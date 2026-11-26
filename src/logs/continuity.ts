import { createHash } from 'node:crypto';
import type { CursorState } from '../shared/contracts';
import type { SourceObservation } from './types';

const MAX_ANCHOR_BYTES = 4n * 1024n;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

function validRange(startOffset: string, endOffset: string): boolean {
  try {
    const start = BigInt(startOffset);
    const end = BigInt(endOffset);
    return start >= 0n && end > start && end - start <= MAX_ANCHOR_BYTES;
  } catch {
    return false;
  }
}

function validAnchors(anchors: CursorState['anchors']): CursorState['anchors'] {
  const ordered = anchors
    .filter((anchor) => validRange(anchor.startOffset, anchor.endOffset) && SHA256_HEX.test(anchor.sha256))
    .slice()
    .sort((a, b) => BigInt(a.startOffset) < BigInt(b.startOffset) ? -1 : BigInt(a.startOffset) > BigInt(b.startOffset) ? 1 : 0);
  const unique = ordered.filter((anchor, index) => index === 0 || anchor.startOffset !== ordered[index - 1].startOffset || anchor.endOffset !== ordered[index - 1].endOffset);
  return unique;
}

export function selectAnchors(anchors: CursorState['anchors']): CursorState['anchors'] {
  const valid = validAnchors(anchors);
  if (valid.length <= 2) return valid;
  return [valid[0], valid[valid.length - 1]];
}

export function hasRequiredAnchorCoverage(anchors: CursorState['anchors'], committedOffset: string, observedSize: string): boolean {
  let committed: bigint;
  let size: bigint;
  try {
    committed = BigInt(committedOffset);
    size = BigInt(observedSize);
  } catch {
    return false;
  }
  const selected = validAnchors(anchors).filter((anchor) => BigInt(anchor.endOffset) <= size);
  if (size === 0n) return selected.length === 0;
  const prefixCovered = selected.some((anchor) => BigInt(anchor.startOffset) === 0n);
  const committedTailCovered = committed === 0n || selected.some((anchor) => BigInt(anchor.startOffset) < committed && BigInt(anchor.endOffset) === committed);
  return prefixCovered && committedTailCovered;
}

export function anchorsMatch(expected: CursorState['anchors'], observed: SourceObservation['anchors']): boolean {
  const validObserved = validAnchors(observed);
  return expected.length > 0 && expected.every((anchor) => validObserved.some((current) => current.startOffset === anchor.startOffset && current.endOffset === anchor.endOffset && current.sha256.toLowerCase() === anchor.sha256.toLowerCase()));
}

export function nextCursorAnchors(previous: CursorState['anchors'], startOffset: bigint, bytes: Uint8Array): CursorState['anchors'] {
  if (bytes.length === 0) return selectAnchors(previous);
  const endOffset = startOffset + BigInt(bytes.length);
  const prefix = selectAnchors(previous).find((anchor) => anchor.startOffset === '0');
  const anchors: CursorState['anchors'] = prefix ? [prefix] : [];
  if (startOffset === 0n && bytes.length > 0) {
    const prefixLength = bytes.length > Number(MAX_ANCHOR_BYTES) ? Number(MAX_ANCHOR_BYTES) : bytes.length;
    const prefixBytes = bytes.slice(0, prefixLength);
    anchors.push({ startOffset: '0', endOffset: String(prefixLength), sha256: createHash('sha256').update(prefixBytes).digest('hex') });
  }
  if (endOffset > 0n) {
    const proposedStart = endOffset > MAX_ANCHOR_BYTES ? endOffset - MAX_ANCHOR_BYTES : 0n;
    const sampleStart = proposedStart > startOffset ? proposedStart : startOffset;
    const localStart = sampleStart > startOffset ? sampleStart - startOffset : 0n;
    const localEnd = endOffset - startOffset;
    if (localEnd > localStart) {
      const sample = bytes.slice(Number(localStart), Number(localEnd));
      if (BigInt(sample.length) === endOffset - sampleStart) {
        anchors.push({
          startOffset: sampleStart.toString(),
          endOffset: endOffset.toString(),
          sha256: createHash('sha256').update(sample).digest('hex'),
        });
      }
    }
  }
  return selectAnchors(anchors);
}
