import React from 'react';
import type { HostSnapshot } from '../../shared/contracts';
import { formatTimeOnly } from '../utils/format';
import { Icon } from './Icon';

interface HeaderProps {
  hosts: HostSnapshot[];
  isDemo: boolean;
  lastSyncTime: string | null;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onOpenGpu?: () => void;
  announcement: string;
  isRefreshing?: boolean;
  theme?: "light" | "dark";
  onToggleTheme?: () => void;
  isSavingTheme?: boolean;
  activeHostId?: string | null;
  onSelectHost?: (hostId: string) => void;
}

export function Header({
  hosts,
  isDemo,
  lastSyncTime,
  onRefresh,
  onOpenSettings,
  onOpenGpu,
  announcement,
  isRefreshing = false,
  theme = "light", onToggleTheme, isSavingTheme = false,
  activeHostId, onSelectHost,
}: HeaderProps) {
  return (
    <header className="app-header">
      <div className="header-brand">
        <Icon name="monitor" /><h1 className="header-title">训练监控器</h1>
        {isDemo && <span className="badge badge-demo">模拟数据</span>}
      </div>

      <div className="header-telemetry" role="status" aria-label="宿主连接状态">
        {hosts.map((host) => {
          let statusClass = 'status-unobserved';
          let statusText = '未观测 / 待探测';

          if (host.connection === 'connected') {
            statusClass = 'status-connected';
            statusText = '已连接';
          } else if (host.connection === 'connecting') {
            statusClass = 'status-connecting';
            statusText = '连接中...';
          } else if (host.connection === 'disconnected') {
            statusClass = 'status-disconnected';
            statusText = '连接断开';
          } else if (host.kind === 'wsl') {
            statusClass = 'status-unobserved';
            statusText = '未观测 / 待探测';
          }

          return (
            <button type="button" key={host.hostId} className={`host-pill ${statusClass}`} aria-label={`切换到 ${host.hostId}`} aria-pressed={activeHostId === host.hostId} onClick={() => onSelectHost?.(host.hostId)} title={`最近连接：${formatTimeOnly(host.lastSuccessAt)}${host.scanComplete ? '' : '，部分信息未读取'}`}>
              <span className="host-kind">
                {host.kind === 'ssh' ? 'SSH' : 'WSL'}
              </span>
              <span className="host-id">{host.hostId}</span>
              <span className="host-status-indicator"></span>
              <span className="host-status-text">
                {statusText}
              </span>
            </button>
          );
        })}
      </div>

      <div className="header-actions">
        {onOpenGpu && <button type="button" className="btn btn-secondary" onClick={onOpenGpu} aria-label="打开 GPU 实时监控窗口" title="独立窗口查看设备 GPU"><Icon name="monitor" /><span>GPU 实时监控</span></button>}
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          onClick={onRefresh}
          title={`刷新 (Ctrl+R) · 最近更新 ${formatTimeOnly(lastSyncTime)}`}
          aria-label="刷新全部宿主与任务数据 (Ctrl+R)"
          disabled={isRefreshing}
        >
          <Icon name="refresh" />{isRefreshing ? "刷新中…" : "刷新"}
        </button>
        {onToggleTheme && <button type="button" className="btn btn-ghost btn-icon-only" title={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'} aria-label={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'} disabled={isSavingTheme} onClick={onToggleTheme}><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button>}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onOpenSettings}
          title="系统设置"
          aria-label="系统设置"
        >
          <Icon name="settings" /><span>设置</span>
        </button>
      </div>

      {/* Low-frequency polite aria-live announcement */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>
    </header>
  );
}
