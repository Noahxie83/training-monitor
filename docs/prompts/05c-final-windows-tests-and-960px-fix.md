# Phase 5c 最终微修提示词：Windows 100% 绿灯测试 + 960px 胶囊防裁切

> **执行定位**：仅修最后 3 处极小尾巴（2 处 Windows 测试环境兼容 + 1 处 `960×650` 自动启动条微裁切），改动极小，执行端开 `low` 或 `medium` 思考强度即可秒修。

---

## 修改清单（共 3 项）

### 1. 修复 `tests/desktop/phase4-resilience.spec.ts` 在 Windows 下获取 `cmd.exe` 而非 `electron.exe`
- **位置**：`tests/desktop/phase4-resilience.spec.ts:1-6, 84, 127`
- **根因**：Windows 上 Playwright 启动 Electron 经过 `cmd.exe`，因此第 84 行 `first.process().spawnfile` 返回 `C:\WINDOWS\system32\cmd.exe`，导致第 127 行 `execFile(executable, [bootstrap, profile])` 直接失败。
- **修复**：使用 `createRequire(import.meta.url)('electron') as string`（从 `node:module` 导入 `createRequire`）获取真实的跨平台 Electron 可执行文件路径（Windows 为 `node_modules/electron/dist/electron.exe`），替换第 84 行的 `first.process().spawnfile` 传给第 127 行 `execFile(...)`。

### 2. 为 `tests/launch/test_phase2_launch.py` 补齐遗漏的 POSIX 装饰器
- **位置**：`tests/launch/test_phase2_launch.py:101`
- **根因**：`test_ngpu_simultaneous_idle_wait_and_index_vs_uuid_mode` 调用 `agent.ensure_server_wait()` 触发 POSIX `os.getuid()` / `0o600` 校验，但漏加了同文件第 196、216 行已加的平台守卫。
- **修复**：在第 101 行 `def test_ngpu_simultaneous_idle_wait_and_index_vs_uuid_mode(self):` 上方补加：
  ```python
  @unittest.skipUnless(os.name == "posix", "requires POSIX process, permission, or runtime directory semantics")
  ```

### 3. 消除 `960×650` 下自动启动状态条右侧条件胶囊的半字裁切
- **位置**：`src/renderer/components/AutoStartPanel.tsx` 与 `src/renderer/styles/cockpit.css:995-1006`
- **根因**：`@media (max-width: 1050px)` 中 `.auto-start-summary-inline` 设置了 `flex-wrap: nowrap; overflow: hidden;`，在 960px 宽度下末尾的 `显存 ≤ 2.0 GiB` 会被硬截断成 `显存 ≤ 2.0 G` 紧贴右侧 `编辑` 按钮。
- **修复**：
  1. 在 `AutoStartPanel.tsx` 中给 `.auto-start-summary-inline` 增加完整条件摘要 `title` 提示，并给非核心长文案胶囊（如 `本机关机后继续等待` / offline-continue 提示胶囊）增加类名 `auto-start-summary-chip-secondary`。
  2. 在 `src/renderer/styles/cockpit.css` 的 `@media (max-width: 1050px)` 中：
     - 隐藏 `.auto-start-summary-chip-secondary { display: none; }`（释出宽度，使全部核心数值条件胶囊完整无裁切展示）；
     - 同时给 `.auto-start-summary-inline` 保留 `padding-right: 4px;` 及渐隐边缘安全兜底（`mask-image: linear-gradient(to right, #000 calc(100% - 12px), transparent)`，或对过长胶囊自然省略），确保即使英文模式或更长条件也不出现硬半字截断。

---

## 验收命令（全部 0 失败）

```bash
npm run typecheck
npm run test:python
npm run test:unit
npm run build
npm run test:desktop
```

确认以上 **100% 全绿**（`test:python` 0 errors / 0 failures，`test:desktop` 29/29 passed），并快速检查更新后的 `test-results/phase3-audit/cockpit-960x650-dark.png` 确认自动启动条条件胶囊不再被半字裁切。

**请勿修改 `docs/prompts/` 下任何文件**，全部通过后提交 commit 并 `git push origin main`。
