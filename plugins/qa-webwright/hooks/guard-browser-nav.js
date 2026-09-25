#!/usr/bin/env node
/**
 * guard-browser-nav — qa-webwright 的 PreToolUse(瀏覽器導向工具) hook：禁止導向正式站、對指定 host 限速。
 *
 * 為什麼：QA 探索（本體或子 agent）在迴圈裡反覆導向同一個外部站，對脆弱的站就是一次小型 DDoS；
 * 把測試指令打到正式站更是不可逆。正常低頻瀏覽不受影響，只擋「正式站」與「短時間高頻」。
 *
 * 攔截工具：mcp__playwright__browser_navigate、mcp__playwright__browser_tabs（開新分頁帶 url 時）、
 *   mcp__claude-in-chrome__navigate、mcp__claude-in-chrome__tabs_create_mcp。取不到網址 → 放行。
 * 啟動條件：專案 tests/e2e/qa-webwright.json 有 browser_guard 段且設了 deny_hosts_regex 或 rate_limits；否則完全靜默。
 *   browser_guard: { deny_hosts_regex: "…", rate_limits: [{host_regex, max, window_s}] }
 * 規則：
 *   · 本機（localhost、127.x、::1、0.0.0.0、*.localhost）永遠放行、不計數。
 *   · host 符合 deny_hosts_regex → 擋。
 *   · 限速：符合 host_regex 的 host，在 window_s 秒滾動視窗內已放行 max 次 → 第 max+1 次起擋（被擋的那次不計數），
 *     視窗滑過去就恢復。狀態檔在 os.tmpdir()（可用環境變數 QA_WEBWRIGHT_NAV_STATE 指定），寫入用 tmp＋rename；
 *     計數以「專案根＋規則＋host」為鍵（不同專案各算各的）。host 尾端句點（prod.example.com.）視同無句點。
 *     已知限制：讀改寫沒有跨程序鎖，並行導向可能各自讀到舊值而略超上限（節流閘，不是精確配額）。
 * FAIL-OPEN：hook 自身錯誤、設定型別壞、狀態檔讀寫失敗 → 放行。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./lib/qa-gate-common.js');

const LOCAL_RE = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|0\.0\.0\.0|(?:[a-z0-9-]+\.)+localhost)$/i;

function statePath() {
  return process.env.QA_WEBWRIGHT_NAV_STATE || path.join(os.tmpdir(), 'qa-webwright-nav-rate.json');
}

function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  // host:port 沒寫 scheme（prod.example.com:8443/x）：冒號後接數字是 port，不是 scheme
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(s) ? s : 'http://' + s).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''); // 尾端句點（FQDN 寫法）與無句點同一站
  } catch (_) {
    return null;
  }
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return G.isObj(s) ? s : {};
  } catch (_) {
    return {};
  }
}

// 回 true＝寫入成功；false＝寫不進去（呼叫端據此 fail-open：計數不可靠就不擋）
function writeState(state) {
  const f = statePath();
  const tmp = f + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, f);
    return true;
  } catch (_) {
    try {
      fs.unlinkSync(tmp);
    } catch (__) {
      /* tmp 本來就沒建成 */
    }
    return false;
  }
}

function main() {
  const input = G.readInput();
  if (!input) return;
  const ti = G.isObj(input.tool_input) ? input.tool_input : {};
  const url = [ti.url, ti.URL, ti.href].find((x) => typeof x === 'string' && x) || '';
  const host = hostOf(url);
  if (!host) return;
  const got = G.loadSection(input, 'browser_guard', (s) => G.isObj(s));
  if (!got) return;
  const sec = got.sec;
  const denyRe = G.re(sec.deny_hosts_regex);
  const limits = (Array.isArray(sec.rate_limits) ? sec.rate_limits : [])
    .filter((r) => G.isObj(r) && G.re(r.host_regex) && Number(r.max) > 0 && Number(r.window_s) > 0);
  if (!denyRe && !limits.length) return;
  if (LOCAL_RE.test(host)) return;

  if (denyRe && denyRe.test(host)) {
    G.deny('[browser-guard] 禁止導向 ' + host + '（符合參數檔 browser_guard.deny_hosts_regex：' + sec.deny_hosts_regex + '）。'
      + '這是正式站／受保護站——QA 一律打本機或測試站。改用測試環境網址後重發；'
      + '確有必要連這個站，先向使用者確認並由使用者調整 tests/e2e/qa-webwright.json。');
    return;
  }
  if (!limits.length) return;
  const now = Date.now();
  const state = readState();
  const denials = [];
  const keys = [];
  limits.forEach((r, i) => {
    if (!G.re(r.host_regex).test(host)) return;
    // 計數鍵含專案根：狀態檔跨專案共用，不同專案各算各的
    const key = got.loc.root + '|' + i + '|' + r.host_regex + '|' + host;
    const win = Number(r.window_s) * 1000;
    const arr = (Array.isArray(state[key]) ? state[key] : []).filter((t) => typeof t === 'number' && now - t < win);
    state[key] = arr;
    if (arr.length >= Number(r.max)) {
      const wait = Math.max(1, Math.ceil((arr[0] + win - now) / 1000));
      denials.push('對 ' + host + ' 的導向在 ' + r.window_s + ' 秒內已 ' + arr.length + ' 次，達上限 ' + r.max
        + ' 次（規則 host_regex=' + r.host_regex + '）——約 ' + wait + ' 秒後視窗滑過即恢復。');
    } else {
      keys.push(key);
    }
  });
  if (!denials.length) for (const k of keys) state[k].push(now); // 被擋的那次不計數
  // 清理：本專案的鍵以本專案最長的限速視窗為門檻（window_s 可大於一天）；別的專案的視窗本閘不知道，
  // 只清 30 天以上沒動的（不得用本專案的短視窗刪掉別專案仍在長視窗內的紀錄）
  const own = got.loc.root + '|';
  const keepOwn = Math.max(24 * 3600 * 1000, ...limits.map((r) => Number(r.window_s) * 1000));
  const keepOther = Math.max(30 * 24 * 3600 * 1000, keepOwn);
  for (const k of Object.keys(state)) {
    const arr = Array.isArray(state[k]) ? state[k].filter((t) => typeof t === 'number') : [];
    const keep = k.startsWith(own) ? keepOwn : keepOther;
    if (arr.length === 0 || now - Math.max(...arr) > keep) delete state[k];
  }
  // 狀態寫不進去（唯讀、磁碟滿）＝計數不可靠 → 放行（FAIL-OPEN），不憑舊狀態擋人
  if (!writeState(state)) return;
  if (denials.length) {
    G.deny(G.listMessage('[browser-guard] 限速', denials,
      '這是防止暴打單一站的節流閘，正常低頻瀏覽不受影響：放慢對同一 host 的導向（批次探索、用 snapshot／evaluate 讀值而不是反覆重新導向），'
      + '或改打本機環境（localhost 不計數）。確有正當高頻需求，請使用者調整 tests/e2e/qa-webwright.json 的 browser_guard.rate_limits。'));
  }
}

try {
  main();
} catch (_) {
  process.exitCode = 0; // FAIL-OPEN
}
