#!/usr/bin/env node
/**
 * export-env.js — 擷取「當前 Claude Code plugin 環境」快照，供日後在別台機器/別專案復現。
 *
 * 資料源（都是 Claude Code 自己維護的官方檔，不自行拼湊）：
 *   - ~/.claude/plugins/known_marketplaces.json：每個 marketplace 的來源（source.repo）
 *   - ~/.claude/plugins/installed_plugins.json：每個已裝 plugin 的版本/scope
 *   - ~/.claude/settings.json：user 層 enabledPlugins（哪些啟用）
 *
 * 產出：env-snapshot.json（預設寫到 plugin 內 plugins/plugin-manager/，隨 git/publish；可用參數改路徑）。
 *   放 plugin 內的用意：新機 /plugin install plugin-manager 時快照進 cache，restore 從 CLAUDE_PLUGIN_ROOT 讀得到。
 *   內含：marketplaces[name→repo]、plugins[name@mkt→{version,enabled,scopes}]。
 *   restore-env.js 吃這份快照產生 marketplace add / install 指令鏈。
 *
 * 注意：本腳本只「讀狀態 + 寫一份 JSON」，不碰 /plugin、不裝任何東西。
 *
 * 用法：node export-env.js [outputPath]
 *   outputPath：（可選）快照輸出路徑；省略寫到 <monorepo>/plugins/plugin-manager/env-snapshot.json。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
function readJson(p, label) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die((label || p) + ' 解析失敗：' + e.message); }
}

const HOME = os.homedir();
const pluginsDir = path.join(HOME, '.claude', 'plugins');
const knownPath = path.join(pluginsDir, 'known_marketplaces.json');
const installedPath = path.join(pluginsDir, 'installed_plugins.json');
const settingsPath = path.join(HOME, '.claude', 'settings.json');

if (!fs.existsSync(knownPath)) die('找不到 known_marketplaces.json：' + knownPath);
if (!fs.existsSync(installedPath)) die('找不到 installed_plugins.json：' + installedPath);

const known = readJson(knownPath, 'known_marketplaces.json');
const installed = readJson(installedPath, 'installed_plugins.json');
const settings = fs.existsSync(settingsPath) ? readJson(settingsPath, 'settings.json') : {};
const enabled = settings.enabledPlugins || {};

// 本機 config 指的「自製 monorepo repo」——用來精確標記哪個 marketplace 是自製（非靠名字猜）。
let selfRepo = null;
const configPath0 = path.join(HOME, '.claude', 'plugin-manager', 'config.json');
if (fs.existsSync(configPath0)) { try { selfRepo = (readJson(configPath0, 'config.json').repo || '').toLowerCase(); } catch (e) { /* 略 */ } }

// 1. marketplaces：name → { source, repo, isCustom }（restore 用來 marketplace add）
const marketplaces = {};
for (const [name, info] of Object.entries(known)) {
  const src = info.source || {};
  const repo = src.repo || src.path || src.url || '(unknown)';
  marketplaces[name] = {
    source: src.source || 'unknown',
    repo,
    isCustom: !!(selfRepo && String(repo).toLowerCase() === selfRepo) // 精確比對 config.repo，非 substring
  };
}

// 2. plugins：name@mkt → { version, enabled, scopes[] }
//    installed_plugins 每個 key 是 array（同 plugin 可同時 user + project 多 scope）——全部保留。
const plugins = {};
const inst = installed.plugins || {};
for (const [key, entries] of Object.entries(inst)) {
  const arr = Array.isArray(entries) ? entries : [entries];
  plugins[key] = {
    version: (arr[0] && arr[0].version) || '(unknown)',
    scopes: arr.map(e => (e && e.scope) || '(unknown)'),
    enabled: enabled[key] === true
  };
}
// enabledPlugins 裡有、但 installed 沒記到的（理論上少見）也補進來
for (const key of Object.keys(enabled)) {
  if (!plugins[key]) plugins[key] = { version: '(not-installed)', scopes: ['user'], enabled: enabled[key] === true };
}

// 3. projects：各專案的 per-project 啟用（<專案>/.claude/settings.json 的 enabledPlugins）。
//    專案來源 = installed_plugins 裡 project scope 條目的 projectPath。
//    key 只存專案 basename（脫敏，不存絕對路徑，避免隨 git 外洩路徑結構）。
const projects = {};
const projPaths = new Set();
for (const entries of Object.values(inst)) {
  for (const e of (Array.isArray(entries) ? entries : [entries])) {
    if (e && e.scope === 'project' && e.projectPath) projPaths.add(e.projectPath);
  }
}
for (const p of projPaths) {
  const sp = path.join(p, '.claude', 'settings.json');
  if (!fs.existsSync(sp)) continue;
  let ps;
  try { ps = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (e) { continue; }
  const pe = ps.enabledPlugins || {};
  if (!Object.keys(pe).length) continue;
  // key 用 basename 脫敏；若兩個不同路徑的專案同名，加後綴避免互蓋（#2、#3…）。
  let key = path.basename(p);
  if (projects[key]) { let n = 2; while (projects[key + '#' + n]) n++; key = key + '#' + n; }
  projects[key] = { enabledPlugins: pe };
}

const snapshot = {
  schemaVersion: 1,
  marketplaces,
  plugins,
  projects
};

// 輸出路徑：參數優先，否則寫進「plugin 內」plugins/plugin-manager/env-snapshot.json。
// 為什麼放 plugin 內：它隨 git/publish 走，新機 /plugin install plugin-manager 時快照就進 cache，
// clone-env skill 從 CLAUDE_PLUGIN_ROOT 讀得到——免手動帶檔。
// （快照 export 完即 publish，權威版本就是 git 那版；cache 被 install/update 更新成 git 版正是要的。）
let outPath = process.argv[2];
if (!outPath) {
  const configPath = path.join(HOME, '.claude', 'plugin-manager', 'config.json');
  if (fs.existsSync(configPath)) {
    const cfg = readJson(configPath, 'config.json');
    if (cfg.monorepo) outPath = path.join(cfg.monorepo, 'plugins', 'plugin-manager', 'env-snapshot.json');
  }
  if (!outPath) outPath = path.join(process.cwd(), 'env-snapshot.json');
}

fs.mkdirSync(path.dirname(outPath), { recursive: true }); // 確保輸出目錄存在，否則 writeFileSync 會 ENOENT
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');

const mktCount = Object.keys(marketplaces).length;
const pluginCount = Object.keys(plugins).length;
const enabledCount = Object.values(plugins).filter(p => p.enabled).length;
console.log('== export-env ==');
console.log('  marketplaces : ' + mktCount);
console.log('  plugins      : ' + pluginCount + '（user 層啟用 ' + enabledCount + '）');
console.log('  projects     : ' + Object.keys(projects).length + '（各專案 per-project 啟用）');
console.log('  → 快照已寫到：' + outPath + '（在 plugin 內、隨 git）');
console.log('\n下一步：');
console.log('  1. /plugin-manager:publish 把快照推上去（新機 install plugin-manager 才帶得到）。');
console.log('  2. 新機裝好 plugin-manager 後說「復現環境」，restore 會從快照產生安裝清單。');
