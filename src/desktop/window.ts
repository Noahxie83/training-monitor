import { BrowserWindow, nativeTheme, session, type BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import type { Preferences } from '../shared/contracts';
import { CHANNELS } from './channels';

const __dirname = dirname(__filename);

const CHROME_PALETTE = {
  light: {
    backgroundColor: '#F4F5F7',
    overlayColor: '#FFFFFF',
    symbolColor: '#111827',
  },
  dark: {
    backgroundColor: '#0E1014',
    overlayColor: '#161A22',
    symbolColor: '#F1F5F9',
  },
} as const;

let currentThemePreference: Preferences['theme'] = 'system';
let nativeThemeListenerAttached = false;

export function resolveChromeTheme(preference: Preferences['theme'] = currentThemePreference): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function applyThemeToWindow(window: BrowserWindow, resolved: 'light' | 'dark'): void {
  if (window.isDestroyed()) return;
  const palette = CHROME_PALETTE[resolved];
  try {
    window.setBackgroundColor(palette.backgroundColor);
  } catch {
    // Ignore on platforms where background updates are unsupported after close.
  }
  if (process.platform === 'win32' && typeof window.setTitleBarOverlay === 'function') {
    try {
      window.setTitleBarOverlay({
        color: palette.overlayColor,
        symbolColor: palette.symbolColor,
        height: 44,
      });
    } catch {
      // Ignore if window does not use titleBarOverlay.
    }
  }
}

function ensureNativeThemeListener(): void {
  if (nativeThemeListenerAttached) return;
  nativeThemeListenerAttached = true;
  nativeTheme.on('updated', () => {
    if (currentThemePreference !== 'system') return;
    const resolved = resolveChromeTheme('system');
    for (const win of BrowserWindow.getAllWindows()) {
      applyThemeToWindow(win, resolved);
    }
  });
}

/** Synchronizes nativeTheme, window backgroundColor, and Windows titleBarOverlay across all windows. */
export function syncWindowTheme(preference: Preferences['theme']): void {
  currentThemePreference = preference;
  ensureNativeThemeListener();
  try {
    nativeTheme.themeSource = preference;
  } catch {
    // Ignore in environments where nativeTheme is restricted.
  }
  const resolved = resolveChromeTheme(preference);
  for (const win of BrowserWindow.getAllWindows()) {
    applyThemeToWindow(win, resolved);
  }
}

export function createWindow(theme?: Preferences['theme']): BrowserWindow {
  if (theme) syncWindowTheme(theme);
  return createSurfaceWindow(false);
}

function createSurfaceWindow(gpu = false, hostId?: string): BrowserWindow {
  ensureNativeThemeListener();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const resolved = resolveChromeTheme();
  const palette = CHROME_PALETTE[resolved];

  const platformChrome: Partial<BrowserWindowConstructorOptions> =
    process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: palette.overlayColor,
            symbolColor: palette.symbolColor,
            height: 44,
          },
        }
      : process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 14, y: 14 },
          }
        : {};

  const window = new BrowserWindow({
    width: gpu ? 980 : 1280,
    height: gpu ? 720 : 800,
    minWidth: gpu ? 640 : 960,
    minHeight: gpu ? 480 : 600,
    show: false,
    title: gpu ? 'GPU 实时监控' : '训练监控器',
    backgroundColor: palette.backgroundColor,
    autoHideMenuBar: true,
    ...platformChrome,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
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
