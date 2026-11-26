import React, { useEffect, useRef, useState } from 'react';
import type {
  AlertEventKind,
  AlertPreferences,
  DiscoveredSshHost,
  DiscoveredWslDistro,
  HostKind,
  HostRegistration,
  HostTarget,
  Preferences,
  Registry,
  TaskRegistration,
  WebhookChannelConfig,
} from '../../shared/contracts';
import { isValidAbsolutePath, validateHostTarget } from '../../shared/validate';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n, type Locale } from '../i18n';
import { Icon } from './Icon';

export type SettingsTab = 'appearance' | 'hosts' | 'alerts';

interface SettingsModalProps {
  isOpen: boolean;
  initialTab?: SettingsTab;
  onClose: () => void;
  preferences: Preferences;
  onUpdatePreferences: (newPrefs: Preferences) => Promise<Preferences | void> | void;
  isSavingPreferences?: boolean;
  registry: Registry | null;
  onUpdateRegistry: (newRegistry: Registry) => Promise<Registry | void> | void;
  onReloadRegistry?: () => Promise<Registry | void> | void;
  registryError?: string | null;
}

interface TargetFormState {
  sshAlias: string;
  sshHostname: string;
  sshUser: string;
  sshPort: string;
  sshIdentityFile: string;
  sshProxyJump: string;
  wslDistribution: string;
  pythonPath: string;
}

const EMPTY_TARGET_FORM: TargetFormState = {
  sshAlias: '',
  sshHostname: '',
  sshUser: '',
  sshPort: '',
  sshIdentityFile: '',
  sshProxyJump: '',
  wslDistribution: '',
  pythonPath: '',
};

const ALL_ALERT_KINDS: AlertEventKind[] = [
  'cuda_oom',
  'process_crashed',
  'loss_nan_inf',
  'training_stalled',
  'training_completed',
  'host_disconnected',
];

function targetToFormState(target: HostTarget): TargetFormState {
  if (target.kind === 'ssh') {
    return {
      sshAlias: target.alias ?? '',
      sshHostname: target.hostname ?? '',
      sshUser: target.user ?? '',
      sshPort: target.port !== undefined ? String(target.port) : '',
      sshIdentityFile: target.identityFile ?? '',
      sshProxyJump: target.proxyJump ?? '',
      wslDistribution: '',
      pythonPath: target.pythonPath ?? '',
    };
  }
  if (target.kind === 'wsl') {
    return {
      ...EMPTY_TARGET_FORM,
      wslDistribution: target.distribution,
      pythonPath: target.pythonPath ?? '',
    };
  }
  return {
    ...EMPTY_TARGET_FORM,
    pythonPath: target.pythonPath ?? '',
  };
}

function buildAndValidateTarget(
  kind: HostKind,
  fields: TargetFormState,
): { target: HostTarget | null; error: string | null } {
  const pythonPath = fields.pythonPath.trim();
  if (kind === 'ssh') {
    const alias = fields.sshAlias.trim();
    const hostname = fields.sshHostname.trim();
    const user = fields.sshUser.trim();
    const portRaw = fields.sshPort.trim();
    const identityFile = fields.sshIdentityFile.trim();
    const proxyJump = fields.sshProxyJump.trim();

    if (!alias && !hostname) {
      return { target: null, error: 'SSH 宿主需填写别名 (Alias) 或主机地址 (HostName)' };
    }
    let port: number | undefined;
    if (portRaw) {
      if (!/^\d+$/.test(portRaw)) {
        return { target: null, error: 'SSH 端口必须为 1–65535 之间的整数' };
      }
      port = Number(portRaw);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        return { target: null, error: 'SSH 端口必须为 1–65535 之间的整数' };
      }
    }
    const candidate: HostTarget = {
      kind: 'ssh',
      ...(alias ? { alias } : {}),
      ...(hostname ? { hostname } : {}),
      ...(user ? { user } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(identityFile ? { identityFile } : {}),
      ...(proxyJump ? { proxyJump } : {}),
      ...(pythonPath ? { pythonPath } : {}),
    };
    try {
      return { target: validateHostTarget(candidate), error: null };
    } catch {
      return { target: null, error: 'SSH 连接参数无效（不允许以 - 开头或包含空白/危险字符）' };
    }
  }

  if (kind === 'wsl') {
    const distribution = fields.wslDistribution.trim();
    if (!distribution) {
      return { target: null, error: 'WSL 宿主必须填写发行版名称' };
    }
    const candidate: HostTarget = {
      kind: 'wsl',
      distribution,
      ...(pythonPath ? { pythonPath } : {}),
    };
    try {
      return { target: validateHostTarget(candidate), error: null };
    } catch {
      return { target: null, error: 'WSL 发行版名称或 Python 路径无效' };
    }
  }

  const candidate: HostTarget = {
    kind: 'local',
    ...(pythonPath ? { pythonPath } : {}),
  };
  try {
    return { target: validateHostTarget(candidate), error: null };
  } catch {
    return { target: null, error: '本机 Python 路径无效' };
  }
}

function summarizeTarget(target: HostTarget): string {
  if (target.kind === 'ssh') {
    if (target.alias) return target.hostname ? `${target.alias} (${target.hostname})` : target.alias;
    const hostPart = target.user ? `${target.user}@${target.hostname ?? ''}` : (target.hostname ?? '');
    return target.port ? `${hostPart}:${target.port}` : hostPart;
  }
  if (target.kind === 'wsl') return target.distribution;
  return target.pythonPath ? `local (${target.pythonPath})` : 'local';
}

function parseRoots(raw: string, allowWindowsDrive: boolean): { roots: string[] | null; error: string | null } {
  const roots = raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const r of roots) {
    if (!isValidAbsolutePath(r, allowWindowsDrive)) {
      return {
        roots: null,
        error: allowWindowsDrive
          ? '白名单根目录必须为绝对路径（如 /workspace 或 C:\\Projects）'
          : '白名单根目录路径必须以 / 开头',
      };
    }
  }
  return { roots, error: null };
}

function parsePollSeconds(raw: string): { pollIntervalMs?: number; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { pollIntervalMs: undefined, error: null };
  const sec = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(sec) || sec < 2 || sec > 60) {
    return { error: '轮询间隔需为 2–60 秒之间的整数' };
  }
  return { pollIntervalMs: sec * 1000, error: null };
}

export function SettingsModal({
  isOpen,
  initialTab = 'appearance',
  onClose,
  preferences,
  onUpdatePreferences,
  isSavingPreferences = false,
  registry,
  onUpdateRegistry,
  onReloadRegistry,
  registryError: externalError,
}: SettingsModalProps) {
  const { t } = useI18n();
  const containerRef = useFocusTrap(isOpen, onClose);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // Registry editing state
  const [hosts, setHosts] = useState<HostRegistration[]>([]);
  const [tasks, setTasks] = useState<TaskRegistration[]>([]);
  const [currentRevision, setCurrentRevision] = useState<number>(0);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isReloading, setIsReloading] = useState<boolean>(false);
  const [isConflict, setIsConflict] = useState<boolean>(false);
  const [internalError, setInternalError] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  const prefRequest = useRef(0);

  // Delete host confirmation modal state
  const [pendingDeleteHost, setPendingDeleteHost] = useState<{ host: HostRegistration; taskCount: number } | null>(null);

  // Add Host form state
  const [isAddingHost, setIsAddingHost] = useState(false);
  const [newHostId, setNewHostId] = useState('');
  const [newHostLabel, setNewHostLabel] = useState('');
  const [newHostKind, setNewHostKind] = useState<HostKind>('ssh');
  const [newHostRoots, setNewHostRoots] = useState('');
  const [newHostPollSec, setNewHostPollSec] = useState('5');
  const [newHostAllowJobControl, setNewHostAllowJobControl] = useState(false);
  const [newTargetFields, setNewTargetFields] = useState<TargetFormState>({ ...EMPTY_TARGET_FORM });

  // Discovery state
  const [discoveredSsh, setDiscoveredSsh] = useState<DiscoveredSshHost[]>([]);
  const [discoveredWsl, setDiscoveredWsl] = useState<DiscoveredWslDistro[]>([]);
  const [discoveringSsh, setDiscoveringSsh] = useState(false);
  const [discoveringWsl, setDiscoveringWsl] = useState(false);
  const [discoveryNotice, setDiscoveryNotice] = useState<string | null>(null);

  // Edit Host state
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editHostLabel, setEditHostLabel] = useState('');
  const [editHostKind, setEditHostKind] = useState<HostKind>('ssh');
  const [editHostRoots, setEditHostRoots] = useState('');
  const [editHostPollSec, setEditHostPollSec] = useState('5');
  const [editHostAllowJobControl, setEditHostAllowJobControl] = useState(false);
  const [editTargetFields, setEditTargetFields] = useState<TargetFormState>({ ...EMPTY_TARGET_FORM });

  // Alerts tab draft state
  const [alertDraft, setAlertDraft] = useState<AlertPreferences>(() => ({
    desktopNotifications: preferences.alerts?.desktopNotifications ?? true,
    stallThresholdMinutes: preferences.alerts?.stallThresholdMinutes ?? 15,
    hostDisconnectThresholdSeconds: preferences.alerts?.hostDisconnectThresholdSeconds ?? 30,
    cooldownSeconds: preferences.alerts?.cooldownSeconds ?? 300,
    enabledKinds: preferences.alerts?.enabledKinds ?? [...ALL_ALERT_KINDS],
    webhooks: preferences.alerts?.webhooks ? structuredClone(preferences.alerts.webhooks) : [],
  }));
  const [alertSaved, setAlertSaved] = useState(false);
  const [testingWebhookIdx, setTestingWebhookIdx] = useState<number | null>(null);
  const [webhookResults, setWebhookResults] = useState<Record<number, { ok: boolean; text: string }>>({});

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      setAlertDraft({
        desktopNotifications: preferences.alerts?.desktopNotifications ?? true,
        stallThresholdMinutes: preferences.alerts?.stallThresholdMinutes ?? 15,
        hostDisconnectThresholdSeconds: preferences.alerts?.hostDisconnectThresholdSeconds ?? 30,
        cooldownSeconds: preferences.alerts?.cooldownSeconds ?? 300,
        enabledKinds: preferences.alerts?.enabledKinds ?? [...ALL_ALERT_KINDS],
        webhooks: preferences.alerts?.webhooks ? structuredClone(preferences.alerts.webhooks) : [],
      });
      setAlertSaved(false);
      setWebhookResults({});
    }
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (registry) {
      setHosts(structuredClone(registry.hosts));
      setTasks(structuredClone(registry.tasks));
      setCurrentRevision(registry.revision);
    } else {
      setHosts([]);
      setTasks([]);
      setCurrentRevision(0);
    }
    setEditingHostId(null);
    setPendingDeleteHost(null);
    setValidationError(null);
    setSaveSuccess(false);
    setInternalError(null);
    setIsConflict(false);
    setDiscoveryNotice(null);
  }, [registry, isOpen]);

  useEffect(() => {
    setThemeError(null);
    return () => {
      prefRequest.current++;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const updateNewTarget = (key: keyof TargetFormState, value: string) =>
    setNewTargetFields((prev) => ({ ...prev, [key]: value }));

  const updateEditTarget = (key: keyof TargetFormState, value: string) =>
    setEditTargetFields((prev) => ({ ...prev, [key]: value }));

  const savePreferencePatch = async (patch: Partial<Preferences>) => {
    const request = ++prefRequest.current;
    setThemeError(null);
    try {
      await Promise.resolve(onUpdatePreferences({ ...preferences, ...patch }));
      return true;
    } catch (err: any) {
      if (request === prefRequest.current) {
        setThemeError(err?.message || '更新偏好失败');
      }
      return false;
    }
  };

  const handleDiscoverSsh = async () => {
    if (!window.desktop?.discoverSshHosts) {
      setDiscoveryNotice('当前环境不支持自动读取 ~/.ssh/config');
      return;
    }
    setDiscoveringSsh(true);
    setDiscoveryNotice(null);
    try {
      const entries = await window.desktop.discoverSshHosts();
      setDiscoveredSsh(entries);
      if (entries.length === 0) setDiscoveryNotice('未在 ~/.ssh/config 中发现可用宿主别名');
    } catch {
      setDiscoveryNotice('读取 ~/.ssh/config 失败，请手动输入连接信息');
    } finally {
      setDiscoveringSsh(false);
    }
  };

  const applyDiscoveredSsh = (item: DiscoveredSshHost) => {
    setNewHostKind('ssh');
    if (!newHostId.trim()) setNewHostId(item.alias);
    if (!newHostLabel.trim()) setNewHostLabel(item.alias);
    setNewTargetFields((prev) => ({
      ...prev,
      sshAlias: item.alias,
      sshHostname: item.hostname ?? '',
      sshUser: item.user ?? '',
      sshPort: item.port !== undefined ? String(item.port) : '',
      sshIdentityFile: item.identityFile ?? '',
      sshProxyJump: item.proxyJump ?? '',
    }));
    setDiscoveryNotice(null);
    setValidationError(null);
  };

  const handleDiscoverWsl = async () => {
    if (!window.desktop?.discoverWslDistros) {
      setDiscoveryNotice('当前环境不支持检测 WSL 发行版');
      return;
    }
    setDiscoveringWsl(true);
    setDiscoveryNotice(null);
    try {
      const distros = await window.desktop.discoverWslDistros();
      setDiscoveredWsl(distros);
      if (distros.length === 0) setDiscoveryNotice('未检测到本机 WSL 发行版');
    } catch {
      setDiscoveryNotice('检测 WSL 发行版失败，请手动填写发行版名称');
    } finally {
      setDiscoveringWsl(false);
    }
  };

  const handleToggleHostEnabled = (hostId: string) => {
    setHosts((prev) => prev.map((h) => (h.hostId === hostId ? { ...h, enabled: !h.enabled } : h)));
    setSaveSuccess(false);
  };

  const requestDeleteHost = (host: HostRegistration) => {
    const associatedTasks = tasks.filter((tItem) => tItem.hostId === host.hostId).length;
    if (associatedTasks > 0) {
      setPendingDeleteHost({ host, taskCount: associatedTasks });
      return;
    }
    setHosts((prev) => prev.filter((h) => h.hostId !== host.hostId));
    setSaveSuccess(false);
  };

  const confirmDeleteHost = () => {
    if (!pendingDeleteHost) return;
    const hostId = pendingDeleteHost.host.hostId;
    setHosts((prev) => prev.filter((h) => h.hostId !== hostId));
    setTasks((prev) => prev.filter((tItem) => tItem.hostId !== hostId));
    setPendingDeleteHost(null);
    setSaveSuccess(false);
  };

  const startEditingHost = (h: HostRegistration) => {
    setEditingHostId(h.hostId);
    setEditHostLabel(h.label);
    setEditHostKind(h.target.kind);
    setEditHostRoots(h.allowedRoots.join('; '));
    setEditHostPollSec(String(Math.round((h.pollIntervalMs ?? 5000) / 1000)));
    setEditHostAllowJobControl(Boolean(h.allowJobControl));
    setEditTargetFields(targetToFormState(h.target));
    setValidationError(null);
  };

  const finishEditingHost = () => {
    const parsedRoots = parseRoots(editHostRoots, editHostKind === 'local');
    if (!parsedRoots.roots) {
      setValidationError(parsedRoots.error);
      return;
    }
    const built = buildAndValidateTarget(editHostKind, editTargetFields);
    if (!built.target) {
      setValidationError(built.error);
      return;
    }
    const poll = parsePollSeconds(editHostPollSec);
    if (poll.error) {
      setValidationError(poll.error);
      return;
    }
    setHosts((prev) =>
      prev.map((h) =>
        h.hostId === editingHostId
          ? {
              ...h,
              label: editHostLabel.trim() || h.hostId,
              allowedRoots: parsedRoots.roots!,
              target: built.target!,
              ...(poll.pollIntervalMs && poll.pollIntervalMs !== 5000 ? { pollIntervalMs: poll.pollIntervalMs } : {}),
              ...(editHostAllowJobControl ? { allowJobControl: true } : {}),
            }
          : h,
      ),
    );
    setEditingHostId(null);
    setValidationError(null);
    setSaveSuccess(false);
  };

  const handleAddHostSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const id = newHostId.trim();
    if (!id) {
      setValidationError('宿主 ID 不能为空');
      return;
    }
    if (hosts.some((h) => h.hostId === id)) {
      setValidationError('该宿主 ID 已存在');
      return;
    }
    const parsedRoots = parseRoots(newHostRoots, newHostKind === 'local');
    if (!parsedRoots.roots) {
      setValidationError(parsedRoots.error);
      return;
    }
    const built = buildAndValidateTarget(newHostKind, newTargetFields);
    if (!built.target) {
      setValidationError(built.error);
      return;
    }
    const poll = parsePollSeconds(newHostPollSec);
    if (poll.error) {
      setValidationError(poll.error);
      return;
    }

    const newHost: HostRegistration = {
      hostId: id,
      label: newHostLabel.trim() || id,
      enabled: true,
      allowedRoots: parsedRoots.roots,
      target: built.target,
      ...(poll.pollIntervalMs && poll.pollIntervalMs !== 5000 ? { pollIntervalMs: poll.pollIntervalMs } : {}),
      ...(newHostAllowJobControl ? { allowJobControl: true } : {}),
    };

    setHosts((prev) => [...prev, newHost]);
    setNewHostId('');
    setNewHostLabel('');
    setNewHostRoots('');
    setNewHostPollSec('5');
    setNewHostAllowJobControl(false);
    setNewTargetFields({ ...EMPTY_TARGET_FORM });
    setIsAddingHost(false);
    setSaveSuccess(false);
  };

  const handleReloadRegistry = async () => {
    if (!onReloadRegistry) return;
    setIsReloading(true);
    try {
      const reg = await onReloadRegistry();
      if (reg) {
        setHosts(structuredClone(reg.hosts));
        setTasks(structuredClone(reg.tasks));
        setCurrentRevision(reg.revision);
      }
      setIsConflict(false);
      setInternalError(null);
      setValidationError(null);
    } catch (err: any) {
      setInternalError(err?.message || '重新拉取配置失败');
    } finally {
      setIsReloading(false);
    }
  };

  const handleSaveAll = async () => {
    setValidationError(null);
    setInternalError(null);
    setSaveSuccess(false);

    const currentHosts = [...hosts];
    const currentTasks = [...tasks];

    if (editingHostId) {
      const parsedRoots = parseRoots(editHostRoots, editHostKind === 'local');
      if (!parsedRoots.roots) {
        setValidationError(parsedRoots.error);
        return;
      }
      const built = buildAndValidateTarget(editHostKind, editTargetFields);
      if (!built.target) {
        setValidationError(built.error);
        return;
      }
      const poll = parsePollSeconds(editHostPollSec);
      if (poll.error) {
        setValidationError(poll.error);
        return;
      }
      const hostIdx = currentHosts.findIndex((h) => h.hostId === editingHostId);
      if (hostIdx !== -1) {
        const nextHost: HostRegistration = {
          ...currentHosts[hostIdx]!,
          label: editHostLabel.trim() || editingHostId,
          allowedRoots: parsedRoots.roots,
          target: built.target,
        };
        if (poll.pollIntervalMs && poll.pollIntervalMs !== 5000) nextHost.pollIntervalMs = poll.pollIntervalMs;
        else delete nextHost.pollIntervalMs;
        if (editHostAllowJobControl) nextHost.allowJobControl = true;
        else delete nextHost.allowJobControl;
        currentHosts[hostIdx] = nextHost;
      }
    }

    if (isAddingHost) {
      const id = newHostId.trim();
      if (!id) {
        setValidationError('宿主 ID 不能为空');
        return;
      }
      if (hosts.some((h) => h.hostId === id)) {
        setValidationError('该宿主 ID 已存在');
        return;
      }
      const parsedRoots = parseRoots(newHostRoots, newHostKind === 'local');
      if (!parsedRoots.roots) {
        setValidationError(parsedRoots.error);
        return;
      }
      const built = buildAndValidateTarget(newHostKind, newTargetFields);
      if (!built.target) {
        setValidationError(built.error);
        return;
      }
      const poll = parsePollSeconds(newHostPollSec);
      if (poll.error) {
        setValidationError(poll.error);
        return;
      }
      currentHosts.push({
        hostId: id,
        label: newHostLabel.trim() || id,
        enabled: true,
        allowedRoots: parsedRoots.roots,
        target: built.target,
        ...(poll.pollIntervalMs && poll.pollIntervalMs !== 5000 ? { pollIntervalMs: poll.pollIntervalMs } : {}),
        ...(newHostAllowJobControl ? { allowJobControl: true } : {}),
      });
    }

    const hostById = new Map<string, HostRegistration>();
    for (const h of currentHosts) {
      if (!h.hostId.trim()) {
        setValidationError('存在空的宿主 ID');
        return;
      }
      try {
        validateHostTarget(h.target);
      } catch {
        setValidationError(`宿主 ${h.hostId} 的连接目标配置无效`);
        return;
      }
      const allowWin = h.target.kind === 'local';
      for (const r of h.allowedRoots) {
        if (!isValidAbsolutePath(r, allowWin)) {
          setValidationError(`宿主 ${h.hostId}${allowWin ? ' 白名单根目录必须为绝对路径' : ' 白名单根目录必须以 / 开头'}`);
          return;
        }
      }
      hostById.set(h.hostId, h);
    }

    for (const taskItem of currentTasks) {
      if (!taskItem.taskId.trim()) {
        setValidationError('存在空的任务 ID');
        return;
      }
      const parentHost = hostById.get(taskItem.hostId);
      if (!parentHost) {
        setValidationError(`任务 ${taskItem.taskId} 引用的宿主 ${taskItem.hostId} 不存在`);
        return;
      }
      const allowWin = parentHost.target.kind === 'local';
      for (const d of taskItem.allowedDirectories) {
        if (!isValidAbsolutePath(d, allowWin)) {
          setValidationError(`任务 ${taskItem.taskId}${allowWin ? ' 的工作目录必须为绝对路径' : ' 的工作目录必须以 / 开头'}`);
          return;
        }
      }
    }

    setIsSaving(true);
    try {
      const updatedRegistry: Registry = {
        version: 2,
        revision: currentRevision,
        hosts: currentHosts,
        tasks: currentTasks,
      };
      const saveRes = await Promise.resolve(onUpdateRegistry(updatedRegistry));
      if (saveRes && typeof saveRes === 'object' && 'revision' in saveRes && typeof (saveRes as any).revision === 'number') {
        setCurrentRevision((saveRes as any).revision);
      }
      setHosts(currentHosts);
      setTasks(currentTasks);
      setEditingHostId(null);
      setIsAddingHost(false);
      setNewHostId('');
      setNewHostLabel('');
      setNewHostRoots('');
      setNewHostPollSec('5');
      setNewHostAllowJobControl(false);
      setNewTargetFields({ ...EMPTY_TARGET_FORM });
      setSaveSuccess(true);
      setIsConflict(false);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isConf = /409|conflict|冲突|revision/i.test(msg);
      setIsConflict(isConf);
      setInternalError(msg || '保存宿主配置失败，可能存在版本冲突');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAlerts = async () => {
    setAlertSaved(false);
    const cleanedWebhooks = (alertDraft.webhooks ?? []).filter((w) => w.url.trim().length > 0);
    for (const w of cleanedWebhooks) {
      try {
        const parsed = new URL(w.url.trim());
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('BAD_PROTOCOL');
      } catch {
        setThemeError(`Webhook URL 格式无效: ${w.url}`);
        return;
      }
    }
    const ok = await savePreferencePatch({
      alerts: {
        desktopNotifications: alertDraft.desktopNotifications ?? true,
        stallThresholdMinutes: Math.max(1, Math.min(1440, Math.round(alertDraft.stallThresholdMinutes ?? 15))),
        hostDisconnectThresholdSeconds: Math.max(5, Math.min(86400, Math.round(alertDraft.hostDisconnectThresholdSeconds ?? 30))),
        cooldownSeconds: Math.max(0, Math.min(86400, Math.round(alertDraft.cooldownSeconds ?? 300))),
        enabledKinds: alertDraft.enabledKinds ?? [...ALL_ALERT_KINDS],
        webhooks: cleanedWebhooks.map((w) => ({
          enabled: w.enabled,
          kind: w.kind,
          url: w.url.trim(),
          ...(w.label?.trim() ? { label: w.label.trim() } : {}),
        })),
      },
    });
    if (ok) setAlertSaved(true);
  };

  const handleTestWebhook = async (idx: number, webhook: WebhookChannelConfig) => {
    if (!window.monitor?.testWebhook) return;
    setTestingWebhookIdx(idx);
    try {
      const res = await window.monitor.testWebhook({
        enabled: webhook.enabled,
        kind: webhook.kind,
        url: webhook.url.trim(),
        ...(webhook.label?.trim() ? { label: webhook.label.trim() } : {}),
      });
      setWebhookResults((prev) => ({
        ...prev,
        [idx]: res.ok
          ? { ok: true, text: t('settings.webhookTestOk', { status: res.statusCode ?? 200 }) }
          : { ok: false, text: t('settings.webhookTestFail', { error: res.error ?? 'ERROR' }) },
      }));
    } catch (err) {
      setWebhookResults((prev) => ({
        ...prev,
        [idx]: { ok: false, text: t('settings.webhookTestFail', { error: err instanceof Error ? err.message : String(err) }) },
      }));
    } finally {
      setTestingWebhookIdx(null);
    }
  };

  const displayError = validationError || internalError || externalError || themeError;
  const activeLocale: Locale = preferences.locale === 'en-US' ? 'en-US' : 'zh-CN';

  const alertRuleLabels: Record<AlertEventKind, string> = {
    cuda_oom: t('settings.alertRuleCudaOom'),
    process_crashed: t('settings.alertRuleCrash'),
    loss_nan_inf: t('settings.alertRuleNan'),
    training_stalled: t('settings.alertRuleStalled'),
    training_completed: t('settings.alertRuleCompleted'),
    host_disconnected: t('settings.alertRuleDisconnected'),
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal-container settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.ariaLabel')}
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 className="modal-title">{t('settings.title')}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            onClick={onClose}
            aria-label={t('app.close')}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {/* 3-Tab Navigation */}
        <div className="settings-tabs" role="tablist" aria-label={t('settings.title')}>
          <button
            type="button"
            role="tab"
            className={`settings-tab-btn ${activeTab === 'appearance' ? 'is-active' : ''}`}
            aria-selected={activeTab === 'appearance'}
            onClick={() => setActiveTab('appearance')}
          >
            <Icon name="sun" size={14} />
            <span>{t('settings.tabAppearance')}</span>
          </button>
          <button
            type="button"
            role="tab"
            className={`settings-tab-btn ${activeTab === 'hosts' ? 'is-active' : ''}`}
            aria-selected={activeTab === 'hosts'}
            onClick={() => setActiveTab('hosts')}
          >
            <Icon name="server" size={14} />
            <span>{t('settings.tabHosts')}</span>
          </button>
          <button
            type="button"
            role="tab"
            className={`settings-tab-btn ${activeTab === 'alerts' ? 'is-active' : ''}`}
            aria-selected={activeTab === 'alerts'}
            onClick={() => setActiveTab('alerts')}
          >
            <Icon name="bell" size={14} />
            <span>{t('settings.tabAlerts')}</span>
          </button>
        </div>

        <div className="modal-body">
          {displayError && (
            <div className="alert alert-danger" role="alert">
              <span>{displayError}</span>
              {isConflict && onReloadRegistry && (
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={() => void handleReloadRegistry()}
                  disabled={isReloading}
                >
                  {isReloading ? t('settings.reloadingBtn') : t('settings.reloadLatestBtn')}
                </button>
              )}
            </div>
          )}

          {saveSuccess && activeTab === 'hosts' && (
            <div className="alert alert-success" role="status">
              <span className="footer-item">
                <Icon name="check" size={14} />
                {t('settings.savedSuccess')}
              </span>
            </div>
          )}

          {alertSaved && activeTab === 'alerts' && (
            <div className="alert alert-success" role="status">
              <span className="footer-item">
                <Icon name="check" size={14} />
                {t('settings.alertsSavedSuccess')}
              </span>
            </div>
          )}

          {/* TAB 1: Appearance & Language */}
          {activeTab === 'appearance' && (
            <>
              <section className="modal-section">
                <h3 className="modal-section-title">{t('settings.themeHeading')}</h3>
                <div className="theme-options-group" role="radiogroup" aria-label={t('settings.themeHeading')}>
                  <label className="theme-radio-label">
                    <div className="theme-radio-head">
                      <input
                        type="radio"
                        name="theme"
                        value="system"
                        aria-label={t('settings.themeSystem')}
                        checked={preferences.theme === 'system'}
                        onChange={() => void savePreferencePatch({ theme: 'system' })}
                      />
                      <span>{t('settings.themeSystem')}</span>
                    </div>
                    <span className="theme-radio-desc">{t('settings.themeSystemDesc')}</span>
                    <div className="theme-swatch-row">
                      <span className="theme-swatch" style={{ background: '#F4F5F7' }} />
                      <span className="theme-swatch" style={{ background: '#0E1014' }} />
                      <span className="theme-swatch" style={{ background: '#2563EB' }} />
                    </div>
                  </label>

                  <label className="theme-radio-label">
                    <div className="theme-radio-head">
                      <input
                        type="radio"
                        name="theme"
                        value="light"
                        aria-label={t('settings.themeLight')}
                        checked={preferences.theme === 'light'}
                        onChange={() => void savePreferencePatch({ theme: 'light' })}
                      />
                      <span>{t('settings.themeLight')}</span>
                    </div>
                    <span className="theme-radio-desc">{t('settings.themeLightDesc')}</span>
                    <div className="theme-swatch-row">
                      <span className="theme-swatch" style={{ background: '#F4F5F7' }} />
                      <span className="theme-swatch" style={{ background: '#FFFFFF' }} />
                      <span className="theme-swatch" style={{ background: '#2563EB' }} />
                    </div>
                  </label>

                  <label className="theme-radio-label">
                    <div className="theme-radio-head">
                      <input
                        type="radio"
                        name="theme"
                        value="dark"
                        aria-label={t('settings.themeDark')}
                        checked={preferences.theme === 'dark'}
                        onChange={() => void savePreferencePatch({ theme: 'dark' })}
                      />
                      <span>{t('settings.themeDark')}</span>
                    </div>
                    <span className="theme-radio-desc">{t('settings.themeDarkDesc')}</span>
                    <div className="theme-swatch-row">
                      <span className="theme-swatch" style={{ background: '#0E1014' }} />
                      <span className="theme-swatch" style={{ background: '#161A22' }} />
                      <span className="theme-swatch" style={{ background: '#60A5FA' }} />
                    </div>
                  </label>
                </div>
              </section>

              <section className="modal-section">
                <h3 className="modal-section-title">{t('settings.languageHeading')}</h3>
                <div className="segmented-control" role="radiogroup" aria-label={t('settings.languageHeading')}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={activeLocale === 'zh-CN'}
                    className={`segmented-btn ${activeLocale === 'zh-CN' ? 'is-active' : ''}`}
                    onClick={() => void savePreferencePatch({ locale: 'zh-CN' })}
                  >
                    {t('settings.langZh')}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={activeLocale === 'en-US'}
                    className={`segmented-btn ${activeLocale === 'en-US' ? 'is-active' : ''}`}
                    onClick={() => void savePreferencePatch({ locale: 'en-US' })}
                  >
                    {t('settings.langEn')}
                  </button>
                </div>
              </section>

              <section className="modal-section">
                <h3 className="modal-section-title">{t('settings.desktopBehaviorHeading')}</h3>
                <label className="setting-check-row">
                  <input
                    type="checkbox"
                    checked={preferences.minimizeToTrayOnClose ?? true}
                    disabled={isSavingPreferences}
                    onChange={(e) => void savePreferencePatch({ minimizeToTrayOnClose: e.target.checked })}
                  />
                  <span>{t('settings.minimizeToTray')}</span>
                </label>
                <label className="setting-check-row">
                  <input
                    type="checkbox"
                    checked={preferences.launchAtLogin ?? false}
                    disabled={isSavingPreferences}
                    onChange={(e) => void savePreferencePatch({ launchAtLogin: e.target.checked })}
                  />
                  <span>{t('settings.launchAtLogin')}</span>
                </label>
                <p className="form-hint">{t('settings.pollNote')}</p>
              </section>
            </>
          )}

          {/* TAB 2: Hosts Management (Card-based + Delete confirmation) */}
          {activeTab === 'hosts' && (
            <section className="modal-section">
              <div className="registry-group-header">
                <h4>{t('settings.hostsHeading', { count: hosts.length })}</h4>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setIsAddingHost((v) => !v)}
                >
                  {isAddingHost ? t('settings.cancelAddHost') : t('settings.addHostBtn')}
                </button>
              </div>

              {isAddingHost && (
                <form className="registry-add-form" onSubmit={handleAddHostSubmit}>
                  <div className="form-row-3">
                    <label className="form-label">
                      {t('settings.formHostId')}
                      <input
                        type="text"
                        className="form-input is-mono"
                        placeholder="gpu-server-01"
                        value={newHostId}
                        onChange={(e) => setNewHostId(e.target.value)}
                      />
                    </label>
                    <label className="form-label">
                      {t('settings.formHostLabel')}
                      <input
                        type="text"
                        className="form-input"
                        placeholder="GPU Server 01"
                        value={newHostLabel}
                        onChange={(e) => setNewHostLabel(e.target.value)}
                      />
                    </label>
                    <label className="form-label">
                      {t('settings.formHostKind')}
                      <select
                        className="form-select"
                        value={newHostKind}
                        onChange={(e) => {
                          setNewHostKind(e.target.value as HostKind);
                          setDiscoveryNotice(null);
                        }}
                      >
                        <option value="ssh">SSH</option>
                        <option value="wsl">WSL</option>
                        <option value="local">Local</option>
                      </select>
                    </label>
                  </div>

                  {newHostKind === 'ssh' && (
                    <>
                      <div className="form-row-inline">
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={() => void handleDiscoverSsh()}
                          disabled={discoveringSsh}
                        >
                          <Icon name="search" size={12} />
                          <span>{discoveringSsh ? t('settings.formScanningSsh') : t('settings.formImportSsh')}</span>
                        </button>
                        {discoveredSsh.length > 0 && (
                          <select
                            className="form-select form-select-sm"
                            style={{ width: 'auto', minWidth: 220 }}
                            aria-label="选择已发现的 SSH 宿主"
                            defaultValue=""
                            onChange={(e) => {
                              const found = discoveredSsh.find((h) => h.alias === e.target.value);
                              if (found) applyDiscoveredSsh(found);
                            }}
                          >
                            <option value="">{t('settings.formSelectSsh', { count: discoveredSsh.length })}</option>
                            {discoveredSsh.map((item) => (
                              <option key={item.alias} value={item.alias}>
                                {item.alias}
                                {item.hostname
                                  ? ` (${item.user ? `${item.user}@` : ''}${item.hostname}${item.port ? `:${item.port}` : ''})`
                                  : ''}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="form-row">
                        <label className="form-label">
                          {t('settings.formSshAlias')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            placeholder="gpu-server-01"
                            value={newTargetFields.sshAlias}
                            onChange={(e) => updateNewTarget('sshAlias', e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          {t('settings.formSshHost')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            placeholder="10.0.0.12"
                            value={newTargetFields.sshHostname}
                            onChange={(e) => updateNewTarget('sshHostname', e.target.value)}
                          />
                        </label>
                      </div>
                      <div className="form-row-3">
                        <label className="form-label">
                          {t('settings.formSshUser')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            value={newTargetFields.sshUser}
                            onChange={(e) => updateNewTarget('sshUser', e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          {t('settings.formSshPort')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            placeholder="22"
                            value={newTargetFields.sshPort}
                            onChange={(e) => updateNewTarget('sshPort', e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          {t('settings.formSshProxy')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            placeholder="bastion"
                            value={newTargetFields.sshProxyJump}
                            onChange={(e) => updateNewTarget('sshProxyJump', e.target.value)}
                          />
                        </label>
                      </div>
                      <div className="form-row">
                        <label className="form-label">
                          {t('settings.formSshKey')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            placeholder="~/.ssh/id_ed25519"
                            value={newTargetFields.sshIdentityFile}
                            onChange={(e) => updateNewTarget('sshIdentityFile', e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          {t('settings.formPythonPath')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            placeholder="/usr/bin/python3"
                            value={newTargetFields.pythonPath}
                            onChange={(e) => updateNewTarget('pythonPath', e.target.value)}
                          />
                        </label>
                      </div>
                    </>
                  )}

                  {newHostKind === 'wsl' && (
                    <>
                      <div className="form-row-inline">
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={() => void handleDiscoverWsl()}
                          disabled={discoveringWsl}
                        >
                          {discoveringWsl ? t('settings.formDetectingWsl') : t('settings.formDetectWsl')}
                        </button>
                        {discoveredWsl.length > 0 && (
                          <select
                            className="form-select form-select-sm"
                            style={{ width: 'auto', minWidth: 200 }}
                            aria-label="选择已发现的 WSL 发行版"
                            defaultValue=""
                            onChange={(e) => {
                              if (!e.target.value) return;
                              updateNewTarget('wslDistribution', e.target.value);
                              if (!newHostId.trim()) setNewHostId(`wsl-${e.target.value.toLowerCase()}`);
                              if (!newHostLabel.trim()) setNewHostLabel(e.target.value);
                            }}
                          >
                            <option value="">{t('settings.formSelectWsl')}</option>
                            {discoveredWsl.map((d) => (
                              <option key={d.name} value={d.name}>
                                {d.name}
                                {d.running ? ' (running)' : ''}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="form-row">
                        <label className="form-label">
                          {t('settings.formWslDistro')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            placeholder="Ubuntu-24.04"
                            value={newTargetFields.wslDistribution}
                            onChange={(e) => updateNewTarget('wslDistribution', e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          {t('settings.formPythonPath')}
                          <input
                            type="text"
                            className="form-input is-mono"
                            value={newTargetFields.pythonPath}
                            onChange={(e) => updateNewTarget('pythonPath', e.target.value)}
                          />
                        </label>
                      </div>
                    </>
                  )}

                  {newHostKind === 'local' && (
                    <label className="form-label">
                      {t('settings.formPythonPath')}
                      <input
                        type="text"
                        className="form-input is-mono"
                        placeholder="留空自动探测 python3 / python"
                        value={newTargetFields.pythonPath}
                        onChange={(e) => updateNewTarget('pythonPath', e.target.value)}
                      />
                    </label>
                  )}

                  {discoveryNotice && (
                    <p className="text-muted" role="status" style={{ fontSize: 12 }}>
                      {discoveryNotice}
                    </p>
                  )}

                  <div className="form-row">
                    <label className="form-label">
                      {t('settings.formAllowedRoots')}
                      <input
                        type="text"
                        className="form-input is-mono"
                        placeholder={newHostKind === 'local' ? '/workspace 或 C:\\Projects' : '/workspace'}
                        value={newHostRoots}
                        onChange={(e) => setNewHostRoots(e.target.value)}
                      />
                    </label>
                    <label className="form-label">
                      {t('settings.formPollInterval')}
                      <input
                        type="number"
                        min={2}
                        max={60}
                        className="form-input is-mono"
                        value={newHostPollSec}
                        onChange={(e) => setNewHostPollSec(e.target.value)}
                      />
                    </label>
                  </div>

                  <label className="setting-check-row">
                    <input
                      type="checkbox"
                      checked={newHostAllowJobControl}
                      onChange={(e) => setNewHostAllowJobControl(e.target.checked)}
                    />
                    <span>{t('settings.formAllowJobControl')}</span>
                  </label>

                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary btn-sm">
                      {t('settings.formConfirmAddHost')}
                    </button>
                  </div>
                </form>
              )}

              {/* Card-based host list */}
              <div className="host-cards-list">
                {hosts.map((h) => {
                  const isEditing = editingHostId === h.hostId;
                  const hostTaskCount = tasks.filter((item) => item.hostId === h.hostId).length;
                  return (
                    <article key={h.hostId} className="host-config-card">
                      <div className="host-config-card-head">
                        <div className="host-config-ident">
                          <span className="platform-badge">{h.target.kind.toUpperCase()}</span>
                          <strong>{h.label}</strong>
                          <code>{h.hostId}</code>
                          <span className="status-pill pill-neutral">
                            {t('settings.hostTasksCount', { count: hostTaskCount })}
                          </span>
                          {h.allowJobControl && (
                            <span className="status-pill pill-warning">{t('settings.jobControlBadge')}</span>
                          )}
                        </div>

                        <div className="host-config-actions">
                          <button
                            type="button"
                            className={`btn btn-xs ${h.enabled ? 'btn-success' : 'btn-secondary'}`}
                            onClick={() => handleToggleHostEnabled(h.hostId)}
                          >
                            {h.enabled ? t('settings.hostEnabled') : t('settings.hostDisabled')}
                          </button>
                          {!isEditing && (
                            <>
                              <button
                                type="button"
                                className="btn btn-secondary btn-xs"
                                data-testid={`edit-host-${h.hostId}`}
                                onClick={() => startEditingHost(h)}
                              >
                                {t('app.edit')}
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger btn-xs"
                                onClick={() => requestDeleteHost(h)}
                              >
                                {t('app.delete')}
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {isEditing ? (
                        <div className="task-form-fields" style={{ marginTop: 6 }}>
                          <div className="form-row">
                            <label className="form-label">
                              {t('settings.formHostLabel')}
                              <input
                                type="text"
                                className="form-input form-input-sm"
                                value={editHostLabel}
                                onChange={(e) => setEditHostLabel(e.target.value)}
                                aria-label="宿主名称"
                              />
                            </label>
                            <label className="form-label">
                              {t('settings.formHostKind')}
                              <select
                                className="form-select form-select-sm"
                                value={editHostKind}
                                onChange={(e) => setEditHostKind(e.target.value as HostKind)}
                                aria-label="宿主类型"
                              >
                                <option value="ssh">SSH</option>
                                <option value="wsl">WSL</option>
                                <option value="local">LOCAL</option>
                              </select>
                            </label>
                          </div>

                          {editHostKind === 'ssh' && (
                            <div className="form-row">
                              <input
                                type="text"
                                className="form-input form-input-sm is-mono"
                                placeholder="SSH 别名 (Alias)"
                                aria-label="编辑 SSH 别名"
                                value={editTargetFields.sshAlias}
                                onChange={(e) => updateEditTarget('sshAlias', e.target.value)}
                              />
                              <input
                                type="text"
                                className="form-input form-input-sm is-mono"
                                placeholder="主机地址 (HostName)"
                                aria-label="编辑 SSH 主机地址"
                                value={editTargetFields.sshHostname}
                                onChange={(e) => updateEditTarget('sshHostname', e.target.value)}
                              />
                              <input
                                type="text"
                                className="form-input form-input-sm is-mono"
                                placeholder="用户名 (选填)"
                                aria-label="编辑 SSH 用户名"
                                value={editTargetFields.sshUser}
                                onChange={(e) => updateEditTarget('sshUser', e.target.value)}
                              />
                              <input
                                type="text"
                                className="form-input form-input-sm is-mono"
                                placeholder="端口 (选填)"
                                aria-label="编辑 SSH 端口"
                                value={editTargetFields.sshPort}
                                onChange={(e) => updateEditTarget('sshPort', e.target.value)}
                              />
                            </div>
                          )}

                          {editHostKind === 'wsl' && (
                            <input
                              type="text"
                              className="form-input form-input-sm is-mono"
                              placeholder="WSL 发行版"
                              aria-label="编辑 WSL 发行版"
                              value={editTargetFields.wslDistribution}
                              onChange={(e) => updateEditTarget('wslDistribution', e.target.value)}
                            />
                          )}

                          <div className="form-row">
                            <input
                              type="text"
                              className="form-input form-input-sm is-mono"
                              placeholder="Python 路径 (选填)"
                              aria-label="编辑 Python 路径"
                              value={editTargetFields.pythonPath}
                              onChange={(e) => updateEditTarget('pythonPath', e.target.value)}
                            />
                            <input
                              type="number"
                              min={2}
                              max={60}
                              className="form-input form-input-sm is-mono"
                              aria-label="轮询间隔"
                              value={editHostPollSec}
                              onChange={(e) => setEditHostPollSec(e.target.value)}
                            />
                          </div>

                          <input
                            type="text"
                            className="form-input form-input-sm is-mono"
                            value={editHostRoots}
                            onChange={(e) => setEditHostRoots(e.target.value)}
                            aria-label="白名单根目录"
                            placeholder="/workspace"
                          />

                          <label className="setting-check-row">
                            <input
                              type="checkbox"
                              checked={editHostAllowJobControl}
                              onChange={(e) => setEditHostAllowJobControl(e.target.checked)}
                            />
                            <span>{t('settings.formAllowJobControl')}</span>
                          </label>

                          <div className="form-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              onClick={() => setEditingHostId(null)}
                            >
                              {t('app.cancel')}
                            </button>
                            <button type="button" className="btn btn-primary btn-xs" onClick={finishEditingHost}>
                              {t('settings.formFinishEdit')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="host-config-meta">
                          <span className="mono">{summarizeTarget(h.target)}</span>
                          <span className="tabular-num">
                            {t('settings.pollIntervalLabel', { sec: Math.round((h.pollIntervalMs ?? 5000) / 1000) })}
                          </span>
                          {h.allowedRoots.length > 0 && (
                            <code className="text-muted">{h.allowedRoots.join('; ')}</code>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
                {hosts.length === 0 && (
                  <p className="text-muted" style={{ fontSize: 12.5 }}>
                    {t('settings.noHosts')}
                  </p>
                )}
              </div>

              {/* Mandatory Secondary Confirmation when deleting a host with tasks */}
              {pendingDeleteHost && (
                <div className="alert alert-danger" role="alertdialog" aria-label={t('settings.deleteHostTitle')}>
                  <div>
                    <strong>{t('settings.deleteHostTitle')}</strong>
                    <p style={{ marginTop: 4 }}>
                      {t('settings.deleteHostDesc', {
                        label: pendingDeleteHost.host.label,
                        count: pendingDeleteHost.taskCount,
                      })}
                    </p>
                  </div>
                  <div className="log-alert-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => setPendingDeleteHost(null)}
                    >
                      {t('app.cancel')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-xs"
                      onClick={confirmDeleteHost}
                    >
                      {t('settings.deleteHostConfirm')}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* TAB 3: Alerts & Webhooks */}
          {activeTab === 'alerts' && (
            <>
              <section className="modal-section">
                <label className="setting-check-row">
                  <input
                    type="checkbox"
                    checked={alertDraft.desktopNotifications !== false}
                    onChange={(e) => setAlertDraft((prev) => ({ ...prev, desktopNotifications: e.target.checked }))}
                  />
                  <span>{t('settings.alertsDesktopToggle')}</span>
                </label>
              </section>

              <section className="modal-section">
                <h3 className="modal-section-title">{t('settings.alertsRulesHeading')}</h3>
                <div className="alert-rules-grid">
                  {ALL_ALERT_KINDS.map((kind) => {
                    const enabledKinds = alertDraft.enabledKinds ?? ALL_ALERT_KINDS;
                    const checked = enabledKinds.includes(kind);
                    return (
                      <label key={kind} className="setting-check-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...new Set([...enabledKinds, kind])]
                              : enabledKinds.filter((k) => k !== kind);
                            setAlertDraft((prev) => ({ ...prev, enabledKinds: next }));
                          }}
                        />
                        <span>{alertRuleLabels[kind]}</span>
                      </label>
                    );
                  })}
                </div>
              </section>

              <section className="modal-section">
                <h3 className="modal-section-title">{t('settings.alertsThresholdsHeading')}</h3>
                <div className="form-row-3">
                  <label className="form-label">
                    {t('settings.stallThresholdMin')}
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      className="form-input is-mono"
                      value={alertDraft.stallThresholdMinutes ?? 15}
                      onChange={(e) =>
                        setAlertDraft((prev) => ({ ...prev, stallThresholdMinutes: Number(e.target.value) || 15 }))
                      }
                    />
                  </label>
                  <label className="form-label">
                    {t('settings.disconnectThresholdSec')}
                    <input
                      type="number"
                      min={5}
                      max={86400}
                      className="form-input is-mono"
                      value={alertDraft.hostDisconnectThresholdSeconds ?? 30}
                      onChange={(e) =>
                        setAlertDraft((prev) => ({
                          ...prev,
                          hostDisconnectThresholdSeconds: Number(e.target.value) || 30,
                        }))
                      }
                    />
                  </label>
                  <label className="form-label">
                    {t('settings.cooldownSec')}
                    <input
                      type="number"
                      min={0}
                      max={86400}
                      className="form-input is-mono"
                      value={alertDraft.cooldownSeconds ?? 300}
                      onChange={(e) =>
                        setAlertDraft((prev) => ({ ...prev, cooldownSeconds: Number(e.target.value) || 0 }))
                      }
                    />
                  </label>
                </div>
              </section>

              <section className="modal-section">
                <div className="registry-group-header">
                  <h3 className="modal-section-title">{t('settings.webhooksHeading')}</h3>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={() =>
                      setAlertDraft((prev) => ({
                        ...prev,
                        webhooks: [
                          ...(prev.webhooks ?? []),
                          { enabled: true, kind: 'feishu', url: '', label: '' },
                        ],
                      }))
                    }
                  >
                    {t('settings.addWebhookBtn')}
                  </button>
                </div>

                {(alertDraft.webhooks ?? []).map((hook, idx) => (
                  <div key={idx} className="webhook-card">
                    <div className="webhook-card-row">
                      <select
                        className="form-select form-select-sm"
                        aria-label={`Webhook 类型 ${idx + 1}`}
                        value={hook.kind}
                        onChange={(e) => {
                          const kind = e.target.value as WebhookChannelConfig['kind'];
                          setAlertDraft((prev) => ({
                            ...prev,
                            webhooks: (prev.webhooks ?? []).map((item, i) => (i === idx ? { ...item, kind } : item)),
                          }));
                        }}
                      >
                        <option value="feishu">飞书 / Lark</option>
                        <option value="slack">Slack</option>
                        <option value="discord">Discord</option>
                        <option value="generic">Generic JSON</option>
                      </select>

                      <input
                        type="url"
                        className="form-input form-input-sm is-mono"
                        placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                        aria-label={`Webhook URL ${idx + 1}`}
                        value={hook.url}
                        onChange={(e) => {
                          const url = e.target.value;
                          setAlertDraft((prev) => ({
                            ...prev,
                            webhooks: (prev.webhooks ?? []).map((item, i) => (i === idx ? { ...item, url } : item)),
                          }));
                        }}
                      />

                      <div className="log-alert-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          disabled={testingWebhookIdx === idx || !hook.url.trim()}
                          onClick={() => void handleTestWebhook(idx, hook)}
                        >
                          {testingWebhookIdx === idx ? t('settings.testingWebhookBtn') : t('settings.testWebhookBtn')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon-only"
                          aria-label={`删除 Webhook ${idx + 1}`}
                          onClick={() =>
                            setAlertDraft((prev) => ({
                              ...prev,
                              webhooks: (prev.webhooks ?? []).filter((_, i) => i !== idx),
                            }))
                          }
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>

                    {webhookResults[idx] && (
                      <span
                        className={webhookResults[idx]!.ok ? 'text-success' : 'text-danger'}
                        style={{ fontSize: 11.5 }}
                      >
                        {webhookResults[idx]!.text}
                      </span>
                    )}
                  </div>
                ))}
              </section>
            </>
          )}
        </div>

        <div className="modal-footer">
          {activeTab === 'hosts' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSaveAll()}
              disabled={isSaving}
            >
              {isSaving ? t('app.saving') : t('settings.saveHostsBtn')}
            </button>
          )}
          {activeTab === 'alerts' && (
            <button type="button" className="btn btn-primary" onClick={() => void handleSaveAlerts()}>
              {t('settings.saveAlertsBtn')}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('settings.closeSettingsBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
