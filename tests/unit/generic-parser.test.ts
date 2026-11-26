import { describe, expect, it } from 'vitest';
import { parseGenericRecord } from '../../src/parsers/generic';
import { taskAlgorithmName, taskLogFormat, taskParser } from '../../src/shared/task-profile';

describe('generic training output', () => {
  it.each([
    ['[train] step=12 loss=0.15', 12],
    ['Step: 0, loss: 0.123', 0],
    ['iteration 42, train_loss=1e-3', 42],
    ['[INFO] global_step=100, grad_norm=0.3', 100],
    ['{"step":80,"loss":0.2,"total_steps":1000}', 80],
    ['{"global_step":120,"train_loss":0.03}', 120],
    ['{"phase":"training","iteration":9}', 9],
  ])('recognizes %s without inventing an index origin or total', (text, step) => {
    expect(parseGenericRecord(String(text))).toMatchObject({ isTrainingOutput: true, stepIndex: step,
      sessionCompletedCount: null, sessionTargetCount: null });
  });

  it.each([
    ['', false], ['heartbeat step=100 loss=0.3', false], ['[val] step=42 loss=0.2', false],
    ['evaluation step=42 loss=0.2', false], ['checkpoint saved step=100 train_loss=0.1', false],
    ['step=100', false], ['train step=-1 loss=0.2', false], ['train step=2.5 loss=0.2', false],
    ['train step=9007199254740992 loss=0.2', false], ['{"step":8,"mode":"eval","loss":0.3}', false],
    ['{"step":"8","loss":0.3}', false], ['{"step":8,"event":"heartbeat","loss":0.3}', false],
    ['{"step":8', false], ['train step=8 loss=0.2\nstep=9', false],
    ['train step=1 loss=0.2' + 'x'.repeat(4096), false],
    ['101/100 [00:01<00:02, 3it/s]', false], ['1/0 [00:01<00:02, 3it/s]', false],
  ])('does not treat ambiguous or nontraining output as training: %s', (text, expected) => {
    expect(parseGenericRecord(String(text)).isTrainingOutput).toBe(expected);
  });

  it.each(['0/100 [00:00<?, 0it/s]', '40%|████| 40/100 [00:20<00:30, 2.0it/s]', '40/100 [00:20<00:30, 0.5s/it]'])('reads tqdm completed counts from %s', text => {
    const value = parseGenericRecord(text);
    expect(value.isTrainingOutput).toBe(true);
    expect(value.sessionTargetCount).toBe(100);
    expect(value.sessionCompletedCount).toBe(text.startsWith('0/') ? 0 : 40);
    expect(value.stepIndex).toBeNull();
  });
});

describe('algorithm names and log formats', () => {
  it('keeps custom names independent from the explicitly selected format', () => {
    expect(taskParser({ algorithm: 'Flow Matching', logFormat: 'generic' })).toBe('generic');
    expect(taskParser({ algorithm: '任意新算法', logFormat: 'flow' })).toBe('legacy_flow');
    expect(taskParser({ algorithm: '', logFormat: 'generic' })).toBe('generic');
    expect(taskParser({ algorithm: 'PPO', logFormat: 'raw' })).toBe('raw');
    expect(taskAlgorithmName({ algorithm: '自定义算法 / Transformer', logFormat: 'generic' })).toBe('自定义算法 / Transformer');
  });
  it('preserves legacy parser selection without forcing registry migration', () => {
    expect(taskLogFormat({ algorithm: 'flow' })).toBe('legacy_flow');
    expect(taskLogFormat({ algorithm: 'score' })).toBe('legacy_score');
    expect(taskLogFormat({ algorithm: 'reflow' })).toBe('legacy_reflow');
    expect(taskParser({ algorithm: 'unknown' })).toBe('unknown');
    expect(taskAlgorithmName({ algorithm: 'flow' })).toBe('Flow Matching');
    expect(taskParser({ algorithm: 'Transformer' })).toBe('generic');
    expect(taskParser({ algorithm: ['flow'] } as any)).toBe('unknown');
    expect(taskParser({ algorithm: 'Transformer', logFormat: ['generic'] } as any)).toBe('unknown');
  });
});
