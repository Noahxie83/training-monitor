import type { Bytes, Checkpoint } from '../shared/contracts';
import { parseIsoMs } from './bindings';

export interface CheckpointEvidenceInput {
  path: string | null;
  name?: string | null;
  isDirectory?: boolean;
  fileCount?: number | null;
  sizeBytes: Bytes | null;
  mtime: string | null;
  fileIdentity?: { dev: string; inode: string } | null;
  fileStepIndex?: number | null;
  stepSource?: 'filename' | 'metadata' | null;
  metadata?: Record<string, string | number | boolean | null> | null;
  scanComplete: boolean;
}

export interface CheckpointRecord extends Checkpoint {
  fileIdentity?: { dev: string; inode: string } | null;
  firstStableObservedAt?: string | null;
}

export function extractCheckpointStepFromName(filename: string): number | null {
  // Supports:
  // - checkpoint-30000.pt, checkpoint-1500, step_1000.ckpt, iter-500.pt
  // - global_step1000, global_step_2500
  // - epoch=3-step=1500.ckpt, epoch_3_step_1500.ckpt
  // - iter_0001000 (Megatron)
  const explicitStep = filename.match(/(?:^|[._-])(?:global_?step|checkpoint|step|iter)[-_=\s]?(\d+)(?:[._-]|$)/i);
  if (explicitStep) {
    const parsed = parseInt(explicitStep[1]!, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  const epochStep = filename.match(/(?:^|[._-])step[=_](\d+)(?:[._-]|$)/i);
  if (epochStep) {
    const parsed = parseInt(epochStep[1]!, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
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
      name: null,
      isDirectory: false,
      fileCount: null,
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

  const filename = current.name || current.path.split(/[\\/]/).filter(Boolean).pop() || current.path;
  let fileStepIndex: number | null =
    typeof current.fileStepIndex === 'number' && Number.isSafeInteger(current.fileStepIndex) && current.fileStepIndex >= 0
      ? current.fileStepIndex
      : null;
  let stepSource: 'filename' | 'metadata' | null = fileStepIndex !== null ? (current.stepSource ?? 'metadata') : null;

  if (fileStepIndex === null) {
    const parsedStep = extractCheckpointStepFromName(filename);
    if (parsedStep !== null) {
      fileStepIndex = parsedStep;
      stepSource = 'filename';
    }
  }

  const isDirectory = Boolean(current.isDirectory);
  const fileCount = typeof current.fileCount === 'number' && Number.isSafeInteger(current.fileCount) ? current.fileCount : null;
  const metadata = current.metadata ?? undefined;

  const extraFields = {
    name: filename,
    ...(isDirectory ? { isDirectory: true } : {}),
    ...(fileCount !== null ? { fileCount } : {}),
    ...(metadata ? { metadata } : {}),
  };

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
      ...extraFields,
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
      ...extraFields,
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
  const fileCountMatches = (previous.fileCount ?? null) === fileCount;

  // Any change in identity, size, fileCount, or mtime resets the stability comparison chain
  if (!identityMatches || !sizeMatches || !mtimeMatches || !fileCountMatches) {
    const hasMetadata = current.sizeBytes !== null && current.mtime !== null;
    return {
      observedAt,
      freshness: 'fresh',
      path: current.path,
      ...extraFields,
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
      ...extraFields,
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
      ...extraFields,
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
  const evidence: 'file_found' | 'file_stable_observed' = diffSec >= 15 ? 'file_stable_observed' : 'file_found';

  return {
    observedAt,
    freshness: 'fresh',
    path: current.path,
    ...extraFields,
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
