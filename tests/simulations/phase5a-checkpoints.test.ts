import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createProductionApi } from '../../src/collector/service';
import type { Registry } from '../../src/shared/contracts';
import { openStore } from '../../src/store/client';
import { createTransport } from '../../src/transport/transport';

it.skipIf(process.platform !== 'linux')('projects a directory checkpoint from the real probe through transport and collector', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-checkpoint-'));
  try {
    const checkpoints = path.join(directory, 'checkpoints');
    const checkpoint = path.join(checkpoints, 'checkpoint-100');
    await mkdir(checkpoint, { recursive: true });
    await writeFile(path.join(checkpoint, 'model.bin'), 'model');
    const registry: Registry = {
      version: 2, revision: 1,
      hosts: [{ hostId: 'local', label: 'Local', target: { kind: 'local' },
        enabled: true, allowedRoots: [directory] }],
      tasks: [{ taskId: 'training', hostId: 'local', label: 'Training', enabled: true, algorithm: 'generic',
        allowedDirectories: [directory], entryPaths: ['train.py'], sources: [], checkpointDirectories: [checkpoints] }],
    };
    const probeSource = await readFile('src/probe/readonly_probe.py', 'utf8');
    const store = await openStore({ directory, now: Date.now });
    const api = createProductionApi({
      store, clock: Date.now, registryProvider: async () => registry,
      transportProvider: (host, reg) => createTransport({ hostId: host.hostId, host, registry: reg }, { probeSource }),
    });
    try {
      api.setCollectionPaused(true);
      await api.start();
      await api.requestRefresh({});
      expect((await api.getSnapshot()).tasks[0]?.checkpoint).toMatchObject({
        path: checkpoint, isDirectory: true, fileCount: 1, evidence: 'file_found', scanComplete: true,
      });
    } finally {
      await api.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
