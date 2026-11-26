# 训练监控器 v1：统一设计

日期：2026-10-18。版本：r2。状态：DeepSeek 对 r1 提出的4项阻塞已修订。新的 Luna 独立 r2 检查为 Approved（`docs/reviews/revision-r2-review.md`）；DeepSeek r2 复核也为 Approved（`docs/reviews/design-review-r2.md`），四项原阻塞已闭合，未发现新阻塞。用户随后回复“确认，暂时按这样处理”，已确认完整 r2 与暂行默认值。主控已制定 `docs/superpowers/plans/2026-10-18-training-monitor-implementation.md`，待用户核对实施计划后执行；审查结论不是实际环境测试通过或已交付产品。非阻塞建议交接见 `docs/reviews/design-review-response.md`。

本文是后续实施计划的唯一设计依据。`docs/drafts/data-design.md`、`docs/drafts/window-design.md` 保留为作者草案；其中不同的枚举、预算、示例、主题建议以本文为准。需求和历史实证见 `docs/requirements-and-evidence.md`。2026-10-18 20:30—20:31 的观察不是当前实时状态，产品初次启动不得将这些 PID、步数或状态当成实时数据。

## 1. 目的、范围与成功标准

在这台 Windows 电脑上打开一个独立桌面窗口，集中查看已登记的 SSH Linux / WSL 训练任务。主要工作是可靠识别自己的任务、展示有证据的进度、保留与补读日志，并明确显示信息的来源和新鲜度。

首版包括：个人任务登记；多宿主任务列表；状态、进度、检查点文件与资源读数；多源日志查看、文字搜索、复制、滚动锁；断线重连、停采后补读；本应用本地日志最多 7 天的缓存。

首版不包括：启动/停止/重启训练、改变排队或占卡、管理 tmux、自动修复训练、训练代码埋点、权重加载验证、服务器常驻采集器、云服务、账号系统、手机访问、日志上传、历史资源曲线。任务登记只改变本机监控配置。

成功标准：能在模拟场景与随后获授权的有限只读实测中正确区分 Flow 训练、Score 队列、Reflow 就绪记录；未知信息不填造数值；重开后按持久化游标补读仍可得的日志；关闭监控不向训练发送任何控制动作。

## 2. 主控合并裁决

| 项目 | v1 决定 | 依据与边界 |
| --- | --- | --- |
| 窗口布局 | 用户选定的 A：左侧宿主/任务，右侧详情和日志 | B 仅留作探索记录，不开发第二套布局 |
| 主题 | 初始跟随 Windows；设置内可手动浅色/深色 | 主控默认值，不声称用户偏爱任一主题 |
| 桌面技术 | Electron + TypeScript；React + Vite 视图；SQLite 本地缓存 | 主控提案，纳入完整设计确认；版本与 SQLite 绑定在实施计划锁定 |
| 首次日志导入 | 每个已登记日志源从当前尾部最多 5 MiB 开始 | 不是全量历史；标注未导入前缀，不称为日志丢失 |
| 后续重开 | 从已提交游标继续，不再套用首次 5 MiB 限制 | 受远端可得性、读取预算、本地 TTL/容量限制 |
| 读取节奏 | 日志每 5 秒；进程/状态/资源每 15 秒 | 可见延迟还受训练输出缓冲、网络和积压影响 |
| 补读 64 MiB | 每宿主每轮追赶窗口的额度，耗尽后让出至少 15 秒，再自动继续 | 不是本次启动只能读取 64 MiB，不需重开或手动解锁 |
| 检查点证据 | 仅 `none / file_found / file_stable_observed` | v1 不读权重内部元数据；不保留 `save_confirmed`、`save_observed`、`metadata_read` 枚举 |
| 日志留存 | 从本机成功入库时间起最多 7×24 小时 | 旧远端日志今天补入后也从今天计时；容量淘汰可更早发生 |

本机只读环境检查可找到 Node.js、OpenSSH 和 WSL 命令，PATH 中未找到 Rust 工具链；这不证明其他位置未安装 Rust。选择 Electron 是为首版保持 TypeScript 技术路径，避免把 Rust 工具链作为前置任务。代价是随应用分发浏览器运行时，实际包体、CPU/内存要测量，不承诺轻量数字。Electron 的主进程/渲染进程划分与隔离要求参照 [进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[上下文隔离](https://www.electronjs.org/docs/latest/tutorial/context-isolation) 与 [安全指南](https://www.electronjs.org/docs/latest/tutorial/security)；这些资料支持平台能力，不构成本应用性能保证。

## 3. 架构与生命周期

```text
Windows 独立窗口：React 视图（只消费快照、日志分页、固定操作）
                         │ 窄化、校验的 IPC / preload
Electron 主进程：配置、窗口、订阅、采集调度与 SSH/WSL 传输
                         │ 有界消息
后台数据工作线程：日志解码/解析、状态归一化、SQLite 事务与搜索
                         │
ssh.exe / wsl.exe：短时只读探针 → 已登记任务的 Linux 文件与 /proc
```

视图无 Node 权限，`contextIsolation=true`、`nodeIntegration=false`、渲染沙箱开启，只加载应用打包的本地内容。日志按纯文本渲染，ANSI 仅解析有限颜色/回车语义，不执行 HTML、链接、控制命令或 OSC 剪贴板操作。不把 `ipcRenderer`、任意 shell、任意路径读取接口暴露给视图。禁止远程页面导航和日志触发的新窗口；不建立产品 HTTP 服务或公网监听。

主进程持有任务配置与传输权限；工作线程持有数据库，禁止同步大查询堵塞窗口线程。IPC 操作限定为读取快照、按任务/源分页或搜索缓存、订阅/取消订阅、立即刷新、保存登记/偏好、复制已验证路径。固定操作均校验调用来源、ID、长度、分页与数值范围，后端从登记 ID 找路径，不接受视图提交任意命令或临时路径。

首版只有一个应用实例和一个主窗口；关闭窗口即退出监控，无托盘常驻、自动开机或远程后台代理。退出时停止计时器，结束自己创建的有限探针/传输子进程，提交或回滚本地事务；绝不按登记 PID 发送信号。远端训练/队列不是应用子进程。崩溃或电脑关机只终止采集；远端当时是否存活需要重连观测。

开发和正式安装均使用同一配置模型。发布目标为 Windows x64 本地可运行包；无需用户另外启动 Web 服务。安装器、代码签名、自动更新不属于 v1 必要功能；包内自带 Electron 运行时，OpenSSH/WSL 是宿主能力。最终包在这台电脑上验证后才称可运行。

## 4. 配置、采集范围与传输

### 4.1 登记

初始本地配置提供服务器 `lab-campus` 和三个任务的已核验路径模板，首次运行显示供核对；不预填活跃 PID 或实时状态。启用已登记宿主后自动只读采集。WSL `Ubuntu-26.04` 初始没有已确认训练任务，显示未观测/尚未登记任务；不能把 `D:\Learning\Paper\GLM` 的 Windows 路径直接当 Linux 运行路径。

配置面板可增改/停用监控登记：显示名、宿主 ID、SSH 别名或 WSL 发行版、个人允许根、任务代码根、真实入口清单、状态文件、日志源、检查点候选目录与允许的轮转文件名模式、解析器 ID。保存后校验重复 ID、路径边界和格式，错误不启用。停用登记仅停止采集；UI 明示其作用。v1 不开放用户自定义探针命令、任意正则执行或训练脚本执行。

首批任务根和源路径沿用需求证据中的绝对路径。尤其服务器为 `Scored-Based`，不得按本地 `Score-Based` 拼写替换。所有文件源、轮转源和检查点扫描均需在已登记的规范化目录内；不递归扫描个人根，更不扫描整个共享盘。

### 4.2 SSH / WSL 探针

SSH 复用 Windows OpenSSH 的现有别名/agent/已知主机设置，不保存密码或复制密钥。使用无 PTY、非交互认证；认证、未知主机密钥或主机密钥变更显示连接设置错误，由用户通过现有 SSH 配置处理，不绕过校验或弹出密码收集表单。不修改 SSH 配置。

WSL 先查看运行中的发行版；仅对已运行且登记的发行版执行有限探针，不为了后台监控自动启动已停止的发行版。停止的 WSL 显示宿主不可达，任务保留历史观测或未观测；不显示空闲。发行版首次是否存在与是否运行分别记录。

Linux 端首选系统 `/usr/bin/python3 -I -S -B` 执行应用内固定、可审查的有限探针，经 stdin/严格编码参数接收白名单请求。不部署脚本文件、不导入训练库或用户模块、不生成 pycache、不安装依赖；文件只以只读方式打开。探针读取 `/proc` 允许字段、固定文件区间、状态 JSON 白名单键和文件系统元数据；可选调用存在的 `nvidia-smi` 只读查询。缺系统 Python 或指标能力时显示能力缺失，不能偷偷安装或切换到不受控命令。

Windows 以参数数组创建 `ssh.exe / wsl.exe`，不经本地 shell 拼接；SSH 远端固定命令中的请求只能使用经过校验的编码载荷，路径不直接插入 shell。响应有协议版本、请求 ID、长度和错误码；stdout/stderr 都有界，超过上限终止该探针并显示采集错误。命令未完成、超时或格式异常的结果不能提交游标。

Linux 路径按 realpath 和目录组件比较，处理符号链接后仍需属于允许根；读取时验证已打开文件的身份与位置，避免校验和打开之间替换文件的竞争。链接逃逸或目标身份不稳定则拒绝本批，不追踪到其他人的目录。缺文件用已校验父目录与登记 basename 判断，不把不存在的路径视作越权读取许可。

### 4.3 进程归属

以真实脚本入口（按解释器参数位置解析）、解析器支持的模块入口，或已核验 cwd 加相符任务角色/输出证据建立任务归属。命令行中偶然出现个人路径、同用户名、同 Python 环境、同 GPU 或 tmux 会话均不充分。无法确定入口且仅 cwd 相符时保留待确认，不擅自归入训练。

发现阶段可短暂枚举最小 `/proc` 身份字段以筛选候选；其他任务的原始命令行/详细字段不持久化、不显示。只向本机返回已匹配或与登记路径有关的有限证据，禁止获取环境变量、系统日志、组员日志。扫描达到时间/数量上限必须返回 `scanComplete=false`，不能据此报告“没有任务”。

进程强身份为 `(hostBootId, pid, startTicks)`；缺任一启动标识则为弱证据，不跨轮询认领同一实例。多次读取需验证实例未变化。已确认主进程的 DataLoader 后代合并为 workers，不增加训练任务数；后代关系也需以实例键重验，不能只凭父 PID 复用。

Score 的 cwd 为 `/home/cy` 不妨碍其真实入口位于登记 Score 根时识别为队列。已确认的队列实例加匹配的当前等待记录可判 `queued`；lock 非必要条件。统一使用 `queueLock.exists` 与 `queueLock.heldByRegisteredProcess`，后者允许 `null`；锁信息自带来源、观测时间和新鲜度。只有内核锁记录及进程/文件身份等确证才报告持锁；打开过该文件的 fd 不证明持锁，不试图获取锁进行测试，不虚构持锁开始时间。

状态文件必须按允许键解析，保留其自身时间/实例关联证据；“本轮读取成功”不等于旧状态内容代表当前。无活跃进程关联的 `ready_not_training` 仅作为就绪记录、可信度降级并标注记录时间。新旧状态与进程冲突时 `unconfirmed`。

### 4.4 训练运行标识与日志关联

`runId` 只标识一次已确认主训练进程实例，不标识任务登记、监控器启动次数或日志文件。后端按 UTF-8 规范 JSON 数组 `[hostId,taskId,hostBootId,pid,startTicks]`（固定位置与类型，整数规范表示）计算 SHA-256，得到 `run:v1:<hex>`；缺强身份、角色未确认或只有 queue/workers 时不生成。任务快照 `currentRun` 保存 ID 与主进程键。监控重开且强键相同则 ID 相同；主机 bootId 或 startTicks 变化即新 ID，即使 PID/路径未变。单纯日志轮转、截断或 generation 改变不新建训练 run。

进程身份与日志字节归属是两种证据。仅凭同路径、mtime、类似计数、同 GPU、checkpoint 名称或进程仍存活，不把旧日志归给当前 run。首次识别 run 时，某源已有的 `[generationStart,observedEOF)` 均标为未关联历史，读取游标照第6节执行，不能为了建立 run 关联而跳过原始历史。

每条绑定记录指定 `runId / mainProcessKey / sourceId / generation / [fromOffset,throughOffset) / evidenceKind / observedAt / observerEpoch`。v1 允许两类有限证据：①已有结构化启动/状态记录带完整实例关联，并由登记解析器确认其指向的运行和字节范围；②解析器确认是训练输出，且只读检查到该主进程直接以可写 fd 指向登记日志，在连续观测窗口前后强键、目标文件和写入关系不变，将两次 EOF 间新增的完整记录归给该 run。只打开文件、只见新增字节或间接 tee/未知转发不能满足②；缺权限时降级，不读取全部 fd 内容或其他任务详情。不声称此有限证据能排除一切共同写入者，发现混写/矛盾即撤销该段归属并置待确认。

观察窗口初次从当时 EOF 开始；开始前已存在的字节、跨窗口边界的半条记录不追认为该 run。断线、应用重开、主进程身份变化或源连续性破坏即关闭窗口，不跨停采区间自动关联新字节；重连后先重验实例，以当前 EOF 开新窗口，再从后续完整记录取证。`observerEpoch` 是每次连续观察会话的本地 UUID，不参与 runId；同一 run 可有多个观察窗口和日志代次。历史绑定保留为证据；新代次不得继承旧代次的有效区间。无法关联的补读日志照常可看，原始记录不因不能换算进度而丢弃。

`Progress.runId` 只在其输入属于当前 run 的可验证记录/字段时填写，不等于已知 `currentRun` 就能填写进度。新 run 建立或身份不明时，当前进度清空：runId、恢复基线、索引、global/session 计数、比例、速率及 ETA 均为 null；配置目标只在 `configuredTarget` 单列。旧 run 的快照保留在历史证据中，不拷贝到当前进度。同一强键重开可显示此前已绑定的同-run进度，但必须 stale、注明原观测时间，不能用停采期间未关联字节刷新它。

后续可关联记录若仅支持本段完成数/目标，可填经单独验证的 session；缺当前 run 恢复基线则 resumeCheckpointIndex、firstLoopIndex、依赖它的全局完成数/比例和 Flow 推导的 lastStepIndex 保持 null。只有该 run 的启动/恢复证据确认基线，且计数语义已验证，才启用第5.2节公式；旧 run 的基线、checkpoint 文件名或旧启动行均不足。日志直接明确给出索引时可独立显示该索引并标来源，不把本段 n 当索引。速率需要至少两个同 run、同连续观察窗口、可关联且有推进的新鲜样本；ETA 另需同 run 的有效目标。离线时同一个实例仍存在，不证明停采期间所有日志都属于它。

## 5. 状态、进度、检查点与资源

### 5.1 状态规则

宿主连接、任务生命周期、字段新鲜度、单源读取状态分别表达。宿主能连接但一个文件缺失，不得把整个宿主改成断开。

| 生命周期 | 最低证据/显示规则 |
| --- | --- |
| `running` | 本轮确认与任务匹配的训练进程；显示“训练进程存在”，有新进度时补充推进证据，不保证算法正常 |
| `queued` | 已确认队列身份及相符等待记录；训练进程未确认；未知持锁不阻断识别 |
| `ready_not_training` | 对应状态记录明确就绪、无训练启动证据；保留记录时间，不声称已核验可启动 |
| `completed` | 解析器已验证的明确完成记录，且与任务/本次运行吻合；进度条到 100% 本身不足 |
| `failed` | 与本次运行关联的明确非零退出记录/结构化失败终态；Traceback、单独进程消失均不足 |
| `unconfirmed` | 身份/状态冲突；进程消失但无退出结果；扫描不完整无法判定 |
| `not_observed` | 宿主本轮成功、登记范围扫描完整，未发现活动任务且无其他有效终态证据；不是成功或空闲保证 |
| `unknown` | 从未得到可用观测 |

不增加 `stalled` 生命周期。日志长时间不更新仅显示“已 X 分钟无新日志”的事实提示；采样/保存阶段只在明确日志证据下显示，整卡 GPU 为零也不能单独推断个人任务卡死。

`fresh` 表示该状态有最近一次成功完整探测依据，并不保证业务正常；`stale` 保留最后观测并必须加“上次观测”文案；`unobserved` 表示从未成功。启动缓存一律降为 stale；失败或超过该数据采集周期两倍未成功则降 stale。各资源、进度、检查点和日志另带自己的观测时间及新鲜度，不随“宿主在线”自动全部变 fresh。

断线显示：“连接中断；上次于 [时间] 观测为 [状态]；当前状态待重连确认”。连接与状态时间取本地接收时间；远端时间单独标来源，不用未经校准的远端时钟与本地相减来断言新鲜。

### 5.2 Flow 的计数语义

恢复索引 `b`、首循环索引 `f`、最后执行索引 `lastStepIndex` 与完成次数分开。仅在已确认 checkpoint 的 step 是零基已执行索引、循环为 `[b+1,T)` 且 tqdm 的 `n` 是本段完成迭代数时，才使用：

```text
f = b + 1
sessionTargetCount = T - f
sessionCompletedCount = n
lastStepIndex = n > 0 ? f + n - 1 : null
completedCount = f + n
globalFraction = completedCount / T
sessionFraction = n / sessionTargetCount
```

历史证据示例（不是实时数据）：`b=30000,T=200000,n=80106` 对应 `f=30001`、本段 `80106/169999≈47.12%`、最后索引 `110106`、累计完成 `110107/200000≈55.05%`。这是循环迭代计数，不额外声称等于优化器更新次数。checkpoint 内容未读取，恢复基线来自已核验配置/启动日志及源码语义，需保留证据来源，不能仅凭文件名启用公式。

`n=0` 时最后索引为 null；`n=169999` 时累计为 200000、最后索引 199999；无效范围、语义未核验或新进程无法关联旧日志时，派生字段为 null，仍可显示原始观测。不得夹到 100% 掩盖语义错误。

Score/Reflow 当前仅显示恢复点/配置目标与原始日志，实时累计比例为 null；不得套 Flow 偏移。新增算法需独立解析器及边界样例。速率与 ETA 只有在同一已关联运行、单位/时长可核验、样本有推进且新鲜时才提供；ETA 标“估计”，采样、补读旧日志、断连或来源过期时留空。不将补读吞吐当训练速率。

### 5.3 检查点与资源

检查点仅读指定候选目录下受限数量的目录项、名称、大小、mtime、文件身份；达到扫描上限显示结果不完整，避免声称发现了全目录最新文件。`fileStepIndex` 仅当解析器已知名称语义时赋值，保留 `stepSource='filename'`，不能当内部权重 step。

`file_found` 表示发现文件；`file_stable_observed` 表示同一文件至少两次成功观测、间隔不少于 15 秒且大小/mtime 未变。变化后退回 file_found。稳定不等于保存完成、原子写入或可恢复；v1 不调用 torch.load、不读 pickle 或模型内部字典。界面写“文件名标记索引…；文件已发现/多次观测未变化”，不写“已确认保存到…”。训练索引与文件标记索引差异只称“索引相差”，不当作可恢复训练成果。

整卡 GPU 利用率/显存带设备 ID 和 `scope=device`。进程显存仅在数据源按 PID 提供且实例映射前后稳定时填 `scope=process`；无法可靠映射则 null。CPU 百分比采用单逻辑核 100% 口径，允许大于 100%，UI 注明；RSS 为该进程驻留字节。默认不把主进程与 workers 的 RSS 相加为“任务独占内存”，以免共享页重复；进程列表可分别查看。进程 GPU 利用率缺能力时为 null，绝不用整卡值替代。历史资源不回补。

## 6. 日志、续读与缓存

### 6.1 首次与再次打开

所有原始字节区间统一为半开 `[startOffset,endOffset)`，end 不包含在区间内；offset 不是字符数或行号。无游标的首次导入：固定本次文件身份、generation 和 EOF `E`，令 `S=max(0,E-5MiB)`，新代次的 `generationStartOffset=S`、初始 `committedOffset=S`、`maxObservedOffset=E`。此时 `[S,S)` 是空区间，不声称已导入任何字节。之后完整保存 `[S,E)`，不向 S 前找行首，也不因显示行边界跳过 S 后的字节。

`S>0` 时保守将第一条显示为“首段可能不完整”，即使 S 偶然正好在行首也不假定已证明完整；首个换行前的字节全部入库并限长展示，首个边界后恢复正常行。没有边界也分块保存原字节，持续限长展示该不完整条目。单独记录 `import_boundary`：`[0,S)` 未导入，不是 gap_confirmed。显示截断、非法 UTF-8 替换、ANSI 去除均不改变原字节范围或游标。首次追赶分母固定为 `E-S`，分子是本代次已成功提交范围与 `[S,E)` 的交集长度；后来追加不改分母。v1 不提供一键全量历史导入。

例：`E=104857600`（100MiB）、`S=99614720`（95MiB），第一个 LF 位于 `S+200`；首条范围为 `[S,S+201)`，201字节全部保存，下一条从 `S+201` 开始。全部提交后 `C=E`，重开只从 E 续读；原始 `[0,S)` 标首次未导入，不能标远端丢失。

已有游标重开：从最后事务提交的 offset 继续，重新核验进程与日志文件。补读旧到新、同一源不跳到尾部、不用首次限制截断停采期间的积压。进度与资源探测可继续刷新；尚未追到新日志时明确标“日志正在追赶，进度基于较早日志”，不伪装日志已实时。

多个源按宿主轮转调度，不能让 Flow 大日志饿死 Score 队列或主机状态。补读到本次目标 EOF 后标“这一停采区间已补齐”，再按普通节奏读取后续追加。不存在逐行时间戳时只报告已补字节/源状态，不编造离线期间的日志产生时间。

### 6.2 身份、竞争与断点

每源内部保存 `CursorState`：dev/inode（可得时）、独立的 generation UUID、`generationStartOffset=G`、`committedOffset=C`、`maxObservedOffset=H`、内容锚点、有限解析状态和事务 revision。C 表示 `[G,C)` 的原字节曾连续成功入库（之后可按 TTL/容量淘汰），不是“完整行结束位置”；H 是经连续性校验、确定属于该代次的最大已观测 EOF，不能将可疑新内容的大小算进旧 H。无文件身份时标弱证据，不能只凭路径/大小沿用游标。mtime 单独不能作身份。

每批打开并验证登记文件，读取前后 fstat。锚点至少覆盖此前确认的文件前缀最多4KiB和 C 前最多4KiB的已提交尾段，记录明确的字节范围和摘要；首次仅导入尾部时，额外的前缀采样只作身份元数据，不入用户历史、不扩大5MiB导入范围。只比较旧代次已观察且仍应存在的同范围；正常尾部追加导致的 size/mtime 增长本身不算不连续。弱身份必须同时校验可用锚点及其他稳定属性，证据不够走下述 reconcile。快速同inode覆盖后若全部采样内容恰好相同，仍可能检测不到；不承诺证明全文件连续。

正常接受的 chunk 必须满足 `startOffset=C`，结束于 `D=C+实际读取字节数`，且读取前后身份和应保留锚点通过校验。以原子 compare-and-swap 校验数据库当前 generation/revision/C 仍等于请求时的值，将原始 `[C,D)`、解析事件、有限 UTF-8 carry/当前行状态及新 C=D 在同一事务提交。重复或迟到响应的起点若已不等于当前 C，不再按新 chunk 插入：完全已提交的响应丢弃，部分重叠的响应作废并从当前 C 重取。仅靠 `(sourceId,generation,startOffset,endOffset)` 唯一键不足以处理重叠范围，仍须上述连续追加条件。事务失败不推进 C；原字节已入库且解析状态已提交时，即便尚无换行也可推进 C。

LF 和 CRLF 的分隔字节属于该条目的源区间，显示文本可移除分隔符。跨批 CR 暂存 `pendingCR`，下一字节为 LF 时组成一个 CRLF；否则将该 CR 终结为重绘，再处理下一字节。待判 CR/半个 UTF-8 字符的有限状态与游标一起持久化，临时预览不当已终结新行。单独 CR 重绘当前逻辑行，保留原始区间；ANSI 仅改变展示。UTF-8 非法序列标异常、显示替代字符，不猜其他编码。未完/超长行按原始块入库；展示条目以 `(sourceId,generation,recordStartOffset,kind)` 稳定 ID 更新而非每批重复追加，带 recordComplete/prefixIncomplete，单条显示遵守64KiB，隐藏尾部不无限缓存。

**代次状态转换（包括同 inode copytruncate）：**

| 当前/检测 | 必须执行的转换 |
| --- | --- |
| `tracking`，身份与锚点连续 | 按 C 继续；只追加、提交成功后推进 C |
| 文件身份变化、size<C、已观察前缀/尾锚点不匹配，或弱身份无法确定连续 | 进入持久化 `reconciling`；保留旧 generation 的 C/H/carry，丢弃本次可疑 payload，禁止从旧 C 接受当前登记文件的新内容，即使新 size 已长回 C 以上；仍允许下一行所述旧归档续读 |
| 只读查登记轮转候选，找到与旧身份/旧内容锚点及轮转规则相符的旧数据 | 仍在旧 generation 从旧 C 有界续读到能确认的旧 EOF；归档身份可以因 copy 而不同，但不能只凭同文件名认定。补全后形成待封存决定，不产生缺失 gap；封存与新代次创建在下述同一事务完成 |
| 旧数据不可得，或检查预算/范围不足以确认 | 形成待提交的旧代次封存及 gap_confirmed/gap_unknown 决定，不单独切换游标；不可把“不完整扫描”当确认丢失 |
| 旧代次可封存，当前登记文件可读且稳定 | **单一事务**写入旧代次封存/缺口（如有）、新 generation UUID、切换原因/时间、新 `G=C=0`、新 H、清空新代次解析carry；新代次不继承旧run绑定，历史绑定保留。事务失败仍为 reconciling，不允许只改游标。新文件从0分批读取，不套首次5MiB策略，不继承旧 C |
| 当前登记文件缺失/权限错误或新内容本身不稳定 | 保持 reconciling 和源错误，按源退避；不提交新代次或跳过源字节；其他源继续 |

同一 dev/inode 不能阻止上述换代；generation 的意义是可连续解读的内容代次，不是 inode 的别名。reconciling 恢复后重复上述幂等步骤；转代前崩溃恢复旧游标，转代事务后崩溃恢复新 C=0 或已提交的新 C，不能混合新旧解析状态。旧代次已补齐而新文件正在读取时表示“已衔接轮转”，不伪称所有新日志也已补齐。

`gap_confirmed` 需要同时有①此前已记录旧代次的具体未提交区间 `[C,H)` 且 H>C，②完整检查允许候选后确认其中某段客观不可得。只报告能证明的半开区间；允许候选已全部检查也不声称遍查服务器其他路径。无法确认曾有未读字节、归档去向不明或检查未完成，记 `gap_unknown`，offset未知为null。事件归属旧 generation；新代次有独立 generation 转换标记，不能用旧 offset 去重新代次原字节。时间跳变、停采、mtime变化以及完整补读的轮转不产生缺失事件，不捏造时间跨度。

例1：旧 C=8MiB、旧 H=10MiB；同inode截断后又长到10MiB，旧锚点不符且旧区间确认不可得。旧代次报告 `[8MiB,10MiB)` 的 gap_confirmed，新代次从0读取；不能直接读新文件的8—10MiB而跳过前8MiB。例2：旧 C=H=8MiB，同样观察到重写后10MiB；没有证据证明旧8MiB之后曾有未提交数据，只能 gap_unknown，新代次仍从0。例3：旧8—10MiB可从登记的归档完整续读，则无gap，新文件仍须用新代次从0读取，按generation区分而非跨代字节去重。

### 6.3 本地留存、空间与背压

配置与缓存存于 Electron 用户数据目录的独立应用子目录；不写项目/训练目录。配置、偏好、游标、代次和少量最近快照作为监控元数据保留至登记移除；原始日志及其解析索引/事件按成功入库 UTC 时间 `ingestedAt` 最多 7 天保留。补读的旧日志从本次入库起计时，和远端真实产生时间不是一回事。

启动及入库清理顺序固定：先按 TTL 删除过期日志及其全文索引，再计算保留内容容量、执行下述容量淘汰，最后校验磁盘空间和本批写入预算。运行中每分钟清理，所有查询还过滤已过期记录。程序关闭期间不运行清理；再次启动时先清理，不能显示已过期数据。原始块与对应事件一起淘汰，不能保留全文搜索副本超过 TTL。

原始日志有效载荷预算：全应用 1 GiB、单任务 256 MiB，触顶按最早入库淘汰至对应上限的 80%；这是日志内容预算，不声称 SQLite 文件、索引、WAL 和整个应用包合计只有 1 GiB。物理磁盘占用另行展示、限制 WAL 增长并测量。前台明确“最多 7 天，容量不足时可能更早清理”。缓存淘汰显示 `cache_evicted` 与可知的字节范围，区别于远端 gap；不自动重新下载已淘汰的区间。

可用磁盘不足 128 MiB、数据库写失败或无法在预算内继续时暂停该源入库和读取，显示 `cache_full/storage_error`，游标不前进；状态/资源仍可采。清理仅作用于本应用缓存表/目录，禁止删除远端或用户训练文件。原始字节在 TTL/容量内保留，不承诺全部远端历史永远可见。

前端日志缓冲最多 10,000 个展示条目、8 MiB UTF-8 文本有效载荷、单条 64 KiB；三者先触顶者生效。8 MiB 不是 JS 堆总内存保证。超长条目显示截断标记且不无限保留隐藏字符串，原始块保留在磁盘。分页旧日志替换缓冲而非无限追加；滚动锁不阻止后台持久化或有界淘汰，阅读位置被淘汰时提示并允许从本地保留缓存重查。

### 6.4 预算与错误隔离

| 项目 | 默认预算 |
| --- | --- |
| 普通日志轮询 | 每源 5 秒，每批每源最多 256 KiB；同宿主调度合并/轮转 |
| 身份/状态/资源/检查点 | 15 秒；检查点稳定判定也按两次成功观测 |
| 缺失但预期将生成的日志 | 源 missing，30 秒重查；不报任务失败 |
| 补读批次 | 最多 1 MiB 原始字节；每宿主至多 1 批/秒，单一 in-flight 探针 |
| 追赶窗口 | 每宿主累计 64 MiB 后至少让出 15 秒，再自动继续；优先到期的状态轮询 |
| 单命令 | 5 秒超时，原始日志响应封装后至多 2 MiB，stderr 至多 64 KiB |
| 宿主失败重试 | 已确认传输/认证失败只更新宿主 retryAt，退避2、5、15、30秒并封顶；该宿主请求等待，其他宿主继续 |
| 单源失败重试 | missing/permission按该源30秒重查；read/timeout/protocol错误按该源2、5、15、30秒退避，其他源与宿主元数据不继承 retryAt |
| 状态 JSON | 单文件最多 256 KiB；超限显示源错误，不读完整文件 |

错误分类按请求阶段和结构化错误码执行：SSH建立连接/握手/认证被拒、连接明确断开、WSL发行版停止等为 `scope=host`；宿主已经应答而单文件 missing/permission/read、单指标缺能力等为 `scope=source`（非日志模块使用自己的采集单元ID）。日志与状态源分项返回结果，一个源出错不能将已成功的其他源一并丢弃。

没有阶段证据的单次命令超时不直接宣称宿主断开：只失败当前请求/源，保持宿主上次连接观测并按时间降 stale，插入一个独立有界的轻量宿主探测。该探测成功则保持 connected，只让失败源退避；该专用探测也失败时将宿主置 disconnected/探测失败并启用宿主退避，不能把请求超时写成训练失败。宿主探测成功重置宿主失败计数；某源成功只重置其自己的失败计数，不清除其他源退避。

每宿主仍最多一个 in-flight：到期的身份/状态/资源采集优先于日志重试和补读，当前日志命令最多占用5秒，结束后先服务已到期元数据，不能在元数据到期时连续派发日志重试；一个坏源可以造成最多本次有界请求的等待，不能获得整个宿主的退避锁。立即刷新只合并有界请求，不能突破并发/字节预算或源隔离。元数据扫描分批续查并带 completeness；单个状态文件错误不使进程扫描结果等于完整未发现。所有数字为待实测的工程默认值，不保证零开销、固定刷新时延、恢复耗时或常驻内存。

## 7. 窗口与交互

A 布局基准约 1280×800、最小 960×600。顶栏显示各宿主连接、最后成功探测与手动刷新；探针耗时称“上次探测耗时”，不当作纯网络 RTT。左侧约 280 px，按宿主列登记任务及状态/新鲜度；右侧选中任务上方呈现累计/本段进度、最后日志观测与检查点文件索引、资源范围，下方为可切换日志源的日志区。宽度不足时收折左栏并提供任务选择器，不开发布局 B。

所有模拟样例带“模拟数据”，真实模式绝不填样例 PID/步数/进程读数。空值显示“未采集/语义未验证/待确认”的具体原因，不显示为零。状态有符号与中文文字，颜色仅辅助；无数据不用假进度骨架暗示正在训练。

日志工具提供：源切换、纯文字搜索、自动滚动开关、复制选择/路径、补读已读/快照目标字节、源错误与停采/补齐说明。搜索限定当前源的本地保留缓存，明确范围；后端分页、可取消、不跨远端全盘搜索，不默认把错误关键字变成失败终态。资源指标和进度保留各自时间，补读进度不能放进训练进度条。

鼠标上滚/文本选择即停自动滚动，恢复按钮始终可用；新日志计数不导致窗口跳动。Space 仅在日志视区焦点且无输入框、文本选择或 IME 组合输入时启闭滚动锁；Ctrl+F 聚焦日志搜索，Esc 关闭抽屉/清空搜索；Ctrl+R 发送合并刷新，Ctrl+1~9 在窗口内切换存在的任务，不注册系统全局快捷键。

日志行原样保留自己的时间文本；独立“采集时间”列展示 ingestedAt，不在无时间戳的日志前伪造生成时间。正常补读不插红色缺失横幅。证据抽屉仅列本任务进程实例、cwd、入口、父子关系、观测时刻、锁存在/确证持有、状态 JSON 的允许键投影与来源；不展示完整环境或未过滤原始 JSON。

采用系统字体、等宽数字和代码、路径中间截断与完整路径复制，主题初始跟随系统并记住手动选择。尊重减少动画，焦点可见；日志逐行不设 live announcement，另用低频 `aria-live=polite` 状态区播报连接/补读结束等变化，避免持续朗读新日志。

## 8. 模块与数据契约 v1

模块边界：`registry`（登记/校验）、`transport`（SSH/WSL 和固定探针）、`collector`（预算、身份/状态/资源）、`parsers`（按算法与运行关联解析）、`store`（SQLite、游标事务、清理/分页/搜索）、`contracts`（共享类型/校验）、`desktop`（窗口/preload）、`ui`（视图）。目录名可在实施计划定，职责不合并成视图内 shell 调用。

下列为设计类型，不是已实现代码。协议版本固定 `1`（尚未实施，不涉及已发布协议迁移），数值未知用 null。时间均为带时区 ISO 8601；offset/字节计数用十进制字符串（跨 IPC/SQLite/JS 不损失64位精度），解析/比较不能使用字典序。所有源字节范围为半开区间，只有同一 generation 的 offset 可直接比较。资源 value 为有限 number，缺失 null；无 NaN/Infinity。无对应源字节的事件 offset 为 null，不能填0假装发生在文件头。CursorState、检查点文件身份/稳定样本、RunBinding 是后端内部持久状态；UI不必收到所有内部证据，但不能缺少实现所需的内部规则。

```typescript
type Freshness = 'fresh' | 'stale' | 'unobserved';
type Confidence = 'high' | 'medium' | 'low' | 'none';
type Bytes = string;
type Lifecycle = 'running' | 'queued' | 'ready_not_training' | 'completed'
  | 'failed' | 'unconfirmed' | 'not_observed' | 'unknown';
interface Stamp { observedAt: string | null; freshness: Freshness }
interface ProcessKey { hostBootId: string; pid: number; startTicks: string }
interface ProcessInstance {
  key: ProcessKey | null; pid: number; parentKey: ProcessKey | null;
  cwd: string | null; scriptEntry: string | null;
  role: 'trainer' | 'queue' | 'worker' | 'unknown'; observedAt: string;
}
interface HostSnapshot extends Stamp {
  version: 1; hostId: string; kind: 'ssh' | 'wsl';
  connection: 'unobserved' | 'connecting' | 'connected' | 'disconnected';
  lastSuccessAt: string | null; lastProbeDurationMs: number | null;
  scanComplete: boolean; errorCode: string | null;
}
interface CountView {
  completedCount: number | null; targetCount: number | null;
  fraction: number | null; unit: 'completed_iterations' | 'unknown';
  verified: boolean; sourceId: string | null;
}
interface Progress extends Stamp {
  runId: string | null; lastStepIndex: number | null;
  bindingIds: string[]; baselineEvidenceId: string | null;
  resumeCheckpointIndex: number | null; firstLoopIndex: number | null;
  global: CountView; session: CountView;
  configuredTarget: { value: number; meaning: 'exclusive_index' | 'count' | 'unknown' } | null;
  iterationsPerSecond: number | null; etaSeconds: number | null;
}
interface Checkpoint extends Stamp {
  path: string | null; fileStepIndex: number | null;
  stepSource: 'filename' | null; sizeBytes: Bytes | null; mtime: string | null;
  evidence: 'none' | 'file_found' | 'file_stable_observed'; scanComplete: boolean;
}
type ResourceMetric = Stamp & {
  source: string; name: 'gpu_utilization' | 'gpu_memory_used' | 'gpu_memory_total'
    | 'cpu_utilization' | 'process_rss';
  unit: 'percent_device' | 'percent_one_cpu' | 'bytes'; value: number | null;
} & ({ scope: 'device'; deviceId: string; processKey: null }
  | { scope: 'process'; deviceId: string | null; processKey: ProcessKey });
interface TaskSnapshot {
  version: 1; taskId: string; hostId: string; lifecycle: Lifecycle;
  freshness: Freshness; statusObservedAt: string | null; confidence: Confidence;
  reason: string; evidence: { kind: string; sourceId: string | null;
    observedAt: string; confidence: Confidence; summary: string }[];
  currentRun: { runId: string; mainProcessKey: ProcessKey } | null;
  processes: { main: ProcessInstance | null; queue: ProcessInstance | null; workers: ProcessInstance[] };
  queueLock: Stamp & { source: string | null; exists: boolean | null;
    heldByRegisteredProcess: boolean | null };
  progress: Progress; checkpoint: Checkpoint; resources: ResourceMetric[];
}
interface LogSourceSnapshot extends Stamp {
  sourceId: string; taskId: string;
  state: 'unobserved' | 'ready' | 'missing' | 'permission_error' | 'reading'
    | 'catching_up' | 'reconciling' | 'paused_budget' | 'cache_full' | 'storage_error' | 'read_error';
  generation: string | null; committedOffset: Bytes | null;
  generationStartOffset: Bytes | null; maxObservedOffset: Bytes | null;
  continuityState: 'tracking' | 'reconciling' | null;
  catchupBytesRead: Bytes | null; catchupBytesTotal: Bytes | null;
  errorCode: string | null;
}
interface LogEvent {
  version: 1; eventId: string; taskId: string; sourceId: string; generation: string;
  kind: 'line' | 'redraw' | 'import_boundary' | 'generation_started'
    | 'gap_confirmed' | 'gap_unknown' | 'cache_evicted';
  startOffset: Bytes | null; endOffset: Bytes | null; ingestedAt: string;
  text: string | null; reason: string | null; displayTruncated: boolean;
  recordComplete: boolean | null; prefixIncomplete: boolean | null;
  runId: string | null; bindingId: string | null;
}
// 内部状态；字节内容和解码carry受第6节预算约束，不向UI整包传送。
interface CursorState {
  sourceId: string; generation: string; revision: number;
  state: 'tracking' | 'reconciling'; identityStrength: 'strong' | 'weak';
  fileIdentity: { dev: string; inode: string } | null;
  generationStartOffset: Bytes; committedOffset: Bytes; maxObservedOffset: Bytes;
  anchors: { startOffset: Bytes; endOffset: Bytes; sha256: string }[];
  parserState: { recordStartOffset: Bytes; pendingCR: boolean;
    utf8CarryBase64: string; boundedPreview: string; displayTruncated: boolean;
    prefixIncomplete: boolean };
}
interface RunBinding {
  bindingId: string; runId: string; mainProcessKey: ProcessKey;
  sourceId: string; generation: string; fromOffset: Bytes; throughOffset: Bytes;
  evidenceKind: 'instance_linked_record' | 'observed_direct_writer';
  observerEpoch: string; observedAt: string;
}
```

登记配置单独提供稳定显示名、算法、宿主参数、规范化源定义/解析器设置和启用位，不混入运行快照。显示最后观测的 UI 不能只检查 lifecycle 是否为 running。任务 freshly observed 不使旧 Progress 自动变 fresh；HostSnapshot 的 Stamp 按15秒宿主探测的两倍时限降级，单源失败不直接改宿主连接。Checkpoint 内部记录文件身份、稳定样本次数/时间，变化即重置样本，不以UI路径/mtime字段冒充身份。置信等级描述证据强弱，不是概率。

## 9. 验收场景与实施顺序

| 场景 | 必须满足的结果 |
| --- | --- |
| 共享账号、相似路径、链接逃逸 | 不因用户名/字符串前缀/参数含路径归属组员进程；逃逸源不读；扫描不完整不报无任务 |
| Score cwd=/home/cy、缺锁/打开锁 fd | 依据入口和关联等待证据识别队列；缺锁不单独阻断，打开 fd 不当作持锁 |
| 主进程+4 workers、PID 复用/主机重启 | 显示一个训练任务；旧实例资源与状态不嫁接给新 PID 实例 |
| WSL 未运行、SSH 断开 | 不自动启动 WSL、不显示其空闲；SSH 保留上次观测，不声称当前运行或失败 |
| Flow n=0/1/80106/169999、未知语义 | 校验索引/次数的边界；未知为 null；Score/Reflow 不复用 Flow 公式 |
| checkpoint 正在增长/稳定后再变 | 不加载权重；稳定等级可回退；不显示保存成功或可恢复 |
| 关机后新增 200 MiB 日志 | 从游标补读，多窗口自动继续；不止读 64 MiB，不跳到尾部，状态探测不饿死 |
| 首次安装已有大日志 | 只导入尾部最多 5 MiB，标未导入前缀；不是确认丢失 |
| 轮转旧文件仍可读/不可得、copytruncate | 可补完整则无 gap；已知未读字节确实不可得才确认 gap；不确定则 unknown |
| Flow源超时、Score状态正常 | Flow仅源退避；宿主轻量探测成功时保持connected，Score到期后优先于Flow重试，不能继承Flow的retryAt |
| 首导入100MiB文件、S后200B遇LF | 保存首条201B为不完整前缀，后续从S+201开始；C最终等于100MiB，重开从该C续读 |
| 旧C=8MiB的同inode覆盖后长回10MiB | 先reconciling；不得从旧C读新文件；原子换generation、新C=0；H=10MiB且旧未读不可得才确认8—10MiB缺口，H=8MiB只记unknown |
| 同run重开与新run复用日志 | 同强键runId稳定但旧快照stale、停采新增字节不自动归属；新键runId不同，当前进度清空，未关联输入不更新数值 |
| 中文跨块、CRLF、tqdm、超长无换行、崩溃 | 原字节 offset 正确；无无限 carry；重开不丢已提交数据、不重复提交行 |
| 7天到期/容量淘汰/磁盘满 | 仅本应用缓存清理；明确淘汰范围；写失败不推进游标、不删除服务器文件 |
| 整卡与进程资源、源缺失 | 不把整卡利用率归给个人进程；缺一个日志不让宿主离线或判任务失败 |
| UI 小窗口、搜索、IME、连续追加 | 能切换任务、读到进度与日志；搜索范围明确，输入不被空格快捷键破坏，缓冲始终有界 |
| 正常关窗与强制结束监控 | 后续只读观察确认独立训练实例未因监控退出而收到控制动作；产品无控制训练 API |

先使用模拟传输/文件流验证归属、计数与游标事务，再做 Windows 打包、IPC/只读操作审查和故障恢复；最后才对已登记的个人任务开展有限低频只读实测。实测记录命令/字节预算/耗时，不人为制造真实训练故障、轮转/截断真实日志或重启训练。外部审查先于实施计划。

实施分工：主控维护正式规范/验收；Luna 负责契约、采集、存储与桌面桥接；Gemini 负责 A 布局视图；DeepSeek 独立审查与模拟场景验证；默认不派 Claude。接口冻结、可运行的模拟桥接齐备后，前端与采集可分目录并行；共享契约与依赖清单由单一负责人顺序修改，避免互相覆盖。

## 10. 留给实施计划的决定

包版本和锁文件、SQLite 绑定兼容性、具体目录/API 命名、打包命令、颜色 token、虚拟列表库和分任务提交顺序由实施计划确定。SQLite 首选打包 Electron 所带 Node 可用且经过验证的内置绑定；不能根据本机 `node --version` 假定 Electron 内可用。若需第三方原生绑定，计划需明确打包/重建兼容性，不将 SQLite 偷换成无限增长 JSON 或内存缓存。

探针系统 Python、`/proc`、文件读权限和 nvidia-smi 的实际可用性由后续只读能力预检确定；缺能力按第4—6节降级，不扩大权限。未验证算法语义保持未知，不是阻碍首版只读显示的 TODO。

完整设计经独立检查、主控处理实质问题并获得用户确认后，使用 writing-plans 制定实施计划。本轮未初始化 Git、未安装依赖、未生成产品脚手架、未连接服务器/WSL。当前目录不是 Git 仓库，不为满足文档提交步骤而擅自初始化仓库。
