import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
await mkdir('dist', { recursive: true });
await mkdir('test-results', { recursive: true });
await build({ entryPoints: ['src/desktop/sqlite-worker.cjs'], outfile: path.resolve('dist/sqlite-worker.cjs'), bundle: false, platform: 'node', format: 'cjs', target: 'node24' });
await build({ entryPoints: ['src/store/worker.ts'], outfile: path.resolve('dist/store-worker.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['node:*'] });
await build({ entryPoints: ['tests/store/helpers/test-worker.ts'], outfile: path.resolve('test-results/store-test-worker.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['node:*'] });
console.log('SQLite canary, store worker, and test-only store harness built for the current Electron runtime.');
