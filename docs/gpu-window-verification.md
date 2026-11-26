# GPU 独立窗口验收

日期：2026-11-05；时间为北京时间。主控实现独立窗口、前端和桌面验收；Luna 补齐宿主 GPU 快照及后端测试。

## 功能

主页面顶部提供 GPU 实时监控入口。再次点击复用窗口并选择当前宿主；窗口内可切换 lab / WSL、立即刷新或重新连接。关闭它不影响主窗口。主题与登记配置在两个窗口间同步。

HostSnapshot 新增可选 gpu，复用已有 host probe 的整卡采样。没有训练任务时仍能显示 GPU；不修改 SQLite schema，不创建虚构任务，也不新增采样定时器。严格校验 GPU DTO 的设备范围、数值、单位和指标数量上限。GPU 失败保留原时间及 stale 值，停用或目标改变后不沿用 fresh GPU。

界面显示每张卡利用率、显存已用/总量及条形指示。整卡视图不显示训练进程占用。未知值不替换成 0；断线有原因和重试入口。WSL 未启动时仍提示先启动 Ubuntu-26.04，本次没有启动 WSL。

## 响应式修正

用户反馈最大化后内容局限于中间窄栏，现移除固定 1080px 内容上限。宽屏四列、普通窗口两列、窄窗单列，并按宽屏增大字号及间距。

预览曾使用固定浏览器视口，导致原生窗口缩小后仍按宽屏渲染。已结束这些预览窗口，改用 Electron 原生窗口 API 验收；产品代码没有设置固定浏览器视口。同时将独立窗口 GPU 区块的 order 重置为 0，修正宿主标题被主面板通用样式移到列表底部的问题。内容不再强行拉伸到整窗高度。

## 实际结果

- typecheck 与生产 build 通过。
- 相关本地测试 152 项通过，覆盖宿主 GPU 契约、无任务采样、错误与恢复、UI、主题、导航、日志、collector、store 和 transport。
- 7 项桌面检查通过，包括独立窗口复用/关闭/重开、主题与登记同步、IPC 边界、订阅与原生缩放。
- 原生缩放：1000×820 为两列；最大化 2560×1418 为四列；还原 940×700 为两列；640×480 为单列。四种状态无横向溢出、关闭按钮完整可见、宿主标题在列表上方；窄窗可滚动看到 GPU 7。没有 pageerror。
- 真实 lab 样本：20:23:17～20:23:37 连续五次，任务数均为 0，每次八卡；间隔 4926～5104ms，GPU 0 利用率为 94、93、93、93、94%。WSL 返回 WSL_NOT_RUNNING。
- 实际采样使用独立 appData 和用户登记的副本，只采宿主与 GPU。用户 registry SHA256 始终为 11D87C16434ED6A34C238C2BA8F20A5CC336202A6FAD7AA02C0DDCFBA90DE161。

没有修改用户登记、启停训练、查询其他用户 GPU 进程、安装依赖或操作 Git。实际和模拟测试窗口均已关闭。

证据位于 test-results：gpu-window-tests.json、gpu-window-native-checks.json、gpu-window-live-samples.json。最终模拟界面截图：gpu-window-native-max-light.png、gpu-window-native-max-dark.png、gpu-window-native-restored.png、gpu-window-native-small.png、gpu-window-native-small-bottom.png、gpu-window-native-wsl.png。

桌面测试输出现在放入 test-results/playwright，防止 Playwright 默认清理整个 test-results 时删除独立测试 worker 和其他验收文件。shell 测试通过测试启动器显式隔离 appData，避免 Windows 原生路径忽略 APPDATA 环境变量替换。

关闭旧 GPU 窗口，再从主页面重新打开即可加载最新布局。
