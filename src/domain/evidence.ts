import type { ProcessKey, TaskRegistration } from "../shared/contracts";
import type { TaskObservation } from "../transport/types";
import { areProcessKeysEqual, isStrongProcessKey, makeRunId } from "./identity";
import {
  isRuntimeTaskPolicy,
  isValidDecimalBytes,
  parseIsoMs,
  type BindingState,
  type StructuredBaselineRead,
} from "./bindings";
import {
  createBaselineReadSupport,
  parseBaselineStartupContent,
  validateStructuredBaselineRead,
} from "./baseline";

export interface StructuredBaselineReadInput {
  evidenceId: string;
  sourceId: string;
  generation: string;
  fileIdentity: { dev: string; inode: string };
  observedAt: string;
  startOffset: string;
  endOffset: string;
  rawContent: string;
}

/**
 * Record a structured startup read only when it resolves against the current
 * registered task, successful source observation and active strong process.
 */
export function ingestStructuredBaselineRead(
  state: BindingState,
  task: TaskRegistration,
  observation: TaskObservation,
  read: StructuredBaselineReadInput,
): BindingState {
  if (!state || typeof state !== "object" || !isRuntimeTaskPolicy(task) ||
      !observation || typeof observation !== "object" || !Array.isArray(observation.sources) ||
      !read || typeof read !== "object") {
    return { ...state, baselineRead: null };
  }
  const mainKey = state.activeMainKey;
  const obsTime = parseIsoMs(observation.observedAt);
  const source = observation.sources.find((candidate) =>
    !!candidate && typeof candidate === "object" && candidate.sourceId === read.sourceId
  );
  const registered = task.sources.some((candidate) =>
    candidate.sourceId === read.sourceId && candidate.kind === "status_json"
  );
  const parsed = typeof read.rawContent === "string" ? parseBaselineStartupContent(read.rawContent) : null;
  let embedded: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(read.rawContent);
    if (value && typeof value === "object" && !Array.isArray(value)) embedded = value as Record<string, unknown>;
  } catch {
    embedded = null;
  }
  const statusValues = source?.statusValues as Record<string, unknown> | null | undefined;
  const readCompleted = !!read && typeof read === "object" &&
    typeof read.evidenceId === "string" && read.evidenceId.length > 0 &&
    typeof read.sourceId === "string" && read.sourceId.length > 0 &&
    typeof read.generation === "string" && read.generation.length > 0 &&
    !!read.fileIdentity && typeof read.fileIdentity === "object" &&
    typeof read.fileIdentity.dev === "string" && typeof read.fileIdentity.inode === "string" &&
    typeof read.observedAt === "string" && parseIsoMs(read.observedAt) !== null &&
    isValidDecimalBytes(read.startOffset) && isValidDecimalBytes(read.endOffset) &&
    typeof read.rawContent === "string";
  const existingBaseline = state.baselineRead;
  const existingValidatedBaseline = existingBaseline && mainKey && state.activeRunId
    ? validateStructuredBaselineRead(existingBaseline, {
        task,
        taskId: task.taskId,
        hostId: task.hostId,
        currentRun: { runId: state.activeRunId, mainProcessKey: mainKey },
        observedAt: observation.observedAt,
      })
    : null;
  const contradictoryBaseline = existingValidatedBaseline !== null &&
    existingBaseline !== null && existingBaseline !== undefined &&
    (read.sourceId === existingBaseline.sourceId) &&
    (parsed?.resumeCheckpointIndex !== existingBaseline.resumeCheckpointIndex ||
      parsed?.targetCount !== existingBaseline.targetCount ||
      parsed?.targetMeaning !== "exclusive_index");
  if (!readCompleted || !mainKey || contradictoryBaseline) {
    return { ...state, baselineRead: null };
  }
  const sourceCursors = Array.isArray(state.sourceCursors) ? state.sourceCursors : [];
  const sourceCursor = sourceCursors.find((cursor) =>
    cursor !== null && typeof cursor === "object" &&
    cursor.sourceId === read.sourceId && cursor.generation === read.generation &&
    cursor.fileIdentity !== null && typeof cursor.fileIdentity === "object" &&
    cursor.fileIdentity.dev === read.fileIdentity?.dev && cursor.fileIdentity.inode === read.fileIdentity?.inode &&
    cursor.observedAt === read.observedAt && cursor.observedAt === source?.observedAt &&
    isValidDecimalBytes(cursor.eofBytes) && isValidDecimalBytes(read.endOffset) && BigInt(read.endOffset) <= BigInt(cursor.eofBytes)
  );
  const embeddedKey = embedded && { hostBootId: embedded.hostBootId, pid: embedded.pid, startTicks: embedded.startTicks };
  const statusKey = statusValues && { hostBootId: statusValues.hostBootId, pid: statusValues.pid, startTicks: statusValues.startTicks };
  if (!mainKey || !state.activeRunId || state.taskId !== task.taskId || state.registeredTask?.taskId !== task.taskId ||
      state.registeredTask.hostId !== task.hostId || JSON.stringify(state.registeredTask) !== JSON.stringify(task) ||
      !task.enabled || task.taskId !== observation.taskId || task.hostId !== observation.hostId ||
      state.activeRunId !== makeRunId(task.hostId, task.taskId, mainKey) ||
      !isStrongProcessKey(mainKey) || !registered || !source || !sourceCursor ||
      observation.freshness !== "fresh" || observation.scanComplete !== true || observation.processScanError !== null ||
      !source.evidenceComplete || source.permission !== "readable" || source.exists !== true ||
      !source.fileIdentity?.dev || !source.fileIdentity.inode ||
      source.fileIdentity.dev !== read.fileIdentity?.dev || source.fileIdentity.inode !== read.fileIdentity?.inode ||
      source.observedAt !== read.observedAt || !isValidDecimalBytes(source.eofBytes) ||
      !isValidDecimalBytes(read.startOffset) || !isValidDecimalBytes(read.endOffset) ||
      BigInt(read.startOffset) >= BigInt(read.endOffset) || BigInt(read.endOffset) > BigInt(source.eofBytes) ||
      BigInt(new TextEncoder().encode(read.rawContent).length) !== BigInt(read.endOffset) - BigInt(read.startOffset) ||
      obsTime === null || parseIsoMs(read.observedAt) === null || parseIsoMs(read.observedAt)! > obsTime ||
      !parsed || parsed.resumeCheckpointIndex === null || parsed.targetCount === null || parsed.targetMeaning !== "exclusive_index" ||
      !embedded || embedded.taskId !== task.taskId || embedded.hostId !== task.hostId ||
      !isStrongProcessKey(embeddedKey as ProcessKey | null) || !areProcessKeysEqual(embeddedKey as ProcessKey | null, mainKey) ||
      !Number.isSafeInteger(embedded.sequence) || (embedded.sequence as number) <= 0 ||
      !statusValues || statusValues.taskId !== task.taskId || statusValues.hostId !== task.hostId ||
      statusValues.sequence !== embedded.sequence || !isStrongProcessKey(statusKey as ProcessKey | null) || !areProcessKeysEqual(statusKey as ProcessKey | null, mainKey)) {
    return { ...state, baselineRead: null };
  }

  const baselineRead: StructuredBaselineRead = {
    ...read,
    taskId: task.taskId,
    hostId: task.hostId,
    runId: state.activeRunId,
    mainProcessKey: { ...mainKey },
    resumeCheckpointIndex: parsed.resumeCheckpointIndex,
    targetCount: parsed.targetCount,
    support: createBaselineReadSupport(
      source,
      sourceCursor,
      embedded.sequence as number,
      mainKey
    ),
  };
  const validated = validateStructuredBaselineRead(baselineRead, {
    task,
    taskId: task.taskId,
    hostId: task.hostId,
    currentRun: { runId: state.activeRunId, mainProcessKey: mainKey },
    observedAt: observation.observedAt,
  });
  return { ...state, baselineRead: validated };
}
