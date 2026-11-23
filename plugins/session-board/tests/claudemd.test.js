'use strict';
// node --test plugins/session-board/tests/claudemd.test.js
// The CLAUDE.md panel's own part (lib/claudemd.js): which files, in what order, the mechanical check, and writing a
// change and taking it back. A made-up home and project in a temporary folder; nothing of this computer's is read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
test('the lines a selection is in: as the page showed them, and a piece that is there once', () => {
  const { piece } = require('../lib/claudemd');
  const t = 'a\r\n- x\r\n\r\nb\r\n- x\r\nc';
  require('node:assert').deepStrictEqual(piece(t, 0, 1, 'a'), { before: 'a', from: 0, to: 1 });
  require('node:assert').deepStrictEqual(piece(t, 4, 5, '- x'), { before: 'b\n- x\nc', from: 3, to: 6 }, 'there twice: the lines beside it are taken in');
  require('node:assert').deepStrictEqual(piece('x\nx', 0, 1, 'x'), { before: 'x\nx', from: 0, to: 2 });
  for (const a of [[0, 1, 'b'], [2, 3, ''], [5, 9, 'c'], [1, 1, ''], [1.5, 2, 'x'], [undefined, 1, 'a']]) require('node:assert').strictEqual(piece(t, ...a), null);
});
test('the page\'s pieces of a file: every line with words in exactly one, the same as md() makes of the whole', () => {
  const assert = require('node:assert'), src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const a = src.indexOf('function cmBlocks('), z = src.indexOf('\n}\n', a) + 3, cmBlocks = new Function(src.slice(a, z) + '; return cmBlocks;')();
  const text = ['---', 'paths: x', '---', '# T', 'para 1', 'para 2', '', '- a', '  more of a', '- b', '  - c', '1. one', '2. two', '   more', '', '```js', '# not a heading', '', '- not a bullet', '```', '| h | i |', '|---|---|', '| 1 | 2 |', 'after', '---', '```', 'never closed', ''];
  const B = cmBlocks(text); const seen = text.map(() => 0); for (const b of B) for (let i = b.from; i < b.to; i++) seen[i]++;
  text.forEach((l, i) => { if (l.trim()) assert.strictEqual(seen[i], 1, i + ' ' + l); else assert.ok(seen[i] <= 1); });
  assert.deepStrictEqual(B.map((b) => [b.from, b.to]), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 6], [7, 9], [9, 10], [10, 11], [11, 14], [15, 20], [20, 23], [23, 24], [24, 25], [25, 28]]);
  assert.deepStrictEqual(cmBlocks(['', ' ']), []);
});
const assert = require('node:assert');
const C = require('../lib/claudemd');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-test-'));
const HOME = path.join(ROOT, 'home'), TOP = path.join(ROOT, 'top'), PROJ = path.join(TOP, 'proj');
const w = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); return p; };
const o = { home: HOME, managed: path.join(ROOT, 'managed', 'CLAUDE.md'), commandNames: () => new Set(['my-skill', 'plug:thing']) };
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('the files Claude Code loads, in its order: managed, yours, your rules, the folders above, the project, its rules, CLAUDE.local.md, imports', () => {
  w(o.managed, '# org\n');
  w(path.join(HOME, '.claude', 'CLAUDE.md'), '# me\n@~/.claude/extra.md\n');
  w(path.join(HOME, '.claude', 'extra.md'), 'extra\n');
  w(path.join(HOME, '.claude', 'rules', 'a.md'), 'rule a\n');
  w(path.join(HOME, '.claude', 'rules', 'sub', 'b.md'), '---\npaths:\n  - "src/**/*.ts"\n---\nrule b\n');
  w(path.join(TOP, 'CLAUDE.md'), '# top\n');
  w(path.join(PROJ, 'CLAUDE.md'), '# proj\n@docs/one.md\n`@not-imported.md`\n');
  w(path.join(PROJ, 'docs', 'one.md'), '@two.md\n');
  w(path.join(PROJ, 'docs', 'two.md'), '@three.md\n');
  w(path.join(PROJ, 'docs', 'three.md'), '@four.md\n');
  w(path.join(PROJ, 'docs', 'four.md'), '@five.md\n');
  w(path.join(PROJ, 'docs', 'five.md'), 'too deep\n');
  w(path.join(PROJ, '.claude', 'CLAUDE.md'), 'inner\n');
  w(path.join(PROJ, '.claude', 'rules', 'x', 'r.md'), 'project rule\n');
  w(path.join(PROJ, 'CLAUDE.local.md'), 'mine\n');
  w(path.join(PROJ, 'AGENTS.md'), 'agents\n');
  const l = C.layers(PROJ, o);
  const rel = (f) => path.relative(ROOT, f.abs).replace(/\\/g, '/');
  const want = ['managed/CLAUDE.md', 'home/.claude/CLAUDE.md', 'home/.claude/rules/a.md', 'home/.claude/rules/sub/b.md', 'top/CLAUDE.md',
    'top/proj/CLAUDE.md', 'top/proj/.claude/CLAUDE.md', 'top/proj/.claude/rules/x/r.md', 'top/proj/CLAUDE.local.md',
    'home/.claude/extra.md', 'top/proj/docs/one.md', 'top/proj/docs/two.md', 'top/proj/docs/three.md', 'top/proj/docs/four.md'];
  assert.deepStrictEqual(l.map(rel), want, 'four hops at most; AGENTS.md not read (there is a CLAUDE.md); a code span is not an import');
  assert.deepStrictEqual([l[0].editable, l[1].editable], [false, true], 'the managed one is read-only');
  assert.deepStrictEqual(l.find((f) => rel(f).endsWith('sub/b.md')).scoped, ['src/**/*.ts']);
  assert.deepStrictEqual(l.find((f) => rel(f).endsWith('two.md')).hops, 2);
  // the global set: no folder, only what every folder loads
  assert.deepStrictEqual(C.layers('', o).map(rel), ['managed/CLAUDE.md', 'home/.claude/CLAUDE.md', 'home/.claude/rules/a.md', 'home/.claude/rules/sub/b.md', 'home/.claude/extra.md']);
});

test('AGENTS.md is read only where no CLAUDE.md is, in the folder or above it', () => {
  const lone = path.join(ROOT, 'lone', 'p');
  w(path.join(lone, 'AGENTS.md'), 'agents\n');
  assert.deepStrictEqual(C.layers(lone, Object.assign({}, o, { managed: '' })).filter((f) => f.kind !== 'user' && f.kind !== 'user-rule' && f.kind !== 'import').map((f) => f.kind), ['agents']);
});

test('imports: not in code, quoted, or a name; ~ is home; a path with an escaped space', () => {
  const file = path.join(PROJ, 'CLAUDE.md');
  const got = C.importsOf('see @a/b.md and `@c.md`\n```\n@d.md\n```\n@~/x.md, @someone "@q.md" @My\\ Docs/e.md', file).map((x) => [x.line, x.raw]);
  assert.deepStrictEqual(got, [[1, 'a/b.md'], [5, '~/x.md'], [5, 'My\\ Docs/e.md']]);
});

test('sections by heading (not inside a fence); the text before the first heading is one too', () => {
  const s = C.sections('intro\n# A\na\n```\n# not\n```\n## A1\nx\n# B\nb');
  assert.deepStrictEqual(s.map((x) => [x.title, x.level, x.start, x.end]), [['（開頭）', 0, 0, 1], ['A', 1, 1, 8], ['A1', 2, 6, 8], ['B', 1, 8, 10]]);
  assert.strictEqual(C.sectionText('intro\n# A\na\n# B\nb', C.sections('intro\n# A\na\n# B\nb')[1]), '# A\na');
});

test('the check: long, broken imports, paths and commands not there, the same sentence twice, a key (never its value)', () => {
  const p = w(path.join(ROOT, 'c', 'proj', 'CLAUDE.md'), [
    '# x', '@gone.md', '看 `src/real.js` 與 `src/gone.js` 和 `.xls/.xlsx` 與 `main:src/a.go`',
    '用 `/my-skill`、`/plug:thing`、`/nope-skill` 和 `/help`；路由 `/recrawl`',
    '原本的 `old/thing.md` 已移除',
    'password = hunter2hunter2',
    '- 這一句寫了兩次，而且夠長到會被比對出來喔',
    '- 這一句寫了兩次，而且夠長到會被比對出來喔',
    '| 欄位 | 說明 這一列是表格的表頭所以不算重複喔 |', '| 欄位 | 說明 這一列是表格的表頭所以不算重複喔 |',
  ].concat(Array(200).fill('line')).join('\n'));
  w(path.join(ROOT, 'c', 'proj', 'src', 'real.js'), '');
  const cwd = path.dirname(p);
  const l = C.layers(cwd, Object.assign({}, o, { home: path.join(ROOT, 'nohome'), managed: '' }));
  const f = C.check(l, cwd, Object.assign({}, o, { home: path.join(ROOT, 'nohome') }));
  const k = (kind) => f.filter((x) => x.kind === kind).map((x) => x.line + ' ' + x.text);
  assert.strictEqual(k('long').length, 1);
  assert.deepStrictEqual(k('import').map((x) => x.split(' ')[0]), ['2']);
  assert.deepStrictEqual(k('path').map((x) => x.split(' ')[0] + ' ' + /提到的 (\S+)/.exec(x)[1]), ['3 src/gone.js'], 'kinds of file, a git version and a line telling of what was are not paths to look for');
  assert.deepStrictEqual(k('command').map((x) => /指令 (\S+)/.exec(x)[1]), ['/nope-skill'], 'a skill there, a built-in, a one-word route: not said');
  assert.deepStrictEqual(k('secret').map((x) => x.split(' ')[0]), ['6']);
  assert.ok(!JSON.stringify(f).includes('hunter2'));
  assert.deepStrictEqual(k('dup').map((x) => x.split(' ')[0]), ['8'], 'a table row repeating is not a sentence written twice');
});

test('the check: a relative path in your own CLAUDE.md is about whatever project you are in, not looked for', () => {
  const home = path.join(ROOT, 'h2');
  w(path.join(home, '.claude', 'CLAUDE.md'), '改 docx 的 `word/document.xml` 時，看 `~/.claude/none.md`\n');
  const l = C.layers('', { home, managed: '' });
  assert.deepStrictEqual(C.check(l, '', { home }).filter((x) => x.kind === 'path').map((x) => /提到的 (\S+)/.exec(x.text)[1]), ['~/.claude/none.md']);
});

test('pathLike', () => {
  for (const t of ['src/a.js', 'C:\\x\\y', '~/.claude/x.md', 'docs/']) assert.ok(C.pathLike(t), t);
  for (const t of ['/help', 'a b/c.md', 'https://x.com/a.md', 'plugins/<name>/x.md', '.xls/.csv', 'origin:a/b.md', 'x.md', '...']) assert.ok(!C.pathLike(t), t);
  // an absolute path on macOS and Linux; on Windows "/x" is a command or a route
  for (const t of ['/etc/claude-code/CLAUDE.md', '/Users/me/notes/']) { assert.ok(C.pathLike(t, 'darwin'), t); assert.ok(!C.pathLike(t, 'win32'), t); }
  for (const t of ['/help', '/api/claudemd', '/plug:thing']) assert.ok(!C.pathLike(t, 'linux'), t);
});

test('a file is counted whole up to 4 MB; over it Claude Code skips it (not counted, not changed); one not in UTF-8 is not changed', () => {
  const home = path.join(ROOT, 'size'), big = 'x'.repeat(600 * 1024) + '\n<!-- 不進對話的註解，不算 -->\n';
  w(path.join(home, '.claude', 'CLAUDE.md'), big);
  w(path.join(home, '.claude', 'rules', 'huge.md'), 'y'.repeat(4 * 1024 * 1024 + 10));
  fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'rules', 'utf16.md'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('規則', 'utf16le')]));
  const l = C.layers('', { home, managed: '' }), by = (n) => l.find((f) => f.abs.endsWith(n));
  assert.deepStrictEqual([by('CLAUDE.md').cut, Math.abs(by('CLAUDE.md').tokens - 600 * 256) <= 1, by('CLAUDE.md').editable], [false, true, true], 'the whole file, the comment left out');
  assert.deepStrictEqual([by('huge.md').skipped, by('huge.md').tokens, by('huge.md').editable, by('huge.md').text.length], [true, 0, false, 512 * 1024]);
  assert.deepStrictEqual([by('utf16.md').utf8, by('utf16.md').editable], [false, false]);
  const r = C.check(l, '', { home });
  assert.ok(r.some((x) => x.kind === 'size' && x.id === by('huge.md').id));
  // what the model is handed is what Claude Code receives: nothing of the skipped file, no block comment
  const pr = C.evalPrompt(l, [], { global: true });
  assert.ok(!pr.includes('yyyyyyyy') && pr.includes('整份跳過') && !pr.includes('不進對話的註解'));
});

test('a file reached through a link that leads outside the project is shown, never changed (an import, a rule)', () => {
  const home = path.join(ROOT, 'lnk-h'), proj = path.join(ROOT, 'lnk-p'), outside = path.join(ROOT, 'lnk-out');
  w(path.join(outside, 'a.md'), 'outside a\n'); w(path.join(outside, 'r.md'), 'outside rule\n');
  w(path.join(proj, 'CLAUDE.md'), '@linked/a.md\n');
  fs.mkdirSync(path.join(proj, '.claude', 'rules'), { recursive: true });
  // a folder link (a junction on Windows: no rights needed)
  fs.symlinkSync(outside, path.join(proj, 'linked'), 'junction');
  fs.symlinkSync(outside, path.join(proj, '.claude', 'rules', 'ext'), 'junction');
  const l = C.layers(proj, { home, managed: '' });
  const imp = l.find((f) => f.kind === 'import'), rule = l.find((f) => f.kind === 'rule');
  assert.deepStrictEqual([imp.abs, imp.editable, imp.away], [path.join(proj, 'linked', 'a.md'), false, true], 'its path reads inside the project; it is not');
  assert.deepStrictEqual([rule.editable, rule.away], [false, true]);
  assert.ok(/專案外/.test(C.readEdit({ file: imp.abs, before: 'outside a', after: 'z' }, l).error));
});

test('an import outside the project and outside ~/.claude is shown, never changed', () => {
  const home = path.join(ROOT, 'imp'), proj = path.join(ROOT, 'imp-p');
  w(path.join(proj, 'CLAUDE.md'), '@../imp-out/a.md\n@docs/b.md\n');
  w(path.join(ROOT, 'imp-out', 'a.md'), 'a\n'); w(path.join(proj, 'docs', 'b.md'), 'b\n');
  const l = C.layers(proj, { home, managed: '' }), a = l.find((f) => f.abs.endsWith('a.md')), b = l.find((f) => f.abs.endsWith('b.md'));
  assert.deepStrictEqual([a.editable, a.away, b.editable, !!b.away], [false, true, true, false]);
  assert.ok(/專案外/.test(C.readEdit({ file: a.abs, before: 'a', after: 'z' }, l).error));
});

test('a proposed change: only text that is there once, in a file one may change', () => {
  const p = w(path.join(ROOT, 'e', 'CLAUDE.md'), 'a\nsame\nb\nsame\n');
  const list = [{ abs: p, text: fs.readFileSync(p, 'utf8'), editable: true }, { abs: path.join(ROOT, 'm.md'), text: 'x', editable: false, kind: 'managed' }];
  assert.ok(/不只一次/.test(C.readEdit({ file: p, before: 'same', after: 'z' }, list).error));
  assert.ok(/找不到/.test(C.readEdit({ file: p, before: 'nope', after: 'z' }, list).error));
  assert.ok(/組織管理/.test(C.readEdit({ file: path.join(ROOT, 'm.md'), before: 'x', after: 'y' }, list).error));
  assert.ok(/不在這組/.test(C.readEdit({ file: path.join(ROOT, 'other.md'), before: 'x', after: 'y' }, list).error));
  assert.deepStrictEqual(C.readEdit({ file: p, before: 'a\nsame', after: 'A' }, list), { abs: p, before: 'a\nsame', after: 'A', why: '' });
});

test('apply keeps CRLF and a BOM, backs up first, refuses a file changed since; undo only while it is as written', () => {
  const dir = path.join(ROOT, 'bak');
  const p = w(path.join(ROOT, 'f', 'CLAUDE.md'), '\uFEFF# t\r\nold line\r\nend\r\n');
  const raw = fs.readFileSync(p, 'utf8');
  // a file not in UTF-8: refused, nothing written
  const u16 = path.join(ROOT, 'f', 'u16.md'); fs.writeFileSync(u16, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('old line', 'utf16le')]));
  const before16 = fs.readFileSync(u16);
  const r16 = C.apply({ abs: u16, before: 'old line', after: 'x', hash: C.sha(before16) }, dir);
  assert.ok(!r16.ok && /UTF-8/.test(r16.error)); assert.ok(fs.readFileSync(u16).equals(before16));
  const prop = { abs: p, before: 'old line', after: 'new line\nsecond', hash: C.sha(raw) };
  assert.ok(!C.apply(Object.assign({}, prop, { hash: 'x' }), dir).ok, 'changed since it was proposed');
  const r = C.apply(prop, dir);
  assert.ok(r.ok);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '\uFEFF# t\r\nnew line\r\nsecond\r\nend\r\n');
  assert.strictEqual(fs.readFileSync(r.backup, 'utf8'), raw);
  fs.appendFileSync(p, 'later\r\n');
  const u = C.undo(p, dir); assert.ok(!u.ok && /又被改過/.test(u.error), 'a later change is not overwritten');
  fs.writeFileSync(p, '\uFEFF# t\r\nnew line\r\nsecond\r\nend\r\n');
  assert.ok(C.undo(p, dir).ok);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), raw);
  assert.ok(!C.undo(p, dir).ok, 'nothing more');
});

test('apply writes through a link: the link stays a link', { skip: process.platform === 'win32' && 'symlinks need rights on Windows' }, () => {
  const real = w(path.join(ROOT, 'g', 'real.md'), 'x\n'), link = path.join(ROOT, 'g', 'CLAUDE.md');
  fs.symlinkSync(real, link);
  assert.ok(C.apply({ abs: link, before: 'x', after: 'y', hash: C.sha('x\n') }, path.join(ROOT, 'bak2')).ok);
  assert.deepStrictEqual([fs.lstatSync(link).isSymbolicLink(), fs.readFileSync(real, 'utf8')], [true, 'y\n']);
});

test('diff: hunks with context', () => {
  const h = C.diff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nD\ne\nf\ng');
  assert.deepStrictEqual(h, [{ oldStart: 2, newStart: 2, oldLines: 5, newLines: 5, lines: [' b', ' c', '-d', '+D', ' e', ' f'] }]);
});

test('the evaluation is kept to the files that are there', () => {
  const list = [{ abs: 'C:\\p\\CLAUDE.md' }];
  const r = C.readEval('前言 {"summary":"s","items":[{"kind":"hook","file":"c:\\\\p\\\\claude.md","line":3,"text":"t","suggest":"u"},{"kind":"weird","file":"x","text":"t2"}]}', list);
  assert.deepStrictEqual(r.items.map((x) => [x.kind, x.file, x.line]), [['hook', 'C:\\p\\CLAUDE.md', 3], ['other', null, null]]);
  assert.strictEqual(C.readEval('not json', list), null);
});

test('tokens: CJK about one each, other text about four characters to one', () => {
  assert.strictEqual(C.tokens('中文字'), 3);
  assert.strictEqual(C.tokens('abcdefgh'), 2);
});

test('a model answer read as JSON: around it left out, never mended (lib/modeljson.js); files are named by id, paths with forward slashes', () => {
  const { parse, PATHS, COPY } = require('../lib/modeljson');
  assert.deepStrictEqual(parse(String.raw`前言 {"file": "C:\\Users\\x\\.claude\\a.md", "t": "第一行\n第二行"} 後`), { file: String.raw`C:\Users\x\.claude\a.md`, t: '第一行\n第二行' });
  assert.deepStrictEqual(parse('```json\n{"a":1}\n```'), { a: 1 });
  // a path with single backslashes is not guessed back (review 2026-11-22: "C:\temp\bin" even reads, as a tab and a
  // backspace) - an answer that does not read is null, and kept as it came by its caller
  assert.strictEqual(parse(String.raw`{"file": "C:\Users\x"}`), null);
  assert.strictEqual(parse('no json'), null);
  assert.strictEqual(parse('{bad'), null);
  // so the prompts ask for ids and forward slashes
  const l = [{ id: 'f0', abs: path.join(ROOT, 'a', 'CLAUDE.md'), label: '專案', text: 'x', loaded: 'x', editable: true }];
  const pr = C.evalPrompt(l, [{ id: 'f0', line: 1, text: 't' }], { cwd: ROOT });
  assert.ok(pr.includes('[f0]') && pr.includes(PATHS) && pr.includes(path.join(ROOT, 'a', 'CLAUDE.md').replace(/\\/g, '/')) && pr.includes('"file":"f0"'));
  // the copy rule only where the original is copied: an edit's, a tweak's - not the evaluation
  assert.ok(C.askPrompt(l, {}, 'q', { cwd: ROOT }).includes(PATHS + COPY) && C.tweakPrompt(l[0], 'x', 'y', l).includes(PATHS + COPY) && !pr.includes(COPY));
  for (const m of ['pluginfit', 'skillwish', 'decide', 'line']) assert.ok(fs.readFileSync(path.join(__dirname, '..', 'lib', m + '.js'), 'utf8').includes("require('./modeljson').PATHS"), m + ' asks for forward slashes');
  // an answer naming a file by its id
  assert.deepStrictEqual(C.readEval('{"summary":"s","items":[{"kind":"vague","file":"f0","line":2,"text":"t"}]}', l).items[0].file, l[0].abs);
  assert.deepStrictEqual(C.readEdit({ file: 'f0', before: 'x', after: 'y' }, l).abs, l[0].abs);
  // as the model may write it: another case, in brackets
  assert.deepStrictEqual([C.readEdit({ file: '[F0]', before: 'x', after: 'y' }, l).abs, C.readEval('{"items":[{"file":"[F0]","text":"t"}]}', l).items[0].file], [l[0].abs, l[0].abs]);
  // other projects in the material: forward slashes too (copied back, they still read)
  assert.ok(!C.evalPrompt([], [], { global: true, others: [{ abs: 'C:\\p\\CLAUDE.md', loaded: 'x' }] }).includes('C:\\p'));
});

test('other projects compared in the global evaluation are read the one way: a file over 4 MB is not handed to the model', () => {
  const big = w(path.join(ROOT, 'other-big', 'CLAUDE.md'), 'z'.repeat(4 * 1024 * 1024 + 5));
  const small = w(path.join(ROOT, 'other-small', 'CLAUDE.md'), '<!-- 不進對話 -->\n規則\n');
  const others = [C.loadedFile(big), C.loadedFile(small)].map((x) => Object.assign(x, { label: '其他專案' }));
  const pr = C.evalPrompt([], [], { global: true, others });
  assert.ok(!pr.includes('zzzzzzzz') && pr.includes('整份跳過') && pr.includes('規則') && !pr.includes('不進對話'));
  // and the server builds that comparison only through it (a file read there on its own is what let one through)
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.slice(src.indexOf('const cmdOthers = '), src.indexOf('const cmdView = '));
  assert.ok(block.includes('CM.loadedFile(') && !/readFileSync/.test(block));
});

test('personal data is looked for in the files that usually go into git - not a CLAUDE.local.md, even one above', () => {
  const top = path.join(ROOT, 'pii-top'), proj = path.join(top, 'p');
  w(path.join(top, 'CLAUDE.local.md'), '聯絡 me@example.com\n');
  w(path.join(proj, 'CLAUDE.md'), '聯絡 you@example.com\n');
  w(path.join(proj, '.claude', 'rules', 'team.local.md'), '聯絡 rule@example.com\n');   // a rule: goes into git, looked at
  const l = C.layers(proj, { home: path.join(ROOT, 'pii-h'), managed: '' });
  const hit = C.check(l, proj, { home: path.join(ROOT, 'pii-h') }).filter((x) => x.kind === 'pii').map((x) => l.find((f) => f.id === x.id).abs);
  assert.deepStrictEqual(hit, [path.join(proj, 'CLAUDE.md'), path.join(proj, '.claude', 'rules', 'team.local.md')]);
});
