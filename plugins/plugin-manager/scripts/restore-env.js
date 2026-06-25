#!/usr/bin/env node
/**
 * restore-env.js — 吃 export-env.js 產的快照，產生「在新環境復現」要貼的指令鏈。
 *
 * 重要：Claude 不能代執行 /plugin（marketplace add / install / reload 都是互動指令），
 *   所以本腳本只「讀快照 + 印出你要自己貼的指令」，不實際安裝任何東西。
 *
 * 兩種復現情境都涵蓋：
 *   - 新機器全複製：跑下面整串 marketplace add + install。
 *   - 同機換專案：用 --enabled-only 只列「啟用中」的 plugin，搭配 /setup-plugins 寫進專案。
 *
 * 自製 plugin（fulin-plugins）特別提示：新機器要先 git clone monorepo + 跑 init.js，
 *   marketplace add 才指得到。
 *
 * 用法：node restore-env.js [snapshotPath] [--enabled-only]
 *   snapshotPath  : 快照檔；省略找 <monorepo>/env-snapshot.json 或 cwd/env-snapshot.json。
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

if (!snapPath) {
  const HOME = os.homedir();
  const configPath = path.join(HOME, '.claude', 'plugin-manager', 'config.json');
  if (fs.existsSync(configPath)) {
    const cfg = readJson(configPath, 'config.json');
    if (cfg.monorepo && fs.existsSync(path.join(cfg.monorepo, 'env-snapshot.json'))) {
      snapPath = path.join(cfg.monorepo, 'env-snapshot.json');
    }
  }
  if (!snapPath) snapPath = path.join(process.cwd(), 'env-snapshot.json');
}
if (!fs.existsSync(snapPath)) die('找不到快照：' + snapPath + '（先在原環境跑 export-env.js）');

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
console.log('（Claude 不能代執行 /plugin，請逐行自己貼到輸入框）');
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

console.log('# 1. 加 marketplace');
for (const name of neededMkts) {
  const m = marketplaces[name];
  if (!m) { console.log('# ⚠ 快照缺 marketplace「' + name + '」來源，需手動處理'); continue; }
  if (m.source === 'github' && m.repo) console.log('/plugin marketplace add ' + m.repo);
  else console.log('/plugin marketplace add ' + (m.repo || '(unknown source for ' + name + ')'));
}

console.log('\n# 2. 安裝 plugin');
for (const [key] of entries) console.log('/plugin install ' + key);

console.log('\n# 3. 套用');
console.log('/reload-plugins');

console.log('\n# 4. 啟用狀態（install 後預設啟用；如需精確還原停用狀態，於 /plugin UI 或專案 settings 調整）');
const enabledList = entries.filter(([, v]) => v.enabled).map(([k]) => k);
const disabledList = entries.filter(([, v]) => !v.enabled).map(([k]) => k);
console.log('  啟用：' + (enabledList.join(', ') || '(無)'));
if (!enabledOnly && disabledList.length) console.log('  快照中停用：' + disabledList.join(', '));
