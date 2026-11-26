import { Icon } from './Icon';
import React from "react";
import { ResourceMetrics } from "./ResourceMetrics";
import type { TaskSnapshot, ProcessInstance, ProcessKey } from "../../shared/contracts";
import { formatTimestamp } from "../utils/format";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface EvidenceDrawerProps {
  task: TaskSnapshot | null;
  isOpen: boolean;
  onClose: () => void;
}

export function EvidenceDrawer({ task, isOpen, onClose }: EvidenceDrawerProps) {
  const containerRef = useFocusTrap(isOpen, onClose);

  if (!isOpen || !task) return null;

  const { processes, queueLock, evidence, statusObservedAt, confidence, reason } = task;
  const mainProcess = processes.main;
  const queueProcess = processes.queue;
  const workerPids = processes.workers.map((w: ProcessInstance) => w.pid).join(", ");
  const cwd = mainProcess?.cwd ?? queueProcess?.cwd ?? "未知";
  const scriptEntry = mainProcess?.scriptEntry ?? queueProcess?.scriptEntry ?? "未知";

  const formatKey = (key?: ProcessKey | null): string => {
    if (!key) return "未知";
    return `${key.hostBootId}:${key.pid}:${key.startTicks}`;
  };


  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="drawer-content"
        role="dialog"
        aria-modal="true"
        aria-label="白名单证据审查抽屉"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="drawer-header">
          <h2 className="drawer-title">任务详情</h2>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={onClose}
            aria-label="关闭抽屉"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="drawer-body">

          {/* Primary Process Identity (I10) */}
          <section className="drawer-section">
            <h3 className="drawer-section-title">进程实例与归属</h3>
            <div className="drawer-field-row">
              <span className="field-label">主进程 PID (mainPid):</span>
              <span className="field-value tabular-num">
                {mainProcess ? mainProcess.pid + " (已观测实例)" : "未观测"}
              </span>
            </div>
            {mainProcess && (
              <>
                <div className="drawer-field-row">
                  <span className="field-label">主进程实例键 (mainKey):</span>
                  <span className="field-value tabular-num">{formatKey(mainProcess.key)}</span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">主进程父键 (parentKey):</span>
                  <span className="field-value tabular-num">{formatKey(mainProcess.parentKey)}</span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">角色 / 观测时间:</span>
                  <span className="field-value tabular-num">
                    {mainProcess.role} | {formatTimestamp(mainProcess.observedAt)}
                  </span>
                </div>
              </>
            )}
            {queueProcess && (
              <>
                <div className="drawer-field-row">
                  <span className="field-label">排队进程 PID (queuePid):</span>
                  <span className="field-value tabular-num">
                    {queueProcess.pid} (角色: {queueProcess.role})
                  </span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">排队进程实例键 (queueKey):</span>
                  <span className="field-value tabular-num">{formatKey(queueProcess.key)}</span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">排队进程父键 (parentKey):</span>
                  <span className="field-value tabular-num">{formatKey(queueProcess.parentKey)}</span>
                </div>
                <div className="drawer-field-row">
                  <span className="field-label">排队进程观测时间:</span>
                  <span className="field-value tabular-num">{formatTimestamp(queueProcess.observedAt)}</span>
                </div>
              </>
            )}
            <div className="drawer-field-row">
              <span className="field-label">工作进程数量:</span>
              <span className="field-value tabular-num">
                {processes.workers.length > 0 ? `${processes.workers.length} 个工作进程 (${workerPids})` : "未观测"}
              </span>
            </div>
            {processes.workers.map((w, idx) => (
              <div key={idx} className="drawer-field-row ms-3">
                <span className="field-label">Worker #{idx + 1} PID {w.pid} (角色: {w.role}):</span>
                <span className="field-value tabular-num">
                  键: {formatKey(w.key)} (父: {formatKey(w.parentKey)}) | {formatTimestamp(w.observedAt)}
                </span>
              </div>
            ))}
            <div className="drawer-field-row">
              <span className="field-label">工作目录 (cwd):</span>
              <span className="field-value field-path">{cwd}</span>
            </div>
            <div className="drawer-field-row">
              <span className="field-label">脚本入口 (scriptEntry):</span>
              <span className="field-value field-path">{scriptEntry}</span>
            </div>
            <div className="drawer-field-row">
              <span className="field-label">任务状态观测时间:</span>
              <span className="field-value tabular-num" title={statusObservedAt ?? ""}>
                {formatTimestamp(statusObservedAt)}
              </span>
            </div>
          </section>

          <section className="drawer-section">
            <h3 className="drawer-section-title">进程与整卡设备指标（独立采样）</h3>
            <ResourceMetrics task={task} />
          </section>

          {/* Queue Lock Status */}
          <section className="drawer-section">
            <h3 className="drawer-section-title">队列与锁证据</h3>
            <div className="drawer-field-row">
              <span className="field-label">锁文件是否存在 (exists):</span>
              <span className="field-value">
                {queueLock.exists === null
                  ? "未知"
                  : queueLock.exists
                  ? "存在"
                  : "不存在"}
              </span>
            </div>
            <div className="drawer-field-row">
              <span className="field-label">进程是否确证持锁 (held):</span>
              <span className="field-value">
                {queueLock.heldByRegisteredProcess === null
                  ? "未知"
                  : queueLock.heldByRegisteredProcess
                  ? "持有"
                  : "未持有"}
              </span>
            </div>
            <div className="drawer-field-row">
              <span className="field-label">锁文件路径 (source):</span>
              <span className="field-value field-path">
                {queueLock.source ?? "—"}
              </span>
            </div>
            <div className="drawer-field-row">
              <span className="field-label">锁观测时间:</span>
              <span className="field-value tabular-num">
                {formatTimestamp(queueLock.observedAt)}
              </span>
            </div>
            <div className="drawer-field-row">
              <span className="field-label">锁新鲜度:</span>
              <span className="field-value">
                {queueLock.freshness === "stale" ? "陈旧 [上次观测]" : queueLock.freshness === "fresh" ? "新鲜" : "未知"}
              </span>
            </div>
          </section>

          {/* Observation Evidence Items */}
          <section className="drawer-section">
            <h3 className="drawer-section-title">
              状态判定证据链 (置信度: {confidence})
            </h3>
            <p className="drawer-reason-text">判定理由: {reason}</p>

            <div className="evidence-items-list">
              {evidence.map((ev: TaskSnapshot["evidence"][number], i: number) => (
                <div key={i} className="evidence-item-card">
                  <div className="evidence-item-header">
                    <span className="evidence-kind">{ev.kind}</span>
                    <span className="evidence-time tabular-num" title={ev.observedAt}>
                      {formatTimestamp(ev.observedAt)}
                    </span>
                  </div>
                  <div className="evidence-summary">{ev.summary}</div>
                  {ev.sourceId && (
                    <div className="evidence-source">来源: {ev.sourceId}</div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="drawer-footer">
          <button
            type="button"
            className="btn btn-secondary w-full"
            onClick={onClose}
          >
            关闭证据抽屉
          </button>
        </div>
      </div>
    </div>
  );
}
