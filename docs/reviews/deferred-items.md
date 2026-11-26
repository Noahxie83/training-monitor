# 实施审查的非阻塞事项

供T8最终独立审查统一分诊。此表记录原发现，不能据此断言后续HEAD仍有同一问题；请核对最终代码与实际证据。不得为Minor单独开启各任务修复循环。

| 来源 | 原发现 | 当前处理 |
| --- | --- | --- |
| T1原审查 | 最小窗口尺寸、mock没有日志流、生成目录忽略规则 | 已分别纳入T1修复及mock readiness；最终审查核对保留效果，不重开原审查 |
| T1 / dependency audit | 8个moderate依赖记录属于构建链；author/description及react-dom打包警告 | 固定版本和本地未签名zip已裁决保留；T9对最终实际ASAR哈希重查运行包边界，保留构建主机风险，不编造作者信息 |
| Mock readiness | getLogs返回原fixture对象，直接消费者可修改缓存 | 防御性隔离建议；没有当前消费者修改的证据，待最终HEAD核验 |
| Mock readiness | NO_COLOR与FORCE_COLOR测试输出警告 | 不影响已有测试结果，非功能阻塞 |
| T2 M1 | 多字节64KiB边界及parser JSON roundtrip覆盖较薄 | 后续新增测试可能部分覆盖，T8按最终实际断言分诊，不单开修复循环 |
| T3 M1 | 失败断言后store未统一关闭，出现额外EBUSY清理噪声 | 第1轮要求回归测试不得遗留worker，但不将本项另算阻塞；核对实际失败路径 |
| T3 M2 | 部分测试覆盖声明超出断言：pendingCR/非法UTF8、seal完整回滚、未retain时TTL隐藏 | 报告须诚实区分；最终按具名断言核验，不把历史自报当作证明 |
| T4 M1 | Windows transport symlink 用例直接 return，却计入 passed | 建议使用明确平台 skip，最终按实际 runner 区分执行与跳过；不单开修复循环，不因此连接真实Linux |
| T7 M1 | 防御性UTF8切片可能重新编码为超过64KiB | 原审查非阻塞；待Gemini修复后的实际HEAD核验 |
| T7 M2 | UTC格式化后省略时区标记 | 原审查非阻塞；待最终HEAD核验 |

原始证据：

- [T1审查](../../.superpowers/sdd/2026-10-18-training-monitor-implementation/task-1-review-report.md)
- [Mock readiness审查](../../.superpowers/sdd/2026-10-18-training-monitor-implementation/mock-readiness-review-report.md)
- [T2审查](../../.superpowers/sdd/2026-10-18-training-monitor-implementation/task-2-review-report.md)
- [T3审查](../../.superpowers/sdd/2026-10-18-training-monitor-implementation/task-3-review-report.md)
- [T7审查](../../.superpowers/sdd/2026-10-18-training-monitor-implementation/task-7-review-report.md)
- [依赖审计与主控裁决](dependency-audit.md)

另有必须在T6/T8关闭的跨任务接口缺口：物理DB/WAL占用目前无公开快照字段。该项不是Minor，也不是T3/T7额外修复循环。2026-10-19只读预检后，主控已批准`MonitorSnapshot.cache?`四字段最小方案（`observedAt/freshness/databaseBytes/walBytes`）；精确null/零/旧样本与单写边界见[task-6-dispatch.txt](../../.superpowers/sdd/2026-10-18-training-monitor-implementation/task-6-dispatch.txt)。T6落地后由Gemini在T8接界面，最终核验真实计量和展示。批准提案不等于当前已经实现或关闭。

T5独立审查（2026-10-20）：T5-M-02（hostBootId验证/哈希空白规范化）保留为Minor，在T8最终HEAD与T4端到端规范键约定一致核验；不在T5第1轮单独修改域层键导致上下游不一致。T5-M-01解析器泛化精度已与本轮R-01/I-02的实质修复重合，按该修复实际结果核验，不另开Minor修复循环。
