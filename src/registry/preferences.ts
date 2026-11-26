import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigRecoveryNotice, Preferences, WindowBounds } from '../shared/contracts';
import { validatePreferences } from '../shared/validate';

export interface PreferencesStoreOptions {
  onRecovery?: (notice: ConfigRecoveryNotice) => void;
  clock?: () => number;
}

export interface PreferencesStore {
  load(): Promise<Preferences>;
  save(value: Preferences): Promise<Preferences>;
  getRecoveryNotice(): ConfigRecoveryNotice | null;
}

function parseWindowBounds(value: unknown): WindowBounds | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (
    typeof b.x !== 'number' || !Number.isFinite(b.x) ||
    typeof b.y !== 'number' || !Number.isFinite(b.y) ||
    typeof b.width !== 'number' || !Number.isFinite(b.width) || b.width <= 0 ||
    typeof b.height !== 'number' || !Number.isFinite(b.height) || b.height <= 0
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
  const bounds = parseWindowBounds(row.windowBounds);
  if (bounds) {
    migrated.windowBounds = bounds;
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

  async function quarantineCorrupt(raw: string, errorCode: string): Promise<Preferences> {
    const timestamp = new Date(clock()).toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filename}.corrupt-${timestamp}.bak`;
    try {
      await atomicWrite(backupPath, raw);
      await rm(filename, { force: true }).catch(() => undefined);
    } catch {
      try { await copyFile(filename, backupPath); } catch { /* Best-effort quarantine. */ }
    }
    const notice: ConfigRecoveryNotice = {
      file: 'preferences',
      backupPath,
      errorCode,
      recoveredAt: new Date(clock()).toISOString(),
      message: `preferences.json 损坏或格式无效 (${errorCode})，已自动隔离备份至 ${path.basename(backupPath)} 并恢复默认偏好。`,
    };
    lastRecoveryNotice = notice;
    console.error(`[preferences] ${notice.message}`);
    options.onRecovery?.(notice);
    return { theme: 'system' };
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
      return quarantineCorrupt(raw, 'PREFERENCES_CORRUPT');
    }
    try {
      return migratePreferences(parsed);
    } catch {
      return quarantineCorrupt(raw, 'PREFERENCES_INVALID');
    }
  }

  return {
    getRecoveryNotice() { return lastRecoveryNotice ? { ...lastRecoveryNotice } : null; },
    load,
    async save(value) {
      let preferences: Preferences;
      try {
        preferences = validatePreferences(value);
      } catch {
        throw new Error('PREFERENCES_INVALID');
      }
      await atomicWrite(filename, `${JSON.stringify(preferences, null, 2)}\n`);
      return structuredClone(preferences);
    },
  };
}
