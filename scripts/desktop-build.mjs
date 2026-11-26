import { copyFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function desktopBuildOptions(outdir) {
  return {
    entryPoints: {
      main: 'src/desktop/main.ts',
      preload: 'src/desktop/preload.ts',
      'runtime-canary': 'src/desktop/runtime-canary.ts',
      'store-worker': 'src/store/worker.ts',
    },
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron', 'node:*'],
  };
}

export async function stageDesktopResources(outdir) {
  for (const file of ['probe/readonly_probe.py', 'launch/launcher.py', 'launch/server_agent.py']) {
    const destination = path.join(outdir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join('src', file), destination);
  }
  await cp('assets/icons', path.join(outdir, 'assets', 'icons'), { recursive: true });
}
