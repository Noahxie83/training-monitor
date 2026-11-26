import type { DatabaseSync } from 'node:sqlite';

export const STORE_SCHEMA_VERSION = 2;

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
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS log_events_fts USING fts5(
      text,
      content='log_events',
      content_rowid='seq',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS log_events_ai AFTER INSERT ON log_events WHEN new.text IS NOT NULL BEGIN
      INSERT INTO log_events_fts(rowid, text) VALUES (new.seq, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS log_events_ad AFTER DELETE ON log_events WHEN old.text IS NOT NULL BEGIN
      INSERT INTO log_events_fts(log_events_fts, rowid, text) VALUES('delete', old.seq, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS log_events_au AFTER UPDATE OF text ON log_events BEGIN
      INSERT INTO log_events_fts(log_events_fts, rowid, text)
        SELECT 'delete', old.seq, old.text WHERE old.text IS NOT NULL;
      INSERT INTO log_events_fts(rowid, text)
        SELECT new.seq, new.text WHERE new.text IS NOT NULL;
    END;
  `);
  if (backfill) {
    db.exec(`INSERT INTO log_events_fts(log_events_fts) VALUES('rebuild');`);
  }
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL;');

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

    if (needsV2Migration) {
      // Drop dead v1 tables and the wasteful full-text B-tree index
      db.exec(`
        DROP INDEX IF EXISTS log_events_text;
        DROP TABLE IF EXISTS run_bindings;
        DROP TABLE IF EXISTS task_projection;
        DROP TABLE IF EXISTS checkpoint_samples;
      `);

      // Strip duplicated text field out of legacy event_json rows to eliminate write amplification
      const legacyRows = db.prepare('SELECT seq, event_json FROM log_events').all() as { seq: number; event_json: string }[];
      const updateStmt = db.prepare('UPDATE log_events SET event_json = ? WHERE seq = ?');
      for (const row of legacyRows) {
        try {
          const parsed = JSON.parse(row.event_json) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && ('text' in parsed || 'rawAnsi' in parsed)) {
            delete parsed.text;
            delete parsed.rawAnsi;
            updateStmt.run(JSON.stringify(parsed), row.seq);
          }
        } catch {
          // Leave malformed legacy JSON untouched
        }
      }
    }

    db.exec(`
      INSERT INTO raw_support(source_id,generation,start_offset,end_offset,start_key,end_key,ingested_at)
      SELECT r.source_id,r.generation,r.start_offset,r.end_offset,
        printf('%010d:',length(CASE WHEN ltrim(r.start_offset,'0')='' THEN '0' ELSE ltrim(r.start_offset,'0') END)) || CASE WHEN ltrim(r.start_offset,'0')='' THEN '0' ELSE ltrim(r.start_offset,'0') END,
        printf('%010d:',length(CASE WHEN ltrim(r.end_offset,'0')='' THEN '0' ELSE ltrim(r.end_offset,'0') END)) || CASE WHEN ltrim(r.end_offset,'0')='' THEN '0' ELSE ltrim(r.end_offset,'0') END,r.ingested_at
      FROM raw_chunks r WHERE NOT EXISTS (SELECT 1 FROM raw_support);

      INSERT INTO raw_usage(owner_type,owner_id,raw_bytes)
        SELECT 'global','*',(SELECT COALESCE(SUM(length(bytes)),0) FROM raw_chunks)
        WHERE NOT EXISTS (SELECT 1 FROM raw_usage WHERE owner_type='global' AND owner_id='*');
      INSERT INTO raw_usage(owner_type,owner_id,raw_bytes)
        SELECT 'task',usage.task_id,usage.raw_bytes FROM (
          SELECT s.task_id,COALESCE(SUM(length(r.bytes)),0) AS raw_bytes FROM raw_chunks r JOIN source_registry s ON s.source_id=r.source_id GROUP BY s.task_id
        ) usage WHERE NOT EXISTS (SELECT 1 FROM raw_usage u WHERE u.owner_type='task' AND u.owner_id=usage.task_id);

      UPDATE log_events SET
        start_key = printf('%010d:', length(CASE WHEN ltrim(start_offset,'0')='' THEN '0' ELSE ltrim(start_offset,'0') END)) || CASE WHEN ltrim(start_offset,'0')='' THEN '0' ELSE ltrim(start_offset,'0') END,
        end_key = printf('%010d:', length(CASE WHEN ltrim(end_offset,'0')='' THEN '0' ELSE ltrim(end_offset,'0') END)) || CASE WHEN ltrim(end_offset,'0')='' THEN '0' ELSE ltrim(end_offset,'0') END
      WHERE start_offset IS NOT NULL AND end_offset IS NOT NULL AND (start_key IS NULL OR end_key IS NULL);

      UPDATE cache_evictions SET
        start_key = printf('%010d:', length(CASE WHEN ltrim(start_offset,'0')='' THEN '0' ELSE ltrim(start_offset,'0') END)) || CASE WHEN ltrim(start_offset,'0')='' THEN '0' ELSE ltrim(start_offset,'0') END,
        end_key = printf('%010d:', length(CASE WHEN ltrim(end_offset,'0')='' THEN '0' ELSE ltrim(end_offset,'0') END)) || CASE WHEN ltrim(end_offset,'0')='' THEN '0' ELSE ltrim(end_offset,'0') END
      WHERE start_key IS NULL OR end_key IS NULL;

      CREATE INDEX IF NOT EXISTS log_events_range ON log_events(source_id,generation,start_key,end_key,seq);
      CREATE INDEX IF NOT EXISTS log_events_start_seq ON log_events(source_id,generation,start_key,seq);
      CREATE INDEX IF NOT EXISTS log_events_text_start_seq ON log_events(source_id,generation,start_key,seq) WHERE text IS NOT NULL;
      CREATE INDEX IF NOT EXISTS cache_evictions_cleanup ON cache_evictions(source_id,generation,cleanup_cursor_seq,eviction_id);
    `);

    ensureFts5(db, needsV2Migration);

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
