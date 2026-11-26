import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTestStore } from '../store/helpers/test-client';
import { createProductionApi, type ProductionMonitorApi } from '../../src/collector/service';
import { launchConfigHash } from '../../src/launch/controller';
import type { Registry } from '../../src/shared/contracts';
import type { ServerWaitResult, Transport } from '../../src/transport/types';
let api: ProductionMonitorApi | undefined; let directory: string | undefined;
afterEach(async () => { await api?.stop(); if (directory && path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(directory, { recursive: true, force: true }); });
it('submits persistent waiting, reads remote results and cancels before saving disabled state', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-server-wait-')); const clock = Date.parse('2026-11-11T00:00:00Z');
  let registry: Registry = { version: 1, revision: 1, hosts: [{ hostId: 'h', label: 'h', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'lab-campus' } }],
    tasks: [{ taskId: 't', hostId: 'h', label: 't', enabled: true, algorithm: '', allowedDirectories: ['/allowed/run'], entryPaths: ['train.py'], sources: [{ sourceId: 'log', kind: 'log', path: '/allowed/run/new.log' }], checkpointDirectories: [],
      autoStart: { execution: 'server_tmux', enabled: true, armId: '12345678-1234-4234-8234-123456789abc', gpuDeviceIds: [], idleSeconds: 60, maxUtilizationPercent: 5, maxMemoryMiB: 1024, launch: { pythonPath: '/usr/bin/python3', entryPath: 'train.py', cwd: '/allowed/run', arguments: '', logSourceId: 'log' } } }] };
  const response = (): ServerWaitResult => ({ state: 'missing', armId: registry.tasks[0]!.autoStart!.armId, configHash: launchConfigHash(registry.hosts[0]!, registry.tasks[0]!), idleElapsedSeconds: 0, requiredIdleSeconds: 60,
    lastCheckedAt: null, startedAt: null, pid: null, errorCode: null, message: null, sessionName: null, selectedDeviceId: null });
  let remote = response(); const events: string[] = [];
  const ensure = vi.fn(async () => { remote = { ...response(), state: 'countdown', idleElapsedSeconds: 25, selectedDeviceId: 'GPU 6' }; events.push('ensure'); return remote; });
  let cancelFails = false;
  const cancel = vi.fn(async () => { events.push('cancel'); if (cancelFails) throw new Error('offline'); return { ...remote, state: 'cancelled' }; });
  const transport = { probeHost: async () => ({ hostId: 'h', connection: 'connected', freshness: 'fresh', observedAt: new Date(clock).toISOString(), scanComplete: true, hostBootId: 'boot', phase: null, errorCode: null }),
    probeTask: async () => ({ taskId: 't', hostId: 'h', freshness: 'fresh', observedAt: new Date(clock).toISOString(), scanComplete: true, processScanError: null, processes: [], sources: [], errorCode: null, phase: null }),
    getServerWait: async () => remote, ensureServerWait: ensure, cancelServerWait: cancel } as unknown as Transport;
  const store = await openTestStore(directory, () => clock);
  api = createProductionApi({ store, registryProvider: async () => registry, registrySaver: async value => { events.push('save'); registry = { ...value, revision: value.revision + 1 }; return registry; }, transportProvider: () => transport, clock: () => clock });
  await api.start(); const snapshot = await api.getSnapshot(); expect(snapshot.tasks[0]?.autoStart).toMatchObject({ phase: 'countdown', idleElapsedSeconds: 25, selectedDeviceId: 'GPU 6', remoteConfirmed: true });
  await api.getSnapshot(); expect(ensure).toHaveBeenCalledTimes(1); expect((await store.getSnapshot()).tasks[0]?.autoStart).toBeUndefined();
  const disabled = structuredClone(registry); disabled.tasks[0]!.autoStart!.enabled = false; cancelFails = true;
  await expect(api.saveRegistry(disabled)).rejects.toThrow('原规则仍可能运行'); expect(registry.tasks[0]!.autoStart!.enabled).toBe(true); expect(events).not.toContain('save');
  cancelFails = false; await api.saveRegistry(disabled); expect(events.slice(-2)).toEqual(['cancel', 'save']); expect(registry.tasks[0]!.autoStart!.enabled).toBe(false);
  expect((await api.getSnapshot()).tasks[0]?.autoStart?.phase).toBe('blocked');
});
