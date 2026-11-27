import type {
  AttributionConfidence,
  Checkpoint,
  Confidence,
  Lifecycle,
  ProcessInstance,
  ProcessKey,
  Progress,
  ResourceMetric,
  TaskRegistration,
  TaskSnapshot,
} from "../shared/contracts";
import type { HostObservation, TaskObservation, TaskProcessObservation } from "../transport/types";
import type { BindingState, TrainerOutputObservation } from "./bindings";
import { parseIsoMs, isTimestampValid, findLiveAttributedProcess, isValidDecimalBytes } from "./bindings";
import { createEmptyProgress, deriveProgress, type ProgressEvidence } from "./progress";
import { areProcessKeysEqual, isRegisteredProcessEntry, isStrongProcessKey, makeRunId, processEntry } from "./identity";
import { stripAnsi } from "../parsers/ansi";

export interface TaskEvidence {
  task: TaskRegistration;
  taskObservation: TaskObservation;
  hostObservation: HostObservation;
  observedAt: string;
  checkpoint?: Checkpoint | null;
  resources?: ResourceMetric[];
  bindingState?: BindingState | null;
  outputSamples?: Record<string, TrainerOutputObservation>;
  progress?: Progress | null;
  progressEvidence?: ProgressEvidence | null;
  statusFileLinkage?: { currentInstanceKey: ProcessKey; sequence?: number; sourceId?: string; observedAt?: string } | null;
  /** Tail lines from registered log source(s) used for terminal-state inference on process exit. */
  tailLogLines?: string[];
  /** Real exit code recorded by managed auto-start supervisor when available. */
  managedExitCode?: number | null;
  /** Whether log-only tracking observed active log growth or recent training records. */
  logOnlyActive?: boolean;
}

const TERMINAL_ERROR_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /CUDA out of memory|torch\.OutOfMemoryError|OutOfMemoryError/i, label: "CUDA out of memory" },
  { re: /Traceback \(most recent call last\):/i, label: "Python traceback" },
  { re: /Segmentation fault|SIGSEGV|core dumped/i, label: "Segmentation fault" },
  { re: /\b(?:SIGKILL|Killed|exit(?:ed)? with (?:code|status) [1-9]\d*|NCCL (?:unhandled )?(?:system |internal )?error)\b/i, label: "Process terminated abnormally" },
  { re: /\b(?:RuntimeError|ValueError|AssertionError|Fatal Python error|FileNotFoundError|ModuleNotFoundError):/i, label: "Runtime error" },
];

const TERMINAL_COMPLETE_PATTERNS: RegExp[] = [
  /\b(?:training\s+(?:complete|completed|finished|done)|finished\s+training|train_runtime)\b/i,
  /\ball\s+\d+\s+(?:epochs?|steps?)\s+(?:complete|completed|finished)\b/i,
];

function inferTerminalStateFromExit(
  previous: TaskSnapshot,
  managedExitCode: number | null | undefined,
  tailLogLines: string[] | undefined,
): { lifecycle: Lifecycle; confidence: Confidence; reason: string; exitCode: number | null; terminalSummary: string | null } {
  const cleanTail = (tailLogLines ?? []).map((line) => stripAnsi(line).trim()).filter(Boolean);

  // Find diagnostic error snippet in tail logs if any
  let errorSnippet: string | null = null;
  for (let i = cleanTail.length - 1; i >= 0; i--) {
    const line = cleanTail[i]!;
    if (TERMINAL_ERROR_PATTERNS.some(({ re }) => re.test(line))) {
      errorSnippet = line.slice(0, 240);
      break;
    }
  }

  // Priority 1: Managed launcher recorded real exit code
  if (typeof managedExitCode === "number" && Number.isSafeInteger(managedExitCode)) {
    if (managedExitCode === 0) {
      return {
        lifecycle: "completed",
        confidence: "high",
        reason: "Managed training process exited cleanly with exit code 0",
        exitCode: 0,
        terminalSummary: cleanTail[cleanTail.length - 1]?.slice(0, 240) ?? "Exit code 0",
      };
    }
    return {
      lifecycle: "failed",
      confidence: "high",
      reason: errorSnippet
        ? `Managed process exited with code ${managedExitCode}: ${errorSnippet}`
        : `Managed process exited with non-zero code ${managedExitCode}`,
      exitCode: managedExitCode,
      terminalSummary: errorSnippet ?? `Exit code ${managedExitCode}`,
    };
  }

  // Priority 2: Tail log inspection when tailLogLines is provided
  if (tailLogLines !== undefined) {
    if (errorSnippet) {
      return {
        lifecycle: "failed",
        confidence: "medium",
        reason: `Process exited after error: ${errorSnippet}`,
        exitCode: null,
        terminalSummary: errorSnippet,
      };
    }

    for (let i = cleanTail.length - 1; i >= 0; i--) {
      const line = cleanTail[i]!;
      if (TERMINAL_COMPLETE_PATTERNS.some((re) => re.test(line))) {
        return {
          lifecycle: "completed",
          confidence: "medium",
          reason: `Process exited after completion marker: ${line.slice(0, 180)}`,
          exitCode: null,
          terminalSummary: line.slice(0, 240),
        };
      }
    }

    // Check if progress reached its known target count
    const cur = previous.progress.current ?? previous.progress.global.completedCount ?? previous.progress.session.completedCount;
    const tot = previous.progress.total ?? previous.progress.global.targetCount ?? previous.progress.session.targetCount;
    if (cur !== null && tot !== null && tot > 0 && cur >= tot) {
      return {
        lifecycle: "completed",
        confidence: "medium",
        reason: `Process exited after reaching target progress (${cur}/${tot})`,
        exitCode: null,
        terminalSummary: `Reached ${cur}/${tot}`,
      };
    }

    return {
      lifecycle: "stopped_unconfirmed",
      confidence: "low",
      reason: "Training process exited without a recorded exit code or explicit completion/error marker in tail logs",
      exitCode: null,
      terminalSummary: cleanTail[cleanTail.length - 1]?.slice(0, 240) ?? null,
    };
  }

  // Legacy fallback when caller does not supply tail logs or exit code
  return {
    lifecycle: "unconfirmed",
    confidence: "low",
    reason: "Previously running process vanished without terminal exit code",
    exitCode: null,
    terminalSummary: null,
  };
}

function toProcessInstance(
  proc: TaskProcessObservation,
  role: ProcessInstance["role"],
  parentKey: ProcessKey | null = null,
): ProcessInstance {
  return {
    key: proc.key,
    pid: proc.key?.pid ?? 0,
    parentKey,
    ...(typeof proc.ppid === "number" ? { ppid: proc.ppid } : {}),
    ...(typeof proc.pgid === "number" ? { pgid: proc.pgid } : {}),
    ...(typeof proc.nsPid === "number" ? { nsPid: proc.nsPid } : {}),
    cwd: proc.cwd,
    scriptEntry: processEntry(proc),
    ...(proc.exe ? { exe: proc.exe } : {}),
    ...(proc.command ? { command: proc.command } : {}),
    role,
    observedAt: proc.observedAt,
  };
}

export function projectTask(previous: TaskSnapshot | null, input: TaskEvidence): TaskSnapshot {
  const { task, taskObservation, hostObservation, observedAt } = input;
  const procs = taskObservation.scanComplete ? (taskObservation.processes || []) : [];

  const obsTime = parseIsoMs(observedAt);

  // Host and task observation gate: validate matching current host and process scan success
  const hostTimeValid = isTimestampValid(hostObservation.observedAt, obsTime);
  const hostSuccess =
    hostObservation.hostId === task.hostId &&
    hostObservation.connection === "connected" &&
    hostObservation.freshness === "fresh" &&
    hostObservation.scanComplete === true &&
    hostObservation.errorCode === null &&
    hostTimeValid;

  const taskTimeValid = isTimestampValid(taskObservation.observedAt, obsTime);
  const taskProcessScanComplete =
    taskObservation.taskId === task.taskId &&
    taskObservation.hostId === task.hostId &&
    taskObservation.freshness === "fresh" &&
    taskObservation.scanComplete === true &&
    taskObservation.processScanError === null &&
    (taskObservation.errorCode === null || taskObservation.errorScope === "source") &&
    taskTimeValid;

  const logOnlyObserved = task.attributionMode === "log_only" && input.logOnlyActive === true &&
    taskObservation.taskId === task.taskId && taskObservation.hostId === task.hostId &&
    taskObservation.freshness === "fresh" && taskTimeValid;
  if (!hostSuccess || (!taskProcessScanComplete && !logOnlyObserved)) {
    const previousRun = previous?.currentRun;
    const priorContextValid = !!previous &&
      previous.taskId === task.taskId && previous.hostId === task.hostId &&
      (!previousRun || (
        isStrongProcessKey(previousRun.mainProcessKey) &&
        previousRun.runId === makeRunId(task.hostId, task.taskId, previousRun.mainProcessKey)
      ));
    if (previous && !priorContextValid) {
      return projectTask(null, input);
    }
    if (previous) {
      const retainedContext = input.bindingState && input.bindingState.taskId === task.taskId &&
        input.bindingState.registeredTask?.taskId === task.taskId && input.bindingState.registeredTask.hostId === task.hostId &&
        JSON.stringify(input.bindingState.registeredTask) === JSON.stringify(task) && previous.currentRun
        ? deriveProgress({
            taskId: task.taskId, hostId: task.hostId,
            observedAt: previous.progress?.observedAt ?? previous.statusObservedAt ?? observedAt,
            freshness: "stale", algorithm: "unknown", currentRun: previous.currentRun,
            bindings: [], boundEvents: [], bindingState: input.bindingState,
          })
        : null;
      return {
        ...previous,
        freshness: "stale",
        statusObservedAt: previous.statusObservedAt, // DO NOT renew from failed poll
        confidence: "low",
        reason: "Host or task process scan failed, incomplete or stale; preserving previous state as stale",
        evidence: [
          {
            kind: previous.lifecycle,
            sourceId: null,
            observedAt: previous.statusObservedAt ?? observedAt,
            confidence: "low",
            summary: "Host or task process scan failed, incomplete or stale; preserving previous state as stale",
          },
        ],
        resources: input.resources ?? previous.resources,
        progress: retainedContext ?? createEmptyProgress(previous.statusObservedAt ?? observedAt, "stale", null),
      };
    } else {
      return {
        version: 1,
        taskId: task.taskId,
        hostId: task.hostId,
        lifecycle: "unconfirmed",
        freshness: "stale",
        statusObservedAt: observedAt,
        confidence: "low",
        attributionConfidence: "none",
        reason: "Host disconnected, incomplete or unobserved during scan without prior state",
        evidence: [
          {
            kind: "unconfirmed",
            sourceId: null,
            observedAt,
            confidence: "low",
            summary: "Host disconnected, incomplete or unobserved during scan without prior state",
          },
        ],
        currentRun: null,
        processes: {
          main: null,
          queue: null,
          workers: [],
        },
        queueLock: {
          observedAt: null,
          freshness: "unobserved",
          source: null,
          exists: null,
          heldByRegisteredProcess: null,
        },
        progress: createEmptyProgress(observedAt, "stale", null),
        checkpoint: {
          observedAt: null,
          freshness: "unobserved",
          path: null,
          fileStepIndex: null,
          stepSource: null,
          sizeBytes: null,
          mtime: null,
          evidence: "none",
          scanComplete: false,
        },
        resources: input.resources ?? [],
      };
    }
  }

  // Find candidate queue process (optional legacy status_json adapter; no hardcoded private state strings)
  const queueCandidates = procs.filter((p) => {
    if (!isStrongProcessKey(p.key)) return false;
    if (!isRegisteredProcessEntry(task, p)) return false;
    if (p.role !== "queue" && p.roleEvidence !== "exact_script_entry") return false;

    if (!input.statusFileLinkage) return false;
    if (!areProcessKeysEqual(input.statusFileLinkage.currentInstanceKey, p.key)) return false;
    if (!input.statusFileLinkage.sourceId) return false;

    const regSource = task.sources.find(
      (rs) => rs.sourceId === input.statusFileLinkage!.sourceId && rs.kind === "status_json"
    );
    if (!regSource) return false;

    const statusSrc = (taskObservation.sources || []).find(
      (s) => s.sourceId === regSource.sourceId
    );
    if (!statusSrc) return false;
    if (!isTimestampValid(statusSrc.observedAt, obsTime)) return false;
    if (statusSrc.permission !== "readable" || statusSrc.exists !== true || !statusSrc.evidenceComplete ||
        !statusSrc.fileIdentity?.dev || !statusSrc.fileIdentity.inode || !isValidDecimalBytes(statusSrc.eofBytes)) return false;

    const vals = statusSrc.statusValues;
    if (!vals) return false;
    const hasWait = Boolean(
      vals.waiting === true ||
      vals.state === "queued" ||
      vals.status === "waiting"
    );
    if (!hasWait) return false;

    if (input.statusFileLinkage.sequence === undefined || !Number.isSafeInteger(input.statusFileLinkage.sequence) || vals.sequence !== input.statusFileLinkage.sequence) return false;
    if (!input.statusFileLinkage.observedAt || !isTimestampValid(input.statusFileLinkage.observedAt, obsTime) || input.statusFileLinkage.observedAt !== statusSrc.observedAt) return false;
    if (vals.hostBootId !== p.key.hostBootId || vals.pid !== p.key.pid || vals.startTicks !== p.key.startTicks) return false;

    return true;
  });

  const queueCandidate = queueCandidates.length === 1 ? queueCandidates[0]! : null;

  const stalePriorQueueEvidence = Boolean(previous?.lifecycle === "queued" && !queueCandidate && input.statusFileLinkage && procs.some((p) => {
    if (!isStrongProcessKey(p.key) || !areProcessKeysEqual(input.statusFileLinkage!.currentInstanceKey, p.key)) return false;
    if (!isRegisteredProcessEntry(task, p) || (p.role !== "queue" && p.roleEvidence !== "exact_script_entry")) return false;
    const regSource = task.sources.find((s) => s.sourceId === input.statusFileLinkage!.sourceId && s.kind === "status_json");
    if (!regSource) return false;
    const statusSource = taskObservation.sources.find((s) => s.sourceId === regSource.sourceId);
    return !statusSource || !isTimestampValid(statusSource.observedAt, obsTime) || !input.statusFileLinkage?.observedAt || !isTimestampValid(input.statusFileLinkage.observedAt, obsTime);
  }));

  // Find candidate main trainer process & process tree via 3-tier attribution (decoupled from 30s log TTL)
  const outputSourceInfo: Record<string, { generation: string; eofBytes: string; fileIdentity: { dev: string; inode: string } | null }> = {};
  for (const window of input.bindingState?.windows ?? []) {
    if (window.isOpen && window.taskId === task.taskId && window.fileIdentity) {
      outputSourceInfo[window.sourceId] = {
        generation: window.generation,
        eofBytes: window.throughOffset,
        fileIdentity: window.fileIdentity,
      };
    }
  }
  const attributed = findLiveAttributedProcess(
    task,
    taskObservation,
    obsTime,
    input.outputSamples ?? {},
    outputSourceInfo,
    {
      logOnlyActive: input.logOnlyActive === true,
      skipInferredTree: Boolean(queueCandidate || stalePriorQueueEvidence),
    },
  );
  const mainCandidate = attributed.primary;
  const attributionConfidence: AttributionConfidence = attributed.attributionConfidence;

  const mainInstance: ProcessInstance | null =
    mainCandidate && isStrongProcessKey(mainCandidate.key)
      ? toProcessInstance(mainCandidate, "trainer", null)
      : null;

  const queueInstance: ProcessInstance | null =
    queueCandidate && isStrongProcessKey(queueCandidate.key)
      ? toProcessInstance(queueCandidate, "queue", null)
      : null;

  // Populate workers: combine explicit worker-role procs AND process-tree DDP/FSDP/DataLoader children
  const workerMap = new Map<string, ProcessInstance>();
  for (const member of attributed.treeMembers) {
    if (!isStrongProcessKey(member.key)) continue;
    const k = `${member.key.hostBootId}:${member.key.pid}:${member.key.startTicks}`;
    workerMap.set(k, toProcessInstance(member, "worker", mainInstance?.key ?? null));
  }
  for (const w of procs) {
    if (w.role !== "worker" || !isStrongProcessKey(w.key)) continue;
    if (mainInstance && areProcessKeysEqual(w.key, mainInstance.key)) continue;
    const k = `${w.key.hostBootId}:${w.key.pid}:${w.key.startTicks}`;
    if (!workerMap.has(k)) {
      workerMap.set(k, toProcessInstance(w, "worker", mainInstance?.key ?? null));
    }
  }
  const workerInstances: ProcessInstance[] = [...workerMap.values()];

  // Determine currentRun
  let currentRun: { runId: string; mainProcessKey: ProcessKey } | null = null;
  if (mainInstance && mainInstance.key) {
    const runId = makeRunId(task.hostId, task.taskId, mainInstance.key);
    currentRun = { runId, mainProcessKey: mainInstance.key };
  }

  // Determine lifecycle, confidence, reason, exitCode, terminalSummary
  let lifecycle: Lifecycle = "unknown";
  let confidence: Confidence = "none";
  let reason = "";
  let exitCode: number | null = null;
  let terminalSummary: string | null = null;

  if (mainInstance) {
    lifecycle = "running";
    confidence = attributionConfidence === "confirmed_process" ? "high" : "medium";
    const treeNote = workerInstances.length > 0 ? ` (+${workerInstances.length} child/worker process${workerInstances.length > 1 ? 'es' : ''})` : "";
    reason = attributionConfidence === "confirmed_process"
      ? `Active training process confirmed${treeNote}`
      : `Active training process tree inferred${treeNote} (no direct log write FD)`;
  } else if (attributionConfidence === "log_only") {
    lifecycle = "running";
    confidence = "medium";
    reason = "Tracking active training via log output (log-only mode)";
  } else if (queueInstance) {
    lifecycle = "queued";
    confidence = "high";
    reason = "Queue process observed matching registered entry and waiting record";
  } else if (stalePriorQueueEvidence) {
    lifecycle = "unconfirmed";
    confidence = "low";
    reason = "Previously queued process remains visible, but its linked waiting record is stale; preserving prior status time as stale";
  } else if (previous && (previous.lifecycle === "running" || previous.lifecycle === "unconfirmed" || previous.lifecycle === "stopped_unconfirmed")) {
    const inferred = inferTerminalStateFromExit(previous, input.managedExitCode, input.tailLogLines);
    lifecycle = inferred.lifecycle;
    confidence = inferred.confidence;
    reason = inferred.reason;
    exitCode = inferred.exitCode;
    terminalSummary = inferred.terminalSummary;
  } else {
    lifecycle = "not_observed";
    confidence = "high";
    reason = "Scan complete with no active processes or records observed";
  }

  // Match lock by registered source kind/id, not a substring heuristic
  const lockReg = task.sources.find((s) => s.kind === "queue_lock");
  const lockSrc = lockReg
    ? (taskObservation.sources || []).find((s) => s.sourceId === lockReg.sourceId)
    : null;

  const queueLock = {
    observedAt: lockSrc ? lockSrc.observedAt : null,
    freshness: lockSrc ? taskObservation.freshness : ("unobserved" as const),
    source: lockSrc ? lockSrc.sourceId : null,
    exists: lockSrc ? lockSrc.exists : null,
    heldByRegisteredProcess: lockSrc ? lockSrc.heldByRegisteredProcess : null,
  };

  const checkpoint: Checkpoint = input.checkpoint ?? previous?.checkpoint ?? {
    observedAt: null,
    freshness: "unobserved",
    path: null,
    fileStepIndex: null,
    stepSource: null,
    sizeBytes: null,
    mtime: null,
    evidence: "none",
    scanComplete: false,
  };

  const resources: ResourceMetric[] = input.resources ?? previous?.resources ?? [];

  // Progress: validate against currentRun and canonical bindingState
  const bindingState = input.bindingState;
  const canonicalBindingState = bindingState && bindingState.taskId === task.taskId &&
    bindingState.registeredTask?.taskId === task.taskId && bindingState.registeredTask.hostId === task.hostId &&
    JSON.stringify(bindingState.registeredTask) === JSON.stringify(task)
    ? bindingState
    : null;
  const progressRun = currentRun ?? (attributionConfidence === "log_only" && canonicalBindingState?.activeRunId
    ? { runId: canonicalBindingState.activeRunId, mainProcessKey: null }
    : null);
  let progress = canonicalBindingState && progressRun
    ? deriveProgress({
        taskId: task.taskId,
        hostId: task.hostId,
        observedAt,
        freshness: taskObservation.freshness,
        algorithm: "unknown",
        currentRun: progressRun,
        bindings: [],
        boundEvents: [],
        bindingState: canonicalBindingState,
      })
    : createEmptyProgress(observedAt, taskObservation.freshness, null);

  // If the process is confirmed alive during a slow step / eval / compile silence and we had same-run
  // progress from a previous poll, preserve the last known progress values while marking progressFreshness='stale'.
  if (
    lifecycle === "running" &&
    currentRun &&
    progress.runId === null &&
    previous?.progress.runId === currentRun.runId
  ) {
    progress = {
      ...previous.progress,
      freshness: "stale",
      progressFreshness: "stale",
      iterationsPerSecond: null,
      etaSeconds: null,
    };
  }

  const projectedFreshness = stalePriorQueueEvidence ? "stale" : taskObservation.freshness;

  return {
    version: 1,
    taskId: task.taskId,
    hostId: task.hostId,
    lifecycle,
    freshness: projectedFreshness,
    statusObservedAt: stalePriorQueueEvidence ? previous!.statusObservedAt : observedAt,
    confidence,
    attributionConfidence,
    ...(exitCode !== null ? { exitCode } : {}),
    ...(terminalSummary !== null ? { terminalSummary } : {}),
    reason,
    evidence: [
      {
        kind: lifecycle,
        sourceId: null,
        observedAt,
        confidence,
        summary: reason,
      },
    ],
    currentRun,
    processes: {
      main: mainInstance,
      queue: queueInstance,
      workers: workerInstances,
    },
    queueLock,
    progress: stalePriorQueueEvidence ? { ...progress, freshness: "stale", progressFreshness: "stale", iterationsPerSecond: null, etaSeconds: null } : progress,
    checkpoint,
    resources,
  };
}
