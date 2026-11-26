# 模型分工与下一轮提示词

当前阶段：用户已确认完整 r2 及 [实施计划](superpowers/plans/2026-10-18-training-monitor-implementation.md)，主控已自主派发Luna的P1/T1。[P1—P9完整提示词](superpowers/plans/2026-10-18-training-monitor-prompts.md) 和 [实际进度](reviews/implementation-progress.md) 已保存。DeepSeek D 与 Luna r2 独立检查均为 Approved；A/B/C/D 不需重发。正在运行的训练不参与开发试验，有限只读实测安排在离线验证与代码审查之后。

最新用户反馈：“确认”，批准具体实施计划。T1正在Luna实施；接口和可运行mock经审查后冻结，再让Luna T2—T6与Gemini T7分目录并行；之后DeepSeek T8独立实现审查。不重复要求用户确认既定方案。

最新调度与制定计划时实际发送给 Luna 的只读建议提示词见 [设计对齐记录](reviews/design-alignment.md)；草图任务提示词见 [草图派发记录](mockup-session.md)。下面 A/B/C/D 全部是已完成的历史模板。下一轮应使用新的P系列提示词，不能从历史模板直接开始写代码。

## 调度约定

- 主控：整理需求、确定模块边界、维护设计稿、整合结果和最终验收。
- GPT-6-luna：采集、任务状态、日志及存储的设计与后续实现。
- Gemini 3.8 Flash：桌面窗口的界面方案及后续前端实现。
- DeepSeek V4.1 Flash：独立审查、模拟场景和后续测试；有明确边界时也可承担实现任务。
- Claude：默认不分配任务。

当前会话已成功使用 GPT-6-luna 子代理。直接派发 DeepSeek 的一次尝试被跨供应商子代理设置拦截，不能把它算作已完成的审查；Gemini 初稿由用户在另一个模型会话完成，本主控未直接调用 Gemini。跨供应商任务可由用户在 Codex 中选择相应模型，粘贴提示词。现阶段不需要更换编辑器或额外购买工具。

## 已完成的设计阶段发送顺序（历史）

1. A/B 初稿、主控 r1 合并、Luna r1 检查和 DeepSeek C 审查均已完成。
2. 主控让两位 Luna 分别只读分析日志与 runId 问题（可并行），自行整合为 r2；随后由全新 Luna 顺序检查固定的 r2，结果写 `docs/reviews/revision-r2-review.md`。
3. D 已由用户发送并完成；DeepSeek 的新报告在 `docs/reviews/design-review-r2.md`，结论 Approved。原 r1 报告保留。Gemini 继续等待，不重复改窗口草案。
4. 主控已核实两份 r2 报告，将完整设计交用户核对。完整设计确认后，先使用 `C:\Users\noahx\.codex\skills\writing-plans\SKILL.md` 制定实施计划，再按计划给出新的分阶段任务与提示词。

实施阶段的并行顺序、精确文件/API、验证命令和skills已写入新的计划与提示词。现有前端/TDD/验证/代码审查skills足够，不需额外下载skill或更换VS Code。

## A：GPT-6-luna，数据与采集设计

```text
你负责训练监控器的数据与采集设计，本轮只写设计文档，不实现产品。

工作区：D:\Project\Process Monitoring
先完整阅读：D:\Project\Process Monitoring\docs\requirements-and-evidence.md
使用 skill：C:\Users\noahx\.config\magpie\library\skills\brainstorming\SKILL.md
主控已开展需求访谈；不要重复已回答的问题。把必须由用户回答的新问题集中交给主控，日常实现选择提出有理由的默认方案并标明为你的建议。

仅可创建或修改：D:\Project\Process Monitoring\docs\drafts\data-design.md
不修改训练材料，不连接服务器，不运行代码，不安装依赖，不创建应用脚手架。

设计 Windows 独立桌面监控器如何只读采集 WSL 与 SSH Linux 任务，重点覆盖：
1. 登记个人任务、规范化路径、工作目录与真实入口不同的情况、进程实例身份和子进程归并。
2. 任务运行状态与采集连接状态分别表示；每种状态列证据、可信程度和降级行为。
3. 累计步数、本轮进度、目标与检查点证据的统一数据字段；不要把所有算法套同一偏移公式。
4. 增量日志的文件身份、offset、轮转/截断/重连、中文与回车刷新、批量补读和本地7天留存。明确首次读取、留存计时与磁盘上限的建议。
5. 本机与远端的职责、SSH凭据复用、读取预算，以及关闭窗口/崩溃不会终止训练的生命周期。
6. 给前端的最小数据契约草案、错误示例和模拟验收场景。

不要用加载权重验证进度，不添加训练启动/停止功能，不部署服务器常驻服务。
交付：设计文档，以及在回复中列出关键选择、未决问题和前端需要遵守的约定。不得把推测写成已核验事实。
```

## B：Gemini 3.8 Flash，桌面界面设计

```text
你负责训练监控器的桌面界面设计，本轮只产出界面说明，不写产品代码。

工作区：D:\Project\Process Monitoring
先完整阅读：D:\Project\Process Monitoring\docs\requirements-and-evidence.md
使用 skills：
C:\Users\noahx\.config\magpie\library\skills\frontend-design\SKILL.md
C:\Users\noahx\.config\magpie\library\skills\design-taste-frontend\SKILL.md
C:\Users\noahx\.codex\skills\ui-ux-pro-max\SKILL.md

这是长期打开的训练监控桌面工具。frontend-design 和产品任务决定信息层级；design-taste-frontend 中面向营销落地页的英雄区、装饰图和布局规则不能直接套用。应保留必要的密集数据、表格、进度与日志。

仅可创建或修改：D:\Project\Process Monitoring\docs\drafts\window-design.md
不修改其他文件，不连接服务器，不安装依赖，不创建桌面或前端脚手架。本轮不要生成可运行原型；可视草图由主控获得用户同意后另行安排。

围绕独立桌面窗口提出一个推荐布局，并说明：
1. 用户如何同时看到WSL/服务器、Flow训练、Score排队与Reflow未启动。
2. 如何清楚区分累计/本轮进度、训练step/检查点文件step、任务状态/连接状态。
3. 日志查看、搜索、暂停自动滚动、补读进度、缺口与最后更新时间怎样呈现。
4. 电脑重启后的恢复过程，离线、加载、证据不足、空任务与错误状态。
5. 中文、数字可读性、键盘操作、颜色之外的状态区分、长路径与小窗口适配。

只给与监控目的有关的页面和交互，不增加账号系统、云服务或训练控制按钮。
交付：布局说明、文本线框、关键组件与状态表、前端所需字段、建议的视觉方向及其理由。技术栈和主题偏好如未确认，应明确写为建议。
```

## C：DeepSeek V4.1 Flash，独立设计审查

历史任务，已发送并完成，结论 Issues Found（4项阻塞）。以下保留原提示词用于追溯，不再发送；下一轮使用 D。

```text
你是独立设计审查员，不参与实现，也不直接改设计稿。

阅读：
D:\Project\Process Monitoring\docs\requirements-and-evidence.md
D:\Project\Process Monitoring\docs\superpowers\specs\2026-10-18-training-monitor-design.md
D:\Project\Process Monitoring\docs\reviews\buildability-review.md

使用审查模板：
C:\Users\noahx\.config\magpie\library\skills\brainstorming\spec-document-reviewer-prompt.md
使用 skill：C:\Users\noahx\.codex\skills\verification-before-completion\SKILL.md

仅可创建或修改：D:\Project\Process Monitoring\docs\reviews\design-review.md
不连接服务器，不运行训练或采集程序，不安装依赖。

判断设计能否直接进入实施计划。检查需求完整性、内部矛盾、接口不一致、会导致实现偏离的歧义，以及用户未要求的扩展。
特别核对：个人任务识别与路径/链接边界；Score cwd在/home/cy且持锁不是排队必要条件；PID复用和工作进程归并；续训计数边界；检查点文件证据不等于保存成功；首次每源尾部5MiB与后续从游标补读的区别；64MiB额度后自动续读；轮转/copytruncate与确认缺口的证据；7天按本地入库时间计时及缓存容量范围；主机在线但单源失败；字段新鲜度；关窗不影响训练；独立桌面形态。

正式稿优先于作者草案。Electron代替Tauri、主题默认跟随系统、日志5秒/身份资源15秒、首导入5MiB是主控待用户批准的明确设计提案，不把它们说成用户已经确认，也不单因与草案不同判错。不要要求在这轮审查中实测真实训练或把未验证的算法语义补为已知。不要为了审查安装新skills；上面本地文件已存在。

给出至少3个能揭示实质问题的模拟场景。将阻碍实施的问题与一般建议分开，不为风格偏好或假想风险阻塞。每个问题给出对应章节、具体矛盾及影响。
输出状态：Approved 或 Issues Found；把不能从现有证据确定的事实列明，不能自行补成事实。
```

## D：DeepSeek V4.1 Flash，r2 设计复核

历史任务，已由用户发送并完成，结论 Approved。报告在 `docs/reviews/design-review-r2.md`；以下保留实际提示词，不需重发。完整设计仍待用户确认。

```text
你继续担任独立设计审查员，复核主控对你上一轮4项阻塞的修订。本轮只审查设计，不写产品代码，不直接修改正式稿。

工作区：D:\Project\Process Monitoring
完整阅读：
D:\Project\Process Monitoring\docs\requirements-and-evidence.md
D:\Project\Process Monitoring\docs\reviews\design-review.md
D:\Project\Process Monitoring\docs\superpowers\specs\2026-10-18-training-monitor-design.md
D:\Project\Process Monitoring\docs\reviews\design-review-response.md
D:\Project\Process Monitoring\docs\reviews\revision-r2-review.md

使用审查模板：
C:\Users\noahx\.config\magpie\library\skills\brainstorming\spec-document-reviewer-prompt.md
使用 skill：C:\Users\noahx\.codex\skills\verification-before-completion\SKILL.md

唯一可创建或修改文件：D:\Project\Process Monitoring\docs\reviews\design-review-r2.md
保留原 design-review.md，不修改其他文件。不连接服务器/WSL/网络，不运行训练、探针或产品程序，不安装依赖，不搭脚手架。

以正式稿 r2 为准，不因为主控或 Luna 说已解决就直接批准。逐项核对以下规则是否真的闭合，并找出修订引入的实质矛盾：
1. §6.4：host/source 错误分类、独立 retryAt、无阶段证据的超时如何处理、单 in-flight 下状态优先，是否避免单源退避扩散。
2. §6.1/6.2/8：首次 S/E、半开区间、committedOffset 原字节语义、首段半行、UTF-8/CRLF/长行、事务及迟到重叠响应，是否仍可能重复或漏读。
3. §6.2：同 inode copytruncate 且新 size 已超过旧 C 时，reconciling、旧归档补读、旧 H 与确认/未知 gap、新 UUID 从0读取及原子切换是否一致；不得要求有限锚点证明所有覆盖。
4. §4.4/5.2/8：runId 生成、强实例变化、queue/workers 排除、RunBinding 的字节范围、停采重开、同 run 基线及 null 降级，是否仍可能把旧进度嫁接给新训练。日志 generation 与训练 run 必须分别判断。

重新推演你原来的6个场景，逐项给预期行为与依据：单源失败；100MiB首次从95MiB半行导入；同inode截断再长到10MiB；PID复用且有旧进度；Score cwd=/home/cy且无锁；宿主在线但training.log未生成。另按需补充能揭示新问题的场景，不增加真实环境测试。文档推演不得写成实测。

输出 Status: Approved 或 Issues Found。用表逐项写原问题“已闭合/未闭合”及章节依据；真实阻塞项给具体矛盾、影响和最小修订方向。一般建议单列，不因措辞或个人偏好阻塞，也不要为了完美证明扩大v1范围。说明无法验证的事实与剩余限制。

Electron、主题跟随系统、5秒/15秒轮询、首次5MiB和缓存预算仍是待用户批准提案。r1旧Approved不替代本轮检查；本轮批准只代表可以进入计划，不代表用户已批准开发或真实训练测试通过。
写完请重新读取报告核实状态、四项结论和六个场景，再简要回复结果。
```

## Skills 是否需要补充

现有 skills 足以支持需求梳理、前端设计、并行工作、代码审查、调试和验收，本轮不需要从网上安装新包。正式设计确认后，主控先使用 `C:\Users\noahx\.codex\skills\writing-plans\SKILL.md` 制定实施计划，再按各任务选用对应技能。

本地 brainstorming 的正文引用 `builder-check-prompt.md`，该文件未找到；同目录现有 `spec-document-reviewer-prompt.md` 可用于正式设计的独立审查。上面 C 已使用实际存在的文件路径，不要求模型读取不存在的文件。
