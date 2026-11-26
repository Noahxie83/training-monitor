// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { App } from '../../src/renderer/App';
import { createControlledMockApi } from './fixtures';

describe('Keyboard Shortcuts & Isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('focuses search input on Ctrl+F', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/搜索日志 \(Ctrl\+F\)/)).toBeDefined();
    });

    const searchInput = screen.getByPlaceholderText(/搜索日志 \(Ctrl\+F\)/);
    expect(document.activeElement).not.toBe(searchInput);

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    expect(document.activeElement).toBe(searchInput);
  });

  it('calls requestRefresh on Ctrl+R', async () => {
    const api = createControlledMockApi();
    const refreshSpy = vi.spyOn(api, 'requestRefresh');
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Flow Matching/ })).toBeDefined();
    });

    fireEvent.keyDown(window, { key: 'r', ctrlKey: true });

    expect(refreshSpy).toHaveBeenCalled();
  });

  it('switches task using Ctrl+1, Ctrl+2, Ctrl+3', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Flow Matching/ })).toBeDefined();
    });

    // Press Ctrl+2 to switch to Score-based
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Score-based/ })).toBeDefined();
    });

    // Press Ctrl+3 to switch to Reflow
    fireEvent.keyDown(window, { key: '3', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Reflow/ })).toBeDefined();
    });

    // Press Ctrl+1 to switch back to Flow
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Flow Matching/ })).toBeDefined();
    });
  });

  it('isolates Space key: toggles scroll lock ONLY when log container is focused and not in input/IME/selection', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /日志流视窗/ })).toBeDefined();
    });

    const logContainer = screen.getByRole('region', { name: /日志流视窗/ });

    // Case 1: Active element is an input -> space should NOT toggle lock
    const searchInput = screen.getByPlaceholderText(/搜索日志 \(Ctrl\+F\)/);
    searchInput.focus();

    const inputSpaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    searchInput.dispatchEvent(inputSpaceEvent);
    expect(inputSpaceEvent.defaultPrevented).toBe(false);
    expect(screen.getByRole('button', { name: /锁定自动滚动/ })).toBeDefined();

    // Case 2: During IME composition -> space should NOT toggle lock
    logContainer.focus();
    const imeSpaceEvent = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(imeSpaceEvent, 'isComposing', { value: true });
    logContainer.dispatchEvent(imeSpaceEvent);
    expect(screen.getByRole('button', { name: /锁定自动滚动/ })).toBeDefined();

    // Case 3: With text selection -> space should NOT toggle lock
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'selected text',
    } as any);
    const selectionSpaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    logContainer.dispatchEvent(selectionSpaceEvent);
    expect(screen.getByRole('button', { name: /锁定自动滚动/ })).toBeDefined();

    // Case 4: Pure log container focus with no IME/selection -> space toggles lock!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
    } as any);
    logContainer.focus();
    fireEvent.keyDown(logContainer, { key: ' ' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /恢复自动滚动/ })).toBeDefined();
    });
  });

  it('closes evidence drawer and settings modal on Esc', async () => {
    const api = createControlledMockApi();
    window.monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '任务详情' })).toBeDefined();
    });

    // Open drawer
    fireEvent.click(screen.getByRole('button', { name: '任务详情' }));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '任务详情抽屉' })).toBeDefined();
    });

    // Press Esc
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '任务详情抽屉' })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: '系统设置' }));
    expect(screen.getByRole('dialog', { name: '系统设置' })).toBeDefined();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '系统设置' })).toBeNull();
  });
});
