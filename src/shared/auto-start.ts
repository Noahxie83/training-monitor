import type { AutoStartConfig, AutoStartStatus, TaskRegistration } from './contracts';

function row(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new TypeError('INVALID_AUTO_START');
  }
  return value as Record<string, any>;
}
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const absolute = (value: unknown): value is string =>
  text(value) && value.startsWith('/') && !value.split('/').includes('..');
const integer = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export const validArmId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const GPU_ID_RE = /^GPU (0|[1-9]\d{0,3})$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MODULE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const CONDA_OR_MOD_RE = /^[A-Za-z0-9._/@:+-]{1,256}$/;

function validGpuIdList(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= 64 &&
    new Set(value).size === value.length &&
    value.every((id: unknown) => typeof id === 'string' && GPU_ID_RE.test(id));
}

export function validateAutoStartConfig(
  value: unknown,
  task: Pick<TaskRegistration, 'entryPaths' | 'sources' | 'allowedDirectories'>,
): AutoStartConfig {
  const c = row(value, [
    'execution',
    'enabled',
    'armId',
    'gpuDeviceIds',
    'gpuExcludeIds',
    'requiredGpuCount',
    'cudaVisibleDevicesMode',
    'idleSeconds',
    'maxUtilizationPercent',
    'maxMemoryMiB',
    'minFreeMemoryMiB',
    'minFreeDiskMiB',
    'gpuSharing',
    'retryOnExit',
    'maxRetries',
    'retryBackoffSeconds',
    'launch',
  ]);
  if (c.minFreeMemoryMiB !== undefined && !integer(c.minFreeMemoryMiB, 1, 1048576)) {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (c.minFreeDiskMiB !== undefined && !integer(c.minFreeDiskMiB, 0, 1073741824)) {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (c.requiredGpuCount !== undefined && !integer(c.requiredGpuCount, 1, 64)) {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (c.gpuExcludeIds !== undefined && !validGpuIdList(c.gpuExcludeIds)) {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (c.cudaVisibleDevicesMode !== undefined && c.cudaVisibleDevicesMode !== 'index' && c.cudaVisibleDevicesMode !== 'uuid') {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (c.maxRetries !== undefined && !integer(c.maxRetries, 0, 100)) {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (c.retryBackoffSeconds !== undefined && !integer(c.retryBackoffSeconds, 0, 86400)) {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (c.gpuSharing !== undefined) {
    const g = row(c.gpuSharing, ['groupId', 'maxDevices', 'maxWorkersPerDevice']);
    if (!text(g.groupId, 128) || !/^[A-Za-z0-9_-]+$/.test(String(g.groupId)) || !integer(g.maxDevices, 1, 64) || !integer(g.maxWorkersPerDevice, 1, 16) || !c.minFreeMemoryMiB) {
      throw new TypeError('INVALID_AUTO_START');
    }
  }
  if (c.retryOnExit !== undefined && typeof c.retryOnExit !== 'boolean') {
    throw new TypeError('INVALID_AUTO_START');
  }

  const l = row(c.launch, [
    'mode',
    'pythonPath',
    'entryPath',
    'moduleName',
    'command',
    'cwd',
    'arguments',
    'logSourceId',
    'condaEnv',
    'venvPath',
    'modules',
    'env',
  ]);
  const mode: 'python_script' | 'python_module' | 'command' =
    l.mode ?? (Array.isArray(l.command) && l.command.length > 0 ? 'command' : l.moduleName ? 'python_module' : 'python_script');
  if (mode !== 'python_script' && mode !== 'python_module' && mode !== 'command') {
    throw new TypeError('INVALID_AUTO_START');
  }

  if (mode === 'python_script') {
    if (!absolute(l.pythonPath) || !/^python(?:3(?:\.\d+)?)?$/.test(l.pythonPath.split('/').at(-1)!)) {
      throw new TypeError('INVALID_AUTO_START');
    }
    if (!text(l.entryPath) || !task.entryPaths.includes(l.entryPath)) {
      throw new TypeError('INVALID_AUTO_START');
    }
  } else if (mode === 'python_module') {
    if (!absolute(l.pythonPath) || !/^python(?:3(?:\.\d+)?)?$/.test(l.pythonPath.split('/').at(-1)!)) {
      throw new TypeError('INVALID_AUTO_START');
    }
    if (!text(l.moduleName, 256) || !MODULE_NAME_RE.test(l.moduleName)) {
      throw new TypeError('INVALID_AUTO_START');
    }
  } else {
    if (!Array.isArray(l.command) || l.command.length < 1 || l.command.length > 256 || l.command.some((tok: unknown) => !text(tok, 4096))) {
      throw new TypeError('INVALID_AUTO_START');
    }
    if (l.pythonPath !== undefined && (!absolute(l.pythonPath) || !/^python(?:3(?:\.\d+)?)?$/.test(l.pythonPath.split('/').at(-1)!))) {
      throw new TypeError('INVALID_AUTO_START');
    }
  }

  if (l.condaEnv !== undefined && (!text(l.condaEnv, 256) || !CONDA_OR_MOD_RE.test(l.condaEnv))) {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (l.venvPath !== undefined && !absolute(l.venvPath)) {
    throw new TypeError('INVALID_AUTO_START');
  }
  if (l.modules !== undefined) {
    if (!Array.isArray(l.modules) || l.modules.length > 32 || l.modules.some((m: unknown) => !text(m, 256) || !CONDA_OR_MOD_RE.test(m))) {
      throw new TypeError('INVALID_AUTO_START');
    }
  }
  if (l.env !== undefined) {
    if (!l.env || typeof l.env !== 'object' || Array.isArray(l.env)) {
      throw new TypeError('INVALID_AUTO_START');
    }
    const entries = Object.entries(l.env as Record<string, unknown>);
    if (entries.length > 128) throw new TypeError('INVALID_AUTO_START');
    for (const [k, v] of entries) {
      if (!ENV_KEY_RE.test(k) || typeof v !== 'string' || v.length > 4096 || /[\u0000-\u001f\u007f]/.test(v)) {
        throw new TypeError('INVALID_AUTO_START');
      }
    }
  }

  if (
    (c.execution !== undefined && c.execution !== 'server_tmux') ||
    typeof c.enabled !== 'boolean' ||
    !validArmId(c.armId) ||
    !validGpuIdList(c.gpuDeviceIds) ||
    (c.execution !== 'server_tmux' && c.gpuDeviceIds.length < 1) ||
    !integer(c.idleSeconds, 1, 86400) ||
    typeof c.maxUtilizationPercent !== 'number' ||
    !Number.isFinite(c.maxUtilizationPercent) ||
    c.maxUtilizationPercent < 0 ||
    c.maxUtilizationPercent > 100 ||
    !integer(c.maxMemoryMiB, 0, 1048576) ||
    !absolute(l.cwd) ||
    !task.allowedDirectories.some(dir => l.cwd === dir || l.cwd.startsWith(dir.replace(/\/$/, '') + '/')) ||
    typeof l.arguments !== 'string' ||
    l.arguments.length > 8192 ||
    /[\u0000-\u001f\u007f]/.test(l.arguments) ||
    !text(l.logSourceId) ||
    !task.sources.some(source => source.sourceId === l.logSourceId && source.kind === 'log')
  ) {
    throw new TypeError('INVALID_AUTO_START');
  }
  return structuredClone(c) as AutoStartConfig;
}

export function validateAutoStartStatus(value: unknown): AutoStartStatus {
  const s = row(value, [
    'execution',
    'remoteConfirmed',
    'sessionName',
    'selectedDeviceId',
    'selectedDeviceIds',
    'armId',
    'phase',
    'idleElapsedSeconds',
    'requiredIdleSeconds',
    'lastCheckedAt',
    'startedAt',
    'pid',
    'exitCode',
    'retryCount',
    'maxRetries',
    'backend',
    'errorCode',
    'errorParams',
    'message',
  ]);
  if (
    (s.execution !== undefined && s.execution !== 'server_tmux') ||
    (s.remoteConfirmed !== undefined && typeof s.remoteConfirmed !== 'boolean') ||
    !(s.sessionName === undefined || s.sessionName === null || (typeof s.sessionName === 'string' && /^tm-wait-[a-f0-9]{40}$/.test(s.sessionName))) ||
    !(s.selectedDeviceId === undefined || s.selectedDeviceId === null || (typeof s.selectedDeviceId === 'string' && GPU_ID_RE.test(s.selectedDeviceId))) ||
    (s.selectedDeviceIds !== undefined && !validGpuIdList(s.selectedDeviceIds)) ||
    !validArmId(s.armId) ||
    !['waiting', 'countdown', 'blocked', 'starting', 'started', 'failed'].includes(s.phase) ||
    !integer(s.idleElapsedSeconds, 0, 86400) ||
    !integer(s.requiredIdleSeconds, 1, 86400) ||
    ![s.lastCheckedAt, s.startedAt].every(time => time === null || (typeof time === 'string' && Number.isFinite(Date.parse(time)))) ||
    !(s.pid === null || integer(s.pid, 1, 2147483647)) ||
    !(s.exitCode === undefined || s.exitCode === null || (Number.isSafeInteger(s.exitCode) && s.exitCode >= -255 && s.exitCode <= 255)) ||
    !(s.retryCount === undefined || integer(s.retryCount, 0, 1000)) ||
    !(s.maxRetries === undefined || integer(s.maxRetries, 0, 1000)) ||
    !(s.backend === undefined || s.backend === null || ['tmux', 'systemd_run', 'setsid'].includes(s.backend)) ||
    !(s.errorCode === null || text(s.errorCode, 128)) ||
    !(s.message === null || text(s.message, 512))
  ) {
    throw new TypeError('INVALID_AUTO_START_STATUS');
  }
  if (s.errorParams !== undefined && s.errorParams !== null) {
    if (typeof s.errorParams !== 'object' || Array.isArray(s.errorParams)) {
      throw new TypeError('INVALID_AUTO_START_STATUS');
    }
    const entries = Object.entries(s.errorParams as Record<string, unknown>);
    if (entries.length > 32) throw new TypeError('INVALID_AUTO_START_STATUS');
    for (const [k, v] of entries) {
      if (!text(k, 64)) throw new TypeError('INVALID_AUTO_START_STATUS');
      if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new TypeError('INVALID_AUTO_START_STATUS');
      }
      if (typeof v === 'string' && (v.length > 256 || /[\u0000-\u001f\u007f]/.test(v))) {
        throw new TypeError('INVALID_AUTO_START_STATUS');
      }
    }
  }
  return s as AutoStartStatus;
}
