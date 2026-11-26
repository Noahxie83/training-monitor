# GPU 实时监控任务书

日期：2026-11-05。主控统筹，Luna 实施；不延续此前多轮形式化审查流程。

## 需求与默认范围

选择服务器任务时显示该服务器所有 GPU 的整卡使用情况；选择本地 WSL 任务时显示这台 Windows 电脑的 GPU。显示 GPU 编号、利用率和显存已用 / 总量，约每 5 秒更新。没有训练 PID 时也可显示整卡指标。设备总占用不等于当前训练进程占用，界面继续分区。

## 实施提示词（Luna）

项目：D:\Project\Process Monitoring。先读取 C:\Users\noahx\.codex\RTK.md。

在现有 Python probe → transport → collector → TaskSnapshot.resources → ResourceMetrics 链路上完成 GPU 整卡采样。现有 shared ResourceMetric 已支持利用率和显存 used/total，优先复用，不更改公共契约或 SQLite schema。

1. SSH：在 probe_host 内执行一次只读 nvidia-smi 聚合查询，字段 index,uuid,utilization.gpu,memory.used,memory.total，格式 csv,noheader,nounits。不要查询 compute-apps、进程表、用户名或其他人的 PID。通过既有 SSH 目标执行，不能在 Windows 侧取值填给服务器。
2. WSL：通过既有 WSL 正在运行的检查与 Linux host probe 确认目标；GPU 从 Windows 侧 nvidia-smi.exe 读取物理 GPU 汇总。不要额外唤醒停止的 WSL，不更改 WSL 或驱动配置。Windows 查询只用于 WSL target。允许使用已安装 Windows/System32 nvidia-smi.exe 或 PATH 中工具，命令固定、shell:false，复用 runBoundedChild，超时约 2 秒。WSL probe_host 可通过固定请求字段跳过重复的 Linux GPU 查询。
3. 内部 HostObservation 可加可选 gpu 结构，包含 observedAt、state/errorCode、metrics，复用 ResourceMetric[]。兼容旧模拟 Transport。不要把 GPU 查询失败写成 host/process scan 失败。
4. 同一轮、同一 host 只查询一次 GPU，供这个宿主所有任务共享；按 hostId 和 transport target 隔离。约 5 秒刷新，复用现有定时刷新，不新增重复定时器或后台服务。
5. CSV 中 N/A、Not Supported 等值按 null 处理，0% 是有效数值；MiB 转 bytes。仅接受合理数字（利用率 0..100，显存非负）。设备可用 UUID 或 GPU 编号作稳定 deviceId，界面应显示可读编号而不是长 UUID。
6. GPU 失败 / 断线时不显示虚构 0。已有样本保留原 observedAt，标 stale；初次无数据则显示暂无 GPU 数据。GPU 样本要能在 task scan 不完整或没有训练进程时单独刷新。重启读到本地缓存时旧资源也不能伪装 fresh。
7. 前端沿用 ResourceMetrics 的 GPU 整卡分区，简洁呈现每卡利用率、显存已用 / 总量，可用轻量条形指示；保留微软雅黑。不要增加温度、功耗、趋势图、常驻技术说明、启停训练按钮或新依赖。

建议文件：src/probe/readonly_probe.py、src/transport/{types,transport}.ts（可新增小型 gpu.ts）、src/collector/service.ts、src/domain/resources.ts（仅必要接线）、src/store/engine.ts（仅缓存 freshness 必要修正）、src/renderer/components/ResourceMetrics.tsx、src/renderer/style.css，及相关聚焦测试。不要重构训练/日志/进度链路，不更改 registry 或用户配置。不要操作 Git，不安装依赖。

实施者只运行本地聚焦测试、类型检查及构建；不自行连接 SSH/WSL，不运行训练或修改服务器。真实只读采样由主控协调。提供修改清单、命令真实结果及未验证项；一次交付即可，不要求冗长 RED/GREEN 报告或自行宣布审批通过。

必要验证：多 GPU 与 N/A/0%；SSH/WSL 采样路径不串；一宿主多任务只一次 GPU 查询；无训练 PID / task scan 失败仍可显示有效 GPU；GPU 查询超时不破坏 host/log；旧样本 stale 和重新成功后恢复；界面设备编号和显存合并显示。

WSL 查询限制参考：https://docs.nvidia.com/cuda/wsl-user-guide/ 。本机已只读核验 Windows nvidia-smi.exe 可返回 GPU 汇总；WSL 当前无运行实例，真实 WSL 集成不能声称已验证。

## 如需手动使用 DeepSeek 的提示词

只读复核 docs/gpu-monitor-brief.md 和本轮 GPU 变更。只检查三件事：SSH/WSL GPU 是否取自正确机器；GPU 错误是否影响训练监控/日志；界面是否把整卡使用量误报为我的训练进程占用。不要修改文件，不运行 Git、安装依赖或连接 SSH/WSL。不进行全项目或形式化审查。仅报告可重现的核心问题及位置，没有问题就说明未发现核心阻塞。此复核不阻塞主控已通过的核心测试。
