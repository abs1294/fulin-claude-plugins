#!/usr/bin/env node
/**
 * upgrade-check.js — 偵測「當前專案啟用的自製 plugin」是否落後 registry 最新版。
 *
 * 本腳本唯讀，不動任何檔案；只跑唯讀的 `claude plugin list --json` 查實際安裝紀錄，不執行任何安裝／更新指令。
 *
 * 為什麼是「偵測 + 列出」，執行交給 Claude：
 *   - 更新用非互動 CLI：`claude plugin marketplace update <mkt>` + `claude plugin update <name>@<mkt> --scope <scope>`，
 *     scope 以 `claude plugin list --json` 的實際安裝紀錄為準（同 id、projectPath＝本專案的 local／project 優先，否則 user）；
 *     CLI 跑不起來或查不到紀錄時，才依啟用宣告所在檔推定（settings.local.json → local、settings.json → project），並在輸出標「推定」。
 *     Claude 可直接用 Bash 執行（照 setup-plugins 的核可規則）；跑完要使用者重開 session 才生效。
 *     互動 slash UI 的 /plugin 沒有 update 子指令，所以印的是 CLI 版。
 *   - 專案 .claude/settings.json 的 enabledPlugins 只存 "name@marketplace"，
 *     通常不帶版本號（Claude Code 裝的是 cache 裡那份）。所以無法純由 settings
 *     得知「專案現在跑哪一版」；能比對的是「此專案啟用了哪些自製 plugin」
 *     vs「registry selfMade 的最新版本」，並標出哪些尚未 publish（dirty）。
 *
 * 做法：
 *   1. 讀 ~/.claude/plugin-manager/{config,registry}.json。
 *   2. 讀 <projectDir>/.claude/settings.json 與 settings.local.json 的 enabledPlugins（local 優先）。
 *   3. 取 enabledPlugins 中 marketplace == config 的 marketplace（預設 fulin-plugins）
 *      且 plugin 名出現在 registry.selfMade 者 = 「本專案啟用的自製 plugin」。
 *   4. 對每個列出：registry 最新版、是否 dirty（dirty=未 publish，最新版連 monorepo 都還沒推）。
 *   5. 印出 Claude 可直接執行的 CLI 指令（marketplace update 刷新 → claude plugin update 更新）。
 *
 * 用法：node upgrade-check.js [projectDir]
 *   projectDir 省略時用 cwd。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const configPath = path.join(PM_DIR, 'config.json');
const registryPath = path.join(PM_DIR, 'registry.json');

function readJson(p, label) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die((label || p) + ' 解析失敗（可能損毀）：' + e.message); }
}

if (!fs.existsSync(configPath)) die('找不到 config.json（~/.claude/plugin-manager/config.json）。');
const config = readJson(configPath, 'config.json');
const registry = fs.existsSync(registryPath)
  ? readJson(registryPath, 'registry.json')
  : { schemaVersion: 1, selfMade: {} };

const projectDir = process.argv[2] || process.cwd();
// marketplace 名的單一真實來源：monorepo 的 .claude-plugin/marketplace.json 的 name。
// 優先序：config.marketplace（顯式覆寫）> marketplace.json 的 name > 'fulin-plugins'（最後保險）。
function resolveMarketplace() {
  if (config.marketplace) return config.marketplace;
  try {
    const mpPath = path.join(config.monorepo || '', '.claude-plugin', 'marketplace.json');
    if (fs.existsSync(mpPath)) {
      const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
      if (mp && mp.name) return mp.name;
    }
  } catch (e) { /* 讀不到就 fallback */ }
  return 'fulin-plugins';
}
const marketplace = resolveMarketplace();
// 印出的更新指令會由 Claude 用 Bash 執行：marketplace 名與 plugin 名都只接受英數與 . _ -（與 register-external 的 key 驗證同一套）。
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
if (!SAFE_NAME.test(marketplace)) die('marketplace 名稱含不允許的字元（只接受英數與 . _ -），不印更新指令：' + JSON.stringify(marketplace));

const settingsPath = path.join(projectDir, '.claude', 'settings.json');
const localSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');
if (!fs.existsSync(settingsPath) && !fs.existsSync(localSettingsPath)) {
  console.log('此專案沒有 .claude/settings.json 也沒有 settings.local.json：' + settingsPath);
  console.log('代表尚未用 /setup-plugins 設定過 plugin 組合。upgrade 無對象。');
  process.exit(0);
}

function readSettings(p, label) {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(label + ' 不是合法 JSON：' + e.message); }
}
const projEnabled = readSettings(settingsPath, 'settings.json').enabledPlugins || {};
const localEnabled = readSettings(localSettingsPath, 'settings.local.json').enabledPlugins || {};
// local 覆寫 project（Claude Code 設定優先序）；scope 跟著宣告所在的檔走。
const enabled = {};
const scopeOf = {};
for (const k of Object.keys(projEnabled)) { enabled[k] = projEnabled[k]; scopeOf[k] = 'project'; }
for (const k of Object.keys(localEnabled)) { enabled[k] = localEnabled[k]; scopeOf[k] = 'local'; }
const selfMade = registry.selfMade || {};

// 實際安裝紀錄：啟用宣告寫在哪個檔不等於裝在哪層（例如 user 層安裝、在專案 settings 宣告啟用），
// 所以 scope 以 claude plugin list --json 為準。唯讀指令；失敗就退回推定。
function normPath(p) {
  const r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
let installs = null;
try {
  const out = require('child_process').execFileSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  const list = JSON.parse(out);
  if (Array.isArray(list)) installs = list;
} catch (e) { installs = null; }
const here = normPath(projectDir);
function installedScope(key) {
  if (!installs) return null;
  const mine = installs.filter((p) => p && p.id === key);
  for (const sc of ['local', 'project']) {
    if (mine.some((p) => p.scope === sc && p.projectPath && normPath(p.projectPath) === here)) return sc;
  }
  if (mine.some((p) => p.scope === 'user')) return 'user';
  return null;
}

// 找出此專案啟用、且屬於本 marketplace、且是自製 plugin 的項目
const rows = [];
for (const key of Object.keys(enabled)) {
  if (enabled[key] === false) continue; // 明確停用的略過
  // key 形如 "name@marketplace"
  const at = key.lastIndexOf('@');
  const pname = at >= 0 ? key.slice(0, at) : key;
  const mkt = at >= 0 ? key.slice(at + 1) : null;
  if (mkt && mkt !== marketplace) continue;       // 別的 marketplace 不管
  if (!selfMade[pname]) continue;                  // 非自製 plugin 不管
  if (!SAFE_NAME.test(pname)) { console.log('⚠ plugin 名稱含不允許的字元，略過：' + JSON.stringify(pname)); continue; }
  const real = installedScope(key);
  rows.push({ name: pname, key, scope: real || scopeOf[key], scopeFrom: real ? 'installed' : 'guessed', latest: selfMade[pname].version, dirty: !!selfMade[pname].dirty });
}

console.log('== setup-plugins upgrade 偵測 ==');
console.log('  專案      : ' + projectDir);
console.log('  marketplace: ' + marketplace);

if (!rows.length) {
  console.log('\n此專案沒有啟用任何「本 marketplace 的自製 plugin」，無需 upgrade。');
  process.exit(0);
}

console.log('\n  本專案啟用的自製 plugin（registry 最新版）：');
for (const r of rows) {
  console.log('    - ' + r.name + '  最新版 ' + r.latest + (r.dirty ? '  ⚠ dirty（registry 最新版尚未 publish）' : ''));
}

const dirtyOnes = rows.filter(r => r.dirty).map(r => r.name);
if (dirtyOnes.length) {
  console.log('\n⚠ 下列 plugin 的 registry 最新版尚未 publish：' + dirtyOnes.join(', '));
  console.log('  請先在 monorepo 跑 /plugin-manager:publish，否則刷新 marketplace 後也抓不到新版。');
}

console.log('\n-- 更新指令（非互動 CLI，Claude 可直接執行；在專案目錄 ' + projectDir + ' 下跑）--');
console.log('  claude plugin marketplace update ' + marketplace + '   # 1. 先刷新 marketplace 索引');
console.log('  # 2. 對每個 plugin 更新（--json 可看 outcome／updateOutcome）：');
for (const r of rows) {
  const why = r.scopeFrom === 'installed'
    ? '# 安裝紀錄：' + r.scope + ' 層（claude plugin list）'
    : '# 推定：查不到安裝紀錄，依啟用宣告在 ' + (r.scope === 'local' ? 'settings.local.json' : 'settings.json');
  console.log('  claude plugin update ' + r.name + '@' + marketplace + ' --scope ' + r.scope + '   ' + why);
}
console.log('  # 標「推定」的：先用 claude plugin list --json 查這個專案的 projectPath 與 scope 確認，再跑。');
console.log('  # 3. 套用：要使用者自己重開 session（CLI 更新後需重開才生效；這步 Claude 做不到）');
console.log('  # 或：在 /plugin 互動 UI 的 Marketplaces tab 對 ' + marketplace + ' 開 Enable auto-update');
