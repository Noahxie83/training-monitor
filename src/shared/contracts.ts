export type Freshness = 'fresh' | 'stale' | 'unobserved';
export type Confidence = 'high' | 'medium' | 'low' | 'none';
export type Bytes = string;
export type Lifecycle = 'running' | 'queued' | 'ready_not_training' | 'completed' | 'failed' | 'unconfirmed' | 'not_observed' | 'unknown';
export type HostKind = 'ssh' | 'wsl' | 'local';
export type AcceleratorAvailability = 'available' | 'none' | 'unavailable';

export interface Stamp { observedAt: string | null; freshness: Freshness }
export interface ProcessKey { hostBootId: string; pid: number; startTicks: string }
export interface ProcessInstance {
  key: ProcessKey | null;
  pid: number;
  parentKey: ProcessKey | null;
  cwd: string | null;
  scriptEntry: string | null;
  launcherEntry?: string | null;
  role: 'trainer' | 'queue' | 'worker' | 'unknown';
  observedAt: string;
}
export interface HostGpuSnapshot {
  observedAt: string | null;
  state: 'available' | 'unavailable';
  acceleratorAvailability?: AcceleratorAvailability;
  errorCode: string | null;
  metrics: ResourceMetric[];
}
export interface TaskGpuUsage extends Stamp {
  state: 'available' | 'unavailable';
  errorCode: string | null;
  processKeys: ProcessKey[];
}
export interface HostSnapshot extends Stamp {
  version: 1;
  hostId: string;
  kind: HostKind;
  connection: 'unobserved' | 'connecting' | 'connected' | 'disconnected';
  lastSuccessAt: string | null;
  lastProbeDurationMs: number | null;
  scanComplete: boolean;
  errorCode: string | null;
  nextRetryAt?: string | null;
  consecutiveFailures?: number;
  acceleratorAvailability?: AcceleratorAvailability;
  gpu?: HostGpuSnapshot;
}
export interface CountView {
  completedCount: number | null;
  targetCount: number | null;
  fraction: number | null;
  unit: 'completed_iterations' | 'unknown';
  verified: boolean;
  sourceId: string | null;
}
export interface Progress extends Stamp {
  runId: string | null;
  lastStepIndex: number | null;
  bindingIds: string[];
  baselineEvidenceId: string | null;
  resumeCheckpointIndex: number | null;
  firstLoopIndex: number | null;
  global: CountView;
  session: CountView;
  configuredTarget: { value: number; meaning: 'exclusive_index' | 'count' | 'unknown' } | null;
  iterationsPerSecond: number | null;
  etaSeconds: number | null;
}
export interface Checkpoint extends Stamp {
  path: string | null;
  fileStepIndex: number | null;
  stepSource: 'filename' | null;
  sizeBytes: Bytes | null;
  mtime: string | null;
  evidence: 'none' | 'file_found' | 'file_stable_observed';
  scanComplete: boolean;
}
export type ResourceMetric = Stamp & {
  source: string;
  name: 'gpu_utilization' | 'gpu_memory_used' | 'gpu_memory_total' | 'cpu_utilization' | 'process_rss';
  unit: 'percent_device' | 'percent_one_cpu' | 'bytes';
  value: number | null;
} & (
  | { scope: 'device'; deviceId: string; processKey: null }
  | { scope: 'process'; deviceId: string | null; processKey: ProcessKey }
);
export interface TaskSnapshot {
  version: 1;
  taskId: string;
  hostId: string;
  lifecycle: Lifecycle;
  freshness: Freshness;
  statusObservedAt: string | null;
  confidence: Confidence;
  reason: string;
  evidence: { kind: string; sourceId: string | null; observedAt: string; confidence: Confidence; summary: string }[];
  currentRun: { runId: string; mainProcessKey: ProcessKey } | null;
  processes: { main: ProcessInstance | null; queue: ProcessInstance | null; workers: ProcessInstance[] };
  queueLock: Stamp & { source: string | null; exists: boolean | null; heldByRegisteredProcess: boolean | null };
  progress: Progress;
  checkpoint: Checkpoint;
  resources: ResourceMetric[];
  gpuUsage?: TaskGpuUsage;
  autoStart?: AutoStartStatus;
}
export interface LogSourceSnapshot extends Stamp {
  sourceId: string;
  taskId: string;
  state:
    | 'unobserved'
    | 'ready'
    | 'missing'
    | 'permission_error'
    | 'reading'
    | 'catching_up'
    | 'reconciling'
    | 'paused_budget'
    | 'cache_full'
    | 'storage_error'
    | 'read_error';
  generation: string | null;
  committedOffset: Bytes | null;
  generationStartOffset: Bytes | null;
  maxObservedOffset: Bytes | null;
  continuityState: 'tracking' | 'reconciling' | null;
  catchupBytesRead: Bytes | null;
  catchupBytesTotal: Bytes | null;
  errorCode: string | null;
}
export interface LogEvent {
  version: 1;
  eventId: string;
  taskId: string;
  sourceId: string;
  generation: string;
  kind: 'line' | 'redraw' | 'import_boundary' | 'generation_started' | 'gap_confirmed' | 'gap_unknown' | 'cache_evicted';
  startOffset: Bytes | null;
  endOffset: Bytes | null;
  ingestedAt: string;
  text: string | null;
  reason: string | null;
  displayTruncated: boolean;
  recordComplete: boolean | null;
  prefixIncomplete: boolean | null;
  runId: string | null;
  bindingId: string | null;
}
export interface CursorState {
  sourceId: string;
  generation: string;
  revision: number;
  state: 'tracking' | 'reconciling';
  identityStrength: 'strong' | 'weak';
  fileIdentity: { dev: string; inode: string } | null;
  generationStartOffset: Bytes;
  committedOffset: Bytes;
  maxObservedOffset: Bytes;
  anchors: { startOffset: Bytes; endOffset: Bytes; sha256: string }[];
  parserState: {
    recordStartOffset: Bytes;
    pendingCR: boolean;
    utf8CarryBase64: string;
    boundedPreview: string;
    displayTruncated: boolean;
    prefixIncomplete: boolean;
    recordInvalidUtf8?: boolean;
  };
}
export interface RunBinding {
  bindingId: string;
  runId: string;
  mainProcessKey: ProcessKey;
  sourceId: string;
  generation: string;
  fromOffset: Bytes;
  throughOffset: Bytes;
  evidenceKind: 'instance_linked_record' | 'observed_direct_writer';
  observerEpoch: string;
  observedAt: string;
}

export type HostTarget =
  | {
      kind: 'ssh';
      /** Mode 1: reference an alias from ~/.ssh/config; Mode 2: explicit connection parameters. */
      alias?: string;
      hostname?: string;
      user?: string;
      port?: number;
      identityFile?: string;
      proxyJump?: string;
      /** Optional remote Python executable override (auto-detected if omitted). */
      pythonPath?: string;
    }
  | {
      kind: 'wsl';
      distribution: string;
      pythonPath?: string;
    }
  | {
      kind: 'local';
      pythonPath?: string;
    };

export interface HostRegistration {
  hostId: string;
  label: string;
  enabled: boolean;
  allowedRoots: string[];
  target: HostTarget;
  /** Optional remote state directory decoupling waiter/launcher state from allowedRoots[0]. */
  stateDir?: string;
  /** Optional per-host poll interval in milliseconds (default 5000, allowed 2000..60000). */
  pollIntervalMs?: number;
  /** Opt-in remote job control flag (default false; reserved for Phase 2). */
  allowJobControl?: boolean;
}

export type LogFormat = 'generic' | 'flow' | 'score' | 'reflow' | 'raw';

export interface AutoStartConfig {
  execution?: 'server_tmux';
  enabled: boolean;
  armId: string;
  gpuDeviceIds: string[];
  idleSeconds: number;
  maxUtilizationPercent: number;
  maxMemoryMiB: number;
  minFreeMemoryMiB?: number;
  minFreeDiskMiB?: number;
  gpuSharing?: { groupId: string; maxDevices: number; maxWorkersPerDevice: number };
  retryOnExit?: boolean;
  launch: { pythonPath: string; entryPath: string; cwd: string; arguments: string; logSourceId: string };
}

export interface AutoStartStatus {
  execution?: 'server_tmux';
  remoteConfirmed?: boolean;
  sessionName?: string | null;
  selectedDeviceId?: string | null;
  armId: string;
  phase: 'waiting' | 'countdown' | 'blocked' | 'starting' | 'started' | 'failed';
  idleElapsedSeconds: number;
  requiredIdleSeconds: number;
  lastCheckedAt: string | null;
  startedAt: string | null;
  pid: number | null;
  errorCode: string | null;
  message: string | null;
}

export interface TaskRegistration {
  taskId: string;
  hostId: string;
  label: string;
  enabled: boolean;
  algorithm: string;
  logFormat?: LogFormat;
  autoStart?: AutoStartConfig;
  allowedDirectories: string[];
  entryPaths: string[];
  sources: { sourceId: string; path: string; kind: 'log' | 'status_json' | 'queue_lock' }[];
  checkpointDirectories: string[];
}

export interface Registry {
  version: 2;
  revision: number;
  hosts: HostRegistration[];
  tasks: TaskRegistration[];
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  locale?: 'zh-CN' | 'en-US';
  minimizeToTrayOnClose?: boolean;
  launchAtLogin?: boolean;
  windowBounds?: WindowBounds;
}

export interface DiscoveredSshHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

export interface DiscoveredWslDistro {
  name: string;
  running: boolean;
}

export interface ConfigRecoveryNotice {
  file: 'registry' | 'preferences';
  backupPath: string;
  errorCode: string;
  recoveredAt: string;
  message: string;
}
