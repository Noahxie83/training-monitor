import { Icon } from './Icon';
import React, { useState, useEffect, useRef } from "react";
import type { Preferences, Registry, HostRegistration, TaskRegistration } from "../../shared/contracts";
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
  const [newHostKind, setNewHostKind] = useState<"ssh" | "wsl">("ssh");
  const [newHostRoots, setNewHostRoots] = useState("");

  // Edit Host state (I1)
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editHostLabel, setEditHostLabel] = useState("");
  const [editHostKind, setEditHostKind] = useState<"ssh" | "wsl">("ssh");
  const [editHostRoots, setEditHostRoots] = useState("");

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
  }, [registry, isOpen]);

  useEffect(() => {
    setThemeError(null);
    return () => { themeRequest.current++; };
  }, [isOpen]);

  if (!isOpen) return null;

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
    setValidationError(null);
  };

  const finishEditingHost = () => {
    const roots = editHostRoots
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (roots.length === 0) {
      setValidationError("白名单根目录路径不能为空且必须以 / 开头");
      return;
    }
    for (const r of roots) {
      if (!r.startsWith("/")) {
        setValidationError("白名单根目录路径必须以 / 开头");
        return;
      }
    }
    setHosts((prev) =>
      prev.map((h) =>
        h.hostId === editingHostId
          ? {
              ...h,
              label: editHostLabel.trim() || h.hostId,
              allowedRoots: roots,
              target:
                editHostKind === "ssh"
                  ? { kind: "ssh", alias: "lab-campus" }
                  : { kind: "wsl", distribution: "Ubuntu-26.04" },
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
    const roots = newHostRoots
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const r of roots) {
      if (!r.startsWith("/")) {
        setValidationError("白名单根目录路径必须以 / 开头");
        return;
      }
    }

    const newHost: HostRegistration = {
      hostId: id,
      label: newHostLabel.trim() || id,
      enabled: true,
      allowedRoots: roots.length > 0 ? roots : ["/home"],
      target:
        newHostKind === "ssh"
          ? { kind: "ssh", alias: "lab-campus" }
          : { kind: "wsl", distribution: "Ubuntu-26.04" },
    };

    setHosts((prev) => [...prev, newHost]);
    setNewHostId("");
    setNewHostLabel("");
    setNewHostRoots("");
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
      const roots = editHostRoots
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (roots.length === 0) {
        setValidationError("白名单根目录路径不能为空且必须以 / 开头");
        return;
      }
      for (const r of roots) {
        if (!r.startsWith("/")) {
          setValidationError("白名单根目录路径必须以 / 开头");
          return;
        }
      }
      const hostIdx = currentHosts.findIndex((h) => h.hostId === editingHostId);
      if (hostIdx !== -1) {
        currentHosts[hostIdx] = {
          ...currentHosts[hostIdx],
          label: editHostLabel.trim() || editingHostId,
          allowedRoots: roots,
          target:
            editHostKind === "ssh"
              ? { kind: "ssh", alias: "lab-campus" }
              : { kind: "wsl", distribution: "Ubuntu-26.04" },
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
      const roots = newHostRoots
        .split(/[;,]/)
        .map((item: string) => item.trim())
        .filter(Boolean);
      for (const r of roots) {
        if (!r.startsWith("/")) {
          setValidationError("白名单根目录路径必须以 / 开头");
          return;
        }
      }
      const newHost: HostRegistration = {
        hostId: id,
        label: newHostLabel.trim() || id,
        enabled: true,
        allowedRoots: roots.length > 0 ? roots : ["/home"],
        target:
          newHostKind === "ssh"
            ? { kind: "ssh", alias: "lab-campus" }
            : { kind: "wsl", distribution: "Ubuntu-26.04" },
      };
      currentHosts.push(newHost);
    }

    // Validation
    for (const h of currentHosts) {
      if (!h.hostId.trim()) {
        setValidationError("存在空的宿主 ID");
        return;
      }
      for (const r of h.allowedRoots) {
        if (!r.startsWith("/")) {
          setValidationError("宿主 " + h.hostId + " 白名单根目录必须以 / 开头");
          return;
        }
      }
    }

    for (const t of currentTasks) {
      if (!t.taskId.trim()) {
        setValidationError("存在空的任务 ID");
        return;
      }
      if (!currentHosts.some((h) => h.hostId === t.hostId)) {
        setValidationError("任务 " + t.taskId + " 引用的宿主 " + t.hostId + " 不存在");
        return;
      }
      for (const d of t.allowedDirectories) {
        if (!d.startsWith("/")) {
          setValidationError("任务 " + t.taskId + " 的工作目录必须以 / 开头");
          return;
        }
      }
    }

    setIsSaving(true);
    try {
      const updatedRegistry: Registry = {
        version: 1,
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
      await Promise.resolve(onUpdatePreferences({ theme }));
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
                        placeholder="例如: lab-campus"
                        value={newHostId}
                        onChange={(e) => setNewHostId(e.target.value)}
                      />
                    </label>
                    <label className="form-label">
                      新增宿主名称:
                      <input
                        type="text"
                        className="form-input"
                        placeholder="例如: Lab Campus (SSH)"
                        value={newHostLabel}
                        onChange={(e) => setNewHostLabel(e.target.value)}
                      />
                    </label>
                    <label className="form-label">
                      宿主类型:
                      <select
                        className="form-select"
                        value={newHostKind}
                        onChange={(e) => setNewHostKind(e.target.value as "ssh" | "wsl")}
                      >
                        <option value="ssh">SSH (远程服务器)</option>
                        <option value="wsl">WSL (本地子系统)</option>
                      </select>
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="form-label w-full">
                      白名单根目录 (以 / 开头，多目录分号隔开):
                      <input
                        type="text"
                        className="form-input"
                        placeholder="/data2/cy/xzn"
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
                      <th>类型</th>
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
                              <select
                                className="form-select form-select-sm"
                                value={editHostKind}
                                onChange={(e) => setEditHostKind(e.target.value as "ssh" | "wsl")}
                                aria-label="宿主类型"
                              >
                                <option value="ssh">SSH</option>
                                <option value="wsl">WSL</option>
                              </select>
                            ) : (
                              h.target.kind.toUpperCase()
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
