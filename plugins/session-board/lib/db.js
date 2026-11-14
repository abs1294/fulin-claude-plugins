'use strict';
// The board's database: one SQLite file, ~/.claude/session-board/board.db.
//
//   settings      key -> value (JSON)          what the settings page saves
//   usage_month   month -> figures (JSON)      a finished month's usage, kept for good
//
// Why there and not in the plugin's own folder: an installed plugin lives in
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, a new folder for
// every version (checked 2026-11-13: cc-statusline has seven of them side by
// side). A database in the plugin folder would start empty after each update.
// And when the plugin is run from its git repository, the file would sit among
// the sources and get committed.
//
// SQLite is the one built into Node (node:sqlite, Node 22.5 or newer); the
// plugin has no packages to install. Node still calls it experimental and
// prints a warning when it is loaded, which is silenced here.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_FILE = path.join(os.homedir(), '.claude', 'session-board', 'board.db');

let Sqlite = null;
function engine() {
  if (Sqlite) return Sqlite;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => { if (!/SQLite is an experimental feature/.test(String(w && w.message || w))) emit.call(process, w, ...rest); };
  try { Sqlite = require('node:sqlite').DatabaseSync; } finally { process.emitWarning = emit; }
  return Sqlite;
}

const opened = new Map();   // file -> database

function open(file = DB_FILE) {
  const key = path.resolve(file);
  if (opened.has(key)) return opened.get(key);
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const db = new (engine())(key);
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS usage_month (month TEXT PRIMARY KEY, computed_at INTEGER NOT NULL, cost REAL NOT NULL, tokens INTEGER NOT NULL, data TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS imported (what TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  opened.set(key, db);
  return db;
}

function close(file = DB_FILE) {
  const key = path.resolve(file);
  const db = opened.get(key);
  if (db) { try { db.close(); } catch (e) {} opened.delete(key); }
}

// Files from before the database existed are read in once; `what` names the batch.
function importOnce(db, what, fn) {
  if (db.prepare('SELECT 1 AS x FROM imported WHERE what = ?').get(what)) return false;
  fn();
  db.prepare('INSERT OR REPLACE INTO imported (what, at) VALUES (?, ?)').run(what, Date.now());
  return true;
}

module.exports = { open, close, importOnce, DB_FILE };
