import { describe, expect, test } from 'vitest';
import {
  decodeFrames,
  encodeFrame,
  FRAME_MAGIC,
  FrameStreamDecoder,
  PROTOCOL_VERSION,
  validateProbeEnvelope,
} from '../../src/transport/protocol';

describe('probe protocol v1 (TMF1 framed)', () => {
  test('round trips a TMF1 bounded frame and rejects length mismatch', () => {
    const payload = Buffer.from(JSON.stringify({ version: 1, requestId: 'r1', sourceId: 's1', ok: true }));
    const frame = encodeFrame(payload);
    expect(frame.subarray(0, 4)).toEqual(FRAME_MAGIC);
    expect(decodeFrames(frame)).toEqual([payload]);
    const broken = Buffer.from(frame);
    broken[7] = (broken[7]! + 1) & 0xff;
    expect(() => decodeFrames(broken)).toThrow('FRAME_LENGTH_MISMATCH');
  });

  test('skips arbitrary MOTD / .bashrc banner bytes before the TMF1 magic sentinel', () => {
    const payload = Buffer.from(JSON.stringify({ version: 1, requestId: 'r1', sourceId: null, payload: { ok: true } }));
    const motd = Buffer.from('Welcome to Ubuntu 24.04 LTS!\nLoading conda base...\n\x1b[32mReady\x1b[0m\nTMF0 false start\n');
    const combined = Buffer.concat([motd, encodeFrame(payload)]);
    expect(decodeFrames(combined)).toEqual([payload]);
  });

  test('streams frames across arbitrarily split chunks including MOTD preamble and multiple frames', () => {
    const p1 = Buffer.from(JSON.stringify({ id: 1 }));
    const p2 = Buffer.from(JSON.stringify({ id: 2, msg: 'hello' }));
    const streamData = Buffer.concat([
      Buffer.from('banner-line-1\nTMF'),
      Buffer.from('not-magic\n'),
      encodeFrame(p1),
      Buffer.from('inter-frame-noise'),
      encodeFrame(p2),
    ]);
    const decoder = new FrameStreamDecoder();
    const out: Buffer[] = [];
    for (let i = 0; i < streamData.length; i += 3) {
      out.push(...decoder.push(streamData.subarray(i, i + 3)));
    }
    expect(out).toEqual([p1, p2]);
  });

  test('rejects missing magic and oversized preamble garbage', () => {
    expect(() => decodeFrames(Buffer.from('plain text without magic'))).toThrow('FRAME_HEADER_TRUNCATED');
    expect(() => decodeFrames(Buffer.concat([Buffer.alloc(65 * 1024, 0x41), encodeFrame(Buffer.from('{}'))]))).toThrow('RESPONSE_LIMIT');
  });

  test('rejects a frame above the response limit before parsing its body', () => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(2 * 1024 * 1024 + 1);
    const header = Buffer.concat([FRAME_MAGIC, len]);
    expect(() => decodeFrames(header, { maxBytes: 2 * 1024 * 1024 })).toThrow('RESPONSE_LIMIT');
  });

  test('requires the matching v1 request and source envelope', () => {
    const expected = { version: PROTOCOL_VERSION, requestId: 'request-1', sourceId: 'log-1', payload: { ok: true } };
    expect(validateProbeEnvelope(expected, { requestId: 'request-1', sourceId: 'log-1' })).toEqual(expected);
    expect(() => validateProbeEnvelope({ ...expected, requestId: 'other' }, { requestId: 'request-1', sourceId: 'log-1' })).toThrow('PROTOCOL_REQUEST_MISMATCH');
    expect(() => validateProbeEnvelope({ ...expected, sourceId: 'other' }, { requestId: 'request-1', sourceId: 'log-1' })).toThrow('PROTOCOL_SOURCE_MISMATCH');
  });
});
