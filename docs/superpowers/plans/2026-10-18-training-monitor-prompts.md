# 训练监控器：实施派发提示词

日期：2026-10-18。用户已确认 [实施计划](2026-10-18-training-monitor-implementation.md)，主控已自主发送P1给Luna。实际派发使用包含本任务与全局约束的独立brief，详见 [实施记录](../../reviews/implementation-progress.md)；后续按以下批次派发。已完成的A/B/C/D设计提示词不再重发。Gemini/DeepSeek仍由用户转发，不使用Claude。

每段代码块是可单独复制的完整提示词。模型须阅读指定文件中的相应任务；正式稿优先于旧草案，用户已确认的只读范围优先于skill的通用建议。读取skill不等于把整套流程再做一遍；不重复脑暴、不重新选择布局、不擅自增加功能或安装其他skills。

## 发送顺序

1. 主控发送 **P1 → Luna**，通过后冻结接口。
2. 同时发送 **P2 → Luna** 与 **P7 → Gemini**。
3. Luna依次完成 **P3 → P4 → P5 → P6**；这期间Gemini继续P7。每项由主控核对交付后再派下一项。
4. P6和P7均完成后，可同时发送 **P8a → Luna** 与 **P8b → DeepSeek**。两者开始前冻结本轮代码快照；Luna先运行集成，不在DeepSeek审查期间混改代码。主控收集问题后串行派修，修完重跑相关验证并交回DeepSeek复核实质问题。
5. P8通过后发送 **P9 → Luna** 构建交付；主控在计划T9的预算内做已授权的真实只读验收。构建不依赖真实机器在线。

共享文件/依赖由Luna独写。Gemini修改renderer和其UI测试；DeepSeek只写审查报告。需要跨范围改动时向主控提交具体文件/接口差异，不在另一模型的目录内直接实现。

## P1 — Luna：安全桌面、接口与运行时门槛

```text
你负责实施任务T1，不是重新设计。工作区 D:/Project/Process Monitoring。用户已确认r2设计，主控在核对实施计划后派发本任务。主控协调和验收，你写具体代码。

先读：
1. docs/superpowers/specs/2026-10-18-training-monitor-design.md 全文。
2. docs/reviews/design-review-response.md 的非阻塞交接。
3. docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 的全局约束、文件地图、版本/命令和T1；浏览后续Interfaces以保证不阻塞后端。
4. C:/Users/noahx/.codex/skills/test-driven-development/SKILL.md。
5. C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md。

只实现T1：精确版本/锁文件、受隔离Electron窗口、共享DTO和MonitorApi校验、同接口mock、最小模拟视图、构建/测试/打包脚本，以及Electron实际Node worker中的SQLite写/读/重开canary。包版本按计划固定；先让测试可运行，再验证行为红测并最小实现。Electron内SQLite和打包后的canary必须实际运行，不能仅测试本机Node。单实例、关窗退出；加载本地构建文件，不开产品HTTP服务。

可写范围：计划T1所列根配置、scripts、src/shared、src/desktop、src/mocks、renderer最小入口、T1测试和必要.gitignore条目。不得实现完整UI或提前写T2以后的采集逻辑。冻结MonitorApi和mock可调用后交主控，后续Gemini接管renderer。共享DTO严格采用正式稿第8节，未知为null，Bytes为十进制字符串。

允许下载本机项目所需的计划依赖；不要全局安装、不要装远端依赖、不要初始化Git。禁止连接SSH/WSL、运行训练、加载权重、改变训练目录、增加启停控制。--demo和canary不得构造真实transport。SQLite不兼容时给出复现并修兼容，不偷换存储。

执行计划T1的全部验证：contracts、真Electron shell、typecheck、test:runtime、package:dir、test:packaged。只在确有已有用户授权Git仓库时提交，否则交付文件清单和命令即可。完成后报告：文件清单、冻结接口、实际版本、每个命令/exit code、未验证项、是否可以同时派T2和T7。不要以“测试应该通过”作结，不进入下一任务。
```

## P2 — Luna：原字节日志引擎

```text
实施T2。工作区 D:/Project/Process Monitoring。T1应已由主控验收；先核对T1产物真实存在，不改写冻结MonitorApi。

读取正式稿 docs/superpowers/specs/2026-10-18-training-monitor-design.md 第6/8/9节、docs/reviews/design-review-response.md、实施计划 docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 全局约束/T2及T3的消费接口。使用 C:/Users/noahx/.codex/skills/test-driven-development/SKILL.md 和 C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md。

仅写 src/logs/** 和计划T2的三个unit测试。实现initialCursor、prepareRead、decideGenerationTransition及对应类型；依照计划确切签名。ReadReply携带请求时expected generation/revision/C，先判迟到/重叠，再处理字节；共享parseBytes复用T1实现。原始块不因UI截断或行不完整而丢失，C不等待换行；UTF8/CRLF/pendingCR与preview有界并可持久化。CR完成的重绘是可归属完整记录，单个未决CR不是。

覆盖首次100MiB从95MiB开始、201B不完整首条；>2^53字节位置；中文逐字节切批；64KiB无换行预览上限；同inode截断后已长回旧C以上必须reconcile；旧H=C只能unknown；旧H>C且候选扫描完成证明不可得才confirmed；归档补完整不报gap，新代仍从0开始。有限锚点不能证明检测所有覆盖，不能夸大。

先写失败断言并运行，再实现，再运行计划T2命令及typecheck。Gemini可能同时编辑renderer，不改其目录；若全量typecheck遇到其在途代码，报告具体来源并协调，不擅自修它。禁止任何真实SSH/WSL/训练连接、依赖安装和Git初始化，不写数据库/调度/完整UI。

完成后交付文件、签名、每条关键断言对应测试名、真实命令结果和限制。若接口确需改变，先交主控具体diff，不让后续任务自行猜。不进入T3。
```

## P3 — Luna：SQLite提交、恢复、清理与搜索

```text
实施T3。工作区 D:/Project/Process Monitoring。读取已确认正式稿 docs/superpowers/specs/2026-10-18-training-monitor-design.md 第6/8/9节、r2非阻塞交接 docs/reviews/design-review-response.md，以及 docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 的全局约束/T3/T6消费接口。先检查T2导出类型，名称严格对齐。

使用skills：
C:/Users/noahx/.codex/skills/test-driven-development/SKILL.md
C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md

仅实现计划T3：src/store/**、对应store测试、必要的Luna所属worker构建/canary接线。一个Node worker拥有唯一SQLite连接，main/renderer不得直接查库或解析日志。openStore/StoreClient按计划签名；registerSource只初始化一次，重开不再套5MiB。

原始BLOB、events、parser carry、C须CAS同事务提交；全旧/部分重叠响应整批拒收；崩溃回滚不重复/跳读。reconciling先持久化，旧归档有界补齐后原子封存旧代/缺口决定/新UUID G=C=0/清parser和绑定。不能从旧C接新文件。测试注入事务中途崩溃，不影响真实进程。

留存从ingestedAt最多7天，查询即时过滤；总1GiB/单任务256MiB，超额到80%；磁盘<128MiB暂停读取且写失败不推进C。只清本应用缓存，已淘汰段不自动回拉。DB/WAL物理空间另测另管。长未完成行不能无限保留旧raw。文字搜索参数化、分页500条/1MiB、分块可取消，不阻塞worker持久化。

按T3先红测再实现并运行tests/store和test:runtime；关键提交/重开分支在真正Electron24 worker内验证，不只依赖Node26。实际记录DB/WAL空间与失败注入结果。不得连接SSH/WSL、读训练目录、安装新包、初始化Git或改Gemini视图。完成后报告真实命令/exit code、事务保证与限制，不进入T4。
```

## P4 — Luna：本地登记与只读传输（仅模拟）

```text
实施T4，当前仅本地模拟，不试连服务器或WSL。工作区 D:/Project/Process Monitoring。
读取 docs/superpowers/specs/2026-10-18-training-monitor-design.md 第3/4/6/8/9节、docs/requirements-and-evidence.md（历史证据不能当实时）、docs/reviews/design-review-response.md，以及 docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 全局约束/T4/T5消费接口。
使用 C:/Users/noahx/.codex/skills/test-driven-development/SKILL.md 与 C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md。

只写计划T4的src/registry、src/transport、src/probe、transport/Python测试。按现有DTO与ReadReply落地Transport、固定封帧协议、HostObservation/TaskObservation/ReadRequest。配置本地原子写入+revision CAS，任务预置disabled待确认，不能显示历史PID正在运行。服务器实际目录拼写是Scored-Based，不改成Windows本地拼写；WSL路径不能从Windows盘符猜。

SSH复用lab-campus与现有known_hosts/凭据；固定系统Python /usr/bin/python3 -I -S -B -，源经stdin，配置用安全base64数据，路径不拼远端shell。不保存密码、不改SSH配置、不部署探针文件。先查running WSL，不启动停止中的发行版。5秒/响应2MiB/stderr64KiB/JSON256KiB上限必须按流累计，超限停止自己的探针，不无限缓存。

真实目录边界、打开后fd身份、symlink中途替换、带引号空格中文路径、/xzn-other必须测试。用户名/共享Python环境/命令偶含路径不当归属。最小有界proc候选发现仅返回登记任务细节；不读environ/syslog/dmesg，不扫描整盘，不运行训练入口。nvidia-smi是可选固定只读命令，缺能力返回未知。禁止训练信号、pkill、权重加载。

用本机临时文件/模拟proc与fake spawn先红测后实现，执行计划tests/transport和python unittest，Windows模拟通过不等于真实Linux通过。交主控完整外部命令白名单、字段投影、错误分类、测试结果。不要安装依赖、初始化Git、改UI或进入T5。
```

## P5 — Luna：运行归属、进度与证据投影

```text
实施T5。工作区 D:/Project/Process Monitoring。先读：
docs/superpowers/specs/2026-10-18-training-monitor-design.md 第4/5/8/9节；
docs/reviews/design-review-response.md 六条非阻塞交接；
docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 全局约束、T5和T6接口；
实际T4 TaskObservation与T2 LogEvent定义。
使用 C:/Users/noahx/.codex/skills/test-driven-development/SKILL.md 和 C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md。

仅写 src/domain/**、src/parsers/**、计划tests/domain。makeRunId、updateBindings、bindCompleteRecord、revokeBindings、deriveProgress、projectTask按计划签名，不再造DTO同义字段。

强键缺bootId/startTicks不生成弱ProcessKey、不输出process资源；device资源独立。只给确认主trainer建run，queue/worker不建。固定类型规范JSON [hostId,taskId,hostBootId,pid,startTicks] SHA256生成run:v1:。新run清bindingIds和baselineEvidenceId，不能嫁接旧步数。

RunBinding只覆盖有完整证据的源/代次/半开字节区间；直接writer fd不是排他证明，初始prefix不能retrobind；晚下载初始历史不因当前窗口存在而归属，structured record也须满足自身的关联规则。pendingCR不完整，已解析完整CR重绘可归属。关机/离线/identity或目标变化关闭窗口；同run重开旧进度stale，离线字节不自动刷新；撤销绑定立即重算或清空投影，内部保留revoked状态。

Flow仅当前run基线和语义已确认才归一化：b30000/T200000/n80106 -> first30001,last110106,global110107/200000,session80106/169999，另测n0/1/169999/越界。Score/Reflow不套Flow公式。检查点仅none/file_found/file_stable_observed，15秒两次稳定后可回退，不加载权重。不以traceback/静默/消失单独判失败完成。Score cwd=/home/cy但入口+当前等待证据可queued；锁存在/open fd不等于持锁。资源scope和CPU/RSS语义按正式稿。

先写红测，执行tests/domain，再最小实现，重跑与typecheck。逐条给主控六条交接所对应测试名和实际结果。禁止真实连接/训练/新依赖/Git初始化，不改renderer，不进入T6。
```

## P6 — Luna：采集调度、生产桥接与关闭

```text
实施T6。工作区 D:/Project/Process Monitoring。读取正式稿 docs/superpowers/specs/2026-10-18-training-monitor-design.md 第6/7/8/9节、docs/reviews/design-review-response.md、实施计划 docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 全局约束/T6，并核对T3 StoreClient、T4 Transport、T5函数实际签名。
使用 C:/Users/noahx/.codex/skills/test-driven-development/SKILL.md 与 C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md。

仅写计划src/collector、store观测投影与desktop生产接线及T6测试。创建createCollector/Collector/Clock和createProductionApi，保持T1 MonitorApi不变；domain解析投影在单SQLite worker里完成，main只调度传输/窗口。

host/source独立retry计数和retryAt。每宿主单inflight，到期元数据优先；日志5秒256KiB，元数据15秒，补读1MiB每宿主最多1批/秒，64MiB后让出>=15秒自动继续。200MiB补读不能64MiB后停住。无阶段证据超时先源/请求失败，再独立有界host probe；probe成功不能把宿主标断线，其他源不能继承失败源退避。host明确错误2/5/15/30秒，missing/permission源30秒。刷新风暴合并，存储失败不推进C，缓存满暂停日志但不压制元数据。

新源先registerSource，旧源按持久化cursor；重开本地快照stale、未探测WSL不是空闲，字段freshness独立。disabled预置不发探针；--demo不得构造真实transport。stop只取消/终止本应用有限探针并关库，不操作登记PID/队列/tmux。

只用虚拟时钟/fake transport/临时appData，先红测再实现。运行T6列明的scheduler、projection、真Electron recovery测试与typecheck，报告准确命令/exit code及生产/模拟composition。不要实际连接SSH/WSL，不安装新包或初始化Git，不改Gemini视图，不自行进入真实验收。完成交主控。
```

## P7 — Gemini：A 布局界面（可与 P2—P6 并行）

```text
你负责训练监控器的T7前端具体实现，不重做方案。工作区 D:/Project/Process Monitoring。用户已选A布局（左宿主/任务、右进度/资源/日志）；已确认Electron与跟随系统主题默认。T1已经提供可运行桌面、window.monitor接口和mock。Luna同时做后端，不要越目录改它的代码。

阅读：
docs/superpowers/specs/2026-10-18-training-monitor-design.md，尤其第5/7/8节；
docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 全局约束、T1的冻结API、T7；
docs/drafts/window-design.md只作为视觉参考，任何矛盾以正式稿为准；
src/shared/api.ts、contracts.ts与src/mocks的真实接口。

必须使用这两个用户指定的前端skills：
C:/Users/noahx/.config/magpie/library/skills/frontend-design/SKILL.md
C:/Users/noahx/.config/magpie/library/skills/design-taste-frontend/SKILL.md
同时使用 C:/Users/noahx/.codex/skills/test-driven-development/SKILL.md 和 C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md。
将设计skill用于高密度工程桌面，用户已定布局/只读范围优先；不要做营销页、展示大标题或增加第二套布局。

只可修改 src/renderer/**、tests/ui/**、tests/desktop/ui.spec.ts。不改package/lock/构建配置/src/shared/src/mocks/desktop/采集与存储，不自行安装依赖；需要接口或fixture变化，给主控具体提案，由Luna单写。

实现A布局及计划组件：顶栏连接/最后同步，左多宿主任务，右双轨进度/检查点/资源、虚拟日志和证据抽屉、登记/主题设置。null显示未知不显示0；断线表述“上次观测…当前待确认”，未探测WSL不显示空闲；检查点不写保存成功/可恢复；device/process资源明确分开。所有mock持续标“模拟数据”。日志时间原样，ingestedAt独立列。

使用已安装TanStack Virtual与纯CSS主题token，遵守10,000条/8MiB UTF8载荷/每条64KiB，增量preview按eventId upsert；不能无限缓存。上滚/选中文字锁滚动，恢复按钮和新条数；Space只在日志焦点且不在输入/IME/选区时生效。Ctrl+F、Ctrl+R、Ctrl+1~9、取消旧搜索/订阅清理、500条/1MiB分页，文字搜索明确本机留存范围。只调用冻结MonitorApi，不碰Node/IPC原语或shell。无日志HTML/ANSI链接/OSC剪贴板解释。

测试先写行为红测再实现，按T7跑tests/ui和真实Electron ui.spec.ts；滚动几何不能靠jsdom假布局证明。验收1200×800/960×650与明暗两主题、键盘/IME/选区/搜索切任务；小窗收折左栏、指标双列。使用系统字体、tabular-nums、完整路径复制、低频polite状态播报，日志行不逐条live播报。

完成后交主控：文件清单、实际命令/exit code、两主题/两尺寸截图、未验证项和必要接口提案。不要只返回设计说明，不连接真实主机、不初始化Git、不进入后续阶段。
```

## P8a — Luna：production 组合的离线集成

```text
你负责T8离线集成验证。工作区 D:/Project/Process Monitoring。T6与T7已交付。先读正式稿 docs/superpowers/specs/2026-10-18-training-monitor-design.md 第9节全部验收场景、docs/reviews/design-review-response.md、实施计划 docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 的T8与全局约束。
使用 C:/Users/noahx/.codex/skills/test-driven-development/SKILL.md 和 C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md。

本轮先只添加/运行tests/simulations、tests/desktop/integration.spec.ts及docs/reviews/integration-results.md，不混改product代码；DeepSeek正在同一冻结快照做独立审查。发现问题给主控定位和可复现输入，等主控将修复分配给原负责人，再重跑相关验证。不要为制造红测改坏代码；已有等价测试可引用真实断言。

关键：使用真实createProductionApi/createCollector/openStore组合，仅transport/时钟/文件为fake；不能只测mock API。禁止任何真实SSH/WSL/训练调用。覆盖正式稿第9节、r2四阻塞与六条交接：首次201B、>2^53、CR/UTF8崩溃重开、CAS迟到重叠、copytruncate长回、新代0、旧H=C unknown/归档补全无gap、同run停采/新run复用/绑定撤销、缺强键资源、源/宿主隔离、200MiB多窗口补读、7天/容量/磁盘失败不推进C、renderer畸形IPC/导航/日志HTML、搜索取消/长期追加、关闭无训练信号。

运行test:simulations、desktop integration；完成修复后按T8要求typecheck、全量test:unit、test:runtime、相关desktop、test:packaged。报告场景->测试文件/名称、实际命令/exit code、未覆盖/降级、payload限额与实际RSS/DB/WAL测量的区别。不得安装依赖、初始化Git或连接真实主机。报告只写docs/reviews/integration-results.md，不进入T9。
```

## P8b — DeepSeek：独立实现审查

```text
你是未参与本轮实现的独立代码审查员。工作区 D:/Project/Process Monitoring。目标是审查真实实现是否满足已确认r2，不是再审设计或用喜好阻塞。

先读：
docs/superpowers/specs/2026-10-18-training-monitor-design.md；
docs/reviews/design-review-response.md（四阻塞闭合与六条实现交接）；
docs/superpowers/plans/2026-10-18-training-monitor-implementation.md，尤其T8；
实际package/lock/scripts、src/shared、desktop、logs、store、registry、transport、probe、domain、parsers、collector、renderer与对应测试；
docs/reviews/integration-results.md若已经产出（尚未产出就明确，不等同通过）。
使用 C:/Users/noahx/.codex/skills/code-review/SKILL.md 与 C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md。当前无Git仓库时用明确文件范围审查，不初始化仓库、不虚构base/head SHA；用户只读限制优先于通用skill。

重点核对：Electron实际SQLite worker/打包兼容；renderer权限/窄IPC/导航/日志文本；realpath打开后身份、无shell注入/跨目录/组员详情；仅自有有限探针收束、无训练控制；原始字节事务/CAS/截断换代/CR UTF8 carry；日志绑定窗口/新run重置/同run离线stale/撤销重算/基线同run；元数据优先及host/source隔离；TTL/容量/磁盘失败/分页搜索有界；UI空格IME/选区/取消/来源隔离。

允许运行计划现有的离线测试命令（临时appData、fake transport）。不安装依赖、不连接SSH/WSL/网络，不读取实际训练文件、不运行任何真实探针、不改产品代码/正式规范/他人测试。不要因运行条件缺失而声称失败或通过，写明未验证及其影响。识别实质bug应给出绝对文件路径+行号、具体输入/前后行为/影响、最小修复方向；一般建议单列。

只创建或更新 docs/reviews/implementation-review.md，Status为Approved或Issues Found，包含按严重性排列的问题、场景核对表、已执行命令/exit code、无法验证事实和非阻塞建议。若实现代码在审查期间变化，说明范围并向主控要求固定快照，不审查漂移版本。写完重新读取核实报告后交主控；不要自动修改实现或宣布产品已交付。
```

## P9 — Luna：Windows 发布构建与交付说明

```text
实施T9的本机构建/交付部分。工作区 D:/Project/Process Monitoring。读取正式稿 docs/superpowers/specs/2026-10-18-training-monitor-design.md、实施计划 docs/superpowers/plans/2026-10-18-training-monitor-implementation.md 的T9和完成条件，以及docs/reviews/implementation-review.md、integration-results.md的实际结论。只有主控确认T8实质问题已处理后执行。
使用 C:/Users/noahx/.codex/skills/verification-before-completion/SKILL.md；若发现需修bug，先向主控交可复现问题，由原负责人按test-driven-development处理，不绕过审查。

本任务先不连接真实SSH/WSL；真实个人任务的2分钟有界只读观测由主控按T9执行并提供实际记录。你负责npm run package:win、zip解压独立临时目录的canary/demo启动、单实例/关闭/重开/主题/本地配置检查、资源及DB/WAL测量，生成可运行Windows x64 zip。无安装器/签名/自动更新要求，不发布公网。

可写README.md、docs/releases/v1-validation.md、生成release产物；产品修复需主控明确分派，不自行改Gemini视图或训练文件。真实验收记录尚未给到时保持“待主控实测”，不能把模拟通过写为已监控服务器。

README说明VS Code只用于开发，用户平时直接打开桌面程序；第一次确认登记、现有SSH正常登录/known_hosts前提、未运行WSL不启动、unknown进度和最后观测、7天与容量提前淘汰、关机后仅补仍可得日志/无过去资源、缓存绝对位置与卸载范围、关闭不控制训练。不给用户新增账号/密码/云服务流程。

完成后报告可运行zip和说明文件的真实绝对路径、大小、构建/解压运行的准确命令与exit code、实际版本、已验证与未验证。主控提供真实只读记录后再补齐同一v1-validation文档，不能宣布未做的实测通过。不要初始化Git或改训练环境。
```

## 失败后的派修格式（主控填写具体证据再发送）

不用让原模型“重新检查一遍”而不给输入。主控应在原任务里发送：审查问题编号、已核对的文件/行、最小重现、违反正式稿/计划哪条、允许修改文件、要补的行为断言、要重跑的命令。仍维持原任务API和只读限制，改完给实际diff与结果。涉及共享API则Luna单写并告知Gemini，不并发改接口。

以上为实施任务提示词，实际已派发项和结果见实施记录。制定计划时已发送给Luna的两条只读建议提示词，另见 [协调记录](../../reviews/design-alignment.md) 的实施计划准备章节。
