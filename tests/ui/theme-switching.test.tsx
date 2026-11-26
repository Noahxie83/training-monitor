// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { createControlledMockApi } from './fixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('selected light and graphite themes', () => {
  it('switches both ways from the header and saves the preference without changing the selected task', async () => {
    const api = createControlledMockApi({ preferences: { theme: 'light' } });
    const save = vi.spyOn(api, 'savePreferences');
    window.monitor = api;
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '切换到深色主题' }));
    await screen.findByRole('button', { name: '切换到浅色主题' });
    expect(container.querySelector('.app-shell')?.getAttribute('data-theme')).toBe('dark');
    expect(save).toHaveBeenLastCalledWith({ theme: 'dark' });
    expect(container.querySelector('.cockpit-location')?.textContent).toContain('flow-cifar10');
    fireEvent.click(screen.getByRole('button', { name: '切换到浅色主题' }));
    await screen.findByRole('button', { name: '切换到深色主题' });
    expect(save).toHaveBeenLastCalledWith({ theme: 'light' });
  });

  it('reflects the shortcut choice in settings and supports returning to follow-system', async () => {
    const api = createControlledMockApi({ preferences: { theme: 'light' } });
    const save = vi.spyOn(api, 'savePreferences');
    window.monitor = api;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '切换到深色主题' }));
    await screen.findByRole('button', { name: '切换到浅色主题' });
    fireEvent.click(screen.getByRole('button', { name: '系统设置' }));
    expect((screen.getByRole('radio', { name: '深色' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '跟随系统' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ theme: 'system' }));
  });

  it('keeps the old theme and reports the error if saving fails', async () => {
    const api = createControlledMockApi({ preferences: { theme: 'light' } });
    vi.spyOn(api, 'savePreferences').mockRejectedValue(new Error('PREFERENCE_WRITE_FAILED'));
    window.monitor = api;
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '切换到深色主题' }));
    await screen.findByText(/PREFERENCE_WRITE_FAILED/);
    expect(container.querySelector('.app-shell')?.getAttribute('data-theme')).toBe('light');
    expect((screen.getByRole('button', { name: '切换到深色主题' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('follows OS changes only while the stored preference is system', async () => {
    const handlers = new Set<(event: MediaQueryListEvent) => void>();
    const media = { matches: false, addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => handlers.add(fn), removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => handlers.delete(fn) };
    vi.stubGlobal('matchMedia', () => media);
    const api = createControlledMockApi({ preferences: { theme: 'system' } });
    window.monitor = api;
    render(<App />);
    await screen.findByRole('button', { name: '切换到深色主题' });
    act(() => { media.matches = true; for (const handler of handlers) handler({ matches: true } as MediaQueryListEvent); });
    await screen.findByRole('button', { name: '切换到浅色主题' });
    fireEvent.click(screen.getByRole('button', { name: '切换到浅色主题' }));
    await screen.findByRole('button', { name: '切换到深色主题' });
    act(() => { for (const handler of handlers) handler({ matches: true } as MediaQueryListEvent); });
    expect(screen.getByRole('button', { name: '切换到深色主题' })).toBeDefined();
    vi.unstubAllGlobals();
  });
});
