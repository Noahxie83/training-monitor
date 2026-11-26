import { BrowserWindow, clipboard, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MonitorApi } from '../shared/api';
import type { Registry } from '../shared/contracts';
import { MONITOR_API_KEYS } from '../shared/api';
import { CHANNELS } from './channels';
import { validateLogPage, validateLogQuery, validateLogSearchPage, validateLogSearchRequest, validateMonitorSnapshot, validateMonitorUpdate, validatePreferences, validateRegistry } from '../shared/validate';

type Subscription = { sessionId: string; subscriptionId: string; contentsId: number; dispose: () => void };
const subscriptions = new Map<string, Subscription>();
const activeSessions = new Map<number, string>();
const lifecycleHooks = new Map<number, WebContents>();
const subscriptionKey = (contentsId: number, sessionId: string, subscriptionId: string) => `${contentsId}:${sessionId}:${subscriptionId}`;

function disposeContents(contentsId: number): void {
  for (const [key, subscription] of subscriptions) {
    if (subscription.contentsId === contentsId) { subscription.dispose(); subscriptions.delete(key); }
  }
  activeSessions.delete(contentsId);
}

function observeContents(contents: Electron.WebContents): void {
  if (lifecycleHooks.has(contents.id)) return;
  lifecycleHooks.set(contents.id, contents);
  contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) disposeContents(contents.id); });
  contents.on('render-process-gone', () => disposeContents(contents.id));
  contents.once('destroyed', () => { disposeContents(contents.id); lifecycleHooks.delete(contents.id); });
}

export function registerMonitorIpc(api: MonitorApi, windows?: { openGpuWindow: (hostId?: string) => void }): () => void {
  const handlers: [string, (event: IpcMainInvokeEvent, arg?: unknown) => unknown][] = [
    [CHANNELS.snapshot, async (event) => { assertSender(event); return validateMonitorSnapshot(await api.getSnapshot()); }],
    [CHANNELS.subscribe, (event, arg) => {
      assertSender(event);
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).some((key) => !['sessionId', 'subscriptionId'].includes(key))) throw new TypeError('INVALID_SUBSCRIPTION');
      const request = arg as { sessionId?: unknown; subscriptionId?: unknown };
      if (typeof request.sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(request.sessionId) || typeof request.subscriptionId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(request.subscriptionId)) throw new TypeError('INVALID_SUBSCRIPTION');
      observeContents(event.sender);
      const previousSession = activeSessions.get(event.sender.id);
      if (previousSession && previousSession !== request.sessionId) disposeContents(event.sender.id);
      activeSessions.set(event.sender.id, request.sessionId);
      const key = subscriptionKey(event.sender.id, request.sessionId, request.subscriptionId);
      if (subscriptions.has(key)) throw new TypeError('INVALID_SUBSCRIPTION');
      const { sessionId, subscriptionId } = request as { sessionId: string; subscriptionId: string };
      const dispose = api.subscribe((update) => {
        if (event.sender.isDestroyed() || activeSessions.get(event.sender.id) !== sessionId) return;
        const safe = validateMonitorUpdate(update);
        event.sender.send('monitor:update', { sessionId, subscriptionId, update: safe });
      });
      subscriptions.set(key, { contentsId: event.sender.id, sessionId, subscriptionId, dispose });
      return true;
    }],
    [CHANNELS.unsubscribe, (event, arg) => {
      assertSender(event);
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).some((key) => !['sessionId', 'subscriptionId'].includes(key))) throw new TypeError('INVALID_SUBSCRIPTION');
      const request = arg as { sessionId?: unknown; subscriptionId?: unknown };
      if (typeof request.sessionId !== 'string' || typeof request.subscriptionId !== 'string') throw new TypeError('INVALID_SUBSCRIPTION');
      const key = subscriptionKey(event.sender.id, request.sessionId, request.subscriptionId);
      subscriptions.get(key)?.dispose(); subscriptions.delete(key); return true;
    }],
    [CHANNELS.refresh, async (event, arg) => { assertSender(event); const scope = exactScope(arg); await api.requestRefresh(scope); }],
    [CHANNELS.logs, async (event, arg) => { assertSender(event); return validateLogPage(await api.getLogs(validateLogQuery(arg))); }],
    [CHANNELS.search, async (event, arg) => { assertSender(event); return validateLogSearchPage(await api.searchLogs(validateLogSearchRequest(arg))); }],
    [CHANNELS.cancel, async (event, arg) => { assertSender(event); if (typeof arg !== 'string' || !arg) throw new TypeError('INVALID_REQUEST_ID'); await api.cancelRequest(arg); }],
    [CHANNELS.getRegistry, async (event) => { assertSender(event); return validateRegistry(await api.getRegistry()); }],
    [CHANNELS.saveRegistry, async (event, arg) => {
      assertSender(event);
      const registry = validateRegistry(await api.saveRegistry(validateRegistry(arg)));
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CHANNELS.registryChanged, registry);
      }
      return registry;
    }],
    [CHANNELS.getPrefs, async (event) => { assertSender(event); return validatePreferences(await api.getPreferences()); }],
    [CHANNELS.savePrefs, async (event, arg) => {
      assertSender(event);
      const preferences = validatePreferences(await api.savePreferences(validatePreferences(arg)));
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CHANNELS.preferencesChanged, preferences);
      }
      return preferences;
    }],
    [CHANNELS.openGpu, async (event, arg) => {
      assertSender(event);
      if (arg !== undefined && (typeof arg !== 'string' || !arg || arg.length > 256)) throw new TypeError('INVALID_HOST_ID');
      if (arg !== undefined && !(await api.getRegistry()).hosts.some(host => host.hostId === arg)) throw new Error('HOST_NOT_REGISTERED');
      if (!windows) throw new Error('GPU_WINDOW_UNAVAILABLE');
      windows.openGpuWindow(arg as string | undefined);
    }],
    [CHANNELS.copy, async (event, arg) => { assertSender(event); if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).some((k) => !['taskId', 'sourceId'].includes(k))) throw new TypeError('INVALID_COPY_REQUEST'); const req = arg as { taskId?: unknown; sourceId?: unknown }; if (typeof req.taskId !== 'string' || (req.sourceId !== undefined && typeof req.sourceId !== 'string')) throw new TypeError('INVALID_COPY_REQUEST'); const reg = validateRegistry(await api.getRegistry()); const task = reg.tasks.find((x) => x.taskId === req.taskId && x.enabled); const source = task?.sources.find((x) => req.sourceId === undefined || x.sourceId === req.sourceId); if (!source) throw new Error('PATH_NOT_REGISTERED'); clipboard.writeText(source.path); }],
  ];
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);
  return () => { for (const [channel] of handlers) ipcMain.removeHandler(channel); for (const subscription of subscriptions.values()) subscription.dispose(); subscriptions.clear(); activeSessions.clear(); lifecycleHooks.clear(); };
}

function exactScope(arg: unknown): { hostId?: string; taskId?: string } {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw new TypeError('INVALID_SCOPE'); const s = arg as Record<string, unknown>;
  if (Object.keys(s).some((key) => !['hostId', 'taskId'].includes(key)) || (s.hostId !== undefined && (typeof s.hostId !== 'string' || !s.hostId)) || (s.taskId !== undefined && (typeof s.taskId !== 'string' || !s.taskId))) throw new TypeError('INVALID_SCOPE'); return s as { hostId?: string; taskId?: string };
}
function assertSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (!frame || !mainFrame || frame.frameTreeNodeId !== mainFrame.frameTreeNodeId || frame.url !== mainFrame.url || new URL(frame.url).protocol !== 'file:') throw new Error('UNAUTHORIZED_SENDER');
  const expected = path.resolve(__dirname, 'renderer', 'index.html');
  let actual: string;
  try { actual = path.resolve(fileURLToPath(frame.url)); } catch { throw new Error('UNAUTHORIZED_SENDER'); }
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('UNAUTHORIZED_SENDER');
}

export const monitorIpcChannels = CHANNELS;
export const monitorApiKeys = MONITOR_API_KEYS;
