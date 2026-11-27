import { app, type BrowserWindow } from 'electron';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createMockApi } from '../mocks/api';
import { createProductionApi, type ProductionMonitorApi } from '../collector/service';
import { createPreferencesStore } from '../registry/preferences';
import { createRegistryStore } from '../registry/config';
import { ConfigRecoveryDeclined } from '../registry/recovery';
import type { MonitorApi, MonitorSnapshot } from '../shared/api';
import type { ConfigRecoveryNotice, Preferences } from '../shared/contracts';
import { openStore } from '../store/client';
import { createTransport, HostSessionPool } from '../transport/transport';
import { configureDefaultSession, createGpuWindowManager, createWindow, createWindowGeometry } from './window';
import { registerMonitorIpc } from './ipc';
import { runStoreCanary } from './runtime-canary';
import { CHANNELS } from './channels';
import { appendJobControlAudit, showDesktopAlert } from './notifications';
import { argument, configureUserData, confirmConfigRecovery, linuxDesktopName, setLaunchAtLogin, showStartupError } from './startup';
import { createMonitorTray } from './tray';

const demo = process.argv.includes('--demo');
const sqliteCanary = process.argv.includes('--sqlite-canary');

function startDesktop(userData: string, isolated: boolean): void {
  let mainWindow: BrowserWindow | undefined;
  let tray: ReturnType<typeof createMonitorTray> | undefined;
  let geometry: ReturnType<typeof createWindowGeometry> | undefined;
  let disposeIpc: (() => void) | undefined;
  let disposeSummary: (() => void) | undefined;
  let productionApi: ProductionMonitorApi | undefined;
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  let sessionPool: HostSessionPool | undefined;
  let createMainWindow: ((observeLoad?: (loading: Promise<void>) => void) => BrowserWindow) | undefined;
  let snapshot: MonitorSnapshot | undefined;
  let preferences: Preferences = { theme: 'system' };
  let selectedTaskId: string | null = null;
  let activeAlertCount = 0;
  let collectionPaused = false;
  let shutdownStarted = false;
  let quitReady = false;
  let checkingStartupConfig = true;

  const confirmRecovery = (notice: ConfigRecoveryNotice) => checkingStartupConfig
    ? confirmConfigRecovery(notice, userData, preferences.locale)
    : true;
  const preferencesStore = createPreferencesStore(userData, { confirmRecovery });

  function showMainWindow(): BrowserWindow | undefined {
    if (shutdownStarted) return;
    const window = mainWindow ?? createMainWindow?.();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  function updateTray(): void {
    tray?.update({
      locale: preferences.locale,
      visible: !!mainWindow?.isVisible() && !mainWindow.isMinimized(),
      running: snapshot?.tasks.filter((task) => task.lifecycle === 'running').length ?? 0,
      alerts: activeAlertCount,
      paused: collectionPaused,
    });
  }

  function updateProgress(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const active = snapshot?.tasks.filter((task) => task.lifecycle === 'running') ?? [];
    const progress = (active.find((task) => task.taskId === selectedTaskId) ?? active[0])?.progress;
    const fromCounts = progress?.current != null && progress.total != null && progress.total > 0
      ? progress.current / progress.total
      : null;
    const fraction = progress?.global.fraction ?? fromCounts ?? progress?.resumedSession?.fraction ?? progress?.session.fraction;
    mainWindow.setProgressBar(typeof fraction === 'number' && Number.isFinite(fraction)
      ? Math.min(1, Math.max(0, fraction))
      : -1);
  }

  let preferencesTail = Promise.resolve();
  function savePreferences(value: Preferences): Promise<Preferences> {
    const saved = preferencesTail.then(async () => {
      const previous = (await preferencesStore.load()).launchAtLogin ?? false;
      const enabled = value.launchAtLogin ?? false;
      const updateLoginItem = !isolated && previous !== enabled;
      if (updateLoginItem) await setLaunchAtLogin(enabled);
      try {
        return await preferencesStore.save(value);
      } catch (error) {
        if (updateLoginItem) {
          await setLaunchAtLogin(previous).catch((reason) => console.error('MONITOR_LOGIN_ITEM_ROLLBACK_FAILED', reason));
        }
        throw error;
      }
    });
    preferencesTail = saved.then(() => undefined, () => undefined);
    return saved;
  }

  async function releaseResources(): Promise<void> {
    disposeIpc?.();
    disposeSummary?.();
    tray?.destroy();
    tray = undefined;
    try {
      if (productionApi) await productionApi.stop();
      else await store?.close();
    } finally {
      try {
        await sessionPool?.closeAll();
      } finally {
        await preferencesTail;
        geometry?.flush();
        await preferencesStore.flush();
      }
    }
  }

  app.on('second-instance', showMainWindow);
  app.on('activate', showMainWindow);
  app.on('window-all-closed', () => {
    if (!shutdownStarted && preferences.minimizeToTrayOnClose === false) app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void starting.then(releaseResources).then(() => {
      quitReady = true;
      app.quit();
    }).catch((error) => {
      console.error('MONITOR_SHUTDOWN_FAILED', error);
      app.exit(1);
    });
  });

  const starting = app.whenReady().then(async () => {
    if (app.isPackaged && process.platform === 'linux' && app.commandLine.hasSwitch('no-sandbox')) {
      throw new Error(app.getLocale().startsWith('zh')
        ? 'Chromium 沙箱不可用。请启用非特权用户命名空间，或安装 .deb 软件包。'
        : 'The Chromium sandbox is unavailable. Enable unprivileged user namespaces or install the .deb package.');
    }
    configureDefaultSession();
    preferences = await preferencesStore.load();
    let api: MonitorApi;
    if (demo) {
      api = { ...createMockApi({ demo: true, writeExport: (file, content) => writeFile(file, content, 'utf8') }), getPreferences: () => preferencesStore.load(), savePreferences };
    } else {
      const registryStore = createRegistryStore(userData, { confirmRecovery });
      const registryProvider = () => registryStore.loadRegistry();
      await registryProvider();
      checkingStartupConfig = false;

      const [probeSource, launcherSource, serverAgentSource] = await Promise.all([
        readFile(path.join(__dirname, 'probe', 'readonly_probe.py'), 'utf8'),
        readFile(path.join(__dirname, 'launch', 'launcher.py'), 'utf8'),
        readFile(path.join(__dirname, 'launch', 'server_agent.py'), 'utf8'),
      ]);
      store = await openStore({ directory: userData, now: Date.now }, path.join(__dirname, 'store-worker.cjs'));
      const pool = sessionPool = new HostSessionPool();
      productionApi = createProductionApi({
        store,
        registryProvider,
        registrySaver: (registry) => registryStore.saveRegistry(registry),
        transportProvider: (host, registry) => createTransport(
          { hostId: host.hostId, host, registry },
          { probeSource, launcherSource, serverAgentSource, registryProvider, sessionPool: pool },
        ),
        clock: Date.now,
        preferencesProvider: () => preferencesStore.load(),
        preferencesSaver: savePreferences,
        onAlert: (alert) => {
          if (preferences.alerts?.desktopNotifications === false) return;
          showDesktopAlert(alert, (taskId, hostId) => {
            const window = showMainWindow();
            if (!taskId || !window) return;
            const payload = hostId ? { taskId, hostId } : { taskId };
            const deliver = () => { if (!window.isDestroyed()) window.webContents.send(CHANNELS.focusTask, payload); };
            if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', deliver);
            else deliver();
          });
        },
        auditJobControl: (entry) => appendJobControlAudit(userData, entry).catch(() => undefined),
      });
      api = productionApi;
      await productionApi.start();
    }
    checkingStartupConfig = false;
    if (shutdownStarted) return;

    if (!isolated && (preferences.launchAtLogin !== undefined || preferencesStore.getRecoveryNotice())) {
      await setLaunchAtLogin(preferences.launchAtLogin ?? false)
        .catch((error) => console.error('MONITOR_LOGIN_ITEM_UPDATE_FAILED', error));
    }
    geometry = createWindowGeometry(preferences.windowBounds, preferencesStore.saveWindowBounds);
    const gpuWindows = createGpuWindowManager(geometry);
    disposeSummary = api.subscribe((update) => {
      if (update.kind === 'alert' && update.alert.severity !== 'info') activeAlertCount += 1;
      if (update.kind === 'snapshot') {
        snapshot = update.snapshot;
        updateProgress();
      }
      if (update.kind !== 'logs') updateTray();
    });
    const initialSnapshot = await api.getSnapshot();
    snapshot ??= initialSnapshot;
    if (shutdownStarted) return;

    tray = createMonitorTray({
      show: showMainWindow,
      hide: () => mainWindow?.hide(),
      openGpu: () => gpuWindows.open(),
      toggleCollection: () => {
        collectionPaused = !collectionPaused;
        productionApi?.setCollectionPaused(collectionPaused);
        updateTray();
      },
      quit: () => app.quit(),
    });
    disposeIpc = registerMonitorIpc(api, {
      openGpuWindow: (hostId) => gpuWindows.open(hostId),
      setActiveTask(taskId, source) {
        if (mainWindow?.webContents !== source) return;
        selectedTaskId = taskId;
        updateProgress();
      },
      clearAlerts(source) {
        if (mainWindow?.webContents !== source) return;
        activeAlertCount = 0;
        updateTray();
      },
      onPreferencesChanged(value) {
        preferences = value;
        updateTray();
      },
    });
    createMainWindow = (observeLoad) => {
      const window = createWindow(preferences.theme, geometry, observeLoad);
      mainWindow = window;
      window.on('close', (event) => {
        if (!shutdownStarted && preferences.minimizeToTrayOnClose !== false) {
          event.preventDefault();
          window.hide();
        }
      });
      window.on('show', updateTray);
      window.on('hide', updateTray);
      window.on('minimize', updateTray);
      window.on('restore', updateTray);
      window.once('closed', () => {
        mainWindow = undefined;
        selectedTaskId = null;
        updateTray();
      });
      updateProgress();
      return window;
    };
    let initialLoad: Promise<void> | undefined;
    createMainWindow((loading) => { initialLoad = loading; });
    updateTray();
    await initialLoad?.catch((error: Error & { code?: string; errno?: number }) => {
      if (error.code !== 'ERR_ABORTED' && error.errno !== -3 && !/^ERR_ABORTED(?: \(-3\))?/.test(error.message)) {
        throw error;
      }
    });
  }).catch(async (error) => {
    shutdownStarted = true;
    await releaseResources().catch((reason) => console.error('MONITOR_SHUTDOWN_FAILED', reason));
    if (error instanceof ConfigRecoveryDeclined) {
      app.exit(0);
      return;
    }
    await showStartupError(error, userData);
    app.exit(1);
  });
}

async function storeCanary(userData: string): Promise<void> {
  try {
    const directory = argument('--canary-dir') ?? path.join(userData, 'canary');
    const evidence = JSON.stringify(await runStoreCanary(directory));
    console.log('SQLITE_CANARY_OK ' + evidence);
    console.log('STORE_CANARY_OK ' + evidence);
    app.exit(0);
  } catch (error) {
    console.error('STORE_CANARY_FAILED', error);
    app.exit(1);
  }
}

try {
  const profile = configureUserData(demo || sqliteCanary);
  if (process.platform === 'linux') app.setDesktopName(linuxDesktopName);
  if (process.platform === 'win32') app.setAppUserModelId('local.training-monitor.desktop');
  if (!app.requestSingleInstanceLock()) app.quit();
  else if (sqliteCanary) void app.whenReady().then(() => storeCanary(profile.directory));
  else startDesktop(profile.directory, profile.isolated);
} catch (error) {
  void app.whenReady().then(async () => {
    await showStartupError(error, app.getPath('userData'));
    app.exit(1);
  });
}
