import type { TaskRegistration } from '../shared/contracts';
import { taskParser } from '../shared/task-profile';
import { parseFlowRecord } from './flow';
import { parseScoreRecord } from './score';
import { parseReflowRecord } from './reflow';
import { parseGenericRecord } from './generic';
import type { ParsedTrainingRecord } from './types';

export function parseRegisteredRecord(task: TaskRegistration, text: string, sourceId: string): ParsedTrainingRecord {
  switch (taskParser(task)) {
    case 'flow': return parseFlowRecord(text, sourceId);
    case 'score': return parseScoreRecord(text, sourceId);
    case 'reflow': return parseReflowRecord(text, sourceId);
    case 'generic': return parseGenericRecord(text, sourceId);
    default: return { algorithm: 'unknown', sessionCompletedCount: null, sessionTargetCount: null,
      rate: null, rawText: text, sourceId, isTrainingOutput: false };
  }
}
