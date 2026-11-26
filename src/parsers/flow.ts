import type { FlowDerivationResult, FlowParams, ParsedTrainingRecord } from './types';

export function flow(params: FlowParams): FlowDerivationResult {
  const { b, T, n } = params;

  if (!Number.isInteger(b) || !Number.isInteger(T) || !Number.isInteger(n)) {
    throw new Error('Flow parameters (b, T, n) must be integers');
  }

  if (b < 0) {
    throw new Error('Flow resumeCheckpointIndex b must be non-negative');
  }

  const f = b + 1;
  const sessionTargetCount = T - f;

  if (sessionTargetCount <= 0) {
    throw new Error(`Flow target T (${T}) must be strictly greater than firstLoopIndex f (${f})`);
  }

  if (n < 0 || n > sessionTargetCount) {
    throw new Error(
      `Flow session completed count n (${n}) is out of bounds: must be between 0 and sessionTargetCount (${sessionTargetCount})`
    );
  }

  const completedCount = f + n;
  const lastStepIndex = n > 0 ? f + n - 1 : null;
  const globalFraction = completedCount / T;
  const sessionFraction = sessionTargetCount > 0 ? n / sessionTargetCount : 0;

  return {
    firstLoopIndex: f,
    lastStepIndex,
    global: {
      completedCount,
      targetCount: T,
      fraction: globalFraction,
      unit: 'completed_iterations',
      verified: true,
    },
    session: {
      completedCount: n,
      targetCount: sessionTargetCount,
      fraction: sessionFraction,
      unit: 'completed_iterations',
      verified: true,
    },
  };
}

export function parseFlowRecord(text: string, sourceId: string = ''): ParsedTrainingRecord {
  if (!text || text.length > 4096) {
    return {
      algorithm: 'flow',
      sessionCompletedCount: null,
      sessionTargetCount: null,
      rate: null,
      rawText: text || '',
      sourceId,
      isTrainingOutput: false,
    };
  }

  // Bounded tqdm training format: completed/target [elapsed<remaining, rate]
  const match = text.match(/(?:^|\s|\|)(\d+)\s*\/\s*(\d+)\s*\[\s*(?:\d+:)?\d+:\d+<(?:\d+:)?\d+:\d+/);
  if (!match) {
    return {
      algorithm: 'flow',
      sessionCompletedCount: null,
      sessionTargetCount: null,
      rate: null,
      rawText: text,
      sourceId,
      isTrainingOutput: false,
    };
  }

  const completed = parseInt(match[1], 10);
  const target = parseInt(match[2], 10);
  if (!Number.isFinite(completed) || !Number.isFinite(target) || completed < 0 || target <= 0) {
    return {
      algorithm: 'flow',
      sessionCompletedCount: null,
      sessionTargetCount: null,
      rate: null,
      rawText: text,
      sourceId,
      isTrainingOutput: false,
    };
  }

  let rate: number | null = null;
  const rateMatch = text.match(/([\d.]+)\s*(?:it\/s|iterations\/s)/i);
  if (rateMatch) {
    rate = parseFloat(rateMatch[1]);
  } else {
    const secMatch = text.match(/([\d.]+)\s*s\/it/i);
    if (secMatch) {
      const sec = parseFloat(secMatch[1]);
      if (sec > 0) rate = 1 / sec;
    }
  }

  return {
    algorithm: 'flow',
    sessionCompletedCount: completed,
    sessionTargetCount: target,
    rate: rate !== null && Number.isFinite(rate) ? rate : null,
    rawText: text,
    sourceId,
    isTrainingOutput: true,
  };
}
