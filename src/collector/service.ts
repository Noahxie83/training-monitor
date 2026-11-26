import { cancelChangedServerWaits } from '../launch/reconcile';
import { AutoStartController } from '../launch/controller';
import type { LaunchLedger } from '../launch/ledger';
import { randomUUID } from 'node:crypto';
import type { MonitorApi, MonitorSnapshot, MonitorUpdate, LogPage, LogQuery, LogSearchPage, LogSearchRequest } from '../shared/api';
import type {
  CursorState,
  LogEvent,
  HostRegistration,
  HostSnapshot,
  LogSourceSnapshot,
  Preferences,
  ProcessKey,
  Registry,
  ResourceMetric,
  TaskRegistration,
  TaskSnapshot,
} from '../shared/contracts';
import type { StoreClient } from '../store/protocol';
import type { PersistedObservation } from '../store/engine';
import type { HostGpuObservation, HostObservation, TaskObservation, TaskProcessObservation, Transport } from '../transport/types';
import type { CandidateScan, SourceObservation } from '../logs/types';
import type { BindingState, TrainerOutputObservation } from '../domain/bindings';
import { projectStatusRecord } from '../domain/status-record';
import { projectRegistrySnapshot } from '../shared/registry-snapshot';
import { PAGE_EVENT_LIMIT, PAGE_TEXT_BUDGET_BYTES } from '../shared/budgets';
import { createInitialBindingState, ingestCompleteRecord, interruptBindingObservation, isTimestampValid, updateBindings } from '../domain/bindings';
import { parseRegisteredRecord } from '../parsers/registered';
import { projectTask } from '../domain/lifecycle';
import { projectResources } from '../domain/resources';
import { areProcessKeysEqual, isRegisteredProcessEntry, makeRunId, processEntry } from '../domain/identity';
import { ingestStructuredBaselineRead } from '../domain/evidence';
import { validateRegistry } from '../shared/validate';
import { CollectorScheduler } from './scheduler';
import { isRegisteredGpuProcess } from '../transport/gpu';

type Scope = { hostId?: string; taskId?: string };
type MaybePromise<T> = T | Promise<T>;
type CommittedLogBatch = { ingestedAt: string; events: LogEvent[] };

export interface ProductionMonitorOptions {
  store: StoreClient;
  registryProvider: () => Promise<Registry>;
  registrySaver?: (registry: Registry) => Promise<Registry>;
  transportProvider: (host: HostRegistration, registry: Registry) => MaybePromise<Transport>;
  clock: () => number;
  launchLedger?: LaunchLedger;
  monotonicClock?: () => number;
  bindingStateProvider?: (taskId: string) => BindingState;
  preferencesProvider?: () => Promise<Preferences>;
  preferencesSaver?: (preferences: Preferences) => Promise<Preferences>;
}

export interface ProductionMonitorApi extends MonitorApi {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const HOST_PROBE_INTERVAL_MS = 5_000;
const NORMAL_READ_BYTES = 256 * 1024;
const CATCH_UP_READ_BYTES = 1024 * 1024;
const PAGE_SIZE = 50;

function eventSignature(event: LogEvent): string { return JSON.stringify(event); }

function boundedLogBatch(events: LogEvent[]): LogEvent[] {
  const selected: LogEvent[] = [];
  let bytes = 0;
  for (const event of events.slice(-PAGE_EVENT_LIMIT)) {
    const next = Buffer.byteLength(event.text ?? '', 'utf8');
    if (selected.length > 0 && bytes + next > PAGE_TEXT_BUDGET_BYTES) break;
    selected.push(event);
    bytes += next;
  }
  return selected;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function retainStaleGpu(current: HostObservation, previous?: HostObservation): HostObservation {
  if (current.gpu?.state === 'available') return current;
  const priorMetrics = previous?.gpu?.metrics ?? [];
  if (priorMetrics.length === 0) return current;
  return {
    ...current,
    gpu: {
      observedAt: previous?.gpu?.observedAt ?? null,
      state: 'unavailable',
      errorCode: current.gpu?.errorCode ?? 'GPU_SAMPLE_UNAVAILABLE',
      metrics: priorMetrics.map((metric) => ({ ...metric, freshness: 'stale' })),
    },
  };
}

function taskResources(gpu: HostGpuObservation | undefined, previous: TaskSnapshot | null, now: string): ResourceMetric[] {
  const processMetrics = previous?.resources.filter((metric) => metric.scope === 'process') ?? [];
  if (gpu?.state === 'available') {
    const deviceSamples = projectResources(gpu.metrics.map((metric) => ({
      source: metric.source,
      name: metric.name,
      unit: metric.unit,
      value: metric.value,
      observedAt: metric.observedAt ?? gpu.observedAt ?? '',
      scope: metric.scope,
      deviceId: metric.deviceId,
      processKey: metric.processKey,
    })), { now, ttlMs: 15_000 });
    return [...processMetrics, ...deviceSamples];
  }
  const staleDeviceMetrics = gpu?.metrics.length
    ? gpu.metrics.map((metric) => ({ ...metric, freshness: 'stale' as const }))
    : previous?.resources.filter((metric) => metric.scope === 'device')
      .map((metric) => ({ ...metric, freshness: 'stale' as const })) ?? [];
  return [...processMetrics, ...staleDeviceMetrics];
}

function processGpuMetric(metric: ResourceMetric): boolean {
  return metric.scope === 'process' && (metric.name === 'gpu_memory_used' || metric.name === 'gpu_utilization');
}

/** A new PID instance can never inherit the previous instance's GPU ownership. */
function withTaskGpu(snapshot: TaskSnapshot, previous: TaskSnapshot | null, task: TaskRegistration, observation: TaskObservation, now: string): TaskSnapshot {
  const complete = observation.freshness === 'fresh' && observation.scanComplete && observation.processScanError === null;
  const keys = observation.processes.filter(process => isRegisteredGpuProcess(task, process)).map(process => process.key);
  const gpu = complete ? observation.processGpu : undefined;
  const baseResources = snapshot.resources.filter(metric => !processGpuMetric(metric));
  if (gpu?.state === 'available') {
    const processKeys = gpu.processKeys.filter(key => keys.some(allowed => areProcessKeysEqual(key, allowed)));
    const metrics = projectResources(gpu.metrics.filter(processGpuMetric).map(metric => ({ ...metric,
      observedAt: metric.observedAt ?? '', keyBeforeSample: metric.processKey, keyAfterSample: metric.processKey,
    })), { now, ttlMs: 15_000, registeredKeys: processKeys });
    return { ...snapshot, resources: [...baseResources, ...metrics], gpuUsage: {
      observedAt: gpu.observedAt, freshness: 'fresh', state: 'available', errorCode: null, processKeys,
    } };
  }
  const retained = (previous?.resources ?? []).filter(metric => processGpuMetric(metric) &&
    (!complete || keys.some(key => areProcessKeysEqual(key, metric.processKey))))
    .map(metric => ({ ...metric, freshness: 'stale' as const }));
  return { ...snapshot, resources: [...baseResources, ...retained], gpuUsage: {
    observedAt: retained.length ? previous?.gpuUsage?.observedAt ?? retained[0]!.observedAt : null,
    freshness: retained.length ? 'stale' : 'unobserved', state: 'unavailable',
    errorCode: observation.processGpu?.errorCode ?? (complete ? 'PROCESS_GPU_UNAVAILABLE' : 'PROCESS_SCAN_INCOMPLETE'),
    processKeys: retained.length ? previous?.gpuUsage?.processKeys ?? [] : [],
  } };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return error instanceof Error && error.message ? error.message : 'SOURCE_READ_FAILED';
}

function sourceState(code: string | null): LogSourceSnapshot['state'] {
  if (!code) return 'ready';
  if (code.includes('PERMISSION') || code.includes('DENIED')) return 'permission_error';
  if (code.includes('MISSING') || code.includes('NOT_FOUND')) return 'missing';
  if (code.includes('STORAGE') || code.includes('CACHE') || code.includes('DISK')) return 'storage_error';
  return 'read_error';
}

function sampleAnchors(cursor: CursorState) {
  return cursor.anchors.map((anchor) => ({
    startOffset: anchor.startOffset,
    length: Number(BigInt(anchor.endOffset) - BigInt(anchor.startOffset)),
    sha256: anchor.sha256,
  }));
}

function sourceObservation(taskObservation: TaskObservation, sourceId: string, sizeOverride?: string): SourceObservation | null {
  const source = taskObservation.sources.find((item) => item.sourceId === sourceId);
  if (!source || !source.fileIdentity || source.eofBytes === null || source.observedAt === null) return null;
  return {
    fileIdentity: { ...source.fileIdentity },
    sizeBytes: sizeOverride ?? source.eofBytes,
    anchors: [],
    observedAt: source.observedAt,
    identityStrength: 'strong',
  };
}

function exactWriter(task: TaskRegistration, process: TaskProcessObservation): boolean {
  return !!process.key &&
    !!process.scriptEntry &&
    isRegisteredProcessEntry(task, process) &&
    process.roleEvidence === 'exact_entry_and_direct_writer_fd' &&
    process.evidenceComplete &&
    process.writerEvidenceComplete &&
    process.directWriterSourceIds.some((sourceId) =>
      task.sources.some((source) => source.sourceId === sourceId && source.kind === 'log'));
}

/**
 * A completed probe can establish process identity before a readable training
 * record is available. Keep that identity useful, but leave run progress
 * unconfirmed and all baseline-derived facts null.
 */
function retainObservedRun(snapshot: TaskSnapshot, task: TaskRegistration, observation: TaskObservation): TaskSnapshot {
  if (snapshot.currentRun || observation.freshness !== 'fresh' || !observation.scanComplete) return snapshot;
  const candidates = observation.processes.filter((process) => exactWriter(task, process));
  if (candidates.length !== 1) return snapshot;
  const process = candidates[0]!;
  const key: ProcessKey = { ...process.key! };
  return {
    ...snapshot,
    lifecycle: snapshot.lifecycle === 'not_observed' ? 'unconfirmed' : snapshot.lifecycle,
    confidence: snapshot.confidence === 'high' ? 'medium' : snapshot.confidence,
    reason: snapshot.reason === 'Scan complete with no active processes or records observed'
      ? 'Registered entry and direct log writer observed; trainer progress is not yet confirmed'
      : snapshot.reason,
    currentRun: { runId: makeRunId(task.hostId, task.taskId, key), mainProcessKey: key },
    processes: {
      ...snapshot.processes,
      main: {
        key,
        pid: key.pid,
        parentKey: null,
        cwd: process.cwd,
        scriptEntry: processEntry(process),
        role: 'trainer',
        observedAt: process.observedAt,
      },
    },
    progress: {
      ...snapshot.progress,
      baselineEvidenceId: null,
      resumeCheckpointIndex: null,
      global: {
        completedCount: null,
        targetCount: null,
        fraction: null,
        unit: 'unknown',
        verified: false,
        sourceId: null,
      },
    },
  };
}

function disconnectedHost(observation: HostObservation, now: string): HostObservation {
  if (observation.connection === 'connected' && observation.freshness === 'fresh' && observation.scanComplete && observation.errorCode === null) return observation;
  return {
    ...observation,
    observedAt: now,
    freshness: 'unobserved',
    connection: 'disconnected',
    scanComplete: false,
    hostBootId: null,
    errorCode: observation.errorCode ?? 'CACHED_OFFLINE',
  };
}

function unavailableTask(task: TaskRegistration, hostObservation: HostObservation): TaskObservation {
  return {
    taskId: task.taskId,
    hostId: task.hostId,
    observedAt: null,
    freshness: 'unobserved',
    scanComplete: false,
    processScanError: hostObservation.errorCode ?? 'HOST_UNAVAILABLE',
    phase: hostObservation.phase,
    processes: [],
    sources: task.sources.map((source) => ({
      sourceId: source.sourceId,
      observedAt: null,
      fileIdentity: null,
      eofBytes: null,
      permission: 'unknown',
      exists: null,
      statusValues: null,
      heldByRegisteredProcess: null,
      errorCode: null,
      evidenceComplete: false,
      errorScope: null,
      phase: null,
    })),
    errorCode: hostObservation.errorCode ?? 'HOST_UNAVAILABLE',
    errorScope: 'host',
  };
}

class ProductionMonitor implements ProductionMonitorApi {
  private readonly scheduler = new CollectorScheduler();
  private readonly listeners = new Set<(update: MonitorUpdate) => void>();
  private readonly previousTasks = new Map<string, TaskSnapshot>();
  private readonly taskRegistrations = new Map<string, string>();
  private readonly bindings = new Map<string, BindingState>();
  private readonly hostEpochs = new Map<string, string>();
  private readonly connectedHosts = new Set<string>();
  private readonly lastHostObservation = new Map<string, HostObservation>();
  private readonly lastHostSuccessAt = new Map<string, string>();
  private readonly lastHostProbeDurationMs = new Map<string, number>();
  private readonly hostTargets = new Map<string, string>();
  private readonly lastTaskObservation = new Map<string, TaskObservation>();
  private readonly publishedLogSignatures = new Map<string, Map<string, string>>();
  private readonly seededLogSources = new Set<string>();
  private readonly abort = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private preferences: Preferences = { theme: 'system' };

  private readonly autoStart: AutoStartController;
  constructor(private readonly options: ProductionMonitorOptions) {
    this.autoStart = new AutoStartController({ ledger: options.launchLedger, clock: options.clock, monotonicClock: options.monotonicClock,
      registryProvider: options.registryProvider, onChange: async () => this.publishSnapshot(await options.registryProvider()) });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new Error('MONITOR_STOPPED');
    this.started = true;
    const registry = await this.options.registryProvider();
    for (const host of registry.hosts) this.hostTargets.set(host.hostId, JSON.stringify(host.target));
    const snapshot = projectRegistrySnapshot(await this.options.store.getSnapshot(), registry);
    for (const host of snapshot.hosts) {
      if (host.lastSuccessAt) this.lastHostSuccessAt.set(host.hostId, host.lastSuccessAt);
      if (host.lastProbeDurationMs !== null) this.lastHostProbeDurationMs.set(host.hostId, host.lastProbeDurationMs);
    }
    for (const task of snapshot.tasks) this.previousTasks.set(task.taskId, task);
    for (const task of registry.tasks) this.taskRegistrations.set(task.taskId, JSON.stringify(task));
    if (this.options.preferencesProvider) this.preferences = await this.options.preferencesProvider();
    this.scheduler.schedule(HOST_PROBE_INTERVAL_MS, '__collector__', () => this.enqueueRefresh({}));
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.scheduler.stop();
    await this.tail.catch(() => undefined);
    await this.options.store.close().catch(() => undefined);
    this.listeners.clear();
  }

  subscribe(listener: (update: MonitorUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getSnapshot(): Promise<MonitorSnapshot> {
    await this.enqueueRefresh({});
    const [snapshot, registry] = await Promise.all([
      this.options.store.getSnapshot(),
      this.options.registryProvider(),
    ]);
    return this.snapshotWithHostStates(projectRegistrySnapshot(snapshot, registry), registry);
  }

  async requestRefresh(scope: Scope): Promise<void> {
    await this.enqueueRefresh(scope);
  }

  getLogs(query: LogQuery): Promise<LogPage> { return this.options.store.getLogs(query); }
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage> { return this.options.store.searchLogs(query); }
  cancelRequest(requestId: string): Promise<void> { return this.options.store.cancelRequest(requestId); }

  async getRegistry(): Promise<Registry> {
    return structuredClone(await this.options.registryProvider());
  }

  async saveRegistry(registry: Registry): Promise<Registry> {
    if (!this.options.registrySaver) throw new Error('REGISTRY_SAVE_UNAVAILABLE');
    const validated = validateRegistry(registry);
    const run = this.tail.catch(() => undefined).then(async () => {
      if (this.stopped) throw new Error('MONITOR_STOPPED');
      const current = await this.options.registryProvider();
      if (validated.revision !== current.revision) throw new Error('REVISION_CONFLICT');
      await cancelChangedServerWaits(current, validated, this.options.transportProvider, this.abort.signal);
      const saved = await this.options.registrySaver!(validated);
      await this.refresh({});
      return structuredClone(saved);
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async getPreferences(): Promise<Preferences> {
    return { ...this.preferences };
  }

  async savePreferences(value: Preferences): Promise<Preferences> {
    if (value.theme !== 'system' && value.theme !== 'light' && value.theme !== 'dark') throw new TypeError('INVALID_PREFERENCES');
    this.preferences = this.options.preferencesSaver
      ? await this.options.preferencesSaver({ theme: value.theme })
      : { theme: value.theme };
    return { ...this.preferences };
  }

  async copyRegisteredPath(): Promise<void> {
    // Desktop IPC owns clipboard access. The monitor API deliberately does not
    // inspect or mutate the registered remote path.
  }

  private enqueueRefresh(scope: Scope): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('MONITOR_STOPPED'));
    const run = this.tail.catch(() => undefined).then(() => this.refresh(scope));
    this.tail = run;
    return run;
  }

  private async refresh(scope: Scope): Promise<void> {
    if (this.stopped) return;
    const registry = await this.options.registryProvider();
    this.autoStart.synchronize(registry);
    this.syncRegisteredTasks(registry);
    this.syncRegisteredHosts(registry);
    const scopedTaskHostId = scope.taskId
      ? registry.tasks.find((task) => task.taskId === scope.taskId)?.hostId
      : undefined;
    const selectedHosts = registry.hosts.filter((host) => scope.hostId
      ? host.hostId === scope.hostId
      : scope.taskId ? host.hostId === scopedTaskHostId : true);
    for (const host of selectedHosts) {
      if (this.abort.signal.aborted) return;
      if (!host.enabled) continue;
      const tasks = registry.tasks.filter((task) => task.enabled && task.hostId === host.hostId &&
        (!scope.taskId || task.taskId === scope.taskId));
      try { await this.refreshHost(host, tasks, registry); }
      catch { /* A task-side failure on one host must not block the remaining hosts. */ }
    }
    await this.publishSnapshot(registry);
  }

  private syncRegisteredHosts(registry: Registry): void {
    const current = new Map(registry.hosts.map((host) => [host.hostId, host]));
    for (const [hostId, previousTarget] of this.hostTargets) {
      const host = current.get(hostId);
      if (!host) {
        this.hostTargets.delete(hostId);
        this.lastHostObservation.delete(hostId);
        this.lastHostSuccessAt.delete(hostId);
        this.lastHostProbeDurationMs.delete(hostId);
        this.connectedHosts.delete(hostId);
        continue;
      }
      if (previousTarget !== JSON.stringify(host.target)) {
        this.lastHostObservation.delete(hostId);
        this.lastHostSuccessAt.delete(hostId);
        this.lastHostProbeDurationMs.delete(hostId);
        this.connectedHosts.delete(hostId);
        this.hostEpochs.delete(hostId);
        for (const task of this.previousTasks.values()) {
          if (task.hostId === hostId) {
            this.previousTasks.delete(task.taskId);
            this.bindings.delete(task.taskId);
            this.lastTaskObservation.delete(task.taskId);
          }
        }
        this.hostTargets.set(hostId, JSON.stringify(host.target));
      }
    }
    for (const host of registry.hosts) {
      if (!this.hostTargets.has(host.hostId)) this.hostTargets.set(host.hostId, JSON.stringify(host.target));
      if (!host.enabled) {
        this.lastHostObservation.set(host.hostId, {
          hostId: host.hostId,
          freshness: 'unobserved',
          observedAt: null,
          phase: null,
          connection: 'unobserved',
          scanComplete: false,
          hostBootId: null,
          errorCode: 'HOST_DISABLED',
        });
        this.connectedHosts.delete(host.hostId);
      } else if (this.lastHostObservation.get(host.hostId)?.errorCode === 'HOST_DISABLED') {
        this.lastHostObservation.delete(host.hostId);
      }
    }
  }

  private syncRegisteredTasks(registry: Registry): void {
    const current = new Map(registry.tasks.map((task) => [task.taskId, task]));
    for (const [taskId, signature] of this.taskRegistrations) {
      const task = current.get(taskId);
      if (!task || JSON.stringify(task) !== signature) {
        this.taskRegistrations.delete(taskId);
        this.previousTasks.delete(taskId);
        this.bindings.delete(taskId);
        this.lastTaskObservation.delete(taskId);
      }
    }
    for (const task of registry.tasks) {
      const signature = JSON.stringify(task);
      if (!this.taskRegistrations.has(task.taskId)) this.taskRegistrations.set(task.taskId, signature);
    }
  }

  private async refreshHost(host: HostRegistration, tasks: TaskRegistration[], registry: Registry): Promise<void> {
    let transport: Transport | null = null;
    let hostObservation: HostObservation;
    const probeStartedAt = this.options.clock();
    const previousHost = this.lastHostObservation.get(host.hostId);
    try {
      transport = await this.options.transportProvider(host, registry);
      hostObservation = retainStaleGpu(await transport.probeHost(this.abort.signal), previousHost);
    } catch (error) {
      hostObservation = retainStaleGpu({
        hostId: host.hostId,
        freshness: 'unobserved',
        observedAt: null,
        phase: 'probe',
        connection: 'unobserved',
        scanComplete: false,
        hostBootId: null,
        errorCode: error instanceof Error && error.message ? error.message : 'HOST_PROBE_FAILED',
      }, previousHost);
    }
    this.lastHostProbeDurationMs.set(host.hostId, Math.max(0, this.options.clock() - probeStartedAt));

    const connected = hostObservation.connection === 'connected' &&
      hostObservation.freshness === 'fresh' && hostObservation.scanComplete && hostObservation.errorCode === null;
    if (!connected) {
      const disconnected = disconnectedHost(hostObservation, iso(this.options.clock()));
      this.connectedHosts.delete(host.hostId);
      this.lastHostObservation.set(host.hostId, disconnected);
      for (const task of tasks) {
        const taskObservation = unavailableTask(task, disconnected);
        const prior = this.previousTasks.get(task.taskId) ?? null;
        const bindingState = interruptBindingObservation(this.bindings.get(task.taskId) ?? this.initialBinding(task.taskId));
        this.bindings.set(task.taskId, bindingState);
        const projected = projectTask(prior, {
          task,
          taskObservation,
          hostObservation: disconnected,
          observedAt: iso(this.options.clock()),
          bindingState,
          resources: taskResources(disconnected.gpu, prior, iso(this.options.clock())),
        });
        const snapshot = this.storeSnapshotFor(withTaskGpu(projected, prior, task, taskObservation, iso(this.options.clock())), task);
        await this.save(task, host.target.kind, disconnected, taskObservation, snapshot, {}, {});
        await this.autoStart.evaluate(host, task, disconnected, transport, this.abort.signal);
      }
      return;
    }

    this.connectedHosts.add(host.hostId);
    this.ensureHostEpoch(host.hostId, hostObservation);
    this.lastHostObservation.set(host.hostId, hostObservation);
    if (hostObservation.observedAt) this.lastHostSuccessAt.set(host.hostId, hostObservation.observedAt);
    for (const task of tasks) {
      if (this.abort.signal.aborted) return;
      if (!transport) return;
      const taskObservation = await transport.probeTask(task, this.abort.signal);
      this.lastTaskObservation.set(task.taskId, taskObservation);
      await this.collectTask(transport, task, host.target.kind, hostObservation, taskObservation);
      await this.autoStart.evaluate(host, task, hostObservation, transport, this.abort.signal);
    }
  }

  private initialBinding(taskId: string): BindingState {
    return this.options.bindingStateProvider?.(taskId) ?? createInitialBindingState();
  }

  private ensureHostEpoch(hostId: string, observation: HostObservation): void {
    const prior = this.hostEpochs.get(hostId);
    const reconnect = !this.connectedHosts.has(hostId);
    if (!prior || reconnect) this.hostEpochs.set(hostId, randomUUID());
  }

  private async collectTask(
    transport: Transport,
    task: TaskRegistration,
    hostKind: HostRegistration['target']['kind'],
    hostObservation: HostObservation,
    taskObservation: TaskObservation,
  ): Promise<void> {
    let observedAt = iso(this.options.clock());
    let bindingState = this.bindings.get(task.taskId) ?? this.initialBinding(task.taskId);
    const sourceStates: PersistedObservation['sourceStates'] = {};
    const sourceGenerations: Record<string, string> = {};

    const logSources = task.sources.filter((source) => source.kind === 'log');
    for (const source of logSources) {
      const observedSource = taskObservation.sources.find((item) => item.sourceId === source.sourceId);
      let cursor = await this.options.store.getCursor(source.sourceId);
      if (!cursor) {
        const initial = sourceObservation(taskObservation, source.sourceId);
        if (initial) {
          try {
            cursor = await this.options.store.registerSource(source.sourceId, initial, task.taskId);
          } catch (error) {
            sourceStates[source.sourceId] = { observedAt, freshness: 'fresh', state: 'storage_error', errorCode: errorCode(error) };
            continue;
          }
        }
      }
      if (!cursor) {
        sourceStates[source.sourceId] = { observedAt, freshness: taskObservation.freshness, state: 'unobserved', errorCode: null };
        continue;
      }

      // Establish the observation window before reading, then advance it to
      // the probed EOF after the transactional read. This lets supported new
      // records acquire run bindings without assigning pre-observation bytes.
      bindingState = await this.applyBindings(task, taskObservation, bindingState, observedAt);
      const result = await this.refreshSource(transport, task, source.sourceId, taskObservation, cursor);
      cursor = result.cursor;
      await this.publishCommittedLogs(source.sourceId, result.batches.flatMap((batch) => batch.events));
      sourceGenerations[source.sourceId] = cursor.generation;
      sourceStates[source.sourceId] = {
        observedAt,
        freshness: taskObservation.freshness,
        state: result.error ? sourceState(result.error) : 'ready',
        errorCode: result.error,
      };
      for (const batch of result.batches) {
        bindingState = await this.applyBindings(task, taskObservation, bindingState, batch.ingestedAt);
        for (const event of batch.events) {
          bindingState = ingestCompleteRecord(event, bindingState).state;
        }
      }
      this.bindings.set(task.taskId, bindingState);
    }

    observedAt = iso(this.options.clock());
    for (const source of task.sources.filter((item) => item.kind !== 'log')) {
      const observed = taskObservation.sources.find((item) => item.sourceId === source.sourceId);
      sourceStates[source.sourceId] = {
        observedAt: observed?.observedAt ?? observedAt,
        freshness: taskObservation.freshness,
        state: observed?.permission === 'missing' ? 'missing' : observed?.permission === 'denied' ? 'permission_error' : 'ready',
        errorCode: observed?.errorCode ?? null,
      };
      // The same read-only probe supplies bytes, stat identity and parsed status.
      // Feed this observation through the domain's existing identity validation.
      if (source.kind === 'status_json' && observed?.statusRawContent &&
          observed.observedAt && observed.fileIdentity?.dev && observed.fileIdentity.inode &&
          observed.eofBytes === String(Buffer.byteLength(observed.statusRawContent, 'utf8'))) {
        const generation = 'status:' + observed.fileIdentity.dev + ':' + observed.fileIdentity.inode;
        bindingState = { ...bindingState, sourceCursors: [
          ...(bindingState.sourceCursors ?? []).filter((item) => item.sourceId !== source.sourceId),
          { sourceId: source.sourceId, generation, fileIdentity: { ...observed.fileIdentity },
            eofBytes: observed.eofBytes, observedAt: observed.observedAt },
        ] };
        bindingState = ingestStructuredBaselineRead(bindingState, task, { ...taskObservation, observedAt }, {
          evidenceId: 'status-read:' + source.sourceId + ':' + observed.observedAt,
          sourceId: source.sourceId, generation, fileIdentity: { ...observed.fileIdentity },
          observedAt: observed.observedAt, startOffset: '0', endOffset: observed.eofBytes,
          rawContent: observed.statusRawContent,
        });
      }
    }

    this.bindings.set(task.taskId, bindingState);
    const prior = this.previousTasks.get(task.taskId) ?? null;
    const outputSamples = await this.latestOutputSample(task, taskObservation);
    observedAt = iso(this.options.clock());
    let projected = projectTask(prior, {
      task,
      taskObservation,
      hostObservation,
      observedAt,
      bindingState,
      outputSamples,
      resources: taskResources(hostObservation.gpu, prior, observedAt),
    });
    projected = retainObservedRun(projected, task, taskObservation);
    projected = projectStatusRecord(projected, task, hostObservation, taskObservation, prior);
    projected = withTaskGpu(projected, prior, task, taskObservation, observedAt);
    const snapshot = this.storeSnapshotFor(projected, task);
    await this.save(task, hostKind, hostObservation, taskObservation, snapshot, sourceGenerations, sourceStates);
  }

  private async applyBindings(
    task: TaskRegistration,
    taskObservation: TaskObservation,
    state: BindingState,
    observedAt: string,
  ): Promise<BindingState> {
    const sourceInfo: Record<string, { generation: string; eofBytes: string; fileIdentity: { dev: string; inode: string } | null }> = {};
    for (const source of taskObservation.sources) {
      const cursor = await this.options.store.getCursor(source.sourceId);
      if (!cursor) continue;
      sourceInfo[source.sourceId] = {
        generation: cursor.generation,
        eofBytes: source.eofBytes ?? cursor.committedOffset,
        fileIdentity: source.fileIdentity,
      };
    }
    const observerEpoch = this.hostEpochs.get(task.hostId);
    if (!observerEpoch) return state;
    const outputSamples = await this.latestOutputSample(task, taskObservation);
    return updateBindings(state, {
      task,
      taskId: task.taskId,
      hostId: task.hostId,
      observerEpoch,
      observedAt,
      taskObservation,
      sourceInfo,
      outputSamples,
    });
  }

  private async refreshSource(
    transport: Transport,
    task: TaskRegistration,
    sourceId: string,
    taskObservation: TaskObservation,
    initialCursor: CursorState,
  ): Promise<{ cursor: CursorState; error: string | null; batches: CommittedLogBatch[] }> {
    let cursor = (await this.options.store.getCursor(sourceId)) ?? initialCursor;
    const batches: CommittedLogBatch[] = [];
    let observed = taskObservation.sources.find((source) => source.sourceId === sourceId);
    let attempts = 0;
    while (attempts++ < 64 && !this.abort.signal.aborted) {
      const current = await this.options.store.getCursor(sourceId);
      if (!current) return { cursor, error: 'CURSOR_UNAVAILABLE', batches };
      cursor = current;
      if (current.state === 'reconciling') {
        const reconciled = await this.reconcile(transport, task, sourceId, observed);
        if (!reconciled) return { cursor: (await this.options.store.getCursor(sourceId)) ?? current, error: null, batches };
        cursor = reconciled;
        continue;
      }

      const eof = observed?.eofBytes ?? current.maxObservedOffset;
      const knownEof = /^\d+$/.test(eof) ? BigInt(eof) : null;
      const identityChanged = !!observed?.fileIdentity && !!current.fileIdentity &&
        (observed.fileIdentity.dev !== current.fileIdentity.dev || observed.fileIdentity.inode !== current.fileIdentity.inode);
      const sourceUnavailable = observed?.permission === 'denied' ||
        observed?.permission === 'missing' ||
        (observed?.errorCode !== null && observed?.errorCode !== undefined);
      const shouldRead = sourceUnavailable ||
        knownEof === null ||
        knownEof > BigInt(current.committedOffset) ||
        knownEof < BigInt(current.committedOffset) ||
        identityChanged ||
        current.committedOffset === '0';
      if (!shouldRead) return { cursor: current, error: null, batches };

      const catchUp = knownEof !== null && knownEof > BigInt(current.maxObservedOffset);
      try {
        const registration = await transport.createRegistrationReference(task.taskId);
        const reply = await transport.readLog({
          kind: 'current',
          sourceId,
          offset: current.committedOffset,
          limitBytes: catchUp ? CATCH_UP_READ_BYTES : NORMAL_READ_BYTES,
          expected: { generation: current.generation, revision: current.revision, committedOffset: current.committedOffset },
          registration,
          anchors: sampleAnchors(current),
        }, this.abort.signal);
        const ingestedAt = iso(this.options.clock());
        const receipt = await this.options.store.commitReadWithReceipt({
          expected: current,
          reply,
          ingestedAt,
        });
        if (receipt.status === 'stale') continue;
        if (receipt.status === 'storage_error') return { cursor: (await this.options.store.getCursor(sourceId)) ?? current, error: 'STORAGE_ERROR', batches };
        cursor = (await this.options.store.getCursor(sourceId)) ?? current;
        if (receipt.status === 'reconciling') continue;
        if (receipt.events.length > 0) batches.push({ ingestedAt, events: receipt.events });
        if (cursor.committedOffset === current.committedOffset) return { cursor, error: null, batches };
        if (knownEof === null || BigInt(cursor.committedOffset) >= knownEof) return { cursor, error: null, batches };
        await new Promise<void>((resolve) => setImmediate(resolve));
      } catch (error) {
        return { cursor: (await this.options.store.getCursor(sourceId)) ?? current, error: errorCode(error), batches };
      }
    }
    return { cursor: (await this.options.store.getCursor(sourceId)) ?? cursor, error: 'READ_BATCH_LIMIT', batches };
  }

  private async reconcile(
    transport: Transport,
    task: TaskRegistration,
    sourceId: string,
    observed: TaskObservation['sources'][number] | undefined,
  ): Promise<CursorState | null> {
    const current = await this.options.store.getCursor(sourceId);
    if (!current) return null;
    const registration = await transport.createRegistrationReference(task.taskId);
    let candidateScan: CandidateScan = { status: 'inconclusive', ranges: [] };
    try {
      const scan = await transport.scanArchiveCandidates(sourceId, registration, sampleAnchors(current), this.abort.signal);
      candidateScan = {
        status: scan.status,
        ranges: scan.candidates.map((candidate) => ({ startOffset: candidate.startOffset, endOffset: candidate.endOffset })),
      };
    } catch {
      // Archive discovery is deliberately not expanded here. An inconclusive
      // scan still permits a stable replacement to be sealed with an explicit
      // unknown gap when old bytes cannot be recovered.
    }
    const stable = observed && observed.fileIdentity && observed.eofBytes !== null && observed.observedAt
      ? sourceObservation({ ...({ sources: [observed] } as TaskObservation), taskId: task.taskId, hostId: task.hostId, observedAt: observed.observedAt, freshness: 'fresh', scanComplete: true, processScanError: null, phase: null, processes: [], errorCode: null }, sourceId, observed.eofBytes)
      : null;
    const decision: Awaited<ReturnType<StoreClient['reconcileSource']>> = await this.options.store.reconcileSource({
      sourceId,
      expected: { generation: current.generation, revision: current.revision, committedOffset: current.committedOffset },
      candidateScan,
      newFile: stable ? { status: 'stable', observation: stable } : { status: 'unconfirmed' },
      observedAt: iso(this.options.clock()),
    });
    if (decision.kind === 'seal') return decision.newCursor;
    return null;
  }

  private async publishCommittedLogs(sourceId: string, events: LogEvent[]): Promise<void> {
    if (this.stopped) return;
    const hasListeners = this.listeners.size > 0;
    let seen = this.publishedLogSignatures.get(sourceId);
    if (!this.seededLogSources.has(sourceId)) {
      const page = await this.options.store.getLogs({
        requestId: 'collector-seed-' + sourceId + '-' + randomUUID(),
        sourceId,
        before: null,
        limit: PAGE_EVENT_LIMIT,
      });
      const currentIds = new Set(events.map((event) => event.eventId));
      seen = new Map(page.events
        .filter((event) => !hasListeners || !currentIds.has(event.eventId))
        .map((event) => [event.eventId, eventSignature(event)]));
      this.publishedLogSignatures.set(sourceId, seen);
      this.seededLogSources.add(sourceId);
    }
    if (!seen) seen = new Map();
    const changed: LogEvent[] = [];
    for (const event of events) {
      const signature = eventSignature(event);
      if (seen.get(event.eventId) === signature) continue;
      seen.set(event.eventId, signature);
      changed.push(event);
    }
    const batch = boundedLogBatch(changed);
    if (batch.length === 0 || !hasListeners) return;
    const update: MonitorUpdate = { kind: 'logs', sourceId, events: structuredClone(batch) };
    for (const listener of [...this.listeners]) listener(structuredClone(update));
  }

  private async latestOutputSample(task: TaskRegistration, taskObservation: TaskObservation): Promise<Record<string, TrainerOutputObservation>> {
    const source = task.sources.find((item) => item.kind === 'log');
    if (!source) return {};
    const observed = taskObservation.sources.find((item) => item.sourceId === source.sourceId);
    const cursor = await this.options.store.getCursor(source.sourceId);
    if (!observed?.fileIdentity || !observed.observedAt || !cursor) return {};
    const page = await this.options.store.getLogs({ requestId: `collector-sample-${task.taskId}-${randomUUID()}`, sourceId: source.sourceId, before: null, limit: PAGE_SIZE });
    // Diagnostic lines may follow a valid progress record. Use a recent record
    // from this file generation; keep the process/file/offset checks downstream.
    const event = [...page.events].reverse().find((item) =>
      item.generation === cursor.generation &&
      item.recordComplete === true && item.text && !item.displayTruncated &&
      item.startOffset !== null && item.endOffset !== null &&
      isTimestampValid(item.ingestedAt, this.options.clock()) &&
      parseRegisteredRecord(task, item.text, source.sourceId).isTrainingOutput);
    if (!event) return {};
    const terminatorBytes = Number(BigInt(event.endOffset!) - BigInt(event.startOffset!)) -
      Buffer.byteLength(event.text!, 'utf8');
    if (!Number.isInteger(terminatorBytes) || terminatorBytes < 0 || terminatorBytes > 2) return {};
    return {
      [source.sourceId]: {
        sourceId: source.sourceId,
        generation: cursor.generation,
        fileIdentity: { ...observed.fileIdentity },
        startOffset: event.startOffset!,
        endOffset: event.endOffset!,
        terminatorBytes: terminatorBytes as 0 | 1 | 2,
        observedAt: observed.observedAt,
        text: event.text!,
      },
    };
  }

  private storeSnapshotFor(projected: TaskSnapshot, task: TaskRegistration): TaskSnapshot {
    this.previousTasks.set(task.taskId, projected);
    return projected;
  }

  private async save(
    task: TaskRegistration,
    hostKind: HostRegistration['target']['kind'],
    hostObservation: HostObservation,
    taskObservation: TaskObservation,
    taskSnapshot: TaskSnapshot,
    sourceGenerations: Record<string, string>,
    sourceStates: PersistedObservation['sourceStates'],
  ): Promise<void> {
    await this.options.store.saveObservation({
      task,
      hostObservation,
      taskObservation,
      observedAt: iso(this.options.clock()),
      sourceGenerations,
      sourceStates,
      taskSnapshot,
      hostKind,
    });
  }

  private snapshotWithHostStates(snapshot: MonitorSnapshot, registry: Registry): MonitorSnapshot {
    this.autoStart.synchronize(registry);
    const registrations = new Map(registry.hosts.map((host) => [host.hostId, host]));
    return {
      ...snapshot,
      tasks: snapshot.tasks.map(cached => {
        const task = { ...cached }; delete task.autoStart;
        const status = this.autoStart.getStatus(task.taskId);
        return status ? { ...task, autoStart: status } : task;
      }),
      hosts: snapshot.hosts.map((cached): HostSnapshot => {
        const registration = registrations.get(cached.hostId);
        if (!registration) return cached;
        const hostSnapshot = { ...cached };
        delete hostSnapshot.gpu;
        const lastSuccessAt = this.lastHostSuccessAt.get(cached.hostId) ?? cached.lastSuccessAt;
        const lastProbeDurationMs = this.lastHostProbeDurationMs.get(cached.hostId) ?? cached.lastProbeDurationMs;
        if (!registration.enabled) {
          return {
            ...hostSnapshot,
            connection: 'unobserved',
            observedAt: null,
            freshness: 'unobserved',
            lastSuccessAt,
            lastProbeDurationMs,
            scanComplete: false,
            errorCode: 'HOST_DISABLED',
          };
        }

        const observation = this.lastHostObservation.get(cached.hostId);
        if (!observation) {
          const wasConnected = cached.connection === 'connected';
          return {
            ...hostSnapshot,
            connection: wasConnected ? 'disconnected' : cached.connection,
            freshness: lastSuccessAt ? 'stale' : cached.freshness,
            lastSuccessAt,
            lastProbeDurationMs,
            scanComplete: wasConnected ? false : cached.scanComplete,
            errorCode: wasConnected ? cached.errorCode ?? 'CACHED_OFFLINE' : cached.errorCode,
          };
        }

        const connected = observation.connection === 'connected' && observation.freshness === 'fresh' &&
          observation.scanComplete && observation.errorCode === null;
        return {
          ...hostSnapshot,
          connection: connected ? 'connected' : observation.connection === 'connected' ? 'disconnected' : observation.connection,
          observedAt: observation.observedAt,
          freshness: connected ? 'fresh' : lastSuccessAt ? 'stale' : 'unobserved',
          lastSuccessAt,
          lastProbeDurationMs,
          scanComplete: observation.scanComplete,
          errorCode: observation.errorCode,
          ...(observation.gpu ? { gpu: structuredClone(observation.gpu) } : {}),
        };
      }),
    };
  }

  private async publishSnapshot(registry: Registry): Promise<void> {
    if (this.listeners.size === 0 || this.stopped) return;
    const snapshot = this.snapshotWithHostStates(projectRegistrySnapshot(await this.options.store.getSnapshot(), registry), registry);
    const update: MonitorUpdate = { kind: 'snapshot', snapshot };
    for (const listener of [...this.listeners]) listener(structuredClone(update));
  }
}

export function createProductionApi(options: ProductionMonitorOptions): ProductionMonitorApi {
  return new ProductionMonitor(options);
}
