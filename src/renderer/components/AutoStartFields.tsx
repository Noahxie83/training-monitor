import React from 'react';
import type { AutoStartConfig, HostSnapshot, TaskRegistration } from '../../shared/contracts';
import { Icon } from './Icon';

export interface EnvKvPair {
  key: string;
  value: string;
}

/** Editable shape of the auto-start configuration; every field is text so the form stays lossless. */
export interface AutoStartDraft {
  enabled: boolean;
  retryOnExit?: boolean;
  maxRetries?: string;
  retryBackoffSeconds?: string;
  gpuText: string;
  gpuExcludeText?: string;
  requiredGpuCount?: string;
  cudaVisibleDevicesMode?: 'index' | 'uuid';
  thresholdMode?: 'idle_cap' | 'free_mem';
  idleSeconds: string;
  maxUtilizationPercent: string;
  maxMemoryMiB: string;
  minFreeMemoryMiB?: string;
  minFreeDiskMiB?: string;
  sharingGroup?: string;
  maxDevices?: string;
  maxWorkersPerDevice?: string;
  launchMode?: 'python_script' | 'python_module' | 'command';
  pythonPath: string;
  entryPath: string;
  moduleName?: string;
  commandText?: string;
  cwd: string;
  arguments: string;
  logSourceId: string;
  condaEnv?: string;
  venvPath?: string;
  modulesText?: string;
  envPairs?: EnvKvPair[];
}

export interface AutoStartContext {
  entryPaths: string[];
  allowedDirectories: string[];
  logSources: { sourceId: string; path: string }[];
  hasStatusSource?: boolean;
  defaultGpuText?: string;
}

export type AutoStartPayload = Omit<AutoStartConfig, 'armId' | 'enabled'>;

export const AUTO_START_DEFAULTS = {
  idleSeconds: '60',
  maxUtilizationPercent: '5',
  maxMemoryMiB: '1024',
  pythonPath: '/usr/bin/python3',
} as const;

export const AUTO_START_HELP =
  '在服务器 tmux 中监控全部 GPU，任意一张卡（或指定数量）连续空闲达到设定时长后自动启动。本机关机后仍会继续等待。';

const GPU_INDEX = /^(0|[1-9]\d{0,3})$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function newAutoStartArmId(): string {
  const cryptoRef = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') cryptoRef.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deviceIdToIndex(deviceId: string): string {
  return deviceId.replace(/^GPU[-\s]?/, '');
}

export function normalizeGpuDeviceId(raw: string): string | null {
  const match = /^GPU[-\s]?(\d+)$/.exec(raw.trim());
  if (!match || !GPU_INDEX.test(match[1]!)) return null;
  return `GPU ${match[1]}`;
}

export interface GpuCard {
  deviceId: string;
  utilization: number | null;
  memoryUsedMiB: number | null;
}

export function hostGpuCards(hostSnapshots: HostSnapshot[] | undefined, hostId: string | undefined): GpuCard[] {
  if (!hostSnapshots || !hostId) return [];
  const host = hostSnapshots.find((item) => item.hostId === hostId);
  if (!host || host.connection !== 'connected' || host.gpu?.state !== 'available') return [];
  const cards = new Map<string, GpuCard>();
  for (const metric of host?.gpu?.metrics ?? []) {
    if (metric.scope !== 'device' || !metric.deviceId) continue;
    if (metric.freshness !== 'fresh' || metric.observedAt !== host?.gpu?.observedAt || metric.value === null || !Number.isFinite(metric.value) || metric.value < 0) continue;
    const deviceId = normalizeGpuDeviceId(metric.deviceId);
    if (!deviceId) continue;
    const card = cards.get(deviceId) ?? { deviceId, utilization: null, memoryUsedMiB: null };
    if (metric.name === 'gpu_utilization' && metric.unit === 'percent_device') card.utilization = metric.value;
    if (metric.name === 'gpu_memory_used' && metric.unit === 'bytes') card.memoryUsedMiB = metric.value / (1024 * 1024);
    cards.set(deviceId, card);
  }
  return Array.from(cards.values()).sort((a, b) => a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true }));
}

export function parseGpuTokens(text: string): { ids: string[]; invalid: boolean } {
  const tokens = text
    .split(/[,;\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const ids: string[] = [];
  let invalid = false;
  for (const token of tokens) {
    const digits = /^GPU[-\s]?(\d+)$/.test(token) ? RegExp.$1 : /^\d+$/.test(token) ? token : null;
    if (digits === null || !GPU_INDEX.test(digits)) {
      invalid = true;
      continue;
    }
    const id = `GPU ${digits}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, invalid };
}

export function createAutoStartDraft(config: AutoStartConfig | null | undefined, context: AutoStartContext): AutoStartDraft {
  if (config) {
    const inferredMode: 'python_script' | 'python_module' | 'command' =
      config.launch.mode ??
      (config.launch.command?.length ? 'command' : config.launch.moduleName ? 'python_module' : 'python_script');
    return {
      enabled: config.enabled,
      retryOnExit: config.retryOnExit ?? false,
      ...(config.maxRetries !== undefined ? { maxRetries: String(config.maxRetries) } : {}),
      ...(config.retryBackoffSeconds !== undefined ? { retryBackoffSeconds: String(config.retryBackoffSeconds) } : {}),
      gpuText: config.gpuDeviceIds.map(deviceIdToIndex).join(', '),
      ...(config.gpuExcludeIds?.length ? { gpuExcludeText: config.gpuExcludeIds.map(deviceIdToIndex).join(', ') } : {}),
      ...(config.requiredGpuCount !== undefined ? { requiredGpuCount: String(config.requiredGpuCount) } : {}),
      ...(config.cudaVisibleDevicesMode !== undefined ? { cudaVisibleDevicesMode: config.cudaVisibleDevicesMode } : {}),
      thresholdMode: config.minFreeMemoryMiB && config.minFreeMemoryMiB > 0 ? 'free_mem' : 'idle_cap',
      idleSeconds: String(config.idleSeconds),
      maxUtilizationPercent: String(config.maxUtilizationPercent),
      maxMemoryMiB: String(config.maxMemoryMiB),
      minFreeMemoryMiB: String(config.minFreeMemoryMiB ?? 0),
      minFreeDiskMiB: String(config.minFreeDiskMiB ?? 0),
      sharingGroup: config.gpuSharing?.groupId ?? '',
      maxDevices: String(config.gpuSharing?.maxDevices ?? 3),
      maxWorkersPerDevice: String(config.gpuSharing?.maxWorkersPerDevice ?? 2),
      launchMode: inferredMode,
      pythonPath: config.launch.pythonPath ?? AUTO_START_DEFAULTS.pythonPath,
      entryPath: config.launch.entryPath ?? context.entryPaths[0] ?? '',
      moduleName: config.launch.moduleName ?? '',
      commandText: config.launch.command?.join(' ') ?? '',
      cwd: config.launch.cwd,
      arguments: config.launch.arguments,
      logSourceId: config.launch.logSourceId,
      condaEnv: config.launch.condaEnv ?? '',
      venvPath: config.launch.venvPath ?? '',
      modulesText: config.launch.modules?.join(', ') ?? '',
      envPairs: config.launch.env
        ? Object.entries(config.launch.env).map(([key, value]) => ({ key, value }))
        : [],
    };
  }
  return {
    enabled: false,
    retryOnExit: false,
    gpuText: context.defaultGpuText ?? '',
    thresholdMode: 'idle_cap',
    idleSeconds: AUTO_START_DEFAULTS.idleSeconds,
    maxUtilizationPercent: AUTO_START_DEFAULTS.maxUtilizationPercent,
    maxMemoryMiB: AUTO_START_DEFAULTS.maxMemoryMiB,
    launchMode: 'python_script',
    pythonPath: AUTO_START_DEFAULTS.pythonPath,
    entryPath: context.entryPaths[0] ?? '',
    moduleName: '',
    commandText: '',
    cwd: context.allowedDirectories[0] ?? '',
    arguments: '',
    logSourceId: context.logSources[0]?.sourceId ?? '',
    condaEnv: '',
    venvPath: '',
    modulesText: '',
    envPairs: [],
  };
}

export function resolveAutoStartDraft(draft: AutoStartDraft, context: AutoStartContext): AutoStartDraft {
  return {
    ...draft,
    entryPath: draft.entryPath || context.entryPaths[0] || '',
    cwd: draft.cwd || context.allowedDirectories[0] || '',
    logSourceId: draft.logSourceId || context.logSources[0]?.sourceId || '',
  };
}

function withinAllowedDirectory(cwd: string, allowedDirectories: string[]): boolean {
  return allowedDirectories.some((dir) => cwd === dir || cwd.startsWith(dir.replace(/\/$/, '') + '/'));
}

export function buildAutoStartPayload(
  draft: AutoStartDraft,
  context: AutoStartContext,
): { payload: AutoStartPayload | null; error: string | null } {
  const idleText = draft.idleSeconds.trim();
  const idleSeconds = Number(idleText);
  if (!/^\d+$/.test(idleText) || !Number.isSafeInteger(idleSeconds) || idleSeconds < 1 || idleSeconds > 86400) {
    return { payload: null, error: '空闲等待时长需为 1–86400 秒之间的整数' };
  }

  const useFreeMem = draft.thresholdMode === 'free_mem' || (draft.thresholdMode === undefined && Number(draft.minFreeMemoryMiB ?? 0) > 0);
  const utilizationText = useFreeMem ? '100' : draft.maxUtilizationPercent.trim();
  const maxUtilizationPercent = Number(utilizationText);
  if (!utilizationText || !Number.isFinite(maxUtilizationPercent) || maxUtilizationPercent < 0 || maxUtilizationPercent > 100) {
    return { payload: null, error: '最大利用率阈值需为 0–100 之间的数值' };
  }

  const memoryText = draft.maxMemoryMiB.trim();
  const maxMemoryMiB = Number(memoryText);
  if (!/^\d+$/.test(memoryText) || !Number.isSafeInteger(maxMemoryMiB) || maxMemoryMiB < 0 || maxMemoryMiB > 1048576) {
    return { payload: null, error: '最大显存占用需为 0–1048576 MiB 之间的整数' };
  }

  const parsedGpus = parseGpuTokens(draft.gpuText ?? '');
  if (parsedGpus.invalid) {
    return { payload: null, error: 'GPU 白名单格式无效，请使用逗号分隔的数字编号（例如 0, 1）' };
  }
  const parsedExcludes = parseGpuTokens(draft.gpuExcludeText ?? '');
  if (parsedExcludes.invalid) {
    return { payload: null, error: 'GPU 黑名单格式无效，请使用逗号分隔的数字编号' };
  }

  let requiredGpuCount: number | undefined;
  if (draft.requiredGpuCount !== undefined && draft.requiredGpuCount.trim() !== '') {
    const reqText = draft.requiredGpuCount.trim();
    const n = Number(reqText);
    if (!/^\d+$/.test(reqText) || !Number.isSafeInteger(n) || n < 1 || n > 64) {
      return { payload: null, error: '所需 GPU 数量需为 1–64 之间的整数' };
    }
    if (n !== 1) requiredGpuCount = n;
  }

  let maxRetries: number | undefined;
  if (draft.maxRetries !== undefined && draft.maxRetries.trim() !== '') {
    const mrText = draft.maxRetries.trim();
    const n = Number(mrText);
    if (!/^\d+$/.test(mrText) || !Number.isSafeInteger(n) || n < 0 || n > 100) {
      return { payload: null, error: '最大重试次数需为 0–100 之间的整数' };
    }
    maxRetries = n;
  }

  let retryBackoffSeconds: number | undefined;
  if (draft.retryBackoffSeconds !== undefined && draft.retryBackoffSeconds.trim() !== '') {
    const rbText = draft.retryBackoffSeconds.trim();
    const n = Number(rbText);
    if (!/^\d+$/.test(rbText) || !Number.isSafeInteger(n) || n < 0 || n > 86400) {
      return { payload: null, error: '重试退避时长需为 0–86400 秒之间的整数' };
    }
    retryBackoffSeconds = n;
  }

  const minFreeMemoryMiB = useFreeMem ? Number(draft.minFreeMemoryMiB ?? 0) : 0;
  const minFreeDiskMiB = Number(draft.minFreeDiskMiB ?? 0);
  const sharingGroup = draft.sharingGroup?.trim() ?? '';
  const maxDevices = Number(draft.maxDevices ?? 3);
  const maxWorkersPerDevice = Number(draft.maxWorkersPerDevice ?? 2);
  if (![minFreeMemoryMiB, minFreeDiskMiB].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1048576)) {
    return { payload: null, error: '可用显存和磁盘门槛需为非负整数（MiB）' };
  }
  if (useFreeMem && minFreeMemoryMiB < 1) {
    return { payload: null, error: '最低可用显存模式下需填写大于 0 的数值（MiB）' };
  }
  if (
    sharingGroup &&
    (!/^[A-Za-z0-9_-]{1,128}$/.test(sharingGroup) ||
      !minFreeMemoryMiB ||
      !Number.isInteger(maxDevices) ||
      maxDevices < 1 ||
      maxDevices > 64 ||
      !Number.isInteger(maxWorkersPerDevice) ||
      maxWorkersPerDevice < 1 ||
      maxWorkersPerDevice > 16)
  ) {
    return { payload: null, error: '共享组需设置最低可用显存、GPU 数量和每卡进程数' };
  }

  const mode = draft.launchMode ?? 'python_script';
  const pythonPath = draft.pythonPath.trim();
  const launchSpec: AutoStartConfig['launch'] = {
    cwd: '',
    arguments: draft.arguments,
    logSourceId: draft.logSourceId,
  };
  if (mode !== 'python_script') launchSpec.mode = mode;

  if (mode === 'python_script' || mode === 'python_module') {
    if (!pythonPath.startsWith('/')) return { payload: null, error: 'Python 路径需为宿主上的绝对路径，例如 /usr/bin/python3' };
    if (pythonPath.split('/').includes('..')) return { payload: null, error: 'Python 路径不能包含 .. 路径段' };
    const pythonName = pythonPath.split('/').filter(Boolean).pop() ?? '';
    if (!/^python(?:3(?:\.\d+)?)?$/.test(pythonName)) {
      return { payload: null, error: 'Python 可执行文件需形如 python3 或 python3.12' };
    }
    launchSpec.pythonPath = pythonPath;
  }

  if (mode === 'python_script') {
    if (context.entryPaths.length === 0) return { payload: null, error: '请先填写脚本入口，再配置自动启动' };
    if (!context.entryPaths.includes(draft.entryPath)) return { payload: null, error: '请选择任务已登记的脚本入口' };
    launchSpec.entryPath = draft.entryPath;
  } else if (mode === 'python_module') {
    const mod = (draft.moduleName ?? '').trim();
    if (!mod || !/^[A-Za-z_][A-Za-z0-9_.]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(mod)) {
      return { payload: null, error: 'Python 模块名无效（例如 torch.distributed.run）' };
    }
    launchSpec.moduleName = mod;
  } else {
    const tokens = (draft.commandText ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) {
      return { payload: null, error: '自定义命令模式需填写可执行命令（例如 torchrun --nproc_per_node=2 train.py）' };
    }
    launchSpec.command = tokens;
  }

  const cwd = draft.cwd.trim();
  if (!cwd.startsWith('/')) return { payload: null, error: '工作目录需为宿主上的绝对路径' };
  if (cwd.split('/').includes('..')) return { payload: null, error: '工作目录不能包含 .. 路径段' };
  if (!withinAllowedDirectory(cwd, context.allowedDirectories)) {
    return { payload: null, error: '工作目录需位于已登记的工作目录内' };
  }
  launchSpec.cwd = cwd;

  if (draft.arguments.length > 8192 || /[\u0000-\u001f\u007f]/.test(draft.arguments)) {
    return { payload: null, error: '启动参数不能超过 8192 个字符，且不能包含控制字符' };
  }

  if (context.logSources.length === 0) return { payload: null, error: '请先登记日志文件，再配置自动启动' };
  if (!context.logSources.some((source) => source.sourceId === draft.logSourceId)) {
    return { payload: null, error: '请选择已登记的日志来源' };
  }

  const condaEnv = draft.condaEnv?.trim();
  if (condaEnv) launchSpec.condaEnv = condaEnv;
  const venvPath = draft.venvPath?.trim();
  if (venvPath) {
    if (!venvPath.startsWith('/')) return { payload: null, error: '虚拟环境路径需为绝对路径' };
    launchSpec.venvPath = venvPath;
  }
  const modules = (draft.modulesText ?? '')
    .split(/[,;\s]+/)
    .map((m) => m.trim())
    .filter(Boolean);
  if (modules.length > 0) launchSpec.modules = modules;

  const envMap: Record<string, string> = {};
  for (const pair of draft.envPairs ?? []) {
    const k = pair.key.trim();
    if (!k) continue;
    if (!ENV_KEY_RE.test(k)) {
      return { payload: null, error: `环境变量名无效: ${k}` };
    }
    envMap[k] = pair.value;
  }
  if (Object.keys(envMap).length > 0) launchSpec.env = envMap;

  return {
    payload: {
      execution: 'server_tmux',
      gpuDeviceIds: parsedGpus.ids,
      ...(parsedExcludes.ids.length > 0 ? { gpuExcludeIds: parsedExcludes.ids } : {}),
      ...(requiredGpuCount !== undefined ? { requiredGpuCount } : {}),
      ...(draft.cudaVisibleDevicesMode
        ? { cudaVisibleDevicesMode: draft.cudaVisibleDevicesMode }
        : {}),
      idleSeconds,
      maxUtilizationPercent,
      maxMemoryMiB,
      ...(minFreeMemoryMiB ? { minFreeMemoryMiB } : {}),
      ...(minFreeDiskMiB ? { minFreeDiskMiB } : {}),
      ...(sharingGroup ? { gpuSharing: { groupId: sharingGroup, maxDevices, maxWorkersPerDevice } } : {}),
      ...(draft.retryOnExit ? { retryOnExit: true } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(retryBackoffSeconds !== undefined ? { retryBackoffSeconds } : {}),
      launch: launchSpec,
    },
    error: null,
  };
}

export function sameAutoStartPayload(a: AutoStartPayload, b: AutoStartPayload): boolean {
  return (
    a.execution === b.execution &&
    a.gpuDeviceIds.join(',') === b.gpuDeviceIds.join(',') &&
    (a.gpuExcludeIds ?? []).join(',') === (b.gpuExcludeIds ?? []).join(',') &&
    (a.requiredGpuCount ?? 1) === (b.requiredGpuCount ?? 1) &&
    (a.cudaVisibleDevicesMode ?? 'index') === (b.cudaVisibleDevicesMode ?? 'index') &&
    a.idleSeconds === b.idleSeconds &&
    a.maxUtilizationPercent === b.maxUtilizationPercent &&
    a.maxMemoryMiB === b.maxMemoryMiB &&
    (a.minFreeMemoryMiB ?? 0) === (b.minFreeMemoryMiB ?? 0) &&
    (a.minFreeDiskMiB ?? 0) === (b.minFreeDiskMiB ?? 0) &&
    JSON.stringify(a.gpuSharing) === JSON.stringify(b.gpuSharing) &&
    !!a.retryOnExit === !!b.retryOnExit &&
    (a.maxRetries ?? 3) === (b.maxRetries ?? 3) &&
    (a.retryBackoffSeconds ?? 10) === (b.retryBackoffSeconds ?? 10) &&
    a.launch.mode === b.launch.mode &&
    a.launch.pythonPath === b.launch.pythonPath &&
    a.launch.entryPath === b.launch.entryPath &&
    a.launch.moduleName === b.launch.moduleName &&
    JSON.stringify(a.launch.command ?? null) === JSON.stringify(b.launch.command ?? null) &&
    a.launch.cwd === b.launch.cwd &&
    a.launch.arguments === b.launch.arguments &&
    a.launch.logSourceId === b.launch.logSourceId &&
    a.launch.condaEnv === b.launch.condaEnv &&
    a.launch.venvPath === b.launch.venvPath &&
    JSON.stringify(a.launch.modules ?? null) === JSON.stringify(b.launch.modules ?? null) &&
    JSON.stringify(a.launch.env ?? null) === JSON.stringify(b.launch.env ?? null)
  );
}

export function autoStartScopeKey(
  task: Pick<TaskRegistration, 'hostId' | 'allowedDirectories' | 'entryPaths' | 'sources'>,
): string {
  return JSON.stringify({
    hostId: task.hostId,
    directories: task.allowedDirectories,
    entries: task.entryPaths,
    sources: task.sources,
  });
}

interface AutoStartFieldsProps {
  draft: AutoStartDraft;
  onChange: (draft: AutoStartDraft) => void;
  context: AutoStartContext;
  hostSnapshots?: HostSnapshot[];
  hostId?: string;
  sectionRef?: React.Ref<HTMLElement>;
  serverSupported?: boolean;
}

export function AutoStartFields({
  draft,
  onChange,
  context,
  sectionRef,
  serverSupported = true,
}: AutoStartFieldsProps) {
  const resolved = resolveAutoStartDraft(draft, context);
  const update = (patch: Partial<AutoStartDraft>) => onChange({ ...draft, ...patch });
  const entryOptions = context.entryPaths.includes(resolved.entryPath)
    ? context.entryPaths
    : [...context.entryPaths, resolved.entryPath].filter(Boolean);

  const thresholdMode = draft.thresholdMode ?? (Number(draft.minFreeMemoryMiB ?? 0) > 0 ? 'free_mem' : 'idle_cap');
  const launchMode = draft.launchMode ?? 'python_script';
  const envPairs = draft.envPairs ?? [];

  return (
    <section className="auto-start-section" aria-labelledby="auto-start-heading" ref={sectionRef}>
      <div className="auto-start-heading">
        <h3 id="auto-start-heading">GPU 空闲自动启动</h3>
        <label className="auto-start-toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!serverSupported && !draft.enabled}
            onChange={(event) =>
              update({
                enabled: event.target.checked,
                gpuText: event.target.checked && !draft.gpuText ? (context.defaultGpuText ?? '') : draft.gpuText,
              })
            }
          />
          启用
        </label>
      </div>
      <p className="auto-start-help">{serverSupported ? AUTO_START_HELP : '此功能仅支持远程 SSH 服务器。'}</p>

      {draft.enabled && (
        <div className="auto-start-body">
          {/* Block 1: Trigger Conditions */}
          <div className="auto-start-subblock">
            <div className="auto-start-subblock-title">
              <span>1. 触发条件与显卡池</span>
              <div className="segmented-control" role="group" aria-label="空闲判定模式">
                <button
                  type="button"
                  className={`segmented-btn ${thresholdMode === 'idle_cap' ? 'is-active' : ''}`}
                  aria-pressed={thresholdMode === 'idle_cap'}
                  onClick={() => update({ thresholdMode: 'idle_cap', minFreeMemoryMiB: '0' })}
                >
                  空闲占用上限
                </button>
                <button
                  type="button"
                  className={`segmented-btn ${thresholdMode === 'free_mem' ? 'is-active' : ''}`}
                  aria-pressed={thresholdMode === 'free_mem'}
                  onClick={() =>
                    update({
                      thresholdMode: 'free_mem',
                      minFreeMemoryMiB: Number(draft.minFreeMemoryMiB) > 0 ? draft.minFreeMemoryMiB : '12000',
                    })
                  }
                >
                  最低可用显存
                </button>
              </div>
            </div>

            <div className="auto-start-grid">
              <label className="form-label">
                空闲等待（秒）
                <input
                  className="form-input is-mono"
                  type="number"
                  min={1}
                  max={86400}
                  step={1}
                  value={draft.idleSeconds}
                  onChange={(event) => update({ idleSeconds: event.target.value })}
                />
              </label>

              <label className="form-label">
                所需 GPU 数量（默认 1 张）
                <input
                  className="form-input is-mono"
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  value={draft.requiredGpuCount ?? '1'}
                  onChange={(event) => update({ requiredGpuCount: event.target.value })}
                />
              </label>

              {thresholdMode === 'idle_cap' ? (
                <>
                  <label className="form-label">
                    最大利用率（%）
                    <input
                      className="form-input is-mono"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={draft.maxUtilizationPercent}
                      onChange={(event) => update({ maxUtilizationPercent: event.target.value })}
                    />
                  </label>
                  <label className="form-label">
                    最大显存（MiB）
                    <input
                      className="form-input is-mono"
                      type="number"
                      min={0}
                      max={1048576}
                      step={1}
                      value={draft.maxMemoryMiB}
                      onChange={(event) => update({ maxMemoryMiB: event.target.value })}
                    />
                  </label>
                </>
              ) : (
                <label className="form-label full-span">
                  最低可用显存（MiB）
                  <input
                    className="form-input is-mono"
                    type="number"
                    min={1}
                    max={1048576}
                    value={draft.minFreeMemoryMiB ?? '12000'}
                    onChange={(event) => update({ minFreeMemoryMiB: event.target.value })}
                  />
                </label>
              )}

              <label className="form-label">
                GPU 白名单（选填，留空监控全部）
                <input
                  className="form-input is-mono"
                  placeholder="例如: 0, 1, 2"
                  value={draft.gpuText}
                  onChange={(event) => update({ gpuText: event.target.value })}
                />
              </label>

              <label className="form-label">
                GPU 黑名单（选填，排除卡号）
                <input
                  className="form-input is-mono"
                  placeholder="例如: 7"
                  value={draft.gpuExcludeText ?? ''}
                  onChange={(event) => update({ gpuExcludeText: event.target.value })}
                />
              </label>
            </div>
          </div>

          {/* Block 2: Launch Command & Environment */}
          <div className="auto-start-subblock">
            <div className="auto-start-subblock-title">
              <span>2. 启动命令与运行环境</span>
              <div className="segmented-control" role="group" aria-label="启动命令模式">
                {(
                  [
                    ['python_script', 'Python 脚本'],
                    ['python_module', 'Python 模块'],
                    ['command', '自定义命令'],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    className={`segmented-btn ${launchMode === m ? 'is-active' : ''}`}
                    aria-pressed={launchMode === m}
                    onClick={() => update({ launchMode: m })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="auto-start-grid">
              {launchMode !== 'command' && (
                <label className="form-label full-span">
                  Python 路径
                  <input
                    className="form-input is-mono"
                    value={draft.pythonPath}
                    onChange={(event) => update({ pythonPath: event.target.value })}
                  />
                </label>
              )}

              {launchMode === 'python_script' && (
                <label className="form-label full-span">
                  脚本入口
                  <select
                    className="form-select"
                    value={resolved.entryPath}
                    onChange={(event) => update({ entryPath: event.target.value })}
                  >
                    {entryOptions.length === 0 && <option value="">（未登记脚本入口）</option>}
                    {entryOptions.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {launchMode === 'python_module' && (
                <label className="form-label full-span">
                  Python 模块名 (python -m)
                  <input
                    className="form-input is-mono"
                    placeholder="例如: torch.distributed.run"
                    value={draft.moduleName ?? ''}
                    onChange={(event) => update({ moduleName: event.target.value })}
                  />
                </label>
              )}

              {launchMode === 'command' && (
                <label className="form-label full-span">
                  启动命令（空格分隔）
                  <input
                    className="form-input is-mono"
                    placeholder="例如: torchrun --nproc_per_node=2 train.py"
                    value={draft.commandText ?? ''}
                    onChange={(event) => update({ commandText: event.target.value })}
                  />
                </label>
              )}

              <label className="form-label full-span">
                启动工作目录
                <input
                  className="form-input is-mono"
                  list="auto-start-cwd-options"
                  value={resolved.cwd}
                  onChange={(event) => update({ cwd: event.target.value })}
                />
                <datalist id="auto-start-cwd-options">
                  {context.allowedDirectories.map((dir) => (
                    <option key={dir} value={dir} />
                  ))}
                </datalist>
              </label>

              <label className="form-label full-span">
                启动参数
                <input
                  className="form-input is-mono"
                  value={draft.arguments}
                  placeholder="例如 --epochs 100 --batch-size 32"
                  onChange={(event) => update({ arguments: event.target.value })}
                />
              </label>

              <label className="form-label full-span">
                日志来源
                <select
                  className="form-select"
                  value={resolved.logSourceId}
                  onChange={(event) => update({ logSourceId: event.target.value })}
                >
                  {context.logSources.length === 0 && <option value="">（未登记日志文件）</option>}
                  {context.logSources.map((source) => (
                    <option key={source.sourceId} value={source.sourceId}>
                      {source.sourceId} · {source.path}
                    </option>
                  ))}
                </select>
              </label>

              <label className="form-label">
                Conda 环境（选填）
                <input
                  className="form-input is-mono"
                  placeholder="例如: pytorch2"
                  value={draft.condaEnv ?? ''}
                  onChange={(event) => update({ condaEnv: event.target.value })}
                />
              </label>

              <label className="form-label">
                Virtualenv 路径（选填）
                <input
                  className="form-input is-mono"
                  placeholder="例如: /workspace/.venv"
                  value={draft.venvPath ?? ''}
                  onChange={(event) => update({ venvPath: event.target.value })}
                />
              </label>
            </div>

            {/* Key-Value Environment Variables Editor */}
            <div className="env-kv-list">
              <div className="auto-start-subblock-title">
                <span className="text-secondary" style={{ fontWeight: 500 }}>
                  环境变量（选填）
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={() => update({ envPairs: [...envPairs, { key: '', value: '' }] })}
                >
                  <Icon name="plus" size={12} />
                  <span>添加变量</span>
                </button>
              </div>
              {envPairs.map((pair, idx) => (
                <div key={idx} className="env-kv-row">
                  <input
                    className="form-input form-input-sm is-mono"
                    placeholder="KEY"
                    aria-label={`环境变量名 ${idx + 1}`}
                    value={pair.key}
                    onChange={(e) => {
                      const next = envPairs.map((item, i) => (i === idx ? { ...item, key: e.target.value } : item));
                      update({ envPairs: next });
                    }}
                  />
                  <input
                    className="form-input form-input-sm is-mono"
                    placeholder="VALUE"
                    aria-label={`环境变量值 ${idx + 1}`}
                    value={pair.value}
                    onChange={(e) => {
                      const next = envPairs.map((item, i) => (i === idx ? { ...item, value: e.target.value } : item));
                      update({ envPairs: next });
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-only"
                    aria-label={`删除环境变量 ${idx + 1}`}
                    onClick={() => update({ envPairs: envPairs.filter((_, i) => i !== idx) })}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Block 3: Collapsible Advanced Settings */}
          <details className="task-extra-fields">
            <summary>3. 高级项（退出重试、磁盘下限、GPU 共享与 CUDA 格式）</summary>
            <div className="task-extra-body">
              <label className="auto-start-toggle">
                <input
                  type="checkbox"
                  checked={!!draft.retryOnExit}
                  onChange={(event) => update({ retryOnExit: event.target.checked })}
                />
                任务异常退出后自动重新等待 GPU
              </label>

              <div className="auto-start-grid">
                <label className="form-label">
                  最大重试次数
                  <input
                    className="form-input is-mono"
                    type="number"
                    min={0}
                    max={100}
                    placeholder="3"
                    value={draft.maxRetries ?? ''}
                    onChange={(event) => update({ maxRetries: event.target.value })}
                  />
                </label>

                <label className="form-label">
                  重试退避时长（秒）
                  <input
                    className="form-input is-mono"
                    type="number"
                    min={0}
                    max={86400}
                    placeholder="10"
                    value={draft.retryBackoffSeconds ?? ''}
                    onChange={(event) => update({ retryBackoffSeconds: event.target.value })}
                  />
                </label>

                <label className="form-label">
                  最低输出磁盘空间（MiB）
                  <input
                    className="form-input is-mono"
                    type="number"
                    min={0}
                    value={draft.minFreeDiskMiB ?? '0'}
                    onChange={(event) => update({ minFreeDiskMiB: event.target.value })}
                  />
                </label>

                <label className="form-label">
                  CUDA_VISIBLE_DEVICES 格式
                  <select
                    className="form-select"
                    value={draft.cudaVisibleDevicesMode ?? 'index'}
                    onChange={(event) =>
                      update({ cudaVisibleDevicesMode: event.target.value as 'index' | 'uuid' })
                    }
                  >
                    <option value="index">GPU 索引 (0,1)</option>
                    <option value="uuid">GPU UUID</option>
                  </select>
                </label>

                <label className="form-label">
                  共享组 ID（选填）
                  <input
                    className="form-input is-mono"
                    placeholder="例如: shared-pool"
                    value={draft.sharingGroup ?? ''}
                    onChange={(event) => update({ sharingGroup: event.target.value })}
                  />
                </label>

                <label className="form-label">
                  共享组最多 GPU 数 / 每卡进程数
                  <div className="form-row">
                    <input
                      className="form-input is-mono"
                      type="number"
                      min={1}
                      max={64}
                      aria-label="共享组最多 GPU 数"
                      value={draft.maxDevices ?? '3'}
                      onChange={(event) => update({ maxDevices: event.target.value })}
                    />
                    <input
                      className="form-input is-mono"
                      type="number"
                      min={1}
                      max={16}
                      aria-label="每张 GPU 最多进程数"
                      value={draft.maxWorkersPerDevice ?? '2'}
                      onChange={(event) => update({ maxWorkersPerDevice: event.target.value })}
                    />
                  </div>
                </label>
              </div>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
