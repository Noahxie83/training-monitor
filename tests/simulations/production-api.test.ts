import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectorScheduler } from '../../src/collector/scheduler';
import { createInitialBindingState } from '../../src/domain/bindings';
import type { MonitorSnapshot } from '../../src/shared/api';
import type { LogEvent, Registry, ResourceMetric, TaskRegistration } from '../../src/shared/contracts';
import { projectRegistrySnapshot } from '../../src/shared/registry-snapshot';
import type { ReadReply, SourceObservation } from '../../src/logs/types';
import type { ProductionMonitorApi } from '../../src/collector/service';
import type { StoreClient } from '../../src/store/protocol';
import type {
  ArchiveCandidateScan,
  HostObservation,
  HostGpuObservation,
  ReadRequest,
  RegistrationReference,
  TaskObservation,
  Transport,
} from '../../src/transport/types';
import { openTestStore } from '../store/helpers/test-client';
import { observation, readReply } from '../store/helpers/fixtures';

const dirs: string[] = [];
const apis: ProductionMonitorApi[] = [];
const clients: StoreClient[] = [];
const NOW = '2026-10-21T00:00:00.000Z';
const FIVE_MIB = 5 * 1024 * 1024;

afterEach(async () => {
  await Promise.allSettled(apis.splice(0).map((api) => api.stop()));
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function registry(enabled = true): Registry {
  return {
    version: 1,
    revision: 1,
    hosts: [{
      hostId: 'host-a',
      label: 'Host A',
      enabled,
      allowedRoots: ['/allowed'],
      target: { kind: 'ssh', alias: 'lab-campus' },
    }],
    tasks: [{
      taskId: 'task-a',
      hostId: 'host-a',
      label: 'Task A',
      enabled,
      algorithm: 'flow',
      allowedDirectories: ['/allowed/task-a'],
      entryPaths: ['/allowed/task-a/train.py'],
      sources: [{ sourceId: 'source-a', path: '/allowed/task-a/train.log', kind: 'log' }],
      checkpointDirectories: [],
    }],
  };
}

function hostObservation(connection: 'connected' | 'unobserved' = 'connected'): HostObservation {
  return connection === 'connected'
    ? { hostId: 'host-a', freshness: 'fresh', observedAt: NOW, phase: null, connection, scanComplete: true, hostBootId: 'boot-a', errorCode: null }
    : { hostId: 'host-a', freshness: 'unobserved', observedAt: null, phase: 'connect', connection, scanComplete: false, hostBootId: null, errorCode: 'CONNECT_FAILED' };
}

function gpuObservation(at = NOW, utilization = 0): HostGpuObservation {
  const metrics: ResourceMetric[] = [
    { observedAt: at, freshness: 'fresh', source: 'nvidia-smi', name: 'gpu_utilization', unit: 'percent_device', value: utilization, scope: 'device', deviceId: 'GPU 0', processKey: null },
    { observedAt: at, freshness: 'fresh', source: 'nvidia-smi', name: 'gpu_memory_used', unit: 'bytes', value: 512 * 1024 * 1024, scope: 'device', deviceId: 'GPU 0', processKey: null },
    { observedAt: at, freshness: 'fresh', source: 'nvidia-smi', name: 'gpu_memory_total', unit: 'bytes', value: 8192 * 1024 * 1024, scope: 'device', deviceId: 'GPU 0', processKey: null },
  ];
  return { observedAt: at, state: 'available', errorCode: null, metrics };
}

function taskObservation(
  eofBytes: string,
  identity = { dev: '1', inode: '2' },
  startTicks = '100',
): TaskObservation {
  return {
    taskId: 'task-a',
    hostId: 'host-a',
    observedAt: NOW,
    freshness: 'fresh',
    scanComplete: true,
    processScanError: null,
    phase: null,
    processes: [{
      key: { hostBootId: 'boot-a', pid: 42, startTicks },
      role: 'unknown',
      cwd: '/allowed/task-a',
      scriptEntry: '/allowed/task-a/train.py',
      observedAt: NOW,
      roleEvidence: 'exact_entry_and_direct_writer_fd',
      directWriterSourceIds: ['source-a'],
      writerSourceEvidence: { 'source-a': { fileIdentity: identity, eofBytes } },
      writerEvidenceComplete: true,
      evidenceComplete: true,
      interpreterFlags: [],
    }],
    sources: [{
      sourceId: 'source-a',
      observedAt: NOW,
      fileIdentity: identity,
      eofBytes,
      permission: 'readable',
      exists: true,
      statusValues: null,
      heldByRegisteredProcess: null,
      errorCode: null,
      evidenceComplete: true,
      errorScope: null,
      phase: null,
    }],
    errorCode: null,
    errorScope: null,
  };
}

class SimulatedTransport implements Transport {
  host = hostObservation();
  task = taskObservation('0');
  bytes = Buffer.alloc(0);
  identity = { dev: '1', inode: '2' };
  failSource = false;
  hostCalls = 0;
  taskCalls = 0;
  readCalls: ReadRequest[] = [];
  readFailures = 0;
  stopSignals = 0;
  inFlight = 0;
  maxInFlight = 0;
  synthesizeAnchors = true;

  async probeHost(signal: AbortSignal): Promise<HostObservation> {
    this.hostCalls += 1;
    this.observeSignal(signal);
    return structuredClone(this.host);
  }

  async probeTask(task: TaskRegistration, signal: AbortSignal): Promise<TaskObservation> {
    this.taskCalls += 1;
    this.observeSignal(signal);
    if (task.taskId !== 'task-a' || task.hostId !== 'host-a') throw new Error('UNREGISTERED_TASK');
    return structuredClone({ ...this.task, sources: this.task.sources.map((source) => ({
      ...source,
      fileIdentity: this.identity,
      eofBytes: String(this.bytes.length),
      errorCode: this.failSource ? 'SOURCE_PERMISSION' : null,
      permission: this.failSource ? 'denied' : 'readable',
    })), processes: this.task.processes.map((process) => ({
      ...process,
      writerSourceEvidence: { 'source-a': { fileIdentity: this.identity, eofBytes: String(this.bytes.length) } },
    })) });
  }

  async readLog(request: ReadRequest, signal: AbortSignal): Promise<ReadReply> {
    this.readCalls.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      this.observeSignal(signal);
      if (this.failSource) {
        this.readFailures += 1;
        throw new Error('SOURCE_PERMISSION');
      }
      const start = Number(BigInt(request.offset));
      const bytes = this.bytes.subarray(start, start + request.limitBytes);
      const expected = request.expected;
      const synthesized = readReply({
        sourceId: 'source-a',
        generation: expected.generation,
        revision: expected.revision,
        committedOffset: expected.committedOffset,
        state: 'tracking',
        identityStrength: 'strong',
        fileIdentity: this.identity,
        generationStartOffset: '0',
        maxObservedOffset: String(this.bytes.length),
        anchors: [],
        parserState: {
          recordStartOffset: expected.committedOffset,
          pendingCR: false,
          utf8CarryBase64: '',
          boundedPreview: '',
          displayTruncated: false,
          prefixIncomplete: false,
        },
      }, bytes, NOW, this.bytes);
      const withObservedIdentity = {
        ...synthesized,
        before: { ...synthesized.before, fileIdentity: { ...this.identity } },
        after: { ...synthesized.after, fileIdentity: { ...this.identity } },
      };
      if (this.synthesizeAnchors) return withObservedIdentity;
      const observedAnchors = request.anchors.map((anchor) => ({
        startOffset: anchor.startOffset,
        endOffset: String(BigInt(anchor.startOffset) + BigInt(anchor.length)),
        sha256: anchor.sha256,
      }));
      return {
        ...withObservedIdentity,
        before: { ...withObservedIdentity.before, anchors: observedAnchors },
        after: { ...withObservedIdentity.after, anchors: observedAnchors },
      };
    } finally {
      this.inFlight -= 1;
    }
  }

  async scanArchiveCandidates(): Promise<ArchiveCandidateScan> {
    return { status: 'inconclusive', candidates: [], errorCode: 'ROTATION_CATALOG_UNCONFIGURED', observedAt: NOW };
  }

  async createRegistrationReference(taskId: string): Promise<RegistrationReference> {
    return { taskId, registryRevision: 1, fingerprint: 'fixture' };
  }

  observeSignal(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('PROBE_CANCELLED');
  }
}

async function store() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-production-api-'));
  dirs.push(directory);
  const client = await openTestStore(directory, () => Date.parse(NOW));
  clients.push(client);
  return { directory, client };
}

function trackApi<T extends ProductionMonitorApi>(api: T): T {
  apis.push(api);
  return api;
}

describe('production monitor API core path', () => {
  it('derives cumulative progress from a probed status read and rejects another process identity', async () => {
    const { createProductionApi } = await import('../../src/collector/service');
    const { client } = await store();
    const current = registry(true);
    current.tasks[0]!.sources.push({ sourceId: 'status-a', path: '/allowed/task-a/status.json', kind: 'status_json' });
    const transport = new SimulatedTransport();
    transport.synthesizeAnchors = false;
    transport.bytes = Buffer.from('0/100 [00:00:00<00:00:10, 0.0it/s]\n');
    let now = Date.parse(NOW);
    let statusPid = 42;
    const probe = transport.probeTask.bind(transport);
    transport.probeTask = async (task, signal) => {
      const result = await probe(task, signal);
      const at = new Date(now).toISOString();
      result.observedAt = new Date(now - 100).toISOString(); // Probe began before its file observation.
      for (const source of result.sources) source.observedAt = at;
      for (const process of result.processes) process.observedAt = at;
      const statusValues = { taskId: 'task-a', hostId: 'host-a', hostBootId: 'boot-a',
        pid: statusPid, startTicks: '100', sequence: now, resume_checkpoint_index: 0,
        target: 101, target_meaning: 'exclusive_index' };
      const raw = JSON.stringify(statusValues);
      result.sources.push({ sourceId: 'status-a', observedAt: at, fileIdentity: {dev:'1',inode:'status'},
        eofBytes: String(Buffer.byteLength(raw)), permission:'readable', exists:true,
        statusValues, statusRawContent:raw, heldByRegisteredProcess:null, errorCode:null,
        evidenceComplete:true, phase:null });
      return result;
    };
    const api = trackApi(createProductionApi({ store: client, registryProvider: async () => current,
      transportProvider: () => transport, clock: () => now }));
    await api.start();
    await api.requestRefresh({ taskId: 'task-a' });
    transport.bytes = Buffer.from('10/100 [00:00:01<00:00:09, 10.0it/s]\n');
    transport.bytes = Buffer.concat([Buffer.from('0/100 [00:00:00<00:00:10, 0.0it/s]\n'), transport.bytes]);
    await api.requestRefresh({ taskId: 'task-a' });
    let progress = (await api.getSnapshot()).tasks[0]!.progress;
    expect(progress.lastStepIndex).toBe(10);
    expect(progress.global).toMatchObject({completedCount:11,targetCount:101,verified:true});
    expect(progress.session).toMatchObject({completedCount:10,targetCount:100,verified:true});
    statusPid = 43;
    transport.bytes = Buffer.concat([transport.bytes, Buffer.from('11/100 [00:00:02<00:00:09, 5.5it/s]\n')]);
    await api.requestRefresh({ taskId: 'task-a' });
    progress = (await api.getSnapshot()).tasks[0]!.progress;
    expect(progress.global.completedCount).toBeNull();
  });

  it('probes registered hosts without tasks, scopes refresh by host, isolates failures, recovers, and protects disabled or changed targets', async () => {
    const collectorModule = await import('../../src/collector/service');
    const { client } = await store();
    let now = Date.parse(NOW);
    const current = registry(true);
    current.tasks = [];
    current.hosts.push({
      hostId: 'host-b', label: 'Host B', enabled: true, allowedRoots: ['/b'],
      target: { kind: 'wsl', distribution: 'Ubuntu-26.04' },
    });
    const ssh = new SimulatedTransport();
    ssh.host = { ...hostObservation('unobserved'), errorCode: 'SSH_UNAVAILABLE' };
    const wsl = new SimulatedTransport();
    wsl.host = { ...hostObservation(), hostId: 'host-b', gpu: gpuObservation(NOW, 63) };
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => current,
      transportProvider: (host) => host.hostId === 'host-a' ? ssh : wsl,
      clock: () => now,
    }));
    await api.start();
    const updates: MonitorSnapshot[] = [];
    api.subscribe((update) => { if (update.kind === 'snapshot') updates.push(update.snapshot); });

    let snapshot = await api.getSnapshot();
    expect(ssh.hostCalls).toBe(1);
    expect(wsl.hostCalls).toBe(1);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.hosts).toHaveLength(2);
    expect((await client.getSnapshot()).hosts).toEqual([]);
    expect(snapshot.hosts.find((host) => host.hostId === 'host-a')).toMatchObject({
      connection: 'disconnected', freshness: 'unobserved', errorCode: 'SSH_UNAVAILABLE', lastSuccessAt: null,
    });
    expect(snapshot.hosts.find((host) => host.hostId === 'host-b')).toMatchObject({
      connection: 'connected', freshness: 'fresh', errorCode: null, lastSuccessAt: NOW, lastProbeDurationMs: 0,
      gpu: { state: 'available', observedAt: NOW, metrics: expect.arrayContaining([expect.objectContaining({ name: 'gpu_utilization', value: 63 })]) },
    });
    expect(snapshot.hosts.find((host) => host.hostId === 'host-a')?.gpu).toBeUndefined();
    expect(updates.at(-1)?.tasks).toEqual([]);
    expect(updates.at(-1)?.hosts.find((host) => host.hostId === 'host-b')).toMatchObject({ connection: 'connected', freshness: 'fresh', lastSuccessAt: NOW });

    now += 1_000;
    ssh.host = { ...hostObservation(), observedAt: new Date(now).toISOString(), gpu: gpuObservation(new Date(now).toISOString(), 22) };
    await api.requestRefresh({ hostId: 'host-a' });
    expect(ssh.hostCalls).toBe(2);
    expect(wsl.hostCalls).toBe(1);
    snapshot = await api.getSnapshot();
    const recoveredAt = new Date(now).toISOString();
    expect(snapshot.hosts.find((host) => host.hostId === 'host-a')).toMatchObject({
      connection: 'connected', freshness: 'fresh', observedAt: recoveredAt, lastSuccessAt: recoveredAt,
      gpu: { state: 'available', observedAt: recoveredAt, metrics: expect.arrayContaining([expect.objectContaining({ name: 'gpu_utilization', value: 22 })]) },
    });
    expect(snapshot.hosts.find((host) => host.hostId === 'host-b')?.gpu?.metrics[0]?.value).toBe(63);
    expect(updates.at(-1)?.hosts.find((host) => host.hostId === 'host-a')).toMatchObject({ connection: 'connected', freshness: 'fresh', lastSuccessAt: recoveredAt });

    now += 1_000;
    ssh.host = { ...hostObservation('unobserved'), errorCode: 'SSH_DISCONNECTED' };
    await api.requestRefresh({ hostId: 'host-a' });
    snapshot = await api.getSnapshot();
    expect(snapshot.hosts.find((host) => host.hostId === 'host-a')).toMatchObject({
      connection: 'disconnected', freshness: 'stale', observedAt: new Date(now).toISOString(),
      lastSuccessAt: recoveredAt, errorCode: 'SSH_DISCONNECTED',
      gpu: { state: 'unavailable', observedAt: recoveredAt, metrics: expect.arrayContaining([expect.objectContaining({ freshness: 'stale', observedAt: recoveredAt, value: 22 })]) },
    });

    const wslCallsBeforeDisable = wsl.hostCalls;
    current.hosts[1]!.enabled = false;
    await api.requestRefresh({ hostId: 'host-b' });
    snapshot = await api.getSnapshot();
    expect(wsl.hostCalls).toBe(wslCallsBeforeDisable);
    expect(snapshot.hosts.find((host) => host.hostId === 'host-b')).toMatchObject({
      connection: 'unobserved', freshness: 'unobserved', errorCode: 'HOST_DISABLED',
    });
    expect(snapshot.hosts.find((host) => host.hostId === 'host-b')?.gpu).toBeUndefined();

    current.hosts[1]!.enabled = true;
    current.hosts[1]!.target = { kind: 'ssh', alias: 'lab-campus' };
    wsl.host = { ...hostObservation('unobserved'), hostId: 'host-b', errorCode: 'TARGET_PROBE_FAILED' };
    await api.requestRefresh({ hostId: 'host-b' });
    snapshot = await api.getSnapshot();
    expect(snapshot.hosts.find((host) => host.hostId === 'host-b')).toMatchObject({
      connection: 'disconnected', freshness: 'unobserved', lastSuccessAt: null, errorCode: 'TARGET_PROBE_FAILED',
    });
    expect(snapshot.hosts.find((host) => host.hostId === 'host-b')?.gpu).toBeUndefined();
    expect(updates.every((update) => update.tasks.length === 0)).toBe(true);
    await api.stop();
    await client.close();
  });

  it('projects registry deletion through getSnapshot and subscriptions without deleting stored logs, and does not revive it after restart', async () => {
    const collectorModule = await import('../../src/collector/service');
    const { directory, client } = await store();
    let current = registry(true);
    const transport = new SimulatedTransport();
    transport.bytes = Buffer.from('historical log stays stored\n');
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => current,
      registrySaver: async (next) => { current = structuredClone(next); return current; },
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await api.start();
    await api.requestRefresh({});
    expect((await client.getLogs({ requestId: 'kept-before-delete', sourceId: 'source-a', before: null, limit: 10 })).events.map((event) => event.text)).toContain('historical log stays stored');

    const updates: MonitorSnapshot[] = [];
    const unsubscribe = api.subscribe((update) => { if (update.kind === 'snapshot') updates.push(update.snapshot); });
    await api.saveRegistry({ ...current, tasks: [] });
    let snapshot = await api.getSnapshot();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.sources).toEqual([]);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((update) => update.tasks.length === 0 && update.sources.length === 0)).toBe(true);

    await api.requestRefresh({});
    snapshot = await api.getSnapshot();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.sources).toEqual([]);
    expect((await client.getLogs({ requestId: 'kept-after-delete', sourceId: 'source-a', before: null, limit: 10 })).events.map((event) => event.text)).toContain('historical log stays stored');
    unsubscribe();
    await api.stop();

    const reopened = await openTestStore(directory, () => Date.parse(NOW));
    clients.push(reopened);
    const restarted = trackApi(collectorModule.createProductionApi({
      store: reopened,
      registryProvider: async () => current,
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await restarted.start();
    snapshot = await restarted.getSnapshot();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.sources).toEqual([]);
    expect((await reopened.getLogs({ requestId: 'still-retained-after-restart', sourceId: 'source-a', before: null, limit: 10 })).events.map((event) => event.text)).toContain('historical log stays stored');
    await restarted.stop();
    await reopened.close();
  });

  it('shows disabled registered tasks and new hosts with full placeholders while filtering unrelated cached entries and sources', () => {
    const cached = {
      version: 1,
      demo: false,
      hosts: [
        { version: 1, hostId: 'host-a', kind: 'ssh', connection: 'connected', observedAt: NOW, freshness: 'fresh', lastSuccessAt: NOW, lastProbeDurationMs: 1, scanComplete: true, errorCode: null },
        { version: 1, hostId: 'host-new', kind: 'ssh', connection: 'connected', observedAt: NOW, freshness: 'fresh', lastSuccessAt: NOW, lastProbeDurationMs: 1, scanComplete: true, errorCode: null },
        { version: 1, hostId: 'removed-host', kind: 'ssh', connection: 'connected', observedAt: NOW, freshness: 'fresh', lastSuccessAt: NOW, lastProbeDurationMs: 1, scanComplete: true, errorCode: null },
      ],
      tasks: [
        { taskId: 'task-a', hostId: 'host-a', lifecycle: 'running', resources: [] },
        { taskId: 'task-new', hostId: 'host-new', lifecycle: 'running', resources: [] },
        { taskId: 'removed-task', hostId: 'removed-host', lifecycle: 'running', resources: [] },
      ],
      sources: [
        { sourceId: 'current-source', taskId: 'task-a', state: 'ready' },
        { sourceId: 'removed-source', taskId: 'task-a', state: 'ready' },
        { sourceId: 'new-source', taskId: 'removed-task', state: 'ready' },
        { sourceId: 'orphan-source', taskId: 'removed-task', state: 'ready' },
      ],
    } as unknown as MonitorSnapshot;
    const registry: Registry = {
      version: 1,
      revision: 2,
      hosts: [
        { hostId: 'host-a', label: 'Host A', enabled: true, allowedRoots: ['/a'], target: { kind: 'ssh', alias: 'lab-campus' } },
        { hostId: 'host-new', label: 'New host', enabled: false, allowedRoots: ['/b'], target: { kind: 'wsl', distribution: 'Ubuntu-26.04' } },
      ],
      tasks: [
        { taskId: 'task-a', hostId: 'host-a', label: 'Task A', enabled: true, algorithm: 'flow', allowedDirectories: ['/a/run'], entryPaths: [], sources: [{ sourceId: 'current-source', path: '/a/run.log', kind: 'log' }], checkpointDirectories: [] },
        { taskId: 'task-new', hostId: 'host-new', label: 'New task', enabled: false, algorithm: 'unknown', allowedDirectories: ['/b/run'], entryPaths: [], sources: [{ sourceId: 'new-source', path: '/b/run.log', kind: 'log' }], checkpointDirectories: [] },
      ],
    };

    const projected = projectRegistrySnapshot(cached, registry);

    expect(projected.hosts.map((host) => host.hostId)).toEqual(['host-a', 'host-new']);
    expect(projected.hosts[1]).toMatchObject({ kind: 'wsl', connection: 'unobserved', freshness: 'unobserved', observedAt: null });
    expect(projected.tasks.map((task) => task.taskId)).toEqual(['task-a', 'task-new']);
    expect(projected.tasks[1]).toMatchObject({ hostId: 'host-new', lifecycle: 'unknown', freshness: 'unobserved', progress: { freshness: 'unobserved' }, checkpoint: { freshness: 'unobserved' } });
    expect(projected.sources.map((source) => [source.sourceId, source.taskId])).toEqual([['current-source', 'task-a'], ['new-source', 'task-new']]);
    expect(projected.sources[1]).toMatchObject({ state: 'unobserved', freshness: 'unobserved', observedAt: null });
  });

  it('starts a large first import at the five MiB tail and keeps every batch bounded', async () => {
    const collectorModule = await import('../../src/collector/service');
    const transport = new SimulatedTransport();
    transport.synthesizeAnchors = false;
    transport.bytes = Buffer.alloc(FIVE_MIB + 128 * 1024, 0x61);
    const { client } = await store();
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));

    await api.start();
    await api.requestRefresh({});

    expect(transport.readCalls[0]?.offset).toBe(String(transport.bytes.length - FIVE_MIB));
    expect(transport.readCalls[0]?.limitBytes).toBe(256 * 1024);
    expect(transport.readCalls.every((call) => call.limitBytes <= 256 * 1024)).toBe(true);
    expect((await client.getCursor('source-a'))?.committedOffset).toBe(String(transport.bytes.length));
    await api.stop();
    await client.close();
  });

  it('does not collect disabled defaults, collects only the registered source, and persists append exactly once', async () => {
    const collectorModule = await import('../../src/collector/service');
    expect(collectorModule.createProductionApi, 'production MonitorApi factory must exist').toBeTypeOf('function');
    const transport = new SimulatedTransport();
    const { directory, client } = await store();
    const disabled = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(false),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await disabled.start();
    await disabled.requestRefresh({});
    expect(transport.hostCalls + transport.taskCalls).toBe(0);
    await disabled.stop();
    await client.close();

    const enabledTransport = new SimulatedTransport();
    const reopened = await openTestStore(directory, () => Date.parse(NOW));
    clients.push(reopened);
    enabledTransport.bytes = Buffer.from('100/1000 [00:10<01:30, 10.0it/s]\n');
    const api = trackApi(collectorModule.createProductionApi({
      store: reopened,
      registryProvider: async () => registry(true),
      transportProvider: () => enabledTransport,
      clock: () => Date.parse(NOW),
    }));
    await api.start();
    await api.requestRefresh({});
    const snapshot = await api.getSnapshot();
    expect(snapshot.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-a', hostId: 'host-a' }),
    ]));
    expect(snapshot.sources).toHaveLength(1);
    expect(enabledTransport.readCalls.length).toBeGreaterThan(0);
    expect(enabledTransport.readCalls.every((call) => call.sourceId === 'source-a')).toBe(true);
    const page = await api.getLogs({ requestId: 'page-a', sourceId: 'source-a', before: null, limit: 10 });
    expect(page.events.map((event) => event.text)).toContain('100/1000 [00:10<01:30, 10.0it/s]');
    const search = await api.searchLogs({ requestId: 'search-a', sourceIds: ['source-a'], literal: '100/1000', continuation: null });
    expect(search.events).toHaveLength(1);
    await api.requestRefresh({});
    expect((await api.getLogs({ requestId: 'page-once', sourceId: 'source-a', before: null, limit: 20 })).events.filter((event) => event.text === '100/1000 [00:10<01:30, 10.0it/s]')).toHaveLength(1);
    await api.stop();
    await reopened.close();
  });

  it('continues from the persisted cursor after restart and reads bytes appended while stopped', async () => {
    const collectorModule = await import('../../src/collector/service');
    expect(collectorModule.createProductionApi).toBeTypeOf('function');
    const { directory, client } = await store();
    const transport = new SimulatedTransport();
    transport.synthesizeAnchors = false;
    transport.bytes = Buffer.from('first\n');
    const first = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await first.start();
    await first.requestRefresh({});
    const cursor = await client.getCursor('source-a');
    expect(cursor?.committedOffset).toBe(String(transport.bytes.length));
    await first.stop();
    await client.close();

    transport.bytes = Buffer.from('first\nsecond\n');
    const reopened = await openTestStore(directory, () => Date.parse(NOW));
    clients.push(reopened);
    const second = trackApi(collectorModule.createProductionApi({
      store: reopened,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await second.start();
    await second.requestRefresh({});
    expect(await reopened.getCursor('source-a')).toMatchObject({ committedOffset: String(transport.bytes.length) });
    const page = await second.getLogs({ requestId: 'restart-page', sourceId: 'source-a', before: null, limit: 10 });
    expect(page.events.map((event) => event.text)).toEqual(expect.arrayContaining(['first', 'second']));
    await second.stop();
    await reopened.close();
  });

  it('reads the first bytes of a replacement generation after sealing the old one', async () => {
    const collectorModule = await import('../../src/collector/service');
    const { client } = await store();
    const transport = new SimulatedTransport();
    transport.synthesizeAnchors = false;
    transport.bytes = Buffer.from('old-record\n');
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await api.start();
    await api.requestRefresh({});
    transport.bytes = Buffer.from('new\n');
    transport.identity = { dev: '1', inode: '99' };
    transport.task = taskObservation('4', transport.identity);
    await api.requestRefresh({});
    await api.requestRefresh({});

    expect(transport.readCalls.slice(0, 2).map((call) => call.offset)).toEqual(['0', '11']);
    expect(transport.readCalls.some((call) => call.offset === '0')).toBe(true);
    expect((await client.getCursor('source-a'))?.committedOffset).toBe('4');
    const page = await api.getLogs({ requestId: 'replacement-first-read', sourceId: 'source-a', before: null, limit: 20 });
    expect(page.events.map((event) => event.text)).toEqual(expect.arrayContaining(['old-record', 'new']));
  });

  it('isolates a failed source and keeps disconnect stale without claiming training failure', async () => {
    const collectorModule = await import('../../src/collector/service');
    expect(collectorModule.createProductionApi).toBeTypeOf('function');
    const { client } = await store();
    const transport = new SimulatedTransport();
    transport.bytes = Buffer.from('before\n');
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await api.start();
    await api.requestRefresh({});
    transport.failSource = true;
    await api.requestRefresh({});
    expect(transport.readFailures).toBeGreaterThan(0);
    expect((await api.getSnapshot()).sources[0]).toMatchObject({ state: 'permission_error' });

    transport.host = hostObservation('unobserved');
    const stale = await api.getSnapshot();
    expect(stale.hosts[0]).toMatchObject({ connection: 'disconnected', freshness: 'stale', observedAt: NOW });
    expect(stale.tasks[0]).toMatchObject({ freshness: 'stale', lifecycle: 'unknown' });
    expect(stale.tasks[0]!.lifecycle).not.toBe('failed');
    expect(stale.tasks[0]!.statusObservedAt).toBe(NOW);
    await api.stop();
    await client.close();
  });

  it('shares one GPU host sample across same-host tasks and keeps it fresh when task scan is incomplete', async () => {
    const collectorModule = await import('../../src/collector/service');
    const { client } = await store();
    const base = new SimulatedTransport();
    base.host = { ...hostObservation(), gpu: gpuObservation() };
    base.task = { ...base.task, scanComplete: false, freshness: 'fresh', processes: [], processScanError: 'PROCESS_SCAN_INCOMPLETE' };
    const registryWithTwoTasks = registry(true);
    registryWithTwoTasks.tasks.push({
      ...registryWithTwoTasks.tasks[0]!, taskId: 'task-b', label: 'Task B',
      allowedDirectories: ['/allowed/task-b'], entryPaths: [], sources: [],
    });
    const multiTaskTransport = new Proxy(base, {
      get(target, property) {
        if (property === 'probeTask') return async (task: TaskRegistration, signal: AbortSignal) => {
          if (task.taskId === 'task-a') return target.probeTask(task, signal);
          target.taskCalls += 1;
          target.observeSignal(signal);
          return { ...taskObservation('0'), taskId: task.taskId, hostId: task.hostId, sources: [], processes: [], scanComplete: false, processScanError: 'PROCESS_SCAN_INCOMPLETE' };
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as SimulatedTransport;
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registryWithTwoTasks,
      transportProvider: () => multiTaskTransport,
      clock: () => Date.parse(NOW),
    }));
    await api.start();
    const snapshot = await api.getSnapshot();
    expect(base.hostCalls).toBe(1);
    expect(base.taskCalls).toBe(2);
    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.tasks.map((task) => task.resources.find((metric) => metric.name === 'gpu_utilization'))).toEqual([
      expect.objectContaining({ value: 0, freshness: 'fresh', deviceId: 'GPU 0' }),
      expect.objectContaining({ value: 0, freshness: 'fresh', deviceId: 'GPU 0' }),
    ]);
    await api.stop();
    await client.close();
  });

  it('keeps logs and host connected when GPU sampling fails, retains stale GPU time through disconnect, and refreshes after recovery', async () => {
    const collectorModule = await import('../../src/collector/service');
    const { client } = await store();
    const transport = new SimulatedTransport();
    transport.bytes = Buffer.from('log remains readable\n');
    transport.host = { ...hostObservation(), gpu: gpuObservation() };
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await api.start();
    await api.requestRefresh({});
    expect((await api.getSnapshot()).tasks[0]!.resources[0]).toMatchObject({ freshness: 'fresh', observedAt: NOW });

    transport.host = { ...hostObservation(), gpu: { observedAt: null, state: 'unavailable', errorCode: 'NVIDIA_SMI_TIMEOUT', metrics: [] } };
    await api.requestRefresh({});
    let snapshot = await api.getSnapshot();
    expect(snapshot.hosts[0]).toMatchObject({ connection: 'connected', freshness: 'fresh' });
    expect(snapshot.tasks[0]!.resources[0]).toMatchObject({ freshness: 'stale', observedAt: NOW });
    expect((await api.getLogs({ requestId: 'gpu-error-log', sourceId: 'source-a', before: null, limit: 20 })).events.map((event) => event.text)).toContain('log remains readable');

    transport.host = hostObservation('unobserved');
    await api.requestRefresh({});
    snapshot = await api.getSnapshot();
    expect(snapshot.tasks[0]!.resources[0]).toMatchObject({ freshness: 'stale', observedAt: NOW });

    transport.host = { ...hostObservation(), gpu: gpuObservation(NOW, 17) };
    await api.requestRefresh({});
    snapshot = await api.getSnapshot();
    expect(snapshot.tasks[0]!.resources.find((metric) => metric.name === 'gpu_utilization')).toMatchObject({ freshness: 'fresh', observedAt: NOW, value: 17 });
    await api.stop();
    await client.close();
  });

  it('samples GPU on every five-second tick even when the prior host probe takes time', async () => {
    const { createProductionApi } = await import('../../src/collector/service');
    const { client } = await store();
    let now = Date.parse(NOW);
    let tick!: () => Promise<void>;
    const schedule = vi.spyOn(CollectorScheduler.prototype, 'schedule').mockImplementation((delay, _key, operation) => {
      expect(delay).toBe(5_000);
      tick = operation;
    });
    const transport = new SimulatedTransport();
    transport.probeHost = async () => {
      transport.hostCalls += 1;
      now += 600;
      return { ...hostObservation(), gpu: gpuObservation(new Date(now).toISOString()) };
    };
    const api = trackApi(createProductionApi({
      store: client, registryProvider: async () => registry(true),
      transportProvider: () => transport, clock: () => now,
    }));
    try {
      await api.start();
      await api.getSnapshot();
      now = Date.parse(NOW) + 5_000;
      await tick();
      now = Date.parse(NOW) + 10_000;
      await tick();
      expect(transport.hostCalls).toBe(3);
    } finally {
      schedule.mockRestore();
      await api.stop();
      await client.close();
    }
  });

  it('does not retain another target\'s GPU samples when a host target changes', async () => {
    const { createProductionApi } = await import('../../src/collector/service');
    const { client } = await store();
    const transport = new SimulatedTransport();
    transport.host = { ...hostObservation(), gpu: gpuObservation() };
    const currentRegistry = registry(true);
    const api = trackApi(createProductionApi({
      store: client, registryProvider: async () => currentRegistry,
      transportProvider: () => transport, clock: () => Date.parse(NOW),
    }));
    await api.start();
    expect((await api.getSnapshot()).tasks[0]!.resources).toHaveLength(3);
    currentRegistry.hosts[0]!.target = { kind: 'wsl', distribution: 'Ubuntu-26.04' };
    transport.host = hostObservation('unobserved');
    expect((await api.getSnapshot()).tasks[0]!.resources).toEqual([]);
    await api.stop();
    await client.close();
  });

  it('resets progress for a same-PID process with new startTicks and keeps unsupported baseline facts null', async () => {
    const collectorModule = await import('../../src/collector/service');
    expect(collectorModule.createProductionApi).toBeTypeOf('function');
    const { client } = await store();
    const transport = new SimulatedTransport();
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
      bindingStateProvider: () => createInitialBindingState(),
    }));
    await api.start();
    await api.requestRefresh({});
    const first = await api.getSnapshot();
    expect(first.tasks[0]!.progress.baselineEvidenceId).toBeNull();
    expect(first.tasks[0]!.progress.global.completedCount).toBeNull();

    transport.task = taskObservation('0', { dev: '1', inode: '2' }, '200');
    await api.requestRefresh({});
    const second = await api.getSnapshot();
    expect(second.tasks[0]!.progress.baselineEvidenceId).toBeNull();
    expect(second.tasks[0]!.progress.global.completedCount).toBeNull();
    expect(second.tasks[0]!.currentRun?.mainProcessKey.startTicks).toBe('200');
    await api.stop();
    await client.close();
  });

  it('uses the existing generation reconciliation path for truncation and preserves old cached logs', async () => {
    const collectorModule = await import('../../src/collector/service');
    expect(collectorModule.createProductionApi).toBeTypeOf('function');
    const { client } = await store();
    const transport = new SimulatedTransport();
    transport.synthesizeAnchors = false;
    transport.bytes = Buffer.from('old-record\n');
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await api.start();
    await api.requestRefresh({});
    const oldGeneration = (await client.getCursor('source-a'))?.generation;
    transport.bytes = Buffer.from('new\n');
    transport.identity = { dev: '1', inode: '99' };
    transport.task = taskObservation('4', transport.identity);
    await api.requestRefresh({});
    await api.requestRefresh({});
    const cursor = await client.getCursor('source-a');
    expect(cursor?.generation).not.toBe(oldGeneration);
    expect(cursor?.committedOffset).toBe('4');
    const page = await api.getLogs({ requestId: 'replacement-page', sourceId: 'source-a', before: null, limit: 20 });
    expect(page.events.map((event) => event.text)).toContain('old-record');
    expect(page.events.map((event) => event.text)).toContain('new');
    await api.stop();
    await client.close();
  });

  it('stops all polling and closes the worker while demo remains network-free', async () => {
    const collectorModule = await import('../../src/collector/service');
    expect(collectorModule.createProductionApi).toBeTypeOf('function');
    const transport = new SimulatedTransport();
    const { client } = await store();
    const api = trackApi(collectorModule.createProductionApi({
      store: client,
      registryProvider: async () => registry(true),
      transportProvider: () => transport,
      clock: () => Date.parse(NOW),
    }));
    await api.start();
    await api.requestRefresh({});
    const calls = transport.hostCalls + transport.taskCalls + transport.readCalls.length;
    await api.stop();
    expect(transport.stopSignals).toBe(0);
    await expect(client.getSnapshot()).rejects.toThrow('STORE_CLOSED');
    expect(transport.hostCalls + transport.taskCalls + transport.readCalls.length).toBe(calls);

    const mockModule = await import('../../src/mocks/api');
    const demo = mockModule.createMockApi({ demo: true });
    expect((await demo.getSnapshot()).demo).toBe(true);
  });
});
