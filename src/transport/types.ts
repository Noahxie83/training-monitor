import type { HostRegistration, ProcessKey, Registry, ResourceMetric, TaskRegistration } from '../shared/contracts';
import type { ArchiveCandidateRef, ReadReply, SourceObservation } from '../logs/types';

export type ProbePhase = 'wsl_list' | 'connect' | 'python_start' | 'probe' | 'process_scan' | 'frame' | 'validate' | 'source_read' | 'dispatch' | 'archive_scan';
export type ErrorScope = 'host' | 'task' | 'request' | 'source';
export type TransportErrorCode = 'CONNECT_FAILED' | 'PROBE_TIMEOUT' | 'PROBE_CANCELLED' | 'RESPONSE_LIMIT' | 'STDERR_LIMIT' | 'PROTOCOL_INVALID' | 'REGISTRY_CHANGED' | 'SOURCE_MISSING' | 'SOURCE_PERMISSION' | 'READ_LIMIT_INVALID' | 'SCAN_INCOMPLETE';

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
  gpu?: HostGpuObservation;
}

export interface HostGpuObservation {
  observedAt: string | null;
  state: 'available' | 'unavailable';
  errorCode: string | null;
  metrics: ResourceMetric[];
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
}

export interface TaskProcessObservation {
  key: ProcessKey;
  role: 'trainer' | 'queue' | 'worker' | 'unknown';
  cwd: string | null;
  scriptEntry: string | null;
  launcherEntry?: string | null;
  observedAt: string;
  roleEvidence: 'exact_script_entry' | 'exact_entry_and_direct_writer_fd' | 'none';
  directWriterSourceIds: string[];
  writerSourceEvidence?: Record<string, { fileIdentity: SourceObservation['fileIdentity']; eofBytes: string }>;
  writerEvidenceComplete: boolean;
  evidenceComplete: boolean;
  interpreterFlags: string[];
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
}

export interface ProcessGpuObservation {
  observedAt: string | null;
  state: 'available' | 'unavailable';
  errorCode: string | null;
  processKeys: ProcessKey[];
  metrics: ResourceMetric[];
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

export interface LaunchResult { status: 'started' | 'busy' | 'already_running' | 'failed'; pid: number | null; processKey: ProcessKey | null; startedAt: string | null; errorCode: string | null }

export interface ServerWaitResult { state: 'missing' | 'waiting' | 'countdown' | 'blocked' | 'starting' | 'started' | 'failed' | 'cancelled'; armId: string; configHash: string; idleElapsedSeconds: number; requiredIdleSeconds: number; lastCheckedAt: string | null; startedAt: string | null; pid: number | null; errorCode: string | null; message: string | null; sessionName: string | null; selectedDeviceId: string | null }

export interface Transport {
  ensureServerWait?(task: TaskRegistration, configHash: string, signal: AbortSignal): Promise<ServerWaitResult>;
  getServerWait?(task: TaskRegistration, configHash: string, signal: AbortSignal): Promise<ServerWaitResult>;
  cancelServerWait?(task: TaskRegistration, configHash: string, signal: AbortSignal): Promise<ServerWaitResult>;
  checkTaskStopped?(task: TaskRegistration, signal: AbortSignal): Promise<{ scanComplete: boolean; running: boolean; errorCode: string | null }>;
  launchTask?(task: TaskRegistration, armId: string, configHash: string, signal: AbortSignal): Promise<LaunchResult>;
  probeHost(signal: AbortSignal): Promise<HostObservation>;
  probeTask(task: TaskRegistration, signal: AbortSignal): Promise<TaskObservation>;
  readLog(request: ReadRequest, signal: AbortSignal): Promise<ReadReply>;
  scanArchiveCandidates(sourceId: string, registration: RegistrationReference, anchors: SampleAnchor[], signal: AbortSignal): Promise<ArchiveCandidateScan>;
  createRegistrationReference(taskId: string): Promise<RegistrationReference>;
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

export type SpawnLike = (command: string, args: string[], options: { shell: false; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true }) => any;
export interface TransportHostContext { hostId: string; host: HostRegistration; registry: Registry }
