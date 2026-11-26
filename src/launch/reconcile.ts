import type { HostRegistration, Registry, TaskRegistration } from '../shared/contracts';
import type { ServerWaitResult, Transport } from '../transport/types';
import { launchConfigHash } from './controller';

const CONFIRMED_SERVER_WAIT_STATES: ServerWaitResult['state'][] = ['cancelled', 'missing', 'started'];

export interface PendingRemoteCancel {
  hostId: string;
  taskId: string;
  armId: string;
  configHash: string;
  task: TaskRegistration;
  queuedAt: string;
}

export interface HostUnreachableReconcileError extends Error {
  code: 'HOST_UNREACHABLE_RECONCILE';
  affectedTasks: PendingRemoteCancel[];
}

export interface CancelChangedServerWaitsOptions {
  forceLocal?: boolean;
  now?: () => number;
  onPendingCancel?: (pending: PendingRemoteCancel) => void | Promise<void>;
}

function isServerWaitTask(task: TaskRegistration | undefined): boolean {
  return task?.autoStart?.enabled === true && task.autoStart.execution === 'server_tmux';
}

function hostById(registry: Registry, hostId: string | undefined): HostRegistration | undefined {
  return registry.hosts.find(host => host.hostId === hostId);
}

function taskById(registry: Registry, taskId: string | undefined): TaskRegistration | undefined {
  return registry.tasks.find(task => task.taskId === taskId);
}

function unreachableReconcileError(affectedTasks: PendingRemoteCancel[]): HostUnreachableReconcileError {
  const err = new Error(
    'HOST_UNREACHABLE_RECONCILE: 无法确认服务器取消等待，原规则仍可能运行，请重新连接后再修改；也可使用 forceLocal 强制本地保存并在宿主重连后自动补发取消。',
  ) as HostUnreachableReconcileError;
  err.code = 'HOST_UNREACHABLE_RECONCILE';
  err.affectedTasks = affectedTasks;
  return err;
}

export async function cancelChangedServerWaits(
  current: Registry,
  next: Registry,
  transportProvider: (host: HostRegistration, registry: Registry) => Transport | Promise<Transport>,
  signal: AbortSignal,
  options: CancelChangedServerWaitsOptions = {},
): Promise<{ pendingCancels: PendingRemoteCancel[] }> {
  const changed = new Set<string>();
  for (const oldTask of current.tasks) {
    const oldHost = hostById(current, oldTask.hostId);
    if (!isServerWaitTask(oldTask) || !oldHost || oldHost.target.kind !== 'ssh') continue;

    const nextTask = taskById(next, oldTask.taskId);
    const nextHost = hostById(next, nextTask?.hostId);
    const requiresCancellation = !nextTask
      || !nextTask.enabled
      || !nextTask.autoStart?.enabled
      || !nextHost
      || !nextHost.enabled
      || launchConfigHash(oldHost, oldTask) !== launchConfigHash(nextHost, nextTask);
    if (requiresCancellation) changed.add(oldTask.taskId);
  }

  const pendingCancels: PendingRemoteCancel[] = [];
  const nowIso = new Date((options.now ?? Date.now)()).toISOString();

  for (const taskId of changed) {
    const oldTask = taskById(current, taskId)!;
    const oldHost = hostById(current, oldTask.hostId)!;
    const oldHash = launchConfigHash(oldHost, oldTask);
    const pendingItem: PendingRemoteCancel = {
      hostId: oldHost.hostId,
      taskId: oldTask.taskId,
      armId: oldTask.autoStart!.armId,
      configHash: oldHash,
      task: structuredClone(oldTask),
      queuedAt: nowIso,
    };

    if (signal.aborted) {
      pendingCancels.push(pendingItem);
      if (options.forceLocal) {
        await options.onPendingCancel?.(pendingItem);
        continue;
      }
      throw unreachableReconcileError(pendingCancels);
    }

    let result: ServerWaitResult | null = null;
    try {
      const transport = await transportProvider(oldHost, current);
      if (!transport.cancelServerWait) throw new Error('CANCEL_UNAVAILABLE');
      result = await transport.cancelServerWait(oldTask, oldHash, signal);
    } catch {
      result = null;
    }

    const confirmed = !signal.aborted &&
      result !== null &&
      result.armId === oldTask.autoStart!.armId &&
      result.configHash === oldHash &&
      CONFIRMED_SERVER_WAIT_STATES.includes(result.state);

    if (!confirmed) {
      pendingCancels.push(pendingItem);
      if (options.forceLocal) {
        await options.onPendingCancel?.(pendingItem);
      } else {
        throw unreachableReconcileError(pendingCancels);
      }
    }
  }

  return { pendingCancels };
}

/**
 * Flush queued remote cancellations once a previously offline host reconnects.
 * Returns the remaining unconfirmed cancellations (if any).
 */
export async function flushPendingRemoteCancels(
  hostId: string,
  transport: Transport,
  pending: PendingRemoteCancel[],
  signal: AbortSignal,
): Promise<{ remaining: PendingRemoteCancel[]; flushed: PendingRemoteCancel[] }> {
  const remaining: PendingRemoteCancel[] = [];
  const flushed: PendingRemoteCancel[] = [];
  for (const item of pending) {
    if (item.hostId !== hostId) {
      remaining.push(item);
      continue;
    }
    if (signal.aborted || !transport.cancelServerWait) {
      remaining.push(item);
      continue;
    }
    try {
      const result = await transport.cancelServerWait(item.task, item.configHash, signal);
      const confirmed =
        result.armId === item.armId &&
        result.configHash === item.configHash &&
        (CONFIRMED_SERVER_WAIT_STATES.includes(result.state) || result.errorCode === 'CONFIG_CHANGED');
      if (confirmed) {
        flushed.push(item);
      } else {
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }
  return { remaining, flushed };
}
