# 主页面任务管理与删除同步修复

日期：2026-11-05。

用户发现设置中的任务列表已经为空，主页面仍显示 Flow/Score/Reflow，并要求按 Codex 的侧栏交互把任务管理移到主页面。

## 根因与改动

`store.getSnapshot()` 返回保留的历史观测；此前 collector 直接返回或推送这份快照，没有按当前 registry 排除已经删除的任务。删除配置不会删除历史缓存，因此旧任务会被当成当前监控任务重新显示。

新增浏览器兼容的 `src/shared/registry-snapshot.ts`。collector 的返回值与订阅推送，以及前端 `useMonitor` 都以当前登记配置投影快照：已删任务及其来源不显示；新登记、停用或尚未采样的项目仍可管理，以完整“未观测”占位显示。宿主和任务身份不匹配时不复用旧观测。底层缓存日志保留。

主页面侧栏标题及各宿主旁增加“＋”。宿主旁的入口预选该宿主；任务行悬停或键盘聚焦时显示“⋯”，提供编辑、移除。独立任务表单直接持久化，包含原有路径、来源 ID、启用状态和版本冲突处理。移除后立即更新当前列表与选择；最后一个任务移除后显示带添加入口的空态。设置保留外观与宿主配置，不再有任务管理表格。

相关文件：`src/collector/service.ts`、`src/shared/registry-snapshot.ts`、`src/renderer/{App.tsx,hooks/useMonitor.ts,style.css}`、`src/renderer/components/{TaskFleetTree.tsx,TaskEditor.tsx,task-form.ts,SettingsModal.tsx,Header.tsx,TaskCockpit.tsx}`。模拟 provider 的登记配置同步更新，避免示例任务与登记列表不一致。

## 验证

- 相关测试：16 个文件、119 项通过。覆盖 transport、store、simulations，以及任务管理、键盘、sidebar-time、live-monitor、resources UI。
- 新任务管理 UI 测试覆盖：空 registry 配合旧缓存/迟到快照；从宿主入口添加及自动选中；编辑保留来源 ID；移除最后任务；保存失败保留任务；版本冲突保留输入；设置中无任务管理表格。
- collector 测试覆盖：保存删除后的读取和订阅、后续刷新、同 store 重建、不删除底层历史日志、新注册占位与来源过滤。
- `npm run typecheck`、`npm run build` 通过。没有声称执行全项目测试；旧键盘测试中的过期文案断言已替换为当前标题和对话框的实际行为断言。
- 实际 Electron 生产窗口使用 `test-results/task-manager-bootstrap.cjs` 设置独立 appData，两个测试宿主均 disabled。没有连接 SSH 或 WSL。
- 实际输入完成添加、自动选中、编辑、更名后 reload、移除、刷新、reload 和关闭重启。最终 registry 与快照任务均为 0，没有旧任务复活。
- 960×650 检查了浅色/深色菜单、任务表单、更多路径展开与空态；无横向溢出，保存按钮在视口内，更多路径可内部滚动。Esc 关闭表单正常。
- 用户实际 registry 测试前后 SHA256 均为 `11D87C16434ED6A34C238C2BA8F20A5CC336202A6FAD7AA02C0DDCFBA90DE161`，未改动。没有操作训练、Git、安装依赖或更改模型配置。测试实例和 Luna 子代理已关闭。

命令：

```text
node node_modules/vitest/vitest.mjs run tests/ui/task-management.test.tsx tests/ui/keyboard.test.tsx tests/ui/sidebar-time.test.tsx tests/ui/live-monitor.test.tsx tests/ui/resources.test.tsx tests/simulations tests/transport tests/store --config vitest.config.ts
npm run typecheck
npm run build
```

截图均来自隔离测试任务：`test-results/task-manager-{empty,add,menu,960x650,editor-960x650,dark-menu,deleted}.png`。重新打开桌面“训练监控器”即可加载当前构建。
