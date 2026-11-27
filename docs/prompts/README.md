# Training Monitor 全面重构与审美升级 — 执行端提示词套件

本目录包含面向执行端 AI 编程代理的 **4 阶段独立可执行提示词**。所有需求均已基于全仓代码静态审计、实机截图审查及架构评审对齐完毕。

## 为什么拆分为 4 个阶段？

当前项目同时存在四类交织问题：**普适性硬编码**、**探针/传输/采集/自动启动结构性缺陷**、**前端视觉与信息密度严重落后**、**桌面端常驻与工程债务**。若一次性全量改造，极易导致跨层契约断裂、单次上下文超载或 UI 与后端互相阻塞。按以下顺序逐阶段推进，每阶段均可独立编译、测试并提交 Git 检查点：

| 阶段 | 提示词文件 | 核心目标 | 建议 Commit 前缀 |
| :---: | --- | --- | --- |
| **Phase 1** | [`01-universality-and-transport.md`](./01-universality-and-transport.md) | 全面去硬编码（任意 SSH/WSL/`local` 宿主、去个人路径与算法锁死）、SSH 长连接复用 JSON-RPC 常驻探针、多宿主并发与退避、配置 v1→v2 无感迁移、NVIDIA `[N/A]`/MIG 修复与无卡降级 | `feat(transport,registry): ...` |
| **Phase 2** | [`02-probe-telemetry-autostart-store.md`](./02-probe-telemetry-autostart-store.md) | 通用 ML 进程树归属（DDP/`torchrun`/`python -m`/`tee`/超 128 FD/`eofBytes` 修复）、通用指标解析与目录级 Checkpoint、多卡任意命令自动启动与主机级排队 GC、SQLite v2（时序表+FTS5+读写分离）、异常检测告警、一键进程发现与可选远程作业控制 | `feat(probe,store,launch): ...` |
| **Phase 3** | [`03-frontend-aesthetic-redesign.md`](./03-frontend-aesthetic-redesign.md) | 前端视觉审美彻底重塑（现代精密工程观测台风、本地打包 `Inter`+`JetBrains Mono`、`lucide-react`、浅深色统一布局、三层明度表面、GPU 集群汇总+双进度条+负载色阶+趋势折线图、ANSI/搜索高亮/原地刷新的日志终端、表单与抽屉重构、中英双语 i18n、Electron 无边框融合标题栏、更新 `DESIGN.md` 与多分辨率截图验收） | `feat(ui): ...` |
| **Phase 4** | [`04-desktop-resilience-and-hygiene.md`](./04-desktop-resilience-and-hygiene.md) | 系统托盘与关闭最小化后台常驻、多屏安全窗口几何记忆、CSP 修复与 React `ErrorBoundary`、配置损坏隔离恢复、跨平台打包与 CI、全仓死代码与根目录残留彻底清理、全链路最终验收 | `chore(desktop,ci): ...` |
| **Phase 5a** | [`05a-backend-desktop-fixes.md`](./05a-backend-desktop-fixes.md) | **收官复核修复（后端/探针/自动启动/桌面端/测试，建议 Codex）**：修 Checkpoint 字段错位、ANSI/`\r` 字节校验、`log_only`/`inferred_tree` 进度、共享锁 `EXDEV`、`restart` 故障、`main.ts` 刷新卸 IPC、Windows Python/Desktop 测试全绿及物理清理根目录脏文件 | `fix(core,desktop): ...` |
| **Phase 5b** | [`05b-frontend-polish-and-wiring.md`](./05b-frontend-polish-and-wiring.md) | **收官复核精修（前端交互/双语/对比度/小屏微调，建议 Gemini）**：补离线 `forceLocal` 确认弹窗、导出取消态、清零 193 行残留中文与 `GpuMonitor` i18n、修深色 2.77:1 对比度与窄窗/macOS 标题栏重叠、优化 `960×650` 头部紧凑度与 `DESIGN.md` 对齐 | `fix(ui): ...` |
| **Phase 5c** | [`05c-final-windows-tests-and-960px-fix.md`](./05c-final-windows-tests-and-960px-fix.md) | **最终 3 项微修（Windows 测试全绿 + 960px 胶囊防裁切）**：修 `phase4-resilience.spec.ts` Windows `electron.exe` 路径、补 `test_phase2_launch.py` POSIX 守卫、修 `960×650` 自动启动条条件胶囊半字裁切 | `fix(tests,ui): ...` |

---

## 执行端操作指南

1. **严格按顺序执行**：必须先完成 Phase 1 并通过该阶段全部验收命令、创建本地 git commit，再执行 Phase 2，以此类推。
2. **如何喂给执行端代理**：在每个全新会话中，直接让执行端代理完整阅读对应阶段文件（例如：“请严格阅读并完整执行 `docs/prompts/01-universality-and-transport.md` 中的全部改造与验收要求，不要遗漏任何子项”）。
3. **跨阶段契约守则**：
   - Phase 1 确定新 `HostRegistration`（支持 `ssh` / `wsl` / `local`）、`v2` 配置迁移及常驻连接传输接口，Phase 2 在此之上扩展批探测、遥测、时序存储、告警与多卡自动启动 IPC。
   - Phase 3 严格消费 Phase 1–2 的稳定共享契约（`src/shared/contracts.ts`、`src/shared/api.ts`）与后端结构化状态码，不再在前端或远端 Python 写死个人路径与硬编码文案。
   - Phase 4 负责收口桌面壳生命周期、安全防护、打包、CI、测试覆盖与仓库清扫，执行最终全量回归。
4. **全局硬约束（所有阶段共同遵守）**：
   - **禁止静默跳过失败测试**：每阶段结束必须贴出真实命令输出作为完成证据。
   - **保持老用户配置向后兼容**：既有 `version: 1` 的 `registry.json` 与 `preferences.json` 必须通过迁移器平滑升级，不得因升级直接闪退或丢数据；全新安装默认进入干净空态引导（严禁再内置 `lab-campus`、`/data2/cy/xzn` 或原作者个人训练任务）。
   - **严禁引入安全回退**：保持 Electron `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；远端命令执行必须严格参数化/安全转义，绝不将未校验用户输入拼接进远端 shell；远程停止/强杀/重启必须默认关闭、按宿主显式开启并经二次确认。

---

## 全局完成标准（Definition of Done）

四个阶段全部完成后，项目必须同时满足：

- [ ] 任意新用户启动后可直接导入 `~/.ssh/config` 宿主、手动填 SSH 参数、选择本机任意 WSL 发行版或启用本机 `local` 模式，零个人硬编码残留。
- [ ] 可稳定监控任意主流框架（PyTorch / DDP `torchrun` / HuggingFace Transformers / Accelerate / DeepSpeed / Lightning / Ultralytics / 自定义脚本与 `python -m` / `| tee` / 容器与慢步长任务），支持 Loss/LR/Epoch/Step/ETA/Checkpoint 与主机/GPU 完整健康遥测。
- [ ] SSH 采用长连接常驻探针复用与每宿主独立退避调度，不再触发连接风暴或 465 KB 重复上传。
- [ ] GPU 空闲自动启动支持多卡 `N` 张、白/黑名单、任意命令与环境激活、本地临时盘 Socket/锁与 GC 防自毁，且宿主离线不锁死配置编辑。
- [ ] 支持 SQLite v2 时序曲线（Loss/LR/吞吐/GPU 利用率与显存）、FTS5 快速检索、异常检测告警（原生通知 + Webhook）、一键运行进程发现与可选远程作业控制。
- [ ] 前端视觉达到现代工程观测台水准（Linear / Vercel Observability / Grafana 质感），浅深双主题在 `1440×900`、`1280×800`、`960×650` 下经 Playwright 实机截图验收无对比度缺陷、无大面积死空洞、无文字截断碰撞。
- [ ] 支持系统托盘后台常驻、多屏窗口记忆、ErrorBoundary、CSP 合规、中英双语切换、全量 TS/Unit/Python/Runtime/Desktop 测试绿灯以及洁净仓库卫生。
