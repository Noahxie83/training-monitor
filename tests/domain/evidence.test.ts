import { describe, expect, it } from 'vitest';
import { evaluateCheckpoint } from '../../src/domain/checkpoints';
import { createInitialBindingState, updateBindings, bindCompleteRecord, ingestCompleteRecord } from '../../src/domain/bindings';
import { ingestStructuredBaselineRead } from '../../src/domain/evidence';
import { deriveProgress, type ProgressEvidence, type ProgressRateSample } from '../../src/domain/progress';
import type { LogEvent } from '../../src/shared/contracts';
import { projectTask, type TaskEvidence } from '../../src/domain/lifecycle';
import { projectResources, type ResourceSampleInput } from '../../src/domain/resources';
import { makeRunId } from '../../src/domain/identity';
import type { ProcessKey, Progress, RunBinding, TaskRegistration, TaskSnapshot } from '../../src/shared/contracts';
import type { HostObservation, TaskObservation, TaskProcessObservation } from '../../src/transport/types';

describe('domain evidence, resources, checkpoints and task projection', () => {
  const hostId = 'lab-campus';
  const taskId = 'score-training';
  const task: TaskRegistration = {
    taskId,
    hostId,
    label: 'Score Training Task',
    enabled: true,
    algorithm: 'score',
    allowedDirectories: ['/data2/cy/xzn'],
    entryPaths: ['/data2/cy/xzn/score/main.py'],
    sources: [
      { sourceId: 'log', path: '/data2/cy/xzn/score/train.log', kind: 'log' },
      { sourceId: 'status', path: '/data2/cy/xzn/score/status.json', kind: 'status_json' },
      { sourceId: 'lock', path: '/data2/cy/xzn/score/queue.lock', kind: 'queue_lock' },
    ],
    checkpointDirectories: ['/data2/cy/xzn/score/checkpoints'],
  };

  const hostObs: HostObservation = {
    hostId,
    freshness: 'fresh',
    observedAt: '2026-10-20T00:00:00.000Z',
    phase: null,
    connection: 'connected',
    scanComplete: true,
    hostBootId: 'boot-1',
    errorCode: null,
  };

  const strongKey: ProcessKey = {
    hostBootId: 'boot-1',
    pid: 5555,
    startTicks: '34567',
  };

  describe('checkpoints', () => {
    it('reports file_found on first observation of checkpoint', () => {
      const cp1 = evaluateCheckpoint(
        null,
        {
          path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
          sizeBytes: '1048576000',
          mtime: '2026-10-20T00:00:00.000Z',
          fileIdentity: { dev: '1', inode: '2' },
          scanComplete: true,
        },
        '2026-10-20T00:00:00.000Z'
      );

      expect(cp1.evidence).toBe('file_found');
      expect(cp1.fileStepIndex).toBe(30000);
      expect(cp1.stepSource).toBe('filename');
    });

    it('promotes to file_stable_observed after >= 15 seconds without change', () => {
      const cp1 = evaluateCheckpoint(
        null,
        {
          path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
          sizeBytes: '1048576000',
          mtime: '2026-10-20T00:00:00.000Z',
          fileIdentity: { dev: '1', inode: '2' },
          scanComplete: true,
        },
        '2026-10-20T00:00:00.000Z'
      );

      const cp2 = evaluateCheckpoint(
        cp1,
        {
          path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
          sizeBytes: '1048576000',
          mtime: '2026-10-20T00:00:00.000Z',
          fileIdentity: { dev: '1', inode: '2' },
          scanComplete: true,
        },
        '2026-10-20T00:00:16.000Z'
      );
      expect(cp2.evidence).toBe('file_stable_observed');
    });

    it('reverts to file_found if checkpoint size or mtime subsequently changes', () => {
      const cpStable = evaluateCheckpoint(
        {
          observedAt: '2026-10-20T00:00:00.000Z',
          freshness: 'fresh',
          path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
          fileStepIndex: 30000,
          stepSource: 'filename',
          sizeBytes: '1048576000',
          mtime: '2026-10-20T00:00:00.000Z',
          evidence: 'file_stable_observed',
          scanComplete: true,
        },
        {
          path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
          sizeBytes: '1048580000',
          mtime: '2026-10-20T00:00:30.000Z',
          fileIdentity: { dev: '1', inode: '2' },
          scanComplete: true,
        },
        '2026-10-20T00:00:30.000Z'
      );
      expect(cpStable.evidence).toBe('file_found');
    });
  });

  describe('resources and metrics', () => {
    it('r2-handoff-6: omits process resource metrics when startTicks is missing rather than constructing weak keys', () => {
      const samples: ResourceSampleInput[] = [
        {
          source: 'proc',
          name: 'cpu_utilization',
          unit: 'percent_one_cpu',
          value: 120.5,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'process',
          processKey: { hostBootId: 'boot-1', pid: 1234, startTicks: '' },
          keyBeforeSample: null,
          keyAfterSample: null,
        },
        {
          source: 'nvidia-smi',
          name: 'gpu_utilization',
          unit: 'percent_device',
          value: 85,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'device',
          deviceId: 'gpu-0',
        },
      ];

      const metricsWithMissingStartTicks = projectResources(samples, { now: '2026-10-20T00:00:05.000Z', registeredKeys: [strongKey] });
      expect(metricsWithMissingStartTicks.filter((m) => m.scope === 'process')).toEqual([]);
      expect(metricsWithMissingStartTicks.filter((m) => m.scope === 'device')).toHaveLength(1);
    });

    it('allows CPU percent_one_cpu to exceed 100% and keeps device GPU metrics separate', () => {
      const samples: ResourceSampleInput[] = [
        {
          source: 'proc',
          name: 'cpu_utilization',
          unit: 'percent_one_cpu',
          value: 385.2,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'process',
          processKey: strongKey,
          keyBeforeSample: strongKey,
          keyAfterSample: strongKey,
        },
        {
          source: 'proc',
          name: 'process_rss',
          unit: 'bytes',
          value: 1073741824,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'process',
          processKey: strongKey,
          keyBeforeSample: strongKey,
          keyAfterSample: strongKey,
        },
        {
          source: 'nvidia-smi',
          name: 'gpu_memory_used',
          unit: 'bytes',
          value: 8589934592,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'device',
          deviceId: 'gpu-0',
        },
      ];

      const metrics = projectResources(samples, { now: '2026-10-20T00:00:05.000Z', registeredKeys: [strongKey] });
      const cpu = metrics.find((m) => m.name === 'cpu_utilization');
      expect(cpu?.value).toBe(385.2);
      expect(cpu?.scope).toBe('process');

      const gpu = metrics.find((m) => m.name === 'gpu_memory_used');
      expect(gpu?.scope).toBe('device');
      if (gpu?.scope === 'device') {
        expect(gpu.processKey).toBeNull();
      }
    });
  });

  describe('lifecycle and task projection', () => {
    const makeRunningEvidence = (at = '2026-10-20T00:00:00.000Z', key = strongKey) => {
      const fileIdentity = { dev: '1', inode: '1' };
      const text = '[score] step 100';
      const taskObservation: TaskObservation = {
        taskId, hostId, observedAt: at, freshness: 'fresh', scanComplete: true,
        processScanError: null, phase: null, errorCode: null,
        sources: [{ sourceId: 'log', observedAt: at, fileIdentity, eofBytes: '100', permission: 'readable', exists: true, statusValues: null, heldByRegisteredProcess: null, errorCode: null, evidenceComplete: true, phase: null }],
        processes: [{ key, role: 'trainer', cwd: '/data2/cy/xzn', scriptEntry: task.entryPaths[0], observedAt: at, roleEvidence: 'exact_entry_and_direct_writer_fd', directWriterSourceIds: ['log'], writerSourceEvidence: { log: { fileIdentity, eofBytes: '100' } }, writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [] }],
      };
      const bindingState = updateBindings(createInitialBindingState(), {
        task, taskId, hostId, observerEpoch: 'epoch-evidence', observedAt: at, taskObservation,
        sourceInfo: { log: { generation: 'gen-evidence', eofBytes: '100', fileIdentity } },
        outputSamples: { log: { sourceId: 'log', generation: 'gen-evidence', fileIdentity, startOffset: '0', endOffset: String(new TextEncoder().encode(text).length), observedAt: at, text } },
      });
      return { taskObservation, bindingState };
    };

    it('projects queued for Score when cwd is /home/cy but registered entry and queue evidence match', () => {
      const queueKey: ProcessKey = { hostBootId: 'boot-1', pid: 7777, startTicks: '4444' };
      const taskObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [
          {
            sourceId: 'lock',
            observedAt: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '5', inode: '6' },
            eofBytes: '0',
            permission: 'readable',
            exists: true,
            statusValues: null,
            heldByRegisteredProcess: null,
            errorCode: null,
            phase: null,
          },
          {
            sourceId: 'status',
            observedAt: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '5', inode: '6' },
            eofBytes: '100',
            permission: 'readable',
            exists: true,
            statusValues: { waiting: true, state: 'waiting_flow', sequence: 1, hostBootId: queueKey.hostBootId, pid: queueKey.pid, startTicks: queueKey.startTicks },
            heldByRegisteredProcess: null,
            errorCode: null,
            evidenceComplete: true,
            phase: null,
          },
        ],
        processes: [
          {
            key: queueKey,
            role: 'queue',
            cwd: '/home/cy',
            scriptEntry: '/data2/cy/xzn/score/main.py',
            observedAt: '2026-10-20T00:00:00.000Z',
            roleEvidence: 'exact_script_entry',
            directWriterSourceIds: [],
            writerEvidenceComplete: true,
            evidenceComplete: true,
            interpreterFlags: [],
          },
        ],
      };

      const evidence: TaskEvidence = {
        task,
        taskObservation: taskObs,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
        statusFileLinkage: { currentInstanceKey: queueKey, sequence: 1, sourceId: 'status', observedAt: '2026-10-20T00:00:00.000Z' },
      };

      const snapshot = projectTask(null, evidence);
      expect(snapshot.lifecycle).toBe('queued');
      expect(snapshot.processes.queue?.pid).toBe(7777);
      expect(snapshot.processes.main).toBeNull();
      expect(snapshot.currentRun).toBeNull();
    });

    it('does not classify traceback, log silence, or disappearing process alone as failed or completed', () => {
      const taskObsNoProcess: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [],
      };

      const running = makeRunningEvidence();
      const prevRunningSnapshot = projectTask(null, {
        task,
        taskObservation: running.taskObservation,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
        bindingState: running.bindingState,
        outputSamples: { log: { sourceId: 'log', generation: 'gen-evidence', fileIdentity: { dev: '1', inode: '1' }, startOffset: '0', endOffset: String(new TextEncoder().encode('[score] step 100').length), observedAt: '2026-10-20T00:00:00.000Z', text: '[score] step 100' } },
      });
      expect(prevRunningSnapshot.lifecycle).toBe('running');

      const nextSnapshot = projectTask(prevRunningSnapshot, {
        task,
        taskObservation: taskObsNoProcess,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:15.000Z',
      });
      expect(nextSnapshot.lifecycle).toBe('unconfirmed');
    });

    it('reports not_observed only when host scan is complete and no active task exists without prior running state', () => {
      const emptyScan: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [],
      };

      const snapshot = projectTask(null, {
        task,
        taskObservation: emptyScan,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
      });
      expect(snapshot.lifecycle).toBe('not_observed');
    });

    it('T5-I-03: rejects running when process has caller role trainer but roleEvidence is none or scriptEntry is not registered', () => {
      const candidateWithRoleOnly = {
        key: strongKey,
        role: 'trainer' as const,
        cwd: '/data2/cy/xzn',
        scriptEntry: '/data2/cy/xzn/score/unregistered.py',
        observedAt: '2026-10-20T00:00:00.000Z',
        roleEvidence: 'none' as const,
        directWriterSourceIds: [],
        writerEvidenceComplete: false,
        evidenceComplete: true,
        interpreterFlags: [],
      };
      const taskObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [candidateWithRoleOnly],
      };
      const snap = projectTask(null, {
        task,
        taskObservation: taskObs,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
      });
      expect(snap.lifecycle).not.toBe('running');
    });

    it('T5-I-03: rejects running when writerEvidenceComplete is true but directWriterSourceIds is empty or lacks registered source or witness', () => {
      const candidateWithEmptyWriters = {
        key: strongKey,
        role: 'trainer' as const,
        cwd: '/data2/cy/xzn',
        scriptEntry: task.entryPaths[0],
        observedAt: '2026-10-20T00:00:00.000Z',
        roleEvidence: 'exact_entry_and_direct_writer_fd' as const,
        directWriterSourceIds: [],
        writerSourceEvidence: {},
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      };
      const taskObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [candidateWithEmptyWriters],
      };
      const snap = projectTask(null, {
        task,
        taskObservation: taskObs,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
      });
      expect(snap.lifecycle).not.toBe('running');
      expect(snap.currentRun).toBeNull();
    });

    it('T5-I-03 (fix-3): projectTask refuses running when taskObservation.sources is empty even if writer evidence labels and non-empty directWriterSourceIds are present', () => {
      const candidateWithWriter = {
        key: strongKey,
        role: 'trainer' as const,
        cwd: '/data2/cy/xzn',
        scriptEntry: task.entryPaths[0],
        observedAt: '2026-10-20T00:00:00.000Z',
        roleEvidence: 'exact_entry_and_direct_writer_fd' as const,
        directWriterSourceIds: ['log'],
        writerSourceEvidence: {
          log: { fileIdentity: { dev: '1', inode: '1' }, eofBytes: '100' },
        },
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      };
      const taskObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [candidateWithWriter],
      };
      const snap = projectTask(null, {
        task,
        taskObservation: taskObs,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
      });
      expect(snap.lifecycle).not.toBe('running');
      expect(snap.currentRun).toBeNull();
      expect(snap.processes.main).toBeNull();
    });

    it('T5-I-04: rejects queued lifecycle when queue candidate lacks matching current-waiting record', () => {
      const queueKey: ProcessKey = { hostBootId: 'boot-1', pid: 7777, startTicks: '4444' };
      const taskObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [
          {
            key: queueKey,
            role: 'queue',
            cwd: '/home/cy',
            scriptEntry: '/data2/cy/xzn/score/main.py',
            observedAt: '2026-10-20T00:00:00.000Z',
            roleEvidence: 'exact_script_entry',
            directWriterSourceIds: [],
            writerEvidenceComplete: true,
            evidenceComplete: true,
            interpreterFlags: [],
          },
        ],
      };
      const snap = projectTask(null, {
        task,
        taskObservation: taskObs,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
      });
      expect(snap.lifecycle).not.toBe('queued');
    });

    it("T5-I-05: rejects not_observed when host is disconnected or host scan is incomplete", () => {
      const emptyTaskObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:00.000Z",
        freshness: "fresh",
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [],
      };
      const disconnectedHostObs: HostObservation = {
        hostId,
        freshness: "stale",
        observedAt: "2026-10-20T00:00:00.000Z",
        phase: null,
        connection: "disconnected",
        scanComplete: false,
        hostBootId: null,
        errorCode: "CONNECT_FAILED",
      };

      const snap = projectTask(null, {
        task,
        taskObservation: emptyTaskObs,
        hostObservation: disconnectedHostObs,
        observedAt: "2026-10-20T00:00:00.000Z",
      });
      expect(snap.lifecycle).not.toBe("not_observed");
    });

    it("T5-I-06: projectTask defaults Progress.runId to null when no bound events exist and clears unrelated previous run progress", () => {
      const newKey: ProcessKey = { hostBootId: 'boot-1', pid: 1234, startTicks: '9999' };
      const running = makeRunningEvidence('2026-10-20T00:00:00.000Z', newKey);

      // 1. Fresh task without bound events must have Progress.runId === null
      const snap1 = projectTask(null, {
        task,
        taskObservation: running.taskObservation,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:00.000Z",
        bindingState: running.bindingState,
        outputSamples: { log: { sourceId: 'log', generation: 'gen-evidence', fileIdentity: { dev: '1', inode: '1' }, startOffset: '0', endOffset: String(new TextEncoder().encode('[score] step 100').length), observedAt: '2026-10-20T00:00:00.000Z', text: '[score] step 100' } },
      });
      expect(snap1.currentRun).not.toBeNull();
      expect(snap1.progress.runId).toBeNull();

      // 2. Previous progress from an OLD runId must NOT be inherited by the new run
      const prevOldSnapshot: TaskSnapshot = {
        ...snap1,
        currentRun: { runId: "old-run-id", mainProcessKey: { hostBootId: "old", pid: 9, startTicks: "1" } },
        progress: {
          ...snap1.progress,
          runId: "old-run-id",
          bindingIds: ["old-binding"],
          global: { completedCount: 5000, targetCount: 10000, fraction: 0.5, unit: "completed_iterations", verified: true, sourceId: "log" },
        },
      };

      const snap2 = projectTask(prevOldSnapshot, {
        task,
        taskObservation: running.taskObservation,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:10.000Z",
        bindingState: running.bindingState,
        outputSamples: { log: { sourceId: 'log', generation: 'gen-evidence', fileIdentity: { dev: '1', inode: '1' }, startOffset: '0', endOffset: String(new TextEncoder().encode('[score] step 100').length), observedAt: '2026-10-20T00:00:00.000Z', text: '[score] step 100' } },
      });
      expect(snap2.progress.runId).toBeNull();
      expect(snap2.progress.global.completedCount).toBeNull();
    });

    it('T5-I-06 fix-5: failed scan does not retain a snapshot from another task or host', () => {
      const running = makeRunningEvidence();
      const current = projectTask(null, {
        task,
        taskObservation: running.taskObservation,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
        bindingState: running.bindingState,
      });
      const foreignPrevious: TaskSnapshot = {
        ...current,
        taskId: 'another-task',
        hostId: 'another-host',
        progress: { ...current.progress, runId: 'fabricated-other-run', global: { ...current.progress.global, completedCount: 987654 } },
      };
      const failed = projectTask(foreignPrevious, {
        task,
        taskObservation: { ...running.taskObservation, freshness: 'stale', scanComplete: false, observedAt: '2026-10-20T00:00:10.000Z' },
        hostObservation: { ...hostObs, freshness: 'stale', scanComplete: false, connection: 'disconnected', observedAt: '2026-10-20T00:00:10.000Z' },
        observedAt: '2026-10-20T00:00:10.000Z',
      });
      expect(failed.taskId).toBe(task.taskId);
      expect(failed.hostId).toBe(task.hostId);
      expect(failed.lifecycle).toBe('unconfirmed');
      expect(failed.progress.runId).toBeNull();
      expect(failed.progress.global.completedCount).toBeNull();
    });

    it("T5-I-04: queue recognition requires conjunction on the SAME record (linkage AND waiting semantics on same status source)", () => {
      const queueKey: ProcessKey = { hostBootId: "boot-1", pid: 7777, startTicks: "4444" };
      const baseQueueProcess = {
        key: queueKey,
        role: "queue" as const,
        cwd: "/home/cy",
        scriptEntry: "/data2/cy/xzn/score/main.py",
        observedAt: "2026-10-20T00:00:00.000Z",
        roleEvidence: "exact_script_entry" as const,
        directWriterSourceIds: [],
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      };

      // 1. Link-only negative: statusFileLinkage present, but status source has waiting: false
      const linkOnlyObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:00.000Z",
        freshness: "fresh",
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [
          {
            sourceId: "status",
            observedAt: "2026-10-20T00:00:00.000Z",
            fileIdentity: { dev: 'status-dev', inode: 'status-inode' },
            eofBytes: "100",
            permission: "readable",
            exists: true,
            statusValues: { waiting: false, state: "idle", sequence: 1, hostBootId: queueKey.hostBootId, pid: queueKey.pid, startTicks: queueKey.startTicks },
            heldByRegisteredProcess: null,
            errorCode: null,
            evidenceComplete: true,
            phase: null,
          },
        ],
        processes: [baseQueueProcess],
      };
      const linkOnlySnap = projectTask(null, {
        task,
        taskObservation: linkOnlyObs,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:00.000Z",
        statusFileLinkage: { currentInstanceKey: queueKey, sequence: 1, sourceId: "status", observedAt: "2026-10-20T00:00:00.000Z" },
      });
      expect(linkOnlySnap.lifecycle).not.toBe("queued");
      expect(linkOnlySnap.processes.queue).toBeNull();

      // 2. Wait-only negative: status source has waiting: true, but statusFileLinkage is null
      const waitOnlyObs: TaskObservation = {
        ...linkOnlyObs,
        sources: [
          {
            ...linkOnlyObs.sources[0],
            statusValues: { waiting: true, state: "waiting_flow", sequence: 1, hostBootId: queueKey.hostBootId, pid: queueKey.pid, startTicks: queueKey.startTicks },
          },
        ],
      };
      const waitOnlySnap = projectTask(null, {
        task,
        taskObservation: waitOnlyObs,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:00.000Z",
        statusFileLinkage: null, // missing linkage
      });
      expect(waitOnlySnap.lifecycle).not.toBe("queued");
      expect(waitOnlySnap.processes.queue).toBeNull();

      // 3. Wrong-instance negative: linkage belongs to a different PID/key
      const wrongInstanceKey: ProcessKey = { hostBootId: "boot-1", pid: 9999, startTicks: "9999" };
      const wrongInstanceSnap = projectTask(null, {
        task,
        taskObservation: waitOnlyObs,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:00.000Z",
        statusFileLinkage: { currentInstanceKey: wrongInstanceKey, sequence: 1, sourceId: "status", observedAt: "2026-10-20T00:00:00.000Z" },
      });
      expect(wrongInstanceSnap.lifecycle).not.toBe("queued");

      // 4. Positive conjunction: BOTH linkage AND waiting semantics agree on the SAME registered status source
      const validConjunctionSnap = projectTask(null, {
        task,
        taskObservation: waitOnlyObs,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:00.000Z",
        statusFileLinkage: { currentInstanceKey: queueKey, sequence: 1, sourceId: "status", observedAt: "2026-10-20T00:00:00.000Z" },
      });
      expect(validConjunctionSnap.lifecycle).toBe("queued");
      expect(validConjunctionSnap.processes.queue?.pid).toBe(7777);
    });

    it('T5-I-05 fix-4: stale queue status cannot renew queued state when current host and process scans succeed', () => {
      const queueKey: ProcessKey = { hostBootId: 'boot-1', pid: 7777, startTicks: '4444' };
      const queueProcess = { key: queueKey, role: 'queue' as const, cwd: '/home/cy', scriptEntry: task.entryPaths[0], observedAt: '2026-10-20T00:00:00.000Z', roleEvidence: 'exact_script_entry' as const, directWriterSourceIds: [], writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [] };
      const statusSource = { sourceId: 'status', observedAt: '2026-10-20T00:00:00.000Z', fileIdentity: { dev: 'status-dev', inode: 'status-inode' }, eofBytes: '100', permission: 'readable' as const, exists: true, statusValues: { waiting: true, state: 'waiting_flow', sequence: 7, hostBootId: queueKey.hostBootId, pid: queueKey.pid, startTicks: queueKey.startTicks }, heldByRegisteredProcess: null, errorCode: null, evidenceComplete: true, phase: null };
      const previous = projectTask(null, {
        task,
        taskObservation: { taskId, hostId, observedAt: '2026-10-20T00:00:00.000Z', freshness: 'fresh', scanComplete: true, processScanError: null, phase: null, errorCode: null, sources: [statusSource], processes: [queueProcess] },
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
        statusFileLinkage: { currentInstanceKey: queueKey, sequence: 7, sourceId: 'status', observedAt: '2026-10-20T00:00:00.000Z' },
      });
      expect(previous.lifecycle).toBe('queued');

      const currentHost: HostObservation = { ...hostObs, observedAt: '2026-10-20T00:00:35.000Z' };
      const currentTask: TaskObservation = {
        taskId, hostId, observedAt: '2026-10-20T00:00:35.000Z', freshness: 'fresh', scanComplete: true,
        processScanError: null, phase: null, errorCode: null, sources: [statusSource],
        processes: [{ ...queueProcess, observedAt: '2026-10-20T00:00:35.000Z' }],
      };
      const staleQueue = projectTask(previous, {
        task, taskObservation: currentTask, hostObservation: currentHost, observedAt: '2026-10-20T00:00:35.000Z',
        statusFileLinkage: { currentInstanceKey: queueKey, sequence: 7, sourceId: 'status', observedAt: '2026-10-20T00:00:00.000Z' },
      });
      expect(staleQueue.freshness).toBe('stale');
      expect(staleQueue.lifecycle).toBe('unconfirmed');
      expect(staleQueue.processes.queue).toBeNull();
      expect(staleQueue.statusObservedAt).toBe(previous.statusObservedAt);
    });

    it("T5-I-05: not_observed requires host scanComplete:true and errorCode:null, while single missing log source still yields not_observed", () => {
      const taskObsEmpty: TaskObservation = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:00.000Z",
        freshness: "fresh",
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [],
      };

      // 1. Host scanComplete: false -> unconfirmed
      const hostIncomplete: HostObservation = {
        ...hostObs,
        scanComplete: false,
      };
      const snapIncomplete = projectTask(null, {
        task,
        taskObservation: taskObsEmpty,
        hostObservation: hostIncomplete,
        observedAt: "2026-10-20T00:00:00.000Z",
      });
      expect(snapIncomplete.lifecycle).toBe("unconfirmed");

      // 2. Host errorCode: 'TIMEOUT' -> unconfirmed
      const hostError: HostObservation = {
        ...hostObs,
        errorCode: "TIMEOUT",
      };
      const snapError = projectTask(null, {
        task,
        taskObservation: taskObsEmpty,
        hostObservation: hostError,
        observedAt: "2026-10-20T00:00:00.000Z",
      });
      expect(snapError.lifecycle).toBe("unconfirmed");

      // 3. Positive: Host success + task process scan complete + single log source missing -> still yields not_observed
      const taskObsLogMissing: TaskObservation = {
        ...taskObsEmpty,
        sources: [
          {
            sourceId: "log",
            observedAt: "2026-10-20T00:00:00.000Z",
            fileIdentity: null,
            eofBytes: "0",
            permission: "missing",
            exists: false,
            statusValues: null,
            heldByRegisteredProcess: null,
            errorCode: "FILE_NOT_FOUND",
            errorScope: "source",
            phase: null,
          },
        ],
      };
      const snapLogMissing = projectTask(null, {
        task,
        taskObservation: taskObsLogMissing,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:00.000Z",
      });
      expect(snapLogMissing.lifecycle).toBe("not_observed");
    });

    it("T5-I-06: projectTask validates input.progress and previous.progress against currentRun and surviving unrevoked bindings", () => {
      const binding1: RunBinding = {
        bindingId: "b-1",
        runId: makeRunId(task.hostId, task.taskId, strongKey),
        mainProcessKey: strongKey,
        sourceId: "log",
        generation: "gen-1",
        fromOffset: "1000",
        throughOffset: "5000",
        evidenceKind: "observed_direct_writer",
        observerEpoch: "epoch-1",
        observedAt: "2026-10-20T00:00:00.000Z",
      };

      const taskObsWithRunning: TaskObservation = {
        taskId,
        hostId,
        observedAt: "2026-10-20T00:00:00.000Z",
        freshness: "fresh",
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [],
        processes: [
          {
            key: strongKey,
            role: "trainer",
            cwd: "/data2/cy/xzn",
            scriptEntry: "/data2/cy/xzn/score/main.py",
            observedAt: "2026-10-20T00:00:00.000Z",
            roleEvidence: "exact_entry_and_direct_writer_fd",
            directWriterSourceIds: ["log"],
            writerSourceEvidence: {
              log: { fileIdentity: { dev: "1", inode: "1" }, eofBytes: "100" },
            },
            writerEvidenceComplete: true,
            evidenceComplete: true,
            interpreterFlags: [],
          },
        ],
      };

      const fakeProgress: Progress = {
        observedAt: "2026-10-20T00:00:00.000Z",
        freshness: "fresh",
        runId: "run-fabricated",
        lastStepIndex: 100,
        bindingIds: ["b-fake"],
        baselineEvidenceId: null,
        resumeCheckpointIndex: null,
        firstLoopIndex: null,
        configuredTarget: null,
        iterationsPerSecond: null,
        etaSeconds: null,
        global: { completedCount: 50, targetCount: 100, fraction: 0.5, unit: "completed_iterations", verified: true, sourceId: "log" },
        session: { completedCount: 50, targetCount: 100, fraction: 0.5, unit: "completed_iterations", verified: true, sourceId: "log" },
      };

      // 1. Caller-supplied input.progress with mismatched runId and unevidenced bindings is rejected
      const snapRejectedInput = projectTask(null, {
        task,
        taskObservation: taskObsWithRunning,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:00.000Z",
        progress: fakeProgress,
        bindingState: {
          windows: [],
          bindings: [binding1],
          revokedBindingIds: [],
          activeRunId: binding1.runId,
          activeMainKey: strongKey,
          observerEpoch: "epoch-1",
        },
      });
      expect(snapRejectedInput.progress.runId).toBeNull();
      expect(snapRejectedInput.progress.bindingIds).toHaveLength(0);

      // 2. previous.progress whose supporting bindings were revoked in current bindingState is cleared
      const validPrevProgress: Progress = {
        ...fakeProgress,
        runId: binding1.runId,
        bindingIds: ["b-1"],
      };
      const prevSnapshot: any = {
        lifecycle: "running",
        currentRun: { runId: binding1.runId, mainProcessKey: strongKey },
        progress: validPrevProgress,
      };

      const snapRevokedPrev = projectTask(prevSnapshot, {
        task,
        taskObservation: taskObsWithRunning,
        hostObservation: hostObs,
        observedAt: "2026-10-20T00:00:15.000Z",
        bindingState: {
          windows: [],
          bindings: [binding1],
          revokedBindingIds: ["b-1"], // b-1 revoked!
          activeRunId: binding1.runId,
          activeMainKey: strongKey,
          observerEpoch: "epoch-1",
        },
      });
      expect(snapRevokedPrev.progress.runId).toBeNull();
      expect(snapRevokedPrev.progress.bindingIds).toHaveLength(0);
    });

    it('T5-I-04 (fix-3): queue candidate with missing or unrelated sourceId in statusFileLinkage fails closed despite unrelated waiting status record', () => {
      const queueKey: ProcessKey = { hostBootId: 'boot-1', pid: 7777, startTicks: '4444' };
      const taskWithMultiStatus: TaskRegistration = {
        ...task,
        sources: [
          ...task.sources,
          { sourceId: 'status-unrelated', kind: 'status_json', path: '/data2/cy/xzn/score/unrelated.json' },
        ],
      };
      const queueProc = {
        key: queueKey,
        role: 'queue' as const,
        cwd: '/home/cy',
        scriptEntry: task.entryPaths[0],
        observedAt: '2026-10-20T00:00:00.000Z',
        roleEvidence: 'exact_script_entry' as const,
        directWriterSourceIds: [],
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      };
      const taskObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [
          {
            sourceId: 'status-unrelated',
            observedAt: '2026-10-20T00:00:00.000Z',
            fileIdentity: null,
            eofBytes: '100',
            permission: 'readable',
            exists: true,
            statusValues: { waiting: true, state: 'queued' },
            heldByRegisteredProcess: null,
            errorCode: null,
            phase: null,
          },
        ],
        processes: [queueProc],
      };

      // statusFileLinkage omits sourceId and observedAt -> must not match unrelated status source
      const snap = projectTask(null, {
        task: taskWithMultiStatus,
        taskObservation: taskObs,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
        statusFileLinkage: { currentInstanceKey: queueKey, sequence: 1 },
      });
      expect(snap.lifecycle).not.toBe('queued');
      expect(snap.processes.queue).toBeNull();
    });

    it('T5-I-05 (fix-3): stale or disconnected host observation with cached trainer process cannot grant fresh running; preserves previous state as stale with original timestamp', () => {
      const candidateWithWriter = {
        key: strongKey,
        role: 'trainer' as const,
        cwd: '/data2/cy/xzn',
        scriptEntry: task.entryPaths[0],
        observedAt: '2026-10-20T00:00:00.000Z',
        roleEvidence: 'exact_entry_and_direct_writer_fd' as const,
        directWriterSourceIds: ['log'],
        writerSourceEvidence: {
          log: { fileIdentity: { dev: '1', inode: '1' }, eofBytes: '100' },
        },
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      };
      const running = makeRunningEvidence();
      const prevRunningSnapshot = projectTask(null, {
        task,
        taskObservation: running.taskObservation,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
        bindingState: running.bindingState,
        outputSamples: { log: { sourceId: 'log', generation: 'gen-evidence', fileIdentity: { dev: '1', inode: '1' }, startOffset: '0', endOffset: String(new TextEncoder().encode('[score] step 100').length), observedAt: '2026-10-20T00:00:00.000Z', text: '[score] step 100' } },
      });
      expect(prevRunningSnapshot.lifecycle).toBe('running');

      // Now host is disconnected and stale at a later time
      const disconnectedHostObs: HostObservation = {
        hostId,
        freshness: 'stale',
        observedAt: '2026-10-20T00:00:10.000Z',
        phase: null,
        connection: 'disconnected',
        scanComplete: false,
        hostBootId: null,
        errorCode: 'CONNECT_FAILED',
      };
      const taskObsCached: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:10.000Z',
        freshness: 'stale',
        scanComplete: false,
        processScanError: 'scan_aborted',
        phase: null,
        errorCode: 'TASK_SCAN_FAILED',
       sources: [
         {
           sourceId: 'log',
           observedAt: '2026-10-20T00:00:10.000Z',
           fileIdentity: { dev: '1', inode: '1' },
           eofBytes: '100',
           permission: 'readable',
           exists: true,
           evidenceComplete: true,
           statusValues: null,
           heldByRegisteredProcess: null,
           errorCode: null,
           phase: null,
         },
       ],
       processes: [{ ...candidateWithWriter, observedAt: '2026-10-20T00:00:10.000Z' }], // cached process
      };

      const snap = projectTask(prevRunningSnapshot, {
        task,
        taskObservation: taskObsCached,
        hostObservation: disconnectedHostObs,
        observedAt: '2026-10-20T00:00:10.000Z',
      });
      expect(snap.freshness).toBe('stale');
      expect(snap.statusObservedAt).toBe('2026-10-20T00:00:00.000Z'); // original timestamp preserved, not renewed from failed poll
      expect(snap.confidence).toBe('low');
    });

    it('T5-I-06 (fix-3): projectTask rejects input.progress whose binding has mismatched mainProcessKey or source', () => {
      const candidateWithWriter = {
        key: strongKey,
        role: 'trainer' as const,
        cwd: '/data2/cy/xzn',
        scriptEntry: task.entryPaths[0],
        observedAt: '2026-10-20T00:00:00.000Z',
        roleEvidence: 'exact_entry_and_direct_writer_fd' as const,
        directWriterSourceIds: ['log'],
        writerSourceEvidence: {
          log: { fileIdentity: { dev: '1', inode: '1' }, eofBytes: '100' },
        },
        writerEvidenceComplete: true,
        evidenceComplete: true,
        interpreterFlags: [],
      };
      const taskObs: TaskObservation = {
        taskId,
        hostId,
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        scanComplete: true,
        processScanError: null,
        phase: null,
        errorCode: null,
        sources: [
          {
            sourceId: 'log',
            observedAt: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '1' },
            eofBytes: '100',
            permission: 'readable',
            exists: true,
            statusValues: null,
            heldByRegisteredProcess: null,
            errorCode: null,
           evidenceComplete: true,
            phase: null,
          },
        ],
        processes: [candidateWithWriter],
      };
      const wrongMainKey: ProcessKey = { hostBootId: 'boot-1', pid: 9999, startTicks: '9999' };
      const bindingMismatchedKey: RunBinding = {
        bindingId: 'b-mismatched-key',
        runId: makeRunId(hostId, taskId, strongKey),
        mainProcessKey: wrongMainKey, // wrong main key!
        sourceId: 'log',
        generation: 'gen-1',
        fromOffset: '0',
        throughOffset: '1000',
        evidenceKind: 'observed_direct_writer',
        observerEpoch: 'epoch-1',
        observedAt: '2026-10-20T00:00:00.000Z',
      };
      const inputProg: Progress = {
        observedAt: '2026-10-20T00:00:00.000Z',
        freshness: 'fresh',
        runId: makeRunId(hostId, taskId, strongKey),
        lastStepIndex: 100,
        bindingIds: ['b-mismatched-key'],
        baselineEvidenceId: null,
        resumeCheckpointIndex: null,
        firstLoopIndex: null,
        global: { completedCount: null, targetCount: null, fraction: null, unit: 'unknown', verified: false, sourceId: null },
        session: { completedCount: 100, targetCount: 200, fraction: 0.5, unit: 'completed_iterations', verified: true, sourceId: 'log' },
        configuredTarget: null,
        iterationsPerSecond: null,
        etaSeconds: null,
      };

      const snap = projectTask(null, {
        task,
        taskObservation: taskObs,
        hostObservation: hostObs,
        observedAt: '2026-10-20T00:00:00.000Z',
        bindingState: {
          windows: [],
          bindings: [bindingMismatchedKey],
          revokedBindingIds: [],
          activeRunId: makeRunId(hostId, taskId, strongKey),
          activeMainKey: strongKey,
          observerEpoch: 'epoch-1',
        },
        progress: inputProg,
      });

      expect(snap.progress.runId).toBeNull();
      expect(snap.progress.bindingIds).toHaveLength(0);
      expect(snap.progress.session.completedCount).toBeNull();
    });
  });

  describe('Group C: Checkpoints and Resources (T5-I-10, T5-I-11)', () => {
    describe('T5-I-10 Checkpoints', () => {
      it('fails stability when fileIdentity (dev/inode) changes despite identical size and mtime', () => {
        const cp1 = evaluateCheckpoint(
          null,
          {
            path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
            sizeBytes: '1048576000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '2' },
            scanComplete: true,
          },
          '2026-10-20T00:00:00.000Z'
        );
        expect(cp1.evidence).toBe('file_found');

        const cp2 = evaluateCheckpoint(
          cp1,
          {
            path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
            sizeBytes: '1048576000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '3', inode: '4' },
            scanComplete: true,
          },
          '2026-10-20T00:00:16.000Z'
        );
        expect(cp2.evidence).toBe('file_found');
      });

      it('fails stability when scanComplete is false', () => {
        const cp1 = evaluateCheckpoint(
          null,
          {
            path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
            sizeBytes: '1048576000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '2' },
            scanComplete: true,
          },
          '2026-10-20T00:00:00.000Z'
        );

        const cp2 = evaluateCheckpoint(
          cp1,
          {
            path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
            sizeBytes: '1048576000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '2' },
            scanComplete: false,
          },
          '2026-10-20T00:00:16.000Z'
        );
        expect(cp2.evidence).not.toBe('file_stable_observed');
      });

      it('does not reset elapsed stability baseline on frequent polls under 15 seconds', () => {
        const cp1 = evaluateCheckpoint(
          null,
          {
            path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
            sizeBytes: '1048576000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '2' },
            scanComplete: true,
          },
          '2026-10-20T00:00:00.000Z'
        );

        const cp2 = evaluateCheckpoint(
          cp1,
          {
            path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
            sizeBytes: '1048576000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '2' },
            scanComplete: true,
          },
          '2026-10-20T00:00:05.000Z'
        );
        expect(cp2.evidence).toBe('file_found');

        const cp3 = evaluateCheckpoint(
          cp2,
          {
            path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
            sizeBytes: '1048576000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '2' },
            scanComplete: true,
          },
          '2026-10-20T00:00:16.000Z'
        );
        expect(cp3.evidence).toBe('file_stable_observed');
      });

      it('extracts step index only from supported checkpoint patterns, rejecting arbitrary first numbers', () => {
        const cpSupported = evaluateCheckpoint(
          null,
          {
            path: '/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt',
            sizeBytes: '1000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '1' },
            scanComplete: true,
          },
          '2026-10-20T00:00:00.000Z'
        );
        expect(cpSupported.fileStepIndex).toBe(30000);
        expect(cpSupported.stepSource).toBe('filename');

        const cpUnsupported = evaluateCheckpoint(
          null,
          {
            path: '/data2/cy/xzn/score/checkpoints/experiment_run1_epoch_02_weight.pt',
            sizeBytes: '1000',
            mtime: '2026-10-20T00:00:00.000Z',
            fileIdentity: { dev: '1', inode: '1' },
            scanComplete: true,
          },
          '2026-10-20T00:00:00.000Z'
        );
        expect(cpUnsupported.fileStepIndex).toBeNull();
        expect(cpUnsupported.stepSource).toBeNull();
      });

      it("T5-I-10: incomplete prior scan cannot serve as time anchor for later complete scan", () => {
        const cp1Incomplete = evaluateCheckpoint(
          null,
          {
            path: "/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt",
            sizeBytes: "1048576000",
            mtime: "2026-10-20T00:00:00.000Z",
            fileIdentity: { dev: "1", inode: "2" },
            scanComplete: false, // incomplete prior scan!
          },
          "2026-10-20T00:00:00.000Z"
        );
        expect(cp1Incomplete.evidence).toBe("file_found");
        expect(cp1Incomplete.firstStableObservedAt).toBeNull();

        // 16s later, a complete scan is performed. It must NOT promote to stable by falling back to cp1.observedAt!
        const cp2Complete = evaluateCheckpoint(
          cp1Incomplete,
          {
            path: "/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt",
            sizeBytes: "1048576000",
            mtime: "2026-10-20T00:00:00.000Z",
            fileIdentity: { dev: "1", inode: "2" },
            scanComplete: true,
          },
          "2026-10-20T00:00:16.000Z"
        );
        expect(cp2Complete.evidence).toBe("file_found");
        expect(cp2Complete.firstStableObservedAt).toBe("2026-10-20T00:00:16.000Z");

        // Only after another 16s of complete observation (at 32s) does it promote to stable!
        const cp3Complete = evaluateCheckpoint(
          cp2Complete,
          {
            path: "/data2/cy/xzn/score/checkpoints/checkpoint-30000.pt",
            sizeBytes: "1048576000",
            mtime: "2026-10-20T00:00:00.000Z",
            fileIdentity: { dev: "1", inode: "2" },
            scanComplete: true,
          },
          "2026-10-20T00:00:32.000Z"
        );
        expect(cp3Complete.evidence).toBe("file_stable_observed");
      });
    });

    describe('T5-I-11 Resources', () => {
      it('rejects process metrics when keyBeforeSample or keyAfterSample is missing even with strong processKey', () => {
        const sampleMissingBefore: ResourceSampleInput = {
          source: 'proc',
          name: 'cpu_utilization',
          unit: 'percent_one_cpu',
          value: 120.5,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'process',
          processKey: strongKey,
          keyBeforeSample: null,
          keyAfterSample: strongKey,
        };
        const sampleMissingAfter: ResourceSampleInput = {
          source: 'proc',
          name: 'cpu_utilization',
          unit: 'percent_one_cpu',
          value: 120.5,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'process',
          processKey: strongKey,
          keyBeforeSample: strongKey,
          keyAfterSample: null,
        };
        expect(projectResources([sampleMissingBefore])).toHaveLength(0);
        expect(projectResources([sampleMissingAfter])).toHaveLength(0);
      });

      it('rejects device metrics missing deviceId or empty string', () => {
        const sampleMissingDevice: ResourceSampleInput = {
          source: 'nvidia-smi',
          name: 'gpu_utilization',
          unit: 'percent_device',
          value: 75,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'device',
          deviceId: null,
        };
        const sampleEmptyDevice: ResourceSampleInput = {
          source: 'nvidia-smi',
          name: 'gpu_utilization',
          unit: 'percent_device',
          value: 75,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'device',
          deviceId: '   ',
        };
        expect(projectResources([sampleMissingDevice])).toHaveLength(0);
        expect(projectResources([sampleEmptyDevice])).toHaveLength(0);
      });

      it('rejects non-finite values (NaN and Infinity)', () => {
        const sampleNaN: ResourceSampleInput = {
          source: 'proc',
          name: 'cpu_utilization',
          unit: 'percent_one_cpu',
          value: NaN,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'process',
          processKey: strongKey,
          keyBeforeSample: strongKey,
          keyAfterSample: strongKey,
        };
        const sampleInf: ResourceSampleInput = {
          source: 'nvidia-smi',
          name: 'gpu_utilization',
          unit: 'percent_device',
          value: Infinity,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'device',
          deviceId: 'gpu-0',
        };
        expect(projectResources([sampleNaN])).toHaveLength(0);
        expect(projectResources([sampleInf])).toHaveLength(0);
      });

      it('computes freshness from explicit now and sampling TTL instead of hardcoded fresh', () => {
        const sample: ResourceSampleInput = {
          source: 'nvidia-smi',
          name: 'gpu_utilization',
          unit: 'percent_device',
          value: 50,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'device',
          deviceId: 'gpu-0',
        };
        const metrics = projectResources([sample], { now: '2026-10-20T00:01:00.000Z' });
        expect(metrics).toHaveLength(1);
        expect(metrics[0].freshness).toBe('stale');
      });

      it("T5-I-11: requires registeredKeys (empty set authorizes zero processes) and explicit now (missing/future now cannot default fresh)", () => {
        const procSample: ResourceSampleInput = {
          source: "proc",
          name: "cpu_utilization",
          unit: "percent_one_cpu",
          value: 85.0,
          observedAt: "2026-10-20T00:00:00.000Z",
          scope: "process",
          processKey: strongKey,
          keyBeforeSample: strongKey,
          keyAfterSample: strongKey,
        };

        // 1. Empty registeredKeys authorizes ZERO processes
        const emptyRegistered = projectResources([procSample], {
          registeredKeys: [],
          now: "2026-10-20T00:00:05.000Z",
        });
        expect(emptyRegistered).toHaveLength(0);

        // 2. Missing registeredKeys authorizes ZERO processes
        const missingRegistered = projectResources([procSample], {
          now: "2026-10-20T00:00:05.000Z",
        });
        expect(missingRegistered).toHaveLength(0);

        // 3. Positive: Matching registered key with explicit now yields metric
        const validProc = projectResources([procSample], {
          registeredKeys: [strongKey],
          now: "2026-10-20T00:00:05.000Z",
        });
        expect(validProc).toHaveLength(1);
        expect(validProc[0].freshness).toBe("fresh");

        // 4. Missing explicit now cannot default fresh
        const devSample: ResourceSampleInput = {
          source: "nvidia-smi",
          name: "gpu_utilization",
          unit: "percent_device",
          value: 60,
          observedAt: "2026-10-20T00:00:00.000Z",
          scope: "device",
          deviceId: "gpu-0",
        };
        const noNowResult = projectResources([devSample]);
        // Missing now must not default fresh
        expect(noNowResult).toHaveLength(0);

        // 5. Future timestamp (> now + 5000ms) is rejected
        const futureResult = projectResources([devSample], {
          now: "2026-10-19T00:00:00.000Z", // 1 day before sample
        });
        expect(futureResult).toHaveLength(0);
      });

      it('T5-I-11 (fix-3): rejects invalid TTL (NaN, negative, zero) and samples ahead of now (even +100ms without 5s grace)', () => {
        const procSample: ResourceSampleInput = {
          source: 'proc',
          name: 'cpu_utilization',
          unit: 'percent_one_cpu',
          value: 85.0,
          observedAt: '2026-10-20T00:00:00.000Z',
          scope: 'process',
          processKey: strongKey,
          keyBeforeSample: strongKey,
          keyAfterSample: strongKey,
        };

        // 1. NaN TTL must refuse usable output (previously bypassed age check and stayed fresh)
        const nanTtlResult = projectResources([procSample], {
          registeredKeys: [strongKey],
          now: '2026-10-20T00:01:00.000Z', // 60s old
          ttlMs: NaN,
        });
        expect(nanTtlResult).toHaveLength(0);

        // 2. Negative TTL must refuse usable output
        const negTtlResult = projectResources([procSample], {
          registeredKeys: [strongKey],
          now: '2026-10-20T00:00:05.000Z',
          ttlMs: -1000,
        });
        expect(negTtlResult).toHaveLength(0);

        // 3. Zero TTL must refuse usable output
        const zeroTtlResult = projectResources([procSample], {
          registeredKeys: [strongKey],
          now: '2026-10-20T00:00:05.000Z',
          ttlMs: 0,
        });
        expect(zeroTtlResult).toHaveLength(0);

        // 4. Sample 100ms in the future (within old +5000ms grace window) must be rejected
        const futureSample: ResourceSampleInput = {
          ...procSample,
          observedAt: '2026-10-20T00:00:00.100Z', // +100ms ahead of now
        };
        const futureResult = projectResources([futureSample], {
          registeredKeys: [strongKey],
          now: '2026-10-20T00:00:00.000Z',
        });
        expect(futureResult).toHaveLength(0);
      });
    });

    describe('Group D: Connected domain-API fixture path', () => {
      it('executes connected pipeline through window establishment -> EOF advancement -> record affiliation -> progress projection -> measured rate -> task snapshot, and confirms failure/staleness when references break', () => {
        const connectedTask: TaskRegistration = {
          taskId: 'flow-training-e2e',
          hostId: 'lab-campus',
          label: 'Flow Training E2E Task',
          enabled: true,
          algorithm: 'flow',
          allowedDirectories: ['/data2/cy/xzn'],
          entryPaths: ['/data2/cy/xzn/train.py'],
          sources: [
            { sourceId: 'log', path: '/data2/cy/xzn/train.log', kind: 'log' },
            { sourceId: 'status', path: '/data2/cy/xzn/status.json', kind: 'status_json' },
          ],
          checkpointDirectories: ['/data2/cy/xzn/checkpoints'],
        };

        // 1. Role and window establishment
        const mainKey: ProcessKey = {
          hostBootId: 'boot-1',
          pid: 1234,
          startTicks: '56789',
        };
        const runId = makeRunId(connectedTask.hostId, connectedTask.taskId, mainKey);
        const fileIdentity = { dev: '100', inode: '200' };
        const initialBindingState = createInitialBindingState();

        const taskObs1: TaskObservation = {
          taskId: connectedTask.taskId,
          hostId: connectedTask.hostId,
          observedAt: '2026-10-20T00:00:00.000Z',
          freshness: 'fresh',
          scanComplete: true,
          processScanError: null,
          phase: null,
          errorCode: null,
          sources: [
            {
              sourceId: 'log',
              observedAt: '2026-10-20T00:00:00.000Z',
              fileIdentity,
              eofBytes: '1000',
              permission: 'readable',
              exists: true,
              statusValues: null,
              heldByRegisteredProcess: null,
              errorCode: null,
              evidenceComplete: true,
              phase: null,
            },
            { sourceId: 'status', observedAt: '2026-10-20T00:00:00.000Z', fileIdentity: { dev: '101', inode: '201' }, eofBytes: '1000', permission: 'readable', exists: true, statusValues: { taskId: connectedTask.taskId, hostId: connectedTask.hostId, sequence: 1, hostBootId: mainKey.hostBootId, pid: mainKey.pid, startTicks: mainKey.startTicks }, heldByRegisteredProcess: null, errorCode: null, evidenceComplete: true, phase: null },
          ],
          processes: [
            {
              key: mainKey,
              role: 'trainer',
              cwd: '/data2/cy/xzn',
              scriptEntry: '/data2/cy/xzn/train.py',
              observedAt: '2026-10-20T00:00:00.000Z',
              roleEvidence: 'exact_entry_and_direct_writer_fd',
              directWriterSourceIds: ['log'],
              writerEvidenceComplete: true,
              evidenceComplete: true,
              interpreterFlags: [],
              writerSourceEvidence: { log: { fileIdentity, eofBytes: '1000' } },
            },
          ],
        };

        const bindingState1 = updateBindings(initialBindingState, {
          task: connectedTask,
          taskId: connectedTask.taskId,
          hostId: connectedTask.hostId,
          observerEpoch: 'epoch-1',
          observedAt: '2026-10-20T00:00:00.000Z',
          taskObservation: taskObs1,
          outputSamples: {
            log: {
              sourceId: 'log', generation: 'gen-1', fileIdentity, startOffset: '0', endOffset: String(new TextEncoder().encode('80106/169999 [05:20<05:00, 2.50it/s]').length),
              observedAt: '2026-10-20T00:00:00.000Z', text: '80106/169999 [05:20<05:00, 2.50it/s]',
            },
          },
          sourceInfo: { log: { generation: 'gen-1', eofBytes: '1000', fileIdentity }, status: { generation: 'status-gen-1', eofBytes: '1000', fileIdentity: { dev: '101', inode: '201' } } },
        });
        expect(bindingState1.activeRunId).toBe(runId);
        expect(bindingState1.windows).toHaveLength(1);
        expect(bindingState1.windows[0].isOpen).toBe(true);

        // 2. Fresh valid EOF advancement
        const taskObs2: TaskObservation = {
          ...taskObs1,
          observedAt: '2026-10-20T00:00:02.000Z',
          sources: [
            {
              ...taskObs1.sources[0],
              observedAt: '2026-10-20T00:00:02.000Z',
              eofBytes: '2500',
            },
            { ...taskObs1.sources[1], observedAt: '2026-10-20T00:00:00.000Z' },
          ],
          processes: [
            {
              ...taskObs1.processes[0],
              observedAt: '2026-10-20T00:00:02.000Z',
              writerSourceEvidence: { log: { fileIdentity, eofBytes: '2500' } },
            },
          ],
        };

        const bindingState2 = updateBindings(bindingState1, {
          task: connectedTask,
          taskId: connectedTask.taskId,
          hostId: connectedTask.hostId,
          observerEpoch: 'epoch-1',
          observedAt: '2026-10-20T00:00:02.000Z',
          taskObservation: taskObs2,
          outputSamples: { log: { sourceId: 'log', generation: 'gen-1', fileIdentity, startOffset: '0', endOffset: String(new TextEncoder().encode('80106/169999 [05:20<05:00, 2.50it/s]').length), observedAt: '2026-10-20T00:00:02.000Z', text: '80106/169999 [05:20<05:00, 2.50it/s]' } },
          sourceInfo: { log: { generation: 'gen-1', eofBytes: '2500', fileIdentity } },
        });
        expect(bindingState2.bindings).toHaveLength(1);
        const confirmedBinding = bindingState2.bindings[0];
        expect(confirmedBinding.fromOffset).toBe('1000');
        expect(confirmedBinding.throughOffset).toBe('2500');

        // 3. Complete record affiliation
        const rawEvent: LogEvent = {
          version: 1,
          eventId: 'ev-flow-1',
          taskId: connectedTask.taskId,
          sourceId: 'log',
          generation: 'gen-1',
          kind: 'line',
          startOffset: '1500',
          endOffset: '2500',
          ingestedAt: '2026-10-20T00:00:02.000Z',
          text: '80000/169999 [05:20<05:00, 2.50it/s]',
          reason: null,
          displayTruncated: false,
          recordComplete: true,
          prefixIncomplete: false,
          runId: null,
          bindingId: null,
        };
        const ingestedRecord1 = ingestCompleteRecord(rawEvent, bindingState2);
        const affiliatedEvent = ingestedRecord1.event;
        expect(affiliatedEvent.runId).toBe(runId);
        expect(affiliatedEvent.bindingId).toBe(confirmedBinding.bindingId);

        const taskObs3: TaskObservation = {
          ...taskObs2,
          observedAt: '2026-10-20T00:00:04.000Z',
          sources: [
            { ...taskObs2.sources[0], observedAt: '2026-10-20T00:00:04.000Z', eofBytes: '3500' },
            taskObs2.sources[1],
          ],
          processes: [{ ...taskObs2.processes[0], observedAt: '2026-10-20T00:00:04.000Z', writerSourceEvidence: { log: { fileIdentity, eofBytes: '3500' } } }],
        };
        const bindingState3 = updateBindings(ingestedRecord1.state, {
          task: connectedTask, taskId: connectedTask.taskId, hostId: connectedTask.hostId,
          observerEpoch: 'epoch-1', observedAt: '2026-10-20T00:00:04.000Z', taskObservation: taskObs3,
          outputSamples: { log: { sourceId: 'log', generation: 'gen-1', fileIdentity, startOffset: '0', endOffset: String(new TextEncoder().encode('80106/169999 [05:20<05:00, 2.50it/s]').length), observedAt: '2026-10-20T00:00:04.000Z', text: '80106/169999 [05:20<05:00, 2.50it/s]' } },
          sourceInfo: { log: { generation: 'gen-1', eofBytes: '3500', fileIdentity } },
        });
        const rawEvent2: LogEvent = { ...rawEvent, eventId: 'ev-flow-2', startOffset: '2500', endOffset: '3500', ingestedAt: '2026-10-20T00:00:04.000Z', text: '80100/169999 [05:10<04:50, 2.50it/s]' };
        const ingestedRecord2 = ingestCompleteRecord(rawEvent2, bindingState3);
        const affiliatedEvent2 = ingestedRecord2.event;
        expect(affiliatedEvent2.runId).toBe(runId);
        expect(affiliatedEvent2.bindingId).toBe(confirmedBinding.bindingId);
        // 4. Progress projection with valid measured rate
        const rateSample1: ProgressRateSample = {
          observedAt: '2026-10-20T00:00:08.000Z',
          completedCount: 80000,
          eventId: affiliatedEvent.eventId,
          runId,
          windowId: bindingState2.windows[0].windowId,
          bindingId: confirmedBinding.bindingId,
          sourceId: 'log',
          generation: 'gen-1',
          startOffset: '1500',
          endOffset: '2500',
        };
        const rateSample2: ProgressRateSample = {
          observedAt: '2026-10-20T00:00:10.000Z',
          completedCount: 80100,
          eventId: affiliatedEvent2.eventId,
          runId,
          windowId: bindingState2.windows[0].windowId,
          bindingId: confirmedBinding.bindingId,
          sourceId: 'log',
          generation: 'gen-1',
          startOffset: '2500',
          endOffset: '3500',
        };
        const structuredContent = JSON.stringify({ taskId: connectedTask.taskId, hostId: connectedTask.hostId, sequence: 1, hostBootId: mainKey.hostBootId, pid: mainKey.pid, startTicks: mainKey.startTicks, resume_checkpoint_index: 30000, total_steps: 200000, target_meaning: 'exclusive_index' });
        const canonicalState = ingestStructuredBaselineRead(ingestedRecord2.state, connectedTask, taskObs1, {
          evidenceId: 'base-1', sourceId: 'status', generation: 'status-gen-1', fileIdentity: { dev: '101', inode: '201' },
          observedAt: '2026-10-20T00:00:00.000Z', startOffset: '0', endOffset: String(new TextEncoder().encode(structuredContent).length), rawContent: structuredContent,
        });
        const wrongIdentityRead = ingestStructuredBaselineRead(ingestedRecord2.state, connectedTask, taskObs1, {
          evidenceId: 'base-wrong-identity', sourceId: 'status', generation: 'status-gen-1', fileIdentity: { dev: 'foreign', inode: '201' },
          observedAt: '2026-10-20T00:00:00.000Z', startOffset: '0', endOffset: String(new TextEncoder().encode(structuredContent).length), rawContent: structuredContent,
        });
        expect(wrongIdentityRead.baselineRead).toBeNull();
        const wrongGenerationRead = ingestStructuredBaselineRead(ingestedRecord2.state, connectedTask, taskObs1, {
          evidenceId: 'base-wrong-generation', sourceId: 'status', generation: 'invented-generation', fileIdentity: { dev: '101', inode: '201' },
          observedAt: '2026-10-20T00:00:00.000Z', startOffset: '0', endOffset: String(new TextEncoder().encode(structuredContent).length), rawContent: structuredContent,
        });
        expect(wrongGenerationRead.baselineRead).toBeNull();
        const oldInstanceContent = JSON.stringify({ taskId: connectedTask.taskId, hostId: connectedTask.hostId, sequence: 1, hostBootId: 'boot-old', pid: mainKey.pid, startTicks: mainKey.startTicks, resume_checkpoint_index: 30000, total_steps: 200000, target_meaning: 'exclusive_index' });
        const oldInstanceRead = ingestStructuredBaselineRead(ingestedRecord2.state, connectedTask, taskObs1, {
          evidenceId: 'base-old-instance', sourceId: 'status', generation: 'status-gen-1', fileIdentity: { dev: '101', inode: '201' },
          observedAt: '2026-10-20T00:00:00.000Z', startOffset: '0', endOffset: String(new TextEncoder().encode(oldInstanceContent).length), rawContent: oldInstanceContent,
        });
        expect(oldInstanceRead.baselineRead).toBeNull();
        const mismatchedStatusObservation = { ...taskObs1, sources: taskObs1.sources.map((source) => source.sourceId === 'status' ? { ...source, statusValues: { ...source.statusValues!, sequence: 2 } } : source) };
        const statusMismatchRead = ingestStructuredBaselineRead(ingestedRecord2.state, connectedTask, mismatchedStatusObservation, {
          evidenceId: 'base-status-mismatch', sourceId: 'status', generation: 'status-gen-1', fileIdentity: { dev: '101', inode: '201' },
          observedAt: '2026-10-20T00:00:00.000Z', startOffset: '0', endOffset: String(new TextEncoder().encode(structuredContent).length), rawContent: structuredContent,
        });
        expect(statusMismatchRead.baselineRead).toBeNull();
        const unregisteredSourceRead = ingestStructuredBaselineRead(ingestedRecord2.state, connectedTask, taskObs1, {
          evidenceId: 'base-wrong-source', sourceId: 'log', generation: 'gen-1', fileIdentity, observedAt: '2026-10-20T00:00:00.000Z',
          startOffset: '0', endOffset: String(new TextEncoder().encode(structuredContent).length), rawContent: structuredContent,
        });
        expect(unregisteredSourceRead.baselineRead).toBeNull();
        const contradictoryMeaning = JSON.stringify({ taskId: connectedTask.taskId, hostId: connectedTask.hostId, sequence: 1, hostBootId: mainKey.hostBootId, pid: mainKey.pid, startTicks: mainKey.startTicks, resume_checkpoint_index: 30000, total_steps: 200000, target_meaning: 'count' });
        const contradictoryRead = ingestStructuredBaselineRead(ingestedRecord2.state, connectedTask, taskObs1, {
          evidenceId: 'base-count-not-index', sourceId: 'status', generation: 'status-gen-1', fileIdentity: { dev: '101', inode: '201' },
          observedAt: '2026-10-20T00:00:00.000Z', startOffset: '0', endOffset: String(new TextEncoder().encode(contradictoryMeaning).length), rawContent: contradictoryMeaning,
        });
        expect(contradictoryRead.baselineRead).toBeNull();
        const progressEvidence: ProgressEvidence = {
          taskId: connectedTask.taskId,
          hostId: connectedTask.hostId,
          observedAt: '2026-10-20T00:00:10.000Z',
          freshness: 'fresh',
          algorithm: 'flow',
          currentRun: { runId, mainProcessKey: mainKey },
          bindings: bindingState2.bindings,
          boundEvents: [affiliatedEvent, affiliatedEvent2],
          taskRegistration: connectedTask,
          sourceObservations: [{ sourceId: 'status', generation: 'status-gen-1', fileIdentity: { dev: '101', inode: '201' }, eofBytes: '100', observedAt: '2026-10-20T00:00:00.000Z' }],
          taskObservation: taskObs1,
          windows: bindingState2.windows,
          bindingState: canonicalState,
          configuredTarget: { value: 200000, meaning: 'exclusive_index' },
        };
        const progress = deriveProgress(progressEvidence);
        expect(progress.freshness).toBe('fresh');
        expect(progress.iterationsPerSecond).toBe(50);
        expect(progress.etaSeconds).toBe(1798);

        // 5. Task snapshot projection
        const hostObsRunning: HostObservation = {
          hostId: connectedTask.hostId,
          observedAt: '2026-10-20T00:00:10.000Z',
          freshness: 'fresh',
          connection: 'connected',
          scanComplete: true,
          hostBootId: 'boot-1',
          phase: null,
          errorCode: null,
        };
        const taskEv: TaskEvidence = {
          task: connectedTask,
          taskObservation: taskObs3,
          hostObservation: hostObsRunning,
          observedAt: '2026-10-20T00:00:10.000Z',
          bindingState: canonicalState,
          outputSamples: { log: { sourceId: 'log', generation: 'gen-1', fileIdentity, startOffset: '0', endOffset: String(new TextEncoder().encode('80106/169999 [05:20<05:00, 2.50it/s]').length), observedAt: '2026-10-20T00:00:04.000Z', text: '80106/169999 [05:20<05:00, 2.50it/s]' } },
          progressEvidence,
          progress,
        };
        const snapshot = projectTask(null, taskEv);
        expect(snapshot.lifecycle).toBe('running');
        expect(snapshot.confidence).toBe('high');
        expect(snapshot.progress?.iterationsPerSecond).toBe(50);
        expect(snapshot.freshness).toBe('fresh');

        const forgedProjection = projectTask(null, {
          ...taskEv,
          progressEvidence: {
            ...progressEvidence,
            algorithm: 'score',
            bindings: [{ ...confirmedBinding, fromOffset: '0', throughOffset: '999999' }],
            boundEvents: [{ ...affiliatedEvent2, text: '999999/999999 [00:00<00:00, 999it/s]' }],
            baselineEvidence: { evidenceId: 'fake', runId, resumeCheckpointIndex: 0 } as any,
            rateSamples: [{ observedAt: taskEv.observedAt, completedCount: 999999, runId, windowId: 'fake', bindingId: 'fake' }],
          },
          progress: { ...progress, session: { ...progress.session, completedCount: 999999 }, iterationsPerSecond: 999 },
        });
        expect(forgedProjection.progress?.session.completedCount).toBe(80100);
        expect(forgedProjection.progress?.iterationsPerSecond).toBe(50);
        expect(forgedProjection.progress?.etaSeconds).toBe(1798);

        // 6. Break supporting references and verify:
        // Case 6A: Break supporting generation in rate sample -> rate becomes null
        const brokenRateEv: ProgressEvidence = {
          ...progressEvidence,
          rateSamples: [
            rateSample1,
            { ...rateSample2, generation: 'mismatched-gen' },
          ],
          bindingState: {
            ...canonicalState,
            completeRecords: (canonicalState.completeRecords ?? []).map((event) => event.eventId === affiliatedEvent2.eventId ? { ...event, generation: 'mismatched-gen' } : event),
          },
        };
        const brokenProgress = deriveProgress(brokenRateEv);
        expect(brokenProgress.iterationsPerSecond).toBeNull();
        expect(brokenProgress.etaSeconds).toBeNull();

        const replayedWithoutWriterAdvance = deriveProgress({ ...progressEvidence, bindingState: { ...canonicalState, polls: [] } });
        expect(replayedWithoutWriterAdvance.iterationsPerSecond).toBeNull();
        expect(replayedWithoutWriterAdvance.etaSeconds).toBeNull();

        // Case 6B: Break host scan completeness -> snapshot retains previous state as stale
        const brokenScanTaskEv: TaskEvidence = {
          ...taskEv,
          hostObservation: {
            ...hostObsRunning,
            scanComplete: false,
          },
          observedAt: '2026-10-20T00:00:20.000Z',
        };
        const retainedStaleSnapshot = projectTask(snapshot, brokenScanTaskEv);
        expect(retainedStaleSnapshot.freshness).toBe('stale');
        expect(retainedStaleSnapshot.lifecycle).toBe('running');
        expect(retainedStaleSnapshot.statusObservedAt).toBe(snapshot.statusObservedAt);
        expect(retainedStaleSnapshot.progress?.freshness).toBe('stale');
        expect(retainedStaleSnapshot.progress?.session.completedCount).toBe(80100);
        expect(retainedStaleSnapshot.progress?.observedAt).toBe(affiliatedEvent2.ingestedAt);
        expect(retainedStaleSnapshot.progress?.iterationsPerSecond).toBeNull();
        expect(retainedStaleSnapshot.progress?.etaSeconds).toBeNull();

        // Without prior snapshot, scan failure yields unconfirmed
        const unconfirmedSnapshot = projectTask(null, brokenScanTaskEv);
        expect(unconfirmedSnapshot.lifecycle).toBe('unconfirmed');
        expect(unconfirmedSnapshot.confidence).toBe('low');

        // Case 6C: Record outside active window / binding cannot be affiliated
        const outOfRangeEvent: LogEvent = {
          ...rawEvent,
          eventId: 'ev-out-of-range',
          startOffset: '6000',
          endOffset: '7000',
        };
        const unaffiliatedEvent = bindCompleteRecord(outOfRangeEvent, bindingState2);
        expect(unaffiliatedEvent.runId).toBeNull();
        expect(unaffiliatedEvent.bindingId).toBeNull();
      });
    });
  });
});
