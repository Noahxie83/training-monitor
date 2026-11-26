import { app } from 'electron';
import { createWindow, createGpuWindowManager } from '../../src/desktop/window';
import { registerMonitorIpc } from '../../src/desktop/ipc';
import { createControlledMockApi, testFlowTask, testHostConnected, testHostWslUnobserved, testRegistry } from '../ui/fixtures';
import type { MonitorSnapshot } from '../../src/shared/api';

const registry = structuredClone(testRegistry);
registry.tasks = [];
registry.hosts[1]!.enabled = true;
const samples = testFlowTask.resources.filter(metric => metric.scope === 'device');
const snapshot: MonitorSnapshot = { version: 1, demo: true, tasks: [], sources: [], hosts: [
  { ...testHostConnected, gpu: { state: 'available', errorCode: null, observedAt: '2026-11-05T12:00:00Z',
    metrics: Array.from({ length: 8 }, (_, index) => samples.map(metric => ({ ...metric, deviceId: `GPU ${index}`,
      value: metric.name === 'gpu_utilization' ? [94, 30, 100, 81, 98, 40, 0, 0][index]! : metric.value }))).flat() } },
  { ...testHostWslUnobserved, connection: 'disconnected', errorCode: 'WSL_NOT_RUNNING' },
] };

app.on('window-all-closed', () => app.quit());
void app.whenReady().then(() => {
  const api = createControlledMockApi({ registry, snapshot, preferences: { theme: 'light' } });
  const gpu = createGpuWindowManager();
  const dispose = registerMonitorIpc(api, { openGpuWindow: hostId => gpu.open(hostId) });
  app.once('before-quit', dispose);
  const main = createWindow();
  main.once('closed', () => app.quit());
});
