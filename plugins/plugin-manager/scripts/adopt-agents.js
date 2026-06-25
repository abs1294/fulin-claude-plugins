#!/usr/bin/env node
/**
 * adopt-agents.js — 把專案的「整個 .claude/agents 目錄」納管成一個 plugin。
 *
 * 與 adopt.js（單一 skill）不同：
 *   - skill 是「一個目錄」→ adopt.js 一次收一個。
 *   - agent 是「單一 .md 檔」，且 Claude Code 不支援 agent 目錄結構（agent 必須是單檔）。
 *     Windows 非管理員又無法對「單檔」建 symlink（要管理員/開發者模式），junction 只能對目錄。
 *   - 解法：把整個 agents 目錄 move 進 plugin 的 agents/，原專案位置改成「整包目錄 junction」
 *     指回去（目錄 junction 免管理員權限）。一個 junction 帶走目錄裡全部 agent。
 *
 * 結果：plugins/<pluginName>/agents/*.md（真身），專案 .claude/agents（junction → 真身）。
 *   隨 monorepo publish 後，別人裝你的 repo 就拿到這組 agent（plugin 內 agents/ 自動載入）。
 *
 * 做法（純檔案操作）：preflight → move 整個 agents 目錄 → 建 plugin.json → marketplace → junction → registry。
 *   任一步失敗 rollback（搬回 agents、清半完成 pluginDir、還原 marketplace）。
 *
 * 用法：node adopt-agents.js <pluginName> [projectDir]
 *   pluginName  : 要建立的 plugin 名（如 supplier-agents）
 *   projectDir  : （可選）專案根；省略用 cwd。會收該專案的 .claude/agents 整包。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
function readJson(p, label) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die((label || p) + ' 解析失敗（可能損毀）：' + e.message); }
}
const NAME_RE = /^[A-Za-z0-9._-]+$/;

// 跨檔案系統安全 move：rename 跨磁碟（專案在 D:、monorepo 在 C:）會丟 EXDEV，
// 此時改用遞迴 copy + 刪來源（與 adopt.js 的 safeMove 一致）。
function safeMove(src, dest) {
  try { fs.renameSync(src, dest); }
  catch (e) {
    if (e.code === 'EXDEV') { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
    else throw e;
  }
}

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const configPath = path.join(PM_DIR, 'config.json');
const registryPath = path.join(PM_DIR, 'registry.json');

if (!fs.existsSync(configPath)) die('找不到 config.json，請先初始化（跑 scripts/init.js）。');
const config = readJson(configPath, 'config.json');
const registry = fs.existsSync(registryPath)
  ? readJson(registryPath, 'registry.json')
  : { schemaVersion: 1, selfMade: {} };

const pluginName = process.argv[2];
const projectDir = process.argv[3] || process.cwd();

if (!pluginName) die('用法：node adopt-agents.js <pluginName> [projectDir]');
if (!NAME_RE.test(pluginName) || pluginName === '.' || pluginName === '..') {
  die('pluginName 只允許英數與 . _ -，不可為 . / ..：' + pluginName);
}

const mono = config.monorepo;
if (!mono || !fs.existsSync(mono)) die('config.monorepo 無效：' + mono);

// 來源：專案的 agents 目錄真身
const srcAgents = path.join(projectDir, '.claude', 'agents');
if (!fs.existsSync(srcAgents)) die('找不到專案 agents 目錄：' + srcAgents);
if (fs.lstatSync(srcAgents).isSymbolicLink()) die(srcAgents + ' 已是 symlink（可能已納管），中止以免重複。');
const agentFiles = fs.readdirSync(srcAgents).filter(f => f.endsWith('.md'));
if (!agentFiles.length) die('專案 agents 目錄裡沒有 .md：' + srcAgents);

// 目標
const pluginDir = path.join(mono, 'plugins', pluginName);
if (fs.existsSync(pluginDir)) die('monorepo 已有同名 plugin：' + pluginDir + '（請換 pluginName）');
const destAgents = path.join(pluginDir, 'agents');

// preflight：先讀驗 marketplace
const mpPath = path.join(mono, '.claude-plugin', 'marketplace.json');
const mp = readJson(mpPath, 'marketplace.json');
if (!Array.isArray(mp.plugins)) die('marketplace.json 格式異常（plugins 非陣列），中止。');
if (mp.plugins.some(p => p.name === pluginName)) {
  die('marketplace.json 已有 entry「' + pluginName + '」但 monorepo 無對應 plugin 目錄（不一致），請先清理。');
}
const mpBackup = JSON.stringify(mp, null, 2) + '\n';

console.log('== adopt-agents 計畫 ==');
console.log('  來源 agents : ' + srcAgents + '（' + agentFiles.length + ' 個 agent）');
console.log('  搬進        : ' + destAgents);
console.log('  原位改為    : 整包 junction → ' + destAgents);
console.log('  plugin 名   : ' + pluginName + ' (version 0.1.0)');

let moved = false;
function rollback(reason) {
  console.error('⚠ adopt-agents 失敗，開始回滾：' + reason);
  try {
    if (moved && !fs.existsSync(srcAgents) && fs.existsSync(destAgents)) {
      safeMove(destAgents, srcAgents); // safeMove 處理跨磁碟
      console.error('  ✓ 已把 agents 真身搬回原專案位置');
    }
  } catch (e) { console.error('  ✗ 搬回失敗，需手動處理：真身可能在 ' + destAgents); }
  try {
    if (fs.existsSync(pluginDir)) { fs.rmSync(pluginDir, { recursive: true, force: true }); console.error('  ✓ 已清除半完成的 ' + pluginDir); }
  } catch (e) { console.error('  ✗ 清除 pluginDir 失敗，需手動刪：' + pluginDir); }
  try { fs.writeFileSync(mpPath, mpBackup); } catch (e) { /* 未改到就略過 */ }
  die('已回滾到 adopt 前狀態（如上有殘留請依提示手動處理）。');
}

try {
  // 1. move 整個 agents 目錄真身進 plugin
  fs.mkdirSync(pluginDir, { recursive: true });
  safeMove(srcAgents, destAgents); // safeMove 處理跨磁碟 EXDEV
  moved = true;
  console.log('✓ 已 move agents 整包進 monorepo：' + agentFiles.join(', '));

  // 2. plugin.json
  const pj = {
    name: pluginName,
    version: '0.1.0',
    description: '（adopt-agents 自動建立，請用 /plugin-manager:update 補描述）agent 組：' + agentFiles.map(f => f.replace(/\.md$/, '')).join('、'),
    author: { name: config.owner || 'unknown' },
    keywords: [pluginName, 'agents']
  };
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(pj, null, 2) + '\n');
  console.log('✓ 已建 plugin.json');

  // 3. marketplace
  mp.plugins.push({ name: pluginName, source: './plugins/' + pluginName, description: pj.description });
  fs.writeFileSync(mpPath, JSON.stringify(mp, null, 2) + '\n');
  console.log('✓ 已加入 marketplace.json');
} catch (e) {
  rollback(e.message);
}

// 4. 原位整包 junction（目錄 junction 免管理員權限）
let junctionOk = true;
try {
  fs.symlinkSync(destAgents, srcAgents, 'junction');
  console.log('✓ 已建整包 junction 回原專案');
} catch (e) {
  try {
    fs.symlinkSync(destAgents, srcAgents, 'dir');
    console.log('✓ 已建整包 symlink（dir）回原專案');
  } catch (e2) {
    junctionOk = false;
    console.error('⚠ junction 建立失敗：' + e2.message + '\n  agents 真身已在 monorepo，但原專案位置未連結。\n  可手動建：mklink /J "' + srcAgents + '" "' + destAgents + '"');
  }
}

// 5. registry（adoptedFrom 脫敏 basename）
registry.selfMade = registry.selfMade || {};
registry.selfMade[pluginName] = {
  version: '0.1.0',
  path: 'plugins/' + pluginName,
  source: 'adopted',
  adoptedFrom: path.basename(projectDir),
  dirty: true
};
const tmp = registryPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n');
fs.renameSync(tmp, registryPath);
console.log('✓ 已更新 registry');

// 專案是 git repo → 提示把 agents junction 排除版控（與 adopt.js 一致）
if (fs.existsSync(path.join(projectDir, '.git'))) {
  console.log('\n⚠ 此專案是 git repo。建議把該 junction 排除，避免污染專案版控：');
  console.log('  在 ' + path.join(projectDir, '.gitignore') + ' 加一行：');
  console.log('    .claude/agents');
}

if (junctionOk) {
  console.log('\n✅ adopt-agents 完成。下一步：/plugin-manager:publish 把整個 monorepo 推上 git。');
} else {
  console.log('\n⚠ 主體已完成（agents 真身進 monorepo、marketplace/registry 已更新），但原專案連結未建。');
  console.log('  請手動：mklink /J "' + srcAgents + '" "' + destAgents + '"，之後再 /plugin-manager:publish。');
}
