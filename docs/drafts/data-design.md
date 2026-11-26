# 训练监控器：数据与采集设计草案

状态：供主控整合与审阅的设计草案；其中数值均为可调建议，尚未测量性能。依据已确认需求和一次有限服务器快照，不代表当前实时状态。首版是 Windows 独立桌面只读监控器；不修改训练代码、不启动/停止任务、不部署远端常驻服务、不加载权重验证。

## 1. 边界与职责

Windows 桌面进程负责任务登记、轮询调度、SSH/WSL 调用、证据归一化、本地 SQLite（建议）缓存及向界面发布快照。远端只响应由桌面发起的有界只读命令：查询指定进程字段、读取已登记日志区间、读取状态文件和检查点文件元数据；不写服务器文件、不执行训练入口、不运行持续代理。复用系统已有 SSH 配置别名 `lab-campus` 与 SSH 凭据，不复制或持久化私钥、密码、令牌。

关闭窗口/进程只停止本地轮询；不向远端发送信号，不改变训练、队列、GPU 等待或 tmux 会话。SSH 超时、WSL 不可达、读取失败只改变采集状态。命令超时后不推断任务退出；错误信息不得回显凭据或完整进程环境变量。

建议初始预算（需在实现前按目标主机确认）：活跃宿主每 15 秒轮询一次进程/状态元数据；单次命令超时 5 秒，最多重试 1 次；每个日志源每轮至多读取 256 KiB，补读时每批至多 1 MiB，批间让出一次轮询机会；单次启动补读总量上限先设 64 MiB，超限暂停并显示待补读字节数。数值只用于限制负载，不承诺刷新时延或性能；后台补读低于实时轮询优先级。避免高频递归扫描目录；只查询登记路径和明确的候选输出目录。

## 2. 任务登记、归属与进程实例

每项登记包含稳定 `taskId`、显示名、宿主（WSL 发行版或 SSH 别名）、个人根目录、代码目录、允许的真实入口路径/入口模式、允许的输出目录、日志源及其解析器/算法语义。首批服务器目录按真实拼写保存：Flow `/data2/cy/xzn/Code/Flow_Matching`；Score `/data2/cy/xzn/Code/Scored-Based/score_sde_pytorch`；Reflow `/data2/cy/xzn/Code/Reflow`。路径按宿主语义规范化后按目录组件比较，不能用字符串前缀，也不能混同本地 `Score-Based` 与服务器 `Scored-Based`。登记输出仅限个人任务目录。

进程归属采用分层证据，不要求每项同时存在：已登记真实入口路径或经过验证的 cwd 是主要锚点；允许输出路径、命令参数中解析出的入口、登记日志目标、任务角色和父子关系用于补强或消歧。仅命令行偶然包含目录、共享用户 `cy`、共享 Python 环境、tmux 存在均不足以认领任务。Score 队列的 cwd `/home/cy` 不匹配代码目录时，可由真实入口位于登记 Score 目录及新鲜且内容匹配的队列状态/队列日志识别为“队列角色”，即使没有 lock 文件也不自动降级。必须区分“lock 路径存在”与“该进程实际持有锁”：只在能从进程 fd/锁元数据确认持有者时记为 `lockHeldByProcess`；文件存在本身只是弱辅助证据。证据冲突、入口解析不明或实例身份不全时标记 `unconfirmed`，保留证据及缺失原因，不强行归属。

进程实例键为 `(hostBootId, pid, startTicks)`；启动时间字段应从同一主机时钟域读取。远端重启改变 `hostBootId`，PID 复用由 `startTicks` 区分。无法取得启动标识或 ticks 时，PID 仅作短时观察线索，不得跨轮询/重连沿用为同一实例。记录父 PID 和可确认的子进程关系。训练主进程归为任务根；DataLoader、worker 等后代作为该任务资源/存活证据，不增加任务数。子进程单独持有 GPU 或特征不足时，不自动判成第二个训练任务。

首轮登记仅扫描清单明确列出的日志/状态文件和有限深度的检查点目录；不因该目录暂时无进程就删除登记。WSL 当前只有发行版可见、尚无活跃任务核验：未完成探针时宿主是 `unknown/unobserved`，不是“空闲”或“无任务”。仅当该宿主本轮连接成功、登记范围探测完成且没有匹配任务时，才可报“当前未发现登记任务”，不可扩展为整机没有其他任务。

## 3. 两组状态与证据可信度

任务生命周期与采集连接分开存储、分别展示，禁止用连接状态覆盖生命周期状态。生命周期建议取值：`running`（本轮确认匹配训练进程；如有推进日志则可信度更高）、`queued`（任务状态文件/队列日志明确等待，训练进程尚未确认）、`ready_not_training`（状态文件明确就绪且无开始训练证据）、`completed`（目标语义已达成且有正常退出或明确完成记录）、`failed`（明确失败证据）、`stalled_suspected`（进程存在但超过可调阈值没有进度，仅疑似）、`unconfirmed`（身份或状态证据冲突/不足）、`not_observed`（本轮完整探测未发现登记任务）。不可把 `not_observed` 等同 `completed`；只有明确状态文件或日志证据时才能报告完成/失败。日志停止刷新本身不证明卡死。

宿主/源连接状态建议：`connected`、`connecting`、`disconnected`、`permission_error`、`source_missing`、`unknown`。每项证据记录来源、观察时间、文件身份或进程实例键、原始值（限长并脱敏）、解析结果、可信等级及降级原因。`high`：同一宿主本轮匹配的进程实例或明确的任务完成/队列状态；`medium`：登记日志有新进度、状态记录明确但时间可能滞后；`low`：仅文件存在/mtime/锁文件或旧快照。等级是证据来源强弱，不是统计概率。

任务快照统一带 `freshness: 'fresh' | 'stale' | 'unobserved'`。`fresh` 表示当前成功探测所得状态，保留本轮 `lifecycle` 与 `statusObservedAt`；断连后若曾有观测，保留最后一次 `lifecycle` 和时间戳但设为 `stale`，前端必须标成“上次观测：运行中/排队…，时间…”，不得表述为当前状态。此前从未成功观测则为 `unobserved`，生命周期为 `unknown`。连接恢复后重新核验进程身份，并根据文件身份/offset 补读。读权限错误只将对应源置为受阻，不能据此判训练失败。检查点证据仅报告 `file_found`（发现路径/大小/mtime）、可选 `metadata_read`（实际读取了安全、轻量元数据时），首版不启用权重恢复级验证；文件存在、mtime 较新或文件大小非零均不证明保存完整或可恢复。

资源快照是数组，每条带 `scope`、`observedAt`、来源、metric 名称/单位和值。设备级记录必须有 `deviceId`；进程级记录必须关联完整 `(hostBootId,pid,startTicks)` 实例键。整卡 GPU 利用率/显存标为 `device`，不能冒充进程占用。只有数据源明确提供按 PID 的指标且进程实例映射已确认时，才填进程 GPU 显存/利用率；不能凭 PID 推断可采到进程 GPU 利用率。CPU 利用率、进程 RSS、进程 GPU 指标无法取得时为 `null`，不可用整机/整卡值替代。建议不为资源指标额外高频采样。

## 4. 进度与检查点契约

进度对象拆为独立视图，不共享一个含糊的 `unit/target/fraction`：全局完成计数视图 `{completedCount, targetCount, fraction}`；本段完成计数视图 `{sessionCompletedCount, sessionTargetCount, fraction}`；最后执行索引 `lastStepIndex` 与 step 单位定义单列。每个计数视图的分子、分母、比例、来源和验证状态独立；未知字段为 `null`，不得根据另一个视图代填。前端显示比例前必须确认该计数目标的语义，且展示分子/分母。不推导 ETA，除非另有经过说明的吞吐数据。

Flow 的已知边界是 Python 半开区间 `[start_step,total_steps)`：恢复检查点记录的零基索引 `b=checkpoint['step']=30000`，checkpoint 已覆盖索引 `0..b` 共 `b+1` 次；首次循环索引 `firstLoopIndex=b+1=30001`；目标末端 `T=200000` 不执行，续训段可执行索引 `30001..199999`，故 `sessionTargetCount=T-firstLoopIndex=169999`。若 `n` 经核验为 tqdm 已完成迭代数，则 `sessionCompletedCount=n`；当 `n>0`，`lastStepIndex=firstLoopIndex+n-1=b+n`，`completedCount=(b+1)+n`；全局计数比例 `completedCount/T`，本段比例 `n/sessionTargetCount`。当 `n=0`，`lastStepIndex` 为 `null`（checkpoint 索引仍单独保存在 resume metadata），不能称本段已经执行该索引。观察 `n≈80106` 对应最后索引约 110106、累计完成约 110107。所有公式依赖 checkpoint 与 tqdm 语义经确认；任一语义未知时对应计数/比例为 `null`。tqdm 完成次数不能直接写入索引字段。

Score、Reflow 和新增任务各自登记 `stepSemantics`、恢复基线规则、目标是索引还是计数、日志字段解析规则及验证状态；未验证时只展示原始日志进度，不换算全局累计比例。训练进度、checkpoint 文件名 step、保存活动阶段分字段呈现。Flow 保存顺序为采样后 `torch.save`，无明确成功日志；检测到文件新增/大小变化只记 `save_observed`，静止一段可调观察窗口后至多记 `file_stable_observed`，都不能标记保存成功/可恢复。建议默认观察静止窗口 3 秒，数值可调且不是原子完成保证。

## 5. 日志游标、补读与本地留存

每个登记日志源游标包括 `sourceId`、宿主 ID、规范化路径、文件身份、已提交字节 offset、最后读取/持久化时间、编码解码器状态、尾部未完成字节/行 carry 及日志代次。远端文件身份优先用设备号/inode；不可用时用创建/变更属性与大小组合并标注弱身份，mtime 单独不能作身份。offset 以原始字节计，解码端保留跨块 UTF-8 等多字节字符及未完成行的 carry；按 LF、CRLF 形成行，并把单独 CR 视为终端行重绘/覆盖事件，保留原始字节序列或可逆文本，不能把 tqdm 的回车刷新误当新行/丢失。

追加：从已提交 offset 继续读。每批原始字节 chunk、解码器 carry、未完成行 carry 与解析后事件必须在同一个本地事务中持久化；事务成功后才提交新 offset。崩溃恢复从最后事务边界继续，不能重放已提交行或跳过未提交字节。重连：若文件身份相同且当前大小不小于 offset，续读；若身份不同或大小小于 offset，开始新 generation，从新文件头按预算补读，并分别保留旧 generation。仅时间戳跳变、mtime 改变、日志中没有某段时间的行，不足以判定日志丢失。只有游标证明已读至某 offset、且同一身份内容被截断/替换导致其后字节不可得，或轮转后旧文件已不存在且无法补读时，才产生 `gap_confirmed`；若只是未访问区间/重连补读尚未完成，显示 `catching_up`，补读完成且连续则不插 gap。若无法判定，显示 `gap_unknown`/“可能缺段”，注明原因，不伪造缺口起止时间。服务器电脑离线时间段没有资源快照；仍存在的日志可补读，已轮转/删除数据不可补回。

启动补读采用旧到新有界分批并报告 bytesRead/bytesTotal（总量未知时 `bytesTotal=null`，不报伪精确百分比）；实时尾部读取优先。为免 SSH/磁盘负载过高，达到总量上限暂停补读并允许下轮继续，不跳过未读区间。日志 UI 增量包需包含 `sourceId`、generation、起止 offset、补读已读/总字节（总量可空）、完成状态及明确 gap 事件；不可只传布尔 `hasGapDetected` 而无来源证据。建议前端内存缓存同时限制最多 10,000 行、总计 8 MiB、单行 64 KiB；超限时按最旧可见缓存淘汰或截断单行并给出明确标记，不能影响磁盘游标或悄悄拼接文本。以上均为可调建议。

7 天指本机成功采集入库的缓存时间，以 `ingestedAt` 为淘汰依据；不使用日志行时间或远端 mtime 作为 TTL。建议 SQLite 每行/块保存 `ingestedAt` 和字节数，每小时清理超过 7×24 小时的数据；建议本地日志总量硬上限 1 GiB、单任务 256 MiB，并按最旧入库数据淘汰至 80% 水位。达到容量上限时先淘汰本应用缓存并记录 `cache_evicted` 区间；若仍无法写入则暂停缓存、显式报 `cache_full`，不得影响远端原始日志。上限均为可调建议。只删除应用自有缓存记录/文件，不触碰服务器日志、训练输出、模型或用户文件。

## 6. 前端最小数据契约

建议后端提供 `HostSnapshot[]`、`TaskSnapshot[]` 和 `LogEvent[]`。核心字段如下（省略 UI 样式字段）：

```typescript
type Connection = 'connected' | 'connecting' | 'disconnected' |
  'permission_error' | 'source_missing' | 'unknown';
type Lifecycle = 'running' | 'queued' | 'ready_not_training' |
  'completed' | 'failed' | 'stalled_suspected' | 'unconfirmed' | 'not_observed' | 'unknown';
type Confidence = 'high' | 'medium' | 'low' | 'none';

interface HostSnapshot {
  hostId: string; kind: 'wsl' | 'ssh'; connection: Connection;
  observedAt: string | null; lastSuccessAt: string | null;
  errorCode?: string; // 脱敏，不含凭据
}
interface Evidence {
  kind: string; source: string; observedAt: string;
  confidence: Confidence; summary: string;
}
interface TaskSnapshot {
  taskId: string; hostId: string; lifecycle: Lifecycle;
  freshness: 'fresh' | 'stale' | 'unobserved';
  statusObservedAt: string | null; confidence: Confidence;
  reason: string; evidence: Evidence[];
  processes: { main: ProcessInstance | null; queue: ProcessInstance | null;
    workers: ProcessInstance[] };
  progress: { lastStepIndex: number | null; resumeCheckpointIndex: number | null;
    firstLoopIndex: number | null;
    global: { completedCount: number | null; targetCount: number | null;
      fraction: number | null; unit: 'completed_iterations' | 'unknown';
      source: string; verified: boolean };
    session: { completedCount: number | null; targetCount: number | null;
      fraction: number | null; unit: 'completed_iterations' | 'unknown';
      source: string; verified: boolean } };
  checkpoint: { path: string | null; fileStepIndex: number | null;
    sizeBytes: number | null; observedAt: string | null;
    evidence: 'none' | 'file_found' | 'file_stable_observed' | 'save_confirmed' };
  resources: ResourceMetric[];
}
interface ProcessInstance { hostBootId: string | null; pid: number;
  startTicks: string | null; parentPid: number | null; cwd: string | null;
  scriptEntry: string | null; role: 'trainer' | 'queue' | 'worker' | 'unknown'; }
type ResourceMetric = { observedAt: string;
  name: 'gpu_utilization' | 'gpu_memory_used' | 'gpu_memory_total' |
    'cpu_utilization' | 'process_rss'; unit: '%' | 'bytes'; value: number | null; } &
  ({ scope: 'device'; deviceId: string; processKey: null } |
   { scope: 'process'; deviceId: string | null;
     processKey: { hostBootId: string; pid: number; startTicks: string } });
interface LogEvent {
  taskId: string; sourceId: string; generation: string;
  kind: 'line' | 'gap_confirmed' |
    'gap_unknown' | 'catchup' | 'cache_evicted';
  startOffset: number; endOffset: number; ingestedAt: string;
  catchupBytesRead: number | null; catchupBytesTotal: number | null;
  text?: string; // gap 类事件附 reason，不生成虚构时间戳
  reason?: string;
}
```

例：SSH 断开时 `{connection:'disconnected'}`，任务保留最后 `lifecycle` 与 `statusObservedAt` 并置 `freshness:'stale'`；从未观测则 freshness 为 `unobserved`、lifecycle 为 `unknown`。WSL 尚未探测也不是空闲。Score cwd 不匹配时可依据登记入口与新鲜队列状态确认为 queue；lock 文件不存在不单独导致降级，文件存在也不等于进程持锁。GPU 整卡读数必须 `scope:'device'` 并带 deviceId；进程指标关联完整实例键。补读正常时有 `catchup`，不能产生缺口事件；超时显示源错误，不能推进 offset。

与窗口草图对齐：沿用 `hostId`、任务名/算法类型、生命周期+连接分离、进程/PID、累计与本轮双视角、检查点与日志流、补读进度。需要在正式设计合并时改正草图中“离线时远端仍运行、数据未丢失”的断言；将证据抽屉中的全部环境变量替换为白名单进程字段，禁止呈现环境变量；空任务需限定为“该宿主本轮已连接且登记范围探测完整，未发现任务”，不能用于未观测 WSL。`completed`、`stalled` 等状态应按本草案证据门槛收紧；检查点等级不包含首版权重验证。资源列表需带 scope/deviceId 或完整 processKey、指标单位和 nullable 字段。日志事件需含 sourceId、generation、offset、catchup 字节数及事务性游标语义；补读不代表缺失。

## 7. 模拟验收场景

1. **归属与 PID 复用**：Score 队列 cwd 为 `/home/cy`，入口和新鲜队列状态属于已登记 Score 目录，应归为 queued；缺 lock 不自动降级，若 lock 文件存在但未确认持有者也不能声称实际持锁。模拟相同 PID、不同 startTicks/bootId，旧实例不能延续。
2. **WSL 未观测与断线**：启动时 WSL 探针未成功，显示 `freshness=unobserved/lifecycle=unknown`；SSH 曾观测后断线，显示 `freshness=stale` 并保留最后 lifecycle 与时间。不得报空闲、当前仍运行或“数据未丢”。恢复后先重新认领进程，再恢复采集。
3. **日志正常补读及轮转**：停采期间文件仍在且身份一致，分批补读后 offset 连续，不出现 gap；之后同一路径被截断/替换，建立新 generation，只有能证明已确认区间不可恢复时报告 gap。
4. **进度边界与 checkpoint**：用 Flow 的 `b=30000,n=0`、`n=1`、`n=169999` 验证索引和完成次数边界；tqdm 数不能直接填入索引字段。只出现 step100000 文件时仅报 file_found；保存期间异常变化不报成功/可恢复。
5. **资源范围与容量**：设备级 GPU 快照不归属具体训练 PID；达到缓存字节上限时只淘汰应用缓存并留下 eviction 事件，远端文件不变；行数少但单行极大时仍被字节上限拦住。

## 8. 实施前仍需主控确认的项目

首轮日志导入起点/历史量上限、缓存容量（默认总 1 GiB、单任务 256 MiB）、刷新与命令预算、首次安装对 SSH 配置的使用方式、具体 SQLite 存储位置和产品 UI 如何呈现仅“最后观测”状态，需在完整设计中统一。各训练算法的 step 单位和完成判定须按源码/日志分别核验；这份设计不把尚未验证的 Score/Reflow 规则写成事实。桌面技术栈属于后续选型，不影响本数据契约。
