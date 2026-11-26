import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { NOW, observation, readReply } from './helpers/fixtures';
import { openTestStore } from './helpers/test-client';

const openStore = (await import('../../src/store/client').catch(() => null))?.openStore;
const dirs: string[] = [];
async function create() {
  expect(openStore, 'store reconciliation must be implemented').toBeTypeOf('function');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-generation-'));
  dirs.push(directory);
  const db = await (openStore as NonNullable<typeof openStore>)({ directory, now: () => Date.parse(NOW) });
  return { db, directory };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('generation recovery', () => {
  it('persists the initial recovery C/H once and seals an unknown scan only after a stable replacement', async () => {
    const { db } = await create();
    const cursor = await db.registerSource('s', observation(Buffer.from('old!')), 'task-a');
    const reply = readReply(cursor, Buffer.from('old!'));
    expect(await db.commitRead({ expected: cursor, reply, ingestedAt: NOW })).toBe('committed');
    const committed = (await db.getCursor('s'))!;
    const expected = { generation: committed.generation, revision: committed.revision, committedOffset: committed.committedOffset };
    const first = await db.reconcileSource({ sourceId: 's', expected, candidateScan: { status: 'inconclusive', ranges: [] }, newFile: { status: 'unconfirmed' }, observedAt: NOW });
    expect(first.kind).toBe('keep_reconciling');
    const pending = (await db.getCursor('s'))!;
    expect(pending.state).toBe('reconciling');
    const sealed = await db.reconcileSource({ sourceId: 's', expected: { generation: pending.generation, revision: pending.revision, committedOffset: pending.committedOffset }, candidateScan: { status: 'inconclusive', ranges: [] }, newFile: { status: 'stable', observation: observation(Buffer.from('new')) }, observedAt: NOW });
    expect(sealed.kind).toBe('seal');
    if (sealed.kind === 'seal') expect(sealed.newCursor).toMatchObject({ state: 'tracking', generationStartOffset: '0', committedOffset: '0', maxObservedOffset: '3' });
    await db.close();
  });

  it('commits archive raw bytes and cursor only after the registered-reference read passes T2 validation', async () => {
    const { db } = await create();
    const cursor = await db.registerSource('s', observation(Buffer.from('old')), 'task-a');
    const transition = await db.reconcileSource({ sourceId: 's', expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset }, candidateScan: { status: 'in_progress', ranges: [] }, newFile: { status: 'unconfirmed' }, observedAt: NOW });
    expect(transition.kind).toBe('keep_reconciling');
    const recovering = (await db.getCursor('s'))!;
    const archived = await db.commitArchiveRead({
      expected: recovering,
      evidence: { candidate: { kind: 'registered_rotation', sourceId: 's', candidateId: 'rot-1', registrationId: 'reg-1' }, reply: readReply(recovering, Buffer.from('old')) },
      ingestedAt: NOW,
    });
    expect(archived).toBe('committed');
    expect((await db.getCursor('s'))?.committedOffset).toBe('3');
    await db.close();
  });

  it('does not evict retained bytes when a duplicate archive batch is rejected as stale', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-stale-archive-'));
    dirs.push(directory);
    let db = await openTestStore(directory, () => Date.parse(NOW));
    const archivedBytes = Buffer.from('secret');
    const cursor = await db.registerSource('s', observation(archivedBytes), 'task-a');
    await db.test.setLimits(10, 10);
    const transition = await db.reconcileSource({ sourceId: 's', expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset }, candidateScan: { status: 'in_progress', ranges: [] }, newFile: { status: 'unconfirmed' }, observedAt: NOW });
    expect(transition.kind).toBe('keep_reconciling');
    const recovering = (await db.getCursor('s'))!;
    const evidence = { candidate: { kind: 'registered_rotation' as const, sourceId: 's', candidateId: 'rot-1', registrationId: 'reg-1' }, reply: readReply(recovering, archivedBytes) };
    expect(await db.commitArchiveRead({ expected: recovering, evidence, ingestedAt: NOW })).toBe('committed');
    expect(await db.commitArchiveRead({ expected: recovering, evidence, ingestedAt: NOW })).toBe('stale');
    expect((await db.diagnostics()).rawBytes).toBe(6);
    expect((await db.getCursor('s'))?.committedOffset).toBe('6');
    expect((await db.getLogs({ requestId: 'stale-archive', sourceId: 's', before: null, limit: 10 })).events.map((event) => event.text)).toContain('secret');
    await db.close();
  });

  it('re-prepares an accepted archive suffix after retention clears an unsupported parser prefix', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-archive-evicted-prefix-'));
    dirs.push(directory);
    let db = await openTestStore(directory, () => Date.parse(NOW));
    await db.test.setLimits(10, 10);
    let cursor = await db.registerSource('s', observation(), 'task-a');
    const secret = Buffer.from('secret');
    const tail = Buffer.from('-tail');
    const completionBytes = Buffer.from('!\n');
    const completeArchive = Buffer.concat([secret, tail, completionBytes]);
    const first = await db.commitRead({ expected: cursor, reply: readReply(cursor, secret, NOW, completeArchive), ingestedAt: NOW });
    cursor = (await db.getCursor('s'))!;
    const transition = await db.reconcileSource({ sourceId: 's', expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset }, candidateScan: { status: 'in_progress', ranges: [] }, newFile: { status: 'unconfirmed' }, observedAt: NOW });
    cursor = (await db.getCursor('s'))!;
    const evidence = { candidate: { kind: 'registered_rotation' as const, sourceId: 's', candidateId: 'rot-1', registrationId: 'reg-1' }, reply: readReply(cursor, tail, NOW, completeArchive) };
    const append = await db.commitArchiveRead({ expected: cursor, evidence, ingestedAt: NOW });
    const after = (await db.getCursor('s'))!;
    const page = await db.getLogs({ requestId: 'archive-suffix', sourceId: 's', before: null, limit: 10 });
    const search = await db.searchLogs({ requestId: 'archive-search-suffix', sourceIds: ['s'], literal: '-tail', continuation: null });
    await db.close();
    const reopenedDb = await openTestStore(directory, () => Date.parse(NOW));
    cursor = (await reopenedDb.getCursor('s'))!;
    const completion = await reopenedDb.commitArchiveRead({
      expected: cursor,
      evidence: {
        candidate: { kind: 'registered_rotation', sourceId: 's', candidateId: 'rot-1', registrationId: 'reg-1' },
        reply: readReply(cursor, completionBytes, NOW, completeArchive),
      },
      ingestedAt: NOW,
    });
    const reopened = (await reopenedDb.getCursor('s'))!;
    const completedPage = await reopenedDb.getLogs({ requestId: 'archive-suffix-complete', sourceId: 's', before: null, limit: 10 });
    const completedSearch = await reopenedDb.searchLogs({ requestId: 'archive-search-complete', sourceIds: ['s'], literal: '-tail!', continuation: null });
    await reopenedDb.close();
    expect(first).toBe('committed');
    expect(transition.kind).toBe('keep_reconciling');
    expect(append).toBe('committed');
    expect(after.parserState.boundedPreview).not.toContain('secret');
    expect(after.parserState).toMatchObject({ recordStartOffset: '6', prefixIncomplete: true, displayTruncated: true });
    expect(page.events).toContainEqual(expect.objectContaining({ text: '-tail', startOffset: '6', endOffset: '11', prefixIncomplete: true }));
    expect(search.events).toContainEqual(expect.objectContaining({ text: '-tail', startOffset: '6', endOffset: '11' }));
    expect(completion).toBe('committed');
    expect(reopened.parserState.boundedPreview).not.toContain('secret');
    expect(reopened.parserState).toMatchObject({ recordStartOffset: '13', prefixIncomplete: false, displayTruncated: false });
    expect(completedPage.events).toContainEqual(expect.objectContaining({ text: '-tail!', startOffset: '6', endOffset: '13', prefixIncomplete: true }));
    expect(completedSearch.events).toContainEqual(expect.objectContaining({ text: '-tail!', startOffset: '6', endOffset: '13' }));
  });

  it('seals without retaining historical plaintext and preserves old run binding evidence', async () => {
    const { db, directory } = await create();
    let cursor = await db.registerSource('s', observation(), 'task-a');
    await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('sealed-secret')), ingestedAt: NOW });
    cursor = (await db.getCursor('s'))!;
    const historicalGeneration = cursor.generation;
    await db.close();
    const seed = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    seed.prepare('INSERT INTO run_bindings(binding_id,source_id,generation,from_offset,through_offset,binding_json) VALUES(?,?,?,?,?,?)')
      .run('binding-old', 's', historicalGeneration, '0', '13', '{"runId":"old-run"}');
    seed.close();
    const reopened = await (openStore as NonNullable<typeof openStore>)({ directory, now: () => Date.parse(NOW) });
    const before = (await reopened.getCursor('s'))!;
    await reopened.reconcileSource({ sourceId: 's', expected: { generation: before.generation, revision: before.revision, committedOffset: before.committedOffset }, candidateScan: { status: 'inconclusive', ranges: [] }, newFile: { status: 'unconfirmed' }, observedAt: NOW });
    const reconciling = (await reopened.getCursor('s'))!;
    const sealed = await reopened.reconcileSource({ sourceId: 's', expected: { generation: reconciling.generation, revision: reconciling.revision, committedOffset: reconciling.committedOffset }, candidateScan: { status: 'inconclusive', ranges: [] }, newFile: { status: 'stable', observation: observation(Buffer.from('new')) }, observedAt: NOW });
    expect(sealed.kind).toBe('seal');
    await reopened.retain(new Date(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000).toISOString());
    await reopened.close();
    const check = new DatabaseSync(path.join(directory, 'monitor.sqlite'));
    const historical = check.prepare('SELECT cursor_json FROM source_generations WHERE source_id=? AND generation=?').get('s', historicalGeneration) as { cursor_json: string };
    const parsed = JSON.parse(historical.cursor_json);
    expect(JSON.stringify(parsed)).not.toContain('sealed-secret');
    const current = JSON.parse((check.prepare('SELECT cursor_json FROM source_cursors WHERE source_id=?').get('s') as { cursor_json: string }).cursor_json) as { generation: string };
    expect(check.prepare('SELECT binding_id FROM run_bindings WHERE source_id=? AND generation=?').all('s', historicalGeneration)).toHaveLength(1);
    expect(check.prepare('SELECT binding_id FROM run_bindings WHERE source_id=? AND generation=?').all('s', current.generation)).toHaveLength(0);
    check.close();
  });

  it('survives worker termination during a generation seal with the full old state intact', async () => {
    expect(openStore, 'store reconciliation must be implemented').toBeTypeOf('function');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-generation-crash-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    expect(await db.commitRead({ expected: cursor, reply: readReply(cursor, Buffer.from('old!')), ingestedAt: NOW })).toBe('committed');
    const tracked = (await db.getCursor('s'))!;
    const before = await db.reconcileSource({ sourceId: 's', expected: { generation: tracked.generation, revision: tracked.revision, committedOffset: tracked.committedOffset }, candidateScan: { status: 'in_progress', ranges: [] }, newFile: { status: 'unconfirmed' }, observedAt: NOW });
    expect(before.kind).toBe('keep_reconciling');
    const oldReconciling = (await db.getCursor('s'))!;
    await db.test.pauseAt('beforeGenerationSeal');
    const transition = db.reconcileSource({ sourceId: 's', expected: { generation: oldReconciling.generation, revision: oldReconciling.revision, committedOffset: oldReconciling.committedOffset }, candidateScan: { status: 'inconclusive', ranges: [] }, newFile: { status: 'stable', observation: observation(Buffer.from('new')) }, observedAt: NOW });
    await db.test.waitForPause();
    await db.test.terminate();
    await expect(transition).rejects.toThrow();
    const reopened = await (openStore as NonNullable<typeof openStore>)({ directory, now: () => Date.parse(NOW) });
    expect(await reopened.getCursor('s')).toMatchObject({ generation: oldReconciling.generation, committedOffset: '4', state: 'reconciling' });
    await reopened.close();
  });

  it('serializes concurrent reads and mutations across the asynchronous seal boundary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-generation-queue-'));
    dirs.push(directory);
    const db = await openTestStore(directory, () => Date.parse(NOW));
    const cursor = await db.registerSource('s', observation(), 'task-a');
    const pending = await db.reconcileSource({ sourceId: 's', expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset }, candidateScan: { status: 'in_progress', ranges: [] }, newFile: { status: 'unconfirmed' }, observedAt: NOW });
    expect(pending.kind).toBe('keep_reconciling');
    const reconciling = (await db.getCursor('s'))!;
    await db.test.pauseAt('beforeGenerationSeal');
    const sealing = db.reconcileSource({ sourceId: 's', expected: { generation: reconciling.generation, revision: reconciling.revision, committedOffset: reconciling.committedOffset }, candidateScan: { status: 'inconclusive', ranges: [] }, newFile: { status: 'stable', observation: observation(Buffer.from('replacement')) }, observedAt: NOW });
    await db.test.waitForPause();
    const reader = db.getCursor('s');
    const registrar = db.registerSource('s', observation(Buffer.from('replacement')), 'task-a');
    db.test.releasePause();
    const result = await sealing;
    expect(result.kind).toBe('seal');
    expect((await reader)?.state).toBe('tracking');
    expect((await registrar).generation).toBe((await reader)?.generation);
    await db.close();
  });
});
