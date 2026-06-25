#!/usr/bin/env node
/**
 * bump-version.js — 為一個既有自製 plugin bump 版本號。
 *
 * 為什麼要 bump：Claude Code 靠 plugin.json 的 version 判斷有無更新。
 *   改了 skill/hook 內容卻不 bump version，其他專案刷新 marketplace 後仍抓不到新版
 *   （Claude Code 沒有 /plugin update 子指令，更新靠 marketplace update + uninstall/install 或 auto-update）。
 *
 * 做法（純檔案操作，不呼叫 claude CLI）：
 *   1. 讀 monorepo/plugins/<name>/.claude-plugin/plugin.json 的現行 version。
 *   2. 依 patch|minor|major 計算新版號（semver，重置低位）。
 *   3. 寫回 plugin.json 的 version。
 *   4. 同步更新 ~/.claude/plugin-manager/registry.json 的 selfMade[<name>].version + dirty:true。
 *   5. 印出 舊版 → 新版，供 skill 呈現給使用者。
 *
 * 用法：node bump-version.js <name> <patch|minor|major>
 *   name : registry selfMade 裡的 plugin 名（= monorepo plugins/<name>）
 *   bump : patch（預設）| minor | major
 *
 * 注意：version 只設在 plugin.json，不在 marketplace.json 加 version 欄
 *       （research 已確認：兩處都設會衝突，plugin.json 勝）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
function readJson(p, label) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die((label || p) + ' 解析失敗（可能損毀）：' + e.message); }
}

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const configPath = path.join(PM_DIR, 'config.json');
const registryPath = path.join(PM_DIR, 'registry.json');

if (!fs.existsSync(configPath)) die('找不到 config.json（~/.claude/plugin-manager/config.json）。');
const config = readJson(configPath, 'config.json');
const registry = fs.existsSync(registryPath)
  ? readJson(registryPath, 'registry.json')
  : { schemaVersion: 1, selfMade: {} };

const name = process.argv[2];
const bump = (process.argv[3] || 'patch').toLowerCase();

if (!name) die('用法：node bump-version.js <name> <patch|minor|major>');
// name 白名單：防 '../' 等讓 pluginDir 逃出 plugins 目錄（與 adopt/register-external 對齊）。
if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') die('plugin 名只能含英數與 . _ -，且不可為 . 或 ..：' + name);
if (!['patch', 'minor', 'major'].includes(bump)) die('bump 必須是 patch | minor | major，收到：' + bump);

const mono = config.monorepo;
if (!mono || !fs.existsSync(mono)) die('config.monorepo 無效：' + mono);

const pluginDir = path.join(mono, 'plugins', name);
const pjPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
if (!fs.existsSync(pjPath)) die('找不到 plugin.json：' + pjPath + '（plugin 名可能拼錯，或尚未建立）');

const pj = readJson(pjPath, 'plugin.json');
const cur = String(pj.version || '0.0.0');

const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) die('plugin.json 的 version 不是 x.y.z 格式：' + cur);
let [major, minor, patch] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];

if (bump === 'major') { major += 1; minor = 0; patch = 0; }
else if (bump === 'minor') { minor += 1; patch = 0; }
else { patch += 1; }

const next = major + '.' + minor + '.' + patch;

// 先驗 registry 有此 plugin entry（在動任何寫入前）。
// 不可在缺漏時靜默以 source:'native' 重建——那會把 adopted plugin（如 git-commit，
// 帶 source:'adopted' + adoptedFrom）無聲降級為 native 並遺失出處。entry 缺漏視為異常。
registry.selfMade = registry.selfMade || {};
const entry = registry.selfMade[name];
if (!entry) {
  die('registry.selfMade 找不到 plugin entry：' + name +
      '（plugin.json 存在但 registry 缺此筆，registry 可能未同步）。' +
      '請先用 /plugin-manager:adopt 納管或手動補 entry，再重跑 bump-version，' +
      '以免把 adopted plugin 誤記為 native 並遺失 adoptedFrom。');
}

// 1. 寫回 plugin.json
pj.version = next;
fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');

// 2. 同步 registry（entry 已確認存在，只更新 version/dirty，保留 source/adoptedFrom）
entry.version = next;
entry.dirty = true;
registry.selfMade[name] = entry;
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');

console.log('== bump-version ==');
console.log('  plugin : ' + name);
console.log('  bump   : ' + bump);
console.log('  ' + cur + ' → ' + next);
console.log('✓ 已寫回 plugin.json');
console.log('✓ 已同步 registry（version=' + next + ', dirty=true）');
console.log('\n下一步：用 /plugin-manager:publish 發布；其他專案要拿到新版需各自刷新 marketplace 後 uninstall + install（或開 auto-update）。');
