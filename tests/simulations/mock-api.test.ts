import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../src/mocks/api';
import { validateLogEvent, validateLogPage, validateLogSearchPage, validateMonitorUpdate } from '../../src/shared/validate';

describe('mock monitor API', () => {
  it('keeps demo state labeled and saves preferences through the shared API', async () => {
    const api = createMockApi({ demo: true });
    expect((await api.getSnapshot()).demo).toBe(true);
    expect(await api.getPreferences()).toEqual({ theme: 'system' });
    expect(await api.savePreferences({ theme: 'dark' })).toEqual({ theme: 'dark' });
  });

  it('uses revision compare-and-swap for registry saves', async () => {
    const api = createMockApi();
    const initial = await api.getRegistry();
    expect(await api.saveRegistry(initial)).toMatchObject({ revision: 1 });
    await expect(api.saveRegistry(initial)).rejects.toThrow('REVISION_CONFLICT');
  });

  it('keeps demo registration and snapshots consistent after removing the example task', async () => {
    const api = createMockApi({ demo: true });
    const registry = await api.getRegistry();
    expect(registry.tasks.map(task => task.taskId)).toEqual(['demo-task']);
    await api.saveRegistry({ ...registry, tasks: [] });
    expect((await api.getSnapshot()).tasks).toEqual([]);
  });

  it('keeps default mode empty and projects only registered unobserved entries', async () => {
    const api = createMockApi();
    const empty = await api.getSnapshot();
    expect(empty).toMatchObject({ demo: false, hosts: [], tasks: [], sources: [] });
    expect(await api.getLogs({ requestId: 'normal-empty', sourceId: 'demo-log', before: null, limit: 100 })).toMatchObject({ events: [], nextBefore: null });
    const registry = await api.getRegistry();
    registry.hosts.push({ hostId: 'h1', label: 'Host', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'wsl', distribution: 'Ubuntu-26.04' } });
    registry.tasks.push({ taskId: 't1', hostId: 'h1', label: 'Task', enabled: true, algorithm: 'flow', allowedDirectories: ['/allowed/task'], entryPaths: [], sources: [{ sourceId: 's1', path: '/allowed/task/train.log', kind: 'log' }], checkpointDirectories: [] });
    await api.saveRegistry(registry);
    expect(await api.getSnapshot()).toMatchObject({ demo: false, hosts: [{ hostId: 'h1', freshness: 'unobserved' }], tasks: [{ taskId: 't1', lifecycle: 'unknown', freshness: 'unobserved', currentRun: null, resources: [] }], sources: [{ sourceId: 's1', taskId: 't1', state: 'unobserved' }] });
    expect(await api.getLogs({ requestId: 'normal-source', sourceId: 's1', before: null, limit: 100 })).toMatchObject({ events: [], nextBefore: null });
    const updates: unknown[] = [];
    const unsubscribe = api.subscribe((update) => updates.push(update));
    await api.requestRefresh({});
    expect(updates).toHaveLength(1);
    expect((updates[0] as any).kind).toBe('snapshot');
    unsubscribe();
  });

  it('rejects duplicate IDs before compare-and-swap changes revision', async () => {
    const api = createMockApi();
    const registry = await api.getRegistry();
    registry.hosts.push({ hostId: 'h1', label: 'A', enabled: true, allowedRoots: ['/a'], target: { kind: 'wsl', distribution: 'Ubuntu-26.04' } });
    registry.hosts.push({ ...registry.hosts[0]! });
    await expect(api.saveRegistry(registry)).rejects.toThrow(/DUPLICATE_ID/);
    expect((await api.getRegistry()).revision).toBe(0);
  });

  it('provides a finite, valid demo log cache with backward bounded pagination', async () => {
    const api = createMockApi({ demo: true });
    const latest = await api.getLogs({ requestId: 'page-1', sourceId: 'demo-log', before: null, limit: 500 });
    expect(latest.events).toHaveLength(500);
    expect(latest.events[0]?.eventId).toBe('demo-event-001500');
    expect(latest.events.at(-1)?.eventId).toBe('demo-event-001999');
    expect(latest.nextBefore).toBe('demo-event-001500');
    expect(latest.truncatedByBudget).toBe(false);
    validateLogPage(latest);
    for (const event of latest.events) validateLogEvent(event);

    const older = await api.getLogs({ requestId: 'page-2', sourceId: 'demo-log', before: latest.nextBefore, limit: 500 });
    expect(older.events).toHaveLength(500);
    expect(older.events[0]?.eventId).toBe('demo-event-001000');
    expect(older.events.at(-1)?.eventId).toBe('demo-event-001499');
    expect(older.events.some((event) => latest.events.some((current) => current.eventId === event.eventId))).toBe(false);
    const offsets = older.events.map((event) => BigInt(event.startOffset!));
    expect(offsets).toEqual([...offsets].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
    expect(await api.getLogs({ requestId: 'other-source', sourceId: 'missing', before: null, limit: 10 })).toMatchObject({ events: [], nextBefore: null });
    const allPages = [latest, older];
    let cursor = older.nextBefore;
    while (cursor) {
      const page = await api.getLogs({ requestId: `page-${allPages.length + 1}`, sourceId: 'demo-log', before: cursor, limit: 500 });
      allPages.push(page);
      cursor = page.nextBefore;
    }
    const allEvents = allPages.flatMap((page) => page.events);
    expect(allPages).toHaveLength(4);
    expect(allEvents).toHaveLength(2_000);
    expect(new Set(allEvents.map((event) => event.eventId)).size).toBe(2_000);
    expect(allPages.every((page) => page.events.length <= 500 && page.events.reduce((sum, event) => sum + new TextEncoder().encode(event.text ?? '').byteLength, 0) <= 1024 * 1024)).toBe(true);
  });

  it('searches retained demo logs with bounded continuation and literal matching', async () => {
    const api = createMockApi({ demo: true });
    const first = await api.searchLogs({ requestId: 'search-1', sourceIds: ['demo-log'], literal: '模拟训练日志', continuation: null });
    expect(first.events).toHaveLength(500);
    expect(first.continuation).not.toBeNull();
    expect(first.scope).toBe('retained_local');
    expect(first.cancelled).toBe(false);
    validateLogSearchPage(first);
    expect(first.events.every((event) => event.text?.includes('模拟训练日志'))).toBe(true);

    const second = await api.searchLogs({ requestId: 'search-2', sourceIds: ['demo-log'], literal: '模拟训练日志', continuation: first.continuation });
    expect(second.events).toHaveLength(500);
    expect(second.events.some((event) => first.events.some((current) => current.eventId === event.eventId))).toBe(false);
    expect(second.continuation).not.toBeNull();
    const remaining: any[] = [first, second];
    let cursor = second.continuation;
    while (cursor) {
      const page = await api.searchLogs({ requestId: `search-${remaining.length + 1}`, sourceIds: ['demo-log'], literal: '模拟训练日志', continuation: cursor });
      remaining.push(page);
      cursor = page.continuation;
    }
    const matches = remaining.flatMap((page) => page.events);
    expect(matches).toHaveLength(2_000);
    expect(new Set(matches.map((event) => event.eventId)).size).toBe(2_000);
  });

  it('emits deterministic demo snapshot and stable redraw upsert updates only while subscribed', async () => {
    const api = createMockApi({ demo: true });
    const updates: unknown[] = [];
    const unsubscribe = api.subscribe((update) => updates.push(update));
    await api.requestRefresh({});
    expect(updates).toHaveLength(2);
    expect(updates.map((update: any) => update.kind)).toEqual(['snapshot', 'logs']);
    const firstLogUpdate = updates[1] as any;
    validateMonitorUpdate(firstLogUpdate);
    expect(firstLogUpdate.events).toHaveLength(1);
    expect(firstLogUpdate.events[0]).toMatchObject({ sourceId: 'demo-log', taskId: 'demo-task', kind: 'redraw', eventId: 'demo-redraw-progress' });
    const snapshotBefore = await api.getSnapshot();
    await api.requestRefresh({});
    const secondLogUpdate = updates[3] as any;
    expect(secondLogUpdate.events[0].eventId).toBe(firstLogUpdate.events[0].eventId);
    expect((await api.getSnapshot()).sources).toEqual(snapshotBefore.sources);
    unsubscribe();
    const updateCount = updates.length;
    await api.requestRefresh({});
    expect(updates).toHaveLength(updateCount);
    const page = await api.getLogs({ requestId: 'redraw-page', sourceId: 'demo-log', before: null, limit: 500 });
    expect(page.events.at(-1)?.eventId).toBe('demo-redraw-progress');
  });

  it('reports an in-flight deterministic search cancellation', async () => {
    const api = createMockApi({ demo: true });
    const pending = api.searchLogs({ requestId: 'cancel-this-search', sourceIds: ['demo-log'], literal: '模拟训练日志', continuation: null });
    await api.cancelRequest('cancel-this-search');
    await expect(pending).resolves.toMatchObject({ events: [], continuation: null, scope: 'retained_local', cancelled: true });
    await expect(api.searchLogs({ requestId: 'cancel-this-search', sourceIds: ['demo-log'], literal: '模拟训练日志', continuation: null })).resolves.toMatchObject({ cancelled: false });
  });
});
