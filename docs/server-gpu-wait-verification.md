# 服务器 GPU 空闲等待验证

日期：2026-11-11。仅 SSH 服务器执行，监控全部 GPU，任意一张卡独立连续空闲达标即使用一张卡启动。旧本地规则不会静默转为服务器托管，WSL 不执行任何部署命令。

## 通过的检查

- 454 项相关 TypeScript 回归通过，覆盖领域、传输、采集器、存储、控制器、取消协调和相邻界面行为。报告：`test-results/server-wait-regression.json`。
- 最终界面与服务器传输检查 18 项通过，报告：`test-results/server-wait-ui-final.json`。
- Python 启动器与服务器 waiter 48 项：47 通过、1 项 Windows symlink 测试跳过。其中服务器 waiter 27 项全部通过。只读 probe 76 项：73 通过、3 项平台相关测试跳过。
- 8 项相关 Electron 原生测试通过：正式主进程启动、冻结 preload API、默认停用、编辑保存、任务 GPU 范围、浅深主题、960×650/1100×800、最大化与还原。tmux 查看命令展开后也没有横向溢出。
- 类型检查与正式构建通过。`dist/launch/server_agent.py` 和启动器已随构建复制。Impeccable 检测无发现，报告：`test-results/server-wait-design-detector.json`。

## 真实服务器实测

lab-campus 已有 tmux 3.2a。使用 `/data2/cy/xzn` 内独立临时目录作为测试白名单根目录，部署两个隔离的 tmux 等待任务；脚本只打印标记和 CUDA_VISIBLE_DEVICES，再短暂休眠，不导入 GPU 框架、不分配显存、不执行用户训练。

提交用的本机 Node/SSH 进程已退出。之后从新的进程查询：一个任务由服务器自动启动，记录显示使用 GPU 0，日志中 CUDA_VISIBLE_DEVICES 只有一个 UUID；训练子进程未继承等待会话的 TMUX/TMUX_PANE。另一个任务的 tmux pane 持续打印候选卡与逐卡连续空闲秒数，取消后状态为 cancelled，且没有生成任务输出日志。测试目录已删除，仅结束本次测试自己创建的会话，没有停止其他 tmux 会话或训练。

最终实测结果与 pane 采样：`test-results/server-wait-live-result.json`（passed=true）。提交和稍后查询是两个独立进程；这验证了脱离客户端后继续执行，没有实际关闭本机或重启服务器。

## 行为边界

服务器自身重启或等待进程丢失后不自动重建，界面报告失败并要求显式重新等待。取消与重新配置须获得服务器确认；无法连接时保留原本地配置，并说明远端可能仍在等待。取消不会终止已经启动的训练进程。同一 arm 的失败、取消和已启动结果不会被重新部署；未知启动结果不会自动重试。

本轮没有更改用户登记文件或自动部署现有任务。结束检查时观察到现有任务有一条旧版规则（execution 字段缺省）；需在新版任务编辑器保存并启用，才会转为服务器 tmux 托管。原有历史 UI 套件的 39 项遗留失败并未在本轮宣称修复；本次回归范围明确限定为上述报告中的相关套件。
