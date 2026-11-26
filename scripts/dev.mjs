import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { context } from 'esbuild';
import electron from 'electron';
import { createServer } from 'vite';
import { desktopBuildOptions, stageDesktopResources } from './desktop-build.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-dev-'));
const out = path.join(directory, 'app');
let server;
let desktop;
let child;
let restart = Promise.resolve();
let stopping = false;
let desktopClose;

async function stopElectron() {
  if (!child) return;
  const running = child;
  child = undefined;
  const closed = new Promise((resolve) => running.once('close', resolve));
  running.kill();
  await closed;
}

function closeDesktop() {
  desktopClose ??= (async () => {
    stopping = true;
    try {
      await stopElectron();
      await desktop?.dispose();
      await restart;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  return desktopClose;
}

try {
  // Vite awaits closeServer hooks before exiting on SIGTERM or closed stdin.
  server = await createServer({
    plugins: [{ name: 'training-monitor-dev-cleanup', closeServer: closeDesktop }],
  });
  function stop() {
    void Promise.all([closeDesktop(), server.close()]).catch((error) => {
      console.error('Could not stop the development server:', error);
      process.exitCode = 1;
    });
  }
  process.prependListener('SIGTERM', stop);
  process.once('SIGINT', stop);
  await server.listen();
  server.printUrls();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('Vite did not expose a loopback renderer URL');
  await stageDesktopResources(out);
  desktop = await context({
    ...desktopBuildOptions(out),
    plugins: [{
      name: 'restart-electron',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length || stopping) return;
          restart = restart.then(async () => {
            await stopElectron();
            if (stopping) return;
            const next = spawn(electron, [
              path.join(out, 'main.cjs'),
              `--user-data-dir=${path.join(directory, 'profile')}`,
              ...process.argv.slice(2),
            ], {
              env: { ...process.env, TRAINING_MONITOR_DEV_URL: url },
              stdio: 'inherit',
            });
            child = next;
            next.once('close', () => { if (child === next) child = undefined; });
            next.once('error', (error) => console.error('Could not launch Electron:', error));
          }).catch((error) => console.error('Could not restart Electron:', error));
        });
      },
    }],
  });
  await desktop.watch();
} catch (error) {
  if (server) await server.close();
  else await closeDesktop();
  throw error;
}
