import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRegistryStore, migrateRegistry } from '../../src/registry/config';
import { createPreferencesStore, migratePreferences } from '../../src/registry/preferences';
import { createDefaultRegistry } from '../../src/registry/presets';
import type { ConfigRecoveryNotice } from '../../src/shared/contracts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('v1 -> v2 registry migration and config recovery', () => {
  it('creates an empty neutral v2 default registry with no personal presets', async () => {
    const def = createDefaultRegistry();
    expect(def).toEqual({ version: 2, revision: 0, hosts: [], tasks: [] });
    const dir = await makeTempDir('monitor-v2-default-');
    const store = createRegistryStore(dir);
    expect(await store.loadRegistry()).toEqual({ version: 2, revision: 0, hosts: [], tasks: [] });
    expect(store.getRecoveryNotice()).toBeNull();
  });

  it('upgrades a legacy v1 registry (lab-campus / flow-cifar10 / autoStart) to v2 and writes atomic registry.v1.bak.json', async () => {
    const dir = await makeTempDir('monitor-v1-migrate-');
    const legacyV1 = {
      version: 1,
      revision: 7,
      hosts: [
        {
          hostId: 'lab-campus',
          label: 'Lab Campus',
          enabled: true,
          allowedRoots: ['/data2/cy/xzn'],
          target: { kind: 'ssh', alias: 'lab-campus' },
        },
        {
          hostId: 'wsl-local',
          label: 'WSL Local',
          enabled: false,
          allowedRoots: ['/home/user'],
          target: { kind: 'wsl', distribution: 'Ubuntu-26.04' },
        },
      ],
      tasks: [
        {
          taskId: 'flow-cifar10',
          hostId: 'lab-campus',
          label: 'Flow Matching',
          enabled: true,
          algorithm: 'flow',
          logFormat: 'flow',
          allowedDirectories: ['/data2/cy/xzn/Flow'],
          entryPaths: ['train.py'],
          sources: [{ sourceId: 'flow-log', path: '/data2/cy/xzn/Flow/train.log', kind: 'log' }],
          checkpointDirectories: ['/data2/cy/xzn/Flow/ckpt'],
          autoStart: {
            execution: 'server_tmux',
            enabled: true,
            armId: '12345678-1234-4234-8234-123456789abc',
            gpuDeviceIds: [],
            idleSeconds: 60,
            maxUtilizationPercent: 5,
            maxMemoryMiB: 1024,
            launch: {
              pythonPath: '/usr/bin/python3',
              entryPath: 'train.py',
              cwd: '/data2/cy/xzn/Flow',
              arguments: '--epochs 10',
              logSourceId: 'flow-log',
            },
          },
        },
      ],
    };
    const rawV1 = `${JSON.stringify(legacyV1, null, 2)}\n`;
    await writeFile(path.join(dir, 'registry.json'), rawV1, 'utf8');

    const store = createRegistryStore(dir);
    const migrated = await store.loadRegistry();

    expect(migrated.version).toBe(2);
    expect(migrated.revision).toBe(7);
    expect(migrated.hosts).toHaveLength(2);
    expect(migrated.hosts[0]).toMatchObject({ hostId: 'lab-campus', target: { kind: 'ssh', alias: 'lab-campus' } });
    expect(migrated.hosts[1]).toMatchObject({ hostId: 'wsl-local', target: { kind: 'wsl', distribution: 'Ubuntu-26.04' } });
    expect(migrated.tasks[0]).toMatchObject({
      taskId: 'flow-cifar10',
      logFormat: 'flow',
      autoStart: { execution: 'server_tmux', idleSeconds: 60 },
    });

    // Atomic v1 backup must preserve the exact pre-migration content
    const backupText = await readFile(path.join(dir, 'registry.v1.bak.json'), 'utf8');
    expect(backupText).toBe(rawV1);

    // Persisted registry.json on disk is now v2
    const diskJson = JSON.parse(await readFile(path.join(dir, 'registry.json'), 'utf8'));
    expect(diskJson.version).toBe(2);
    expect(diskJson.revision).toBe(7);

    // Subsequent loads are idempotent and do not overwrite backup
    expect(await createRegistryStore(dir).loadRegistry()).toEqual(migrated);
  });

  it('migrateRegistry rejects unsupported future versions', () => {
    expect(() => migrateRegistry({ version: 99, revision: 0, hosts: [], tasks: [] })).toThrow(/REGISTRY_INVALID|INVALID_REGISTRY/);
  });

  it('quarantines corrupt registry.json (malformed JSON or invalid schema) and notifies listener', async () => {
    const dir = await makeTempDir('monitor-registry-corrupt-');
    await writeFile(path.join(dir, 'registry.json'), '{"version": 2, broken', 'utf8');

    const notices: ConfigRecoveryNotice[] = [];
    const store = createRegistryStore(dir, { onRecovery: (n) => notices.push(n) });
    const loaded = await store.loadRegistry();

    expect(loaded).toEqual({ version: 2, revision: 0, hosts: [], tasks: [] });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ file: 'registry' });
    const files = await readdir(dir);
    const quarantined = files.find((f) => f.startsWith('registry.json.corrupt-') && f.endsWith('.bak'));
    expect(quarantined).toBeTruthy();
    expect(await readFile(path.join(dir, quarantined!), 'utf8')).toBe('{"version": 2, broken');

    // Schema-corrupt v2 file also quarantines safely
    await writeFile(path.join(dir, 'registry.json'), JSON.stringify({ version: 2, revision: -5, hosts: 'bad', tasks: [] }), 'utf8');
    const store2 = createRegistryStore(dir);
    const loaded2 = await store2.loadRegistry();
    expect(loaded2).toEqual({ version: 2, revision: 0, hosts: [], tasks: [] });
    expect(store2.getRecoveryNotice()?.file).toBe('registry');
  });

  it('migrates preferences.json with extended keys, ignores unknown future keys, and quarantines corrupt files', async () => {
    const upgraded = migratePreferences({
      theme: 'dark',
      locale: 'en-US',
      minimizeToTrayOnClose: true,
      launchAtLogin: false,
      windowBounds: { x: 10, y: 20, width: 1200, height: 800, isMaximized: false },
      futureUnknownFeatureFlag: { enabled: true },
    });
    expect(upgraded).toEqual({
      theme: 'dark',
      locale: 'en-US',
      minimizeToTrayOnClose: true,
      launchAtLogin: false,
      windowBounds: { x: 10, y: 20, width: 1200, height: 800, isMaximized: false },
    });

    const dir = await makeTempDir('monitor-prefs-corrupt-');
    await writeFile(path.join(dir, 'preferences.json'), '{not-valid-json', 'utf8');
    const notices: ConfigRecoveryNotice[] = [];
    const store = createPreferencesStore(dir, { onRecovery: (n) => notices.push(n) });
    const prefs = await store.load();
    expect(prefs).toEqual({ theme: 'system' });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.file).toBe('preferences');
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith('preferences.json.corrupt-') && f.endsWith('.bak'))).toBe(true);
  });
});
