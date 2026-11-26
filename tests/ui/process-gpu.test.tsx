// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResourceMetrics } from '../../src/renderer/components/ResourceMetrics';
import { HostOverview } from '../../src/renderer/components/HostOverview';
import { testFlowTask, testHostConnected } from './fixtures';
import type { ResourceMetric } from '../../src/shared/contracts';

afterEach(cleanup);
function taskFixture() {
  const task = structuredClone(testFlowTask);
  const key = task.processes.main!.key!;
  task.gpuUsage = { observedAt: '2026-11-11T00:00:00Z', freshness: 'fresh', state: 'available', errorCode: null, processKeys: [key] };
  const metric = (deviceId: string, name: ResourceMetric['name'], value: number | null): ResourceMetric => ({
    source: 'test-process', observedAt: '2026-11-11T00:00:00Z', freshness: 'fresh', name, value,
    unit: name === 'gpu_utilization' ? 'percent_device' : 'bytes', scope: 'process', deviceId, processKey: key,
  });
  task.resources = [
    ...Array.from({ length: 8 }, (_, index) => task.resources.filter(sample => sample.scope === 'device').map(sample => ({ ...sample, deviceId: `GPU ${index}`, value: sample.name === 'gpu_utilization' ? 98 : sample.value }))).flat(),
    metric('GPU 6', 'gpu_utilization', 74), metric('GPU 6', 'gpu_memory_used', 2 * 1024 ** 3),
  ];
  return { task, metric, key };
}

describe('task process GPU resources', () => {
  it('shows only the card used by this task and never substitutes whole-device utilization or memory', () => {
    const { task, key } = taskFixture();
    render(<ResourceMetrics task={task} />);
    expect(screen.getByText('当前任务 GPU · 1 张')).toBeDefined();
    expect(screen.getByText('GPU 6')).toBeDefined();
    expect(screen.getByText('74%')).toBeDefined();
    expect(screen.getByText('2.00 GiB')).toBeDefined();
    expect(screen.getByRole('meter', { name: `GPU 6 PID ${key.pid} 利用率` }).getAttribute('aria-valuenow')).toBe('74');
    expect(screen.queryByText('GPU 7')).toBeNull();
    expect(screen.queryByText('98%')).toBeNull();
    expect(screen.queryByText(/GPU 整卡/)).toBeNull();
  });

  it('supports multiple GPUs, keeps unknown utilization distinct from zero, and marks history stale', () => {
    const { task, metric, key } = taskFixture();
    task.resources.push(metric('GPU 7', 'gpu_utilization', null), metric('GPU 7', 'gpu_memory_used', 0));
    task.gpuUsage!.freshness = 'stale';
    render(<ResourceMetrics task={task} />);
    expect(screen.getByText('当前任务 GPU · 2 张')).toBeDefined();
    expect(screen.getByRole('meter', { name: `GPU 7 PID ${key.pid} 利用率` }).getAttribute('aria-valuenow')).toBeNull();
    expect(screen.getByText('0 B')).toBeDefined();
    expect(screen.getAllByText('上次使用')).toHaveLength(2);
    expect(screen.getAllByText('待更新')).toHaveLength(2);
  });

  it('explains unavailable process attribution instead of showing all GPU cards', () => {
    const { task } = taskFixture();
    task.resources = task.resources.filter(sample => sample.scope === 'device');
    task.gpuUsage = { observedAt: null, freshness: 'unobserved', state: 'unavailable', errorCode: 'WSL_PROCESS_GPU_UNAVAILABLE', processKeys: [] };
    render(<ResourceMetrics task={task} />);
    expect(screen.getByText('当前环境暂不支持进程 GPU 归属识别')).toBeDefined();
    expect(screen.queryByText('GPU 0')).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('retains all whole-device GPU cards on the host overview', () => {
    const { task } = taskFixture();
    render(<HostOverview host={{ ...testHostConnected, gpu: { observedAt: '2026-11-11T00:00:00Z', state: 'available', errorCode: null,
      metrics: task.resources.filter(metric => metric.scope === 'device') } }} taskCount={1} />);
    expect(screen.getByText('GPU 整卡 · 8 张')).toBeDefined();
    expect(screen.getByRole('meter', { name: 'GPU 7 利用率' })).toBeDefined();
    expect(screen.queryByText(/当前任务 GPU/)).toBeNull();
  });
});
