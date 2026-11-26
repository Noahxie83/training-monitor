import { Icon } from './Icon';
import React, { useState, useEffect, useRef } from "react";
import type {
  DiscoveredSshHost,
  DiscoveredWslDistro,
  HostKind,
  HostRegistration,
  HostTarget,
  Preferences,
  Registry,
  TaskRegistration,
} from "../../shared/contracts";
import { isValidAbsolutePath, validateHostTarget } from "../../shared/validate";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  preferences: Preferences;
  onUpdatePreferences: (newPrefs: Preferences) => Promise<Preferences | void> | void;
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
  sshAlias: "",
  sshHostname: "",
  sshUser: "",
  sshPort: "",
  sshIdentityFile: "",
  sshProxyJump: "",
  wslDistribution: "",
  pythonPath: "",
};

function targetToFormState(target: HostTarget): TargetFormState {
  if (target.kind === "ssh") {
    return {
      sshAlias: target.alias ?? "",
      sshHostname: target.hostname ?? "",
      sshUser: target.user ?? "",
      sshPort: target.port !== undefined ? String(target.port) : "",
      sshIdentityFile: target.identityFile ?? "",
      sshProxyJump: target.proxyJump ?? "",
      wslDistribution: "",
      pythonPath: target.pythonPath ?? "",
    };
  }
  if (target.kind === "wsl") {
    return {
      ...EMPTY_TARGET_FORM,
      wslDistribution: target.distribution,
      pythonPath: target.pythonPath ?? "",
    };
  }
  return {
    ...EMPTY_TARGET_FORM,
    pythonPath: target.pythonPath ?? "",
  };
}

function buildAndValidateTarget(
  kind: HostKind,
  fields: TargetFormState,
): { target: HostTarget | null; error: string | null } {
  const pythonPath = fields.pythonPath.trim();
  if (kind === "ssh") {
    const alias = fields.sshAlias.trim();
    const hostname = fields.sshHostname.trim();
    const user = fields.sshUser.trim();
    const portRaw = fields.sshPort.trim();
    const identityFile = fields.sshIdentityFile.trim();
    const proxyJump = fields.sshProxyJump.trim();

    if (!alias && !hostname) {
      return { target: null, error: "SSH 宿主需填写别名 (Alias) 或主机地址 (HostName)" };
    }
    let port: number | undefined;
    if (portRaw) {
      if (!/^\d+$/.test(portRaw)) {
        return { target: null, error: "SSH 端口必须为 1–65535 之间的整数" };
      }
      port = Number(portRaw);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        return { target: null, error: "SSH 端口必须为 1–65535 之间的整数" };
      }
    }
    const candidate: HostTarget = {
      kind: "ssh",
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
      return { target: null, error: "SSH 连接参数无效（不允许以 - 开头或包含空白/危险字符）" };
    }
  }

  if (kind === "wsl") {
    const distribution = fields.wslDistribution.trim();
    if (!distribution) {
      return { target: null, error: "WSL 宿主必须填写发行版名称" };
    }
    const candidate: HostTarget = {
      kind: "wsl",
      distribution,
      ...(pythonPath ? { pythonPath } : {}),
    };
    try {
      return { target: validateHostTarget(candidate), error: null };
    } catch {
      return { target: null, error: "WSL 发行版名称或 Python 路径无效" };
    }
  }

  const candidate: HostTarget = {
    kind: "local",
    ...(pythonPath ? { pythonPath } : {}),
  };
  try {
    return { target: validateHostTarget(candidate), error: null };
  } catch {
    return { target: null, error: "本机 Python 路径无效" };
  }
}

function summarizeTarget(target: HostTarget): string {
  if (target.kind === "ssh") {
    if (target.alias) return target.hostname ? `${target.alias} (${target.hostname})` : target.alias;
    const hostPart = target.user ? `${target.user}@${target.hostname ?? ""}` : (target.hostname ?? "");
    return target.port ? `${hostPart}:${target.port}` : hostPart;
  }
  if (target.kind === "wsl") return target.distribution;
  return target.pythonPath ? `本机 (${target.pythonPath})` : "本机";
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
          ? "白名单根目录必须为绝对路径（如 /workspace 或 C:\\Projects）"
          : "白名单根目录路径必须以 / 开头",
      };
    }
  }
  return { roots, error: null };
}

export function SettingsModal({
  isOpen,
  onClose,
  preferences,
  onUpdatePreferences,
  registry,
  onUpdateRegistry,
  onReloadRegistry,
  registryError: externalError,
}: SettingsModalProps) {
  const containerRef = useFocusTrap(isOpen, onClose);

  // Local editable copy of registry
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
  const themeRequest = useRef(0);

  // Add Host form state
  const [isAddingHost, setIsAddingHost] = useState(false);
  const [newHostId, setNewHostId] = useState("");
  const [newHostLabel, setNewHostLabel] = useState("");
  const [newHostKind, setNewHostKind] = useState<HostKind>("ssh");
  const [newHostRoots, setNewHostRoots] = useState("");
  const [newTargetFields, setNewTargetFields] = useState<TargetFormState>({ ...EMPTY_TARGET_FORM });

  // Discovery state
  const [discoveredSsh, setDiscoveredSsh] = useState<DiscoveredSshHost[]>([]);
  const [discoveredWsl, setDiscoveredWsl] = useState<DiscoveredWslDistro[]>([]);
  const [discoveringSsh, setDiscoveringSsh] = useState(false);
  const [discoveringWsl, setDiscoveringWsl] = useState(false);
  const [discoveryNotice, setDiscoveryNotice] = useState<string | null>(null);

  // Edit Host state
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editHostLabel, setEditHostLabel] = useState("");
  const [editHostKind, setEditHostKind] = useState<HostKind>("ssh");
  const [editHostRoots, setEditHostRoots] = useState("");
  const [editTargetFields, setEditTargetFields] = useState<TargetFormState>({ ...EMPTY_TARGET_FORM });

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
    setValidationError(null);
    setSaveSuccess(false);
    setInternalError(null);
    setIsConflict(false);
    setDiscoveryNotice(null);
  }, [registry, isOpen]);

  useEffect(() => {
    setThemeError(null);
    return () => { themeRequest.current++; };
  }, [isOpen]);

  if (!isOpen) return null;

  const updateNewTarget = (key: keyof TargetFormState, value: string) =>
    setNewTargetFields((prev) => ({ ...prev, [key]: value }));

  const updateEditTarget = (key: keyof TargetFormState, value: string) =>
    setEditTargetFields((prev) => ({ ...prev, [key]: value }));

  const handleDiscoverSsh = async () => {
    if (!window.desktop?.discoverSshHosts) {
      setDiscoveryNotice("当前环境不支持自动读取 ~/.ssh/config");
      return;
    }
    setDiscoveringSsh(true);
    setDiscoveryNotice(null);
    try {
      const entries = await window.desktop.discoverSshHosts();
      setDiscoveredSsh(entries);
      if (entries.length === 0) {
        setDiscoveryNotice("未在 ~/.ssh/config 中发现可用宿主别名");
      }
    } catch {
      setDiscoveryNotice("读取 ~/.ssh/config 失败，请手动输入连接信息");
    } finally {
      setDiscoveringSsh(false);
    }
  };

  const applyDiscoveredSsh = (item: DiscoveredSshHost) => {
    setNewHostKind("ssh");
    if (!newHostId.trim()) setNewHostId(item.alias);
    if (!newHostLabel.trim()) setNewHostLabel(item.alias);
    setNewTargetFields((prev) => ({
      ...prev,
      sshAlias: item.alias,
      sshHostname: item.hostname ?? "",
      sshUser: item.user ?? "",
      sshPort: item.port !== undefined ? String(item.port) : "",
      sshIdentityFile: item.identityFile ?? "",
      sshProxyJump: item.proxyJump ?? "",
    }));
    setDiscoveryNotice(null);
    setValidationError(null);
  };

  const handleDiscoverWsl = async () => {
    if (!window.desktop?.discoverWslDistros) {
      setDiscoveryNotice("当前环境不支持检测 WSL 发行版");
      return;
    }
    setDiscoveringWsl(true);
    setDiscoveryNotice(null);
    try {
      const distros = await window.desktop.discoverWslDistros();
      setDiscoveredWsl(distros);
      if (distros.length === 0) {
        setDiscoveryNotice("未检测到本机 WSL 发行版");
      }
    } catch {
      setDiscoveryNotice("检测 WSL 发行版失败，请手动填写发行版名称");
    } finally {
      setDiscoveringWsl(false);
    }
  };

  const handleToggleHostEnabled = (hostId: string) => {
    setHosts((prev) =>
      prev.map((h) => (h.hostId === hostId ? { ...h, enabled: !h.enabled } : h))
    );
    setSaveSuccess(false);
  };

  const handleDeleteHost = (hostId: string) => {
    setHosts((prev) => prev.filter((h) => h.hostId !== hostId));
    setTasks((prev) => prev.filter((t) => t.hostId !== hostId));
    setSaveSuccess(false);
  };

  const startEditingHost = (h: HostRegistration) => {
    setEditingHostId(h.hostId);
    setEditHostLabel(h.label);
    setEditHostKind(h.target.kind);
    setEditHostRoots(h.allowedRoots.join("; "));
    setEditTargetFields(targetToFormState(h.target));
    setValidationError(null);
  };

  const finishEditingHost = () => {
    const parsedRoots = parseRoots(editHostRoots, editHostKind === "local");
    if (!parsedRoots.roots) {
      setValidationError(parsedRoots.error);
      return;
    }
    const built = buildAndValidateTarget(editHostKind, editTargetFields);
    if (!built.target) {
      setValidationError(built.error);
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
            }
          : h
      )
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
      setValidationError("宿主 ID 不能为空");
      return;
    }
    if (hosts.some((h) => h.hostId === id)) {
      setValidationError("该宿主 ID 已存在");
      return;
    }
    const parsedRoots = parseRoots(newHostRoots, newHostKind === "local");
    if (!parsedRoots.roots) {
      setValidationError(parsedRoots.error);
      return;
    }
    const built = buildAndValidateTarget(newHostKind, newTargetFields);
    if (!built.target) {
      setValidationError(built.error);
      return;
    }

    const newHost: HostRegistration = {
      hostId: id,
      label: newHostLabel.trim() || id,
      enabled: true,
      allowedRoots: parsedRoots.roots,
      target: built.target,
    };

    setHosts((prev) => [...prev, newHost]);
    setNewHostId("");
    setNewHostLabel("");
    setNewHostRoots("");
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
      setInternalError(err?.message || "重新拉取配置失败");
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
      const parsedRoots = parseRoots(editHostRoots, editHostKind === "local");
      if (!parsedRoots.roots) {
        setValidationError(parsedRoots.error);
        return;
      }
      const built = buildAndValidateTarget(editHostKind, editTargetFields);
      if (!built.target) {
        setValidationError(built.error);
        return;
      }
      const hostIdx = currentHosts.findIndex((h) => h.hostId === editingHostId);
      if (hostIdx !== -1) {
        currentHosts[hostIdx] = {
          ...currentHosts[hostIdx]!,
          label: editHostLabel.trim() || editingHostId,
          allowedRoots: parsedRoots.roots,
          target: built.target,
        };
      }
    }

    if (isAddingHost) {
      const id = newHostId.trim();
      if (!id) {
        setValidationError("宿主 ID 不能为空");
        return;
      }
      if (hosts.some((h) => h.hostId === id)) {
        setValidationError("该宿主 ID 已存在");
        return;
      }
      const parsedRoots = parseRoots(newHostRoots, newHostKind === "local");
      if (!parsedRoots.roots) {
        setValidationError(parsedRoots.error);
        return;
      }
      const built = buildAndValidateTarget(newHostKind, newTargetFields);
      if (!built.target) {
        setValidationError(built.error);
        return;
      }
      const newHost: HostRegistration = {
        hostId: id,
        label: newHostLabel.trim() || id,
        enabled: true,
        allowedRoots: parsedRoots.roots,
        target: built.target,
      };
      currentHosts.push(newHost);
    }

    // Validation
    const hostById = new Map<string, HostRegistration>();
    for (const h of currentHosts) {
      if (!h.hostId.trim()) {
        setValidationError("存在空的宿主 ID");
        return;
      }
      try {
        validateHostTarget(h.target);
      } catch {
        setValidationError("宿主 " + h.hostId + " 的连接目标配置无效");
        return;
      }
      const allowWin = h.target.kind === "local";
      for (const r of h.allowedRoots) {
        if (!isValidAbsolutePath(r, allowWin)) {
          setValidationError("宿主 " + h.hostId + (allowWin ? " 白名单根目录必须为绝对路径" : " 白名单根目录必须以 / 开头"));
          return;
        }
      }
      hostById.set(h.hostId, h);
    }

    for (const t of currentTasks) {
      if (!t.taskId.trim()) {
        setValidationError("存在空的任务 ID");
        return;
      }
      const parentHost = hostById.get(t.hostId);
      if (!parentHost) {
        setValidationError("任务 " + t.taskId + " 引用的宿主 " + t.hostId + " 不存在");
        return;
      }
      const allowWin = parentHost.target.kind === "local";
      for (const d of t.allowedDirectories) {
        if (!isValidAbsolutePath(d, allowWin)) {
          setValidationError("任务 " + t.taskId + (allowWin ? " 的工作目录必须为绝对路径" : " 的工作目录必须以 / 开头"));
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
      if (saveRes && typeof saveRes === "object" && "revision" in saveRes && typeof (saveRes as any).revision === "number") {
        setCurrentRevision((saveRes as any).revision);
      }
      setHosts(currentHosts);
      setTasks(currentTasks);
      setEditingHostId(null);
      setIsAddingHost(false);
      setNewHostId("");
      setNewHostLabel("");
      setNewHostRoots("");
      setNewTargetFields({ ...EMPTY_TARGET_FORM });
      setSaveSuccess(true);
      setIsConflict(false);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isConf = /409|conflict|冲突|revision/i.test(msg);
      setIsConflict(isConf);
      setInternalError(msg || "保存宿主配置失败，可能存在版本冲突");
    } finally {
      setIsSaving(false);
    }
  };

  const handleThemeChange = async (theme: "system" | "light" | "dark") => {
    const request = ++themeRequest.current;
    // Preference retries own only their feedback, leaving registry errors intact.
    setThemeError(null);
    try {
      await Promise.resolve(onUpdatePreferences({ ...preferences, theme }));
    } catch (err: any) {
      if (request === themeRequest.current) {
        setThemeError(err?.message || "更新偏好失败");
      }
    }
  };

  const displayError = validationError || internalError || externalError || themeError;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal-container settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="系统设置"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 className="modal-title">系统设置</h2>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={onClose}
            aria-label="关闭"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          {displayError && (
            <div className="alert alert-danger" role="alert">
              <div>
                <strong>错误提示: </strong> {displayError}
              </div>
              {isConflict && onReloadRegistry && (
                <div style={{ marginTop: "8px" }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={handleReloadRegistry}
                    disabled={isReloading}
                  >
                    {isReloading ? "正在重新加载..." : "重新加载最新配置"}
                  </button>
                </div>
              )}
            </div>
          )}

          {saveSuccess && (
            <div className="alert alert-success" role="status">
              ✓ 登记配置保存成功
            </div>
          )}

          {/* Section 1: Preferences */}
          <section className="modal-section">
            <h3 className="modal-section-title">外观</h3>
            <div className="theme-options-group" role="radiogroup" aria-label="主题偏好">
              <label className="theme-radio-label">
                <input
                  type="radio"
                  name="theme"
                  value="system"
                  checked={preferences.theme === "system"}
                  onChange={() => handleThemeChange("system")}
                />
                <span>跟随系统</span>
              </label>

              <label className="theme-radio-label">
                <input
                  type="radio"
                  name="theme"
                  value="light"
                  checked={preferences.theme === "light"}
                  onChange={() => handleThemeChange("light")}
                />
                <span>浅色</span>
              </label>

              <label className="theme-radio-label">
                <input
                  type="radio"
                  name="theme"
                  value="dark"
                  checked={preferences.theme === "dark"}
                  onChange={() => handleThemeChange("dark")}
                />
                <span>深色</span>
              </label>
            </div>
          </section>

          {/* Section 2: Registry Management */}
          <section className="modal-section">
            <div className="registry-tables">
              {/* Hosts Table & Form */}
              <div className="registry-group-header">
                <h4>宿主配置 ({hosts.length})</h4>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={() => setIsAddingHost((v) => !v)}
                >
                  {isAddingHost ? "取消添加" : "+ 添加宿主"}
                </button>
              </div>

              {isAddingHost && (
                <form className="registry-add-form" onSubmit={handleAddHostSubmit}>
                  <div className="form-row">
                    <label className="form-label">
                      新增宿主 ID:
                      <input
                        type="text"
                        className="form-input"
                        placeholder="例如: gpu-server-01"
                        value={newHostId}
                        onChange={(e) => setNewHostId(e.target.value)}
                      />
                    </label>
                    <label className="form-label">
                      新增宿主名称:
                      <input
                        type="text"
                        className="form-input"
                        placeholder="例如: GPU Server 01"
                        value={newHostLabel}
                        onChange={(e) => setNewHostLabel(e.target.value)}
                      />
                    </label>
                    <label className="form-label">
                      宿主类型:
                      <select
                        className="form-select"
                        value={newHostKind}
                        onChange={(e) => {
                          setNewHostKind(e.target.value as HostKind);
                          setDiscoveryNotice(null);
                        }}
                      >
                        <option value="ssh">SSH (远程服务器)</option>
                        <option value="wsl">WSL (本地子系统)</option>
                        <option value="local">Local (本机)</option>
                      </select>
                    </label>
                  </div>

                  {newHostKind === "ssh" && (
                    <>
                      <div className="form-row">
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={handleDiscoverSsh}
                          disabled={discoveringSsh}
                        >
                          {discoveringSsh ? "正在扫描..." : "从 ~/.ssh/config 导入"}
                        </button>
                        {discoveredSsh.length > 0 && (
                          <select
                            className="form-select form-select-sm"
                            aria-label="选择已发现的 SSH 宿主"
                            defaultValue=""
                            onChange={(e) => {
                              const found = discoveredSsh.find((h) => h.alias === e.target.value);
                              if (found) applyDiscoveredSsh(found);
                            }}
                          >
                            <option value="">选择导入条目 ({discoveredSsh.length})</option>
                            {discoveredSsh.map((item) => (
                              <option key={item.alias} value={item.alias}>
                                {item.alias}{item.hostname ? ` (${item.user ? `${item.user}@` : ""}${item.hostname}${item.port ? `:${item.port}` : ""})` : ""}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="form-row">
                        <label className="form-label">
                          SSH 别名 (Alias):
                          <input
                            type="text"
                            className="form-input"
                            placeholder="例如: gpu-server-01"
                            value={newTargetFields.sshAlias}
                            onChange={(e) => updateNewTarget("sshAlias", e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          主机地址 (HostName):
                          <input
                            type="text"
                            className="form-input"
                            placeholder="例如: 10.0.0.12"
                            value={newTargetFields.sshHostname}
                            onChange={(e) => updateNewTarget("sshHostname", e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          用户名 (User):
                          <input
                            type="text"
                            className="form-input"
                            placeholder="选填"
                            value={newTargetFields.sshUser}
                            onChange={(e) => updateNewTarget("sshUser", e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          端口 (Port):
                          <input
                            type="text"
                            className="form-input"
                            placeholder="22"
                            value={newTargetFields.sshPort}
                            onChange={(e) => updateNewTarget("sshPort", e.target.value)}
                          />
                        </label>
                      </div>
                      <div className="form-row">
                        <label className="form-label">
                          私钥路径 (IdentityFile):
                          <input
                            type="text"
                            className="form-input"
                            placeholder="选填，例如 ~/.ssh/id_ed25519"
                            value={newTargetFields.sshIdentityFile}
                            onChange={(e) => updateNewTarget("sshIdentityFile", e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          跳板机 (ProxyJump):
                          <input
                            type="text"
                            className="form-input"
                            placeholder="选填，例如 bastion"
                            value={newTargetFields.sshProxyJump}
                            onChange={(e) => updateNewTarget("sshProxyJump", e.target.value)}
                          />
                        </label>
                        <label className="form-label">
                          Python 路径 (选填):
                          <input
                            type="text"
                            className="form-input"
                            placeholder="留空自动探测"
                            value={newTargetFields.pythonPath}
                            onChange={(e) => updateNewTarget("pythonPath", e.target.value)}
                          />
                        </label>
                      </div>
                    </>
                  )}

                  {newHostKind === "wsl" && (
                    <div className="form-row">
                      <label className="form-label">
                        WSL 发行版:
                        <input
                          type="text"
                          className="form-input"
                          placeholder="例如: Ubuntu-24.04"
                          value={newTargetFields.wslDistribution}
                          onChange={(e) => updateNewTarget("wslDistribution", e.target.value)}
                        />
                      </label>
                      <div className="form-label">
                        <span>本机检测:</span>
                        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={handleDiscoverWsl}
                            disabled={discoveringWsl}
                          >
                            {discoveringWsl ? "检测中..." : "检测 WSL 发行版"}
                          </button>
                          {discoveredWsl.length > 0 && (
                            <select
                              className="form-select form-select-sm"
                              aria-label="选择已发现的 WSL 发行版"
                              defaultValue=""
                              onChange={(e) => {
                                if (!e.target.value) return;
                                updateNewTarget("wslDistribution", e.target.value);
                                if (!newHostId.trim()) setNewHostId(`wsl-${e.target.value.toLowerCase()}`);
                                if (!newHostLabel.trim()) setNewHostLabel(e.target.value);
                              }}
                            >
                              <option value="">选择发行版</option>
                              {discoveredWsl.map((d) => (
                                <option key={d.name} value={d.name}>
                                  {d.name}{d.running ? " (运行中)" : ""}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </div>
                      <label className="form-label">
                        Python 路径 (选填):
                        <input
                          type="text"
                          className="form-input"
                          placeholder="留空自动探测"
                          value={newTargetFields.pythonPath}
                          onChange={(e) => updateNewTarget("pythonPath", e.target.value)}
                        />
                      </label>
                    </div>
                  )}

                  {newHostKind === "local" && (
                    <div className="form-row">
                      <label className="form-label w-full">
                        本机 Python 路径 (选填):
                        <input
                          type="text"
                          className="form-input"
                          placeholder="留空自动探测本机 python3 / python"
                          value={newTargetFields.pythonPath}
                          onChange={(e) => updateNewTarget("pythonPath", e.target.value)}
                        />
                      </label>
                    </div>
                  )}

                  {discoveryNotice && (
                    <p className="text-muted" role="status">{discoveryNotice}</p>
                  )}

                  <div className="form-row">
                    <label className="form-label w-full">
                      白名单根目录 (选填，多目录分号隔开；留空仅查看宿主 GPU):
                      <input
                        type="text"
                        className="form-input"
                        placeholder={newHostKind === "local" ? "例如: /workspace 或 C:\\Projects" : "例如: /workspace"}
                        value={newHostRoots}
                        onChange={(e) => setNewHostRoots(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary btn-sm">
                      确认添加宿主
                    </button>
                  </div>
                </form>
              )}

              <div className="registry-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>宿主 ID</th>
                      <th>显示名称</th>
                      <th>类型 / 目标</th>
                      <th>状态</th>
                      <th>白名单根目录</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hosts.map((h) => {
                      const isEditing = editingHostId === h.hostId;
                      return (
                        <tr key={h.hostId}>
                          <td><code>{h.hostId}</code></td>
                          <td>
                            {isEditing ? (
                              <input
                                type="text"
                                className="form-input form-input-sm"
                                value={editHostLabel}
                                onChange={(e) => setEditHostLabel(e.target.value)}
                                aria-label="宿主名称"
                              />
                            ) : (
                              h.label
                            )}
                          </td>
                          <td>
                            {isEditing ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
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
                                {editHostKind === "ssh" && (
                                  <>
                                    <input
                                      type="text"
                                      className="form-input form-input-sm"
                                      placeholder="SSH 别名 (Alias)"
                                      aria-label="编辑 SSH 别名"
                                      value={editTargetFields.sshAlias}
                                      onChange={(e) => updateEditTarget("sshAlias", e.target.value)}
                                    />
                                    <input
                                      type="text"
                                      className="form-input form-input-sm"
                                      placeholder="主机地址 (HostName)"
                                      aria-label="编辑 SSH 主机地址"
                                      value={editTargetFields.sshHostname}
                                      onChange={(e) => updateEditTarget("sshHostname", e.target.value)}
                                    />
                                    <input
                                      type="text"
                                      className="form-input form-input-sm"
                                      placeholder="用户名 (选填)"
                                      aria-label="编辑 SSH 用户名"
                                      value={editTargetFields.sshUser}
                                      onChange={(e) => updateEditTarget("sshUser", e.target.value)}
                                    />
                                    <input
                                      type="text"
                                      className="form-input form-input-sm"
                                      placeholder="端口 (选填)"
                                      aria-label="编辑 SSH 端口"
                                      value={editTargetFields.sshPort}
                                      onChange={(e) => updateEditTarget("sshPort", e.target.value)}
                                    />
                                  </>
                                )}
                                {editHostKind === "wsl" && (
                                  <input
                                    type="text"
                                    className="form-input form-input-sm"
                                    placeholder="WSL 发行版"
                                    aria-label="编辑 WSL 发行版"
                                    value={editTargetFields.wslDistribution}
                                    onChange={(e) => updateEditTarget("wslDistribution", e.target.value)}
                                  />
                                )}
                                <input
                                  type="text"
                                  className="form-input form-input-sm"
                                  placeholder="Python 路径 (选填)"
                                  aria-label="编辑 Python 路径"
                                  value={editTargetFields.pythonPath}
                                  onChange={(e) => updateEditTarget("pythonPath", e.target.value)}
                                />
                              </div>
                            ) : (
                              <span>
                                <strong>{h.target.kind.toUpperCase()}</strong>{" "}
                                <small className="text-muted">{summarizeTarget(h.target)}</small>
                              </span>
                            )}
                          </td>
                          <td>
                            <button
                              type="button"
                              className={"btn btn-xs " + (h.enabled ? "btn-success" : "btn-secondary")}
                              onClick={() => handleToggleHostEnabled(h.hostId)}
                            >
                              {h.enabled ? "已启用" : "已停用"}
                            </button>
                          </td>
                          <td>
                            {isEditing ? (
                              <input
                                type="text"
                                className="form-input form-input-sm"
                                value={editHostRoots}
                                onChange={(e) => setEditHostRoots(e.target.value)}
                                aria-label="白名单根目录"
                              />
                            ) : (
                              <code>{h.allowedRoots.join("; ")}</code>
                            )}
                          </td>
                          <td>
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-primary btn-xs mr-1"
                                  onClick={finishEditingHost}
                                >
                                  完成
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-xs"
                                  onClick={() => setEditingHostId(null)}
                                >
                                  取消
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-xs mr-1"
                                  data-testid={"edit-host-" + h.hostId}
                                  onClick={() => startEditingHost(h)}
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-danger btn-xs"
                                  onClick={() => handleDeleteHost(h.hostId)}
                                >
                                  删除
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {hosts.length === 0 && (
                      <tr>
                        <td colSpan={6} className="text-muted">暂无已登记宿主</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

            </div>
          </section>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSaveAll}
            disabled={isSaving}
          >
            {isSaving ? "正在保存..." : "保存宿主配置"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
          >
            关闭设置
          </button>
        </div>
      </div>
    </div>
  );
}
