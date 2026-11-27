import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Registry } from '../../src/shared/contracts';
import { createRegistryStore } from '../../src/registry/config';
import { createDefaultRegistry } from '../../src/registry/presets';
import { loadRotationCatalog } from '../../src/registry/rotation-catalog';
import { createTransport, projectTaskObservation, runBoundedChild } from '../../src/transport/transport';
import { encodeFrame, FrameStreamDecoder } from '../../src/transport/protocol';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill() { this.killed = true; this.emit('close', null, 'SIGTERM'); return true; }
  finish(code = 0) { this.stdout.end(); this.stderr.end(); this.emit('close', code, null); }
}

function makeRegistry(overrides: Partial<Registry> = {}): Registry {
  return {
    version: 2,
    revision: 0,
    hosts: [
      { hostId: 'gpu-node', label: 'GPU Node', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'gpu-node' } },
      { hostId: 'wsl-node', label: 'WSL Node', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'wsl', distribution: 'Ubuntu-24.04' } },
    ],
    tasks: [
      {
        taskId: 'task-1',
        hostId: 'gpu-node',
        label: 'Task 1',
        enabled: true,
        algorithm: 'generic',
        logFormat: 'generic',
        allowedDirectories: ['/allowed/run'],
        entryPaths: ['/allowed/run/train.py'],
        sources: [{ sourceId: 'task-log', path: '/allowed/run/train.log', kind: 'log' }],
        checkpointDirectories: [],
      },
    ],
    ...overrides,
  };
}

/** Helper attaching persistent --serve TMF1 frame request/response behavior to a FakeChild. */
function attachServeHandler(
  child: FakeChild,
  responder: (request: Record<string, unknown>) => Record<string, unknown>,
  options: { preamble?: Buffer } = {},
) {
  let headerParsed = false;
  let expectedBytes = 0;
  let buf = Buffer.alloc(0);
  let preambleSent = false;
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
        const request = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
        if (!preambleSent && options.preamble) {
          preambleSent = true;
          child.stdout.write(options.preamble);
        }
        if (request.op === 'shutdown') {
          child.stdout.end(encodeFrame(Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, sourceId: null, payload: { shutdown: true } }))));
          child.emit('close', 0, null);
          return;
        }
        const payload = responder(request);
        const envelope = { version: 1, requestId: request.requestId, sourceId: request.sourceId ?? null, payload };
        child.stdout.write(encodeFrame(Buffer.from(JSON.stringify(envelope))));
      }
    }
  });
}

/** Spawns real local Python --serve process when FakeTransport routes SSH to local python for integration assertions. */
function spawnRealServePython(mutateRequest?: (req: Record<string, unknown>) => Record<string, unknown>) {
  return vi.fn(() => {
    const py = nodeSpawn('python', ['-B', '-c', "import sys; n=int(sys.stdin.buffer.readline()); src=sys.stdin.buffer.read(n); exec(compile(src,'probe','exec'),{'__name__':'__main__'})", '--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!mutateRequest) return py;
    const proxy = new FakeChild();
    let headerParsed = false;
    let expectedBytes = 0;
    let buf = Buffer.alloc(0);
    const decoder = new FrameStreamDecoder();
    proxy.stdin.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      if (!headerParsed) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        expectedBytes = Number(buf.subarray(0, nl).toString('ascii'));
        if (buf.length < nl + 1 + expectedBytes) return;
        py.stdin.write(buf.subarray(0, nl + 1 + expectedBytes));
        buf = buf.subarray(nl + 1 + expectedBytes);
        headerParsed = true;
      }
      if (buf.length > 0) {
        const frames = decoder.push(buf);
        buf = Buffer.alloc(0);
        for (const frame of frames) {
          const parsed = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
          const next = parsed.op === 'shutdown' ? parsed : mutateRequest(parsed);
          py.stdin.write(encodeFrame(Buffer.from(JSON.stringify(next))));
        }
      }
    });
    proxy.stdin.on('end', () => py.stdin.end());
    py.stdout.on('data', (c) => proxy.stdout.write(c));
    py.stdout.on('end', () => proxy.stdout.end());
    py.stderr.on('data', (c) => proxy.stderr.write(c));
    py.stderr.on('end', () => proxy.stderr.end());
    py.on('close', (code, sig) => proxy.emit('close', code, sig));
    proxy.kill = () => { proxy.killed = true; return py.kill(); };
    return proxy;
  });
}

describe('registry and rotation catalog', () => {
  test('starts with a clean empty v2 registry and persists with revision CAS', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-registry-'));
    const store = createRegistryStore(directory);
    const initial = await store.loadRegistry();
    expect(initial).toEqual({ version: 2, revision: 0, hosts: [], tasks: [] });
    const saved = await store.saveRegistry(initial);
    expect(saved.revision).toBe(1);
    await expect(store.saveRegistry(initial)).rejects.toThrow('REVISION_CONFLICT');
    expect((await createRegistryStore(directory).loadRegistry()).revision).toBe(1);
    expect(await readFile(path.join(directory, 'registry.json'), 'utf8')).toContain('"revision": 1');
  });

  test('quarantines a corrupt registry to a .corrupt-*.bak file and recovers with clean defaults', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-registry-corrupt-'));
    const filename = path.join(directory, 'registry.json');
    await writeFile(filename, '{not-json');
    const store = createRegistryStore(directory);
    const recovered = await store.loadRegistry();
    expect(recovered).toEqual({ version: 2, revision: 0, hosts: [], tasks: [] });
    const notice = store.getRecoveryNotice();
    expect(notice).not.toBeNull();
    expect(notice?.file).toBe('registry');
    const files = await readdir(directory);
    const backup = files.find((f) => f.startsWith('registry.json.corrupt-') && f.endsWith('.bak'));
    expect(backup).toBeTruthy();
    expect(await readFile(path.join(directory, backup!), 'utf8')).toBe('{not-json');
  });

  test('returns an unconfigured terminal catalog state when no catalog exists', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-catalog-'));
    const loaded = await loadRotationCatalog(path.join(directory, 'rotation-catalog.json'), async () => createDefaultRegistry());
    expect(loaded).toEqual({ status: 'unconfigured', candidates: [] });
  });

  test('does not scan or read an archive without old-content anchors', async () => {
    const registry = makeRegistry();
    const host = registry.hosts[0]!;
    const calls = vi.fn();
    const transport = createTransport({ hostId: host.hostId, host, registry }, {
      probeSource: 'print(1)',
      spawn: calls as never,
      rotationCatalog: {
        status: 'configured',
        listCandidates: () => [{ kind: 'registered_rotation', sourceId: 'task-log', candidateId: 'opaque', registrationId: 'reg' }],
        resolveCandidate: async () => null,
      },
    });
    const result = await transport.scanArchiveCandidates('task-log', { taskId: 'task-1', registryRevision: 0, fingerprint: 'unused' }, [], new AbortController().signal);
    expect(result).toMatchObject({ status: 'inconclusive', errorCode: 'OLD_ANCHORS_UNAVAILABLE' });
    expect(calls).not.toHaveBeenCalled();
  });

  test('mints opaque refs only for an exact registered basename and invalidates on ownership change', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-catalog-bound-'));
    const registry: Registry = {
      version: 2, revision: 3,
      hosts: [{ hostId: 'h', label: 'h', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'gpu-node' } }],
      tasks: [{ taskId: 't', hostId: 'h', label: 't', enabled: true, algorithm: 'flow', allowedDirectories: ['/allowed/run'], entryPaths: [], sources: [{ sourceId: 's', path: '/allowed/run/current.log', kind: 'log' }], checkpointDirectories: [] }],
    };
    const file = path.join(directory, 'rotation-catalog.json');
    await writeFile(file, JSON.stringify({ version: 1, records: [{ registrationId: 'reg-a', taskId: 't', sourceId: 's', allowedDirectory: '/allowed/run', exactBasenames: ['current.log.1', 'backup.log'] }] }));
    let current = registry;
    const loaded = await loadRotationCatalog(file, async () => current);
    expect(loaded.status).toBe('configured');
    if (loaded.status !== 'configured') return;
    const refs = loaded.listCandidates('s');
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => !JSON.stringify(ref).includes('/allowed/'))).toBe(true);
    const resolved = await loaded.resolveCandidate(refs[0]!);
    expect(resolved?.path).toBe('/allowed/run/current.log.1');
    current = { ...registry, tasks: [{ ...registry.tasks[0]!, sources: [{ sourceId: 's', path: '/allowed/run/current.log.1', kind: 'log' }] }] };
    expect(await loaded.resolveCandidate(refs[0]!)).toBeNull();
  });
});

describe('bounded child execution and WSL behavior', () => {
  test('terminates only the owned probe child when its cumulative output crosses the cap', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const promise = runBoundedChild('python3', ['-I', '-S', '-B', '-'], Buffer.from('probe'), new AbortController().signal, spawn as never, { timeoutMs: 1000, stdoutLimitBytes: 8, stderrLimitBytes: 8 });
    child.stdout.write(Buffer.from('123456789'));
    await expect(promise).rejects.toThrow('RESPONSE_LIMIT');
    expect(child.killed).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('reports WSL as unobserved and never execs a stopped distribution', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    const calls: { command: string; args: string[] }[] = [];
    const spawn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      const child = new FakeChild();
      queueMicrotask(() => { child.stdout.end('Debian\n'); child.stderr.end(); child.emit('close', 0, null); });
      return child;
    });
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    const observation = await transport.probeHost(new AbortController().signal);
    expect(observation).toMatchObject({ freshness: 'unobserved', connection: 'unobserved', errorCode: 'WSL_NOT_RUNNING' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['--list', '--running', '--quiet']);
  });

  test('classifies a stopped WSL distribution as a host-scoped list failure through probeHost', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => { child.stdout.end('Debian\n'); child.stderr.end(); child.emit('close', 0, null); });
      return child;
    });
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });

    const observation = await transport.probeHost(new AbortController().signal);
    expect(observation).toMatchObject({
      freshness: 'unobserved', connection: 'unobserved', errorCode: 'WSL_NOT_RUNNING',
      errorScope: 'host', phase: 'wsl_list', observedAt: null,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('does not exec WSL when a failed running-list includes the distribution name', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    const calls: string[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      calls.push('spawn');
      queueMicrotask(() => {
        if (calls.length === 1) { child.stdout.end('Ubuntu-24.04\n'); child.stderr.end(); child.emit('close', 1, null); }
        else child.finish(2);
      });
      return child;
    });
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    const observation = await transport.probeHost(new AbortController().signal);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({ freshness: 'unobserved', errorCode: 'WSL_LIST_FAILED', errorScope: 'host', phase: 'wsl_list' });
  });

  test('does not exec WSL for empty or non-exact running-list output', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    for (const output of ['', ' Ubuntu-24.04-extra\n', 'OtherDistro\n']) {
      const spawn = vi.fn(() => {
        const child = new FakeChild();
        queueMicrotask(() => { child.stdout.end(output); child.stderr.end(); child.emit('close', 0, null); });
        return child;
      });
      const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
      const result = await transport.probeHost(new AbortController().signal);
      expect(result).toMatchObject({ freshness: 'unobserved', errorCode: 'WSL_NOT_RUNNING', phase: 'wsl_list' });
      expect(spawn).toHaveBeenCalledTimes(1);
    }
  });

  test('keeps WSL list cancellation in host preflight scope', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    const controller = new AbortController();
    const pending = transport.probeHost(controller.signal);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ freshness: 'unobserved', errorCode: 'PROBE_CANCELLED', errorScope: 'host', phase: 'wsl_list' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('keeps WSL list timeout in host preflight scope without a distro exec', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    const result = await transport.probeHost(new AbortController().signal);
    expect(result).toMatchObject({ freshness: 'unobserved', errorCode: 'PROBE_TIMEOUT', errorScope: 'host', phase: 'wsl_list' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('keeps WSL list failures and truncated output from reaching distro exec', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    const oversizedSpawn = vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => { child.stdout.write(Buffer.alloc(4097, 65)); });
      return child;
    });
    const oversizedTransport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: oversizedSpawn as never });
    const oversized = await oversizedTransport.probeHost(new AbortController().signal);
    expect(oversized).toMatchObject({ freshness: 'unobserved', errorScope: 'host', phase: 'wsl_list' });
    expect(oversizedSpawn).toHaveBeenCalledTimes(1);

    const failedSpawn = vi.fn(() => { throw new Error('synthetic spawn failure'); });
    const failedTransport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: failedSpawn as never });
    const failed = await failedTransport.probeHost(new AbortController().signal);
    expect(failed).toMatchObject({ freshness: 'unobserved', errorCode: 'TRANSPORT_UNAVAILABLE', errorScope: 'host', phase: 'wsl_list' });
    expect(failedSpawn).toHaveBeenCalledTimes(1);
  });

  test('executes WSL only after a successful exact running-list result and reuses persistent session', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    const spawn = vi.fn((command: string, args: string[]) => {
      const child = new FakeChild();
      if (command === 'wsl.exe' && args.includes('--list')) {
        queueMicrotask(() => { child.stdout.end('Ubuntu-24.04\n'); child.stderr.end(); child.emit('close', 0, null); });
      } else if (command.toLowerCase().endsWith('nvidia-smi.exe')) {
        queueMicrotask(() => { child.stdout.end('0, GPU-a, 0, 512, 8192\n'); child.stderr.end(); child.emit('close', 0, null); });
      } else {
        attachServeHandler(child, () => ({ hostBootId: 'boot', scanComplete: true, errorCode: null, errorScope: null, phase: null }));
      }
      return child;
    });
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    try {
      const first = await transport.probeHost(new AbortController().signal);
      expect(first).toMatchObject({ connection: 'connected', hostBootId: 'boot' });
      // WSL startup plus the separate device and compute-app GPU queries.
      const spawnsAfterFirst = spawn.mock.calls.length;
      expect(spawnsAfterFirst).toBe(4);
      // Second probe reuses persistent session without re-running wsl --list or wsl --exec!
      await transport.probeHost(new AbortController().signal);
      // Only the two GPU queries run again.
      expect(spawn.mock.calls.length).toBe(spawnsAfterFirst + 2);
    } finally {
      await transport.close?.();
    }
  });

  test('uses Windows aggregate GPU sampling only after the registered WSL distro is running', async () => {
    const registry = makeRegistry();
    const host = registry.hosts.find((item) => item.target.kind === 'wsl')!;
    const requests: Record<string, unknown>[] = [];
    const calls: { command: string; args: string[] }[] = [];
    const spawn = vi.fn((command: string, args: string[]) => {
      const child = new FakeChild();
      calls.push({ command, args });
      if (command === 'wsl.exe' && args.includes('--list')) {
        queueMicrotask(() => { child.stdout.end('Ubuntu-24.04\n'); child.stderr.end(); child.emit('close', 0, null); });
      } else if (command.toLowerCase().endsWith('nvidia-smi.exe')) {
        queueMicrotask(() => { child.stdout.end(args[0]!.startsWith('--query-compute-apps')
          ? '88, GPU-a, 256, python.exe\n'
          : '0, GPU-a, 0, 512, 8192, "NVIDIA Test", 55, 60, 120, 35, bus-1, Default, 0\n'); child.stderr.end(); child.emit('close', 0, null); });
      } else {
        attachServeHandler(child, (req) => {
          requests.push(req);
          return { hostBootId: 'wsl-boot', scanComplete: true, errorCode: null, errorScope: null, phase: null };
        });
      }
      return child;
    });
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    try {
      const observation = await transport.probeHost(new AbortController().signal);
      expect(observation).toMatchObject({ connection: 'connected', gpu: { state: 'available' } });
      expect(observation.gpu?.metrics).toHaveLength(3);
      expect(observation.gpu?.metrics[0]).toMatchObject({ deviceId: 'GPU 0', name: 'gpu_utilization', value: 0 });
      expect(requests[0]).toMatchObject({ op: 'probe_host', includeGpu: false });
      expect(calls).toHaveLength(4);
      expect(observation.gpu?.devices?.[0]).toMatchObject({
        name: 'NVIDIA Test', temperatureC: 55, powerDrawW: 60, fanSpeedPct: 35,
        activeProcesses: [{ pid: 88, command: 'python.exe', memoryMiB: 256 }],
      });
      expect(calls[2]!.command.toLowerCase()).toContain('nvidia-smi.exe');
      expect(calls[2]!.args).toContain('--format=csv,noheader,nounits');
    } finally {
      await transport.close?.();
    }
  });

  test('uses only SSH host GPU results for SSH targets and reuses one persistent SSH session', async () => {
    const registry = makeRegistry();
    const host = registry.hosts[0]!;
    const calls: { command: string; args: string[] }[] = [];
    let gpuStatus: 'ok' | 'error' = 'ok';
    const spawn = vi.fn((command: string, args: string[]) => {
      const child = new FakeChild();
      calls.push({ command, args });
      attachServeHandler(child, () => ({
        hostBootId: 'ssh-boot',
        scanComplete: true,
        errorCode: null,
        errorScope: null,
        phase: null,
        gpu: gpuStatus === 'ok'
          ? { status: 'ok', observedAt: Date.now() + 60_000, csv: '0, GPU-a, 12, 512, 8192' }
          : { status: 'error', errorCode: 'GPU_QUERY_FAILED' },
      }), { preamble: Buffer.from('Welcome MOTD banner\n') });
      return child;
    });
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    try {
      const startedAt = Date.now();
      const sampled = await transport.probeHost(new AbortController().signal);
      expect(sampled).toMatchObject({ connection: 'connected', freshness: 'fresh', gpu: { state: 'available' } });
      expect(sampled.gpu?.metrics[0]).toMatchObject({ deviceId: 'GPU 0', value: 12 });
      expect(Date.parse(sampled.gpu!.observedAt!)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(sampled.gpu!.observedAt!)).toBeLessThanOrEqual(Date.now());
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe('ssh');
      expect(calls[0]!.args).toContain('gpu-node');

      gpuStatus = 'error';
      const failedGpu = await transport.probeHost(new AbortController().signal);
      expect(failedGpu).toMatchObject({ connection: 'connected', freshness: 'fresh', scanComplete: true, errorCode: null, gpu: { state: 'unavailable', errorCode: 'GPU_QUERY_FAILED' } });
      // Same persistent SSH session reused!
      expect(calls).toHaveLength(1);
    } finally {
      await transport.close?.();
    }
  });

  test('consumes an actual Python --serve error frame as an unobserved task request failure', async () => {
    const registry: Registry = {
      version: 2, revision: 1,
      hosts: [{ hostId: 'h', label: 'h', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'gpu-node' } }],
      tasks: [{ taskId: 't', hostId: 'h', label: 't', enabled: true, algorithm: 'flow', allowedDirectories: ['/allowed/run'], entryPaths: [], sources: [], checkpointDirectories: [] }],
    };
    const probeSource = await readFile(path.resolve('src/probe/readonly_probe.py'), 'utf8');
    const spawn = spawnRealServePython((req) => ({ ...req, proc: null }));
    const host = registry.hosts[0]!;
    const transport = createTransport({ hostId: 'h', host, registry }, { probeSource, spawn: spawn as never });
    try {
      const observation = await transport.probeTask(registry.tasks[0]!, new AbortController().signal);
      expect(observation).toMatchObject({ freshness: 'unobserved', scanComplete: false, errorCode: 'PROBE_REQUEST_INVALID', errorScope: 'request', phase: 'dispatch' });
      expect(observation.processes).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await transport.close?.();
    }
  });

  test('preserves matching request and source scope through actual Python --serve frame into readLog', async () => {
    const registry: Registry = {
      version: 2, revision: 1,
      hosts: [{ hostId: 'h', label: 'h', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'gpu-node' } }],
      tasks: [{ taskId: 't', hostId: 'h', label: 't', enabled: true, algorithm: 'flow', allowedDirectories: ['/allowed/run'], entryPaths: [], sources: [{ sourceId: 's', path: '/allowed/run/current.log', kind: 'log' }], checkpointDirectories: [] }],
    };
    const probeSource = await readFile(path.resolve('src/probe/readonly_probe.py'), 'utf8');
    const spawn = spawnRealServePython((req) => ({ ...req, op: 'unsupported-test-operation' }));
    const host = registry.hosts[0]!;
    const transport = createTransport({ hostId: 'h', host, registry }, { probeSource, spawn: spawn as never });
    try {
      const registration = await transport.createRegistrationReference('t');
      const expected = { generation: 'g', revision: 0, committedOffset: '0' };
      await expect(transport.readLog({ kind: 'current', sourceId: 's', offset: '0', limitBytes: 16, expected, registration, anchors: [] }, new AbortController().signal))
        .rejects.toMatchObject({ message: 'REQUEST_OP_UNSUPPORTED', errorScope: 'request', phase: 'dispatch', sourceId: 's' });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await transport.close?.();
    }
  });

  test('finishes an absent rotation catalog as inconclusive without spawning a probe', async () => {
    const registry = makeRegistry();
    const host = registry.hosts[0]!;
    const calls = vi.fn();
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: calls as never });
    const result = await transport.scanArchiveCandidates('task-log', { taskId: 'task-1', registryRevision: 0, fingerprint: 'unused' }, [], new AbortController().signal);
    expect(result).toMatchObject({ status: 'inconclusive', candidates: [], errorCode: 'ROTATION_CATALOG_UNCONFIGURED' });
    expect(calls).not.toHaveBeenCalled();
  });

  test('surfaces one source failure without discarding sibling source observations', async () => {
    const task = { taskId: 'task', hostId: 'h', label: 'Task', enabled: true, algorithm: 'flow' as const, allowedDirectories: ['/allowed'], entryPaths: [], sources: [{ sourceId: 'bad-log', path: '/allowed/a.log', kind: 'log' as const }, { sourceId: 'good-log', path: '/allowed/b.log', kind: 'log' as const }], checkpointDirectories: [] };
    const observation = projectTaskObservation(task, {
      scanComplete: true,
      sources: [
        { sourceId: 'bad-log', status: 'permission_error', errorCode: 'SOURCE_PERMISSION', observedAt: null, fileIdentity: null, eofBytes: null },
        { sourceId: 'good-log', status: 'ok', errorCode: null, observedAt: '2026-01-01T00:00:00.000Z', fileIdentity: { dev: '1', inode: '2' }, eofBytes: '9' },
      ],
      processes: [{ processKey: { hostBootId: 'boot', pid: 42, startTicks: '100' }, role: 'unknown', roleEvidence: 'exact_entry_and_direct_writer_fd', writerSourceIds: ['good-log'], writerSourceEvidence: { 'good-log': { fileIdentity: { dev: '1', inode: '2' }, eofBytes: '9' } }, writerEvidenceComplete: true, cwd: '/workspace', scriptEntry: '/registered/train.py', interpreterFlags: ['-I'], evidenceComplete: true }],
    }, '2026-01-01T00:00:00.000Z');
    expect(observation.sources).toHaveLength(2);
    expect(observation.sources[0]).toMatchObject({ sourceId: 'bad-log', permission: 'denied', errorCode: 'SOURCE_PERMISSION' });
    expect(observation.sources[1]).toMatchObject({ sourceId: 'good-log', permission: 'readable', exists: true, eofBytes: '9' });
    expect(observation.processes[0]).toMatchObject({ role: 'unknown', cwd: '/workspace', scriptEntry: '/registered/train.py', directWriterSourceIds: ['good-log'], writerEvidenceComplete: true, interpreterFlags: ['-I'] });
  });

  test('does not project a host-scoped task failure as a fresh task observation', async () => {
    const task = { taskId: 'task', hostId: 'h', label: 'Task', enabled: true, algorithm: 'flow' as const, allowedDirectories: ['/allowed'], entryPaths: [], sources: [], checkpointDirectories: [] };
    const observation = projectTaskObservation(task, { scanComplete: false, errorCode: 'HOST_IDENTITY_UNAVAILABLE', errorScope: 'host', phase: 'probe' }, '2026-01-01T00:00:00.000Z');
    expect(observation).toMatchObject({ freshness: 'unobserved', observedAt: null, scanComplete: false, errorCode: 'HOST_IDENTITY_UNAVAILABLE', errorScope: 'host', phase: 'probe', processes: [] });
  });

  test('uses receipt time for process and source evidence despite a server clock ahead', () => {
    const receipt = '2026-01-01T00:00:00.000Z';
    const task = { taskId: 'task', hostId: 'h', label: 'Task', enabled: true, algorithm: 'flow', allowedDirectories: ['/allowed'], entryPaths: ['/allowed/train.py'], sources: [{ sourceId: 'log', path: '/allowed/output.log', kind: 'log' as const }], checkpointDirectories: [] };
    const observation = projectTaskObservation(task, {
      scanComplete: true,
      sources: [{ sourceId: 'log', status: 'ok', observedAt: '2026-01-01T00:01:00.000Z', fileIdentity: { dev: '1', inode: '2' }, eofBytes: '9' }],
      processes: [{ processKey: { hostBootId: 'boot', pid: 42, startTicks: '100' }, role: 'unknown', observedAt: '2026-01-01T00:01:00.000Z', roleEvidence: 'exact_entry_and_direct_writer_fd', scriptEntry: '/allowed/train.py', writerSourceIds: ['log'], writerSourceEvidence: { log: { fileIdentity: { dev: '1', inode: '2' }, eofBytes: '9' } }, writerEvidenceComplete: true, evidenceComplete: true }],
    }, receipt);
    expect(observation.observedAt).toBe(receipt);
    expect(observation.sources[0]!.observedAt).toBe(receipt);
    expect(observation.processes[0]!.observedAt).toBe(receipt);
  });

  test('rejects a registered task from another host before spawn', async () => {
    const registry: Registry = {
      version: 2, revision: 1,
      hosts: [
        { hostId: 'a', label: 'a', enabled: true, allowedRoots: ['/a'], target: { kind: 'ssh', alias: 'node-a' } },
        { hostId: 'b', label: 'b', enabled: true, allowedRoots: ['/b'], target: { kind: 'ssh', alias: 'node-b' } },
      ],
      tasks: [
        { taskId: 'ta', hostId: 'a', label: 'a', enabled: true, algorithm: 'flow', allowedDirectories: ['/a/run'], entryPaths: [], sources: [], checkpointDirectories: [] },
        { taskId: 'tb', hostId: 'b', label: 'b', enabled: true, algorithm: 'flow', allowedDirectories: ['/b/run'], entryPaths: [], sources: [{ sourceId: 'b-log', path: '/b/run/a.log', kind: 'log' }], checkpointDirectories: [] },
      ],
    };
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); });
      return child;
    });
    const transport = createTransport({ hostId: 'a', host: registry.hosts[0]!, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    const observation = await transport.probeTask(registry.tasks[1]!, new AbortController().signal);
    expect(observation).toMatchObject({ errorCode: 'REGISTRY_HOST_MISMATCH', hostId: 'b' });
    expect(observation.sources[0]).toMatchObject({ errorCode: null, errorScope: null, permission: 'unknown' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('keeps a remote probe process failure separate from an SSH connection failure', async () => {
    const registry = makeRegistry();
    const host = registry.hosts[0]!;
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.finish(2));
      return child;
    });
    const transport = createTransport({ hostId: host.hostId, host, registry }, { probeSource: 'print(1)', spawn: spawn as never });
    const result = await transport.probeHost(new AbortController().signal);
    expect(result).toMatchObject({ errorCode: 'REMOTE_PROBE_FAILED', errorScope: 'request', phase: 'python_start' });
  });

  test('handles asynchronous stdin EPIPE gracefully without masking stderr close classification', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const pending = runBoundedChild('ssh', [], Buffer.from('probe'), new AbortController().signal, spawn as never, { timeoutMs: 1000 });
    const unhandled: unknown[] = [];
    child.stdin.on('error', (error) => { unhandled.push(error); });
    child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }));
    const outcome = await Promise.race([
      pending.then(() => 'resolved', (error) => (error as Error).message),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    expect(outcome).toBe('PROBE_STDIN_FAILED');
    expect(unhandled).toHaveLength(1);
    child.stdin.emit('error', Object.assign(new Error('late pipe close'), { code: 'EPIPE' }));
    expect(unhandled).toHaveLength(2);
    child.finish(1);
  });

  test('mints a current registry reference and reuses persistent session across reads and scans', async () => {
    const registry: Registry = {
      version: 2, revision: 4,
      hosts: [{ hostId: 'h', label: 'h', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'gpu-node' } }],
      tasks: [{ taskId: 't', hostId: 'h', label: 't', enabled: true, algorithm: 'flow', allowedDirectories: ['/allowed/..cache'], entryPaths: [], sources: [{ sourceId: 's', path: '/allowed/..cache/..logs', kind: 'log' }], checkpointDirectories: [] }],
    };
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      attachServeHandler(child, (request) => {
        const observation = { fileIdentity: { dev: '1', inode: '2' }, sizeBytes: '4', observedAt: 1767225600000 };
        return request.op === 'scan_rotation'
          ? { scanComplete: true, checkedCount: 1, candidates: [{ candidateIndex: 0, sizeBytes: '4' }] }
          : { ok: true, expected: request.expected, before: observation, after: observation, startOffset: request.offset, bytesBase64: '', bytesLength: 0 };
      });
      return child;
    });
    const catalog = {
      status: 'configured' as const,
      listCandidates: () => [{ kind: 'registered_rotation' as const, sourceId: 's', candidateId: 'candidate', registrationId: 'registration' }],
      resolveCandidate: async () => ({ kind: 'registered_rotation' as const, sourceId: 's', candidateId: 'candidate', registrationId: 'registration', taskId: 't', path: '/allowed/..cache/..logs.1', currentPath: '/allowed/..cache/..logs', allowedDirectories: ['/allowed/..cache'] }),
    };
    const transport = createTransport({ hostId: 'h', host: registry.hosts[0]!, registry }, { probeSource: 'print(1)', spawn: spawn as never, rotationCatalog: catalog });
    try {
      const reference = await transport.createRegistrationReference('t');
      expect(reference).toMatchObject({ taskId: 't', registryRevision: 4 });
      const expected = { generation: 'g', revision: 0, committedOffset: '0' };
      const current = await transport.readLog({ kind: 'current', sourceId: 's', offset: '0', limitBytes: 10, expected, registration: reference, anchors: [] }, new AbortController().signal);
      expect(current).toMatchObject({ sourceId: 's', startOffset: '0', bytes: new Uint8Array() });
      const anchors = [{ startOffset: '0', length: 1, sha256: 'a'.repeat(64) }];
      const scan = await transport.scanArchiveCandidates('s', reference, anchors, new AbortController().signal);
      expect(scan).toMatchObject({ status: 'complete', candidates: [{ startOffset: '0', endOffset: '4' }] });
      const archived = await transport.readLog({ kind: 'registered_rotation', sourceId: 's', offset: '0', limitBytes: 10, expected, registration: reference, anchors, candidate: scan.candidates[0]!.reference }, new AbortController().signal);
      expect(archived).toMatchObject({ sourceId: 's', startOffset: '0' });
      // All 3 RPCs multiplexed over ONE persistent SSH session!
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await transport.close?.();
    }
  });

  test('preserves source error scope and archive_scan phase through actual Python --serve frame on 65 rotation candidates limit', async () => {
    const registry: Registry = {
      version: 2,
      revision: 1,
      hosts: [{ hostId: 'h', label: 'h', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'gpu-node' } }],
      tasks: [{
        taskId: 't',
        hostId: 'h',
        label: 't',
        enabled: true,
        algorithm: 'flow',
        allowedDirectories: ['/allowed/run'],
        entryPaths: [],
        sources: [{ sourceId: 's', path: '/allowed/run/current.log', kind: 'log' }],
        checkpointDirectories: [],
      }],
    };
    const candidateList = Array.from({ length: 65 }, (_, i) => ({
      kind: 'registered_rotation' as const,
      sourceId: 's',
      candidateId: `candidate-${i + 1}`,
      registrationId: 'registration-1',
    }));
    const catalog = {
      status: 'configured' as const,
      listCandidates: () => candidateList,
      resolveCandidate: async (ref: (typeof candidateList)[number]) => ({
        kind: 'registered_rotation' as const,
        sourceId: 's',
        candidateId: ref.candidateId,
        registrationId: 'registration-1',
        taskId: 't',
        path: `/allowed/run/archive-${ref.candidateId}.log`,
        currentPath: '/allowed/run/current.log',
        allowedDirectories: ['/allowed/run'],
      }),
    };
    const probeSource = await readFile(path.resolve('src/probe/readonly_probe.py'), 'utf8');
    const spawn = spawnRealServePython();
    const host = registry.hosts[0]!;
    const transport = createTransport({ hostId: 'h', host, registry }, { probeSource, spawn: spawn as never, rotationCatalog: catalog });
    try {
      const registration = await transport.createRegistrationReference('t');
      const anchors = [{ startOffset: '0', length: 1, sha256: 'a'.repeat(64) }];
      const scan = await transport.scanArchiveCandidates('s', registration, anchors, new AbortController().signal);
      expect(scan).toMatchObject({
        status: 'inconclusive',
        candidates: [],
        errorCode: 'ROTATION_SCAN_LIMIT',
        errorScope: 'source',
        phase: 'archive_scan',
        sourceId: 's',
      });
      expect(typeof scan.requestId).toBe('string');
      expect(scan.requestId).not.toBe('');
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await transport.close?.();
    }
  });

  test('falls back to archive_scan phase when archive scan fails or is incomplete without remote phase', async () => {
    const registry: Registry = {
      version: 2,
      revision: 1,
      hosts: [{ hostId: 'h', label: 'h', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'gpu-node' } }],
      tasks: [{
        taskId: 't',
        hostId: 'h',
        label: 't',
        enabled: true,
        algorithm: 'flow',
        allowedDirectories: ['/allowed/run'],
        entryPaths: [],
        sources: [{ sourceId: 's', path: '/allowed/run/current.log', kind: 'log' }],
        checkpointDirectories: [],
      }],
    };
    const catalog = {
      status: 'configured' as const,
      listCandidates: () => [{ kind: 'registered_rotation' as const, sourceId: 's', candidateId: 'c1', registrationId: 'r1' }],
      resolveCandidate: async () => ({
        kind: 'registered_rotation' as const,
        sourceId: 's',
        candidateId: 'c1',
        registrationId: 'r1',
        taskId: 't',
        path: '/allowed/run/archive-c1.log',
        currentPath: '/allowed/run/current.log',
        allowedDirectories: ['/allowed/run'],
      }),
    };
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      attachServeHandler(child, () => ({ scanComplete: false, checkedCount: 0, candidates: [] }));
      return child;
    });
    const host = registry.hosts[0]!;
    const transport = createTransport({ hostId: 'h', host, registry }, { probeSource: 'print(1)', spawn: spawn as never, rotationCatalog: catalog });
    try {
      const registration = await transport.createRegistrationReference('t');
      const anchors = [{ startOffset: '0', length: 1, sha256: 'a'.repeat(64) }];
      const scan = await transport.scanArchiveCandidates('s', registration, anchors, new AbortController().signal);
      expect(scan).toMatchObject({
        status: 'inconclusive',
        candidates: [],
        errorCode: 'ROTATION_SCAN_INCOMPLETE',
        errorScope: 'source',
        phase: 'archive_scan',
        sourceId: 's',
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await transport.close?.();
    }
  });

  test('reports queue lock existence without claiming that a registered process holds it', () => {
    const task = { taskId: 'task', hostId: 'h', label: 'Task', enabled: true, algorithm: 'flow' as const, allowedDirectories: ['/allowed'], entryPaths: [], sources: [{ sourceId: 'lock', path: '/allowed/queue.lock', kind: 'queue_lock' as const }], checkpointDirectories: [] };
    const observation = projectTaskObservation(task, { scanComplete: true, sources: [{ sourceId: 'lock', status: 'ok', observedAt: '2026-01-01T00:00:00.000Z', fileIdentity: { dev: '1', inode: '2' }, eofBytes: '0' }], processes: [] }, '2026-01-01T00:00:00.000Z');
    expect(observation.sources[0]).toMatchObject({ exists: true, heldByRegisteredProcess: null });
  });
});
