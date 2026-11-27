import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveMonitor, liveRegistry } from './live-monitor-fixture';

const monitors: Awaited<ReturnType<typeof createLiveMonitor>>[] = [];
afterEach(async () => { await Promise.all(monitors.splice(0).map(monitor => monitor.close())); });

describe('generic tasks through the production collector', () => {
  it('recognizes a custom algorithm training step without inventing progress counts', async () => {
    const registry = liveRegistry();
    registry.tasks[0] = { ...registry.tasks[0]!, algorithm: 'PPO / 自定义算法', logFormat: 'generic' };
    const monitor = await createLiveMonitor({ registry, initialLog: '[train] step=10 loss=0.2\n' });
    monitors.push(monitor);
    await monitor.api.start();
    await monitor.api.requestRefresh({});
    monitor.append('[train] step=11 loss=0.15\n');
    await monitor.api.requestRefresh({});
    const snapshot = await monitor.api.getSnapshot();
    expect(snapshot.tasks[0]).toMatchObject({ lifecycle: 'running', progress: { lastStepIndex: 11,
      global: { completedCount: null, targetCount: null }, session: { completedCount: null, targetCount: null },
      resumeCheckpointIndex: null, baselineEvidenceId: null } });
  });

  it('uses tqdm session counts for a generic task even when its name is Flow Matching', async () => {
    const registry = liveRegistry();
    registry.tasks[0] = { ...registry.tasks[0]!, algorithm: 'Flow Matching', logFormat: 'generic' };
    const monitor = await createLiveMonitor({ registry, initialLog: '0/100 [00:00<?, 0it/s]\n' });
    monitors.push(monitor);
    await monitor.api.start();
    await monitor.api.requestRefresh({});
    monitor.append('25/100 [00:10<00:30, 2.5it/s]\n');
    await monitor.api.requestRefresh({});
    const snapshot = await monitor.api.getSnapshot();
    expect(snapshot.tasks[0]).toMatchObject({ lifecycle: 'running', progress: {
      session: { completedCount: 25, targetCount: 100, fraction: 0.25, unit: 'completed_iterations', verified: true },
      global: { completedCount: null, targetCount: null, verified: false }, resumeCheckpointIndex: null, baselineEvidenceId: null } });
  });
});

describe('Phase 5a log attribution through the production collector', () => {
  it('keeps ANSI redraw byte evidence, monotonic progress and ETA across repeated CR frames', async () => {
    const registry = liveRegistry();
    registry.tasks[0]!.logFormat = 'generic';
    const frame = (step: number) => `\x1b[32m${step}/100 [00:10<00:30, 2.5it/s]\x1b[0m`;
    const monitor = await createLiveMonitor({ registry, initialLog: frame(0) + '\n' });
    monitors.push(monitor);
    monitor.api.setCollectionPaused(true);
    await monitor.api.start();
    await monitor.api.requestRefresh({});
    monitor.append(frame(7) + '\r' + frame(10) + '\r' + frame(11));
    await monitor.api.requestRefresh({});
    expect((await monitor.api.getSnapshot()).tasks[0]?.progress.current).toBe(10);
    monitor.append('\r' + frame(20) + '\r' + frame(21));
    await monitor.api.requestRefresh({});
    const task = (await monitor.api.getSnapshot()).tasks[0]!;
    expect(task.attributionConfidence).toBe('confirmed_process');
    expect(task.progress).toMatchObject({ current: 20, total: 100, progressFreshness: 'fresh' });
    expect(task.progress.iterationsPerSecond).toBeGreaterThan(0);
    expect(task.progress.etaSeconds).toBeGreaterThan(0);
  });

  it.each(['log_only', 'inferred_tree'] as const)('keeps %s progress, scalars and persisted series', async (mode) => {
    const registry = liveRegistry();
    registry.tasks[0]!.logFormat = 'generic';
    if (mode === 'log_only') registry.tasks[0]!.attributionMode = 'log_only';
    const monitor = await createLiveMonitor({ registry, initialLog: '0/100 [00:00<?, 0it/s]\n' });
    monitors.push(monitor);
    const originalProbe = monitor.transport.probeTask.bind(monitor.transport);
    vi.spyOn(monitor.transport, 'probeTask').mockImplementation(async (task) => {
      const observed = await originalProbe(task);
      if (mode === 'log_only') {
        return { ...observed, processes: [], scanComplete: false, processScanError: 'PROC_SCAN_INCOMPLETE' };
      }
      return {
        ...observed,
        processes: observed.processes.map((proc) => ({
          ...proc, roleEvidence: 'exact_script_entry', directWriterSourceIds: [], writerSourceEvidence: {},
        })),
      };
    });
    monitor.api.setCollectionPaused(true);
    await monitor.api.start();
    await monitor.api.requestRefresh({});
    monitor.append('25/100 [00:10<00:30, 2.5it/s] loss=0.25 lr=1e-4\n');
    await monitor.api.requestRefresh({});
    const snapshot = (await monitor.api.getSnapshot()).tasks[0]!;
    expect(snapshot).toMatchObject({
      lifecycle: 'running', attributionConfidence: mode,
      progress: { current: 25, total: 100, scalars: { loss: 0.25, lr: 0.0001 } },
    });
    if (mode === 'log_only') expect(snapshot.currentRun).toBeNull();
    const history = await monitor.api.getMetricSeries!({ taskId: snapshot.taskId });
    expect(history.series.loss?.at(-1)).toMatchObject({ value: 0.25, step: 25 });
  });
});
