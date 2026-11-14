'use strict';
// node --test plugins/session-board/tests/monthly.test.js
// The month scan is run for real, against a made-up home folder.
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
// Local-time timestamps: the month is the one on the wall clock, not UTC.
const at = (y, mo, d, h) => new Date(y, mo - 1, d, h || 12).toISOString();
const turn = (id, model, ts, usage, extra) => JSON.stringify(Object.assign({ type: 'assistant', sessionId: 'S1', cwd: 'C:\\w\\proj', timestamp: ts, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage } }, extra));

test('usage-scan: one month, every session, each API message once, priced per model', () => {
  const home = tmp();
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
  // A project untouched since before the month is not even opened.
  const oldProj = path.join(home, '.claude', 'projects', 'C--old');
  fs.mkdirSync(oldProj, { recursive: true });
  const oldFile = path.join(oldProj, 'S9.jsonl');
  fs.writeFileSync(oldFile, turn('m9', 'claude-opus-5-5', at(2026, 11, 3), U) + '\n');
  fs.utimesSync(oldFile, new Date(2026, 8, 1), new Date(2026, 8, 1));

  const out = JSON.parse(execFileSync(process.execPath, [SCAN, '2026-11'], { env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home }), encoding: 'utf8' }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.priced, true);                                    // cc-statusline's price table, found beside this plugin
  assert.deepStrictEqual([out.files, out.records, out.duplicates, out.sessionCount, out.daysInMonth], [2, 3, 2, 1, 30]);
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
  assert.strictEqual((await again.get('2026-10')).total.cost, 4);            // a new server reads it back, no scan
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(again.stored().map((r) => [r.month, r.cost]), [['2026-10', 4]]);

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
  const run = (bin, args, opts, cb) => { calls.push(args[1]); cb(null, JSON.stringify({ ok: true, month: args[1], computedAt: clock.getTime(), total: { cost: 7 } })); };
  const db = path.join(d, 'board.db'), legacyDir = path.join(d, 'usage');
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, '2026-10.json'), JSON.stringify({ ok: true, month: '2026-10', computedAt: 5, total: { cost: 3, tok: 9 } }));   // from before the database
  const m = new Monthly({ db, legacyDir, run, now: () => clock });
  assert.strictEqual((await m.get('2026-10')).total.cost, 3);                       // read in from the old file, no scan
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(m.ensurePrevious(), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls, ['2026-12']);
  assert.deepStrictEqual(m.stored().map((r) => [r.month, r.cost, r.tokens]), [['2026-12', 7, 0], ['2026-10', 3, 9]]);
  assert.strictEqual(m.ensurePrevious(), false);                                    // already written down
  assert.strictEqual(new Monthly({ db, legacyDir, run, now: () => clock }).ensurePrevious(), false);
  assert.strictEqual(calls.length, 1);
});
