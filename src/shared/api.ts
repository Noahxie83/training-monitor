import type {
  AlertEvent,
  DiscoveredProcess,
  DiscoveredSshHost,
  DiscoveredWslDistro,
  GpuSeriesPoint,
  HostSeriesPoint,
  HostSnapshot,
  JobControlAction,
  JobControlResult,
  LogEvent,
  LogSourceSnapshot,
  MetricSeriesResponse,
  Preferences,
  Registry,
  SaveRegistryOptions,
  TaskSnapshot,
  WebhookChannelConfig,
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
  | { kind: 'logs'; sourceId: string; events: LogEvent[] }
  | { kind: 'alert'; alert: AlertEvent };

export interface LogQuery { requestId: string; sourceId: string; before: string | null; limit: number }
export interface LogPage { events: LogEvent[]; nextBefore: string | null; truncatedByBudget: boolean }

export type LogLevelFilter = 'error' | 'warn' | 'info' | 'debug';

export interface LogSearchRequest {
  requestId: string;
  sourceIds: string[];
  literal: string;
  continuation: string | null;
  mode?: 'literal' | 'regex';
  caseSensitive?: boolean;
  level?: LogLevelFilter | null;
}

export interface LogSearchPage { events: LogEvent[]; continuation: string | null; scope: 'retained_local'; cancelled: boolean }

export interface MetricSeriesQuery {
  taskId: string;
  metrics?: string[];
  rangeMs?: number;
  maxPoints?: number;
}

export interface GpuSeriesQuery {
  hostId: string;
  deviceId?: string;
  rangeMs?: number;
  maxPoints?: number;
}

export interface GpuSeriesResponse {
  hostId: string;
  gpu: GpuSeriesPoint[];
  host: HostSeriesPoint[];
}

export interface ExportLogsQuery {
  sourceIds: string[];
  literal?: string;
  mode?: 'literal' | 'regex';
  caseSensitive?: boolean;
  level?: LogLevelFilter | null;
  destinationPath?: string;
}

export interface ExportLogsResult {
  exportedCount: number;
  path: string | null;
}

export interface ControlTaskRequest {
  taskId: string;
  action: JobControlAction;
  confirmToken: string;
}

export interface MonitorApi {
  getSnapshot(): Promise<MonitorSnapshot>;
  subscribe(listener: (update: MonitorUpdate) => void): () => void;
  requestRefresh(scope: { hostId?: string; taskId?: string }): Promise<void>;
  getLogs(query: LogQuery): Promise<LogPage>;
  searchLogs(query: LogSearchRequest): Promise<LogSearchPage>;
  cancelRequest(requestId: string): Promise<void>;
  getRegistry(): Promise<Registry>;
  saveRegistry(registry: Registry, options?: SaveRegistryOptions): Promise<Registry>;
  getPreferences(): Promise<Preferences>;
  savePreferences(value: Preferences): Promise<Preferences>;
  copyRegisteredPath(value: { taskId: string; sourceId?: string }): Promise<void>;
  getMetricSeries?(query: MetricSeriesQuery): Promise<MetricSeriesResponse>;
  getGpuSeries?(query: GpuSeriesQuery): Promise<GpuSeriesResponse>;
  exportLogs?(query: ExportLogsQuery): Promise<ExportLogsResult>;
  discoverProcesses?(hostId: string): Promise<DiscoveredProcess[]>;
  controlTask?(request: ControlTaskRequest): Promise<JobControlResult>;
  testWebhook?(webhook: WebhookChannelConfig): Promise<{ ok: boolean; statusCode: number | null; error: string | null }>;
}

export const MONITOR_API_KEYS = [
  'cancelRequest',
  'controlTask',
  'copyRegisteredPath',
  'discoverProcesses',
  'exportLogs',
  'getGpuSeries',
  'getLogs',
  'getMetricSeries',
  'getPreferences',
  'getRegistry',
  'getSnapshot',
  'requestRefresh',
  'savePreferences',
  'saveRegistry',
  'searchLogs',
  'subscribe',
  'testWebhook',
] as const;

export type CopyCommandKind = 'ssh' | 'tmux_attach' | 'tail_log';

export interface OpenSshTerminalRequest {
  hostId: string;
  command?: string;
}

export interface CopyCommandRequest {
  kind: CopyCommandKind;
  hostId: string;
  taskId?: string;
  sourceId?: string;
}

/** Native window and host-environment actions are separate from the portable monitor data API. */
export interface DesktopApi {
  openGpuWindow(hostId?: string): Promise<void>;
  setActiveTask?(taskId: string | null): Promise<void>;
  copyDiagnosticText?(text: string): Promise<void>;
  onGpuHostSelected(listener: (hostId: string) => void): () => void;
  onPreferencesChanged(listener: (preferences: Preferences) => void): () => void;
  onRegistryChanged(listener: (registry: Registry) => void): () => void;
  discoverSshHosts(): Promise<DiscoveredSshHost[]>;
  discoverWslDistros(): Promise<DiscoveredWslDistro[]>;
  openSshTerminal?(request: OpenSshTerminalRequest): Promise<{ ok: boolean; command: string; error: string | null }>;
  copyCommand?(request: CopyCommandRequest): Promise<string>;
  onFocusTask?(listener: (taskId: string) => void): () => void;
}
