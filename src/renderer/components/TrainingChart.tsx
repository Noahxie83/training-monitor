import React, { useEffect, useMemo, useState } from 'react';
import type { MetricSeriesPoint } from '../../shared/contracts';
import { formatScalarValue, formatTimeOnly } from '../utils/format';
import { useI18n } from '../i18n';

const SERIES_COLORS: Record<string, string> = {
  loss: 'var(--chart-1)',
  train_loss: 'var(--chart-1)',
  eval_loss: 'var(--chart-2)',
  val_loss: 'var(--chart-2)',
  lr: 'var(--chart-3)',
  learning_rate: 'var(--chart-3)',
  iterations_per_second: 'var(--chart-4)',
};

const PREFERRED_ORDER = ['loss', 'train_loss', 'eval_loss', 'val_loss', 'lr', 'learning_rate', 'iterations_per_second'];

function computeEma(points: MetricSeriesPoint[], alpha = 0.25): MetricSeriesPoint[] {
  if (points.length <= 2) return points;
  const out: MetricSeriesPoint[] = [];
  let acc = points[0]!.value;
  for (const pt of points) {
    acc = alpha * pt.value + (1 - alpha) * acc;
    out.push({ ...pt, value: acc });
  }
  return out;
}

interface TrainingChartProps {
  taskId: string;
  refreshTick?: string | null;
  onHasDataChange?: (hasData: boolean) => void;
}

export function TrainingChart({ taskId, refreshTick, onHasDataChange }: TrainingChartProps) {
  const { t } = useI18n();
  const [seriesMap, setSeriesMap] = useState<Record<string, MetricSeriesPoint[]>>({});
  const [loading, setLoading] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState<string>('');
  const [smoothed, setSmoothed] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const getter = window.monitor?.getMetricSeries;
    if (!getter) {
      setSeriesMap({});
      onHasDataChange?.(false);
      return;
    }
    setLoading(true);
    getter({ taskId, rangeMs: 6 * 60 * 60 * 1000, maxPoints: 240 })
      .then((res) => {
        if (!active) return;
        const cleaned: Record<string, MetricSeriesPoint[]> = {};
        for (const [key, pts] of Object.entries(res.series ?? {})) {
          if (Array.isArray(pts) && pts.length > 0) cleaned[key] = pts;
        }
        setSeriesMap(cleaned);
        onHasDataChange?.(Object.keys(cleaned).length > 0);
      })
      .catch(() => {
        if (active) {
          setSeriesMap({});
          onHasDataChange?.(false);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [taskId, refreshTick, onHasDataChange]);

  const metricKeys = useMemo(() => {
    const keys = Object.keys(seriesMap);
    keys.sort((a, b) => {
      const ia = PREFERRED_ORDER.indexOf(a);
      const ib = PREFERRED_ORDER.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
    return keys;
  }, [seriesMap]);

  const activeKey = metricKeys.includes(selectedMetric) ? selectedMetric : (metricKeys[0] ?? '');
  const rawPoints = activeKey ? (seriesMap[activeKey] ?? []) : [];
  const plotPoints = useMemo(() => (smoothed ? computeEma(rawPoints) : rawPoints), [rawPoints, smoothed]);
  const color = SERIES_COLORS[activeKey] ?? 'var(--chart-1)';

  const labelForMetric = (key: string) => {
    if (key === 'loss' || key === 'train_loss') return t('chart.metricLoss');
    if (key === 'eval_loss' || key === 'val_loss') return t('chart.metricEvalLoss');
    if (key === 'lr' || key === 'learning_rate') return t('chart.metricLr');
    if (key === 'iterations_per_second') return t('chart.metricThroughput');
    return key;
  };

  const W = 400;
  const H = 100;
  const padL = 4;
  const padR = 4;
  const padT = 8;
  const padB = 8;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const geometry = useMemo(() => {
    if (rawPoints.length < 2) return null;
    const vals = rawPoints.map((p) => p.value);
    let minV = Math.min(...vals);
    let maxV = Math.max(...vals);
    if (minV === maxV) {
      const delta = Math.abs(minV) * 0.1 || 1;
      minV -= delta;
      maxV += delta;
    } else {
      const pad = (maxV - minV) * 0.08;
      minV -= pad;
      maxV += pad;
    }
    const xOf = (idx: number) => padL + (idx / Math.max(1, rawPoints.length - 1)) * plotW;
    const yOf = (val: number) => padT + (1 - (val - minV) / (maxV - minV)) * plotH;
    const toPath = (pts: MetricSeriesPoint[]) =>
      pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${xOf(idx).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(' ');
    const areaPath =
      toPath(plotPoints) +
      ` L${xOf(plotPoints.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${xOf(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
    return {
      minV,
      maxV,
      midV: (minV + maxV) / 2,
      rawPath: toPath(rawPoints),
      smoothPath: toPath(plotPoints),
      areaPath,
      xOf,
      yOf,
    };
  }, [rawPoints, plotPoints, plotW, plotH]);

  const hoveredPoint = hoverIdx !== null && plotPoints[hoverIdx] ? plotPoints[hoverIdx] : null;
  const hoveredRaw = hoverIdx !== null && rawPoints[hoverIdx] ? rawPoints[hoverIdx] : null;

  return (
    <div className="training-chart-wrap" role="region" aria-label={t('chart.title')}>
      <div className="chart-controls-bar">
        <div className="chart-metric-chips">
          {metricKeys.map((key) => (
            <button
              key={key}
              type="button"
              className={`chart-metric-chip ${key === activeKey ? 'is-active' : ''}`}
              aria-pressed={key === activeKey}
              onClick={() => {
                setSelectedMetric(key);
                setHoverIdx(null);
              }}
            >
              <span className="chart-swatch" style={{ backgroundColor: SERIES_COLORS[key] ?? 'var(--chart-1)' }} />
              <span>{labelForMetric(key)}</span>
            </button>
          ))}
        </div>

        {rawPoints.length >= 2 && (
          <button
            type="button"
            className={`chart-metric-chip ${smoothed ? 'is-active' : ''}`}
            aria-pressed={smoothed}
            onClick={() => setSmoothed((v) => !v)}
          >
            {t('chart.smooth')}
          </button>
        )}
      </div>

      <div className="chart-svg-box">
        {geometry ? (
          <div className="chart-plot-layout">
            <div className="chart-y-axis" aria-hidden="true">
              <span>{formatScalarValue(activeKey, geometry.maxV)}</span>
              <span>{formatScalarValue(activeKey, geometry.midV)}</span>
              <span>{formatScalarValue(activeKey, geometry.minV)}</span>
            </div>
            <div className="chart-canvas-col">
              <div className="chart-svg-stage">
                <svg
                  className="chart-svg"
                  viewBox={`0 0 ${W} ${H}`}
                  preserveAspectRatio="none"
                  onMouseLeave={() => setHoverIdx(null)}
                  onMouseMove={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const relX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * W;
                    const ratio = Math.max(0, Math.min(1, (relX - padL) / plotW));
                    const idx = Math.round(ratio * (rawPoints.length - 1));
                    setHoverIdx(idx);
                  }}
                >
                  {/* Subtle horizontal gridlines */}
                  {[0, 0.5, 1].map((frac, i) => {
                    const y = padT + frac * plotH;
                    return (
                      <line
                        key={i}
                        x1={padL}
                        x2={W - padR}
                        y1={y}
                        y2={y}
                        stroke="var(--chart-grid)"
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}

                  {/* Area fill */}
                  <path d={geometry.areaPath} fill={color} fillOpacity="0.1" />

                  {/* Faint raw line when smoothed */}
                  {smoothed && (
                    <path
                      d={geometry.rawPath}
                      fill="none"
                      stroke={color}
                      strokeOpacity="0.28"
                      strokeWidth="1.2"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}

                  {/* Primary line */}
                  <path
                    className="chart-line"
                    d={geometry.smoothPath}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />

                  {/* Interactive crosshair */}
                  {hoverIdx !== null && hoveredPoint && (
                    <line
                      x1={geometry.xOf(hoverIdx)}
                      x2={geometry.xOf(hoverIdx)}
                      y1={padT}
                      y2={padT + plotH}
                      stroke="var(--border-strong)"
                      strokeDasharray="3 3"
                      strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </svg>
                {hoveredRaw && (
                  <div className="chart-tooltip">
                    {hoveredRaw.step != null
                      ? `${t('chart.stepPrefix')}${hoveredRaw.step} · `
                      : `${formatTimeOnly(hoveredRaw.observedAt)} · `}
                    <strong>{formatScalarValue(activeKey, hoveredRaw.value)}</strong>
                  </div>
                )}
              </div>
              <div className="chart-x-axis" aria-hidden="true">
                <span>
                  {rawPoints[0]?.step != null
                    ? `${t('chart.stepPrefix')}${rawPoints[0].step}`
                    : formatTimeOnly(rawPoints[0]?.observedAt ?? null)}
                </span>
                <span>
                  {rawPoints[rawPoints.length - 1]?.step != null
                    ? `${t('chart.stepPrefix')}${rawPoints[rawPoints.length - 1]!.step}`
                    : formatTimeOnly(rawPoints[rawPoints.length - 1]?.observedAt ?? null)}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="chart-empty">
            {loading ? t('chart.loading') : t('chart.empty')}
          </div>
        )}
      </div>
    </div>
  );
}
