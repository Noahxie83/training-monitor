import { Buffer } from 'node:buffer';
import type { CursorState, LogEvent } from '../shared/contracts';
import type { Bytes } from './types';
import { hasAnsi, stripAnsi } from '../parsers/ansi';

const MAX_PREVIEW_BYTES = 64 * 1024;

function eventId(sourceId: string, generation: string, offset: string, kind: string): string {
  // Share one logical line ID across in-progress CR redraws and the finalized LF line
  // so tqdm/progress redraws overwrite in-place instead of leaving duplicate redraw+line rows.
  const logicalKind = kind === 'redraw' ? 'line' : kind;
  return `${sourceId}:${generation}:${offset}:${logicalKind}`;
}

function makeEvent(
  cursor: CursorState,
  taskId: string,
  kind: LogEvent['kind'],
  startOffset: Bytes | null,
  endOffset: Bytes | null,
  rawText: string | null,
  ingestedAt: string,
  complete: boolean | null,
  prefixIncomplete: boolean | null,
  truncated = false,
  diagnostic: string | null = null,
): LogEvent {
  const keyOffset = startOffset ?? 'none';
  let text = rawText;
  let rawAnsi: string | undefined;
  if (rawText !== null && hasAnsi(rawText)) {
    rawAnsi = rawText;
    text = stripAnsi(rawText);
  }
  return {
    version: 1,
    eventId: eventId(cursor.sourceId, cursor.generation, keyOffset, kind),
    taskId,
    sourceId: cursor.sourceId,
    generation: cursor.generation,
    kind,
    startOffset,
    endOffset,
    ingestedAt,
    text,
    ...(rawAnsi !== undefined ? { rawAnsi } : {}),
    reason: diagnostic ?? (kind === 'import_boundary' ? 'prefix_not_imported' : null),
    displayTruncated: truncated,
    recordComplete: complete,
    prefixIncomplete,
    runId: null,
    bindingId: null,
  };
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function trimToByteLimit(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Length(value) <= maxBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Length(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && low < value.length && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low--;
  return { text: value.slice(0, low), truncated: true };
}

function decodedPrefix(bytes: Uint8Array): { text: string; carry: Uint8Array } {
  if (!bytes.length) return { text: '', carry: bytes };
  const minimumStart = Math.max(0, bytes.length - 4);
  let splitAt = bytes.length;
  for (let start = bytes.length - 1; start >= minimumStart; start--) {
    const lead = bytes[start]!;
    const expected = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    const available = bytes.length - start;
    if (expected === 0 || available >= expected) continue;

    let possiblePrefix = true;
    for (let index = 1; index < available; index++) {
      const continuation = bytes[start + index]!;
      if ((continuation & 0xc0) !== 0x80
        || (index === 1 && lead === 0xe0 && continuation < 0xa0)
        || (index === 1 && lead === 0xed && continuation > 0x9f)
        || (index === 1 && lead === 0xf0 && continuation < 0x90)
        || (index === 1 && lead === 0xf4 && continuation > 0x8f)) {
        possiblePrefix = false;
        break;
      }
    }
    if (possiblePrefix) {
      splitAt = start;
      break;
    }
  }
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, splitAt)),
    carry: bytes.slice(splitAt),
  };
}

export interface DecodeResult {
  parserState: CursorState['parserState'];
  events: LogEvent[];
}

export function decodeChunk(cursor: CursorState, taskId: string, input: Uint8Array, chunkStart: bigint, ingestedAt: string): DecodeResult {
  if (input.length === 0) return { parserState: { ...cursor.parserState }, events: [] };
  const previousCarry = Buffer.from(cursor.parserState.utf8CarryBase64, 'base64');
  const bytes = new Uint8Array(previousCarry.length + input.length);
  bytes.set(previousCarry, 0);
  bytes.set(input, previousCarry.length);
  let state = { ...cursor.parserState };
  let preview = state.boundedPreview;
  let truncated = state.displayTruncated;
  let prefixIncomplete = state.prefixIncomplete;
  let recordStart = BigInt(state.recordStartOffset);
  let pendingCR = state.pendingCR;
  const events: LogEvent[] = [];
  let recordInvalidUtf8 = state.recordInvalidUtf8 ?? false;
  const newByteStart = chunkStart;
  const baseOffset = chunkStart - BigInt(previousCarry.length);

  const appendText = (slice: Uint8Array) => {
    const decoded = decodedPrefix(slice);
    const completeByteLength = slice.length - decoded.carry.length;
    try { new TextDecoder('utf-8', { fatal: true }).decode(slice.subarray(0, completeByteLength)); }
    catch { recordInvalidUtf8 = true; }
    const candidate = preview + decoded.text;
    const limited = trimToByteLimit(candidate, MAX_PREVIEW_BYTES);
    preview = limited.text;
    truncated ||= limited.truncated;
    state = { ...state, utf8CarryBase64: Buffer.from(decoded.carry).toString('base64') };
  };

  const flushCarryAtBoundary = () => {
    const carry = Buffer.from(state.utf8CarryBase64, 'base64');
    if (carry.length === 0) return;
    recordInvalidUtf8 = true;
    const limited = trimToByteLimit(preview + new TextDecoder('utf-8', { fatal: false }).decode(carry), MAX_PREVIEW_BYTES);
    preview = limited.text;
    truncated ||= limited.truncated;
    state = { ...state, utf8CarryBase64: '' };
  };

  let segmentStart = 0;
  const flushSegment = (end: number) => {
    if (end > segmentStart) appendText(bytes.subarray(segmentStart, end));
    segmentStart = end;
  };

  if (pendingCR) {
    if (bytes[0] === 0x0a) {
      flushSegment(0);
      flushCarryAtBoundary();
      events.push(makeEvent(cursor, taskId, 'line', recordStart.toString(), (newByteStart + 1n).toString(), preview, ingestedAt, true, prefixIncomplete, truncated, recordInvalidUtf8 ? 'invalid_utf8' : null));
      recordInvalidUtf8 = false;
      preview = '';
      truncated = false;
      prefixIncomplete = false;
      recordStart = newByteStart + 1n;
      pendingCR = false;
      segmentStart = 1;
    } else {
      flushSegment(0);
      flushCarryAtBoundary();
      const crOffset = newByteStart - 1n;
      events.push(makeEvent(cursor, taskId, 'redraw', recordStart.toString(), (crOffset + 1n).toString(), preview, ingestedAt, true, prefixIncomplete, truncated, recordInvalidUtf8 ? 'invalid_utf8' : null));
      recordInvalidUtf8 = false;
      preview = '';
      truncated = false;
      prefixIncomplete = false;
      pendingCR = false;
    }
  }

  for (let i = segmentStart; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      flushSegment(i);
      flushCarryAtBoundary();
      const end = baseOffset + BigInt(i + 1);
      events.push(makeEvent(cursor, taskId, 'line', recordStart.toString(), end.toString(), preview, ingestedAt, true, prefixIncomplete, truncated, recordInvalidUtf8 ? 'invalid_utf8' : null));
      recordInvalidUtf8 = false;
      preview = '';
      truncated = false;
      prefixIncomplete = false;
      recordStart = end;
      segmentStart = i + 1;
    } else if (byte === 0x0d) {
      flushSegment(i);
      flushCarryAtBoundary();
      if (i + 1 < bytes.length) {
        if (bytes[i + 1] === 0x0a) {
          flushCarryAtBoundary();
          const end = baseOffset + BigInt(i + 2);
          events.push(makeEvent(cursor, taskId, 'line', recordStart.toString(), end.toString(), preview, ingestedAt, true, prefixIncomplete, truncated, recordInvalidUtf8 ? 'invalid_utf8' : null));
          recordInvalidUtf8 = false;
          preview = '';
          truncated = false;
          prefixIncomplete = false;
          recordStart = end;
          i++;
          segmentStart = i + 1;
        } else {
          flushCarryAtBoundary();
          const end = baseOffset + BigInt(i + 1);
          events.push(makeEvent(cursor, taskId, 'redraw', recordStart.toString(), end.toString(), preview, ingestedAt, true, prefixIncomplete, truncated, recordInvalidUtf8 ? 'invalid_utf8' : null));
          recordInvalidUtf8 = false;
          preview = '';
          truncated = false;
          prefixIncomplete = false;
          segmentStart = i + 1;
        }
      } else {
        flushCarryAtBoundary();
        pendingCR = true;
        segmentStart = i + 1;
      }
    }
  }

  flushSegment(bytes.length);
  const readEnd = chunkStart + BigInt(input.length);
  if (input.length > 0 && recordStart < readEnd) {
    events.push(makeEvent(cursor, taskId, pendingCR ? 'redraw' : 'line', recordStart.toString(), readEnd.toString(), preview, ingestedAt, false, prefixIncomplete, truncated, recordInvalidUtf8 ? 'invalid_utf8' : null));
  }
  state = {
    recordStartOffset: recordStart.toString(),
    pendingCR,
    utf8CarryBase64: state.utf8CarryBase64,
    boundedPreview: preview,
    displayTruncated: truncated,
    prefixIncomplete,
    recordInvalidUtf8,
  };
  return { parserState: state, events };
}

export function importBoundaryEvent(cursor: CursorState, taskId: string, ingestedAt: string): LogEvent {
  const event = makeEvent(cursor, taskId, 'import_boundary', null, null, null, ingestedAt, null, null);
  return { ...event, eventId: eventId(cursor.sourceId, cursor.generation, cursor.generationStartOffset, 'import_boundary') };
}
