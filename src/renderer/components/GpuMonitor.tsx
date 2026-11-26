import React, { useEffect, useState } from 'react';
import { useMonitor } from '../hooks/useMonitor';
import { GpuDeviceMetrics } from './ResourceMetrics';
import { hostFailureMessage } from './HostConnectionPanel';
import { Icon } from './Icon';
import { formatTimestamp, formatTimeOnly } from '../utils/format';

/** A companion window: device samples belong to the host, never a selected task. */
export function GpuMonitor() {
  const { snapshot, registry, activeHost, activeHostId, selectHost, connectingHostIds, connectHost,
    hostConnectionErrors, resolvedTheme, updatePreferences, isSavingPreferences,
    error, isLoadingSnapshot, retrySnapshotLoad } = useMonitor();
  const [requestedHostId, setRequestedHostId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('hostId'));

  useEffect(() => window.desktop?.onGpuHostSelected(setRequestedHostId), []);
  useEffect(() => {
    if (!requestedHostId || !snapshot?.hosts.some(host => host.hostId === requestedHostId)) return;
    selectHost(requestedHostId);
    setRequestedHostId(null);
  }, [requestedHostId, snapshot, selectHost]);

  const registration = registry?.hosts.find(host => host.hostId === activeHostId);
  const disabled = registration?.enabled === false;
  const connecting = connectingHostIds.includes(activeHostId ?? '');
  const connected = activeHost?.connection === 'connected' && !disabled;
  const gpu = activeHost?.gpu;
  const resources = (gpu?.metrics ?? []).map(metric => disabled || !connected || gpu?.state !== 'available'
    ? { ...metric, freshness: 'stale' as const } : metric);
  const hasSamples = resources.length > 0;
  const stale = hasSamples && resources.some(metric => metric.freshness !== 'fresh');
  const connectionMessage = activeHost && (hostConnectionErrors[activeHost.hostId] || hostFailureMessage(activeHost.errorCode, activeHost.kind));
  const gpuUnavailable = connected && gpu?.state === 'unavailable';
  const status = connecting ? '连接中…' : disabled ? '已停用' : connected ? '已连接' : activeHost?.connection === 'disconnected' ? '连接已断开' : '待连接';

  return <div className="app-shell gpu-monitor-page" data-theme={resolvedTheme}>
    <header className="gpu-monitor-toolbar">
      <div className="gpu-monitor-title"><Icon name="monitor" /><h1>GPU 实时监控</h1>{snapshot?.demo && <span className="badge-demo">模拟数据</span>}</div>
      <div className="header-actions">
        <button type="button" className="btn btn-ghost btn-icon-only" disabled={isSavingPreferences} aria-label={resolvedTheme === 'light' ? '切换到深色主题' : '切换到浅色主题'} onClick={() => { void updatePreferences({ theme: resolvedTheme === 'light' ? 'dark' : 'light' }).catch(() => undefined); }}><Icon name={resolvedTheme === 'light' ? 'moon' : 'sun'} /></button>
        <button type="button" className="btn btn-secondary" onClick={() => window.close()}><Icon name="close" />关闭窗口</button>
      </div>
    </header>
    {!!snapshot?.hosts.length && <nav className="gpu-host-tabs" aria-label="选择设备">
      {snapshot.hosts.map(host => <button type="button" key={host.hostId} aria-pressed={host.hostId === activeHostId} onClick={() => selectHost(host.hostId)}>
        <Icon name={host.kind === 'ssh' ? 'server' : 'terminal'} /><span>{host.hostId}</span><span className="gpu-host-kind">{host.kind === 'ssh' ? 'SSH' : '本机 WSL'}</span>
      </button>)}
    </nav>}
    {error && <div role="alert" className="alert alert-danger gpu-monitor-alert"><span>{error}</span><button type="button" className="btn btn-secondary btn-sm" onClick={() => { void retrySnapshotLoad(); }}>重试读取</button></div>}
    <main className="gpu-monitor-content">
      {activeHost ? <>
        <div className="gpu-monitor-hostline">
          <div><h2>{registration?.label || activeHost.hostId}</h2><p className="gpu-monitor-host-meta"><span className={connected ? 'text-success' : 'text-muted'} role="status">{status}</span><span>约每 5 秒更新</span></p></div>
          {!disabled && <button type="button" className="btn btn-secondary" disabled={connecting || !registration} onClick={() => { void connectHost(activeHost.hostId); }}><Icon name="refresh" />{connecting ? '连接中…' : connected ? '立即刷新' : '重新连接'}</button>}
        </div>
        {(disabled || connectionMessage) && <p className="alert alert-warning" role="alert">{disabled ? '此宿主已停用，请在主窗口设置中启用。' : connectionMessage}</p>}
        {(stale || gpuUnavailable) && <p className="gpu-monitor-stale text-warning" role="status">{hasSamples ? '当前显示上次采样，等待更新。' : 'GPU 采样暂不可用，请稍后刷新。'}</p>}
        {hasSamples ? <GpuDeviceMetrics resources={resources} /> : <div className="gpu-monitor-empty"><Icon name="monitor" /><h2>{isLoadingSnapshot ? '正在读取 GPU 数据…' : '暂无 GPU 数据'}</h2><p>{disabled ? '启用宿主后即可查看整卡使用情况。' : connected ? '等待设备采样，或点击立即刷新。' : '连接设备后即可查看利用率与显存。'}</p></div>}
        {gpu?.observedAt && <p className="gpu-monitor-sample-time" title={formatTimestamp(gpu.observedAt)}>最近采样 {formatTimeOnly(gpu.observedAt)}{stale ? ' · 待更新' : ''}</p>}
      </> : <div className="gpu-monitor-empty"><Icon name="server" /><h2>{isLoadingSnapshot ? '正在读取设备…' : '暂无设备'}</h2><p>请在主窗口设置中添加宿主。</p></div>}
    </main>
  </div>;
}
