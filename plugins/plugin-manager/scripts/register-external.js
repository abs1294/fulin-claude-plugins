#!/usr/bin/env node
/**
 * register-external.js — 把「別人做的外部 plugin」登記進 registry.externalCandidates。
 *
 * 與 adopt 不同：adopt 是把「你自己的 skill」搬進 monorepo（真身進你的 repo）。
 *   register-external 只是「登記一筆外部 plugin 的來源 + 備註」當候選清單，
 *   不複製任何別人的程式碼進你的 monorepo（尊重它住在別人的 repo、跟著上游更新）。
 *   之後 /setup-plugins 會列出這份候選清單讓你挑、產生要自貼的安裝指令。
 *
 * 為什麼用腳本而非手編 registry：與 adopt/bump-version/publish-finalize 一致，
 *   registry 一律由腳本操作，避免手寫 JSON 出錯（本專案設計原則）。
 *
 * 做法（純檔案操作，不呼叫 claude CLI、不碰別人的 repo）：
 *   1. 驗證 <name@marketplace> 格式。
 *   2. 寫/更新 registry.externalCandidates[name@marketplace] = { marketplace, source, note }。
 *   3. 已存在則更新（並提示是覆蓋）。
 *
 * 用法：node register-external.js <name@marketplace> <source> [note]
 *   name@marketplace : plugin 名 + marketplace 名（與 enabledPlugins key 同格式）
 *   source           : 取得來源——marketplace add 的參數，如 github owner/repo、或 URL
 *   note             : （可選）一句用途備註
 *
 * 移除候選：node register-external.js --remove <name@marketplace>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const registryPath = path.join(PM_DIR, 'registry.json');

// 確保家目錄狀態夾存在——首次使用時 PM_DIR 可能還沒被建立，否則下面 writeFileSync 會 ENOENT。
fs.mkdirSync(PM_DIR, { recursive: true });

const registry = fs.existsSync(registryPath)
  ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  : { schemaVersion: 1, selfMade: {}, externalCandidates: {} };
registry.externalCandidates = registry.externalCandidates || {};

const argv = process.argv.slice(2);

// --- 移除模式 ---
if (argv[0] === '--remove') {
  const key = argv[1];
  if (!key) die('用法：node register-external.js --remove <name@marketplace>');
  if (!registry.externalCandidates[key]) die('externalCandidates 沒有這筆：' + key);
  delete registry.externalCandidates[key];
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log('✓ 已移除外部候選：' + key);
  process.exit(0);
}

// --- 登記模式 ---
const key = argv[0];
const source = argv[1];
const note = argv.slice(2).join(' ');

if (!key || !source) die('用法：node register-external.js <name@marketplace> <source> [note]');

// 驗證 key 格式 name@marketplace（限 plugin/marketplace 名的合法字元，避免把
// /、;、<、> 等寫進 registry 並出現在給使用者貼的 /plugin install 指令裡）。
const m = key.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)$/);
if (!m) die('<name@marketplace> 格式錯誤（只允許英數與 . _ -，格式 plugin名@marketplace名，如 dotnet-skills@dotnet-skills）：' + key);
const marketplace = m[2];

const exists = !!registry.externalCandidates[key];
registry.externalCandidates[key] = {
  marketplace: marketplace,
  source: source,
  note: note || ''
};
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');

console.log('== register-external ==');
console.log('  ' + (exists ? '更新（覆蓋既有）' : '新增') + '外部候選：' + key);
console.log('  marketplace : ' + marketplace);
console.log('  source      : ' + source);
if (note) console.log('  note        : ' + note);
console.log('\n下一步：');
console.log('  - /setup-plugins 會列出 externalCandidates 讓你挑裝。');
console.log('  - 要實際安裝需自貼（Claude 不能代執行 /plugin）：');
console.log('      /plugin marketplace add ' + source);
console.log('      /plugin install ' + key);
console.log('      /reload-plugins');
