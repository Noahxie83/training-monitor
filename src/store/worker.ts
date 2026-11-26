import { workerData } from 'node:worker_threads';
import { installStoreWorker } from './worker-host';

void installStoreWorker(workerData, false).catch((error) => {
  console.error(`STORE_WORKER_START_FAILED ${String(error)}`);
  process.exitCode = 1;
});
