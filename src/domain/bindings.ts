import type { Bytes, LogEvent, ProcessKey, RunBinding, TaskRegistration } from "../shared/contracts";
import type { TaskObservation, TaskProcessObservation } from "../transport/types";
import { areProcessKeysEqual, isRegisteredProcessEntry, isStrongProcessKey, makeRunId } from "./identity";
import { parseRegisteredRecord } from '../parsers/registered';
import { taskParser, type ParserKind } from '../shared/task-profile';
import { validateStructuredBaselineRead } from "./baseline";

export interface ActiveWriterWindow {
  windowId: string;
  openingId: string;
  taskId: string;
  sourceId: string;
  generation: string;
  observerEpoch: string;
  fromOffset: Bytes;
  throughOffset: Bytes;
  isOpen: boolean;
  mainProcessKey: ProcessKey;
  runId: string;
  fileIdentity: { dev: string; inode: string } | null;
  algorithm?: ParserKind;
  activeBindingId?: string | null;
}

export interface BindingState {
  taskId?: string | null;
  registeredTask?: TaskRegistration | null;
  algorithm?: ParserKind;
  activeRunId: string | null;
  activeMainKey: ProcessKey | null;
  observerEpoch: string | null;
  openingSeq?: number;
  windows: ActiveWriterWindow[];
  bindings: RunBinding[];
  revokedBindingIds: string[];
  /** Bounded normalized poll history used to resolve live rate evidence. */
  polls?: BindingPoll[];
  /** Complete records affiliated by this domain path, never caller-bound DTOs. */
  completeRecords?: LogEvent[];
  baselineRead?: StructuredBaselineRead | null;
  sourceCursors?: BindingSourceCursor[];
}

export interface BindingPoll {
  taskId: string;
  runId: string;
  mainProcessKey: ProcessKey;
  windowId: string;
  openingId: string;
  sourceId: string;
  generation: string;
  observerEpoch: string;
  fileIdentity: { dev: string; inode: string };
  eofBytes: Bytes;
  /** Collection batch time associated with the committed records. */
  observedAt: string;
  /** Time of the source/process probe that supplied identity and EOF. */
  sourceObservedAt?: string;
}

export interface StructuredBaselineRead {
  evidenceId: string;
  taskId: string;
  hostId: string;
  runId: string;
  mainProcessKey: ProcessKey;
  sourceId: string;
  generation: string;
  fileIdentity: { dev: string; inode: string };
  observedAt: string;
  startOffset: Bytes;
  endOffset: Bytes;
  rawContent: string;
  resumeCheckpointIndex: number;
  targetCount: number;
  support?: BaselineReadSupport;
}

export interface BaselineReadSupport {
  version: 1;
  source: {
    sourceId: string;
    generation: string;
    fileIdentity: { dev: string; inode: string };
    eofBytes: Bytes;
    observedAt: string;
  };
  cursor: {
    sourceId: string;
    generation: string;
    fileIdentity: { dev: string; inode: string };
    eofBytes: Bytes;
    observedAt: string;
  };
  status: {
    taskId: string;
    hostId: string;
    sequence: number;
    mainProcessKey: ProcessKey;
  };
}

export interface BindingSourceCursor {
  sourceId: string;
  generation: string;
  fileIdentity: { dev: string; inode: string };
  eofBytes: Bytes;
  observedAt: string;
}

export interface BindingObservation {
  task: TaskRegistration;
  taskId: string;
  hostId: string;
  observerEpoch: string;
  observedAt: string;
  taskObservation: TaskObservation;
  sourceInfo: Record<string, { generation: string; eofBytes: Bytes; fileIdentity: { dev: string; inode: string } | null }>;
  outputSamples: Record<string, TrainerOutputObservation>;
}

export interface TrainerOutputObservation {
  sourceId: string;
  generation: string;
  fileIdentity: { dev: string; inode: string };
  startOffset: Bytes;
  endOffset: Bytes;
  /** Raw LF, CRLF, or CR bytes decoded out of the displayed record text. */
  terminatorBytes?: 0 | 1 | 2;
  observedAt: string;
  text: string;
}

type RegisteredSource = TaskRegistration["sources"][number];

function hasValidRegisteredSources(value: unknown): value is RegisteredSource[] {
  return Array.isArray(value) && value.every((source) =>
    !!source &&
    typeof source === "object" &&
    typeof source.sourceId === "string" &&
    source.sourceId.length > 0 &&
    typeof source.path === "string" &&
    source.path.length > 0 &&
    (source.kind === "log" || source.kind === "status_json" || source.kind === "queue_lock")
  );
}

export function isRuntimeTaskPolicy(value: unknown): value is TaskRegistration {
  if (!value || typeof value !== "object") return false;
  const task = value as TaskRegistration;
  return typeof task.taskId === "string" && task.taskId.length > 0 &&
    typeof task.hostId === "string" && task.hostId.length > 0 &&
    task.enabled === true &&
    typeof task.algorithm === 'string' && taskParser(task) !== 'unknown' &&
    Array.isArray(task.entryPaths) &&
    task.entryPaths.length > 0 &&
    task.entryPaths.every((path) => typeof path === "string" && path.length > 0) &&
    hasValidRegisteredSources(task.sources);
}

function findRegisteredSource(
  task: TaskRegistration,
  sourceId: string,
  kind?: RegisteredSource["kind"]
): RegisteredSource | undefined {
  if (!isRuntimeTaskPolicy(task)) return undefined;
  return task.sources.find((source) => source.sourceId === sourceId && (kind === undefined || source.kind === kind));
}

function retainedSameRun(
  state: BindingState,
  task: TaskRegistration,
  hostId: string,
  taskId: string
): { mainKey: ProcessKey; runId: string } | null {
  if (!isRuntimeTaskPolicy(task) ||
      task.taskId !== taskId || task.hostId !== hostId ||
      state.taskId !== taskId ||
      !state.registeredTask || !isRuntimeTaskPolicy(state.registeredTask) ||
      JSON.stringify(state.registeredTask) !== JSON.stringify(task) ||
      !isStrongProcessKey(state.activeMainKey) ||
      typeof state.activeRunId !== "string") {
    return null;
  }
  const runId = makeRunId(hostId, taskId, state.activeMainKey);
  if (state.activeRunId !== runId) return null;
  return { mainKey: { ...state.activeMainKey }, runId };
}

export function isValidDecimalBytes(val: unknown): val is Bytes {
  return typeof val === "string" && /^\d+$/.test(val);
}

export function parseSafeBigInt(val: unknown): bigint | null {
  if (typeof val === "string" && /^\d+$/.test(val)) {
    try {
      return BigInt(val);
    } catch {
      return null;
    }
  }
  return null;
}

export function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function isTimestampValid(
  ts: string | null | undefined,
  refTime: number | null,
  ttlMs: number = 30000
): boolean {
  if (refTime === null || typeof refTime !== "number" || !Number.isFinite(refTime)) return false;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  const t = parseIsoMs(ts);
  if (t === null) return false;
  if (t > refTime) return false;
  if (refTime - t > ttlMs) return false;
  return true;
}

export function createInitialBindingState(): BindingState {
  return {
    taskId: null,
    algorithm: undefined,
    activeRunId: null,
    activeMainKey: null,
    observerEpoch: null,
    openingSeq: 0,
    windows: [],
    bindings: [],
    revokedBindingIds: [],
    polls: [],
    completeRecords: [],
    sourceCursors: [],
  };
}

function isRetainedBaselineRead(value: unknown): value is StructuredBaselineRead {
  if (!value || typeof value !== "object") return false;
  const baseline = value as StructuredBaselineRead;
  return typeof baseline.evidenceId === "string" && baseline.evidenceId.length > 0 &&
    typeof baseline.taskId === "string" && baseline.taskId.length > 0 &&
    typeof baseline.hostId === "string" && baseline.hostId.length > 0 &&
    typeof baseline.runId === "string" && baseline.runId.length > 0 &&
    isStrongProcessKey(baseline.mainProcessKey) &&
    typeof baseline.sourceId === "string" && baseline.sourceId.length > 0 &&
    typeof baseline.generation === "string" && baseline.generation.length > 0 &&
    !!baseline.fileIdentity && typeof baseline.fileIdentity.dev === "string" &&
    typeof baseline.fileIdentity.inode === "string" &&
    parseIsoMs(baseline.observedAt) !== null &&
    isValidDecimalBytes(baseline.startOffset) && isValidDecimalBytes(baseline.endOffset) &&
    BigInt(baseline.startOffset) < BigInt(baseline.endOffset) &&
    typeof baseline.rawContent === "string" &&
    Number.isSafeInteger(baseline.resumeCheckpointIndex) && baseline.resumeCheckpointIndex >= 0 &&
    Number.isSafeInteger(baseline.targetCount) && baseline.targetCount > 0;
}

function baselineAppliesTo(
  baseline: unknown,
  task: TaskRegistration,
  key: ProcessKey,
  observedAt: string
): baseline is StructuredBaselineRead {
  if (!isRuntimeTaskPolicy(task)) return false;
  return isRetainedBaselineRead(baseline) &&
    baseline.taskId === task.taskId && baseline.hostId === task.hostId &&
    baseline.runId === makeRunId(task.hostId, task.taskId, key) &&
    areProcessKeysEqual(baseline.mainProcessKey, key) &&
    !!findRegisteredSource(task, baseline.sourceId, "status_json") &&
    parseIsoMs(observedAt) !== null;
}

function retainBaselineRead(
  baseline: unknown,
  task: TaskRegistration,
  key: ProcessKey,
  observedAt: string
): StructuredBaselineRead | null {
  if (!baselineAppliesTo(baseline, task, key, observedAt)) return null;
  const validated = validateStructuredBaselineRead(baseline, {
    task,
    taskId: task.taskId,
    hostId: task.hostId,
    currentRun: { runId: makeRunId(task.hostId, task.taskId, key), mainProcessKey: key },
    observedAt,
  });
  // Keep a context-applicable record for compatibility and evidence display.
  // Projection independently requires the validator to grant baseline authority.
  return validated ?? {
    ...baseline,
    mainProcessKey: { ...baseline.mainProcessKey },
    fileIdentity: { ...baseline.fileIdentity },
  };
}

export function resolveTaskPolicy(
  input: BindingObservation,
  state: BindingState
): TaskRegistration | null {
  const task = input?.task;
  if (!isRuntimeTaskPolicy(task) || task.taskId !== input.taskId || task.hostId !== input.hostId) return null;
  if (state.registeredTask && JSON.stringify(state.registeredTask) !== JSON.stringify(task)) return null;
  return task;
}

export function findSubstantiveTrainerProcess(
  task: TaskRegistration,
  taskObservation: TaskObservation,
  obsTime: number | null,
  outputSamples: Record<string, TrainerOutputObservation>,
  sourceInfo: BindingObservation["sourceInfo"]
): TaskProcessObservation | null {
  if (!isRuntimeTaskPolicy(task)) return null;
  if (!taskObservation || taskObservation.taskId !== task.taskId || taskObservation.hostId !== task.hostId) return null;
  if (obsTime === null) return null;
  if (!isTimestampValid(taskObservation.observedAt, obsTime)) return null;
  if (taskObservation.freshness !== "fresh" || taskObservation.scanComplete !== true) return null;
  if (taskObservation.errorCode !== null && taskObservation.errorScope !== "source") return null;
  if (!Array.isArray(task.entryPaths) || task.entryPaths.length === 0) return null;
  if (taskParser(task) === 'unknown') return null;

  const procs = taskObservation.processes || [];
  const candidates = procs.filter((proc) => {
    if (!isStrongProcessKey(proc.key)) return false;
    if (proc.roleEvidence !== "exact_entry_and_direct_writer_fd") return false;
    if (!isRegisteredProcessEntry(task, proc)) return false;
    if (proc.writerEvidenceComplete !== true || proc.evidenceComplete !== true) return false;
    if (!Array.isArray(proc.directWriterSourceIds) || proc.directWriterSourceIds.length === 0) return false;
    if (!isTimestampValid(proc.observedAt, obsTime)) return false;

    const hasValidWitness = proc.directWriterSourceIds.some((sid) => {
      const regSource = findRegisteredSource(task, sid);
      if (!regSource || regSource.kind !== "log") return false;

      const src = (taskObservation.sources || []).find((s) => s.sourceId === sid);
      if (
        !src ||
        src.permission !== "readable" ||
        src.exists !== true ||
        src.evidenceComplete !== true ||
        !isValidDecimalBytes(src.eofBytes) ||
        !src.fileIdentity ||
        !src.fileIdentity.dev ||
        !src.fileIdentity.inode ||
        !isTimestampValid(src.observedAt, obsTime)
      ) {
        return false;
      }

      const witness = proc.writerSourceEvidence?.[sid];
      if (
        !witness ||
        !witness.fileIdentity ||
        witness.fileIdentity.dev !== src.fileIdentity.dev ||
        witness.fileIdentity.inode !== src.fileIdentity.inode ||
        witness.eofBytes !== src.eofBytes
      ) {
        return false;
      }

      {
        const sample = outputSamples?.[sid];
        const observedSource = src;
        const sourceState = sourceInfo?.[sid];
        if (!sample || sample.sourceId !== sid || !observedSource.fileIdentity || !sourceState || !sample.generation || sample.generation !== sourceState.generation) return false;
        if (sourceState.eofBytes !== observedSource.eofBytes || sourceState.fileIdentity?.dev !== observedSource.fileIdentity.dev || sourceState.fileIdentity?.inode !== observedSource.fileIdentity.inode) return false;
        if (sample.fileIdentity.dev !== observedSource.fileIdentity.dev || sample.fileIdentity.inode !== observedSource.fileIdentity.inode) return false;
        if (sample.observedAt !== observedSource.observedAt || !isTimestampValid(sample.observedAt, obsTime)) return false;
        if (!isValidDecimalBytes(sample.startOffset) || !isValidDecimalBytes(sample.endOffset) || BigInt(sample.startOffset) >= BigInt(sample.endOffset) || BigInt(sample.endOffset) > BigInt(sourceState.eofBytes) || BigInt(sample.endOffset) > BigInt(observedSource.eofBytes)) return false;
        const text = sample.text;
        if (typeof text !== "string" || text.length === 0 || text.length > 65536) return false;
        const terminatorBytes = sample.terminatorBytes ?? 0;
        if (!Number.isInteger(terminatorBytes) || terminatorBytes < 0 || terminatorBytes > 2) return false;
        if (BigInt(new TextEncoder().encode(text).length) + BigInt(terminatorBytes) !==
            BigInt(sample.endOffset) - BigInt(sample.startOffset)) return false;
        if (!parseRegisteredRecord(task, text, sid).isTrainingOutput) return false;
      }

      return true;
    });

    return hasValidWitness;
  });

  return candidates.length === 1 ? candidates[0] : null;
}

export function updateBindings(state: BindingState, input: BindingObservation): BindingState {
  const { taskId, hostId, observerEpoch, observedAt, taskObservation, sourceInfo } = input;
  const task = resolveTaskPolicy(input, state);
  const retainedBindings = Array.isArray(state.bindings)
    ? state.bindings.filter((binding) => binding !== null && typeof binding === "object")
    : [];
  const retainedWindows = Array.isArray(state.windows)
    ? state.windows.filter((window) => window !== null && typeof window === "object")
    : [];
  const retainedRevokedBindingIds = Array.isArray(state.revokedBindingIds)
    ? state.revokedBindingIds.filter((bindingId): bindingId is string => typeof bindingId === "string")
    : [];
  const retainedPolls = Array.isArray(state.polls) ? state.polls : [];
  const retainedCompleteRecords = Array.isArray(state.completeRecords) ? state.completeRecords : [];
  const retainedSourceCursors = Array.isArray(state.sourceCursors) ? state.sourceCursors : [];
  const historicalRun = task ? retainedSameRun(state, task, hostId, taskId) : null;
  const previouslyConfirmedKey = historicalRun?.mainKey ?? null;
  if (!task || !input.outputSamples || typeof input.outputSamples !== "object") {
    return { ...state, activeRunId: null, activeMainKey: null, observerEpoch: null,
      windows: retainedWindows.map((w) => ({ ...w, isOpen: false })),
      bindings: retainedBindings,
      revokedBindingIds: retainedRevokedBindingIds,
      polls: retainedPolls,
      completeRecords: retainedCompleteRecords,
      sourceCursors: retainedSourceCursors,
      baselineRead: null };
  }

  const nextWindows = retainedWindows.map((w) => ({ ...w }));
  const nextBindings = retainedBindings.map((b) => ({ ...b }));
  const revoked = [...retainedRevokedBindingIds];
  const obsTime = parseIsoMs(observedAt);
  const taskTimeValid = isTimestampValid(taskObservation.observedAt, obsTime);

  // Preconditions on input
  if (
    !observerEpoch ||
    observerEpoch.trim() === "" ||
    !taskTimeValid ||
    taskObservation.freshness !== "fresh" ||
    taskObservation.scanComplete !== true ||
    (taskObservation.errorCode !== null && taskObservation.errorScope !== "source")
  ) {
    for (const w of nextWindows) {
      w.isOpen = false;
    }
    return {
      taskId,
      registeredTask: task,
      algorithm: taskParser(task),
      activeRunId: historicalRun?.runId ?? null,
      activeMainKey: previouslyConfirmedKey,
      observerEpoch: null,
      openingSeq: state.openingSeq ?? 0,
      windows: nextWindows,
      bindings: nextBindings,
      revokedBindingIds: revoked,
      polls: retainedPolls,
      completeRecords: retainedCompleteRecords,
      sourceCursors: retainedSourceCursors,
      baselineRead: previouslyConfirmedKey
        ? retainBaselineRead(state.baselineRead, task, previouslyConfirmedKey, observedAt)
        : null,
    };
  }

  // Detect mixed-writer contradictions among candidate processes on registered sources
  const writersPerSource = new Map<string, ProcessKey[]>();
  for (const proc of taskObservation.processes || []) {
    if (Array.isArray(proc.directWriterSourceIds)) {
      for (const sid of proc.directWriterSourceIds) {
        const list = writersPerSource.get(sid) ?? [];
        // stdout and stderr can both point to the same log. Count distinct
        // process instances rather than duplicate descriptors from one writer.
        if (!list.some((key) => areProcessKeysEqual(key, proc.key))) list.push(proc.key);
        writersPerSource.set(sid, list);
      }
    }
  }
  const contradictedSources = new Set<string>();
  for (const [sid, pkeys] of writersPerSource.entries()) {
    if (pkeys.length > 1) {
      contradictedSources.add(sid);
    }
  }
  if (contradictedSources.size > 0) {
    for (const w of nextWindows) {
      if (contradictedSources.has(w.sourceId) && w.isOpen) {
        w.isOpen = false;
        if (w.activeBindingId && !revoked.includes(w.activeBindingId)) {
          revoked.push(w.activeBindingId);
        }
        for (const b of nextBindings) {
          if (
            b.sourceId === w.sourceId &&
            b.runId === w.runId &&
            b.generation === w.generation &&
            b.fromOffset === w.fromOffset &&
            !revoked.includes(b.bindingId)
          ) {
            revoked.push(b.bindingId);
          }
        }
      }
    }
  }

  // Find confirmed substantive trainer process
  const trainerProc = findSubstantiveTrainerProcess(task, taskObservation, obsTime, input.outputSamples, sourceInfo);

  // Multiple or zero trainer candidates cannot confirm an active run
  if (!trainerProc) {
    for (const w of nextWindows) {
      w.isOpen = false;
    }
    return {
      taskId,
      registeredTask: task,
      algorithm: taskParser(task),
      activeRunId: historicalRun?.runId ?? null,
      activeMainKey: previouslyConfirmedKey,
      observerEpoch: null,
      openingSeq: state.openingSeq ?? 0,
      windows: nextWindows,
      bindings: nextBindings,
      revokedBindingIds: revoked,
      polls: retainedPolls,
      completeRecords: retainedCompleteRecords,
      sourceCursors: retainedSourceCursors,
      baselineRead: previouslyConfirmedKey
        ? retainBaselineRead(state.baselineRead, task, previouslyConfirmedKey, observedAt)
        : null,
    };
  }

  const currentRunId = makeRunId(hostId, taskId, trainerProc.key);
  const instanceChanged = state.activeRunId !== null && state.activeRunId !== currentRunId;
  const epochChanged = state.observerEpoch !== null && state.observerEpoch !== observerEpoch;
  const taskChanged = state.taskId !== null && state.taskId !== taskId;
  const algoChanged = state.algorithm && taskParser(task) !== state.algorithm;

  if (instanceChanged || epochChanged || taskChanged || algoChanged) {
    for (const w of nextWindows) {
      w.isOpen = false;
    }
  }

  const sameRun = state.activeRunId === currentRunId && state.activeMainKey !== null &&
    areProcessKeysEqual(state.activeMainKey, trainerProc.key);
  const retainedBaselineRead = sameRun
    ? retainBaselineRead(state.baselineRead, task, trainerProc.key, observedAt)
    : null;
  if (!sameRun) {
    nextBindings.splice(0, nextBindings.length);
  }

  let nextOpeningSeq = state.openingSeq ?? 0;

  // Revalidate or close all existing open windows
  for (const w of nextWindows) {
    if (!w.isOpen) continue;

    const src = (taskObservation.sources || []).find((s) => s.sourceId === w.sourceId);
    if (!src) {
      w.isOpen = false;
      continue;
    }

    if (
      src.permission !== "readable" ||
      src.exists !== true ||
      src.eofBytes === null ||
      src.evidenceComplete !== true ||
      !src.fileIdentity ||
      !src.fileIdentity.dev ||
      !src.fileIdentity.inode ||
      !isTimestampValid(src.observedAt, obsTime)
    ) {
      w.isOpen = false;
      continue;
    }

    if (!trainerProc.directWriterSourceIds?.includes(w.sourceId)) {
      w.isOpen = false;
      continue;
    }

    const witness = trainerProc.writerSourceEvidence?.[w.sourceId];
    if (
      !witness ||
      !witness.fileIdentity ||
      witness.fileIdentity.dev !== src.fileIdentity.dev ||
      witness.fileIdentity.inode !== src.fileIdentity.inode ||
      witness.eofBytes !== src.eofBytes
    ) {
      w.isOpen = false;
      continue;
    }

    const gen = sourceInfo?.[w.sourceId]?.generation;
    if (!gen || gen !== w.generation) {
      w.isOpen = false;
      continue;
    }

    if (w.fileIdentity) {
      if (w.fileIdentity.dev !== src.fileIdentity.dev || w.fileIdentity.inode !== src.fileIdentity.inode) {
        w.isOpen = false;
        continue;
      }
    }

    const curThrough = parseSafeBigInt(w.throughOffset);
    const curFrom = parseSafeBigInt(w.fromOffset);
    const srcEof = parseSafeBigInt(src.eofBytes);
    if (curThrough === null || curFrom === null || srcEof === null) {
      w.isOpen = false;
      continue;
    }

    if (srcEof < curThrough) {
      // Truncation or rewind closes window
      w.isOpen = false;
      continue;
    }

    // Window advances to current EOF
    w.throughOffset = src.eofBytes;

    if (srcEof > curFrom) {
      const bindingId = ["binding", currentRunId, w.sourceId, w.generation, w.openingId, w.fromOffset].join(":");
      w.activeBindingId = bindingId;
      const existingIdx = nextBindings.findIndex((b) => b.bindingId === bindingId);
      const updatedBinding: RunBinding = {
        bindingId,
        runId: currentRunId,
        mainProcessKey: trainerProc.key,
        sourceId: w.sourceId,
        generation: w.generation,
        fromOffset: w.fromOffset,
        throughOffset: w.throughOffset,
        evidenceKind: "observed_direct_writer",
        observerEpoch,
        observedAt,
      };
      if (existingIdx >= 0) {
        nextBindings[existingIdx] = updatedBinding;
      } else {
        nextBindings.push(updatedBinding);
      }
    }
  }

  // Check sources to open NEW windows if not already open
  for (const src of taskObservation.sources || []) {
    const sourceId = src.sourceId;
    const info = sourceInfo?.[sourceId];
    if (!info || !info.generation || typeof info.generation !== "string" || info.generation.trim() === "") {
      continue; // No generation fallback
    }
    const gen = info.generation;
    if (!isValidDecimalBytes(src.eofBytes)) {
      continue;
    }
    if (info.fileIdentity && (!src.fileIdentity || info.fileIdentity.dev !== src.fileIdentity.dev || info.fileIdentity.inode !== src.fileIdentity.inode)) {
      continue;
    }
    if (info.eofBytes && (!isValidDecimalBytes(info.eofBytes) || info.eofBytes !== src.eofBytes)) {
      continue;
    }

    const alreadyOpen = nextWindows.some(
      (w) =>
        w.isOpen &&
        w.sourceId === sourceId &&
        w.runId === currentRunId &&
        w.observerEpoch === observerEpoch &&
        w.generation === gen
    );
    if (alreadyOpen) {
      continue;
    }

    if (contradictedSources.has(sourceId)) {
      continue;
    }
    if (!isTimestampValid(src.observedAt, obsTime)) {
      continue;
    }

    if (!trainerProc.directWriterSourceIds?.includes(sourceId)) {
      continue;
    }

    // Source must be registered with kind: "log"
    const regSource = task.sources.find((s) => s.sourceId === sourceId);
    if (!regSource || regSource.kind !== "log") {
      continue;
    }

    if (
      src.permission !== "readable" ||
      src.exists !== true ||
      src.eofBytes === null ||
      src.evidenceComplete !== true ||
      !src.fileIdentity ||
      !src.fileIdentity.dev ||
      !src.fileIdentity.inode
    ) {
      continue;
    }

    const witness = trainerProc.writerSourceEvidence?.[sourceId];
    if (
      !witness ||
      !witness.fileIdentity ||
      witness.fileIdentity.dev !== src.fileIdentity.dev ||
      witness.fileIdentity.inode !== src.fileIdentity.inode ||
      witness.eofBytes !== src.eofBytes
    ) {
      continue;
    }

    nextOpeningSeq += 1;
    const openingId = ["open", currentRunId, sourceId, observerEpoch, nextOpeningSeq].join(":");
    const windowId = ["win", currentRunId, sourceId, observerEpoch, nextOpeningSeq, src.eofBytes].join(":");
    const newWin: ActiveWriterWindow = {
      windowId,
      openingId,
      taskId,
      sourceId,
      generation: gen,
      observerEpoch,
      fromOffset: src.eofBytes,
      throughOffset: src.eofBytes,
      isOpen: true,
      mainProcessKey: trainerProc.key,
      runId: currentRunId,
      fileIdentity: { dev: src.fileIdentity.dev, inode: src.fileIdentity.inode },
      algorithm: taskParser(task),
      activeBindingId: null,
    };
    nextWindows.push(newWin);
  }

  const polls = sameRun ? [...retainedPolls] : [];
  const sourceCursors = sameRun ? [...retainedSourceCursors] : [];
  for (const observedSource of taskObservation.sources ?? []) {
    const registration = findRegisteredSource(task, observedSource.sourceId);
    const info = sourceInfo?.[observedSource.sourceId];
    if (!registration || !info || !info.generation || !observedSource.fileIdentity ||
        !isValidDecimalBytes(observedSource.eofBytes) || info.eofBytes !== observedSource.eofBytes ||
        info.fileIdentity?.dev !== observedSource.fileIdentity.dev || info.fileIdentity?.inode !== observedSource.fileIdentity.inode ||
        observedSource.permission !== "readable" || observedSource.exists !== true || observedSource.evidenceComplete !== true ||
        typeof observedSource.observedAt !== "string" ||
        !isTimestampValid(observedSource.observedAt, obsTime)) continue;
    sourceCursors.push({ sourceId: observedSource.sourceId, generation: info.generation,
      fileIdentity: { dev: observedSource.fileIdentity.dev, inode: observedSource.fileIdentity.inode },
      eofBytes: observedSource.eofBytes, observedAt: observedSource.observedAt });
  }
  for (const window of nextWindows) {
    if (!window.isOpen || window.runId !== currentRunId || window.observerEpoch !== observerEpoch) continue;
    const source = taskObservation.sources.find((candidate) => candidate.sourceId === window.sourceId);
    const writer = trainerProc.writerSourceEvidence?.[window.sourceId];
    if (!source || !writer || source.eofBytes !== writer.eofBytes ||
        !source.fileIdentity || source.fileIdentity.dev !== writer.fileIdentity?.dev || source.fileIdentity.inode !== writer.fileIdentity?.inode ||
        !isValidDecimalBytes(source.eofBytes) || !isTimestampValid(source.observedAt, obsTime)) continue;
    polls.push({
      taskId, runId: currentRunId, mainProcessKey: trainerProc.key, windowId: window.windowId,
      openingId: window.openingId, sourceId: window.sourceId, generation: window.generation,
      observerEpoch, fileIdentity: { dev: source.fileIdentity.dev, inode: source.fileIdentity.inode },
      eofBytes: source.eofBytes, observedAt, sourceObservedAt: source.observedAt ?? undefined,
    });
  }

  return {
    taskId,
    registeredTask: task,
    algorithm: taskParser(task),
    activeRunId: currentRunId,
    activeMainKey: trainerProc.key,
    observerEpoch,
    openingSeq: nextOpeningSeq,
    windows: nextWindows,
    bindings: nextBindings,
    revokedBindingIds: revoked,
    polls: polls.slice(-256),
    completeRecords: sameRun ? retainedCompleteRecords : [],
    sourceCursors: sourceCursors.slice(-512),
    baselineRead: retainedBaselineRead,
  };
}

export function bindCompleteRecord(event: LogEvent, state: BindingState): LogEvent {
  if (event.recordComplete !== true || event.prefixIncomplete === true) {
    return { ...event, runId: null, bindingId: null };
  }

  if (event.startOffset === null || event.endOffset === null) {
    return { ...event, runId: null, bindingId: null };
  }

  const evStart = parseSafeBigInt(event.startOffset);
  const evEnd = parseSafeBigInt(event.endOffset);
  if (evStart === null || evEnd === null || evStart >= evEnd) {
    return { ...event, runId: null, bindingId: null };
  }

  if (!state.activeRunId || !state.activeMainKey || !state.observerEpoch) {
    return { ...event, runId: null, bindingId: null };
  }

  if (state.taskId && event.taskId !== state.taskId) {
    return { ...event, runId: null, bindingId: null };
  }

  // Active open window must exist for this event's source, gen, run, epoch
  const windows = Array.isArray(state.windows) ? state.windows : [];
  const bindings = Array.isArray(state.bindings) ? state.bindings : [];
  const revokedBindingIds = Array.isArray(state.revokedBindingIds) ? state.revokedBindingIds : [];
  const candidateWindows = windows.filter(
    (w) =>
      w !== null && typeof w === "object" &&
      w.isOpen &&
      w.sourceId === event.sourceId &&
      w.generation === event.generation &&
      w.runId === state.activeRunId &&
      w.observerEpoch === state.observerEpoch &&
      (!w.taskId || !state.taskId || w.taskId === state.taskId) &&
      (!event.taskId || !w.taskId || w.taskId === event.taskId)
  );

  if (candidateWindows.length !== 1) {
    return { ...event, runId: null, bindingId: null };
  }

  const activeWin = candidateWindows[0];

  const wFrom = parseSafeBigInt(activeWin.fromOffset);
  const wThrough = parseSafeBigInt(activeWin.throughOffset);
  if (wFrom === null || wThrough === null || evStart < wFrom || evEnd > wThrough) {
    return { ...event, runId: null, bindingId: null };
  }

  // Enforce semantic algorithm parsing: ordinary text or health text cannot pass
  if (!event.text || event.text.trim().length === 0) {
    return { ...event, runId: null, bindingId: null };
  }

  const registeredTask = state.registeredTask;
  if (!isRuntimeTaskPolicy(registeredTask) || registeredTask.taskId !== event.taskId || registeredTask.hostId === "" ||
      taskParser(registeredTask) === 'unknown' ||
      !findRegisteredSource(registeredTask, event.sourceId, "log")) {
    return { ...event, runId: null, bindingId: null };
  }
  const isTrainingOutput = parseRegisteredRecord(registeredTask, event.text, event.sourceId).isTrainingOutput;

  if (!isTrainingOutput) {
    return { ...event, runId: null, bindingId: null };
  }

  // Find matching binding within the verified bounds of activeRunId
  const matchingBindings = bindings.filter((b) => {
    if (b === null || typeof b !== "object") return false;
    if (activeWin.activeBindingId && b.bindingId !== activeWin.activeBindingId) return false;
    if (revokedBindingIds.includes(b.bindingId)) return false;
    if (b.sourceId !== event.sourceId || b.generation !== event.generation) return false;
    if (b.runId !== state.activeRunId || !areProcessKeysEqual(b.mainProcessKey, state.activeMainKey)) return false;
    if (b.observerEpoch !== state.observerEpoch) return false;
    if (b.fromOffset !== activeWin.fromOffset) return false;
    const bFrom = parseSafeBigInt(b.fromOffset);
    const bThrough = parseSafeBigInt(b.throughOffset);
    if (bFrom === null || bThrough === null || bFrom >= bThrough) return false;
    return evStart >= bFrom && evEnd <= bThrough;
  });

  if (matchingBindings.length !== 1) {
    return { ...event, runId: null, bindingId: null };
  }

  const matchingBinding = matchingBindings[0];

  return {
    ...event,
    runId: matchingBinding.runId,
    bindingId: matchingBinding.bindingId,
  };
}

/** Affiliate and retain one normalized decoder record in the canonical binding context. */
export function ingestCompleteRecord(event: LogEvent, state: BindingState): { state: BindingState; event: LogEvent } {
  const affiliated = bindCompleteRecord(event, state);
  if (!affiliated.runId || !affiliated.bindingId) return { state, event: affiliated };
  const windows = Array.isArray(state.windows) ? state.windows : [];
  const polls = Array.isArray(state.polls) ? state.polls : [];
  const records = Array.isArray(state.completeRecords) ? state.completeRecords : [];
  const window = windows.find((candidate) => candidate !== null && typeof candidate === "object" && candidate.isOpen && candidate.sourceId === affiliated.sourceId && candidate.generation === affiliated.generation && candidate.runId === affiliated.runId);
  const matchingPolls = polls.filter((candidate) =>
    candidate !== null && typeof candidate === "object" &&
    candidate.windowId === window?.windowId && candidate.observedAt === affiliated.ingestedAt &&
    isValidDecimalBytes(affiliated.endOffset) && isValidDecimalBytes(candidate.eofBytes) && BigInt(candidate.eofBytes) >= BigInt(affiliated.endOffset)
  );
  const poll = matchingPolls[matchingPolls.length - 1];
  if (!poll) return { state, event: { ...affiliated, runId: null, bindingId: null } };
  const next = [...records.filter((record) => record !== null && typeof record === "object" && record.eventId !== affiliated.eventId), affiliated].slice(-512);
  return { state: { ...state, completeRecords: next }, event: affiliated };
}

/** End the current continuous observation without inventing a replacement session. */
export function interruptBindingObservation(state: BindingState): BindingState {
  const windows = Array.isArray(state.windows) ? state.windows : [];
  const bindings = Array.isArray(state.bindings) ? state.bindings : [];
  const revokedBindingIds = Array.isArray(state.revokedBindingIds) ? state.revokedBindingIds : [];
  const polls = Array.isArray(state.polls) ? state.polls : [];
  const completeRecords = Array.isArray(state.completeRecords) ? state.completeRecords : [];
  const sourceCursors = Array.isArray(state.sourceCursors) ? state.sourceCursors : [];
  return {
    ...state,
    activeRunId: typeof state.activeRunId === "string" ? state.activeRunId : null,
    activeMainKey: isStrongProcessKey(state.activeMainKey) ? { ...state.activeMainKey } : null,
    observerEpoch: null,
    windows: windows
      .filter((window) => window !== null && typeof window === "object")
      .map((window) => ({ ...window, isOpen: false })),
    bindings: bindings.filter((binding) => binding !== null && typeof binding === "object"),
    revokedBindingIds: revokedBindingIds.filter((bindingId): bindingId is string => typeof bindingId === "string"),
    polls,
    completeRecords,
    sourceCursors,
  };
}

export function revokeBindings(state: BindingState, bindingIds: string[]): BindingState {
  const revoked = new Set([...state.revokedBindingIds, ...bindingIds]);
  const nextWindows = state.windows.map((w) => {
    if (w.activeBindingId && revoked.has(w.activeBindingId)) {
      return { ...w, isOpen: false };
    }
    return { ...w };
  });

  return {
    ...state,
    windows: nextWindows,
    revokedBindingIds: Array.from(revoked),
  };
}
