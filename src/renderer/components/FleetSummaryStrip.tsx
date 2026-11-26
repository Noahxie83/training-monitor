import React, { useMemo } from 'react';
import type { GpuDeviceDetail, HostSystemHealth, ResourceMetric } from '../../shared/contracts';
import { formatBytes, getLoadTier } from '../utils/format';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

export interface NormalizedGpuCardData {
  deviceId: string;
  name: string | null;
  utilPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memRatioPct: number | null;
  tempC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
  activeProcesses: NonNullable<GpuDeviceDetail['activeProcesses']>;
  stale: boolean;
  isIdle: boolean;
}

export function buildNormalizedGpuCards(
  resources: ResourceMetric[],
  devices?: GpuDeviceDetail[],
): NormalizedGpuCardData[] {
  const deviceIds = new Set<string>();
  for (const d of devices ?? []) deviceIds.add(d.deviceId);
  for (const m of resources) {
    if (m.scope === 'device' && m.deviceId) deviceIds.add(m.deviceId);
  }

  const orderedIds = [...deviceIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return orderedIds.map((deviceId) => {
    const detail = devices?.find((d) => d.deviceId === deviceId);
    const samples = resources.filter((m) => m.scope === 'device' && m.deviceId === deviceId);
    const utilMetric = samples.find((m) => m.name === 'gpu_utilization');
    const memUsedMetric = samples.find((m) => m.name === 'gpu_memory_used');
    const memTotalMetric = samples.find((m) => m.name === 'gpu_memory_total');

    const utilPct =
      utilMetric !== undefined
        ? utilMetric.value
        : detail?.utilizationPct !== undefined
          ? detail.utilizationPct
          : null;

    const memUsedBytes =
      memUsedMetric?.value !== null && memUsedMetric?.value !== undefined
        ? memUsedMetric.value
        : detail?.memoryUsedMiB !== null && detail?.memoryUsedMiB !== undefined
          ? detail.memoryUsedMiB * 1024 * 1024
          : null;

    const memTotalBytes =
      memTotalMetric?.value !== null && memTotalMetric?.value !== undefined
        ? memTotalMetric.value
        : detail?.memoryTotalMiB !== null && detail?.memoryTotalMiB !== undefined
          ? detail.memoryTotalMiB * 1024 * 1024
          : null;

    const memRatioPct =
      memUsedBytes !== null && memTotalBytes !== null && memTotalBytes > 0
        ? Math.max(0, Math.min(100, (memUsedBytes / memTotalBytes) * 100))
        : null;

    const stale = [utilMetric, memUsedMetric, memTotalMetric].some((m) => m?.freshness === 'stale');
    const isIdle =
      utilPct !== null &&
      utilPct < 10 &&
      (memUsedBytes === null || memUsedBytes < 1024 * 1024 * 1024 || (memRatioPct !== null && memRatioPct < 10));

    return {
      deviceId,
      name: detail?.name ?? null,
      utilPct,
      memUsedBytes,
      memTotalBytes,
      memRatioPct,
      tempC: detail?.temperatureC ?? null,
      powerDrawW: detail?.powerDrawW ?? null,
      powerLimitW: detail?.powerLimitW ?? null,
      activeProcesses: detail?.activeProcesses ?? [],
      stale,
      isIdle,
    };
  });
}

interface FleetSummaryStripProps {
  cards: NormalizedGpuCardData[];
  system?: HostSystemHealth;
  filter: 'all' | 'idle';
  onFilterChange: (filter: 'all' | 'idle') => void;
}

export function FleetSummaryStrip({
  cards,
  system,
  filter,
  onFilterChange,
}: FleetSummaryStripProps) {
  const { t } = useI18n();

  const summary = useMemo(() => {
    const total = cards.length;
    const idleCount = cards.filter((c) => c.isIdle).length;
    const utils = cards.map((c) => c.utilPct).filter((v): v is number => v !== null && Number.isFinite(v));
    const avgUtil = utils.length > 0 ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null;
    const totalMemUsed = cards.reduce((acc, c) => acc + (c.memUsedBytes ?? 0), 0);
    const totalMemCap = cards.reduce((acc, c) => acc + (c.memTotalBytes ?? 0), 0);
    const vramPct = totalMemCap > 0 ? Math.round((totalMemUsed / totalMemCap) * 100) : null;
    const temps = cards.map((c) => c.tempC).filter((v): v is number => v !== null && Number.isFinite(v));
    const peakTemp = temps.length > 0 ? Math.round(Math.max(...temps)) : null;
    return { total, idleCount, avgUtil, totalMemUsed, totalMemCap, vramPct, peakTemp };
  }, [cards]);

  const cpuPct = system?.cpuUtilizationPct ?? null;
  const ramUsed = system?.memoryUsedBytes ? Number(system.memoryUsedBytes) : null;
  const ramTotal = system?.memoryTotalBytes ? Number(system.memoryTotalBytes) : null;
  const ramPct = ramUsed !== null && ramTotal !== null && ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : null;
  const primaryDisk = system?.disks?.[0] ?? null;
  const diskUsed = primaryDisk ? Number(primaryDisk.usedBytes) : null;
  const diskTotal = primaryDisk ? Number(primaryDisk.totalBytes) : null;
  const diskPct = diskUsed !== null && diskTotal !== null && diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : null;

  const hasSystem = cpuPct !== null || ramPct !== null || diskPct !== null;

  if (cards.length === 0 && !hasSystem) return null;

  const avgTier = getLoadTier(summary.avgUtil);
  const vramTier = getLoadTier(summary.vramPct);

  return (
    <section className="fleet-summary-strip" aria-label={t('resources.deviceGpuTitle')}>
      {cards.length > 0 && (
        <div className="fleet-summary-cards">
          <div className="fleet-kpi-card">
            <div className="fleet-kpi-label">
              <span>{t('hostOverview.fleetIdleGpus')}</span>
              <Icon name="gpu" size={13} />
            </div>
            <div className={`fleet-kpi-value ${summary.idleCount > 0 ? 'is-idle-available' : ''}`}>
              {summary.idleCount} <span className="text-muted" style={{ fontSize: 15 }}>/ {summary.total}</span>
            </div>
            <span className="fleet-kpi-sub">
              {summary.idleCount > 0 ? t('resources.loadIdle') : t('resources.loadCritical')}
            </span>
          </div>

          <div className="fleet-kpi-card">
            <div className="fleet-kpi-label">
              <span>{t('hostOverview.fleetTotalVram')}</span>
              <Icon name="memory" size={13} />
            </div>
            <div className="fleet-kpi-value">
              {summary.vramPct !== null ? `${summary.vramPct}%` : t('app.none')}
            </div>
            <div className={`gpu-meter load-tier-${vramTier}`}>
              <span className="gpu-meter-fill" style={{ width: `${summary.vramPct ?? 0}%` }} />
            </div>
            <span className="fleet-kpi-sub">
              {summary.totalMemCap > 0
                ? (() => {
                    const gib = 1024 ** 3;
                    if (summary.totalMemCap >= gib) {
                      const usedGiB = summary.totalMemUsed / gib;
                      const totalGiB = summary.totalMemCap / gib;
                      const totalStr = Number.isInteger(totalGiB) ? String(totalGiB) : totalGiB.toFixed(1);
                      return `${usedGiB.toFixed(1)} / ${totalStr} GiB`;
                    }
                    return `${formatBytes(summary.totalMemUsed, '—')} / ${formatBytes(summary.totalMemCap, '—')}`;
                  })()
                : t('app.none')}
            </span>
          </div>

          <div className="fleet-kpi-card">
            <div className="fleet-kpi-label">
              <span>{t('hostOverview.fleetAvgUtil')}</span>
              <Icon name="activity" size={13} />
            </div>
            <div className="fleet-kpi-value">
              {summary.avgUtil !== null ? `${summary.avgUtil}%` : t('app.none')}
            </div>
            <div className={`gpu-meter load-tier-${avgTier}`}>
              <span className="gpu-meter-fill" style={{ width: `${summary.avgUtil ?? 0}%` }} />
            </div>
            <span className="fleet-kpi-sub">{summary.total} GPUs</span>
          </div>

          <div className="fleet-kpi-card">
            <div className="fleet-kpi-label">
              <span>{t('hostOverview.fleetPeakTemp')}</span>
              <Icon name="thermometer" size={13} />
            </div>
            <div
              className={`fleet-kpi-value ${
                summary.peakTemp !== null && summary.peakTemp >= 85
                  ? 'is-hot'
                  : summary.peakTemp !== null && summary.peakTemp >= 75
                    ? 'is-warm'
                    : ''
              }`}
            >
              {summary.peakTemp !== null ? `${summary.peakTemp}°C` : t('app.none')}
            </div>
            <span className="fleet-kpi-sub">
              {summary.peakTemp !== null ? 'NVML / SMI' : t('app.none')}
            </span>
          </div>
        </div>
      )}

      {(hasSystem || cards.length > 0) && (
        <div className="fleet-controls-row">
          <div className="host-system-bars">
            {cpuPct !== null && (
              <div className={`host-sys-chip load-tier-${getLoadTier(cpuPct)}`}>
                <Icon name="cpu" size={12} />
                <span>{t('hostOverview.hostCpu')}</span>
                <span className="host-sys-chip-bar">
                  <span className="host-sys-chip-fill" style={{ width: `${Math.min(100, Math.round(cpuPct))}%` }} />
                </span>
                <span className="tabular-num">{Math.round(cpuPct)}%</span>
              </div>
            )}
            {ramPct !== null && ramUsed !== null && ramTotal !== null && (
              <div className={`host-sys-chip load-tier-${getLoadTier(ramPct)}`}>
                <Icon name="memory" size={12} />
                <span>{t('hostOverview.hostRam')}</span>
                <span className="host-sys-chip-bar">
                  <span className="host-sys-chip-fill" style={{ width: `${ramPct}%` }} />
                </span>
                <span className="tabular-num">
                  {formatBytes(ramUsed, '—')} / {formatBytes(ramTotal, '—')}
                </span>
              </div>
            )}
            {diskPct !== null && primaryDisk && diskUsed !== null && diskTotal !== null && (
              <div className={`host-sys-chip load-tier-${getLoadTier(diskPct)}`} title={primaryDisk.path}>
                <Icon name="hardDrive" size={12} />
                <span>{t('hostOverview.hostDisk')}</span>
                <span className="host-sys-chip-bar">
                  <span className="host-sys-chip-fill" style={{ width: `${diskPct}%` }} />
                </span>
                <span className="tabular-num">
                  {formatBytes(diskUsed, '—')} / {formatBytes(diskTotal, '—')}
                </span>
              </div>
            )}
          </div>

          {cards.length > 0 && (
            <div className="segmented-control" role="group" aria-label={t('resources.deviceGpuTitle')}>
              <button
                type="button"
                className={`segmented-btn ${filter === 'all' ? 'is-active' : ''}`}
                aria-pressed={filter === 'all'}
                onClick={() => onFilterChange('all')}
              >
                {t('hostOverview.filterAll', { count: summary.total })}
              </button>
              <button
                type="button"
                className={`segmented-btn ${filter === 'idle' ? 'is-active' : ''}`}
                aria-pressed={filter === 'idle'}
                onClick={() => onFilterChange('idle')}
              >
                {t('hostOverview.filterIdle', { count: summary.idleCount })}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
