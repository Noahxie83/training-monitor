export const PROTOCOL_VERSION = 1 as const;
export const FRAME_MAGIC = Buffer.from('TMF1', 'ascii');
export const FRAME_HEADER_BYTES = 8; // 4-byte magic ("TMF1") + 4-byte big-endian uint32 length
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_STATUS_JSON_BYTES = 256 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_PREAMBLE_JUNK_BYTES = 64 * 1024;

export class ProtocolError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProtocolError'; }
}

export function encodeFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength > MAX_RESPONSE_BYTES) throw new ProtocolError('RESPONSE_LIMIT');
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  FRAME_MAGIC.copy(frame, 0);
  frame.writeUInt32BE(payload.byteLength, 4);
  Buffer.from(payload).copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export function decodeFrames(input: Uint8Array, options: { maxBytes?: number; maxPreambleBytes?: number } = {}): Buffer[] {
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxPreambleBytes = options.maxPreambleBytes ?? MAX_PREAMBLE_JUNK_BYTES;
  if (input.byteLength > maxBytes + FRAME_HEADER_BYTES + maxPreambleBytes) {
    throw new ProtocolError('RESPONSE_LIMIT');
  }
  const bytes = Buffer.from(input);
  if (bytes.length === 0) return [];
  const frames: Buffer[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const magicIndex = bytes.indexOf(FRAME_MAGIC, cursor);
    if (magicIndex < 0) {
      if (frames.length > 0) {
        // Ignore trailing whitespace/newlines after valid frames, fail on unexpected partial frame.
        const trailing = bytes.subarray(cursor);
        if (trailing.every((b) => b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09)) break;
      }
      throw new ProtocolError('FRAME_HEADER_TRUNCATED');
    }
    if (magicIndex - cursor > maxPreambleBytes) {
      throw new ProtocolError('RESPONSE_LIMIT');
    }
    cursor = magicIndex;
    if (bytes.length - cursor < FRAME_HEADER_BYTES) throw new ProtocolError('FRAME_HEADER_TRUNCATED');
    const length = bytes.readUInt32BE(cursor + 4);
    cursor += FRAME_HEADER_BYTES;
    if (length > maxBytes) throw new ProtocolError('RESPONSE_LIMIT');
    if (bytes.length - cursor < length) throw new ProtocolError('FRAME_LENGTH_MISMATCH');
    frames.push(bytes.subarray(cursor, cursor + length));
    cursor += length;
  }
  return frames;
}

/**
 * Incremental streaming frame decoder for persistent bidirectional sessions.
 * Scans past arbitrary MOTD / .bashrc stdout preamble bytes until the `TMF1` magic sentinel.
 */
export class FrameStreamDecoder {
  private buffer = Buffer.alloc(0);
  private discardedPreamble = 0;
  private readonly maxBytes: number;
  private readonly maxPreambleBytes: number;

  constructor(options: { maxBytes?: number; maxPreambleBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
    this.maxPreambleBytes = options.maxPreambleBytes ?? MAX_PREAMBLE_JUNK_BYTES;
  }

  push(chunk: Buffer | Uint8Array): Buffer[] {
    const incoming = Buffer.from(chunk);
    if (incoming.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    const frames: Buffer[] = [];

    while (this.buffer.length > 0) {
      const magicIndex = this.buffer.indexOf(FRAME_MAGIC);
      if (magicIndex < 0) {
        // Keep up to 3 trailing bytes in case "TMF1" straddles chunk boundaries.
        const keep = Math.min(3, this.buffer.length);
        const drop = this.buffer.length - keep;
        this.discardedPreamble += drop;
        if (this.discardedPreamble > this.maxPreambleBytes) {
          this.buffer = Buffer.alloc(0);
          throw new ProtocolError('RESPONSE_LIMIT');
        }
        this.buffer = this.buffer.subarray(drop);
        break;
      }
      if (magicIndex > 0) {
        this.discardedPreamble += magicIndex;
        if (this.discardedPreamble > this.maxPreambleBytes) {
          this.buffer = Buffer.alloc(0);
          throw new ProtocolError('RESPONSE_LIMIT');
        }
        this.buffer = this.buffer.subarray(magicIndex);
      }
      if (this.buffer.length < FRAME_HEADER_BYTES) break;
      const length = this.buffer.readUInt32BE(4);
      if (length > this.maxBytes) {
        this.buffer = Buffer.alloc(0);
        throw new ProtocolError('RESPONSE_LIMIT');
      }
      if (this.buffer.length < FRAME_HEADER_BYTES + length) break;
      frames.push(Buffer.from(this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)));
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length);
      this.discardedPreamble = 0;
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.discardedPreamble = 0;
  }
}

export interface ProbeEnvelope { version: 1; requestId: string; sourceId: string | null; payload: unknown }

export function validateProbeEnvelope(value: unknown, expected: { requestId: string; sourceId: string | null }): ProbeEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('PROTOCOL_SCHEMA_INVALID');
  const v = value as Record<string, unknown>;
  if (v.version !== PROTOCOL_VERSION || typeof v.requestId !== 'string' ||
      !(typeof v.sourceId === 'string' || v.sourceId === null) || !('payload' in v)) throw new ProtocolError('PROTOCOL_SCHEMA_INVALID');
  if (v.requestId !== expected.requestId) throw new ProtocolError('PROTOCOL_REQUEST_MISMATCH');
  if (v.sourceId !== expected.sourceId) throw new ProtocolError('PROTOCOL_SOURCE_MISMATCH');
  return v as unknown as ProbeEnvelope;
}
