#!/usr/bin/env node
/**
 * upgrade-check.js — 偵測「當前專案啟用的自製 plugin」是否落後 registry 最新版。
 *
 * 唯讀，不動任何檔案、不代執行 /plugin（research 風險 A：互動指令一律給使用者貼）。
 *
 * 為什麼是「偵測 + 列出」而非自動更新：
 *   - plugin 啟用/更新（/plugin install、uninstall、marketplace update）是互動指令，Claude 不能代執行。
 *     注意：Claude Code 沒有 /plugin update 子指令，更新要靠 marketplace update + uninstall/install。
 *   - 專案 .claude/settings.json 的 enabledPlugins 只存 "name@marketplace"，
 *     通常不帶版本號（Claude Code 裝的是 cache 裡那份）。所以無法純由 settings
 *     得知「專案現在跑哪一版」；能比對的是「此專案啟用了哪些自製 plugin」
 *     vs「registry selfMade 的最新版本」，並標出哪些尚未 publish（dirty）。
 *
 * 做法：
 *   1. 讀 ~/.claude/plugin-manager/{config,registry}.json。
 *   2. 讀 <projectDir>/.claude/settings.json 的 enabledPlugins。
 *   3. 取 enabledPlugins 中 marketplace == config 的 marketplace（預設 fulin-plugins）
 *      且 plugin 名出現在 registry.selfMade 者 = 「本專案啟用的自製 plugin」。
 *   4. 對每個列出：registry 最新版、是否 dirty（dirty=未 publish，最新版連 monorepo 都還沒推）。
 *   5. 印出建議使用者自貼的指令（marketplace update 刷新 → uninstall + install 重裝）。
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

const settingsPath = path.join(projectDir, '.claude', 'settings.json');
if (!fs.existsSync(settingsPath)) {
  console.log('此專案沒有 .claude/settings.json：' + settingsPath);
  console.log('代表尚未用 /setup-plugins 設定過 plugin 組合。upgrade 無對象。');
  process.exit(0);
}

let settings;
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
catch (e) { die('settings.json 不是合法 JSON：' + e.message); }

const enabled = settings.enabledPlugins || {};
const selfMade = registry.selfMade || {};

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
  rows.push({ name: pname, key, latest: selfMade[pname].version, dirty: !!selfMade[pname].dirty });
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

console.log('\n-- 建議使用者自貼的指令（Claude 不能代執行 /plugin；無 /plugin update 子指令）--');
console.log('  /plugin marketplace update ' + marketplace + '   # 1. 先刷新 marketplace 索引');
console.log('  # 2. 對每個落後的 plugin 重裝（uninstall + install，各自一行——');
console.log('  #    /plugin 輸入框不是 shell，不能用 && 串接，需逐行貼）：');
for (const r of rows) {
  console.log('  /plugin uninstall ' + r.name + '@' + marketplace);
  console.log('  /plugin install ' + r.name + '@' + marketplace);
}
console.log('  /reload-plugins                                # 3. 套用');
console.log('  # 或：在 /plugin 互動 UI 的 Marketplaces tab 對 ' + marketplace + ' 開 Enable auto-update');
