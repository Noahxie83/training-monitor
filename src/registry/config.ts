import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Registry } from '../shared/contracts';
import { validateRegistry } from '../shared/validate';
import { createDefaultRegistry } from './presets';

const queues = new Map<string, Promise<unknown>>();

function queued<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  queues.set(key, current);
  void current.finally(() => { if (queues.get(key) === current) queues.delete(key); }).catch(() => undefined);
  return current;
}

function validateSavedRegistry(value: unknown): Registry {
  try { return validateRegistry(value); }
  catch { throw new Error('REGISTRY_INVALID'); }
}

export interface RegistryStore { loadRegistry(): Promise<Registry>; saveRegistry(value: Registry): Promise<Registry> }

export function createRegistryStore(userDataDirectory: string, defaults: () => Registry = createDefaultRegistry): RegistryStore {
  const filename = path.join(path.resolve(userDataDirectory), 'registry.json');

  async function readCurrent(): Promise<Registry> {
    let raw: string;
    try { raw = await readFile(filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateSavedRegistry(defaults());
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('REGISTRY_CORRUPT'); }
    return validateSavedRegistry(parsed);
  }

  return {
    loadRegistry() { return queued(filename, readCurrent); },
    saveRegistry(value) {
      return queued(filename, async () => {
        const current = await readCurrent();
        const validated = validateSavedRegistry(value);
        if (validated.revision !== current.revision) throw new Error('REVISION_CONFLICT');
        const saved: Registry = { ...validated, revision: current.revision + 1 };
        const temp = `${filename}.${process.pid}.${randomUUID()}.tmp`;
        let handle;
        try {
          await (await import('node:fs/promises')).mkdir(path.dirname(filename), { recursive: true });
          handle = await open(temp, 'wx', 0o600);
          await handle.writeFile(`${JSON.stringify(saved, null, 2)}\n`, 'utf8');
          await handle.sync();
          await handle.close(); handle = undefined;
          await rename(temp, filename);
          try {
            const directory = await open(path.dirname(filename), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
          } catch { /* Directory fsync is not supported by all Windows filesystems. */ }
          return structuredClone(saved);
        } catch (error) {
          if (handle) await handle.close().catch(() => undefined);
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      });
    },
  };
}
