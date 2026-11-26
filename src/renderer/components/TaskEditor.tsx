import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AutoStartConfig,
  DiscoveredProcess,
  HostSnapshot,
  Registry,
  TaskRegistration,
  TaskSourcePathMode,
} from '../../shared/contracts';
import { validateAutoStartConfig } from '../../shared/auto-start';
import { taskAlgorithmName, taskLogFormat } from '../../shared/task-profile';
import { isValidAbsolutePath } from '../../shared/validate';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { slugifyTaskId } from '../utils/format';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { parseAndValidateTaskForm, type TaskFormInputs } from './task-form';
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

interface TaskEditorProps {
  registry: Registry;
  task: TaskRegistration | null;
  hostId?: string;
  initialProcess?: DiscoveredProcess | null;
  hostSnapshots?: HostSnapshot[];
  focusAutoStart?: boolean;
  onClose: () => void;
  onSave: (registry: Registry) => Promise<Registry>;
  onSaved: (taskId: string, hostId: string) => void;
  onReload: () => Promise<Registry>;
  onOpenSettings: () => void;
  onRequestDiscoverProcesses?: (hostId: string) => void;
}

export function TaskEditor({
  registry,
  task,
  hostId,
  initialProcess,
  hostSnapshots,
  focusAutoStart = false,
  onClose,
  onSave,
  onSaved,
  onReload,
  onOpenSettings,
  onRequestDiscoverProcesses,
}: TaskEditorProps) {
  const { t } = useI18n();
  const [taskIdTouched, setTaskIdTouched] = useState(Boolean(task));
  const [fields, setFields] = useState<TaskFormInputs>(() => {
    const primaryLog = task?.sources.find((s) => s.kind === 'log');
    if (!task && initialProcess) {
      const slug = slugifyTaskId(initialProcess.suggestedName) || `task-${initialProcess.pid}`;
      return {
        taskId: slug,
        hostId: hostId ?? registry.hosts[0]?.hostId ?? '',
        label: initialProcess.suggestedName,
        algorithm: '',
        logFormat: 'generic',
        logPathMode: 'exact',
        attributionMode: 'auto',
        progressRegex: '',
        lossRegex: '',
        allowedDirsStr: initialProcess.cwd ?? '',
        entryPathsStr: initialProcess.suggestedEntry ?? 'train.py',
        ckptDirsStr: '',
        logPath: initialProcess.openLogPaths[0] ?? '',
        statusPath: '',
        lockPath: '',
      };
    }
    return {
      taskId: task?.taskId ?? '',
      hostId: task?.hostId ?? hostId ?? registry.hosts[0]?.hostId ?? '',
      label: task?.label ?? '',
      algorithm: task ? taskAlgorithmName(task) : '',
      logFormat: task ? (taskLogFormat(task).replace(/^legacy_/, '') as TaskFormInputs['logFormat']) : 'generic',
      logPathMode: primaryLog?.pathMode ?? 'exact',
      attributionMode: task?.attributionMode ?? 'auto',
      progressRegex: task?.customPatterns?.progressRegex ?? '',
      lossRegex: task?.customPatterns?.metricRegexes?.loss ?? '',
      allowedDirsStr: task?.allowedDirectories.join('; ') ?? '',
      entryPathsStr: task?.entryPaths.join('; ') ?? '',
      ckptDirsStr: task?.checkpointDirectories.join('; ') ?? '',
      logPath: primaryLog?.path ?? '',
      statusPath: task?.sources.find((s) => s.kind === 'status_json')?.path ?? '',
      lockPath: task?.sources.find((s) => s.kind === 'queue_lock')?.path ?? '',
    };
  });

  const [autoStartDraft, setAutoStartDraft] = useState<AutoStartDraft>(() =>
    createAutoStartDraft(task?.autoStart, {
      entryPaths: task?.entryPaths ?? [],
      allowedDirectories: task?.allowedDirectories ?? [],
      logSources: (task?.sources ?? [])
        .filter((source) => source.kind === 'log')
        .map((source) => ({ sourceId: source.sourceId, path: source.path })),
      hasStatusSource: task?.sources.some((source) => source.kind === 'status_json') ?? false,
    }),
  );
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const autoStartRef = useRef<HTMLElement>(null);
  const container = useFocusTrap(true, () => {
    if (!saving) onClose();
  });

  const change = (key: keyof TaskFormInputs, value: string) => {
    setFields((previous) => {
      const next = { ...previous, [key]: value };
      // Auto-generate taskId slug from label when creating a new task
      if (key === 'label' && !task && !taskIdTouched) {
        const slug = slugifyTaskId(value);
        if (slug) next.taskId = slug;
      }
      return next;
    });
  };

  const selectedHost = registry.hosts.find((host) => host.hostId === fields.hostId);
  const allowWin = selectedHost?.target.kind === 'local';

  // Inline field-level validation feedback
  const inlineWorkDirInvalid =
    fields.allowedDirsStr.trim().length > 0 &&
    fields.allowedDirsStr
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .some((d) => !isValidAbsolutePath(d, allowWin));

  const inlineLogInvalid =
    fields.logPath.trim().length > 0 && !isValidAbsolutePath(fields.logPath.trim(), allowWin);

  const context = useMemo<AutoStartContext>(() => {
    const entryPaths = fields.entryPathsStr
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const allowedDirectories = fields.allowedDirsStr
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const logPath = fields.logPath.trim();
    const existingLog = task?.sources.find((source) => source.kind === 'log');
    const logSources = logPath
      ? [{ sourceId: existingLog?.sourceId ?? `${fields.taskId.trim() || 'task'}-log`, path: logPath }]
      : [];
    const cards = hostGpuCards(hostSnapshots, fields.hostId);
    const defaultGpuText = cards.length > 0 ? cards[0]!.deviceId.replace(/^GPU[-\s]?/, '') : '';
    return {
      entryPaths,
      allowedDirectories,
      logSources,
      defaultGpuText,
      hasStatusSource: !!fields.statusPath?.trim(),
    };
  }, [fields.entryPathsStr, fields.allowedDirsStr, fields.logPath, fields.statusPath, fields.taskId, fields.hostId, task, hostSnapshots]);

  useEffect(() => {
    if (!focusAutoStart) return;
    const node = autoStartRef.current;
    if (!node) return;
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    node.querySelector<HTMLElement>('input[type="checkbox"]')?.focus();
  }, [focusAutoStart]);

  function resolveAutoStartForTask(
    parsedTask: TaskRegistration,
    prior: AutoStartConfig | undefined,
    priorTask: TaskRegistration | null | undefined,
    draft: AutoStartDraft,
  ): { config?: AutoStartConfig; error: string | null } {
    const taskContext: AutoStartContext = {
      entryPaths: parsedTask.entryPaths,
      allowedDirectories: parsedTask.allowedDirectories,
      logSources: parsedTask.sources
        .filter((source) => source.kind === 'log')
        .map((source) => ({ sourceId: source.sourceId, path: source.path })),
      hasStatusSource: parsedTask.sources.some((source) => source.kind === 'status_json'),
    };
    const resolvedDraft = resolveAutoStartDraft(draft, taskContext);
    if (!draft.enabled) {
      if (!prior) return { config: undefined, error: null };
      const entryPath =
        prior.launch.entryPath && taskContext.entryPaths.includes(prior.launch.entryPath)
          ? prior.launch.entryPath
          : taskContext.entryPaths[0];
      const cwd = taskContext.allowedDirectories.some(
        (dir) => prior.launch.cwd === dir || prior.launch.cwd.startsWith(dir.replace(/\/$/, '') + '/'),
      )
        ? prior.launch.cwd
        : taskContext.allowedDirectories[0];
      const logSourceId = taskContext.logSources.some((source) => source.sourceId === prior.launch.logSourceId)
        ? prior.launch.logSourceId
        : taskContext.logSources[0]?.sourceId;
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
    const { payload, error: payloadErr } = buildAutoStartPayload(resolvedDraft, taskContext);
    if (!payload) return { config: undefined, error: payloadErr };
    const priorScope = priorTask ? autoStartScopeKey(priorTask) : null;
    const nextScope = autoStartScopeKey(parsedTask);
    const unchanged =
      prior?.execution === 'server_tmux' &&
      prior?.enabled === true &&
      priorScope !== null &&
      priorScope === nextScope &&
      sameAutoStartPayload(payload, {
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
    } catch {
      return { config: undefined, error: '自动启动配置无效，请检查解释器、目录和日志来源' };
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const parsed = parseAndValidateTaskForm(fields, registry.hosts, registry.tasks, task?.taskId);
    if (!parsed.task) {
      setError(parsed.error);
      return;
    }
    if (task && !registry.tasks.some((item) => item.taskId === task.taskId)) {
      setError('该任务已被移除，请关闭后重新添加。');
      return;
    }
    if (autoStartDraft.enabled && selectedHost?.target.kind !== 'ssh') {
      setError('仅远程 SSH 服务器支持托管等待');
      return;
    }
    const autoStart = resolveAutoStartForTask(parsed.task, task?.autoStart, task, autoStartDraft);
    if (autoStart.error) {
      setError(autoStart.error);
      return;
    }
    const nextTask: TaskRegistration = { ...parsed.task, enabled };
    if (autoStart.config) nextTask.autoStart = autoStart.config;
    else delete nextTask.autoStart;
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      await onSave({
        ...registry,
        tasks: task
          ? registry.tasks.map((item) => (item.taskId === task.taskId ? nextTask : item))
          : [...registry.tasks, nextTask],
      });
      onSaved(nextTask.taskId, nextTask.hostId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setConflict(/revision|conflict|409|冲突/i.test(message));
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div
        className="modal-container task-editor"
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-editor-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="task-editor-title" className="modal-title">
            {task ? t('taskEditor.editTitle') : t('taskEditor.addTitle')}
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            aria-label={t('taskEditor.closeAria')}
            disabled={saving}
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-body">
            {error && (
              <div className="alert alert-danger" role="alert">
                <span>{error}</span>
                {conflict && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    disabled={saving}
                    onClick={async () => {
                      try {
                        await onReload();
                        setConflict(false);
                        setError(null);
                      } catch (reason) {
                        setError(reason instanceof Error ? reason.message : String(reason));
                      }
                    }}
                  >
                    {t('app.reloadConfig')}
                  </button>
                )}
              </div>
            )}

            {registry.hosts.length === 0 ? (
              <div className="empty-state-card" style={{ alignSelf: 'center', width: '100%' }}>
                <p className="empty-text">{t('taskEditor.noHostsNotice')}</p>
                <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                  {t('taskEditor.goAddHost')}
                </button>
              </div>
            ) : (
              <fieldset disabled={saving} className="task-form-fields">
                {!task && onRequestDiscoverProcesses && fields.hostId && (
                  <div className="task-import-banner">
                    <span>{t('taskEditor.importRunningBanner')}</span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => onRequestDiscoverProcesses(fields.hostId)}
                    >
                      <Icon name="radar" size={12} />
                      <span>{t('taskEditor.importRunningBtn')}</span>
                    </button>
                  </div>
                )}

                <div className="form-row">
                  <label className="form-label">
                    {t('taskEditor.fieldTaskLabel')}
                    <input
                      className="form-input"
                      placeholder="例如: Llama-3-8B LoRA SFT"
                      value={fields.label}
                      onChange={(e) => change('label', e.target.value)}
                    />
                  </label>
                  <label className="form-label">
                    {t('taskEditor.fieldTaskId')}
                    <input
                      className="form-input is-mono"
                      placeholder="自动根据名称生成"
                      value={fields.taskId}
                      disabled={!!task}
                      onChange={(e) => {
                        setTaskIdTouched(true);
                        change('taskId', e.target.value);
                      }}
                    />
                  </label>
                </div>

                <div className="form-row">
                  <label className="form-label">
                    {t('taskEditor.fieldHost')}
                    <select
                      className="form-select"
                      value={fields.hostId}
                      onChange={(e) => change('hostId', e.target.value)}
                    >
                      {registry.hosts.map((host) => (
                        <option key={host.hostId} value={host.hostId}>
                          {host.label}
                          {host.enabled ? '' : ` (${t('settings.hostDisabled')})`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-label">
                    {t('taskEditor.fieldAlgorithm')}
                    <input
                      className="form-input"
                      placeholder="输入任意算法或模型名称"
                      maxLength={120}
                      value={fields.algorithm}
                      onChange={(e) => change('algorithm', e.target.value)}
                    />
                  </label>
                </div>

                {/* Full-width monospace path fields — ZERO narrow column truncation */}
                <label className="form-label">
                  {t('taskEditor.fieldWorkDir')}
                  <input
                    className={`form-input is-mono ${inlineWorkDirInvalid ? 'is-invalid' : ''}`}
                    placeholder={allowWin ? '/workspace/project 或 C:\\Projects\\exp' : '/workspace/project'}
                    value={fields.allowedDirsStr}
                    onChange={(e) => change('allowedDirsStr', e.target.value)}
                  />
                  {inlineWorkDirInvalid && (
                    <span className="form-field-error">
                      {allowWin ? '工作目录需为绝对路径' : '工作目录需以 / 开头'}
                    </span>
                  )}
                </label>

                <label className="form-label">
                  {t('taskEditor.fieldEntry')}
                  <input
                    className="form-input is-mono"
                    placeholder="例如: train.py 或 src/train_sft.py"
                    value={fields.entryPathsStr}
                    onChange={(e) => change('entryPathsStr', e.target.value)}
                  />
                </label>

                <label className="form-label">
                  {t('taskEditor.fieldLogPath')}
                  <input
                    className={`form-input is-mono ${inlineLogInvalid ? 'is-invalid' : ''}`}
                    placeholder={allowWin ? '/workspace/project/train.log' : '/workspace/project/logs/train*.log'}
                    value={fields.logPath}
                    onChange={(e) => change('logPath', e.target.value)}
                  />
                  {inlineLogInvalid && (
                    <span className="form-field-error">
                      {allowWin ? '日志路径需为绝对路径' : '日志路径需以 / 开头'}
                    </span>
                  )}
                </label>

                {/* Progressive Disclosure: Advanced Options */}
                <details className="task-extra-fields">
                  <summary>{t('taskEditor.advancedSummary')}</summary>
                  <div className="task-extra-body">
                    <div className="form-row">
                      <label className="form-label">
                        {t('taskEditor.fieldLogFormat')}
                        <select
                          className="form-select"
                          value={fields.logFormat}
                          aria-describedby="task-log-format-help"
                          onChange={(e) => change('logFormat', e.target.value)}
                        >
                          <option value="generic">{t('taskEditor.formatGeneric')}</option>
                          <option value="raw">{t('taskEditor.formatRaw')}</option>
                          <optgroup label={t('taskEditor.formatLegacyGroup')}>
                            <option value="flow">{t('taskEditor.formatFlow')}</option>
                            <option value="score">{t('taskEditor.formatScore')}</option>
                            <option value="reflow">{t('taskEditor.formatReflow')}</option>
                          </optgroup>
                        </select>
                      </label>

                      <label className="form-label">
                        {t('taskEditor.fieldLogPathMode')}
                        <select
                          className="form-select"
                          value={fields.logPathMode ?? 'exact'}
                          onChange={(e) => change('logPathMode', e.target.value as TaskSourcePathMode)}
                        >
                          <option value="exact">{t('taskEditor.pathModeExact')}</option>
                          <option value="glob_latest">{t('taskEditor.pathModeGlob')}</option>
                          <option value="dir_latest">{t('taskEditor.pathModeDir')}</option>
                        </select>
                      </label>
                    </div>
                    <p id="task-log-format-help" className="form-hint">
                      {t('taskEditor.logFormatHelp')}
                    </p>

                    <label className="form-label">
                      {t('taskEditor.fieldAttributionMode')}
                      <select
                        className="form-select"
                        value={fields.attributionMode ?? 'auto'}
                        onChange={(e) => change('attributionMode', e.target.value)}
                      >
                        <option value="auto">{t('taskEditor.attributionAuto')}</option>
                        <option value="log_only">{t('taskEditor.attributionLogOnly')}</option>
                      </select>
                    </label>

                    <label className="form-label">
                      {t('taskEditor.fieldProgressRegex')}
                      <input
                        className="form-input is-mono"
                        placeholder="例如: step=(?<current>\d+)/(?<total>\d+)"
                        value={fields.progressRegex ?? ''}
                        onChange={(e) => change('progressRegex', e.target.value)}
                      />
                    </label>

                    <label className="form-label">
                      {t('taskEditor.fieldLossRegex')}
                      <input
                        className="form-input is-mono"
                        placeholder="例如: train_loss[:=]\s*([0-9.eE+-]+)"
                        value={fields.lossRegex ?? ''}
                        onChange={(e) => change('lossRegex', e.target.value)}
                      />
                    </label>

                    <label className="form-label">
                      {t('taskEditor.fieldCkptDirs')}
                      <input
                        className="form-input is-mono"
                        placeholder="/workspace/project/checkpoints"
                        value={fields.ckptDirsStr}
                        onChange={(e) => change('ckptDirsStr', e.target.value)}
                      />
                    </label>

                    <label className="form-label">
                      {t('taskEditor.fieldStatusPath')}
                      <input
                        className="form-input is-mono"
                        placeholder="/workspace/project/status.json"
                        value={fields.statusPath}
                        onChange={(e) => change('statusPath', e.target.value)}
                      />
                    </label>

                    <label className="form-label">
                      {t('taskEditor.fieldLockPath')}
                      <input
                        className="form-input is-mono"
                        placeholder="/workspace/project/queue.lock"
                        value={fields.lockPath}
                        onChange={(e) => change('lockPath', e.target.value)}
                      />
                    </label>
                  </div>
                </details>

                <AutoStartFields
                  draft={autoStartDraft}
                  onChange={setAutoStartDraft}
                  context={context}
                  hostSnapshots={hostSnapshots}
                  hostId={fields.hostId}
                  sectionRef={autoStartRef}
                  serverSupported={selectedHost?.target.kind === 'ssh'}
                />

                <label className="task-enabled">
                  <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                  {t('taskEditor.fieldEnabled')}
                </label>
              </fieldset>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
              {t('app.cancel')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || registry.hosts.length === 0}
            >
              {saving ? t('app.saving') : task ? t('taskEditor.submitEdit') : t('taskEditor.submitAdd')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
