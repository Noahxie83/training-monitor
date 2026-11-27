import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NOW, observation, readReply } from './helpers/fixtures';
import { openTestStore } from './helpers/test-client';

const openStore = (await import('../../src/store/client').catch(() => null))?.openStore;
const dirs: string[] = [];
async function create() {
  expect(openStore, 'store query API must be implemented').toBeTypeOf('function');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-query-'));
  dirs.push(directory);
  return (openStore as NonNullable<typeof openStore>)({ directory, now: () => Date.parse(NOW) });
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('local log queries', () => {
  it('keeps a retained record visible and searchable across more than 256 chunks while unfinished and completed', async () => {
    const db = await create();
    let cursor = await db.registerSource('many-chunks', observation(), 'task-a');
    let full = Buffer.alloc(0);
    for (let i = 0; i < 257; i++) {
      full = Buffer.concat([full, Buffer.from('x')]);
      expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('x'), NOW, full), ingestedAt: NOW })).toBe('committed');
      cursor = (await db.getCursor('many-chunks'))!;
    }
    const unfinished = await db.getLogs({ requestId: 'many-chunks-preview', sourceId: 'many-chunks', before: null, limit: 10 });
    expect(unfinished.events).toContainEqual(expect.objectContaining({ text: 'x'.repeat(257), recordComplete: false }));
    const searchPreview = await db.searchLogs({ requestId: 'many-chunks-search-preview', sourceIds: ['many-chunks'], literal: 'x'.repeat(257), continuation: null });
    expect(searchPreview.events).toContainEqual(expect.objectContaining({ text: 'x'.repeat(257), recordComplete: false }));

    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('\n'), NOW, Buffer.concat([full, Buffer.from('\n')])), ingestedAt: NOW })).toBe('committed');
    const completed = await db.getLogs({ requestId: 'many-chunks-completed', sourceId: 'many-chunks', before: null, limit: 10 });
    expect(completed.events).toContainEqual(expect.objectContaining({ text: 'x'.repeat(257), recordComplete: true }));
    const searchComplete = await db.searchLogs({ requestId: 'many-chunks-search-complete', sourceIds: ['many-chunks'], literal: 'x'.repeat(257), continuation: null });
    expect(searchComplete.events).toContainEqual(expect.objectContaining({ text: 'x'.repeat(257), recordComplete: true }));
    await db.close();
  }, 30_000);

  it('preserves a cancellation acknowledged while search is queued behind a generation seal', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-queued-search-cancel-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('queued-search', observation(), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('queued result\n')), ingestedAt: NOW })).toBe('committed');
    const tracked = (await db.getCursor('queued-search'))!;
    await db.test.pauseAt('beforeGenerationSeal');
    const sealing = db.reconcileSource({
      sourceId: 'queued-search',
      expected: { generation: tracked.generation, revision: tracked.revision, committedOffset: tracked.committedOffset },
      candidateScan: { status: 'inconclusive', ranges: [] },
      newFile: { status: 'stable', observation: observation(Buffer.from('replacement')) },
      observedAt: NOW,
    });
    await db.test.waitForPause();
    const search = db.searchLogs({ requestId: 'queued-cancel', sourceIds: ['queued-search'], literal: 'queued', continuation: null });
    await db.cancelRequest('queued-cancel');
    db.test.releasePause();
    expect((await sealing).kind).toBe('seal');
    await expect(search).resolves.toMatchObject({ cancelled: true, events: [], continuation: null });
    await db.close();
  });

  it('uses exclusive keyset paging with a fixed high-water mark and rejects a token for another source', async () => {
    const db = await create();
    const cursor = await db.registerSource('s', observation(), 'task-a');
    const payload = Buffer.from(Array.from({ length: 505 }, (_, i) => `line-${i.toString().padStart(3, '0')}\n`).join(''));
    await db.commitRead({ expected: cursor, reply: readReply(cursor, payload), ingestedAt: NOW });
    const first = await db.getLogs({ requestId: 'p1', sourceId: 's', before: null, limit: 500 });
    expect(first.events).toHaveLength(500);
    expect(first.nextBefore).not.toBeNull();
    const second = await db.getLogs({ requestId: 'p2', sourceId: 's', before: first.nextBefore, limit: 500 });
    expect(second.events).toHaveLength(5);
    await expect(db.getLogs({ requestId: 'x', sourceId: 'other', before: first.nextBefore, limit: 10 })).rejects.toThrow('STALE_CONTINUATION');
    await db.close();
  });

  it('keeps a captured page usable when a preview above its high-water mark is upserted', async () => {
    const db = await create();
    let cursor = await db.registerSource('s', observation(), 'task-a');
    await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('a\nb\nc\n')), ingestedAt: NOW });
    const first = await db.getLogs({ requestId: 'captured', sourceId: 's', before: null, limit: 1 });
    expect(first.events.map((event) => event.text)).toEqual(['c']);
    expect(first.nextBefore).not.toBeNull();
    cursor = (await db.getCursor('s'))!;
    await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('next')), ingestedAt: NOW, });
    cursor = (await db.getCursor('s'))!;
    await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from(' more'), NOW, Buffer.from('a\nb\nc\nnext more')), ingestedAt: NOW });
    const second = await db.getLogs({ requestId: 'continue', sourceId: 's', before: first.nextBefore, limit: 1 });
    expect(second.events.map((event) => event.text)).toEqual(['b']);
    await db.close();
  });

  it('invalidates a captured page when an event inside its high-water range changes', async () => {
    const db = await create();
    let cursor = await db.registerSource('s', observation(), 'task-a');
    await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('finished\nnext\n')), ingestedAt: NOW });
    const first = await db.getLogs({ requestId: 'captured-preview', sourceId: 's', before: null, limit: 1 });
    await db.retain(new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString());
    await expect(db.getLogs({ requestId: 'stale-preview', sourceId: 's', before: first.nextBefore, limit: 1 })).rejects.toThrow('STALE_CONTINUATION');
    await db.close();
  });

  it('matches literal text and lets a cancellation message run between yielded search batches', async () => {
    const db = await create();
    const cursor = await db.registerSource('s', observation(), 'task-a');
    const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => `row ${i} marker\n`).join(''));
    await db.commitRead({ expected: cursor, reply: readReply(cursor, payload), ingestedAt: NOW });
    const search = db.searchLogs({ requestId: 'cancel-me', sourceIds: ['s'], literal: 'marker', continuation: null });
    await db.cancelRequest('cancel-me');
    await expect(search).resolves.toMatchObject({ cancelled: true });
    const normal = await db.searchLogs({ requestId: 'normal', sourceIds: ['s'], literal: 'row 17 marker', continuation: null });
    expect(normal.events.some((event) => event.text?.includes('row 17 marker'))).toBe(true);
    expect(normal.scope).toBe('retained_local');
    await db.close();
  });

  it('resumes after the one MiB output budget without skipping the first unreturned match', async () => {
    const db = await create();
    const records = Array.from({ length: 17 }, (_, index) => `budget-hit-${index}-` + 'x'.repeat(64 * 1024 - 20));
    const contents = Buffer.from(`${records.join('\n')}\n`);
    const cursor = await db.registerSource('s', observation(contents), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, contents), ingestedAt: NOW })).toBe('committed');
    const first = await db.searchLogs({ requestId: 'budget-1', sourceIds: ['s'], literal: 'budget-hit-', continuation: null });
    expect(first.events).toHaveLength(16);
    expect(first.continuation).not.toBeNull();
    const second = await db.searchLogs({ requestId: 'budget-2', sourceIds: ['s'], literal: 'budget-hit-', continuation: first.continuation });
    expect(second.events).toHaveLength(1);
    expect(new Set([...first.events, ...second.events].map((event) => event.eventId)).size).toBe(17);
    await db.close();
  });
});
