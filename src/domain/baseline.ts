import type {
  ProcessKey,
  TaskRegistration,
} from "../shared/contracts";
import type { TaskObservation } from "../transport/types";
import {
  areProcessKeysEqual,
  isStrongProcessKey,
  makeRunId,
} from "./identity";
import type {
  BaselineReadSupport,
  BindingSourceCursor,
  StructuredBaselineRead,
} from "./bindings";

export interface ParsedBaselineContent {
  resumeCheckpointIndex: number | null;
  targetCount: number | null;
  targetMeaning: string | null;
}

export interface BaselineValidationContext {
  task: unknown;
  taskId: string;
  hostId: string;
  currentRun: { runId: string; mainProcessKey: ProcessKey } | null;
  observedAt: string | null;
}

const MAX_BASELINE_BYTES = 256 * 1024;

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDecimalBytes(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function toDecimal(value: unknown): bigint | null {
  if (!isDecimalBytes(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function cloneFileIdentity(
  value: unknown
): { dev: string; inode: string } | null {
  if (!value || typeof value !== "object") return null;
  const identity = value as { dev?: unknown; inode?: unknown };
  if (!isNonemptyString(identity.dev) || !isNonemptyString(identity.inode)) {
    return null;
  }
  return { dev: identity.dev, inode: identity.inode };
}

function cloneProcessKey(value: unknown): ProcessKey | null {
  if (!value || typeof value !== "object") return null;
  const key = value as ProcessKey;
  if (!isStrongProcessKey(key)) return null;
  return {
    hostBootId: key.hostBootId,
    pid: key.pid,
    startTicks: key.startTicks,
  };
}

function sameFileIdentity(
  left: unknown,
  right: unknown
): boolean {
  const a = cloneFileIdentity(left);
  const b = cloneFileIdentity(right);
  return a !== null && b !== null &&
    a.dev === b.dev && a.inode === b.inode;
}

function isRegisteredStatusSource(
  task: unknown,
  sourceId: unknown
): task is TaskRegistration {
  if (!task || typeof task !== "object" || !isNonemptyString(sourceId)) {
    return false;
  }
  const candidate = task as TaskRegistration;
  return isNonemptyString(candidate.taskId) &&
    isNonemptyString(candidate.hostId) &&
    candidate.enabled === true &&
    Array.isArray(candidate.sources) &&
    candidate.sources.some((source) =>
      !!source &&
      typeof source === "object" &&
      source.sourceId === sourceId &&
      source.kind === "status_json"
    );
}

function parseConcreteBaselineJson(
  raw: unknown
): { parsed: ParsedBaselineContent; record: Record<string, unknown> } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const resumeCheckpointIndex =
    typeof record.resume_checkpoint_index === "number"
      ? record.resume_checkpoint_index
      : typeof record.resumeCheckpointIndex === "number"
      ? record.resumeCheckpointIndex
      : typeof record.resume_step === "number"
      ? record.resume_step
      : null;
  const targetCount =
    typeof record.total_steps === "number"
      ? record.total_steps
      : typeof record.target === "number"
      ? record.target
      : typeof record.target_count === "number"
      ? record.target_count
      : typeof record.targetCount === "number"
      ? record.targetCount
      : null;
  const targetMeaning =
    typeof record.target_meaning === "string"
      ? record.target_meaning
      : typeof record.meaning === "string"
      ? record.meaning
      : null;
  if (resumeCheckpointIndex === null ||
      targetCount === null ||
      targetMeaning === null) {
    return null;
  }
  return {
    parsed: { resumeCheckpointIndex, targetCount, targetMeaning },
    record,
  };
}

function validateSupport(
  baseline: StructuredBaselineRead,
  support: BaselineReadSupport
): boolean {
  if (support.version !== 1) return false;
  const source = support.source;
  const cursor = support.cursor;
  const status = support.status;
  if (!source || !cursor || !status) return false;

  const sourceIdentity = cloneFileIdentity(source.fileIdentity);
  const cursorIdentity = cloneFileIdentity(cursor.fileIdentity);
  const baselineIdentity = cloneFileIdentity(baseline.fileIdentity);
  const statusKey = cloneProcessKey(status.mainProcessKey);
  if (!sourceIdentity || !cursorIdentity || !baselineIdentity || !statusKey) {
    return false;
  }

  if (!isNonemptyString(source.sourceId) ||
      !isNonemptyString(cursor.sourceId) ||
      source.sourceId !== baseline.sourceId ||
      cursor.sourceId !== source.sourceId ||
      !isNonemptyString(source.generation) ||
      !isNonemptyString(cursor.generation) ||
      source.generation !== baseline.generation ||
      cursor.generation !== source.generation ||
      !sameFileIdentity(source.fileIdentity, cursor.fileIdentity) ||
      !sameFileIdentity(source.fileIdentity, baseline.fileIdentity) ||
      !sameFileIdentity(cursor.fileIdentity, baseline.fileIdentity)) {
    return false;
  }

  const sourceEof = toDecimal(source.eofBytes);
  const cursorEof = toDecimal(cursor.eofBytes);
  if (sourceEof === null ||
      cursorEof === null ||
      sourceEof !== cursorEof) {
    return false;
  }

  const sourceTime = parseTimestamp(source.observedAt);
  const cursorTime = parseTimestamp(cursor.observedAt);
  const baselineTime = parseTimestamp(baseline.observedAt);
  if (sourceTime === null ||
      cursorTime === null ||
      baselineTime === null ||
      sourceTime !== cursorTime ||
      sourceTime !== baselineTime) {
    return false;
  }

  if (!isNonemptyString(status.taskId) ||
      !isNonemptyString(status.hostId) ||
      status.taskId !== baseline.taskId ||
      status.hostId !== baseline.hostId ||
      !Number.isSafeInteger(status.sequence) ||
      status.sequence <= 0 ||
      !areProcessKeysEqual(status.mainProcessKey, baseline.mainProcessKey)) {
    return false;
  }

  return true;
}

/**
 * Validate a baseline only from immutable ingestion support and the current
 * task/run context. Latest source metadata is deliberately not consulted.
 */
export function validateStructuredBaselineRead(
  baseline: unknown,
  context: BaselineValidationContext
): StructuredBaselineRead | null {
  if (!baseline || typeof baseline !== "object") return null;
  const candidate = baseline as StructuredBaselineRead;
  const { task, taskId, hostId, currentRun, observedAt } = context;

  if (!isRegisteredStatusSource(task, candidate.sourceId) ||
      task.taskId !== taskId ||
      task.hostId !== hostId ||
      candidate.taskId !== taskId ||
      candidate.hostId !== hostId ||
      !currentRun ||
      candidate.runId !== currentRun.runId ||
      candidate.runId !== makeRunId(hostId, taskId, currentRun.mainProcessKey) ||
      !areProcessKeysEqual(candidate.mainProcessKey, currentRun.mainProcessKey) ||
      !isStrongProcessKey(candidate.mainProcessKey)) {
    return null;
  }

  if (!candidate.support ||
      typeof candidate.support !== "object" ||
      !validateSupport(candidate, candidate.support)) {
    return null;
  }

  const observationTime = parseTimestamp(observedAt);
  const sourceTime = parseTimestamp(candidate.support.source.observedAt);
  const baselineTime = parseTimestamp(candidate.observedAt);
  if (observationTime === null ||
      sourceTime === null ||
      baselineTime === null ||
      baselineTime > observationTime ||
      sourceTime > observationTime) {
    return null;
  }

  const start = toDecimal(candidate.startOffset);
  const end = toDecimal(candidate.endOffset);
  const originalEof = toDecimal(candidate.support.source.eofBytes);
  if (start === null ||
      end === null ||
      originalEof === null ||
      start < 0n ||
      start >= end ||
      end > originalEof ||
      typeof candidate.rawContent !== "string") {
    return null;
  }

  const rawBytes = new TextEncoder().encode(candidate.rawContent).length;
  if (rawBytes > MAX_BASELINE_BYTES ||
      BigInt(rawBytes) !== end - start) {
    return null;
  }

  const concrete = parseConcreteBaselineJson(candidate.rawContent);
  if (!concrete) return null;
  const { parsed, record } = concrete;
  if (parsed.resumeCheckpointIndex !== candidate.resumeCheckpointIndex ||
      parsed.targetCount !== candidate.targetCount ||
      parsed.targetMeaning !== "exclusive_index" ||
      !Number.isSafeInteger(candidate.resumeCheckpointIndex) ||
      candidate.resumeCheckpointIndex < 0 ||
      !Number.isSafeInteger(candidate.targetCount) ||
      candidate.targetCount <= 0) {
    return null;
  }

  const embeddedKey = cloneProcessKey({
    hostBootId: record.hostBootId,
    pid: record.pid,
    startTicks: record.startTicks,
  });
  if (!embeddedKey ||
      record.taskId !== taskId ||
      record.hostId !== hostId ||
      !areProcessKeysEqual(embeddedKey, candidate.mainProcessKey) ||
      !Number.isSafeInteger(record.sequence) ||
      (record.sequence as number) <= 0 ||
      record.sequence !== candidate.support.status.sequence) {
    return null;
  }

  return {
    ...candidate,
    mainProcessKey: { ...candidate.mainProcessKey },
    fileIdentity: { ...candidate.fileIdentity },
    support: {
      version: 1,
      source: {
        sourceId: candidate.support.source.sourceId,
        generation: candidate.support.source.generation,
        fileIdentity: { ...candidate.support.source.fileIdentity },
        eofBytes: candidate.support.source.eofBytes,
        observedAt: candidate.support.source.observedAt,
      },
      cursor: {
        sourceId: candidate.support.cursor.sourceId,
        generation: candidate.support.cursor.generation,
        fileIdentity: { ...candidate.support.cursor.fileIdentity },
        eofBytes: candidate.support.cursor.eofBytes,
        observedAt: candidate.support.cursor.observedAt,
      },
      status: {
        taskId: candidate.support.status.taskId,
        hostId: candidate.support.status.hostId,
        sequence: candidate.support.status.sequence,
        mainProcessKey: { ...candidate.support.status.mainProcessKey },
      },
    },
  };
}

export function createBaselineReadSupport(
  source: TaskObservation["sources"][number],
  cursor: BindingSourceCursor,
  statusSequence: number,
  statusKey: ProcessKey
): BaselineReadSupport {
  const sourceIdentity = cloneFileIdentity(source.fileIdentity);
  const cursorIdentity = cloneFileIdentity(cursor.fileIdentity);
  const key = cloneProcessKey(statusKey);
  if (!sourceIdentity || !cursorIdentity || !key) {
    throw new Error("Cannot create baseline support without strong identities");
  }
  return {
    version: 1,
    source: {
      sourceId: source.sourceId,
      generation: cursor.generation,
      fileIdentity: sourceIdentity,
      eofBytes: source.eofBytes!,
      observedAt: source.observedAt!,
    },
    cursor: {
      sourceId: cursor.sourceId,
      generation: cursor.generation,
      fileIdentity: cursorIdentity,
      eofBytes: cursor.eofBytes,
      observedAt: cursor.observedAt,
    },
    status: {
      taskId: source.statusValues?.taskId as string,
      hostId: source.statusValues?.hostId as string,
      sequence: statusSequence,
      mainProcessKey: key,
    },
  };
}

export function parseBaselineStartupContent(
  raw: string
): ParsedBaselineContent | null {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const concrete = parseConcreteBaselineJson(trimmed);
    if (concrete) return concrete.parsed;
  }

  let resumeIndex: number | null = null;
  let targetCount: number | null = null;
  let targetMeaning: string | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const parts = line.split(/[:=]/);
    if (parts.length < 2) continue;
    const key = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(":").trim();
    if (key === "resume_checkpoint_index" ||
        key === "resumecheckpointindex" ||
        key === "resume_step") {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) resumeIndex = parsed;
    } else if (key === "total_steps" ||
               key === "target" ||
               key === "targetcount" ||
               key === "target_count") {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) targetCount = parsed;
    } else if (key === "target_meaning" || key === "meaning") {
      targetMeaning = value.toLowerCase();
    }
  }
  if (resumeIndex === null || targetMeaning === null) return null;
  return { resumeCheckpointIndex: resumeIndex, targetCount, targetMeaning };
}
