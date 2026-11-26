import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLaunchLedger, type LaunchRecord } from '../../src/launch/ledger';

let directory: string;

const record = (overrides: Partial<LaunchRecord> = {}): LaunchRecord => ({
  taskId: 'task-1',
  armId: '0d8f6ff0-390a-45a5-91e5-fc7dd116c100',
  configHash: 'a'.repeat(64),
  status: 'attempted',
  pid: 1234,
  startedAt: null,
  errorCode: null,
  ...overrides,
});

const started = (overrides: Partial<LaunchRecord> = {}): LaunchRecord => ({
  ...record({ status: 'started', pid: 2345, startedAt: '2026-11-11T00:00:00Z' }),
  ...overrides,
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'launch-ledger-'));
});

afterEach(async () => {
  if (await isTemporaryDirectory(directory)) await rm(directory, { recursive: true, force: true });
  directory = '';
});

async function isTemporaryDirectory(target: string): Promise<boolean> {
  try {
    await stat(target);
  } catch {
    return false;
  }
  return join(target, 'x').startsWith(join(tmpdir(), 'x'));
}

describe('launch ledger', () => {
  it('claims an absent launch once under concurrency and persists it after reopening', async () => {
    const first = createLaunchLedger(directory);
    const next = record();
    const claims = await Promise.allSettled([first.claim(next), first.claim(next)]);
    expect(claims.filter((result) => result.status === 'fulfilled' && result.value === true)).toHaveLength(1);
    expect(claims.find((result) => result.status === 'fulfilled')).toMatchObject({ value: true });

    expect(await first.get(next.taskId, next.armId)).toEqual(next);
    expect(await first.get(next.taskId, 'ffffffff-ffff-4fff-8fff-ffffffffffff')).toBeNull();
    const reopened = createLaunchLedger(directory);
    expect(await reopened.get(next.taskId, next.armId)).toEqual(next);
    expect(await reopened.claim({ ...next, pid: 9999 })).toBe(false);
  });

  it('serializes claims across independent instances backed by the same directory', async () => {
    const armId = '0d8f6ff0-390a-45a5-91e5-fc7dd116c300';
    const first = createLaunchLedger(directory);
    const second = createLaunchLedger(directory);
    const claims = await Promise.allSettled([
      first.claim(record({ armId })),
      second.claim(record({ armId })),
    ]);
    expect(claims.filter((result) => result.status === 'fulfilled' && result.value === true)).toHaveLength(1);
    expect(claims.find((result) => result.status === 'fulfilled')).toMatchObject({ value: true });
    expect(await first.get('task-1', armId)).toEqual(record({ armId }));
  });

  it('moves one attempted hash through each terminal state and preserves matching finish calls', async () => {
    const ledger = createLaunchLedger(directory);
    const launch = record();
    await ledger.claim(launch);
    await expect(ledger.finish({ ...launch, status: 'attempted', startedAt: null })).rejects.toThrow(/terminal status/);
    await ledger.finish({ ...launch, status: 'started', pid: 2345, startedAt: '2026-11-11T00:00:00Z' });
    const terminal = { ...launch, status: 'started', pid: 2345, startedAt: '2026-11-11T00:00:00Z' } as LaunchRecord;
    expect(await ledger.get('task-1', launch.armId)).toEqual(terminal);
    await ledger.finish({ ...launch, status: 'started', pid: 2345, startedAt: '2026-11-11T00:00:00Z' });
    await expect(ledger.finish({ ...launch, status: 'started', pid: 3456, startedAt: '2026-11-11T00:00:00Z' })).rejects.toThrow(/terminal launch already recorded/);
    await expect(ledger.finish({ ...launch, status: 'failed', pid: null, startedAt: null, errorCode: 'SPAWN_FAILED' })).rejects.toThrow(/terminal launch already recorded/);

    const failureDirectory = await mkdtemp(join(tmpdir(), 'launch-ledger-failed-'));
    const failureLedger = createLaunchLedger(failureDirectory);
    const failureLaunch = record({ armId: '0d8f6ff0-390a-45a5-91e5-fc7dd116c001' });
    await failureLedger.claim(failureLaunch);
    await failureLedger.finish({ ...failureLaunch, status: 'failed', pid: null, startedAt: null, errorCode: 'SPAWN_FAILED' });
    await expect(failureLedger.finish({ ...failureLaunch, status: 'started', pid: 1234, startedAt: '2026-11-11T00:01:00Z', errorCode: null })).rejects.toThrow(/terminal launch already recorded/);
    if (await isTemporaryDirectory(failureDirectory)) await rm(failureDirectory, { recursive: true, force: true });
  });

  it('releases only a matching attempted claim and keeps terminal records immutable', async () => {
    const ledger = createLaunchLedger(directory);
    const firstArmId = '0d8f6ff0-390a-45a5-91e5-fc7dd116c005';
    const secondArmId = '0d8f6ff0-390a-45a5-91e5-fc7dd116c006';
    await expect(ledger.release('task-1', firstArmId, 'a'.repeat(64))).resolves.toBeUndefined();

    await ledger.claim(record({ armId: firstArmId }));
    await ledger.claim(record({ armId: secondArmId }));
    await expect(ledger.release('task-1', firstArmId, 'b'.repeat(64))).rejects.toThrow(/configHash mismatch/);
    await expect(ledger.release('task-1', firstArmId, 'not-a-hash')).rejects.toThrow(/INVALID_LAUNCH_LEDGER/);
    expect(await ledger.get('task-1', firstArmId)).toEqual(record({ armId: firstArmId }));

    await ledger.release('task-1', firstArmId, 'a'.repeat(64));
    expect(await ledger.get('task-1', firstArmId)).toBeNull();
    expect(await ledger.get('task-1', secondArmId)).toEqual(record({ armId: secondArmId }));

    const claimedLaunch = record({ armId: firstArmId });
    await ledger.claim(claimedLaunch);
    await ledger.finish({ ...claimedLaunch, status: 'started', pid: 2345, startedAt: '2026-11-11T00:00:00Z' });
    await expect(ledger.release('task-1', firstArmId, 'a'.repeat(64))).rejects.toThrow(/terminal launch already recorded/);
    expect(await ledger.get('task-1', firstArmId)).toEqual({
      ...claimedLaunch,
      status: 'started',
      pid: 2345,
      startedAt: '2026-11-11T00:00:00Z',
    });
  });

  it('fails closed on malformed or invalid files and does not overwrite them', async () => {
    const path = join(directory, 'auto-start-ledger.json');
    await writeFile(path, '{broken', { encoding: 'utf8' });
    const ledger = createLaunchLedger(directory);
    await expect(ledger.get('task-1', record().armId)).rejects.toThrow(/INVALID_LAUNCH_LEDGER/);
    await expect(ledger.claim(record())).rejects.toThrow(/INVALID_LAUNCH_LEDGER/);
    await expect(ledger.finish({ ...record(), status: 'started', startedAt: '2026-11-11T00:00:00Z' })).rejects.toThrow(/INVALID_LAUNCH_LEDGER/);
    expect(await readFile(path, 'utf8')).toBe('{broken');

    const invalidSchema = JSON.stringify({ version: 1, records: [{ ...record(), extra: true }] });
    await writeFile(path, invalidSchema, 'utf8');
    await expect(ledger.get('task-1', record().armId)).rejects.toThrow(/INVALID_LAUNCH_LEDGER/);
    expect(await readFile(path, 'utf8')).toBe(invalidSchema);
  });

  it('propagates real path and write failures instead of inventing success', async () => {
    const filePathAsDirectory = join(directory, 'occupied-file');
    await writeFile(filePathAsDirectory, 'not a directory', 'utf8');
    const ledger = createLaunchLedger(filePathAsDirectory);
    await expect(ledger.claim(record())).rejects.toMatchObject({ code: 'EEXIST' });

    const blocked = createLaunchLedger(directory);
    await blocked.claim(record({ armId: '0d8f6ff0-390a-45a5-91e5-fc7dd116c002' }));
    const source = await readFile(join(directory, 'auto-start-ledger.json'), 'utf8');
    await expect(blocked.claim(record({ armId: '0d8f6ff0-390a-45a5-91e5-fc7dd116c003', taskId: 'x'.repeat(201) }))).rejects.toThrow(/INVALID_LAUNCH_LEDGER/);
    await expect(blocked.claim(record({ armId: 'not-a-uuid' }))).rejects.toThrow(/INVALID_LAUNCH_LEDGER/);
    await expect(blocked.finish({ ...record({ armId: '0d8f6ff0-390a-45a5-91e5-fc7dd116c004' }), status: 'started', startedAt: '2026-11-11T00:00:00Z' })).rejects.toThrow(/finish requires an attempted record/);
    expect(await readFile(join(directory, 'auto-start-ledger.json'), 'utf8')).toBe(source);
  });
});
