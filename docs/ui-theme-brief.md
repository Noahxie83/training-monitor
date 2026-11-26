# 可切换主题验收

日期：2026-11-05。此监控工作区采用 Operate 模式：切换任务、查看训练进度、GPU 汇总和日志，优先可读性与长期使用的稳定感。

用户明确选择浅色方案①、深色方案②；正式实现保留微软雅黑和固定展开侧栏，接入既有 preferences 存储，不新增依赖、不变更公共数据契约或采集链路。

## 改动

- 重整 `style.css` 的语义颜色和布局；浅色为进度/GPU 并排、日志横跨，深色为独立 GPU 右栏。
- 顶部日/月按钮快捷切换，设置中的浅/深/跟随系统保持同步，选择持久化。
- 统一 SVG 图标、任务菜单 portal、表单与焦点样式。训练进程指标默认收起；GPU 未知/旧值独立保留。
- 本地日志时间缩为时分秒，悬停仍有完整本地日期时间，日志长文本和虚拟滚动继续工作。

## 实际验证

`npm run typecheck`、`npm run build` 通过。相关测试 18 文件、131 项通过，含主题切换/保存失败/跟随系统、任务管理、键盘、日志虚拟化、GPU 资源、collector、store 和 transport。不是全项目测试声明。

实际 Electron 验证使用隔离数据：

- `theme-ui-fixture.tsx` 提供模拟八卡、任务和日志，检查两套宽窗口布局、960×650 无横向溢出、GPU 7 可滚动查看、表单/菜单/Esc、未知和 8 卡旧值提示。
- 通过设置选择跟随系统，并模拟 OS 深浅变化，实际界面均响应。
- 使用 `task-manager-bootstrap.cjs` 加载正式构建和独立 appData，实际保存深色、关闭后重启，仍加载深色；两个测试宿主均 disabled，没有连接 SSH 或启动 WSL。
- 最终浅/深截图的可见文字对比度检查无低于 4.5:1 的项目，界面没有 pageerror。Impeccable 检测执行一次，退出 0、无发现。
- 用户 registry SHA256 前后均为 `11D87C16434ED6A34C238C2BA8F20A5CC336202A6FAD7AA02C0DDCFBA90DE161`。没有改用户登记、训练、驱动、模型配置、Git 或安装依赖。所有本次测试窗口已关闭。

证据：`test-results/theme-ui-checks.json`、`theme-design-detector.json`、`theme-{light,dark}-{1280,960}.png`、`theme-dark-editor.png`、`theme-stale.png`。宽窗口截图为最终颜色；960 截图来自同一布局检查。

重新打开桌面快捷方式即可加载最终构建。顶部切换图标与设置均可操作主题。
