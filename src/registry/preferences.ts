import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Preferences } from '../shared/contracts';

export interface PreferencesStore {
  load(): Promise<Preferences>;
  save(value: Preferences): Promise<Preferences>;
}

function validatePreferences(value: unknown): Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PREFERENCES_INVALID');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 1 || (row.theme !== 'system' && row.theme !== 'light' && row.theme !== 'dark')) {
    throw new Error('PREFERENCES_INVALID');
  }
  return { theme: row.theme };
}

export function createPreferencesStore(userDataDirectory: string): PreferencesStore {
  const filename = path.join(path.resolve(userDataDirectory), 'preferences.json');

  async function load(): Promise<Preferences> {
    let raw: string;
    try {
      raw = await readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { theme: 'system' };
      throw error;
    }
    try {
      return validatePreferences(JSON.parse(raw));
    } catch (error) {
      if (error instanceof Error && error.message === 'PREFERENCES_INVALID') throw error;
      throw new Error('PREFERENCES_CORRUPT');
    }
  }

  return {
    load,
    async save(value) {
      const preferences = validatePreferences(value);
      const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await mkdir(path.dirname(filename), { recursive: true });
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, filename);
        return structuredClone(preferences);
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
