#!/usr/bin/env node
'use strict';
/**
 * check-version.js — Phase 0 第一步：正在用的 harness 是不是遠端 repo 上的最新版。
 *
 * 為什麼要這支：實際發生過安裝進行到一半，marketplace 在背景更新出新版，
 * 但 session 用的還是舊版 skill；舊版少了最後一整步（畫流程圖），裝完才被使用者發現，
 * 整輪重做。只印「正在用哪一版」不夠——使用者不會知道那一版是不是舊的，
 * 所以直接去遠端 repo 讀最新版本號來比。
 *
 * 做法：
 *   1. 正在用的版本＝本 plugin 的 .claude-plugin/plugin.json。
 *   2. 從腳本所在路徑認出 marketplace（~/.claude/plugins/cache/<marketplace>/<plugin>/<版本>/…），
 *      到 ~/.claude/plugins/known_marketplaces.json 找它的本機 clone（installLocation）。
 *      直接從原始碼 repo 執行時（維護者開發中），改用腳本所在的 git repo。
 *   3. 在那個 clone 裡 `git fetch origin <預設分支>`（只更新遠端參照，不動工作目錄），
 *      用 `git show FETCH_HEAD:...` 讀遠端的 marketplace.json 與本 plugin 的 plugin.json。
 *   4. 另列本機快取裡比正在用的更新、但還沒啟用的版本（那次事故就是這種狀態）。
 *
 * 用法：node check-version.js
 * exit 0＝已是最新；2＝落後（要停下請使用者更新）；3＝查不到（沒網路、沒 git、不是 git clone），不擋。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');
let own;
try {
  own = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
} catch (e) {
  own = null;
}
if (!own || typeof own !== 'object') {
  console.log('正在用：查不到（本 plugin 的 .claude-plugin/plugin.json 讀不到或不是 JSON 物件）');
  console.log('判定：無法比對，繼續 init，收尾回報要寫「沒有比對到遠端版本」與原因');
  process.exit(3);
}

function git(cwd, args, timeout = 30000) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// SemVer：主.次.修（-預發行標記）。build 標記（+…）不參與比較。
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isVersion(v) {
  return typeof v === 'string' && SEMVER.test(v);
}

// 照 SemVer 規則比：先比主.次.修；相同時，沒有預發行標記的（正式版）比有的新；
// 兩邊都有預發行標記就逐段比，數字段比數值、數字段小於文字段、文字段比字典序、段數多的較新。
function cmp(a, b) {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) {
    const d = BigInt(ma[i]) - BigInt(mb[i]);
    if (d) return d > 0n ? 1 : -1;
  }
  const ra = ma[4];
  const rb = mb[4];
  if (!ra && !rb) return 0;
  if (!ra) return 1;
  if (!rb) return -1;
  const xa = ra.split('.');
  const xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      const d = BigInt(xa[i]) - BigInt(xb[i]);
      if (d) return d > 0n ? 1 : -1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (xa[i] !== xb[i]) {
      return xa[i] < xb[i] ? -1 : 1;
    }
  }
  return 0;
}

function unknown(msg) {
  console.log(`正在用：${own.name} ${own.version}`);
  console.log(`遠端最新：查不到（${msg}）`);
  console.log('判定：無法比對，繼續 init，收尾回報要寫「沒有比對到遠端版本」與原因');
  process.exit(3);
}

if (!isVersion(own.version)) unknown(`本 plugin 的 plugin.json 版本號不是有效的版本格式：${JSON.stringify(own.version)}`);

// 1. 找 repo 位置
let repoDir = null;
let where = '';
const m = pluginRoot.split(path.sep).join('/').match(/\/plugins\/cache\/([^/]+)\/[^/]+\/[^/]+$/);
if (m) {
  const km = path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  try {
    const entry = JSON.parse(fs.readFileSync(km, 'utf8'))[m[1]];
    if (entry && entry.installLocation) repoDir = entry.installLocation;
    where = `marketplace ${m[1]}`;
  } catch (e) {
    unknown(`讀不到 ${km}：${e.message}`);
  }
  if (!repoDir) unknown(`known_marketplaces.json 裡沒有 ${m[1]}`);
} else {
  try {
    repoDir = git(pluginRoot, ['rev-parse', '--show-toplevel']);
    where = '原始碼 repo（不是安裝版）';
  } catch (e) {
    unknown('不在 plugin 快取目錄，也不在 git repo 裡');
  }
}

// 2. 抓遠端最新
let remoteVersion;
let branch;
try {
  // 遠端預設分支直接問遠端（ls-remote --symref），不用本機分支頂替：
  // 本機可能停在開發分支或落後的分支，拿它當「遠端最新」會錯放或錯擋。問不到就算查不到。
  const head = git(repoDir, ['ls-remote', '--symref', 'origin', 'HEAD'], 60000);
  const hm = head.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
  if (!hm) unknown(`${where}：問不到遠端的預設分支（git ls-remote --symref origin HEAD 沒有回 ref 行）`);
  branch = hm[1];
  git(repoDir, ['fetch', '--quiet', 'origin', branch], 60000);
  const mkt = JSON.parse(git(repoDir, ['show', 'FETCH_HEAD:.claude-plugin/marketplace.json']));
  const entry = (mkt.plugins || []).find((p) => p.name === own.name);
  if (!entry) unknown(`遠端 marketplace.json 沒有 ${own.name}`);
  if (typeof entry.source !== 'string') unknown(`遠端 marketplace.json 裡 ${own.name} 的 source 不是 repo 內路徑（${JSON.stringify(entry.source)}），這支腳本只比對同一個 repo 裡的 plugin`);
  const src = entry.source.replace(/^\.\//, '').replace(/\/$/, '');
  remoteVersion = JSON.parse(git(repoDir, ['show', `FETCH_HEAD:${src}/.claude-plugin/plugin.json`])).version;
} catch (e) {
  unknown(`${where}：${(e.stderr || e.message || '').toString().split('\n')[0]}`);
}

if (!isVersion(remoteVersion)) unknown(`遠端 plugin.json 的版本號缺漏或格式不對：${JSON.stringify(remoteVersion)}`);

// 3. 本機快取裡更新但沒啟用的版本
let cached = [];
if (m) {
  const dir = path.dirname(pluginRoot);
  try {
    cached = fs.readdirSync(dir).filter((v) => isVersion(v) && cmp(v, own.version) > 0).sort(cmp);
  } catch (e) { /* 讀不到就不列 */ }
}

console.log(`正在用：${own.name} ${own.version}（${where}）`);
console.log(`遠端最新：${remoteVersion}（${branch} 分支）`);
if (cached.length) console.log(`本機已下載但沒啟用的較新版本：${cached.join('、')}`);
if (cmp(own.version, remoteVersion) < 0) {
  // 下面的指令會由 Claude 用 Bash 執行：名稱只接受英數與 . _ -，不符就印佔位、不組成可執行指令。
  const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
  const mk = m && SAFE_NAME.test(m[1]) ? m[1] : '<marketplace 名稱>';
  if (!SAFE_NAME.test(String(own.name))) {
    console.log('判定：落後，但 plugin.json 的 name 含不允許的字元，不印更新指令：' + JSON.stringify(own.name));
    process.exit(2);
  }
  console.log('判定：落後，停下來；經使用者同意後更新，再請使用者重開 session 重跑 /harness:init');
  console.log(`更新方式（非互動 CLI，使用者同意後 Claude 可直接執行；scope 用 claude plugin list --json 查這筆安裝紀錄）：claude plugin marketplace update ${mk}　→　claude plugin update ${own.name}@${mk} --scope <實際 scope>　→　使用者重開 session`);
  process.exit(2);
}
if (cmp(own.version, remoteVersion) > 0) {
  console.log('判定：已是最新（正在用的比遠端新，通常是維護者在原始碼 repo 開發中、還沒推上去）');
} else {
  console.log('判定：已是最新');
}
process.exit(0);
