import type {
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
import type { HostObservation, TaskObservation } from "../transport/types";
import type { BindingState, TrainerOutputObservation } from "./bindings";
import { parseIsoMs, isTimestampValid, findSubstantiveTrainerProcess, isValidDecimalBytes } from "./bindings";
import { createEmptyProgress, deriveProgress, type ProgressEvidence } from "./progress";
import { areProcessKeysEqual, isRegisteredProcessEntry, isStrongProcessKey, makeRunId, processEntry } from "./identity";

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
}

export function projectTask(previous: TaskSnapshot | null, input: TaskEvidence): TaskSnapshot {
  const { task, taskObservation, hostObservation, observedAt } = input;
  const procs = taskObservation.processes || [];

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

  if (!hostSuccess || !taskProcessScanComplete) {
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

  // Find candidate main trainer process via authoritative substantive predicate
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
  const mainCandidate = findSubstantiveTrainerProcess(
    task,
    taskObservation,
    obsTime,
    input.outputSamples ?? {},
    outputSourceInfo
  );

  // Find candidate queue process:
  // Must have strong key, exact personal registered entry, and matching current-waiting record
  const queueCandidates = procs.filter((p) => {
    if (!isStrongProcessKey(p.key)) return false;
    if (!isRegisteredProcessEntry(task, p)) return false;
    if (p.role !== "queue" && p.roleEvidence !== "exact_script_entry") return false;

    // Must have matching current-waiting record and linkage on the SAME registered status_json source
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
      vals.state === "waiting_flow" ||
      vals.state === "queued" ||
      vals.status === "waiting"
    );
    if (!hasWait) return false;

    if (input.statusFileLinkage.sequence === undefined || !Number.isSafeInteger(input.statusFileLinkage.sequence) || vals.sequence !== input.statusFileLinkage.sequence) return false;
    if (!input.statusFileLinkage.observedAt || !isTimestampValid(input.statusFileLinkage.observedAt, obsTime) || input.statusFileLinkage.observedAt !== statusSrc.observedAt) return false;
    if (vals.hostBootId !== p.key.hostBootId || vals.pid !== p.key.pid || vals.startTicks !== p.key.startTicks) return false;

    return true;
  });

  const queueCandidate = queueCandidates.length === 1 ? queueCandidates[0] : null;

  const stalePriorQueueEvidence = Boolean(previous?.lifecycle === "queued" && !queueCandidate && input.statusFileLinkage && procs.some((p) => {
    if (!isStrongProcessKey(p.key) || !areProcessKeysEqual(input.statusFileLinkage!.currentInstanceKey, p.key)) return false;
    if (!isRegisteredProcessEntry(task, p) || (p.role !== "queue" && p.roleEvidence !== "exact_script_entry")) return false;
    const regSource = task.sources.find((s) => s.sourceId === input.statusFileLinkage!.sourceId && s.kind === "status_json");
    if (!regSource) return false;
    const statusSource = taskObservation.sources.find((s) => s.sourceId === regSource.sourceId);
    return !statusSource || !isTimestampValid(statusSource.observedAt, obsTime) || !input.statusFileLinkage?.observedAt || !isTimestampValid(input.statusFileLinkage.observedAt, obsTime);
  }));

  // Find worker processes
  const workerCandidates = procs.filter((p) => p.role === "worker");

  const mainInstance: ProcessInstance | null =
    mainCandidate && isStrongProcessKey(mainCandidate.key)
      ? {
          key: mainCandidate.key,
          pid: mainCandidate.key.pid,
          parentKey: null,
          cwd: mainCandidate.cwd,
          scriptEntry: processEntry(mainCandidate),
          role: "trainer",
          observedAt: mainCandidate.observedAt,
        }
      : null;

  const queueInstance: ProcessInstance | null =
    queueCandidate && isStrongProcessKey(queueCandidate.key)
      ? {
          key: queueCandidate.key,
          pid: queueCandidate.key.pid,
          parentKey: null,
          cwd: queueCandidate.cwd,
          scriptEntry: processEntry(queueCandidate),
          role: "queue",
          observedAt: queueCandidate.observedAt,
        }
      : null;

  const workerInstances: ProcessInstance[] = workerCandidates.map((w) => ({
    key: w.key,
    pid: w.key?.pid ?? 0,
    parentKey: null,
    cwd: w.cwd,
    scriptEntry: processEntry(w),
    role: "worker",
    observedAt: w.observedAt,
  }));

  // Determine currentRun
  let currentRun: { runId: string; mainProcessKey: ProcessKey } | null = null;
  if (mainInstance && mainInstance.key) {
    const runId = makeRunId(task.hostId, task.taskId, mainInstance.key);
    currentRun = { runId, mainProcessKey: mainInstance.key };
  }

  // Determine lifecycle, confidence, reason
  let lifecycle: Lifecycle = "unknown";
  let confidence: Confidence = "none";
  let reason = "";

  if (mainInstance) {
    lifecycle = "running";
    confidence = "high";
    reason = "Active training process confirmed";
  } else if (queueInstance) {
    lifecycle = "queued";
    confidence = "high";
    reason = "Queue process observed matching registered entry and waiting record";
  } else if (stalePriorQueueEvidence) {
    lifecycle = "unconfirmed";
    confidence = "low";
    reason = "Previously queued process remains visible, but its linked waiting record is stale; preserving prior status time as stale";
  } else {
    // No active main or queue process found
    if (previous && (previous.lifecycle === "running" || previous.lifecycle === "unconfirmed")) {
      lifecycle = "unconfirmed";
      confidence = "low";
      reason = "Previously running process vanished without terminal exit code";
    } else {
      lifecycle = "not_observed";
      confidence = "high";
      reason = "Scan complete with no active processes or records observed";
    }
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

  // Progress:
  // Validate caller progress and previous progress against currentRun and surviving unrevoked bindings
  const bindingState = input.bindingState;
  const revokedSet = new Set(bindingState?.revokedBindingIds || []);
  const validBindings = (bindingState?.bindings || []).filter((b) => {
    if (revokedSet.has(b.bindingId)) return false;
    if (!currentRun || b.runId !== currentRun.runId) return false;
    if (!areProcessKeysEqual(b.mainProcessKey, currentRun.mainProcessKey)) return false;
    const regSource = task.sources.find((s) => s.sourceId === b.sourceId);
    if (!regSource || regSource.kind !== "log") return false;
    if (!isValidDecimalBytes(b.fromOffset) || !isValidDecimalBytes(b.throughOffset)) return false;
    if (BigInt(b.fromOffset) >= BigInt(b.throughOffset)) return false;
    return true;
  });
  const validBindingIds = new Set(validBindings.map((b) => b.bindingId));

  const canonicalBindingState = bindingState && bindingState.taskId === task.taskId &&
    bindingState.registeredTask?.taskId === task.taskId && bindingState.registeredTask.hostId === task.hostId &&
    JSON.stringify(bindingState.registeredTask) === JSON.stringify(task)
    ? bindingState
    : null;
  const progress = canonicalBindingState && currentRun
    ? deriveProgress({
        taskId: task.taskId,
        hostId: task.hostId,
        observedAt,
        freshness: taskObservation.freshness,
        algorithm: "unknown",
        currentRun,
        bindings: [],
        boundEvents: [],
        bindingState: canonicalBindingState,
      })
    : createEmptyProgress(observedAt, taskObservation.freshness, null);

  const projectedFreshness = stalePriorQueueEvidence ? "stale" : taskObservation.freshness;

  return {
    version: 1,
    taskId: task.taskId,
    hostId: task.hostId,
    lifecycle,
    freshness: projectedFreshness,
    statusObservedAt: stalePriorQueueEvidence ? previous!.statusObservedAt : observedAt,
    confidence,
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
    progress: stalePriorQueueEvidence ? { ...progress, freshness: "stale", iterationsPerSecond: null, etaSeconds: null } : progress,
    checkpoint,
    resources,
  };
}
