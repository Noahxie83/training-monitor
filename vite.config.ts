import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export default defineConfig({
  root: process.cwd(),
  base: './',
  plugins: [
    react(),
    {
      name: 'training-monitor-dev-csp',
      apply: 'serve',
      transformIndexHtml: {
        order: 'post',
        handler(html, { server }) {
          const nonce = randomBytes(16).toString('base64');
          const port = server?.config.server.port ?? 5173;
          return html
            .replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`)
            .replace("connect-src 'none';", `connect-src 'self' ws://127.0.0.1:${port};`)
            .replace(/<script\b/g, `<script nonce="${nonce}"`);
        },
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: path.resolve('dist/renderer'), emptyOutDir: true, sourcemap: false },
});
