# 设计对齐记录与下一轮提示词

日期：2026-10-18。对象为 Gemini 的 `docs/drafts/window-design.md` 与 Luna 的 `docs/drafts/data-design.md`。均为设计草案，尚未定稿，也未开始产品实现。

本轮用户更新：已明确选择 **A 布局（左侧环境/任务栏，右侧详情与日志）**，并已交回 Gemini 修订结果。下方保留历史已发送提示词原文。主控已落实 A；明暗默认跟随系统作为正式稿提案，并非用户已选主题。

最新进展：DeepSeek 对 r1 提出4项阻塞，主控修订为 r2 后，全新 Luna 与 DeepSeek 的 r2 检查均为 Approved。D 已完成，不需重发。下文各阶段记录用于追溯；当前是用户确认完整设计，确认后再制定实施计划。Gemini 等待。

## 主控对 Gemini 稿的核对

总体布局、双轨进度、日志阅读与只读操作方向可以保留。下列问题会影响实现，需修订后再合并：

| 位置（本轮原稿行号） | 问题 | 应对齐的行为 |
| --- | --- | --- |
| 38、297 | 断线时仍写“远端训练独立运行中”“数据未丢失”，超出了可观测事实 | 显示“连接中断；上次于…观测为训练中；当前状态待重连确认”。关闭监控不会停止独立训练是架构保证，当前仍存活是另一件事 |
| 165、98—144 | WSL 被写成已连接/空闲；线框混入未核验的 Loss、速率、显存、检查点名称等 | WSL 初始为未观测/未连接。历史证据与纯模拟示例分开标识，缺失读数显示未采集 |
| 174—208 | 混用了 step 索引与完成次数；示例算式结果虽然约为 11 万，不能推广成通用续训公式 | Flow 恢复索引 30000、首轮索引 30001。若 tqdm 的 n 为完成迭代数，最后执行索引=30001+n−1；全局完成次数=30001+n。Score/Reflow 未验证时仅显示原始量和恢复点 |
| 227—263、289 | 将停采、mtime 跃迁、日志时间跳变或轮转直接当日志缺失 | 区分“停采区间”“正在补读”“已补齐”“确认不可补回”“可能缺段”。正常追加且完整补回时没有丢失缺口；轮转后归档可补回也不应误报 |
| 299、380 | 增加 syslog/dmesg 和全部进程环境变量查看，超出首版任务证据范围；无 lock 被当通用不充分条件 | 只呈现登记任务的白名单进程/文件字段；不读取环境变量，不扩展到系统日志或组员任务。lock 文件存在、实际持锁、训练是否开始分别表示 |
| 390—509 | 契约缺少进程实例键、字段新鲜度、明确进度单位、资源范围、多日志源/代次等，非活跃任务却要求数值进度 | 与修订后的 data-design.md 对齐；未知数值可 null，保留最后观测时间。设备与进程资源分项，不能把整卡数据归给进程 |
| 250、276、298、531—535 | 仅限行数无法限制超长行内存；<100ms 首帧、固定补读耗时、<40MB、零显存、10Hz 等没有实测依据 | 内存同时限制行数、字节与单行大小；性能数字仅作待测目标或删除。技术栈、刷新预算均为候选方案；只读读取也应节流，不能承诺零 I/O 影响 |

一般交互建议：空格等快捷键只在日志阅读区域生效，不拦截输入框、文本选择及输入法；实时日志避免每行强制屏幕阅读器播报。浅色/深色继续供用户比较，不能把暗色“更护眼”当已确认偏好。

## r1 合并时的发送顺序（历史）

1. **Luna：数据设计及契约修订，由主控直接发送，已完成一轮补齐。** 数据稿已交回，尚未经正式合并与独立审查。
2. **Gemini：修订已完成并交回。** 本轮无需继续派发；作者草案保留，主控未覆盖其正文。
3. 主控已形成统一稿 `docs/superpowers/specs/2026-10-18-training-monitor-design.md`；主题、首导入、补读额度、缓存语义和唯一契约在正式稿统一。
4. 独立 Luna 已检查正式稿可实施性，结论 Approved，无阻塞项，结果在 `docs/reviews/buildability-review.md`；现在可把 `docs/model-prompts.md` 的 C 发给 DeepSeek 独立审查。各正式审查顺序执行，避免边审边改同一稿。
5. 独立审查回稿、主控整合、用户确认完整设计后再制定实施计划。本轮不接入训练或安装桌面框架。

## 给 Gemini 的提示词（用户已发送）

```text
你继续负责训练监控器窗口设计。本轮修订设计文档，不写产品代码。

先读：
D:\Project\Process Monitoring\docs\requirements-and-evidence.md
D:\Project\Process Monitoring\docs\reviews\design-alignment.md
D:\Project\Process Monitoring\docs\drafts\window-design.md
如 data-design.md 已存在，也读 D:\Project\Process Monitoring\docs\drafts\data-design.md；它可能正在并行修订，契约最终由主控整合。

继续使用：
C:\Users\noahx\.config\magpie\library\skills\frontend-design\SKILL.md
C:\Users\noahx\.config\magpie\library\skills\design-taste-frontend\SKILL.md
C:\Users\noahx\.codex\skills\ui-ux-pro-max\SKILL.md
遵循前端工具界面的信息层级；design-taste-frontend 的营销页规则不适用于本仪表盘。

唯一可修改文件：D:\Project\Process Monitoring\docs\drafts\window-design.md。
不改 Luna 文件、草图或其他项目文件；不连接 SSH/WSL，不安装依赖，不初始化脚手架，不运行训练，不新增训练控制或服务器常驻服务。

请逐条解决主控核对表中的实质问题，连同正文、线框、状态表、TypeScript示例一起改，避免只在末尾追加免责声明：
1. 断线只保留带时间的上次观测，不能宣称当前远端仍运行、数据未丢；WSL未探测时不能显示空闲/已连接。
2. 严格区分零基step索引、完成次数、本段完成次数与目标边界；Flow公式写清前提，Score/Reflow不套通用偏移公式；未训练任务显示恢复点而非实时进度。检查点只标实际证据级别，不编造已确认文件名或保存成功。
3. 停采不等于丢失；补读完整则显示已补齐。mtime变化、时间戳跳变、单纯轮转都不能独立证明丢失；不可得区间才显示确认缺口，无法证明则显示可能缺段，不虚构起止时间。
4. 收紧证据抽屉到登记任务白名单字段，去除全部环境变量、系统日志读取。状态判定不要求cwd/入口/lock全部成立，lock文件存在也不等于持锁；Traceback出现或日志静默不能单独等同任务失败/卡死。
5. 接口契约加入unknown/null、新鲜度/最后观测、进程实例与工作进程归并、明确单位和来源、设备/进程资源范围、多日志源与generation/offset、补读与缺口证据。采用Luna草案语义，尚未对齐项明确交给主控，不自建第二套矛盾规范。
6. 内存同时限行数和字节、单行大小。删除未实测的Tauri常驻内存和零显存保证、固定恢复耗时、无卡顿/不影响I/O等绝对表述；刷新/读取预算及技术栈只作候选和待测目标，不扩展为10Hz采集需求。
7. 将所有虚构数值和原始日志样例清楚标为模拟；原始日志没有时间戳则不可捏造，采集时间单列。快捷键限定作用域，日志朗读不过度打扰；主题偏好留给用户。

保留总体紧凑布局、中文可读性、累计/本段双视角和日志阅读功能。用户已批准静态草图，主控正在展示A/B布局；更新下一步说明，不能写成仍待首次草图许可。交付时简述修订完成项与仍需主控决定的事项，不声称产品或正式设计已通过验收。
```

## 主控实际发给 Luna 的提示词

### 数据设计任务（已发送）

```text
现在正式执行 docs/model-prompts.md 中任务 A：数据与采集设计。先完整读 D:\Project\Process Monitoring\docs\requirements-and-evidence.md，使用 C:\Users\noahx\.config\magpie\library\skills\brainstorming\SKILL.md；主控已完成访谈且用户同意静态草图，不重复访谈或制作界面。唯一允许创建或修改文件 D:\Project\Process Monitoring\docs\drafts\data-design.md。本轮只写设计，不连接服务器/WSL，不运行训练或采集，不安装依赖或脚手架。覆盖：1登记目录、真实入口与cwd不同、进程实例及子进程归并；2运行状态和连接状态分开，证据、可信度和降级；3累计索引/完成计数/本轮计数/目标/检查点证据的契约和Flow边界公式，其他算法单独定义；4日志文件身份offset、轮转截断重连、多字节/回车、分批补读、本地7天计时与磁盘上限建议；5 Windows本机与远端职责、复用SSH凭据、只读预算、关窗崩溃不牵连训练；6前端最小契约、错误例及模拟验收场景。建议给出数值默认值并标为可调建议，不能承诺未测试性能。附加阅读 Gemini 已写 D:\Project\Process Monitoring\docs\drafts\window-design.md，只用于找接口矛盾，不修改它。特别防止：离线仍断言远端当前运行/数据未丢；把补读后连续日志标成丢失缺口；WSL未观测却标空闲；把tqdm完成次数当step索引；仅按mtime或时间戳跳变判日志丢失；缓存只限制行数不限制字节；要求lock/cwd所有证据同时存在；将整卡GPU指标冒充本进程；暴露全部进程环境变量。不要加载权重验证，不部署服务器常驻服务，无训练控制。本次设计草案独立于草图，不把HTML当产品代码。回复文件路径、关键选择、与Gemini契约需对齐点和未决问题。保持精炼但覆盖可实施边界。
```

### 数据契约补齐（随后发送）

```text
草案已读。请只在 data-design.md 补齐本轮几个契约缺口，不扩大产品范围：1. 断连行为选定一种一致表示，不再“改unknown或保留”二选一：建议任务当前freshness=unobserved/stale/fresh，保留lastObserved lifecycle+statusObservedAt，展示端明确上次状态；修订文字和类型一致。2. progress不能一个unit/target/fraction同时对应lastStepIndex、completedCount和sessionCount，拆成明确全局完成计数视图/本段完成计数视图及lastStepIndex；写清起止边界、resume checkpoint index与首次循环index，null表示未知。3. process字段保留主/队列实例及已确认workers列表，资源改列表，每项有scope和deviceId或完整进程实例键、metric单位；同时承载进程显存与整卡利用率，CPU利用率/进程RSS可null，不凭PID就声称能采到进程GPU利用率。4. LogEvent补充sourceId及catchup已读/总字节可null，原始chunk已持久化与解码carry状态一起提交游标，避免拆分多字节或未完成行重启后重复/跳读；前端内存除行数上限还需字节上限和单行上限，标为建议。5. 模拟Score缺lock但入口+新鲜队列证据充分时不要自动降级所有情形；分清文件存在和实际持锁。已有刷新/首次导入/容量默认作为主控待定建议保持即可，不重复问用户。不连接任何宿主或运行程序；回复完成即可。
```

静态草图的实际提示词与修订顺序另见 `docs/mockup-session.md`。

## Gemini 修订交回后的主控合并

统一稿：`docs/superpowers/specs/2026-10-18-training-monitor-design.md`。本轮只写文档，未连接服务器/WSL、安装依赖、初始化 Git 或生成产品脚手架。

主要裁决：保留用户选择的 A 布局；主题跟随系统且可手动选择；Electron/TypeScript/React/SQLite 为主控提案，完整设计仍需用户确认。首导入每源尾部5MiB，后续从游标补读；64MiB是追赶窗口额度、让出15秒后自动继续，不是停止补读的总量。7天从本地成功入库计时，容量可更早淘汰；日志内容预算与实际数据库磁盘占用区别标注。

统一枚举移除 save_confirmed/save_observed/metadata_read，仅保留 none/file_found/file_stable_observed；主机连接与单源错误分开；不设 stalled 生命周期；锁文件存在/打开fd不等于持锁。首次未导入前缀、远端确定缺失、可能缺段与本地缓存淘汰分别表达；以文件锚点补充inode/大小的有限检测，不承诺检测所有快速覆盖。作者草案不覆盖，正式稿为唯一实施依据。

### Luna 草案交叉核对（主控已直接发送）

模型 GPT-6-luna，新子代理 `draft_merge_check`。与主控写稿可并行，只读作者草案；它没有撰写正式稿。

```text
你是训练监控器设计的独立核对员。本轮只读，不写文件，不连接服务器/WSL、不安装依赖、不运行产品或训练。工作区 D:\Project\Process Monitoring。完整阅读 docs\requirements-and-evidence.md、docs\drafts\data-design.md、docs\drafts\window-design.md；只找会导致实现错误的剩余矛盾/遗漏，最多8项。重点：两稿检查点证据枚举不一致、补读优先级/64MiB上限、首次日志导入、7天缓存、UI示例残留超缓存数值、队列归属/持锁判定、主机与源状态是否混淆。不是风格审查，不修改两份作者草案。返回文件行号、问题与简明建议。主控将另写正式统一稿，本轮不算正式稿可实施性审查。
```

返回8项：检查点枚举、首导入、64MiB语义、超出缓存约束的示例、7天计时口径、排队是否必须持锁、宿主/源状态混用、持锁示例不可预填。已由统一稿处理；示例超限不继承到正式稿。

### Luna 正式稿可实施性检查（随后由主控直接发送）

模型 GPT-6-luna，新子代理 `formal_spec_builder_review`，未参与作者草案或正式稿撰写。正式稿完成后顺序执行；不与修改正式稿并行。

```text
你是未参与撰写此正式稿的独立设计审查员，只检查，不改设计。工作区 D:\Project\Process Monitoring。先读 C:\Users\noahx\.config\magpie\library\skills\brainstorming\spec-document-reviewer-prompt.md，按该模板校准；本地 builder-check-prompt.md 缺失，使用这个实际存在的模板。再完整阅读 docs\requirements-and-evidence.md 和 docs\superpowers\specs\2026-10-18-training-monitor-design.md。检查是否完整、一致、可以进入实施计划；重点关注会造成真实错误的遗漏/矛盾，而不是偏好。检查个人任务身份、弱PID降级、状态证据/新鲜度、Flow边界、checkpoint不读权重、日志offset/补读/首次导入/7天淘汰、预算与IPC、关闭监控生命周期。正式稿有意用Electron替代草案Tauri、主题跟随系统、首次5MiB，不当作未确认需求的事实，而是主控待用户批准的设计默认；不因作者草案与正式稿不同就阻塞。只可创建/修改 D:\Project\Process Monitoring\docs\reviews\buildability-review.md。不得连接服务器/WSL、执行探针、安装依赖、写产品代码、修改其他文件或发消息给其他会话。输出 Status: Approved 或 Issues Found，每个阻塞项给正式稿章节/行号、具体冲突和规划影响；可建议最小修正。最多6个实质问题，不为假想风险扩大范围。完成后回复简明结果。
```

当时结果：**Approved**，无阻塞项；见 `docs/reviews/buildability-review.md`。主控当时核对后只更新正式稿审查状态说明，再请用户发送 C。C 现已完成并提出4项阻塞；处理见下文。Gemini 继续等待。

## DeepSeek r1 回稿后的 r2 修订

原报告：`docs/reviews/design-review.md`，Status Issues Found；4个阻塞项及6个模拟场景已核对。全部为真实契约缺口，主控接受并修订，不覆盖原报告。

本轮使用 `C:\Users\noahx\.codex\skills\receiving-code-review\SKILL.md` 核对反馈，按 `C:\Users\noahx\.config\magpie\library\skills\brainstorming\SKILL.md` 继续设计阶段，并用 verification-before-completion 核验新报告。没有补装 skills。

### 本轮实际发送顺序

1. 下列日志建议与运行绑定建议交给两位 Luna，可并行；它们只读并返回建议，不共同编辑正式稿。主控同时核对错误隔离等其余问题。
2. 主控整合建议，修订唯一正式稿为 r2，并写 `docs/reviews/design-review-response.md`；作者草案和原审查报告不改。
3. r2 固定后，交给第三位全新 Luna 做独立审查，不与修改正式稿并行。实际结论 Approved，见 `revision-r2-review.md`；主控已读取原报告验证内容。
4. D 随后由用户发回原 DeepSeek 会话，已生成 `design-review-r2.md`，结论 Approved。主控已回读核实并整理完整设计供确认；Gemini 暂不分配任务。这轮没有派发任何产品代码任务。

### Luna：日志边界建议（主控已直接发送）

模型 GPT-6-luna，子代理 `log_revision_advice`。实际提示词：

```text
你负责对设计审查的日志问题提出独立修订建议。只读、不写文件、不连接服务器/WSL、不运行产品/探针/训练、不安装依赖。工作区 D:\Project\Process Monitoring。完整阅读 docs\reviews\design-review.md，再读 docs\superpowers\specs\2026-10-18-training-monitor-design.md 第6节及第8节。针对阻塞项2/3，给出可直接合并的最小规范：1所有原始chunk/LogEvent字节区间用[start,end)及committedOffset定义；首次5MiB从S开始、不丢字节，首行显示如何截断而不影响offset，UTF8/CRLF/长行/崩溃；2同inode copytruncate检测的明确状态转换、旧游标不得用于新代次、原子提交代次和重置、确认gap与unknown的证据边界、弱身份如何降级。用2-3个具体数字例子指出不可重放或跳过的范围。必须承认同inode快速覆盖且锚点相同不可完全检测。只返回建议和你发现的真实歧义，不修改正式稿；主控会整合。不扩大历史导入范围、不增加复杂终端仿真或服务器写入。
```

返回建议已用于半开区间、G/C/H、首段原字节保留、原子代次转换和 gap 门槛；不是独立批准结论。

### Luna：运行绑定建议（主控已直接发送）

模型 GPT-6-luna，子代理 `run_binding_advice`。实际提示词：

```text
只读独立建议，不修改文件，不连接网络/服务器/WSL，不运行探针/训练，不安装依赖。工作区 D:\Project\Process Monitoring。阅读 docs\reviews\design-review.md 第4阻塞项与 docs\superpowers\specs\2026-10-18-training-monitor-design.md 的4.3/5.2/6/8。请在不修改训练、不加载权重、共享账号约束下，提出v1最小可实现runId/日志绑定规则。已考虑：runId由hostId/taskId/主训练进程强实例键确定性生成，queue/workers不生成训练run；同key重开保持、key变新run；Progress.runId只在进度字节可归属当前run时填，否则null；日志generation变化不等于run变化，但旧binding要失效；run首次识别时将已存在日志前缀视为未关联历史，不能凭mtime/路径把n嫁接给新run；验证当前进程直接写入登记日志+本地观察后新增完整记录可作为有界证据（间接tee/无法读fd时unknown），已有按实例绑定的启动/恢复记录可更强验证。请指出这些规则是否有实质漏洞，给最小的字段和2个实例。不要要求万能证明所有co-writer，也不能把打开日志fd当训练进程持锁；不建立按PID/mtime的宽松兜底。特别关注恢复基线来源必须同run，计数/ETA哪些null，离线期间同进程日志是否可持续归属的不确定边界。简明返回建议。
```

返回建议已用于规范 runId 元组、RunBinding 字节区间、观察窗口及停采恢复、同-run 基线与 null 降级；不是独立批准结论。

### Luna：全新 r2 规格审查（主控已直接发送）

模型 GPT-6-luna，新子代理 `r2_spec_review`，不继承两位建议者的对话。实际提示词：

```text
你是未参与设计撰写的独立规格审查员，检查 r2 是否可进入实施计划。工作区 D:\Project\Process Monitoring。先完整阅读 C:\Users\noahx\.config\magpie\library\skills\brainstorming\spec-document-reviewer-prompt.md 和 C:\Users\noahx\.codex\skills\verification-before-completion\SKILL.md，按模板校准，只报影响实施的实质缺口，不用风格偏好阻塞。
完整阅读 docs\requirements-and-evidence.md、docs\reviews\design-review.md（原 DeepSeek r1 审查）、docs\superpowers\specs\2026-10-18-training-monitor-design.md（现在 r2）。独立验证原四项阻塞是否闭合：1 单源与宿主退避分离；2 首次尾部5MiB、[start,end)、raw committedOffset、行/UTF8/CRLF/崩溃语义；3 同inode copytruncate且文件已长回旧C以上的代次转换、旧归档续读、gap证据及原子切换；4 runId强实例生成、日志字节区间绑定、重开/离线/新进程不继承旧进度、基线同run。重点核对 §4.4/6.1/6.2/6.4/8 的实现契约是否一致、有无新增实质矛盾。至少逐项复演原审查6个模拟场景；这是文档桌面推演，不能声称实测。标明有限锚点无法发现全部同inode覆盖，fd不排他，无法归属的进度null是否被一致处理。
只可创建或修改 D:\Project\Process Monitoring\docs\reviews\revision-r2-review.md，其他文件只读；不连接服务器/WSL/网络，不运行训练、探针或产品程序，不安装依赖，不写产品代码，不修改正式稿。输出 Status: Approved 或 Issues Found，四项闭合表、6场景结果、真实阻塞项（有则定位章节与矛盾/影响）、非阻塞建议及无法验证事实。不要因为设计未获用户批准而否定文档完整性，也不要把建议技术栈说成已获批准。写完读取验证文件后，简要向主控报告真实问题。
```

实际结果 **Approved**：四项闭合、六场景文档推演通过，无新增阻塞；不是实测。主控核验后只更新正式稿开头的审查状态说明，未再修改设计规则。外部 DeepSeek r2 复核随后已完成，见下文。

## DeepSeek r2 交回与完整设计交付

用户交回 `docs/reviews/design-review-r2.md`。主控完整读取核实：Status Approved，4项标记已闭合，6个原场景及补充矛盾探测均无阻塞；原 r1 报告保持不变。

主控仅更新文档审查状态，把6条非阻塞建议记录到 `docs/reviews/design-review-response.md`，未改变已审查 r2 的设计规则，未调用 writing-plans 或派发实现。

### Luna：审查交接提取（主控已直接发送）

模型 GPT-6-luna，新子代理 `r2_review_handoff`。与主控更新状态并行，只读报告提取后续注意事项，不是又一轮设计审查。实际提示词：

```text
只读资料提取，不做又一轮设计审查，不写文件，不连接网络/服务器/WSL，不运行程序或安装依赖。工作区 D:\Project\Process Monitoring。阅读 docs\reviews\design-review-r2.md 的一般建议与补充矛盾探测，并参照 docs\superpowers\specs\2026-10-18-training-monitor-design.md。主控已核实报告 Approved，将向用户交付完整设计确认；此刻不要编实施计划或产品代码。请将六条非阻塞建议压缩为后续计划应保留的具体检查点，按原报告逐条对应，指出有没有需要额外改变用户范围的建议（没有就直说）。另外仅列用户确认时最值得点明的3项设计默认/限制，不能把技术默认说成已获批准。仅返回简短建议，供主控记录审查交接。
```

返回的六项均为既有范围内的实现契约细化，已记录到处理对照。该子代理没有修改文件。下一步由用户确认正式设计与主控提出的默认值；之后主控使用 writing-plans 编写实施计划，明确每阶段提示词、skills、文件范围、验证与并行顺序。

## 实施计划准备（用户已确认 r2）

用户随后回复“确认，暂时按这样处理”。主控据此记录完整r2与暂行默认已确认，使用writing-plans制定 [实施计划](../superpowers/plans/2026-10-18-training-monitor-implementation.md) 和 [实施提示词](../superpowers/plans/2026-10-18-training-monitor-prompts.md)。本阶段没有发送实施任务；下列两位Luna只提供只读建议，不是计划审查者。完整计划由主控自己撰写并按skill自查，没有再派计划审查。

### Luna：后端任务边界建议（已发送）

模型GPT-6-luna，子代理plan_backend_advice。实际提示词：

```text
你是实施计划的只读技术建议者，不是实施者。工作区 D:\Project\Process Monitoring。用户已确认 r2 设计，当前仅制定实施计划，不写产品代码、不安装依赖、不连接服务器/WSL、不改训练、不初始化Git。完整读 docs\superpowers\specs\2026-10-18-training-monitor-design.md 与 docs\reviews\design-review-response.md 第非阻塞交接。请向主控提出数据/采集的最小任务划分（最多6个）、每任务确切文件目录建议、跨模块API签名（可以TypeScript类型签名不写实现）、最关键的失败断言与模拟验证命令建议、依赖顺序。重点避免运行归属、原始chunk持久化、CR重绘、CAS/代次切换、SQLite单线程归属、host/source隔离、进程强键的复杂性被漏掉；给出一个接口冻结后前后端可并行的分界。只返回简洁技术建议，不写文件或正式计划、不执行模拟测试，不盲目扩大范围。主控独自写计划并做最终自查，不需要你审批计划。
```

结果：建议先冻结契约/mock，再分纯日志算法、单worker存储、传输、运行语义与调度；重点保留CAS和绑定撤销。主控将它们收敛为T1—T6，接口与目录以最终计划为准。

### Luna：桌面与打包任务边界建议（已发送）

模型GPT-6-luna，子代理plan_desktop_advice。实际提示词：

```text
只读实施计划建议，不实现不安装不连服务器/WSL不修改文件。工作区 D:\Project\Process Monitoring。用户已确认r2设计。阅读 docs\superpowers\specs\2026-10-18-training-monitor-design.md 第3/7/8/10节及 docs\reviews\design-review-r2.md 一般建议。请从Windows Electron桌面边界、UI/后端分目录并行、SQLite绑定/打包兼容验证、mock桥接、退出/重开、日志内存与键盘交互方面，提出最多4个可独立交付的任务（文件范围、前置条件、2-3个关键验收断言/命令），列出最容易遗漏的集成接口。版本未知就明确由主控核验，不联网猜版本、不为架构另起设计审查。只返回建议，不写计划或代码，主控自行写正式计划并自查。
```

结果：把实际Electron内的SQLite及打包canary提前至T1；界面消费同一mock/production窄接口；强调取消/订阅释放、IME和缓冲限额。主控已采用这些边界。

### 主控的版本核验与计划自查

只读核验本机Node26.2.0/npm12.0.1/Python3.14.7、官方registry包元数据与官方Electron/Node/构建文档，没有安装依赖。Electron44.9.0携带Node24.22.0，因此计划要求在实际Electron worker和打包可执行文件中验证SQLite，不能由宿主Node替代。本机只枚举node:sqlite导出，未创建产品数据库；确有DatabaseSync导出。

主控自查中补齐了ReadReply的expected generation/revision/C标签、一次性registerSource持久化起点、T1共享parseBytes及worker测试构建入口，避免后续任务接口脱节。正式r2规则没有改变。

交付范围为计划/提示词与状态记录。未连接SSH/WSL、未运行训练/采集程序、未安装依赖、未创建产品脚手架、未初始化Git。用户核对计划后才按P1开始实施；P7与P2的并行关系及P8审查快照要求均已写明。
