import type { Bytes, CursorState, LogEvent } from '../shared/contracts';

export type { Bytes, CursorState, LogEvent };

export interface RawChunk {
  sourceId: string;
  generation: string;
  startOffset: Bytes;
  endOffset: Bytes;
  bytes: Uint8Array;
  ingestedAt: string;
}

export interface SourceObservation {
  fileIdentity: CursorState['fileIdentity'];
  sizeBytes: Bytes;
  anchors: CursorState['anchors'];
  observedAt: string;
  identityStrength: CursorState['identityStrength'];
}

export interface ReadReply {
  sourceId: string;
  expected: { generation: string; revision: number; committedOffset: Bytes };
  startOffset: Bytes;
  bytes: Uint8Array;
  before: SourceObservation;
  after: SourceObservation;
}

export type PreparedRead =
  | { kind: 'append'; expected: ReadReply['expected']; next: CursorState; raw: RawChunk; events: LogEvent[] }
  | { kind: 'discard' }
  | { kind: 'reconcile'; reason: string };

export interface CandidateScan {
  status: 'in_progress' | 'complete' | 'inconclusive';
  ranges: { startOffset: Bytes; endOffset: Bytes }[];
}

export interface ReconcileEvidence {
  oldCursor: CursorState;
  recovery: { initialCommittedOffset: Bytes; initialMaxObservedOffset: Bytes };
  candidateScan: CandidateScan;
  newFile: { status: 'stable'; observation: SourceObservation } | { status: 'unconfirmed' | 'missing' };
  observedAt: string;
}

export type GapState =
  | { kind: 'gap_confirmed'; startOffset: Bytes; endOffset: Bytes }
  | { kind: 'gap_unknown'; startOffset: null; endOffset: null }
  | null;

export interface OldGenerationProgress {
  generation: string;
  initialCommittedOffset: Bytes;
  initialMaxObservedOffset: Bytes;
  committedOffset: Bytes;
  maxObservedOffset: Bytes;
  gap: GapState;
}

export type GenerationDecision =
  | { kind: 'recover_old'; oldGeneration: OldGenerationProgress; expected: ReadReply['expected']; range: { startOffset: Bytes; endOffset: Bytes } }
  | { kind: 'keep_reconciling'; oldGeneration: OldGenerationProgress; reason: string }
  | { kind: 'seal'; oldGeneration: OldGenerationProgress & { sealed: true }; newCursor: CursorState };

export interface ArchiveCandidateRef {
  /** Opaque ID allocated by the local registry for a known rotated archive. Never a path or remote claim. */
  kind: 'registered_rotation';
  sourceId: string;
  candidateId: string;
  registrationId: string;
}

export interface ArchiveReadEvidence {
  candidate: ArchiveCandidateRef;
  reply: ReadReply;
}
