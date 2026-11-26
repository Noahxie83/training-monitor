import { describe, expect, it } from 'vitest';
import { decideGenerationTransition, initialCursor, prepareArchiveRead, prepareRead } from '../../src/logs/bytes';
import type { ArchiveReadEvidence, ReadReply, ReconcileEvidence, SourceObservation } from '../../src/logs/types';

const MiB = 1024 * 1024;
const now = '2026-10-19T00:00:00.000Z';

function observation(size: number, bytes: number[] = [], inode = '42'): SourceObservation {
  const data = new Uint8Array(bytes);
  const length = BigInt(size);
  const start = length > 5n * BigInt(MiB) ? length - 5n * BigInt(MiB) : 0n;
  const digest = data[0] === 0x62 ? 'b'.repeat(64) : 'a'.repeat(64);
  const anchors = length > 0n ? [{ startOffset: '0', endOffset: (length < 4096n ? length : 4096n).toString(), sha256: digest }] : [];
  if (start > 0n) anchors.push({ startOffset: (start - 1n).toString(), endOffset: start.toString(), sha256: digest });
  return {
    fileIdentity: { dev: '7', inode },
    sizeBytes: String(size),
    anchors,
    observedAt: now,
    identityStrength: 'strong',
  };
}

function reply(cursor: ReturnType<typeof initialCursor>, before: SourceObservation, after: SourceObservation): ReadReply {
  return {
    sourceId: cursor.sourceId,
    expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset },
    startOffset: cursor.committedOffset,
    bytes: new Uint8Array([0x78]),
    before,
    after,
  };
}

function evidence(cursor: ReturnType<typeof initialCursor>, candidateScan: ReconcileEvidence['candidateScan'], newObservation: SourceObservation): ReconcileEvidence {
  return {
    oldCursor: { ...cursor, state: 'reconciling' },
    recovery: { initialCommittedOffset: cursor.committedOffset, initialMaxObservedOffset: cursor.maxObservedOffset },
    candidateScan,
    newFile: { status: 'stable', observation: newObservation },
    observedAt: now,
  };
}

describe('log continuity and generation changes', () => {
  it('discards a late response when the CAS revision no longer matches', () => {
    const cursor = initialCursor('source', observation(0));
    const stale: ReadReply = {
      ...reply(cursor, observation(0), observation(1)),
      expected: { generation: cursor.generation, revision: cursor.revision - 1, committedOffset: cursor.committedOffset },
    };
    expect(prepareRead(cursor, stale, now, 'task-source')).toEqual({ kind: 'discard' });
  });

  it('discards an overlapping payload with the current CAS label so the caller can reread at C', () => {
    const original = initialCursor('source', observation(1));
    const cursor = { ...original, committedOffset: '1', parserState: { ...original.parserState, recordStartOffset: '1' } };
    const overlapping: ReadReply = {
      ...reply(cursor, observation(2), observation(2)),
      startOffset: '0',
      bytes: new Uint8Array([0x61, 0x62]),
    };
    expect(prepareRead(cursor, overlapping, now, 'task-source')).toEqual({ kind: 'discard' });
  });

  it('reconciles a rewritten same inode even after its size has grown beyond old C', () => {
    const original = initialCursor('source', observation(8 * MiB, [0x61]));
    const cursor = { ...original, committedOffset: String(8 * MiB), parserState: { ...original.parserState, recordStartOffset: String(8 * MiB) } };
    const rewritten = observation(10 * MiB, [0x62]);
    const result = prepareRead(cursor, reply(cursor, rewritten, rewritten), now, 'task-source');
    expect(result).toMatchObject({ kind: 'reconcile' });
  });

  it('accepts weak file identity only when the observed anchor remains available', () => {
    const anchor = { startOffset: '0', endOffset: '4', sha256: 'c'.repeat(64) };
    const weakObservation: SourceObservation = { fileIdentity: null, sizeBytes: '4', anchors: [anchor], observedAt: now, identityStrength: 'weak' };
    const cursor = initialCursor('weak-source', weakObservation);
    const weakReply: ReadReply = {
      sourceId: 'weak-source',
      expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset },
      startOffset: '0',
      bytes: new Uint8Array([0x78]),
      before: weakObservation,
      after: { ...weakObservation, sizeBytes: '5' },
    };
    expect(prepareRead(cursor, weakReply, now, 'task-weak').kind).toBe('append');
    expect(prepareRead(cursor, { ...weakReply, after: { ...weakReply.after, anchors: [{ ...anchor, sha256: 'd'.repeat(64) }] } }, now, 'task-weak')).toMatchObject({ kind: 'reconcile', reason: 'committed_anchor_changed' });
  });

  it('creates a new generation at zero and reports unknown when old H equals C', () => {
    const original = initialCursor('source', observation(8 * MiB, [0x61]));
    const cursor = { ...original, committedOffset: String(8 * MiB), parserState: { ...original.parserState, recordStartOffset: String(8 * MiB) } };
    const decision = decideGenerationTransition(evidence(cursor, { status: 'complete', ranges: [] }, observation(10 * MiB, [0x62])));
    expect(decision.kind).toBe('seal');
    if (decision.kind !== 'seal') return;
    expect(decision.oldGeneration.gap).toMatchObject({ kind: 'gap_unknown', startOffset: null, endOffset: null });
    expect(decision.newCursor.generation).not.toBe(cursor.generation);
    expect(decision.newCursor.generationStartOffset).toBe('0');
    expect(decision.newCursor.committedOffset).toBe('0');
    expect(decision.newCursor.maxObservedOffset).toBe(String(10 * MiB));
    expect(decision.newCursor.anchors).toEqual(observation(10 * MiB, [0x62]).anchors.slice(0, 1));
  });

  it('confirms only the known unavailable old interval after a complete candidate scan', () => {
    const cursor = { ...initialCursor('source', observation(10 * MiB)), committedOffset: String(8 * MiB) };
    const decision = decideGenerationTransition(evidence(cursor, { status: 'complete', ranges: [] }, observation(10 * MiB, [0x62])));
    expect(decision.kind).toBe('seal');
    if (decision.kind !== 'seal') return;
    expect(decision.oldGeneration.gap).toEqual({ kind: 'gap_confirmed', startOffset: String(8 * MiB), endOffset: String(10 * MiB) });
    expect(decision.newCursor.committedOffset).toBe('0');
  });

  it('does not report a gap when a candidate contains the full unread old range', () => {
    const cursor = { ...initialCursor('source', observation(10 * MiB)), committedOffset: String(8 * MiB) };
    const decision = decideGenerationTransition(evidence(cursor, { status: 'inconclusive', ranges: [{ startOffset: String(8 * MiB), endOffset: String(10 * MiB) }] }, observation(10 * MiB, [0x62])));
    expect(decision.kind).toBe('recover_old');
    if (decision.kind !== 'recover_old') return;
    expect(decision.oldGeneration.gap).toBeNull();
    expect(decision.range).toEqual({ startOffset: String(8 * MiB), endOffset: String(10 * MiB) });
    expect(decision.oldGeneration.committedOffset).toBe(String(8 * MiB));
  });

  it('leaves a missing range unknown when candidate scanning was incomplete', () => {
    const cursor = { ...initialCursor('source', observation(10 * MiB)), committedOffset: String(8 * MiB) };
    const decision = decideGenerationTransition(evidence(cursor, { status: 'in_progress', ranges: [] }, observation(10 * MiB, [0x62])));
    expect(decision.kind).toBe('keep_reconciling');
    if (decision.kind !== 'keep_reconciling') return;
    expect(decision.oldGeneration.gap).toMatchObject({ kind: 'gap_unknown', startOffset: null, endOffset: null });
  });

  it('seals without a gap only after a durable cursor reaches the initially observed H', () => {
    const initial = { ...initialCursor('source', observation(10 * MiB)), committedOffset: String(8 * MiB) };
    const context: ReconcileEvidence = {
      ...evidence(initial, { status: 'complete', ranges: [{ startOffset: String(8 * MiB), endOffset: String(10 * MiB) }] }, observation(1)),
      recovery: { initialCommittedOffset: String(8 * MiB), initialMaxObservedOffset: String(10 * MiB) },
    };
    const offer = decideGenerationTransition(context);
    expect(offer.kind).toBe('recover_old');
    const durable = { ...initial, committedOffset: String(10 * MiB), revision: initial.revision + 1 };
    const completed = decideGenerationTransition({ ...context, oldCursor: { ...durable, state: 'reconciling' }, candidateScan: { status: 'in_progress', ranges: [] } });
    expect(completed.kind).toBe('seal');
    if (completed.kind === 'seal') expect(completed.oldGeneration.gap).toBeNull();
  });

  it('keeps a generation reconciling until the replacement file is explicitly stable', () => {
    const cursor = { ...initialCursor('source', observation(10 * MiB)), committedOffset: String(10 * MiB), state: 'reconciling' as const };
    const decision = decideGenerationTransition({
      ...evidence(cursor, { status: 'complete', ranges: [] }, observation(2)),
      newFile: { status: 'unconfirmed' },
    });
    expect(decision).toMatchObject({ kind: 'keep_reconciling', reason: 'new_file_not_stable' });
  });

  it('seals an ended inconclusive scan with unknown gap once the new file is stable', () => {
    const cursor = { ...initialCursor('source', observation(10 * MiB)), committedOffset: String(8 * MiB), state: 'reconciling' as const };
    const decision = decideGenerationTransition(evidence(cursor, { status: 'inconclusive', ranges: [] }, observation(2, [0x62])));
    expect(decision.kind).toBe('seal');
    if (decision.kind === 'seal') expect(decision.oldGeneration.gap).toEqual({ kind: 'gap_unknown', startOffset: null, endOffset: null });
  });

  it('keeps an in-progress scan reconciling while unavailable old bytes remain', () => {
    const cursor = { ...initialCursor('source', observation(10 * MiB)), committedOffset: String(8 * MiB), state: 'reconciling' as const };
    const decision = decideGenerationTransition(evidence(cursor, { status: 'in_progress', ranges: [] }, observation(2, [0x62])));
    expect(decision.kind).toBe('keep_reconciling');
  });

  it('keeps an inconclusive ended scan reconciling until the replacement is stable', () => {
    const cursor = { ...initialCursor('source', observation(10 * MiB)), committedOffset: String(8 * MiB), state: 'reconciling' as const };
    const decision = decideGenerationTransition({
      ...evidence(cursor, { status: 'inconclusive', ranges: [] }, observation(2, [0x62])),
      newFile: { status: 'unconfirmed' },
    });
    expect(decision).toMatchObject({ kind: 'keep_reconciling', reason: 'new_file_not_stable' });
    if (decision.kind === 'keep_reconciling') expect(decision.oldGeneration.gap).toEqual({ kind: 'gap_unknown', startOffset: null, endOffset: null });
  });

  it('prepares a CAS-checked old-generation append from a registered stable archive copy', () => {
    const cursor = initialCursor('source', observation(4));
    const prefix = { startOffset: '0', endOffset: '1', sha256: 'a'.repeat(64) };
    const tail = { startOffset: '1', endOffset: '2', sha256: 'b'.repeat(64) };
    const reconciling = { ...cursor, state: 'reconciling' as const, committedOffset: '2', maxObservedOffset: '4', anchors: [prefix, tail], parserState: { ...cursor.parserState, recordStartOffset: '2' } };
    const archiveObs: SourceObservation = { fileIdentity: { dev: '8', inode: '99' }, sizeBytes: '4', anchors: [prefix, tail], observedAt: now, identityStrength: 'strong' };
    const archiveEvidence: ArchiveReadEvidence = {
      candidate: { kind: 'registered_rotation', sourceId: 'source', candidateId: 'rotated-1', registrationId: 'registration-1' },
      reply: { ...reply(reconciling, archiveObs, archiveObs), startOffset: '2', bytes: new Uint8Array([0x63, 0x64]) },
    };
    const result = prepareArchiveRead(reconciling, archiveEvidence, now, 'task-source');
    expect(prepareRead(reconciling, archiveEvidence.reply, now, 'task-source')).toMatchObject({ kind: 'reconcile', reason: 'cursor_already_reconciling' });
    expect(result.kind).toBe('append');
    if (result.kind !== 'append') return;
    expect(result.raw).toMatchObject({ generation: cursor.generation, startOffset: '2', endOffset: '4' });
    expect(result.raw.bytes).toEqual(new Uint8Array([0x63, 0x64]));
    expect(result.next).toMatchObject({ state: 'reconciling', generation: cursor.generation, committedOffset: '4', maxObservedOffset: '4' });
    expect(prepareArchiveRead(reconciling, { ...archiveEvidence, reply: { ...archiveEvidence.reply, after: { ...archiveEvidence.reply.after, fileIdentity: { dev: '8', inode: '100' } } } }, now, 'task-source')).toMatchObject({ kind: 'reconcile', reason: 'file_identity_changed' });
    expect(prepareArchiveRead(reconciling, { ...archiveEvidence, candidate: { ...archiveEvidence.candidate, sourceId: 'other-source' } }, now, 'task-source')).toMatchObject({ kind: 'reconcile', reason: 'unregistered_archive_candidate' });
  });

  it('discards stale CAS and reconciles an archive copy whose old content anchors do not match', () => {
    const cursor = initialCursor('source', observation(4));
    const anchors = [
      { startOffset: '0', endOffset: '1', sha256: 'a'.repeat(64) },
      { startOffset: '1', endOffset: '2', sha256: 'b'.repeat(64) },
    ];
    const reconciling = { ...cursor, state: 'reconciling' as const, committedOffset: '2', maxObservedOffset: '4', anchors, parserState: { ...cursor.parserState, recordStartOffset: '2' } };
    const changed: SourceObservation = { fileIdentity: { dev: '8', inode: '99' }, sizeBytes: '4', anchors: anchors.map((anchor) => ({ ...anchor, sha256: 'c'.repeat(64) })), observedAt: now, identityStrength: 'strong' };
    const base: ArchiveReadEvidence = { candidate: { kind: 'registered_rotation', sourceId: 'source', candidateId: 'rotated-1', registrationId: 'registration-1' }, reply: { ...reply(reconciling, changed, changed), startOffset: '2', bytes: new Uint8Array([0x63, 0x64]) } };
    expect(prepareArchiveRead(reconciling, { ...base, reply: { ...base.reply, expected: { ...base.reply.expected, revision: base.reply.expected.revision - 1 } } }, now, 'task-source')).toEqual({ kind: 'discard' });
    expect(prepareArchiveRead(reconciling, base, now, 'task-source')).toMatchObject({ kind: 'reconcile', reason: 'committed_anchor_changed' });
  });
});
