import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CopyCommandKind } from '../../shared/api';
import type {
  AutoStartConfig,
  HostRegistration,
  HostSnapshot,
  JobControlAction,
  LogSourceSnapshot,
  TaskRegistration,
  TaskSnapshot,
} from '../../shared/contracts';
import { getLifecycleBadge } from '../utils/lifecycle';
import { formatTimestamp } from '../utils/format';
import { useI18n } from '../i18n';
import { DualProgressBar } from './DualProgressBar';
import { KpiMetricsGrid } from './KpiMetricsGrid';
import { ResourceMetrics } from './ResourceMetrics';
import { TrainingChart } from './TrainingChart';
import { Icon } from './Icon';
import { LogConsole } from './LogConsole';
import { useLogBuffer } from '../hooks/useLogBuffer';
import { AutoStartPanel } from './AutoStartPanel';
import { JobControlModal } from './JobControlModal';

interface TaskCockpitProps {
  task: TaskSnapshot | null;
  host: HostSnapshot | null;
  hostRegistration?: HostRegistration | null;
  taskRegistration?: TaskRegistration | null;
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
  hostRegistration,
  taskRegistration,
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
  const { locale, t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [terminalNote, setTerminalNote] = useState<string | null>(null);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [rightTab, setRightTab] = useState<'gpu' | 'curves'>('gpu');
  const [hasChartData, setHasChartData] = useState(false);
  const userChoseTabRef = useRef(false);
  const prevTaskIdRef = useRef<string | null>(task?.taskId ?? null);
  const terminalMenuRef = useRef<HTMLDivElement>(null);
  const [jobControlAction, setJobControlAction] = useState<JobControlAction | null>(null);

  // Reset user tab choice synchronously before child effects when switching tasks
  if (prevTaskIdRef.current !== (task?.taskId ?? null)) {
    prevTaskIdRef.current = task?.taskId ?? null;
    userChoseTabRef.current = false;
  }

  useEffect(() => {
    userChoseTabRef.current = false;
    setHasChartData(false);
    setRightTab('gpu');
    setTerminalMenuOpen(false);
  }, [task?.taskId]);

  useEffect(() => {
    if (!terminalMenuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!terminalMenuRef.current?.contains(event.target as Node)) {
        setTerminalMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTerminalMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [terminalMenuOpen]);

  const logBuffer = useLogBuffer(task?.taskId ?? null, sources);

  const handleChartHasData = useCallback((hasData: boolean) => {
    setHasChartData(hasData);
    if (!userChoseTabRef.current) {
      setRightTab(hasData ? 'curves' : 'gpu');
    }
  }, []);

  const handleCopyPath = async () => {
    if (!task) return;
    setCopyError(null);
    try {
      await window.monitor.copyRegisteredPath({ taskId: task.taskId });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err: any) {
      setCopyError(t('cockpit.copyPathFailed', { reason: err?.message || '' }));
      setTimeout(() => setCopyError(null), 3000);
    }
  };

  const handleCopyCommand = async (kind: CopyCommandKind) => {
    if (!task || !host || !window.desktop?.copyCommand) return;
    setTerminalMenuOpen(false);
    setTerminalNote(null);
    try {
      await window.desktop.copyCommand({
        kind,
        hostId: host.hostId,
        taskId: task.taskId,
        ...(kind === 'tail_log' && logBuffer.activeSourceId ? { sourceId: logBuffer.activeSourceId } : {}),
      });
      setTerminalNote(t('app.copied'));
      setTimeout(() => setTerminalNote(null), 2000);
    } catch {
      // Ignore command copy failure
    }
  };

  const handleOpenTerminal = async () => {
    if (!task || !host) return;
    setTerminalNote(null);
    const sessionName = task.autoStart?.sessionName;
    if (window.desktop?.openSshTerminal) {
      try {
        const res = await window.desktop.openSshTerminal({
          hostId: host.hostId,
          ...(sessionName ? { command: `tmux -L training-monitor-$(id -u) attach-session -t =${sessionName}` } : {}),
        });
        if (!res.ok && window.desktop?.copyCommand) {
          await handleCopyCommand(sessionName ? 'tmux_attach' : 'ssh');
        }
      } catch {
        // Ignore terminal open errors gracefully
      }
    } else if (window.desktop?.copyCommand) {
      await handleCopyCommand(sessionName ? 'tmux_attach' : 'ssh');
    }
  };

  if (!task) {
    return (
      <main className="cockpit-container cockpit-empty" role="main" aria-label={t('cockpit.emptyMainAria')}>
        <div className="empty-state-card">
          <div className="empty-icon">
            <Icon name="folder" size={22} />
          </div>
          <h2 className="empty-title">{t('cockpit.emptyTitle')}</h2>
          <p className="empty-text">
            {host
              ? t('cockpit.emptyDescWithHost', { hostId: host.hostId })
              : t('cockpit.emptyDescNoHost')}
          </p>
          {onOpenSettings && (
            <div className="empty-actions">
              <button
                type="button"
                className="btn btn-primary"
                aria-label={t('cockpit.addFirstTaskAria')}
                onClick={onOpenSettings}
              >
                <Icon name="plus" size={14} />
                <span>{t('sidebar.addTask')}</span>
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  const badge = getLifecycleBadge(task.lifecycle, locale);
  const isDisconnected = host?.connection === 'disconnected';
  const isStale = task.freshness === 'stale';
  const showStaleWarning = isDisconnected || isStale;

  const warningMessage = isDisconnected
    ? t('cockpit.disconnectedWarning', { time: formatTimestamp(task.statusObservedAt), status: badge.text })
    : isStale
      ? t('cockpit.staleWarning', { time: formatTimestamp(task.statusObservedAt), status: badge.text })
      : '';

  const attribution =
    task.attributionConfidence ??
    (task.processes.main ? 'confirmed_process' : task.processes.workers.length > 0 ? 'inferred_tree' : 'log_only');
  const attributionLabel = t(`confidence.${attribution}`);
  const allowJobControl = hostRegistration?.allowJobControl === true;
  const activePids = [
    ...(task.processes.main ? [task.processes.main.pid] : []),
    ...task.processes.workers.map((w) => w.pid),
  ];

  const sourcePathById: Record<string, string> = {};
  for (const s of taskRegistration?.sources ?? []) {
    sourcePathById[s.sourceId] = s.path;
  }

  const showAutoStart = Boolean(autoStartConfig && onConfigureAutoStart);
  const hasTerminalActions = Boolean((window.desktop?.openSshTerminal || window.desktop?.copyCommand) && host);

  return (
    <main
      className={`cockpit-container ${showAutoStart ? 'has-autostart' : ''}`}
      role="main"
      aria-label={t('cockpit.mainAria')}
    >
      {/* Row 1: Task Title & Action Bar */}
      <div className="cockpit-header">
        <div className="cockpit-title-row">
          <div className="cockpit-ident">
            <div className="cockpit-title-line">
              <h2 className="cockpit-task-title" title={taskLabel || task.taskId}>
                {taskLabel || task.taskId}
              </h2>
              <span className={`task-badge ${badge.className}`}>
                <span className={`lifecycle-dot ${badge.pulse ? 'is-pulsing' : ''}`} />
                {badge.text}
              </span>
              <span className={`confidence-badge ${attribution === 'confirmed_process' ? 'is-confirmed' : ''}`}>
                <Icon name="shield" size={11} />
                <span>{attributionLabel}</span>
              </span>
            </div>
            <p className="cockpit-location">
              <span className="cockpit-location-host">
                {hostRegistration?.label || task.hostId} / {task.taskId}
              </span>
              {algorithmName && (
                <span className="cockpit-algorithm" title={t('cockpit.algorithmTitle')}>
                  {algorithmName}
                </span>
              )}
              {taskRegistration?.allowedDirectories[0] && (
                <span className="cockpit-location-dir text-muted" title={taskRegistration.allowedDirectories[0]}>
                  {taskRegistration.allowedDirectories[0]}
                </span>
              )}
            </p>
          </div>

          <div className="cockpit-action-buttons">
            {copyError && (
              <span className="text-danger" style={{ fontSize: 12 }}>
                {copyError}
              </span>
            )}
            {terminalNote && (
              <span className="text-success" style={{ fontSize: 12 }}>
                {terminalNote}
              </span>
            )}
            {hasTerminalActions && (
              <div className="cockpit-split-btn-wrap" ref={terminalMenuRef}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm cockpit-split-main"
                  onClick={() => void handleOpenTerminal()}
                  title={t('cockpit.openTerminalTitle')}
                >
                  <Icon name="terminal" size={13} />
                  <span>{t('cockpit.openTerminal')}</span>
                </button>
                {window.desktop?.copyCommand && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm cockpit-split-caret"
                    aria-label={t('cockpit.terminalMenuAria')}
                    title={t('cockpit.terminalMenuAria')}
                    aria-haspopup="menu"
                    aria-expanded={terminalMenuOpen}
                    onClick={() => setTerminalMenuOpen((v) => !v)}
                  >
                    <Icon name="chevronDown" size={12} />
                  </button>
                )}
                {terminalMenuOpen && window.desktop?.copyCommand && (
                  <div className="popover-panel cockpit-cmd-menu" role="menu" aria-label={t('cockpit.terminalMenuAria')}>
                    <button type="button" role="menuitem" onClick={() => void handleCopyCommand('ssh')}>
                      <Icon name="terminal" size={12} />
                      <span>{t('cockpit.copySsh')}</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => void handleCopyCommand('tmux_attach')}>
                      <Icon name="layers" size={12} />
                      <span>{t('cockpit.copyTmux')}</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => void handleCopyCommand('tail_log')}>
                      <Icon name="file" size={12} />
                      <span>{t('cockpit.copyTail')}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {onConfigureAutoStart && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onConfigureAutoStart}
                aria-label={t('cockpit.autoStartBtnAria')}
                title={t('cockpit.autoStartBtnAria')}
              >
                <Icon name="clock" size={13} />
                <span className="btn-label">{t('cockpit.autoStartBtn')}</span>
              </button>
            )}
            {allowJobControl && (
              <>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => setJobControlAction('stop')}
                >
                  <Icon name="stop" size={12} />
                  <span>{t('cockpit.jobControlStop')}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => setJobControlAction('kill')}
                  title={t('cockpit.jobControlKillTitle')}
                >
                  <Icon name="kill" size={12} />
                  <span>{t('cockpit.jobControlKill')}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setJobControlAction('restart')}
                >
                  <Icon name="restart" size={12} />
                  <span>{t('cockpit.jobControlRestart')}</span>
                </button>
              </>
            )}
            <button
              type="button"
              className={`btn btn-secondary btn-sm ${copied ? 'btn-copied' : ''}`}
              onClick={() => void handleCopyPath()}
              aria-label={copied ? t('app.copied') : t('cockpit.copyPath')}
              title={copied ? t('app.copied') : t('cockpit.copyPath')}
            >
              <Icon name={copied ? 'check' : 'copy'} size={13} />
              <span className="btn-label">{copied ? t('app.copied') : t('cockpit.copyPath')}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onOpenEvidence}
              aria-label={t('cockpit.taskDetailsAria')}
              title={t('cockpit.taskDetailsTitle')}
            >
              <Icon name="info" size={13} />
              <span className="btn-label">{t('cockpit.taskDetails')}</span>
            </button>
          </div>
        </div>

        {showStaleWarning && (
          <div className="cockpit-warning-banner" role="alert">
            <Icon name="warning" size={14} />
            <span className="warning-text">{warningMessage}</span>
          </div>
        )}
      </div>

      {/* Optional Row: Compact 2-row AutoStart Status Strip */}
      {showAutoStart && autoStartConfig && onConfigureAutoStart && (
        <AutoStartPanel
          config={autoStartConfig}
          status={task.autoStart ?? null}
          hostSnapshots={hostSnapshots}
          hostId={task.hostId}
          taskId={task.taskId}
          onConfigure={onConfigureAutoStart}
          onRearm={() => onRearmAutoStart?.()}
          onDisable={() => onDisableAutoStart?.()}
          isBusy={autoStartBusy}
          error={autoStartError}
        />
      )}

      {/* Row 2: Unified 2-Column Telemetry Cards (NO dark-mode layout mutation!) */}
      <div className="cockpit-telemetry-grid">
        <div className="telemetry-card">
          <DualProgressBar task={task} algorithm={algorithm} />
          <KpiMetricsGrid task={task} />
        </div>

        <section
          className={`telemetry-card cockpit-right-card ${hasChartData ? 'is-wide-split' : ''}`}
          aria-label={t('cockpit.telemetryPanelAria')}
        >
          <div className="section-heading right-tabs-bar">
            <div className="segmented-control" role="tablist" aria-label={t('cockpit.telemetryPanelAria')}>
              <button
                id="cockpit-tab-curves"
                type="button"
                role="tab"
                className={`segmented-btn ${rightTab === 'curves' ? 'is-active' : ''}`}
                aria-selected={rightTab === 'curves'}
                aria-controls="cockpit-panel-curves"
                onClick={() => {
                  userChoseTabRef.current = true;
                  setRightTab('curves');
                }}
              >
                <Icon name="chart" size={13} />
                <span>{t('cockpit.tabCurves')}</span>
              </button>
              <button
                id="cockpit-tab-gpu"
                type="button"
                role="tab"
                className={`segmented-btn ${rightTab === 'gpu' ? 'is-active' : ''}`}
                aria-selected={rightTab === 'gpu'}
                aria-controls="cockpit-panel-gpu"
                onClick={() => {
                  userChoseTabRef.current = true;
                  setRightTab('gpu');
                }}
              >
                <Icon name="gpu" size={13} />
                <span>{t('cockpit.tabGpuProcess')}</span>
              </button>
            </div>
          </div>

          <div className={`cockpit-right-split ${hasChartData ? 'is-wide-split' : ''}`}>
            <div
              id="cockpit-panel-curves"
              role="tabpanel"
              aria-labelledby="cockpit-tab-curves"
              className={`right-pane ${rightTab !== 'curves' ? 'is-hidden-tab' : ''}`}
            >
              <TrainingChart
                taskId={task.taskId}
                refreshTick={task.progress.observedAt ?? task.statusObservedAt}
                onHasDataChange={handleChartHasData}
              />
            </div>

            <div
              id="cockpit-panel-gpu"
              role="tabpanel"
              aria-labelledby="cockpit-tab-gpu"
              className={`right-pane ${rightTab !== 'gpu' ? 'is-hidden-tab' : ''}`}
            >
              <ResourceMetrics task={task} />
            </div>
          </div>
        </section>
      </div>

      {/* Row 3: Terminal-grade Virtualized Log Console — ALWAYS visible above the fold */}
      <div className="cockpit-logs-section">
        <LogConsole
          sources={logBuffer.sources}
          sourcePathById={sourcePathById}
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
          searchMode={logBuffer.searchMode}
          searchCaseSensitive={logBuffer.searchCaseSensitive}
          levelFilter={logBuffer.levelFilter}
          onSearchChange={logBuffer.executeSearch}
          onSearchModeChange={logBuffer.setSearchMode}
          onSearchCaseSensitiveChange={logBuffer.setSearchCaseSensitive}
          onLevelFilterChange={logBuffer.setLevelFilter}
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

      {jobControlAction && (
        <JobControlModal
          taskId={task.taskId}
          taskLabel={taskLabel || task.taskId}
          action={jobControlAction}
          pids={activePids}
          onClose={() => setJobControlAction(null)}
          onCompleted={() => onRefresh()}
        />
      )}
    </main>
  );
}
