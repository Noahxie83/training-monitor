import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { NOW, observation, readReply } from './helpers/fixtures';
import { openTestStore } from './helpers/test-client';
import { storeLimits } from '../../src/store/engine';

const openStore = (await import('../../src/store/client').catch(() => null))?.openStore;
const dirs: string[] = [];
async function create() {
  expect(openStore, 'store retention API must be implemented').toBeTypeOf('function');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-retention-'));
  dirs.push(directory);
  return (openStore as NonNullable<typeof openStore>)({ directory, now: () => Date.parse(NOW) });
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('cache retention', () => {
  it('hides expired text immediately and removes its raw/event support at the seven-day boundary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-expiry-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('retained line\n')), ingestedAt: NOW });
    const daySeven = new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect((await db.getLogs({ requestId: 'fresh', sourceId: 's', before: null, limit: 500 })).events.length).toBeGreaterThan(0);
    const retained = await db.retain(daySeven);
    expect(retained.pausedForDisk).toBe(false);
    expect((await db.getLogs({ requestId: 'expired', sourceId: 's', before: null, limit: 500 })).events).toEqual([]);
    expect(await db.diagnostics()).toMatchObject({ rawBytes: 0 });
    await db.close();
  });

  it('pauses new reads below the 128 MiB free-space floor without advancing C', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-disk-floor-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    // The test-only worker harness supplies a synthetic disk reading; the production API has no disk override.
    await db.test.setFreeBytesAndWait(127 * 1024 * 1024);
    const result = await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('blocked\n')), ingestedAt: NOW });
    expect(result).toBe('storage_error');
    expect((await db.getCursor('s'))?.committedOffset).toBe(cursor.committedOffset);
    expect((await db.retain(NOW)).pausedForDisk).toBe(true);
    await db.close();
  });

  it('reserves disk headroom for the accepted batch above the free-space floor', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-disk-headroom-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    await db.test.setFreeBytesAndWait(128 * 1024 * 1024 + 1);
    const result = await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('12345678')), ingestedAt: NOW });
    expect(result).toBe('storage_error');
    expect((await db.getCursor('s'))?.committedOffset).toBe('0');
    expect((await db.diagnostics()).rawBytes).toBe(0);
    await db.close();
  });

  it('keeps exact BigInt range support beyond SQLite signed integer casts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-bigint-range-'));
    dirs.push(directory);
    let db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('big-offset', observation(), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('x\n')), ingestedAt: NOW })).toBe('committed');
    await db.close();

    const seed = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    const start = 1180591620717411303424n;
    const end = start + 2n;
    for (const table of ['source_cursors', 'source_generations']) {
      const rows = seed.prepare(table === 'source_cursors'
        ? 'SELECT source_id,cursor_json FROM source_cursors WHERE source_id=?'
        : 'SELECT source_id,generation,cursor_json FROM source_generations WHERE source_id=?').all('big-offset') as { source_id: string; generation?: string; cursor_json: string }[];
      for (const row of rows) {
        const state = JSON.parse(row.cursor_json) as { committedOffset: string; parserState: { recordStartOffset: string } };
        state.committedOffset = end.toString();
        state.parserState.recordStartOffset = end.toString();
        if (table === 'source_cursors') seed.prepare('UPDATE source_cursors SET cursor_json=? WHERE source_id=?').run(JSON.stringify(state), row.source_id);
        else seed.prepare('UPDATE source_generations SET cursor_json=? WHERE source_id=? AND generation=?').run(JSON.stringify(state), row.source_id, row.generation!);
      }
    }
    const event = seed.prepare('SELECT event_id,event_json FROM log_events WHERE source_id=?').get('big-offset') as { event_id: string; event_json: string };
    const parsed = JSON.parse(event.event_json) as { startOffset: string; endOffset: string };
    parsed.startOffset = start.toString();
    parsed.endOffset = end.toString();
    seed.prepare('UPDATE log_events SET start_offset=?,end_offset=?,event_json=? WHERE event_id=?').run(start.toString(), end.toString(), JSON.stringify(parsed), event.event_id);
    seed.prepare('UPDATE raw_chunks SET start_offset=?,end_offset=? WHERE source_id=?').run(start.toString(), end.toString(), 'big-offset');
    seed.prepare('UPDATE raw_support SET start_offset=?,end_offset=?,start_key=?,end_key=? WHERE source_id=?').run(start.toString(), end.toString(), `${String(start.toString().length).padStart(10, '0')}:${start}`, `${String(end.toString().length).padStart(10, '0')}:${end}`, 'big-offset');
    seed.close();

    db = await openTestStore(directory, () => Date.parse(NOW));
    expect((await db.getLogs({ requestId: 'bigint-support', sourceId: 'big-offset', before: null, limit: 10 })).events).toContainEqual(expect.objectContaining({ text: 'x' }));
    await db.close();
  });

  it('does not resurrect an evicted parser prefix when a retained suffix is appended', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-evicted-parser-prefix-'));
    dirs.push(directory);
    let db = await openTestStore(directory, () => Date.parse(NOW));
    await db.test.setLimits(10, 10);
    let cursor = await db.registerSource('s', observation(), 'task-a');
    const secret = Buffer.from('secret');
    const firstCommit = await db.commitRead({ expected: cursor, reply: readReply(cursor, secret), ingestedAt: NOW });
    cursor = (await db.getCursor('s'))!;
    const tail = Buffer.from('-tail');
    const secondCommit = await db.commitRead({ expected: cursor, reply: readReply(cursor, tail, NOW, Buffer.concat([secret, tail])), ingestedAt: NOW });
    const after = (await db.getCursor('s'))!;
    const page = await db.getLogs({ requestId: 'retained-suffix', sourceId: 's', before: null, limit: 10 });
    const search = await db.searchLogs({ requestId: 'search-suffix', sourceIds: ['s'], literal: '-tail', continuation: null });
    await db.close();
    db = await openTestStore(directory, () => Date.parse(NOW));
    cursor = (await db.getCursor('s'))!;
    const reopenedContainsSecret = cursor.parserState.boundedPreview.includes('secret');
    const completedBytes = Buffer.from('!\n');
    const completion = await db.commitRead({ expected: cursor, reply: readReply(cursor, completedBytes, NOW, Buffer.concat([secret, tail, completedBytes])), ingestedAt: NOW });
    const completedPage = await db.getLogs({ requestId: 'suffix-complete', sourceId: 's', before: null, limit: 10 });
    await db.close();
    expect(firstCommit).toBe('committed');
    expect(secondCommit).toBe('committed');
    expect(after.committedOffset).toBe('11');
    expect(after.parserState.boundedPreview).not.toContain('secret');
    expect(after.parserState).toMatchObject({ recordStartOffset: '6', prefixIncomplete: true, displayTruncated: true });
    expect(page.events).toContainEqual(expect.objectContaining({ text: '-tail', startOffset: '6', endOffset: '11', prefixIncomplete: true, displayTruncated: true }));
    expect(search.events).toContainEqual(expect.objectContaining({ text: '-tail', startOffset: '6', endOffset: '11' }));
    expect(reopenedContainsSecret).toBe(false);
    expect(completion).toBe('committed');
    expect(completedPage.events).toContainEqual(expect.objectContaining({ text: '-tail!', startOffset: '6', endOffset: '13', prefixIncomplete: true }));
  });

  it('keeps a long unfinished record preview bounded and does not renew old raw age on append', async () => {
    const db = await create();
    let cursor = await db.registerSource('s', observation(), 'task-a');
    const first = Buffer.from('a'.repeat(64 * 1024));
    await db.commitRead({ expected: cursor, reply: readReply(cursor, first), ingestedAt: NOW });
    cursor = (await db.getCursor('s'))!;
    const more = Buffer.from('b'.repeat(1024));
    const sixDays = new Date(Date.parse(NOW) + 6 * 24 * 60 * 60 * 1000).toISOString();
    await db.commitRead({ expected: cursor, reply: readReply(cursor, more, sixDays, Buffer.concat([first, more])), ingestedAt: sixDays });
    const state = (await db.getCursor('s'))!.parserState;
    expect(Buffer.byteLength(state.boundedPreview, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    const daySevenFromFirst = new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.retain(daySevenFromFirst);
    const after = (await db.getCursor('s'))!.parserState;
    expect(Buffer.byteLength(after.boundedPreview, 'utf8')).toBe(0);
    expect(after.displayTruncated).toBe(true);
    expect(after.prefixIncomplete).toBe(true);
    expect(after.recordStartOffset).toBe((await db.getCursor('s'))?.committedOffset);
    const suffix = Buffer.from('new-tail');
    const dayEight = new Date(Date.parse(NOW) + 8 * 24 * 60 * 60 * 1000).toISOString();
    const afterExpiry = (await db.getCursor('s'))!;
    await db.commitRead({ expected: afterExpiry, reply: readReply(afterExpiry, suffix, dayEight, Buffer.concat([first, more, suffix])), ingestedAt: dayEight });
    const later = await db.getLogs({ requestId: 'suffix', sourceId: 's', before: null, limit: 500 });
    expect(later.events.some((event) => event.text === 'new-tail' && event.displayTruncated && event.prefixIncomplete)).toBe(true);
    await db.close();
  });

  it('uses the declared real quotas while tests exercise the 80 percent target with a tiny injected fixture', async () => {
    expect(storeLimits()).toMatchObject({ rawGlobalBytes: 1024n * 1024n * 1024n, rawTaskBytes: 256n * 1024n * 1024n, minFreeBytes: 128n * 1024n * 1024n });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-quota-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('123456789012')), ingestedAt: NOW })).toBe('committed');
    await db.test.setLimits(10, 10);
    await db.retain(NOW);
    expect((await db.diagnostics()).rawBytes).toBeLessThanOrEqual(8);
    await db.close();
  });

  it('rejects a single batch and existing usage plus batch before advancing C', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-admission-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    let cursor = await db.registerSource('s', observation(), 'task-a');
    await db.test.setLimits(10, 10);
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('12345678901')), ingestedAt: NOW })).toBe('storage_error');
    expect((await db.getCursor('s'))?.committedOffset).toBe('0');
    expect((await db.diagnostics()).rawBytes).toBe(0);
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('123456')), ingestedAt: NOW })).toBe('committed');
    cursor = (await db.getCursor('s'))!;
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('78901'), NOW, Buffer.from('12345678901')), ingestedAt: NOW })).toBe('committed');
    expect((await db.getCursor('s'))?.committedOffset).toBe('11');
    expect((await db.diagnostics()).rawBytes).toBe(5);
    await db.close();
  });

  it('checkpoints after the cleanup commit and can reopen with the committed data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-checkpoint-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('checkpoint-data\n')), ingestedAt: NOW })).toBe('committed');
    expect((await db.diagnostics()).walBytes).toBeGreaterThan(0);
    await db.test.setWalThreshold(0);
    await db.retain(NOW);
    expect((await db.diagnostics()).rawBytes).toBeGreaterThan(0);
    await db.close();
    const reopened = await (openStore as NonNullable<typeof openStore>)({ directory, now: () => Date.parse(NOW) });
    expect((await reopened.getCursor('s'))?.committedOffset).toBe('16');
    await reopened.close();
  });

  it('cleans a finite 70-chunk fixture in 64-row metadata batches and hides unsupported text', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-cleanup-batch-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    let cursor = await db.registerSource('s', observation(), 'task-a');
    let full = Buffer.alloc(0);
    for (let i = 0; i < 70; i++) {
      full = Buffer.concat([full, Buffer.from('x')]);
      expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('x'), NOW, full), ingestedAt: NOW })).toBe('committed');
      cursor = (await db.getCursor('s'))!;
    }
    const daySeven = new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.retain(daySeven);
    expect((await db.diagnostics()).rawBytes).toBe(6);
    expect((await db.getLogs({ requestId: 'hidden-after-batch', sourceId: 's', before: null, limit: 10 })).events).toEqual([]);
    expect((await db.getCursor('s'))?.parserState.boundedPreview).toBe('');
    await db.retain(daySeven);
    expect((await db.diagnostics()).rawBytes).toBe(0);
    await db.close();
  });

  it('resumes evicted event cleanup in 256-row batches and uses the indexed exact-range plan', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-event-cleanup-batch-'));
    dirs.push(directory);
    let db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    const payload = Buffer.from(Array.from({ length: 400 }, (_, index) => `event-${index}\n`).join(''));
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, payload), ingestedAt: NOW })).toBe('committed');
    const daySeven = new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.retain(daySeven);
    await db.close();

    let inspect = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    try {
      const remaining = (inspect.prepare('SELECT COUNT(*) AS n FROM log_events WHERE text IS NOT NULL').get() as { n: number }).n;
      const pending = (inspect.prepare('SELECT COUNT(*) AS n FROM cache_evictions').get() as { n: number }).n;
      const supportPlan = inspect.prepare('EXPLAIN QUERY PLAN SELECT start_offset,end_offset FROM raw_support WHERE source_id=? AND generation=? AND start_key<=? ORDER BY start_key DESC LIMIT 1')
        .all('s', 'generation', '0000000001:0') as { detail: string }[];
      const leftPlan = inspect.prepare('EXPLAIN QUERY PLAN SELECT support_id FROM raw_support WHERE source_id=? AND generation=? AND end_key=? LIMIT 1')
        .all('s', 'generation', '0000000001:0') as { detail: string }[];
      const eventStartPlan = inspect.prepare('EXPLAIN QUERY PLAN SELECT start_key FROM log_events WHERE source_id=? AND generation=? AND text IS NOT NULL AND start_key<? ORDER BY start_key DESC LIMIT 1')
        .all('s', 'generation', '0000000001:0') as { detail: string }[];
      const eventRangePlan = inspect.prepare('EXPLAIN QUERY PLAN SELECT seq,start_key FROM log_events WHERE source_id=? AND generation=? AND text IS NOT NULL AND start_key>=? AND start_key<? ORDER BY start_key,seq LIMIT 256')
        .all('s', 'generation', '0000000001:0', '0000000002:0') as { detail: string }[];
      console.info(`T3_FIX3_SUPPORT_PREDECESSOR_PLAN ${JSON.stringify(supportPlan.map((row) => row.detail))}`);
      console.info(`T3_FIX3_SUPPORT_LEFT_NEIGHBOR_PLAN ${JSON.stringify(leftPlan.map((row) => row.detail))}`);
      console.info(`T3_FIX3_EVENT_PREDECESSOR_PLAN ${JSON.stringify(eventStartPlan.map((row) => row.detail))}`);
      console.info(`T3_FIX3_EVENT_RANGE_PLAN ${JSON.stringify(eventRangePlan.map((row) => row.detail))}`);
      inspect.close();
      expect(remaining).toBe(144);
      expect(pending).toBe(1);
      expect(supportPlan.some((row) => row.detail.includes('raw_support_start'))).toBe(true);
      expect(leftPlan.some((row) => row.detail.includes('raw_support_end'))).toBe(true);
      expect(eventStartPlan.some((row) => row.detail.includes('log_events_text_start_seq'))).toBe(true);
      expect(eventRangePlan.some((row) => row.detail.includes('log_events_text_start_seq'))).toBe(true);
    } finally { try { inspect.close(); } catch { /* already closed */ } }

    db = await openTestStore(directory, () => Date.parse(NOW));
    await db.retain(daySeven);
    await db.close();
    inspect = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    expect((inspect.prepare('SELECT COUNT(*) AS n FROM log_events WHERE text IS NOT NULL').get() as { n: number }).n).toBe(0);
    expect((inspect.prepare('SELECT COUNT(*) AS n FROM cache_evictions').get() as { n: number }).n).toBe(0);
    inspect.close();
  });

  it('proves complete visibility over 16, 128, and 1024 different-time support intervals with 64-candidate blocks', async () => {
    for (const intervalCount of [16, 128, 1024]) {
      const directory = await mkdtemp(path.join(os.tmpdir(), `monitor-support-work-${intervalCount}-`));
      dirs.push(directory);
      let db = await openTestStore(directory, () => Date.parse(NOW));
      const cursor = await db.registerSource(`support-${intervalCount}`, observation(), 'task-a');
      const text = `${'x'.repeat(intervalCount)}\n`;
      expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from(text)), ingestedAt: NOW })).toBe('committed');
      await db.close();

      const raw = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
      const event = raw.prepare('SELECT source_id,generation,end_offset FROM log_events WHERE source_id=? AND text IS NOT NULL').get(`support-${intervalCount}`) as { source_id: string; generation: string; end_offset: string };
      try {
        raw.exec('BEGIN');
        raw.prepare('DELETE FROM raw_support WHERE source_id=?').run(event.source_id);
        const insert = raw.prepare('INSERT INTO raw_support(source_id,generation,start_offset,end_offset,start_key,end_key,ingested_at) VALUES(?,?,?,?,?,?,?)');
        for (let index = 0; index < intervalCount + 1; index++) {
          const start = String(index); const end = String(index + 1);
          const key = (value: string) => `${String(value.length).padStart(10, '0')}:${value}`;
          insert.run(event.source_id, event.generation, start, end, key(start), key(end), new Date(Date.parse(NOW) + index).toISOString());
        }
        raw.exec('COMMIT');
      } finally {
        raw.close();
      }

      db = await openTestStore(directory, () => Date.parse(NOW));
      const page = await db.getLogs({ requestId: `support-page-${intervalCount}`, sourceId: event.source_id, before: null, limit: 10 });
      const search = await db.searchLogs({ requestId: `support-search-${intervalCount}`, sourceIds: [event.source_id], literal: 'x', continuation: null });
      const work = await db.test.getWorkCounts();
      if (intervalCount === 1024) {
        const interrupted = db.searchLogs({ requestId: 'support-proof-cancel', sourceIds: [event.source_id], literal: 'x', continuation: null });
        await db.cancelRequest('support-proof-cancel');
        await expect(interrupted).resolves.toMatchObject({ cancelled: true, events: [], continuation: null });
        const afterCancel = await db.test.getWorkCounts();
        expect(afterCancel.support).toBeGreaterThan(0);
        expect(afterCancel.support).toBeLessThanOrEqual(65);
        console.info(`T3_FIX3_SUPPORT_CANCEL_WORK ${JSON.stringify({ candidatesBeforeCancellation: afterCancel.support, maxCandidatesPerBlock: afterCancel.supportMaxBlock })}`);
      }
      await db.close();
      expect(page.events.some((row) => row.text === text.slice(0, -1))).toBe(true);
      expect(search.events.some((row) => row.text === text.slice(0, -1))).toBe(true);
      expect(work.support).toBeGreaterThanOrEqual(intervalCount + 1);
      expect(work.support).toBeLessThanOrEqual(2 * (intervalCount + 1));
      expect(work.supportMaxBlock).toBeLessThanOrEqual(64);
      expect(work.supportBlocks).toBeGreaterThanOrEqual(Math.ceil((intervalCount + 1) / 64));
      console.info(`T3_FIX3_SUPPORT_WORK ${JSON.stringify({ intervalCount, completeTextVisible: true, candidatesVisited: work.support, blocks: work.supportBlocks, maxCandidatesPerBlock: work.supportMaxBlock })}`);
    }
  }, 15_000);

  it('hides text when indexed support ends before the requested record and visits only the direct predecessor', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-support-missing-after-end-'));
    dirs.push(directory);
    let db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('missing-after-end', observation(), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('x\n')), ingestedAt: NOW })).toBe('committed');
    await db.close();

    const seed = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    const event = seed.prepare('SELECT generation FROM log_events WHERE source_id=? AND text IS NOT NULL').get('missing-after-end') as { generation: string };
    seed.prepare('DELETE FROM raw_support WHERE source_id=?').run('missing-after-end');
    seed.prepare('INSERT INTO raw_support(source_id,generation,start_offset,end_offset,start_key,end_key,ingested_at) VALUES(?,?,?,?,?,?,?)')
      .run('missing-after-end', event.generation, '0', '1', '0000000001:0', '0000000001:1', NOW);
    seed.close();

    db = await openTestStore(directory, () => Date.parse(NOW));
    try {
      const page = await db.getLogs({ requestId: 'missing-after-end', sourceId: 'missing-after-end', before: null, limit: 10 });
      const work = await db.test.getWorkCounts();
      expect(page.events).toEqual([]);
      expect(work.support).toBe(1);
      expect(work.supportMaxBlock).toBe(1);
      console.info(`T3_FIX3_SUPPORT_MISSING_AFTER_END ${JSON.stringify(work)}`);
    } finally { await db.close(); }
  });

  it('locates an exact left support neighbor by end key during a differently-timestamped append', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-support-left-neighbor-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    let cursor = await db.registerSource('left-neighbor', observation(), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('a')), ingestedAt: NOW })).toBe('committed');
    cursor = (await db.getCursor('left-neighbor'))!;
    const later = new Date(Date.parse(NOW) + 1000).toISOString();
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('b'), later, Buffer.from('ab')), ingestedAt: later })).toBe('committed');
    const work = await db.test.getWorkCounts();
    await db.close();
    expect(work.support).toBe(1);
    expect(work.supportMaxBlock).toBe(1);
    console.info(`T3_FIX3_SUPPORT_LEFT_NEIGHBOR_WORK ${JSON.stringify(work)}`);
  });

  it('keeps a new behind-cursor eviction reachable after an older cleanup task advances', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-eviction-behind-cursor-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('queue-source', observation(), 'task-a');
    const payload = Buffer.from(Array.from({ length: 400 }, (_, index) => `line-${index}\n`).join(''));
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, payload), ingestedAt: NOW })).toBe('committed');
    const daySeven = new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.retain(daySeven);
    const firstBatch = await db.test.getWorkCounts();

    const direct = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    const generation = (direct.prepare('SELECT generation FROM log_events WHERE source_id=? LIMIT 1').get('queue-source') as { generation: string }).generation;
    const key = '0000000001:0';
    direct.prepare(`INSERT INTO log_events(event_id,source_id,task_id,generation,start_offset,end_offset,ingested_at,text,event_json,start_key,end_key)
      VALUES('post-cursor-stale-row','queue-source','task-a',?,'0','1',?,'stale','{}',?, '0000000001:1')`).run(generation, NOW, key);
    direct.prepare(`INSERT INTO cache_evictions(source_id,task_id,generation,start_offset,end_offset,evicted_at,start_key,end_key)
      VALUES('queue-source','task-a',?,'0','1',?,?, '0000000001:1')`).run(generation, daySeven, key);
    direct.close();

    await db.retain(daySeven);
    const afterOlderTask = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    const ghostAfterOlder = (afterOlderTask.prepare("SELECT COUNT(*) AS n FROM log_events WHERE event_id='post-cursor-stale-row'").get() as { n: number }).n;
    const pendingAfterOlder = (afterOlderTask.prepare('SELECT COUNT(*) AS n FROM cache_evictions').get() as { n: number }).n;
    afterOlderTask.close();
    await db.retain(daySeven);
    const afterNewTask = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    const ghostAfterNew = (afterNewTask.prepare("SELECT COUNT(*) AS n FROM log_events WHERE event_id='post-cursor-stale-row'").get() as { n: number }).n;
    const pendingAfterNew = (afterNewTask.prepare('SELECT COUNT(*) AS n FROM cache_evictions').get() as { n: number }).n;
    afterNewTask.close();
    await db.close();

    expect(firstBatch.cleanup).toBe(256);
    expect(firstBatch.cleanupMaxBlock).toBeLessThanOrEqual(256);
    expect(ghostAfterOlder).toBe(1);
    expect(pendingAfterOlder).toBe(1);
    expect(ghostAfterNew).toBe(0);
    expect(pendingAfterNew).toBe(0);
    console.info(`T3_FIX3_EVICTION_WORK ${JSON.stringify({ firstBatch, ghostAfterOlder, pendingAfterOlder, ghostAfterNew, pendingAfterNew })}`);
  });

  it('cleans both CR redraw and completed-line events that share one start offset', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-cr-event-cleanup-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    let cursor = await db.registerSource('cr-source', observation(), 'task-a');
    const first = Buffer.from('a\r');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, first), ingestedAt: NOW })).toBe('committed');
    cursor = (await db.getCursor('cr-source'))!;
    const lineFeed = Buffer.from('\n');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, lineFeed, NOW, Buffer.from('a\r\n')), ingestedAt: NOW })).toBe('committed');
    const before = await db.getLogs({ requestId: 'cr-before-expiry', sourceId: 'cr-source', before: null, limit: 10 });
    const daySeven = new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.retain(daySeven);
    await db.close();
    const expired = await openTestStore(directory, () => Date.parse(daySeven));
    const after = await expired.getLogs({ requestId: 'cr-after-expiry', sourceId: 'cr-source', before: null, limit: 10 });
    await expired.close();
    // Phase 2 unifies \r redraw and final \n under one logical line event (no duplicate redraw+line row)
    expect(before.events.filter((event) => event.startOffset === '0' && event.text !== null).map((event) => event.kind).sort()).toEqual(['line']);
    expect(after.events.filter((event) => event.startOffset === '0' && event.text !== null)).toEqual([]);
  });
});
