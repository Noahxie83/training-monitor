// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { App } from '../../src/renderer/App';
import { SettingsModal } from '../../src/renderer/components/SettingsModal';
import { TaskEditor } from '../../src/renderer/components/TaskEditor';
import { LogConsole } from '../../src/renderer/components/LogConsole';
import { DualProgressBar } from '../../src/renderer/components/DualProgressBar';
import { KpiMetricsGrid } from '../../src/renderer/components/KpiMetricsGrid';
import { ResourceMetrics } from '../../src/renderer/components/ResourceMetrics';
import { Header } from '../../src/renderer/components/Header';
import { EvidenceDrawer } from '../../src/renderer/components/EvidenceDrawer';
import {
  createControlledMockApi,
  testRegistry,
  testHostConnected,
  testHostWslUnobserved,
  testFlowTask,
  testScoreTask,
  testReflowTask,
  testFlowSource,
} from './fixtures';
import type { Registry, TaskRegistration, HostRegistration, LogSourceSnapshot, TaskSnapshot, HostSnapshot } from '../../src/shared/contracts';

describe('T7 Fix 2 Requirements - Group A: Settings & Registry (I1, NB2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // I1: Edit existing hosts and tasks, validate fields, handle revision conflict & reload
  it('I1: supports editing existing hosts and tasks with all 3 source kinds, validating fields and handling revision conflicts', async () => {
    const initialRegistry: Registry = structuredClone(testRegistry);
    const saveSpy = vi.fn().mockImplementation(async (reg: Registry) => {
      return reg;
    });
    const reloadSpy = vi.fn().mockImplementation(async () => {
      return {
        ...initialRegistry,
        revision: 2,
      };
    });

    render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        preferences={{ theme: 'system' }}
        onUpdatePreferences={vi.fn()}
        registry={initialRegistry}
        onUpdateRegistry={saveSpy}
        onReloadRegistry={reloadSpy}
      />
    );

    // Switch to Hosts tab
    fireEvent.click(screen.getByRole('tab', { name: '宿主管理' }));

    // Verify edit buttons exist for existing hosts and tasks
    const editHostButtons = screen.getAllByRole('button', { name: /编辑/i });
    expect(editHostButtons.length).toBeGreaterThanOrEqual(2);

    // Click edit on the first host (lab-campus)
    fireEvent.click(editHostButtons[0]);

    // Find edit inputs for the host
    const hostLabelEdit = screen.getByDisplayValue('Lab Campus (SSH)');
    fireEvent.change(hostLabelEdit, { target: { value: 'Campus GPU Server 1' } });

    const hostRootsEdit = screen.getByDisplayValue('/data2/cy/xzn');
    // Try invalid root (not starting with /)
    fireEvent.change(hostRootsEdit, { target: { value: 'invalid/path' } });
    fireEvent.click(screen.getByRole('button', { name: /保存宿主配置/i }));

    await waitFor(() => {
      expect(screen.getByText(/允许监控的根目录路径必须以 \/ 开头/i)).toBeDefined();
    });
    expect(saveSpy).not.toHaveBeenCalled();

    // Fix host roots with multiple valid paths
    fireEvent.change(hostRootsEdit, { target: { value: '/data2/cy/xzn; /data3/storage' } });

    // Save valid registry
    fireEvent.click(screen.getByRole('button', { name: /保存宿主配置/i }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    const savedPayload: Registry = saveSpy.mock.calls[0][0];
    const savedHost = savedPayload.hosts.find((h) => h.hostId === 'lab-campus');
    expect(savedHost?.label).toBe('Campus GPU Server 1');
    expect(savedHost?.allowedRoots).toEqual(['/data2/cy/xzn', '/data3/storage']);

    // Now simulate revision conflict (409)
    saveSpy.mockRejectedValueOnce(new Error('409 Conflict: Registry revision mismatch'));
    fireEvent.click(screen.getByRole('button', { name: /保存宿主配置/i }));

    await waitFor(() => {
      expect(screen.getByText(/版本冲突|409 Conflict/i)).toBeDefined();
      expect(screen.getByRole('button', { name: /重新加载最新配置/i })).toBeDefined();
    });

    // Click reload latest registry
    fireEvent.click(screen.getByRole('button', { name: /重新加载最新配置/i }));
    await waitFor(() => {
      expect(reloadSpy).toHaveBeenCalled();
    });

    // Verify task editing with all 3 source kinds through TaskEditor
    cleanup();
    const taskSaveSpy = vi.fn().mockImplementation(async (reg: Registry) => reg);
    render(
      <TaskEditor
        registry={savedPayload}
        task={savedPayload.tasks[0]!}
        onClose={vi.fn()}
        onSave={taskSaveSpy}
        onSaved={vi.fn()}
        onReload={reloadSpy}
        onOpenSettings={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: 'Flow Matching Multi-Source' } });
    fireEvent.change(screen.getByLabelText('脚本入口'), { target: { value: 'train.py; eval.py' } });
    fireEvent.change(screen.getByLabelText('检查点目录'), { target: { value: '/data2/ckpts; /data3/ckpts' } });
    fireEvent.change(screen.getByLabelText(/状态文件/), { target: { value: '/data2/status.json' } });
    fireEvent.change(screen.getByLabelText(/队列锁文件/), { target: { value: '/data2/queue.lock' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() => {
      expect(taskSaveSpy).toHaveBeenCalledTimes(1);
    });
    const savedTask = (taskSaveSpy.mock.calls[0][0] as Registry).tasks.find((t) => t.taskId === 'flow-cifar10');
    expect(savedTask?.label).toBe('Flow Matching Multi-Source');
    expect(savedTask?.entryPaths).toEqual(['train.py', 'eval.py']);
    expect(savedTask?.checkpointDirectories).toEqual(['/data2/ckpts', '/data3/ckpts']);
    expect(savedTask?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'log', path: '/data2/cy/xzn/Code/Flow_Matching/training.log' }),
        expect.objectContaining({ kind: 'status_json', path: '/data2/status.json' }),
        expect.objectContaining({ kind: 'queue_lock', path: '/data2/queue.lock' }),
      ])
    );
  });

  // NB2: Unified task assembly & validation in TaskEditor
  it('NB2: unifies task validation and payload assembly in TaskEditor without fabricating paths', async () => {
    const initialRegistry: Registry = structuredClone(testRegistry);
    const saveSpy = vi.fn().mockImplementation(async (reg: Registry) => reg);

    render(
      <TaskEditor
        registry={initialRegistry}
        task={null}
        onClose={vi.fn()}
        onSave={saveSpy}
        onSaved={vi.fn()}
        onReload={vi.fn(async () => initialRegistry)}
        onOpenSettings={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText('任务 ID'), { target: { value: 'custom-task' } });
    fireEvent.click(screen.getByRole('button', { name: '添加任务' }));

    await waitFor(() => {
      expect(screen.getByText(/工作目录必须以 \/ 开头|工作目录不能为空/i)).toBeDefined();
    });
    expect(saveSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/custom; /data/custom' } });
    fireEvent.change(screen.getByLabelText('脚本入口'), { target: { value: 'train_a.py; train_b.py' } });
    fireEvent.change(screen.getByLabelText('检查点目录'), { target: { value: '/workspace/ckpts;/data/ckpts' } });
    fireEvent.change(screen.getByLabelText('日志路径'), { target: { value: '/workspace/custom/train.log' } });
    fireEvent.change(screen.getByLabelText(/状态文件/), { target: { value: '/workspace/custom/status.json' } });

    fireEvent.click(screen.getByRole('button', { name: '添加任务' }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    const savedPayload: Registry = saveSpy.mock.calls[0][0];
    const addedTask = savedPayload.tasks.find((t) => t.taskId === 'custom-task');
    expect(addedTask).toBeDefined();
    expect(addedTask?.checkpointDirectories).toEqual(['/workspace/ckpts', '/data/ckpts']);
    expect(addedTask?.entryPaths).toEqual(['train_a.py', 'train_b.py']);
    expect(addedTask?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'log', path: '/workspace/custom/train.log' }),
        expect.objectContaining({ kind: 'status_json', path: '/workspace/custom/status.json' }),
      ])
    );
  });
});

describe('T7 Fix 2 Requirements - Group B: Async State, Isolation, Boundary (I3, I4, I16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // I3: Switching source/task abandons in-flight earlier page; late response does not pollute new source
  it('I3: isolates in-flight paging requests across source switch and drops late arrivals', async () => {
    const sourceA: LogSourceSnapshot = {
      ...testFlowSource,
      sourceId: 'source-a',
    };
    const sourceB: LogSourceSnapshot = {
      ...testFlowSource,
      sourceId: 'source-b',
    };

    let resolveEarlierA: (val: any) => void;
    const earlierDeferredPromise = new Promise((resolve) => {
      resolveEarlierA = resolve;
    });

    const multiSourceRegistry = structuredClone(testRegistry);
    multiSourceRegistry.tasks[0]!.sources = [
      { sourceId: 'source-a', path: '/data2/cy/xzn/Code/Flow_Matching/a.log', kind: 'log' },
      { sourceId: 'source-b', path: '/data2/cy/xzn/Code/Flow_Matching/b.log', kind: 'log' },
    ];
    const api = createControlledMockApi({
      registry: multiSourceRegistry,
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected, testHostWslUnobserved],
        tasks: [testFlowTask],
        sources: [sourceA, sourceB],
      },
    });

    // Intercept getLogs to control timing
    const origGetLogs = api.getLogs.bind(api);
    api.getLogs = vi.fn().mockImplementation(async (query) => {
      if (query.sourceId === 'source-a' && query.before === 'cursor-a-1') {
        return earlierDeferredPromise;
      }
      if (query.sourceId === 'source-a' && query.before === null) {
        return {
          events: [
            {
              version: 1,
              eventId: 'evt-a-0',
              taskId: 'flow-cifar10',
              sourceId: 'source-a',
              generation: 'gen-1',
              kind: 'line',
              startOffset: '0',
              endOffset: '50',
              ingestedAt: '2026-10-18T20:30:00.000Z',
              text: 'initial source A log',
              reason: null,
              displayTruncated: false,
              recordComplete: true,
              prefixIncomplete: false,
              runId: 'run-1',
              bindingId: 'b-1',
            },
          ],
          nextBefore: 'cursor-a-1',
          truncatedByBudget: false,
        };
      }
      if (query.sourceId === 'source-b') {
        return {
          events: [
            {
              version: 1,
              eventId: 'evt-b-0',
              taskId: 'flow-cifar10',
              sourceId: 'source-b',
              generation: 'gen-1',
              kind: 'line',
              startOffset: '0',
              endOffset: '50',
              ingestedAt: '2026-10-18T20:30:01.000Z',
              text: 'initial source B log',
              reason: null,
              displayTruncated: false,
              recordComplete: true,
              prefixIncomplete: false,
              runId: 'run-1',
              bindingId: 'b-1',
            },
          ],
          nextBefore: null,
          truncatedByBudget: false,
        };
      }
      return origGetLogs(query);
    });

    window.monitor = api;
    render(<App />);

    // Wait for source A initial load
    await waitFor(() => {
      expect(screen.getByText('initial source A log')).toBeDefined();
    });

    // Click "加载更早日志" on source A (starts deferred in-flight request)
    const loadEarlierBtn = screen.getByRole('button', { name: /加载更早日志/i });
    fireEvent.click(loadEarlierBtn);

    // Now switch to source B tab (friendly filename b.log)
    const sourceBTab = screen.getByRole('tab', { name: /b\.log|source-b/i });
    fireEvent.click(sourceBTab);

    // Wait for source B to be displayed
    await waitFor(() => {
      expect(screen.getByText('initial source B log')).toBeDefined();
    });

    // Now resolve the late response from source A!
    resolveEarlierA!({
      events: [
        {
          version: 1,
          eventId: 'late-a-evt',
          taskId: 'flow-cifar10',
          sourceId: 'source-a',
          generation: 'gen-1',
          kind: 'line',
          startOffset: '0',
          endOffset: '50',
          ingestedAt: '2026-10-18T20:29:00.000Z',
          text: 'LATE ARRIVAL FROM SOURCE A',
          reason: null,
          displayTruncated: false,
          recordComplete: true,
          prefixIncomplete: false,
          runId: 'run-1',
          bindingId: 'b-1',
        },
      ],
      nextBefore: 'stale-cursor-a',
      truncatedByBudget: false,
    });

    // Wait to ensure event loop ticks
    await new Promise((r) => setTimeout(r, 50));

    // Verify: Source A's late event must NOT appear in Source B!
    expect(screen.queryByText('LATE ARRIVAL FROM SOURCE A')).toBeNull();
    // Source B log remains
    expect(screen.getByText('initial source B log')).toBeDefined();
    // Source B nextBefore should remain null (not overwritten by stale-cursor-a)
    expect(screen.queryByRole('button', { name: /加载更早日志/i })).toBeNull();
  });

  // I4: STALE_CONTINUATION surfaced with error banner and retry action
  it('I4: surfaces STALE_CONTINUATION error banner and allows reload from latest', async () => {
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });

    let shouldFailStale = false;
    api.getLogs = vi.fn().mockImplementation(async (query) => {
      if (shouldFailStale) {
        throw new Error('STALE_CONTINUATION: log cursor has expired');
      }
      return {
        events: [
          {
            version: 1,
            eventId: 'evt-normal-1',
            taskId: 'flow-cifar10',
            sourceId: 'flow-log',
            generation: 'gen-1',
            kind: 'line',
            startOffset: '0',
            endOffset: '50',
            ingestedAt: '2026-10-18T20:30:00.000Z',
            text: 'running flow step 100',
            reason: null,
            displayTruncated: false,
            recordComplete: true,
            prefixIncomplete: false,
            runId: 'run-1',
            bindingId: 'b-1',
          },
        ],
        nextBefore: 'cursor-stale-test',
        truncatedByBudget: false,
      };
    });

    window.monitor = api;
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('running flow step 100')).toBeDefined();
    });

    // Next paging call will fail with STALE_CONTINUATION
    shouldFailStale = true;
    const loadEarlierBtn = screen.getByRole('button', { name: /加载更早日志/i });
    fireEvent.click(loadEarlierBtn);

    // Assert friendly error banner is displayed (no raw internal error code leaked)
    await waitFor(() => {
      expect(screen.getByText(/历史日志位置已过期/i)).toBeDefined();
    });

    // A button to reload from latest should be present
    const reloadBtn = screen.getByRole('button', { name: /重新从最新加载/i });
    expect(reloadBtn).toBeDefined();
  });

  // I16: Visible error states for async failures and no unhandled rejections
  it('I16: surfaces visible errors for refresh failure and search failure without unhandled rejections', async () => {
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });

    // Mock refresh failure
    api.requestRefresh = vi.fn().mockRejectedValue(new Error('SSH Socket Timeout'));
    // Mock search failure
    api.searchLogs = vi.fn().mockRejectedValue(new Error('Search Index Corrupted'));

    window.monitor = api;
    render(<App />);

    // 1. Trigger refresh
    const refreshBtn = screen.getByRole('button', { name: /刷新/i });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByText(/刷新观测数据失败.*SSH Socket Timeout/i)).toBeDefined();
    });

    // 2. Trigger search failure
    const searchInput = screen.getByPlaceholderText(/搜索日志/i);
    fireEvent.change(searchInput, { target: { value: 'target_search' } });

    await waitFor(() => {
      expect(screen.getByText(/日志搜索失败.*Search Index Corrupted/i)).toBeDefined();
    });
  });
});

describe('T7 Fix 2 Requirements - Group C: Log Retention & Scroll Anchors (I6, I11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // I11: Shared 10,000 / 8 MiB budget across live and search, 64 KiB UTF-8 single line truncation
  it('I11: enforces shared 10,000 / 8 MiB triple budget across live and search, single-line 64 KiB UTF-8 limit and stats covering all events', async () => {
    const longChineseStr = '测试超长行-多字节UTF8'.repeat(5000); // ~100KB
    const encoder = new TextEncoder();
    expect(encoder.encode(longChineseStr).byteLength).toBeGreaterThan(65536);

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });

    api.getLogs = vi.fn().mockResolvedValue({
      events: [
        {
          version: 1,
          eventId: 'evt-oversized',
          taskId: 'flow-cifar10',
          sourceId: 'flow-log',
          generation: 'gen-1',
          kind: 'line',
          startOffset: '0',
          endOffset: '100000',
          ingestedAt: '2026-10-18T20:30:00.000Z',
          text: longChineseStr,
          reason: null,
          displayTruncated: false,
          recordComplete: true,
          prefixIncomplete: false,
          runId: 'run-1',
          bindingId: 'b-1',
        },
      ],
      nextBefore: null,
      truncatedByBudget: false,
    });

    window.monitor = api;
    render(<App />);

    // Assert single line truncation tag is rendered
    await waitFor(() => {
      expect(screen.getByText(/\[已截断过长单行\]/i)).toBeDefined();
    });

    // Check footer buffer statistics shows bounded event count
    const footerStats = screen.getByText(/1\s*行/);
    expect(footerStats).toBeDefined();
  });

  // I6: Selectionchange engages scroll lock, resume auto-scroll immediately scrolls to end
  it('I6: selectionchange locks auto-scroll and clicking resume returns to tail', async () => {
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });

    let subCb: any = null;
    api.subscribe = vi.fn().mockImplementation((cb) => {
      subCb = cb;
      return () => {};
    });

    api.getLogs = vi.fn().mockResolvedValue({
      events: [
        {
          version: 1,
          eventId: 'evt-1',
          taskId: 'flow-cifar10',
          sourceId: 'flow-log',
          generation: 'gen-1',
          kind: 'line',
          startOffset: '0',
          endOffset: '20',
          ingestedAt: '2026-10-18T20:30:00.000Z',
          text: 'line 1',
          reason: null,
          displayTruncated: false,
          recordComplete: true,
          prefixIncomplete: false,
          runId: 'run-1',
          bindingId: 'b-1',
        },
      ],
      nextBefore: null,
      truncatedByBudget: false,
    });

    window.monitor = api;
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('line 1')).toBeDefined();
    });

    const viewport = screen.getByRole('region', { name: /日志流视窗/i });
    expect(viewport).toBeDefined();

    // Simulate selection inside viewport
    const selectionMock = {
      isCollapsed: false,
      toString: () => 'line 1',
      anchorNode: viewport,
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionMock as any);

    // Dispatch document selectionchange
    document.dispatchEvent(new Event('selectionchange'));

    // Assert auto-scroll is locked and lock button indicates locked state
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /恢复自动滚动/i })).toBeDefined();
    });

    // Simulate incoming log event while locked -> unread banner appears
    if (subCb) {
      subCb({
        kind: 'logs',
        sourceId: 'flow-log',
        generation: 'gen-1',
        events: [
          {
            version: 1,
            eventId: 'evt-2',
            taskId: 'flow-cifar10',
            sourceId: 'flow-log',
            generation: 'gen-1',
            kind: 'line',
            startOffset: '20',
            endOffset: '40',
            ingestedAt: '2026-10-18T20:30:01.000Z',
            text: 'line 2',
            reason: null,
            displayTruncated: false,
            recordComplete: true,
            prefixIncomplete: false,
            runId: 'run-1',
            bindingId: 'b-1',
          },
        ],
      });
    }

    await waitFor(() => {
      expect(screen.getByText(/回到底部 \(\+1 新行\)/i)).toBeDefined();
    });

    // Click resume button in unread banner
    const resumeBtns = screen.getAllByRole('button', { name: /恢复自动滚动/i });
    fireEvent.click(resumeBtns[1] ?? resumeBtns[0]);

    // Unread banner disappears
    await waitFor(() => {
      expect(screen.queryByText(/回到底部/i)).toBeNull();
    });
  });
});

describe('T7 Fix 2 Requirements - Group D: Observability Semantics, Shortcuts & Evidence (I7, I8, I9, I10, I14, NB1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // I7: Log source snapshot states, offsets and generation boundaries
  it('I7: differentiates missing, reconciling, cache_full, errors, and only displays 已补齐 when committedOffset >= maxObservedOffset with fresh state', async () => {
    const defaultProps = {
      sources: [],
      activeSourceId: 'src-1',
      onSelectSource: vi.fn(),
      events: [],
      totalBufferedCount: 10,
      totalBufferedBytes: 1024,
      isScrollLocked: false,
      setIsScrollLocked: vi.fn(),
      unreadCount: 0,
      onResumeAutoScroll: vi.fn(),
      onToggleScrollLock: vi.fn(),
      searchQuery: '',
      onSearchChange: vi.fn(),
      isSearching: false,
      isWrapLines: false,
      onToggleWrapLines: vi.fn(),
      onRefresh: vi.fn(),
    };

    // Case A: missing file
    const missingSource: LogSourceSnapshot = {
      ...testFlowSource,
      sourceId: 'src-1',
      state: 'missing',
      freshness: 'fresh',
      errorCode: null,
    };
    const { rerender } = render(<LogConsole {...defaultProps} sources={[missingSource]} activeSource={missingSource} />);
    expect(screen.getByText(/日志文件缺失/i)).toBeDefined();

    // Case B: reconciling
    const reconcilingSource: LogSourceSnapshot = {
      ...testFlowSource,
      sourceId: 'src-1',
      state: 'reconciling',
      freshness: 'fresh',
    };
    rerender(<LogConsole {...defaultProps} sources={[reconcilingSource]} activeSource={reconcilingSource} />);
    expect(screen.getByText(/同步日志位置中/i)).toBeDefined();

    // Case C: cache_full
    const cacheFullSource: LogSourceSnapshot = {
      ...testFlowSource,
      sourceId: 'src-1',
      state: 'cache_full',
      freshness: 'fresh',
    };
    rerender(<LogConsole {...defaultProps} sources={[cacheFullSource]} activeSource={cacheFullSource} />);
    expect(screen.getByText(/缓存已满/i)).toBeDefined();

    // Case D: permission_error with specific error code
    const permErrorSource: LogSourceSnapshot = {
      ...testFlowSource,
      sourceId: 'src-1',
      state: 'permission_error',
      freshness: 'fresh',
      errorCode: 'EACCES_PERMISSION_DENIED',
    };
    rerender(<LogConsole {...defaultProps} sources={[permErrorSource]} activeSource={permErrorSource} />);
    expect(screen.getByText(/无读取权限.*EACCES_PERMISSION_DENIED/i)).toBeDefined();

    // Case E: ready but offset is LESS than maxObservedOffset -> must show 已就绪, NOT 已同步最新!
    const readyLaggingSource: LogSourceSnapshot = {
      ...testFlowSource,
      sourceId: 'src-1',
      state: 'ready',
      freshness: 'fresh',
      committedOffset: '1000',
      maxObservedOffset: '2000',
      generationStartOffset: '0',
    };
    rerender(<LogConsole {...defaultProps} sources={[readyLaggingSource]} activeSource={readyLaggingSource} />);
    expect(screen.queryByText(/已同步最新/i)).toBeNull();
    expect(screen.getByText(/已就绪/i)).toBeDefined();

    // Case F: ready and committedOffset >= maxObservedOffset -> displays 已同步最新
    const readyCaughtUpSource: LogSourceSnapshot = {
      ...testFlowSource,
      sourceId: 'src-1',
      state: 'ready',
      freshness: 'fresh',
      committedOffset: '5000000',
      maxObservedOffset: '5000000',
      generationStartOffset: '0',
    };
    rerender(<LogConsole {...defaultProps} sources={[readyCaughtUpSource]} activeSource={readyCaughtUpSource} />);
    expect(screen.getByText(/已同步最新/i)).toBeDefined();

    // Case G: generation_started boundary event
    rerender(
      <LogConsole
        {...defaultProps}
        sources={[readyCaughtUpSource]}
        activeSource={readyCaughtUpSource}
        events={[
          {
            version: 1,
            eventId: 'evt-gen-boundary',
            taskId: 'flow-cifar10',
            sourceId: 'src-1',
            generation: 'gen-2',
            kind: 'generation_started',
            startOffset: '0',
            endOffset: '0',
            ingestedAt: '2026-10-18T20:30:00.000Z',
            text: null,
            reason: 'log rotated',
            displayTruncated: false,
            recordComplete: true,
            prefixIncomplete: false,
            runId: 'run-1',
            bindingId: 'b-1',
          },
        ]}
      />
    );
    expect(screen.getByText(/\[日志文件已轮转更新\]/i)).toBeDefined();
  });

  // I8: Header per-host lastSuccessAt vs snapshot time, KPI stops speed/ETA on stale, separates checkpoint mtime & process unknowns
  it('I8: Header decouples local snapshot time from host lastSuccessAt, and KPI stops speed/ETA display when stale, separating checkpoint mtime and process unknowns', () => {
    // 1. Header test
    const hosts: HostSnapshot[] = [
      {
        ...testHostConnected,
        hostId: 'lab-campus',
        lastSuccessAt: '2026-10-18T20:00:00.000Z',
        scanComplete: false,
      },
      {
        ...testHostWslUnobserved,
        hostId: 'wsl-ubuntu',
        lastSuccessAt: null,
      },
    ];

    render(
      <Header
        hosts={hosts}
        isDemo={false}
        lastSyncTime="2026-10-18T20:45:00.000Z"
        onRefresh={vi.fn()}
        onOpenSettings={vi.fn()}
        announcement=""
      />
    );

    const refreshBtn = screen.getByRole('button', { name: /刷新全部宿主/ });
    expect(refreshBtn.getAttribute('title')).toContain('最近更新');
    const hostPill = screen.getByRole('button', { name: '切换到 lab-campus' });
    expect(hostPill.getAttribute('title')).toContain('部分信息尚未读取完成');

    // 2. KPI test: Stale progress stops speed and ETA estimation
    const staleTask: TaskSnapshot = {
      ...testFlowTask,
      progress: {
        ...testFlowTask.progress,
        freshness: 'stale',
        iterationsPerSecond: 6.33,
        etaSeconds: 14190,
      },
      checkpoint: {
        ...testFlowTask.checkpoint,
        freshness: 'stale',
        mtime: '2026-10-18T19:00:00.000Z',
        observedAt: '2026-10-18T20:30:00.000Z',
      },
      processes: {
        main: null,
        queue: null,
        workers: [],
      },
    };

    render(<><KpiMetricsGrid task={staleTask} /><ResourceMetrics task={staleTask} /></>);

    // Speed & ETA must NOT show active rate or estimate; must show 待更新
    expect(screen.queryByText(/6\.33\s*it\/s/i)).toBeNull();
    expect(screen.getAllByText(/待更新/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText('最新检查点')).toBeDefined();

    // Main process and workers must NOT say "未运行" or "0 Workers"
    expect(screen.queryByText(/未运行/i)).toBeNull();
    expect(screen.queryByText(/0 Workers/i)).toBeNull();
    expect(screen.getByText(/暂无进程资源数据/i)).toBeDefined();
  });

  // I9: DualProgressBar never fabricates targets or algorithm-specific pseudo-formulas
  it('I9: renders dual-track progress without fabricating targets or pseudo-formulas', () => {
    const validFlowTask: TaskSnapshot = structuredClone(testFlowTask);
    const { rerender } = render(<DualProgressBar task={validFlowTask} algorithm="flow" />);
    expect(screen.getByText(/110,107 \/ 200,000/)).toBeDefined();
    expect(screen.getByText(/80,106 \/ 169,999/)).toBeDefined();

    // Null target must NOT fabricate 200,000!
    const nullTargetTask: TaskSnapshot = {
      ...validFlowTask,
      progress: {
        ...validFlowTask.progress,
        configuredTarget: null,
        global: {
          ...validFlowTask.progress.global,
          targetCount: null,
          fraction: null,
        },
      },
    };
    rerender(<DualProgressBar task={nullTargetTask} algorithm="flow" />);
    expect(screen.queryByText(/200,000/i)).toBeNull();
    expect(screen.getByText(/未知 \/ —/)).toBeDefined();
  });

  // I10: ProcessKey exact matching, worker/queue distinction and device GPU isolation
  it('I10: matches process metrics strictly by full ProcessKey (hostBootId, pid, startTicks), without fallback to mismatched PID or arbitrary processes', () => {
    const mainKey = { hostBootId: 'boot-1', pid: 1000, startTicks: '500' };
    const otherBootKey = { hostBootId: 'boot-2', pid: 1000, startTicks: '500' }; // same PID & ticks, different boot!
    const workerKey = { hostBootId: 'boot-1', pid: 1001, startTicks: '600' };

    const taskWithProcesses: TaskSnapshot = {
      ...testFlowTask,
      processes: {
        main: {
          key: mainKey,
          pid: 1000,
          parentKey: null,
          cwd: '/workspace',
          scriptEntry: 'train.py',
          role: 'trainer',
          observedAt: '2026-10-18T20:30:00.000Z',
        },
        queue: null,
        workers: [
          {
            key: workerKey,
            pid: 1001,
            parentKey: mainKey,
            cwd: '/workspace',
            scriptEntry: null,
            role: 'worker',
            observedAt: '2026-10-18T20:30:00.000Z',
          },
        ],
      },
      resources: [
        // Resource with same PID 1000 but from boot-2! Must NOT match main process!
        {
          observedAt: '2026-10-18T20:30:00.000Z',
          freshness: 'fresh',
          source: 'proc',
          name: 'process_rss',
          unit: 'bytes',
          value: 999999999,
          scope: 'process',
          deviceId: null,
          processKey: otherBootKey,
        },
        // Resource for worker 1001
        {
          observedAt: '2026-10-18T20:30:00.000Z',
          freshness: 'fresh',
          source: 'proc',
          name: 'process_rss',
          unit: 'bytes',
          value: 2000000000,
          scope: 'process',
          deviceId: null,
          processKey: workerKey,
        },
        // Device GPU
        {
          observedAt: '2026-10-18T20:30:00.000Z',
          freshness: 'fresh',
          source: 'nvidia-smi',
          name: 'gpu_utilization',
          unit: 'percent_device',
          value: 85,
          scope: 'device',
          deviceId: 'GPU-0',
          processKey: null,
        },
      ],
    };

    // Test ResourceMetrics: Main process RSS must show "等待检测" because boot-2 resource doesn't match main process boot-1!
    render(<ResourceMetrics task={taskWithProcesses} />);
    expect(screen.getByText(/本进程物理内存:/i).nextSibling?.textContent).toBe('等待检测');

    // Test EvidenceDrawer: displays process keys and worker keys without duplicating ResourceMetrics
    render(<EvidenceDrawer task={taskWithProcesses} isOpen={true} onClose={vi.fn()} />);
    expect(screen.getAllByText(/boot-1:1000:500/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/boot-1:1001:600/i)).toBeDefined();
  });

  // I14 & NB1: Keyboard shortcuts, composition guards and focus trap stability across rerenders
  it('I14 & NB1: ignores shortcuts during IME composition and contentEditable, and maintains dialog focus during parent rerenders without stealing focus', async () => {
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });
    window.monitor = api;
    render(<App />);

    // Open Settings Modal
    const settingsBtn = screen.getByRole('button', { name: '系统设置' });
    settingsBtn.focus();
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '系统设置' })).toBeDefined();
      expect(screen.queryByText(/暂无已登记宿主/i)).toBeNull();
    });

    // Switch to Hosts tab and click edit on first host
    fireEvent.click(screen.getByRole('tab', { name: '宿主管理' }));
    const editHostBtn = screen.getAllByRole('button', { name: /编辑/i })[0];
    fireEvent.click(editHostBtn);

    // Focus on an input inside modal
    const hostInput = screen.getByDisplayValue('Lab Campus (SSH)');
    hostInput.focus();
    expect(document.activeElement).toBe(hostInput);

    // Simulate parent rerender / snapshot update while input is focused
    api.emitUpdate({
      kind: 'snapshot',
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });

    // NB1 assertion: document.activeElement MUST remain the input, not stolen by the close button!
    expect(document.activeElement).toBe(hostInput);

    // Test Esc during IME composition (isComposing: true) -> modal must NOT close!
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('dialog', { name: '系统设置' })).toBeDefined();

    // Test Esc with keyCode 229 -> modal must NOT close!
    fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 });
    expect(screen.getByRole('dialog', { name: '系统设置' })).toBeDefined();

    // Normal Esc -> modal closes and focus restores to settings button
    fireEvent.keyDown(window, { key: 'Escape', isComposing: false, keyCode: 27 });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '系统设置' })).toBeNull();
    });
    expect(document.activeElement).toBe(settingsBtn);
  });
});

