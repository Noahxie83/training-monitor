import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/desktop', outputDir: './test-results/playwright', timeout: 30_000, workers: 1, reporter: 'list', use: { trace: 'off' } });
