import Database from 'better-sqlite3';
import path from 'node:path';

const DB_PATH = process.env.BRIDGE_DB_PATH || '/app/data/bridge.sqlite';
let db = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS message_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    sender TEXT,
    recipient TEXT,
    group_id TEXT,
    message TEXT NOT NULL,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
`;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);

    const defaults = {
      enabled: 'true',
      signal_api_url: process.env.SIGNAL_API_URL || 'http://signal-cli:8080',
      signal_sender: process.env.SIGNAL_SENDER || '',
      allowed_numbers: process.env.ALLOWED_NUMBERS || '',
      allowed_groups: process.env.ALLOWED_GROUPS || '',
      pty_host_url: process.env.PTY_HOST_URL || 'http://host.docker.internal:3101',
      poll_interval_ms: process.env.POLL_INTERVAL_MS || '2500',
      project_dir: process.env.PROJECT_DIR || '',
      groups_enabled: 'true',
      group_prefix: process.env.GROUP_PREFIX || 'chad',
      approval_numbers: process.env.ALLOWED_NUMBERS || '',
    };

    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(defaults)) insert.run(k, v);
  }
  return db;
}

export function getSetting(key) {
  return (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key))?.value || '';
}

export function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

export function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

export function logMessage(direction, sender, recipient, groupId, message) {
  getDb().prepare(
    'INSERT INTO message_log (direction, sender, recipient, group_id, message, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(direction, sender, recipient, groupId, message, Date.now());
}

export function getMessageLog(limit = 50) {
  return getDb().prepare('SELECT * FROM message_log ORDER BY timestamp DESC LIMIT ?').all(limit);
}
