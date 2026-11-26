import type { CursorState, LogEvent } from '../shared/contracts';
import type { LogPage, LogQuery, LogSearchPage, LogSearchRequest, MonitorSnapshot } from '../shared/api';
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

export interface StoreClient {
  getCursor(sourceId: string): Promise<CursorState | null>;
  registerSource(sourceId: string, observation: SourceObservation, taskId: string): Promise<CursorState>;
  saveObservation(observation: PersistedObservation): Promise<void>;
  commitRead(input: { expected: CursorState; reply: ReadReply; ingestedAt: string }): Promise<CommitReadResult['status']>;
  commitReadWithReceipt(input: { expected: CursorState; reply: ReadReply; ingestedAt: string }): Promise<CommitReadResult>;
  commitArchiveRead(input: { expected: CursorState; evidence: ArchiveReadEvidence; ingestedAt: string }): Promise<'committed' | 'stale' | 'reconciling' | 'storage_error'>;
  reconcileSource(input: ReconcileRequest): Promise<GenerationDecision | { kind: 'stale' }>;
  getSnapshot(): Promise<MonitorSnapshot>;
  getLogs(query: LogQuery): Promise<LogPage>;
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage>;
  cancelRequest(requestId: string): Promise<void>;
  retain(now: string): Promise<{ pausedForDisk: boolean }>;
  close(): Promise<void>;
}

export type StoreOperation =
  | { method: 'getCursor'; args: [string] }
  | { method: 'registerSource'; args: [string, SourceObservation, string] }
  | { method: 'saveObservation'; args: [PersistedObservation] }
  | { method: 'commitRead'; args: [Parameters<StoreClient['commitRead']>[0]] }
  | { method: 'commitReadWithReceipt'; args: [Parameters<StoreClient['commitReadWithReceipt']>[0]] }
  | { method: 'commitArchiveRead'; args: [Parameters<StoreClient['commitArchiveRead']>[0]] }
  | { method: 'reconcileSource'; args: [ReconcileRequest] }
  | { method: 'getSnapshot'; args: [] }
  | { method: 'getLogs'; args: [LogQuery, string] }
  | { method: 'searchLogs'; args: [LogSearchRequest, string] }
  | { method: 'cancelRequest'; args: [string] }
  | { method: 'retain'; args: [string] }
  | { method: 'diagnostics'; args: [] }
  | { method: 'close'; args: [] };

export type WorkerRequest = { id: number; operation: StoreOperation };
export type WorkerResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
export type StoreDiagnostics = { databaseBytes: number; walBytes: number; rawBytes: number; sqliteVersion: string };

export function asLogEvents(value: unknown): LogEvent[] { return value as LogEvent[]; }
