import type { DatabaseSync } from 'node:sqlite';

export const STORE_SCHEMA_VERSION = 2;
const LARGE_MIGRATION_ROWS = 50_000;
const FTS_CURSOR = 'fts_backfill_cursor';
const JSON_CURSOR = 'json_slim_cursor';
const BACKFILL_END = 'backfill_end_seq';
const LEGACY_CLEANUP = 'legacy_cleanup_pending';

function dropLegacySchema(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS log_events_text;
    DROP TABLE IF EXISTS run_bindings;
    DROP TABLE IF EXISTS task_projection;
    DROP TABLE IF EXISTS checkpoint_samples;
  `);
}

export function hasPendingFtsBackfill(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(FTS_CURSOR) !== undefined;
}

function currentUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

function legacySchemaVersion(db: DatabaseSync): number | null {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  if (!exists) return null;
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
  return typeof row?.version === 'number' ? row.version : null;
}

function ensureBaseTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_registry (
      source_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      recovery_json TEXT
    );
    CREATE TABLE IF NOT EXISTS source_cursors (
      source_id TEXT PRIMARY KEY REFERENCES source_registry(source_id),
      cursor_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_generations (
      source_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('tracking','reconciling','sealed')),
      cursor_json TEXT NOT NULL,
      PRIMARY KEY(source_id, generation)
    );
    CREATE TABLE IF NOT EXISTS raw_chunks (
      chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      start_offset TEXT NOT NULL,
      end_offset TEXT NOT NULL,
      bytes BLOB NOT NULL,
      ingested_at TEXT NOT NULL,
      UNIQUE(source_id, generation, start_offset)
    );
    CREATE TABLE IF NOT EXISTS raw_usage (
      owner_type TEXT NOT NULL CHECK(owner_type IN ('global','task')),
      owner_id TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0),
      PRIMARY KEY(owner_type,owner_id)
    );
    CREATE TABLE IF NOT EXISTS raw_support (
      support_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      start_offset TEXT NOT NULL,
      end_offset TEXT NOT NULL,
      start_key TEXT NOT NULL,
      end_key TEXT NOT NULL,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS raw_support_range ON raw_support(source_id,generation,start_key,end_key,ingested_at);
    CREATE INDEX IF NOT EXISTS raw_support_start ON raw_support(source_id,generation,start_key);
    CREATE INDEX IF NOT EXISTS raw_support_end ON raw_support(source_id,generation,end_key);
    CREATE INDEX IF NOT EXISTS raw_chunks_source_range ON raw_chunks(source_id, generation, chunk_id);
    CREATE INDEX IF NOT EXISTS raw_chunks_age ON raw_chunks(ingested_at, chunk_id);
    CREATE TABLE IF NOT EXISTS log_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      start_offset TEXT,
      end_offset TEXT,
      ingested_at TEXT NOT NULL,
      text TEXT,
      raw_ansi TEXT,
      event_json TEXT NOT NULL,
      start_key TEXT,
      end_key TEXT
    );
    CREATE INDEX IF NOT EXISTS log_events_source_order ON log_events(source_id, seq DESC);
    CREATE INDEX IF NOT EXISTS log_events_generation_seq ON log_events(source_id,generation,seq);
    CREATE TABLE IF NOT EXISTS source_epochs (
      source_id TEXT PRIMARY KEY,
      content_epoch INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS content_changes (
      source_id TEXT NOT NULL,
      content_epoch INTEGER NOT NULL,
      event_seq INTEGER NOT NULL,
      PRIMARY KEY(source_id, content_epoch)
    );
    CREATE INDEX IF NOT EXISTS content_changes_range ON content_changes(source_id, event_seq, content_epoch);
    CREATE TABLE IF NOT EXISTS pending_remote_cancels (
      host_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (host_id, task_id, arm_id, config_hash)
    );
    CREATE TABLE IF NOT EXISTS observation_snapshot (
      task_id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_snapshots (
      host_id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_id TEXT,
      observed_at TEXT NOT NULL,
      step REAL,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS metric_samples_lookup ON metric_samples(task_id, metric_name, observed_at);
    CREATE INDEX IF NOT EXISTS metric_samples_age ON metric_samples(observed_at);
    CREATE TABLE IF NOT EXISTS gpu_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      util_pct REAL,
      mem_used_mib REAL,
      mem_total_mib REAL,
      temp_c REAL,
      power_w REAL
    );
    CREATE INDEX IF NOT EXISTS gpu_samples_lookup ON gpu_samples(host_id, device_id, observed_at);
    CREATE INDEX IF NOT EXISTS gpu_samples_age ON gpu_samples(observed_at);
    CREATE TABLE IF NOT EXISTS host_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      cpu_pct REAL,
      ram_used_mib REAL,
      ram_total_mib REAL
    );
    CREATE INDEX IF NOT EXISTS host_samples_lookup ON host_samples(host_id, observed_at);
    CREATE INDEX IF NOT EXISTS host_samples_age ON host_samples(observed_at);
    CREATE TABLE IF NOT EXISTS cache_evictions (
      eviction_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      start_offset TEXT NOT NULL,
      end_offset TEXT NOT NULL,
      evicted_at TEXT NOT NULL,
      start_key TEXT,
      end_key TEXT,
      cleanup_cursor_seq INTEGER NOT NULL DEFAULT 0,
      cleanup_phase TEXT NOT NULL DEFAULT 'predecessor',
      cleanup_group_key TEXT,
      cleanup_cursor_start_key TEXT,
      cleanup_cursor_event_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS cache_evictions_source ON cache_evictions(source_id, generation, start_offset);
  `);
}

function ensureFts5(db: DatabaseSync, backfill: boolean): void {
  // During backfill, rows ahead of the cursor and within the original high-water
  // mark have no FTS entry to delete unless a live write has indexed them.
  const pending = (row: 'new' | 'old') => `EXISTS (
    SELECT 1 FROM store_meta WHERE key = '${FTS_CURSOR}' AND ${row}.seq > CAST(value AS INTEGER)
      AND ${row}.seq <= (SELECT CAST(value AS INTEGER) FROM store_meta WHERE key = '${BACKFILL_END}')
  )`;
  const indexed = `NOT ${pending('old')} OR EXISTS (SELECT 1 FROM fts_backfill_updates WHERE seq = old.seq)`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS fts_backfill_updates (seq INTEGER PRIMARY KEY);
    CREATE VIRTUAL TABLE IF NOT EXISTS log_events_fts USING fts5(
      text,
      content='log_events',
      content_rowid='seq',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS log_events_ai AFTER INSERT ON log_events BEGIN
      INSERT INTO log_events_fts(rowid, text) VALUES (new.seq, new.text);
      INSERT OR IGNORE INTO fts_backfill_updates(seq) SELECT new.seq WHERE ${pending('new')};
    END;
    CREATE TRIGGER IF NOT EXISTS log_events_ad AFTER DELETE ON log_events WHEN ${indexed} BEGIN
      INSERT INTO log_events_fts(log_events_fts, rowid, text) VALUES('delete', old.seq, old.text);
      DELETE FROM fts_backfill_updates WHERE seq = old.seq;
    END;
    CREATE TRIGGER IF NOT EXISTS log_events_au AFTER UPDATE OF text ON log_events BEGIN
      INSERT INTO log_events_fts(log_events_fts, rowid, text) SELECT 'delete', old.seq, old.text WHERE ${indexed};
      INSERT INTO log_events_fts(rowid, text) VALUES (new.seq, new.text);
      INSERT OR IGNORE INTO fts_backfill_updates(seq) SELECT new.seq WHERE ${pending('new')};
    END;
  `);
  if (backfill) {
    db.exec(`INSERT INTO log_events_fts(log_events_fts) VALUES('rebuild');`);
  }
}

const MISSING_EVENT_KEYS = 'start_offset IS NOT NULL AND end_offset IS NOT NULL AND (start_key IS NULL OR end_key IS NULL)';

function offsetKeySql(column: string): string {
  const digits = `COALESCE(NULLIF(ltrim(${column}, '0'), ''), '0')`;
  return `printf('%010d:', length(${digits})) || ${digits}`;
}

function fillEventKeys(db: DatabaseSync, range?: { after: number; through: number }): void {
  const predicate = range ? `seq > ? AND seq <= ? AND ${MISSING_EVENT_KEYS}` : MISSING_EVENT_KEYS;
  const params = range ? [range.after, range.through] : [];
  if (!db.prepare(`SELECT 1 FROM log_events WHERE ${predicate} LIMIT 1`).get(...params)) return;
  db.prepare(`UPDATE log_events SET start_key = ${offsetKeySql('start_offset')}, end_key = ${offsetKeySql('end_offset')}
    WHERE ${predicate}`).run(...params);
}

function slimEventJson(db: DatabaseSync, range?: { after: number; through: number }): void {
  db.prepare(`
    UPDATE log_events
    SET raw_ansi = COALESCE(raw_ansi, CASE WHEN json_type(event_json, '$.rawAnsi') = 'text'
      THEN json_extract(event_json, '$.rawAnsi') END),
      event_json = json_remove(event_json, '$.text', '$.rawAnsi')
    WHERE ${range ? 'seq > ? AND seq <= ? AND' : ''}
      CASE WHEN json_valid(event_json) THEN
        json_type(event_json, '$.text') IS NOT NULL OR json_type(event_json, '$.rawAnsi') IS NOT NULL
      ELSE 0 END
  `).run(...(range ? [range.after, range.through] : []));
}

export function hasPendingMigration(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 FROM store_meta WHERE key IN (?, ?) LIMIT 1').get(FTS_CURSOR, LEGACY_CLEANUP) !== undefined;
}

/** Runs inside the caller's write transaction so cursors and FTS entries advance together. */
export function migrateLegacyBatch(db: DatabaseSync, batchSize: number): boolean {
  const progress = db.prepare(`
    SELECT CAST(fts.value AS INTEGER) AS after, CAST(boundary.value AS INTEGER) AS end
    FROM store_meta fts JOIN store_meta boundary ON boundary.key = ?
    WHERE fts.key = ?
  `).get(BACKFILL_END, FTS_CURSOR) as { after: number; end: number } | undefined;
  if (!progress) {
    if (db.prepare('SELECT 1 FROM store_meta WHERE key = ?').get(LEGACY_CLEANUP)) {
      dropLegacySchema(db);
      db.prepare('DELETE FROM store_meta WHERE key = ?').run(LEGACY_CLEANUP);
    }
    return false;
  }
  const { after, end } = progress;
  const { through } = db.prepare(`
    SELECT MAX(seq) AS through FROM (SELECT seq FROM log_events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?)
  `).get(after, end, batchSize) as { through: number | null };
  if (through !== null) {
    fillEventKeys(db, { after, through });
    slimEventJson(db, { after, through });
    db.prepare(`INSERT INTO log_events_fts(rowid, text)
      SELECT e.seq, e.text FROM log_events e WHERE e.seq > ? AND e.seq <= ?
        AND NOT EXISTS (SELECT 1 FROM fts_backfill_updates u WHERE u.seq = e.seq)`).run(after, through);
    db.prepare('DELETE FROM fts_backfill_updates WHERE seq <= ?').run(through);
    if (through < end) {
      db.prepare('UPDATE store_meta SET value = ? WHERE key IN (?, ?)').run(String(through), FTS_CURSOR, JSON_CURSOR);
      return true;
    }
  }
  db.prepare('DELETE FROM store_meta WHERE key IN (?, ?, ?)').run(FTS_CURSOR, JSON_CURSOR, BACKFILL_END);
  return true;
}

export function initializeSchema(db: DatabaseSync, migrationProgress?: () => void): void {
  db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

  const userVer = currentUserVersion(db);
  const legacyVer = legacySchemaVersion(db);
  if (userVer > STORE_SCHEMA_VERSION || (legacyVer !== null && legacyVer > STORE_SCHEMA_VERSION)) {
    throw new Error('STORE_SCHEMA_UNSUPPORTED');
  }

  const needsV2Migration = userVer < STORE_SCHEMA_VERSION;
  if (needsV2Migration) {
    db.exec('BEGIN IMMEDIATE');
  }
  try {
    ensureBaseTables(db);

    const eventColumns = new Set((db.prepare('PRAGMA table_info(log_events)').all() as { name: string }[]).map((column) => column.name));
    if (!eventColumns.has('start_key')) db.exec('ALTER TABLE log_events ADD COLUMN start_key TEXT');
    if (!eventColumns.has('end_key')) db.exec('ALTER TABLE log_events ADD COLUMN end_key TEXT');
    if (!eventColumns.has('raw_ansi')) db.exec('ALTER TABLE log_events ADD COLUMN raw_ansi TEXT');

    const evictionColumns = new Set((db.prepare('PRAGMA table_info(cache_evictions)').all() as { name: string }[]).map((column) => column.name));
    if (!evictionColumns.has('cleanup_cursor_seq')) db.exec('ALTER TABLE cache_evictions ADD COLUMN cleanup_cursor_seq INTEGER NOT NULL DEFAULT 0');
    if (!evictionColumns.has('start_key')) db.exec('ALTER TABLE cache_evictions ADD COLUMN start_key TEXT');
    if (!evictionColumns.has('end_key')) db.exec('ALTER TABLE cache_evictions ADD COLUMN end_key TEXT');
    if (!evictionColumns.has('cleanup_phase')) db.exec("ALTER TABLE cache_evictions ADD COLUMN cleanup_phase TEXT NOT NULL DEFAULT 'predecessor'");
    if (!evictionColumns.has('cleanup_group_key')) db.exec('ALTER TABLE cache_evictions ADD COLUMN cleanup_group_key TEXT');
    if (!evictionColumns.has('cleanup_cursor_start_key')) db.exec('ALTER TABLE cache_evictions ADD COLUMN cleanup_cursor_start_key TEXT');
    if (!evictionColumns.has('cleanup_cursor_event_seq')) db.exec('ALTER TABLE cache_evictions ADD COLUMN cleanup_cursor_event_seq INTEGER NOT NULL DEFAULT 0');

    let backgroundBackfill = false;
    if (needsV2Migration) {
      migrationProgress?.();
      const { count } = db.prepare(`SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM log_events INDEXED BY log_events_source_order LIMIT ?
      )`).get(LARGE_MIGRATION_ROWS + 1) as { count: number };
      backgroundBackfill = count > LARGE_MIGRATION_ROWS;
      if (backgroundBackfill) {
        // DROP INDEX walks the legacy text B-tree and can take tens of seconds on a cold disk.
        db.prepare(`
          INSERT INTO store_meta(key, value) VALUES (?, '0'), (?, '0'),
            (?, (SELECT MAX(seq) FROM log_events)), (?, '1')
        `).run(FTS_CURSOR, JSON_CURSOR, BACKFILL_END, LEGACY_CLEANUP);
      } else {
        dropLegacySchema(db);
        migrationProgress?.();
        fillEventKeys(db);
        slimEventJson(db);
      }
    }

    migrationProgress?.();
    if (!db.prepare('SELECT 1 FROM raw_support LIMIT 1').get()) {
      db.exec(`
        INSERT INTO raw_support(source_id,generation,start_offset,end_offset,start_key,end_key,ingested_at)
        SELECT r.source_id,r.generation,r.start_offset,r.end_offset,
          ${offsetKeySql('r.start_offset')},${offsetKeySql('r.end_offset')},r.ingested_at
        FROM raw_chunks r
      `);
    }

    db.exec(`
      INSERT INTO raw_usage(owner_type,owner_id,raw_bytes)
        SELECT 'global','*',(SELECT COALESCE(SUM(length(bytes)),0) FROM raw_chunks)
        WHERE NOT EXISTS (SELECT 1 FROM raw_usage WHERE owner_type='global' AND owner_id='*');
      INSERT INTO raw_usage(owner_type,owner_id,raw_bytes)
        SELECT 'task',s.task_id,SUM(length(r.bytes))
        FROM source_registry s CROSS JOIN raw_chunks r ON r.source_id=s.source_id
        WHERE NOT EXISTS (SELECT 1 FROM raw_usage u WHERE u.owner_type='task' AND u.owner_id=s.task_id)
        GROUP BY s.task_id;

      UPDATE cache_evictions SET
        start_key = printf('%010d:', length(CASE WHEN ltrim(start_offset,'0')='' THEN '0' ELSE ltrim(start_offset,'0') END)) || CASE WHEN ltrim(start_offset,'0')='' THEN '0' ELSE ltrim(start_offset,'0') END,
        end_key = printf('%010d:', length(CASE WHEN ltrim(end_offset,'0')='' THEN '0' ELSE ltrim(end_offset,'0') END)) || CASE WHEN ltrim(end_offset,'0')='' THEN '0' ELSE ltrim(end_offset,'0') END
      WHERE start_key IS NULL OR end_key IS NULL;

      CREATE INDEX IF NOT EXISTS log_events_range ON log_events(source_id,generation,start_key,end_key,seq);
      CREATE INDEX IF NOT EXISTS log_events_start_seq ON log_events(source_id,generation,start_key,seq);
      CREATE INDEX IF NOT EXISTS log_events_text_start_seq ON log_events(source_id,generation,start_key,seq) WHERE text IS NOT NULL;
      CREATE INDEX IF NOT EXISTS cache_evictions_cleanup ON cache_evictions(source_id,generation,cleanup_cursor_seq,eviction_id);
    `);

    migrationProgress?.();
    ensureFts5(db, needsV2Migration && !backgroundBackfill);

    db.exec(`
      DELETE FROM schema_version;
      INSERT INTO schema_version(version) VALUES (${STORE_SCHEMA_VERSION});
      PRAGMA user_version = ${STORE_SCHEMA_VERSION};
    `);

    if (needsV2Migration) {
      db.exec('COMMIT');
    }
  } catch (error) {
    if (needsV2Migration) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    }
    throw error;
  }
}
