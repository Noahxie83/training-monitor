import type {
  HostSnapshot,
  TaskSnapshot,
  LogSourceSnapshot,
  Registry,
  Preferences,
  LogEvent,
} from '../../src/shared/contracts';
import type { MonitorApi, MonitorSnapshot, MonitorUpdate } from '../../src/shared/api';

export const testHostConnected: HostSnapshot = {
  version: 1,
  hostId: 'lab-campus',
  kind: 'ssh',
  connection: 'connected',
  lastSuccessAt: '2026-10-18T20:31:05.000Z',
  lastProbeDurationMs: 42,
  scanComplete: true,
  errorCode: null,
  observedAt: '2026-10-18T20:31:05.000Z',
  freshness: 'fresh',
};

export const testHostWslUnobserved: HostSnapshot = {
  version: 1,
  hostId: 'wsl-ubuntu',
  kind: 'wsl',
  connection: 'unobserved',
  lastSuccessAt: null,
  lastProbeDurationMs: null,
  scanComplete: false,
  errorCode: null,
  observedAt: null,
  freshness: 'unobserved',
};

export const testHostDisconnected: HostSnapshot = {
  version: 1,
  hostId: 'lab-campus',
  kind: 'ssh',
  connection: 'disconnected',
  lastSuccessAt: '2026-10-18T20:31:05.000Z',
  lastProbeDurationMs: null,
  scanComplete: false,
  errorCode: 'CONNECTION_TIMEOUT',
  observedAt: '2026-10-18T20:31:05.000Z',
  freshness: 'stale',
};

export const testFlowTask: TaskSnapshot = {
  version: 1,
  taskId: 'flow-cifar10',
  hostId: 'lab-campus',
  lifecycle: 'running',
  freshness: 'fresh',
  statusObservedAt: '2026-10-18T20:31:05.000Z',
  confidence: 'high',
  reason: '训练进程存在且持续推进',
  evidence: [
    {
      kind: 'process_match',
      sourceId: 'proc',
      observedAt: '2026-10-18T20:31:05.000Z',
      confidence: 'high',
      summary: '检测到 PID 594319 且入口符合 torchcfm/examples/images/cifar10/train.py',
    },
    {
      kind: 'queue_lock',
      sourceId: '/data2/cy/xzn/Code/Flow_Matching/queue.lock',
      observedAt: '2026-10-18T20:31:05.000Z',
      confidence: 'high',
      summary: '持有锁文件',
    },
  ],
  currentRun: {
    runId: 'run:v1:flow-1',
    mainProcessKey: { hostBootId: 'boot-lab', pid: 594319, startTicks: '12345678' },
  },
  processes: {
    main: {
      key: { hostBootId: 'boot-lab', pid: 594319, startTicks: '12345678' },
      pid: 594319,
      parentKey: null,
      cwd: '/data2/cy/xzn/Code/Flow_Matching',
      scriptEntry: 'torchcfm/examples/images/cifar10/train.py',
      role: 'trainer',
      observedAt: '2026-10-18T20:31:05.000Z',
    },
    queue: null,
    workers: [
      {
        key: { hostBootId: 'boot-lab', pid: 594320, startTicks: '12345680' },
        pid: 594320,
        parentKey: { hostBootId: 'boot-lab', pid: 594319, startTicks: '12345678' },
        cwd: '/data2/cy/xzn/Code/Flow_Matching',
        scriptEntry: null,
        role: 'worker',
        observedAt: '2026-10-18T20:31:05.000Z',
      },
      {
        key: { hostBootId: 'boot-lab', pid: 594321, startTicks: '12345681' },
        pid: 594321,
        parentKey: { hostBootId: 'boot-lab', pid: 594319, startTicks: '12345678' },
        cwd: '/data2/cy/xzn/Code/Flow_Matching',
        scriptEntry: null,
        role: 'worker',
        observedAt: '2026-10-18T20:31:05.000Z',
      },
    ],
  },
  queueLock: {
    observedAt: '2026-10-18T20:31:05.000Z',
    freshness: 'fresh',
    source: '/data2/cy/xzn/Code/Flow_Matching/queue.lock',
    exists: true,
    heldByRegisteredProcess: true,
  },
  progress: {
    observedAt: '2026-10-18T20:31:05.000Z',
    freshness: 'fresh',
    runId: 'run:v1:flow-1',
    lastStepIndex: 110106,
    bindingIds: ['bind-1'],
    baselineEvidenceId: 'base-1',
    resumeCheckpointIndex: 30000,
    firstLoopIndex: 30001,
    global: {
      completedCount: 110107,
      targetCount: 200000,
      fraction: 0.550535,
      unit: 'completed_iterations',
      verified: true,
      sourceId: 'flow-log',
    },
    session: {
      completedCount: 80106,
      targetCount: 169999,
      fraction: 0.471214,
      unit: 'completed_iterations',
      verified: true,
      sourceId: 'flow-log',
    },
    configuredTarget: { value: 200000, meaning: 'exclusive_index' },
    iterationsPerSecond: 6.33,
    etaSeconds: 14190,
  },
  checkpoint: {
    observedAt: '2026-10-18T20:31:05.000Z',
    freshness: 'fresh',
    path: '/data2/cy/xzn/Code/Flow_Matching/results_server_resume/weights_step_100000.pt',
    fileStepIndex: 100000,
    stepSource: 'filename',
    sizeBytes: '508788736',
    mtime: '2026-10-18T20:03:00.000Z',
    evidence: 'file_stable_observed',
    scanComplete: true,
  },
  resources: [
    {
      observedAt: '2026-10-18T20:31:05.000Z',
      freshness: 'fresh',
      source: 'nvidia-smi',
      name: 'gpu_utilization',
      unit: 'percent_device',
      value: 97,
      scope: 'device',
      deviceId: 'GPU-0',
      processKey: null,
    },
    {
      observedAt: '2026-10-18T20:31:05.000Z',
      freshness: 'fresh',
      source: 'nvidia-smi',
      name: 'gpu_memory_used',
      unit: 'bytes',
      value: 9930014720,
      scope: 'device',
      deviceId: 'GPU-0',
      processKey: null,
    },
    {
      observedAt: '2026-10-18T20:31:05.000Z',
      freshness: 'fresh',
      source: 'nvidia-smi',
      name: 'gpu_memory_total',
      unit: 'bytes',
      value: 25769803776,
      scope: 'device',
      deviceId: 'GPU-0',
      processKey: null,
    },
    {
      observedAt: '2026-10-18T20:31:05.000Z',
      freshness: 'fresh',
      source: 'proc',
      name: 'process_rss',
      unit: 'bytes',
      value: 9930014720,
      scope: 'process',
      deviceId: null,
      processKey: { hostBootId: 'boot-lab', pid: 594319, startTicks: '12345678' },
    },
  ],
};

export const testScoreTask: TaskSnapshot = {
  version: 1,
  taskId: 'score-based',
  hostId: 'lab-campus',
  lifecycle: 'queued',
  freshness: 'fresh',
  statusObservedAt: '2026-10-18T20:31:05.000Z',
  confidence: 'medium',
  reason: '队列脚本等待 Flow 任务完成',
  evidence: [
    {
      kind: 'queue_status',
      sourceId: 'status.json',
      observedAt: '2026-10-18T20:31:05.000Z',
      confidence: 'medium',
      summary: '状态记录为 waiting_flow',
    },
  ],
  currentRun: null,
  processes: {
    main: null,
    queue: {
      key: { hostBootId: 'boot-lab', pid: 601234, startTicks: '12349000' },
      pid: 601234,
      parentKey: null,
      cwd: '/home/cy',
      scriptEntry: '/data2/cy/xzn/Code/Scored-Based/queue_runner.py',
      role: 'queue',
      observedAt: '2026-10-18T20:31:05.000Z',
    },
    workers: [],
  },
  queueLock: {
    observedAt: '2026-10-18T20:31:05.000Z',
    freshness: 'fresh',
    source: '/data2/cy/xzn/Code/Scored-Based/queue.lock',
    exists: false,
    heldByRegisteredProcess: false,
  },
  progress: {
    observedAt: '2026-10-18T20:31:05.000Z',
    freshness: 'fresh',
    runId: null,
    lastStepIndex: null,
    bindingIds: [],
    baselineEvidenceId: null,
    resumeCheckpointIndex: 20294,
    firstLoopIndex: null,
    global: {
      completedCount: null,
      targetCount: null,
      fraction: null,
      unit: 'unknown',
      verified: false,
      sourceId: null,
    },
    session: {
      completedCount: null,
      targetCount: null,
      fraction: null,
      unit: 'unknown',
      verified: false,
      sourceId: null,
    },
    configuredTarget: { value: 100000, meaning: 'count' },
    iterationsPerSecond: null,
    etaSeconds: null,
  },
  checkpoint: {
    observedAt: null,
    freshness: 'unobserved',
    path: null,
    fileStepIndex: null,
    stepSource: null,
    sizeBytes: null,
    mtime: null,
    evidence: 'none',
    scanComplete: true,
  },
  resources: [],
};

export const testReflowTask: TaskSnapshot = {
  version: 1,
  taskId: 'reflow',
  hostId: 'lab-campus',
  lifecycle: 'ready_not_training',
  freshness: 'fresh',
  statusObservedAt: '2026-10-18T20:31:05.000Z',
  confidence: 'low',
  reason: '就绪记录明确，尚未启动',
  evidence: [],
  currentRun: null,
  processes: { main: null, queue: null, workers: [] },
  queueLock: {
    observedAt: null,
    freshness: 'unobserved',
    source: null,
    exists: null,
    heldByRegisteredProcess: null,
  },
  progress: {
    observedAt: null,
    freshness: 'unobserved',
    runId: null,
    lastStepIndex: null,
    bindingIds: [],
    baselineEvidenceId: null,
    resumeCheckpointIndex: 4000,
    firstLoopIndex: null,
    global: {
      completedCount: null,
      targetCount: null,
      fraction: null,
      unit: 'unknown',
      verified: false,
      sourceId: null,
    },
    session: {
      completedCount: null,
      targetCount: null,
      fraction: null,
      unit: 'unknown',
      verified: false,
      sourceId: null,
    },
    configuredTarget: null,
    iterationsPerSecond: null,
    etaSeconds: null,
  },
  checkpoint: {
    observedAt: null,
    freshness: 'unobserved',
    path: null,
    fileStepIndex: null,
    stepSource: null,
    sizeBytes: null,
    mtime: null,
    evidence: 'none',
    scanComplete: false,
  },
  resources: [],
};

export const testFlowSource: LogSourceSnapshot = {
  observedAt: '2026-10-18T20:31:05.000Z',
  freshness: 'fresh',
  sourceId: 'flow-log',
  taskId: 'flow-cifar10',
  state: 'reading',
  generation: 'gen-1',
  committedOffset: '5242880',
  generationStartOffset: '0',
  maxObservedOffset: '5242880',
  continuityState: 'tracking',
  catchupBytesRead: null,
  catchupBytesTotal: null,
  errorCode: null,
};

export const testRegistry: Registry = {
  version: 2,
  revision: 1,
  hosts: [
    {
      hostId: 'lab-campus',
      label: 'Lab Campus (SSH)',
      enabled: true,
      allowedRoots: ['/data2/cy/xzn'],
      target: { kind: 'ssh', alias: 'lab-campus' },
    },
    {
      hostId: 'wsl-ubuntu',
      label: 'WSL (Ubuntu-26.04)',
      enabled: false,
      allowedRoots: ['/home/user'],
      target: { kind: 'wsl', distribution: 'Ubuntu-26.04' },
    },
  ],
  tasks: [
    {
      taskId: 'flow-cifar10',
      hostId: 'lab-campus',
      label: 'Flow Matching (CIFAR-10)',
      enabled: true,
      algorithm: 'flow',
      allowedDirectories: ['/data2/cy/xzn/Code/Flow_Matching'],
      entryPaths: ['torchcfm/examples/images/cifar10/train.py'],
      sources: [
        {
          sourceId: 'flow-log',
          path: '/data2/cy/xzn/Code/Flow_Matching/training.log',
          kind: 'log',
        },
      ],
      checkpointDirectories: ['/data2/cy/xzn/Code/Flow_Matching/results_server_resume'],
    },
    {
      taskId: 'score-based',
      hostId: 'lab-campus',
      label: 'Score-based Generative Model',
      enabled: true,
      algorithm: 'score',
      allowedDirectories: ['/data2/cy/xzn/Code/Scored-Based'],
      entryPaths: ['queue_runner.py'],
      sources: [
        {
          sourceId: 'score-log',
          path: '/data2/cy/xzn/Code/Scored-Based/queue.log',
          kind: 'log',
        },
      ],
      checkpointDirectories: ['/data2/cy/xzn/Code/Scored-Based/checkpoints'],
    },
    {
      taskId: 'reflow',
      hostId: 'lab-campus',
      label: 'Reflow 2-rectified Flow',
      enabled: true,
      algorithm: 'reflow',
      allowedDirectories: ['/data2/cy/xzn/Code/Reflow'],
      entryPaths: ['train_reflow.py'],
      sources: [],
      checkpointDirectories: [],
    },
  ],
};

export function createControlledMockApi(options: {
  snapshot?: MonitorSnapshot;
  logs?: LogEvent[];
  preferences?: Preferences;
  registry?: Registry;
} = {}): MonitorApi & {
  emitUpdate: (update: MonitorUpdate) => void;
  lastCopied: { taskId: string; sourceId?: string } | null;
} {
  let currentSnapshot: MonitorSnapshot = options.snapshot ?? {
    version: 1,
    demo: true,
    hosts: [testHostConnected, testHostWslUnobserved],
    tasks: [testFlowTask, testScoreTask, testReflowTask],
    sources: [testFlowSource],
  };
  let preferences: Preferences = options.preferences ?? { theme: 'system' };
  let registry: Registry = options.registry ?? structuredClone(testRegistry);
  const listeners = new Set<(update: MonitorUpdate) => void>();
  const events: LogEvent[] = options.logs ?? [];
  let lastCopied: { taskId: string; sourceId?: string } | null = null;
  const cancelledRequests = new Set<string>();

  return {
    get lastCopied() {
      return lastCopied;
    },
    emitUpdate(update: MonitorUpdate) {
      if (update.kind === 'snapshot') {
        currentSnapshot = update.snapshot;
      }
      for (const listener of [...listeners]) {
        listener(structuredClone(update));
      }
    },
    async getSnapshot() {
      return structuredClone(currentSnapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async requestRefresh() {
      for (const listener of [...listeners]) {
        listener({ kind: 'snapshot', snapshot: structuredClone(currentSnapshot) });
      }
    },
    async getLogs(query) {
      const filtered = events.filter((e) => e.sourceId === query.sourceId);
      const limit = Math.min(query.limit, 500);
      return {
        events: filtered.slice(0, limit),
        nextBefore: null,
        truncatedByBudget: false,
      };
    },
    async searchLogs(query) {
      if (cancelledRequests.has(query.requestId)) {
        return { events: [], continuation: null, scope: 'retained_local', cancelled: true };
      }
      const filtered = events.filter(
        (e) => query.sourceIds.includes(e.sourceId) && (e.text ?? '').includes(query.literal),
      );
      return {
        events: filtered,
        continuation: null,
        scope: 'retained_local',
        cancelled: false,
      };
    },
    async cancelRequest(requestId) {
      cancelledRequests.add(requestId);
    },
    async getRegistry() {
      return structuredClone(registry);
    },
    async saveRegistry(newRegistry) {
      registry = structuredClone(newRegistry);
      return structuredClone(registry);
    },
    async getPreferences() {
      return { ...preferences };
    },
    async savePreferences(newPrefs) {
      preferences = { ...newPrefs };
      return { ...preferences };
    },
    async copyRegisteredPath(value) {
      lastCopied = value;
    },
  };
}
