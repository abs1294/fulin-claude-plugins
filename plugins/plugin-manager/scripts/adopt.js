#!/usr/bin/env node
/**
 * adopt.js — 把當前專案的一個自製 skill 納管進 monorepo。
 *
 * 模型：Move + symlink（真身只有一份）
 *   1. 把 <project>/.claude/skills/<skill> 真身 MOVE 進 monorepo/plugins/<pluginName>/skills/<skill>
 *   2. 為新 plugin 建 .claude-plugin/plugin.json（version 0.1.0）
 *   3. 在 monorepo marketplace.json 的 plugins[] 加一筆
 *   4. 原專案位置改成 symlink 指回 monorepo 那份（在專案仍可見、可用）
 *   5. 更新 ~/.claude/plugin-manager/registry.json 的 selfMade
 *   6. 若專案是 git repo，提示把該 symlink 加進 .gitignore（避免污染專案 repo）
 *
 * 用法：node adopt.js <skillName> <pluginName> [projectDir]
 *   skillName   : 專案 .claude/skills/ 底下的 skill 目錄名
 *   pluginName  : 在 monorepo 裡的 plugin 名（預設同 skillName）
 *   projectDir  : 專案根目錄（預設 cwd）
 *
 * 設計：所有狀態從 ~/.claude/plugin-manager/config.json 讀（monorepo 路徑、owner）。
 *       純檔案 + git 操作，不呼叫 claude CLI（research 風險 A 對策）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

// 一致的 JSON 讀取：解析失敗給乾淨 die 訊息，不噴 raw stack trace。
function readJson(p, label) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die((label || p) + ' 解析失敗（可能損毀）：' + e.message); }
}

// 跨檔案系統安全 move：rename 在跨磁碟（Windows 專案在 D:、monorepo 在 C:）會丟 EXDEV，
// 此時改用遞迴 copy + 刪來源。主流程與 rollback 共用，確保兩邊都能跨磁碟。
function safeMove(src, dest) {
  try { fs.renameSync(src, dest); }
  catch (e) {
    if (e.code === 'EXDEV') { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
    else throw e;
  }
}

// plugin/skill 名白名單：只允許英數與 . _ -，且不可為 . / .. / 含路徑分隔符，
// 防止 '../' 等讓路徑逃出 monorepo（與 register-external.js 的 key 驗證對齊）。
const NAME_RE = /^[A-Za-z0-9._-]+$/;
function validName(label, v) {
  if (!NAME_RE.test(v) || v === '.' || v === '..' || v.includes('/') || v.includes('\\')) {
    die(label + ' 格式錯誤（只允許英數與 . _ -，不可為 . / .. / 含路徑分隔符）：' + v);
  }
}

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const configPath = path.join(PM_DIR, 'config.json');
const registryPath = path.join(PM_DIR, 'registry.json');

if (!fs.existsSync(configPath)) die('找不到 config.json，請先初始化 plugin-manager（~/.claude/plugin-manager/config.json）。');
const config = readJson(configPath, 'config.json');
const registry = fs.existsSync(registryPath)
  ? readJson(registryPath, 'registry.json')
  : { schemaVersion: 1, selfMade: {}, externalCandidates: {} };

const skillName = process.argv[2];
const pluginName = process.argv[3] || skillName;
const projectDir = process.argv[4] || process.cwd();

if (!skillName) die('用法：node adopt.js <skillName> <pluginName> [projectDir]');
validName('skillName', skillName);
validName('pluginName', pluginName);

const mono = config.monorepo;
if (!mono || !fs.existsSync(mono)) die('config.monorepo 無效：' + mono);

// 來源：專案的 skill 真身
const srcSkill = path.join(projectDir, '.claude', 'skills', skillName);
if (!fs.existsSync(srcSkill)) die('找不到專案 skill：' + srcSkill);
const stat = fs.lstatSync(srcSkill);
if (stat.isSymbolicLink()) die(srcSkill + ' 已經是 symlink（可能已被納管），中止以免重複。');

// 目標：monorepo plugin
const pluginDir = path.join(mono, 'plugins', pluginName);
if (fs.existsSync(pluginDir)) die('monorepo 已有同名 plugin：' + pluginDir + '（請換 pluginName）');

const destSkill = path.join(pluginDir, 'skills', skillName);

console.log('== adopt 計畫 ==');
console.log('  skill 真身 : ' + srcSkill);
console.log('  搬進       : ' + destSkill);
console.log('  原位改為   : symlink → ' + destSkill);
console.log('  plugin 名  : ' + pluginName + ' (version 0.1.0)');

// === preflight：在動任何不可逆操作前，先讀好 marketplace.json 並驗證可寫 ===
// （srcSkill 存在/非 symlink、destSkill/pluginDir 不存在已在前面檢查過。）
const mpPath = path.join(mono, '.claude-plugin', 'marketplace.json');
const mp = readJson(mpPath, 'marketplace.json');
if (!Array.isArray(mp.plugins)) die('marketplace.json 格式異常（plugins 非陣列），中止。');
// 此時 pluginDir 已確認不存在（前面檢查過），若 marketplace 卻已有同名 entry，
// 代表處於「pluginDir 被手刪、marketplace 沒清」的不一致狀態——在動不可逆操作前擋下。
if (mp.plugins.some(p => p.name === pluginName)) {
  die('marketplace.json 已有 entry「' + pluginName + '」但 monorepo 無對應 plugin 目錄（不一致狀態）。請先清理 marketplace 或改用其他流程。');
}
const mpBackup = JSON.stringify(mp, null, 2) + '\n'; // 回滾用快照

// === rollback：rename 真身之後若任一步失敗，把真身搬回原位、清掉半完成的 pluginDir ===
let moved = false;
function rollback(reason) {
  console.error('⚠ adopt 失敗，開始回滾：' + reason);
  try {
    if (moved && !fs.existsSync(srcSkill) && fs.existsSync(destSkill)) {
      safeMove(destSkill, srcSkill); // 真身搬回原位（safeMove 處理跨磁碟）
      console.error('  ✓ 已把 skill 真身搬回原專案位置');
    }
  } catch (e) { console.error('  ✗ 搬回真身失敗，需手動處理：真身可能在 ' + destSkill); }
  try {
    if (fs.existsSync(pluginDir)) { fs.rmSync(pluginDir, { recursive: true, force: true }); console.error('  ✓ 已清除半完成的 ' + pluginDir); }
  } catch (e) { console.error('  ✗ 清除 pluginDir 失敗，需手動刪：' + pluginDir); }
  try { fs.writeFileSync(mpPath, mpBackup); } catch (e) { /* marketplace 未改到就略過 */ }
  die('已回滾到 adopt 前狀態（如上有殘留請依提示手動處理）。');
}

try {
  // 1. 建 plugin 目錄 + move 真身（move 後標 moved，供 rollback 判斷）
  fs.mkdirSync(path.join(pluginDir, 'skills'), { recursive: true });
  safeMove(srcSkill, destSkill); // safeMove 處理跨磁碟 EXDEV
  moved = true;
  console.log('✓ 已 move skill 真身進 monorepo');

  // 2. 建 plugin.json
  const pluginJson = {
    name: pluginName,
    version: '0.1.0',
    description: '（adopt 自動建立，請用 /plugin-manager:update 補描述）skill ' + skillName,
    author: { name: config.owner || 'unknown' },
    keywords: [skillName]
  };
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(pluginJson, null, 2) + '\n');
  console.log('✓ 已建 plugin.json');

  // 3. 更新 marketplace.json
  if (!mp.plugins.some(p => p.name === pluginName)) {
    mp.plugins.push({ name: pluginName, source: './plugins/' + pluginName, description: pluginJson.description });
    fs.writeFileSync(mpPath, JSON.stringify(mp, null, 2) + '\n');
    console.log('✓ 已加入 marketplace.json');
  }
} catch (e) {
  rollback(e.message); // plugin.json / marketplace 任一步失敗 → 全回滾
}

// 4. 原位置改 symlink（Windows: junction 較穩；先試 symlink，失敗 fallback）
// 注意：symlink 失敗「不」回滾——真身與 plugin 已就緒，只是原專案沒連結，屬可手動補的非致命狀態。
let symlinkOk = true;
try {
  fs.symlinkSync(destSkill, srcSkill, 'junction');
  console.log('✓ 已建 symlink（junction）回原專案');
} catch (e) {
  try {
    fs.symlinkSync(destSkill, srcSkill, 'dir');
    console.log('✓ 已建 symlink（dir）回原專案');
  } catch (e2) {
    symlinkOk = false;
    console.error('⚠ symlink 建立失敗：' + e2.message + '\n  真身已在 monorepo（adopt 主體已完成），但原專案位置未連結。\n  可手動建 junction：mklink /J "' + srcSkill + '" "' + destSkill + '"');
  }
}

// 5. 更新 registry
// 邊界誠實標示：此步「不在」上面的 rollback 範圍內。registry 寫入是最後一步、單一
// writeFileSync，失敗機率極低；萬一失敗，後果僅「registry 缺此 plugin entry」（真身/
// marketplace 都已就緒，可重跑 bump-version 或手動補 entry 修復），不致真身遺失，故不擴大原子範圍。
// adoptedFrom 只存專案名（basename），不存本機絕對路徑——避免 registry 若哪天誤入版控/
// 備份/貼到 issue 時外洩完整路徑結構（registry 本就存家目錄、設計上不進 git，這是縱深防禦）。
registry.selfMade = registry.selfMade || {};
registry.selfMade[pluginName] = {
  version: '0.1.0',
  path: 'plugins/' + pluginName,
  source: 'adopted',
  adoptedFrom: path.basename(projectDir),
  dirty: true
};
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log('✓ 已更新 registry');

// 6. 專案是 git repo → 提示 gitignore
const projGit = path.join(projectDir, '.git');
if (fs.existsSync(projGit)) {
  console.log('\n⚠ 此專案是 git repo。建議把該 symlink 排除，避免污染專案版控：');
  console.log('  在 ' + path.join(projectDir, '.gitignore') + ' 加入一行：');
  console.log('    .claude/skills/' + skillName);
}

if (symlinkOk) {
  console.log('\n✅ adopt 完成。下一步：/plugin-manager:publish 把整個 monorepo 推上 git。');
} else {
  console.log('\n⚠ adopt 主體已完成（真身已進 monorepo、marketplace/registry 已更新），但原專案連結未建。');
  console.log('  請先手動執行：mklink /J "' + srcSkill + '" "' + destSkill + '"');
  console.log('  建好連結後才能在原專案使用此 skill。之後再 /plugin-manager:publish。');
}
