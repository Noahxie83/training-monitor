import type { AutoStartConfig, AutoStartStatus, TaskRegistration } from './contracts';

function row(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('INVALID_AUTO_START');
  return value as Record<string, any>;
}
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const absolute = (value: unknown): value is string => text(value) && value.startsWith('/') && !value.split('/').includes('..');
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export const validArmId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function validateAutoStartConfig(value: unknown, task: Pick<TaskRegistration, 'entryPaths' | 'sources' | 'allowedDirectories'>): AutoStartConfig {
  const c = row(value, ['execution', 'enabled', 'armId', 'gpuDeviceIds', 'idleSeconds', 'maxUtilizationPercent', 'maxMemoryMiB', 'minFreeMemoryMiB', 'minFreeDiskMiB', 'gpuSharing', 'retryOnExit', 'launch']);
  if (c.minFreeMemoryMiB !== undefined && !integer(c.minFreeMemoryMiB, 1, 1048576) || c.minFreeDiskMiB !== undefined && !integer(c.minFreeDiskMiB, 0, 1073741824)) throw new TypeError('INVALID_AUTO_START');
  if (c.gpuSharing !== undefined) {
    const g = row(c.gpuSharing, ['groupId', 'maxDevices', 'maxWorkersPerDevice']);
    if (!text(g.groupId, 128) || !/^[A-Za-z0-9_-]+$/.test(String(g.groupId)) || !integer(g.maxDevices, 1, 64) || !integer(g.maxWorkersPerDevice, 1, 16) || !c.minFreeMemoryMiB) throw new TypeError('INVALID_AUTO_START');
  }
  const l = row(c.launch, ['pythonPath', 'entryPath', 'cwd', 'arguments', 'logSourceId']);
  if ((c.retryOnExit !== undefined && typeof c.retryOnExit !== 'boolean') || (c.retryOnExit === true && !task.sources.some(source => source.kind === 'status_json'))) throw new TypeError('INVALID_AUTO_START');
  if ((c.execution !== undefined && c.execution !== 'server_tmux') || typeof c.enabled !== 'boolean' || !validArmId(c.armId) || !Array.isArray(c.gpuDeviceIds) || (c.execution !== 'server_tmux' && c.gpuDeviceIds.length < 1) || c.gpuDeviceIds.length > 64 || new Set(c.gpuDeviceIds).size !== c.gpuDeviceIds.length || c.gpuDeviceIds.some((id: unknown) => typeof id !== 'string' || !/^GPU (0|[1-9]\d{0,3})$/.test(id)) ||
      !integer(c.idleSeconds, 1, 86400) || typeof c.maxUtilizationPercent !== 'number' || !Number.isFinite(c.maxUtilizationPercent) || c.maxUtilizationPercent < 0 || c.maxUtilizationPercent > 100 || !integer(c.maxMemoryMiB, 0, 1048576) ||
      !absolute(l.pythonPath) || !/^python(?:3(?:\.\d+)?)?$/.test(l.pythonPath.split('/').at(-1)!) || !text(l.entryPath) || !task.entryPaths.includes(l.entryPath) || !absolute(l.cwd) || !task.allowedDirectories.some(dir => l.cwd === dir || l.cwd.startsWith(dir.replace(/\/$/, '') + '/')) ||
      typeof l.arguments !== 'string' || l.arguments.length > 8192 || /[\u0000-\u001f\u007f]/.test(l.arguments) || !text(l.logSourceId) || !task.sources.some(source => source.sourceId === l.logSourceId && source.kind === 'log')) throw new TypeError('INVALID_AUTO_START');
  return structuredClone(c) as AutoStartConfig;
}

export function validateAutoStartStatus(value: unknown): AutoStartStatus {
  const s = row(value, ['execution', 'remoteConfirmed', 'sessionName', 'selectedDeviceId', 'armId', 'phase', 'idleElapsedSeconds', 'requiredIdleSeconds', 'lastCheckedAt', 'startedAt', 'pid', 'errorCode', 'message']);
  if ((s.execution !== undefined && s.execution !== 'server_tmux') || (s.remoteConfirmed !== undefined && typeof s.remoteConfirmed !== 'boolean') || !(s.sessionName === undefined || s.sessionName === null || typeof s.sessionName === 'string' && /^tm-wait-[a-f0-9]{40}$/.test(s.sessionName)) || !(s.selectedDeviceId === undefined || s.selectedDeviceId === null || typeof s.selectedDeviceId === 'string' && /^GPU (0|[1-9]\d{0,3})$/.test(s.selectedDeviceId)) || !validArmId(s.armId) || !['waiting', 'countdown', 'blocked', 'starting', 'started', 'failed'].includes(s.phase) || !integer(s.idleElapsedSeconds, 0, 86400) || !integer(s.requiredIdleSeconds, 1, 86400) ||
      ![s.lastCheckedAt, s.startedAt].every(time => time === null || typeof time === 'string' && Number.isFinite(Date.parse(time))) || !(s.pid === null || integer(s.pid, 1, 2147483647)) ||
      !(s.errorCode === null || text(s.errorCode, 128)) || !(s.message === null || text(s.message, 512))) throw new TypeError('INVALID_AUTO_START_STATUS');
  return s as AutoStartStatus;
}
