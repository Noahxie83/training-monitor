import { describe, expect, it } from 'vitest';
import {
  bindCompleteRecord,
  createInitialBindingState,
  findSubstantiveTrainerProcess,
  resolveTaskPolicy,
  updateBindings,
} from '../../src/domain/bindings';
import { ingestStructuredBaselineRead } from '../../src/domain/evidence';
import { makeRunId } from '../../src/domain/identity';
import type { LogEvent, ProcessKey, TaskRegistration } from '../../src/shared/contracts';
import type { TaskObservation } from '../../src/transport/types';

describe('T6-A residual prerequisites', () => {
  const hostId = 'lab-campus';
  const taskId = 'flow-residual';
  const sourceId = 'main-log';
  const statusSourceId = 'status-json';
  const generation = 'log-gen-1';
  const observedAt = '2026-10-21T00:00:00.000Z';
  const fileIdentity = { dev: '10', inode: '20' };
  const statusIdentity = { dev: '30', inode: '40' };
  const mainKey: ProcessKey = { hostBootId: 'boot-1', pid: 4321, startTicks: '98765' };
  const runId = makeRunId(hostId, taskId, mainKey);
  const outputText = '80106/169999 [05:20<05:00, 2.50it/s]';
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
    label: 'Residual policy fixture',
    enabled: true,
    algorithm: 'flow',
    allowedDirectories: ['/training'],
    entryPaths: ['/training/train.py'],
    sources: [
      { sourceId, path: '/training/train.log', kind: 'log' },
      { sourceId: statusSourceId, path: '/training/status.json', kind: 'status_json' },
    ],
    checkpointDirectories: [],
  };

  function observation(at = observedAt, eofBytes = '1000'): TaskObservation {
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
          sourceId: statusSourceId,
          observedAt: at,
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
        directWriterSourceIds: [sourceId],
        writerSourceEvidence: { [sourceId]: { fileIdentity, eofBytes } },
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      }],
    };
  }

  function outputSamples(at = observedAt) {
    return {
      [sourceId]: {
        sourceId,
        generation,
        fileIdentity,
        startOffset: '0',
        endOffset: String(new TextEncoder().encode(outputText).length),
        observedAt: at,
        text: outputText,
      },
    };
  }

  function input(overrides: Record<string, unknown> = {}) {
    return {
      task,
      taskId,
      hostId,
      observerEpoch: 'epoch-1',
      observedAt,
      taskObservation: observation(),
      sourceInfo: {
        [sourceId]: { generation, eofBytes: '1000', fileIdentity },
        [statusSourceId]: { generation: 'status-gen-1', eofBytes: statusEof, fileIdentity: statusIdentity },
      },
      outputSamples: outputSamples(),
      ...overrides,
    };
  }

  function event(): LogEvent {
    return {
      version: 1,
      eventId: 'residual-event',
      taskId,
      sourceId,
      generation,
      kind: 'line',
      startOffset: '900',
      endOffset: '1000',
      ingestedAt: observedAt,
      text: outputText,
      reason: null,
      displayTruncated: false,
      recordComplete: true,
      prefixIncomplete: false,
      runId: null,
      bindingId: null,
    };
  }

  const malformedSources = [
    null,
    {},
    [null],
    [{ sourceId }],
    [{ kind: 'log' }],
  ];

  it.each(malformedSources)(
    'T5-F4-NEW-02 A: malformed task sources %j fail closed without throwing',
    (sources) => {
      const malformedTask = { ...task, sources } as unknown as TaskRegistration;
      const malformedInput = input({ task: malformedTask });
      const initial = createInitialBindingState();

      expect(() => resolveTaskPolicy(malformedInput as any, initial)).not.toThrow();
      expect(resolveTaskPolicy(malformedInput as any, initial)).toBeNull();
      expect(() => findSubstantiveTrainerProcess(
        malformedTask,
        observation(),
        Date.parse(observedAt),
        outputSamples(),
        input().sourceInfo,
      )).not.toThrow();
      expect(findSubstantiveTrainerProcess(
        malformedTask,
        observation(),
        Date.parse(observedAt),
        outputSamples(),
        input().sourceInfo,
      )).toBeNull();
      expect(() => updateBindings(initial, malformedInput as any)).not.toThrow();
      const updated = updateBindings(initial, malformedInput as any);
      expect(updated.activeRunId).toBeNull();
      expect(updated.activeMainKey).toBeNull();
      expect(updated.windows.filter((window) => window.isOpen)).toHaveLength(0);
      expect(updated.bindings).toHaveLength(0);
    },
  );

  it('T5-F4-NEW-02 A: malformed registered task sources cannot bind a complete record', () => {
    const valid = updateBindings(createInitialBindingState(), input() as any);
    const malformedState = {
      ...valid,
      registeredTask: { ...task, sources: null } as unknown as TaskRegistration,
    };

    let bound!: LogEvent;
    expect(() => {
      bound = bindCompleteRecord(event(), malformedState as any);
    }).not.toThrow();
    expect(bound?.runId).toBeNull();
    expect(bound?.bindingId).toBeNull();
  });

  it('T5-F4-NEW-02 A: baseline ingestion fails closed for malformed task, observation and read shapes', () => {
    const valid = updateBindings(createInitialBindingState(), input() as any);
    expect(valid.activeRunId).toBe(runId);
    const validRead = {
      evidenceId: 'baseline-residual',
      sourceId: statusSourceId,
      generation: 'status-gen-1',
      fileIdentity: statusIdentity,
      observedAt,
      startOffset: '0',
      endOffset: statusEof,
      rawContent: statusContent,
    };

    const cases: Array<[TaskRegistration, TaskObservation, unknown]> = [
      [{ ...task, sources: null } as unknown as TaskRegistration, observation(), validRead],
      [task, { ...observation(), sources: null } as unknown as TaskObservation, validRead],
      [task, observation(), null],
      [task, observation(), { ...validRead, fileIdentity: null }],
    ];

    for (const [candidateTask, candidateObservation, candidateRead] of cases) {
      expect(() => ingestStructuredBaselineRead(
        valid,
        candidateTask,
        candidateObservation,
        candidateRead as any,
      )).not.toThrow();
      expect(ingestStructuredBaselineRead(
        valid,
        candidateTask,
        candidateObservation,
        candidateRead as any,
      ).baselineRead).toBeNull();
    }
  });
});
