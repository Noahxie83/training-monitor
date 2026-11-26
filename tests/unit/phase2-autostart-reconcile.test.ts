import { describe, expect, it, vi } from 'vitest';
import { buildAutoStartPayload, createAutoStartDraft } from '../../src/renderer/components/AutoStartFields';
import { AutoStartController, launchConfigHash } from '../../src/launch/controller';
import { cancelChangedServerWaits, flushPendingRemoteCancels, type PendingRemoteCancel } from '../../src/launch/reconcile';
import type { Registry } from '../../src/shared/contracts';
import type { HostObservation, ServerWaitResult, Transport } from '../../src/transport/types';

function makeRegistry(): Registry {
  return {
    version: 2,
    revision: 1,
    hosts: [{
      hostId: 'h-ssh', label: 'SSH Node', enabled: true, allowedRoots: ['/data'],
      stateDir: '/var/lib/tm-state', target: { kind: 'ssh', alias: 'gpu-01' },
    }],
    tasks: [{
      taskId: 't-multi', hostId: 'h-ssh', label: 'Multi GPU', enabled: true, algorithm: 'Qwen3', logFormat: 'generic',
      allowedDirectories: ['/data/exp'], entryPaths: ['train.py'],
      sources: [{ sourceId: 'log', kind: 'log', path: '/data/exp/train.log' }],
      checkpointDirectories: [],
      autoStart: {
        execution: 'server_tmux', enabled: true, armId: '11111111-2222-4333-8444-555555555555',
        gpuDeviceIds: ['GPU 0', 'GPU 2'], gpuExcludeIds: ['GPU 1'],
        requiredGpuCount: 2, cudaVisibleDevicesMode: 'index',
        idleSeconds: 60, maxUtilizationPercent: 5, maxMemoryMiB: 1024,
        retryOnExit: true, maxRetries: 4, retryBackoffSeconds: 15,
        launch: {
          pythonPath: '/usr/bin/python3', entryPath: 'train.py',
          cwd: '/data/exp', arguments: '--epochs 5', logSourceId: 'log',
        },
      },
    }],
  };
}

describe('Phase 2 auto-start passthrough, controller error surfacing, and offline reconcile', () => {
  it('preserves gpuDeviceIds, gpuExcludeIds, requiredGpuCount, cudaVisibleDevicesMode, and maxRetries through AutoStartFields', () => {
    const reg = makeRegistry();
    const task = reg.tasks[0]!;
    const context = {
      entryPaths: task.entryPaths,
      allowedDirectories: task.allowedDirectories,
      logSources: [{ sourceId: 'log', path: '/data/exp/train.log' }],
      hasStatusSource: false,
    };
    const draft = createAutoStartDraft(task.autoStart, context);
    expect(draft.gpuText).toBe('0, 2');
    expect(draft.gpuExcludeText).toBe('1');
    expect(draft.requiredGpuCount).toBe('2');
    expect(draft.maxRetries).toBe('4');

    const { payload, error } = buildAutoStartPayload(draft, context);
    expect(error).toBeNull();
    expect(payload).toMatchObject({
      gpuDeviceIds: ['GPU 0', 'GPU 2'],
      gpuExcludeIds: ['GPU 1'],
      requiredGpuCount: 2,
      cudaVisibleDevicesMode: 'index',
      retryOnExit: true,
      maxRetries: 4,
      retryBackoffSeconds: 15,
    });
  });

  it('controller surfaces server failed/blocked errorCode without masking via SERVER_WAIT_RESPONSE_MISMATCH', async () => {
    const reg = makeRegistry();
    const host = reg.hosts[0]!;
    const task = reg.tasks[0]!;
    const hash = launchConfigHash(host, task);
    const failedRemote: ServerWaitResult = {
      state: 'failed',
      armId: task.autoStart!.armId,
      configHash: hash,
      idleElapsedSeconds: 0,
      requiredIdleSeconds: 0, // intentionally differs from configured 60 on error frames!
      lastCheckedAt: '2026-11-26T00:00:00.000Z',
      startedAt: null,
      pid: null,
      errorCode: 'MAX_RETRIES_EXCEEDED',
      errorParams: { retryCount: 4, maxRetries: 4 },
      message: 'Maximum retry count reached',
      sessionName: 'tm-wait-abc',
      selectedDeviceId: null,
      retryCount: 4,
      maxRetries: 4,
    };

    const transport: Partial<Transport> = {
      getServerWait: vi.fn().mockResolvedValue(failedRemote),
      ensureServerWait: vi.fn().mockResolvedValue(failedRemote),
    };
    const controller = new AutoStartController({
      clock: () => Date.parse('2026-11-26T00:00:00.000Z'),
      registryProvider: async () => reg,
    });
    controller.synchronize(reg);
    const hostObs: HostObservation = {
      hostId: host.hostId, freshness: 'fresh', observedAt: '2026-11-26T00:00:00.000Z',
      phase: null, connection: 'connected', scanComplete: true, hostBootId: 'b1', errorCode: null,
    };
    await controller.evaluate(host, task, hostObs, transport as Transport, new AbortController().signal);
    const status = controller.getStatus(task.taskId);
    expect(status?.phase).toBe('failed');
    expect(status?.errorCode).toBe('MAX_RETRIES_EXCEEDED');
    expect(status?.errorCode).not.toBe('SERVER_WAIT_RESPONSE_MISMATCH');
    expect(status?.retryCount).toBe(4);
  });

  it('reconcile throws HOST_UNREACHABLE_RECONCILE offline, supports forceLocal pending cancel, and flushes on reconnect', async () => {
    const current = makeRegistry();
    const next = structuredClone(current);
    next.tasks[0]!.autoStart!.enabled = false;

    const offlineTransport = {
      cancelServerWait: vi.fn().mockRejectedValue(new Error('SSH_TIMEOUT')),
    } as unknown as Transport;

    // 1. Default save without forceLocal throws structured HOST_UNREACHABLE_RECONCILE
    let caught: any = null;
    try {
      await cancelChangedServerWaits(current, next, () => offlineTransport, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('HOST_UNREACHABLE_RECONCILE');
    expect(caught.affectedTasks).toHaveLength(1);

    // 2. forceLocal=true succeeds and queues PendingRemoteCancel
    const pending: PendingRemoteCancel[] = [];
    await cancelChangedServerWaits(current, next, () => offlineTransport, new AbortController().signal, {
      forceLocal: true,
      onPendingCancel: (item) => { pending.push(item); },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.taskId).toBe('t-multi');

    // 3. Once host reconnects, flushPendingRemoteCancels cancels remotely and drains queue!
    const expectedHash = pending[0]!.configHash;
    const onlineTransport = {
      cancelServerWait: vi.fn().mockResolvedValue({
        state: 'cancelled',
        armId: pending[0]!.armId,
        configHash: expectedHash,
        idleElapsedSeconds: 0,
        requiredIdleSeconds: 60,
        lastCheckedAt: '2026-11-26T00:01:00.000Z',
        startedAt: null,
        pid: null,
        errorCode: null,
        message: null,
        sessionName: null,
        selectedDeviceId: null,
      }),
    } as unknown as Transport;
    const flushed = await flushPendingRemoteCancels('h-ssh', onlineTransport, pending, new AbortController().signal);
    expect(flushed.flushed).toHaveLength(1);
    expect(flushed.remaining).toHaveLength(0);
    expect(onlineTransport.cancelServerWait).toHaveBeenCalledTimes(1);
  });
});
