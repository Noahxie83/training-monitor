# GPU 监控验收记录

日期：2026-11-05，时间为北京时间。承接 `gpu-monitor-brief.md`，没有重设计监控链路。

## 最终实现

SSH 的 Python host probe 只查询 `index,uuid,utilization.gpu,memory.used,memory.total`；WSL 先确认分发版已运行及 host probe 成功，才执行 Windows 的固定 `nvidia-smi.exe` 汇总查询。两者不使用 GPU 进程查询。没有训练 PID 或 task scan 失败时，设备资源仍可独立更新。

collector 复用现有 5 秒调度，每轮每宿主只采一次 GPU，供同宿主任务共享。目标改变时清除设备缓存。失败保留已有样本及其时间并标记 stale；重启缓存也降级 stale。GPU 失败与 host/log 状态隔离。

真实界面暴露并修复两处问题：服务器时间领先桌面约 2100 ms，原资源未来时间校验会丢弃有效数据，因此实时响应在桌面接收时记录资源时间；原有第二层节流依据探测完成时间跳过间隔 tick，现由既有 scheduler 单独负责调度与防重叠。

资源卡片顶部显示 GPU 编号、利用率、显存已用/总量与轻量条形图；未知值不伪装成 0。旧值标“待更新”，整卡资源保持与训练进程资源分区。无样本的 Worker 不生成重复占位指标。字体和固定展开侧栏保留。

## 检查清单与实际结果

| 检查 | 方式与结果 |
| --- | --- |
| 多卡、N/A、0%、MiB 转 bytes | transport GPU 解析测试通过 |
| SSH/WSL 来源与停用保护 | mock transport 路径测试通过；没有实际启动 WSL |
| 同 host 共享、无 PID/scan 失败 | collector + store 集成测试通过 |
| GPU 超时/错误不破坏日志 | 本地 transport、collector 和 Python mock 测试通过 |
| 断线保留时间、stale、恢复、重启缓存 | 本地集成测试通过 |
| 远端时钟偏差与 5 秒调度 | transport 偏差回归测试、模拟探测耗时的调度测试、真实 Electron 采样通过 |
| 任务切换 | 正式窗口 Flow Matching/Reflow/Score-based 均显示八卡；模拟本地 WSL 任务显示单卡，切回 SSH 恢复八卡 |
| 未知/旧值/空数据/恢复 | 隔离 Electron fixture 验证未知利用率无 aria-valuenow，旧值有待更新，空数据有简短提示，恢复可显示有效 0% |
| 八卡滚动、小窗口 | 960×650 viewport，GPU 0 与 GPU 7 的截图已检查，无横向溢出、关键区域遮挡或重复 Worker 未知行 |
| 实际实时更新 | 最终正式 Electron 连续 19 轮，15:36:25～15:37:55；每轮三个任务各 24 项 fresh 设备指标，间隔 4880～5098 ms，利用率实际变化 |

执行结果：

```text
node scripts/test-workers.mjs
  成功（Luna 构建实际 SQLite 测试 worker）
node node_modules/vitest/vitest.mjs run tests/transport tests/simulations tests/store tests/ui/resources.test.tsx --config vitest.config.ts
  12 files passed, 99 tests passed
python -m unittest discover -s tests/probe -p test_gpu_probe.py
  19 tests, OK
npm run typecheck
  通过
npm run build
  通过
```

没有运行全项目测试或声称全项目无缺陷。DeepSeek 限定复核未发现核心阻塞，Luna 后端测试与 Gemini Python mock 测试均由主控查看并整合。测试夹具中的类型错误和 Windows stdout mock 已修复并重跑。

## 证据与边界

- `test-results/gpu-live-ui-final-samples.json`：最终真实自动采样，所有指标为 device scope、无 processKey。
- `test-results/gpu-live-ui-final.png`：最终正式界面。
- `test-results/gpu-ui-960x650.png`、`gpu-ui-960x650-scroll.png`、`gpu-ui-fit.json`：最终模拟八卡布局与滚动结果。
- `test-results/gpu-ui-stale.png`：模拟旧值/未知值状态。
- `test-results/gpu-ui-fixture.tsx`、`gpu-ui-main.cjs`：隔离模拟检查入口，生产构建不引用它们。
- `test-results/gpu-live-samples.json`：上一阶段真实 SSH 两次采样、本机 Windows 一卡解析证据，未覆盖真实 WSL runtime。
- `test-results/gpu-live-ui-samples.json`：本次修复前间歇空数据的现场证据，供定位问题，不代表最终结果。

WSL 当前停用且未登记本地任务，真实 WSL 整链路未验证。没有唤醒 WSL、改变 registry、控制训练、安装依赖或使用 Git。正式窗口读取的 registry SHA256 前后均为 `C9CD4665CA40EB388A170633A8AA62E1C770834CEC3E347E37EDAA0634C0EC7D`；实际 revision=1，与旧交接中的 revision=7 不同。所有本次测试 Electron 实例已关闭。

隔离启动首次因 Windows 环境不完整弹出 appData 错误，错误实例已关闭；之后通过正常 PowerShell 环境启动成功，未因此修改生产代码或配置。桌面快捷方式重新打开后使用最终 `dist/main.cjs`。
