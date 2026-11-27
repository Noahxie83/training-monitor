import { _electron as electron, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

test('hides the main window on close and keeps the GPU monitor live', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-tray-'));
  const app = await electron.launch({ chromiumSandbox: true, args: [path.resolve('dist/main.cjs'), '--demo', `--user-data-dir=${directory}`] });
  try {
    const main = await app.firstWindow();
    const gpuOpened = app.waitForEvent('window');
    await main.getByRole('button', { name: '打开 GPU 实时监控窗口' }).click();
    const gpu = await gpuOpened;
    const mainWindow = await app.browserWindow(main);
    const gpuWindow = await app.browserWindow(gpu);
    await expect.poll(() => gpuWindow.evaluate((window) => window.isVisible())).toBe(true);

    await mainWindow.evaluate((window) => window.close());
    await expect.poll(() => mainWindow.evaluate((window) => window.isVisible())).toBe(false);
    expect(await gpuWindow.evaluate((window) => window.isVisible())).toBe(true);
    await expect(gpu.getByRole('heading', { name: 'GPU 实时监控', exact: true })).toBeVisible();
    await gpu.evaluate(() => window.monitor.requestRefresh({}));

    await gpuWindow.evaluate((window) => window.close());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await mainWindow.evaluate((window) => window.isVisible())).toBe(false);
    await app.evaluate(({ app }) => app.emit('activate'));
    await expect.poll(() => mainWindow.evaluate((window) => window.isVisible())).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('backs up a damaged configuration and continues when the user chooses reset', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-recovery-'));
  try {
    const damaged = '{"theme":';
    const configuration = path.join(directory, 'preferences.json');
    const prompt = path.join(directory, 'recovery-prompt.json');
    const bootstrap = path.join(directory, 'bootstrap.cjs');
    await writeFile(configuration, damaged);
    await writeFile(bootstrap, `
      const { dialog } = require('electron');
      const { writeFileSync } = require('node:fs');
      dialog.showMessageBox = async (options) => {
        writeFileSync(${JSON.stringify(prompt)}, JSON.stringify(options));
        return { response: 0, checkboxChecked: false };
      };
      require(${JSON.stringify(path.resolve('dist/main.cjs'))});
    `);
    const app = await electron.launch({ chromiumSandbox: true, args: [bootstrap, `--user-data-dir=${directory}`] });
    try {
      const main = await app.firstWindow();
      expect(await main.evaluate(() => window.monitor.getPreferences())).toMatchObject({ theme: 'system' });
      const backups = (await readdir(directory)).filter((name) => name.startsWith('preferences.json.corrupt-'));
      expect(backups).toHaveLength(1);
      const backup = path.join(directory, backups[0]!);
      expect(await readFile(backup, 'utf8')).toBe(damaged);
      const recoveryPrompt = JSON.parse(await readFile(prompt, 'utf8'));
      expect(recoveryPrompt).toMatchObject({ type: 'warning', buttons: [expect.any(String), expect.any(String)], defaultId: 0 });
      expect(recoveryPrompt.detail).toContain(backup);
    } finally {
      await app.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fits off-screen saved geometry to the work area and remembers a resized window', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-geometry-'));
  const mainEntry = path.resolve('dist/main.cjs');
  const executable = createRequire(import.meta.url)('electron') as string;
  const profile = `--user-data-dir=${directory}`;
  try {
    await writeFile(path.join(directory, 'preferences.json'), JSON.stringify({
      theme: 'system',
      windowBounds: { main: { x: 50000, y: -50000, width: 1080, height: 720, isMaximized: false } },
    }));
    let savedSize: number[];
    const first = await electron.launch({ chromiumSandbox: true, args: [mainEntry, profile] });
    try {
      const main = await first.firstWindow();
      const nativeWindow = await first.browserWindow(main);
      await expect.poll(() => nativeWindow.evaluate((window) => window.isVisible())).toBe(true);
      const { fits, targetWidth, targetHeight } = await first.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const bounds = window.getBounds();
        const display = screen.getPrimaryDisplay().workArea;
        const [minWidth, minHeight] = window.getMinimumSize();
        return {
          fits: bounds.x >= display.x && bounds.y >= display.y &&
            bounds.x + bounds.width <= display.x + display.width &&
            bounds.y + bounds.height <= display.y + display.height,
          targetWidth: Math.max(minWidth, Math.min(1060, display.width - 16)),
          targetHeight: Math.max(minHeight, Math.min(690, display.height - 16)),
        };
      });
      expect(fits).toBe(true);
      await nativeWindow.evaluate((window, { width, height }) => window.setSize(width, height), { width: targetWidth, height: targetHeight });
      const tolerance = process.platform === 'win32' ? 2 : 0;
      await expect.poll(async () => {
        const [width, height] = await nativeWindow.evaluate((window) => window.getSize());
        return Math.max(Math.abs(width - targetWidth), Math.abs(height - targetHeight));
      }).toBeLessThanOrEqual(tolerance);
      const [width, height] = savedSize = await nativeWindow.evaluate((window) => window.getSize());
      await expect.poll(() => main.evaluate(async () => (await window.monitor.getPreferences()).windowBounds?.main))
        .toMatchObject({ width, height, isMaximized: false });
      await main.evaluate(async () => {
        const preferences = await window.monitor.getPreferences();
        await window.monitor.savePreferences({ ...preferences, minimizeToTrayOnClose: false });
      });
    } finally {
      await first.close();
    }

    // The attached Playwright debugger can hold Electron open after App.quit().
    // Relaunch without a debugger to check that closing the last window exits.
    const bootstrap = path.join(directory, 'reopen.cjs');
    await writeFile(bootstrap, `
      const { app } = require('electron');
      app.once('browser-window-created', (_event, window) => {
        window.webContents.once('did-finish-load', () => {
          console.log('RESTORED_WINDOW_SIZE ' + JSON.stringify(window.getSize()));
          setImmediate(() => window.close());
        });
      });
      require(${JSON.stringify(mainEntry)});
    `);
    const { stdout } = await promisify(execFile)(executable, [bootstrap, profile], { timeout: 10_000 });
    const restored = stdout.match(/^RESTORED_WINDOW_SIZE (\[\d+,\s*\d+\])\s*$/m);
    expect(restored).not.toBeNull();
    const [width, height] = JSON.parse(restored![1]!) as [number, number];
    const tolerance = process.platform === 'win32' ? 4 : 0;
    expect(Math.abs(width - savedSize![0])).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(height - savedSize![1])).toBeLessThanOrEqual(tolerance);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('initializes taskbar progress and applies the login item from saved preferences', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-native-'));
  try {
    const bootstrap = path.join(directory, 'native.cjs');
    const nativeCalls = path.join(directory, 'native-calls.log');
    await writeFile(path.join(directory, 'preferences.json'), JSON.stringify({
      theme: 'system', launchAtLogin: true,
    }));
    await writeFile(bootstrap, `
      const { app, BrowserWindow } = require('electron');
      const { appendFileSync } = require('node:fs');
      const append = (record) => appendFileSync(${JSON.stringify(nativeCalls)}, JSON.stringify(record) + '\\n');
      app.setPath('userData', ${JSON.stringify(directory)});
      app.setPath('appData', ${JSON.stringify(directory)});
      app.setLoginItemSettings = (settings) => append({ login: settings.openAtLogin });
      const setProgressBar = BrowserWindow.prototype.setProgressBar;
      BrowserWindow.prototype.setProgressBar = function(value) {
        append({ progress: value });
        return setProgressBar.call(this, value);
      };
      require(${JSON.stringify(path.resolve('dist/main.cjs'))});
    `);
    const app = await electron.launch({ args: [bootstrap] });
    try {
      const main = await app.firstWindow();
      await main.evaluate(() => window.monitor.getSnapshot());
      expect(await readFile(nativeCalls, 'utf8')).toContain('{"progress":-1}');
      if (process.platform === 'linux') {
        const loginFile = path.join(directory, 'autostart', 'training-monitor.desktop');
        expect(await readFile(loginFile, 'utf8')).toContain('Name=Training Monitor');
        await main.evaluate(async () => {
          const preferences = await window.monitor.getPreferences();
          await window.monitor.savePreferences({ ...preferences, launchAtLogin: false });
        });
        await expect(readFile(loginFile)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(await readFile(nativeCalls, 'utf8')).toContain('{"login":true}');
      }
    } finally {
      await app.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
