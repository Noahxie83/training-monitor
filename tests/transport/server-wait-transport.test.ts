import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createTransport } from '../../src/transport/transport';
import { encodeFrame } from '../../src/transport/protocol';
import type { Registry } from '../../src/shared/contracts';

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { this.emit('close', null); return true; }
}

async function setup(wsl = false, requireWorkerUploadOnFirstEnsure = false) {
  const registry: Registry = {
    version: 2,
    revision: 1,
    hosts: [{
      hostId: 'h',
      label: 'h',
      enabled: true,
      allowedRoots: ['/allowed'],
      target: wsl ? { kind: 'wsl', distribution: 'Ubuntu-24.04' } : { kind: 'ssh', alias: 'gpu-node' },
    }],
    tasks: [{
      taskId: 't',
      hostId: 'h',
      label: 't',
      enabled: true,
      algorithm: '',
      allowedDirectories: ['/allowed/run'],
      entryPaths: ['train.py'],
      checkpointDirectories: [],
      sources: [{ sourceId: 'log', kind: 'log', path: '/allowed/run/output.log' }],
      autoStart: {
        execution: 'server_tmux',
        enabled: true,
        armId: '12345678-1234-4234-8234-123456789abc',
        gpuDeviceIds: [],
        idleSeconds: 60,
        maxUtilizationPercent: 5,
        maxMemoryMiB: 1024,
        launch: {
          pythonPath: '/usr/bin/python3',
          entryPath: 'train.py',
          cwd: '/allowed/run',
          arguments: '--name "hello; not-a-shell"',
          logSourceId: 'log',
        },
      },
    }],
  };
  const requests: any[] = [];
  const calls: any[] = [];
  const stdinSizes: number[] = [];
  let invalid = false;
  let workerPresent = !requireWorkerUploadOnFirstEnsure;
  const probeSource = await readFile('src/probe/readonly_probe.py', 'utf8');
  const launcherSource = await readFile('src/launch/launcher.py', 'utf8');
  const serverAgentSource = await readFile('src/launch/server_agent.py', 'utf8');

  const spawn = (command: string, args: string[], options: any) => {
    const child = new Child();
    const chunks: Buffer[] = [];
    calls.push({ command, args, options });
    child.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stdin.once('end', () => {
      const source = Buffer.concat(chunks).toString('utf8');
      stdinSizes.push(Buffer.byteLength(source, 'utf8'));
      const encoded = source.match(/REQUEST_B64 = "([^"\n]+)"/)![1]!;
      const request = JSON.parse(Buffer.from(encoded, 'base64').toString());
      requests.push(request);
      expect(source).not.toContain('--name "hello; not-a-shell"');

      const agentB64 = source.match(/AGENT_SOURCE_B64 = "([^"\n]+)"/)?.[1];
      const hasFullWorker = Boolean(agentB64 && agentB64 !== '__SERVER_AGENT_SOURCE_B64__');
      if (hasFullWorker) {
        const workerSource = Buffer.from(agentB64!, 'base64').toString('utf8');
        expect(workerSource).toContain('__MONITOR_REQUEST_B64__');
        expect(workerSource).not.toContain(request.requestId);
        workerPresent = true;
      }

      const needsWorker = request.op === 'ensure_server_wait' && !workerPresent && !hasFullWorker;
      const payload = needsWorker
        ? {
            state: 'failed',
            armId: request.armId,
            configHash: request.configHash,
            idleElapsedSeconds: 0,
            requiredIdleSeconds: 60,
            lastCheckedAt: null,
            startedAt: null,
            pid: null,
            errorCode: 'WORKER_SOURCE_REQUIRED',
            message: 'upload worker',
            sessionName: null,
            selectedDeviceId: null,
          }
        : {
            state: request.op === 'cancel_server_wait' ? 'cancelled' : request.op === 'ensure_server_wait' ? 'waiting' : 'missing',
            armId: request.armId,
            configHash: request.configHash,
            idleElapsedSeconds: 0,
            requiredIdleSeconds: 60,
            lastCheckedAt: null,
            startedAt: null,
            pid: null,
            errorCode: null,
            message: null,
            sessionName: invalid ? 'bad;session' : null,
            selectedDeviceId: null,
          };
      const body = encodeFrame(Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, sourceId: null, payload })));
      child.stdout.end(body);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  return {
    registry,
    requests,
    calls,
    stdinSizes,
    invalid: () => { invalid = true; },
    transport: createTransport(
      { hostId: 'h', host: registry.hosts[0]!, registry },
      { probeSource, launcherSource, serverAgentSource, spawn: spawn as never, registryProvider: async () => registry },
    ),
  };
}

const signal = new AbortController().signal;

describe('SSH-only tmux wait transport', () => {
  it('sends persistent retry intent while leaving GPU selection open', async () => {
    const f = await setup();
    const task = f.registry.tasks[0]!;
    task.sources.push({ sourceId: 'status', kind: 'status_json', path: '/allowed/run/status.json' });
    task.autoStart!.retryOnExit = true;
    await f.transport.ensureServerWait!(task, 'a'.repeat(64), signal);
    expect(f.requests[0]).toMatchObject({ retryOnExit: true, idleSeconds: 60, launchRequest: { gpuDevices: [] } });
  });

  it('passes compact scripts for get/cancel and deploys full worker only on WORKER_SOURCE_REQUIRED', async () => {
    const f = await setup(false, true);
    const task = f.registry.tasks[0]!;
    await f.transport.getServerWait!(task, 'a'.repeat(64), signal);
    await f.transport.ensureServerWait!(task, 'a'.repeat(64), signal);
    await f.transport.cancelServerWait!(task, 'a'.repeat(64), signal);
    // get (compact), ensure probe (compact -> WORKER_SOURCE_REQUIRED), ensure upload (full), cancel (compact)
    expect(f.requests.map((r) => r.op)).toEqual(['get_server_wait', 'ensure_server_wait', 'ensure_server_wait', 'cancel_server_wait']);
    expect(f.stdinSizes[0]!).toBeLessThan(80_000);
    expect(f.stdinSizes[1]!).toBeLessThan(80_000);
    expect(f.stdinSizes[2]!).toBeGreaterThan(f.stdinSizes[1]!);
    expect(f.stdinSizes[3]!).toBeLessThan(80_000);
    expect(f.requests[2]).toMatchObject({ idleSeconds: 60, launchRequest: { gpuDevices: [], hostAllowedRoots: ['/allowed'], taskAllowedDirectories: ['/allowed/run'] } });
    expect(f.calls.every((call) => call.command === 'ssh' && call.options.shell === false && call.options.windowsHide)).toBe(true);
  });

  it('never starts WSL for any server wait operation', async () => {
    const f = await setup(true);
    const task = f.registry.tasks[0]!;
    for (const method of [f.transport.getServerWait, f.transport.ensureServerWait, f.transport.cancelServerWait]) {
      await expect(method!(task, 'a'.repeat(64), signal)).rejects.toThrow('SERVER_WAIT_SSH_ONLY');
    }
    expect(f.calls).toHaveLength(0);
  });

  it('requires explicit server hosting before remote deployment', async () => {
    const f = await setup();
    delete f.registry.tasks[0]!.autoStart!.execution;
    await expect(f.transport.ensureServerWait!(f.registry.tasks[0]!, 'a'.repeat(64), signal)).rejects.toThrow('SERVER_WAIT_CONFIRMATION_REQUIRED');
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a changed task registration before deployment', async () => {
    const f = await setup();
    const old = structuredClone(f.registry.tasks[0]!);
    f.registry.tasks[0]!.autoStart!.idleSeconds = 120;
    await expect(f.transport.ensureServerWait!(old, 'a'.repeat(64), signal)).rejects.toThrow('REGISTRY_CHANGED');
    expect(f.calls).toHaveLength(0);
  });

  it('allows cancelling a detached job even after task monitoring is disabled', async () => {
    const f = await setup();
    f.registry.tasks[0]!.enabled = false;
    await expect(f.transport.cancelServerWait!(f.registry.tasks[0]!, 'a'.repeat(64), signal)).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('rejects malformed session metadata', async () => {
    const f = await setup();
    f.invalid();
    await expect(f.transport.getServerWait!(f.registry.tasks[0]!, 'a'.repeat(64), signal)).rejects.toThrow('SERVER_WAIT_PROTOCOL_INVALID');
  });
});
