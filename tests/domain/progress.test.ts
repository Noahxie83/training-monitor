import { describe, expect, it } from 'vitest';
import { makeRunId } from '../../src/domain/identity';
import {
  deriveProgress,
  parseBaselineStartupContent,
  validateStructuredBaselineRead,
  type ProgressEvidence,
  type FlowBaselineEvidence,
} from '../../src/domain/progress';
import { flow } from '../../src/parsers/flow';
import type { LogEvent, ProcessKey, RunBinding, TaskRegistration } from '../../src/shared/contracts';
import type { TaskObservation } from '../../src/transport/types';
import {
  createInitialBindingState,
  ingestCompleteRecord,
  interruptBindingObservation,
  revokeBindings,
  updateBindings,
  type BindingState,
} from '../../src/domain/bindings';
import { ingestStructuredBaselineRead } from '../../src/domain/evidence';

describe('domain progress derivation and flow counting semantics', () => {
  const hostId = 'lab-campus';
  const taskId = 'task-flow-1';
  const sourceId = 'source-log-1';
  const gen = 'gen-1';
  const mainKey: ProcessKey = {
    hostBootId: 'boot-1',
    pid: 8888,
    startTicks: '12345',
  };
  const runId = makeRunId(hostId, taskId, mainKey);

  const binding1: RunBinding = {
    bindingId: 'b-1',
    runId,
    mainProcessKey: mainKey,
    sourceId,
    generation: gen,
    fromOffset: '1000',
    throughOffset: '5000',
    evidenceKind: 'observed_direct_writer',
    observerEpoch: 'epoch-1',
    observedAt: '2026-10-20T00:00:00.000Z',
  };

  const boundEvent: LogEvent = {
    version: 1,
    eventId: 'ev-1',
    taskId,
    sourceId,
    generation: gen,
    kind: 'line',
    startOffset: '1500',
    endOffset: '2000',
    ingestedAt: '2026-10-20T00:00:05.000Z',
    text: '80106/169999 [05:20<05:00, 2.50it/s]',
    reason: null,
    displayTruncated: false,
    recordComplete: true,
    prefixIncomplete: false,
    runId,
    bindingId: 'b-1',
  };

  function canonicalFlowEvidence(events: LogEvent[], revokedSources: string[] = []): ProgressEvidence {
    const sourceIds = [...new Set(events.map((event) => event.sourceId))];
    const generations = Object.fromEntries(sourceIds.map((id) => [id, events.find((event) => event.sourceId === id)?.generation ?? gen]));
    const task = {
      taskId, hostId, label: taskId, enabled: true, algorithm: 'flow' as const,
      allowedDirectories: ['/data'], entryPaths: ['/data/train.py'], checkpointDirectories: [],
      sources: sourceIds.map((id) => ({ sourceId: id, path: `/data/${id}.log`, kind: 'log' as const })),
    };
    const fileIdentities = Object.fromEntries(sourceIds.map((id, index) => [id, { dev: 'dev', inode: String(index + 1) }]));
    const openingTime = '2026-10-20T00:00:30.000Z';
    const firstUpdateTime = '2026-10-20T00:00:31.000Z';
    const secondUpdateTime = '2026-10-20T00:00:32.000Z';
    const sampleText = '80106/169999 [05:20<05:00, 2.50it/s]';
    const observation = (at: string, eof: string): TaskObservation => ({
      taskId, hostId, observedAt: at, freshness: 'fresh', scanComplete: true, processScanError: null,
      phase: null, errorCode: null,
      sources: sourceIds.map((id) => ({ sourceId: id, observedAt: at, fileIdentity: fileIdentities[id], eofBytes: eof,
        permission: 'readable' as const, exists: true, statusValues: null, heldByRegisteredProcess: null,
        errorCode: null, evidenceComplete: true, phase: null })),
      processes: [{ key: mainKey, role: 'trainer', cwd: '/data', scriptEntry: '/data/train.py', observedAt: at,
        roleEvidence: 'exact_entry_and_direct_writer_fd', directWriterSourceIds: sourceIds, writerEvidenceComplete: true,
        evidenceComplete: true, interpreterFlags: [], writerSourceEvidence: Object.fromEntries(sourceIds.map((id) => [id, { fileIdentity: fileIdentities[id], eofBytes: eof }])) }],
    });
    const sample = (id: string, at: string, eof: string) => ({ sourceId: id, generation: generations[id], fileIdentity: fileIdentities[id],
      startOffset: '0', endOffset: String(new TextEncoder().encode(sampleText).length), observedAt: at, text: sampleText });
    let state = updateBindings(createInitialBindingState(), {
      task, taskId, hostId, observerEpoch: 'epoch-1', observedAt: openingTime,
      taskObservation: observation(openingTime, '1000'),
      outputSamples: Object.fromEntries(sourceIds.map((id) => [id, sample(id, openingTime, '1000')])),
      sourceInfo: Object.fromEntries(sourceIds.map((id) => [id, { generation: generations[id], eofBytes: '1000', fileIdentity: fileIdentities[id] }])),
    });
    state = updateBindings(state, {
      task, taskId, hostId, observerEpoch: 'epoch-1', observedAt: firstUpdateTime,
      taskObservation: observation(firstUpdateTime, '5000'),
      outputSamples: Object.fromEntries(sourceIds.map((id) => [id, sample(id, firstUpdateTime, '5000')])),
      sourceInfo: Object.fromEntries(sourceIds.map((id) => [id, { generation: generations[id], eofBytes: '5000', fileIdentity: fileIdentities[id] }])),
    });
    state = updateBindings(state, {
      task, taskId, hostId, observerEpoch: 'epoch-1', observedAt: secondUpdateTime,
      taskObservation: observation(secondUpdateTime, '8000'),
      outputSamples: Object.fromEntries(sourceIds.map((id) => [id, sample(id, secondUpdateTime, '8000')])),
      sourceInfo: Object.fromEntries(sourceIds.map((id) => [id, { generation: generations[id], eofBytes: '8000', fileIdentity: fileIdentities[id] }])),
    });
    for (const event of events) {
      const endOffset = /^\d+$/.test(event.endOffset ?? '') ? BigInt(event.endOffset!) : 0n;
      const eventTime = endOffset <= 5000n ? firstUpdateTime : secondUpdateTime;
      const ingested = ingestCompleteRecord({ ...event, taskId, ingestedAt: eventTime }, state);
      state = ingested.state;
    }
    if (revokedSources.length) {
      state = revokeBindings(state, state.bindings.filter((binding) => revokedSources.includes(binding.sourceId)).map((binding) => binding.bindingId));
    }
    return { taskId, hostId, observedAt: secondUpdateTime, freshness: 'fresh', algorithm: 'flow', currentRun: { runId, mainProcessKey: mainKey }, bindings: [], bindingState: state };
  }

  it('computes exact Flow counters for standard verified profile (b=30000, T=200000, n=80106)', () => {
    const result = flow({ b: 30000, T: 200000, n: 80106 });
    expect(result).toMatchObject({
      firstLoopIndex: 30001,
      lastStepIndex: 110106,
      global: { completedCount: 110107, targetCount: 200000 },
      session: { completedCount: 80106, targetCount: 169999 },
    });
    expect(result.global.fraction).toBeCloseTo(110107 / 200000, 6);
    expect(result.session.fraction).toBeCloseTo(80106 / 169999, 6);
  });

  it('T5-I-09 fix-4: derives progress only from complete records in one comparable source generation', () => {
    const incomplete = deriveProgress({
      taskId, hostId, observedAt: '2026-10-20T00:00:10.000Z', freshness: 'fresh', algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey }, bindings: [binding1],
      boundEvents: [{ ...boundEvent, recordComplete: false }],
    });
    expect(incomplete.session.completedCount).toBeNull();
    expect(incomplete.lastStepIndex).toBeNull();

    const secondBinding: RunBinding = { ...binding1, bindingId: 'b-2', sourceId: 'other-log', generation: 'gen-2' };
    const secondEvent: LogEvent = { ...boundEvent, eventId: 'ev-2', sourceId: 'other-log', generation: 'gen-2', bindingId: 'b-2' };
    const mixedStreams = deriveProgress({
      taskId, hostId, observedAt: '2026-10-20T00:00:10.000Z', freshness: 'fresh', algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey }, bindings: [binding1, secondBinding], boundEvents: [boundEvent, secondEvent],
    });
    expect(mixedStreams.session.completedCount).toBeNull();
    expect(mixedStreams.runId).toBeNull();
  });

  it('handles Flow boundary values at n=0, n=1, and n=169999 with strict index and count semantics', () => {
    // n = 0
    const n0 = flow({ b: 30000, T: 200000, n: 0 });
    expect(n0.lastStepIndex).toBeNull();
    expect(n0.global.completedCount).toBe(30001);
    expect(n0.session.completedCount).toBe(0);

    // n = 1
    const n1 = flow({ b: 30000, T: 200000, n: 1 });
    expect(n1.lastStepIndex).toBe(30001);
    expect(n1.global.completedCount).toBe(30002);
    expect(n1.session.completedCount).toBe(1);

    // n = 169999
    const nMax = flow({ b: 30000, T: 200000, n: 169999 });
    expect(nMax.lastStepIndex).toBe(199999);
    expect(nMax.global.completedCount).toBe(200000);
    expect(nMax.session.completedCount).toBe(169999);
  });

  it('rejects invalid or out-of-bounds Flow parameters without clamping to 100%', () => {
    // n exceeds session target (170000 > 169999)
    expect(() => flow({ b: 30000, T: 200000, n: 170000 })).toThrow(/out of bounds/i);
    // negative n
    expect(() => flow({ b: 30000, T: 200000, n: -1 })).toThrow(/out of bounds/i);
    // non-integer n
    expect(() => flow({ b: 30000, T: 200000, n: 1.5 })).toThrow(/integer/i);
    // target T <= f
    expect(() => flow({ b: 30000, T: 30001, n: 0 })).toThrow(/target/i);
  });

  it('r2-handoff-1: new run resets progress with empty bindingIds and null baselineEvidenceId', () => {
    const newRunEvidence: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: '2026-10-20T00:00:00.000Z',
      freshness: 'fresh',
      algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [],
      boundEvents: [],
      configuredTarget: { value: 200000, meaning: 'exclusive_index' },
    };

    const newRun = { progress: deriveProgress(newRunEvidence) };
    expect(newRun.progress).toMatchObject({
      runId: null,
      bindingIds: [],
      baselineEvidenceId: null,
      lastStepIndex: null,
      resumeCheckpointIndex: null,
      firstLoopIndex: null,
      global: { completedCount: null, targetCount: null, fraction: null },
      session: { completedCount: null, targetCount: null, fraction: null },
    });
  });

  it('marks reopened progress stale and preserves original timestamps when no new bound progress exists', () => {
    const priorProgress = {
      observedAt: '2026-10-20T00:00:00.000Z',
      freshness: 'fresh' as const,
      runId,
      lastStepIndex: 110106,
      bindingIds: ['b-1'],
      baselineEvidenceId: 'base-1',
      resumeCheckpointIndex: 30000,
      firstLoopIndex: 30001,
      global: { completedCount: 110107, targetCount: 200000, fraction: 0.550535, unit: 'completed_iterations' as const, verified: true, sourceId },
      session: { completedCount: 80106, targetCount: 169999, fraction: 0.471214, unit: 'completed_iterations' as const, verified: true, sourceId },
      configuredTarget: { value: 200000, meaning: 'exclusive_index' as const },
      iterationsPerSecond: 2.5,
      etaSeconds: 35957,
    };

    const reopenEvidence: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: '2026-10-20T00:10:00.000Z',
      freshness: 'stale',
      algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [binding1],
      boundEvents: [],
    };

    const reopenedSameRun = { progress: deriveProgress(reopenEvidence) };
    expect(reopenedSameRun.progress.freshness).toBe('stale');
    expect(reopenedSameRun.progress.runId).toBeNull();
    expect(reopenedSameRun.progress.global.completedCount).toBeNull();
    // Without resolvable prior support, an arbitrary persisted Progress DTO is cleared.
  });

  it('keeps global Flow fields null when baseline is unverified or missing (unverifiedFlow)', () => {
    const unverifiedEvidence: ProgressEvidence = {
      ...canonicalFlowEvidence([boundEvent]),
      observedAt: '2026-10-20T00:00:31.000Z',
      baselineEvidence: null, // No verified startup baseline for current run
      configuredTarget: { value: 200000, meaning: 'exclusive_index' },
    };

    const unverifiedFlow = deriveProgress(unverifiedEvidence);
    expect(unverifiedFlow.global.fraction).toBeNull();
    expect(unverifiedFlow.global.completedCount).toBeNull();
    expect(unverifiedFlow.lastStepIndex).toBeNull();
    // Session count can still be populated from the bound record
    expect(unverifiedFlow.session.completedCount).toBe(80106);
    expect(unverifiedFlow.session.targetCount).toBe(169999);
    expect(unverifiedFlow.session.verified).toBe(true);
  });

  it('does not apply Flow offsets to Score or Reflow algorithms', () => {
    const scoreEvidence: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: '2026-10-20T00:00:05.000Z',
      freshness: 'fresh',
      algorithm: 'score',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [binding1],
      boundEvents: [boundEvent],
      configuredTarget: { value: 200000, meaning: 'exclusive_index' },
    };

    const scoreProgress = deriveProgress(scoreEvidence);
    expect(scoreProgress.global.completedCount).toBeNull();
    expect(scoreProgress.global.fraction).toBeNull();
  });

  it('T5-I-02 fix-5: registered Flow policy controls progress when a caller requests Score', () => {
    const canonical = canonicalFlowEvidence([boundEvent]);
    const result = deriveProgress({
      ...canonical,
      taskId,
      hostId,
      algorithm: 'score',
      taskRegistration: { ...canonical.bindingState!.registeredTask!, algorithm: 'score' },
      bindings: [{ ...binding1, fromOffset: '0', throughOffset: '999999' }],
      boundEvents: [{ ...boundEvent, text: '999999/999999 [00:00<00:00, 999it/s]' }],
      configuredTarget: { value: 200000, meaning: 'exclusive_index' },
    });
    expect(result.session.completedCount).toBe(80106);
    expect(result.session.unit).toBe('completed_iterations');
  });

  it('T5-F4-NEW-01 fix-5: complete standalone-CR redraw contributes progress', () => {
    const result = deriveProgress(canonicalFlowEvidence([{ ...boundEvent, kind: 'redraw' }]));
    expect(result.session.completedCount).toBe(80106);
  });

  it('T5-F4-NEW-01 fix-5: two measured complete redraws support rate through the same opening', () => {
    const redraw1: LogEvent = { ...boundEvent, eventId: 'redraw-1', kind: 'redraw', startOffset: '1500', endOffset: '2500', text: '80000/169999 [05:20<05:00, 2.50it/s]' };
    const redraw2: LogEvent = { ...boundEvent, eventId: 'redraw-2', kind: 'redraw', startOffset: '5000', endOffset: '6500', text: '80100/169999 [05:20<05:00, 2.50it/s]' };
    const result = deriveProgress(canonicalFlowEvidence([redraw1, redraw2]));
    expect(result.session.completedCount).toBe(80100);
    expect(result.iterationsPerSecond).toBe(100);
    expect(result.etaSeconds).toBeNull(); // No linked startup baseline in this rate-only fixture.
  });

  it('T5-F4-NEW-02 fix-5: malformed baseline identity fails closed without throwing', () => {
    const raw = JSON.stringify({ resume_checkpoint_index: 30, total_steps: 200, target_meaning: 'exclusive_index' });
    const registeredFlowTask = {
      taskId,
      hostId,
      label: taskId,
      enabled: true,
      algorithm: 'flow' as const,
      allowedDirectories: ['/training'],
      entryPaths: ['/training/train.py'],
      sources: [
        { sourceId, path: '/training/train.log', kind: 'log' as const },
        { sourceId: 'status-json', path: '/training/status.json', kind: 'status_json' as const },
      ],
      checkpointDirectories: [],
    };
    const evidence: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: '2026-10-20T00:00:05.000Z',
      freshness: 'fresh',
      algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [binding1],
      taskRegistration: registeredFlowTask,
      boundEvents: [boundEvent],
      baselineEvidence: {
        evidenceId: 'base-malformed',
        taskId,
        hostId,
        runId,
        mainProcessKey: mainKey,
        sourceId: 'status-json',
        generation: 'status-gen',
        fileIdentity: { dev: '1', inode: '2' },
        observedAt: '2026-10-20T00:00:00.000Z',
        startOffset: '0',
        endOffset: String(new TextEncoder().encode(raw).length),
        resumeCheckpointIndex: 30,
        rawContent: raw,
      },
      sourceObservations: [{ sourceId: 'status-json', generation: 'status-gen', fileIdentity: undefined as any, eofBytes: '500', observedAt: '2026-10-20T00:00:00.000Z' }],
      configuredTarget: { value: 200, meaning: 'exclusive_index' },
      bindingState: {
        taskId, registeredTask: registeredFlowTask, algorithm: 'flow', activeRunId: runId,
        activeMainKey: mainKey, observerEpoch: 'epoch-1', windows: [], bindings: [binding1],
        revokedBindingIds: [], completeRecords: [boundEvent], polls: [],
      },
    };
    expect(() => deriveProgress(evidence)).not.toThrow();
    expect(deriveProgress(evidence).global.verified).toBe(false);
  });

  it('T5-F4-NEW-02 fix-5: malformed rate identity fails closed without throwing', () => {
    const registeredFlowTask = {
      taskId,
      hostId,
      label: taskId,
      enabled: true,
      algorithm: 'flow' as const,
      allowedDirectories: ['/training'],
      entryPaths: ['/training/train.py'],
      sources: [{ sourceId, path: '/training/train.log', kind: 'log' as const }],
      checkpointDirectories: [],
    };
    const secondEvent: LogEvent = {
      ...boundEvent,
      eventId: 'ev-rate-2',
      startOffset: '2000',
      endOffset: '2500',
      ingestedAt: '2026-10-20T00:00:10.000Z',
      text: '80100/169999 [05:10<04:50, 2.50it/s]',
    };
    const evidence: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: '2026-10-20T00:00:10.000Z',
      freshness: 'fresh',
      algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [binding1],
      taskRegistration: registeredFlowTask,
      boundEvents: [boundEvent, secondEvent],
      windows: [{
        windowId: 'window-1', openingId: 'open-1', taskId, sourceId, generation: gen,
        observerEpoch: 'epoch-1', fromOffset: '1000', throughOffset: '5000', isOpen: true,
        mainProcessKey: mainKey, runId, fileIdentity: { dev: '10', inode: '20' }, activeBindingId: 'b-1',
      }],
      rateSamples: [
        { observedAt: boundEvent.ingestedAt, completedCount: 80000, runId, windowId: 'window-1', bindingId: 'b-1', sourceId, generation: gen, startOffset: '1500', endOffset: '2000', eventId: boundEvent.eventId },
        { observedAt: secondEvent.ingestedAt, completedCount: 80100, runId, windowId: 'window-1', bindingId: 'b-1', sourceId, generation: gen, startOffset: '2000', endOffset: '2500', eventId: secondEvent.eventId },
      ],
      rateObservations: [
        { eventId: boundEvent.eventId, sourceId, generation: gen, fileIdentity: undefined as any, eofBytes: '2000', observedAt: boundEvent.ingestedAt, writerProcessKey: mainKey, writerEofBytes: '2000' },
        { eventId: secondEvent.eventId, sourceId, generation: gen, fileIdentity: { dev: '10', inode: '20' }, eofBytes: '3000', observedAt: secondEvent.ingestedAt, writerProcessKey: mainKey, writerEofBytes: '3000' },
      ],
      bindingState: {
        taskId, registeredTask: registeredFlowTask, algorithm: 'flow', activeRunId: runId,
        activeMainKey: mainKey,
        observerEpoch: 'epoch-1',
        windows: [{ windowId: 'window-1', openingId: 'open-1', taskId, sourceId, generation: gen, observerEpoch: 'epoch-1', fromOffset: '1000', throughOffset: '5000', isOpen: true, mainProcessKey: mainKey, runId, fileIdentity: { dev: '10', inode: '20' }, activeBindingId: 'b-1' }],
        bindings: [binding1], revokedBindingIds: [], completeRecords: [boundEvent, secondEvent],
        polls: [
          { taskId, runId, mainProcessKey: mainKey, windowId: 'window-1', openingId: 'open-1', sourceId, generation: gen, observerEpoch: 'epoch-1', fileIdentity: undefined as any, eofBytes: '2000', observedAt: boundEvent.ingestedAt },
          { taskId, runId, mainProcessKey: mainKey, windowId: 'window-1', openingId: 'open-1', sourceId, generation: gen, observerEpoch: 'epoch-1', fileIdentity: { dev: '10', inode: '20' }, eofBytes: '3000', observedAt: secondEvent.ingestedAt },
        ],
      },
    };
    expect(() => deriveProgress(evidence)).not.toThrow();
    expect(deriveProgress(evidence).iterationsPerSecond).toBeNull();
  });

  it('nulls derived counts after revocation when supporting binding evidence is revoked', () => {
    const evidenceWithRevocation: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: '2026-10-20T00:00:10.000Z',
      freshness: 'fresh',
      algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [binding1],
      revokedBindingIds: ['b-1'], // binding revoked
      boundEvents: [boundEvent],
      baselineEvidence: {
        evidenceId: 'base-1',
        taskId,
        hostId,
        runId,
        mainProcessKey: mainKey,
        sourceId,
        generation: gen,
        observedAt: '2026-10-20T00:00:00.000Z',
        resumeCheckpointIndex: 30000,
        rawContent: JSON.stringify({ resume_checkpoint_index: 30000, total_steps: 200000, target_meaning: 'exclusive_index' }),
        provenance: { sourceKind: 'config', profile: 'flow_v1' },
      },
      configuredTarget: { value: 200000, meaning: 'exclusive_index' },
    };

    const progressAfterRevocation = deriveProgress(evidenceWithRevocation);
    expect(progressAfterRevocation.global.completedCount).toBeNull();
    expect(progressAfterRevocation.session.completedCount).toBeNull();
  });

  it('T5-I-07: retained metadata is not independent support for baseline-backed projection', () => {
    const evidence: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: '2026-10-20T00:00:10.000Z',
      freshness: 'fresh',
      algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [binding1],
      boundEvents: [boundEvent],
      bindingState: {
        taskId,
        registeredTask: {
          taskId, hostId, label: taskId, enabled: true, algorithm: 'flow',
          allowedDirectories: ['/data'],
          entryPaths: ['/data/train.py'],
          sources: [{ sourceId, path: '/data/train.log', kind: 'log' }],
          checkpointDirectories: [],
        },
        algorithm: 'flow',
        activeRunId: runId,
        activeMainKey: mainKey,
        observerEpoch: 'epoch-1',
        windows: [],
        bindings: [binding1],
        revokedBindingIds: [],
        completeRecords: [boundEvent],
        polls: [],
        baselineRead: {
          evidenceId: 'self-declared-baseline',
          taskId,
          hostId,
          runId,
          mainProcessKey: mainKey,
          sourceId: 'status-json',
          generation: 'status-gen-1',
          fileIdentity: { dev: '30', inode: '40' },
          observedAt: '2026-10-20T00:00:00.000Z',
          startOffset: '0',
          endOffset: '1',
          rawContent: '{"resume_checkpoint_index":30000,"total_steps":200000,"target_meaning":"exclusive_index"}',
          resumeCheckpointIndex: 30000,
          targetCount: 200000,
        },
      },
    };

    const progress = deriveProgress(evidence);
    expect(progress.baselineEvidenceId).toBeNull();
    expect(progress.global.completedCount).toBeNull();
    expect(progress.global.verified).toBe(false);
    expect(progress.session.completedCount).toBe(80106);
  });

  describe('T6-A canonical journal guards', () => {
    const registeredTask = {
      taskId,
      hostId,
      label: taskId,
      enabled: true,
      algorithm: 'flow' as const,
      allowedDirectories: ['/training'],
      entryPaths: ['/training/train.py'],
      sources: [
        { sourceId, path: '/training/train.log', kind: 'log' as const },
        { sourceId: 'status-json', path: '/training/status.json', kind: 'status_json' as const },
      ],
      checkpointDirectories: [],
    };
    const fileIdentity = { dev: '10', inode: '20' };
    const statusIdentity = { dev: '11', inode: '21' };
    const openingAt = '2026-10-20T00:00:00.000Z';
    const firstRecordAt = '2026-10-20T00:00:02.000Z';
    const secondRecordAt = '2026-10-20T00:00:04.000Z';
    const firstText = '80000/169999 [05:20<05:00, 2.50it/s]';
    const secondText = '80100/169999 [05:10<04:50, 2.50it/s]';
    const structuredContent = JSON.stringify({
      taskId,
      hostId,
      sequence: 1,
      hostBootId: mainKey.hostBootId,
      pid: mainKey.pid,
      startTicks: mainKey.startTicks,
      resume_checkpoint_index: 30000,
      total_steps: 200000,
      target_meaning: 'exclusive_index',
    });

    function taskObservation(at: string, eofBytes: string): TaskObservation {
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
            sourceId,
            observedAt: at,
            fileIdentity,
            eofBytes,
            permission: 'readable',
            exists: true,
            statusValues: null,
            heldByRegisteredProcess: null,
            errorCode: null,
            evidenceComplete: true,
            phase: null,
          },
          {
            sourceId: 'status-json',
            observedAt: openingAt,
            fileIdentity: statusIdentity,
            eofBytes: String(new TextEncoder().encode(structuredContent).length),
            permission: 'readable',
            exists: true,
            statusValues: {
              taskId,
              hostId,
              sequence: 1,
              hostBootId: mainKey.hostBootId,
              pid: mainKey.pid,
              startTicks: mainKey.startTicks,
            },
            heldByRegisteredProcess: null,
            errorCode: null,
            evidenceComplete: true,
            phase: null,
          },
        ],
        processes: [{
          key: mainKey,
          role: 'trainer',
          cwd: '/training',
          scriptEntry: '/training/train.py',
          observedAt: at,
          roleEvidence: 'exact_entry_and_direct_writer_fd',
          directWriterSourceIds: [sourceId],
          writerEvidenceComplete: true,
          evidenceComplete: true,
          interpreterFlags: [],
          writerSourceEvidence: {
            [sourceId]: { fileIdentity, eofBytes },
          },
        }],
      };
    }

    function sample(at: string, eofBytes: string) {
      return {
        sourceId,
        generation: gen,
        fileIdentity,
        startOffset: '0',
        endOffset: String(new TextEncoder().encode(secondText).length),
        observedAt: at,
        text: secondText,
      };
    }

    function observationInput(at: string, eofBytes: string) {
      return {
        task: registeredTask,
        taskId,
        hostId,
        observerEpoch: 'epoch-guards',
        observedAt: at,
        taskObservation: taskObservation(at, eofBytes),
        outputSamples: { [sourceId]: sample(at, eofBytes) },
        sourceInfo: {
          [sourceId]: { generation: gen, eofBytes, fileIdentity },
          'status-json': {
            generation: 'status-gen',
            eofBytes: String(new TextEncoder().encode(structuredContent).length),
            fileIdentity: statusIdentity,
          },
        },
      };
    }

    function canonicalState() {
      let state = updateBindings(createInitialBindingState(), observationInput(openingAt, '1000'));
      state = updateBindings(state, observationInput(firstRecordAt, '2500'));
      const first = ingestCompleteRecord({
        ...boundEvent,
        eventId: 'guard-event-1',
        startOffset: '1500',
        endOffset: '2500',
        ingestedAt: firstRecordAt,
        text: firstText,
      }, state);
      state = updateBindings(first.state, observationInput(secondRecordAt, '4000'));
      const second = ingestCompleteRecord({
        ...boundEvent,
        eventId: 'guard-event-2',
        startOffset: '2500',
        endOffset: '4000',
        ingestedAt: secondRecordAt,
        text: secondText,
      }, state);
      return second.state;
    }

    it('guards canonical source cursor arrays and nested identities without losing a valid baseline', () => {
      const valid = canonicalState();
      const baselineInput = {
        evidenceId: 'guard-baseline',
        sourceId: 'status-json',
        generation: 'status-gen',
        fileIdentity: statusIdentity,
        observedAt: openingAt,
        startOffset: '0',
        endOffset: String(new TextEncoder().encode(structuredContent).length),
        rawContent: structuredContent,
      };
      const baseline = ingestStructuredBaselineRead(valid, registeredTask, taskObservation(openingAt, '1000'), baselineInput);
      expect(baseline.baselineRead).toMatchObject({
        evidenceId: 'guard-baseline',
        observedAt: openingAt,
        resumeCheckpointIndex: 30000,
        targetCount: 200000,
      });

      const malformedStates = [
        { ...baseline, sourceCursors: null },
        { ...baseline, sourceCursors: [null] },
        { ...baseline, sourceCursors: [{ ...baseline.sourceCursors![0], fileIdentity: null }] },
        { ...baseline, sourceCursors: [{ ...baseline.sourceCursors![0], fileIdentity: {} }] },
      ] as any[];

      for (const malformed of malformedStates) {
        expect(() => ingestStructuredBaselineRead(malformed, registeredTask, taskObservation(openingAt, '1000'), baselineInput)).not.toThrow();
        expect(ingestStructuredBaselineRead(malformed, registeredTask, taskObservation(openingAt, '1000'), baselineInput).baselineRead).toBeNull();
        expect(() => updateBindings(malformed, observationInput('2026-10-20T00:00:06.000Z', '4500'))).not.toThrow();
      }
    });

    it.each([
      undefined,
      null,
      '-1',
      '0x10',
      '1e3',
      '1.5',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {},
    ])('rejects malformed canonical poll EOF %j without throwing or weakening valid support', (badEof) => {
      const valid = canonicalState();
      const malformedPoll = { ...valid.polls![0], eofBytes: badEof } as any;
      const malformed = {
        ...valid,
        polls: [...valid.polls!.slice(0, -1), malformedPoll],
      } as any;

      expect(() => ingestCompleteRecord({
        ...boundEvent,
        eventId: 'guard-malformed-poll-record',
        startOffset: '2500',
        endOffset: '4000',
        ingestedAt: malformedPoll.observedAt,
        text: secondText,
      }, malformed)).not.toThrow();
      expect(() => deriveProgress({
        ...canonicalFlowEvidence([]),
        observedAt: secondRecordAt,
        bindingState: malformed,
      })).not.toThrow();
      const projected = deriveProgress({
        ...canonicalFlowEvidence([]),
        observedAt: secondRecordAt,
        bindingState: malformed,
      });
      expect(projected.iterationsPerSecond).toBeNull();
      expect(projected.etaSeconds).toBeNull();
      expect(projected.session.completedCount).toBe(80100);
      expect(() => interruptBindingObservation(malformed)).not.toThrow();
    });

    it('keeps exact decimal comparison above 2^53 while guarding canonical record and projection inputs', () => {
      const hugeOpening = '9007199254740992';
      const hugeRecordEnd = '9007199254745000';
      let state = updateBindings(createInitialBindingState(), observationInput(openingAt, hugeOpening));
      state = updateBindings(state, observationInput(firstRecordAt, hugeRecordEnd));
      const hugeEvent = {
        ...boundEvent,
        eventId: 'guard-huge-record',
        startOffset: hugeOpening,
        endOffset: hugeRecordEnd,
        ingestedAt: firstRecordAt,
        text: firstText,
      };
      const ingested = ingestCompleteRecord(hugeEvent, state);
      expect(ingested.event.runId).toBe(runId);
      expect(ingested.event.bindingId).toBeTruthy();
      expect(() => deriveProgress({
        ...canonicalFlowEvidence([]),
        observedAt: firstRecordAt,
        bindingState: ingested.state,
      })).not.toThrow();
      expect(deriveProgress({
        ...canonicalFlowEvidence([]),
        observedAt: firstRecordAt,
        bindingState: ingested.state,
      }).session.completedCount).toBe(80000);
    });

    it('guards non-array and malformed canonical record, window, poll, binding and baseline journals', () => {
      const valid = canonicalState();
      const malformedStates = [
        { ...valid, polls: null },
        { ...valid, polls: [null] },
        { ...valid, completeRecords: null },
        { ...valid, completeRecords: [null] },
        { ...valid, windows: null },
        { ...valid, windows: [null] },
        { ...valid, bindings: null },
        { ...valid, bindings: [null] },
        { ...valid, baselineRead: { evidenceId: null, fileIdentity: null, rawContent: null } },
      ] as any[];

      for (const malformed of malformedStates) {
        expect(() => updateBindings(malformed, observationInput('2026-10-20T00:00:06.000Z', '4500'))).not.toThrow();
        expect(() => ingestCompleteRecord({
          ...boundEvent,
          eventId: 'guard-journal-record',
          startOffset: '2500',
          endOffset: '4000',
          ingestedAt: secondRecordAt,
          text: secondText,
        }, malformed)).not.toThrow();
        expect(() => deriveProgress({
          ...canonicalFlowEvidence([]),
          observedAt: secondRecordAt,
          bindingState: malformed,
        })).not.toThrow();
        expect(() => interruptBindingObservation(malformed)).not.toThrow();
      }
    });
  });

  describe('T6-A baseline lifecycle', () => {
    const lifecycleTask = {
      taskId,
      hostId,
      label: taskId,
      enabled: true,
      algorithm: 'flow' as const,
      allowedDirectories: ['/training'],
      entryPaths: ['/training/train.py'],
      sources: [
        { sourceId, path: '/training/train.log', kind: 'log' as const },
        { sourceId: 'status-json', path: '/training/status.json', kind: 'status_json' as const },
      ],
      checkpointDirectories: [],
    };
    const fileIdentity = { dev: '10', inode: '20' };
    const statusIdentity = { dev: '11', inode: '21' };
    const openingAt = '2026-10-20T00:00:00.000Z';
    const structuredContent = JSON.stringify({
      taskId,
      hostId,
      sequence: 1,
      hostBootId: mainKey.hostBootId,
      pid: mainKey.pid,
      startTicks: mainKey.startTicks,
      resume_checkpoint_index: 30000,
      total_steps: 200000,
      target_meaning: 'exclusive_index',
    });

    function lifecycleObservation(
      at: string,
      eofBytes: string,
      key: ProcessKey = mainKey
    ): TaskObservation {
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
            sourceId,
            observedAt: at,
            fileIdentity,
            eofBytes,
            permission: 'readable',
            exists: true,
            statusValues: null,
            heldByRegisteredProcess: null,
            errorCode: null,
            evidenceComplete: true,
            phase: null,
          },
          {
            sourceId: 'status-json',
            observedAt: openingAt,
            fileIdentity: statusIdentity,
            eofBytes: String(new TextEncoder().encode(structuredContent).length),
            permission: 'readable',
            exists: true,
            statusValues: {
              taskId,
              hostId,
              sequence: 1,
              hostBootId: key.hostBootId,
              pid: key.pid,
              startTicks: key.startTicks,
            },
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
          directWriterSourceIds: [sourceId],
          writerEvidenceComplete: true,
          evidenceComplete: true,
          interpreterFlags: [],
          writerSourceEvidence: {
            [sourceId]: { fileIdentity, eofBytes },
          },
        }],
      };
    }

    function lifecycleInput(
      at: string,
      eofBytes: string,
      epoch: string,
      key: ProcessKey = mainKey
    ) {
      const text = '80106/169999 [05:20<05:00, 2.50it/s]';
      return {
        task: lifecycleTask,
        taskId,
        hostId,
        observerEpoch: epoch,
        observedAt: at,
        taskObservation: lifecycleObservation(at, eofBytes, key),
        outputSamples: {
          [sourceId]: {
            sourceId,
            generation: gen,
            fileIdentity,
            startOffset: '0',
            endOffset: String(new TextEncoder().encode(text).length),
            observedAt: at,
            text,
          },
        },
        sourceInfo: {
          [sourceId]: { generation: gen, eofBytes, fileIdentity },
          'status-json': {
            generation: 'status-gen',
            eofBytes: String(new TextEncoder().encode(structuredContent).length),
            fileIdentity: statusIdentity,
          },
        },
      };
    }

    function withBaseline() {
      let state = updateBindings(createInitialBindingState(), lifecycleInput(openingAt, '1000', 'epoch-baseline'));
      state = ingestStructuredBaselineRead(state, lifecycleTask, lifecycleObservation(openingAt, '1000'), {
        evidenceId: 'baseline-original',
        sourceId: 'status-json',
        generation: 'status-gen',
        fileIdentity: statusIdentity,
        observedAt: openingAt,
        startOffset: '0',
        endOffset: String(new TextEncoder().encode(structuredContent).length),
        rawContent: structuredContent,
      });
      return state;
    }

    function projectionFor(state: ReturnType<typeof createInitialBindingState>, at: string) {
      return deriveProgress({
        taskId,
        hostId,
        observedAt: at,
        freshness: 'fresh',
        algorithm: 'flow',
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [],
        boundEvents: [],
        bindingState: state,
      });
    }

    it('retains one validated baseline through several ordinary polls without renewing its original time', () => {
      const baseline = withBaseline();
      expect(baseline.baselineRead).toMatchObject({
        evidenceId: 'baseline-original',
        observedAt: openingAt,
      });

      let state = baseline;
      for (const [index, at] of [
        '2026-10-20T00:00:02.000Z',
        '2026-10-20T00:00:04.000Z',
        '2026-10-20T00:00:06.000Z',
      ].entries()) {
        state = updateBindings(state, lifecycleInput(at, String(1000 + (index + 1) * 1000), 'epoch-baseline'));
        expect(state.baselineRead?.evidenceId).toBe('baseline-original');
        expect(state.baselineRead?.observedAt).toBe(openingAt);
      }

      const eventAt = '2026-10-20T00:00:06.000Z';
      const ingested = ingestCompleteRecord({
        ...boundEvent,
        eventId: 'baseline-retention-record',
        startOffset: '1000',
        endOffset: '3000',
        ingestedAt: eventAt,
        text: '80106/169999 [05:20<05:00, 2.50it/s]',
      }, state);
      expect(ingested.event.runId).toBe(runId);
      const progress = projectionFor(ingested.state, eventAt);
      expect(progress).toMatchObject({
        runId,
        baselineEvidenceId: 'baseline-original',
        resumeCheckpointIndex: 30000,
        firstLoopIndex: 30001,
        lastStepIndex: 110106,
        global: { completedCount: 110107, targetCount: 200000, verified: true },
        session: { completedCount: 80106, targetCount: 169999, verified: true },
      });
    });

    it('retains historical baseline through a conservative observation failure and clears it for a new strong run', () => {
      const baseline = withBaseline();
      const failedObservation = lifecycleObservation('2026-10-20T00:00:02.000Z', '2000');
      failedObservation.freshness = 'stale';
      const failed = updateBindings(baseline, {
        ...lifecycleInput('2026-10-20T00:00:02.000Z', '2000', 'epoch-baseline'),
        taskObservation: failedObservation,
      });
      expect(failed.baselineRead).toMatchObject({
        evidenceId: 'baseline-original',
        observedAt: openingAt,
      });
      expect(failed.activeRunId).toBe(runId);

      const nextKey: ProcessKey = {
        hostBootId: 'boot-2',
        pid: mainKey.pid,
        startTicks: '99999',
      };
      const nextRunId = makeRunId(hostId, taskId, nextKey);
      const newRun = updateBindings(failed, lifecycleInput(
        '2026-10-20T00:00:04.000Z',
        '3000',
        'epoch-new-run',
        nextKey
      ));
      expect(newRun.activeRunId).toBe(nextRunId);
      expect(newRun.baselineRead).toBeNull();
      expect(newRun.completeRecords).toEqual([]);
      expect(newRun.polls?.every((poll) => poll.runId === nextRunId)).toBe(true);
      const progress = deriveProgress({
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:04.000Z',
        freshness: 'fresh',
        algorithm: 'flow',
        currentRun: { runId: nextRunId, mainProcessKey: nextKey },
        bindings: [],
        boundEvents: [],
        bindingState: newRun,
      });
      expect(progress.runId).toBeNull();
      expect(progress.baselineEvidenceId).toBeNull();
      expect(progress.lastStepIndex).toBeNull();
      expect(progress.global.completedCount).toBeNull();
      expect(progress.session.completedCount).toBeNull();
      expect(progress.iterationsPerSecond).toBeNull();
      expect(progress.etaSeconds).toBeNull();
    });

    it('clears current baseline authority on incompatible registration and contradictory baseline evidence', () => {
      const baseline = withBaseline();
      const changedTask = {
        ...lifecycleTask,
        sources: [
          ...lifecycleTask.sources,
          { sourceId: 'extra-log', path: '/training/extra.log', kind: 'log' as const },
        ],
      };
      const changed = updateBindings(baseline, {
        ...lifecycleInput('2026-10-20T00:00:02.000Z', '2000', 'epoch-baseline'),
        task: changedTask,
        taskObservation: {
          ...lifecycleObservation('2026-10-20T00:00:02.000Z', '2000'),
          sources: [
            ...lifecycleObservation('2026-10-20T00:00:02.000Z', '2000').sources,
            {
              sourceId: 'extra-log',
              observedAt: '2026-10-20T00:00:02.000Z',
              fileIdentity: { dev: '12', inode: '22' },
              eofBytes: '0',
              permission: 'readable',
              exists: true,
              statusValues: null,
              heldByRegisteredProcess: null,
              errorCode: null,
              evidenceComplete: true,
              phase: null,
            },
          ],
          processes: [{
            ...lifecycleObservation('2026-10-20T00:00:02.000Z', '2000').processes[0],
            directWriterSourceIds: [sourceId, 'extra-log'],
            writerSourceEvidence: {
              [sourceId]: { fileIdentity, eofBytes: '2000' },
              'extra-log': { fileIdentity: { dev: '12', inode: '22' }, eofBytes: '0' },
            },
          }],
        },
        outputSamples: {
          ...lifecycleInput('2026-10-20T00:00:02.000Z', '2000', 'epoch-baseline').outputSamples,
          'extra-log': {
            sourceId: 'extra-log',
            generation: 'extra-gen',
            fileIdentity: { dev: '12', inode: '22' },
            startOffset: '0',
            endOffset: '1',
            observedAt: '2026-10-20T00:00:02.000Z',
            text: '80106/169999 [05:20<05:00, 2.50it/s]',
          },
        },
        sourceInfo: {
          ...lifecycleInput('2026-10-20T00:00:02.000Z', '2000', 'epoch-baseline').sourceInfo,
          'extra-log': { generation: 'extra-gen', eofBytes: '0', fileIdentity: { dev: '12', inode: '22' } },
        },
      });
      expect(changed.baselineRead).toBeNull();

      const contradictoryContent = JSON.stringify({
        ...JSON.parse(structuredContent),
        resume_checkpoint_index: 30001,
      });
      const contradictory = ingestStructuredBaselineRead(baseline, lifecycleTask, lifecycleObservation(openingAt, '1000'), {
        evidenceId: 'baseline-contradictory',
        sourceId: 'status-json',
        generation: 'status-gen',
        fileIdentity: statusIdentity,
        observedAt: openingAt,
        startOffset: '0',
        endOffset: String(new TextEncoder().encode(contradictoryContent).length),
        rawContent: contradictoryContent,
      });
      expect(contradictory.baselineRead).toBeNull();
    });
  });

  it('derives speed and ETA only from at least two advancing fresh samples in the same window', () => {
    const evidence: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: '2026-10-20T00:00:20.000Z',
      freshness: 'fresh',
      algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [binding1],
      boundEvents: [boundEvent],
      baselineEvidence: {
        evidenceId: 'base-1',
        taskId,
        hostId,
        runId,
        mainProcessKey: mainKey,
        sourceId,
        generation: gen,
        observedAt: '2026-10-20T00:00:00.000Z',
        resumeCheckpointIndex: 30000,
        rawContent: JSON.stringify({ resume_checkpoint_index: 30000, total_steps: 200000, target_meaning: 'exclusive_index' }),
        provenance: { sourceKind: 'config', profile: 'flow_v1' },
      },
      configuredTarget: { value: 200000, meaning: 'exclusive_index' },
      rateSamples: [
        { observedAt: '2026-10-20T00:00:10.000Z', completedCount: 80000, runId, windowId: 'win-1', bindingId: 'b-1', sourceId, generation: gen, startOffset: '1000', endOffset: '1500' },
        { observedAt: '2026-10-20T00:00:20.000Z', completedCount: 80100, runId, windowId: 'win-1', bindingId: 'b-1', sourceId, generation: gen, startOffset: '1500', endOffset: '2000' },
      ],
    };

    const progress = deriveProgress(evidence);
    // 100 iterations in 10 seconds = 10 it/s
    expect(progress.iterationsPerSecond).toBeNull();
    expect(progress.etaSeconds).toBeNull();
    // Caller-provided window labels/counts without an actual window/event reference are not measurements.
    // Remaining global = 200000 - 110107 = 89893 -> at 10 it/s => 8989s
    expect(progress.etaSeconds).toBeNull();
  });

  describe("Group B fixes: I-06, I-07, I-08, I-09", () => {
    it("T5-I-06: deriveProgress clears runId and resets if previous progress bindingId is not in valid bindings", () => {
      const priorProgress = {
        observedAt: "2026-10-20T00:00:00.000Z",
        freshness: "fresh" as const,
        runId,
        lastStepIndex: 110106,
        bindingIds: ["b-prior-missing"],
        baselineEvidenceId: "base-1",
        resumeCheckpointIndex: 30000,
        firstLoopIndex: 30001,
        global: { completedCount: 110107, targetCount: 200000, fraction: 0.550535, unit: "completed_iterations" as const, verified: true, sourceId },
        session: { completedCount: 80106, targetCount: 169999, fraction: 0.471214, unit: "completed_iterations" as const, verified: true, sourceId },
        configuredTarget: { value: 200000, meaning: "exclusive_index" as const },
        iterationsPerSecond: 2.5,
        etaSeconds: 35957,
      };

      const evidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:10:00.000Z",
        freshness: "stale",
        algorithm: "flow",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1], // binding1 has id "b-1", not "b-prior-missing"
        boundEvents: [],
      };

      const res = deriveProgress(evidence);
      expect(res.runId).toBeNull();
      expect(res.global.completedCount).toBeNull();
      expect(res.bindingIds).toHaveLength(0);
    });

    it("T5-I-07: rejects bare boolean baselineEvidence without typed startup evidence and requires exclusive_index target", () => {
      // Bare boolean baseline with no typed evidence
      const bareBooleanEvidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:05.000Z",
        freshness: "fresh",
        algorithm: "flow",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        baselineEvidence: {
          evidenceId: "base-unproven",
          runId,
          resumeCheckpointIndex: 30000,
          verified: true, // bare boolean
          source: "status_record",
        },
        configuredTarget: { value: 200000, meaning: "exclusive_index" },
      };

      const res1 = deriveProgress(bareBooleanEvidence);
      expect(res1.global.completedCount).toBeNull();
      expect(res1.global.verified).toBe(false);

      // Typed baseline evidence, but target meaning is "count" instead of "exclusive_index"
      const typedBaseline = {
        evidenceId: "base-typed-1",
        runId,
        resumeCheckpointIndex: 30000,
        sourceId: "log",
        generation: gen,
        observedAt: "2026-10-20T00:00:00.000Z",
        kind: "verified_config_startup" as const,
        profile: "flow_v1" as const,
      };

      const countTargetEvidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:05.000Z",
        freshness: "fresh",
        algorithm: "flow",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        baselineEvidence: typedBaseline,
        configuredTarget: { value: 169999, meaning: "count" }, // invalid target meaning
      };

      const res2 = deriveProgress(countTargetEvidence);
      expect(res2.global.completedCount).toBeNull();
      expect(res2.global.verified).toBe(false);
    });

    it("T5-I-08: Score and Reflow keep real-time session counts null and unit unknown", () => {
      const scoreEvent: LogEvent = {
        ...boundEvent,
        text: "step: 1000",
      };
      const scoreEvidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:05.000Z",
        freshness: "fresh",
        algorithm: "score",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [scoreEvent],
        configuredTarget: { value: 10000, meaning: "exclusive_index" },
      };

      const res = deriveProgress(scoreEvidence);
      expect(res.session.completedCount).toBeNull();
      expect(res.session.targetCount).toBeNull();
      expect(res.session.fraction).toBeNull();
      expect(res.session.unit).toBe("unknown");
    });

    it("T5-I-09: rate/ETA derivation requires explicit matching windowId, TTL freshness, and advancing counts", () => {
      // Missing windowId rejected
      const noWindowEvidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:20.000Z",
        freshness: "fresh",
        algorithm: "flow",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        rateSamples: [
          { observedAt: "2026-10-20T00:00:10.000Z", completedCount: 80000, runId }, // missing windowId
          { observedAt: "2026-10-20T00:00:20.000Z", completedCount: 80100, runId }, // missing windowId
        ],
      };
      const res1 = deriveProgress(noWindowEvidence);
      expect(res1.iterationsPerSecond).toBeNull();
      expect(res1.etaSeconds).toBeNull();
    });

    it("T5-I-09: orders bound events deterministically by offset so out-of-order ingestion does not regress progress", () => {
      // Out-of-order events: pass earlier event last in array, verify latest offset is used
      const evEarly: LogEvent = {
        ...boundEvent,
        eventId: "ev-early",
        startOffset: "1200",
        endOffset: "1400",
        text: "80050/169999 [05:00<05:20, 2.50it/s]",
      };
      const evLate: LogEvent = {
        ...boundEvent,
        eventId: "ev-late",
        startOffset: "1500",
        endOffset: "2000",
        text: "80106/169999 [05:20<05:00, 2.50it/s]",
      };

      const outOfOrderEvidence: ProgressEvidence = canonicalFlowEvidence([evLate, evEarly]); // evEarly placed last in array
      const res2 = deriveProgress(outOfOrderEvidence);
      expect(res2.session.completedCount).toBe(80106); // should be from evLate, not evEarly
    });

    it("T5-I-09: recomputes progress correctly when one binding is revoked but another valid bound event remains", () => {
      const ev1: LogEvent = {
        ...boundEvent,
        eventId: "ev-source-one",
        bindingId: "b-1",
        startOffset: "2000",
        endOffset: "2500",
        text: "80050/169999 [05:00<05:20, 2.50it/s]",
      };
      const ev2: LogEvent = {
        ...boundEvent,
        eventId: "ev-source-two",
        sourceId: "other-log",
        generation: "gen-2",
        bindingId: "b-2",
        startOffset: "6000",
        endOffset: "6500",
        text: "80100/169999 [05:20<05:00, 2.50it/s]",
      };

      const partialRevocationEvidence: ProgressEvidence = canonicalFlowEvidence([ev1, ev2], [ev2.sourceId]); // second source revoked; first remains
      expect(partialRevocationEvidence.bindingState!.completeRecords).toHaveLength(2);
      expect(partialRevocationEvidence.bindingState!.bindings).toHaveLength(2);
      expect(partialRevocationEvidence.bindingState!.revokedBindingIds).toHaveLength(1);

      const res = deriveProgress(partialRevocationEvidence);
      expect(res.session.completedCount).toBe(80050); // recalculated from remaining ev1
      expect(res.bindingIds).toEqual([partialRevocationEvidence.bindingState!.bindings.find((binding) => binding.sourceId === sourceId)!.bindingId]);
    });

    it("T5-N-01: handles malformed event offset (e.g. 12x) without throwing SyntaxError and isolates invalid record", () => {
      const malformedEvent: LogEvent = {
        ...boundEvent,
        eventId: "ev-malformed",
        startOffset: "12x",
        endOffset: "1000",
        text: "80100/169999 [05:20<05:00, 2.50it/s]",
      };
      const validEvent: LogEvent = {
        ...boundEvent,
        eventId: "ev-valid",
        startOffset: "1500",
        endOffset: "2000",
        text: "80106/169999 [05:20<05:00, 2.50it/s]",
      };

      const evidenceWithMalformed: ProgressEvidence = canonicalFlowEvidence([malformedEvent, validEvent]);

      // Must not throw SyntaxError when parsing offsets
      let res: any;
      expect(() => {
        res = deriveProgress(evidenceWithMalformed);
      }).not.toThrow();
      expect(res.session.completedCount).toBe(80106);

      // If ONLY malformed event exists, it safely yields empty/null progress
      const onlyMalformedEvidence: ProgressEvidence = {
        ...canonicalFlowEvidence([malformedEvent]),
      };
      const resOnlyMalformed = deriveProgress(onlyMalformedEvidence);
      expect(resOnlyMalformed.session.completedCount).toBeNull();
      expect(resOnlyMalformed.runId).toBeNull();
    });

    it("T5-I-07 fix-4: baseline requires explicit target semantics and content target agreement", () => {
      expect(parseBaselineStartupContent('{"resume_checkpoint_index":30,"target_count":200}')).toBeNull();
      expect(parseBaselineStartupContent('resume_checkpoint_index=30\ntarget_count=200')).toBeNull();
      expect(parseBaselineStartupContent('{"resume_checkpoint_index":30,"target_count":200,"target_meaning":"count"}')?.targetMeaning).toBe('count');
    });
    it("T5-I-07: rejects bare source string verified_config_startup without typed evidence chain and process key linkage", () => {
      // Bare source string without required typed provenance and process key linkage
      const bareBaseline: any = {
        evidenceId: "base-bare",
        runId,
        resumeCheckpointIndex: 30000,
        source: "verified_config_startup",
      };

      const evidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:10.000Z",
        freshness: "fresh",
        algorithm: "flow",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        baselineEvidence: bareBaseline,
        configuredTarget: { value: 200000, meaning: "exclusive_index" },
      };

      const res = deriveProgress(evidence);
      expect(res.global.verified).toBe(false);
      expect(res.global.completedCount).toBeNull();
      expect(res.global.fraction).toBeNull();

      // Negative: mismatched process key in baseline
      const mismatchedKeyBaseline: any = {
        evidenceId: "base-mismatched",
        taskId,
        hostId,
        runId,
        mainProcessKey: { hostBootId: "boot-other", pid: 9999, startTicks: "99999" },
        sourceId: "source-log-1",
        observedAt: "2026-10-20T00:00:00.000Z",
        resumeCheckpointIndex: 30000,
        provenance: { sourceKind: "config", profile: "flow_v1" },
      };
      const resMismatched = deriveProgress({ ...evidence, baselineEvidence: mismatchedKeyBaseline });
      expect(resMismatched.global.verified).toBe(false);
      expect(resMismatched.global.completedCount).toBeNull();

      // Negative: negative resumeCheckpointIndex
      const negativeIndexBaseline: any = {
        evidenceId: "base-neg",
        taskId,
        hostId,
        runId,
        mainProcessKey: mainKey,
        sourceId: "source-log-1",
        observedAt: "2026-10-20T00:00:00.000Z",
        resumeCheckpointIndex: -10,
        provenance: { sourceKind: "config", profile: "flow_v1" },
      };
      const resNeg = deriveProgress({ ...evidence, baselineEvidence: negativeIndexBaseline });
      expect(resNeg.global.verified).toBe(false);
      expect(resNeg.global.completedCount).toBeNull();
    });

    it("T5-I-09: rate/ETA requires sample bindingId in valid bindings, observation age within TTL, positive advancing counts, and is null for score/reflow or stale progress", () => {
      // 1. Score algorithm keeps rate/ETA null even if samples provided
      const scoreRateEvidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:20.000Z",
        freshness: "fresh",
        algorithm: "score",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        rateSamples: [
          { observedAt: "2026-10-20T00:00:10.000Z", completedCount: 100, runId, windowId: "win-1", bindingId: "b-1", sourceId, generation: gen, startOffset: "1000", endOffset: "1500" },
          { observedAt: "2026-10-20T00:00:20.000Z", completedCount: 150, runId, windowId: "win-1", bindingId: "b-1", sourceId, generation: gen, startOffset: "1500", endOffset: "2000" },
        ],
      };
      const resScore = deriveProgress(scoreRateEvidence);
      expect(resScore.iterationsPerSecond).toBeNull();
      expect(resScore.etaSeconds).toBeNull();

      // 2. Stale progress clears rate/ETA
      const staleEvidence: ProgressEvidence = {
        ...scoreRateEvidence,
        algorithm: "flow",
        freshness: "stale",
      };
      const resStale = deriveProgress(staleEvidence);
      expect(resStale.iterationsPerSecond).toBeNull();
      expect(resStale.etaSeconds).toBeNull();

      // 3. Sample bindingId not in valid bindings clears rate
      const invalidBindingSampleEvidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:20.000Z",
        freshness: "fresh",
        algorithm: "flow",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        rateSamples: [
          { observedAt: "2026-10-20T00:00:10.000Z", completedCount: 80000, runId, windowId: "win-1", bindingId: "b-nonexistent" },
          { observedAt: "2026-10-20T00:00:20.000Z", completedCount: 80100, runId, windowId: "win-1", bindingId: "b-1" },
        ],
      };
      const resInvalidBinding = deriveProgress(invalidBindingSampleEvidence);
      expect(resInvalidBinding.iterationsPerSecond).toBeNull();

      // 4. Stale sample (>30s old vs observedAt) clears rate
      const staleSampleEvidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:01:00.000Z", // 60s
        freshness: "fresh",
        algorithm: "flow",
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        rateSamples: [
          { observedAt: "2026-10-20T00:00:00.000Z", completedCount: 80000, runId, windowId: "win-1", bindingId: "b-1", sourceId, generation: gen, startOffset: "1000", endOffset: "1500" }, // 60s old > 30s TTL
          { observedAt: "2026-10-20T00:00:50.000Z", completedCount: 80100, runId, windowId: "win-1", bindingId: "b-1", sourceId, generation: gen, startOffset: "1500", endOffset: "2000" },
        ],
      };
      const resStaleSample = deriveProgress(staleSampleEvidence);
      expect(resStaleSample.iterationsPerSecond).toBeNull();
    });

    it('T5-I-06 (fix-3): deriveProgress rejects bound event whose byte range falls outside the binding fromOffset..throughOffset interval', () => {
      const outOfBoundsEvent: LogEvent = {
        ...boundEvent,
        eventId: 'ev-out-of-bounds',
        startOffset: '6000', // binding1 is 1000..5000
        endOffset: '7000',
        text: '80106/169999 [05:20<05:00, 2.50it/s]',
      };

      const evidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:20.000Z',
        freshness: 'fresh',
        algorithm: 'flow',
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1], // 1000..5000
        boundEvents: [outOfBoundsEvent],
      };

      const res = deriveProgress(evidence);
      expect(res.session.completedCount).toBeNull();
      expect(res.bindingIds).toHaveLength(0);
    });

    it('T5-I-07 (fix-3): deriveProgress rejects baseline evidence without concrete rawContent agreeing with resumeCheckpointIndex and target', () => {
      const profileOnlyBaseline: FlowBaselineEvidence = {
        evidenceId: 'base-profile-only',
        runId,
        resumeCheckpointIndex: 30000,
        provenance: { profile: 'flow_v1', sourceKind: 'config' },
      };

      const evidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:05.000Z',
        freshness: 'fresh',
        algorithm: 'flow',
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        baselineEvidence: profileOnlyBaseline,
        configuredTarget: { value: 200000, meaning: 'exclusive_index' },
      };

      const res = deriveProgress(evidence);
      expect(res.global.verified).toBe(false);
      expect(res.global.completedCount).toBeNull();
      expect(res.baselineEvidenceId).toBeNull();
    });

    it('T5-I-09 (fix-3): deriveProgress rejects rate samples sharing arbitrary windowId string without binding, source, generation and offset provenance', () => {
      const arbitraryWindowEvidence: ProgressEvidence = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:20.000Z',
        freshness: 'fresh',
        algorithm: 'flow',
        currentRun: { runId, mainProcessKey: mainKey },
        bindings: [binding1],
        boundEvents: [boundEvent],
        rateSamples: [
          { observedAt: '2026-10-20T00:00:10.000Z', completedCount: 100, runId, windowId: 'arbitrary-win' },
          { observedAt: '2026-10-20T00:00:20.000Z', completedCount: 150, runId, windowId: 'arbitrary-win' },
        ],
      };

      const res = deriveProgress(arbitraryWindowEvidence);
      expect(res.iterationsPerSecond).toBeNull();
      expect(res.etaSeconds).toBeNull();
    });
  });

});


describe('T6-A historical baseline support', () => {
  const hostId = 'lab-campus';
  const taskId = 'flow-baseline-support';
  const logSourceId = 'main-log';
  const statusSourceId = 'status-json';
  const logGeneration = 'log-gen-1';
  const statusGeneration = 'status-gen-1';
  const logIdentity = { dev: '10', inode: '20' };
  const statusIdentity = { dev: '30', inode: '40' };
  const mainKey: ProcessKey = { hostBootId: 'boot-1', pid: 4321, startTicks: '98765' };
  const runId = makeRunId(hostId, taskId, mainKey);
  const openingAt = '2026-10-21T00:00:00.000Z';
  const eventAt = '2026-10-21T00:00:01.000Z';
  const reopenAt = '2026-10-21T00:00:10.000Z';
  const nextAt = '2026-10-21T00:00:11.000Z';
  const flowText = '80106/169999 [05:20<05:00, 2.50it/s]';
  const statusContent = JSON.stringify({
    taskId,
    hostId,
    hostBootId: mainKey.hostBootId,
    pid: mainKey.pid,
    startTicks: mainKey.startTicks,
    sequence: 1,
    resume_checkpoint_index: 30000,
    total_steps: 200000,
    target_meaning: 'exclusive_index',
  });
  const statusEof = String(new TextEncoder().encode(statusContent).length);

  const task: TaskRegistration = {
    taskId,
    hostId,
    label: 'Baseline support fixture',
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

  function observation(at: string, logEof: string): TaskObservation {
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
          observedAt: openingAt,
          fileIdentity: statusIdentity,
          eofBytes: statusEof,
          permission: 'readable',
          exists: true,
          statusValues: {
            taskId,
            hostId,
            hostBootId: mainKey.hostBootId,
            pid: mainKey.pid,
            startTicks: mainKey.startTicks,
            sequence: 1,
          },
          heldByRegisteredProcess: null,
          errorCode: null,
          evidenceComplete: true,
          phase: null,
        },
      ],
      processes: [{
        key: mainKey,
        role: 'trainer',
        cwd: '/training',
        scriptEntry: '/training/train.py',
        observedAt: at,
        roleEvidence: 'exact_entry_and_direct_writer_fd',
        directWriterSourceIds: [logSourceId],
        writerSourceEvidence: { [logSourceId]: { fileIdentity: logIdentity, eofBytes: logEof } },
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      }],
    };
  }

  function outputSamples(at: string) {
    return {
      [logSourceId]: {
        sourceId: logSourceId,
        generation: logGeneration,
        fileIdentity: logIdentity,
        startOffset: '0',
        endOffset: String(new TextEncoder().encode(flowText).length),
        observedAt: at,
        text: flowText,
      },
    };
  }

  function sourceInfo(logEof: string, statusGen = statusGeneration) {
    return {
      [logSourceId]: { generation: logGeneration, eofBytes: logEof, fileIdentity: logIdentity },
      [statusSourceId]: { generation: statusGen, eofBytes: statusEof, fileIdentity: statusIdentity },
    };
  }

  function update(
    state: BindingState,
    at: string,
    logEof: string,
    epoch: string,
    statusGen = statusGeneration,
  ): BindingState {
    return updateBindings(state, {
      task,
      taskId,
      hostId,
      observerEpoch: epoch,
      observedAt: at,
      taskObservation: observation(at, logEof),
      sourceInfo: sourceInfo(logEof, statusGen),
      outputSamples: outputSamples(at),
    });
  }

  function event(eventId: string, start: string, end: string, at: string): LogEvent {
    return {
      version: 1,
      eventId,
      taskId,
      sourceId: logSourceId,
      generation: logGeneration,
      kind: 'line',
      startOffset: start,
      endOffset: end,
      ingestedAt: at,
      text: flowText,
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    };
  }

  function withBaseline(): BindingState {
    let state = update(createInitialBindingState(), openingAt, '5000', 'epoch-1');
    state = update(state, eventAt, '5200', 'epoch-1');
    state = ingestCompleteRecord(event('baseline-support-record', '5000', '5200', eventAt), state).state;
    state = ingestStructuredBaselineRead(state, task, observation(openingAt, '5000'), {
      evidenceId: 'baseline-support',
      sourceId: statusSourceId,
      generation: statusGeneration,
      fileIdentity: statusIdentity,
      observedAt: openingAt,
      startOffset: '0',
      endOffset: statusEof,
      rawContent: statusContent,
    });
    expect(state.baselineRead).toMatchObject({
      evidenceId: 'baseline-support',
      observedAt: openingAt,
    });
    return state;
  }

  function projectionFor(state: BindingState, at: string): ReturnType<typeof deriveProgress> {
    const input: ProgressEvidence = {
      taskId,
      hostId,
      observedAt: at,
      freshness: 'fresh',
      algorithm: 'flow',
      currentRun: { runId, mainProcessKey: mainKey },
      bindings: [],
      boundEvents: [],
      bindingState: state,
    };
    return deriveProgress(input);
  }

  function rehydrate(state: BindingState): BindingState {
    return JSON.parse(JSON.stringify(state)) as BindingState;
  }

  it('retains baseline authority through JSON rehydration, polls, interruption, generation change and cursor eviction', () => {
    let state = withBaseline();
    expect(state.baselineRead).toHaveProperty('support');

    state = rehydrate(state);
    state = update(state, '2026-10-21T00:00:02.000Z', '5300', 'epoch-1');
    state = update(state, '2026-10-21T00:00:03.000Z', '5400', 'epoch-1', 'status-gen-2');
    state = interruptBindingObservation(state);
    state = { ...state, sourceCursors: [] };

    const progress = projectionFor(state, '2026-10-21T00:00:04.000Z');
    expect(progress).toMatchObject({
      observedAt: eventAt,
      runId,
      baselineEvidenceId: 'baseline-support',
      resumeCheckpointIndex: 30000,
      firstLoopIndex: 30001,
      lastStepIndex: 110106,
      global: { completedCount: 110107, targetCount: 200000, verified: true },
      session: { completedCount: 80106, targetCount: 169999, verified: true },
      iterationsPerSecond: null,
      etaSeconds: null,
    });
  });

  const supportMutations: Array<{
    name: string;
    mutate: (baseline: any) => void;
  }> = [
    { name: 'missing support', mutate: (baseline) => { delete baseline.support; } },
    { name: 'null support', mutate: (baseline) => { baseline.support = null; } },
    { name: 'empty support object', mutate: (baseline) => { baseline.support = {}; } },
    { name: 'missing source support', mutate: (baseline) => { delete baseline.support.source; } },
    { name: 'missing cursor support', mutate: (baseline) => { delete baseline.support.cursor; } },
    { name: 'missing status support', mutate: (baseline) => { delete baseline.support.status; } },
    { name: 'unsupported support version', mutate: (baseline) => { baseline.support.version = 2; } },
    { name: 'raw byte length mismatch', mutate: (baseline) => { baseline.rawContent += 'x'; } },
    { name: 'range shorter than raw bytes', mutate: (baseline) => { baseline.endOffset = String(Number(baseline.endOffset) - 1); } },
    { name: 'empty baseline identity', mutate: (baseline) => { baseline.fileIdentity.dev = ''; } },
    { name: 'empty source identity', mutate: (baseline) => { baseline.support.source.fileIdentity.inode = ''; } },
    { name: 'empty cursor identity', mutate: (baseline) => { baseline.support.cursor.fileIdentity.dev = ''; } },
    { name: 'normalized resume mismatch', mutate: (baseline) => { baseline.resumeCheckpointIndex = 30001; } },
    { name: 'normalized target mismatch', mutate: (baseline) => { baseline.targetCount = 199999; } },
    { name: 'baseline task mismatch', mutate: (baseline) => { baseline.taskId = 'other-task'; } },
    { name: 'baseline host mismatch', mutate: (baseline) => { baseline.hostId = 'other-host'; } },
    { name: 'baseline source mismatch', mutate: (baseline) => { baseline.sourceId = logSourceId; } },
    { name: 'baseline run mismatch', mutate: (baseline) => { baseline.runId = 'other-run'; } },
    { name: 'baseline process key mismatch', mutate: (baseline) => { baseline.mainProcessKey.pid = 9999; } },
    { name: 'empty source generation', mutate: (baseline) => { baseline.support.source.generation = ''; } },
    { name: 'source EOF before baseline end', mutate: (baseline) => { baseline.support.source.eofBytes = '1'; } },
    { name: 'source and cursor EOF mismatch', mutate: (baseline) => { baseline.support.cursor.eofBytes = '2'; } },
    { name: 'status sequence mismatch', mutate: (baseline) => { baseline.support.status.sequence = 2; } },
    { name: 'status task mismatch', mutate: (baseline) => { baseline.support.status.taskId = 'other-task'; } },
    { name: 'status host mismatch', mutate: (baseline) => { baseline.support.status.hostId = 'other-host'; } },
    { name: 'status process key mismatch', mutate: (baseline) => { baseline.support.status.mainProcessKey.startTicks = '1'; } },
    { name: 'future baseline time', mutate: (baseline) => { baseline.observedAt = '2099-01-01T00:00:00.000Z'; } },
    { name: 'future source support time', mutate: (baseline) => { baseline.support.source.observedAt = '2099-01-01T00:00:00.000Z'; } },
    {
      name: 'embedded sequence mismatch',
      mutate: (baseline) => {
        const record = JSON.parse(baseline.rawContent);
        record.sequence = 2;
        baseline.rawContent = JSON.stringify(record);
        baseline.endOffset = String(new TextEncoder().encode(baseline.rawContent).length);
        baseline.support.source.eofBytes = baseline.endOffset;
        baseline.support.cursor.eofBytes = baseline.endOffset;
      },
    },
    {
      name: 'embedded task mismatch',
      mutate: (baseline) => {
        const record = JSON.parse(baseline.rawContent);
        record.taskId = 'other-task';
        baseline.rawContent = JSON.stringify(record);
        baseline.endOffset = String(new TextEncoder().encode(baseline.rawContent).length);
        baseline.support.source.eofBytes = baseline.endOffset;
        baseline.support.cursor.eofBytes = baseline.endOffset;
      },
    },
  ];

  it.each(supportMutations)(
    'rejects $name without throwing or discarding session history',
    ({ mutate }) => {
      const valid = rehydrate(withBaseline());
      const baseline = JSON.parse(JSON.stringify(valid.baselineRead));
      mutate(baseline);
      const state = { ...valid, baselineRead: baseline };
      let progress: ReturnType<typeof deriveProgress> | null = null;
      expect(() => {
        progress = projectionFor(state, '2026-10-21T00:00:04.000Z');
      }).not.toThrow();
      expect(progress!.baselineEvidenceId).toBeNull();
      expect(progress!.lastStepIndex).toBeNull();
      expect(progress!.global.completedCount).toBeNull();
      expect(progress!.session.completedCount).toBe(80106);
      expect(state.completeRecords).toHaveLength(1);
      expect(state.bindings).toHaveLength(1);
    },
  );

  it('does not repair support from current metadata after it is absent', () => {
    const state = rehydrate(withBaseline());
    const withoutSupport = {
      ...state,
      baselineRead: { ...state.baselineRead!, support: undefined },
    };
    const polled = update(withoutSupport, nextAt, '5400', 'epoch-1');
    expect(polled.baselineRead?.evidenceId).toBe('baseline-support');
    const progress = projectionFor(polled, nextAt);
    expect(progress.baselineEvidenceId).toBeNull();
    expect(progress.global.completedCount).toBeNull();
    expect(progress.session.completedCount).toBe(80106);
  });
});

