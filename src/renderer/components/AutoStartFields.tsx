import React from 'react';
import type { AutoStartConfig, HostSnapshot, TaskRegistration } from '../../shared/contracts';

/** Editable shape of the auto-start configuration; every field is text so the form stays lossless. */
export interface AutoStartDraft {
  enabled: boolean;
  retryOnExit?: boolean;
  gpuText: string;
  idleSeconds: string;
  maxUtilizationPercent: string;
  maxMemoryMiB: string;
  minFreeMemoryMiB?: string;
  minFreeDiskMiB?: string;
  sharingGroup?: string;
  maxDevices?: string;
  maxWorkersPerDevice?: string;
  pythonPath: string;
  entryPath: string;
  cwd: string;
  arguments: string;
  logSourceId: string;
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
  '在服务器 tmux 中监控全部 GPU，任意一张卡连续空闲达到设定时长后启动。可启用退出后继续等待，直到状态文件报告完成。本机关机后仍会继续等待。';

const GPU_INDEX = /^(0|[1-9]\d{0,3})$/;

export function newAutoStartArmId(): string {
  const cryptoRef = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') cryptoRef.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deviceIdToIndex(deviceId: string): string {
  return deviceId.replace(/^GPU[-\s]?/, '');
}

/** Host metrics use "GPU 0"; older fixtures used "GPU-0". Both normalize to the registry format. */
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
  const host = hostSnapshots.find(item => item.hostId === hostId);
  // Only a connected host with an available, fresh sample may describe a card as idle.
  if (!host || host.connection !== 'connected' || host.gpu?.state !== 'available') return [];
  const cards = new Map<string, GpuCard>();
  for (const metric of host?.gpu?.metrics ?? []) {
    if (metric.scope !== 'device' || !metric.deviceId) continue;
    if (metric.freshness !== 'fresh' || metric.observedAt !== host?.gpu?.observedAt || metric.value === null || !Number.isFinite(metric.value) || metric.value < 0) continue;
    const deviceId = normalizeGpuDeviceId(metric.deviceId);
    if (!deviceId) continue;
    const card = cards.get(deviceId) ?? { deviceId, utilization: null, memoryUsedMiB: null };
    if (metric.name === 'gpu_utilization' && metric.unit === 'percent_device') card.utilization = metric.value;
    if (metric.name === 'gpu_memory_used' && metric.unit === 'bytes') card.memoryUsedMiB = metric.value === null ? null : metric.value / (1024 * 1024);
    cards.set(deviceId, card);
  }
  return Array.from(cards.values()).sort((a, b) => a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true }));
}

export function parseGpuTokens(text: string): { ids: string[]; invalid: boolean } {
  const tokens = text.split(/[,;\s]+/).map(token => token.trim()).filter(Boolean);
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
    return {
      enabled: config.enabled,
      retryOnExit: config.retryOnExit ?? false,
      gpuText: config.gpuDeviceIds.map(deviceIdToIndex).join(', '),
      idleSeconds: String(config.idleSeconds),
      maxUtilizationPercent: String(config.maxUtilizationPercent),
      maxMemoryMiB: String(config.maxMemoryMiB),
      minFreeMemoryMiB: String(config.minFreeMemoryMiB ?? 0),
      minFreeDiskMiB: String(config.minFreeDiskMiB ?? 0),
      sharingGroup: config.gpuSharing?.groupId ?? '',
      maxDevices: String(config.gpuSharing?.maxDevices ?? 3),
      maxWorkersPerDevice: String(config.gpuSharing?.maxWorkersPerDevice ?? 2),
      pythonPath: config.launch.pythonPath,
      entryPath: config.launch.entryPath,
      cwd: config.launch.cwd,
      arguments: config.launch.arguments,
      logSourceId: config.launch.logSourceId,
    };
  }
  return {
    enabled: false,
    retryOnExit: false,
    gpuText: context.defaultGpuText ?? '',
    idleSeconds: AUTO_START_DEFAULTS.idleSeconds,
    maxUtilizationPercent: AUTO_START_DEFAULTS.maxUtilizationPercent,
    maxMemoryMiB: AUTO_START_DEFAULTS.maxMemoryMiB,
    pythonPath: AUTO_START_DEFAULTS.pythonPath,
    entryPath: context.entryPaths[0] ?? '',
    cwd: context.allowedDirectories[0] ?? '',
    arguments: '',
    logSourceId: context.logSources[0]?.sourceId ?? '',
  };
}

/** Empty selections fall back to the task's first registered entry, directory and log source. */
export function resolveAutoStartDraft(draft: AutoStartDraft, context: AutoStartContext): AutoStartDraft {
  return {
    ...draft,
    entryPath: draft.entryPath || context.entryPaths[0] || '',
    cwd: draft.cwd || context.allowedDirectories[0] || '',
    logSourceId: draft.logSourceId || context.logSources[0]?.sourceId || '',
  };
}

function withinAllowedDirectory(cwd: string, allowedDirectories: string[]): boolean {
  return allowedDirectories.some(dir => cwd === dir || cwd.startsWith(dir.replace(/\/$/, '') + '/'));
}

/** Validates the draft against the task it will be stored on; messages are user facing Chinese. */
export function buildAutoStartPayload(
  draft: AutoStartDraft,
  context: AutoStartContext,
): { payload: AutoStartPayload | null; error: string | null } {
  const idleText = draft.idleSeconds.trim();
  const idleSeconds = Number(idleText);
  if (!/^\d+$/.test(idleText) || !Number.isSafeInteger(idleSeconds) || idleSeconds < 1 || idleSeconds > 86400) {
    return { payload: null, error: '空闲等待时长需为 1–86400 秒之间的整数' };
  }

  const utilizationText = draft.maxUtilizationPercent.trim();
  const maxUtilizationPercent = Number(utilizationText);
  if (!utilizationText || !Number.isFinite(maxUtilizationPercent) || maxUtilizationPercent < 0 || maxUtilizationPercent > 100) {
    return { payload: null, error: '最大利用率阈值需为 0–100 之间的数值' };
  }

  const memoryText = draft.maxMemoryMiB.trim();
  const maxMemoryMiB = Number(memoryText);
  if (!/^\d+$/.test(memoryText) || !Number.isSafeInteger(maxMemoryMiB) || maxMemoryMiB < 0 || maxMemoryMiB > 1048576) {
    return { payload: null, error: '最大显存占用需为 0–1048576 MiB 之间的整数' };
  }

  const pythonPath = draft.pythonPath.trim();
  const minFreeMemoryMiB = Number(draft.minFreeMemoryMiB ?? 0);
  const minFreeDiskMiB = Number(draft.minFreeDiskMiB ?? 0);
  const sharingGroup = draft.sharingGroup?.trim() ?? '';
  const maxDevices = Number(draft.maxDevices ?? 3);
  const maxWorkersPerDevice = Number(draft.maxWorkersPerDevice ?? 2);
  if (![minFreeMemoryMiB, minFreeDiskMiB].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1048576)) return {payload:null,error:'可用显存和磁盘门槛需为非负整数（MiB）'};
  if (sharingGroup && (!/^[A-Za-z0-9_-]{1,128}$/.test(sharingGroup) || !minFreeMemoryMiB || !context.hasStatusSource || !Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 64 || !Number.isInteger(maxWorkersPerDevice) || maxWorkersPerDevice < 1 || maxWorkersPerDevice > 16)) return {payload:null,error:'共享组需设置可用显存、状态文件、GPU 数量和每卡进程数'};
  if (!pythonPath.startsWith('/')) return { payload: null, error: 'Python 路径需为宿主上的绝对路径，例如 /usr/bin/python3' };
  if (pythonPath.split('/').includes('..')) return { payload: null, error: 'Python 路径不能包含 .. 路径段' };
  const pythonName = pythonPath.split('/').filter(Boolean).pop() ?? '';
  if (!/^python(?:3(?:\.\d+)?)?$/.test(pythonName)) {
    return { payload: null, error: 'Python 可执行文件需形如 python3 或 python3.12' };
  }

  if (context.entryPaths.length === 0) return { payload: null, error: '请先填写脚本入口，再配置自动启动' };
  if (!context.entryPaths.includes(draft.entryPath)) return { payload: null, error: '请选择任务已登记的脚本入口' };

  const cwd = draft.cwd.trim();
  if (!cwd.startsWith('/')) return { payload: null, error: '工作目录需为宿主上的绝对路径' };
  if (cwd.split('/').includes('..')) return { payload: null, error: '工作目录不能包含 .. 路径段' };
  if (!withinAllowedDirectory(cwd, context.allowedDirectories)) {
    return { payload: null, error: '工作目录需位于已登记的工作目录内' };
  }

  const args = draft.arguments;
  if (args.length > 8192 || /[\u0000-\u001f\u007f]/.test(args)) {
    return { payload: null, error: '启动参数不能超过 8192 个字符，且不能包含控制字符' };
  }

  if (context.logSources.length === 0) return { payload: null, error: '请先登记日志文件，再配置自动启动' };
  if (!context.logSources.some(source => source.sourceId === draft.logSourceId)) {
    return { payload: null, error: '请选择已登记的日志来源' };
  }
  if (draft.retryOnExit && !context.hasStatusSource) return { payload: null, error: '请先登记状态 JSON 文件，用于确认任务完成' };

  return {
    payload: {
      execution: 'server_tmux',
      gpuDeviceIds: [],
      idleSeconds,
      maxUtilizationPercent,
      maxMemoryMiB,
      ...(minFreeMemoryMiB ? { minFreeMemoryMiB } : {}),
      ...(minFreeDiskMiB ? { minFreeDiskMiB } : {}),
      ...(sharingGroup ? { gpuSharing: { groupId: sharingGroup, maxDevices, maxWorkersPerDevice } } : {}),
      ...(draft.retryOnExit ? { retryOnExit: true } : {}),
      launch: {
        pythonPath,
        entryPath: draft.entryPath,
        cwd,
        arguments: args,
        logSourceId: draft.logSourceId,
      },
    },
    error: null,
  };
}

/** An unchanged configuration keeps its arm id so the running countdown is not restarted. */
export function sameAutoStartPayload(a: AutoStartPayload, b: AutoStartPayload): boolean {
  return a.execution === b.execution && a.gpuDeviceIds.join(',') === b.gpuDeviceIds.join(',')
    && a.idleSeconds === b.idleSeconds
    && a.maxUtilizationPercent === b.maxUtilizationPercent
    && a.maxMemoryMiB === b.maxMemoryMiB
    && (a.minFreeMemoryMiB ?? 0) === (b.minFreeMemoryMiB ?? 0)
    && (a.minFreeDiskMiB ?? 0) === (b.minFreeDiskMiB ?? 0)
    && JSON.stringify(a.gpuSharing) === JSON.stringify(b.gpuSharing)
    && !!a.retryOnExit === !!b.retryOnExit
    && a.launch.pythonPath === b.launch.pythonPath
    && a.launch.entryPath === b.launch.entryPath
    && a.launch.cwd === b.launch.cwd
    && a.launch.arguments === b.launch.arguments
    && a.launch.logSourceId === b.launch.logSourceId;
}

/**
 * The controller hashes the task scope together with the configuration. When the
 * scope moves — a different host, another work directory, a different entry or a
 * relocated log file — the stored arm no longer describes the task and a new arm
 * id is required.
 */
export function autoStartScopeKey(task: Pick<TaskRegistration, 'hostId' | 'allowedDirectories' | 'entryPaths' | 'sources'>): string {
  return JSON.stringify({ hostId: task.hostId, directories: task.allowedDirectories, entries: task.entryPaths, sources: task.sources });
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

export function AutoStartFields({ draft, onChange, context, sectionRef, serverSupported = true }: AutoStartFieldsProps) {
  const resolved = resolveAutoStartDraft(draft, context);
  const update = (patch: Partial<AutoStartDraft>) => onChange({ ...draft, ...patch });
  const entryOptions = context.entryPaths.includes(resolved.entryPath)
    ? context.entryPaths
    : [...context.entryPaths, resolved.entryPath].filter(Boolean);

  return <section className="auto-start-section" aria-labelledby="auto-start-heading" ref={sectionRef}>
    <div className="auto-start-heading">
      <h3 id="auto-start-heading">GPU 空闲自动启动</h3>
      <label className="auto-start-toggle">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={!serverSupported && !draft.enabled}
          onChange={event => update({
            enabled: event.target.checked,
            gpuText: event.target.checked && !draft.gpuText ? (context.defaultGpuText ?? '') : draft.gpuText,
          })}
        />
        启用
      </label>
    </div>
    <p className="auto-start-help">{serverSupported ? Number(draft.minFreeMemoryMiB) > 0 ? '持续满足可用显存门槛后启动；共享组统一限制 GPU 数量和每卡进程数，同卡模型加载依次进行。服务器 tmux 持续等待。' : AUTO_START_HELP : '此功能仅支持远程 SSH 服务器。'}</p>
    {draft.enabled ? <div className="auto-start-body">
      <p className="task-form-help">监控范围：全部 GPU，任意一张满足条件即可，无需勾选。每张卡独立计时，启动脚本内的 CUDA 编号为 0。</p>
      <label className="auto-start-toggle">
        <input type="checkbox" checked={!!draft.retryOnExit} disabled={!context.hasStatusSource}
          onChange={event => update({ retryOnExit: event.target.checked })} />
        任务退出后重新等待全部 GPU，完成后停止
      </label>
      <div className="auto-start-grid">
        <label className="form-label">最低可用显存（MiB，0 表示沿用占用上限）
          <input className="form-input" type="number" min={0} value={draft.minFreeMemoryMiB ?? '0'} onChange={event => update({minFreeMemoryMiB:event.target.value,maxUtilizationPercent:event.target.value !== '0' ? '100' : draft.maxUtilizationPercent})}/>
        </label>
        <label className="form-label">最低输出磁盘空间（MiB）
          <input className="form-input" type="number" min={0} value={draft.minFreeDiskMiB ?? '0'} onChange={event => update({minFreeDiskMiB:event.target.value})}/>
        </label>
        <label className="form-label">共享组（相同组共用 GPU 数量上限）
          <input className="form-input" value={draft.sharingGroup ?? ''} onChange={event => update({sharingGroup:event.target.value})}/>
        </label>
        <label className="form-label">共享组最多 GPU 数
          <input className="form-input" type="number" min={1} max={64} value={draft.maxDevices ?? '3'} onChange={event => update({maxDevices:event.target.value})}/>
        </label>
        <label className="form-label">每张 GPU 最多进程数
          <input className="form-input" type="number" min={1} max={16} value={draft.maxWorkersPerDevice ?? '2'} onChange={event => update({maxWorkersPerDevice:event.target.value})}/>
        </label>
        <label className="form-label">空闲等待（秒）
          <input
            className="form-input"
            type="number"
            min={1}
            max={86400}
            step={1}
            value={draft.idleSeconds}
            onChange={event => update({ idleSeconds: event.target.value })}
          />
        </label>
        <label className="form-label">最大利用率（%）
          <input
            className="form-input"
            type="number"
            min={0}
            max={100}
            step={1}
            value={draft.maxUtilizationPercent}
            onChange={event => update({ maxUtilizationPercent: event.target.value })}
          />
        </label>
        <label className="form-label">最大显存（MiB）
          <input
            className="form-input"
            type="number"
            min={0}
            max={1048576}
            step={1}
            value={draft.maxMemoryMiB}
            onChange={event => update({ maxMemoryMiB: event.target.value })}
          />
        </label>
        <label className="form-label">Python 路径
          <input
            className="form-input"
            value={draft.pythonPath}
            onChange={event => update({ pythonPath: event.target.value })}
          />
        </label>
        <label className="form-label">脚本入口
          <select className="form-select" value={resolved.entryPath} onChange={event => update({ entryPath: event.target.value })}>
            {entryOptions.length === 0 && <option value="">（未登记脚本入口）</option>}
            {entryOptions.map(entry => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
        <label className="form-label">启动工作目录
          <input
            className="form-input"
            list="auto-start-cwd-options"
            value={resolved.cwd}
            onChange={event => update({ cwd: event.target.value })}
          />
          <datalist id="auto-start-cwd-options">
            {context.allowedDirectories.map(dir => <option key={dir} value={dir} />)}
          </datalist>
        </label>
        <label className="form-label">启动参数
          <input
            className="form-input"
            value={draft.arguments}
            placeholder="例如 --epochs 100"
            onChange={event => update({ arguments: event.target.value })}
          />
        </label>
        <label className="form-label">日志来源
          <select className="form-select" value={resolved.logSourceId} onChange={event => update({ logSourceId: event.target.value })}>
            {context.logSources.length === 0 && <option value="">（未登记日志文件）</option>}
            {context.logSources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.sourceId} · {source.path}</option>)}
          </select>
        </label>
      </div>
    </div> : null}
  </section>;
}
