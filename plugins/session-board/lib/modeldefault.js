'use strict';
// The model and effort new conversations start on: Claude Code's own default, in ~/.claude/settings.json, so a
// conversation opened in a terminal starts on it too (asked 2026-11-26: changing a conversation's model on the board
// should change the default as well, or ask - asked each time, kept in Claude Code's settings).
//
// Where the effort goes: under modelSettings.<model>.effortLevel. Claude Code 2.1.332 takes the top-level effortLevel
// of the user's settings only for a fixed list of older models (claude-opus-4-7 … claude-fable-5-1 - read from the
// installed program); measured 2026-11-26 with "effortLevel": "high" there: Opus 5.5 and Sonnet 5.5 ran on medium,
// while modelSettings.opus (or .claude-opus-5-5) high gave high. A model's key may be its alias ("opus") or its full
// id; Claude Code resolves both to the same model and the full id wins when both are there - so a full id already
// there for the model being set is updated along with the alias.
//
// Only "model" and that one effortLevel are changed; everything else in the file is kept as it was read (parsed and
// written back as JSON, two spaces - the way Claude Code itself writes it). A copy of the file as it was is kept first
// (~/.claude/session-board/backups/settings-<time>.json, the newest ten). A file that cannot be read as JSON is left
// alone: nothing is written over it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KEEP = 10;

const fileOf = (home) => path.join(home || os.homedir(), '.claude', 'settings.json');
const familyOf = (m) => (/(fable|opus|sonnet|haiku)/i.exec(String(m || '')) || [])[1] ? /(fable|opus|sonnet|haiku)/i.exec(String(m))[1].toLowerCase() : '';

function read(home) {
  const f = fileOf(home);
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { ok: true, file: f, json: {}, missing: true }; return { ok: false, file: f, error: '讀不到 Claude Code 的設定檔：' + e.message }; }
  try { const j = JSON.parse(text.replace(/^﻿/, '')); if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object'); return { ok: true, file: f, json: j }; }
  catch (e) { return { ok: false, file: f, error: 'Claude Code 的設定檔不是正確的 JSON，沒有改它（' + f + '）' }; }
}

// The keys under modelSettings that are this model: its alias, and a full id of the same family already there that is
// the one the conversation runs on (seen) - not every id of the family (claude-opus-4-7 is another model).
function keysFor(ms, alias, seen) {
  const keys = [alias];
  const s = String(seen || '').toLowerCase();
  if (s && familyOf(s) === alias && ms && Object.prototype.hasOwnProperty.call(ms, s) && s !== alias) keys.push(s);
  return keys;
}

// -> {ok, model, effort, file}   effort: what modelSettings says for the default model ('' = not set: the model's own)
function get(o = {}) {
  const r = read(o.home);
  if (!r.ok) return { ok: false, error: r.error, file: r.file };
  const j = r.json, model = typeof j.model === 'string' ? j.model : '';
  const alias = familyOf(model);
  const ms = j.modelSettings && typeof j.modelSettings === 'object' ? j.modelSettings : {};
  let effort = '';
  if (alias) for (const k of keysFor(ms, alias, o.seen).reverse()) { const v = ms[k] && ms[k].effortLevel; if (EFFORTS.includes(v)) { effort = v; break; } }
  return { ok: true, model, alias, effort, file: r.file };
}

// {model?, effort?, seen?, home?, now?} -> {ok, model, effort, backup, file}   model: an alias; effort for that model
// (or, with no model given, for the model that is the default now).
function set(o = {}) {
  if (o.model !== undefined && !ALIASES.includes(o.model)) return { ok: false, error: '模型只能是 ' + ALIASES.join('、') };
  if (o.effort !== undefined && !EFFORTS.includes(o.effort)) return { ok: false, error: 'effort 只能是 ' + EFFORTS.join('、') };
  if (o.model === undefined && o.effort === undefined) return { ok: false, error: '沒有要改的' };
  const r = read(o.home);
  if (!r.ok) return { ok: false, error: r.error, file: r.file };
  const j = r.json;
  const alias = o.model || familyOf(j.model);
  if (o.effort !== undefined && !alias) return { ok: false, error: '現在的預設模型看不出是哪一個，effort 沒有地方放；請一起選模型' };
  // the file as it was, first
  let backup = '';
  if (!r.missing) {
    const dir = path.join(path.dirname(r.file), 'session-board', 'backups');
    try {
      fs.mkdirSync(dir, { recursive: true });
      backup = path.join(dir, 'settings-' + new Date(o.now || Date.now()).toISOString().replace(/[:.]/g, '-') + '.json');
      fs.copyFileSync(r.file, backup);
      const old = fs.readdirSync(dir).filter((n) => /^settings-.*\.json$/.test(n)).sort();
      for (const n of old.slice(0, Math.max(0, old.length - KEEP))) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) {} }
    } catch (e) { return { ok: false, error: '沒辦法先備份設定檔，所以沒有改：' + e.message, file: r.file }; }
  }
  // the same model as now: what is written stays ("opus[1m]", "claude-opus-4-7", "opusplan" are opus too - turning them
  // into "opus" would lose the 1M window or the version kept on purpose: review 2026-11-26)
  if (o.model !== undefined && familyOf(j.model) !== o.model) j.model = o.model;
  if (o.effort !== undefined) {
    if (!j.modelSettings || typeof j.modelSettings !== 'object' || Array.isArray(j.modelSettings)) j.modelSettings = {};
    for (const k of keysFor(j.modelSettings, alias, o.seen)) {
      const cur = j.modelSettings[k] && typeof j.modelSettings[k] === 'object' ? j.modelSettings[k] : {};
      j.modelSettings[k] = Object.assign({}, cur, { effortLevel: o.effort });
    }
  }
  // written where the file really is: a settings.json that is a link (dotfiles) stays a link
  let real = r.file; try { real = fs.realpathSync(r.file); } catch (e) {}
  const tmp = real + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
    fs.renameSync(tmp, real);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} return { ok: false, error: '寫不進設定檔：' + e.message, file: r.file, backup }; }
  const now = get({ home: o.home, seen: o.seen });
  return { ok: true, model: now.model, effort: now.effort, backup, file: r.file };
}

module.exports = { get, set, familyOf, ALIASES, EFFORTS };
