import React, { useEffect, useMemo, useState } from 'react';
import { useMonitor } from '../hooks/useMonitor';
import { useGpuHistory } from '../hooks/useGpuHistory';
import { I18nProvider, translateHostError, useI18n } from '../i18n';
import { FleetSummaryStrip, buildNormalizedGpuCards } from './FleetSummaryStrip';
import { GpuDeviceMetrics } from './ResourceMetrics';
import { Icon } from './Icon';
import { formatTimeOnly, formatTimestamp } from '../utils/format';

function GpuMonitorInner() {
  const {
    snapshot,
    registry,
    activeHost,
    activeHostId,
    selectHost,
    connectingHostIds,
    connectHost,
    hostConnectionErrors,
    preferences,
    locale,
    resolvedTheme,
    updatePreferences,
    isSavingPreferences,
    error,
    isLoadingSnapshot,
    retrySnapshotLoad,
  } = useMonitor();
  const { t } = useI18n();
  const [requestedHostId, setRequestedHostId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('hostId'),
  );
  const [filter, setFilter] = useState<'all' | 'idle'>('all');

  useEffect(() => window.desktop?.onGpuHostSelected(setRequestedHostId), []);
  useEffect(() => {
    if (!requestedHostId || !snapshot?.hosts.some((host) => host.hostId === requestedHostId)) return;
    selectHost(requestedHostId);
    setRequestedHostId(null);
  }, [requestedHostId, snapshot, selectHost]);

  const gpuHistory = useGpuHistory(activeHost);

  const registration = registry?.hosts.find((host) => host.hostId === activeHostId);
  const disabled = registration?.enabled === false;
  const connecting = connectingHostIds.includes(activeHostId ?? '');
  const connected = activeHost?.connection === 'connected' && !disabled;
  const gpu = activeHost?.gpu;
  const resources = useMemo(
    () =>
      (gpu?.metrics ?? []).map((metric) =>
        disabled || !connected || gpu?.state !== 'available' ? { ...metric, freshness: 'stale' as const } : metric,
      ),
    [gpu?.metrics, gpu?.state, disabled, connected],
  );
  const cards = useMemo(() => buildNormalizedGpuCards(resources, gpu?.devices), [resources, gpu?.devices]);
  const hasSamples = cards.length > 0;
  const stale = hasSamples && resources.some((metric) => metric.freshness !== 'fresh');
  const connectionMessage =
    activeHost &&
    (hostConnectionErrors[activeHost.hostId] ||
      translateHostError(locale, activeHost.errorCode, activeHost.kind, registration));
  const noGpuDevice =
    connected && (activeHost?.acceleratorAvailability === 'none' || gpu?.acceleratorAvailability === 'none');
  const gpuUnavailable = connected && !noGpuDevice && gpu?.state === 'unavailable';
  const status = connecting
    ? t('header.hostConnecting')
    : disabled
      ? t('header.hostDisabled')
      : connected
        ? t('header.hostConnected')
        : activeHost?.connection === 'disconnected'
          ? t('header.hostDisconnected')
          : t('header.hostPending');

  return (
    <I18nProvider
      locale={locale}
      onChangeLocale={(next) => {
        void updatePreferences({ ...preferences, locale: next }).catch(() => undefined);
      }}
    >
      <GpuMonitorContent
        snapshot={snapshot}
        registry={registry}
        activeHost={activeHost}
        activeHostId={activeHostId}
        selectHost={selectHost}
        connectHost={connectHost}
        resolvedTheme={resolvedTheme}
        preferences={preferences}
        updatePreferences={updatePreferences}
        isSavingPreferences={isSavingPreferences}
        error={error}
        isLoadingSnapshot={isLoadingSnapshot}
        retrySnapshotLoad={retrySnapshotLoad}
        registration={registration}
        disabled={disabled}
        connecting={connecting}
        connected={connected}
        gpu={gpu}
        resources={resources}
        cards={cards}
        gpuHistory={gpuHistory}
        hasSamples={hasSamples}
        stale={stale}
        connectionMessage={connectionMessage}
        noGpuDevice={noGpuDevice}
        gpuUnavailable={gpuUnavailable}
        status={status}
        filter={filter}
        setFilter={setFilter}
      />
    </I18nProvider>
  );
}

function GpuMonitorContent({
  snapshot,
  registry,
  activeHost,
  activeHostId,
  selectHost,
  connectHost,
  resolvedTheme,
  preferences,
  updatePreferences,
  isSavingPreferences,
  error,
  isLoadingSnapshot,
  retrySnapshotLoad,
  registration,
  disabled,
  connecting,
  connected,
  gpu,
  resources,
  cards,
  gpuHistory,
  hasSamples,
  stale,
  connectionMessage,
  noGpuDevice,
  gpuUnavailable,
  status,
  filter,
  setFilter,
}: any) {
  const { locale, t } = useI18n();

  return (
    <div className="app-shell gpu-monitor-page" data-theme={resolvedTheme}>
      <header className="gpu-monitor-toolbar">
        <div className="gpu-monitor-title">
          <span className="brand-mark">
            <Icon name="gpu" size={15} />
          </span>
          <h1>{t('gpuWindow.title')}</h1>
          {snapshot?.demo && <span className="badge-demo">{t('app.demoBadge')}</span>}
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn btn-ghost header-lang-btn"
            disabled={isSavingPreferences}
            aria-label={t('header.switchLanguage')}
            title={t('header.switchLanguage')}
            onClick={() => {
              const nextLocale = locale === 'zh-CN' ? 'en-US' : 'zh-CN';
              void updatePreferences({ ...preferences, locale: nextLocale }).catch(() => undefined);
            }}
          >
            {t('header.langShort')}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            disabled={isSavingPreferences}
            aria-label={resolvedTheme === 'light' ? t('header.switchToDark') : t('header.switchToLight')}
            onClick={() => {
              void updatePreferences({
                ...preferences,
                theme: resolvedTheme === 'light' ? 'dark' : 'light',
              }).catch(() => undefined);
            }}
          >
            <Icon name={resolvedTheme === 'light' ? 'moon' : 'sun'} size={14} />
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              window.setTimeout(() => window.close(), 0);
            }}
          >
            <Icon name="close" size={13} />
            <span>{t('gpuWindow.closeWindow')}</span>
          </button>
        </div>
      </header>

      {!!snapshot?.hosts.length && (
        <nav className="gpu-host-tabs" aria-label={t('gpuWindow.selectDeviceAria')}>
          {snapshot.hosts.map((host: any) => {
            const reg = registry?.hosts.find((h: any) => h.hostId === host.hostId);
            const dotClass =
              host.connection === 'connected'
                ? 'dot-connected'
                : host.connection === 'disconnected'
                  ? 'dot-disconnected'
                  : 'dot-unobserved';
            const tabLabel = `${reg?.label || host.hostId} ${host.hostId} ${host.kind.toUpperCase()}`;
            return (
              <button
                type="button"
                key={host.hostId}
                aria-label={tabLabel}
                aria-pressed={host.hostId === activeHostId}
                onClick={() => selectHost(host.hostId)}
              >
                <span className={`host-status-dot ${dotClass}`} />
                <span>{reg?.label || host.hostId}</span>
                <span className="gpu-host-kind">{host.hostId}</span>
                <span className="platform-badge">{host.kind.toUpperCase()}</span>
              </button>
            );
          })}
        </nav>
      )}

      {error && (
        <div role="alert" className="alert alert-danger gpu-monitor-alert">
          <span>{error}</span>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={() => {
              void retrySnapshotLoad();
            }}
          >
            {t('gpuWindow.retryRead')}
          </button>
        </div>
      )}

      <main className="gpu-monitor-content">
        {activeHost ? (
          <>
            <div className="gpu-monitor-hostline">
              <div>
                <h2>{registration?.label || activeHost.hostId}</h2>
                <p className="gpu-monitor-host-meta">
                  <span
                    className={`status-pill ${connected ? 'pill-running' : activeHost.connection === 'disconnected' ? 'pill-danger' : 'pill-neutral'}`}
                    role="status"
                  >
                    <span className="status-dot" />
                    {status}
                  </span>
                  <span>{t('gpuWindow.pollIntervalNote')}</span>
                  {gpu?.observedAt && (
                    <span className="tabular-num" title={formatTimestamp(gpu.observedAt)}>
                      {t('gpuWindow.lastSample', { time: formatTimeOnly(gpu.observedAt) })}
                      {stale ? ` · ${t('app.stale')}` : ''}
                    </span>
                  )}
                </p>
              </div>
              {!disabled && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={connecting || !registration}
                  onClick={() => {
                    void connectHost(activeHost.hostId);
                  }}
                >
                  <Icon name="refresh" size={13} className={connecting ? 'is-spinning' : ''} />
                  <span>
                    {connecting
                      ? t('header.hostConnecting')
                      : connected
                        ? t('gpuWindow.refreshNow')
                        : t('gpuWindow.reconnect')}
                  </span>
                </button>
              )}
            </div>

            {(disabled || connectionMessage) && (
              <p className="alert alert-warning" role="alert">
                {disabled ? t('gpuWindow.disabledNotice') : connectionMessage}
              </p>
            )}

            {(stale || gpuUnavailable) && (
              <p className="gpu-monitor-stale text-warning" role="status">
                {hasSamples ? t('gpuWindow.staleNotice') : t('gpuWindow.unavailableNotice')}
              </p>
            )}

            {hasSamples && (
              <FleetSummaryStrip
                cards={cards}
                system={activeHost.system}
                filter={filter}
                onFilterChange={setFilter}
              />
            )}

            {hasSamples ? (
              <GpuDeviceMetrics
                resources={resources}
                devices={gpu?.devices}
                gpuHistory={gpuHistory}
                idleOnly={filter === 'idle'}
              />
            ) : (
              <div className="gpu-monitor-empty">
                <div className="empty-icon">
                  <Icon name={noGpuDevice ? 'cpu' : 'gpu'} size={22} />
                </div>
                <h2>
                  {isLoadingSnapshot
                    ? t('gpuWindow.loadingGpu')
                    : noGpuDevice
                      ? t('hostOverview.noGpuDetected')
                      : t('resources.deviceGpuEmpty')}
                </h2>
                <p>
                  {disabled
                    ? t('gpuWindow.emptyDisabledDesc')
                    : noGpuDevice
                      ? t('hostOverview.noGpuCpuOnlyDesc')
                      : connected
                        ? t('gpuWindow.emptyConnectedDesc')
                        : t('gpuWindow.emptyDisconnectedDesc')}
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="gpu-monitor-empty">
            <div className="empty-icon">
              <Icon name="server" size={22} />
            </div>
            <h2>{isLoadingSnapshot ? t('gpuWindow.loadingDevice') : t('gpuWindow.noDevice')}</h2>
            <p>{t('gpuWindow.noDeviceDesc')}</p>
          </div>
        )}
      </main>
    </div>
  );
}

/** A companion window: device samples belong to the host, never a selected task. */
export function GpuMonitor() {
  return <GpuMonitorInner />;
}
