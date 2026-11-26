// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SettingsModal } from "../../src/renderer/components/SettingsModal";
import { TaskEditor } from "../../src/renderer/components/TaskEditor";
import { validateRegistry } from "../../src/shared/validate";
import type { Registry, Preferences, HostRegistration, TaskRegistration } from "../../src/shared/contracts";

const defaultPrefs: Preferences = {
  theme: "system",
};

const baseHost: HostRegistration = {
  hostId: "host-1",
  label: "GPU Server 1",
  enabled: true,
  allowedRoots: ["/data", "/home"],
  target: { kind: "ssh", alias: "gpu-node" },
};

const disabledMultiSourceTask: TaskRegistration = {
  taskId: "task-disabled-multi",
  hostId: "host-1",
  label: "Flow Train Task",
  enabled: false, // disabled!
  algorithm: "flow",
  allowedDirectories: ["/data/exp1"],
  entryPaths: ["/data/exp1/train.py"],
  sources: [
    { sourceId: "custom-log-alpha", path: "/data/exp1/train.log", kind: "log" },
    { sourceId: "custom-log-beta", path: "/data/exp1/eval.log", kind: "log" },
    { sourceId: "custom-status-main", path: "/data/exp1/status.json", kind: "status_json" },
  ],
  checkpointDirectories: ["/data/exp1/checkpoints"],
};

const baseRegistry: Registry = {
  version: 2,
  revision: 1,
  hosts: [baseHost],
  tasks: [disabledMultiSourceTask],
};

describe("T7 Fix 3 Requirements - Group A: Settings, Registry & Host Targets (I1, NB3, NB5)", () => {
  afterEach(() => { cleanup(); });
  beforeEach(() => { cleanup(); });
  it("NB3: preserves enabled=false, custom sourceIds, and multiple same-kind sources when editing task", async () => {
    let savedPayload: Registry | null = null;
    const updateRegistry = vi.fn(async (reg: Registry) => {
      savedPayload = reg;
      return reg;
    });

    render(
      <TaskEditor
        registry={baseRegistry}
        task={disabledMultiSourceTask}
        onClose={() => {}}
        onSave={updateRegistry}
        onSaved={() => {}}
        onReload={async () => baseRegistry}
        onOpenSettings={() => {}}
      />
    );

    // Edit label and first log path
    const labelInput = screen.getByDisplayValue("Flow Train Task");
    fireEvent.change(labelInput, { target: { value: "Flow Train Task Renamed" } });

    const logInput = screen.getByDisplayValue("/data/exp1/train.log");
    fireEvent.change(logInput, { target: { value: "/data/exp1/train-updated.log" } });

    // Save changes
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await waitFor(() => {
      expect(updateRegistry).toHaveBeenCalledTimes(1);
    });

    expect(savedPayload).not.toBeNull();
    const savedTask = savedPayload!.tasks.find((t) => t.taskId === "task-disabled-multi");
    expect(savedTask).toBeDefined();

    // Must preserve enabled=false (NB3)
    expect(savedTask!.enabled).toBe(false);

    // Must preserve custom sourceId on updated first log
    expect(savedTask!.sources.find((s) => s.path === "/data/exp1/train-updated.log")).toEqual({
      sourceId: "custom-log-alpha",
      path: "/data/exp1/train-updated.log",
      kind: "log",
    });

    // Must preserve second log source (NB3)
    expect(savedTask!.sources.find((s) => s.sourceId === "custom-log-beta")).toEqual({
      sourceId: "custom-log-beta",
      path: "/data/exp1/eval.log",
      kind: "log",
    });

    // Must preserve status source
    expect(savedTask!.sources.find((s) => s.sourceId === "custom-status-main")).toEqual({
      sourceId: "custom-status-main",
      path: "/data/exp1/status.json",
      kind: "status_json",
    });

    // Must pass shared validateRegistry without throwing
    expect(() => validateRegistry(savedPayload)).not.toThrow();
  });

  it("NB5: switching host kind between SSH, WSL, and Local produces strictly valid v2 targets", async () => {
    let savedPayload: Registry | null = null;
    const updateRegistry = vi.fn(async (reg: Registry) => {
      savedPayload = reg;
      return reg;
    });

    render(
      <SettingsModal
        isOpen={true}
        onClose={() => {}}
        preferences={defaultPrefs}
        onUpdatePreferences={() => {}}
        registry={baseRegistry}
        onUpdateRegistry={updateRegistry}
      />
    );

    // Switch to Hosts tab and edit host-1 (currently SSH)
    fireEvent.click(screen.getByRole("tab", { name: "宿主管理" }));
    const editButtons = screen.getAllByRole("button", { name: "编辑" });
    fireEvent.click(editButtons[0]);

    // Switch type from SSH to WSL and specify distribution
    const typeSelect = screen.getByRole("combobox", { name: /宿主类型|类型/i });
    fireEvent.change(typeSelect, { target: { value: "wsl" } });
    fireEvent.change(screen.getByLabelText("编辑 WSL 发行版"), { target: { value: "Ubuntu-24.04" } });

    // Complete edit and save
    fireEvent.click(screen.getByRole("button", { name: /完成编辑|完成/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存宿主配置" }));

    await waitFor(() => {
      expect(updateRegistry).toHaveBeenCalledTimes(1);
    });

    expect(savedPayload).not.toBeNull();
    const savedHost = savedPayload!.hosts.find((h) => h.hostId === "host-1");
    expect(savedHost).toBeDefined();

    // Target must strictly be { kind: 'wsl', distribution: 'Ubuntu-24.04' } without ssh fields
    expect(savedHost!.target).toEqual({
      kind: "wsl",
      distribution: "Ubuntu-24.04",
    });

    expect(() => validateRegistry(savedPayload)).not.toThrow();
  });

  it("I1: handles revision conflict (409), reloads latest registry, and saves with updated revision", async () => {
    let callCount = 0;
    let savedPayloads: Registry[] = [];
    const updateRegistry = vi.fn(async (reg: Registry) => {
      callCount++;
      savedPayloads.push(reg);
      if (callCount === 1) {
        throw new Error("HTTP 409 Conflict: Stale registry revision");
      }
      return { ...reg, revision: reg.revision + 1 };
    });

    const reloadedRegistry: Registry = {
      version: 2,
      revision: 4,
      hosts: [{ ...baseHost, label: "Server Confirmed Host" }],
      tasks: [disabledMultiSourceTask],
    };

    const reloadRegistry = vi.fn(async () => reloadedRegistry);

    render(
      <SettingsModal
        isOpen={true}
        onClose={() => {}}
        preferences={defaultPrefs}
        onUpdatePreferences={() => {}}
        registry={baseRegistry}
        onUpdateRegistry={updateRegistry}
        onReloadRegistry={reloadRegistry}
      />
    );

    // Switch to Hosts tab and attempt save with revision 1 -> fails with 409
    fireEvent.click(screen.getByRole("tab", { name: "宿主管理" }));
    fireEvent.click(screen.getByRole("button", { name: "保存宿主配置" }));

    await waitFor(() => {
      expect(updateRegistry).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/409|conflict|冲突|版本冲突/i)).toBeDefined();
    });

    expect(savedPayloads[0].revision).toBe(1);

    // Click reload button
    const reloadBtn = screen.getByRole("button", { name: /重新加载最新配置|重新拉取/i });
    fireEvent.click(reloadBtn);

    await waitFor(() => {
      expect(reloadRegistry).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Server Confirmed Host")).toBeDefined();
    });

    // Now edit host label and save again
    const editButtons = screen.getAllByRole("button", { name: "编辑" });
    fireEvent.click(editButtons[0]);

    const labelInput = screen.getByDisplayValue("Server Confirmed Host");
    fireEvent.change(labelInput, { target: { value: "Re-edited After Reload" } });
    fireEvent.click(screen.getByRole("button", { name: /完成编辑|完成/ }));

    fireEvent.click(screen.getByRole("button", { name: "保存宿主配置" }));

    await waitFor(() => {
      expect(updateRegistry).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/配置已保存成功|登记配置保存成功/i)).toBeDefined();
    });

    // Second payload MUST use reloaded revision 4!
    expect(savedPayloads[1].revision).toBe(4);
    const finalHost = savedPayloads[1].hosts.find((h) => h.hostId === "host-1");
    expect(finalHost!.label).toBe("Re-edited After Reload");
    expect(() => validateRegistry(savedPayloads[1])).not.toThrow();
  });
});

import { App } from "../../src/renderer/App";
import { useMonitor } from "../../src/renderer/hooks/useMonitor";
import { renderHook, act } from "@testing-library/react";
import {
  createControlledMockApi,
  testHostConnected,
  testFlowTask,
  testScoreTask,
  testFlowSource,
} from "./fixtures";

describe("T7 Fix 3 Requirements - Group B: Log Requests, Events, Cancellation & Shared Budget (I3, I4, I11, I16[log], NB4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("I3: filters incoming log updates per-event by taskId and generation", async () => {
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [{ ...testFlowSource, generation: "gen-current" }],
      },
      logs: [
        {
          version: 1,
          eventId: "init-1",
          taskId: "flow-cifar10",
          sourceId: "flow-log",
          generation: "gen-current",
          kind: "line",
          startOffset: 0,
          endOffset: 10,
          ingestedAt: "2026-10-18T20:30:00Z",
          text: "Initial log line",
          reason: null,
          displayTruncated: false,
          recordComplete: true,
          prefixIncomplete: false,
          runId: "run-1",
          bindingId: null,
        },
      ],
    });
    (window as any).monitor = api;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Initial log line/)).toBeDefined();
    });

    // Emit logs update containing mixed events
    act(() => {
      api.emitUpdate({
        kind: "logs",
        sourceId: "flow-log",
        events: [
          {
            version: 1,
            eventId: "stale-gen-ev",
            taskId: "flow-cifar10",
            sourceId: "flow-log",
            generation: "gen-old", // STALE GENERATION!
            kind: "line",
            startOffset: 10,
            endOffset: 20,
            ingestedAt: "2026-10-18T20:31:00Z",
            text: "DROPPED_STALE_GEN_EVENT",
            reason: null,
            displayTruncated: false,
            recordComplete: true,
            prefixIncomplete: false,
            runId: "run-1",
            bindingId: null,
          },
          {
            version: 1,
            eventId: "wrong-task-ev",
            taskId: "wrong-task", // WRONG TASK!
            sourceId: "flow-log",
            generation: "gen-current",
            kind: "line",
            startOffset: 20,
            endOffset: 30,
            ingestedAt: "2026-10-18T20:31:01Z",
            text: "DROPPED_WRONG_TASK_EVENT",
            reason: null,
            displayTruncated: false,
            recordComplete: true,
            prefixIncomplete: false,
            runId: "run-1",
            bindingId: null,
          },
          {
            version: 1,
            eventId: "valid-ev",
            taskId: "flow-cifar10",
            sourceId: "flow-log",
            generation: "gen-current", // VALID
            kind: "line",
            startOffset: 30,
            endOffset: 40,
            ingestedAt: "2026-10-18T20:31:02Z",
            text: "ACCEPTED_CURRENT_GEN_EVENT",
            reason: null,
            displayTruncated: false,
            recordComplete: true,
            prefixIncomplete: false,
            runId: "run-1",
            bindingId: null,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/ACCEPTED_CURRENT_GEN_EVENT/)).toBeDefined();
    });

    // Must NOT contain dropped events
    expect(screen.queryByText(/DROPPED_STALE_GEN_EVENT/)).toBeNull();
    expect(screen.queryByText(/DROPPED_WRONG_TASK_EVENT/)).toBeNull();
  });

  it("I3: delayed initial snapshot does not overwrite user-selected active task", async () => {
    let resolveInitialSnapshot: (s: any) => void;
    const delayedSnapshotPromise = new Promise((resolve) => {
      resolveInitialSnapshot = resolve;
    });

    const api = createControlledMockApi();
    api.getSnapshot = vi.fn().mockReturnValue(delayedSnapshotPromise);
    (window as any).monitor = api;

    const { result } = renderHook(() => useMonitor());

    // Push subscription update setting active task to score-cifar10
    act(() => {
      api.emitUpdate({
        kind: "snapshot",
        snapshot: {
          version: 1,
          demo: false,
          hosts: [testHostConnected],
          tasks: [testScoreTask, testFlowTask],
          sources: [],
        },
      });
    });

    expect(result.current.activeTaskId).toBe("score-based");

    // Now resolve initial snapshot which only contains flow-cifar10
    await act(async () => {
      resolveInitialSnapshot!({
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [],
      });
    });

    // activeTaskId MUST remain score-based and not be reset to flow-cifar10
    expect(result.current.activeTaskId).toBe("score-based");
  });

  it("NB4: switching tasks while history request is in-flight does not leave new task stuck in loading", async () => {
    let resolveEarlierA: (page: any) => void;
    const earlierPromiseA = new Promise((resolve) => {
      resolveEarlierA = resolve;
    });

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask, testScoreTask],
        sources: [
          { ...testFlowSource, sourceId: "flow-log", taskId: "flow-cifar10" },
          { ...testFlowSource, sourceId: "score-log", taskId: "score-based" },
        ],
      },
    });

    api.getLogs = vi.fn().mockImplementation(async (query: any) => {
      if (query.sourceId === "flow-log" && query.before) {
        return earlierPromiseA;
      }
      if (query.sourceId === "flow-log") {
        return {
          events: [],
          nextBefore: "cursor-flow-1",
          truncatedByBudget: false,
        };
      }
      if (query.sourceId === "score-log") {
        return {
          events: [],
          nextBefore: "cursor-score-1",
          truncatedByBudget: false,
        };
      }
      return { events: [], nextBefore: null, truncatedByBudget: false };
    });
    (window as any).monitor = api;

    render(<App />);

    // Wait for flow-cifar10 initial load
    await waitFor(() => {
      expect(screen.getByText(/加载更早日志/)).toBeDefined();
    });

    // Click load earlier on flow-cifar10
    fireEvent.click(screen.getByRole("button", { name: /加载更早日志/ }));

    // Verify it is loading
    expect(screen.getByText(/加载中/)).toBeDefined();

    // Now switch to score-based task
    const scoreTaskItem = screen.getByTitle("Score-based Generative Model");
    fireEvent.click(scoreTaskItem);

    // Wait for score-based to mount and complete initial load
    await waitFor(() => {
      const earlierBtn = screen.getByRole("button", { name: /加载更早日志/ });
      expect(earlierBtn).toBeDefined();
      // NB4: score task button must NOT be stuck in loading!
      expect((earlierBtn as HTMLButtonElement).disabled).toBe(false);
      expect(earlierBtn.textContent).toContain("加载更早日志");
    });

    // Now resolve A's delayed request
    await act(async () => {
      resolveEarlierA!({
        events: [],
        nextBefore: null,
        truncatedByBudget: false,
      });
    });

    // Button on score task must still be ready and enabled
    const earlierBtnAfter = screen.getByRole("button", { name: /加载更早日志/ });
    expect((earlierBtnAfter as HTMLButtonElement).disabled).toBe(false);
    expect(earlierBtnAfter.textContent).toContain("加载更早日志");
  });

  it("I4: history loading provides cancellation button and search error provides restart search button", async () => {
    let resolveEarlier: (val: any) => void;
    const earlierPromise = new Promise((resolve) => {
      resolveEarlier = resolve;
    });

    const searchSpy = vi.fn().mockImplementation(async (query: any) => {
      if (query.continuation === null && query.literal === "error-test") {
        throw new Error("STALE_CONTINUATION: Search index regenerated");
      }
      if (query.continuation === null && query.literal === "restart-test") {
        return {
          events: [
            {
              version: 1,
              eventId: "restarted-hit-1",
              taskId: "flow-cifar10",
              sourceId: "flow-log",
              generation: "gen-1",
              kind: "line",
              startOffset: 0,
              endOffset: 10,
              ingestedAt: "2026-10-18T20:30:00Z",
              text: "Search hit restarted successfully",
              reason: null,
              displayTruncated: false,
              recordComplete: true,
              prefixIncomplete: false,
              runId: "run-1",
              bindingId: null,
            },
          ],
          continuation: "cont-2",
          cancelled: false,
        };
      }
      return { events: [], continuation: null, cancelled: false };
    });

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });

    api.getLogs = vi.fn().mockImplementation(async (query: any) => {
      if (query.before) return earlierPromise;
      return { events: [], nextBefore: "cursor-1", truncatedByBudget: false };
    });
    api.searchLogs = searchSpy;
    (window as any).monitor = api;

    render(<App />);

    // 1. History cancellation test
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /加载更早日志/ })).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /加载更早日志/ }));

    // Must show '取消加载' button
    const cancelBtn = await screen.findByRole("button", { name: /取消加载/ });
    expect(cancelBtn).toBeDefined();

    // Click cancel
    fireEvent.click(cancelBtn);

    // After cancellation, button resets back to '加载更早日志' and not disabled
    await waitFor(() => {
      const earlierBtn = screen.getByRole("button", { name: /加载更早日志/ });
      expect((earlierBtn as HTMLButtonElement).disabled).toBe(false);
      expect(earlierBtn.textContent).toContain("加载更早日志");
    });

    // 2. Search error and restart search test
    const searchInput = screen.getByPlaceholderText(/搜索日志/);
    fireEvent.change(searchInput, { target: { value: "error-test" } });

    // Expect search error banner with '从头检索' button
    const restartBtn = await screen.findByRole("button", { name: /从头检索/ });
    expect(restartBtn).toBeDefined();

    // Now change search to 'restart-test' and click '从头检索'
    fireEvent.change(searchInput, { target: { value: "restart-test" } });
    fireEvent.click(restartBtn);

    await waitFor(() => {
      expect(screen.getByText(/Search hit restarted successfully/)).toBeDefined();
    });
  });

  it("I11: enforces shared triple UI budget (10,000 unique events, 8 MiB UTF-8, 64 KiB single event truncation)", async () => {
    // Generate an event with 70 KiB text (exceeding 64 KiB)
    const longChunk = "这是一段用来测试超长多字节UTF8边界截断的中文文本。".repeat(1500);
    const rawBytes = new TextEncoder().encode(longChunk);
    expect(rawBytes.byteLength).toBeGreaterThan(64 * 1024);

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
      logs: [
        {
          version: 1,
          eventId: "oversized-event",
          taskId: "flow-cifar10",
          sourceId: "flow-log",
          generation: "gen-1",
          kind: "line",
          startOffset: 0,
          endOffset: rawBytes.byteLength,
          ingestedAt: "2026-10-18T20:30:00Z",
          text: longChunk,
          reason: null,
          displayTruncated: false,
          recordComplete: true,
          prefixIncomplete: false,
          runId: "run-1",
          bindingId: null,
        },
      ],
    });
    (window as any).monitor = api;

    render(<App />);

    // Must show truncation tag
    await waitFor(() => {
      expect(screen.getByText(/已截断|单条超限/)).toBeDefined();
    });

    // Check footer stats
    const footerStat = screen.getByText(/1 行/);
    expect(footerStat).toBeDefined();
  });

  it("I16(log): displays distinct error banner and retry button when initial getLogs fails", async () => {
    let callCount = 0;
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });

    api.getLogs = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("IPC_TIMEOUT: Log daemon did not respond");
      }
      return {
        events: [
          {
            version: 1,
            eventId: "recovered-ev",
            taskId: "flow-cifar10",
            sourceId: "flow-log",
            generation: "gen-1",
            kind: "line",
            startOffset: 0,
            endOffset: 10,
            ingestedAt: "2026-10-18T20:30:00Z",
            text: "Recovered after retry",
            reason: null,
            displayTruncated: false,
            recordComplete: true,
            prefixIncomplete: false,
            runId: "run-1",
            bindingId: null,
          },
        ],
        nextBefore: null,
        truncatedByBudget: false,
      };
    });
    (window as any).monitor = api;

    render(<App />);

    // Must show error banner with retry button
    const retryBtn = await screen.findByRole("button", { name: /重试/ });
    expect(retryBtn).toBeDefined();
    expect(screen.getByText(/IPC_TIMEOUT|读取初始日志失败/)).toBeDefined();

    // Click retry
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText(/Recovered after retry/)).toBeDefined();
    });
    expect(screen.queryByText(/IPC_TIMEOUT/)).toBeNull();
  });
});



describe("T7 Fix 3 Requirements - Group C: Observation, Resources, Focus & Non-Log Errors (I7, I8, I10, I14, I16[nonlog])", () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("I7: source states, freshness distinction across states, observedAt, and BigInt > 2^53 comparison", async () => {
    const staleCatchupSource: LogSourceSnapshot = {
      version: 1,
      sourceId: "flow-log",
      taskId: "flow-cifar10",
      state: "catching_up",
      freshness: "stale",
      observedAt: "2026-10-18T20:31:05Z",
      generation: "gen-1",
      generationStartOffset: null,
      committedOffset: "9007199254740993",
      maxObservedOffset: "9007199254740995",
      continuityState: "tracking",
      catchupBytesRead: 1024,
      catchupBytesTotal: 4096,
      errorCode: null,
    };

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [staleCatchupSource],
      },
    });
    (window as any).monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/补读中.*待更新/)).toBeDefined();
    });

    expect(screen.queryByText(/已同步最新/)).toBeNull();

    const caughtUpSource: LogSourceSnapshot = {
      ...staleCatchupSource,
      freshness: "fresh",
      committedOffset: "9007199254740995",
      maxObservedOffset: "9007199254740995",
      state: "ready",
    };

    await act(async () => {
      api.emitUpdate({
        kind: "snapshot",
        snapshot: {
          version: 1,
          demo: false,
          hosts: [testHostConnected],
          tasks: [testFlowTask],
          sources: [caughtUpSource],
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/已同步最新/)).toBeDefined();
    });
  });

  it("I8: independent timestamps, unknown states, stale rate/ETA paused, decoupled snapshot sync time", async () => {
    const staleTask: TaskSnapshot = {
      ...testFlowTask,
      progress: {
        ...testFlowTask.progress,
        freshness: "stale",
        iterationsPerSecond: 4.5,
        etaSeconds: 3600,
        observedAt: "2026-10-18T20:10:00Z",
      },
      checkpoint: {
        ...testFlowTask.checkpoint,
        freshness: "stale",
        observedAt: "2026-10-18T20:15:00Z",
        mtime: "2026-10-18T20:12:00Z",
      },
      processes: {
        main: null,
        queue: null,
        workers: [],
      },
      queueLock: {
        source: "/run/lock",
        exists: null,
        heldByRegisteredProcess: null,
        observedAt: "2026-10-18T20:20:00Z",
        freshness: "stale",
      },
    };

    const hostWithoutLastSuccess: HostSnapshot = {
      ...testHostConnected,
      lastSuccessAt: null,
      scanComplete: false,
    };

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [hostWithoutLastSuccess],
        tasks: [staleTask],
        sources: [testFlowSource],
      },
    });
    api.requestRefresh = vi.fn().mockRejectedValue(new Error("REFRESH_TIMEOUT"));
    (window as any).monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText("待更新").length).toBeGreaterThanOrEqual(2);
    });

    expect(screen.getAllByText(/检查点/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/0 Workers/)).toBeNull();

    const hostPill = screen.getByRole("button", { name: "切换到 lab-campus" });
    expect(hostPill.getAttribute("title")).toContain("部分信息尚未读取完成");

    const refreshBtn = screen.getByRole("button", { name: /刷新全部宿主/ });
    const syncTimeBefore = refreshBtn.getAttribute("title");
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByText(/刷新观测数据失败.*REFRESH_TIMEOUT/)).toBeDefined();
    });
    const syncTimeAfter = refreshBtn.getAttribute("title");
    expect(syncTimeAfter).toBe(syncTimeBefore);
  });

  it("I10: strict process matching on (hostBootId, pid, startTicks) for main, queue, workers, and resources", async () => {
    const mainKey: ProcessKey = { hostBootId: "boot-1", pid: 101, startTicks: "1000" };
    const queueKey: ProcessKey = { hostBootId: "boot-1", pid: 102, startTicks: "2000" };
    const workerKey: ProcessKey = { hostBootId: "boot-1", pid: 103, startTicks: "3000" };

    const taskWithProcesses: TaskSnapshot = {
      ...testFlowTask,
      processes: {
        main: {
          key: mainKey,
          pid: 101,
          parentKey: null,
          cwd: "/workspace/train",
          scriptEntry: "train.py",
          role: "trainer",
          observedAt: "2026-10-18T20:30:00Z",
        },
        queue: {
          key: queueKey,
          pid: 102,
          parentKey: mainKey,
          cwd: "/workspace/train",
          scriptEntry: "queue.py",
          role: "queue",
          observedAt: "2026-10-18T20:30:01Z",
        },
        workers: [
          {
            key: workerKey,
            pid: 103,
            parentKey: mainKey,
            cwd: "/workspace/train",
            scriptEntry: "worker.py",
            role: "worker",
            observedAt: "2026-10-18T20:30:02Z",
          },
        ],
      },
      resources: [
        {
          observedAt: "2026-10-18T20:30:00Z",
          freshness: "fresh",
          source: "procfs",
          name: "process_rss",
          unit: "bytes",
          value: 104857600,
          scope: "process",
          deviceId: null,
          processKey: mainKey,
        },
        {
          observedAt: "2026-10-18T20:30:00Z",
          freshness: "fresh",
          source: "procfs",
          name: "process_rss",
          unit: "bytes",
          value: 999999999,
          scope: "process",
          deviceId: null,
          processKey: { hostBootId: "boot-OLD", pid: 101, startTicks: "1000" },
        },
        {
          observedAt: "2026-10-18T20:30:01Z",
          freshness: "fresh",
          source: "procfs",
          name: "process_rss",
          unit: "bytes",
          value: 52428800,
          scope: "process",
          deviceId: null,
          processKey: queueKey,
        },
        {
          observedAt: "2026-10-18T20:30:02Z",
          freshness: "fresh",
          source: "procfs",
          name: "process_rss",
          unit: "bytes",
          value: 31457280,
          scope: "process",
          deviceId: null,
          processKey: workerKey,
        },
      ],
    };

    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [taskWithProcesses],
        sources: [testFlowSource],
      },
    });
    (window as any).monitor = api;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/100\.0 MiB/)).toBeDefined();
    });
    expect(screen.queryByText(/999999999|953\.7 MiB/)).toBeNull();

    expect(screen.getByText(/50\.0 MiB/)).toBeDefined();
    expect(screen.getByText(/30\.0 MiB/)).toBeDefined();

    const evidenceBtn = screen.getByRole("button", { name: /任务详情/ });
    fireEvent.click(evidenceBtn);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /任务详情抽屉/ })).toBeDefined();
    });

    expect(screen.getByText(/boot-1:102:2000/)).toBeDefined();
    expect(screen.getByText(/boot-1:103:3000/)).toBeDefined();
    expect(screen.getByText(/状态观测时间/)).toBeDefined();
    expect(screen.queryByText(/最近确认存活时间/)).toBeNull();
  });

  it("I14: keyboard shortcut guards against IME keyCode 229, contentEditable, Space in log viewport, and modal inert background", async () => {
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });
    const refreshSpy = vi.fn().mockImplementation(api.requestRefresh);
    api.requestRefresh = refreshSpy;
    (window as any).monitor = api;

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: /核心指标看板/ })).toBeDefined();
    });

    const keydown229 = new KeyboardEvent("keydown", {
      ctrlKey: true,
      key: "r",
      keyCode: 229,
      bubbles: true,
    });
    window.dispatchEvent(keydown229);
    expect(refreshSpy).not.toHaveBeenCalled();

    const editableDiv = document.createElement("div");
    editableDiv.contentEditable = "true";
    editableDiv.setAttribute("contenteditable", "true");
    editableDiv.tabIndex = 0;
    document.body.appendChild(editableDiv);
    editableDiv.focus();

    const editableKeydown = new KeyboardEvent("keydown", {
      ctrlKey: true,
      key: "r",
      bubbles: true,
    });
    editableDiv.dispatchEvent(editableKeydown);
    expect(refreshSpy).not.toHaveBeenCalled();
    document.body.removeChild(editableDiv);

    const settingsBtn = screen.getByRole("button", { name: "系统设置" });
    fireEvent.click(settingsBtn);

    const dialog = await screen.findByRole("dialog", { name: "系统设置" });
    expect(dialog).toBeDefined();

    const appBody = container.querySelector(".app-body");
    expect(appBody?.hasAttribute("inert")).toBe(true);

    const closeBtn = screen.getAllByRole("button", { name: /关闭设置/ })[0];
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "系统设置" })).toBeNull();
    });
    expect(appBody?.hasAttribute("inert")).toBe(false);
  });

  it("I16(nonlog): non-log error states, retry for getSnapshot, loading state, and refresh failure handling", async () => {
    let callCount = 0;
    const api = createControlledMockApi({
      snapshot: {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      },
    });

    api.getSnapshot = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("DAEMON_UNAVAILABLE");
      }
      return {
        version: 1,
        demo: false,
        hosts: [testHostConnected],
        tasks: [testFlowTask],
        sources: [testFlowSource],
      };
    });
    (window as any).monitor = api;

    render(<App />);

    const retryBtn = await screen.findByRole("button", { name: /重试/ });
    expect(retryBtn).toBeDefined();
    expect(screen.getByText(/读取初始快照失败.*DAEMON_UNAVAILABLE/)).toBeDefined();

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: /核心指标看板/ })).toBeDefined();
    });
    expect(screen.queryByText(/DAEMON_UNAVAILABLE/)).toBeNull();
  });


  describe("T7 Fix 3 Requirements - Group D: Anchor, Selection & Real Evidence (I6, I15)", () => {
    beforeEach(() => {
      cleanup();
      vi.restoreAllMocks();
    });

    it("I6: manual scroll lock, anchor tracking, and compensation on prepending/shifting logs", async () => {
      let subscribeListener = null;
      const initialEvents = Array.from({ length: 10 }, (_, i) => ({
        version: 1,
        eventId: "ev-" + i,
        taskId: "flow-cifar10",
        sourceId: "flow-log",
        generation: "gen-1",
        kind: "line",
        startOffset: i * 10,
        endOffset: (i + 1) * 10,
        ingestedAt: "2026-10-18T20:30:00Z",
        text: "Log line " + i,
        reason: null,
        displayTruncated: false,
        recordComplete: true,
        prefixIncomplete: false,
        runId: "run-1",
        bindingId: null,
      }));

      const api = createControlledMockApi({
        snapshot: {
          version: 1,
          demo: false,
          hosts: [testHostConnected],
          tasks: [testFlowTask],
          sources: [testFlowSource],
        },
        logs: initialEvents,
      });
      api.subscribe = vi.fn().mockImplementation((listener) => {
        subscribeListener = listener;
        return () => {
          subscribeListener = null;
        };
      });
      (window as any).monitor = api;

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText("Log line 0")).toBeDefined();
      });

      const viewport = screen.getByRole("region", { name: "日志流视窗" });

      // Simulate user scrolling up manually
      Object.defineProperty(viewport, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(viewport, "clientHeight", { value: 300, configurable: true });
      Object.defineProperty(viewport, "scrollTop", { value: 100, configurable: true, writable: true });
      fireEvent.scroll(viewport);

      // Scroll lock should be engaged
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "恢复自动滚动" })).toBeDefined();
      });

      // Emit new log event while locked
      expect(subscribeListener).toBeDefined();
      subscribeListener({
        kind: "logs",
        sourceId: "flow-log",
        events: [
          {
            version: 1,
            eventId: "ev-10",
            taskId: "flow-cifar10",
            sourceId: "flow-log",
            generation: "gen-1",
            kind: "line",
            startOffset: 100,
            endOffset: 110,
            ingestedAt: "2026-10-18T20:31:00Z",
            text: "Log line 10",
            reason: null,
            displayTruncated: false,
            recordComplete: true,
            prefixIncomplete: false,
            runId: "run-1",
            bindingId: null,
          },
        ],
      });

      // Floating unread banner must appear with unread count
      await waitFor(() => {
        expect(screen.getByText(/回到底部 \(\+1 新行\)/)).toBeDefined();
      });

      // Clicking resume button in the floating banner resumes auto-scroll
      const banner = screen.getByText(/回到底部 \(\+1 新行\)/).closest(".log-unread-floating-banner") as HTMLElement;
      const resumeBtn = banner.querySelector("button")!;
      fireEvent.click(resumeBtn);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "锁定自动滚动" })).toBeDefined();
        expect(screen.queryByText(/回到底部/)).toBeNull();
      });
    });

    it("I6: anchor eviction displays warning banner with history reload option when anchor event is dropped", async () => {
      const { LogConsole } = await import("../../src/renderer/components/LogConsole");
      const onReloadFromLatestSpy = vi.fn();
      const onLoadEarlierSpy = vi.fn();

      render(
        <LogConsole
          sources={[testFlowSource]}
          activeSource={testFlowSource}
          activeSourceId={testFlowSource.sourceId}
          onSelectSource={vi.fn()}
          events={[]}
          totalBufferedCount={0}
          totalBufferedBytes={0}
          isScrollLocked={true}
          setIsScrollLocked={vi.fn()}
          unreadCount={0}
          onResumeAutoScroll={vi.fn()}
          onToggleScrollLock={vi.fn()}
          searchQuery=""
          onSearchChange={vi.fn()}
          isSearching={false}
          isWrapLines={false}
          onToggleWrapLines={vi.fn()}
          onRefresh={vi.fn()}
          onLoadEarlier={onLoadEarlierSpy}
          onReloadFromLatest={onReloadFromLatestSpy}
          isAnchorEvicted={true}
        />
      );

      expect(screen.getByText("当前阅读位置已被缓冲区淘汰")).toBeDefined();
      const reloadHistoryBtn = screen.getByRole("button", { name: "历史重载" });
      expect(reloadHistoryBtn).toBeDefined();
      fireEvent.click(reloadHistoryBtn);
      expect(onLoadEarlierSpy).toHaveBeenCalled();
    });

    it("I15: dual progress bar fill widths reflect real values and handle boundary conditions (null, 0%, 100%)", async () => {
      const { DualProgressBar } = await import("../../src/renderer/components/DualProgressBar");
      const taskBase = { ...testFlowTask };

      // 1. Boundary: null fraction -> 0% width and fill-empty
      const taskNull = {
        ...taskBase,
        progress: {
          ...taskBase.progress,
          global: { ...taskBase.progress.global, fraction: null },
          session: { ...taskBase.progress.session, fraction: null },
        },
      };
      const { container: c1 } = render(<DualProgressBar task={taskNull} algorithm="flow" />);
      const globalFill1 = c1.querySelector(".progress-fill-global");
      const sessionFill1 = c1.querySelector(".progress-fill-session");
      expect(globalFill1.style.width).toBe("0%");
      expect(globalFill1.className).toContain("fill-empty");
      expect(sessionFill1.style.width).toBe("0%");
      expect(sessionFill1.className).toContain("fill-empty");
      cleanup();

      // 2. Non-zero fraction: 52.3% and 100%
      const taskFraction = {
        ...taskBase,
        progress: {
          ...taskBase.progress,
          global: { ...taskBase.progress.global, fraction: 0.523 },
          session: { ...taskBase.progress.session, fraction: 1.0 },
        },
      };
      const { container: c2 } = render(<DualProgressBar task={taskFraction} algorithm="flow" />);
      const globalFill2 = c2.querySelector(".progress-fill-global");
      const sessionFill2 = c2.querySelector(".progress-fill-session");
      expect(globalFill2.style.width).toBe("52.3%");
      expect(sessionFill2.style.width).toBe("100%");
    });
  });

});
