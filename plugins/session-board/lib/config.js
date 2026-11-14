'use strict';
// User settings, kept in the board's database (lib/db.js, table `settings`).
//
// Every setting has a default, and a stored value of the wrong type or a
// folder that no longer exists is ignored rather than trusted. Settings are
// read again on each use, so a change takes effect without restarting the board.
//
//   pickerStartDir  the folder the "choose a folder" window opens in when
//                   starting a new conversation. Default: none (Windows then
//                   opens wherever that window was last used).
//   autoRestore     true: when the board starts, the terminal sessions that
//                   were open when it last stopped are opened again without
//                   asking. Default false: they are listed on the first page
//                   and you choose.
//
// Before the database there was ~/.claude/session-board/config.json. The first
// time the database is used, that file's contents are copied in (every key,
// known or not) and the file is renamed to config.json.imported.
const fs = require('fs');
const path = require('path');
const DB = require('./db');

const LEGACY_FILE = path.join(path.dirname(DB.DB_FILE), 'config.json');
//   autoContinue    true (default): a restored session that was cut off in the middle of a turn is told to
//                   pick the work up again, instead of just being opened.
const DEFAULTS = { pickerStartDir: '', autoRestore: false, autoContinue: true };

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

function store(file, legacy) {
  const db = DB.open(file);
  DB.importOnce(db, 'config.json', () => {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(legacy, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return;
    const put = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
    for (const [k, v] of Object.entries(j)) put.run(k, JSON.stringify(v), Date.now());
    try { fs.renameSync(legacy, legacy + '.imported'); } catch (e) {}
  });
  return db;
}

// Everything stored, as it is: {key: value}.
function raw(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) { try { out[r.key] = JSON.parse(r.value); } catch (e) {} }
  return out;
}

function load(file = DB.DB_FILE, legacy = LEGACY_FILE) {
  const out = Object.assign({}, DEFAULTS);
  let j;
  try { j = raw(store(file, legacy)); } catch (e) { return out; }
  if (typeof j.pickerStartDir === 'string' && path.isAbsolute(j.pickerStartDir) && isDir(j.pickerStartDir)) out.pickerStartDir = path.normalize(j.pickerStartDir);
  if (j.autoRestore === true) out.autoRestore = true;
  if (j.autoContinue === false) out.autoContinue = false;
  return out;
}

// Saves settings chosen in the page. Returns {ok, config} or {ok:false, error}.
// Unlike load(), a bad value is refused with a reason here: the person is
// looking at the form and should be told, not silently ignored.
// Only the keys in the patch are touched; anything else stored stays as it is.
function save(patch, file = DB.DB_FILE, legacy = LEGACY_FILE) {
  const set = {}, clear = [];
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'pickerStartDir')) {
    const v = patch.pickerStartDir;
    if (typeof v !== 'string') return { ok: false, error: '資料夾路徑必須是文字' };
    const p = v.trim().replace(/^["']+|["']+$/g, '');
    if (!p) clear.push('pickerStartDir');   // cleared: back to "let Windows decide"
    else if (!path.isAbsolute(p)) return { ok: false, error: '請填完整路徑，例如 C:\\Users\\你\\Projects' };
    else if (!isDir(p)) return { ok: false, error: '找不到這個資料夾：' + p };
    else set.pickerStartDir = path.normalize(p);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoContinue')) {
    if (typeof patch.autoContinue !== 'boolean') return { ok: false, error: '自動接續只能是開或關' };
    if (patch.autoContinue) clear.push('autoContinue'); else set.autoContinue = false;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoRestore')) {
    if (typeof patch.autoRestore !== 'boolean') return { ok: false, error: '自動還原只能是開或關' };
    if (patch.autoRestore) set.autoRestore = true; else clear.push('autoRestore');
  }
  try {
    const db = store(file, legacy);
    const put = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    for (const [k, v] of Object.entries(set)) put.run(k, JSON.stringify(v), Date.now());
    for (const k of clear) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
  } catch (e) { return { ok: false, error: '設定存不進資料庫：' + String(e.message || e).slice(0, 120) }; }
  return { ok: true, config: load(file, legacy) };
}

// Other things the board remembers that are not settings on the settings page
// (the list of hidden sessions, for one): any JSON value under a key.
function value(key, fallback, file = DB.DB_FILE, legacy = LEGACY_FILE) {
  try { const r = store(file, legacy).prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? JSON.parse(r.value) : fallback; } catch (e) { return fallback; }
}
function setValue(key, v, file = DB.DB_FILE, legacy = LEGACY_FILE) {
  try {
    store(file, legacy).prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(v), Date.now());
    return true;
  } catch (e) { return false; }
}

// What is stored, including keys this version does not know. For tests and for looking.
function stored(file = DB.DB_FILE, legacy = LEGACY_FILE) { try { return raw(store(file, legacy)); } catch (e) { return {}; } }

module.exports = { load, save, stored, value, setValue, CONFIG_FILE: DB.DB_FILE, LEGACY_FILE, DEFAULTS };
