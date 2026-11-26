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

  test('keeps command arguments parameterized and independent of registered path text', async () => {
    const { commandSpecFor, safeArgsFor } = await import('../../src/transport/commands');
    const sshArgs = safeArgsFor({
      kind: 'ssh',
      hostname: '10.0.0.12',
      user: 'alice',
      port: 2222,
      identityFile: '~/.ssh/id_ed25519',
      proxyJump: 'bastion',
    });
    expect(sshArgs.slice(0, 15)).toEqual([
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=2',
      '-l', 'alice',
      '-p', '2222',
    ]);
    expect(sshArgs).toContain('-i');
    expect(sshArgs).toContain('~/.ssh/id_ed25519');
    expect(sshArgs).toContain('-J');
    expect(sshArgs).toContain('bastion');
    expect(sshArgs).toContain('--');
    expect(sshArgs).toContain('10.0.0.12');
    expect(sshArgs.at(-1)).toContain('sh -c');
    expect(sshArgs.at(-1)).not.toContain('\\');

    const wslArgs = safeArgsFor({ kind: 'wsl', distribution: 'Ubuntu-24.04', pythonPath: '/opt/venv/bin/python' });
    expect(wslArgs.slice(0, 5)).toEqual(['--distribution', 'Ubuntu-24.04', '--exec', 'sh', '-c']);
    expect(wslArgs.at(-1)).toBe('/opt/venv/bin/python');

    const localSpec = commandSpecFor({ kind: 'local', pythonPath: '/usr/bin/python3' }, { serve: true });
    expect(localSpec.command).toBe('/usr/bin/python3');
    expect(localSpec.args.slice(0, 4)).toEqual(['-I', '-S', '-B', '-c']);
    expect(localSpec.args).toContain('--serve');
  });
});
