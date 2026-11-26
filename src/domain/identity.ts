import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProcessKey, TaskRegistration } from '../shared/contracts';

export function isStrongProcessKey(key: ProcessKey | null | undefined): key is ProcessKey {
  if (!key) return false;
  if (typeof key.hostBootId !== 'string' || key.hostBootId.trim().length === 0) return false;
  if (typeof key.pid !== 'number' || !Number.isInteger(key.pid) || key.pid <= 0) return false;
  if (typeof key.startTicks !== 'string' || !/^\d+$/.test(key.startTicks) || key.startTicks.length === 0) return false;
  return true;
}

export function areProcessKeysEqual(a: ProcessKey | null | undefined, b: ProcessKey | null | undefined): boolean {
  if (!isStrongProcessKey(a) || !isStrongProcessKey(b)) return false;
  return a.hostBootId === b.hostBootId && a.pid === b.pid && a.startTicks === b.startTicks;
}

export function makeRunId(hostId: string, taskId: string, key: ProcessKey): string {
  if (!isStrongProcessKey(key)) {
    throw new Error('Invalid ProcessKey for runId: requires valid hostBootId, positive integer pid, and digits startTicks');
  }
  const tuple = [hostId, taskId, key.hostBootId, key.pid, key.startTicks];
  const json = JSON.stringify(tuple);
  return 'run:v1:' + createHash('sha256').update(json, 'utf8').digest('hex');
}

function normalizePosix(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function normalizeModuleEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.startsWith('module:')) return trimmed.slice('module:'.length).trim() || null;
  if (trimmed.startsWith('-m ')) return trimmed.slice(3).trim() || null;
  return null;
}

/**
 * A probe resolves script operands against process cwd, or reports `module:<mod>`
 * for `python -m <mod>` / bare command basenames for general ML launchers.
 */
export function isRegisteredEntryPath(
  task: Pick<TaskRegistration, 'allowedDirectories' | 'entryPaths'>,
  scriptEntry: string | null | undefined,
): boolean {
  if (!scriptEntry) return false;

  // Support `python -m <module>` reported as `module:<name>`
  if (scriptEntry.startsWith('module:')) {
    const actualMod = scriptEntry.slice('module:'.length).trim();
    if (!actualMod) return false;
    return task.entryPaths.some((entry) => {
      const expectedMod = normalizeModuleEntry(entry);
      return expectedMod !== null && expectedMod === actualMod;
    });
  }

  // Absolute filesystem path matching
  if (scriptEntry.startsWith('/')) {
    const actual = normalizePosix(scriptEntry);
    const root = task.allowedDirectories[0] ?? '/';
    return task.entryPaths.some((entry) => {
      if (normalizeModuleEntry(entry) !== null) return false;
      const candidate = path.posix.isAbsolute(entry) ? entry : path.posix.join(root, entry);
      return normalizePosix(candidate) === actual;
    });
  }

  // General command / launcher basename match (e.g. `torchrun`, `accelerate`, `yolo`)
  return task.entryPaths.some((entry) => {
    const trimmed = entry.trim();
    return trimmed === scriptEntry || path.posix.basename(trimmed) === scriptEntry;
  });
}

/**
 * A registered entry may have been launched as a bare name from another
 * directory, or via a distributed launcher / module. The probe reports
 * the matched entry in scriptEntry or launcherEntry.
 */
export function isRegisteredProcessEntry(
  task: Pick<TaskRegistration, 'allowedDirectories' | 'entryPaths'>,
  process: { cwd?: string | null; scriptEntry?: string | null; launcherEntry?: string | null | undefined; treeMember?: boolean },
): boolean {
  return isRegisteredEntryPath(task, process.scriptEntry) || isRegisteredLauncherPath(task, process);
}

export function processEntry(process: { scriptEntry: string | null; launcherEntry?: string | null | undefined }): string | null {
  return process.scriptEntry ?? process.launcherEntry ?? null;
}

/**
 * A launcher entry is the registered file the probe matched by name while the
 * process ran from a different directory (or via a module/wrapper). It must still be in the registry.
 */
export function isRegisteredLauncherPath(
  task: Pick<TaskRegistration, 'allowedDirectories' | 'entryPaths'>,
  process: { cwd?: string | null; launcherEntry?: string | null | undefined },
): boolean {
  if (!isRegisteredEntryPath(task, process.launcherEntry)) return false;
  if (process.launcherEntry?.startsWith('module:')) return true;
  const entry = task.entryPaths[0];
  // A bare file name can only run the file it names; accept it from any cwd.
  if (typeof entry === 'string' && !path.posix.isAbsolute(entry) && !entry.includes('/')) return true;
  const root = task.allowedDirectories[0];
  if (typeof root !== 'string' || typeof process.cwd !== 'string') return false;
  const normRoot = normalizePosix(root);
  const normCwd = normalizePosix(process.cwd);
  return normCwd === normRoot || normCwd.startsWith(`${normRoot}/`);
}
