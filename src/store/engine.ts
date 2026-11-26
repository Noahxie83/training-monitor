import { DatabaseSync } from 'node:sqlite';
import { statfs, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import type {
  CursorState,
  GpuSeriesPoint,
  HostSeriesPoint,
  HostSnapshot,
  LogEvent,
  LogSourceSnapshot,
  MetricSeriesPoint,
  MetricSeriesResponse,
  TaskRegistration,
  TaskSnapshot,
} from '../shared/contracts';
import type {
  ExportLogsQuery,
  ExportLogsResult,
  GpuSeriesQuery,
  GpuSeriesResponse,
  LogPage,
  LogQuery,
  LogSearchPage,
  LogSearchRequest,
  MetricSeriesQuery,
  MonitorSnapshot,
} from '../shared/api';
import type { HostObservation, TaskObservation } from '../transport/types';
import { createEmptyProgress } from '../domain/progress';
import { PAGE_EVENT_LIMIT, PAGE_TEXT_BUDGET_BYTES } from '../shared/budgets';
import { isSafeRegexPattern } from '../shared/validate';
import { prepareArchiveRead, prepareRead } from '../logs/bytes';
import { nextCursorAnchors } from '../logs/continuity';
import { initialCursor, decideGenerationTransition } from '../logs/generation';
import type { ArchiveReadEvidence, GapState, GenerationDecision, PreparedRead, ReadReply, SourceObservation } from '../logs/types';
import { initializeSchema } from './schema';
import type {
  CommitReadResult,
  GpuSampleRow,
  HostSampleRow,
  MetricSampleRow,
  ReconcileRequest,
  StoreDiagnostics,
} from './protocol';

const MiB = 1024n * 1024n;
const GiB = 1024n * MiB;
const RAW_GLOBAL_LIMIT = GiB;
const RAW_TASK_LIMIT = 256n * MiB;
const TARGET_PERCENT = 80n;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FINE_SERIES_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_FREE_BYTES = 128n * MiB;
const BATCH_STORAGE_MULTIPLIER = 4n;
const BATCH_STORAGE_FIXED = 64n * 1024n;
const SEARCH_BATCH = 128;
const SEARCH_RESULT_LIMIT = 500;
const CLEANUP_ROW_LIMIT = 64;
const CLEANUP_BYTE_LIMIT = 4n * MiB;
const EPOCH = 0;
const DEFAULT_MAX_SERIES_POINTS = 240;

type EngineHooks = {
  beforeCursorWrite?: () => void;
  beforeGenerationSeal?: () => void | Promise<void>;
  freeBytes?: () => Promise<bigint>;
  yieldSearch?: () => Promise<void>;
  rawGlobalLimit?: () => bigint | undefined;
  rawTaskLimit?: () => bigint | undefined;
  walCheckpointThreshold?: () => number | undefined;
  workProbe?: (kind: 'support' | 'cleanup') => void;
  workBlock?: (kind: 'support' | 'cleanup') => void;
};
type SourceRow = { source_id: string; task_id: string; recovery_json: string | null };
type CursorRow = { cursor_json: string };
type EventRow = {
  seq: number;
  event_id: string;
  source_id: string;
  task_id: string;
  generation: string;
  start_offset: string | null;
  end_offset: string | null;
  ingested_at: string;
  text: string | null;
  raw_ansi: string | null;
  event_json: string;
};
type RawRow = { chunk_id: number; source_id: string; generation: string; start_offset: string; end_offset: string; bytes?: Uint8Array; ingested_at: string };
type SizedRawRow = RawRow & { byte_length: number };
type SupportRow = { support_id: number; start_offset: string; end_offset: string; start_key: string; end_key: string; ingested_at: string };
type SearchToken = {
  v: 1;
  sourceIds: string[];
  literal: string;
  mode: 'literal' | 'regex';
  caseSensitive: boolean;
  level: string | null;
  highWater: number;
  beforeSeq: number;
  epochs: Record<string, number>;
};
type PageToken = { v: 1; sourceId: string; highWater: number; beforeSeq: number; epoch: number };
type PersistedSourceState = Pick<LogSourceSnapshot, 'observedAt' | 'freshness' | 'state' | 'errorCode'>;

/** Minimal last-observation record. It deliberately contains no baseline authority. */
export interface PersistedObservation {
  task: TaskRegistration;
  hostObservation: HostObservation;
  taskObservation: TaskObservation;
  observedAt: string;
  sourceGenerations: Record<string, string>;
  sourceStates: Record<string, PersistedSourceState>;
  hostKind?: 'ssh' | 'wsl' | 'local';
  /** Domain projection computed from supported observations; never baseline authority. */
  taskSnapshot?: TaskSnapshot;
}
type ObservationRow = { snapshot_json: string };

function isoMillis(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError('INVALID_TIMESTAMP');
  return result;
}

function encodeToken(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeToken<T>(value: string): T {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T; }
  catch { throw new Error('STALE_CONTINUATION'); }
}

function textBytes(event: LogEvent): number { return Buffer.byteLength(event.text ?? '', 'utf8'); }

function offsetKey(value: string): string {
  const digits = BigInt(value).toString();
  return `${String(digits.length).padStart(10, '0')}:${digits}`;
}

function emptyParserState(cursor: CursorState): CursorState['parserState'] {
  return { ...cursor.parserState, recordStartOffset: cursor.committedOffset, utf8CarryBase64: '', pendingCR: false, recordInvalidUtf8: false, boundedPreview: '', displayTruncated: true, prefixIncomplete: true };
}

/** Serialize LogEvent metadata WITHOUT duplicating `text` or `rawAnsi` into `event_json`. */
function encodeEventMeta(event: LogEvent): string {
  const { text: _text, rawAnsi: _rawAnsi, ...meta } = event;
  return JSON.stringify(meta);
}

function eventFromRow(row: EventRow): LogEvent {
  const meta = JSON.parse(row.event_json) as Partial<LogEvent>;
  return {
    version: 1,
    eventId: meta.eventId ?? row.event_id,
    taskId: meta.taskId ?? row.task_id,
    sourceId: meta.sourceId ?? row.source_id,
    generation: meta.generation ?? row.generation,
    kind: meta.kind ?? 'line',
    startOffset: meta.startOffset !== undefined ? meta.startOffset : row.start_offset,
    endOffset: meta.endOffset !== undefined ? meta.endOffset : row.end_offset,
    ingestedAt: meta.ingestedAt ?? row.ingested_at,
    text: row.text,
    ...(row.raw_ansi ? { rawAnsi: row.raw_ansi } : {}),
    reason: meta.reason ?? null,
    displayTruncated: meta.displayTruncated ?? false,
    recordComplete: meta.recordComplete ?? null,
    prefixIncomplete: meta.prefixIncomplete ?? null,
    runId: meta.runId ?? null,
    bindingId: meta.bindingId ?? null,
  };
}

const LEVEL_PATTERNS: Record<string, RegExp> = {
  error: /\b(?:ERROR|CRITICAL|FATAL|EXCEPTION|TRACEBACK|OOM|OUT OF MEMORY)\b/i,
  warn: /\b(?:WARN|WARNING)\b/i,
  info: /\bINFO\b/i,
  debug: /\bDEBUG\b/i,
};

function matchesLogLevel(text: string, level: string | null | undefined): boolean {
  if (!level || level === 'all') return true;
  const re = LEVEL_PATTERNS[level];
  return re ? re.test(text) : true;
}

/** Largest-Triangle-Three-Buckets downsampling preserving visual extrema and endpoints. */
export function downsampleLttb<T>(
  points: T[],
  maxPoints: number,
  xOf: (point: T) => number,
  yOf: (point: T) => number,
): T[] {
  if (maxPoints < 3 || points.length <= maxPoints) return points;
  const sampled: T[] = [points[0]!];
  const bucketSize = (points.length - 2) / (maxPoints - 2);
  let a = 0;
  for (let i = 0; i < maxPoints - 2; i++) {
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgRangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length);
    let avgX = 0;
    let avgY = 0;
    const avgLen = Math.max(1, avgRangeEnd - avgRangeStart);
    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgX += xOf(points[j]!);
      avgY += yOf(points[j]!);
    }
    avgX /= avgLen;
    avgY /= avgLen;

    const rangeOffs = Math.floor(i * bucketSize) + 1;
    const rangeTo = Math.min(Math.floor((i + 1) * bucketSize) + 1, points.length - 1);
    const pointAX = xOf(points[a]!);
    const pointAY = yOf(points[a]!);
    let maxArea = -1;
    let nextA = rangeOffs;
    for (let j = rangeOffs; j < rangeTo; j++) {
      const area = Math.abs(
        (pointAX - avgX) * (yOf(points[j]!) - pointAY) -
        (pointAX - xOf(points[j]!)) * (avgY - pointAY),
      ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }
    sampled.push(points[nextA]!);
    a = nextA;
  }
  sampled.push(points[points.length - 1]!);
  return sampled;
}

export class StoreEngine {
  private readonly db: DatabaseSync;
  private readonly readDb: DatabaseSync;
  private readonly separateReadDb: boolean;
  private readonly stmtFindEvent: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtInsertEvent: ReturnType<DatabaseSync['prepare']>;
  private readonly stmtEnsureEpoch: ReturnType<DatabaseSync['prepare']>;
  private readonly databasePath: string;
  private readonly hooks: EngineHooks;
  private readonly now: () => number;
  private readonly canceled = new Set<string>();
  private readonly searchRequests = new Set<string>();
  private readonly freshObservationTasks = new Set<string>();
  private readonly freshHostSnapshots = new Set<string>();
  private closed = false;

  constructor(databasePath: string, now: () => number, hooks: EngineHooks = {}) {
    this.databasePath = databasePath;
    this.now = now;
    this.hooks = hooks;
    this.db = new DatabaseSync(databasePath);
    initializeSchema(this.db);
    this.stmtFindEvent = this.db.prepare('SELECT seq, text, raw_ansi, event_json FROM log_events WHERE event_id = ?');
    this.stmtInsertEvent = this.db.prepare(
      'INSERT INTO log_events(event_id,source_id,task_id,generation,start_offset,end_offset,ingested_at,text,raw_ansi,event_json,start_key,end_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    this.stmtEnsureEpoch = this.db.prepare('INSERT INTO source_epochs(source_id,content_epoch) VALUES(?,0) ON CONFLICT(source_id) DO NOTHING');
    if (databasePath !== ':memory:') {
      this.readDb = new DatabaseSync(databasePath, { readOnly: true });
      this.readDb.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON;');
      this.separateReadDb = true;
    } else {
      this.readDb = this.db;
      this.separateReadDb = false;
    }
    if (hooks.workProbe) {
      this.db.function('t3_support_probe', () => { hooks.workProbe!('support'); return 1; });
      this.db.function('t3_cleanup_probe', () => { hooks.workProbe!('cleanup'); return 1; });
      if (this.separateReadDb) {
        this.readDb.function('t3_support_probe', () => { hooks.workProbe!('support'); return 1; });
        this.readDb.function('t3_cleanup_probe', () => { hooks.workProbe!('cleanup'); return 1; });
      }
    }
  }

  private assertOpen(): void { if (this.closed) throw new Error('STORE_CLOSED'); }
  runtimeInfo(): { sqlite: string } { return { sqlite: String((this.readDb.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version) }; }
  private begin(): void { this.assertOpen(); this.db.exec('BEGIN IMMEDIATE'); }
  private commit(): void { this.db.exec('COMMIT'); }
  private rollback(): void { try { this.db.exec('ROLLBACK'); } catch { /* A failed BEGIN has no transaction to roll back. */ } }

  private cursor(sourceId: string, conn: DatabaseSync = this.db): CursorState | null {
    const row = conn.prepare('SELECT cursor_json FROM source_cursors WHERE source_id = ?').get(sourceId) as CursorRow | undefined;
    return row ? JSON.parse(row.cursor_json) as CursorState : null;
  }

  private source(sourceId: string, conn: DatabaseSync = this.db): SourceRow | null {
    return (conn.prepare('SELECT source_id, task_id, recovery_json FROM source_registry WHERE source_id = ?').get(sourceId) as SourceRow | undefined) ?? null;
  }

  private epoch(sourceId: string, conn: DatabaseSync = this.readDb): number {
    const row = conn.prepare('SELECT content_epoch FROM source_epochs WHERE source_id = ?').get(sourceId) as { content_epoch: number } | undefined;
    return row?.content_epoch ?? EPOCH;
  }

  private markContentChange(sourceId: string, seq: number): void {
    this.db.prepare('INSERT INTO source_epochs(source_id,content_epoch) VALUES(?,0) ON CONFLICT(source_id) DO NOTHING').run(sourceId);
    this.db.prepare('UPDATE source_epochs SET content_epoch=content_epoch+1 WHERE source_id=?').run(sourceId);
    this.db.prepare('INSERT OR REPLACE INTO content_changes(source_id,content_epoch,event_seq) VALUES(?,?,?)').run(sourceId, this.epoch(sourceId, this.db), seq);
  }

  private changedInCapturedRange(sourceId: string, epoch: number, highWater: number): boolean {
    return Boolean(this.readDb.prepare('SELECT 1 AS changed FROM content_changes WHERE source_id=? AND content_epoch>? AND event_seq<=? LIMIT 1').get(sourceId, epoch, highWater));
  }

  private setCursor(cursor: CursorState): void {
    this.hooks.beforeCursorWrite?.();
    this.db.prepare('INSERT INTO source_cursors(source_id,cursor_json) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET cursor_json=excluded.cursor_json').run(cursor.sourceId, JSON.stringify(cursor));
    this.db.prepare('INSERT INTO source_generations(source_id,generation,state,cursor_json) VALUES(?,?,?,?) ON CONFLICT(source_id,generation) DO UPDATE SET state=excluded.state,cursor_json=excluded.cursor_json').run(cursor.sourceId, cursor.generation, cursor.state, JSON.stringify(cursor));
  }

  private assertCas(cursor: CursorState | null, sourceId: string, expected: { generation: string; revision: number; committedOffset: string }): cursor is CursorState {
    return Boolean(cursor && cursor.sourceId === sourceId && cursor.generation === expected.generation && cursor.revision === expected.revision && cursor.committedOffset === expected.committedOffset);
  }

  private async diskFree(): Promise<bigint> {
    if (this.hooks.freeBytes) return this.hooks.freeBytes();
    if (this.databasePath === ':memory:') return 10n * GiB;
    const usage = await statfs(path.dirname(this.databasePath));
    return BigInt(usage.bavail) * BigInt(usage.bsize);
  }

  private addEvent(event: LogEvent): void {
    const previous = this.stmtFindEvent.get(event.eventId) as {
      seq: number; text: string | null; raw_ansi: string | null; event_json: string;
    } | undefined;
    const encoded = encodeEventMeta(event);
    const rawAnsi = event.rawAnsi ?? null;
    if (!previous) {
      this.stmtInsertEvent.run(
        event.eventId, event.sourceId, event.taskId, event.generation,
        event.startOffset, event.endOffset, event.ingestedAt, event.text, rawAnsi, encoded,
        event.startOffset === null ? null : offsetKey(event.startOffset),
        event.endOffset === null ? null : offsetKey(event.endOffset),
      );
      this.stmtEnsureEpoch.run(event.sourceId);
      return;
    }
    if (previous.text !== event.text || previous.raw_ansi !== rawAnsi || previous.event_json !== encoded) {
      let prevKind: string | undefined;
      try { prevKind = (JSON.parse(previous.event_json) as { kind?: string }).kind; } catch { /* ignore */ }
      const maxRow = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS max_seq FROM log_events WHERE source_id=?').get(event.sourceId) as { max_seq: number };
      const isTailInPlaceRedraw = previous.seq === maxRow.max_seq && (event.kind === 'redraw' || prevKind === 'redraw');

      this.db.prepare(
        'UPDATE log_events SET task_id=?,generation=?,start_offset=?,end_offset=?,ingested_at=?,text=?,raw_ansi=?,event_json=?,start_key=?,end_key=? WHERE event_id=?',
      ).run(
        event.taskId, event.generation, event.startOffset, event.endOffset, event.ingestedAt,
        event.text, rawAnsi, encoded,
        event.startOffset === null ? null : offsetKey(event.startOffset),
        event.endOffset === null ? null : offsetKey(event.endOffset),
        event.eventId,
      );
      // Tail CR redraws updating the active tail line in-place do NOT invalidate historical pagination cursors,
      // eliminating the STALE_CONTINUATION storm while keeping eviction/historical edits strict.
      if (!isTailInPlaceRedraw) {
        this.markContentChange(event.sourceId, previous.seq);
      }
    }
  }

  private addRaw(prepared: Extract<PreparedRead, { kind: 'append' }>): void {
    const { raw } = prepared;
    if (raw.bytes.byteLength > 0) {
      this.db.prepare('INSERT INTO raw_chunks(source_id,generation,start_offset,end_offset,bytes,ingested_at) VALUES(?,?,?,?,?,?)')
        .run(raw.sourceId, raw.generation, raw.startOffset, raw.endOffset, Buffer.from(raw.bytes), raw.ingestedAt);
      this.addRawSupport(raw.sourceId, raw.generation, raw.startOffset, raw.endOffset, raw.ingestedAt);
      const source = this.source(raw.sourceId);
      if (source) this.adjustRawUsage(source.task_id, BigInt(raw.bytes.byteLength));
    }
    for (const event of prepared.events) this.addEvent(event);
    this.hooks.beforeCursorWrite?.();
    this.db.prepare('UPDATE source_cursors SET cursor_json=? WHERE source_id=?').run(JSON.stringify(prepared.next), prepared.next.sourceId);
    this.db.prepare('UPDATE source_generations SET state=?,cursor_json=? WHERE source_id=? AND generation=?')
      .run(prepared.next.state, JSON.stringify(prepared.next), prepared.next.sourceId, prepared.next.generation);
  }

  private adjustRawUsage(taskId: string, delta: bigint): void {
    this.db.prepare("INSERT INTO raw_usage(owner_type,owner_id,raw_bytes) VALUES('global','*',0) ON CONFLICT(owner_type,owner_id) DO NOTHING").run();
    this.db.prepare("INSERT INTO raw_usage(owner_type,owner_id,raw_bytes) VALUES('task',?,0) ON CONFLICT(owner_type,owner_id) DO NOTHING").run(taskId);
    this.db.prepare("UPDATE raw_usage SET raw_bytes=raw_bytes+? WHERE owner_type='global' AND owner_id='*'").run(Number(delta));
    this.db.prepare("UPDATE raw_usage SET raw_bytes=raw_bytes+? WHERE owner_type='task' AND owner_id=?").run(Number(delta), taskId);
  }

  private addRawSupport(sourceId: string, generation: string, start: string, end: string, ingestedAt: string): void {
    const startKey = offsetKey(start); const endKey = offsetKey(end);
    const probe = this.hooks.workProbe ? ' AND t3_support_probe()=1' : '';
    const left = this.db.prepare(`SELECT * FROM raw_support WHERE source_id=? AND generation=? AND end_key=? AND ingested_at=?${probe} LIMIT 1`).get(sourceId, generation, startKey, ingestedAt) as SupportRow | undefined;
    this.hooks.workBlock?.('support');
    const right = this.db.prepare(`SELECT * FROM raw_support WHERE source_id=? AND generation=? AND start_key=? AND ingested_at=?${probe} LIMIT 1`).get(sourceId, generation, endKey, ingestedAt) as SupportRow | undefined;
    this.hooks.workBlock?.('support');
    const mergedStart = left?.start_offset ?? start;
    const mergedEnd = right?.end_offset ?? end;
    if (left) this.db.prepare('DELETE FROM raw_support WHERE support_id=?').run(left.support_id);
    if (right) this.db.prepare('DELETE FROM raw_support WHERE support_id=?').run(right.support_id);
    this.db.prepare('INSERT INTO raw_support(source_id,generation,start_offset,end_offset,start_key,end_key,ingested_at) VALUES(?,?,?,?,?,?,?)')
      .run(sourceId, generation, mergedStart, mergedEnd, offsetKey(mergedStart), offsetKey(mergedEnd), ingestedAt);
  }

  async getCursor(sourceId: string): Promise<CursorState | null> { this.assertOpen(); return this.cursor(sourceId, this.readDb); }

  async registerSource(sourceId: string, observation: SourceObservation, taskId: string): Promise<CursorState> {
    this.assertOpen();
    if (!sourceId || !taskId) throw new TypeError('INVALID_SOURCE_REGISTRATION');
    this.begin();
    try {
      const existing = this.source(sourceId);
      if (existing) {
        if (existing.task_id !== taskId) throw new Error('SOURCE_TASK_CONFLICT');
        const cursor = this.cursor(sourceId);
        if (!cursor) throw new Error('STORE_CORRUPT_CURSOR');
        this.commit();
        return cursor;
      }
      const cursor = initialCursor(sourceId, observation);
      this.db.prepare('INSERT INTO source_registry(source_id,task_id) VALUES(?,?)').run(sourceId, taskId);
      this.db.prepare('INSERT INTO source_epochs(source_id,content_epoch) VALUES(?,0)').run(sourceId);
      this.setCursor(cursor);
      this.commit();
      return cursor;
    } catch (error) { this.rollback(); throw error; }
  }

  async saveObservation(observation: PersistedObservation): Promise<void> {
    this.assertOpen();
    const { task, hostObservation, taskObservation } = observation;
    if (!task.taskId || taskObservation.taskId !== task.taskId || hostObservation.hostId !== task.hostId) {
      throw new TypeError('INVALID_OBSERVATION');
    }
    if (!Number.isFinite(Date.parse(observation.observedAt))) throw new TypeError('INVALID_OBSERVATION_TIMESTAMP');
    this.begin();
    try {
      this.db.prepare('INSERT INTO observation_snapshot(task_id,snapshot_json) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET snapshot_json=excluded.snapshot_json')
        .run(task.taskId, JSON.stringify(observation));
      this.commit();
      this.freshObservationTasks.add(task.taskId);
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async saveHostSnapshot(host: HostSnapshot): Promise<void> {
    this.assertOpen();
    if (!host || !host.hostId) throw new TypeError('INVALID_HOST_SNAPSHOT');
    const updatedAt = host.observedAt ?? new Date(this.now()).toISOString();
    this.begin();
    try {
      this.db.prepare(
        'INSERT INTO host_snapshots(host_id, snapshot_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(host_id) DO UPDATE SET snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at',
      ).run(host.hostId, JSON.stringify(host), updatedAt);
      this.commit();
      this.freshHostSnapshots.add(host.hostId);
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async saveMetricSamples(samples: MetricSampleRow[]): Promise<void> {
    this.assertOpen();
    if (!Array.isArray(samples) || samples.length === 0) return;
    this.begin();
    try {
      const stmt = this.db.prepare(
        'INSERT INTO metric_samples(task_id, run_id, observed_at, step, metric_name, value) VALUES(?, ?, ?, ?, ?, ?)',
      );
      for (const s of samples) {
        if (!s.taskId || !s.metricName || !Number.isFinite(s.value)) continue;
        stmt.run(s.taskId, s.runId ?? null, s.observedAt, s.step ?? null, s.metricName, s.value);
      }
      this.commit();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async saveGpuSamples(samples: GpuSampleRow[]): Promise<void> {
    this.assertOpen();
    if (!Array.isArray(samples) || samples.length === 0) return;
    this.begin();
    try {
      const stmt = this.db.prepare(
        'INSERT INTO gpu_samples(host_id, device_id, observed_at, util_pct, mem_used_mib, mem_total_mib, temp_c, power_w) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const s of samples) {
        if (!s.hostId || !s.deviceId) continue;
        stmt.run(s.hostId, s.deviceId, s.observedAt, s.utilPct, s.memUsedMiB, s.memTotalMiB, s.tempC, s.powerW);
      }
      this.commit();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async saveHostSamples(samples: HostSampleRow[]): Promise<void> {
    this.assertOpen();
    if (!Array.isArray(samples) || samples.length === 0) return;
    this.begin();
    try {
      const stmt = this.db.prepare(
        'INSERT INTO host_samples(host_id, observed_at, cpu_pct, ram_used_mib, ram_total_mib) VALUES(?, ?, ?, ?, ?)',
      );
      for (const s of samples) {
        if (!s.hostId) continue;
        stmt.run(s.hostId, s.observedAt, s.cpuPct, s.ramUsedMiB, s.ramTotalMiB);
      }
      this.commit();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async getMetricSeries(query: MetricSeriesQuery, now = new Date(this.now()).toISOString()): Promise<MetricSeriesResponse> {
    this.assertOpen();
    const nowMs = isoMillis(now);
    const rangeMs = Math.max(1000, Math.min(30 * 24 * 60 * 60 * 1000, query.rangeMs || 3600_000));
    const maxPoints = Math.max(10, Math.min(2000, query.maxPoints ?? DEFAULT_MAX_SERIES_POINTS));
    const sinceIso = new Date(nowMs - rangeMs).toISOString();

    const metricNames = query.metrics && query.metrics.length > 0
      ? query.metrics
      : (this.readDb.prepare('SELECT DISTINCT metric_name FROM metric_samples WHERE task_id = ? AND observed_at >= ? ORDER BY metric_name')
          .all(query.taskId, sinceIso) as { metric_name: string }[]).map((r) => r.metric_name);

    const series: Record<string, MetricSeriesPoint[]> = {};
    const stmt = this.readDb.prepare(
      'SELECT observed_at, step, value FROM metric_samples WHERE task_id = ? AND metric_name = ? AND observed_at >= ? ORDER BY observed_at ASC, id ASC',
    );
    for (const metricName of metricNames) {
      const rows = stmt.all(query.taskId, metricName, sinceIso) as { observed_at: string; step: number | null; value: number }[];
      const points: MetricSeriesPoint[] = rows.map((row) => ({
        observedAt: row.observed_at,
        step: row.step,
        value: row.value,
      }));
      series[metricName] = downsampleLttb(
        points,
        maxPoints,
        (pt) => Date.parse(pt.observedAt),
        (pt) => pt.value,
      );
    }
    return { taskId: query.taskId, series };
  }

  async getGpuSeries(query: GpuSeriesQuery, now = new Date(this.now()).toISOString()): Promise<GpuSeriesResponse> {
    this.assertOpen();
    const nowMs = isoMillis(now);
    const rangeMs = Math.max(1000, Math.min(30 * 24 * 60 * 60 * 1000, query.rangeMs || 3600_000));
    const maxPoints = Math.max(10, Math.min(2000, query.maxPoints ?? DEFAULT_MAX_SERIES_POINTS));
    const sinceIso = new Date(nowMs - rangeMs).toISOString();

    const deviceIds = query.deviceId
      ? [query.deviceId]
      : (this.readDb.prepare('SELECT DISTINCT device_id FROM gpu_samples WHERE host_id = ? AND observed_at >= ? ORDER BY device_id')
          .all(query.hostId, sinceIso) as { device_id: string }[]).map((r) => r.device_id);

    const gpuPoints: GpuSeriesPoint[] = [];
    const gpuStmt = this.readDb.prepare(
      'SELECT observed_at, util_pct, mem_used_mib, mem_total_mib, temp_c, power_w FROM gpu_samples WHERE host_id = ? AND device_id = ? AND observed_at >= ? ORDER BY observed_at ASC, id ASC',
    );
    for (const deviceId of deviceIds) {
      const rows = gpuStmt.all(query.hostId, deviceId, sinceIso) as {
        observed_at: string;
        util_pct: number | null;
        mem_used_mib: number | null;
        mem_total_mib: number | null;
        temp_c: number | null;
        power_w: number | null;
      }[];
      const points: GpuSeriesPoint[] = rows.map((row) => ({
        observedAt: row.observed_at,
        deviceId,
        utilPct: row.util_pct,
        memUsedMiB: row.mem_used_mib,
        memTotalMiB: row.mem_total_mib,
        tempC: row.temp_c,
        powerW: row.power_w,
      }));
      gpuPoints.push(
        ...downsampleLttb(
          points,
          maxPoints,
          (pt) => Date.parse(pt.observedAt),
          (pt) => pt.utilPct ?? pt.memUsedMiB ?? 0,
        ),
      );
    }

    const hostRows = this.readDb.prepare(
      'SELECT observed_at, cpu_pct, ram_used_mib, ram_total_mib FROM host_samples WHERE host_id = ? AND observed_at >= ? ORDER BY observed_at ASC, id ASC',
    ).all(query.hostId, sinceIso) as {
      observed_at: string;
      cpu_pct: number | null;
      ram_used_mib: number | null;
      ram_total_mib: number | null;
    }[];
    const hostPoints: HostSeriesPoint[] = downsampleLttb(
      hostRows.map((row) => ({
        observedAt: row.observed_at,
        cpuPct: row.cpu_pct,
        ramUsedMiB: row.ram_used_mib,
        ramTotalMiB: row.ram_total_mib,
      })),
      maxPoints,
      (pt) => Date.parse(pt.observedAt),
      (pt) => pt.cpuPct ?? 0,
    );

    return { hostId: query.hostId, gpu: gpuPoints, host: hostPoints };
  }

  async exportLogs(query: ExportLogsQuery, now = new Date(this.now()).toISOString()): Promise<ExportLogsResult> {
    this.assertOpen();
    const maxLines = 50_000;
    const cutoff = isoMillis(now) - MAX_CACHE_AGE_MS;
    if (!query.sourceIds.length) {
      return { exportedCount: 0, path: query.destinationPath ?? null };
    }
    const mode = query.mode ?? 'literal';
    const caseSensitive = query.caseSensitive ?? false;
    const pattern = query.literal ?? '';
    let regex: RegExp | null = null;
    if (pattern && mode === 'regex') {
      if (!isSafeRegexPattern(pattern)) throw new Error('UNSAFE_REGEX_PATTERN');
      regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    }
    const literalLower = pattern && !caseSensitive ? pattern.toLowerCase() : null;

    const placeholders = query.sourceIds.map(() => '?').join(',');
    const rows = this.readDb.prepare(
      `SELECT seq,event_id,source_id,task_id,generation,start_offset,end_offset,ingested_at,text,raw_ansi,event_json FROM log_events WHERE source_id IN (${placeholders}) AND text IS NOT NULL ORDER BY seq ASC LIMIT ?`,
    ).all(...query.sourceIds, maxLines * 2) as EventRow[];

    const lines: string[] = [];
    for (const row of rows) {
      if (lines.length >= maxLines) break;
      const event = eventFromRow(row);
      if (event.text === null) continue;
      if (!await this.visible(event, row.source_id, cutoff)) continue;
      if (!matchesLogLevel(event.text, query.level)) continue;
      if (pattern) {
        if (regex) {
          if (!regex.test(event.text)) continue;
        } else if (literalLower !== null) {
          if (!event.text.toLowerCase().includes(literalLower)) continue;
        } else {
          if (!event.text.includes(pattern)) continue;
        }
      }
      lines.push(event.text);
    }

    const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    if (query.destinationPath) {
      await mkdir(path.dirname(query.destinationPath), { recursive: true });
      await writeFile(query.destinationPath, content, 'utf8');
      return { exportedCount: lines.length, path: query.destinationPath };
    }
    return { exportedCount: lines.length, path: null };
  }

  async purgeOrphans(activeHostIds: string[], activeTaskIds: string[]): Promise<void> {
    this.assertOpen();
    this.begin();
    try {
      const hostSet = new Set(activeHostIds);
      const taskSet = new Set(activeTaskIds);

      const obsTasks = (this.db.prepare('SELECT task_id FROM observation_snapshot').all() as { task_id: string }[]).map((r) => r.task_id);
      for (const taskId of obsTasks) {
        if (!taskSet.has(taskId)) {
          this.db.prepare('DELETE FROM observation_snapshot WHERE task_id=?').run(taskId);
          this.db.prepare('DELETE FROM metric_samples WHERE task_id=?').run(taskId);
          this.freshObservationTasks.delete(taskId);
        }
      }

      const persistedHosts = (this.db.prepare('SELECT host_id FROM host_snapshots').all() as { host_id: string }[]).map((r) => r.host_id);
      for (const hostId of persistedHosts) {
        if (!hostSet.has(hostId)) {
          this.db.prepare('DELETE FROM host_snapshots WHERE host_id=?').run(hostId);
          this.db.prepare('DELETE FROM gpu_samples WHERE host_id=?').run(hostId);
          this.db.prepare('DELETE FROM host_samples WHERE host_id=?').run(hostId);
          this.freshHostSnapshots.delete(hostId);
        }
      }

      const sampleHosts = (this.db.prepare('SELECT DISTINCT host_id FROM gpu_samples').all() as { host_id: string }[]).map((r) => r.host_id);
      for (const hostId of sampleHosts) {
        if (!hostSet.has(hostId)) {
          this.db.prepare('DELETE FROM gpu_samples WHERE host_id=?').run(hostId);
          this.db.prepare('DELETE FROM host_samples WHERE host_id=?').run(hostId);
        }
      }

      this.commit();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private cachedTaskSnapshot(observation: PersistedObservation, fresh: boolean): TaskSnapshot {
    const prior = observation.taskSnapshot;
    const base: TaskSnapshot = prior ? structuredClone(prior) : {
      version: 1,
      taskId: observation.task.taskId,
      hostId: observation.task.hostId,
      lifecycle: 'unknown',
      freshness: 'unobserved',
      statusObservedAt: observation.observedAt,
      confidence: 'none',
      reason: 'Cached observation',
      evidence: [],
      currentRun: null,
      processes: { main: null, queue: null, workers: [] },
      queueLock: { observedAt: null, freshness: 'unobserved', source: null, exists: null, heldByRegisteredProcess: null },
      progress: createEmptyProgress(observation.observedAt, 'unobserved', null),
      checkpoint: { observedAt: null, freshness: 'unobserved', path: null, fileStepIndex: null, stepSource: null, sizeBytes: null, mtime: null, evidence: 'none', scanComplete: false },
      resources: [],
    };
    const cachedResources = fresh
      ? base.resources
      : base.resources.map((metric) => ({ ...metric, freshness: 'stale' as const }));
    const connected = fresh &&
      observation.hostObservation.connection === 'connected' &&
      observation.hostObservation.freshness === 'fresh' &&
      observation.hostObservation.scanComplete === true &&
      observation.taskObservation.freshness === 'fresh' &&
      observation.taskObservation.scanComplete === true;
    if (connected) {
      return {
        ...base,
        taskId: observation.task.taskId,
        hostId: observation.task.hostId,
        freshness: 'fresh',
        statusObservedAt: observation.observedAt,
        resources: cachedResources,
      };
    }
    return {
      ...base,
      taskId: observation.task.taskId,
      hostId: observation.task.hostId,
      lifecycle: 'unknown',
      freshness: 'stale',
      statusObservedAt: base.statusObservedAt ?? observation.observedAt,
      confidence: 'low',
      reason: 'Cached observation is stale until a fresh host and task probe succeeds',
      resources: cachedResources,
      ...(base.gpuUsage ? { gpuUsage: { ...base.gpuUsage, freshness: 'stale' as const, state: 'unavailable' as const, errorCode: base.gpuUsage.errorCode ?? 'CACHED_OFFLINE' } } : {}),
      progress: {
        ...base.progress,
        freshness: 'stale',
        iterationsPerSecond: null,
        etaSeconds: null,
      },
    };
  }

  private cachedHostSnapshot(observations: PersistedObservation[], fresh: Set<string>): HostSnapshot | null {
    const observation = observations.find((item) => item.task.taskId === observations[0]?.task.taskId);
    if (!observation) return null;
    const hostId = observation.task.hostId;
    const hostRows = observations.filter((item) => item.task.hostId === hostId);
    const freshRow = hostRows.find((item) => fresh.has(item.task.taskId) &&
      item.hostObservation.connection === 'connected' &&
      item.hostObservation.freshness === 'fresh' &&
      item.hostObservation.scanComplete === true);
    const latest = freshRow ?? hostRows.slice().sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]!;
    const connected = Boolean(freshRow);
    return {
      version: 1,
      hostId,
      kind: latest.hostKind ?? 'ssh',
      connection: connected ? 'connected' : latest.hostObservation.observedAt ? 'disconnected' : 'unobserved',
      lastSuccessAt: latest.hostObservation.connection === 'connected' ? latest.hostObservation.observedAt : null,
      lastProbeDurationMs: null,
      scanComplete: connected ? latest.hostObservation.scanComplete : false,
      errorCode: connected ? latest.hostObservation.errorCode : latest.hostObservation.errorCode ?? 'CACHED_OFFLINE',
      observedAt: latest.hostObservation.observedAt,
      freshness: connected ? 'fresh' : latest.hostObservation.observedAt ? 'stale' : 'unobserved',
      ...(latest.hostObservation.system ? { system: structuredClone(latest.hostObservation.system) } : {}),
    };
  }

  private cachedSourceSnapshots(observation: PersistedObservation, fresh: boolean): LogSourceSnapshot[] {
    return observation.task.sources.map((registered) => {
      const cursor = this.cursor(registered.sourceId, this.readDb);
      const persistedState = observation.sourceStates[registered.sourceId];
      const observedSource = observation.taskObservation.sources.find((item) => item.sourceId === registered.sourceId);
      const active = fresh && observation.hostObservation.connection === 'connected' && observation.taskObservation.freshness === 'fresh';
      return {
        sourceId: registered.sourceId,
        taskId: observation.task.taskId,
        state: active ? persistedState?.state ?? (observedSource?.permission === 'readable' ? 'ready' : 'unobserved') : 'unobserved',
        freshness: active ? persistedState?.freshness ?? observation.taskObservation.freshness : 'stale',
        observedAt: persistedState?.observedAt ?? observedSource?.observedAt ?? observation.observedAt,
        generation: observation.sourceGenerations[registered.sourceId] ?? cursor?.generation ?? null,
        committedOffset: cursor?.committedOffset ?? null,
        generationStartOffset: cursor?.generationStartOffset ?? null,
        maxObservedOffset: cursor?.maxObservedOffset ?? null,
        continuityState: cursor?.state ?? null,
        catchupBytesRead: null,
        catchupBytesTotal: null,
        errorCode: active ? persistedState?.errorCode ?? null : null,
      };
    });
  }

  private persistReconcile(cursor: CursorState): CursorState {
    if (cursor.state === 'reconciling') return cursor;
    const next = { ...cursor, revision: cursor.revision + 1, state: 'reconciling' as const };
    this.db.prepare('UPDATE source_registry SET recovery_json=? WHERE source_id=? AND recovery_json IS NULL')
      .run(JSON.stringify({ initialCommittedOffset: cursor.committedOffset, initialMaxObservedOffset: cursor.maxObservedOffset }), cursor.sourceId);
    this.setCursor(next);
    return next;
  }

  private commitPrepared(cursor: CursorState, expected: CursorState, prepared: PreparedRead): 'committed' | 'stale' | 'reconciling' | 'storage_error' {
    if (prepared.kind === 'discard') return 'stale';
    if (prepared.kind === 'reconcile') {
      if (cursor.state === 'reconciling') return 'reconciling';
      this.persistReconcile(cursor);
      return 'reconciling';
    }
    this.addRaw(prepared);
    return 'committed';
  }

  async commitRead(input: { expected: CursorState; reply: ReadReply; ingestedAt: string }): Promise<CommitReadResult['status']> {
    return (await this.commitReadWithReceipt(input)).status;
  }

  async commitReadWithReceipt(input: { expected: CursorState; reply: ReadReply; ingestedAt: string }): Promise<CommitReadResult> {
    this.assertOpen();
    const sourceId = input.expected.sourceId;
    const source = this.source(sourceId);
    if (!source) return { status: 'stale', events: [] };
    const sameObservedIdentity = input.reply.before.fileIdentity?.dev === input.reply.after.fileIdentity?.dev &&
      input.reply.before.fileIdentity?.inode === input.reply.after.fileIdentity?.inode;
    const effectiveReply = sameObservedIdentity &&
      input.reply.bytes.byteLength > 0 &&
      input.reply.after.anchors.length === 0 &&
      input.expected.anchors.length === 0 &&
      input.reply.after.sizeBytes !== '0'
      ? (() => {
        const anchors = nextCursorAnchors([], BigInt(input.reply.startOffset), input.reply.bytes);
        return {
          ...input.reply,
          before: { ...input.reply.before, anchors },
          after: { ...input.reply.after, anchors },
        };
      })()
      : input.reply;
    const pendingBytes = input.reply.bytes.byteLength;
    const totalLimit = this.hooks.rawGlobalLimit?.() ?? RAW_GLOBAL_LIMIT;
    const taskLimit = this.hooks.rawTaskLimit?.() ?? RAW_TASK_LIMIT;
    if (BigInt(pendingBytes) > totalLimit || BigInt(pendingBytes) > taskLimit) return { status: 'storage_error', events: [] };
    const current = this.cursor(sourceId);
    if (!this.assertCas(current, sourceId, { generation: input.expected.generation, revision: input.expected.revision, committedOffset: input.expected.committedOffset })) return { status: 'stale', events: [] };
    if (current.state !== input.expected.state) return { status: 'stale', events: [] };
    let prepared = prepareRead(current, effectiveReply, input.ingestedAt, source.task_id);
    if (prepared.kind === 'discard') return { status: 'stale', events: [] };
    if (prepared.kind === 'reconcile') {
      this.begin();
      try {
        const latest = this.cursor(sourceId);
        if (!this.assertCas(latest, sourceId, input.expected) || latest.state !== input.expected.state) { this.rollback(); return { status: 'stale', events: [] }; }
        const status = this.commitPrepared(latest, input.expected, prepared);
        this.commit();
        return { status, events: [] };
      } catch { this.rollback(); return { status: 'storage_error', events: [] }; }
    }
    if (!(await this.hasDiskHeadroom(prepared.raw.bytes.byteLength, prepared.events))) return { status: 'storage_error', events: [] };
    try { await this.retain(input.ingestedAt, { taskId: source.task_id, bytes: prepared.raw.bytes.byteLength }); } catch { return { status: 'storage_error', events: [] }; }
    const afterRetention = this.cursor(sourceId);
    if (!this.assertCas(afterRetention, sourceId, input.expected) || afterRetention.state !== input.expected.state) return { status: 'stale', events: [] };
    prepared = prepareRead(afterRetention, effectiveReply, input.ingestedAt, source.task_id);
    if (prepared.kind === 'discard') return { status: 'stale', events: [] };
    if (prepared.kind === 'reconcile') {
      this.begin();
      try {
        const latest = this.cursor(sourceId);
        if (!this.assertCas(latest, sourceId, input.expected) || latest.state !== input.expected.state) { this.rollback(); return { status: 'stale', events: [] }; }
        const status = this.commitPrepared(latest, input.expected, prepared);
        this.commit();
        return { status, events: [] };
      } catch { this.rollback(); return { status: 'storage_error', events: [] }; }
    }
    if (!(await this.hasDiskHeadroom(prepared.raw.bytes.byteLength, prepared.events))) return { status: 'storage_error', events: [] };
    if (!(await this.admitBatch(source.task_id, prepared.raw.bytes.byteLength, prepared.events))) return { status: 'storage_error', events: [] };
    this.begin();
    try {
      const latest = this.cursor(sourceId);
      if (!this.assertCas(latest, sourceId, prepared.kind === 'append' ? prepared.expected : { generation: input.expected.generation, revision: input.expected.revision, committedOffset: input.expected.committedOffset })) { this.rollback(); return { status: 'stale', events: [] }; }
      const status = this.commitPrepared(latest, input.expected, prepared);
      this.commit();
      return { status, events: status === 'committed' && prepared.kind === 'append' ? prepared.events : [] };
    } catch { this.rollback(); return { status: 'storage_error', events: [] }; }
  }

  async commitArchiveRead(input: { expected: CursorState; evidence: ArchiveReadEvidence; ingestedAt: string }): Promise<'committed' | 'stale' | 'reconciling' | 'storage_error'> {
    this.assertOpen();
    const sourceId = input.expected.sourceId;
    const source = this.source(sourceId);
    if (!source || input.evidence.candidate.sourceId !== sourceId) return 'stale';
    const pendingBytes = input.evidence.reply.bytes.byteLength;
    const totalLimit = this.hooks.rawGlobalLimit?.() ?? RAW_GLOBAL_LIMIT;
    const taskLimit = this.hooks.rawTaskLimit?.() ?? RAW_TASK_LIMIT;
    if (BigInt(pendingBytes) > totalLimit || BigInt(pendingBytes) > taskLimit) return 'storage_error';
    const current = this.cursor(sourceId);
    if (!this.assertCas(current, sourceId, { generation: input.expected.generation, revision: input.expected.revision, committedOffset: input.expected.committedOffset })) return 'stale';
    let prepared = prepareArchiveRead(current, input.evidence, input.ingestedAt, source.task_id);
    if (prepared.kind === 'discard') return 'stale';
    if (prepared.kind === 'reconcile') {
      this.begin();
      try {
        const latest = this.cursor(sourceId);
        if (!this.assertCas(latest, sourceId, input.expected) || latest.state !== 'reconciling') { this.rollback(); return 'stale'; }
        const status = this.commitPrepared(latest, input.expected, prepared);
        this.commit();
        return status;
      } catch { this.rollback(); return 'storage_error'; }
    }
    if (!(await this.hasDiskHeadroom(prepared.raw.bytes.byteLength, prepared.events))) return 'storage_error';
    try { await this.retain(input.ingestedAt, { taskId: source.task_id, bytes: prepared.raw.bytes.byteLength }); } catch { return 'storage_error'; }
    const afterRetention = this.cursor(sourceId);
    if (!this.assertCas(afterRetention, sourceId, input.expected) || afterRetention.state !== 'reconciling') return 'stale';
    prepared = prepareArchiveRead(afterRetention, input.evidence, input.ingestedAt, source.task_id);
    if (prepared.kind === 'discard') return 'stale';
    if (prepared.kind === 'reconcile') {
      this.begin();
      try {
        const latest = this.cursor(sourceId);
        if (!this.assertCas(latest, sourceId, input.expected) || latest.state !== 'reconciling') { this.rollback(); return 'stale'; }
        const status = this.commitPrepared(latest, input.expected, prepared);
        this.commit();
        return status;
      } catch { this.rollback(); return 'storage_error'; }
    }
    if (!(await this.hasDiskHeadroom(prepared.raw.bytes.byteLength, prepared.events))) return 'storage_error';
    if (!(await this.admitBatch(source.task_id, prepared.raw.bytes.byteLength, prepared.events))) return 'storage_error';
    this.begin();
    try {
      const latest = this.cursor(sourceId);
      if (!this.assertCas(latest, sourceId, prepared.expected) || latest.state !== 'reconciling') { this.rollback(); return 'stale'; }
      this.addRaw(prepared);
      this.commit();
      return 'committed';
    } catch { this.rollback(); return 'storage_error'; }
  }

  private gapEvent(sourceId: string, generation: string, taskId: string, ingestedAt: string, gap: GapState): LogEvent | null {
    if (!gap) return null;
    const kind = gap.kind;
    return { version: 1, eventId: `${sourceId}:${generation}:generation:${kind}`, taskId, sourceId, generation, kind, startOffset: gap.startOffset, endOffset: gap.endOffset, ingestedAt, text: null, reason: kind, displayTruncated: false, recordComplete: null, prefixIncomplete: null, runId: null, bindingId: null };
  }

  private decide(current: CursorState, source: SourceRow, request: ReconcileRequest): GenerationDecision {
    const recovery = source.recovery_json ? JSON.parse(source.recovery_json) as { initialCommittedOffset: string; initialMaxObservedOffset: string } : { initialCommittedOffset: current.committedOffset, initialMaxObservedOffset: current.maxObservedOffset };
    return decideGenerationTransition({ oldCursor: current, recovery, candidateScan: request.candidateScan, newFile: request.newFile, observedAt: request.observedAt });
  }

  async reconcileSource(request: ReconcileRequest): Promise<GenerationDecision | { kind: 'stale' }> {
    this.assertOpen();
    const source = this.source(request.sourceId);
    const cursor = this.cursor(request.sourceId);
    if (!source || !this.assertCas(cursor, request.sourceId, request.expected)) return { kind: 'stale' };
    this.begin();
    try {
      const latest = this.cursor(request.sourceId);
      if (!this.assertCas(latest, request.sourceId, request.expected)) { this.rollback(); return { kind: 'stale' }; }
      const reconciling = this.persistReconcile(latest);
      const persistedSource = this.source(request.sourceId)!;
      const decision = this.decide(reconciling, persistedSource, request);
      if (decision.kind !== 'seal') { this.commit(); return decision; }
      await this.hooks.beforeGenerationSeal?.();
      const gap = this.gapEvent(request.sourceId, decision.oldGeneration.generation, source.task_id, request.observedAt, decision.oldGeneration.gap);
      if (gap) this.addEvent(gap);
      const old = this.db.prepare('SELECT cursor_json FROM source_generations WHERE source_id=? AND generation=?').get(request.sourceId, decision.oldGeneration.generation) as CursorRow | undefined;
      const oldCursor = old ? JSON.parse(old.cursor_json) as CursorState : reconciling;
      const sealedOld = { ...oldCursor, state: 'reconciling' as const, parserState: emptyParserState(oldCursor) };
      this.db.prepare("UPDATE source_generations SET state='sealed',cursor_json=? WHERE source_id=? AND generation=?").run(JSON.stringify(sealedOld), request.sourceId, decision.oldGeneration.generation);
      const newCursor = decision.newCursor;
      this.setCursor(newCursor);
      const startEvent: LogEvent = { version: 1, eventId: `${request.sourceId}:${newCursor.generation}:generation_started`, taskId: source.task_id, sourceId: request.sourceId, generation: newCursor.generation, kind: 'generation_started', startOffset: '0', endOffset: '0', ingestedAt: request.observedAt, text: null, reason: null, displayTruncated: false, recordComplete: null, prefixIncomplete: false, runId: null, bindingId: null };
      this.addEvent(startEvent);
      this.db.prepare('UPDATE source_registry SET recovery_json=NULL WHERE source_id=?').run(request.sourceId);
      this.commit();
      return decision;
    } catch (error) { this.rollback(); throw error; }
  }

  async getSnapshot(): Promise<MonitorSnapshot> {
    this.assertOpen();
    const rows = this.readDb.prepare('SELECT snapshot_json FROM observation_snapshot ORDER BY task_id').all() as ObservationRow[];
    const observations = rows.flatMap((row) => {
      try {
        const parsed = JSON.parse(row.snapshot_json) as PersistedObservation;
        return parsed && parsed.task && typeof parsed.task.taskId === 'string' ? [parsed] : [];
      } catch {
        return [];
      }
    });
    const tasks = observations.map((observation) =>
      this.cachedTaskSnapshot(observation, this.freshObservationTasks.has(observation.task.taskId)));
    const hostMap = new Map<string, HostSnapshot>();

    // First hydrate persisted 0-task (and any other) host snapshots
    const hostRows = this.readDb.prepare('SELECT host_id, snapshot_json FROM host_snapshots ORDER BY host_id').all() as { host_id: string; snapshot_json: string }[];
    for (const row of hostRows) {
      try {
        const parsed = JSON.parse(row.snapshot_json) as HostSnapshot;
        if (!parsed || typeof parsed.hostId !== 'string') continue;
        const fresh = this.freshHostSnapshots.has(parsed.hostId);
        if (fresh) {
          hostMap.set(parsed.hostId, parsed);
        } else {
          const wasConnected = parsed.connection === 'connected';
          hostMap.set(parsed.hostId, {
            ...parsed,
            connection: wasConnected ? 'disconnected' : parsed.connection,
            freshness: parsed.observedAt ? 'stale' : parsed.freshness,
            scanComplete: false,
            errorCode: wasConnected ? (parsed.errorCode ?? 'CACHED_OFFLINE') : parsed.errorCode,
          });
        }
      } catch {
        // Ignore malformed host snapshot
      }
    }

    // Merge host snapshots derived from task observations
    const hostIds = [...new Set(observations.map((observation) => observation.task.hostId))];
    for (const hostId of hostIds) {
      const hostObservations = observations.filter((observation) => observation.task.hostId === hostId);
      const host = this.cachedHostSnapshot(hostObservations, this.freshObservationTasks);
      if (host && (!hostMap.has(hostId) || !this.freshHostSnapshots.has(hostId))) {
        hostMap.set(hostId, host);
      }
    }

    const hosts = [...hostMap.values()].sort((a, b) => a.hostId.localeCompare(b.hostId));
    const sources = observations.flatMap((observation) =>
      this.cachedSourceSnapshots(observation, this.freshObservationTasks.has(observation.task.taskId)));
    return { version: 1, demo: false, hosts, tasks, sources };
  }

  private decodePageToken(sourceId: string, token: string | null, highWater: number): PageToken {
    if (!token) return { v: 1, sourceId, highWater, beforeSeq: highWater + 1, epoch: this.epoch(sourceId) };
    const parsed = decodeToken<PageToken>(token);
    if (parsed.v !== 1 || parsed.sourceId !== sourceId || parsed.highWater < 0 || parsed.beforeSeq < 0) throw new Error('STALE_CONTINUATION');
    if (this.changedInCapturedRange(sourceId, parsed.epoch, parsed.highWater)) throw new Error('STALE_CONTINUATION');
    return parsed;
  }

  private async visible(event: LogEvent, sourceId: string, cutoffMs: number, requestId?: string): Promise<boolean> {
    if (event.text === null || event.startOffset === null || event.endOffset === null) return true;
    return this.isSupported(sourceId, event.generation, event.startOffset, event.endOffset, cutoffMs, requestId);
  }

  async getLogs(query: LogQuery, now = new Date(this.now()).toISOString()): Promise<LogPage> {
    this.assertOpen();
    const latest = this.readDb.prepare('SELECT COALESCE(MAX(seq),0) AS max_seq FROM log_events').get() as { max_seq: number };
    const token = this.decodePageToken(query.sourceId, query.before, latest.max_seq);
    const source = this.source(query.sourceId, this.readDb);
    if (!source) return { events: [], nextBefore: null, truncatedByBudget: false };
    const rows = this.readDb.prepare('SELECT seq,event_id,source_id,task_id,generation,start_offset,end_offset,ingested_at,text,raw_ansi,event_json FROM log_events WHERE source_id=? AND seq<=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(query.sourceId, token.highWater, token.beforeSeq, Math.min(query.limit, PAGE_EVENT_LIMIT) + 1) as EventRow[];
    const cutoff = isoMillis(now) - MAX_CACHE_AGE_MS;
    const events: LogEvent[] = [];
    let used = 0; let truncatedByBudget = false;
    for (const row of rows) {
      const event = eventFromRow(row);
      if (!await this.visible(event, query.sourceId, cutoff)) continue;
      const bytes = textBytes(event);
      if (events.length >= Math.min(query.limit, PAGE_EVENT_LIMIT) || used + bytes > PAGE_TEXT_BUDGET_BYTES) { truncatedByBudget = true; break; }
      events.push(event); used += bytes;
    }
    const hasMore = rows.length > events.length && events.length > 0;
    const last = rows.find((row) => row.event_id === events.at(-1)?.eventId);
    const nextBefore = hasMore && last ? encodeToken({ ...token, beforeSeq: last.seq }) : null;
    return { events, nextBefore, truncatedByBudget };
  }

  private searchToken(query: LogSearchRequest): SearchToken {
    const sourceIds = [...query.sourceIds].sort();
    const mode = query.mode ?? 'literal';
    const caseSensitive = query.caseSensitive ?? true;
    const level = query.level ?? null;
    const latest = this.readDb.prepare('SELECT COALESCE(MAX(seq),0) AS max_seq FROM log_events').get() as { max_seq: number };
    if (!query.continuation) {
      return {
        v: 1,
        sourceIds,
        literal: query.literal,
        mode,
        caseSensitive,
        level,
        highWater: latest.max_seq,
        beforeSeq: latest.max_seq + 1,
        epochs: Object.fromEntries(sourceIds.map((id) => [id, this.epoch(id)])),
      };
    }
    const token = decodeToken<SearchToken>(query.continuation);
    if (
      token.v !== 1 ||
      token.literal !== query.literal ||
      (token.mode ?? 'literal') !== mode ||
      (token.caseSensitive ?? true) !== caseSensitive ||
      (token.level ?? null) !== level ||
      JSON.stringify(token.sourceIds) !== JSON.stringify(sourceIds)
    ) throw new Error('STALE_CONTINUATION');
    for (const id of sourceIds) if (this.changedInCapturedRange(id, token.epochs[id] ?? -1, token.highWater)) throw new Error('STALE_CONTINUATION');
    return token;
  }

  async searchLogs(query: LogSearchRequest, now = new Date(this.now()).toISOString()): Promise<LogSearchPage> {
    this.assertOpen();
    this.searchRequests.add(query.requestId);
    try {
      const token = this.searchToken(query);
      const mode = token.mode;
      const caseSensitive = token.caseSensitive;
      let regex: RegExp | null = null;
      if (mode === 'regex') {
        if (!isSafeRegexPattern(query.literal)) throw new Error('UNSAFE_REGEX_PATTERN');
        try {
          regex = new RegExp(query.literal, caseSensitive ? '' : 'i');
        } catch {
          throw new Error('INVALID_REGEX_PATTERN');
        }
      }
      const literalLower = !caseSensitive ? query.literal.toLowerCase() : null;
      // FTS5 trigram accelerates any literal substring query >= 3 characters without false negatives!
      const useFts = mode === 'literal' && query.literal.length >= 3 && query.literal.length <= 256 && !/[\u0000]/.test(query.literal);
      const ftsQuery = useFts ? `"${query.literal.replace(/"/g, '""')}"` : null;

      const events: LogEvent[] = [];
      const cutoff = isoMillis(now) - MAX_CACHE_AGE_MS;
      let used = 0; let beforeSeq = token.beforeSeq; let scannedExhausted = false; let truncated = false;
      let lastEmittedSeq: number | null = null;

      while (events.length < SEARCH_RESULT_LIMIT && !scannedExhausted) {
        if (this.canceled.has(query.requestId)) { this.canceled.delete(query.requestId); return { events: [], continuation: null, scope: 'retained_local', cancelled: true }; }
        const sourceClause = token.sourceIds.length ? `e.source_id IN (${token.sourceIds.map(() => '?').join(',')})` : '0';
        let rows: EventRow[];
        if (ftsQuery !== null && token.sourceIds.length > 0) {
          rows = this.readDb.prepare(
            `SELECT e.seq,e.event_id,e.source_id,e.task_id,e.generation,e.start_offset,e.end_offset,e.ingested_at,e.text,e.raw_ansi,e.event_json
             FROM log_events_fts f
             CROSS JOIN log_events e ON e.seq = f.rowid
             WHERE log_events_fts MATCH ? AND ${sourceClause} AND e.seq<=? AND e.seq<?
             ORDER BY e.seq DESC LIMIT ?`,
          ).all(ftsQuery, ...token.sourceIds, token.highWater, beforeSeq, SEARCH_BATCH) as EventRow[];
        } else {
          rows = this.readDb.prepare(
            `SELECT e.seq,e.event_id,e.source_id,e.task_id,e.generation,e.start_offset,e.end_offset,e.ingested_at,e.text,e.raw_ansi,e.event_json
             FROM log_events e
             WHERE ${sourceClause} AND e.seq<=? AND e.seq<?
             ORDER BY e.seq DESC LIMIT ?`,
          ).all(...token.sourceIds, token.highWater, beforeSeq, SEARCH_BATCH) as EventRow[];
        }
        if (rows.length === 0) { scannedExhausted = true; break; }
        for (const row of rows) {
          beforeSeq = row.seq;
          const event = eventFromRow(row);
          if (event.text === null) continue;
          if (!matchesLogLevel(event.text, token.level)) continue;
          const matched = regex
            ? regex.test(event.text)
            : literalLower !== null
              ? event.text.toLowerCase().includes(literalLower)
              : event.text.includes(query.literal);
          if (!matched) continue;
          if (!await this.visible(event, row.source_id, cutoff, query.requestId)) continue;
          const bytes = textBytes(event);
          if (used + bytes > PAGE_TEXT_BUDGET_BYTES) { truncated = true; break; }
          events.push(event); used += bytes;
          lastEmittedSeq = row.seq;
          if (events.length >= SEARCH_RESULT_LIMIT) break;
        }
        if (rows.length < SEARCH_BATCH && !truncated && events.length < SEARCH_RESULT_LIMIT) scannedExhausted = true;
        if (this.hooks.yieldSearch) await this.hooks.yieldSearch();
        else await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.canceled.has(query.requestId)) { this.canceled.delete(query.requestId); return { events: [], continuation: null, scope: 'retained_local', cancelled: true }; }
        if (truncated || events.length >= SEARCH_RESULT_LIMIT) break;
      }
      if ((truncated || events.length >= SEARCH_RESULT_LIMIT) && lastEmittedSeq !== null) beforeSeq = lastEmittedSeq;
      const continuation = !scannedExhausted && (events.length >= SEARCH_RESULT_LIMIT || truncated)
        ? encodeToken({ ...token, beforeSeq }) : null;
      return { events, continuation, scope: 'retained_local', cancelled: false };
    } finally {
      this.searchRequests.delete(query.requestId);
      this.canceled.delete(query.requestId);
    }
  }

  async beginSearchRequest(requestId: string): Promise<void> { this.assertOpen(); this.searchRequests.add(requestId); }
  async cancelRequest(requestId: string): Promise<void> { this.assertOpen(); if (this.searchRequests.has(requestId)) this.canceled.add(requestId); }

  private async hasDiskHeadroom(pendingBytes: number, events: LogEvent[]): Promise<boolean> {
    try {
      const free = await this.diskFree();
      const eventBytes = BigInt(events.reduce((sum, event) => sum + Buffer.byteLength(event.text ?? '', 'utf8') + Buffer.byteLength(encodeEventMeta(event), 'utf8'), 0));
      const projected = BigInt(pendingBytes) * BATCH_STORAGE_MULTIPLIER + eventBytes * 2n + BATCH_STORAGE_FIXED;
      return free >= MIN_FREE_BYTES + projected;
    } catch { return false; }
  }

  private async admitBatch(taskId: string, pendingBytes: number, events: LogEvent[]): Promise<boolean> {
    if (!(await this.hasDiskHeadroom(pendingBytes, events))) return false;
    const global = BigInt(((this.db.prepare("SELECT raw_bytes AS n FROM raw_usage WHERE owner_type='global' AND owner_id='*'").get() as { n: number } | undefined)?.n) ?? 0);
    const task = BigInt(((this.db.prepare("SELECT raw_bytes AS n FROM raw_usage WHERE owner_type='task' AND owner_id=?").get(taskId) as { n: number } | undefined)?.n) ?? 0);
    const totalLimit = this.hooks.rawGlobalLimit?.() ?? RAW_GLOBAL_LIMIT;
    const taskLimit = this.hooks.rawTaskLimit?.() ?? RAW_TASK_LIMIT;
    return global + BigInt(pendingBytes) <= totalLimit && task + BigInt(pendingBytes) <= taskLimit;
  }

  async diagnostics(): Promise<StoreDiagnostics> {
    const raw = this.readDb.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM raw_chunks').get() as { bytes: number };
    const dbInfo = this.databasePath === ':memory:' ? { size: 0 } : await stat(this.databasePath).catch(() => ({ size: 0 } as Awaited<ReturnType<typeof stat>>));
    const walInfo = this.databasePath === ':memory:' ? { size: 0 } : await stat(`${this.databasePath}-wal`).catch(() => ({ size: 0 } as Awaited<ReturnType<typeof stat>>));
    return { databaseBytes: Number(dbInfo.size), walBytes: Number(walInfo.size), rawBytes: raw.bytes, sqliteVersion: this.runtimeInfo().sqlite };
  }

  private async evictRaw(row: SizedRawRow, now: string, taskId: string): Promise<void> {
    this.db.prepare('DELETE FROM raw_chunks WHERE chunk_id=?').run(row.chunk_id);
    this.adjustRawUsage(taskId, -BigInt(row.byte_length));
    const startKey = offsetKey(row.start_offset); const endKey = offsetKey(row.end_offset);
    this.db.prepare(`INSERT INTO cache_evictions(source_id,task_id,generation,start_offset,end_offset,evicted_at,start_key,end_key,
      cleanup_cursor_seq,cleanup_phase,cleanup_group_key,cleanup_cursor_start_key,cleanup_cursor_event_seq)
      VALUES(?,?,?,?,?,?,?,?,'0','predecessor',NULL,NULL,0)`)
      .run(row.source_id, taskId, row.generation, row.start_offset, row.end_offset, now, startKey, endKey);
    const range = this.db.prepare('SELECT * FROM raw_support WHERE source_id=? AND generation=? AND start_key<=? ORDER BY start_key DESC LIMIT 1')
      .get(row.source_id, row.generation, startKey) as SupportRow | undefined;
    if (range && range.ingested_at === row.ingested_at && range.start_key <= startKey && range.end_key >= endKey) {
      this.db.prepare('DELETE FROM raw_support WHERE support_id=?').run(range.support_id);
      if (BigInt(range.start_offset) < BigInt(row.start_offset)) {
        this.db.prepare('INSERT INTO raw_support(source_id,generation,start_offset,end_offset,start_key,end_key,ingested_at) VALUES(?,?,?,?,?,?,?)')
          .run(row.source_id, row.generation, range.start_offset, row.start_offset, range.start_key, startKey, range.ingested_at);
      }
      if (BigInt(row.end_offset) < BigInt(range.end_offset)) {
        this.db.prepare('INSERT INTO raw_support(source_id,generation,start_offset,end_offset,start_key,end_key,ingested_at) VALUES(?,?,?,?,?,?,?)')
          .run(row.source_id, row.generation, row.end_offset, range.end_offset, endKey, range.end_key, range.ingested_at);
      }
    }
    const cursor = this.cursor(row.source_id);
    if (cursor && cursor.generation === row.generation && cursor.parserState.boundedPreview) {
      if (BigInt(row.end_offset) > BigInt(cursor.parserState.recordStartOffset) && BigInt(row.start_offset) < BigInt(cursor.committedOffset)) {
        const next = { ...cursor, parserState: emptyParserState(cursor) };
        this.db.prepare('UPDATE source_cursors SET cursor_json=? WHERE source_id=?').run(JSON.stringify(next), row.source_id);
        this.db.prepare('UPDATE source_generations SET cursor_json=? WHERE source_id=? AND generation=?').run(JSON.stringify(next), row.source_id, row.generation);
      }
    }
    const historical = this.db.prepare('SELECT cursor_json FROM source_generations WHERE source_id=? AND generation=?').get(row.source_id, row.generation) as CursorRow | undefined;
    if (historical) {
      const historicalCursor = JSON.parse(historical.cursor_json) as CursorState;
      if (historicalCursor.parserState.boundedPreview
        && BigInt(row.end_offset) > BigInt(historicalCursor.parserState.recordStartOffset)
        && BigInt(row.start_offset) < BigInt(historicalCursor.committedOffset)) {
        const next = { ...historicalCursor, parserState: emptyParserState(historicalCursor) };
        this.db.prepare('UPDATE source_generations SET cursor_json=? WHERE source_id=? AND generation=?').run(JSON.stringify(next), row.source_id, row.generation);
      }
    }
  }

  private async isSupported(sourceId: string, generation: string, startOffset: string, endOffset: string, cutoffMs: number, requestId?: string): Promise<boolean> {
    const start = BigInt(startOffset); const end = BigInt(endOffset);
    if (end <= start) return true;
    const probe = this.hooks.workProbe ? ' AND t3_support_probe()=1' : '';
    const predecessor = this.readDb.prepare(`SELECT start_offset,end_offset,ingested_at FROM raw_support WHERE source_id=? AND generation=? AND start_key<=?${probe} ORDER BY start_key DESC LIMIT 1`);
    const first = predecessor.get(sourceId, generation, offsetKey(start.toString())) as { start_offset: string; end_offset: string; ingested_at: string } | undefined;
    this.hooks.workBlock?.('support');
    let position = start;
    if (first) {
      const rangeStart = BigInt(first.start_offset); const rangeEnd = BigInt(first.end_offset);
      if (rangeStart <= position && rangeEnd > position && Date.parse(first.ingested_at) > cutoffMs) position = rangeEnd;
    }
    if (position >= end) return true;
    let afterKey: string | null = null;
    let checked = 0;
    const successors = this.readDb.prepare(`SELECT start_offset,end_offset,start_key,ingested_at FROM raw_support
      WHERE source_id=? AND generation=? AND start_key>=? AND start_key<?${probe}
      ORDER BY start_key LIMIT 64`);
    const successorsAfter = this.readDb.prepare(`SELECT start_offset,end_offset,start_key,ingested_at FROM raw_support
      WHERE source_id=? AND generation=? AND start_key>? AND start_key<?${probe}
      ORDER BY start_key LIMIT 64`);
    while (position < end) {
      if (requestId && this.canceled.has(requestId)) return false;
      const args = [sourceId, generation, afterKey ?? offsetKey(position.toString()), offsetKey(end.toString())];
      const rows = (afterKey ? successorsAfter : successors).all(...args) as { start_offset: string; end_offset: string; start_key: string; ingested_at: string }[];
      this.hooks.workBlock?.('support');
      if (!rows.length) return false;
      for (const row of rows) {
        const rangeStart = BigInt(row.start_offset); const rangeEnd = BigInt(row.end_offset);
        if (rangeStart !== position || rangeEnd <= position || Date.parse(row.ingested_at) <= cutoffMs) return false;
        position = rangeEnd;
        afterKey = row.start_key;
        checked++;
        if (position >= end) return true;
      }
      if (rows.length < 64) return false;
      if (checked >= 64) {
        checked = 0;
        if (requestId && this.canceled.has(requestId)) return false;
        if (this.hooks.yieldSearch) await this.hooks.yieldSearch();
        else await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return true;
  }

  private processEventCleanup(): void {
    const queue = this.db.prepare('SELECT * FROM cache_evictions ORDER BY eviction_id LIMIT 1').get() as {
      eviction_id: number; source_id: string; generation: string; start_offset: string; end_offset: string;
      start_key: string; end_key: string; cleanup_phase: 'predecessor' | 'forward'; cleanup_group_key: string | null;
      cleanup_cursor_start_key: string | null; cleanup_cursor_event_seq: number;
    } | undefined;
    if (!queue) return;
    const probe = this.hooks.workProbe ? ' AND t3_cleanup_probe()=1' : '';
    const predecessorLookup = this.db.prepare(`SELECT start_key FROM log_events WHERE source_id=? AND generation=? AND text IS NOT NULL AND start_key<?${probe} ORDER BY start_key DESC LIMIT 1`);
    const predecessorGroup = this.db.prepare(`SELECT seq,end_key FROM log_events WHERE source_id=? AND generation=? AND text IS NOT NULL AND start_key=? AND seq>?${probe} ORDER BY seq LIMIT 256`);
    const forwardRows = (startAfter: boolean) => this.db.prepare(`SELECT seq,start_key FROM log_events
      WHERE source_id=? AND generation=? AND text IS NOT NULL AND start_key>=? AND start_key<?
      ${startAfter ? 'AND (start_key>? OR (start_key=? AND seq>?))' : ''}${probe}
      ORDER BY start_key,seq LIMIT ?`);

    let phase = queue.cleanup_phase;
    let groupKey = queue.cleanup_group_key;
    let cursorKey = queue.cleanup_cursor_start_key;
    let cursorSeq = queue.cleanup_cursor_event_seq;
    let used = 0;
    if (phase === 'predecessor') {
      groupKey ??= (predecessorLookup.get(queue.source_id, queue.generation, queue.start_key) as { start_key: string } | undefined)?.start_key ?? null;
      if (groupKey === null) phase = 'forward';
      else {
        const candidates = predecessorGroup.all(queue.source_id, queue.generation, groupKey, cursorSeq) as { seq: number; end_key: string }[];
        this.hooks.workBlock?.('cleanup');
        for (const row of candidates) {
          if (row.end_key > queue.start_key) {
            this.db.prepare('DELETE FROM log_events WHERE seq=?').run(row.seq);
            this.markContentChange(queue.source_id, row.seq);
          }
        }
        used += candidates.length;
        if (candidates.length === 256) {
          this.db.prepare('UPDATE cache_evictions SET cleanup_group_key=?,cleanup_cursor_event_seq=? WHERE eviction_id=?')
            .run(groupKey, candidates.at(-1)!.seq, queue.eviction_id);
          return;
        }
        phase = 'forward';
        cursorKey = null;
        cursorSeq = 0;
      }
    }
    const limit = Math.max(1, 256 - used);
    const stmt = forwardRows(cursorKey !== null);
    const args = cursorKey === null
      ? [queue.source_id, queue.generation, queue.start_key, queue.end_key]
      : [queue.source_id, queue.generation, queue.start_key, queue.end_key, cursorKey, cursorKey, cursorSeq];
    const forward = stmt.all(...args, limit) as { seq: number; start_key: string }[];
    this.hooks.workBlock?.('cleanup');
    for (const row of forward) {
      this.db.prepare('DELETE FROM log_events WHERE seq=?').run(row.seq);
      this.markContentChange(queue.source_id, row.seq);
    }
    if (forward.length === limit) {
      this.db.prepare(`UPDATE cache_evictions SET cleanup_phase='forward',cleanup_group_key=NULL,cleanup_cursor_start_key=?,cleanup_cursor_event_seq=? WHERE eviction_id=?`)
        .run(forward.at(-1)!.start_key, forward.at(-1)!.seq, queue.eviction_id);
    } else this.db.prepare('DELETE FROM cache_evictions WHERE eviction_id=?').run(queue.eviction_id);
  }

  private pruneSeriesAndContentChanges(nowMs: number): void {
    const expiredIso = new Date(nowMs - MAX_CACHE_AGE_MS).toISOString();
    const fineCutoffIso = new Date(nowMs - FINE_SERIES_AGE_MS).toISOString();

    // Rolling deletion beyond 7 days
    this.db.prepare('DELETE FROM metric_samples WHERE observed_at <= ?').run(expiredIso);
    this.db.prepare('DELETE FROM gpu_samples WHERE observed_at <= ?').run(expiredIso);
    this.db.prepare('DELETE FROM host_samples WHERE observed_at <= ?').run(expiredIso);

    // Downsample older-than-24h series into 5-minute buckets (keeping latest sample per bucket)
    this.db.prepare(`
      DELETE FROM gpu_samples
      WHERE observed_at <= ? AND id NOT IN (
        SELECT MAX(id) FROM gpu_samples
        WHERE observed_at <= ?
        GROUP BY host_id, device_id, substr(observed_at, 1, 15)
      )
    `).run(fineCutoffIso, fineCutoffIso);
    this.db.prepare(`
      DELETE FROM host_samples
      WHERE observed_at <= ? AND id NOT IN (
        SELECT MAX(id) FROM host_samples
        WHERE observed_at <= ?
        GROUP BY host_id, substr(observed_at, 1, 15)
      )
    `).run(fineCutoffIso, fineCutoffIso);
    this.db.prepare(`
      DELETE FROM metric_samples
      WHERE observed_at <= ? AND id NOT IN (
        SELECT MAX(id) FROM metric_samples
        WHERE observed_at <= ?
        GROUP BY task_id, metric_name, substr(observed_at, 1, 15)
      )
    `).run(fineCutoffIso, fineCutoffIso);

    // Keep content_changes bounded to latest 128 epochs per source
    const epochRows = this.db.prepare('SELECT source_id, content_epoch FROM source_epochs').all() as { source_id: string; content_epoch: number }[];
    for (const row of epochRows) {
      if (row.content_epoch > 128) {
        this.db.prepare('DELETE FROM content_changes WHERE source_id=? AND content_epoch < ?').run(row.source_id, row.content_epoch - 128);
      }
    }
  }

  async retain(now: string, pending?: { taskId: string; bytes: number }): Promise<{ pausedForDisk: boolean }> {
    this.assertOpen();
    const nowMs = isoMillis(now); const cutoffMs = nowMs - MAX_CACHE_AGE_MS;
    const pausedForDisk = await this.diskFree() < MIN_FREE_BYTES;
    this.begin();
    try {
      let work = 0;
      let workBytes = 0n;
      const expired = this.db.prepare('SELECT chunk_id,source_id,generation,start_offset,end_offset,length(bytes) AS byte_length,ingested_at FROM raw_chunks WHERE ingested_at <= ? ORDER BY chunk_id LIMIT ?')
        .all(new Date(cutoffMs).toISOString(), CLEANUP_ROW_LIMIT) as SizedRawRow[];
      for (const row of expired) {
        const size = BigInt(row.byte_length);
        if (work > 0 && workBytes + size > CLEANUP_BYTE_LIMIT) break;
        const source = this.source(row.source_id);
        if (source) await this.evictRaw(row, now, source.task_id);
        work++; workBytes += size;
      }
      let total = BigInt(((this.db.prepare("SELECT raw_bytes AS bytes FROM raw_usage WHERE owner_type='global' AND owner_id='*'").get() as { bytes: number } | undefined)?.bytes) ?? 0);
      const totalLimit = this.hooks.rawGlobalLimit?.() ?? RAW_GLOBAL_LIMIT;
      const taskLimit = this.hooks.rawTaskLimit?.() ?? RAW_TASK_LIMIT;
      const pendingBytes = BigInt(pending?.bytes ?? 0);
      if (total + pendingBytes > totalLimit) {
        const target = totalLimit * TARGET_PERCENT / 100n;
        const rows = this.db.prepare('SELECT chunk_id,source_id,generation,start_offset,end_offset,length(bytes) AS byte_length,ingested_at FROM raw_chunks ORDER BY ingested_at,chunk_id LIMIT ?').all(Math.max(0, CLEANUP_ROW_LIMIT - work)) as SizedRawRow[];
        for (const row of rows) {
          const size = BigInt(row.byte_length);
          if (total + pendingBytes <= target || workBytes > 0 && workBytes + size > CLEANUP_BYTE_LIMIT) break;
          const source = this.source(row.source_id); if (!source) continue;
          total -= size;
          await this.evictRaw(row, now, source.task_id);
          work++; workBytes += size;
        }
      }
      const tasks = pending ? [pending.taskId] : [];
      for (const taskId of tasks) {
        let taskTotal = BigInt(((this.db.prepare("SELECT raw_bytes AS bytes FROM raw_usage WHERE owner_type='task' AND owner_id=?").get(taskId) as { bytes: number } | undefined)?.bytes) ?? 0);
        const taskPending = taskId === pending?.taskId ? pendingBytes : 0n;
        if (taskTotal + taskPending <= taskLimit) continue;
        const target = taskLimit * TARGET_PERCENT / 100n;
        const rows = this.db.prepare('SELECT r.chunk_id,r.source_id,r.generation,r.start_offset,r.end_offset,length(r.bytes) AS byte_length,r.ingested_at FROM raw_chunks r JOIN source_registry s ON s.source_id=r.source_id WHERE s.task_id=? ORDER BY r.ingested_at,r.chunk_id LIMIT ?').all(taskId, Math.max(0, CLEANUP_ROW_LIMIT - work)) as SizedRawRow[];
        for (const row of rows) {
          const size = BigInt(row.byte_length);
          if (taskTotal + taskPending <= target || workBytes > 0 && workBytes + size > CLEANUP_BYTE_LIMIT) break;
          taskTotal -= size;
          await this.evictRaw(row, now, taskId);
          work++; workBytes += size;
        }
      }
      this.processEventCleanup();
      this.pruneSeriesAndContentChanges(nowMs);
      this.db.exec('PRAGMA incremental_vacuum(128)');
      this.commit();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const diag = await this.diagnostics();
      if (diag.walBytes > (this.hooks.walCheckpointThreshold?.() ?? 64 * 1024 * 1024)) {
        try {
          const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy?: number; log?: number; checkpointed?: number };
          void checkpoint;
        } catch { /* The committed store stays usable; retry during a later retain. */ }
      }
      return { pausedForDisk };
    } catch (error) { this.rollback(); throw error; }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.separateReadDb) {
      try { this.readDb.close(); } catch { /* ignore */ }
    }
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* Keep close bounded even if a checkpoint is unavailable. */ }
    this.db.close();
    this.closed = true;
    this.canceled.clear();
  }
}

export function storeLimits(): { rawGlobalBytes: bigint; rawTaskBytes: bigint; ageMs: number; minFreeBytes: bigint } {
  return { rawGlobalBytes: RAW_GLOBAL_LIMIT, rawTaskBytes: RAW_TASK_LIMIT, ageMs: MAX_CACHE_AGE_MS, minFreeBytes: MIN_FREE_BYTES };
}
