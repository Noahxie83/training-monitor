import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const exe = path.resolve('release/win-unpacked/Training Monitor.exe');
const temp = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-packaged-'));
try {
  const child = spawn(exe, ['--sqlite-canary', `--canary-dir=${temp}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, APPDATA: path.join(temp, 'appdata') } });
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; process.stderr.write(chunk); });
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('PACKAGED_CANARY_TIMEOUT')); }, 30000); child.once('error', reject); child.once('exit', (status) => { clearTimeout(timer); resolve(status); }); });
  if (code !== 0 || !output.includes('SQLITE_CANARY_OK')) throw new Error(`PACKAGED_CANARY_FAILED exit=${code}\n${errors}`);
  console.log('PACKAGED_SQLITE_CANARY_OK');
  const demoApp = await electron.launch({ executablePath: exe, args: ['--demo'], env: { ...process.env, APPDATA: path.join(temp, 'demo-appdata') } });
  try { const window = await demoApp.firstWindow(); await expect(window.getByText('模拟数据')).toBeVisible({ timeout: 15000 }); const result = await window.evaluate(() => window.monitor.getSnapshot().then((snapshot) => ({ demo: snapshot.demo, tasks: snapshot.tasks.length }))); if (!result.demo || result.tasks !== 1) throw new Error('PACKAGED_DEMO_FAILED'); console.log('PACKAGED_DEMO_OK'); }
  finally { await demoApp.close(); }
} finally { await rm(temp, { recursive: true, force: true }); }
