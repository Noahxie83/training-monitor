export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type ClassifiedLogLevel = 'error' | 'warn' | 'info' | 'debug';

const STANDARD_16_FG: Record<number, string> = {
  30: 'var(--ansi-black)',
  31: 'var(--ansi-red)',
  32: 'var(--ansi-green)',
  33: 'var(--ansi-yellow)',
  34: 'var(--ansi-blue)',
  35: 'var(--ansi-magenta)',
  36: 'var(--ansi-cyan)',
  37: 'var(--ansi-white)',
  90: 'var(--ansi-bright-black)',
  91: 'var(--ansi-bright-red)',
  92: 'var(--ansi-bright-green)',
  93: 'var(--ansi-bright-yellow)',
  94: 'var(--ansi-bright-blue)',
  95: 'var(--ansi-bright-magenta)',
  96: 'var(--ansi-bright-cyan)',
  97: 'var(--ansi-bright-white)',
};

const STANDARD_16_BG: Record<number, string> = {
  40: 'var(--ansi-bg-black)',
  41: 'var(--ansi-bg-red)',
  42: 'var(--ansi-bg-green)',
  43: 'var(--ansi-bg-yellow)',
  44: 'var(--ansi-bg-blue)',
  45: 'var(--ansi-bg-magenta)',
  46: 'var(--ansi-bg-cyan)',
  47: 'var(--ansi-bg-white)',
  100: 'var(--ansi-bg-bright-black)',
  101: 'var(--ansi-bg-bright-red)',
  102: 'var(--ansi-bg-bright-green)',
  103: 'var(--ansi-bg-bright-yellow)',
  104: 'var(--ansi-bg-bright-blue)',
  105: 'var(--ansi-bg-bright-magenta)',
  106: 'var(--ansi-bg-bright-cyan)',
  107: 'var(--ansi-bg-bright-white)',
};

const ANSI_256_BASE = [
  '#1e293b', '#dc2626', '#16a34a', '#ca8a04', '#2563eb', '#9333ea', '#0891b2', '#cbd5e1',
  '#64748b', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#c084fc', '#22d3ee', '#f8fafc',
];

function ansi256ToHex(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return ANSI_256_BASE[n];
  if (n >= 232) {
    const shade = 8 + (n - 232) * 10;
    const h = shade.toString(16).padStart(2, '0');
    return `#${h}${h}${h}`;
  }
  const idx = n - 16;
  const r = Math.floor(idx / 36);
  const g = Math.floor((idx % 36) / 6);
  const b = idx % 6;
  const steps = [0, 95, 135, 175, 215, 255];
  const toHex = (v: number) => steps[v]!.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// eslint-disable-next-line no-control-regex
const ESC_SEQ_RE = /\x1B(?:\[([0-9;]*)m|\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

/**
 * Safely parse ANSI SGR 16/256/TrueColor sequences into styled React-safe text segments.
 * Non-SGR escape codes are stripped without executing or injecting raw HTML.
 */
export function parseAnsiSegments(input: string): AnsiSegment[] {
  if (!input) return [];
  if (!input.includes('\x1B')) return [{ text: input }];

  const segments: AnsiSegment[] = [];
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;

  let lastIndex = 0;
  ESC_SEQ_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (chunk: string) => {
    if (!chunk) return;
    segments.push({
      text: chunk,
      ...(fg ? { fg } : {}),
      ...(bg ? { bg } : {}),
      ...(bold ? { bold: true } : {}),
      ...(dim ? { dim: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(underline ? { underline: true } : {}),
    });
  };

  while ((match = ESC_SEQ_RE.exec(input)) !== null) {
    if (match.index > lastIndex) {
      pushText(input.slice(lastIndex, match.index));
    }
    lastIndex = ESC_SEQ_RE.lastIndex;

    const sgr = match[1];
    if (sgr === undefined) continue; // non-SGR control sequence: strip safely

    const codes = sgr === '' ? [0] : sgr.split(';').map((part) => (part === '' ? 0 : Number(part)));
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]!;
      if (!Number.isFinite(code)) continue;
      if (code === 0) {
        fg = undefined;
        bg = undefined;
        bold = false;
        dim = false;
        italic = false;
        underline = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 2) {
        dim = true;
      } else if (code === 3) {
        italic = true;
      } else if (code === 4) {
        underline = true;
      } else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 23) {
        italic = false;
      } else if (code === 24) {
        underline = false;
      } else if (code === 39) {
        fg = undefined;
      } else if (code === 49) {
        bg = undefined;
      } else if (code in STANDARD_16_FG) {
        fg = STANDARD_16_FG[code];
      } else if (code in STANDARD_16_BG) {
        bg = STANDARD_16_BG[code];
      } else if ((code === 38 || code === 48) && i + 1 < codes.length) {
        const isFg = code === 38;
        const mode = codes[i + 1];
        if (mode === 5 && i + 2 < codes.length) {
          const hex = ansi256ToHex(codes[i + 2]!);
          if (hex) {
            if (isFg) fg = hex;
            else bg = hex;
          }
          i += 2;
        } else if (mode === 2 && i + 4 < codes.length) {
          const r = Math.max(0, Math.min(255, Math.round(codes[i + 2]!)));
          const g = Math.max(0, Math.min(255, Math.round(codes[i + 3]!)));
          const b = Math.max(0, Math.min(255, Math.round(codes[i + 4]!)));
          const color = `rgb(${r}, ${g}, ${b})`;
          if (isFg) fg = color;
          else bg = color;
          i += 4;
        }
      }
    }
  }

  if (lastIndex < input.length) {
    pushText(input.slice(lastIndex));
  }

  return segments;
}

const ERROR_PATTERN = /\b(ERROR|ERR|FATAL|CRITICAL|Traceback|Exception|RuntimeError|ValueError|OutOfMemoryError|OOM|CUDA out of memory|Segmentation fault)\b/i;
const WARN_PATTERN = /\b(WARN|WARNING|DEPRECATED|UserWarning|FutureWarning)\b/i;
const DEBUG_PATTERN = /\b(DEBUG|TRACE)\b/i;

export function classifyLogLevel(plainText: string | null | undefined): ClassifiedLogLevel {
  if (!plainText) return 'info';
  if (ERROR_PATTERN.test(plainText)) return 'error';
  if (WARN_PATTERN.test(plainText)) return 'warn';
  if (DEBUG_PATTERN.test(plainText)) return 'debug';
  return 'info';
}
