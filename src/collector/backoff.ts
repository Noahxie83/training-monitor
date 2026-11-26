export const INITIAL_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;

export function nextBackoffMs(
  previous: number | null,
  options: { initialMs?: number; maxMs?: number } = {},
): number {
  const initialMs = options.initialMs ?? INITIAL_BACKOFF_MS;
  const maxMs = options.maxMs ?? MAX_BACKOFF_MS;
  if (previous === null) return Math.min(maxMs, initialMs);
  return Math.min(maxMs, Math.max(initialMs, previous * 2));
}

export function backoffMsForFailures(
  consecutiveFailures: number,
  options: { initialMs?: number; maxMs?: number } = {},
): number {
  if (consecutiveFailures <= 0) return options.initialMs ?? INITIAL_BACKOFF_MS;
  let delay: number | null = null;
  for (let i = 0; i < consecutiveFailures; i++) {
    delay = nextBackoffMs(delay, options);
  }
  return delay ?? (options.initialMs ?? INITIAL_BACKOFF_MS);
}
