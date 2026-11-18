'use strict';
// lib/judge.js: one fixed question to the small model about a reply ("is work left undone?"), answered as one JSON line.
const test = require('node:test');
const assert = require('node:assert');
const { Judge, readJudgement, SHOW_AT, MAX_CHARS, FAIL_KEEP_MS } = require('../lib/judge');

test('a failed judgement is asked again only after FAIL_KEEP_MS; a good one is kept', async () => {
  let t = 1000000, calls = 0, fail = true;
  const j = new Judge({ now: () => t, run: async () => { calls++; return fail ? { ok: false, error: 'x' } : { ok: true, text: '{"unfinished": 0.9}' }; } });
  await j.ask('k', 'a'); await j.ask('k', 'a');
  assert.strictEqual(calls, 1);
  t += FAIL_KEEP_MS + 1; fail = false;
  assert.strictEqual((await j.ask('k', 'a')).show, true, 'retried after the wait');
  t += FAIL_KEEP_MS * 10; await j.ask('k', 'a');
  assert.strictEqual(calls, 2, 'a good answer is not asked again');
});

test('the answer is read as a probability and up to five items; anything else is not taken', () => {
  assert.deepStrictEqual(readJudgement('{"unfinished": 0.92, "items": ["第 9 封還沒改", "第 10 封還沒改"]}'), { unfinished: 0.92, items: ['第 9 封還沒改', '第 10 封還沒改'] });
  assert.deepStrictEqual(readJudgement('好的：\n{"unfinished": 1.4}'), { unfinished: 1, items: [] }, 'clamped; text around the JSON ignored');
  assert.strictEqual(readJudgement('{"unfinished": "maybe"}'), null);
  assert.strictEqual(readJudgement('沒有 JSON'), null);
  assert.strictEqual(readJudgement('{"unfinished": 0.5, "items": ["a","b","c","d","e","f"]}').items.length, 5);
});

test('asked once per message; the button only from SHOW_AT; a failed call is said, not guessed', async () => {
  const asked = [];
  const answers = { a: '{"unfinished": 0.9, "items": ["x"]}', b: '{"unfinished": 0.1, "items": []}', c: 'garbage' };
  const j = new Judge({ run: async (prompt) => { asked.push(prompt); const k = /<<<\n(\w)/.exec(prompt)[1]; return k === 'd' ? { ok: false, error: '判讀逾時' } : { ok: true, text: answers[k] }; } });
  const [a1, a2] = await Promise.all([j.ask('s|1', 'a 還沒改'), j.ask('s|1', 'a 還沒改')]);
  assert.deepStrictEqual([a1.show, a1.items, a2 === a1 || a2.show === a1.show], [true, ['x'], true]);
  assert.strictEqual(asked.length, 1, 'the same message asked at the same time: one call');
  await j.ask('s|1', 'a'); assert.strictEqual(asked.length, 1, 'and kept afterwards');
  assert.strictEqual((await j.ask('s|2', 'b 已完成')).show, false);
  assert.strictEqual(SHOW_AT, 0.7);
  assert.deepStrictEqual(await j.ask('s|3', 'c'), { ok: false, error: '判斷結果不是預期的格式' });
  assert.deepStrictEqual(await j.ask('s|4', 'd'), { ok: false, error: '判讀逾時' });
  const n = asked.length;
  await j.ask('s|4', 'd'); await j.ask('s|3', 'c');
  assert.strictEqual(asked.length, n, 'a failure is kept too: a page reload does not ask again');
  assert.strictEqual((await j.ask('', 'x')).ok, false);
  // a long reply: only its end is sent (where a turn says what is left)
  await j.ask('s|5', 'a' + 'x'.repeat(MAX_CHARS * 2) + 'END');
  const last = asked[asked.length - 1];
  assert.ok(last.includes('END') && last.length < MAX_CHARS + 200);
});
