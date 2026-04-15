// Built-in SQLite (Node.js 22.5+). Run with --experimental-sqlite flag.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, '..', 'bot.db'));

db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER  NOT NULL,
    category       TEXT     NOT NULL DEFAULT '',
    text           TEXT     NOT NULL,
    media_file_id  TEXT,
    media_type     TEXT,
    status         TEXT     NOT NULL DEFAULT 'pending',
    reject_reason  TEXT,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    mod_message_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS users (
    user_id                INTEGER  PRIMARY KEY,
    submissions_count_hour INTEGER  NOT NULL DEFAULT 0,
    hour_reset_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_banned              INTEGER  NOT NULL DEFAULT 0,
    ban_reason             TEXT,
    created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stats (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    total_submitted INTEGER NOT NULL DEFAULT 0,
    total_approved  INTEGER NOT NULL DEFAULT 0,
    total_rejected  INTEGER NOT NULL DEFAULT 0,
    total_postponed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    key  TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
`);

db.exec('INSERT OR IGNORE INTO stats (id) VALUES (1)');

// ─── Session storage adapter (SQLite-backed, survives restarts) ─────────────

const _sessionRead   = db.prepare('SELECT data FROM sessions WHERE key = ?');
const _sessionWrite  = db.prepare('INSERT OR REPLACE INTO sessions (key, data) VALUES (?, ?)');
const _sessionDelete = db.prepare('DELETE FROM sessions WHERE key = ?');

const sessionStorage = {
  read:   (key) => { const row = _sessionRead.get(key); return row ? JSON.parse(row.data) : undefined; },
  write:  (key, value) => _sessionWrite.run(key, JSON.stringify(value)),
  delete: (key) => _sessionDelete.run(key),
};

module.exports = {
  sessionStorage,

  // ─── Users ────────────────────────────────────────────────────────────────
  getUser:         db.prepare('SELECT * FROM users WHERE user_id = ?'),
  createUser:      db.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)'),
  resetUserHour:   db.prepare('UPDATE users SET submissions_count_hour = 0, hour_reset_at = ? WHERE user_id = ?'),
  incrementCount:  db.prepare('UPDATE users SET submissions_count_hour = submissions_count_hour + 1 WHERE user_id = ?'),
  banUser:         db.prepare('UPDATE users SET is_banned = 1, ban_reason = ? WHERE user_id = ?'),
  unbanUser:       db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE user_id = ?'),
  getBannedUsers:  db.prepare('SELECT user_id, ban_reason FROM users WHERE is_banned = 1'),
  getBannedCount:  db.prepare('SELECT COUNT(*) AS cnt FROM users WHERE is_banned = 1'),

  // ─── Submissions ──────────────────────────────────────────────────────────
  createSubmission: db.prepare(
    "INSERT INTO submissions (user_id, category, text, media_file_id, media_type) VALUES (?, '', ?, ?, ?)"
  ),
  getSubmission:    db.prepare('SELECT * FROM submissions WHERE id = ?'),
  updateStatus:     db.prepare('UPDATE submissions SET status = ?, reject_reason = ? WHERE id = ?'),
  setModMsgId:      db.prepare('UPDATE submissions SET mod_message_id = ? WHERE id = ?'),
  getUserStats:     db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'approved'  THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'rejected'  THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'postponed' THEN 1 ELSE 0 END) AS postponed
    FROM submissions WHERE user_id = ?
  `),
  findDuplicateSubmission: db.prepare(
    "SELECT id FROM submissions WHERE user_id = ? AND text = ? AND created_at > datetime('now', '-1 hour') LIMIT 1"
  ),

  // ─── Stats ────────────────────────────────────────────────────────────────
  getStats:     db.prepare('SELECT * FROM stats WHERE id = 1'),
  incSubmitted: db.prepare('UPDATE stats SET total_submitted  = total_submitted  + 1 WHERE id = 1'),
  incApproved:  db.prepare('UPDATE stats SET total_approved   = total_approved   + 1 WHERE id = 1'),
  incRejected:  db.prepare('UPDATE stats SET total_rejected   = total_rejected   + 1 WHERE id = 1'),
  incPostponed: db.prepare('UPDATE stats SET total_postponed  = total_postponed  + 1 WHERE id = 1'),

  // ─── Session maintenance ──────────────────────────────────────────────────
  // Удаляет «пустые» сессии (пользователь не в середине флоу)
  cleanIdleSessions: db.prepare(`
    DELETE FROM sessions
    WHERE json_extract(data, '$.step')              IS NULL
      AND json_extract(data, '$.awaitingRejectFor') IS NULL
      AND json_extract(data, '$.awaitingBanFor')    IS NULL
  `),
};
