import React from 'react';
import type { HostSnapshot } from '../../shared/contracts';
import { GpuDeviceMetrics } from './ResourceMetrics';
import { Icon } from './Icon';

export function HostOverview({ host, label, taskCount, onAddTask }: {
  host: HostSnapshot | null; label?: string; taskCount: number; onAddTask?: () => void;
}) {
  return <main className="host-overview" aria-label="宿主首页">
    <div className="host-overview-heading"><div><h2>{label || host?.hostId || '暂无宿主'}</h2><p>{taskCount ? `已登记 ${taskCount} 个任务 · 从左侧选择任务查看进程与日志` : host ? `为 ${host.hostId} 添加任务，开始查看训练进度和日志。` : '先在设置中添加宿主。'}</p></div>
      {onAddTask && <button type="button" className="btn btn-primary" aria-label={taskCount ? '添加监控任务' : '添加第一个任务'} onClick={onAddTask}><Icon name="plus" />添加任务</button>}
    </div>
    {!taskCount && <h3 className="host-empty-tasks">暂无已登记任务</h3>}
    <GpuDeviceMetrics resources={host?.gpu?.metrics ?? []} />
  </main>;
}
