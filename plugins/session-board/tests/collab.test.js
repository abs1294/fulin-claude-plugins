'use strict';
// lib/collab.js: the ledger (written from the templates, read back), names, the messages between members; and the
// switch of a board conversation to bypass (lib/chat.js setBypass) that collaborations rely on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('../lib/collab');
const { Channels } = require('../lib/chat');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-collab-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const NO_USER = { userDir: path.join(os.tmpdir(), 'sb-collab-no-user-dir') };
const collab = () => ({ id: 3, goal: '對齊規格', createdAt: Date.UTC(2026, 10, 18, 2, 0), ledger: 'C:\\w\\.claude\\collab\\3.md', members: [
  { sessionId: '00000000-0000-4000-8000-000000000001', cwd: 'C:\\w\\ALPHA', owner: 'board', role: 'ALPHA', does: '推送端', name: '合作3-ALPHA' },
  { sessionId: '00000000-0000-4000-8000-000000000002', cwd: 'C:\\w\\BETA', owner: 'terminal', role: 'BETA', does: '接收端', name: '合作3-BETA', seenName: 'project-b-c2' },
] });

test('names: the pattern filled, one line, kept short', () => {
  assert.strictEqual(C.fixedName('合作{id}-{short}', 3, 'ALPHA'), '合作3-ALPHA');
  assert.strictEqual(C.fixedName('S{id}-{short}', 3, 'a\n b;"c" $d'), 'S3-a-b-c-d', 'it goes on command lines');
  assert.strictEqual(C.fixedName('', 3, 'A'), 'S3-A');
  assert.strictEqual(C.fixedName('', 3, 'cafe\u0301\u200b\u0000😀x'), 'S3-café' + 'x', 'one form of each letter; nothing invisible');
  assert.ok(!C.fixedName('--x{id}', 3, '').startsWith('-'), 'never read as an option');
  assert.strictEqual(C.fixedName('合作{id}-{short}', 3, 'x'.repeat(100)).length, 60);
});

test('fixed names: given once, unique whatever the pattern, those of before 0.22.0 taken from the collaborations', () => {
  const Codes = require('../lib/codes');
  const kv = {}; const value = (k, d) => (k in kv ? kv[k] : d), put = (k, v) => { kv[k] = JSON.parse(JSON.stringify(v)); };
  const id = (n) => '00000000-0000-4000-8000-00000000000' + n;
  assert.strictEqual(Codes.give(value, put, id(1), 'A', 'S{id}-{short}'), 'S1-A');
  assert.strictEqual(Codes.give(value, put, id(1), 'B', 'X{id}'), 'S1-A', 'the same from then on');
  const odd = [id(2), id(3), id(4), id(5)].map((s, i) => Codes.give(value, put, s, 'x'.repeat(i < 2 ? 70 : 2), ['{short}-{id}', '{short}-{id}', '同名', '***'][i]));
  assert.ok(odd.every(Boolean) && new Set(odd).size === 4, 'none empty, none twice: ' + odd.join(' '));
  assert.strictEqual(Codes.give(value, put, id(6), 'z', '同名'), 'S6-z', 'taken already: the number first');
  const m = (s, name) => ({ sessionId: s, name });
  const old = { collabs: [{ id: 3, state: 'ended', members: [m(id(1), '合作3-A')] }, { id: 2, state: 'active', members: [m(id(1), '合作2-A'), m(id(2), '合作2 ; B')] }, { id: 1, state: 'ended', members: [m(id(1), '合作1-A'), m(id(3), '合作1-C')] }] };
  const ov = (k, d) => (k in old ? old[k] : d);
  assert.deepStrictEqual(Codes.book(ov).codes, { [id(1)]: '合作2-A', [id(3)]: '合作1-C', [id(2)]: '合作2-B' }, 'the one under way first; made safe');
  assert.ok(['合作3-A', '合作1-A', '合作2 ; B', '合作2-B'].every((x) => Codes.known(ov).has(x)), 'every name ever given is known as one');
  const oput = (k, v) => { old[k] = JSON.parse(JSON.stringify(v)); };
  assert.strictEqual(Codes.freeze(ov, oput), true);
  old.collabs[1].state = 'ended'; old.collabs[1].members.forEach((x) => { x.name = 'renamed'; });
  assert.strictEqual(Codes.book(ov).codes[id(1)], '合作2-A', 'the collaboration it came from ends: the same name');
  assert.ok(Codes.known(ov).has('合作2 ; B'), 'the old ones are still no titles');
  assert.strictEqual(Codes.freeze(ov, oput), false, 'once');
  assert.strictEqual(Codes.move(ov, oput, id(2), id(8)), '合作2-B');
  assert.deepStrictEqual([Codes.book(ov).codes[id(8)], Codes.book(ov).codes[id(2)], Codes.move(ov, oput, id(2), id(9))], ['合作2-B', undefined, ''], 'moved along, not left behind');
  Codes.give(ov, oput, id(7), 'N', 'S{id}-{short}'); assert.ok(Codes.known(ov).has('合作3-A') && Codes.book(ov).codes[id(7)] === 'S1-N');
  assert.deepStrictEqual(Codes.book((k, d) => d), { n: 0, codes: {}, old: [] });
});

test('the ledger: every section from the template, members with the name they have now, one column per member', () => {
  const t = C.ledgerText(collab(), NO_USER);
  for (const s of ['## 目標', '## 成員與分工', '## 介面清單', '## 承諾清單', '## 待你裁定', '## 使用者裁定', '## 驗證紀錄', '## 合作規則']) assert.ok(t.includes(s), s);
  assert.ok(t.includes('| 介面 | 提供方 | 版本／最後改動 | ALPHA | BETA |'));
  assert.ok(t.includes('代號 `合作3-BETA`（現在登記的名字是 `project-b-c2`'), 'the fixed name, and the one it is registered under while that is another');
  assert.ok(/代號 `合作3-ALPHA`；資料夾/.test(t), 'only the fixed one when it is registered under it: ' + C.section(t, '成員與分工'));
  assert.ok(t.includes('每個介面'), 'the rules');
  assert.ok(!/\{\{/.test(t), 'nothing left unfilled');
  const b = C.briefText(collab(), collab().members[0], NO_USER);
  assert.ok(b.startsWith('（看板自動送出）【合作 #3】') && b.includes('合作3-ALPHA') && b.includes('合作3-BETA') && b.includes('project-b-c2') && b.includes('C:\\w\\.claude\\collab\\3.md'));
});

test('the ledger read back: promises not ticked, questions not decided, interfaces a member has not caught up with', () => {
  let t = C.ledgerText(collab(), NO_USER);
  t = C.replaceSection(t, '介面清單', '| 介面 | 提供方 | 版本／最後改動 | ALPHA | BETA |\n| --- | --- | --- | --- | --- |\n| POST /sync | ALPHA | v2 11-18 | ✓ | |\n| 欄位 doc_no | BETA | v1 | ✓ | ✓ 已跟上 |');
  t = C.replaceSection(t, '承諾清單', '- [ ] [ALPHA] 給 BETA 各環境的 host\n- [x] [BETA] 開服務讓 ALPHA 打\n- [ ] 沒寫誰的一件');
  t = C.replaceSection(t, '待你裁定', '- [ ] 髒資料誰處理？\n- [x] 已決定的');
  const o = C.readLedger(t, collab(), NO_USER);
  assert.deepStrictEqual(o.promises.filter((p) => !p.done).map((p) => [p.who, p.text]), [['ALPHA', '給 BETA 各環境的 host'], ['', '沒寫誰的一件']]);
  assert.deepStrictEqual(o.pending, [{ done: false, question: '髒資料誰處理？' }, { done: true, question: '已決定的' }]);
  assert.deepStrictEqual(o.interfaces.map((i) => [i.name, i.behind]), [['POST /sync', ['BETA']], ['欄位 doc_no', []]]);
  // a decision: ticked, and the answer word for word
  const t2 = C.answerDecision(t, '髒資料誰處理？', '視為業務端的髒資料，\n人工處理', Date.UTC(2026, 10, 18, 3, 0), NO_USER);
  assert.ok(t2.includes('- [x] 髒資料誰處理？'));
  assert.ok(t2.includes('使用者原話：視為業務端的髒資料，\n  人工處理'));
  assert.strictEqual(C.readLedger(t2, collab(), NO_USER).pending.filter((p) => !p.done).length, 0);
  assert.ok(C.section(t2, '驗證紀錄') !== undefined && t2.indexOf('## 驗證紀錄') > t2.indexOf('使用者原話'), 'the sections stay in order');
  // the same ledger with Windows line ends (templates checked out with CRLF, or saved by a Windows editor): read the same
  const crlf = t.replace(/\r?\n/g, '\r\n');
  const o2 = C.readLedger(crlf, collab(), NO_USER);
  assert.deepStrictEqual([o2.promises.length, o2.pending.length, o2.interfaces.map((i) => i.behind)], [3, 2, [['BETA'], []]]);
  assert.ok(C.answerDecision(crlf, '髒資料誰處理？', '人工', 0, NO_USER).includes('[x] 髒資料誰處理？'));
});

test('one section of a ledger rewritten from what is on disk now; one-line text keeps the ledger in shape', () => {
  const d = tmp(), f = path.join(d, 'l.md');
  fs.writeFileSync(f, '# x\n\n## 成員與分工\n\n- 舊的\n\n## 承諾清單\n\n- [ ] [A] 一件\n');
  // a member adds a promise between the board reading and writing: it stays
  fs.appendFileSync(f, '- [ ] [B] 另一件\n');
  C.writeSection(f, '成員與分工', '- 新的');
  const t = fs.readFileSync(f, 'utf8');
  assert.ok(t.includes('- 新的') && !t.includes('- 舊的') && t.includes('[B] 另一件') && t.includes('[A] 一件'));
  assert.strictEqual(C.oneLine('A\n## 偷開一節 | 欄', 40), 'A ## 偷開一節 欄', 'no line breaks or table bars');
  assert.strictEqual(C.oneLine('x'.repeat(50), 40).length, 40);
});

test('your own templates and wording win over the plugin\'s', () => {
  const u = tmp();
  fs.writeFileSync(path.join(u, 'rules.md'), '只有一條：先問。');
  fs.writeFileSync(path.join(u, 'config.json'), JSON.stringify({ sections: { promises: '答應的事' }, doneMarks: ['done'] }));
  const t = C.ledgerText(collab(), { userDir: u });
  assert.ok(t.includes('只有一條：先問。') && t.includes('## 答應的事') && !t.includes('## 承諾清單'));
  const t2 = C.replaceSection(t, '答應的事', '- [ ] [ALPHA] x');
  assert.strictEqual(C.readLedger(t2, collab(), { userDir: u }).promises.length, 1);
  assert.strictEqual(C.settings({ userDir: u }).sections.members, '成員與分工', 'what you did not change stays');
});

test('the messages between members, from their transcripts; a sent one marked when the other has it', () => {
  const d = tmp(), a = path.join(d, 'a.jsonl'), b = path.join(d, 'b.jsonl');
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(a, [
    L({ type: 'assistant', timestamp: '2026-11-18T03:00:00Z', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: '合作3-BETA', message: '請開服務，我要實際打過去' } }] } }),
    L({ type: 'assistant', timestamp: '2026-11-18T03:05:00Z', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: '合作3-BETA', message: '這則沒送到' } }] } }),
    L({ type: 'user', timestamp: '2026-11-18T03:02:00Z', message: { content: 'Another Claude session sent a message: <cross-session-message from="uds:x" from-name="合作3-BETA" from-mode="bypass">開好了，8098</cross-session-message>' } }),
  ].join('\n'));
  fs.writeFileSync(b, [
    // the brief only mentions the tag: not a message
    L({ type: 'user', timestamp: '2026-11-18T02:59:00Z', message: { content: '（看板自動送出）【合作 #3】…對方的訊息會以 <cross-session-message from-name="…"> 送進來…' } }),
    // came in while it was working: written only as a queued item; then the same shown again - listed once
    L({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-18T03:00:01Z', content: '<cross-session-message from="uds:y" from-name="合作3-ALPHA" from-mode="bypass">\n請開服務，我要實際打過去\n</cross-session-message>' }),
    L({ type: 'user', timestamp: '2026-11-18T03:00:05Z', message: { content: [{ type: 'text', text: '<cross-session-message from="uds:y" from-name="合作3-ALPHA">請開服務，我要實際打過去</cross-session-message>' }] } }),
    L({ type: 'assistant', timestamp: '2026-11-18T03:01:59Z', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: '合作3-ALPHA', message: '開好了，8098' } }] } }),
  ].join('\n'));
  const tl = C.timeline([{ role: 'ALPHA', file: a, name: '合作3-ALPHA' }, { role: 'BETA', file: b, name: '合作3-BETA' }, { role: 'X', file: null, name: '合作3-X' }], NO_USER);
  assert.deepStrictEqual(tl.map((x) => [x.member, x.dir, x.peer, x.text, x.delivered]), [
    ['ALPHA', 'out', '合作3-BETA', '請開服務，我要實際打過去', true],
    ['BETA', 'in', '合作3-ALPHA', '請開服務，我要實際打過去', undefined],
    ['BETA', 'out', '合作3-ALPHA', '開好了，8098', true],
    ['ALPHA', 'in', '合作3-BETA', '開好了，8098', undefined],
    ['ALPHA', 'out', '合作3-BETA', '這則沒送到', false],
  ]);
});

test('delivered means the one it was sent to got it from the one who sent it - not just the same words somewhere', () => {
  const d = tmp(), a = path.join(d, 'a.jsonl'), b = path.join(d, 'b.jsonl'), c = path.join(d, 'c.jsonl');
  const L = (o) => JSON.stringify(o);
  const out = (t, to, msg) => L({ type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to, message: msg } }] } });
  const got = (t, from, msg) => L({ type: 'user', timestamp: t, message: { content: '<cross-session-message from="uds:z" from-name="' + from + '">' + msg + '</cross-session-message>' } });
  // A and C both send 「好」 to B; B was given only C's. A also sends 「好」 to C, who never got it.
  fs.writeFileSync(a, [out('2026-11-18T04:00:00Z', '合作4-B', '好'), out('2026-11-18T04:00:02Z', '合作4-C', '好')].join('\n'));
  fs.writeFileSync(b, got('2026-11-18T04:00:05Z', '合作4-C', '好'));
  fs.writeFileSync(c, out('2026-11-18T04:00:01Z', '合作4-B', '好'));
  const tl = C.timeline([{ role: 'A', file: a, name: '合作4-A' }, { role: 'B', file: b, name: '合作4-B' }, { role: 'C', file: c, name: '合作4-C', seenName: 'proj-c-12' }], NO_USER);
  const sent = tl.filter((x) => x.dir === 'out').map((x) => [x.member, x.peer, x.delivered]);
  assert.deepStrictEqual(sent, [['A', '合作4-B', false], ['C', '合作4-B', true], ['A', '合作4-C', false]], 'only C to B arrived');
  // a sender known by the name Claude Code gives it now is still the same sender
  fs.writeFileSync(b, got('2026-11-18T04:00:05Z', 'proj-c-12', '好'));
  const tl2 = C.timeline([{ role: 'A', file: a, name: '合作4-A' }, { role: 'B', file: b, name: '合作4-B' }, { role: 'C', file: c, name: '合作4-C', seenName: 'proj-c-12' }], NO_USER);
  assert.deepStrictEqual(tl2.filter((x) => x.dir === 'out' && x.member === 'C').map((x) => x.delivered), [true]);
  // sent outside the collaboration: not marked, even though a member was given the same words from that sender
  fs.writeFileSync(a, out('2026-11-18T04:00:00Z', 'someone-else', '好'));
  fs.writeFileSync(b, got('2026-11-18T04:00:05Z', '合作4-A', '好'));
  const tl3 = C.timeline([{ role: 'A', file: a, name: '合作4-A' }, { role: 'B', file: b, name: '合作4-B' }], NO_USER);
  assert.deepStrictEqual(tl3.filter((x) => x.dir === 'out').map((x) => x.delivered), [null], 'cannot be seen: left unmarked');
});

function fakeSpawn(log) {
  return (bin, args) => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.stdin = Object.assign(new EventEmitter(), { written: [], write(s) { this.written.push(JSON.parse(s)); return true; }, end() { p.emit('exit', 0); } });
    p.kill = () => { p.killed = true; p.emit('exit', null); };
    p.out = (o) => p.stdout.emit('data', JSON.stringify(o) + '\n');
    log.push({ args, p }); return p;
  };
}
test('setBypass: an idle conversation\'s next process runs in bypass; a busy one changes once its turn is over', () => {
  const log = []; const ch = new Channels(path.join(tmp(), 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const c = ch.create(tmp());
  ch.send(c.sessionId, '一');
  assert.ok(!log[0].args.includes('--dangerously-skip-permissions'));
  log[0].p.out({ type: 'result', is_error: false });   // idle
  assert.deepStrictEqual(ch.setBypass(c.sessionId, true), { ok: true, now: true });
  assert.ok(log[0].p.killed, 'the idle process ended');
  ch.send(c.sessionId, '二');
  assert.ok(log[1].args.includes('--dangerously-skip-permissions'), 'the next one runs in bypass');
  // busy: kept until the turn is over
  assert.deepStrictEqual(ch.setBypass(c.sessionId, false), { ok: true, now: false });
  assert.ok(!log[1].p.killed, 'not cut off mid-turn');
  log[1].p.out({ type: 'result', is_error: false });
  assert.ok(log[1].p.killed, 'ended when the turn was over');
  ch.send(c.sessionId, '三');
  assert.ok(!log[2].args.includes('--dangerously-skip-permissions'));
  assert.strictEqual(ch.setBypass('nope', true).ok, false);
});
