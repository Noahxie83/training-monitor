import React from 'react';
import type { ProcessKey, ResourceMetric, TaskSnapshot } from '../../shared/contracts';
import { formatBytes, formatTimeOnly } from '../utils/format';

function sameProcess(a: ProcessKey | null, b: ProcessKey | null) {
  return Boolean(a && b && a.hostBootId === b.hostBootId && a.pid === b.pid && a.startTicks === b.startTicks);
}

function Metric({ label, metric, valuePrefix = '', valueSuffix = '' }: { label: string; metric?: ResourceMetric; valuePrefix?: string; valueSuffix?: string }) {
  return <div className="kpi-detail-row" data-resource-source={metric?.source}>
    <span className="kpi-detail-label">{label}:</span>
    <span className="kpi-detail-val tabular-num">
      <span>{valuePrefix}{metric?.value === null || metric?.value === undefined ? '未观测' : metric.unit === 'bytes' ? formatBytes(metric.value) : `${metric.value}%`}{valueSuffix}</span>
      {metric?.freshness === 'stale' && <span className="text-warning">（待更新）</span>}
    </span>
  </div>;
}

/** Resource samples carry independent stamps; process instance time is never a sampling time. */
export function ResourceMetrics({ task }: { task: TaskSnapshot }) {
  const { processes, resources } = task;
  const members = [
    { process: processes.main, label: '主进程', rss: '本进程物理内存', cpu: 'CPU 占用' },
    { process: processes.queue, label: '队列进程', rss: '队列进程物理内存', cpu: '队列进程 CPU 占用' },
    ...processes.workers.map(process => ({ process, label: `Worker ${process.pid}`, rss: `Worker ${process.pid} 物理内存`, cpu: `Worker ${process.pid} CPU 占用` })),
  ];
  return <>
    <details className="kpi-resource-section process-resource-section">
      <summary>训练进程{!members.some(m => m.process) && <span className="text-muted">暂无进程资源数据</span>}</summary>
      {members.some(m => m.process) ? <>
      <div className="kpi-detail-row"><span className="kpi-detail-label">主 PID:</span><span>{processes.main?.pid ?? '未观测'}</span></div>
      <div className="kpi-detail-row"><span className="kpi-detail-label">工作进程:</span><span>{processes.workers.length ? `${processes.workers.length} Workers` : '未观测'}</span></div>
      {members.filter(m => m.process && (m.process.role !== 'worker' || resources.some(sample => sample.scope === 'process' && sameProcess(sample.processKey, m.process?.key ?? null)))).map(({ process, label, rss, cpu }) => {
        const samples = resources.filter(m => m.scope === 'process' && sameProcess(m.processKey, process?.key ?? null));
        return <div key={label} className="kpi-process-group" aria-label={`${label}资源`}>
          <Metric label={rss} metric={samples.find(m => m.name === 'process_rss')} />
          <Metric label={cpu} metric={samples.find(m => m.name === 'cpu_utilization')} />
        </div>;
      })}
      </> : null}
    </details>
    <TaskGpuMetrics task={task} />
  </>;
}

export function TaskGpuMetrics({ task }: { task: TaskSnapshot }) {
  const usage = task.gpuUsage;
  const keys = usage?.processKeys ?? [task.processes.main?.key, ...task.processes.workers.map(process => process.key)].filter((key): key is ProcessKey => !!key);
  const metrics = task.resources.filter(metric => metric.scope === 'process' && metric.deviceId &&
    (metric.name === 'gpu_utilization' || metric.name === 'gpu_memory_used') && keys.some(key => sameProcess(key, metric.processKey)));
  const devices = [...new Set(metrics.map(metric => metric.deviceId!))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const stale = usage?.freshness === 'stale' || task.freshness === 'stale' || metrics.some(metric => metric.freshness === 'stale');
  const empty = usage?.errorCode === 'WSL_PROCESS_GPU_UNAVAILABLE' ? '当前环境暂不支持进程 GPU 归属识别'
    : usage?.state === 'available' && usage.processKeys.length ? '当前进程未检测到 GPU 使用'
    : !task.processes.main && !usage?.processKeys.length ? '等待确认训练进程' : '暂时无法获取进程 GPU 使用情况';
  return <section className="kpi-resource-section gpu-resource-section task-gpu-section" aria-label="当前任务 GPU">
    <div className="section-heading"><h3>当前任务 GPU{devices.length ? ` · ${devices.length} 张` : ''}</h3><span className="text-muted">进程利用率 / 显存</span></div>
    <div className="gpu-device-list">{devices.length ? devices.map(device => {
      const samples = metrics.filter(metric => metric.deviceId === device);
      const processes = keys.filter((key, index) => keys.findIndex(other => sameProcess(key, other)) === index && samples.some(metric => sameProcess(metric.processKey, key)));
      return <div key={device} className="kpi-device-group task-gpu-device" aria-label={`${device}进程资源`}>
        <div className="gpu-device-heading"><strong>{device}</strong><span className={stale ? 'text-warning task-gpu-badge' : 'text-success task-gpu-badge'}>{stale ? '上次使用' : '本任务使用'}</span></div>
        {processes.map(key => {
          const utilization = samples.find(metric => metric.name === 'gpu_utilization' && sameProcess(metric.processKey, key));
          const memory = samples.find(metric => metric.name === 'gpu_memory_used' && sameProcess(metric.processKey, key));
          return <div key={`${key.hostBootId}:${key.pid}:${key.startTicks}`} className="task-gpu-process">
            <div className="gpu-memory-row"><span>PID {key.pid}</span><span>{utilization?.value === null || utilization?.value === undefined ? '利用率未提供' : `${utilization.value}%`}</span></div>
            <div className="gpu-meter" role="meter" aria-label={`${device} PID ${key.pid} 利用率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={utilization?.value ?? undefined}><span className="gpu-meter-fill" style={{ width: `${utilization?.value ?? 0}%` }} /></div>
            <div className="gpu-memory-row"><span>进程显存</span><span>{memory?.value === null || memory?.value === undefined ? '未提供' : formatBytes(memory.value)}</span></div>
          </div>;
        })}
        {stale && <span className="text-warning gpu-stale">待更新</span>}
      </div>;
    }) : <div className="text-muted task-gpu-empty">{empty}</div>}</div>
    {usage?.observedAt && <p className="task-gpu-updated text-muted">采样于 {formatTimeOnly(usage.observedAt)}</p>}
  </section>;
}

export function GpuDeviceMetrics({ resources }: { resources: ResourceMetric[] }) {
  const devices = [...new Set(resources.filter(m => m.scope === 'device').map(m => m.deviceId))];
  return <section className="kpi-resource-section gpu-resource-section">
      <div className="section-heading"><h3>GPU 整卡{devices.length ? ` · ${devices.length} 张` : ''}</h3><span className="text-muted">利用率 / 显存</span></div>
      <div className="gpu-device-list">{devices.length ? devices.map(device => {
        const samples = resources.filter(m => m.scope === 'device' && m.deviceId === device);
        const utilization = samples.find(m => m.name === 'gpu_utilization');
        const memoryUsed = samples.find(m => m.name === 'gpu_memory_used');
        const memoryTotal = samples.find(m => m.name === 'gpu_memory_total');
        const memoryRatio = memoryUsed?.value !== null && memoryUsed?.value !== undefined &&
          memoryTotal?.value !== null && memoryTotal?.value !== undefined && memoryTotal.value > 0
          ? Math.max(0, Math.min(100, memoryUsed.value / memoryTotal.value * 100)) : null;
        const stale = [utilization, memoryUsed, memoryTotal].some(metric => metric?.freshness === 'stale');
        return <div key={device} className="kpi-device-group" aria-label={`${device}整卡资源`}>
          <div className="gpu-device-heading">
            <span>{device}</span>
            <span>{utilization?.value === null || utilization?.value === undefined ? '未观测' : `${utilization.value}%`}</span>
          </div>
          <div className="gpu-meter" role="meter" aria-label={`${device} 利用率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={utilization?.value ?? undefined}>
            <span className="gpu-meter-fill" style={{ width: `${utilization?.value ?? 0}%` }} />
          </div>
          <div className="gpu-memory-row">
            <span>显存</span>
            <span>{memoryUsed?.value === null || memoryUsed?.value === undefined ? '未观测' : formatBytes(memoryUsed.value)} / {memoryTotal?.value === null || memoryTotal?.value === undefined ? '未观测' : formatBytes(memoryTotal.value)}</span>
          </div>
          <div className="gpu-meter gpu-memory-meter" role="meter" aria-label={`${device} 显存`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={memoryRatio ?? undefined}>
            <span className="gpu-meter-fill" style={{ width: `${memoryRatio ?? 0}%` }} />
          </div>
          {stale && <span className="text-warning gpu-stale">（待更新）</span>}
        </div>;
      }) : <div className="text-muted">暂无 GPU 数据</div>}</div>
    </section>;
}
