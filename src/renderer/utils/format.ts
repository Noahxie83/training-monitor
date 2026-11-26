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

export function formatBytes(bytes: number | string | null): string {
  if (bytes === null || bytes === undefined) return '未知';
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(n)) return '未知';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatNumber(num: number | null): string {
  if (num === null || num === undefined) return '未知';
  return num.toLocaleString('en-US');
}

export function formatPercent(fraction: number | null): string {
  if (fraction === null || fraction === undefined) return '未知';
  return `${(fraction * 100).toFixed(2)}%`;
}

export function middleEllipsis(path: string | null, maxLength = 45): string {
  if (!path) return '—';
  if (path.length <= maxLength) return path;
  const start = Math.floor((maxLength - 5) / 2);
  const end = path.length - (maxLength - 5 - start);
  return `${path.slice(0, start)}...${path.slice(end)}`;
}
