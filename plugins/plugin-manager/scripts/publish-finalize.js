#!/usr/bin/env node
/**
 * publish-finalize.js — publish（commit+push）成功後，清掉已發布 plugin 的 dirty 旗標。
 *
 * 為什麼需要：registry 的 dirty=true 由 adopt/bump-version 寫入，代表「已改未推」。
 *   publish 推上 remote 後，這些 plugin 就不再 dirty。但先前沒有腳本做這件事
 *   （SKILL.md 只用文字要求清，靠人手動），導致 dirty 永遠殘留、upgrade-check 誤報。
 *   本腳本把「清 dirty」實作出來，閉合狀態機。
 *
 * 安全前提：只在「工作區乾淨且本地未領先 origin」時才清——確保改動確實已 push。
 *   若工作區仍有未提交改動、或本地領先 origin（還沒 push），則不清、回報原因。
 *
 * 做法（唯讀 git + 改 registry）：
 *   1. 讀 config.monorepo，檢查它是 git repo。
 *   2. git status --short：若非空 → 工作區還有未提交改動 → 不清，回報。
 *   3. git rev-list --count @{u}..HEAD：若 > 0 → 本地領先未 push → 不清，回報。
 *   4. 都通過 → 把 registry.selfMade 裡所有 dirty=true 清成 false。
 *
 * 用法：node publish-finalize.js [--force]
 *   --force：跳過「未 push」檢查（極少用；例如剛 push 完但 upstream 偵測不到）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

// 不用 shell 重導向（Windows cmd.exe 不認 Unix 語法）；回傳 { ok, out }。
function sh(cmd, cwd) {
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).trim() }; }
}

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const configPath = path.join(PM_DIR, 'config.json');
const registryPath = path.join(PM_DIR, 'registry.json');

if (!fs.existsSync(configPath)) die('找不到 config.json（~/.claude/plugin-manager/config.json）。');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const mono = config.monorepo;
if (!mono || !fs.existsSync(path.join(mono, '.git'))) die('monorepo 不是 git repo：' + mono);

if (!fs.existsSync(registryPath)) die('找不到 registry.json。');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

const force = process.argv.includes('--force');

// 1. 工作區必須乾淨
const statusRes = sh('git status --short', mono);
if (!statusRes.ok) die('git status 失敗：' + statusRes.out);
if (statusRes.out) {
  console.log('⚠ 工作區仍有未提交改動，尚未完成 publish——不清 dirty。');
  console.log(statusRes.out);
  process.exit(0);
}

// 2. 必須能驗證「本地未領先 origin」（除非 --force）。
//    rev-list 失敗（無 upstream / upstream 壞 / 無網路）→ 無法證明已 push → fail-safe 拒清，
//    不可當成 0 ahead（那會在「其實沒 push」時誤清 dirty）。
if (!force) {
  const aheadRes = sh('git rev-list --count @{u}..HEAD', mono);
  if (!aheadRes.ok) {
    console.log('⚠ 無法驗證是否已 push（git rev-list 失敗，可能無 upstream）——不清 dirty。');
    console.log('  ' + aheadRes.out);
    console.log('  確定已 push 後可用 --force 強制清。');
    process.exit(0);
  }
  const aheadNum = parseInt(aheadRes.out, 10) || 0;
  if (aheadNum > 0) {
    console.log('⚠ 本地領先 origin ' + aheadNum + ' 個 commit（尚未 push）——不清 dirty。');
    console.log('  請先 push，或確定已 push 後用 --force。');
    process.exit(0);
  }
}

// 3. 清 dirty
const selfMade = registry.selfMade || {};
const cleared = [];
for (const [name, e] of Object.entries(selfMade)) {
  if (e && e.dirty === true) { e.dirty = false; cleared.push(name); }
}

if (!cleared.length) {
  console.log('沒有 dirty=true 的 plugin，registry 已是乾淨狀態。');
  process.exit(0);
}

fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log('✓ 已清 dirty 的 plugin：' + cleared.join(', '));
console.log('  （工作區乾淨且已 push，狀態機閉合）');
