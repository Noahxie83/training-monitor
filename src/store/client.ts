import type { PendingRemoteCancel } from '../launch/reconcile';
import { Worker } from 'node:worker_threads';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  GpuSampleRow,
  HostSampleRow,
  MetricSampleRow,
  StoreClient as StoreClientContract,
  StoreOperation,
  WorkerRequest,
  WorkerResponse,
  StoreDiagnostics,
} from './protocol';
import type {
  CursorState,
  HostSnapshot,
  MetricSeriesResponse,
} from '../shared/contracts';
import type {
  ExportLogsQuery,
  ExportLogsResult,
  GpuSeriesQuery,
  GpuSeriesResponse,
  LogPage,
  LogQuery,
  LogSearchPage,
  LogSearchRequest,
  MetricSeriesQuery,
  MonitorSnapshot,
} from '../shared/api';
import type { ArchiveReadEvidence, ReadReply, SourceObservation } from '../logs/types';
import type { CommitReadResult, ReconcileRequest } from './protocol';
import type { PersistedObservation } from './engine';

type ReadyMessage = { kind: 'ready'; runtime: { electron: string | null; node: string; sqlite: string } };
type MigratingMessage = { kind: 'migrating' };
type OpenOptions = { directory: string; now: () => number; maxRestarts?: number };
type InternalClient = StoreClientContract & {
  diagnostics(): Promise<StoreDiagnostics>;
  runtime: ReadyMessage['runtime'];
  crashCount?: () => number;
  forceTerminateWorkerForTest?: () => Promise<number>;
};
const READY_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_LIMIT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESTARTS = 5;

class StoreClientImpl implements InternalClient {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readyResolve!: (message: ReadyMessage) => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<ReadyMessage>;
  private renewReadyTimeout?: () => void;
  private closed = false;
  private terminalError: Error | null = null;
  private closing: Promise<void> | null = null;
  runtime: ReadyMessage['runtime'] = { electron: null, node: 'unknown', sqlite: 'unknown' };

  constructor(private readonly worker: Worker, private readonly clock: () => number, private readonly onUnexpectedExit?: (error: Error) => void) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    worker.on('message', (message: ReadyMessage | MigratingMessage | WorkerResponse) => {
      if ('kind' in message && message.kind === 'ready') { this.runtime = message.runtime; this.readyResolve(message); return; }
      if ('kind' in message && message.kind === 'migrating') { this.renewReadyTimeout?.(); return; }
      if (!('id' in message)) return;
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.ok) item.resolve(message.value);
      else item.reject(new Error(message.error));
    });
    worker.once('error', (error) => this.fail(error));
    worker.once('exit', (code) => {
      if (!this.closed && !this.closing) this.fail(new Error(`STORE_WORKER_EXIT_${code}`));
    });
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.readyReject(error);
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    this.onUnexpectedExit?.(error);
  }
  isFailed(): boolean { return this.terminalError !== null; }
  async terminateRaw(): Promise<number> { return this.worker.terminate(); }
  async start(): Promise<void> {
    const deadline = performance.now() + READY_TIMEOUT_LIMIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      this.renewReadyTimeout = () => {
        clearTimeout(timer);
        const remaining = Math.min(READY_TIMEOUT_MS, deadline - performance.now());
        if (remaining <= 0) reject(new Error('STORE_READY_TIMEOUT'));
        else timer = setTimeout(() => reject(new Error('STORE_READY_TIMEOUT')), remaining);
      };
      this.renewReadyTimeout();
    });
    try {
      await Promise.race([this.ready, timeout]);
    } finally {
      clearTimeout(timer);
      this.renewReadyTimeout = undefined;
    }
  }
  private async withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async call<T>(operation: StoreOperation): Promise<T> {
    if (this.closed || this.terminalError) throw this.terminalError ?? new Error('STORE_CLOSED');
    await this.ready;
    const id = ++this.sequence;
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage({ id, operation } satisfies WorkerRequest);
    return await response as T;
  }
  enqueueRemoteCancel(item: PendingRemoteCancel): Promise<void> { return this.call({ method: 'enqueueRemoteCancel', args: [item] }); }
  getPendingRemoteCancels(hostId: string): Promise<PendingRemoteCancel[]> { return this.call({ method: 'getPendingRemoteCancels', args: [hostId] }); }
  deleteRemoteCancel(item: PendingRemoteCancel): Promise<void> { return this.call({ method: 'deleteRemoteCancel', args: [item] }); }
  getCursor(sourceId: string): Promise<CursorState | null> { return this.call({ method: 'getCursor', args: [sourceId] }); }
  registerSource(sourceId: string, observation: SourceObservation, taskId: string): Promise<CursorState> { return this.call({ method: 'registerSource', args: [sourceId, observation, taskId] }); }
  saveObservation(observation: PersistedObservation): Promise<void> { return this.call({ method: 'saveObservation', args: [observation] }); }
  saveHostSnapshot(host: HostSnapshot): Promise<void> { return this.call({ method: 'saveHostSnapshot', args: [host] }); }
  saveMetricSamples(samples: MetricSampleRow[]): Promise<void> { return this.call({ method: 'saveMetricSamples', args: [samples] }); }
  saveGpuSamples(samples: GpuSampleRow[]): Promise<void> { return this.call({ method: 'saveGpuSamples', args: [samples] }); }
  saveHostSamples(samples: HostSampleRow[]): Promise<void> { return this.call({ method: 'saveHostSamples', args: [samples] }); }
  commitRead(input: Parameters<StoreClientContract['commitRead']>[0]): Promise<CommitReadResult['status']> { return this.call({ method: 'commitRead', args: [input] }); }
  commitReadWithReceipt(input: Parameters<StoreClientContract['commitReadWithReceipt']>[0]): Promise<CommitReadResult> { return this.call({ method: 'commitReadWithReceipt', args: [input] }); }
  commitArchiveRead(input: Parameters<StoreClientContract['commitArchiveRead']>[0]): Promise<'committed' | 'stale' | 'reconciling' | 'storage_error'> { return this.call({ method: 'commitArchiveRead', args: [input] }); }
  reconcileSource(input: ReconcileRequest): Promise<Awaited<ReturnType<StoreClientContract['reconcileSource']>>> { return this.call({ method: 'reconcileSource', args: [input] }); }
  getSnapshot(): Promise<MonitorSnapshot> { return this.call({ method: 'getSnapshot', args: [] }); }
  getLogs(query: LogQuery): Promise<LogPage> { return this.call({ method: 'getLogs', args: [query, new Date(this.clock()).toISOString()] }); }
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage> { return this.call({ method: 'searchLogs', args: [query, new Date(this.clock()).toISOString()] }); }
  getMetricSeries(query: MetricSeriesQuery): Promise<MetricSeriesResponse> { return this.call({ method: 'getMetricSeries', args: [query, new Date(this.clock()).toISOString()] }); }
  getGpuSeries(query: GpuSeriesQuery): Promise<GpuSeriesResponse> { return this.call({ method: 'getGpuSeries', args: [query, new Date(this.clock()).toISOString()] }); }
  exportLogs(query: ExportLogsQuery): Promise<ExportLogsResult> { return this.call({ method: 'exportLogs', args: [query, new Date(this.clock()).toISOString()] }); }
  purgeOrphans(activeHostIds: string[], activeTaskIds: string[]): Promise<void> { return this.call({ method: 'purgeOrphans', args: [activeHostIds, activeTaskIds] }); }
  cancelRequest(requestId: string): Promise<void> { return this.call({ method: 'cancelRequest', args: [requestId] }); }
  retain(now: string): Promise<{ pausedForDisk: boolean }> { return this.call({ method: 'retain', args: [now] }); }
  diagnostics(): Promise<StoreDiagnostics> { return this.call({ method: 'diagnostics', args: [] }); }
  async close(): Promise<void> {
    if (this.closed) {
      if (this.terminalError) throw this.terminalError;
      return;
    }
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try {
        if (this.terminalError) {
          throw this.terminalError;
        }
        await this.withTimeout(this.call({ method: 'close', args: [] }), CLOSE_TIMEOUT_MS, 'STORE_CLOSE_TIMEOUT');
      } finally {
        this.closed = true;
        for (const item of this.pending.values()) item.reject(this.terminalError ?? new Error('STORE_CLOSED'));
        this.pending.clear();
        await this.worker.terminate();
      }
    })();
    return this.closing;
  }
}

/**
 * Controlled auto-restarting wrapper around StoreClientImpl:
 * if the SQLite worker crashes unexpectedly, it automatically respawns a fresh worker
 * (up to `maxRestarts`) against the same durable WAL database instead of permanently
 * locking the app in a terminal error state.
 */
class RestartableStoreClient implements InternalClient {
  private current: StoreClientImpl;
  private restarting: Promise<StoreClientImpl> | null = null;
  private restarts = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly maxRestarts: number;
  runtime: ReadyMessage['runtime'];

  constructor(
    initial: StoreClientImpl,
    private readonly spawnFresh: () => Promise<StoreClientImpl>,
    maxRestarts = DEFAULT_MAX_RESTARTS,
  ) {
    this.current = initial;
    this.runtime = initial.runtime;
    this.maxRestarts = maxRestarts;
  }

  crashCount(): number { return this.restarts; }
  async forceTerminateWorkerForTest(): Promise<number> { return this.current.terminateRaw(); }

  private async ensureLive(): Promise<StoreClientImpl> {
    if (this.closed) throw new Error('STORE_CLOSED');
    if (!this.current.isFailed()) return this.current;
    if (this.restarting) return this.restarting;
    if (this.restarts >= this.maxRestarts) throw new Error('STORE_WORKER_RESTART_LIMIT');
    this.restarts += 1;
    this.restarting = (async () => {
      const next = await this.spawnFresh();
      this.current = next;
      this.runtime = next.runtime;
      return next;
    })();
    try {
      return await this.restarting;
    } finally {
      this.restarting = null;
    }
  }

  private async runWithRestart<T>(fn: (client: StoreClientImpl) => Promise<T>): Promise<T> {
    const client = await this.ensureLive();
    if (this.closed) throw new Error('STORE_CLOSED');
    try {
      return await fn(client);
    } catch (error) {
      if (!this.closed && client.isFailed() && this.restarts < this.maxRestarts) {
        const fresh = await this.ensureLive();
        if (this.closed) throw new Error('STORE_CLOSED');
        return await fn(fresh);
      }
      throw error;
    }
  }

  enqueueRemoteCancel(item: PendingRemoteCancel): Promise<void> { return this.runWithRestart((c) => c.enqueueRemoteCancel(item)); }
  getPendingRemoteCancels(hostId: string): Promise<PendingRemoteCancel[]> { return this.runWithRestart((c) => c.getPendingRemoteCancels(hostId)); }
  deleteRemoteCancel(item: PendingRemoteCancel): Promise<void> { return this.runWithRestart((c) => c.deleteRemoteCancel(item)); }
  getCursor(sourceId: string): Promise<CursorState | null> { return this.runWithRestart((c) => c.getCursor(sourceId)); }
  registerSource(sourceId: string, observation: SourceObservation, taskId: string): Promise<CursorState> { return this.runWithRestart((c) => c.registerSource(sourceId, observation, taskId)); }
  saveObservation(observation: PersistedObservation): Promise<void> { return this.runWithRestart((c) => c.saveObservation(observation)); }
  saveHostSnapshot(host: HostSnapshot): Promise<void> { return this.runWithRestart((c) => c.saveHostSnapshot(host)); }
  saveMetricSamples(samples: MetricSampleRow[]): Promise<void> { return this.runWithRestart((c) => c.saveMetricSamples(samples)); }
  saveGpuSamples(samples: GpuSampleRow[]): Promise<void> { return this.runWithRestart((c) => c.saveGpuSamples(samples)); }
  saveHostSamples(samples: HostSampleRow[]): Promise<void> { return this.runWithRestart((c) => c.saveHostSamples(samples)); }
  commitRead(input: Parameters<StoreClientContract['commitRead']>[0]): Promise<CommitReadResult['status']> { return this.runWithRestart((c) => c.commitRead(input)); }
  commitReadWithReceipt(input: Parameters<StoreClientContract['commitReadWithReceipt']>[0]): Promise<CommitReadResult> { return this.runWithRestart((c) => c.commitReadWithReceipt(input)); }
  commitArchiveRead(input: Parameters<StoreClientContract['commitArchiveRead']>[0]): Promise<'committed' | 'stale' | 'reconciling' | 'storage_error'> { return this.runWithRestart((c) => c.commitArchiveRead(input)); }
  reconcileSource(input: ReconcileRequest): Promise<Awaited<ReturnType<StoreClientContract['reconcileSource']>>> { return this.runWithRestart((c) => c.reconcileSource(input)); }
  getSnapshot(): Promise<MonitorSnapshot> { return this.runWithRestart((c) => c.getSnapshot()); }
  getLogs(query: LogQuery): Promise<LogPage> { return this.runWithRestart((c) => c.getLogs(query)); }
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage> { return this.runWithRestart((c) => c.searchLogs(query)); }
  getMetricSeries(query: MetricSeriesQuery): Promise<MetricSeriesResponse> { return this.runWithRestart((c) => c.getMetricSeries(query)); }
  getGpuSeries(query: GpuSeriesQuery): Promise<GpuSeriesResponse> { return this.runWithRestart((c) => c.getGpuSeries(query)); }
  exportLogs(query: ExportLogsQuery): Promise<ExportLogsResult> { return this.runWithRestart((c) => c.exportLogs(query)); }
  purgeOrphans(activeHostIds: string[], activeTaskIds: string[]): Promise<void> { return this.runWithRestart((c) => c.purgeOrphans(activeHostIds, activeTaskIds)); }
  cancelRequest(requestId: string): Promise<void> { return this.runWithRestart((c) => c.cancelRequest(requestId)); }
  retain(now: string): Promise<{ pausedForDisk: boolean }> { return this.runWithRestart((c) => c.retain(now)); }
  diagnostics(): Promise<StoreDiagnostics> { return this.runWithRestart((c) => c.diagnostics()); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.restarting?.catch(() => undefined);
      await this.current.close().catch(() => undefined);
    })();
    return this.closing;
  }
}

export async function connectStoreWorker(worker: Worker, clock: () => number): Promise<InternalClient> {
  const client = new StoreClientImpl(worker, clock);
  try { await client.start(); } catch (error) { await worker.terminate(); throw error; }
  return client;
}

async function spawnWorkerClient(options: OpenOptions, workerFile: string): Promise<StoreClientImpl> {
  if (typeof options.now !== 'function') throw new TypeError('INVALID_STORE_CLOCK');
  const directory = path.resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const openedAt = new Date(options.now()).toISOString();
  const worker = new Worker(workerFile, { workerData: { databasePath: path.join(directory, 'monitor.sqlite'), openedAt } });
  const client = new StoreClientImpl(worker, options.now);
  try { await client.start(); } catch (error) { await worker.terminate(); throw error; }
  return client;
}

export async function openStore(options: OpenOptions, workerFile = path.resolve(process.cwd(), 'dist/store-worker.cjs')): Promise<InternalClient> {
  const initial = await spawnWorkerClient(options, workerFile);
  return new RestartableStoreClient(
    initial,
    () => spawnWorkerClient(options, workerFile),
    options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
  );
}

export function temporaryStoreId(): string { return randomUUID(); }
