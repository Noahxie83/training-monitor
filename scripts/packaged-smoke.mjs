import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { runCanary } from './electron-smoke.mjs';

const { name, productName } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const suffix = process.arch === 'x64' ? '' : `-${process.arch}`;
const unpackedPaths = {
  win32: [`win${suffix}-unpacked`, `${productName}.exe`],
  darwin: [`mac${suffix}`, `${productName}.app`, 'Contents', 'MacOS', productName],
  linux: [`linux${suffix}-unpacked`, name],
};
const unpackedPath = unpackedPaths[process.platform];
if (!unpackedPath) throw new Error(`Unsupported packaging platform: ${process.platform}`);

const executablePath = path.resolve('release', ...unpackedPath);
const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-packaged-'));
try {
  await runCanary(executablePath, [], directory, 'SQLITE_CANARY_OK');
  console.log('PACKAGED_SQLITE_CANARY_OK');

  const demoApp = await electron.launch({
    executablePath,
    args: ['--demo', `--user-data-dir=${path.join(directory, 'demo-profile')}`],
    chromiumSandbox: true,
    timeout: 15_000,
  });
  try {
    const page = await demoApp.firstWindow({ timeout: 15_000 });
    const errors = [];
    page.on('console', (message) => {
      if (/content security policy|\bcsp\b/i.test(message.text())) errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    await expect(page.getByTitle('模拟数据')).toBeVisible({ timeout: 15_000 });
    await page.reload({ timeout: 15_000 });
    await expect(page.getByTitle('模拟数据')).toBeVisible({ timeout: 15_000 });
    const snapshot = await page.evaluate(() => window.monitor.getSnapshot());
    expect({ demo: snapshot.demo, tasks: snapshot.tasks.length }).toEqual({ demo: true, tasks: 1 });
    expect(errors).toEqual([]);
    const security = await demoApp.evaluate(({ app, BrowserWindow }) => {
      const { sandbox, contextIsolation, nodeIntegration } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { noSandbox: app.commandLine.hasSwitch('no-sandbox'), sandbox, contextIsolation, nodeIntegration };
    });
    expect(security).toEqual({ noSandbox: false, sandbox: true, contextIsolation: true, nodeIntegration: false });
    console.log('PACKAGED_DEMO_OK');
    console.log('PACKAGED_CSP_OK');
    console.log('PACKAGED_SANDBOX_OK');
  } finally {
    await demoApp.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
