#!/usr/bin/env node
/**
 * update-all.js — 把「這台電腦所有專案（與 user 層）」已安裝的本 marketplace plugin 批次更新到最新版。
 * （使用端功能，對應 /plugin-manager-update；開發端的 bump 版號是 bump-version.js／/plugin-manager-bump。）
 *
 * 流程：
 *   1. 解析 marketplace 名：--marketplace > config.marketplace > monorepo marketplace.json 的 name > 'fulin-plugins'
 *      （同 upgrade-check.js 的 resolveMarketplace；名稱只接受 ^[A-Za-z0-9._-]+$）。
 *   2. `claude plugin marketplace update <mkt> --json` 刷新（--no-refresh 跳過）。
 *   3. 最新版：讀 ~/.claude/plugins/known_marketplaces.json 的 <mkt>.installLocation（刷新後的 marketplace clone），
 *      從它的 .claude-plugin/marketplace.json 找各 plugin 的 source，再讀 <source>/.claude-plugin/plugin.json 的 version。
 *      刻意不讀 monorepo 工作樹：工作樹可能有還沒 publish 的改動，CLI 更新拿到的是 clone 那份。
 *   4. `claude plugin list --json`，挑 id 以 @<mkt> 結尾且 version ≠ 最新版的安裝紀錄，分類：
 *        可更新（user 層、或 project／local 且專案目錄存在）／失效（專案目錄不存在）／
 *        不處理（managed、synced 等腳本不處理的 scope）／無法判定最新版。
 *   5. 預設 dry-run：只印表，exit 0，不改任何東西。
 *   6. --apply：逐筆在 projectPath（user 層用家目錄）下跑 `claude plugin update <id> --scope <scope> --json`
 *      （execFileSync，不經 shell）。全部跑完重新 list 比對版本；仍落後且屬「巢狀」
 *      （同 id 另有 project 安裝的 projectPath 在它底下）的 project 安裝 → 記下 <proj>/.claude/settings.json 與
 *      settings.local.json 的位元組 → uninstall --keep-data ＋ install → 再比對設定檔：有變印差異並標「需人工確認」
 *      （不自動還原），沒變才算補救成功。最後印總表。
 *   7. 失效紀錄只列出；--prune-missing <id>@<path> 逐筆移除（見下方 pruneMissing 的說明與實測依據）。
 *
 * 用法：
 *   node update-all.js [--apply] [--no-refresh] [--only a,b] [--json] [--marketplace <name>]
 *   node update-all.js --prune-missing <name@mkt>@<專案路徑>
 *
 * 結束提醒：CLI 更新後要重開該專案的 Claude Code session 才生效（這步 Claude 做不到）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const HANDLED_SCOPES = ['user', 'project', 'local'];

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

// ---------- 參數 ----------
const argv = process.argv.slice(2);
const opt = { apply: false, refresh: true, only: null, json: false, marketplace: null, pruneMissing: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--apply') opt.apply = true;
  else if (a === '--no-refresh') opt.refresh = false;
  else if (a === '--json') opt.json = true;
  else if (a === '--only') { const v = argv[++i]; if (!v) die('--only 要接 plugin 名（逗號分隔）'); opt.only = v.split(',').map((s) => s.trim()).filter(Boolean); }
  else if (a === '--marketplace') { opt.marketplace = argv[++i]; if (!opt.marketplace) die('--marketplace 要接名稱'); }
  else if (a === '--prune-missing') { opt.pruneMissing = argv[++i]; if (!opt.pruneMissing) die('--prune-missing 要接 <name@mkt>@<專案路徑>'); }
  else if (a === '-h' || a === '--help') {
    console.log('用法：node update-all.js [--apply] [--no-refresh] [--only a,b] [--json] [--marketplace <name>]');
    console.log('      node update-all.js --prune-missing <name@mkt>@<專案路徑>');
    console.log('預設 dry-run（只列表、不改任何東西）；--apply 才真的更新。');
    process.exit(0);
  } else die('不認得的參數：' + a);
}
if (opt.only) for (const n of opt.only) if (!SAFE_NAME.test(n)) die('--only 的 plugin 名含不允許的字元：' + JSON.stringify(n));

// ---------- 工具 ----------
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function normPath(p) {
  const r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
// SemVer 比較；回 -1／0／1，任一邊不是版本號回 null。
// 主.次.修比數值；相同時正式版比預發行新；預發行逐段比：數字段比數值、數字段小於文字段、文字段比字典序、段數多的較新。build（+…）不參與。
function cmpVer(a, b) {
  const re = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  const x = re.exec(String(a || '')); const y = re.exec(String(b || ''));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) { const d = BigInt(x[i]) - BigInt(y[i]); if (d) return d > 0n ? 1 : -1; }
  const ra = x[4]; const rb = y[4];
  if (!ra && !rb) return 0;
  if (!ra) return 1;
  if (!rb) return -1;
  const pa = ra.split('.'); const pb = rb.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]); const nb = /^\d+$/.test(pb[i]);
    if (na && nb) { const d = BigInt(pa[i]) - BigInt(pb[i]); if (d) return d > 0n ? 1 : -1; }
    else if (na !== nb) return na ? -1 : 1;
    else if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
function isUnder(child, parent) { // child 嚴格在 parent 底下
  const c = normPath(child); const p = normPath(parent);
  return c !== p && c.startsWith(p + '/');
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function short(s) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > 200 ? s.slice(0, 200) + '…' : s; }

// 跑 claude CLI（不經 shell）。回 { ok, stdout, stderr, json, error }
function runClaude(args, cwd, timeout) {
  try {
    const stdout = execFileSync('claude', args, { cwd, encoding: 'utf8', timeout: timeout || 300000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return { ok: true, stdout, stderr: '', json: lastJsonLine(stdout) };
  } catch (e) {
    const stdout = e.stdout ? String(e.stdout) : '';
    const stderr = e.stderr ? String(e.stderr) : '';
    return { ok: false, stdout, stderr, json: lastJsonLine(stdout), error: e.message };
  }
}
function lastJsonLine(out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) { try { return JSON.parse(lines[i]); } catch (e) { /* 下一行 */ } }
  }
  return null;
}
function listInstalls() {
  const r = runClaude(['plugin', 'list', '--json'], os.homedir(), 120000);
  if (!r.ok) die('claude plugin list --json 失敗：' + short(r.stderr || r.error));
  let a;
  try { a = JSON.parse(r.stdout); } catch (e) { die('claude plugin list --json 輸出不是 JSON：' + short(r.stdout)); }
  if (!Array.isArray(a)) die('claude plugin list --json 不是陣列');
  return a;
}

// ---------- 1. marketplace 名 ----------
const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
const config = readJsonSafe(path.join(PM_DIR, 'config.json')) || {};
function resolveMarketplace() {
  if (opt.marketplace) return opt.marketplace;
  if (config.marketplace) return config.marketplace;
  try {
    const mpPath = path.join(config.monorepo || '', '.claude-plugin', 'marketplace.json');
    if (config.monorepo && fs.existsSync(mpPath)) {
      const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
      if (mp && mp.name) return mp.name;
    }
  } catch (e) { /* fallback */ }
  return 'fulin-plugins';
}
const MKT = resolveMarketplace();
if (!SAFE_NAME.test(MKT)) die('marketplace 名稱含不允許的字元（只接受英數與 . _ -）：' + JSON.stringify(MKT));

// ---------- --prune-missing ----------
// 實測依據（2026-10-11，Claude Code 2.1.296，scratchpad 暫存安裝）：project 安裝紀錄的專案目錄不在時，
// 在別的目錄跑 `claude plugin uninstall <id> --scope project` 不會作用到它；
// 在「原路徑重建一個空目錄」後於該目錄下跑 uninstall --scope project --keep-data，紀錄會被移除。
// 所以這裡的做法是：確認路徑真的不存在 → 建空目錄 → 在裡面跑 uninstall → 刪掉剛建的空目錄（只刪本次建立的部分）。
if (opt.pruneMissing) {
  const s = opt.pruneMissing;
  const a1 = s.indexOf('@'); const a2 = a1 >= 0 ? s.indexOf('@', a1 + 1) : -1;
  if (a1 < 0 || a2 < 0) die('--prune-missing 格式是 <name@mkt>@<專案路徑>，收到：' + s);
  const id = s.slice(0, a2); const proj = s.slice(a2 + 1);
  const [pname, pmkt] = id.split('@');
  if (!SAFE_NAME.test(pname) || !SAFE_NAME.test(pmkt)) die('plugin id 含不允許的字元：' + id);
  if (!path.isAbsolute(proj)) die('專案路徑要是絕對路徑：' + proj);
  const beforeList = listInstalls();
  const rec = beforeList.find((p) => p && p.id === id && (p.scope === 'project' || p.scope === 'local') && p.projectPath && normPath(p.projectPath) === normPath(proj));
  if (!rec) die('找不到這筆安裝紀錄（claude plugin list --json 裡沒有 ' + id + ' 在 ' + proj + ' 的 project／local 安裝）');
  if (fs.existsSync(proj)) die('專案路徑存在，不是失效紀錄；要移除請直接在該目錄跑 claude plugin uninstall ' + id + ' --scope ' + rec.scope + ' --keep-data');
  // 記下要建的最上層目錄，事後只刪這一段
  if (!fs.existsSync(path.parse(proj).root)) die('專案路徑所在的磁碟機不存在（' + path.parse(proj).root + '），無法暫建目錄來移除；這筆要等磁碟機接回再處理');
  let top = proj;
  while (path.dirname(top) !== top && !fs.existsSync(path.dirname(top))) top = path.dirname(top);
  fs.mkdirSync(proj, { recursive: true });
  let r;
  try {
    r = runClaude(['plugin', 'uninstall', id, '--scope', rec.scope, '--keep-data', '--json'], proj);
  } finally {
    // 只刪本次建立的空目錄；CLI 若在裡面留了檔（例如 .claude/settings.json）也一併刪，因為這目錄原本就不存在
    try { fs.rmSync(top, { recursive: true, force: true }); } catch (e) { console.error('⚠ 暫建目錄沒刪乾淨，請手動刪：' + top); }
  }
  const afterList = listInstalls();
  const key = (p) => p.id + '|' + p.scope + '|' + (p.projectPath ? normPath(p.projectPath) : '');
  const afterKeys = new Set(afterList.filter(Boolean).map(key));
  const removed = beforeList.filter((p) => p && !afterKeys.has(key(p)));
  const still = afterKeys.has(key(rec));
  const extra = removed.filter((p) => key(p) !== key(rec));
  console.log((still ? '✗ 仍在：' : '✓ 已移除：') + id + '（' + rec.scope + '）' + proj);
  if (!r.ok || still) console.log('  CLI 輸出：' + short(r.stdout + ' ' + r.stderr));
  if (extra.length) {
    console.log('⚠ 另外還有安裝紀錄一起消失（不是本次指定的），請確認並視需要裝回：');
    for (const p of extra) console.log('  - ' + p.id + ' ' + p.scope + ' ' + (p.projectPath || '(user 層)') + '   裝回：在該目錄跑 claude plugin install ' + p.id + ' --scope ' + p.scope);
  }
  process.exit(still || extra.length ? 1 : 0);
}

// ---------- 2. 刷新 marketplace ----------
let refreshNote = '略過（--no-refresh）';
if (opt.refresh) {
  const r = runClaude(['plugin', 'marketplace', 'update', MKT, '--json'], os.homedir());
  refreshNote = r.ok ? 'ok' : '失敗：' + short((r.stdout + ' ' + r.stderr).trim() || String(r.error || ''));
  if (!r.ok) {
    console.error('⚠ marketplace 刷新失敗，以下用目前 clone 裡的版本判斷（可能過期）：' + short((r.stdout + ' ' + r.stderr).trim() || String(r.error || '')));
    // 用過期的 clone 去 --apply 會照舊資料更新；刷新失敗就不更新。確定要用目前 clone 時明確加 --no-refresh。
    if (opt.apply) die('marketplace 刷新失敗，不執行 --apply。排除後重跑；確定要用目前 clone 的版本就加 --no-refresh。');
  }
}

// ---------- 3. 最新版（從 marketplace clone 讀） ----------
const known = readJsonSafe(path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json')) || {};
const mktInfo = known[MKT];
if (!mktInfo || !mktInfo.installLocation) die('known_marketplaces.json 沒有 ' + MKT + ' 的 installLocation（這台電腦沒加過這個 marketplace？）');
const mktRoot = mktInfo.installLocation;
const mktJson = readJsonSafe(path.join(mktRoot, '.claude-plugin', 'marketplace.json'));
if (!mktJson || !Array.isArray(mktJson.plugins)) die('讀不到 marketplace clone 的 marketplace.json：' + path.join(mktRoot, '.claude-plugin', 'marketplace.json'));
const latest = {}; // name -> version | null
const pluginRoot = (mktJson.metadata && mktJson.metadata.pluginRoot) || '';
for (const p of mktJson.plugins) {
  if (!p || !p.name) continue;
  let ver = null;
  if (typeof p.source === 'string') {
    const src = p.source.startsWith('./') || p.source.startsWith('../') ? p.source : path.join(pluginRoot, p.source);
    const pj = readJsonSafe(path.join(mktRoot, src, '.claude-plugin', 'plugin.json'));
    if (pj && pj.version) ver = String(pj.version);
  }
  if (!ver && p.version) ver = String(p.version); // 外部來源（github 等）只能靠 marketplace 條目自帶的 version
  latest[p.name] = ver;
}

// ---------- 4. 分類 ----------
function classify(installs) {
  const rows = [];
  let upToDate = 0;
  for (const p of installs) {
    if (!p || typeof p.id !== 'string' || !p.id.endsWith('@' + MKT)) continue;
    const name = p.id.slice(0, p.id.length - MKT.length - 1);
    if (opt.only && !opt.only.includes(name)) continue;
    const base = { id: p.id, name, scope: p.scope, projectPath: p.projectPath || null, oldVersion: p.version || null, latest: latest[name] };
    if (!(name in latest)) { rows.push(Object.assign(base, { category: 'unknown', note: 'marketplace 已沒有這個 plugin' })); continue; }
    if (!latest[name]) { rows.push(Object.assign(base, { category: 'unknown', note: '讀不到最新版號' })); continue; }
    if ((p.scope === 'project' || p.scope === 'local') && p.projectPath && !isDir(p.projectPath)) { rows.push(Object.assign(base, { category: 'missing', note: '專案目錄不存在' })); continue; }
    if (p.version === latest[name]) { upToDate++; continue; }
    const c = cmpVer(p.version, latest[name]);
    if (c === 0) { upToDate++; continue; } // 只差 build 標記（+…）視為相同
    if (c === null) { rows.push(Object.assign(base, { category: 'unknown', note: '版本號無法比較（' + p.version + ' vs ' + latest[name] + '）' })); continue; }
    if (c > 0) { rows.push(Object.assign(base, { category: 'ahead', note: '已裝的比 marketplace 新，不動（避免降版）' })); continue; }
    if (!HANDLED_SCOPES.includes(p.scope)) { rows.push(Object.assign(base, { category: 'skipped', note: 'scope ' + p.scope + ' 由系統管理，腳本不處理' })); continue; }
    if (p.scope === 'user') { rows.push(Object.assign(base, { category: 'updatable', cwd: os.homedir() })); continue; }
    if (!p.projectPath) { rows.push(Object.assign(base, { category: 'unknown', note: '缺 projectPath' })); continue; }
    if (!isDir(p.projectPath)) { rows.push(Object.assign(base, { category: 'missing', note: '專案目錄不存在' })); continue; }
    rows.push(Object.assign(base, { category: 'updatable', cwd: p.projectPath }));
  }
  return { rows, upToDate };
}

const CAT_LABEL = { updatable: '可更新', missing: '失效（目錄不存在）', ahead: '比 marketplace 新（不動）', skipped: '不處理', unknown: '無法判定' };
function printPlanTable(rows) {
  const order = ['updatable', 'missing', 'ahead', 'skipped', 'unknown'];
  for (const cat of order) {
    const rs = rows.filter((r) => r.category === cat);
    if (!rs.length) continue;
    console.log('\n[' + CAT_LABEL[cat] + '] ' + rs.length + ' 筆');
    for (const r of rs) {
      console.log('  - ' + r.name.padEnd(16) + ' ' + String(r.scope).padEnd(8) + ' ' + String(r.oldVersion) + ' → ' + (r.latest || '-') +
        '   ' + (r.scope === 'user' ? '(user 層)' : (r.projectPath || '')) + (r.note ? '   # ' + r.note : ''));
    }
  }
}

const installs0 = listInstalls();
const plan = classify(installs0);

if (!opt.apply) {
  if (opt.json) {
    console.log(JSON.stringify({ mode: 'dry-run', marketplace: MKT, marketplaceClone: mktRoot, refresh: refreshNote, latest, upToDate: plan.upToDate, rows: plan.rows }, null, 2));
    process.exit(0);
  }
  console.log('== /plugin-manager-update（dry-run，不改任何東西）==');
  console.log('  marketplace : ' + MKT + '（刷新：' + refreshNote + '）');
  console.log('  最新版來源  : ' + mktRoot);
  if (opt.only) console.log('  只看        : ' + opt.only.join(', '));
  console.log('  已是最新    : ' + plan.upToDate + ' 筆');
  if (!plan.rows.length) { console.log('\n沒有落後的安裝。'); process.exit(0); }
  printPlanTable(plan.rows);
  const n = plan.rows.filter((r) => r.category === 'updatable').length;
  if (n) console.log('\n下一步：核可後加 --apply 更新上面「可更新」的 ' + n + ' 筆（逐筆在該專案目錄下跑 claude plugin update）。');
  else console.log('\n沒有可更新的安裝；上面列的是要你知道或決定的紀錄。');
  printMissingHelp(plan.rows);
  process.exit(0);
}

function printMissingHelp(rows) {
  const miss = rows.filter((r) => r.category === 'missing');
  if (!miss.length) return;
  console.log('\n失效紀錄（專案目錄已不存在）只列出、不動。要移除就逐筆指定：');
  for (const r of miss) console.log('  node update-all.js --prune-missing ' + r.id + '@' + r.projectPath);
  console.log('  （做法：在原路徑暫建空目錄 → 於其中跑 claude plugin uninstall --scope <該筆的 scope：' + Array.from(new Set(miss.map((r) => r.scope))).join('／') + '> --keep-data → 刪掉暫建目錄。）');
}

// ---------- 6. --apply ----------
const todo = plan.rows.filter((r) => r.category === 'updatable');
if (!opt.json) {
  console.log('== /plugin-manager-update --apply ==');
  console.log('  marketplace : ' + MKT + '（刷新：' + refreshNote + '）');
  console.log('  要更新      : ' + todo.length + ' 筆');
}
for (const r of todo) {
  const res = runClaude(['plugin', 'update', r.id, '--scope', r.scope, '--json'], r.cwd);
  const j = res.json || {};
  r.cli = { ok: res.ok && j.outcome === 'ok', outcome: j.outcome || null, updateOutcome: j.updateOutcome || null, raw: short(res.stdout + ' ' + res.stderr) };
  if (!opt.json) console.log('  · ' + r.name + ' ' + r.scope + ' ' + (r.scope === 'user' ? '(user 層)' : r.projectPath) + ' → ' + (r.cli.ok ? (j.updateOutcome || 'ok') : '失敗'));
}

function findInstall(list, r) {
  return list.find((p) => p && p.id === r.id && p.scope === r.scope &&
    (r.scope === 'user' ? true : (p.projectPath && normPath(p.projectPath) === normPath(r.projectPath))));
}
function readBytes(p) { try { return fs.readFileSync(p); } catch (e) { return null; } }
function snapshotSettings(proj) {
  const out = {};
  for (const f of ['settings.json', 'settings.local.json']) out[f] = readBytes(path.join(proj, '.claude', f));
  return out;
}
function diffSettings(before, after) {
  const diffs = [];
  for (const f of Object.keys(before)) {
    const a = before[f]; const b = after[f];
    if (a === null && b === null) continue;
    if (a !== null && b !== null && Buffer.compare(a, b) === 0) continue;
    const al = a === null ? [] : a.toString('utf8').split(/\r?\n/);
    const bl = b === null ? [] : b.toString('utf8').split(/\r?\n/);
    const lines = [];
    if (a === null) lines.push('  (原本不存在，現在被建立)');
    if (b === null) lines.push('  (原本存在，現在被刪除)');
    for (const l of al) if (!bl.includes(l)) lines.push('  - ' + l);
    for (const l of bl) if (!al.includes(l)) lines.push('  + ' + l);
    if (!lines.length) lines.push('  （只有行序／換行字元不同）');
    diffs.push({ file: f, lines });
  }
  return diffs;
}

let after = listInstalls();
for (const r of todo) {
  const now = findInstall(after, r);
  r.newVersion = now ? now.version : null;
  if (!r.cli.ok) { r.result = 'failed'; continue; }
  if (r.newVersion === r.latest) { r.result = r.cli.updateOutcome === 'up_to_date' ? 'up_to_date' : 'updated'; continue; }
  r.result = 'still-behind';
}

// 巢狀補救：仍落後的 project 安裝，且同 id 另有 project 安裝在它底下或上層（CLI 可能拿另一筆比對而回 up_to_date；兩種排列都實測過）
for (const r of todo) {
  if (r.result !== 'still-behind' || r.scope !== 'project') continue;
  const nested = after.filter((p) => p && p.id === r.id && p.scope === 'project' && p.projectPath && (isUnder(p.projectPath, r.projectPath) || isUnder(r.projectPath, p.projectPath)));
  if (!nested.length) continue;
  r.nestedOthers = nested.map((p) => p.projectPath);
  const before = snapshotSettings(r.projectPath);
  const un = runClaude(['plugin', 'uninstall', r.id, '--scope', 'project', '--keep-data', '--json'], r.projectPath);
  if (!un.ok) { r.result = 'failed'; r.cli.raw = 'uninstall 失敗：' + short(un.stdout + ' ' + un.stderr); continue; }
  const ins = runClaude(['plugin', 'install', r.id, '--scope', 'project', '--json'], r.projectPath);
  if (!ins.ok) {
    r.result = 'failed';
    r.cli.raw = '⚠ 已 uninstall 但 install 失敗，這個專案目前沒有裝 ' + r.name + '；請在 ' + r.projectPath + ' 跑 claude plugin install ' + r.id + ' --scope project。CLI：' + short(ins.stdout + ' ' + ins.stderr);
    continue;
  }
  const diffs = diffSettings(before, snapshotSettings(r.projectPath));
  r.reinstall = true;
  if (diffs.length) { r.result = 'needs-review'; r.settingsDiff = diffs; }
  else r.result = 'reinstalled-pending'; // 版本待最後 list 確認
}
if (todo.some((r) => r.reinstall)) {
  after = listInstalls();
  for (const r of todo) {
    if (!r.reinstall) continue;
    const now = findInstall(after, r);
    r.newVersion = now ? now.version : null;
    if (r.result === 'reinstalled-pending') r.result = r.newVersion === r.latest ? 'reinstalled' : 'still-behind';
  }
}

// ---------- 總表 ----------
// 結束碼：1＝有失敗；3＝沒有失敗但有仍落後或需人工確認；0＝全部完成
function exitCode() {
  if (todo.some((r) => r.result === 'failed')) return 1;
  if (todo.some((r) => r.result === 'still-behind' || r.result === 'needs-review')) return 3;
  return 0;
}
const RES_LABEL = { updated: 'updated', up_to_date: 'up_to_date', reinstalled: 'reinstalled（巢狀補救）', 'needs-review': '需人工確認（重裝後設定檔有變）', 'still-behind': '仍落後', failed: '失敗' };
const restart = [];
for (const r of todo) {
  if (['updated', 'reinstalled', 'needs-review'].includes(r.result)) {
    const where = r.scope === 'user' ? '(user 層：所有專案)' : r.projectPath;
    if (!restart.includes(where)) restart.push(where);
  }
}
if (opt.json) {
  console.log(JSON.stringify({ mode: 'apply', marketplace: MKT, refresh: refreshNote, rows: plan.rows, restart }, null, 2));
  process.exit(exitCode());
}
console.log('\n== 總表 ==');
for (const key of ['updated', 'up_to_date', 'reinstalled', 'needs-review', 'still-behind', 'failed']) {
  const rs = todo.filter((r) => r.result === key);
  if (!rs.length) continue;
  console.log('\n[' + RES_LABEL[key] + '] ' + rs.length + ' 筆');
  for (const r of rs) {
    console.log('  - ' + r.name.padEnd(16) + ' ' + r.scope.padEnd(8) + ' ' + r.oldVersion + ' → ' + (r.newVersion || '?') + '（最新 ' + r.latest + '）  ' + (r.scope === 'user' ? '(user 層)' : r.projectPath));
    if (r.nestedOthers) console.log('      巢狀：同 plugin 另有安裝在 ' + r.nestedOthers.join('、'));
    if (r.settingsDiff) for (const d of r.settingsDiff) { console.log('      .claude/' + d.file + ' 有變：'); for (const l of d.lines) console.log('      ' + l); }
    if (key === 'failed' || key === 'still-behind') console.log('      CLI：' + r.cli.raw);
  }
}
const others = plan.rows.filter((r) => r.category !== 'updatable');
if (others.length) { console.log('\n未處理的紀錄：'); printPlanTable(others); }
printMissingHelp(plan.rows);
if (restart.length) {
  console.log('\n⚠ 下列位置的 Claude Code session 要重開，新版才會生效（這步要你自己做）：');
  for (const w of restart) console.log('  - ' + w);
}
process.exit(exitCode());
