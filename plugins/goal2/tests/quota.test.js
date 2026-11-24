#!/usr/bin/env node
// goal2 的額度重置時間（lib/quota.js 與 delaylocal.js 第 3 步）回歸測試。
// Run: node plugins/goal2/tests/quota.test.js
//
// 對應使用者 2026-11-24 的兩條裁定：①沒有 5 小時視窗就改等 7 天額度 ②沒裝或太舊的 cc-statusline 擋下並提示安裝，
// 不退回讀 rate-limit-snapshots.json。用假的使用者目錄（USERPROFILE／HOME 指到暫存目錄），不碰真實的額度檔。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const Q = require('../lib/quota.js');
const DELAY = path.resolve(__dirname, '..', 'skills', 'delaylocal', 'delaylocal.js');
let pass = 0, fail = 0;
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  -> ' + detail)); };

const NOW = 1_800_000_000;              // 固定的「現在」（秒）
const AT = (NOW - 120) * 1000;          // 2 分鐘前查的
const homes = [];
function mkHome({ limits, installed, snapshots, legacy }) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'g2q-')); homes.push(h);
  const w = (rel, v) => { const p = path.join(h, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
  // 額度檔現在要帶介面版本 v（cc-statusline 1.9.0 起）；夾具預設補上 v:1，測舊檔要明確帶 legacy:true
  if (limits && typeof limits === 'object' && !legacy && !('v' in limits)) limits = { v: 1, ...limits };
  if (limits !== undefined) w('.claude/cc-statusline/state/account-limits.json', limits);
  if (installed !== undefined) w('.claude/plugins/installed_plugins.json', { plugins: installed });
  if (snapshots !== undefined) w('.claude/rate-limit-snapshots.json', snapshots);
  return h;
}
const inst = (...vs) => ({ 'cc-statusline@fulin-plugins': vs.map((version) => ({ scope: 'user', version })) });
const win = (resets) => ({ used_percentage: 10, resets_at: resets });
const R = (o) => Q.resolveQuota({ home: mkHome(o), now: NOW });

try {

  // ── 正常：有 5 小時視窗 ──
  let r = R({ limits: { at: AT, five_hour: win(NOW + 3600), seven_day: win(NOW + 86400 * 5), tried: AT } });
  check(r.ok && r.window === 'five_hour' && r.base === NOW + 3600 && r.warning === null, 'five-hour-normal', JSON.stringify(r));

  // ── 裁定 1：five_hour 為 null → 改等 7 天 ──
  r = R({ limits: { at: AT, five_hour: null, seven_day: win(NOW + 86400 * 2), tried: AT } });
  check(r.ok && r.window === 'seven_day' && r.base === NOW + 86400 * 2 && /沒有 5 小時額度視窗/.test(r.warning), 'ruling-1-seven-day', JSON.stringify(r));
  // 兩個視窗都有、5 小時優先（7 天不搶）
  r = R({ limits: { at: AT, five_hour: win(NOW + 100), seven_day: win(NOW + 99999) } });
  check(r.ok && r.window === 'five_hour' && r.base === NOW + 100, 'five-hour-wins-when-both', JSON.stringify(r));
  // 有 5 小時額度、但目前沒有視窗在跑（resets_at 明確為 null）：額度是滿的，不用等，不能誤等 7 天（2026-11-24 同事提出）
  r = R({ limits: { at: AT, five_hour: { used_percentage: 0, resets_at: null }, seven_day: win(NOW + 86400 * 3) } });
  check(r.ok && r.window === 'five_hour' && r.idle === true && r.base === NOW && /不用等/.test(r.warning || ''), 'five-hour-idle-no-wait-not-seven-day', JSON.stringify(r));
  r = R({ limits: { at: AT, five_hour: { used_percentage: 100, resets_at: null }, seven_day: win(NOW + 86400 * 3) } });
  check(!r.ok && r.code === 'no-window' && /已用完/.test(r.message), 'five-hour-exhausted-unknown-reset-blocks', JSON.stringify(r).slice(0, 200));
  r = R({ limits: { at: AT, five_hour: null, seven_day: win(NOW + 86400 * 3) } });
  check(r.ok && r.window === 'seven_day' && r.idle === false, 'five-hour-null-still-seven-day', JSON.stringify(r));
  // 7 天額度用完：不管 5 小時額度如何都等它；已過重置時間的不算用完；用完又查不到何時重置就擋下
  const full = (resets) => ({ used_percentage: 100, resets_at: resets });
  r = R({ limits: { at: AT, five_hour: win(NOW + 3600), seven_day: full(NOW + 86400 * 2) } });
  check(r.ok && r.window === 'seven_day' && r.base === NOW + 86400 * 2 && /7 天額度已經用完/.test(r.warning), 'seven-day-used-up-wins', JSON.stringify(r));
  r = R({ limits: { at: AT, five_hour: { used_percentage: 0, resets_at: null }, seven_day: full(NOW + 86400 * 2) } });
  check(r.ok && r.window === 'seven_day' && r.idle === false && r.base === NOW + 86400 * 2, 'seven-day-used-up-over-idle', JSON.stringify(r));
  r = R({ limits: { at: AT, five_hour: win(NOW + 3600), seven_day: full(NOW + 600) } });
  check(r.ok && r.base === NOW + 3600 && r.window === 'five_hour' && /先重置/.test(r.warning) && !/好幾天/.test(r.warning), 'seven-day-used-up-resets-before-five-hour', JSON.stringify(r));
  r = R({ limits: { at: AT, five_hour: win(NOW + 3600), seven_day: full(NOW - 5) } });
  check(r.ok && r.window === 'five_hour' && r.base === NOW + 3600, 'seven-day-already-reset', JSON.stringify(r));
  r = R({ limits: { at: AT, five_hour: win(NOW + 3600), seven_day: full(null) } });
  check(!r.ok && r.code === 'no-window' && /7 天額度已用完/.test(r.message), 'seven-day-used-up-unknown-reset-blocks', JSON.stringify(r));
  // 資料偏舊要附警告但仍可用
  r = R({ limits: { at: (NOW - 3 * 3600) * 1000, five_hour: win(NOW + 100) } });
  check(r.ok && r.limits_age_minutes === 180 && /180 分鐘前/.test(r.warning), 'stale-warning', JSON.stringify(r));

  r = R({ limits: { at: (NOW - 3 * 3600) * 1000, five_hour: { used_percentage: 0, resets_at: null }, seven_day: win(NOW + 86400) } });
  check(r.ok && r.idle && /180 分鐘前查的，現在的情況可能不同/.test(r.warning), 'stale-warning-idle', JSON.stringify(r));

  // ── 裁定 2：沒裝／太舊 → 擋下並提示安裝，且不退回讀快照檔 ──
  const snap = { abc: { five_hour: { resets_at: NOW + 7200 } } };       // 舊檔裡有一個看起來可用的 5 小時重置時間
  r = R({ snapshots: snap });                             // 沒裝、沒額度檔、只有舊快照
  check(!r.ok && r.code === 'cc-statusline-missing' && /claude plugin install cc-statusline@fulin-plugins/.test(r.message) && !/7200/.test(JSON.stringify(r)), 'ruling-2-not-installed-blocks-no-fallback', JSON.stringify(r).slice(0, 220));
  r = R({ legacy: true, limits: { at: AT, five_hour: win(NOW + 100) }, snapshots: snap });   // 沒有 v＝舊版或開發時殘留的舊檔：舊版不會更新它，不能信
  check(!r.ok && r.code === 'cc-statusline-too-old' && /claude plugin update/.test(r.message) && /沒有介面版本 v/.test(r.message), 'ruling-2-no-v-means-too-old', JSON.stringify(r).slice(0, 220));
  r = R({ legacy: true, limits: { v: '1', at: AT, five_hour: win(NOW + 100) } });
  check(!r.ok && r.code === 'cc-statusline-too-old', 'v-must-be-a-number', JSON.stringify(r).slice(0, 160));
  r = R({ legacy: true, limits: { v: 0, at: AT, five_hour: win(NOW + 100) } });
  check(!r.ok && r.code === 'cc-statusline-too-old', 'v-zero-is-too-old', JSON.stringify(r).slice(0, 160));
  r = R({ legacy: true, limits: { v: 2, at: AT, five_hour: win(NOW + 100), some_future_field: { a: 1 } } });   // 欄位只加不改：更新的 v 與不認得的欄位都照常讀
  check(r.ok && r.window === 'five_hour', 'newer-v-and-unknown-fields-accepted', JSON.stringify(r).slice(0, 160));
  r = R({ installed: inst('1.8.4'), limits: { at: AT, five_hour: win(NOW + 100) } });         // installed_plugins.json 不再是判斷依據（只看額度檔自己的 v）
  check(r.ok, 'installed-plugins-file-not-consulted', JSON.stringify(r).slice(0, 160));
  r = R({});                                                        // 沒有額度檔
  check(!r.ok && r.code === 'cc-statusline-missing' && /claude plugin install/.test(r.message), 'no-limits-file-blocks', JSON.stringify(r).slice(0, 200));

  // ── 裁定沒講到的情況：照「擋下並說明」 ──
  r = R({ limits: { at: AT, none: true, five_hour: null, seven_day: null } });
  check(!r.ok && r.code === 'no-limits' && /goal2:goal/.test(r.message), 'no-limits-account-blocks', JSON.stringify(r).slice(0, 200));
  r = R({ limits: { at: AT, five_hour: null, seven_day: null } });
  check(!r.ok && r.code === 'no-window', 'both-windows-null-blocks', JSON.stringify(r).slice(0, 200));
  r = R({ limits: { tried: AT, five_hour: null, seven_day: null } });
  check(!r.ok && r.code === 'limits-not-answered', 'tried-but-not-answered-blocks', JSON.stringify(r).slice(0, 200));
  r = R({ limits: '{壞掉' });
  check(!r.ok && r.code === 'limits-unreadable', 'broken-json-blocks', JSON.stringify(r).slice(0, 200));
  r = R({ limits: '[1,2]' });
  check(!r.ok && r.code === 'limits-unreadable', 'array-json-blocks', JSON.stringify(r).slice(0, 200));
  r = R({ limits: { at: AT, five_hour: { resets_at: '明天' }, seven_day: null } });
  check(!r.ok && r.code === 'limits-unreadable', 'a-window-of-another-shape-blocks', JSON.stringify(r).slice(0, 200));

  // ── 視窗的其他狀態 ──
  const idle = { used_percentage: 0, resets_at: null };
  r = R({ limits: { at: AT, five_hour: null, seven_day: idle } });
  check(r.ok && r.window === 'seven_day' && r.idle === true && r.base === NOW && /7 天額度目前沒有在計時/.test(r.warning), 'seven-day-idle-no-wait', JSON.stringify(r));
  r = R({ limits: { at: AT, five_hour: win(NOW - 5), seven_day: win(NOW + 86400) } });
  check(r.ok && r.window === 'five_hour' && r.idle === true && r.base === NOW && !/好幾天/.test(r.warning), 'five-hour-already-reset-no-wait', JSON.stringify(r));
  r = R({ limits: { at: (NOW - 86400) * 1000, five_hour: null, seven_day: win(NOW - 5) } });
  check(!r.ok && r.code === 'limits-stale' && /太舊了/.test(r.message), 'seven-day-already-reset-old-data-blocks', JSON.stringify(r).slice(0, 200));
  r = R({ limits: { at: (NOW - 10 * 86400) * 1000, five_hour: win(NOW - 9 * 86400), seven_day: win(NOW - 5 * 86400) } });
  check(!r.ok && r.code === 'limits-stale', 'a-file-nobody-keeps-up-blocks', JSON.stringify(r).slice(0, 200));
  // 只有 7 天額度、剛過重置時間（近期的資料）：不用等
  r = R({ limits: { at: AT, five_hour: null, seven_day: { used_percentage: 100, resets_at: NOW - 60 } } });
  check(r.ok && r.window === 'seven_day' && r.idle === true && r.base === NOW && /不用等/.test(r.warning), 'seven-day-only-just-reset-no-wait', JSON.stringify(r));
  // 兩個視窗各六種狀態的每一種組合：要嘛排得了、要嘛說得出為什麼不行，不會丟例外
  { const S = { none: null, idle, running: win(NOW + 3600), over: win(NOW - 60), full: { used_percentage: 100, resets_at: NOW + 7200 }, fullIdle: { used_percentage: 100, resets_at: null } }, want = { 'none/none': 'no-window', 'fullIdle/none': 'no-window' }; const bad = [];
    for (const a of Object.keys(S)) for (const b of Object.keys(S)) for (const old of [false, true]) { const q = R({ limits: { at: old ? (NOW - 3 * 86400) * 1000 : AT, five_hour: S[a], seven_day: S[b] } }), k = a + '/' + b;
      const exp = b === 'full' ? ['seven_day', NOW + 7200] : b === 'fullIdle' ? 'no-window' : a === 'running' ? ['five_hour', NOW + 3600] : a === 'full' ? ['five_hour', NOW + 7200] : a === 'fullIdle' ? 'no-window' : a !== 'none' ? (old ? 'limits-stale' : ['five_hour', NOW]) : b === 'none' ? 'no-window' : b === 'running' ? ['seven_day', NOW + 3600] : old ? 'limits-stale' : ['seven_day', NOW];
      if (typeof exp === 'string' ? q.ok || q.code !== exp : !q.ok || q.window !== exp[0] || q.base !== exp[1]) bad.push(k + (old ? '(old)' : '') + ' ' + JSON.stringify(q).slice(0, 120)); if (want[k] && q.code !== want[k]) bad.push(k); }
    check(!bad.length, 'every-pair-of-states (72)', bad.slice(0, 4).join(' ; ')); }
  // 三個 plugin 各有一份「視窗現在的狀態」（外掛不能互相 require）：在 repo 裡比對三份一致
  { const others = ['../../cc-statusline/hooks/account-limits.js', '../../session-board/lib/quota.js'].map((f) => path.join(__dirname, f)).filter((f) => fs.existsSync(f)).map((f) => require(f).stateOf).filter((f) => typeof f === 'function'); const V = [null, undefined, {}, 'x', 5, [], idle, { used_percentage: 'a', resets_at: null }, win(NOW + 1), win(NOW), win(NOW - 1), win(NOW + 8 * 86400), win(NOW + 8 * 86400 + 1), win((NOW + 60) * 1000), win('x'), { resets_at: NOW + 5 }];
    const bad = V.filter((v) => others.some((f) => f(v, NOW) !== Q.stateOf(v, NOW))); check(!bad.length, 'same-states-as-the-others (' + others.length + ')', JSON.stringify(bad)); }
  for (const [five, label] of [[{ used_percentage: 5, resets_at: '明天' }, 'string'], [{ resets_at: null }, 'no-percentage'], [{ used_percentage: 5, resets_at: NOW + 30 * 86400 }, 'a-month-ahead'], [{ used_percentage: 5, resets_at: (NOW + 3600) * 1000 }, 'milliseconds'], ['x', 'not-an-object']]) { r = R({ limits: { at: AT, five_hour: five, seven_day: win(NOW + 86400) } }); check(!r.ok && r.code === 'limits-unreadable', 'unreadable-five-hour-' + label, JSON.stringify(r).slice(0, 160)); }
  for (const at of [9e18, (NOW + 7200) * 1000, 0, -1, 'x']) { r = R({ limits: { at, five_hour: win(NOW + 100), seven_day: null } }); check(!r.ok && r.code === 'limits-not-answered', 'a-time-that-is-none-' + at, JSON.stringify(r).slice(0, 160)); }

  // ── 真的跑 delaylocal.js（--plain：不建 run 目錄；假使用者目錄）──
  const runDelay = (o, extraEnv) => {
    const home = mkHome(o);
    const r2 = spawnSync(process.execPath, [DELAY, '60', '--plain', '--cwd', home], { input: '把測試跑一遍', encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ...(extraEnv || {}) } });
    let j = null; try { j = JSON.parse(r2.stdout); } catch (e) {}
    return { status: r2.status, j, raw: r2.stdout + r2.stderr };
  };
  const future = Math.floor(Date.now() / 1000) + 2 * 86400;
  let x = runDelay({ limits: { at: Date.now(), five_hour: null, seven_day: win(future), tried: Date.now() } });
  check(x.status === 0 && x.j && x.j.ok && x.j.quota_window === 'seven_day' && /7 天/.test(x.j.quota_warning) && x.j.fire_in_minutes > 2 * 24 * 60 - 5 && x.j.fire_in_minutes < 2 * 24 * 60 + 5, 'e2e-seven-day-schedules-two-days-out', x.raw.slice(0, 300));
  x = runDelay({ limits: { at: Date.now(), five_hour: win(Math.floor(Date.now() / 1000) + 3600), seven_day: win(future) } });
  check(x.status === 0 && x.j && x.j.quota_window === 'five_hour' && x.j.fire_in_minutes > 60 && x.j.fire_in_minutes < 62, 'e2e-five-hour-schedules-in-an-hour', x.raw.slice(0, 300));
  x = runDelay({ limits: { at: Date.now(), five_hour: { used_percentage: 0, resets_at: null }, seven_day: win(future) } });
  check(x.status === 0 && x.j && x.j.ok && x.j.quota_window === 'five_hour' && x.j.fire_in_minutes >= 0 && x.j.fire_in_minutes <= 2, 'e2e-five-hour-idle-schedules-now-not-in-days', x.raw.slice(0, 300));
  // 問使用者之前就看得到會不會被擋
  { const sc = (o) => { const home = mkHome(o), q = spawnSync(process.execPath, [DELAY, '--show-config'], { encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }); try { return JSON.parse(q.stdout).quota; } catch (e) { return q.stdout + q.stderr; } };
    const no = sc({}), yes = sc({ limits: { at: Date.now(), five_hour: null, seven_day: win(future) } }); check(no && no.ok === false && /claude plugin install/.test(no.message) && yes && yes.ok === true && yes.window === 'seven_day', 'show-config-tells-quota', JSON.stringify([no, yes]).slice(0, 300)); }
  x = runDelay({ snapshots: { aaaaaaaabbbbccccddddeeee: { five_hour: { resets_at: Math.floor(Date.now() / 1000) + 3600 } } } });
  check(x.status === 1 && x.j && x.j.ok === false && /cc-statusline/.test(x.j.error) && /claude plugin install/.test(x.j.error), 'e2e-not-installed-blocks-with-install-hint', x.raw.slice(0, 300));
  x = runDelay({ limits: { at: Date.now(), none: true } });
  check(x.status === 1 && x.j && x.j.ok === false && /沒有額度限制/.test(x.j.error), 'e2e-no-limits-blocks', x.raw.slice(0, 300));
} finally { for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }); } catch (e) {} } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
