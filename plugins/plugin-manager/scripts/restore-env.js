#!/usr/bin/env node
/**
 * restore-env.js — 吃 export-env.js 產的快照，產生「在新環境復現」的 claude plugin CLI 指令鏈。
 *
 * 分工：`claude plugin marketplace add` / `install` / `disable` 是非互動 CLI，
 *   經使用者核可後由 Claude 直接執行（Bash）；只有最後的 /reload-plugins（沒有 CLI 對應）或重開 session
 *   要使用者自己做。本腳本本身只「讀快照 + 印出指令」，不實際安裝任何東西。
 *
 * 兩種復現情境都涵蓋：
 *   - 新機器全複製：跑下面整串 marketplace add + install。
 *   - 同機換專案：用 --enabled-only 只列「啟用中」的 plugin，搭配 /setup-plugins 寫進專案。
 *
 * 自製 plugin（fulin-plugins）特別提示：新機器要先 git clone monorepo + 跑 init.js，
 *   marketplace add 才指得到。
 *
 * 用法：node restore-env.js [snapshotPath] [--enabled-only]
 *   snapshotPath  : 快照檔；省略依序找 CLAUDE_PLUGIN_ROOT > 本 plugin 目錄 > monorepo/plugins/plugin-manager > cwd。
 *   --enabled-only: 只輸出快照裡 enabled=true 的 plugin（同機換專案常用）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
function readJson(p, label) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die((label || p) + ' 解析失敗：' + e.message); }
}

const args = process.argv.slice(2);
const enabledOnly = args.includes('--enabled-only');
let snapPath = args.find(a => !a.startsWith('--'));

// 找快照順序：參數 > 同 plugin 目錄（CLAUDE_PLUGIN_ROOT，新機從 cache 讀的關鍵）
// > monorepo 內 plugins/plugin-manager（開發機）> cwd。
if (!snapPath) {
  const candidates = [];
  if (process.env.CLAUDE_PLUGIN_ROOT) candidates.push(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'env-snapshot.json'));
  // 本腳本所在 plugin 目錄（__dirname = .../plugin-manager/scripts → 上一層）
  candidates.push(path.join(__dirname, '..', 'env-snapshot.json'));
  const HOME = os.homedir();
  const configPath = path.join(HOME, '.claude', 'plugin-manager', 'config.json');
  if (fs.existsSync(configPath)) {
    try { const cfg = readJson(configPath, 'config.json'); if (cfg.monorepo) candidates.push(path.join(cfg.monorepo, 'plugins', 'plugin-manager', 'env-snapshot.json')); } catch (e) { /* 略 */ }
  }
  candidates.push(path.join(process.cwd(), 'env-snapshot.json'));
  snapPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
}
if (!fs.existsSync(snapPath)) die('找不到快照：' + snapPath + '（先在原環境說「擷取環境快照」並 publish，新機 install plugin-manager 才會帶到快照）');

const snap = readJson(snapPath, 'env-snapshot.json');
const marketplaces = snap.marketplaces || {};
const plugins = snap.plugins || {};

// 篩要復現的 plugin
let entries = Object.entries(plugins);
if (enabledOnly) entries = entries.filter(([, v]) => v.enabled);

// 找出這些 plugin 涉及的 marketplace（只 add 用得到的）
const neededMkts = new Set();
for (const [key] of entries) {
  const at = key.lastIndexOf('@');
  if (at >= 0) neededMkts.add(key.slice(at + 1));
}

console.log('== restore-env：在新環境復現的指令 ==');
console.log('（以下 claude plugin 指令是非互動 CLI：使用者核可後 Claude 直接執行；只有第 3 步 /reload-plugins 要使用者自己在輸入框打）');
console.log('（' + (enabledOnly ? '只含啟用中的 plugin' : '含全部 plugin，未啟用的也裝起來') + '）\n');

// 自製 marketplace 特別前置——用 export 時標的 isCustom 旗標（精確比對 config.repo），不靠名字猜
const selfMkt = Object.entries(marketplaces).filter(([n, m]) => neededMkts.has(n) && m.isCustom);
if (selfMkt.length) {
  console.log('# 0. 自製 monorepo：先 clone 並初始化（新機器才需要）');
  for (const [, m] of selfMkt) {
    console.log('git clone https://github.com/' + m.repo + '.git');
    console.log('node "<clone 路徑>/plugins/plugin-manager/scripts/init.js" <owner> ' + m.repo);
  }
  console.log('');
}

// 印出的指令會由 Claude 用 Bash 執行：來源與 key 都要過白名單，不符的只印警告註解。
const SAFE_ARG = /^[A-Za-z0-9.\/~][A-Za-z0-9._~+@:\/\\-]*$/;
function shArg(s) { return s.includes('\\') ? "'" + s + "'" : s; }
function scopeFor(v) {
  const scopes = Array.isArray(v.scopes) && v.scopes.length ? v.scopes : ['user'];
  if (scopes.includes('user')) return { sc: 'user', scopes };
  return { sc: scopes.includes('local') && !scopes.includes('project') ? 'local' : 'project', scopes };
}

console.log('# 1. 加 marketplace');
for (const name of neededMkts) {
  const m = marketplaces[name];
  if (!m) { console.log('# ⚠ 快照缺 marketplace「' + name + '」來源，需手動處理'); continue; }
  if (!m.repo) { console.log('# ⚠ marketplace「' + name + '」快照裡沒有來源，需手動處理'); continue; }
  if (!SAFE_ARG.test(m.repo)) { console.log('# ⚠ marketplace「' + name + '」的來源含空白或 shell 特殊字元，不印成可執行指令：' + JSON.stringify(m.repo)); continue; }
  console.log('claude plugin marketplace add ' + shArg(m.repo));
}

// install 不帶 --scope 時預設 user；原環境只裝在專案層的，要到該專案目錄下用 --scope project/local 裝。
console.log('\n# 2. 安裝 plugin');
for (const [key, v] of entries) {
  if (!SAFE_ARG.test(key)) { console.log('# ⚠ plugin key 含空白或 shell 特殊字元，跳過：' + JSON.stringify(key)); continue; }
  const { sc, scopes } = scopeFor(v);
  if (sc === 'user') console.log('claude plugin install ' + key + ' --scope user');
  else {
    console.log('# ' + key + '：原環境只裝在 ' + scopes.join('/') + ' 層 → 到對應專案目錄下跑：claude plugin install ' + key + ' --scope ' + sc);
  }
}

console.log('\n# 3. 套用（沒有 CLI 對應：使用者自己在輸入框打，或重開 session）');
console.log('/reload-plugins');

// 快照的 enabled 只反映 user 層 ~/.claude/settings.json（export-env.js），專案層安裝在快照裡一律是 false，
// 所以只對 user 層安裝印 disable；專案層的啟用狀態看第 5 段，不能從這裡推。
console.log('\n# 4. user 層啟用狀態（install 後預設啟用；要精確還原，對 user 層「快照中停用」的跑下面的 disable。專案層安裝的啟用狀態看第 5 段）');
const enabledList = entries.filter(([, v]) => v.enabled).map(([k]) => k);
const disabledList = entries.filter(([, v]) => !v.enabled).map(([k]) => k);
console.log('  啟用：' + (enabledList.join(', ') || '(無)'));
if (!enabledOnly && disabledList.length) {
  console.log('  快照中停用：' + disabledList.join(', '));
  for (const [key, v] of entries) {
    if (v.enabled || !SAFE_ARG.test(key)) continue;
    if (scopeFor(v).sc === 'user') console.log('claude plugin disable ' + key + ' --scope user');
  }
}

// 5. per-project 啟用（各專案 .claude/settings.json 的 enabledPlugins）
const projects = snap.projects || {};
if (Object.keys(projects).length) {
  console.log('\n# 5. 各專案的 per-project 啟用（在對應專案目錄下，用 /setup-plugins 寫進該專案 settings）');
  for (const [proj, info] of Object.entries(projects)) {
    const list = Object.keys(info.enabledPlugins || {}).filter(k => info.enabledPlugins[k] === true);
    console.log('  專案「' + proj + '」啟用：' + (list.join(', ') || '(無)'));
  }
  console.log('  （快照只記專案名，新機請到對應專案目錄跑 /setup-plugins 或手動寫進該專案 .claude/settings.json）');
}
