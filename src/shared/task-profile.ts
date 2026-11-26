import type { LogFormat, TaskRegistration } from './contracts';

export type ParserKind = 'generic' | 'flow' | 'score' | 'reflow' | 'unknown';
const legacyNames: Record<string, string> = { flow: 'Flow Matching', score: 'Score-based', reflow: 'Reflow', unknown: '' };

/** Only legacy registrations infer a parser from their old enum field. */
export function taskLogFormat(task: Pick<TaskRegistration, 'algorithm' | 'logFormat'>): LogFormat {
  if (!task || typeof task.algorithm !== 'string' || task.algorithm.length > 120 || /[\u0000-\u001f\u007f]/.test(task.algorithm)) return 'raw';
  if (task.logFormat !== undefined) return ['generic', 'flow', 'score', 'reflow', 'raw'].includes(task.logFormat) ? task.logFormat : 'raw';
  if (['flow', 'score', 'reflow'].includes(task.algorithm)) return task.algorithm as LogFormat;
  return task.algorithm === 'unknown' ? 'raw' : 'generic';
}

export function taskParser(task: Pick<TaskRegistration, 'algorithm' | 'logFormat'>): ParserKind {
  const format = taskLogFormat(task);
  return ['generic', 'flow', 'score', 'reflow'].includes(format) ? format as ParserKind : 'unknown';
}

export function taskAlgorithmName(task: Pick<TaskRegistration, 'algorithm' | 'logFormat'>): string {
  return task.logFormat === undefined && Object.hasOwn(legacyNames, task.algorithm)
    ? legacyNames[task.algorithm]! : task.algorithm;
}
