import { describe, expect, test } from 'vitest';
import { decodeFrames, encodeFrame, PROTOCOL_VERSION, validateProbeEnvelope } from '../../src/transport/protocol';

describe('probe protocol v1', () => {
  test('round trips a bounded frame and rejects length mismatch', () => {
    const payload = Buffer.from(JSON.stringify({ version: 1, requestId: 'r1', sourceId: 's1', ok: true }));
    const frame = encodeFrame(payload);
    expect(decodeFrames(frame)).toEqual([payload]);
    const broken = Buffer.from(frame); broken[3] += 1;
    expect(() => decodeFrames(broken)).toThrow('FRAME_LENGTH_MISMATCH');
  });

  test('rejects a frame above the response limit before parsing its body', () => {
    const header = Buffer.alloc(4); header.writeUInt32BE(2 * 1024 * 1024 + 1);
    expect(() => decodeFrames(header, { maxBytes: 2 * 1024 * 1024 })).toThrow('RESPONSE_LIMIT');
  });

  test('requires the matching v1 request and source envelope', () => {
    const expected = { version: PROTOCOL_VERSION, requestId: 'request-1', sourceId: 'log-1', payload: { ok: true } };
    expect(validateProbeEnvelope(expected, { requestId: 'request-1', sourceId: 'log-1' })).toEqual(expected);
    expect(() => validateProbeEnvelope({ ...expected, requestId: 'other' }, { requestId: 'request-1', sourceId: 'log-1' })).toThrow('PROTOCOL_REQUEST_MISMATCH');
    expect(() => validateProbeEnvelope({ ...expected, sourceId: 'other' }, { requestId: 'request-1', sourceId: 'log-1' })).toThrow('PROTOCOL_SOURCE_MISMATCH');
  });
});
