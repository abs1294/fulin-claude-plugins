#!/usr/bin/env node
// all-usage-refresh.js 的明細輸出（cc-statusline-usage-detail.json）回歸測試。
// Run: node hooks/tests/all-usage-detail.test.js
//
// 用假的使用者目錄（USERPROFILE／HOME 指到暫存目錄）跑真的 all-usage-refresh.js，夾具是合成的逐字紀錄。
// 驗：總額與明細加總對得上、跨檔去重（subagent 的回應也被抄進主對話時只算一次）、按日／按模型／按專案／按 session、
// 四項成本拆分、開場固定底、thinking token、牌價表（prices）與原始模型 id 對照（modelIds）、
// 明細檔不新鮮時會重掃（舊版升級後明細檔不存在）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'all-usage-refresh.js');
const priceLib = require('../../scripts/lib-price');
let pass = 0, fail = 0;
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  -> ' + detail)); };
const near = (a, b) => Math.abs(a - b) < 1e-3;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-'));
const PROJ = path.join(HOME, '.claude', 'projects');
const put = (rel, rows) => { const p = path.join(PROJ, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
const msg = (id, ts, model, u) => ({ type: 'assistant', timestamp: ts, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u } });
const U = (o) => ({ input_tokens: o.in || 0, output_tokens: o.out || 0, cache_read_input_tokens: o.cr || 0, cache_creation_input_tokens: (o.cw5 || 0) + (o.cw1 || 0), cache_creation: { ephemeral_5m_input_tokens: o.cw5 || 0, ephemeral_1h_input_tokens: o.cw1 || 0 }, ...(o.think ? { output_tokens_details: { thinking_tokens: o.think } } : {}) });
const run = () => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, TZ: 'UTC', USERPROFILE: HOME, HOME }, encoding: 'utf8' });

const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5'   /* 內建牌價表有的：沒有的會背景去查真實牌價頁 */;
const u1 = U({ in: 100, out: 500, cw1: 40000, cr: 0, think: 300 });          // A 的第一則：開場固定底 40100
const u2 = U({ in: 10, out: 200, cr: 40000 });
const u3 = U({ in: 50, out: 1000, cw5: 20000, cr: 10000 });                    // subagent 的回應（也被抄進主對話一份）
const u4 = U({ in: 5, out: 5, cw1: 8000 });                                    // B 專案
try {
  // 專案 A：兩個 session；a1 有 subagent，subagent 的回應 s1 在主對話也出現一次（要去重）
  put('proj-a/sess-a1.jsonl', [msg('m1', '2026-11-10T02:00:00.000Z', OPUS, u1), msg('m1', '2026-11-10T02:00:01.000Z', OPUS, u1), msg('m2', '2026-11-11T03:00:00.000Z', OPUS, u2), msg('s1', '2026-11-11T03:00:05.000Z', SONNET, u3)]);
  put('proj-a/sess-a1/subagents/agent-x.jsonl', [msg('s1', '2026-11-11T03:00:05.000Z', SONNET, u3)]);
  put('proj-a/sess-a2.jsonl', [msg('m3', '2026-11-12T04:00:00.000Z', SONNET, u2)]);
  put('proj-b/sess-b1.jsonl', [msg('m4', '2026-11-10T05:00:00.000Z', OPUS, u4), { type: 'assistant', timestamp: '2026-11-10T05:00:01.000Z', message: { id: 'syn', model: '<synthetic>', usage: U({ in: 9999 }) } }]);

  const r = run();
  check(r.status === 0, 'exit-0', 'exit ' + r.status + ' ' + String(r.stderr).slice(0, 200));
  const dir = path.join(HOME, '.claude', 'usage-data');
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'cc-statusline-all-usage.json'), 'utf8'));
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'cc-statusline-usage-detail.json'), 'utf8'));
  // 假目錄沒有牌價快取，腳本用的是內建牌價；測試程序自己別讀真實使用者目錄的快取
  const rp = priceLib.makeResolver(priceLib.BUILTIN);
  const cost = (u, m) => priceLib.usageCost(u, rp(m).pr);
  const expectTotal = cost(u1, OPUS) + cost(u2, OPUS) + cost(u3, SONNET) + cost(u2, SONNET) + cost(u4, OPUS);   // m1 去重、s1 去重
  check(near(all.cost, expectTotal), 'all-usage-total-dedup', `all.cost=${all.cost} 預期 ${expectTotal}`);
  const sum = (o, f) => Object.values(o).reduce((s, x) => s + f(x), 0);
  check(near(sum(d.byDay, (x) => x.cost), all.cost) && near(sum(d.byModel, (x) => x.cost), all.cost) && near(sum(d.byProject, (x) => x.cost), all.cost) && near(d.sessions.reduce((s, x) => s + x.cost, 0), all.cost), 'detail-sums-equal-total', `day ${sum(d.byDay, (x) => x.cost)} model ${sum(d.byModel, (x) => x.cost)} project ${sum(d.byProject, (x) => x.cost)}`);
  check(d.sig === all.sig && d.v === 1, 'detail-sig-matches', `${d.sig} vs ${all.sig}`);

  const sa1 = d.sessions.find((s) => s.id === 'sess-a1');
  check(sa1 && sa1.project === 'proj-a' && sa1.requests === 3, 'session-requests-dedup', `requests=${sa1 && sa1.requests}（m1 兩列、s1 兩個檔，應為 3）`);
  check(sa1 && near(sa1.subCost, cost(u3, SONNET)), 'subagent-cost-recorded', `subCost=${sa1 && sa1.subCost} 預期 ${cost(u3, SONNET)}`);
  check(sa1 && sa1.startCtx === 40100, 'start-context', `startCtx=${sa1 && sa1.startCtx}（第一則的 input+快取寫入+快取讀取，應為 40100）`);
  check(sa1 && sa1.think === 300, 'thinking-tokens', `think=${sa1 && sa1.think}`);
  const partsSum = sa1 ? sa1.parts.in + sa1.parts.out + sa1.parts.cw + sa1.parts.cr : 0;
  check(sa1 && near(partsSum, sa1.cost), 'parts-sum-equals-cost', `parts ${partsSum} vs cost ${sa1 && sa1.cost}`);
  check(sa1 && sa1.first.startsWith('2026-11-10') && sa1.last.startsWith('2026-11-11'), 'first-last', `${sa1 && sa1.first} ${sa1 && sa1.last}`);

  check(Object.keys(d.byProject).sort().join() === 'proj-a,proj-b', 'projects', Object.keys(d.byProject).join());
  const pa = d.byProject['proj-a'];
  check(pa && pa.sessions === 2 && near(Object.values(pa.byDay).reduce((a, x) => a + x, 0), pa.cost) && near(sum(pa.models, (x) => x), pa.cost) && near(sum(pa.parts, (x) => x), pa.cost), 'project-detail-consistent', JSON.stringify(pa).slice(0, 300));
  check(Object.keys(d.byModel).sort().join() === 'opus-5-5,sonnet-5', 'models-normalized-and-synthetic-skipped', Object.keys(d.byModel).join());
  check(d.modelIds[OPUS] === 'opus-5-5' && d.modelIds[SONNET] === 'sonnet-5', 'modelIds-map', JSON.stringify(d.modelIds));
  const pr = d.prices['opus-5-5'];
  check(pr && pr.in === rp(OPUS).pr.in && pr.cr === rp(OPUS).pr.cr && pr.cw1h === rp(OPUS).pr.cw1h && pr.out === rp(OPUS).pr.out, 'prices-snapshot-present', JSON.stringify(d.prices).slice(0, 200));
  check(d.byDay['2026-11-10'] && d.byDay['2026-11-11'] && d.byDay['2026-11-12'], 'byDay-days', Object.keys(d.byDay).join());
  check(d.sessionsTotal === 3 && d.sessions.length === 3, 'sessionsTotal', `sessionsTotal=${d.sessionsTotal}（a1、a2、b1；subagent 算在 a1 裡）`);

  // 新鮮度：明細檔被刪掉時要重掃（舊版升級）；兩個檔都新鮮時不重掃
  const mtime = (f) => fs.statSync(path.join(dir, f)).mtimeMs;
  const t0 = mtime('cc-statusline-usage-detail.json');
  run();
  check(mtime('cc-statusline-usage-detail.json') === t0, 'fresh-no-rescan', '兩個檔都新鮮不該重掃');
  fs.unlinkSync(path.join(dir, 'cc-statusline-usage-detail.json'));
  run();
  check(fs.existsSync(path.join(dir, 'cc-statusline-usage-detail.json')), 'missing-detail-rescans', '明細檔不存在時要重掃補出來');
  // 狀態列自己會補：總額檔還新鮮、明細檔不在
  fs.unlinkSync(path.join(dir, 'cc-statusline-usage-detail.json'));
  spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'statusline.js')], { input: JSON.stringify({ session_id: 's', cwd: HOME, model: { id: OPUS, display_name: 'x' }, cost: {} }), env: { ...process.env, TZ: 'UTC', USERPROFILE: HOME, HOME }, encoding: 'utf8' });
  for (let k = 0; k < 100 && !fs.existsSync(path.join(dir, 'cc-statusline-usage-detail.json')); k++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  check(fs.existsSync(path.join(dir, 'cc-statusline-usage-detail.json')), 'statusline-fills-missing-detail', '總額檔新鮮、明細檔不在，跑一次狀態列要補出來');
  for (let k = 0; k < 100 && fs.existsSync(path.join(dir, 'cc-statusline-all-usage.json.lock')); k++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);   // 背景那次掃完放鎖
  // 明細寫不進去（同名資料夾擋著）：記下來，狀態列與腳本都不為了補它一直重掃；擋的東西沒了、照時間掃到就會補
  const det = path.join(dir, 'cc-statusline-usage-detail.json'), tot = path.join(dir, 'cc-statusline-all-usage.json'), J = () => JSON.parse(fs.readFileSync(tot, 'utf8'));
  fs.unlinkSync(det); fs.mkdirSync(path.join(det, 'x'), { recursive: true }); fs.unlinkSync(tot); run();
  const at1 = J().at; check(J().detailFailed === true && fs.readdirSync(dir).filter((f) => /usage-detail.*tmp/.test(f)).length === 0, 'detail-failed-recorded-no-tmp', JSON.stringify(J()).slice(0, 200));
  fs.rmSync(det, { recursive: true }); run(); check(J().at === at1 && !fs.existsSync(det), 'detail-failed-not-rescanned-at-once', '總額還新鮮，不重掃');
  { const j = J(); j.at -= 7 * 3600000; fs.writeFileSync(tot, JSON.stringify(j)); } run(); check(!J().detailFailed && fs.existsSync(det), 'detail-failed-filled-at-next-scan', JSON.stringify(J()).slice(0, 200));
  // 超過上限的 session：個數與合計在 sessionsRest
  fs.unlinkSync(tot); spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, TZ: 'UTC', USERPROFILE: HOME, HOME, CC_USAGE_DETAIL_SESSIONS: '1' }, encoding: 'utf8' });
  { const x = JSON.parse(fs.readFileSync(det, 'utf8')); check(x.sessions.length === 1 && x.sessionsTotal === 3 && x.sessionsRest.count === 2 && near(x.sessions[0].cost + x.sessionsRest.cost, J().cost), 'sessions-rest', JSON.stringify(x.sessionsRest)); }
  // 檔名排在 subagent 資料夾前面的主對話也抄了它的回應：仍算在 subagent
  put('proj-c/s9.jsonl', [msg('s9m', '2026-11-11T03:00:06.000Z', SONNET, u3)]); put('proj-c/s9/subagents/agent-y.jsonl', [msg('s9m', '2026-11-11T03:00:06.000Z', SONNET, u3)]);
  fs.unlinkSync(tot); run(); { const x = JSON.parse(fs.readFileSync(det, 'utf8')).sessions.find((y) => y.id === 's9'); check(x && x.requests === 1 && near(x.subCost, cost(u3, SONNET)), 'subagent-keeps-its-own-turn', JSON.stringify(x)); }
  fs.rmSync(path.join(PROJ, 'proj-c'), { recursive: true });
  // projects/ 根層散落的逐字紀錄不會讓整支當掉
  put('stray.jsonl', [msg('mstray', '2026-11-10T02:00:00.000Z', OPUS, u2)]);
  fs.unlinkSync(path.join(dir, 'cc-statusline-all-usage.json'));
  const sr = run(), sd = JSON.parse(fs.readFileSync(path.join(dir, 'cc-statusline-usage-detail.json'), 'utf8'));
  check(sr.status === 0 && fs.existsSync(path.join(dir, 'cc-statusline-all-usage.json')) && sd.byProject['（專案目錄外）'].sessions === 1, 'stray-transcript-in-root', 'exit ' + sr.status + ' ' + String(sr.stderr).slice(0, 160));
  fs.unlinkSync(path.join(PROJ, 'stray.jsonl'));
} finally { for (let k = 0; k < 5; k++) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* 背景還在寫 */ } } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
