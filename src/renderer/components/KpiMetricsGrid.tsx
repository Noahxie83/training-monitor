import React from 'react';
import type { TaskSnapshot } from '../../shared/contracts';
import {
  formatBytes,
  formatEta,
  formatNumber,
  formatRate,
  formatScalarValue,
  formatTimeOnly,
  formatTimestamp,
} from '../utils/format';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

export function KpiMetricsGrid({ task }: { task: TaskSnapshot }) {
  const { locale, t } = useI18n();
  const { progress, checkpoint } = task;
  const stale = progress.freshness === 'stale';
  const eta = progress.etaSeconds;

  const stepVal = progress.current ?? progress.lastStepIndex;
  const scalars = progress.scalars ?? {};
  const lossKey = Object.keys(scalars).find((k) => /^(loss|train_loss|total_loss)$/i.test(k));
  const lrKey = Object.keys(scalars).find((k) => /^(lr|learning_rate)$/i.test(k));
  const lossVal = lossKey ? scalars[lossKey] : undefined;
  const lrVal = lrKey ? scalars[lrKey] : undefined;

  const ckptName = checkpoint.name || checkpoint.path?.split(/[/\\]/).filter(Boolean).pop() || null;

  return (
    <div className="training-facts" role="region" aria-label={t('progress.kpiAria')}>
      <dl className="execution-facts">
        <div className="kpi-cell">
          <dt>{t('progress.kpiStep')}</dt>
          <dd className="tabular-num">
            {stepVal === null || stepVal === undefined ? t('app.unknown') : formatNumber(stepVal)}
            {stale && <small className="text-warning">{t('app.stale')}</small>}
          </dd>
        </div>

        <div className="kpi-cell">
          <dt>{t('progress.kpiLoss')}</dt>
          <dd className="tabular-num">
            {lossVal !== undefined ? formatScalarValue('loss', lossVal) : t('app.none')}
          </dd>
          {lrVal !== undefined && (
            <span className="kpi-sub">LR {formatScalarValue('lr', lrVal)}</span>
          )}
        </div>

        <div className="kpi-cell">
          <dt>{t('progress.kpiRate')}</dt>
          <dd className="tabular-num">
            {stale ? (
              <span className="text-warning" style={{ fontSize: 13 }}>{t('app.stale')}</span>
            ) : progress.iterationsPerSecond === null ? (
              t('app.none')
            ) : (
              <>
                {formatRate(progress.iterationsPerSecond)}
                <small>it/s</small>
              </>
            )}
          </dd>
        </div>

        <div className="kpi-cell">
          <dt>{t('progress.kpiEta')}</dt>
          <dd className="tabular-num">
            {stale ? (
              <span className="text-warning" style={{ fontSize: 13 }}>{t('app.stale')}</span>
            ) : (
              formatEta(eta, locale)
            )}
          </dd>
        </div>
      </dl>

      <div className="checkpoint-row" aria-label={t('progress.checkpointAria')}>
        <Icon name={checkpoint.isDirectory ? 'folder' : 'file'} size={13} className="text-muted" />
        <span className="checkpoint-label">{t('progress.checkpointLabel')}</span>
        {checkpoint.path && ckptName ? (
          <>
            <span className="checkpoint-file" title={checkpoint.path}>
              {ckptName}
            </span>
            {checkpoint.fileStepIndex !== null && (
              <span className="checkpoint-meta-chip" title={t('progress.checkpointStepTitle')}>
                Step {formatNumber(checkpoint.fileStepIndex)}
              </span>
            )}
            {checkpoint.sizeBytes !== null && (
              <span className="checkpoint-meta-chip">{formatBytes(checkpoint.sizeBytes, t('app.unknown'))}</span>
            )}
            {checkpoint.isDirectory && checkpoint.fileCount != null && (
              <span className="checkpoint-meta-chip">
                {t('progress.checkpointFiles', { count: checkpoint.fileCount })}
              </span>
            )}
            <span className="checkpoint-time" title={formatTimestamp(checkpoint.mtime)}>
              {checkpoint.freshness === 'stale' ? t('app.stale') : formatTimeOnly(checkpoint.mtime)}
            </span>
          </>
        ) : (
          <span className="text-muted">{t('progress.checkpointEmpty')}</span>
        )}
      </div>
    </div>
  );
}
