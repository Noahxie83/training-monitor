import { app, BrowserWindow, nativeTheme, screen, session, type BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import type { Preferences, WindowBounds } from '../shared/contracts';
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

export function configureDefaultSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

export function rendererEntryUrl(): URL {
  const devUrl = !app.isPackaged && process.env.TRAINING_MONITOR_DEV_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('INVALID_DEV_RENDERER_URL');
    }
    return url;
  }
  return pathToFileURL(path.join(__dirname, 'renderer', 'index.html'));
}

export function desktopIconPath(filename: string): string {
  return path.join(__dirname, 'assets', 'icons', filename);
}

type Surface = 'main' | 'gpu';

function sameBounds(a: WindowBounds | undefined, b: WindowBounds): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height &&
    a.isMaximized === b.isMaximized;
}

export function createWindowGeometry(
  initial: Preferences['windowBounds'],
  save: (kind: Surface, bounds: WindowBounds) => Promise<void>,
) {
  const bounds = { ...initial };
  const pending = new Set<() => void>();
  return {
    get(kind: Surface) { return bounds[kind]; },
    track(window: BrowserWindow, kind: Surface) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastMaximized = bounds[kind]?.isMaximized ?? false;
      const persist = () => {
        clearTimeout(timer);
        if (window.isDestroyed()) return;
        const isMaximized = window.isMinimized() ? lastMaximized : window.isMaximized();
        const next = { ...window.getNormalBounds(), isMaximized };
        if (sameBounds(bounds[kind], next)) return;
        bounds[kind] = next;
        void save(kind, next).catch((error) => {
          if (bounds[kind] === next) delete bounds[kind];
          console.error('MONITOR_WINDOW_BOUNDS_SAVE_FAILED', error);
        });
      };
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(persist, 300);
      };
      window.on('move', schedule);
      window.on('resize', schedule);
      window.on('maximize', () => { lastMaximized = true; schedule(); });
      window.on('unmaximize', () => { lastMaximized = false; schedule(); });
      window.on('close', persist);
      window.once('closed', () => {
        clearTimeout(timer);
        pending.delete(persist);
      });
      pending.add(persist);
    },
    flush() { for (const persist of pending) persist(); },
  };
}

type WindowGeometry = ReturnType<typeof createWindowGeometry>;
type WindowLoadObserver = (loading: Promise<void>) => void;

function initialGeometry(kind: Surface, saved?: WindowBounds): BrowserWindowConstructorOptions {
  const gpu = kind === 'gpu';
  const primary = screen.getPrimaryDisplay().workArea;
  const display = saved && screen.getAllDisplays().find(({ workArea }) =>
    saved.x >= workArea.x && saved.y >= workArea.y &&
    saved.x + saved.width <= workArea.x + workArea.width &&
    saved.y + saved.height <= workArea.y + workArea.height,
  );
  const workArea = display ? display.workArea : primary;
  const minWidth = Math.min(gpu ? 640 : 960, workArea.width);
  const minHeight = Math.min(gpu ? 480 : 600, workArea.height);
  const width = Math.min(workArea.width, Math.max(minWidth, saved?.width ?? (gpu ? 980 : 1280)));
  const height = Math.min(workArea.height, Math.max(minHeight, saved?.height ?? (gpu ? 720 : 800)));
  const x = display && saved
    ? Math.min(saved.x, workArea.x + workArea.width - width)
    : workArea.x + Math.floor((workArea.width - width) / 2);
  const y = display && saved
    ? Math.min(saved.y, workArea.y + workArea.height - height)
    : workArea.y + Math.floor((workArea.height - height) / 2);
  return { x, y, width, height, minWidth, minHeight };
}

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

export function createWindow(
  theme?: Preferences['theme'],
  geometry?: WindowGeometry,
  observeLoad?: WindowLoadObserver,
): BrowserWindow {
  if (theme) syncWindowTheme(theme);
  return createSurfaceWindow('main', geometry, undefined, observeLoad);
}

function createSurfaceWindow(
  kind: Surface,
  geometry?: WindowGeometry,
  hostId?: string,
  observeLoad?: WindowLoadObserver,
): BrowserWindow {
  ensureNativeThemeListener();

  const gpu = kind === 'gpu';
  const allowed = rendererEntryUrl();
  if (gpu) allowed.search = new URLSearchParams({ view: 'gpu', ...(hostId ? { hostId } : {}) }).toString();
  const allowedUrl = allowed.href;
  const saved = geometry?.get(kind);
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
    ...initialGeometry(kind, saved),
    show: false,
    title: gpu ? 'GPU 实时监控' : '训练监控器',
    icon: desktopIconPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
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

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== allowedUrl) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (url !== allowedUrl) event.preventDefault(); });
  window.once('ready-to-show', () => {
    window.show();
    if (saved?.isMaximized) window.maximize();
  });
  geometry?.track(window, kind);
  const loading = window.loadURL(allowedUrl);
  if (observeLoad) observeLoad(loading);
  else void loading.catch((error) => {
    if (!window.isDestroyed()) console.error('MONITOR_RENDERER_LOAD_FAILED', error);
  });
  return window;
}

/** One reusable, independently movable window sharing the existing collector. */
export function createGpuWindowManager(geometry?: WindowGeometry) {
  let window: BrowserWindow | null = null;
  let selectedHostId: string | undefined;
  return {
    open(hostId?: string) {
      selectedHostId = hostId;
      if (!window || window.isDestroyed()) {
        window = createSurfaceWindow('gpu', geometry, hostId);
        window.webContents.on('did-finish-load', () => {
          if (selectedHostId && window && !window.isDestroyed()) window.webContents.send(CHANNELS.gpuHost, selectedHostId);
        });
        window.on('closed', () => { window = null; });
        return;
      } else if (hostId) {
        window.webContents.send(CHANNELS.gpuHost, hostId);
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  };
}
