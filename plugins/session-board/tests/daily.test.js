'use strict';
// node --test plugins/session-board/tests/daily.test.js
// A day's summary (lib/daily.js): what goes to Claude, what is kept, the content check. Claude and Python are stand-ins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Daily, gather, promptOf, rulesOf, hitsOf } = require('../lib/daily');

const at = (h, m) => new Date(2026, 10, 3, h, m).getTime();
const rows = [
  { file: 'a', sid: 'A', who: 0, at: at(9, 0), text: '改合約' }, { file: 'a', sid: 'A', who: 1, at: at(9, 1), text: '我先看' }, { file: 'a', sid: 'A', who: 2, at: at(9, 2), text: 'Edit x' }, { file: 'a', sid: 'A', who: 1, at: at(9, 5), text: '改好了' },
  { file: 'p', sid: 'P', who: 0, at: at(9, 0), text: 'Condense the tool payload' }, { file: 'c', sid: 'C', who: 1, at: at(9, 0), text: '只有 Claude' },
];
const about = (sid) => (sid === 'P' ? null : { title: '合約', cwd: 'C:\\w', folder: 'w' });
const skill = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-')); fs.mkdirSync(path.join(r, 'skills', 'daily-report', 'scripts'), { recursive: true }); fs.writeFileSync(path.join(r, 'skills', 'daily-report', 'SKILL.md'), '# x\n\n### 2. 萃取\n舊的\n\n### 3. 生成日報\n寫作要點：說結果\n\n### 4. 閘\n後面\n'); fs.writeFileSync(path.join(r, 'skills', 'daily-report', 'scripts', 'content_guard.py'), ''); return r; };
const rig = (o = {}) => { const prompts = []; const d = new Daily(Object.assign({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'daily-')), root: skill, day: async () => rows, about, python: ['py'], run: (bin, a, opt, cb) => cb(null, '{"passed":true,"hits":[],"advisory":[]}', ''), ask: async (s, p) => { prompts.push([s, p]); return { ok: true, text: '好的：\n# 2026-11-03 工作日報\n\n## 合約\n- 完成合約修改\n' }; } }, o)); return { d, prompts }; };
const done = async (d, date) => { for (let i = 0; i < 200 && d.busy.has(date); i++) await new Promise((r) => setTimeout(r, 5)); };

test('what was said that day, yours and what came of it; a program and a conversation you said nothing in are left out', () => {
  const g = gather(rows, about);
  assert.deepStrictEqual(g, [{ title: '合約', cwd: 'C:\\w', folder: 'w', from: '09:00', to: '09:05', turns: [{ at: at(9, 0), you: '改合約', claude: '改好了', did: 1 }] }]);
  const p = promptOf('2026-11-03', g); assert.match(p, /"他說":"改合約","Claude最後回":"改好了","動作數":1/);
  const big = [{ title: 't', cwd: 'c', from: '', to: '', turns: Array.from({ length: 900 }, () => ({ at: 1, you: '你'.repeat(150), claude: '答'.repeat(500), did: 0 })) }];
  const q = promptOf('2026-11-03', big); assert.strictEqual(q.split('你'.repeat(150)).length - 1, 900, 'too much: yours stay'); assert.ok(!q.includes('答'.repeat(300)));
});

test('written by the skill\'s own words, kept, read again; nothing but the report', async () => {
  const { d, prompts } = rig(); assert.deepStrictEqual(d.make('2026-11-03'), { ok: true }); assert.strictEqual(d.month('2026-11')['2026-11-03'].state, 'running'); assert.deepStrictEqual(d.make('2026-11-03'), { ok: true, already: true }); await done(d, '2026-11-03');
  const r = d.read('2026-11-03'); assert.deepStrictEqual([r.text, r.talks, r.folders, r.said, r.partial, r.hits], ['# 2026-11-03 工作日報\n\n## 合約\n- 完成合約修改\n', 1, 1, 1, false, []]);
  assert.match(prompts[0][0], /寫作要點：說結果/); assert.ok(!/舊的|後面/.test(prompts[0][0])); assert.deepStrictEqual(d.month('2026-11'), { '2026-11-03': { state: 'done' } });
  assert.deepStrictEqual(fs.readdirSync(d.o.dir).sort(), ['2026-11-03.json', '2026-11-03.md'], 'nothing left of the check');
  assert.strictEqual(d.read('../x'), null);
});

test('what the content check finds is put right once; what is left is said; no Python is said', async () => {
  let n = 0; const run = (bin, a, o, cb) => { n++; cb(Object.assign(new Error('1'), { code: 1 }), JSON.stringify({ passed: false, hits: n === 1 ? [{ line: 4, word: 'plugin', text: 'x' }, { line: 5, word: 'agent', text: 'y' }] : [{ line: 4, word: 'plugin', text: 'x' }], advisory: [{ word: '貴司' }] }), ''); };
  const { d, prompts } = rig({ run }); d.make('2026-11-03'); await done(d, '2026-11-03');
  assert.strictEqual(prompts.length, 2); assert.match(prompts[1][1], /內容檢查不過[\s\S]*第 4 行 plugin x/); assert.deepStrictEqual(d.read('2026-11-03').hits, ['第 4 行 plugin x']);
  const none = rig({ run: (b, a, o, cb) => cb(Object.assign(new Error('no'), { code: 'ENOENT' }), '', '') }); none.d.make('2026-11-03'); await done(none.d, '2026-11-03'); assert.strictEqual(none.d.read('2026-11-03').hits, null);
  assert.deepStrictEqual(hitsOf({ hits: [] }), []);
});

test('what cannot be written is said and does not take away the one there is', async () => {
  const { d } = rig(); d.make('2026-11-03'); await done(d, '2026-11-03');
  d.o.ask = async () => ({ ok: false, error: '額度用完' }); d.make('2026-11-03'); await done(d, '2026-11-03'); assert.match(d.failed.get('2026-11-03'), /額度用完/); assert.ok(d.read('2026-11-03').text);
  const e = rig({ day: async () => [] }).d; e.make('2026-11-03'); await done(e, '2026-11-03'); assert.deepStrictEqual(e.month('2026-11'), { '2026-11-03': { state: 'failed', error: '這一天沒有你說過話的對話' } });
  const nr = rig({ day: async () => null }).d; nr.make('2026-11-03'); await done(nr, '2026-11-03'); assert.match(nr.failed.get('2026-11-03'), /讀不出來/);
  const store = []; const sp = rig({ python: ['python', 'py'], run: (b, a, o, cb) => { store.push(b); cb(b === 'python' ? Object.assign(new Error('9009'), { code: 9009 }) : null, b === 'python' ? '' : '{"hits":[]}', ''); } }).d; sp.make('2026-11-03'); await done(sp, '2026-11-03'); assert.deepStrictEqual([store, sp.read('2026-11-03').hits], [['python', 'py'], []], 'the one that only opens the Store is not Python');
  assert.match(rig({ root: () => null }).d.make('2026-11-03').error, /deliver-report/);
  for (const x of ['2026-13-01', 'x', '', '2099-01-01', '2026-02-31x']) assert.strictEqual(rig().d.make(x).ok, false, x);
});

test('the real skill still has the part this reads', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'deliver-report', 'skills')) && 'deliver-report is not beside this plugin' }, () => {
  const r = rulesOf(path.join(__dirname, '..', '..', 'deliver-report')); assert.match(r, /固定結構/); assert.match(r, /待辦與未完成/); assert.ok(!/content_guard/.test(r));
});

test('what the board sent by itself is not yours: the first words at each time, what you said after is', () => {
  const { notYours } = require('../lib/daily'), r = (sid, at, who = 0) => ({ sid, at, who });
  const rows = [r('a', 1000), r('a', 2000), r('a', 3000, 1), r('b', 1000), r('a', 900000)];
  assert.deepStrictEqual(notYours(rows, new Map([['a', [500, 899000]]])), [rows[1], rows[2], rows[3]]);
  const { sentByBoard } = require('../lib/daily');
  const runs = [{ sessionId: 'a', startedAt: 500, how: 'new', scheduleId: 1 }, { sessionId: 'a', startedAt: 900, how: 'board', scheduleId: 1 }, { sessionId: 'p', startedAt: 500, how: 'peer', scheduleId: 1 }, { sessionId: 's', startedAt: 500, how: 'board', scheduleId: 2 }, { sessionId: '', startedAt: 5, how: 'digest' }];
  assert.deepStrictEqual([...sentByBoard({ h: { by: 'health', at: 1 }, l: { by: 'line', at: 2 }, bad: null }, runs, (id) => ({ 1: '看一下進度', 2: ' /goal2:goal 做完' }[id]))], [['l', [2]], ['a', [500]]]);
  assert.deepStrictEqual(notYours(rows, new Map()), rows); assert.deepStrictEqual(notYours(rows, new Map([['a', [5e6]]])), rows);
});
