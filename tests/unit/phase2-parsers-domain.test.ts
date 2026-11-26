import { describe, expect, it } from 'vitest';
import { parseGenericRecord } from '../../src/parsers/generic';
import { stripAnsi } from '../../src/parsers/ansi';
import { projectTask } from '../../src/domain/lifecycle';
import { createInitialBindingState, updateBindings, ingestCompleteRecord } from '../../src/domain/bindings';
import { deriveProgress } from '../../src/domain/progress';
import { evaluateCheckpoint } from '../../src/domain/checkpoints';
import { makeRunId } from '../../src/domain/identity';
import { validateRegistry } from '../../src/shared/validate';
import type { LogEvent, ProcessKey, Registry, TaskRegistration } from '../../src/shared/contracts';
import type { HostObservation, TaskObservation } from '../../src/transport/types';

describe('Phase 2 universal ML parsers & domain semantics', () => {
  it('parses HuggingFace Python dict, Lightning with val_loss, YOLO tabular, ANSI colors, and tqdm arbitrary units', () => {
    // 1. HuggingFace Transformers Python dict
    const hf = parseGenericRecord("{'loss': 0.5234, 'grad_norm': 1.21, 'learning_rate': 1e-05, 'epoch': 0.25}");
    expect(hf.isTrainingOutput).toBe(true);
    expect(hf.unit).toBe('epoch');
    expect(hf.current).toBeCloseTo(0.25);
    expect(hf.scalars).toMatchObject({ loss: 0.5234, grad_norm: 1.21, lr: 1e-5 });

    // 2. PyTorch Lightning line containing BOTH train_loss and val_loss
    const pl = parseGenericRecord('Epoch 3: 100%|██████████| 500/500 [01:20<00:00, 6.25it/s, train_loss=0.25, val_loss=0.31]');
    expect(pl.isTrainingOutput).toBe(true);
    expect(pl.sessionCompletedCount).toBe(500);
    expect(pl.sessionTargetCount).toBe(500);
    expect(pl.scalars).toMatchObject({ train_loss: 0.25, val_loss: 0.31 });

    // 3. Ultralytics / YOLO tabular row
    const yolo = parseGenericRecord('      1/100      3.24G     1.123      0.845      1.012        64        640');
    expect(yolo.isTrainingOutput).toBe(true);
    expect(yolo.unit).toBe('epoch');
    expect(yolo.current).toBe(1);
    expect(yolo.total).toBe(100);
    expect(yolo.scalars?.box_loss).toBeCloseTo(1.123);

    // 4. ANSI colored log line
    const ansiLine = '\u001b[32mEpoch 4/20\u001b[0m | \u001b[1;33mloss=0.184\u001b[0m | lr=3e-4';
    expect(stripAnsi(ansiLine)).toBe('Epoch 4/20 | loss=0.184 | lr=3e-4');
    const ansiParsed = parseGenericRecord(ansiLine);
    expect(ansiParsed.isTrainingOutput).toBe(true);
    expect(ansiParsed.current).toBe(4);
    expect(ansiParsed.total).toBe(20);
    expect(ansiParsed.scalars).toMatchObject({ loss: 0.184, lr: 3e-4 });

    // 5. tqdm arbitrary units (img/s, tok/s, samples/s, ?it/s)
    const tqdmImg = parseGenericRecord('  40%|████      | 400/1000 [00:10<00:15, 40.5img/s]');
    expect(tqdmImg.isTrainingOutput).toBe(true);
    expect(tqdmImg.rate).toBeCloseTo(40.5);
    expect(tqdmImg.rateUnit).toBe('img/s');

    const tqdmUnknownRate = parseGenericRecord('   0%|          | 0/1000 [00:00<?, ?it/s]');
    expect(tqdmUnknownRate.isTrainingOutput).toBe(true);
    expect(tqdmUnknownRate.sessionCompletedCount).toBe(0);
    expect(tqdmUnknownRate.sessionTargetCount).toBe(1000);

    // 6. Non-finite NaN/Inf loss detection
    const nanRec = parseGenericRecord('step=42 loss=nan lr=1e-4');
    expect(nanRec.isTrainingOutput).toBe(true);
    expect(nanRec.nonFiniteLoss).toBe(true);

    // 7. Custom regex & JSON fields + ReDoS protection
    const custom = parseGenericRecord('CUSTOM_PROGRESS cur=75 tot=200 reward=12.5', 'log', {
      progressRegex: 'cur=(?<current>\\d+)\\s+tot=(?<total>\\d+)',
      metricRegexes: { reward: 'reward=([0-9.]+)' },
    });
    expect(custom.isTrainingOutput).toBe(true);
    expect(custom.current).toBe(75);
    expect(custom.total).toBe(200);
    expect(custom.scalars?.reward).toBeCloseTo(12.5);

    const badReg: Registry = {
      version: 2,
      revision: 0,
      hosts: [{ hostId: 'h1', label: 'H1', enabled: true, allowedRoots: ['/data'], target: { kind: 'local' } }],
      tasks: [{
        taskId: 't1', hostId: 'h1', label: 'T1', enabled: true, algorithm: 'PPO', logFormat: 'generic',
        customPatterns: { progressRegex: '(a+)+$' },
        allowedDirectories: ['/data'], entryPaths: ['train.py'],
        sources: [{ sourceId: 'log', kind: 'log', path: '/data/train.log' }], checkpointDirectories: [],
      }],
    };
    expect(() => validateRegistry(badReg)).toThrow('INVALID_REGISTRY');
  });

  it('keeps raw-mode tasks running and keeps slow-step (>60s silent) tasks running without downgrading to unconfirmed', () => {
    const mainKey: ProcessKey = { hostBootId: 'boot-1', pid: 4200, startTicks: '8888' };
    const hostObs = (at: string): HostObservation => ({
      hostId: 'h1', freshness: 'fresh', observedAt: at, phase: null,
      connection: 'connected', scanComplete: true, hostBootId: 'boot-1', errorCode: null,
    });
    const makeTaskObs = (at: string, eofBytes: string): TaskObservation => ({
      taskId: 't1', hostId: 'h1', observedAt: at, freshness: 'fresh', scanComplete: true,
      processScanError: null, phase: null, errorCode: null,
      processes: [{
        key: mainKey, role: 'trainer', cwd: '/data', scriptEntry: '/data/train.py',
        observedAt: at, roleEvidence: 'exact_entry_and_direct_writer_fd',
        directWriterSourceIds: ['log'],
        writerSourceEvidence: { log: { fileIdentity: { dev: '1', inode: '2' }, eofBytes } },
        writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [],
      }],
      sources: [{
        sourceId: 'log', observedAt: at, fileIdentity: { dev: '1', inode: '2' }, eofBytes,
        permission: 'readable', exists: true, statusValues: null, heldByRegisteredProcess: null,
        errorCode: null, evidenceComplete: true, phase: null,
      }],
    });

    // 1. Raw mode process stays running
    const rawTask: TaskRegistration = {
      taskId: 't1', hostId: 'h1', label: 'Raw', enabled: true, algorithm: 'Custom', logFormat: 'raw',
      allowedDirectories: ['/data'], entryPaths: ['/data/train.py'],
      sources: [{ sourceId: 'log', kind: 'log', path: '/data/train.log' }], checkpointDirectories: [],
    };
    const t0 = '2026-10-20T00:00:00.000Z';
    const rawSnap = projectTask(null, {
      task: rawTask, hostObservation: hostObs(t0), taskObservation: makeTaskObs(t0, '100'), observedAt: t0,
    });
    expect(rawSnap.lifecycle).toBe('running');
    expect(rawSnap.attributionConfidence).toBe('confirmed_process');

    // 2. Slow step / torch.compile silence > 90s keeps lifecycle === 'running' (NOT unconfirmed!)
    const genericTask: TaskRegistration = { ...rawTask, logFormat: 'generic' };
    const t1 = '2026-10-20T00:01:35.000Z'; // 95 seconds after last log record
    const snap0 = projectTask(null, {
      task: genericTask, hostObservation: hostObs(t0), taskObservation: makeTaskObs(t0, '100'), observedAt: t0,
    });
    expect(snap0.lifecycle).toBe('running');
    const snapSlow = projectTask(snap0, {
      task: genericTask, hostObservation: hostObs(t1), taskObservation: makeTaskObs(t1, '100'), observedAt: t1,
    });
    expect(snapSlow.lifecycle).toBe('running');
    expect(snapSlow.attributionConfidence).toBe('confirmed_process');
  });

  it('computes sliding-window rate and ETA for generic parser even across >30s slow steps', () => {
    const mainKey: ProcessKey = { hostBootId: 'boot-1', pid: 500, startTicks: '100' };
    const task: TaskRegistration = {
      taskId: 'gen-task', hostId: 'h1', label: 'LLM', enabled: true, algorithm: 'Qwen3', logFormat: 'generic',
      allowedDirectories: ['/data'], entryPaths: ['/data/train.py'],
      sources: [{ sourceId: 'log', kind: 'log', path: '/data/train.log' }], checkpointDirectories: [],
    };
    const fid = { dev: '1', inode: '10' };
    const line0 = 'step=40/1000 loss=1.8\n';
    const line1 = 'step=100/1000 loss=1.5\n';
    const line2 = 'step=160/1000 loss=1.2\n';
    const b0 = Buffer.byteLength(line0, 'utf8');
    const b1 = Buffer.byteLength(line1, 'utf8');
    const b2 = Buffer.byteLength(line2, 'utf8');

    const makeObs = (at: string, eof: string): TaskObservation => ({
      taskId: 'gen-task', hostId: 'h1', observedAt: at, freshness: 'fresh', scanComplete: true,
      processScanError: null, phase: null, errorCode: null,
      processes: [{
        key: mainKey, role: 'trainer', cwd: '/data', scriptEntry: '/data/train.py',
        observedAt: at, roleEvidence: 'exact_entry_and_direct_writer_fd',
        directWriterSourceIds: ['log'],
        writerSourceEvidence: { log: { fileIdentity: fid, eofBytes: eof } },
        writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [],
      }],
      sources: [{
        sourceId: 'log', observedAt: at, fileIdentity: fid, eofBytes: eof,
        permission: 'readable', exists: true, statusValues: null, heldByRegisteredProcess: null,
        errorCode: null, evidenceComplete: true, phase: null,
      }],
    });

    const t0 = '2026-10-20T00:00:00.000Z';
    const t1 = '2026-10-20T00:00:10.000Z';
    const t2 = '2026-10-20T00:01:10.000Z'; // 60 seconds later (exceeds legacy 30s cap!)

    let state = createInitialBindingState();
    // Open window at t0 (fromOffset = b0)
    const sample0Text = line0.trimEnd();
    state = updateBindings(state, {
      task, taskId: 'gen-task', hostId: 'h1', observerEpoch: 'ep-1', observedAt: t0,
      taskObservation: makeObs(t0, String(b0)),
      sourceInfo: { log: { generation: 'g1', eofBytes: String(b0), fileIdentity: fid } },
      outputSamples: {
        log: { sourceId: 'log', generation: 'g1', fileIdentity: fid, startOffset: '0', endOffset: String(b0), terminatorBytes: 1, observedAt: t0, text: sample0Text },
      },
    });
    // Advance EOF to include line1 (b0..b0+b1) at t1
    const sample1Text = line1.trimEnd();
    state = updateBindings(state, {
      task, taskId: 'gen-task', hostId: 'h1', observerEpoch: 'ep-1', observedAt: t1,
      taskObservation: makeObs(t1, String(b0 + b1)),
      sourceInfo: { log: { generation: 'g1', eofBytes: String(b0 + b1), fileIdentity: fid } },
      outputSamples: {
        log: { sourceId: 'log', generation: 'g1', fileIdentity: fid, startOffset: String(b0), endOffset: String(b0 + b1), terminatorBytes: 1, observedAt: t1, text: sample1Text },
      },
    });
    const ev1: LogEvent = {
      version: 1, eventId: 'e1', taskId: 'gen-task', sourceId: 'log', generation: 'g1',
      kind: 'line', startOffset: String(b0), endOffset: String(b0 + b1), ingestedAt: t1, text: sample1Text,
      reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false, runId: null, bindingId: null,
    };
    state = ingestCompleteRecord(ev1, state).state;

    // Advance EOF to include line2 (b0+b1..b0+b1+b2) at t2 (60s after t1 -> +60 steps in 60s = 1.0 step/s, remaining 840 -> ETA 840s)
    const sample2Text = line2.trimEnd();
    state = updateBindings(state, {
      task, taskId: 'gen-task', hostId: 'h1', observerEpoch: 'ep-1', observedAt: t2,
      taskObservation: makeObs(t2, String(b0 + b1 + b2)),
      sourceInfo: { log: { generation: 'g1', eofBytes: String(b0 + b1 + b2), fileIdentity: fid } },
      outputSamples: {
        log: { sourceId: 'log', generation: 'g1', fileIdentity: fid, startOffset: String(b0 + b1), endOffset: String(b0 + b1 + b2), terminatorBytes: 1, observedAt: t2, text: sample2Text },
      },
    });
    const ev2: LogEvent = {
      version: 1, eventId: 'e2', taskId: 'gen-task', sourceId: 'log', generation: 'g1',
      kind: 'line', startOffset: String(b0 + b1), endOffset: String(b0 + b1 + b2), ingestedAt: t2, text: sample2Text,
      reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false, runId: null, bindingId: null,
    };
    state = ingestCompleteRecord(ev2, state).state;

    const runId = makeRunId('h1', 'gen-task', mainKey);
    const prog = deriveProgress({
      taskId: 'gen-task', hostId: 'h1', observedAt: t2, freshness: 'fresh',
      algorithm: 'generic', currentRun: { runId, mainProcessKey: mainKey },
      bindings: [], boundEvents: [], bindingState: state,
    });
    expect(prog.current).toBe(160);
    expect(prog.total).toBe(1000);
    expect(prog.iterationsPerSecond).toBeCloseTo(1.0, 2);
    expect(prog.etaSeconds).toBe(840);
    expect(prog.scalars?.loss).toBeCloseTo(1.2);
  });

  it('evaluates directory checkpoints and infers terminal state without private status_json', () => {
    const ck1 = evaluateCheckpoint(null, {
      path: '/out/checkpoint-1500', name: 'checkpoint-1500', isDirectory: true, fileCount: 4,
      sizeBytes: '4096', mtime: '2026-10-20T00:00:00.000Z', fileIdentity: { dev: '1', inode: '55' },
      fileStepIndex: 1500, stepSource: 'metadata', metadata: { epoch: 3 }, scanComplete: true,
    }, '2026-10-20T00:00:00.000Z');
    expect(ck1.evidence).toBe('file_found');
    expect(ck1.isDirectory).toBe(true);
    expect(ck1.fileCount).toBe(4);
    expect(ck1.stepSource).toBe('metadata');

    const ck2 = evaluateCheckpoint(ck1, {
      path: '/out/checkpoint-1500', name: 'checkpoint-1500', isDirectory: true, fileCount: 4,
      sizeBytes: '4096', mtime: '2026-10-20T00:00:00.000Z', fileIdentity: { dev: '1', inode: '55' },
      fileStepIndex: 1500, stepSource: 'metadata', metadata: { epoch: 3 }, scanComplete: true,
    }, '2026-10-20T00:00:20.000Z');
    expect(ck2.evidence).toBe('file_stable_observed');

    // Terminal state inference when running process exits
    const mainKey: ProcessKey = { hostBootId: 'boot-1', pid: 777, startTicks: '10' };
    const task: TaskRegistration = {
      taskId: 't-exit', hostId: 'h1', label: 'Exit', enabled: true, algorithm: 'LLM', logFormat: 'generic',
      allowedDirectories: ['/data'], entryPaths: ['/data/train.py'],
      sources: [{ sourceId: 'log', kind: 'log', path: '/data/train.log' }], checkpointDirectories: [],
    };
    const t0 = '2026-10-20T00:00:00.000Z';
    const t1 = '2026-10-20T00:00:10.000Z';
    const hostObs: HostObservation = {
      hostId: 'h1', freshness: 'fresh', observedAt: t0, phase: null,
      connection: 'connected', scanComplete: true, hostBootId: 'boot-1', errorCode: null,
    };
    const runningSnap = projectTask(null, {
      task, hostObservation: hostObs, observedAt: t0,
      taskObservation: {
        taskId: 't-exit', hostId: 'h1', observedAt: t0, freshness: 'fresh', scanComplete: true,
        processScanError: null, phase: null, errorCode: null,
        processes: [{
          key: mainKey, role: 'trainer', cwd: '/data', scriptEntry: '/data/train.py',
          observedAt: t0, roleEvidence: 'exact_entry_and_direct_writer_fd',
          directWriterSourceIds: ['log'],
          writerSourceEvidence: { log: { fileIdentity: { dev: '1', inode: '2' }, eofBytes: '10' } },
          writerEvidenceComplete: true, evidenceComplete: true, interpreterFlags: [],
        }],
        sources: [{
          sourceId: 'log', observedAt: t0, fileIdentity: { dev: '1', inode: '2' }, eofBytes: '10',
          permission: 'readable', exists: true, statusValues: null, heldByRegisteredProcess: null,
          errorCode: null, evidenceComplete: true, phase: null,
        }],
      },
    });
    const emptyObs: TaskObservation = {
      taskId: 't-exit', hostId: 'h1', observedAt: t1, freshness: 'fresh', scanComplete: true,
      processScanError: null, phase: null, errorCode: null, processes: [], sources: [],
    };
    const hostObs1: HostObservation = { ...hostObs, observedAt: t1 };

    const crashed = projectTask(runningSnap, {
      task, hostObservation: hostObs1, taskObservation: emptyObs, observedAt: t1,
      tailLogLines: ['Traceback (most recent call last):', 'torch.OutOfMemoryError: CUDA out of memory'],
    });
    expect(crashed.lifecycle).toBe('failed');

    const completed = projectTask(runningSnap, {
      task, hostObservation: hostObs1, taskObservation: emptyObs, observedAt: t1,
      managedExitCode: 0, tailLogLines: ['Training completed.'],
    });
    expect(completed.lifecycle).toBe('completed');
    expect(completed.exitCode).toBe(0);

    const stoppedUnconfirmed = projectTask(runningSnap, {
      task, hostObservation: hostObs1, taskObservation: emptyObs, observedAt: t1,
      tailLogLines: ['step=42 loss=0.3'],
    });
    expect(stoppedUnconfirmed.lifecycle).toBe('stopped_unconfirmed');
  });
});
