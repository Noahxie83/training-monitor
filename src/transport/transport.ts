import { createHash, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import type { HostRegistration, ProcessKey, Registry, TaskRegistration } from '../shared/contracts';
import type { ReadReply, SourceObservation } from '../logs/types';
import type { RotationCatalogLoad, RotationCandidateRef } from '../registry/rotation-catalog';
import { safeArgsFor, stoppedWslListArgs } from './commands';
import { gpuDeviceMap, isRegisteredGpuProcess, projectGpuCsv, projectProcessGpu } from './gpu';
import { decodeFrames, MAX_READ_BYTES, MAX_RESPONSE_BYTES, MAX_STDERR_BYTES, PROTOCOL_VERSION, validateProbeEnvelope } from './protocol';
import { isRegisteredEntryPath, isRegisteredLauncherPath } from '../domain/identity';
import type { ArchiveCandidateScan, HostObservation, LaunchResult, ServerWaitResult, ReadRequest, SpawnLike, TaskObservation, Transport, TransportHostContext } from './types';

export interface BoundedChildResult { stdout: Buffer; stderr: Buffer; exitCode: number | null }
export interface ChildLimits { timeoutMs?: number; stdoutLimitBytes?: number; stderrLimitBytes?: number }

type FailureScope = 'host' | 'task' | 'request' | 'source';
type FailurePhase = 'wsl_list' | 'connect' | 'python_start' | 'probe' | 'process_scan' | 'frame' | 'validate' | 'source_read' | 'dispatch' | 'archive_scan';
function coded(code: string, errorScope: FailureScope = 'request', phase: FailurePhase = 'validate', requestId: string | null = null, sourceId: string | null = null): Error {
  const error = new Error(code) as Error & { code: string; errorScope: FailureScope; phase: FailurePhase; requestId: string | null; sourceId: string | null };
  Object.assign(error, { code, errorScope, phase, requestId, sourceId });
  return error;
}

function failureFields(error: unknown, fallbackPhase: FailurePhase): { code: string; errorScope: FailureScope; phase: FailurePhase; requestId: string | null; sourceId: string | null } {
  const row = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const scope = ['host', 'task', 'request', 'source'].includes(String(row.errorScope)) ? row.errorScope as FailureScope : 'request';
  const phases = ['wsl_list', 'connect', 'python_start', 'probe', 'process_scan', 'frame', 'validate', 'source_read', 'dispatch', 'archive_scan'];
  return { code: error instanceof Error ? error.message : 'PROBE_FAILED', errorScope: scope,
    phase: phases.includes(String(row.phase)) ? row.phase as FailurePhase : fallbackPhase,
    requestId: typeof row.requestId === 'string' ? row.requestId : null,
    sourceId: typeof row.sourceId === 'string' ? row.sourceId : null };
}

export function runBoundedChild(command: string, args: string[], input: Buffer, signal: AbortSignal, spawnChild: SpawnLike = nodeSpawn as SpawnLike, limits: ChildLimits = {}): Promise<BoundedChildResult> {
  const timeoutMs = limits.timeoutMs ?? 5_000;
  const stdoutLimit = limits.stdoutLimitBytes ?? MAX_RESPONSE_BYTES;
  const stderrLimit = limits.stderrLimitBytes ?? MAX_STDERR_BYTES;
  if (signal.aborted) return Promise.reject(coded('PROBE_CANCELLED'));
  return new Promise((resolve, reject) => {
    let child: any;
    let settled = false;
    let stdoutBytes = 0; let stderrBytes = 0;
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const finish = (error?: Error, exitCode: number | null = null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
    };
    const stop = (code: string) => {
      if (settled) return;
      finish(coded(code));
      try { child?.kill(); } catch { /* The child may already have exited. */ }
    };
    const abort = () => stop('PROBE_CANCELLED');
    const timer = setTimeout(() => stop('PROBE_TIMEOUT'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    try { child = spawnChild(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { finish(coded('TRANSPORT_UNAVAILABLE')); return; }
    child.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      const data = Buffer.from(chunk); stdoutBytes += data.length;
      if (stdoutBytes > stdoutLimit) { stop('RESPONSE_LIMIT'); return; }
      stdout.push(data);
    });
    child.stderr.on('data', (chunk: Buffer | Uint8Array) => {
      const data = Buffer.from(chunk); stderrBytes += data.length;
      if (stderrBytes > stderrLimit) { stop('STDERR_LIMIT'); return; }
      stderr.push(data);
    });
    child.once('error', () => finish(coded('TRANSPORT_UNAVAILABLE')));
    // Keep the listener for the lifetime of the stream; a late EPIPE after close is expected.
    child.stdin.on('error', () => stop('PROBE_STDIN_FAILED'));
    child.once('close', (code: number | null) => {
      if (settled) return;
      finish(undefined, code);
    });
    try { child.stdin.end(input); } catch { stop('PROBE_STDIN_FAILED'); }
  });
}

function iso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function unavailableGpu(errorCode: string): NonNullable<HostObservation['gpu']> {
  return { observedAt: null, state: 'unavailable', errorCode, metrics: [] };
}

function linuxGpuObservation(value: unknown, receivedAt: string): NonNullable<HostObservation['gpu']> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.status !== 'ok' || typeof row.csv !== 'string') {
    return unavailableGpu(typeof row.errorCode === 'string' ? row.errorCode : 'GPU_DATA_UNAVAILABLE');
  }
  // Resource TTLs use the desktop clock. Remote clocks can be ahead or behind;
  // stamp this live response on receipt so valid samples are never rejected as future evidence.
  return projectGpuCsv(row.csv, receivedAt);
}

async function windowsGpuObservation(signal: AbortSignal, spawnChild: SpawnLike, onDevices?: (devices: {uuid: string; index: number}[]) => void): Promise<NonNullable<HostObservation['gpu']>> {
  const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe');
  const args = ['--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
  try {
    const result = await runBoundedChild(executable, args, Buffer.alloc(0), signal, spawnChild, {
      timeoutMs: 2_000, stdoutLimitBytes: 16 * 1024, stderrLimitBytes: 4 * 1024,
    });
    if (result.exitCode !== 0) return unavailableGpu('NVIDIA_SMI_FAILED');
    const csv = result.stdout.toString('utf8');
    onDevices?.(gpuDeviceMap(csv));
    return projectGpuCsv(csv, new Date().toISOString());
  } catch (error) {
    return unavailableGpu(error instanceof Error && error.message === 'PROBE_TIMEOUT' ? 'NVIDIA_SMI_TIMEOUT' : 'NVIDIA_SMI_UNAVAILABLE');
  }
}

function validErrorScope(value: unknown): FailureScope | null {
  return value === 'host' || value === 'task' || value === 'request' || value === 'source' ? value : null;
}

function validProbePhase(value: unknown): FailurePhase | null {
  return value === 'wsl_list' || value === 'connect' || value === 'python_start' || value === 'probe' ||
    value === 'process_scan' || value === 'frame' || value === 'validate' || value === 'source_read' || value === 'dispatch' || value === 'archive_scan' ? value : null;
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.posix.relative(path.posix.resolve(root), path.posix.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
}

function pathScopes(host: HostRegistration, task: TaskRegistration): { hostAllowedRoots: string[]; taskAllowedDirectories: string[] } {
  return { hostAllowedRoots: [...host.allowedRoots], taskAllowedDirectories: task.allowedDirectories.filter((directory) => host.allowedRoots.some((root) => pathWithin(root, directory))) };
}

function fingerprint(task: TaskRegistration, host: HostRegistration): string {
  return createHash('sha256').update(JSON.stringify({ hostId: host.hostId, target: host.target, allowedRoots: host.allowedRoots, task })).digest('hex');
}

function sourceFor(registry: Registry, taskId: string, sourceId: string): { task: TaskRegistration; host: HostRegistration; source: TaskRegistration['sources'][number] } | null {
  const task = registry.tasks.find((item) => item.taskId === taskId);
  const host = task && registry.hosts.find((item) => item.hostId === task.hostId);
  const source = task?.sources.find((item) => item.sourceId === sourceId && item.kind === 'log');
  return task && host && source ? { task, host, source } : null;
}

function encodeProbe(source: string, request: Record<string, unknown>): Buffer {
  if (!source.includes('__MONITOR_REQUEST_B64__')) throw coded('PROBE_TEMPLATE_INVALID');
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  return Buffer.from(source.replace('__MONITOR_REQUEST_B64__', encoded), 'utf8');
}

async function invokeProbe(context: TransportHostContext, script: string, request: Record<string, unknown>, signal: AbortSignal, spawnChild: SpawnLike, listOnly = false, limits: ChildLimits = {}): Promise<unknown> {
  const target = context.host.target;
  if (target.kind === 'wsl') {
    let list: BoundedChildResult;
    try {
      list = await runBoundedChild('wsl.exe', stoppedWslListArgs(), Buffer.alloc(0), signal, spawnChild, { timeoutMs: 2_000, stdoutLimitBytes: 4096, stderrLimitBytes: 4096 });
    } catch (error) {
      const failure = failureFields(error, 'wsl_list');
      throw coded(failure.code, 'host', 'wsl_list', String(request.requestId ?? '') || null, null);
    }
    if (list.exitCode !== 0) throw coded('WSL_LIST_FAILED', 'host', 'wsl_list');
    const text = list.stdout.includes(0) ? list.stdout.toString('utf16le') : list.stdout.toString('utf8');
    const running = text.split(/\r?\n/).map((line) => line.trim().replace(/^\uFEFF/, '')).filter(Boolean);
    if (!running.includes(target.distribution)) throw coded('WSL_NOT_RUNNING', 'host', 'wsl_list', String(request.requestId ?? '') || null, null);
    if (listOnly) return { running: true };
  }
  const args = safeArgsFor(target);
  const command = target.kind === 'ssh' ? 'ssh' : 'wsl.exe';
  const input = encodeProbe(script, request);
  const child = await runBoundedChild(command, args, input, signal, spawnChild, limits);
  if (child.exitCode !== 0 && child.stdout.length === 0) {
    if (target.kind === 'ssh' && child.exitCode === 255) throw coded('SSH_EXIT_UNCLASSIFIED', 'request', 'connect', String(request.requestId), (request.sourceId as string | null) ?? null);
    throw coded('REMOTE_PROBE_FAILED', 'request', 'python_start', String(request.requestId), (request.sourceId as string | null) ?? null);
  }
  const frames = decodeFrames(child.stdout);
  if (frames.length !== 1) throw coded('PROTOCOL_FRAME_COUNT_INVALID');
  let parsed: unknown;
  try { parsed = JSON.parse(frames[0]!.toString('utf8')); } catch { throw coded('PROTOCOL_JSON_INVALID'); }
  const expected = { requestId: String(request.requestId), sourceId: (request.sourceId as string | null) ?? null };
  const envelope = validateProbeEnvelope(parsed, expected);
  return envelope.payload;
}

function validateProcessKey(value: unknown): ProcessKey | null {
  if (!value || typeof value !== 'object') return null;
  const key = value as Record<string, unknown>;
  return typeof key.hostBootId === 'string' && key.hostBootId.length > 0 && Number.isSafeInteger(key.pid) && typeof key.startTicks === 'string' && /^\d+$/.test(key.startTicks)
    ? { hostBootId: key.hostBootId, pid: key.pid as number, startTicks: key.startTicks } : null;
}

export function projectTaskObservation(task: TaskRegistration, payload: unknown, observedAt: string): TaskObservation {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const complete = data.scanComplete === true;
  const sourceRows = Array.isArray(data.sources) ? data.sources : [];
  const byId = new Map(sourceRows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map((row) => [row.sourceId, row]));
  const sources = task.sources.map((source) => {
    const result = byId.get(source.sourceId);
    const status = result?.status;
    const identity = result?.fileIdentity;
    const fileIdentity = identity && typeof identity === 'object' && typeof (identity as Record<string, unknown>).dev === 'string' && typeof (identity as Record<string, unknown>).inode === 'string'
      ? { dev: (identity as Record<string, string>).dev, inode: (identity as Record<string, string>).inode } : null;
    return {
      sourceId: source.sourceId, observedAt: iso(result?.observedAt) ? observedAt : null, fileIdentity,
      eofBytes: typeof result?.eofBytes === 'string' && /^\d+$/.test(result.eofBytes) ? result.eofBytes : null,
      permission: status === 'ok' && fileIdentity ? 'readable' as const : status === 'missing' ? 'missing' as const : status === 'permission_error' ? 'denied' as const : 'unknown' as const,
      exists: status === 'ok' ? true : status === 'missing' ? false : null,
      statusValues: result?.statusValues && typeof result.statusValues === 'object' && !Array.isArray(result.statusValues) ? result.statusValues as Record<string, string | number | boolean | null> : null,
      statusRawContent: source.kind === 'status_json' && typeof result?.statusRawContent === 'string' && Buffer.byteLength(result.statusRawContent, 'utf8') <= 256 * 1024 ? result.statusRawContent : null,
      heldByRegisteredProcess: null,
      errorCode: typeof result?.errorCode === 'string' ? result.errorCode : null,
      evidenceComplete: status === 'ok' && !!fileIdentity && typeof result?.eofBytes === 'string' && /^\d+$/.test(result.eofBytes),
      errorScope: typeof result?.errorCode === 'string' ? 'source' as const : null,
      phase: typeof result?.errorCode === 'string' ? 'source_read' as const : null,
    };
  });
  const sourceIdentityById = new Map(sources.map((row) => [row.sourceId, { fileIdentity: row.fileIdentity, eofBytes: row.eofBytes }]));
  const processes: TaskObservation['processes'] = [];
  if (Array.isArray(data.processes)) for (const value of data.processes) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const key = validateProcessKey(row.processKey);
    if (!key || !['trainer', 'queue', 'worker', 'unknown'].includes(String(row.role))) continue;
    const evidence = row.writerSourceEvidence && typeof row.writerSourceEvidence === 'object' ? row.writerSourceEvidence as Record<string, unknown> : {};
    const reportedWriterIds = Array.isArray(row.writerSourceIds) ? row.writerSourceIds.filter((id): id is string => typeof id === 'string' && task.sources.some((item) => item.sourceId === id)) : [];
    const writerIds = reportedWriterIds.filter((id): id is string => {
      if (typeof id !== 'string' || !task.sources.some((item) => item.sourceId === id)) return false;
      const expected = sourceIdentityById.get(id);
      const actual = evidence[id] && typeof evidence[id] === 'object' ? evidence[id] as Record<string, unknown> : {};
      return !!expected && expected.fileIdentity !== null && expected.eofBytes !== null &&
        JSON.stringify(actual.fileIdentity) === JSON.stringify(expected.fileIdentity) && actual.eofBytes === expected.eofBytes;
    });
    const launcherEntry = typeof row.launcherEntry === 'string' && typeof row.cwd === 'string' && isRegisteredLauncherPath(task, { cwd: row.cwd, launcherEntry: row.launcherEntry }) ? row.launcherEntry : null;
    const entryVerified = row.roleEvidence === 'exact_script_entry' || row.roleEvidence === 'exact_entry_and_direct_writer_fd' || launcherEntry !== null;
    const confirmedWriter = (row.roleEvidence === 'exact_entry_and_direct_writer_fd' || launcherEntry !== null) && writerIds.length > 0;
    const writerSourceEvidence: NonNullable<TaskObservation['processes'][number]['writerSourceEvidence']> = {};
    for (const id of writerIds) writerSourceEvidence[id] = evidence[id] as { fileIdentity: SourceObservation['fileIdentity']; eofBytes: string };
    // Receipt time is on the desktop clock, shared with lifecycle and progress TTLs.
    processes.push({ key, role: 'unknown', cwd: typeof row.cwd === 'string' ? row.cwd : null, scriptEntry: typeof row.scriptEntry === 'string' ? row.scriptEntry : null, launcherEntry, observedAt, roleEvidence: confirmedWriter ? 'exact_entry_and_direct_writer_fd' : entryVerified ? 'exact_script_entry' : 'none', directWriterSourceIds: confirmedWriter ? writerIds : [], writerSourceEvidence, writerEvidenceComplete: row.writerEvidenceComplete === true && complete && writerIds.length === reportedWriterIds.length, evidenceComplete: row.evidenceComplete === true && entryVerified && complete, interpreterFlags: Array.isArray(row.interpreterFlags) ? row.interpreterFlags.filter((flag): flag is string => typeof flag === 'string').slice(0, 16) : [] });
  }
  const hostError = data.errorScope === 'host' && typeof data.errorCode === 'string' ? data.errorCode : null;
  const requestError = data.errorScope === 'request' && typeof data.errorCode === 'string' ? data.errorCode : null;
  const taskError = data.errorScope === 'task' && typeof data.errorCode === 'string' ? data.errorCode : null;
  const observationError = hostError ?? requestError;
  const validPhases: FailurePhase[] = ['wsl_list', 'connect', 'python_start', 'probe', 'process_scan', 'frame', 'validate', 'source_read', 'dispatch', 'archive_scan'];
  const phase = validPhases.includes(data.phase as FailurePhase) ? data.phase as FailurePhase : null;
  return { taskId: task.taskId, hostId: task.hostId, observedAt: observationError ? null : observedAt, freshness: observationError ? 'unobserved' : 'fresh', scanComplete: complete && !observationError, processScanError: typeof data.errorCode === 'string' ? data.errorCode : null, phase, processes: observationError ? [] : processes, sources, errorCode: hostError ?? requestError ?? taskError, errorScope: hostError ? 'host' : requestError ? 'request' : taskError ? 'task' : null };
}

export interface CreateTransportOptions { probeSource: string; launcherSource?: string; serverAgentSource?: string; spawn?: SpawnLike; registryProvider?: () => Promise<Registry>; rotationCatalog?: RotationCatalogLoad }

export function createTransport(context: TransportHostContext, options: CreateTransportOptions): Transport {
  const spawnChild = options.spawn ?? nodeSpawn as SpawnLike;
  const registryProvider = options.registryProvider ?? (async () => context.registry);
  const now = () => new Date().toISOString();
  let devices: { uuid: string; index: number }[] = [];
  let gpuHostBootId: string | null = null;
  const currentContext = async () => {
    const registry = await registryProvider();
    const host = registry.hosts.find((item) => item.hostId === context.hostId);
    if (!host || JSON.stringify(host.target) !== JSON.stringify(context.host.target) || host.enabled !== context.host.enabled) throw coded('REGISTRY_CHANGED');
    return { registry, host };
  };
  const serverWait = async (op: 'ensure_server_wait' | 'get_server_wait' | 'cancel_server_wait', task: TaskRegistration, configHash: string, signal: AbortSignal): Promise<ServerWaitResult> => {
    if (context.host.target.kind !== 'ssh') throw coded('SERVER_WAIT_SSH_ONLY');
    const { registry, host } = await currentContext();
    const registered = registry.tasks.find(item => item.taskId === task.taskId);
    if (!registered?.autoStart || registered.hostId !== host.hostId || fingerprint(task, host) !== fingerprint(registered, host) || !/^[a-f0-9]{64}$/.test(configHash)) throw coded('REGISTRY_CHANGED');
    const config = registered.autoStart;
    if (config.execution !== 'server_tmux') throw coded('SERVER_WAIT_CONFIRMATION_REQUIRED');
    if (op === 'ensure_server_wait' && (!host.enabled || !registered.enabled || !config.enabled)) throw coded('REGISTRY_CHANGED');
    const scopes = pathScopes(host, registered);
    if (!scopes.taskAllowedDirectories.length || !options.launcherSource || !options.serverAgentSource) throw coded('SERVER_WAIT_UNAVAILABLE');
    const launcher = options.launcherSource.replace('__READONLY_PROBE_SOURCE_B64__', Buffer.from(options.probeSource).toString('base64'));
    const template = options.serverAgentSource.replace('__LAUNCHER_SOURCE_B64__', Buffer.from(launcher).toString('base64'));
    const script = template.replace('__SERVER_AGENT_SOURCE_B64__', Buffer.from(template).toString('base64'));
    const requestId = randomUUID();
    const request: Record<string, unknown> = { version: PROTOCOL_VERSION, requestId, sourceId: null, op, taskId: task.taskId, armId: config.armId, configHash, ...scopes };
    if (op === 'ensure_server_wait') Object.assign(request, { idleSeconds: config.idleSeconds, retryOnExit: config.retryOnExit ?? false, launchRequest: {
      version: PROTOCOL_VERSION, requestId, sourceId: null, op: 'launch_task', taskId: task.taskId, armId: config.armId, configHash, ...scopes,
      entryPaths: registered.entryPaths, sources: registered.sources, launch: config.launch, gpuDevices: [],
      maxUtilizationPercent: config.maxUtilizationPercent, maxMemoryMiB: config.maxMemoryMiB,
      ...(config.minFreeMemoryMiB ? { minFreeMemoryMiB: config.minFreeMemoryMiB } : {}),
      ...(config.minFreeDiskMiB ? { minFreeDiskMiB: config.minFreeDiskMiB } : {}),
      ...(config.gpuSharing ? { gpuSharing: config.gpuSharing } : {}),
    } });
    const data = await invokeProbe({ ...context, host, registry }, script, request, signal, spawnChild, false, { timeoutMs: 20_000 }) as Record<string, unknown>;
    const keys = ['state', 'armId', 'configHash', 'idleElapsedSeconds', 'requiredIdleSeconds', 'lastCheckedAt', 'startedAt', 'pid', 'errorCode', 'message', 'sessionName', 'selectedDeviceId'];
    if (!data || Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key)) ||
        !['missing', 'waiting', 'countdown', 'blocked', 'starting', 'started', 'failed', 'cancelled'].includes(String(data.state)) || data.armId !== config.armId || data.configHash !== configHash ||
        !Number.isSafeInteger(data.idleElapsedSeconds) || Number(data.idleElapsedSeconds) < 0 || Number(data.idleElapsedSeconds) > 86400 ||
        !Number.isSafeInteger(data.requiredIdleSeconds) || Number(data.requiredIdleSeconds) < 1 || Number(data.requiredIdleSeconds) > 86400 ||
        ![data.lastCheckedAt, data.startedAt].every(time => time === null || typeof time === 'string' && iso(time) !== null) ||
        !(data.pid === null || Number.isSafeInteger(data.pid) && Number(data.pid) > 0) ||
        !(data.errorCode === null || typeof data.errorCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(data.errorCode)) ||
        !(data.message === null || typeof data.message === 'string' && data.message.length <= 512 && !/[\u0000-\u001f\u007f]/.test(data.message)) ||
        !(data.sessionName === null || typeof data.sessionName === 'string' && /^tm-wait-[a-f0-9]{40}$/.test(data.sessionName)) ||
        !(data.selectedDeviceId === null || typeof data.selectedDeviceId === 'string' && /^GPU (0|[1-9]\d{0,3})$/.test(data.selectedDeviceId)) ||
        data.state === 'started' && (data.pid === null || data.startedAt === null)) throw coded('SERVER_WAIT_PROTOCOL_INVALID');
    return data as unknown as ServerWaitResult;
  };

  return {
    ensureServerWait: (task, hash, signal) => serverWait('ensure_server_wait', task, hash, signal),
    getServerWait: (task, hash, signal) => serverWait('get_server_wait', task, hash, signal),
    cancelServerWait: (task, hash, signal) => serverWait('cancel_server_wait', task, hash, signal),
    async createRegistrationReference(taskId) {
      const { registry, host } = await currentContext();
      const task = registry.tasks.find((item) => item.taskId === taskId);
      if (!task || task.hostId !== host.hostId || !task.enabled || !host.enabled) throw coded('REGISTRY_HOST_MISMATCH');
      return { taskId: task.taskId, registryRevision: registry.revision, fingerprint: fingerprint(task, host) };
    },
    async probeHost(signal) {
      const observedAt = now();
      devices = [];
      gpuHostBootId = null;
      try {
        const { host } = await currentContext();
        if (!host.enabled) return { hostId: host.hostId, freshness: 'unobserved', observedAt: null, phase: null, connection: 'unobserved', scanComplete: false, hostBootId: null, errorCode: 'HOST_DISABLED' };
        const payload = await invokeProbe({ ...context, host }, options.probeSource, {
          version: PROTOCOL_VERSION, requestId: randomUUID(), sourceId: null, op: 'probe_host',
          includeGpu: host.target.kind === 'ssh',
        }, signal, spawnChild);
        const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        const scope = ['host', 'request', 'task', 'source'].includes(String(data.errorScope)) ? data.errorScope as FailureScope : null;
        if (typeof data.errorCode === 'string') return { hostId: host.hostId, freshness: 'unobserved', observedAt: null, phase: validProbePhase(data.phase) ?? 'probe', connection: 'unobserved', scanComplete: false, hostBootId: null, errorCode: data.errorCode, errorScope: scope ?? 'request' };
        const gpu = host.target.kind === 'wsl'
          ? await windowsGpuObservation(signal, spawnChild, value => { devices = value; })
          : linuxGpuObservation(data.gpu, now());
        if (host.target.kind === 'ssh' && gpu?.state === 'available' && data.gpu && typeof data.gpu === 'object' && (data.gpu as Record<string, unknown>).status === 'ok') {
          const csv = (data.gpu as Record<string, unknown>).csv;
          if (typeof csv === 'string') devices = gpuDeviceMap(csv);
          gpuHostBootId = typeof data.hostBootId === 'string' ? data.hostBootId : null;
        }
        if (gpu?.state === 'available') gpuHostBootId = typeof data.hostBootId === 'string' ? data.hostBootId : null;
        return { hostId: host.hostId, freshness: 'fresh', observedAt: now(), phase: validProbePhase(data.phase) ?? 'probe', connection: 'connected', scanComplete: data.scanComplete === true, hostBootId: typeof data.hostBootId === 'string' ? data.hostBootId : null, errorCode: null, errorScope: null, gpu };
      } catch (error) {
        const failure = failureFields(error, 'probe');
        const scope = failure.errorScope === 'request' && failure.code === 'TRANSPORT_UNAVAILABLE' ? 'host' : failure.errorScope;
        const phase = failure.phase === 'validate' ? failure.code === 'WSL_NOT_RUNNING' || failure.code === 'WSL_LIST_FAILED' ? 'wsl_list' : failure.code === 'REMOTE_PROBE_FAILED' ? 'python_start' : failure.code === 'SSH_EXIT_UNCLASSIFIED' ? 'connect' : scope === 'host' ? 'connect' : 'probe' : failure.phase;
        return { hostId: context.hostId, freshness: 'unobserved', observedAt: null, phase, connection: 'unobserved', scanComplete: false, hostBootId: null, errorCode: failure.code, errorScope: scope };
      }
    },
    async probeTask(task, signal) {
      const observedAt = now();
      try {
        const { registry, host } = await currentContext();
        const registered = registry.tasks.find((item) => item.taskId === task.taskId);
        if (!host.enabled || !registered?.enabled || task.hostId !== host.hostId || registered.hostId !== host.hostId || task.hostId !== context.hostId || fingerprint(task, host) !== fingerprint(registered, host)) throw coded('REGISTRY_HOST_MISMATCH');
        const scopes = pathScopes(host, registered);
        if (!scopes.taskAllowedDirectories.length) throw coded('PATH_OUTSIDE_ALLOWED_ROOT');
        const payload = await invokeProbe({ ...context, host, registry }, options.probeSource, {
          version: PROTOCOL_VERSION, requestId: randomUUID(), sourceId: null, op: 'probe_task',
          proc: { root: '/proc' },
          includeProcessGpu: host.target.kind === 'ssh',
          gpuDevices: host.target.kind === 'ssh' ? devices : [],
          task: { taskId: registered.taskId, ...scopes, allowedDirectories: scopes.taskAllowedDirectories, entryPaths: registered.entryPaths, sources: registered.sources },
        }, signal, spawnChild);
        const observation = projectTaskObservation(registered, payload, now());
        const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        const keys = observation.processes.filter(process => process.key.hostBootId === gpuHostBootId && isRegisteredGpuProcess(registered, process)).map(process => process.key);
        observation.processGpu = host.target.kind === 'wsl'
          ? { observedAt: null, state: 'unavailable', errorCode: 'WSL_PROCESS_GPU_UNAVAILABLE', metrics: [], processKeys: [] }
          : projectProcessGpu(data.processGpu, keys, devices, now());
        return observation;
      } catch (error) {
        const failure = failureFields(error, 'probe');
        return { taskId: task.taskId, hostId: task.hostId, observedAt: null, freshness: 'unobserved', scanComplete: false, processScanError: failure.code, phase: failure.phase, processes: [], sources: task.sources.map((source) => ({ sourceId: source.sourceId, observedAt: null, fileIdentity: null, eofBytes: null, permission: 'unknown' as const, exists: null, statusValues: null, heldByRegisteredProcess: null, errorCode: null, evidenceComplete: false, errorScope: null, phase: null })), errorCode: failure.code, errorScope: failure.errorScope };
      }
    },
    async checkTaskStopped(task, signal) {
      const { registry, host } = await currentContext();
      const registered = registry.tasks.find(item => item.taskId === task.taskId);
      if (!host.enabled || !registered?.enabled || registered.hostId !== host.hostId || fingerprint(task, host) !== fingerprint(registered, host)) throw coded('REGISTRY_CHANGED');
      const scopes = pathScopes(host, registered);
      if (!scopes.taskAllowedDirectories.length) throw coded('PATH_OUTSIDE_ALLOWED_ROOT');
      const data = await invokeProbe({ ...context, host, registry }, options.probeSource, {
        version: PROTOCOL_VERSION, requestId: randomUUID(), sourceId: null, op: 'probe_launch_readiness', proc: { root: '/proc' },
        task: { taskId: task.taskId, ...scopes, allowedDirectories: scopes.taskAllowedDirectories, entryPaths: registered.entryPaths, sources: [] },
      }, signal, spawnChild) as Record<string, unknown>;
      if (!data || typeof data.scanComplete !== 'boolean' || typeof data.running !== 'boolean' || !(data.errorCode === null || typeof data.errorCode === 'string')) throw coded('PROTOCOL_INVALID');
      return { scanComplete: data.scanComplete, running: data.running, errorCode: data.errorCode as string | null };
    },
    async launchTask(task, armId, configHash, signal) {
      const { registry, host } = await currentContext();
      const registered = registry.tasks.find(item => item.taskId === task.taskId);
      if (!host.enabled || !registered?.enabled || registered.hostId !== host.hostId || fingerprint(task, host) !== fingerprint(registered, host) || !registered.autoStart?.enabled || registered.autoStart.armId !== armId) throw coded('REGISTRY_CHANGED');
      const config = registered.autoStart;
      const scopes = pathScopes(host, registered);
      if (!scopes.taskAllowedDirectories.length || !options.launcherSource || !gpuHostBootId || !/^[a-f0-9]{64}$/.test(configHash)) throw coded('LAUNCH_SERVICE_UNAVAILABLE');
      const gpuDevices = config.gpuDeviceIds.map(deviceId => {
        const device = devices.find(item => `GPU ${item.index}` === deviceId);
        if (!device) throw coded('GPU_IDENTITY_UNAVAILABLE');
        return { deviceId, uuid: device.uuid };
      });
      const script = options.launcherSource.replace('__READONLY_PROBE_SOURCE_B64__', Buffer.from(options.probeSource).toString('base64'));
      const data = await invokeProbe({ ...context, host, registry }, script, {
        version: PROTOCOL_VERSION, requestId: randomUUID(), sourceId: null, op: 'launch_task',
        armId, taskId: task.taskId, configHash, ...scopes, entryPaths: registered.entryPaths, sources: registered.sources,
        launch: config.launch, gpuDevices, maxUtilizationPercent: config.maxUtilizationPercent, maxMemoryMiB: config.maxMemoryMiB,
        ...(config.minFreeMemoryMiB ? { minFreeMemoryMiB: config.minFreeMemoryMiB } : {}),
        ...(config.minFreeDiskMiB ? { minFreeDiskMiB: config.minFreeDiskMiB } : {}),
        ...(config.gpuSharing ? { gpuSharing: config.gpuSharing } : {}),
      }, signal, spawnChild, false, { timeoutMs: 15_000 }) as Record<string, unknown>;
      if (!data || !['started', 'busy', 'already_running', 'failed'].includes(String(data.status)) ||
          !(data.pid === null || Number.isSafeInteger(data.pid) && Number(data.pid) > 0) || !(data.startedAt === null || iso(data.startedAt)) ||
          !(data.errorCode === null || typeof data.errorCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(data.errorCode)) ||
          !(data.processKey === null || validateProcessKey(data.processKey)) ||
          (data.status === 'started' && (data.pid === null || data.startedAt === null))) throw coded('PROTOCOL_INVALID');
      return { status: data.status, pid: data.pid, processKey: data.processKey, startedAt: data.startedAt, errorCode: data.errorCode } as LaunchResult;
    },
    async readLog(request: ReadRequest, signal): Promise<ReadReply> {
      const { registry, host } = await currentContext();
      const registration = sourceFor(registry, request.registration.taskId, request.sourceId);
      if (!registration || registration.host.hostId !== host.hostId || !registration.task.enabled || !host.enabled ||
          registration.task.hostId !== host.hostId || request.registration.registryRevision !== registry.revision ||
          request.registration.fingerprint !== fingerprint(registration.task, host)) throw coded('REGISTRY_CHANGED');
      if (request.kind !== 'current' && request.kind !== 'registered_rotation') throw coded('READ_KIND_INVALID');
      if (request.offset !== request.expected.committedOffset || !/^\d+$/.test(request.offset) ||
          !Number.isSafeInteger(request.limitBytes) || request.limitBytes < 0 || request.limitBytes > MAX_READ_BYTES) throw coded('READ_LIMIT_INVALID');
      if (request.anchors.length > 2 || request.anchors.some((anchor) => !Number.isSafeInteger(anchor.length) || anchor.length < 0 || anchor.length > 4096 || !/^\d+$/.test(anchor.startOffset) || !/^[a-f\d]{64}$/i.test(anchor.sha256))) throw coded('ANCHOR_REQUEST_INVALID');
      if (request.kind === 'registered_rotation' && request.anchors.length === 0) throw coded('OLD_ANCHORS_UNAVAILABLE');
      let remotePath = registration.source.path;
      if (request.kind === 'registered_rotation') {
        if (!request.candidate || request.candidate.sourceId !== request.sourceId || !options.rotationCatalog || options.rotationCatalog.status !== 'configured') throw coded('ROTATION_CANDIDATE_INVALID');
        const candidate = await options.rotationCatalog.resolveCandidate(request.candidate);
        if (!candidate || candidate.taskId !== registration.task.taskId || candidate.currentPath === candidate.path || !registration.task.allowedDirectories.includes(path.posix.dirname(candidate.path))) throw coded('ROTATION_CANDIDATE_INVALID');
        remotePath = candidate.path;
      }
      const requestId = randomUUID();
      const scopes = pathScopes(host, registration.task);
      if (!scopes.taskAllowedDirectories.length || !scopes.taskAllowedDirectories.some((root) => pathWithin(root, remotePath))) throw coded('PATH_OUTSIDE_ALLOWED_ROOT');
      const payload = await invokeProbe({ ...context, host, registry }, options.probeSource, {
        version: PROTOCOL_VERSION, requestId, sourceId: request.sourceId, op: 'read_log',
        path: remotePath, currentPath: registration.source.path, ...scopes,
        offset: request.offset, limitBytes: request.limitBytes, anchors: request.anchors,
        expected: request.expected, kind: request.kind,
      }, signal, spawnChild);
      const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      if (typeof data.errorCode === 'string') throw coded(data.errorCode, validErrorScope(data.errorScope) ?? 'source', validProbePhase(data.phase) ?? 'source_read', requestId, request.sourceId);
      if (data.ok !== true || data.expected === undefined || JSON.stringify(data.expected) !== JSON.stringify(request.expected)) throw coded(typeof data.errorCode === 'string' ? data.errorCode : 'PROTOCOL_CAS_MISMATCH');
      const before = parseObservation(data.before, request.anchors);
      const after = parseObservation(data.after, request.anchors);
      if (JSON.stringify(before.fileIdentity) !== JSON.stringify(after.fileIdentity)) throw coded('PATH_IDENTITY_CHANGED');
      if (data.startOffset !== request.offset || typeof data.bytesBase64 !== 'string' || !Number.isSafeInteger(data.bytesLength)) throw coded('PROTOCOL_READ_SCHEMA_INVALID');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.bytesBase64)) throw coded('PROTOCOL_BASE64_INVALID');
      const bytes = Buffer.from(data.bytesBase64, 'base64');
      if (bytes.length !== data.bytesLength || bytes.length > request.limitBytes) throw coded('PROTOCOL_READ_LENGTH_MISMATCH');
      return { sourceId: request.sourceId, expected: request.expected, startOffset: request.offset, bytes: new Uint8Array(bytes), before, after };
    },
    async scanArchiveCandidates(sourceId, registration, anchors, signal): Promise<ArchiveCandidateScan> {
      const observedAt = now();
      const catalog = options.rotationCatalog;
      if (!catalog || catalog.status !== 'configured') return { status: 'inconclusive', candidates: [], errorCode: 'ROTATION_CATALOG_UNCONFIGURED', observedAt };
      if (anchors.length === 0 || anchors.length > 2 || anchors.some((anchor) => !Number.isSafeInteger(anchor.length) || anchor.length < 0 || anchor.length > 4096 || !/^\d+$/.test(anchor.startOffset) || !/^[a-f\d]{64}$/i.test(anchor.sha256))) return { status: 'inconclusive', candidates: [], errorCode: 'OLD_ANCHORS_UNAVAILABLE', observedAt };
      const { registry, host } = await currentContext();
      const link = sourceFor(registry, registration.taskId, sourceId);
      if (!link || link.host.hostId !== host.hostId || !link.task.enabled || !host.enabled || registration.registryRevision !== registry.revision || registration.fingerprint !== fingerprint(link.task, host)) return { status: 'inconclusive', candidates: [], errorCode: 'REGISTRY_CHANGED', observedAt };
      const refs = catalog.listCandidates(sourceId);
      if (!refs.length) return { status: 'inconclusive', candidates: [], errorCode: 'ROTATION_CANDIDATES_UNAVAILABLE', observedAt };
      const resolved = [];
      for (const reference of refs) {
        const candidate = await catalog.resolveCandidate(reference);
        if (!candidate || candidate.taskId !== link.task.taskId || candidate.path === link.source.path || !link.task.allowedDirectories.includes(path.posix.dirname(candidate.path))) continue;
        resolved.push({ reference, path: candidate.path });
      }
      if (!resolved.length) return { status: 'inconclusive', candidates: [], errorCode: 'ROTATION_CANDIDATES_UNAVAILABLE', observedAt };
      const requestId = randomUUID();
      const payload = await invokeProbe({ ...context, host, registry }, options.probeSource, {
        version: PROTOCOL_VERSION, requestId, sourceId, op: 'scan_rotation',
        currentPath: link.source.path, candidates: resolved.map((item) => item.path), ...pathScopes(host, link.task), anchors,
      }, signal, spawnChild);
      const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      if (typeof data.errorCode === 'string') return { status: 'inconclusive', candidates: [], errorCode: data.errorCode, errorScope: validErrorScope(data.errorScope) ?? 'source', phase: validProbePhase(data.phase) ?? 'archive_scan', requestId, sourceId, observedAt };
      const candidates = [];
      if (Array.isArray(data.candidates)) for (const row of data.candidates) {
        if (!row || typeof row !== 'object') continue;
        const item = row as Record<string, unknown>;
        const index = item.candidateIndex;
        if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= resolved.length || typeof item.sizeBytes !== 'string' || !/^\d+$/.test(item.sizeBytes)) continue;
        const ref = resolved[index as number]!.reference;
        candidates.push({ reference: ref, startOffset: '0', endOffset: item.sizeBytes });
      }
      const complete = data.scanComplete === true && data.checkedCount === resolved.length;
      return { status: complete ? 'complete' : 'inconclusive', candidates, errorCode: complete ? null : typeof data.errorCode === 'string' ? data.errorCode : 'ROTATION_SCAN_INCOMPLETE', errorScope: complete ? null : validErrorScope(data.errorScope) ?? 'source', phase: complete ? null : validProbePhase(data.phase) ?? 'archive_scan', requestId, sourceId, observedAt };
    },
  };
}

function parseObservation(value: unknown, anchors: ReadRequest['anchors']): SourceObservation {
  if (!value || typeof value !== 'object') throw coded('PROTOCOL_OBSERVATION_INVALID');
  const row = value as Record<string, unknown>;
  const identity = row.fileIdentity;
  if (!identity || typeof identity !== 'object' || typeof (identity as Record<string, unknown>).dev !== 'string' || typeof (identity as Record<string, unknown>).inode !== 'string' || typeof row.sizeBytes !== 'string' || !/^\d+$/.test(row.sizeBytes)) throw coded('PROTOCOL_IDENTITY_INVALID');
  const observedAt = iso(row.observedAt);
  if (!observedAt) throw coded('PROTOCOL_OBSERVATION_INVALID');
  return { fileIdentity: { dev: (identity as Record<string, string>).dev, inode: (identity as Record<string, string>).inode }, sizeBytes: row.sizeBytes, anchors: anchors.map((item) => ({ startOffset: item.startOffset, endOffset: (BigInt(item.startOffset) + BigInt(item.length)).toString(), sha256: item.sha256 })), observedAt, identityStrength: 'strong' };
}
