import { app } from 'electron';
import { createWindow, createGpuWindowManager } from '../../src/desktop/window';
import { registerMonitorIpc } from '../../src/desktop/ipc';
import { createControlledMockApi, testFlowTask, testHostConnected, testRegistry } from '../ui/fixtures';
import type { MonitorSnapshot } from '../../src/shared/api';
import type { ResourceMetric } from '../../src/shared/contracts';

const registry = structuredClone(testRegistry);
registry.tasks = [{ ...registry.tasks[0]!, label: '当前训练任务' }];
const task = structuredClone(testFlowTask);
const key = task.processes.main!.key!;
const deviceMetrics = Array.from({ length: 8 }, (_, index) => task.resources.filter(metric => metric.scope === 'device').map(metric => ({
  ...metric, deviceId: `GPU ${index}`, value: metric.name === 'gpu_utilization' ? 98 : metric.value,
}))).flat();
const base = { scope: 'process' as const, processKey: key, deviceId: 'GPU 6', observedAt: '2026-11-11T00:00:00Z', freshness: 'fresh' as const, source: 'test-process' };
const processMetrics: ResourceMetric[] = [{ ...base, name: 'gpu_utilization', unit: 'percent_device', value: 74 },
  { ...base, name: 'gpu_memory_used', unit: 'bytes', value: 2 * 1024 ** 3 }];
task.resources = [...deviceMetrics, ...processMetrics];
task.gpuUsage = { observedAt: base.observedAt, freshness: 'fresh', state: 'available', errorCode: null, processKeys: [key] };
const snapshot: MonitorSnapshot = { version: 1, demo: true, sources: [], tasks: [task], hosts: [{ ...testHostConnected,
  gpu: { observedAt: base.observedAt, state: 'available', errorCode: null, metrics: deviceMetrics } }] };
registry.hosts = [registry.hosts[0]!];
app.on('window-all-closed', () => app.quit());
void app.whenReady().then(() => {
  const api = createControlledMockApi({ registry, snapshot, preferences: { theme: 'light' } });
  const gpu = createGpuWindowManager();
  const dispose = registerMonitorIpc(api, { openGpuWindow: hostId => gpu.open(hostId) });
  app.once('before-quit', dispose);
  createWindow().once('closed', () => app.quit());
});
