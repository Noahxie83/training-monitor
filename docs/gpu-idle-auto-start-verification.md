# GPU 空闲自动启动验证记录

日期：2026-11-11。实现位于 `src/launch`，通过原有采集器、登记配置与 Transport 接入，默认关闭。没有为现有任务启用规则，没有执行实际训练或启动停止的 WSL。

## 已通过

- 后端回归：386 项 TypeScript 测试通过，报告 `test-results/auto-start-backend.json`。
- 最终相关检查：67 项通过，包括 17 项自动启动界面测试、任务管理、宿主导航、主题、任务 GPU，以及空闲计时与传输测试。报告 `test-results/auto-start-targeted-final.json`。
- Python 启动器：21 项，20 通过、1 项 Windows symlink 测试跳过。只读 probe：76 项，73 通过、3 项平台相关测试跳过。
- Electron：8 项相关原生窗口测试通过，覆盖正式主进程启动、默认关闭状态、冻结 preload API、任务编辑保存、浅深主题、960×650 与 1100×800、最大化和还原、当前任务 GPU 范围。
- `npm run typecheck` 与 `npm run build` 通过，`dist/launch/launcher.py` 已随构建复制；打包配置包含整个 dist。
- Impeccable 对改动的 renderer 文件检测返回 `[]`。
- 真实 `registry.json` 校验值保持 `FF9A9BD077983482473ABFA7546F461AE7908A03F352A5140D9F14FAF44BAC42`。

计时测试覆盖多卡、显存和利用率阈值、未知或缺失数据、重复采样、断线、boot 变化、休眠间隔、已运行任务、进程扫描不完整、重启、一次启用只启动一次、超时不重试、启动前配置变化和 busy 后重新等待。启动器测试使用临时目录与 mock，覆盖实际 base64 probe 加载、有界 framed protocol、脚本/日志范围、追加日志、独占 claim、失败与损坏 receipt、UUID、锁 FD 继承和无 shell 参数执行。

## 验证边界与现存失败

未执行真实 SSH/WSL GPU 自动启动试跑；Linux fcntl、nvidia-smi 与训练 spawn 路径在 Windows 上使用 mock 验证。原生界面使用隔离 appData 或内存 fixture，不是实际训练数据。截图在 `test-results/auto-start-light.png`、`auto-start-dark-small.png` 与 `auto-start-editor-dark-small.png`。

扩展运行全量 UI 时，报告 `test-results/auto-start-ui-final.json` 记录 131 项中 92 通过、39 失败。这些失败集中在旧 dashboard/fix-1～fix-5 测试：旧文案与标题、已移出设置的任务入口、旧时间/资源布局，以及一个日志滚动测试的 Maximum update depth exceeded。没有把这轮全量 UI 检查标为通过，也没有通过恢复旧界面行为或跳过测试来消除失败。本功能当时的 15 项界面测试全部通过，随后补充的两个范围变更与部分 GPU 数据测试也通过。
