import React from 'react';
import type { HostRegistration, HostSnapshot } from '../../shared/contracts';
import { formatTimeOnly } from '../utils/format';
import { translateHostError, useI18n, type Locale } from '../i18n';
import { Icon } from './Icon';

export function hostFailureMessage(
  code: string | null,
  kind: HostSnapshot['kind'],
  registration?: HostRegistration,
  locale: Locale = 'zh-CN',
): string | null {
  return translateHostError(locale, code, kind, registration);
}

/**
 * Compact inline diagnostic bar: completely hidden (0px) when the active host is healthy & connected.
 * Only expands automatically on disconnect, disabled host, connection error, or active connect attempt.
 */
export function HostConnectionPanel({
  host,
  registration,
  connecting,
  error,
  onConnect,
  onOpenSettings,
}: {
  host: HostSnapshot;
  registration?: HostRegistration;
  connecting: boolean;
  error?: string;
  onConnect: () => void;
  onOpenSettings: () => void;
}) {
  const { locale, t } = useI18n();
  const disabled = registration?.enabled === false;
  const connected = !disabled && host.connection === 'connected';
  const message = error || translateHostError(locale, host.errorCode, host.kind, registration);

  // Zero vertical footprint when host is connected and healthy
  if (connected && !connecting && !message) {
    return null;
  }

  // Also hide when host is simply unobserved with no error (users can connect via header pill or sidebar)
  // Wait: if unobserved and enabled with no error, show a very slim info bar so users can connect immediately.
  const isDanger = Boolean(error || host.connection === 'disconnected');
  const isInfo = !isDanger && !disabled;

  const statusText = connecting
    ? t('header.hostConnecting')
    : disabled
      ? t('header.hostDisabled')
      : host.connection === 'disconnected'
        ? t('header.hostDisconnected')
        : t('header.hostPending');

  return (
    <section
      className={`host-inline-alert-strip ${isDanger ? 'is-danger' : isInfo ? 'is-info' : ''}`}
      aria-label={t('header.hostConnectionStatusAria', { hostId: host.hostId })}
    >
      <div className="host-inline-alert-main">
        <Icon name={isDanger ? 'warning' : 'info'} size={14} />
        <strong className="mono">{registration?.label || host.hostId}</strong>
        <span role="status">{statusText}</span>
        {message && (
          <span className="host-inline-alert-text" role="alert" title={message}>
            · {message}
          </span>
        )}
        {!connecting && !connected && !disabled && host.nextRetryAt && (
          <span className="host-inline-alert-meta">
            {t('header.hostNextRetry')}: {formatTimeOnly(host.nextRetryAt)}
          </span>
        )}
      </div>

      {disabled ? (
        <button type="button" className="btn btn-secondary btn-xs" onClick={onOpenSettings}>
          {t('header.hostEnableInSettings')}
        </button>
      ) : (
        <button
          type="button"
          className={`btn btn-xs ${isDanger ? 'btn-primary' : 'btn-secondary'}`}
          disabled={connecting || !registration}
          onClick={onConnect}
        >
          <Icon name="refresh" size={12} className={connecting ? 'is-spinning' : ''} />
          {connecting
            ? t('header.hostConnecting')
            : host.connection === 'disconnected'
              ? t('header.hostReconnect')
              : t('header.hostConnect')}
        </button>
      )}
    </section>
  );
}
