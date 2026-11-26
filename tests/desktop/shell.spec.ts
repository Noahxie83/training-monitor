import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

let app: ElectronApplication;
let page: Page;
let testData: string;

async function launchIsolated(demo = true): Promise<ElectronApplication> {
  const root = path.join(testData, demo ? 'demo' : 'normal');
  await mkdir(root, { recursive: true });
  const bootstrap = path.join(root, 'bootstrap.cjs');
  await writeFile(bootstrap, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(root)});require(${JSON.stringify(path.resolve('dist/main.cjs'))});`);
  return electron.launch({ args: [bootstrap, ...(demo ? ['--demo'] : []), `--user-data-dir=${path.join(root, 'lock')}`] });
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
  await expect(page.getByText('模拟数据')).toBeVisible();
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
