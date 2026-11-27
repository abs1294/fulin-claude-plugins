#!/usr/bin/env node
// Compaction counts (scripts/lib-compacts.js through lib-records.js collect): a conversation's own, the ones a copy
// carried over from the conversation it was copied from, and those its transcript shows but the hook never counted.
// In a made-up home folder. Run: node hooks/tests/compacts.test.js -> one line a failed check, exit 1 when there is one.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..'), LIB = path.join(ROOT, 'scripts', 'lib-records.js'), HOOK = path.join(ROOT, 'hooks', 'compact-monitor.js');
let pass = 0, fail = 0;
const check = (ok, what, got) => { if (ok) pass++; else { fail++; console.log('FAIL | ' + what + ' | ' + JSON.stringify(got)); } };
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cmp-')), env = Object.assign({}, process.env, { USERPROFILE: H, HOME: H });
const PRJ = path.join(H, '.claude', 'projects'), STATE = path.join(H, '.claude', 'cc-statusline', 'state'), P = 'C--w-proj', D = path.join(PRJ, P);
const run = (o) => { const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(' + JSON.stringify(LIB) + ').collect(' + JSON.stringify(o || {}) + ')))'], { env, encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch (e) { return r.stderr; } };
const key = (sid) => sid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
const state = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'claude-compacts-' + key(sid) + '.json'), 'utf8')); } catch (e) { return null; } };
const setState = (sid, j) => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(path.join(STATE, 'claude-compacts-' + key(sid) + '.json'), JSON.stringify(j)); };
const shown = (sid) => { const s = state(sid); return s ? (Number(s.count) || 0) + (Number(s.inherited) || 0) : 0; };
const L = (o) => JSON.stringify(o) + '\n';
const meta = (sid) => L({ type: 'custom-title', customTitle: 't', sessionId: sid }) + L({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-27T14:00:00Z', sessionId: sid });
const you = (sid, ts, x) => L(Object.assign({ type: 'user', sessionId: sid, timestamp: ts, message: { role: 'user', content: '秘密內容' } }, x));
const reply = (sid, id, ts, x) => L(Object.assign({ type: 'assistant', sessionId: sid, timestamp: ts, message: { id, model: 'claude-haiku-4-5', content: [{ type: 'text', text: '秘密內容' }], usage: { input_tokens: 1 } } }, x));
const boundary = (sid, uuid, ts) => L({ type: 'system', subtype: 'compact_boundary', parentUuid: null, logicalParentUuid: 'x', uuid, sessionId: sid, timestamp: ts, compactMetadata: { trigger: 'auto' } });
const summary = (sid, ts) => you(sid, ts, { isCompactSummary: true });
try {
  fs.mkdirSync(D, { recursive: true });
  const A = 'aaaaaaaa-1111-4111-8111-111111111111', B = 'bbbbbbbb-1111-4111-8111-111111111111', C = 'cccccccc-1111-4111-8111-111111111111', E = 'eeeeeeee-1111-4111-8111-111111111111', N = 'dddddddd-1111-4111-8111-111111111111';
  // A: compacted three times (the hook counted them), the last at 06:57
  fs.writeFileSync(path.join(D, A + '.jsonl'), you(A, '2026-11-27T01:00:00Z') + reply(A, 'a1', '2026-11-27T01:00:01Z')
    + boundary(A, 'u1', '2026-11-27T02:00:00Z') + summary(A, '2026-11-27T02:00:00Z') + reply(A, 'a2', '2026-11-27T02:10:00Z')
    + boundary(A, 'u2', '2026-11-27T04:00:00Z') + summary(A, '2026-11-27T04:00:00Z') + reply(A, 'a3', '2026-11-27T04:10:00Z')
    + boundary(A, 'u3', '2026-11-27T06:57:16Z') + summary(A, '2026-11-27T06:57:14Z') + reply(A, 'a4', '2026-11-27T06:54:47Z'));
  setState(A, { count: 3, last: Date.parse('2026-11-27T06:55:10Z') });
  // B: a copy of A, made at 14:00 from A's last compaction (claude --resume A --fork-session)
  const copied = boundary(B, 'u3', '2026-11-27T06:57:16Z') + summary(B, '2026-11-27T06:57:14Z') + reply(B, 'a4', '2026-11-27T06:54:47Z', { requestSessionId: A });
  fs.writeFileSync(path.join(D, B + '.jsonl'), meta(B) + copied + you(B, '2026-11-27T14:00:15Z') + reply(B, 'b1', '2026-11-27T14:00:18Z'));
  // N: never compacted; E: compacted twice before the hook kept its count (no file)
  fs.writeFileSync(path.join(D, N + '.jsonl'), you(N, '2026-11-27T01:00:00Z') + reply(N, 'n1', '2026-11-27T01:00:01Z'));
  fs.writeFileSync(path.join(D, E + '.jsonl'), you(E, '2026-08-14T01:00:00Z') + reply(E, 'e1', '2026-08-14T01:00:01Z') + boundary(E, 'e-u1', '2026-08-14T13:57:37Z') + summary(E, '2026-08-14T13:57:37Z') + reply(E, 'e2', '2026-08-14T14:00:00Z') + boundary(E, 'e-u2', '2026-09-08T06:53:46Z'));

  let r = run();
  check(r && typeof r.added === 'number', 'collect ran', r);
  let b = state(B);
  check(b && b.v === 1 && b.count === 0 && b.inherited === 3 && b.from === A && b.inheritedAt === Date.parse('2026-11-27T06:57:16Z') && shown(B) === 3, 'a copy: the three of the conversation it was copied from', b);
  check(JSON.stringify(state(A)) === JSON.stringify({ count: 3, last: Date.parse('2026-11-27T06:55:10Z') }), 'the original: its file left as the hook wrote it', state(A));
  check(state(N) === null, 'never compacted: no file (still 0)', state(N));
  const e = state(E); check(e && e.count === 2 && e.inherited === 0 && e.last === Date.parse('2026-09-08T06:53:46Z') && !e.from, 'compacted before the hook counted: its own boundaries', e);
  check(!fs.readdirSync(STATE).some((f) => fs.readFileSync(path.join(STATE, f), 'utf8').includes('秘密')) && !fs.readFileSync(path.join(H, '.claude', 'usage-data', 'records', '.own', 'compacts.json'), 'utf8').includes('秘密'), 'no conversation text', '');

  // the copy compacts itself: the hook counts it, what it carried over stays
  spawnSync(process.execPath, [HOOK], { env, input: JSON.stringify({ session_id: B }), encoding: 'utf8' });
  fs.appendFileSync(path.join(D, B + '.jsonl'), boundary(B, 'b-u1', '2026-11-27T16:00:00Z') + summary(B, '2026-11-27T16:00:00Z') + reply(B, 'b2', '2026-11-27T16:01:00Z'));
  r = run({ transcript: path.join(D, B + '.jsonl') });
  b = state(B); check(b && b.count === 1 && b.inherited === 3 && shown(B) === 4, 'its own compaction on top of the three', b);

  // A goes on and compacts again after B was copied: B keeps what A had had by then
  setState(A, { count: 4, last: Date.parse('2026-11-27T18:00:00Z') });
  fs.appendFileSync(path.join(D, A + '.jsonl'), boundary(A, 'u4', '2026-11-27T18:01:00Z') + summary(A, '2026-11-27T18:01:00Z'));
  r = run();
  check(state(B).inherited === 3, 'what A did later is not B\'s', state(B));

  // a copy of the copy, from B's own compaction: A's three and B's one
  const C1 = boundary(C, 'b-u1', '2026-11-27T16:00:00Z') + summary(C, '2026-11-27T16:00:00Z') + reply(C, 'b2', '2026-11-27T16:01:00Z', { requestSessionId: B });
  fs.writeFileSync(path.join(D, C + '.jsonl'), meta(C) + C1 + you(C, '2026-11-27T20:00:00Z') + reply(C, 'c1', '2026-11-27T20:00:05Z'));
  r = run({ transcript: path.join(D, C + '.jsonl') });
  check(state(C) && state(C).inherited === 4 && state(C).from === B && shown(C) === 4, 'a copy of a copy', state(C));

  // a copy made in another project folder than A's (A has compacted once more since): what A had by then, not now
  const X = '12121212-1111-4111-8111-111111111111', D2 = path.join(PRJ, 'C--w-other'); fs.mkdirSync(D2, { recursive: true });
  fs.writeFileSync(path.join(D2, X + '.jsonl'), meta(X) + copied.replace(/"sessionId":"bbbbbbbb[^"]*"/g, '"sessionId":"' + X + '"') + you(X, '2026-11-27T22:30:00Z'));
  r = run({ transcript: path.join(D2, X + '.jsonl') });
  check(state(X) && state(X).inherited === 3 && state(X).from === A && shown(X) === 3 && state(A).count === 4, 'a copy in another folder: A\'s three of then, not its four of now', [state(X), state(A)]);

  // a first message that speaks of compact_boundary is still the first message: the compaction after it is its own
  const W = '34343434-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(D, W + '.jsonl'), meta(W) + you(W, '2026-11-27T01:00:00Z', { message: { role: 'user', content: 'compact_boundary' } }) + reply(W, 'w1', '2026-11-27T01:00:05Z', { message: { id: 'w1', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'compact_boundary' } }], usage: { input_tokens: 1 } } })
    + boundary(W, 'w-u1', '2026-11-27T03:00:00Z') + summary(W, '2026-11-27T03:00:00Z'));
  r = run({ transcript: path.join(D, W + '.jsonl') });
  check(state(W) && state(W).count === 1 && state(W).inherited === 0 && !state(W).from, 'a message naming the boundary is no boundary: its own compaction, nothing carried over', state(W));

  // copied from a conversation no run has read yet, which compacted again after the copy was made: read on the spot,
  // and only what it had by then counts (P: compacted at 10:00 - copied - and again at 12:00; the hook counted both)
  const P = '56565656-1111-4111-8111-111111111111', Q = '78787878-1111-4111-8111-111111111111', D3 = path.join(PRJ, 'C--w-third'); fs.mkdirSync(D3, { recursive: true });
  fs.writeFileSync(path.join(D3, P + '.jsonl'), you(P, '2026-11-27T09:00:00Z') + reply(P, 'p1', '2026-11-27T09:00:05Z') + boundary(P, 'p-u1', '2026-11-27T10:00:00Z') + summary(P, '2026-11-27T10:00:00Z') + reply(P, 'p2', '2026-11-27T10:05:00Z')
    + boundary(P, 'p-u2', '2026-11-27T12:00:00Z') + summary(P, '2026-11-27T12:00:00Z'));
  setState(P, { count: 2, last: Date.parse('2026-11-27T11:59:00Z') });
  fs.writeFileSync(path.join(D, Q + '.jsonl'), meta(Q) + boundary(Q, 'p-u1', '2026-11-27T10:00:00Z') + summary(Q, '2026-11-27T10:00:00Z') + reply(Q, 'p2', '2026-11-27T10:05:00Z', { requestSessionId: P }) + you(Q, '2026-11-27T11:00:00Z'));
  r = run({ transcript: path.join(D, Q + '.jsonl') });
  check(state(Q) && state(Q).inherited === 1 && state(Q).from === P, 'its original read on the spot (another folder, never read before): one of then, not two of now', state(Q));

  // the hook's count higher than the boundaries (it counts every compaction that started): kept
  setState(N, { count: 5, last: 1 });
  fs.appendFileSync(path.join(D, N + '.jsonl'), boundary(N, 'n-u1', '2026-11-27T21:00:00Z'));
  r = run(); check(state(N).count === 5 && state(N).last === 1, 'never lowered', state(N));

  // a copy whose original cannot be told (an older Claude Code wrote no requestSessionId): one at least
  const F = 'ffffffff-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(D, F + '.jsonl'), meta(F) + boundary(F, 'zz', '2026-11-27T05:00:00Z') + summary(F, '2026-11-27T05:00:00Z') + you(F, '2026-11-27T22:00:00Z') + reply(F, 'f1', '2026-11-27T22:00:05Z'));
  r = run(); check(state(F) && state(F).inherited === 1 && !state(F).from && shown(F) === 1, 'the original unknown: at least the one copied', state(F));

  // a transcript read in two goes (a line half written at first) counts the same
  const G = '99999999-1111-4111-8111-111111111111', gp = path.join(D, G + '.jsonl'), whole = meta(G) + copied.replace(/"sessionId":"bbbbbbbb[^"]*"/g, '"sessionId":"' + G + '"') + you(G, '2026-11-27T23:00:00Z');
  fs.writeFileSync(gp, whole.slice(0, 120)); r = run({ transcript: gp });
  fs.appendFileSync(gp, whole.slice(120)); r = run({ transcript: gp });
  check(state(G) && state(G).inherited === 3 && state(G).from === A, 'read in two goes', state(G));
} finally {
  try { fs.rmSync(H, { recursive: true, force: true }); } catch (e) {}
}
console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
