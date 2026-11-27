import type { Locale } from '../i18n';

export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

export function formatTimeOnly(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

export function formatBytes(bytes: number | string | null, unknownLabel = '—'): string {
  if (bytes === null || bytes === undefined) return unknownLabel;
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(n)) return unknownLabel;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n < 1024 * 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  return `${(n / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TiB`;
}

export function formatMiBAsGiB(mib: number | null | undefined, unknownLabel = '—'): string {
  if (mib === null || mib === undefined || !Number.isFinite(mib)) return unknownLabel;
  if (mib < 1024) return `${Math.round(mib)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}

export function formatNumber(num: number | null, unknownLabel = '—'): string {
  if (num === null || num === undefined || !Number.isFinite(num)) return unknownLabel;
  return num.toLocaleString('en-US');
}

export function formatPercent(fraction: number | null, unknownLabel = '—'): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return unknownLabel;
  return `${(fraction * 100).toFixed(2)}%`;
}

export function formatRate(ips: number | null | undefined): string {
  if (ips === null || ips === undefined || !Number.isFinite(ips)) return '—';
  return ips.toFixed(2);
}

/** Humanized ETA formatter: avoids verbose zero-hour or multi-hundred-hour strings. */
export function formatEta(seconds: number | null | undefined, _locale: Locale = 'zh-CN'): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days >= 1) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours >= 1) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

export function formatScalarValue(key: string, value: number): string {
  if (!Number.isFinite(value)) return '—';
  const lower = key.toLowerCase();
  if (lower === 'lr' || lower.includes('learning_rate') || (Math.abs(value) > 0 && Math.abs(value) < 0.001)) {
    return value.toExponential(2);
  }
  if (Math.abs(value) >= 1000) return value.toFixed(1);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(4);
}

export type LoadTier = 'idle' | 'active' | 'high' | 'critical' | 'unknown';

/** 4-tier GPU load semantic color classification: <10% idle, 10–69% active, 70–89% high, >=90% critical. */
export function getLoadTier(pct: number | null | undefined): LoadTier {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'unknown';
  if (pct < 10) return 'idle';
  if (pct < 70) return 'active';
  if (pct < 90) return 'high';
  return 'critical';
}

export function slugifyTaskId(label: string): string {
  const ascii = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return ascii;
}

export function middleEllipsis(path: string | null, maxLength = 45): string {
  if (!path) return '—';
  if (path.length <= maxLength) return path;
  const start = Math.floor((maxLength - 5) / 2);
  const end = path.length - (maxLength - 5 - start);
  return `${path.slice(0, start)}...${path.slice(end)}`;
}

export function friendlySourceName(sourceId: string, resolvedPath?: string | null, configuredPath?: string | null): string {
  const candidate = resolvedPath || configuredPath;
  if (candidate) {
    const base = candidate.split(/[/\\]/).filter(Boolean).pop();
    if (base) return base;
  }
  return sourceId;
}
