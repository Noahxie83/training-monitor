import React, { useState, useLayoutEffect, useRef } from "react";
import { useMonitor } from "./hooks/useMonitor";
import { Header } from "./components/Header";
import { TaskFleetTree } from "./components/TaskFleetTree";
import { TaskCockpit } from "./components/TaskCockpit";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { SettingsModal } from "./components/SettingsModal";
import { TaskEditor } from './components/TaskEditor';
import { HostConnectionPanel } from './components/HostConnectionPanel';
import { HostOverview } from './components/HostOverview';
import type { TaskSnapshot, TaskRegistration } from "../shared/contracts";
import { taskAlgorithmName } from '../shared/task-profile';
import { newAutoStartArmId } from './components/AutoStartFields';

export function App() {
  const {
    snapshot,
    activeTask,
    activeTaskId,
    setActiveTaskId,
    activeHost, activeHostId, selectHost, connectHost, connectingHostIds, hostConnectionErrors,
    preferences,
    resolvedTheme,
    updatePreferences,
    registry,
    registryError,
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
    error,
  } = useMonitor();

  const [isEvidenceOpen, setIsEvidenceOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [taskEditor, setTaskEditor] = useState<{ task: TaskRegistration | null; hostId?: string; focusAutoStart?: boolean } | null>(null);
  const [removingTask, setRemovingTask] = useState(false);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  const [autoStartError, setAutoStartError] = useState<string | null>(null);
  const [gpuWindowError, setGpuWindowError] = useState<string | null>(null);
  const openGpu = () => {
    setGpuWindowError(null);
    void window.desktop?.openGpuWindow(activeHostId ?? undefined).catch(() => setGpuWindowError('打开 GPU 监控窗口失败，请重试。'));
  };
  const addTask = (hostId?: string) => { setTaskActionError(null); setTaskEditor({ task: null, hostId: hostId ?? activeHostId ?? undefined }); };
  const configureAutoStart = (taskId: string) => {
    const task = registry?.tasks.find(item => item.taskId === taskId);
    if (!task) return;
    setTaskActionError(null); setAutoStartError(null);
    setTaskEditor({ task, focusAutoStart: true });
  };
  /** A new arm id restarts the idle countdown without touching the saved configuration. */
  const rearmAutoStart = async (taskId: string) => {
    if (!registry || autoStartBusy) return;
    const task = registry.tasks.find(item => item.taskId === taskId);
    if (!task?.autoStart) return;
    setAutoStartBusy(true); setAutoStartError(null);
    try {
      await updateRegistry({
        ...registry,
        tasks: registry.tasks.map(item => item.taskId === taskId
          ? { ...item, autoStart: { ...item.autoStart!, execution: 'server_tmux' as const, gpuDeviceIds: [], armId: newAutoStartArmId() } }
          : item),
      });
    } catch (reason) {
      setAutoStartError(reason instanceof Error ? reason.message : String(reason));
    } finally { setAutoStartBusy(false); }
  };
  /** Disabling never stops a running training process; it only removes the automatic trigger. */
  const disableAutoStart = async (taskId: string) => {
    if (!registry || autoStartBusy) return;
    const task = registry.tasks.find(item => item.taskId === taskId);
    if (!task?.autoStart) return;
    setAutoStartBusy(true); setAutoStartError(null);
    try {
      await updateRegistry({
        ...registry,
        tasks: registry.tasks.map(item => item.taskId === taskId
          ? { ...item, autoStart: { ...item.autoStart!, enabled: false } }
          : item),
      });
    } catch (reason) {
      setAutoStartError(reason instanceof Error ? reason.message : String(reason));
    } finally { setAutoStartBusy(false); }
  };
  const removeTask = async (taskId: string) => {
    if (!registry || removingTask) return;
    setRemovingTask(true); setTaskActionError(null);
    try {
      await updateRegistry({ ...registry, tasks: registry.tasks.filter(task => task.taskId !== taskId) });
      document.querySelector<HTMLButtonElement>('.fleet-header button')?.focus();
    } catch (reason) { setTaskActionError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRemovingTask(false); }
  };

  // Flatten tasks in fleet display order for Ctrl+1~9
  const orderedTasks: TaskSnapshot[] = [];
  if (snapshot) {
    const hostMap = new Map<string, TaskSnapshot[]>();
    for (const h of snapshot.hosts) {
      hostMap.set(h.hostId, []);
    }
    for (const t of snapshot.tasks) {
      const list = hostMap.get(t.hostId);
      if (list) list.push(t);
      else hostMap.set(t.hostId, [t]);
    }
    for (const list of hostMap.values()) {
      orderedTasks.push(...list);
    }
  }

  // Keyboard shortcuts: Ctrl+R, Ctrl+1~9, Esc with strict guards (I14)
  const shortcutStateRef = useRef({
    orderedTasks,
    refresh,
    setActiveTaskId,
    isSettingsOpen,
    isEvidenceOpen,
    taskEditor,
  });
  shortcutStateRef.current = {
    orderedTasks,
    refresh,
    setActiveTaskId,
    isSettingsOpen,
    isEvidenceOpen,
    taskEditor,
  };

  useLayoutEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const state = shortcutStateRef.current;
      // If modal or drawer is open, or during IME, or in text input, do not trigger global navigation shortcuts
      const activeEl = document.activeElement;
      const targetEl = e.target as HTMLElement | null;
      const isInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl as HTMLElement)?.isContentEditable ||
        (activeEl as any)?.contentEditable === "true" ||
        (activeEl as HTMLElement)?.getAttribute?.("contenteditable") === "true" ||
        targetEl instanceof HTMLInputElement ||
        targetEl instanceof HTMLTextAreaElement ||
        targetEl instanceof HTMLSelectElement ||
        targetEl?.isContentEditable ||
        (targetEl as any)?.contentEditable === "true" ||
        targetEl?.getAttribute?.("contenteditable") === "true";
      const isComposing = (e as any).isComposing === true || e.keyCode === 229;

      // Esc -> Close overlays
      if (e.key === "Escape") {
        if (isComposing) return;
        if (state.isEvidenceOpen) {
          setIsEvidenceOpen(false);
          return;
        }
        if (state.isSettingsOpen) {
          setIsSettingsOpen(false);
          return;
        }
      }

      if (state.isSettingsOpen || state.isEvidenceOpen || state.taskEditor || isInput || isComposing) {
        return;
      }

      // Ctrl+R -> Refresh
      if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        state.refresh();
        return;
      }

      // Ctrl+1~9 -> Switch task
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const index = parseInt(e.key, 10) - 1;
        if (index < state.orderedTasks.length && state.orderedTasks[index]) {
          e.preventDefault();
          state.setActiveTaskId(state.orderedTasks[index].taskId);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const activeTaskRegistration =
    registry?.tasks.find((t) => t.taskId === activeTaskId) ?? null;

  return (
    <div className="app-shell" data-theme={resolvedTheme}>
      <Header
        theme={resolvedTheme}
        onToggleTheme={() => { void updatePreferences({ theme: resolvedTheme === 'light' ? 'dark' : 'light' }).catch(() => undefined); }}
        isSavingTheme={isSavingPreferences}
        hosts={snapshot?.hosts ?? []}
        activeHostId={activeHostId}
        onSelectHost={selectHost}
        isDemo={Boolean(snapshot?.demo)}
        lastSyncTime={lastSyncTime}
        onRefresh={refresh}
        isRefreshing={isRefreshing}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenGpu={window.desktop ? openGpu : undefined}
        announcement={announcement}
      />

      {(isLoadingSnapshot || isLoadingPreferences || isSavingPreferences) && (
        <div role="status">
          {isLoadingSnapshot && <span>正在读取监控快照…</span>}
          {isLoadingPreferences && <span>正在读取偏好设置…</span>}
          {isSavingPreferences && <span>正在保存偏好设置…</span>}
        </div>
      )}
      {[snapshotError, preferencesError, preferencesSaveError, refreshError].filter(Boolean).map((message) => (
        <div key={message} className="global-error-banner alert alert-danger" role="alert">
          <span>{message}</span>
          {message === snapshotError && <button type="button" className="btn btn-secondary btn-sm" onClick={retrySnapshotLoad}>重试</button>}
          {message === preferencesError && <button type="button" className="btn btn-secondary btn-sm" onClick={retryPreferencesLoad}>重试读取偏好设置</button>}
          {message === refreshError && <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>重试刷新</button>}
        </div>
      ))}
      {(taskActionError || (registryError && !isSettingsOpen && !taskEditor)) && <div className="global-error-banner alert alert-danger" role="alert">
        <span>{taskActionError || registryError}</span>
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => { void reloadRegistry().then(() => setTaskActionError(null)).catch(() => undefined); }}>重新加载配置</button>
      </div>}
      {gpuWindowError && <div className="global-error-banner alert alert-danger" role="alert"><span>{gpuWindowError}</span><button type="button" className="btn btn-secondary btn-sm" onClick={openGpu}>重试打开</button></div>}

      <div className="app-body">
        <TaskFleetTree
          hosts={snapshot?.hosts ?? []}
          tasks={snapshot?.tasks ?? []}
          activeTaskId={activeTaskId}
          activeHostId={activeHostId}
          onSelectHost={selectHost}
          onConnectHost={registry ? connectHost : undefined}
          connectingHostIds={connectingHostIds}
          disabledHostIds={registry?.hosts.filter(host => !host.enabled).map(host => host.hostId)}
          onSelectTask={setActiveTaskId}
          registrations={registry?.tasks}
          onAddTask={registry ? addTask : undefined}
          onEditTask={taskId => {
            const task = registry?.tasks.find(item => item.taskId === taskId);
            if (task) { setTaskActionError(null); setTaskEditor({ task }); }
          }}
          onRemoveTask={removeTask}
          isSaving={removingTask}
        />

        <div className="host-workspace">
        {activeHost && <HostConnectionPanel
          host={activeHost} registration={registry?.hosts.find(host => host.hostId === activeHostId)}
          connecting={connectingHostIds.includes(activeHost.hostId)} error={hostConnectionErrors[activeHost.hostId]}
          onConnect={() => { void connectHost(activeHost.hostId); }} onOpenSettings={() => setIsSettingsOpen(true)}
        />}
        {activeTask ? <TaskCockpit
          task={activeTask}
          host={activeHost}
          sources={snapshot?.sources ?? []}
          onOpenEvidence={() => setIsEvidenceOpen(true)}
          onRefresh={refresh}
          onOpenSettings={registry ? () => addTask() : undefined}
          algorithm={activeTaskRegistration?.algorithm}
          algorithmName={activeTaskRegistration ? taskAlgorithmName(activeTaskRegistration) : undefined}
          taskLabel={activeTaskRegistration?.label}
          autoStartConfig={activeTaskRegistration?.autoStart ?? null}
          hostSnapshots={snapshot?.hosts ?? []}
          onConfigureAutoStart={activeTaskRegistration ? () => configureAutoStart(activeTaskRegistration.taskId) : undefined}
          onRearmAutoStart={activeTaskRegistration ? () => { void rearmAutoStart(activeTaskRegistration.taskId); } : undefined}
          onDisableAutoStart={activeTaskRegistration ? () => { void disableAutoStart(activeTaskRegistration.taskId); } : undefined}
          autoStartBusy={autoStartBusy}
          autoStartError={autoStartError}
        /> : <HostOverview host={activeHost} label={registry?.hosts.find(host => host.hostId === activeHostId)?.label}
          taskCount={snapshot?.tasks.filter(task => task.hostId === activeHostId).length ?? 0}
          onAddTask={registry?.hosts.length ? () => addTask() : undefined} />}
        </div>
      </div>

      <EvidenceDrawer
        task={activeTask}
        isOpen={isEvidenceOpen}
        onClose={() => setIsEvidenceOpen(false)}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        preferences={preferences}
        onUpdatePreferences={updatePreferences}
        registry={registry}
        onUpdateRegistry={updateRegistry}
        onReloadRegistry={reloadRegistry}
        registryError={registryError}
      />
      {taskEditor && registry && <TaskEditor
        registry={registry} task={taskEditor.task} hostId={taskEditor.hostId}
        hostSnapshots={snapshot?.hosts ?? []}
        focusAutoStart={taskEditor.focusAutoStart}
        onClose={() => setTaskEditor(null)} onSave={updateRegistry} onReload={reloadRegistry}
        onSaved={(taskId, hostId) => { setActiveTaskId(taskId, hostId); setTaskEditor(null); }}
        onOpenSettings={() => { setTaskEditor(null); setIsSettingsOpen(true); }}
      />}
    </div>
  );
}
