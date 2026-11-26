import { app, dialog, shell } from 'electron';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ConfigRecoveryNotice, Preferences } from '../shared/contracts';

export const linuxDesktopName = 'training-monitor.desktop';

export function argument(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return undefined;
  const arg = process.argv[index]!;
  const value = arg === name ? process.argv[index + 1] : arg.slice(name.length + 1);
  if (!value || (arg === name && value.startsWith('--'))) throw new Error(`Missing value for ${name}`);
  return value;
}

export function configureUserData(ephemeral: boolean): { directory: string; isolated: boolean } {
  // Electron derives the standard path from its app name. Keep the pre-Phase 4
  // profile name so existing registry, preferences and SQLite files stay in place.
  app.setName('TrainingMonitor');
  const supplied = argument('--user-data-dir') ?? process.env.TRAINING_MONITOR_USER_DATA_DIR;
  if (supplied) {
    const directory = path.resolve(supplied);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    app.setPath('userData', directory);
    return { directory, isolated: true };
  }
  if (ephemeral) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'training-monitor-'));
    app.setPath('userData', directory);
    process.once('exit', () => {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); }
      catch (error) { console.warn('MONITOR_TEMP_PROFILE_CLEANUP_FAILED', error); }
    });
    return { directory, isolated: true };
  }
  return { directory: app.getPath('userData'), isolated: false };
}

export async function confirmConfigRecovery(
  notice: ConfigRecoveryNotice,
  directory: string,
  locale: Preferences['locale'],
): Promise<boolean> {
  const en = locale === 'en-US' || (locale === undefined && !app.getLocale().startsWith('zh'));
  const filename = notice.file + '.json';
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: en ? 'Training Monitor configuration' : '训练监控器配置',
    message: en ? `${filename} is damaged.` : `${filename} 已损坏。`,
    detail: en
      ? `A copy was saved to:\n${notice.backupPath}`
      : `原文件已备份至：\n${notice.backupPath}`,
    buttons: en ? ['Reset and continue', 'Open configuration folder'] : ['重置配置并继续启动', '打开配置目录排查'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) return true;
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  return false;
}

export async function showStartupError(error: unknown, directory: string): Promise<void> {
  const summary = error instanceof Error ? error.message : String(error);
  const details = error instanceof Error ? error.stack ?? summary : summary;
  const filename = path.join(directory, 'logs', 'startup.log');
  console.error('MONITOR_STARTUP_FAILED', details);
  try {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await appendFile(filename, `${new Date().toISOString()}\n${details}\n\n`, { mode: 0o600 });
  } catch (reason) {
    console.error('MONITOR_STARTUP_LOG_FAILED', reason);
  }
  if (app.getLocale().startsWith('zh')) {
    dialog.showErrorBox('训练监控器启动失败', `${summary}\n\n启动日志：${filename}`);
  } else {
    dialog.showErrorBox('Training Monitor could not start', `${summary}\n\nStartup log: ${filename}`);
  }
}

function desktopExecArgument(value: string): string {
  // The desktop-entry parser unescapes the key before parsing Exec's quoting.
  const escaped = value.replace(/["`$\\]/g, '\\$&').replace(/\\/g, '\\\\')
    .replace(/%/g, '%%').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  const args = process.defaultApp ? [app.getAppPath()] : [];
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: args.map((value) => `"${value}"`) });
  } else if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } else if (process.platform === 'linux') {
    const directory = path.join(app.getPath('appData'), 'autostart');
    const filename = path.join(directory, linuxDesktopName);
    if (!enabled) {
      await rm(filename, { force: true });
      return;
    }
    const executable = process.env.APPIMAGE ?? process.execPath;
    const exec = [executable, ...args].map(desktopExecArgument).join(' ');
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `[Desktop Entry]\nType=Application\nName=Training Monitor\nExec=${exec}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
