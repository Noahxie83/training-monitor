import { randomUUID } from 'node:crypto';
import type {
  AlertEvent,
  AlertEventKind,
  AlertPreferences,
  HostSnapshot,
  LogEvent,
  TaskSnapshot,
  WebhookChannelConfig,
} from '../shared/contracts';
import { stripAnsi } from '../parsers/ansi';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

const DEFAULT_COOLDOWN_SECONDS = 300;
const DEFAULT_STALL_MINUTES = 15;
const DEFAULT_DISCONNECT_SECONDS = 60;

const CUDA_OOM_RE = /CUDA out of memory|torch\.OutOfMemoryError|OutOfMemoryError|HIP out of memory/i;
const LOSS_NAN_INF_RE = /\b(?:loss|train_loss|training_loss|val_loss|eval_loss)["']?\s*[:=]\s*["']?(?:nan|[-+]?inf(?:inity)?)\b/i;
const CRASH_LOG_RE = /Traceback \(most recent call last\):|Segmentation fault|SIGSEGV|SIGKILL|NCCL (?:unhandled )?(?:system |internal )?error|Fatal Python error/i;

export function buildWebhookPayload(channel: WebhookChannelConfig, alert: AlertEvent): Record<string, unknown> {
  const prefix = `[Training Monitor][${alert.severity.toUpperCase()}]`;
  const summary = `${prefix} ${alert.title}\n${alert.message}\nHost: ${alert.hostId}${alert.taskId ? ` | Task: ${alert.taskId}` : ''}\nTime: ${alert.observedAt}`;
  switch (channel.kind) {
    case 'feishu':
      return { msg_type: 'text', content: { text: summary } };
    case 'slack':
      return { text: summary };
    case 'discord':
      return { content: summary };
    case 'generic':
    default:
      return {
        alertId: alert.alertId,
        kind: alert.kind,
        severity: alert.severity,
        hostId: alert.hostId,
        taskId: alert.taskId,
        title: alert.title,
        message: alert.message,
        observedAt: alert.observedAt,
      };
  }
}

export async function dispatchWebhook(
  channel: WebhookChannelConfig,
  alert: AlertEvent,
  fetchImpl: FetchLike = (globalThis.fetch as unknown as FetchLike),
): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
  if (!channel.url || !/^https?:\/\//i.test(channel.url)) {
    return { ok: false, statusCode: null, error: 'INVALID_WEBHOOK_URL' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, statusCode: null, error: 'FETCH_UNAVAILABLE' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  try {
    const body = JSON.stringify(buildWebhookPayload(channel, alert));
    const response = await fetchImpl(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    return response.ok
      ? { ok: true, statusCode: response.status, error: null }
      : { ok: false, statusCode: response.status, error: `HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : 'WEBHOOK_FAILED' };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTestWebhook(
  channel: WebhookChannelConfig,
  nowMs: number = Date.now(),
  fetchImpl?: FetchLike,
): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
  const testAlert: AlertEvent = {
    alertId: `test-${randomUUID()}`,
    kind: 'training_completed',
    severity: 'info',
    hostId: 'test-host',
    taskId: 'test-task',
    title: 'Training Monitor 测试告警',
    message: `来自通道 "${channel.label || channel.kind}" 的连通性测试消息。`,
    observedAt: new Date(nowMs).toISOString(),
  };
  return dispatchWebhook(channel, testAlert, fetchImpl);
}

interface StallTracker {
  runId: string;
  lastProgressValue: number | null;
  lastProgressAdvanceMs: number;
  lowGpuSinceMs: number | null;
}

export interface AlertEngineOptions {
  clock: () => number;
  getPreferences: () => AlertPreferences | undefined;
  onAlert?: (alert: AlertEvent) => void | Promise<void>;
  fetchImpl?: FetchLike;
}

export class AlertEngine {
  private readonly cooldowns = new Map<string, number>();
  private readonly stallTrackers = new Map<string, StallTracker>();
  private readonly disconnectSince = new Map<string, number>();
  private readonly recentAlerts: AlertEvent[] = [];

  constructor(private readonly options: AlertEngineOptions) {}

  private config(): Required<Pick<AlertPreferences, 'cooldownSeconds' | 'stallThresholdMinutes' | 'hostDisconnectThresholdSeconds' | 'desktopNotifications'>> & {
    enabledKinds: AlertEventKind[] | null;
    webhooks: WebhookChannelConfig[];
  } {
    const raw = this.options.getPreferences();
    return {
      cooldownSeconds: raw?.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
      stallThresholdMinutes: raw?.stallThresholdMinutes ?? DEFAULT_STALL_MINUTES,
      hostDisconnectThresholdSeconds: raw?.hostDisconnectThresholdSeconds ?? DEFAULT_DISCONNECT_SECONDS,
      desktopNotifications: raw?.desktopNotifications ?? true,
      enabledKinds: raw?.enabledKinds ?? null,
      webhooks: raw?.webhooks ?? [],
    };
  }

  private emit(
    kind: AlertEventKind,
    severity: AlertEvent['severity'],
    hostId: string,
    taskId: string | null,
    title: string,
    message: string,
  ): AlertEvent | null {
    const cfg = this.config();
    if (cfg.enabledKinds !== null && !cfg.enabledKinds.includes(kind)) return null;

    const nowMs = this.options.clock();
    const dedupKey = `${hostId}\0${taskId ?? '*'}\0${kind}`;
    const lastSent = this.cooldowns.get(dedupKey);
    if (lastSent !== undefined && nowMs - lastSent < cfg.cooldownSeconds * 1000) {
      return null;
    }
    this.cooldowns.set(dedupKey, nowMs);

    const alert: AlertEvent = {
      alertId: randomUUID(),
      kind,
      severity,
      hostId,
      taskId,
      title,
      message: message.slice(0, 500),
      observedAt: new Date(nowMs).toISOString(),
    };
    this.recentAlerts.push(alert);
    if (this.recentAlerts.length > 200) this.recentAlerts.shift();

    void Promise.resolve(this.options.onAlert?.(alert)).catch(() => undefined);

    for (const webhook of cfg.webhooks) {
      if (!webhook.enabled) continue;
      void dispatchWebhook(webhook, alert, this.options.fetchImpl).catch(() => undefined);
    }

    return alert;
  }

  getRecentAlerts(): AlertEvent[] {
    return structuredClone(this.recentAlerts);
  }

  clearTask(taskId: string): void {
    this.stallTrackers.delete(taskId);
  }

  /** Inspect newly ingested log events for CUDA OOM or NaN/Inf loss. */
  inspectLogEvents(hostId: string, taskId: string, events: LogEvent[]): AlertEvent[] {
    const emitted: AlertEvent[] = [];
    for (const event of events) {
      if (!event.text) continue;
      const clean = stripAnsi(event.text);
      if (CUDA_OOM_RE.test(clean)) {
        const alert = this.emit(
          'cuda_oom',
          'critical',
          hostId,
          taskId,
          `CUDA OOM (${taskId})`,
          clean.trim(),
        );
        if (alert) emitted.push(alert);
      }
      if (LOSS_NAN_INF_RE.test(clean)) {
        const alert = this.emit(
          'loss_nan_inf',
          'warning',
          hostId,
          taskId,
          `Loss 出现 NaN/Inf (${taskId})`,
          clean.trim(),
        );
        if (alert) emitted.push(alert);
      }
    }
    return emitted;
  }

  /** Inspect task snapshot transition and stall conditions. */
  inspectTaskSnapshot(previous: TaskSnapshot | null, current: TaskSnapshot, tailLines?: string[]): AlertEvent[] {
    const emitted: AlertEvent[] = [];
    const nowMs = this.options.clock();
    const cfg = this.config();

    // 1. Crash detection
    if (previous?.lifecycle === 'running' && current.lifecycle === 'failed') {
      const snippet = current.terminalSummary || current.reason || 'Training process exited abnormally';
      const alert = this.emit(
        'process_crashed',
        'critical',
        current.hostId,
        current.taskId,
        `训练进程异常退出 (${current.taskId})`,
        snippet,
      );
      if (alert) emitted.push(alert);
      this.stallTrackers.delete(current.taskId);
    } else if (previous?.lifecycle === 'running' && current.lifecycle !== 'running' && tailLines?.length) {
      const crashLine = [...tailLines].reverse().map(stripAnsi).find((line) => CRASH_LOG_RE.test(line));
      if (crashLine) {
        const alert = this.emit(
          'process_crashed',
          'critical',
          current.hostId,
          current.taskId,
          `训练进程崩溃 (${current.taskId})`,
          crashLine.trim(),
        );
        if (alert) emitted.push(alert);
      }
    }

    // 2. Completion detection
    if (previous?.lifecycle === 'running' && current.lifecycle === 'completed') {
      const alert = this.emit(
        'training_completed',
        'info',
        current.hostId,
        current.taskId,
        `训练任务已完成 (${current.taskId})`,
        current.terminalSummary || current.reason || 'Training completed',
      );
      if (alert) emitted.push(alert);
      this.stallTrackers.delete(current.taskId);
    }

    // 3. Stall detection: running + zero progress advance for >= stallThresholdMinutes + GPU util < 2%
    if (current.lifecycle === 'running' && current.currentRun) {
      const progressVal =
        current.progress.current ??
        current.progress.lastStepIndex ??
        current.progress.global.completedCount ??
        current.progress.session.completedCount ??
        null;

      const gpuUtils = current.resources
        .filter((m) => m.name === 'gpu_utilization' && m.scope === 'process' && m.freshness === 'fresh' &&
          typeof m.value === 'number' && Number.isFinite(m.value))
        .map((m) => m.value!);
      if (progressVal === null || gpuUtils.length === 0) {
        this.stallTrackers.delete(current.taskId);
        return emitted;
      }
      const isGpuIdle = Math.max(...gpuUtils) < 2;

      let tracker = this.stallTrackers.get(current.taskId);
      if (!tracker || tracker.runId !== current.currentRun.runId) {
        tracker = {
          runId: current.currentRun.runId,
          lastProgressValue: progressVal,
          lastProgressAdvanceMs: nowMs,
          lowGpuSinceMs: isGpuIdle ? nowMs : null,
        };
        this.stallTrackers.set(current.taskId, tracker);
      } else {
        if (progressVal !== null && (tracker.lastProgressValue === null || progressVal > tracker.lastProgressValue)) {
          tracker.lastProgressValue = progressVal;
          tracker.lastProgressAdvanceMs = nowMs;
          tracker.lowGpuSinceMs = isGpuIdle ? nowMs : null;
        } else {
          if (isGpuIdle) {
            if (tracker.lowGpuSinceMs === null) tracker.lowGpuSinceMs = nowMs;
          } else {
            tracker.lowGpuSinceMs = null;
          }
          const thresholdMs = cfg.stallThresholdMinutes * 60 * 1000;
          const noProgressDuration = nowMs - tracker.lastProgressAdvanceMs;
          const lowGpuDuration = tracker.lowGpuSinceMs !== null ? nowMs - tracker.lowGpuSinceMs : 0;
          if (noProgressDuration >= thresholdMs && lowGpuDuration >= thresholdMs) {
            const mins = Math.round(noProgressDuration / 60_000);
            const alert = this.emit(
              'training_stalled',
              'warning',
              current.hostId,
              current.taskId,
              `训练疑似卡死 (${current.taskId})`,
              `已连续 ${mins} 分钟无步数推进且 GPU 利用率低于 2%`,
            );
            if (alert) emitted.push(alert);
          }
        }
      }
    } else {
      this.stallTrackers.delete(current.taskId);
    }

    return emitted;
  }

  /** Inspect host connectivity for sustained disconnects. */
  inspectHostSnapshot(host: HostSnapshot): AlertEvent | null {
    const nowMs = this.options.clock();
    const cfg = this.config();
    if (host.connection === 'connected') {
      this.disconnectSince.delete(host.hostId);
      return null;
    }
    if (host.errorCode === 'HOST_DISABLED') {
      this.disconnectSince.delete(host.hostId);
      return null;
    }
    if (host.connection === 'disconnected') {
      const since = this.disconnectSince.get(host.hostId);
      if (since === undefined) {
        this.disconnectSince.set(host.hostId, nowMs);
        return null;
      }
      if (nowMs - since >= cfg.hostDisconnectThresholdSeconds * 1000) {
        const secs = Math.round((nowMs - since) / 1000);
        return this.emit(
          'host_disconnected',
          'warning',
          host.hostId,
          null,
          `宿主持续断连 (${host.hostId})`,
          `宿主 ${host.hostId} 已断开连接 ${secs} 秒（${host.errorCode ?? 'DISCONNECTED'}）`,
        );
      }
    }
    return null;
  }
}
