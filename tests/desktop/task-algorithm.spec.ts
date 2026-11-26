import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('saves and reopens an arbitrary algorithm name through the production UI and IPC', async () => {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-algorithm-'));
  await writeFile(path.join(configDirectory, 'registry.json'), JSON.stringify({ version: 1, revision: 0, tasks: [],
    hosts: [{ hostId: 'algorithm-test', label: '测试宿主', enabled: false, allowedRoots: ['/simulated'], target: { kind: 'wsl', distribution: 'Ubuntu-26.04' } }] }));
  await writeFile(path.join(configDirectory, 'preferences.json'), JSON.stringify({ theme: 'light' }));
  const app = await electron.launch({ args: [path.resolve('dist/main.cjs'), `--user-data-dir=${configDirectory}`] });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 800));
    await page.getByRole('button', { name: '添加任务', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: '添加任务' });
    await dialog.getByLabel('任务 ID', { exact: true }).fill('universal-algorithm');
    await dialog.getByLabel('任务名称', { exact: true }).fill('通用训练任务');
    await dialog.getByRole('textbox', { name: '算法 / 模型名称（选填）' }).fill('自定义 Transformer + PPO');
    await dialog.getByLabel('工作目录', { exact: true }).fill('/simulated/project');
    await dialog.getByLabel('脚本入口', { exact: true }).fill('train.py');
    await dialog.getByLabel('日志路径', { exact: true }).fill('/simulated/project/train.log');
    await expect(dialog.getByRole('combobox', { name: '算法类型' })).toHaveCount(0);
    await dialog.getByText(/高级选项/).click();
    await expect(dialog.getByRole('combobox', { name: '日志识别' })).toHaveValue('generic');
    await page.screenshot({ path: path.resolve('test-results/algorithm-form-light.png') });
    await page.evaluate(() => window.monitor.savePreferences({ theme: 'dark' }));
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: path.resolve('test-results/algorithm-form-dark.png') });
    await dialog.getByRole('button', { name: '添加任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '通用训练任务' })).toBeVisible();
    const task = await page.evaluate(async () => (await window.monitor.getRegistry()).tasks.find(task => task.taskId === 'universal-algorithm'));
    expect(task).toMatchObject({ algorithm: '自定义 Transformer + PPO', logFormat: 'generic' });
    const saved = JSON.parse(await readFile(path.join(configDirectory, 'registry.json'), 'utf8'));
    expect(saved.tasks[0]).toMatchObject({ algorithm: '自定义 Transformer + PPO', logFormat: 'generic' });
    await page.reload();
    await page.getByRole('button', { name: '通用训练任务的任务菜单' }).click();
    await page.getByRole('menuitem', { name: '编辑任务' }).click();
    await expect(page.getByRole('textbox', { name: '算法 / 模型名称（选填）' })).toHaveValue('自定义 Transformer + PPO');
    await expect(page.getByLabel('日志识别')).toHaveValue('generic');
  } finally {
    await app.close();
    await rm(configDirectory, { recursive: true, force: true });
  }
});
