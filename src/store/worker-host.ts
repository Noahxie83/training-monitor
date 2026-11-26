import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { setImmediate as yieldToMessages } from 'node:timers/promises';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { StoreEngine } from './engine';
import type { StoreOperation, WorkerRequest, WorkerResponse } from './protocol';

type FaultPoint = 'beforeCursorWrite' | 'beforeGenerationSeal';
type WorkerData = { databasePath: string; openedAt: string; testOnly?: boolean; controlPort?: MessagePort };

export async function installStoreWorker(data: WorkerData, testOnly = false): Promise<void> {
  if (!parentPort) throw new Error('STORE_WORKER_REQUIRES_PARENT_PORT');
  let freeOverride: bigint | null = null;
  let failNext: FaultPoint | null = null;
  let pauseAt: FaultPoint | null = null;
  let releasePause: (() => void) | null = null;
  let rawGlobalLimit: bigint | undefined;
  let rawTaskLimit: bigint | undefined;
  let walThreshold: number | undefined;
  const work = { support: 0, cleanup: 0, supportBlocks: 0, supportMaxBlock: 0, cleanupBlocks: 0, cleanupMaxBlock: 0, supportCurrent: 0, cleanupCurrent: 0 };
  const port = testOnly ? data.controlPort : undefined;
  const injected = (point: FaultPoint): void => {
    if (failNext === point) { failNext = null; throw new Error(`INJECTED_${point}`); }
  };
  const engine = new StoreEngine(data.databasePath, () => Date.parse(data.openedAt), {
    beforeCursorWrite: () => injected('beforeCursorWrite'),
    beforeGenerationSeal: async () => {
      injected('beforeGenerationSeal');
      if (pauseAt !== 'beforeGenerationSeal') return;
      port?.postMessage({ kind: 'fault-reached', point: pauseAt });
      await new Promise<void>((resolve) => { releasePause = resolve; });
    },
    freeBytes: async () => freeOverride ?? defaultFreeBytes(data.databasePath),
    yieldSearch: async () => { await yieldToMessages(); },
    rawGlobalLimit: () => rawGlobalLimit,
    rawTaskLimit: () => rawTaskLimit,
    walCheckpointThreshold: () => walThreshold,
    workProbe: (kind) => { work[kind]++; work[`${kind}Current` as 'supportCurrent' | 'cleanupCurrent']++; },
    workBlock: (kind) => {
      const current = work[`${kind}Current` as 'supportCurrent' | 'cleanupCurrent'];
      if (kind === 'support') { work.supportBlocks++; work.supportMaxBlock = Math.max(work.supportMaxBlock, current); work.supportCurrent = 0; }
      else { work.cleanupBlocks++; work.cleanupMaxBlock = Math.max(work.cleanupMaxBlock, current); work.cleanupCurrent = 0; }
    },
  });
  try { await engine.retain(data.openedAt); } catch (error) { engine.close().catch(() => {}); throw error; }
  parentPort.postMessage({ kind: 'ready', runtime: { electron: process.versions.electron ?? null, node: process.versions.node, ...engine.runtimeInfo() } });
  port?.on('message', (message: { kind: string; id?: number; point?: FaultPoint; bytes?: string; globalBytes?: string; taskBytes?: string; threshold?: number }) => {
    if (!testOnly) return;
    if (message.kind === 'fail-next' && isFault(message.point)) failNext = message.point;
    else if (message.kind === 'pause-at' && isFault(message.point)) pauseAt = message.point;
    else if (message.kind === 'set-free-bytes' && typeof message.bytes === 'string' && /^\d+$/.test(message.bytes)) freeOverride = BigInt(message.bytes);
    else if (message.kind === 'set-limits' && message.globalBytes && message.taskBytes && /^\d+$/.test(message.globalBytes) && /^\d+$/.test(message.taskBytes)) { rawGlobalLimit = BigInt(message.globalBytes); rawTaskLimit = BigInt(message.taskBytes); }
    else if (message.kind === 'set-wal-threshold' && Number.isSafeInteger(message.threshold) && message.threshold! >= 0) walThreshold = message.threshold;
    else if (message.kind === 'release-pause') { pauseAt = null; releasePause?.(); releasePause = null; }
    else if (message.kind === 'get-work-counts') {
      port!.postMessage({ kind: 'work-counts', id: message.id, value: { support: work.support, cleanup: work.cleanup, supportBlocks: work.supportBlocks, supportMaxBlock: work.supportMaxBlock, cleanupBlocks: work.cleanupBlocks, cleanupMaxBlock: work.cleanupMaxBlock } });
      work.support = 0; work.cleanup = 0; work.supportBlocks = 0; work.supportMaxBlock = 0; work.cleanupBlocks = 0; work.cleanupMaxBlock = 0;
      work.supportCurrent = 0; work.cleanupCurrent = 0;
    }
    if (typeof message.id === 'number') port!.postMessage({ kind: 'control-applied', id: message.id });
  });
  let requestTail = Promise.resolve();
  parentPort.on('message', (message: WorkerRequest) => {
    if (!message || typeof message.id !== 'number' || !message.operation) return;
    // Cancellation must be able to run while a search yields. Every operation
    // touching SQLite joins one FIFO so no request can observe an open txn.
    const run = async () => {
      try {
        const value = await dispatch(engine, message.operation);
        parentPort!.postMessage({ id: message.id, ok: true, value } satisfies WorkerResponse);
        if (message.operation.method === 'close') parentPort!.close();
      } catch (error) {
        parentPort!.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : 'STORE_WORKER_ERROR' } satisfies WorkerResponse);
      }
    };
    if (message.operation.method === 'cancelRequest') void run();
    else {
      if (message.operation.method === 'searchLogs') void engine.beginSearchRequest(message.operation.args[0].requestId);
      requestTail = requestTail.then(run, run);
    }
  });
}

function isFault(value: unknown): value is FaultPoint { return value === 'beforeCursorWrite' || value === 'beforeGenerationSeal'; }
async function defaultFreeBytes(databasePath: string): Promise<bigint> {
  const usage = await statfs(path.dirname(databasePath));
  return BigInt(usage.bavail) * BigInt(usage.bsize);
}
async function dispatch(engine: StoreEngine, operation: StoreOperation): Promise<unknown> {
  switch (operation.method) {
    case 'getCursor': return engine.getCursor(...operation.args);
    case 'registerSource': return engine.registerSource(...operation.args);
    case 'saveObservation': return engine.saveObservation(...operation.args);
    case 'commitRead': return engine.commitRead(...operation.args);
    case 'commitReadWithReceipt': return engine.commitReadWithReceipt(...operation.args);
    case 'commitArchiveRead': return engine.commitArchiveRead(...operation.args);
    case 'reconcileSource': return engine.reconcileSource(...operation.args);
    case 'getSnapshot': return engine.getSnapshot();
    case 'getLogs': return engine.getLogs(...operation.args);
    case 'searchLogs': return engine.searchLogs(...operation.args);
    case 'cancelRequest': return engine.cancelRequest(...operation.args);
    case 'retain': return engine.retain(...operation.args);
    case 'diagnostics': return engine.diagnostics();
    case 'close': await engine.close(); return null;
  }
}
