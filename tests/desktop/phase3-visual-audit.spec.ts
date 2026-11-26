import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AUDIT_DIR = path.resolve('test-results/phase3-audit');

function parseRgb(color: string): [number, number, number] | null {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

async function setWindowSize(app: ElectronApplication, page: Page, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    if (win.isMaximized()) win.unmaximize();
  });
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized()))
    .toBe(false);
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  await page.waitForTimeout(120);
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(async (t) => {
    const cur = await window.monitor.getPreferences();
    await window.monitor.savePreferences({ ...cur, theme: t });
  }, theme);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', theme);
  await page.waitForTimeout(100);
}

async function assertNoOverflow(page: Page, context: string) {
  const res = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(res.scrollWidth, `Horizontal overflow in ${context}: ${JSON.stringify(res)}`).toBeLessThanOrEqual(
    res.innerWidth + 1,
  );
}

test('Phase 3 full multi-viewport dual-theme visual audit (1440x900, 1280x800, 960x650)', async () => {
  await mkdir(AUDIT_DIR, { recursive: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-phase3-audit-'));
  const entry = path.resolve('dist/phase3-audit-fixture.cjs');
  await build({
    entryPoints: ['tests/desktop/phase3-audit-fixture-main.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron', 'node:*'],
  });

  const app = await electron.launch({ args: [entry, `--user-data-dir=${directory}`] });
  const errors: string[] = [];

  try {
    const page = await app.firstWindow();
    page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.getByRole('heading', { name: 'Llama-3-8B LoRA SFT' }).waitFor();
    await expect(page.locator('.chart-line')).toBeVisible();

    // 1. Task Cockpit across 1440x900, 1280x800, 960x650 in BOTH light and dark themes
    const viewports: [number, number][] = [
      [1440, 900],
      [1280, 800],
      [960, 650],
    ];

    for (const [w, h] of viewports) {
      await setWindowSize(app, page, w, h);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await assertNoOverflow(page, `cockpit-${w}x${h}-${theme}`);

        // Verify log viewport visible above the fold
        const logBox = await page.locator('.log-viewport').boundingBox();
        expect(logBox).not.toBeNull();
        expect(logBox!.height, `Log height too small at ${w}x${h} ${theme}`).toBeGreaterThanOrEqual(
          h >= 800 ? 180 : 140,
        );

        // Verify active source tab contrast >= 4.5:1
        const tabColors = await page.locator('.source-tab-btn.is-active').evaluate((el) => {
          const cs = getComputedStyle(el);
          return { fg: cs.color, bg: cs.backgroundColor };
        });
        const fg = parseRgb(tabColors.fg);
        const bg = parseRgb(tabColors.bg);
        if (fg && bg) {
          expect(
            contrastRatio(fg, bg),
            `Low active source-tab contrast in ${theme}: ${JSON.stringify(tabColors)}`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        await page.screenshot({ path: path.join(AUDIT_DIR, `cockpit-${w}x${h}-${theme}.png`) });
      }
    }

    // 2. Host Overview (8 GPUs + FleetSummaryStrip + Sparklines + VRAM bars) across 3 resolutions × 2 themes
    await page.getByRole('button', { name: '选择宿主 gpu-cluster-a100' }).click();
    await expect(page.getByRole('main', { name: '宿主首页' })).toBeVisible();
    await expect(page.locator('.fleet-summary-strip')).toBeVisible();
    await expect(page.locator('.gpu-memory-meter')).toHaveCount(8);

    for (const [w, h] of viewports) {
      await setWindowSize(app, page, w, h);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await assertNoOverflow(page, `host-overview-${w}x${h}-${theme}`);

        // Verify VRAM bars have visible non-zero height
        const memMeterBox = await page.locator('.gpu-memory-meter').first().boundingBox();
        expect(memMeterBox).not.toBeNull();
        expect(memMeterBox!.height).toBeGreaterThanOrEqual(4);

        await page.screenshot({ path: path.join(AUDIT_DIR, `host-overview-${w}x${h}-${theme}.png`) });
      }
    }

    // 3. Empty-task host onboarding view (1280x800 light & dark)
    await setWindowSize(app, page, 1280, 800);
    await page.getByRole('button', { name: '选择宿主 workstation-local' }).click();
    await expect(page.getByRole('heading', { name: '暂无已登记任务' })).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await assertNoOverflow(page, `host-empty-1280x800-${theme}`);
      await page.screenshot({ path: path.join(AUDIT_DIR, `host-empty-1280x800-${theme}.png`) });
    }

    // 4. Task Editor + AutoStart 3-section modal (1280x800 & 960x650, light & dark)
    await page.getByText('Llama-3-8B LoRA SFT', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Llama-3-8B LoRA SFT' })).toBeVisible();
    await page.getByRole('button', { name: '编辑自动启动配置' }).click();
    const taskDialog = page.getByRole('dialog', { name: '编辑任务' });
    await expect(taskDialog).toBeVisible();

    for (const [w, h] of [
      [1280, 800],
      [960, 650],
    ] as [number, number][]) {
      await setWindowSize(app, page, w, h);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await assertNoOverflow(page, `task-editor-${w}x${h}-${theme}`);

        // Check primary button contrast >= 4.5:1
        const btnColors = await taskDialog.locator('.btn-primary').first().evaluate((el) => {
          const cs = getComputedStyle(el);
          return { fg: cs.color, bg: cs.backgroundColor };
        });
        const fg = parseRgb(btnColors.fg);
        const bg = parseRgb(btnColors.bg);
        if (fg && bg) {
          expect(
            contrastRatio(fg, bg),
            `Low primary button contrast in ${theme}: ${JSON.stringify(btnColors)}`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        await page.screenshot({ path: path.join(AUDIT_DIR, `task-editor-${w}x${h}-${theme}.png`) });
      }
    }
    await taskDialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(taskDialog).toBeHidden();

    // 5. Settings Modal (all 3 tabs) at 1280x800 in light & dark
    await setWindowSize(app, page, 1280, 800);
    await page.getByRole('button', { name: '系统设置' }).click();
    const settingsDialog = page.getByRole('dialog', { name: '系统设置' });
    await expect(settingsDialog).toBeVisible();

    for (const [tabSlug, tabLabel] of [
      ['appearance', '外观与语言'],
      ['hosts', '宿主管理'],
      ['alerts', '告警与通知'],
    ] as const) {
      await settingsDialog.getByRole('tab', { name: tabLabel }).click();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await assertNoOverflow(page, `settings-${tabSlug}-${theme}`);
        await page.screenshot({ path: path.join(AUDIT_DIR, `settings-${tabSlug}-1280x800-${theme}.png`) });
      }
    }
    await settingsDialog.getByRole('button', { name: '关闭设置' }).click();
    await expect(settingsDialog).toBeHidden();

    // 6. Process Discovery Modal at 1280x800 in light & dark
    await page.getByRole('button', { name: '扫描当前宿主运行中的训练进程' }).click();
    const discoveryDialog = page.getByRole('dialog', { name: '发现运行中的训练进程' });
    await expect(discoveryDialog).toBeVisible();
    await expect(discoveryDialog.getByText('Reward Model Training')).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: path.join(AUDIT_DIR, `process-discovery-1280x800-${theme}.png`) });
    }
    await page.keyboard.press('Escape');
    await expect(discoveryDialog).toBeHidden();

    // 7. Standalone GPU Monitor Window (normal + native maximized) in light & dark
    await setTheme(page, 'light');
    const gpuOpened = app.waitForEvent('window');
    await page.getByRole('button', { name: '打开 GPU 实时监控窗口' }).click();
    const gpuPage = await gpuOpened;
    gpuPage.on('pageerror', (err) => errors.push(`gpu pageerror: ${String(err)}`));
    await gpuPage.getByRole('meter', { name: 'GPU 7 利用率' }).waitFor();

    // Normal size 1080x780
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=gpu'))!;
      win.unmaximize();
      win.setContentSize(1080, 780);
    });
    await expect.poll(() => gpuPage.evaluate(() => innerWidth)).toBe(1080);
    await gpuPage.waitForTimeout(120);
    await gpuPage.screenshot({ path: path.join(AUDIT_DIR, 'gpu-window-normal-light.png') });

    await setTheme(gpuPage, 'dark');
    await gpuPage.screenshot({ path: path.join(AUDIT_DIR, 'gpu-window-normal-dark.png') });

    // Native Maximized
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=gpu'))!;
      win.maximize();
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().includes('view=gpu'))!
            .isMaximized(),
        ),
      )
      .toBe(true);
    await gpuPage.waitForTimeout(150);
    await assertNoOverflow(gpuPage, 'gpu-window-maximized-dark');
    await gpuPage.screenshot({ path: path.join(AUDIT_DIR, 'gpu-window-maximized-dark.png') });

    await setTheme(gpuPage, 'light');
    await assertNoOverflow(gpuPage, 'gpu-window-maximized-light');
    await gpuPage.screenshot({ path: path.join(AUDIT_DIR, 'gpu-window-maximized-light.png') });

    await gpuPage.close();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
