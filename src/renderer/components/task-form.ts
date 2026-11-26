import type { HostRegistration, LogFormat, TaskRegistration } from "../../shared/contracts";
import { taskAlgorithmName, taskLogFormat } from '../../shared/task-profile';

export interface TaskFormInputs {
  taskId: string;
  hostId: string;
  label: string;
  algorithm: string;
  logFormat?: LogFormat;
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
  isEditingTaskId?: string | null
): { task: TaskRegistration | null; error: string | null } {
  const id = fields.taskId.trim();
  if (!id) {
    return { task: null, error: "任务 ID 不能为空" };
  }
  if (!isEditingTaskId || isEditingTaskId !== id) {
    if (existingTasks.some((t) => t.taskId === id)) {
      return { task: null, error: "该任务 ID 已存在" };
    }
  }
  if (!fields.hostId || !availableHosts.some((h) => h.hostId === fields.hostId)) {
    return { task: null, error: "任务所属宿主不存在，请先添加或选择宿主" };
  }
  const algorithmName = fields.algorithm.trim();
  if (algorithmName.length > 120 || /[\u0000-\u001f\u007f]/.test(algorithmName)) {
    return { task: null, error: '算法名称最多 120 个字符，不能包含控制字符' };
  }
  const format = fields.logFormat ?? 'generic';
  if (!['generic', 'flow', 'score', 'reflow', 'raw'].includes(format)) {
    return { task: null, error: '请选择有效的日志识别方式' };
  }

  const dirs = fields.allowedDirsStr
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (dirs.length === 0) {
    return { task: null, error: "工作目录不能为空，且必须以 / 开头" };
  }
  for (const d of dirs) {
    if (!d.startsWith("/")) {
      return { task: null, error: "工作目录必须以 / 开头" };
    }
  }

  const entries = fields.entryPathsStr
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return { task: null, error: "脚本入口路径不能为空" };
  }

  const ckpts = fields.ckptDirsStr
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of ckpts) {
    if (!c.startsWith("/")) {
      return { task: null, error: "检查点目录必须以 / 开头" };
    }
  }

  const existingTask = isEditingTaskId ? existingTasks.find((t) => t.taskId === isEditingTaskId) : null;
  const retainLegacyProfile = existingTask && existingTask.logFormat === undefined &&
    algorithmName === taskAlgorithmName(existingTask) && format === taskLogFormat(existingTask);
  let sources: TaskRegistration["sources"] = [];

  if (existingTask) {
    sources = structuredClone(existingTask.sources);
    const logP = fields.logPath.trim();
    const logIdx = sources.findIndex((s) => s.kind === "log");
    if (logP) {
      if (logIdx !== -1) {
        sources[logIdx] = { ...sources[logIdx], path: logP };
      } else {
        sources.push({ sourceId: id + "-log", path: logP, kind: "log" });
      }
    } else if (logIdx !== -1) {
      sources.splice(logIdx, 1);
    }

    const statusP = (fields.statusPath || "").trim();
    const statusIdx = sources.findIndex((s) => s.kind === "status_json");
    if (statusP) {
      if (statusIdx !== -1) {
        sources[statusIdx] = { ...sources[statusIdx], path: statusP };
      } else {
        sources.push({ sourceId: id + "-status", path: statusP, kind: "status_json" });
      }
    } else if (statusIdx !== -1) {
      sources.splice(statusIdx, 1);
    }

    const lockP = (fields.lockPath || "").trim();
    const lockIdx = sources.findIndex((s) => s.kind === "queue_lock");
    if (lockP) {
      if (lockIdx !== -1) {
        sources[lockIdx] = { ...sources[lockIdx], path: lockP };
      } else {
        sources.push({ sourceId: id + "-lock", path: lockP, kind: "queue_lock" });
      }
    } else if (lockIdx !== -1) {
      sources.splice(lockIdx, 1);
    }
  } else {
    const logP = fields.logPath.trim();
    if (logP) {
      sources.push({ sourceId: id + "-log", path: logP, kind: "log" });
    }
    const statusP = (fields.statusPath || "").trim();
    if (statusP) {
      sources.push({ sourceId: id + "-status", path: statusP, kind: "status_json" });
    }
    const lockP = (fields.lockPath || "").trim();
    if (lockP) {
      sources.push({ sourceId: id + "-lock", path: lockP, kind: "queue_lock" });
    }
  }

  if (sources.length === 0) {
    return { task: null, error: "至少需要配置一个有效的日志或状态文件路径" };
  }

  const task: TaskRegistration = {
    taskId: id,
    hostId: fields.hostId,
    label: fields.label.trim() || id,
    enabled: existingTask ? existingTask.enabled : true,
    algorithm: retainLegacyProfile ? existingTask.algorithm : algorithmName,
    ...(retainLegacyProfile ? {} : { logFormat: format }),
    allowedDirectories: dirs,
    entryPaths: entries,
    sources,
    checkpointDirectories: ckpts,
  };

  return { task, error: null };
}

