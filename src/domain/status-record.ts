import type { TaskRegistration, TaskSnapshot } from '../shared/contracts';
import type { HostObservation, TaskObservation } from '../transport/types';
import { createEmptyProgress } from './progress';
import { areProcessKeysEqual, isRegisteredProcessEntry, isStrongProcessKey, makeRunId } from './identity';

const MAX_RATE_WINDOW_SECONDS = 30 * 60; // 30 minutes to handle slow steps cleanly

/**
 * Optional adapter for structured status files:
 * 1) Legacy instance-linked status JSON (pid/hostBootId/startTicks)
 * 2) Standard HuggingFace `trainer_state.json` (global_step / max_steps / epoch / log_history)
 */
export function projectStatusRecord(
  snapshot: TaskSnapshot,
  task: TaskRegistration,
  host: HostObservation,
  observation: TaskObservation,
  previous: TaskSnapshot | null = null,
): TaskSnapshot {
  if (host.connection !== 'connected' || host.freshness !== 'fresh' || !host.scanComplete || host.errorCode ||
      observation.freshness !== 'fresh' || !observation.scanComplete || observation.errorCode) return snapshot;

  for (const source of observation.sources) {
    if (!task.sources.some(item => item.sourceId === source.sourceId && item.kind === 'status_json') ||
        source.permission !== 'readable' || !source.exists || !source.evidenceComplete || !source.fileIdentity ||
        !source.statusRawContent || source.eofBytes !== String(Buffer.byteLength(source.statusRawContent, 'utf8'))) continue;

    let record: Record<string, unknown>;
    try { record = JSON.parse(source.statusRawContent); } catch { continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;

    // Adapter B: HuggingFace trainer_state.json (standard ML framework state file)
    if (typeof record.global_step === 'number' && typeof record.max_steps === 'number' &&
        record.taskId === undefined && record.hostBootId === undefined) {
      const globalStep = record.global_step;
      const maxSteps = record.max_steps;
      const isProcessRunning = snapshot.lifecycle === 'running';
      const updatedAt = source.observedAt ?? snapshot.statusObservedAt ?? new Date().toISOString();
      const scalars: Record<string, number> = { ...(snapshot.progress.scalars ?? {}) };
      if (Array.isArray(record.log_history) && record.log_history.length > 0) {
        const lastEntry = record.log_history[record.log_history.length - 1];
        if (lastEntry && typeof lastEntry === 'object') {
          for (const key of ['loss', 'eval_loss', 'learning_rate', 'grad_norm']) {
            const v = (lastEntry as Record<string, unknown>)[key];
            if (typeof v === 'number' && Number.isFinite(v)) {
              scalars[key === 'learning_rate' ? 'lr' : key] = v;
            }
          }
        }
      }
      const nextProgress = {
        ...snapshot.progress,
        observedAt: updatedAt,
        lastStepIndex: Number.isSafeInteger(globalStep) ? globalStep : snapshot.progress.lastStepIndex,
        unit: 'step' as const,
        current: globalStep,
        total: maxSteps > 0 ? maxSteps : snapshot.progress.total ?? null,
        ...(Object.keys(scalars).length ? { scalars } : {}),
        ...(maxSteps > 0 ? {
          global: {
            completedCount: Math.min(maxSteps, Math.max(0, Math.round(globalStep))),
            targetCount: Math.round(maxSteps),
            fraction: Math.min(1, Math.max(0, globalStep / maxSteps)),
            unit: 'completed_iterations' as const,
            verified: isProcessRunning,
            sourceId: source.sourceId,
          },
        } : {}),
      };
      if (!isProcessRunning && maxSteps > 0 && globalStep >= maxSteps) {
        return {
          ...snapshot,
          lifecycle: 'completed',
          confidence: 'high',
          reason: `trainer_state.json reached target step (${globalStep}/${maxSteps})`,
          progress: nextProgress,
          evidence: [{
            kind: 'trainer_state_completed',
            sourceId: source.sourceId,
            observedAt: updatedAt,
            confidence: 'high',
            summary: `trainer_state.json reached ${globalStep}/${maxSteps}`,
          }],
        };
      }
      return { ...snapshot, progress: nextProgress };
    }

    // Adapter A: Legacy instance-linked status JSON
    if (record.taskId !== task.taskId || record.hostId !== task.hostId ||
        record.hostBootId !== host.hostBootId || !Number.isSafeInteger(record.sequence) || Number(record.sequence) <= 0) continue;
    if (typeof record.hostBootId !== 'string' || typeof record.pid !== 'number' || typeof record.startTicks !== 'string') continue;
    const key = { hostBootId: record.hostBootId, pid: record.pid, startTicks: record.startTicks };
    if (!isStrongProcessKey(key)) continue;
    const live = record.status === 'running' && observation.processes.some(process =>
      areProcessKeysEqual(process.key, key) && isRegisteredProcessEntry(task, process) &&
      process.roleEvidence === 'exact_entry_and_direct_writer_fd' && process.evidenceComplete && process.writerEvidenceComplete);
    if (observation.processes.length && !live) continue;
    const lifecycle = live ? 'running' : record.status === 'failed' ? 'failed' : record.status === 'completed' ? 'completed' : record.status === 'paused' ? 'ready_not_training' : null;
    if (!lifecycle) continue;
    const updatedAt = live ? source.observedAt : typeof record.updated_at === 'string' && Number.isFinite(Date.parse(record.updated_at)) ? new Date(record.updated_at).toISOString() : source.observedAt;
    const runId = makeRunId(task.hostId, task.taskId, key);
    const progress = createEmptyProgress(updatedAt ?? snapshot.statusObservedAt!, live ? 'fresh' : 'stale', null);
    progress.runId = runId;
    const step = Number.isSafeInteger(record.step) && Number(record.step) >= 0 ? Number(record.step) : null;
    const target = Number.isSafeInteger(record.target) && Number(record.target) > 0 ? Number(record.target) : null;
    const meaning = record.target_meaning === 'exclusive_index' ? 'exclusive_index' : record.target_meaning === 'count' ? 'count' : null;
    if (step !== null && target !== null && meaning) {
      const completed = Math.min(target, step + (meaning === 'exclusive_index' ? 1 : 0));
      progress.lastStepIndex = step;
      progress.unit = 'step';
      progress.current = completed;
      progress.total = target;
      progress.configuredTarget = { value: target, meaning };
      progress.global = { completedCount: completed, targetCount: target, fraction: completed / target, unit: 'completed_iterations', verified: live, sourceId: source.sourceId };
      const resume = record.resume_checkpoint_index;
      if (Number.isSafeInteger(resume) && Number(resume) >= 0 && Number(resume) <= step) {
        const sessionTarget = target - Number(resume) - 1;
        const sessionDone = Math.min(sessionTarget, step - Number(resume));
        if (sessionTarget > 0) {
          progress.session = { completedCount: sessionDone, targetCount: sessionTarget, fraction: sessionDone / sessionTarget, unit: 'completed_iterations', verified: live, sourceId: source.sourceId };
          progress.resumedSession = { ...progress.session };
        }
      }
      if (live && previous?.progress.runId === runId && previous.progress.freshness === 'fresh' && previous.progress.lastStepIndex !== null && previous.progress.observedAt && updatedAt) {
        const seconds = (Date.parse(updatedAt) - Date.parse(previous.progress.observedAt)) / 1000;
        if (seconds > 0 && seconds <= MAX_RATE_WINDOW_SECONDS && step >= previous.progress.lastStepIndex) {
          const measured = (step - previous.progress.lastStepIndex) / seconds;
          const priorRate = previous.progress.global.sourceId === source.sourceId ? previous.progress.iterationsPerSecond : null;
          const rate = priorRate !== null ? 0.8 * priorRate + 0.2 * measured : measured;
          if (rate > 0) { progress.iterationsPerSecond = rate; progress.etaSeconds = Math.ceil((target - completed) / rate); }
        }
      }
    }
    const reason = live ? 'Active training process and its status record confirmed' : record.status === 'failed' && typeof record.error === 'string' ? record.error : `Last run reported ${String(record.status)}`;
    return {
      ...snapshot,
      lifecycle,
      confidence: 'medium',
      reason,
      currentRun: { runId, mainProcessKey: key },
      progress,
      evidence: [{ kind: live ? 'linked_status' : 'terminal_status', sourceId: source.sourceId, observedAt: source.observedAt!, confidence: 'medium', summary: reason }],
    };
  }
  return snapshot;
}
