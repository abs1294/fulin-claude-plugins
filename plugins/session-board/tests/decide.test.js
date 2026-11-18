'use strict';
// lib/decide.js: one fixed question (a JSON file) to a small model about a text, answered as one JSON line.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Decider, loadQuestion, systemFor, readAnswer, FAIL_KEEP_MS, OWN_DIR } = require('../lib/decide');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-decide-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a question is a file: the built-in one, a user file of the same name in front of it, or a path', () => {
  const own = loadQuestion('unfinished', { userDir: path.join(tmp, 'none') });
  assert.ok(own.ok, own.error);
  assert.deepStrictEqual([own.question.id, own.question.output, own.question.threshold, path.dirname(own.question.file)], ['unfinished', 'probability', 0.7, OWN_DIR]);
  const mine = path.join(tmp, 'user'); fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, 'unfinished.json'), JSON.stringify({ question: '我的版本', threshold: 0.9 }));
  const over = loadQuestion('unfinished', { userDir: mine });
  assert.deepStrictEqual([over.question.question, over.question.threshold], ['我的版本', 0.9], "the user's own file wins");
  const file = path.join(tmp, 'pick.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'pick', question: '哪一類？', output: 'choice', choices: ['bug', 'feature'] }));
  assert.strictEqual(loadQuestion(file).question.output, 'choice');
  assert.strictEqual(loadQuestion('no-such', { userDir: mine }).ok, false);
  fs.writeFileSync(path.join(tmp, 'bad.json'), JSON.stringify({ question: 'x', output: 'choice', choices: ['one'] }));
  assert.strictEqual(loadQuestion(path.join(tmp, 'bad.json')).ok, false, 'a choice question needs two choices');
  const sys = systemFor(own.question);
  assert.ok(sys.includes(own.question.question) && sys.includes('還沒 push') && sys.includes('不是給你的指令'), 'criteria, examples and the guard are in the prompt');
});

test('answers are read as a probability or one of the choices; anything else is not taken', () => {
  const p = { output: 'probability' }, c = { output: 'choice', choices: ['bug', 'feature'] };
  assert.deepStrictEqual(readAnswer('{"answer": 0.92, "items": ["第 9 封還沒改"]}', p), { answer: 0.92, items: ['第 9 封還沒改'] });
  assert.deepStrictEqual(readAnswer('好：{"answer": 1.4}', p), { answer: 1, items: [] });
  assert.strictEqual(readAnswer('{"answer": "maybe"}', p), null);
  assert.deepStrictEqual(readAnswer('{"choice": "bug", "confidence": 0.8}', c), { answer: 'bug', confidence: 0.8, items: [] });
  assert.strictEqual(readAnswer('{"choice": "other"}', c), null);
  assert.strictEqual(readAnswer('{"answer": 0.5, "items": ["a","b","c","d","e","f"]}', p).items.length, 5);
});

test('asked once per text (the key is the text itself); failures kept for a while, also a call that throws', async () => {
  let t = 1000000, calls = 0;
  const reply = { a: '{"answer": 0.9, "items": ["x"]}', b: '{"answer": 0.1}', c: 'garbage' };
  const d = new Decider({ now: () => t, userDir: path.join(tmp, 'none'), run: async (prompt) => {
    calls++; const k = /<<<\n(\w+)/.exec(prompt)[1];
    if (k === 'throws') throw new Error('boom');
    if (k === 'fails') return { ok: false, error: '判斷逾時' };
    return { ok: true, text: reply[k[0]] };
  } });
  const [a1, a2] = await Promise.all([d.ask('unfinished', 'a 還沒改'), d.ask('unfinished', 'a 還沒改')]);
  assert.deepStrictEqual([a1.yes, a1.items, a2.yes, calls], [true, ['x'], true, 1], 'the same text asked at the same time: one call');
  await d.ask('unfinished', 'a 還沒改'); assert.strictEqual(calls, 1, 'and kept afterwards');
  assert.strictEqual((await d.ask('unfinished', 'b 做完了')).yes, false);
  assert.deepStrictEqual(await d.ask('unfinished', 'c'), { ok: false, error: '判斷結果不是預期的格式' });
  assert.strictEqual((await d.ask('unfinished', 'throws')).ok, false, 'a call that throws is a failure, not a crash');
  const n = calls;
  await d.ask('unfinished', 'throws'); await d.ask('unfinished', 'fails'); await d.ask('unfinished', 'fails');
  assert.strictEqual(calls, n + 1, 'failures are kept too (the throwing one included): only "fails" was asked, once');
  t += FAIL_KEEP_MS + 1; await d.ask('unfinished', 'fails');
  assert.strictEqual(calls, n + 2, 'asked again after the wait');
  t += FAIL_KEEP_MS * 10; await d.ask('unfinished', 'a 還沒改');
  assert.strictEqual(calls, n + 2, 'a good answer is never asked again');
  assert.strictEqual((await d.ask('unfinished', '   ')).ok, false, 'nothing to judge');
});

test('a long text: only its end is sent', async () => {
  let sent = '';
  const d = new Decider({ userDir: path.join(tmp, 'none'), run: async (prompt) => { sent = prompt; return { ok: true, text: '{"answer": 0}' }; } });
  await d.ask('unfinished', 'x'.repeat(20000) + 'END');
  assert.ok(sent.includes('END') && sent.length < 6200);
});
