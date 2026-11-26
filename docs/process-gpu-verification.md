# 任务进程 GPU 归属验收

日期：2026-11-11。承接用户要求：自动识别当前任务进程使用哪张卡并显示用量；任务页不显示全部卡，全部卡保留在宿主首页。

## 最终行为

- 任务页只列出该任务实际关联的 GPU，显示物理卡号、PID、进程显存和可获取的进程 SM 利用率。未知利用率显示未提供，不拿整卡百分比替代。
- 点击侧栏宿主标题、宿主 ID 或顶部宿主按钮进入宿主首页，显示全部卡的整卡利用率与显存；点击任务回到进程与日志页面。独立 GPU 窗口继续提供整卡视图。
- 断线或采样失败保留原时间和旧值，标上次使用、待更新；进程启动时间或宿主 boot ID 改变后，不把旧卡归属沿用到新进程。

## 采集链路

在现有 task probe 中增加可选 processGpu。只对同 UID、登记脚本入口匹配、强 ProcessKey 已确认的目标采样。SSH 复用同轮宿主查询所得的 GPU UUID 与物理编号映射，再读取固定的 compute-apps PID/UUID/显存字段。无目标进程时不执行进程 GPU 查询。

最小 NVIDIA 进程行在远端立即按目标 PID 过滤，本机不接收无关进程的原始 CSV、名称、命令行或环境变量。采样前后重新检查所有权、PID 启动时间，限制命令时长、输出字节及行数。显存 N/A 为 null，0 是有效值，重复记录不重复累加。

可选 NVML 使用系统驱动已有库和 Python 标准库 ctypes；只采用最近 5 秒、晚于当前进程实例出生时间的 SM 样本，并在读取后再次验证进程身份。没有可靠样本时保留未知，不使用 accounting 的历史平均或整卡负载。

Transport 校验字段、进程实例、GPU 编号与宿主 boot ID；collector 只投影该登记任务的进程指标。相对入口路径按登记工作目录解析。GPU 错误与原进程扫描、日志和进度判定分离。TaskSnapshot 新增可选 gpuUsage，沿用 ResourceMetric 的 process scope；没有修改 SQLite schema。

WSL 当前不提供可靠的进程归属映射，界面明确提示不可用；保留 Windows 物理 GPU 的整卡视图，不把 Windows PID 和 Linux PID 按数字相同来匹配。

## 验证结果

- typecheck 与最终生产 build 通过。
- 400 项相关测试、35 文件通过；新增 SSH 帧接线测试单独通过，共 401 项。覆盖 PID/boot 换代、物理卡映射、多卡、未知与 0、采样失败、恢复、宿主导航、进程与整卡指标分离。
- Python probe 共 74 项：71 通过，3 项按环境跳过。新增 15 项覆盖候选过滤、所有权变化、超时、重复 GPU 行、SM 样本过期和 PID 出生时间。
- 9 项桌面检查通过。新增场景确认：任务只显示 GPU 6 的模拟进程利用率 74% 和显存 2 GiB，而不显示整卡 98%；切到宿主显示全部八卡，切回任务恢复单卡。浅深主题及 960×650 无横向溢出。
- 截图已查看并修正任务 GPU 标题换行和宿主列表间距。Impeccable 检测一次，无发现。
- 真实 SSH 只读复验：登记版本 12，任务 hdps_main_20261111 的状态文件为 paused，未发现登记入口进程，返回空进程 GPU 关联。没有启动或停止该任务。因此本轮不声称取得了该任务运行中的 GPU 正向现场样本；正向链路由模拟 probe、transport 帧和 collector 测试验证。

旧 T1 静态检查曾将 demo 中 WSL 标签误判为执行依赖；检查已改为验证 mock 没有导入或调用真实 transport/child_process，保留模拟与生产边界。

证据：test-results/process-gpu-live.json、process-gpu-tests.json、process-gpu-design-detector.json；最终模拟截图为 process-gpu-task-light.png、process-gpu-task-dark.png、process-gpu-task-small.png 和 process-gpu-host-dark.png。

参考：[NVIDIA NVML 进程利用率接口](https://docs.nvidia.com/deploy/nvml-api/latest/api/group__nvmlDeviceQueries.html)。接口使用最近进程采样，驱动不支持时返回未提供。

测试使用独立本地数据，实际复验仅访问登记任务及 /data2/cy/xzn 范围。没有修改用户登记、训练、驱动或 WSL 配置，没有安装依赖或操作 Git。所有本次测试窗口均已关闭。

重启桌面应用即可加载新的采集器和界面。
