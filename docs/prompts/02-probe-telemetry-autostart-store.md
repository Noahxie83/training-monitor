# Phase 2 执行提示词：通用 ML 探针与解析引擎、多卡自动启动、SQLite v2 时序存储、告警与进程发现

> **前置条件**：请先确认 Phase 1（`docs/prompts/01-universality-and-transport.md`）已完成并提交，本阶段直接建立在 Phase 1 的泛化宿主模型、长连接复用通道与批量探测能力之上。
> **核心目标**：彻底打通现代机器学习/深度学习全生态监控能力（多卡 DDP/FSDP、任意框架日志、目录级 Checkpoint、主机/GPU 健康指标），将 GPU 空闲自动启动升级为通用多卡主机级队列，重构 SQLite v2 时序与检索引擎，并补齐异常告警、进程自动发现与受控远程作业操作。

---

## 一、背景与必须根治的问题清单

1. **进程归属封杀现代 ML 训练**：
   - `readonly_probe.py` 硬编码个人脚本指纹（`start_parallel_worker(\d+)\.py`、`parallel_runner`），拒绝 `python -m`、非 `python*` 可执行文件（`torchrun`/`accelerate`/`deepspeed`/`yolo`/`uv`/`conda`/`bash`/`srun`），`MAX_FDS_PER_PROCESS = 128` 导致 PyTorch/NCCL 必然报 `PROC_SCAN_INCOMPLETE`，单进程校验（`candidates.length === 1`）与多写 FD 冲突校验彻底封杀 DDP/FSDP、`DataLoader` worker 与 `| tee` 管道日志。
   - **活跃日志写入竞态**：`readonly_probe.py` 在单次扫描中三次要求日志文件 `sizeBytes == expected['eofBytes']` 精确相等，训练一打日志就报 `PROC_SCAN_INCOMPLETE`。
   - **容器与 NFS 盲区**：仅扫描同 UID 进程（忽略 Docker/root 任务）、在读 `cmdline` 前就急切 `realpath(cwd)` 触发 NFS 阻塞耗尽 0.75s 预算、缺少 `NSpid` 容器命名空间感知。
2. **`raw` 模式损坏与 30s 日志 TTL 误报**：
   - `raw` 日志被映射为 `unknown` 后直接被 `isRuntimeTaskPolicy` 拒判；只要训练步长、eval 验证或 `torch.compile` 超过 30 秒未输出匹配行，运行中任务就会被误判为 `unconfirmed`（进程消失）。
3. **指标解析狭隘 + 私有 `status_json` 垄断终态 + Checkpoint 死代码**：
   - 速率（`it/s`）与 ETA 仍强绑 `algorithm === 'flow'`；`generic.ts` 丢弃 `loss`/`lr`/`grad_norm`/`eval` 数值、误杀含 `eval`/`validation`/`checkpoint` 的正常训练行、不剥离 ANSI、不支持 HF Python dict / Epoch / Token / 自定义正则；30 秒速率窗口上限无法处理慢步长。
   - `completed`/`failed`/`queued` 只能由包含内核 `hostBootId`/`startTicks`/`exclusive_index` 的私有 `status_json` 触发；`evaluateCheckpoint` 未接线且不支持分片目录型 Checkpoint（HF / DeepSpeed / Megatron / Lightning / YOLO）。
4. **日志管线缺陷与 SQLite v1 性能瓶颈**：
   - 无 ANSI 处理；`\r` tqdm 进度条刷新反复递增 `content_epoch` 引发翻页/搜索 `STALE_CONTINUATION` 风暴并残留 `redraw`+`line` 重复行；`O_NOFOLLOW` 阻断 `latest.log` 软链接；不支持 glob/时间戳目录与多日志源。
   - SQLite 存在 4 倍日志文本写放大（含无效 B-tree 索引 `log_events_text`）、冻结时钟、搜索与写入串行 Head-of-Line 阻塞、Worker 崩溃无法恢复、无时序表（`observation_snapshot` 覆盖写）、3 张死表从未读写。
5. **GPU 空闲自动启动（`src/launch/`）严重缺陷**：
   - 仅单卡、仅 `[python, -u, script.py]`、无 env/conda/venv、`CUDA_VISIBLE_DEVICES` 强制 UUID；`gpuDeviceIds` 白名单在传输与 UI 被静默丢弃；`gpuSharing` 缺 `status_json` 时 `StopIteration` 崩溃；`tmux.sock` 放在 `allowedRoots[0]` 导致 NFS 与 >108 字节路径必败；不清理历史状态导致 256 文件后永久 `STATE_FILE_LIMIT` 自毁；多任务热身期抢卡竞态；`controller.ts` 错误掩盖（`requiredIdleSeconds` 错位）；`retryOnExit` 无限重启；离线宿主死锁注册表编辑。
6. **核心运维能力缺口**：
   - 无 GPU 型号/温度/功耗/风扇/占卡进程及主机 CPU/RAM/磁盘/进程 RSS 采集；无异常检测与通知/Webhook；无运行中进程自动发现；无本地终端打开 / `tmux attach` 及可选远程停止/强杀/重启。

---

## 二、详细改造规范

### 1. 分层信任模型与通用 ML 进程树探针

改造 `src/probe/readonly_probe.py`、`src/domain/identity.ts`、`src/domain/bindings.ts`、`src/domain/lifecycle.ts`、`src/collector/service.ts`：

1. **彻底清除个人脚本指纹与修复扫描 Bug**：
   - 删除 `start_parallel_worker(\d+)\.py`、`from parallel_runner import run`、`b"parallel_runner"`、`waiting_flow`、`worker_finished`、`total_samples`/`completed_samples` 等作者私有硬编码。
   - **修复 `eofBytes` 竞态**：验证活跃日志写 FD 时仅校验文件身份 `(st_dev, st_ino)` 一致且 `current_size >= initial_size`，绝不因日志正在增长就判定 `scan_complete = False`。
   - **消除 NFS 阻塞与突破 128 FD 上限**：扫描 `/proc/<pid>` 时，先读取轻量的 `/proc/<pid>/comm` 与 `/proc/<pid>/cmdline` 完成粗筛，**仅对命中的候选进程**执行 `realpath(cwd)` 与目标 FD 检测；取消 128 FD 硬截断（对命中进程流式检查 FD 是否指向目标日志 inode，上限放宽至可配置如 4096 且超限时标记 `fdScanTruncated: true` 而非污染整机 `scanComplete`）；容忍对其他用户 `/proc/<pid>` 的 `EACCES`/`EPERM`（适配 `hidepid`）；允许可配置扫描预算（默认 `2.0s`）与可选跨 UID 扫描（适配 Docker/root 容器，读取 `/proc/<pid>/status` 中 `NSpid` 做容器 PID 映射）。
2. **完整命令解析与进程树聚合**：
   - 支持任意可执行文件（`python*`、`torchrun`、`accelerate`、`deepspeed`、`yolo`、`uv`、`conda`、`bash`/`sh`、`srun`、`ray`、二进制训练程序），完整解析 Python `-m <module>`、`-c`、合并短参数（`-uB`）、`-P` 等。
   - 在 `readonly_probe.py` 采集 `pid`、`ppid`、`pgid`、`cmdline`、`cwd`、`exe`，按父子进程与进程组（PGID）构建**任务进程树**：
     - 一个任务允许关联**一组进程（Root Launcher + N 个 DDP/FSDP Rank Worker + DataLoader 子进程）**，不再要求 `candidates.length === 1`。
     - 同一进程树内多个子进程继承共享 stdout/stderr 写入同一日志 FD 属于正常行为，彻底废除因此吊销绑定的“多写冲突”误判。
     - 聚合该进程树下所有 PID 的 GPU 显存、SM 利用率、CPU 利用率与进程 RSS。
3. **三层归属置信度与进程存活解耦**：
   - 引入显式字段 `attributionConfidence: 'confirmed_process' | 'inferred_tree' | 'log_only' | 'none'`：
     - `confirmed_process`：匹配注册命令/入口与工作目录，且进程（或其进程树/管道下游）持有活跃日志写 FD 或由本工具托管启动。
     - `inferred_tree`：匹配注册命令/模块/工作目录（支持 `| tee` 管道日志或容器外部重定向，无需直接写 FD）。
     - `log_only`：用户显式选择或无法穿透容器/Slurm `/proc` 时，仅凭日志文件持续增长与指标更新追踪任务（仍正常展示进度、曲线与日志，UI 清晰标示“仅日志追踪”）。
   - **进程存活与日志解析完全解耦**：
     - 只要主进程或进程树存活，无论任务处于 `raw` 日志模式还是长达数十分钟的 eval/compile/慢 step 静默期，生命周期必须稳定保持 `running`，**绝不因 30 秒无匹配日志行而降级为 `unconfirmed`**；进度新鲜度（`progressFreshness`）独立标识最后一次解析到指标的时间。
4. **无需私有 `status_json` 的终态推断**：
   - 将私有 `status_json` 与 `queue_lock` 降级为可选兼容适配器（移除其对 `completed`/`failed`/`queued` 的垄断）。
   - 终态来源按可信度分层：① 由本工具托管启动的任务直接记录真实退出码（`exitCode === 0 → completed`，非 0 → `failed` 并附尾段错误摘要）；② 支持标准框架状态文件（如 HuggingFace `trainer_state.json`）；③ 进程退出后检查尾部日志特征（如明确 Traceback / CUDA OOM / SIGKILL 判 `failed`，明确完成标记或达到目标 step/epoch 判 `completed`，否则保持 `stopped_unconfirmed` 并在 UI 说明原因而非笼统“消失”）。

### 2. 通用 ML 进度、标量指标解析与目录级 Checkpoint 扫描

改造 `src/parsers/*`、`src/domain/progress.ts`、`src/domain/checkpoints.ts`、`src/shared/task-profile.ts`：

1. **ANSI 剥离与多框架通用解析器**：
   - 所有解析器执行前统一剥离 ANSI 转义序列（`\x1b\[[0-9;?]*[ -/]*[@-~]` 等），日志原始 ANSI 保留供前端彩色渲染。
   - 扩展 `ParsedTrainingRecord` 与 `TaskProgress` 契约：
     - 主进度单位泛化：`unit: 'step' | 'epoch' | 'token' | 'sample' | 'percent' | 'unknown'`，同时支持 `current` / `total`（例如 `Epoch 3/50`、`step 1200/10000`）。
     - 动态标量指标字典：`scalars: Record<string, number>`（内置识别 `loss`、`train_loss`、`val_loss`、`eval_loss`、`lr` / `learning_rate`、`grad_norm`、`acc` / `accuracy`、`perplexity`、`tokens_per_sec` 等）。
     - `resumedSession` 副进度轨变为可选字段：仅当真实检测到续训基线（resume offset / checkpoint start）时才填充，普通从零训练不再强行展示无意义双轨。
   - 升级 `src/parsers/generic.ts`：
     - 修正过度激进的排除正则：不再误杀同一行同时包含 `loss` 与 `val_loss` / `validation` / `checkpoint` 的 Lightning、Keras、Ultralytics 日志（将 `val_*`/`eval_*` 提取到对应标量键而非丢弃整行）。
     - 支持主流框架开箱即用：HuggingFace Transformers 单引号 Python dict（`{'loss': 0.52, 'learning_rate': 1e-5, 'epoch': 0.25}`）、JSONL、标准 `key=value` / `key: value`、`Epoch X/Y`、`Step X/Y`、`Iter X/Y`、Ultralytics 表格行、`tqdm` 任意速率单位（`it/s`、`s/it`、`img/s`、`tok/s`、`samples/s`、`?it/s`）。
     - 支持任务级**自定义提取规则**（`customPatterns?: { progressRegex?: string; metricRegexes?: Record<string, string>; jsonFields?: Record<string, string> }`，带安全正则长度与防 ReDoS 校验）。
     - 将旧 `flow` / `score` / `reflow` 清晰归类为 `legacy_flow` / `legacy_score` / `legacy_reflow` 兼容预设（老配置自动映射），彻底从核心速率/ETA 逻辑中解耦。
   - **通用速率与 ETA**：对任意产生单调递增 `current`（step/epoch/token）的解析器均采用滑动窗口（可配置窗口上限如 30 分钟，彻底移除 30 秒 `dt` 上限）平滑计算速率与 ETA，且跨日志轮转连续有效。
2. **目录级与分片 Checkpoint 扫描（正式接线生产链路）**：
   - 在 `readonly_probe.py` 实现有界 Checkpoint 扫描并在 `transport.ts` → `collector/service.ts` → `domain/checkpoints.ts` 全链路接线。
   - 同时支持**单文件**（`.pt`/`.pth`/`.ckpt`/`.safetensors`/`.bin`）与**目录型分片 Checkpoint**（HF `checkpoint-*`、DeepSpeed `global_step*`、Megatron `iter_*`、Orbax/DCP），支持读取元数据指针文件（`trainer_state.json`、`latest_checkpointed_iteration.txt`、`latest`），扩展正则支持 `epoch=3-step=1500.ckpt`、`best.pt`、`last.pt`，允许无步数编号的 Checkpoint 正常展示文件名、总大小与更新时间。
3. **动态日志源（软链接、Glob、最新文件与多日志源）**：
   - 允许日志源配置 `pathMode: 'exact' | 'glob_latest' | 'dir_latest'`（严格限定在任务 `allowedDirectories` 内），原生适配 Hydra 时间戳目录、Lightning `version_N`、Ultralytics `expN` 与 Slurm `slurm-*.out`。
   - 对 `latest.log` 类软链接：不再盲目 `O_NOFOLLOW` 报错，改为先解析 `realpath` 并严格校验最终目标仍在 `allowedRoots` 范围内后再只读打开；`_read_log` 捕获全部 `OSError` 并映射结构化错误码。
   - 采集器与任务配置支持多日志源（如 `stdout.log` + `stderr.log` 或多 rank 日志），不再仅采样第一条日志源。

### 3. 主机与 GPU 全维健康遥测

扩展 `src/probe/readonly_probe.py`、`src/transport/gpu.ts`、`src/shared/contracts.ts`：

- **GPU 完整健康字段**（单次 `nvidia-smi` 查询一并采集，无额外开销）：`name`（显卡型号，如 `NVIDIA RTX 4090` / `A100-SXM4-80GB`）、`temperatureC`、`powerDrawW`、`powerLimitW`、`fanSpeedPct`、`pciBusId`、`computeMode`、`eccErrors`、`activeProcesses: Array<{ pid, command, user?, memoryMiB, smUtilPct? }>`（解决共享服务器上“到底是谁占着卡”的刚需痛点）。
- **主机系统与进程资源**：在 `probe_host_and_tasks` 中采集宿主机 CPU 总利用率、内存已用/总量、关键目录（`allowedRoots` 及工作目录）磁盘已用/可用空间，以及已绑定训练进程树的聚合 CPU 利用率与内存 RSS（正式填满 `domain/resources.ts` 中闲置的 `cpu_utilization` 与 `process_rss`）。

### 4. 日志管线修复与 SQLite v2 高性能时序/检索存储

重构 `src/logs/decoder.ts`、`src/store/schema.ts`、`src/store/engine.ts`、`src/store/worker-host.ts`、`src/store/client.ts`：

1. **彻底修复 `\r` tqdm 重绘风暴与重复行**：
   - 修改 `src/logs/decoder.ts` 与 `src/store/engine.ts`：
     - 同一行内持续的 `\r` 刷新统一使用同一个逻辑行 ID 就地覆盖，行尾遇到 `\n` 定格为同一行的最终态，**不再同时留下 `redraw` 和 `line` 两条重复记录**。
     - 尾部活跃行就地刷新时，若未改变已分页历史区间，不递增破坏历史翻页游标的 `content_epoch`，彻底根除 `STALE_CONTINUATION` 报错风暴。
     - 每条事件保留可选 `rawAnsi`（仅当含 ANSI 码时存储）与剥离后的纯文本 `text`（供搜索和解析使用）。
2. **SQLite Schema v2（事务迁移、消除 4 倍写放大、FTS5 与时序表）**：
   - 建立基于 `PRAGMA user_version` 的事务性迁移器（v1 → v2），移除未使用的死表（`run_bindings`、`task_projection`、`checkpoint_samples`）。
   - **消除 4 倍存储放大**：删除无用的 B-tree 索引 `log_events_text`；不再在 `log_events.event_json` 中重复序列化整段 `text`；新增 `log_events_fts`（SQLite FTS5 虚表，与 `log_events` 同步）支撑毫秒级大小写不敏感、多词与日志级别过滤，同时支持正则搜索（`regex` 模式）与跨日志源搜索及导出到文件。
   - **新增时序表与自动降采样清理**：
     - `metric_samples(task_id, run_id, observed_at, step, metric_name, value)`
     - `gpu_samples(host_id, device_id, observed_at, util_pct, mem_used_mib, mem_total_mib, temp_c, power_w)`
     - `host_samples(host_id, observed_at, cpu_pct, ram_used_mib, ram_total_mib)`
     - 提供 IPC 查询接口 `getMetricSeries(taskId, metrics, rangeMs, maxPoints)` 与 `getGpuSeries(hostId, deviceId?, rangeMs, maxPoints)`，服务端采用时间桶/LTTB 降采样返回适配图表的点数（如最多 240 点），并按保留策略自动滚动清理（如精细保留 24 小时、降采样保留 7 天）。
   - **修复 Worker 可靠性与并发瓶颈**：
     - 修复 `worker-host.ts` 冻结时钟 Bug，改用实时 `Date.now()`。
     - 启用 SQLite WAL 下的**读写分离**：写操作走单写队列，只读搜索与时序查询走独立只读连接（`readonly: true`），彻底消除搜索阻塞采集写入与快照读取。
     - 定时执行 `retain()` 并同步清理 `content_changes` 及已删任务/宿主的孤儿数据；在 `store/client.ts` 增加 Worker 意外退出后的受控自动重启与队列重建（不再永久锁死 `terminalError`）；在 `getSnapshot()` 中持久化保留“0 任务宿主”状态。

### 5. GPU 空闲自动启动（`src/launch/`）全面升级

重构 `src/shared/auto-start.ts`、`src/launch/controller.ts`、`src/launch/reconcile.ts`、`src/launch/launcher.py`、`src/launch/server_agent.py`：

1. **多卡 N-GPU、白/黑名单与通用启动命令**：
   - 支持配置 `requiredGpuCount: number`（默认 `1`，支持等待 `N` 张卡同时持续空闲达标）、`gpuDeviceIds` 白名单与 `gpuExcludeIds` 黑名单（修通 `transport.ts` 与前端表单的端到端透传，不再静默丢弃！）、`cudaVisibleDevicesMode: 'index' | 'uuid'`（默认 `'index'`，兼顾通用脚本）。
   - 启动规格泛化为通用命令模式：支持 `python` 脚本、`python -m` 模块、或任意命令/启动器（`torchrun`、`accelerate`、`deepspeed`、`bash train.sh` 等，基于 argv 数组安全执行，无 shell 注入），支持可选环境激活（`condaEnv` / `venvPath` / `modules`）与用户自定义环境变量键值表 `env: Record<string, string>`。
   - 修复 `gpuSharing`：不再因缺少私有 `status_json` 抛出 `StopIteration` 崩溃，改为显存稳定窗口/宽限期或自定义校验，并将 `.slot` 写入改为临时文件 + `os.replace` 原子更新。
2. **修复 NFS `tmux.sock`、256 文件自毁、抢卡竞态与非 `tmux` 降级**：
   - 将 Unix Socket（`tmux.sock`）与进程锁彻底移出 `allowedRoots[0]`，放入本机本地临时盘（优先 `$XDG_RUNTIME_DIR/training-monitor`，回退 `/tmp/training-monitor-<uid>`，短路径杜绝 108 字节 `sun_path` 与 NFS 故障）。
   - 持久化等待状态目录移至宿主独立状态目录（默认 `$XDG_STATE_HOME/training-monitor` 或 `~/.local/state/training-monitor`，不随 `allowedRoots` 顺序变化丢失）。
   - 自动 GC：每次操作与周期轮询自动清理超过 TTL（如 7 天）的终态 wait 记录、旧版本 sha256 worker 脚本、孤儿锁与收据，彻底消除 256 文件 `STATE_FILE_LIMIT` 自毁；放宽 `tmux` 版本正则以兼容 `next-*`/`3.4.1`；若远端无 `tmux`，支持自动降级为 `systemd-run --user` 或 `setsid` 后台托管。
   - **主机级 FIFO 协调队列**：在协调逻辑中先检查活跃 GPU 锁/保留槽位，避免多任务在同一张热身卡上同时倒计时和惊群抢锁；取消通过继承 `flock` FD 给用户训练进程来判断占用的脆弱机制（防止子进程泄漏锁），改为薄包装器（supervisor wrapper）监控子进程组退出并写入真实退出码与收据。
3. **修复报错掩盖、无限重启与离线死锁**：
   - 修复 `controller.ts`：当服务端返回错误态时不再用 `requiredIdleSeconds !== c.idleSeconds` 强抛 `SERVER_WAIT_RESPONSE_MISMATCH`，如实透传服务端结构化 `errorCode`、`params` 与日志诊断（远端 Python 全部改发结构化 code + params，移除硬编码中文文案）。
   - 为 `retryOnExit` 增加 `maxRetries`（默认 3）、指数退避与真实退出码判定（退出码 `0` 视为完成不再重启），并将 waiter 异常 traceback 写入有界诊断日志。
   - 修复 `reconcile.ts` 离线死锁：编辑/停用/删除远端任务时优先请求远端取消；若宿主当前不可达，向上层返回可恢复冲突码 `HOST_UNREACHABLE_RECONCILE`，支持用户二次确认后以 `forceLocal: true` 完成本地变更并登记 `pendingRemoteCancels`，待下次宿主重连时自动补发远端取消。

### 6. 异常检测告警、一键进程发现与受控远程作业操作

新增模块 `src/collector/alerts.ts`、`src/desktop/notifications.ts` 并扩展 `src/probe/readonly_probe.py`、`src/desktop/ipc.ts`、`src/shared/api.ts`：

1. **异常检测与告警通知引擎**：
   - 在采集器内检测以下事件（按任务+事件类型去重与冷却防刷屏）：
     - `cuda_oom`（日志命中 `CUDA out of memory` / `OutOfMemoryError`）
     - `process_crashed`（非零退出码或尾段 `Traceback`/`Segmentation fault`/SIGKILL）
     - `loss_nan_inf`（解析到 `NaN`/`Inf` loss）
     - `training_stalled`（进程存活但超过可配置阈值如 15 分钟步数零推进且 GPU 利用率长期 < 2%）
     - `training_completed`（任务完成）
     - `host_disconnected`（宿主持续断连超阈值）
   - 推送通道：内置 Electron 原生系统通知（点击通知聚焦对应任务），并支持用户可选配置 Webhook（飞书 / Slack / Discord / 通用 JSON POST，含“发送测试通知”按钮，敏感 URL 妥善存储）。
2. **只读进程自动发现（`discover_processes`）**：
   - 在 `readonly_probe.py` 新增 `discover_processes` RPC：联合 `nvidia-smi` 计算进程与 `/proc` 训练类进程，返回 `{ pid, pgid, command, cwd, gpuIndices, gpuMemoryMiB, openLogPaths, suggestedName, suggestedEntry }[]`，供前端实现“一键扫描当前运行任务并导入登记”。
3. **默认只读 + 显式开启的远程作业控制与本地终端快捷动作**：
   - 始终提供只读本地辅助动作：`openSshTerminal(hostId, command?)`（在本地系统终端拉起 `ssh -t <target>` 或 `tmux attach`）、`copyCommand(kind)`（复制 SSH / `tmux attach` / `tail -f` 命令）。
   - 仅当对应宿主的 `allowJobControl === true` 时，IPC 放行 `controlTask(taskId, action: 'stop' | 'kill' | 'restart')`（分别对应向任务进程组发送 `SIGINT`/`SIGTERM`、`SIGKILL` 或按托管命令重启），执行前校验二次确认令牌，并将每次控制动作写入本地追加式审计日志 `job-control-audit.jsonl`。

---

## 三、验收标准与必跑命令

1. **新增自动化测试覆盖**：
   - Python 探针测试：DDP 多进程树聚合、>200 FD 进程不报 `PROC_SCAN_INCOMPLETE`、日志边写边探测不触发 `eofBytes` 竞态、`python -m` / `torchrun` / `| tee` 匹配、软链接 `latest.log` 与越界软链接拒绝、目录型 Checkpoint 扫描、`discover_processes`、主机 CPU/RAM/磁盘与 GPU 型号/温度/功耗字段解析。
   - 解析器与领域测试：HF Python dict、Lightning 含 `val_loss` 行、YOLO、ANSI 彩色日志、tqdm 任意单位、自定义正则、`raw` 模式保活与 >60s 慢 step 不降级 `unconfirmed`、通用 `generic` 速率/ETA 计算。
   - SQLite v2 测试：v1→v2 迁移、`\r` 连续刷新不产生重复行且不引发 `STALE_CONTINUATION`、FTS5 搜索与正则搜索、时序读写与降采样、Worker 异常退出自动重启。
   - 自动启动测试：N-GPU 多卡触发、`gpuDeviceIds` 透传生效、任意命令+env 启动、本地 `/tmp` socket 路径、256+ 历史文件 GC 不自毁、`controller.ts` 正确透传服务端错误、`retryOnExit` 达上限停止、离线 `forceLocal` 登记待取消并在重连后补发。
   - 告警与作业控制测试：OOM/NaN/Stall 规则去重触发、默认 `allowJobControl=false` 严格拒绝远程信号。
2. **必跑验证命令（全绿通过）**：
   ```bash
   npm run typecheck
   npm run test:unit
   python -B -m unittest discover -s tests/probe -p "test_*.py"
   python -B -m unittest discover -s tests/launch -p "test_*.py"
   npm run build
   npm run test:runtime
   ```
3. **完成后提交独立 commit，再进入 Phase 3。**
