import type { Lifecycle } from '../../shared/contracts';

export function getLifecycleBadge(lifecycle: Lifecycle): {
  text: string;
  symbol: string;
  className: string;
} {
  switch (lifecycle) {
    case 'running':
      return { text: '运行中', symbol: '●', className: 'lifecycle-running' };
    case 'queued':
      return { text: '排队中', symbol: '⏳', className: 'lifecycle-queued' };
    case 'ready_not_training':
      return { text: '就绪未启动', symbol: '○', className: 'lifecycle-ready' };
    case 'completed':
      return { text: '已完成', symbol: '✓', className: 'lifecycle-completed' };
    case 'failed':
      return { text: '失败', symbol: '✕', className: 'lifecycle-failed' };
    case 'stopped_unconfirmed':
      return { text: '已停止', symbol: '■', className: 'lifecycle-stopped' };
    case 'unconfirmed':
      return { text: '待确认', symbol: '?', className: 'lifecycle-unconfirmed' };
    case 'not_observed':
      return { text: '未观测', symbol: '○', className: 'lifecycle-not-observed' };
    default:
      return { text: '未知', symbol: '—', className: 'lifecycle-unknown' };
  }
}
