import { describe, expect, it, vi } from 'vitest';
import { AutoStartController, launchConfigHash } from '../../src/launch/controller';
import { validateRegistry } from '../../src/shared/validate';
import type { Registry } from '../../src/shared/contracts';
import type { HostObservation, ServerWaitResult, Transport } from '../../src/transport/types';

export function autoRegistry(): Registry {
  return { version: 2, revision: 1, hosts: [{ hostId: 'h', label: 'Lab', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'gpu-node' } }],
    tasks: [{ taskId: 't', hostId: 'h', label: 'train', enabled: true, algorithm: '', allowedDirectories: ['/allowed/run'], entryPaths: ['train.py'], checkpointDirectories: [],
      sources: [{ sourceId: 'log', kind: 'log', path: '/allowed/run/output.log' }], autoStart: { execution: 'server_tmux', enabled: true,
        armId: '12345678-1234-4234-8234-123456789abc', gpuDeviceIds: [], idleSeconds: 60, maxUtilizationPercent: 5, maxMemoryMiB: 1024,
        launch: { pythonPath: '/usr/bin/python3', entryPath: 'train.py', cwd: '/allowed/run', arguments: '--name "test run"', logSourceId: 'log' } } }] };
}
function fixture() {
  const registry = autoRegistry();
  const hash = () => launchConfigHash(registry.hosts[0]!, registry.tasks[0]!);
  let remote: ServerWaitResult = { state: 'missing', armId: registry.tasks[0]!.autoStart!.armId, configHash: hash(), idleElapsedSeconds: 0, requiredIdleSeconds: 60,
    lastCheckedAt: null, startedAt: null, pid: null, errorCode: null, message: null, sessionName: null, selectedDeviceId: null };
  const get = vi.fn(async () => structuredClone(remote));
  const ensure = vi.fn(async () => { remote = { ...remote, state: 'waiting', sessionName: 'tm-wait-' + 'a'.repeat(40) }; return structuredClone(remote); });
  const launch = vi.fn();
  const transport = { getServerWait: get, ensureServerWait: ensure, launchTask: launch } as unknown as Transport;
  const options = { clock: () => Date.parse('2026-11-11T00:00:00Z'), registryProvider: async () => registry };
  let controller = new AutoStartController(options);
  const host: HostObservation = { hostId: 'h', connection: 'connected', freshness: 'fresh', observedAt: '2026-11-11T00:00:00Z', scanComplete: true,
    hostBootId: 'boot', phase: null, errorCode: null };
  async function tick(signal = new AbortController().signal) { controller.synchronize(registry); await controller.evaluate(registry.hosts[0]!, registry.tasks[0]!, host, transport, signal); }
  return { registry, get, ensure, launch, host, tick, status: () => controller.getStatus('t'), restart: () => { controller = new AutoStartController(options); },
    remote: (patch: Partial<ServerWaitResult>) => { remote = { ...remote, ...patch }; } };
}

describe('server-owned GPU wait controller', () => {
  it('recreates a lost session for an enabled persistent waiter', async () => {
    const f = fixture();
    f.registry.tasks[0]!.autoStart!.retryOnExit = true;
    f.remote({ state: 'failed', errorCode: 'SERVER_WAITER_LOST',
      configHash: launchConfigHash(f.registry.hosts[0]!, f.registry.tasks[0]!) });
    await f.tick();
    expect(f.ensure).toHaveBeenCalledTimes(1);
    expect(f.status()?.phase).toBe('waiting');
  });
  it('requires a registered completion status source for persistent retry', () => {
    const registry = autoRegistry(); const task = registry.tasks[0]!;
    task.autoStart!.retryOnExit = true;
    expect(() => validateRegistry(registry)).toThrow('INVALID_AUTO_START');
    task.sources.push({ sourceId: 'status', kind: 'status_json', path: '/allowed/run/status.json' });
    expect(validateRegistry(registry).tasks[0]!.autoStart!.retryOnExit).toBe(true);
  });
  it('submits one persistent job and never launches from the desktop', async () => {
    const f = fixture(); await f.tick(); await f.tick(); expect(f.ensure).toHaveBeenCalledTimes(1); expect(f.launch).not.toHaveBeenCalled();
    expect(f.status()).toMatchObject({ remoteConfirmed: true, execution: 'server_tmux', phase: 'waiting' });
  });
  it('reads continued server countdown after the desktop restarts', async () => {
    const f = fixture(); await f.tick(); f.remote({ state: 'countdown', idleElapsedSeconds: 45, selectedDeviceId: 'GPU 6' }); f.restart(); await f.tick();
    expect(f.status()).toMatchObject({ phase: 'countdown', idleElapsedSeconds: 45, selectedDeviceId: 'GPU 6' }); expect(f.ensure).toHaveBeenCalledTimes(1);
  });
  it('publishes a launch completed while the desktop was closed', async () => {
    const f = fixture(); f.remote({ state: 'started', startedAt: '2026-11-11T00:00:30Z', pid: 42, selectedDeviceId: 'GPU 7' }); await f.tick();
    expect(f.status()).toMatchObject({ phase: 'started', pid: 42, selectedDeviceId: 'GPU 7' }); expect(f.ensure).not.toHaveBeenCalled();
  });
  it('does not need local GPU metrics to submit server monitoring', async () => {
    const f = fixture(); f.host.gpu = { state: 'unavailable', observedAt: null, errorCode: 'LOCAL_SAMPLE_MISSING', metrics: [] }; await f.tick(); expect(f.ensure).toHaveBeenCalledTimes(1);
  });
  it('keeps the remote interval unconfirmed during disconnect and recovers from the server', async () => {
    const f = fixture(); f.remote({ state: 'countdown', idleElapsedSeconds: 30 }); await f.tick(); f.host.connection = 'disconnected'; await f.tick();
    expect(f.status()).toMatchObject({ remoteConfirmed: false, idleElapsedSeconds: 30, errorCode: 'SERVER_WAIT_UNCONFIRMED' });
    f.remote({ idleElapsedSeconds: 55 }); f.host.connection = 'connected'; await f.tick(); expect(f.status()).toMatchObject({ remoteConfirmed: true, idleElapsedSeconds: 55 });
  });
  it.each(['cancelled', 'failed', 'started'] as const)('does not resubmit a %s job', async state => {
    const f = fixture(); f.remote({ state }); await f.tick(); await f.tick(); expect(f.ensure).not.toHaveBeenCalled();
  });
  it('does not silently turn an old desktop rule into a server deployment', async () => {
    const f = fixture(); delete f.registry.tasks[0]!.autoStart!.execution; await f.tick(); expect(f.get).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled();
    expect(f.status()?.errorCode).toBe('SERVER_WAIT_CONFIRMATION_REQUIRED');
  });
  it('rejects WSL server hosting without starting a WSL command', async () => {
    const f = fixture(); f.registry.hosts[0]!.target = { kind: 'wsl', distribution: 'Ubuntu-26.04' }; await f.tick(); expect(f.get).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled();
    expect(f.status()?.errorCode).toBe('SERVER_WAIT_SSH_ONLY');
  });
  it('requires latest enabled registration before submitting', async () => {
    const f = fixture(); const response = await f.get(); f.get.mockImplementationOnce(async () => { f.registry.tasks[0]!.autoStart!.enabled = false; return response; });
    await f.tick(); expect(f.ensure).not.toHaveBeenCalled(); expect(f.status()?.errorCode).toBe('REGISTRY_CHANGED');
  });
  it('recovers an uncertain submission from a later server query', async () => {
    const f = fixture(); f.ensure.mockImplementationOnce(async () => { f.remote({ state: 'countdown', idleElapsedSeconds: 5 }); throw new Error('timeout'); });
    await f.tick(); expect(f.status()?.remoteConfirmed).toBe(false); await f.tick(); expect(f.status()).toMatchObject({ remoteConfirmed: true, phase: 'countdown' }); expect(f.ensure).toHaveBeenCalledTimes(1);
  });
  it('does not submit after a pre-cancelled request', async () => { const f = fixture(); const abort = new AbortController(); abort.abort(); await f.tick(abort.signal); expect(f.get).not.toHaveBeenCalled(); });
  it('keeps disabled rules inactive', async () => { const f = fixture(); f.registry.tasks[0]!.autoStart!.enabled = false; await f.tick(); expect(f.get).not.toHaveBeenCalled(); });
  it('fails closed on mismatched remote identity', async () => { const f = fixture(); f.remote({ armId: 'incorrect' }); await f.tick(); expect(f.status()?.remoteConfirmed).toBe(false); expect(f.ensure).not.toHaveBeenCalled(); });
  it('validates server-only configuration with no manual GPU selection', () => {
    expect(validateRegistry(autoRegistry()).tasks[0]!.autoStart!.gpuDeviceIds).toEqual([]);
    const r = autoRegistry(); r.hosts[0]!.target = { kind: 'wsl', distribution: 'Ubuntu-26.04' }; expect(() => validateRegistry(r)).toThrow('AUTO_START_SSH_ONLY');
  });
});
