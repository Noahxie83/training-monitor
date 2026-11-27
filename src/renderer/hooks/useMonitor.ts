import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { projectRegistrySnapshot } from '../../shared/registry-snapshot';
import type { MonitorSnapshot, MonitorUpdate } from '../../shared/api';
import type { AlertEvent, Preferences, Registry, SaveRegistryOptions } from '../../shared/contracts';
import { translate, type Locale } from '../i18n';

const MAX_RECENT_ALERTS = 50;

export class HostUnreachableReconcileClientError extends Error {
  readonly code = 'HOST_UNREACHABLE_RECONCILE' as const;
  readonly errorCode = 'HOST_UNREACHABLE_RECONCILE' as const;
  readonly taskCount: number;

  constructor(taskCount: number, message: string) {
    super(message);
    this.name = 'HostUnreachableReconcileClientError';
    this.taskCount = taskCount;
  }
}

export function parseHostUnreachableReconcileError(err: unknown): { taskCount: number } | null {
  if (!err) return null;
  if (err instanceof HostUnreachableReconcileClientError) {
    return { taskCount: err.taskCount };
  }
  const obj = err as {
    code?: unknown;
    errorCode?: unknown;
    errorParams?: { taskCount?: unknown };
    message?: unknown;
  };
  if (obj.errorCode === 'HOST_UNREACHABLE_RECONCILE' || obj.code === 'HOST_UNREACHABLE_RECONCILE') {
    const count = Number(obj.errorParams?.taskCount);
    return { taskCount: Number.isSafeInteger(count) && count > 0 ? count : 1 };
  }
  const msg = typeof obj.message === 'string' ? obj.message : String(err);
  const match = /HOST_UNREACHABLE_RECONCILE(?::(\d+))?/.exec(msg);
  if (match) {
    const count = match[1] ? Number(match[1]) : 1;
    return { taskCount: Number.isSafeInteger(count) && count > 0 ? count : 1 };
  }
  return null;
}

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
  const pendingFocusRef = useRef<{ taskId: string; hostId?: string } | null>(null);
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

  const snapshotRef = useRef<MonitorSnapshot | null>(snapshot);
  snapshotRef.current = snapshot;

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
  const localeRef = useRef<Locale>(locale);
  localeRef.current = locale;
  const themePreferenceRef = useRef<Preferences['theme']>(preferences.theme);
  themePreferenceRef.current = preferences.theme;

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
      if (themePreferenceRef.current !== 'system') return;
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
        const loc = localeRef.current;
        setSnapshotError(
          translate(loc, 'monitor.loadSnapshotFailed', {
            reason: err?.message || translate(loc, 'app.unknownError'),
          }),
        );
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
      localeRef.current = prefs.locale === 'en-US' ? 'en-US' : 'zh-CN';
      themePreferenceRef.current = prefs.theme;
      setPreferences(prefs);
      applyTheme(prefs.theme);
    } catch (err: any) {
      if (mountedRef.current && request === preferencesRequest.current) {
        const loc = localeRef.current;
        setPreferencesError(
          translate(loc, 'monitor.loadPreferencesFailed', {
            reason: err?.message || translate(loc, 'app.unknownError'),
          }),
        );
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
      localeRef.current = value.locale === 'en-US' ? 'en-US' : 'zh-CN';
      themePreferenceRef.current = value.theme;
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
    const stopFocusTask = window.desktop?.onFocusTask?.((taskId, explicitHostId) => {
      if (!mounted) return;
      const latest = snapshotRef.current;
      const foundTask = latest?.tasks.find((item) => item.taskId === taskId);
      const resolvedHostId = foundTask?.hostId ?? explicitHostId ?? null;
      if (resolvedHostId) {
        rememberedTasks.current.set(resolvedHostId, taskId);
        pendingFocusRef.current = foundTask ? null : { taskId, hostId: resolvedHostId };
        setSelection({ hostId: resolvedHostId, taskId, view: 'task' });
      } else {
        pendingFocusRef.current = { taskId };
        setSelection((current) => ({ ...current, taskId, view: 'task' }));
      }
    });

    window.monitor
      .getRegistry()
      .then((reg) => {
        if (mounted) setRegistry((previous) => (previous && previous.revision > reg.revision ? previous : reg));
      })
      .catch((err) => {
        if (mounted) {
          const loc = localeRef.current;
          setRegistryError(
            translate(loc, 'monitor.loadRegistryFailed', {
              reason: err?.message || translate(loc, 'app.unknownError'),
            }),
          );
        }
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
            setAnnouncement(
              translate(localeRef.current, 'monitor.hostStatusChanged', {
                hostId: host.hostId,
                status: host.connection,
              }),
            );
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
      const pending = pendingFocusRef.current;
      if (pending) {
        const focusedTask = snapshot.tasks.find((item) => item.taskId === pending.taskId);
        if (focusedTask) {
          pendingFocusRef.current = null;
          rememberedTasks.current.set(focusedTask.hostId, focusedTask.taskId);
          return current.hostId === focusedTask.hostId && current.taskId === focusedTask.taskId && current.view === 'task'
            ? current
            : { hostId: focusedTask.hostId, taskId: focusedTask.taskId, view: 'task' };
        }
      }

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
      pendingFocusRef.current = null;
      setSelection({ hostId, taskId: null, view: 'host' });
    },
    [snapshot],
  );

  const selectTask = useCallback(
    (taskId: string, hostId?: string) => {
      const task = snapshot?.tasks.find((item) => item.taskId === taskId);
      const targetHostId = task?.hostId ?? hostId;
      if (!targetHostId || !snapshot?.hosts.some((host) => host.hostId === targetHostId)) return;
      pendingFocusRef.current = null;
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
        if (mountedRef.current) {
          setAnnouncement(translate(localeRef.current, 'monitor.hostCheckDone', { hostId }));
        }
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
        const nextLocale: Locale = saved.locale === 'en-US' ? 'en-US' : 'zh-CN';
        localeRef.current = nextLocale;
        themePreferenceRef.current = saved.theme;
        setPreferences(saved);
        applyTheme(saved.theme);
        setPreferencesError(null);
        setAnnouncement(translate(nextLocale, 'monitor.preferencesSaved'));
      } catch (err: any) {
        if (!mountedRef.current || request !== preferencesRequest.current) return;
        const loc = localeRef.current;
        setPreferencesSaveError(
          translate(loc, 'monitor.savePreferencesFailed', {
            reason: err?.message || translate(loc, 'app.unknownError'),
          }),
        );
        throw err;
      } finally {
        if (mountedRef.current && request === preferencesRequest.current) setIsSavingPreferences(false);
      }
    },
    [applyTheme],
  );

  const updateRegistry = useCallback(async (newRegistry: Registry, options?: SaveRegistryOptions) => {
    setRegistryError(null);
    try {
      const saved = options
        ? await window.monitor.saveRegistry(newRegistry, options)
        : await window.monitor.saveRegistry(newRegistry);
      setRegistry(saved);
      setAnnouncement(translate(localeRef.current, 'monitor.registrySaved'));
      return saved;
    } catch (err: any) {
      const loc = localeRef.current;
      const reconcile = parseHostUnreachableReconcileError(err);
      if (reconcile) {
        const localized = translate(loc, 'errors.HOST_UNREACHABLE_RECONCILE', {
          taskCount: reconcile.taskCount,
        });
        throw new HostUnreachableReconcileClientError(reconcile.taskCount, localized);
      }
      const message = err?.message || translate(loc, 'monitor.saveRegistryFailed');
      setRegistryError(message);
      throw err;
    }
  }, []);

  const reloadRegistry = useCallback(async () => {
    setRegistryError(null);
    try {
      const reg = await window.monitor.getRegistry();
      setRegistry(reg);
      return reg;
    } catch (err: any) {
      const msg = err?.message || translate(localeRef.current, 'monitor.reloadRegistryFailed');
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
      if (mountedRef.current && request === refreshRequest.current) {
        setAnnouncement(translate(localeRef.current, 'monitor.refreshed'));
      }
    } catch (err: any) {
      if (mountedRef.current && request === refreshRequest.current) {
        const loc = localeRef.current;
        setRefreshError(
          translate(loc, 'monitor.refreshFailed', {
            reason: err?.message || translate(loc, 'app.unknownError'),
          }),
        );
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
