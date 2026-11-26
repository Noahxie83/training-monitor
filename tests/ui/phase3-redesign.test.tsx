// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../../src/renderer/App';
import { DualProgressBar } from '../../src/renderer/components/DualProgressBar';
import { TrainingChart } from '../../src/renderer/components/TrainingChart';
import { HostOverview } from '../../src/renderer/components/HostOverview';
import { LogConsole } from '../../src/renderer/components/LogConsole';
import { SettingsModal } from '../../src/renderer/components/SettingsModal';
import { TaskEditor } from '../../src/renderer/components/TaskEditor';
import { ProcessDiscoveryModal } from '../../src/renderer/components/ProcessDiscoveryModal';
import { JobControlModal } from '../../src/renderer/components/JobControlModal';
import { buildAutoStartPayload, createAutoStartDraft } from '../../src/renderer/components/AutoStartFields';
import { I18nProvider } from '../../src/renderer/i18n';
import { classifyLogLevel, parseAnsiSegments } from '../../src/renderer/utils/ansi';
import { createControlledMockApi, testFlowSource, testFlowTask, testHostConnected, testRegistry } from './fixtures';
import type { GpuDeviceDetail, GpuSeriesPoint, LogEvent, MetricSeriesPoint, TaskSnapshot } from '../../src/shared/contracts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function wrap(ui: React.ReactNode, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  return <I18nProvider locale={locale}>{ui}</I18nProvider>;
}

describe('Phase 3 Redesign: Design System, Visualizations, ANSI Console & Bilingual UI', () => {
  it('enforces modular CSS with zero !important rules, local WOFF2 fonts, and semantic tokens', () => {
    const stylesDir = path.resolve('src/renderer/styles');
    const files = fs.readdirSync(stylesDir).filter((f) => f.endsWith('.css'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    const allCss = [
      fs.readFileSync(path.resolve('src/renderer/style.css'), 'utf8'),
      ...files.map((f) => fs.readFileSync(path.join(stylesDir, f), 'utf8')),
    ].join('\n');
    const strippedCss = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(strippedCss).not.toMatch(/!important/);
    expect(strippedCss).toContain("font-family: 'Inter'");
    expect(strippedCss).toContain("font-family: 'JetBrains Mono'");
    expect(strippedCss).toContain('--accent-ink:');
    expect(strippedCss).toContain('--load-idle:');
    expect(strippedCss).toContain('--load-active:');
    expect(strippedCss).toContain('--load-high:');
    expect(strippedCss).toContain('--load-critical:');

    const fontsDir = path.resolve('src/renderer/assets/fonts');
    const woff2Files = fs.readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'));
    expect(woff2Files.length).toBeGreaterThanOrEqual(7);
  });

  it('parses ANSI 16/256/TrueColor SGR safely without HTML injection and classifies log levels', () => {
    const segs = parseAnsiSegments('\x1B[1;38;2;239;68;68mERROR\x1B[0m <script>alert(1)</script> \x1B[38;5;46mOK\x1B[0m');
    expect(segs[0]).toMatchObject({ text: 'ERROR', bold: true, fg: 'rgb(239, 68, 68)' });
    expect(segs[1]?.text).toContain('<script>alert(1)</script>');
    expect(segs[2]).toMatchObject({ text: 'OK', fg: '#00ff00' });

    expect(classifyLogLevel('RuntimeError: CUDA out of memory')).toBe('error');
    expect(classifyLogLevel('WARNING: gradient norm spike detected')).toBe('warn');
    expect(classifyLogLevel('step=100 loss=0.412 lr=1e-4')).toBe('info');
  });

  it('supports ANSI rendering, level filter pills, regex/case <mark> search, match nav, clear and export in LogConsole', async () => {
    const exportLogs = vi.fn().mockResolvedValue({ exportedCount: 3, path: '/tmp/out.log' });
    const api = createControlledMockApi();
    api.exportLogs = exportLogs;
    window.monitor = api;

    const events: LogEvent[] = [
      {
        version: 1,
        eventId: 'e1',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'gen-1',
        kind: 'line',
        startOffset: '0',
        endOffset: '40',
        ingestedAt: '2026-10-18T20:30:00Z',
        text: 'INFO step=10 loss=0.420',
        rawAnsi: '\x1B[32mINFO\x1B[0m step=10 loss=0.420',
        reason: null,
        displayTruncated: false,
        recordComplete: true,
        prefixIncomplete: false,
        runId: null,
        bindingId: null,
      },
      {
        version: 1,
        eventId: 'e2',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'gen-1',
        kind: 'line',
        startOffset: '40',
        endOffset: '90',
        ingestedAt: '2026-10-18T20:30:01Z',
        text: 'WARNING gradient clipping activated Loss=0.91',
        reason: null,
        displayTruncated: false,
        recordComplete: true,
        prefixIncomplete: false,
        runId: null,
        bindingId: null,
      },
      {
        version: 1,
        eventId: 'e3',
        taskId: 'flow-cifar10',
        sourceId: 'flow-log',
        generation: 'gen-1',
        kind: 'line',
        startOffset: '90',
        endOffset: '140',
        ingestedAt: '2026-10-18T20:30:02Z',
        text: 'ERROR RuntimeError: CUDA out of memory',
        reason: null,
        displayTruncated: false,
        recordComplete: true,
        prefixIncomplete: false,
        runId: null,
        bindingId: null,
      },
    ];

    function Harness() {
      const [q, setQ] = React.useState('');
      const [mode, setMode] = React.useState<'literal' | 'regex'>('literal');
      const [cs, setCs] = React.useState(false);
      const [lv, setLv] = React.useState<'all' | 'error' | 'warn' | 'info'>('all');
      return wrap(
        <LogConsole
          sources={[testFlowSource]}
          sourcePathById={{ 'flow-log': '/workspace/train.log' }}
          activeSource={testFlowSource}
          activeSourceId="flow-log"
          onSelectSource={vi.fn()}
          events={events}
          totalBufferedCount={events.length}
          totalBufferedBytes={200}
          isScrollLocked={false}
          setIsScrollLocked={vi.fn()}
          unreadCount={0}
          onResumeAutoScroll={vi.fn()}
          onToggleScrollLock={vi.fn()}
          searchQuery={q}
          searchMode={mode}
          searchCaseSensitive={cs}
          levelFilter={lv}
          onSearchChange={setQ}
          onSearchModeChange={setMode}
          onSearchCaseSensitiveChange={setCs}
          onLevelFilterChange={setLv}
          isSearching={false}
          isWrapLines={true}
          onToggleWrapLines={vi.fn()}
          onRefresh={vi.fn()}
        />,
      );
    }

    const { container } = render(<Harness />);
    expect(screen.getByText(/CUDA out of memory/)).toBeDefined();

    // Level filter: ERR only
    fireEvent.click(screen.getByRole('button', { name: 'ERR' }));
    expect(screen.getByText(/CUDA out of memory/)).toBeDefined();
    expect(screen.queryByText(/step=10/)).toBeNull();

    // Reset to ALL and search with <mark> highlight & regex mode
    fireEvent.click(screen.getByRole('button', { name: 'ALL' }));
    const searchInput = screen.getByPlaceholderText(/搜索日志/);
    fireEvent.click(screen.getByRole('button', { name: '.*' }));
    fireEvent.change(searchInput, { target: { value: 'loss=[0-9.]+' } });

    await waitFor(() => {
      const marks = container.querySelectorAll('mark.log-mark');
      expect(marks.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('1 / 2')).toBeDefined();
    });

    // Navigate to next match
    fireEvent.click(screen.getByRole('button', { name: '下一处匹配' }));
    expect(screen.getByText('2 / 2')).toBeDefined();

    // Case-sensitive toggle narrows to lowercase loss= only
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeDefined());

    // Export logs invokes monitor.exportLogs
    fireEvent.click(screen.getByRole('button', { name: '导出当前日志' }));
    await waitFor(() => expect(exportLogs).toHaveBeenCalledTimes(1));

    // Clear view & restore view
    fireEvent.click(screen.getByRole('button', { name: '清空当前视图显示' }));
    expect(screen.getByText(/视图已清空/)).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: '恢复视图' })[0]!);
    expect(screen.getByText(/CUDA out of memory/)).toBeDefined();
  });

  it('switches bilingual UI live between zh-CN and en-US without legacy jargon', async () => {
    const api = createControlledMockApi({ preferences: { theme: 'light', locale: 'zh-CN' } });
    const savePrefs = vi.spyOn(api, 'savePreferences');
    window.monitor = api;

    render(<App />);
    await screen.findByRole('heading', { name: '训练监控器' });
    expect(screen.queryByText(/白名单证据/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
    await screen.findByRole('heading', { name: 'Training Monitor' });
    expect(savePrefs).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en-US' }));
    expect(screen.getByRole('button', { name: 'System settings' })).toBeDefined();
  });

  it('renders single progress track when no resume offset exists and dual tracks when resumed', () => {
    const freshTask: TaskSnapshot = {
      ...structuredClone(testFlowTask),
      progress: {
        ...structuredClone(testFlowTask.progress),
        resumeCheckpointIndex: null,
        baselineEvidenceId: null,
        resumedSession: null,
        session: { ...structuredClone(testFlowTask.progress.global) },
      },
    };
    const { rerender } = render(wrap(<DualProgressBar task={freshTask} />));
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);

    rerender(wrap(<DualProgressBar task={testFlowTask} />));
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('renders interactive TrainingChart from getMetricSeries with metric chips and EMA smoothing', async () => {
    const lossPts: MetricSeriesPoint[] = Array.from({ length: 12 }, (_, i) => ({
      step: (i + 1) * 100,
      observedAt: `2026-10-18T20:${String(i).padStart(2, '0')}:00Z`,
      value: Number((1.2 - i * 0.08).toFixed(3)),
    }));
    const lrPts: MetricSeriesPoint[] = lossPts.map((p) => ({ ...p, value: 1e-4 }));
    const api = createControlledMockApi();
    api.getMetricSeries = vi.fn().mockResolvedValue({
      taskId: 'flow-cifar10',
      series: { loss: lossPts, lr: lrPts },
    });
    window.monitor = api;

    const onHasData = vi.fn();
    const { container } = render(wrap(<TrainingChart taskId="flow-cifar10" onHasDataChange={onHasData} />));
    await waitFor(() => expect(onHasData).toHaveBeenCalledWith(true));
    expect(container.querySelector('.chart-line')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'LR' }));
    expect(screen.getByRole('button', { name: 'LR' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '平滑' }));
    expect(screen.getByRole('button', { name: '平滑' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('renders FleetSummaryStrip, 4-tier GPU load cards, memory meters, sparklines, and linked process jumps on HostOverview', async () => {
    const devices: GpuDeviceDetail[] = [
      {
        deviceId: 'GPU 0',
        index: 0,
        uuid: 'GPU-uuid-0',
        name: 'NVIDIA A100-SXM4-80GB',
        utilizationPct: 3,
        memoryUsedMiB: 512,
        memoryTotalMiB: 81920,
        temperatureC: 34,
        powerDrawW: 52,
        powerLimitW: 400,
        activeProcesses: [],
      },
      {
        deviceId: 'GPU 1',
        index: 1,
        uuid: 'GPU-uuid-1',
        name: 'NVIDIA A100-SXM4-80GB',
        utilizationPct: 96,
        memoryUsedMiB: 72000,
        memoryTotalMiB: 81920,
        temperatureC: 76,
        powerDrawW: 368,
        powerLimitW: 400,
        activeProcesses: [{ pid: 594319, command: 'python3 train.py', memoryMiB: 71680 }],
      },
    ];
    const gpuSeries: GpuSeriesPoint[] = [
      { observedAt: '2026-10-18T20:20:00Z', deviceId: 'GPU 0', utilPct: 2, memUsedMiB: 512, memTotalMiB: 81920, tempC: 33, powerW: 50 },
      { observedAt: '2026-10-18T20:30:00Z', deviceId: 'GPU 0', utilPct: 3, memUsedMiB: 512, memTotalMiB: 81920, tempC: 34, powerW: 52 },
      { observedAt: '2026-10-18T20:20:00Z', deviceId: 'GPU 1', utilPct: 92, memUsedMiB: 70000, memTotalMiB: 81920, tempC: 74, powerW: 360 },
      { observedAt: '2026-10-18T20:30:00Z', deviceId: 'GPU 1', utilPct: 96, memUsedMiB: 72000, memTotalMiB: 81920, tempC: 76, powerW: 368 },
    ];
    const api = createControlledMockApi();
    api.getGpuSeries = vi.fn().mockResolvedValue({ hostId: 'lab-campus', gpu: gpuSeries, host: [] });
    window.monitor = api;

    const onSelectTask = vi.fn();
    const { container } = render(
      wrap(
        <HostOverview
          host={{
            ...testHostConnected,
            system: {
              observedAt: '2026-10-18T20:31:05Z',
              freshness: 'fresh',
              cpuUtilizationPct: 42,
              memoryUsedBytes: String(64 * 1024 ** 3),
              memoryTotalBytes: String(256 * 1024 ** 3),
              disks: [
                {
                  path: '/data',
                  usedBytes: String(800 * 1024 ** 3),
                  availableBytes: String(1200 * 1024 ** 3),
                  totalBytes: String(2000 * 1024 ** 3),
                },
              ],
            },
            gpu: {
              observedAt: '2026-10-18T20:31:05Z',
              state: 'available',
              errorCode: null,
              metrics: [],
              devices,
            },
          }}
          taskCount={1}
          hostTasks={[testFlowTask]}
          taskRegistrations={testRegistry.tasks}
          onSelectTask={onSelectTask}
        />,
      ),
    );

    expect(container.querySelector('.fleet-summary-strip')).not.toBeNull();
    expect(container.querySelectorAll('.gpu-memory-meter')).toHaveLength(2);
    expect(container.querySelector('.gpu-device-card.load-tier-idle')).not.toBeNull();
    expect(container.querySelector('.gpu-device-card.load-tier-critical')).not.toBeNull();
    await waitFor(() => expect(container.querySelectorAll('.gpu-sparkline-svg')).toHaveLength(2));

    // Filter idle-only shows only GPU 0
    fireEvent.click(screen.getByRole('button', { name: /仅看空闲/ }));
    expect(screen.getByText('GPU 0')).toBeDefined();
    expect(screen.queryByText('GPU 1')).toBeNull();

    // Back to all and click linked PID tag -> jumps to task
    fireEvent.click(screen.getByRole('button', { name: /全部/ }));
    fireEvent.click(screen.getByRole('button', { name: /PID 594319/ }));
    expect(onSelectTask).toHaveBeenCalledWith('flow-cifar10');
  });

  it('requires secondary confirmation to delete a host with tasks and tests webhooks in SettingsModal', async () => {
    const testWebhook = vi.fn().mockResolvedValue({ ok: true, statusCode: 200, error: null });
    const api = createControlledMockApi();
    api.testWebhook = testWebhook;
    window.monitor = api;

    const saveRegistry = vi.fn(async (reg) => reg);
    const savePrefs = vi.fn(async (p) => p);

    render(
      wrap(
        <SettingsModal
          isOpen={true}
          onClose={vi.fn()}
          preferences={{ theme: 'light' }}
          onUpdatePreferences={savePrefs}
          registry={structuredClone(testRegistry)}
          onUpdateRegistry={saveRegistry}
        />,
      ),
    );

    // Hosts tab -> deleting lab-campus (3 tasks) requires explicit secondary confirmation
    fireEvent.click(screen.getByRole('tab', { name: '宿主管理' }));
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    fireEvent.click(deleteButtons[0]!);
    const confirmBox = screen.getByRole('alertdialog', { name: '确认删除宿主？' });
    expect(confirmBox.textContent).toContain('3 个监控任务');
    fireEvent.click(within(confirmBox).getByRole('button', { name: '确认删除宿主与任务' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Alerts tab -> add webhook and test send
    fireEvent.click(screen.getByRole('tab', { name: '告警与通知' }));
    fireEvent.click(screen.getByRole('button', { name: '+ 添加 Webhook' }));
    fireEvent.change(screen.getByLabelText('Webhook URL 1'), {
      target: { value: 'https://hooks.example.com/notify' },
    });
    fireEvent.click(screen.getByRole('button', { name: '测试发送' }));
    await waitFor(() => expect(testWebhook).toHaveBeenCalledTimes(1));
    await screen.findByText(/发送成功 \(HTTP 200\)/);
  });

  it('auto-slugs TaskEditor taskId, shows inline path validation, imports discovered processes, builds 3-mode AutoStart, and confirms JobControl', async () => {
    const discoverProcesses = vi.fn().mockResolvedValue([
      {
        pid: 8812,
        pgid: 8812,
        command: 'python3 train_sft.py --epochs 3',
        cwd: '/workspace/llm',
        gpuIndices: [0, 1],
        gpuMemoryMiB: 24576,
        openLogPaths: ['/workspace/llm/train.log'],
        suggestedName: 'LLM SFT Run',
        suggestedEntry: 'train_sft.py',
      },
    ]);
    const controlTask = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 'flow-cifar10',
      action: 'stop',
      pidsSignaled: [8812],
      errorCode: null,
    });
    const api = createControlledMockApi();
    api.discoverProcesses = discoverProcesses;
    api.controlTask = controlTask;
    window.monitor = api;

    // 1. Process discovery import
    const onImport = vi.fn();
    render(wrap(<ProcessDiscoveryModal hostId="lab-campus" onClose={vi.fn()} onImport={onImport} />));
    await screen.findByText('LLM SFT Run');
    fireEvent.click(screen.getByRole('button', { name: '导入为任务' }));
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ pid: 8812, suggestedName: 'LLM SFT Run' }));
    cleanup();

    // 2. TaskEditor auto-slug & inline validation
    render(
      wrap(
        <TaskEditor
          registry={structuredClone(testRegistry)}
          task={null}
          onClose={vi.fn()}
          onSave={vi.fn(async (r) => r)}
          onSaved={vi.fn()}
          onReload={vi.fn(async () => structuredClone(testRegistry))}
          onOpenSettings={vi.fn()}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: 'Llama 3 SFT' } });
    expect((screen.getByLabelText('任务 ID') as HTMLInputElement).value).toBe('llama-3-sft');
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: 'relative/path' } });
    expect(screen.getByText(/工作目录需以 \/ 开头/)).toBeDefined();
    cleanup();

    // 3. AutoStartFields command mode + env KV + free_mem payload
    const draft = createAutoStartDraft(null, {
      entryPaths: ['train.py'],
      allowedDirectories: ['/workspace/llm'],
      logSources: [{ sourceId: 'log-1', path: '/workspace/llm/train.log' }],
    });
    const { payload, error } = buildAutoStartPayload(
      {
        ...draft,
        enabled: true,
        thresholdMode: 'free_mem',
        minFreeMemoryMiB: '16000',
        launchMode: 'command',
        commandText: 'torchrun --nproc_per_node=2 train.py',
        condaEnv: 'pt2',
        envPairs: [{ key: 'OMP_NUM_THREADS', value: '8' }],
      },
      {
        entryPaths: ['train.py'],
        allowedDirectories: ['/workspace/llm'],
        logSources: [{ sourceId: 'log-1', path: '/workspace/llm/train.log' }],
      },
    );
    expect(error).toBeNull();
    expect(payload).toMatchObject({
      minFreeMemoryMiB: 16000,
      launch: {
        mode: 'command',
        command: ['torchrun', '--nproc_per_node=2', 'train.py'],
        condaEnv: 'pt2',
        env: { OMP_NUM_THREADS: '8' },
      },
    });

    // 4. JobControlModal confirmation
    const onCompleted = vi.fn();
    render(
      wrap(
        <JobControlModal
          taskId="flow-cifar10"
          taskLabel="Flow Matching"
          action="stop"
          pids={[594319]}
          onClose={vi.fn()}
          onCompleted={onCompleted}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }));
    await waitFor(() =>
      expect(controlTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'flow-cifar10', action: 'stop' })),
    );
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
});
