'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Notices } = require('../lib/notices');
const { Watchdog } = require('../lib/watchdog');

const fresh = (o = { statusNotices: true }) => new Notices(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notice-')), 'b.db'), o);
const open = (N) => N.openList().map((x) => x.kind + ':' + x.sessionId).sort();
const closed = (N) => N.closedList().map((x) => x.kind + ':' + x.sessionId + '/' + x.closedBy).sort();
const S = (id, title) => ({ sessionId: id, title: title || id });

test('waiting: opens when a session stops for you, closes when it goes on; the same thing twice is one notice', () => {
  const N = fresh();
  N.status(S('a', '甲'), 'busy', 'waiting', 1000);
  N.status(S('a', '甲'), 'busy', 'waiting', 1100);                                   // told again: still one
  assert.deepStrictEqual([open(N), N.openCount(), N.openList()[0].title], [['waiting:a'], 1, '等你回應：甲']);
  N.status(S('a'), 'waiting', 'busy', 2000);                                        // you answered
  assert.deepStrictEqual([open(N), closed(N), N.closedList()[0].closedAt], [[], ['waiting:a/answered'], 2000]);
  N.status(S('a'), 'busy', 'waiting', 3000);                                        // it asks again: a new notice, the old one stays closed
  N.status(S('a'), 'waiting', 'idle', 3500);                                        // the turn was stopped instead of answered: said as it is
  assert.strictEqual(N.closedList()[0].closedBy, 'stopped');
  N.status(S('a'), 'busy', 'waiting', 3600);
  assert.deepStrictEqual([open(N), N.closedList().length], [['waiting:a'], 2]);   // open once more; the two earlier ones stay closed
});

test('done: opens when a turn ends, closes when you look at it, when it starts again, or when it asks you something', () => {
  const N = fresh();
  N.status(S('a'), 'busy', 'idle', 1000); N.status(S('b'), 'background', 'idle', 1000); N.status(S('c'), 'busy', 'idle', 1000);
  assert.deepStrictEqual(open(N), ['done:a', 'done:b', 'done:c']);
  assert.strictEqual(N.seen('a', 2000), true);                                      // opened on the board
  N.status(S('b'), 'idle', 'busy', 2000);                                           // you told it something more
  N.status(S('c'), 'idle', 'waiting', 2000);
  assert.deepStrictEqual([open(N), closed(N)], [['waiting:c'], ['done:a/seen', 'done:b/continued', 'done:c/continued']]);
  assert.strictEqual(N.seen('a', 3000), false);                                     // nothing left to close
  N.status(S('z'), 'idle', 'idle', 4000); N.status(S('z'), '', 'idle', 4000);       // not a turn ending: nothing
  assert.strictEqual(open(N).includes('done:z'), false);
});

test('stuck, limit, error: each closes when the session is at work again or leaves work; a session that ends closes everything of it', () => {
  const N = fresh();
  N.open({ kind: 'stuck', sessionId: 'a', title: '可能卡住：甲' }, 1000);
  N.open({ kind: 'limit', sessionId: 'b', title: '額度用完：乙' }, 1000);
  N.open({ kind: 'error', sessionId: 'c', title: '被錯誤中斷：丙' }, 1000);
  N.open({ kind: 'limit', sessionId: 'd', title: '額度用完：丁' }, 1000); N.status(S('d'), 'busy', 'waiting', 1000);
  N.status(S('a'), 'busy', 'idle', 2000);                                           // it stopped working: not stuck any more (and it finished)
  N.status(S('b'), 'idle', 'busy', 2000);                                           // carried on after the limit came back
  N.status(S('c'), 'idle', 'busy', 2000);
  assert.deepStrictEqual([open(N), closed(N)], [['done:a', 'limit:d', 'waiting:d'], ['error:c/resumed', 'limit:b/resumed', 'stuck:a/moved']]);
  assert.strictEqual(N.gone('d', 3000), 2);                                         // the session ended: both of its notices
  assert.deepStrictEqual(open(N), ['done:a']);
  assert.ok(closed(N).includes('limit:d/ended') && closed(N).includes('waiting:d/ended'));
});

test('an event that never arrived: the table is made true to the sessions as they are', () => {
  const N = fresh();
  N.status(S('gone'), 'busy', 'waiting', 1000);                                     // its session ended while the board was off
  N.status(S('answered'), 'busy', 'waiting', 1000);                                 // you answered in the terminal; the event was lost
  N.status(S('still'), 'busy', 'waiting', 1000);
  N.status(S('again'), 'busy', 'idle', 1000);                                       // "finished" - but it is working again
  N.status(S('unseen'), 'busy', 'idle', 1000);
  N.open({ kind: 'stuck', sessionId: 'moved' }, 1000); N.open({ kind: 'stuck', sessionId: 'stuckstill' }, 1000);
  N.open({ kind: 'limit', sessionId: 'resumed' }, 1000); N.open({ kind: 'limit', sessionId: 'halted' }, 1000);
  N.open({ key: 'budget:2026-11:warn', kind: 'budget', title: '預算' }, 1000);      // not about a session: left alone here
  const now = [['answered', 'busy'], ['still', 'waiting'], ['again', 'busy'], ['unseen', 'idle'], ['moved', 'idle'], ['stuckstill', 'busy'], ['resumed', 'busy'], ['halted', 'idle']].map(([sessionId, status]) => ({ sessionId, status }));
  assert.strictEqual(N.reconcile(now, 5000), 5);
  assert.deepStrictEqual(open(N), ['budget:', 'done:unseen', 'limit:halted', 'stuck:stuckstill', 'waiting:still']);
  assert.deepStrictEqual(closed(N), ['done:again/continued', 'limit:resumed/resumed', 'stuck:moved/moved', 'waiting:answered/answered', 'waiting:gone/ended']);
  assert.strictEqual(N.reconcile(now, 6000), 0);                                    // nothing left to fix: it does not keep closing
});

test('by hand, the budget, and what is kept: dismissing closes one; last month\'s budget notices close; closed ones go after 30 days', () => {
  const N = fresh(), DAY = 86400000;
  const w = N.open({ kind: 'waiting', sessionId: 'a', title: 't' }, 1000);
  assert.deepStrictEqual([N.closeId(w.id, 'dismissed', 2000), N.closeId(w.id, 'dismissed', 2100), closed(N)], [true, false, ['waiting:a/dismissed']]);
  N.open({ key: 'budget:2026-10:100', kind: 'budget', title: '十月' }, 1000); N.open({ key: 'budget:2026-11:warn', kind: 'budget', title: '十一月' }, 1000);
  assert.strictEqual(N.closeKind('budget', 'month over', 'budget:2026-11:', 3000), 1);          // every budget notice that is not this month's
  assert.deepStrictEqual(N.openList().map((x) => x.key), ['budget:2026-11:warn']);
  assert.strictEqual(N.closeKind('budget', 'budget changed', '', 4000), 1);
  N.status(S('old'), 'busy', 'waiting', 1000); N.status(S('old'), 'waiting', 'busy', 2000);
  assert.strictEqual(N.prune(2000 + 31 * DAY), 4);                                              // all closed more than 30 days ago
  assert.deepStrictEqual([N.closedList().length, N.openCount()], [0, 0]);
});

test('the watching of stopped sessions opens a notice for what it finds and clears a standstill that is over', async () => {
  const N = fresh(), told = [];
  const s = { sessionId: 'a', title: '建置', status: 'busy', owner: 'terminal', activeAt: 1000 };
  let mem = '{}';
  const dog = new Watchdog({ sessions: () => [s], transcript: () => 'f', settings: () => ({ stuck: true, stuckMinutes: 10 }), channels: {}, tell: (t) => told.push(t),
    recall: () => JSON.parse(mem), remember: (st) => { mem = JSON.stringify(st); }, open: (n) => N.open(n), resolve: (kind, sid, by) => N.close(kind + ':' + sid, by) });
  dog.endingOf = () => null;
  const MIN = 60000;
  await dog.tick(1000 + 11 * MIN); await dog.tick(1000 + 12 * MIN);
  assert.deepStrictEqual([open(N), N.openList()[0].title, told.length], [['stuck:a'], '可能卡住：建置', 1]);   // one notice, one Windows notification: two different things
  s.activeAt = 1000 + 12.5 * MIN; await dog.tick(1000 + 13 * MIN);                    // it wrote again
  assert.deepStrictEqual([open(N), closed(N)], [[], ['stuck:a/moved']]);
  s.activeAt = 1000 + 13 * MIN; await dog.tick(1000 + 30 * MIN);                      // and stands still again: a new notice
  assert.deepStrictEqual(open(N), ['stuck:a']);
  s.status = 'idle'; await dog.tick(1000 + 31 * MIN);
  assert.deepStrictEqual(open(N), []);
});

test('by default a turn that ends or asks you writes nothing (the left column shows those); stuck, limits and errors still do; old ones are retired', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notice-')), 'b.db');
  const before = new Notices(file, { statusNotices: true });
  before.status(S('a', '甲'), 'busy', 'idle', 1000); before.status(S('b', '乙'), 'busy', 'waiting', 1000);
  before.open({ kind: 'stuck', sessionId: 'c', title: '卡住' }, 1000);
  const N = new Notices(file);
  assert.deepStrictEqual(open(N), ['stuck:c'], 'done and waiting left open from before are closed');
  assert.ok(closed(N).includes('done:a/retired') && closed(N).includes('waiting:b/retired'));
  N.status(S('d', '丁'), 'busy', 'idle', 2000); N.status(S('e', '戊'), 'busy', 'waiting', 2000);
  N.open({ kind: 'limit', sessionId: 'f', title: '額度' }, 2000);
  assert.deepStrictEqual(open(N), ['limit:f', 'stuck:c']);
});
