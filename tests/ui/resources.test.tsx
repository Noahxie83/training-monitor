// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { GpuDeviceMetrics } from '../../src/renderer/components/ResourceMetrics';
import { testFlowTask } from './fixtures';

afterEach(cleanup);

describe('GPU device resources', () => {
  test('shows compact whole-device utilization and combined memory without a training process', () => {
    const task = structuredClone(testFlowTask);
    task.processes = { main: null, queue: null, workers: [] };
    task.resources = task.resources.filter((metric) => metric.scope === 'device').map((metric) => ({ ...metric, deviceId: 'GPU 0' }));

    render(<GpuDeviceMetrics resources={task.resources} />);

    expect(screen.getByText('GPU 0')).toBeDefined();
    expect(screen.getByText('97%')).toBeDefined();
    expect(screen.getByText('9.25 GiB / 24.00 GiB')).toBeDefined();
  });

  test('keeps unknown utilization distinct from zero and marks retained values stale', () => {
    const task = structuredClone(testFlowTask);
    task.resources = task.resources.filter(metric => metric.scope === 'device').map(metric => ({
      ...metric, deviceId: 'GPU 0', freshness: 'stale', value: metric.name === 'gpu_utilization' ? null : metric.value,
    }));
    render(<GpuDeviceMetrics resources={task.resources} />);
    expect(screen.getByRole('meter', { name: 'GPU 0 利用率' }).getAttribute('aria-valuenow')).toBeNull();
    expect(screen.getByText('（待更新）')).toBeDefined();
    expect(screen.queryByText('0%')).toBeNull();
  });

  test('renders eight whole-device groups and preserves a valid zero utilization', () => {
    const task = structuredClone(testFlowTask);
    const metrics = task.resources.filter(metric => metric.scope === 'device');
    task.resources = Array.from({ length: 8 }, (_, index) => metrics.map(metric => ({
      ...metric, deviceId: `GPU ${index}`, value: metric.name === 'gpu_utilization' ? 0 : metric.value,
    }))).flat();
    render(<GpuDeviceMetrics resources={task.resources} />);
    expect(screen.getAllByRole('meter')).toHaveLength(16);
    expect(screen.getByRole('meter', { name: 'GPU 7 利用率' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('GPU 整卡 · 8 张')).toBeDefined();
  });
});
