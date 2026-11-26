import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

describe('collector scheduler', () => {
  it('serializes work per host and clears every scheduled timer on stop', async () => {
    const module = await import('../../src/collector/scheduler');
    expect(module.CollectorScheduler, 'collector scheduler API must exist').toBeTypeOf('function');

    vi.useFakeTimers();
    const scheduler = new module.CollectorScheduler();
    let active = 0;
    let maxActive = 0;
    const runs: number[] = [];
    const operation = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runs.push(active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active -= 1;
    };

    scheduler.schedule(5_000, 'host-a', operation);
    scheduler.schedule(15_000, 'host-a', operation);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await scheduler.waitIdle();

    expect(runs.length).toBeGreaterThan(2);
    expect(maxActive).toBe(1);
    expect(scheduler.activeTimerCount()).toBe(2);

    scheduler.stop();
    await scheduler.waitIdle();
    expect(scheduler.activeTimerCount()).toBe(0);
    // The scheduler owns only polling timers. Drain the test operation's own
    // 10ms delay before checking that no test timer remains.
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps exponential backoff without creating an extra scheduling framework', async () => {
    const module = await import('../../src/collector/backoff');
    expect(module.nextBackoffMs, 'bounded collector backoff API must exist').toBeTypeOf('function');
    expect(module.nextBackoffMs(null)).toBe(5_000);
    expect(module.nextBackoffMs(5_000)).toBe(10_000);
    expect(module.nextBackoffMs(10_000)).toBe(20_000);
    expect(module.nextBackoffMs(20_000)).toBe(30_000);
    expect(module.nextBackoffMs(30_000)).toBe(30_000);
  });
});
