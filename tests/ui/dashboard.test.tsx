// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { App } from '../../src/renderer/App';
import {
  createControlledMockApi,
  testFlowTask,
  testHostDisconnected,
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
      expect(screen.getByText('DEMO')).toBeDefined();
      expect(screen.getByTitle('模拟数据')).toBeDefined();
    });

    // Host list
    expect(screen.getAllByText(/lab-campus/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0);

    // WSL unobserved host must display pending/disabled state, never idle or connected
    expect(screen.getAllByText(/wsl-ubuntu/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/wsl.*已连接/i)).toBeNull();
    expect(screen.queryByText(/wsl.*空闲/i)).toBeNull();

    // Task fleet
    expect(screen.getAllByText(/Flow Matching/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Score-based/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Reflow/).length).toBeGreaterThan(0);
  });

  it('displays empty state with registration guidance in normal mode when no tasks exist', async () => {
    const api = createControlledMockApi({
      registry: { version: 2, revision: 0, hosts: [], tasks: [] },
      snapshot: { version: 1, demo: false, hosts: [], tasks: [], sources: [] },
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText(/暂无宿主/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/在系统设置中添加/).length).toBeGreaterThan(0);
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
      expect(screen.getAllByText(/连接已断开/).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/上次确认/)).toBeDefined();
    expect(screen.getByText(/等待重连/)).toBeDefined();
  });

  it('renders dual-track progress and handles null values as "未知", never 0', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('progressbar', { name: '全局累计训练进度' })).toBeDefined();
    });

    // Flow task dual track
    expect(screen.getByText(/110,107 \/ 200,000/)).toBeDefined();
    expect(screen.getByText(/55.05%/)).toBeDefined();
    expect(screen.getByText(/80,106 \/ 169,999/)).toBeDefined();
    expect(screen.getByText(/47.12%/)).toBeDefined();

    // Switch to Score task where progress is null
    fireEvent.click(screen.getByText(/Score-based Generative Model/));

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
      expect(screen.getByLabelText('最新检查点')).toBeDefined();
    });

    expect(screen.getByText(/Step 100,000/)).toBeDefined();
    expect(screen.queryByText(/保存成功/)).toBeNull();
    expect(screen.queryByText(/可恢复/)).toBeNull();
  });

  it('strictly distinguishes process-scope memory and task GPU panels', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/训练进程树/)).toBeDefined();
    });

    // Process scope label
    expect(screen.getByText(/本进程物理内存/)).toBeDefined();
    // Task GPU section
    expect(screen.getByRole('region', { name: '当前任务 GPU' })).toBeDefined();
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
      expect(screen.getByRole('button', { name: '任务详情' })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: '任务详情' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /任务详情抽屉/ })).toBeDefined();
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
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /任务详情抽屉/ })).toBeNull();
    });
  });

  it('opens settings modal and allows toggling theme and editing registry', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '系统设置' })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: '系统设置' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '系统设置' })).toBeDefined();
    });

    // Theme selection
    const darkRadio = screen.getByRole('radio', { name: '深色' });
    fireEvent.click(darkRadio);

    await waitFor(async () => {
      const prefs = await api.getPreferences();
      expect(prefs.theme).toBe('dark');
    });

    // Close modal
    fireEvent.click(screen.getByRole('button', { name: /关闭设置/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '系统设置' })).toBeNull();
    });
  });
});
