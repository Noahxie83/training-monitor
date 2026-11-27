import React from 'react';
import type {
  GpuDeviceDetail,
  GpuSeriesPoint,
  ProcessKey,
  ResourceMetric,
  TaskSnapshot,
} from '../../shared/contracts';
import { formatBytes, formatMiBAsGiB, formatTimeOnly, getLoadTier } from '../utils/format';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { Sparkline } from './Sparkline';
import { buildNormalizedGpuCards } from './FleetSummaryStrip';

function sameProcess(a: ProcessKey | null, b: ProcessKey | null) {
  return Boolean(a && b && a.hostBootId === b.hostBootId && a.pid === b.pid && a.startTicks === b.startTicks);
}

function Metric({
  label,
  metric,
  valuePrefix = '',
  valueSuffix = '',
}: {
  label: string;
  metric?: ResourceMetric;
  valuePrefix?: string;
  valueSuffix?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="kpi-detail-row" data-resource-source={metric?.source}>
      <span className="kpi-detail-label">{label}:</span>
      <span className="kpi-detail-val tabular-num">
        <span>
          {valuePrefix}
          {metric?.value === null || metric?.value === undefined
            ? t('app.unobserved')
            : metric.unit === 'bytes'
              ? formatBytes(metric.value, t('app.unknown'))
              : `${metric.value}%`}
          {valueSuffix}
        </span>
        {metric?.freshness === 'stale' && <span className="text-warning">{t('app.staleParen')}</span>}
      </span>
    </div>
  );
}

/** Resource samples carry independent stamps; process instance time is never a sampling time. */
export function ResourceMetrics({ task }: { task: TaskSnapshot }) {
  const { t } = useI18n();
  const { processes, resources } = task;
  const members = [
    {
      process: processes.main,
      label: t('resources.mainProcessLabel'),
      rss: t('resources.mainProcessRssLabel'),
      cpu: t('resources.cpuLabel'),
    },
    {
      process: processes.queue,
      label: t('resources.queueProcessLabel'),
      rss: `${t('resources.queueProcessLabel')} ${t('resources.rssLabel')}`,
      cpu: `${t('resources.queueProcessLabel')} ${t('resources.cpuLabel')}`,
    },
    ...processes.workers.map((process) => ({
      process,
      label: t('resources.workerLabel', { pid: process.pid }),
      rss: `${t('resources.workerLabel', { pid: process.pid })} ${t('resources.rssLabel')}`,
      cpu: `${t('resources.workerLabel', { pid: process.pid })} ${t('resources.cpuLabel')}`,
    })),
  ];

  const hasAnyProcess = members.some((m) => m.process);

  return (
    <>
      <TaskGpuMetrics task={task} />
      <details className="process-resource-section">
        <summary>
          <span>{t('resources.processSectionTitle')}</span>
          {hasAnyProcess ? (
            <span className="text-muted tabular-num">
              PID {processes.main?.pid ?? '—'}
              {processes.workers.length > 0 ? ` · ${t('resources.workersValue', { count: processes.workers.length })}` : ''}
            </span>
          ) : (
            <span className="text-muted">{t('resources.noProcessData')}</span>
          )}
        </summary>
        {hasAnyProcess && (
          <>
            <div className="kpi-detail-row">
              <span className="kpi-detail-label">{t('resources.mainPid')}:</span>
              <span className="kpi-detail-val tabular-num">{processes.main?.pid ?? t('app.unobserved')}</span>
            </div>
            <div className="kpi-detail-row">
              <span className="kpi-detail-label">{t('resources.workersCount')}:</span>
              <span className="kpi-detail-val tabular-num">
                {processes.workers.length
                  ? t('resources.workersValue', { count: processes.workers.length })
                  : t('app.unobserved')}
              </span>
            </div>
            {members
              .filter(
                (m) =>
                  m.process &&
                  (m.process.role !== 'worker' ||
                    resources.some((sample) => sample.scope === 'process' && sameProcess(sample.processKey, m.process?.key ?? null))),
              )
              .map(({ process, label, rss, cpu }) => {
                const samples = resources.filter(
                  (m) => m.scope === 'process' && sameProcess(m.processKey, process?.key ?? null),
                );
                return (
                  <div key={label} className="kpi-process-group" aria-label={t('resources.processGroupAria', { label })}>
                    <Metric label={rss} metric={samples.find((m) => m.name === 'process_rss')} />
                    <Metric label={cpu} metric={samples.find((m) => m.name === 'cpu_utilization')} />
                  </div>
                );
              })}
          </>
        )}
      </details>
    </>
  );
}

export function TaskGpuMetrics({ task }: { task: TaskSnapshot }) {
  const { t } = useI18n();
  const usage = task.gpuUsage;
  const keys =
    usage?.processKeys ??
    [task.processes.main?.key, ...task.processes.workers.map((process) => process.key)].filter(
      (key): key is ProcessKey => !!key,
    );
  const metrics = task.resources.filter(
    (metric) =>
      metric.scope === 'process' &&
      metric.deviceId &&
      (metric.name === 'gpu_utilization' || metric.name === 'gpu_memory_used') &&
      keys.some((key) => sameProcess(key, metric.processKey)),
  );
  const devices = [...new Set(metrics.map((metric) => metric.deviceId!))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const stale =
    usage?.freshness === 'stale' ||
    task.freshness === 'stale' ||
    metrics.some((metric) => metric.freshness === 'stale');
  const empty =
    usage?.errorCode === 'WSL_PROCESS_GPU_UNAVAILABLE'
      ? t('resources.emptyWslUnsupported')
      : usage?.state === 'available' && usage.processKeys.length
        ? t('resources.emptyNoGpuUsed')
        : !task.processes.main && !usage?.processKeys.length
          ? t('resources.emptyWaitingProcess')
          : t('resources.emptyUnavailable');

  return (
    <section className="task-gpu-section" aria-label={t('resources.taskGpuAria')}>
      <div className="section-heading">
        <h3>
          {devices.length
            ? t('resources.taskGpuCount', { count: devices.length })
            : t('resources.taskGpuTitle')}
        </h3>
        <span className="section-heading-meta">{t('resources.taskGpuSubtitle')}</span>
      </div>
      <div className="task-gpu-list">
        {devices.length ? (
          devices.map((device) => {
            const samples = metrics.filter((metric) => metric.deviceId === device);
            const processes = keys.filter(
              (key, index) =>
                keys.findIndex((other) => sameProcess(key, other)) === index &&
                samples.some((metric) => sameProcess(metric.processKey, key)),
            );
            return (
              <div key={device} className="task-gpu-device" aria-label={t('resources.deviceProcessAria', { device })}>
                <div className="gpu-device-heading">
                  <strong className="mono">{device}</strong>
                  <span className={`task-gpu-badge ${stale ? 'pill-warning' : 'pill-running'}`}>
                    {stale ? t('resources.taskGpuPrevious') : t('resources.taskGpuOwned')}
                  </span>
                </div>
                {processes.map((key) => {
                  const utilization = samples.find(
                    (metric) => metric.name === 'gpu_utilization' && sameProcess(metric.processKey, key),
                  );
                  const memory = samples.find(
                    (metric) => metric.name === 'gpu_memory_used' && sameProcess(metric.processKey, key),
                  );
                  const tier = getLoadTier(utilization?.value ?? null);
                  return (
                    <div key={`${key.hostBootId}:${key.pid}:${key.startTicks}`} className="task-gpu-process">
                      <div className="gpu-memory-row">
                        <span className="mono">PID {key.pid}</span>
                        <span className="tabular-num">
                          {utilization?.value === null || utilization?.value === undefined
                            ? t('resources.utilUnavailable')
                            : `${utilization.value}%`}
                        </span>
                      </div>
                      <div
                        className={`gpu-meter load-tier-${tier}`}
                        role="meter"
                        aria-label={t('resources.processUtilMeterAria', { device, pid: key.pid })}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={utilization?.value ?? undefined}
                      >
                        <span className="gpu-meter-fill" style={{ width: `${utilization?.value ?? 0}%` }} />
                      </div>
                      <div className="gpu-memory-row">
                        <span>{t('resources.processMemoryLabel')}</span>
                        <span className="tabular-num">
                          {memory?.value === null || memory?.value === undefined
                            ? t('resources.memUnavailable')
                            : formatBytes(memory.value, t('app.unknown'))}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {stale && <span className="gpu-stale">{t('app.stale')}</span>}
              </div>
            );
          })
        ) : (
          <div className="task-gpu-empty">{empty}</div>
        )}
      </div>
      {usage?.observedAt && (
        <p className="task-gpu-updated">{t('resources.sampledAt', { time: formatTimeOnly(usage.observedAt) })}</p>
      )}
    </section>
  );
}

interface GpuDeviceMetricsProps {
  resources: ResourceMetric[];
  devices?: GpuDeviceDetail[];
  gpuHistory?: Record<string, GpuSeriesPoint[]>;
  idleOnly?: boolean;
  pidToTask?: Map<number, { taskId: string; label: string }>;
  onSelectTask?: (taskId: string) => void;
}

export function GpuDeviceMetrics({
  resources,
  devices,
  gpuHistory = {},
  idleOnly = false,
  pidToTask,
  onSelectTask,
}: GpuDeviceMetricsProps) {
  const { t } = useI18n();
  const allCards = buildNormalizedGpuCards(resources, devices);
  const visibleCards = idleOnly ? allCards.filter((c) => c.isIdle) : allCards;

  const tierLabel = (tier: ReturnType<typeof getLoadTier>) => {
    if (tier === 'idle') return t('resources.loadIdle');
    if (tier === 'active') return t('resources.loadActive');
    if (tier === 'high') return t('resources.loadHigh');
    if (tier === 'critical') return t('resources.loadCritical');
    return t('app.unobserved');
  };

  return (
    <section className="gpu-resource-section">
      <div className="section-heading">
        <h3>
          {allCards.length
            ? t('resources.deviceGpuCount', { count: allCards.length })
            : t('resources.deviceGpuTitle')}
        </h3>
        <span className="section-heading-meta">{t('resources.deviceGpuSubtitle')}</span>
      </div>

      {visibleCards.length > 0 ? (
        <div className="gpu-device-list">
          {visibleCards.map((card) => {
            const utilTier = getLoadTier(card.utilPct);
            const memTier = getLoadTier(card.memRatioPct);
            const sparkPoints = gpuHistory[card.deviceId] ?? [];
            const memPctText = card.memRatioPct !== null ? ` · ${Math.round(card.memRatioPct)}%` : '';

            return (
              <article
                key={card.deviceId}
                className={`gpu-device-card load-tier-${utilTier}`}
                aria-label={t('resources.deviceWholeAria', { device: card.deviceId })}
              >
                <div className="gpu-card-top">
                  <div className="gpu-card-ident">
                    <span className="gpu-card-id">{card.deviceId}</span>
                    {card.name && (
                      <span className="gpu-card-model" title={card.name}>
                        {card.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '')}
                      </span>
                    )}
                  </div>
                  <div className="gpu-card-top-right">
                    <span className={`gpu-load-pill load-tier-${utilTier}`}>{tierLabel(utilTier)}</span>
                  </div>
                </div>

                {(card.tempC !== null || card.powerDrawW !== null) && (
                  <div className="gpu-card-env-meta">
                    {card.tempC !== null && (
                      <span className="gpu-card-env-item">
                        <Icon name="thermometer" size={11} />
                        {Math.round(card.tempC)}°C
                      </span>
                    )}
                    {card.powerDrawW !== null && (
                      <span className="gpu-card-env-item">
                        <Icon name="zap" size={11} />
                        {Math.round(card.powerDrawW)}W
                        {card.powerLimitW !== null ? ` / ${Math.round(card.powerLimitW)}W` : ''}
                      </span>
                    )}
                  </div>
                )}

                <div className="gpu-card-body">
                  <div className="gpu-device-heading">
                    <span className="text-muted" style={{ fontSize: 11.5 }}>
                      GPU
                    </span>
                    <span className="gpu-util-readout">
                      {card.utilPct === null ? t('app.unobserved') : `${Math.round(card.utilPct)}%`}
                    </span>
                  </div>
                  <div
                    className={`gpu-meter load-tier-${utilTier}`}
                    role="meter"
                    aria-label={t('resources.utilMeterAria', { device: card.deviceId })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={card.utilPct ?? undefined}
                  >
                    <span className="gpu-meter-fill" style={{ width: `${card.utilPct ?? 0}%` }} />
                  </div>

                  <div className="gpu-memory-row">
                    <span>{t('resources.deviceMemoryLabel')}</span>
                    <span className="gpu-memory-readout">
                      <span>
                        {card.memUsedBytes === null ? t('app.unobserved') : formatBytes(card.memUsedBytes, t('app.unknown'))}
                        {' / '}
                        {card.memTotalBytes === null ? t('app.unobserved') : formatBytes(card.memTotalBytes, t('app.unknown'))}
                      </span>
                      {memPctText && <span className="text-muted">{memPctText}</span>}
                    </span>
                  </div>
                  <div
                    className={`gpu-meter gpu-memory-meter load-tier-${memTier}`}
                    role="meter"
                    aria-label={t('resources.memMeterAria', { device: card.deviceId })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={card.memRatioPct !== null ? Math.round(card.memRatioPct) : undefined}
                  >
                    <span className="gpu-meter-fill" style={{ width: `${card.memRatioPct ?? 0}%` }} />
                  </div>
                </div>

                {sparkPoints.length >= 2 && (
                  <Sparkline
                    points={sparkPoints}
                    colorVar={`var(--load-${utilTier})`}
                    ariaLabel={t('resources.sparklineAria', { device: card.deviceId })}
                  />
                )}

                {card.activeProcesses.length > 0 && (
                  <div className="gpu-card-procs" aria-label={t('resources.activeProcesses')}>
                    {card.activeProcesses.slice(0, 3).map((proc) => {
                      const tokens = proc.command.trim().split(/\s+/).filter(Boolean);
                      const scriptToken = tokens.find((tok) => /\.(py|sh|js|mjs|ts)$/i.test(tok));
                      const rawTarget = scriptToken ?? tokens[0] ?? proc.command;
                      const shortCmd = rawTarget.split(/[/\\]/).pop() || rawTarget;
                      const linkedTask = pidToTask?.get(proc.pid);
                      const tagText = `PID ${proc.pid} · ${shortCmd}${proc.memoryMiB != null ? ` · ${formatMiBAsGiB(proc.memoryMiB)}` : ''}`;
                      if (linkedTask && onSelectTask) {
                        return (
                          <button
                            key={proc.pid}
                            type="button"
                            className="gpu-proc-tag is-linked"
                            title={`${t('resources.jumpToTaskTitle', { task: linkedTask.label })}\n${proc.command}`}
                            onClick={() => onSelectTask(linkedTask.taskId)}
                          >
                            <span>{tagText}</span>
                          </button>
                        );
                      }
                      return (
                        <span key={proc.pid} className="gpu-proc-tag" title={proc.command}>
                          {tagText}
                        </span>
                      );
                    })}
                  </div>
                )}

                {card.stale && <span className="gpu-stale">{t('app.staleParen')}</span>}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="text-muted" style={{ fontSize: 12.5 }}>
          {idleOnly && allCards.length > 0 ? t('hostOverview.filterIdleEmpty') : t('resources.deviceGpuEmpty')}
        </div>
      )}
    </section>
  );
}
