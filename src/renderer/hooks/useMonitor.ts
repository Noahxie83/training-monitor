import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { projectRegistrySnapshot } from '../../shared/registry-snapshot';
import type { MonitorSnapshot, MonitorUpdate } from '../../shared/api';
import type { AlertEvent, Preferences, Registry } from '../../shared/contracts';
import { translate, type Locale } from '../i18n';

const MAX_RECENT_ALERTS = 50;

function applyDocumentTheme(nextTheme: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  if (current === nextTheme) return;
  // Disable transitions for 1 frame to guarantee zero button/surface flash on theme switch
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', nextTheme);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        root.classList.remove('theme-switching');
      });
    });
  } else {
    root.classList.remove('theme-switching');
  }
}

export function useMonitor() {
  const [cachedSnapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [selection, setSelection] = useState<{ hostId: string | null; taskId: string | null; view: 'host' | 'task' }>({
    hostId: null,
    taskId: null,
    view: 'task',
  });
  const rememberedTasks = useRef(new Map<string, string>());
  const connecting = useRef(new Set<string>());
  const [connectingHostIds, setConnectingHostIds] = useState<string[]>([]);
  const [hostConnectionErrors, setHostConnectionErrors] = useState<Record<string, string>>({});
  const [preferences, setPreferences] = useState<Preferences>({ theme: 'system' });
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [unreadAlertCount, setUnreadAlertCount] = useState<number>(0);

  const snapshot = useMemo(
    () =>
      registry
        ? projectRegistrySnapshot(
            cachedSnapshot ?? {
              version: 1,
              demo: false,
              hosts: [],
              tasks: [],
              sources: [],
            },
            registry,
          )
        : cachedSnapshot,
    [cachedSnapshot, registry],
  );

  const [registryError, setRegistryError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [preferencesSaveError, setPreferencesSaveError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false);
  const [isLoadingPreferences, setIsLoadingPreferences] = useState(false);
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const preferencesRequest = useRef(0);
  const snapshotRequest = useRef(0);
  const refreshRequest = useRef(0);
  const mountedRef = useRef(true);
  const error = snapshotError ?? preferencesError ?? preferencesSaveError ?? refreshError;
  const prevHostsRef = useRef<Map<string, string>>(new Map());

  const locale: Locale = preferences.locale === 'en-US' ? 'en-US' : 'zh-CN';

  // Apply theme to document with 1-frame anti-flash protection
  const applyTheme = useCallback((theme: 'system' | 'light' | 'dark') => {
    if (theme === 'system') {
      const isDark =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : true;
      const next = isDark ? 'dark' : 'light';
      applyDocumentTheme(next);
      setResolvedTheme(next);
    } else {
      applyDocumentTheme(theme);
      setResolvedTheme(theme);
    }
  }, []);

  // Dynamic listener for system theme changes (I12)
  useEffect(() => {
    if (preferences.theme !== 'system') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      const nextTheme = e.matches ? 'dark' : 'light';
      applyDocumentTheme(nextTheme);
      setResolvedTheme(nextTheme);
    };

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleChange);
      return () => mql.removeEventListener('change', handleChange);
    } else if (typeof (mql as any).addListener === 'function') {
      (mql as any).addListener(handleChange);
      return () => (mql as any).removeListener(handleChange);
    }
  }, [preferences.theme]);

  const retrySnapshotLoad = useCallback(async () => {
    const request = ++snapshotRequest.current;
    setIsLoadingSnapshot(true);
    setSnapshotError(null);
    try {
      const s = await window.monitor.getSnapshot();
      if (!mountedRef.current || request !== snapshotRequest.current) return;
      setSnapshot((prev) => prev ?? s);
      setLastSyncTime(new Date().toISOString());
    } catch (err: any) {
      if (mountedRef.current && request === snapshotRequest.current) {
        setSnapshotError('读取初始快照失败: ' + (err?.message || '未知错误'));
      }
    } finally {
      if (mountedRef.current && request === snapshotRequest.current) setIsLoadingSnapshot(false);
    }
  }, []);

  const retryPreferencesLoad = useCallback(async () => {
    const request = ++preferencesRequest.current;
    setIsLoadingPreferences(true);
    setIsSavingPreferences(false);
    setPreferencesError(null);
    try {
      const prefs = await window.monitor.getPreferences();
      if (!mountedRef.current || request !== preferencesRequest.current) return;
      setPreferences(prefs);
      applyTheme(prefs.theme);
    } catch (err: any) {
      if (mountedRef.current && request === preferencesRequest.current) {
        setPreferencesError('读取偏好设置失败: ' + (err?.message || '未知错误'));
      }
    } finally {
      if (mountedRef.current && request === preferencesRequest.current) setIsLoadingPreferences(false);
    }
  }, [applyTheme]);

  // Load initial data and subscribe
  useEffect(() => {
    let mounted = true;
    mountedRef.current = true;
    void retryPreferencesLoad();
    void retrySnapshotLoad();

    const stopPreferenceUpdates = window.desktop?.onPreferencesChanged((value) => {
      if (!mounted) return;
      preferencesRequest.current++;
      setPreferences(value);
      applyTheme(value.theme);
      setIsLoadingPreferences(false);
      setIsSavingPreferences(false);
      setPreferencesError(null);
      setPreferencesSaveError(null);
    });
    const stopRegistryUpdates = window.desktop?.onRegistryChanged((value) => {
      if (mounted) setRegistry((previous) => (previous && previous.revision > value.revision ? previous : value));
    });
    const stopFocusTask = window.desktop?.onFocusTask?.((taskId) => {
      if (!mounted) return;
      setSelection((current) => ({ ...current, taskId, view: 'task' }));
    });

    window.monitor
      .getRegistry()
      .then((reg) => {
        if (mounted) setRegistry((previous) => (previous && previous.revision > reg.revision ? previous : reg));
      })
      .catch((err) => {
        if (mounted) setRegistryError('读取登记配置失败: ' + (err?.message || '未知错误'));
      });

    const unsubscribe = window.monitor.subscribe((update: MonitorUpdate) => {
      if (update.kind === 'snapshot') {
        setSnapshot(update.snapshot);
        setLastSyncTime(new Date().toISOString());
        setHostConnectionErrors((previous) => {
          const next = { ...previous };
          let changed = false;
          for (const host of update.snapshot.hosts) {
            if (host.connection === 'connected' && host.freshness === 'fresh' && next[host.hostId]) {
              delete next[host.hostId];
              changed = true;
            }
          }
          return changed ? next : previous;
        });

        const prevHosts = prevHostsRef.current;
        for (const host of update.snapshot.hosts) {
          const prevConn = prevHosts.get(host.hostId);
          if (prevConn && prevConn !== host.connection) {
            setAnnouncement(`宿主 ${host.hostId} 状态变更为: ${host.connection}`);
          }
          prevHosts.set(host.hostId, host.connection);
        }
      } else if (update.kind === 'alert') {
        setAlerts((prev) => [update.alert, ...prev.filter((a) => a.alertId !== update.alert.alertId)].slice(0, MAX_RECENT_ALERTS));
        setUnreadAlertCount((c) => c + 1);
      }
    });

    return () => {
      mounted = false;
      mountedRef.current = false;
      preferencesRequest.current++;
      snapshotRequest.current++;
      refreshRequest.current++;
      unsubscribe();
      stopPreferenceUpdates?.();
      stopRegistryUpdates?.();
      stopFocusTask?.();
    };
  }, [applyTheme, retryPreferencesLoad, retrySnapshotLoad]);

  const activeHost = snapshot?.hosts.find((host) => host.hostId === selection.hostId) ?? snapshot?.hosts[0] ?? null;
  const hostTasks = snapshot?.tasks.filter((task) => task.hostId === activeHost?.hostId) ?? [];
  const activeTask =
    selection.view === 'host'
      ? null
      : (hostTasks.find((task) => task.taskId === selection.taskId) ?? hostTasks[0] ?? null);

  useEffect(() => {
    if (!snapshot) return;
    setSelection((current) => {
      const host = snapshot.hosts.find((item) => item.hostId === current.hostId) ?? snapshot.hosts[0];
      if (current.view === 'host') {
        return current.hostId === (host?.hostId ?? null)
          ? current
          : { hostId: host?.hostId ?? null, taskId: null, view: 'host' };
      }
      const tasks = host ? snapshot.tasks.filter((task) => task.hostId === host.hostId) : [];
      const taskId =
        tasks.find((task) => task.taskId === rememberedTasks.current.get(host?.hostId ?? ''))?.taskId ??
        tasks.find((task) => task.taskId === current.taskId)?.taskId ??
        tasks[0]?.taskId ??
        null;
      const hostId = host?.hostId ?? null;
      return current.hostId === hostId && current.taskId === taskId ? current : { hostId, taskId, view: 'task' };
    });
  }, [snapshot]);

  const selectHost = useCallback(
    (hostId: string) => {
      if (!snapshot?.hosts.some((host) => host.hostId === hostId)) return;
      setSelection({ hostId, taskId: null, view: 'host' });
    },
    [snapshot],
  );

  const selectTask = useCallback(
    (taskId: string, hostId?: string) => {
      const task = snapshot?.tasks.find((item) => item.taskId === taskId);
      const targetHostId = task?.hostId ?? hostId;
      if (!targetHostId || !snapshot?.hosts.some((host) => host.hostId === targetHostId)) return;
      rememberedTasks.current.set(targetHostId, taskId);
      setSelection({ hostId: targetHostId, taskId, view: 'task' });
    },
    [snapshot],
  );

  const connectHost = useCallback(
    async (hostId: string) => {
      if (connecting.current.has(hostId)) return;
      const host = registry?.hosts.find((item) => item.hostId === hostId);
      if (!host?.enabled) return;
      connecting.current.add(hostId);
      setConnectingHostIds([...connecting.current]);
      setHostConnectionErrors((previous) => ({ ...previous, [hostId]: '' }));
      try {
        await window.monitor.requestRefresh({ hostId });
        if (mountedRef.current) setAnnouncement(`宿主 ${hostId} 已完成连接检测`);
      } catch (reason) {
        if (mountedRef.current) {
          setHostConnectionErrors((previous) => ({
            ...previous,
            [hostId]: reason instanceof Error ? reason.message : String(reason),
          }));
        }
      } finally {
        connecting.current.delete(hostId);
        if (mountedRef.current) setConnectingHostIds([...connecting.current]);
      }
    },
    [registry],
  );

  const updatePreferences = useCallback(
    async (newPrefs: Preferences) => {
      const request = ++preferencesRequest.current;
      setIsLoadingPreferences(false);
      setIsSavingPreferences(true);
      setPreferencesSaveError(null);
      try {
        const saved = await window.monitor.savePreferences(newPrefs);
        if (!mountedRef.current || request !== preferencesRequest.current) return;
        setPreferences(saved);
        applyTheme(saved.theme);
        setPreferencesError(null);
        setAnnouncement('偏好设置已保存');
      } catch (err: any) {
        if (!mountedRef.current || request !== preferencesRequest.current) return;
        setPreferencesSaveError('保存偏好设置失败: ' + (err?.message || '未知错误'));
        throw err;
      } finally {
        if (mountedRef.current && request === preferencesRequest.current) setIsSavingPreferences(false);
      }
    },
    [applyTheme],
  );

  const updateRegistry = useCallback(async (newRegistry: Registry) => {
    setRegistryError(null);
    try {
      const saved = await window.monitor.saveRegistry(newRegistry);
      setRegistry(saved);
      setAnnouncement('登记配置已成功保存');
      return saved;
    } catch (err: any) {
      const message = err?.message || '保存登记配置失败，可能存在版本冲突或格式错误';
      const reconcile = /HOST_UNREACHABLE_RECONCILE:(\d+)/.exec(message);
      if (reconcile) {
        const localized = translate(preferences.locale ?? 'zh-CN', 'errors.HOST_UNREACHABLE_RECONCILE',
          { taskCount: Number(reconcile[1]) });
        setRegistryError(localized);
        throw new Error(localized);
      }
      setRegistryError(message);
      throw err;
    }
  }, [preferences.locale]);

  const reloadRegistry = useCallback(async () => {
    setRegistryError(null);
    try {
      const reg = await window.monitor.getRegistry();
      setRegistry(reg);
      return reg;
    } catch (err: any) {
      const msg = err?.message || '重新加载登记配置失败';
      setRegistryError(msg);
      throw err;
    }
  }, []);

  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      await window.monitor.requestRefresh({});
      if (mountedRef.current && request === refreshRequest.current) setAnnouncement('已刷新监控观测数据');
    } catch (err: any) {
      if (mountedRef.current && request === refreshRequest.current) {
        setRefreshError('刷新观测数据失败: ' + (err?.message || '未知错误'));
      }
    } finally {
      if (mountedRef.current && request === refreshRequest.current) setIsRefreshing(false);
    }
  }, []);

  const markAlertsRead = useCallback(() => {
    setUnreadAlertCount(0);
    void window.desktop?.clearAlerts?.().catch(() => undefined);
  }, []);
  const clearAlerts = useCallback(() => {
    setAlerts([]);
    markAlertsRead();
  }, [markAlertsRead]);

  return {
    snapshot,
    activeTask,
    activeTaskId: activeTask?.taskId ?? null,
    setActiveTaskId: selectTask,
    activeHost,
    activeHostId: activeHost?.hostId ?? null,
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
    error,
    announcement,
    lastSyncTime,
    alerts,
    unreadAlertCount,
    markAlertsRead,
    clearAlerts,
  };
}
