import type { ParsedTrainingRecord } from './types';
import { stripAnsi } from './ansi';

export function parseScoreRecord(text: string, sourceId: string = ''): ParsedTrainingRecord {
  const clean = stripAnsi(text || '');
  if (!clean || clean.length > 4096) {
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
  const match = clean.match(/(?:^|\s)(?:(?:score\s+)?step:\s*|\[score\]\s*step\s*)(\d+)/i);
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
  const validStep = Number.isFinite(step) ? step : null;
  const scalars: Record<string, number> = {};
  const lossMatch = clean.match(/\bloss\s*[:=]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i);
  if (lossMatch) {
    const val = Number(lossMatch[1]);
    if (Number.isFinite(val)) scalars.loss = val;
  }

  return {
    algorithm: 'score',
    sessionCompletedCount: null,
    sessionTargetCount: null,
    rate: null,
    rawText: text,
    sourceId,
    isTrainingOutput: true,
    stepIndex: validStep,
    unit: 'step',
    current: validStep,
    total: null,
    ...(Object.keys(scalars).length ? { scalars } : {}),
  };
}
