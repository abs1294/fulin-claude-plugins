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

function sh(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8' }).trim(); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

const configPath = path.join(os.homedir(), '.claude', 'plugin-manager', 'config.json');
if (!fs.existsSync(configPath)) { console.error('ERROR: 找不到 config.json'); process.exit(1); }
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const mono = config.monorepo;
if (!mono || !fs.existsSync(path.join(mono, '.git'))) { console.error('ERROR: monorepo 不是 git repo：' + mono); process.exit(1); }

const status = sh('git status --short', mono);
const branch = sh('git rev-parse --abbrev-ref HEAD', mono);
const ahead = sh('git rev-list --count @{u}..HEAD 2>/dev/null || echo 0', mono);

if (!status) {
  console.log('工作區乾淨，沒有待發布的改動。');
  if (parseInt(ahead) > 0) console.log('但本地領先 origin ' + ahead + ' 個 commit，可能需要 push。');
  process.exit(0);
}

// 找出哪些 plugin 目錄有改動
const changedPlugins = new Set();
let otherChanges = [];
for (const line of status.split('\n')) {
  const file = line.slice(3);
  const m = file.match(/^plugins\/([^/]+)\//);
  if (m) changedPlugins.add(m[1]);
  else otherChanges.push(file);
}

console.log('== monorepo 待發布狀態 ==');
console.log('  分支: ' + branch + (parseInt(ahead) > 0 ? '（本地領先 ' + ahead + '）' : ''));
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
