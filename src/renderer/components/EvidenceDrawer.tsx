import React, { useState } from 'react';
import type {
  LogSourceSnapshot,
  ProcessInstance,
  ProcessKey,
  TaskSnapshot,
} from '../../shared/contracts';
import { formatBytes, formatNumber, formatTimestamp } from '../utils/format';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface EvidenceDrawerProps {
  task: TaskSnapshot | null;
  sources?: LogSourceSnapshot[];
  isOpen: boolean;
  onClose: () => void;
}

function CopyChip({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      style={{ height: 20, padding: '0 4px' }}
      title={copied ? t('app.copied') : t('app.copy')}
      aria-label={copied ? t('app.copied') : t('app.copy')}
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={11} />
    </button>
  );
}

export function EvidenceDrawer({ task, sources = [], isOpen, onClose }: EvidenceDrawerProps) {
  const { t } = useI18n();
  const containerRef = useFocusTrap(isOpen, onClose);

  if (!isOpen || !task) return null;

  const { processes, queueLock, evidence, statusObservedAt, confidence, reason, checkpoint } = task;
  const mainProcess = processes.main;
  const queueProcess = processes.queue;
  const workerPids = processes.workers.map((w: ProcessInstance) => w.pid).join(', ');
  const cwd = mainProcess?.cwd ?? queueProcess?.cwd ?? null;
  const scriptEntry = mainProcess?.scriptEntry ?? queueProcess?.scriptEntry ?? null;
  const taskSources = sources.filter((s) => s.taskId === task.taskId);

  const formatKey = (key?: ProcessKey | null): string => {
    if (!key) return t('app.unknown');
    return `${key.hostBootId}:${key.pid}:${key.startTicks}`;
  };

  const attribution =
    task.attributionConfidence ??
    (mainProcess ? 'confirmed_process' : processes.workers.length > 0 ? 'inferred_tree' : 'log_only');

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="drawer-content"
        role="dialog"
        aria-modal="true"
        aria-label={t('drawer.ariaLabel')}
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="drawer-header">
          <h2 className="drawer-title">{t('drawer.title')}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            onClick={onClose}
            aria-label={t('drawer.closeAria')}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="drawer-body">
          {/* Attribution & Diagnosis Summary */}
          <section className="drawer-section">
            <h3 className="drawer-section-title">
              <span>{t('drawer.sectionSummary')}</span>
              <span className="confidence-badge is-confirmed">{t(`confidence.${attribution}`)}</span>
            </h3>
            <div className="drawer-kv-table">
              <div className="drawer-field-row">
                <span className="field-label">{t('drawer.attributionLabel')}</span>
                <span className="field-value">{t(`confidence.${attribution}`)}</span>
              </div>
              <div className="drawer-field-row">
                <span className="field-label">{t('drawer.confidenceLabel')}</span>
                <span className="field-value">{t(`confidence.${confidence}`)}</span>
              </div>
              <div className="drawer-field-row">
                <span className="field-label">{t('drawer.observedAtLabel')}</span>
                <span className="field-value tabular-num" title={statusObservedAt ?? ''}>
                  {formatTimestamp(statusObservedAt)}
                </span>
              </div>
              {task.exitCode !== undefined && task.exitCode !== null && (
                <div className="drawer-field-row">
                  <span className="field-label">{t('drawer.exitCodeLabel')}</span>
                  <span className="field-value mono">{task.exitCode}</span>
                </div>
              )}
              <div className="drawer-field-row">
                <span className="field-label">{t('drawer.reasonLabel')}</span>
                <span className="field-value">{reason || t('app.none')}</span>
              </div>
            </div>
          </section>

          {/* Process Tree Details (ResourceMetrics duplication removed!) */}
          <section className="drawer-section">
            <h3 className="drawer-section-title">{t('drawer.sectionProcessTree')}</h3>
            <div className="drawer-kv-table">
              <div className="drawer-field-row">
                <span className="field-label">{t('drawer.mainProcess')}</span>
                <span className="field-value-wrap">
                  <span className="field-value tabular-num">
                    {mainProcess ? `PID ${mainProcess.pid} (${mainProcess.role})` : t('app.unobserved')}
                  </span>
                  {mainProcess && <CopyChip value={String(mainProcess.pid)} />}
                </span>
              </div>

              {mainProcess && (
                <>
                  <div className="drawer-field-row">
                    <span className="field-label">{t('drawer.processKey')}</span>
                    <span className="field-value-wrap">
                      <span className="field-value field-path">{formatKey(mainProcess.key)}</span>
                      {mainProcess.key && <CopyChip value={formatKey(mainProcess.key)} />}
                    </span>
                  </div>
                  <div className="drawer-field-row">
                    <span className="field-label">{t('drawer.parentKey')}</span>
                    <span className="field-value field-path">{formatKey(mainProcess.parentKey)}</span>
                  </div>
                </>
              )}

              {queueProcess && (
                <>
                  <div className="drawer-field-row">
                    <span className="field-label">{t('drawer.queueProcess')}</span>
                    <span className="field-value tabular-num">
                      PID {queueProcess.pid} ({queueProcess.role})
                    </span>
                  </div>
                  <div className="drawer-field-row">
                    <span className="field-label">{t('drawer.processKey')}</span>
                    <span className="field-value field-path">{formatKey(queueProcess.key)}</span>
                  </div>
                </>
              )}

              <div className="drawer-field-row">
                <span className="field-label">{t('resources.workersCount')}</span>
                <span className="field-value tabular-num">
                  {processes.workers.length > 0 ? `${processes.workers.length} (${workerPids})` : t('app.unobserved')}
                </span>
              </div>

              {processes.workers.map((w, idx) => (
                <div key={`${w.pid}-${idx}`} className="drawer-field-row">
                  <span className="field-label">
                    {t('drawer.workerProcess', { index: idx + 1 })} · PID {w.pid}
                  </span>
                  <span className="field-value field-path">{formatKey(w.key)}</span>
                </div>
              ))}

              <div className="drawer-field-row">
                <span className="field-label">{t('drawer.cwd')}</span>
                <span className="field-value-wrap">
                  <span className="field-value field-path">{cwd ?? t('app.unknown')}</span>
                  {cwd && <CopyChip value={cwd} />}
                </span>
              </div>

              <div className="drawer-field-row">
                <span className="field-label">{t('drawer.scriptEntry')}</span>
                <span className="field-value-wrap">
                  <span className="field-value field-path">{scriptEntry ?? t('app.unknown')}</span>
                  {scriptEntry && <CopyChip value={scriptEntry} />}
                </span>
              </div>

              {mainProcess?.command && (
                <div className="drawer-field-row">
                  <span className="field-label">{t('drawer.command')}</span>
                  <span className="field-value-wrap">
                    <span className="field-value field-path">{mainProcess.command}</span>
                    <CopyChip value={mainProcess.command} />
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* Log Cursor & Checkpoint Diagnostics */}
          <section className="drawer-section">
            <h3 className="drawer-section-title">{t('drawer.sectionCursorCheckpoint')}</h3>
            <div className="drawer-kv-table">
              {taskSources.map((src) => (
                <React.Fragment key={src.sourceId}>
                  <div className="drawer-field-row">
                    <span className="field-label">{t('drawer.logSource')}</span>
                    <span className="field-value field-path">{src.sourceId}</span>
                  </div>
                  {src.resolvedPath && (
                    <div className="drawer-field-row">
                      <span className="field-label">{t('drawer.resolvedPath')}</span>
                      <span className="field-value-wrap">
                        <span className="field-value field-path">{src.resolvedPath}</span>
                        <CopyChip value={src.resolvedPath} />
                      </span>
                    </div>
                  )}
                  <div className="drawer-field-row">
                    <span className="field-label">{t('drawer.logOffset')}</span>
                    <span className="field-value tabular-num">
                      {src.committedOffset !== null ? formatBytes(src.committedOffset, '—') : '—'}
                      {' / '}
                      {src.maxObservedOffset !== null ? formatBytes(src.maxObservedOffset, '—') : '—'}
                    </span>
                  </div>
                </React.Fragment>
              ))}

              <div className="drawer-field-row">
                <span className="field-label">{t('drawer.checkpointPath')}</span>
                <span className="field-value-wrap">
                  <span className="field-value field-path">{checkpoint.path ?? t('app.none')}</span>
                  {checkpoint.path && <CopyChip value={checkpoint.path} />}
                </span>
              </div>
              {checkpoint.path && (
                <>
                  <div className="drawer-field-row">
                    <span className="field-label">{t('drawer.checkpointSize')}</span>
                    <span className="field-value tabular-num">
                      {checkpoint.sizeBytes !== null ? formatBytes(checkpoint.sizeBytes, '—') : '—'}
                      {checkpoint.fileStepIndex !== null ? ` · Step ${formatNumber(checkpoint.fileStepIndex)}` : ''}
                      {checkpoint.isDirectory && checkpoint.fileCount != null
                        ? ` · ${t('progress.checkpointFiles', { count: checkpoint.fileCount })}`
                        : ''}
                    </span>
                  </div>
                  <div className="drawer-field-row">
                    <span className="field-label">{t('drawer.checkpointMtime')}</span>
                    <span className="field-value tabular-num">{formatTimestamp(checkpoint.mtime)}</span>
                  </div>
                </>
              )}
            </div>
          </section>

          {/* Queue Lock */}
          {(queueLock.source || queueLock.exists !== null) && (
            <section className="drawer-section">
              <h3 className="drawer-section-title">{t('drawer.sectionQueueLock')}</h3>
              <div className="drawer-kv-table">
                <div className="drawer-field-row">
                  <span className="field-label">{t('drawer.lockExists')}</span>
                  <span className="field-value">
                    {queueLock.exists === null ? t('app.unknown') : queueLock.exists ? t('drawer.yes') : t('drawer.no')}
                  </span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">{t('drawer.lockHeld')}</span>
                  <span className="field-value">
                    {queueLock.heldByRegisteredProcess === null
                      ? t('app.unknown')
                      : queueLock.heldByRegisteredProcess
                        ? t('drawer.yes')
                        : t('drawer.no')}
                  </span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">{t('drawer.lockPath')}</span>
                  <span className="field-value field-path">{queueLock.source ?? t('app.none')}</span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">{t('drawer.lockObserved')}</span>
                  <span className="field-value tabular-num">{formatTimestamp(queueLock.observedAt)}</span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">{t('drawer.lockFreshness')}</span>
                  <span className="field-value">
                    {queueLock.freshness === 'stale'
                      ? t('app.stale')
                      : queueLock.freshness === 'fresh'
                        ? t('drawer.fresh')
                        : t('app.unknown')}
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* Evidence Chain */}
          <section className="drawer-section">
            <h3 className="drawer-section-title">{t('drawer.sectionEvidence')}</h3>
            {evidence.length > 0 ? (
              <div className="evidence-items-list">
                {evidence.map((ev, i) => (
                  <div key={i} className="evidence-item-card">
                    <div className="evidence-item-header">
                      <span className="evidence-kind">{ev.kind}</span>
                      <span className="evidence-time tabular-num" title={ev.observedAt}>
                        {formatTimestamp(ev.observedAt)}
                      </span>
                    </div>
                    <div className="evidence-summary">{ev.summary}</div>
                    {ev.sourceId && (
                      <div className="evidence-source">
                        {t('drawer.evidenceSource', { source: ev.sourceId })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted" style={{ fontSize: 12 }}>
                {t('drawer.noEvidence')}
              </p>
            )}
          </section>
        </div>

        <div className="drawer-footer">
          <button type="button" className="btn btn-secondary w-full" onClick={onClose}>
            {t('drawer.closeBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
