# Phase 4 执行提示词：桌面端后台常驻、安全加固、跨平台打包与工程债务彻底清理

> **前置条件**：请先确认 Phase 1、Phase 2、Phase 3 均已完成并提交。
> **核心目标**：补齐桌面端长时后台监控体验（系统托盘、多屏窗口记忆、任务栏进度），清零剩余安全与稳定性隐患（CSP 语法错误、ErrorBoundary、启动崩溃交互、IPC 防护），打通跨平台打包、完整测试矩阵与 CI，并彻底清扫全仓死代码与根目录残留垃圾文件。

---

## 一、背景与必须根治的问题清单

1. **桌面端缺少后台常驻体验**：
   - `src/desktop/main.ts` 中 `mainWindow.on('closed')` 与 `window-all-closed` 直接调用 `app.quit()`，关闭主窗口会立刻强杀采集器、告警引擎以及仍在打开的独立 GPU 窗口；无系统托盘、无关闭最小化到托盘、无开机自启、无窗口位置尺寸记忆、无 OS 任务栏进度。
2. **安全与鲁棒性隐患**：
   - `index.html:5` 的 CSP 存在低级语法错误：`object-src 'none` 漏写闭合单引号，导致该指令失效。
   - `src/renderer/main.tsx` / `App.tsx` / `GpuMonitor.tsx` 均未包裹 React `ErrorBoundary`，任意渲染异常直接黑屏/白屏。
   - `src/desktop/main.ts` 启动期遇配置/数据库/探针异常直接 `app.exit(1)` 静默闪退，无弹窗诊断或自动恢复入口。
   - `src/desktop/ipc.ts` 未限制单 `WebContents` 的订阅上限；`assertSender` 在 POSIX 上用 `.toLowerCase()` 削弱路径比对；`preload.ts` 内 `validateMonitorUpdate` 未做异常隔离；`window.ts` 每次开新窗口都重复注册 `session.defaultSession` 权限处理器。
3. **跨平台打包、测试覆盖与 CI 缺口**：
   - `electron-builder.yml` 与 `package.json` 仅支持 Windows x64 `dir`/`zip`，无安装程序（NSIS）、无 macOS（arm64/x64 `dmg`/`zip`）、无 Linux（`AppImage`/`deb`）、无应用图标。
   - `scripts/packaged-smoke.mjs` 与 `scripts/runtime-check.mjs` 写死 Windows 可执行路径并用 `APPDATA` 隔离配置（在 Linux/macOS 无效）。
   - `tsconfig.json` 的 `include` 漏掉 `tests/**/*.tsx`，全部 17+ 前端测试从未参与 `typecheck`；8+ 个 Python 探针/启动测试未接入 npm 脚本；缺少热开发模式与 GitHub Actions CI。
4. **大量死代码与严重仓库卫生污染**：
   - 死代码：`src/desktop/sqlite-worker.cjs`（从未被任何代码 spawn，却被 `build.mjs` 复制进产物）、`src/launch/ledger.ts`（实例化却从未调用任何方法）、`src/transport/paths.ts`（生产未用且有安全缺陷）、`src/probe/README.txt`（过时草稿还打进 `dist/`）、`src/mocks/api.ts` 非 demo 模式泄露 demo 数据、`pathWithin` 对 `..cache` 前缀文件误判。
   - 根目录与源码目录脏文件：39 个 `task-6b-*`/`task-7-*` 旧日志、2 个旧报告、危险的一次性脚本 `apply_changes.py`、`NVIDIA Corporation/umdlogs`、`.superpowers/`、4 处 `__pycache__/*.pyc`，以及文件间 CRLF/LF 混用、缺少 `.gitattributes` 与 `.editorconfig`。

---

## 二、详细改造规范

### 1. 系统托盘、后台常驻与多屏安全窗口记忆

修改 `src/desktop/main.ts`、`src/desktop/window.ts`、`src/desktop/ipc.ts`、`src/registry/preferences.ts`：

1. **原生系统托盘（`Tray`）**：
   - 为应用提供清晰的高 DPI 托盘图标与窗口图标（`assets/icons/` 生成或提供 Windows `.ico`、macOS 模板 `.png`、Linux `.png`）。
   - 托盘右键菜单实时展示：当前监控摘要（如“运行中 2 · 告警 0”）、显示/隐藏主窗口、打开 GPU 实时监控窗口、暂停/恢复后台采集、退出应用。
   - 左键单击/双击托盘图标快速唤起并聚焦主窗口。
   - 支持偏好项 `minimizeToTrayOnClose`（默认 `true`）：点击主窗口关闭按钮时隐藏至托盘继续后台监控与告警推送，且不关闭独立的 GPU 监控窗口；仅在托盘点击“退出”或显式 `app.quit()`（或 `minimizeToTrayOnClose === false` 且全部窗口关闭）时才优雅停机。
   - 支持偏好项 `launchAtLogin`（调用 Electron `app.setLoginItemSettings`，在设置页可控）。
   - 支持 OS 任务栏进度指示（`mainWindow.setProgressBar` 映射当前选中/活跃运行任务进度，无确定进度时清除）。
2. **多显示器安全的窗口几何持久化**：
   - 在 `preferences.json` 持久化 `windowBounds.main` 与 `windowBounds.gpu`（`x`, `y`, `width`, `height`, `isMaximized`，防抖保存避免拖拽高频写盘）。
   - 窗口创建恢复坐标前，严格对照 `screen.getAllDisplays()` 校验工作区可见性；若外接显示器已拔出导致坐标越界，自动居中回退至主显示器安全区域，不出现“看不见的屏外窗口”。

### 2. 安全加固与异常恢复机制

修改 `index.html`、`src/renderer/main.tsx`、`src/renderer/components/ErrorBoundary.tsx`（新增）、`src/desktop/main.ts`、`src/desktop/ipc.ts`、`src/desktop/preload.ts`、`src/desktop/window.ts`：

1. **修复 CSP 语法错误**：
   - 修正 `index.html` 中缺失闭合引号的指令为 `object-src 'none';`，并确认打包后在开发者工具控制台无任何 CSP 解析警告。
2. **全链路 React `ErrorBoundary`**：
   - 新增美观、支持双语和双主题的 `ErrorBoundary` 组件，分别包裹主应用 `<App />` 与独立 GPU 窗口 `<GpuMonitor />`，捕获未预期渲染异常后展示可读错误摘要、复制诊断信息按钮与一键重载恢复按钮。
3. **启动失败可恢复交互**：
   - 重写 `src/desktop/main.ts` 启动 `catch` 分支：严禁直接静默 `app.exit(1)`；若为配置文件损坏，自动备份原文件并弹窗提示用户选择“重置配置并继续启动”或“打开配置目录排查”；若为其他致命错误，调用 `dialog.showErrorBox` 展示明确错误与日志位置后再退出。
4. **IPC 与安全卫生收紧**：
   - `src/desktop/window.ts` 将 `session.defaultSession.setPermissionRequestHandler` / `setPermissionCheckHandler` 移至 `app.whenReady()` 仅注册一次，避免每开新窗重复覆盖。
   - `src/desktop/ipc.ts` 限制单 `WebContents` 最大活跃事件订阅数（防渲染端异常泄漏），在非 Windows 平台保持 `assertSender` 大小写敏感精确路径校验；`src/desktop/preload.ts` 对 `validateMonitorUpdate` 包裹安全 `try/catch`（仅记录告警不中断事件分发）。
   - 修复 `src/desktop/main.ts` 中 `userData` 路径策略：遵循 Electron 标准或仅在显式 `--user-data-dir` / 测试环境变量下覆写，避免 `--demo` 模式污染真实用户数据目录。

### 3. 跨平台打包、测试脚本补全与 CI

修改 `electron-builder.yml`、`package.json`、`tsconfig.json`、`scripts/*`，新增 `.github/workflows/ci.yml`：

1. **跨平台构建与打包配置**：
   - 更新 `electron-builder.yml` 与 `package.json`：
     - Windows：`nsis` 安装包 + 便携 `zip`（x64），绑定应用图标。
     - macOS：`dmg` + `zip`（`arm64` & `x64`）。
     - Linux：`AppImage` + `deb`（x64）。
     - 在 `package.json` 补全标准 `description`、合理脚本：`package:win`、`package:mac`、`package:linux`、`dev`（支持前端 Vite 热更新 + 主进程便捷重启）、`test:python`（`python -B -m unittest discover -s tests -p "test_*.py"`）、`test:all`。
2. **修复测试工具链漏检与跨平台隔离**：
   - 在 `tsconfig.json` 的 `include` 中加入 `"tests/**/*.tsx"`，确保全部 React UI 测试接受严格 TypeScript 类型检查并修复暴露出的所有类型错误。
   - 更新 `scripts/packaged-smoke.mjs` 与 `scripts/runtime-check.mjs`：通过跨平台 `--user-data-dir=<tempDir>` 参数与平台自适应产物路径运行，彻底消除对 Windows `APPDATA` 与硬编码 `.exe` 路径的依赖。
   - 新增 `.github/workflows/ci.yml`：在 PR 与 `main` push 时自动执行 `typecheck`、`test:unit`、`test:python`、`build`、`test:runtime`（并在可用 Runner 上运行桌面端验收）。

### 4. 死代码移除与仓库卫生彻底清理

1. **移除死代码与修复路径边界 Bug**：
   - 修复所有 `pathWithin` / `componentWithin` 工具函数：改用 `relative !== '..' && !relative.startsWith('../') && !relative.startsWith('..\\')`（解决对 `..cache` / `..logs` 等合法目录名的误杀）。
   - 删除确认无生产引用的死文件及对应构建复制项：
     - `src/desktop/sqlite-worker.cjs`（同步移除 `scripts/build.mjs`、`scripts/test-workers.mjs` 中对该文件的复制）
     - `src/launch/ledger.ts`（及其无用注入，除非 Phase 2 明确复用；若已由服务端队列收据替代则彻底移除）
     - `src/transport/paths.ts`
     - `src/probe/README.txt`（同步从 `scripts/build.mjs` 移除）
   - 清理 `src/mocks/api.ts` 非 demo 模式泄露 demo fixture 元数据的问题，改用干净工厂函数构造空快照。
2. **清扫根目录与缓存污染、统一工程规范**：
   - 删除工作区中未追踪的脏文件/临时产物（仅清理垃圾文件，绝不删文档或测试资产）：
     - 根目录 `task-6b-*.log`、`task-7-*.log`、`task-6b-core-report.md`、`task-7-fix-3-report.md`
     - 根目录危险脚本 `apply_changes.py`
     - 根目录 `NVIDIA Corporation/` 驱动转储目录
     - 根目录 `.superpowers/` 临时会话目录（含 `.last-token`）
     - 全仓库所有 `__pycache__/` 与 `*.pyc`
   - 整理 `.gitignore`：用规范通配规则（`__pycache__/`, `*.pyc`, `dist/`, `release/`, `test-results/`, `.vitest/`, `*.log` 等）替代零散写死的临时文件名。
   - 新增 `.gitattributes`（强制源码统一 LF 换行，`*.bat`/`*.cmd` 除外）与 `.editorconfig`（统一缩进、UTF-8、尾换行）。

---

## 三、全项目最终验收清单（Final Verification Gate）

执行端必须逐一执行以下全部命令，确认 **0 错误、0 跳过隐藏失败、0 脏文件残留**，并在总结中贴出实际命令输出与最终视觉回归确认：

```bash
# 1. 类型检查（现已包含全部 tests/**/*.tsx）
npm run typecheck

# 2. 单元测试、领域、存储、传输、仿真与 UI 测试
npm run test:unit

# 3. 全部 Python 探针与自动启动测试（不生成 __pycache__）
npm run test:python

# 4. 生产构建与运行时金丝雀检查
npm run build
npm run test:runtime

# 5. Electron 桌面端端到端与多分辨率双主题视觉测试
npm run test:desktop

# 6. 打包烟测（Windows 环境验证）
npm run package:dir
npm run test:packaged

# 7. 仓库洁净度检查（无 __pycache__、无根目录旧日志、无个人硬编码）
git status
```

完成后提交最终 commit，整个 Training Monitor 全面普适化与前端审美重塑宣告收官。
