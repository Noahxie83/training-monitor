import { describe, expect, it } from 'vitest';
import {
  createInitialBindingState,
  ingestCompleteRecord,
  interruptBindingObservation,
  updateBindings,
  type BindingState,
} from '../../src/domain/bindings';
import { ingestStructuredBaselineRead } from '../../src/domain/evidence';
import { makeRunId } from '../../src/domain/identity';
import { projectTask } from '../../src/domain/lifecycle';
import type { LogEvent, ProcessKey, TaskRegistration, TaskSnapshot } from '../../src/shared/contracts';
import type { HostObservation, TaskObservation } from '../../src/transport/types';

describe('canonical observation interruption and evidence time', () => {
  const hostId = 'lab-campus';
  const taskId = 'flow-lifecycle';
  const logSourceId = 'main-log';
  const statusSourceId = 'status-json';
  const logGeneration = 'log-gen-1';
  const statusGeneration = 'status-gen-1';
  const logIdentity = { dev: '10', inode: '20' };
  const statusIdentity = { dev: '30', inode: '40' };
  const mainKey: ProcessKey = { hostBootId: 'boot-1', pid: 4321, startTicks: '98765' };
  const runId = makeRunId(hostId, taskId, mainKey);

  const openAt = '2026-10-20T00:00:00.000Z';
  const eventAt = '2026-10-20T00:00:01.000Z';
  const stopAt = '2026-10-20T00:00:05.000Z';
  const reopenAt = '2026-10-20T00:00:10.000Z';
  const firstNewAt = '2026-10-20T00:00:11.000Z';
  const secondNewAt = '2026-10-20T00:00:12.000Z';
  const failedAt = '2026-10-20T00:00:20.000Z';
  const flowText80106 = '80106/169999 [05:20<05:00, 2.50it/s]';
  const flowText80110 = '80110/169999 [05:19<04:59, 2.50it/s]';
  const flowText80111 = '80111/169999 [05:19<04:59, 2.50it/s]';
  const flowText80120 = '80120/169999 [05:18<04:58, 2.50it/s]';

  const task: TaskRegistration = {
    taskId,
    hostId,
    label: 'Flow lifecycle fixture',
    enabled: true,
    algorithm: 'flow',
    allowedDirectories: ['/training'],
    entryPaths: ['/training/train.py'],
    sources: [
      { sourceId: logSourceId, path: '/training/train.log', kind: 'log' },
      { sourceId: statusSourceId, path: '/training/status.json', kind: 'status_json' },
    ],
    checkpointDirectories: [],
  };

  function baselineContent(key: ProcessKey = mainKey): string {
    return JSON.stringify({
      taskId,
      hostId,
      hostBootId: key.hostBootId,
      pid: key.pid,
      startTicks: key.startTicks,
      sequence: 1,
      resume_checkpoint_index: 30000,
      total_steps: 200000,
      target_meaning: 'exclusive_index',
    });
  }

  const statusContent = baselineContent();
  const statusEof = String(new TextEncoder().encode(statusContent).length);

  function observation(at: string, logEof: string, key: ProcessKey = mainKey): TaskObservation {
    const statusValues = {
      taskId,
      hostId,
      hostBootId: key.hostBootId,
      pid: key.pid,
      startTicks: key.startTicks,
      sequence: 1,
    };
    return {
      taskId,
      hostId,
      observedAt: at,
      freshness: 'fresh',
      scanComplete: true,
      processScanError: null,
      phase: null,
      errorCode: null,
      sources: [
        {
          sourceId: logSourceId,
          observedAt: at,
          fileIdentity: logIdentity,
          eofBytes: logEof,
          permission: 'readable',
          exists: true,
          statusValues: null,
          heldByRegisteredProcess: null,
          errorCode: null,
          evidenceComplete: true,
          phase: null,
        },
        {
          sourceId: statusSourceId,
          observedAt: at,
          fileIdentity: statusIdentity,
          eofBytes: statusEof,
          permission: 'readable',
          exists: true,
          statusValues,
          heldByRegisteredProcess: null,
          errorCode: null,
          evidenceComplete: true,
          phase: null,
        },
      ],
      processes: [{
        key,
        role: 'trainer',
        cwd: '/training',
        scriptEntry: '/training/train.py',
        observedAt: at,
        roleEvidence: 'exact_entry_and_direct_writer_fd',
        directWriterSourceIds: [logSourceId],
        writerSourceEvidence: {
          [logSourceId]: { fileIdentity: logIdentity, eofBytes: logEof },
        },
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      }],
    };
  }

  function hostObservation(at: string): HostObservation {
    return {
      hostId,
      freshness: 'fresh',
      observedAt: at,
      phase: null,
      connection: 'connected',
      scanComplete: true,
      hostBootId: mainKey.hostBootId,
      errorCode: null,
    };
  }

  function sourceInfo(logEof: string) {
    return {
      [logSourceId]: { generation: logGeneration, eofBytes: logEof, fileIdentity: logIdentity },
      [statusSourceId]: { generation: statusGeneration, eofBytes: statusEof, fileIdentity: statusIdentity },
    };
  }

  function outputSamples(at: string) {
    return {
      [logSourceId]: {
        sourceId: logSourceId,
        generation: logGeneration,
        fileIdentity: logIdentity,
        startOffset: '0',
        endOffset: String(new TextEncoder().encode(flowText80106).length),
        observedAt: at,
        text: flowText80106,
      },
    };
  }

  function update(
    state: BindingState,
    at: string,
    logEof: string,
    epoch: string,
    key: ProcessKey = mainKey,
  ): BindingState {
    return updateBindings(state, {
      task,
      taskId,
      hostId,
      observerEpoch: epoch,
      observedAt: at,
      taskObservation: observation(at, logEof, key),
      sourceInfo: sourceInfo(logEof),
      outputSamples: outputSamples(at),
    });
  }

  function event(
    eventId: string,
    startOffset: string,
    endOffset: string,
    at: string,
    text = flowText80106,
    kind: LogEvent['kind'] = 'line',
    recordComplete: boolean | null = true,
    prefixIncomplete: boolean | null = false,
  ): LogEvent {
    return {
      version: 1,
      eventId,
      taskId,
      sourceId: logSourceId,
      generation: logGeneration,
      kind,
      startOffset,
      endOffset,
      ingestedAt: at,
      text,
      reason: null,
      displayTruncated: false,
      recordComplete,
      prefixIncomplete,
      runId: null,
      bindingId: null,
    };
  }

  function openCanonical(withInitialEvent: boolean): BindingState {
    let state = update(createInitialBindingState(), openAt, '5000', 'epoch-e1');
    state = ingestStructuredBaselineRead(
      state,
      task,
      observation(openAt, '5000'),
      {
        evidenceId: 'baseline-1',
        sourceId: statusSourceId,
        generation: statusGeneration,
        fileIdentity: statusIdentity,
        observedAt: openAt,
        startOffset: '0',
        endOffset: statusEof,
        rawContent: statusContent,
      },
    );
    if (withInitialEvent) {
      state = update(state, eventAt, '5200', 'epoch-e1');
      state = ingestCompleteRecord(
        event('initial-record', '5000', '5200', eventAt),
        state,
      ).state;
    }
    return state;
  }

  function openWithoutBaseline(withInitialEvent: boolean): BindingState {
    let state = update(createInitialBindingState(), openAt, '5000', 'epoch-e1');
    expect(state.baselineRead).toBeNull();
    if (withInitialEvent) {
      state = update(state, eventAt, '5200', 'epoch-e1');
      state = ingestCompleteRecord(
        event('no-baseline-initial-record', '5000', '5200', eventAt),
        state,
      ).state;
    }
    return state;
  }

  function project(
    state: BindingState,
    at: string,
    logEof: string,
    key: ProcessKey = mainKey,
  ): TaskSnapshot {
    return projectTask(null, {
      task,
      taskObservation: observation(at, logEof, key),
      hostObservation: hostObservation(at),
      observedAt: at,
      bindingState: state,
      outputSamples: outputSamples(at),
    });
  }

  it('keeps same-run baseline and historical progress stale after interruption and unchanged-EOF reopen', () => {
    const interrupted = interruptBindingObservation(openCanonical(true));
    expect(interrupted.observerEpoch).toBeNull();
    expect(interrupted.activeRunId).toBe(runId);
    expect(interrupted.activeMainKey).toEqual(mainKey);
    expect(interrupted.baselineRead?.evidenceId).toBe('baseline-1');
    expect(interrupted.windows.every((window) => !window.isOpen)).toBe(true);

    const reopened = update(interrupted, reopenAt, '5200', 'epoch-e2');
    const snapshot = project(reopened, reopenAt, '5200');

    expect(snapshot.currentRun?.runId).toBe(runId);
    expect(snapshot.progress).toMatchObject({
      freshness: 'stale',
      observedAt: eventAt,
      runId,
      baselineEvidenceId: 'baseline-1',
      resumeCheckpointIndex: 30000,
      lastStepIndex: 110106,
      session: { completedCount: 80106, targetCount: 169999 },
      global: { completedCount: 110107, targetCount: 200000 },
      iterationsPerSecond: null,
      etaSeconds: null,
    });
  });

  it('opens a new epoch at the current EOF and cannot affiliate stopped-interval bytes', () => {
    const interrupted = interruptBindingObservation(openCanonical(true));
    const reopened = update(interrupted, reopenAt, '7000', 'epoch-e2');
    const currentWindow = reopened.windows.find((window) => window.isOpen);
    expect(currentWindow).toMatchObject({ fromOffset: '7000', throughOffset: '7000', observerEpoch: 'epoch-e2' });

    const offlineAttempt = ingestCompleteRecord(
      event('offline-record', '5200', '5400', firstNewAt),
      reopened,
    );
    expect(offlineAttempt.event.runId).toBeNull();
    expect(offlineAttempt.event.bindingId).toBeNull();
    expect(offlineAttempt.state.completeRecords).toHaveLength(1);

    const snapshot = project(reopened, firstNewAt, '7000');
    expect(snapshot.progress.freshness).toBe('stale');
    expect(snapshot.progress.observedAt).toBe(eventAt);
    expect(snapshot.progress.session.completedCount).toBe(80106);
  });

  it('requires two advancing records in the new window before restoring rate and ETA', () => {
    const interrupted = interruptBindingObservation(openCanonical(false));
    let state = update(interrupted, reopenAt, '5000', 'epoch-e2');

    state = update(state, firstNewAt, '5100', 'epoch-e2');
    state = ingestCompleteRecord(
      event('new-record-1', '5000', '5100', firstNewAt, flowText80110),
      state,
    ).state;
    const oneRecord = project(state, firstNewAt, '5100');
    expect(oneRecord.progress).toMatchObject({
      freshness: 'fresh',
      observedAt: firstNewAt,
      baselineEvidenceId: 'baseline-1',
      session: { completedCount: 80110 },
      iterationsPerSecond: null,
      etaSeconds: null,
    });

    state = update(state, secondNewAt, '5200', 'epoch-e2');
    state = ingestCompleteRecord(
      event('new-record-2', '5100', '5200', secondNewAt, flowText80120),
      state,
    ).state;
    const twoRecords = project(state, secondNewAt, '5200');
    expect(state.completeRecords?.map((record) => ({
      eventId: record.eventId,
      bindingId: record.bindingId,
      ingestedAt: record.ingestedAt,
      endOffset: record.endOffset,
    }))).toEqual([
      { eventId: 'new-record-1', bindingId: state.bindings.find((binding) => binding.sourceId === logSourceId)?.bindingId, ingestedAt: firstNewAt, endOffset: '5100' },
      { eventId: 'new-record-2', bindingId: state.bindings.find((binding) => binding.sourceId === logSourceId)?.bindingId, ingestedAt: secondNewAt, endOffset: '5200' },
    ]);
    expect(state.polls?.map((poll) => ({
      windowId: poll.windowId,
      eofBytes: poll.eofBytes,
      observedAt: poll.observedAt,
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ eofBytes: '5100', observedAt: firstNewAt }),
      expect.objectContaining({ eofBytes: '5200', observedAt: secondNewAt }),
    ]));
    expect(twoRecords.progress).toMatchObject({
      freshness: 'fresh',
      observedAt: secondNewAt,
      baselineEvidenceId: 'baseline-1',
      session: { completedCount: 80120 },
      global: { completedCount: 110121, targetCount: 200000 },
      iterationsPerSecond: 10,
      etaSeconds: 8988,
    });
  });

  it('does not create fresh progress from a host scan that finds no new post-reopen record', () => {
    const interrupted = interruptBindingObservation(openCanonical(true));
    let state = update(interrupted, reopenAt, '7000', 'epoch-e2');
    state = update(state, firstNewAt, '7000', 'epoch-e2');

    const snapshot = project(state, firstNewAt, '7000');
    expect(snapshot.progress).toMatchObject({
      freshness: 'stale',
      observedAt: eventAt,
      runId,
      baselineEvidenceId: 'baseline-1',
      session: { completedCount: 80106 },
      iterationsPerSecond: null,
      etaSeconds: null,
    });
  });

  it('keeps uninterrupted same-epoch appends usable and timestamps progress from the record', () => {
    let state = openCanonical(false);
    state = update(state, firstNewAt, '5200', 'epoch-e1');
    state = ingestCompleteRecord(
      event('same-epoch-record', '5000', '5200', firstNewAt),
      state,
    ).state;

    const polledAgain = update(state, secondNewAt, '5200', 'epoch-e1');
    const snapshot = project(polledAgain, secondNewAt, '5200');
    expect(snapshot.progress).toMatchObject({
      freshness: 'fresh',
      observedAt: firstNewAt,
      runId,
      baselineEvidenceId: 'baseline-1',
      session: { completedCount: 80106 },
      global: { completedCount: 110107 },
    });
  });

  it('accepts a complete standalone-CR redraw in the current observation window', () => {
    let state = openCanonical(false);
    state = update(state, firstNewAt, '5200', 'epoch-e1');
    state = ingestCompleteRecord(
      event('standalone-redraw', '5000', '5200', firstNewAt, flowText80106, 'redraw'),
      state,
    ).state;

    const snapshot = project(state, firstNewAt, '5200');
    expect(snapshot.progress).toMatchObject({
      freshness: 'fresh',
      observedAt: firstNewAt,
      session: { completedCount: 80106 },
    });
  });

  it('leaves incomplete and pending-CR prefixes unbound while accepting the later complete record', () => {
    let state = openCanonical(false);
    state = update(state, firstNewAt, '5200', 'epoch-e1');

    const incomplete = ingestCompleteRecord(
      event('pending-prefix', '5000', '5100', firstNewAt, flowText80110, 'line', false, false),
      state,
    );
    expect(incomplete.event.runId).toBeNull();
    expect(incomplete.event.bindingId).toBeNull();
    expect(incomplete.state.completeRecords).toHaveLength(0);

    const pendingCr = ingestCompleteRecord(
      event('pending-cr', '5000', '5100', firstNewAt, flowText80111, 'line', true, true),
      state,
    );
    expect(pendingCr.event.runId).toBeNull();
    expect(pendingCr.state.completeRecords).toHaveLength(0);

    state = update(state, secondNewAt, '5200', 'epoch-e1');
    const complete = ingestCompleteRecord(
      event('complete-after-prefix', '5100', '5200', secondNewAt, flowText80120),
      state,
    );
    expect(complete.event.runId).toBe(runId);
    expect(complete.event.bindingId).toBeTruthy();
    expect(project(complete.state, secondNewAt, '5200').progress).toMatchObject({
      freshness: 'fresh',
      observedAt: secondNewAt,
      session: { completedCount: 80120 },
    });
  });

  it('invalidates old baseline and progress when a new strong process key starts', () => {
    const interrupted = interruptBindingObservation(openCanonical(true));
    const newKey: ProcessKey = { hostBootId: 'boot-1', pid: 4321, startTicks: '99999' };
    const newRunId = makeRunId(hostId, taskId, newKey);
    let state = update(interrupted, reopenAt, '5200', 'epoch-e2', newKey);

    expect(state.activeRunId).toBe(newRunId);
    expect(state.activeMainKey).toEqual(newKey);
    expect(state.baselineRead).toBeNull();
    expect(state.completeRecords).toHaveLength(0);
    expect(state.polls?.every((poll) => poll.runId === newRunId)).toBe(true);

    state = update(state, firstNewAt, '5400', 'epoch-e2', newKey);
    state = ingestCompleteRecord(
      event('new-run-record', '5200', '5400', firstNewAt, flowText80110),
      state,
    ).state;
    const snapshot = project(state, firstNewAt, '5400', newKey);
    expect(snapshot.currentRun?.runId).toBe(newRunId);
    expect(snapshot.progress).toMatchObject({
      freshness: 'fresh',
      observedAt: firstNewAt,
      runId: newRunId,
      baselineEvidenceId: null,
      lastStepIndex: null,
      session: { completedCount: 80110 },
      global: { completedCount: null, targetCount: null },
      iterationsPerSecond: null,
      etaSeconds: null,
    });
  });

  it('T5-I-06 / T6A-NEW-01: failed scan preserves no-baseline same-run history, then same-key recovery retains it', () => {
    let state = openWithoutBaseline(true);
    const previous = project(state, eventAt, '5200');
    expect(previous.currentRun?.runId).toBe(runId);
    expect(previous.progress).toMatchObject({
      freshness: 'fresh',
      observedAt: eventAt,
      session: { completedCount: 80106 },
      global: { completedCount: null },
    });
    const originalBindingId = state.bindings[0].bindingId;

    const failedObservation = observation(stopAt, '5200');
    failedObservation.freshness = 'stale';
    state = updateBindings(state, {
      task,
      taskId,
      hostId,
      observerEpoch: 'epoch-e1',
      observedAt: stopAt,
      taskObservation: failedObservation,
      sourceInfo: sourceInfo('5200'),
      outputSamples: outputSamples(stopAt),
    });

    expect(state.activeRunId).toBe(runId);
    expect(state.activeMainKey).toEqual(mainKey);
    expect(state.observerEpoch).toBeNull();
    expect(state.windows.every((window) => !window.isOpen)).toBe(true);
    expect(state.bindings.some((binding) => binding.bindingId === originalBindingId)).toBe(true);
    expect(state.completeRecords).toHaveLength(1);

    const stale = projectTask(previous, {
      task,
      taskObservation: failedObservation,
      hostObservation: hostObservation(stopAt),
      observedAt: stopAt,
      bindingState: state,
      outputSamples: outputSamples(stopAt),
    });
    expect(stale).toMatchObject({
      lifecycle: 'running',
      freshness: 'stale',
      statusObservedAt: eventAt,
      currentRun: { runId, mainProcessKey: mainKey },
      progress: {
        freshness: 'stale',
        observedAt: eventAt,
        runId,
        baselineEvidenceId: null,
        session: { completedCount: 80106 },
        global: { completedCount: null },
        iterationsPerSecond: null,
        etaSeconds: null,
      },
    });

    state = update(state, reopenAt, '7000', 'epoch-e2');
    expect(state.activeRunId).toBe(runId);
    expect(state.activeMainKey).toEqual(mainKey);
    expect(state.bindings.some((binding) => binding.bindingId === originalBindingId)).toBe(true);
    expect(state.completeRecords).toHaveLength(1);
    expect(state.windows.find((window) => window.isOpen)).toMatchObject({
      fromOffset: '7000',
      throughOffset: '7000',
      observerEpoch: 'epoch-e2',
    });

    const offline = ingestCompleteRecord(
      event('no-baseline-offline-record', '5200', '5400', firstNewAt, flowText80110),
      state,
    );
    expect(offline.event.runId).toBeNull();
    expect(offline.state.completeRecords).toHaveLength(1);

    state = update(state, firstNewAt, '7100', 'epoch-e2');
    const live = ingestCompleteRecord(
      event('no-baseline-live-record', '7000', '7100', firstNewAt, flowText80110),
      state,
    );
    expect(live.event.runId).toBe(runId);
    expect(live.state.completeRecords).toHaveLength(2);
    expect(project(live.state, firstNewAt, '7100').progress).toMatchObject({
      freshness: 'fresh',
      observedAt: firstNewAt,
      runId,
      baselineEvidenceId: null,
      session: { completedCount: 80110 },
      global: { completedCount: null, targetCount: null },
      iterationsPerSecond: null,
      etaSeconds: null,
    });
  });

  it('T5-I-06 / T6A-NEW-01: a complete scan with no trainer closes the epoch but retains no-baseline run identity', () => {
    let state = openWithoutBaseline(true);
    const originalBindingId = state.bindings[0].bindingId;
    const noTrainer = observation(stopAt, '5200');
    noTrainer.processes = [];

    state = updateBindings(state, {
      task,
      taskId,
      hostId,
      observerEpoch: 'epoch-e1',
      observedAt: stopAt,
      taskObservation: noTrainer,
      sourceInfo: sourceInfo('5200'),
      outputSamples: outputSamples(stopAt),
    });
    expect(state.activeRunId).toBe(runId);
    expect(state.activeMainKey).toEqual(mainKey);
    expect(state.observerEpoch).toBeNull();
    expect(state.windows.every((window) => !window.isOpen)).toBe(true);
    expect(state.bindings.some((binding) => binding.bindingId === originalBindingId)).toBe(true);
    expect(state.completeRecords).toHaveLength(1);

    state = update(state, reopenAt, '7000', 'epoch-e2');
    expect(state.activeRunId).toBe(runId);
    expect(state.activeMainKey).toEqual(mainKey);
    expect(state.bindings.some((binding) => binding.bindingId === originalBindingId)).toBe(true);
    expect(state.completeRecords).toHaveLength(1);
  });

  it('T5-I-06 / T6A-NEW-01: forged nonempty key and run ID do not become retained historical authority', () => {
    const valid = openWithoutBaseline(true);
    const forged = {
      ...valid,
      activeRunId: 'invented-run-id',
      activeMainKey: { hostBootId: 'boot-forged', pid: 9999, startTicks: '1' },
    };
    const failedObservation = observation(stopAt, '5200');
    failedObservation.freshness = 'stale';

    const next = updateBindings(forged, {
      task,
      taskId,
      hostId,
      observerEpoch: 'epoch-e1',
      observedAt: stopAt,
      taskObservation: failedObservation,
      sourceInfo: sourceInfo('5200'),
      outputSamples: outputSamples(stopAt),
    });
    expect(next.activeRunId).toBeNull();
    expect(next.activeMainKey).toBeNull();
  });

  it('preserves original status time through a failed host scan', () => {
    let state = openCanonical(false);
    state = update(state, firstNewAt, '5200', 'epoch-e1');
    state = ingestCompleteRecord(
      event('prior-evidence', '5000', '5200', firstNewAt),
      state,
    ).state;
    const previous = project(state, firstNewAt, '5200');

    const disconnectedHost: HostObservation = {
      ...hostObservation(failedAt),
      connection: 'disconnected',
      freshness: 'stale',
      scanComplete: false,
      errorCode: 'CONNECT_FAILED',
    };
    const failed = projectTask(previous, {
      task,
      taskObservation: observation(failedAt, '5200'),
      hostObservation: disconnectedHost,
      observedAt: failedAt,
      bindingState: state,
      outputSamples: outputSamples(failedAt),
    });

    expect(failed.statusObservedAt).toBe(firstNewAt);
    expect(failed.progress).toMatchObject({
      freshness: 'stale',
      observedAt: firstNewAt,
      iterationsPerSecond: null,
      etaSeconds: null,
    });
  });
});
