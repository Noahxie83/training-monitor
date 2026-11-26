import type { ParsedTrainingRecord } from './types';
import { stripAnsi } from './ansi';

export function parseReflowRecord(text: string, sourceId: string = ''): ParsedTrainingRecord {
  const clean = stripAnsi(text || '');
  if (!clean || clean.length > 4096) {
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
  const match = clean.match(/(?:^|\s)(?:reflow\s+(?:step|iter):\s*|\[reflow\]\s*(?:step|iter)\s*)(\d+)/i);
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
  const validStep = Number.isFinite(step) ? step : null;
  const scalars: Record<string, number> = {};
  const lossMatch = clean.match(/\bloss\s*[:=]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i);
  if (lossMatch) {
    const val = Number(lossMatch[1]);
    if (Number.isFinite(val)) scalars.loss = val;
  }

  return {
    algorithm: 'reflow',
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
