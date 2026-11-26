import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: process.cwd(),
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', strictPort: true },
  build: { outDir: path.resolve('dist/renderer'), emptyOutDir: true, sourcemap: false },
});
