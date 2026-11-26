import { afterEach, describe, expect, it } from 'vitest';
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
