import type { TaskRegistration } from '../shared/contracts';
import { taskParser } from '../shared/task-profile';
import { parseFlowRecord } from './flow';
import { parseScoreRecord } from './score';
import { parseReflowRecord } from './reflow';
import { parseGenericRecord } from './generic';
import type { ParsedTrainingRecord } from './types';

export function parseRegisteredRecord(task: TaskRegistration, text: string, sourceId: string): ParsedTrainingRecord {
  switch (taskParser(task)) {
    case 'flow':
    case 'legacy_flow':
      return parseFlowRecord(text, sourceId);
    case 'score':
    case 'legacy_score':
      return parseScoreRecord(text, sourceId);
    case 'reflow':
    case 'legacy_reflow':
      return parseReflowRecord(text, sourceId);
    case 'generic': return parseGenericRecord(text, sourceId, task.customPatterns);
    case 'raw':
      return {
        algorithm: 'raw',
        sessionCompletedCount: null,
        sessionTargetCount: null,
        rate: null,
        rawText: text,
        sourceId,
        isTrainingOutput: false,
      };
    default:
      return {
        algorithm: 'unknown',
        sessionCompletedCount: null,
        sessionTargetCount: null,
        rate: null,
        rawText: text,
        sourceId,
        isTrainingOutput: false,
      };
  }
}
