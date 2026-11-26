import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { desktopBuildOptions, stageDesktopResources } from './desktop-build.mjs';

const out = path.resolve('dist');
await rm(out, { recursive: true, force: true });
await esbuild(desktopBuildOptions(out));
await stageDesktopResources(out);
await viteBuild();
console.log('Build outputs: Electron main, preload, SQLite worker, and renderer.');
