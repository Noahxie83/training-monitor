import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { DiscoveredSshHost, DiscoveredWslDistro } from '../shared/contracts';
import type { SpawnLike } from './types';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

function isConcreteSshAlias(pattern: string): boolean {
  if (!pattern || pattern.length > 255) return false;
  if (pattern.startsWith('!') || pattern.startsWith('-')) return false;
  if (/[*?]/.test(pattern)) return false;
  if (WHITESPACE_OR_CONTROL.test(pattern)) return false;
  return true;
}

function tokenizeSshLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '#') {
      if (!inQuotes) break;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseDirective(rawLine: string): { key: string; values: string[] } | null {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Support both "Key Value" and "Key=Value" (with optional whitespace around '=')
  let key = '';
  let rest = '';
  const eqMatch = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(trimmed);
  if (eqMatch) {
    key = eqMatch[1]!.toLowerCase();
    rest = eqMatch[2]!;
  } else {
    const spMatch = /^([A-Za-z][A-Za-z0-9]*)\s+(.*)$/.exec(trimmed);
    if (!spMatch) return null;
    key = spMatch[1]!.toLowerCase();
    rest = spMatch[2]!;
  }
  const values = tokenizeSshLine(rest);
  if (values.length === 0) return null;
  return { key, values };
}

function expandHome(filePath: string, homeDir: string): string {
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(homeDir, filePath.slice(2));
  }
  return filePath;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

async function defaultExpandGlob(pattern: string, baseDir: string, homeDir: string): Promise<string[]> {
  const expanded = expandHome(pattern, homeDir);
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  if (!/[*?]/.test(base)) {
    return [resolved];
  }
  try {
    const entries = await readdir(dir);
    const regex = globToRegExp(base);
    return entries
      .filter((name) => regex.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export interface ParseSshConfigOptions {
  baseDir?: string;
  homeDir?: string;
  readInclude?: (filePath: string) => Promise<string | null>;
  expandGlob?: (pattern: string, baseDir: string) => Promise<string[]>;
}

interface HostBlock {
  patterns: string[];
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

function matchesPattern(alias: string, pattern: string): boolean {
  if (pattern.startsWith('!')) return false;
  return globToRegExp(pattern).test(alias);
}

function blockMatchesAlias(alias: string, patterns: string[]): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globToRegExp(pattern.slice(1)).test(alias)) return false;
    } else if (matchesPattern(alias, pattern)) {
      matched = true;
    }
  }
  return matched;
}

export async function parseSshConfig(content: string, options: ParseSshConfigOptions = {}): Promise<DiscoveredSshHost[]> {
  const homeDir = options.homeDir ?? os.homedir();
  const baseDir = options.baseDir ?? path.join(homeDir, '.ssh');
  const readInclude = options.readInclude ?? (async (filePath: string) => {
    try { return await readFile(filePath, 'utf8'); } catch { return null; }
  });
  const expandGlob = options.expandGlob ?? ((pattern: string, dir: string) => defaultExpandGlob(pattern, dir, homeDir));

  const blocks: HostBlock[] = [];
  const concreteAliases: string[] = [];
  const seenAliases = new Set<string>();

  async function processLines(text: string, allowInclude: boolean): Promise<void> {
    let currentBlock: HostBlock | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
      const directive = parseDirective(rawLine);
      if (!directive) continue;
      const { key, values } = directive;

      if (key === 'include') {
        if (!allowInclude) continue;
        // One level of Include expansion per specification.
        for (const pattern of values) {
          const files = await expandGlob(pattern, baseDir);
          for (const file of files) {
            const included = await readInclude(file);
            if (included !== null) {
              await processLines(included, false);
            }
          }
        }
        continue;
      }

      if (key === 'host') {
        currentBlock = { patterns: values };
        blocks.push(currentBlock);
        for (const pattern of values) {
          if (isConcreteSshAlias(pattern) && !seenAliases.has(pattern)) {
            seenAliases.add(pattern);
            concreteAliases.push(pattern);
          }
        }
        continue;
      }

      if (key === 'match') {
        // Stop attributing subsequent directives to the previous Host block.
        currentBlock = null;
        continue;
      }

      if (!currentBlock) continue;
      const firstValue = values[0]!;
      if (key === 'hostname' && currentBlock.hostname === undefined && !WHITESPACE_OR_CONTROL.test(firstValue) && !firstValue.startsWith('-')) {
        currentBlock.hostname = firstValue;
      } else if (key === 'user' && currentBlock.user === undefined && !WHITESPACE_OR_CONTROL.test(firstValue) && !firstValue.startsWith('-')) {
        currentBlock.user = firstValue;
      } else if (key === 'port' && currentBlock.port === undefined) {
        const port = Number(firstValue);
        if (/^\d+$/.test(firstValue) && Number.isSafeInteger(port) && port >= 1 && port <= 65535) {
          currentBlock.port = port;
        }
      } else if (key === 'identityfile' && currentBlock.identityFile === undefined && !CONTROL_CHARS.test(firstValue)) {
        currentBlock.identityFile = firstValue;
      } else if (key === 'proxyjump' && currentBlock.proxyJump === undefined && !WHITESPACE_OR_CONTROL.test(firstValue) && !firstValue.startsWith('-')) {
        currentBlock.proxyJump = firstValue;
      }
    }
  }

  await processLines(content, true);

  // OpenSSH first-match-wins resolution for each discovered concrete alias.
  return concreteAliases.map((alias) => {
    const entry: DiscoveredSshHost = { alias };
    for (const block of blocks) {
      if (!blockMatchesAlias(alias, block.patterns)) continue;
      if (entry.hostname === undefined && block.hostname !== undefined) entry.hostname = block.hostname;
      if (entry.user === undefined && block.user !== undefined) entry.user = block.user;
      if (entry.port === undefined && block.port !== undefined) entry.port = block.port;
      if (entry.identityFile === undefined && block.identityFile !== undefined) entry.identityFile = block.identityFile;
      if (entry.proxyJump === undefined && block.proxyJump !== undefined) entry.proxyJump = block.proxyJump;
    }
    return entry;
  });
}

export async function discoverSshHosts(configPath?: string): Promise<DiscoveredSshHost[]> {
  const homeDir = os.homedir();
  const resolvedPath = configPath ? path.resolve(configPath) : path.join(homeDir, '.ssh', 'config');
  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch {
    return [];
  }
  return parseSshConfig(raw, {
    baseDir: path.dirname(resolvedPath),
    homeDir,
  });
}

/**
 * Decodes `wsl.exe --list --quiet` output, handling UTF-16LE (with or without BOM),
 * NUL bytes, CRLF, and UTF-8 outputs cleanly.
 */
export function parseWslListOutput(buffer: Buffer | Uint8Array): string[] {
  const raw = Buffer.from(buffer);
  if (raw.length === 0) return [];
  const hasUtf16Bom = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe;
  const hasNullByte = raw.includes(0);
  const text = (hasUtf16Bom || hasNullByte) ? raw.toString('utf16le') : raw.toString('utf8');
  const seen = new Set<string>();
  const distros: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^\uFEFF/, '').replace(/\0/g, '').replace(/\r/g, '').trim();
    if (!cleaned || CONTROL_CHARS.test(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    distros.push(cleaned);
  }
  return distros;
}

function runQuickWslList(args: string[], spawnChild: SpawnLike, signal?: AbortSignal): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    let settled = false;
    let child: any;
    const chunks: Buffer[] = [];
    let total = 0;
    const done = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try { child?.kill(); } catch { /* ignore */ }
      done(null);
    };
    const timer = setTimeout(onAbort, 3_000);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawnChild('wsl.exe', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      done(null);
      return;
    }
    child.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      const data = Buffer.from(chunk);
      total += data.length;
      if (total > 64 * 1024) { onAbort(); return; }
      chunks.push(data);
    });
    child.stderr.on('data', () => { /* bounded drain */ });
    child.once('error', () => done(null));
    child.once('close', (code: number | null) => {
      if (code === 0) done(Buffer.concat(chunks));
      else done(null);
    });
    try { child.stdin.end(); } catch { /* ignore */ }
  });
}

export async function discoverWslDistros(options: {
  platform?: NodeJS.Platform;
  spawn?: SpawnLike;
  signal?: AbortSignal;
} = {}): Promise<DiscoveredWslDistro[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return [];
  const spawnChild = options.spawn ?? (nodeSpawn as SpawnLike);

  const [allBuf, runningBuf] = await Promise.all([
    runQuickWslList(['--list', '--quiet'], spawnChild, options.signal),
    runQuickWslList(['--list', '--running', '--quiet'], spawnChild, options.signal),
  ]);
  if (!allBuf) return [];
  const all = parseWslListOutput(allBuf);
  const runningSet = new Set(runningBuf ? parseWslListOutput(runningBuf) : []);
  return all.map((name) => ({ name, running: runningSet.has(name) }));
}
