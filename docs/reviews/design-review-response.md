# 训练监控器：r1 审查处理与 r2 复核说明

日期：2026-10-18。对象：`docs/reviews/design-review.md` 中 DeepSeek 对 r1 的审查。原报告保持不变，原结论仍为 **Issues Found**。下表表示主控在正式稿 r2 的修订；DeepSeek 随后的独立复核已确认四项闭合，结论 **Approved**，见新报告 `docs/reviews/design-review-r2.md`。

正式稿：`docs/superpowers/specs/2026-10-18-training-monitor-design.md`。本轮只处理设计文档，没有连接服务器/WSL、运行探针/训练、安装依赖或写产品代码。

## 四项阻塞意见

| 原问题 | 核对结论与 r2 修订 | 正式稿位置 | 复核要点 |
| --- | --- | --- | --- |
| 1. 单源故障与同宿主退避冲突 | 接受。分开 host/source 错误分类、失败计数和 retryAt。无阶段证据的命令超时先作为当前请求/源失败，再做独立有界宿主探测；不能凭单日志超时就判整个宿主断线。到期状态/资源优先于日志重试，保留其他成功源。 | §6.4、§8 HostSnapshot/LogSourceSnapshot | Flow 超时但 Score 可读时，Score 不继承 Flow 的退避；单个 in-flight 仍可能造成至多本次请求的有界等待，不承诺精确实时刷新。 |
| 2. 首次导入、行边界与 offset 不闭合 | 接受。统一 `[start,end)` 原始字节区间；首次固定 EOF=E、S=max(0,E−5MiB)、G=C=S，完整入库 `[S,E)`。首段保守标不完整，显示截断不丢原字节。C 是原字节连续入库位置，允许未完成行；原始块、解析状态、事件及 C 同事务提交。CAS 防迟到/重叠响应重复写入。 | §6.1、§6.2、§8 CursorState/LogEvent | E=100MiB、S=95MiB、LF 在 S+200 时，首条含 LF 共201字节，下一条从 S+201 开始；最终 C=E。CRLF/UTF-8 跨批、超长行和崩溃不靠行尾推进游标。 |
| 3. 同 inode copytruncate 无状态转换 | 接受。锚点失配/截断等先进入持久化 reconciling，保留旧 C/H，禁止用旧 C 接收可疑新文件。允许候选归档有界补旧代次；随后同事务封存旧代次、记缺口决定、创建新 UUID、G=C=0、重置新解析状态和绑定。新文件从0读，不套首次5MiB。 | §6.2、§8 CursorState | C=8MiB、重写后10MiB不能跳过新0—8MiB。已知旧 H=10MiB 且旧8—10MiB确实不可得才确认该段 gap；旧 H=C 时未知。归档能补完整则无 gap，但新代次仍须读取。 |
| 4. Progress.runId 无生成和归属规则 | 接受。runId 由 hostId/taskId/bootId/pid/startTicks 的规范元组确定；只对已确认主训练实例生成，queue/workers 不生成训练 run。独立 RunBinding 将可验证字节范围关联到 run。历史前缀不凭路径/mtime 嫁接；新实例重置当前进度；重开同实例保留旧绑定的 stale 观测，但停采期间补读不能自动刷新进度。 | §4.4、§5.2、§8 Progress/TaskSnapshot/RunBinding | 主机重启/PID 复用必为新 run；新 generation 不自动意味着新 run，也不继承旧日志绑定。缺当前 run 基线时全局派生值仍 null；原始日志照常可看。 |

## 原六个模拟场景的预期判定

以下是设计桌面推演，不是真实服务器测试。独立 r2 检查结果见 `revision-r2-review.md`；原审查员也已重新推演这六个场景，结果见 `design-review-r2.md`，均通过。

1. **Flow 日志超时，Score 状态可读**：Flow 源单独退避；独立宿主探测和 Score 状态可继续，不沿用 Flow 的 retryAt。
2. **100MiB 日志首次从95MiB半行开始**：S 后201字节全部保存，半行标识只影响展示；后续连续提交到 E，从 E 续读。
3. **同 inode 截断并长回10MiB**：先 reconcile；完成旧代次处理后新 generation 从0开始。确认缺口需旧未提交区间及不可得证据，不能把新 size 当旧 H。
4. **PID 数字复用，旧 n=80106 仍在缓存**：bootId/startTicks 变更生成新 run；旧进度保留为旧证据，不用于当前进度。日志/基线不能归属当前 run 时归一化字段 null。
5. **Score cwd=/home/cy，无 queue.lock，但个人入口及当前等待证据相符**：可为 queued；不把 cwd/持锁作为必须同时成立的门槛，不显示已经训练。
6. **SSH 在线，Score training.log 尚未生成**：该源 missing、30秒重查；不把宿主标 disconnected，不把任务标 failed。

## 非阻塞建议的处理

- 锁字段统一为 `queueLock.exists/heldByRegisteredProcess`，附来源及 Stamp；打开 fd 不等于持锁。
- 检查点身份、稳定样本次数/时间明确为内部状态；UI 不用 path/mtime 冒充文件身份。
- HostSnapshot 增加 Stamp，并明确15秒采集周期两倍后的 stale 规则。
- 登记仍使用已校验本地配置；不新增复杂配置编辑器或任意命令输入。
- 清理顺序固定为 TTL → 内容容量淘汰 → 磁盘空间/当前写入预算；不清远端数据。

## 仍然成立的限制

有限锚点不能证明全文件连续：同 inode 快速覆盖且所有采样恰好相同时可能检测不到。直接可写 fd 加连续窗口只提供有限归属证据，不证明排他写入；发现矛盾撤销归属。间接 tee、无法读取进程身份/fd、缺同 run 启动基线等场景可出现日志可读而进度未知，这是明确降级，不靠猜测补齐。

未实测性能、权限及传输能力；未验证权重可恢复性；历史 PID/进度不是当前状态。用户已于2026-10-18确认完整r2及Electron、主题、导入与缓存等暂行默认；这不等于已经实现或真实环境验证。

## 审查状态

- DeepSeek r1：**Issues Found**，原报告保留。
- 主控 r2：已逐项修订；主控已回读 Luna 与 DeepSeek 两份 r2 报告，核实状态、四项闭合及六个场景。
- Luna r2：**Approved**，未发现新阻塞；四项规则及六场景仅作桌面推演，见 `revision-r2-review.md`。
- DeepSeek r2：**Approved**，四项已闭合、六个场景一致，另作迟到重叠响应、停采重开和转换事务崩溃等桌面推演，无新增阻塞。D 已完成，不需重发。
- 用户完整设计确认：已完成，原话“确认，暂时按这样处理”。主控已形成实施计划，待用户核对计划后开始编码。

## 非阻塞建议向后续计划的交接

以下六项来自 DeepSeek r2 的一般建议。主控已核对，它们细化现有规则，不改变产品范围，不需要重新进行一轮设计审查。现已落实为实施计划T2/T5/T8的接口与测试要求；本节仍只是审查交接，不是已实现行为。

1. 新 run 重置 Progress 时同时设置 `bindingIds=[]`、`baselineEvidenceId=null`，避免旧证据引用残留。
2. 代次转换中的“稳定”指身份、锚点及读取前后一致性；正常追加导致 size/mtime 改变不要求等待文件停止增长。
3. 已由单独 CR 终结的 tqdm 重绘记录也纳入可绑定的完整记录；pendingCR 未决时仍不是完整记录。
4. 定义 RunBinding 的有效/撤销状态或等效删除语义；撤销后立即重算受影响进度，证据不足则置 null，不继续展示被撤销证据派生的有效数值。
5. 不把初始未关联历史重新追认为当前 run。窗口开启后才读取到某段旧字节，不足以改变这条限制；结构化记录证据同样遵守观察窗口与可验证归属范围。
6. 进程资源缺启动标识时不构造弱 ProcessKey；该进程级指标保持缺失/省略，设备级读数如有则独立展示，不能冒充该进程指标。

后续顺序：完整r2已确认 → writing-plans计划及P系列提示词已完成 → 用户核对计划 → T1 → T2—T6与T7并行 → T8模拟/独立代码审查 → T9有限只读实测与交付。当前未派发实现任务。计划见 `docs/superpowers/plans/2026-10-18-training-monitor-implementation.md`。
