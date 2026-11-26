type ScheduledTask = {
  hostKey: string;
  delayMs: number;
  operation: () => Promise<void>;
  busy: boolean;
};

export class CollectorScheduler {
  private readonly tasks: ScheduledTask[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly hostTails = new Map<string, Promise<void>>();
  private started = false;
  private stopped = false;

  schedule(delayMs: number, hostKey: string, operation: () => Promise<void>): void {
    if (this.stopped || !Number.isFinite(delayMs) || delayMs < 0) return;
    this.tasks.push({ hostKey, delayMs, operation, busy: false });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const task of this.tasks) this.arm(task);
  }

  async waitIdle(): Promise<void> {
    // Wait only for work already dispatched in this turn. Future periodic
    // ticks remain scheduled and must not keep an explicit refresh waiting.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.tasks.length = 0;
  }

  activeTimerCount(): number {
    return this.timers.size;
  }

  private arm(task: ScheduledTask): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      // Keep one periodic timer armed for every task. A slow operation only
      // suppresses overlap; it must not leave that task unscheduled.
      this.arm(task);
      if (task.busy) return;
      task.busy = true;
      const previous = this.hostTails.get(task.hostKey) ?? Promise.resolve();
      const current: Promise<void> = previous.catch(() => undefined).then(async () => {
        try {
          await task.operation();
        } catch {
          // Each host operation owns its failure and retry policy.
        } finally {
          if (this.hostTails.get(task.hostKey) === current) this.hostTails.delete(task.hostKey);
          task.busy = false;
        }
      });
      this.hostTails.set(task.hostKey, current);
    }, task.delayMs);
    this.timers.add(timer);
    timer.unref?.();
  }
}
