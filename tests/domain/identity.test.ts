import { describe, expect, it } from 'vitest';
import { areProcessKeysEqual, isRegisteredEntryPath, isRegisteredProcessEntry, isStrongProcessKey, makeRunId, processEntry } from '../../src/domain/identity';
import type { ProcessKey } from '../../src/shared/contracts';

describe('domain identity and runId generation', () => {
  const key: ProcessKey = {
    hostBootId: 'boot-1',
    pid: 1234,
    startTicks: '100',
  };
  const canonicalRunIdFixture = 'run:v1:f518a8f0e04592c008b248a0a4bb5711ba82f3e3618e915af4565e21f08b2344';

  it('computes canonical runId using fixed UTF-8 JSON tuple SHA-256', () => {
    const runId = makeRunId('h', 't', key);
    expect(runId).toBe(canonicalRunIdFixture);
  });

  it('compares a registered entry stored relative to the allowed root', () => {
    const task = { allowedDirectories: ['/data/exp'], entryPaths: ['workers/start_worker6.py'] };
    expect(isRegisteredEntryPath(task, '/data/exp/workers/start_worker6.py')).toBe(true);
    expect(isRegisteredEntryPath(task, '/data/exp/workers/start_worker7.py')).toBe(false);
  });

  it('rejects an entry resolved outside the allowed root', () => {
    const task = { allowedDirectories: ['/data/exp'], entryPaths: ['/data/exp/workers/start_worker6.py'] };
    expect(isRegisteredEntryPath(task, '/data/other/start_worker6.py')).toBe(false);
  });

  it('accepts a launcher entry for a bare registered script started from another cwd', () => {
    const task = { allowedDirectories: ['/data/exp'], entryPaths: ['start_worker6.py'] };
    const worker = { cwd: '/data/src', scriptEntry: null, launcherEntry: '/data/exp/start_worker6.py' };
    expect(isRegisteredEntryPath(task, worker.launcherEntry)).toBe(true);
    expect(isRegisteredProcessEntry(task, worker)).toBe(true);
    expect(processEntry(worker)).toBe('/data/exp/start_worker6.py');
  });

  it('rejects a launcher entry outside the registry', () => {
    const task = { allowedDirectories: ['/data/exp'], entryPaths: ['start_worker6.py'] };
    expect(isRegisteredProcessEntry(task, { cwd: '/data/src', scriptEntry: null, launcherEntry: '/data/other/start_worker6.py' })).toBe(false);
    expect(isRegisteredProcessEntry(task, { cwd: '/data/src', scriptEntry: '/data/src/start_worker6.py', launcherEntry: null })).toBe(false);
  });

  it('keeps the exact script entry when no launcher was matched', () => {
    expect(processEntry({ scriptEntry: '/data/exp/start.py', launcherEntry: null })).toBe('/data/exp/start.py');
    expect(processEntry({ scriptEntry: null, launcherEntry: null })).toBe(null);
  });

  it('differentiates runs when startTicks changes on same pid and boot', () => {
    const oldRunId = makeRunId('h', 't', key);
    const newRunId = makeRunId('h', 't', { ...key, startTicks: '2' });
    expect(newRunId).not.toBe(oldRunId);
    expect(newRunId.startsWith('run:v1:')).toBe(true);
  });

  it('differentiates runs when hostBootId changes (system reboot)', () => {
    const oldRunId = makeRunId('h', 't', key);
    const rebootRunId = makeRunId('h', 't', { ...key, hostBootId: 'boot-2' });
    expect(rebootRunId).not.toBe(oldRunId);
  });

  it('differentiates runs across different tasks or hosts', () => {
    const r1 = makeRunId('h1', 't', key);
    const r2 = makeRunId('h2', 't', key);
    const r3 = makeRunId('h1', 't2', key);
    expect(r1).not.toBe(r2);
    expect(r1).not.toBe(r3);
  });

  it('is deterministic and stable on repeated identical inputs', () => {
    expect(makeRunId('h', 't', key)).toBe(makeRunId('h', 't', { ...key }));
  });

  it('rejects weak process keys without valid startTicks, pid or hostBootId', () => {
    expect(() => makeRunId('h', 't', { hostBootId: '', pid: 1234, startTicks: '100' })).toThrow(/ProcessKey/);
    expect(() => makeRunId('h', 't', { hostBootId: 'boot-1', pid: 0, startTicks: '100' })).toThrow(/ProcessKey/);
    expect(() => makeRunId('h', 't', { hostBootId: 'boot-1', pid: -5, startTicks: '100' })).toThrow(/ProcessKey/);
    expect(() => makeRunId('h', 't', { hostBootId: 'boot-1', pid: 1.5, startTicks: '100' })).toThrow(/ProcessKey/);
    expect(() => makeRunId('h', 't', { hostBootId: 'boot-1', pid: 1234, startTicks: '' })).toThrow(/ProcessKey/);
    expect(() => makeRunId('h', 't', { hostBootId: 'boot-1', pid: 1234, startTicks: 'abc' })).toThrow(/ProcessKey/);
  });

  it('validates strong process keys and compares keys strictly', () => {
    expect(isStrongProcessKey(key)).toBe(true);
    expect(isStrongProcessKey(null)).toBe(false);
    expect(isStrongProcessKey({ hostBootId: 'b', pid: 1, startTicks: '' })).toBe(false);
    expect(areProcessKeysEqual(key, { ...key })).toBe(true);
    expect(areProcessKeysEqual(key, { ...key, startTicks: '101' })).toBe(false);
    expect(areProcessKeysEqual(key, null)).toBe(false);
  });
});
