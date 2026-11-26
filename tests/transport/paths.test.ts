import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canReadOpenedFile, isWithin, openRegisteredFile } from '../../src/transport/paths';

let tempDir: string | undefined;
afterEach(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); tempDir = undefined; });

describe('registered path boundaries', () => {
  test('compares path components, not string prefixes', () => {
    expect(isWithin('/data2/cy/xzn', '/data2/cy/xzn/run.py')).toBe(true);
    expect(isWithin('/data2/cy/xzn', '/data2/cy/xzn-other/run.py')).toBe(false);
  });

  test('rejects a symlink that escapes the registered root', async () => {
    if (process.platform === 'win32') return;
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'monitor-path-'));
    const allowed = path.join(tempDir, 'allowed');
    const outside = path.join(tempDir, 'outside');
    await mkdir(allowed); await mkdir(outside);
    const secret = path.join(outside, 'log.txt'); await writeFile(secret, 'outside');
    const link = path.join(allowed, 'log.txt'); await symlink(secret, link);
    await expect(openRegisteredFile(link, [allowed])).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' });
    expect(await canReadOpenedFile(link, [allowed])).toBe(false);
  });

  test('rechecks the opened identity after the path changes between resolution and open', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'monitor-race-'));
    const allowed = path.join(tempDir, 'allowed');
    await mkdir(allowed);
    const target = path.join(allowed, 'source.log');
    const decoy = path.join(allowed, 'decoy.log');
    await writeFile(target, 'registered'); await writeFile(decoy, 'decoy');
    const swap = async () => { await rm(target); await writeFile(target, 'replacement'); };
    await expect(openRegisteredFile(target, [allowed], { afterResolve: swap })).rejects.toMatchObject({ code: 'PATH_IDENTITY_CHANGED' });
  });

  test('keeps the fixed command arguments independent of registered path text', async () => {
    const { safeArgsFor } = await import('../../src/transport/commands');
    const pathWithShellText = `/tmp/训练 run '$(touch injected)'`;
    expect(safeArgsFor({ kind: 'ssh', alias: 'lab-campus' }, pathWithShellText)).toEqual([
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '--', 'lab-campus', '/usr/bin/python3 -I -S -B -',
    ]);
    expect(safeArgsFor({ kind: 'wsl', distribution: 'Ubuntu-26.04' }, pathWithShellText)).toEqual([
      '--distribution', 'Ubuntu-26.04', '--exec', '/usr/bin/python3', '-I', '-S', '-B', '-',
    ]);
  });
});
