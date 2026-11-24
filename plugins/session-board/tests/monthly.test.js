'use strict';
// node --test plugins/session-board/tests/monthly.test.js
// The month is added up for real, against a made-up home folder, from the records cc-statusline really makes of it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Monthly } = require('../lib/monthly');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-test-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const SCAN = path.join(__dirname, '..', 'scripts', 'usage-scan.js');
const collect = (env) => execFileSync(process.execPath, ['-e', 'require(' + JSON.stringify(path.join(__dirname, '..', '..', 'cc-statusline', 'scripts', 'lib-records.js')) + ').collect()'], { env });
// Local-time timestamps: the month is the one on the wall clock, not UTC.
const at = (y, mo, d, h) => new Date(y, mo - 1, d, h || 12).toISOString();
const turn = (id, model, ts, usage, extra) => JSON.stringify(Object.assign({ type: 'assistant', sessionId: 'S1', cwd: 'C:\\w\\proj', timestamp: ts, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage } }, extra));

test('usage-scan: one month, every session, each API message once, priced per model', () => {
  const home = tmp();
  { const r = JSON.parse(execFileSync(process.execPath, [SCAN, '2026-11'], { env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home }), encoding: 'utf8' })); assert.ok(!r.ok && /1\.10\.0/.test(r.error), 'no records: said, nothing is read instead'); }
  const proj = path.join(home, '.claude', 'projects', 'C--w-proj');
  const sub = path.join(proj, 'S1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const U = { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 4000, cache_creation: { ephemeral_1h_input_tokens: 1000 } };
  fs.writeFileSync(path.join(proj, 'S1.jsonl'), [
    JSON.stringify({ type: 'ai-title', aiTitle: '測試用的對話', sessionId: 'S1' }),
    turn('m1', 'claude-opus-5-5', at(2026, 11, 1, 0), U),                 // first hour of the month: counted
    turn('m1', 'claude-opus-5-5', at(2026, 11, 1, 0), U),                 // the same message written again (second content block)
    turn('m2', 'claude-sonnet-4-6', at(2026, 11, 12), { input_tokens: 10, output_tokens: 20 }),
    turn('m3', 'claude-opus-5-5', at(2026, 10, 31, 23), U),               // last hour of October: not this month
    turn('m4', 'claude-opus-5-5', at(2026, 12, 1, 0), U),                 // first hour of December: not this month
    turn('m5', '<synthetic>', at(2026, 11, 5), { input_tokens: 99, output_tokens: 99 }),   // not a model: nothing was billed
    '{"type":"assistant","message":{"usage": broken json',
    JSON.stringify({ type: 'user', timestamp: at(2026, 11, 5), message: { role: 'user', content: 'no usage here' } }),
  ].join('\n'));   // no trailing newline
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), [
    turn('m2', 'claude-sonnet-4-6', at(2026, 11, 12), { input_tokens: 10, output_tokens: 20 }),   // a subagent's turn, also echoed in the parent above
    turn('m6', 'claude-haiku-4-5', at(2026, 11, 30, 23), { input_tokens: 1000000, output_tokens: 0 }, { sessionId: 'S1' }),
  ].join('\n') + '\n');
  const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home }), scan = () => JSON.parse(execFileSync(process.execPath, [SCAN, '2026-11'], { env, encoding: 'utf8' }));
  collect(env);
  fs.rmSync(path.join(sub, 'agent-a1.jsonl'));   // cleared away by Claude Code: counted all the same
  { const mf = path.join(home, '.claude', 'usage-data', 'records', 'meta.json'), was = fs.readFileSync(mf, 'utf8'); fs.writeFileSync(mf, JSON.stringify(Object.assign(JSON.parse(was), { at: 0 }))); assert.ok(scan().ok === false && /第一次/.test(scan().error), 'being made for the first time: part of it is not a figure'); fs.writeFileSync(mf, was); }
  const out = scan();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.priced, true);                                    // cc-statusline's price table, found beside this plugin
  assert.deepStrictEqual([out.records, out.sessionCount, out.daysInMonth, out.dataAt > 0], [3, 1, 30, true]);
  // opus-5-5: 1000*4 + 2000*20 + 2000*5 (5-minute write) + 1000*8 (1-hour write) + 4000*0.20 = 62,800 per million tokens
  // sonnet-4-6: 10*3 + 20*15 = 330 ; haiku-4-5: 1,000,000*1 = 1,000,000
  const want = (62800 + 330 + 1000000) / 1e6;
  assert.ok(Math.abs(out.total.cost - want) < 1e-9, 'cost ' + out.total.cost + ' vs ' + want);
  assert.deepStrictEqual([out.total.in, out.total.out, out.total.cw, out.total.cr, out.total.tok], [1001010, 2020, 3000, 4000, 1010030]);
  assert.deepStrictEqual(out.days.filter((d) => d.tok > 0).map((d) => [d.day, d.tok]), [[1, 10000], [12, 30], [30, 1000000]]);
  assert.deepStrictEqual(out.models.map((m) => [m.model, m.exact, m.priced]), [['haiku-4-5', true, true], ['opus-5-5', true, true], ['sonnet-4-6', true, true]]);
  assert.deepStrictEqual(out.projects.map((p) => [p.id, p.name, p.path, p.tok]), [['C--w-proj', 'proj', 'C:\\w\\proj', 1010030]]);   // one project, not one per working directory
  assert.deepStrictEqual(out.sessions.map((s) => [s.sessionId, s.title, s.projectName, s.tok]), [['S1', '測試用的對話', 'proj', 1010030]]);
  // The pieces add up to the whole.
  for (const list of [out.days, out.models, out.projects]) assert.ok(Math.abs(list.reduce((a, x) => a + x.cost, 0) - out.total.cost) < 1e-9);

  // each day's part: added up by the page for any days, the same as the whole
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'), a0 = page.indexOf('function sliceUsage('), sliceUsage = new Function(page.slice(a0, page.indexOf('\n}\n', a0) + 3) + '; return sliceUsage;')();
  const near = (x, y, m) => assert.ok(Math.abs(x - y) < 1e-6, m + ' ' + x + ' ' + y), all = sliceUsage(out, 1, 30);
  for (const k of ['in', 'out', 'cw', 'cr', 'tok', 'n']) assert.strictEqual(all.total[k], out.total[k], k);
  near(all.total.cost, out.total.cost, 'cost');
  assert.deepStrictEqual([all.sessionCount, all.records, all.unpricedTok, all.approxTok], [out.sessionCount, out.records, out.unpricedTok, out.approxTok]);
  for (const [k, id] of [['models', 'model'], ['projects', 'id'], ['roles', 'role'], ['sessions', 'sessionId']]) { assert.deepStrictEqual(all[k].map((x) => [x[id], x.tok, x.n]), out[k].map((x) => [x[id], x.tok, x.n]), k); all[k].forEach((x, i) => near(x.cost, out[k][i].cost, k)); }
  assert.deepStrictEqual(all.roles.map((x) => [x.role, x.runs, x.team, x.models.map((y) => y.model), x.projects.map((y) => y.name)]), out.roles.map((x) => [x.role, x.runs, x.team, x.models.map((y) => y.model), x.projects.map((y) => y.name)]));
  assert.deepStrictEqual([all.projects[0].name, all.projects[0].path, all.sessions[0].title, all.sessions[0].projectName], ['proj', 'C:\\w\\proj', '測試用的對話', 'proj']);
  const some = sliceUsage(out, 2, 12); assert.deepStrictEqual([some.total.tok, some.models.map((x) => x.model), some.days.map((x) => x.day).length, some.sessions[0].firstDay, some.sessions[0].lastDay, some.roles.length], [30, ['sonnet-4-6'], 11, 12, 12, 1]);
  const none = sliceUsage(out, 3, 4); assert.deepStrictEqual([none.total.tok, none.models, none.sessions, none.sessionCount], [0, [], [], 0]);

  assert.deepStrictEqual(out.slice.runs.map((r) => r[3]).sort(), [0, 1], 'which records are subagents\''); 
  // a record file that cannot be read just then: no figure rather than a part of it
  { const pre = path.join(home, 'pre.js'); fs.writeFileSync(pre, "const fs=require('fs'),o=fs.readFileSync;fs.readFileSync=function(p,...a){if(/2026-11.*jsonl$/.test(String(p)))throw Object.assign(new Error('x'),{code:'EBUSY'});return o.call(fs,p,...a);};"); const z = JSON.parse(execFileSync(process.execPath, ['-r', pre, SCAN, '2026-11'], { env, encoding: 'utf8' })); assert.ok(z.ok === false && /一時讀不到/.test(z.error)); fs.writeFileSync(pre, fs.readFileSync(pre, 'utf8').replace('EBUSY', 'ENOENT')); const z2 = JSON.parse(execFileSync(process.execPath, ['-r', pre, SCAN, '2026-11'], { env, encoding: 'utf8' })); assert.ok(z2.ok === false, 'listed, and gone when it is read'); }
  // the title is kept when the conversation is cleared away, and read again when it changes
  fs.appendFileSync(path.join(proj, 'S1.jsonl'), '\n' + JSON.stringify({ type: 'custom-title', customTitle: '改過的名字', sessionId: 'S1' }) + '\n'); assert.strictEqual(scan().sessions[0].title, '改過的名字');
  // a fixed name of a collaboration (--name) is written down as a title too: passed over, also one kept before it was known as such
  { const DB = require('../lib/db').open(path.join(home, '.claude', 'session-board', 'board.db')); const set = (v) => DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('sessionCodes', JSON.stringify(v));
    fs.appendFileSync(path.join(proj, 'S1.jsonl'), JSON.stringify({ type: 'custom-title', customTitle: 'S9-proj', sessionId: 'S1' }) + '\n'); assert.strictEqual(scan().sessions[0].title, 'S9-proj');
    set({ n: 9, codes: { x: 'S9-proj' } }); assert.strictEqual(scan().sessions[0].title, '改過的名字');
    { const off = JSON.parse(execFileSync(process.execPath, [SCAN, '2026-11'], { env: Object.assign({}, env, { SESSION_BOARD_SCAN_CACHE: '0' }), encoding: 'utf8' })); assert.strictEqual(off.sessions[0].title, '改過的名字', 'with nothing kept as well'); } set({}); }
  fs.rmSync(path.join(proj, 'S1.jsonl')); { const z = scan(); assert.deepStrictEqual([z.sessions[0].title, z.total.tok], ['改過的名字', out.total.tok]); }

  assert.deepStrictEqual(JSON.parse(execFileSync(process.execPath, [SCAN, '2026-13'], { encoding: 'utf8' })), { ok: false, error: 'month must be YYYY-MM' });
});

test('Monthly: the current month is recomputed when stale, a past month is kept on disk, a failed scan keeps the last figure', async () => {
  const d = tmp();
  let clock = new Date(2026, 10, 13, 9, 0, 0), calls = [], fail = false;
  const run = (bin, args, opts, cb) => { calls.push(args[1]); if (fail) return cb(new Error('boom'), ''); cb(null, JSON.stringify({ ok: true, month: args[1], computedAt: clock.getTime(), total: { cost: calls.length } })); };
  const db = path.join(d, 'board.db'), legacyDir = path.join(d, 'usage');
  const m = new Monthly({ db, legacyDir, run, now: () => clock });

  assert.strictEqual((await m.get('2026-11')).total.cost, 1);
  assert.strictEqual((await m.get('2026-11')).total.cost, 1);                // fresh: not recomputed
  clock = new Date(2026, 10, 13, 9, 6, 0);
  assert.strictEqual((await m.get('2026-11')).total.cost, 2);                // six minutes later: recomputed
  assert.strictEqual((await m.get('2026-11', true)).total.cost, 3);          // asked to
  assert.deepStrictEqual(m.stored(), []);                                    // the current month is not written down

  const [a, b] = await Promise.all([m.get('2026-10'), m.get('2026-10')]);    // two askers, one scan
  assert.deepStrictEqual([a.total.cost, b.total.cost, calls.length], [4, 4, 4]);
  const again = new Monthly({ db, legacyDir, run, now: () => clock });
  assert.strictEqual((await again.get('2026-10')).total.cost, 5);            // a new server adds it up again, once a day
  assert.strictEqual((await again.get('2026-10')).total.cost, 5); assert.strictEqual(calls.length, 5, 'not again the same day');
  assert.deepStrictEqual(again.stored().map((r) => [r.month, r.cost]), [['2026-10', 5]]);

  fail = true;
  const r = await m.get('2026-10', true);
  assert.deepStrictEqual([r.ok, r.stale, r.total.cost, r.error], [true, true, 4, 'boom']);
  assert.deepStrictEqual(await m.get('2026-09'), { ok: false, error: 'boom' });   // nothing to fall back on
  assert.deepStrictEqual(await m.get('2026-12'), { ok: false, error: '這個月還沒到' });
  assert.deepStrictEqual(await m.get('nope'), { ok: false, error: 'month must be YYYY-MM' });
});

test('Monthly.ensurePrevious saves last month once, without anyone opening it', async () => {
  const d = tmp();
  const calls = [];
  const clock = new Date(2027, 0, 2, 9, 0, 0);   // January: last month is December of the year before
  const run = (bin, args, opts, cb) => { calls.push(args[1]); cb(null, JSON.stringify({ ok: true, month: args[1], computedAt: clock.getTime(), total: { cost: 7, tok: 9 } })); };
  const db = path.join(d, 'board.db'), legacyDir = path.join(d, 'usage');
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, '2026-10.json'), JSON.stringify({ ok: true, month: '2026-10', computedAt: 5, total: { cost: 3, tok: 9 } }));   // from before the database
  const m = new Monthly({ db, legacyDir, run, now: () => clock });
  assert.deepStrictEqual(m.stored().map((r) => [r.month, r.cost]), [['2026-10', 3]]);   // read in from the old file
  assert.strictEqual((await m.get('2026-10')).total.cost, 7); assert.deepStrictEqual(calls.splice(0), ['2026-10'], 'and added up again');
  assert.strictEqual(m.ensurePrevious(), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls, ['2026-12']);
  assert.deepStrictEqual(m.stored().map((r) => [r.month, r.cost, r.tokens]), [['2026-12', 7, 9], ['2026-10', 7, 9]]);
  assert.strictEqual(m.ensurePrevious(), false);                                    // already written down
  // a month the records had not reached the end of: again a minute later, never a day; whole: once a day. What the records give replaces what they gave.
  {
    const to = new Date(2027, 0, 1).getTime(), seq = [], data = (cost, dataAt) => JSON.stringify(Object.assign({ ok: true, month: '2026-12', to, computedAt: 1, total: { cost, tok: 1 }, roles: [], slice: null }, dataAt ? { dataAt } : {}));
    let t = new Date(2027, 0, 1, 0, 5).getTime(), give = data(20, to - 5), bad = false; const m2 = new Monthly({ db: path.join(d, 'b2.db'), legacyDir: path.join(d, 'none'), now: () => new Date(t), run: (b, a, o, cb) => { seq.push(a[1]); if (bad) return cb(null, JSON.stringify({ ok: false, error: '整理中' })); cb(null, give); } });
    const cost = async () => (await m2.get('2026-12')).total.cost;
    assert.strictEqual(await cost(), 20);
    give = data(21, to + 5); t += 30000; assert.strictEqual(await cost(), 20); t += 40000; assert.strictEqual(await cost(), 21, 'a minute later, the rest is in');
    t += 23 * 3600000; give = data(22, to + 9); assert.strictEqual(await cost(), 21); t += 2 * 3600000; assert.strictEqual(await cost(), 22, 'whole: a day later');
    t += 25 * 3600000; give = data(12, to + 20); assert.strictEqual(await cost(), 12, 'a price put right makes it less');
    bad = true; t += 25 * 3600000; { const r = await m2.get('2026-12'); assert.deepStrictEqual([r.total.cost, r.stale], [12, true]); } bad = false; give = data(13, to + 30); assert.strictEqual(await cost(), 13, 'a failed one is not waited a day for');
    // the board's own look: not whole = made again every time it looks
    const m3 = new Monthly({ db: path.join(d, 'b3.db'), legacyDir: path.join(d, 'none'), now: () => new Date(t), run: (b, a, o, cb) => { seq.push('m3'); cb(null, give); } }); give = data(5, to - 1);
    assert.strictEqual(m3.ensurePrevious(), true); await Promise.all([...m3.jobs.values()]); seq.length = 0; t += 1000; give = data(6, to + 1);
    assert.strictEqual(m3.ensurePrevious(), true); await Promise.all([...m3.jobs.values()]); assert.deepStrictEqual([seq, await (async () => (await m3.get('2026-12')).total.cost)()], [['m3'], 6]); assert.strictEqual(m3.ensurePrevious(), false);
    // kept before there were records, and more than they hold: not replaced by less
    give = data(50); const m4 = new Monthly({ db: path.join(d, 'b4.db'), legacyDir: path.join(d, 'none'), now: () => new Date(t), run: (b, a, o, cb) => cb(null, give) }); await m4.get('2026-12'); give = data(3, to + 1); t += 25 * 3600000; assert.strictEqual((await m4.get('2026-12')).total.cost, 50);
    // ... nor one kept without a price table (no cost, only tokens); and a title there was is kept where there is none now
    const at5 = (o) => JSON.stringify(Object.assign({ ok: true, month: '2026-12', to, computedAt: 1, roles: [] }, o)), m5 = (f) => new Monthly({ db: path.join(d, f), legacyDir: path.join(d, 'none'), now: () => new Date(t), run: (b, a, o, cb) => cb(null, give) });
    give = at5({ total: { cost: 0, tok: 5000000 }, slice: null }); let q = m5('b5.db'); await q.get('2026-12'); give = at5({ dataAt: to + 1, total: { cost: 0, tok: 0 }, slice: null }); t += 25 * 3600000; assert.strictEqual((await q.get('2026-12')).total.tok, 5000000);
    // what is on record cannot be read just then: nothing is written over it, and it is asked again
    give = at5({ total: { cost: 100, tok: 100 }, slice: null }); q = m5('b7.db'); await q.get('2026-12'); give = at5({ total: { cost: 3, tok: 3 }, slice: null });
    { const r = m5('b7.db'), db0 = r._db.bind(r); let held = true; r._db = () => { if (held) throw new Error('database is locked'); return db0(); }; assert.strictEqual((await r.get('2026-12')).total.cost, 3); held = false; assert.strictEqual(m5('b7.db')._disk('2026-12').total.cost, 100, 'not written over'); assert.strictEqual((await r.get('2026-12')).total.cost, 100, 'asked again, at once'); }
    const ses = (title) => ({ total: { cost: 9, tok: 9 }, sessions: [{ sessionId: 'S1', title }, { sessionId: 'S2', title: title && '二' }], slice: { sessions: [['S1', 0, title], ['S2', 0, title && '二']] } });
    give = at5(ses('舊標題')); q = m5('b6.db'); await q.get('2026-12'); give = at5(Object.assign({ dataAt: to + 1 }, ses(''))); t += 25 * 3600000; { const z = await q.get('2026-12'); assert.deepStrictEqual([z.dataAt, z.sessions.map((x) => x.title), z.slice.sessions.map((x) => x[2])], [to + 1, ['舊標題', '二'], ['舊標題', '二']]); }
  }
  assert.strictEqual(new Monthly({ db, legacyDir, run, now: () => clock }).ensurePrevious(), false);
  assert.strictEqual(calls.length, 1);
});
