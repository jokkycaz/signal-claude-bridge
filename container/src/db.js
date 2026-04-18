import Database from 'better-sqlite3';
import fs from 'node:fs';

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
    profile_id TEXT,
    message TEXT NOT NULL,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    project_dir TEXT NOT NULL DEFAULT '',
    host_port INTEGER NOT NULL DEFAULT 3101,
    allowed_numbers TEXT NOT NULL DEFAULT '',
    allowed_groups TEXT NOT NULL DEFAULT '',
    approval_numbers TEXT NOT NULL DEFAULT '',
    dm_enabled INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE TABLE IF NOT EXISTS group_names (
    group_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
`;

function migrateToProfiles(database) {
  // Check if profiles table has any rows — if not, migrate from global settings
  const count = database.prepare('SELECT COUNT(*) as c FROM profiles').get().c;
  if (count > 0) return;

  // Read current global settings to create a default profile
  const get = (key) => (database.prepare('SELECT value FROM settings WHERE key = ?').get(key))?.value || '';

  const prefix = get('group_prefix') || process.env.GROUP_PREFIX || 'chad';
  const projectDir = get('project_dir') || process.env.PROJECT_DIR || '';
  const allowedNumbers = get('allowed_numbers') || process.env.ALLOWED_NUMBERS || '';
  const allowedGroups = get('allowed_groups') || process.env.ALLOWED_GROUPS || '';
  const approvalNumbers = get('approval_numbers') || allowedNumbers;
  const ptyHostUrl = get('pty_host_url') || process.env.PTY_HOST_URL || 'http://host.docker.internal:3101';

  // Extract port from pty_host_url
  let port = 3101;
  try { port = parseInt(new URL(ptyHostUrl).port) || 3101; } catch {}

  database.prepare(`
    INSERT INTO profiles (id, name, prefix, project_dir, host_port, allowed_numbers, allowed_groups, approval_numbers, dm_enabled, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `).run(prefix, prefix, prefix, projectDir, port, allowedNumbers, allowedGroups, approvalNumbers);

  console.log(`[DB] Migrated global settings to profile "${prefix}" (port ${port})`);
}

function addProfileIdColumn(database) {
  // Add profile_id column to message_log if it doesn't exist
  const cols = database.prepare("PRAGMA table_info(message_log)").all();
  if (!cols.some(c => c.name === 'profile_id')) {
    database.exec('ALTER TABLE message_log ADD COLUMN profile_id TEXT');
    console.log('[DB] Added profile_id column to message_log');
  }
}

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);

    addProfileIdColumn(db);

    const defaults = {
      enabled: 'true',
      signal_api_url: process.env.SIGNAL_API_URL || 'http://signal-cli:8080',
      signal_sender: process.env.SIGNAL_SENDER || '',
      poll_interval_ms: process.env.POLL_INTERVAL_MS || '2500',
      groups_enabled: 'true',
      bridge_secret: process.env.BRIDGE_SECRET || '',
    };

    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(defaults)) insert.run(k, v);

    migrateToProfiles(db);
  }
  return db;
}

// --- Global settings ---

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

// --- Profiles ---

export function getProfiles() {
  return getDb().prepare('SELECT * FROM profiles ORDER BY created_at').all();
}

export function getProfile(id) {
  return getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
}

export function createProfile({ id, name, prefix, project_dir, host_port, allowed_numbers, allowed_groups, approval_numbers, dm_enabled }) {
  getDb().prepare(`
    INSERT INTO profiles (id, name, prefix, project_dir, host_port, allowed_numbers, allowed_groups, approval_numbers, dm_enabled, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, name, prefix, project_dir || '', host_port || 3101, allowed_numbers || '', allowed_groups || '', approval_numbers || '', dm_enabled ? 1 : 0);
  syncProfilesJson();
  return getProfile(id);
}

export function updateProfile(id, data) {
  const profile = getProfile(id);
  if (!profile) return null;

  const fields = ['name', 'prefix', 'project_dir', 'host_port', 'allowed_numbers', 'allowed_groups', 'approval_numbers', 'dm_enabled', 'enabled'];
  for (const field of fields) {
    if (data[field] !== undefined) {
      const value = (field === 'dm_enabled' || field === 'enabled') ? (data[field] ? 1 : 0) : data[field];
      getDb().prepare(`UPDATE profiles SET ${field} = ? WHERE id = ?`).run(value, id);
    }
  }
  syncProfilesJson();
  return getProfile(id);
}

export function deleteProfile(id) {
  getDb().prepare('DELETE FROM profiles WHERE id = ?').run(id);
  syncProfilesJson();
}

// --- Group names ---

export function upsertGroupName(groupId, name) {
  getDb().prepare(`
    INSERT INTO group_names (group_id, name, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET name = ?, updated_at = ?
  `).run(groupId, name, Date.now(), name, Date.now());
}

export function getGroupNames() {
  const rows = getDb().prepare('SELECT group_id, name FROM group_names').all();
  const map = {};
  for (const r of rows) map[r.group_id] = r.name;
  return map;
}

// --- Message log ---

export function logMessage(direction, sender, recipient, groupId, message, profileId) {
  getDb().prepare(
    'INSERT INTO message_log (direction, sender, recipient, group_id, profile_id, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(direction, sender, recipient, groupId, profileId || null, message, Date.now());
}

export function getMessageLog(limit = 50) {
  return getDb().prepare('SELECT * FROM message_log ORDER BY timestamp DESC LIMIT ?').all(limit);
}

// --- Sync profiles.json for host launcher ---

function syncProfilesJson() {
  try {
    const profiles = getProfiles().filter(p => p.enabled);
    const data = profiles.map(p => ({
      id: p.id,
      name: p.name,
      prefix: p.prefix,
      port: p.host_port,
      projectDir: p.project_dir,
    }));
    fs.writeFileSync('/app/data/profiles.json', JSON.stringify(data, null, 2));
    console.log(`[DB] Synced profiles.json (${data.length} profiles)`);
  } catch (err) {
    console.error(`[DB] Failed to sync profiles.json: ${err.message}`);
  }
}
