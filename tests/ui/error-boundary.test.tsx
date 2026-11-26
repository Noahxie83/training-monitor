// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/renderer/components/ErrorBoundary';
import { createControlledMockApi } from './fixtures';

const failure = new Error('Telemetry component failed');

function BrokenWindow(): never {
  throw failure;
}

describe('renderer error recovery', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    { surface: 'main', locale: 'en-US', theme: 'light', copy: 'Copy diagnostic information', copied: 'Diagnostic information copied.', reload: 'Reload window' },
    { surface: 'gpu', locale: 'zh-CN', theme: 'dark', copy: '复制诊断信息', copied: '已复制诊断信息。', reload: '重载窗口' },
  ] as const)('offers recovery for the $surface window in $locale', async ({ surface, locale, theme, copy, copied, reload }) => {
    const copyDiagnosticText = vi.fn(async () => undefined);
    vi.stubGlobal('monitor', createControlledMockApi({ preferences: { locale, theme } }));
    vi.stubGlobal('desktop', { copyDiagnosticText });
    const onCaughtError = vi.fn();
    const { container } = render(
      <ErrorBoundary surface={surface}><BrokenWindow /></ErrorBoundary>,
      { onCaughtError },
    );

    fireEvent.click(await screen.findByRole('button', { name: copy }));
    expect((await screen.findByRole('status')).textContent).toBe(copied);
    expect(screen.getByRole('button', { name: reload }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain(failure.message);
    expect(container.firstElementChild?.getAttribute('data-theme')).toBe(theme);
    expect(copyDiagnosticText).toHaveBeenCalledWith(expect.stringContaining(failure.message));
    expect(copyDiagnosticText).toHaveBeenCalledWith(expect.stringContaining('BrokenWindow'));
    expect(onCaughtError).toHaveBeenCalledWith(failure, expect.objectContaining({ componentStack: expect.any(String) }));
  });
});
