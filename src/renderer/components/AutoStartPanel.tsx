import React, { useState } from 'react';
import type { AutoStartConfig, AutoStartStatus, HostSnapshot } from '../../shared/contracts';
import { formatMiBAsGiB, formatTimestamp } from '../utils/format';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

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
  taskId?: string;
  onConfigure: () => void;
  onRearm: () => void;
  onDisable: () => void;
  isBusy?: boolean;
  error?: string | null;
}

export function AutoStartPanel({
  config,
  status,
  hostId,
  taskId,
  onConfigure,
  onRearm,
  onDisable,
  isBusy = false,
  error,
}: AutoStartPanelProps) {
  const { t } = useI18n();
  const [copiedTmux, setCopiedTmux] = useState(false);

  const errorKey = status?.errorCode ? `autoStart.errors.${status.errorCode}` : null;
  const translated = errorKey ? t(errorKey, status?.errorParams ?? undefined) : null;
  const statusMessage = translated && translated !== errorKey ? translated : status?.message;

  const phase = status?.phase ?? null;
  const unconfirmed = status?.remoteConfirmed === false;
  const isStarting = phase === 'starting';
  const remaining = status ? Math.max(0, status.requiredIdleSeconds - status.idleElapsedSeconds) : 0;
  const countdownPct =
    status && status.requiredIdleSeconds > 0
      ? Math.min(100, Math.max(0, Math.round((status.idleElapsedSeconds / status.requiredIdleSeconds) * 100)))
      : 0;

  const phaseText = !config.enabled
    ? t('autoStart.phaseOff')
    : unconfirmed
      ? t('autoStart.phaseUnconfirmed')
      : phase === 'waiting'
        ? t('autoStart.phaseWaiting')
        : phase === 'countdown'
          ? t('autoStart.phaseCountdown')
          : phase === 'blocked'
            ? t('autoStart.phaseBlocked')
            : phase === 'starting'
              ? t('autoStart.phaseStarting')
              : phase === 'started'
                ? t('autoStart.phaseStarted')
                : phase === 'failed'
                  ? t('autoStart.phaseFailed')
                  : t('autoStart.phaseEnabled');

  const gpuCount = config.requiredGpuCount ?? 1;
  const poolLabel =
    config.gpuDeviceIds.length > 0
      ? t('autoStart.summaryWhitelist', {
          gpus: config.gpuDeviceIds.map((g) => g.replace(/^GPU\s*/, '')).join(','),
          count: gpuCount,
        })
      : gpuCount === 1
        ? t('autoStart.summaryAllPoolAny')
        : t('autoStart.summaryAllPool', { count: gpuCount });

  const selectedDevicesLabel = status?.selectedDeviceIds?.length
    ? `${status.selectedDeviceIds.join(', ')} · `
    : status?.selectedDeviceId
      ? `${status.selectedDeviceId} · `
      : '';

  const tmuxCommand = status?.sessionName
    ? `tmux -L training-monitor-$(id -u) attach-session -t =${status.sessionName}`
    : null;

  const backendLabel = status?.backend ?? 'tmux';

  const copyTmux = async () => {
    if (!tmuxCommand) return;
    try {
      if (window.desktop?.copyCommand && hostId && taskId) {
        try {
          await window.desktop.copyCommand({ kind: 'tmux_attach', hostId, taskId });
        } catch {
          if (window.desktop.copyDiagnosticText) {
            await window.desktop.copyDiagnosticText(tmuxCommand);
          } else {
            throw new Error('COPY_FAILED');
          }
        }
      } else if (window.desktop?.copyDiagnosticText) {
        await window.desktop.copyDiagnosticText(tmuxCommand);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(tmuxCommand);
      } else {
        return;
      }
      setCopiedTmux(true);
      setTimeout(() => setCopiedTmux(false), 1800);
    } catch {
      // Clipboard failed — do not claim copied
    }
  };

  return (
    <section className="auto-start-panel" aria-label={t('autoStart.ariaLabel')}>
      <div className="auto-start-panel-head">
        <div className="auto-start-panel-ident">
          <h3 className="auto-start-panel-title">
            <Icon name="clock" size={14} className="text-info" />
            <span>{t('autoStart.title')}</span>
          </h3>
          <span
            className={`auto-start-phase ${
              !config.enabled ? 'auto-start-phase-off' : phase ? PHASE_CLASS[phase] : 'auto-start-phase-enabled'
            }`}
          >
            {phaseText}
          </span>

          {config.enabled && (
            <div className="auto-start-summary-inline">
              <span className="auto-start-summary-chip">{poolLabel}</span>
              <span className="auto-start-summary-chip">{t('autoStart.summaryIdleDuration', { seconds: config.idleSeconds })}</span>
              {config.minFreeMemoryMiB ? (
                <span className="auto-start-summary-chip">
                  {t('autoStart.summaryFreeMem', { mem: formatMiBAsGiB(config.minFreeMemoryMiB) })}
                </span>
              ) : (
                <>
                  <span className="auto-start-summary-chip">
                    {t('autoStart.summaryUtil', { pct: config.maxUtilizationPercent })}
                  </span>
                  <span className="auto-start-summary-chip">
                    {t('autoStart.summaryMem', { mem: formatMiBAsGiB(config.maxMemoryMiB) })}
                  </span>
                </>
              )}
              {config.gpuSharing && (
                <span className="auto-start-summary-chip">
                  {t('autoStart.summarySharing', {
                    devices: config.gpuSharing.maxDevices,
                    workers: config.gpuSharing.maxWorkersPerDevice,
                  })}
                </span>
              )}
              {config.retryOnExit && <span className="auto-start-summary-chip">{t('autoStart.summaryRetry')}</span>}
              {!unconfirmed &&
                config.execution === 'server_tmux' &&
                status?.remoteConfirmed &&
                phase !== 'started' &&
                phase !== 'failed' &&
                status.errorCode !== 'SERVER_WAIT_CANCELLED' && (
                  <span className="auto-start-summary-chip">{t('autoStart.serverHostedChip')}</span>
                )}
            </div>
          )}
        </div>

        <div className="auto-start-panel-actions">
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={onConfigure}
            aria-label={t('autoStart.editAria')}
          >
            <Icon name="sliders" size={12} />
            <span>{t('autoStart.editBtn')}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={onRearm}
            disabled={isBusy || isStarting || !config.enabled || config.execution !== 'server_tmux'}
            aria-label={t('autoStart.rearmAria')}
          >
            <Icon name="refresh" size={12} />
            <span>{t('autoStart.rearmBtn')}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={onDisable}
            disabled={isBusy || isStarting || !config.enabled}
            aria-label={t('autoStart.disableAria')}
          >
            <Icon name="pause" size={12} />
            <span>{t('autoStart.disableBtn')}</span>
          </button>
        </div>
      </div>

      {config.enabled ? (
        <div className="auto-start-row-bottom">
          {phase === 'countdown' && status && !unconfirmed ? (
            <div className="auto-start-countdown-wrap">
              <div className="auto-start-countdown" aria-label={t('autoStart.countdownAria')}>
                <span>
                  {selectedDevicesLabel}
                  {t('autoStart.countdownText', {
                    device: '',
                    elapsed: status.idleElapsedSeconds,
                    required: status.requiredIdleSeconds,
                  })}
                </span>
                <span className="tabular-num text-muted">
                  {t('autoStart.countdownRemaining', { remaining })}
                </span>
              </div>
              <div className="auto-start-countdown-rail" role="progressbar" aria-valuenow={countdownPct} aria-valuemin={0} aria-valuemax={100}>
                <div className="auto-start-countdown-fill" style={{ width: `${countdownPct}%` }} />
              </div>
            </div>
          ) : (phase === 'blocked' || unconfirmed) && statusMessage ? (
            <p className="auto-start-note auto-start-note-blocked">{statusMessage}</p>
          ) : phase === 'failed' ? (
            <p className="auto-start-note auto-start-note-failed">
              {statusMessage ?? t('autoStart.phaseFailed')}
              {status?.errorCode ? ` (${status.errorCode})` : ''}
            </p>
          ) : phase === 'started' && status?.pid ? (
            <p className="auto-start-note auto-start-note-started tabular-num">
              {t('autoStart.serverHostedStarted', { backend: backendLabel })} · {t('autoStart.startedPid', { pid: status.pid })}
              {status.selectedDeviceIds?.length
                ? ` · ${status.selectedDeviceIds.join(', ')}`
                : status.selectedDeviceId
                  ? ` · ${status.selectedDeviceId}`
                  : ''}
              {status.startedAt ? ` · ${formatTimestamp(status.startedAt)}` : ''}
            </p>
          ) : !unconfirmed && config.execution === 'server_tmux' && status?.remoteConfirmed && status.errorCode !== 'SERVER_WAIT_CANCELLED' ? (
            <p className="auto-start-note text-muted">
              {t('autoStart.serverHostedRunning', { backend: backendLabel })}
            </p>
          ) : null}

          {tmuxCommand && !unconfirmed && phase !== 'started' && phase !== 'failed' && status?.errorCode !== 'SERVER_WAIT_CANCELLED' && (
            <details className="auto-start-session">
              <summary>{t('autoStart.tmuxToggle')}</summary>
              <div className="auto-start-session-code-row">
                <code>{tmuxCommand}</code>
                <button type="button" className="btn btn-secondary btn-xs" onClick={() => void copyTmux()}>
                  <Icon name={copiedTmux ? 'check' : 'copy'} size={12} />
                  <span>{copiedTmux ? t('app.copied') : t('autoStart.copyTmuxBtn')}</span>
                </button>
              </div>
            </details>
          )}
        </div>
      ) : (
        <p className="auto-start-note text-muted">{t('autoStart.disabledNote')}</p>
      )}

      {error && (
        <p className="auto-start-note auto-start-note-failed" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
