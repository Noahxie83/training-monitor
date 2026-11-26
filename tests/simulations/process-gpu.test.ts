import { afterEach, describe, expect, it } from 'vitest';
import { createLiveMonitor } from './live-monitor-fixture';
import type { ResourceMetric } from '../../src/shared/contracts';

const monitors: Awaited<ReturnType<typeof createLiveMonitor>>[] = [];
afterEach(async () => { await Promise.all(monitors.splice(0).map(monitor => monitor.close())); });

describe('task GPU collection and history', () => {
  it('publishes only registered process usage, retains failed samples stale, clears old PID ownership and recovers', async () => {
    const monitor = await createLiveMonitor();
    monitors.push(monitor);
    const probe = monitor.transport.probeTask.bind(monitor.transport);
    let unavailable = false;
    let device = 'GPU 6';
    monitor.transport.probeTask = async task => {
      const observation = await probe(task);
      const key = observation.processes[0]!.key;
      const metric: ResourceMetric = { observedAt: observation.observedAt, freshness: 'fresh', scope: 'process',
        processKey: key, deviceId: device, source: 'test-nvidia-process', name: 'gpu_memory_used', unit: 'bytes', value: 2 * 1024 ** 3 };
      observation.processGpu = unavailable ? { observedAt: null, state: 'unavailable', errorCode: 'PROCESS_GPU_TIMEOUT', processKeys: [], metrics: [] }
        : { observedAt: observation.observedAt, state: 'available', errorCode: null, processKeys: [key], metrics: [metric,
          { ...metric, processKey: { ...key, pid: 999 }, value: 99 * 1024 ** 3 }] };
      return observation;
    };
    await monitor.api.start();
    await monitor.api.requestRefresh({});
    let snapshot = await monitor.api.getSnapshot();
    let task = snapshot.tasks[0]!;
    const own = task.resources.filter(metric => metric.scope === 'process' && metric.name === 'gpu_memory_used');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ deviceId: 'GPU 6', value: 2 * 1024 ** 3, freshness: 'fresh', processKey: { pid: 42, startTicks: '100' } });
    expect(task.gpuUsage).toMatchObject({ state: 'available', freshness: 'fresh' });
    const sampledAt = own[0]!.observedAt;

    unavailable = true;
    await monitor.api.requestRefresh({});
    snapshot = await monitor.api.getSnapshot();
    task = snapshot.tasks[0]!;
    expect(task.resources.filter(metric => metric.scope === 'process' && metric.name === 'gpu_memory_used')).toMatchObject([
      { deviceId: 'GPU 6', freshness: 'stale', observedAt: sampledAt },
    ]);
    expect(task.gpuUsage).toMatchObject({ state: 'unavailable', freshness: 'stale', observedAt: sampledAt });

    monitor.setStartTicks('200');
    await monitor.api.requestRefresh({});
    snapshot = await monitor.api.getSnapshot();
    expect(snapshot.tasks[0]!.resources.filter(metric => metric.scope === 'process' && metric.name === 'gpu_memory_used')).toEqual([]);
    expect(snapshot.tasks[0]!.gpuUsage?.processKeys).toEqual([]);

    unavailable = false;
    device = 'GPU 7';
    await monitor.api.requestRefresh({});
    snapshot = await monitor.api.getSnapshot();
    expect(snapshot.tasks[0]!.resources.filter(metric => metric.scope === 'process' && metric.name === 'gpu_memory_used')).toMatchObject([
      { deviceId: 'GPU 7', freshness: 'fresh', processKey: { pid: 42, startTicks: '200' } },
    ]);
  });
});
