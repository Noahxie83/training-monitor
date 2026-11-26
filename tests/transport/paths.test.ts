import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRotationCatalog } from '../../src/registry/rotation-catalog';
import type { Registry } from '../../src/shared/contracts';

let tempDir: string | undefined;
afterEach(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); tempDir = undefined; });

describe('registered path boundaries', () => {
  test.each([
    ['/training', '/training/..cache', '/training-other'],
    ['C:\\training', 'C:\\training\\..cache', 'D:\\training'],
  ])('allows registered dot-prefixed directories and rejects escapes from %s', async (root, inside, outside) => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'monitor-path-'));
    const filename = path.join(tempDir, 'rotation.json');
    const nested = { taskId: 'task', sourceId: 'log', exactBasenames: ['train.log.1'] };
    await writeFile(filename, JSON.stringify({ version: 1, records: [
      { ...nested, registrationId: 'inside', allowedDirectory: inside },
      { ...nested, registrationId: 'outside', allowedDirectory: outside },
    ] }));
    const registry: Registry = {
      version: 2, revision: 0,
      hosts: [{ hostId: 'host', label: 'Host', enabled: true, allowedRoots: [root], target: { kind: 'local' } }],
      tasks: [{ taskId: 'task', hostId: 'host', label: 'Task', enabled: true, algorithm: 'generic',
        allowedDirectories: [inside, outside], entryPaths: [], checkpointDirectories: [],
        sources: [{ sourceId: 'log', kind: 'log', path: `${inside}/train.log` }] }],
    };
    const catalog = await loadRotationCatalog(filename, async () => registry);
    if (catalog.status !== 'configured') throw new Error('Expected rotation catalog');
    expect(catalog.listCandidates('log').map(item => item.registrationId)).toEqual(['inside']);
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
