// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { App } from '../../src/renderer/App';
import {
  createControlledMockApi,
  testFlowTask,
  testScoreTask,
  testReflowTask,
  testHostConnected,
  testHostDisconnected,
  testHostWslUnobserved,
} from './fixtures';

describe('Dashboard (Layout A & Cockpit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders demo badge and active hosts and tasks in demo mode', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('模拟数据')).toBeDefined();
    });

    // Host list
    expect(screen.getByText(/lab-campus/)).toBeDefined();
    expect(screen.getByText(/已连接/)).toBeDefined();

    // WSL unobserved host must display unobserved / waiting probe, never idle or connected
    expect(screen.getByText(/wsl-ubuntu/)).toBeDefined();
    expect(screen.getByText(/未观测 \/ 待探测/)).toBeDefined();
    expect(screen.queryByText(/wsl.*已连接/i)).toBeNull();
    expect(screen.queryByText(/wsl.*空闲/i)).toBeNull();

    // Task fleet
    expect(screen.getByText(/Flow Matching/)).toBeDefined();
    expect(screen.getByText(/Score-based/)).toBeDefined();
    expect(screen.getByText(/Reflow/)).toBeDefined();
  });

  it('displays empty state with registration guidance in normal mode when no tasks exist', async () => {
    const api = createControlledMockApi({
      snapshot: { version: 1, demo: false, hosts: [], tasks: [], sources: [] },
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/暂无已登记任务/)).toBeDefined();
    });
    expect(screen.getByText(/可在右上角【登记 \/ 设置】中添加/)).toBeDefined();
  });

  it('shows stale observation warning when host/task is disconnected', async () => {
    const staleTask = {
      ...testFlowTask,
      freshness: 'stale' as const,
      statusObservedAt: '2026-10-18T20:31:05.000Z',
    };
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostDisconnected],
        tasks: [staleTask],
        sources: [],
      },
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/连接中断/)).toBeDefined();
    });
    expect(screen.getByText(/上次于 2026-10-18T20:31:05.000Z 观测/)).toBeDefined();
    expect(screen.getByText(/当前状态待重连确认/)).toBeDefined();
  });

  it('renders dual-track progress and handles null values as "未知", never 0', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/算法全局累计完成次数/)).toBeDefined();
    });

    // Flow task dual track
    expect(screen.getByText(/110,107 \/ 200,000/)).toBeDefined();
    expect(screen.getByText(/55.05%/)).toBeDefined();
    expect(screen.getByText(/80,106 \/ 169,999/)).toBeDefined();
    expect(screen.getByText(/47.12%/)).toBeDefined();

    // Switch to Score task where progress is null
    fireEvent.click(screen.getByText(/Score-based/));

    await waitFor(() => {
      expect(screen.getAllByText(/排队中/).length).toBeGreaterThan(0);
    });

    // Score task has null completedCount and fraction; must display 未知, NOT 0 or 0%
    const unknowns = screen.getAllByText(/未知|—/);
    expect(unknowns.length).toBeGreaterThan(0);
    expect(screen.queryByText(/0 \/ 0/)).toBeNull();
    expect(screen.queryByText(/0.00%/)).toBeNull();
  });

  it('displays checkpoint evidence level accurately and never claims save verified or recoverable', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/最新检查点文件/)).toBeDefined();
    });

    expect(screen.getByText(/Step 100,000 \(文件名标记\)/)).toBeDefined();
    expect(screen.getByText(/多次观测文件稳定 \(未验证权重恢复\)/)).toBeDefined();
    expect(screen.queryByText(/保存成功/)).toBeNull();
    expect(screen.queryByText(/可恢复/)).toBeNull();
  });

  it('strictly distinguishes device-scope GPU utilization from process-scope memory', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/资源观测分项/)).toBeDefined();
    });

    // Device scope label
    expect(screen.getByText(/GPU 0.*97%.*\[设备整卡\]/)).toBeDefined();
    // Process scope label
    expect(screen.getByText(/本进程物理内存/)).toBeDefined();
  });

  it('copies registered path with visual feedback', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/复制路径/)).toBeDefined();
    });

    const copyBtn = screen.getByRole('button', { name: /复制路径/ });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(api.lastCopied).toEqual({ taskId: 'flow-cifar10' });
      expect(screen.getByText(/已复制/)).toBeDefined();
    });
  });

  it('opens evidence drawer with whitelisted fields only and excludes env vars and syslog', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/证据详情/)).toBeDefined();
    });

    fireEvent.click(screen.getByText(/证据详情/));

    await waitFor(() => {
      expect(screen.getByText(/白名单证据审查/)).toBeDefined();
    });

    expect(screen.getAllByText(/594319/).length).toBeGreaterThan(0); // main PID
    expect(screen.getByText(/594320, 594321/)).toBeDefined(); // worker PIDs
    expect(screen.getAllByText(/\/data2\/cy\/xzn\/Code\/Flow_Matching/).length).toBeGreaterThan(0); // cwd
    expect(screen.getAllByText(/torchcfm\/examples\/images\/cifar10\/train.py/).length).toBeGreaterThan(0); // scriptEntry

    // Strict whitelist: no environment variables or system logs
    expect(screen.queryByText(/CUDA_VISIBLE_DEVICES/)).toBeNull();
    expect(screen.queryByText(/PATH=/)).toBeNull();
    expect(screen.queryByText(/syslog/i)).toBeNull();
    expect(screen.queryByText(/dmesg/i)).toBeNull();

    // Close drawer
    fireEvent.click(screen.getByRole('button', { name: /关闭证据抽屉/ }));
    await waitFor(() => {
      expect(screen.queryByText(/白名单证据审查/)).toBeNull();
    });
  });

  it('opens settings modal and allows toggling theme and editing registry', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /设置 \/ 登记/ })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /设置 \/ 登记/ }));

    await waitFor(() => {
      expect(screen.getByText(/系统偏好与任务登记/)).toBeDefined();
    });

    // Theme selection
    const darkRadio = screen.getByLabelText(/深色模式 \(dark\)/);
    fireEvent.click(darkRadio);

    await waitFor(async () => {
      const prefs = await api.getPreferences();
      expect(prefs.theme).toBe('dark');
    });

    // Close modal
    fireEvent.click(screen.getByRole('button', { name: /关闭设置/ }));
    await waitFor(() => {
      expect(screen.queryByText(/系统偏好与任务登记/)).toBeNull();
    });
  });
});
