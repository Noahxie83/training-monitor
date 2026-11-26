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

/**
 * A probe resolves the script operand against the process cwd, so an entry that
 * was launched as a bare filename arrives fully qualified. Registered entries
 * may be stored relative to the first allowed directory; compare both forms.
 */
export function isRegisteredEntryPath(task: Pick<TaskRegistration, 'allowedDirectories' | 'entryPaths'>, scriptEntry: string | null | undefined): boolean {
  if (!scriptEntry || !scriptEntry.startsWith('/')) return false;
  const normalize = (value: string) => {
    const normalized = path.posix.normalize(value);
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  };
  const actual = normalize(scriptEntry);
  const root = task.allowedDirectories[0] ?? '/';
  return task.entryPaths.some(entry => normalize(path.posix.isAbsolute(entry) ? entry : path.posix.join(root, entry)) === actual);
}

/**
 * A registered entry may have been launched as a bare name from another
 * directory. The probe then reports the registered entry as launcherEntry.
 */
export function isRegisteredProcessEntry(
  task: Pick<TaskRegistration, 'allowedDirectories' | 'entryPaths'>,
  process: { cwd?: string | null; scriptEntry?: string | null; launcherEntry?: string | null | undefined },
): boolean {
  return isRegisteredEntryPath(task, process.scriptEntry) || isRegisteredLauncherPath(task, process);
}

export function processEntry(process: { scriptEntry: string | null; launcherEntry?: string | null | undefined }): string | null {
  return process.scriptEntry ?? process.launcherEntry ?? null;
}

/**
 * A launcher entry is the registered file the probe matched by name while the
 * process ran from a different directory. It must still be in the registry.
 */
export function isRegisteredLauncherPath(task: Pick<TaskRegistration, 'allowedDirectories' | 'entryPaths'>, process: { cwd?: string | null; launcherEntry?: string | null | undefined }): boolean {
  if (!isRegisteredEntryPath(task, process.launcherEntry)) return false;
  const entry = task.entryPaths[0];
  // A bare file name can only run the file it names; accept it from any cwd.
  if (typeof entry === 'string' && !path.posix.isAbsolute(entry) && !entry.includes('/')) return true;
  const root = task.allowedDirectories[0];
  return typeof root === 'string' && typeof process.cwd === 'string' &&
    path.posix.normalize(process.cwd) === path.posix.normalize(root).replace(/\/$/, '');
}
