import { Icon } from './Icon';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AutoStartConfig, HostSnapshot, Registry, TaskRegistration } from '../../shared/contracts';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { parseAndValidateTaskForm, type TaskFormInputs } from './task-form';
import { taskAlgorithmName, taskLogFormat } from '../../shared/task-profile';
import {
  AutoStartFields,
  autoStartScopeKey,
  buildAutoStartPayload,
  createAutoStartDraft,
  hostGpuCards,
  newAutoStartArmId,
  resolveAutoStartDraft,
  sameAutoStartPayload,
  type AutoStartContext,
  type AutoStartDraft,
} from './AutoStartFields';
import { validateAutoStartConfig } from '../../shared/auto-start';

interface TaskEditorProps {
  registry: Registry;
  task: TaskRegistration | null;
  hostId?: string;
  hostSnapshots?: HostSnapshot[];
  focusAutoStart?: boolean;
  onClose: () => void;
  onSave: (registry: Registry) => Promise<Registry>;
  onSaved: (taskId: string, hostId: string) => void;
  onReload: () => Promise<Registry>;
  onOpenSettings: () => void;
}

export function TaskEditor({ registry, task, hostId, hostSnapshots, focusAutoStart = false, onClose, onSave, onSaved, onReload, onOpenSettings }: TaskEditorProps) {
  const [fields, setFields] = useState<TaskFormInputs>(() => ({
    taskId: task?.taskId ?? '', hostId: task?.hostId ?? hostId ?? registry.hosts[0]?.hostId ?? '',
    label: task?.label ?? '', algorithm: task ? taskAlgorithmName(task) : '',
    logFormat: task ? (taskLogFormat(task).replace(/^legacy_/, '') as TaskFormInputs['logFormat']) : 'generic',
    allowedDirsStr: task?.allowedDirectories.join('; ') ?? '',
    entryPathsStr: task?.entryPaths.join('; ') ?? '',
    ckptDirsStr: task?.checkpointDirectories.join('; ') ?? '',
    logPath: task?.sources.find(source => source.kind === 'log')?.path ?? '',
    statusPath: task?.sources.find(source => source.kind === 'status_json')?.path ?? '',
    lockPath: task?.sources.find(source => source.kind === 'queue_lock')?.path ?? '',
  }));
  const [autoStartDraft, setAutoStartDraft] = useState<AutoStartDraft>(() => createAutoStartDraft(task?.autoStart, {
    entryPaths: task?.entryPaths ?? [],
    allowedDirectories: task?.allowedDirectories ?? [],
    logSources: (task?.sources ?? []).filter(source => source.kind === 'log').map(source => ({ sourceId: source.sourceId, path: source.path })),
    hasStatusSource: task?.sources.some(source => source.kind === 'status_json') ?? false,
  }));
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const autoStartRef = useRef<HTMLElement>(null);
  const container = useFocusTrap(true, () => { if (!saving) onClose(); });
  const change = (key: keyof TaskFormInputs, value: string) => setFields(previous => ({ ...previous, [key]: value }));

  const context = useMemo<AutoStartContext>(() => {
    const entryPaths = fields.entryPathsStr.split(/[;,]/).map(item => item.trim()).filter(Boolean);
    const allowedDirectories = fields.allowedDirsStr.split(/[;,]/).map(item => item.trim()).filter(Boolean);
    const logPath = fields.logPath.trim();
    const existingLog = task?.sources.find(source => source.kind === 'log');
    const logSources = logPath
      ? [{ sourceId: existingLog?.sourceId ?? `${fields.taskId.trim() || 'task'}-log`, path: logPath }]
      : [];
    const cards = hostGpuCards(hostSnapshots, fields.hostId);
    const defaultGpuText = cards.length > 0 ? cards[0]!.deviceId.replace(/^GPU[-\s]?/, '') : '';
    return { entryPaths, allowedDirectories, logSources, defaultGpuText, hasStatusSource: !!fields.statusPath?.trim() };
  }, [fields.entryPathsStr, fields.allowedDirsStr, fields.logPath, fields.statusPath, fields.taskId, fields.hostId, task, hostSnapshots]);

  useEffect(() => {
    if (!focusAutoStart) return;
    const node = autoStartRef.current;
    if (!node) return;
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    node.querySelector<HTMLElement>('input[type="checkbox"]')?.focus();
  }, [focusAutoStart]);

  /**
   * Keeps the stored configuration consistent with the task it belongs to.
   * A disabled configuration survives, but never points at removed entries or logs.
   */
  function resolveAutoStartForTask(parsedTask: TaskRegistration, prior: AutoStartConfig | undefined, priorTask: TaskRegistration | null | undefined, draft: AutoStartDraft): { config?: AutoStartConfig; error: string | null } {
    const taskContext: AutoStartContext = {
      entryPaths: parsedTask.entryPaths,
      allowedDirectories: parsedTask.allowedDirectories,
      logSources: parsedTask.sources.filter(source => source.kind === 'log').map(source => ({ sourceId: source.sourceId, path: source.path })),
      hasStatusSource: parsedTask.sources.some(source => source.kind === 'status_json'),
    };
    const resolvedDraft = resolveAutoStartDraft(draft, taskContext);
    if (!draft.enabled) {
      if (!prior) return { config: undefined, error: null };
      const entryPath = prior.launch.entryPath && taskContext.entryPaths.includes(prior.launch.entryPath) ? prior.launch.entryPath : taskContext.entryPaths[0];
      const cwd = taskContext.allowedDirectories.some(dir => prior.launch.cwd === dir || prior.launch.cwd.startsWith(dir.replace(/\/$/, '') + '/'))
        ? prior.launch.cwd : taskContext.allowedDirectories[0];
      const logSourceId = taskContext.logSources.some(source => source.sourceId === prior.launch.logSourceId)
        ? prior.launch.logSourceId : taskContext.logSources[0]?.sourceId;
      if (!entryPath || !cwd || !logSourceId) return { config: undefined, error: null };
      const candidate: AutoStartConfig = {
        ...prior,
        enabled: false,
        launch: { ...prior.launch, entryPath, cwd, logSourceId },
      };
      try {
        return { config: validateAutoStartConfig(candidate, parsedTask), error: null };
      } catch {
        return { config: undefined, error: null };
      }
    }
    const { payload, error } = buildAutoStartPayload(resolvedDraft, taskContext);
    if (!payload) return { config: undefined, error };
    const priorScope = priorTask ? autoStartScopeKey(priorTask) : null;
    const nextScope = autoStartScopeKey(parsedTask);
    const unchanged = prior?.execution === 'server_tmux' && prior?.enabled === true
      && priorScope !== null
      && priorScope === nextScope
      && sameAutoStartPayload(payload, {
        execution: prior.execution,
        gpuDeviceIds: prior.gpuDeviceIds,
        gpuExcludeIds: prior.gpuExcludeIds,
        requiredGpuCount: prior.requiredGpuCount,
        cudaVisibleDevicesMode: prior.cudaVisibleDevicesMode,
        idleSeconds: prior.idleSeconds,
        maxUtilizationPercent: prior.maxUtilizationPercent,
        maxMemoryMiB: prior.maxMemoryMiB,
        minFreeMemoryMiB: prior.minFreeMemoryMiB,
        minFreeDiskMiB: prior.minFreeDiskMiB,
        gpuSharing: prior.gpuSharing,
        retryOnExit: prior.retryOnExit,
        maxRetries: prior.maxRetries,
        retryBackoffSeconds: prior.retryBackoffSeconds,
        launch: prior.launch,
      });
    const candidate: AutoStartConfig = {
      enabled: true,
      armId: unchanged ? prior.armId : newAutoStartArmId(),
      ...payload,
    };
    try {
      return { config: validateAutoStartConfig(candidate, parsedTask), error: null };
    } catch (reason) {
      return { config: undefined, error: '自动启动配置无效，请检查解释器、目录和日志来源' };
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const parsed = parseAndValidateTaskForm(fields, registry.hosts, registry.tasks, task?.taskId);
    if (!parsed.task) { setError(parsed.error); return; }
    if (task && !registry.tasks.some(item => item.taskId === task.taskId)) {
      setError('该任务已被移除，请关闭后重新添加。'); return;
    }
    if (autoStartDraft.enabled && registry.hosts.find(host => host.hostId === fields.hostId)?.target.kind !== 'ssh') { setError('仅远程 SSH 服务器支持托管等待'); return; }
    const autoStart = resolveAutoStartForTask(parsed.task, task?.autoStart, task, autoStartDraft);
    if (autoStart.error) { setError(autoStart.error); return; }
    const nextTask: TaskRegistration = { ...parsed.task, enabled };
    if (autoStart.config) nextTask.autoStart = autoStart.config;
    else delete nextTask.autoStart;
    setSaving(true); setError(null); setConflict(false);
    try {
      await onSave({ ...registry, tasks: task
        ? registry.tasks.map(item => item.taskId === task.taskId ? nextTask : item)
        : [...registry.tasks, nextTask] });
      onSaved(nextTask.taskId, nextTask.hostId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setConflict(/revision|conflict|409|冲突/i.test(message));
      setError(message);
    } finally { setSaving(false); }
  }
  return <div className="modal-overlay" onClick={() => { if (!saving) onClose(); }}>
    <div className="modal-container task-editor" ref={container} role="dialog" aria-modal="true" aria-labelledby="task-editor-title" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <div className="modal-header">
        <h2 id="task-editor-title">{task ? '编辑任务' : '添加任务'}</h2>
        <button type="button" className="btn btn-ghost" aria-label="关闭任务编辑" disabled={saving} onClick={onClose}><Icon name="close" /></button>
      </div>
      <form onSubmit={save}>
        <div className="modal-body">
          {error && <div className="alert alert-danger" role="alert">{error}
            {conflict && <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={async () => {
              try { await onReload(); setConflict(false); setError(null); }
              catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
            }}>重新加载配置</button>}
          </div>}
          {registry.hosts.length === 0 ? <div className="empty-state-card">
            <p>先添加一个宿主，再添加监控任务。</p>
            <button type="button" className="btn btn-secondary" onClick={onOpenSettings}>添加宿主</button>
          </div> : <fieldset disabled={saving} className="task-form-fields">
            <div className="form-row">
              <label className="form-label">任务 ID<input className="form-input" value={fields.taskId} disabled={!!task} onChange={e => change('taskId', e.target.value)} /></label>
              <label className="form-label">任务名称<input className="form-input" value={fields.label} onChange={e => change('label', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label className="form-label">宿主<select className="form-select" value={fields.hostId} onChange={e => change('hostId', e.target.value)}>
                {registry.hosts.map(host => <option key={host.hostId} value={host.hostId}>{host.label}{host.enabled ? '' : '（已停用）'}</option>)}
              </select></label>
              <label className="form-label">算法名称（选填）<input className="form-input" placeholder="输入任意算法或模型名称" maxLength={120} value={fields.algorithm} onChange={e => change('algorithm', e.target.value)} /></label>
            </div>
            <label className="form-label">工作目录<input className="form-input" placeholder="宿主上的绝对路径" value={fields.allowedDirsStr} onChange={e => change('allowedDirsStr', e.target.value)} /></label>
            <label className="form-label">脚本入口<input className="form-input" placeholder="例如 train.py" value={fields.entryPathsStr} onChange={e => change('entryPathsStr', e.target.value)} /></label>
            <label className="form-label">日志路径<input className="form-input" placeholder="宿主上的日志文件路径" value={fields.logPath} onChange={e => change('logPath', e.target.value)} /></label>
            <details className="task-extra-fields">
              <summary>高级选项</summary>
              <label className="form-label">日志识别<select className="form-select" value={fields.logFormat} aria-describedby="task-log-format-help" onChange={e => change('logFormat', e.target.value)}>
                <option value="generic">通用识别（默认）</option>
                <option value="raw">仅查看日志</option>
                <option value="flow">Flow Matching 兼容格式</option>
                <option value="score">Score-based 兼容格式</option>
                <option value="reflow">Reflow 兼容格式</option>
              </select></label>
              <p id="task-log-format-help" className="task-form-help">通用模式识别 step/loss、JSON 和 tqdm 日志；算法名称不影响识别方式。</p>
              <label className="form-label">状态文件<input className="form-input" value={fields.statusPath} onChange={e => change('statusPath', e.target.value)} /></label>
              <label className="form-label">队列锁文件<input className="form-input" value={fields.lockPath} onChange={e => change('lockPath', e.target.value)} /></label>
              <label className="form-label">检查点目录<input className="form-input" value={fields.ckptDirsStr} onChange={e => change('ckptDirsStr', e.target.value)} /></label>
            </details>
            <AutoStartFields
              draft={autoStartDraft}
              onChange={setAutoStartDraft}
              context={context}
              hostSnapshots={hostSnapshots}
              hostId={fields.hostId}
              sectionRef={autoStartRef}
              serverSupported={registry.hosts.find(host => host.hostId === fields.hostId)?.target.kind === 'ssh'}
            />
            <label className="task-enabled"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />启用监控</label>
          </fieldset>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={saving || registry.hosts.length === 0}>{saving ? '正在保存…' : task ? '保存更改' : '添加任务'}</button>
        </div>
      </form>
    </div>
  </div>;
}
