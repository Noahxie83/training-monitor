import React, { useMemo } from 'react';
import type { GpuSeriesPoint } from '../../shared/contracts';

interface SparklineProps {
  points: GpuSeriesPoint[];
  colorVar?: string;
  ariaLabel: string;
}

export function Sparkline({ points, colorVar = 'var(--load-active)', ariaLabel }: SparklineProps) {
  const paths = useMemo(() => {
    if (points.length < 2) return null;
    const w = 200;
    const h = 28;
    const padY = 3;
    const plotH = h - padY * 2;
    const xOf = (i: number) => (i / Math.max(1, points.length - 1)) * w;
    const yOf = (pct: number) => padY + (1 - Math.max(0, Math.min(100, pct)) / 100) * plotH;

    const utilCoords: string[] = [];
    const memCoords: string[] = [];

    points.forEach((pt, idx) => {
      const x = xOf(idx).toFixed(1);
      if (pt.utilPct !== null && Number.isFinite(pt.utilPct)) {
        utilCoords.push(`${utilCoords.length === 0 ? 'M' : 'L'}${x},${yOf(pt.utilPct).toFixed(1)}`);
      }
      if (
        pt.memUsedMiB !== null &&
        pt.memTotalMiB !== null &&
        Number.isFinite(pt.memUsedMiB) &&
        Number.isFinite(pt.memTotalMiB) &&
        pt.memTotalMiB > 0
      ) {
        const memPct = (pt.memUsedMiB / pt.memTotalMiB) * 100;
        memCoords.push(`${memCoords.length === 0 ? 'M' : 'L'}${x},${yOf(memPct).toFixed(1)}`);
      }
    });

    if (utilCoords.length < 2 && memCoords.length < 2) return null;

    const utilPath = utilCoords.join(' ');
    const areaPath =
      utilCoords.length >= 2
        ? `${utilPath} L${w.toFixed(1)},${(h - padY).toFixed(1)} L0,${(h - padY).toFixed(1)} Z`
        : '';

    return {
      utilPath,
      areaPath,
      memPath: memCoords.length >= 2 ? memCoords.join(' ') : '',
    };
  }, [points]);

  if (!paths) return null;

  return (
    <div className="gpu-sparkline-box" role="img" aria-label={ariaLabel}>
      <svg className="gpu-sparkline-svg" viewBox="0 0 200 28" preserveAspectRatio="none">
        {paths.areaPath && <path d={paths.areaPath} fill={colorVar} fillOpacity="0.14" />}
        {paths.memPath && (
          <path
            d={paths.memPath}
            fill="none"
            stroke="var(--text-muted)"
            strokeOpacity="0.7"
            strokeWidth="1.2"
            strokeDasharray="3 2"
          />
        )}
        {paths.utilPath && (
          <path
            d={paths.utilPath}
            fill="none"
            stroke={colorVar}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </div>
  );
}
