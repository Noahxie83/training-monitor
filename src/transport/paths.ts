import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

export class PathSafetyError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PathSafetyError'; }
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export interface OpenOptions { afterResolve?: (resolved: string) => void | Promise<void> }

export async function openRegisteredFile(candidate: string, allowedRoots: string[], options: OpenOptions = {}): Promise<FileHandle> {
  if (!path.isAbsolute(candidate) || !allowedRoots.length) throw new PathSafetyError('INVALID_PATH_REQUEST');
  let resolved: string;
  let roots: string[];
  try {
    [resolved, ...roots] = await Promise.all([realpath(candidate), ...allowedRoots.map((root) => realpath(root))]);
  } catch { throw new PathSafetyError('PATH_NOT_FOUND'); }
  if (!roots.some((root) => isWithin(root, resolved))) throw new PathSafetyError('PATH_OUTSIDE_ALLOWED_ROOT');
  let original;
  try { original = await stat(resolved); } catch { throw new PathSafetyError('PATH_NOT_FOUND'); }
  if (!original.isFile()) throw new PathSafetyError('NOT_A_REGULAR_FILE');
  await options.afterResolve?.(resolved);
  let handle: FileHandle;
  try { handle = await open(candidate, 'r'); } catch { throw new PathSafetyError('PATH_OPEN_FAILED'); }
  try {
    const [opened, afterPath, finalResolved] = await Promise.all([handle.stat(), stat(candidate), realpath(candidate)]);
    const finalAllowed = roots.some((root) => isWithin(root, finalResolved));
    if (!finalAllowed || !opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino ||
        afterPath.dev !== opened.dev || afterPath.ino !== opened.ino) {
      throw new PathSafetyError('PATH_IDENTITY_CHANGED');
    }
    return handle;
  } catch (error) {
    await handle.close();
    if (error instanceof PathSafetyError) throw error;
    throw new PathSafetyError('PATH_IDENTITY_CHANGED');
  }
}

export async function canReadOpenedFile(candidate: string, allowedRoots: string[]): Promise<boolean> {
  try { const file = await openRegisteredFile(candidate, allowedRoots); await file.close(); return true; }
  catch { return false; }
}
