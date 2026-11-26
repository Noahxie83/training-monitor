import { MessageChannel, Worker } from 'node:worker_threads';
import path from 'node:path';
import { connectStoreWorker } from '../../../src/store/client';
import type { StoreClient } from '../../../src/store/protocol';

type TestControls = {
  setFreeBytes(bytes: number): void;
  setLimits(globalBytes: number, taskBytes: number): Promise<void>;
  setWalThreshold(bytes: number): Promise<void>;
  setFreeBytesAndWait(bytes: number): Promise<void>;
  failNext(point: 'beforeCursorWrite' | 'beforeGenerationSeal'): Promise<void>;
  pauseAt(point: 'beforeGenerationSeal'): Promise<void>;
  waitForPause(): Promise<void>;
  getWorkCounts(): Promise<{ support: number; cleanup: number; supportBlocks: number; supportMaxBlock: number; cleanupBlocks: number; cleanupMaxBlock: number }>;
  releasePause(): void;
  terminate(): Promise<number>;
};
export type TestStore = StoreClient & {
  diagnostics(): Promise<{ databaseBytes: number; walBytes: number; rawBytes: number }>;
  test: TestControls;
};

export async function openTestStore(directory: string, now: () => number, workerFile = path.resolve(process.cwd(), 'test-results/store-test-worker.cjs')): Promise<TestStore> {
  const channel = new MessageChannel();
  const worker = new Worker(workerFile, {
    workerData: { databasePath: path.join(directory, 'monitor.sqlite'), openedAt: new Date(now()).toISOString(), testOnly: true, controlPort: channel.port2 },
    transferList: [channel.port2],
  });
  const messages: { kind: string; point?: string; id?: number }[] = [];
  const waiters: ((message: { kind: string; point?: string; id?: number }) => void)[] = [];
  const workWaiters = new Map<number, (value: { support: number; cleanup: number; supportBlocks: number; supportMaxBlock: number; cleanupBlocks: number; cleanupMaxBlock: number }) => void>();
  const store = await connectStoreWorker(worker, now);
  let controlId = 0;
  const applied = new Map<number, () => void>();
  const sendControl = (message: Record<string, unknown>) => new Promise<void>((resolve) => {
    const id = ++controlId;
    applied.set(id, resolve);
    channel.port1.postMessage({ ...message, id });
  });
  channel.port1.on('message', (message: { kind: string; id?: number; point?: string; value?: { support: number; cleanup: number; supportBlocks: number; supportMaxBlock: number; cleanupBlocks: number; cleanupMaxBlock: number } }) => {
    if (message.kind === 'control-applied' && message.id) { applied.get(message.id)?.(); applied.delete(message.id); }
    else if (message.kind === 'work-counts' && message.id && message.value) { workWaiters.get(message.id)?.(message.value); workWaiters.delete(message.id); }
    else {
      const waiter = waiters.shift();
      if (waiter) waiter(message); else messages.push(message);
    }
  });
  const test: TestControls = {
    setFreeBytes(bytes) { void sendControl({ kind: 'set-free-bytes', bytes: String(bytes) }); },
    setFreeBytesAndWait(bytes) { return sendControl({ kind: 'set-free-bytes', bytes: String(bytes) }); },
    setLimits(globalBytes, taskBytes) { return sendControl({ kind: 'set-limits', globalBytes: String(globalBytes), taskBytes: String(taskBytes) }); },
    setWalThreshold(bytes) { return sendControl({ kind: 'set-wal-threshold', threshold: bytes }); },
    failNext(point) { return sendControl({ kind: 'fail-next', point }); },
    async pauseAt(point) { await sendControl({ kind: 'pause-at', point }); },
    waitForPause() {
      const found = messages.findIndex((message) => message.kind === 'fault-reached');
      if (found >= 0) { messages.splice(found, 1); return Promise.resolve(); }
      return new Promise((resolve) => waiters.push((message) => { if (message.kind === 'fault-reached') resolve(); }));
    },
    getWorkCounts() {
      const id = ++controlId;
      return new Promise((resolve) => { workWaiters.set(id, resolve); channel.port1.postMessage({ kind: 'get-work-counts', id }); });
    },
    releasePause() { channel.port1.postMessage({ kind: 'release-pause' }); },
    terminate() { return worker.terminate(); },
  };
  return Object.assign(store, { test });
}
