# Phase 5b 收尾精修提示词：前端交互补全、全量双语收口、对比度修复与小屏微调（建议 Gemini 执行）

> **前置条件**：请先确认 Phase 5a（`05a-backend-desktop-fixes.md`）已完成并提交（特别是 `CHANNELS.exportLogs` 的 `showSaveDialog` 与 `pendingRemoteCancels` 持久化、托盘告警计数同步 IPC）。
> **复核评价**：Phase 3 的整体视觉跃迁非常成功，30 张多分辨率双主题截图已达到现代精密工程观测台水准！本阶段只做**精准查漏补缺与最后 5% 的精致度打磨**，把实机审计发现的所有交互断链、对比度隐患、未国际化文案和小屏紧凑度问题全部清零。

---

## 一、P0 级功能断链修复（2 项）

### 1. 补全离线宿主 `forceLocal` 二次确认弹窗
- **位置**：`src/renderer/hooks/useMonitor.ts:329-341`、`src/renderer/components/TaskEditor.tsx:289-299`、`src/renderer/components/SettingsModal.tsx:653-674`、`src/renderer/App.tsx:103-157`
- **现状**：后端已完整支持 `HOST_UNREACHABLE_RECONCILE` 与 `saveRegistry(next, { forceLocal: true })`，但前端 `src/renderer/` 中零处处理，离线时编辑/停用/删除已托管自动启动的任务直接报原始错误。
- **修复**：
  - 扩展 `useMonitor.ts` 的 `updateRegistry(newRegistry: Registry, options?: SaveRegistryOptions)` 透传 `options` 到 `window.monitor.saveRegistry`。
  - 在任务编辑保存、设置页宿主/任务变更、以及自动启动重新等待/停用/删除任务等入口统一捕获 `HOST_UNREACHABLE_RECONCILE` 错误，弹出精致的双语确认模态框（清晰说明宿主当前失联，确认后将先完成本地修改并自动登记“重连后补发远端取消”），点击确认后以 `{ forceLocal: true }` 重试。

### 2. 对齐 Electron 日志导出反馈与取消处理
- **位置**：`src/renderer/components/LogConsole.tsx:443-457`
- **修复**：配合 Phase 5a 的主进程 `dialog.showSaveDialog`，当 `exportLogs` 返回 `cancelled` 或 `path === null` 时静默取消（绝不误报导出成功）；仅在真实落盘后提示成功并展示保存的文件名/行数（非 Electron 浏览器单测/预览环境继续优雅回退 Blob 下载）。

---

## 二、P1 级重要交互、对比度、i18n 与窗口Chrome修复（7 项）

1. **修复 `SettingsModal.finishEditingHost` 无法撤销开关与重置轮询**（`src/renderer/components/SettingsModal.tsx:440-453`）：
   - 当取消勾选“允许远程作业控制”时显式 `delete nextHost.allowJobControl`；当轮询间隔改回 `5` 秒时显式 `delete nextHost.pollIntervalMs`（与 `handleSaveAll` 行为完全一致）。
2. **修复 `>=1440px` 无曲线数据时隐藏右卡 Tab 栏导致用户被困**（`src/renderer/components/TaskCockpit.tsx:69-71, 373`、`src/renderer/styles/cockpit.css:534-563`）：
   - 仅当 `.cockpit-right-card.is-wide-split` 真正处于双栏并排模式时才隐藏 `.right-tabs-bar`；且在 `useEffect` 中监听 `task?.taskId` 变化自动重置 `userChoseTab` 与 `hasChartData`，彻底避免跨任务切换后被困在空白曲线页。
3. **清零渲染端全部 193 行硬编码中文 & 修复 `GpuMonitor` Provider 位置**（`AutoStartFields.tsx`、`SettingsModal.tsx`、`TaskEditor.tsx`、`task-form.ts`、`GpuMonitor.tsx`、`ResourceMetrics.tsx`、`AutoStartPanel.tsx`、`HostConnectionPanel.tsx`、`useMonitor.ts`、`useLogBuffer.ts`、`utils/format.ts`）：
   - 将 `GpuMonitor.tsx:29` 的 `useI18n()` 与 `status` 计算移入 `<I18nProvider locale={locale}>` 内部的子组件中，使独立 GPU 窗口切到英文后连接状态同步变为英文。
   - 让 `AutoStartFields.tsx` 完整接入 `useI18n()`，并将 `task-form.ts`、`SettingsModal` 校验与发现提示、`useMonitor`、`useLogBuffer`（复用已有 `logs.*` 键）、`ResourceMetrics`、`AutoStartPanel`、`HostConnectionPanel`、`format.ts` 的硬编码中文全部收口到 `zh-CN.ts` 与 `en-US.ts`（确保双语键 100% 对等，切 `EN` 后任意弹窗、表单、提示、日志报错均无残留中文）。
4. **修复深色模式危险按钮悬停与告警徽章 2.77:1 对比度故障**（`src/renderer/styles/tokens.css`、`primitives.css:84`、`layout.css:176`）：
   - 在 `tokens.css` 定义 `--danger-ink`（浅色 `#FFFFFF` 配 `#DC2626` = 4.83:1；深色 `#0B1120` 配 `#F87171` = 7.77:1），替换 `primitives.css:84` 和 `layout.css:176` 的硬编码 `#FFFFFF`。
5. **修复 `AutoStartPanel` 与 `EvidenceDrawer` 剪贴板复制在 Electron 权限锁下失效**（`src/renderer/components/AutoStartPanel.tsx:90-99`、`EvidenceDrawer.tsx:20-39`）：
   - 优先调用 `window.desktop?.copyDiagnosticText`（或 `copyCommand`），仅在非 Electron 环境回退 `navigator.clipboard.writeText`，且仅在写入成功后才置 `copied = true`。
6. **修复无边框融合标题栏在窄 GPU 窗与 macOS 下的重叠**（`src/renderer/styles/gpu.css:611-615`、`src/renderer/styles/layout.css`、`src/desktop/window.ts:210-214`）：
   - `gpu.css:611-615` 在 `@media (max-width: 700px)` 中保留 `calc(12px + env(titlebar-area-*))` 安全区计算，避免“关闭窗口”按钮钻到 Windows 原生最小化/关闭按钮底下；
   - macOS `hiddenInset` 下为顶栏左侧预留 ~78px 安全区（通过平台类或 `titleBarOverlay`），避免应用品牌图标与 macOS 红黄绿交通灯重叠。
7. **修复点击桌面告警通知无法聚焦非当前宿主任务**（`src/renderer/hooks/useMonitor.ts:176-179`、`src/desktop/main.ts`）：
   - 收到 `onFocusTask` 时，根据最新快照解析该 `taskId` 所属 `hostId`（或 IPC 一并下发 `{ hostId, taskId }`），原子更新 `selection.hostId`、`selection.taskId`、`view: 'task'` 与 `rememberedTasks`。
   - 同步在 `markAlertsRead` / `clearAlerts` 中调用 Phase 5a 提供的托盘计数同步接口。

---

## 三、P2 级视觉精细度、交互完整度与无障碍打磨

1. **`960×650` 小窗任务驾驶舱头部紧凑度优化**（实机截图 `cockpit-960x650-dark.png` 发现的问题）：
   - 在 `<= 1024px` 视口下，压缩任务标题区垂直占比（将置信度徽章与算法标签保持紧凑同行或单行省略，自动启动条在窄高窗口下合并为更紧凑的两行），让 `960×650` 下的日志终端至少舒展露出 4–6 行日志而非仅 1.5 行。
2. **补齐作业控制 `Kill (SIGKILL)` 与显式快捷命令菜单**（`src/renderer/components/TaskCockpit.tsx`）：
   - 当 `host.allowJobControl === true` 时，在停止/重启旁（或紧凑下拉菜单中）暴露已实现的 `kill`（强制终止 SIGKILL，复用 `JobControlModal` 二次确认）。
   - 为「终端」按钮增加紧凑下拉选项或快捷复制按钮，显式暴露已有的 `Copy SSH`、`Copy tmux attach`、`Copy tail -f`（复用已存在的 `cockpit.copySsh` / `copyTmux` / `copyTail` 翻译键）。
3. **表单完整度与 UX 细节打磨**：
   - `SettingsModal.tsx` 编辑 SSH 宿主时补齐 `IdentityFile` 与 `ProxyJump` 输入框；Webhook 行增加启用开关与标签编辑；告警数字阈值输入框改用字符串草稿在保存时校验（不再清空瞬间弹回默认值）；点击顶栏“停用宿主”提示按钮时打开 `SettingsModal` 并直达 `'hosts'` 标签页；删除含任务宿主的二次确认改为居中聚焦模态框（不再藏在滚动容器底部视口外）。
   - `AutoStartFields.tsx` 为已接线的 `modules` 补齐可选输入框（Environment Modules），并在 `TaskEditor.tsx` 高级选项补齐可选 `allowCrossUidScan`（允许跨用户/容器扫描）开关，同时在 `task-form.ts` 校验任务目录是否在宿主 `allowedRoots` 内给出前置提示。
   - 在 `I18nProvider` / `App.tsx` / `GpuMonitor.tsx` 随语言切换动态同步 `document.title`（中英文窗口标题）。
4. **代码洁癖、无障碍与文档对齐**：
   - 清理 `src/renderer/` 中 13 个未定义死 CSS 类名（测试钩子类改为 `data-testid` 或补齐对应样式），替换 `SettingsModal.tsx` 残留的 `白名单根目录` 为统一本地化文案；
   - 修正 `TaskFleetTree.tsx` 嵌套 `role="treeitem"` ARIA 合法性、为各 `tablist` 补齐 `aria-controls`/`tabpanel` 关联并本地化 `LogConsole.tsx:685` 的 `aria-label`；
   - 修复 `Sparkline.tsx:45` 首尾 `null` 点闭合斜线伪影（锚定到实际首尾非空点 `x` 坐标）；优化 `LogConsole.tsx` 跨 ANSI 片段的搜索高亮匹配；
   - 将 `DESIGN.md` 中的 token 名称、色值、字号表、侧栏宽度（`232px`）及 10 个 CSS 模块列表（含 `recovery.css`）与 `src/renderer/styles/tokens.css` & `style.css` 100% 同步。

---

## 四、验收标准与实机截图核验

1. **新增/更新前端单测与桌面测试**：
   - 覆盖 `HOST_UNREACHABLE_RECONCILE` → `forceLocal` 确认弹窗重试、`SettingsModal` 撤销 `allowJobControl` / 重置轮询、切 `en-US` 后 `AutoStartFields`/`GpuMonitor`/`LogConsole` 零中文残留、`>=1440px` 无曲线切任务不锁死、跨宿主点击告警通知聚焦、`exportLogs` 取消不误报成功。
2. **重新跑通全量验证并亲自目视核验关键更新截图**：
   ```bash
   npm run typecheck
   npm run test:unit
   npm run build
   npm run test:desktop
   ```
   重点打开检查更新后的 `cockpit-960x650-dark.png`、`cockpit-1440x900-dark.png`、`settings-hosts-1280x800-dark.png`、`gpu-window-normal-dark.png`（及英文模式验证），确认对比度、布局、标题栏安全区与日志首屏高度全部达标。
3. **请勿修改 `docs/prompts/` 下文件，全部绿灯后提交 Phase 5b 最终 commit。**
