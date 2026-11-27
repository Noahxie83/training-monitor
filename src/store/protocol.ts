import type { PendingRemoteCancel } from '../launch/reconcile';
import type {
  CursorState,
  HostSnapshot,
  LogEvent,
  MetricSeriesResponse,
} from '../shared/contracts';
import type {
  ExportLogsQuery,
  ExportLogsResult,
  GpuSeriesQuery,
  GpuSeriesResponse,
  LogPage,
  LogQuery,
  LogSearchPage,
  LogSearchRequest,
  MetricSeriesQuery,
  MonitorSnapshot,
} from '../shared/api';
import type { ArchiveReadEvidence, CandidateScan, GenerationDecision, ReadReply, SourceObservation } from '../logs/types';
import type { PersistedObservation } from './engine';

export type CommitReadResult = {
  status: 'committed' | 'stale' | 'reconciling' | 'storage_error';
  events: LogEvent[];
};

export type ReconcileRequest = {
  sourceId: string;
  expected: ReadReply['expected'];
  candidateScan: CandidateScan;
  newFile: { status: 'stable'; observation: SourceObservation } | { status: 'unconfirmed' | 'missing' };
  observedAt: string;
};

export interface MetricSampleRow {
  taskId: string;
  runId: string | null;
  observedAt: string;
  step: number | null;
  metricName: string;
  value: number;
}

export interface GpuSampleRow {
  hostId: string;
  deviceId: string;
  observedAt: string;
  utilPct: number | null;
  memUsedMiB: number | null;
  memTotalMiB: number | null;
  tempC: number | null;
  powerW: number | null;
}

export interface HostSampleRow {
  hostId: string;
  observedAt: string;
  cpuPct: number | null;
  ramUsedMiB: number | null;
  ramTotalMiB: number | null;
}

export interface StoreClient {
  enqueueRemoteCancel?(item: PendingRemoteCancel): Promise<void>;
  getPendingRemoteCancels?(hostId: string): Promise<PendingRemoteCancel[]>;
  deleteRemoteCancel?(item: PendingRemoteCancel): Promise<void>;
  getCursor(sourceId: string): Promise<CursorState | null>;
  registerSource(sourceId: string, observation: SourceObservation, taskId: string): Promise<CursorState>;
  saveObservation(observation: PersistedObservation): Promise<void>;
  saveHostSnapshot?(host: HostSnapshot): Promise<void>;
  saveMetricSamples?(samples: MetricSampleRow[]): Promise<void>;
  saveGpuSamples?(samples: GpuSampleRow[]): Promise<void>;
  saveHostSamples?(samples: HostSampleRow[]): Promise<void>;
  commitRead(input: { expected: CursorState; reply: ReadReply; ingestedAt: string }): Promise<CommitReadResult['status']>;
  commitReadWithReceipt(input: { expected: CursorState; reply: ReadReply; ingestedAt: string }): Promise<CommitReadResult>;
  commitArchiveRead(input: { expected: CursorState; evidence: ArchiveReadEvidence; ingestedAt: string }): Promise<'committed' | 'stale' | 'reconciling' | 'storage_error'>;
  reconcileSource(input: ReconcileRequest): Promise<GenerationDecision | { kind: 'stale' }>;
  getSnapshot(): Promise<MonitorSnapshot>;
  getLogs(query: LogQuery): Promise<LogPage>;
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage>;
  getMetricSeries?(query: MetricSeriesQuery): Promise<MetricSeriesResponse>;
  getGpuSeries?(query: GpuSeriesQuery): Promise<GpuSeriesResponse>;
  exportLogs?(query: ExportLogsQuery): Promise<ExportLogsResult>;
  purgeOrphans?(activeHostIds: string[], activeTaskIds: string[]): Promise<void>;
  cancelRequest(requestId: string): Promise<void>;
  retain(now: string): Promise<{ pausedForDisk: boolean }>;
  close(): Promise<void>;
}

export type StoreOperation =
  | { method: 'enqueueRemoteCancel'; args: [PendingRemoteCancel] }
  | { method: 'getPendingRemoteCancels'; args: [string] }
  | { method: 'deleteRemoteCancel'; args: [PendingRemoteCancel] }
  | { method: 'getCursor'; args: [string] }
  | { method: 'registerSource'; args: [string, SourceObservation, string] }
  | { method: 'saveObservation'; args: [PersistedObservation] }
  | { method: 'saveHostSnapshot'; args: [HostSnapshot] }
  | { method: 'saveMetricSamples'; args: [MetricSampleRow[]] }
  | { method: 'saveGpuSamples'; args: [GpuSampleRow[]] }
  | { method: 'saveHostSamples'; args: [HostSampleRow[]] }
  | { method: 'commitRead'; args: [Parameters<StoreClient['commitRead']>[0]] }
  | { method: 'commitReadWithReceipt'; args: [Parameters<StoreClient['commitReadWithReceipt']>[0]] }
  | { method: 'commitArchiveRead'; args: [Parameters<StoreClient['commitArchiveRead']>[0]] }
  | { method: 'reconcileSource'; args: [ReconcileRequest] }
  | { method: 'getSnapshot'; args: [] }
  | { method: 'getLogs'; args: [LogQuery, string] }
  | { method: 'searchLogs'; args: [LogSearchRequest, string] }
  | { method: 'getMetricSeries'; args: [MetricSeriesQuery, string] }
  | { method: 'getGpuSeries'; args: [GpuSeriesQuery, string] }
  | { method: 'exportLogs'; args: [ExportLogsQuery, string] }
  | { method: 'purgeOrphans'; args: [string[], string[]] }
  | { method: 'cancelRequest'; args: [string] }
  | { method: 'retain'; args: [string] }
  | { method: 'diagnostics'; args: [] }
  | { method: 'close'; args: [] };

export type WorkerRequest = { id: number; operation: StoreOperation };
export type WorkerResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
export type StoreDiagnostics = { databaseBytes: number; walBytes: number; rawBytes: number; sqliteVersion: string };

export function asLogEvents(value: unknown): LogEvent[] { return value as LogEvent[]; }
