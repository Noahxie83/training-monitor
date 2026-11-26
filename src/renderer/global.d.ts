import type { DesktopApi, MonitorApi } from '../shared/api';
declare global { interface Window { monitor: MonitorApi; desktop?: DesktopApi } }
export {};
