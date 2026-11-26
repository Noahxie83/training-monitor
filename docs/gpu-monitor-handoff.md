# GPU 功能重启交接

## 最终完成记录（2026-11-05，本聊天）

本次已承接磁盘实现完成交付。下方暂停记录保留为历史，后续以本节及 `docs/gpu-monitor-verification.md` 为准。

- DeepSeek 与 Gemini 子代理均实际回复连通标记；DeepSeek 完成限定范围只读复核，Luna 补齐后端测试，Gemini 补齐 Python mock 测试。代理已关闭。
- 主控真实界面发现并修复服务器时钟领先约 2.1 秒造成 GPU 样本间歇消失的问题：远端 GPU 实时响应使用桌面接收时间参与 TTL 校验，失败仍保留原样本时间并标 stale。
- 移除重复的完成时间节流，直接使用现有 5 秒、防重叠的调度；同宿主多个任务共享一次样本。宿主 target 改变时清除旧设备缓存。
- GPU 位于资源卡片顶部；无资源样本的 Worker 不再逐行显示未知指标。保留微软雅黑、固定展开侧栏及整卡/进程分区。
- 最终聚焦测试 12 文件、99 项通过；Python GPU mock 测试 19 项通过；typecheck、build 通过。
- 最终真实 Electron 自动刷新连续 19 轮（北京时间 15:36:25～15:37:55），每轮三个服务器任务均有 8 卡、24 项 fresh device 指标；间隔 4880～5098 ms，利用率有变化，无空白轮次。
- 960×650 界面无横向溢出，GPU 7 可滚动查看；模拟 SSH 八卡/WSL 单卡切换、未知/旧值/恢复均验证。真实 WSL runtime 仍未验证，没有唤醒或修改 WSL。
- 本次正式窗口读取 `C:\Users\noahx\AppData\Roaming\TrainingMonitor\registry.json`，实际 revision=1，SSH 根目录仍为 `/data2/cy/xzn`，WSL disabled；此文件修改时间为 2026-10-22，本次前后 SHA256 相同。旧交接中的 revision=7 不能当成本次实际读取值。
- 所有本次打开的 Electron 窗口已关闭，未改 registry、训练、模型配置，未使用 Git或安装依赖。曾因隔离启动环境不完整触发 appData 错误弹窗，已关闭该测试实例并改用完整 Windows 环境启动；无需修改生产配置。

最终证据：`test-results/gpu-live-ui-final-samples.json`、`gpu-live-ui-final.png`、`gpu-ui-960x650.png`、`gpu-ui-960x650-scroll.png`、`gpu-ui-fit.json`。`gpu-live-ui-samples.json` 是修复前发现问题时的证据，不能作为最终结果。

## 最新补充：转入新聊天（2026-11-05）

用户已将 C:\Users\noahx\.codex\config.toml 的 [features] multi_agent_v2 设为 false，主控已只读核实。用户报告在新聊天测试 auto/deepseek-v4.1-flash 收到 HTTP 200（约 1.96 秒），因 32-token 限额未生成最终正文；这证明接口能响应，不能据此宣称子代理已完成项目任务。原聊天反复测试仍受旧 V2 任务封装限制，用户现明确要求切换到新聊天继续。

恢复后先用少量输出预算测试 DeepSeek 子代理是否真正能读到任务并回复；成功后可安排一次窄范围核心复核，Luna继续必要实施。若仍不可用，提供手动提示词即可，不要继续反复排查配置或阻塞 GPU 功能。Gemini 无法主动调用时同样提供提示词。

GPU 部分自下面暂停记录后没有继续完成验收；原 Luna 已被中断，没有应继续写文件的代理。请以磁盘文件为准承接，完成核心测试与实际界面验证，不重启设计流程或多轮审查。

保存时间：2026-11-05 15:08（北京时间）。用户要重启 Codex，主控已中断正在工作的 Luna 子代理，暂停实施。请先读此文件，再继续；不要把未完成的功能宣布已交付。

## 用户需求与工作方式

- Windows 桌面训练监控器。SSH 服务器任务显示服务器所有 GPU 的整卡使用；本地 WSL 任务显示本机物理 GPU。约 5 秒更新编号、利用率、显存已用 / 总量。
- 仍为只读；服务器个人任务根目录 /data2/cy/xzn。只读 GPU 整卡聚合，不查询其他人的进程列表、PID、名称。
- 用户讨厌过度防御、多轮审查、冗余小字。做核心功能和必要验证即可。全局微软雅黑，固定展开侧栏。
- 主控负责协调，Luna 可直接调用并已经实施。DeepSeek 在本会话调用两次均失败（任务封装被 ChatGPT backend 加密，magpie 路由模型无法读取）。用户现已修改相关设置并准备重启 Codex；恢复后可重新测试。Gemini 若无法直接调用，则提供手动提示词。不要声称代理已成功执行，除非收到结果。
- 完整任务书和各模型提示词：docs/gpu-monitor-brief.md。
- 先读 C:\Users\noahx\.codex\RTK.md。不要操作 Git、安装依赖、启动/停止训练、修改远端文件或用户 registry。

## 当前代码状态（部分实现已落盘，尚未最终验收）

Luna 子代理名 /root/gpu_chain_luna，暂停前 running，主控已调用 interrupt_agent。恢复时可先查代理状态，或在新会话重新委派 Luna；不依赖旧代理内存。

已修改 / 新增的主要文件：

- src/probe/readonly_probe.py：probe_host 内增加仅聚合 nvidia-smi 查询，可用 includeGpu 跳过；2 秒命令超时；工具失败与 host 失败隔离。
- src/transport/types.ts：HostObservation 可选 gpu + HostGpuObservation，内部结构。
- src/transport/gpu.ts：projectGpuCsv，index/uuid/utilization/memory CSV → 现有 ResourceMetric[]；deviceId 显示 GPU N；N/A 为 null，MiB 转 bytes。
- src/transport/transport.ts：SSH 接收 Linux GPU CSV；WSL 先确认运行 / probe host，再从 Windows System32 nvidia-smi.exe 采样，绝不把本地数据填给 SSH。
- src/collector/service.ts：5 秒刷新、同主机共用 GPU 样本，taskResources 通过 projectResources 投影，失败保留旧值为 stale。
- src/domain/lifecycle.ts：扫描失败的早返回也接收 input.resources，使任务未确认时 GPU 可独立更新。
- src/store/engine.ts：重启缓存资源降级 stale，当前进程刚采样成功的资源保留独立 freshness。
- src/renderer/components/ResourceMetrics.tsx、src/renderer/style.css：GPU 利用率 / 显存轻量条形显示；不要为每个进程生成 8 行未知显存。
- tests/transport/gpu.test.ts：已创建；其他新增测试可能尚未写完。

中断时主控未收到实施完成报告。以上全部代码仍需一次核心检查、聚焦测试、类型检查、build，以及实际 Electron 界面验证。不要沿用之前 UI 任务的测试结果作为本次结果。

## 已完成且主控验证的真实只读证据

- 服务器 lab-campus 的 nvidia-smi 聚合查询成功，8 张卡（0..7）。
- 新 transport + Python probe_host 已实际连接服务器连续采样两次，相隔约 5.6 秒，均 connected + GPU available，8 卡共 24 项指标，所有项均 device scope，无 PID；两次时间推进且利用率数值变化。
- 本机 Windows 的 C:\WINDOWS\system32\nvidia-smi.exe 成功，1 张卡；新 CSV 解析成功。
- 证据：test-results/gpu-live-samples.json。
- 主控辅助文件：test-results/gpu-live-entry.ts、gpu-live-entry.cjs、gpu-live-check.cjs。辅助脚本只跑 probeHost，不 probeTask，不运行训练。编译命令：node -e 'require("esbuild").buildSync({entryPoints:["test-results/gpu-live-entry.ts"],outfile:"test-results/gpu-live-entry.cjs",bundle:true,platform:"node",format:"cjs",target:"node24"})'；然后 node test-results/gpu-live-check.cjs。无需因重启重复现场 SSH，代码变动影响链路才重跑。
- WSL 当前没有运行实例，且 registry 内 wsl-ubuntu enabled=false、未登记任务。真实 WSL 集成没有验证。不要为测试启动 WSL或修改其登记配置。
- 用户 registry revision=7，lab-campus enabled=true、allowedRoots=[/data2/cy/xzn]；3 个开启任务 flow-cifar10/score-based/reflow。保持不变。

## 恢复后的最短路径

1. 检查 Luna 当前落盘实现和测试，确认两处核心问题已处理：task scan 失败不吞 GPU；store 不把刚采到的 GPU 无条件变 stale。主控暂停前看到这两处已开始修正，但尚未测试确认。
2. Luna 补完必要测试：多卡/N/A/0%、WSL 与 SSH 分支隔离、同 host 多任务单次采样、无 PID/scan 失败仍显示 GPU、GPU 错误不破坏 host/log、断线旧值和重启缓存 stale、恢复成功变 fresh。避免扩展成全项目审查。
3. 运行相关聚焦测试、npm run typecheck、npm run build，保留真实结果。不要因为静态推测开启多轮审查。
4. 用 playwright-interactive 检查实际 Electron UI：8 卡资源可滚动、没有大片未知进程指标，960×650 无横向溢出；运行中数值能更新。没有 Electron 进程运行时可启动真实监控（只读）；开始前重新确认运行进程，别误终止用户已有窗口。也可用隔离 demo/fixture 检查宿主切换和未知值，明确标模拟。
5. 交付简明说明；真实 WSL runtime 未验证要诚实说明。桌面快捷方式「训练监控器」指向 node_modules/electron/dist/electron.exe + dist/main.cjs，新 build 后重新打开即生效。

## UI 工具提示

playwright 包和 Electron 已安装，无需下载。Node REPL 工具可用：用 createRequire('D:/Project/Process Monitoring/package.json') 加载 playwright。可以通过 Electron --remote-debugging-port=9229 在 127.0.0.1 连接，正式模式通过 PowerShell Start-Process 启动可继承正常 SSH 环境。用户未要求打开可见窗口时使用 -WindowStyle Hidden。

多个 Electron 实例测试要用独立 --user-data-dir，避免单实例锁影响用户窗口。辅助窗口检查后正常关闭。不要用批量 kill 结束 Electron 或任何训练进程。
