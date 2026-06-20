#!/usr/bin/env node
/**
 * publish-status.js — 分析 monorepo 待發布狀態（唯讀，不做 commit/push）。
 *
 * 輸出：哪些 plugin 有改動、git status 摘要、建議的 commit message。
 * 實際的 commit/push 由 skill 引導使用者確認後執行（走既有 git 流程）。
 *
 * 用法：node publish-status.js
 * 從 ~/.claude/plugin-manager/config.json 讀 monorepo 路徑。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// 回傳 { ok, out }：ok=false 代表 git 指令失敗（caller 自行決定 fail fast）。
// 不用 shell 重導向（2>/dev/null）或 ||，因為 Windows 走 cmd.exe 不認 Unix 語法。
function sh(cmd, cwd) {
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).trim() }; }
}

const configPath = path.join(os.homedir(), '.claude', 'plugin-manager', 'config.json');
if (!fs.existsSync(configPath)) { console.error('ERROR: 找不到 config.json'); process.exit(1); }
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const mono = config.monorepo;
if (!mono || !fs.existsSync(path.join(mono, '.git'))) { console.error('ERROR: monorepo 不是 git repo：' + mono); process.exit(1); }

const statusRes = sh('git status --short', mono);
if (!statusRes.ok) { console.error('ERROR: git status 失敗：' + statusRes.out); process.exit(1); }
const status = statusRes.out;

const branchRes = sh('git rev-parse --abbrev-ref HEAD', mono);
const branch = branchRes.ok ? branchRes.out : '(unknown)';

// ahead：無 upstream 時 git rev-list 會失敗（sh().ok=false）→ 視為 0，不用 shell 重導向。
const aheadRes = sh('git rev-list --count @{u}..HEAD', mono);
const aheadNum = aheadRes.ok ? (parseInt(aheadRes.out, 10) || 0) : 0;

if (!status) {
  console.log('工作區乾淨，沒有待發布的改動。');
  if (aheadNum > 0) console.log('但本地領先 origin ' + aheadNum + ' 個 commit，可能需要 push。');
  process.exit(0);
}

// 找出哪些 plugin 目錄有改動
// git status --short 格式：2 欄狀態碼 + 空格 + path。用 regex 取 path（slice(3) 對
// rename 的 "R  a -> b" 或欄位寬度變化不穩，會砍掉 path 首字）。rename 取箭頭後的新路徑。
const changedPlugins = new Set();
let otherChanges = [];
for (const line of status.split('\n')) {
  if (!line.trim()) continue;
  // sh() 已 trim 行，前導狀態欄空格可能被砍；用 1-2 字元狀態碼 + 一或多空白容錯。
  const m0 = line.match(/^.{1,2}\s+(.+)$/);
  if (!m0) continue;
  let file = m0[1];
  const arrow = file.indexOf(' -> ');
  if (arrow >= 0) file = file.slice(arrow + 4); // rename：取新路徑
  file = file.replace(/^"|"$/g, '');            // 去掉非 ASCII 路徑的引號
  const m = file.match(/^plugins\/([^/]+)\//);
  if (m) changedPlugins.add(m[1]);
  else otherChanges.push(file);
}

console.log('== monorepo 待發布狀態 ==');
console.log('  分支: ' + branch + (aheadNum > 0 ? '（本地領先 ' + aheadNum + '）' : ''));
console.log('  改動的 plugin: ' + ([...changedPlugins].join(', ') || '(無)'));
if (otherChanges.length) console.log('  其他改動: ' + otherChanges.join(', '));
console.log('\n-- git status --');
console.log(status);

// 建議 commit message
let suggested;
const plugins = [...changedPlugins];
if (plugins.length === 1) suggested = 'Update: ' + plugins[0] + ' plugin';
else if (plugins.length > 1) suggested = 'Update: ' + plugins.join(', ') + ' plugins';
else suggested = 'Update: monorepo config';
console.log('\n-- 建議 commit message --');
console.log(suggested);
