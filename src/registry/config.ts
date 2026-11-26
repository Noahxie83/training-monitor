import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigRecoveryNotice, HostRegistration, HostTarget, Registry } from '../shared/contracts';
import { validateRegistry } from '../shared/validate';
import { createDefaultRegistry } from './presets';
import { backUpCorruptConfig, ConfigRecoveryDeclined, type ConfigRecoveryOptions } from './recovery';

const queues = new Map<string, Promise<unknown>>();

function queued<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  queues.set(key, current);
  void current.finally(() => { if (queues.get(key) === current) queues.delete(key); }).catch(() => undefined);
  return current;
}

export interface RegistryMigrationResult {
  registry: Registry;
  migrated: boolean;
  fromVersion: 1 | 2;
}

function migrateHostTarget(rawTarget: unknown): HostTarget {
  if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    throw new Error('REGISTRY_INVALID');
  }
  const target = rawTarget as Record<string, unknown>;
  if (target.kind === 'ssh') {
    const next: Extract<HostTarget, { kind: 'ssh' }> = { kind: 'ssh' };
    if (typeof target.alias === 'string' && target.alias.trim()) next.alias = target.alias.trim();
    if (typeof target.hostname === 'string' && target.hostname.trim()) next.hostname = target.hostname.trim();
    if (typeof target.user === 'string' && target.user.trim()) next.user = target.user.trim();
    if (typeof target.port === 'number') next.port = target.port;
    if (typeof target.identityFile === 'string' && target.identityFile.trim()) next.identityFile = target.identityFile.trim();
    if (typeof target.proxyJump === 'string' && target.proxyJump.trim()) next.proxyJump = target.proxyJump.trim();
    if (typeof target.pythonPath === 'string' && target.pythonPath.trim()) next.pythonPath = target.pythonPath.trim();
    return next;
  }
  if (target.kind === 'wsl') {
    const next: Extract<HostTarget, { kind: 'wsl' }> = {
      kind: 'wsl',
      distribution: typeof target.distribution === 'string' ? target.distribution.trim() : '',
    };
    if (typeof target.pythonPath === 'string' && target.pythonPath.trim()) next.pythonPath = target.pythonPath.trim();
    return next;
  }
  if (target.kind === 'local') {
    const next: Extract<HostTarget, { kind: 'local' }> = { kind: 'local' };
    if (typeof target.pythonPath === 'string' && target.pythonPath.trim()) next.pythonPath = target.pythonPath.trim();
    return next;
  }
  throw new Error('REGISTRY_INVALID');
}

/**
 * Smoothly migrates v1 registry payloads to v2 while preserving every host, task,
 * logFormat, and auto-start definition. Already-v2 payloads are validated directly.
 */
export function migrateRegistry(raw: unknown): RegistryMigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('REGISTRY_INVALID');
  }
  const root = raw as Record<string, unknown>;
  if (root.version === 2) {
    try {
      return { registry: validateRegistry(root), migrated: false, fromVersion: 2 };
    } catch {
      throw new Error('REGISTRY_INVALID');
    }
  }
  if (root.version === 1) {
    if (!Array.isArray(root.hosts) || !Array.isArray(root.tasks)) {
      throw new Error('REGISTRY_INVALID');
    }
    const hosts: HostRegistration[] = root.hosts.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('REGISTRY_INVALID');
      const host = entry as Record<string, unknown>;
      const migratedHost: HostRegistration = {
        hostId: host.hostId as string,
        label: host.label as string,
        enabled: host.enabled as boolean,
        allowedRoots: Array.isArray(host.allowedRoots) ? [...(host.allowedRoots as string[])] : [],
        target: migrateHostTarget(host.target),
      };
      if (typeof host.stateDir === 'string') migratedHost.stateDir = host.stateDir;
      if (typeof host.pollIntervalMs === 'number') migratedHost.pollIntervalMs = host.pollIntervalMs;
      if (typeof host.allowJobControl === 'boolean') migratedHost.allowJobControl = host.allowJobControl;
      return migratedHost;
    });
    const candidate = {
      version: 2 as const,
      revision: root.revision,
      hosts,
      tasks: structuredClone(root.tasks),
    };
    try {
      return { registry: validateRegistry(candidate), migrated: true, fromVersion: 1 };
    } catch {
      throw new Error('REGISTRY_INVALID');
    }
  }
  throw new Error('REGISTRY_INVALID');
}

async function atomicWriteFile(filename: string, contents: string): Promise<void> {
  const temp = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(path.dirname(filename), { recursive: true });
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, filename);
    try {
      const directory = await open(path.dirname(filename), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { /* Directory fsync is not supported by all Windows filesystems. */ }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateSavedRegistry(value: unknown): Registry {
  try { return validateRegistry(value); }
  catch { throw new Error('REGISTRY_INVALID'); }
}

export interface RegistryStoreOptions extends ConfigRecoveryOptions {
  defaults?: () => Registry;
}

export interface RegistryStore {
  loadRegistry(): Promise<Registry>;
  saveRegistry(value: Registry): Promise<Registry>;
  getRecoveryNotice(): ConfigRecoveryNotice | null;
}

export function createRegistryStore(
  userDataDirectory: string,
  defaultsOrOptions: (() => Registry) | RegistryStoreOptions = createDefaultRegistry,
): RegistryStore {
  const opts: RegistryStoreOptions = typeof defaultsOrOptions === 'function'
    ? { defaults: defaultsOrOptions }
    : defaultsOrOptions;
  const defaults = opts.defaults ?? createDefaultRegistry;
  const clock = opts.clock ?? Date.now;
  const dir = path.resolve(userDataDirectory);
  const filename = path.join(dir, 'registry.json');
  const v1BackupFilename = path.join(dir, 'registry.v1.bak.json');
  let lastRecoveryNotice: ConfigRecoveryNotice | null = null;

  async function quarantineCorrupt(errorCode: string): Promise<Registry> {
    const notice = await backUpCorruptConfig(filename, 'registry', errorCode, clock);
    lastRecoveryNotice = notice;
    console.error(`[registry] ${notice.message}`);
    if (opts.confirmRecovery && !await opts.confirmRecovery(notice)) throw new ConfigRecoveryDeclined(notice.message);
    const registry = validateSavedRegistry(defaults());
    await atomicWriteFile(filename, `${JSON.stringify(registry, null, 2)}\n`);
    opts.onRecovery?.(notice);
    return registry;
  }

  async function readCurrent(): Promise<Registry> {
    let raw: string;
    try { raw = await readFile(filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateSavedRegistry(defaults());
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch {
      return quarantineCorrupt('REGISTRY_CORRUPT');
    }
    let result: RegistryMigrationResult;
    try {
      result = migrateRegistry(parsed);
    } catch {
      return quarantineCorrupt('REGISTRY_INVALID');
    }
    if (result.migrated) {
      // Atomic v1 backup prior to writing v2 registry.
      try {
        await atomicWriteFile(v1BackupFilename, raw);
      } catch {
        // Best-effort backup; still proceed with atomic write of migrated v2.
      }
      await atomicWriteFile(filename, `${JSON.stringify(result.registry, null, 2)}\n`);
    }
    return structuredClone(result.registry);
  }

  return {
    getRecoveryNotice() { return lastRecoveryNotice ? { ...lastRecoveryNotice } : null; },
    loadRegistry() { return queued(filename, readCurrent); },
    saveRegistry(value) {
      return queued(filename, async () => {
        const current = await readCurrent();
        const validated = validateSavedRegistry(value);
        if (validated.revision !== current.revision) throw new Error('REVISION_CONFLICT');
        const saved: Registry = { ...validated, revision: current.revision + 1 };
        await atomicWriteFile(filename, `${JSON.stringify(saved, null, 2)}\n`);
        return structuredClone(saved);
      });
    },
  };
}
