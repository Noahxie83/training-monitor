import React from 'react';
import type { HostRegistration, HostSnapshot } from '../../shared/contracts';
import { formatTimestamp } from '../utils/format';
import { Icon } from './Icon';

export function hostFailureMessage(code: string | null, kind: HostSnapshot['kind']): string | null {
  if (!code) return null;
  if (code === 'WSL_NOT_RUNNING') return 'WSL 尚未运行，请先启动 Ubuntu-26.04，再点击连接。';
  if (code === 'HOST_DISABLED') return '此宿主已停用，可在设置中启用。';
  if (code === 'PROBE_TIMEOUT') return '连接超时，请检查网络后重试。';
  if (code === 'SSH_EXIT_UNCLASSIFIED') return 'SSH 连接失败，请检查网络及 SSH 登录配置后重试。';
  if (code === 'TRANSPORT_UNAVAILABLE') return kind === 'wsl' ? '无法调用 WSL，请检查本机 WSL 是否可用。' : '无法调用 SSH，请检查本机 SSH 是否可用。';
  if (code === 'HOST_IDENTITY_UNAVAILABLE') return '已启动探测，但无法读取宿主身份，请重试。';
  return `连接检测未完成：${code}`;
}

export function HostConnectionPanel({ host, registration, connecting, error, onConnect, onOpenSettings }: {
  host: HostSnapshot;
  registration?: HostRegistration;
  connecting: boolean;
  error?: string;
  onConnect: () => void;
  onOpenSettings: () => void;
}) {
  const disabled = registration?.enabled === false;
  const connected = !disabled && host.connection === 'connected';
  const status = connecting ? '连接中…' : disabled ? '已停用' : connected ? '已连接' : host.connection === 'disconnected' ? '连接已断开' : '待连接';
  const message = error || hostFailureMessage(host.errorCode, host.kind);
  return <section className="host-connection-panel" aria-label={`${host.hostId}连接状态`}>
    <div className="host-connection-heading">
      <div className="host-connection-ident"><Icon name={host.kind === 'ssh' ? 'server' : 'terminal'} /><strong>{host.hostId}</strong><span className={connected ? 'text-success' : 'text-muted'} role="status">{status}</span></div>
      {disabled ? <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenSettings}>在设置中启用</button>
        : <button type="button" className={`btn btn-sm ${connected ? 'btn-secondary' : 'btn-primary'}`} disabled={connecting || !registration} onClick={onConnect}>
          <Icon name="refresh" />{connecting ? '连接中…' : connected ? '检查连接' : host.connection === 'disconnected' ? '重新连接' : '连接'}
        </button>}
    </div>
    {message && <p className="host-connection-error text-warning" role="alert">{message}</p>}
    {!connecting && host.observedAt && <p className="host-connection-time">最近检测：{formatTimestamp(host.observedAt)}{!connected && host.lastSuccessAt ? ` · 上次连接：${formatTimestamp(host.lastSuccessAt)}` : ''}</p>}
  </section>;
}
