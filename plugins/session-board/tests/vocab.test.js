'use strict';
// node --test plugins/session-board/tests/vocab.test.js - the mic's own words (lib/vocab.js)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../lib/vocab');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-')), 'vocab.json');

test('what you changed in the words the mic gave: each short replaced piece; a rewrite or added words teach nothing', () => {
  assert.deepStrictEqual(V.edits('你幫我哥特 commit 一下然後普許上去', '你幫我 git commit 一下然後 push 上去'), [{ heard: '哥特', meant: 'git' }, { heard: '普許', meant: 'push' }]);
  assert.deepStrictEqual(V.edits('那個 session 波的的賴小秘書', '那個 session-board 的 LINE 小秘書'), [{ heard: 'session波的', meant: 'session-board' }, { heard: '賴', meant: 'LINE' }]);
  assert.deepStrictEqual(V.edits('今天天氣很好', '今天天氣很好。'), [], 'punctuation is not a change');
  assert.deepStrictEqual(V.edits('我想要改這一整段話的寫法讓它變得更好', '完全不同的另一句話，跟原本沒關係'), [], 'rewritten, not corrected');
  assert.deepStrictEqual(V.edits('幫我看一下', '幫我看一下，順便把測試跑完'), [], 'words added after: nothing replaced');
  assert.deepStrictEqual(V.edits('', 'x'), []);
});

test('your words: added, taken out; one of the board\'s own taken out is hidden (it would come back); learned ones count up', () => {
  const f = tmpFile(), src = ['fulin-claude-plugins', 'session-board 發版', 'session-board 修正', 'Supplier_Code'];
  assert.deepStrictEqual(V.list(src, f).auto, ['session-board', 'fulin-claude-plugins', 'Supplier_Code'], 'the board\'s names, most frequent first');
  assert.deepStrictEqual(V.add('  dapfe\n', f), { ok: true });
  assert.deepStrictEqual(V.add('DAPFE', f), { ok: true }, 'already there (case aside)');
  assert.deepStrictEqual(V.load(f).words.map((w) => w.term), ['dapfe']);
  assert.strictEqual(V.add('', f).ok, false);
  V.remove('Supplier_Code', f);
  assert.ok(!V.list(src, f).auto.includes('Supplier_Code'), 'hidden from the board\'s');
  V.add('Supplier_Code', f);
  assert.ok(V.list(src, f).words.some((w) => w.term === 'Supplier_Code') && !V.load(f).hidden.length, 'added back by you: not hidden any more');
  // learned twice: counted; what was meant (with letters) becomes a word too
  V.learn('幫我哥特 commit', '幫我 git commit', f); V.learn('哥特 push', 'git push', f);
  const v = V.load(f);
  assert.deepStrictEqual(v.fixes.map((x) => [x.heard, x.meant, x.n]), [['哥特', 'git', 2]]);
  assert.ok(v.words.some((w) => w.term === 'git' && w.learned));
  assert.deepStrictEqual(V.fixes(10, f), [{ heard: '哥特', meant: 'git' }]);
  V.unlearn('哥特', 'git', f); assert.deepStrictEqual(V.load(f).fixes, []);
  // the hints: yours first, then what was learned, then the board's; no repeats
  assert.deepStrictEqual(V.terms(src, 10, f).slice(0, 3), ['dapfe', 'Supplier_Code', 'git']);
  // one line, no < > (the OpenAI transcription refuses a request with them)
  assert.strictEqual(V.clean('a<b>\nc'), 'a b c');
});

test('kept in this person\'s own board folder, nowhere else', () => {
  assert.strictEqual(V.FILE(), path.join(os.homedir(), '.claude', 'session-board', 'vocab.json'));
});
