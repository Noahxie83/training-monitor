import type { ParsedTrainingRecord } from './types';

export function parseReflowRecord(text: string, sourceId: string = ''): ParsedTrainingRecord {
  if (!text || text.length > 4096) {
    return {
      algorithm: 'reflow',
      sessionCompletedCount: null,
      sessionTargetCount: null,
      rate: null,
      rawText: text || '',
      sourceId,
      isTrainingOutput: false,
    };
  }

  // Reflow algorithm specific training pattern, e.g. "reflow step: 1000", "[reflow] iter: 1000"
  const match = text.match(/(?:^|\s)(?:reflow\s+(?:step|iter):\s*|\[reflow\]\s*(?:step|iter)\s*)(\d+)/i);
  if (!match) {
    return {
      algorithm: 'reflow',
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
    algorithm: 'reflow',
    sessionCompletedCount: null,
    sessionTargetCount: null,
    rate: null,
    rawText: text,
    sourceId,
    isTrainingOutput: true,
    stepIndex: Number.isFinite(step) ? step : null,
  };
}
