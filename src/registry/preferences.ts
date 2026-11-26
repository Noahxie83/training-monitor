import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigRecoveryNotice, Preferences, WindowBounds } from '../shared/contracts';
import { validatePreferences } from '../shared/validate';
import { backUpCorruptConfig, ConfigRecoveryDeclined, type ConfigRecoveryOptions } from './recovery';

export type PreferencesStoreOptions = ConfigRecoveryOptions;

export interface PreferencesStore {
  load(): Promise<Preferences>;
  save(value: Preferences): Promise<Preferences>;
  saveWindowBounds(kind: 'main' | 'gpu', bounds: WindowBounds): Promise<void>;
  flush(): Promise<void>;
  getRecoveryNotice(): ConfigRecoveryNotice | null;
}

function parseWindowBounds(value: unknown): WindowBounds | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (
    typeof b.x !== 'number' || !Number.isFinite(b.x) ||
    typeof b.y !== 'number' || !Number.isFinite(b.y) ||
    typeof b.width !== 'number' || !Number.isFinite(b.width) || b.width < 1 ||
    typeof b.height !== 'number' || !Number.isFinite(b.height) || b.height < 1
  ) {
    return undefined;
  }
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
    ...(typeof b.isMaximized === 'boolean' ? { isMaximized: b.isMaximized } : {}),
  };
}

/**
 * Forward-compatible preferences migration. Accepts known extended keys and safely
 * ignores unrecognized future keys instead of crashing on version upgrades.
 */
export function migratePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('PREFERENCES_INVALID');
  }
  const row = raw as Record<string, unknown>;
  const theme = row.theme === 'system' || row.theme === 'light' || row.theme === 'dark'
    ? row.theme
    : row.theme === undefined ? 'system' : null;
  if (theme === null) {
    throw new Error('PREFERENCES_INVALID');
  }
  const migrated: Preferences = { theme };
  if (row.locale === 'zh-CN' || row.locale === 'en-US') {
    migrated.locale = row.locale;
  }
  if (typeof row.minimizeToTrayOnClose === 'boolean') {
    migrated.minimizeToTrayOnClose = row.minimizeToTrayOnClose;
  }
  if (typeof row.launchAtLogin === 'boolean') {
    migrated.launchAtLogin = row.launchAtLogin;
  }
  if (row.windowBounds && typeof row.windowBounds === 'object' && !Array.isArray(row.windowBounds)) {
    const nested = row.windowBounds as Record<string, unknown>;
    const main = parseWindowBounds(nested.main) ?? parseWindowBounds(nested);
    const gpu = parseWindowBounds(nested.gpu);
    if (main || gpu) migrated.windowBounds = { ...(main ? { main } : {}), ...(gpu ? { gpu } : {}) };
  }
  if (row.alerts && typeof row.alerts === 'object' && !Array.isArray(row.alerts)) {
    try {
      const validated = validatePreferences({ theme, alerts: row.alerts });
      if (validated.alerts) migrated.alerts = validated.alerts;
    } catch {
      // Drop malformed alert section while preserving valid theme/locale/bounds.
    }
  }
  return migrated;
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(path.dirname(filename), { recursive: true });
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createPreferencesStore(userDataDirectory: string, options: PreferencesStoreOptions = {}): PreferencesStore {
  const filename = path.join(path.resolve(userDataDirectory), 'preferences.json');
  const clock = options.clock ?? Date.now;
  let lastRecoveryNotice: ConfigRecoveryNotice | null = null;
  let tail = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = tail.then(operation);
    tail = current.then(() => undefined, () => undefined);
    return current;
  }

  async function write(value: Preferences): Promise<Preferences> {
    await atomicWrite(filename, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }

  async function quarantineCorrupt(errorCode: string): Promise<Preferences> {
    const notice = await backUpCorruptConfig(filename, 'preferences', errorCode, clock);
    lastRecoveryNotice = notice;
    console.error(`[preferences] ${notice.message}`);
    if (options.confirmRecovery && !await options.confirmRecovery(notice)) throw new ConfigRecoveryDeclined(notice.message);
    const preferences = await write({ theme: 'system' });
    options.onRecovery?.(notice);
    return preferences;
  }

  async function load(): Promise<Preferences> {
    let raw: string;
    try {
      raw = await readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { theme: 'system' };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return quarantineCorrupt('PREFERENCES_CORRUPT');
    }
    try {
      return migratePreferences(parsed);
    } catch {
      return quarantineCorrupt('PREFERENCES_INVALID');
    }
  }

  return {
    getRecoveryNotice() { return lastRecoveryNotice ? { ...lastRecoveryNotice } : null; },
    load: () => enqueue(load),
    flush: () => tail,
    async save(value) {
      let preferences: Preferences;
      try {
        preferences = validatePreferences(value);
      } catch {
        throw new Error('PREFERENCES_INVALID');
      }
      return enqueue(async () => {
        const windowBounds = preferences.windowBounds ?? (await load()).windowBounds;
        return write(windowBounds ? { ...preferences, windowBounds } : preferences);
      });
    },
    saveWindowBounds(kind, bounds) {
      return enqueue(async () => {
        const current = await load();
        await write(validatePreferences({
          ...current,
          windowBounds: { ...current.windowBounds, [kind]: bounds },
        }));
      });
    },
  };
}
