# Phase 1 执行提示词：全面去硬编码普适化、长连接复用传输与多宿主并发采集

> **执行定位**：本阶段为 4 阶段重构的第 1 步。核心目标是彻底剥离原作者个人工作流硬编码，建立真正普适的多宿主连接模型（任意 SSH / 动态 WSL / 本机 `local`），解决 SSH 连接风暴与采集阻塞瓶颈，并打通向后兼容的 `v1 → v2` 配置迁移与 NVIDIA 遥测兼容修复。
> **不要在此阶段重做前端视觉样式**（前端审美大改在 Phase 3），但本阶段须保证 `SettingsModal`、`HostConnectionPanel` 等交互能真实录入和校验新的宿主目标字段，且所有现有测试（经合理更新后）与构建全绿。

---

## 一、背景与必须根治的问题清单

根据全仓静态审计，当前代码存在以下阻断性普适性与传输缺陷，本阶段必须全部清零：

1. **单一宿主与个人路径全链路写死**：
   - `src/shared/contracts.ts`、`src/shared/validate.ts`、`src/transport/commands.ts` 将 `HostRegistration.target` 锁死为字面量 `'lab-campus'` 与 `'Ubuntu-26.04'`。
   - `src/registry/presets.ts` 预置个人路径 `/data2/cy/xzn` 与三个个人任务（`flow-cifar10`、`score-based`、`reflow`）。
   - `src/renderer/components/SettingsModal.tsx` 添加/编辑宿主时完全没有目标输入框，静默写死 `'lab-campus'` 和 `'Ubuntu-26.04'`；`src/renderer/components/HostConnectionPanel.tsx` 报错写死 `Ubuntu-26.04`。
2. **Windows 专用路径与硬编码 `/usr/bin/python3`**：
   - `src/transport/commands.ts` 与 `src/launch/server_agent.py` 硬编码 `/usr/bin/python3`；`src/transport/transport.ts` 硬编码 `wsl.exe`、`C:\Windows\System32\nvidia-smi.exe` 且缺乏原生 `local` 宿主模式。
   - `src/transport/protocol.ts` 从 stdout 第 0 字节开始直接解析 4 字节长度头，远程 `.bashrc`/MOTD/非 POSIX shell 输出任意字符即直接破坏帧协议。
3. **SSH 零复用连接风暴 + 全局串行阻塞 + 死代码退避**：
   - `src/collector/service.ts` 将所有宿主与任务串行塞进同一条 `this.tail` 链，每 5 秒为 `probeHost`、`probeTask`、`readLog`、`getServerWait` 各自拉起全新 `ssh` 握手；`transport.ts` 每次 `get_server_wait`/`cancel_server_wait` 都将约 465 KB 的三层 base64 Python 源码全量重传。
   - `src/collector/backoff.ts` 从未被调用，离线宿主每 5 秒撞 5 秒超时拖死全局与 `saveRegistry()`；`getSnapshot()` 阻塞等待全网轮询才返回本地缓存；`scheduler.ts` 的 `waitIdle()` 未真正等待活跃任务。
4. **传输错误处理与采集器状态 Bug**：
   - `transport.ts` 的 `runBoundedChild` 丢弃 `stderr`、遇快速退出 `EPIPE` 误报 `PROBE_STDIN_FAILED`、超时仅调用一次 `child.kill()` 无 SIGKILL / 进程树清理。
   - `service.ts` 中 `this.connectedHosts.add(host.hostId)` 写在 `ensureHostEpoch()` 之前，导致重连/重启后 `hostEpochs` 永远不轮转；`this.publishedLogSignatures` 无限增长导致主进程内存泄漏。
5. **NVIDIA 遥测与硬件锁定**：
   - `readonly_probe.py` 未匹配带方括号的 `[N/A]` / `[Not Supported]`，且 `GPU-*` UUID 正则直接拒绝 NVIDIA MIG（`MIG-*`）；NVML 存在采样缓冲区竞态、0.3s 全局截止时间丢弃高索引卡、墙钟偏移丢样本问题；无 GPU 主机或非 NVIDIA 硬件缺少优雅降级。
6. **配置无迁移机制**：
   - `src/registry/config.ts`、`src/registry/preferences.ts`、`src/shared/validate.ts` 对键集合做严格 `exact` 拦截，升级新增字段即导致启动崩溃。

---

## 二、详细改造规范

### 1. 普适化宿主模型与 `~/.ssh/config` / WSL 自动发现

修改 `src/shared/contracts.ts`、`src/shared/validate.ts`、`src/shared/registry-snapshot.ts`、`src/registry/presets.ts`、`src/registry/config.ts`、`src/registry/preferences.ts`：

1. **泛化 `HostRegistration.target` 联合类型**（升级配置版本至 `version: 2`）：
   ```ts
   export type HostTarget =
     | {
         kind: 'ssh';
         /** 模式一：直接引用 ~/.ssh/config 别名；模式二：显式连接参数 */
         alias?: string;
         hostname?: string;
         user?: string;
         port?: number;
         identityFile?: string;
         proxyJump?: string;
         /** 可选远端 Python 解释器覆盖路径（留空则自动探测 python3 / conda） */
         pythonPath?: string;
       }
     | {
         kind: 'wsl';
         distribution: string;
         pythonPath?: string;
       }
     | {
         kind: 'local';
         pythonPath?: string;
       };
   ```
   - 校验规则：
     - `ssh`：必须提供合法 `alias`（拒绝以 `-` 开头或含控制字符/空白，防 SSH 参数注入）或合法 `hostname`；`port` 若存在须为 `1..65535` 整数；`proxyJump`/`user`/`identityFile` 禁止换行与空字节。
     - `wsl`：`distribution` 为非空安全字符串（严禁写死 `'Ubuntu-26.04'`）。
     - `local`：支持在当前 Windows / Linux / macOS 本机直接采集。
   - 为 `HostRegistration` 增加可选字段：`stateDir?: string`（远端状态目录，解耦对 `allowedRoots[0]` 的依赖）、`pollIntervalMs?: number`（默认 `5000`，允许 `2000..60000`）、`allowJobControl?: boolean`（默认 `false`，为 Phase 2 远程作业控制预留开关）。
   - 放宽 `allowedRoots` 校验：支持 POSIX `/` 路径以及在 Windows `local` 目标下支持合法盘符绝对路径（如 `D:\...` / `C:/...`），并允许 `allowedRoots` 在只读浏览主机 GPU 阶段为空数组（此时仅放行整机/GPU 探针，登记任务时再校验目录归属）。
2. **清除个人预设与空态引导**：
   - 重写 `src/registry/presets.ts`：`createDefaultRegistry()` 返回空的 `hosts: []`、`tasks: []`（`version: 2`），彻底移除 `lab-campus`、`Ubuntu-26.04`、`/data2/cy/xzn`、`flow-cifar10`、`score-based`、`reflow`。
   - 将演示模式用的样例数据统一收敛在 `src/mocks/fixtures.ts`，使用通用中性命名（如 `gpu-server-01`、`local-workstation`、`llm-sft-7b`、`vision-backbone`），不泄露个人目录。
3. **无感 `v1 → v2` 配置迁移与容错**：
   - 在 `src/registry/config.ts` 与 `src/registry/preferences.ts` 实现 `migrateRegistry(raw)` 与 `migratePreferences(raw)`：
     - 自动将已有 `version: 1` 的 `registry.json` 平滑迁移到 `version: 2`（保留用户已登记的所有宿主、任务与 `logFormat`），写入前原子备份 `registry.v1.bak.json`。
     - `preferences.json` 升级支持扩展键（`theme`、`locale`、`minimizeToTrayOnClose`、`launchAtLogin`、`windowBounds` 等），对未知的前向兼容字段采取保留或安全忽略，不再因多一个字段直接抛 `PREFERENCES_INVALID`。
     - 若配置文件 JSON 损坏，不静默崩溃，记录错误并自动隔离备份为 `*.corrupt-<timestamp>.bak`，向上层返回结构化恢复提示。
4. **宿主自动发现 IPC 能力**：
   - 新增工具模块 `src/transport/discovery.ts` 并通过 `src/desktop/ipc.ts`、`src/desktop/preload.ts`、`src/shared/api.ts` 暴露：
     - `discoverSshHosts()`：安全解析 `~/.ssh/config`（支持 `Include` 一层展开与多别名提取，跳过通配符 `*` / `?`），返回候选 `{ alias, hostname, user, port, identityFile, proxyJump }[]`。
     - `discoverWslDistros()`：在 Windows 上运行 `wsl.exe --list --quiet`（正确处理 UTF-16LE 输出与去除 `\0`/`\r`），返回已安装与运行中状态列表；非 Windows 返回 `[]`。
   - 更新 `src/renderer/components/SettingsModal.tsx` 与 `HostConnectionPanel.tsx`：移除所有硬编码 `'lab-campus'` / `'Ubuntu-26.04'` / `'/data2/cy/xzn'`，提供最小可用表单字段（SSH 别名/一键导入 `~/.ssh/config`/显式主机端口用户私钥、WSL 发行版选择、本机 `local` 模式、可选自定义 Python 路径）。

### 2. 长连接复用传输层（Per-Host Persistent Multiplexed Worker）

重构 `src/transport/commands.ts`、`src/transport/protocol.ts`、`src/transport/transport.ts`、`src/probe/readonly_probe.py`：

1. **带魔数哨兵的二进制帧协议（防 `.bashrc`/MOTD 污染）**：
   - 在 `src/transport/protocol.ts` 与 `src/probe/readonly_probe.py` 约定帧格式：`[4-byte magic: b"TMF1"][4-byte big-endian uint32 length][UTF-8 JSON payload]`。
   - 客户端解码器扫描并丢弃 `TMF1` 魔数之前由远程登录 shell/MOTD 产生的任意杂散 stdout 字节，彻底杜绝非静默 `.bashrc` 或 `fish`/`csh` 引发的协议崩坏。
2. **每宿主单条长连接常驻远端 JSON-RPC 会话**：
   - 在 `readonly_probe.py` 增加常驻服务循环模式（例如 `--serve`）：启动后持续从 stdin 读取带 `id` 的 JSON-RPC 请求帧，执行后写回带同 `id` 的响应帧，收到 EOF 或 `shutdown` 优雅退出。
   - 在 `src/transport/transport.ts` 实现 `HostSessionPool`：
     - **SSH 宿主**：通过单条长连接 `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=2` 启动常驻 `readonly_probe.py`，所有 `probe_host`、`probe_task`、`probe_batch`、`read_log` 均复用该会话的双向管道，彻底消灭每 5 秒反复 SSH 握手！
     - **动态 Python 解释器探测**：远程启动命令不再写死 `/usr/bin/python3`；若宿主配置了 `pythonPath` 则优先校验使用，否则使用轻量 POSIX 探针序列（`command -v python3 || command -v python || /usr/bin/python3`），并验证 Python >= 3.7（失败时返回明确错误码 `REMOTE_PYTHON_UNAVAILABLE` 及诊断信息）。
     - **WSL 宿主**：同样复用每发行版单条长连接 `wsl.exe -d <distro> -- ...`，避免每次 RPC 重复调用 `wsl.exe --list --running --quiet`（改为会话建立前及断线重连时检查一次）。
     - **Local 宿主**：直接本地 `spawn` 对应平台的 Python（Windows/Linux/macOS 自适应探测 `python3`/`python`/`py -3`），无需 SSH/WSL。
     - **自动重连与进程树安全回收**：会话异常断开、超时或关闭时，立即拒绝未完成请求、清理会话槽位，并在超时清理中执行 `SIGTERM → 1500ms → SIGKILL`（Windows 使用 `taskkill /PID <pid> /T /F`，POSIX 使用负 PID 进程组查杀），杜绝僵尸 `ssh`/`wsl`/`python` 残留。
3. **单次批量合并探测 + 消除 465 KB 重复上传**：
   - 在 `readonly_probe.py` 新增批量操作 `probe_host_and_tasks`：一次 RPC 同时返回宿主基础状态、整卡 GPU 信息及该宿主下所有已启用任务的进程与源文件元数据，将每轮每宿主的往返次数从 `O(1 + 3 * N)` 压减为 `1`（外加按需增量 `read_log`）。
   - 修改 `src/transport/transport.ts`：对只读操作（`get_server_wait`、`cancel_server_wait`）禁止将三层 base64 嵌套的 ~465 KB 部署脚本随请求反复重传；仅在 `ensure_server_wait` 检测到远端缺少匹配 sha256 的 worker 脚本时才按需下发一次。
4. **修复 `EPIPE` 竞态与 SSH `stderr` 结构化错误分类**：
   - 修复 `runBoundedChild` / 长连接会话：写入 `stdin` 遇 `EPIPE` 时不立即覆盖真实退出原因，等待 `close` 事件结合退出码与受限截断后的 `stderr`（上限 4 KiB，脱敏敏感路径）精准分类错误：`SSH_HOST_KEY_UNKNOWN`、`SSH_AUTH_FAILED`、`SSH_CONNECTION_REFUSED`、`SSH_TIMEOUT`、`REMOTE_PYTHON_UNAVAILABLE`、`WSL_NOT_RUNNING`、`HOST_UNREACHABLE`。
   - 前端 `HostConnectionPanel` 根据错误码直接给出可操作修复提示（如提示首次在终端执行 `ssh <alias>` 接受主机指纹或配置 `ssh-agent`）。

### 3. 每宿主独立并发调度、真正启用指数退避与采集器 Bug 修复

重构 `src/collector/scheduler.ts`、`src/collector/backoff.ts`、`src/collector/service.ts`：

1. **打破全局串行 `this.tail` 瓶颈**：
   - 每个已启用宿主在 `CollectorScheduler` 中拥有独立的调度计时器与串行尾队列（`hostKey = host.hostId`），不同宿主完全并行探测；A 宿主断网或高延迟绝不阻塞 B 宿主刷新与 `saveRegistry()`。
   - 修复 `CollectorScheduler.waitIdle()`：真实 `Promise.allSettled` 等待全部 `hostTails` 清空，不再仅用单个 `queueMicrotask` 敷衍。
2. **正式接线 `backoff.ts`**：
   - 宿主连续探测失败时使用 `nextBackoffMs(failures)` 递增退避间隔（例如 5s → 10s → 20s → 40s → 最大 60s），并在快照中暴露 `nextRetryAt` 与 `consecutiveFailures`；收到用户手动点击“重试连接”或恢复成功时立即归零退避。
3. **非阻塞 `getSnapshot()`**：
   - `ProductionMonitor.getSnapshot()` 立即读取本地持久化缓存与内存最新快照返回给 UI（零网络阻塞），同时在后台异步触发过期宿主刷新并通过订阅事件推送更新。
4. **修复 `ensureHostEpoch` 顺序 Bug 与 `publishedLogSignatures` 内存泄漏**：
   - 在 `refreshHost()` 中先执行 `this.ensureHostEpoch(host.hostId, hostObservation)`（比较 `lastBootId !== observation.hostBootId` 以及 `!this.connectedHosts.has(hostId)`，满足其一即轮转 epoch），再执行 `this.connectedHosts.add(host.hostId)`。
   - 将 `this.publishedLogSignatures` 替换为按 `(sourceId, generation)` 限容的有界窗口（如每源最多保留最近 512 条或直接采用递增 `(generation, seq, contentEpoch)` 游标判定），并在任务删除、宿主删除与 generation 封存时彻底释放内存。

### 4. NVIDIA 遥测兼容修复与异构/无卡硬件优雅降级

修改 `src/probe/readonly_probe.py`、`src/transport/gpu.ts`、`src/transport/transport.ts`、`src/domain/resources.ts`：

1. **统一 `[N/A]` / `[Not Supported]` 解析**：
   - 封装统一的缺失值解析函数（兼容 `N/A`、`[N/A]`、`NA`、`[Not Supported]`、`Not Supported`、`Unknown`、`-`），彻底解决 `nvidia-smi --format=csv,noheader,nounits` 返回 `[N/A]` 导致整个任务 GPU 遥测报 `NVIDIA_SMI_RESPONSE_INVALID` 的 Bug。
2. **支持 NVIDIA MIG 与稳健 NVML 采样**：
   - 扩展 GPU UUID 校验正则以同时匹配 `GPU-[A-Za-z0-9-]+` 与 `MIG-[A-Za-z0-9-]+`（并在 `gpu.ts`、`launcher.py`、`server_agent.py` 保持一致）。
   - 修复 NVML `nvmlDeviceGetProcessUtilization`：为采样数组增加额外余量缓冲、将总 0.3s 硬超时改为按单卡预算分摊（避免 8–16 卡节点高索引卡被截断）、采用单调时钟安全容差避免 NTP 校时微偏导致样本全部被丢弃。
   - 限制 `_query_linux_gpu` 的子进程流式读取字节上限（避免先无限读入内存再判断 16 KiB），并优先使用可信系统路径（`/usr/bin/nvidia-smi`、`/usr/local/nvidia/bin/nvidia-smi`）再回退 `PATH`；Windows 本地/WSL 的 `nvidia-smi.exe` 支持 `System32` + `Program Files\NVIDIA Corporation\NVSMI` + `PATH` 查找。
3. **无 GPU / 非 NVIDIA 主机优雅降级与抽象探针接口**：
   - 抽离远端加速器探测器抽象层（`AcceleratorCollector`），当前内置 `NvidiaCollector` 与 `NoGpuFallbackCollector`（并在结构上预留 `RocmCollector` / `AppleMpsCollector` 扩展点）。
   - 当宿主机无 `nvidia-smi` 或为纯 CPU 训练节点时，返回明确的 `acceleratorAvailability: 'none'`（而非当作严重连接错误报错），主机连接状态仍为正常 `connected`，允许纯 CPU 训练任务顺利监控。

---

## 三、涉及的核心文件清单

- 共享契约与迁移：`src/shared/contracts.ts`, `src/shared/validate.ts`, `src/shared/api.ts`, `src/shared/registry-snapshot.ts`, `src/registry/presets.ts`, `src/registry/config.ts`, `src/registry/preferences.ts`
- 传输与发现：`src/transport/types.ts`, `src/transport/commands.ts`, `src/transport/protocol.ts`, `src/transport/gpu.ts`, `src/transport/transport.ts`, `src/transport/discovery.ts`（新增）
- 探针与采集器：`src/probe/readonly_probe.py`, `src/collector/scheduler.ts`, `src/collector/backoff.ts`, `src/collector/service.ts`
- 桌面 IPC 与最小 UI 接线：`src/desktop/channels.ts`, `src/desktop/ipc.ts`, `src/desktop/preload.ts`, `src/mocks/fixtures.ts`, `src/mocks/api.ts`, `src/renderer/components/SettingsModal.tsx`, `src/renderer/components/HostConnectionPanel.tsx`
- 对应单元测试与传输/探针测试：`tests/unit/*`, `tests/transport/*`, `tests/probe/*`, `tests/ui/*`

---

## 四、验收标准与必跑命令

执行完成后，必须逐项验证并输出命令执行结果：

1. **零硬编码检索验收**：
   - 在 `src/` 全目录检索 `lab-campus`、`Ubuntu-26.04`、`/data2/cy/xzn`，结果必须为 **0 处**（仅测试 fixtures 允许使用明确标记为 legacy migration 的 v1 测试样本）。
2. **新增核心自动化测试**：
   - `v1 → v2` 配置迁移测试（含旧 `lab-campus`/`flow-cifar10` 平滑升级 + 损坏 JSON 备份恢复）。
   - `discoverSshHosts`（解析带 `Include`、注释、多主机、通配符的 SSH config）与 `discoverWslDistros`（UTF-16LE 输出解析）单测。
   - 帧协议测试：在 `TMF1` 魔数前注入随机 MOTD/`.bashrc` 杂散字节仍可准确解帧。
   - `HostSessionPool` 复用测试：连续 3 轮采集仅建立 1 次长连接会话，不重复 spawn SSH；断线后自动重连且 `ensureHostEpoch` 正确轮转 epoch。
   - 多宿主并发 + 退避测试：A 宿主超时不阻塞 B 宿主，失败后间隔按 `backoff.ts` 递增；`getSnapshot()` 瞬时返回不阻塞。
   - NVIDIA `[N/A]`、`[Not Supported]`、`MIG-*` UUID 与无 GPU 节点优雅降级测试（Python `unittest` + TS `vitest`）。
3. **必跑验证命令（全绿通过）**：
   ```bash
   npm run typecheck
   npm run test:unit
   python -B -m unittest discover -s tests/probe -p "test_*.py"
   python -B -m unittest discover -s tests/launch -p "test_*.py"
   npm run build
   npm run test:runtime
   ```
4. **完成后请创建清晰 commit，不修改 `docs/prompts/` 下文件。**
