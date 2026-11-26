import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../store/client';
import type { SourceObservation } from '../logs/types';

export async function runStoreCanary(cacheDirectory: string): Promise<Record<string, unknown>> {
  await mkdir(cacheDirectory, { recursive: true });
  const workerFile = path.join(__dirname, 'store-worker.cjs');
  const payload = Buffer.from('electron-store-commit-reopen\n', 'utf8');
  const digest = createHash('sha256').update(payload).digest('hex');
  const observation: SourceObservation = {
    fileIdentity: { dev: 'runtime-canary', inode: 'temporary-source' },
    identityStrength: 'strong',
    sizeBytes: String(payload.length),
    observedAt: new Date().toISOString(),
    anchors: [{ startOffset: '0', endOffset: String(payload.length), sha256: digest }],
  };
  const directory = path.join(cacheDirectory, 'training-monitor-store');
  const now = () => Date.now();
  const first = await openStore({ directory, now }, workerFile);
  try {
    const cursor = await first.registerSource('runtime-canary-source', observation, 'runtime-canary-task');
    const reply = {
      sourceId: cursor.sourceId,
      expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset },
      startOffset: cursor.committedOffset,
      bytes: new Uint8Array(payload),
      before: observation,
      after: observation,
    };
    const commit = await first.commitRead({ expected: cursor, reply, ingestedAt: new Date(now()).toISOString() });
    if (commit !== 'committed') throw new Error(`STORE_CANARY_COMMIT_${commit}`);
  } finally {
    await first.close();
  }

  const reopened = await openStore({ directory, now }, workerFile);
  try {
    const cursor = await reopened.getCursor('runtime-canary-source');
    const page = await reopened.getLogs({ requestId: 'runtime-canary-readback', sourceId: 'runtime-canary-source', before: null, limit: 10 });
    const metrics = await (reopened as typeof reopened & { diagnostics(): Promise<{ databaseBytes: number; walBytes: number; rawBytes: number; sqliteVersion: string }> }).diagnostics();
    if (cursor?.committedOffset !== String(payload.length) || !page.events.some((event) => event.text === 'electron-store-commit-reopen')) {
      throw new Error('STORE_CANARY_REOPEN_MISMATCH');
    }
    return {
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      sqlite: metrics.sqliteVersion,
      commit: 'committed',
      reopen: 'verified',
      committedOffset: cursor.committedOffset,
      rawBytes: metrics.rawBytes,
      databaseBytes: metrics.databaseBytes,
      walBytes: metrics.walBytes,
      worker: 'single-production-store-worker',
    };
  } finally {
    await reopened.close();
  }
}
