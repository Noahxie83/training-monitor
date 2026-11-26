import { formatTimeOnly, formatTimestamp } from '../../src/renderer/utils/format';
﻿// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import React from 'react';
import { App } from '../../src/renderer/App';
import { LogConsole } from '../../src/renderer/components/LogConsole';
import { createControlledMockApi, testFlowSource } from './fixtures';
import type { LogEvent } from '../../src/shared/contracts';

describe('Log Console (Virtualization & Controls)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders log events with independent ingestedAt column and raw text', async () => {
    const sampleEvents: LogEvent[] = [
      {
        version: 1,
        eventId: 'evt-1',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'gen-1',
        kind: 'line',
        startOffset: '0',
        endOffset: '100',
        ingestedAt: '2026-10-18T20:30:58.000Z',
        text: 'epoch 1 step 80104 loss=0.342 lr=1e-4',
        reason: null,
        displayTruncated: false,
        recordComplete: true,
        prefixIncomplete: false,
        runId: 'run:v1:flow-1',
        bindingId: 'bind-1',
      },
      {
        version: 1,
        eventId: 'evt-2',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'gen-1',
        kind: 'line',
        startOffset: '100',
        endOffset: '200',
        ingestedAt: '2026-10-18T20:31:02.000Z',
        text: 'epoch 1 step 80105 loss=0.339 lr=1e-4',
        reason: null,
        displayTruncated: false,
        recordComplete: true,
        prefixIncomplete: false,
        runId: 'run:v1:flow-1',
        bindingId: 'bind-1',
      },
    ];

    const api = createControlledMockApi({ logs: sampleEvents });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/epoch 1 step 80104/)).toBeDefined();
    });

    expect(screen.getByText(formatTimeOnly(sampleEvents[0]!.ingestedAt))).toBeDefined();
    expect(screen.getByTitle(`${formatTimestamp(sampleEvents[0]!.ingestedAt)}（本地时间）`)).toBeDefined();
    expect(screen.getByText(/step 80105/)).toBeDefined();
    expect(screen.getByText(formatTimeOnly(sampleEvents[1]!.ingestedAt))).toBeDefined();
  });

  it('shows newest-first API pages in ascending log order across pagination', async () => {
    const makeEvent = (eventId: string, startOffset: string, kind: 'line' | 'redraw', text: string): LogEvent => ({
      version: 1,
      eventId,
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind,
      startOffset,
      endOffset: String(Number(startOffset) + text.length),
      ingestedAt: '2026-10-18T20:31:00.000Z',
      text,
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    });
    const oldest = makeEvent('evt-oldest', '0', 'line', 'order-oldest');
    const redraw = makeEvent('evt-redraw', '0', 'redraw', 'order-redraw');
    const newest = makeEvent('evt-newest', '20', 'line', 'order-newest');
    const api = createControlledMockApi();
    api.getLogs = vi.fn(async (query) => query.before
      ? { events: [oldest], nextBefore: null, truncatedByBudget: false }
      : { events: [newest, redraw], nextBefore: 'older-page', truncatedByBudget: false });
    window.monitor = api;

    render(<App />);
    await screen.findByText('order-newest');

    const rowTexts = () => Array.from(document.querySelectorAll('.log-event-row'))
      .map((row) => row.textContent ?? '')
      .filter((text) => /order-(oldest|redraw|newest)/.test(text));
    await waitFor(() => expect(rowTexts().join('|')).toMatch(/order-redraw.*order-newest/));
    fireEvent.click(screen.getByRole('button', { name: /加载更早日志/ }));

    await waitFor(() => expect(rowTexts().join('|')).toMatch(/order-oldest.*order-redraw.*order-newest/));
    expect(rowTexts().join('|').match(/order-oldest/g)).toHaveLength(1);
    expect(rowTexts().join('|').match(/order-redraw/g)).toHaveLength(1);
    expect(rowTexts().join('|').match(/order-newest/g)).toHaveLength(1);
  });

  it('keeps measured wrapped row positions when log events change', async () => {
    const makeEvent = (eventId: string, text: string): LogEvent => ({
      version: 1,
      eventId,
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'line',
      startOffset: '0',
      endOffset: String(text.length),
      ingestedAt: '2026-10-18T20:31:00.000Z',
      text,
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains('log-event-row') && this.textContent?.includes('wrap-height') ? 50 : 26;
    });
    const events = [makeEvent('evt-wrap', 'wrap-height'), makeEvent('evt-after-wrap', 'following row')];
    const props = {
      sources: [testFlowSource],
      activeSource: testFlowSource,
      activeSourceId: testFlowSource.sourceId,
      onSelectSource: vi.fn(),
      events,
      totalBufferedCount: events.length,
      totalBufferedBytes: 100,
      isScrollLocked: true,
      setIsScrollLocked: vi.fn(),
      unreadCount: 0,
      onResumeAutoScroll: vi.fn(),
      onToggleScrollLock: vi.fn(),
      searchQuery: '',
      onSearchChange: vi.fn(),
      isSearching: false,
      isWrapLines: true,
      onToggleWrapLines: vi.fn(),
      onRefresh: vi.fn(),
    };
    const { container, rerender } = render(<LogConsole {...props} />);
    const rowTop = (eventId: string) => {
      const row = container.querySelector<HTMLElement>(`[data-event-id="${eventId}"]`);
      const top = row?.style.transform.match(/translateY\((\d+)px\)/)?.[1];
      return top == null ? null : Number(top);
    };

    try {
      await waitFor(() => expect(rowTop('evt-after-wrap')).toBe(50));
      const appended = [...events, makeEvent('evt-appended', 'new event')];
      rerender(<LogConsole {...props} events={appended} totalBufferedCount={appended.length} />);
      await waitFor(() => expect(rowTop('evt-after-wrap')).toBe(50));
    } finally {
      offsetHeight.mockRestore();
    }
  });

  it('truncates overlong single line exceeding 64 KiB with indicator', async () => {
    const overlongText = 'A'.repeat(70_000);
    const overlongEvent: LogEvent = {
      version: 1,
      eventId: 'evt-overlong',
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'line',
      startOffset: '0',
      endOffset: '70000',
      ingestedAt: '2026-10-18T20:31:00.000Z',
      text: overlongText,
      reason: null,
      displayTruncated: true,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    };

    const api = createControlledMockApi({ logs: [overlongEvent] });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/已截断过长单行/)).toBeDefined();
    });
  });

  it('upserts redraw events in place without creating duplicate lines', async () => {
    const redraw1: LogEvent = {
      version: 1,
      eventId: 'evt-redraw-tqdm',
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'redraw',
      startOffset: '1000',
      endOffset: '1050',
      ingestedAt: '2026-10-18T20:31:00.000Z',
      text: '47%|████▍ | 80105/169999 [3:34:12<3:56:31, 6.33it/s]',
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: 'run:v1:flow-1',
      bindingId: 'bind-1',
    };

    const redraw2: LogEvent = {
      ...redraw1,
      ingestedAt: '2026-10-18T20:31:05.000Z',
      text: '47%|████▍ | 80106/169999 [3:34:14<3:56:30, 6.33it/s]',
    };

    const api = createControlledMockApi({ logs: [redraw1] });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/80105\/169999/)).toBeDefined();
    });

    // Emit updated redraw event with same eventId
    act(() => {
      api.emitUpdate({ kind: 'logs', sourceId: 'flow-log', events: [redraw2] });
    });

    await waitFor(() => {
      expect(screen.getByText(/80106\/169999/)).toBeDefined();
    });

    // Old line must be replaced, not appended as duplicate
    expect(screen.queryByText(/80105\/169999/)).toBeNull();
  });

  it('displays gap_confirmed, gap_unknown, and cache_evicted banners correctly', async () => {
    const gapEvents: LogEvent[] = [
      {
        version: 1,
        eventId: 'evt-gap-1',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'gen-1',
        kind: 'gap_confirmed',
        startOffset: '1000',
        endOffset: '5000',
        ingestedAt: '2026-10-18T20:31:00.000Z',
        text: null,
        reason: '日志文件在停采期间被远程轮转且历史不可得',
        displayTruncated: false,
        recordComplete: null,
        prefixIncomplete: null,
        runId: null,
        bindingId: null,
      },
      {
        version: 1,
        eventId: 'evt-gap-2',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'gen-1',
        kind: 'gap_unknown',
        startOffset: null,
        endOffset: null,
        ingestedAt: '2026-10-18T20:31:01.000Z',
        text: null,
        reason: '文件截断重写，无法证明曾有未提交数据',
        displayTruncated: false,
        recordComplete: null,
        prefixIncomplete: null,
        runId: null,
        bindingId: null,
      },
      {
        version: 1,
        eventId: 'evt-evict-1',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'gen-1',
        kind: 'cache_evicted',
        startOffset: '0',
        endOffset: '2000',
        ingestedAt: '2026-10-18T20:31:02.000Z',
        text: null,
        reason: '本地已达到容量上限淘汰最旧入库记录',
        displayTruncated: false,
        recordComplete: null,
        prefixIncomplete: null,
        runId: null,
        bindingId: null,
      },
    ];

    const api = createControlledMockApi({ logs: gapEvents });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/确认缺口/)).toBeDefined();
    });

    expect(screen.getByText(/可能缺段/)).toBeDefined();
    expect(screen.getByText(/历史日志已清理/)).toBeDefined();
  });

  it('manages auto-scroll lock and displays unread logs banner', async () => {
    const initialEvent: LogEvent = {
      version: 1,
      eventId: 'evt-base',
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'line',
      startOffset: '0',
      endOffset: '50',
      ingestedAt: '2026-10-18T20:31:00.000Z',
      text: 'initial log line',
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    };

    const api = createControlledMockApi({ logs: [initialEvent] });
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/initial log line/)).toBeDefined();
    });

    // Lock auto-scroll manually via button
    const lockButton = screen.getByRole('button', { name: /锁定自动滚动/ });
    fireEvent.click(lockButton);

    // Add 3 new log events
    const newEvents: LogEvent[] = [1, 2, 3].map((i) => ({
      version: 1,
      eventId: `evt-new-${i}`,
      taskId: 'flow-cifar10',
      sourceId: 'flow-log',
      generation: 'gen-1',
      kind: 'line',
      startOffset: String(i * 50),
      endOffset: String((i + 1) * 50),
      ingestedAt: '2026-10-18T20:31:05.000Z',
      text: `new log line ${i}`,
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    }));

    act(() => {
      api.emitUpdate({ kind: 'logs', sourceId: 'flow-log', events: newEvents });
    });

    // Floating unread banner appears
    await waitFor(() => {
      expect(screen.getByText(/有 3 条新日志/)).toBeDefined();
    });

    // Click resume button in the floating banner
    const resumeButton = screen.getAllByRole('button', { name: /恢复自动滚动/ }).slice(-1)[0];
    fireEvent.click(resumeButton);

    await waitFor(() => {
      expect(screen.queryByText(/有 3 条新日志/)).toBeNull();
    });
  });

  it('searches downloaded logs and cancels old requests on task switch', async () => {
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    const api = createControlledMockApi({ logs: [] });
    api.cancelRequest = cancelSpy;
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/查找日志 \(Ctrl\+F\)/)).toBeDefined();
    });

    expect(screen.getByTitle('搜索已下载的日志')).toBeDefined();

    const searchInput = screen.getByPlaceholderText(/查找日志 \(Ctrl\+F\)/);
    fireEvent.change(searchInput, { target: { value: 'error' } });

    // Switch task
    fireEvent.click(screen.getByText(/Score-based/));

    await waitFor(() => {
      // Previous search should be cancelled
      expect(cancelSpy).toHaveBeenCalled();
    });
  });
});
