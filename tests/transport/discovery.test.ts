import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSshHosts, discoverWslDistros, parseSshConfig, parseWslListOutput } from '../../src/transport/discovery';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { this.emit('close', null, 'SIGTERM'); return true; }
}

describe('SSH config discovery', () => {
  it('parses Host blocks, Include globs (1-level), comments, multi-alias, first-match-wins, and skips wildcards/unsafe entries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-ssh-cfg-'));
    dirs.push(dir);
    const confD = path.join(dir, 'config.d');
    const nestedDir = path.join(dir, 'nested');
    await mkdir(confD, { recursive: true });
    await mkdir(nestedDir, { recursive: true });

    await writeFile(path.join(confD, '01-cluster.conf'), [
      '# Cluster nodes',
      'Host gpu-a100 gpu-h100 !gpu-blocked *.internal',
      '  User researcher # inline comment',
      '  Port=2222',
      '  IdentityFile "~/.ssh/cluster key"',
      '  ProxyJump bastion.example.com',
      '',
      'Host gpu-a100',
      '  HostName 10.10.0.10',
      '  Port 9999', // must be ignored under OpenSSH first-match-wins!
      '',
      'Host gpu-h100',
      '  HostName 10.10.0.20',
      '',
      '# Nested include should NOT be expanded beyond 1 level',
      'Include nested/nested.conf',
    ].join('\n'), 'utf8');

    await writeFile(path.join(nestedDir, 'nested.conf'), 'Host nested-should-not-appear\n  HostName 1.2.3.4\n', 'utf8');

    const mainConfig = [
      'Include config.d/*.conf',
      '',
      'Host -bad-option-injection',
      '  HostName 10.0.0.99',
      '',
      'Host dev-box',
      '  HostName 192.168.1.50',
      '',
      'Match host dev-box',
      '  Port 4444',
      '',
      'Host *',
      '  User default-user',
      '  Port 22',
    ].join('\n');
    const configPath = path.join(dir, 'config');
    await writeFile(configPath, mainConfig, 'utf8');

    const discovered = await discoverSshHosts(configPath);
    expect(discovered).toEqual([
      {
        alias: 'gpu-a100',
        hostname: '10.10.0.10',
        user: 'researcher',
        port: 2222,
        identityFile: '~/.ssh/cluster key',
        proxyJump: 'bastion.example.com',
      },
      {
        alias: 'gpu-h100',
        hostname: '10.10.0.20',
        user: 'researcher',
        port: 2222,
        identityFile: '~/.ssh/cluster key',
        proxyJump: 'bastion.example.com',
      },
      {
        alias: 'dev-box',
        hostname: '192.168.1.50',
        user: 'default-user',
        port: 22,
      },
    ]);
  });

  it('returns empty array when ssh config file does not exist', async () => {
    expect(await discoverSshHosts(path.join(os.tmpdir(), 'nonexistent-ssh-config-12345'))).toEqual([]);
    expect(await parseSshConfig('Host *\n  User foo\n')).toEqual([]);
  });
});

describe('WSL distribution discovery', () => {
  it('parses UTF-16LE (with and without BOM), NUL bytes, CRLF, and UTF-8 outputs cleanly', () => {
    const utf16WithBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu-24.04\r\nDebian\r\n\r\n', 'utf16le')]);
    expect(parseWslListOutput(utf16WithBom)).toEqual(['Ubuntu-24.04', 'Debian']);

    const utf16NoBom = Buffer.from('Ubuntu-22.04\r\nArch\r\n', 'utf16le');
    expect(parseWslListOutput(utf16NoBom)).toEqual(['Ubuntu-22.04', 'Arch']);

    const utf8 = Buffer.from('\uFEFFUbuntu\nUbuntu\nAlpine\r\n', 'utf8');
    expect(parseWslListOutput(utf8)).toEqual(['Ubuntu', 'Alpine']);
  });

  it('returns empty array on non-Windows platforms without spawning wsl.exe', async () => {
    const spawn = vi.fn();
    expect(await discoverWslDistros({ platform: 'linux', spawn: spawn as never })).toEqual([]);
    expect(await discoverWslDistros({ platform: 'darwin', spawn: spawn as never })).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('merges installed and running WSL distros on Windows', async () => {
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        if (args.includes('--running')) {
          child.stdout.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu-24.04\r\n', 'utf16le')]));
        } else {
          child.stdout.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu-24.04\r\nDebian\r\n', 'utf16le')]));
        }
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    });
    const distros = await discoverWslDistros({ platform: 'win32', spawn: spawn as never });
    expect(distros).toEqual([
      { name: 'Ubuntu-24.04', running: true },
      { name: 'Debian', running: false },
    ]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

it('drops unsafe SSH directives and caps the result at the discovery validation limit', async () => {
  const entries = Array.from({ length: 520 }, (_, index) => `Host gpu-${index}`);
  const config = [
    'Host -bad bad;alias valid',
    '  ProxyJump safe,-invalid',
    '  HostName unsafe$hostname',
    '  User ' + 'u'.repeat(129),
    '  IdentityFile ' + 'i'.repeat(1025),
    ...entries,
  ].join('\n');
  const hosts = await parseSshConfig(config);
  expect(hosts).toHaveLength(512);
  expect(hosts[0]).toEqual({ alias: 'valid' });
});
