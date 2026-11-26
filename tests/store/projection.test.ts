import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestStore } from './helpers/test-client';
import { observation } from './helpers/fixtures';
import type { TaskObservation } from '../../src/transport/types';
import { createEmptyProgress } from '../../src/domain/progress';
import type { TaskSnapshot } from '../../src/shared/contracts';

const dirs: string[] = [];
const NOW = '2026-10-21T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function taskObservation(): TaskObservation {
  return {
    taskId: 'task-a',
    hostId: 'host-a',
    observedAt: NOW,
    freshness: 'fresh',
    scanComplete: true,
    processScanError: null,
    phase: null,
    processes: [],
    sources: [],
    errorCode: null,
    errorScope: null,
  };
}

describe('store-owned production snapshot projection', () => {
  it('persists the last observation and marks it stale until a fresh observation replaces it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-projection-'));
    dirs.push(directory);
    let store = await openTestStore(directory, () => Date.parse(NOW));
    expect((store as unknown as Record<string, unknown>).saveObservation, 'store projection write API must exist').toBeTypeOf('function');

    await store.registerSource('source-a', observation(), 'task-a');
    await store.saveObservation({
      task: {
        taskId: 'task-a',
        hostId: 'host-a',
        label: 'Task A',
        enabled: true,
        algorithm: 'flow',
        allowedDirectories: ['/allowed/task-a'],
        entryPaths: ['/allowed/task-a/train.py'],
        sources: [{ sourceId: 'source-a', path: '/allowed/task-a/train.log', kind: 'log' }],
        checkpointDirectories: [],
      },
      hostObservation: {
        hostId: 'host-a',
        freshness: 'fresh',
        observedAt: NOW,
        phase: null,
        connection: 'connected',
        scanComplete: true,
        hostBootId: 'boot-a',
        errorCode: null,
      },
      taskObservation: taskObservation(),
      observedAt: NOW,
      sourceGenerations: { 'source-a': 'generation-a' },
      taskSnapshot: {
        version: 1,
        taskId: 'task-a',
        hostId: 'host-a',
        lifecycle: 'not_observed',
        freshness: 'fresh',
        statusObservedAt: NOW,
        confidence: 'high',
        reason: 'No active process observed',
        evidence: [],
        currentRun: null,
        processes: { main: null, queue: null, workers: [] },
        queueLock: { observedAt: null, freshness: 'unobserved', source: null, exists: null, heldByRegisteredProcess: null },
        progress: createEmptyProgress(NOW, 'fresh', null),
        checkpoint: { observedAt: null, freshness: 'unobserved', path: null, fileStepIndex: null, stepSource: null, sizeBytes: null, mtime: null, evidence: 'none', scanComplete: false },
        resources: [{ observedAt: NOW, freshness: 'fresh', source: 'nvidia-smi', name: 'gpu_utilization', unit: 'percent_device', value: 0, scope: 'device', deviceId: 'GPU 0', processKey: null }],
      } satisfies TaskSnapshot,
      sourceStates: {
        'source-a': {
          observedAt: NOW,
          freshness: 'fresh',
          state: 'ready',
          errorCode: null,
        },
      },
    });
    expect(await store.getSnapshot()).toMatchObject({
      version: 1,
      demo: false,
      hosts: [{ hostId: 'host-a', connection: 'connected', freshness: 'fresh', observedAt: NOW }],
      tasks: [{ taskId: 'task-a', hostId: 'host-a', freshness: 'fresh', statusObservedAt: NOW }],
      sources: [{ sourceId: 'source-a', taskId: 'task-a', generation: 'generation-a', committedOffset: '0' }],
    });
    await store.close();

    store = await openTestStore(directory, () => Date.parse(NOW) + 60_000);
    const reopened = await store.getSnapshot();
    expect(reopened.hosts[0]).toMatchObject({
      connection: 'disconnected',
      freshness: 'stale',
      observedAt: NOW,
      lastSuccessAt: NOW,
    });
    expect(reopened.tasks[0]).toMatchObject({
      freshness: 'stale',
      statusObservedAt: NOW,
      lifecycle: 'unknown',
      resources: [{ observedAt: NOW, freshness: 'stale', name: 'gpu_utilization', value: 0, deviceId: 'GPU 0' }],
      progress: { baselineEvidenceId: null, global: { completedCount: null, targetCount: null } },
    });
    expect(reopened.sources[0]).toMatchObject({
      state: 'unobserved',
      freshness: 'stale',
      observedAt: NOW,
      committedOffset: '0',
    });
    expect(JSON.stringify(reopened)).not.toContain('baselineRead');
    await store.close();
  });
});
