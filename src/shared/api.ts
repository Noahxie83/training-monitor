import type {
  DiscoveredSshHost,
  DiscoveredWslDistro,
  HostSnapshot,
  LogEvent,
  LogSourceSnapshot,
  Preferences,
  Registry,
  TaskSnapshot,
} from './contracts';

export interface MonitorSnapshot {
  version: 1;
  demo: boolean;
  hosts: HostSnapshot[];
  tasks: TaskSnapshot[];
  sources: LogSourceSnapshot[];
}
export type MonitorUpdate =
  | { kind: 'snapshot'; snapshot: MonitorSnapshot }
  | { kind: 'logs'; sourceId: string; events: LogEvent[] };
export interface LogQuery { requestId: string; sourceId: string; before: string | null; limit: number }
export interface LogPage { events: LogEvent[]; nextBefore: string | null; truncatedByBudget: boolean }
export interface LogSearchRequest { requestId: string; sourceIds: string[]; literal: string; continuation: string | null }
export interface LogSearchPage { events: LogEvent[]; continuation: string | null; scope: 'retained_local'; cancelled: boolean }

export interface MonitorApi {
  getSnapshot(): Promise<MonitorSnapshot>;
  subscribe(listener: (update: MonitorUpdate) => void): () => void;
  requestRefresh(scope: { hostId?: string; taskId?: string }): Promise<void>;
  getLogs(query: LogQuery): Promise<LogPage>;
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage>;
  cancelRequest(requestId: string): Promise<void>;
  getRegistry(): Promise<Registry>;
  saveRegistry(registry: Registry): Promise<Registry>;
  getPreferences(): Promise<Preferences>;
  savePreferences(value: Preferences): Promise<Preferences>;
  copyRegisteredPath(value: { taskId: string; sourceId?: string }): Promise<void>;
}

export const MONITOR_API_KEYS = [
  'cancelRequest',
  'copyRegisteredPath',
  'getLogs',
  'getPreferences',
  'getRegistry',
  'getSnapshot',
  'requestRefresh',
  'savePreferences',
  'saveRegistry',
  'searchLogs',
  'subscribe',
] as const;

/** Native window and host-environment actions are separate from the portable monitor data API. */
export interface DesktopApi {
  openGpuWindow(hostId?: string): Promise<void>;
  onGpuHostSelected(listener: (hostId: string) => void): () => void;
  onPreferencesChanged(listener: (preferences: Preferences) => void): () => void;
  onRegistryChanged(listener: (registry: Registry) => void): () => void;
  discoverSshHosts(): Promise<DiscoveredSshHost[]>;
  discoverWslDistros(): Promise<DiscoveredWslDistro[]>;
}
