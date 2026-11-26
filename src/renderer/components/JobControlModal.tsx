import React, { useState } from 'react';
import type { JobControlAction, JobControlResult } from '../../shared/contracts';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface JobControlModalProps {
  taskId: string;
  taskLabel: string;
  action: JobControlAction;
  pids: number[];
  onClose: () => void;
  onCompleted?: (result: JobControlResult) => void;
}

function generateToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `confirm-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function JobControlModal({
  taskId,
  taskLabel,
  action,
  pids,
  onClose,
  onCompleted,
}: JobControlModalProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useFocusTrap(true, () => {
    if (!busy) onClose();
  });

  const title =
    action === 'kill'
      ? t('jobControl.titleKill')
      : action === 'restart'
        ? t('jobControl.titleRestart')
        : t('jobControl.titleStop');

  const desc =
    action === 'kill'
      ? t('jobControl.descKill', { label: taskLabel })
      : action === 'restart'
        ? t('jobControl.descRestart', { label: taskLabel })
        : t('jobControl.descStop', { label: taskLabel });

  const confirmLabel =
    action === 'kill'
      ? t('jobControl.confirmKill')
      : action === 'restart'
        ? t('jobControl.confirmRestart')
        : t('jobControl.confirmStop');

  const execute = async () => {
    if (busy || !window.monitor?.controlTask) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.monitor.controlTask({
        taskId,
        action,
        confirmToken: generateToken(),
      });
      if (!result.ok) {
        setError(result.message || result.errorCode || 'JOB_CONTROL_FAILED');
      } else {
        onCompleted?.(result);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div
        ref={containerRef}
        className="modal-container confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-control-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="job-control-title" className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            onClick={onClose}
            disabled={busy}
            aria-label={t('app.close')}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="modal-body">
          <p className="text-secondary" style={{ fontSize: 13 }}>
            {desc}
          </p>
          {pids.length > 0 && (
            <div className="drawer-kv-table">
              <div className="drawer-field-row">
                <span className="field-label">{t('jobControl.pidsLabel')}</span>
                <span className="field-value mono">{pids.join(', ')}</span>
              </div>
            </div>
          )}
          {error && (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            {t('app.cancel')}
          </button>
          <button
            type="button"
            className={`btn ${action === 'restart' ? 'btn-primary' : 'btn-danger'}`}
            onClick={() => void execute()}
            disabled={busy}
          >
            {busy ? t('jobControl.executing') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
