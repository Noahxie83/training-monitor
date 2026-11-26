import type {
  CustomPatternConfig,
  HostRegistration,
  LogFormat,
  TaskRegistration,
  TaskSourcePathMode,
} from '../../shared/contracts';
import { normalizeLogFormat, taskAlgorithmName, taskLogFormat } from '../../shared/task-profile';
import { isSafeRegexPattern, isValidAbsolutePath } from '../../shared/validate';

export interface TaskFormInputs {
  taskId: string;
  hostId: string;
  label: string;
  algorithm: string;
  logFormat?: LogFormat;
  logPathMode?: TaskSourcePathMode;
  attributionMode?: 'auto' | 'log_only';
  progressRegex?: string;
  lossRegex?: string;
  allowedDirsStr: string;
  entryPathsStr: string;
  ckptDirsStr: string;
  logPath: string;
  statusPath?: string;
  lockPath?: string;
}

export function parseAndValidateTaskForm(
  fields: TaskFormInputs,
  availableHosts: HostRegistration[],
  existingTasks: TaskRegistration[],
  isEditingTaskId?: string | null,
): { task: TaskRegistration | null; error: string | null } {
  const id = fields.taskId.trim();
  if (!id) {
    return { task: null, error: '任务 ID 不能为空' };
  }
  if (!isEditingTaskId || isEditingTaskId !== id) {
    if (existingTasks.some((t) => t.taskId === id)) {
      return { task: null, error: '该任务 ID 已存在' };
    }
  }
  const selectedHost = availableHosts.find((h) => h.hostId === fields.hostId);
  if (!fields.hostId || !selectedHost) {
    return { task: null, error: '任务所属宿主不存在，请先添加或选择宿主' };
  }
  const allowWinPath = selectedHost.target.kind === 'local';
  const algorithmName = fields.algorithm.trim();
  if (algorithmName.length > 120 || /[\u0000-\u001f\u007f]/.test(algorithmName)) {
    return { task: null, error: '算法名称最多 120 个字符，不能包含控制字符' };
  }
  const format = fields.logFormat ?? 'generic';
  if (!['generic', 'legacy_flow', 'legacy_score', 'legacy_reflow', 'flow', 'score', 'reflow', 'raw'].includes(format)) {
    return { task: null, error: '请选择有效的日志识别方式' };
  }

  const dirs = fields.allowedDirsStr
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (dirs.length === 0) {
    return { task: null, error: allowWinPath ? '工作目录不能为空，且必须为绝对路径' : '工作目录不能为空，且必须以 / 开头' };
  }
  for (const d of dirs) {
    if (!isValidAbsolutePath(d, allowWinPath)) {
      return { task: null, error: allowWinPath ? '工作目录必须为绝对路径' : '工作目录必须以 / 开头' };
    }
  }

  const entries = fields.entryPathsStr
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return { task: null, error: '脚本入口路径不能为空' };
  }

  const ckpts = fields.ckptDirsStr
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of ckpts) {
    if (!isValidAbsolutePath(c, allowWinPath)) {
      return { task: null, error: allowWinPath ? '检查点目录必须为绝对路径' : '检查点目录必须以 / 开头' };
    }
  }

  let customPatterns: CustomPatternConfig | undefined;
  const progressRe = fields.progressRegex?.trim();
  const lossRe = fields.lossRegex?.trim();
  if (progressRe) {
    if (!isSafeRegexPattern(progressRe)) {
      return { task: null, error: '自定义进度正则表达式语法无效或存在回溯风险' };
    }
    customPatterns = { ...(customPatterns ?? {}), progressRegex: progressRe };
  }
  if (lossRe) {
    if (!isSafeRegexPattern(lossRe)) {
      return { task: null, error: '自定义 Loss 正则表达式语法无效或存在回溯风险' };
    }
    customPatterns = { ...(customPatterns ?? {}), metricRegexes: { loss: lossRe } };
  }

  const existingTask = isEditingTaskId ? existingTasks.find((t) => t.taskId === isEditingTaskId) : null;
  const retainLegacyProfile =
    existingTask &&
    existingTask.logFormat === undefined &&
    algorithmName === taskAlgorithmName(existingTask) &&
    normalizeLogFormat(format) === taskLogFormat(existingTask);
  let sources: TaskRegistration['sources'] = [];
  const logPathMode = fields.logPathMode && fields.logPathMode !== 'exact' ? fields.logPathMode : undefined;

  if (existingTask) {
    sources = structuredClone(existingTask.sources);
    const logP = fields.logPath.trim();
    const logIdx = sources.findIndex((s) => s.kind === 'log');
    if (logP) {
      if (logIdx !== -1) {
        const updated = { ...sources[logIdx]!, path: logP };
        if (logPathMode) updated.pathMode = logPathMode;
        else delete updated.pathMode;
        sources[logIdx] = updated;
      } else {
        sources.push({ sourceId: `${id}-log`, path: logP, kind: 'log', ...(logPathMode ? { pathMode: logPathMode } : {}) });
      }
    } else if (logIdx !== -1) {
      sources.splice(logIdx, 1);
    }

    const statusP = (fields.statusPath || '').trim();
    const statusIdx = sources.findIndex((s) => s.kind === 'status_json');
    if (statusP) {
      if (statusIdx !== -1) sources[statusIdx] = { ...sources[statusIdx]!, path: statusP };
      else sources.push({ sourceId: `${id}-status`, path: statusP, kind: 'status_json' });
    } else if (statusIdx !== -1) {
      sources.splice(statusIdx, 1);
    }

    const lockP = (fields.lockPath || '').trim();
    const lockIdx = sources.findIndex((s) => s.kind === 'queue_lock');
    if (lockP) {
      if (lockIdx !== -1) sources[lockIdx] = { ...sources[lockIdx]!, path: lockP };
      else sources.push({ sourceId: `${id}-lock`, path: lockP, kind: 'queue_lock' });
    } else if (lockIdx !== -1) {
      sources.splice(lockIdx, 1);
    }
  } else {
    const logP = fields.logPath.trim();
    if (logP) {
      sources.push({ sourceId: `${id}-log`, path: logP, kind: 'log', ...(logPathMode ? { pathMode: logPathMode } : {}) });
    }
    const statusP = (fields.statusPath || '').trim();
    if (statusP) sources.push({ sourceId: `${id}-status`, path: statusP, kind: 'status_json' });
    const lockP = (fields.lockPath || '').trim();
    if (lockP) sources.push({ sourceId: `${id}-lock`, path: lockP, kind: 'queue_lock' });
  }

  if (sources.length === 0) {
    return { task: null, error: '至少需要配置一个有效的日志或状态文件路径' };
  }

  const task: TaskRegistration = {
    taskId: id,
    hostId: fields.hostId,
    label: fields.label.trim() || id,
    enabled: existingTask ? existingTask.enabled : true,
    algorithm: retainLegacyProfile ? existingTask.algorithm : algorithmName,
    ...(retainLegacyProfile ? {} : { logFormat: format }),
    ...(customPatterns ? { customPatterns } : {}),
    ...(fields.attributionMode && fields.attributionMode !== 'auto' ? { attributionMode: fields.attributionMode } : {}),
    allowedDirectories: dirs,
    entryPaths: entries,
    sources,
    checkpointDirectories: ckpts,
  };

  return { task, error: null };
}
