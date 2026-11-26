import type { Bytes, Checkpoint } from '../shared/contracts';
import { parseIsoMs } from './bindings';

export interface CheckpointEvidenceInput {
  path: string | null;
  sizeBytes: Bytes | null;
  mtime: string | null;
  fileIdentity?: { dev: string; inode: string } | null;
  scanComplete: boolean;
}

export interface CheckpointRecord extends Checkpoint {
  fileIdentity?: { dev: string; inode: string } | null;
  firstStableObservedAt?: string | null;
}

export function evaluateCheckpoint(
  previous: Checkpoint | CheckpointRecord | null,
  current: CheckpointEvidenceInput,
  observedAt: string
): CheckpointRecord {
  if (!current.path) {
    return {
      observedAt,
      freshness: 'unobserved',
      path: null,
      fileStepIndex: null,
      stepSource: null,
      sizeBytes: null,
      mtime: null,
      evidence: 'none',
      scanComplete: current.scanComplete,
      fileIdentity: null,
      firstStableObservedAt: null,
    };
  }

  let fileStepIndex: number | null = null;
  let stepSource: 'filename' | null = null;
  const filename = current.path.split(/[\\/]/).pop() || current.path;
  // Supported filename patterns only (e.g. checkpoint-30000.pt, step_1000.ckpt, iter-500.pt)
  const match = filename.match(/(?:^|[._-])(?:checkpoint|step|iter)[-_]?(\d+)(?:[._-]|$)/i);
  if (match) {
    fileStepIndex = parseInt(match[1], 10);
    stepSource = 'filename';
  }

  const currIdentity = current.fileIdentity;
  const hasCurrentIdentity = Boolean(currIdentity && currIdentity.dev && currIdentity.inode);
  const prevRecord = previous as CheckpointRecord | null;
  const prevIdentity = prevRecord?.fileIdentity ?? null;

  // Incomplete scan cannot prove stability; metadata supports file_found if observed
  if (!current.scanComplete) {
    const hasMetadata = current.sizeBytes !== null && current.mtime !== null;
    return {
      observedAt,
      freshness: 'fresh',
      path: current.path,
      fileStepIndex,
      stepSource,
      sizeBytes: current.sizeBytes,
      mtime: current.mtime,
      evidence: hasMetadata ? 'file_found' : 'none',
      scanComplete: false,
      fileIdentity: current.fileIdentity ?? null,
      firstStableObservedAt: null,
    };
  }

  if (!previous || previous.path !== current.path || previous.evidence === 'none') {
    const hasMetadata = current.sizeBytes !== null && current.mtime !== null;
    return {
      observedAt,
      freshness: 'fresh',
      path: current.path,
      fileStepIndex,
      stepSource,
      sizeBytes: current.sizeBytes,
      mtime: current.mtime,
      evidence: hasMetadata ? 'file_found' : 'none',
      scanComplete: current.scanComplete,
      fileIdentity: current.fileIdentity ?? null,
      firstStableObservedAt: hasCurrentIdentity && hasMetadata ? observedAt : null,
    };
  }

  // Both observations must have non-null matching dev/inode identity
  const identityMatches =
    prevIdentity !== null &&
    currIdentity !== null &&
    currIdentity !== undefined &&
    prevIdentity.dev !== '' &&
    prevIdentity.inode !== '' &&
    currIdentity.dev !== '' &&
    currIdentity.inode !== '' &&
    prevIdentity.dev === currIdentity.dev &&
    prevIdentity.inode === currIdentity.inode;

  const sizeMatches = previous.sizeBytes === current.sizeBytes && current.sizeBytes !== null;
  const mtimeMatches = previous.mtime === current.mtime && current.mtime !== null;

  // Any change in identity, size, or mtime resets the stability comparison chain
  if (!identityMatches || !sizeMatches || !mtimeMatches) {
    const hasMetadata = current.sizeBytes !== null && current.mtime !== null;
    return {
      observedAt,
      freshness: 'fresh',
      path: current.path,
      fileStepIndex,
      stepSource,
      sizeBytes: current.sizeBytes,
      mtime: current.mtime,
      evidence: hasMetadata ? 'file_found' : 'none',
      scanComplete: current.scanComplete,
      fileIdentity: current.fileIdentity ?? null,
      firstStableObservedAt: hasCurrentIdentity && hasMetadata ? observedAt : null,
    };
  }

  // Prior incomplete scan or missing firstStableObservedAt cannot serve as time anchor
  if (!previous.scanComplete || !prevRecord?.firstStableObservedAt) {
    const hasMetadata = current.sizeBytes !== null && current.mtime !== null;
    return {
      observedAt,
      freshness: 'fresh',
      path: current.path,
      fileStepIndex,
      stepSource,
      sizeBytes: current.sizeBytes,
      mtime: current.mtime,
      evidence: hasMetadata ? 'file_found' : 'none',
      scanComplete: current.scanComplete,
      fileIdentity: current.fileIdentity ?? null,
      firstStableObservedAt: hasCurrentIdentity && hasMetadata ? observedAt : null,
    };
  }

  const baselineTimeStr = prevRecord.firstStableObservedAt;
  const prevTime = parseIsoMs(baselineTimeStr);
  const currTime = parseIsoMs(observedAt);

  if (prevTime === null || currTime === null) {
    const hasMetadata = current.sizeBytes !== null && current.mtime !== null;
    return {
      observedAt,
      freshness: 'fresh',
      path: current.path,
      fileStepIndex,
      stepSource,
      sizeBytes: current.sizeBytes,
      mtime: current.mtime,
      evidence: hasMetadata ? 'file_found' : 'none',
      scanComplete: current.scanComplete,
      fileIdentity: current.fileIdentity ?? null,
      firstStableObservedAt: hasCurrentIdentity && hasMetadata ? observedAt : null,
    };
  }

  const diffSec = (currTime - prevTime) / 1000;

  let evidence: 'file_found' | 'file_stable_observed' = 'file_found';
  if (diffSec >= 15) {
    evidence = 'file_stable_observed';
  }

  return {
    observedAt,
    freshness: 'fresh',
    path: current.path,
    fileStepIndex,
    stepSource,
    sizeBytes: current.sizeBytes,
    mtime: current.mtime,
    evidence,
    scanComplete: current.scanComplete,
    fileIdentity: current.fileIdentity ?? null,
    firstStableObservedAt: baselineTimeStr,
  };
}