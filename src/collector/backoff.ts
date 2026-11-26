const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;

export function nextBackoffMs(previous: number | null): number {
  if (previous === null) return INITIAL_BACKOFF_MS;
  return Math.min(MAX_BACKOFF_MS, Math.max(INITIAL_BACKOFF_MS, previous * 2));
}
