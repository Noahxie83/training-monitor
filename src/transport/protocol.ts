export const PROTOCOL_VERSION = 1 as const;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_STATUS_JSON_BYTES = 256 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;

export class ProtocolError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProtocolError'; }
}

export function encodeFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength > MAX_RESPONSE_BYTES) throw new ProtocolError('RESPONSE_LIMIT');
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0); Buffer.from(payload).copy(frame, 4);
  return frame;
}

export function decodeFrames(input: Uint8Array, options: { maxBytes?: number } = {}): Buffer[] {
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  if (input.byteLength > maxBytes + 4) throw new ProtocolError('RESPONSE_LIMIT');
  const bytes = Buffer.from(input); const frames: Buffer[] = []; let cursor = 0;
  while (cursor < bytes.length) {
    if (bytes.length - cursor < 4) throw new ProtocolError('FRAME_HEADER_TRUNCATED');
    const length = bytes.readUInt32BE(cursor); cursor += 4;
    if (length > maxBytes) throw new ProtocolError('RESPONSE_LIMIT');
    if (bytes.length - cursor < length) throw new ProtocolError('FRAME_LENGTH_MISMATCH');
    frames.push(bytes.subarray(cursor, cursor + length)); cursor += length;
  }
  return frames;
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
