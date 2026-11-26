# Training Monitor（训练监控器）

用于集中查看与管理远程 SSH（Linux）及本地 WSL 训练任务的 Windows 桌面监控应用，基于 Electron、React、TypeScript 与 Vite 构建。

## 主要功能

- **多宿主与任务管理**：支持按 SSH 别名或 WSL 发行版登记宿主与训练任务，提供独立的宿主概览视图与任务详情视图。
- **进程与证据归属**：通过只读探针（`src/probe/readonly_probe.py`）采集 `/proc` 进程、工作目录、脚本入口与检查点文件状态，结合证据置信度展示运行状态、全局/本轮训练进度、速率与 ETA。
- **实时与补读日志控制台**：支持多日志源（训练日志、状态 JSON、队列锁）持久化游标追踪、断点续读、搜索过滤与本地 SQLite 缓存。
- **GPU 实时监控**：任务视图展示与已确认训练进程关联的 GPU 占用；宿主首页及独立 GPU 原生窗口展示全部设备的实时利用率与显存状态，支持浅色 / 深色 / 跟随系统主题切换。
- **GPU 空闲自动启动（SSH tmux）**：支持为 SSH 任务配置连续空闲时间、GPU 利用率与显存阈值，通过远端 `tmux` 托管等待并在条件满足时自动启动训练。

## 技术栈

- **桌面壳与前端**：Electron 44、React 19、TypeScript、Vite、@tanstack/react-virtual
- **本地存储与采集**：Node Worker + SQLite 本地缓存、Python 只读探针与远端启动代理（`ssh.exe` / `wsl.exe` 传输）
- **测试**：Vitest、Testing Library、Playwright（Electron 桌面测试）

## 目录结构

```text
├── src/
│   ├── collector/   # 采集调度、退避与生产 API 服务
│   ├── desktop/     # Electron 主进程、窗口管理、IPC 与 preload
│   ├── domain/      # 生命周期、进度、检查点、资源与归属领域逻辑
│   ├── launch/      # SSH tmux 自动启动控制器、账本与远端代理
│   ├── logs/        # 日志字节偏移、连续性、解码与分代管理
│   ├── mocks/       # 本地演示 / 测试用 Mock API 与样例数据
│   ├── parsers/     # 通用及算法日志解析器
│   ├── probe/       # 远端只读 Python 探针
│   ├── registry/    # 宿主/任务登记与主题偏好持久化
│   ├── renderer/    # React 前端界面与组件
│   ├── shared/      # 前后端共享契约、校验与常量
│   ├── store/       # SQLite Worker 与存储协议
│   └── transport/   # SSH / WSL 传输与 GPU 查询封装
├── scripts/         # 构建、启动与运行时检查脚本
├── tests/           # 单元、领域、存储、传输、仿真、UI 与桌面端测试
├── docs/            # 设计规格、草案、审查与验证记录
└── DESIGN.md        # 界面与交互设计约定
```

## 常用命令

```bash
# 安装依赖
npm install

# 构建主进程、Worker 与渲染进程
npm run build

# 构建并启动桌面应用
npm start

# TypeScript 类型检查
npm run typecheck

# 运行单元测试与 Worker 测试
npm run test:unit

# 运行运行时检查 / Electron 桌面端测试
npm run test:runtime
npm run test:desktop

# 打包 Windows x64 目录或 zip 分发包
npm run package:dir
npm run package:win
```

更多设计细节与交互规范见 [DESIGN.md](DESIGN.md) 与 [docs/](docs/)。
