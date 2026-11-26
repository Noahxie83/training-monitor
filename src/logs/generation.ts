import { randomUUID } from 'node:crypto';
import type { CursorState } from '../shared/contracts';
import { selectAnchors } from './continuity';
import type { GapState, GenerationDecision, OldGenerationProgress, ReconcileEvidence, SourceObservation } from './types';

const MiB = 1024n * 1024n;
export function initialCursor(sourceId: string, observation: SourceObservation): CursorState {
  const size = BigInt(observation.sizeBytes);
  const start = size > 5n * MiB ? size - 5n * MiB : 0n;
  return {
    sourceId,
    generation: randomUUID(),
    revision: 0,
    state: 'tracking',
    identityStrength: observation.identityStrength,
    fileIdentity: observation.fileIdentity,
    generationStartOffset: start.toString(),
    committedOffset: start.toString(),
    maxObservedOffset: size.toString(),
    anchors: selectAnchors(observation.anchors),
    parserState: {
      recordStartOffset: start.toString(),
      pendingCR: false,
      utf8CarryBase64: '',
      boundedPreview: '',
      displayTruncated: false,
      prefixIncomplete: start > 0n,
    },
  };
}

export function decideGenerationTransition(input: ReconcileEvidence): GenerationDecision {
  const old = input.oldCursor;
  const committed = BigInt(old.committedOffset);
  const observed = BigInt(input.recovery.initialMaxObservedOffset);
  const initialCommitted = BigInt(input.recovery.initialCommittedOffset);
  const rangeEnd = (range: { startOffset: string; endOffset: string }) => {
    try { return [BigInt(range.startOffset), BigInt(range.endOffset)] as const; }
    catch { return null; }
  };
  const ranges = input.candidateScan.ranges
    .map(rangeEnd)
    .filter((range): range is readonly [bigint, bigint] => range !== null && range[0] >= 0n && range[1] > range[0])
    .map(([start, end]) => [start < observed ? start : observed, end < observed ? end : observed] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const oldGenerationBase = {
    generation: old.generation,
    initialCommittedOffset: input.recovery.initialCommittedOffset,
    initialMaxObservedOffset: input.recovery.initialMaxObservedOffset,
    committedOffset: old.committedOffset,
    maxObservedOffset: old.maxObservedOffset,
    gap: null,
  };
  const keep = (reason: string, gap: GapState = { kind: 'gap_unknown', startOffset: null, endOffset: null }): GenerationDecision => ({
    kind: 'keep_reconciling', oldGeneration: { ...oldGenerationBase, gap }, reason,
  });

  if (old.state !== 'reconciling') return keep('cursor_not_reconciling');
  if (committed < initialCommitted || committed > observed || initialCommitted > observed) return keep('invalid_recovery_context');

  if (committed < observed) {
    let position = committed;
    for (const [start, end] of ranges) {
      if (end <= position) continue;
      if (start > position) break;
      if (end > position) position = end;
      if (position >= observed) break;
    }
    if (position > committed) {
      return {
        kind: 'recover_old', oldGeneration: { ...oldGenerationBase, gap: null },
        expected: { generation: old.generation, revision: old.revision, committedOffset: old.committedOffset },
        range: { startOffset: old.committedOffset, endOffset: position.toString() },
      };
    }
    const hasAvailableOldBytes = ranges.some(([start, end]) => end > committed && start < observed);
    if (hasAvailableOldBytes) return keep('old_bytes_not_yet_recovered');
    if (input.candidateScan.status === 'in_progress') return keep('candidate_scan_in_progress');
    const gap: GapState = input.candidateScan.status === 'complete'
      ? { kind: 'gap_confirmed', startOffset: committed.toString(), endOffset: observed.toString() }
      : { kind: 'gap_unknown', startOffset: null, endOffset: null };
    if (input.newFile.status !== 'stable') return keep('new_file_not_stable', gap);
    return seal(input, oldGenerationBase, gap);
  }

  if (input.newFile.status !== 'stable') return keep('new_file_not_stable');
  const gap: GapState = observed === initialCommitted ? { kind: 'gap_unknown', startOffset: null, endOffset: null } : null;
  return seal(input, oldGenerationBase, gap);
}

function seal(input: ReconcileEvidence, oldGeneration: OldGenerationProgress, gap: GapState): GenerationDecision {
  if (input.newFile.status !== 'stable') return { kind: 'keep_reconciling', oldGeneration: { ...oldGeneration, gap }, reason: 'new_file_not_stable' };
  const observed = input.newFile.observation;
  const fresh = initialCursor(input.oldCursor.sourceId, { ...observed, sizeBytes: '0', anchors: selectAnchors(observed.anchors).filter((anchor) => anchor.startOffset === '0') });
  fresh.maxObservedOffset = observed.sizeBytes;
  return {
    kind: 'seal',
    oldGeneration: { ...oldGeneration, gap, sealed: true },
    newCursor: { ...fresh, generationStartOffset: '0', committedOffset: '0', parserState: { ...fresh.parserState, recordStartOffset: '0', prefixIncomplete: false } },
  };
}
