import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createTransport } from '../../src/transport/transport';
import { encodeFrame, FrameStreamDecoder } from '../../src/transport/protocol';
import type { Registry } from '../../src/shared/contracts';

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { this.emit('close', null); return true; }
}

const signal = new AbortController().signal;

async function setup(wsl = false) {
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
      algorithm: '',
      enabled: true,
      allowedDirectories: ['/allowed/run'],
      entryPaths: ['train.py'],
      checkpointDirectories: [],
      sources: [{ sourceId: 'log', kind: 'log', path: '/allowed/run/new.log' }],
      autoStart: {
        enabled: true,
        armId: '12345678-1234-4234-8234-123456789abc',
        gpuDeviceIds: ['GPU 6'],
        idleSeconds: 10,
        maxUtilizationPercent: 5,
        maxMemoryMiB: 1024,
        launch: {
          pythonPath: '/usr/bin/python3',
          entryPath: 'train.py',
          cwd: '/allowed/run',
          arguments: '--name "hello; touch /tmp/never"',
          logSourceId: 'log',
        },
      },
    }],
  };
  const requests: any[] = [];
  const calls: any[] = [];
  let running = true;
  const probeSource = await readFile('src/probe/readonly_probe.py', 'utf8');
  const launcherSource = await readFile('src/launch/launcher.py', 'utf8');

  const spawn = (command: string, args: string[], options: any) => {
    const child = new Child();
    calls.push({ command, args, options });
    if (command === 'wsl.exe' && args.includes('--list')) {
      queueMicrotask(() => {
        child.stdout.end(Buffer.from(running ? 'Ubuntu-24.04\n' : ''));
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    }
    if (command.toLowerCase().endsWith('nvidia-smi.exe')) {
      queueMicrotask(() => {
        child.stdout.end(Buffer.from('6, GPU-a, 0, 0, 24576'));
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    }
    const isServe = args.some((a) => a.includes('--serve'));
    if (isServe) {
      let headerParsed = false;
      let expectedSourceBytes = 0;
      let buf = Buffer.alloc(0);
      const decoder = new FrameStreamDecoder();
      child.stdin.on('data', (chunk) => {
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
        if (!headerParsed) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          expectedSourceBytes = Number(buf.subarray(0, nl).toString('ascii'));
          if (buf.length < nl + 1 + expectedSourceBytes) return;
          buf = buf.subarray(nl + 1 + expectedSourceBytes);
          headerParsed = true;
        }
        if (buf.length > 0) {
          const frames = decoder.push(buf);
          buf = Buffer.alloc(0);
          for (const frame of frames) {
            const request = JSON.parse(frame.toString('utf8'));
            requests.push(request);
            if (request.op === 'shutdown') {
              child.stdout.end(encodeFrame(Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, sourceId: null, payload: { shutdown: true } }))));
              child.emit('close', 0);
              return;
            }
            const payload = request.op === 'probe_host'
              ? { hostBootId: 'boot', scanComplete: true, errorCode: null, gpu: { status: 'ok', csv: '6, GPU-a, 0, 0, 24576' } }
              : { scanComplete: true, running: false, errorCode: null };
            child.stdout.write(encodeFrame(Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, sourceId: null, payload }))));
          }
        }
      });
      return child;
    }

    const chunks: Buffer[] = [];
    child.stdin.on('data', (data) => chunks.push(Buffer.from(data)));
    child.stdin.once('end', () => {
      const source = Buffer.concat(chunks).toString('utf8');
      const encoded = source.match(/REQUEST_B64 = "([^"\n]+)"/)![1]!;
      const request = JSON.parse(Buffer.from(encoded, 'base64').toString());
      requests.push(request);
      if (request.op === 'launch_task') {
        const embedded = source.match(/PROBE_SOURCE_B64 = "([^"\n]+)"/)![1]!;
        expect(Buffer.from(embedded, 'base64').toString()).toBe(probeSource);
        expect(source).not.toContain(request.launch.arguments);
      }
      const payload = { status: 'started', pid: 42, processKey: null, startedAt: '2026-11-11T00:00:00Z', errorCode: null };
      const body = encodeFrame(Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, sourceId: null, payload })));
      child.stdout.end(body);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  const transport = createTransport({ hostId: 'h', host: registry.hosts[0]!, registry }, { probeSource, launcherSource, spawn: spawn as never, registryProvider: async () => registry });
  return { transport, registry, requests, calls, stop: () => { running = false; } };
}

describe('registered launch transport', () => {
  it.each([false, true])('frames a scoped launch and physical UUID for WSL=%s', async (wsl) => {
    const f = await setup(wsl);
    try {
      await f.transport.probeHost(signal);
      expect(await f.transport.checkTaskStopped!(f.registry.tasks[0]!, signal)).toEqual({ scanComplete: true, running: false, errorCode: null });
      const result = await f.transport.launchTask!(f.registry.tasks[0]!, f.registry.tasks[0]!.autoStart!.armId, 'a'.repeat(64), signal);
      expect(result.status).toBe('started');
      expect(f.requests.at(-1)).toMatchObject({ op: 'launch_task', gpuDevices: [{ deviceId: 'GPU 6', uuid: 'GPU-a' }], taskAllowedDirectories: ['/allowed/run'], hostAllowedRoots: ['/allowed'] });
      expect(f.requests.find((r) => r.op === 'probe_launch_readiness').task.sources).toEqual([]);
      expect(f.calls.every((call) => call.options.shell === false && call.options.windowsHide)).toBe(true);
    } finally {
      await f.transport.close?.();
    }
  });

  it('refuses launch after task configuration changed', async () => {
    const f = await setup();
    try {
      await f.transport.probeHost(signal);
      const old = structuredClone(f.registry.tasks[0]!);
      f.registry.tasks[0]!.autoStart!.enabled = false;
      await expect(f.transport.launchTask!(old, old.autoStart!.armId, 'a'.repeat(64), signal)).rejects.toThrow('REGISTRY_CHANGED');
      expect(f.requests.filter((r) => r.op === 'launch_task')).toHaveLength(0);
    } finally {
      await f.transport.close?.();
    }
  });

  it('never wakes stopped WSL even after a successful earlier sample', async () => {
    const f = await setup(true);
    try {
      await f.transport.probeHost(signal);
      f.stop();
      await expect(f.transport.launchTask!(f.registry.tasks[0]!, f.registry.tasks[0]!.autoStart!.armId, 'a'.repeat(64), signal)).rejects.toThrow('WSL_NOT_RUNNING');
      expect(f.requests.filter((r) => r.op === 'launch_task')).toHaveLength(0);
    } finally {
      await f.transport.close?.();
    }
  });

  it('requires a successful same transport GPU identity sample', async () => {
    const f = await setup();
    try {
      await expect(f.transport.launchTask!(f.registry.tasks[0]!, f.registry.tasks[0]!.autoStart!.armId, 'a'.repeat(64), signal)).rejects.toThrow('LAUNCH_SERVICE_UNAVAILABLE');
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.transport.close?.();
    }
  });
});
