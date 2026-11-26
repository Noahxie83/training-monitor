import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { runCanary } from './electron-smoke.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-runtime-'));
try {
  await runCanary(electron, [path.resolve('test-results/runtime/main.cjs')], directory, 'STORE_CANARY_OK');
} finally {
  await rm(directory, { recursive: true, force: true });
}
