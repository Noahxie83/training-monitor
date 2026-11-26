import React, { useEffect, useRef, useState } from 'react';
import type { AlertEvent, HostRegistration, HostSnapshot } from '../../shared/contracts';
import { formatTimeOnly, formatTimestamp } from '../utils/format';
import { translateHostError, useI18n } from '../i18n';
import { Icon } from './Icon';

interface HeaderProps {
  hosts: HostSnapshot[];
  hostRegistrations?: HostRegistration[];
  isDemo: boolean;
  lastSyncTime: string | null;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onOpenGpu?: () => void;
  onOpenDiscovery?: () => void;
  announcement: string;
  isRefreshing?: boolean;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
  isSavingTheme?: boolean;
  onToggleLocale?: () => void;
  activeHostId?: string | null;
  activeTaskLabel?: string | null;
  onSelectHost?: (hostId: string) => void;
  onConnectHost?: (hostId: string) => void;
  connectingHostIds?: string[];
  hostConnectionErrors?: Record<string, string>;
  alerts?: AlertEvent[];
  unreadAlertCount?: number;
  onMarkAlertsRead?: () => void;
  onClearAlerts?: () => void;
  onSelectAlertTask?: (taskId: string, hostId: string) => void;
}

export function Header({
  hosts,
  hostRegistrations = [],
  isDemo,
  lastSyncTime,
  onRefresh,
  onOpenSettings,
  onOpenGpu,
  onOpenDiscovery,
  announcement,
  isRefreshing = false,
  theme = 'light',
  onToggleTheme,
  isSavingTheme = false,
  onToggleLocale,
  activeHostId,
  activeTaskLabel,
  onSelectHost,
  onConnectHost,
  connectingHostIds = [],
  hostConnectionErrors = {},
  alerts = [],
  unreadAlertCount = 0,
  onMarkAlertsRead,
  onClearAlerts,
  onSelectAlertTask,
}: HeaderProps) {
  const { locale, t } = useI18n();
  const [diagOpen, setDiagOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const diagRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!diagOpen && !alertsOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (diagOpen && !diagRef.current?.contains(event.target as Node)) setDiagOpen(false);
      if (alertsOpen && !alertRef.current?.contains(event.target as Node)) setAlertsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDiagOpen(false);
        setAlertsOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [diagOpen, alertsOpen]);

  const activeHost = hosts.find((h) => h.hostId === activeHostId) ?? hosts[0] ?? null;
  const activeReg = activeHost ? hostRegistrations.find((r) => r.hostId === activeHost.hostId) : undefined;
  const isDisabled = activeReg?.enabled === false;
  const isConnecting = activeHost ? connectingHostIds.includes(activeHost.hostId) || activeHost.connection === 'connecting' : false;
  const isConnected = Boolean(activeHost && !isDisabled && activeHost.connection === 'connected');
  const isDisconnected = Boolean(activeHost && !isDisabled && activeHost.connection === 'disconnected');

  const statusClass = isConnecting
    ? 'status-connecting'
    : isDisabled
      ? 'status-unobserved'
      : isConnected
        ? 'status-connected'
        : isDisconnected
          ? 'status-disconnected'
          : 'status-unobserved';

  const statusText = isConnecting
    ? t('header.hostConnecting')
    : isDisabled
      ? t('header.hostDisabled')
      : isConnected
        ? t('header.hostConnected')
        : isDisconnected
          ? t('header.hostDisconnected')
          : t('header.hostPending');

  const activeHostLabel = activeReg?.label || activeHost?.hostId || '';
  const activeErrorMessage = activeHost
    ? hostConnectionErrors[activeHost.hostId] || translateHostError(locale, activeHost.errorCode, activeHost.kind, activeReg)
    : null;

  return (
    <header className="app-header">
      <div className="header-brand">
        <span className="brand-mark">
          <Icon name="activity" size={15} />
        </span>
        <h1 className="header-title">{t('app.title')}</h1>
        {isDemo && (
          <span className="badge-demo" title={t('app.demoBadgeFull')}>
            {t('app.demoBadge')}
          </span>
        )}
      </div>

      <div className="header-center" ref={diagRef}>
        {activeHost ? (
          <>
            <nav className="header-breadcrumb" aria-label={t('header.hostStatusAria')}>
              <button
                type="button"
                className="breadcrumb-host-btn"
                aria-label={t('header.switchHostAria', { hostId: activeHost.hostId })}
                onClick={() => onSelectHost?.(activeHost.hostId)}
                title={`${activeHostLabel} (${activeHost.hostId})${activeHost.scanComplete ? '' : ` · ${t('header.hostPartialScan')}`}`}
              >
                <span className="platform-badge">{activeHost.kind.toUpperCase()}</span>
                <span className="breadcrumb-host-label">{activeHostLabel}</span>
              </button>
              {activeTaskLabel && (
                <>
                  <Icon name="chevronRight" size={13} className="breadcrumb-sep" />
                  <span className="breadcrumb-task" title={activeTaskLabel}>
                    {activeTaskLabel}
                  </span>
                </>
              )}
            </nav>

            <button
              type="button"
              className={`header-status-trigger ${statusClass}`}
              aria-label={t('header.hostDiagnosticAria', { hostId: activeHost.hostId })}
              aria-expanded={diagOpen}
              onClick={() => {
                setAlertsOpen(false);
                setDiagOpen((v) => !v);
              }}
              title={`${t('header.hostLastSuccess')}: ${formatTimeOnly(activeHost.lastSuccessAt)}${activeHost.scanComplete ? '' : ` · ${t('header.hostPartialScan')}`}`}
            >
              <span className={`status-dot ${isConnected ? 'dot-connected' : isDisconnected ? 'dot-disconnected' : isConnecting ? 'dot-connecting' : 'dot-unobserved'}`} />
              <span>{statusText}</span>
            </button>

            {diagOpen && (
              <div className="popover-panel host-diag-popover no-drag" role="region" aria-label={t('header.hostDiagnosticAria', { hostId: activeHost.hostId })}>
                <div className="host-diag-header">
                  <strong className="mono">{activeHost.hostId}</strong>
                  <span className={`status-pill ${isConnected ? 'pill-running' : isDisconnected ? 'pill-danger' : isConnecting ? 'pill-warning' : 'pill-neutral'}`}>
                    <span className="status-dot" />
                    {statusText}
                  </span>
                </div>
                <div className="host-diag-row">
                  <span className="text-muted">{t('header.hostLastCheck')}</span>
                  <span className="tabular-num">{formatTimestamp(activeHost.observedAt)}</span>
                </div>
                <div className="host-diag-row">
                  <span className="text-muted">{t('header.hostLastSuccess')}</span>
                  <span className="tabular-num">{formatTimestamp(activeHost.lastSuccessAt)}</span>
                </div>
                {activeHost.lastProbeDurationMs !== null && (
                  <div className="host-diag-row">
                    <span className="text-muted">{t('header.hostProbeLatency')}</span>
                    <span className="tabular-num">{Math.round(activeHost.lastProbeDurationMs)} ms</span>
                  </div>
                )}
                {!isConnected && activeHost.nextRetryAt && (
                  <div className="host-diag-row">
                    <span className="text-muted">{t('header.hostNextRetry')}</span>
                    <span className="tabular-num">{formatTimeOnly(activeHost.nextRetryAt)}</span>
                  </div>
                )}
                {!activeHost.scanComplete && isConnected && (
                  <div className="text-warning" style={{ fontSize: 11.5 }}>{t('header.hostPartialScan')}</div>
                )}
                {activeErrorMessage && (
                  <div className="alert alert-warning" style={{ padding: '6px 8px', fontSize: 11.5 }}>
                    {activeErrorMessage}
                  </div>
                )}
                <div className="host-diag-actions">
                  {isDisabled ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => {
                        setDiagOpen(false);
                        onOpenSettings();
                      }}
                    >
                      {t('header.hostEnableInSettings')}
                    </button>
                  ) : (
                    onConnectHost && (
                      <button
                        type="button"
                        className={`btn btn-xs ${isConnected ? 'btn-secondary' : 'btn-primary'}`}
                        disabled={isConnecting || !activeReg}
                        onClick={() => onConnectHost(activeHost.hostId)}
                      >
                        <Icon name="refresh" size={12} className={isConnecting ? 'is-spinning' : ''} />
                        {isConnecting
                          ? t('header.hostConnecting')
                          : isConnected
                            ? t('header.hostCheckConnection')
                            : isDisconnected
                              ? t('header.hostReconnect')
                              : t('header.hostConnect')}
                      </button>
                    )
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <span className="text-muted" style={{ fontSize: 12 }}>
            {t('hostOverview.noHostTitle')}
          </span>
        )}
      </div>

      <div className="header-actions">
        {onOpenDiscovery && activeHost && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onOpenDiscovery}
            aria-label={t('header.discoverProcessesAria')}
            title={t('header.discoverProcessesTitle')}
          >
            <Icon name="radar" size={14} />
            <span className="btn-label">{t('header.discoverProcesses')}</span>
          </button>
        )}

        {onOpenGpu && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onOpenGpu}
            aria-label={t('header.openGpuWindowAria')}
            title={t('header.openGpuWindowTitle')}
          >
            <Icon name="gpu" size={14} />
            <span className="btn-label">{t('header.openGpuWindow')}</span>
          </button>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={onRefresh}
          title={t('header.refreshTitle', { time: formatTimeOnly(lastSyncTime) })}
          aria-label={t('header.refreshAria')}
          disabled={isRefreshing}
        >
          <Icon name="refresh" size={14} className={isRefreshing ? 'is-spinning' : ''} />
          <span className="btn-label">{isRefreshing ? t('header.refreshing') : t('header.refresh')}</span>
        </button>

        <div className="header-alert-wrap" ref={alertRef}>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            aria-label={t('header.alertsAria')}
            aria-expanded={alertsOpen}
            title={t('header.alertsTitle')}
            onClick={() => {
              setDiagOpen(false);
              setAlertsOpen((prev) => {
                const next = !prev;
                if (next) onMarkAlertsRead?.();
                return next;
              });
            }}
          >
            <Icon name="bell" size={14} />
            {unreadAlertCount > 0 && (
              <span className="alert-count-badge">{unreadAlertCount > 9 ? '9+' : unreadAlertCount}</span>
            )}
          </button>

          {alertsOpen && (
            <div className="popover-panel alert-popover no-drag" role="region" aria-label={t('header.alertsTitle')}>
              <div className="alert-popover-header">
                <span>{t('header.alertsTitle')}</span>
                {alerts.length > 0 && onClearAlerts && (
                  <button type="button" className="btn btn-ghost btn-xs" onClick={onClearAlerts}>
                    {t('header.alertsClear')}
                  </button>
                )}
              </div>
              <div className="alert-popover-list">
                {alerts.length === 0 ? (
                  <div className="alert-popover-empty">{t('header.alertsEmpty')}</div>
                ) : (
                  alerts.map((alert) => (
                    <button
                      key={alert.alertId}
                      type="button"
                      className="alert-popover-item"
                      onClick={() => {
                        setAlertsOpen(false);
                        if (alert.taskId) onSelectAlertTask?.(alert.taskId, alert.hostId);
                        else onSelectHost?.(alert.hostId);
                      }}
                    >
                      <div className="alert-popover-item-head">
                        <span className={alert.severity === 'critical' ? 'text-danger' : alert.severity === 'warning' ? 'text-warning' : 'text-info'}>
                          {alert.title}
                        </span>
                        <span className="tabular-num text-muted">{formatTimeOnly(alert.observedAt)}</span>
                      </div>
                      <span className="text-secondary">{alert.message}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {onToggleLocale && (
          <button
            type="button"
            className="btn btn-ghost header-lang-btn"
            title={t('header.switchLanguage')}
            aria-label={t('header.switchLanguage')}
            disabled={isSavingTheme}
            onClick={onToggleLocale}
          >
            {t('header.langShort')}
          </button>
        )}

        {onToggleTheme && (
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            title={theme === 'light' ? t('header.switchToDark') : t('header.switchToLight')}
            aria-label={theme === 'light' ? t('header.switchToDark') : t('header.switchToLight')}
            disabled={isSavingTheme}
            onClick={onToggleTheme}
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={14} />
          </button>
        )}

        <button
          type="button"
          className="btn btn-ghost"
          onClick={onOpenSettings}
          title={t('header.settingsAria')}
          aria-label={t('header.settingsAria')}
        >
          <Icon name="settings" size={14} />
          <span className="btn-label">{t('header.settings')}</span>
        </button>
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </header>
  );
}
