// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { createControlledMockApi, testFlowTask, testHostConnected, testRegistry } from './fixtures';
import type { MonitorSnapshot } from '../../src/shared/api';

afterEach(cleanup);

function setup(empty = false) {
  const registry = structuredClone(testRegistry);
  registry.tasks = empty ? [] : [registry.tasks[0]!];
  const staleSnapshot: MonitorSnapshot = { version: 1, demo: false,
    hosts: [structuredClone(testHostConnected)], tasks: [structuredClone(testFlowTask)], sources: [] };
  const api = createControlledMockApi({ registry, snapshot: staleSnapshot });
  window.monitor = api;
  const save = vi.spyOn(api, 'saveRegistry');
  render(<App />);
  return { api, save, registry, staleSnapshot };
}

async function openMenu(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${label}的任务菜单` }));
}

describe('main-page task management', () => {
  it('hides deleted cached tasks, remains empty after a late snapshot, and keeps the add entry on the main page', async () => {
    const { api, staleSnapshot } = setup(true);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '添加任务' }).length).toBeGreaterThan(0));
    expect(screen.getByRole('heading', { name: '暂无已登记任务' })).toBeDefined();
    expect(screen.queryByText('Flow Matching')).toBeNull();
    act(() => api.emitUpdate({ kind: 'snapshot', snapshot: staleSnapshot }));
    expect(screen.getByRole('heading', { name: '暂无已登记任务' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'flow-cifar10' })).toBeNull();
  });

  it('adds from the host plus, selects the new task, and persists in one save', async () => {
    const { save } = setup(true);
    fireEvent.click(await screen.findByRole('button', { name: '向 wsl-ubuntu 添加任务' }));
    const dialog = screen.getByRole('dialog', { name: '添加任务' });
    expect((within(dialog).getByLabelText('所属宿主') as HTMLSelectElement).value).toBe('wsl-ubuntu');
    fireEvent.change(within(dialog).getByLabelText('任务 ID'), { target: { value: 'new-task' } });
    fireEvent.change(within(dialog).getByLabelText('任务名称'), { target: { value: '本地实验' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '算法 / 模型名称（选填）' }), { target: { value: 'Transformer / 自定义算法' } });
    fireEvent.change(within(dialog).getByLabelText('工作目录'), { target: { value: '/home/user/run' } });
    fireEvent.change(within(dialog).getByLabelText('脚本入口'), { target: { value: 'train.py' } });
    fireEvent.change(within(dialog).getByLabelText('日志路径'), { target: { value: '/home/user/run/train.log' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加任务' }));
    await screen.findByRole('heading', { name: '本地实验' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].tasks[0]).toMatchObject({ taskId: 'new-task', label: '本地实验', hostId: 'wsl-ubuntu', algorithm: 'Transformer / 自定义算法', logFormat: 'generic' });
    expect(screen.getByTitle('算法 / 模型').textContent).toBe('Transformer / 自定义算法');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('edits the task from its menu and preserves paths and source IDs', async () => {
    const { save, registry } = setup();
    await openMenu(registry.tasks[0]!.label);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑任务' }));
    const dialog = screen.getByRole('dialog', { name: '编辑任务' });
    expect((within(dialog).getByLabelText('任务 ID') as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole('textbox', { name: '算法 / 模型名称（选填）' }) as HTMLInputElement).value).toBe('Flow Matching');
    expect((within(dialog).getByLabelText('日志识别') as HTMLSelectElement).value).toBe('flow');
    fireEvent.change(within(dialog).getByLabelText('任务名称'), { target: { value: '修改名称' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' }));
    await screen.findByRole('heading', { name: '修改名称' });
    expect(save.mock.calls[0]![0].tasks[0]!.sources).toEqual(registry.tasks[0]!.sources);
    expect(save.mock.calls[0]![0].tasks[0]!.algorithm).toBe('flow');
  });

  it('removes the selected last task immediately and ignores subsequent cached snapshots', async () => {
    const { save, registry, api, staleSnapshot } = setup();
    await openMenu(registry.tasks[0]!.label);
    fireEvent.click(screen.getByRole('menuitem', { name: '移除任务' }));
    await screen.findByRole('heading', { name: '暂无已登记任务' });
    expect(save.mock.calls[0]![0].tasks).toEqual([]);
    act(() => api.emitUpdate({ kind: 'snapshot', snapshot: staleSnapshot }));
    expect(screen.getByRole('heading', { name: '暂无已登记任务' })).toBeDefined();
  });

  it('keeps a task visible when removing it fails and shows the failure', async () => {
    const { save, registry } = setup();
    save.mockRejectedValue(new Error('DISK_WRITE_FAILED'));
    await openMenu(registry.tasks[0]!.label);
    fireEvent.click(screen.getByRole('menuitem', { name: '移除任务' }));
    await screen.findByText('DISK_WRITE_FAILED');
    expect(screen.getByRole('heading', { name: registry.tasks[0]!.label })).toBeDefined();
  });

  it('keeps form input on a save conflict and permits cancel without saving', async () => {
    const { save } = setup(true);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '添加任务' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0]!);
    const dialog = screen.getByRole('dialog', { name: '添加任务' });
    const fill = (name: string, value: string) => fireEvent.change(within(dialog).getByLabelText(name), { target: { value } });
    fill('任务 ID', 'conflict-task'); fill('工作目录', '/data2/cy/xzn/run'); fill('脚本入口', 'train.py'); fill('日志路径', '/data2/cy/xzn/run/train.log');
    save.mockRejectedValue(new Error('REVISION_CONFLICT'));
    fireEvent.click(within(dialog).getByRole('button', { name: '添加任务' }));
    await screen.findByText('REVISION_CONFLICT');
    expect((within(dialog).getByLabelText('任务 ID') as HTMLInputElement).value).toBe('conflict-task');
    expect(within(dialog).getByRole('button', { name: '重新加载配置' })).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('settings contains appearance and hosts, and no task-management table', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '系统设置' }));
    const dialog = screen.getByRole('dialog', { name: '系统设置' });
    expect(within(dialog).getByRole('tab', { name: '外观与语言' })).toBeDefined();
    fireEvent.click(within(dialog).getByRole('tab', { name: '宿主管理' }));
    expect(within(dialog).getByRole('button', { name: '+ 添加宿主' })).toBeDefined();
    expect(within(dialog).queryByText(/任务配置/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /添加任务/ })).toBeNull();
  });
});
