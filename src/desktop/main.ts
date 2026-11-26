import { createLaunchLedger } from '../launch/ledger';
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { createMockApi } from '../mocks/api';
import { createProductionApi, type ProductionMonitorApi } from '../collector/service';
import { createPreferencesStore } from '../registry/preferences';
import { createRegistryStore } from '../registry/config';
import { openStore } from '../store/client';
import { createTransport } from '../transport/transport';
import { createGpuWindowManager, createWindow } from './window';
import { registerMonitorIpc } from './ipc';
import { runStoreCanary } from './runtime-canary';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let mainWindow: BrowserWindow | null = null;
let disposeIpc: (() => void) | null = null;
let productionApi: ProductionMonitorApi | null = null;
let shutdownStarted = false;
let quitReady = false;
const demo = process.argv.includes('--demo');
function argument(prefix: string): string | undefined { return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length); }

app.on('second-instance', () => { if (!mainWindow || mainWindow.isDestroyed()) return; if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  disposeIpc?.();
  disposeIpc = null;
  void (async () => {
    await productionApi?.stop();
    productionApi = null;
    quitReady = true;
    app.quit();
  })().catch((error) => {
    console.error(`MONITOR_SHUTDOWN_FAILED ${String(error)}`);
    quitReady = true;
    app.exit(1);
  });
});

if (gotLock) {
  const appDataRoot = path.join(app.getPath('appData'), 'TrainingMonitor');
  app.setPath('userData', appDataRoot);
  void app.whenReady().then(async () => {
    if (process.argv.includes('--sqlite-canary')) {
      const canaryDirectory = argument('--canary-dir=') ?? path.join(os.tmpdir(), 'TrainingMonitor-canary');
      try { const evidence = await runStoreCanary(canaryDirectory); console.log(`SQLITE_CANARY_OK ${JSON.stringify(evidence)}`); console.log(`STORE_CANARY_OK ${JSON.stringify(evidence)}`); app.exit(0); }
      catch (error) { console.error(`STORE_CANARY_FAILED ${String(error)}`); app.exit(1); }
      return;
    }
    let api;
    if (demo) {
      api = createMockApi({ demo: true });
    } else {
      try {
        const userData = app.getPath('userData');
        const registryStore = createRegistryStore(userData);
        const registryProvider = () => registryStore.loadRegistry();
        const preferencesStore = createPreferencesStore(userData);
        const store = await openStore({ directory: userData, now: Date.now }, path.join(__dirname, 'store-worker.cjs'));
        const probeSource = await readFile(path.join(__dirname, 'probe', 'readonly_probe.py'), 'utf8');
        const launcherSource = await readFile(path.join(__dirname, 'launch', 'launcher.py'), 'utf8');
        const serverAgentSource = await readFile(path.join(__dirname, 'launch', 'server_agent.py'), 'utf8');
        productionApi = createProductionApi({
          launchLedger: createLaunchLedger(userData),
          store,
          registryProvider,
          registrySaver: (registry) => registryStore.saveRegistry(registry),
          transportProvider: (host, registry) => createTransport(
            { hostId: host.hostId, host, registry },
            { probeSource, launcherSource, serverAgentSource, registryProvider },
          ),
          clock: Date.now,
          preferencesProvider: () => preferencesStore.load(),
          preferencesSaver: (preferences) => preferencesStore.save(preferences),
        });
        api = productionApi;
        await productionApi.start();
      } catch (error) {
        console.error(`MONITOR_STARTUP_FAILED ${String(error)}`);
        await productionApi?.stop().catch(() => undefined);
        productionApi = null;
        app.exit(1);
        return;
      }
    }
    const gpuWindows = createGpuWindowManager();
    disposeIpc = registerMonitorIpc(api, { openGpuWindow: (hostId) => gpuWindows.open(hostId) });
    mainWindow = createWindow();
    mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  });
}
