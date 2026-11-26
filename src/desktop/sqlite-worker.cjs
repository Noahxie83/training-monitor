const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(workerData.databasePath);
  db.exec('CREATE TABLE IF NOT EXISTS runtime_canary (id INTEGER PRIMARY KEY, byte_count TEXT NOT NULL)');
  if (workerData.mode === 'write') db.prepare('INSERT OR REPLACE INTO runtime_canary (id, byte_count) VALUES (1, ?)').run('9007199254740993');
  const value = db.prepare('SELECT byte_count FROM runtime_canary WHERE id = 1').get()?.byte_count ?? null;
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  db.close();
  parentPort.postMessage({ ok: true, value, sqliteVersion });
  parentPort.close();
} catch (error) {
  parentPort.postMessage({ ok: false, message: String(error?.stack ?? error) });
  parentPort.close();
}
