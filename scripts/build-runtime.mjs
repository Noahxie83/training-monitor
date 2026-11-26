import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'test-results', 'runtime');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/desktop/main.ts')],
  outfile: path.join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron', 'node:*'],
});
await build({
  entryPoints: [path.join(root, 'src/store/worker.ts')],
  outfile: path.join(out, 'store-worker.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['node:*'],
});
console.log('Built Electron main and its production SQLite store worker under test-results/runtime without touching dist.');
