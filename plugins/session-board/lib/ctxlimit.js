'use strict';
// How much context a conversation really has: not the model's own size where autoCompactWindow says less (2026-11-23: a
// folder set to 500,000 was shown as 27% of a million). Claude Code's rule, read in its program and measured: the window is
// the smaller of the model's and the one set. Where it is set: CLAUDE_CODE_AUTO_COMPACT_WINDOW (in a settings file's env),
// else autoCompactWindow - in a file, the model's own (modelSettings) before the file's - the nearer file first.
// Read from the files, not asked of Claude Code (its word would be exact, but it hardly ever changes - 2026-11-23: 為什麼不
// 去讀設定檔); a file is read again only when it changed. 'auto', or nothing set, says nothing here.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN = 100000;
// 500000, "500000", "500k", "1m" -> tokens; anything else 0
function size(v) {
  const m = /^\s*([\d,_]+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(String(v == null ? '' : v)); if (!m) return 0;
  const n = Number(m[1].replace(/[,_]/g, '')) * (/k/i.test(m[2]) ? 1000 : /m/i.test(m[2]) ? 1000000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.max(MIN, Math.round(n)) : 0;
}
// the name a model goes by in the settings: not its date, not [1m]
const plain = (model) => String(model || '').replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '').toLowerCase();

const cache = new Map();   // file -> {key: size and time, j}
function read(file) {
  let key = ''; try { const st = fs.statSync(file); key = st.size + ':' + st.mtimeMs; } catch (e) { return null; }
  const c = cache.get(file); if (c && c.key === key) return c.j;
  let j = null; try { j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = null;
  cache.set(file, { key, j }); if (cache.size > 300) cache.delete(cache.keys().next().value);
  return j;
}
function managedFile(platform = process.platform) {
  return platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json' : platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
}
// -> tokens set for this model in this folder, or 0 (nothing set, or 'auto')
function limitFor(cwd, model, o = {}) {
  const home = o.home || os.homedir(), want = plain(model);
  const files = [o.managed || managedFile(), ...(cwd ? [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json')] : []), path.join(home, '.claude', 'settings.json')].map(read);
  for (const j of files) { const v = j && j.env && typeof j.env === 'object' ? size(j.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) : 0; if (v) return v; }
  for (const j of files) {
    if (!j) continue;
    const per = j.modelSettings && typeof j.modelSettings === 'object' ? Object.entries(j.modelSettings).find(([k, v]) => plain(k) === want && v && typeof v === 'object' && v.autoCompactWindow !== undefined) : null;
    const v = per ? per[1].autoCompactWindow : j.autoCompactWindow;
    if (v !== undefined && v !== null) return String(v).toLowerCase() === 'auto' ? 0 : size(v);
  }
  return 0;
}

module.exports = { limitFor, size, plain };
