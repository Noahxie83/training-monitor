import { app } from 'electron';
import { createWindow, createGpuWindowManager } from '../../src/desktop/window';
import { registerMonitorIpc } from '../../src/desktop/ipc';
import { createControlledMockApi } from '../ui/fixtures';
import type { MonitorSnapshot } from '../../src/shared/api';
import type {
  GpuDeviceDetail,
  GpuSeriesPoint,
  LogEvent,
  MetricSeriesPoint,
  Registry,
  ResourceMetric,
  TaskSnapshot,
} from '../../src/shared/contracts';

const NOW = '2026-11-26T16:10:00.000Z';

const GPU_UTILS = [0, 4, 38, 62, 78, 86, 95, 98];
const GPU_MEMS_MIB = [480, 1024, 24576, 42100, 56320, 62800, 71680, 74240];
const GPU_TEMPS = [31, 34, 52, 61, 68, 72, 76, 79];
const GPU_POWER = [52, 58, 175, 240, 295, 328, 366, 382];

const devices: GpuDeviceDetail[] = Array.from({ length: 8 }, (_, idx) => ({
  deviceId: `GPU ${idx}`,
  index: idx,
  uuid: `GPU-00000000-0000-0000-0000-00000000000${idx}`,
  name: 'NVIDIA A100-SXM4-80GB',
  utilizationPct: GPU_UTILS[idx]!,
  memoryUsedMiB: GPU_MEMS_MIB[idx]!,
  memoryTotalMiB: 81920,
  temperatureC: GPU_TEMPS[idx]!,
  powerDrawW: GPU_POWER[idx]!,
  powerLimitW: 400,
  activeProcesses:
    idx >= 6
      ? [{ pid: idx === 6 ? 41820 : 41821, command: 'python3 scripts/train_sft.py --lora', memoryMiB: GPU_MEMS_MIB[idx]! }]
      : idx >= 2
        ? [{ pid: 39100 + idx, command: 'python3 eval_worker.py', memoryMiB: GPU_MEMS_MIB[idx]! }]
        : [],
}));

const deviceMetrics: ResourceMetric[] = devices.flatMap((d) => [
  {
    observedAt: NOW,
    freshness: 'fresh',
    source: 'nvidia-smi',
    name: 'gpu_utilization',
    unit: 'percent_device',
    value: d.utilizationPct ?? null,
    scope: 'device',
    deviceId: d.deviceId,
    processKey: null,
  },
  {
    observedAt: NOW,
    freshness: 'fresh',
    source: 'nvidia-smi',
    name: 'gpu_memory_used',
    unit: 'bytes',
    value: (d.memoryUsedMiB ?? 0) * 1024 * 1024,
    scope: 'device',
    deviceId: d.deviceId,
    processKey: null,
  },
  {
    observedAt: NOW,
    freshness: 'fresh',
    source: 'nvidia-smi',
    name: 'gpu_memory_total',
    unit: 'bytes',
    value: (d.memoryTotalMiB ?? 81920) * 1024 * 1024,
    scope: 'device',
    deviceId: d.deviceId,
    processKey: null,
  },
]);

const mainKey = { hostBootId: 'boot-a100', pid: 41820, startTicks: '9823410' };
const workerKey = { hostBootId: 'boot-a100', pid: 41821, startTicks: '9823415' };

const registry: Registry = {
  version: 2,
  revision: 3,
  hosts: [
    {
      hostId: 'gpu-cluster-a100',
      label: 'A100-80GB Node 01',
      enabled: true,
      allowedRoots: ['/workspace/experiments'],
      pollIntervalMs: 5000,
      allowJobControl: true,
      target: { kind: 'ssh', alias: 'gpu-cluster-a100', hostname: '10.24.0.18', user: 'trainer', port: 22 },
    },
    {
      hostId: 'workstation-local',
      label: 'Local Dev Node',
      enabled: true,
      allowedRoots: ['/home/trainer/projects'],
      pollIntervalMs: 5000,
      target: { kind: 'local' },
    },
  ],
  tasks: [
    {
      taskId: 'llama3-sft-lora',
      hostId: 'gpu-cluster-a100',
      label: 'Llama-3-8B LoRA SFT',
      enabled: true,
      algorithm: 'Llama-3-8B / LoRA',
      logFormat: 'generic',
      allowedDirectories: ['/workspace/experiments/llama3-sft'],
      entryPaths: ['scripts/train_sft.py'],
      sources: [
        { sourceId: 'sft-train', path: '/workspace/experiments/llama3-sft/logs/train.log', kind: 'log' },
        { sourceId: 'sft-eval', path: '/workspace/experiments/llama3-sft/logs/eval.log', kind: 'log' },
      ],
      checkpointDirectories: ['/workspace/experiments/llama3-sft/checkpoints'],
      autoStart: {
        execution: 'server_tmux',
        enabled: true,
        armId: '11111111-2222-4333-8444-555555555555',
        gpuDeviceIds: [],
        idleSeconds: 60,
        maxUtilizationPercent: 5,
        maxMemoryMiB: 2048,
        launch: {
          pythonPath: '/opt/conda/envs/pt2/bin/python3',
          entryPath: 'scripts/train_sft.py',
          cwd: '/workspace/experiments/llama3-sft',
          arguments: '--config configs/sft_lora.yaml --bf16',
          logSourceId: 'sft-train',
          condaEnv: 'pt2',
          env: { WANDB_MODE: 'offline', NCCL_DEBUG: 'WARN' },
        },
      },
    },
    {
      taskId: 'vit-pretrain',
      hostId: 'gpu-cluster-a100',
      label: 'ViT-Large MAE Pretrain',
      enabled: true,
      algorithm: 'ViT-Large / MAE',
      logFormat: 'generic',
      allowedDirectories: ['/workspace/experiments/vit-mae'],
      entryPaths: ['main_pretrain.py'],
      sources: [{ sourceId: 'vit-log', path: '/workspace/experiments/vit-mae/train.log', kind: 'log' }],
      checkpointDirectories: [],
    },
    {
      taskId: 'sdxl-eval',
      hostId: 'gpu-cluster-a100',
      label: 'SDXL Refiner Benchmark',
      enabled: true,
      algorithm: 'Diffusion / SDXL',
      logFormat: 'generic',
      allowedDirectories: ['/workspace/experiments/sdxl'],
      entryPaths: ['eval_fid.py'],
      sources: [],
      checkpointDirectories: [],
    },
  ],
};

const sftTask: TaskSnapshot = {
  version: 1,
  taskId: 'llama3-sft-lora',
  hostId: 'gpu-cluster-a100',
  lifecycle: 'running',
  freshness: 'fresh',
  statusObservedAt: NOW,
  confidence: 'high',
  attributionConfidence: 'confirmed_process',
  reason: 'Trainer process PID 41820 actively advancing steps and writing logs',
  evidence: [
    {
      kind: 'process_match',
      sourceId: 'proc',
      observedAt: NOW,
      confidence: 'high',
      summary: 'Matched PID 41820 with script scripts/train_sft.py inside /workspace/experiments/llama3-sft',
    },
    {
      kind: 'log_progress',
      sourceId: 'sft-train',
      observedAt: NOW,
      confidence: 'high',
      summary: 'Observed step 56,420 / 100,000 with loss=0.7824 lr=6.42e-5',
    },
  ],
  currentRun: { runId: 'run:v1:sft-1', mainProcessKey: mainKey },
  processes: {
    main: {
      key: mainKey,
      pid: 41820,
      parentKey: null,
      cwd: '/workspace/experiments/llama3-sft',
      scriptEntry: 'scripts/train_sft.py',
      command: '/opt/conda/envs/pt2/bin/python3 scripts/train_sft.py --config configs/sft_lora.yaml --bf16',
      role: 'trainer',
      observedAt: NOW,
    },
    queue: null,
    workers: [
      {
        key: workerKey,
        pid: 41821,
        parentKey: mainKey,
        cwd: '/workspace/experiments/llama3-sft',
        scriptEntry: null,
        role: 'worker',
        observedAt: NOW,
      },
    ],
  },
  queueLock: { observedAt: null, freshness: 'unobserved', source: null, exists: null, heldByRegisteredProcess: null },
  progress: {
    observedAt: NOW,
    freshness: 'fresh',
    runId: 'run:v1:sft-1',
    lastStepIndex: 56420,
    current: 56420,
    total: 100000,
    unit: 'step',
    scalars: { loss: 0.7824, eval_loss: 0.8912, lr: 6.42e-5 },
    bindingIds: ['b-sft'],
    baselineEvidenceId: 'ckpt-12000',
    resumeCheckpointIndex: 12000,
    firstLoopIndex: 12001,
    global: {
      completedCount: 56420,
      targetCount: 100000,
      fraction: 0.5642,
      unit: 'step',
      verified: true,
      sourceId: 'sft-train',
    },
    session: {
      completedCount: 44420,
      targetCount: 88000,
      fraction: 0.5048,
      unit: 'step',
      verified: true,
      sourceId: 'sft-train',
    },
    configuredTarget: { value: 100000, meaning: 'count' },
    iterationsPerSecond: 6.42,
    etaSeconds: 6788,
  },
  checkpoint: {
    observedAt: NOW,
    freshness: 'fresh',
    path: '/workspace/experiments/llama3-sft/checkpoints/checkpoint-55000',
    name: 'checkpoint-55000',
    isDirectory: true,
    fileCount: 7,
    fileStepIndex: 55000,
    stepSource: 'filename',
    sizeBytes: String(3_420_000_000),
    mtime: '2026-11-26T15:58:00.000Z',
    evidence: 'file_stable_observed',
    scanComplete: true,
  },
  gpuUsage: {
    observedAt: NOW,
    freshness: 'fresh',
    state: 'available',
    errorCode: null,
    processKeys: [mainKey, workerKey],
  },
  autoStart: {
    execution: 'server_tmux',
    backend: 'tmux',
    remoteConfirmed: true,
    sessionName: `tm-wait-${'a1b2c3d4'.repeat(5)}`,
    selectedDeviceId: 'GPU 0',
    armId: '11111111-2222-4333-8444-555555555555',
    phase: 'countdown',
    idleElapsedSeconds: 34,
    requiredIdleSeconds: 60,
    lastCheckedAt: NOW,
    startedAt: null,
    pid: null,
    errorCode: null,
    message: 'GPU 0 持续空闲，等待启动',
  },
  resources: [
    ...deviceMetrics,
    {
      observedAt: NOW,
      freshness: 'fresh',
      source: 'nvidia-smi',
      name: 'gpu_utilization',
      unit: 'percent_device',
      value: 95,
      scope: 'process',
      deviceId: 'GPU 6',
      processKey: mainKey,
    },
    {
      observedAt: NOW,
      freshness: 'fresh',
      source: 'nvidia-smi',
      name: 'gpu_memory_used',
      unit: 'bytes',
      value: 71680 * 1024 * 1024,
      scope: 'process',
      deviceId: 'GPU 6',
      processKey: mainKey,
    },
    {
      observedAt: NOW,
      freshness: 'fresh',
      source: 'nvidia-smi',
      name: 'gpu_utilization',
      unit: 'percent_device',
      value: 98,
      scope: 'process',
      deviceId: 'GPU 7',
      processKey: workerKey,
    },
    {
      observedAt: NOW,
      freshness: 'fresh',
      source: 'nvidia-smi',
      name: 'gpu_memory_used',
      unit: 'bytes',
      value: 74240 * 1024 * 1024,
      scope: 'process',
      deviceId: 'GPU 7',
      processKey: workerKey,
    },
    {
      observedAt: NOW,
      freshness: 'fresh',
      source: 'proc',
      name: 'process_rss',
      unit: 'bytes',
      value: 18 * 1024 ** 3,
      scope: 'process',
      deviceId: null,
      processKey: mainKey,
    },
    {
      observedAt: NOW,
      freshness: 'fresh',
      source: 'proc',
      name: 'cpu_utilization',
      unit: 'percent_one_cpu',
      value: 312,
      scope: 'process',
      deviceId: null,
      processKey: mainKey,
    },
  ],
};

const queuedTask: TaskSnapshot = {
  ...structuredClone(sftTask),
  taskId: 'vit-pretrain',
  lifecycle: 'queued',
  currentRun: null,
  autoStart: undefined,
  gpuUsage: undefined,
  processes: { main: null, queue: null, workers: [] },
  resources: [],
  progress: {
    ...structuredClone(sftTask.progress),
    lastStepIndex: null,
    current: null,
    total: null,
    scalars: undefined,
    resumeCheckpointIndex: null,
    baselineEvidenceId: null,
    global: { completedCount: null, targetCount: null, fraction: null, unit: 'unknown', verified: false, sourceId: null },
    session: { completedCount: null, targetCount: null, fraction: null, unit: 'unknown', verified: false, sourceId: null },
    iterationsPerSecond: null,
    etaSeconds: null,
  },
};

const completedTask: TaskSnapshot = {
  ...structuredClone(queuedTask),
  taskId: 'sdxl-eval',
  lifecycle: 'completed',
  progress: {
    ...structuredClone(queuedTask.progress),
    global: { completedCount: 5000, targetCount: 5000, fraction: 1, unit: 'step', verified: true, sourceId: null },
  },
};

const logs: LogEvent[] = [
  {
    version: 1,
    eventId: 'log-1',
    taskId: 'llama3-sft-lora',
    sourceId: 'sft-train',
    generation: 'gen-1',
    kind: 'line',
    startOffset: '0',
    endOffset: '90',
    ingestedAt: '2026-11-26T16:08:10.000Z',
    text: '[INFO] Initialized DeepSpeed ZeRO-2 across 2x NVIDIA A100-80GB GPUs (bf16 enabled)',
    rawAnsi: '\x1B[1;36m[INFO]\x1B[0m Initialized DeepSpeed ZeRO-2 across \x1B[32m2x NVIDIA A100-80GB\x1B[0m GPUs (bf16 enabled)',
    reason: null,
    displayTruncated: false,
    recordComplete: true,
    prefixIncomplete: false,
    runId: 'run:v1:sft-1',
    bindingId: null,
  },
  {
    version: 1,
    eventId: 'log-2',
    taskId: 'llama3-sft-lora',
    sourceId: 'sft-train',
    generation: 'gen-1',
    kind: 'line',
    startOffset: '90',
    endOffset: '180',
    ingestedAt: '2026-11-26T16:08:30.000Z',
    text: '[INFO] step=56400/100000 loss=0.7941 eval_loss=0.8965 lr=6.44e-05 throughput=6.39 it/s',
    rawAnsi: '\x1B[32m[INFO]\x1B[0m step=\x1B[1m56400/100000\x1B[0m loss=\x1B[38;2;96;165;250m0.7941\x1B[0m eval_loss=0.8965 lr=6.44e-05 throughput=6.39 it/s',
    reason: null,
    displayTruncated: false,
    recordComplete: true,
    prefixIncomplete: false,
    runId: 'run:v1:sft-1',
    bindingId: null,
  },
  {
    version: 1,
    eventId: 'log-3',
    taskId: 'llama3-sft-lora',
    sourceId: 'sft-train',
    generation: 'gen-1',
    kind: 'line',
    startOffset: '180',
    endOffset: '270',
    ingestedAt: '2026-11-26T16:08:52.000Z',
    text: '[WARN] Gradient norm spike (grad_norm=4.82 > 1.0); applying adaptive gradient clipping',
    reason: null,
    displayTruncated: false,
    recordComplete: true,
    prefixIncomplete: false,
    runId: 'run:v1:sft-1',
    bindingId: null,
  },
  {
    version: 1,
    eventId: 'log-4',
    taskId: 'llama3-sft-lora',
    sourceId: 'sft-train',
    generation: 'gen-1',
    kind: 'line',
    startOffset: '270',
    endOffset: '360',
    ingestedAt: '2026-11-26T16:09:15.000Z',
    text: '[INFO] step=56410/100000 loss=0.7880 lr=6.43e-05 grad_norm=0.74 throughput=6.41 it/s',
    rawAnsi: '\x1B[32m[INFO]\x1B[0m step=\x1B[1m56410/100000\x1B[0m loss=\x1B[38;2;96;165;250m0.7880\x1B[0m lr=6.43e-05 grad_norm=0.74 throughput=6.41 it/s',
    reason: null,
    displayTruncated: false,
    recordComplete: true,
    prefixIncomplete: false,
    runId: 'run:v1:sft-1',
    bindingId: null,
  },
  {
    version: 1,
    eventId: 'log-5',
    taskId: 'llama3-sft-lora',
    sourceId: 'sft-train',
    generation: 'gen-1',
    kind: 'line',
    startOffset: '360',
    endOffset: '460',
    ingestedAt: '2026-11-26T16:09:38.000Z',
    text: '[ERROR] Transient DataLoader worker timeout on shard #14; automatically retried and recovered',
    reason: null,
    displayTruncated: false,
    recordComplete: true,
    prefixIncomplete: false,
    runId: 'run:v1:sft-1',
    bindingId: null,
  },
  {
    version: 1,
    eventId: 'log-6',
    taskId: 'llama3-sft-lora',
    sourceId: 'sft-train',
    generation: 'gen-1',
    kind: 'line',
    startOffset: '460',
    endOffset: '560',
    ingestedAt: '2026-11-26T16:09:50.000Z',
    text: '[INFO] Saved checkpoint-55000 (3.18 GiB, 7 shards) in 4.2s',
    rawAnsi: '\x1B[32m[INFO]\x1B[0m Saved \x1B[33mcheckpoint-55000\x1B[0m (3.18 GiB, 7 shards) in 4.2s',
    reason: null,
    displayTruncated: false,
    recordComplete: true,
    prefixIncomplete: false,
    runId: 'run:v1:sft-1',
    bindingId: null,
  },
  {
    version: 1,
    eventId: 'log-7',
    taskId: 'llama3-sft-lora',
    sourceId: 'sft-train',
    generation: 'gen-1',
    kind: 'redraw',
    startOffset: '560',
    endOffset: '650',
    ingestedAt: '2026-11-26T16:10:00.000Z',
    text: '56%|████████████████▊             | 56420/100000 [2:26:12<1:53:08, 6.42it/s, loss=0.7824]',
    reason: null,
    displayTruncated: false,
    recordComplete: true,
    prefixIncomplete: false,
    runId: 'run:v1:sft-1',
    bindingId: null,
  },
];

const lossSeries: MetricSeriesPoint[] = [];
const evalLossSeries: MetricSeriesPoint[] = [];
const lrSeries: MetricSeriesPoint[] = [];
const throughputSeries: MetricSeriesPoint[] = [];

for (let i = 0; i < 36; i++) {
  const progress = i / 35;
  const step = 12000 + Math.round(progress * 44420);
  const observedAt = new Date(Date.parse('2026-11-26T14:00:00.000Z') + i * 220_000).toISOString();
  const noise = Math.sin(i * 1.3) * 0.045;
  const loss = Number((2.35 * Math.exp(-1.25 * progress) + 0.14 + noise).toFixed(4));
  lossSeries.push({ step, observedAt, value: loss });
  if (i % 3 === 0) {
    evalLossSeries.push({ step, observedAt, value: Number((loss + 0.095 + Math.cos(i) * 0.015).toFixed(4)) });
  }
  lrSeries.push({
    step,
    observedAt,
    value: Number((3e-4 * (0.2 + 0.8 * Math.cos((Math.PI / 2) * progress))).toExponential(3)),
  });
  throughputSeries.push({
    step,
    observedAt,
    value: Number((6.18 + Math.sin(i * 0.6) * 0.22 + progress * 0.15).toFixed(2)),
  });
}

const gpuSeriesPoints: GpuSeriesPoint[] = devices.flatMap((d) =>
  Array.from({ length: 18 }, (_, i) => {
    const wave = Math.sin(i * 0.65 + d.index) * ((d.utilizationPct ?? 0) <= 10 ? 2 : 7);
    const utilPct = Math.max(0, Math.min(100, Math.round((d.utilizationPct ?? 0) + wave)));
    const memUsedMiB = Math.max(256, Math.min(81920, Math.round((d.memoryUsedMiB ?? 512) + Math.cos(i * 0.4) * 1024)));
    return {
      observedAt: new Date(Date.parse(NOW) - (17 - i) * 50_000).toISOString(),
      deviceId: d.deviceId,
      utilPct,
      memUsedMiB,
      memTotalMiB: 81920,
      tempC: d.temperatureC ?? null,
      powerW: d.powerDrawW ?? null,
    };
  }),
);

const snapshot: MonitorSnapshot = {
  version: 1,
  demo: true,
  hosts: [
    {
      version: 1,
      hostId: 'gpu-cluster-a100',
      kind: 'ssh',
      connection: 'connected',
      lastSuccessAt: NOW,
      lastProbeDurationMs: 28,
      scanComplete: true,
      errorCode: null,
      observedAt: NOW,
      freshness: 'fresh',
      system: {
        observedAt: NOW,
        freshness: 'fresh',
        cpuUtilizationPct: 48,
        memoryUsedBytes: String(142 * 1024 ** 3),
        memoryTotalBytes: String(256 * 1024 ** 3),
        disks: [
          {
            path: '/workspace',
            usedBytes: String(1480 * 1024 ** 3),
            availableBytes: String(2520 * 1024 ** 3),
            totalBytes: String(4000 * 1024 ** 3),
          },
        ],
      },
      gpu: {
        observedAt: NOW,
        state: 'available',
        errorCode: null,
        metrics: deviceMetrics,
        devices,
      },
    },
    {
      version: 1,
      hostId: 'workstation-local',
      kind: 'local',
      connection: 'connected',
      lastSuccessAt: NOW,
      lastProbeDurationMs: 4,
      scanComplete: true,
      errorCode: null,
      observedAt: NOW,
      freshness: 'fresh',
      acceleratorAvailability: 'none',
      system: {
        observedAt: NOW,
        freshness: 'fresh',
        cpuUtilizationPct: 18,
        memoryUsedBytes: String(14 * 1024 ** 3),
        memoryTotalBytes: String(64 * 1024 ** 3),
        disks: [
          {
            path: '/',
            usedBytes: String(310 * 1024 ** 3),
            availableBytes: String(690 * 1024 ** 3),
            totalBytes: String(1000 * 1024 ** 3),
          },
        ],
      },
    },
  ],
  tasks: [sftTask, queuedTask, completedTask],
  sources: [
    {
      observedAt: NOW,
      freshness: 'fresh',
      sourceId: 'sft-train',
      taskId: 'llama3-sft-lora',
      state: 'ready',
      generation: 'gen-1',
      committedOffset: '8421000',
      generationStartOffset: '0',
      maxObservedOffset: '8421000',
      continuityState: 'tracking',
      catchupBytesRead: null,
      catchupBytesTotal: null,
      errorCode: null,
      resolvedPath: '/workspace/experiments/llama3-sft/logs/train.log',
    },
    {
      observedAt: NOW,
      freshness: 'fresh',
      sourceId: 'sft-eval',
      taskId: 'llama3-sft-lora',
      state: 'ready',
      generation: 'gen-1',
      committedOffset: '41000',
      generationStartOffset: '0',
      maxObservedOffset: '41000',
      continuityState: 'tracking',
      catchupBytesRead: null,
      catchupBytesTotal: null,
      errorCode: null,
      resolvedPath: '/workspace/experiments/llama3-sft/logs/eval.log',
    },
  ],
};

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(() => {
  const api = createControlledMockApi({
    registry,
    snapshot,
    logs: [...logs].reverse(),
    preferences: { theme: 'light', locale: 'zh-CN' },
  });

  api.getMetricSeries = async (query) => {
    const series: Record<string, MetricSeriesPoint[]> =
      query.taskId === 'llama3-sft-lora'
        ? {
            loss: lossSeries,
            eval_loss: evalLossSeries,
            lr: lrSeries,
            iterations_per_second: throughputSeries,
          }
        : {};
    return { taskId: query.taskId, series };
  };

  api.getGpuSeries = async (query) => ({
    hostId: query.hostId,
    gpu: query.hostId === 'gpu-cluster-a100' ? gpuSeriesPoints : [],
    host: [],
  });

  api.discoverProcesses = async () => [
    {
      pid: 41820,
      pgid: 41820,
      command: 'python3 scripts/train_sft.py --config configs/sft_lora.yaml --bf16',
      cwd: '/workspace/experiments/llama3-sft',
      gpuIndices: [6, 7],
      gpuMemoryMiB: 145920,
      openLogPaths: ['/workspace/experiments/llama3-sft/logs/train.log'],
      suggestedName: 'Llama-3-8B LoRA SFT',
      suggestedEntry: 'scripts/train_sft.py',
    },
    {
      pid: 52310,
      pgid: 52310,
      command: 'torchrun --nproc_per_node=2 train_reward.py --lr 2e-5',
      cwd: '/workspace/experiments/reward-model',
      gpuIndices: [4, 5],
      gpuMemoryMiB: 119120,
      openLogPaths: ['/workspace/experiments/reward-model/run.log'],
      suggestedName: 'Reward Model Training',
      suggestedEntry: 'train_reward.py',
    },
  ];

  api.testWebhook = async () => ({ ok: true, statusCode: 200, error: null });

  const gpu = createGpuWindowManager();
  const dispose = registerMonitorIpc(api, { openGpuWindow: (hostId) => gpu.open(hostId) });
  app.once('before-quit', dispose);
  const main = createWindow();
  main.once('closed', () => app.quit());
});
