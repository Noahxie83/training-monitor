import { Worker } from 'node:worker_threads';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoreClient as StoreClientContract, StoreOperation, WorkerRequest, WorkerResponse, StoreDiagnostics } from './protocol';
import type { CursorState } from '../shared/contracts';
import type { LogPage, LogQuery, LogSearchPage, LogSearchRequest, MonitorSnapshot } from '../shared/api';
import type { ArchiveReadEvidence, ReadReply, SourceObservation } from '../logs/types';
import type { CommitReadResult, ReconcileRequest } from './protocol';
import type { PersistedObservation } from './engine';

type ReadyMessage = { kind: 'ready'; runtime: { electron: string | null; node: string; sqlite: string } };
type OpenOptions = { directory: string; now: () => number };
type InternalClient = StoreClientContract & { diagnostics(): Promise<StoreDiagnostics>; runtime: ReadyMessage['runtime'] };
const READY_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 2_000;

class StoreClientImpl implements InternalClient {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readyResolve!: (message: ReadyMessage) => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<ReadyMessage>;
  private closed = false;
  private terminalError: Error | null = null;
  private closing: Promise<void> | null = null;
  runtime: ReadyMessage['runtime'] = { electron: null, node: 'unknown', sqlite: 'unknown' };

  constructor(private readonly worker: Worker, private readonly clock: () => number) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    worker.on('message', (message: ReadyMessage | WorkerResponse) => {
      if ('kind' in message && message.kind === 'ready') { this.runtime = message.runtime; this.readyResolve(message); return; }
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
  }
  async start(): Promise<void> { await this.withTimeout(this.ready, READY_TIMEOUT_MS, 'STORE_READY_TIMEOUT'); }
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
  getCursor(sourceId: string): Promise<CursorState | null> { return this.call({ method: 'getCursor', args: [sourceId] }); }
  registerSource(sourceId: string, observation: SourceObservation, taskId: string): Promise<CursorState> { return this.call({ method: 'registerSource', args: [sourceId, observation, taskId] }); }
  saveObservation(observation: PersistedObservation): Promise<void> { return this.call({ method: 'saveObservation', args: [observation] }); }
  commitRead(input: Parameters<StoreClientContract['commitRead']>[0]): Promise<CommitReadResult['status']> { return this.call({ method: 'commitRead', args: [input] }); }
  commitReadWithReceipt(input: Parameters<StoreClientContract['commitReadWithReceipt']>[0]): Promise<CommitReadResult> { return this.call({ method: 'commitReadWithReceipt', args: [input] }); }
  commitArchiveRead(input: Parameters<StoreClientContract['commitArchiveRead']>[0]): Promise<'committed' | 'stale' | 'reconciling' | 'storage_error'> { return this.call({ method: 'commitArchiveRead', args: [input] }); }
  reconcileSource(input: ReconcileRequest): Promise<Awaited<ReturnType<StoreClientContract['reconcileSource']>>> { return this.call({ method: 'reconcileSource', args: [input] }); }
  getSnapshot(): Promise<MonitorSnapshot> { return this.call({ method: 'getSnapshot', args: [] }); }
  getLogs(query: LogQuery): Promise<LogPage> { return this.call({ method: 'getLogs', args: [query, new Date(this.clock()).toISOString()] }); }
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage> { return this.call({ method: 'searchLogs', args: [query, new Date(this.clock()).toISOString()] }); }
  cancelRequest(requestId: string): Promise<void> { return this.call({ method: 'cancelRequest', args: [requestId] }); }
  retain(now: string): Promise<{ pausedForDisk: boolean }> { return this.call({ method: 'retain', args: [now] }); }
  diagnostics(): Promise<StoreDiagnostics> { return this.call({ method: 'diagnostics', args: [] }); }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try { await this.withTimeout(this.call({ method: 'close', args: [] }), CLOSE_TIMEOUT_MS, 'STORE_CLOSE_TIMEOUT'); }
      finally { this.closed = true; for (const item of this.pending.values()) item.reject(new Error('STORE_CLOSED')); this.pending.clear(); await this.worker.terminate(); }
    })();
    return this.closing;
  }
}

export async function connectStoreWorker(worker: Worker, clock: () => number): Promise<InternalClient> {
  const client = new StoreClientImpl(worker, clock);
  try { await client.start(); } catch (error) { await worker.terminate(); throw error; }
  return client;
}

async function makeClient(options: OpenOptions, workerFile: string): Promise<InternalClient> {
  if (typeof options.now !== 'function') throw new TypeError('INVALID_STORE_CLOCK');
  const directory = path.resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const openedAt = new Date(options.now()).toISOString();
  const worker = new Worker(workerFile, { workerData: { databasePath: path.join(directory, 'monitor.sqlite'), openedAt } });
  return connectStoreWorker(worker, options.now);
}

export async function openStore(options: OpenOptions, workerFile = path.resolve(process.cwd(), 'dist/store-worker.cjs')): Promise<StoreClientContract> {
  return makeClient(options, workerFile);
}

export function temporaryStoreId(): string { return randomUUID(); }
