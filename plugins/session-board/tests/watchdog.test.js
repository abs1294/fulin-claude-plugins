'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../lib/watchdog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-watch-'));
const errLine = (text, ts, extra) => JSON.stringify(Object.assign({ type: 'assistant', timestamp: ts, isApiErrorMessage: true, error: 'rate_limit', message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } }, extra || {}));
const T = (iso) => Date.parse(iso);

test('the kinds of stop, in the words Claude Code writes them', () => {
  const k = (t) => W.classify(t);
  assert.deepStrictEqual([
    k("You've hit your session limit · resets 2:30pm (Asia/Taipei)"), k("You've hit your weekly limit · resets Sep 5, 3pm (Asia/Taipei)"),
    k('API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.'), k('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'),
    k("The model's tool call could not be parsed (retry also failed)."), k('API Error: 500 Internal server error. This is a server-side issue'), k('API Error: Unable to connect to API (ENOTFOUND)'),
  ], ['limit', 'limit', 'error', 'error', 'error', 'error', 'error']);
  // nothing that waiting fixes: left alone
  for (const t of ["You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.", "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage",
    "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 3:20pm (Asia/Taipei)", 'Prompt is too long', 'Please run /login · API Error: 403 Request not allowed',
    "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it. Run /model to pick a different model."]) assert.strictEqual(k(t), 'other', t);
});

test('when the limit comes back, read from the line and the time it was written', () => {
  const iso = (t) => (t ? new Date(t).toISOString() : 0);
  // 12:52 in Taipei; 2:30pm the same day
  assert.strictEqual(iso(W.resetTime("You've hit your session limit · resets 2:30pm (Asia/Taipei)", T('2026-06-29T04:52:54.898Z'))), '2026-06-29T06:30:00.000Z');
  // 23:00 in Taipei; 12:10am is the next day there
  assert.strictEqual(iso(W.resetTime('… resets 12:10am (Asia/Taipei)', T('2026-06-29T15:00:00Z'))), '2026-06-29T16:10:00.000Z');
  assert.strictEqual(iso(W.resetTime('… resets 3pm (Asia/Taipei)', T('2026-06-29T04:00:00Z'))), '2026-06-29T07:00:00.000Z');
  assert.strictEqual(iso(W.resetTime("You've hit your weekly limit · resets Sep 5, 3pm (Asia/Taipei)", T('2026-09-03T01:00:00Z'))), '2026-09-05T07:00:00.000Z');
  assert.strictEqual(iso(W.resetTime('… resets Jan 2, 9am (Asia/Taipei)', T('2026-12-30T01:00:00Z'))), '2027-01-02T01:00:00.000Z');          // across the new year
  assert.strictEqual(iso(W.resetTime('… resets 3pm (America/New_York)', T('2026-07-01T15:00:00Z'))), '2026-07-01T19:00:00.000Z');           // another zone, daylight time
  assert.deepStrictEqual([W.resetTime('no time in here', 5), W.resetTime('resets 2:30pm (Asia/Taipei)', 0), W.resetTime('resets 25:99pm (Asia/Taipei)', 5)], [0, 0, 0]);
});

test('how a transcript ends: an error line with only housekeeping after it; anything said after it is not an ending', () => {
  const d = tmp(), f = path.join(d, 't.jsonl');
  const user = (t, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: t } });
  const lim = errLine("You've hit your session limit · resets 2:30pm (Asia/Taipei)", '2026-06-29T04:52:54.898Z');
  fs.writeFileSync(f, [user('做一件事', '2026-06-29T04:50:00Z'), lim, JSON.stringify({ type: 'system', subtype: 'turn_duration' }), JSON.stringify({ type: 'file-history-snapshot' })].join('\n') + '\n');
  const e = W.ending(f);
  assert.deepStrictEqual([e.kind, e.at, new Date(e.resetAt).toISOString(), e.weekly], ['limit', T('2026-06-29T04:52:54.898Z'), '2026-06-29T06:30:00.000Z', false]);
  fs.appendFileSync(f, user('繼續', '2026-06-29T06:40:00Z') + '\n');
  assert.strictEqual(W.ending(f), null);                                                   // you already said something
  fs.writeFileSync(f, [user('x', '2026-06-29T04:50:00Z'), errLine('API Error: 529 Overloaded.', '2026-06-29T04:51:00Z')].join('\n'));
  assert.deepStrictEqual([W.ending(f).kind, W.ending(f).resetAt], ['error', 0]);
  fs.writeFileSync(f, [lim, errLine('x', '2026-06-29T04:53:00Z', { isSidechain: true })].join('\n'));   // a subagent's line is not the conversation's
  assert.strictEqual(W.ending(f).kind, 'limit');
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', timestamp: '2026-06-29T04:53:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: "You've hit your session limit is what the log said" }] } }));
  assert.strictEqual(W.ending(f), null);                                                   // a reply that merely quotes the words
  assert.strictEqual(W.ending(path.join(d, 'nothing.jsonl')), null);
});

// A watchdog over made-up sessions: what it told, what it sent, what it remembers.
function rig(sessions, endings, settings) {
  const r = { told: [], sent: [], peers: [], mem: '{}' /* has run before; null = never */, seen: {}, quota: {} };
  r.dog = new W.Watchdog({
    sessions: () => sessions, transcript: (s) => 'file:' + s.sessionId, settings: () => settings,
    channels: { send: (id, text) => { r.sent.push([id, text]); return { ok: true }; } },
    peer: async (s, text, mark) => { r.peers.push([s.sessionId, mark, text]); return r.peerFails ? { state: 'failed', note: '沒有名稱' } : { state: 'sent' }; },
    peerCheck: (s, mark) => r.seen[s.sessionId] || '', tell: (title, text) => r.told.push(title + '｜' + text),
    recall: () => (r.mem ? JSON.parse(r.mem) : null), remember: (st) => { r.mem = JSON.stringify(st); }, quota: () => r.quota,
  });
  r.dog.endingOf = (s) => endings[s.sessionId] || null;
  return r;
}
const MIN = 60000;

test('stuck: told once per standstill, never acted on; a session that moves again can be reported again', async () => {
  const s = { sessionId: 'a', title: '建置', status: 'busy', owner: 'terminal', activeAt: 1000 };
  const r = rig([s], {}, { stuck: true, stuckMinutes: 10 });
  await r.dog.tick(1000 + 9 * MIN); assert.strictEqual(r.told.length, 0);
  await r.dog.tick(1000 + 11 * MIN); await r.dog.tick(1000 + 30 * MIN);
  assert.deepStrictEqual([r.told.length, r.told[0].startsWith('可能卡住：建置｜顯示執行中，但已經 11 分鐘'), r.sent.length, r.peers.length], [1, true, 0, 0]);
  s.activeAt = 1000 + 31 * MIN; await r.dog.tick(1000 + 45 * MIN);
  assert.strictEqual(r.told.length, 2);
  const off = rig([{ sessionId: 'a', status: 'busy', activeAt: 1 }], {}, { stuck: false });
  await off.dog.tick(99 * MIN); assert.strictEqual(off.told.length, 0);
});

test('limit: you are told at once; the session is asked to carry on a minute after the reset, once, the way it is open', async () => {
  const at = T('2026-06-29T04:52:54Z'), reset = T('2026-06-29T06:30:00Z');
  const board = { sessionId: 'b', title: '看板裡的', status: 'idle', owner: 'board' }, term = { sessionId: 't', title: '終端機的', name: 'term-1', status: 'idle', owner: 'terminal' };
  const end = { kind: 'limit', at, text: 'x', resetAt: reset, weekly: false };
  const r = rig([board, term], { b: end, t: end }, { limitResume: true });
  await r.dog.tick(at + MIN);
  assert.deepStrictEqual([r.told.length, /^額度用完：看板裡的｜額度 .+ 回來，到時候看板會請它接著做。$/.test(r.told[0]), r.sent.length, r.peers.length], [2, true, 0, 0]);
  await r.dog.tick(reset + 30000); assert.deepStrictEqual([r.sent.length, r.peers.length], [0, 0]);              // not yet: a minute after
  r.quota = { fiveHour: { pct: 100, resetsAt: reset + 10 * MIN } };
  await r.dog.tick(reset + 2 * MIN); assert.deepStrictEqual([r.sent.length, r.peers.length], [0, 0]);            // the figure still says used up: wait
  r.quota = { fiveHour: { pct: 3, resetsAt: reset + 5 * 3600000 } };
  await r.dog.tick(reset + 3 * MIN);
  assert.deepStrictEqual([r.sent.map((x) => x[0]), r.sent[0][1] === W.LIMIT_PROMPT, r.peers.map((x) => x[0]), r.peers[0][2].includes(W.LIMIT_PROMPT) && r.peers[0][2].includes(r.peers[0][1])], [['b'], true, ['t'], true]);
  await r.dog.tick(reset + 4 * MIN); await r.dog.tick(reset + 5 * MIN);
  assert.deepStrictEqual([r.sent.length, r.peers.length], [1, 1]);                                               // once
  r.seen.t = 'delivered'; await r.dog.tick(reset + 5.5 * MIN);
  assert.deepStrictEqual(JSON.parse(r.mem).acted.t.state, 'delivered');
  // a board that restarts remembers: a new watchdog over the same memory sends nothing
  const again = rig([board, term], { b: end, t: end }, { limitResume: true }); again.mem = r.mem;
  await again.dog.tick(reset + 6 * MIN);
  assert.deepStrictEqual([again.sent.length, again.peers.length, again.told.length], [0, 0, 0]);
  assert.ok(r.dog.log().some((x) => x.sessionId === 't' && x.what === '它收下了，接著做'));
});

test('limit: switched off it only tells; a reset long past is left alone; a message not taken is reported', async () => {
  const at = T('2026-06-29T04:52:54Z'), reset = T('2026-06-29T06:30:00Z');
  const s = { sessionId: 't', title: 'T', name: 'n', status: 'idle', owner: 'terminal' }, end = { kind: 'limit', at, text: 'x', resetAt: reset };
  const off = rig([s], { t: end }, { limitResume: false });
  await off.dog.tick(at + MIN); await off.dog.tick(reset + 5 * MIN);
  assert.deepStrictEqual([off.peers.length, off.told.length, off.told[0].includes('自動接續是關著的')], [0, 1, true]);
  const late = rig([s], { t: end }, { limitResume: true });
  await late.dog.tick(reset + 13 * 3600000);
  assert.deepStrictEqual([late.peers.length, late.told.length, JSON.parse(late.mem).acted.t.state], [0, 0, 'stale']);   // the board was off all night: nothing is sent into a session you have left
  const lost = rig([s], { t: end }, { limitResume: true });
  await lost.dog.tick(reset + 2 * MIN); await lost.dog.tick(reset + 6 * MIN);
  assert.deepStrictEqual([lost.peers.length, JSON.parse(lost.mem).acted.t.state, lost.told[lost.told.length - 1].startsWith('沒有接續成：T｜')], [1, 'unconfirmed', true]);
  const fail = rig([s], { t: end }, { limitResume: true }); fail.peerFails = true;
  await fail.dog.tick(reset + 2 * MIN); await fail.dog.tick(reset + 3 * MIN);
  assert.deepStrictEqual([fail.peers.length, JSON.parse(fail.mem).acted.t.state], [1, 'failed']);
  // a working or waiting session is never spoken to, whatever its transcript ends in
  const busy = rig([Object.assign({}, s, { status: 'waiting' })], { t: end }, { limitResume: true });
  await busy.dog.tick(reset + 2 * MIN); assert.deepStrictEqual([busy.peers.length, busy.told.length], [0, 0]);
});

test('a server error: one more try two minutes later, at most three an hour; other errors are left alone', async () => {
  const s = { sessionId: 'b', title: 'B', status: 'idle', owner: 'board' };
  const ends = { b: { kind: 'error', at: 1000000, text: 'API Error: 529 Overloaded.' } };
  const r = rig([s], ends, { errorRetry: true });
  await r.dog.tick(1000000 + MIN); assert.strictEqual(r.sent.length, 0);
  await r.dog.tick(1000000 + 3 * MIN); assert.deepStrictEqual([r.sent.length, r.sent[0][1] === W.ERROR_PROMPT], [1, true]);
  for (let i = 1; i <= 4; i++) { ends.b = { kind: 'error', at: 1000000 + i * 5 * MIN, text: 'API Error: 529 Overloaded.' }; await r.dog.tick(ends.b.at + 3 * MIN); }
  assert.deepStrictEqual([r.sent.length, r.told.filter((x) => x.startsWith('不再自動再試')).length], [3, 1]);        // three, then it says so and stops
  const other = rig([s], { b: { kind: 'other', at: 5, text: 'Prompt is too long' } }, { errorRetry: true, limitResume: true });
  await other.dog.tick(99 * MIN); assert.deepStrictEqual([other.sent.length, other.told.length], [0, 0]);
  const off = rig([s], { b: { kind: 'error', at: 1000000, text: 'x' } }, { errorRetry: false });
  await off.dog.tick(1000000 + 3 * MIN); assert.strictEqual(off.sent.length, 0);
});

test('the first round ever acts on nothing that already stands stopped; a stop after that is handled', async () => {
  const at = T('2026-06-29T04:52:54Z'), reset = T('2026-06-29T06:30:00Z');
  const s = { sessionId: 'b', title: 'B', status: 'idle', owner: 'board' }, ends = { b: { kind: 'limit', at, text: 'x', resetAt: reset } };
  const r = rig([s], ends, { limitResume: true, errorRetry: true }); r.mem = null;
  await r.dog.tick(reset + 5 * MIN); await r.dog.tick(reset + 6 * MIN);
  assert.deepStrictEqual([r.sent.length, r.told.length, JSON.parse(r.mem).acted.b.state], [0, 0, 'baseline']);   // it was like that when the watching began
  ends.b = { kind: 'limit', at: reset + 3600000, text: 'x', resetAt: reset + 2 * 3600000 };                           // a new stop
  await r.dog.tick(reset + 3600000 + MIN); await r.dog.tick(reset + 2 * 3600000 + 2 * MIN);
  assert.deepStrictEqual([r.sent.length, r.told.length], [1, 2]);
});

test("one model's limit: a board conversation is switched to Opus at once and asked to carry on; a terminal session is told what to type", async () => {
  const line = "You've hit your Fable limit · resets Nov 18, 9pm (Asia/Taipei). Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
  assert.strictEqual(W.classify(line), 'model');
  assert.strictEqual(W.classify("You've hit your session limit · resets 2:30pm (Asia/Taipei)"), 'limit', 'the ordinary limit is unchanged');
  const d = tmp(), f = path.join(d, 't.jsonl'); fs.writeFileSync(f, errLine(line, '2026-11-17T05:00:00Z') + '\n');
  const e = W.ending(f);
  assert.deepStrictEqual([e.kind, e.model, new Date(e.resetAt).toISOString()], ['model', 'Fable', '2026-11-18T13:00:00.000Z']);
  const at = T('2026-11-17T05:00:00Z');
  const board = { sessionId: 'b', title: '看板裡的', status: 'idle', owner: 'board' }, term = { sessionId: 't', title: '終端機的', status: 'idle', owner: 'terminal' };
  const r = rig([board, term], { b: e, t: e }, {});
  const models = []; r.dog.ops.channels.setModel = (id, m) => { models.push([id, m]); return { ok: true }; };
  await r.dog.tick(at + 20000);
  assert.deepStrictEqual(models, [['b', 'opus']], 'switched now, without waiting for the reset');
  assert.deepStrictEqual([r.sent.length, r.sent[0][0], /Fable 的用量額度用完.*改用 opus/.test(r.sent[0][1])], [1, 'b', true]);
  assert.strictEqual(r.peers.length, 0, 'nothing sent into the terminal session');
  assert.ok(r.told.some((t) => /^Fable 額度用完：終端機的｜.*輸入 \/model opus/.test(t)), JSON.stringify(r.told));
  await r.dog.tick(at + 60000); await r.dog.tick(at + 120000);
  assert.deepStrictEqual([models.length, r.sent.length], [1, 1], 'once');
  // switched off: only told
  const r2 = rig([board], { b: e }, { modelSwitch: false }); const m2 = []; r2.dog.ops.channels.setModel = (id, m) => { m2.push(m); return { ok: true }; };
  await r2.dog.tick(at + 20000);
  assert.deepStrictEqual([m2.length, r2.sent.length, /自動換模型是關著的/.test(r2.told[0])], [0, 0, true]);
  // another model chosen in the settings
  const r3 = rig([board], { b: e }, { switchTo: 'sonnet' }); const m3 = []; r3.dog.ops.channels.setModel = (id, m) => { m3.push(m); return { ok: true }; };
  await r3.dog.tick(at + 20000); assert.deepStrictEqual(m3, ['sonnet']);
});

test('a command typed in Claude Code after the stop (/model) does not hide it', () => {
  const d = tmp(), f = path.join(d, 't.jsonl');
  const user = (c, ts, extra) => JSON.stringify(Object.assign({ type: 'user', timestamp: ts, message: { role: 'user', content: c } }, extra));
  fs.writeFileSync(f, [
    errLine("You've hit your Fable limit · resets Nov 18, 9pm (Asia/Taipei). Switch to another model, or manage usage credits at https://claude.ai/settings/usage, to continue.", '2026-11-17T05:30:25Z'),
    user('<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>', '2026-11-17T05:31:03Z', { isMeta: true }),
    user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>', '2026-11-17T05:31:03Z'),
    user('<local-command-stdout>Kept model as Fable</local-command-stdout>', '2026-11-17T05:31:04Z'),
    JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: '2026-11-17T05:31:03Z' }),
  ].join('\n') + '\n');
  assert.deepStrictEqual([W.ending(f).kind, W.ending(f).model], ['model', 'Fable']);
  fs.appendFileSync(f, user('那就先這樣', '2026-11-17T05:32:00Z') + '\n');
  assert.strictEqual(W.ending(f), null, 'something you really said: no longer stopped');
});
