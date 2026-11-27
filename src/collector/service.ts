import { cancelChangedServerWaits, flushPendingRemoteCancels, type PendingRemoteCancel } from '../launch/reconcile';
import { AutoStartController, launchConfigHash } from '../launch/controller';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ControlTaskRequest,
  ExportLogsQuery,
  ExportLogsResult,
  GpuSeriesQuery,
  GpuSeriesResponse,
  LogPage,
  LogQuery,
  LogSearchPage,
  LogSearchRequest,
  MetricSeriesQuery,
  MonitorApi,
  MonitorSnapshot,
  MonitorUpdate,
} from '../shared/api';
import type {
  AlertEvent,
  Checkpoint,
  CursorState,
  DiscoveredProcess,
  HostRegistration,
  HostSnapshot,
  JobControlAuditEntry,
  JobControlResult,
  LogEvent,
  LogSourceSnapshot,
  MetricSeriesResponse,
  Preferences,
  ProcessKey,
  Registry,
  ResourceMetric,
  SaveRegistryOptions,
  TaskRegistration,
  TaskSnapshot,
  WebhookChannelConfig,
} from '../shared/contracts';
import type { GpuSampleRow, HostSampleRow, MetricSampleRow, StoreClient } from '../store/protocol';
import type { PersistedObservation } from '../store/engine';
import type { HostGpuObservation, HostObservation, TaskObservation, TaskProcessObservation, Transport } from '../transport/types';
import type { CandidateScan, SourceObservation } from '../logs/types';
import type { BindingState, TrainerOutputObservation } from '../domain/bindings';
import { projectStatusRecord } from '../domain/status-record';
import { evaluateCheckpoint, type CheckpointRecord } from '../domain/checkpoints';
import { projectRegistrySnapshot } from '../shared/registry-snapshot';
import { PAGE_EVENT_LIMIT, PAGE_TEXT_BUDGET_BYTES } from '../shared/budgets';
import { createInitialBindingState, ingestCompleteRecord, interruptBindingObservation, isTimestampValid, updateBindings } from '../domain/bindings';
import { parseRegisteredRecord } from '../parsers/registered';
import { projectTask } from '../domain/lifecycle';
import { projectResources } from '../domain/resources';
import { areProcessKeysEqual, isRegisteredProcessEntry, isStrongProcessKey, makeRunId, processEntry } from '../domain/identity';
import { ingestStructuredBaselineRead } from '../domain/evidence';
import { validatePreferences, validateRegistry } from '../shared/validate';
import { nextBackoffMs } from './backoff';
import { CollectorScheduler } from './scheduler';
import { isRegisteredGpuProcess } from '../transport/gpu';
import { AlertEngine, sendTestWebhook } from './alerts';

type Scope = { hostId?: string; taskId?: string };
type MaybePromise<T> = T | Promise<T>;
type CommittedLogBatch = { ingestedAt: string; events: LogEvent[] };
type HostRetryState = { consecutiveFailures: number; backoffMs: number | null; nextRetryAtMs: number | null };
type BoundedSignatureCache = { generation: string | null; entries: Map<string, string> };

export interface ProductionMonitorOptions {
  store: StoreClient;
  registryProvider: () => Promise<Registry>;
  registrySaver?: (registry: Registry) => Promise<Registry>;
  transportProvider: (host: HostRegistration, registry: Registry) => MaybePromise<Transport>;
  clock: () => number;
  monotonicClock?: () => number;
  bindingStateProvider?: (taskId: string) => BindingState;
  preferencesProvider?: () => Promise<Preferences>;
  preferencesSaver?: (preferences: Preferences) => Promise<Preferences>;
  onAlert?: (alert: AlertEvent) => void | Promise<void>;
  auditJobControl?: (entry: JobControlAuditEntry) => void | Promise<void>;
}

export interface ProductionMonitorApi extends MonitorApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  setCollectionPaused(paused: boolean): void;
  /** Diagnostic helper for verifying host epoch rotation on reconnect/reboot. */
  getHostEpoch?(hostId: string): string | null;
}

const HOST_PROBE_INTERVAL_MS = 5_000;
const RETENTION_INTERVAL_MS = 5 * 60 * 1000;
const NORMAL_READ_BYTES = 256 * 1024;
const CATCH_UP_READ_BYTES = 1024 * 1024;
const PAGE_SIZE = 50;
const MAX_PUBLISHED_SIGNATURES_PER_SOURCE = 512;

function toPublicCheckpoint(record: CheckpointRecord): Checkpoint {
  const { fileIdentity: _fi, firstStableObservedAt: _fso, ...publicFields } = record;
  return publicFields;
}

function isTaskTrackedProcess(task: TaskRegistration, proc: TaskProcessObservation): boolean {
  return isStrongProcessKey(proc.key) && (isRegisteredGpuProcess(task, proc) || proc.treeMember === true);
}

function processCpuRssMetrics(
  task: TaskRegistration,
  observation: TaskObservation,
  now: string,
): ResourceMetric[] {
  if (observation.freshness !== 'fresh' || !observation.scanComplete || observation.processScanError !== null) {
    return [];
  }
  const tracked = observation.processes.filter((proc) => isTaskTrackedProcess(task, proc));
  if (tracked.length === 0) return [];
  const registeredKeys = tracked.map((proc) => proc.key);
  const samples: Parameters<typeof projectResources>[0] = [];
  for (const proc of tracked) {
    if (typeof proc.cpuPercent === 'number' && Number.isFinite(proc.cpuPercent) && proc.cpuPercent >= 0) {
      samples.push({
        source: 'proc',
        name: 'cpu_utilization',
        unit: 'percent_one_cpu',
        value: proc.cpuPercent,
        observedAt: proc.observedAt,
        scope: 'process',
        deviceId: null,
        processKey: proc.key,
        keyBeforeSample: proc.key,
        keyAfterSample: proc.key,
      });
    }
    if (typeof proc.rssBytes === 'number' && Number.isFinite(proc.rssBytes) && proc.rssBytes >= 0) {
      samples.push({
        source: 'proc',
        name: 'process_rss',
        unit: 'bytes',
        value: proc.rssBytes,
        observedAt: proc.observedAt,
        scope: 'process',
        deviceId: null,
        processKey: proc.key,
        keyBeforeSample: proc.key,
        keyAfterSample: proc.key,
      });
    }
  }
  if (samples.length === 0) return [];
  return projectResources(samples, { now, ttlMs: 15_000, registeredKeys });
}

function extractGpuSampleRows(hostId: string, gpu: HostGpuObservation | undefined): GpuSampleRow[] {
  if (!gpu || gpu.state !== 'available' || !gpu.observedAt) return [];
  if (gpu.devices && gpu.devices.length > 0) {
    return gpu.devices.map((device) => ({
      hostId,
      deviceId: device.deviceId,
      observedAt: gpu.observedAt!,
      utilPct: device.utilizationPct ?? null,
      memUsedMiB: device.memoryUsedMiB ?? null,
      memTotalMiB: device.memoryTotalMiB ?? null,
      tempC: device.temperatureC ?? null,
      powerW: device.powerDrawW ?? null,
    }));
  }
  const byDevice = new Map<string, GpuSampleRow>();
  for (const metric of gpu.metrics) {
    if (metric.scope !== 'device' || !metric.deviceId || metric.value === null) continue;
    let row = byDevice.get(metric.deviceId);
    if (!row) {
      row = {
        hostId,
        deviceId: metric.deviceId,
        observedAt: gpu.observedAt,
        utilPct: null,
        memUsedMiB: null,
        memTotalMiB: null,
        tempC: null,
        powerW: null,
      };
      byDevice.set(metric.deviceId, row);
    }
    if (metric.name === 'gpu_utilization') row.utilPct = metric.value;
    else if (metric.name === 'gpu_memory_used') row.memUsedMiB = metric.value / (1024 * 1024);
    else if (metric.name === 'gpu_memory_total') row.memTotalMiB = metric.value / (1024 * 1024);
  }
  return [...byDevice.values()];
}

function extractHostSampleRow(hostId: string, observation: HostObservation): HostSampleRow | null {
  const sys = observation.system;
  if (!sys || !sys.observedAt) return null;
  const toMiB = (bytes: string | null): number | null => {
    if (bytes === null || !/^\d+$/.test(bytes)) return null;
    return Number(bytes) / (1024 * 1024);
  };
  return {
    hostId,
    observedAt: sys.observedAt,
    cpuPct: sys.cpuUtilizationPct,
    ramUsedMiB: toMiB(sys.memoryUsedBytes),
    ramTotalMiB: toMiB(sys.memoryTotalBytes),
  };
}

function extractMetricSampleRows(snapshot: TaskSnapshot, observedAt: string): MetricSampleRow[] {
  const rows: MetricSampleRow[] = [];
  const runId = snapshot.currentRun?.runId ?? snapshot.progress.runId;
  const step = snapshot.progress.current ?? snapshot.progress.lastStepIndex ?? null;
  if (snapshot.progress.scalars) {
    for (const [metricName, value] of Object.entries(snapshot.progress.scalars)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        rows.push({ taskId: snapshot.taskId, runId, observedAt, step, metricName, value });
      }
    }
  }
  if (typeof snapshot.progress.iterationsPerSecond === 'number' && Number.isFinite(snapshot.progress.iterationsPerSecond)) {
    rows.push({
      taskId: snapshot.taskId,
      runId,
      observedAt,
      step,
      metricName: 'iterations_per_second',
      value: snapshot.progress.iterationsPerSecond,
    });
  }
  return rows;
}

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
  if (current.acceleratorAvailability === 'none' || current.gpu?.acceleratorAvailability === 'none') return current;
  const priorMetrics = previous?.gpu?.metrics ?? [];
  if (priorMetrics.length === 0) return current;
  return {
    ...current,
    gpu: {
      observedAt: previous?.gpu?.observedAt ?? null,
      state: 'unavailable',
      acceleratorAvailability: current.gpu?.acceleratorAvailability ?? 'unavailable',
      errorCode: current.gpu?.errorCode ?? 'GPU_SAMPLE_UNAVAILABLE',
      metrics: priorMetrics.map((metric) => ({ ...metric, freshness: 'stale' })),
    },
  };
}

function taskResources(
  gpu: HostGpuObservation | undefined,
  previous: TaskSnapshot | null,
  now: string,
  procMetrics?: ResourceMetric[],
): ResourceMetric[] {
  const processMetrics = procMetrics !== undefined
    ? [
      ...(previous?.resources.filter((metric) => processGpuMetric(metric)) ?? []),
      ...procMetrics,
    ]
    : (previous?.resources.filter((metric) => metric.scope === 'process') ?? []);
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
  if (gpu?.acceleratorAvailability === 'none') {
    return [...processMetrics];
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
  const keys = observation.processes.filter(process => isTaskTrackedProcess(task, process)).map(process => process.key);
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
    errorCode: observation.processGpu?.errorCode !== undefined
      ? observation.processGpu.errorCode
      : (complete ? 'PROCESS_GPU_UNAVAILABLE' : 'PROCESS_SCAN_INCOMPLETE'),
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
  private readonly previousCheckpoints = new Map<string, CheckpointRecord>();
  private readonly taskRegistrations = new Map<string, { signature: string; sourceIds: string[] }>();
  private readonly bindings = new Map<string, BindingState>();
  private readonly hostEpochs = new Map<string, string>();
  private readonly lastHostBootIds = new Map<string, string>();
  private readonly connectedHosts = new Set<string>();
  private readonly lastHostObservation = new Map<string, HostObservation>();
  private readonly lastHostSuccessAt = new Map<string, string>();
  private readonly lastHostProbeDurationMs = new Map<string, number>();
  private readonly lastHostAttemptAtMs = new Map<string, number>();
  private readonly hostTargets = new Map<string, string>();
  private readonly hostPollIntervals = new Map<string, number>();
  private readonly hostRetry = new Map<string, HostRetryState>();
  private readonly hostTails = new Map<string, Promise<void>>();
  private readonly inFlightHosts = new Set<string>();
  private readonly hostTransports = new Map<string, { targetKey: string; transport: Transport }>();
  private readonly lastTaskObservation = new Map<string, TaskObservation>();
  private readonly publishedLogSignatures = new Map<string, BoundedSignatureCache>();
  private readonly seededLogSources = new Set<string>();
  private pendingRemoteCancels: PendingRemoteCancel[] = [];
  private readonly abort = new AbortController();
  private registryTail: Promise<void> = Promise.resolve();
  private lastRetentionAtMs = 0;
  private started = false;
  private stopped = false;
  private collectionPaused = false;
  private preferences: Preferences = { theme: 'system' };

  private readonly autoStart: AutoStartController;
  private readonly alertEngine: AlertEngine;
  constructor(private readonly options: ProductionMonitorOptions) {
    this.autoStart = new AutoStartController({
      clock: options.clock,
      monotonicClock: options.monotonicClock,
      registryProvider: options.registryProvider,
      onChange: async () => this.publishSnapshot(await options.registryProvider()),
    });
    this.alertEngine = new AlertEngine({
      clock: options.clock,
      getPreferences: () => this.preferences.alerts,
      onAlert: (alert) => {
        if (!this.stopped) {
          const update: MonitorUpdate = { kind: 'alert', alert: structuredClone(alert) };
          for (const listener of [...this.listeners]) listener(structuredClone(update));
        }
        return this.options.onAlert?.(alert);
      },
    });
  }

  getHostEpoch(hostId: string): string | null {
    return this.hostEpochs.get(hostId) ?? null;
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
    for (const task of registry.tasks) {
      this.taskRegistrations.set(task.taskId, {
        signature: JSON.stringify(task),
        sourceIds: task.sources.map((s) => s.sourceId),
      });
    }
    if (this.options.preferencesProvider) this.preferences = await this.options.preferencesProvider();
    this.syncHostSchedules(registry);
    if (!this.collectionPaused) this.scheduler.start();
  }

  setCollectionPaused(paused: boolean): void {
    this.collectionPaused = paused;
    if (paused) this.scheduler.pause();
    else if (this.started && !this.stopped) this.scheduler.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.scheduler.stop();
    await Promise.allSettled([...this.hostTails.values(), this.registryTail, this.scheduler.waitIdle()]);
    const transports = [...this.hostTransports.values()];
    this.hostTransports.clear();
    await Promise.allSettled(transports.map((entry) => entry.transport.close?.()));
    await this.options.store.close().catch(() => undefined);
    this.listeners.clear();
    this.publishedLogSignatures.clear();
    this.seededLogSources.clear();
  }

  subscribe(listener: (update: MonitorUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Non-blocking snapshot read: returns persisted + in-memory state immediately with zero network wait,
   * and triggers asynchronous background refresh for any unobserved or stale enabled hosts.
   */
  async getSnapshot(): Promise<MonitorSnapshot> {
    if (this.stopped) throw new Error('MONITOR_STOPPED');
    const [snapshot, registry] = await Promise.all([
      this.options.store.getSnapshot(),
      this.options.registryProvider(),
    ]);
    this.syncRegisteredTasks(registry);
    this.syncRegisteredHosts(registry);
    this.syncHostSchedules(registry);

    const nowMs = this.options.clock();
    const staleHostIds: string[] = [];
    for (const host of registry.hosts) {
      if (!host.enabled || this.inFlightHosts.has(host.hostId)) continue;
      const retry = this.hostRetry.get(host.hostId);
      if (retry?.nextRetryAtMs !== null && retry?.nextRetryAtMs !== undefined && nowMs < retry.nextRetryAtMs) {
        continue;
      }
      const lastAttempt = this.lastHostAttemptAtMs.get(host.hostId);
      // Only trigger initial non-blocking probe on unobserved hosts; CollectorScheduler owns periodic polling.
      if (lastAttempt === undefined) {
        staleHostIds.push(host.hostId);
      }
    }

    if (staleHostIds.length > 0 && !this.stopped && !this.collectionPaused) {
      void this.refreshSelectedHosts(registry, staleHostIds, {}, false).catch(() => undefined);
    }

    return this.snapshotWithHostStates(projectRegistrySnapshot(snapshot, registry), registry);
  }

  async requestRefresh(scope: Scope): Promise<void> {
    if (this.stopped) throw new Error('MONITOR_STOPPED');
    const registry = await this.options.registryProvider();
    this.autoStart.synchronize(registry);
    this.syncRegisteredTasks(registry);
    this.syncRegisteredHosts(registry);
    this.syncHostSchedules(registry);

    const scopedTaskHostId = scope.taskId
      ? registry.tasks.find((task) => task.taskId === scope.taskId)?.hostId
      : undefined;
    const selectedHosts = registry.hosts.filter((host) => scope.hostId
      ? host.hostId === scope.hostId
      : scope.taskId ? host.hostId === scopedTaskHostId : true);

    // Manual refresh / "重试连接" immediately resets backoff for selected hosts.
    for (const host of selectedHosts) {
      this.resetHostBackoff(host.hostId);
    }

    await this.refreshSelectedHosts(registry, selectedHosts.map((h) => h.hostId), scope, true);
  }

  getLogs(query: LogQuery): Promise<LogPage> { return this.options.store.getLogs(query); }
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage> { return this.options.store.searchLogs(query); }
  cancelRequest(requestId: string): Promise<void> { return this.options.store.cancelRequest(requestId); }

  async getRegistry(): Promise<Registry> {
    return structuredClone(await this.options.registryProvider());
  }

  async saveRegistry(registry: Registry, options?: SaveRegistryOptions): Promise<Registry> {
    if (!this.options.registrySaver) throw new Error('REGISTRY_SAVE_UNAVAILABLE');
    const validated = validateRegistry(registry);
    // Serialized only against other registry saves — never blocked by an offline host!
    const run = this.registryTail.catch(() => undefined).then(async () => {
      if (this.stopped) throw new Error('MONITOR_STOPPED');
      const current = await this.options.registryProvider();
      if (validated.revision !== current.revision) throw new Error('REVISION_CONFLICT');
      await cancelChangedServerWaits(current, validated, this.options.transportProvider, this.abort.signal, {
        forceLocal: options?.forceLocal === true,
        now: this.options.clock,
        onPendingCancel: async (pending) => {
          if (this.options.store.enqueueRemoteCancel) {
            await this.options.store.enqueueRemoteCancel(pending);
            return;
          }
          this.pendingRemoteCancels = [
            ...this.pendingRemoteCancels.filter((p) => !(p.hostId === pending.hostId && p.taskId === pending.taskId && p.armId === pending.armId)),
            pending,
          ];
        },
      });
      const saved = await this.options.registrySaver!(validated);
      this.autoStart.synchronize(saved);
      this.syncRegisteredTasks(saved);
      this.syncRegisteredHosts(saved);
      this.syncHostSchedules(saved);
      await this.options.store.purgeOrphans?.(
        saved.hosts.map((h) => h.hostId),
        saved.tasks.map((t) => t.taskId),
      ).catch(() => undefined);
      await this.publishSnapshot(saved);
      const enabledIds = saved.hosts.filter((h) => h.enabled).map((h) => h.hostId);
      if (enabledIds.length > 0 && !this.stopped && !this.collectionPaused) {
        void this.refreshSelectedHosts(saved, enabledIds, {}, false).catch(() => undefined);
      }
      return structuredClone(saved);
    });
    this.registryTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async getMetricSeries(query: MetricSeriesQuery): Promise<MetricSeriesResponse> {
    if (this.stopped) throw new Error('MONITOR_STOPPED');
    if (this.options.store.getMetricSeries) {
      return this.options.store.getMetricSeries(query);
    }
    return { taskId: query.taskId, series: {} };
  }

  async getGpuSeries(query: GpuSeriesQuery): Promise<GpuSeriesResponse> {
    if (this.stopped) throw new Error('MONITOR_STOPPED');
    if (this.options.store.getGpuSeries) {
      return this.options.store.getGpuSeries(query);
    }
    return { hostId: query.hostId, gpu: [], host: [] };
  }

  async exportLogs(query: ExportLogsQuery): Promise<ExportLogsResult> {
    if (this.stopped) throw new Error('MONITOR_STOPPED');
    if (this.options.store.exportLogs) {
      return this.options.store.exportLogs(query);
    }
    return { exportedCount: 0, path: null };
  }

  async discoverProcesses(hostId: string): Promise<DiscoveredProcess[]> {
    if (this.stopped) throw new Error('MONITOR_STOPPED');
    const registry = await this.options.registryProvider();
    const host = registry.hosts.find((item) => item.hostId === hostId);
    if (!host) throw new Error('HOST_NOT_REGISTERED');
    if (!host.enabled) throw new Error('HOST_DISABLED');
    const transport = await this.getHostTransport(host, registry);
    if (!transport.discoverProcesses) return [];
    return transport.discoverProcesses(this.abort.signal);
  }

  async controlTask(request: ControlTaskRequest): Promise<JobControlResult> {
    if (this.stopped) throw new Error('MONITOR_STOPPED');
    const registry = await this.options.registryProvider();
    const task = registry.tasks.find((item) => item.taskId === request.taskId);
    if (!task) {
      return { ok: false, taskId: request.taskId, action: request.action, errorCode: 'TASK_NOT_REGISTERED', message: 'Task not found' };
    }
    const host = registry.hosts.find((item) => item.hostId === task.hostId);
    if (!host) {
      return { ok: false, taskId: request.taskId, action: request.action, errorCode: 'HOST_NOT_REGISTERED', message: 'Host not found' };
    }
    const timestamp = iso(this.options.clock());

    // Strict opt-in gate: remote job control MUST be explicitly enabled on the host!
    if (host.allowJobControl !== true) {
      await this.options.auditJobControl?.({
        timestamp,
        hostId: host.hostId,
        taskId: task.taskId,
        action: request.action,
        allowed: false,
        ok: false,
        pidsSignaled: [],
        errorCode: 'JOB_CONTROL_DISABLED',
        reason: 'Host allowJobControl is false',
      });
      return {
        ok: false,
        taskId: task.taskId,
        action: request.action,
        errorCode: 'JOB_CONTROL_DISABLED',
        message: 'Remote job control is disabled for this host (set allowJobControl=true to opt in)',
      };
    }

    if (typeof request.confirmToken !== 'string' || request.confirmToken.trim().length < 8) {
      await this.options.auditJobControl?.({
        timestamp,
        hostId: host.hostId,
        taskId: task.taskId,
        action: request.action,
        allowed: false,
        ok: false,
        pidsSignaled: [],
        errorCode: 'CONFIRMATION_REQUIRED',
        reason: 'Missing or invalid confirmToken',
      });
      return {
        ok: false,
        taskId: task.taskId,
        action: request.action,
        errorCode: 'CONFIRMATION_REQUIRED',
        message: 'Explicit confirmation token required for remote job control',
      };
    }

    const keys: ProcessKey[] = [];
    const seen = new Set<string>();
    const addKey = (key: ProcessKey | null | undefined) => {
      if (!key || !isStrongProcessKey(key)) return;
      const id = `${key.hostBootId}:${key.pid}:${key.startTicks}`;
      if (!seen.has(id)) {
        seen.add(id);
        keys.push(key);
      }
    };
    const lastObs = this.lastTaskObservation.get(task.taskId);
    if (lastObs) {
      for (const proc of lastObs.processes) {
        if (isTaskTrackedProcess(task, proc)) addKey(proc.key);
      }
    }
    const prevSnap = this.previousTasks.get(task.taskId);
    if (prevSnap) {
      addKey(prevSnap.currentRun?.mainProcessKey);
      addKey(prevSnap.processes.main?.key);
      for (const worker of prevSnap.processes.workers) addKey(worker.key);
    }

    try {
      const transport = await this.getHostTransport(host, registry);
      if (!transport.signalTask) {
        const res: JobControlResult = {
          ok: false,
          taskId: task.taskId,
          action: request.action,
          errorCode: 'JOB_CONTROL_UNSUPPORTED',
          message: 'Transport does not support signalTask',
        };
        await this.options.auditJobControl?.({
          timestamp,
          hostId: host.hostId,
          taskId: task.taskId,
          action: request.action,
          allowed: true,
          ok: false,
          pidsSignaled: [],
          errorCode: res.errorCode,
        });
        return res;
      }

      let finalResult: JobControlResult;
      if (request.action === 'restart' && (!host.enabled || !task.enabled || !task.autoStart?.enabled || !transport.launchTask)) {
        finalResult = {
          ok: false, taskId: task.taskId, action: request.action,
          errorCode: 'LAUNCH_SERVICE_UNAVAILABLE', message: 'Restart requires an enabled launch configuration.',
        };
      } else {
        finalResult = await transport.signalTask(task, request.action, keys, this.abort.signal);
      }
      if (request.action === 'restart' && finalResult.ok && transport.launchTask) {
        const signal = this.abort.signal;
        const deadline = performance.now() + 5_000;
        let stopped = false;
        do {
          const observation = await transport.probeTask(task, signal);
          stopped = observation.taskId === task.taskId && observation.hostId === task.hostId &&
            observation.freshness === 'fresh' && observation.scanComplete && observation.processScanError === null &&
            (observation.errorCode === null || observation.errorScope === 'source') &&
            !observation.processes.some((proc) =>
              keys.some((key) => areProcessKeysEqual(key, proc.key)) || isTaskTrackedProcess(task, proc));
          if (!stopped) await delay(150, undefined, { signal });
        } while (!stopped && performance.now() < deadline);
        if (!stopped) {
          finalResult = { ...finalResult, ok: false, errorCode: 'RESTART_STOP_UNCONFIRMED', message: 'Previous process exit could not be confirmed.' };
        } else {
          const armId = randomUUID();
          const configHash = createHash('sha256').update(launchConfigHash(host, task)).update(armId).digest('hex');
          const launched = await transport.launchTask(task, armId, configHash, signal, { restart: true });
          finalResult = {
            ...finalResult,
            ok: launched.status === 'started',
            pid: launched.pid,
            errorCode: launched.status === 'started' ? null : (launched.errorCode ?? 'RESTART_LAUNCH_FAILED'),
            message: launched.status === 'started' ? 'Restarted training process' : `Relaunch status=${launched.status}`,
          };
        }
      }
      await this.options.auditJobControl?.({
        timestamp,
        hostId: host.hostId,
        taskId: task.taskId,
        action: request.action,
        allowed: true,
        ok: finalResult.ok,
        pidsSignaled: finalResult.pidsSignaled ?? [],
        errorCode: finalResult.errorCode,
      });
      return finalResult;
    } catch (error) {
      const code = errorCode(error);
      await this.options.auditJobControl?.({
        timestamp,
        hostId: host.hostId,
        taskId: task.taskId,
        action: request.action,
        allowed: true,
        ok: false,
        pidsSignaled: [],
        errorCode: code,
      });
      return {
        ok: false,
        taskId: task.taskId,
        action: request.action,
        errorCode: code,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async testWebhook(webhook: WebhookChannelConfig): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
    return sendTestWebhook(webhook, this.options.clock());
  }

  async getPreferences(): Promise<Preferences> {
    return structuredClone(await this.options.preferencesProvider?.() ?? this.preferences);
  }

  async savePreferences(value: Preferences): Promise<Preferences> {
    const validated = validatePreferences(value);
    this.preferences = this.options.preferencesSaver
      ? await this.options.preferencesSaver(validated)
      : structuredClone(validated);
    return structuredClone(this.preferences);
  }

  async copyRegisteredPath(): Promise<void> {
    // Desktop IPC owns clipboard access. The monitor API deliberately does not
    // inspect or mutate the registered remote path.
  }

  private resetHostBackoff(hostId: string): void {
    this.hostRetry.delete(hostId);
  }

  private recordHostFailure(hostId: string): void {
    const prev = this.hostRetry.get(hostId) ?? { consecutiveFailures: 0, backoffMs: null, nextRetryAtMs: null };
    const backoffMs = nextBackoffMs(prev.backoffMs);
    this.hostRetry.set(hostId, {
      consecutiveFailures: prev.consecutiveFailures + 1,
      backoffMs,
      nextRetryAtMs: this.options.clock() + backoffMs,
    });
  }

  private syncHostSchedules(registry: Registry): void {
    const activeIds = new Set<string>();
    for (const host of registry.hosts) {
      if (!host.enabled) {
        this.scheduler.unscheduleHost(host.hostId);
        this.hostPollIntervals.delete(host.hostId);
        continue;
      }
      activeIds.add(host.hostId);
      const delay = host.pollIntervalMs ?? HOST_PROBE_INTERVAL_MS;
      const existingDelay = this.hostPollIntervals.get(host.hostId);
      if (existingDelay !== delay || !this.scheduler.hasHost(host.hostId)) {
        this.scheduler.unscheduleHost(host.hostId);
        this.hostPollIntervals.set(host.hostId, delay);
        this.scheduler.schedule(delay, host.hostId, () => this.runScheduledHostTick(host.hostId));
      }
    }
    for (const hostId of [...this.hostPollIntervals.keys()]) {
      if (!activeIds.has(hostId)) {
        this.scheduler.unscheduleHost(hostId);
        this.hostPollIntervals.delete(hostId);
      }
    }
  }

  private async runScheduledHostTick(hostId: string): Promise<void> {
    if (this.stopped || this.collectionPaused) return;
    const retry = this.hostRetry.get(hostId);
    if (retry?.nextRetryAtMs !== null && retry?.nextRetryAtMs !== undefined && this.options.clock() < retry.nextRetryAtMs) {
      return;
    }
    const registry = await this.options.registryProvider();
    this.autoStart.synchronize(registry);
    this.syncRegisteredTasks(registry);
    this.syncRegisteredHosts(registry);
    const host = registry.hosts.find((item) => item.hostId === hostId);
    if (!host || !host.enabled) return;
    await this.enqueueHostWork(host.hostId, async () => {
      if (this.stopped || this.collectionPaused) return;
      const latestRegistry = await this.options.registryProvider();
      const latestHost = latestRegistry.hosts.find((item) => item.hostId === hostId);
      if (!latestHost || !latestHost.enabled) return;
      const tasks = latestRegistry.tasks.filter((task) => task.enabled && task.hostId === hostId);
      await this.refreshHost(latestHost, tasks, latestRegistry);
      await this.publishSnapshot(latestRegistry);
    });
  }

  private enqueueHostWork(hostId: string, work: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const previous = this.hostTails.get(hostId) ?? Promise.resolve();
    const current: Promise<void> = previous.catch(() => undefined).then(async () => {
      this.inFlightHosts.add(hostId);
      try {
        await work();
      } catch {
        // Host-level errors are isolated per host and never break sibling hosts.
      } finally {
        this.inFlightHosts.delete(hostId);
        if (this.hostTails.get(hostId) === current) this.hostTails.delete(hostId);
      }
    });
    this.hostTails.set(hostId, current);
    return current;
  }

  private async refreshSelectedHosts(
    registry: Registry,
    hostIds: string[],
    scope: Scope,
    publishAtEnd: boolean,
  ): Promise<void> {
    const selected = registry.hosts.filter((host) => hostIds.includes(host.hostId));
    // All hosts execute independently in parallel!
    await Promise.allSettled(selected.map(async (host) => {
      if (this.abort.signal.aborted || !host.enabled) return;
      const tasks = registry.tasks.filter((task) =>
        task.enabled && task.hostId === host.hostId && (!scope.taskId || task.taskId === scope.taskId),
      );
      await this.enqueueHostWork(host.hostId, async () => {
        if (this.abort.signal.aborted || this.stopped) return;
        await this.refreshHost(host, tasks, registry);
        await this.publishSnapshot(registry);
      });
    }));
    if (publishAtEnd && !this.stopped) {
      await this.publishSnapshot(registry);
    }
  }

  private async getHostTransport(host: HostRegistration, registry: Registry): Promise<Transport> {
    const targetKey = JSON.stringify(host.target);
    const cached = this.hostTransports.get(host.hostId);
    if (cached && cached.targetKey === targetKey) {
      return cached.transport;
    }
    if (cached) {
      this.hostTransports.delete(host.hostId);
      void cached.transport.close?.().catch(() => undefined);
    }
    const transport = await this.options.transportProvider(host, registry);
    this.hostTransports.set(host.hostId, { targetKey, transport });
    return transport;
  }

  private releaseSourceSignatures(sourceIds: string[]): void {
    for (const sourceId of sourceIds) {
      this.publishedLogSignatures.delete(sourceId);
      this.seededLogSources.delete(sourceId);
    }
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
        this.lastHostAttemptAtMs.delete(hostId);
        this.connectedHosts.delete(hostId);
        this.hostEpochs.delete(hostId);
        this.lastHostBootIds.delete(hostId);
        this.hostRetry.delete(hostId);
        const cachedTransport = this.hostTransports.get(hostId);
        if (cachedTransport) {
          this.hostTransports.delete(hostId);
          void cachedTransport.transport.close?.().catch(() => undefined);
        }
        continue;
      }
      if (previousTarget !== JSON.stringify(host.target)) {
        this.lastHostObservation.delete(hostId);
        this.lastHostSuccessAt.delete(hostId);
        this.lastHostProbeDurationMs.delete(hostId);
        this.lastHostAttemptAtMs.delete(hostId);
        this.connectedHosts.delete(hostId);
        this.hostEpochs.delete(hostId);
        this.lastHostBootIds.delete(hostId);
        this.hostRetry.delete(hostId);
        const cachedTransport = this.hostTransports.get(hostId);
        if (cachedTransport) {
          this.hostTransports.delete(hostId);
          void cachedTransport.transport.close?.().catch(() => undefined);
        }
        for (const task of this.previousTasks.values()) {
          if (task.hostId === hostId) {
            this.previousTasks.delete(task.taskId);
            this.previousCheckpoints.delete(task.taskId);
            this.bindings.delete(task.taskId);
            this.lastTaskObservation.delete(task.taskId);
            this.alertEngine.clearTask(task.taskId);
            const meta = this.taskRegistrations.get(task.taskId);
            if (meta) this.releaseSourceSignatures(meta.sourceIds);
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
        this.hostRetry.delete(host.hostId);
        const cachedTransport = this.hostTransports.get(host.hostId);
        if (cachedTransport) {
          this.hostTransports.delete(host.hostId);
          void cachedTransport.transport.close?.().catch(() => undefined);
        }
      } else if (this.lastHostObservation.get(host.hostId)?.errorCode === 'HOST_DISABLED') {
        this.lastHostObservation.delete(host.hostId);
      }
    }
  }

  private syncRegisteredTasks(registry: Registry): void {
    const current = new Map(registry.tasks.map((task) => [task.taskId, task]));
    for (const [taskId, meta] of this.taskRegistrations) {
      const task = current.get(taskId);
      if (!task || JSON.stringify(task) !== meta.signature) {
        this.taskRegistrations.delete(taskId);
        this.previousTasks.delete(taskId);
        this.previousCheckpoints.delete(taskId);
        this.bindings.delete(taskId);
        this.lastTaskObservation.delete(taskId);
        this.alertEngine.clearTask(taskId);
        this.releaseSourceSignatures(meta.sourceIds);
      }
    }
    for (const task of registry.tasks) {
      const signature = JSON.stringify(task);
      if (!this.taskRegistrations.has(task.taskId)) {
        this.taskRegistrations.set(task.taskId, {
          signature,
          sourceIds: task.sources.map((s) => s.sourceId),
        });
      }
    }
  }

  private async refreshHost(host: HostRegistration, tasks: TaskRegistration[], registry: Registry): Promise<void> {
    let transport: Transport | null = null;
    let hostObservation: HostObservation;
    let batchTaskObservations: Map<string, TaskObservation> | null = null;
    const probeStartedAt = this.options.clock();
    this.lastHostAttemptAtMs.set(host.hostId, probeStartedAt);
    const previousHost = this.lastHostObservation.get(host.hostId);

    try {
      transport = await this.getHostTransport(host, registry);
      if (transport.probeHostAndTasks) {
        const batch = await transport.probeHostAndTasks(tasks, this.abort.signal);
        hostObservation = retainStaleGpu(batch.host, previousHost);
        batchTaskObservations = batch.tasks;
      } else {
        hostObservation = retainStaleGpu(await transport.probeHost(this.abort.signal), previousHost);
      }
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
      this.recordHostFailure(host.hostId);
      this.lastHostObservation.set(host.hostId, disconnected);
      const hostSnap = this.buildHostSnapshot(host, disconnected);
      await this.options.store.saveHostSnapshot?.(hostSnap).catch(() => undefined);
      this.alertEngine.inspectHostSnapshot(hostSnap);
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

    // Rotate host epoch BEFORE marking host as connected, and detect boot_id changes!
    this.ensureHostEpoch(host.hostId, hostObservation);
    this.connectedHosts.add(host.hostId);
    if (hostObservation.hostBootId) {
      this.lastHostBootIds.set(host.hostId, hostObservation.hostBootId);
    }
    this.resetHostBackoff(host.hostId);
    this.lastHostObservation.set(host.hostId, hostObservation);
    if (hostObservation.observedAt) this.lastHostSuccessAt.set(host.hostId, hostObservation.observedAt);

    // Persist 0-task (and all) host snapshots + GPU/host time series!
    const hostSnap = this.buildHostSnapshot(host, hostObservation);
    await this.options.store.saveHostSnapshot?.(hostSnap).catch(() => undefined);
    this.alertEngine.inspectHostSnapshot(hostSnap);
    const gpuRows = extractGpuSampleRows(host.hostId, hostObservation.gpu);
    if (gpuRows.length > 0) {
      await this.options.store.saveGpuSamples?.(gpuRows).catch(() => undefined);
    }
    const hostRow = extractHostSampleRow(host.hostId, hostObservation);
    if (hostRow) {
      await this.options.store.saveHostSamples?.([hostRow]).catch(() => undefined);
    }

    // Flush any queued forceLocal server-wait cancellations on reconnect!
    if (transport) {
      const pending = await this.options.store.getPendingRemoteCancels?.(host.hostId) ?? this.pendingRemoteCancels;
      const { flushed } = await flushPendingRemoteCancels(host.hostId, transport, pending, this.abort.signal);
      for (const item of flushed) await this.options.store.deleteRemoteCancel?.(item);
      this.pendingRemoteCancels = this.pendingRemoteCancels.filter((item) => !flushed.includes(item));
    }

    for (const task of tasks) {
      if (this.abort.signal.aborted) return;
      if (!transport) return;
      const taskObservation = batchTaskObservations?.get(task.taskId)
        ?? await transport.probeTask(task, this.abort.signal);
      this.lastTaskObservation.set(task.taskId, taskObservation);
      await this.collectTask(transport, task, host.target.kind, hostObservation, taskObservation);
      await this.autoStart.evaluate(host, task, hostObservation, transport, this.abort.signal);
    }
    const nowMs = this.options.clock();
    this.lastHostAttemptAtMs.set(host.hostId, nowMs);
    if (nowMs - this.lastRetentionAtMs >= RETENTION_INTERVAL_MS) {
      this.lastRetentionAtMs = nowMs;
      void this.options.store.retain(iso(nowMs)).catch(() => undefined);
    }
  }

  private buildHostSnapshot(host: HostRegistration, observation: HostObservation): HostSnapshot {
    const connected = observation.connection === 'connected' && observation.freshness === 'fresh' &&
      observation.scanComplete && observation.errorCode === null;
    const lastSuccessAt = this.lastHostSuccessAt.get(host.hostId) ?? null;
    const lastProbeDurationMs = this.lastHostProbeDurationMs.get(host.hostId) ?? null;
    const retry = this.hostRetry.get(host.hostId);
    const retryFields = retry && retry.consecutiveFailures > 0
      ? {
        consecutiveFailures: retry.consecutiveFailures,
        nextRetryAt: retry.nextRetryAtMs !== null ? iso(retry.nextRetryAtMs) : null,
      }
      : {};
    return {
      version: 1,
      hostId: host.hostId,
      kind: host.target.kind,
      connection: connected ? 'connected' : observation.connection === 'connected' ? 'disconnected' : observation.connection,
      observedAt: observation.observedAt,
      freshness: connected ? 'fresh' : lastSuccessAt ? 'stale' : 'unobserved',
      lastSuccessAt,
      lastProbeDurationMs,
      scanComplete: observation.scanComplete,
      errorCode: observation.errorCode,
      ...retryFields,
      ...(observation.acceleratorAvailability ? { acceleratorAvailability: observation.acceleratorAvailability } : {}),
      ...(observation.gpu ? { gpu: structuredClone(observation.gpu) } : {}),
      ...(observation.system ? { system: structuredClone(observation.system) } : {}),
    };
  }

  private initialBinding(taskId: string): BindingState {
    return this.options.bindingStateProvider?.(taskId) ?? createInitialBindingState();
  }

  private ensureHostEpoch(hostId: string, observation: HostObservation): void {
    const prior = this.hostEpochs.get(hostId);
    const reconnect = !this.connectedHosts.has(hostId);
    const previousBootId = this.lastHostBootIds.get(hostId);
    const rebooted = Boolean(previousBootId && observation.hostBootId && previousBootId !== observation.hostBootId);
    if (!prior || reconnect || rebooted) {
      this.hostEpochs.set(hostId, randomUUID());
    }
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
    const newlyCommittedEvents: LogEvent[] = [];
    for (const source of logSources) {
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

      bindingState = await this.applyBindings(task, taskObservation, bindingState, observedAt);
      const result = await this.refreshSource(transport, task, source.sourceId, taskObservation, cursor);
      cursor = result.cursor;
      const sourceEvents = result.batches.flatMap((batch) => batch.events);
      if (sourceEvents.length > 0) newlyCommittedEvents.push(...sourceEvents);
      await this.publishCommittedLogs(source.sourceId, cursor.generation, sourceEvents);
      sourceGenerations[source.sourceId] = cursor.generation;
      sourceStates[source.sourceId] = {
        observedAt,
        freshness: taskObservation.freshness,
        state: result.error ? sourceState(result.error) : 'ready',
        errorCode: result.error,
      };
      for (const batch of result.batches) {
        bindingState = await this.applyBindings(task, taskObservation, bindingState, batch.ingestedAt, batch.events);
        for (const event of batch.events) {
          bindingState = ingestCompleteRecord(event, bindingState).state;
        }
      }
      this.bindings.set(task.taskId, bindingState);
    }

    if (newlyCommittedEvents.length > 0) {
      this.alertEngine.inspectLogEvents(task.hostId, task.taskId, newlyCommittedEvents);
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
    const { outputSamples, tailLogLines } = await this.sampleLogOutputs(task, taskObservation, newlyCommittedEvents, bindingState.completeRecords);
    observedAt = iso(this.options.clock());

    // Evaluate directory/file-level checkpoint scan when present
    let checkpoint: Checkpoint | undefined;
    if (taskObservation.checkpointScan) {
      const scan = taskObservation.checkpointScan;
      const latest = scan.latest;
      const record = evaluateCheckpoint(
        this.previousCheckpoints.get(task.taskId) ?? null,
        {
          path: latest?.path ?? null,
          name: latest?.name ?? null,
          isDirectory: latest?.isDirectory ?? false,
          fileCount: latest?.fileCount ?? null,
          sizeBytes: latest?.sizeBytes ?? null,
          mtime: latest?.mtime ?? null,
          fileIdentity: latest?.fileIdentity ?? null,
          fileStepIndex: latest?.fileStepIndex ?? null,
          stepSource: latest?.stepSource ?? null,
          metadata: latest?.metadata ?? null,
          scanComplete: scan.scanComplete,
        },
        observedAt,
      );
      this.previousCheckpoints.set(task.taskId, record);
      checkpoint = toPublicCheckpoint(record);
    }

    const autoStartStatus = this.autoStart.getStatus(task.taskId);
    const managedExitCode = typeof autoStartStatus?.exitCode === 'number' ? autoStartStatus.exitCode : undefined;
    const logOnlyActive = task.attributionMode === 'log_only' &&
      (newlyCommittedEvents.length > 0 || Object.keys(outputSamples).length > 0);
    const procMetrics = processCpuRssMetrics(task, taskObservation, observedAt);

    let projected = projectTask(prior, {
      task,
      taskObservation,
      hostObservation,
      observedAt,
      bindingState,
      outputSamples,
      checkpoint,
      tailLogLines: tailLogLines.length > 0 ? tailLogLines : undefined,
      managedExitCode,
      logOnlyActive,
      resources: taskResources(hostObservation.gpu, prior, observedAt, procMetrics),
    });
    projected = retainObservedRun(projected, task, taskObservation);
    projected = projectStatusRecord(projected, task, hostObservation, taskObservation, prior);
    projected = withTaskGpu(projected, prior, task, taskObservation, observedAt);
    const snapshot = this.storeSnapshotFor(projected, task);
    await this.save(task, hostKind, hostObservation, taskObservation, snapshot, sourceGenerations, sourceStates);
    const metricRows = extractMetricSampleRows(snapshot, observedAt);
    if (metricRows.length > 0) {
      await this.options.store.saveMetricSamples?.(metricRows).catch(() => undefined);
    }
    this.alertEngine.inspectTaskSnapshot(prior, snapshot, tailLogLines.length > 0 ? tailLogLines : undefined);
  }

  private async applyBindings(
    task: TaskRegistration,
    taskObservation: TaskObservation,
    state: BindingState,
    observedAt: string,
    committedEvents: LogEvent[] = [],
  ): Promise<BindingState> {
    const sourceInfo: Record<string, { generation: string; eofBytes: string; fileIdentity: { dev: string; inode: string } | null; committedOffset: string }> = {};
    for (const source of taskObservation.sources) {
      const cursor = await this.options.store.getCursor(source.sourceId);
      if (!cursor) continue;
      sourceInfo[source.sourceId] = {
        generation: cursor.generation,
        committedOffset: cursor.committedOffset,
        eofBytes: source.eofBytes ?? cursor.committedOffset,
        fileIdentity: source.fileIdentity,
      };
    }
    const observerEpoch = this.hostEpochs.get(task.hostId);
    if (!observerEpoch) return state;
    const { outputSamples } = await this.sampleLogOutputs(task, taskObservation, committedEvents, state.completeRecords);
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
    const observed = taskObservation.sources.find((source) => source.sourceId === sourceId);
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
      // An inconclusive scan still permits sealing a stable replacement with an explicit unknown gap.
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
    if (decision.kind === 'seal') {
      // Release old generation signatures as soon as a generation is sealed.
      this.publishedLogSignatures.delete(sourceId);
      this.seededLogSources.delete(sourceId);
      return decision.newCursor;
    }
    return null;
  }

  private recordBoundedSignature(cache: BoundedSignatureCache, eventId: string, signature: string): void {
    if (cache.entries.has(eventId)) cache.entries.delete(eventId);
    cache.entries.set(eventId, signature);
    while (cache.entries.size > MAX_PUBLISHED_SIGNATURES_PER_SOURCE) {
      const oldest = cache.entries.keys().next().value;
      if (oldest === undefined) break;
      cache.entries.delete(oldest);
    }
  }

  private async publishCommittedLogs(sourceId: string, generation: string, events: LogEvent[]): Promise<void> {
    if (this.stopped) return;
    const hasListeners = this.listeners.size > 0;
    let cache = this.publishedLogSignatures.get(sourceId);
    if (cache && cache.generation !== generation) {
      // Generation rotated: release old generation memory immediately.
      cache = { generation, entries: new Map() };
      this.publishedLogSignatures.set(sourceId, cache);
      this.seededLogSources.delete(sourceId);
    }
    if (!this.seededLogSources.has(sourceId)) {
      const page = await this.options.store.getLogs({
        requestId: 'collector-seed-' + sourceId + '-' + randomUUID(),
        sourceId,
        before: null,
        limit: PAGE_EVENT_LIMIT,
      });
      const currentIds = new Set(events.map((event) => event.eventId));
      cache = { generation, entries: new Map() };
      for (const event of page.events) {
        if (event.generation !== generation) continue;
        if (hasListeners && currentIds.has(event.eventId)) continue;
        this.recordBoundedSignature(cache, event.eventId, eventSignature(event));
      }
      this.publishedLogSignatures.set(sourceId, cache);
      this.seededLogSources.add(sourceId);
    }
    if (!cache) {
      cache = { generation, entries: new Map() };
      this.publishedLogSignatures.set(sourceId, cache);
    }
    const changed: LogEvent[] = [];
    for (const event of events) {
      const signature = eventSignature(event);
      if (cache.entries.get(event.eventId) === signature) continue;
      this.recordBoundedSignature(cache, event.eventId, signature);
      changed.push(event);
    }
    const batch = boundedLogBatch(changed);
    if (batch.length === 0 || !hasListeners) return;
    const update: MonitorUpdate = { kind: 'logs', sourceId, events: structuredClone(batch) };
    for (const listener of [...this.listeners]) listener(structuredClone(update));
  }

  private async sampleLogOutputs(
    task: TaskRegistration,
    taskObservation: TaskObservation,
    committedEvents: LogEvent[] = [],
    retainedRecords: LogEvent[] = [],
  ): Promise<{ outputSamples: Record<string, TrainerOutputObservation>; tailLogLines: string[] }> {
    const logSources = task.sources.filter((item) => item.kind === 'log');
    const outputSamples: Record<string, TrainerOutputObservation> = {};
    const tailLogLines: string[] = [];

    for (const source of logSources) {
      const observed = taskObservation.sources.find((item) => item.sourceId === source.sourceId);
      const cursor = await this.options.store.getCursor(source.sourceId);
      if (!cursor) continue;
      const page = await this.options.store.getLogs({
        requestId: `collector-sample-${task.taskId}-${source.sourceId}-${randomUUID()}`,
        sourceId: source.sourceId,
        before: null,
        limit: PAGE_SIZE,
      });
      for (const item of page.events.slice(0, 30).reverse()) {
        if (item.text) tailLogLines.push(item.text);
      }
      if (!observed?.fileIdentity || !observed.observedAt) continue;
      const batchSamples = committedEvents.filter((item) => item.sourceId === source.sourceId).reverse();
      const history = retainedRecords.filter((item) => item.sourceId === source.sourceId).reverse();
      const event = [...batchSamples, ...page.events, ...history].find((item) =>
        item.generation === cursor.generation &&
        item.recordComplete === true && item.text && !item.displayTruncated && !item.prefixIncomplete && !item.reason &&
        item.startOffset !== null && item.endOffset !== null &&
        isTimestampValid(item.ingestedAt, this.options.clock()) &&
        parseRegisteredRecord(task, item.text, source.sourceId).isTrainingOutput);
      if (!event) continue;
      const rawByteLength = Buffer.byteLength(event.rawAnsi ?? event.text!, 'utf8');
      const terminatorBytes = Number(BigInt(event.endOffset!) - BigInt(event.frameStartOffset ?? event.startOffset!)) - rawByteLength;
      if (!Number.isInteger(terminatorBytes) || terminatorBytes < 0 || terminatorBytes > 2) continue;
      outputSamples[source.sourceId] = {
        sourceId: source.sourceId,
        generation: cursor.generation,
        fileIdentity: { ...observed.fileIdentity },
        startOffset: event.startOffset!,
        endOffset: event.endOffset!,
        frameStartOffset: event.frameStartOffset,
        rawAnsi: event.rawAnsi,
        terminatorBytes: terminatorBytes as 0 | 1 | 2,
        observedAt: observed.observedAt,
        text: event.text!,
      };
    }

    return { outputSamples, tailLogLines: tailLogLines.slice(-40) };
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
        delete hostSnapshot.system;
        delete hostSnapshot.nextRetryAt;
        delete hostSnapshot.consecutiveFailures;
        delete hostSnapshot.acceleratorAvailability;
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

        const retry = this.hostRetry.get(cached.hostId);
        const retryFields = retry && retry.consecutiveFailures > 0
          ? {
            consecutiveFailures: retry.consecutiveFailures,
            nextRetryAt: retry.nextRetryAtMs !== null ? iso(retry.nextRetryAtMs) : null,
          }
          : {};

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
            ...retryFields,
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
          ...retryFields,
          ...(observation.acceleratorAvailability ? { acceleratorAvailability: observation.acceleratorAvailability } : {}),
          ...(observation.gpu ? { gpu: structuredClone(observation.gpu) } : {}),
          ...(observation.system ? { system: structuredClone(observation.system) } : {}),
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
