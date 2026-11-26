import React from 'react';
import type { TaskSnapshot } from '../../shared/contracts';
import { formatNumber, formatTimestamp, formatTimeOnly } from '../utils/format';
import { Icon } from './Icon';

export function KpiMetricsGrid({ task }: { task: TaskSnapshot }) {
  const { progress, checkpoint } = task;
  const stale = progress.freshness === 'stale';
  const eta = progress.etaSeconds;
  return <div className="training-facts" role="region" aria-label="核心指标看板">
    <dl className="execution-facts">
      <div><dt>当前 Step</dt><dd className="tabular-num">{progress.lastStepIndex === null ? '未知' : formatNumber(progress.lastStepIndex)}{stale && <small>待更新</small>}</dd></div>
      <div><dt>速率</dt><dd className="tabular-num">{stale ? '待更新' : progress.iterationsPerSecond === null ? '—' : <>{progress.iterationsPerSecond}<small>it/s</small></>}</dd></div>
      <div><dt>预计剩余</dt><dd className="tabular-num">{stale ? '待更新' : eta === null ? '—' : <>{Math.floor(eta / 3600)}<small>小时</small>{Math.floor(eta % 3600 / 60)}<small>分</small></>}</dd></div>
    </dl>
    <div className="checkpoint-row" aria-label="最新检查点">
      <Icon name="file" /><span className="checkpoint-label">最新检查点</span>
      {checkpoint.path ? <>
        <span className="checkpoint-file" title={checkpoint.path}>{checkpoint.path.split('/').pop()}</span>
        <span className="checkpoint-step" title="从检查点文件名读取的步数">{checkpoint.fileStepIndex === null ? '—' : `Step ${formatNumber(checkpoint.fileStepIndex)}`}</span>
        <span className="checkpoint-time" title={formatTimestamp(checkpoint.mtime)}>{checkpoint.freshness === 'stale' ? '待更新' : formatTimeOnly(checkpoint.mtime)}</span>
      </> : <span className="text-muted">暂无检查点信息</span>}
    </div>
  </div>;
}
