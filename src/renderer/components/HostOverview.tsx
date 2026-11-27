import React, { useMemo, useState } from 'react';
import type { HostSnapshot, TaskRegistration, TaskSnapshot } from '../../shared/contracts';
import { useGpuHistory } from '../hooks/useGpuHistory';
import { useI18n } from '../i18n';
import { FleetSummaryStrip, buildNormalizedGpuCards } from './FleetSummaryStrip';
import { GpuDeviceMetrics } from './ResourceMetrics';
import { Icon } from './Icon';

interface HostOverviewProps {
  host: HostSnapshot | null;
  label?: string;
  taskCount: number;
  hostTasks?: TaskSnapshot[];
  taskRegistrations?: TaskRegistration[];
  onSelectTask?: (taskId: string) => void;
  onAddTask?: () => void;
  onDiscoverProcesses?: () => void;
  onOpenSettings?: () => void;
}

export function HostOverview({
  host,
  label,
  taskCount,
  hostTasks = [],
  taskRegistrations = [],
  onSelectTask,
  onAddTask,
  onDiscoverProcesses,
  onOpenSettings,
}: HostOverviewProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<'all' | 'idle'>('all');
  const gpuHistory = useGpuHistory(host);

  const cards = useMemo(
    () => buildNormalizedGpuCards(host?.gpu?.metrics ?? [], host?.gpu?.devices),
    [host?.gpu?.metrics, host?.gpu?.devices],
  );

  const pidToTask = useMemo(() => {
    const map = new Map<number, { taskId: string; label: string }>();
    for (const task of hostTasks) {
      const reg = taskRegistrations.find((r) => r.taskId === task.taskId);
      const entry = { taskId: task.taskId, label: reg?.label || task.taskId };
      if (task.processes.main) map.set(task.processes.main.pid, entry);
      if (task.processes.queue) map.set(task.processes.queue.pid, entry);
      for (const worker of task.processes.workers) map.set(worker.pid, entry);
    }
    return map;
  }, [hostTasks, taskRegistrations]);

  const noGpuCpuOnly =
    host?.connection === 'connected' &&
    (host.acceleratorAvailability === 'none' || host.gpu?.acceleratorAvailability === 'none');

  return (
    <main className="host-overview" aria-label={t('hostOverview.ariaLabel')}>
      <div className="host-overview-heading">
        <div>
          <h2>{label || host?.hostId || t('hostOverview.noHostTitle')}</h2>
          <p>
            {taskCount
              ? t('hostOverview.taskSummary', { count: taskCount })
              : host
                ? t('hostOverview.emptyHostDesc', { hostId: host.hostId })
                : t('hostOverview.noHostDesc')}
          </p>
        </div>

        <div className="host-overview-actions">
          {host && onDiscoverProcesses && (
            <button type="button" className="btn btn-secondary" onClick={onDiscoverProcesses}>
              <Icon name="radar" size={14} />
              <span>{t('hostOverview.scanProcessesBtn')}</span>
            </button>
          )}
          {onAddTask ? (
            <button
              type="button"
              className="btn btn-primary"
              aria-label={taskCount ? t('hostOverview.addTaskAria') : t('cockpit.addFirstTaskAria')}
              onClick={onAddTask}
            >
              <Icon name="plus" size={14} />
              <span>{t('hostOverview.addTaskBtn')}</span>
            </button>
          ) : (
            onOpenSettings && (
              <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                <Icon name="settings" size={14} />
                <span>{t('hostOverview.openSettingsBtn')}</span>
              </button>
            )
          )}
        </div>
      </div>

      {!taskCount && (
        <section className="host-empty-onboarding" aria-label={t('hostOverview.emptyCardTitle')}>
          <div className="host-empty-onboarding-copy">
            <h3>{t('hostOverview.emptyCardTitle')}</h3>
            <p>{host ? t('hostOverview.emptyCardHint') : t('hostOverview.noHostDesc')}</p>
          </div>
          <div className="host-empty-onboarding-actions">
            {host && onDiscoverProcesses && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onDiscoverProcesses}>
                <Icon name="radar" size={13} />
                <span>{t('hostOverview.scanProcessesBtn')}</span>
              </button>
            )}
            {onAddTask && (
              <button type="button" className="btn btn-primary btn-sm" onClick={onAddTask}>
                <Icon name="plus" size={13} />
                <span>{t('hostOverview.addTaskBtn')}</span>
              </button>
            )}
          </div>
        </section>
      )}

      {host && (
        <FleetSummaryStrip
          cards={cards}
          system={host.system}
          filter={filter}
          onFilterChange={setFilter}
        />
      )}

      {noGpuCpuOnly ? (
        <div className="empty-state-card" style={{ alignSelf: 'center', marginTop: 12 }}>
          <div className="empty-icon">
            <Icon name="cpu" size={22} />
          </div>
          <h3 className="empty-title">{t('hostOverview.noGpuDetected')}</h3>
          <p className="empty-text">{t('hostOverview.noGpuCpuOnlyDesc')}</p>
        </div>
      ) : (
        <GpuDeviceMetrics
          resources={host?.gpu?.metrics ?? []}
          devices={host?.gpu?.devices}
          gpuHistory={gpuHistory}
          idleOnly={filter === 'idle'}
          pidToTask={pidToTask}
          onSelectTask={onSelectTask}
        />
      )}
    </main>
  );
}
