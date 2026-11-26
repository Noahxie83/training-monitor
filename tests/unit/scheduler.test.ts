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
    await vi.advanceTimersByTimeAsync(15_020);
    await scheduler.waitIdle();

    expect(runs.length).toBeGreaterThan(2);
    expect(maxActive).toBe(1);
    expect(scheduler.activeTimerCount()).toBe(2);

    scheduler.stop();
    await vi.runAllTimersAsync();
    await scheduler.waitIdle();
    expect(scheduler.activeTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps exponential backoff at 60s without creating an extra scheduling framework', async () => {
    const module = await import('../../src/collector/backoff');
    expect(module.nextBackoffMs, 'bounded collector backoff API must exist').toBeTypeOf('function');
    expect(module.nextBackoffMs(null)).toBe(5_000);
    expect(module.nextBackoffMs(5_000)).toBe(10_000);
    expect(module.nextBackoffMs(10_000)).toBe(20_000);
    expect(module.nextBackoffMs(20_000)).toBe(40_000);
    expect(module.nextBackoffMs(40_000)).toBe(60_000);
    expect(module.nextBackoffMs(60_000)).toBe(60_000);
  });

  it('pauses polling while in-flight work drains and resumes with one timer per host', async () => {
    const { CollectorScheduler } = await import('../../src/collector/scheduler');
    vi.useFakeTimers();
    const scheduler = new CollectorScheduler();
    const collect = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    scheduler.schedule(50, 'host-a', collect);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    scheduler.pause();
    expect(scheduler.activeTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    await scheduler.waitIdle();
    expect(collect).toHaveBeenCalledTimes(1);

    scheduler.start();
    scheduler.start();
    expect(scheduler.activeTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(collect).toHaveBeenCalledTimes(2);
    scheduler.stop();
    await scheduler.waitIdle();
  });
});
