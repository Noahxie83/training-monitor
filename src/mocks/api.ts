import type { MonitorApi, MonitorSnapshot, MonitorUpdate } from '../shared/api';
import type { Registry, Preferences, LogEvent } from '../shared/contracts';
import { demoSnapshot } from './fixtures';
import { validateRegistry } from '../shared/validate';
import { PAGE_EVENT_LIMIT, PAGE_TEXT_BUDGET_BYTES } from '../shared/budgets';
import { projectRegistrySnapshot } from '../shared/registry-snapshot';

const DEMO_EVENT_COUNT = 2_000;
const DEMO_EVENT_CAPACITY = 2_000;
const DEMO_GENERATION = 'demo-generation-1';
const DEMO_REDRAW_ID = 'demo-redraw-progress';
const DEMO_TIME = '2026-10-18T12:00:00.000Z';

function makeDemoEvent(index: number, eventId = `demo-event-${String(index).padStart(6, '0')}`): LogEvent {
  const text = `模拟训练日志 step=${String(index).padStart(4, '0')} token-${index % 20}`;
  const start = BigInt(index) * 256n;
  const end = start + BigInt(new TextEncoder().encode(text).byteLength);
  return {
    version: 1, eventId, taskId: 'demo-task', sourceId: 'demo-log', generation: DEMO_GENERATION,
    kind: 'line', startOffset: String(start), endOffset: String(end), ingestedAt: DEMO_TIME, text,
    reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false, runId: null, bindingId: null,
  };
}

const emptyRegistry: Registry = { version: 2, revision: 0, hosts: [], tasks: [] };
export function createMockApi(options: { demo?: boolean } = {}): MonitorApi {
  let registry: Registry = options.demo === true ? {
    version: 2, revision: 0,
    hosts: [{ hostId: 'demo-host', label: '模拟宿主', enabled: false, allowedRoots: ['/simulated'], target: { kind: 'ssh', alias: 'gpu-server-01' } }],
    tasks: [{ taskId: 'demo-task', hostId: 'demo-host', label: 'demo-task', enabled: false, algorithm: 'unknown',
      allowedDirectories: ['/simulated'], entryPaths: ['train.py'], sources: [{ sourceId: 'demo-log', path: '/simulated/train.log', kind: 'log' }], checkpointDirectories: [] }],
  } : structuredClone(emptyRegistry);
  let preferences: Preferences = { theme: 'system' };
  const listeners = new Set<(update: MonitorUpdate) => void>();
  const events: LogEvent[] = options.demo === true ? Array.from({ length: DEMO_EVENT_COUNT }, (_, index) => makeDemoEvent(index)) : [];
  const activeSearches = new Set<string>();
  const cancelledSearches = new Set<string>();
  let refreshCount = 0;
  const snapshot = (): MonitorSnapshot => {
    if (options.demo === true) return projectRegistrySnapshot(structuredClone(demoSnapshot), registry);
    const hosts = registry.hosts.map((host) => ({
      version: 1 as const, hostId: host.hostId, kind: host.target.kind, connection: 'unobserved' as const,
      lastSuccessAt: null, lastProbeDurationMs: null, scanComplete: false, errorCode: null,
      observedAt: null, freshness: 'unobserved' as const,
    }));
    const tasks = registry.tasks.map((registration) => ({
      ...structuredClone(demoSnapshot.tasks[0]!), taskId: registration.taskId, hostId: registration.hostId,
      lifecycle: 'unknown' as const, reason: '尚无可用观测',
    }));
    const sources = registry.tasks.flatMap((registration) => registration.sources.map((source) => ({
      ...structuredClone(demoSnapshot.sources[0]!), sourceId: source.sourceId, taskId: registration.taskId,
    })));
    return { version: 1, demo: false, hosts, tasks, sources };
  };
  const publishSnapshot = () => { const update: MonitorUpdate = { kind: 'snapshot', snapshot: snapshot() }; for (const listener of [...listeners]) listener(structuredClone(update)); };
  const publishDemoRedraw = () => {
    refreshCount += 1;
    const text = `模拟进度刷新 ${refreshCount}`;
    const start = BigInt(DEMO_EVENT_COUNT) * 256n;
    const redraw: LogEvent = {
      version: 1, eventId: DEMO_REDRAW_ID, taskId: 'demo-task', sourceId: 'demo-log', generation: DEMO_GENERATION,
      kind: 'redraw', startOffset: String(start), endOffset: String(start + BigInt(new TextEncoder().encode(text).byteLength)),
      ingestedAt: DEMO_TIME, text, reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false,
      runId: null, bindingId: null,
    };
    const existing = events.findIndex((event) => event.eventId === DEMO_REDRAW_ID);
    if (existing >= 0) events[existing] = redraw;
    else events.push(redraw);
    events.sort((a, b) => BigInt(a.startOffset ?? '0') < BigInt(b.startOffset ?? '0') ? -1 : BigInt(a.startOffset ?? '0') > BigInt(b.startOffset ?? '0') ? 1 : a.eventId.localeCompare(b.eventId));
    while (events.length > DEMO_EVENT_CAPACITY) events.shift();
    const update: MonitorUpdate = { kind: 'logs', sourceId: 'demo-log', events: [structuredClone(redraw)] };
    for (const listener of [...listeners]) listener(structuredClone(update));
  };
  return {
    async getSnapshot() { return snapshot(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async requestRefresh() { publishSnapshot(); if (options.demo === true) publishDemoRedraw(); },
    async getLogs(query) {
      const all = events.filter((event) => event.sourceId === query.sourceId);
      const cursor = query.before === null ? all.length : all.findIndex((event) => event.eventId === query.before);
      if (cursor < 0) return { events: [], nextBefore: null, truncatedByBudget: false };
      const limit = Math.min(PAGE_EVENT_LIMIT, Math.max(1, Math.floor(query.limit) || 1));
      const page: LogEvent[] = [];
      let textBytes = 0;
      let start = cursor;
      let truncatedByBudget = false;
      while (start > 0 && page.length < limit) {
        const candidate = all[start - 1]!;
        const bytes = new TextEncoder().encode(candidate.text ?? '').byteLength;
        if (textBytes + bytes > PAGE_TEXT_BUDGET_BYTES) { truncatedByBudget = true; break; }
        page.push(candidate);
        textBytes += bytes;
        start -= 1;
      }
      page.reverse();
      return { events: page, nextBefore: start > 0 && page.length > 0 ? page[0]!.eventId : null, truncatedByBudget };
    },
    async searchLogs(query) {
      activeSearches.add(query.requestId);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      activeSearches.delete(query.requestId);
      const cancelled = cancelledSearches.delete(query.requestId);
      if (cancelled) return { events: [], continuation: null, scope: 'retained_local', cancelled: true };
      let index = query.continuation === null ? 0 : Number(query.continuation);
      if (!Number.isSafeInteger(index) || index < 0 || index > events.length) index = 0;
      const page: LogEvent[] = [];
      let textBytes = 0;
      let nextIndex = index;
      for (; nextIndex < events.length; nextIndex += 1) {
        const event = events[nextIndex]!;
        if (!query.sourceIds.includes(event.sourceId) || !(event.text ?? '').includes(query.literal)) continue;
        const bytes = new TextEncoder().encode(event.text ?? '').byteLength;
        if (page.length >= PAGE_EVENT_LIMIT || textBytes + bytes > PAGE_TEXT_BUDGET_BYTES) break;
        page.push(event);
        textBytes += bytes;
      }
      return { events: structuredClone(page), continuation: nextIndex < events.length ? String(nextIndex) : null, scope: 'retained_local', cancelled: false };
    },
    async cancelRequest(requestId) { if (activeSearches.has(requestId)) cancelledSearches.add(requestId); },
    async getRegistry() { return structuredClone(registry); },
    async saveRegistry(value, _options) { const validated = validateRegistry(value); if (validated.revision !== registry.revision) throw new Error('REVISION_CONFLICT'); registry = { ...structuredClone(validated), revision: registry.revision + 1 }; publishSnapshot(); return structuredClone(registry); },
    async getPreferences() { return { ...preferences }; },
    async savePreferences(value) { preferences = { ...value }; return { ...preferences }; },
    async copyRegisteredPath() {},
    async getMetricSeries(query) { return { taskId: query.taskId, series: {} }; },
    async getGpuSeries(query) { return { hostId: query.hostId, gpu: [], host: [] }; },
    async exportLogs(query) {
      const matched = events.filter((e) => query.sourceIds.includes(e.sourceId) && (!query.literal || (e.text ?? '').includes(query.literal)));
      return { exportedCount: matched.length, path: query.destinationPath ?? null };
    },
    async discoverProcesses(_hostId) { return []; },
    async controlTask(request) {
      const task = registry.tasks.find((t) => t.taskId === request.taskId);
      const host = task ? registry.hosts.find((h) => h.hostId === task.hostId) : undefined;
      if (!task || !host) return { ok: false, taskId: request.taskId, action: request.action, errorCode: 'TASK_NOT_REGISTERED', message: 'Task not found' };
      if (host.allowJobControl !== true) {
        return { ok: false, taskId: request.taskId, action: request.action, errorCode: 'JOB_CONTROL_DISABLED', message: 'Remote job control is disabled for this host' };
      }
      if (!request.confirmToken || request.confirmToken.length < 8) {
        return { ok: false, taskId: request.taskId, action: request.action, errorCode: 'CONFIRMATION_REQUIRED', message: 'Confirmation token required' };
      }
      return { ok: true, taskId: request.taskId, action: request.action, pidsSignaled: [], errorCode: null, message: 'Simulated job control action' };
    },
    async testWebhook(_webhook) { return { ok: true, statusCode: 200, error: null }; },
  };
}
