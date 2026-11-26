import { _electron as electron, expect, test } from '@playwright/test';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

test('opens, reuses, updates and closes a GPU companion without affecting the main window', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-gpu-window-'));
  const appData = path.join(directory, 'appdata');
  await mkdir(appData);
  const bootstrap = path.join(directory, 'bootstrap.cjs');
  await writeFile(bootstrap, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.resolve('dist/main.cjs'))});`);
  const app = await electron.launch({ args: [bootstrap, '--demo', `--user-data-dir=${path.join(directory, 'lock')}`] });
  try {
    const main = await app.firstWindow();
    await main.getByRole('button', { name: '打开 GPU 实时监控窗口' }).waitFor();
    const gpuOpened = app.waitForEvent('window');
    await main.getByRole('button', { name: '打开 GPU 实时监控窗口' }).click();
    const gpu = await gpuOpened;
    await expect(gpu.getByRole('heading', { name: 'GPU 实时监控', exact: true })).toBeVisible();
    expect(new URL(gpu.url()).searchParams.get('view')).toBe('gpu');
    expect(await gpu.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await gpu.evaluate(() => Object.isFrozen(window.desktop))).toBe(true);
    await main.getByRole('button', { name: '打开 GPU 实时监控窗口' }).click();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);

    await main.evaluate(() => window.monitor.savePreferences({ theme: 'dark' }));
    await expect(gpu.locator('.app-shell')).toHaveAttribute('data-theme', 'dark');
    await gpu.getByRole('button', { name: '切换到浅色主题' }).click();
    await expect(main.locator('.app-shell')).toHaveAttribute('data-theme', 'light');

    await main.evaluate(async () => {
      const registry = await window.monitor.getRegistry();
      await window.monitor.saveRegistry({ ...registry, hosts: [...registry.hosts, { ...registry.hosts[0]!, hostId: 'second-device', label: '第二台设备' }] });
    });
    await expect(gpu.getByRole('button', { name: /second-device/ })).toBeVisible();
    await main.evaluate(() => window.desktop!.openGpuWindow('second-device'));
    await expect(gpu.getByRole('button', { name: /second-device/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(gpu.getByRole('heading', { name: '第二台设备' })).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await expect(main.evaluate(() => window.desktop!.openGpuWindow('not-registered'))).rejects.toThrow(/HOST_NOT_REGISTERED/);
    expect(await gpu.evaluate(() => window.open('https://example.invalid'))).toBeNull();

    await gpu.getByRole('button', { name: '关闭窗口' }).click();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(main.getByRole('heading', { name: '训练监控器' })).toBeVisible();
    const reopened = app.waitForEvent('window');
    await main.evaluate(() => window.desktop!.openGpuWindow('second-device'));
    const nextGpu = await reopened;
    await expect(nextGpu.getByRole('heading', { name: '第二台设备' })).toBeVisible();
    await nextGpu.close();
  } finally {
    await app.close();
    const target = path.resolve(directory);
    if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('UNEXPECTED_TEST_DIRECTORY');
    await rm(target, { recursive: true, force: true });
  }
});
