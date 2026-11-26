import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Registry } from '../shared/contracts';

export interface RotationRecord { registrationId: string; taskId: string; sourceId: string; allowedDirectory: string; exactBasenames: string[] }
export interface RotationCatalog { version: 1; records: RotationRecord[] }
export interface RotationCandidateRef { kind: 'registered_rotation'; sourceId: string; candidateId: string; registrationId: string }
export interface ResolvedRotationCandidate extends RotationCandidateRef { taskId: string; path: string; currentPath: string; allowedDirectories: string[] }
export type RotationCatalogLoad = { status: 'unconfigured'; candidates: [] } | { status: 'configured'; listCandidates(sourceId: string): RotationCandidateRef[]; resolveCandidate(candidate: RotationCandidateRef): Promise<ResolvedRotationCandidate | null> };

const MAX_RECORDS = 32;
const MAX_BASENAMES_PER_RECORD = 64;
const MAX_CANDIDATES = 128;

function invalid(): never { throw new Error('ROTATION_CATALOG_INVALID'); }

function validateCatalog(value: unknown): RotationCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.records) || root.records.length > MAX_RECORDS) return invalid();
  const records: RotationRecord[] = [];
  const registrationIds = new Set<string>();
  let total = 0;
  for (const item of root.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid();
    const record = item as Record<string, unknown>;
    const { registrationId, taskId, sourceId, allowedDirectory, exactBasenames } = record;
    if ([registrationId, taskId, sourceId, allowedDirectory].some((part) => typeof part !== 'string' || part.length === 0) ||
        !Array.isArray(exactBasenames) || exactBasenames.length === 0 || exactBasenames.length > MAX_BASENAMES_PER_RECORD || registrationIds.has(registrationId as string)) return invalid();
    registrationIds.add(registrationId as string);
    const names: string[] = [];
    for (const name of exactBasenames) {
      if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('..') || /[\\/\0]/.test(name) || name.length > 255 || names.includes(name)) return invalid();
      names.push(name);
    }
    total += names.length;
    if (total > MAX_CANDIDATES) return invalid();
    records.push({ registrationId: registrationId as string, taskId: taskId as string, sourceId: sourceId as string, allowedDirectory: allowedDirectory as string, exactBasenames: names });
  }
  return { version: 1, records };
}

function isRegistered(record: RotationRecord, registry: Registry): { task: Registry['tasks'][number]; source: Registry['tasks'][number]['sources'][number] } | null {
  const task = registry.tasks.find((item) => item.taskId === record.taskId);
  const source = task?.sources.find((item) => item.sourceId === record.sourceId && item.kind === 'log');
  if (!task || !source || !task.allowedDirectories.includes(record.allowedDirectory)) return null;
  const host = registry.hosts.find((item) => item.hostId === task.hostId);
  if (!host || !host.allowedRoots.some((root) => componentWithin(root, record.allowedDirectory))) return null;
  return { task, source };
}

function componentWithin(root: string, candidate: string): boolean {
  const isWin = /^[A-Za-z]:[\\/]/.test(root) || /^[A-Za-z]:[\\/]/.test(candidate);
  const ops = isWin ? path.win32 : path.posix;
  const relative = ops.relative(ops.resolve(root), ops.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !ops.isAbsolute(relative));
}

export async function loadRotationCatalog(filename: string, registryProvider: () => Promise<Registry>): Promise<RotationCatalogLoad> {
  let raw: string;
  try { raw = await readFile(filename, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unconfigured', candidates: [] };
    throw error;
  }
  let catalog: RotationCatalog;
  try { catalog = validateCatalog(JSON.parse(raw)); }
  catch { throw new Error('ROTATION_CATALOG_INVALID'); }
  const registry = await registryProvider();
  const mappings = new Map<string, { ref: RotationCandidateRef; record: RotationRecord; basename: string; registrationScope: string }>();
  for (const record of catalog.records) {
    const link = isRegistered(record, registry);
    if (!link) continue;
    const registeredHost = registry.hosts.find((item) => item.hostId === link.task.hostId)!;
    const registrationScope = JSON.stringify({ taskId: link.task.taskId, hostId: link.task.hostId, allowedDirectories: link.task.allowedDirectories, source: link.source, target: registeredHost.target, allowedRoots: registeredHost.allowedRoots });
    for (const basename of record.exactBasenames) {
      const candidateId = randomUUID();
      const ref: RotationCandidateRef = { kind: 'registered_rotation', sourceId: record.sourceId, candidateId, registrationId: record.registrationId };
      mappings.set(candidateId, { ref, record, basename, registrationScope });
    }
  }
  return {
    status: 'configured',
    listCandidates(sourceId) { return [...mappings.values()].filter((item) => item.record.sourceId === sourceId).map((item) => ({ ...item.ref })); },
    async resolveCandidate(candidate) {
      const item = mappings.get(candidate.candidateId);
      if (!item || candidate.kind !== 'registered_rotation' || candidate.sourceId !== item.ref.sourceId || candidate.registrationId !== item.ref.registrationId) return null;
      const currentRegistry = await registryProvider();
      const link = isRegistered(item.record, currentRegistry);
      if (!link) return null;
      const registeredHost = currentRegistry.hosts.find((host) => host.hostId === link.task.hostId)!;
      const currentScope = JSON.stringify({ taskId: link.task.taskId, hostId: link.task.hostId, allowedDirectories: link.task.allowedDirectories, source: link.source, target: registeredHost.target, allowedRoots: registeredHost.allowedRoots });
      if (currentScope !== item.registrationScope || link.source.path === path.posix.join(item.record.allowedDirectory, item.basename)) return null;
      return { ...item.ref, taskId: item.record.taskId, path: path.posix.join(item.record.allowedDirectory, item.basename), currentPath: link.source.path, allowedDirectories: [...link.task.allowedDirectories] };
    },
  };
}
