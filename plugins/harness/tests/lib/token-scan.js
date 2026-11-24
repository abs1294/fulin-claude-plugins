#!/usr/bin/env node
// /harness:review 的 token 花費腳本（skills/review/scripts/token-scan.js）回歸測試。
// 夾具照真實逐字紀錄的形狀合成（assistant 列有 message.id 與 usage，同一個 id 因內容區塊拆成多列），不放真實紀錄。
// 用量紀錄一律由 cc-statusline 的 lib-records.js collect() 從合成的逐字紀錄產生（假的家目錄）；明細檔有兩種：
// refresh() 由 all-usage-refresh.js 產生（端到端），setDetail() 手寫（要測明細檔的特殊情況時）。
//
// 用法：node plugins/harness/tests/lib/token-scan.js   → 每項印一行 `PASS|FAIL <項目>｜<證據>`，有 FAIL 時 exit 1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'review', 'scripts', 'token-scan.js');
const CCS = path.resolve(__dirname, '..', '..', '..', 'cc-statusline', 'scripts'), LIB = path.join(CCS, 'lib-records.js');
if (!fs.existsSync(LIB)) { console.log('略過｜旁邊沒有 cc-statusline（要在 repo 裡跑）：' + LIB); process.exit(0); }
let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}｜${detail}`); };
const put = (p, rows) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n'); };
const usage = (o) => ({ input_tokens: o.in || 0, output_tokens: o.out || 0, cache_read_input_tokens: o.rd || 0, cache_creation_input_tokens: (o.cw5 || 0) + (o.cw1 || 0), cache_creation: { ephemeral_5m_input_tokens: o.cw5 || 0, ephemeral_1h_input_tokens: o.cw1 || 0 } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const userRes = (ts, id, n) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'a'.repeat(n) }] } });
const userTxt = (ts, t) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: t } });

// 每個情境自己一組專案、家目錄（逐字紀錄、用量紀錄、明細檔），互不影響
const worlds = [];
function world(name) {
  const w = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'tsw-proj-')), home: fs.mkdtempSync(path.join(os.tmpdir(), 'tsw-home-')) };
  worlds.push(w.root, w.home);
  w.proj = name || 'C--work-demo';
  w.tdir = path.join(w.home, '.claude', 'projects', w.proj); fs.mkdirSync(w.tdir, { recursive: true });
  w.usage = path.join(w.home, '.claude', 'usage-data'); w.records = path.join(w.usage, 'records'); w.detail = path.join(w.usage, 'cc-statusline-usage-detail.json');
  const env = { ...process.env, HOME: w.home, USERPROFILE: w.home };
  w.a = (id, ts, u, o) => {
    const r = { type: 'assistant', timestamp: ts, entrypoint: 'cli', cwd: w.root, message: { id, model: (o && o.model) || 'claude-opus-5-5', role: 'assistant', usage: usage(u), content: (o && o.blocks) || [{ type: 'text', text: 'x' }] } };
    if (o && 'cwd' in o) { r.cwd = o.cwd; if (r.cwd == null) delete r.cwd; }
    if (o && o.think != null) r.message.usage.output_tokens_details = { thinking_tokens: o.think };
    return r;
  };
  w.put = (n, rows) => put(path.join(w.tdir, n), rows);
  // 從頭收一次用量紀錄
  w.collect = () => { fs.rmSync(w.records, { recursive: true, force: true }); const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(LIB)}).collect()`], { env, encoding: 'utf8' }); if (r.status !== 0 || !fs.existsSync(path.join(w.records, 'meta.json'))) throw new Error('collect 失敗：' + r.stderr); };
  // 從頭收一次，再由 cc-statusline 匯總出明細檔
  w.refresh = () => { fs.rmSync(w.usage, { recursive: true, force: true }); const r = spawnSync(process.execPath, [path.join(CCS, 'all-usage-refresh.js')], { env, encoding: 'utf8' }); if (r.status !== 0 || !fs.existsSync(w.detail)) throw new Error('all-usage-refresh 失敗：' + r.stderr); };
  w.setDetail = (d) => { fs.mkdirSync(w.usage, { recursive: true }); fs.writeFileSync(w.detail, typeof d === 'string' ? d : JSON.stringify(d)); };
  w.setMeta = (d) => fs.writeFileSync(path.join(w.records, 'meta.json'), typeof d === 'string' ? d : JSON.stringify(d));
  w.spawn = (extra, o) => spawnSync(process.execPath, [...(o && o.pre ? ['-r', o.pre] : []), SCRIPT, w.root, '--transcripts', (o && o.tdir) || w.tdir, '--usage-detail', w.detail, '--records', w.records, ...(extra || [])], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  w.run = (extra, o) => { const r = w.spawn(extra, o); try { return { status: r.status, ...JSON.parse(r.stdout) }; } catch { return { status: r.status, err: String(r.stderr || '').slice(-300), totals: {}, byDay: {}, flagged: [], allSessions: [], notes: [] }; } };
  return w;
}
const P = { 'opus-5-5': { in: 4, out: 20, cw: 5, cw1h: 8, cr: 0.2, exact: true }, 'haiku-4-5': { in: 1, out: 5, cw: 1.25, cw1h: 2, cr: 0.1, exact: true } };
const IDS = { 'claude-opus-5-5': 'opus-5-5', 'claude-haiku-4-5': 'haiku-4-5' };
// 手寫的明細檔的一個 session：照 all-usage-refresh.js 寫出的欄位
const ds = (id, project, cost, o) => ({ id, project, cost, subCost: 0, requests: 1, first: '2026-11-10T01:00:00.000Z', last: '2026-11-10T02:00:00.000Z', models: { 'opus-5-5': cost }, parts: { in: 0, out: 0, cw: 0, cr: cost }, tok: { in: 0, out: 0, cw: 0, cr: 0 }, startCtx: null, think: 0, ...(o || {}) });
const detailOf = (project, sessions, byDay, o) => ({ v: 1, at: Date.now(), sig: 'x', prices: P, modelIds: IDS,
  byProject: { [project]: { cost: 0, requests: 0, sessions: sessions.length, byDay: byDay || { '2026-11-10': sessions.reduce((a, s) => a + s.cost, 0) }, models: {}, parts: {} } }, sessions, sessionsTotal: sessions.length, sessionsRest: { count: 0, cost: 0 }, ...(o || {}) });
const at = (i) => new Date(Date.UTC(2026, 10, 10, 1, 0, i)).toISOString();
const has = (j, re) => j.notes.some((n) => re.test(n));
const note = (j, re) => j.notes.filter((n) => re.test(n)).join(' | ').slice(0, 220);
const sig = (s) => s ? s.signals.map((x) => x.code) : [];
const by = (j, id) => j.flagged.find((s) => s.session === id);
try {
  // ── 端到端：逐字紀錄 → collect → 匯總 → token-scan ──
  {
    const w = world(), fwd = w.root.split(path.sep).join('/');
    // 一般 session：四個 message.id，第一個拆成兩列（只算一次，第二列的工具呼叫仍要算）；一次重建（閒置 2 小時後）、一個大工具結果、同檔讀 4 次
    const f = path.join(fwd, 'src', 'a.js');
    w.put('sess-a.jsonl', [
      userTxt('2026-11-10T01:00:00.000Z', '開工'),
      w.a('m1', '2026-11-10T01:00:01.000Z', { in: 10, out: 100, cw1: 1000, rd: 0 }, { blocks: [toolUse('t1', 'Read', { file_path: f })] }),
      w.a('m1', '2026-11-10T01:00:01.500Z', { in: 10, out: 100, cw1: 1000, rd: 0 }, { blocks: [toolUse('t2', 'Read', { file_path: f })] }),
      userRes('2026-11-10T01:00:02.000Z', 't2', 30000),
      w.a('m2', '2026-11-10T01:00:05.000Z', { in: 5, out: 50, rd: 1000 }, { blocks: [toolUse('t3', 'Read', { file_path: f })] }),
      '', '{這行壞掉',
      w.a('m3', '2026-11-10T01:00:06.000Z', { in: 5, out: 50, rd: 1000 }, { blocks: [toolUse('t4', 'Read', { file_path: f }), toolUse('t5', 'Read', { file_path: 'C:/elsewhere/secret-name.txt' })] }),
      w.a('m4', '2026-11-10T03:10:00.000Z', { in: 5, out: 10, cw1: 90000, rd: 0 }),          // 閒置 2 小時後整段重建
    ]);
    w.refresh();
    const out = path.join(w.home, 'out.json'), r = w.spawn(['--out', out]);
    check(r.status === 0, 'exit-0', `exit ${r.status} ${String(r.stderr || '').slice(0, 200)}`);
    const j = JSON.parse(fs.readFileSync(out, 'utf8')), a = j.flagged[0] || {};
    check(j.source === 'cc-statusline' && j.unit === 'usd' && j.noData === null && !('weights' in j) && j.usageDetailAt && j.recordsAt, 'source', `source=${j.source} unit=${j.unit} noData=${j.noData} recordsAt=${j.recordsAt}`);
    check(j.totals.sessions === 1 && a.requests === 4 && a.scannedRequests === 4, 'dedupe-by-message-id', `requests=${a.requests} scanned=${a.scannedRequests}（同一個 message.id 拆成兩列只算一次，應為 4）`);
    const T = a.scannedTokens || {};
    check(T.input === 25 && T.output === 210 && a.tokens.in === 25 && a.tokens.out === 210, 'sum-input-output', JSON.stringify([T, a.tokens]));
    check(T.cacheCreate1h === 91000 && T.cacheCreate5m === 0 && T.cacheRead === 2000, 'sum-cache', JSON.stringify(T));
    // 牌價 opus-5-5：m1 0.01004、m2 0.00122、m3 0.00122、m4 0.72022
    check(a.cost === 0.73 && a.scannedCost === 0.73 && j.totals.cost === 0.73, 'cost-from-records', `cost=${a.cost} scanned=${a.scannedCost} totals=${j.totals.cost}（應為 0.7327）`);
    check(a.cacheRebuilds && a.cacheRebuilds.length === 1 && a.cacheRebuilds[0].afterIdleOver1h === true && a.cacheRebuilds[0].at === 'sess-a.jsonl:9' && a.cacheRebuilds[0].cost === 0.72, 'cache-rebuild-after-idle', JSON.stringify(a.cacheRebuilds));
    check(a.bigToolResultCount === 1 && a.bigToolResults[0].tool === 'Read', 'big-tool-result', JSON.stringify(a.bigToolResults) + '（t2 在同一則的第二列）');
    check(a.repeatedReads.length === 1 && a.repeatedReads[0].file === 'src/a.js' && a.repeatedReads[0].n === 4, 'repeated-read-relative-path', JSON.stringify(a.repeatedReads) + '（同一則拆成兩列，兩列的工具呼叫都要算）');
    check(a.startCtx === 1010 && a.startCtxIsOpening === true, 'startctx-verified', `startCtx=${a.startCtx} opening=${a.startCtxIsOpening}`);
    check(!JSON.stringify(j).includes('secret-name') && !JSON.stringify(j).includes('elsewhere'), 'outside-path-not-leaked', '專案外的檔名不能出現在輸出');
    check(has(j, /1 行解析失敗/) && !has(j, /對不到那一列/), 'bad-line-noted', note(j, /解析失敗/) + '（壞掉的列與空白列之後的行號仍對得到）');
    check(!JSON.stringify(j).includes('開工'), 'no-user-text', '使用者發言原文不能出現在輸出');
    check(!has(j, /差 \d+%/), 'totals-agree', note(j, /差 \d+%/) || '明細檔與對到的紀錄一致');
    check(/API 等值金額/.test(j.notes.join()) && !/比例|不分模型|倍率/.test(j.notes.join()), 'notes', j.notes.join(' | ').slice(0, 160));

    // 長壽＋subagent：跨 3 天、subagent 占比高
    w.put('sess-b.jsonl', [w.a('b1', '2026-11-10T00:00:00.000Z', { in: 1, out: 1, cw5: 300000 }), w.a('b2', '2026-11-13T00:00:00.000Z', { in: 1, out: 1, rd: 300000 })]);
    w.put('sess-b/subagents/agent-x.jsonl', [w.a('bs1', '2026-11-10T00:10:00.000Z', { in: 1, out: 1, cw5: 2000000 })]);
    w.refresh();
    const b = by(w.run(), 'sess-b');
    check(b && b.subagents === 1 && sig(b).includes('long-lived') && sig(b).includes('subagent-heavy'), 'long-lived-and-subagent', sig(b).join(','));
    check(b && b.subagentShare === 0.87 && b.scannedCost === 11.56, 'subagent-share', `share=${b && b.subagentShare} scanned=${b && b.scannedCost}（子紀錄 10 ÷ 總 11.56）`);

    // 審查者實跑找到的缺陷（2026-11-23）：①壓縮雙重計次 ②專案外不同檔被合併成假的重複讀 ③`..` 洩漏專案外檔名 ④workflows 底下的 subagent 沒掃 ⑤出處不帶路徑 ⑥沒 message.id 的列
    const C = [
      userTxt('2026-11-10T01:00:00.000Z', '開工'),
      { type: 'user', timestamp: '2026-11-10T01:00:01.000Z', isCompactSummary: true, message: { role: 'user', content: '摘要' } },
      { type: 'system', timestamp: '2026-11-10T01:00:01.000Z', subtype: 'compact_boundary' },
      { type: 'user', timestamp: '2026-11-10T02:00:01.000Z', isCompactSummary: true, message: { role: 'user', content: '摘要二' } },
      { type: 'system', timestamp: '2026-11-10T02:00:01.000Z', subtype: 'compact_boundary' },
    ];
    for (let i = 0; i < 4; i++) C.push(w.a('c' + i, '2026-11-10T03:0' + i + ':00.000Z', { in: 1, out: 1 }, { blocks: [toolUse('rc' + i, 'Read', { file_path: 'C:/other-' + i + '/file.txt' })] }));
    for (let i = 0; i < 4; i++) C.push(w.a('d' + i, '2026-11-10T04:0' + i + ':00.000Z', { in: 1, out: 1 }, { blocks: [toolUse('rd' + i, 'Read', { file_path: fwd + '/../escape/secret-name-' + i + '.txt' })] }));
    C.push({ type: 'assistant', timestamp: '2026-11-10T05:00:00.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', usage: usage({ in: 7, out: 7 }), content: [{ type: 'text', text: 'x' }] } });   // 有 usage 沒有 id
    w.put('sess-c.jsonl', C);
    w.put('sess-c/subagents/workflows/wf_1/agent-deep.jsonl', [w.a('cw1', '2026-11-10T03:30:00.000Z', { in: 1, out: 1, cw5: 100000 })]);
    // 4 次讀「同一個」專案外檔要算重複
    w.put('sess-e.jsonl', [0, 1, 2, 3].map((i) => w.a('e' + i, '2026-11-10T06:0' + i + ':00.000Z', { in: 1, out: 1 }, { blocks: [toolUse('re' + i, 'Read', { file_path: 'C:/same/file.txt' })] })));
    w.refresh();
    const jc = w.run(), c = by(jc, 'sess-c'), e = by(jc, 'sess-e');
    check(c && c.compactions === 2, 'compaction-counted-once', `compactions=${c && c.compactions}（兩次壓縮各留 summary 與 boundary 兩種標記，應為 2）`);
    check(c && c.repeatedReads.length === 0, 'outside-reads-not-merged', JSON.stringify(c && c.repeatedReads));
    check(!JSON.stringify(jc).includes('secret-name') && !JSON.stringify(jc).includes('escape'), 'dotdot-not-leaked', '用 .. 繞出專案的檔名不能出現');
    check(c && c.subagents === 1 && c.scannedTokens.cacheCreate5m === 100000, 'nested-workflow-subagent-scanned', `subagents=${c && c.subagents} cw5m=${c && c.scannedTokens.cacheCreate5m}`);
    check(c && c.requests === 10 && c.scannedRequests === 10 && c.scannedTokens.input === 16, 'row-without-id-counted', `requests=${c && c.requests} scanned=${c && c.scannedRequests}（8 則＋subagent 1 則＋沒有 message.id 的 1 則）`);
    check(c && c.bigToolResultCount === 0, 'sanity-no-big-result', 'c 沒有大結果');
    check(e && e.repeatedReads.length === 1 && e.repeatedReads[0].n === 4 && e.repeatedReads[0].file === '（專案外）的某個檔', 'same-outside-file-still-repeated', JSON.stringify(e && e.repeatedReads));
    check(jc.breakdown.parts.cw > 0 && Math.abs(Object.values(jc.breakdown.parts).reduce((x, y) => x + y, 0) - jc.totals.sessionsFullCost) < 0.02 && jc.breakdown.models['opus-5-5'].share === 1, 'breakdown', JSON.stringify(jc.breakdown).slice(0, 260));

    // --since：全部早於範圍 → 沒有 session，要明講沒資料
    const j3 = w.run(['--since', '2026-12-01']);
    check(j3.totals.sessions === 0 && has(j3, /沒有資料/) && j3.noData === null, 'since-empty', note(j3, /沒有資料/));

    // ── 手寫的明細檔：排名、總額、範圍都照它 ──
    const sessA = ds('sess-a', w.proj, 0.7327, { requests: 4, first: '2026-11-10T01:00:01.000Z', last: '2026-11-10T03:10:00.000Z', parts: { in: 0.0002, out: 0.0042, cw: 0.72, cr: 0.0004 }, tok: { in: 25, out: 210, cw: 91000, cr: 2000 }, startCtx: 1010, think: 100 });
    const sessOld = ds('sess-old', w.proj, 5, { first: '2026-10-01T00:00:00.000Z', last: '2026-10-02T00:00:00.000Z', startCtx: 30000 }), sessOther = ds('sess-other', 'some-other-project', 99);
    const mk = (sessions, extra) => detailOf(w.proj, sessions, { '2026-10-01': 5, '2026-11-10': 0.7327 }, extra);
    w.setDetail(mk([sessA, sessOld, sessOther]));
    const ju = w.run(['--since', '2026-11-01']), ua = by(ju, 'sess-a');
    check(ju.totals.sessions === 1 && ju.totals.cost === 0.73, 'scope-project-and-since', `sessions=${ju.totals.sessions} cost=${ju.totals.cost}（另一個專案的 99 與範圍外的 5 不能算進來）`);
    check(ua && ua.cost === 0.73 && ua.models['opus-5-5'] === 0.73, 'cost-from-detail', JSON.stringify(ua && { cost: ua.cost, models: ua.models }));
    check(ju.breakdown && ju.breakdown.parts.cw === 0.72 && ju.breakdown.models['opus-5-5'].share === 1 && ju.breakdown.startup.medianCtxTokens === 1010, 'detail-breakdown', JSON.stringify(ju.breakdown).slice(0, 260));
    check(ju.byDay['2026-11-10'] && !ju.byDay['2026-10-01'] && ju.byDay['2026-11-10'].cost === 0.73, 'byDay-filtered-by-since', JSON.stringify(ju.byDay));
    check(!JSON.stringify(ju).includes('sess-other') && !JSON.stringify(ju).includes('sess-old'), 'other-sessions-excluded', '別的專案與範圍外的 session 不出現');
    // 明細檔與對到的用量紀錄差太多：以明細檔為準並明說
    w.setDetail(mk([{ ...sessA, cost: 1.5 }]));
    const jm = w.run(['--since', '2026-11-01']);
    check(jm.flagged[0].cost === 1.5 && has(jm, /差 \d+%/), 'mismatch-noted', note(jm, /差 \d+%/));
    // 逐字紀錄不見：還是有金額，註明沒有診斷
    w.setDetail(mk([{ ...sessA, id: 'sess-gone' }]));
    const jg = w.run(['--since', '2026-11-01']);
    check(jg.flagged[0].cost === 0.73 && jg.flagged[0].diagnosis === 'missing' && has(jg, /找不到 session sess-go/), 'transcript-missing', note(jg, /找不到/));

    // 壞參數
    const plain = (...a2) => spawnSync(process.execPath, [SCRIPT, w.root, ...a2], { encoding: 'utf8' });
    check(plain('--transcripts', path.join(w.tdir, 'nope')).status === 2, 'bad-dir-exit-2', '找不到目錄要 exit 2');
    check((() => { const z = plain('--transcripts', __filename); return z.status === 2 && /是目錄/.test(z.stderr); })(), 'file-as-dir-exit-2', '--transcripts 指到檔案要 exit 2');
    check((() => { const z = w.spawn(['--out', w.tdir]); return z.status === 2 && /寫不進/.test(z.stderr); })(), 'out-is-dir-exit-2', '--out 指到資料夾要 exit 2');
    check(w.spawn(['--since', '11/10']).status === 2, 'bad-since-exit-2', '日期格式錯要 exit 2');
    // 預設位置是家目錄底下的 usage-data
    w.refresh();
    const dj = JSON.parse(spawnSync(process.execPath, [SCRIPT, w.root, '--transcripts', w.tdir], { env: { ...process.env, HOME: w.home, USERPROFILE: w.home }, encoding: 'utf8' }).stdout);
    check(dj.source === 'cc-statusline' && dj.totals.sessions === 4, 'default-paths', `source=${dj.source} sessions=${dj.totals.sessions}`);
  }

  // ── 沒有金額：每一種都 exit 0、說原因、不自己讀用量 ──
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 100000 })]);
    const none = (label, code, prep, re) => {
      w.refresh(); prep();
      const j = w.run(), nd = j.noData || {};
      check(j.status === 0 && j.source === 'none' && j.unit === null && nd.code === code && /^沒有金額，/.test(nd.message) && /cc-statusline 到 1\.10\.0/.test(nd.message) && re.test(nd.message) && j.notes[0] === nd.message, 'no-data ' + label, `${j.status} ${nd.code}｜${nd.message || j.err}`);
      check(j.totals && j.totals.cost === null && j.totals.sessions === null && j.flagged.length === 0 && j.allSessions.length === 0 && Object.keys(j.byDay).length === 0 && j.breakdown === null, 'no-data-no-figures ' + label, JSON.stringify(j.totals));
    };
    const det = () => JSON.parse(fs.readFileSync(w.detail, 'utf8')), meta = () => JSON.parse(fs.readFileSync(path.join(w.records, 'meta.json'), 'utf8'));
    { w.refresh(); fs.writeFileSync(path.join(w.records, '2020-01'), 'x'); const j = w.run(); check(j.source !== 'none', 'records 底下名字像月份的檔案略過', j.source); fs.rmSync(path.join(w.records, '2020-01')); }
    { w.refresh(); const before = w.run(); for (const m of fs.readdirSync(w.records).filter((x) => /^\d{4}-\d{2}$/.test(x))) for (const f of fs.readdirSync(path.join(w.records, m))) { const p = path.join(w.records, m, f), L = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); fs.writeFileSync(p, L.flatMap((l) => { const r = JSON.parse(l); return [l, JSON.stringify({ ...r, id: 'other-' + r.id, in: 999999999, cost: 9999 })]; }).join('\n') + '\n'); } const after = w.run(); check(after.source !== 'none' && JSON.stringify(after.flagged.map((s) => [s.session, s.signals.map((x) => x.code)])) === JSON.stringify(before.flagged.map((s) => [s.session, s.signals.map((x) => x.code)])), '同一行有別則的紀錄，用 message.id 對', [before.flagged.length, after.flagged.length]); w.refresh(); }
    none('紀錄檔讀不到（不拿一部分當全部）', 'unreadable', () => { const m = fs.readdirSync(w.records).find((x) => /^\d{4}-/.test(x)), f = fs.readdirSync(path.join(w.records, m)).find((x) => x.endsWith('.jsonl')); fs.rmSync(path.join(w.records, m, f)); fs.mkdirSync(path.join(w.records, m, f)); }, /讀不了 cc-statusline 的每則用量紀錄/);
    none('沒有明細檔', 'missing', () => fs.rmSync(w.detail), /沒有 cc-statusline 的明細檔/);
    none('明細檔壞掉', 'unreadable', () => w.setDetail('{壞掉'), /讀不了 cc-statusline 的明細檔/);
    none('明細檔沒有 v', 'version', () => { const d = det(); delete d.v; w.setDetail(d); }, /明細檔格式不認得（v：沒有）/);
    none('明細檔 v 不是數字', 'version', () => w.setDetail({ ...det(), v: 'x' }), /格式不認得（v：x）/);
    none('明細檔沒有這個專案', 'project', () => w.setDetail({ ...det(), byProject: { other: { cost: 1, byDay: {} } } }), /明細檔裡沒有這個專案（C--work-demo）/);
    none('沒有用量紀錄', 'missing', () => fs.rmSync(w.records, { recursive: true }), /沒有 cc-statusline 的每則用量紀錄/);
    none('紀錄的 meta 壞掉', 'unreadable', () => w.setMeta('{'), /讀不了 cc-statusline 的每則用量紀錄/);
    none('紀錄的 meta 沒有 v', 'version', () => { const m = meta(); delete m.v; w.setMeta(m); }, /每則用量紀錄格式不認得/);
    none('紀錄裡沒有這個專案', 'project', () => fs.rmSync(path.join(w.records, '2026-11'), { recursive: true }), /每則用量紀錄裡沒有這個專案/);
    // --out 也寫得出來
    w.refresh(); fs.rmSync(w.detail);
    const out = path.join(w.home, 'a', 'none.json'), r = w.spawn(['--out', out]);
    check(r.status === 0 && JSON.parse(fs.readFileSync(out, 'utf8')).noData.code === 'missing' && /"noData"/.test(r.stdout) && /完整結果/.test(r.stdout), 'no-data-out', r.stdout.replace(/\s+/g, ' ').slice(0, 120));
    // v 比 1 大：照用（欄位只加不改）
    w.refresh(); w.setDetail({ ...det(), v: 2 }); w.setMeta({ ...meta(), v: 3 });
    const j2 = w.run();
    check(j2.source === 'cc-statusline' && j2.totals.cost === 0.5, 'newer-v-accepted', `source=${j2.source} cost=${j2.totals.cost}`);
  }

  // 1 開場固定底只算主對話的回應與主對話的模型：主對話 5 則 opus（上下文 40000）＋subagent 300 則 haiku
  {
    const w = world(); const sub = [];
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 40000 }), ...[1, 2, 3, 4].map((i) => w.a('m' + i, at(i), { rd: 40000, out: 10 }))]);
    for (let i = 0; i < 300; i++) sub.push(w.a('u' + i, at(10 + i), { rd: 70000 }, { model: 'claude-haiku-4-5' }));
    w.put('s1/subagents/agent-x.jsonl', sub);
    // 主：0.2 + 4×(0.008+0.0002)=0.2328；sub：300×0.007=2.1
    w.refresh();
    const s = w.run().flagged[0];
    check(s && s.startupFloorCost === 0.04 && s.startupFloorShare === 0.02 && !sig(s).includes('startup-heavy'), 'startup-floor-main-only', `cost=${s && s.startupFloorCost} share=${s && s.startupFloorShare}（5×40000×0.2/1e6＝0.04；算進 subagent 或用 haiku 牌價都不對）`);
    check(s && s.mainRequests === 5 && s.requests === 305 && s.scannedRequests === 305 && s.scannedCost === 2.33, 'main-requests-counted', `main=${s && s.mainRequests} requests=${s && s.requests} scannedCost=${s && s.scannedCost}`);
    check(s && s.subagentShare === 0.9 && s.models['haiku-4-5'] === 2.1, 'per-model-prices', JSON.stringify(s && s.models));
    // subagent 用便宜模型、主對話很短：占比不得超過 1
    w.setDetail(detailOf(w.proj, [ds('s1', w.proj, 0.01, { subCost: 0.009, requests: 305, startCtx: 40000 })]));
    const s2 = w.run().flagged[0];
    check(s2 && s2.startupFloorShare <= 1 && s2.startupFloorCost <= 0.01, 'startup-share-capped', `share=${s2 && s2.startupFloorShare} cost=${s2 && s2.startupFloorCost}`);
  }
  // 2 大小寫：落點換算的目錄名 c--work-demo，明細檔是 C--work-demo
  {
    const w = world('c--work-demo');
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 100000 })]);
    w.collect();
    w.setDetail(detailOf('C--work-demo', [ds('s1', 'C--work-demo', 0.5, { startCtx: 100000 })]));
    const pre = path.join(w.home, 'pre.js');
    const plat = (p) => { fs.writeFileSync(pre, `Object.defineProperty(process, 'platform', { value: '${p}' });`); return w.run([], { pre }); };
    const win = plat('win32'), mac = plat('darwin'), lin = plat('linux');
    const ok = (j) => j.source === 'cc-statusline' && j.totals.sessions === 1 && j.flagged[0].scannedCost === 0.5;
    check(ok(win) && ok(mac), 'project-case-insensitive-win-mac', `win=${win.source}/${win.totals.sessions} mac=${mac.source}/${mac.totals.sessions}`);
    check(lin.source === 'none' && lin.noData.code === 'project', 'project-case-sensitive-linux', `linux=${lin.source}`);
    // 專案資料夾名很長：cc-statusline 的檔名截短加雜湊
    const lw = world('C--' + 'long-name-'.repeat(19) + 'end');
    let made = true; try { lw.put('s1.jsonl', [lw.a('m0', at(0), { cw5: 100000 })]); } catch { made = false; console.log('略過｜這台的路徑長度放不下很長的專案名'); }
    if (made) { lw.refresh(); const j = lw.run(); check(lw.proj.length > 180 && j.source === 'cc-statusline' && j.flagged[0] && j.flagged[0].scannedCost === 0.5, 'long-project-name', `${lw.proj.length} 字 source=${j.source} scanned=${j.flagged[0] && j.flagged[0].scannedCost}`); }
  }
  // 3 totals.cost 是範圍內的；整個 session 的另列，breakdown 標明口徑
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 100000 })]);
    w.collect();
    w.setDetail(detailOf(w.proj, [ds('s1', w.proj, 10, { first: '2026-10-01T00:00:00.000Z', startCtx: 100000 })], { '2026-10-01': 8, '2026-11-10': 2 }));
    const j = w.run(['--since', '2026-11-01']);
    check(j.totals.cost === 2 && j.totals.dayCost === 2 && j.totals.sessionsFullCost === 10, 'totals-in-range', JSON.stringify(j.totals));
    check(!!(j.fields && j.fields['totals.sessionsFullCost']) && /整個/.test((j.breakdown || {}).scope || '') && has(j, /跟別次健檢比就比這些/), 'scope-explained', note(j, /別次健檢/));
  }
  // 6 <synthetic> 列不算回應；沒有單價、暫估單價的各說幾則
  {
    const w = world();
    w.put('s1.jsonl', [w.a('syn', at(0), {}, { model: '<synthetic>' }), w.a('m0', at(1), { cw5: 100000 }), w.a('weird', at(2), { in: 10 }, { model: 'claude-unknown-9' }), w.a('near', at(3), { in: 10 }, { model: 'claude-opus-9-9' })]);
    w.collect();
    w.setDetail(detailOf(w.proj, [ds('s1', w.proj, 0.5, { requests: 2, startCtx: 100000 })]));
    const j = w.run(), s = j.flagged[0];
    check(has(j, /有 1 則回應的模型沒有單價/) && has(j, /有 1 則回應用的是暫估單價/), 'unpriced-and-approx-noted', note(j, /單價/) || '（沒有這條 note）');
    check(s && s.requests === 2 && j.allSessions[0].requests === 2 && s.scannedRequests === 3, 'synthetic-not-counted', `flagged=${s && s.requests} all=${j.allSessions[0] && j.allSessions[0].requests} scanned=${s && s.scannedRequests}`);
    check(s && s.startCtxIsOpening === true, 'synthetic-first-row-is-not-opening', `opening=${s && s.startCtxIsOpening}`);
  }
  // 7 便宜的 session：先捨入到分再比會冒出假的金額差；startup 占比也要用沒捨入的值
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', at(0), { rd: 70000 })]);                      // 0.014
    w.refresh();
    const j = w.run(); const s = j.flagged[0];
    check(!has(j, /差 \d+%/), 'cheap-session-no-false-diff', note(j, /差 \d+%/) || '沒有假的金額差');
    check(s && s.startupFloorShare === 1, 'startup-share-unrounded', `share=${s && s.startupFloorShare}（0.014/0.014＝1；捨入成 0.01 再算會是 0.71）`);
    // 真的差 2 分錢（差 1 倍但金額太小）：不說
    w.setDetail(detailOf(w.proj, [ds('s1', w.proj, 0.034, { startCtx: 70000 })]));
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
    w.refresh();
    const j = w.run(); const c = (id) => sig(by(j, id)).includes('context-never-compacted');
    check(by(j, 'small') && !c('small'), 'never-compacted-needs-size', `小上下文 40 次回應：${c('small')}`);
    check(c('big') && by(j, 'few') && !c('few') && c('subcomp'), 'never-compacted-main-only', `big=${c('big')} few(主 5 次＋子 60 次)=${c('few')} subcomp(壓縮發生在 subagent)=${c('subcomp')}`);
  }
  // 9 輸出占比、thinking、開場固定底
  {
    const w = world();
    w.put('out.jsonl', [w.a('o0', at(0), { in: 10, out: 10000 }, { think: 8000 })]);
    w.put('start.jsonl', Array.from({ length: 10 }, (_, i) => w.a('t' + i, at(i), i ? { rd: 50000 } : { cw5: 50000 })));
    w.refresh();
    const j = w.run(); const o = by(j, 'out'), st = by(j, 'start');
    check(sig(o).includes('output-heavy') && sig(o).includes('think-heavy') && o.thinkShare === 0.8, 'output-and-think', sig(o).join(','));
    check(sig(st).includes('startup-heavy') && st.startupFloorCost === 0.1 && st.startupFloorShare === 0.29 && /約 0.1 美元/.test(JSON.stringify(st.signals)), 'startup-heavy', sig(st).join(',') + ` ${st && st.startupFloorShare}（10×50000×0.2/1e6÷0.34）`);
  }
  // 10 byDay 照每則回應的日期分，不得早於 --since
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', '2026-10-20T04:00:00.000Z', { in: 1000000 }), w.a('m1', '2026-11-10T04:00:00.000Z', { in: 100000 }), w.a('m2', '2026-11-11T04:00:00.000Z', { in: 200000 })]);
    w.refresh();
    const j = w.run(['--since', '2026-11-01']);
    check(JSON.stringify(Object.keys(j.byDay)) === '["2026-11-10","2026-11-11"]' && j.byDay['2026-11-10'].cost === 0.4 && j.byDay['2026-11-11'].cost === 0.8, 'byday-per-response', JSON.stringify(j.byDay));
    check(j.totals.cost === 1.2 && j.totals.sessionsFullCost === 5.2 && j.flagged[0].scannedCost === 5.2, 'in-range-vs-full', JSON.stringify(j.totals) + '（紀錄分在兩個月份的檔，都要讀）');
  }
  // 11 主檔與 subagent 檔的同一則只算一次（歸 subagent）；fork 帶過來的不重複算、內容照看
  {
    const w = world();
    w.put('s1.jsonl', [w.a('m0', at(0), { in: 100000 }), w.a('dup', at(1), { in: 50000 })]);
    w.put('s1/subagents/agent-1.jsonl', [w.a('dup', at(1), { in: 50000 })]);
    w.put('s2.jsonl', [w.a('m0', at(0), { in: 100000 }, { blocks: [toolUse('x', 'Grep', {})] }), w.a('n1', at(5), { in: 1000 })]);      // fork：複製了 s1 的 m0
    w.refresh();
    const j = w.run(); const s = by(j, 's1'), z = by(j, 's2');
    check(s && s.requests === 2 && s.scannedRequests === 2 && s.mainRequests === 1 && s.cost === 0.6 && s.scannedCost === 0.6 && s.subagentShare === 0.33, 'dedupe-main-and-subagent', `requests=${s && s.requests} main=${s && s.mainRequests} cost=${s && s.cost}`);
    check(z && z.scannedRequests === 1 && z.scannedTokens.input === 1000 && z.toolCalls[0].name === 'Grep' && has(j, /resume／fork/) && j.totals.sessionsFullCost === 0.6, 'fork-not-counted-twice', `scanned=${z && z.scannedRequests} in=${z && z.scannedTokens.input} full=${j.totals.sessionsFullCost}`);
  }
  // 12 分叉 session：留下的第一則是分叉後那一則，不是開場固定底
  {
    const w = world();
    w.put('a-orig.jsonl', [w.a('m0', at(0), { cw5: 20000 }), w.a('m1', at(1), { rd: 20000 })]);
    w.put('cont.jsonl', [{ type: 'user', isCompactSummary: true, timestamp: at(0), cwd: w.root, message: { role: 'user', content: '摘要' } }, w.a('k0', at(1), { cw5: 60000 })]);
    w.put('fork.jsonl', [w.a('m0', at(0), { cw5: 20000 }), w.a('m1', at(1), { rd: 20000 }), w.a('m2', at(2), { rd: 170000 })]);
    w.refresh();
    const j = w.run(); const f = by(j, 'fork');
    check(f && f.startCtx === 170000 && f.startCtxIsOpening === false && f.startupFloorCost === null && !sig(f).includes('startup-heavy'), 'fork-startctx-not-opening', `startCtx=${f && f.startCtx} opening=${f && f.startCtxIsOpening} floor=${f && f.startupFloorCost}`);
    const st = (j.breakdown || {}).startup || {};
    check(st.sessions === 1 && st.medianCtxTokens === 20000 && st.excludedNotOpening === 2, 'fork-excluded-from-median', JSON.stringify(st));
    check(has(j, /算在先建立的那個對話/) && has(j, /有 2 個 session 的開場上下文/), 'fork-noted', note(j, /先建立/));
    // 分叉後那一則剛好跟開場一樣大：看是不是同一則，不是看大小
    const w2 = world();
    w2.put('a-orig.jsonl', [w2.a('m0', at(0), { cw5: 20000 })]);
    w2.put('fork.jsonl', [w2.a('m0', at(0), { cw5: 20000 }), w2.a('m2', at(2), { rd: 20100 })]);
    w2.refresh();
    const f2 = by(w2.run(), 'fork');
    check(f2 && f2.startCtxIsOpening === false, 'fork-same-size-not-opening', `opening=${f2 && f2.startCtxIsOpening}`);
    // 用量紀錄沒有這個 session：沒有可以對的
    w2.setDetail(detailOf(w2.proj, [ds('late', w2.proj, 0.1, { startCtx: 20000 })])); w2.put('late.jsonl', [w2.a('l0', at(9), { cw5: 20000 })]);
    const l = w2.run();
    check(l.flagged[0] && l.flagged[0].startCtxIsOpening === null && l.breakdown.startup.unverified === 1 && has(l, /差 100%/), 'session-not-in-records', note(l, /差/));
  }
  // 13 明細只列花最多的：這個專案的 session 被截掉時不能說沒有資料
  {
    const w = world(); w.put('s1.jsonl', [w.a('m0', at(0), { in: 1 })]); w.collect();
    const d = detailOf(w.proj, [ds('zz', 'other', 99)], { '2026-11-10': 3 }, { sessionsTotal: 1600, sessionsRest: { count: 1599, cost: 20 } });
    d.byProject[w.proj].sessions = 4; w.setDetail(d);
    const j = w.run(['--since', '2026-11-01']);
    check(!has(j, /沒有資料/) && has(j, /這個專案有 4 個花費較少的沒列/) && j.totals.cost === 3, 'truncated-sessions-noted', j.notes.join(' | ').slice(0, 260));
  }
  // 14 明細檔太舊、比用量紀錄舊：照用並說
  {
    const w = world(); w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 100000 })]); w.refresh();
    const d = JSON.parse(fs.readFileSync(w.detail, 'utf8'));
    check(!has(w.run(), /小時/), 'fresh-detail-no-note', '剛產生的不說');
    w.setDetail({ ...d, at: Date.now() - 10 * 3600e3 }); const j = w.run();
    check(j.totals.cost === 0.5 && has(j, /比它的用量紀錄舊 10 小時/) && !has(j, /小時前產生/), 'detail-behind-records-noted', note(j, /小時/));
    w.setDetail({ ...d, at: Date.now() - 50 * 3600e3 });
    check(has(w.run(), /是 50 小時前產生的/), 'stale-detail-noted', note(w.run(), /小時前/));
  }
  // 15 讀不了的逐字紀錄要說；大檔逐塊讀，列跨塊、多位元組字元跨塊都不能壞；最後一列沒換行（還在寫）不算；讀不出來的紀錄列略過
  {
    const w = world(); fs.mkdirSync(path.join(w.tdir, 'isdir.jsonl'));
    w.put('s1.jsonl', [w.a('m0', at(0), { in: 1 })]);
    w.collect(); w.setDetail(detailOf(w.proj, [ds('s1', w.proj, 0.1), ds('isdir', w.proj, 1)]));
    const j = w.run();
    check(has(j, /讀不了/) && has(j, /isdir\.jsonl/) && by(j, 'isdir').diagnosis === 'unreadable' && by(j, 'isdir').cost === 1, 'unreadable-noted', note(j, /讀不了/) || '（沒有這條 note）');
    const pad = '中文字'.repeat(3001); const rows = [];
    for (let i = 0; i < 400; i++) rows.push(w.a('b' + i, at(i), { in: 1 }, { blocks: [{ type: 'text', text: pad + 'x'.repeat(i % 7) }] }));
    rows.push(w.a('wide', at(500), { in: 3 }, { blocks: [{ type: 'text', text: '寬'.repeat(3 * 1024 * 1024) }] }), w.a('after', at(501), { in: 5 }));   // 一列就超過一塊
    w.put('big.jsonl', rows);
    fs.writeFileSync(path.join(w.tdir, 'notail.jsonl'), JSON.stringify(w.a('q0', at(0), { in: 7 })) + '\n' + JSON.stringify(w.a('q1', at(1), { in: 70 })));
    w.refresh();
    const j2 = w.run(); const b = by(j2, 'big'), q = by(j2, 'notail');
    check(b && b.requests === 402 && b.scannedRequests === 402 && b.scannedTokens.input === 408 && !has(j2, /解析失敗/), 'chunked-read-intact', `big=${b && b.scannedRequests} in=${b && b.scannedTokens.input}（檔 ${Math.round(fs.statSync(path.join(w.tdir, 'big.jsonl')).size / 1e6)} MB）`);
    check(q && q.requests === 1 && q.scannedTokens.input === 7, 'unfinished-last-row', `requests=${q && q.requests} in=${q && q.scannedTokens.input}`);
    fs.appendFileSync(path.join(w.records, '2026-11', w.proj + '.jsonl'), '{"id":"寫到一半');
    const j3 = w.run();
    check(j3.status === 0 && has(j3, /用量紀錄有 1 行讀不出來/) && by(j3, 'big').scannedRequests === 402, 'half-written-record', note(j3, /讀不出來/));
  }
  // 逐字紀錄被改寫過、行號跑掉：不會對到別則，並且說
  {
    const w = world(), rows = [w.a('m0', at(0), { in: 100000 }), w.a('m1', at(1), { in: 200000 }), w.a('m2', at(2), { in: 300000 })];
    w.put('s1.jsonl', rows); w.refresh(); w.put('s1.jsonl', rows.slice(1));
    const j = w.run(), s = j.flagged[0];
    check(s && s.cost === 2.4 && s.scannedRequests === 0 && has(j, /有 3 則用量紀錄在逐字紀錄裡對不到/) && has(j, /差 100%/), 'rewritten-transcript', `scanned=${s && s.scannedRequests}｜${note(j, /對不到|差/)}`);
  }
  // 16 內容區塊是 null、明細檔缺欄位：不拋例外
  {
    const w = world();
    w.put('s1.jsonl', ['null', '5', w.a('m0', at(0), { in: 1 }, { blocks: [null, { type: 'text', text: 'x' }] }), { type: 'user', timestamp: at(1), cwd: w.root, message: { role: 'user', content: [null, { type: 'tool_result', tool_use_id: 't', content: [null] }] } }, { type: 'assistant', timestamp: at(2), cwd: w.root, message: null }, { type: 'assistant', timestamp: 'bad', cwd: w.root, message: { id: 'z', usage: null } }]);
    w.refresh();
    const j = w.run();
    check(j.status === 0 && j.flagged[0] && j.flagged[0].requests === 1 && j.flagged[0].scannedRequests === 1, 'null-blocks-no-throw', `exit ${j.status} ${j.err || ''}`);
    w.setDetail({ v: 1, byProject: { [w.proj]: {} }, sessions: [null, { id: 's1', project: w.proj, last: '2026-11-10T02:00:00.000Z' }, { project: w.proj, last: '2026-11-10T02:00:00.000Z' }] });
    fs.appendFileSync(path.join(w.records, '2026-11', w.proj + '.jsonl'), '{}\n{"sid":"s1"}\n{"sid":"s1","ts":1,"line":99}\nnull\n');
    const k = w.run();
    check(k.status === 0 && k.source === 'cc-statusline' && k.totals.cost === null && k.totals.sessions === 1, 'missing-fields-no-throw', `exit ${k.status} cost=${k.totals.cost} sessions=${k.totals.sessions} ${k.err || ''}`);
  }
  // 17 不同落點換算成同一個目錄名：照 cwd 過濾
  {
    const w = world(); const other = path.join(w.home, 'elsewhere');
    w.put('mine.jsonl', [w.a('m0', at(0), { in: 100 }), w.a('m1', at(1), { in: 1000 }, { cwd: other }), w.a('m2', at(2), { in: 5 }, { cwd: path.join(w.root, 'sub') })]);
    w.put('other.jsonl', [w.a('o0', at(0), { in: 7777 }, { cwd: other })]);
    w.put('mine/subagents/agent-1.jsonl', [w.a('p0', at(3), { in: 3333 }, { cwd: other })]);
    w.refresh();
    const j = w.run();
    check(j.totals.sessions === 1 && j.flagged[0].scannedTokens.input === 105 && j.flagged[0].scannedRequests === 2, 'cwd-filtered', `sessions=${j.totals.sessions} in=${j.flagged[0] && j.flagged[0].scannedTokens.input}（100＋5；別的 cwd 的列、session、subagent 都不算）`);
    check(has(j, /略過 1 個別的專案的 session/) && has(j, /中途切到別的專案/) && has(j, /subagent 紀錄/) && !has(j, /對不到那一列/), 'cwd-filter-noted', note(j, /別的專案/));
    check(has(j, /按目錄名加總、拆不開/), 'collision-noted', note(j, /拆不開/));
  }
  // 18 找不到目錄：exit 2、說清楚原因與怎麼補
  {
    const w = world(); const r = w.spawn([], { tdir: path.join(w.home, 'nope') });
    check(r.status === 2 && /--transcripts <目錄>/.test(r.stderr) && /沒有產生結果檔/.test(r.stderr), 'missing-dir-explained', String(r.stderr).replace(/\s+/g, ' ').slice(0, 200));
  }
  // 不碰原始用量：逐字紀錄的用量改掉，金額不變（有沒有讀，從輸出看得出來）
  {
    const w = world(); w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 100000 })]); w.refresh();
    w.put('s1.jsonl', [w.a('m0', at(0), { cw5: 999999, rd: 5 })]);
    const j = w.run(), s = j.flagged[0];
    check(s && s.scannedCost === 0.5 && s.scannedTokens.cacheCreate5m === 100000 && s.startCtx === 100000, 'usage-not-read-from-transcripts', `scanned=${s && s.scannedCost} ${JSON.stringify(s && s.scannedTokens)}`);
  }
} finally { for (const d of worlds) fs.rmSync(d, { recursive: true, force: true }); }
console.log(`合計 PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
