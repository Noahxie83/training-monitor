import { validateAutoStartConfig, validateAutoStartStatus } from './auto-start';
import type {
  AlertEvent,
  AlertEventKind,
  AlertPreferences,
  Bytes,
  CustomPatternConfig,
  DiscoveredProcess,
  DiscoveredSshHost,
  DiscoveredWslDistro,
  Freshness,
  GpuDeviceDetail,
  HostGpuSnapshot,
  HostSnapshot,
  HostSystemHealth,
  HostTarget,
  LogEvent,
  LogSourceSnapshot,
  Preferences,
  Registry,
  ResourceMetric,
  Stamp,
  TaskSnapshot,
  WebhookChannelConfig,
  WindowBounds,
} from './contracts';
import type {
  ControlTaskRequest,
  ExportLogsQuery,
  GpuSeriesQuery,
  LogPage,
  LogQuery,
  LogSearchPage,
  LogSearchRequest,
  MetricSeriesQuery,
  MonitorSnapshot,
  MonitorUpdate,
} from './api';
import {
  EVENT_PREVIEW_BYTES,
  PAGE_EVENT_LIMIT,
  PAGE_TEXT_BUDGET_BYTES,
  SEARCH_LITERAL_LIMIT,
  SUBSCRIPTION_TEXT_BUDGET_BYTES,
} from './budgets';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE_ABS = /^[A-Za-z]:[\\/]/;

const PROGRESS_UNITS = ['step', 'epoch', 'token', 'sample', 'percent', 'completed_iterations', 'unknown'] as const;
const LIFECYCLES = ['running', 'queued', 'ready_not_training', 'completed', 'failed', 'stopped_unconfirmed', 'unconfirmed', 'not_observed', 'unknown'] as const;
const ATTRIBUTION_CONFIDENCES = ['confirmed_process', 'inferred_tree', 'log_only', 'none'] as const;
const LOG_FORMATS = ['generic', 'legacy_flow', 'legacy_score', 'legacy_reflow', 'flow', 'score', 'reflow', 'raw'] as const;
const ALERT_KINDS: readonly AlertEventKind[] = [
  'cuda_oom',
  'process_crashed',
  'loss_nan_inf',
  'training_stalled',
  'training_completed',
  'host_disconnected',
];

/**
 * Guards user-supplied regexes against excessive length, control characters,
 * backreferences, and nested quantifiers that can trigger ReDoS.
 */
export function isSafeRegexPattern(pattern: unknown, maxLength = 256): pattern is string {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > maxLength || CONTROL_CHARS.test(pattern)) {
    return false;
  }
  // Reject backreferences (\1..\9) and lookbehind assertions
  if (/\\[1-9]/.test(pattern) || /\(\?<[=!]/.test(pattern)) return false;
  // Reject obvious nested quantifiers like (a+)+, (.*)*, (a{1,5})+, ([a-z]+){2,}
  if (/\([^()]*[+*][^()]*\)\s*(?:[+*?]|\{\d+)/.test(pattern)) return false;
  if (/\([^()]*\{\d+,\d*\}[^()]*\)\s*(?:[+*]|\{\d+)/.test(pattern)) return false;
  // Reject consecutive quantifiers like ++, **, *+, +*
  if (/(?<!\\)[+*]\s*[+*]/.test(pattern)) return false;
  // Limit total grouping / alternation complexity
  const parens = (pattern.match(/\(/g) ?? []).length;
  const alternations = (pattern.match(/\|/g) ?? []).length;
  if (parens > 12 || alternations > 16) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

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

export function isValidAbsolutePath(value: unknown, allowWindowsDrive = false): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || CONTROL_CHARS.test(value)) return false;
  if (value.startsWith('/')) {
    return !value.split('/').includes('..');
  }
  if (allowWindowsDrive && WINDOWS_DRIVE_ABS.test(value)) {
    return !value.split(/[\\/]/).includes('..');
  }
  return false;
}

function isSafeSshToken(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.startsWith('-') &&
    !WHITESPACE_OR_CONTROL.test(value);
}

function isSafePathOption(value: unknown, maxLength = 1024): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARS.test(value);
}

export function validateHostTarget(value: unknown, code = 'INVALID_REGISTRY'): HostTarget {
  const target = object(value, code);
  if (target.kind === 'ssh') {
    exact(target, ['kind', 'alias', 'hostname', 'user', 'port', 'identityFile', 'proxyJump', 'pythonPath'], code);
    const hasAlias = target.alias !== undefined;
    const hasHostname = target.hostname !== undefined;
    if (!hasAlias && !hasHostname) throw new TypeError(code);
    if (hasAlias && !isSafeSshToken(target.alias, 255)) throw new TypeError(code);
    if (hasHostname && !isSafeSshToken(target.hostname, 255)) throw new TypeError(code);
    if (target.user !== undefined && !isSafeSshToken(target.user, 128)) throw new TypeError(code);
    if (target.port !== undefined && (typeof target.port !== 'number' || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535)) {
      throw new TypeError(code);
    }
    if (target.identityFile !== undefined && (!isSafePathOption(target.identityFile, 1024) || target.identityFile.startsWith('-'))) {
      throw new TypeError(code);
    }
    if (target.proxyJump !== undefined && !isSafeSshToken(target.proxyJump, 512)) throw new TypeError(code);
    if (target.pythonPath !== undefined && (!isSafePathOption(target.pythonPath, 1024) || /['"`$;|&<>]/.test(target.pythonPath))) {
      throw new TypeError(code);
    }
    return structuredClone(target) as unknown as HostTarget;
  }
  if (target.kind === 'wsl') {
    exact(target, ['kind', 'distribution', 'pythonPath'], code);
    if (
      typeof target.distribution !== 'string' ||
      target.distribution.length === 0 ||
      target.distribution.length > 255 ||
      target.distribution.startsWith('-') ||
      CONTROL_CHARS.test(target.distribution) ||
      /[\\/]/.test(target.distribution)
    ) {
      throw new TypeError(code);
    }
    if (target.pythonPath !== undefined && (!isSafePathOption(target.pythonPath, 1024) || /['"`$;|&<>]/.test(target.pythonPath))) {
      throw new TypeError(code);
    }
    return structuredClone(target) as unknown as HostTarget;
  }
  if (target.kind === 'local') {
    exact(target, ['kind', 'pythonPath'], code);
    if (target.pythonPath !== undefined && !isSafePathOption(target.pythonPath, 1024)) {
      throw new TypeError(code);
    }
    return structuredClone(target) as unknown as HostTarget;
  }
  throw new TypeError(code);
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

function validateCustomPatterns(value: unknown): CustomPatternConfig {
  const cp = object(value, 'INVALID_REGISTRY');
  exact(cp, ['progressRegex', 'metricRegexes', 'jsonFields'], 'INVALID_REGISTRY');
  const result: CustomPatternConfig = {};
  if (cp.progressRegex !== undefined) {
    if (!isSafeRegexPattern(cp.progressRegex)) throw new TypeError('INVALID_REGISTRY');
    result.progressRegex = cp.progressRegex;
  }
  if (cp.metricRegexes !== undefined) {
    const map = object(cp.metricRegexes, 'INVALID_REGISTRY');
    const entries = Object.entries(map);
    if (entries.length > 32) throw new TypeError('INVALID_REGISTRY');
    const validated: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(k) || !isSafeRegexPattern(v)) throw new TypeError('INVALID_REGISTRY');
      validated[k] = v;
    }
    result.metricRegexes = validated;
  }
  if (cp.jsonFields !== undefined) {
    const map = object(cp.jsonFields, 'INVALID_REGISTRY');
    const entries = Object.entries(map);
    if (entries.length > 32) throw new TypeError('INVALID_REGISTRY');
    const validated: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(k) || typeof v !== 'string' || !v || v.length > 128 || CONTROL_CHARS.test(v)) {
        throw new TypeError('INVALID_REGISTRY');
      }
      validated[k] = v;
    }
    result.jsonFields = validated;
  }
  return result;
}

export function validateRegistry(value: unknown): Registry {
  const root = object(value, 'INVALID_REGISTRY');
  exact(root, ['version', 'revision', 'hosts', 'tasks'], 'INVALID_REGISTRY');
  if (root.version !== 2 || !Number.isSafeInteger(root.revision) || (root.revision as number) < 0 || !Array.isArray(root.hosts) || !Array.isArray(root.tasks)) throw new TypeError('INVALID_REGISTRY');
  const hosts = root.hosts.map((entry) => {
    const host = object(entry, 'INVALID_REGISTRY');
    exact(host, ['hostId', 'label', 'enabled', 'allowedRoots', 'target', 'stateDir', 'pollIntervalMs', 'allowJobControl'], 'INVALID_REGISTRY');
    const target = validateHostTarget(host.target, 'INVALID_REGISTRY');
    const allowWin = target.kind === 'local';
    if (
      typeof host.hostId !== 'string' ||
      !host.hostId ||
      host.hostId.length > 256 ||
      CONTROL_CHARS.test(host.hostId) ||
      typeof host.label !== 'string' ||
      host.label.length > 256 ||
      CONTROL_CHARS.test(host.label) ||
      typeof host.enabled !== 'boolean' ||
      !Array.isArray(host.allowedRoots) ||
      host.allowedRoots.some((rootPath) => !isValidAbsolutePath(rootPath, allowWin))
    ) {
      throw new TypeError('INVALID_REGISTRY');
    }
    if (host.stateDir !== undefined && !isValidAbsolutePath(host.stateDir, allowWin)) {
      throw new TypeError('INVALID_REGISTRY');
    }
    if (host.pollIntervalMs !== undefined && (typeof host.pollIntervalMs !== 'number' || !Number.isSafeInteger(host.pollIntervalMs) || host.pollIntervalMs < 2000 || host.pollIntervalMs > 60000)) {
      throw new TypeError('INVALID_REGISTRY');
    }
    if (host.allowJobControl !== undefined && typeof host.allowJobControl !== 'boolean') {
      throw new TypeError('INVALID_REGISTRY');
    }
    return { ...host, target } as Record<string, unknown> & { hostId: string; target: HostTarget };
  });
  const hostMap = new Map(hosts.map((host) => [host.hostId, host]));
  if (hostMap.size !== hosts.length) throw new TypeError('DUPLICATE_ID');
  const seenTaskIds = new Set<string>();
  const seenSourceIds = new Set<string>();
  const tasks = root.tasks.map((entry) => {
    const task = object(entry, 'INVALID_REGISTRY');
    exact(task, [
      'taskId', 'hostId', 'label', 'enabled', 'algorithm', 'logFormat',
      'customPatterns', 'attributionMode', 'allowCrossUidScan', 'autoStart',
      'allowedDirectories', 'entryPaths', 'sources', 'checkpointDirectories',
    ], 'INVALID_REGISTRY');
    if (
      typeof task.taskId !== 'string' || !task.taskId ||
      typeof task.hostId !== 'string' || !hostMap.has(task.hostId) ||
      typeof task.label !== 'string' || typeof task.enabled !== 'boolean' ||
      typeof task.algorithm !== 'string' || task.algorithm.length > 120 || CONTROL_CHARS.test(task.algorithm) ||
      (task.logFormat !== undefined && !enumIs(task.logFormat, LOG_FORMATS)) ||
      (task.attributionMode !== undefined && !enumIs(task.attributionMode, ['auto', 'log_only'])) ||
      (task.allowCrossUidScan !== undefined && typeof task.allowCrossUidScan !== 'boolean')
    ) {
      throw new TypeError('INVALID_REGISTRY');
    }
    if (task.customPatterns !== undefined) {
      validateCustomPatterns(task.customPatterns);
    }
    if (seenTaskIds.has(task.taskId)) throw new TypeError('DUPLICATE_ID'); seenTaskIds.add(task.taskId);
    const parentHost = hostMap.get(task.hostId)!;
    const allowWin = parentHost.target.kind === 'local';
    for (const key of ['allowedDirectories', 'checkpointDirectories'] as const) {
      if (!Array.isArray(task[key]) || task[key].some((dirPath) => !isValidAbsolutePath(dirPath, allowWin))) throw new TypeError('INVALID_REGISTRY');
    }
    if (!Array.isArray(task.entryPaths) || task.entryPaths.some((entryPath) => typeof entryPath !== 'string' || !entryPath || CONTROL_CHARS.test(entryPath))) throw new TypeError('INVALID_REGISTRY');
    if (!Array.isArray(task.sources)) throw new TypeError('INVALID_REGISTRY');
    for (const source of task.sources) {
      const src = object(source, 'INVALID_REGISTRY');
      exact(src, ['sourceId', 'path', 'kind', 'pathMode'], 'INVALID_REGISTRY');
      if (
        typeof src.sourceId !== 'string' || !src.sourceId ||
        !isValidAbsolutePath(src.path, allowWin) ||
        !enumIs(src.kind, ['log', 'status_json', 'queue_lock']) ||
        (src.pathMode !== undefined && !enumIs(src.pathMode, ['exact', 'glob_latest', 'dir_latest']))
      ) {
        throw new TypeError('INVALID_REGISTRY');
      }
      if (seenSourceIds.has(src.sourceId)) throw new TypeError('DUPLICATE_ID'); seenSourceIds.add(src.sourceId);
    }
    if (task.autoStart !== undefined) {
      const autoStart = validateAutoStartConfig(task.autoStart, task as unknown as Registry['tasks'][number]);
      if (autoStart.enabled && autoStart.execution === 'server_tmux' && parentHost.target.kind !== 'ssh') throw new TypeError('AUTO_START_SSH_ONLY');
    }
    return task;
  });
  return { version: 2, revision: root.revision as number, hosts: hosts as unknown as Registry['hosts'], tasks: tasks as unknown as Registry['tasks'] };
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
  exact(p, ['key', 'pid', 'ppid', 'pgid', 'nsPid', 'parentKey', 'cwd', 'scriptEntry', 'launcherEntry', 'exe', 'command', 'role', 'observedAt'], 'INVALID_PROCESS');
  if (
    !processKey(p.key) ||
    !Number.isSafeInteger(p.pid) || typeof p.pid !== 'number' || p.pid <= 0 ||
    (p.ppid !== undefined && !integerOrNull(p.ppid)) ||
    (p.pgid !== undefined && !integerOrNull(p.pgid)) ||
    (p.nsPid !== undefined && !integerOrNull(p.nsPid)) ||
    !processKey(p.parentKey) ||
    !nullableString(p.cwd) ||
    !nullableString(p.scriptEntry) ||
    (p.launcherEntry !== undefined && !nullableString(p.launcherEntry)) ||
    (p.exe !== undefined && !nullableString(p.exe)) ||
    (p.command !== undefined && !nullableString(p.command)) ||
    !enumIs(p.role, ['trainer', 'queue', 'worker', 'unknown']) ||
    !validTime(p.observedAt) || p.observedAt === null
  ) {
    throw new TypeError('INVALID_PROCESS');
  }
}

function validateGpuDeviceDetail(value: unknown): GpuDeviceDetail {
  const d = object(value, 'INVALID_HOST_GPU_SNAPSHOT');
  exact(d, [
    'deviceId', 'index', 'uuid', 'name', 'utilizationPct', 'memoryUsedMiB',
    'memoryTotalMiB', 'memoryFreeMiB', 'temperatureC', 'powerDrawW', 'powerLimitW',
    'fanSpeedPct', 'pciBusId', 'computeMode', 'eccErrors', 'activeProcesses',
  ], 'INVALID_HOST_GPU_SNAPSHOT');
  if (!string(d.deviceId) || !Number.isSafeInteger(d.index) || (d.index as number) < 0 || !string(d.uuid)) {
    throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
  }
  if (d.name !== undefined && !nullableString(d.name)) throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
  for (const numField of ['utilizationPct', 'memoryUsedMiB', 'memoryTotalMiB', 'memoryFreeMiB', 'temperatureC', 'powerDrawW', 'powerLimitW', 'fanSpeedPct', 'eccErrors'] as const) {
    if (d[numField] !== undefined && !finiteOrNull(d[numField])) throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
  }
  for (const strField of ['pciBusId', 'computeMode'] as const) {
    if (d[strField] !== undefined && !nullableString(d[strField])) throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
  }
  if (d.activeProcesses !== undefined) {
    if (!Array.isArray(d.activeProcesses) || d.activeProcesses.length > 128) throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
    for (const proc of d.activeProcesses) {
      const p = object(proc, 'INVALID_HOST_GPU_SNAPSHOT');
      exact(p, ['pid', 'command', 'user', 'memoryMiB', 'smUtilPct'], 'INVALID_HOST_GPU_SNAPSHOT');
      if (!Number.isSafeInteger(p.pid) || (p.pid as number) <= 0 || typeof p.command !== 'string' ||
          (p.user !== undefined && !nullableString(p.user)) || !finiteOrNull(p.memoryMiB) ||
          (p.smUtilPct !== undefined && !finiteOrNull(p.smUtilPct))) {
        throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
      }
    }
  }
  return d as unknown as GpuDeviceDetail;
}

function validateHostSystemHealth(value: unknown): HostSystemHealth {
  const s = object(value, 'INVALID_HOST_SNAPSHOT');
  exact(s, ['observedAt', 'freshness', 'cpuUtilizationPct', 'memoryUsedBytes', 'memoryTotalBytes', 'disks'], 'INVALID_HOST_SNAPSHOT');
  stamp({ observedAt: s.observedAt, freshness: s.freshness });
  if (!finiteOrNull(s.cpuUtilizationPct) || !Array.isArray(s.disks) || s.disks.length > 64) {
    throw new TypeError('INVALID_HOST_SNAPSHOT');
  }
  if (s.memoryUsedBytes !== null) parseBytes(s.memoryUsedBytes as string);
  if (s.memoryTotalBytes !== null) parseBytes(s.memoryTotalBytes as string);
  for (const disk of s.disks) {
    const d = object(disk, 'INVALID_HOST_SNAPSHOT');
    exact(d, ['path', 'usedBytes', 'availableBytes', 'totalBytes'], 'INVALID_HOST_SNAPSHOT');
    if (!string(d.path)) throw new TypeError('INVALID_HOST_SNAPSHOT');
    parseBytes(d.usedBytes as string);
    parseBytes(d.availableBytes as string);
    parseBytes(d.totalBytes as string);
  }
  return s as unknown as HostSystemHealth;
}

export function validateHostSnapshot(value: unknown): HostSnapshot {
  const h = object(value, 'INVALID_HOST_SNAPSHOT');
  exact(h, [
    'observedAt', 'freshness', 'version', 'hostId', 'kind', 'connection',
    'lastSuccessAt', 'lastProbeDurationMs', 'scanComplete', 'errorCode',
    'nextRetryAt', 'consecutiveFailures', 'acceleratorAvailability', 'gpu', 'system',
  ], 'INVALID_HOST_SNAPSHOT');
  stamp({ observedAt: h.observedAt, freshness: h.freshness });
  if (
    h.version !== 1 ||
    !string(h.hostId) ||
    !enumIs(h.kind, ['ssh', 'wsl', 'local']) ||
    !enumIs(h.connection, ['unobserved', 'connecting', 'connected', 'disconnected']) ||
    !validTime(h.lastSuccessAt) ||
    !finiteOrNull(h.lastProbeDurationMs) ||
    (h.lastProbeDurationMs !== null && h.lastProbeDurationMs < 0) ||
    typeof h.scanComplete !== 'boolean' ||
    !nullableString(h.errorCode)
  ) {
    throw new TypeError('INVALID_HOST_SNAPSHOT');
  }
  if (h.nextRetryAt !== undefined && !validTime(h.nextRetryAt)) throw new TypeError('INVALID_HOST_SNAPSHOT');
  if (h.consecutiveFailures !== undefined && (typeof h.consecutiveFailures !== 'number' || !Number.isSafeInteger(h.consecutiveFailures) || h.consecutiveFailures < 0)) {
    throw new TypeError('INVALID_HOST_SNAPSHOT');
  }
  if (h.acceleratorAvailability !== undefined && !enumIs(h.acceleratorAvailability, ['available', 'none', 'unavailable'])) {
    throw new TypeError('INVALID_HOST_SNAPSHOT');
  }
  if (Object.prototype.hasOwnProperty.call(h, 'gpu') && h.gpu !== undefined) validateHostGpuSnapshot(h.gpu);
  if (Object.prototype.hasOwnProperty.call(h, 'system') && h.system !== undefined) validateHostSystemHealth(h.system);
  return h as unknown as HostSnapshot;
}

function validateHostGpuSnapshot(value: unknown): HostGpuSnapshot {
  const gpu = object(value, 'INVALID_HOST_GPU_SNAPSHOT');
  exact(gpu, ['observedAt', 'state', 'acceleratorAvailability', 'errorCode', 'metrics', 'devices'], 'INVALID_HOST_GPU_SNAPSHOT');
  if (!validTime(gpu.observedAt) || !enumIs(gpu.state, ['available', 'unavailable']) ||
      (gpu.acceleratorAvailability !== undefined && !enumIs(gpu.acceleratorAvailability, ['available', 'none', 'unavailable'])) ||
      !nullableString(gpu.errorCode) ||
      !Array.isArray(gpu.metrics) || gpu.metrics.length > 768) throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
  for (const item of gpu.metrics) {
    const metric = validateMetric(item);
    const expectedUnit = metric.name === 'gpu_utilization' ? 'percent_device' : 'bytes';
    if (metric.scope !== 'device' || metric.processKey !== null ||
        !['gpu_utilization', 'gpu_memory_used', 'gpu_memory_total'].includes(metric.name) || metric.unit !== expectedUnit ||
        (metric.value !== null && (metric.value < 0 || (metric.name === 'gpu_utilization' && metric.value > 100)))) {
      throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
    }
  }
  if (gpu.devices !== undefined) {
    if (!Array.isArray(gpu.devices) || gpu.devices.length > 64) throw new TypeError('INVALID_HOST_GPU_SNAPSHOT');
    gpu.devices.forEach(validateGpuDeviceDetail);
  }
  return gpu as unknown as HostGpuSnapshot;
}

function validateCountView(value: unknown): void {
  const c = object(value, 'INVALID_TASK_SNAPSHOT');
  exact(c, ['completedCount', 'targetCount', 'fraction', 'unit', 'verified', 'sourceId'], 'INVALID_TASK_SNAPSHOT');
  if (!finiteOrNull(c.completedCount) || !finiteOrNull(c.targetCount) || !finiteOrNull(c.fraction) ||
      !enumIs(c.unit, PROGRESS_UNITS) || typeof c.verified !== 'boolean' || !nullableString(c.sourceId)) {
    throw new TypeError('INVALID_TASK_SNAPSHOT');
  }
}

export function validateTaskSnapshot(value: unknown): TaskSnapshot {
  const t = object(value, 'INVALID_TASK_SNAPSHOT');
  exact(t, [
    'version', 'taskId', 'hostId', 'lifecycle', 'freshness', 'statusObservedAt',
    'confidence', 'attributionConfidence', 'exitCode', 'terminalSummary', 'reason',
    'evidence', 'currentRun', 'processes', 'queueLock', 'progress', 'checkpoint',
    'resources', 'gpuUsage', 'autoStart',
  ], 'INVALID_TASK_SNAPSHOT');
  if (
    t.version !== 1 || !string(t.taskId) || !string(t.hostId) ||
    !enumIs(t.lifecycle, LIFECYCLES) || !isFreshness(t.freshness) || !validTime(t.statusObservedAt) ||
    !enumIs(t.confidence, ['high', 'medium', 'low', 'none']) ||
    (t.attributionConfidence !== undefined && !enumIs(t.attributionConfidence, ATTRIBUTION_CONFIDENCES)) ||
    (t.exitCode !== undefined && !integerOrNull(t.exitCode)) ||
    (t.terminalSummary !== undefined && !nullableString(t.terminalSummary)) ||
    !string(t.reason, true) || !Array.isArray(t.evidence)
  ) {
    throw new TypeError('INVALID_TASK_SNAPSHOT');
  }
  for (const e of t.evidence) {
    const item = object(e, 'INVALID_TASK_SNAPSHOT');
    exact(item, ['kind', 'sourceId', 'observedAt', 'confidence', 'summary'], 'INVALID_TASK_SNAPSHOT');
    if (!string(item.kind) || !nullableString(item.sourceId) || !validTime(item.observedAt) || item.observedAt === null || !enumIs(item.confidence, ['high', 'medium', 'low', 'none']) || !string(item.summary, true)) {
      throw new TypeError('INVALID_TASK_SNAPSHOT');
    }
  }
  if (t.currentRun !== null) {
    const run = object(t.currentRun, 'INVALID_TASK_SNAPSHOT');
    exact(run, ['runId', 'mainProcessKey'], 'INVALID_TASK_SNAPSHOT');
    if (!string(run.runId) || !processKey(run.mainProcessKey) || run.mainProcessKey === null) throw new TypeError('INVALID_TASK_SNAPSHOT');
  }
  if (t.autoStart !== undefined) validateAutoStartStatus(t.autoStart);
  if (t.gpuUsage !== undefined) {
    const gpu = object(t.gpuUsage, 'INVALID_TASK_GPU');
    exact(gpu, ['observedAt', 'freshness', 'state', 'errorCode', 'processKeys'], 'INVALID_TASK_GPU');
    stamp({ observedAt: gpu.observedAt, freshness: gpu.freshness });
    if (!enumIs(gpu.state, ['available', 'unavailable']) || !nullableString(gpu.errorCode) || !Array.isArray(gpu.processKeys) || gpu.processKeys.length > 64 || gpu.processKeys.some(key => !key || !processKey(key))) {
      throw new TypeError('INVALID_TASK_GPU');
    }
  }
  const processes = object(t.processes, 'INVALID_TASK_SNAPSHOT');
  exact(processes, ['main', 'queue', 'workers'], 'INVALID_TASK_SNAPSHOT');
  for (const k of ['main', 'queue'] as const) if (processes[k] !== null) validateProcess(processes[k]);
  if (!Array.isArray(processes.workers)) throw new TypeError('INVALID_TASK_SNAPSHOT');
  processes.workers.forEach(validateProcess);
  const q = object(t.queueLock, 'INVALID_TASK_SNAPSHOT');
  exact(q, ['observedAt', 'freshness', 'source', 'exists', 'heldByRegisteredProcess'], 'INVALID_TASK_SNAPSHOT');
  stamp({ observedAt: q.observedAt, freshness: q.freshness });
  if (!nullableString(q.source) || (q.exists !== null && typeof q.exists !== 'boolean') || (q.heldByRegisteredProcess !== null && typeof q.heldByRegisteredProcess !== 'boolean')) {
    throw new TypeError('INVALID_TASK_SNAPSHOT');
  }
  const p = object(t.progress, 'INVALID_TASK_SNAPSHOT');
  exact(p, [
    'observedAt', 'freshness', 'runId', 'lastStepIndex', 'bindingIds',
    'baselineEvidenceId', 'resumeCheckpointIndex', 'firstLoopIndex',
    'global', 'session', 'resumedSession', 'unit', 'current', 'total',
    'scalars', 'progressFreshness', 'configuredTarget', 'iterationsPerSecond', 'etaSeconds',
  ], 'INVALID_TASK_SNAPSHOT');
  stamp({ observedAt: p.observedAt, freshness: p.freshness });
  if (
    !nullableString(p.runId) || !integerOrNull(p.lastStepIndex) ||
    !Array.isArray(p.bindingIds) || p.bindingIds.some((x) => !string(x)) ||
    !nullableString(p.baselineEvidenceId) || !integerOrNull(p.resumeCheckpointIndex) ||
    !integerOrNull(p.firstLoopIndex) || !finiteOrNull(p.iterationsPerSecond) || !finiteOrNull(p.etaSeconds) ||
    (p.unit !== undefined && !enumIs(p.unit, PROGRESS_UNITS)) ||
    (p.current !== undefined && !finiteOrNull(p.current)) ||
    (p.total !== undefined && !finiteOrNull(p.total)) ||
    (p.progressFreshness !== undefined && !isFreshness(p.progressFreshness))
  ) {
    throw new TypeError('INVALID_TASK_SNAPSHOT');
  }
  if (p.scalars !== undefined) {
    const scalars = object(p.scalars, 'INVALID_TASK_SNAPSHOT');
    for (const [k, v] of Object.entries(scalars)) {
      if (!string(k) || typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError('INVALID_TASK_SNAPSHOT');
    }
  }
  validateCountView(p.global);
  validateCountView(p.session);
  if (p.resumedSession !== undefined && p.resumedSession !== null) validateCountView(p.resumedSession);
  if (p.configuredTarget !== null) {
    const c = object(p.configuredTarget, 'INVALID_TASK_SNAPSHOT');
    exact(c, ['value', 'meaning'], 'INVALID_TASK_SNAPSHOT');
    if (typeof c.value !== 'number' || !Number.isFinite(c.value) || !enumIs(c.meaning, ['exclusive_index', 'count', 'unknown'])) {
      throw new TypeError('INVALID_TASK_SNAPSHOT');
    }
  }
  const c = object(t.checkpoint, 'INVALID_TASK_SNAPSHOT');
  exact(c, ['observedAt', 'freshness', 'path', 'fileStepIndex', 'stepSource', 'sizeBytes', 'mtime', 'evidence', 'scanComplete', 'isDirectory', 'fileCount', 'name', 'metadata'], 'INVALID_TASK_SNAPSHOT');
  stamp({ observedAt: c.observedAt, freshness: c.freshness });
  if (
    !nullableString(c.path) || !integerOrNull(c.fileStepIndex) ||
    (c.stepSource !== null && c.stepSource !== 'filename' && c.stepSource !== 'metadata') ||
    !validTime(c.mtime) || (c.sizeBytes !== null && typeof c.sizeBytes !== 'string') ||
    !enumIs(c.evidence, ['none', 'file_found', 'file_stable_observed']) ||
    typeof c.scanComplete !== 'boolean' ||
    (c.isDirectory !== undefined && typeof c.isDirectory !== 'boolean') ||
    (c.fileCount !== undefined && !integerOrNull(c.fileCount)) ||
    (c.name !== undefined && !nullableString(c.name))
  ) {
    throw new TypeError('INVALID_TASK_SNAPSHOT');
  }
  if (c.sizeBytes !== null) parseBytes(c.sizeBytes as string);
  if (c.metadata !== undefined && c.metadata !== null) {
    const meta = object(c.metadata, 'INVALID_TASK_SNAPSHOT');
    for (const [k, v] of Object.entries(meta)) {
      if (!string(k) || (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) throw new TypeError('INVALID_TASK_SNAPSHOT');
    }
  }
  if (!Array.isArray(t.resources)) throw new TypeError('INVALID_TASK_SNAPSHOT');
  t.resources.forEach(validateMetric);
  return t as unknown as TaskSnapshot;
}

export function validateLogSourceSnapshot(value: unknown): LogSourceSnapshot {
  const s = object(value, 'INVALID_LOG_SOURCE');
  exact(s, [
    'observedAt', 'freshness', 'sourceId', 'taskId', 'state', 'generation',
    'committedOffset', 'generationStartOffset', 'maxObservedOffset',
    'continuityState', 'catchupBytesRead', 'catchupBytesTotal', 'errorCode', 'resolvedPath',
  ], 'INVALID_LOG_SOURCE');
  stamp({ observedAt: s.observedAt, freshness: s.freshness });
  if (
    !string(s.sourceId) || !string(s.taskId) ||
    !enumIs(s.state, ['unobserved', 'ready', 'missing', 'permission_error', 'reading', 'catching_up', 'reconciling', 'paused_budget', 'cache_full', 'storage_error', 'read_error']) ||
    !nullableString(s.generation) ||
    (s.continuityState !== null && !enumIs(s.continuityState, ['tracking', 'reconciling'])) ||
    !nullableString(s.errorCode) ||
    (s.resolvedPath !== undefined && !nullableString(s.resolvedPath))
  ) {
    throw new TypeError('INVALID_LOG_SOURCE');
  }
  for (const key of ['committedOffset', 'generationStartOffset', 'maxObservedOffset', 'catchupBytesRead', 'catchupBytesTotal'] as const) {
    if (s[key] !== null) parseBytes(s[key] as string);
  }
  return s as unknown as LogSourceSnapshot;
}

export function validateMonitorSnapshot(value: unknown): MonitorSnapshot {
  const s = object(value, 'INVALID_SNAPSHOT');
  exact(s, ['version', 'demo', 'hosts', 'tasks', 'sources'], 'INVALID_SNAPSHOT');
  if (s.version !== 1 || typeof s.demo !== 'boolean' || !Array.isArray(s.hosts) || !Array.isArray(s.tasks) || !Array.isArray(s.sources)) throw new TypeError('INVALID_SNAPSHOT');
  return { version: 1 as const, demo: s.demo, hosts: s.hosts.map(validateHostSnapshot), tasks: s.tasks.map(validateTaskSnapshot), sources: s.sources.map(validateLogSourceSnapshot) };
}

export function validateLogEvent(value: unknown): LogEvent {
  const e = object(value, 'INVALID_LOG_EVENT');
  exact(e, [
    'version', 'eventId', 'taskId', 'sourceId', 'generation', 'kind',
    'startOffset', 'endOffset', 'ingestedAt', 'text', 'rawAnsi', 'reason',
    'displayTruncated', 'recordComplete', 'prefixIncomplete', 'runId', 'bindingId',
  ], 'INVALID_LOG_EVENT');
  if (
    e.version !== 1 || !string(e.eventId) || !string(e.taskId) || !string(e.sourceId) || !string(e.generation) ||
    !enumIs(e.kind, ['line', 'redraw', 'import_boundary', 'generation_started', 'gap_confirmed', 'gap_unknown', 'cache_evicted']) ||
    !validTime(e.ingestedAt) || e.ingestedAt === null || !isBoundedPreview(e.text) ||
    (e.rawAnsi !== undefined && !isBoundedPreview(e.rawAnsi)) ||
    !nullableString(e.reason) || typeof e.displayTruncated !== 'boolean' ||
    (e.recordComplete !== null && typeof e.recordComplete !== 'boolean') ||
    (e.prefixIncomplete !== null && typeof e.prefixIncomplete !== 'boolean') ||
    !nullableString(e.runId) || !nullableString(e.bindingId)
  ) {
    throw new TypeError('INVALID_LOG_EVENT');
  }
  for (const k of ['startOffset', 'endOffset'] as const) if (e[k] !== null) parseBytes(e[k] as string);
  return e as unknown as LogEvent;
}

export function validateLogQuery(value: unknown): LogQuery {
  const q = object(value, 'INVALID_LOG_QUERY');
  exact(q, ['requestId', 'sourceId', 'before', 'limit'], 'INVALID_LOG_QUERY');
  if (!string(q.requestId) || !string(q.sourceId) || !nullableString(q.before) || (q.before !== null && q.before.length > 1024) || !Number.isSafeInteger(q.limit) || typeof q.limit !== 'number' || q.limit < 1 || q.limit > PAGE_EVENT_LIMIT) throw new TypeError('INVALID_LOG_QUERY');
  return q as unknown as LogQuery;
}

export function validateLogPage(value: unknown): LogPage {
  const p = object(value, 'INVALID_LOG_PAGE');
  exact(p, ['events', 'nextBefore', 'truncatedByBudget'], 'INVALID_LOG_PAGE');
  if (!Array.isArray(p.events) || p.events.length > PAGE_EVENT_LIMIT || !nullableString(p.nextBefore) || typeof p.truncatedByBudget !== 'boolean') throw new TypeError('INVALID_LOG_PAGE');
  const events = p.events.map(validateLogEvent);
  const textBytes = events.reduce((n, e) => n + new TextEncoder().encode(e.text ?? '').length, 0);
  if (textBytes > PAGE_TEXT_BUDGET_BYTES) throw new TypeError('INVALID_LOG_PAGE');
  return { events, nextBefore: p.nextBefore, truncatedByBudget: p.truncatedByBudget };
}

export function validateLogSearchRequest(value: unknown): LogSearchRequest {
  const q = object(value, 'INVALID_SEARCH');
  exact(q, ['requestId', 'sourceIds', 'literal', 'continuation', 'mode', 'caseSensitive', 'level'], 'INVALID_SEARCH');
  if (
    !string(q.requestId) || !Array.isArray(q.sourceIds) || q.sourceIds.length > 1000 ||
    q.sourceIds.some((s) => !string(s)) || !string(q.literal, true) ||
    q.literal.length > SEARCH_LITERAL_LIMIT || !nullableString(q.continuation) ||
    (q.mode !== undefined && !enumIs(q.mode, ['literal', 'regex'])) ||
    (q.caseSensitive !== undefined && typeof q.caseSensitive !== 'boolean') ||
    (q.level !== undefined && q.level !== null && !enumIs(q.level, ['error', 'warn', 'info', 'debug']))
  ) {
    throw new TypeError('INVALID_SEARCH');
  }
  if (q.mode === 'regex' && q.literal.length > 0 && !isSafeRegexPattern(q.literal)) {
    throw new TypeError('INVALID_SEARCH_REGEX');
  }
  return q as unknown as LogSearchRequest;
}

export function validateLogSearchPage(value: unknown): LogSearchPage {
  const p = object(value, 'INVALID_SEARCH_PAGE');
  exact(p, ['events', 'continuation', 'scope', 'cancelled'], 'INVALID_SEARCH_PAGE');
  if (!Array.isArray(p.events) || p.events.length > PAGE_EVENT_LIMIT || !nullableString(p.continuation) || p.scope !== 'retained_local' || typeof p.cancelled !== 'boolean') throw new TypeError('INVALID_SEARCH_PAGE');
  const events = p.events.map(validateLogEvent);
  const textBytes = events.reduce((n, e) => n + new TextEncoder().encode(e.text ?? '').length, 0);
  if (textBytes > PAGE_TEXT_BUDGET_BYTES) throw new TypeError('INVALID_SEARCH_PAGE');
  return { events, continuation: p.continuation, scope: 'retained_local', cancelled: p.cancelled };
}

export function validateAlertEvent(value: unknown): AlertEvent {
  const a = object(value, 'INVALID_ALERT');
  exact(a, ['alertId', 'kind', 'taskId', 'hostId', 'severity', 'title', 'message', 'observedAt', 'details'], 'INVALID_ALERT');
  if (
    !string(a.alertId) || !enumIs(a.kind, ALERT_KINDS) || !nullableString(a.taskId) ||
    !string(a.hostId) || !enumIs(a.severity, ['info', 'warning', 'critical']) ||
    !string(a.title) || !string(a.message) || !validTime(a.observedAt) || a.observedAt === null
  ) {
    throw new TypeError('INVALID_ALERT');
  }
  if (a.details !== undefined) {
    const details = object(a.details, 'INVALID_ALERT');
    for (const [k, v] of Object.entries(details)) {
      if (!string(k) || (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) {
        throw new TypeError('INVALID_ALERT');
      }
    }
  }
  return a as unknown as AlertEvent;
}

export function validateMonitorUpdate(value: unknown): MonitorUpdate {
  const u = object(value, 'INVALID_UPDATE');
  if (u.kind === 'snapshot') { exact(u, ['kind', 'snapshot'], 'INVALID_UPDATE'); return { kind: 'snapshot', snapshot: validateMonitorSnapshot(u.snapshot) }; }
  if (u.kind === 'logs') {
    exact(u, ['kind', 'sourceId', 'events'], 'INVALID_UPDATE');
    if (!string(u.sourceId) || !Array.isArray(u.events) || u.events.length > PAGE_EVENT_LIMIT) throw new TypeError('INVALID_UPDATE');
    const events = u.events.map(validateLogEvent);
    const textBytes = events.reduce((n, event) => n + new TextEncoder().encode(event.text ?? '').byteLength, 0);
    if (textBytes > SUBSCRIPTION_TEXT_BUDGET_BYTES) throw new TypeError('INVALID_UPDATE');
    return { kind: 'logs', sourceId: u.sourceId, events };
  }
  if (u.kind === 'alert') {
    exact(u, ['kind', 'alert'], 'INVALID_UPDATE');
    return { kind: 'alert', alert: validateAlertEvent(u.alert) };
  }
  throw new TypeError('INVALID_UPDATE');
}

export function validateWebhookChannelConfig(value: unknown, code = 'INVALID_PREFERENCES'): WebhookChannelConfig {
  const w = object(value, code);
  exact(w, ['enabled', 'kind', 'url', 'label'], code);
  if (typeof w.enabled !== 'boolean' || !enumIs(w.kind, ['feishu', 'slack', 'discord', 'generic']) || typeof w.url !== 'string' || w.url.length === 0 || w.url.length > 2048 || CONTROL_CHARS.test(w.url)) {
    throw new TypeError(code);
  }
  let parsedUrl: URL;
  try { parsedUrl = new URL(w.url); } catch { throw new TypeError(code); }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') throw new TypeError(code);
  if (w.label !== undefined && (typeof w.label !== 'string' || w.label.length > 120 || CONTROL_CHARS.test(w.label))) {
    throw new TypeError(code);
  }
  return structuredClone(w) as unknown as WebhookChannelConfig;
}

function validateAlertPreferences(value: unknown): AlertPreferences {
  const a = object(value, 'INVALID_PREFERENCES');
  exact(a, ['desktopNotifications', 'stallThresholdMinutes', 'hostDisconnectThresholdSeconds', 'cooldownSeconds', 'enabledKinds', 'webhooks'], 'INVALID_PREFERENCES');
  const result: AlertPreferences = {};
  if (a.desktopNotifications !== undefined) {
    if (typeof a.desktopNotifications !== 'boolean') throw new TypeError('INVALID_PREFERENCES');
    result.desktopNotifications = a.desktopNotifications;
  }
  if (a.stallThresholdMinutes !== undefined) {
    if (typeof a.stallThresholdMinutes !== 'number' || !Number.isFinite(a.stallThresholdMinutes) || a.stallThresholdMinutes < 1 || a.stallThresholdMinutes > 1440) {
      throw new TypeError('INVALID_PREFERENCES');
    }
    result.stallThresholdMinutes = a.stallThresholdMinutes;
  }
  if (a.hostDisconnectThresholdSeconds !== undefined) {
    if (typeof a.hostDisconnectThresholdSeconds !== 'number' || !Number.isFinite(a.hostDisconnectThresholdSeconds) || a.hostDisconnectThresholdSeconds < 5 || a.hostDisconnectThresholdSeconds > 86400) {
      throw new TypeError('INVALID_PREFERENCES');
    }
    result.hostDisconnectThresholdSeconds = a.hostDisconnectThresholdSeconds;
  }
  if (a.cooldownSeconds !== undefined) {
    if (typeof a.cooldownSeconds !== 'number' || !Number.isFinite(a.cooldownSeconds) || a.cooldownSeconds < 0 || a.cooldownSeconds > 86400) {
      throw new TypeError('INVALID_PREFERENCES');
    }
    result.cooldownSeconds = a.cooldownSeconds;
  }
  if (a.enabledKinds !== undefined) {
    if (!Array.isArray(a.enabledKinds) || a.enabledKinds.some((k) => !enumIs(k, ALERT_KINDS))) {
      throw new TypeError('INVALID_PREFERENCES');
    }
    result.enabledKinds = [...new Set(a.enabledKinds as AlertEventKind[])];
  }
  if (a.webhooks !== undefined) {
    if (!Array.isArray(a.webhooks) || a.webhooks.length > 16) throw new TypeError('INVALID_PREFERENCES');
    result.webhooks = a.webhooks.map((w) => validateWebhookChannelConfig(w, 'INVALID_PREFERENCES'));
  }
  return result;
}

function validateWindowBounds(value: unknown): WindowBounds {
  const b = object(value, 'INVALID_PREFERENCES');
  exact(b, ['x', 'y', 'width', 'height', 'isMaximized'], 'INVALID_PREFERENCES');
  if (
    typeof b.x !== 'number' || !Number.isFinite(b.x) ||
    typeof b.y !== 'number' || !Number.isFinite(b.y) ||
    typeof b.width !== 'number' || !Number.isFinite(b.width) || b.width < 1 ||
    typeof b.height !== 'number' || !Number.isFinite(b.height) || b.height < 1 ||
    (b.isMaximized !== undefined && typeof b.isMaximized !== 'boolean')
  ) {
    throw new TypeError('INVALID_PREFERENCES');
  }
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
    ...(b.isMaximized !== undefined ? { isMaximized: b.isMaximized } : {}),
  };
}

export function validatePreferences(value: unknown): Preferences {
  const p = object(value, 'INVALID_PREFERENCES');
  exact(p, ['theme', 'locale', 'minimizeToTrayOnClose', 'launchAtLogin', 'windowBounds', 'alerts'], 'INVALID_PREFERENCES');
  if (!enumIs(p.theme, ['system', 'light', 'dark'])) throw new TypeError('INVALID_PREFERENCES');
  if (p.locale !== undefined && !enumIs(p.locale, ['zh-CN', 'en-US'])) throw new TypeError('INVALID_PREFERENCES');
  if (p.minimizeToTrayOnClose !== undefined && typeof p.minimizeToTrayOnClose !== 'boolean') throw new TypeError('INVALID_PREFERENCES');
  if (p.launchAtLogin !== undefined && typeof p.launchAtLogin !== 'boolean') throw new TypeError('INVALID_PREFERENCES');
  const result: Preferences = { theme: p.theme as Preferences['theme'] };
  if (p.locale !== undefined) result.locale = p.locale as Preferences['locale'];
  if (p.minimizeToTrayOnClose !== undefined) result.minimizeToTrayOnClose = p.minimizeToTrayOnClose;
  if (p.launchAtLogin !== undefined) result.launchAtLogin = p.launchAtLogin;
  if (p.windowBounds !== undefined) {
    const bounds = object(p.windowBounds, 'INVALID_PREFERENCES');
    exact(bounds, ['main', 'gpu'], 'INVALID_PREFERENCES');
    result.windowBounds = {
      ...(bounds.main === undefined ? {} : { main: validateWindowBounds(bounds.main) }),
      ...(bounds.gpu === undefined ? {} : { gpu: validateWindowBounds(bounds.gpu) }),
    };
  }
  if (p.alerts !== undefined) result.alerts = validateAlertPreferences(p.alerts);
  return result;
}

export function validateRefreshScope(value: unknown): { hostId?: string; taskId?: string } {
  const s = object(value, 'INVALID_SCOPE');
  exact(s, ['hostId', 'taskId'], 'INVALID_SCOPE');
  if ((s.hostId !== undefined && !string(s.hostId)) || (s.taskId !== undefined && !string(s.taskId))) throw new TypeError('INVALID_SCOPE');
  return s as { hostId?: string; taskId?: string };
}

export function validateMetricSeriesQuery(value: unknown): MetricSeriesQuery {
  const q = object(value, 'INVALID_METRIC_QUERY');
  exact(q, ['taskId', 'metrics', 'rangeMs', 'maxPoints'], 'INVALID_METRIC_QUERY');
  if (!string(q.taskId)) throw new TypeError('INVALID_METRIC_QUERY');
  if (q.metrics !== undefined && (!Array.isArray(q.metrics) || q.metrics.length > 32 || q.metrics.some((m) => !string(m) || m.length > 64))) {
    throw new TypeError('INVALID_METRIC_QUERY');
  }
  if (q.rangeMs !== undefined && (typeof q.rangeMs !== 'number' || !Number.isFinite(q.rangeMs) || q.rangeMs <= 0)) {
    throw new TypeError('INVALID_METRIC_QUERY');
  }
  if (q.maxPoints !== undefined && (!Number.isSafeInteger(q.maxPoints) || (q.maxPoints as number) < 2 || (q.maxPoints as number) > 2000)) {
    throw new TypeError('INVALID_METRIC_QUERY');
  }
  return q as unknown as MetricSeriesQuery;
}

export function validateGpuSeriesQuery(value: unknown): GpuSeriesQuery {
  const q = object(value, 'INVALID_GPU_SERIES_QUERY');
  exact(q, ['hostId', 'deviceId', 'rangeMs', 'maxPoints'], 'INVALID_GPU_SERIES_QUERY');
  if (!string(q.hostId)) throw new TypeError('INVALID_GPU_SERIES_QUERY');
  if (q.deviceId !== undefined && !string(q.deviceId)) throw new TypeError('INVALID_GPU_SERIES_QUERY');
  if (q.rangeMs !== undefined && (typeof q.rangeMs !== 'number' || !Number.isFinite(q.rangeMs) || q.rangeMs <= 0)) {
    throw new TypeError('INVALID_GPU_SERIES_QUERY');
  }
  if (q.maxPoints !== undefined && (!Number.isSafeInteger(q.maxPoints) || (q.maxPoints as number) < 2 || (q.maxPoints as number) > 2000)) {
    throw new TypeError('INVALID_GPU_SERIES_QUERY');
  }
  return q as unknown as GpuSeriesQuery;
}

export function validateExportLogsQuery(value: unknown): ExportLogsQuery {
  const q = object(value, 'INVALID_EXPORT_QUERY');
  exact(q, ['sourceIds', 'literal', 'mode', 'caseSensitive', 'level', 'destinationPath'], 'INVALID_EXPORT_QUERY');
  if (!Array.isArray(q.sourceIds) || q.sourceIds.length === 0 || q.sourceIds.length > 100 || q.sourceIds.some((s) => !string(s))) {
    throw new TypeError('INVALID_EXPORT_QUERY');
  }
  if (q.literal !== undefined && (!string(q.literal, true) || q.literal.length > SEARCH_LITERAL_LIMIT)) throw new TypeError('INVALID_EXPORT_QUERY');
  if (q.mode !== undefined && !enumIs(q.mode, ['literal', 'regex'])) throw new TypeError('INVALID_EXPORT_QUERY');
  if (q.mode === 'regex' && q.literal && !isSafeRegexPattern(q.literal)) throw new TypeError('INVALID_SEARCH_REGEX');
  if (q.caseSensitive !== undefined && typeof q.caseSensitive !== 'boolean') throw new TypeError('INVALID_EXPORT_QUERY');
  if (q.level !== undefined && q.level !== null && !enumIs(q.level, ['error', 'warn', 'info', 'debug'])) throw new TypeError('INVALID_EXPORT_QUERY');
  if (q.destinationPath !== undefined && (!string(q.destinationPath) || CONTROL_CHARS.test(q.destinationPath))) throw new TypeError('INVALID_EXPORT_QUERY');
  return q as unknown as ExportLogsQuery;
}

export function validateControlTaskRequest(value: unknown): ControlTaskRequest {
  const r = object(value, 'INVALID_JOB_CONTROL');
  exact(r, ['taskId', 'action', 'confirmToken'], 'INVALID_JOB_CONTROL');
  if (!string(r.taskId) || !enumIs(r.action, ['stop', 'kill', 'restart']) || !string(r.confirmToken) || r.confirmToken.length < 8 || r.confirmToken.length > 128) {
    throw new TypeError('INVALID_JOB_CONTROL');
  }
  return r as unknown as ControlTaskRequest;
}

export function validateDiscoveredProcesses(value: unknown): DiscoveredProcess[] {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('INVALID_DISCOVERED_PROCESSES');
  return value.map((item) => {
    const p = object(item, 'INVALID_DISCOVERED_PROCESSES');
    exact(p, ['pid', 'pgid', 'command', 'cwd', 'gpuIndices', 'gpuMemoryMiB', 'openLogPaths', 'suggestedName', 'suggestedEntry'], 'INVALID_DISCOVERED_PROCESSES');
    if (
      !Number.isSafeInteger(p.pid) || (p.pid as number) <= 0 ||
      !integerOrNull(p.pgid) ||
      typeof p.command !== 'string' || !nullableString(p.cwd) ||
      !Array.isArray(p.gpuIndices) || p.gpuIndices.some((i) => !Number.isSafeInteger(i) || (i as number) < 0) ||
      !finiteOrNull(p.gpuMemoryMiB) ||
      !Array.isArray(p.openLogPaths) || p.openLogPaths.some((l) => typeof l !== 'string') ||
      typeof p.suggestedName !== 'string' || !nullableString(p.suggestedEntry)
    ) {
      throw new TypeError('INVALID_DISCOVERED_PROCESSES');
    }
    return p as unknown as DiscoveredProcess;
  });
}

export function validateDiscoveredSshHosts(value: unknown): DiscoveredSshHost[] {
  if (!Array.isArray(value) || value.length > 512) throw new TypeError('INVALID_DISCOVERED_HOSTS');
  return value.map((item) => {
    const h = object(item, 'INVALID_DISCOVERED_HOSTS');
    exact(h, ['alias', 'hostname', 'user', 'port', 'identityFile', 'proxyJump'], 'INVALID_DISCOVERED_HOSTS');
    if (!isSafeSshToken(h.alias, 255)) throw new TypeError('INVALID_DISCOVERED_HOSTS');
    const result: DiscoveredSshHost = { alias: h.alias };
    if (h.hostname !== undefined) {
      if (!isSafeSshToken(h.hostname, 255)) throw new TypeError('INVALID_DISCOVERED_HOSTS');
      result.hostname = h.hostname;
    }
    if (h.user !== undefined) {
      if (!isSafeSshToken(h.user, 128)) throw new TypeError('INVALID_DISCOVERED_HOSTS');
      result.user = h.user;
    }
    if (h.port !== undefined) {
      if (typeof h.port !== 'number' || !Number.isSafeInteger(h.port) || h.port < 1 || h.port > 65535) throw new TypeError('INVALID_DISCOVERED_HOSTS');
      result.port = h.port;
    }
    if (h.identityFile !== undefined) {
      if (!isSafePathOption(h.identityFile, 1024)) throw new TypeError('INVALID_DISCOVERED_HOSTS');
      result.identityFile = h.identityFile;
    }
    if (h.proxyJump !== undefined) {
      if (!isSafeSshToken(h.proxyJump, 512)) throw new TypeError('INVALID_DISCOVERED_HOSTS');
      result.proxyJump = h.proxyJump;
    }
    return result;
  });
}

export function validateDiscoveredWslDistros(value: unknown): DiscoveredWslDistro[] {
  if (!Array.isArray(value) || value.length > 128) throw new TypeError('INVALID_DISCOVERED_WSL');
  return value.map((item) => {
    const d = object(item, 'INVALID_DISCOVERED_WSL');
    exact(d, ['name', 'running'], 'INVALID_DISCOVERED_WSL');
    if (typeof d.name !== 'string' || !d.name || d.name.length > 255 || CONTROL_CHARS.test(d.name) || typeof d.running !== 'boolean') {
      throw new TypeError('INVALID_DISCOVERED_WSL');
    }
    return { name: d.name, running: d.running };
  });
}
