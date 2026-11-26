import { BrowserWindow, session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { CHANNELS } from './channels';

const __dirname = dirname(__filename);
export function createWindow(): BrowserWindow {
  return createSurfaceWindow();
}

function createSurfaceWindow(gpu = false, hostId?: string): BrowserWindow {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: gpu ? 940 : 1040, height: 720, minWidth: gpu ? 640 : 960, minHeight: gpu ? 480 : 600, show: false,
    title: gpu ? 'GPU 实时监控' : '训练监控器',
    backgroundColor: '#1c1d20', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  const rendererPath = path.resolve(__dirname, 'renderer', 'index.html');
  const query = gpu ? { view: 'gpu', ...(hostId ? { hostId } : {}) } : undefined;
  const allowed = new URL(pathToFileURL(rendererPath).href);
  if (query) allowed.search = new URLSearchParams(query).toString();
  const allowedUrl = allowed.href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== allowedUrl) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (url !== allowedUrl) event.preventDefault(); });
  void window.loadFile(rendererPath, query ? { query } : undefined);
  window.once('ready-to-show', () => window.show());
  return window;
}

/** One reusable, independently movable window sharing the existing collector. */
export function createGpuWindowManager() {
  let window: BrowserWindow | null = null;
  let selectedHostId: string | undefined;
  return {
    open(hostId?: string) {
      selectedHostId = hostId;
      if (!window || window.isDestroyed()) {
        window = createSurfaceWindow(true, hostId);
        window.webContents.on('did-finish-load', () => {
          if (selectedHostId && window && !window.isDestroyed()) window.webContents.send(CHANNELS.gpuHost, selectedHostId);
        });
        window.on('closed', () => { window = null; });
      } else if (hostId) {
        window.webContents.send(CHANNELS.gpuHost, hostId);
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  };
}
