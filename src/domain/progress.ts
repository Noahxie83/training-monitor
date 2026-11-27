import type { Freshness, LogEvent, ProcessKey, Progress, ProgressUnit, RunBinding, TaskRegistration } from "../shared/contracts";
import { flow, parseFlowRecord } from "../parsers/flow";
import { parseScoreRecord } from "../parsers/score";
import { parseReflowRecord } from "../parsers/reflow";
import { parseGenericRecord } from '../parsers/generic';
import { parseRegisteredRecord } from '../parsers/registered';
import { taskParser, type ParserKind } from '../shared/task-profile';
import { areProcessKeysEqual } from "./identity";
import { isValidDecimalBytes, parseIsoMs, isTimestampValid, sameBindingProcess } from "./bindings";
import type { ActiveWriterWindow } from "./bindings";
import type { BindingState } from "./bindings";
import type { TaskObservation } from "../transport/types";
import {
  parseBaselineStartupContent,
  validateStructuredBaselineRead,
  type ParsedBaselineContent,
} from "./baseline";

export { parseBaselineStartupContent, validateStructuredBaselineRead };
export type { ParsedBaselineContent };

const DEFAULT_RATE_WINDOW_SECONDS = 30 * 60; // 30 minutes sliding window for slow-step workloads

export interface FlowBaselineEvidence {
  evidenceId: string;
  taskId?: string;
  hostId?: string;
  runId: string;
  mainProcessKey?: ProcessKey;
  sourceId?: string;
  generation?: string;
  fileIdentity?: { dev: string; inode: string } | null;
  observedAt?: string;
  startOffset?: string;
  endOffset?: string;
  resumeCheckpointIndex: number | null;
  rawContent?: string;
  extractedSemantics?: {
    loopIndex?: number;
    stepIndex?: number;
    count?: number;
  };
  provenance?: {
    sourceKind?: "status_json" | "config" | "log";
    contentHash?: string;
    rawRecord?: string;
    profile?: "flow_v1";
  };
  source?: "verified_config_startup" | "status_record";
  kind?: "verified_config_startup" | "instance_linked_status";
  profile?: "flow_v1";
  verified?: boolean;
}

export interface ProgressRateSample {
  observedAt: string;
  completedCount: number;
  runId: string;
  windowId?: string;
  bindingId?: string;
  sourceId?: string;
  generation?: string;
  startOffset?: string;
  endOffset?: string;
  eventId?: string;
}

export interface RateObservation {
  eventId: string;
  sourceId: string;
  generation: string;
  fileIdentity: { dev: string; inode: string };
  eofBytes: string;
  observedAt: string;
  writerProcessKey: ProcessKey | null;
  writerEofBytes: string;
}

export interface BaselineSourceObservation {
  sourceId: string;
  generation: string;
  fileIdentity: { dev: string; inode: string };
  eofBytes: string;
  observedAt: string;
}

export interface ProgressEvidence {
  taskId: string;
  hostId: string;
  observedAt: string;
  freshness: Freshness;
  algorithm: ParserKind;
  currentRun: { runId: string; mainProcessKey: ProcessKey | null } | null;
  bindings: RunBinding[];
  taskRegistration?: TaskRegistration;
  sourceObservations?: BaselineSourceObservation[];
  taskObservation?: TaskObservation;
  windows?: ActiveWriterWindow[];
  rateObservations?: RateObservation[];
  revokedBindingIds?: string[];
  boundEvents?: LogEvent[];
  baselineEvidence?: FlowBaselineEvidence | null;
  configuredTarget?: { value: number; meaning: "exclusive_index" | "count" | "unknown" } | null;
  rateSamples?: ProgressRateSample[];
  /** Current-open windows retained separately from read-only historical context. */
  currentWindows?: ActiveWriterWindow[];
  /** Single canonical domain journal. When present it overrides caller DTO arrays. */
  bindingState?: BindingState;
  /** Configurable sliding window upper bound in seconds (defaults to 1800s / 30m). */
  rateWindowSeconds?: number;
}

function numericProgressOf(
  task: TaskRegistration,
  text: string,
  sourceId: string,
): { value: number; total: number | null; unit: ProgressUnit } | null {
  const parsed = parseRegisteredRecord(task, text, sourceId);
  if (!parsed.isTrainingOutput) return null;
  const val = parsed.sessionCompletedCount ?? parsed.current ?? parsed.stepIndex ?? null;
  if (val === null || !Number.isFinite(val)) return null;
  const total = parsed.sessionTargetCount ?? parsed.total ?? null;
  return {
    value: val,
    total: total !== null && Number.isFinite(total) && total > 0 ? total : null,
    unit: parsed.unit ?? (parsed.sessionCompletedCount !== null ? "step" : "unknown"),
  };
}

export function deriveProgress(input: ProgressEvidence): Progress {
  if (!input.bindingState) {
    return createEmptyProgress(input.observedAt, input.freshness, input.configuredTarget ?? null);
  }
  const canonical = input.bindingState as BindingState;
  if (!Array.isArray(canonical.bindings) || !Array.isArray(canonical.revokedBindingIds) ||
      !Array.isArray(canonical.windows) || (canonical.polls !== undefined && !Array.isArray(canonical.polls)) ||
      (canonical.completeRecords !== undefined && !Array.isArray(canonical.completeRecords)) ||
      !canonical.registeredTask || typeof canonical.registeredTask !== "object") {
    return createEmptyProgress(input.observedAt, input.freshness, input.configuredTarget ?? null);
  }
  if (canonical.taskId !== input.taskId || canonical.registeredTask.taskId !== input.taskId || canonical.registeredTask.hostId !== input.hostId ||
      !canonical.registeredTask.enabled || !input.currentRun || canonical.activeRunId !== input.currentRun.runId ||
      !sameBindingProcess(canonical.activeMainKey, input.currentRun.mainProcessKey) ||
      (canonical.activeMainKey === null && canonical.registeredTask.attributionMode !== "log_only")) {
    return createEmptyProgress(input.observedAt, input.freshness, input.configuredTarget ?? null);
  }

  const rateWindowSeconds =
    typeof input.rateWindowSeconds === "number" && Number.isFinite(input.rateWindowSeconds) && input.rateWindowSeconds > 0
      ? Math.min(86400, input.rateWindowSeconds)
      : DEFAULT_RATE_WINDOW_SECONDS;

  {
    const baselineRead = input.bindingState.baselineRead;
    const validatedBaselineRead = baselineRead && input.currentRun.mainProcessKey
      ? validateStructuredBaselineRead(baselineRead, {
          task: input.bindingState.registeredTask,
          taskId: input.taskId,
          hostId: input.hostId,
          currentRun: { ...input.currentRun, mainProcessKey: input.currentRun.mainProcessKey },
          observedAt: input.observedAt,
        })
      : null;
    const canonicalRecords = input.bindingState.completeRecords ?? [];
    const polls = input.bindingState.polls ?? [];
    const canonicalRateSamples: ProgressRateSample[] = [];
    const canonicalRateObservations: RateObservation[] = [];
    for (const record of canonicalRecords) {
      if (record === null || typeof record !== "object") continue;
      if (!record.runId || !record.bindingId || !record.text || !record.recordComplete || record.prefixIncomplete ||
          (record.kind !== "line" && record.kind !== "redraw")) continue;
      const recordBinding = input.bindingState.bindings.find((candidate) =>
        candidate !== null && typeof candidate === "object" &&
        candidate.bindingId === record.bindingId &&
        candidate.runId === record.runId &&
        candidate.sourceId === record.sourceId &&
        candidate.generation === record.generation);
      if (!recordBinding) continue;
      const window = input.bindingState.windows.find((candidate) =>
        candidate !== null && typeof candidate === "object" && candidate.windowId &&
        candidate.activeBindingId === record.bindingId &&
        candidate.observerEpoch === recordBinding.observerEpoch &&
        candidate.sourceId === record.sourceId && candidate.generation === record.generation && candidate.runId === record.runId);
      if (!window) continue;
      const matchingPolls = polls.filter((candidate) =>
        candidate !== null && typeof candidate === "object" &&
        candidate.fileIdentity !== null && typeof candidate.fileIdentity === "object" &&
        candidate.windowId === window.windowId &&
        isValidDecimalBytes(candidate.eofBytes) && isValidDecimalBytes(record.endOffset) &&
        BigInt(candidate.eofBytes) >= BigInt(record.endOffset)
      );
      const exactPoll = matchingPolls.find((candidate) =>
        candidate.observedAt === record.ingestedAt
      );
      const poll = exactPoll ?? matchingPolls
        .filter((candidate) =>
          (parseIsoMs(candidate.observedAt) ?? Number.NEGATIVE_INFINITY) >=
          (parseIsoMs(record.ingestedAt) ?? Number.POSITIVE_INFINITY)
        )
        .sort((left, right) =>
          (parseIsoMs(left.observedAt) ?? 0) - (parseIsoMs(right.observedAt) ?? 0)
        )[0];
      if (!poll || !input.bindingState.registeredTask) continue;
      const numeric = numericProgressOf(input.bindingState.registeredTask, record.text, record.sourceId);
      if (!numeric) continue;
      canonicalRateSamples.push({
        observedAt: poll.observedAt, completedCount: numeric.value, runId: poll.runId,
        windowId: poll.windowId, bindingId: record.bindingId, sourceId: record.sourceId,
        generation: record.generation, startOffset: record.startOffset ?? undefined,
        endOffset: record.endOffset ?? undefined, eventId: record.eventId,
      });
      canonicalRateObservations.push({
        eventId: record.eventId, sourceId: poll.sourceId, generation: poll.generation,
        fileIdentity: poll.fileIdentity, eofBytes: poll.eofBytes, observedAt: poll.observedAt,
        writerProcessKey: poll.mainProcessKey, writerEofBytes: poll.eofBytes,
      });
    }
    const currentWindows = input.bindingState.windows.filter((window) =>
      window !== null && typeof window === "object" && window.isOpen === true &&
      typeof window.observerEpoch === "string" && window.observerEpoch.length > 0
    );
    input = {
      ...input,
      taskRegistration: input.bindingState.registeredTask ?? undefined,
      bindings: input.bindingState.bindings,
      revokedBindingIds: input.bindingState.revokedBindingIds,
      boundEvents: canonicalRecords,
      windows: input.bindingState.windows,
      rateSamples: canonicalRateSamples,
      rateObservations: canonicalRateObservations,
      baselineEvidence: validatedBaselineRead ? {
        evidenceId: validatedBaselineRead.evidenceId,
        taskId: validatedBaselineRead.taskId,
        hostId: validatedBaselineRead.hostId,
        runId: validatedBaselineRead.runId,
        mainProcessKey: validatedBaselineRead.mainProcessKey,
        sourceId: validatedBaselineRead.sourceId,
        generation: validatedBaselineRead.generation,
        fileIdentity: validatedBaselineRead.fileIdentity,
        observedAt: validatedBaselineRead.observedAt,
        startOffset: validatedBaselineRead.startOffset,
        endOffset: validatedBaselineRead.endOffset,
        resumeCheckpointIndex: validatedBaselineRead.resumeCheckpointIndex,
        rawContent: validatedBaselineRead.rawContent,
      } : null,
      configuredTarget: validatedBaselineRead
        ? { value: validatedBaselineRead.targetCount, meaning: "exclusive_index" }
        : null,
      currentWindows,
    };
  }

  const {
    observedAt,
    freshness,
    currentRun,
    bindings,
    revokedBindingIds = [],
    boundEvents = [],
    baselineEvidence,
    configuredTarget = null,
    rateSamples = [],
  } = input;

  if (!Array.isArray(bindings) || !Array.isArray(revokedBindingIds) || !Array.isArray(boundEvents)) {
    return createEmptyProgress(observedAt, freshness, configuredTarget);
  }

  const registration = input.taskRegistration;
  const registeredPolicyValid = !!registration &&
    registration.enabled === true &&
    registration.taskId === input.taskId &&
    registration.hostId === input.hostId &&
    Array.isArray(registration.sources) &&
    registration.sources.every((source) => !!source && typeof source.sourceId === "string" && typeof source.kind === "string") &&
    taskParser(registration) !== 'unknown';
  const algorithm = registeredPolicyValid ? taskParser(registration) : 'unknown';

  if (!currentRun || !currentRun.runId || algorithm === 'raw') {
    return createEmptyProgress(observedAt, freshness, configuredTarget);
  }

  const runId = currentRun.runId;
  const revokedSet = new Set(revokedBindingIds.filter((bindingId): bindingId is string => typeof bindingId === "string"));

  const validBindings = bindings.filter((b) => {
    if (!b || typeof b !== "object") return false;
    if (b.runId !== runId) return false;
    if (revokedSet.has(b.bindingId)) return false;
    if (!sameBindingProcess(b.mainProcessKey, currentRun.mainProcessKey)) return false;
    if (b.mainProcessKey === null && b.evidenceKind !== "log_only") return false;
    if (!isValidDecimalBytes(b.fromOffset) || !isValidDecimalBytes(b.throughOffset)) return false;
    if (BigInt(b.fromOffset) >= BigInt(b.throughOffset)) return false;
    return true;
  });
  const validBindingsMap = new Map(validBindings.map((b) => [b.bindingId, b]));

  const filteredEvents: LogEvent[] = [];
  for (const e of boundEvents) {
    if (!e || typeof e !== "object" || typeof e.text !== "string" || !e.taskId || !e.sourceId) continue;
    if (!registeredPolicyValid || !registration!.sources.some((s) => s && s.kind === "log" && s.sourceId === e.sourceId)) continue;
    if (e.runId !== runId) continue;
    if (!e.bindingId) continue;
    const b = validBindingsMap.get(e.bindingId);
    if (!b) continue;
    if (b.sourceId !== e.sourceId) continue;
    if (b.generation !== e.generation) continue;
    if (!isValidDecimalBytes(e.startOffset) || !isValidDecimalBytes(e.endOffset)) continue;
    const frameStart = e.frameStartOffset ?? e.startOffset;
    if (!isValidDecimalBytes(frameStart)) continue;
    const start = BigInt(frameStart);
    if (start < BigInt(e.startOffset)) continue;
    const end = BigInt(e.endOffset);
    if (start >= end) continue;
    if ((e.kind !== "line" && e.kind !== "redraw") || e.recordComplete !== true || e.prefixIncomplete === true || !e.text || e.text.includes("\r")) continue;
    const bFrom = BigInt(b.fromOffset);
    const bThrough = BigInt(b.throughOffset);
    if (start < bFrom || end > bThrough) continue;

    if (!parseRegisteredRecord(registration!, e.text, e.sourceId).isTrainingOutput) continue;
    filteredEvents.push(e);
  }

  if (filteredEvents.length === 0) return createEmptyProgress(observedAt, freshness, configuredTarget);

  filteredEvents.sort((a, b) => {
    if (a.sourceId !== b.sourceId || a.generation !== b.generation) {
      const time = (parseIsoMs(a.ingestedAt) ?? 0) - (parseIsoMs(b.ingestedAt) ?? 0);
      if (time !== 0) return time;
      return a.sourceId.localeCompare(b.sourceId) || a.generation.localeCompare(b.generation);
    }
    const aEnd = BigInt(a.endOffset!);
    const bEnd = BigInt(b.endOffset!);
    return aEnd < bEnd ? -1 : aEnd > bEnd ? 1 : 0;
  });

  const currentEvents = filteredEvents.filter((event) => {
    const binding = validBindingsMap.get(event.bindingId!);
    return !!binding && (input.currentWindows ?? []).some((window) =>
      window.isOpen && window.runId === event.runId &&
      window.taskId === input.taskId && window.sourceId === event.sourceId &&
      window.generation === event.generation && window.observerEpoch === binding.observerEpoch
    );
  });
  const numericEvents = filteredEvents.filter((event) => numericProgressOf(registration!, event.text!, event.sourceId));
  const latestEvent = numericEvents.filter((event) => currentEvents.includes(event)).at(-1) ??
    numericEvents.at(-1) ?? currentEvents.at(-1) ?? filteredEvents.at(-1)!;
  const currentLatestEvent = currentEvents.includes(latestEvent) ? latestEvent : null;
  const progressFreshness = currentLatestEvent ? freshness : "stale";
  const rawText = latestEvent.text || "";

  let lastStepIndex: number | null = null;
  let firstLoopIndex: number | null = null;
  let resumeCheckpointIndex: number | null = null;
  let baselineEvidenceId: string | null = null;

  let globalCompletedCount: number | null = null;
  let globalTargetCount: number | null = null;
  let globalFraction: number | null = null;
  let globalVerified = false;

  let sessionCompletedCount: number | null = null;
  let sessionTargetCount: number | null = null;
  let sessionFraction: number | null = null;
  let sessionVerified = false;

  let unit: ProgressUnit = "unknown";
  let currentValue: number | null = null;
  let totalValue: number | null = null;
  let mergedScalars: Record<string, number> = {};
  let hasRealResumeSession = false;

  // Accumulate latest scalar metrics across bound events (so train_loss and val_loss across adjacent lines both remain visible)
  for (const ev of filteredEvents.slice(-32)) {
    const parsedEv = parseRegisteredRecord(registration!, ev.text ?? "", ev.sourceId);
    if (parsedEv.scalars) {
      mergedScalars = { ...mergedScalars, ...parsedEv.scalars };
    }
  }

  const isFlow = algorithm === "flow" || algorithm === "legacy_flow";
  const isScore = algorithm === "score" || algorithm === "legacy_score";
  const isReflow = algorithm === "reflow" || algorithm === "legacy_reflow";

  if (isFlow) {
    const parsed = parseFlowRecord(rawText, latestEvent.sourceId);
    sessionCompletedCount = parsed.sessionCompletedCount;
    sessionTargetCount = parsed.sessionTargetCount;
    sessionVerified = parsed.isTrainingOutput && sessionCompletedCount !== null;
    sessionFraction =
      sessionTargetCount && sessionCompletedCount !== null
        ? sessionCompletedCount / sessionTargetCount
        : null;
    unit = "step";
    currentValue = sessionCompletedCount;
    totalValue = sessionTargetCount;

    const obsTime = parseIsoMs(observedAt);
    let hasValidBaseline = false;

    if (baselineEvidence != null && baselineEvidence.runId === runId && obsTime !== null) {
      const bTime = baselineEvidence.observedAt ? parseIsoMs(baselineEvidence.observedAt) : null;
      const bTimeValid = bTime !== null && bTime <= obsTime;
      const bKeyValid =
        baselineEvidence.mainProcessKey != null &&
        currentRun?.mainProcessKey != null &&
        areProcessKeysEqual(baselineEvidence.mainProcessKey, currentRun.mainProcessKey);
      const bTaskValid = baselineEvidence.taskId === input.taskId;
      const bHostValid = baselineEvidence.hostId === input.hostId;
      const bIndexValid =
        baselineEvidence.resumeCheckpointIndex !== null &&
        Number.isInteger(baselineEvidence.resumeCheckpointIndex) &&
        baselineEvidence.resumeCheckpointIndex >= 0;

      const raw =
        baselineEvidence.rawContent ||
        baselineEvidence.provenance?.rawRecord ||
        (typeof (baselineEvidence as any).raw === "string" ? (baselineEvidence as any).raw : null);

      const registeredSources = Array.isArray(input.taskRegistration?.sources) ? input.taskRegistration.sources : [];
      const registeredSource = input.taskRegistration?.taskId === input.taskId && input.taskRegistration.hostId === input.hostId && input.taskRegistration.enabled && registeredSources.some((s) => !!s && s.sourceId === baselineEvidence.sourceId && s.kind === "status_json");
      const sourceObservation = Array.isArray(input.sourceObservations) ? input.sourceObservations.find((s) => !!s && !!s.fileIdentity && typeof s.fileIdentity.dev === "string" && typeof s.fileIdentity.inode === "string" && s.sourceId === baselineEvidence.sourceId && s.generation === baselineEvidence.generation && s.fileIdentity.dev === baselineEvidence.fileIdentity?.dev && s.fileIdentity.inode === baselineEvidence.fileIdentity?.inode && s.observedAt === baselineEvidence.observedAt && isValidDecimalBytes(s.eofBytes) && isValidDecimalBytes(baselineEvidence.endOffset) && BigInt(baselineEvidence.endOffset) <= BigInt(s.eofBytes)) : undefined;
      const taskSources = Array.isArray(input.taskObservation?.sources) ? input.taskObservation!.sources : [];
      const taskSource = taskSources.find((s) => !!s && s.sourceId === baselineEvidence.sourceId && s.observedAt === baselineEvidence.observedAt && s.fileIdentity?.dev === baselineEvidence.fileIdentity?.dev && s.fileIdentity?.inode === baselineEvidence.fileIdentity?.inode && s.eofBytes === sourceObservation?.eofBytes && s.permission === "readable" && s.exists === true && s.evidenceComplete === true);
      const rangeValid = isValidDecimalBytes(baselineEvidence.startOffset) && isValidDecimalBytes(baselineEvidence.endOffset) && BigInt(baselineEvidence.startOffset) < BigInt(baselineEvidence.endOffset);
      const contentMatchesRange = !!raw && isValidDecimalBytes(baselineEvidence.startOffset) && isValidDecimalBytes(baselineEvidence.endOffset) && rangeValid && BigInt(new TextEncoder().encode(raw).length) === BigInt(baselineEvidence.endOffset) - BigInt(baselineEvidence.startOffset);
      const identityValid = !!baselineEvidence.fileIdentity?.dev && !!baselineEvidence.fileIdentity?.inode && !!baselineEvidence.generation;
      const canonicalRead = input.bindingState?.baselineRead;
      const canonicalReadValid = canonicalRead
        ? validateStructuredBaselineRead(canonicalRead, {
            task: input.bindingState?.registeredTask,
            taskId: input.taskId,
            hostId: input.hostId,
            currentRun: currentRun.mainProcessKey ? { ...currentRun, mainProcessKey: currentRun.mainProcessKey } : null,
            observedAt,
          })
        : null;
      if (canonicalReadValid !== null) hasValidBaseline = true;
      if (bTimeValid && bKeyValid && bTaskValid && bHostValid && bIndexValid && raw && registeredSource && sourceObservation && taskSource && rangeValid && contentMatchesRange && identityValid) {
        const parsedBaseline = parseBaselineStartupContent(raw);
        if (parsedBaseline && parsedBaseline.resumeCheckpointIndex === baselineEvidence.resumeCheckpointIndex && parsedBaseline.targetMeaning === "exclusive_index" && parsedBaseline.targetCount === configuredTarget?.value && configuredTarget?.meaning === parsedBaseline.targetMeaning) {
          hasValidBaseline = true;
        }
      }
    }

    const hasValidTarget =
      configuredTarget != null &&
      configuredTarget.meaning === "exclusive_index" &&
      Number.isInteger(configuredTarget.value) &&
      configuredTarget.value > 0;

    if (hasValidBaseline && baselineEvidence != null && baselineEvidence.resumeCheckpointIndex !== null && hasValidTarget && configuredTarget != null && sessionCompletedCount !== null) {
      const b = baselineEvidence.resumeCheckpointIndex;
      const T = configuredTarget.value;

      try {
        const derived = flow({ b, T, n: sessionCompletedCount });
        firstLoopIndex = derived.firstLoopIndex;
        lastStepIndex = derived.lastStepIndex;
        resumeCheckpointIndex = b;
        baselineEvidenceId = baselineEvidence.evidenceId;
        globalCompletedCount = derived.global.completedCount;
        globalTargetCount = derived.global.targetCount;
        globalFraction = derived.global.fraction;
        globalVerified = true;
        currentValue = globalCompletedCount;
        totalValue = globalTargetCount;
        hasRealResumeSession = true;
      } catch {
        firstLoopIndex = null;
        lastStepIndex = null;
        resumeCheckpointIndex = null;
        baselineEvidenceId = null;
        globalCompletedCount = null;
        globalTargetCount = null;
        globalFraction = null;
        globalVerified = false;
      }
    }
  } else if (algorithm === 'generic') {
    const parsed = parseGenericRecord(rawText, latestEvent.sourceId, registration?.customPatterns);
    lastStepIndex = parsed.stepIndex ?? null;
    sessionCompletedCount = parsed.sessionCompletedCount;
    sessionTargetCount = parsed.sessionTargetCount;
    sessionVerified = parsed.isTrainingOutput && sessionCompletedCount !== null && sessionTargetCount !== null;
    sessionFraction = sessionVerified ? sessionCompletedCount! / sessionTargetCount! : null;
    unit = parsed.unit ?? (sessionVerified ? 'step' : 'unknown');
    currentValue = parsed.current ?? parsed.sessionCompletedCount ?? parsed.stepIndex ?? null;
    totalValue = parsed.total ?? parsed.sessionTargetCount ?? null;
  } else if (isScore || isReflow) {
    const parsed = isScore
      ? parseScoreRecord(rawText, latestEvent.sourceId)
      : parseReflowRecord(rawText, latestEvent.sourceId);
    lastStepIndex = parsed.stepIndex ?? null;
    unit = "step";
    currentValue = parsed.stepIndex ?? null;
    totalValue = null;
    sessionCompletedCount = null;
    sessionTargetCount = null;
    sessionFraction = null;
    sessionVerified = false;
  }

  // Sliding-window rate & ETA across ALL monotonic parsers (flow, generic, score, reflow)
  // with configurable window ceiling up to 30m (removing the old 30s cap) and supporting log rotations.
  let iterationsPerSecond: number | null = null;
  let etaSeconds: number | null = null;

  if (progressFreshness === "fresh" && Array.isArray(rateSamples) && rateSamples.length >= 2 && Array.isArray(input.rateObservations) && Array.isArray(input.windows)) {
    const obsTime = parseIsoMs(observedAt);
    const windowTtlMs = rateWindowSeconds * 1000;
    const validSamples = rateSamples.filter((s) => {
      if (!s || typeof s !== "object" || typeof s.completedCount !== "number" || !Number.isFinite(s.completedCount)) return false;
      if (s.runId !== runId || s.sourceId !== latestEvent.sourceId) return false;
      if (!s.bindingId || typeof s.bindingId !== "string" || !validBindingsMap.has(s.bindingId)) return false;
      if (!s.sourceId || typeof s.sourceId !== "string" || !s.generation || typeof s.generation !== "string") return false;
      if (!isValidDecimalBytes(s.startOffset) || !isValidDecimalBytes(s.endOffset)) return false;
      const b = validBindingsMap.get(s.bindingId)!;
      if (b.sourceId !== s.sourceId || b.generation !== s.generation) return false;
      const sStart = BigInt(s.startOffset);
      const sEnd = BigInt(s.endOffset);
      if (sStart >= sEnd) return false;
      const bFrom = BigInt(b.fromOffset);
      const bThrough = BigInt(b.throughOffset);
      if (sEnd > bThrough) return false;
      if (!isTimestampValid(s.observedAt, obsTime, windowTtlMs)) return false;
      const event = filteredEvents.find((e) => e.eventId === s.eventId && e.bindingId === s.bindingId && e.sourceId === s.sourceId && e.generation === s.generation && e.startOffset === s.startOffset && e.endOffset === s.endOffset);
      if (!event || !event.recordComplete || (event.kind !== "line" && event.kind !== "redraw") || event.prefixIncomplete || !event.text || event.text.includes("\r") || event.ingestedAt !== s.observedAt) return false;
      if (BigInt(event.frameStartOffset ?? s.startOffset) < bFrom) return false;
      const win = input.windows?.find((w) => !!w && w.windowId === s.windowId && w.runId === runId && w.taskId === input.taskId && w.sourceId === s.sourceId && w.generation === s.generation && w.activeBindingId === s.bindingId && sameBindingProcess(w.mainProcessKey, currentRun.mainProcessKey));
      if (!win) return false;
      // For legacy flow, enforce strict open-window identity check on the newest sample
      const measurement = (input.rateObservations ?? []).find((m) => !!m && !!m.fileIdentity && typeof m.fileIdentity.dev === "string" && typeof m.fileIdentity.inode === "string" && m.eventId === event.eventId && m.sourceId === event.sourceId && m.generation === event.generation && m.observedAt === event.ingestedAt && m.fileIdentity.dev === win.fileIdentity?.dev && m.fileIdentity.inode === win.fileIdentity?.inode && isValidDecimalBytes(event.endOffset) && isValidDecimalBytes(m.eofBytes) && isValidDecimalBytes(m.writerEofBytes) && BigInt(event.endOffset) <= BigInt(m.eofBytes) && m.eofBytes === m.writerEofBytes && sameBindingProcess(m.writerProcessKey, currentRun.mainProcessKey));
      if (!measurement) return false;
      const numeric = numericProgressOf(registration!, event.text, event.sourceId);
      if (!numeric || numeric.value !== s.completedCount) return false;
      return true;
    });

    validSamples.sort((a, b) => {
      const ta = parseIsoMs(a.observedAt) ?? 0;
      const tb = parseIsoMs(b.observedAt) ?? 0;
      if (ta !== tb) return ta - tb;
      if (a.generation === b.generation) {
        const sa = BigInt(a.startOffset ?? 0);
        const sb = BigInt(b.startOffset ?? 0);
        if (sa < sb) return -1;
        if (sa > sb) return 1;
      }
      return 0;
    });

    if (validSamples.length >= 2) {
      const last = validSamples[validSamples.length - 1]!;
      const lastTime = parseIsoMs(last.observedAt)!;
      // Pick the earliest sample within the sliding window that has strictly lower progress
      // (for 2 samples this naturally uses validSamples[0] vs validSamples[1], preserving exact Flow math).
      const lastWin = input.windows?.find((w) => w.windowId === last.windowId);
      const lastIsOpen = Boolean(lastWin?.isOpen);

      if (lastIsOpen) {
        let anchor: ProgressRateSample | null = null;
        // Prefer same-window sample pair first when available; fall back to cross-rotation same-source pair.
        const sameWindowCandidates = validSamples.slice(0, -1).filter((s) =>
          s.windowId === last.windowId &&
          s.bindingId === last.bindingId &&
          s.sourceId === last.sourceId &&
          s.generation === last.generation
        );
        const crossRotationCandidates = validSamples.slice(0, -1).filter((s) =>
          s.sourceId === last.sourceId && s.generation !== last.generation
        );

        const latestMeasurement = input.rateObservations?.find((m) => m.eventId === last.eventId && m.observedAt === last.observedAt);

        if (sameWindowCandidates.length > 0 && latestMeasurement && isValidDecimalBytes(latestMeasurement.eofBytes)) {
          // Use the oldest sample within sliding window if >2 samples, or previous sample if 2 samples.
          const candidatePool = sameWindowCandidates.filter((prev) => {
            const t1 = parseIsoMs(prev.observedAt)!;
            const dt = (lastTime - t1) / 1000;
            const prevMeasurement = input.rateObservations?.find((m) => m.eventId === prev.eventId && m.observedAt === prev.observedAt);
            const eofProg = !!prevMeasurement && isValidDecimalBytes(prevMeasurement.eofBytes) &&
              BigInt(latestMeasurement.eofBytes) > BigInt(prevMeasurement.eofBytes);
            const offsetProg = BigInt(last.startOffset!) >= BigInt(prev.startOffset!) &&
              BigInt(last.endOffset!) > BigInt(prev.endOffset!);
            return dt > 0 && dt <= rateWindowSeconds && last.completedCount > prev.completedCount && eofProg && offsetProg;
          });
          // For flow with <= 2 samples, candidatePool[0] === validSamples[len-2].
          // Using the oldest valid anchor in a sliding window (capped at last 10 samples) smooths jitter!
          if (candidatePool.length > 0) {
            anchor = candidatePool[Math.max(0, candidatePool.length - 10)]!;
          }
        } else if (crossRotationCandidates.length > 0) {
          // Cross-log-rotation continuity: monotonic step progression across sealed -> new generation
          const candidatePool = crossRotationCandidates.filter((prev) => {
            const t1 = parseIsoMs(prev.observedAt)!;
            const dt = (lastTime - t1) / 1000;
            return dt > 0 && dt <= rateWindowSeconds && last.completedCount > prev.completedCount;
          });
          if (candidatePool.length > 0) {
            anchor = candidatePool[candidatePool.length - 1]!;
          }
        }

        if (anchor) {
          const t1 = parseIsoMs(anchor.observedAt)!;
          const dt = (lastTime - t1) / 1000;
          const dn = last.completedCount - anchor.completedCount;
          if (dt > 0 && dt <= rateWindowSeconds && dn > 0) {
            iterationsPerSecond = dn / dt;
            if (isFlow) {
              if (configuredTarget && configuredTarget.meaning === "exclusive_index" && globalTargetCount !== null && globalCompletedCount !== null && globalVerified) {
                const remaining = globalTargetCount - globalCompletedCount;
                etaSeconds = remaining > 0 ? Math.round(remaining / iterationsPerSecond) : 0;
              }
            } else if (totalValue !== null && currentValue !== null && totalValue >= currentValue) {
              const remaining = totalValue - currentValue;
              etaSeconds = remaining > 0 ? Math.round(remaining / iterationsPerSecond) : 0;
            }
          }
        }
      }
    }
  }

  const activeBindingIds = Array.from(
    new Set(filteredEvents.map((e) => e.bindingId).filter((id): id is string => Boolean(id)))
  );

  const globalUnit = globalVerified ? "completed_iterations" : "unknown";
  const sessionUnit = (isFlow || algorithm === 'generic') && sessionVerified ? 'completed_iterations' : 'unknown';

  const sessionTrack = {
    completedCount: sessionCompletedCount,
    targetCount: sessionTargetCount,
    fraction: sessionFraction,
    unit: sessionUnit as "completed_iterations" | "unknown",
    verified: sessionVerified,
    sourceId: latestEvent.sourceId,
  };

  return {
    observedAt: (currentLatestEvent ?? latestEvent).ingestedAt,
    freshness: progressFreshness,
    progressFreshness,
    runId,
    lastStepIndex,
    unit,
    current: currentValue,
    total: totalValue,
    ...(Object.keys(mergedScalars).length > 0 ? { scalars: mergedScalars } : {}),
    ...(hasRealResumeSession ? { resumedSession: sessionTrack } : {}),
    bindingIds: activeBindingIds,
    baselineEvidenceId,
    resumeCheckpointIndex,
    firstLoopIndex,
    global: {
      completedCount: globalCompletedCount,
      targetCount: globalTargetCount,
      fraction: globalFraction,
      unit: globalUnit,
      verified: globalVerified,
      sourceId: latestEvent.sourceId,
    },
    session: sessionTrack,
    configuredTarget,
    iterationsPerSecond,
    etaSeconds,
  };
}

export function createEmptyProgress(
  observedAt: string,
  freshness: Freshness,
  configuredTarget: Progress["configuredTarget"]
): Progress {
  return {
    observedAt,
    freshness,
    progressFreshness: freshness,
    runId: null,
    lastStepIndex: null,
    unit: "unknown",
    current: null,
    total: null,
    bindingIds: [],
    baselineEvidenceId: null,
    resumeCheckpointIndex: null,
    firstLoopIndex: null,
    global: {
      completedCount: null,
      targetCount: null,
      fraction: null,
      unit: "unknown",
      verified: false,
      sourceId: null,
    },
    session: {
      completedCount: null,
      targetCount: null,
      fraction: null,
      unit: "unknown",
      verified: false,
      sourceId: null,
    },
    configuredTarget,
    iterationsPerSecond: null,
    etaSeconds: null,
  };
}
