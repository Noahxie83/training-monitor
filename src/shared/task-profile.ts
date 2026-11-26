import type { LogFormat, TaskRegistration } from './contracts';

export type CanonicalLogFormat = 'generic' | 'legacy_flow' | 'legacy_score' | 'legacy_reflow' | 'raw';
export type ParserKind = CanonicalLogFormat | 'flow' | 'score' | 'reflow' | 'unknown';

const legacyNames: Record<string, string> = {
  flow: 'Flow Matching',
  legacy_flow: 'Flow Matching',
  score: 'Score-based',
  legacy_score: 'Score-based',
  reflow: 'Reflow',
  legacy_reflow: 'Reflow',
  unknown: '',
};

const VALID_LOG_FORMATS = new Set<string>([
  'generic',
  'legacy_flow',
  'legacy_score',
  'legacy_reflow',
  'flow',
  'score',
  'reflow',
  'raw',
]);

export function normalizeLogFormat(format: string): CanonicalLogFormat | null {
  switch (format) {
    case 'generic': return 'generic';
    case 'flow':
    case 'legacy_flow': return 'legacy_flow';
    case 'score':
    case 'legacy_score': return 'legacy_score';
    case 'reflow':
    case 'legacy_reflow': return 'legacy_reflow';
    case 'raw': return 'raw';
    default: return null;
  }
}

/** Only legacy registrations infer a parser from their old enum field. */
export function taskLogFormat(task: Pick<TaskRegistration, 'algorithm' | 'logFormat'>): CanonicalLogFormat {
  if (!task || typeof task.algorithm !== 'string' || task.algorithm.length > 120 || /[\u0000-\u001f\u007f]/.test(task.algorithm)) {
    return 'raw';
  }
  if (task.logFormat !== undefined) {
    return normalizeLogFormat(task.logFormat) ?? 'raw';
  }
  const legacy = normalizeLogFormat(task.algorithm);
  if (legacy === 'legacy_flow' || legacy === 'legacy_score' || legacy === 'legacy_reflow') {
    return legacy;
  }
  return task.algorithm === 'unknown' ? 'raw' : 'generic';
}

export function taskParser(task: Pick<TaskRegistration, 'algorithm' | 'logFormat'>): ParserKind {
  if (!task || typeof task.algorithm !== 'string' || task.algorithm.length > 120 || /[\u0000-\u001f\u007f]/.test(task.algorithm)) {
    return 'unknown';
  }
  if (task.logFormat !== undefined) {
    if (typeof task.logFormat !== 'string' || !VALID_LOG_FORMATS.has(task.logFormat)) {
      return 'unknown';
    }
    return taskLogFormat(task);
  }
  if (task.algorithm === 'unknown') return 'unknown';
  return taskLogFormat(task);
}

export function taskAlgorithmName(task: Pick<TaskRegistration, 'algorithm' | 'logFormat'>): string {
  return task.logFormat === undefined && Object.hasOwn(legacyNames, task.algorithm)
    ? legacyNames[task.algorithm]! : task.algorithm;
}
