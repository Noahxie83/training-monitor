import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProductionMonitorApi } from '../../src/collector/service';
import type { Registry, TaskRegistration } from '../../src/shared/contracts';
import type { StoreClient } from '../../src/store/protocol';
import type { ArchiveCandidateScan, HostObservation, ReadRequest, RegistrationReference, TaskObservation, Transport } from '../../src/transport/types';
import type { ReadReply } from '../../src/logs/types';
import { openTestStore } from '../store/helpers/test-client';
import { observation, readReply } from '../store/helpers/fixtures';

const START_MS = Date.parse('2026-10-21T00:00:00.000Z');
const IDENTITY = { dev: '1', inode: '2' };

export function liveRegistry(enabled = true): Registry {
  return {
    version: 1,
    revision: 1,
    hosts: [{ hostId: 'host-a', label: 'Host A', enabled, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'lab-campus' } }],
    tasks: [{
      taskId: 'task-a', hostId: 'host-a', label: 'Task A', enabled, algorithm: 'flow',
      allowedDirectories: ['/allowed/task-a'], entryPaths: ['/allowed/task-a/train.py'],
      sources: [{ sourceId: 'source-a', path: '/allowed/task-a/train.log', kind: 'log' }], checkpointDirectories: [],
    }],
  };
}

function hostObservation(at: string): HostObservation {
  return { hostId: 'host-a', freshness: 'fresh', observedAt: at, phase: null, connection: 'connected', scanComplete: true, hostBootId: 'boot-a', errorCode: null };
}

function taskObservation(at: string, eofBytes: string, startTicks = '100'): TaskObservation {
  return {
    taskId: 'task-a', hostId: 'host-a', observedAt: at, freshness: 'fresh', scanComplete: true,
    processScanError: null, phase: null, errorCode: null, errorScope: null,
    processes: [{
      key: { hostBootId: 'boot-a', pid: 42, startTicks }, role: 'unknown', cwd: '/allowed/task-a',
      scriptEntry: '/allowed/task-a/train.py', observedAt: at, roleEvidence: 'exact_entry_and_direct_writer_fd',
      directWriterSourceIds: ['source-a'], writerSourceEvidence: { 'source-a': { fileIdentity: { ...IDENTITY }, eofBytes } },
      writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [],
    }],
    sources: [{
      sourceId: 'source-a', observedAt: at, fileIdentity: { ...IDENTITY }, eofBytes, permission: 'readable',
      exists: true, statusValues: null, heldByRegisteredProcess: null, errorCode: null, evidenceComplete: true,
      errorScope: null, phase: null,
    }],
  };
}

class LiveTransport implements Transport {
  bytes = Buffer.from('100/1000 [00:10<01:30, 10.0it/s]\n');
  clock: () => number;
  startTicks = '100';
  hostCalls = 0;
  taskCalls = 0;
  readCalls: ReadRequest[] = [];
  constructor(clock: () => number) { this.clock = clock; }
  private at(): string { return new Date(this.clock()).toISOString(); }
  async probeHost(): Promise<HostObservation> { this.hostCalls += 1; return hostObservation(this.at()); }
  async probeTask(task: TaskRegistration): Promise<TaskObservation> {
    if (task.taskId !== 'task-a') throw new Error('UNREGISTERED_TASK');
    this.taskCalls += 1;
    return taskObservation(this.at(), String(this.bytes.length), this.startTicks);
  }
  async readLog(request: ReadRequest): Promise<ReadReply> {
    this.readCalls.push(request);
    const start = Number(BigInt(request.offset));
    const bytes = this.bytes.subarray(start, start + request.limitBytes);
    const observedAt = this.at();
    const reply = readReply({ ...request.expected, sourceId: 'source-a', state: 'tracking', identityStrength: 'strong', fileIdentity: IDENTITY,
      generationStartOffset: '0', maxObservedOffset: String(this.bytes.length), anchors: [], parserState: { recordStartOffset: request.expected.committedOffset,
        pendingCR: false, utf8CarryBase64: '', boundedPreview: '', displayTruncated: false, prefixIncomplete: false } } as never,
      bytes, observedAt, this.bytes);
    const anchors = request.anchors.map((anchor) => ({ ...anchor, endOffset: String(BigInt(anchor.startOffset) + BigInt(anchor.length)), sha256: anchor.sha256 }));
    return { ...reply, before: { ...reply.before, fileIdentity: { ...IDENTITY }, anchors }, after: { ...reply.after, fileIdentity: { ...IDENTITY }, anchors } };
  }
  async scanArchiveCandidates(): Promise<ArchiveCandidateScan> { return { status: 'inconclusive', candidates: [], errorCode: 'ROTATION_CATALOG_UNCONFIGURED', observedAt: this.at() }; }
  async createRegistrationReference(taskId: string): Promise<RegistrationReference> { return { taskId, registryRevision: 1, fingerprint: 'fixture' }; }
}

export async function createLiveMonitor(options: { registry?: Registry; initialLog?: string; clockStepMs?: number } = {}) {
  const { createProductionApi } = await import('../../src/collector/service');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-live-'));
  let clockMs = START_MS;
  const clock = () => (clockMs += options.clockStepMs ?? 1_000);
  const store: StoreClient = await openTestStore(directory, clock);
  const transport = new LiveTransport(clock);
  if (options.initialLog !== undefined) transport.bytes = Buffer.from(options.initialLog);
  const api: ProductionMonitorApi = createProductionApi({ store, registryProvider: async () => options.registry ?? liveRegistry(), transportProvider: () => transport, clock });
  return {
    api, store, directory,
    append(text: string) { transport.bytes = Buffer.concat([transport.bytes, Buffer.from(text)]); },
    replaceTail(text: string) { const bytes = transport.bytes; const last = bytes.lastIndexOf(0x0a); transport.bytes = Buffer.concat([bytes.subarray(0, last + 1), Buffer.from(text)]); },
    setStartTicks(value: string) { transport.startTicks = value; },
    transport,
    async close() { await api.stop().catch(() => undefined); await rm(directory, { recursive: true, force: true }); },
  };
}

export { observation };
