#!/usr/bin/env node
// /harness:review 的 token 花費腳本（skills/review/scripts/token-scan.js）回歸測試。
// 夾具照真實逐字紀錄的形狀合成（assistant 列有 message.id 與 usage，同一個 id 因內容區塊拆成多列），不放真實紀錄。
//
// 用法：node plugins/harness/tests/lib/token-scan.js   → 每項印一行 `PASS|FAIL <項目>｜<證據>`，有 FAIL 時 exit 1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'review', 'scripts', 'token-scan.js');
let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}｜${detail}`); };
const put = (p, rows) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n'); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-proj-'));
const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-tr-'));
const fwd = root.split(path.sep).join('/');
const usage = (o) => ({ input_tokens: o.in || 0, output_tokens: o.out || 0, cache_read_input_tokens: o.rd || 0, cache_creation_input_tokens: (o.cw5 || 0) + (o.cw1 || 0), cache_creation: { ephemeral_5m_input_tokens: o.cw5 || 0, ephemeral_1h_input_tokens: o.cw1 || 0 } });
const asst = (id, ts, u, blocks, model) => ({ type: 'assistant', timestamp: ts, entrypoint: 'cli', cwd: root, message: { id, model: model || 'claude-opus-5-5', role: 'assistant', usage: usage(u), content: blocks || [{ type: 'text', text: 'x' }] } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const userRes = (ts, id, n) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'a'.repeat(n) }] } });
const userTxt = (ts, t) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: t } });
// 預設指到一個不存在的明細檔：比例模式，且不受這台機器真實的 cc-statusline 明細檔影響
const NO_DETAIL = path.join(tdir, 'no-such-detail.json');
const run = (extra, detail) => spawnSync(process.execPath, [SCRIPT, root, '--transcripts', tdir, '--usage-detail', detail || NO_DETAIL, ...(extra || [])], { encoding: 'utf8' });
try {
  // 一般 session A：兩個 message.id，第一個被拆成兩列（usage 相同，要只算一次）；有一次重建（閒置 2 小時後）、一個大工具結果、同檔讀 4 次
  const f = path.join(fwd, 'src', 'a.js');
  const A = [
    userTxt('2026-11-10T01:00:00.000Z', '開工'),
    asst('m1', '2026-11-10T01:00:01.000Z', { in: 10, out: 100, cw1: 1000, rd: 0 }, [toolUse('t1', 'Read', { file_path: f })]),
    asst('m1', '2026-11-10T01:00:01.500Z', { in: 10, out: 100, cw1: 1000, rd: 0 }, [toolUse('t2', 'Read', { file_path: f })]),
    userRes('2026-11-10T01:00:02.000Z', 't1', 30000),
    asst('m2', '2026-11-10T01:00:05.000Z', { in: 5, out: 50, rd: 1000 }, [toolUse('t3', 'Read', { file_path: f })]),
    asst('m3', '2026-11-10T01:00:06.000Z', { in: 5, out: 50, rd: 1000 }, [toolUse('t4', 'Read', { file_path: f }), toolUse('t5', 'Read', { file_path: 'C:/elsewhere/secret-name.txt' })]),
    asst('m4', '2026-11-10T03:10:00.000Z', { in: 5, out: 10, cw1: 90000, rd: 0 }),          // 閒置 2 小時後整段重建
    '{這行壞掉',
  ];
  put(path.join(tdir, 'sess-a.jsonl'), A);
  const r = run(['--out', path.join(tdir, 'out.json')]);
  check(r.status === 0, 'exit-0', `exit ${r.status} ${String(r.stderr || '').slice(0, 200)}`);
  const j = JSON.parse(fs.readFileSync(path.join(tdir, 'out.json'), 'utf8'));
  const a = j.flagged[0];
  check(j.totals.sessions === 1 && a && a.requests === 4, 'dedupe-by-message-id', `requests=${a && a.requests}（同一個 message.id 拆成兩列只算一次，應為 4）`);
  check(a && a.tokens.input === 10 + 5 + 5 + 5 && a.tokens.output === 100 + 50 + 50 + 10, 'sum-input-output', `in=${a && a.tokens.input} out=${a && a.tokens.output}`);
  check(a && a.tokens.cacheCreate1h === 91000 && a.tokens.cacheRead === 2000, 'sum-cache', `cw1h=${a && a.tokens.cacheCreate1h} read=${a && a.tokens.cacheRead}`);
  const expect = 25 * 1 + 91000 * 2 + 2000 * 0.1 + 210 * 5;
  check(a && a.cost === Math.round(expect) && j.unit === 'units' && j.source === 'transcripts-only', 'fallback-weights', `cost=${a && a.cost} 預期 ${Math.round(expect)}；unit=${j.unit} source=${j.source}`);
  check(j.notes.some((n) => /沒有 cc-statusline 明細檔/.test(n)) && j.notes.some((n) => /不分模型/.test(n)), 'fallback-says-so', j.notes.filter((n) => /cc-statusline/.test(n)).join(' | ').slice(0, 220));
  check(a && a.cacheRebuilds.length === 1 && a.cacheRebuilds[0].afterIdleOver1h === true, 'cache-rebuild-after-idle', JSON.stringify(a && a.cacheRebuilds));
  check(a && a.bigToolResultCount === 1 && a.bigToolResults[0].tool === 'Read', 'big-tool-result', JSON.stringify(a && a.bigToolResults));
  check(a && a.repeatedReads.length === 1 && a.repeatedReads[0].file === 'src/a.js' && a.repeatedReads[0].n === 4, 'repeated-read-relative-path', JSON.stringify(a && a.repeatedReads));
  check(!JSON.stringify(j).includes('secret-name') && !JSON.stringify(j).includes('elsewhere'), 'outside-path-not-leaked', '專案外的檔名不能出現在輸出');
  check(j.notes.some((n) => /解析失敗/.test(n)), 'bad-line-noted', j.notes.join(' | ').slice(0, 200));
  check(!JSON.stringify(j).includes('開工'), 'no-user-text', '使用者發言原文不能出現在輸出');

  // 長壽＋subagent：B 跨 3 天、subagent 占比高
  put(path.join(tdir, 'sess-b.jsonl'), [
    asst('b1', '2026-11-10T00:00:00.000Z', { in: 1, out: 1, cw5: 300000 }),
    asst('b2', '2026-11-13T00:00:00.000Z', { in: 1, out: 1, rd: 300000 }),
  ]);
  put(path.join(tdir, 'sess-b', 'subagents', 'agent-x.jsonl'), [asst('bs1', '2026-11-10T00:10:00.000Z', { in: 1, out: 1, cw5: 2000000 })]);
  const r2 = run();
  const j2 = JSON.parse(r2.stdout);
  const b = j2.flagged.find((s) => s.session === 'sess-b');
  const codes = b ? b.signals.map((x) => x.code) : [];
  check(b && b.subagents === 1 && codes.includes('long-lived') && codes.includes('subagent-heavy'), 'long-lived-and-subagent', codes.join(','));
  check(b && b.subagentShare === 0.86, 'subagent-share', `share=${b && b.subagentShare}（子紀錄 2,000,000×1.25 ÷ 總 2,905,000 ≈ 0.86）`);

  // 審查者實跑找到的缺陷（2026-11-23）：①壓縮雙重計次 ②專案外不同檔被合併成假的重複讀 ③`..` 洩漏專案外檔名 ④workflows 底下的 subagent 沒掃 ⑤出處不帶路徑 ⑥沒 message.id 的列靜默丟掉
  const C = [
    userTxt('2026-11-10T01:00:00.000Z', '開工'),
    { type: 'user', timestamp: '2026-11-10T01:00:01.000Z', isCompactSummary: true, message: { role: 'user', content: '摘要' } },
    { type: 'system', timestamp: '2026-11-10T01:00:01.000Z', subtype: 'compact_boundary' },
    { type: 'user', timestamp: '2026-11-10T02:00:01.000Z', isCompactSummary: true, message: { role: 'user', content: '摘要二' } },
    { type: 'system', timestamp: '2026-11-10T02:00:01.000Z', subtype: 'compact_boundary' },
  ];
  for (let i = 0; i < 4; i++) C.push(asst('c' + i, '2026-11-10T03:0' + i + ':00.000Z', { in: 1, out: 1 }, [toolUse('rc' + i, 'Read', { file_path: 'C:/other-' + i + '/file.txt' })]));
  for (let i = 0; i < 4; i++) C.push(asst('d' + i, '2026-11-10T04:0' + i + ':00.000Z', { in: 1, out: 1 }, [toolUse('rd' + i, 'Read', { file_path: fwd + '/../escape/secret-name-' + i + '.txt' })]));
  C.push({ type: 'assistant', timestamp: '2026-11-10T05:00:00.000Z', message: { role: 'assistant', usage: usage({ in: 7, out: 7 }), content: [{ type: 'text', text: 'x' }] } });   // 有 usage 沒有 id
  put(path.join(tdir, 'sess-c.jsonl'), C);
  put(path.join(tdir, 'sess-c', 'subagents', 'workflows', 'wf_1', 'agent-deep.jsonl'), [asst('cw1', '2026-11-10T03:30:00.000Z', { in: 1, out: 1, cw5: 100000 })]);
  const rc = run();
  const jc = JSON.parse(rc.stdout);
  const c = jc.flagged.find((s) => s.session === 'sess-c');
  check(c && c.compactions === 2, 'compaction-counted-once', `compactions=${c && c.compactions}（兩次壓縮各留 summary 與 boundary 兩種標記，應為 2）`);
  check(c && c.repeatedReads.length === 0, 'outside-reads-not-merged', JSON.stringify(c && c.repeatedReads));
  check(!JSON.stringify(jc).includes('secret-name') && !JSON.stringify(jc).includes('escape'), 'dotdot-not-leaked', '用 .. 繞出專案的檔名不能出現');
  check(c && c.subagents === 1 && c.tokens.cacheCreate5m === 100000, 'nested-workflow-subagent-scanned', `subagents=${c && c.subagents} cw5m=${c && c.tokens.cacheCreate5m}`);
  check(jc.notes.some((n) => /沒有 message.id/.test(n)), 'dropped-rows-noted', jc.notes.filter((n) => /message.id/.test(n)).join(' | '));
  check(c && c.bigToolResultCount === 0, 'sanity-no-big-result', 'c 沒有大結果');
  // 4 次讀「同一個」專案外檔要算重複
  put(path.join(tdir, 'sess-e.jsonl'), [0, 1, 2, 3].map((i) => asst('e' + i, '2026-11-10T06:0' + i + ':00.000Z', { in: 1, out: 1 }, [toolUse('re' + i, 'Read', { file_path: 'C:/same/file.txt' })])));
  const je = JSON.parse(run().stdout);
  const e = je.flagged.find((s) => s.session === 'sess-e');
  check(e && e.repeatedReads.length === 1 && e.repeatedReads[0].n === 4 && e.repeatedReads[0].file === '（專案外）的某個檔', 'same-outside-file-still-repeated', JSON.stringify(e && e.repeatedReads));

  // ── 有 cc-statusline 明細檔（usd 模式）：金額、排名、拆分讀它；逐字紀錄只拿來診斷，金額用它的牌價 ──
  const proj = path.basename(tdir);
  const PR = { in: 4, out: 20, cw: 5, cw1h: 8, cr: 0.2, exact: true };    // opus-5-5 的牌價（與 cc-statusline 內建一致，這裡寫死當夾具）
  // sess-a 的逐字紀錄用這組牌價算出來是 0.7327：m1 0.01004、m2 0.00122、m3 0.00122、m4 0.72022
  const sessA = { id: 'sess-a', project: proj, cost: 0.7327, subCost: 0, requests: 4, first: '2026-11-10T01:00:01.000Z', last: '2026-11-10T03:10:00.000Z', models: { 'opus-5-5': 0.7327 },
    parts: { in: 0.0002, out: 0.0042, cw: 0.72, cr: 0.0004 }, tok: { in: 25, out: 210, cw: 91000, cr: 2000 }, startCtx: 1010, think: 100 };
  const sessOld = { id: 'sess-old', project: proj, cost: 5, subCost: 0, requests: 10, first: '2026-10-01T00:00:00.000Z', last: '2026-10-02T00:00:00.000Z', models: { 'opus-5-5': 5 }, parts: { in: 0, out: 1, cw: 2, cr: 2 }, tok: { in: 0, out: 0, cw: 0, cr: 0 }, startCtx: 30000, think: 0 };
  const sessOther = { id: 'sess-other', project: 'some-other-project', cost: 99, subCost: 0, requests: 1, first: '2026-11-10T00:00:00.000Z', last: '2026-11-10T00:00:00.000Z', models: { 'opus-5-5': 99 }, parts: { in: 0, out: 0, cw: 0, cr: 99 }, tok: { in: 0, out: 0, cw: 0, cr: 0 }, startCtx: 1, think: 0 };
  const mkDetail = (sessions, extra) => ({ v: 1, at: Date.now(), sig: 'fixture', prices: { 'opus-5-5': PR }, modelIds: { 'claude-opus-5-5': 'opus-5-5' },
    byProject: { [proj]: { cost: 5.7327, requests: 14, sessions: 2, byDay: { '2026-10-01': 5, '2026-11-10': 0.7327 }, models: { 'opus-5-5': 5.7327 }, parts: {} } },
    sessions, sessionsTotal: sessions.length, ...(extra || {}) });
  const dPath = path.join(tdir, 'detail.json');
  fs.writeFileSync(dPath, JSON.stringify(mkDetail([sessA, sessOld, sessOther])));
  const ru = run(['--since', '2026-11-01'], dPath);
  const ju = JSON.parse(ru.stdout);
  const ua = ju.flagged.find((s) => s.session === 'sess-a');
  check(ju.source === 'cc-statusline' && ju.unit === 'usd' && ju.weights === null, 'usd-mode', `source=${ju.source} unit=${ju.unit}`);
  check(ju.totals.sessions === 1 && ju.totals.cost === 0.73, 'usd-scope-project-and-since', `sessions=${ju.totals.sessions} cost=${ju.totals.cost}（另一個專案的 99 與範圍外的 5 不能算進來）`);
  check(ua && ua.cost === 0.73 && ua.models['opus-5-5'] === 0.73, 'usd-cost-from-detail', JSON.stringify(ua && { cost: ua.cost, models: ua.models }));
  check(ua && ua.cacheRebuilds.length === 1 && ua.cacheRebuilds[0].cost === 0.72, 'usd-rebuild-priced-with-detail-prices', JSON.stringify(ua && ua.cacheRebuilds));
  check(ua && ua.startCtx === 1010 && ua.startCtxIsOpening === true, 'usd-startctx-verified', `startCtx=${ua && ua.startCtx} opening=${ua && ua.startCtxIsOpening}（明細檔的值與逐字紀錄第一則的上下文一致）`);
  check(ju.breakdown && ju.breakdown.parts.cw === 0.72 && ju.breakdown.models['opus-5-5'].share === 1 && ju.breakdown.startup.medianCtxTokens === 1010, 'usd-breakdown', JSON.stringify(ju.breakdown).slice(0, 260));
  check(ju.byDay['2026-11-10'] && !ju.byDay['2026-10-01'] && ju.byDay['2026-11-10'].cost === 0.73, 'usd-byDay-filtered-by-since', JSON.stringify(ju.byDay));
  check(!JSON.stringify(ju).includes('sess-other') && !JSON.stringify(ju).includes('sess-old'), 'usd-other-sessions-excluded', '別的專案與範圍外的 session 不出現');
  check(ju.notes.some((n) => /API 等值金額/.test(n)) && !ju.notes.some((n) => /不分模型/.test(n)), 'usd-notes', ju.notes.join(' | ').slice(0, 200));

  // 明細檔金額與自己掃逐字紀錄差太多：以明細檔為準並明說
  fs.writeFileSync(dPath, JSON.stringify(mkDetail([{ ...sessA, cost: 1.5 }])));
  const jm = JSON.parse(run(['--since', '2026-11-01'], dPath).stdout);
  check(jm.flagged[0].cost === 1.5 && jm.notes.some((n) => /差 \d+%/.test(n)), 'usd-mismatch-noted', jm.notes.filter((n) => /差/.test(n)).join(' | ').slice(0, 200));
  // 明細檔裡沒有這個專案：退回比例模式並說明
  fs.writeFileSync(dPath, JSON.stringify({ ...mkDetail([]), byProject: { other: { cost: 1, byDay: {} } } }));
  const jn = JSON.parse(run(['--since', '2026-11-01'], dPath).stdout);
  check(jn.unit === 'units' && jn.notes.some((n) => /沒有這個專案/.test(n)), 'usd-project-missing-falls-back', jn.notes[0]);
  // 明細檔壞掉：退回
  fs.writeFileSync(dPath, '{壞掉');
  const jb = JSON.parse(run(['--since', '2026-11-01'], dPath).stdout);
  check(jb.unit === 'units' && jb.notes.some((n) => /讀不了 cc-statusline 明細檔/.test(n)), 'usd-bad-detail-falls-back', jb.notes[0]);
  // 逐字紀錄不見：還是有金額，註明沒有診斷
  fs.writeFileSync(dPath, JSON.stringify(mkDetail([{ ...sessA, id: 'sess-gone' }])));
  const jg = JSON.parse(run(['--since', '2026-11-01'], dPath).stdout);
  check(jg.flagged[0].cost === 0.73 && jg.flagged[0].diagnosis === 'missing' && jg.notes.some((n) => /找不到 session sess-go/.test(n)), 'usd-transcript-missing', jg.notes.filter((n) => /找不到/.test(n)).join(' | '));

  // --since：全部早於範圍 → 沒有 session，要明講沒資料
  const r3 = run(['--since', '2026-12-01']);
  const j3 = JSON.parse(r3.stdout);
  check(j3.totals.sessions === 0 && j3.notes.some((n) => /沒有資料/.test(n)), 'since-empty', j3.notes[0]);

  // 壞參數
  check(spawnSync(process.execPath, [SCRIPT, root, '--transcripts', path.join(tdir, 'nope')], { encoding: 'utf8' }).status === 2, 'bad-dir-exit-2', '找不到目錄要 exit 2');
  check((() => { const z = spawnSync(process.execPath, [SCRIPT, root, '--transcripts', __filename], { encoding: 'utf8' }); return z.status === 2 && /是目錄/.test(z.stderr); })(), 'file-as-dir-exit-2', '--transcripts 指到檔案要 exit 2');
  check((() => { const z = run(['--out', tdir]); return z.status === 2 && /寫不進/.test(z.stderr); })(), 'out-is-dir-exit-2', '--out 指到資料夾要 exit 2');
  check(run(['--since', '11/10']).status === 2, 'bad-since-exit-2', '日期格式錯要 exit 2');
} finally {
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tdir, { recursive: true, force: true });
}

// ── 第二批：每個情境自己一組專案與逐字紀錄目錄，互不影響 ──
const worlds = [];
function world(name) {
  const w = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'tsw-proj-')), base: fs.mkdtempSync(path.join(os.tmpdir(), 'tsw-tr-')) };
  worlds.push(w.root, w.base);
  w.tdir = path.join(w.base, name || 'C--work-demo'); fs.mkdirSync(w.tdir);
  w.detail = path.join(w.base, 'cc-statusline-usage-detail.json');     // 預設不存在＝比例模式
  w.a = (id, ts, u, o) => { const r = asst(id, ts, u, o && o.blocks, o && o.model); r.cwd = o && 'cwd' in o ? o.cwd : w.root; if (r.cwd == null) delete r.cwd; if (o && o.think != null) r.message.usage.output_tokens_details = { thinking_tokens: o.think }; return r; };
  w.put = (n, rows) => put(path.join(w.tdir, n), rows);
  w.setDetail = (d) => fs.writeFileSync(w.detail, JSON.stringify(d));
  w.spawn = (extra, o) => spawnSync(process.execPath, [...(o && o.pre ? ['-r', o.pre] : []), SCRIPT, w.root, '--transcripts', (o && o.tdir) || w.tdir, '--usage-detail', w.detail, ...(extra || [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  w.run = (extra, o) => { const r = w.spawn(extra, o); try { return { status: r.status, ...JSON.parse(r.stdout) }; } catch { return { status: r.status, err: String(r.stderr || '').slice(-300), totals: {}, byDay: {}, flagged: [], allSessions: [], notes: [] }; } };
  return w;
}
const P = { 'opus-5-5': { in: 4, out: 20, cw: 5, cw1h: 8, cr: 0.2, exact: true }, 'haiku-4-5': { in: 1, out: 5, cw: 1.25, cw1h: 2, cr: 0.1, exact: true } };
const IDS = { 'claude-opus-5-5': 'opus-5-5', 'claude-haiku-4-5': 'haiku-4-5' };
// 明細檔的一個 session：照 all-usage-refresh.js 寫出的欄位
const ds = (id, project, cost, o) => ({ id, project, cost, subCost: 0, requests: 1, first: '2026-11-10T01:00:00.000Z', last: '2026-11-10T02:00:00.000Z', models: { 'opus-5-5': cost }, parts: { in: 0, out: 0, cw: 0, cr: cost }, tok: { in: 0, out: 0, cw: 0, cr: 0 }, startCtx: null, think: 0, ...(o || {}) });
const detailOf = (project, sessions, byDay, o) => ({ v: 1, at: Date.now(), sig: 'x', prices: P, modelIds: IDS,
  byProject: { [project]: { cost: 0, requests: 0, sessions: sessions.length, byDay: byDay || { '2026-11-10': sessions.reduce((a, s) => a + s.cost, 0) }, models: {}, parts: {} } }, sessions, sessionsTotal: sessions.length, sessionsRest: { count: 0, cost: 0 }, ...(o || {}) });
const at = (i) => new Date(Date.UTC(2026, 10, 10, 1, 0, i)).toISOString();
const has = (j, re) => j.notes.some((n) => re.test(n));
const note = (j, re) => j.notes.filter((n) => re.test(n)).join(' | ').slice(0, 220);
const sig = (s) => s ? s.signals.map((x) => x.code) : [];
try {
  // 1 開場固定底只算主對話的回應與主對話的模型：主對話 5 則 opus（上下文 40000）＋subagent 300 則 haiku
  {
    const w = world(); const sub = [];
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 40000 }), ...[1, 2, 3, 4].map((i) => w.a('m' + i, at(i), { rd: 40000, out: 10 }))]);
    for (let i = 0; i < 300; i++) sub.push(w.a('u' + i, at(10 + i), { rd: 70000 }, { model: 'claude-haiku-4-5' }));
    w.put('s1/subagents/agent-x.jsonl', sub);
    // 主：0.2 + 4×(0.008+0.0002)=0.2328；sub：300×0.007=2.1
    w.setDetail(detailOf('C--work-demo', [ds('s1', 'C--work-demo', 2.3328, { subCost: 2.1, requests: 305, models: { 'haiku-4-5': 2.1, 'opus-5-5': 0.2328 }, startCtx: 40000 })]));
    const s = w.run().flagged[0];
    check(s && s.startupFloorCost === 0.04 && s.startupFloorShare === 0.02 && !sig(s).includes('startup-heavy'), 'startup-floor-main-only', `cost=${s && s.startupFloorCost} share=${s && s.startupFloorShare}（5×40000×0.2/1e6＝0.04；算進 subagent 或用 haiku 牌價都不對）`);
    check(s && s.mainRequests === 5 && s.requests === 305 && s.scannedRequests === 305, 'main-requests-counted', `main=${s && s.mainRequests} requests=${s && s.requests}`);
    // subagent 用便宜模型、主對話很短：占比不得超過 1
    w.setDetail(detailOf('C--work-demo', [ds('s1', 'C--work-demo', 0.01, { subCost: 0.009, requests: 305, startCtx: 40000 })]));
    const s2 = w.run().flagged[0];
    check(s2 && s2.startupFloorShare <= 1 && s2.startupFloorCost <= 0.01, 'startup-share-capped', `share=${s2 && s2.startupFloorShare} cost=${s2 && s2.startupFloorCost}`);
  }
  // 2 大小寫：落點換算的目錄名 c--work-demo，明細檔是 C--work-demo
  {
    const w = world('c--work-demo');
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 100000 })]);
    w.setDetail(detailOf('C--work-demo', [ds('s1', 'C--work-demo', 0.5, { startCtx: 100000 })]));
    const pre = path.join(w.base, 'pre.js');
    const plat = (p) => { fs.writeFileSync(pre, `Object.defineProperty(process, 'platform', { value: '${p}' });`); return w.run([], { pre }); };
    const win = plat('win32'), mac = plat('darwin'), lin = plat('linux');
    check(win.unit === 'usd' && win.totals.sessions === 1 && mac.unit === 'usd' && mac.totals.sessions === 1, 'project-case-insensitive-win-mac', `win=${win.unit}/${win.totals.sessions} mac=${mac.unit}/${mac.totals.sessions}`);
    check(lin.unit === 'units' && has(lin, /沒有這個專案/), 'project-case-sensitive-linux', `linux=${lin.unit}`);
  }
  // 3 totals.cost 是範圍內的；整個 session 的另列，breakdown 標明口徑
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 100000 })]);
    w.setDetail(detailOf('C--work-demo', [ds('s1', 'C--work-demo', 10, { first: '2026-10-01T00:00:00.000Z', startCtx: 100000 })], { '2026-10-01': 8, '2026-11-10': 2 }));
    const j = w.run(['--since', '2026-11-01']);
    check(j.totals.cost === 2 && j.totals.dayCost === 2 && j.totals.sessionsFullCost === 10, 'totals-in-range', JSON.stringify(j.totals));
    check(!!(j.fields && j.fields['totals.sessionsFullCost']) && /整個/.test((j.breakdown || {}).scope || '') && has(j, /跟別次健檢比就比這些/), 'scope-explained', note(j, /別次健檢/));
  }
  // 6 <synthetic> 列：不是找不到牌價、不算回應；找不到牌價的只數一次
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 100000 }), w.a('syn', at(1), {}, { model: '<synthetic>' }), w.a('weird', at(2), { in: 10 }, { model: 'claude-unknown-9' })]);
    w.setDetail(detailOf('C--work-demo', [ds('s1', 'C--work-demo', 0.5, { requests: 1, startCtx: 100000 })]));
    const j = w.run();
    check(has(j, /有 1 則回應的模型在 cc-statusline 的牌價表裡找不到/), 'synthetic-not-unpriced', note(j, /牌價表/) || '（沒有這條 note）');
    check(j.flagged[0] && j.flagged[0].requests === j.allSessions[0].requests && j.flagged[0].requests === 1, 'requests-consistent', `flagged=${j.flagged[0] && j.flagged[0].requests} all=${j.allSessions[0] && j.allSessions[0].requests}`);
    fs.rmSync(w.detail); const u = w.run();
    check(u.flagged[0] && u.flagged[0].requests === 2 && u.allSessions[0].requests === 2, 'synthetic-not-counted-units', `requests=${u.flagged[0] && u.flagged[0].requests}`);
  }
  // 7 便宜的 session：先捨入到分再比會冒出假的金額差；startup 占比也要用沒捨入的值
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', at(0), { rd: 70000 })]);                      // 0.014
    w.setDetail(detailOf('C--work-demo', [ds('s1', 'C--work-demo', 0.014, { startCtx: 70000 })]));
    const j = w.run(); const s = j.flagged[0];
    check(!has(j, /差 \d+%/), 'cheap-session-no-false-diff', note(j, /差 \d+%/) || '沒有假的金額差');
    check(s && s.startupFloorShare === 1, 'startup-share-unrounded', `share=${s && s.startupFloorShare}（0.014/0.014＝1；捨入成 0.01 再算會是 0.71）`);
    // 真的差 2 分錢（差 1 倍但金額太小）：不說
    w.setDetail(detailOf('C--work-demo', [ds('s1', 'C--work-demo', 0.034, { startCtx: 70000 })]));
    const j2 = w.run();
    check(!has(j2, /差 \d+%/), 'diff-absolute-floor', note(j2, /差 \d+%/) || '差 0.02 美元不說');
  }
  // 8 沒壓縮過：上下文要夠大，次數與壓縮都只算主對話
  {
    const w = world(); const many = (p, ctx, n) => Array.from({ length: n }, (_, i) => w.a(p + i, at(i), { rd: ctx }));
    w.put('small.jsonl', many('a', 3000, 40));
    w.put('big.jsonl', many('b', 150000, 40));
    w.put('few.jsonl', many('c', 150000, 5)); w.put('few/subagents/agent-1.jsonl', many('d', 10, 60));
    w.put('subcomp.jsonl', many('e', 150000, 40)); w.put('subcomp/subagents/agent-1.jsonl', [w.a('f0', at(0), { rd: 5 }), { type: 'system', subtype: 'compact_boundary', timestamp: at(1), cwd: w.root }]);
    const j = w.run(); const c = (id) => sig(j.flagged.find((s) => s.session === id)).includes('context-never-compacted');
    check(!c('small'), 'never-compacted-needs-size', `小上下文 40 次回應：${c('small')}`);
    check(c('big') && !c('few') && c('subcomp'), 'never-compacted-main-only', `big=${c('big')} few(主 5 次＋子 60 次)=${c('few')} subcomp(壓縮發生在 subagent)=${c('subcomp')}`);
  }
  // 9 比例模式也算輸出占比、開場固定底、thinking
  {
    const w = world();
    w.put('out.jsonl', [w.a('o0', at(0), { in: 10, out: 10000 }, { think: 8000 })]);
    w.put('start.jsonl', Array.from({ length: 10 }, (_, i) => w.a('t' + i, at(i), i ? { rd: 50000 } : { cw5: 50000 })));
    const j = w.run(); const o = sig(j.flagged.find((s) => s.session === 'out')), st = sig(j.flagged.find((s) => s.session === 'start'));
    check(o.includes('output-heavy') && o.includes('think-heavy'), 'units-output-and-think', o.join(','));
    check(st.includes('startup-heavy'), 'units-startup-heavy', st.join(','));
    check(has(j, /比例模式的訊號限制/), 'units-signal-limits-noted', note(j, /訊號限制/));
    fs.rmSync(path.join(w.tdir, 'out.jsonl'));
    check(has(w.run(), /沒有 thinking token 欄位/), 'units-no-think-field-noted', '逐字紀錄沒有 thinking 欄位時要說 think-heavy 不會出現');
  }
  // 10 比例模式 byDay 照每則回應的日期分，不得早於 --since
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', '2026-10-20T04:00:00.000Z', { in: 1000 }), w.a('m1', '2026-11-10T04:00:00.000Z', { in: 10 }), w.a('m2', '2026-11-11T04:00:00.000Z', { in: 20 })]);
    const j = w.run(['--since', '2026-11-01']);
    check(JSON.stringify(Object.keys(j.byDay)) === '["2026-11-10","2026-11-11"]' && j.byDay['2026-11-10'].cost === 10 && j.byDay['2026-11-11'].cost === 20, 'units-byday-per-response', JSON.stringify(j.byDay));
    check(j.totals.cost === 30 && j.totals.sessionsFullCost === 1030, 'units-totals-in-range', JSON.stringify(j.totals));
  }
  // 11 主檔與 subagent 檔的同一則只算一次；跨 session 複製不去重但要說
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', at(0), { in: 100 }), w.a('dup', at(1), { in: 50 })]);
    w.put('s1/subagents/agent-1.jsonl', [w.a('dup', at(1), { in: 50 })]);
    w.put('s2.jsonl', [w.a('m0', at(0), { in: 100 }), w.a('n1', at(5), { in: 1 })]);      // fork：複製了 s1 的 m0
    const j = w.run(); const s = j.flagged.find((x) => x.session === 's1');
    check(s && s.requests === 2 && s.cost === 150, 'units-dedupe-main-and-subagent', `requests=${s && s.requests} cost=${s && s.cost}`);
    check(has(j, /resume／fork/) && has(j, /有 1 則回應在別的 session 檔也出現過/), 'units-fork-duplicates-noted', note(j, /fork/));
  }
  // 12 分叉 session：明細檔的 startCtx 是分叉後那一則，不是開場固定底
  {
    const w = world();
    w.put('orig.jsonl', [w.a('m0', at(0), { cw5: 20000 }), w.a('m1', at(1), { rd: 20000 })]);
    w.put('fork.jsonl', [w.a('m0', at(0), { cw5: 20000 }), w.a('m1', at(1), { rd: 20000 }), w.a('m2', at(2), { rd: 170000 })]);
    w.put('cont.jsonl', [{ type: 'user', isCompactSummary: true, timestamp: at(0), cwd: w.root, message: { role: 'user', content: '摘要' } }, w.a('k0', at(1), { cw5: 60000 })]);
    w.setDetail(detailOf('C--work-demo', [ds('orig', 'C--work-demo', 0.104, { startCtx: 20000 }), ds('fork', 'C--work-demo', 0.034, { startCtx: 170000 }), ds('cont', 'C--work-demo', 0.3, { startCtx: 60000 })]));
    const j = w.run(); const f = j.flagged.find((s) => s.session === 'fork');
    check(f && f.startCtxIsOpening === false && f.startupFloorCost === null && !sig(f).includes('startup-heavy'), 'fork-startctx-not-opening', `opening=${f && f.startCtxIsOpening} floor=${f && f.startupFloorCost}`);
    const st = (j.breakdown || {}).startup || {};
    check(st.sessions === 1 && st.medianCtxTokens === 20000 && st.excludedNotOpening === 2, 'fork-excluded-from-median', JSON.stringify(st));
    check(has(j, /檔名排序/) && has(j, /有 2 個 session 的開場上下文/), 'fork-noted', note(j, /檔名排序/));
  }
  // 13 明細只列花最多的：這個專案的 session 被截掉時不能說沒有資料
  {
    const w = world(); const d = detailOf('C--work-demo', [ds('zz', 'other', 99)], { '2026-11-10': 3 }, { sessionsTotal: 1600, sessionsRest: { count: 1599, cost: 20 } });
    d.byProject['C--work-demo'].sessions = 4; w.setDetail(d);
    const j = w.run(['--since', '2026-11-01']);
    check(!has(j, /沒有資料/) && has(j, /這個專案有 4 個花費較少的沒列/) && j.totals.cost === 3, 'truncated-sessions-noted', j.notes.join(' | ').slice(0, 260));
  }
  // 14 總額檔說明細寫入失敗
  {
    const w = world(); w.put('s1.jsonl', [w.a('m0', at(0), { in: 1 })]);
    fs.writeFileSync(path.join(w.base, 'cc-statusline-all-usage.json'), JSON.stringify({ at: Date.now(), sig: 'x', cost: 1, detailFailed: true }));
    const j = w.run();
    check(j.unit === 'units' && has(j, /明細寫入失敗/) && !has(j, /沒裝 cc-statusline/), 'detail-write-failed-noted', note(j, /明細/));
  }
  // 15 讀不了的逐字紀錄要說；大檔逐塊讀，列跨塊、多位元組字元跨塊都不能壞
  {
    const w = world(); fs.mkdirSync(path.join(w.tdir, 'isdir.jsonl'));
    w.put('s1.jsonl', [w.a('m0', at(0), { in: 1 })]);
    const j = w.run();
    check(has(j, /讀不了/) && has(j, /isdir\.jsonl/), 'unreadable-noted', note(j, /讀不了/) || '（沒有這條 note）');
    const pad = '中文字'.repeat(3001); const rows = [];
    for (let i = 0; i < 400; i++) rows.push(w.a('b' + i, at(i), { in: 1 }, { blocks: [{ type: 'text', text: pad + 'x'.repeat(i % 7) }] }));
    put(path.join(w.tdir, 'big.jsonl'), rows);
    fs.writeFileSync(path.join(w.tdir, 'notail.jsonl'), JSON.stringify(w.a('q0', at(0), { in: 7 })));   // 最後一列沒有換行
    const j2 = w.run(); const b = j2.flagged.find((s) => s.session === 'big'), q = j2.flagged.find((s) => s.session === 'notail');
    check(b && b.requests === 400 && !has(j2, /解析失敗/) && q && q.cost === 7, 'chunked-read-intact', `big=${b && b.requests}（檔 ${Math.round(fs.statSync(path.join(w.tdir, 'big.jsonl')).size / 1e6)} MB）notail=${q && q.cost}`);
  }
  // 16 內容區塊是 null、明細檔缺欄位：不拋例外
  {
    const w = world();
    w.put('s1.jsonl', ['null', '5', w.a('m0', at(0), { in: 1 }, { blocks: [null, { type: 'text', text: 'x' }] }), { type: 'user', timestamp: at(1), cwd: w.root, message: { role: 'user', content: [null, { type: 'tool_result', tool_use_id: 't', content: [null] }] } }, { type: 'assistant', timestamp: at(2), cwd: w.root, message: null }, { type: 'assistant', timestamp: 'bad', cwd: w.root, message: { id: 'z', usage: null } }]);
    const j = w.run();
    check(j.status === 0 && j.flagged[0] && j.flagged[0].requests === 1, 'null-blocks-no-throw', `exit ${j.status} ${j.err || ''}`);
    w.setDetail({ v: 1, byProject: { 'C--work-demo': {} }, sessions: [null, { id: 's1', project: 'C--work-demo', last: '2026-11-10T02:00:00.000Z' }, { project: 'C--work-demo', last: '2026-11-10T02:00:00.000Z' }] });
    const k = w.run();
    check(k.status === 0 && k.unit === 'usd' && k.totals.cost === null && k.totals.sessions === 1, 'detail-missing-fields-no-throw', `exit ${k.status} cost=${k.totals.cost} sessions=${k.totals.sessions} ${k.err || ''}`);
  }
  // 17 不同落點換算成同一個目錄名：照 cwd 過濾
  {
    const w = world(); const other = path.join(w.base, 'elsewhere');
    w.put('mine.jsonl', [w.a('m0', at(0), { in: 100 }), w.a('m1', at(1), { in: 1000 }, { cwd: other }), w.a('m2', at(2), { in: 5 }, { cwd: path.join(w.root, 'sub') })]);
    w.put('other.jsonl', [w.a('o0', at(0), { in: 7777 }, { cwd: other })]);
    w.put('mine/subagents/agent-1.jsonl', [w.a('p0', at(3), { in: 3333 }, { cwd: other })]);
    const j = w.run();
    check(j.totals.sessions === 1 && j.flagged[0].cost === 105, 'cwd-filtered', `sessions=${j.totals.sessions} cost=${j.flagged[0] && j.flagged[0].cost}（100＋5；別的 cwd 的列、session、subagent 都不算）`);
    check(has(j, /略過 1 個別的專案的 session/) && has(j, /中途切到別的專案/) && has(j, /subagent 紀錄/), 'cwd-filter-noted', note(j, /別的專案/));
    w.setDetail(detailOf('C--work-demo', [ds('mine', 'C--work-demo', 1), ds('other', 'C--work-demo', 50)]));
    const k = w.run();
    check(k.totals.sessions === 1 && has(k, /按目錄名加總、拆不開/), 'usd-collision-noted', note(k, /拆不開/) || JSON.stringify(k.totals));
  }
  // 18 找不到目錄：exit 2、說清楚原因與怎麼補
  {
    const w = world(); const r = w.spawn([], { tdir: path.join(w.base, 'nope') });
    check(r.status === 2 && /--transcripts <目錄>/.test(r.stderr) && /沒有產生結果檔/.test(r.stderr), 'missing-dir-explained', String(r.stderr).replace(/\s+/g, ' ').slice(0, 200));
  }
} finally { for (const d of worlds) fs.rmSync(d, { recursive: true, force: true }); }
console.log(`合計 PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
