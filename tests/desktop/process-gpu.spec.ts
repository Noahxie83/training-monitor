import { _electron as electron, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('shows task-owned GPU usage in the task and all cards only on the host overview', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-task-gpu-'));
  const entry = path.resolve('dist/process-gpu-fixture.cjs');
  await build({ entryPoints: ['tests/desktop/process-gpu-fixture-main.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:*'] });
  const app = await electron.launch({ args: [entry, `--user-data-dir=${directory}`] });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 800));
    await expect(page.getByRole('region', { name: '当前任务 GPU' })).toBeVisible();
    await expect(page.getByText('当前任务 GPU · 1 张')).toBeVisible();
    await expect(page.getByText('74%', { exact: true })).toBeVisible();
    await expect(page.getByText('2.00 GiB', { exact: true })).toBeVisible();
    await expect(page.getByText('98%', { exact: true })).toHaveCount(0);
    await expect(page.getByText('GPU 7', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.resolve('test-results/process-gpu-task-light.png') });
    await page.getByRole('button', { name: '切换到深色主题' }).click();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark');
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: path.resolve('test-results/process-gpu-task-dark.png') });

    await page.getByRole('button', { name: '选择宿主 lab-campus' }).click();
    await expect(page.getByRole('main', { name: '宿主首页' })).toBeVisible();
    await expect(page.getByText('GPU 整卡 · 8 张')).toBeVisible();
    await expect(page.getByRole('region', { name: '当前任务 GPU' })).toHaveCount(0);
    await page.screenshot({ path: path.resolve('test-results/process-gpu-host-dark.png') });
    await page.getByText('GPU 7', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText('GPU 7', { exact: true })).toBeInViewport();

    await page.getByText('当前训练任务', { exact: true }).click();
    await expect(page.getByRole('region', { name: '当前任务 GPU' })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 650));
    await expect(page.getByText('GPU 6', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: path.resolve('test-results/process-gpu-task-small.png') });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(directory, { recursive: true, force: true });
  }
});
