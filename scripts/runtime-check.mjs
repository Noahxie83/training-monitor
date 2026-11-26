import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

const temp = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-runtime-'));
try {
  const child = spawn(electron, [path.resolve('test-results/runtime/main.cjs'), '--sqlite-canary', `--canary-dir=${path.join(temp, 'store')}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, APPDATA: path.join(temp, 'appdata') } });
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; process.stderr.write(chunk); });
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('ELECTRON_RUNTIME_TIMEOUT')); }, 30000); child.once('error', reject); child.once('exit', (status) => { clearTimeout(timer); resolve(status); }); });
  if (code !== 0 || !output.includes('STORE_CANARY_OK')) throw new Error(`ELECTRON_RUNTIME_FAILED exit=${code}\n${errors}`);
} finally { await rm(temp, { recursive: true, force: true }); }
