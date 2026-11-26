import React from 'react';
import type { ProgressUnit, TaskSnapshot } from '../../shared/contracts';
import { formatNumber, formatPercent, formatTimeOnly } from '../utils/format';
import { useI18n } from '../i18n';

interface DualProgressBarProps {
  task: TaskSnapshot;
  algorithm?: string;
}

function unitSuffix(unit: ProgressUnit | undefined, t: (k: string) => string): string {
  switch (unit) {
    case 'epoch':
      return t('progress.unitEpoch');
    case 'token':
      return t('progress.unitToken');
    case 'sample':
      return t('progress.unitSample');
    case 'step':
      return t('progress.unitStep');
    default:
      return '';
  }
}

export function DualProgressBar({ task }: DualProgressBarProps) {
  const { t } = useI18n();
  const { progress } = task;

  const globalCompleted = progress.global.completedCount;
  const globalTarget = progress.global.targetCount;
  const globalFraction = progress.global.fraction;
  const globalPercentWidth =
    globalFraction !== null ? Math.min(100, Math.max(0, Math.round(globalFraction * 1000) / 10)) : 0;

  const sessionView = progress.resumedSession ?? progress.session;
  const sessionCompleted = sessionView.completedCount;
  const sessionTarget = sessionView.targetCount;
  const sessionFraction = sessionView.fraction;
  const sessionPercentWidth =
    sessionFraction !== null ? Math.min(100, Math.max(0, Math.round(sessionFraction * 1000) / 10)) : 0;

  // Show dual track ONLY when resumed-session offset evidence exists
  const hasResumeEvidence =
    progress.resumeCheckpointIndex !== null ||
    progress.baselineEvidenceId !== null ||
    progress.resumedSession != null ||
    (sessionCompleted !== null &&
      globalCompleted !== null &&
      (sessionCompleted !== globalCompleted || sessionTarget !== globalTarget));

  const primaryTrack =
    globalCompleted !== null || globalTarget !== null || hasResumeEvidence ? progress.global : sessionView;
  const primaryCompleted = primaryTrack.completedCount;
  const primaryTarget = primaryTrack.targetCount;
  const primaryFraction = primaryTrack.fraction;
  const primaryWidth =
    primaryFraction !== null ? Math.min(100, Math.max(0, Math.round(primaryFraction * 1000) / 10)) : 0;
  const primaryUnit = unitSuffix(progress.unit ?? primaryTrack.unit, t);

  const freshnessMeta = progress.observedAt
    ? progress.freshness === 'stale'
      ? t('progress.lastRecordedAt', { time: formatTimeOnly(progress.observedAt) })
      : t('progress.updatedAt', { time: formatTimeOnly(progress.observedAt) })
    : t('progress.pending');

  return (
    <section className="dual-progress-panel" aria-label={t('progress.ariaLabel')}>
      <div className="section-heading">
        <h3>{t('progress.title')}</h3>
        <span className="section-heading-meta tabular-num">{freshnessMeta}</span>
      </div>

      {/* Track 1: Overall Progress */}
      <div className="progress-track-block">
        <div className="progress-track-header">
          <span className="track-title">
            {t('progress.globalTrack')}
            {primaryUnit ? ` · ${primaryUnit}` : ''}
          </span>
          <span className="track-values">
            {primaryCompleted !== null && primaryTarget !== null ? (
              <>
                <strong className="tabular-num">
                  {formatNumber(primaryCompleted)} / {formatNumber(primaryTarget)}
                </strong>
                <span className="track-percent tabular-num">({formatPercent(primaryFraction)})</span>
              </>
            ) : primaryFraction !== null ? (
              <strong className="tabular-num">{formatPercent(primaryFraction)}</strong>
            ) : (
              <span className="text-muted">{t('progress.unknownPair')}</span>
            )}
          </span>
        </div>
        <div
          className="progress-bar-rail"
          role="progressbar"
          aria-label={t('progress.globalAria')}
          aria-valuenow={primaryFraction !== null ? Math.round(primaryFraction * 100) : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`progress-bar-fill progress-fill-global ${primaryFraction === null ? 'fill-empty' : ''}`}
            style={{ width: `${hasResumeEvidence ? globalPercentWidth : primaryWidth}%` }}
          />
        </div>
      </div>

      {/* Track 2: Resumed Session — rendered ONLY when resume offset evidence exists */}
      {hasResumeEvidence && (
        <div className="progress-track-block">
          <div className="progress-track-header">
            <span className="track-title">{t('progress.sessionTrack')}</span>
            <span className="track-values">
              {sessionCompleted !== null && sessionTarget !== null ? (
                <>
                  <strong className="tabular-num">
                    {formatNumber(sessionCompleted)} / {formatNumber(sessionTarget)}
                  </strong>
                  <span className="track-percent tabular-num">({formatPercent(sessionFraction)})</span>
                </>
              ) : (
                <span className="text-muted">{t('progress.unknownPair')}</span>
              )}
            </span>
          </div>
          <div
            className="progress-bar-rail"
            role="progressbar"
            aria-label={t('progress.sessionAria')}
            aria-valuenow={sessionFraction !== null ? Math.round(sessionFraction * 100) : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`progress-bar-fill progress-fill-session ${sessionFraction === null ? 'fill-empty' : ''}`}
              style={{ width: `${sessionPercentWidth}%` }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
