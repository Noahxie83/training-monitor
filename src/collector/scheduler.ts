type ScheduledTask = {
  hostKey: string;
  delayMs: number;
  operation: () => Promise<void>;
  busy: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export class CollectorScheduler {
  private readonly tasks: ScheduledTask[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly hostTails = new Map<string, Promise<void>>();
  private started = false;
  private stopped = false;

  schedule(delayMs: number, hostKey: string, operation: () => Promise<void>): void {
    if (this.stopped || !Number.isFinite(delayMs) || delayMs < 0) return;
    const task: ScheduledTask = { hostKey, delayMs, operation, busy: false, cancelled: false, timer: null };
    this.tasks.push(task);
    if (this.started) this.arm(task);
  }

  unscheduleHost(hostKey: string): void {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const task = this.tasks[i]!;
      if (task.hostKey !== hostKey) continue;
      task.cancelled = true;
      if (task.timer) {
        clearTimeout(task.timer);
        this.timers.delete(task.timer);
        task.timer = null;
      }
      this.tasks.splice(i, 1);
    }
  }

  hasHost(hostKey: string): boolean {
    return this.tasks.some((task) => !task.cancelled && task.hostKey === hostKey);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const task of this.tasks) {
      if (!task.cancelled && !task.timer) this.arm(task);
    }
  }

  async waitIdle(): Promise<void> {
    // Truly await all currently active per-host operations until every hostTail settles.
    while (this.hostTails.size > 0) {
      const active = [...this.hostTails.values()];
      await Promise.allSettled(active);
      // Break if the same settled promises are no longer changing (defensive against external misuse).
      if (active.every((promise) => ![...this.hostTails.values()].includes(promise))) {
        if (this.hostTails.size === 0) break;
      } else {
        break;
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const task of this.tasks) {
      task.cancelled = true;
      task.timer = null;
    }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.tasks.length = 0;
  }

  activeTimerCount(): number {
    return this.timers.size;
  }

  private arm(task: ScheduledTask): void {
    if (this.stopped || task.cancelled) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (task.timer === timer) task.timer = null;
      if (this.stopped || task.cancelled) return;
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
    task.timer = timer;
    this.timers.add(timer);
    timer.unref?.();
  }
}
