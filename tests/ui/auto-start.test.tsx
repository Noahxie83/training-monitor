// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { createControlledMockApi, testFlowTask, testHostConnected, testRegistry } from './fixtures';
import type { AutoStartConfig, Registry } from '../../src/shared/contracts';
import type { MonitorSnapshot } from '../../src/shared/api';
const baseConfig: AutoStartConfig = { execution: 'server_tmux', enabled: true, armId: '11111111-2222-4333-8444-555555555555', gpuDeviceIds: [], idleSeconds: 60, maxUtilizationPercent: 5, maxMemoryMiB: 1024,
  launch: { pythonPath: '/usr/bin/python3', entryPath: 'torchcfm/examples/images/cifar10/train.py', cwd: '/data2/cy/xzn/Code/Flow_Matching', arguments: '', logSourceId: 'flow-log' } };
function setup(options: { config?: AutoStartConfig; phase?: 'waiting'|'countdown'|'blocked'|'starting'|'started'|'failed'; confirmed?: boolean; registry?: Registry } = {}) {
  const registry = options.registry ?? structuredClone(testRegistry);
  if (options.config) registry.tasks[0]!.autoStart = structuredClone(options.config);
  const task = structuredClone(testFlowTask);
  if (options.config) task.autoStart = { armId: options.config.armId, execution: 'server_tmux', remoteConfirmed: options.confirmed ?? true, sessionName: 'tm-wait-' + 'a'.repeat(40), selectedDeviceId: 'GPU 6',
    phase: options.phase ?? 'waiting', idleElapsedSeconds: 25, requiredIdleSeconds: 60, lastCheckedAt: '2026-11-11T00:00:00Z', startedAt: options.phase === 'started' ? '2026-11-11T00:01:00Z' : null,
    pid: options.phase === 'started' ? 42 : null, errorCode: null, message: options.confirmed === false ? '连接中断，服务器上的等待可能仍在继续' : null };
  const snapshot: MonitorSnapshot = { version: 1, demo: false, hosts: [structuredClone(testHostConnected)], tasks: [task], sources: [] };
  const api = createControlledMockApi({ registry, snapshot }); window.monitor = api;
  const save = vi.spyOn(api, 'saveRegistry'); render(<App />); return { save, api };
}
async function editor() {
  fireEvent.click(await screen.findByRole('button', { name: 'Flow Matching (CIFAR-10)的任务菜单' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '编辑任务' })); return screen.getByRole('dialog', { name: '编辑任务' });
}
afterEach(cleanup);
describe('remote GPU waiting interface', () => {
  it('starts off, explains tmux and all GPUs, and requires no card selection', async () => {
    setup(); const dialog = await editor(); const section = within(dialog).getByRole('region', { name: 'GPU 空闲自动启动' });
    expect((within(section).getByLabelText('启用') as HTMLInputElement).checked).toBe(false);
    expect(section.textContent).toContain('任意一张卡'); expect(section.textContent).toContain('本机关机');
    fireEvent.click(within(section).getByLabelText('启用'));
    expect((within(section).getByLabelText('空闲等待（秒）') as HTMLInputElement).value).toBe('60');
    expect((within(section).getByLabelText('最大利用率（%）') as HTMLInputElement).value).toBe('5');
    expect(within(section).queryByLabelText('GPU 编号')).toBeNull(); expect(within(section).queryByRole('checkbox', { name: /选择 GPU/ })).toBeNull();
  });
  it('saves explicit server hosting with the all-card pool', async () => {
    const { save } = setup(); const dialog = await editor(); fireEvent.click(within(dialog).getByLabelText('启用')); fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(save.mock.calls[0]![0].tasks[0]!.autoStart).toMatchObject({ execution: 'server_tmux', enabled: true, gpuDeviceIds: [], idleSeconds: 60 });
  });
  it('validates duration before submitting a persistent server job', async () => {
    const { save } = setup(); const dialog = await editor(); fireEvent.click(within(dialog).getByLabelText('启用')); fireEvent.change(within(dialog).getByLabelText('空闲等待（秒）'), { target: { value: '0' } });
    fireEvent.submit(dialog.querySelector('form')!); expect((await within(dialog).findByRole('alert')).textContent).toContain('1–86400'); expect(save).not.toHaveBeenCalled();
  });
  it('rejects a launch cwd outside the registered directories', async () => {
    const { save } = setup({ config: baseConfig }); const dialog = await editor(); fireEvent.change(within(dialog).getByLabelText('启动工作目录'), { target: { value: '/tmp/other' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' })); expect((await within(dialog).findByRole('alert')).textContent).toContain('工作目录需位于'); expect(save).not.toHaveBeenCalled();
  });
  it('preserves the arm for an ordinary name edit', async () => {
    const { save } = setup({ config: baseConfig }); const dialog = await editor(); fireEvent.change(within(dialog).getByLabelText('任务名称'), { target: { value: 'New Label' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(save.mock.calls[0]![0].tasks[0]!.autoStart).toEqual(baseConfig);
  });
  it('rotates the arm when changing a server wait condition', async () => {
    const { save } = setup({ config: baseConfig }); const dialog = await editor(); fireEvent.change(within(dialog).getByLabelText('空闲等待（秒）'), { target: { value: '120' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(save.mock.calls[0]![0].tasks[0]!.autoStart!.armId).not.toBe(baseConfig.armId);
  });
  it('rotates the arm when moving the registered output log', async () => {
    const { save } = setup({ config: baseConfig }); const dialog = await editor(); fireEvent.change(within(dialog).getByLabelText('日志路径'), { target: { value: '/data2/cy/xzn/Code/Flow_Matching/new.log' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(save.mock.calls[0]![0].tasks[0]!.autoStart!.armId).not.toBe(baseConfig.armId);
  });
  it('explicitly converts an old desktop rule without silently reusing its arm', async () => {
    const old = { ...baseConfig, execution: undefined, gpuDeviceIds: ['GPU 0', 'GPU 1'] }; const { save } = setup({ config: old }); const dialog = await editor();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0].tasks[0]!.autoStart!; expect(saved.execution).toBe('server_tmux'); expect(saved.gpuDeviceIds).toEqual([]); expect(saved.armId).not.toBe(old.armId);
  });
  it('shows the server candidate and single-card interval', async () => {
    setup({ config: baseConfig, phase: 'countdown' }); const panel = await screen.findByRole('region', { name: 'GPU 空闲自动启动' });
    expect(panel.textContent).toContain('全部 GPU · 任意一张'); expect(within(panel).getByLabelText('空闲倒计时').textContent).toContain('GPU 6'); expect(panel.textContent).toContain('25s / 60s'); expect(panel.textContent).toContain('tmux -L training-monitor-$(id -u)'); expect(panel.textContent).toContain('本机关机后继续等待');
  });
  it('marks disconnected server state unconfirmed without claiming a live countdown', async () => {
    setup({ config: baseConfig, phase: 'blocked', confirmed: false }); const panel = await screen.findByRole('region', { name: 'GPU 空闲自动启动' });
    expect(panel.textContent).toContain('状态待确认'); expect(panel.textContent).toContain('等待可能仍在继续'); expect(within(panel).queryByLabelText('空闲倒计时')).toBeNull();
  });
  it('keeps rearm and disable unavailable while a launch is in flight', async () => {
    setup({ config: baseConfig, phase: 'starting' }); const panel = await screen.findByRole('region', { name: 'GPU 空闲自动启动' });
    expect((within(panel).getByRole('button', { name: '重新等待自动启动' }) as HTMLButtonElement).disabled).toBe(true); expect((within(panel).getByRole('button', { name: '停用自动启动' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('rearms a fresh server job and requests cancellation when disabled', async () => {
    const { save } = setup({ config: baseConfig, phase: 'countdown' }); const panel = await screen.findByRole('region', { name: 'GPU 空闲自动启动' });
    fireEvent.click(within(panel).getByRole('button', { name: '重新等待自动启动' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(save.mock.calls[0]![0].tasks[0]!.autoStart!.armId).not.toBe(baseConfig.armId);
    fireEvent.click(within(panel).getByRole('button', { name: '停用自动启动' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(2)); expect(save.mock.calls[1]![0].tasks[0]!.autoStart!.enabled).toBe(false);
  });
});
