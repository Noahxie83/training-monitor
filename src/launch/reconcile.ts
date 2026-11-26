import type { HostRegistration, Registry, TaskRegistration } from '../shared/contracts';
import type { ServerWaitResult, Transport } from '../transport/types';
import { launchConfigHash } from './controller';

const CONFIRMED_SERVER_WAIT_STATES: ServerWaitResult['state'][] = ['cancelled', 'missing', 'started'];

function isServerWaitTask(task: TaskRegistration | undefined): boolean {
  return task?.autoStart?.enabled === true && task.autoStart.execution === 'server_tmux';
}

function hostById(registry: Registry, hostId: string | undefined): HostRegistration | undefined {
  return registry.hosts.find(host => host.hostId === hostId);
}

function taskById(registry: Registry, taskId: string | undefined): TaskRegistration | undefined {
  return registry.tasks.find(task => task.taskId === taskId);
}

function uncertain(): Error {
  return new Error('无法确认服务器取消等待，原规则仍可能运行，请重新连接后再修改');
}

export async function cancelChangedServerWaits(
  current: Registry,
  next: Registry,
  transportProvider: (host: HostRegistration, registry: Registry) => Transport | Promise<Transport>,
  signal: AbortSignal,
): Promise<void> {
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

  for (const taskId of changed) {
    if (signal.aborted) throw uncertain();
    const oldTask = taskById(current, taskId)!;
    const oldHost = hostById(current, oldTask.hostId)!;
    const oldHash = launchConfigHash(oldHost, oldTask);
    let result: ServerWaitResult;
    try {
      const transport = await transportProvider(oldHost, current);
      if (!transport.cancelServerWait) throw uncertain();
      result = await transport.cancelServerWait(oldTask, oldHash, signal);
      if (signal.aborted) throw uncertain();
    } catch {
      throw uncertain();
    }

    if (result.armId !== oldTask.autoStart!.armId
      || result.configHash !== oldHash
      || !CONFIRMED_SERVER_WAIT_STATES.includes(result.state)) {
      throw uncertain();
    }
  }
}
