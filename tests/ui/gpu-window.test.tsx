// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GpuMonitor } from '../../src/renderer/components/GpuMonitor';
import { App } from '../../src/renderer/App';
import { createControlledMockApi, testRegistry, testHostConnected, testHostWslUnobserved, testFlowTask } from './fixtures';
import type { MonitorSnapshot } from '../../src/shared/api';
import type { Preferences } from '../../src/shared/contracts';

afterEach(() => { cleanup(); delete window.desktop; window.history.replaceState({}, '', '/'); });

function setup() {
  const registry = structuredClone(testRegistry);
  registry.hosts[1]!.enabled = true;
  registry.tasks = [];
  const deviceSamples = testFlowTask.resources.filter(metric => metric.scope === 'device');
  const snapshot: MonitorSnapshot = { version: 1, demo: false, tasks: [], sources: [], hosts: [
    { ...structuredClone(testHostConnected), gpu: { observedAt: '2026-11-05T12:00:00Z', state: 'available', errorCode: null,
      metrics: Array.from({ length: 8 }, (_, i) => deviceSamples.map(metric => ({ ...metric, deviceId: `GPU ${i}`, freshness: 'fresh' as const,
        value: metric.name === 'gpu_utilization' ? i * 10 : metric.value }))).flat() } },
    { ...structuredClone(testHostWslUnobserved), connection: 'disconnected', errorCode: 'WSL_NOT_RUNNING' },
  ] };
  const api = createControlledMockApi({ registry, snapshot, preferences: { theme: 'light' } });
  window.monitor = api;
  let hostListener: ((id: string) => void) | undefined;
  let preferencesListener: ((value: Preferences) => void) | undefined;
  const open = vi.fn(async (_id?: string) => {});
  window.desktop = { openGpuWindow: open,
    onGpuHostSelected: listener => { hostListener = listener; return () => { hostListener = undefined; }; },
    onPreferencesChanged: listener => { preferencesListener = listener; return () => { preferencesListener = undefined; }; },
    onRegistryChanged: () => () => {},
  };
  return { api, snapshot, open, select: (id: string) => hostListener?.(id), theme: (value: Preferences) => preferencesListener?.(value) };
}

describe('independent GPU window', () => {
  it('opens from the main page for the selected host even without tasks', async () => {
    const { open } = setup();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '选择宿主 wsl-ubuntu' }));
    fireEvent.click(screen.getByRole('button', { name: '打开 GPU 实时监控窗口' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('wsl-ubuntu');
  });

  it('renders eight device GPUs without any tasks and consumes real-time snapshot updates', async () => {
    const { api, snapshot } = setup();
    render(<GpuMonitor />);
    await screen.findByText('GPU 整卡 · 8 张');
    expect(screen.getByRole('meter', { name: 'GPU 0 利用率' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('meter', { name: 'GPU 7 利用率' }).getAttribute('aria-valuenow')).toBe('70');
    expect(screen.queryByText('训练进程')).toBeNull();
    await act(async () => { api.emitUpdate({ kind: 'snapshot', snapshot: { ...snapshot, hosts: snapshot.hosts.map(host => host.hostId !== 'lab-campus' ? host : {
      ...host, gpu: { ...host.gpu!, metrics: host.gpu!.metrics.map(metric => ({ ...metric, value: metric.name === 'gpu_utilization' ? 42 : metric.value })) },
    }) } }); });
    expect(screen.getByRole('meter', { name: 'GPU 7 利用率' }).getAttribute('aria-valuenow')).toBe('42');
  });

  it('switches devices, shows stopped WSL, and requests refresh only for that host', async () => {
    const { api } = setup();
    const refresh = vi.spyOn(api, 'requestRefresh');
    window.history.replaceState({}, '', '/?view=gpu&hostId=wsl-ubuntu');
    render(<GpuMonitor />);
    await screen.findByText(/WSL 尚未运行/);
    expect(screen.queryByText('GPU 7')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledExactlyOnceWith({ hostId: 'wsl-ubuntu' }));
    fireEvent.click(screen.getByRole('button', { name: /lab-campus/ }));
    await screen.findByText('GPU 7');
  });

  it('marks retained samples stale and keeps unknown distinct from valid zero', async () => {
    const { api, snapshot } = setup();
    render(<GpuMonitor />);
    await screen.findByText('GPU 7');
    await act(async () => { api.emitUpdate({ kind: 'snapshot', snapshot: { ...snapshot, hosts: snapshot.hosts.map(host => host.hostId !== 'lab-campus' ? host : {
      ...host, connection: 'disconnected', errorCode: 'PROBE_TIMEOUT', gpu: { ...host.gpu!, state: 'unavailable', metrics: host.gpu!.metrics.map(metric => ({ ...metric,
        freshness: 'stale' as const, value: metric.deviceId === 'GPU 1' && metric.name === 'gpu_utilization' ? null : metric.value })) },
    }) } }); });
    expect(screen.getByText('当前显示上次采样，等待更新。')).toBeDefined();
    expect(screen.getByRole('meter', { name: 'GPU 0 利用率' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('meter', { name: 'GPU 1 利用率' }).getAttribute('aria-valuenow')).toBeNull();
  });

  it('reuses host-selection messages and syncs the theme from the main window', async () => {
    const { select, theme } = setup();
    const { container } = render(<GpuMonitor />);
    await screen.findByText('GPU 7');
    act(() => { select('wsl-ubuntu'); theme({ theme: 'dark' }); });
    await screen.findByText(/WSL 尚未运行/);
    expect(container.querySelector('.app-shell')?.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: /wsl-ubuntu/ }).getAttribute('aria-pressed')).toBe('true');
  });
});
