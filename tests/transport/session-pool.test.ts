import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Registry } from '../../src/shared/contracts';
import { createTransport, HostSessionPool, sanitizeStderr } from '../../src/transport/transport';
import { encodeFrame, FrameStreamDecoder } from '../../src/transport/protocol';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; this.emit('close', null, 'SIGTERM'); return true; }
}

function makeRegistry(target: Registry['hosts'][number]['target'] = { kind: 'ssh', alias: 'gpu-node-01' }): Registry {
  return {
    version: 2,
    revision: 1,
    hosts: [{ hostId: 'h1', label: 'Host 1', enabled: true, allowedRoots: ['/workspace'], target }],
    tasks: [{
      taskId: 't1',
      hostId: 'h1',
      label: 'Task 1',
      enabled: true,
      algorithm: 'generic',
      logFormat: 'generic',
      allowedDirectories: ['/workspace/run'],
      entryPaths: ['/workspace/run/train.py'],
      sources: [],
      checkpointDirectories: [],
    }],
  };
}

function attachPersistentResponder(
  child: FakeChild,
  responder: (req: Record<string, unknown>) => Record<string, unknown>,
) {
  let headerParsed = false;
  let expectedBytes = 0;
  let buf = Buffer.alloc(0);
  const decoder = new FrameStreamDecoder();
  child.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    if (!headerParsed) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      expectedBytes = Number(buf.subarray(0, nl).toString('ascii'));
      if (buf.length < nl + 1 + expectedBytes) return;
      buf = buf.subarray(nl + 1 + expectedBytes);
      headerParsed = true;
    }
    if (buf.length > 0) {
      const frames = decoder.push(buf);
      buf = Buffer.alloc(0);
      for (const frame of frames) {
        const req = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
        if (req.op === 'shutdown') {
          child.stdout.end(encodeFrame(Buffer.from(JSON.stringify({ version: 1, requestId: req.requestId, sourceId: null, payload: { shutdown: true } }))));
          child.emit('close', 0, null);
          return;
        }
        const payload = responder(req);
        child.stdout.write(encodeFrame(Buffer.from(JSON.stringify({ version: 1, requestId: req.requestId, sourceId: req.sourceId ?? null, payload }))));
      }
    }
  });
}

describe('HostSessionPool reuse, auto-reconnect, stderr classification, and local target', () => {
  it('reuses a single SSH process across 3 consecutive polling rounds and auto-reconnects after mid-session drop', async () => {
    const registry = makeRegistry();
    const pool = new HostSessionPool();
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      attachPersistentResponder(child, (req) => {
        if (req.op === 'probe_host_and_tasks') {
          return {
            host: { hostBootId: `boot-${children.length}`, scanComplete: true, errorCode: null, gpu: { status: 'ok', csv: '0, GPU-1, 10, 512, 8192' } },
            tasks: {
              t1: { scanComplete: true, errorCode: null, processes: [], sources: [] },
            },
          };
        }
        return { hostBootId: `boot-${children.length}`, scanComplete: true, errorCode: null, gpu: { status: 'ok', csv: '0, GPU-1, 10, 512, 8192' } };
      });
      return child;
    });

    const transport = createTransport(
      { hostId: 'h1', host: registry.hosts[0]!, registry },
      { probeSource: 'print(1)', spawn: spawn as never, sessionPool: pool },
    );
    const signal = new AbortController().signal;
    try {
      // 3 consecutive rounds spawn SSH ONLY ONCE
      const r1 = await transport.probeHostAndTasks!(registry.tasks, signal);
      const r2 = await transport.probeHostAndTasks!(registry.tasks, signal);
      const r3 = await transport.probeHost(signal);
      expect(r1.host.connection).toBe('connected');
      expect(r2.host.connection).toBe('connected');
      expect(r3.connection).toBe('connected');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(pool.activeCount()).toBe(1);

      // Simulate unexpected mid-session SSH disconnect
      children[0]!.stderr.end('Connection reset by peer\n');
      children[0]!.emit('close', 255, null);
      expect(pool.hasActiveSession('h1')).toBe(false);

      // Next call automatically reconnects in a new session
      const r4 = await transport.probeHost(signal);
      expect(r4).toMatchObject({ connection: 'connected', hostBootId: 'boot-2' });
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      await pool.closeAll();
    }
  });

  it('queues concurrent local requests on one startup and walks asynchronous Python fallbacks', async () => {
    const pool = new HostSessionPool();
    const spawn = vi.fn((command: string) => {
      const child = new FakeChild();
      if (command === 'python') queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' }));
      });
      else if (command === 'py') queueMicrotask(() => { child.emit('close', 9009); });
      else attachPersistentResponder(child, (req) => ({ id: req.requestId }));
      return child;
    });
    const signal = new AbortController().signal;
    const requests = ['one', 'two', 'three'].map((requestId) =>
      pool.call('local', { kind: 'local' }, 'print(1)', { requestId, sourceId: null },
        signal, spawn as never, { platform: 'win32' }));
    try {
      expect(await Promise.all(requests)).toEqual([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
      expect(spawn.mock.calls.map(([command]) => command)).toEqual(['python', 'py', 'python3']);
      expect(pool.activeCount()).toBe(1);
    } finally {
      await pool.closeAll();
    }
  });

  it.each([
    ['Host key verification failed.\n', 255, 'SSH_HOST_KEY_UNKNOWN'],
    ['Permission denied (publickey,keyboard-interactive).\n', 255, 'SSH_AUTH_FAILED'],
    ['ssh: connect to host 10.0.0.1 port 22: Connection refused\n', 255, 'SSH_CONNECTION_REFUSED'],
    ['ssh: connect to host 10.0.0.1 port 22: Connection timed out\n', 255, 'SSH_TIMEOUT'],
    ['PYTHON_UNAVAILABLE\n', 127, 'REMOTE_PYTHON_UNAVAILABLE'],
  ])('classifies EPIPE + stderr %j into %s without masking root cause', async (stderrText, exitCode, expectedCode) => {
    const registry = makeRegistry();
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      child.stdin.once('data', () => {
        // Trigger EPIPE slightly before close + stderr to test race handling
        child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        child.stderr.end(stderrText);
        setTimeout(() => child.emit('close', exitCode, null), 5);
      });
      return child;
    });

    const transport = createTransport(
      { hostId: 'h1', host: registry.hosts[0]!, registry },
      { probeSource: 'print(1)', spawn: spawn as never },
    );
    const result = await transport.probeHost(new AbortController().signal);
    expect(result).toMatchObject({ connection: 'unobserved', errorCode: expectedCode });
  });

  it('sanitizes private paths and caps diagnostic stderr to 4 KiB', () => {
    const raw = 'Permission denied -i /home/alice/.ssh/id_ed25519 C:\\Users\\bob\\key ' + 'x'.repeat(10_000);
    const clean = sanitizeStderr(raw);
    expect(clean.length).toBeLessThanOrEqual(4 * 1024);
    expect(clean).not.toContain('alice');
    expect(clean).not.toContain('bob');
    expect(clean).toContain('<redacted>');
  });

  it('probes a local host directly with real Python --serve (no ssh or wsl.exe) and degrades CPU-only cleanly', async () => {
    const registry = makeRegistry({ kind: 'local' });
    const probeSource = await readFile(path.resolve('src/probe/readonly_probe.py'), 'utf8');
    const pool = new HostSessionPool();
    const transport = createTransport(
      { hostId: 'h1', host: registry.hosts[0]!, registry },
      { probeSource, sessionPool: pool },
    );
    try {
      const obs = await transport.probeHost(new AbortController().signal);
      expect(obs.connection).toBe('connected');
      expect(obs.freshness).toBe('fresh');
      expect(obs.scanComplete).toBe(true);
      expect(obs.hostBootId).toBeTruthy();
      expect(obs.errorCode).toBeNull();
      expect(pool.hasActiveSession('h1')).toBe(true);
    } finally {
      await pool.closeAll();
    }
  });
});
