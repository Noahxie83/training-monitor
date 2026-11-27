import React from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface ForceLocalReconcileModalProps {
  taskCount: number;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ForceLocalReconcileModal({
  taskCount,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: ForceLocalReconcileModalProps) {
  const { t } = useI18n();
  const containerRef = useFocusTrap(true, () => {
    if (!busy) onCancel();
  });

  return (
    <div
      className="modal-overlay is-nested"
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <div
        ref={containerRef}
        className="modal-container confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="force-local-reconcile-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="force-local-reconcile-title" className="modal-title confirm-modal-title">
            <Icon name="warning" size={16} className="text-warning" />
            <span>{t('reconcile.title')}</span>
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            onClick={onCancel}
            disabled={busy}
            aria-label={t('app.close')}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="modal-body">
          <p className="confirm-modal-copy">{t('reconcile.description', { taskCount })}</p>
          <div className="alert alert-warning" role="note">
            <span>{t('reconcile.note')}</span>
          </div>
          {error && (
            <div className="alert alert-danger" role="alert">
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            {t('app.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? t('reconcile.confirming') : t('reconcile.confirmBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
