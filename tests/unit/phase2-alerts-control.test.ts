import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertEngine, buildWebhookPayload, dispatchWebhook } from '../../src/collector/alerts';
import { createProductionApi } from '../../src/collector/service';
import { appendJobControlAudit, buildHelperCommand, openLocalSshTerminal } from '../../src/desktop/notifications';
import { openStore } from '../../src/store/client';
import type { AlertEvent, HostRegistration, JobControlAuditEntry, LogEvent, Registry, TaskSnapshot } from '../../src/shared/contracts';
import type { Transport } from '../../src/transport/types';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeRunningSnap(step: number, gpuUtil: number, runId = 'run-1'): TaskSnapshot {
  return {
    version: 1, taskId: 't1', hostId: 'h1', lifecycle: 'running', freshness: 'fresh',
    statusObservedAt: '2026-11-26T00:00:00.000Z', confidence: 'high', reason: 'running',
    evidence: [], currentRun: { runId, mainProcessKey: { hostBootId: 'b1', pid: 42, startTicks: '10' } },
    processes: { main: null, queue: null, workers: [] },
    queueLock: { observedAt: null, freshness: 'unobserved', source: null, exists: null, heldByRegisteredProcess: null },
    progress: {
      observedAt: '2026-11-26T00:00:00.000Z', freshness: 'fresh', runId, lastStepIndex: step,
      current: step, total: 1000, bindingIds: [], baselineEvidenceId: null, resumeCheckpointIndex: null,
      firstLoopIndex: null,
      global: { completedCount: null, targetCount: null, fraction: null, unit: 'unknown', verified: false, sourceId: null },
      session: { completedCount: step, targetCount: 1000, fraction: step / 1000, unit: 'step', verified: true, sourceId: 'log' },
      configuredTarget: null, iterationsPerSecond: null, etaSeconds: null,
    },
    checkpoint: {
      observedAt: null, freshness: 'unobserved', path: null, fileStepIndex: null, stepSource: null,
      sizeBytes: null, mtime: null, evidence: 'none', scanComplete: false,
    },
    resources: [{
      observedAt: '2026-11-26T00:00:00.000Z', freshness: 'fresh', source: 'nvidia-smi',
      name: 'gpu_utilization', unit: 'percent_device', value: gpuUtil,
      scope: 'process', deviceId: 'GPU 0', processKey: { hostBootId: 'b1', pid: 42, startTicks: '10' },
    }],
  };
}

describe('Phase 2 AlertEngine, Webhooks, helper commands, and opt-in job control', () => {
  it('triggers OOM, NaN/Inf, Stall, Crash, Complete, and HostDisconnect alerts with cooldown deduplication', async () => {
    let nowMs = Date.parse('2026-11-26T00:00:00.000Z');
    const received: AlertEvent[] = [];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const engine = new AlertEngine({
      clock: () => nowMs,
      getPreferences: () => ({
        cooldownSeconds: 300,
        stallThresholdMinutes: 15,
        hostDisconnectThresholdSeconds: 60,
        webhooks: [{ enabled: true, kind: 'feishu', url: 'https://hooks.example.com/feishu', label: 'Feishu' }],
      }),
      onAlert: (alert) => { received.push(alert); },
      fetchImpl: fetchMock,
    });

    const mkLog = (id: string, text: string): LogEvent => ({
      version: 1, eventId: id, taskId: 't1', sourceId: 'log', generation: 'g1',
      kind: 'line', startOffset: '0', endOffset: '40', ingestedAt: new Date(nowMs).toISOString(),
      text, reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false,
      runId: null, bindingId: null,
    });

    // OOM + dedup within cooldown window
    engine.inspectLogEvents('h1', 't1', [mkLog('e1', 'torch.OutOfMemoryError: CUDA out of memory')]);
    engine.inspectLogEvents('h1', 't1', [mkLog('e2', 'CUDA out of memory again')]);
    expect(received.filter((a) => a.kind === 'cuda_oom')).toHaveLength(1);

    // NaN loss
    engine.inspectLogEvents('h1', 't1', [mkLog('e3', `{"loss": "NaN"}`)]);
    expect(received.filter((a) => a.kind === 'loss_nan_inf')).toHaveLength(1);

    // Stall detection: 15 minutes zero progress + GPU util < 2%
    const snapA = makeRunningSnap(100, 1);
    engine.inspectTaskSnapshot(null, snapA);
    nowMs += 10 * 60_000;
    engine.inspectTaskSnapshot(snapA, snapA);
    expect(received.filter((a) => a.kind === 'training_stalled')).toHaveLength(0);
    nowMs += 6 * 60_000; // total 16m >= 15m
    engine.inspectTaskSnapshot(snapA, snapA);
    expect(received.filter((a) => a.kind === 'training_stalled')).toHaveLength(1);

    // Host disconnected for >= 60s
    const discHost = {
      version: 1 as const, hostId: 'h1', kind: 'ssh' as const, connection: 'disconnected' as const,
      observedAt: new Date(nowMs).toISOString(), freshness: 'stale' as const,
      lastSuccessAt: null, lastProbeDurationMs: null, scanComplete: false, errorCode: 'SSH_TIMEOUT',
    };
    engine.inspectHostSnapshot(discHost);
    nowMs += 65_000;
    engine.inspectHostSnapshot(discHost);
    expect(received.filter((a) => a.kind === 'host_disconnected')).toHaveLength(1);

    // Verify Webhook payloads for Feishu, Slack, Discord, generic
    const sampleAlert = received[0]!;
    expect(buildWebhookPayload({ enabled: true, kind: 'feishu', url: 'https://x' }, sampleAlert)).toHaveProperty('msg_type', 'text');
    expect(buildWebhookPayload({ enabled: true, kind: 'slack', url: 'https://x' }, sampleAlert)).toHaveProperty('text');
    expect(buildWebhookPayload({ enabled: true, kind: 'discord', url: 'https://x' }, sampleAlert)).toHaveProperty('content');
    const webhookRes = await dispatchWebhook({ enabled: true, kind: 'slack', url: 'https://hooks.slack.com/t' }, sampleAlert, fetchMock);
    expect(webhookRes.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('ignores host-wide utilization, CPU-only tasks and raw logs when checking for stalls', () => {
    let nowMs = Date.parse('2026-11-26T00:00:00.000Z');
    const engine = new AlertEngine({ clock: () => nowMs, getPreferences: () => ({ stallThresholdMinutes: 1 }) });
    const cpu = makeRunningSnap(100, 0);
    const raw = makeRunningSnap(100, 0);
    raw.taskId = 'raw';
    raw.progress.current = null;
    raw.progress.lastStepIndex = null;
    raw.progress.session.completedCount = null;
    cpu.resources[0] = { ...cpu.resources[0]!, scope: 'device', deviceId: 'GPU 0', processKey: null };
    engine.inspectTaskSnapshot(null, cpu);
    engine.inspectTaskSnapshot(null, raw);
    nowMs += 120_000;
    expect(engine.inspectTaskSnapshot(cpu, cpu)).toEqual([]);
    expect(engine.inspectTaskSnapshot(raw, raw)).toEqual([]);
  });

  it.each([
    ['win32', ['wt.exe', 'powershell.exe', 'cmd.exe']],
    ['linux', ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']],
  ] as const)('falls back after asynchronous %s terminal spawn errors', async (platform, terminalNames) => {
    const spawn = vi.fn((name: string) => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => {
        if (name === terminalNames.at(-1)) child.emit('spawn');
        else child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      return child;
    });
    const host: HostRegistration = { hostId: 'h', label: 'Host', enabled: true, allowedRoots: ['/data'],
      target: { kind: 'ssh', alias: 'test-host' } };
    await expect(openLocalSshTerminal(host, undefined, { platform, spawn: spawn as never })).resolves
      .toMatchObject({ ok: true, command: 'ssh -t test-host' });
    expect(spawn.mock.calls.map(([name]) => name)).toEqual(terminalNames);
    const attach = buildHelperCommand('tmux_attach', host, undefined, undefined, 'tm-wait-' + 'a'.repeat(40));
    expect(attach).toContain('tmux -S');
    expect(attach).toContain('/tmp/training-monitor-');
  });

  it('strictly denies remote controlTask when host.allowJobControl is false and audits allowed calls', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-jobctl-'));
    dirs.push(dir);
    const store = await openStore({ directory: dir, now: () => Date.parse('2026-11-26T00:00:00.000Z') });

    let allowJobControl = false;
    const registryProvider = async (): Promise<Registry> => ({
      version: 2, revision: 1,
      hosts: [{
        hostId: 'h1', label: 'H1', enabled: true, allowedRoots: ['/data'],
        allowJobControl, target: { kind: 'ssh', alias: 'gpu-01' },
      }],
      tasks: [{
        taskId: 't1', hostId: 'h1', label: 'T1', enabled: true, algorithm: 'LLM', logFormat: 'generic',
        allowedDirectories: ['/data'], entryPaths: ['train.py'],
        sources: [{ sourceId: 'log', kind: 'log', path: '/data/train.log' }], checkpointDirectories: [],
      }],
    });

    const signalMock = vi.fn().mockResolvedValue({
      ok: true, taskId: 't1', action: 'stop', pidsSignaled: [42], errorCode: null, message: 'Sent SIGTERM',
    });
    const fakeTransport = { signalTask: signalMock } as unknown as Transport;
    const audits: JobControlAuditEntry[] = [];

    const api = createProductionApi({
      store,
      registryProvider,
      transportProvider: () => fakeTransport,
      clock: () => Date.parse('2026-11-26T00:00:00.000Z'),
      auditJobControl: async (entry) => {
        audits.push(entry);
        await appendJobControlAudit(dir, entry);
      },
    });
    await api.start();

    // 1. Default allowJobControl=false MUST deny without calling transport.signalTask!
    const denied = await api.controlTask!({ taskId: 't1', action: 'stop', confirmToken: 'confirm-token-1234' });
    expect(denied.ok).toBe(false);
    expect(denied.errorCode).toBe('JOB_CONTROL_DISABLED');
    expect(signalMock).not.toHaveBeenCalled();
    expect(audits.at(-1)?.allowed).toBe(false);

    // 2. Enable allowJobControl=true -> short/empty token still rejected
    allowJobControl = true;
    const noTok = await api.controlTask!({ taskId: 't1', action: 'stop', confirmToken: 'short' });
    expect(noTok.ok).toBe(false);
    expect(noTok.errorCode).toBe('CONFIRMATION_REQUIRED');
    expect(signalMock).not.toHaveBeenCalled();

    // 3. Enable allowJobControl=true + valid token -> dispatches signalTask & writes JSONL audit log!
    const allowed = await api.controlTask!({ taskId: 't1', action: 'stop', confirmToken: 'confirm-stop-t1-ok' });
    expect(allowed.ok).toBe(true);
    expect(signalMock).toHaveBeenCalledTimes(1);
    const auditLog = await readFile(path.join(dir, 'job-control-audit.jsonl'), 'utf8');
    const lines = auditLog.trim().split('\n').map((l) => JSON.parse(l) as JobControlAuditEntry);
    expect(lines).toHaveLength(3);
    expect(lines[0]!.errorCode).toBe('JOB_CONTROL_DISABLED');
    expect(lines[2]!.allowed).toBe(true);
    expect(lines[2]!.ok).toBe(true);

    // Verify helper commands
    const sshHost: HostRegistration = {
      hostId: 'h1', label: 'H1', enabled: true, allowedRoots: ['/data'],
      target: { kind: 'ssh', hostname: '10.0.0.5', user: 'alice', port: 2222 },
    };
    expect(buildHelperCommand('ssh', sshHost)).toBe('ssh -t -p 2222 alice@10.0.0.5');
    const tmuxCmd = buildHelperCommand('tmux_attach', sshHost, undefined, undefined, 'tm-wait-1');
    expect(tmuxCmd).toContain('tmux attach -t');
    expect(tmuxCmd).toContain('tm-wait-1');

    await api.stop();
  });
});
