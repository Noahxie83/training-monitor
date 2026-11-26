// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import type { Preferences } from '../../src/shared/contracts';
import { createControlledMockApi } from './fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openSettings(api: ReturnType<typeof createControlledMockApi>) {
  window.monitor = api;
  render(<App />);
  await screen.findByRole('heading', { name: 'Flow Matching (CIFAR-10)' });
  await waitFor(() => expect(screen.queryByText('正在读取偏好设置…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '系统设置' }));
  return screen.getByRole('dialog');
}

function themeRadio(dialog: HTMLElement, theme: 'light' | 'dark') {
  return within(dialog).getByRole('radio', { name: theme === 'light' ? '浅色' : '深色' }) as HTMLInputElement;
}

afterEach(cleanup);

describe('I16: actual App settings preference feedback recovery', () => {
  // Break caught: the modal retains its local failure after a successful retry.
  it('clears the visible theme failure when retrying successfully in the same open modal', async () => {
    const recovery = deferred<Preferences>();
    const api = createControlledMockApi({ preferences: { theme: 'dark' } });
    api.savePreferences = vi.fn()
      .mockRejectedValueOnce(new Error('theme save unavailable'))
      .mockReturnValueOnce(recovery.promise);
    const dialog = await openSettings(api);
    const light = themeRadio(dialog, 'light');

    fireEvent.click(light);
    expect((await within(dialog).findByRole('alert')).textContent).toContain('theme save unavailable');
    expect(light.checked).toBe(false);
    expect(themeRadio(dialog, 'dark').checked).toBe(true);
    expect(document.querySelector('.app-shell')?.getAttribute('data-theme')).toBe('dark');
    expect(screen.queryByText('正在保存偏好设置…')).toBeNull();

    fireEvent.click(light);
    expect(screen.getByText('正在保存偏好设置…')).toBeDefined();
    const alertDuringRetry = within(dialog).queryByRole('alert');
    expect(light.checked).toBe(false);
    await act(async () => recovery.resolve({ theme: 'light' }));

    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(light.checked).toBe(true);
    expect(document.querySelector('.app-shell')?.getAttribute('data-theme')).toBe('light');
    expect(document.querySelectorAll('.global-error-banner')).toHaveLength(0);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(alertDuringRetry).toBeNull();
    expect(screen.queryByText('正在保存偏好设置…')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Flow Matching (CIFAR-10)' })).toBeDefined();
  });

  // Break caught: an older preference completion replaces newer UI state.
  it.each(['success', 'failure'] as const)('ignores an older theme %s after newer success in the open modal', async (outcome) => {
    const older = deferred<Preferences>();
    const newer = deferred<Preferences>();
    const api = createControlledMockApi();
    api.savePreferences = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const dialog = await openSettings(api);

    fireEvent.click(themeRadio(dialog, 'dark'));
    fireEvent.click(themeRadio(dialog, 'light'));
    expect(screen.getByText('正在保存偏好设置…')).toBeDefined();
    await act(async () => newer.resolve({ theme: 'light' }));
    expect(themeRadio(dialog, 'light').checked).toBe(true);
    expect(screen.queryByText('正在保存偏好设置…')).toBeNull();
    await act(async () => {
      if (outcome === 'success') older.resolve({ theme: 'dark' });
      else older.reject(new Error('stale theme failure'));
    });

    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(themeRadio(dialog, 'light').checked).toBe(true);
    expect(document.querySelector('.app-shell')?.getAttribute('data-theme')).toBe('light');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(document.querySelectorAll('.global-error-banner')).toHaveLength(0);
    expect(screen.queryByText('正在保存偏好设置…')).toBeNull();
  });

  // Break caught: clearing preference feedback also erases unrelated registration errors.
  it.each(['validation', 'conflict'] as const)('preserves the unrelated registry %s error through theme failure and retry', async (kind) => {
    const failedSave = deferred<Preferences>();
    const recovery = deferred<Preferences>();
    const api = createControlledMockApi();
    api.savePreferences = vi.fn().mockReturnValueOnce(failedSave.promise).mockReturnValueOnce(recovery.promise);
    api.saveRegistry = async () => { throw new Error('409 registry revision conflict'); };
    const dialog = await openSettings(api);
    const ui = within(dialog);
    const expectedError = kind === 'validation' ? '宿主 ID 不能为空' : '409 registry revision conflict';
    if (kind === 'validation') {
      fireEvent.click(ui.getByRole('button', { name: '+ 添加宿主' }));
      fireEvent.click(ui.getByRole('button', { name: '确认添加宿主' }));
    } else {
      fireEvent.click(ui.getByRole('button', { name: '保存宿主配置' }));
    }
    expect((await ui.findByRole('alert')).textContent).toContain(expectedError);

    fireEvent.click(themeRadio(dialog, 'light'));
    await act(async () => failedSave.reject(new Error('theme save unavailable')));
    expect(ui.getByRole('alert').textContent).toContain(expectedError);
    fireEvent.click(themeRadio(dialog, 'light'));
    expect(ui.getByRole('alert').textContent).toContain(expectedError);
    await act(async () => recovery.resolve({ theme: 'light' }));

    expect(themeRadio(dialog, 'light').checked).toBe(true);
    expect(ui.getByRole('alert').textContent).toContain(expectedError);
    expect(ui.getByRole('alert').textContent).not.toContain('theme save unavailable');
    expect(screen.queryByText('正在保存偏好设置…')).toBeNull();
    expect(document.querySelectorAll('.global-error-banner')).toHaveLength(0);
    if (kind === 'conflict') expect(ui.getByRole('button', { name: '重新加载最新配置' })).toBeDefined();
    else expect(ui.getByLabelText('新增宿主 ID:')).toBeDefined();
  });
});
