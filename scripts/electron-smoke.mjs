import { spawn } from 'node:child_process';
import path from 'node:path';

export async function runCanary(executable, appArgs, directory, expectedOutput) {
  const child = spawn(executable, [
    ...appArgs,
    '--sqlite-canary',
    `--canary-dir=${path.join(directory, 'store')}`,
    `--user-data-dir=${path.join(directory, 'profile')}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.pipe(process.stderr, { end: false });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (timedOut) throw new Error('Electron SQLite canary timed out');
    if (code !== 0 || !output.includes(expectedOutput)) {
      throw new Error(`${expectedOutput} missing or canary failed (exit=${code}, signal=${signal})`);
    }
  } finally {
    clearTimeout(timer);
  }
}
