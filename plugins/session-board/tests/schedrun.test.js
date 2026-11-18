'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Schedules, clean, lastDue } = require('../lib/schedule');
const { Runner, LATE_MS, unattended } = require('../lib/schedrun');

test('a schedule that hands work to goal2 marks it unattended: nobody is there to answer its questions', () => {
  assert.strictEqual(unattended('/goal2:goal 修好第 9、10 封'), '/goal2:goal --unattended 修好第 9、10 封');
  assert.strictEqual(unattended('/goal2:goal'), '/goal2:goal --unattended', 'bare: goal2 takes the goal from the conversation');
  assert.strictEqual(unattended('  /goal2:goal\n修好'), '  /goal2:goal --unattended\n修好');
  assert.strictEqual(unattended('/goal2:goal --unattended 修好'), '/goal2:goal --unattended 修好', 'not marked twice');
  for (const t of ['/goal2:goals x', '每天整理日報', '請跑 /goal2:goal x']) assert.strictEqual(unattended(t), t, 'anything else is sent as it is');
});

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-run-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const at = (y, m, d, h, n) => new Date(y, m - 1, d, h, n, 0, 0).getTime();

test('the latest time a schedule was due', () => {
  const now = at(2026, 11, 15, 12, 0);                                    // a Sunday, noon
  assert.strictEqual(lastDue({ kind: 'daily', at: '09:00' }, now), at(2026, 11, 15, 9, 0));
  assert.strictEqual(lastDue({ kind: 'daily', at: '13:00' }, now), at(2026, 11, 14, 13, 0));        // not yet today: yesterday's
  assert.strictEqual(lastDue({ kind: 'daily', at: '12:00' }, now), now);                             // due this very minute
  assert.strictEqual(lastDue({ kind: 'weekly', at: '09:00', days: '5' }, now), at(2026, 11, 13, 9, 0));   // last Friday
  assert.strictEqual(lastDue({ kind: 'once', at: '08:00', date: '2026-11-20' }, now), 0);            // still ahead
  assert.strictEqual(lastDue({ kind: 'once', at: '08:00', date: '2026-11-10' }, now), at(2026, 11, 10, 8, 0));
  assert.strictEqual(lastDue({ kind: 'every', everyHours: 4, updatedAt: at(2026, 11, 15, 7, 0) }, now), at(2026, 11, 15, 11, 0));
  assert.strictEqual(lastDue({ kind: 'every', everyHours: 4, updatedAt: at(2026, 11, 15, 9, 0) }, now), 0);   // not four hours yet
});

// A board made of nothing: conversations are objects, "sending" is remembered.
function fakeBoard(d) {
  const convs = new Map(), sent = [], told = [];
  const channels = {
    create(cwd, sid) { const c = { sessionId: sid || 'new-' + (convs.size + 1), cwd, title: '', queue: [], state: 'busy' }; convs.set(c.sessionId, c); return c; },
    get(sid) { return convs.get(sid) || null; },
    send(sid, text) { sent.push([sid, text]); return { ok: true }; },
    status(c) { return c.state; },
  };
  const open = [];
  const ops = { sessions: () => open, channels, isDir: (p) => p === d, newId: () => 'copy-1', tell: (t, x) => told.push(x),
    peer: async (s, text, mark) => { ops.peerCalls.push([s.sessionId, text, mark]); return ops.peerAnswer; }, takeOver: async (s) => { ops.took.push(s.sessionId); return ops.takeAnswer; },
    peerCheck: () => ops.seen, seen: 'delivered',
    peerCalls: [], took: [], peerAnswer: { state: 'sent' }, takeAnswer: { ok: true } };
  return { ops, convs, sent, told, open };
}
const SID = 'fcddb7be-012a-460b-bb6e-4ca9c9f93b75';

test('a schedule fires when due, once; one that came due while the board was down is noted and asked about, not run', async () => {
  const d = tmp(); const S = new Schedules(path.join(d, 'b.db')); const b = fakeBoard(d); const R = new Runner(S, b.ops);
  const saved = at(2026, 11, 14, 8, 0);
  const id = S.save(clean({ kind: 'daily', at: '09:00', name: '晨報', target: 'folder', cwd: d, prompt: '整理昨天', skipPermissions: true }, () => true).value, null, saved);
  await R.tick(at(2026, 11, 14, 8, 59));
  assert.strictEqual(b.sent.length, 0);                                                       // not yet
  await R.tick(at(2026, 11, 14, 9, 0) + 20000);
  assert.deepStrictEqual([b.sent.length, b.sent[0][1], [...b.convs.values()][0].skipPermissions, [...b.convs.values()][0].title], [1, '整理昨天', true, '⏰ 晨報']);
  await R.tick(at(2026, 11, 14, 9, 1)); await R.tick(at(2026, 11, 14, 9, 2));
  assert.strictEqual(b.sent.length, 1);                                                       // the same due time is not run twice
  const again = new Runner(new Schedules(path.join(d, 'b.db')), b.ops);                       // nor by a board that restarts in that minute
  await again.tick(at(2026, 11, 14, 9, 2));
  assert.strictEqual(b.sent.length, 1);
  // The board is down over the next morning and comes back at noon.
  await R.tick(at(2026, 11, 15, 12, 0));
  assert.strictEqual(b.sent.length, 1);                                                       // not run behind your back
  const n = S.notices();
  assert.deepStrictEqual([n.length, n[0].kind, /錯過了：原定 11\/15 09:00/.test(n[0].text), b.told.length], [1, 'missed', true, 1], n[0] && n[0].text);
  assert.deepStrictEqual(S.runs().map((r) => r.status), ['missed', 'running']);
  await R.tick(at(2026, 11, 15, 12, 1));
  assert.strictEqual(S.notices().length, 1);                                                  // and noted once
  // "Run it" on the notice runs it now and closes the notice; a closed notice does nothing more.
  const r = await R.act(n[0].id, 'run', at(2026, 11, 15, 12, 5));
  assert.deepStrictEqual([r.ok, b.sent.length, S.notices().length], [true, 2, 0]);
  assert.strictEqual((await R.act(n[0].id, 'run')).ok, false);
  // Switched off, or switched on again later, is not "missed": the clock starts again from the change.
  S.setEnabled(id, false, at(2026, 11, 16, 8, 0)); await R.tick(at(2026, 11, 16, 9, 0)); assert.strictEqual(b.sent.length, 2);
  S.setEnabled(id, true, at(2026, 11, 17, 10, 0)); await R.tick(at(2026, 11, 17, 10, 1));
  assert.deepStrictEqual([b.sent.length, S.notices().length], [2, 0]);                        // 09:00 was before it was switched on again
});

test('where a run goes depends on what the session is doing', async () => {
  const d = tmp(); const S = new Schedules(path.join(d, 'b.db')); const b = fakeBoard(d); const R = new Runner(S, b.ops);
  const mk = (extra) => S.get(S.save(clean(Object.assign({ kind: 'daily', at: '09:00', name: '跟進', target: 'session', sessionId: SID, sessionTitle: '碳排', cwd: d, prompt: '接著做' }, extra), () => true).value, null, 1));
  const now = at(2026, 11, 15, 9, 0); let k = 0; const fire = (s, force) => R.fire(s, now + (++k), now, force);
  // not open anywhere: the board carries it on
  let r = await fire(mk({}));
  assert.deepStrictEqual([r.status, S.runs(1)[0].how, b.sent.pop()], ['running', 'resume', [SID, '接著做']]);
  // open on the board: sent to it
  b.open.push({ sessionId: SID, owner: 'board', cwd: d });
  r = await fire(mk({})); assert.deepStrictEqual([S.runs(1)[0].how, b.sent.pop()[0]], ['board', SID]);
  // open in a terminal: handed over session to session, with a mark the receiver's transcript can be searched for
  b.open[0] = { sessionId: SID, owner: 'terminal', cwd: d, name: 'project-b-8c', pid: 1 };
  r = await fire(mk({}));
  assert.deepStrictEqual([r.status, S.runs(1)[0].how, b.sent.length, b.ops.peerCalls.length], ['sent', 'peer', 0, 1]);    // handed over; not yet known to be taken
  assert.ok(b.ops.peerCalls[0][1].startsWith('【看板排程「跟進」' + b.ops.peerCalls[0][2] + '】\n接著做') && b.ops.peerCalls[0][2] === '#' + S.runs(1)[0].id);
  b.ops.seen = ''; await R.settle(now + 30000); assert.strictEqual(S.runs(1)[0].status, 'sent');                           // a session can take half a minute to pick it up
  b.ops.seen = 'delivered'; await R.settle(now + 40000); assert.deepStrictEqual([S.runs(1)[0].status, S.notices().length], ['delivered', 0]);
  // never seen to be taken: after three minutes it is called undelivered, and you are told
  r = await fire(mk({})); b.ops.seen = ''; await R.settle(now + 60000); assert.strictEqual(S.notices().length, 0);
  await R.settle(now + 4 * 60000); assert.deepStrictEqual([S.runs(1)[0].status, S.notices()[0].kind], ['unconfirmed', 'undelivered']);
  await R.act(S.notices()[0].id, 'skip');
  // held by the receiver, fallback "only tell me": nothing runs, a notice says why
  r = await fire(mk({})); b.ops.seen = 'held'; await R.settle(now + 20000);
  assert.deepStrictEqual([S.runs(1)[0].status, b.sent.length, S.notices()[0].kind, /扣住/.test(S.notices()[0].text)], ['held', 0, 'undelivered', true]);
  // … and its button "run a copy" starts a copy of the session on the board, the original untouched
  const act = await R.act(S.notices()[0].id, 'fork', now + 500);
  const copy = b.convs.get('copy-1');
  assert.deepStrictEqual([act.ok, copy.forkOf, b.sent.pop()[0], b.ops.took.length, S.notices().length], [true, SID, 'copy-1', 0, 0]);
  // fallback "copy" does that by itself; fallback "move it here" ends the terminal one first, and says so when it cannot
  b.ops.peerAnswer = { state: 'failed', note: '同名' };
  r = await fire(mk({ fallback: 'fork' })); assert.deepStrictEqual([r.ok, S.runs(2).map((x) => x.how + ':' + x.status), /改用分身/.test(S.runs(2)[1].note)], [true, ['fork:running', 'peer:failed'], true]); b.sent.pop();
  r = await fire(mk({ fallback: 'takeover' })); assert.deepStrictEqual([S.runs(1)[0].how, b.ops.took, b.sent.pop()[0]], ['takeover', [SID], SID]);
  b.ops.takeAnswer = { ok: false, error: '它正在執行' };
  const before = S.notices().length;
  r = await fire(mk({ fallback: 'takeover' })); assert.deepStrictEqual([r.ok, b.sent.length, S.notices().length > before], [false, 0, true]);   // could not move it: told, nothing run
  // a folder that is gone: failed, with a notice
  r = await R.fire(Object.assign(mk({}), { cwd: path.join(d, 'gone') }), now + 99, now);
  assert.deepStrictEqual([r.ok, /資料夾已經不存在/.test(r.error)], [false, true]);
});

test('a run on the board is followed until it finishes, and a stop for approval is told once', async () => {
  const d = tmp(); const S = new Schedules(path.join(d, 'b.db')); const b = fakeBoard(d); const R = new Runner(S, b.ops);
  const s = S.get(S.save(clean({ kind: 'daily', at: '09:00', name: '晨報', target: 'folder', cwd: d, prompt: 'x' }, () => true).value, null, 1));
  const t0 = at(2026, 11, 15, 9, 0);
  await R.fire(s, t0, t0);
  const c = [...b.convs.values()][0];
  c.state = 'idle'; await R.settle(t0 + 2000); assert.strictEqual(S.runs(1)[0].status, 'running');  // too early to call it finished
  c.state = 'waiting'; await R.settle(t0 + 20000); await R.settle(t0 + 40000);
  assert.deepStrictEqual([S.runs(1)[0].status, S.notices().filter((n) => n.kind === 'approval').length], ['waiting', 1]);
  c.state = 'busy'; await R.settle(t0 + 60000); assert.strictEqual(S.runs(1)[0].status, 'running');
  c.state = 'idle'; await R.settle(t0 + 80000);
  assert.deepStrictEqual([S.runs(1)[0].status, S.runs(1)[0].endedAt], ['done', t0 + 80000]);
  assert.ok(LATE_MS >= 60000);
});

test('a schedule that names a role starts its conversation as that role; one that carries a session on does not', async () => {
  const d = tmp(); const S = new Schedules(path.join(d, 'b.db')); const b = fakeBoard(d); const R = new Runner(S, b.ops);
  const v = clean({ kind: 'daily', at: '09:00', name: '每日驗收', target: 'folder', cwd: d, prompt: '跑一輪', agent: 'qa-engineer' }, () => true).value;
  assert.strictEqual(v.agent, 'qa-engineer');
  const s = S.get(S.save(v, null, 1));
  assert.strictEqual(s.agent, 'qa-engineer');
  await R.fire(s, at(2026, 11, 15, 9, 0), at(2026, 11, 15, 9, 0));
  assert.strictEqual([...b.convs.values()][0].agent, 'qa-engineer');
  assert.strictEqual(S.get(S.save(Object.assign({}, v, { agent: '' }), s.id, 2)).agent, '');   // taken off again
  assert.strictEqual(clean({ kind: 'daily', at: '09:00', target: 'session', sessionId: SID, cwd: d, prompt: 'x', agent: 'qa-engineer' }, () => true).value.agent, '');
  assert.strictEqual(clean({ kind: 'daily', at: '09:00', target: 'folder', cwd: d, prompt: 'x', agent: '--resume' }, () => true).value.agent, '');
});

test('a schedule that hands a goal to goal2: started through goal2, followed until goal2 says how it ended', async () => {
  const d = tmp(); const S = new Schedules(path.join(d, 'b.db')); const b = fakeBoard(d);
  const started = [], states = new Map();
  b.ops.goal = {
    start: async (task, cond, cwd) => { started.push([task, cond, cwd]); return cond === 'refused' ? { ok: false, error: 'goal2 沒有接下這件事：條件太模糊' } : { ok: true, runId: 'r' + started.length }; },
    state: async (id) => states.get(id) || null,
  };
  const R = new Runner(S, b.ops);
  assert.strictEqual(clean({ kind: 'daily', at: '09:00', target: 'goal', cwd: d, prompt: '跑完測試' }, () => true).error, '請寫下完成條件：做到什麼程度、怎麼檢查算完成');
  const v = clean({ kind: 'daily', at: '09:00', target: 'goal', cwd: d, prompt: '跑完測試', goal: 'npm test 全過', skipPermissions: true, agent: 'reviewer' }, () => true).value;
  assert.deepStrictEqual([v.target, v.goal, v.skipPermissions, v.agent], ['goal', 'npm test 全過', false, ''], 'goal2 decides its own permissions; no role');
  const id = S.save(v, null, at(2026, 11, 14, 8, 0));
  assert.strictEqual(S.get(id).goal, 'npm test 全過');
  await R.tick(at(2026, 11, 14, 9, 0) + 5000);
  assert.deepStrictEqual(started, [['跑完測試', 'npm test 全過', d]]);
  assert.strictEqual(b.sent.length, 0, 'no conversation on the board');
  const run = S.runs(1)[0];
  assert.deepStrictEqual([run.status, run.how, run.sessionId], ['running', 'goal', 'goal:r1']);
  // still running, then not listed yet, then ended
  states.set('r1', { status: 'running', alive: true }); await R.settle(at(2026, 11, 14, 9, 5));
  assert.strictEqual(S.runs(1)[0].status, 'running');
  states.set('r1', { status: 'done', alive: false }); await R.settle(at(2026, 11, 14, 9, 30));
  assert.deepStrictEqual([S.runs(1)[0].status, /達成/.test(S.runs(1)[0].note)], ['done', true]);
  // one that does not reach its condition: failed, and you are told
  const id2 = S.save(clean({ kind: 'daily', at: '10:00', target: 'goal', cwd: d, prompt: 'x', goal: 'y' }, () => true).value, null, at(2026, 11, 14, 8, 0));
  await R.tick(at(2026, 11, 14, 10, 0) + 5000);
  states.set('r2', { status: 'impossible', alive: false }); await R.settle(at(2026, 11, 14, 10, 30));
  assert.strictEqual(S.runs(1)[0].status, 'failed');
  assert.ok(S.notices().some((n) => n.scheduleId === id2 && /判定做不到/.test(n.text)));
  // goal2 refuses the task itself
  S.save(clean({ kind: 'daily', at: '11:00', target: 'goal', cwd: d, prompt: 'x', goal: 'refused' }, () => true).value, null, at(2026, 11, 14, 8, 0));
  await R.tick(at(2026, 11, 14, 11, 0) + 5000);
  assert.ok(/條件太模糊/.test(S.runs(1)[0].note) && S.runs(1)[0].status === 'failed');
  // no goal2 on this computer
  const R2 = new Runner(S, Object.assign({}, b.ops, { goal: null }));
  S.save(clean({ kind: 'daily', at: '12:00', target: 'goal', cwd: d, prompt: 'x', goal: 'z' }, () => true).value, null, at(2026, 11, 14, 8, 0));
  await R2.tick(at(2026, 11, 14, 12, 0) + 5000);
  assert.ok(/沒有裝 goal2/.test(S.runs(1)[0].note));
});
