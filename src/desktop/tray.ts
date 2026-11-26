import { Menu, Tray, type MenuItemConstructorOptions } from 'electron';
import type { Preferences } from '../shared/contracts';
import { desktopIconPath } from './window';

interface TrayStatus {
  locale: Preferences['locale'];
  visible: boolean;
  running: number;
  alerts: number;
  paused: boolean;
}

interface TrayActions {
  show(): void;
  hide(): void;
  openGpu(): void;
  toggleCollection(): void;
  quit(): void;
}

export function createMonitorTray(actions: TrayActions) {
  const filename = process.platform === 'darwin'
    ? 'trayTemplate.png'
    : process.platform === 'win32' ? 'icon.ico' : 'tray.png';
  const tray = new Tray(desktopIconPath(filename));
  tray.setToolTip('Training Monitor');
  tray.on('click', actions.show);
  tray.on('double-click', actions.show);
  let menu: Menu;
  let previousStatus: string | undefined;
  if (process.platform === 'darwin') tray.on('right-click', () => { if (menu) tray.popUpContextMenu(menu); });
  return {
    update(status: TrayStatus) {
      const statusKey = JSON.stringify(status);
      if (statusKey === previousStatus) return;
      previousStatus = statusKey;
      const { locale, visible, running, alerts, paused } = status;
      const en = locale === 'en-US';
      const items: MenuItemConstructorOptions[] = [
        { label: en ? `Running ${running} · Alerts ${alerts}` : `运行中 ${running} · 告警 ${alerts}`, enabled: false },
        { type: 'separator' },
        {
          label: visible ? (en ? 'Hide main window' : '隐藏主窗口') : (en ? 'Show main window' : '显示主窗口'),
          click: visible ? actions.hide : actions.show,
        },
        { label: en ? 'Open GPU monitor' : '打开 GPU 实时监控', click: actions.openGpu },
        {
          label: paused ? (en ? 'Resume background collection' : '恢复后台采集') : (en ? 'Pause background collection' : '暂停后台采集'),
          click: actions.toggleCollection,
        },
        { type: 'separator' },
        { label: en ? 'Quit' : '退出应用', click: actions.quit },
      ];
      menu = Menu.buildFromTemplate(items);
      // macOS suppresses the click events when a persistent menu is attached.
      if (process.platform !== 'darwin') tray.setContextMenu(menu);
    },
    destroy: () => tray.destroy(),
  };
}
