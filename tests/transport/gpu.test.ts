import { describe, expect, test } from 'vitest';
import { gpuDeviceMap, projectGpuCsv, projectProcessGpu } from '../../src/transport/gpu';

describe('aggregate GPU CSV projection', () => {
  test('supports multiple devices, preserves zero, maps unsupported values to null and converts MiB to bytes', () => {
    const result = projectGpuCsv([
      '0, GPU-a, 0, 512, 8192',
      '1, GPU-b, N/A, Not Supported, 16384',
    ].join('\n'), '2026-11-05T00:00:00.000Z');

    expect(result.state).toBe('available');
    expect(result.metrics).toHaveLength(6);
    expect(result.metrics).toMatchObject([
      { deviceId: 'GPU 0', name: 'gpu_utilization', value: 0 },
      { deviceId: 'GPU 0', name: 'gpu_memory_used', value: 512 * 1024 * 1024 },
      { deviceId: 'GPU 0', name: 'gpu_memory_total', value: 8192 * 1024 * 1024 },
      { deviceId: 'GPU 1', name: 'gpu_utilization', value: null },
      { deviceId: 'GPU 1', name: 'gpu_memory_used', value: null },
      { deviceId: 'GPU 1', name: 'gpu_memory_total', value: 16384 * 1024 * 1024 },
    ]);
  });

  test('handles NVIDIA [N/A], [Not Supported], NA, Unknown, -, and MIG-* UUIDs', () => {
    const csv = [
      '0, MIG-GPU-1234-abcd/0/0, [N/A], [Not Supported], 20480',
      '1, GPU-5678, Unknown, -, NA',
    ].join('\n');
    expect(gpuDeviceMap(csv)).toEqual([
      { index: 0, uuid: 'MIG-GPU-1234-abcd/0/0' },
      { index: 1, uuid: 'GPU-5678' },
    ]);
    const result = projectGpuCsv(csv, '2026-11-05T00:00:00.000Z');
    expect(result.state).toBe('available');
    expect(result.acceleratorAvailability).toBe('available');
    expect(result.metrics.map((m) => m.value)).toEqual([
      null, null, 20480 * 1024 * 1024,
      null, null, null,
    ]);
  });

  test('rejects invalid device values without turning them into zero', () => {
    const result = projectGpuCsv('0, GPU-a, 101, -1, 8192', '2026-11-05T00:00:00.000Z');
    expect(result.metrics.map((metric) => metric.value)).toEqual([null, null, 8192 * 1024 * 1024]);
    expect(projectGpuCsv('', '2026-11-05T00:00:00.000Z')).toMatchObject({ state: 'unavailable', metrics: [] });
  });
});

describe('task-scoped GPU process projection', () => {
  const key = { hostBootId: 'boot-a', pid: 42, startTicks: '100' };
  const devices = [{ index: 6, uuid: 'GPU-a' }, { index: 7, uuid: 'GPU-b' }];
  const sample = { processKey: key, keyBeforeSample: key, keyAfterSample: key, deviceId: 'GPU 6', memoryBytes: 1024, utilizationPercent: 74 };
  const at = '2026-11-11T00:00:00Z';

  test('maps physical IDs and accepts only this task’s stable PID instances', () => {
    expect(gpuDeviceMap('6, GPU-a, 90, 512, 8192\n7, GPU-b, 80, 512, 8192')).toEqual(devices);
    const other = { ...key, pid: 999 };
    const result = projectProcessGpu({ status: 'ok', processKeys: [key, other], samples: [sample, sample,
      { ...sample, processKey: other, keyBeforeSample: other, keyAfterSample: other },
      { ...sample, deviceId: 'GPU 7', memoryBytes: 0, utilizationPercent: null },
    ] }, [key], devices, at);
    expect(result.processKeys).toEqual([key]);
    expect(result.metrics).toMatchObject([
      { scope: 'process', deviceId: 'GPU 6', processKey: key, value: 1024 },
      { scope: 'process', deviceId: 'GPU 6', processKey: key, value: 74 },
      { scope: 'process', deviceId: 'GPU 7', processKey: key, value: 0 },
      { scope: 'process', deviceId: 'GPU 7', processKey: key, value: null },
    ]);
  });

  test('rejects PID reuse and unmapped devices and keeps GPU failures separate', () => {
    const result = projectProcessGpu({ status: 'ok', processKeys: [key], samples: [
      { ...sample, keyAfterSample: { ...key, startTicks: '200' } }, { ...sample, deviceId: 'GPU 99' },
    ] }, [key], devices, at);
    expect(result.metrics).toEqual([]);
    expect(projectProcessGpu({ status: 'unavailable', errorCode: 'PROCESS_GPU_TIMEOUT' }, [key], devices, at)).toMatchObject({ state: 'unavailable', metrics: [], errorCode: 'PROCESS_GPU_TIMEOUT' });
    expect(projectProcessGpu({ status: 'none', errorCode: null }, [key], [], at)).toMatchObject({ state: 'unavailable', metrics: [], errorCode: null });
  });
});
