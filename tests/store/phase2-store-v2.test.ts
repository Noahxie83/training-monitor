import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreEngine } from '../../src/store/engine';
import { connectStoreWorker, openStore } from '../../src/store/client';
import { NOW, observation, readReply } from './helpers/fixtures';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function seedLargeV1(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      BEGIN;
      PRAGMA user_version = 1;
      CREATE TABLE source_registry(source_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, recovery_json TEXT);
      INSERT INTO source_registry(source_id, task_id) VALUES ('src', 'task');
      CREATE TABLE raw_chunks(
        chunk_id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, generation TEXT NOT NULL,
        start_offset TEXT NOT NULL, end_offset TEXT NOT NULL, bytes BLOB NOT NULL, ingested_at TEXT NOT NULL,
        UNIQUE(source_id, generation, start_offset)
      );
      INSERT INTO raw_chunks(source_id, generation, start_offset, end_offset, bytes, ingested_at)
      VALUES ('src', 'g1', '12', '34', zeroblob(22), '2020-01-01T00:00:00.000Z');
      CREATE TABLE log_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, source_id TEXT NOT NULL,
        task_id TEXT NOT NULL, generation TEXT NOT NULL, start_offset TEXT, end_offset TEXT,
        ingested_at TEXT NOT NULL, text TEXT, event_json TEXT NOT NULL
      );
      CREATE INDEX log_events_text ON log_events(source_id, text, seq DESC);
      CREATE INDEX log_events_source_order ON log_events(source_id, seq DESC);
      WITH RECURSIVE rows(i) AS (VALUES (1) UNION ALL SELECT i+1 FROM rows WHERE i<50001)
      INSERT INTO log_events(event_id, source_id, task_id, generation, ingested_at, text, event_json)
      SELECT 'legacy-' || i, CASE WHEN i IN (3,29999,50000,50001) THEN 'src' ELSE 'bulk' END,
        'task', 'g1', '${NOW}', 'historical-marker ' || i,
        json_object('text', 'historical-marker ' || i, 'rawAnsi', NULL) FROM rows;
      UPDATE log_events SET start_offset='12', end_offset='34' WHERE seq=3;
      UPDATE log_events SET text=NULL WHERE seq=2;
      UPDATE log_events SET text=text || ' 🚀x' WHERE seq=50000;
      UPDATE log_events SET event_json=json_set(event_json, '$.rawAnsi', 'legacy ANSI') WHERE seq=29999;
      COMMIT;
    `);
  } finally {
    db.close();
  }
}

describe('Phase 2 SQLite v2 store, FTS5, time-series, and worker resilience', () => {
  it('migrates v1 SQLite database transactionally to v2, drops dead tables/index, slims event_json, and backfills FTS5', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-v1-migrate-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'monitor.sqlite');

    // Construct an authentic v1 schema (user_version = 0) with dead tables and bloated event_json
    const v1 = new DatabaseSync(dbPath);
    v1.exec(`
      CREATE TABLE source_registry(source_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, recovery_json TEXT);
      CREATE TABLE source_cursors(source_id TEXT PRIMARY KEY, cursor_json TEXT NOT NULL);
      CREATE TABLE source_generations(source_id TEXT NOT NULL, generation TEXT NOT NULL, state TEXT NOT NULL, cursor_json TEXT NOT NULL, PRIMARY KEY(source_id, generation));
      CREATE TABLE raw_chunks(chunk_id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, generation TEXT NOT NULL, start_offset TEXT NOT NULL, end_offset TEXT NOT NULL, bytes BLOB NOT NULL, ingested_at TEXT NOT NULL);
      CREATE TABLE raw_support(support_id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, generation TEXT NOT NULL, start_offset TEXT NOT NULL, end_offset TEXT NOT NULL, start_key TEXT NOT NULL, end_key TEXT NOT NULL, ingested_at TEXT NOT NULL);
      CREATE TABLE raw_usage(owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, raw_bytes INTEGER NOT NULL, PRIMARY KEY(owner_type, owner_id));
      CREATE TABLE log_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, source_id TEXT NOT NULL, task_id TEXT NOT NULL, generation TEXT NOT NULL, start_offset TEXT, end_offset TEXT, ingested_at TEXT NOT NULL, text TEXT, event_json TEXT NOT NULL, start_key TEXT, end_key TEXT);
      CREATE INDEX log_events_text ON log_events(source_id, text);
      CREATE TABLE cache_evictions(eviction_id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, task_id TEXT NOT NULL, generation TEXT NOT NULL, start_offset TEXT NOT NULL, end_offset TEXT NOT NULL, evicted_at TEXT NOT NULL, start_key TEXT NOT NULL, end_key TEXT NOT NULL, cleanup_cursor_seq TEXT NOT NULL DEFAULT '0', cleanup_phase TEXT NOT NULL DEFAULT 'predecessor', cleanup_group_key TEXT, cleanup_cursor_start_key TEXT, cleanup_cursor_event_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE source_epochs(source_id TEXT PRIMARY KEY, content_epoch INTEGER NOT NULL);
      CREATE TABLE content_changes(source_id TEXT NOT NULL, content_epoch INTEGER NOT NULL, event_seq INTEGER NOT NULL, PRIMARY KEY(source_id, content_epoch));
      CREATE TABLE run_bindings(binding_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, generation TEXT NOT NULL, from_offset TEXT NOT NULL, through_offset TEXT NOT NULL, binding_json TEXT NOT NULL);
      CREATE TABLE task_projection(task_id TEXT PRIMARY KEY, projection_json TEXT NOT NULL);
      CREATE TABLE checkpoint_samples(sample_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, observed_at TEXT NOT NULL, sample_json TEXT NOT NULL);
      CREATE TABLE observation_snapshot(task_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL);
    `);
    const sampleText = 'Epoch 2/10 CUDA_MIGRATION_MARKER loss=0.314';
    const bloatedEventJson = JSON.stringify({
      version: 1, eventId: 'ev-v1-1', taskId: 'task-1', sourceId: 'src-1', generation: 'g1',
      kind: 'line', startOffset: '0', endOffset: String(sampleText.length + 1), ingestedAt: NOW,
      text: sampleText, reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false,
      runId: null, bindingId: null,
    });
    v1.prepare('INSERT INTO source_registry(source_id, task_id) VALUES(?, ?)').run('src-1', 'task-1');
    v1.prepare('INSERT INTO source_epochs(source_id, content_epoch) VALUES(?, 0)').run('src-1');
    v1.prepare('INSERT INTO raw_support(source_id, generation, start_offset, end_offset, start_key, end_key, ingested_at) VALUES(?,?,?,?,?,?,?)')
      .run('src-1', 'g1', '0', String(sampleText.length + 1), '0'.repeat(20), String(sampleText.length + 1).padStart(20, '0'), NOW);
    v1.prepare('INSERT INTO log_events(event_id, source_id, task_id, generation, start_offset, end_offset, ingested_at, text, event_json) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('ev-v1-1', 'src-1', 'task-1', 'g1', '0', String(sampleText.length + 1), NOW, sampleText, bloatedEventJson);
    v1.close();

    // Open with StoreEngine v2 — should migrate automatically in a single transaction
    const engine = new StoreEngine(dbPath, () => Date.parse(NOW));
    const search = await engine.searchLogs({
      requestId: 'mig-search', sourceIds: ['src-1'], literal: 'migration_marker',
      continuation: null, mode: 'literal', caseSensitive: false,
    }, NOW);
    expect(search.events).toHaveLength(1);
    expect(search.events[0]!.text).toBe(sampleText);
    await engine.close();

    // Verify schema v2 invariants directly
    const check = new DatabaseSync(dbPath);
    const uv = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(uv).toBe(2);
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).not.toContain('run_bindings');
    expect(tables).not.toContain('task_projection');
    expect(tables).not.toContain('checkpoint_samples');
    expect(tables).toContain('log_events_fts');
    expect(tables).toContain('host_snapshots');
    expect(tables).toContain('metric_samples');
    expect(tables).toContain('gpu_samples');
    expect(tables).toContain('host_samples');
    const idx = check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='log_events_text'").all();
    expect(idx).toHaveLength(0);
    const slimRow = check.prepare("SELECT event_json FROM log_events WHERE event_id='ev-v1-1'").get() as { event_json: string };
    expect(slimRow.event_json).not.toContain('CUDA_MIGRATION_MARKER');
    check.close();
  });

  it('defers large v1 backfill, keeps history searchable, and resumes durable batches after reopen', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-large-v1-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'monitor.sqlite');
    seedLargeV1(dbPath);
    const check = new DatabaseSync(dbPath);
    let engine = new StoreEngine(dbPath, () => Date.parse(NOW));
    const search = (literal = 'historical-marker 2') => engine.searchLogs({
      requestId: 'historical-search', sourceIds: ['src'], literal,
      continuation: null, mode: 'literal',
    }, NOW);
    const ftsCount = (query: string) => check.prepare('SELECT count(*) AS n FROM log_events_fts WHERE log_events_fts MATCH ?')
      .get(query)?.n;
    const historical = '"historical-marker"';
    const cursor = (key: string) => check.prepare('SELECT value FROM store_meta WHERE key=?').get(key)?.value;
    try {
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(ftsCount(historical)).toBe(0);
      expect(cursor('fts_backfill_cursor')).toBe('0');
      expect(cursor('json_slim_cursor')).toBe('0');
      expect(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='log_events_text'").get()).toBeDefined();
      expect((await search()).events.find((event) => event.eventId === 'legacy-29999')?.rawAnsi).toBe('legacy ANSI');
      expect((await search('🚀x')).events.map((event) => event.eventId)).toEqual(['legacy-50000']);

      expect(engine.runBackgroundMigrationStep(7)).toBe(true);
      expect(cursor('fts_backfill_cursor')).toBe('7');
      expect(ftsCount(historical)).toBe(6);
      check.exec(`
        UPDATE log_events SET text='updated-marker' WHERE seq IN (1, 10);
        UPDATE log_events SET text='second-update-marker' WHERE seq=11;
        DELETE FROM log_events WHERE seq=11;
        DELETE FROM log_events WHERE seq IN (4, 50001);
        INSERT INTO log_events(event_id, source_id, task_id, generation, ingested_at, text, event_json)
        VALUES ('new', 'src', 'task', 'g1', '${NOW}', NULL, '{}'),
          ('gap', 'src', 'task', 'g1', '${NOW}', NULL, '{}');
        UPDATE log_events SET text='new-live-marker' WHERE event_id='new';
      `);
      expect(ftsCount('"new-live-marker"')).toBe(1);
      expect(ftsCount('"updated-marker"')).toBe(2);
      expect(ftsCount('"second-update-marker"')).toBe(0);

      await engine.close();
      engine = new StoreEngine(dbPath, () => Date.parse(NOW));
      expect(cursor('json_slim_cursor')).toBe('7');
      let steps = 0;
      while (engine.runBackgroundMigrationStep()) steps++;
      expect(steps).toBeGreaterThan(1);
      expect(cursor('fts_backfill_cursor')).toBeUndefined();
      expect(cursor('json_slim_cursor')).toBeUndefined();
      expect(check.prepare(`SELECT count(*) AS n FROM log_events
        WHERE json_type(event_json, '$.text') IS NOT NULL OR json_type(event_json, '$.rawAnsi') IS NOT NULL`).get()?.n).toBe(0);
      expect(check.prepare('SELECT start_key, end_key FROM log_events WHERE seq=3').get())
        .toMatchObject({ start_key: '0000000002:12', end_key: '0000000002:34' });
      expect(ftsCount(historical)).toBe(49_995);
      expect(ftsCount('"updated-marker"')).toBe(2);
      expect(ftsCount('"new-live-marker"')).toBe(1);
      check.exec("INSERT INTO log_events_fts(log_events_fts, rank) VALUES('integrity-check', 1)");
      expect(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='log_events_text'").get()).toBeUndefined();
      expect((await search()).events.find((event) => event.eventId === 'legacy-29999')?.rawAnsi).toBe('legacy ANSI');
      expect((await search('🚀x')).events.map((event) => event.eventId)).toEqual(['legacy-50000']);
    } finally {
      await engine.close();
      check.close();
    }
  }, 30_000);

  it('opens a large legacy database through the production worker and completes background backfill', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-large-worker-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'monitor.sqlite');
    seedLargeV1(dbPath);
    const client = await openStore({ directory: dir, now: () => Date.parse(NOW) });
    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const page = await client.searchLogs({
        requestId: 'worker-migration', sourceIds: ['src'], literal: 'historical-marker 50001',
        continuation: null, mode: 'literal',
      });
      expect(page.events.map((event) => event.eventId)).toEqual(['legacy-50001']);
      await expect.poll(() => check.prepare('SELECT count(*) AS n FROM store_meta').get()?.n, { timeout: 15_000 }).toBe(0);
      await expect.poll(() => check.prepare('SELECT 1 FROM log_events WHERE seq=3').get()).toBeUndefined();
    } finally {
      check.close();
      await client.close();
    }
  }, 30_000);

  it('extends worker readiness on migration heartbeats up to the total timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
      const ready = connectStoreWorker(worker as unknown as Worker, () => Date.parse(NOW));
      await vi.advanceTimersByTimeAsync(29_000);
      worker.emit('message', { kind: 'migrating' });
      await vi.advanceTimersByTimeAsync(29_000);
      const runtime = { electron: null, node: '22', sqlite: '3' };
      worker.emit('message', { kind: 'ready', runtime });
      expect((await ready).runtime).toEqual(runtime);

      const slowWorker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
      const result = connectStoreWorker(slowWorker as unknown as Worker, () => Date.parse(NOW));
      const rejected = expect(result).rejects.toThrow('STORE_READY_TIMEOUT');
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(25_000);
        slowWorker.emit('message', { kind: 'migrating' });
      }
      await vi.advanceTimersByTimeAsync(19_999);
      expect(slowWorker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(slowWorker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates continuous CR tqdm redraws into 1 row without causing STALE_CONTINUATION', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-cr-storm-'));
    dirs.push(dir);
    const engine = new StoreEngine(path.join(dir, 'monitor.sqlite'), () => Date.parse(NOW));
    let cursor = await engine.registerSource('s', observation(), 'task-a');

    // Write 3 complete lines so we can hold a pagination token on historical lines
    let full = Buffer.from('line-1\nline-2\nline-3\n');
    expect(await engine.commitRead({ expected: cursor, reply: readReply(cursor, full, NOW, full), ingestedAt: NOW })).toBe('committed');
    cursor = (await engine.getCursor('s'))!;

    const page1 = await engine.getLogs({ requestId: 'p1', sourceId: 's', before: null, limit: 1 }, NOW);
    expect(page1.events.map((e) => e.text)).toEqual(['line-3']);
    expect(page1.nextBefore).not.toBeNull();

    // Now simulate 20 continuous tqdm \r redraws followed by final \n!
    for (let i = 1; i <= 20; i++) {
      const chunk = Buffer.from(`tqdm ${i}/20 [00:0${i % 10}<00:00, 10it/s]\r`);
      full = Buffer.concat([full, chunk]);
      expect(await engine.commitRead({ expected: cursor, reply: readReply(cursor, chunk, NOW, full), ingestedAt: NOW })).toBe('committed');
      cursor = (await engine.getCursor('s'))!;
    }
    const finalNl = Buffer.from('\n');
    full = Buffer.concat([full, finalNl]);
    expect(await engine.commitRead({ expected: cursor, reply: readReply(cursor, finalNl, NOW, full), ingestedAt: NOW })).toBe('committed');

    // Only ONE row for the tqdm line (finalized as kind='line'), zero duplicate redraw+line!
    const latest = await engine.getLogs({ requestId: 'all', sourceId: 's', before: null, limit: 50 }, NOW);
    const tqdmEvents = latest.events.filter((e) => e.text?.startsWith('tqdm '));
    expect(tqdmEvents).toHaveLength(1);
    expect(tqdmEvents[0]!.kind).toBe('line');
    expect(tqdmEvents[0]!.text).toContain('tqdm 20/20');

    // Existing pagination cursor MUST still work without throwing STALE_CONTINUATION!
    const page2 = await engine.getLogs({ requestId: 'p2', sourceId: 's', before: page1.nextBefore, limit: 2 }, NOW);
    expect(page2.events.map((e) => e.text)).toEqual(['line-2', 'line-1']);
    await engine.close();
  });

  it('supports FTS5 case-insensitive search, regex search, level filter, and log export', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-fts-regex-'));
    dirs.push(dir);
    const engine = new StoreEngine(path.join(dir, 'monitor.sqlite'), () => Date.parse(NOW));
    const cursor = await engine.registerSource('s', observation(), 'task-a');
    const payload = Buffer.from([
      '[INFO] Training started lr=1e-4',
      '[WARN] Gradient norm spike: 12.4',
      '[ERROR] CUDA out of memory at step 999',
      '[DEBUG] Dataloader batch=12',
    ].join('\n') + '\n');
    await engine.commitRead({ expected: cursor, reply: readReply(cursor, payload, NOW, payload), ingestedAt: NOW });

    const fts = await engine.searchLogs({
      requestId: 'r1', sourceIds: ['s'], literal: 'cuda out of memory', continuation: null,
      mode: 'literal', caseSensitive: false,
    }, NOW);
    expect(fts.events).toHaveLength(1);
    expect(fts.events[0]!.text).toContain('step 999');

    const regex = await engine.searchLogs({
      requestId: 'r2', sourceIds: ['s'], literal: 'step\\s+\\d{3}', continuation: null,
      mode: 'regex', caseSensitive: true,
    }, NOW);
    expect(regex.events).toHaveLength(1);

    await expect(engine.searchLogs({
      requestId: 'r-bad', sourceIds: ['s'], literal: '(a+)+$', continuation: null, mode: 'regex',
    }, NOW)).rejects.toThrow('UNSAFE_REGEX_PATTERN');

    const warnOnly = await engine.searchLogs({
      requestId: 'r3', sourceIds: ['s'], literal: 'norm', continuation: null, level: 'warn',
    }, NOW);
    expect(warnOnly.events).toHaveLength(1);

    const outPath = path.join(dir, 'exported.log');
    const exported = await engine.exportLogs({ sourceIds: ['s'], level: 'error', destinationPath: outPath }, NOW);
    expect(exported.exportedCount).toBe(1);
    expect(exported.path).toBe(outPath);
    expect(await readFile(outPath, 'utf8')).toContain('CUDA out of memory');
    await engine.close();
  });

  it('persists time-series samples with LTTB downsampling and 0-task host snapshots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-series-'));
    dirs.push(dir);
    const baseMs = Date.parse(NOW);
    const engine = new StoreEngine(path.join(dir, 'monitor.sqlite'), () => baseMs + 600_000);

    // Save 300 metric points and query downsampled to maxPoints=40
    const metricSamples = Array.from({ length: 300 }, (_, i) => ({
      taskId: 't-series', runId: 'run-1',
      observedAt: new Date(baseMs + i * 1000).toISOString(),
      step: i, metricName: 'loss', value: 2.0 / (1 + i * 0.05) + (i === 150 ? 1.5 : 0),
    }));
    await engine.saveMetricSamples(metricSamples);
    const res = await engine.getMetricSeries({ taskId: 't-series', metrics: ['loss'], rangeMs: 3600_000, maxPoints: 40 }, new Date(baseMs + 400_000).toISOString());
    expect(res.series.loss).toBeDefined();
    expect(res.series.loss!.length).toBeLessThanOrEqual(40);
    // LTTB preserves first point, last point, and prominent spike at i=150!
    expect(res.series.loss![0]!.step).toBe(0);
    expect(res.series.loss!.at(-1)!.step).toBe(299);
    expect(res.series.loss!.some((p) => p.step === 150)).toBe(true);

    // GPU + host series + 0-task host snapshot persistence
    await engine.saveGpuSamples([{
      hostId: 'h-zero', deviceId: 'GPU 0', observedAt: NOW,
      utilPct: 88, memUsedMiB: 20000, memTotalMiB: 24564, tempC: 65, powerW: 260,
    }]);
    await engine.saveHostSamples([{
      hostId: 'h-zero', observedAt: NOW, cpuPct: 42.5, ramUsedMiB: 16384, ramTotalMiB: 65536,
    }]);
    await engine.saveHostSnapshot({
      version: 1, hostId: 'h-zero', kind: 'ssh', connection: 'connected',
      observedAt: NOW, freshness: 'fresh', lastSuccessAt: NOW, lastProbeDurationMs: 120,
      scanComplete: true, errorCode: null,
    });
    const gpuSeries = await engine.getGpuSeries({ hostId: 'h-zero', rangeMs: 3600_000, maxPoints: 50 }, new Date(baseMs + 60_000).toISOString());
    expect(gpuSeries.gpu).toHaveLength(1);
    expect(gpuSeries.gpu[0]).toMatchObject({ deviceId: 'GPU 0', utilPct: 88, tempC: 65, powerW: 260 });
    expect(gpuSeries.host).toHaveLength(1);
    expect((await engine.getSnapshot()).hosts.some((h) => h.hostId === 'h-zero')).toBe(true);
    await engine.close();
  });

  it('keeps a sample per true five-minute boundary when retaining old metrics', async () => {
    const engine = new StoreEngine(':memory:', () => Date.parse(NOW));
    try {
      await engine.saveMetricSamples(['00:04:10', '00:05:10', '00:09:10', '00:10:10'].map((time, step) => ({
        taskId: 'task', runId: 'run', observedAt: `2026-10-19T${time}.000Z`, step, metricName: 'loss', value: step,
      })));
      await engine.retain('2026-10-21T00:00:00.000Z');
      const result = await engine.getMetricSeries({ taskId: 'task', rangeMs: 3 * 86_400_000 }, '2026-10-21T00:00:00.000Z');
      expect(result.series.loss?.map((point) => point.value)).toEqual([0, 2, 3]);
    } finally {
      await engine.close();
    }
  });

  it('waits for an in-flight worker restart during concurrent close calls', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-close-restart-'));
    dirs.push(directory);
    const store = await openStore({ directory, now: () => Date.parse(NOW) });
    await store.forceTerminateWorkerForTest!();
    const pending = expect(store.getSnapshot()).rejects.toThrow('STORE_CLOSED');
    const first = store.close();
    const second = store.close();
    expect(first).toBe(second);
    await Promise.all([first, second, pending]);
    expect(store.crashCount?.()).toBe(1);
  });

  it('automatically restarts the SQLite store worker after unexpected termination', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-restart-'));
    dirs.push(dir);
    const client = await openStore({ directory: dir, now: () => Date.parse(NOW) });
    const cursor = await client.registerSource('s-resilient', observation(), 'task-r');
    expect(cursor.sourceId).toBe('s-resilient');

    // Kill the underlying worker abruptly
    await client.forceTerminateWorkerForTest?.();
    await new Promise((r) => setTimeout(r, 80));

    // Next operation transparently respawns worker and reads durable WAL state!
    const recovered = await client.getCursor('s-resilient');
    expect(recovered?.sourceId).toBe('s-resilient');
    expect(client.crashCount?.()).toBeGreaterThanOrEqual(1);
    await client.close();
  });
});
