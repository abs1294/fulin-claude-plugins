'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Past = require('../lib/past');
const K = require('../lib/keep');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-past-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const user = (text, extra) => JSON.stringify(Object.assign({ type: 'user', cwd: 'C:\\w\\proj', timestamp: '2026-11-10T03:00:00.000Z', message: { role: 'user', content: text } }, extra));
const SID = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

test('past: what you said is read from the two ends of a transcript, however long the middle is', () => {
  const d = tmp(), proj = path.join(d, 'C--w-proj');
  fs.mkdirSync(proj, { recursive: true });
  const big = path.join(proj, SID(1) + '.jsonl');
  const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } });
  fs.writeFileSync(big, [
    JSON.stringify({ type: 'summary', cwd: 'C:\\w\\proj' }),
    user('<command-name>/clear</command-name>'),                           // put there by Claude Code, not said by you
    user([{ type: 'text', text: '第一句  [Image #1]\n問延長線' }]),
    ...Array.from({ length: 300 }, () => filler),                          // 1.2 MB in the middle, never read
    user('中間說的話'),
    ...Array.from({ length: 300 }, () => filler),
    user([{ type: 'tool_result', content: 'not text' }]),
    user('最後一句', { timestamp: '2026-11-12T03:00:00.000Z' }),
    JSON.stringify({ type: 'ai-title', aiTitle: '買延長線', sessionId: SID(1) }),
    user('subagent 說的', { isSidechain: true }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(proj, SID(2) + '.jsonl'), user('只有一句 redcap') + '\n');
  fs.writeFileSync(path.join(proj, SID(3) + '.jsonl'), JSON.stringify({ type: 'summary', cwd: 'C:\\w\\proj' }) + '\n');   // nothing said: left out
  fs.writeFileSync(path.join(proj, 'agent-abc.jsonl'), user('a subagent record') + '\n');                                 // cannot be resumed: left out
  const old = path.join(proj, SID(4) + '.jsonl');
  fs.writeFileSync(old, user('兩個月前') + '\n');
  fs.utimesSync(old, new Date(Date.now() - 60 * 86400000), new Date(Date.now() - 60 * 86400000));

  assert.ok(fs.statSync(big).size > 2 * 1024 * 1024);
  assert.deepStrictEqual(Past.ends(big), { cwd: 'C:\\w\\proj', first: '第一句 問延長線', last: '最後一句', lastAt: Date.parse('2026-11-12T03:00:00.000Z') });
  assert.strictEqual(Past.lastSaid(big), '最後一句');

  const all = Past.list({ projectsDir: d });
  assert.deepStrictEqual(all.items.map((x) => [x.sessionId, x.title, x.folder, x.last]).sort(), [[SID(1), '買延長線', 'proj', '最後一句'], [SID(2), '只有一句 redcap', 'proj', '只有一句 redcap']]);
  assert.strictEqual(all.total, 3);                                         // the 60-day-old one and the subagent file are not even counted
  assert.deepStrictEqual(Past.list({ projectsDir: d, q: 'REDCAP' }).items.map((x) => x.sessionId), [SID(2)]);
  assert.deepStrictEqual(Past.list({ projectsDir: d, q: '延長線' }).items.map((x) => x.sessionId), [SID(1)]);   // title and first sentence
  assert.strictEqual(Past.list({ projectsDir: d, q: '中間說的話' }).matched, 0);                               // the middle is not searched
  assert.deepStrictEqual(Past.list({ projectsDir: d, exclude: new Set([SID(1)]) }).items.map((x) => x.sessionId), [SID(2)]);
  assert.strictEqual(Past.find(d, SID(4)).first, '兩個月前');                 // by id, whatever its age
  assert.strictEqual(Past.find(d, '..\\x'), null);
});

test('keep: a session you ended yourself is known at once, also when the board was not running', () => {
  const d = tmp(), file = path.join(d, 'keep.json');
  const A = { sessionId: SID(1), cwd: 'C:\\w\\x', title: 'A', pid: 1 }, B = { sessionId: SID(2), cwd: 'C:\\w\\b', title: 'B', pid: 2 }, C = { sessionId: SID(3), cwd: 'C:\\w\\a', title: 'C', pid: 3 };
  const k = new K.Keeper(file);
  k.observe([A, B], 99000);
  k.observe([A, B, C], 100000);                                             // C is the one seen open last in its folder
  k.setCommand(A.sessionId, 'claude --a'); k.setCommand(C.sessionId, 'claude --c'); k.setCommand(B.sessionId, 'claude --c');
  // The board stops. Then A is exited by hand, B is killed with the machine ("other"), C's note is from before it was last seen.
  const ended = new Map([[A.sessionId, { reason: 'prompt_input_exit', at: 200000 }], [B.sessionId, { reason: 'other', at: 200000 }], [C.sessionId, { reason: 'logout', at: 100000 - 3600000 }]]);
  const next = new K.Keeper(file);
  next.observe([], 300000, ended);
  assert.deepStrictEqual(next.restorable().map((x) => x.title).sort(), ['B', 'C']);
  assert.deepStrictEqual(next.recentlyClosed().map((x) => [x.title, x.closedAt]), [['A', 200000]]);
  // A note about a session that is open is not acted on.
  const live = new K.Keeper(path.join(d, 'k2.json'));
  live.observe([A], 100000, new Map([[A.sessionId, { reason: 'prompt_input_exit', at: 100000 }]]));
  assert.strictEqual(live.isKept(A.sessionId), true);
  // Ended from the board.
  live.markClosed(A.sessionId, 150000);
  assert.strictEqual(live.isKept(A.sessionId), false);
  live.markClosed(B.sessionId, 160000, { cwd: B.cwd, title: 'B' });         // ended before the board had noted it down
  assert.deepStrictEqual(live.recentlyClosed().map((x) => x.title), ['B']);   // A is not listed until the board sees it gone
  // The command for a conversation with none on record.
  assert.strictEqual(next.defaultCommand('C:\\w\\a'), 'claude --c');       // the one last used in that folder
  assert.strictEqual(next.defaultCommand('C:\\elsewhere'), 'claude --c');   // most used overall
  assert.strictEqual(new K.Keeper(path.join(d, 'empty.json')).defaultCommand('C:\\x'), 'claude');
});

test('usage-scan: a second scan reads only what was added, and gives what a full scan gives', () => {
  const home = tmp();
  const proj = path.join(home, '.claude', 'projects', 'C--w-proj');
  fs.mkdirSync(proj, { recursive: true });
  const at = (d, h) => new Date(2026, 10, d, h || 12).toISOString();
  const turn = (id, ts, sid) => JSON.stringify({ type: 'assistant', sessionId: sid || 'S1', cwd: 'C:\\w\\proj', timestamp: ts, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 10 } } });
  const f1 = path.join(proj, 'S1.jsonl'), f2 = path.join(proj, 'S2.jsonl');
  fs.writeFileSync(f1, turn('m1', at(1)) + '\n' + turn('m2', at(2)));           // the last line has no line break yet
  fs.writeFileSync(f2, turn('m9', at(3), 'S2') + '\n');
  const run = (cache) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'usage-scan.js'), '2026-11'],
    { env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home, SESSION_BOARD_SCAN_CACHE: cache }), encoding: 'utf8' }));
  const core = (j) => JSON.stringify([j.total, j.days, j.sessions, j.records, j.duplicates]);

  const a = run('1');
  assert.deepStrictEqual([a.cached, a.reused, a.records, a.total.tok], [true, 0, 3, 330]);
  const b = run('1');
  assert.deepStrictEqual([b.reused, b.readBytes, b.records], [2, 0, 3]);        // nothing changed: no file opened
  assert.strictEqual(core(b), core(a));
  // The unfinished line is completed, the same message is written once more, and a new one follows.
  fs.appendFileSync(f1, '\n' + turn('m2', at(2)) + '\n' + turn('m3', at(4)) + '\n');
  const c = run('1');
  assert.deepStrictEqual([c.reused, c.records, c.total.tok], [1, 4, 440]);
  assert.ok(c.readBytes < fs.statSync(f1).size, 'only the added part of the file was read');
  assert.strictEqual(core(c), core(run('0')));                                  // same as reading everything
  fs.unlinkSync(f2);                                                            // a transcript is cleaned up
  assert.strictEqual(core(run('1')), core(run('0')));
  require('../lib/db').close(path.join(home, '.claude', 'session-board', 'board.db'));
});

test('interrupted: a transcript that stops in the middle of a turn, and one that does not', () => {
  const d = tmp();
  const write = (name, lines) => { const f = path.join(d, name); fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return f; };
  const you = (text, extra) => Object.assign({ type: 'user', message: { role: 'user', content: text } }, extra);
  const claude = (content, stop) => ({ type: 'assistant', message: { role: 'assistant', content, stop_reason: stop === undefined ? 'end_turn' : stop } });
  const say = [{ type: 'text', text: '做完了' }], call = [{ type: 'text', text: '我來跑測試' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }];
  const result = you([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
  assert.strictEqual(Past.interrupted(write('done.jsonl', [you('幫我改'), claude(say)])), false);                       // Claude had the last word
  assert.strictEqual(Past.interrupted(write('asked.jsonl', [you('幫我改'), claude(say), you('再改一下')])), true);       // you asked, no answer yet
  assert.strictEqual(Past.interrupted(write('tool.jsonl', [you('跑測試'), claude(call, 'tool_use')])), true);           // a tool was called and never came back
  assert.strictEqual(Past.interrupted(write('result.jsonl', [you('跑測試'), claude(call, 'tool_use'), result])), true); // the tool came back, Claude had not gone on
  assert.strictEqual(Past.interrupted(write('partial.jsonl', [you('寫報告'), claude([{ type: 'text', text: '第一段' }], null)])), true);   // cut off while writing
  assert.strictEqual(Past.interrupted(write('stopped.jsonl', [you('跑很久'), claude(call, 'tool_use'), you([{ type: 'text', text: '[Request interrupted by user for tool use]' }])])), false);   // you stopped it yourself
  // What a subagent or Claude Code itself wrote after the end does not change the answer.
  assert.strictEqual(Past.interrupted(write('side.jsonl', [you('幫我改'), claude(say), you('子代理的提示', { isSidechain: true }), you('<meta>', { isMeta: true }), { type: 'system', subtype: 'x' }])), false);
  assert.strictEqual(Past.interrupted(path.join(d, 'missing.jsonl')), false);
  assert.strictEqual(Past.interrupted(write('empty.jsonl', [{ type: 'summary' }])), false);
});

test('the launcher can open a conversation with something to say, as one quoted argument', () => {
  const sid = '11111111-2222-3333-4444-555555555555';
  assert.match(K.launcherText('claude --x "a b"', sid, true, '請接著把"被中斷"的工作\n做完 100%'), /\r\nclaude --x "a b" --resume 11111111-2222-3333-4444-555555555555 "請接著把 被中斷 的工作 做完 100%%"\r\n$/);
  assert.match(K.launcherText('claude', sid, true), /\r\nclaude --resume 11111111-2222-3333-4444-555555555555\r\n$/);   // nothing to say: as before
});
