import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { initialCursor, prepareRead } from '../../src/logs/bytes';
import type { ReadReply, SourceObservation } from '../../src/logs/types';

const now = '2026-10-19T00:00:00.000Z';

function observation(size: number): SourceObservation {
  return { fileIdentity: { dev: '1', inode: '2' }, sizeBytes: String(size), anchors: [], observedAt: now, identityStrength: 'strong' };
}

function append(cursor: ReturnType<typeof initialCursor>, bytes: Uint8Array) {
  const start = BigInt(cursor.committedOffset);
  const end = start + BigInt(bytes.length);
  const base = observation(Number(end));
  const anchors = cursor.anchors.length > 0 ? cursor.anchors : bytes.length > 0
    ? [{ startOffset: '0', endOffset: String(Math.min(bytes.length, 4096)), sha256: createHash('sha256').update(bytes.slice(0, 4096)).digest('hex') }]
    : [];
  const obs = { ...base, anchors };
  const reply: ReadReply = {
    sourceId: cursor.sourceId,
    expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset },
    startOffset: cursor.committedOffset,
    bytes,
    before: obs,
      after: obs,
  };
  return prepareRead(cursor, reply, now, 'task-decoder');
}

describe('incremental UTF-8 and line decoding', () => {
  it('joins split Chinese UTF-8 and CRLF bytes without losing or duplicating source bytes', () => {
    const input = new TextEncoder().encode('开始\r\n结束\n');
    let cursor = initialCursor('decoder', observation(0));
    const chunks = [input.slice(0, 2), input.slice(2, 5), input.slice(5, 7), input.slice(7)];
    const stored: Uint8Array[] = [];
    const events = [] as { text: string | null; kind: string; eventId: string; startOffset: string | null; endOffset: string | null; recordComplete: boolean | null }[];

    for (const chunk of chunks) {
      const result = append(cursor, chunk);
      expect(result.kind, result.kind === 'reconcile' ? result.reason : '').toBe('append');
      if (result.kind !== 'append') return;
      stored.push(result.raw.bytes);
      events.push(...result.events);
      cursor = result.next;
      if (stored.length === 1) {
        expect(cursor.committedOffset).toBe('2');
        expect(cursor.parserState.utf8CarryBase64).not.toBe('');
        expect(events.at(-1)).toMatchObject({ recordComplete: false, text: '' });
      }
    }

    const joined = new Uint8Array(stored.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of stored) { joined.set(part, offset); offset += part.length; }
    expect(joined).toEqual(input);
    expect(cursor.committedOffset).toBe(String(input.length));
    expect(events.filter((event) => event.recordComplete).map((event) => event.text)).toEqual(['开始', '结束']);
    expect(events.find((event) => event.text === '开始' && event.recordComplete)?.endOffset).toBe('8');
  });

  it('persists pending CR across a batch and resolves a lone CR as a stable redraw', () => {
    let cursor = initialCursor('redraw', observation(0));
    const pending = append(cursor, new TextEncoder().encode('12%\r'));
    expect(pending.kind).toBe('append');
    if (pending.kind !== 'append') return;
    cursor = pending.next;
    expect(cursor.parserState.pendingCR).toBe(true);
    expect(pending.events.find((event) => event.kind === 'redraw')).toMatchObject({ recordComplete: false, startOffset: '0', endOffset: '4' });

    const resolved = append(cursor, new TextEncoder().encode('13%'));
    expect(resolved.kind).toBe('append');
    if (resolved.kind !== 'append') return;
    const redraw = resolved.events.find((event) => event.kind === 'redraw');
    expect(redraw).toMatchObject({ text: '12%', recordComplete: true, startOffset: '0', endOffset: '4' });
    expect(redraw?.eventId).toContain('redraw');
  });

  it('flushes incomplete UTF-8 at LF instead of borrowing bytes from the next record', () => {
    let cursor = initialCursor('bad-boundary', observation(0));
    const first = append(cursor, new Uint8Array([0xe4, 0x0a]));
    expect(first.kind).toBe('append');
    if (first.kind !== 'append') return;
    cursor = first.next;
    expect(first.events.find((event) => event.kind === 'line')).toMatchObject({
      text: '\ufffd',
      startOffset: '0',
      endOffset: '2',
      recordComplete: true,
      reason: 'invalid_utf8',
    });
    expect(cursor.parserState.utf8CarryBase64).toBe('');

    const second = append(cursor, new Uint8Array([0xb8, 0xad, 0x0a]));
    expect(second.kind).toBe('append');
    if (second.kind !== 'append') return;
    expect(second.events.find((event) => event.kind === 'line')).toMatchObject({ text: '\ufffd\ufffd', startOffset: '2', endOffset: '5', recordComplete: true, reason: 'invalid_utf8' });
  });

  it('persists confirmed invalid UTF-8 across JSON reload, empty reads and pending CR', () => {
    let cursor = initialCursor('invalid-carry', observation(0));
    const malformed = append(cursor, new Uint8Array([0xff]));
    expect(malformed.kind).toBe('append');
    if (malformed.kind !== 'append') return;
    expect(malformed.events.at(-1)).toMatchObject({ recordComplete: false, reason: 'invalid_utf8' });
    cursor = JSON.parse(JSON.stringify(malformed.next));

    const empty = append(cursor, new Uint8Array());
    expect(empty.kind).toBe('append');
    if (empty.kind !== 'append') return;
    cursor = JSON.parse(JSON.stringify(empty.next));
    const cr = append(cursor, new Uint8Array([0x0d]));
    expect(cr.kind).toBe('append');
    if (cr.kind !== 'append') return;
    expect(cr.next.parserState.recordInvalidUtf8).toBe(true);
    cursor = JSON.parse(JSON.stringify(cr.next));
    const emptyAfterCr = append(cursor, new Uint8Array());
    expect(emptyAfterCr.kind).toBe('append');
    if (emptyAfterCr.kind !== 'append') return;
    cursor = JSON.parse(JSON.stringify(emptyAfterCr.next));
    const lf = append(cursor, new Uint8Array([0x0a]));
    expect(lf.kind).toBe('append');
    if (lf.kind !== 'append') return;
    expect(lf.events.find((event) => event.kind === 'line')).toMatchObject({ text: '\ufffd', reason: 'invalid_utf8', recordComplete: true });
    expect(lf.next.parserState.recordInvalidUtf8).toBe(false);
  });

  it('does not mark a legal split UTF-8 character invalid while its carry is incomplete', () => {
    let cursor = initialCursor('valid-carry', observation(0));
    const first = append(cursor, new Uint8Array([0xe4]));
    expect(first.kind).toBe('append');
    if (first.kind !== 'append') return;
    expect(first.next.parserState.recordInvalidUtf8).toBe(false);
    expect(first.events.at(-1)?.reason).toBeNull();
    const second = append(first.next, new Uint8Array([0xb8, 0xad, 0x0a]));
    expect(second.kind).toBe('append');
    if (second.kind !== 'append') return;
    expect(second.events.find((event) => event.kind === 'line')).toMatchObject({ text: '中', reason: null, recordComplete: true });
  });

  it('marks a legal UTF-8 prefix invalid only when CR proves the record ended incomplete', () => {
    let cursor = initialCursor('incomplete-at-cr', observation(0));
    const lead = append(cursor, new Uint8Array([0xe4]));
    expect(lead.kind).toBe('append');
    if (lead.kind !== 'append') return;
    expect(lead.next.parserState.recordInvalidUtf8).toBe(false);
    cursor = lead.next;

    const cr = append(cursor, new Uint8Array([0x0d]));
    expect(cr.kind).toBe('append');
    if (cr.kind !== 'append') return;
    expect(cr.next.parserState.recordInvalidUtf8).toBe(true);
    cursor = JSON.parse(JSON.stringify(cr.next));

    const empty = append(cursor, new Uint8Array());
    expect(empty.kind).toBe('append');
    if (empty.kind !== 'append') return;
    cursor = JSON.parse(JSON.stringify(empty.next));
    const lf = append(cursor, new Uint8Array([0x0a]));
    expect(lf.kind).toBe('append');
    if (lf.kind !== 'append') return;
    expect(lf.events.find((event) => event.kind === 'line')).toMatchObject({ text: '\ufffd', reason: 'invalid_utf8', recordComplete: true });
  });

  it.each([
    { name: 'overlong E0 second byte', prefix: [0xe0, 0x80] },
    { name: 'surrogate ED second byte', prefix: [0xed, 0xa0] },
    { name: 'out-of-range F4 second byte', prefix: [0xf4, 0x90] },
  ])('rejects an already impossible UTF-8 prefix immediately: $name', ({ name, prefix }) => {
    let cursor = initialCursor(`impossible-${name}`, observation(0));
    const result = append(cursor, new Uint8Array(prefix));
    expect(result.kind).toBe('append');
    if (result.kind !== 'append') return;
    expect(result.events.at(-1)).toMatchObject({ reason: 'invalid_utf8', recordComplete: false });
    expect(result.events.at(-1)?.text).toContain('\ufffd');
    expect(result.next.parserState.utf8CarryBase64).toBe('');
    expect(result.next.parserState.recordInvalidUtf8).toBe(true);
    cursor = JSON.parse(JSON.stringify(result.next));

    const empty = append(cursor, new Uint8Array());
    expect(empty.kind).toBe('append');
    if (empty.kind !== 'append') return;
    expect(empty.events).toEqual([]);
    expect(empty.next.parserState.recordInvalidUtf8).toBe(true);
    expect(empty.next.parserState).toEqual(cursor.parserState);
    expect(empty.next.parserState.boundedPreview).toContain('\ufffd');
  });

  it.each([
    { name: 'E4', prefix: [0xe4], completion: [0xb8, 0xad], text: '中' },
    { name: 'E0 A0', prefix: [0xe0, 0xa0], completion: [0x80], text: '\u0800' },
    { name: 'ED 9F', prefix: [0xed, 0x9f], completion: [0xbf], text: '\ud7ff' },
    { name: 'F0 90', prefix: [0xf0, 0x90], completion: [0x80, 0x80], text: '\ud800\udc00' },
    { name: 'F4 8F', prefix: [0xf4, 0x8f], completion: [0xbf, 0xbf], text: '\udbff\udfff' },
  ])('keeps a valid incomplete prefix undecided then decodes it: $name', ({ name, prefix, completion, text }) => {
    let cursor = initialCursor(`valid-prefix-${name}`, observation(0));
    const partial = append(cursor, new Uint8Array(prefix));
    expect(partial.kind).toBe('append');
    if (partial.kind !== 'append') return;
    expect(partial.next.parserState.recordInvalidUtf8).toBe(false);
    expect(partial.next.parserState.utf8CarryBase64).not.toBe('');

    const end = prefix.length + completion.length + 1;
    const completed = append(partial.next, new Uint8Array([...completion, 0x0a]));
    expect(completed.kind).toBe('append');
    if (completed.kind !== 'append') return;
    expect(completed.events.find((event) => event.kind === 'line')).toMatchObject({ text, reason: null, recordComplete: true, startOffset: '0', endOffset: String(end) });
    expect(completed.next.parserState.recordInvalidUtf8).toBe(false);
    expect(completed.next.parserState.utf8CarryBase64).toBe('');
  });

  it('retains a pending CR and partial record over repeated empty reads', () => {
    let cursor = initialCursor('empty-after-cr', observation(0));
    const partial = append(cursor, new TextEncoder().encode('a\r'));
    expect(partial.kind).toBe('append');
    if (partial.kind !== 'append') return;
    cursor = partial.next;

    for (let i = 0; i < 3; i++) {
      const empty = append(cursor, new Uint8Array());
      expect(empty.kind).toBe('append');
      if (empty.kind !== 'append') return;
      expect(empty.events).toEqual([]);
      expect(empty.next.parserState).toEqual(cursor.parserState);
      expect(empty.next.committedOffset).toBe(cursor.committedOffset);
      cursor = empty.next;
    }

    const lf = append(cursor, new Uint8Array([0x0a]));
    expect(lf.kind).toBe('append');
    if (lf.kind !== 'append') return;
    expect(lf.events.find((event) => event.kind === 'line')).toMatchObject({ text: 'a', startOffset: '0', endOffset: '3', recordComplete: true });
  });

  it('bounds rendered preview while retaining every raw byte of an unterminated line', () => {
    const input = new Uint8Array(70 * 1024).fill(0x78);
    const cursor = initialCursor('long-line', observation(0));
    const result = append(cursor, input);
    expect(result.kind).toBe('append');
    if (result.kind !== 'append') return;
    expect(result.raw.bytes).toEqual(input);
    expect(new TextEncoder().encode(result.next.parserState.boundedPreview).length).toBeLessThanOrEqual(64 * 1024);
    expect(result.next.parserState.displayTruncated).toBe(true);
    expect(result.next.committedOffset).toBe('71680');
    expect(result.events.at(-1)).toMatchObject({ recordComplete: false, displayTruncated: true, startOffset: '0', endOffset: '71680' });
  });

  it('updates a redraw using the same event id as more preview bytes arrive', () => {
    let cursor = initialCursor('stable-redraw', observation(0));
    const first = append(cursor, new TextEncoder().encode('1%\r'));
    expect(first.kind).toBe('append');
    if (first.kind !== 'append') return;
    cursor = first.next;
    const second = append(cursor, new TextEncoder().encode('2%\r'));
    expect(second.kind).toBe('append');
    if (second.kind !== 'append') return;
    const firstRedraw = second.events.find((event) => event.kind === 'redraw');
    cursor = second.next;
    const third = append(cursor, new TextEncoder().encode('3%\n'));
    expect(third.kind).toBe('append');
    if (third.kind !== 'append') return;
    expect(third.events.find((event) => event.kind === 'redraw')?.eventId).toBe(firstRedraw?.eventId);
    expect(third.events.filter((event) => event.kind === 'redraw')).toHaveLength(1);
  });
});
