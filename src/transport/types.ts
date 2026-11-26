import type {
  AcceleratorAvailability,
  DiscoveredProcess,
  GpuDeviceDetail,
  HostRegistration,
  HostSystemHealth,
  JobControlAction,
  JobControlResult,
  ProcessKey,
  Registry,
  ResourceMetric,
  TaskRegistration,
} from '../shared/contracts';
import type { ArchiveCandidateRef, ReadReply, SourceObservation } from '../logs/types';

export type ProbePhase =
  | 'wsl_list'
  | 'connect'
  | 'python_start'
  | 'probe'
  | 'process_scan'
  | 'frame'
  | 'validate'
  | 'source_read'
  | 'dispatch'
  | 'archive_scan';
export type ErrorScope = 'host' | 'task' | 'request' | 'source';
export type TransportErrorCode =
  | 'CONNECT_FAILED'
  | 'PROBE_TIMEOUT'
  | 'PROBE_CANCELLED'
  | 'RESPONSE_LIMIT'
  | 'STDERR_LIMIT'
  | 'PROTOCOL_INVALID'
  | 'REGISTRY_CHANGED'
  | 'SOURCE_MISSING'
  | 'SOURCE_PERMISSION'
  | 'READ_LIMIT_INVALID'
  | 'SCAN_INCOMPLETE'
  | 'SSH_HOST_KEY_UNKNOWN'
  | 'SSH_AUTH_FAILED'
  | 'SSH_CONNECTION_REFUSED'
  | 'SSH_TIMEOUT'
  | 'REMOTE_PYTHON_UNAVAILABLE'
  | 'WSL_NOT_RUNNING'
  | 'HOST_UNREACHABLE';

export interface HostObservation {
  hostId: string;
  freshness: 'fresh' | 'stale' | 'unobserved';
  observedAt: string | null;
  phase: ProbePhase | null;
  connection: 'connected' | 'disconnected' | 'unobserved';
  scanComplete: boolean;
  hostBootId: string | null;
  errorCode: string | null;
  errorScope?: ErrorScope | null;
  acceleratorAvailability?: AcceleratorAvailability;
  gpu?: HostGpuObservation;
  system?: HostSystemHealth;
}

export interface HostGpuObservation {
  observedAt: string | null;
  state: 'available' | 'unavailable';
  acceleratorAvailability?: AcceleratorAvailability;
  errorCode: string | null;
  metrics: ResourceMetric[];
  devices?: GpuDeviceDetail[];
}

export interface SourceTaskObservation {
  sourceId: string;
  observedAt: string | null;
  fileIdentity: SourceObservation['fileIdentity'] | null;
  eofBytes: string | null;
  permission: 'readable' | 'denied' | 'missing' | 'unknown';
  exists: boolean | null;
  statusValues: Record<string, string | number | boolean | null> | null;
  statusRawContent?: string | null;
  heldByRegisteredProcess: boolean | null;
  errorCode: string | null;
  evidenceComplete?: boolean;
  errorScope?: 'source' | null;
  phase: ProbePhase | null;
  resolvedPath?: string | null;
}

export interface TaskProcessObservation {
  key: ProcessKey;
  role: 'trainer' | 'queue' | 'worker' | 'unknown';
  ppid?: number | null;
  pgid?: number | null;
  nsPid?: number | null;
  cwd: string | null;
  scriptEntry: string | null;
  launcherEntry?: string | null;
  exe?: string | null;
  command?: string | null;
  observedAt: string;
  roleEvidence: 'exact_script_entry' | 'exact_entry_and_direct_writer_fd' | 'none';
  directWriterSourceIds: string[];
  writerSourceEvidence?: Record<string, { fileIdentity: SourceObservation['fileIdentity']; eofBytes: string }>;
  writerEvidenceComplete: boolean;
  evidenceComplete: boolean;
  fdScanTruncated?: boolean;
  treeMember?: boolean;
  rssBytes?: number | null;
  cpuPercent?: number | null;
  interpreterFlags: string[];
}

export interface CheckpointScanObservation {
  scanComplete: boolean;
  latest: {
    path: string;
    name: string;
    isDirectory: boolean;
    fileCount: number | null;
    sizeBytes: string;
    mtime: string;
    fileIdentity: { dev: string; inode: string } | null;
    fileStepIndex: number | null;
    stepSource: 'filename' | 'metadata' | null;
    metadata?: Record<string, string | number | boolean | null>;
  } | null;
  errorCode: string | null;
}

export interface TaskObservation {
  taskId: string;
  hostId: string;
  observedAt: string | null;
  freshness: 'fresh' | 'stale' | 'unobserved';
  scanComplete: boolean;
  processScanError: string | null;
  phase: ProbePhase | null;
  processes: TaskProcessObservation[];
  sources: SourceTaskObservation[];
  errorCode: string | null;
  errorScope?: ErrorScope | null;
  processGpu?: ProcessGpuObservation;
  checkpointScan?: CheckpointScanObservation | null;
  fdScanTruncated?: boolean;
}

export interface ProcessGpuObservation {
  observedAt: string | null;
  state: 'available' | 'unavailable';
  errorCode: string | null;
  processKeys: ProcessKey[];
  metrics: ResourceMetric[];
}

export interface BatchProbeObservation {
  host: HostObservation;
  tasks: Map<string, TaskObservation>;
}

export interface RegistrationReference { taskId: string; registryRevision: number; fingerprint: string }
export interface CursorLabel { generation: string; revision: number; committedOffset: string }
export interface SampleAnchor { startOffset: string; length: number; sha256: string }
export interface ReadRequest {
  kind: 'current' | 'registered_rotation';
  sourceId: string;
  offset: string;
  limitBytes: number;
  expected: CursorLabel;
  registration: RegistrationReference;
  anchors: SampleAnchor[];
  candidate?: ArchiveCandidateRef;
}

export interface ReadResult { reply: ReadReply; isCurrentFile: boolean }

export interface LaunchResult {
  status: 'started' | 'busy' | 'already_running' | 'failed';
  pid: number | null;
  processKey: ProcessKey | null;
  startedAt: string | null;
  errorCode: string | null;
  exitCode?: number | null;
}

export interface ServerWaitResult {
  state: 'missing' | 'waiting' | 'countdown' | 'blocked' | 'starting' | 'started' | 'failed' | 'cancelled';
  armId: string;
  configHash: string;
  idleElapsedSeconds: number;
  requiredIdleSeconds: number;
  lastCheckedAt: string | null;
  startedAt: string | null;
  pid: number | null;
  errorCode: string | null;
  errorParams?: Record<string, string | number | boolean> | null;
  message: string | null;
  sessionName: string | null;
  selectedDeviceId: string | null;
  selectedDeviceIds?: string[];
  retryCount?: number;
  maxRetries?: number;
  exitCode?: number | null;
  backend?: 'tmux' | 'systemd_run' | 'setsid';
}

export interface Transport {
  ensureServerWait?(task: TaskRegistration, configHash: string, signal: AbortSignal): Promise<ServerWaitResult>;
  getServerWait?(task: TaskRegistration, configHash: string, signal: AbortSignal): Promise<ServerWaitResult>;
  cancelServerWait?(task: TaskRegistration, configHash: string, signal: AbortSignal): Promise<ServerWaitResult>;
  checkTaskStopped?(task: TaskRegistration, signal: AbortSignal): Promise<{ scanComplete: boolean; running: boolean; errorCode: string | null }>;
  launchTask?(task: TaskRegistration, armId: string, configHash: string, signal: AbortSignal): Promise<LaunchResult>;
  discoverProcesses?(signal: AbortSignal): Promise<DiscoveredProcess[]>;
  signalTask?(
    task: TaskRegistration,
    action: JobControlAction,
    processKeys: ProcessKey[],
    signal: AbortSignal,
  ): Promise<JobControlResult>;
  probeHost(signal: AbortSignal): Promise<HostObservation>;
  probeTask(task: TaskRegistration, signal: AbortSignal): Promise<TaskObservation>;
  probeHostAndTasks?(tasks: TaskRegistration[], signal: AbortSignal): Promise<BatchProbeObservation>;
  readLog(request: ReadRequest, signal: AbortSignal): Promise<ReadReply>;
  scanArchiveCandidates(sourceId: string, registration: RegistrationReference, anchors: SampleAnchor[], signal: AbortSignal): Promise<ArchiveCandidateScan>;
  createRegistrationReference(taskId: string): Promise<RegistrationReference>;
  close?(): Promise<void>;
}

export interface ArchiveCandidateScan {
  status: 'in_progress' | 'complete' | 'inconclusive';
  candidates: { reference: ArchiveCandidateRef; startOffset: string; endOffset: string }[];
  errorCode: string | null;
  errorScope?: ErrorScope | null;
  phase?: ProbePhase | null;
  requestId?: string | null;
  sourceId?: string | null;
  observedAt: string;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { shell: false; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true; detached?: boolean },
) => any;
export interface TransportHostContext { hostId: string; host: HostRegistration; registry: Registry }
