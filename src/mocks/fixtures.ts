import type { HostSnapshot, LogSourceSnapshot, Registry, TaskSnapshot } from '../shared/contracts';
import type { MonitorSnapshot } from '../shared/api';

export const demoHost: HostSnapshot = {
  version: 1,
  hostId: 'demo-host',
  kind: 'ssh',
  connection: 'unobserved',
  lastSuccessAt: null,
  lastProbeDurationMs: null,
  scanComplete: false,
  errorCode: null,
  observedAt: null,
  freshness: 'unobserved',
};

export const demoTask: TaskSnapshot = {
  version: 1,
  taskId: 'demo-task',
  hostId: demoHost.hostId,
  lifecycle: 'unknown',
  freshness: 'unobserved',
  statusObservedAt: null,
  confidence: 'none',
  reason: '尚未连接真实训练源',
  evidence: [],
  currentRun: null,
  processes: { main: null, queue: null, workers: [] },
  queueLock: { observedAt: null, freshness: 'unobserved', source: null, exists: null, heldByRegisteredProcess: null },
  progress: {
    observedAt: null,
    freshness: 'unobserved',
    runId: null,
    lastStepIndex: null,
    bindingIds: [],
    baselineEvidenceId: null,
    resumeCheckpointIndex: null,
    firstLoopIndex: null,
    global: { completedCount: null, targetCount: null, fraction: null, unit: 'unknown', verified: false, sourceId: null },
    session: { completedCount: null, targetCount: null, fraction: null, unit: 'unknown', verified: false, sourceId: null },
    configuredTarget: null,
    iterationsPerSecond: null,
    etaSeconds: null,
  },
  checkpoint: { observedAt: null, freshness: 'unobserved', path: null, fileStepIndex: null, stepSource: null, sizeBytes: null, mtime: null, evidence: 'none', scanComplete: false },
  resources: [],
};

export const demoSource: LogSourceSnapshot = {
  observedAt: null,
  freshness: 'unobserved',
  sourceId: 'demo-log',
  taskId: demoTask.taskId,
  state: 'unobserved',
  generation: null,
  committedOffset: null,
  generationStartOffset: null,
  maxObservedOffset: null,
  continuityState: null,
  catchupBytesRead: null,
  catchupBytesTotal: null,
  errorCode: null,
};

export const demoSnapshot: MonitorSnapshot = {
  version: 1,
  demo: true,
  hosts: [demoHost],
  tasks: [demoTask],
  sources: [demoSource],
};

/** Neutral multi-host demonstration registry used only for --demo / storybook previews. */
export function createDemoPresetRegistry(): Registry {
  return {
    version: 2,
    revision: 0,
    hosts: [
      {
        hostId: 'gpu-server-01',
        label: 'GPU Server 01',
        enabled: true,
        allowedRoots: ['/workspace'],
        target: { kind: 'ssh', alias: 'gpu-server-01' },
      },
      {
        hostId: 'local-workstation',
        label: 'Local Workstation',
        enabled: true,
        allowedRoots: ['/workspace'],
        target: { kind: 'local' },
      },
    ],
    tasks: [
      {
        taskId: 'llm-sft-7b',
        hostId: 'gpu-server-01',
        label: 'LLM SFT 7B',
        enabled: true,
        algorithm: 'LLM SFT',
        logFormat: 'generic',
        allowedDirectories: ['/workspace/llm-sft-7b'],
        entryPaths: ['train.py'],
        sources: [{ sourceId: 'llm-sft-7b-log', path: '/workspace/llm-sft-7b/train.log', kind: 'log' }],
        checkpointDirectories: ['/workspace/llm-sft-7b/checkpoints'],
      },
      {
        taskId: 'vision-backbone',
        hostId: 'local-workstation',
        label: 'Vision Backbone',
        enabled: true,
        algorithm: 'ViT',
        logFormat: 'generic',
        allowedDirectories: ['/workspace/vision-backbone'],
        entryPaths: ['train_vit.py'],
        sources: [{ sourceId: 'vision-backbone-log', path: '/workspace/vision-backbone/train.log', kind: 'log' }],
        checkpointDirectories: ['/workspace/vision-backbone/checkpoints'],
      },
    ],
  };
}
