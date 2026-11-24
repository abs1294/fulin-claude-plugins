#!/usr/bin/env node
/**
 * all-usage-refresh.js — cross-session API-equivalent usage for the (all) figure.
 *
 * Brings the usage records up to date (lib-records.js: every message of every transcript,
 * main sessions AND subagents, once), adds them up with the same price table statusline.js uses,
 * and writes ~/.claude/usage-data/cc-statusline-all-usage.json.
 *
 * Spawned detached by statusline.js and by the hooks (session-usage.js) when its cache is missing or
 * stale. Never runs inline: adding up takes seconds.
 *
 * Why a full scan rather than the cumulative store: the store only ever held
 * sessions that rendered a statusline (68 of 591 main transcripts locally) and its
 * cost came from the payload, which omits subagents. Together those understated the
 * total by 3.2x.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE = path.join(os.homedir(), '.claude', 'usage-data', 'cc-statusline-all-usage.json');
// 同一次掃描順便產出的明細（按日、按模型、按專案、按 session）：給需要「花在哪」的讀者（例如 harness 的健檢），
// 另寫一個檔，因為 statusline.js 每次渲染都會讀上面那個小檔，不能讓它變大
const DETAIL = path.join(os.homedir(), '.claude', 'usage-data', 'cc-statusline-usage-detail.json');
const DETAIL_SESSIONS_MAX = Number(process.env.CC_USAGE_DETAIL_SESSIONS) || 1500;   // （環境變數給測試用）
const LOCK = CACHE + '.lock';
const FRESH_MS = 15 * 60 * 1000;   // at most this often
const LOCK_STALE_MS = 30 * 60 * 1000;

// Pricing is shared with statusline.js (exact model match, stand-in price for
// unknown ids, backfill via price-refresh.js). sig ties the cache to the table.
const priceLib = require('./lib-price');
const { table, sig, cache: priceCache } = priceLib.loadTable();
const resolvePrice = priceLib.makeResolver(table);

// Skip if a recent result already exists.
try {
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  // 明細檔也要在、且跟牌價表對得上（兩份同一次掃描寫的），否則照樣掃（舊版只寫上面那個檔，升級後明細檔不存在）
  // 上一次掃描明細寫不進去（detailFailed）的，等下一次照時間掃，不為了補它一直重掃
  const fresh = c && c.at && (Date.now() - c.at) < FRESH_MS && c.sig === sig;
  if (fresh && c.detailFailed) process.exit(0);
  const d = JSON.parse(fs.readFileSync(DETAIL, 'utf8'));
  if (fresh && d && d.sig === sig) process.exit(0);
} catch (e) {}

// Single-runner lock: a scan is expensive and several sessions may spawn at once.
// Shared with price-refresh.js (lib-price.acquireRunLock): a stale lock is taken
// over by atomic rename, not stat -> unlink -> create, which let a late run
// delete the lock an earlier run had just made and both scan at once.
if (!priceLib.acquireRunLock(LOCK, LOCK_STALE_MS)) process.exit(0);
process.on('exit', () => priceLib.releaseRunLock(LOCK));
// Lost the lock in a takeover race after all: the other holder scans.
if (!priceLib.ownsRunLock(LOCK)) process.exit(0);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

// The usage records are brought up to date first, then added up: nothing is read from the transcripts here
// (lib-records.js). Another run bringing them up to date is waited for, up to a minute.
const records = require('./lib-records');
let current = false;
for (let n = 0; n < 60; n++) {
  let r = null;
  try { r = records.collect(); } catch (e) { r = undefined; }
  if (r) current = true;
  if (r !== null) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
// Nothing collected yet (the records could not be written): no figure rather than a wrong one. They could not be brought
// up to date and there is a figure: it stays, with the time it has.
if (!fs.existsSync(records.META) || (!current && fs.existsSync(CACHE))) process.exit(0);
let recordsAt = 0; try { recordsAt = JSON.parse(fs.readFileSync(records.META, 'utf8')).at || 0; } catch (e) {}
if (!recordsAt) process.exit(0);   // the first collecting is still going on: half of it is not a figure

let tok = 0, cost = 0, unpricedTok = 0, approxTok = 0, recs = 0, files = 0;
const missing = new Set();
// 明細：金額拆成輸入、輸出、快取寫入、快取讀取四項；本地日期
const byDay = {}, byModel = {}, byProject = {}, bySession = {}, modelIds = {};
const localDay = (ts) => { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const newParts = () => ({ in: 0, out: 0, cw: 0, cr: 0 });
const add = (o, k, init) => o[k] || (o[k] = init());
for (const f of records.recordFiles()) {
  files++;
  records.eachRecord(f.p, (x) => {
    if (!(x.ts > 0)) return;
    const n = (v) => v || 0, t = n(x.in) + n(x.out) + n(x.cw5) + n(x.cw1) + n(x.rd);
    tok += t; recs++;
    const r = resolvePrice(x.model || '');
    if (r.key && !r.exact) missing.add(r.key);
    if (!r.pr) { unpricedTok += t; return; }
    const pt = { in: n(x.in) * r.pr.in / 1e6, out: n(x.out) * r.pr.out / 1e6, cw: (n(x.cw5) * r.pr.cw + n(x.cw1) * r.pr.cw1h) / 1e6, cr: n(x.rd) * r.pr.cr / 1e6 };
    const c = pt.in + pt.out + pt.cw + pt.cr;
    cost += c;
    if (!r.exact) approxTok += t;
    // ── 明細 ──
    const day = localDay(x.ts), iso = new Date(x.ts).toISOString();
    const dd = add(byDay, day, () => ({ cost: 0, requests: 0, models: {}, parts: newParts() }));
    dd.cost += c; dd.requests++; dd.models[r.key] = (dd.models[r.key] || 0) + c;
    const mm = add(byModel, r.key, () => ({ cost: 0, requests: 0, exact: r.exact, parts: newParts() }));
    mm.cost += c; mm.requests++;
    const pj = add(byProject, f.project, () => ({ cost: 0, requests: 0, sessions: new Set(), byDay: {}, models: {}, parts: newParts() }));
    pj.cost += c; pj.requests++; pj.sessions.add(x.sid);
    pj.byDay[day] = (pj.byDay[day] || 0) + c; pj.models[r.key] = (pj.models[r.key] || 0) + c;
    const ss = add(bySession, f.project + '/' + x.sid, () => ({ id: x.sid, project: f.project, cost: 0, subCost: 0, requests: 0, first: null, last: null, models: {}, parts: newParts(), tok: { in: 0, out: 0, cw: 0, cr: 0 }, startCtx: null, think: 0, _line: Infinity }));
    ss.cost += c; if (x.agent) ss.subCost += c; ss.requests++;
    if (!ss.first || iso < ss.first) ss.first = iso; if (!ss.last || iso > ss.last) ss.last = iso;
    ss.models[r.key] = (ss.models[r.key] || 0) + c;
    ss.tok.in += n(x.in); ss.tok.out += n(x.out); ss.tok.cw += n(x.cw5) + n(x.cw1); ss.tok.cr += n(x.rd);
    for (const k of ['in', 'out', 'cw', 'cr']) { dd.parts[k] += pt[k]; mm.parts[k] += pt[k]; ss.parts[k] += pt[k]; pj.parts[k] += pt[k]; }
    // 開場固定底：主對話檔的第一則回應（跨檔去重之後的；分叉出來的 session 是分叉後第一則）讀到的上下文（專案說明檔、規則、hook 輸出、工具定義、skill 清單都在裡面）；thinking token 另記
    if (!x.agent && n(x.line) < ss._line) { ss._line = n(x.line); ss.startCtx = n(x.in) + n(x.cw5) + n(x.cw1) + n(x.rd); }
    ss.think += n(x.think);
    modelIds[x.model] = r.key;
  });
}
for (const x of Object.values(bySession)) delete x._line;

let detailFailed = true;
// 明細檔（先寫，免得上面小檔更新後、明細檔還是舊的，讀者看到兩份對不上）
try {
  const R = (x) => Math.round(x * 1e4) / 1e4;
  const rd = (o) => (o.parts ? { ...o, cost: R(o.cost), parts: Object.fromEntries(Object.entries(o.parts).map(([k, v]) => [k, R(v)])) } : o);
  const prices = {};
  // 解析器吃的是原始模型 id（claude-opus-5-5），不是正規化後的 key（opus-5-5）；讀者拿到 prices[key] 就能直接算
  for (const raw of Object.keys(modelIds)) { const r = resolvePrice(raw); if (r.pr) prices[r.key] = { ...r.pr, exact: r.exact }; }
  const ranked = Object.values(bySession).sort((a, b) => b.cost - a.cost), rest = ranked.slice(DETAIL_SESSIONS_MAX);
  const sessions = ranked.slice(0, DETAIL_SESSIONS_MAX)
    .map((s) => ({ ...rd(s), subCost: R(s.subCost), models: Object.fromEntries(Object.entries(s.models).map(([k, v]) => [k, R(v)])) }));
  const detail = {
    v: 1, at: recordsAt, sig, tz: -new Date().getTimezoneOffset() / 60, prices,
    byDay: Object.fromEntries(Object.entries(byDay).sort().map(([d, v]) => [d, { ...rd(v), models: Object.fromEntries(Object.entries(v.models).map(([k, x]) => [k, R(x)])) }])),
    byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, rd(v)])),
    byProject: Object.fromEntries(Object.entries(byProject).sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => [k, { cost: R(v.cost), requests: v.requests, sessions: v.sessions.size, byDay: Object.fromEntries(Object.entries(v.byDay).sort().map(([d, x]) => [d, R(x)])), models: Object.fromEntries(Object.entries(v.models).map(([m, x]) => [m, R(x)])), parts: Object.fromEntries(Object.entries(v.parts).map(([p, x]) => [p, R(x)])) }])),
    modelIds,   // 逐字紀錄裡的原始模型 id → 牌價表的 key，讀者要自己照牌價算金額時用
    sessions, sessionsTotal: ranked.length, sessionsRest: { count: rest.length, cost: R(rest.reduce((s, x) => s + x.cost, 0)) },   // 只列花最多的；其餘的個數與合計
  };
  const dtmp = DETAIL + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(dtmp, JSON.stringify(detail)); fs.renameSync(dtmp, DETAIL); detailFailed = false; } catch (e) { try { fs.unlinkSync(dtmp); } catch (_) {} }
} catch (e) {}
const tmp = CACHE + '.' + process.pid + '.tmp';
try {
  fs.writeFileSync(tmp, JSON.stringify({ at: recordsAt, sig, cost, tok, unpricedTok, approxTok, missing: [...missing], records: recs, files, ...(detailFailed ? { detailFailed: true } : {}) }));
  fs.renameSync(tmp, CACHE);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
}
priceLib.requestLookup([...missing], priceCache);
