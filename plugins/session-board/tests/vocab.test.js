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

test('one per project, in this person\'s own board folder; no folder, nothing kept (asked 2026-11-22)', () => {
  const a = V.fileFor('C:\\work\\proj-a'), b = V.fileFor('C:\\work\\proj-b');
  assert.ok(a.startsWith(path.join(os.homedir(), '.claude', 'session-board', 'vocab')) && a !== b);
  assert.strictEqual(V.fileFor('C:\\WORK\\Proj-A\\'), a, 'the same folder however written');
  assert.strictEqual(V.fileFor(''), '');
  // one project's words are not another's
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v-')), fa = path.join(dir, 'a.json'), fb = path.join(dir, 'b.json');
  V.add('alpha', fa); V.learn('哥特 push', 'git push', fa);
  assert.deepStrictEqual([V.terms([], 10, fa), V.terms([], 10, fb), V.fixes(10, fb)], [['alpha', 'git'], [], []]);
  assert.throws(() => V.add('x', ''), /專案/);
  // the old one for every folder: copied into a project only when asked, never deleted
  const old = path.join(dir, 'old.json'); V.save({ words: [{ term: 'legacy', at: 1 }], fixes: [{ heard: '哈', meant: 'ha', n: 1, at: 1 }], hidden: ['Noise'] }, old);
  assert.strictEqual(V.legacyCount(fb, old), 3, 'hidden words count too');
  assert.deepStrictEqual(V.importLegacy(fb, old), { ok: true, words: 1, fixes: 1, hidden: 1 });
  assert.deepStrictEqual([V.terms([], 10, fb).includes('legacy'), V.load(fb).hidden, fs.existsSync(old)], [true, ['Noise'], true]);
  assert.strictEqual(V.legacyCount(fb, old), 0, 'copied: nothing more to offer, the button goes');
  assert.deepStrictEqual(V.importLegacy(fb, old), { ok: true, words: 0, fixes: 0, hidden: 0 }, 'twice: nothing twice');
  // only hidden words left in the old one: still offered (review 2026-11-22)
  const onlyHidden = path.join(dir, 'old2.json'); V.save({ words: [], fixes: [], hidden: ['Other'] }, onlyHidden);
  assert.strictEqual(V.legacyCount(fa, onlyHidden), 1);
  // a project whose lists are full: nothing of its own is pushed out, and nothing is offered that would not fit
  const full = path.join(dir, 'full.json'), many = path.join(dir, 'many.json');
  V.save({ words: Array.from({ length: V.MAX_WORDS }, (_, i) => ({ term: 'w' + i, at: 1 })), fixes: Array.from({ length: 300 }, (_, i) => ({ heard: 'h' + i, meant: 'm' + i, n: 1, at: 1 })), hidden: [] }, full);
  V.save({ words: [{ term: 'new', at: 1 }], fixes: [{ heard: 'x', meant: 'y', n: 1, at: 1 }], hidden: [] }, many);
  assert.strictEqual(V.legacyCount(full, many), 0, 'no room: not offered');
  assert.deepStrictEqual(V.importLegacy(full, many), { ok: true, words: 0, fixes: 0, hidden: 0 });
  const after = V.load(full);
  assert.deepStrictEqual([after.words.length, after.fixes.length, after.fixes[0].heard], [V.MAX_WORDS, 300, 'h0'], 'its own corrections, the oldest too, still there');
  // the old file's own repeats once; the newest corrections first when only some fit; hidden vs yours: yours wins
  const messy = path.join(dir, 'messy.json'), p2 = path.join(dir, 'p2.json');
  V.save({ words: [{ term: 'Git', at: 1 }, { term: 'git', at: 2 }], fixes: [{ heard: 'a', meant: 'A', n: 1, at: 1 }, { heard: 'b', meant: 'B', n: 1, at: 9 }], hidden: ['Mine', 'mine', 'Git'] }, messy);
  V.save({ words: [{ term: 'Mine', at: 1 }], fixes: Array.from({ length: 299 }, (_, i) => ({ heard: 'k' + i, meant: 'v' + i, n: 1, at: 1 })), hidden: ['git'] }, p2);
  assert.deepStrictEqual(V.importLegacy(p2, messy), { ok: true, words: 1, fixes: 1, hidden: 0 });
  const got = V.load(p2);
  assert.deepStrictEqual([got.words.map((w) => w.term), got.fixes.slice(-1)[0].heard, got.hidden], [['Mine', 'Git'], 'b', []], 'one Git; the newer correction; Git now yours is no longer hidden, Mine stays yours');
});

test('learning at the moment: a name put right in a sentence said again is a word to listen for; a pasted address is not', () => {
  // (asked 2026-11-21: the tidying is to be right when it is done - no correcting later, no weekly tidy)
  const V = require('../lib/vocab');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v-')), 'v.json');
  assert.deepStrictEqual(V.learn('我想要哥特那個分支先合併然後再推上去給大家看', '請把 git 分支合併後推上去，讓大家都能看到這次的改動', file), [{ heard: '', meant: 'git' }]);
  assert.deepStrictEqual(V.learn('打開網頁', '打開 https://example.com/a 看看', file), []);
  assert.deepStrictEqual(V.learn('哥特 push 一下', 'git push 一下', file), [{ heard: '哥特', meant: 'git' }]);
  assert.deepStrictEqual(V.learn('今天天氣很好我們出去走走吧', '明天下雨我們待在家裡看書好了', file), []);
  assert.deepStrictEqual([V.load(file).words.map((w) => w.term), V.load(file).fixes.map((x) => x.heard + '->' + x.meant)], [['git'], ['哥特->git']]);
});

test('words typed on after what the mic gave are not learned; nor the pieces of a path (review 2026-11-21)', () => {
  const V = require('../lib/vocab');
  const f = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v-')), 'v.json');
  assert.deepStrictEqual(V.learn('請把它改好', '請把它改好，順便跑 npm test', f()), []);
  assert.deepStrictEqual(V.learn('我想要看那個檔案然後再推上去給大家看看吧', String.raw`請打開 C:\work\notes.md 和 src/app.js 再推上去給大家看看吧`, f()), []);
  assert.deepStrictEqual(V.learn('我想要看那個檔案然後再推上去給大家看看吧', String.raw`請打開 C:\work\notes.md 再跟 vitest 一起推上去給大家看看吧`, f()), [{ heard: '', meant: 'vitest' }]);
});

test('a path written right next to Chinese words takes only itself away, not the words beside it (review 2026-11-21)', () => {
  const V = require('../lib/vocab');
  assert.deepStrictEqual(V.newNames('', String.raw`打開C:\work\notes.md用vitest跑`), ['vitest']);
  assert.deepStrictEqual(V.newNames('', 'and/or 都可以，src/app.js 交給 Prettier'), ['Prettier']);
  // whatever characters the names in a path use (review 2026-11-21)
  assert.deepStrictEqual(V.newNames('', 'src/foo+bar.js 跟 packages/@scope/tool 交給 Biome'), ['Biome']);
  assert.deepStrictEqual(V.newNames('', String.raw`D:\專案\My-App\v2.0\x.md用Deno`), ['Deno']);
  // a path written against a comma, quotes or brackets, or Japanese: the word beside it stays
  assert.deepStrictEqual(V.newNames('', '用vitest,src/a.js跑'), ['vitest']);
  assert.deepStrictEqual(V.newNames('', '(src/a.js)和"lib/b.js"交給Biome'), ['Biome']);
  assert.deepStrictEqual(V.newNames('', 'これはJest/src/a.jsです'), []);
  assert.deepStrictEqual(V.newNames('', 'これはsrc/a.jsとJestです'), ['Jest']);
  // a colon, ? ! or | right against a path ends it; a drive letter only where it starts a word
  for (const t of ['用vitest:src/a.js跑', 'vitest|src/a.js', 'vitest!src/a.js', 'ㅋㅋsrc/a.js 跟 vitest']) assert.deepStrictEqual(V.newNames('', t), ['vitest'], t);
  assert.deepStrictEqual(V.newNames('', String.raw`Biome:C:\x\y.md`), ['Biome']);
  // a file or folder named in Chinese: its extension is not a word; the words after a path still are
  for (const t of ['看 .claude/harness/A-漏水診斷書.md 這份', String.raw`D:\專案\報告.docx 給`, '改 docs/規格書-v2.pdf', 'scripts/建置.ps1 跑']) assert.deepStrictEqual(V.newNames('', t), [], t);
  assert.deepStrictEqual(V.newNames('', String.raw`打開C:\work\notes.md用vitest跑`), ['vitest']);
  // a correction stays when its word is also in a pasted address
  assert.deepStrictEqual(V.edits('吉特 推到 那裡', 'git 推到 git@github.com:acme/tool'), [{ heard: '吉特', meant: 'git' }]);
  // a web address after a list number or a mark, a drive after a mark (review 2026-11-21)
  for (const t of ['1.https://example.com/vitest-runner 跑', '-https://example.com/a 跑', '第3步 1.https://abc.example.com/vitest']) assert.deepStrictEqual(V.newNames('', t), [], t);
  assert.deepStrictEqual(V.edits('網頁 在 這', '網頁 在 1.https://example.com/a'), []);
  assert.deepStrictEqual(V.newNames('', String.raw`out-C:\work\a.md`), ['out']);
  // a small letter and a colon after a mark ends a name, it is not a drive
  assert.deepStrictEqual(V.newNames('', 'see util.c:src/util.c'), ['see', 'util.c']);
  assert.deepStrictEqual(V.newNames('', 'file.h:/usr/include/x.h'), ['file.h']);
  assert.deepStrictEqual(V.newNames('', 'my-app-v:1/2 test'), ['my-app-v', 'test']);
  assert.deepStrictEqual(V.newNames('', 'e.g.C:/x/y 跟 Bun'), ['e.g', 'Bun']);
  // a long run of letters, dots or slashes takes linear time too
  for (const unit of ['a', 'a.', 'a/', 'a-b.', '1', '1a', '-a', 'a@', 'a=', 'é']) {
    let t1 = Date.now(); V.newNames('', unit.repeat(2000)); const s1 = Date.now() - t1;
    t1 = Date.now(); V.newNames('', unit.repeat(8000)); const s2 = Date.now() - t1;
    assert.ok(s2 < 8 * s1 + 40, JSON.stringify(unit) + ': four times as long took ' + s2 + 'ms against ' + s1 + 'ms');
  }
  // a long sentence of Chinese takes linear time (it took n²)
  const long = '這是一段很長的中文句子'.repeat(400); let t0 = Date.now(); V.newNames('', long); const a = Date.now() - t0;
  t0 = Date.now(); V.newNames('', long + long + long + long); const b = Date.now() - t0;
  assert.ok(b < 8 * a + 40, 'four times as long took ' + b + 'ms against ' + a + 'ms');
  // web addresses of any kind, and git's user@host: form
  for (const t of ['git@github.com:acme/tool', 'git@github.com:tool', 'user@myserver:repo.git', 'user@server:repo!tools,x', 'ssh://git@github.com/acme/tool', 'HTTPS://github.com/acme/tool', 'file:///C:/x/y.md']) assert.deepStrictEqual(V.newNames('', t + ' 給 Biome'), ['Biome'], t);
});

test('learning asks first: a preview keeps nothing; only what you said yes to is kept (asked 2026-11-27)', () => {
  const f = tmpFile();
  const got = V.learn('你幫我哥特 commit 一下', '你幫我 git commit 一下', f, { dry: true });
  assert.deepStrictEqual(got, [{ heard: '哥特', meant: 'git' }]);
  assert.deepStrictEqual([V.load(f).fixes, V.load(f).words], [[], []], 'a preview: nothing kept');
  assert.deepStrictEqual(V.remember(got, f), [{ heard: '哥特', meant: 'git' }]);
  assert.deepStrictEqual(V.load(f).fixes.map((x) => [x.heard, x.meant, x.n]), [['哥特', 'git', 1]]);
  assert.ok(V.load(f).words.some((w) => w.term === 'git' && w.learned), 'a word with letters is listened for too');
  V.remember(got, f); assert.strictEqual(V.load(f).fixes[0].n, 2, 'said yes again: counted');
  V.remember([{ heard: '', meant: 'DAPFE' }, { heard: 'x', meant: 'x' }, { heard: 'a' }, null], f);
  assert.ok(V.load(f).words.some((w) => w.term === 'DAPFE'), 'a word to listen for');
  assert.strictEqual(V.load(f).fixes.length, 1, 'nothing kept for a pair that changes nothing or has no meaning');
});
test('a full list is not offered a word it would not keep, and 記住 says what was kept (review 2026-11-27)', () => {
  const f = tmpFile();
  V.save({ words: Array.from({ length: V.MAX_WORDS }, (_, i) => ({ term: 'w' + i, at: 1, learned: false })), fixes: [], hidden: [] }, f);
  const given = '我想要哥特那個分支先合併然後再推上去給大家看', sent = '請把 git 分支合併後推上去，讓大家都能看到這次的改動';
  assert.deepStrictEqual(V.learn(given, sent, f, { dry: true }), [], 'no room: no word offered');
  assert.deepStrictEqual(V.remember([{ heard: '', meant: 'vitest' }], f), [], 'no room: nothing said to be kept');
  assert.strictEqual(V.load(f).words.length, V.MAX_WORDS);
  assert.deepStrictEqual(V.remember([{ heard: '', meant: 'w3' }], f), [{ heard: '', meant: 'w3' }], 'one already there: kept');
  // a correction still goes in (the newest is kept), its word only when there is room
  assert.deepStrictEqual(V.remember([{ heard: '哥特', meant: 'git' }], f), [{ heard: '哥特', meant: 'git' }]);
  assert.deepStrictEqual(V.load(f).fixes.map((x) => x.meant), ['git']);
  const g = tmpFile();
  assert.deepStrictEqual(V.learn(given, sent, g, { dry: true }), [{ heard: '', meant: 'git' }], 'room: offered');
});
