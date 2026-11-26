// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { createControlledMockApi, testRegistry, testFlowTask, testScoreTask, testReflowTask, testHostConnected, testHostWslUnobserved } from './fixtures';
import type { MonitorSnapshot } from '../../src/shared/api';

afterEach(cleanup);

function setup({ empty = false, localTask = false, disabledWsl = false } = {}) {
  const registry = structuredClone(testRegistry);
  registry.hosts[1]!.enabled = !disabledWsl;
  if (empty) registry.tasks = [];
  const snapshot: MonitorSnapshot = { version: 1, demo: false,
    hosts: [structuredClone(testHostConnected), structuredClone(testHostWslUnobserved)],
    tasks: empty ? [] : [structuredClone(testFlowTask), structuredClone(testScoreTask), structuredClone(testReflowTask)], sources: [] };
  if (localTask) {
    registry.tasks.push({ ...structuredClone(testRegistry.tasks[0]!), taskId: 'local-task', hostId: 'wsl-ubuntu', label: '本地实验', sources: [] });
    snapshot.tasks.push({ ...structuredClone(testFlowTask), taskId: 'local-task', hostId: 'wsl-ubuntu' });
  }
  const api = createControlledMockApi({ registry, snapshot });
  const refresh = vi.spyOn(api, 'requestRefresh');
  window.monitor = api;
  render(<App />);
  return { api, refresh, snapshot };
}

describe('host navigation and explicit connection', () => {
  it('keeps the chosen empty host when the initial snapshot arrives late', async () => {
    const registry = structuredClone(testRegistry);
    registry.hosts[1]!.enabled = true;
    const snapshot: MonitorSnapshot = { version: 1, demo: false, hosts: [testHostConnected, testHostWslUnobserved], tasks: [testFlowTask], sources: [] };
    const api = createControlledMockApi({ registry, snapshot });
    let finish!: (value: MonitorSnapshot) => void;
    api.getSnapshot = () => new Promise(resolve => { finish = resolve; });
    window.monitor = api;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '选择宿主 wsl-ubuntu' }));
    await act(async () => { finish(snapshot); });
    expect(screen.getByRole('button', { name: '选择宿主 wsl-ubuntu' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { name: '暂无已登记任务' })).toBeDefined();
  });

  it('selects a host with no tasks without falling back to a task on another host', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '选择宿主 wsl-ubuntu' }));
    expect(screen.getByRole('button', { name: '选择宿主 wsl-ubuntu' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { name: '暂无已登记任务' })).toBeDefined();
    expect(screen.getByText(/为 wsl-ubuntu/)).toBeDefined();
    expect(screen.queryByRole('heading', { name: /Flow Matching/ })).toBeNull();
  });

  it('opens the host overview from host navigation and returns to a task only when selected', async () => {
    setup({ localTask: true });
    fireEvent.click(await screen.findByText('Reflow 2-rectified Flow'));
    await screen.findByRole('heading', { name: 'Reflow 2-rectified Flow' });
    fireEvent.click(screen.getByRole('button', { name: '选择宿主 wsl-ubuntu' }));
    await screen.findByRole('main', { name: '宿主首页' });
    expect(screen.queryByRole('heading', { name: '本地实验' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看 lab-campus' }));
    expect(screen.queryByRole('heading', { name: 'Reflow 2-rectified Flow' })).toBeNull();
    fireEvent.click(screen.getByText('Reflow 2-rectified Flow'));
    await screen.findByRole('heading', { name: 'Reflow 2-rectified Flow' });
  });

  it('switches hosts when selecting a task or using its keyboard shortcut', async () => {
    setup({ localTask: true });
    await screen.findByRole('button', { name: '选择宿主 lab-campus' });
    fireEvent.keyDown(window, { key: '4', ctrlKey: true });
    await screen.findByRole('heading', { name: '本地实验' });
    expect(screen.getByRole('button', { name: '选择宿主 wsl-ubuntu' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    await screen.findByRole('heading', { name: /Flow Matching/ });
    expect(screen.getByRole('button', { name: '选择宿主 lab-campus' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('connects only the selected host, prevents duplicate requests, and uses the returned status', async () => {
    const { api, refresh, snapshot } = setup({ empty: true });
    let finish!: () => void;
    refresh.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    fireEvent.click(await screen.findByRole('button', { name: '选择宿主 wsl-ubuntu' }));
    const panel = screen.getByRole('region', { name: 'wsl-ubuntu连接状态' });
    fireEvent.click(within(panel).getByRole('button', { name: '连接' }));
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ hostId: 'wsl-ubuntu' });
    expect((within(panel).getByRole('button', { name: '连接中…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      api.emitUpdate({ kind: 'snapshot', snapshot: { ...snapshot, hosts: snapshot.hosts.map(host => host.hostId === 'wsl-ubuntu'
        ? { ...host, connection: 'connected', freshness: 'fresh', scanComplete: true, observedAt: '2026-11-05T00:00:00Z', lastSuccessAt: '2026-11-05T00:00:00Z', errorCode: null } : host) } });
      finish();
    });
    await waitFor(() => {
      // Once connected & healthy, inline alert strip auto-collapses and header shows 已连接
      expect(screen.queryByRole('region', { name: 'wsl-ubuntu连接状态' })).toBeNull();
      expect(screen.getByRole('button', { name: 'wsl-ubuntu 连接诊断' }).textContent).toContain('已连接');
    });
    expect(screen.getByRole('button', { name: '选择宿主 wsl-ubuntu' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a useful stopped-WSL reason and retains a retry button', async () => {
    const { api, refresh, snapshot } = setup({ empty: true });
    refresh.mockImplementation(async () => api.emitUpdate({ kind: 'snapshot', snapshot: {
      ...snapshot, hosts: snapshot.hosts.map(host => host.hostId === 'wsl-ubuntu'
        ? { ...host, connection: 'disconnected', freshness: 'unobserved', errorCode: 'WSL_NOT_RUNNING' } : host),
    } }));
    fireEvent.click(await screen.findByRole('button', { name: '选择宿主 wsl-ubuntu' }));
    const panel = screen.getByRole('region', { name: 'wsl-ubuntu连接状态' });
    fireEvent.click(within(panel).getByRole('button', { name: '连接' }));
    await screen.findByText(/WSL 尚未运行，请先启动/);
    expect(within(panel).getByRole('button', { name: '重新连接' })).toBeDefined();
  });

  it('does not enable or connect disabled hosts', async () => {
    const { refresh } = setup({ empty: true, disabledWsl: true });
    fireEvent.click(await screen.findByRole('button', { name: '选择宿主 wsl-ubuntu' }));
    const panel = screen.getByRole('region', { name: 'wsl-ubuntu连接状态' });
    expect(within(panel).getByRole('button', { name: '在设置中启用' })).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('defaults a new task to the host the user selected', async () => {
    setup({ empty: true });
    fireEvent.click(await screen.findByRole('button', { name: '选择宿主 wsl-ubuntu' }));
    fireEvent.click(screen.getByRole('button', { name: '添加第一个任务' }));
    const dialog = screen.getByRole('dialog', { name: '添加任务' });
    expect((within(dialog).getByRole('combobox', { name: '所属宿主' }) as HTMLSelectElement).value).toBe('wsl-ubuntu');
  });
});
