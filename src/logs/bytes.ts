import type { CursorState } from '../shared/contracts';
import { decodeChunk, importBoundaryEvent } from './decoder';
import { anchorsMatch, hasRequiredAnchorCoverage, nextCursorAnchors } from './continuity';
import { decideGenerationTransition, initialCursor } from './generation';
import type { ArchiveReadEvidence, GenerationDecision, PreparedRead, ReadReply, ReconcileEvidence, SourceObservation } from './types';

export { decideGenerationTransition, initialCursor };

function identityStable(cursor: CursorState, before: SourceObservation, after: SourceObservation): boolean {
  if (cursor.fileIdentity) {
    const same = (identity: SourceObservation['fileIdentity']) => identity?.dev === cursor.fileIdentity?.dev && identity?.inode === cursor.fileIdentity?.inode;
    return same(before.fileIdentity) && same(after.fileIdentity)
      && before.identityStrength === cursor.identityStrength && after.identityStrength === cursor.identityStrength;
  }
  return cursor.identityStrength === 'weak'
    && before.identityStrength === 'weak' && after.identityStrength === 'weak'
    && before.fileIdentity === null && after.fileIdentity === null
    && cursor.anchors.length > 0;
}

function freshGenerationStable(cursor: CursorState, before: SourceObservation, after: SourceObservation): boolean {
  if (cursor.committedOffset !== '0' || cursor.generationStartOffset !== '0' || cursor.anchors.length !== 0) return false;
  return observedIdentityStable(before, after)
    && before.identityStrength === 'strong' && after.identityStrength === 'strong';
}

function observedIdentityStable(before: SourceObservation, after: SourceObservation): boolean {
  if (before.identityStrength !== after.identityStrength) return false;
  if (before.fileIdentity && after.fileIdentity) return before.fileIdentity.dev === after.fileIdentity.dev && before.fileIdentity.inode === after.fileIdentity.inode;
  return before.identityStrength === 'weak' && before.fileIdentity === null && after.fileIdentity === null;
}

function continuityReason(cursor: CursorState, reply: ReadReply, archiveCopy = false): string | null {
  const start = BigInt(cursor.committedOffset);
  const beforeSize = BigInt(reply.before.sizeBytes);
  const afterSize = BigInt(reply.after.sizeBytes);
  const end = start + BigInt(reply.bytes.length);
  if (beforeSize < start || afterSize < start) return 'observed_size_below_committed_offset';
  if (end > beforeSize || end > afterSize) return 'read_exceeds_observed_file_size';
  if (afterSize < beforeSize) return 'file_shrank_during_read';
  if (archiveCopy ? !observedIdentityStable(reply.before, reply.after)
    : !identityStable(cursor, reply.before, reply.after) && !freshGenerationStable(cursor, reply.before, reply.after)) return 'file_identity_changed';
  const noObservedOldBytes = BigInt(cursor.maxObservedOffset) === 0n && cursor.anchors.length === 0;
  const firstReadOfFreshGeneration = cursor.committedOffset === '0' &&
    cursor.generationStartOffset === '0';
  if (firstReadOfFreshGeneration && start === 0n) {
    if (reply.before.identityStrength !== reply.after.identityStrength) return 'file_identity_changed';
    if (reply.before.fileIdentity && reply.after.fileIdentity &&
      (reply.before.fileIdentity.dev !== reply.after.fileIdentity.dev ||
       reply.before.fileIdentity.inode !== reply.after.fileIdentity.inode)) return 'file_identity_changed';
    if (cursor.fileIdentity && reply.before.fileIdentity &&
      (reply.before.fileIdentity.dev !== cursor.fileIdentity.dev ||
       reply.before.fileIdentity.inode !== cursor.fileIdentity.inode)) return 'file_identity_changed';
    if (afterSize > 0n &&
      !hasRequiredAnchorCoverage(reply.after.anchors, '0', reply.after.sizeBytes)) return 'missing_required_anchors';
    if (cursor.anchors.length > 0 &&
      (!anchorsMatch(cursor.anchors, reply.before.anchors) || !anchorsMatch(cursor.anchors, reply.after.anchors))) {
      return 'committed_anchor_changed';
    }
    return null;
  }
  const tailGenerationStart = BigInt(cursor.generationStartOffset);
  const hasPrefixAnchor = cursor.anchors.some((anchor) => anchor.startOffset === '0');
  if (tailGenerationStart > 0n && !hasPrefixAnchor && cursor.maxObservedOffset === reply.after.sizeBytes) {
    if (reply.before.identityStrength !== reply.after.identityStrength) return 'file_identity_changed';
    if (reply.before.fileIdentity && reply.after.fileIdentity &&
      (reply.before.fileIdentity.dev !== reply.after.fileIdentity.dev ||
       reply.before.fileIdentity.inode !== reply.after.fileIdentity.inode)) return 'file_identity_changed';
    if (start === tailGenerationStart && cursor.anchors.length === 0) {
      if (reply.bytes.length === 0) return 'missing_required_anchors';
      return null;
    }
    if (!anchorsMatch(cursor.anchors, reply.before.anchors) ||
      !anchorsMatch(cursor.anchors, reply.after.anchors)) return 'committed_anchor_changed';
    if (!anchorsMatch(reply.before.anchors, reply.after.anchors)) return 'observation_changed_during_read';
    return null;
  }
  // A verified bounded tail import may start at the five MiB boundary
  // without historical anchors. A first read from byte zero still requires
  // prefix and committed-tail coverage.
  if (noObservedOldBytes && start === 0n && afterSize > 0n &&
    !hasRequiredAnchorCoverage(reply.after.anchors, '0', reply.after.sizeBytes)) return 'missing_required_anchors';
  if (!noObservedOldBytes && (!hasRequiredAnchorCoverage(cursor.anchors, cursor.committedOffset, cursor.maxObservedOffset)
    || !hasRequiredAnchorCoverage(reply.before.anchors, cursor.committedOffset, cursor.maxObservedOffset)
    || !hasRequiredAnchorCoverage(reply.after.anchors, cursor.committedOffset, cursor.maxObservedOffset))) return 'missing_required_anchors';
  if (!noObservedOldBytes && (!anchorsMatch(cursor.anchors, reply.before.anchors) || !anchorsMatch(cursor.anchors, reply.after.anchors))) return 'committed_anchor_changed';
  if (!noObservedOldBytes && !anchorsMatch(reply.before.anchors, reply.after.anchors)) return 'observation_changed_during_read';
  return null;
}

export function prepareArchiveRead(cursor: CursorState, evidence: ArchiveReadEvidence, ingestedAt: string, taskId: string): PreparedRead {
  const reply = evidence.reply;
  if (reply.sourceId !== cursor.sourceId || reply.expected.generation !== cursor.generation || reply.expected.revision !== cursor.revision || reply.expected.committedOffset !== cursor.committedOffset) return { kind: 'discard' };
  if (cursor.state !== 'reconciling') return { kind: 'reconcile', reason: 'cursor_not_reconciling' };
  if (reply.startOffset !== cursor.committedOffset) return { kind: 'discard' };
  if (evidence.candidate.kind !== 'registered_rotation' || evidence.candidate.sourceId !== cursor.sourceId || !evidence.candidate.candidateId.trim() || !evidence.candidate.registrationId.trim()) return { kind: 'reconcile', reason: 'unregistered_archive_candidate' };
  const start = BigInt(cursor.committedOffset);
  const end = start + BigInt(reply.bytes.length);
  if (end > BigInt(cursor.maxObservedOffset)) return { kind: 'reconcile', reason: 'archive_exceeds_old_observed_end' };
  const reason = continuityReason(cursor, reply, true);
  if (reason) return { kind: 'reconcile', reason };
  const decoded = decodeChunk(cursor, taskId, reply.bytes, start, ingestedAt);
  const next: CursorState = {
    ...cursor,
    revision: cursor.revision + 1,
    state: 'reconciling',
    anchors: nextCursorAnchors(cursor.anchors, start, reply.bytes),
    committedOffset: end.toString(),
    parserState: decoded.parserState,
  };
  const raw = { sourceId: cursor.sourceId, generation: cursor.generation, startOffset: start.toString(), endOffset: end.toString(), bytes: reply.bytes.slice(), ingestedAt };
  const events = [...(cursor.generationStartOffset !== '0' && cursor.revision === 0 ? [importBoundaryEvent(cursor, taskId, ingestedAt)] : []), ...decoded.events];
  return {
    kind: 'append',
    expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset },
    next,
    raw,
    events,
  };
}

export function prepareRead(cursor: CursorState, reply: ReadReply, ingestedAt: string, taskId: string): PreparedRead {
  if (reply.sourceId !== cursor.sourceId || reply.expected.generation !== cursor.generation || reply.expected.revision !== cursor.revision || reply.expected.committedOffset !== cursor.committedOffset) return { kind: 'discard' };
  if (cursor.state !== 'tracking') return { kind: 'reconcile', reason: 'cursor_already_reconciling' };
  if (reply.startOffset !== cursor.committedOffset) return { kind: 'discard' };
  const reason = continuityReason(cursor, reply);
  if (reason) return { kind: 'reconcile', reason };
  const start = BigInt(cursor.committedOffset);
  const end = start + BigInt(reply.bytes.length);
  const decoded = decodeChunk(cursor, taskId, reply.bytes, start, ingestedAt);
  let nextAnchors = nextCursorAnchors(cursor.anchors, start, reply.bytes);
  if (reply.bytes.length === 0 && start === 0n && BigInt(cursor.maxObservedOffset) === 0n && BigInt(reply.after.sizeBytes) > 0n) {
    nextAnchors = nextCursorAnchors(reply.after.anchors, start, reply.bytes).filter((anchor) => anchor.startOffset === '0');
  }
  const next: CursorState = {
    ...cursor,
    revision: cursor.revision + 1,
    state: 'tracking',
    fileIdentity: reply.after.fileIdentity,
    identityStrength: reply.after.identityStrength,
    anchors: nextAnchors,
    committedOffset: end.toString(),
    maxObservedOffset: BigInt(reply.after.sizeBytes) > BigInt(cursor.maxObservedOffset) ? reply.after.sizeBytes : cursor.maxObservedOffset,
    parserState: decoded.parserState,
  };
  const raw = { sourceId: cursor.sourceId, generation: cursor.generation, startOffset: start.toString(), endOffset: end.toString(), bytes: reply.bytes.slice(), ingestedAt };
  const events = [...(cursor.generationStartOffset !== '0' && cursor.revision === 0 ? [importBoundaryEvent(cursor, taskId, ingestedAt)] : []), ...decoded.events];
  return {
    kind: 'append',
    expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset },
    next,
    raw,
    events,
  };
}

export function transitionGeneration(input: ReconcileEvidence): GenerationDecision {
  return decideGenerationTransition(input);
}
