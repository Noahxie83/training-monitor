import { createHash } from 'node:crypto';
import type { AutoStartStatus, HostRegistration, Registry, TaskRegistration } from '../shared/contracts';
import type { HostObservation, ServerWaitResult, Transport } from '../transport/types';

export function launchConfigHash(host: HostRegistration, task: TaskRegistration): string {
  return createHash('sha256').update(JSON.stringify({
    hostId: host.hostId,
    target: host.target,
    roots: host.allowedRoots,
    ...(host.stateDir ? { stateDir: host.stateDir } : {}),
    taskId: task.taskId,
    directories: task.allowedDirectories,
    entries: task.entryPaths,
    sources: task.sources,
    autoStart: task.autoStart,
  })).digest('hex');
}

type State = { hash: string; status: AutoStartStatus };
interface Options {
  clock: () => number;
  monotonicClock?: () => number;
  registryProvider: () => Promise<Registry>;
  onChange?: () => Promise<void>;
}

function formatServerWaitMessage(result: ServerWaitResult): string {
  if (result.state === 'cancelled') return '服务器等待已取消；点击重新等待可创建新规则';
  if (result.errorCode) return result.message || result.errorCode;
  if (result.state === 'failed') return result.message || 'Server launch failed';
  if (result.state === 'blocked') return result.message || 'Server prerequisites unavailable';
  if (result.state === 'started') {
    if (result.exitCode === 0) return '任务已完成（退出码 0），自动重试已结束';
    return '服务器已创建进程，请查看任务日志';
  }
  if (result.state === 'starting') return '服务器正在检查并启动进程';
  const count = result.selectedDeviceIds?.length;
  if (count && count > 1) return `服务器正在等待 ${count} 张 GPU 连续空闲`;
  return '服务器正在监控可用 GPU，等待满足连续空闲条件';
}

/** The server owns timers and launch receipts. Closing the app never cancels a server job. */
export class AutoStartController {
  private readonly states = new Map<string, State>();
  private readonly active = new Set<string>();
  constructor(private readonly options: Options) {}

  synchronize(registry: Registry): void {
    for (const id of this.states.keys()) {
      if (!registry.tasks.some(task => task.taskId === id && task.autoStart)) this.states.delete(id);
    }
    for (const task of registry.tasks) {
      const config = task.autoStart;
      const host = registry.hosts.find(item => item.hostId === task.hostId);
      if (!config || !host) continue;
      const hash = launchConfigHash(host, task);
      let state = this.states.get(task.taskId);
      if (!state || state.hash !== hash) {
        state = {
          hash,
          status: {
            armId: config.armId,
            phase: 'waiting',
            idleElapsedSeconds: 0,
            requiredIdleSeconds: config.idleSeconds,
            lastCheckedAt: null,
            startedAt: null,
            pid: null,
            errorCode: null,
            message: '等待确认服务器托管状态',
            execution: 'server_tmux',
            remoteConfirmed: false,
            sessionName: null,
            selectedDeviceId: null,
          },
        };
        this.states.set(task.taskId, state);
      }
      if (!config.enabled || !host.enabled || !task.enabled) {
        Object.assign(state.status, { phase: 'blocked', message: !config.enabled ? '自动启动已停用' : '监控已停用' });
      }
    }
  }

  getStatus(taskId: string): AutoStartStatus | undefined {
    const state = this.states.get(taskId);
    return state ? structuredClone(state.status) : undefined;
  }

  private unconfirmed(state: State, code: string, message: string): void {
    Object.assign(state.status, { phase: 'blocked', remoteConfirmed: false, errorCode: code, errorParams: undefined, message });
  }

  private project(state: State, result: ServerWaitResult): void {
    const phase = result.state === 'cancelled' || result.state === 'missing' ? 'blocked' : result.state;
    Object.assign(state.status, {
      phase,
      idleElapsedSeconds: result.idleElapsedSeconds,
      requiredIdleSeconds: result.requiredIdleSeconds,
      lastCheckedAt: result.lastCheckedAt,
      startedAt: result.startedAt,
      pid: result.pid,
      errorCode: result.state === 'cancelled' ? 'SERVER_WAIT_CANCELLED' : result.errorCode,
      errorParams: result.errorCode === 'MAX_RETRIES_EXCEEDED'
        ? { ...result.errorParams, count: result.retryCount ?? result.maxRetries ?? 3 }
        : result.errorParams ?? undefined,
      message: formatServerWaitMessage(result),
      remoteConfirmed: true,
      sessionName: result.sessionName,
      selectedDeviceId: result.selectedDeviceId,
      ...(result.selectedDeviceIds ? { selectedDeviceIds: [...result.selectedDeviceIds] } : { selectedDeviceIds: undefined }),
      ...(typeof result.retryCount === 'number' ? { retryCount: result.retryCount } : {}),
      ...(typeof result.maxRetries === 'number' ? { maxRetries: result.maxRetries } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.backend ? { backend: result.backend } : {}),
    });
  }

  async evaluate(
    host: HostRegistration,
    task: TaskRegistration,
    observation: HostObservation,
    transport: Transport | null,
    signal: AbortSignal,
  ): Promise<void> {
    const c = task.autoStart;
    const state = this.states.get(task.taskId);
    if (!c?.enabled || !task.enabled || !host.enabled || !state || state.hash !== launchConfigHash(host, task) || signal.aborted || this.active.has(task.taskId)) return;
    if (host.target.kind !== 'ssh') { this.unconfirmed(state, 'SERVER_WAIT_SSH_ONLY', '仅远程 SSH 服务器支持托管等待'); return; }
    if (c.execution !== 'server_tmux') { this.unconfirmed(state, 'SERVER_WAIT_CONFIRMATION_REQUIRED', '请编辑并保存为服务器托管规则后启用'); return; }
    if (!transport?.getServerWait || !transport.ensureServerWait) { this.unconfirmed(state, 'SERVER_WAIT_UNAVAILABLE', '服务器托管服务不可用'); return; }
    if (observation.connection !== 'connected' || observation.freshness !== 'fresh' || !observation.scanComplete || observation.errorCode) {
      this.unconfirmed(state, 'SERVER_WAIT_UNCONFIRMED', '连接中断，服务器上的等待可能仍在继续；重新连接后确认'); return;
    }
    this.active.add(task.taskId);
    try {
      let result = await transport.getServerWait(task, state.hash, signal);
      if (result.armId !== c.armId || result.configHash !== state.hash) throw new Error('SERVER_WAIT_RESPONSE_MISMATCH');
      if (result.state === 'missing' || (c.retryOnExit && result.errorCode === 'SERVER_WAITER_LOST')) {
        const registry = await this.options.registryProvider();
        const current = registry.tasks.find(item => item.taskId === task.taskId);
        const currentHost = registry.hosts.find(item => item.hostId === host.hostId);
        if (signal.aborted || !current?.enabled || !current.autoStart?.enabled || !currentHost?.enabled || launchConfigHash(currentHost, current) !== state.hash) {
          this.unconfirmed(state, 'REGISTRY_CHANGED', '配置已变化，等待重新确认'); return;
        }
        state.status.message = '正在提交到服务器；确认托管后可关闭本机';
        try { await this.options.onChange?.(); } catch { /* Publishing does not control the persistent job. */ }
        result = await transport.ensureServerWait(current, state.hash, signal);
      }
      if (signal.aborted) return;
      if (result.armId !== c.armId || result.configHash !== state.hash) {
        throw new Error('SERVER_WAIT_RESPONSE_MISMATCH');
      }
      // Do NOT mask server-returned failed/blocked/missing error codes with SERVER_WAIT_RESPONSE_MISMATCH
      // when error payloads report fallback requiredIdleSeconds (e.g. 1).
      const requiresExactIdle =
        result.state === 'waiting' ||
        result.state === 'countdown' ||
        result.state === 'starting' ||
        result.state === 'started';
      if (requiresExactIdle && result.requiredIdleSeconds !== c.idleSeconds) {
        throw new Error('SERVER_WAIT_RESPONSE_MISMATCH');
      }
      this.project(state, result);
    } catch {
      this.unconfirmed(state, 'SERVER_WAIT_UNCONFIRMED', '无法确认服务器托管状态；若已提交，关闭本机不会停止等待，请重连确认');
    } finally { this.active.delete(task.taskId); }
  }
}
