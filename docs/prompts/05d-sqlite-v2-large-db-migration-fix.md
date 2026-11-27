# Phase 5d 紧急修复提示词：解决大体积旧版 SQLite v1→v2 迁移触发 `STORE_READY_TIMEOUT`（建议 Codex 执行）

> **实机故障根因**：真实用户在 `AppData\Roaming\TrainingMonitor\monitor.sqlite` 中存在 **1.66 GB / 751,545 行 `log_events`** 的旧版 v1 本地缓存库。首次启动升级至 v2 时发生以下三重阻塞，100% 触发 `STORE_READY_TIMEOUT` 启动失败：
> 1. `src/store/client.ts:45` 将 `READY_TIMEOUT_MS` 硬编码为仅 **5,000 ms**；
> 2. `src/store/schema.ts:232-245` 在启动事务内执行 `db.prepare('SELECT seq, event_json FROM log_events').all()` 一次性把 **75 万行** 旧 JSON 全部拉入 V8 内存逐行 `JSON.parse/stringify` + 逐行 `UPDATE`，随后第 188 行同步执行全表 `INSERT INTO log_events_fts(log_events_fts) VALUES('rebuild')` 建 trigram 索引；
> 3. `src/store/worker-host.ts:58` 在发送 `{ kind: 'ready' }` 之前又同步阻塞等待 `await engine.retain(data.openedAt)`。

---

## 一、必须完成的根治改造

### 1. 消除大库启动迁移 OOM 与秒级超时（`src/store/schema.ts`、`src/store/engine.ts`）
- **绝不把全表 `.all()` 拉进 JS 内存**：
  - 将 `schema.ts:232-245` 的 JS 循环改为使用 SQLite 原生 `json_remove(event_json, '$.text', '$.rawAnsi')`（零 JS 内存开销、C 层速度）：
    ```sql
    UPDATE log_events
    SET event_json = json_remove(event_json, '$.text', '$.rawAnsi')
    WHERE json_valid(event_json)
      AND (json_extract(event_json, '$.text') IS NOT NULL OR json_extract(event_json, '$.rawAnsi') IS NOT NULL)
    ```
  - 对 `start_key`/`end_key` 补齐 `UPDATE`，先用 `SELECT 1 FROM log_events WHERE start_offset IS NOT NULL AND (start_key IS NULL OR end_key IS NULL) LIMIT 1` 快判，无缺失行则跳过全表扫描。
- **按表规模区分同步/后台异步迁移（大库 < 1 秒秒开）**：
  - 增加轻量元数据表 `store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`。
  - 在 `initializeSchema()` 执行 v1→v2 迁移时先检查 `SELECT COUNT(*) AS c FROM log_events`：
    - **中小库（`c <= 50_000`，覆盖全部现有迁移测试与普通新旧库）**：事务内直接执行 SQLite 原生 `json_remove` + `INSERT INTO log_events_fts(log_events_fts) VALUES('rebuild')`，一次完成，行为与现有 `phase2-store-v2.test.ts` 100% 兼容。
    - **大库（`c > 50_000`，如数十万~百万行历史缓存）**：
      1. 事务内仅执行秒级 DDL 操作：删除废表与 `log_events_text` 索引、补齐 v2 新表与列、建 `log_events_fts` 虚表及增删改触发器（确保所有新写入日志立即进 FTS5）、在 `store_meta` 写入 `fts_backfill_cursor = '0'`、`json_slim_cursor = '0'` 并提交 `user_version = 2`。
      2. 在 `StoreEngine.searchLogs()` 中：若 `fts_backfill_cursor` 尚未完成（仍存在），自动回退到直接扫描 `log_events`（与现有非 FTS5 路径一致），保证后台回填期间历史搜索结果 100% 完整准确；回填完成删除 `fts_backfill_cursor` 后自动切换 FTS5 加速。
      3. 新增 `StoreEngine.runBackgroundMigrationStep(batchSize = 2000)`：每次按 `seq > cursor ORDER BY seq ASC LIMIT batchSize` 分批在短事务内完成 `json_remove` 瘦身与增量写入 `log_events_fts(rowid, text)`，全部完成后清除 `store_meta` 标记并执行一次轻量 `PRAGMA incremental_vacuum(2000)` 释放历史冗余空间。

### 2. 解耦启动就绪与异步维护，放宽超时并增加迁移心跳（`src/store/worker-host.ts`、`src/store/client.ts`）
- **不再在 `ready` 之前阻塞跑生产 `retain()`**：
  - `src/store/worker-host.ts:58`：当 `testOnly === true` 时保持原同步 `await engine.retain(data.openedAt)`（兼容既有测试断言）；**生产模式（`!testOnly`）**在 `new StoreEngine(...)` 完成后**立即** `parentPort.postMessage({ kind: 'ready', ... })`，再通过 `writeTail` 异步调度首次 `engine.retain(data.openedAt)` 与分批 `runBackgroundMigrationStep()`（每批间 `yieldToMessages()`，绝不阻塞主界面打开和正常写入）。
- **合理化 `READY_TIMEOUT_MS` 与心跳续期**：
  - `src/store/client.ts:45`：将默认 `READY_TIMEOUT_MS` 从 `5_000` 提高到 `30_000`；在 `worker-host.ts` 构造 `StoreEngine` 前发送 `{ kind: 'migrating' }` 进度消息，`StoreClientImpl` 收到后重置超时计时器（总上限如 `120_000 ms`），彻底消灭大库或慢磁盘上的误杀超时。

### 3. 顺手修平 Windows HiDPI 下 `phase4-resilience.spec.ts:129` 的 3px 舍入断言
- **位置**：`tests/desktop/phase4-resilience.spec.ts:128-129`
- **根因**：Windows 125%/150% DPI 缩放下无边框重启恢复的窗口尺寸可能存在 1–4px 整数取整误差（实测 `[1064, 691]` vs `[1061, 691]`），第 129 行 `expect(stdout).toContain(...)` 严格字符串相等导致误报。
- **修复**：解析 `RESTORED_WINDOW_SIZE [w,h]`，在 `process.platform === 'win32'` 下断言宽高误差 `<= 4px`（非 Windows 保持精确相等 `0`）。

---

## 二、测试与验收要求

1. 在 `tests/store/phase2-store-v2.test.ts` 新增**大库迁移回归测试**：构造超过大库阈值（可通过注入阈值参数测试，如 500 行 + 阈值设为 100）的 v1 数据库，验证：
   - `StoreEngine` / Worker 秒级完成 schema v2 打开并立刻 `ready`；
   - 后台回填未完成前 `searchLogs` 仍可命中历史旧行；
   - 调用分批后台迁移完成后，`event_json` 中 `text`/`rawAnsi` 全部瘦身清除、`log_events_fts` 完整覆盖历史行并切换至 FTS5 检索。
2. 逐项运行全部验收命令，确认 **Windows 本机 100% 全绿**（包括 `test:desktop` **29 / 29 passed**）：
   ```bash
   npm run typecheck
   npm run test:python
   npm run test:unit
   npm run build
   npm run test:runtime
   npm run test:desktop
   ```
3. 请勿修改 `docs/prompts/` 下任何文件，全部通过后提交 commit 并 `git push origin main`。
