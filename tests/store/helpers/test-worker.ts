import { workerData } from 'node:worker_threads';
import { installStoreWorker } from '../../../src/store/worker-host';

void installStoreWorker(workerData, true).catch((error) => {
  console.error(`STORE_TEST_WORKER_START_FAILED ${String(error)}`);
  process.exitCode = 1;
});
