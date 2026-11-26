import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { NOW, observation, readReply } from './helpers/fixtures';
import { openTestStore } from './helpers/test-client';
import { connectStoreWorker } from '../../src/store/client';

const openStore = (await import('../../src/store/client').catch(() => null))?.openStore;
const dirs: string[] = [];
async function store() {
  expect(openStore, 'openStore must provide the persistent worker-backed store API').toBeTypeOf('function');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-store-'));
  dirs.push(directory);
  return (openStore as NonNullable<typeof openStore>)({ directory, now: () => Date.parse(NOW) });
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('SQLite commit and recovery', () => {
  it('commits raw bytes, parsed events and cursor atomically and reopens at the exact byte offset', async () => {
    const first = await store();
    const cursor = await first.registerSource('s', observation(), 'task-a');
    const result = await first.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('alpha\r\n')), ingestedAt: NOW });
    expect(result).toBe('committed');
    await first.close();
    await expect(first.close()).resolves.toBeUndefined();
    const reopened = await (openStore as NonNullable<typeof openStore>)({ directory: dirs.at(-1)!, now: () => Date.parse(NOW) });
    expect((await reopened.getCursor('s'))?.committedOffset).toBe('7');
    const page = await reopened.getLogs({ requestId: 'r', sourceId: 's', before: null, limit: 500 });
    expect(page.events.map((event) => event.text)).toContain('alpha');
    expect(page.events.find((event) => event.text === 'alpha')?.taskId).toBe('task-a');
    await reopened.close();
  });

  it('rejects stale and partially overlapping reads without duplicating raw ranges', async () => {
    const db = await store();
    const cursor = await db.registerSource('s', observation(), 'task-a');
    const reply = readReply(cursor, Buffer.from('abcdefgh'));
    expect(await db.commitRead({ expected: cursor, reply, ingestedAt: NOW })).toBe('committed');
    expect(await db.commitRead({ expected: cursor, reply, ingestedAt: NOW })).toBe('stale');
    const newer = (await db.getCursor('s'))!;
    const overlap = { ...readReply(newer, Buffer.from('zz')), startOffset: '7' };
    expect(await db.commitRead({ expected: newer, reply: overlap, ingestedAt: NOW })).toBe('stale');
    await db.close();
  });

  it('does not evict retained bytes when a duplicate normal batch is rejected as stale', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-stale-replay-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    await db.test.setLimits(10, 10);
    const reply = readReply(cursor, Buffer.from('secret'));
    expect(await db.commitRead({ expected: cursor, reply, ingestedAt: NOW })).toBe('committed');
    expect(await db.commitRead({ expected: cursor, reply, ingestedAt: NOW })).toBe('stale');
    expect((await db.diagnostics()).rawBytes).toBe(6);
    expect((await db.getCursor('s'))?.committedOffset).toBe('6');
    expect((await db.getLogs({ requestId: 'duplicate-preserves-text', sourceId: 's', before: null, limit: 10 })).events.map((event) => event.text)).toContain('secret');
    await db.close();
  });

  it('keeps parser carry and invalid-UTF8 state across close and reopen', async () => {
    const db = await store();
    const cursor = await db.registerSource('s', observation(), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from([0xe4, 0xb8])), ingestedAt: NOW })).toBe('committed');
    const after = (await db.getCursor('s'))!;
    expect(after.parserState.utf8CarryBase64).not.toBe('');
    await db.close();
    const reopened = await (openStore as NonNullable<typeof openStore>)({ directory: dirs.at(-1)!, now: () => Date.parse(NOW) });
    expect((await reopened.getCursor('s'))?.parserState).toEqual(after.parserState);
    await reopened.close();
  });

  it('persists an accepted inode-change reconcile before returning and preserves its recovery window', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-read-reconcile-persist-'));
    dirs.push(directory);
    let db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    const reply = readReply(cursor, Buffer.from('x'));
    const changed = { ...reply.before, fileIdentity: { dev: '1', inode: '99' } };
    const effectiveReply = { ...reply, before: changed, after: { ...reply.after, fileIdentity: { dev: '1', inode: '99' } } };
    const result = await db.commitRead({ expected: cursor, reply: effectiveReply, ingestedAt: NOW });
    let persisted = (await db.getCursor('s'))!;
    await db.close();

    db = await openTestStore(directory, () => Date.parse(NOW));
    persisted = (await db.getCursor('s'))!;
    const expected = { generation: persisted.generation, revision: persisted.revision, committedOffset: persisted.committedOffset };
    const continued = await db.reconcileSource({ sourceId: 's', expected, candidateScan: { status: 'inconclusive', ranges: [] }, newFile: { status: 'unconfirmed' }, observedAt: NOW });
    const afterStale = await db.commitRead({ expected: cursor, reply: effectiveReply, ingestedAt: NOW });
    const afterStaleCursor = (await db.getCursor('s'))!;
    await db.close();

    const inspect = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    const recovery = JSON.parse((inspect.prepare('SELECT recovery_json AS value FROM source_registry WHERE source_id=?').get('s') as { value: string }).value) as Record<string, string>;
    inspect.close();
    expect(result).toBe('reconciling');
    expect(persisted).toMatchObject({ state: 'reconciling', revision: cursor.revision + 1, committedOffset: '0', maxObservedOffset: '0' });
    expect(continued.kind).toBe('keep_reconciling');
    expect(afterStale).toBe('stale');
    expect(afterStaleCursor).toMatchObject({ state: 'reconciling', revision: persisted.revision, committedOffset: '0' });
    expect(recovery).toEqual({ initialCommittedOffset: '0', initialMaxObservedOffset: '0' });
  });

  it('does not change a source task mapping when a caller tries to reassign it', async () => {
    const db = await store();
    await db.registerSource('s', observation(), 'task-a');
    await expect(db.registerSource('s', observation(Buffer.from('different')), 'task-b')).rejects.toThrow('SOURCE_TASK_CONFLICT');
    await db.close();
  });

  it('rolls back raw chunks and leaves C unchanged when failure is injected after raw insertion', async () => {
    expect(openStore, 'openStore must provide the persistent worker-backed store API').toBeTypeOf('function');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-rollback-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    await db.test.failNext('beforeCursorWrite');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('atomic\n')), ingestedAt: NOW })).toBe('storage_error');
    expect(await db.diagnostics()).toMatchObject({ rawBytes: 0 });
    await db.close();
    const reopened = await (openStore as NonNullable<typeof openStore>)({ directory, now: () => Date.parse(NOW) });
    expect((await reopened.getCursor('s'))?.committedOffset).toBe('0');
    expect((await reopened.getLogs({ requestId: 'empty', sourceId: 's', before: null, limit: 500 })).events).toEqual([]);
    await reopened.close();
  });

  it('rejects worker exit before ready and unexpected exit(0) after ready, including close', async () => {
    const beforeReady = new Worker('process.exit(1)', { eval: true });
    await expect(connectStoreWorker(beforeReady, () => Date.parse(NOW))).rejects.toThrow('STORE_WORKER_EXIT_1');
    const afterReady = new Worker(`(async () => { const { parentPort } = await import('node:worker_threads'); parentPort.postMessage({ kind: 'ready', runtime: { electron: null, node: process.versions.node, sqlite: 'test' } }); parentPort.on('message', () => {}); setTimeout(() => process.exit(0), 50); })();`, { eval: true });
    const client = await connectStoreWorker(afterReady, () => Date.parse(NOW));
    const pending = client.getCursor('s');
    await expect(pending).rejects.toThrow('STORE_WORKER_EXIT_0');
    const started = Date.now();
    await expect(client.close()).rejects.toThrow('STORE_WORKER_EXIT_0');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
