import { describe, expect, it } from 'vitest';
import { projectStatusRecord } from '../../src/domain/status-record';
import { projectTask } from '../../src/domain/lifecycle';
import { validateTaskSnapshot } from '../../src/shared/validate';
import type { TaskRegistration } from '../../src/shared/contracts';
import type { HostObservation, TaskObservation } from '../../src/transport/types';

function fixture(patch: Record<string, unknown> = {}) {
  const task: TaskRegistration = { taskId: 't', hostId: 'h', label: 'Task', enabled: true, algorithm: 'HDPS', logFormat: 'flow', allowedDirectories: ['/run'], entryPaths: ['/run/start.py'], checkpointDirectories: [], sources: [{ sourceId: 'status', kind: 'status_json', path: '/run/status.json' }] };
  const time = '2026-11-15T12:00:00Z';
  const host: HostObservation = { hostId: 'h', connection: 'connected', freshness: 'fresh', observedAt: time, scanComplete: true, hostBootId: 'boot', phase: null, errorCode: null };
  const raw = JSON.stringify({ taskId: 't', hostId: 'h', hostBootId: 'boot', pid: 42, startTicks: '100', sequence: 5, status: 'failed', error: 'CUDA out of memory', updated_at: '2026-11-15T11:00:00Z', step: 634916, target: 2060801, target_meaning: 'exclusive_index', resume_checkpoint_index: 20470, ...patch });
  const observation: TaskObservation = { taskId: 't', hostId: 'h', observedAt: time, freshness: 'fresh', scanComplete: true, processScanError: null, phase: null, errorCode: null, processes: [], sources: [{ sourceId: 'status', observedAt: time, fileIdentity: { dev: '1', inode: '2' }, eofBytes: String(Buffer.byteLength(raw)), permission: 'readable', exists: true, statusValues: null, statusRawContent: raw, heldByRegisteredProcess: null, errorCode: null, evidenceComplete: true, phase: null }] };
  const snapshot = projectTask(null, { task, hostObservation: host, taskObservation: observation, observedAt: time });
  return { task, host, observation, snapshot, project: () => projectStatusRecord(snapshot, task, host, observation) };
}

describe('last reported progress after a task exits', () => {
  it('shows failure and historical counts while reporting no live speed or GPU process', () => {
    const result = fixture({ updated_at: '2026-11-15T19:00:00+0800' }).project();
    expect(() => validateTaskSnapshot(result)).not.toThrow();
    expect(result.progress.observedAt).toBe('2026-11-15T11:00:00.000Z');
    expect(result.lifecycle).toBe('failed');
    expect(result.reason).toBe('CUDA out of memory');
    expect(result.processes.main).toBeNull();
    expect(result.progress).toMatchObject({ freshness: 'stale', lastStepIndex: 634916, iterationsPerSecond: null, etaSeconds: null, global: { completedCount: 634917, targetCount: 2060801 } });
  });
  it('does not use another task or boot identity as this task history', () => {
    expect(fixture({ taskId: 'other' }).project().lifecycle).toBe('not_observed');
    expect(fixture({ hostBootId: 'other' }).project().lifecycle).toBe('not_observed');
  });
  it('does not label a status record as terminal while it reports running', () => {
    expect(fixture({ status: 'running' }).project().lifecycle).toBe('not_observed');
  });
  it('does not let an old failure override a visible replacement process', () => {
    const f = fixture();
    f.observation.processes.push({ key: { hostBootId: 'boot', pid: 84, startTicks: '200' }, role: 'unknown', cwd: '/run', scriptEntry: '/run/start.py', observedAt: f.observation.observedAt!, roleEvidence: 'exact_script_entry', directWriterSourceIds: [], writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [] });
    expect(f.project()).toBe(f.snapshot);
  });
  it('fills live progress from a matching producer when log bindings are catching up', () => {
    const f = fixture({ status: 'running' });
    f.observation.processes.push({ key: { hostBootId: 'boot', pid: 42, startTicks: '100' }, role: 'unknown', cwd: '/run', scriptEntry: '/run/start.py', observedAt: f.observation.observedAt!, roleEvidence: 'exact_entry_and_direct_writer_fd', directWriterSourceIds: ['log'], writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [] });
    const snapshot = f.project();
    expect(snapshot.lifecycle).toBe('running');
    expect(snapshot.progress).toMatchObject({ freshness: 'fresh', global: { completedCount: 634917, targetCount: 2060801, verified: true } });
    expect(() => validateTaskSnapshot(snapshot)).not.toThrow();
    f.observation.processes[0]!.key.startTicks = '200';
    expect(f.project()).toBe(f.snapshot);
  });
  it('uses successive live status reads for rate instead of replayed log speed', () => {
    const f = fixture({ status: 'running' });
    f.observation.processes.push({ key: { hostBootId: 'boot', pid: 42, startTicks: '100' }, role: 'unknown', cwd: '/run', scriptEntry: '/run/start.py', observedAt: f.observation.observedAt!, roleEvidence: 'exact_entry_and_direct_writer_fd', directWriterSourceIds: ['log'], writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [] });
    const previous = f.project();
    const source = f.observation.sources[0]!;
    const record = JSON.parse(source.statusRawContent!); record.step += 20; record.sequence++;
    source.statusRawContent = JSON.stringify(record); source.eofBytes = String(Buffer.byteLength(source.statusRawContent!));
    source.observedAt = '2026-11-15T12:00:10Z';
    const next = projectStatusRecord(f.snapshot, f.task, f.host, f.observation, previous);
    expect(next.progress.iterationsPerSecond).toBe(2);
    expect(next.progress.global.completedCount).toBe(634937);
  });
});
