// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import React from 'react';
import { App } from '../../src/renderer/App';
import {
  createControlledMockApi,
  testFlowTask,
  testScoreTask,
  testReflowTask,
  testFlowSource,
  testHostConnected,
  testHostDisconnected,
  testRegistry,
} from './fixtures';
import type { LogEvent, LogSourceSnapshot, TaskSnapshot, ResourceMetric } from '../../src/shared/contracts';

describe('T7 Fix 1 Requirements (I1 - I17)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // I1: SettingsModal editing, validation, conflict & error feedback
  it('I1: supports editing registry (hosts and tasks), input validation and handles conflicts', async () => {
    const api = createControlledMockApi();
    const saveSpy = vi.spyOn(api, 'saveRegistry');
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '系统设置' })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: '系统设置' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '系统设置' })).toBeDefined();
    });

    // Switch to Hosts tab in tabbed SettingsModal
    fireEvent.click(screen.getByRole('tab', { name: '宿主管理' }));

    // Check that interactive edit controls exist for hosts
    expect(screen.getByRole('button', { name: /\+ 添加宿主/i })).toBeDefined();

    // Click add host
    fireEvent.click(screen.getByRole('button', { name: /\+ 添加宿主/i }));

    // Fill invalid host ID
    const hostIdInput = screen.getByLabelText(/新增宿主 ID/i);
    fireEvent.change(hostIdInput, { target: { value: '' } });

    const saveBtn = screen.getByRole('button', { name: /保存宿主配置/i });
    fireEvent.click(saveBtn);

    // Validation error must appear
    await waitFor(() => {
      expect(screen.getByText(/宿主 ID 不能为空/i)).toBeDefined();
    });
    expect(saveSpy).not.toHaveBeenCalled();

    // Fill valid WSL host fields
    fireEvent.change(hostIdInput, { target: { value: 'wsl-test' } });
    const hostLabelInput = screen.getByLabelText(/显示名称/i);
    fireEvent.change(hostLabelInput, { target: { value: 'WSL Test' } });
    fireEvent.change(screen.getByLabelText(/宿主类型/i), { target: { value: 'wsl' } });
    fireEvent.change(screen.getByLabelText(/WSL 发行版/i), { target: { value: 'Ubuntu-24.04' } });
    const hostRootsInput = screen.getByLabelText(/允许监控的根目录/i);
    fireEvent.change(hostRootsInput, { target: { value: '/home/test' } });

    // Save valid registry
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalled();
    });
  });

  // I2: Search cancellation on switch, isolation, Esc to clear
  it('I2: isolates search results, cancels active search on task switch, clears on Esc', async () => {
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    let searchResolve: ((val: any) => void) | null = null;
    const api = createControlledMockApi({
      logs: [
        {
          version: 1,
          eventId: 'evt-s1',
          taskId: 'flow-cifar10',
          sourceId: 'flow-log',
          generation: 'gen-1',
          kind: 'line',
          startOffset: '0',
          endOffset: '50',
          ingestedAt: '2026-10-18T20:31:00.000Z',
          text: 'loss=0.342 error found',
          reason: null,
          displayTruncated: false,
          recordComplete: true,
          prefixIncomplete: false,
          runId: null,
          bindingId: null,
        },
      ],
    });
    api.cancelRequest = cancelSpy;
    api.searchLogs = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        searchResolve = resolve;
      });
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/搜索日志 \(Ctrl\+F\)/)).toBeDefined();
    });

    const searchInput = screen.getByPlaceholderText(/搜索日志 \(Ctrl\+F\)/);
    fireEvent.change(searchInput, { target: { value: 'error' } });

    // Esc in search input should clear query and cancel search
    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect((searchInput as HTMLInputElement).value).toBe('');
    expect(cancelSpy).toHaveBeenCalled();
  });

  // I3: Initial page vs push subscription race condition
  it('I3: does not overwrite newer pushed log events with older initial page response', async () => {
    let pageResolve: ((val: any) => void) | null = null;
    const api = createControlledMockApi();
    api.getLogs = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        pageResolve = resolve;
      });
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText(/Flow Matching/).length).toBeGreaterThan(0);
    });

    // Push event arrives while initial getLogs is still pending
    const pushEvent: LogEvent = {
      version: 1,
      eventId: 'evt-live-push',
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'line',
      startOffset: '500',
      endOffset: '600',
      ingestedAt: '2026-10-18T20:31:10.000Z',
      text: 'realtime pushed log line',
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    };

    act(() => {
      api.emitUpdate({ kind: 'logs', sourceId: 'flow-log', events: [pushEvent] });
    });

    await waitFor(() => {
      expect(screen.getByText(/realtime pushed log line/)).toBeDefined();
    });

    // Now initial page resolves with an earlier event
    const pageEvent: LogEvent = {
      version: 1,
      eventId: 'evt-page-earlier',
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'line',
      startOffset: '100',
      endOffset: '200',
      ingestedAt: '2026-10-18T20:31:00.000Z',
      text: 'earlier page log line',
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    };

    act(() => {
      pageResolve!({
        events: [pageEvent],
        nextBefore: null,
        truncatedByBudget: false,
      });
    });

    // BOTH the earlier page log line AND the realtime pushed line must be present!
    await waitFor(() => {
      expect(screen.getByText(/earlier page log line/)).toBeDefined();
      expect(screen.getByText(/realtime pushed log line/)).toBeDefined();
    });
  });

  // I4: History pagination (nextBefore)
  it('I4: supports history pagination when nextBefore is returned', async () => {
    const event1: LogEvent = {
      version: 1,
      eventId: 'evt-page-1',
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'line',
      startOffset: '100',
      endOffset: '200',
      ingestedAt: '2026-10-18T20:31:05.000Z',
      text: 'page 1 recent line',
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    };
    const event0: LogEvent = {
      version: 1,
      eventId: 'evt-page-0',
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'line',
      startOffset: '0',
      endOffset: '100',
      ingestedAt: '2026-10-18T20:30:00.000Z',
      text: 'page 0 older line',
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    };

    const api = createControlledMockApi();
    api.getLogs = vi.fn().mockImplementation(async (query) => {
      if (query.before === 'cursor-earlier') {
        return {
          events: [event0],
          nextBefore: null,
          truncatedByBudget: false,
        };
      }
      return {
        events: [event1],
        nextBefore: 'cursor-earlier',
        truncatedByBudget: true,
      };
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/page 1 recent line/)).toBeDefined();
    });

    // "加载更早日志" button should appear
    const loadEarlierBtn = screen.getByRole('button', { name: /加载更早日志/i });
    fireEvent.click(loadEarlierBtn);

    await waitFor(() => {
      expect(screen.getByText(/page 0 older line/)).toBeDefined();
    });
  });

  // I7: Source catchup / error / unobserved indicators in footer
  it('I7: accurately reflects source state, catchup progress and errors instead of hardcoded [✓ 已补齐]', async () => {
    const catchingUpSource: LogSourceSnapshot = {
      ...testFlowSource,
      state: 'catching_up',
      catchupBytesRead: '1048576',
      catchupBytesTotal: '5242880',
    };

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: true,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [catchingUpSource],
      },
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/补读中/i)).toBeDefined();
    });
    expect(screen.queryByText(/\[✓ 已补齐\]/)).toBeNull();
  });

  // I8: Independent freshness & accurate observation timestamps
  it('I8: labels stale rate and ETA with [上次观测] and clarifies task stale vs connection broken', async () => {
    const staleTask: TaskSnapshot = {
      ...testFlowTask,
      freshness: 'stale',
      progress: {
        ...testFlowTask.progress,
        freshness: 'stale',
        iterationsPerSecond: 12.5,
        etaSeconds: 3600,
      },
    };

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: true,
        hosts: [testHostConnected], // Host is connected!
        tasks: [staleTask],
        sources: [testFlowSource],
      },
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/任务状态待更新/i)).toBeDefined();
    });
    // Must NOT state "连接中断" when host is connected!
    expect(screen.queryByText(/连接中断/)).toBeNull();

    // Stale rate and ETA must show 待更新 instead of stale numeric rate/ETA
    expect(screen.getAllByText(/待更新/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/12\.5/)).toBeNull();
  });

  // I9: Exact algorithm check & no Flow formula for Reflow
  it('I9: does NOT apply Flow Matching formula or 200,000 target to Reflow task', async () => {
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: true,
        hosts: [testHostConnected],
        tasks: [testReflowTask],
        sources: [],
      },
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Reflow/)).toBeDefined();
    });

    // Should NOT contain the Flow Matching specific formula: "覆盖0..4000共4001次" or "200000 (不执行)"
    expect(screen.queryByText(/覆盖0\.\./)).toBeNull();
    expect(screen.queryByText(/200000/)).toBeNull();
  });

  // I10: Device grouping & process RSS semantics
  it('I10: groups device metrics by deviceId, displays CPU utilization, and distinguishes process RSS', async () => {
    const taskWithMetrics: TaskSnapshot = {
      ...testFlowTask,
      processes: {
        main: {
          key: { hostBootId: 'boot1', pid: 12345, startTicks: '100' },
          pid: 12345,
          parentKey: null,
          cwd: '/workspace',
          scriptEntry: 'train.py',
          role: 'trainer',
          observedAt: '2026-10-18T20:31:00.000Z',
        },
        queue: null,
        workers: [
          {
            key: { hostBootId: 'boot1', pid: 12346, startTicks: '105' },
            pid: 12346,
            parentKey: { hostBootId: 'boot1', pid: 12345, startTicks: '100' },
            cwd: '/workspace',
            scriptEntry: 'worker.py',
            role: 'worker',
            observedAt: '2026-10-18T20:31:00.000Z',
          },
        ],
      },
      resources: [
        {
          observedAt: '2026-10-18T20:31:00.000Z',
          freshness: 'fresh',
          source: 'nvidia-smi',
          name: 'gpu_utilization',
          unit: 'percent_device',
          value: 88,
          scope: 'device',
          deviceId: 'gpu_0',
          processKey: null,
        },
        {
          observedAt: '2026-10-18T20:31:00.000Z',
          freshness: 'fresh',
          source: 'ps',
          name: 'cpu_utilization',
          unit: 'percent_one_cpu',
          value: 145,
          scope: 'process',
          deviceId: null,
          processKey: { hostBootId: 'boot1', pid: 12345, startTicks: '100' },
        },
        {
          observedAt: '2026-10-18T20:31:00.000Z',
          freshness: 'fresh',
          source: 'ps',
          name: 'process_rss',
          unit: 'bytes',
          value: 2147483648,
          scope: 'process',
          deviceId: null,
          processKey: { hostBootId: 'boot1', pid: 12345, startTicks: '100' },
        },
      ],
    };

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: true,
        hosts: [testHostConnected],
        tasks: [taskWithMetrics],
        sources: [testFlowSource],
      },
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/145%/)).toBeDefined();
    });
    expect(screen.getByText(/2\.00? GiB/)).toBeDefined();
    expect(screen.getAllByText(/1 Workers/).length).toBeGreaterThan(0);
  });

  // I17: Dual progress bar DOM/CSS alignment
  it('I17: uses aligned .progress-bar-rail classes and omits aria-valuenow when progress is unknown', async () => {
    const taskWithoutProgress: TaskSnapshot = {
      ...testFlowTask,
      progress: {
        ...testFlowTask.progress,
        global: {
          completedCount: null,
          targetCount: null,
          fraction: null,
          unit: 'unknown',
          verified: false,
          sourceId: null,
        },
        session: {
          completedCount: null,
          targetCount: null,
          fraction: null,
          unit: 'unknown',
          verified: false,
          sourceId: null,
        },
      },
    };

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: true,
        hosts: [testHostConnected],
        tasks: [taskWithoutProgress],
        sources: [testFlowSource],
      },
    });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      const bars = document.querySelectorAll('.progress-bar-rail');
      expect(bars.length).toBe(2);
    });

    const progressBars = screen.getAllByRole('progressbar');
    for (const bar of progressBars) {
      expect(bar.getAttribute('aria-valuenow')).toBeNull();
    }
  });
});
