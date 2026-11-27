import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseHostUnreachableReconcileError, useMonitor } from './hooks/useMonitor';
import { I18nProvider, translate } from './i18n';
import { Header } from './components/Header';
import { TaskFleetTree } from './components/TaskFleetTree';
import { TaskCockpit } from './components/TaskCockpit';
import { EvidenceDrawer } from './components/EvidenceDrawer';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import { TaskEditor } from './components/TaskEditor';
import { HostConnectionPanel } from './components/HostConnectionPanel';
import { HostOverview } from './components/HostOverview';
import { ProcessDiscoveryModal } from './components/ProcessDiscoveryModal';
import { ForceLocalReconcileModal } from './components/ForceLocalReconcileModal';
import type { DiscoveredProcess, Registry, TaskRegistration, TaskSnapshot } from '../shared/contracts';
import { taskAlgorithmName } from '../shared/task-profile';
import { newAutoStartArmId } from './components/AutoStartFields';

interface PendingForceLocalAction {
  registry: Registry;
  taskCount: number;
  kind: 'autostart' | 'remove';
  afterSave?: () => void;
}

export function App() {
  const {
    snapshot,
    activeTask,
    activeTaskId,
    setActiveTaskId,
    activeHost,
    activeHostId,
    selectHost,
    connectHost,
    connectingHostIds,
    hostConnectionErrors,
    preferences,
    locale,
    resolvedTheme,
    updatePreferences,
    registry,
    registryError,
    setRegistryError,
    updateRegistry,
    reloadRegistry,
    refresh,
    retrySnapshotLoad,
    retryPreferencesLoad,
    isLoadingSnapshot,
    isLoadingPreferences,
    isSavingPreferences,
    snapshotError,
    preferencesError,
    preferencesSaveError,
    refreshError,
    isRefreshing,
    announcement,
    lastSyncTime,
    alerts,
    unreadAlertCount,
    markAlertsRead,
    clearAlerts,
  } = useMonitor();

  useEffect(() => {
    void window.desktop?.setActiveTask?.(activeTaskId).catch((error: unknown) => {
      console.warn('Failed to update taskbar progress', error);
    });
  }, [activeTaskId]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (window.desktop?.platform === 'darwin') {
      document.documentElement.classList.add('platform-darwin');
    } else {
      document.documentElement.classList.remove('platform-darwin');
    }
  }, []);

  const [isEvidenceOpen, setIsEvidenceOpen] = useState(false);
  const [settingsModal, setSettingsModal] = useState<{ open: boolean; tab: SettingsTab }>({
    open: false,
    tab: 'appearance',
  });
  const [taskEditor, setTaskEditor] = useState<{
    task: TaskRegistration | null;
    hostId?: string;
    focusAutoStart?: boolean;
    initialProcess?: DiscoveredProcess | null;
  } | null>(null);
  const [discoveryHostId, setDiscoveryHostId] = useState<string | null>(null);
  const [removingTask, setRemovingTask] = useState(false);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  const [autoStartError, setAutoStartError] = useState<string | null>(null);
  const [gpuWindowError, setGpuWindowError] = useState<string | null>(null);
  const [pendingForceLocal, setPendingForceLocal] = useState<PendingForceLocalAction | null>(null);
  const [forceLocalBusy, setForceLocalBusy] = useState(false);
  const [forceLocalError, setForceLocalError] = useState<string | null>(null);

  const t = (key: string, params?: Record<string, string | number | null | undefined>) =>
    translate(locale, key, params);

  const openGpu = () => {
    setGpuWindowError(null);
    void window.desktop
      ?.openGpuWindow(activeHostId ?? undefined)
      .catch(() => setGpuWindowError(t('app.openGpuFailed')));
  };

  const addTask = (hostId?: string, initialProcess?: DiscoveredProcess | null) => {
    setTaskActionError(null);
    setTaskEditor({ task: null, hostId: hostId ?? activeHostId ?? undefined, initialProcess: initialProcess ?? null });
  };

  const configureAutoStart = (taskId: string) => {
    const task = registry?.tasks.find((item) => item.taskId === taskId);
    if (!task) return;
    setTaskActionError(null);
    setAutoStartError(null);
    setTaskEditor({ task, focusAutoStart: true });
  };

  const rearmAutoStart = async (taskId: string) => {
    if (!registry || autoStartBusy) return;
    const task = registry.tasks.find((item) => item.taskId === taskId);
    if (!task?.autoStart) return;
    const nextRegistry: Registry = {
      ...registry,
      tasks: registry.tasks.map((item) =>
        item.taskId === taskId
          ? { ...item, autoStart: { ...item.autoStart!, execution: 'server_tmux' as const, armId: newAutoStartArmId() } }
          : item,
      ),
    };
    setAutoStartBusy(true);
    setAutoStartError(null);
    try {
      await updateRegistry(nextRegistry);
    } catch (reason) {
      const reconcile = parseHostUnreachableReconcileError(reason);
      if (reconcile) {
        setForceLocalError(null);
        setPendingForceLocal({ registry: nextRegistry, taskCount: reconcile.taskCount, kind: 'autostart' });
      } else {
        setAutoStartError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setAutoStartBusy(false);
    }
  };

  const disableAutoStart = async (taskId: string) => {
    if (!registry || autoStartBusy) return;
    const task = registry.tasks.find((item) => item.taskId === taskId);
    if (!task?.autoStart) return;
    const nextRegistry: Registry = {
      ...registry,
      tasks: registry.tasks.map((item) =>
        item.taskId === taskId ? { ...item, autoStart: { ...item.autoStart!, enabled: false } } : item,
      ),
    };
    setAutoStartBusy(true);
    setAutoStartError(null);
    try {
      await updateRegistry(nextRegistry);
    } catch (reason) {
      const reconcile = parseHostUnreachableReconcileError(reason);
      if (reconcile) {
        setForceLocalError(null);
        setPendingForceLocal({ registry: nextRegistry, taskCount: reconcile.taskCount, kind: 'autostart' });
      } else {
        setAutoStartError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setAutoStartBusy(false);
    }
  };

  const removeTask = async (taskId: string) => {
    if (!registry || removingTask) return;
    const nextRegistry: Registry = {
      ...registry,
      tasks: registry.tasks.filter((task) => task.taskId !== taskId),
    };
    setRemovingTask(true);
    setTaskActionError(null);
    try {
      await updateRegistry(nextRegistry);
      document.querySelector<HTMLButtonElement>('.fleet-header button')?.focus();
    } catch (reason) {
      const reconcile = parseHostUnreachableReconcileError(reason);
      if (reconcile) {
        setForceLocalError(null);
        setPendingForceLocal({
          registry: nextRegistry,
          taskCount: reconcile.taskCount,
          kind: 'remove',
          afterSave: () => {
            document.querySelector<HTMLButtonElement>('.fleet-header button')?.focus();
          },
        });
      } else {
        setTaskActionError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setRemovingTask(false);
    }
  };

  const confirmForceLocal = async () => {
    if (!pendingForceLocal || forceLocalBusy) return;
    setForceLocalBusy(true);
    setForceLocalError(null);
    try {
      await updateRegistry(pendingForceLocal.registry, { forceLocal: true });
      const after = pendingForceLocal.afterSave;
      setPendingForceLocal(null);
      setAutoStartError(null);
      setTaskActionError(null);
      setRegistryError(null);
      after?.();
    } catch (reason) {
      const msg = reason instanceof Error ? reason.message : String(reason);
      setForceLocalError(msg);
      if (pendingForceLocal.kind === 'autostart') setAutoStartError(msg);
      else setTaskActionError(msg);
    } finally {
      setForceLocalBusy(false);
    }
  };

  // Flatten tasks in fleet display order for Ctrl+1~9
  const orderedTasks: TaskSnapshot[] = [];
  if (snapshot) {
    const hostMap = new Map<string, TaskSnapshot[]>();
    for (const h of snapshot.hosts) hostMap.set(h.hostId, []);
    for (const taskItem of snapshot.tasks) {
      const list = hostMap.get(taskItem.hostId);
      if (list) list.push(taskItem);
      else hostMap.set(taskItem.hostId, [taskItem]);
    }
    for (const list of hostMap.values()) orderedTasks.push(...list);
  }

  const shortcutStateRef = useRef({
    orderedTasks,
    refresh,
    setActiveTaskId,
    isSettingsOpen: settingsModal.open,
    isEvidenceOpen,
    taskEditor,
    discoveryHostId,
    pendingForceLocal,
    forceLocalBusy,
  });
  shortcutStateRef.current = {
    orderedTasks,
    refresh,
    setActiveTaskId,
    isSettingsOpen: settingsModal.open,
    isEvidenceOpen,
    taskEditor,
    discoveryHostId,
    pendingForceLocal,
    forceLocalBusy,
  };

  useLayoutEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const state = shortcutStateRef.current;
      const activeEl = document.activeElement;
      const targetEl = e.target as HTMLElement | null;
      const isInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl as HTMLElement)?.isContentEditable ||
        (activeEl as any)?.contentEditable === 'true' ||
        (activeEl as HTMLElement)?.getAttribute?.('contenteditable') === 'true' ||
        targetEl instanceof HTMLInputElement ||
        targetEl instanceof HTMLTextAreaElement ||
        targetEl instanceof HTMLSelectElement ||
        targetEl?.isContentEditable ||
        (targetEl as any)?.contentEditable === 'true' ||
        targetEl?.getAttribute?.('contenteditable') === 'true';
      const isComposing = (e as any).isComposing === true || e.keyCode === 229;

      if (e.key === 'Escape') {
        if (isComposing) return;
        if (state.pendingForceLocal) {
          if (!state.forceLocalBusy) setPendingForceLocal(null);
          return;
        }
        if (state.discoveryHostId) {
          setDiscoveryHostId(null);
          return;
        }
        if (state.isEvidenceOpen) {
          setIsEvidenceOpen(false);
          return;
        }
        if (state.isSettingsOpen) {
          setSettingsModal((prev) => ({ ...prev, open: false }));
          return;
        }
      }

      if (
        state.pendingForceLocal ||
        state.isSettingsOpen ||
        state.isEvidenceOpen ||
        state.taskEditor ||
        state.discoveryHostId ||
        isInput ||
        isComposing
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        void state.refresh();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const index = parseInt(e.key, 10) - 1;
        if (index < state.orderedTasks.length && state.orderedTasks[index]) {
          e.preventDefault();
          state.setActiveTaskId(state.orderedTasks[index]!.taskId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const activeTaskRegistration = registry?.tasks.find((item) => item.taskId === activeTaskId) ?? null;
  const activeHostRegistration = registry?.hosts.find((item) => item.hostId === activeHostId) ?? null;
  const activeHostTasks = snapshot?.tasks.filter((item) => item.hostId === activeHostId) ?? [];

  const handleToggleLocale = () => {
    const nextLocale = locale === 'zh-CN' ? 'en-US' : 'zh-CN';
    void updatePreferences({ ...preferences, locale: nextLocale }).catch(() => undefined);
  };

  return (
    <I18nProvider
      locale={locale}
      documentTitle={t('app.title')}
      onChangeLocale={(next) => {
        void updatePreferences({ ...preferences, locale: next }).catch(() => undefined);
      }}
    >
      <div className="app-shell" data-theme={resolvedTheme}>
        <Header
          theme={resolvedTheme}
          onToggleTheme={() => {
            void updatePreferences({
              ...preferences,
              theme: resolvedTheme === 'light' ? 'dark' : 'light',
            }).catch(() => undefined);
          }}
          isSavingTheme={isSavingPreferences}
          onToggleLocale={handleToggleLocale}
          hosts={snapshot?.hosts ?? []}
          hostRegistrations={registry?.hosts ?? []}
          activeHostId={activeHostId}
          activeTaskLabel={activeTask ? activeTaskRegistration?.label || activeTask.taskId : null}
          onSelectHost={selectHost}
          onConnectHost={registry ? connectHost : undefined}
          connectingHostIds={connectingHostIds}
          hostConnectionErrors={hostConnectionErrors}
          isDemo={Boolean(snapshot?.demo)}
          lastSyncTime={lastSyncTime}
          onRefresh={() => void refresh()}
          isRefreshing={isRefreshing}
          onOpenSettings={() => setSettingsModal({ open: true, tab: 'appearance' })}
          onOpenHostSettings={() => setSettingsModal({ open: true, tab: 'hosts' })}
          onOpenGpu={window.desktop ? openGpu : undefined}
          onOpenDiscovery={activeHostId && window.monitor?.discoverProcesses ? () => setDiscoveryHostId(activeHostId) : undefined}
          announcement={announcement}
          alerts={alerts}
          unreadAlertCount={unreadAlertCount}
          onMarkAlertsRead={markAlertsRead}
          onClearAlerts={clearAlerts}
          onSelectAlertTask={(taskId, hostId) => setActiveTaskId(taskId, hostId)}
        />

        {(isLoadingSnapshot || isLoadingPreferences || isSavingPreferences) && (
          <div className="global-status-strip" role="status">
            {isLoadingSnapshot && <span>{t('app.loadingSnapshot')}</span>}
            {isLoadingPreferences && <span>{t('app.loadingPreferences')}</span>}
            {isSavingPreferences && <span>{t('app.savingPreferences')}</span>}
          </div>
        )}

        {[snapshotError, preferencesError, preferencesSaveError, refreshError].filter(Boolean).map((message) => (
          <div key={message} className="global-error-banner alert alert-danger" role="alert">
            <span>{message}</span>
            {message === snapshotError && (
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => void retrySnapshotLoad()}>
                {t('app.retry')}
              </button>
            )}
            {message === preferencesError && (
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => void retryPreferencesLoad()}>
                {t('app.retryPreferences')}
              </button>
            )}
            {message === refreshError && (
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => void refresh()}>
                {t('app.retryRefresh')}
              </button>
            )}
          </div>
        ))}

        {(taskActionError || (registryError && !settingsModal.open && !taskEditor)) && (
          <div className="global-error-banner alert alert-danger" role="alert">
            <span>{taskActionError || registryError}</span>
            <button
              className="btn btn-secondary btn-xs"
              type="button"
              onClick={() => {
                void reloadRegistry()
                  .then(() => setTaskActionError(null))
                  .catch(() => undefined);
              }}
            >
              {t('app.reloadConfig')}
            </button>
          </div>
        )}

        {gpuWindowError && (
          <div className="global-error-banner alert alert-danger" role="alert">
            <span>{gpuWindowError}</span>
            <button type="button" className="btn btn-secondary btn-xs" onClick={openGpu}>
              {t('app.retryOpenGpu')}
            </button>
          </div>
        )}

        <div className="app-body">
          <TaskFleetTree
            hosts={snapshot?.hosts ?? []}
            hostRegistrations={registry?.hosts ?? []}
            tasks={snapshot?.tasks ?? []}
            activeTaskId={activeTaskId}
            activeHostId={activeHostId}
            onSelectHost={selectHost}
            onConnectHost={registry ? connectHost : undefined}
            connectingHostIds={connectingHostIds}
            disabledHostIds={registry?.hosts.filter((host) => !host.enabled).map((host) => host.hostId)}
            onSelectTask={setActiveTaskId}
            registrations={registry?.tasks}
            onAddTask={registry ? addTask : undefined}
            onEditTask={(taskId) => {
              const found = registry?.tasks.find((item) => item.taskId === taskId);
              if (found) {
                setTaskActionError(null);
                setTaskEditor({ task: found });
              }
            }}
            onRemoveTask={(taskId) => void removeTask(taskId)}
            onOpenHostSettings={() => setSettingsModal({ open: true, tab: 'hosts' })}
            isSaving={removingTask}
          />

          <div className="host-workspace">
            {activeHost && (
              <HostConnectionPanel
                host={activeHost}
                registration={activeHostRegistration ?? undefined}
                connecting={connectingHostIds.includes(activeHost.hostId)}
                error={hostConnectionErrors[activeHost.hostId]}
                onConnect={() => {
                  void connectHost(activeHost.hostId);
                }}
                onOpenSettings={() => setSettingsModal({ open: true, tab: 'hosts' })}
              />
            )}

            {activeTask ? (
              <TaskCockpit
                task={activeTask}
                host={activeHost}
                hostRegistration={activeHostRegistration}
                taskRegistration={activeTaskRegistration}
                sources={snapshot?.sources ?? []}
                onOpenEvidence={() => setIsEvidenceOpen(true)}
                onRefresh={() => void refresh()}
                onOpenSettings={registry ? () => addTask() : undefined}
                algorithm={activeTaskRegistration?.algorithm}
                algorithmName={activeTaskRegistration ? taskAlgorithmName(activeTaskRegistration) : undefined}
                taskLabel={activeTaskRegistration?.label}
                autoStartConfig={activeTaskRegistration?.autoStart ?? null}
                hostSnapshots={snapshot?.hosts ?? []}
                onConfigureAutoStart={
                  activeTaskRegistration ? () => configureAutoStart(activeTaskRegistration.taskId) : undefined
                }
                onRearmAutoStart={
                  activeTaskRegistration
                    ? () => {
                        void rearmAutoStart(activeTaskRegistration.taskId);
                      }
                    : undefined
                }
                onDisableAutoStart={
                  activeTaskRegistration
                    ? () => {
                        void disableAutoStart(activeTaskRegistration.taskId);
                      }
                    : undefined
                }
                autoStartBusy={autoStartBusy}
                autoStartError={autoStartError}
              />
            ) : (
              <HostOverview
                host={activeHost}
                label={activeHostRegistration?.label}
                taskCount={activeHostTasks.length}
                hostTasks={activeHostTasks}
                taskRegistrations={registry?.tasks ?? []}
                onSelectTask={(taskId) => setActiveTaskId(taskId, activeHostId ?? undefined)}
                onAddTask={registry?.hosts.length ? () => addTask() : undefined}
                onDiscoverProcesses={
                  activeHostId && window.monitor?.discoverProcesses
                    ? () => setDiscoveryHostId(activeHostId)
                    : undefined
                }
                onOpenSettings={() => setSettingsModal({ open: true, tab: 'hosts' })}
              />
            )}
          </div>
        </div>

        <EvidenceDrawer
          task={activeTask}
          sources={snapshot?.sources ?? []}
          isOpen={isEvidenceOpen}
          onClose={() => setIsEvidenceOpen(false)}
        />

        <SettingsModal
          isOpen={settingsModal.open}
          initialTab={settingsModal.tab}
          onClose={() => setSettingsModal((prev) => ({ ...prev, open: false }))}
          preferences={preferences}
          onUpdatePreferences={updatePreferences}
          isSavingPreferences={isSavingPreferences}
          registry={registry}
          onUpdateRegistry={updateRegistry}
          onReloadRegistry={reloadRegistry}
          registryError={registryError}
        />

        {taskEditor && registry && (
          <TaskEditor
            registry={registry}
            task={taskEditor.task}
            hostId={taskEditor.hostId}
            initialProcess={taskEditor.initialProcess}
            hostSnapshots={snapshot?.hosts ?? []}
            focusAutoStart={taskEditor.focusAutoStart}
            onClose={() => setTaskEditor(null)}
            onSave={updateRegistry}
            onReload={reloadRegistry}
            onSaved={(taskId, savedHostId) => {
              setActiveTaskId(taskId, savedHostId);
              setTaskEditor(null);
            }}
            onOpenSettings={() => {
              setTaskEditor(null);
              setSettingsModal({ open: true, tab: 'hosts' });
            }}
            onRequestDiscoverProcesses={
              window.monitor?.discoverProcesses
                ? (targetHostId) => {
                    setTaskEditor(null);
                    setDiscoveryHostId(targetHostId);
                  }
                : undefined
            }
          />
        )}

        {discoveryHostId && (
          <ProcessDiscoveryModal
            hostId={discoveryHostId}
            hostLabel={registry?.hosts.find((h) => h.hostId === discoveryHostId)?.label}
            onClose={() => setDiscoveryHostId(null)}
            onImport={(proc) => {
              const targetHostId = discoveryHostId;
              setDiscoveryHostId(null);
              addTask(targetHostId, proc);
            }}
          />
        )}

        {pendingForceLocal && (
          <ForceLocalReconcileModal
            taskCount={pendingForceLocal.taskCount}
            busy={forceLocalBusy}
            error={forceLocalError}
            onCancel={() => {
              if (!forceLocalBusy) {
                setPendingForceLocal(null);
                setForceLocalError(null);
              }
            }}
            onConfirm={() => void confirmForceLocal()}
          />
        )}
      </div>
    </I18nProvider>
  );
}
