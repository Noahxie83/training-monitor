import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const entry of ['main', 'preload', 'runtime-canary']) {
  await esbuild({ entryPoints: [path.join(root, `src/desktop/${entry}.ts`)], outfile: path.join(out, `${entry}.cjs`), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:*'], sourcemap: false });
}
await esbuild({ entryPoints: [path.join(root, 'src/store/worker.ts')], outfile: path.join(out, 'store-worker.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['node:*'], sourcemap: false });
await copyFile(path.join(root, 'src/desktop/sqlite-worker.cjs'), path.join(out, 'sqlite-worker.cjs'));
await mkdir(path.join(out, 'probe'), { recursive: true });
await copyFile(path.join(root, 'src/probe/README.txt'), path.join(out, 'probe/README.txt'));
await copyFile(path.join(root, 'src/probe/readonly_probe.py'), path.join(out, 'probe/readonly_probe.py'));
await mkdir(path.join(out, 'launch'), { recursive: true });
await copyFile(path.join(root, 'src/launch/launcher.py'), path.join(out, 'launch/launcher.py'));
await copyFile(path.join(root, 'src/launch/server_agent.py'), path.join(out, 'launch/server_agent.py'));
await viteBuild({ configFile: path.join(root, 'vite.config.ts') });
console.log('Build outputs: Electron main, preload, SQLite worker, and renderer.');
