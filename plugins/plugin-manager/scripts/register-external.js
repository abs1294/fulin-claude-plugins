#!/usr/bin/env node
/**
 * register-external.js — 把「別人做的外部 plugin」登記進【推薦清單】recommends.json。
 *
 * 與 adopt 不同：adopt 是把「你自己的 skill」真身搬進 monorepo。
 *   register-external 只記「外部 plugin 的來源 + 用途 + tag」當推薦，
 *   不複製別人的程式碼進你的 monorepo（尊重它住在別人的 repo、跟著上游更新）。
 *
 * 寫去哪：plugins/plugin-manager/recommends.json（在 plugin 內、隨 monorepo 進 git）。
 *   ⭐ 這是刻意的——recommends 會被 publish 推廣，別人裝你的 repo 就看到你精選的外部 plugin。
 *   （對比 registry.json 在家目錄、不進 git、只存你個人本機狀態 selfMade。）
 *   之後 /setup-plugins 會列出這份推薦清單讓你挑、產生要自貼的安裝指令。
 *
 * 用法：node register-external.js <name@marketplace> <source> <note> [--tags a,b,c]
 *   name@marketplace : plugin 名 + marketplace 名（與 enabledPlugins key 同格式）
 *   source           : 取得來源——marketplace add 的參數，如 github owner/repo、或 URL
 *   note             : 【必填】一句用途描述（之後翻清單時靠它認出這 plugin 是幹嘛的）
 *   --tags a,b,c     : （可選）面向標籤，供 /setup-plugins 按面向分組挑裝（清單多時免一長串勾選）
 *
 * 移除：node register-external.js --remove <name@marketplace>
 * 改完記得 /plugin-manager:publish，recommends 才會推上去讓別人看到。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

// recommends.json 放在 plugin 內（隨 monorepo 進 git、會被 publish 推廣），
// 不像 registry.json（家目錄、私人、不進 git）。這是「公開推薦清單」與「個人本機狀態」的分界。
const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const configPath = path.join(PM_DIR, 'config.json');
if (!fs.existsSync(configPath)) die('找不到 config.json（~/.claude/plugin-manager/config.json），請先初始化 plugin-manager。');
let config;
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
catch (e) { die('config.json 解析失敗：' + e.message); }
const mono = config.monorepo;
if (!mono || !fs.existsSync(mono)) die('config.monorepo 無效：' + mono);

const recommendsPath = path.join(mono, 'plugins', 'plugin-manager', 'recommends.json');

let recommends;
if (fs.existsSync(recommendsPath)) {
  try { recommends = JSON.parse(fs.readFileSync(recommendsPath, 'utf8')); }
  catch (e) { die('recommends.json 解析失敗（可能損毀或被截斷）：' + e.message); }
} else {
  recommends = { schemaVersion: 1, recommends: {} };
}
recommends.recommends = recommends.recommends || {};

const argv = process.argv.slice(2);

// 原子寫 recommends.json（temp+rename，避免中斷留半截 JSON）。
function writeRecommends() {
  const tmp = recommendsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(recommends, null, 2) + '\n');
  fs.renameSync(tmp, recommendsPath);
}

// --- 移除模式 ---
if (argv[0] === '--remove') {
  const key = argv[1];
  if (!key) die('用法：node register-external.js --remove <name@marketplace>');
  if (!recommends.recommends[key]) die('recommends.json 沒有這筆：' + key);
  delete recommends.recommends[key];
  writeRecommends();
  console.log('✓ 已從推薦清單移除：' + key);
  process.exit(0);
}

// --- 登記模式 ---
const key = argv[0];
const source = argv[1];

// 從剩餘參數抽出 --tags a,b,c（其餘當 note）。tags 用於 /setup-plugins 按面向分組挑裝，
// 避免推薦清單一多時要一長串勾選。
const rest = argv.slice(2);
let tags = [];
const noteParts = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--tags') { tags = (rest[++i] || '').split(',').map(t => t.trim()).filter(Boolean); }
  else if (rest[i].startsWith('--tags=')) { tags = rest[i].slice('--tags='.length).split(',').map(t => t.trim()).filter(Boolean); }
  else noteParts.push(rest[i]);
}
const note = noteParts.join(' ');

if (!key || !source) die('用法：node register-external.js <name@marketplace> <source> [note] [--tags a,b,c]');

// 驗證 key 格式 name@marketplace（限 plugin/marketplace 名的合法字元，避免把
// /、;、<、> 等寫進 registry 並出現在給使用者貼的 /plugin install 指令裡）。
const m = key.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)$/);
if (!m) die('<name@marketplace> 格式錯誤（只允許英數與 . _ -，格式 plugin名@marketplace名，如 dotnet-skills@dotnet-skills）：' + key);
const marketplace = m[2];

// source / note 會被原樣印進「請使用者複製貼上」的指令區塊、並寫進 registry。
// 拒絕換行與控制字元，否則攻擊者可在 source 塞 "\n/plugin install evil@x" 多出一行
// 可被連同正常輸出一起貼進 Claude Code 的惡意 slash 指令（與 key 驗證同樣的注入面）。
function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) < 0x20) return true; } // < 空格 = 控制字元（含 CR LF TAB）
  return false;
}
// note 必填：之後翻 recommends.json 或 /setup-plugins 列清單時，要靠它想起「這個 plugin 是做什麼的」。
if (!note) die('note（用途描述）必填——請一句話說明這個 plugin 是做什麼的，否則之後認不出來。');
for (const [label, v] of [['source', source], ['note', note]]) {
  if (v && hasControlChar(v)) die(label + ' 不可含換行或控制字元：' + JSON.stringify(v));
}
// tag 限合法字元（會用於分組顯示，且避免控制字元注入）。
for (const t of tags) {
  if (!/^[A-Za-z0-9._-]+$/.test(t)) die('tag 只允許英數與 . _ -：' + JSON.stringify(t));
}

const exists = !!recommends.recommends[key];
recommends.recommends[key] = {
  marketplace: marketplace,
  source: source,
  note: note,
  tags: tags
};
writeRecommends();

console.log('== register-external（推薦清單）==');
console.log('  ' + (exists ? '更新（覆蓋既有）' : '新增') + '推薦：' + key);
console.log('  marketplace : ' + marketplace);
console.log('  source      : ' + source);
console.log('  note        : ' + note);
if (tags.length) console.log('  tags        : ' + tags.join(', '));
console.log('  → 已寫進 plugins/plugin-manager/recommends.json（隨 monorepo publish 後別人裝你 repo 就看得到）');
console.log('\n下一步：');
console.log('  - /plugin-manager:publish 把 recommends.json 推上去，別人裝你 repo 才看得到此推薦。');
console.log('  - /setup-plugins 會列出推薦清單讓你（或別人）挑裝。');
console.log('  - 要實際安裝需自貼（Claude 不能代執行 /plugin）：');
console.log('      /plugin marketplace add ' + source);
console.log('      /plugin install ' + key);
console.log('      /reload-plugins');
