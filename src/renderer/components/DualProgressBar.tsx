import React from "react";
import type { TaskSnapshot } from "../../shared/contracts";
import { formatNumber, formatPercent, formatTimeOnly } from "../utils/format";

interface DualProgressBarProps {
  task: TaskSnapshot;
  algorithm?: string;
}

export function DualProgressBar({ task }: DualProgressBarProps) {
  const { progress } = task;

  // Global counts
  const globalCompleted = progress.global.completedCount;
  const globalTarget = progress.global.targetCount;
  const globalFraction = progress.global.fraction;
  const globalPercentWidth =
    globalFraction !== null
      ? Math.min(100, Math.max(0, Math.round(globalFraction * 1000) / 10))
      : 0;

  // Session counts
  const sessionCompleted = progress.session.completedCount;
  const sessionTarget = progress.session.targetCount;
  const sessionFraction = progress.session.fraction;
  const sessionPercentWidth =
    sessionFraction !== null
      ? Math.min(100, Math.max(0, Math.round(sessionFraction * 1000) / 10))
      : 0;

  return (
    <section className="dual-progress-panel" aria-label="双轨进度严格解耦看板">
      <div className="section-heading"><h3>训练进度</h3><span className="text-muted">{progress.observedAt ? `${progress.freshness === 'stale' ? '上次记录 ' : '更新于 '}${formatTimeOnly(progress.observedAt)}` : '待观测'}</span></div>
      {/* Track 1: Global Cumulative */}
      <div className="progress-track-block">
        <div className="progress-track-header">
          <span className="track-title">累计进度</span>
          <span className="track-values">
            {globalCompleted !== null && globalTarget !== null ? (
              <>
                <strong className="tabular-num">
                  {formatNumber(globalCompleted)} / {formatNumber(globalTarget)}
                </strong>{" "}
                <span className="track-percent tabular-num">
                  ({formatPercent(globalFraction)})
                </span>
              </>
            ) : (
              <span className="text-muted">未知 / —</span>
            )}
          </span>
        </div>
        <div
          className="progress-bar-rail"
          role="progressbar"
          aria-label="算法全局累计完成次数"
          aria-valuenow={globalFraction !== null ? Math.round(globalFraction * 100) : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={"progress-bar-fill progress-fill-global " + (globalFraction === null ? "fill-empty" : "")}
            style={{ width: globalPercentWidth + "%" }}
          />
        </div>
      </div>

      {/* Track 2: Current Session */}
      <div className="progress-track-block">
        <div className="progress-track-header">
          <span className="track-title">本轮进度</span>
          <span className="track-values">
            {sessionCompleted !== null && sessionTarget !== null ? (
              <>
                <strong className="tabular-num">
                  {formatNumber(sessionCompleted)} / {formatNumber(sessionTarget)}
                </strong>{" "}
                <span className="track-percent tabular-num">
                  ({formatPercent(sessionFraction)})
                </span>
              </>
            ) : (
              <span className="text-muted">未知 / —</span>
            )}
          </span>
        </div>
        <div
          className="progress-bar-rail"
          role="progressbar"
          aria-label="本段续训实际完成次数"
          aria-valuenow={sessionFraction !== null ? Math.round(sessionFraction * 100) : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={"progress-bar-fill progress-fill-session " + (sessionFraction === null ? "fill-empty" : "")}
            style={{ width: sessionPercentWidth + "%" }}
          />
        </div>
      </div>

    </section>
  );
}
