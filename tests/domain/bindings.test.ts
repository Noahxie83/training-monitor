import { describe, expect, it } from 'vitest';
import {
  bindCompleteRecord,
  createInitialBindingState,
  ingestCompleteRecord,
  isTimestampValid,
  revokeBindings,
  updateBindings as updateBindingsCore,
  findSubstantiveTrainerProcess,
} from '../../src/domain/bindings';
import { makeRunId } from '../../src/domain/identity';
import type { LogEvent, ProcessKey } from '../../src/shared/contracts';
import type { TaskObservation } from '../../src/transport/types';

describe('domain bindings and continuous writer windows', () => {
  const hostId = 'lab-campus';
  const taskId = 'flow-training';
  const sourceId = 'main-log';
  const generation = 'gen-uuid-1';
  const epoch1 = 'epoch-local-1';
  const fileIdentity = { dev: '100', inode: '200' };

  const mainKey: ProcessKey = {
    hostBootId: 'boot-1',
    pid: 4321,
    startTicks: '98765',
  };
  const expectedRunId = makeRunId(hostId, taskId, mainKey);
  const registeredTask = {
    taskId, hostId, label: taskId, enabled: true, algorithm: 'flow' as const,
    allowedDirectories: ['/data2/cy/xzn'], entryPaths: ['/data2/cy/xzn/train.py'],
    sources: [{ sourceId, path: '/data2/cy/xzn/train.log', kind: 'log' as const }],
    checkpointDirectories: [],
  };

  it('counts merged stdout/stderr as one process writing the registered log', () => {
    const observe = (eofBytes: string) => {
      const observation = makeObservation(eofBytes);
      observation.processes[0]!.directWriterSourceIds = [sourceId, sourceId];
      return { taskId, hostId, observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z', taskObservation: observation,
        sourceInfo: { [sourceId]: { generation, eofBytes, fileIdentity } } };
    };
    const opened = updateBindings(createInitialBindingState(), observe('1000'));
    const advanced = updateBindings(opened, observe('2000'));
    expect(advanced.windows.some((window) => window.isOpen)).toBe(true);
    expect(advanced.bindings.some((binding) => binding.throughOffset === '2000')).toBe(true);
    expect(advanced.revokedBindingIds).toEqual([]);
  });

  function updateBindings(state: ReturnType<typeof createInitialBindingState>, input: any) {
    const task = input.task ?? registeredTask;
    const sampleText = task.algorithm === 'score' ? '[score] step 100' : '80106/169999 [10:00<10:00, 1.5it/s]';
    const observedSource = input.taskObservation.sources.find((s: any) => s.sourceId === sourceId);
    const sourceState = input.sourceInfo?.[sourceId];
    const contentBytes = Buffer.byteLength(sampleText);
    const outputSamples = input.outputSamples ?? (observedSource && sourceState ? {
      [sourceId]: {
        sourceId,
        generation: sourceState.generation,
        fileIdentity: observedSource.fileIdentity,
        startOffset: '0',
        endOffset: String(contentBytes),
        observedAt: observedSource.observedAt,
        text: sampleText,
      },
    } : {});
    return updateBindingsCore(state, { ...input, task, outputSamples });
  }

  function makeObservation(
    eofBytes: string,
    opts: {
      directWriter?: boolean;
      scriptEntry?: string;
      roleEvidence?: 'exact_script_entry' | 'exact_entry_and_direct_writer_fd' | 'none';
      writerEvidenceComplete?: boolean;
      wrongFileIdentity?: boolean;
      observedAt?: string;
    } = {}
  ): TaskObservation {
    const directWriter = opts.directWriter !== false;
    const roleEvidence = opts.roleEvidence ?? 'exact_entry_and_direct_writer_fd';
    const fid = opts.wrongFileIdentity ? { dev: '999', inode: '999' } : fileIdentity;
    const obsAt = opts.observedAt ?? '2026-10-20T00:00:00.000Z';
    return {
      taskId,
      hostId,
      observedAt: obsAt,
      freshness: 'fresh',
      scanComplete: true,
      processScanError: null,
      phase: null,
      errorCode: null,
      sources: [
        {
          sourceId,
          observedAt: obsAt,
          fileIdentity: fid,
          eofBytes,
          permission: 'readable',
          exists: true,
          statusValues: null,
          heldByRegisteredProcess: null,
          errorCode: null,
          evidenceComplete: true,
          phase: null,
        },
      ],
      processes: [
        {
          key: mainKey,
          role: 'unknown',
          cwd: '/data2/cy/xzn',
          scriptEntry: opts.scriptEntry ?? '/data2/cy/xzn/train.py',
          observedAt: obsAt,
          roleEvidence,
          directWriterSourceIds: directWriter ? [sourceId] : [],
          writerEvidenceComplete: opts.writerEvidenceComplete !== false,
          evidenceComplete: true,
          interpreterFlags: [],
          writerSourceEvidence: directWriter ? { [sourceId]: { fileIdentity: fid, eofBytes } } : {},
        },
      ],
    };
  }

  function makeEvent(
    start: string,
    end: string,
    opts: {
      recordComplete?: boolean;
      prefixIncomplete?: boolean;
      kind?: LogEvent['kind'];
      text?: string;
      gen?: string;
    } = {}
  ): LogEvent {
    return {
      version: 1,
      eventId: `ev-${start}-${end}`,
      taskId,
      sourceId,
      generation: opts.gen ?? generation,
      kind: opts.kind ?? 'line',
      startOffset: start,
      endOffset: end,
      ingestedAt: '2026-10-20T00:00:05.000Z',
      text: opts.text ?? '80106/169999 [10:00<10:00, 1.5it/s]',
      reason: null,
      displayTruncated: false,
      recordComplete: opts.recordComplete !== false,
      prefixIncomplete: opts.prefixIncomplete === true,
      runId: null,
      bindingId: null,
    };
  }

  it('T5-I-03 fix-4: accepts only bounded output observations linked to registered source identity and generation', () => {
    const observation = makeObservation('5000');
    const sourceInfo = { [sourceId]: { generation, eofBytes: '5000', fileIdentity } };
    const sample = {
      sourceId, generation, fileIdentity, startOffset: '0', endOffset: String(Buffer.byteLength('80106/169999 [10:00<10:00, 1.5it/s]')),
      observedAt: '2026-10-20T00:00:00.000Z', text: '80106/169999 [10:00<10:00, 1.5it/s]',
    };
    const now = Date.parse('2026-10-20T00:00:00.000Z');

    expect(findSubstantiveTrainerProcess(registeredTask, observation, now, { [sourceId]: sample }, sourceInfo)).toBeTruthy();
    expect(findSubstantiveTrainerProcess(registeredTask, observation, now, { [sourceId]: sample.text } as any, sourceInfo)).toBeNull();
    expect(findSubstantiveTrainerProcess(registeredTask, observation, now, { [sourceId]: { ...sample, generation: 'other-generation' } }, sourceInfo)).toBeNull();
    expect(findSubstantiveTrainerProcess(registeredTask, observation, now, { [sourceId]: { ...sample, fileIdentity: { dev: 'wrong', inode: 'wrong' } } }, sourceInfo)).toBeNull();
    expect(findSubstantiveTrainerProcess(registeredTask, observation, now, { [sourceId]: { ...sample, observedAt: '2026-10-19T23:59:59.000Z' } }, sourceInfo)).toBeNull();
    expect(findSubstantiveTrainerProcess(registeredTask, observation, now, { [sourceId]: { ...sample, endOffset: '5001' } }, sourceInfo)).toBeNull();
    expect(findSubstantiveTrainerProcess(registeredTask, makeObservation('50'), now, { [sourceId]: sample }, sourceInfo)).toBeNull();
  });

  it('opens a continuous writer window starting at current observed EOF upon first detection', () => {
    const initial = createInitialBindingState();
    const obs1 = makeObservation('5000000');
    const state1 = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: obs1,
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
    });

    expect(state1.activeRunId).toBe(expectedRunId);
    expect(state1.windows).toHaveLength(1);
    expect(state1.windows[0]).toMatchObject({
      sourceId,
      generation,
      fromOffset: '5000000',
      throughOffset: '5000000',
      isOpen: true,
      runId: expectedRunId,
    });
  });

  it('associates committed records with the collection batch while retaining the source probe time', () => {
    const sourceObservedAt = '2026-10-20T00:00:00.000Z';
    const batchObservedAt = '2026-10-20T00:00:05.000Z';
    let state = updateBindings(createInitialBindingState(), {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: sourceObservedAt,
      taskObservation: makeObservation('1000', { observedAt: sourceObservedAt }),
      sourceInfo: { [sourceId]: { generation, eofBytes: '1000', fileIdentity } },
    });
    state = updateBindings(state, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: batchObservedAt,
      taskObservation: makeObservation('2000', { observedAt: sourceObservedAt }),
      sourceInfo: { [sourceId]: { generation, eofBytes: '2000', fileIdentity } },
    });

    expect(state.polls?.at(-1)).toMatchObject({ observedAt: batchObservedAt, sourceObservedAt });
    const record = {
      ...makeEvent('1000', '1050'),
      ingestedAt: batchObservedAt,
      text: '101/1000 [00:10<01:30, 10.0it/s]',
    };
    const ingested = ingestCompleteRecord(record, state);
    expect(ingested.event.runId).toBe(expectedRunId);
    expect(ingested.state.completeRecords).toContainEqual(expect.objectContaining({ eventId: record.eventId, runId: expectedRunId }));
  });

  it('requires the line terminator byte count to explain the recorded byte range', () => {
    const observation = makeObservation('5000');
    const sourceInfo = { [sourceId]: { generation, eofBytes: '5000', fileIdentity } };
    const text = '80106/169999 [10:00<10:00, 1.5it/s]';
    const sample = {
      sourceId, generation, fileIdentity, startOffset: '0',
      endOffset: String(Buffer.byteLength(text) + 1),
      terminatorBytes: 1 as const,
      observedAt: '2026-10-20T00:00:00.000Z', text,
    };
    const now = Date.parse('2026-10-20T00:00:00.000Z');

    expect(findSubstantiveTrainerProcess(registeredTask, observation, now, { [sourceId]: sample }, sourceInfo)).toBeTruthy();
    expect(findSubstantiveTrainerProcess(registeredTask, observation, now, {
      [sourceId]: { ...sample, terminatorBytes: 0 },
    }, sourceInfo)).toBeNull();
  });

  it('r2-handoff-5: does not retroactively bind initial unassociated history fetched after window opened', () => {
    const initial = createInitialBindingState();
    // Observed startup at 5 MiB (5242880 bytes)
    const state1 = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation('5242880'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '5242880', fileIdentity } },
    });

    // Next poll advances EOF to 5300000
    const state2 = updateBindings(state1, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:15.000Z',
      taskObservation: makeObservation('5300000'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '5300000', fileIdentity } },
    });

    // An event from historical range [1000, 2000) downloaded later
    const lateFetchedInitialHistory = makeEvent('1000', '2000');
    const boundHistory = bindCompleteRecord(lateFetchedInitialHistory, state2);
    expect(boundHistory.runId).toBeNull();
    expect(boundHistory.bindingId).toBeNull();

    // An event spanning across the window boundary [5242800, 5243000) also cannot bind
    const crossBoundaryEvent = makeEvent('5242800', '5243000');
    expect(bindCompleteRecord(crossBoundaryEvent, state2).runId).toBeNull();

    // An event fully inside the new window [5242880, 5243500) binds
    const inWindowEvent = makeEvent('5242880', '5243500');
    expect(bindCompleteRecord(inWindowEvent, state2).runId).toBe(expectedRunId);
  });

  it('r2-handoff-3: binds complete redraw terminated by standalone CR while leaving pendingCR unbound', () => {
    const initial = createInitialBindingState();
    const state1 = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation('1000'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '1000', fileIdentity } },
    });
    const state2 = updateBindings(state1, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:15.000Z',
      taskObservation: makeObservation('2000', { observedAt: '2026-10-20T00:00:15.000Z' }),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '2000', fileIdentity } },
    });

    // Pending CR record is incomplete
    const pendingCREvent = makeEvent('1100', '1150', {
      kind: 'redraw',
      recordComplete: false,
      text: '12%',
    });
    expect(bindCompleteRecord(pendingCREvent, state2).runId).toBeNull();

    // Standalone CR complete redraw within window
    const completeRedrawInWindow = makeEvent('1200', '1250', {
      kind: 'redraw',
      recordComplete: true,
      prefixIncomplete: false,
      text: '80106/169999 [10:00<10:00, 1.5it/s]',
    });
    expect(bindCompleteRecord(completeRedrawInWindow, state2).runId).toBe(expectedRunId);
  });

  it('r2-handoff-2: continuous writer window accepts nondecreasing EOF on normal file append without requiring stopped growth', () => {
    const initial = createInitialBindingState();
    let state = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation('10000'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '10000', fileIdentity } },
    });

    // Appending more bytes: 10000 -> 15000 -> 22000
    state = updateBindings(state, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:05.000Z',
      taskObservation: makeObservation('15000'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '15000', fileIdentity } },
    });
    expect(state.windows[0].isOpen).toBe(true);
    expect(state.windows[0].throughOffset).toBe('15000');

    state = updateBindings(state, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:10.000Z',
      taskObservation: makeObservation('22000'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '22000', fileIdentity } },
    });
    expect(state.windows[0].isOpen).toBe(true);
    expect(state.windows[0].throughOffset).toBe('22000');

    const event = makeEvent('16000', '17000');
    expect(bindCompleteRecord(event, state).runId).toBe(expectedRunId);
  });

  it('handles large byte offsets exceeding 2^53 with BigInt precision', () => {
    const hugeStart = '9007199254740992'; // 2^53
    const hugeThrough = '9007199254745000'; // 2^53 + 4008
    const initial = createInitialBindingState();

    let state = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation(hugeStart),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: hugeStart, fileIdentity } },
    });
    state = updateBindings(state, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:15.000Z',
      taskObservation: makeObservation(hugeThrough),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: hugeThrough, fileIdentity } },
    });

    const hugeEvent = makeEvent('9007199254741000', '9007199254742000');
    const bound = bindCompleteRecord(hugeEvent, state);
    expect(bound.runId).toBe(expectedRunId);
    expect(bound.bindingId).toBeTruthy();
  });

  it('r2-handoff-4: revoking bindings clears or recalculates affected progress and nulls unbacked derived counts', () => {
    const initial = createInitialBindingState();
    let state = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation('1000'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '1000', fileIdentity } },
    });
    state = updateBindings(state, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:15.000Z',
      taskObservation: makeObservation('5000'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '5000', fileIdentity } },
    });

    const event = makeEvent('1500', '2500');
    const bound = bindCompleteRecord(event, state);
    expect(bound.runId).toBe(expectedRunId);
    const bindingId = bound.bindingId!;

    // Revoke the binding
    const revokedState = revokeBindings(state, [bindingId]);
    expect(revokedState.revokedBindingIds).toContain(bindingId);

    // Subsequent attempt to bind with revoked state fails
    const attemptAfterRevoke = bindCompleteRecord(event, revokedState);
    expect(attemptAfterRevoke.runId).toBeNull();
    expect(attemptAfterRevoke.bindingId).toBeNull();
  });

  it('refuses to open or advance a window if direct writer witness or role evidence is invalid', () => {
    const initial = createInitialBindingState();

    // No direct writer source id
    const noWriter = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation('1000', { directWriter: false }),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '1000', fileIdentity } },
    });
    expect(noWriter.windows).toHaveLength(0);

    // Role evidence is none
    const noRole = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation('1000', { roleEvidence: 'none' }),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '1000', fileIdentity } },
    });
    expect(noRole.windows).toHaveLength(0);

    // Script entry does not match registered entryPaths
    const wrongEntry = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation('1000', { scriptEntry: '/home/other/run.py' }),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '1000', fileIdentity } },
    });
    expect(wrongEntry.windows).toHaveLength(0);
  });

  it('closes open windows when observerEpoch changes or process instance changes', () => {
    const initial = createInitialBindingState();
    const state1 = updateBindings(initial, {
      taskId,
      hostId,
      observerEpoch: epoch1,
      observedAt: '2026-10-20T00:00:00.000Z',
      taskObservation: makeObservation('1000'),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '1000', fileIdentity } },
    });
    expect(state1.windows[0].isOpen).toBe(true);

    // Epoch changed (reconnect / new observation session)
    const state2 = updateBindings(state1, {
      taskId,
      hostId,
      observerEpoch: 'epoch-local-2',
      observedAt: '2026-10-20T00:01:00.000Z',
      taskObservation: makeObservation('2000', { observedAt: '2026-10-20T00:01:00.000Z' }),
      entryPaths: ['/data2/cy/xzn/train.py'],
      sourceInfo: { [sourceId]: { generation, eofBytes: '2000', fileIdentity } },
    });
    // Previous window should be closed
    const oldWin = state2.windows.find((w) => w.observerEpoch === epoch1);
    expect(oldWin?.isOpen).toBe(false);
    // New window opened starting at 2000
    const newWin = state2.windows.find((w) => w.observerEpoch === 'epoch-local-2');
    expect(newWin?.fromOffset).toBe('2000');
  });

  describe('Group A fixes: R-01, R-02, I-01, I-02', () => {
    it('T5-R-01: rejects non-training output (e.g. server health ok) and ordinary text even when kind is line or redraw', () => {
      const initial = createInitialBindingState();
      const state1 = updateBindings(initial, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: makeObservation('5000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
      });
      const state2 = updateBindings(state1, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:15.000Z',
        taskObservation: makeObservation('5001000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5001000', fileIdentity } },
      });

      const healthLine = makeEvent('5000100', '5000200', {
        kind: 'line',
        text: 'server health ok',
      });
      expect(bindCompleteRecord(healthLine, state2).runId).toBeNull();

      const healthRedraw = makeEvent('5000200', '5000300', {
        kind: 'redraw',
        text: 'cpu 10/100',
      });
      expect(bindCompleteRecord(healthRedraw, state2).runId).toBeNull();
    });

    it('T5-R-01: rejects record when taskId, generation, or observerEpoch does not match active window', () => {
      const initial = createInitialBindingState();
      const state1 = updateBindings(initial, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: makeObservation('5000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
      });
      const state2 = updateBindings(state1, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:15.000Z',
        taskObservation: makeObservation('5001000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5001000', fileIdentity } },
      });

      const wrongTaskEvent = makeEvent('5000100', '5000200');
      wrongTaskEvent.taskId = 'different-task';
      expect(bindCompleteRecord(wrongTaskEvent, state2).runId).toBeNull();

      const wrongGenEvent = makeEvent('5000100', '5000200', { gen: 'other-gen' });
      expect(bindCompleteRecord(wrongGenEvent, state2).runId).toBeNull();
    });

    it('T5-R-02: refuses to open window when generation is missing from sourceInfo (no gen-uuid-1 fallback)', () => {
      const initial = createInitialBindingState();
      const state = updateBindings(initial, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: makeObservation('5000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        // sourceInfo omitted
      });
      expect(state.windows).toHaveLength(0);
    });

    it('T5-R-02: refuses to open window when writerSourceEvidence is missing or dev/inode or EOF mismatches', () => {
      const initial = createInitialBindingState();
      const obsMismatch = makeObservation('5000000', { wrongFileIdentity: true });
      const stateMismatch = updateBindings(initial, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: obsMismatch,
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
      });
      expect(stateMismatch.windows).toHaveLength(0);
    });

    it('T5-I-01: closes active writer window when direct writer witness is missing or incomplete', () => {
      const initial = createInitialBindingState();
      const state1 = updateBindings(initial, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: makeObservation('5000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
      });
      const state2 = updateBindings(state1, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:15.000Z',
        taskObservation: makeObservation('5001000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5001000', fileIdentity } },
      });
      expect(state2.windows[0].isOpen).toBe(true);

      // Witness removed on next observation
      const obsNoWriter = makeObservation('5002000', { directWriter: false });
      const state3 = updateBindings(state2, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:30.000Z',
        taskObservation: obsNoWriter,
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5002000', fileIdentity } },
      });
      expect(state3.windows[0].isOpen).toBe(false);
    });

    it('T5-N-02: handles malformed eofBytes or window offsets without throwing and safely rejects', () => {
      const initial = createInitialBindingState();
      // Malformed source eofBytes containing non-digits
      const obsMalformed = makeObservation('12x');
      let state: any;
      expect(() => {
        state = updateBindings(initial, {
          taskId,
          hostId,
          observerEpoch: epoch1,
          observedAt: '2026-10-20T00:00:00.000Z',
          taskObservation: obsMalformed,
          entryPaths: ['/data2/cy/xzn/train.py'],
          sourceInfo: { [sourceId]: { generation, eofBytes: '12x', fileIdentity } },
        });
      }).not.toThrow();
      expect(state.windows.filter((w: any) => w.isOpen)).toHaveLength(0);
    });

    it('T5-R-01: refuses to bind backfilled events into old closed range after reopening at later EOF', () => {
      const initial = createInitialBindingState();
      // Open window 1 at 5000000, advance to 5001000
      const s1 = updateBindings(initial, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: makeObservation('5000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
      });
      const s2 = updateBindings(s1, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:15.000Z',
        taskObservation: makeObservation('5001000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5001000', fileIdentity } },
      });
      // Close window
      const s3 = updateBindings(s2, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:30.000Z',
        taskObservation: makeObservation('5001000', { directWriter: false }),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5001000', fileIdentity } },
      });
      expect(s3.windows[0].isOpen).toBe(false);

      // Reopen at later EOF 6000000, advance to 6001000
      const s4 = updateBindings(s3, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:01:00.000Z',
        taskObservation: makeObservation('6000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '6000000', fileIdentity } },
      });
      const s5 = updateBindings(s4, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:01:15.000Z',
        taskObservation: makeObservation('6001000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '6001000', fileIdentity } },
      });

      // An event inside old window range [5000200, 5000300] must NOT bind to the old closed binding!
      const oldEv = makeEvent('5000200', '5000300', { text: 'step: 100/1000 loss: 0.123' });
      const bound = bindCompleteRecord(oldEv, s5);
      expect(bound.runId).toBeNull();
      expect(bound.bindingId).toBeNull();
    });

    it('T5-R-01 / T5-I-02: caller algorithm override is rejected when registered task is score', () => {
      const initial: any = { ...createInitialBindingState(), algorithm: 'score', taskId };
      const scoreTask = { ...registeredTask, algorithm: 'score' as const };
      const s1 = updateBindings(initial, {
        task: scoreTask,
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: makeObservation('5000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        algorithm: 'score',
        sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
      });
      const s2 = updateBindings(s1, {
        task: scoreTask,
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:15.000Z',
        taskObservation: makeObservation('5001000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        algorithm: 'score',
        sourceInfo: { [sourceId]: { generation, eofBytes: '5001000', fileIdentity } },
      });

      // Caller attempts to pass { algorithm: 'flow' } with Flow text under Score task
      const flowEv = makeEvent('5000100', '5000200', { text: ' 10%|#         | 100/1000 [00:10<01:30, 10.0it/s]' });
      const bound = bindCompleteRecord(flowEv, s2);
      expect(bound.runId).toBeNull();
      expect(bound.bindingId).toBeNull();
    });

    it('T5-I-01: detects mixed-writer contradiction on registered source, closes window and revokes binding', () => {
      const initial = createInitialBindingState();
      const s1 = updateBindings(initial, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: makeObservation('5000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
      });
      const s2 = updateBindings(s1, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:15.000Z',
        taskObservation: makeObservation('5001000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5001000', fileIdentity } },
      });
      expect(s2.windows[0].isOpen).toBe(true);

      // Now two distinct candidate processes both claim direct write to sourceId (contradiction!)
      const obsContradiction = makeObservation('5002000');
      obsContradiction.processes = [
        ...(obsContradiction.processes || []),
        {
          key: { hostBootId: 'boot-1', pid: 9999, startTicks: '12345' },
          role: 'trainer' as const,
          cwd: '/data2/cy/xzn',
          scriptEntry: '/data2/cy/xzn/train.py',
          observedAt: '2026-10-20T00:00:30.000Z',
          roleEvidence: 'exact_entry_and_direct_writer_fd' as const,
          directWriterSourceIds: [sourceId],
          writerEvidenceComplete: true,
          evidenceComplete: true,
          interpreterFlags: [],
        },
      ];

      const s3 = updateBindings(s2, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:30.000Z',
        taskObservation: obsContradiction,
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5002000', fileIdentity } },
      });
      expect(s3.windows[0].isOpen).toBe(false);
      expect(s3.revokedBindingIds.length).toBeGreaterThan(0);
    });

    it('T5-N-02 (fix-3): does not throw SyntaxError when retained binding has malformed throughOffset "12x", and safely fails closed', () => {
      const state = {
        ...createInitialBindingState(),
        taskId,
        activeRunId: expectedRunId,
        activeMainKey: mainKey,
        observerEpoch: epoch1,
        windows: [
          {
            windowId: 'win-1',
            openingId: 'op-1',
            taskId,
            sourceId,
            generation,
            observerEpoch: epoch1,
            fromOffset: '1000',
            throughOffset: '5000',
            isOpen: true,
            mainProcessKey: mainKey,
            runId: expectedRunId,
            fileIdentity,
            algorithm: 'flow' as const,
            activeBindingId: 'b-active',
          },
        ],
        bindings: [
          {
            bindingId: 'b-corrupted',
            runId: expectedRunId,
            mainProcessKey: mainKey,
            sourceId,
            generation,
            fromOffset: '1000',
            throughOffset: '12x', // Malformed retained binding
            evidenceKind: 'observed_direct_writer' as const,
            observerEpoch: epoch1,
            observedAt: '2026-10-20T00:00:00.000Z',
          },
        ],
        revokedBindingIds: [],
      };

      const event = makeEvent('1200', '1300');
      let bound: any;
      expect(() => {
        bound = bindCompleteRecord(event, state as any);
      }).not.toThrow();
      expect(bound?.bindingId).toBeNull();
    });

    it('T5-I-01 (fix-3): isTimestampValid fails closed for null refTime and rejects future timestamps (+1ms ahead)', () => {
      expect(isTimestampValid('2026-10-20T00:00:01.000Z', null)).toBe(false);
      expect(isTimestampValid('2026-10-20T00:00:00.001Z', Date.parse('2026-10-20T00:00:00.000Z'))).toBe(false);
      expect(isTimestampValid('2026-10-20T00:00:00.000Z', Date.parse('2026-10-20T00:00:00.000Z'), NaN)).toBe(false);
      expect(isTimestampValid('2026-10-20T00:00:00.000Z', Date.parse('2026-10-20T00:00:00.000Z'), -1000)).toBe(false);
    });

    it('T5-I-01 (fix-3): mixed-writer contradiction on active window revokes suspect active binding without revoking legitimate historical binding from prior run', () => {
      const initial = createInitialBindingState();
      const historyBindingId = 'binding:history-run-old:main-log:gen-uuid-1:100:epoch-old';
      initial.bindings.push({
        bindingId: historyBindingId,
        runId: 'history-run-old',
        mainProcessKey: { hostBootId: 'boot-0', pid: 1111, startTicks: '11111' },
        sourceId,
        generation,
        fromOffset: '100',
        throughOffset: '500',
        evidenceKind: 'observed_direct_writer',
        observerEpoch: 'epoch-old',
        observedAt: '2026-10-19T23:00:00.000Z',
      });

      const s1 = updateBindings(initial, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:00.000Z',
        taskObservation: makeObservation('5000000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5000000', fileIdentity } },
      });
      const s2 = updateBindings(s1, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:15.000Z',
        taskObservation: makeObservation('5001000'),
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5001000', fileIdentity } },
      });
      expect(s2.windows[0].isOpen).toBe(true);
      const activeBinding = s2.bindings.find((b) => b.runId === expectedRunId);
      expect(activeBinding).toBeDefined();
      const activeBindingId = activeBinding!.bindingId;

      const obsContradiction = makeObservation('5002000');
      obsContradiction.processes = [
        ...(obsContradiction.processes || []),
        {
          key: { hostBootId: 'boot-1', pid: 9999, startTicks: '12345' },
          role: 'trainer' as const,
          cwd: '/data2/cy/xzn',
          scriptEntry: '/data2/cy/xzn/train.py',
          observedAt: '2026-10-20T00:00:30.000Z',
          roleEvidence: 'exact_entry_and_direct_writer_fd' as const,
          directWriterSourceIds: [sourceId],
          writerEvidenceComplete: true,
          evidenceComplete: true,
          interpreterFlags: [],
        },
      ];

      const s3 = updateBindings(s2, {
        taskId,
        hostId,
        observerEpoch: epoch1,
        observedAt: '2026-10-20T00:00:30.000Z',
        taskObservation: obsContradiction,
        entryPaths: ['/data2/cy/xzn/train.py'],
        sourceInfo: { [sourceId]: { generation, eofBytes: '5002000', fileIdentity } },
      });

      expect(s3.windows[0].isOpen).toBe(false);
      expect(s3.revokedBindingIds).toContain(activeBindingId);
      expect(s3.revokedBindingIds).not.toContain(historyBindingId);
    });

    it('T5-R-01 (fix-3): ambiguous duplicate active windows fail closed and reject binding', () => {
      const state = {
        ...createInitialBindingState(),
        taskId,
        activeRunId: expectedRunId,
        activeMainKey: mainKey,
        observerEpoch: epoch1,
        windows: [
          {
            windowId: 'win-1',
            openingId: 'op-1',
            taskId,
            sourceId,
            generation,
            observerEpoch: epoch1,
            fromOffset: '5000000',
            throughOffset: '5010000',
            isOpen: true,
            mainProcessKey: mainKey,
            runId: expectedRunId,
            fileIdentity,
            algorithm: 'flow' as const,
            activeBindingId: 'b-1',
          },
          {
            windowId: 'win-2',
            openingId: 'op-2',
            taskId,
            sourceId,
            generation,
            observerEpoch: epoch1,
            fromOffset: '5000000',
            throughOffset: '5010000',
            isOpen: true,
            mainProcessKey: mainKey,
            runId: expectedRunId,
            fileIdentity,
            algorithm: 'flow' as const,
            activeBindingId: 'b-2',
          },
        ],
        bindings: [
          {
            bindingId: 'b-1',
            runId: expectedRunId,
            mainProcessKey: mainKey,
            sourceId,
            generation,
            fromOffset: '5000000',
            throughOffset: '5010000',
            evidenceKind: 'observed_direct_writer' as const,
            observerEpoch: epoch1,
            observedAt: '2026-10-20T00:00:00.000Z',
          },
        ],
        revokedBindingIds: [],
      };

      const event = makeEvent('5002000', '5003000');
      const bound = bindCompleteRecord(event, state as any);
      expect(bound.bindingId).toBeNull();
    });
  });
});
