// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useLogBuffer } from '../../src/renderer/hooks/useLogBuffer';
import type { LogSourceSnapshot } from '../../src/shared/contracts';
import type { MonitorUpdate } from '../../src/shared/api';
import type { ProductionMonitorApi } from '../../src/collector/service';

const apis: ProductionMonitorApi[] = [];

afterEach(async () => {
  cleanup();
  await Promise.allSettled(apis.splice(0).map((api) => api.stop()));
});

function LogHarness({ api, source }: { api: ProductionMonitorApi; source: LogSourceSnapshot }) {
  const buffer = useLogBuffer(source.taskId, [source]);
  return <div data-testid="live-lines">{buffer.events.map((event) => event.text).join('\n')}</div>;
}

describe('live monitor production path', () => {
  it('delivers committed same-generation appends to an already mounted log window', async () => {
    const fixture = await import('../simulations/live-monitor-fixture');
    const connected = await fixture.createLiveMonitor();
    apis.push(connected.api);
    window.monitor = connected.api;
    const updates: MonitorUpdate[] = [];
    const unsubscribe = connected.api.subscribe((update) => updates.push(structuredClone(update)));
    await connected.api.start();
    await connected.api.requestRefresh({});
    const initial = await connected.api.getSnapshot();
    const source = initial.sources[0]!;

    render(<LogHarness api={connected.api} source={source} />);
    await waitFor(() => expect(screen.getByTestId('live-lines').textContent).toContain('100/1000'));

    connected.append('101/1000 [00:10<01:30, 10.0it/s]\n');
    await act(async () => { await connected.api.requestRefresh({}); });
    await waitFor(() => expect(screen.getByTestId('live-lines').textContent).toContain('101/1000'));

    const logUpdates = updates.filter((update): update is Extract<MonitorUpdate, { kind: 'logs' }> => update.kind === 'logs');
    expect(logUpdates.some((update) => update.events.some((event) => event.text === '101/1000 [00:10<01:30, 10.0it/s]'))).toBe(true);

    await connected.api.requestRefresh({});
    expect(updates.filter((update) => update.kind === 'logs')).toHaveLength(logUpdates.length);

    connected.replaceTail('102/1000 [00:11<01:30, 10.0it/s] revised');
    await connected.api.requestRefresh({});
    await waitFor(() => expect(screen.getByTestId('live-lines').textContent).toContain('102/1000'));
    expect(updates.filter((update) => update.kind === 'logs').length).toBeGreaterThan(logUpdates.length);
    unsubscribe();
  });

  it('advances supported session progress from newly observed complete Flow records', async () => {
    const fixture = await import('../simulations/live-monitor-fixture');
    const connected = await fixture.createLiveMonitor();
    apis.push(connected.api);
    window.monitor = connected.api;
    const updates: MonitorUpdate[] = [];
    const unsubscribe = connected.api.subscribe((update) => updates.push(structuredClone(update)));
    await connected.api.start();
    await connected.api.requestRefresh({});
    const initial = await connected.api.getSnapshot();
    const source = initial.sources[0]!;

    render(<LogHarness api={connected.api} source={source} />);
    await waitFor(() => expect(screen.getByTestId('live-lines').textContent).toContain('100/1000'));

    for (const step of [101, 102, 103]) {
      connected.append(`${step}/1000 [00:10<01:30, 10.0it/s]\n`);
      await act(async () => { await connected.api.requestRefresh({}); });
      await waitFor(() => expect(screen.getByTestId('live-lines').textContent).toContain(`${step}/1000`));
      expect(updates.some((update) =>
        update.kind === 'logs' && update.events.some((event) => event.text?.startsWith(`${step}/1000`)))).toBe(true);
      const snapshot = await connected.api.getSnapshot();
      const task = snapshot.tasks[0]!;
      expect(task.lifecycle).toBe('running');
      expect(task.currentRun?.runId).toBeTruthy();
      expect(task.progress.runId).toBe(task.currentRun?.runId);
      expect(task.progress.session.completedCount).toBe(step);
      expect(task.progress.session.targetCount).toBe(1000);
      expect(task.progress.global.completedCount).toBeNull();
      expect(task.progress.baselineEvidenceId).toBeNull();
      expect(task.progress.resumeCheckpointIndex).toBeNull();
      expect(task.progress.firstLoopIndex).toBeNull();
    }
    unsubscribe();
  });
});
