export interface FlowParams {
  b: number;
  T: number;
  n: number;
}

export interface FlowDerivationResult {
  firstLoopIndex: number;
  lastStepIndex: number | null;
  global: {
    completedCount: number;
    targetCount: number;
    fraction: number;
    unit: 'completed_iterations';
    verified: true;
  };
  session: {
    completedCount: number;
    targetCount: number;
    fraction: number;
    unit: 'completed_iterations';
    verified: true;
  };
}

export interface ParsedTrainingRecord {
  algorithm: 'flow' | 'score' | 'reflow' | 'generic' | 'unknown';
  sessionCompletedCount: number | null;
  sessionTargetCount: number | null;
  rate: number | null;
  rawText: string;
  sourceId: string;
  isTrainingOutput: boolean;
  stepIndex?: number | null;
}
