import { createHash, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  AcceleratorAvailability,
  DiscoveredProcess,
  HostRegistration,
  HostSystemHealth,
  HostTarget,
  JobControlAction,
  JobControlResult,
  ProcessKey,
  Registry,
  TaskRegistration,
} from '../shared/contracts';
import type { ReadReply, SourceObservation } from '../logs/types';
import type { RotationCatalogLoad } from '../registry/rotation-catalog';
import { commandSpecFor, stoppedWslListArgs } from './commands';
import { parseWslListOutput } from './discovery';
import { gpuDeviceMap, isRegisteredGpuProcess, projectGpuCsv, projectProcessGpu } from './gpu';
import {
  decodeFrames,
  encodeFrame,
  FrameStreamDecoder,
  MAX_READ_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_STDERR_BYTES,
  PROTOCOL_VERSION,
  validateProbeEnvelope,
} from './protocol';
import { isRegisteredLauncherPath } from '../domain/identity';
import type {
  ArchiveCandidateScan,
  BatchProbeObservation,
  HostObservation,
  LaunchResult,
  ReadRequest,
  ServerWaitResult,
  SpawnLike,
  TaskObservation,
  Transport,
  TransportHostContext,
} from './types';

export interface BoundedChildResult { stdout: Buffer; stderr: Buffer; exitCode: number | null }
export interface ChildLimits { timeoutMs?: number; stdoutLimitBytes?: number; stderrLimitBytes?: number }

const STDERR_DIAGNOSTIC_LIMIT_BYTES = 4 * 1024;
const SIGKILL_ESCALATION_MS = 1_500;
const EPIPE_CLOSE_GRACE_MS = 20;

type FailureScope = 'host' | 'task' | 'request' | 'source';
type FailurePhase =
  | 'wsl_list'
  | 'connect'
  | 'python_start'
  | 'probe'
  | 'process_scan'
  | 'frame'
  | 'validate'
  | 'source_read'
  | 'dispatch'
  | 'archive_scan';

function coded(
  code: string,
  errorScope: FailureScope = 'request',
  phase: FailurePhase = 'validate',
  requestId: string | null = null,
  sourceId: string | null = null,
  diagnostic?: string,
): Error {
  const error = new Error(code) as Error & {
    code: string;
    errorScope: FailureScope;
    phase: FailurePhase;
    requestId: string | null;
    sourceId: string | null;
    diagnostic?: string;
  };
  Object.assign(error, { code, errorScope, phase, requestId, sourceId, ...(diagnostic ? { diagnostic } : {}) });
  return error;
}

function failureFields(
  error: unknown,
  fallbackPhase: FailurePhase,
): { code: string; errorScope: FailureScope; phase: FailurePhase; requestId: string | null; sourceId: string | null } {
  const row = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const scope = ['host', 'task', 'request', 'source'].includes(String(row.errorScope)) ? row.errorScope as FailureScope : 'request';
  const phases: FailurePhase[] = [
    'wsl_list', 'connect', 'python_start', 'probe', 'process_scan',
    'frame', 'validate', 'source_read', 'dispatch', 'archive_scan',
  ];
  return {
    code: error instanceof Error ? error.message : 'PROBE_FAILED',
    errorScope: scope,
    phase: phases.includes(String(row.phase) as FailurePhase) ? row.phase as FailurePhase : fallbackPhase,
    requestId: typeof row.requestId === 'string' ? row.requestId : null,
    sourceId: typeof row.sourceId === 'string' ? row.sourceId : null,
  };
}

/** Bounds and sanitizes stderr diagnostics to 4 KiB without leaking local private key / home paths. */
export function sanitizeStderr(raw: Buffer | string): string {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  const bounded = buf.length > STDERR_DIAGNOSTIC_LIMIT_BYTES
    ? buf.subarray(0, STDERR_DIAGNOSTIC_LIMIT_BYTES).toString('utf8')
    : buf.toString('utf8');
  return bounded
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1<redacted>')
    .replace(/(\/(?:home|Users)\/)[^/\s:]+/g, '$1<redacted>')
    .replace(/(-i\s+)(\S+)/g, '$1<redacted>')
    .trim();
}

export function classifyTransportFailure(
  targetKind: HostTarget['kind'],
  exitCode: number | null,
  stderrBuffer: Buffer | string,
): { code: string; errorScope: FailureScope; phase: FailurePhase; diagnostic: string } {
  const diagnostic = sanitizeStderr(stderrBuffer);
  const lower = diagnostic.toLowerCase();

  if (
    diagnostic.includes('TM_ERR:REMOTE_PYTHON_UNAVAILABLE') ||
    ((exitCode === 126 || exitCode === 127) && (lower.includes('python') || diagnostic.includes('TM_ERR:')))
  ) {
    return { code: 'REMOTE_PYTHON_UNAVAILABLE', errorScope: 'host', phase: 'python_start', diagnostic };
  }

  if (targetKind === 'ssh') {
    if (
      lower.includes('host key verification failed') ||
      lower.includes('are you sure you want to continue connecting') ||
      lower.includes('remote host identification has changed') ||
      lower.includes('offending ')
    ) {
      return { code: 'SSH_HOST_KEY_UNKNOWN', errorScope: 'host', phase: 'connect', diagnostic };
    }
    if (
      lower.includes('permission denied') ||
      lower.includes('authentication failed') ||
      lower.includes('too many authentication failures') ||
      lower.includes('no more authentication methods')
    ) {
      return { code: 'SSH_AUTH_FAILED', errorScope: 'host', phase: 'connect', diagnostic };
    }
    if (lower.includes('connection refused')) {
      return { code: 'SSH_CONNECTION_REFUSED', errorScope: 'host', phase: 'connect', diagnostic };
    }
    if (lower.includes('connection timed out') || lower.includes('operation timed out') || lower.includes('timed out')) {
      return { code: 'SSH_TIMEOUT', errorScope: 'host', phase: 'connect', diagnostic };
    }
    if (
      lower.includes('could not resolve hostname') ||
      lower.includes('name or service not known') ||
      lower.includes('no route to host') ||
      lower.includes('network is unreachable') ||
      lower.includes('temporary failure in name resolution') ||
      lower.includes('connection reset by peer') ||
      lower.includes('connection closed by remote host') ||
      lower.includes('broken pipe')
    ) {
      return { code: 'HOST_UNREACHABLE', errorScope: 'host', phase: 'connect', diagnostic };
    }
    if (exitCode === 255) {
      return { code: 'SSH_EXIT_UNCLASSIFIED', errorScope: 'request', phase: 'connect', diagnostic };
    }
  }

  return { code: 'REMOTE_PROBE_FAILED', errorScope: 'request', phase: 'python_start', diagnostic };
}

/**
 * Safely terminates a child process tree: SIGTERM followed by SIGKILL after 1500ms
 * (POSIX negative-PID process group when detached, Windows `taskkill /PID /T /F`).
 */
export function terminateProcessTree(child: any, options: { detached?: boolean; platform?: NodeJS.Platform } = {}): void {
  if (!child) return;
  const platform = options.platform ?? process.platform;
  const pid: number | undefined = typeof child.pid === 'number' && child.pid > 0 ? child.pid : undefined;
  let exited = child.exitCode !== null && child.exitCode !== undefined;
  const markExited = () => { exited = true; };
  try { child.once?.('exit', markExited); } catch { /* ignore */ }
  try { child.once?.('close', markExited); } catch { /* ignore */ }

  const sendSignal = (sig: NodeJS.Signals) => {
    if (exited) return;
    if (platform === 'win32') {
      if (sig === 'SIGKILL' && pid) {
        try {
          const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            shell: false, stdio: 'ignore', windowsHide: true,
          });
          killer.unref?.();
        } catch {
          try { child.kill(); } catch { /* ignore */ }
        }
      } else {
        try { child.kill(); } catch { /* ignore */ }
      }
      return;
    }

    if (options.detached && pid) {
      try { process.kill(-pid, sig); return; } catch { /* fall through to direct kill */ }
    }
    try { child.kill(sig); } catch { /* ignore */ }
  };

  sendSignal('SIGTERM');
  if (!exited) {
    const escalation = setTimeout(() => {
      if (!exited) sendSignal('SIGKILL');
    }, SIGKILL_ESCALATION_MS);
    escalation.unref?.();
  }
}

export function runBoundedChild(
  command: string,
  args: string[],
  input: Buffer,
  signal: AbortSignal,
  spawnChild: SpawnLike = nodeSpawn as SpawnLike,
  limits: ChildLimits = {},
): Promise<BoundedChildResult> {
  const timeoutMs = limits.timeoutMs ?? 5_000;
  const stdoutLimit = limits.stdoutLimitBytes ?? MAX_RESPONSE_BYTES;
  const stderrLimit = limits.stderrLimitBytes ?? MAX_STDERR_BYTES;
  if (signal.aborted) return Promise.reject(coded('PROBE_CANCELLED'));
  const useDetached = spawnChild === (nodeSpawn as unknown) && process.platform !== 'win32';

  return new Promise((resolve, reject) => {
    let child: any;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdinFailed = false;
    let epipeTimer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const finish = (error?: Error, exitCode: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (epipeTimer) clearTimeout(epipeTimer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
    };
    const stop = (code: string) => {
      if (settled) return;
      finish(coded(code));
      terminateProcessTree(child, { detached: useDetached });
    };
    const abort = () => stop('PROBE_CANCELLED');
    const timer = setTimeout(() => stop('PROBE_TIMEOUT'), timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });

    try {
      const spawnOpts = useDetached
        ? { shell: false as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true as const, detached: true }
        : { shell: false as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true as const };
      child = spawnChild(command, args, spawnOpts);
    } catch {
      finish(coded('TRANSPORT_UNAVAILABLE'));
      return;
    }

    child.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      const data = Buffer.from(chunk);
      stdoutBytes += data.length;
      if (stdoutBytes > stdoutLimit) { stop('RESPONSE_LIMIT'); return; }
      stdout.push(data);
    });
    child.stderr.on('data', (chunk: Buffer | Uint8Array) => {
      const data = Buffer.from(chunk);
      stderrBytes += data.length;
      if (stderrBytes > stderrLimit) { stop('STDERR_LIMIT'); return; }
      stderr.push(data);
    });
    child.once('error', () => finish(coded('TRANSPORT_UNAVAILABLE')));

    // On EPIPE (e.g. ssh immediately rejected host key / auth), wait briefly for `close`
    // so stderr and exit code are preserved instead of masking the real root cause.
    child.stdin.on('error', () => {
      if (settled) return;
      stdinFailed = true;
      if (!epipeTimer) {
        epipeTimer = setTimeout(() => {
          if (!settled) stop('PROBE_STDIN_FAILED');
        }, EPIPE_CLOSE_GRACE_MS);
        epipeTimer.unref?.();
      }
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      if (stdinFailed && code === 0 && stdout.length === 0) {
        finish(coded('PROBE_STDIN_FAILED'));
        return;
      }
      finish(undefined, code);
    });
    try {
      child.stdin.end(input);
    } catch {
      stdinFailed = true;
      if (!epipeTimer) {
        epipeTimer = setTimeout(() => {
          if (!settled) stop('PROBE_STDIN_FAILED');
        }, EPIPE_CLOSE_GRACE_MS);
        epipeTimer.unref?.();
      }
    }
  });
}

function iso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function unavailableGpu(errorCode: string | null, availability: AcceleratorAvailability = 'unavailable'): NonNullable<HostObservation['gpu']> {
  return { observedAt: null, state: 'unavailable', acceleratorAvailability: availability, errorCode, metrics: [] };
}

function linuxGpuObservation(value: unknown, receivedAt: string): NonNullable<HostObservation['gpu']> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.status === 'skipped') return undefined;
  if (row.status === 'none' || row.acceleratorAvailability === 'none') {
    return unavailableGpu(null, 'none');
  }
  if (row.status !== 'ok' || typeof row.csv !== 'string') {
    return unavailableGpu(typeof row.errorCode === 'string' ? row.errorCode : 'GPU_DATA_UNAVAILABLE', 'unavailable');
  }
  return projectGpuCsv(row.csv, receivedAt, row.devices);
}

function parseHostSystemHealth(value: unknown, fallbackObservedAt: string): HostSystemHealth | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const numOrNull = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const disks = Array.isArray(row.disks)
    ? row.disks
        .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof (d as any).path === 'string')
        .slice(0, 16)
        .map((d) => ({
          path: String(d.path),
          usedBytes: typeof d.usedBytes === 'string' && /^\d+$/.test(d.usedBytes) ? d.usedBytes : '0',
          availableBytes: typeof d.availableBytes === 'string' && /^\d+$/.test(d.availableBytes)
            ? d.availableBytes
            : (typeof d.freeBytes === 'string' && /^\d+$/.test(d.freeBytes) ? d.freeBytes : '0'),
          totalBytes: typeof d.totalBytes === 'string' && /^\d+$/.test(d.totalBytes) ? d.totalBytes : '0',
        }))
    : [];
  const observedAt = iso(row.observedAt) ?? fallbackObservedAt;
  const memUsed = typeof row.memoryUsedBytes === 'string' && /^\d+$/.test(row.memoryUsedBytes)
    ? row.memoryUsedBytes
    : (typeof row.ramUsedBytes === 'string' && /^\d+$/.test(row.ramUsedBytes) ? row.ramUsedBytes : null);
  const memTotal = typeof row.memoryTotalBytes === 'string' && /^\d+$/.test(row.memoryTotalBytes)
    ? row.memoryTotalBytes
    : (typeof row.ramTotalBytes === 'string' && /^\d+$/.test(row.ramTotalBytes) ? row.ramTotalBytes : null);
  return {
    observedAt,
    freshness: observedAt ? 'fresh' : 'unobserved',
    cpuUtilizationPct: numOrNull(row.cpuUtilizationPct) ?? numOrNull(row.cpuPercent),
    memoryUsedBytes: memUsed,
    memoryTotalBytes: memTotal,
    disks,
  };
}

export function resolveWindowsNvidiaSmiPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const systemRoot = env.SystemRoot ?? 'C:\\Windows';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  return [
    path.win32.join(systemRoot, 'System32', 'nvidia-smi.exe'),
    path.win32.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    'nvidia-smi.exe',
  ];
}

async function windowsGpuObservation(
  signal: AbortSignal,
  spawnChild: SpawnLike,
  onDevices?: (devices: { uuid: string; index: number }[]) => void,
): Promise<NonNullable<HostObservation['gpu']>> {
  const candidates = resolveWindowsNvidiaSmiPaths();
  const isRealSpawn = spawnChild === (nodeSpawn as unknown);
  const existing = isRealSpawn ? candidates.filter((c) => c === 'nvidia-smi.exe' || existsSync(c)) : [candidates[0]!];
  const ordered = existing.length > 0 ? existing : candidates;
  const args = ['--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];

  let sawUnavailable = false;
  for (const executable of ordered) {
    try {
      const result = await runBoundedChild(executable, args, Buffer.alloc(0), signal, spawnChild, {
        timeoutMs: 2_000, stdoutLimitBytes: 16 * 1024, stderrLimitBytes: 4 * 1024,
      });
      if (result.exitCode !== 0) return unavailableGpu('NVIDIA_SMI_FAILED', 'unavailable');
      const csv = result.stdout.toString('utf8');
      onDevices?.(gpuDeviceMap(csv));
      return projectGpuCsv(csv, new Date().toISOString());
    } catch (error) {
      if (error instanceof Error && error.message === 'PROBE_TIMEOUT') {
        return unavailableGpu('NVIDIA_SMI_TIMEOUT', 'unavailable');
      }
      if (error instanceof Error && error.message === 'PROBE_CANCELLED') {
        return unavailableGpu('PROBE_CANCELLED', 'unavailable');
      }
      sawUnavailable = true;
    }
  }
  return sawUnavailable ? unavailableGpu(null, 'none') : unavailableGpu('NVIDIA_SMI_UNAVAILABLE', 'unavailable');
}

function validErrorScope(value: unknown): FailureScope | null {
  return value === 'host' || value === 'task' || value === 'request' || value === 'source' ? value : null;
}

function validProbePhase(value: unknown): FailurePhase | null {
  return value === 'wsl_list' || value === 'connect' || value === 'python_start' || value === 'probe' ||
    value === 'process_scan' || value === 'frame' || value === 'validate' || value === 'source_read' ||
    value === 'dispatch' || value === 'archive_scan' ? value : null;
}

function pathWithin(root: string, candidate: string): boolean {
  const isWin = /^[A-Za-z]:[\\/]/.test(root) || /^[A-Za-z]:[\\/]/.test(candidate);
  const ops = isWin ? path.win32 : path.posix;
  const relative = ops.relative(ops.resolve(root), ops.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !ops.isAbsolute(relative));
}

function pathScopes(host: HostRegistration, task: TaskRegistration): { hostAllowedRoots: string[]; taskAllowedDirectories: string[] } {
  return {
    hostAllowedRoots: [...host.allowedRoots],
    taskAllowedDirectories: task.allowedDirectories.filter((directory) => host.allowedRoots.some((root) => pathWithin(root, directory))),
  };
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

function encodeOneShotScript(source: string, request: Record<string, unknown>): Buffer {
  if (!source.includes('__MONITOR_REQUEST_B64__')) throw coded('PROBE_TEMPLATE_INVALID');
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  return Buffer.from(source.replace('__MONITOR_REQUEST_B64__', encoded), 'utf8');
}

async function checkWslDistributionRunning(
  distribution: string,
  requestId: string | null,
  signal: AbortSignal,
  spawnChild: SpawnLike,
): Promise<void> {
  let list: BoundedChildResult;
  try {
    list = await runBoundedChild('wsl.exe', stoppedWslListArgs(), Buffer.alloc(0), signal, spawnChild, {
      timeoutMs: 2_000, stdoutLimitBytes: 4096, stderrLimitBytes: 4096,
    });
  } catch (error) {
    const failure = failureFields(error, 'wsl_list');
    throw coded(failure.code, 'host', 'wsl_list', requestId, null);
  }
  if (list.exitCode !== 0) throw coded('WSL_LIST_FAILED', 'host', 'wsl_list', requestId, null);
  const running = parseWslListOutput(list.stdout);
  if (!running.includes(distribution)) throw coded('WSL_NOT_RUNNING', 'host', 'wsl_list', requestId, null);
}

/**
 * A single persistent bidirectional JSON-RPC session for one host (SSH, WSL, or local).
 * Reuses one long-lived process across all probe / read_log / archive_scan requests.
 */
class PersistentHostSession {
  private child: any = null;
  private readonly decoder = new FrameStreamDecoder();
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private alive = false;
  private closed = false;
  private lastExitError: Error | null = null;
  private readonly detached: boolean;
  private readonly pending = new Map<string, {
    sourceId: string | null;
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    abortListener: () => void;
    signal: AbortSignal;
  }>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly target: HostTarget,
    private readonly probeSource: string,
    private readonly spawnChild: SpawnLike,
    private readonly onDead: () => void,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.detached = spawnChild === (nodeSpawn as unknown) && platform !== 'win32';
  }

  isAlive(): boolean {
    return this.alive && !this.closed;
  }

  async start(signal: AbortSignal, requestId: string): Promise<void> {
    if (this.alive) return;
    if (signal.aborted) throw coded('PROBE_CANCELLED', 'request', 'connect', requestId, null);

    if (this.target.kind === 'wsl') {
      await checkWslDistributionRunning(this.target.distribution, requestId, signal, this.spawnChild);
    }

    const spec = commandSpecFor(this.target, { serve: true, platform: this.platform });
    const attempts = [{ command: spec.command, args: spec.args }, ...(spec.fallbackCommands ?? [])];
    const spawnOpts = this.detached
      ? { shell: false as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true as const, detached: true }
      : { shell: false as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true as const };

    let spawned: any = null;
    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        spawned = this.spawnChild(attempt.command, attempt.args, spawnOpts);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!spawned) {
      throw coded(
        this.target.kind === 'local' ? 'REMOTE_PYTHON_UNAVAILABLE' : 'TRANSPORT_UNAVAILABLE',
        'host',
        this.target.kind === 'local' ? 'python_start' : 'connect',
        requestId,
        null,
        lastError instanceof Error ? lastError.message : undefined,
      );
    }

    this.child = spawned;
    this.alive = true;
    this.lastExitError = null;
    this.stderrChunks = [];
    this.stderrBytes = 0;
    this.decoder.reset();

    spawned.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      if (!this.alive) return;
      try {
        const frames = this.decoder.push(chunk);
        for (const frame of frames) {
          this.handleFrame(frame);
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : 'PROTOCOL_INVALID';
        this.failSession(coded(code, 'request', 'frame'));
      }
    });

    spawned.stderr.on('data', (chunk: Buffer | Uint8Array) => {
      const data = Buffer.from(chunk);
      if (this.stderrBytes < STDERR_DIAGNOSTIC_LIMIT_BYTES) {
        const take = Math.min(data.length, STDERR_DIAGNOSTIC_LIMIT_BYTES - this.stderrBytes);
        this.stderrChunks.push(data.subarray(0, take));
        this.stderrBytes += take;
      }
    });

    spawned.once('error', () => {
      this.failSession(coded(
        this.target.kind === 'local' ? 'REMOTE_PYTHON_UNAVAILABLE' : 'TRANSPORT_UNAVAILABLE',
        'host',
        this.target.kind === 'local' ? 'python_start' : 'connect',
      ));
    });

    // Do not immediately overwrite close/stderr classification on EPIPE; let close arrive.
    spawned.stdin.on('error', () => {
      // Wait for close/error event to supply exit code + stderr classification.
    });

    spawned.once('close', (code: number | null) => {
      const stderrBuf = Buffer.concat(this.stderrChunks);
      if (this.closed) {
        this.cleanupAfterExit(coded('SESSION_CLOSED', 'host', 'connect'));
        return;
      }
      const classified = classifyTransportFailure(this.target.kind, code, stderrBuf);
      this.cleanupAfterExit(coded(classified.code, classified.errorScope, classified.phase, null, null, classified.diagnostic));
    });

    // Send probe source header once for the lifetime of this persistent session.
    const sourceBytes = Buffer.from(this.probeSource, 'utf8');
    const bootstrapHeader = Buffer.from(`${sourceBytes.length}\n`, 'ascii');
    try {
      spawned.stdin.write(Buffer.concat([bootstrapHeader, sourceBytes]));
    } catch {
      // If stdin is already closed, the upcoming close event will reject the first RPC with classified stderr.
    }
  }

  private handleFrame(frame: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.toString('utf8'));
    } catch {
      this.failSession(coded('PROTOCOL_JSON_INVALID', 'request', 'frame'));
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.failSession(coded('PROTOCOL_SCHEMA_INVALID', 'request', 'frame'));
      return;
    }
    const row = parsed as Record<string, unknown>;
    const reqId = typeof row.requestId === 'string' ? row.requestId : null;
    if (reqId && this.pending.has(reqId)) {
      const entry = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      clearTimeout(entry.timer);
      entry.signal.removeEventListener('abort', entry.abortListener);
      try {
        const envelope = validateProbeEnvelope(parsed, { requestId: reqId, sourceId: entry.sourceId });
        entry.resolve(envelope.payload);
      } catch (err) {
        entry.reject(err instanceof Error ? err : coded('PROTOCOL_INVALID', 'request', 'frame', reqId, entry.sourceId));
      }
      return;
    }
    // Single-pending mismatch: surface exact PROTOCOL_REQUEST_MISMATCH / PROTOCOL_SCHEMA_INVALID
    if (this.pending.size === 1) {
      const [[expectedId, entry]] = this.pending.entries();
      this.pending.delete(expectedId);
      clearTimeout(entry.timer);
      entry.signal.removeEventListener('abort', entry.abortListener);
      try {
        const envelope = validateProbeEnvelope(parsed, { requestId: expectedId, sourceId: entry.sourceId });
        entry.resolve(envelope.payload);
      } catch (err) {
        entry.reject(err instanceof Error ? err : coded('PROTOCOL_INVALID', 'request', 'frame', expectedId, entry.sourceId));
      }
      return;
    }
    this.failSession(coded('PROTOCOL_REQUEST_MISMATCH', 'request', 'frame'));
  }

  private cleanupAfterExit(error: Error): void {
    const wasAlive = this.alive;
    this.alive = false;
    this.child = null;
    this.lastExitError = error;
    for (const [reqId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.signal.removeEventListener('abort', entry.abortListener);
      entry.reject(coded(
        error.message,
        (error as any).errorScope ?? 'request',
        (error as any).phase ?? 'connect',
        reqId,
        entry.sourceId,
      ));
    }
    this.pending.clear();
    if (wasAlive) this.onDead();
  }

  private failSession(error: Error): void {
    const child = this.child;
    this.cleanupAfterExit(error);
    terminateProcessTree(child, { detached: this.detached, platform: this.platform });
  }

  request(payload: Record<string, unknown>, signal: AbortSignal, timeoutMs = 8_000): Promise<unknown> {
    const run = this.tail.catch(() => undefined).then(() => this.sendOnce(payload, signal, timeoutMs));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendOnce(request: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const requestId = String(request.requestId ?? randomUUID());
    const sourceId = (request.sourceId as string | null) ?? null;
    if (signal.aborted) throw coded('PROBE_CANCELLED', 'request', 'probe', requestId, sourceId);
    if (!this.alive) {
      await this.start(signal, requestId);
    }
    if (!this.alive || !this.child) {
      if (this.lastExitError) {
        throw coded(
          this.lastExitError.message,
          (this.lastExitError as any).errorScope ?? 'host',
          (this.lastExitError as any).phase ?? 'connect',
          requestId,
          sourceId,
          (this.lastExitError as any).diagnostic,
        );
      }
      throw coded('TRANSPORT_UNAVAILABLE', 'host', 'connect', requestId, sourceId);
    }

    const frame = encodeFrame(Buffer.from(JSON.stringify(request), 'utf8'));
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(coded('PROBE_CANCELLED', 'request', 'probe', requestId, sourceId));
        this.failSession(coded('PROBE_CANCELLED', 'request', 'probe', requestId, sourceId));
      };
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        signal.removeEventListener('abort', abortListener);
        reject(coded('PROBE_TIMEOUT', 'host', 'probe', requestId, sourceId));
        this.failSession(coded('PROBE_TIMEOUT', 'host', 'probe', requestId, sourceId));
      }, timeoutMs);
      timer.unref?.();
      signal.addEventListener('abort', abortListener, { once: true });
      this.pending.set(requestId, { sourceId, resolve, reject, timer, abortListener, signal });

      try {
        this.child.stdin.write(frame);
      } catch {
        // Wait briefly for close event to classify error; fallback if child never exits.
        const fallback = setTimeout(() => {
          if (this.pending.has(requestId)) {
            this.failSession(coded('PROBE_STDIN_FAILED', 'request', 'connect', requestId, sourceId));
          }
        }, EPIPE_CLOSE_GRACE_MS);
        fallback.unref?.();
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child && this.alive) {
      try {
        const shutdownFrame = encodeFrame(Buffer.from(JSON.stringify({
          version: PROTOCOL_VERSION,
          requestId: `shutdown-${randomUUID()}`,
          sourceId: null,
          op: 'shutdown',
        }), 'utf8'));
        child.stdin.write(shutdownFrame);
        child.stdin.end();
      } catch { /* ignore */ }
    }
    this.cleanupAfterExit(coded('SESSION_CLOSED', 'host', 'connect'));
    terminateProcessTree(child, { detached: this.detached, platform: this.platform });
  }
}

/**
 * Manages one long-lived multiplexed probe session per registered host target.
 */
export class HostSessionPool {
  private readonly sessions = new Map<string, { targetKey: string; session: PersistentHostSession }>();

  private sessionKey(hostId: string, target: HostTarget): string {
    return `${hostId}\0${JSON.stringify(target)}`;
  }

  async call(
    hostId: string,
    target: HostTarget,
    probeSource: string,
    request: Record<string, unknown>,
    signal: AbortSignal,
    spawnChild: SpawnLike,
    options: { timeoutMs?: number; platform?: NodeJS.Platform } = {},
  ): Promise<unknown> {
    const targetKey = this.sessionKey(hostId, target);
    const existing = this.sessions.get(hostId);
    if (existing && existing.targetKey !== targetKey) {
      this.sessions.delete(hostId);
      await existing.session.close();
    }
    let entry = this.sessions.get(hostId);
    if (!entry || !entry.session.isAlive()) {
      const session = new PersistentHostSession(
        target,
        probeSource,
        spawnChild,
        () => {
          if (this.sessions.get(hostId)?.session === session) {
            this.sessions.delete(hostId);
          }
        },
        options.platform,
      );
      entry = { targetKey, session };
      this.sessions.set(hostId, entry);
    }
    return entry.session.request(request, signal, options.timeoutMs ?? 8_000);
  }

  hasActiveSession(hostId: string): boolean {
    return Boolean(this.sessions.get(hostId)?.session.isAlive());
  }

  activeCount(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.session.isAlive()) count += 1;
    }
    return count;
  }

  async invalidate(hostId: string): Promise<void> {
    const entry = this.sessions.get(hostId);
    if (!entry) return;
    this.sessions.delete(hostId);
    await entry.session.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((entry) => entry.session.close()));
  }
}

/** One-shot invocation used strictly for launcher.py and server_agent.py control operations. */
async function invokeOneShotScript(
  context: TransportHostContext,
  script: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  spawnChild: SpawnLike,
  limits: ChildLimits = {},
): Promise<unknown> {
  const target = context.host.target;
  if (target.kind === 'wsl') {
    await checkWslDistributionRunning(target.distribution, String(request.requestId ?? '') || null, signal, spawnChild);
  }
  const spec = commandSpecFor(target, { serve: false });
  const input = encodeOneShotScript(script, request);
  const child = await runBoundedChild(spec.command, spec.args, input, signal, spawnChild, limits);
  if (child.exitCode !== 0 && child.stdout.length === 0) {
    const classified = classifyTransportFailure(target.kind, child.exitCode, child.stderr);
    throw coded(classified.code, classified.errorScope, classified.phase, String(request.requestId), (request.sourceId as string | null) ?? null, classified.diagnostic);
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
      ...(typeof result?.resolvedPath === 'string' ? { resolvedPath: result.resolvedPath } : {}),
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
      if (!expected || expected.fileIdentity === null || expected.eofBytes === null) return false;
      if (JSON.stringify(actual.fileIdentity) !== JSON.stringify(expected.fileIdentity)) return false;
      if (typeof actual.eofBytes !== 'string' || !/^\d+$/.test(actual.eofBytes)) return false;
      // Active log files grow monotonically during training; allow actual.eofBytes >= expected.eofBytes.
      return BigInt(actual.eofBytes) >= BigInt(expected.eofBytes);
    });
    const launcherEntry = typeof row.launcherEntry === 'string' && typeof row.cwd === 'string' && isRegisteredLauncherPath(task, { cwd: row.cwd, launcherEntry: row.launcherEntry }) ? row.launcherEntry : null;
    const treeMember = row.treeMember === true;
    const entryVerified = row.roleEvidence === 'exact_script_entry' || row.roleEvidence === 'exact_entry_and_direct_writer_fd' || launcherEntry !== null || treeMember;
    const confirmedWriter = (row.roleEvidence === 'exact_entry_and_direct_writer_fd' || launcherEntry !== null) && writerIds.length > 0;
    const writerSourceEvidence: NonNullable<TaskObservation['processes'][number]['writerSourceEvidence']> = {};
    for (const id of writerIds) writerSourceEvidence[id] = evidence[id] as { fileIdentity: SourceObservation['fileIdentity']; eofBytes: string };
    processes.push({
      key,
      role: row.role === 'worker' ? 'worker' : 'unknown',
      ...(typeof row.ppid === 'number' && Number.isSafeInteger(row.ppid) ? { ppid: row.ppid } : {}),
      ...(typeof row.pgid === 'number' && Number.isSafeInteger(row.pgid) ? { pgid: row.pgid } : {}),
      ...(typeof row.nsPid === 'number' && Number.isSafeInteger(row.nsPid) ? { nsPid: row.nsPid } : {}),
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      scriptEntry: typeof row.scriptEntry === 'string' ? row.scriptEntry : null,
      launcherEntry,
      ...(typeof row.exe === 'string' ? { exe: row.exe } : {}),
      ...(typeof row.command === 'string' ? { command: row.command } : {}),
      observedAt,
      roleEvidence: confirmedWriter ? 'exact_entry_and_direct_writer_fd' : entryVerified ? 'exact_script_entry' : 'none',
      directWriterSourceIds: confirmedWriter ? writerIds : [],
      writerSourceEvidence,
      writerEvidenceComplete: row.writerEvidenceComplete === true && complete && writerIds.length === reportedWriterIds.length,
      evidenceComplete: row.evidenceComplete === true && entryVerified && complete,
      ...(row.fdScanTruncated === true ? { fdScanTruncated: true } : {}),
      ...(treeMember ? { treeMember: true } : {}),
      ...(typeof row.rssBytes === 'number' && Number.isFinite(row.rssBytes) && row.rssBytes >= 0 ? { rssBytes: row.rssBytes } : {}),
      ...(typeof row.cpuPercent === 'number' && Number.isFinite(row.cpuPercent) && row.cpuPercent >= 0 ? { cpuPercent: row.cpuPercent } : {}),
      interpreterFlags: Array.isArray(row.interpreterFlags) ? row.interpreterFlags.filter((flag): flag is string => typeof flag === 'string').slice(0, 16) : [],
    });
  }
  const rawCp = data.checkpointScan && typeof data.checkpointScan === 'object' ? data.checkpointScan as Record<string, unknown> : null;
  let checkpointScan: TaskObservation['checkpointScan'] = null;
  if (rawCp) {
    const rawLatest = rawCp.latest && typeof rawCp.latest === 'object' ? rawCp.latest as Record<string, unknown> : null;
    const latestId = rawLatest?.fileIdentity && typeof rawLatest.fileIdentity === 'object'
      ? rawLatest.fileIdentity as Record<string, unknown>
      : null;
    checkpointScan = {
      scanComplete: rawCp.scanComplete === true,
      errorCode: typeof rawCp.errorCode === 'string' ? rawCp.errorCode : null,
      latest: rawLatest && typeof rawLatest.path === 'string' && typeof rawLatest.sizeBytes === 'string' && typeof rawLatest.mtime === 'string'
        ? {
            path: rawLatest.path,
            name: typeof rawLatest.name === 'string' ? rawLatest.name : path.posix.basename(rawLatest.path),
            isDirectory: rawLatest.isDirectory === true,
            fileCount: typeof rawLatest.fileCount === 'number' && Number.isSafeInteger(rawLatest.fileCount) ? rawLatest.fileCount : null,
            sizeBytes: /^\d+$/.test(rawLatest.sizeBytes) ? rawLatest.sizeBytes : '0',
            mtime: iso(rawLatest.mtime) ?? observedAt,
            fileIdentity: latestId && typeof latestId.dev === 'string' && typeof latestId.inode === 'string'
              ? { dev: latestId.dev, inode: latestId.inode }
              : null,
            fileStepIndex: typeof rawLatest.fileStepIndex === 'number' && Number.isSafeInteger(rawLatest.fileStepIndex) ? rawLatest.fileStepIndex : null,
            stepSource: rawLatest.stepSource === 'filename' || rawLatest.stepSource === 'metadata' ? rawLatest.stepSource : null,
            ...(rawLatest.metadata && typeof rawLatest.metadata === 'object' && !Array.isArray(rawLatest.metadata)
              ? { metadata: rawLatest.metadata as Record<string, string | number | boolean | null> }
              : {}),
          }
        : null,
    };
  }
  const hostError = data.errorScope === 'host' && typeof data.errorCode === 'string' ? data.errorCode : null;
  const requestError = data.errorScope === 'request' && typeof data.errorCode === 'string' ? data.errorCode : null;
  const taskError = data.errorScope === 'task' && typeof data.errorCode === 'string' ? data.errorCode : null;
  const observationError = hostError ?? requestError;
  const validPhases: FailurePhase[] = ['wsl_list', 'connect', 'python_start', 'probe', 'process_scan', 'frame', 'validate', 'source_read', 'dispatch', 'archive_scan'];
  const phase = validPhases.includes(data.phase as FailurePhase) ? data.phase as FailurePhase : null;
  return {
    taskId: task.taskId,
    hostId: task.hostId,
    observedAt: observationError ? null : observedAt,
    freshness: observationError ? 'unobserved' : 'fresh',
    scanComplete: complete && !observationError,
    processScanError: typeof data.errorCode === 'string' ? data.errorCode : null,
    phase,
    processes: observationError ? [] : processes,
    sources,
    errorCode: hostError ?? requestError ?? taskError,
    errorScope: hostError ? 'host' : requestError ? 'request' : taskError ? 'task' : null,
    ...(checkpointScan ? { checkpointScan } : {}),
    ...(data.fdScanTruncated === true ? { fdScanTruncated: true } : {}),
  };
}

export interface CreateTransportOptions {
  probeSource: string;
  launcherSource?: string;
  serverAgentSource?: string;
  spawn?: SpawnLike;
  registryProvider?: () => Promise<Registry>;
  rotationCatalog?: RotationCatalogLoad;
  sessionPool?: HostSessionPool;
  platform?: NodeJS.Platform;
}

export function createTransport(context: TransportHostContext, options: CreateTransportOptions): Transport {
  const spawnChild = options.spawn ?? (nodeSpawn as SpawnLike);
  const registryProvider = options.registryProvider ?? (async () => context.registry);
  const ownsPool = !options.sessionPool;
  const sessionPool = options.sessionPool ?? new HostSessionPool();
  const platform = options.platform ?? process.platform;
  const now = () => new Date().toISOString();
  let devices: { uuid: string; index: number }[] = [];
  let gpuHostBootId: string | null = null;
  let lastAcceleratorAvailability: AcceleratorAvailability | undefined;
  let cachedWorkerBundle: { template: string; sha256: string } | null = null;

  const getWorkerBundle = () => {
    if (cachedWorkerBundle) return cachedWorkerBundle;
    if (!options.launcherSource || !options.serverAgentSource) return null;
    const launcher = options.launcherSource.replace('__READONLY_PROBE_SOURCE_B64__', Buffer.from(options.probeSource).toString('base64'));
    const template = options.serverAgentSource.replace('__LAUNCHER_SOURCE_B64__', Buffer.from(launcher).toString('base64'));
    const sha256 = createHash('sha256').update(Buffer.from(template, 'utf8')).digest('hex');
    cachedWorkerBundle = { template, sha256 };
    return cachedWorkerBundle;
  };

  const currentContext = async () => {
    const registry = await registryProvider();
    const host = registry.hosts.find((item) => item.hostId === context.hostId);
    if (!host || JSON.stringify(host.target) !== JSON.stringify(context.host.target) || host.enabled !== context.host.enabled) {
      throw coded('REGISTRY_CHANGED');
    }
    return { registry, host };
  };

  const callProbeSession = (host: HostRegistration, request: Record<string, unknown>, signal: AbortSignal, timeoutMs = 8_000) =>
    sessionPool.call(host.hostId, host.target, options.probeSource, request, signal, spawnChild, { timeoutMs, platform });

  const parseServerWaitPayload = (data: Record<string, unknown>, armId: string, configHash: string): ServerWaitResult => {
    const requiredKeys = ['state', 'armId', 'configHash', 'idleElapsedSeconds', 'requiredIdleSeconds', 'lastCheckedAt', 'startedAt', 'pid', 'errorCode', 'message', 'sessionName', 'selectedDeviceId'];
    const optionalKeys = ['errorParams', 'selectedDeviceIds', 'retryCount', 'maxRetries', 'exitCode', 'backend'];
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    if (
      !data ||
      requiredKeys.some(key => !(key in data)) ||
      Object.keys(data).some(key => !allowedKeys.has(key)) ||
      !['missing', 'waiting', 'countdown', 'blocked', 'starting', 'started', 'failed', 'cancelled'].includes(String(data.state)) ||
      data.armId !== armId ||
      data.configHash !== configHash ||
      !Number.isSafeInteger(data.idleElapsedSeconds) || Number(data.idleElapsedSeconds) < 0 || Number(data.idleElapsedSeconds) > 86400 ||
      !Number.isSafeInteger(data.requiredIdleSeconds) || Number(data.requiredIdleSeconds) < 1 || Number(data.requiredIdleSeconds) > 86400 ||
      ![data.lastCheckedAt, data.startedAt].every(time => time === null || (typeof time === 'string' && iso(time) !== null)) ||
      !(data.pid === null || (Number.isSafeInteger(data.pid) && Number(data.pid) > 0)) ||
      !(data.errorCode === null || (typeof data.errorCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(data.errorCode))) ||
      !(data.message === null || (typeof data.message === 'string' && data.message.length <= 512 && !/[\u0000-\u001f\u007f]/.test(data.message))) ||
      !(data.sessionName === null || (typeof data.sessionName === 'string' && /^tm-wait-[a-f0-9]{40}$/.test(data.sessionName))) ||
      !(data.selectedDeviceId === null || (typeof data.selectedDeviceId === 'string' && /^GPU (0|[1-9]\d{0,3})$/.test(data.selectedDeviceId))) ||
      (data.selectedDeviceIds !== undefined && (!Array.isArray(data.selectedDeviceIds) || data.selectedDeviceIds.some(d => typeof d !== 'string' || !/^GPU (0|[1-9]\d{0,3})$/.test(d)))) ||
      (data.backend !== undefined && !['tmux', 'systemd_run', 'setsid'].includes(String(data.backend))) ||
      (data.state === 'started' && (data.pid === null || data.startedAt === null))
    ) {
      throw coded('SERVER_WAIT_PROTOCOL_INVALID');
    }
    return data as unknown as ServerWaitResult;
  };

  const serverWait = async (
    op: 'ensure_server_wait' | 'get_server_wait' | 'cancel_server_wait',
    task: TaskRegistration,
    configHash: string,
    signal: AbortSignal,
  ): Promise<ServerWaitResult> => {
    if (context.host.target.kind !== 'ssh') throw coded('SERVER_WAIT_SSH_ONLY');
    const { registry, host } = await currentContext();
    const registered = registry.tasks.find(item => item.taskId === task.taskId);
    if (!registered?.autoStart || registered.hostId !== host.hostId || fingerprint(task, host) !== fingerprint(registered, host) || !/^[a-f0-9]{64}$/.test(configHash)) {
      throw coded('REGISTRY_CHANGED');
    }
    const config = registered.autoStart;
    if (config.execution !== 'server_tmux') throw coded('SERVER_WAIT_CONFIRMATION_REQUIRED');
    if (op === 'ensure_server_wait' && (!host.enabled || !registered.enabled || !config.enabled)) throw coded('REGISTRY_CHANGED');
    const scopes = pathScopes(host, registered);
    if (!scopes.taskAllowedDirectories.length || !options.launcherSource || !options.serverAgentSource) throw coded('SERVER_WAIT_UNAVAILABLE');

    const baseRequest = (requestId: string): Record<string, unknown> => {
      const req: Record<string, unknown> = {
        version: PROTOCOL_VERSION,
        requestId,
        sourceId: null,
        op,
        taskId: task.taskId,
        armId: config.armId,
        configHash,
        ...scopes,
        ...(host.stateDir ? { stateDir: host.stateDir } : {}),
      };
      if (op === 'ensure_server_wait') {
        Object.assign(req, {
          idleSeconds: config.idleSeconds,
          retryOnExit: config.retryOnExit ?? false,
          ...(typeof config.maxRetries === 'number' ? { maxRetries: config.maxRetries } : {}),
          ...(typeof config.retryBackoffSeconds === 'number' ? { retryBackoffSeconds: config.retryBackoffSeconds } : {}),
          ...(typeof config.requiredGpuCount === 'number' ? { requiredGpuCount: config.requiredGpuCount } : {}),
          launchRequest: {
            version: PROTOCOL_VERSION,
            requestId,
            sourceId: null,
            op: 'launch_task',
            taskId: task.taskId,
            armId: config.armId,
            configHash,
            ...scopes,
            ...(host.stateDir ? { stateDir: host.stateDir } : {}),
            entryPaths: registered.entryPaths,
            sources: registered.sources,
            launch: config.launch,
            gpuDevices: [],
            ...(config.gpuDeviceIds?.length ? { gpuDeviceIds: config.gpuDeviceIds } : {}),
            ...(config.gpuExcludeIds?.length ? { gpuExcludeIds: config.gpuExcludeIds } : {}),
            ...(typeof config.requiredGpuCount === 'number' ? { requiredGpuCount: config.requiredGpuCount } : {}),
            cudaVisibleDevicesMode: config.cudaVisibleDevicesMode ?? 'index',
            useSupervisor: true,
            useLocalLocks: true,
            maxUtilizationPercent: config.maxUtilizationPercent,
            maxMemoryMiB: config.maxMemoryMiB,
            ...(config.minFreeMemoryMiB ? { minFreeMemoryMiB: config.minFreeMemoryMiB } : {}),
            ...(config.minFreeDiskMiB ? { minFreeDiskMiB: config.minFreeDiskMiB } : {}),
            ...(config.gpuSharing ? { gpuSharing: config.gpuSharing } : {}),
          },
        });
      }
      return req;
    };

    // Never re-upload the 465 KB nested worker bundle for read-only or cancel operations!
    if (op === 'get_server_wait' || op === 'cancel_server_wait') {
      const request = baseRequest(randomUUID());
      const data = await invokeOneShotScript({ ...context, host, registry }, options.serverAgentSource, request, signal, spawnChild, { timeoutMs: 20_000 }) as Record<string, unknown>;
      return parseServerWaitPayload(data, config.armId, configHash);
    }

    // For ensure_server_wait, first try lightweight mode carrying only workerSha256.
    // Only if the remote lacks a matching sha256 worker script do we upload the full bundle once.
    const bundle = getWorkerBundle();
    if (!bundle) throw coded('SERVER_WAIT_UNAVAILABLE');
    const probeReq = { ...baseRequest(randomUUID()), workerSha256: bundle.sha256 };
    const first = await invokeOneShotScript({ ...context, host, registry }, options.serverAgentSource, probeReq, signal, spawnChild, { timeoutMs: 20_000 }) as Record<string, unknown>;
    const firstResult = parseServerWaitPayload(first, config.armId, configHash);
    if (firstResult.state === 'failed' && firstResult.errorCode === 'WORKER_SOURCE_REQUIRED') {
      const fullScript = bundle.template.replace('__SERVER_AGENT_SOURCE_B64__', Buffer.from(bundle.template).toString('base64'));
      const deployReq = baseRequest(randomUUID());
      const deployed = await invokeOneShotScript({ ...context, host, registry }, fullScript, deployReq, signal, spawnChild, { timeoutMs: 20_000 }) as Record<string, unknown>;
      return parseServerWaitPayload(deployed, config.armId, configHash);
    }
    return firstResult;
  };

  const projectHostData = async (
    host: HostRegistration,
    data: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HostObservation> => {
    const scope = ['host', 'request', 'task', 'source'].includes(String(data.errorScope)) ? data.errorScope as FailureScope : null;
    if (typeof data.errorCode === 'string') {
      return {
        hostId: host.hostId,
        freshness: 'unobserved',
        observedAt: null,
        phase: validProbePhase(data.phase) ?? 'probe',
        connection: 'unobserved',
        scanComplete: false,
        hostBootId: null,
        errorCode: data.errorCode,
        errorScope: scope ?? 'request',
      };
    }

    const useWindowsNvidia = host.target.kind === 'wsl' || (host.target.kind === 'local' && platform === 'win32');
    const gpu = useWindowsNvidia
      ? await windowsGpuObservation(signal, spawnChild, (value) => { devices = value; })
      : linuxGpuObservation(data.gpu, now());

    if (!useWindowsNvidia && gpu?.state === 'available' && data.gpu && typeof data.gpu === 'object' && (data.gpu as Record<string, unknown>).status === 'ok') {
      const csv = (data.gpu as Record<string, unknown>).csv;
      if (typeof csv === 'string') devices = gpuDeviceMap(csv);
    }
    if (gpu?.state === 'available') {
      gpuHostBootId = typeof data.hostBootId === 'string' ? data.hostBootId : null;
    }

    const acceleratorAvailability: AcceleratorAvailability | undefined =
      gpu?.acceleratorAvailability ??
      (data.acceleratorAvailability === 'available' || data.acceleratorAvailability === 'none' || data.acceleratorAvailability === 'unavailable'
        ? data.acceleratorAvailability
        : gpu?.state === 'available' ? 'available' : undefined);
    lastAcceleratorAvailability = acceleratorAvailability;

    const observedAt = now();
    const system = parseHostSystemHealth(data.system, observedAt);
    return {
      hostId: host.hostId,
      freshness: 'fresh',
      observedAt,
      phase: validProbePhase(data.phase) ?? 'probe',
      connection: 'connected',
      scanComplete: data.scanComplete === true,
      hostBootId: typeof data.hostBootId === 'string' ? data.hostBootId : null,
      errorCode: null,
      errorScope: null,
      ...(acceleratorAvailability ? { acceleratorAvailability } : {}),
      ...(gpu ? { gpu } : {}),
      ...(system ? { system } : {}),
    };
  };

  const attachTaskProcessGpu = (
    host: HostRegistration,
    registered: TaskRegistration,
    observation: TaskObservation,
    data: Record<string, unknown>,
  ): TaskObservation => {
    if (host.target.kind === 'wsl') {
      observation.processGpu = { observedAt: null, state: 'unavailable', errorCode: 'WSL_PROCESS_GPU_UNAVAILABLE', metrics: [], processKeys: [] };
      return observation;
    }
    if (lastAcceleratorAvailability === 'none' || (data.processGpu && typeof data.processGpu === 'object' && (data.processGpu as Record<string, unknown>).status === 'none')) {
      observation.processGpu = { observedAt: null, state: 'unavailable', errorCode: null, metrics: [], processKeys: [] };
      return observation;
    }
    const keys = observation.processes
      .filter((process) => process.key.hostBootId === gpuHostBootId && isRegisteredGpuProcess(registered, process))
      .map((process) => process.key);
    observation.processGpu = projectProcessGpu(data.processGpu, keys, devices, now());
    return observation;
  };

  const mapHostFailure = (error: unknown): HostObservation => {
    const failure = failureFields(error, 'probe');
    const scope = failure.errorScope === 'request' && failure.code === 'TRANSPORT_UNAVAILABLE' ? 'host' : failure.errorScope;
    const phase = failure.phase === 'validate'
      ? (failure.code === 'WSL_NOT_RUNNING' || failure.code === 'WSL_LIST_FAILED'
        ? 'wsl_list'
        : failure.code === 'REMOTE_PROBE_FAILED' || failure.code === 'REMOTE_PYTHON_UNAVAILABLE'
          ? 'python_start'
          : failure.code.startsWith('SSH_') || failure.code === 'HOST_UNREACHABLE'
            ? 'connect'
            : scope === 'host' ? 'connect' : 'probe')
      : failure.phase;
    return {
      hostId: context.hostId,
      freshness: 'unobserved',
      observedAt: null,
      phase,
      connection: 'unobserved',
      scanComplete: false,
      hostBootId: null,
      errorCode: failure.code,
      errorScope: scope,
    };
  };

  const mapTaskFailure = (task: TaskRegistration, error: unknown): TaskObservation => {
    const failure = failureFields(error, 'probe');
    return {
      taskId: task.taskId,
      hostId: task.hostId,
      observedAt: null,
      freshness: 'unobserved',
      scanComplete: false,
      processScanError: failure.code,
      phase: failure.phase,
      processes: [],
      sources: task.sources.map((source) => ({
        sourceId: source.sourceId,
        observedAt: null,
        fileIdentity: null,
        eofBytes: null,
        permission: 'unknown' as const,
        exists: null,
        statusValues: null,
        heldByRegisteredProcess: null,
        errorCode: null,
        evidenceComplete: false,
        errorScope: null,
        phase: null,
      })),
      errorCode: failure.code,
      errorScope: failure.errorScope,
    };
  };

  return {
    ensureServerWait: (task, hash, signal) => serverWait('ensure_server_wait', task, hash, signal),
    getServerWait: (task, hash, signal) => serverWait('get_server_wait', task, hash, signal),
    cancelServerWait: (task, hash, signal) => serverWait('cancel_server_wait', task, hash, signal),
    async close() {
      if (ownsPool) await sessionPool.closeAll();
      else await sessionPool.invalidate(context.hostId);
    },
    async createRegistrationReference(taskId) {
      const { registry, host } = await currentContext();
      const task = registry.tasks.find((item) => item.taskId === taskId);
      if (!task || task.hostId !== host.hostId || !task.enabled || !host.enabled) throw coded('REGISTRY_HOST_MISMATCH');
      return { taskId: task.taskId, registryRevision: registry.revision, fingerprint: fingerprint(task, host) };
    },
    async probeHost(signal) {
      devices = [];
      gpuHostBootId = null;
      lastAcceleratorAvailability = undefined;
      try {
        const { host } = await currentContext();
        if (!host.enabled) {
          return { hostId: host.hostId, freshness: 'unobserved', observedAt: null, phase: null, connection: 'unobserved', scanComplete: false, hostBootId: null, errorCode: 'HOST_DISABLED' };
        }
        const useWindowsNvidia = host.target.kind === 'wsl' || (host.target.kind === 'local' && platform === 'win32');
        const payload = await callProbeSession(host, {
          version: PROTOCOL_VERSION,
          requestId: randomUUID(),
          sourceId: null,
          op: 'probe_host',
          includeGpu: !useWindowsNvidia,
          includeGpuDetails: !useWindowsNvidia,
          includeSystem: true,
          diskPaths: host.allowedRoots,
        }, signal);
        const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        return await projectHostData(host, data, signal);
      } catch (error) {
        return mapHostFailure(error);
      }
    },
    async probeHostAndTasks(tasks, signal): Promise<BatchProbeObservation> {
      devices = [];
      gpuHostBootId = null;
      lastAcceleratorAvailability = undefined;
      const taskMap = new Map<string, TaskObservation>();
      try {
        const { registry, host } = await currentContext();
        if (!host.enabled) {
          return {
            host: { hostId: host.hostId, freshness: 'unobserved', observedAt: null, phase: null, connection: 'unobserved', scanComplete: false, hostBootId: null, errorCode: 'HOST_DISABLED' },
            tasks: taskMap,
          };
        }
        const eligibleTasks: { task: TaskRegistration; requestTask: Record<string, unknown> }[] = [];
        for (const task of tasks) {
          const registered = registry.tasks.find((item) => item.taskId === task.taskId);
          if (!registered?.enabled || task.hostId !== host.hostId || registered.hostId !== host.hostId || task.hostId !== context.hostId || fingerprint(task, host) !== fingerprint(registered, host)) {
            taskMap.set(task.taskId, mapTaskFailure(task, coded('REGISTRY_HOST_MISMATCH')));
            continue;
          }
          const scopes = pathScopes(host, registered);
          if (!scopes.taskAllowedDirectories.length) {
            taskMap.set(task.taskId, mapTaskFailure(task, coded('PATH_OUTSIDE_ALLOWED_ROOT')));
            continue;
          }
          eligibleTasks.push({
            task: registered,
            requestTask: {
              taskId: registered.taskId,
              ...scopes,
              allowedDirectories: scopes.taskAllowedDirectories,
              entryPaths: registered.entryPaths,
              sources: registered.sources,
              checkpointDirectories: registered.checkpointDirectories,
              ...(registered.allowCrossUidScan ? { allowCrossUidScan: true } : {}),
            },
          });
        }
        const useWindowsNvidia = host.target.kind === 'wsl' || (host.target.kind === 'local' && platform === 'win32');
        const payload = await callProbeSession(host, {
          version: PROTOCOL_VERSION,
          requestId: randomUUID(),
          sourceId: null,
          op: 'probe_host_and_tasks',
          includeGpu: !useWindowsNvidia,
          includeGpuDetails: !useWindowsNvidia,
          includeProcessGpu: !useWindowsNvidia,
          includeSystem: true,
          diskPaths: host.allowedRoots,
          proc: { root: '/proc' },
          tasks: eligibleTasks.map((item) => item.requestTask),
        }, signal);
        const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        const hostData = root.host && typeof root.host === 'object' ? root.host as Record<string, unknown> : root;
        const hostObs = await projectHostData(host, hostData, signal);
        const taskPayloads = root.tasks && typeof root.tasks === 'object' ? root.tasks as Record<string, unknown> : {};
        const receivedAt = now();
        for (const { task } of eligibleTasks) {
          const rawTask = taskPayloads[task.taskId];
          const taskData = rawTask && typeof rawTask === 'object' ? rawTask as Record<string, unknown> : {};
          const observation = projectTaskObservation(task, taskData, receivedAt);
          taskMap.set(task.taskId, attachTaskProcessGpu(host, task, observation, taskData));
        }
        return { host: hostObs, tasks: taskMap };
      } catch (error) {
        return { host: mapHostFailure(error), tasks: taskMap };
      }
    },
    async probeTask(task, signal) {
      try {
        const { registry, host } = await currentContext();
        const registered = registry.tasks.find((item) => item.taskId === task.taskId);
        if (!host.enabled || !registered?.enabled || task.hostId !== host.hostId || registered.hostId !== host.hostId || task.hostId !== context.hostId || fingerprint(task, host) !== fingerprint(registered, host)) {
          throw coded('REGISTRY_HOST_MISMATCH');
        }
        const scopes = pathScopes(host, registered);
        if (!scopes.taskAllowedDirectories.length) throw coded('PATH_OUTSIDE_ALLOWED_ROOT');
        const useWindowsNvidia = host.target.kind === 'wsl' || (host.target.kind === 'local' && platform === 'win32');
        const includeProcessGpu = !useWindowsNvidia && lastAcceleratorAvailability !== 'none';
        const payload = await callProbeSession(host, {
          version: PROTOCOL_VERSION,
          requestId: randomUUID(),
          sourceId: null,
          op: 'probe_task',
          proc: { root: '/proc' },
          includeProcessGpu,
          gpuDevices: includeProcessGpu ? devices : [],
          task: {
            taskId: registered.taskId,
            ...scopes,
            allowedDirectories: scopes.taskAllowedDirectories,
            entryPaths: registered.entryPaths,
            sources: registered.sources,
            checkpointDirectories: registered.checkpointDirectories,
            ...(registered.allowCrossUidScan ? { allowCrossUidScan: true } : {}),
          },
        }, signal);
        const observation = projectTaskObservation(registered, payload, now());
        const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        return attachTaskProcessGpu(host, registered, observation, data);
      } catch (error) {
        return mapTaskFailure(task, error);
      }
    },
    async checkTaskStopped(task, signal) {
      const { registry, host } = await currentContext();
      const registered = registry.tasks.find(item => item.taskId === task.taskId);
      if (!host.enabled || !registered?.enabled || registered.hostId !== host.hostId || fingerprint(task, host) !== fingerprint(registered, host)) throw coded('REGISTRY_CHANGED');
      const scopes = pathScopes(host, registered);
      if (!scopes.taskAllowedDirectories.length) throw coded('PATH_OUTSIDE_ALLOWED_ROOT');
      const data = await callProbeSession(host, {
        version: PROTOCOL_VERSION,
        requestId: randomUUID(),
        sourceId: null,
        op: 'probe_launch_readiness',
        proc: { root: '/proc' },
        task: { taskId: task.taskId, ...scopes, allowedDirectories: scopes.taskAllowedDirectories, entryPaths: registered.entryPaths, sources: [] },
      }, signal) as Record<string, unknown>;
      if (!data || typeof data.scanComplete !== 'boolean' || typeof data.running !== 'boolean' || !(data.errorCode === null || typeof data.errorCode === 'string')) throw coded('PROTOCOL_INVALID');
      return { scanComplete: data.scanComplete, running: data.running, errorCode: data.errorCode as string | null };
    },
    async discoverProcesses(signal): Promise<DiscoveredProcess[]> {
      const { host } = await currentContext();
      if (!host.enabled) return [];
      const payload = await callProbeSession(host, {
        version: PROTOCOL_VERSION,
        requestId: randomUUID(),
        sourceId: null,
        op: 'discover_processes',
        proc: { root: '/proc' },
      }, signal, 10_000) as Record<string, unknown>;
      if (!payload || !Array.isArray(payload.processes)) return [];
      const out: DiscoveredProcess[] = [];
      for (const item of payload.processes.slice(0, 64)) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        if (typeof row.pid !== 'number' || !Number.isSafeInteger(row.pid) || row.pid <= 0) continue;
        out.push({
          pid: row.pid,
          pgid: typeof row.pgid === 'number' && Number.isSafeInteger(row.pgid) ? row.pgid : row.pid,
          command: typeof row.command === 'string' ? row.command.slice(0, 1024) : '',
          cwd: typeof row.cwd === 'string' ? row.cwd : null,
          gpuIndices: Array.isArray(row.gpuIndices) ? row.gpuIndices.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n)) : [],
          gpuMemoryMiB: typeof row.gpuMemoryMiB === 'number' && Number.isFinite(row.gpuMemoryMiB) ? row.gpuMemoryMiB : null,
          openLogPaths: Array.isArray(row.openLogPaths) ? row.openLogPaths.filter((p): p is string => typeof p === 'string').slice(0, 16) : [],
          suggestedName: typeof row.suggestedName === 'string' ? row.suggestedName.slice(0, 128) : `pid-${row.pid}`,
          suggestedEntry: typeof row.suggestedEntry === 'string' ? row.suggestedEntry.slice(0, 512) : '',
          ...(typeof row.user === 'string' ? { user: row.user } : {}),
        });
      }
      return out;
    },
    async signalTask(task: TaskRegistration, action: JobControlAction, processKeys: ProcessKey[], signal: AbortSignal): Promise<JobControlResult> {
      const { registry, host } = await currentContext();
      if (host.allowJobControl !== true) {
        return { ok: false, action, taskId: task.taskId, pidsSignaled: [], errorCode: 'JOB_CONTROL_DISABLED', message: 'Job control is disabled for this host.' };
      }
      if (!options.launcherSource) {
        return { ok: false, action, taskId: task.taskId, pidsSignaled: [], errorCode: 'LAUNCHER_UNAVAILABLE', message: 'Launcher source is unavailable.' };
      }
      if (action === 'restart') {
        if (processKeys.length > 0) {
          await invokeOneShotScript({ ...context, host, registry }, options.launcherSource, {
            version: PROTOCOL_VERSION,
            requestId: randomUUID(),
            sourceId: null,
            op: 'signal_task',
            action: 'stop',
            processKeys,
          }, signal, spawnChild, { timeoutMs: 10_000 });
        }
        return { ok: true, action: 'restart', taskId: task.taskId, pidsSignaled: processKeys.map((k) => k.pid), errorCode: null, message: 'Stop signal sent for restart.' };
      }
      const data = await invokeOneShotScript({ ...context, host, registry }, options.launcherSource, {
        version: PROTOCOL_VERSION,
        requestId: randomUUID(),
        sourceId: null,
        op: 'signal_task',
        action,
        processKeys,
      }, signal, spawnChild, { timeoutMs: 10_000 }) as Record<string, unknown>;
      return {
        ok: data?.ok === true,
        action,
        taskId: task.taskId,
        pidsSignaled: Array.isArray(data?.pidsSignaled) ? data.pidsSignaled.filter((n): n is number => typeof n === 'number') : [],
        errorCode: typeof data?.errorCode === 'string' ? data.errorCode : null,
        message: data?.ok === true ? `Signal ${action} sent.` : (typeof data?.errorCode === 'string' ? data.errorCode : 'SIGNAL_FAILED'),
      };
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
      const data = await invokeOneShotScript({ ...context, host, registry }, script, {
        version: PROTOCOL_VERSION,
        requestId: randomUUID(),
        sourceId: null,
        op: 'launch_task',
        armId,
        taskId: task.taskId,
        configHash,
        ...scopes,
        entryPaths: registered.entryPaths,
        sources: registered.sources,
        launch: config.launch,
        gpuDevices,
        maxUtilizationPercent: config.maxUtilizationPercent,
        maxMemoryMiB: config.maxMemoryMiB,
        ...(config.minFreeMemoryMiB ? { minFreeMemoryMiB: config.minFreeMemoryMiB } : {}),
        ...(config.minFreeDiskMiB ? { minFreeDiskMiB: config.minFreeDiskMiB } : {}),
        ...(config.gpuSharing ? { gpuSharing: config.gpuSharing } : {}),
      }, signal, spawnChild, { timeoutMs: 15_000 }) as Record<string, unknown>;
      if (!data || !['started', 'busy', 'already_running', 'failed'].includes(String(data.status)) ||
          !(data.pid === null || (Number.isSafeInteger(data.pid) && Number(data.pid) > 0)) || !(data.startedAt === null || iso(data.startedAt)) ||
          !(data.errorCode === null || (typeof data.errorCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(data.errorCode))) ||
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
      const payload = await callProbeSession(host, {
        version: PROTOCOL_VERSION,
        requestId,
        sourceId: request.sourceId,
        op: 'read_log',
        path: remotePath,
        currentPath: registration.source.path,
        ...(registration.source.pathMode ? { pathMode: registration.source.pathMode } : {}),
        ...scopes,
        offset: request.offset,
        limitBytes: request.limitBytes,
        anchors: request.anchors,
        expected: request.expected,
        kind: request.kind,
      }, signal);
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
      const payload = await callProbeSession(host, {
        version: PROTOCOL_VERSION,
        requestId,
        sourceId,
        op: 'scan_rotation',
        currentPath: link.source.path,
        candidates: resolved.map((item) => item.path),
        ...pathScopes(host, link.task),
        anchors,
      }, signal);
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
      return {
        status: complete ? 'complete' : 'inconclusive',
        candidates,
        errorCode: complete ? null : typeof data.errorCode === 'string' ? data.errorCode : 'ROTATION_SCAN_INCOMPLETE',
        errorScope: complete ? null : validErrorScope(data.errorScope) ?? 'source',
        phase: complete ? null : validProbePhase(data.phase) ?? 'archive_scan',
        requestId,
        sourceId,
        observedAt,
      };
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
  return {
    fileIdentity: { dev: (identity as Record<string, string>).dev, inode: (identity as Record<string, string>).inode },
    sizeBytes: row.sizeBytes,
    anchors: anchors.map((item) => ({ startOffset: item.startOffset, endOffset: (BigInt(item.startOffset) + BigInt(item.length)).toString(), sha256: item.sha256 })),
    observedAt,
    identityStrength: 'strong',
  };
}
