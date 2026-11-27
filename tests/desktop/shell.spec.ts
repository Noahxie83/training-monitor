import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

let app: ElectronApplication;
let page: Page;
let testData: string;

async function launchIsolated(demo = true): Promise<ElectronApplication> {
  const profile = path.join(testData, demo ? 'demo' : 'normal');
  return electron.launch({
    args: [path.resolve('dist/main.cjs'), ...(demo ? ['--demo'] : []), `--user-data-dir=${profile}`],
  });
}

test.beforeAll(async () => {
  testData = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-desktop-'));
  app = await launchIsolated();
  page = await app.firstWindow();
});
test.afterAll(async () => {
  await app?.close();
  if (testData && path.resolve(testData).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(testData, { recursive: true, force: true });
});

test('opens a local demo window with only the frozen preload API', async () => {
  await expect(page.getByText('DEMO', { exact: true })).toBeVisible();
  await expect(page.getByTitle('模拟数据')).toBeVisible();
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  expect(await page.evaluate(() => 'ipcRenderer' in window)).toBe(false);
  expect(await page.evaluate(() => Object.keys(window.monitor).sort())).toEqual([
    'cancelRequest', 'controlTask', 'copyRegisteredPath', 'discoverProcesses', 'exportLogs',
    'getGpuSeries', 'getLogs', 'getMetricSeries', 'getPreferences', 'getRegistry', 'getSnapshot',
    'requestRefresh', 'savePreferences', 'saveRegistry', 'searchLogs', 'subscribe', 'testWebhook',
  ]);
  expect(await page.evaluate(() => window.monitor.getSnapshot().then((s) => s.demo))).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMinimumSize())).toEqual([960, 600]);
});

test('default mode has no demo IDs or measurements', async () => {
  await app.close();
  const normal = await launchIsolated(false);
  try {
    const normalPage = await normal.firstWindow();
    const snapshot = await normalPage.evaluate(() => window.monitor.getSnapshot());
    const registry = await normalPage.evaluate(() => window.monitor.getRegistry());
    expect(snapshot.demo).toBe(false);
    expect(registry.hosts.every(host => !host.enabled)).toBe(true);
    expect(snapshot.hosts.every(host => host.connection === 'unobserved' && host.lastSuccessAt === null && !host.gpu)).toBe(true);
    expect(snapshot.tasks.map(task => task.taskId)).toEqual(registry.tasks.map(task => task.taskId));
    expect(snapshot.tasks.every(task => !task.taskId.startsWith('demo-') && task.resources.length === 0 && !task.currentRun)).toBe(true);
  } finally {
    await normal.close();
    app = await launchIsolated();
    page = await app.firstWindow();
  }
});

test('releases subscriptions on reload and resubscribes exactly once', async () => {
  await page.evaluate(() => {
    (window as any).__updates = 0;
    (window as any).__unsubscribe = window.monitor.subscribe((update) => { if (update.kind === 'snapshot') (window as any).__updates += 1; });
  });
  await page.evaluate(() => window.monitor.requestRefresh({}));
  await expect.poll(() => page.evaluate(() => (window as any).__updates)).toBe(1);
  await page.reload();
  await page.evaluate(() => {
    (window as any).__updates = 0;
    (window as any).__unsubscribe = window.monitor.subscribe((update) => { if (update.kind === 'snapshot') (window as any).__updates += 1; });
  });
  await page.evaluate(() => window.monitor.requestRefresh({}));
  await expect.poll(() => page.evaluate(() => (window as any).__updates)).toBe(1);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__updates)).toBe(1);
});

test('keeps subscriptions through hash and history same-document navigation', async () => {
  await page.reload();
  await page.evaluate(() => {
    (window as any).__updates = 0;
    (window as any).__unsubscribe = window.monitor.subscribe((update) => { if (update.kind === 'snapshot') (window as any).__updates += 1; });
  });
  await page.evaluate(() => window.monitor.requestRefresh({}));
  await expect.poll(() => page.evaluate(() => (window as any).__updates)).toBe(1);

  await page.evaluate(() => { window.location.hash = 'review-same-document'; });
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#review-same-document');
  await page.evaluate(() => window.monitor.requestRefresh({}));
  await expect.poll(() => page.evaluate(() => (window as any).__updates)).toBe(2);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__updates)).toBe(2);

  await page.evaluate(() => { window.history.pushState({}, '', `${window.location.pathname}?review=same-document`); });
  await page.evaluate(() => window.monitor.requestRefresh({}));
  await expect.poll(() => page.evaluate(() => (window as any).__updates)).toBe(3);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__updates)).toBe(3);
  await page.evaluate(() => (window as any).__unsubscribe());
});

test('blocks navigation, popups, permission requests and unregistered path copying', async () => {
  const initialUrl = page.url();
  expect(await page.evaluate(() => window.open('https://example.invalid'))).toBeNull();
  await page.evaluate(() => { window.location.href = 'https://example.invalid/'; });
  await page.waitForTimeout(400);
  expect(page.url()).toBe(initialUrl);
  await expect(page.evaluate(() => window.monitor.copyRegisteredPath({ taskId: 'not-registered' }))).rejects.toThrow(/PATH_NOT_REGISTERED/);
  await expect(page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }))).rejects.toThrow();
});

test('caps subscriptions for one WebContents and preserves the existing subscriptions', async () => {
  const result = await page.evaluate(async () => {
    let updates = 0;
    let rejected = 0;
    const failure = () => { rejected++; };
    window.addEventListener('monitor-subscription-error', failure);
    const unsubs = Array.from({ length: 10 }, () => window.monitor.subscribe((event) => {
      if (event.kind === 'snapshot') updates++;
    }));
    try {
      await window.monitor.getSnapshot();
      await window.monitor.requestRefresh({});
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { updates, rejected };
    } finally {
      unsubs.forEach((unsubscribe) => unsubscribe());
      window.removeEventListener('monitor-subscription-error', failure);
    }
  });
  expect(result.updates).toBeGreaterThan(0);
  expect(result.updates).toBeLessThanOrEqual(8);
  expect(result.rejected + result.updates).toBe(10);
});

test('rejects IPC calls from a window with the preload on an untrusted URL', async () => {
  const untrustedFile = path.join(testData, 'untrusted.html');
  await writeFile(untrustedFile, '<!doctype html><title>Untrusted</title>');
  const result = await app.evaluate(async ({ BrowserWindow }, { preload, untrustedFile }) => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
    try {
      await window.loadFile(untrustedFile);
      return await window.webContents.executeJavaScript(
        'window.monitor.getSnapshot().then(() => "accepted", error => String(error))',
      );
    } finally {
      window.destroy();
    }
  }, { preload: path.resolve('dist/preload.cjs'), untrustedFile });
  expect(result).toContain('UNAUTHORIZED_SENDER');
});

test('binds export to the initiating window and writes only the native selection', async () => {
  const destination = path.join(testData, 'selected.log');
  const rejectedPath = path.join(testData, 'renderer-selected.log');
  await app.evaluate(({ dialog, BrowserWindow }, selected) => {
    const original = dialog.showSaveDialog;
    let calls = 0;
    dialog.showSaveDialog = (async (owner: Electron.BrowserWindow) => {
      if (owner !== BrowserWindow.getAllWindows()[0]) throw new Error('Invalid export window');
      if (calls++ === 0) return { canceled: true, filePath: '' };
      dialog.showSaveDialog = original;
      return { canceled: false, filePath: selected };
    }) as typeof dialog.showSaveDialog;
  }, destination);
  await expect(page.evaluate(() => window.monitor.exportLogs!({ sourceIds: ['demo-log'] }))).resolves
    .toEqual({ exportedCount: 0, path: null, cancelled: true });
  const exported = await page.evaluate((file) => window.monitor.exportLogs!({
    sourceIds: ['demo-log'], literal: 'step=0042', destinationPath: file,
  }), rejectedPath);
  expect(exported).toEqual({ exportedCount: 1, path: destination });
  expect(await readFile(destination, 'utf8')).toContain('step=0042');
  await expect(readFile(rejectedPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('keeps IPC active after ERR_ABORTED interrupts the first navigation', async () => {
  const bootstrap = path.join(testData, 'interrupt-startup.cjs');
  const navigationError = path.join(testData, 'initial-navigation-error');
  await writeFile(bootstrap, `
    const { BrowserWindow } = require('electron');
    const { writeFileSync } = require('node:fs');
    const loadURL = BrowserWindow.prototype.loadURL;
    BrowserWindow.prototype.loadURL = function (url) {
      BrowserWindow.prototype.loadURL = loadURL;
      const first = loadURL.call(this, url);
      setImmediate(() => void loadURL.call(this, url).catch(() => {}));
      return first.catch((error) => {
        writeFileSync(${JSON.stringify(navigationError)}, String(error));
        throw error;
      });
    };
    require(${JSON.stringify(path.resolve('dist/main.cjs'))});
  `);
  const interrupted = await electron.launch({
    args: [bootstrap, '--demo', `--user-data-dir=${path.join(testData, 'interrupted')}`],
  });
  try {
    const interruptedPage = await interrupted.firstWindow();
    await expect(interruptedPage.getByText('DEMO', { exact: true })).toBeVisible();
    expect(await readFile(navigationError, 'utf8')).toContain('ERR_ABORTED');
    await interruptedPage.evaluate(() => window.monitor.requestRefresh({}));
    expect(await interruptedPage.evaluate(() => window.monitor.getSnapshot())).toMatchObject({ demo: true });
  } finally {
    await interrupted.close();
  }
});
