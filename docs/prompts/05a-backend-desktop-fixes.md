# Phase 5a 收尾修复提示词：后端、探针、自动启动、桌面端与测试卫生修复（建议 Codex 执行）

> **执行定位**：前 4 个 Phase 的核心框架与视觉重构已基本完成，但在 Windows 实机全量测试与 4 路逐行代码复核中发现了若干跨边界接线 Bug、测试平台兼容问题及未清理的脏文件。本提示词专注**后端、探针、传输、自动启动、SQLite、桌面主进程与仓库卫生**的精准修复，不触碰前端审美大改（前端交互/i18n/样式微调在 `05b-frontend-polish-and-wiring.md` 中由前端会话执行）。

---

## 一、P0 级必须立即修复的硬伤（6 项）

### 1. Checkpoint 全链路字段名错位（生产环境 Checkpoint 永远为空）
- **位置**：`src/probe/readonly_probe.py:1669-1685, 2862-2867` vs `src/transport/transport.ts:951-980`
- **根因**：`scan_checkpoints()` 返回 `{"scanComplete", "errorCode", "checkpoint": {...}}` 并写入 `payload["checkpointScan"]`，但 `transport.ts` 中 `projectTaskObservation()` 读取 `rawCp.latest` 而非 `rawCp.checkpoint`，导致 `evaluateCheckpoint()` 永远收到 `{ path: null }`。
- **修复**：在 `transport.ts` 的 `projectTaskObservation()` 中统一读取 `rawCp.checkpoint ?? rawCp.latest`（或统一对齐协议字段为 `checkpoint`），并新增一条端到端 `probe -> transport -> collector` 目录型 Checkpoint 集成测试。

### 2. ANSI 彩色日志与 `\r` tqdm 进度条被字节长度校验误杀，破坏实时进度与 ETA
- **位置**：`src/logs/decoder.ts:29-34, 210-231`、`src/collector/service.ts:1624-1636`、`src/domain/bindings.ts:540-548`
- **根因**：
  1. `decoder.ts` 将纯文本存入 `event.text`、原始 ANSI 存入 `event.rawAnsi`。`collector/service.ts:1624` 用 `rawAnsi` 算 `terminatorBytes`，却把剥离后的 `event.text` 传给 `outputSamples`，导致 `bindings.ts:545` 字节长度等式恒不成立。
  2. 多帧 `\r`（tqdm）重绘行共享同一个起始 `recordStart`，因此 `endOffset - startOffset` 跨越所有历史帧而 `event.text` 仅含最后一帧，`terminatorBytes > 2` 导致 `collector/service.ts:1626` 与 `bindings.ts:545` 直接跳过所有 tqdm 行。
- **修复**：在 `decoder.ts` 中为重绘/ANSI 行保留准确的原始帧字节范围信息（例如 `rawByteLength` / `frameStartOffset` 或 `redrawn: boolean`），在 `sampleLogOutputs()` 与 `findSubstantiveTrainerProcess()` 中使用 `event.rawAnsi ?? event.text` 进行范围核对，并对 `\r` 重绘行允许 `rawByteLength + terminatorBytes <= endOffset - startOffset`（确保合法字节边界不越界）。补充端到端仿真测试：同时含 ANSI 颜色码与多帧 `\r` tqdm 的日志流必须正常绑定并产出实时进度与 ETA。

### 3. `log_only` 与非直写 FD 的 `inferred_tree` 模式无法产出进度、标量与时序曲线
- **位置**：`src/domain/lifecycle.ts:389-413, 469-481`、`src/domain/bindings.ts:495-502, 760-786`、`src/collector/service.ts:1373-1399`
- **根因**：`log_only` 留下 `currentRun = null` 跳过 `deriveProgress()`；`inferred_tree` 在 `updateBindings()` 仍要求 `exact_entry_and_direct_writer_fd`，导致容器/Slurm/`| tee` 任务永远没有进度、Loss/LR 标量与 `metric_samples`。
- **修复**：利用 `contracts.ts` 已定义的 `evidenceKind: 'inferred_tree' | 'log_only'`，为这两种归属模式打通合法的记录绑定与 `deriveProgress()` / `metric_samples` 写入路径（同时保持 UI 上的归属置信度透明区分，不影响 `confirmed_process` 的严格语义）。补充针对 `log_only` 和 `| tee` `inferred_tree` 的仿真测试。

### 4. `useLocalLocks: true` 破坏 `gpuSharing` 占卡检测并引发跨分区 `EXDEV`
- **位置**：`src/transport/transport.ts:1132-1133`、`src/launch/launcher.py:1221-1234, 1312-1313, 1332-1345`、`src/launch/server_agent.py:2036-2038`
- **根因**：`launcher.py` 把 `.share-*.slot` 建在 `/tmp` 本地锁目录，但 `server_agent.py:2037` 传 `state_root`（`$HOME` 下）给 `_sharing_candidate_allowed()` 导致永远查不到占卡；且 `_update_sharing_slot_pid()` 在 `state_directory` 建临时文件后跨挂载点 `os.replace` 到 `/tmp` 锁目录触发 `EXDEV` 并被静默吞掉。
- **修复**：`server_agent.py` 在 `useLocalLocks` 开启时统一传 `launcher._runtime_lock_dir()`；`_update_sharing_slot_pid()` 始终在 `os.path.dirname(slot_path)` 下创建临时文件确保同文件系统原子 `os.replace`。补充 Python 回归测试。

### 5. `controlTask('restart')` 必然抛 `LAUNCH_SERVICE_UNAVAILABLE`
- **位置**：`src/collector/service.ts:811-823`、`src/transport/transport.ts:1494-1570`
- **根因**：`service.ts:813` 传入 `restart:${armId}:${ts}` 非 64 位十六进制 `configHash`，被 `transport.ts:1538` 直接拒绝；此外复用旧 `armId` 冲突、未校验 `signal_task` 结果并等待进程退出、`launchTask` 漏传 `cudaVisibleDevicesMode`/`stateDir`/`useSupervisor`/`useLocalLocks` 且误拒空 `gpuDeviceIds`。
- **修复**：生成合法 SHA-256 十六进制 `configHash` 与新的重启 `armId`，先确认 `signal_task` 终止成功并短轮询等待旧进程退出，再透传完整启动参数完成重启。补充 `controlTask('restart')` 单元测试。

### 6. 主进程启动期 `page.reload()` 中断 `initialLoad` 导致全部 IPC 被卸载（`shell.spec.ts` 实机失败）
- **位置**：`src/desktop/main.ts:254-262`
- **根因**：`main.ts:257` 在顶层 `app.whenReady()` 链中 `await initialLoad`；一旦渲染页在首帧加载期间被刷新（例如用户按 `Ctrl+R` 或 Playwright `shell.spec.ts:68` 调用 `page.reload()`），`window.loadFile()` 抛出 `ERR_ABORTED`，直接落入 `.catch()` 执行 `shutdownStarted = true; await releaseResources()`，把 `monitor:*` 全部 IPC 处理器卸载掉，导致应用永久报 `No handler registered for 'monitor:refresh'`。
- **修复**：对 `initialLoad` 单独捕获并忽略 `ERR_ABORTED`（错误码 `-3`）导航中断，绝不因普通页面重载触发主进程停机与 IPC 注销。确认 `tests/desktop/shell.spec.ts` 全部通过且 `afterAll` 不再超时。

---

## 二、P1 级重要可靠性、安全、功能与测试修复（15 项）

### A. 传输、探针与采集器（Phase 1–2）
1. **`HostSessionPool.call()` 并发启动进程泄漏**（`src/transport/transport.ts:493, 517-526, 795-810`）：引入 `starting` 状态或共享 `startPromise`（`isUsable = !closed && !dead`），确保同宿主并发调用排入同一条会话队列而不覆盖创建重复进程，替换旧会话前必定 `close()`。
2. **`local` 宿主 `fallbackCommands` 异步 `ENOENT` 死代码**（`src/transport/transport.ts:537-544, 853-855`、`src/transport/commands.ts:157-174`）：异步探测或监听 `spawn`/`error`（含 Windows Store 9009 / Python <3.7 退出码 126）依次尝试 `python` / `py -3` / `python3`，并在 `invokeOneShotScript` 同步生效。
3. **正式接线 `AcceleratorCollector`**（`src/probe/readonly_probe.py:2613-2682, 2872, 2893`）：将 `_probe_host_impl` 与 `_probe_task_impl` 改为通过 `select_accelerator_collector()` 分发（透传 `proc_root`、`include_details`、`allow_cross_uid`），不再旁路绕过。
4. **Windows `hostBootId` 32 位溢出与分钟抖动**（`src/probe/readonly_probe.py:2700-2706`）：显式设置 `GetTickCount64.restype = ctypes.c_ulonglong` 并在会话内缓存稳定启动标识，消除 24.85 天溢出与跨分钟抖动误触发 epoch 轮转。
5. **SSH 参数与 `fish` 下 `pythonPath` 安全收紧**（`src/shared/validate.ts:132-164`、`src/transport/commands.ts:24, 42-44, 118`）：对 `alias`/`hostname`/`user` 与 `proxyJump` 逗号分隔的**每一跳**均按严格白名单校验（禁止前导 `-` 及 shell 元字符 `` ;|&$`()'" ``），在 SSH/WSL `pythonPath` 中禁止 `\` 与前导 `-`。
6. **`sampleLogOutputs()` 切片方向写反**（`src/collector/service.ts:1607-1623`）：`store.getLogs()` 返回 `ORDER BY seq DESC`（索引 0 最新），改为 `page.events.slice(0, 30).reverse()` 取按时间正序的最新 30 行尾日志，并用 `page.events.find(...)`（去掉 `.reverse()`）选最新训练样本。
7. **多日志源任务进度被清空**（`src/domain/progress.ts:331-334`）：当 `distinctSources.size > 1` 时不再直接返回空进度，改为聚合跨源标量并选主进度源（或按源独立算速率后择优）。
8. **次要/动态日志缺失导致 `PROC_SCAN_INCOMPLETE`**（`src/probe/readonly_probe.py:1045-1080, 2785-2860`）：区分“日志文件尚未创建（`SOURCE_MISSING`）”与“扫描异常”，缺失日志源不污染 `scanComplete`，保证进程仍可通过其他日志源或 `inferred_tree` 归属。
9. **桌面日志导出缺失保存弹窗**（`src/desktop/ipc.ts:151-156`、`src/store/engine.ts:619-667`）：在 `CHANNELS.exportLogs` 中未指定安全路径时，由主进程绑定发起窗口调用 `dialog.showSaveDialog()` 选择目标路径（不信任渲染端传入的任意路径）；用户取消时返回 `{ exportedCount: 0, path: null, cancelled: true }`，选定后真实落盘并返回路径。
10. **自动启动 `retryBackoffSeconds` 默认被 0 覆盖 & 未启动误判完成**（`src/launch/server_agent.py:249-252, 1090, 1918-1930`）：第 249 行默认改为 `DEFAULT_RETRY_BACKOFF_SECONDS`（10）；`_retry_iteration()` 仅在 `record["state"] == "started"`（真实启动过进程）后才检查 `_completion_reported()`。
11. **补齐多任务主机级 FIFO 协调队列**（`src/launch/server_agent.py:1074-1109, 1694-1721, 2045-2098`）：在 waiter 记录中持久化单调 `createdAt`/`queueOrder`，在主机级队列锁下按 FIFO 顺序为高优先 waiter 预留候选卡，防止多个等待任务在同一热身卡上同时倒计时和惊群抢锁。
12. **持久化 `pendingRemoteCancels`**（`src/collector/service.ts:485, 644-653, 1188-1192`）：将待补发远端取消队列落盘（SQLite 表或原子 JSON 文件），重启后自动恢复并在对应宿主重连时冲刷。
13. **落实或诚实处理 `launch.modules`**（`src/launch/launcher.py:1143-1144`）：通过 `modulecmd python load <validated_mod>` 解析环境变量增量并应用到 `process_env`（若远端无 `modulecmd` 则返回明确结构化错误码 `MODULECMD_UNAVAILABLE`），替代无效的 `TM_REQUESTED_MODULES` 空壳变量。
14. **终端拉起防崩溃与 `tmux_attach` 补 `-S` 参数**（`src/desktop/notifications.ts:69-75, 108-143`）：为 `openLocalSshTerminal` 改为异步监听 `spawn`/`error` 事件，缺失 `wt.exe` 时自动回退 `powershell.exe`/`cmd.exe`、Linux 缺失 `x-terminal-emulator` 时依次回退 `gnome-terminal`/`konsole`/`xterm` 且绝不触发未捕获 `ENOENT`；为托管 `tm-wait-*` 会话的 `copyCommand('tmux_attach')` 补上对应的 `-S` 自定义 Socket 路径。
15. **`AlertEngine` 规则修复**（`src/collector/alerts.ts:23, 205-215, 268-319`）：放宽 `LOSS_NAN_INF_RE` 兼容单/双引号包裹（如 `{'loss': nan}` / `{"loss": "NaN"}`）或直接消费解析器 `nonFiniteLoss`；`training_stalled` 优先仅检查 `scope === 'process'` 的本任务 GPU 利用率，且对 `raw` 无进度模式或纯 CPU 节点避免误报停滞。

### B. 跨平台测试绿灯与仓库脏文件彻底清扫（Phase 4 验收门禁）
16. **修复 Windows 本机 `npm run test:python`（16F/15E → 0 失败）**：
    - `readonly_probe.py:2685-2708`（`_read_host_boot_id`）支持在提供自定义 `proc_root` 或 mock 时走 `boot_id` 读取逻辑；
    - `tests/probe/test_gpu_probe.py:459-460` 对 `clock_gettime_ns`/`sysconf`/`CLOCK_BOOTTIME` 使用 `create=True`；
    - `tests/probe/test_process_gpu_probe.py:178` mock `os.name='posix'` 或 `_find_nvidia_smi`；
    - 对依赖 Linux `/proc`、POSIX `os.getuid()`/`0o600`/`os.killpg`/非提权软链接的探针与启动用例（`test_readonly_probe.py`、`test_phase2_probe.py`、`test_phase2_launch.py`），在非 POSIX 或无软链接权限的 Windows 环境添加明确的 `@unittest.skipUnless(...)` 守卫（或在单测中正确 mock 平台原语），确保 **Windows 与 Linux 上 `npm run test:python` 均 100% 绿灯**！
17. **修复 `phase4-resilience.spec.ts` Windows HiDPI 1px 容差与 `retention.test.ts` 超时**：
    - `tests/desktop/phase4-resilience.spec.ts:97-99` 在 Windows DPI 缩放下允许 `±2px` 误差（`Math.abs(w - 1060) <= 2`），同时保留精确持久化一致校验。
    - `tests/store/retention.test.ts:273` 为 16/128/1024 多轮大样本测试显式设置 `15_000` 超时，避免并发测试环境下 5024ms 偶发擦线超时。
18. **真正从磁盘删除全部 Phase 4 要求的脏文件**：
    - 物理删除工作区中的：`apply_changes.py`、`task-6b-core-report.md`、`task-7-fix-3-report.md`、全部 39 个根目录 `task-6b-*.log`/`task-7-*.log`、`NVIDIA Corporation/`、`.superpowers/`（含敏感 `.last-token`）、以及全部 `__pycache__/` 目录与 `.pyc` 文件。
    - 清理 `.gitignore` 中残留的 `/NVIDIA Corporation/` 与 `/.superpowers/` 一次性条目；执行 `git add --renormalize .` 将 20 个残留 CRLF 的受跟踪文本文件统一为 LF。

---

## 三、P2 级顺手收尾项（全部一次性补齐）

1. **WSL / Windows 本地 GPU 探针补全健康字段与 `diskPaths`**：扩展 `transport.ts:389-421` `windowsGpuObservation()` 采集完整 GPU 型号/温度/功耗/风扇/占卡进程；对齐 `includeSystemHealth` 字段名；`diskPaths` 合并各任务去重后的 `allowedDirectories`。
2. **托盘暂停采集与告警计数同步**：`collector/service.ts:665` 在 `saveRegistry()` 后检查 `!this.collectionPaused` 再触发后台探测；增加 IPC 通道让前端“已读/清空告警”同步重置 `main.ts` 托盘 `activeAlertCount`；`controller.ts`/`reconcile.ts` 优先输出结构化 `errorCode` + `errorParams` 交由前端 i18n 渲染（保留简短 fallback）。
3. **Windows DWM 多屏恢复容错**：`src/desktop/window.ts:103-107` 改为按与各显示器 `workArea` 的**最大可见交集面积**（阈值如 ≥ 100×50px）选屏并夹紧（clamp）坐标，避免 Windows 边缘吸附的 ~7px DWM 隐形边框把副屏窗口错误弹回主屏。
4. **杂项稳健性**：
   - `src/transport/discovery.ts` 内置与 `validateDiscoveredSshHosts` 一致的长度/前导 `-`/512 宿主上限保护；
   - `PersistentHostSession` 首次连接超时略大于 SSH `ConnectTimeout=8`（如 10s）避免竞态误判 `PROBE_TIMEOUT`；
   - `src/store/engine.ts:1391-1415` 改用 `CAST(strftime('%s', observed_at) / 300 AS INTEGER)` 实现真正 5 分钟分桶；`RestartableStoreClient.close()` 同步等待并销毁在途 `this.restarting` Worker；
   - `package.json:6-10` 移除个人 GitHub 用户名与邮箱，改为通用占位元数据；
   - `.github/workflows/ci.yml:35, 44` 为 `xvfb-run` 补齐 `-s '-screen 0 1920x1080x24'`，并补充覆盖 `SUBSCRIPTION_LIMIT_REACHED`、`assertSender`、任务栏进度与 `setLaunchAtLogin` 的定向测试。

---

## 四、必跑验收命令（全部 100% 绿灯）

```bash
npm run typecheck
npm run test:python
npm run test:unit
npm run build
npm run test:runtime
npm run test:desktop
npm run package:dir
npm run test:packaged
git status --short
```

确认以上全部退出码为 `0`，`git status` 无脏文件残留且 `docs/prompts/` 未改动，提交 Phase 5a commit 后再交由 Phase 5b 执行。
