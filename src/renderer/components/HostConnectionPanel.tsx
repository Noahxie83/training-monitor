import React from 'react';
import type { HostRegistration, HostSnapshot } from '../../shared/contracts';
import { formatTimestamp } from '../utils/format';
import { Icon } from './Icon';

export function hostFailureMessage(
  code: string | null,
  kind: HostSnapshot['kind'],
  registration?: HostRegistration,
): string | null {
  if (!code) return null;
  if (code === 'WSL_NOT_RUNNING') {
    const distro = registration?.target.kind === 'wsl' ? registration.target.distribution : '目标发行版';
    return `WSL 尚未运行，请先启动 ${distro}，再点击连接。`;
  }
  if (code === 'SSH_HOST_KEY_UNKNOWN') {
    const sshTarget = registration?.target.kind === 'ssh'
      ? (registration.target.alias ?? (registration.target.user ? `${registration.target.user}@${registration.target.hostname}` : registration.target.hostname) ?? '<host>')
      : '<host>';
    return `未信任远程主机指纹，请先在终端运行 ssh ${sshTarget} 确认主机指纹后再重试。`;
  }
  if (code === 'SSH_AUTH_FAILED') return 'SSH 身份认证失败，请检查私钥、ssh-agent 或登录配置（已禁用交互式密码输入）。';
  if (code === 'SSH_CONNECTION_REFUSED') return '目标主机拒绝了 SSH 连接，请检查主机地址、端口与 sshd 服务状态。';
  if (code === 'SSH_TIMEOUT') return 'SSH 连接超时，请检查网络、防火墙或跳板机配置后重试。';
  if (code === 'HOST_UNREACHABLE') return '无法连接到目标主机，请检查网络连通性与主机配置后重试。';
  if (code === 'REMOTE_PYTHON_UNAVAILABLE') return '目标环境未找到可用的 Python 3.7+，请安装 python3 或在宿主设置中指定自定义 pythonPath。';
  if (code === 'HOST_DISABLED') return '此宿主已停用，可在设置中启用。';
  if (code === 'PROBE_TIMEOUT') return '连接超时，请检查网络后重试。';
  if (code === 'SSH_EXIT_UNCLASSIFIED') return 'SSH 连接失败，请检查网络及 SSH 登录配置后重试。';
  if (code === 'TRANSPORT_UNAVAILABLE') {
    if (kind === 'wsl') return '无法调用 WSL，请检查本机 WSL 是否可用。';
    if (kind === 'local') return '无法启动本机 Python 探测进程，请检查本机 Python 环境或指定 pythonPath。';
    return '无法调用 SSH，请检查本机 SSH 是否可用。';
  }
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
  const message = error || hostFailureMessage(host.errorCode, host.kind, registration);
  const retryNote = !connecting && !connected && !disabled && host.nextRetryAt
    ? ` · 下次自动重试：${formatTimestamp(host.nextRetryAt)}`
    : '';
  return <section className="host-connection-panel" aria-label={`${host.hostId}连接状态`}>
    <div className="host-connection-heading">
      <div className="host-connection-ident"><Icon name={host.kind === 'ssh' ? 'server' : 'terminal'} /><strong>{host.hostId}</strong><span className={connected ? 'text-success' : 'text-muted'} role="status">{status}</span></div>
      {disabled ? <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenSettings}>在设置中启用</button>
        : <button type="button" className={`btn btn-sm ${connected ? 'btn-secondary' : 'btn-primary'}`} disabled={connecting || !registration} onClick={onConnect}>
          <Icon name="refresh" />{connecting ? '连接中…' : connected ? '检查连接' : host.connection === 'disconnected' ? '重新连接' : '连接'}
        </button>}
    </div>
    {message && <p className="host-connection-error text-warning" role="alert">{message}</p>}
    {!connecting && (host.observedAt || retryNote) && <p className="host-connection-time">{host.observedAt ? `最近检测：${formatTimestamp(host.observedAt)}` : ''}{!connected && host.lastSuccessAt ? ` · 上次连接：${formatTimestamp(host.lastSuccessAt)}` : ''}{retryNote}</p>}
  </section>;
}
