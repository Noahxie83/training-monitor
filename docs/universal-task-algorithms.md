# 通用算法名称与日志识别

日期：2026-11-11。任务登记沿用 Operate 模式及已选定的两套主题。

## 用户要求与结果

原算法下拉框仅列出 Flow Matching、Score-based、Reflow 和其他，且 algorithm 同时承担显示名称与选择解析器的职责。这使监控器看起来只支持用户以前的几个项目。

现在算法名称为选填自由文本，最多 120 字符，支持中文、任意算法或模型名称。新任务可以不填写名称。主页面显示填写的名称，保存后重新编辑仍保留。

日志识别移至高级选项，新增任务默认通用识别，也可选择仅查看日志或旧任务的专用兼容格式。名称与识别方式独立：即使名称为 Flow Matching，选择通用识别也不会套用 Flow 续训公式。

## 数据与兼容

TaskRegistration.algorithm 从封闭枚举变为名称字符串，并新增可选 logFormat。registry 仍为版本 1；没有修改 SQLite schema。旧配置未填写 logFormat 时，flow/score/reflow 仍使用原解析器，unknown 保持原来只读日志的语义。编辑旧任务且没有改变名称和格式时保留原有字段，不强制迁移。

通用识别支持带训练语义的 step/loss 文本、含数值 step 和 loss 或训练阶段的 JSON，以及 tqdm 已完成/总次数格式。它继续经过原来的注册脚本、直接写入者、文件身份、字节范围、完整记录和当前运行绑定验证。心跳、排队、验证日志、不安全数值、不完整记录不作为训练进度。

明确的 step 只显示为 Step，不假定从 0 或 1 开始，不据此推算完成次数。tqdm 提供本轮已完成/总次数；无专用基线时不生成累计进度、续训偏移或 ETA。

## 验证

- typecheck、生产 build 通过。
- 393 项相关测试、33 个文件通过：全部 domain/unit/simulations/transport/store 和当前使用的核心 UI 测试。
- 新增模拟采集链路验证：自定义 PPO 任务可识别后续训练 Step；名称为 Flow Matching 的通用任务仅得到 tqdm 本轮进度，不得到 Flow 累计公式。
- 7 项已有桌面检查通过。新增原生桌面检查通过：使用独立 appData、正式 collector/store/IPC 和停用宿主，填写自定义名称，保存至实际 registry.json，重新加载后编辑仍能读取；没有连接 SSH 或启动 WSL。
- 最终浅深色表单截图已查看；Impeccable 检测一次，结果为空数组。

测试仅写独立临时数据，没有修改用户登记配置或训练文件，没有操作 Git、安装依赖。测试窗口已关闭。

证据：test-results/algorithm-tests.json、algorithm-design-detector.json、algorithm-form-light.png、algorithm-form-dark.png；原生测试位于 tests/desktop/task-algorithm.spec.ts。

重启桌面应用以加载新的主进程校验规则和任务编辑器。
