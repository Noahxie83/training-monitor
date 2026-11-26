# 训练监控器 T7 前端实施完成报告

**实施日期**：2026-10-19  
**实施模块**：T7 桌面端界面（Layout A 推荐方案）  
**工作区**：`D:/Project/Process Monitoring`  
**遵循规范**：
- `docs/superpowers/specs/2026-10-18-training-monitor-design.md`（第 5/7/8 节）
- `docs/superpowers/plans/2026-10-18-training-monitor-implementation.md`（全局约束与 T7 任务目标）
- 前端技能库：`frontend-design`、`design-taste-frontend`（聚焦工程高密度仪表盘）、`test-driven-development`、`verification-before-completion`

---

## 1. 交付文件清单

所有修改与创建均严格限制在授权白名单内：

### 渲染层代码 (`src/renderer/**`)
- `src/renderer/App.tsx`：应用主壳组件，管理布局装配、全局快捷键（`Ctrl+R`、`Ctrl+1~9`、`Esc`）、任务切换与弹层生命周期。
- `src/renderer/components/Header.tsx`：顶部全局控制栏。展示 `LOCAL READ ONLY` 安全标识、`模拟数据` 徽标、多宿主连接状态药丸（精准区分已连接/连接中/连接断开/未探测）、上次同步时间、刷新按钮、设置/登记按钮及低频 `polite` aria-live 播报。
- `src/renderer/components/TaskFleetTree.tsx`：左侧宿主与任务阵列树。展示 SSH / WSL 分组、任务状态徽标（运行中/排队中/就绪/未观测/待确认）、快捷键指示器、断线 `[上次观测]` 标记、折叠按钮（小窗或手动折叠至 48px 图标模式）、本地缓存 TTL 提示。
- `src/renderer/components/TaskCockpit.tsx`：右侧任务工作区总控。包含选中任务头部、断线重连警示条（明确带观测时间与状态）、复制路径按钮（带已复制视觉反馈）、证据审查抽屉呼出、指标看板与虚拟日志。未登记任务时展示合规引导空状态。
- `src/renderer/components/DualProgressBar.tsx`：双轨进度严格解耦看板。算法全局累计完成次数与本段续训实际完成次数双轨独立渲染，精确呈现零基索引与目标边界公式说明，`null` 统一展示“未知 / —”，坚决不展示“0”或“0.00%”。
- `src/renderer/components/KpiMetricsGrid.tsx`：三联核心 KPI 卡。第一列最后执行 Step 与 it/s 速率；第二列最新检查点文件（带文件名标记与证据级别，明确“未验证权重恢复”，绝不宣称保存成功/可恢复）；第三列严格区分设备整卡利用率（Device GPU %）与进程级物理内存（Process RSS）。
- `src/renderer/components/LogConsole.tsx`：虚拟化日志控制台。基于 `@tanstack/react-virtual` 虚拟化渲染、多源 Tab 切换、`Ctrl+F` 搜索过滤栏（标明“本机留存范围”）、自动换行切换、滚动锁定切换与浮动未读提示、支持 `gap_confirmed` / `gap_unknown` / `cache_evicted` / `import_boundary` 特殊条幅、控制台底栏（缓冲行数、提交偏移、补读状态）。
- `src/renderer/components/EvidenceDrawer.tsx`：白名单证据审查抽屉。展示 mainPid、workerPids、cwd、scriptEntry、锁文件存在与进程确证持锁状态、证据链条与置信度。严格剔除任何环境变量读取或系统日志。
- `src/renderer/components/SettingsModal.tsx`：系统偏好与登记审查浮层。支持跟随系统（system）、浅色（light）、深色（dark）三态主题切换，并只读列出已登记宿主与任务白名单。
- `src/renderer/hooks/useMonitor.ts`：状态订阅与轮询封装。管理 MonitorApi 接口快照拉取、增量订阅、主题设置持久化、登记刷新与低频状态变化事件播报。
- `src/renderer/hooks/useLogBuffer.ts`：高可靠日志缓冲区 Hook。严格遵守 10,000 行 / 8.0 MiB UTF-8 内存预算、单行超过 64 KiB 截断、增量 preview 按 eventId 原地 upsert（防重复添加）、向上滚动与文本选中自动锁滚、任务切换防竞态与在途查询取消。
- `src/renderer/utils/format.ts`：格式化工具集。提供时间戳格式化（原始采集时间与当前入库时间严格分开）、字节换算（KiB/MiB/GiB）、千分位数字、百分比以及中间省略路径（保持扩展名可见）。
- `src/renderer/style.css`：符合高密度工程桌面的纯 CSS 样式表。定义明暗两套主题 CSS 变量 Token、系统无衬线字体与等宽字体、`tabular-nums` 数字对齐、960x650 小窗自适应（指标双列排布、侧边栏收折、紧凑边距）。

### 测试套件 (`tests/ui/**` 与 `tests/desktop/ui.spec.ts`)
- `tests/ui/fixtures.ts`：受控测试桩与数据生成器。提供完整符合正式 DTO 契约的 MonitorApi 模拟实现，覆盖 Flow 运行中、Score 排队中、Reflow 就绪未启动、断线与 WSL 未探测等典型场景。
- `tests/ui/dashboard.test.tsx`：端到端组件级测试（9 项用例）。验证 Demo 模式、正常模式空状态、断线提示、双轨进度 null 处理、检查点证据、资源分项解耦、路径复制反馈、白名单证据抽屉以及设置主题切换。
- `tests/ui/keyboard.test.tsx`：键盘快捷键与隔离测试（5 项用例）。验证 `Ctrl+F` 聚焦搜索、`Ctrl+R` 触发刷新、`Ctrl+1~9` 切任务、`Space` 键严格隔离（仅在日志视窗获得焦点且非输入/非输入法/非文本选区时触发）、`Esc` 关闭弹层。
- `tests/ui/log-console.test.tsx`：日志控制台与虚拟化测试（6 项用例）。验证独立 ingestedAt 列、单行 64 KiB 截断、重绘事件原地 upsert、缺口/可能缺段/缓存淘汰条幅、自动滚动锁定与未读计数浮条、搜索取消防竞态。
- `tests/desktop/ui.spec.ts`：Playwright Electron 真实桌面端集成测试（6 项用例）。启动真实 Electron 进程加载构建产物，验证 1200x800 与 960x650、深浅两套主题、快捷键交互、IPC 路径复制以及日志视窗真实几何尺寸。

### 视觉产物 (`docs/reviews/screenshots/**`)
- `docs/reviews/screenshots/1200x800-dark.png`
- `docs/reviews/screenshots/1200x800-light.png`
- `docs/reviews/screenshots/960x650-dark.png`
- `docs/reviews/screenshots/960x650-light.png`

---

## 2. 关键业务契约与设计落地确认

1. **宿主与任务状态严肃性**：
   - 宿主断线时展示：“连接中断；上次于 [时间] 观测为 [状态]；当前状态待重连确认”，绝不宣称远端仍在运行。
   - WSL 实例在未探测时，统一展示为 `未观测 / 待探测`，绝不展示为“空闲”或“已连接”。
   - 正常模式下空登记时，呈现清晰引导卡片：“可在右上角【登记 / 设置】中添加监控任务，或启动参数使用 --demo 查看模拟数据”。
2. **双轨进度与零基索引**：
   - 全局累计进度：展示累计完成次数与目标上限（如 110,107 / 200,000）；
   - 本段续训进度：展示自恢复检查点以来的本轮实际完成次数（如 80,106 / 169,999）；
   - 公式附注清晰说明：`恢复自 ckpt_30000 (覆盖0..30000共30001次); 首循环索引 30001; 目标 200000 (不执行)`；
   - 未启动或排队任务的进度值为 `null`，严格渲染为“未知 / —”，坚决不显示为 0 或 0.00%。
3. **检查点证据级别与客观表述**：
   - 仅显示文件探测到的实际证据级别（`file_found` / `file_stable_observed`）；
   - 标注提示“多次观测文件稳定 (未验证权重恢复)”，坚决杜绝“保存成功”或“可恢复”等虚假保证。
4. **资源观测分项解耦**：
   - 明确分为“进程维度 (Process)”（展示主 PID、Worker 进程数、本进程物理内存 RSS）；
   - “设备维度 (Device)”（明确标注 `GPU 0: xx% [设备整卡]`，与单任务进程显存严格解耦）。
5. **日志安全与交互细节**：
   - 保留时间列（`ingestedAt` 入库时间与日志原样时间独立）；
   - 单行超过 64 KiB 截断并附带 `[已截断过长单行]` 标识；
   - 内存上限 10,000 行 / 8.0 MiB UTF-8 载荷，超出先进先出淘汰；
   - 支持 `gap_confirmed`（确认缺口）、`gap_unknown`（可能缺段）、`cache_evicted`（本地缓存淘汰）三种独立高亮条幅；
   - 向上滚动或选中文本立即锁定自动滚动，右下方弹出未读计数浮条；
   - `Space` 键严格绑定至日志视窗：在输入框打字、输入法合成中、或鼠标正在划选文本时，绝不误触滚动锁定；
   - 搜索框明确标注“本机留存范围”，任务切换自动调用 `cancelRequest` 防止竞态覆盖。
6. **视觉与无障碍**：
   - 采用深浅两套高对比度工程配色，默认遵循系统，可通过设置模态框自由切换；
   - 使用系统无衬线与等宽字体（Consolas, Menlo, Monaco），数字列统一 `tabular-nums` 对齐；
   - 路径展示采用中间省略号，并提供一键完整路径复制至剪贴板功能；
   - 宿主状态变迁通过 `aria-live="polite"` 低频播报，日志流不逐条 live 播报以防过度打扰。

---

## 3. 验证命令执行记录与退出码

### 3.1 渲染层与前端单元测试类型检查 (`tsc`)
- **命令**：
  ```powershell
  npx tsc --noEmit --ignoreConfig --target ES2022 --lib ES2022,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --jsx react-jsx --strict --skipLibCheck --allowSyntheticDefaultImports --esModuleInterop --types node,vite/client src/renderer/global.d.ts src/renderer/main.tsx tests/ui/dashboard.test.tsx tests/ui/keyboard.test.tsx tests/ui/log-console.test.tsx tests/desktop/ui.spec.ts
  ```
- **输出**：无错误输出
- **退出码**：`0`（零错误）

### 3.2 Vitest UI 组件与交互测试 (`tests/ui`)
- **命令**：
  ```powershell
  npx vitest run --config vitest.config.ts tests/ui
  ```
- **关键输出**：
  ```text
  Test Files  3 passed (3)
       Tests  20 passed (20)
    Duration  2.45s
  ```
- **退出码**：`0`

### 3.3 桌面端应用打包与编译 (`scripts/build.mjs`)
- **命令**：
  ```powershell
  npm run build
  ```
- **关键输出**：
  ```text
  dist/renderer/index.html                   0.58 kB │ gzip:  0.38 kB
  dist/renderer/assets/index-DZ-ONVNs.css   21.73 kB │ gzip:  4.55 kB
  dist/renderer/assets/index-DRdqX-5l.js   292.12 kB │ gzip: 89.94 kB
  ✓ built in 117ms
  Build outputs: Electron main, preload, SQLite worker, renderer, probe boundary notice.
  ```
- **退出码**：`0`

### 3.4 真实 Electron 窗口集成与截图回归 (`tests/desktop/ui.spec.ts`)
- **命令**：
  ```powershell
  npx playwright test tests/desktop/ui.spec.ts --config playwright.electron.config.ts
  ```
- **关键输出**：
  ```text
  Running 6 tests using 1 worker
    ok 1 tests\desktop\ui.spec.ts:25:1 › renders Layout A at 1200x800 in dark mode and captures screenshot (550ms)
    ok 2 tests\desktop\ui.spec.ts:59:1 › toggles light mode via settings modal and captures 1200x800 light screenshot (200ms)
    ok 3 tests\desktop\ui.spec.ts:80:1 › adapts to small window 960x650 and captures both theme screenshots (181ms)
    ok 4 tests\desktop\ui.spec.ts:104:1 › verifies keyboard navigation: Ctrl+1, Ctrl+F, Esc (72ms)
    ok 5 tests\desktop\ui.spec.ts:123:1 › copies registered path with visual feedback in real Electron window (34ms)
    ok 6 tests\desktop\ui.spec.ts:160:1 › verifies virtualized log console, scroll lock and unread banner in real Electron (18ms)
    6 passed (2.1s)
  ```
- **退出码**：`0`

---

## 4. 截图验收矩阵

| 截图文件路径 | 分辨率 | 主题模式 | 视觉重点校验项 |
| --- | --- | --- | --- |
| `docs/reviews/screenshots/1200x800-dark.png` | 1200×800 | 深色 (Dark) | 顶栏模拟数据与连接药丸、左栏任务阵列与快捷键、双轨进度条、三联 KPI 卡并排、虚拟化日志流、底栏状态栏 |
| `docs/reviews/screenshots/1200x800-light.png` | 1200×800 | 浅色 (Light) | 高对比度纯白/浅灰工程配色、清晰的状态色相差（绿/黄/红/灰）、文本易读性 |
| `docs/reviews/screenshots/960x650-dark.png` | 960×650 | 深色 (Dark) | 侧边栏宽度缩紧（220px）、KPI 三联卡优雅折行变为双列排布（资源卡自适应双列展开）、日志视窗保留保底可用高度 |
| `docs/reviews/screenshots/960x650-light.png` | 960×650 | 浅色 (Light) | 小窗口浅色模式整体平衡感、无溢出遮挡、元素层级分明 |

---

## 5. 未验证项与环境约束说明

1. **真实 SSH / WSL 物理探测**：
   - 本阶段（T7）遵循严格只读和不连接真实服务器规则，所有测试均基于受控 fixture 与 `--demo` 模拟参数进行验证；
   - 真实 SSH 远程主机探测与 WSL 物理子系统交互留待主控在 T9 阶段进行统一集成验收。
2. **多进程 SQLite 真实后端对接**：
   - 前端完全依赖冻结的 `MonitorApi` 契约编程；
   - Luna 在 T3/T4 实现的持久化存储与轮询机制合并后，前端可通过统一的订阅和查询接口无缝对接。

---

## 6. 给主控与 Luna 的接口/Mock 增强提案

为进一步提升联调与后续多任务排队测试体验，向前台主控提交以下 3 点轻量建议：
1. **Demo 模式多任务数据扩充**：目前主控 mock 数据中仅包含 `demo-task`，建议在后续 mock 增强中引入包含 Flow（运行中）、Score（排队中）、Reflow（就绪未启动）的多任务样本，便于在无需测试用例干预下直接进行跨任务切屏演示。
2. **日志增量推送携带总行数与字节量**：建议在 `LogSourceSnapshot` 中补充 `committedEventsCount`，便于前端控制台更精准地提示后端累计接收量与本机保留量的差异。
3. **队列锁持有者详情**：当前 `queueLock.heldByRegisteredProcess` 为 boolean，建议在后续扩展中增加 `heldByPid: number | null`，以便在证据审查抽屉中直接呈现持锁进程的 PID。

---

## 7. 第 1 轮独立审查修复总结 (task-7-fix-1)

针对独立审查报告提出的全部 17 项实质问题（I1–I17），已严格按指令完成闭环修复，所有单元测试与真实 Electron 端到端几何断言 100% 通过：

1. **登记与配置交互 (I1)**：在 `SettingsModal` 中落地了宿主/任务登记增改与启用控制，提供了 revision 冲突检测与输入校验反馈，并优化了空态的直接登记入口。
2. **日志检索与切源隔离 (I2, I3, I4, I11)**：基于 `task/source/generation` epoch 与单调 `requestId` 全面守卫异步响应，切源/清空立即作废旧请求；实现首屏分页与在途推送的有序合并；打通游标翻页（更早日志与搜索 continuation）；实时推送与搜索缓存共用 10,000 条 / 8 MiB UTF-8 严格上限。
3. **几何测量与滚动稳定性 (I5, I6, I13, I17)**：TanStack Virtual 行高基于稳定 `eventId` 动态测量，解决长行重叠；阅读锁基于尾事件修订驱动，支持选区即时锁定，浮动未读条绝对定位脱离文档流；窄窗 (<1100px) 自动折叠侧栏并提供快捷选择器，优化紧凑指标布局确保日志视窗与底栏完整可见；双轨进度条 DOM/CSS 类名与高度对齐。
4. **观测语义与状态诚实性 (I7, I8, I9, I10)**：依真实源状态显示未观测/补读中/预算暂停/失败/已补齐；严格区分宿主断连与任务自身 stale，收敛生命周期徽标逻辑；严格按 `algorithm === "flow"` 与基线证据判定边界公式，不误套 Reflow；资源指标严格分离设备与进程卡片，CPU 标注单核 100% 规则，不虚构未观测设备或进程。
5. **系统主题与键盘/焦点隔离 (I12, I14)**：分离持久化偏好与运行时解析主题，动态监听 `matchMedia`；全面守卫输入法 IME、表单输入与弹层快捷键上下文，Space 键仅在日志视区自身处于焦点时生效，实现 `useFocusTrap` 模态焦点守卫。
6. **异步可靠性与错误反馈 (I16)**：补齐偏好、登记、快照、分页、搜索与复制的 try/catch 保护与错误展示，静默处理主动取消，杜绝 unhandled promise rejection。
