import { Icon } from './Icon';
import { createPortal } from 'react-dom';
import React, { useEffect, useRef, useState } from "react";
import type { HostSnapshot, TaskSnapshot, TaskRegistration } from "../../shared/contracts";
import { formatTimestamp } from "../utils/format";
import { getLifecycleBadge } from "../utils/lifecycle";

interface TaskFleetTreeProps {
  hosts: HostSnapshot[];
  tasks: TaskSnapshot[];
  activeTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  registrations?: TaskRegistration[];
  onAddTask?: (hostId?: string) => void;
  onEditTask?: (taskId: string) => void;
  onRemoveTask?: (taskId: string) => void;
  isSaving?: boolean;
  activeHostId?: string | null;
  onSelectHost?: (hostId: string) => void;
  onConnectHost?: (hostId: string) => void;
  connectingHostIds?: string[];
  disabledHostIds?: string[];
}

function TaskActions({ label, onEdit, onRemove, disabled }: { label: string; onEdit: () => void; onRemove: () => void; disabled: boolean }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setPosition(null); trigger.current?.focus(); };
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const scroll = () => setPosition(null);
    document.addEventListener('mousedown', outside);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', scroll); };
  }, [position]);
  const open = () => {
    const box = trigger.current!.getBoundingClientRect();
    setPosition({ top: Math.max(8, Math.min(box.bottom + 4, window.innerHeight - 94)), left: Math.max(8, box.right - 144) });
  };
  return <div className="fleet-task-actions">
    <button ref={trigger} type="button" className="fleet-icon-button task-menu-trigger" aria-label={`${label}的任务菜单`} title="任务菜单" aria-haspopup="menu" aria-expanded={!!position} disabled={disabled} onClick={() => position ? close() : open()} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(); } }}><Icon name="more" /></button>
    {position && createPortal(<div ref={menu} role="menu" aria-label={`${label}任务操作`} className="fleet-task-menu" style={{ position: 'fixed', ...position }} onBlur={event => {
      if (!menu.current?.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) setPosition(null);
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const next = items.indexOf(document.activeElement as HTMLElement) + (event.key === 'ArrowDown' ? 1 : -1);
        items[(next + items.length) % items.length]?.focus();
      }
    }}>
      <button type="button" role="menuitem" onClick={() => { close(); onEdit(); }}>编辑任务</button>
      <button type="button" role="menuitem" className="task-remove" onClick={() => { close(); onRemove(); }}>移除任务</button>
    </div>, document.body)}
  </div>;
}

export function TaskFleetTree({
  hosts,
  tasks,
  activeTaskId,
  onSelectTask,
  registrations = [], onAddTask, onEditTask, onRemoveTask, isSaving = false,
  activeHostId, onSelectHost, onConnectHost, connectingHostIds = [], disabledHostIds = [],
}: TaskFleetTreeProps) {
  // Map tasks under each host
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
          kind: "ssh",
          connection: "unobserved",
          lastSuccessAt: null,
          lastProbeDurationMs: null,
          scanComplete: false,
          errorCode: null,
          observedAt: null,
          freshness: "unobserved",
        },
        tasks: [task],
      });
    }
  }

  let taskGlobalIndex = 0;

  return (
    <nav
      className="task-fleet-panel"
      aria-label="环境与任务阵列"
    >
      <div className="fleet-header">
        <span className="fleet-title">监控任务</span>
        {onAddTask && <button type="button" className="fleet-icon-button" aria-label="添加任务" title="添加任务" disabled={isSaving} onClick={() => onAddTask()}><Icon name="plus" /></button>}
      </div>

      <div className="fleet-tree" role="tree">
        {Array.from(hostMap.values()).map(({ host, tasks: hostTasks }) => {
          const isConnected = host.connection === "connected";
          const isDisconnected = host.connection === "disconnected";

          return (
            <div key={host.hostId} className={`fleet-host-group ${activeHostId === host.hostId ? 'is-selected-host' : ''}`} role="treeitem" aria-expanded="true">
              <div className="fleet-host-header">
                <button type="button" className="fleet-host-select" onClick={() => onSelectHost?.(host.hostId)} aria-label={`选择宿主 ${host.hostId}`} aria-pressed={activeHostId === host.hostId}>
                <Icon name={host.kind === "ssh" ? "server" : "terminal"} /><strong className="host-name" title={host.hostId}>{host.kind === "ssh" ? "远程服务器" : host.kind === "wsl" ? "本地 WSL" : "本机"}</strong>
                <span className="host-kind-tag">{host.kind.toUpperCase()}</span>
                <span
                  className={
                    "host-status-dot " +
                    (isConnected
                      ? "dot-connected"
                      : isDisconnected
                      ? "dot-disconnected"
                      : "dot-unobserved")
                  }
                  title={host.connection}
                />
                <span className="fleet-host-connection">{isConnected ? "已连接" : isDisconnected ? "已断开" : "待观测"}</span>
                </button>
                {onAddTask && <button type="button" className="fleet-icon-button fleet-host-add" aria-label={`向 ${host.hostId} 添加任务`} title="添加任务" disabled={isSaving} onClick={() => onAddTask(host.hostId)}><Icon name="plus" /></button>}
              </div>
              <div className="fleet-host-address-row">
                <button type="button" className="fleet-host-address" onClick={() => onSelectHost?.(host.hostId)} aria-label={`查看 ${host.hostId}`}>{host.hostId}</button>
                {onConnectHost && !isConnected && !disabledHostIds.includes(host.hostId) && <button type="button" className="fleet-host-connect btn btn-ghost btn-xs" disabled={connectingHostIds.includes(host.hostId)} aria-label={`连接 ${host.hostId}`} onClick={() => onConnectHost(host.hostId)}>{connectingHostIds.includes(host.hostId) ? '连接中…' : '连接'}</button>}
              </div>

              {hostTasks.length === 0 ? (
                <div className="fleet-empty-host">
                  <small>无登记任务</small>
                </div>
              ) : (
                <div className="fleet-tasks-list" role="group">
                  {hostTasks.map((task) => {
                    taskGlobalIndex += 1;
                    const shortcutIndex = taskGlobalIndex <= 9 ? taskGlobalIndex : null;
                    const isActive = task.taskId === activeTaskId;
                    const badge = getLifecycleBadge(task.lifecycle);
                    const isStale = task.freshness === "stale";
                    const registration = registrations.find(item => item.taskId === task.taskId);
                    const label = registration?.label || task.taskId;

                    let progressSummary = "待观测";
                    if (task.progress.global.completedCount !== null) {
                      progressSummary = "累计 " + Math.round(task.progress.global.completedCount / 1000) + "k";
                    } else if (task.progress.resumeCheckpointIndex !== null) {
                      progressSummary = "基线 " + task.progress.resumeCheckpointIndex;
                    }

                    return (
                      <div key={task.taskId} className="fleet-task-row">
                      <button
                        type="button"
                        role="treeitem"
                        aria-selected={isActive}
                        className={"fleet-task-item " + (isActive ? "is-active" : "")}
                        onClick={() => onSelectTask(task.taskId)}
                      >
                        <div className="task-item-main">
                          <span className="task-item-name" title={label}>
                            {label}
                          </span>
                          {shortcutIndex && (
                            <kbd className="task-shortcut">Ctrl+{shortcutIndex}</kbd>
                          )}
                        </div>

                        <div className="task-item-meta">
                          <span className={"task-badge " + badge.className}>
                            <span className="lifecycle-dot" />{badge.text}
                          </span>
                          {isStale && (
                            <span
                              className="task-stale-tag"
                              title={"上次观测时间: " + formatTimestamp(task.statusObservedAt)}
                            >
                              [上次观测]
                            </span>
                          )}
                          <span className="task-summary-tag">{registration?.enabled === false ? '已停用' : progressSummary}</span>
                        </div>
                      </button>
                      {registration && onEditTask && onRemoveTask && <TaskActions label={label} disabled={isSaving} onEdit={() => onEditTask(task.taskId)} onRemove={() => onRemoveTask(task.taskId)} />}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="fleet-footer"><Icon name="monitor" />进程监控</div>
    </nav>
  );
}
