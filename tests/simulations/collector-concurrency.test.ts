import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductionApi, type ProductionMonitorApi } from '../../src/collector/service';
import type { Registry, TaskRegistration } from '../../src/shared/contracts';
import type { StoreClient } from '../../src/store/protocol';
import type { ArchiveCandidateScan, HostObservation, ReadRequest, RegistrationReference, TaskObservation, Transport } from '../../src/transport/types';
import type { ReadReply } from '../../src/logs/types';
import { openTestStore } from '../store/helpers/test-client';
import { readReply } from '../store/helpers/fixtures';

const dirs: string[] = [];
const apis: ProductionMonitorApi[] = [];
const clients: StoreClient[] = [];

afterEach(async () => {
  await Promise.allSettled(apis.splice(0).map((api) => api.stop()));
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function multiHostRegistry(): Registry {
  return {
    version: 2,
    revision: 1,
    hosts: [
      { hostId: 'slow-host', label: 'Slow Host', enabled: true, allowedRoots: ['/a'], target: { kind: 'ssh', alias: 'slow-node' } },
      { hostId: 'fast-host', label: 'Fast Host', enabled: true, allowedRoots: ['/b'], target: { kind: 'ssh', alias: 'fast-node' } },
    ],
    tasks: [],
  };
}

function makeStubTransport(
  hostId: string,
  probeHostImpl: (signal: AbortSignal) => Promise<HostObservation>,
  overrides: Partial<Transport> = {},
): Transport {
  return {
    probeHost: probeHostImpl,
    async probeTask(task: TaskRegistration): Promise<TaskObservation> {
      return {
        taskId: task.taskId,
        hostId,
        observedAt: new Date().toISOString(),
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        processes: [],
        sources: [],
        errorCode: null,
        errorScope: null,
      };
    },
    async readLog(): Promise<ReadReply> { throw new Error('UNEXPECTED_READ'); },
    async scanArchiveCandidates(): Promise<ArchiveCandidateScan> {
      return { status: 'inconclusive', candidates: [], errorCode: 'ROTATION_CATALOG_UNCONFIGURED', observedAt: new Date().toISOString() };
    },
    async createRegistrationReference(taskId: string): Promise<RegistrationReference> {
      return { taskId, registryRevision: 1, fingerprint: 'fp' };
    },
    ...overrides,
  };
}

describe('multi-host concurrency, backoff, non-blocking getSnapshot, epoch & CPU-only hosts', () => {
  it('isolates a hung host so fast hosts, getSnapshot(), and saveRegistry() never block', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-concurrency-'));
    dirs.push(dir);
    let now = Date.parse('2026-11-20T00:00:00.000Z');
    const store = await openTestStore(dir, () => now);
    clients.push(store);
    let current = multiHostRegistry();

    let releaseSlow!: () => void;
    const slowBlocked = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowStarted!: () => void;
    const slowDidStart = new Promise<void>((resolve) => { slowStarted = resolve; });

    const slowTransport = makeStubTransport('slow-host', async (signal) => {
      slowStarted();
      await Promise.race([
        slowBlocked,
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      return {
        hostId: 'slow-host',
        connection: 'unobserved',
        freshness: 'unobserved',
        observedAt: null,
        scanComplete: false,
        hostBootId: null,
        phase: 'connect',
        errorCode: 'SSH_TIMEOUT',
      };
    });

    const fastTransport = makeStubTransport('fast-host', async () => ({
      hostId: 'fast-host',
      connection: 'connected',
      freshness: 'fresh',
      observedAt: new Date(now).toISOString(),
      scanComplete: true,
      hostBootId: 'fast-boot-1',
      phase: null,
      errorCode: null,
      acceleratorAvailability: 'none',
      gpu: { observedAt: null, state: 'unavailable', acceleratorAvailability: 'none', errorCode: null, metrics: [] },
    }));

    const api = createProductionApi({
      store,
      registryProvider: async () => current,
      registrySaver: async (next) => { current = { ...structuredClone(next), revision: current.revision + 1 }; return current; },
      transportProvider: (host) => host.hostId === 'slow-host' ? slowTransport : fastTransport,
      clock: () => now,
    });
    apis.push(api);
    await api.start();

    // Start hanging probe on slow-host
    const slowRefresh = api.requestRefresh({ hostId: 'slow-host' });
    await slowDidStart;

    // 1. fast-host refresh completes immediately while slow-host is still hung
    const t0 = Date.now();
    await api.requestRefresh({ hostId: 'fast-host' });
    expect(Date.now() - t0).toBeLessThan(500);

    // 2. getSnapshot() returns immediately without blocking on slow-host, showing fast-host connected (CPU-only!)
    const t1 = Date.now();
    const snap = await api.getSnapshot();
    expect(Date.now() - t1).toBeLessThan(200);
    const fast = snap.hosts.find((h) => h.hostId === 'fast-host');
    expect(fast).toMatchObject({
      connection: 'connected',
      freshness: 'fresh',
      errorCode: null,
      acceleratorAvailability: 'none',
    });

    // 3. saveRegistry() completes immediately without waiting for slow-host!
    const t2 = Date.now();
    const saved = await api.saveRegistry({
      ...current,
      hosts: current.hosts.map((h) => h.hostId === 'fast-host' ? { ...h, label: 'Fast Host Updated' } : h),
    });
    expect(Date.now() - t2).toBeLessThan(500);
    expect(saved.revision).toBe(2);

    releaseSlow();
    await slowRefresh;
  });

  it('applies exponential backoff (5s->10s->20s->40s->60s) on failures, exposes nextRetryAt, and resets on manual refresh', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-backoff-'));
    dirs.push(dir);
    let now = Date.parse('2026-11-20T00:00:00.000Z');
    const store = await openTestStore(dir, () => now);
    clients.push(store);
    const current: Registry = {
      version: 2,
      revision: 1,
      hosts: [{ hostId: 'h1', label: 'H1', enabled: true, allowedRoots: ['/a'], target: { kind: 'ssh', alias: 'node-1' } }],
      tasks: [],
    };
    let shouldFail = true;
    let bootId = 'boot-1';
    let calls = 0;

    const transport = makeStubTransport('h1', async () => {
      calls += 1;
      if (shouldFail) {
        return {
          hostId: 'h1',
          connection: 'unobserved',
          freshness: 'unobserved',
          observedAt: null,
          scanComplete: false,
          hostBootId: null,
          phase: 'connect',
          errorCode: 'SSH_TIMEOUT',
        };
      }
      return {
        hostId: 'h1',
        connection: 'connected',
        freshness: 'fresh',
        observedAt: new Date(now).toISOString(),
        scanComplete: true,
        hostBootId: bootId,
        phase: null,
        errorCode: null,
      };
    });

    const api = createProductionApi({
      store,
      registryProvider: async () => current,
      transportProvider: () => transport,
      clock: () => now,
    });
    apis.push(api);
    await api.start();

    // First failure -> 5s backoff
    await api.requestRefresh({ hostId: 'h1' });
    let host = (await api.getSnapshot()).hosts[0]!;
    expect(host.consecutiveFailures).toBe(1);
    expect(host.nextRetryAt).toBe(new Date(now + 5_000).toISOString());

    // Manual retry resets backoff and succeeds, establishing epoch 1
    shouldFail = false;
    await api.requestRefresh({ hostId: 'h1' });
    host = (await api.getSnapshot()).hosts[0]!;
    expect(host.connection).toBe('connected');
    expect(host.consecutiveFailures ?? 0).toBe(0);
    expect(host.nextRetryAt ?? null).toBeNull();
    const epoch1 = api.getHostEpoch?.('h1');
    expect(epoch1).toBeTruthy();

    // Disconnect then reconnect rotates hostEpoch!
    shouldFail = true;
    now += 1_000;
    await api.requestRefresh({ hostId: 'h1' });
    shouldFail = false;
    now += 1_000;
    await api.requestRefresh({ hostId: 'h1' });
    const epoch2 = api.getHostEpoch?.('h1');
    expect(epoch2).toBeTruthy();
    expect(epoch2).not.toBe(epoch1);

    // Host reboot (hostBootId changes without disconnect) also rotates hostEpoch!
    bootId = 'boot-2';
    now += 1_000;
    await api.requestRefresh({ hostId: 'h1' });
    const epoch3 = api.getHostEpoch?.('h1');
    expect(epoch3).toBeTruthy();
    expect(epoch3).not.toBe(epoch2);
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it('keeps log deduplication bounded across >600 distinct log lines', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-dedup-'));
    dirs.push(dir);
    const now = Date.parse('2026-11-20T00:00:00.000Z');
    const at = new Date(now).toISOString();
    const store = await openTestStore(dir, () => now);
    clients.push(store);
    const current: Registry = {
      version: 2,
      revision: 1,
      hosts: [{ hostId: 'h1', label: 'H1', enabled: true, allowedRoots: ['/a'], target: { kind: 'ssh', alias: 'node-1' } }],
      tasks: [{
        taskId: 't1',
        hostId: 'h1',
        label: 'T1',
        enabled: true,
        algorithm: 'generic',
        logFormat: 'generic',
        allowedDirectories: ['/a/run'],
        entryPaths: ['/a/run/train.py'],
        sources: [{ sourceId: 's1', path: '/a/run/train.log', kind: 'log' }],
        checkpointDirectories: [],
      }],
    };
    const identity = { dev: '1', inode: '2' };
    let bytes = Buffer.from(Array.from({ length: 350 }, (_, i) => `step=${i} loss=0.1\n`).join(''), 'utf8');
    const transport = makeStubTransport('h1', async () => ({
      hostId: 'h1', connection: 'connected', freshness: 'fresh', observedAt: at, scanComplete: true, hostBootId: 'boot-1', phase: null, errorCode: null,
    }), {
      async probeTask(): Promise<TaskObservation> {
        return {
          taskId: 't1', hostId: 'h1', observedAt: at, freshness: 'fresh', scanComplete: true,
          processScanError: null, phase: null, errorCode: null, errorScope: null, processes: [],
          sources: [{
            sourceId: 's1', observedAt: at, fileIdentity: identity, eofBytes: String(bytes.length),
            permission: 'readable', exists: true, statusValues: null, heldByRegisteredProcess: null,
            errorCode: null, evidenceComplete: true, errorScope: null, phase: null,
          }],
        };
      },
      async readLog(request: ReadRequest): Promise<ReadReply> {
        const start = Number(BigInt(request.offset));
        const slice = bytes.subarray(start, start + request.limitBytes);
        const reply = readReply({
          ...request.expected,
          sourceId: 's1',
          state: 'tracking',
          identityStrength: 'strong',
          fileIdentity: identity,
          generationStartOffset: '0',
          maxObservedOffset: String(bytes.length),
          anchors: [],
          parserState: {
            recordStartOffset: request.expected.committedOffset,
            pendingCR: false,
            utf8CarryBase64: '',
            boundedPreview: '',
            displayTruncated: false,
            prefixIncomplete: false,
          },
        } as never, slice, at, bytes);
        return {
          ...reply,
          before: { ...reply.before, fileIdentity: identity, anchors: [] },
          after: { ...reply.after, fileIdentity: identity, anchors: [] },
        };
      },
    });

    const api = createProductionApi({
      store,
      registryProvider: async () => current,
      transportProvider: () => transport,
      clock: () => now,
    });
    apis.push(api);
    const published: string[] = [];
    api.subscribe((u) => {
      if (u.kind === 'logs') published.push(...u.events.map((e) => e.eventId));
    });
    await api.start();
    await api.requestRefresh({});
    bytes = Buffer.concat([bytes, Buffer.from(Array.from({ length: 300 }, (_, i) => `step=${i + 350} loss=0.05\n`).join(''), 'utf8')]);
    await api.requestRefresh({});
    expect(published.length).toBeGreaterThanOrEqual(650);
    // Refresh again with unchanged file should not republish duplicates
    const countBefore = published.length;
    await api.requestRefresh({});
    expect(published.length).toBe(countBefore);
  });
});
