import type { ParsedTrainingRecord } from './types';

export function parseScoreRecord(text: string, sourceId: string = ''): ParsedTrainingRecord {
  if (!text || text.length > 4096) {
    return {
      algorithm: 'score',
      sessionCompletedCount: null,
      sessionTargetCount: null,
      rate: null,
      rawText: text || '',
      sourceId,
      isTrainingOutput: false,
    };
  }

  // Score algorithm specific training pattern, e.g. "step: 1000", "step: 1000, loss: 0.123", "[score] step 1000"
  const match = text.match(/(?:^|\s)(?:(?:score\s+)?step:\s*|\[score\]\s*step\s*)(\d+)/i);
  if (!match) {
    return {
      algorithm: 'score',
      sessionCompletedCount: null,
      sessionTargetCount: null,
      rate: null,
      rawText: text,
      sourceId,
      isTrainingOutput: false,
    };
  }

  const step = parseInt(match[1], 10);

  return {
    algorithm: 'score',
    sessionCompletedCount: null,
    sessionTargetCount: null,
    rate: null,
    rawText: text,
    sourceId,
    isTrainingOutput: true,
    stepIndex: Number.isFinite(step) ? step : null,
  };
}
