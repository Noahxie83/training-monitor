import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreEngine } from '../../src/store/engine';
import { openStore } from '../../src/store/client';
import { NOW, observation, readReply } from './helpers/fixtures';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
