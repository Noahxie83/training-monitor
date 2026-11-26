import type { Freshness, LogEvent, ProcessKey, Progress, RunBinding, TaskRegistration } from "../shared/contracts";
import { flow, parseFlowRecord } from "../parsers/flow";
import { parseScoreRecord } from "../parsers/score";
import { parseReflowRecord } from "../parsers/reflow";
import { parseGenericRecord } from '../parsers/generic';
import { parseRegisteredRecord } from '../parsers/registered';
import { taskParser, type ParserKind } from '../shared/task-profile';
import { areProcessKeysEqual } from "./identity";
import { isValidDecimalBytes, parseIsoMs, isTimestampValid } from "./bindings";
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
  writerProcessKey: ProcessKey;
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
  currentRun: { runId: string; mainProcessKey: ProcessKey } | null;
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
      !canonical.activeMainKey || !areProcessKeysEqual(canonical.activeMainKey, input.currentRun.mainProcessKey)) {
    return createEmptyProgress(input.observedAt, input.freshness, input.configuredTarget ?? null);
  }
  if (input.bindingState) {
    const baselineRead = input.bindingState.baselineRead;
    const validatedBaselineRead = baselineRead
      ? validateStructuredBaselineRead(baselineRead, {
          task: input.bindingState.registeredTask,
          taskId: input.taskId,
          hostId: input.hostId,
          currentRun: input.currentRun,
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
      if (!poll) continue;
      const parsed = parseFlowRecord(record.text, record.sourceId);
      if (!parsed.isTrainingOutput || parsed.sessionCompletedCount === null) continue;
      canonicalRateSamples.push({
        observedAt: poll.observedAt, completedCount: parsed.sessionCompletedCount, runId: poll.runId,
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
      // No read-journal API currently supplies raw structured baseline content;
      // caller-authored baseline/config DTOs therefore cannot grant global counts.
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

  // Parser selection comes from the registered task policy. A caller-selected
  // algorithm is display/input metadata only and cannot choose parser semantics.
  const registration = input.taskRegistration;
  const registeredPolicyValid = !!registration &&
    registration.enabled === true &&
    registration.taskId === input.taskId &&
    registration.hostId === input.hostId &&
    Array.isArray(registration.sources) &&
    registration.sources.every((source) => !!source && typeof source.sourceId === "string" && typeof source.kind === "string") &&
    taskParser(registration) !== 'unknown';
  const algorithm = registeredPolicyValid ? taskParser(registration) : 'unknown';

  // If no confirmed main process, return empty progress
  if (!currentRun || !currentRun.runId) {
    return createEmptyProgress(observedAt, freshness, configuredTarget);
  }

  const runId = currentRun.runId;
  const revokedSet = new Set(revokedBindingIds.filter((bindingId): bindingId is string => typeof bindingId === "string"));

  // Filter bindings not revoked
  const validBindings = bindings.filter((b) => {
    if (!b || typeof b !== "object") return false;
    if (b.runId !== runId) return false;
    if (revokedSet.has(b.bindingId)) return false;
    if (!currentRun?.mainProcessKey || !areProcessKeysEqual(b.mainProcessKey, currentRun.mainProcessKey)) return false;
    if (!isValidDecimalBytes(b.fromOffset) || !isValidDecimalBytes(b.throughOffset)) return false;
    if (BigInt(b.fromOffset) >= BigInt(b.throughOffset)) return false;
    return true;
  });
  const validBindingsMap = new Map(validBindings.map((b) => [b.bindingId, b]));
  const validBindingIds = new Set(validBindings.map((b) => b.bindingId));

  // Filter bound events belonging to current run and valid bindings, with valid decimal offsets within binding interval
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
    const start = BigInt(e.startOffset);
    const end = BigInt(e.endOffset);
    if (start >= end) continue;
    if ((e.kind !== "line" && e.kind !== "redraw") || e.recordComplete !== true || e.prefixIncomplete === true || !e.text || e.text.includes("\r")) continue;
    const bFrom = BigInt(b.fromOffset);
    const bThrough = BigInt(b.throughOffset);
    if (start < bFrom || end > bThrough) continue;

    // Ordinary diagnostic/result lines do not supersede the last verified
    // progress record in the same bound writer window.
    if (!parseRegisteredRecord(registration!, e.text, e.sourceId).isTrainingOutput) continue;
    filteredEvents.push(e);
  }

  // Historical same-run records remain visible, but only support in the
  // currently open observation window can make progress fresh.
  const currentEvents = filteredEvents.filter((event) => {
    const binding = validBindingsMap.get(event.bindingId!);
    return !!binding && (input.currentWindows ?? []).some((window) =>
      window.isOpen && window.runId === event.runId &&
      window.taskId === input.taskId &&
      window.sourceId === event.sourceId &&
      window.generation === event.generation &&
      window.observerEpoch === binding.observerEpoch
    );
  });
  if (filteredEvents.length === 0) return createEmptyProgress(observedAt, freshness, configuredTarget);

  // Byte offsets can only be ordered within one source generation. Refuse to
  // synthesize a single progress cursor from incomparable streams.
  const streams = new Set(filteredEvents.map((event) => `${event.sourceId}\u0000${event.generation}`));
  if (streams.size !== 1) return createEmptyProgress(observedAt, freshness, configuredTarget);

  // Deterministically sort events by offset ascending
  filteredEvents.sort((a, b) => {
    const aStart = BigInt(a.startOffset!);
    const bStart = BigInt(b.startOffset!);
    if (aStart < bStart) return -1;
    if (aStart > bStart) return 1;
    const aEnd = BigInt(a.endOffset!);
    const bEnd = BigInt(b.endOffset!);
    if (aEnd < bEnd) return -1;
    if (aEnd > bEnd) return 1;
    return 0;
  });

  const latestEvent = filteredEvents[filteredEvents.length - 1];
  const currentLatestEvent = currentEvents[currentEvents.length - 1] ?? null;
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

  if (algorithm === "flow") {
    const parsed = parseFlowRecord(rawText, latestEvent.sourceId);
    sessionCompletedCount = parsed.sessionCompletedCount;
    sessionTargetCount = parsed.sessionTargetCount;
    sessionVerified = parsed.isTrainingOutput && sessionCompletedCount !== null;
    sessionFraction =
      sessionTargetCount && sessionCompletedCount !== null
        ? sessionCompletedCount / sessionTargetCount
        : null;

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
            currentRun,
            observedAt,
          })
        : null;
      if (canonicalReadValid !== null) hasValidBaseline = true;
      if (bTimeValid && bKeyValid && bTaskValid && bHostValid && bIndexValid && raw && registeredSource && sourceObservation && taskSource && rangeValid && contentMatchesRange && identityValid) {
        const parsed = parseBaselineStartupContent(raw);
        if (parsed && parsed.resumeCheckpointIndex === baselineEvidence.resumeCheckpointIndex && parsed.targetMeaning === "exclusive_index" && parsed.targetCount === configuredTarget?.value && configuredTarget?.meaning === parsed.targetMeaning) {
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
    const parsed = parseGenericRecord(rawText, latestEvent.sourceId);
    lastStepIndex = parsed.stepIndex ?? null;
    sessionCompletedCount = parsed.sessionCompletedCount;
    sessionTargetCount = parsed.sessionTargetCount;
    sessionVerified = parsed.isTrainingOutput && sessionCompletedCount !== null && sessionTargetCount !== null;
    sessionFraction = sessionVerified ? sessionCompletedCount! / sessionTargetCount! : null;
  } else if (algorithm === "score" || algorithm === "reflow") {
    // Score/Reflow v1: session counts and ratios null, unknown unit
    sessionCompletedCount = null;
    sessionTargetCount = null;
    sessionFraction = null;
    sessionVerified = false;
  }

  // Rate and ETA derivation: requires flow algorithm, fresh progress, matching non-empty windowId, valid bindings, advancing counts, fresh within TTL
  let iterationsPerSecond: number | null = null;
  let etaSeconds: number | null = null;

  if (algorithm === "flow" && progressFreshness === "fresh" && Array.isArray(rateSamples) && rateSamples.length >= 2 && Array.isArray(input.rateObservations) && Array.isArray(input.windows)) {
    const obsTime = parseIsoMs(observedAt);
    const validSamples = rateSamples.filter((s) => {
      if (!s || typeof s !== "object" || typeof s.completedCount !== "number" || !Number.isFinite(s.completedCount)) return false;
      if (s.runId !== runId) return false;
      if (!s.windowId || !input.windows?.some((w) => !!w && w.windowId === s.windowId && w.isOpen && w.runId === runId && w.taskId === input.taskId && w.sourceId === s.sourceId && w.generation === s.generation && w.activeBindingId === s.bindingId && areProcessKeysEqual(w.mainProcessKey, currentRun.mainProcessKey))) return false;
      if (!s.bindingId || typeof s.bindingId !== "string") return false;
      if (!validBindingsMap.has(s.bindingId)) return false;
      if (!s.sourceId || typeof s.sourceId !== "string") return false;
      if (!s.generation || typeof s.generation !== "string") return false;
      if (!isValidDecimalBytes(s.startOffset) || !isValidDecimalBytes(s.endOffset)) return false;
      const b = validBindingsMap.get(s.bindingId)!;
      if (b.sourceId !== s.sourceId || b.generation !== s.generation) return false;
      const sStart = BigInt(s.startOffset);
      const sEnd = BigInt(s.endOffset);
      if (sStart >= sEnd) return false;
      const bFrom = BigInt(b.fromOffset);
      const bThrough = BigInt(b.throughOffset);
      if (sStart < bFrom || sEnd > bThrough) return false;
      if (!isTimestampValid(s.observedAt, obsTime, 30_000)) return false;
      const event = filteredEvents.find((e) => e.eventId === s.eventId && e.bindingId === s.bindingId && e.sourceId === s.sourceId && e.generation === s.generation && e.startOffset === s.startOffset && e.endOffset === s.endOffset);
      if (!event || !event.recordComplete || (event.kind !== "line" && event.kind !== "redraw") || event.prefixIncomplete || !event.text || event.text.includes("\r") || event.ingestedAt !== s.observedAt) return false;
      const measurement = (input.rateObservations ?? []).find((m) => !!m && !!m.fileIdentity && typeof m.fileIdentity.dev === "string" && typeof m.fileIdentity.inode === "string" && m.eventId === event.eventId && m.sourceId === event.sourceId && m.generation === event.generation && m.observedAt === event.ingestedAt && m.fileIdentity.dev === input.windows?.find((w) => !!w && w.windowId === s.windowId)?.fileIdentity?.dev && m.fileIdentity.inode === input.windows?.find((w) => !!w && w.windowId === s.windowId)?.fileIdentity?.inode && isValidDecimalBytes(event.endOffset) && isValidDecimalBytes(m.eofBytes) && isValidDecimalBytes(m.writerEofBytes) && BigInt(event.endOffset) <= BigInt(m.eofBytes) && m.eofBytes === m.writerEofBytes && areProcessKeysEqual(m.writerProcessKey, currentRun.mainProcessKey));
      if (!measurement) return false;
      const record = parseFlowRecord(event.text, event.sourceId);
      if (!record.isTrainingOutput || record.sessionCompletedCount !== s.completedCount) return false;
      return true;
    });

    validSamples.sort((a, b) => {
      const ta = parseIsoMs(a.observedAt) ?? 0;
      const tb = parseIsoMs(b.observedAt) ?? 0;
      if (ta !== tb) return ta - tb;
      const sa = BigInt(a.startOffset ?? 0);
      const sb = BigInt(b.startOffset ?? 0);
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return 0;
    });

    if (validSamples.length >= 2) {
      const prev = validSamples[validSamples.length - 2];
      const last = validSamples[validSamples.length - 1];

      const sameWindow = prev.windowId === last.windowId;
      const sameBinding = prev.bindingId === last.bindingId;
      const sameSource = prev.sourceId === last.sourceId;
      const sameGen = prev.generation === last.generation;
      const previousMeasurement = input.rateObservations?.find((m) => m.eventId === prev.eventId);
      const latestMeasurement = input.rateObservations?.find((m) => m.eventId === last.eventId);
      const eofProgression = !!previousMeasurement && !!latestMeasurement &&
        isValidDecimalBytes(previousMeasurement.eofBytes) && isValidDecimalBytes(latestMeasurement.eofBytes) &&
        BigInt(latestMeasurement.eofBytes) > BigInt(previousMeasurement.eofBytes);

      if (sameWindow && sameBinding && sameSource && sameGen && eofProgression) {
        const t1 = parseIsoMs(prev.observedAt)!;
        const t2 = parseIsoMs(last.observedAt)!;
        const dt = (t2 - t1) / 1000;
        const dn = last.completedCount - prev.completedCount;

        const offsetProgressionValid =
          BigInt(last.startOffset!) >= BigInt(prev.startOffset!) &&
          BigInt(last.endOffset!) > BigInt(prev.endOffset!);

        if (dt > 0 && dt <= 30 && dn > 0 && offsetProgressionValid) {
          iterationsPerSecond = dn / dt;
          if (configuredTarget && configuredTarget.meaning === "exclusive_index" && globalTargetCount !== null && globalCompletedCount !== null && globalVerified) {
            const remaining = globalTargetCount - globalCompletedCount;
            if (remaining > 0) {
              etaSeconds = Math.round(remaining / iterationsPerSecond);
            } else {
              etaSeconds = 0;
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
  const sessionUnit = (algorithm === 'flow' || algorithm === 'generic') && sessionVerified ? 'completed_iterations' : 'unknown';

  return {
    observedAt: (currentLatestEvent ?? latestEvent).ingestedAt,
    freshness: progressFreshness,
    runId,
    lastStepIndex,
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
    session: {
      completedCount: sessionCompletedCount,
      targetCount: sessionTargetCount,
      fraction: sessionFraction,
      unit: sessionUnit,
      verified: sessionVerified,
      sourceId: latestEvent.sourceId,
    },
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
    runId: null,
    lastStepIndex: null,
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
