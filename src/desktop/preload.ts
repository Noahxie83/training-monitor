import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, MonitorApi, MonitorUpdate } from '../shared/api';
import type { Preferences, Registry } from '../shared/contracts';
import { CHANNELS as c } from './channels';
import {
  validateControlTaskRequest,
  validateDiscoveredProcesses,
  validateDiscoveredSshHosts,
  validateDiscoveredWslDistros,
  validateExportLogsQuery,
  validateGpuSeriesQuery,
  validateLogPage,
  validateLogQuery,
  validateLogSearchPage,
  validateLogSearchRequest,
  validateMetricSeriesQuery,
  validateMonitorSnapshot,
  validateMonitorUpdate,
  validatePreferences,
  validateRefreshScope,
  validateRegistry,
  validateWebhookChannelConfig,
} from '../shared/validate';

const sessionId = crypto.randomUUID();
let sequence = 0;
const updateListeners = new Map<string, (update: MonitorUpdate) => void>();
ipcRenderer.on(c.update, (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !['sessionId', 'subscriptionId', 'update'].includes(key))) return;
  const item = payload as { sessionId?: unknown; subscriptionId?: unknown; update?: unknown };
  if (item.sessionId !== sessionId || typeof item.subscriptionId !== 'string') return;
  const listener = updateListeners.get(item.subscriptionId);
  if (!listener) return;
  let update: MonitorUpdate;
  try {
    update = validateMonitorUpdate(item.update);
  } catch (error) {
    console.warn('MONITOR_INVALID_UPDATE', error);
    return;
  }
  listener(update);
});

const api: MonitorApi = {
  async getSnapshot() { return validateMonitorSnapshot(await ipcRenderer.invoke(c.snapshot)); },
  subscribe(listener) {
    const subscriptionId = `sub-${++sequence}`;
    let registered = false;
    const reportFailure = () => window.dispatchEvent(new CustomEvent('monitor-subscription-error', { detail: { code: 'SUBSCRIPTION_FAILED' } }));
    const request = { sessionId, subscriptionId };
    const unsubscribe = () => { void ipcRenderer.invoke(c.unsubscribe, request).catch(reportFailure); };
    updateListeners.set(subscriptionId, listener);
    void ipcRenderer.invoke(c.subscribe, request).then(() => {
      registered = true;
      if (!updateListeners.has(subscriptionId)) unsubscribe();
    }).catch(() => {
      if (updateListeners.delete(subscriptionId)) reportFailure();
    });
    return () => {
      if (updateListeners.delete(subscriptionId) && registered) unsubscribe();
    };
  },
  async requestRefresh(scope) { await ipcRenderer.invoke(c.refresh, validateRefreshScope(scope)); },
  async getLogs(query) { return validateLogPage(await ipcRenderer.invoke(c.logs, validateLogQuery(query))); },
  async searchLogs(query) { return validateLogSearchPage(await ipcRenderer.invoke(c.search, validateLogSearchRequest(query))); },
  async cancelRequest(requestId) { if (typeof requestId !== 'string' || !requestId) throw new TypeError('INVALID_REQUEST_ID'); await ipcRenderer.invoke(c.cancel, requestId); },
  async getRegistry() { return validateRegistry(await ipcRenderer.invoke(c.getRegistry)); },
  async saveRegistry(registry, options) {
    const validated = validateRegistry(registry);
    const payload = options ? { registry: validated, options } : validated;
    return validateRegistry(await ipcRenderer.invoke(c.saveRegistry, payload));
  },
  async getPreferences() { return validatePreferences(await ipcRenderer.invoke(c.getPrefs)); },
  async savePreferences(value) { return validatePreferences(await ipcRenderer.invoke(c.savePrefs, validatePreferences(value))); },
  async copyRegisteredPath(value) { if (!value || typeof value !== 'object' || Object.keys(value).some((k) => !['taskId', 'sourceId'].includes(k)) || typeof value.taskId !== 'string' || (value.sourceId !== undefined && typeof value.sourceId !== 'string')) throw new TypeError('INVALID_COPY_REQUEST'); await ipcRenderer.invoke(c.copy, value); },
  async getMetricSeries(query) { return ipcRenderer.invoke(c.metricSeries, validateMetricSeriesQuery(query)); },
  async getGpuSeries(query) { return ipcRenderer.invoke(c.gpuSeries, validateGpuSeriesQuery(query)); },
  async exportLogs(query) { return ipcRenderer.invoke(c.exportLogs, validateExportLogsQuery(query)); },
  async discoverProcesses(hostId) {
    if (typeof hostId !== 'string' || !hostId || hostId.length > 256) throw new TypeError('INVALID_HOST_ID');
    return validateDiscoveredProcesses(await ipcRenderer.invoke(c.discoverProcesses, hostId));
  },
  async controlTask(request) { return ipcRenderer.invoke(c.controlTask, validateControlTaskRequest(request)); },
  async testWebhook(webhook) { return ipcRenderer.invoke(c.testWebhook, validateWebhookChannelConfig(webhook, 'INVALID_WEBHOOK')); },
};
contextBridge.exposeInMainWorld('monitor', Object.freeze(api));

const hostListeners = new Set<(hostId: string) => void>();
let pendingHostId: string | undefined;
ipcRenderer.on(c.gpuHost, (_event, hostId: unknown) => {
  if (typeof hostId !== 'string' || !hostId || hostId.length > 256) return;
  if (!hostListeners.size) pendingHostId = hostId;
  else for (const listener of hostListeners) listener(hostId);
});
const focusTaskListeners = new Set<(taskId: string, hostId?: string) => void>();
let pendingFocusTask: { taskId: string; hostId?: string } | undefined;
ipcRenderer.on(c.focusTask, (_event, payload: unknown) => {
  let target: { taskId: string; hostId?: string } | null = null;
  if (typeof payload === 'string' && payload) {
    target = { taskId: payload };
  } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const item = payload as { taskId?: unknown; hostId?: unknown };
    if (typeof item.taskId === 'string' && item.taskId) {
      target = {
        taskId: item.taskId,
        ...(typeof item.hostId === 'string' && item.hostId ? { hostId: item.hostId } : {}),
      };
    }
  }
  if (!target) return;
  if (!focusTaskListeners.size) pendingFocusTask = target;
  else for (const listener of focusTaskListeners) listener(target.taskId, target.hostId);
});
const desktop: DesktopApi = {
  platform: process.platform,
  async openGpuWindow(hostId) {
    if (hostId !== undefined && (typeof hostId !== 'string' || !hostId || hostId.length > 256)) throw new TypeError('INVALID_HOST_ID');
    await ipcRenderer.invoke(c.openGpu, hostId);
  },
  async clearAlerts() { await ipcRenderer.invoke(c.clearAlerts); },
  async setActiveTask(taskId) { await ipcRenderer.invoke(c.activeTask, taskId); },
  async copyDiagnosticText(text) { await ipcRenderer.invoke(c.copyDiagnostic, text); },
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
  async discoverSshHosts() { return validateDiscoveredSshHosts(await ipcRenderer.invoke(c.discoverSsh)); },
  async discoverWslDistros() { return validateDiscoveredWslDistros(await ipcRenderer.invoke(c.discoverWsl)); },
  async openSshTerminal(request) { return ipcRenderer.invoke(c.openSshTerminal, request); },
  async copyCommand(request) { return ipcRenderer.invoke(c.copyCommand, request); },
  onFocusTask(listener) {
    focusTaskListeners.add(listener);
    const target = pendingFocusTask;
    if (target) {
      queueMicrotask(() => {
        if (focusTaskListeners.has(listener) && pendingFocusTask === target) {
          pendingFocusTask = undefined;
          listener(target.taskId, target.hostId);
        }
      });
    }
    return () => { focusTaskListeners.delete(listener); };
  },
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
