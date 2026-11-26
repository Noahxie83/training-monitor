import React, { useState } from "react";
import type {
  TaskSnapshot,
  HostSnapshot,
  LogSourceSnapshot,
  AutoStartConfig,
} from "../../shared/contracts";
import { getLifecycleBadge } from "../utils/lifecycle";
import { formatTimestamp } from "../utils/format";
import { DualProgressBar } from "./DualProgressBar";
import { KpiMetricsGrid } from "./KpiMetricsGrid";
import { ResourceMetrics } from "./ResourceMetrics";
import { Icon } from "./Icon";
import { LogConsole } from "./LogConsole";
import { useLogBuffer } from "../hooks/useLogBuffer";
import { AutoStartPanel } from "./AutoStartPanel";

interface TaskCockpitProps {
  task: TaskSnapshot | null;
  host: HostSnapshot | null;
  sources: LogSourceSnapshot[];
  onOpenEvidence: () => void;
  onRefresh: () => void;
  onOpenSettings?: () => void;
  algorithm?: string;
  algorithmName?: string;
  taskLabel?: string;
  autoStartConfig?: AutoStartConfig | null;
  hostSnapshots?: HostSnapshot[];
  onConfigureAutoStart?: () => void;
  onRearmAutoStart?: () => void;
  onDisableAutoStart?: () => void;
  autoStartBusy?: boolean;
  autoStartError?: string | null;
}

export function TaskCockpit({
  task,
  host,
  sources,
  onOpenEvidence,
  onRefresh,
  onOpenSettings,
  algorithm,
  algorithmName,
  taskLabel,
  autoStartConfig,
  hostSnapshots,
  onConfigureAutoStart,
  onRearmAutoStart,
  onDisableAutoStart,
  autoStartBusy = false,
  autoStartError,
}: TaskCockpitProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  // Hook for active task logs (I2, I3, I4, I11)
  const logBuffer = useLogBuffer(task?.taskId ?? null, sources);

  const handleCopyPath = async () => {
    if (!task) return;
    setCopyError(null);
    try {
      await window.monitor.copyRegisteredPath({ taskId: task.taskId });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err: any) {
      setCopyError("复制失败: " + (err?.message || "无可用路径"));
      setTimeout(() => setCopyError(null), 3000);
    }
  };

  // Normal mode empty state (I1)
  if (!task) {
    return (
      <main className="cockpit-container cockpit-empty" role="main" aria-label="训练监控主工作区">
        <div className="empty-state-card">
          <div className="empty-icon"><Icon name="folder" /></div>
          <h2 className="empty-title">暂无已登记任务</h2>
          <p className="empty-text">
            {host ? `为 ${host.hostId} 添加任务，开始查看训练进度和日志。` : '添加一个任务，开始查看训练进度和日志。'}
          </p>
          {onOpenSettings && (
            <button
              type="button"
              className="btn btn-primary"
              aria-label="添加第一个任务"
              onClick={onOpenSettings}
              style={{ marginTop: 12 }}
            >
              <Icon name="plus" /> 添加任务
            </button>
          )}
        </div>
      </main>
    );
  }

  const badge = getLifecycleBadge(task.lifecycle);
  const isDisconnected = host?.connection === "disconnected";
  const isStale = task.freshness === "stale";
  const showStaleWarning = isDisconnected || isStale;

  // Warning text strictly separating disconnected from task stale (I8)
  let warningMessage = "";
  if (isDisconnected) {
    warningMessage = "连接中断；上次确认：" + formatTimestamp(task.statusObservedAt) + "（本地时间），状态：" + badge.text + "；等待重连。";
  } else if (isStale) {
    warningMessage = "任务状态待更新；上次确认：" + formatTimestamp(task.statusObservedAt) + "（本地时间），状态：" + badge.text + "。";
  }

  return (
    <main className="cockpit-container" role="main" aria-label="训练任务监控视窗">
      {/* Top Header of Selected Task */}
      <div className="cockpit-header">
        <div className="cockpit-title-row">
          <div className="cockpit-ident">
            <h2 className="cockpit-task-title">{taskLabel || task.taskId}</h2>
            
            <span className={"task-badge " + badge.className}>
              <span className="lifecycle-dot" />{badge.text}
            </span>
            <p className="cockpit-location">{task.hostId}<span aria-hidden="true">/</span>{task.taskId}{algorithmName && <span className="cockpit-algorithm" title="算法名称">{algorithmName}</span>}</p>
          </div>

          <div className="cockpit-action-buttons">
            {copyError && <span className="text-danger" style={{ fontSize: 12 }}>{copyError}</span>}
            {onConfigureAutoStart && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onConfigureAutoStart}
                aria-label="配置 GPU 空闲自动启动"
                title="配置 GPU 空闲自动启动"
              >
                <Icon name="play" />空闲自动启动
              </button>
            )}
            <button
              type="button"
              className={"btn btn-secondary " + (copied ? "btn-copied" : "")}
              onClick={handleCopyPath}
              aria-label={copied ? "已复制" : "复制路径"}
            >
              <Icon name={copied ? "check" : "copy"} />{copied ? "已复制" : "复制路径"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onOpenEvidence}
              aria-label="白名单证据详情"
              title="白名单证据详情"
            >
              <Icon name="info" />任务详情
            </button>
          </div>
        </div>

        {/* Disconnected / Stale Warning Banner (I8) */}
        {showStaleWarning && (
          <div className="cockpit-warning-banner" role="alert">
            <Icon name="warning" />
            <span className="warning-text">{warningMessage}</span>
          </div>
        )}
      </div>

      {autoStartConfig && onConfigureAutoStart && (
        <AutoStartPanel
          config={autoStartConfig}
          status={task.autoStart ?? null}
          hostSnapshots={hostSnapshots}
          hostId={task.hostId}
          onConfigure={onConfigureAutoStart}
          onRearm={() => onRearmAutoStart?.()}
          onDisable={() => onDisableAutoStart?.()}
          isBusy={autoStartBusy}
          error={autoStartError}
        />
      )}

      {/* Progress & KPIs Grid */}
      <div className="cockpit-workspace">
      <div className="cockpit-metrics-section">
        <DualProgressBar task={task} algorithm={algorithm} />
        <KpiMetricsGrid task={task} />
      </div>
      <section className="cockpit-resource-panel" aria-label="资源使用"><ResourceMetrics task={task} /></section>

      {/* Virtualized Log Console */}
      <div className="cockpit-logs-section">
        <LogConsole
          sources={logBuffer.sources}
          activeSource={logBuffer.activeSource}
          activeSourceId={logBuffer.activeSourceId}
          onSelectSource={logBuffer.setActiveSourceId}
          events={logBuffer.events}
          totalBufferedCount={logBuffer.totalBufferedCount}
          totalBufferedBytes={logBuffer.totalBufferedBytes}
          isScrollLocked={logBuffer.isScrollLocked}
          setIsScrollLocked={logBuffer.setIsScrollLocked}
          unreadCount={logBuffer.unreadCount}
          onResumeAutoScroll={logBuffer.resumeAutoScroll}
          onToggleScrollLock={logBuffer.toggleScrollLock}
          searchQuery={logBuffer.searchQuery}
          onSearchChange={logBuffer.executeSearch}
          onClearSearch={logBuffer.clearSearch}
          isSearching={logBuffer.isSearching}
          isWrapLines={logBuffer.isWrapLines}
          onToggleWrapLines={() => logBuffer.setIsWrapLines((v) => !v)}
          onRefresh={onRefresh}
          nextBefore={logBuffer.nextBefore}
          truncatedByBudget={logBuffer.truncatedByBudget}
          onLoadEarlier={logBuffer.loadEarlierLogs}
          searchContinuation={logBuffer.searchContinuation}
          onLoadMoreSearch={logBuffer.loadMoreSearchResults}
          isLoadingEarlier={logBuffer.isLoadingEarlier}
          onCancelEarlier={logBuffer.cancelEarlierLogs}
          activeGeneration={logBuffer.activeSource?.generation ?? null}
          pagingError={logBuffer.pagingError}
          searchError={logBuffer.searchError}
          onRestartSearch={logBuffer.restartSearch}
          isLoadingInitial={logBuffer.isLoadingInitial}
          residentEvicted={logBuffer.residentEvicted}
          initialFetchError={logBuffer.initialFetchError}
          onReloadFromLatest={logBuffer.reloadFromLatest}
        />
      </div>
      </div>
    </main>
  );
}
