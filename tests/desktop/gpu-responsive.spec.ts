import { _electron as electron, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('uses native viewport sizes through maximize, restore and narrow window resizing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-gpu-responsive-'));
  const entry = path.resolve('dist/gpu-fixture-main.cjs');
  await build({ entryPoints: ['tests/desktop/gpu-fixture-main.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:*'] });
  const app = await electron.launch({ args: [entry, `--user-data-dir=${directory}`] });
  try {
    const main = await app.firstWindow();
    const opened = app.waitForEvent('window');
    await main.getByRole('button', { name: '打开 GPU 实时监控窗口' }).click();
    const page = await opened;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.getByRole('meter', { name: 'GPU 7 利用率' }).waitFor();
    const checks: unknown[] = [];
    const measure = () => page.evaluate(() => {
      const list = document.querySelector('.gpu-device-list')!;
      const close = document.querySelector('.gpu-monitor-toolbar .btn-secondary')!.getBoundingClientRect();
      const host = document.querySelector('.gpu-monitor-hostline')!.getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth > innerWidth, closeVisible: close.right <= innerWidth && close.left >= 0,
        hostAboveGpu: host.bottom < list.getBoundingClientRect().top,
        columns: getComputedStyle(list).gridTemplateColumns.split(' ').length,
        gridWidth: list.getBoundingClientRect().width };
    });
    const resize = async (width: number, height: number) => {
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=gpu'))!;
        if (window.isMaximized()) window.unmaximize();
      });
      await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=gpu'))!.isMaximized(),
      )).toBe(false);
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=gpu'))!;
        window.setContentSize(size.width, size.height);
      }, { width, height });
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    };
    await resize(1000, 820);
    const ordinary = await measure();
    expect(ordinary.columns).toBe(2);
    expect(ordinary.hostAboveGpu && ordinary.closeVisible && !ordinary.overflow).toBe(true);
    checks.push({ state: 'ordinary', ...ordinary });
    await page.screenshot({ path: path.resolve('test-results/gpu-window-native-ordinary.png') });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=gpu'))!.maximize());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=gpu'))!.isMaximized())).toBe(true);
    const maximum = await measure();
    expect(maximum.columns).toBe(maximum.width >= 1500 ? 4 : maximum.width <= 700 ? 1 : 2);
    expect(maximum.gridWidth).toBeGreaterThan(maximum.width * 0.85);
    expect(maximum.hostAboveGpu && maximum.closeVisible && !maximum.overflow).toBe(true);
    checks.push({ state: 'maximized', ...maximum });
    await page.screenshot({ path: path.resolve('test-results/gpu-window-native-max-light.png') });
    await page.getByRole('button', { name: '切换到深色主题' }).click();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: path.resolve('test-results/gpu-window-native-max-dark.png') });

    await resize(940, 700);
    const restored = await measure();
    expect(restored.columns).toBe(2);
    expect(restored.hostAboveGpu && restored.closeVisible && !restored.overflow).toBe(true);
    checks.push({ state: 'restored', ...restored });
    await page.screenshot({ path: path.resolve('test-results/gpu-window-native-restored.png') });
    await resize(640, 480);
    const narrow = await measure();
    expect(narrow.columns).toBe(1);
    expect(narrow.hostAboveGpu && narrow.closeVisible && !narrow.overflow).toBe(true);
    checks.push({ state: 'narrow', ...narrow });
    await page.screenshot({ path: path.resolve('test-results/gpu-window-native-small.png') });
    await page.getByRole('meter', { name: 'GPU 7 利用率' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('meter', { name: 'GPU 7 利用率' })).toBeInViewport();
    await page.screenshot({ path: path.resolve('test-results/gpu-window-native-small-bottom.png') });
    await page.getByRole('button', { name: /wsl-ubuntu/ }).click();
    await expect(page.getByText(/WSL 尚未运行/)).toBeVisible();
    await page.screenshot({ path: path.resolve('test-results/gpu-window-native-wsl.png') });
    expect(errors).toEqual([]);
    await writeFile(path.resolve('test-results/gpu-window-native-checks.json'), JSON.stringify({ checks, pageErrors: errors }, null, 2));
  } finally {
    await app.close();
    if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(directory, { recursive: true, force: true });
  }
});
