import { describe, expect, it } from 'vitest';
import { initialCursor, prepareRead } from '../../src/logs/bytes';
import { nextCursorAnchors } from '../../src/logs/continuity';
import type { ReadReply, SourceObservation } from '../../src/logs/types';

const MiB = 1024 * 1024;
const now = '2026-10-19T00:00:00.000Z';

function observation(size: number | string, inode = '42'): SourceObservation {
  const length = BigInt(size);
  const start = length > 5n * BigInt(MiB) ? length - 5n * BigInt(MiB) : 0n;
  const anchors = length === 0n ? [] : [{ startOffset: '0', endOffset: (length < 4096n ? length : 4096n).toString(), sha256: 'a'.repeat(64) }];
  if (start > 0n) anchors.push({ startOffset: (start - 1n).toString(), endOffset: start.toString(), sha256: 'b'.repeat(64) });
  return {
    fileIdentity: { dev: '7', inode },
    sizeBytes: String(size),
    anchors,
    observedAt: now,
    identityStrength: 'strong',
  };
}

function reply(sourceId: string, generation: string, revision: number, committedOffset: string, bytes: Uint8Array, fileSize: number | string): ReadReply {
  const obs = observation(fileSize);
  const end = BigInt(committedOffset);
  const anchors = end > 0n
    ? [...obs.anchors.filter((anchor) => anchor.startOffset === '0'), { startOffset: (end - 1n).toString(), endOffset: end.toString(), sha256: 'b'.repeat(64) }]
    : obs.anchors;
  return {
    sourceId,
    expected: { generation, revision, committedOffset },
    startOffset: committedOffset,
    bytes,
    before: { ...obs, anchors },
    after: { ...obs, anchors },
  };
}

describe('raw byte cursor', () => {
  it('starts a first import at the conservative five MiB tail boundary', () => {
    const cursor = initialCursor('flow-log', observation(100 * MiB));

    expect(cursor.generationStartOffset).toBe(String(95 * MiB));
    expect(cursor.committedOffset).toBe(String(95 * MiB));
    expect(cursor.maxObservedOffset).toBe(String(100 * MiB));
  });

  it('continues a first tail import from returned bytes without inventing a prefix', () => {
    const size = 6 * MiB;
    const sourceId = 'tail-first';
    const initial: SourceObservation = {
      fileIdentity: { dev: '7', inode: '42' },
      sizeBytes: String(size),
      anchors: [],
      observedAt: now,
      identityStrength: 'strong',
    };
    const cursor = initialCursor(sourceId, initial);
    const firstBytes = new Uint8Array(64 * 1024).fill(0x61);
    const firstAnchors = nextCursorAnchors([], BigInt(cursor.committedOffset), firstBytes);
    const first = prepareRead(cursor, {
      sourceId,
      expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset },
      startOffset: cursor.committedOffset,
      bytes: firstBytes,
      before: { ...initial, anchors: firstAnchors },
      after: { ...initial, anchors: firstAnchors },
    }, now, 'task-tail');

    expect(first.kind).toBe('append');
    if (first.kind !== 'append') return;
    expect(first.next.anchors.every((anchor) => anchor.startOffset !== '0')).toBe(true);

    const secondBytes = new Uint8Array(32 * 1024).fill(0x62);
    const second = prepareRead(first.next, {
      sourceId,
      expected: {
        generation: first.next.generation,
        revision: first.next.revision,
        committedOffset: first.next.committedOffset,
      },
      startOffset: first.next.committedOffset,
      bytes: secondBytes,
      before: { ...initial, anchors: first.next.anchors },
      after: { ...initial, anchors: first.next.anchors },
    }, now, 'task-tail');

    expect(second.kind).toBe('append');
  });

  it('preserves the 201-byte first prefix record and continues exactly after LF', () => {
    const start = 95 * MiB;
    const cursor = initialCursor('flow-log', observation(100 * MiB));
    const bytes = new Uint8Array([...new Array(200).fill(0x61), 0x0a, 0x62]);
    const result = prepareRead(cursor, reply('flow-log', cursor.generation, cursor.revision, String(start), bytes, start + bytes.length), now, 'task-flow');

    expect(result.kind).toBe('append');
    if (result.kind !== 'append') return;
    expect(result.raw.startOffset).toBe(String(start));
    expect(result.raw.endOffset).toBe(String(start + bytes.length));
    expect(result.raw.bytes).toEqual(bytes);
    expect(result.events.find((event) => event.kind === 'line')).toMatchObject({
      kind: 'line',
      startOffset: String(start),
      endOffset: String(start + 201),
      prefixIncomplete: true,
      recordComplete: true,
    });
    expect(result.next.committedOffset).toBe(String(start + bytes.length));
    expect(result.next.parserState.recordStartOffset).toBe(String(start + 201));
    expect(result.next.parserState.prefixIncomplete).toBe(false);
    expect(result.events.find((event) => event.kind === 'line')?.taskId).toBe('task-flow');
  });

  it('keeps a prefix marked incomplete even when its first byte is a line boundary', () => {
    const cursor = initialCursor('flow-log', observation(6 * MiB));
    const result = prepareRead(cursor, reply('flow-log', cursor.generation, cursor.revision, cursor.committedOffset, new Uint8Array([0x0a]), 6 * MiB + 1), now, 'task-flow');

    expect(result.kind).toBe('append');
    if (result.kind !== 'append') return;
    expect(result.events.find((event) => event.kind === 'line')).toMatchObject({ kind: 'line', prefixIncomplete: true, recordComplete: true });
  });

  it('uses BigInt-safe offsets beyond JavaScript safe integer precision', () => {
    const huge = 9_007_199_254_740_993n;
    const obs = observation(0);
    const cursor = initialCursor('big-log', obs);
    const positionedAnchors = [{ startOffset: '0', endOffset: '4096', sha256: 'a'.repeat(64) }, { startOffset: (huge - 1n).toString(), endOffset: huge.toString(), sha256: 'b'.repeat(64) }];
    const positioned = { ...cursor, generationStartOffset: huge.toString(), committedOffset: huge.toString(), maxObservedOffset: huge.toString(), anchors: positionedAnchors, parserState: { ...cursor.parserState, recordStartOffset: huge.toString() } };
    const result = prepareRead(positioned, reply('big-log', positioned.generation, positioned.revision, huge.toString(), new Uint8Array([0x78]), (huge + 1n).toString()), now, 'task-big');

    expect(result.kind).toBe('append');
    if (result.kind === 'append') expect(result.next.committedOffset).toBe('9007199254740994');
  });

  it('reconciles a nonempty strongly identified file when required old-byte anchors are absent', () => {
    const original = observation(4);
    const cursor = initialCursor('anchor-required', original);
    const base = reply('anchor-required', cursor.generation, cursor.revision, cursor.committedOffset, new Uint8Array([0x78]), 5);
    const unanchored = { ...base, before: { ...base.before, anchors: [] }, after: { ...base.after, anchors: [] } };
    expect(cursor.committedOffset).toBe('0');
    expect(prepareRead(cursor, unanchored, now, 'task-anchor')).toMatchObject({ kind: 'reconcile', reason: 'missing_required_anchors' });
  });

  it('derives both prefix and current tail anchors from the first observed bytes', () => {
    const cursor = initialCursor('first-bytes', observation(0));
    const payload = new Uint8Array(8 * 1024).fill(0x6d);
    const result = prepareRead(cursor, reply('first-bytes', cursor.generation, cursor.revision, '0', payload, payload.length), now, 'task-anchor');
    expect(result.kind).toBe('append');
    if (result.kind !== 'append') return;
    expect(result.next.anchors).toHaveLength(2);
    expect(result.next.anchors[0]).toMatchObject({ startOffset: '0', endOffset: '4096' });
    expect(result.next.anchors[1]).toMatchObject({ startOffset: '4096', endOffset: '8192' });
  });

  it('keeps the old C-tail when observations also include a later sample', () => {
    const cursor = initialCursor('extra-observation-anchor', observation(10));
    const prefix = { startOffset: '0', endOffset: '4', sha256: 'a'.repeat(64) };
    const tail = { startOffset: '8', endOffset: '10', sha256: 'b'.repeat(64) };
    const extra = { startOffset: '10', endOffset: '11', sha256: 'c'.repeat(64) };
    const positioned = { ...cursor, committedOffset: '10', maxObservedOffset: '10', anchors: [prefix, tail], parserState: { ...cursor.parserState, recordStartOffset: '10' } };
    const obs = { ...observation(11), anchors: [prefix, tail, extra] };
    const result = prepareRead(positioned, {
      sourceId: positioned.sourceId,
      expected: { generation: positioned.generation, revision: positioned.revision, committedOffset: '10' },
      startOffset: '10', bytes: new Uint8Array([0x78]), before: obs, after: obs,
    }, now, 'task-anchor');
    expect(result.kind).toBe('append');
  });

  it('derives required anchors on an empty read that races initial file growth', () => {
    const cursor = initialCursor('empty-growth', observation(0));
    const grew: SourceObservation = { ...observation(2), anchors: [{ startOffset: '0', endOffset: '2', sha256: 'd'.repeat(64) }] };
    const empty = prepareRead(cursor, {
      sourceId: cursor.sourceId,
      expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: '0' },
      startOffset: '0', bytes: new Uint8Array(), before: observation(0), after: grew,
    }, now, 'task-empty-growth');
    expect(empty.kind).toBe('append');
    if (empty.kind !== 'append') return;
    expect(empty.next.maxObservedOffset).toBe('2');
    expect(empty.next.anchors).toEqual(grew.anchors);

    const nextObservation = { ...grew, sizeBytes: '4' };
    const next = prepareRead(empty.next, {
      sourceId: cursor.sourceId,
      expected: { generation: empty.next.generation, revision: empty.next.revision, committedOffset: '0' },
      startOffset: '0', bytes: new Uint8Array([0, 0, 0, 0]), before: nextObservation, after: nextObservation,
    }, now, 'task-empty-growth');
    expect(next.kind).toBe('append');
  });
});
