import React from 'react';
import type { AutoStartConfig, AutoStartStatus, HostSnapshot } from '../../shared/contracts';
import { Icon } from './Icon';
import { formatTimestamp } from '../utils/format';

const PHASE_TEXT: Record<AutoStartStatus['phase'], string> = {
  waiting: '等待空闲',
  countdown: '空闲倒计时',
  blocked: '暂停等待',
  starting: '正在启动',
  started: '已启动',
  failed: '启动失败',
};

const PHASE_CLASS: Record<AutoStartStatus['phase'], string> = {
  waiting: 'auto-start-phase-waiting',
  countdown: 'auto-start-phase-countdown',
  blocked: 'auto-start-phase-blocked',
  starting: 'auto-start-phase-starting',
  started: 'auto-start-phase-started',
  failed: 'auto-start-phase-failed',
};

interface AutoStartPanelProps {
  config: AutoStartConfig;
  status?: AutoStartStatus | null;
  hostSnapshots?: HostSnapshot[];
  hostId?: string;
  onConfigure: () => void;
  onRearm: () => void;
  onDisable: () => void;
  isBusy?: boolean;
  error?: string | null;
}

export function AutoStartPanel({
  config,
  status,
  hostSnapshots,
  hostId,
  onConfigure,
  onRearm,
  onDisable,
  isBusy = false,
  error,
}: AutoStartPanelProps) {
  const phase = status?.phase ?? null;
  const unconfirmed = status?.remoteConfirmed === false;
  const isStarting = phase === 'starting';
  const remaining = status
    ? Math.max(0, status.requiredIdleSeconds - status.idleElapsedSeconds)
    : 0;

  return <section className="auto-start-panel" aria-label="GPU 空闲自动启动">
    <div className="auto-start-panel-head">
      <div className="auto-start-panel-ident">
        <h3 className="auto-start-panel-title">GPU 空闲自动启动</h3>
        {config.enabled
          ? <span className={"auto-start-phase " + (phase ? PHASE_CLASS[phase] : 'auto-start-phase-enabled')}>
              {unconfirmed ? '状态待确认' : phase ? PHASE_TEXT[phase] : '等待服务器确认'}
            </span>
          : <span className="auto-start-phase auto-start-phase-off">未启用</span>}
      </div>
      <div className="auto-start-panel-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onConfigure} aria-label="编辑自动启动配置">
          <Icon name="settings" />编辑
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRearm} disabled={isBusy || isStarting || !config.enabled || config.execution !== 'server_tmux'} aria-label="重新等待自动启动">
          <Icon name="refresh" />重新等待
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDisable} disabled={isBusy || isStarting || !config.enabled} aria-label="停用自动启动">
          <Icon name="pause" />停用
        </button>
      </div>
    </div>

    {config.enabled ? <>
      <div className="auto-start-panel-facts">
        <span className="auto-start-fact">{config.minFreeMemoryMiB ? '条件持续' : '空闲时长'} <strong className="tabular-num">{config.idleSeconds}s</strong></span>
        {config.minFreeMemoryMiB ? <span className="auto-start-fact">可用显存 ≥ <strong className="tabular-num">{config.minFreeMemoryMiB} MiB</strong></span> : <>
          <span className="auto-start-fact">利用率 ≤ <strong className="tabular-num">{config.maxUtilizationPercent}%</strong></span>
          <span className="auto-start-fact">显存 ≤ <strong className="tabular-num">{config.maxMemoryMiB} MiB</strong></span>
        </>}
        {config.gpuSharing && <span className="auto-start-fact">最多 {config.gpuSharing.maxDevices} 张 GPU · 每卡 {config.gpuSharing.maxWorkersPerDevice} 个进程</span>}
        {!!config.minFreeDiskMiB && <span className="auto-start-fact">输出磁盘可用 ≥ {config.minFreeDiskMiB} MiB</span>}
        <span className="auto-start-fact">全部 GPU · 任意一张</span>
        {config.retryOnExit && <span className="auto-start-fact">退出后自动重新等待</span>}
      </div>
      {phase === 'countdown' && status && !unconfirmed && <p className="auto-start-countdown" aria-label="空闲倒计时">
        {status.selectedDeviceId ? `${status.selectedDeviceId} · ` : ''}
        已连续空闲 <strong className="tabular-num">{status.idleElapsedSeconds}s / {status.requiredIdleSeconds}s</strong>
        <span className="text-muted">（还需 {remaining}s）</span>
      </p>}
      {(phase === 'blocked' || unconfirmed) && status?.message && <p className="auto-start-note auto-start-note-blocked">{status.message}</p>}
      {!unconfirmed && config.execution === 'server_tmux' && status?.remoteConfirmed && status.errorCode !== 'SERVER_WAIT_CANCELLED' && phase !== 'failed' && <p className="auto-start-note text-muted" title={status.sessionName ?? undefined}>服务器 tmux 托管 · {phase === 'started' ? '已由服务器启动' : '本机关机后继续等待'}{status.selectedDeviceId && phase === 'started' ? ` · 使用 ${status.selectedDeviceId}` : ''}</p>}
      {phase === 'failed' && <p className="auto-start-note auto-start-note-failed">
        {status?.message ?? '启动失败'}
        {status?.errorCode ? `（${status.errorCode}）` : ''}
      </p>}
      {phase === 'started' && status?.pid && <p className="auto-start-note auto-start-note-started">
        启动命令已执行，PID <span className="tabular-num">{status.pid}</span>
        {status.startedAt ? ` · ${formatTimestamp(status.startedAt)}` : ''}
      </p>}
      {status?.lastCheckedAt && phase !== 'started' && <p className="auto-start-note text-muted">上次检查 {formatTimestamp(status.lastCheckedAt)}</p>}
      {status?.sessionName && !unconfirmed && phase !== 'started' && phase !== 'failed' && status.errorCode !== 'SERVER_WAIT_CANCELLED' && <details className="auto-start-session">
        <summary>在服务器终端查看等待</summary>
        <code>{`tmux -L training-monitor-$(id -u) attach-session -t =${status.sessionName}`}</code>
      </details>}
    </> : <p className="auto-start-note text-muted">
      自动启动已停用；不会影响正在运行的训练进程。
    </p>}
    {error && <p className="auto-start-note auto-start-note-failed" role="alert">{error}</p>}
  </section>;
}
