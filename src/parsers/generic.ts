import type { ParsedTrainingRecord } from './types';

/** Recognize explicit training records without assuming a framework or resume offset. */
export function parseGenericRecord(text: string, sourceId = ''): ParsedTrainingRecord {
  const result: ParsedTrainingRecord = { algorithm: 'generic', sessionCompletedCount: null,
    sessionTargetCount: null, rate: null, rawText: text || '', sourceId, isTrainingOutput: false, stepIndex: null };
  if (!text || text.length > 4096 || /[\r\n]/.test(text.trim())) return result;
  if (/\b(?:heartbeat|health|queued|waiting|checkpoint|resume|startup|config|eval|evaluation|validation|testing)\b|\[val\]/i.test(text)) return result;

  const safeStep = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (text.trim().startsWith('{')) {
    try {
      const record = JSON.parse(text);
      if (!record || typeof record !== 'object' || Array.isArray(record)) return result;
      if (['eval', 'evaluation', 'validation', 'test', 'heartbeat', 'health'].includes(record.mode ?? record.phase ?? record.event)) return result;
      const training = record.mode === 'train' || record.phase === 'train' || record.phase === 'training' ||
        ['loss', 'train_loss', 'training_loss'].some(key => typeof record[key] === 'number' && Number.isFinite(record[key]));
      const step = safeStep(record.global_step ?? record.step ?? record.iteration);
      return training && step !== null ? { ...result, isTrainingOutput: true, stepIndex: step } : result;
    } catch { return result; }
  }

  // tqdm reports completed iterations directly; labelled step indices do not.
  const bar = text.match(/(?:^|[\s|])([0-9]+)\s*\/\s*([0-9]+)\s*\[[^\]\r\n]*\b(?:[0-9.]+\s*it\/s|[0-9.]+\s*s\/it)[^\]\r\n]*\]/i);
  if (bar) {
    const completed = safeStep(Number(bar[1]));
    const total = safeStep(Number(bar[2]));
    if (completed !== null && total !== null && total > 0 && completed <= total) {
      return { ...result, isTrainingOutput: true, sessionCompletedCount: completed, sessionTargetCount: total };
    }
  }
  const training = /\b(?:train|training|train_loss|training_loss)\b/i.test(text) ||
    /\b(?:loss|grad_norm)\s*[:=]\s*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?\b/i.test(text);
  const match = text.match(/(?:^|[\s[,{])(?:global_step|step|iteration|iter)\s*[:= ]\s*([0-9]+)(?=$|[\s,;/}\]])/i);
  const step = match ? safeStep(Number(match[1])) : null;
  return training && step !== null ? { ...result, isTrainingOutput: true, stepIndex: step } : result;
}
