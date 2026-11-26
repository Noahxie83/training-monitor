# Dependency alert triage

日期：2026-10-19。依据根目录 `package.json`、`package-lock.json`、现有 `package:dir` 日志和一次 `npm audit --json` 查询。审计原始 JSON 保存在 [dependency-audit-raw.json](../../.superpowers/sdd/2026-10-18-training-monitor-implementation/dependency-audit-raw.json)。查询返回退出码 1（存在告警），报告 8 项 moderate、0 项其他严重级别；451 个依赖节点中 6 prod、446 dev、96 optional、13 peer（npm 的分类口径可能重叠）。没有运行修复或安装命令。

## 8 项告警与实际依赖链

锁文件把以下构建依赖都标为 `dev: true`。主包直接依赖 `electron-builder@26.15.3`；该版本依赖 `app-builder-lib@26.15.3` 和 `dmg-builder@26.15.3`，而 `app-builder-lib` 又把 `dmg-builder` 与 `electron-builder-squirrel-windows@26.15.3` 声明为 peer。`app-builder-lib` 的 `@electron/get@^3` 在锁文件中解析为嵌套的 `@electron/get@3.1.0`，它把 `global-agent@^3` 声明为可选依赖，随后是 `global-agent@3.0.0` → `roarr@2.15.4` → `sprintf-js@1.1.3`。根层的 `@electron/get@5.1.0` 是 Electron 44 的另一条依赖，不能与受影响的嵌套版本混为一谈。

| npm 报告项 | 锁文件版本与路径 | 审计报告给出的范围 / 说明 | 影响面 |
|---|---|---|---|
| `electron-builder`（直接开发依赖） | 26.15.3 → `app-builder-lib` 26.15.3、`dmg-builder` 26.15.3 | `19.25.0` 或 `26.6.0–27.0.0-alpha.2`；经两个子包受影响 | Windows/macOS/Linux 安装包生成工具链；此项目当前执行 Windows x64 dir/zip 打包 |
| `app-builder-lib` | 26.15.3；由 builder 与 dmg-builder 使用，并作为 squirrel-builder 的 peer | `26.6.0–27.0.0-alpha.2`；经 `@electron/get`、`dmg-builder`、squirrel-builder | 打包编排和平台资源处理阶段 |
| `dmg-builder` | 26.15.3 → `app-builder-lib` 26.15.3 | `26.6.0–27.0.0-alpha.2`；依赖受影响的 app-builder-lib | macOS DMG 构建；当前 Windows target 未使用该输出路径 |
| `electron-builder-squirrel-windows` | 26.15.3 → `app-builder-lib` 26.15.3（peer） | `26.6.0–27.0.0-alpha.2`；依赖受影响的 app-builder-lib | Windows Squirrel target；当前日志记录的是 `dir` target，不是 Squirrel 安装包 |
| `@electron/get` | 嵌套 3.1.0（app-builder-lib）；该包可选依赖 `global-agent` | `1.6.0–4.0.3`，经 `global-agent` | 构建时 Electron 下载/代理相关工具；未证实在生成应用运行时加载 |
| `global-agent` | 3.0.0（可选）→ `roarr` 2.15.4 | `<=3.0.0`，经 `roarr` | 上述构建时代理链的可选依赖；具体受攻击输入条件未由本次 npm JSON 解释 |
| `roarr` | 2.15.4（可选）→ `sprintf-js` 1.1.3 | `<=2.15.4`，经 `sprintf-js` | 构建时日志格式化依赖链 |
| `sprintf-js` | 1.1.3（可选） | `<=1.1.3`；GHSA-hp3w-g68c-fv3c：无界精度说明符可导致拒绝服务，CVSS 5.3 / CWE-1284 | 若被触发，影响使用该格式化路径的进程可用性；当前没有证据表明这个输入路径暴露给已交付应用用户 |

这 8 项是 npm 按受影响包/依赖效果展开的 8 条记录，沿同一条可选打包工具子树串联，并非 8 个相互独立的应用运行时入口。npm JSON 只为 `sprintf-js` 提供了具名 GHSA、CWE、CVSS 和简述；其余记录仅列出 `via`、受影响范围和影响关系，不能据本次结果补写具体利用条件。

## 产物边界与风险可达性

此仓库把 `electron-builder`、Vite、esbuild、测试工具和 Electron 声明为开发依赖；运行依赖只有 `@tanstack/react-virtual`、React 和 React DOM。`scripts/build.mjs` 将 Electron main、preload、runtime-canary 用 esbuild `bundle: true` 输出到 `dist`，复制 SQLite worker，再用 Vite 构建 renderer。`electron-builder.yml` 的 `files` 仅列出 `dist/**/*` 与 `package.json`，启用 asar；安装日志也显示 builder 执行 rebuild、下载 Electron、搜索 node modules 并生成 `release/win-unpacked`。在当前 T1 fix1 的已生成 `release/win-unpacked/resources/app.asar` 中，使用本地 `@electron/asar` 的 `listPackage` 和 `extractFile` 内存 API 检查所有 `node_modules` 路径，并读取应用与命中包的 package.json：没有 `electron-builder`、`app-builder-lib`、`dmg-builder`、`electron-builder-squirrel-windows`、`@electron/get`、`global-agent`、`roarr` 或 `sprintf-js` 的包路径；asar 根 manifest 仅声明 3 个 production dependencies，asar 内仅看到 production 包树。完整路径检查结果、包大小和 SHA-256 见同目录的 `dependency-audit-boundary-evidence.txt`。

当前包的 `dist/main.cjs` 静态外部 require 只有 `electron` 与 `node:path`、`node:os`、`node:url`、`node:worker_threads`、`node:fs/promises`；`preload.cjs` 只外部 require `electron`；`runtime-canary.cjs` 只外部 require `node:worker_threads`、`node:fs/promises`、`node:path`；SQLite worker 只外部 require `node:worker_threads`、`node:sqlite`。renderer bundle 没有静态 import 或外部 require，React/React DOM 是其 Vite bundle 内代码；asar 另将 `react-dom@19.3.1`、`react@19.3.1` 和 `@tanstack/react-virtual@3.14.21` 收入 `node_modules`。这是对打包依赖路径和编译后外部模块边界的证据，不是对每个应用路径的运行时行为、动态载入或依赖自身漏洞的全面证明。故此 T1 fix1 包内没有发现这条审计工具依赖链，但构建/打包主机仍会运行受影响工具，构建环境的 moderate 风险仍存在；构建期代理/日志格式化输入能否触发漏洞点也未由现有证据验证。T9 最终包需复核同一边界；本结论仅适用于 SHA-256 `bc3e9c359fd5f6a12b5c5acdc6d8176f6f014f8f1ce956eb4af1fb7ff8f39755` 的 T1 fix1 包，不可外推到之后的包。

## 建议与打包日志告警

npm 对全部 8 项都给出 `fixAvailable: electron-builder@26.5.0`，并标 `isSemVerMajor: true`。当前锁定的是 26.15.3，因此这是回退到较低版本而不是升级；不应把 `npm audit fix --force` 当作无风险升级。主控应选择：在保持当前锁文件不变的前提下接受并记录这个工具链告警，或先核对各公告/维护者说明和 26.5.0 与当前 Electron 44 配置的兼容性，再明确批准一次有范围的 builder 版本变更并重建验证。对 `sprintf-js` 子链，优先检查上游修复是否能通过相容的 `electron-builder` / `app-builder-lib` 版本收敛；不要直接覆盖传递依赖。

现有 `package:dir` 日志另有三项 builder 提示，均不是这 8 项 npm 安全告警：

- 缺少 `description` 和 `author`：builder 未能从 `package.json` 读取包描述及作者元数据。它们可能影响安装包/可执行文件的产品元信息与展示，不改变 npm audit 风险计数；日志没有证明产物中的具体字段值。
- `duplicate dependency references: react-dom@19.3.1`：builder 在收集依赖时发现重复引用。锁文件中根应用有一个 `react-dom@19.3.1` 版本；测试库将其作为 peer 引用，因此现有证据更像重复引用而非两个不同版本。renderer 构建仅 16 个模块、输出约 221 KB 的 JS，与 React 进入构建产物相符，但没有对 bundle 内容或 packaged app 的 node_modules 做核验，不能把此警告解释为已证明的重复运行时副本。
- `signAndEditExecutable: false`：builder 明确跳过签名和可执行文件资源编辑。日志建议若只想跳过签名而仍保留图标/元数据编辑，可配置 `signExecutable: false`。当前可确定 Windows 可执行文件未由本轮 builder 签名且资源编辑被跳过；是否属于交付阻断取决于主控的发布/签名要求。

这些判断仅供主控分诊，不构成交付批准；本次未改任何版本、代码或锁文件。


## 主控处置（2026-10-19）

保留批准的固定依赖与本地未签名zip。当前证据未发现该构建工具链随T1 fix1包分发，构建主机moderate风险仍保留在案；不执行audit fix/强制降级。批准的T9没有签名或安装器要求。T9最终产物须按新SHA256重新核对包内依赖路径和编译模块边界，交付记录注明残余风险与未签名本地分发限制；如最终发现该链进入运行产物则重新裁决，不能沿用本次边界结论。
