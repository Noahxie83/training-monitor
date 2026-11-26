import React, { useCallback, useEffect, useState } from 'react';
import type { DiscoveredProcess } from '../../shared/contracts';
import { formatMiBAsGiB } from '../utils/format';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface ProcessDiscoveryModalProps {
  hostId: string;
  hostLabel?: string;
  onClose: () => void;
  onImport: (proc: DiscoveredProcess) => void;
}

export function ProcessDiscoveryModal({
  hostId,
  hostLabel,
  onClose,
  onImport,
}: ProcessDiscoveryModalProps) {
  const { t } = useI18n();
  const [processes, setProcesses] = useState<DiscoveredProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useFocusTrap(true, onClose);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!window.monitor?.discoverProcesses) {
        setProcesses([]);
        return;
      }
      const list = await window.monitor.discoverProcesses(hostId);
      setProcesses(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  useEffect(() => {
    void scan();
  }, [scan]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal-container"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discovery-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="discovery-modal-title" className="modal-title">
              {t('discovery.title')}
            </h2>
            <p className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
              {t('discovery.subtitle', { hostId: hostLabel || hostId })}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            onClick={onClose}
            aria-label={t('app.close')}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="modal-body">
          {error && (
            <div className="alert alert-danger" role="alert">
              {t('discovery.errorPrefix', { error })}
            </div>
          )}

          {loading ? (
            <div className="empty-state-card" style={{ alignSelf: 'center', width: '100%' }}>
              <Icon name="refresh" size={20} className="is-spinning text-info" />
              <p className="empty-text">{t('discovery.scanning')}</p>
            </div>
          ) : processes.length === 0 ? (
            <div className="empty-state-card" style={{ alignSelf: 'center', width: '100%' }}>
              <div className="empty-icon">
                <Icon name="radar" size={20} />
              </div>
              <p className="empty-text">{t('discovery.empty', { hostId: hostLabel || hostId })}</p>
            </div>
          ) : (
            <div className="discovery-list">
              {processes.map((proc) => (
                <article key={proc.pid} className="discovery-item-card">
                  <div className="discovery-item-head">
                    <div className="discovery-item-title">
                      <strong>{proc.suggestedName}</strong>
                      <span className="platform-badge">PID {proc.pid}</span>
                      {proc.gpuIndices.length > 0 && (
                        <span className="status-pill pill-info mono">
                          {t('discovery.gpusLabel')} {proc.gpuIndices.join(',')}
                        </span>
                      )}
                      {proc.gpuMemoryMiB != null && (
                        <span className="status-pill pill-neutral mono">
                          {t('discovery.vramLabel')} {formatMiBAsGiB(proc.gpuMemoryMiB)}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-xs"
                      onClick={() => onImport(proc)}
                    >
                      <Icon name="plus" size={12} />
                      <span>{t('discovery.importBtn')}</span>
                    </button>
                  </div>

                  <div className="discovery-cmd">{proc.command}</div>

                  <div className="discovery-meta-grid">
                    {proc.cwd && (
                      <span>
                        <strong className="text-muted">{t('discovery.cwdLabel')}: </strong>
                        <span className="mono">{proc.cwd}</span>
                      </span>
                    )}
                    <span>
                      <strong className="text-muted">{t('discovery.logLabel')}: </strong>
                      {proc.openLogPaths.length > 0 ? (
                        <span className="mono">{proc.openLogPaths[0]}</span>
                      ) : (
                        <span className="text-muted">{t('discovery.noLogFound')}</span>
                      )}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => void scan()}
          >
            <Icon name="refresh" size={13} className={loading ? 'is-spinning' : ''} />
            <span>{t('discovery.rescan')}</span>
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('app.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
