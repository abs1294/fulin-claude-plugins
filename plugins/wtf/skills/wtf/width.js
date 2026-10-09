#!/usr/bin/env node
'use strict';
/**
 * width.js — wtf 終端機寬度設定的唯一讀寫入口
 *
 * 為什麼存使用者層、不跟 plugin 走（0.18.0 起）：
 * 0.17.x 以前存在 skills/wtf/config.json，但 Claude Code 的 plugin cache 按版本號分資料夾，
 * 每次升版新資料夾裡的設定都是空的 → 使用者每升一次版就被重問一次寬度。
 * 寬度是「這台機器、這個人的視窗」的屬性，不是 plugin 版本的屬性，所以改存：
 *   ~/.claude/wtf/config.json
 * （測試可用環境變數 WTF_CONFIG 指到別的檔，避免動到真實設定）
 *
 * 搬遷：使用者層檔案不存在時，掃 ~/.claude/plugins/cache/<marketplace>/wtf/<版本>/skills/wtf/config.json，
 * 取版本最高、且 terminalWidth 有數字的那份搬過來——舊版問過的值不必再問一次。
 *
 * 用法（hook 與模型都走這支，模型不要自己 cat / 改 JSON）：
 *   node width.js get            印出目前設定（JSON）
 *   node width.js set <寬度>     寫入寬度（20~400 的整數）
 *   node width.js decline        記下「使用者明確說不要再問寬度」
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_WIDTH = 20;
const MAX_WIDTH = 400;

function configPath() {
  const env = process.env.WTF_CONFIG;
  if (typeof env === 'string' && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.claude', 'wtf', 'config.json');
}

function validWidth(w) {
  return typeof w === 'number' && Number.isInteger(w) && w >= MIN_WIDTH && w <= MAX_WIDTH;
}

// 舊版（0.17.x 以前）存在各版本資料夾裡的設定：取版本最高、有寬度數字的那份
function findLegacy() {
  const base = process.env.WTF_PLUGIN_CACHE
    ? path.resolve(process.env.WTF_PLUGIN_CACHE)
    : path.join(os.homedir(), '.claude', 'plugins', 'cache');
  let best = null;
  let mps = [];
  try { mps = fs.readdirSync(base); } catch (e) { return null; }
  for (const mp of mps) {
    const wtfDir = path.join(base, mp, 'wtf');
    let vers = [];
    try { vers = fs.readdirSync(wtfDir); } catch (e) { continue; }
    for (const ver of vers) {
      const p = path.join(wtfDir, ver, 'skills', 'wtf', 'config.json');
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
      if (!cfg || !validWidth(cfg.terminalWidth)) continue;
      if (!best || ver.localeCompare(best.ver, undefined, { numeric: true }) > 0) {
        best = { ver, file: p, terminalWidth: cfg.terminalWidth, widthPromptDeclined: cfg.widthPromptDeclined === true };
      }
    }
  }
  return best;
}

function writeConfig(obj) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const data = {
    terminalWidth: validWidth(obj.terminalWidth) ? obj.terminalWidth : null,
    widthPromptDeclined: obj.widthPromptDeclined === true,
    _note: '由 wtf plugin 的 width.js 讀寫。terminalWidth＝使用者終端機視窗可用寬度（字元數，中文佔兩格）；' +
      'widthPromptDeclined＝使用者明確說過不要再問寬度。存在使用者層，plugin 升版不會清掉。',
  };
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' });
  fs.renameSync(tmp, p);
  return data;
}

/**
 * 讀設定。回傳：
 *   { path, terminalWidth, widthPromptDeclined, source, broken }
 *   source：'user'（使用者層檔）／'migrated'（剛從舊版搬來）／'none'（都沒有）
 *   broken：非空字串＝使用者層檔存在但讀不了（權限、非法 JSON）
 */
function load() {
  const p = configPath();
  let raw = null;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      return { path: p, terminalWidth: null, widthPromptDeclined: false, source: 'user',
        broken: '讀不到（' + ((e && e.code) || String(e)) + '）' };
    }
  }
  if (raw !== null) {
    let cfg;
    try { cfg = JSON.parse(raw); } catch (e) {
      return { path: p, terminalWidth: null, widthPromptDeclined: false, source: 'user',
        broken: '不是合法 JSON：' + String((e && e.message) || e).split('\n')[0] };
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return { path: p, terminalWidth: null, widthPromptDeclined: false, source: 'user', broken: '內容不是 JSON 物件' };
    }
    return { path: p, terminalWidth: validWidth(cfg.terminalWidth) ? cfg.terminalWidth : null,
      widthPromptDeclined: cfg.widthPromptDeclined === true, source: 'user', broken: '' };
  }
  // 使用者層沒有 → 試著從舊版搬
  const legacy = findLegacy();
  if (legacy) {
    try {
      writeConfig(legacy);
      return { path: p, terminalWidth: legacy.terminalWidth, widthPromptDeclined: legacy.widthPromptDeclined,
        source: 'migrated', migratedFrom: legacy.file, broken: '' };
    } catch (e) {
      // 寫不進去也照樣回傳舊值，這次先用；下次再試搬
      return { path: p, terminalWidth: legacy.terminalWidth, widthPromptDeclined: legacy.widthPromptDeclined,
        source: 'migrated', migratedFrom: legacy.file, broken: '' };
    }
  }
  return { path: p, terminalWidth: null, widthPromptDeclined: false, source: 'none', broken: '' };
}

module.exports = { configPath, load, writeConfig, validWidth, MIN_WIDTH, MAX_WIDTH };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'get') {
    console.log(JSON.stringify(load(), null, 2));
    process.exit(0);
  }
  if (cmd === 'set') {
    const n = Number(arg);
    if (!validWidth(n)) {
      console.error(`[wtf width] 寬度要是 ${MIN_WIDTH}~${MAX_WIDTH} 的整數，收到：${arg}`);
      process.exit(1);
    }
    const cur = load();
    // 只改寬度；widthPromptDeclined 維持原狀（它只管要不要主動問，已有數字本來就不會問）
    const saved = writeConfig({ terminalWidth: n, widthPromptDeclined: cur.broken ? false : cur.widthPromptDeclined });
    console.log(JSON.stringify({ ok: true, path: configPath(), ...saved }, null, 2));
    process.exit(0);
  }
  if (cmd === 'decline') {
    const cur = load();
    const saved = writeConfig({ terminalWidth: cur.terminalWidth, widthPromptDeclined: true });
    console.log(JSON.stringify({ ok: true, path: configPath(), ...saved }, null, 2));
    process.exit(0);
  }
  console.error('用法：node width.js get | set <寬度> | decline');
  process.exit(1);
}
