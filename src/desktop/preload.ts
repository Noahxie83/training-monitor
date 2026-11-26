import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, MonitorApi, MonitorUpdate } from '../shared/api';
import type { Preferences, Registry } from '../shared/contracts';
import { CHANNELS as c } from './channels';
import { validateLogPage, validateLogQuery, validateLogSearchPage, validateLogSearchRequest, validateMonitorSnapshot, validateMonitorUpdate, validatePreferences, validateRefreshScope, validateRegistry } from '../shared/validate';

const sessionId = crypto.randomUUID();
let sequence = 0;
const api: MonitorApi = {
  async getSnapshot() { return validateMonitorSnapshot(await ipcRenderer.invoke(c.snapshot)); },
  subscribe(listener) {
    const subscriptionId = `sub-${++sequence}`;
    let active = true; let registered = false;
    const reportFailure = () => window.dispatchEvent(new CustomEvent('monitor-subscription-error', { detail: { code: 'SUBSCRIPTION_FAILED' } }));
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => { if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((k) => !['sessionId', 'subscriptionId', 'update'].includes(k))) return; const item = payload as { sessionId?: unknown; subscriptionId?: unknown; update?: unknown }; if (item.sessionId === sessionId && item.subscriptionId === subscriptionId && active) listener(validateMonitorUpdate(item.update)); };
    ipcRenderer.on('monitor:update', handler);
    void ipcRenderer.invoke(c.subscribe, { sessionId, subscriptionId }).then(() => { registered = true; if (!active) void ipcRenderer.invoke(c.unsubscribe, { sessionId, subscriptionId }).catch(reportFailure); }).catch(() => { ipcRenderer.removeListener('monitor:update', handler); reportFailure(); });
    return () => { active = false; ipcRenderer.removeListener('monitor:update', handler); if (registered) void ipcRenderer.invoke(c.unsubscribe, { sessionId, subscriptionId }).catch(reportFailure); };
  },
  async requestRefresh(scope) { await ipcRenderer.invoke(c.refresh, validateRefreshScope(scope)); },
  async getLogs(query) { return validateLogPage(await ipcRenderer.invoke(c.logs, validateLogQuery(query))); },
  async searchLogs(query) { return validateLogSearchPage(await ipcRenderer.invoke(c.search, validateLogSearchRequest(query))); },
  async cancelRequest(requestId) { if (typeof requestId !== 'string' || !requestId) throw new TypeError('INVALID_REQUEST_ID'); await ipcRenderer.invoke(c.cancel, requestId); },
  async getRegistry() { return validateRegistry(await ipcRenderer.invoke(c.getRegistry)); },
  async saveRegistry(registry) { return validateRegistry(await ipcRenderer.invoke(c.saveRegistry, validateRegistry(registry))); },
  async getPreferences() { return validatePreferences(await ipcRenderer.invoke(c.getPrefs)); },
  async savePreferences(value) { return validatePreferences(await ipcRenderer.invoke(c.savePrefs, validatePreferences(value))); },
  async copyRegisteredPath(value) { if (!value || typeof value !== 'object' || Object.keys(value).some((k) => !['taskId', 'sourceId'].includes(k)) || typeof value.taskId !== 'string' || (value.sourceId !== undefined && typeof value.sourceId !== 'string')) throw new TypeError('INVALID_COPY_REQUEST'); await ipcRenderer.invoke(c.copy, value); },
};
contextBridge.exposeInMainWorld('monitor', Object.freeze(api));

const hostListeners = new Set<(hostId: string) => void>();
let pendingHostId: string | undefined;
ipcRenderer.on(c.gpuHost, (_event, hostId: unknown) => {
  if (typeof hostId !== 'string' || !hostId || hostId.length > 256) return;
  if (!hostListeners.size) pendingHostId = hostId;
  else for (const listener of hostListeners) listener(hostId);
});
const desktop: DesktopApi = {
  async openGpuWindow(hostId) {
    if (hostId !== undefined && (typeof hostId !== 'string' || !hostId || hostId.length > 256)) throw new TypeError('INVALID_HOST_ID');
    await ipcRenderer.invoke(c.openGpu, hostId);
  },
  onGpuHostSelected(listener) {
    hostListeners.add(listener);
    if (pendingHostId) {
      const hostId = pendingHostId;
      queueMicrotask(() => {
        if (hostListeners.has(listener) && pendingHostId === hostId) {
          pendingHostId = undefined;
          listener(hostId);
        }
      });
    }
    return () => { hostListeners.delete(listener); };
  },
  onPreferencesChanged(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: Preferences) => listener(validatePreferences(value));
    ipcRenderer.on(c.preferencesChanged, handler);
    return () => { ipcRenderer.removeListener(c.preferencesChanged, handler); };
  },
  onRegistryChanged(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: Registry) => listener(validateRegistry(value));
    ipcRenderer.on(c.registryChanged, handler);
    return () => { ipcRenderer.removeListener(c.registryChanged, handler); };
  },
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
