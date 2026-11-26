import { describe, expect, it } from 'vitest';
import { parseBytes, validateMetric, validateRegistry, validateMonitorSnapshot, validateTaskSnapshot, validateLogEvent, validatePreferences, validateLogQuery, validateLogPage, validateMonitorUpdate, validateLogSearchRequest, validateLogSearchPage } from '../../src/shared/validate';
import { demoTask } from '../../src/mocks/fixtures';

const metric = {
  observedAt: '2026-10-18T10:00:00Z', freshness: 'fresh', source: 'fixture',
  name: 'gpu_utilization', unit: 'percent_device', value: 12,
  scope: 'device', deviceId: 'gpu0', processKey: null,
};

const registry = {
  version: 1, revision: 0,
  hosts: [{ hostId: 'local-demo', label: 'Demo host', enabled: true, allowedRoots: ['/tmp/demo'], target: { kind: 'wsl', distribution: 'Ubuntu-26.04' } }],
  tasks: [{ taskId: 'demo-task', hostId: 'local-demo', label: 'Simulated task', enabled: true, algorithm: 'flow', allowedDirectories: ['/tmp/demo'], entryPaths: [], sources: [], checkpointDirectories: [] }],
};

describe('shared contracts', () => {
  it('accepts arbitrary algorithm names and independent log formats while retaining legacy registrations', () => {
    const custom: any = structuredClone(registry);
    custom.tasks[0].algorithm = 'Transformer / 自定义算法';
    custom.tasks[0].logFormat = 'generic';
    expect(validateRegistry(custom).tasks[0]).toMatchObject({ algorithm: 'Transformer / 自定义算法', logFormat: 'generic' });
    custom.tasks[0].algorithm = '';
    expect(validateRegistry(custom).tasks[0]!.algorithm).toBe('');
    expect(validateRegistry(registry).tasks[0]!.algorithm).toBe('flow');
    custom.tasks[0].logFormat = 'arbitrary-command';
    expect(() => validateRegistry(custom)).toThrow();
    custom.tasks[0].logFormat = 'generic';
    custom.tasks[0].algorithm = 'x'.repeat(121);
    expect(() => validateRegistry(custom)).toThrow();
  });
  it('parses byte strings without losing precision', () => {
    expect(parseBytes('9007199254740993')).toBe(9007199254740993n);
  });

  it('rejects non-finite resource values', () => {
    expect(() => validateMetric({ ...metric, value: Infinity })).toThrow();
  });

  it('rejects unrecognized control fields in registry input', () => {
    expect(() => validateRegistry({ ...registry, command: 'kill -9 1' })).toThrow();
  });

  it('rejects invalid registration targets and paths', () => {
    const invalid = structuredClone(registry);
    (invalid.hosts[0] as any).target = { kind: 'ssh', alias: 'other-host' };
    expect(() => validateRegistry(invalid)).toThrow();
  });

  it('rejects control fields and malformed bytes in cross-process log DTOs', () => {
    const event = { version: 1, eventId: 'e1', taskId: 't1', sourceId: 's1', generation: 'g1', kind: 'line', startOffset: '1', endOffset: '2', ingestedAt: '2026-10-18T10:00:00Z', text: 'ok', reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false, runId: null, bindingId: null };
    expect(validateLogEvent(event).eventId).toBe('e1');
    expect(() => validateLogEvent({ ...event, startOffset: '01' })).toThrow();
    expect(() => validateLogEvent({ ...event, command: 'cmd.exe' })).toThrow();
  });

  it('rejects unexpected snapshot fields and validates preferences', () => {
    const snapshot = { version: 1, demo: true, hosts: [], tasks: [], sources: [] };
    expect(validateMonitorSnapshot(snapshot).demo).toBe(true);
    expect(() => validateMonitorSnapshot({ ...snapshot, execute: 'anything' })).toThrow();
    expect(validatePreferences({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(() => validatePreferences({ theme: 'dark', command: 'x' })).toThrow();
    expect(() => validatePreferences({ theme: ['dark'] })).toThrow(/INVALID_PREFERENCES/);
    expect(() => validatePreferences({ theme: new String('dark') })).toThrow(/INVALID_PREFERENCES/);
  });

  it('accepts legacy host snapshots and validates bounded aggregate-only host GPU metrics', () => {
    const host = {
      observedAt: '2026-10-18T10:00:00Z', freshness: 'fresh', version: 1, hostId: 'h1', kind: 'ssh',
      connection: 'connected', lastSuccessAt: '2026-10-18T10:00:00Z', lastProbeDurationMs: 12,
      scanComplete: true, errorCode: null,
    };
    const legacy = { version: 1, demo: false, hosts: [host], tasks: [], sources: [] };
    expect(validateMonitorSnapshot(legacy).hosts[0]).toEqual(host);

    const memory = { ...metric, name: 'gpu_memory_used', unit: 'bytes', value: 1024 };
    const total = { ...metric, name: 'gpu_memory_total', unit: 'bytes', value: 8192 };
    const gpu = { observedAt: host.observedAt, state: 'available', errorCode: null, metrics: [metric, memory, total] };
    const withGpu = { ...legacy, hosts: [{ ...host, gpu }] };
    expect(validateMonitorSnapshot(withGpu).hosts[0]?.gpu).toEqual(gpu);

    const rejectsGpu = (metrics: unknown[]) => validateMonitorSnapshot({ ...legacy, hosts: [{ ...host, gpu: { ...gpu, metrics } }] });
    expect(() => rejectsGpu([{ ...metric, name: 'cpu_utilization' }])).toThrow();
    expect(() => rejectsGpu([{ ...metric, unit: 'bytes' }])).toThrow();
    expect(() => rejectsGpu([{ ...metric, value: -0.1 }])).toThrow();
    expect(() => rejectsGpu([{ ...metric, value: 100.01 }])).toThrow();
    expect(() => rejectsGpu([{ ...memory, value: -1 }])).toThrow();
    expect(() => rejectsGpu(Array.from({ length: 769 }, () => metric))).toThrow();
    expect(() => rejectsGpu([{ ...metric, scope: 'process', deviceId: null, processKey: { hostBootId: 'boot', pid: 1, startTicks: '1' } }])).toThrow();
  });

  it('rejects coerced enum values and invalid calendar timestamps across DTOs', () => {
    expect(() => validateMetric({ ...metric, name: ['gpu_utilization'] })).toThrow(/INVALID_METRIC/);
    const invalidDate = '2026-02-30T10:00:00Z';
    expect(() => validateMetric({ ...metric, observedAt: invalidDate })).toThrow(/INVALID_METRIC/);
    expect(() => validateTaskSnapshot({ ...demoTask, lifecycle: ['unknown'] })).toThrow(/INVALID_TASK_SNAPSHOT/);
    expect(() => validateTaskSnapshot({ ...demoTask, checkpoint: { ...demoTask.checkpoint, mtime: invalidDate } })).toThrow(/INVALID_TASK_SNAPSHOT/);
    const taskRegistry = structuredClone(registry);
    (taskRegistry.tasks[0] as any).algorithm = ['flow'];
    expect(() => validateRegistry(taskRegistry)).toThrow(/INVALID_REGISTRY/);
  });

  it('rejects duplicate host, task and globally addressable source IDs', () => {
    const dupHost = structuredClone(registry);
    dupHost.hosts.push(structuredClone(dupHost.hosts[0]));
    expect(() => validateRegistry(dupHost)).toThrow(/DUPLICATE_ID/);
    const dupTask = structuredClone(registry);
    dupTask.tasks.push(structuredClone(dupTask.tasks[0]));
    expect(() => validateRegistry(dupTask)).toThrow(/DUPLICATE_ID/);
    const dupSource = structuredClone(registry);
    const originalTask = dupSource.tasks[0] as any;
    originalTask.sources.push({ sourceId: 'shared', path: '/tmp/one.log', kind: 'log' });
    dupSource.tasks.push({ ...structuredClone(originalTask), taskId: 'task-two', sources: [{ sourceId: 'shared', path: '/tmp/two.log', kind: 'log' }] });
    expect(() => validateRegistry(dupSource)).toThrow(/DUPLICATE_ID/);
    const crossCategory = structuredClone(registry);
    (crossCategory.tasks[0] as any).taskId = 'local-demo';
    expect(validateRegistry(crossCategory).tasks[0]?.taskId).toBe('local-demo');
  });

  it('bounds page and search request inputs', () => {
    expect(validateLogQuery({ requestId: 'r', sourceId: 's', before: null, limit: 500 }).limit).toBe(500);
    expect(() => validateLogQuery({ requestId: 'r', sourceId: 's', before: null, limit: 501 })).toThrow();
    expect(validateLogSearchRequest({ requestId: 'r', sourceIds: ['s'], literal: 'step', continuation: null }).literal).toBe('step');
    expect(() => validateLogSearchRequest({ requestId: 'r', sourceIds: ['s'], literal: 'x'.repeat(257), continuation: null })).toThrow();
  });

  it('validates page and subscription responses at runtime', () => {
    const event = { version: 1, eventId: 'e1', taskId: 't1', sourceId: 's1', generation: 'g1', kind: 'line', startOffset: '1', endOffset: '2', ingestedAt: '2026-10-18T10:00:00Z', text: 'ok', reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false, runId: null, bindingId: null };
    expect(validateLogPage({ events: [event], nextBefore: null, truncatedByBudget: false }).events).toHaveLength(1);
    expect(validateLogSearchPage({ events: [event], continuation: null, scope: 'retained_local', cancelled: false }).scope).toBe('retained_local');
    expect(validateMonitorUpdate({ kind: 'logs', sourceId: 's1', events: [event] }).kind).toBe('logs');
    expect(() => validateMonitorUpdate({ kind: 'logs', sourceId: 's1', events: [event], execute: 'x' })).toThrow();
  });

  it('enforces UTF-8 per-event and per-subscription text budgets', () => {
    const event = { version: 1, eventId: 'e1', taskId: 't1', sourceId: 's1', generation: 'g1', kind: 'line', startOffset: '1', endOffset: '2', ingestedAt: '2026-10-18T10:00:00Z', text: 'ok', reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false, runId: null, bindingId: null };
    expect(() => validateLogEvent({ ...event, text: '中'.repeat(21846) })).toThrow(/INVALID_LOG_EVENT/);
    const individuallyLegal = Array.from({ length: 17 }, (_, index) => ({ ...event, eventId: `e${index}`, text: 'x'.repeat(65536) }));
    expect(() => validateMonitorUpdate({ kind: 'logs', sourceId: 's1', events: individuallyLegal })).toThrow(/INVALID_UPDATE/);
    expect(() => validateLogPage({ events: [{ ...event, text: 'x'.repeat(65537) }], nextBefore: null, truncatedByBudget: false })).toThrow(/INVALID_LOG_EVENT/);
  });
});
