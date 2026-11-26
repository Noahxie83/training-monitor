import { createHash } from 'node:crypto';
import type { CursorState } from '../../../src/shared/contracts';
import type { ReadReply, SourceObservation } from '../../../src/logs/types';

export function observation(bytes = Buffer.alloc(0), observedAt = '2026-10-19T00:00:00.000Z'): SourceObservation {
  const anchors = bytes.length === 0 ? [] : bytes.length <= 4096
    ? [{ startOffset: '0', endOffset: String(bytes.length), sha256: createHash('sha256').update(bytes).digest('hex') }]
    : [
      { startOffset: '0', endOffset: '4096', sha256: createHash('sha256').update(bytes.subarray(0, 4096)).digest('hex') },
      { startOffset: String(bytes.length - 4096), endOffset: String(bytes.length), sha256: createHash('sha256').update(bytes.subarray(bytes.length - 4096)).digest('hex') },
    ];
  return {
    fileIdentity: { dev: '1', inode: '2' },
    identityStrength: 'strong',
    sizeBytes: String(bytes.length),
    observedAt,
    anchors,
  };
}

export function readReply(cursor: CursorState, bytes: Uint8Array, observedAt = '2026-10-19T00:00:01.000Z', fullContents?: Uint8Array): ReadReply {
  const contents = Buffer.from(bytes);
  const full = Buffer.from(fullContents ?? contents);
  const anchors = cursor.anchors.map((anchor) => {
    const chunk = full.subarray(Number(BigInt(anchor.startOffset)), Number(BigInt(anchor.endOffset)));
    return { ...anchor, sha256: createHash('sha256').update(chunk).digest('hex') };
  });
  const afterAnchors = anchors.length ? anchors : (full.length ? [{ startOffset: '0', endOffset: String(Math.min(full.length, 4096)), sha256: createHash('sha256').update(full.subarray(0, 4096)).digest('hex') }] : []);
  const endOffset = BigInt(cursor.committedOffset) + BigInt(contents.length);
  const beforeSize = BigInt(cursor.maxObservedOffset) > endOffset ? cursor.maxObservedOffset : endOffset.toString();
  const before: SourceObservation = { ...observation(full, observedAt), sizeBytes: beforeSize, anchors };
  const after: SourceObservation = { ...observation(full, observedAt), anchors: afterAnchors };
  return {
    sourceId: cursor.sourceId,
    expected: { generation: cursor.generation, revision: cursor.revision, committedOffset: cursor.committedOffset },
    startOffset: cursor.committedOffset,
    bytes: new Uint8Array(contents),
    before,
    after,
  };
}

export const NOW = '2026-10-19T00:00:00.000Z';
