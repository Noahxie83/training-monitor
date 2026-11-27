import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HostRegistration, HostSnapshot, TaskRegistration, TaskSnapshot } from '../../shared/contracts';
import { formatScalarValue, formatTimestamp } from '../utils/format';
import { getLifecycleBadge } from '../utils/lifecycle';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface TaskFleetTreeProps {
  hosts: HostSnapshot[];
  hostRegistrations?: HostRegistration[];
  tasks: TaskSnapshot[];
  activeTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  registrations?: TaskRegistration[];
  onAddTask?: (hostId?: string) => void;
  onEditTask?: (taskId: string) => void;
  onRemoveTask?: (taskId: string) => void;
  onOpenHostSettings?: () => void;
  isSaving?: boolean;
  activeHostId?: string | null;
  onSelectHost?: (hostId: string) => void;
  onConnectHost?: (hostId: string) => void;
  connectingHostIds?: string[];
  disabledHostIds?: string[];
}

function TaskActions({
  label,
  onEdit,
  onRemove,
  disabled,
}: {
  label: string;
  onEdit: () => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => {
    setPosition(null);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) {
        setPosition(null);
      }
    };
    const scroll = () => setPosition(null);
    document.addEventListener('mousedown', outside);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', scroll);
    };
  }, [position]);

  const open = () => {
    const box = trigger.current!.getBoundingClientRect();
    setPosition({
      top: Math.max(8, Math.min(box.bottom + 4, window.innerHeight - 94)),
      left: Math.max(8, box.right - 144),
    });
  };

  return (
    <div className="fleet-task-actions">
      <button
        ref={trigger}
        type="button"
        className="fleet-icon-button task-menu-trigger"
        aria-label={t('sidebar.taskMenuAria', { label })}
        title={t('sidebar.taskMenuTitle')}
        aria-haspopup="menu"
        aria-expanded={!!position}
        disabled={disabled}
        onClick={() => (position ? close() : open())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            open();
          }
        }}
      >
        <Icon name="more" size={14} />
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={t('sidebar.taskActionsAria', { label })}
            className="fleet-task-menu"
            style={{ position: 'fixed', ...position }}
            onBlur={(event) => {
              if (!menu.current?.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) {
                setPosition(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                close();
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const items = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
                const next = items.indexOf(document.activeElement as HTMLElement) + (event.key === 'ArrowDown' ? 1 : -1);
                items[(next + items.length) % items.length]?.focus();
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onEdit();
              }}
            >
              <Icon name="sliders" size={13} />
              <span>{t('sidebar.editTask')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="task-remove"
              onClick={() => {
                close();
                onRemove();
              }}
            >
              <Icon name="trash" size={13} />
              <span>{t('sidebar.removeTask')}</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

function summarizeTaskMetric(task: TaskSnapshot, enabled: boolean, disabledLabel: string): string {
  if (!enabled) return disabledLabel;
  if (task.progress.global.fraction !== null) {
    return `${Math.round(task.progress.global.fraction * 100)}%`;
  }
  if (task.progress.session.fraction !== null) {
    return `${Math.round(task.progress.session.fraction * 100)}%`;
  }
  const loss = task.progress.scalars?.loss ?? task.progress.scalars?.train_loss;
  if (typeof loss === 'number' && Number.isFinite(loss)) {
    return `loss ${formatScalarValue('loss', loss)}`;
  }
  if (task.progress.global.completedCount !== null) {
    const c = task.progress.global.completedCount;
    return c >= 1000 ? `${Math.round(c / 1000)}k` : String(c);
  }
  if (task.progress.lastStepIndex !== null) {
    const s = task.progress.lastStepIndex;
    return s >= 1000 ? `${Math.round(s / 1000)}k` : `s${s}`;
  }
  return '';
}

export function TaskFleetTree({
  hosts,
  hostRegistrations = [],
  tasks,
  activeTaskId,
  onSelectTask,
  registrations = [],
  onAddTask,
  onEditTask,
  onRemoveTask,
  onOpenHostSettings,
  isSaving = false,
  activeHostId,
  onSelectHost,
  onConnectHost,
  connectingHostIds = [],
  disabledHostIds = [],
}: TaskFleetTreeProps) {
  const { locale, t } = useI18n();
  const hostMap = new Map<string, { host: HostSnapshot; tasks: TaskSnapshot[] }>();

  for (const host of hosts) {
    hostMap.set(host.hostId, { host, tasks: [] });
  }
  for (const task of tasks) {
    const entry = hostMap.get(task.hostId);
    if (entry) {
      entry.tasks.push(task);
    } else {
      hostMap.set(task.hostId, {
        host: {
          version: 1,
          hostId: task.hostId,
          kind: 'ssh',
          connection: 'unobserved',
          lastSuccessAt: null,
          lastProbeDurationMs: null,
          scanComplete: false,
          errorCode: null,
          observedAt: null,
          freshness: 'unobserved',
        },
        tasks: [task],
      });
    }
  }

  let taskGlobalIndex = 0;
  const onlineCount = hosts.filter((h) => h.connection === 'connected').length;
  const runningCount = tasks.filter((item) => item.lifecycle === 'running').length;

  return (
    <nav className="task-fleet-panel" aria-label={t('sidebar.ariaLabel')}>
      <div className="fleet-header">
        <span className="fleet-title">{t('sidebar.title')}</span>
        {onAddTask && (
          <button
            type="button"
            className="fleet-icon-button"
            aria-label={t('sidebar.addTask')}
            title={t('sidebar.addTask')}
            disabled={isSaving}
            onClick={() => onAddTask()}
          >
            <Icon name="plus" size={15} />
          </button>
        )}
      </div>

      <div className="fleet-tree" role="tree">
        {Array.from(hostMap.values()).map(({ host, tasks: hostTasks }) => {
          const isConnected = host.connection === 'connected';
          const isDisconnected = host.connection === 'disconnected';
          const isConnecting = connectingHostIds.includes(host.hostId) || host.connection === 'connecting';
          const isDisabled = disabledHostIds.includes(host.hostId);
          const hostReg = hostRegistrations.find((r) => r.hostId === host.hostId);
          const displayName = hostReg?.label || host.hostId;
          const showSubId = displayName !== host.hostId;

          return (
            <div
              key={host.hostId}
              className="fleet-host-group"
              role="group"
              aria-label={displayName}
            >
              <div className="fleet-host-header">
                <button
                  type="button"
                  className="fleet-host-select"
                  onClick={() => onSelectHost?.(host.hostId)}
                  aria-label={t('sidebar.selectHost', { hostId: host.hostId })}
                  aria-pressed={activeHostId === host.hostId}
                  title={`${displayName} (${host.hostId})`}
                >
                  <span className="platform-badge">{host.kind.toUpperCase()}</span>
                  <strong className="host-name">{displayName}</strong>
                  <span
                    className={`host-status-dot ${
                      isConnected
                        ? 'dot-connected'
                        : isDisconnected
                          ? 'dot-disconnected'
                          : isConnecting
                            ? 'dot-connecting'
                            : 'dot-unobserved'
                    }`}
                    title={host.connection}
                  />
                </button>
                {onAddTask && (
                  <button
                    type="button"
                    className="fleet-icon-button fleet-host-add"
                    aria-label={t('sidebar.addTaskToHost', { hostId: host.hostId })}
                    title={t('sidebar.addTask')}
                    disabled={isSaving}
                    onClick={() => onAddTask(host.hostId)}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                )}
              </div>

              {(showSubId || (onConnectHost && !isConnected && !isDisabled)) && (
                <div className="fleet-host-subrow">
                  <button
                    type="button"
                    className="fleet-host-address"
                    onClick={() => onSelectHost?.(host.hostId)}
                    aria-label={t('sidebar.viewHost', { hostId: host.hostId })}
                  >
                    {host.hostId}
                  </button>
                  {onConnectHost && !isConnected && !isDisabled && (
                    <button
                      type="button"
                      className="fleet-host-connect btn btn-ghost btn-xs"
                      disabled={isConnecting}
                      aria-label={t('sidebar.connectHost', { hostId: host.hostId })}
                      onClick={() => onConnectHost(host.hostId)}
                    >
                      {isConnecting ? t('header.hostConnecting') : t('header.hostConnect')}
                    </button>
                  )}
                </div>
              )}

              {hostTasks.length === 0 ? (
                <div className="fleet-empty-host">{t('sidebar.emptyHost')}</div>
              ) : (
                <div className="fleet-tasks-list">
                  {hostTasks.map((task) => {
                    taskGlobalIndex += 1;
                    const shortcutHint = taskGlobalIndex <= 9 ? `Ctrl+${taskGlobalIndex}` : null;
                    const isActive = task.taskId === activeTaskId;
                    const badge = getLifecycleBadge(task.lifecycle, locale);
                    const isStale = task.freshness === 'stale';
                    const registration = registrations.find((item) => item.taskId === task.taskId);
                    const label = registration?.label || task.taskId;
                    const rightMetric = summarizeTaskMetric(task, registration?.enabled !== false, t('sidebar.disabledTag'));

                    return (
                      <div key={task.taskId} className="fleet-task-row">
                        <button
                          type="button"
                          role="treeitem"
                          aria-selected={isActive}
                          className={`fleet-task-item ${isActive ? 'is-active' : ''}`}
                          onClick={() => onSelectTask(task.taskId)}
                          title={shortcutHint ? `${label} (${shortcutHint})` : label}
                        >
                          <div className="task-item-main">
                            <span className="task-item-name" title={label}>
                              {label}
                            </span>
                            {rightMetric && <span className="task-item-right">{rightMetric}</span>}
                          </div>

                          <div className="task-item-meta">
                            <span className={`task-badge ${badge.className}`}>
                              <span className={`lifecycle-dot ${badge.pulse ? 'is-pulsing' : ''}`} />
                              {badge.text}
                            </span>
                            {isStale && (
                              <span
                                className="task-stale-tag"
                                title={`${t('drawer.observedAtLabel')}: ${formatTimestamp(task.statusObservedAt)}`}
                              >
                                {t('app.stale')}
                              </span>
                            )}
                          </div>
                        </button>
                        {registration && onEditTask && onRemoveTask && (
                          <TaskActions
                            label={label}
                            disabled={isSaving}
                            onEdit={() => onEditTask(task.taskId)}
                            onRemove={() => onRemoveTask(task.taskId)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="fleet-footer">
        <div className="fleet-footer-stats tabular-num">
          <strong>{t('sidebar.footerHostsOnline', { online: onlineCount, total: hosts.length })}</strong>
          <span>{t('sidebar.footerRunning', { count: runningCount })}</span>
        </div>
        {onOpenHostSettings && (
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={onOpenHostSettings}
            title={t('sidebar.addHostQuick')}
          >
            <Icon name="plus" size={12} />
            <span>{t('sidebar.addHostQuick')}</span>
          </button>
        )}
      </div>
    </nav>
  );
}
