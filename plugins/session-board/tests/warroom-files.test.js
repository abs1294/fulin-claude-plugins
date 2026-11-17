'use strict';
// node --test plugins/session-board/tests/warroom-files.test.js
const test = require('node:test');
const assert = require('node:assert');
const WIN_ONLY = { skip: process.platform !== 'win32' && 'Windows only: Windows paths and tools (the Mac side: tests/mac.test.js, tests/mac-e2e.js)' };
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../lib/warroom');
const F = require('../lib/files');
const S = require('../lib/sessions');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-test-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const T0 = Date.parse('2026-11-12T06:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const user = (text, s, id) => JSON.stringify({ type: 'user', uuid: id, timestamp: at(s), message: { role: 'user', content: [{ type: 'text', text }] } });
const asst = (blocks, s, id, mid, usage) => JSON.stringify({ type: 'assistant', uuid: id, timestamp: at(s), message: { id: mid, model: 'claude-x', role: 'assistant', content: blocks, usage } });
const U = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

test('lastAction reads what the transcript tail says is happening', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  const write = (lines) => fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.deepStrictEqual(W.lastAction(path.join(d, 'missing.jsonl')), { state: 'starting' });
  write([user('hi', 0, 'u1')]);
  assert.deepStrictEqual(W.lastAction(f), { state: 'thinking' });
  write([user('hi', 0, 'u1'), asst([{ type: 'thinking', thinking: 'x' }], 1, 'a1', 'm1')]);
  assert.deepStrictEqual(W.lastAction(f), { state: 'thinking' });
  write([user('hi', 0, 'u1'), asst([{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\a\\b.js' } }], 2, 'a2', 'm1')]);
  assert.deepStrictEqual(W.lastAction(f), { state: 'tool', tool: 'Edit', detail: 'C:\\a\\b.js' });
  write([user('hi', 0, 'u1'), asst([{ type: 'text', text: 'done' }], 3, 'a3', 'm2'), '{"type":"last-prompt"}', '{"type":"cost-state"']);
  assert.deepStrictEqual(W.lastAction(f), { state: 'writing' });
  // A subagent's entries do not describe what the session itself is doing.
  write([asst([{ type: 'text', text: 'main' }], 3, 'a3', 'm2'), JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })]);
  assert.deepStrictEqual(W.lastAction(f), { state: 'writing' });
});

test('turnsOf cuts turns at what you typed and counts each API message once', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, [
    asst([{ type: 'text', text: '前一輪的尾巴' }], -5, 'a0', 'm0', U(1, 1, 0, 0)),
    user('第一問', 0, 'u1'),
    asst([{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }], 2, 'a1', 'm1', U(10, 5, 100, 20)),
    asst([{ type: 'text', text: '第一答' }], 4, 'a2', 'm1', U(10, 5, 100, 20)),     // same API message: usage repeated
    asst([{ type: 'text', text: '補充' }], 10, 'a3', 'm2', U(3, 7, 0, 0)),
    user('第二問', 60, 'u2'),
    asst([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], 61, 'a4', 'm3', U(2, 2, 0, 0)),
  ].join('\n') + '\n');
  const { readHistory } = require('../lib/history');
  const items = readHistory(f).items;
  const now = T0 + 100 * 1000;
  const turns = W.turnsOf(items, { busy: true, now });
  assert.strictEqual(turns.length, 2);            // the tail of an earlier turn has no beginning here: dropped
  assert.deepStrictEqual([turns[0].id, turns[0].prompt, turns[0].tools, turns[0].replies, turns[0].running, turns[0].durationMs], ['u1', '第一問', 1, 2, false, 10000]);
  assert.deepStrictEqual([turns[1].running, turns[1].durationMs, turns[1].tools, turns[1].replies], [true, 40000, 1, 0]);   // still running: measured to now
  assert.strictEqual(W.turnsOf(items, { busy: false, now })[1].running, false);
});

test('build and receipt: live sessions, stuck detection, today count, cost', () => {
  const d = tmp();
  const o = { projectsDir: path.join(d, 'p'), stateDir: path.join(d, 'st') };
  fs.mkdirSync(o.stateDir, { recursive: true });
  const cwd = 'C:\\w\\proj';
  const pdir = path.join(o.projectsDir, S.encodeCwd(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  const A = 'aaaaaaaa-1111-0000-0000-00000000000a', B = 'bbbbbbbb-1111-0000-0000-00000000000b';
  const now = T0 + 3600 * 1000;
  const fa = path.join(pdir, A + '.jsonl'), fb = path.join(pdir, B + '.jsonl');
  fs.writeFileSync(fa, [user('甲的問題', 0, 'ua'), asst([{ type: 'tool_use', name: 'Bash', input: { description: '跑測試' } }], 5, 'a1', 'm1', U(1, 2, 3, 4))].join('\n') + '\n');
  fs.writeFileSync(fb, [user('乙的問題', 100, 'ub'), asst([{ type: 'text', text: '乙的**回答**' }], 130, 'b1', 'm2', U(5, 6, 7, 8))].join('\n') + '\n');
  fs.utimesSync(fa, new Date(now - 11 * 60000), new Date(now - 11 * 60000));   // A: busy, silent for 11 minutes
  fs.writeFileSync(path.join(o.stateDir, `claude-toksum2-${S.sidKey(A)}.json`), JSON.stringify({ files: { x: { cost: 1.25, tok: 10 }, y: { cost: 0.5, tok: 5 } } }));
  const sessions = [
    { sessionId: A, cwd, title: '甲', folder: 'proj', owner: 'board', status: 'busy', group: 'running', since: now - 3000000 },
    { sessionId: B, cwd, title: '乙', folder: 'proj', owner: 'terminal', status: 'idle', group: 'yours', since: now - 1000 },
  ];
  fs.writeFileSync(path.join(o.stateDir, `claude-compacts-${S.sidKey(A)}.json`), JSON.stringify({ count: 3, last: now - 5000 }));
  fs.writeFileSync(path.join(o.stateDir, `claude-msgcount-${S.sidKey(A)}`), '42');
  const w = W.build(sessions, o, now);
  assert.strictEqual(w.stats, undefined);                     // the day totals are gone on purpose
  assert.strictEqual(w.live.length, 1);
  assert.deepStrictEqual([w.live[0].sessionId, w.live[0].stuck, w.live[0].action.state, w.live[0].action.tool, w.live[0].action.detail], [A, true, 'tool', 'Bash', '跑測試']);
  assert.ok(w.live[0].quietMs >= 11 * 60000);
  // Only finished turns are listed; A's turn is still running and is in `live` instead.
  assert.deepStrictEqual(w.turns.map((t) => [t.sessionId, t.id, t.tools, t.replied, t.durationMs]), [[B, 'ub', 0, true, 30000]]);
  // One usage row per session, dearest first; a session with no figures says null, not zero.
  assert.deepStrictEqual(w.usage.map((u) => [u.sessionId, u.cost, u.tok, u.compacts, u.messages, u.context]),
    [[A, 1.75, 15, 3, 42, 4 + 1 + 3], [B, null, null, 0, null, 5 + 7 + 8]]);   // cc-statusline is there (its folder exists) and recorded no compaction: zero, not unknown
});

test('sessionStats splits main and subagent cost and reads the tracker files', () => {
  const d = tmp();
  const sid = 'abcdabcd-1111-2222-3333-444455556666';
  const k = S.sidKey(sid);
  const w = (name, v) => fs.writeFileSync(path.join(d, name), typeof v === 'string' ? v : JSON.stringify(v));
  w(`claude-toksum2-${k}.json`, { files: {
    ['C:\\p\\' + sid + '.jsonl']: { cost: 10, tok: 1000, unpricedTok: 0, approxTok: 0 },
    'C:\\p\\sub\\agent-a1.jsonl': { cost: 2, tok: 200, unpricedTok: 0, approxTok: 5 },
    'C:\\p\\sub\\agent-a2.jsonl': { cost: 1, tok: 100 } } });
  w(`claude-compacts-${k}.json`, { count: 65, last: 1794463735989 });
  w(`claude-msgcount-${k}`, '614\n');
  w(`claude-agents-${k}.json`, { x: { name: 'qa-engineer', status: 'done' }, y: { name: 'code-reviewer', status: 'running' } });
  w(`claude-skills-${k}.json`, { 'git-commit': { count: 6, last: 9 }, 'code-review': { count: 8, last: 1 } });
  w(`claude-mcp-${k}.json`, { 'playwright__browser_tabs': { count: 32, errors: 2, last: 5 } });
  w(`claude-files-${k}.json`, ['a.py', 'b.cs']);
  const items = [{ role: 'assistant', u: { in: 5, out: 9, cr: 100, cw: 20, model: 'm1' } }, { role: 'tool' }];
  const st = require('../lib/stats').sessionStats(sid, d, items);
  assert.deepStrictEqual(st.usage, { cost: 13, tok: 1300, mainCost: 10, mainTok: 1000, agentCost: 3, agentTok: 300, agentRuns: 2, estimated: true });
  assert.deepStrictEqual(st.compacts, { count: 65, last: 1794463735989 });
  assert.strictEqual(st.messages, 614);
  assert.deepStrictEqual(st.context, { tokens: 125, model: 'm1', effort: '', window: 0, pct: null, assumed: false });   // what went IN for the newest reply; no known window, so no percentage is invented
  const S2 = require('../lib/stats');
  assert.deepStrictEqual(S2.sessionStats(sid, d, items, { windows: { m1: 1000 } }).context, { tokens: 125, model: 'm1', effort: '', window: 1000, pct: 13, assumed: false });
  const bigItems = [{ role: 'assistant', u: { in: 10, out: 0, cr: 300000, cw: 0, model: 'unknown-model' } }];
  assert.deepStrictEqual(S2.sessionStats(sid, d, bigItems).context, { tokens: 300010, model: 'unknown-model', effort: '', window: 1000000, pct: 30, assumed: true });   // over 200K can only be the 1M window
  // A conversation the board runs has no cc-statusline figures: the board's own running totals are used.
  const other = 'eeeeeeee-1111-2222-3333-444455556666';
  assert.deepStrictEqual(S2.sessionStats(other, d, [], { boardUsage: { cost: 0.9, tok: 135 } }).usage, { cost: 0.9, tok: 135, mainCost: 0.9, mainTok: 135, agentCost: 0, agentTok: 0, agentRuns: 0, estimated: false, byBoard: true });
  assert.strictEqual(S2.sessionStats(other, d, [], { boardUsage: { cost: 0, tok: 0 } }).usage, null);
  assert.strictEqual(S2.sessionStats(sid, d, items, { boardUsage: { cost: 99, tok: 99 } }).usage.cost, 13);   // cc-statusline's figure wins when it exists
  assert.deepStrictEqual(S2.sessionStats(other, d, []).compacts, { count: 0, last: 0 });
  assert.deepStrictEqual(st.agents, { running: ['code-reviewer'], kinds: ['qa-engineer', 'code-reviewer'] });
  assert.strictEqual(st.usage.agentRuns, 2);   // how many were ever started comes from here, not from the pruned list
  assert.deepStrictEqual(st.skills.map((s) => s.name + s.count), ['code-review8', 'git-commit6']);
  assert.deepStrictEqual(st.mcp, [{ name: 'playwright__browser_tabs', count: 32, last: 5, errors: 2 }]);
  assert.deepStrictEqual(st.edited, ['a.py', 'b.cs']);
  // Nothing on disk: absent, never a made-up zero.
  const none = require('../lib/stats').sessionStats('00000000-0000-0000-0000-000000000000', path.join(d, 'no-statusline-here'), []);
  assert.deepStrictEqual([none.usage, none.compacts, none.messages, none.context, none.agents.kinds.length, none.skills.length], [null, null, null, null, 0, 0]);
});

test('config: nothing stored, or a stored value of the wrong type, falls back to defaults; a real folder is accepted', () => {
  const C = require('../lib/config');
  const DB = require('../lib/db');
  const d = tmp();
  const f = path.join(d, 'board.db'), none = path.join(d, 'no-config.json');
  assert.deepStrictEqual(C.load(f, none), { pickerStartDir: '', autoRestore: false, autoContinue: true });                 // a new database
  const put = (v) => DB.open(f).prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, 0)').run('pickerStartDir', v);
  put('{ not json');
  assert.deepStrictEqual(C.load(f, none), { pickerStartDir: '', autoRestore: false, autoContinue: true });
  for (const bad of [42, ['x'], 'relative\\path', path.join(d, 'does-not-exist'), f /* a file, not a folder */]) {
    put(JSON.stringify(bad));
    assert.strictEqual(C.load(f, none).pickerStartDir, '', JSON.stringify(bad));
  }
  put(JSON.stringify(d));
  assert.deepStrictEqual(C.load(f, none), { pickerStartDir: path.normalize(d), autoRestore: false, autoContinue: true });
  DB.close(f);
});

test('config.save: refuses a bad folder with a reason, keeps keys it does not know, and can clear', () => {
  const C = require('../lib/config');
  const DB = require('../lib/db');
  const d = tmp();
  const f = path.join(d, 'sub', 'board.db'), none = path.join(d, 'no-config.json');   // the folder does not exist yet: it is created
  assert.deepStrictEqual(C.save({ pickerStartDir: '  "' + d + '"  ' }, f, none), { ok: true, config: { pickerStartDir: path.normalize(d), autoRestore: false, autoContinue: true } });   // pasted with quotes and spaces
  DB.open(f).prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)').run('futureSetting', JSON.stringify({ a: 1 }));
  for (const [bad, why] of [['relative\\x', '完整路徑'], [path.join(d, 'nope'), '找不到'], [42, '文字']]) {
    const r = C.save({ pickerStartDir: bad }, f, none);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes(why), r.error);
  }
  assert.strictEqual(C.stored(f, none).pickerStartDir, path.normalize(d));                 // a refused save changed nothing
  assert.deepStrictEqual(C.save({ pickerStartDir: '' }, f, none), { ok: true, config: { pickerStartDir: '', autoRestore: false, autoContinue: true } });
  assert.deepStrictEqual(C.stored(f, none), { futureSetting: { a: 1 } });                  // cleared, the unknown key untouched
  DB.close(f);
});

test('config: the old config.json is copied into the database once, then set aside', () => {
  const C = require('../lib/config');
  const DB = require('../lib/db');
  const d = tmp();
  const f = path.join(d, 'board.db'), old = path.join(d, 'config.json');
  fs.writeFileSync(old, '\ufeff' + JSON.stringify({ pickerStartDir: d, autoRestore: true, somethingElse: [1] }));   // saved by Notepad with a BOM
  assert.deepStrictEqual(C.load(f, old), { pickerStartDir: path.normalize(d), autoRestore: true, autoContinue: true });
  assert.deepStrictEqual(C.stored(f, old), { pickerStartDir: d, autoRestore: true, somethingElse: [1] });
  assert.deepStrictEqual([fs.existsSync(old), fs.existsSync(old + '.imported')], [false, true]);
  // A config.json that appears later is not read again: the database is the record now.
  C.save({ autoRestore: false, autoContinue: true }, f, old);
  fs.writeFileSync(old, JSON.stringify({ autoRestore: true, autoContinue: true }));
  assert.strictEqual(C.load(f, old).autoRestore, false);
  DB.close(f);
});

test('a compaction summary is a marker in the conversation, not something you said', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, [
    user('壓縮前的問題', 0, 'u1'),
    JSON.stringify({ type: 'user', uuid: 'cs', timestamp: at(50), isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: '<artifact-content-authored-by-others/>\nThis session is being continued from a previous conversation...' } }),
    user('壓縮後的問題', 60, 'u2'),
    asst([{ type: 'text', text: '答' }], 70, 'a1', 'm1', U(1, 1, 0, 0)),
  ].join('\n') + '\n');
  const { readHistory } = require('../lib/history');
  const items = readHistory(f).items;
  assert.deepStrictEqual(items.map((i) => [i.role, i.text]), [['user', '壓縮前的問題'], ['compact', undefined], ['user', '壓縮後的問題'], ['assistant', '答']]);
  assert.deepStrictEqual(W.turnsOf(items).map((t) => t.prompt), ['壓縮前的問題', '壓縮後的問題']);   // not counted as a turn of yours
});

test('files: kinds, what may be opened, and resolving what was written', WIN_ONLY, () => {
  assert.deepStrictEqual(['a.PNG', 'b.pdf', 'c.docx', 'd.xlsx', 'e.pptx', 'f.md', 'g.cs', 'h.exe', 'README', 'x.zip'].map(F.kindOf),
    ['image', 'pdf', 'office', 'office', 'office', 'text', 'text', 'other', 'text', 'other']);
  // Documents and data open with one click; anything that runs does not.
  assert.deepStrictEqual(['a.docx', 'a.pdf', 'a.png', 'a.md', 'a.ps1', 'a.bat', 'a.exe', 'a.js', 'a.lnk', 'a.cmd'].map(F.canOpen),
    [true, true, true, true, false, false, false, false, false, false]);
  assert.strictEqual(F.mimeOf('x.html'), 'text/plain; charset=utf-8');   // never served as a page
  assert.strictEqual(F.mimeOf('x.svg'), 'image/svg+xml');

  const cwd = path.join(os.tmpdir(), 'proj');
  assert.strictEqual(F.resolve('src/a.js:12', cwd), path.join(cwd, 'src', 'a.js'));
  assert.strictEqual(F.resolve('src/a.js:12-30', cwd), path.join(cwd, 'src', 'a.js'));
  assert.strictEqual(F.resolve('`C:\\x\\報告 final.docx`', cwd), 'C:\\x\\報告 final.docx');
  assert.strictEqual(F.resolve('a.js', ''), null);                // relative with no folder to resolve against
  assert.strictEqual(F.resolve('a<b>.js', cwd), null);
  assert.strictEqual(F.resolve('x'.repeat(500), cwd), null);
});

test('a file mentioned by name only is found inside the session folder, and nowhere else', () => {
  const base = tmp();
  const d = path.join(base, 'work', 'proj');            // deep enough to be searchable
  fs.mkdirSync(path.join(d, 'claire', '一卡通'), { recursive: true });
  fs.mkdirSync(path.join(d, 'old'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true });
  const real = path.join(d, 'claire', '一卡通', '簡報_AWS版.pptx');
  fs.writeFileSync(real, 'new');
  fs.writeFileSync(path.join(d, 'old', '簡報_AWS版.pptx'), 'old');
  fs.utimesSync(path.join(d, 'old', '簡報_AWS版.pptx'), new Date(Date.now() - 86400000), new Date(Date.now() - 86400000));
  fs.writeFileSync(path.join(d, 'node_modules', 'x', 'hidden.js'), '');
  fs.writeFileSync(path.join(base, 'outside.txt'), '');

  const [byName, byTail, wrongTail, skipped, outside, up] = F.check(['簡報_AWS版.pptx', '一卡通/簡報_AWS版.pptx', 'nope/簡報_AWS版.pptx', 'hidden.js', 'outside.txt', '../../outside.txt'], d);
  assert.deepStrictEqual([byName.abs, byName.searched, byName.others, byName.kind], [real, true, 1, 'office']);   // two by that name: the newer one
  assert.strictEqual(byTail.abs, real);
  assert.strictEqual(byTail.others, 0);
  assert.strictEqual(wrongTail, null);
  assert.strictEqual(skipped, null);                    // dependency folders are not searched
  assert.strictEqual(outside, null);                    // not under the session folder
  assert.strictEqual(up.abs, path.join(base, 'outside.txt'));   // written explicitly: resolved directly, no search involved
  assert.strictEqual(up.searched, undefined);

  // Never from a drive root, a top-level folder, or the home folder.
  assert.strictEqual(F.searchableRoot('C:\\'), null);
  assert.strictEqual(F.searchableRoot('C:\\Users'), null);
  assert.strictEqual(F.searchableRoot(os.homedir()), null);
  assert.strictEqual(F.searchableRoot('relative\\x\\y'), null);
  assert.strictEqual(F.findByName('anything.txt', os.homedir()), null);
});

test('files.check answers per path, and officePdf caches by content identity', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', '報告.docx'), 'fake');
  fs.writeFileSync(path.join(d, 'note.md'), '# hi');
  const r = F.check(['sub/報告.docx', 'note.md:3', 'nope.txt', 'sub', path.join(d, 'note.md'), 'v1.2.3'], d);
  assert.deepStrictEqual(r.map((x) => x && [x.kind, x.name]), [['office', '報告.docx'], ['text', 'note.md'], null, ['dir', 'sub'], ['text', 'note.md'], null]);
  assert.strictEqual(r[0].canOpen, true);
  assert.strictEqual(F.realFile(path.join(d, 'sub')), null);          // a folder is not a file
  assert.strictEqual(F.realFile('note.md'), null);                    // must be absolute

  const src = path.join(d, 'sub', '報告.docx');
  const out = F.cachePathFor(src);
  try { fs.unlinkSync(out); } catch (e) {}
  let calls = 0;
  const convert = async (s, dst) => { calls++; fs.writeFileSync(dst, '%PDF-fake'); return { ok: true }; };
  const [a, b] = await Promise.all([F.officePdf(src, convert), F.officePdf(src, convert)]);   // two at once: one conversion
  assert.deepStrictEqual([a.ok, b.ok, calls], [true, true, 1]);
  assert.strictEqual((await F.officePdf(src, convert)).cached, true);
  assert.strictEqual(calls, 1);
  fs.writeFileSync(src, 'changed content');                           // edited file -> a different cache entry
  const out2 = F.cachePathFor(src);
  assert.notStrictEqual(out2, out);
  const fail = await F.officePdf(src, async () => ({ ok: false, error: 'Word said no' }));
  assert.deepStrictEqual(fail, { ok: false, error: 'Word said no' });
  assert.strictEqual(fs.existsSync(out2), false);                     // a failed conversion leaves nothing behind
  for (const p of [out, out2]) { try { fs.unlinkSync(p); } catch (e) {} }
});

test('paths an AI wrote: no network paths, and nothing that runs when opened is opened by a click', WIN_ONLY, () => {
  for (const p of ['\\\\host\\share\\a.txt', '//host/share/a.txt', '\\\\?\\UNC\\host\\share\\a.txt']) assert.strictEqual(F.resolve(p, 'C:\\work'), null, p);
  assert.strictEqual(F.resolve('C:\\work\\a.txt', ''), 'C:\\work\\a.txt');
  for (const p of ['\\\\host\\share\\a.txt', '//host/share/a.txt']) assert.strictEqual(F.realFile(p), null, p);
  assert.strictEqual(F.resolve('sub\\a.txt', 'C:\\work'), 'C:\\work\\sub\\a.txt');
  assert.deepStrictEqual(['a.docx', 'a.xlsx', 'a.pdf', 'a.png', 'a.md'].map((x) => F.canOpen(x)), [true, true, true, true, true]);
  assert.deepStrictEqual(['a.docm', 'a.xlsm', 'a.pptm', 'a.html', 'a.htm', 'a.svg', 'a.ps1', 'a.exe'].map((x) => F.canOpen(x)), [false, false, false, false, false, false, false, false]);
});

test('a network path is recognised whichever separators it is written with, and nothing else is', () => {
  const BS = String.fromCharCode(92);
  for (const p of [BS + BS + 'host' + BS + 'share' + BS + 'a.txt', '//host/share/a.txt', BS + '/host/share', '/' + BS + 'host', '  ' + BS + BS + 'host' + BS + 's', BS + BS + '?' + BS + 'UNC' + BS + 'host' + BS + 's']) {
    assert.strictEqual(F.isNetworkPath(p), true, JSON.stringify(p));
    assert.strictEqual(F.realFile(p), null); assert.strictEqual(F.resolve(p, 'C:' + BS + 'work'), null);
  }
  for (const p of ['C:' + BS + 'work' + BS + 'a.txt', 'a' + BS + BS + 'b.txt', BS + 'rooted.txt', './a.txt', '', null]) assert.strictEqual(F.isNetworkPath(p), false, JSON.stringify(p));
});
