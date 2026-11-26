import { validateAutoStartConfig, validateAutoStartStatus } from './auto-start';
import type { Bytes, Registry, ResourceMetric, Freshness, HostGpuSnapshot } from './contracts';
import type { LogEvent, HostSnapshot, TaskSnapshot, LogSourceSnapshot, Stamp } from './contracts';
import type { LogPage, LogQuery, LogSearchPage, LogSearchRequest, MonitorSnapshot, MonitorUpdate } from './api';
import { EVENT_PREVIEW_BYTES, PAGE_EVENT_LIMIT, PAGE_TEXT_BUDGET_BYTES, SEARCH_LITERAL_LIMIT, SUBSCRIPTION_TEXT_BUDGET_BYTES } from './budgets';

export function parseBytes(value: Bytes): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('INVALID_BYTES');
  return BigInt(value);
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[], code: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new TypeError(code);
}
function validTime(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , zoneHourText, zoneMinuteText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zoneHour = zone === 'Z' ? 0 : Number(zoneHourText); const zoneMinute = zone === 'Z' ? 0 : Number(zoneMinuteText);
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]! && hour <= 23 && minute <= 59 && second <= 59 && zoneHour <= 23 && zoneMinute <= 59;
}
function enumIs(value: unknown, allowed: readonly string[]): boolean { return typeof value === 'string' && allowed.includes(value); }
function isBoundedPreview(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && new TextEncoder().encode(value).byteLength <= EVENT_PREVIEW_BYTES);
}

export function validateMetric(value: unknown): ResourceMetric {
  const metric = object(value, 'INVALID_METRIC');
  exact(metric, ['observedAt', 'freshness', 'source', 'name', 'unit', 'value', 'scope', 'deviceId', 'processKey'], 'INVALID_METRIC');
  const names = ['gpu_utilization', 'gpu_memory_used', 'gpu_memory_total', 'cpu_utilization', 'process_rss'];
  const units = ['percent_device', 'percent_one_cpu', 'bytes'];
  const freshness = ['fresh', 'stale', 'unobserved'];
  if (!validTime(metric.observedAt) || !enumIs(metric.freshness, freshness) || typeof metric.source !== 'string' || !metric.source || !enumIs(metric.name, names) || !enumIs(metric.unit, units)) throw new TypeError('INVALID_METRIC');
  if (metric.value !== null && (typeof metric.value !== 'number' || !Number.isFinite(metric.value))) throw new TypeError('INVALID_METRIC');
  if (metric.scope === 'device' && typeof metric.deviceId === 'string' && metric.deviceId && metric.processKey === null) return metric as unknown as ResourceMetric;
  if (metric.scope === 'process' && (metric.deviceId === null || typeof metric.deviceId === 'string') && metric.processKey && typeof metric.processKey === 'object') {
    const key = object(metric.processKey, 'INVALID_METRIC');
    exact(key, ['hostBootId', 'pid', 'startTicks'], 'INVALID_METRIC');
    if (typeof key.hostBootId === 'string' && typeof key.pid === 'number' && Number.isSafeInteger(key.pid) && typeof key.startTicks === 'string' && key.pid > 0) { parseBytes(key.startTicks); return metric as unknown as ResourceMetric; }
  }
  throw new TypeError('INVALID_METRIC');
}

export function validateRegistry(value: unknown): Registry {
  const root = object(value, 'INVALID_REGISTRY');
  exact(root, ['version', 'revision', 'hosts', 'tasks'], 'INVALID_REGISTRY');
  if (root.version !== 1 || !Number.isSafeInteger(root.revision) || (root.revision as number) < 0 || !Array.isArray(root.hosts) || !Array.isArray(root.tasks)) throw new TypeError('INVALID_REGISTRY');
  const hosts = root.hosts.map((entry) => {
    const host = object(entry, 'INVALID_REGISTRY');
    exact(host, ['hostId', 'label', 'enabled', 'allowedRoots', 'target'], 'INVALID_REGISTRY');
    const target = object(host.target, 'INVALID_REGISTRY');
    if (target.kind === 'ssh') { exact(target, ['kind', 'alias'], 'INVALID_REGISTRY'); if (target.alias !== 'lab-campus') throw new TypeError('INVALID_REGISTRY'); }
    else if (target.kind === 'wsl') { exact(target, ['kind', 'distribution'], 'INVALID_REGISTRY'); if (target.distribution !== 'Ubuntu-26.04') throw new TypeError('INVALID_REGISTRY'); }
    else throw new TypeError('INVALID_REGISTRY');
    if (typeof host.hostId !== 'string' || !host.hostId || typeof host.label !== 'string' || typeof host.enabled !== 'boolean' || !Array.isArray(host.allowedRoots) || host.allowedRoots.some((path) => typeof path !== 'string' || !path)) throw new TypeError('INVALID_REGISTRY');
    return host;
  });
  const hostIds = new Set(hosts.map((host) => host.hostId));
  if (hostIds.size !== hosts.length) throw new TypeError('DUPLICATE_ID');
  const seenTaskIds = new Set<string>();
  const seenSourceIds = new Set<string>();
  const tasks = root.tasks.map((entry) => {
    const task = object(entry, 'INVALID_REGISTRY');
    exact(task, ['taskId', 'hostId', 'label', 'enabled', 'algorithm', 'logFormat', 'autoStart', 'allowedDirectories', 'entryPaths', 'sources', 'checkpointDirectories'], 'INVALID_REGISTRY');
    if (typeof task.taskId !== 'string' || !task.taskId || typeof task.hostId !== 'string' || !hostIds.has(task.hostId) || typeof task.label !== 'string' || typeof task.enabled !== 'boolean' ||
        typeof task.algorithm !== 'string' || task.algorithm.length > 120 || /[\u0000-\u001f\u007f]/.test(task.algorithm) ||
        (task.logFormat !== undefined && !enumIs(task.logFormat, ['generic', 'flow', 'score', 'reflow', 'raw']))) throw new TypeError('INVALID_REGISTRY');
    if (seenTaskIds.has(task.taskId)) throw new TypeError('DUPLICATE_ID'); seenTaskIds.add(task.taskId);
    for (const key of ['allowedDirectories', 'entryPaths', 'checkpointDirectories'] as const) if (!Array.isArray(task[key]) || task[key].some((path) => typeof path !== 'string' || !path)) throw new TypeError('INVALID_REGISTRY');
    if (!Array.isArray(task.sources)) throw new TypeError('INVALID_REGISTRY');
    for (const source of task.sources) { const src = object(source, 'INVALID_REGISTRY'); exact(src, ['sourceId', 'path', 'kind'], 'INVALID_REGISTRY'); if (typeof src.sourceId !== 'string' || !src.sourceId || typeof src.path !== 'string' || !src.path || !enumIs(src.kind, ['log', 'status_json', 'queue_lock'])) throw new TypeError('INVALID_REGISTRY'); if (seenSourceIds.has(src.sourceId)) throw new TypeError('DUPLICATE_ID'); seenSourceIds.add(src.sourceId); }
    if (task.autoStart !== undefined) {
      const autoStart = validateAutoStartConfig(task.autoStart, task as unknown as Registry['tasks'][number]);
      if (autoStart.enabled && autoStart.execution === 'server_tmux' && (hosts as unknown as Registry['hosts']).find(host => host.hostId === task.hostId)?.target.kind !== 'ssh') throw new TypeError('AUTO_START_SSH_ONLY');
    }
    return task;
  });
  return { version: 1, revision: root.revision as number, hosts: hosts as unknown as Registry['hosts'], tasks: tasks as unknown as Registry['tasks'] };
}

export function isFreshness(value: unknown): value is Freshness { return value === 'fresh' || value === 'stale' || value === 'unobserved'; }

function string(value: unknown, allowEmpty = false): value is string { return typeof value === 'string' && (allowEmpty || value.length > 0); }
function nullableString(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function finiteOrNull(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isFinite(value)); }
function integerOrNull(value: unknown): value is number | null { return value === null || (Number.isSafeInteger(value) && typeof value === 'number'); }
function stamp(value: unknown): Stamp {
  const item = object(value, 'INVALID_STAMP');
  exact(item, ['observedAt', 'freshness'], 'INVALID_STAMP');
  if (!validTime(item.observedAt) || !isFreshness(item.freshness)) throw new TypeError('INVALID_STAMP');
  return item as unknown as Stamp;
}
function processKey(value: unknown): boolean {
  if (value === null) return true;
  const key = object(value, 'INVALID_PROCESS_KEY');
  exact(key, ['hostBootId', 'pid', 'startTicks'], 'INVALID_PROCESS_KEY');
  return string(key.hostBootId) && Number.isSafeInteger(key.pid) && typeof key.pid === 'number' && key.pid > 0 && string(key.startTicks) && (() => { try { parseBytes(key.startTicks as string); return true; } catch { return false; } })();
}
function validateProcess(value: unknown): void {
  const p = object(value, 'INVALID_PROCESS');
  exact(p, ['key', 'pid', 'parentKey', 'cwd', 'scriptEntry', 'role', 'observedAt'], 'INVALID_PROCESS');
  if (!processKey(p.key) || !Number.isSafeInteger(p.pid) || typeof p.pid !== 'number' || p.pid <= 0 || !processKey(p.parentKey) || !nullableString(p.cwd) || !nullableString(p.scriptEntry) || !enumIs(p.role, ['trainer', 'queue', 'worker', 'unknown']) || !validTime(p.observedAt) || p.observedAt === null) throw new TypeError('INVALID_PROCESS');
}

export function validateHostSnapshot(value: unknown): HostSnapshot {
  const h = object(value, 'INVALID_HOST_SNAPSHOT');
  exact(h, ['observedAt', 'freshness', 'version', 'hostId', 'kind', 'connection', 'lastSuccessAt', 'lastProbeDurationMs', 'scanComplete', 'errorCode', 'gpu'], 'INVALID_HOST_SNAPSHOT');
  stamp({ observedAt: h.observedAt, freshness: h.freshness });
  if (h.version !== 1 || !string(h.hostId) || !enumIs(h.kind, ['ssh', 'wsl']) || !enumIs(h.connection, ['unobserved', 'connecting', 'connected', 'disconnected']) || !validTime(h.lastSuccessAt) || !finiteOrNull(h.lastProbeDurationMs) || (h.lastProbeDurationMs !== null && h.lastProbeDurationMs < 0) || typeof h.scanComplete !== 'boolean' || !nullableString(h.errorCode)) throw new TypeError('INVALID_HOST_SNAPSHOT');
  if (Object.prototype.hasOwnProperty.call(h, 'gpu')) validateHostGpuSnapshot(h.gpu);
  return h as unknown as HostSnapshot;
}

function validateHostGpuSnapshot(value: unknown): HostGpuSnapshot {
  const gpu = object(value, 'INVALID_HOST_GPU_SNAPSHOT');
  exact(gpu, ['observedAt', 'state', 'errorCode', 'metrics'], 'INVALID_HOST_GPU_SNAPSHOT');
  if (!validTime(gpu.observedAt) || !enumIs(gpu.state, ['available', 'unavailable']) || !nullableString(gpu.errorCode) ||
      !Array.isArray(gpu.metrics) || gpu.metrics.length > 768) throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
  for (const value of gpu.metrics) {
    const metric = validateMetric(value);
    const expectedUnit = metric.name === 'gpu_utilization' ? 'percent_device' : 'bytes';
    if (metric.scope !== 'device' || metric.processKey !== null ||
        !['gpu_utilization', 'gpu_memory_used', 'gpu_memory_total'].includes(metric.name) || metric.unit !== expectedUnit ||
        (metric.value !== null && (metric.value < 0 || metric.name === 'gpu_utilization' && metric.value > 100))) {
      throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
    }
  }
  return gpu as unknown as HostGpuSnapshot;
}

export function validateTaskSnapshot(value: unknown): TaskSnapshot {
  const t = object(value, 'INVALID_TASK_SNAPSHOT');
  exact(t, ['version', 'taskId', 'hostId', 'lifecycle', 'freshness', 'statusObservedAt', 'confidence', 'reason', 'evidence', 'currentRun', 'processes', 'queueLock', 'progress', 'checkpoint', 'resources', 'gpuUsage', 'autoStart'], 'INVALID_TASK_SNAPSHOT');
  if (t.version !== 1 || !string(t.taskId) || !string(t.hostId) || !enumIs(t.lifecycle, ['running', 'queued', 'ready_not_training', 'completed', 'failed', 'unconfirmed', 'not_observed', 'unknown']) || !isFreshness(t.freshness) || !validTime(t.statusObservedAt) || !enumIs(t.confidence, ['high', 'medium', 'low', 'none']) || !string(t.reason, true) || !Array.isArray(t.evidence)) throw new TypeError('INVALID_TASK_SNAPSHOT');
  for (const e of t.evidence) { const item = object(e, 'INVALID_TASK_SNAPSHOT'); exact(item, ['kind', 'sourceId', 'observedAt', 'confidence', 'summary'], 'INVALID_TASK_SNAPSHOT'); if (!string(item.kind) || !nullableString(item.sourceId) || !validTime(item.observedAt) || item.observedAt === null || !enumIs(item.confidence, ['high', 'medium', 'low', 'none']) || !string(item.summary, true)) throw new TypeError('INVALID_TASK_SNAPSHOT'); }
  if (t.currentRun !== null) { const run = object(t.currentRun, 'INVALID_TASK_SNAPSHOT'); exact(run, ['runId', 'mainProcessKey'], 'INVALID_TASK_SNAPSHOT'); if (!string(run.runId) || !processKey(run.mainProcessKey) || run.mainProcessKey === null) throw new TypeError('INVALID_TASK_SNAPSHOT'); }
  if (t.autoStart !== undefined) validateAutoStartStatus(t.autoStart);
  if (t.gpuUsage !== undefined) {
    const gpu = object(t.gpuUsage, 'INVALID_TASK_GPU');
    exact(gpu, ['observedAt', 'freshness', 'state', 'errorCode', 'processKeys'], 'INVALID_TASK_GPU');
    stamp({ observedAt: gpu.observedAt, freshness: gpu.freshness });
    if (!enumIs(gpu.state, ['available', 'unavailable']) || !nullableString(gpu.errorCode) || !Array.isArray(gpu.processKeys) || gpu.processKeys.length > 64 || gpu.processKeys.some(key => !key || !processKey(key))) throw new TypeError('INVALID_TASK_GPU');
  }
  const processes = object(t.processes, 'INVALID_TASK_SNAPSHOT'); exact(processes, ['main', 'queue', 'workers'], 'INVALID_TASK_SNAPSHOT');
  for (const k of ['main', 'queue'] as const) if (processes[k] !== null) validateProcess(processes[k]);
  if (!Array.isArray(processes.workers)) throw new TypeError('INVALID_TASK_SNAPSHOT'); processes.workers.forEach(validateProcess);
  const q = object(t.queueLock, 'INVALID_TASK_SNAPSHOT'); exact(q, ['observedAt', 'freshness', 'source', 'exists', 'heldByRegisteredProcess'], 'INVALID_TASK_SNAPSHOT'); stamp({ observedAt: q.observedAt, freshness: q.freshness }); if (!nullableString(q.source) || (q.exists !== null && typeof q.exists !== 'boolean') || (q.heldByRegisteredProcess !== null && typeof q.heldByRegisteredProcess !== 'boolean')) throw new TypeError('INVALID_TASK_SNAPSHOT');
  const p = object(t.progress, 'INVALID_TASK_SNAPSHOT');
  exact(p, ['observedAt', 'freshness', 'runId', 'lastStepIndex', 'bindingIds', 'baselineEvidenceId', 'resumeCheckpointIndex', 'firstLoopIndex', 'global', 'session', 'configuredTarget', 'iterationsPerSecond', 'etaSeconds'], 'INVALID_TASK_SNAPSHOT'); stamp({ observedAt: p.observedAt, freshness: p.freshness });
  if (!nullableString(p.runId) || !integerOrNull(p.lastStepIndex) || !Array.isArray(p.bindingIds) || p.bindingIds.some((x) => !string(x)) || !nullableString(p.baselineEvidenceId) || !integerOrNull(p.resumeCheckpointIndex) || !integerOrNull(p.firstLoopIndex) || !finiteOrNull(p.iterationsPerSecond) || !finiteOrNull(p.etaSeconds)) throw new TypeError('INVALID_TASK_SNAPSHOT');
  for (const name of ['global', 'session'] as const) { const c = object(p[name], 'INVALID_TASK_SNAPSHOT'); exact(c, ['completedCount', 'targetCount', 'fraction', 'unit', 'verified', 'sourceId'], 'INVALID_TASK_SNAPSHOT'); if (!integerOrNull(c.completedCount) || !integerOrNull(c.targetCount) || !finiteOrNull(c.fraction) || !enumIs(c.unit, ['completed_iterations', 'unknown']) || typeof c.verified !== 'boolean' || !nullableString(c.sourceId)) throw new TypeError('INVALID_TASK_SNAPSHOT'); }
  if (p.configuredTarget !== null) { const c = object(p.configuredTarget, 'INVALID_TASK_SNAPSHOT'); exact(c, ['value', 'meaning'], 'INVALID_TASK_SNAPSHOT'); if (typeof c.value !== 'number' || !Number.isFinite(c.value) || !enumIs(c.meaning, ['exclusive_index', 'count', 'unknown'])) throw new TypeError('INVALID_TASK_SNAPSHOT'); }
  const c = object(t.checkpoint, 'INVALID_TASK_SNAPSHOT'); exact(c, ['observedAt', 'freshness', 'path', 'fileStepIndex', 'stepSource', 'sizeBytes', 'mtime', 'evidence', 'scanComplete'], 'INVALID_TASK_SNAPSHOT'); stamp({ observedAt: c.observedAt, freshness: c.freshness }); if (!nullableString(c.path) || !integerOrNull(c.fileStepIndex) || (c.stepSource !== null && c.stepSource !== 'filename') || !validTime(c.mtime) || (c.sizeBytes !== null && typeof c.sizeBytes !== 'string') || !enumIs(c.evidence, ['none', 'file_found', 'file_stable_observed']) || typeof c.scanComplete !== 'boolean') throw new TypeError('INVALID_TASK_SNAPSHOT'); if (c.sizeBytes !== null) parseBytes(c.sizeBytes as string);
  if (!Array.isArray(t.resources)) throw new TypeError('INVALID_TASK_SNAPSHOT'); t.resources.forEach(validateMetric);
  return t as unknown as TaskSnapshot;
}

export function validateLogSourceSnapshot(value: unknown): LogSourceSnapshot {
  const s = object(value, 'INVALID_LOG_SOURCE'); exact(s, ['observedAt', 'freshness', 'sourceId', 'taskId', 'state', 'generation', 'committedOffset', 'generationStartOffset', 'maxObservedOffset', 'continuityState', 'catchupBytesRead', 'catchupBytesTotal', 'errorCode'], 'INVALID_LOG_SOURCE'); stamp({ observedAt: s.observedAt, freshness: s.freshness });
  if (!string(s.sourceId) || !string(s.taskId) || !enumIs(s.state, ['unobserved', 'ready', 'missing', 'permission_error', 'reading', 'catching_up', 'reconciling', 'paused_budget', 'cache_full', 'storage_error', 'read_error']) || !nullableString(s.generation) || (s.continuityState !== null && !enumIs(s.continuityState, ['tracking', 'reconciling'])) || !nullableString(s.errorCode)) throw new TypeError('INVALID_LOG_SOURCE');
  for (const key of ['committedOffset', 'generationStartOffset', 'maxObservedOffset', 'catchupBytesRead', 'catchupBytesTotal'] as const) if (s[key] !== null) parseBytes(s[key] as string);
  return s as unknown as LogSourceSnapshot;
}

export function validateMonitorSnapshot(value: unknown): MonitorSnapshot {
  const s = object(value, 'INVALID_SNAPSHOT'); exact(s, ['version', 'demo', 'hosts', 'tasks', 'sources'], 'INVALID_SNAPSHOT');
  if (s.version !== 1 || typeof s.demo !== 'boolean' || !Array.isArray(s.hosts) || !Array.isArray(s.tasks) || !Array.isArray(s.sources)) throw new TypeError('INVALID_SNAPSHOT');
  const result = { version: 1 as const, demo: s.demo, hosts: s.hosts.map(validateHostSnapshot), tasks: s.tasks.map(validateTaskSnapshot), sources: s.sources.map(validateLogSourceSnapshot) };
  return result;
}

export function validateLogEvent(value: unknown): LogEvent {
  const e = object(value, 'INVALID_LOG_EVENT'); exact(e, ['version', 'eventId', 'taskId', 'sourceId', 'generation', 'kind', 'startOffset', 'endOffset', 'ingestedAt', 'text', 'reason', 'displayTruncated', 'recordComplete', 'prefixIncomplete', 'runId', 'bindingId'], 'INVALID_LOG_EVENT');
  if (e.version !== 1 || !string(e.eventId) || !string(e.taskId) || !string(e.sourceId) || !string(e.generation) || !enumIs(e.kind, ['line', 'redraw', 'import_boundary', 'generation_started', 'gap_confirmed', 'gap_unknown', 'cache_evicted']) || !validTime(e.ingestedAt) || e.ingestedAt === null || !isBoundedPreview(e.text) || !nullableString(e.reason) || typeof e.displayTruncated !== 'boolean' || (e.recordComplete !== null && typeof e.recordComplete !== 'boolean') || (e.prefixIncomplete !== null && typeof e.prefixIncomplete !== 'boolean') || !nullableString(e.runId) || !nullableString(e.bindingId)) throw new TypeError('INVALID_LOG_EVENT');
  for (const k of ['startOffset', 'endOffset'] as const) if (e[k] !== null) parseBytes(e[k] as string);
  return e as unknown as LogEvent;
}

export function validateLogQuery(value: unknown): LogQuery {
  const q = object(value, 'INVALID_LOG_QUERY'); exact(q, ['requestId', 'sourceId', 'before', 'limit'], 'INVALID_LOG_QUERY');
  if (!string(q.requestId) || !string(q.sourceId) || !nullableString(q.before) || (q.before !== null && q.before.length > 1024) || !Number.isSafeInteger(q.limit) || typeof q.limit !== 'number' || q.limit < 1 || q.limit > PAGE_EVENT_LIMIT) throw new TypeError('INVALID_LOG_QUERY'); return q as unknown as LogQuery;
}
export function validateLogPage(value: unknown): LogPage {
  const p = object(value, 'INVALID_LOG_PAGE'); exact(p, ['events', 'nextBefore', 'truncatedByBudget'], 'INVALID_LOG_PAGE'); if (!Array.isArray(p.events) || p.events.length > PAGE_EVENT_LIMIT || !nullableString(p.nextBefore) || typeof p.truncatedByBudget !== 'boolean') throw new TypeError('INVALID_LOG_PAGE');
  const events = p.events.map(validateLogEvent); const textBytes = events.reduce((n, e) => n + new TextEncoder().encode(e.text ?? '').length, 0); if (textBytes > PAGE_TEXT_BUDGET_BYTES) throw new TypeError('INVALID_LOG_PAGE'); return { events, nextBefore: p.nextBefore, truncatedByBudget: p.truncatedByBudget };
}
export function validateLogSearchRequest(value: unknown): LogSearchRequest {
  const q = object(value, 'INVALID_SEARCH'); exact(q, ['requestId', 'sourceIds', 'literal', 'continuation'], 'INVALID_SEARCH'); if (!string(q.requestId) || !Array.isArray(q.sourceIds) || q.sourceIds.length > 1000 || q.sourceIds.some((s) => !string(s)) || !string(q.literal, true) || q.literal.length > SEARCH_LITERAL_LIMIT || !nullableString(q.continuation)) throw new TypeError('INVALID_SEARCH'); return q as unknown as LogSearchRequest;
}
export function validateLogSearchPage(value: unknown): LogSearchPage {
  const p = object(value, 'INVALID_SEARCH_PAGE'); exact(p, ['events', 'continuation', 'scope', 'cancelled'], 'INVALID_SEARCH_PAGE'); if (!Array.isArray(p.events) || p.events.length > PAGE_EVENT_LIMIT || !nullableString(p.continuation) || p.scope !== 'retained_local' || typeof p.cancelled !== 'boolean') throw new TypeError('INVALID_SEARCH_PAGE'); const events = p.events.map(validateLogEvent); const textBytes = events.reduce((n, e) => n + new TextEncoder().encode(e.text ?? '').length, 0); if (textBytes > PAGE_TEXT_BUDGET_BYTES) throw new TypeError('INVALID_SEARCH_PAGE'); return { events, continuation: p.continuation, scope: 'retained_local', cancelled: p.cancelled };
}
export function validateMonitorUpdate(value: unknown): MonitorUpdate {
  const u = object(value, 'INVALID_UPDATE');
  if (u.kind === 'snapshot') { exact(u, ['kind', 'snapshot'], 'INVALID_UPDATE'); return { kind: 'snapshot', snapshot: validateMonitorSnapshot(u.snapshot) }; }
  if (u.kind === 'logs') { exact(u, ['kind', 'sourceId', 'events'], 'INVALID_UPDATE'); if (!string(u.sourceId) || !Array.isArray(u.events) || u.events.length > PAGE_EVENT_LIMIT) throw new TypeError('INVALID_UPDATE'); const events = u.events.map(validateLogEvent); const textBytes = events.reduce((n, event) => n + new TextEncoder().encode(event.text ?? '').byteLength, 0); if (textBytes > SUBSCRIPTION_TEXT_BUDGET_BYTES) throw new TypeError('INVALID_UPDATE'); return { kind: 'logs', sourceId: u.sourceId, events }; }
  throw new TypeError('INVALID_UPDATE');
}
export function validatePreferences(value: unknown) {
  const p = object(value, 'INVALID_PREFERENCES'); exact(p, ['theme'], 'INVALID_PREFERENCES'); if (!enumIs(p.theme, ['system', 'light', 'dark'])) throw new TypeError('INVALID_PREFERENCES'); return { theme: p.theme as 'system' | 'light' | 'dark' };
}

export function validateRefreshScope(value: unknown): { hostId?: string; taskId?: string } {
  const s = object(value, 'INVALID_SCOPE'); exact(s, ['hostId', 'taskId'], 'INVALID_SCOPE');
  if ((s.hostId !== undefined && !string(s.hostId)) || (s.taskId !== undefined && !string(s.taskId))) throw new TypeError('INVALID_SCOPE');
  return s as { hostId?: string; taskId?: string };
}
