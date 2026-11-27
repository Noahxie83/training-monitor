// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../../src/renderer/App';
import { AutoStartFields, buildAutoStartPayload, createAutoStartDraft } from '../../src/renderer/components/AutoStartFields';
import { AutoStartPanel } from '../../src/renderer/components/AutoStartPanel';
import { EvidenceDrawer } from '../../src/renderer/components/EvidenceDrawer';
import { GpuMonitor } from '../../src/renderer/components/GpuMonitor';
import { LogConsole } from '../../src/renderer/components/LogConsole';
import { SettingsModal } from '../../src/renderer/components/SettingsModal';
import { Sparkline } from '../../src/renderer/components/Sparkline';
import { TaskCockpit } from '../../src/renderer/components/TaskCockpit';
import { TaskEditor } from '../../src/renderer/components/TaskEditor';
import { TaskFleetTree } from '../../src/renderer/components/TaskFleetTree';
import { parseAndValidateTaskForm } from '../../src/renderer/components/task-form';
import { I18nProvider } from '../../src/renderer/i18n';
import { enUS } from '../../src/renderer/i18n/en-US';
import { zhCN } from '../../src/renderer/i18n/zh-CN';
import { HostUnreachableReconcileClientError } from '../../src/renderer/hooks/useMonitor';
import type { DesktopApi, MonitorSnapshot } from '../../src/shared/api';
import type {
  AutoStartConfig,
  AutoStartStatus,
  GpuSeriesPoint,
  LogEvent,
  Registry,
  TaskSnapshot,
} from '../../src/shared/contracts';
import {
  createControlledMockApi,
  testFlowSource,
  testFlowTask,
  testHostConnected,
  testHostWslUnobserved,
  testRegistry,
} from './fixtures';

const CJK_RE = /[\u4e00-\u9fff]/;

function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...collectKeys(v as Record<string, unknown>, next));
    } else {
      out.push(next);
    }
  }
  return out.sort();
}

function walkFiles(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, exts, out);
    else if (exts.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

function createMockDesktop(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    platform: 'linux',
    openGpuWindow: vi.fn().mockResolvedValue(undefined),
    clearAlerts: vi.fn().mockResolvedValue(undefined),
    setActiveTask: vi.fn().mockResolvedValue(undefined),
    copyDiagnosticText: vi.fn().mockResolvedValue(undefined),
    onGpuHostSelected: vi.fn(() => () => {}),
    onPreferencesChanged: vi.fn(() => () => {}),
    onRegistryChanged: vi.fn(() => () => {}),
    discoverSshHosts: vi.fn().mockResolvedValue([]),
    discoverWslDistros: vi.fn().mockResolvedValue([]),
    openSshTerminal: vi.fn().mockResolvedValue({ ok: true, command: 'ssh test', error: null }),
    copyCommand: vi.fn().mockResolvedValue('ssh test'),
    onFocusTask: vi.fn(() => () => {}),
    ...overrides,
  };
}

function makeAutoStartConfig(overrides: Partial<AutoStartConfig> = {}): AutoStartConfig {
  return {
    execution: 'server_tmux',
    enabled: true,
    armId: 'arm-1',
    gpuDeviceIds: ['GPU 0'],
    idleSeconds: 60,
    maxUtilizationPercent: 10,
    maxMemoryMiB: 1024,
    launch: {
      mode: 'python_script',
      pythonPath: '/usr/bin/python3',
      entryPath: 'train.py',
      cwd: '/data2/cy/xzn/Code/Flow_Matching',
      arguments: '',
      logSourceId: 'flow-log',
    },
    ...overrides,
  };
}

function makeAutoStartStatus(overrides: Partial<AutoStartStatus> = {}): AutoStartStatus {
  return {
    execution: 'server_tmux',
    remoteConfirmed: true,
    sessionName: 'tm-session-1',
    selectedDeviceId: 'GPU 0',
    armId: 'arm-1',
    phase: 'waiting',
    idleElapsedSeconds: 0,
    requiredIdleSeconds: 60,
    lastCheckedAt: '2026-10-18T20:30:00Z',
    startedAt: null,
    pid: null,
    errorCode: null,
    message: null,
    ...overrides,
  };
}

function LogConsoleHarness({ events }: { events: LogEvent[] }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isScrollLocked, setIsScrollLocked] = useState(true);
  const [isWrapLines, setIsWrapLines] = useState(true);
  return (
    <I18nProvider locale="en-US">
      <LogConsole
        sources={[testFlowSource]}
        activeSource={testFlowSource}
        activeSourceId={testFlowSource.sourceId}
        onSelectSource={vi.fn()}
        events={events}
        totalBufferedCount={events.length}
        totalBufferedBytes={128}
        isScrollLocked={isScrollLocked}
        setIsScrollLocked={setIsScrollLocked}
        unreadCount={0}
        onResumeAutoScroll={vi.fn()}
        onToggleScrollLock={() => setIsScrollLocked((v) => !v)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isSearching={false}
        isWrapLines={isWrapLines}
        onToggleWrapLines={() => setIsWrapLines((v) => !v)}
        onRefresh={vi.fn()}
      />
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { desktop?: DesktopApi }).desktop;
  document.documentElement.classList.remove('platform-darwin');
});

describe('Phase 5b Polish & Wiring Verification', () => {
  it('enforces 100% zh-CN / en-US key parity, zero CJK outside i18n dicts, --danger-ink contrast, and safe-area CSS', () => {
    const zhKeys = collectKeys(zhCN as unknown as Record<string, unknown>);
    const enKeys = collectKeys(enUS as unknown as Record<string, unknown>);
    expect(enKeys).toEqual(zhKeys);
    const zhKeySet = new Set(zhKeys);

    const rendererFiles = walkFiles(path.resolve('src/renderer'), ['.ts', '.tsx']).filter(
      (p) => !p.endsWith(`${path.sep}zh-CN.ts`) && !p.endsWith(`${path.sep}en-US.ts`),
    );
    const cjkViolations: string[] = [];
    const missingKeyViolations: string[] = [];
    for (const file of rendererFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (CJK_RE.test(content)) cjkViolations.push(path.relative(process.cwd(), file));
      for (const m of content.matchAll(/\b(?:t\(|translate\([^,]+,\s*)'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'/g)) {
        const key = m[1]!;
        if (!zhKeySet.has(key)) missingKeyViolations.push(`${path.relative(process.cwd(), file)}: ${key}`);
      }
    }
    expect(cjkViolations).toEqual([]);
    expect(missingKeyViolations).toEqual([]);

    const tokensCss = fs.readFileSync(path.resolve('src/renderer/styles/tokens.css'), 'utf8');
    const primitivesCss = fs.readFileSync(path.resolve('src/renderer/styles/primitives.css'), 'utf8');
    const layoutCss = fs.readFileSync(path.resolve('src/renderer/styles/layout.css'), 'utf8');
    const gpuCss = fs.readFileSync(path.resolve('src/renderer/styles/gpu.css'), 'utf8');
    const cockpitCss = fs.readFileSync(path.resolve('src/renderer/styles/cockpit.css'), 'utf8');

    expect(tokensCss).toContain('--danger-ink: #FFFFFF;');
    expect(tokensCss).toContain('--danger-ink: #0B1120;');
    expect(primitivesCss).toContain('color: var(--danger-ink);');
    expect(primitivesCss).not.toMatch(/\.btn-danger:hover[\s\S]*?color:\s*#FFFFFF/i);
    expect(layoutCss).toContain('color: var(--danger-ink);');
    expect(layoutCss).toContain('html.platform-darwin');
    expect(layoutCss).toContain('--titlebar-inset-left: 78px;');
    expect(gpuCss).toMatch(/@media\s*\(max-width:\s*700px\)\s*\{[\s\S]*?\.gpu-monitor-toolbar\s*\{[\s\S]*?env\(titlebar-area-x/);
    expect(cockpitCss).toContain('.cockpit-right-card.is-wide-split .right-tabs-bar');
  });

  it('P0.1: prompts ForceLocalReconcileModal and retries with { forceLocal: true } in TaskEditor, SettingsModal, and App', async () => {
    // 1. TaskEditor
    const taskSaveSpy = vi
      .fn()
      .mockRejectedValueOnce(new HostUnreachableReconcileClientError(2, 'HOST_UNREACHABLE_RECONCILE:2'))
      .mockImplementationOnce(async (reg: Registry) => reg);
    const onSaved = vi.fn();

    render(
      <I18nProvider locale="zh-CN">
        <TaskEditor
          registry={structuredClone(testRegistry)}
          task={testRegistry.tasks[0]!}
          onClose={vi.fn()}
          onSave={taskSaveSpy}
          onSaved={onSaved}
          onReload={vi.fn(async () => testRegistry)}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    const dialog = await screen.findByRole('alertdialog', { name: /宿主当前失联/ });
    expect(dialog.textContent).toContain('2');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认本地保存并登记补发' }));
    await waitFor(() => {
      expect(taskSaveSpy).toHaveBeenCalledTimes(2);
    });
    expect(taskSaveSpy.mock.calls[1]?.[1]).toEqual({ forceLocal: true });
    expect(onSaved).toHaveBeenCalledTimes(1);

    // 2. SettingsModal
    cleanup();
    const settingsSaveSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('HOST_UNREACHABLE_RECONCILE:1'))
      .mockImplementationOnce(async (reg: Registry) => reg);

    render(
      <I18nProvider locale="en-US">
        <SettingsModal
          isOpen
          preferences={{ theme: 'dark', locale: 'en-US' }}
          registry={structuredClone(testRegistry)}
          initialTab="hosts"
          onClose={vi.fn()}
          onUpdatePreferences={vi.fn().mockResolvedValue(undefined)}
          onUpdateRegistry={settingsSaveSpy}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Hosts' }));
    const settingsConfirm = await screen.findByRole('alertdialog', { name: /Host Unreachable/i });
    fireEvent.click(within(settingsConfirm).getByRole('button', { name: /Save Locally & Queue Cancel/i }));
    await waitFor(() => {
      expect(settingsSaveSpy).toHaveBeenCalledTimes(2);
    });
    expect(settingsSaveSpy.mock.calls[1]?.[1]).toEqual({ forceLocal: true });

    // 3. App auto-start disable flow
    cleanup();
    const regWithAutoStart: Registry = structuredClone(testRegistry);
    regWithAutoStart.tasks[0]!.autoStart = makeAutoStartConfig();
    const api = createControlledMockApi({ registry: regWithAutoStart });
    const appSaveSpy = vi
      .spyOn(api, 'saveRegistry')
      .mockRejectedValueOnce(new Error('HOST_UNREACHABLE_RECONCILE:1'))
      .mockImplementationOnce(async (reg: Registry) => ({ ...reg, revision: reg.revision + 1 }));
    window.monitor = api;
    window.desktop = createMockDesktop();

    render(<App />);
    const disableBtn = await screen.findByRole('button', { name: '停用自动启动' });
    fireEvent.click(disableBtn);
    const appConfirm = await screen.findByRole('alertdialog', { name: /宿主当前失联/ });
    fireEvent.click(within(appConfirm).getByRole('button', { name: '确认本地保存并登记补发' }));
    await waitFor(() => {
      expect(appSaveSpy).toHaveBeenCalledTimes(2);
    });
    expect(appSaveSpy.mock.calls[1]?.[1]).toEqual({ forceLocal: true });
  });

  it('P0.2 & P2.4: LogConsole stays silent on cancelled/null export, shows filename+count on write, localizes levelFilterAria, and highlights across ANSI segments', async () => {
    const exportLogs = vi
      .fn()
      .mockResolvedValueOnce({ exportedCount: 0, path: null, cancelled: true })
      .mockResolvedValueOnce({ exportedCount: 0, path: null })
      .mockResolvedValueOnce({ exportedCount: 7, path: '/tmp/exports/run-07.log' });
    const api = createControlledMockApi();
    api.exportLogs = exportLogs;
    window.monitor = api;
    window.desktop = createMockDesktop();

    const events: LogEvent[] = [
      {
        version: 1,
        eventId: 'e1',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'g1',
        kind: 'line',
        startOffset: '0',
        endOffset: '40',
        ingestedAt: '2026-10-18T20:30:00Z',
        text: 'CUDA out of memory during backward',
        rawAnsi: '\x1B[31mCUDA\x1B[0m out of \x1B[33mmemory\x1B[0m during backward',
        reason: null,
        displayTruncated: false,
        recordComplete: true,
        prefixIncomplete: false,
        runId: null,
        bindingId: null,
      },
    ];

    const { container } = render(<LogConsoleHarness events={events} />);

    await screen.findByText(/during backward/);
    const exportBtn = screen.getByRole('button', { name: 'Export logs' });

    // 1. Cancelled -> no success notice
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportLogs).toHaveBeenCalledTimes(1));
    expect(container.querySelector('.log-status-notice')).toBeNull();

    // 2. path === null -> no success notice
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportLogs).toHaveBeenCalledTimes(2));
    expect(container.querySelector('.log-status-notice')).toBeNull();

    // 3. Written -> shows filename & count
    fireEvent.click(exportBtn);
    const notice = await screen.findByText(/run-07\.log/);
    expect(notice.textContent).toContain('7');

    // Cross-ANSI search highlighting + localized levelFilterAria
    expect(screen.getByRole('group', { name: 'Log level filter' })).toBeDefined();
    const searchInput = screen.getByPlaceholderText('Search logs (Ctrl+F)…');
    fireEvent.change(searchInput, { target: { value: 'CUDA out of memory' } });
    await waitFor(() => {
      const marks = Array.from(container.querySelectorAll('mark.log-mark'));
      expect(marks.map((m) => m.textContent).join('')).toBe('CUDA out of memory');
    });
  });

  it('P1.1 & P2.3: SettingsModal revokes allowJobControl, resets pollIntervalMs=5, edits SSH IdentityFile/ProxyJump, supports webhook enabled/label & alert string drafts & centered delete modal', async () => {
    const reg: Registry = structuredClone(testRegistry);
    reg.hosts[0] = {
      ...reg.hosts[0]!,
      allowJobControl: true,
      pollIntervalMs: 15000,
    };
    const saveRegistrySpy = vi.fn().mockImplementation(async (next: Registry) => next);
    const savePrefsSpy = vi.fn().mockResolvedValue(undefined);

    render(
      <I18nProvider locale="zh-CN">
        <SettingsModal
          isOpen
          preferences={{
            theme: 'dark',
            locale: 'zh-CN',
            alerts: {
              desktopNotifications: true,
              stallThresholdMinutes: 20,
              hostDisconnectThresholdSeconds: 60,
              cooldownSeconds: 180,
              enabledKinds: ['cuda_oom'],
              webhooks: [{ enabled: true, kind: 'feishu', url: 'https://example.com/hook', label: 'Lab Bot' }],
            },
          }}
          registry={reg}
          initialTab="hosts"
          onClose={vi.fn()}
          onUpdatePreferences={savePrefsSpy}
          onUpdateRegistry={saveRegistrySpy}
        />
      </I18nProvider>,
    );

    // Edit host 0: revoke allowJobControl, reset pollIntervalMs to 5, set IdentityFile & ProxyJump
    const editButtons = screen.getAllByRole('button', { name: '编辑' });
    fireEvent.click(editButtons[0]!);

    const jobControlCheckbox = screen.getByRole('checkbox', { name: /允许远程作业控制/ }) as HTMLInputElement;
    expect(jobControlCheckbox.checked).toBe(true);
    fireEvent.click(jobControlCheckbox);

    const pollInput = screen.getByLabelText('轮询间隔') as HTMLInputElement;
    expect(pollInput.value).toBe('15');
    fireEvent.change(pollInput, { target: { value: '5' } });

    fireEvent.change(screen.getByLabelText('编辑 SSH 私钥路径'), { target: { value: '~/.ssh/id_a100' } });
    fireEvent.change(screen.getByLabelText('编辑 SSH 跳板机'), { target: { value: 'bastion.lab.edu' } });

    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '保存宿主配置' }));

    await waitFor(() => expect(saveRegistrySpy).toHaveBeenCalledTimes(1));
    const savedHost = (saveRegistrySpy.mock.calls[0]![0] as Registry).hosts[0]!;
    expect('allowJobControl' in savedHost).toBe(false);
    expect('pollIntervalMs' in savedHost).toBe(false);
    expect(savedHost.target).toMatchObject({
      kind: 'ssh',
      identityFile: '~/.ssh/id_a100',
      proxyJump: 'bastion.lab.edu',
    });

    // Delete host with tasks renders centered nested alertdialog
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    fireEvent.click(deleteButtons[0]!);
    const deleteDialog = screen.getByRole('alertdialog', { name: '确认删除宿主？' });
    expect(deleteDialog.closest('.modal-overlay.is-nested')).not.toBeNull();
    fireEvent.click(within(deleteDialog).getByRole('button', { name: '取消' }));

    // Switch to Alerts tab: string draft clearing does not snap back; invalid fails validation; webhook toggle & label persist
    const alertsTab = screen.getByRole('tab', { name: '告警与通知' });
    expect(alertsTab.getAttribute('aria-controls')).toBe('settings-panel-alerts');
    fireEvent.click(alertsTab);
    expect(document.getElementById('settings-panel-alerts')?.getAttribute('role')).toBe('tabpanel');

    const stallInput = screen.getByLabelText('停滞判定时长 (分钟)') as HTMLInputElement;
    fireEvent.change(stallInput, { target: { value: '' } });
    expect(stallInput.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '保存告警配置' }));
    expect(await screen.findByText(/停滞判定时长需为 1–1440/)).toBeDefined();
    expect(savePrefsSpy).not.toHaveBeenCalled();

    fireEvent.change(stallInput, { target: { value: '45' } });
    const hookEnable = screen.getByLabelText('启用 Webhook 1') as HTMLInputElement;
    fireEvent.click(hookEnable);
    const hookLabel = screen.getByLabelText('Webhook 标签 1') as HTMLInputElement;
    fireEvent.change(hookLabel, { target: { value: 'On-call Group' } });
    fireEvent.click(screen.getByRole('button', { name: '保存告警配置' }));

    await waitFor(() => expect(savePrefsSpy).toHaveBeenCalledTimes(1));
    expect(savePrefsSpy.mock.calls[0]![0].alerts).toMatchObject({
      stallThresholdMinutes: 45,
      webhooks: [
        {
          enabled: false,
          kind: 'feishu',
          url: 'https://example.com/hook',
          label: 'On-call Group',
        },
      ],
    });
  });

  it('P1.2 & P2.2: TaskCockpit resets wide-split tab state across tasks, exposes Kill (SIGKILL), and provides Terminal command dropdown', async () => {
    const api = createControlledMockApi();
    api.getMetricSeries = vi
      .fn()
      .mockResolvedValueOnce({
        taskId: 'task-with-curves',
        series: {
          loss: [
            { observedAt: '2026-10-18T20:00:00Z', step: 100, value: 1.2 },
            { observedAt: '2026-10-18T20:01:00Z', step: 200, value: 0.8 },
          ],
        },
      })
      .mockResolvedValueOnce({
        taskId: 'task-no-curves',
        series: {},
      });
    window.monitor = api;
    const desktop = createMockDesktop();
    window.desktop = desktop;

    const hostReg = { ...testRegistry.hosts[0]!, allowJobControl: true };
    const taskWithCurves: TaskSnapshot = { ...testFlowTask, taskId: 'task-with-curves' };
    const taskNoCurves: TaskSnapshot = { ...testFlowTask, taskId: 'task-no-curves' };

    const { container, rerender } = render(
      <I18nProvider locale="en-US">
        <TaskCockpit
          task={taskWithCurves}
          host={testHostConnected}
          taskRegistration={testRegistry.tasks[0]!}
          hostRegistration={hostReg}
          sources={[]}
          onOpenEvidence={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('.cockpit-right-card.is-wide-split')).not.toBeNull();
    });

    // Kill (SIGKILL) button visible and opens JobControlModal
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Terminal split dropdown menu calls copyCommand
    fireEvent.click(screen.getByRole('button', { name: 'Terminal quick commands' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy SSH command' }));
    await waitFor(() => {
      expect(desktop.copyCommand).toHaveBeenCalledWith({
        kind: 'ssh',
        hostId: taskWithCurves.hostId,
        taskId: taskWithCurves.taskId,
      });
    });

    // Switch to task without curves -> is-wide-split removed & tab resets to GPU/Process
    rerender(
      <I18nProvider locale="en-US">
        <TaskCockpit
          task={taskNoCurves}
          host={testHostConnected}
          taskRegistration={{ ...testRegistry.tasks[0]!, taskId: 'task-no-curves' }}
          hostRegistration={hostReg}
          sources={[]}
          onOpenEvidence={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('.cockpit-right-card.is-wide-split')).toBeNull();
    });
    const gpuTab = screen.getByRole('tab', { name: /GPU & Process/i });
    expect(gpuTab.getAttribute('aria-selected')).toBe('true');
    expect(gpuTab.getAttribute('aria-controls')).toBe('cockpit-panel-gpu');
    expect(document.getElementById('cockpit-panel-gpu')?.getAttribute('role')).toBe('tabpanel');
  });

  it('P1.3 & P2.3: GpuMonitor renders translated status inside I18nProvider, syncs document.title, and AutoStartFields/TaskEditor render zero Chinese in en-US with modules & allowCrossUidScan', async () => {
    const api = createControlledMockApi({ preferences: { theme: 'dark', locale: 'en-US' } });
    window.monitor = api;
    window.desktop = createMockDesktop();

    const { container } = render(<GpuMonitor />);
    await screen.findByText('Connected');
    expect(document.title).toBe('Live GPU Monitor');
    // Exclude the intentional '中' language switch button when checking zero CJK in en-US mode
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.header-lang-btn').forEach((el) => el.remove());
    expect(CJK_RE.test(clone.textContent ?? '')).toBe(false);

    // AutoStartFields in en-US + Environment Modules
    cleanup();
    const autoContext = {
      entryPaths: ['train.py'],
      allowedDirectories: ['/data2/cy/xzn/run'],
      logSources: [{ sourceId: 's1', path: '/data2/cy/xzn/run/train.log' }],
      defaultGpuText: '0',
      hasStatusSource: false,
    };
    const draft = createAutoStartDraft(null, autoContext);
    draft.enabled = true;
    draft.modulesText = 'cuda/12.1, nccl/2.18';
    const built = buildAutoStartPayload(draft, autoContext, 'en-US');
    expect(built.error).toBeNull();
    expect(built.payload?.launch.modules).toEqual(['cuda/12.1', 'nccl/2.18']);

    const { container: autoStartDom } = render(
      <I18nProvider locale="en-US">
        <AutoStartFields draft={draft} onChange={vi.fn()} context={autoContext} serverSupported />
      </I18nProvider>,
    );
    expect(screen.getByLabelText(/Environment Modules/i)).toBeDefined();
    expect(CJK_RE.test(autoStartDom.textContent ?? '')).toBe(false);

    // TaskEditor in en-US: allowCrossUidScan + allowedRoots warning
    cleanup();
    const saveTaskSpy = vi.fn().mockImplementation(async (reg: Registry) => reg);
    const { container: editorDom } = render(
      <I18nProvider locale="en-US">
        <TaskEditor
          registry={structuredClone(testRegistry)}
          task={null}
          onClose={vi.fn()}
          onSave={saveTaskSpy}
          onSaved={vi.fn()}
          onReload={vi.fn(async () => testRegistry)}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByLabelText('Task ID'), { target: { value: 'cross-uid-run' } });
    fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: '/outside/path' } });
    fireEvent.change(screen.getByLabelText('Script Entry'), { target: { value: 'train.py' } });
    fireEvent.change(screen.getByLabelText('Log Path'), { target: { value: '/outside/path/train.log' } });

    // Upfront allowedRoots warning in English
    expect(screen.getByRole('status').textContent).toMatch(/inside host allowed roots/i);
    expect(screen.getByRole('status').textContent).not.toContain('taskEditor.');
    const validated = parseAndValidateTaskForm(
      {
        taskId: 'cross-uid-run',
        hostId: 'lab-campus',
        label: 'Cross UID Run',
        algorithm: 'Custom',
        allowCrossUidScan: true,
        allowedDirsStr: '/outside/path',
        entryPathsStr: 'train.py',
        ckptDirsStr: '',
        logPath: '/outside/path/train.log',
      },
      testRegistry.hosts,
      testRegistry.tasks,
      null,
      'en-US',
    );
    expect(validated.error).toBeNull();
    expect(validated.warning).toMatch(/inside host allowed roots/i);
    expect(validated.task?.allowCrossUidScan).toBe(true);

    // Expand advanced options & check allowCrossUidScan
    fireEvent.click(screen.getByText(/Advanced Options/i));
    fireEvent.click(screen.getByLabelText(/Allow cross-UID/i));
    expect(CJK_RE.test(editorDom.textContent ?? '')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add Task' }));
    await waitFor(() => expect(saveTaskSpy).toHaveBeenCalledTimes(1));
    const created = (saveTaskSpy.mock.calls[0]![0] as Registry).tasks.find((t) => t.taskId === 'cross-uid-run');
    expect(created?.allowCrossUidScan).toBe(true);
  });

  it('P1.5: AutoStartPanel and EvidenceDrawer prefer Electron clipboard IPC and do not fake success on failure', async () => {
    const copyCommand = vi.fn().mockRejectedValueOnce(new Error('IPC_FAIL')).mockResolvedValueOnce('tmux attach');
    const copyDiagnosticText = vi.fn().mockRejectedValueOnce(new Error('CLIP_FAIL')).mockResolvedValueOnce(undefined);
    window.desktop = createMockDesktop({ copyCommand, copyDiagnosticText });

    render(
      <I18nProvider locale="en-US">
        <AutoStartPanel
          config={makeAutoStartConfig()}
          status={makeAutoStartStatus()}
          hostId="lab-campus"
          taskId="flow-cifar10"
          onConfigure={vi.fn()}
          onRearm={vi.fn()}
          onDisable={vi.fn()}
        />
      </I18nProvider>,
    );

    // First click fails both copyCommand & copyDiagnosticText -> stays "Copy command"
    const copyBtn = screen.getByRole('button', { name: 'Copy command' });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(copyDiagnosticText).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();

    // Second click succeeds via copyCommand -> becomes "Copied"
    fireEvent.click(copyBtn);
    await screen.findByRole('button', { name: 'Copied' });

    // EvidenceDrawer CopyChip uses copyDiagnosticText and does not fake success when failing
    cleanup();
    const drawerCopy = vi.fn().mockRejectedValueOnce(new Error('LOCKED')).mockResolvedValueOnce(undefined);
    window.desktop = createMockDesktop({ copyDiagnosticText: drawerCopy });
    render(
      <I18nProvider locale="en-US">
        <EvidenceDrawer isOpen onClose={vi.fn()} task={testFlowTask} sources={[testFlowSource]} />
      </I18nProvider>,
    );
    const copyChip = screen.getAllByRole('button', { name: 'Copy' })[0]!;
    fireEvent.click(copyChip);
    await waitFor(() => expect(drawerCopy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();

    fireEvent.click(copyChip);
    await screen.findByRole('button', { name: 'Copied' });
  });

  it('P1.7 & P2.3: cross-host onFocusTask switches host + task atomically, clearAlerts syncs tray, and disabled host opens Hosts settings tab', async () => {
    let focusHandler: ((taskId: string, hostId?: string) => void) | null = null;
    const clearAlerts = vi.fn().mockResolvedValue(undefined);
    window.desktop = createMockDesktop({
      clearAlerts,
      onFocusTask: vi.fn((cb) => {
        focusHandler = cb;
        return () => {
          focusHandler = null;
        };
      }),
    });

    const secondTask: TaskSnapshot = {
      ...testFlowTask,
      taskId: 'wsl-diffusion',
      hostId: 'wsl-ubuntu',
    };
    const multiHostSnapshot: MonitorSnapshot = {
      version: 1,
      demo: false,
      hosts: [testHostConnected, { ...testHostWslUnobserved, connection: 'connected', freshness: 'fresh' }],
      tasks: [testFlowTask, secondTask],
      sources: [testFlowSource],
    };
    const multiHostRegistry: Registry = {
      ...structuredClone(testRegistry),
      hosts: [
        { ...testRegistry.hosts[0]!, enabled: false },
        { ...testRegistry.hosts[1]!, enabled: true },
      ],
      tasks: [
        testRegistry.tasks[0]!,
        {
          ...testRegistry.tasks[0]!,
          taskId: 'wsl-diffusion',
          hostId: 'wsl-ubuntu',
          label: 'WSL Diffusion Run',
        },
      ],
    };
    const api = createControlledMockApi({
      snapshot: multiHostSnapshot,
      registry: multiHostRegistry,
      preferences: { theme: 'dark', locale: 'en-US' },
    });
    window.monitor = api;

    render(<App />);
    await screen.findByRole('heading', { name: 'Flow Matching (CIFAR-10)' });

    // Disabled host header button opens SettingsModal straight to Hosts tab
    fireEvent.click(screen.getByRole('button', { name: /lab-campus connection diagnostics/i }));
    const diagPopover = screen.getByRole('region', { name: /lab-campus connection diagnostics/i });
    fireEvent.click(within(diagPopover).getByRole('button', { name: 'Enable in Settings' }));
    const settingsDialog = screen.getByRole('dialog', { name: 'System settings' });
    const hostsTab = await within(settingsDialog).findByRole('tab', { name: 'Hosts' });
    expect(hostsTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(settingsDialog).getAllByRole('button', { name: 'Close' })[0]!);

    // Cross-host alert focus switches hostId + taskId atomically
    expect(focusHandler).not.toBeNull();
    act(() => {
      focusHandler!('wsl-diffusion', 'wsl-ubuntu');
    });
    await screen.findByRole('heading', { name: 'WSL Diffusion Run' });

    // Opening alerts popover calls window.desktop.clearAlerts()
    fireEvent.click(screen.getByRole('button', { name: 'Alert notifications' }));
    await waitFor(() => expect(clearAlerts).toHaveBeenCalled());
  });

  it('P2.4: TaskFleetTree has no nested role="treeitem" and Sparkline anchors areaPath to valid non-null x range', () => {
    const { container: treeContainer } = render(
      <I18nProvider locale="en-US">
        <TaskFleetTree
          hosts={[testHostConnected]}
          hostRegistrations={testRegistry.hosts}
          tasks={[testFlowTask]}
          registrations={testRegistry.tasks}
          activeHostId="lab-campus"
          activeTaskId="flow-cifar10"
          onSelectHost={vi.fn()}
          onSelectTask={vi.fn()}
        />
      </I18nProvider>,
    );

    const treeItems = Array.from(treeContainer.querySelectorAll('[role="treeitem"]'));
    expect(treeItems.length).toBeGreaterThan(0);
    for (const item of treeItems) {
      expect(item.querySelector('[role="treeitem"]')).toBeNull();
    }

    const points: GpuSeriesPoint[] = [
      { observedAt: '2026-10-18T20:00:00Z', deviceId: 'GPU 0', utilPct: null, memUsedMiB: null, memTotalMiB: 81920, tempC: null, powerW: null },
      { observedAt: '2026-10-18T20:01:00Z', deviceId: 'GPU 0', utilPct: 40, memUsedMiB: 40960, memTotalMiB: 81920, tempC: 50, powerW: 200 },
      { observedAt: '2026-10-18T20:02:00Z', deviceId: 'GPU 0', utilPct: 80, memUsedMiB: 60000, memTotalMiB: 81920, tempC: 65, powerW: 300 },
      { observedAt: '2026-10-18T20:03:00Z', deviceId: 'GPU 0', utilPct: null, memUsedMiB: null, memTotalMiB: 81920, tempC: null, powerW: null },
    ];
    const { container: sparkContainer } = render(<Sparkline points={points} ariaLabel="GPU 0 sparkline" />);
    const paths = Array.from(sparkContainer.querySelectorAll('path'));
    const areaD = paths[0]?.getAttribute('d') ?? '';
    expect(areaD).toContain('L133.3,25.0 L66.7,25.0 Z');
    expect(areaD).not.toContain('L200,');
    expect(areaD).not.toContain('L0,');
  });
});
