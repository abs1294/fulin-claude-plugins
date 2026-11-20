'use strict';
// The other plugins of this marketplace, as one picture: what is installed where, what each has waiting for you, and
// what can be done from here. For the board's "外掛" page.
//
// Everything is read from what Claude Code and the plugins themselves keep on disk, or asked of the plugins' own
// tools; nothing of theirs is written by the board, except through those tools when you press a button:
//   installed and where          ~/.claude/plugins/installed_plugins.json (Claude Code's own record)
//   out of date                  plugin-manager: scripts/update-all.js --json --no-refresh (read only, 1 s, no network)
//   changed and not published    plugin-manager: scripts/publish-status.js (read only; only where the monorepo is set up)
//   goal2                        lib/goal2.js (goal.js --list)
//   harness                      lib/harness.js (its files in each project that has it)
//   daily report                 deliver-report: <project>/.claude/daily-report.json, ~/.claude/daily-report/sent/
//   self-heal                    its switch: the file ~/.claude/self-heal.off (there = off)
//   commits not pushed           git, in the folders the board knows
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MKT = '@fulin-plugins';
const HOME = () => os.homedir();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const vcmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true });

// -> {name: {versions: [...], newest, root, description, installs: [{scope, project}]}}
function installed(file = path.join(HOME(), '.claude', 'plugins', 'installed_plugins.json')) {
  const j = readJson(file); const out = {};
  for (const [id, list] of Object.entries((j && j.plugins) || {})) {
    if (!id.endsWith(MKT) || !Array.isArray(list)) continue;
    const name = id.slice(0, -MKT.length);
    const newest = list.slice().sort((a, b) => vcmp(b.version, a.version))[0] || {};
    const pj = readJson(path.join(newest.installPath || '', '.claude-plugin', 'plugin.json')) || {};
    out[name] = { name, newest: newest.version || '', root: newest.installPath || '', description: String(pj.description || ''), installs: list.map((e) => ({ scope: e.scope, project: e.projectPath || '', version: e.version })) };
  }
  return out;
}

// A plugin's folder: beside this one (the monorepo), else where Claude Code installed it.
function rootOf(name, inst, here = path.join(__dirname, '..')) {
  const sib = path.join(here, '..', name);
  if (fs.existsSync(path.join(sib, '.claude-plugin', 'plugin.json'))) return sib;
  return inst[name] && inst[name].root ? inst[name].root : null;
}

// What plugin-manager's `update-all.js --apply --json` did, in one line. Its JSON has no summary of its own: rows (one
// per install; result updated / up_to_date / reinstalled / needs-review / still-behind / failed) and restart (the places
// whose Claude Code sessions need starting again). Its exit: 0 all done, 3 nothing failed but something is still behind
// or needs a look, 1 something failed. -> {ok, summary, error, restart}
function updateResult(stdout, status, stderr) {
  let j = null; try { j = JSON.parse(stdout); } catch (e) {}
  if (!j) return { ok: false, summary: '', error: String(stderr || stdout || '').trim().slice(-400) || 'exit ' + status, restart: [] };
  const rows = (j.rows || []).filter((r) => r && r.result);
  const of = (...k) => rows.filter((r) => k.includes(r.result));
  const group = (rs) => { const m = new Map(); for (const r of rs) { const k = r.name + ' ' + (r.oldVersion || '?') + ' → ' + (r.newVersion || r.latest || '?'); m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([k, n]) => k + (n > 1 ? '（' + n + ' 處）' : '')).join('、'); };
  const parts = [];
  if (of('updated', 'reinstalled').length) parts.push('更新了 ' + group(of('updated', 'reinstalled')));
  if (of('needs-review').length) parts.push('更新了但要你看一下設定檔 ' + group(of('needs-review')));
  if (of('still-behind').length) parts.push('仍落後 ' + group(of('still-behind')));
  if (of('failed').length) parts.push('失敗 ' + group(of('failed')));
  const restart = Array.isArray(j.restart) ? j.restart : [];
  const ok = status === 0 || status === 3;
  return { ok, summary: parts.join('；'), error: ok ? '' : parts.join('；') || String(stderr || '').trim().slice(-400) || 'exit ' + status, restart };
}

const run = (file, args, o = {}) => new Promise((resolve) => {
  (o.run || execFile)(o.exe || process.execPath, [file].concat(args), { cwd: o.cwd, windowsHide: true, timeout: o.timeout || 30000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: o.env || process.env },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
});

// plugin-manager's view: which installs are behind, and (on the developer's machine) what is changed and not published.
async function pluginManager(inst, o = {}) {
  const root = rootOf('plugin-manager', inst, o.here);
  if (!root) return { installed: false };
  const r = await run(path.join(root, 'scripts', 'update-all.js'), ['--json'].concat(o.refresh ? [] : ['--no-refresh']), { run: o.run, timeout: o.refresh ? 120000 : 30000 });
  let u = null; try { u = JSON.parse(r.out); } catch (e) {}
  const behind = {};
  for (const row of (u && u.rows) || []) if (row.category === 'updatable') { const b = behind[row.name] || (behind[row.name] = { name: row.name, from: new Set(), to: row.latest, where: [] }); b.from.add(row.oldVersion); b.where.push(row.projectPath || '(使用者層)'); }
  const p = await run(path.join(root, 'scripts', 'publish-status.js'), [], { run: o.run });
  const changed = (/改動的 plugin:\s*(.+)/.exec(p.out) || [])[1];
  const ahead = (/本地領先\s*(\d+)/.exec(p.out) || [])[1];
  return {
    installed: true, checked: !!u, error: u ? '' : (r.err || r.out).trim().slice(-300), latest: (u && u.latest) || {}, upToDate: (u && u.upToDate) || 0,
    behind: Object.values(behind).map((b) => ({ name: b.name, from: [...b.from].join('、'), to: b.to, count: b.where.length, where: b.where })),
    unpublished: changed && !/無|none/i.test(changed) ? changed.split(/[,，、]\s*/).map((x) => x.trim()).filter(Boolean) : [], aheadOfRemote: Number(ahead) || 0,
  };
}

// The daily report of deliver-report: which projects have it switched on, when one was last sent.
function dailyReport(inst) {
  const projects = ((inst['deliver-report'] && inst['deliver-report'].installs) || []).map((x) => x.project).filter(Boolean);
  const on = [...new Set(projects)].filter((p) => fs.existsSync(path.join(p, '.claude', 'daily-report.json')));
  let sent = []; try { sent = fs.readdirSync(path.join(HOME(), '.claude', 'daily-report', 'sent')).filter((n) => /^\d{4}-\d{2}-\d{2}/.test(n)).sort(); } catch (e) {}
  const could = [...new Set(projects)].filter((p) => !on.includes(p) && fs.existsSync(p));
  return { installed: !!inst['deliver-report'], projects: on, could, credentials: fs.existsSync(path.join(HOME(), '.claude', 'daily-report', 'config.json')), lastSent: sent.length ? sent[sent.length - 1].slice(0, 10) : '' };
}

// Switches the daily report on for a project: its .claude/daily-report.json, the way deliver-report's own template has
// it - who it goes to, and require_approval true (nothing is sent until you say so in the conversation), no schedule.
// An existing file is never overwritten. -> {ok, file?, error?}
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
function enableDaily(project, recipients, cc) {
  if (!Array.isArray(recipients) || (cc !== undefined && cc !== null && !Array.isArray(cc))) return { ok: false, error: '收件人與副本要是清單' };
  const to = (recipients || []).map((x) => String(x).trim()).filter(Boolean), copy = (cc || []).map((x) => String(x).trim()).filter(Boolean);
  if (!to.length) return { ok: false, error: '至少要一個收件人' };
  const bad = to.concat(copy).filter((x) => !EMAIL.test(x));
  if (bad.length) return { ok: false, error: '這些不像信箱：' + bad.join('、') };
  const file = path.join(project, '.claude', 'daily-report.json');
  if (fs.existsSync(file)) return { ok: false, error: '這個專案已經有日報設定了，看板不覆蓋：' + file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ recipients: to, cc: copy, subject_prefix: '[專案日報]', confirm_wait_minutes: 30, require_approval: true, schedule: { enabled: false } }, null, 2) + '\n');
  return { ok: true, file };
}

// Commits made and not pushed, and changes not committed, in each git repository among the given folders.
async function gitRepos(folders, o = {}) {
  const git = (cwd, args) => new Promise((resolve) => (o.run || execFile)('git', ['-C', cwd].concat(args), { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (e, out) => resolve(e ? null : String(out || '').trim())));
  const seen = new Map();
  for (const f of folders) {
    if (seen.size >= 40) break;
    const top = await git(f, ['rev-parse', '--show-toplevel']); if (!top) continue;
    const key = path.normalize(top).toLowerCase(); if (seen.has(key)) continue;
    const [ahead, dirty, branch] = await Promise.all([git(top, ['rev-list', '--count', '@{u}..HEAD']), git(top, ['status', '--porcelain']), git(top, ['rev-parse', '--abbrev-ref', 'HEAD'])]);
    seen.set(key, { root: path.normalize(top), name: path.basename(top), branch: branch || '', unpushed: ahead == null ? null : Number(ahead) || 0, uncommitted: dirty == null ? 0 : dirty.split('\n').filter(Boolean).length });
  }
  return [...seen.values()].filter((r) => r.unpushed || r.uncommitted).sort((a, b) => (b.unpushed || 0) - (a.unpushed || 0) || b.uncommitted - a.uncommitted);
}

const selfHealOff = () => path.join(HOME(), '.claude', 'self-heal.off');
function setSelfHeal(on) {
  const f = selfHealOff();
  if (on) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, error: String(e.message) }; } }
  else fs.writeFileSync(f, 'switched off from session-board ' + new Date().toISOString() + '\n');
  return { ok: true, on: !fs.existsSync(f) };
}

// The integrations the board has, and the plugin each belongs to. `git` needs no plugin (it is plain git).
const INTEGRATIONS = [
  { key: 'goal2', plugin: 'goal2', name: 'goal2', what: '排程頁的 goal 執行紀錄、排程交給 goal2、外掛頁的交辦' },
  { key: 'harness', plugin: 'harness', name: 'harness', what: '辦公室房間的 harness 狀態、待核可項目、健檢' },
  { key: 'versions', plugin: 'plugin-manager', name: '版本檢查（plugin-manager）', what: '哪些 plugin 有新版、一鍵全部更新、改了還沒發布的' },
  { key: 'git', plugin: '', name: 'git', what: '看板知道的資料夾裡，沒 push、沒 commit 的（外掛頁與辦公室房間）' },
  { key: 'daily', plugin: 'deliver-report', name: '日報（deliver-report）', what: '哪些專案啟用日報、上次寄出' },
  { key: 'selfHeal', plugin: 'self-heal', name: 'self-heal', what: 'self-heal 的開關' },
  { key: 'qa', plugin: 'qa-webwright', name: 'qa-webwright', what: '辦公室房間顯示那個專案最近幾次瀏覽器測試的結果' },
  { key: 'cbm', plugin: 'cbm-guard', name: 'cbm-guard', what: '辦公室房間顯示程式碼索引有沒有過期，過期可以一鍵重建' },
];
// -> {key: {on, installed, name, what}}: on where installed. There is no switch of its own any more (asked 2026-11-20:
// "installed means shown; it goes by each folder, not one switch for all") - a room shows what its folder has
// (server.js roomFacts, lib/pluginfit.js installedFor).
function integrations(inst) {
  const out = {};
  for (const x of INTEGRATIONS) { const installed = !x.plugin || !!inst[x.plugin]; out[x.key] = { on: installed, installed, name: x.name, what: x.what, plugin: x.plugin }; }
  return out;
}
module.exports = { enableDaily, INTEGRATIONS, integrations, installed, rootOf, updateResult, pluginManager, dailyReport, gitRepos, setSelfHeal, selfHealOff, MKT };
