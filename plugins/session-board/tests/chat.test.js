'use strict';
// node --test plugins/session-board/tests/chat.test.js
// History reading and the conversation manager, with a fake claude process.
const test = require('node:test');
const assert = require('node:assert');
const WIN_ONLY = { skip: process.platform !== 'win32' && 'Windows only: Windows paths and tools (the Mac side: tests/mac.test.js, tests/mac-e2e.js)' };
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const H = require('../lib/history');
const { Channels } = require('../lib/chat');
const S = require('../lib/sessions');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-test-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

const user = (text, extra) => JSON.stringify(Object.assign({ type: 'user', uuid: 'u-' + text.slice(0, 6), timestamp: '2026-11-12T06:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } }, extra));
const asst = (blocks, id) => JSON.stringify({ type: 'assistant', uuid: id || 'a1', timestamp: '2026-11-12T06:00:01.000Z', message: { role: 'assistant', content: blocks } });

test('readHistory keeps what was typed and said, in order, and drops the rest', () => {
  const f = path.join(tmp(), 't.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'api-request-blob', hash: 'x', content: [{ type: 'text', text: '"type":"user" quoted inside a blob' }] }),
    user('第一問'),
    user('<system-reminder>\nnot typed</system-reminder>'),
    user('<task-notification>agent done</task-notification>'),
    asst([{ type: 'thinking', thinking: '...' }], 'a0'),
    asst([{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: '列出檔案' } }], 'a1'),
    JSON.stringify({ type: 'user', uuid: 'tr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } }),
    asst([{ type: 'text', text: '第一答' }], 'a2'),
    user('子代理的話', { isSidechain: true }),
    user('第二問'),
    '{broken json "type":"user"',
    asst([{ type: 'text', text: '第二答' }, { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\x\\y.txt' } }], 'a3'),
  ].join('\n') + '\n');
  const r = H.readHistory(f);
  assert.strictEqual(r.more, false);
  assert.deepStrictEqual(r.items.map((i) => [i.role, i.tool || '', i.text]), [
    ['user', '', '第一問'],
    ['tool', 'Bash', '列出檔案'],
    ['assistant', '', '第一答'],
    ['user', '', '第二問'],
    ['assistant', '', '第二答'],
    ['tool', 'Read', 'C:\\x\\y.txt'],
  ]);
});

test('readHistory stops at max and says more exist; survives lines larger than a chunk', () => {
  const f = path.join(tmp(), 't.jsonl');
  const big = JSON.stringify({ type: 'api-request-blob', pad: 'x'.repeat(2.5 * 1024 * 1024) });
  const lines = [];
  for (let i = 0; i < 30; i++) { lines.push(user('問' + i, { uuid: 'u' + i })); if (i % 10 === 0) lines.push(big); lines.push(asst([{ type: 'text', text: '答' + i }], 'a' + i)); }
  fs.writeFileSync(f, lines.join('\n'));   // no trailing newline
  const r = H.readHistory(f, { max: 10 });
  assert.strictEqual(r.more, true);
  assert.strictEqual(r.items.length, 10);
  assert.strictEqual(r.items[r.items.length - 1].text, '答29');
  assert.strictEqual(r.items[0].text, '問25');
  const all = H.readHistory(f, { max: 1000 });
  assert.strictEqual(all.items.length, 60);
  assert.strictEqual(all.items[0].text, '問0');
  assert.strictEqual(all.more, false);
});

test('readHistory on a missing or empty file', () => {
  const d = tmp();
  assert.deepStrictEqual(H.readHistory(path.join(d, 'nope.jsonl')), { items: [], more: false });
  fs.writeFileSync(path.join(d, 'empty.jsonl'), '');
  assert.deepStrictEqual(H.readHistory(path.join(d, 'empty.jsonl')), { items: [], more: false });
});

// A stand-in for the claude process: records what is written to stdin, lets the test emit stdout lines.
function fakeSpawn(log) {
  return (bin, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = Object.assign(new EventEmitter(), { written: [], write(s) { this.written.push(JSON.parse(s)); return true; }, end() { p.emit('exit', 0); } });
    p.kill = () => { p.killed = true; p.emit('exit', null); };
    p.out = (o) => p.stdout.emit('data', JSON.stringify(o) + '\n');
    log.push({ bin, args, opts, p });
    return p;
  };
}
function listener() {
  const res = Object.assign(new EventEmitter(), { events: [], write(s) { const m = /^data: (.*)\n\n$/.exec(s); if (m) this.events.push(JSON.parse(m[1])); }, end() {} });
  return res;
}

test('Channels: a turn, an approval, and what is saved', () => {
  const d = tmp();
  const file = path.join(d, 'channels.json');
  const log = [];
  let hasTranscript = false;
  const ch = new Channels(file, { spawn: fakeSpawn(log), transcriptOf: () => (hasTranscript ? 'x' : null) });
  const c = ch.create(d);
  const res = listener();
  assert.strictEqual(ch.subscribe(c.sessionId, res), true);
  assert.strictEqual(ch.status(c), 'idle');

  assert.deepStrictEqual(ch.send(c.sessionId, '  幫我 建檔  '), { ok: true, queued: false, mid: false });
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual(log[0].args.slice(-2), ['--session-id', c.sessionId]);   // new session: created under the channel's id
  assert.ok(log[0].args.includes('--permission-prompt-tool'));
  assert.strictEqual(log[0].opts.cwd, d);
  const p = log[0].p;
  assert.deepStrictEqual(p.stdin.written[0], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '  幫我 建檔  ' }] } });
  assert.strictEqual(ch.status(c), 'busy');
  assert.strictEqual(c.title, '幫我 建檔');

  p.out({ type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'tool_use', name: 'Write', input: { file_path: 'a.txt', content: 'hi' } }] } });
  p.out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input: { file_path: 'a.txt', content: 'hi' } } });
  assert.strictEqual(ch.status(c), 'waiting');
  assert.deepStrictEqual(ch.answer(c.sessionId, 'nope', true), { ok: false, error: 'no such request' });
  assert.deepStrictEqual(ch.answer(c.sessionId, 'r1', true), { ok: true });
  assert.deepStrictEqual(p.stdin.written[1], { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { file_path: 'a.txt', content: 'hi' } } } });
  assert.strictEqual(ch.status(c), 'busy');

  p.out({ type: 'assistant', message: { content: [{ type: 'text', text: '做好了' }] } });
  p.out({ type: 'result', subtype: 'success', is_error: false, result: '做好了' });
  assert.strictEqual(ch.status(c), 'idle');
  assert.strictEqual(ch.unread(c), true);
  ch.seen(c.sessionId);
  assert.strictEqual(ch.unread(c), false);

  assert.deepStrictEqual(res.events.filter((e) => e.type !== 'tasks' && e.type !== 'shell' && e.type !== 'unsent' && e.type !== 'user').map((e) => e.type), ['state', 'state', 'tool', 'permission', 'state', 'permission-done', 'state', 'assistant', 'result', 'state']);
  assert.deepStrictEqual(res.events.find((e) => e.type === 'permission'), { type: 'permission', requestId: 'r1', tool: 'Write', text: 'a.txt' });

  // Second message: same process, no second spawn.
  hasTranscript = true;
  c.lastResultAt = Date.now() + 1; ch.send(c.sessionId, '第二則');
  assert.strictEqual(ch.unread(c), true, 'sent by whoever: what was not read is not read by that (you wrote it: server.js says seen)');
  assert.strictEqual(log.length, 1);
  p.out({ type: 'result', is_error: false });

  // Saved and reloaded: the channel survives a restart, and resumes instead of creating.
  const again = new Channels(file, { spawn: fakeSpawn(log), transcriptOf: () => 'x' });
  assert.strictEqual(again.list().length, 1);
  assert.strictEqual(again.get(c.sessionId).title, '幫我 建檔');
  again.send(c.sessionId, '重開後');
  assert.deepStrictEqual(log[1].args.slice(-2), ['--resume', c.sessionId]);
  ch.shutdown(); again.shutdown();
});

test('Channels: a process that dies mid-turn is reported, and deny / stop / remove work', () => {
  const d = tmp();
  const log = [];
  const ch = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const c = ch.create(d);
  const res = listener();
  ch.subscribe(c.sessionId, res);
  ch.send(c.sessionId, 'x');
  log[0].p.stderr.emit('data', 'boom');
  log[0].p.emit('exit', 1);
  assert.strictEqual(ch.status(c), 'idle');
  assert.ok(res.events.some((e) => e.type === 'error' && e.text.includes('boom')));
  assert.strictEqual(ch.running(c.sessionId), false);

  ch.send(c.sessionId, 'y');
  const p = log[1].p;
  p.out({ type: 'control_request', request_id: 'r9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } } });
  ch.answer(c.sessionId, 'r9', false);
  assert.strictEqual(p.stdin.written[1].response.response.behavior, 'deny');

  assert.strictEqual(ch.stop(c.sessionId), true);
  assert.strictEqual(p.killed, true);
  assert.strictEqual(ch.status(c), 'idle');
  assert.strictEqual(ch.remove(c.sessionId), true);
  assert.strictEqual(ch.has(c.sessionId), false);
  assert.deepStrictEqual(ch.send(c.sessionId, 'z'), { ok: false, error: 'no such channel' });
  ch.shutdown();
});

test('a question form is read from the transcript, shown as a form, and answered with the choices', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  const questions = [
    { question: '哪裡最卡？', header: '最卡的事', multiSelect: true, options: [{ label: '看不懂', description: '約 25 次' }, { label: '太慢' }] },
    { question: '要不要刪？', header: '刪除', multiSelect: false, options: [{ label: '要' }, { label: '不要' }] },
  ];
  fs.writeFileSync(f, [
    user('整理一下'),
    asst([{ type: 'text', text: '先問你' }, { type: 'tool_use', name: 'AskUserQuestion', input: { questions } }], 'a1'),
    // The sentence in the tool result differs between Claude Code code paths; the answers are taken from toolUseResult.
    JSON.stringify({ type: 'user', uuid: 'tr', toolUseResult: { questions, answers: { '哪裡最卡？': '看不懂, 太慢', '要不要刪？': '不要' } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'The user answered: "哪裡最卡？"="看不懂, 太慢", "要不要刪？"="不要". Read the answers carefully.' }] } }),
    JSON.stringify({ type: 'user', uuid: 'tr2', toolUseResult: { stdout: 'x', answers: 'not an object' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: 'ok' }] } }),
  ].join('\n') + '\n');
  const items = H.readHistory(f).items;
  assert.deepStrictEqual(items.map((i) => i.role), ['user', 'assistant', 'ask', 'answered']);
  assert.deepStrictEqual(items[2].questions[0], { question: '哪裡最卡？', header: '最卡的事', multiSelect: true, options: [{ label: '看不懂', description: '約 25 次' }, { label: '太慢', description: '' }] });
  assert.deepStrictEqual(items[3].answers, [{ question: '哪裡最卡？', answer: '看不懂, 太慢' }, { question: '要不要刪？', answer: '不要' }]);
  assert.deepStrictEqual(H.questionsOf({ questions: [{ nope: 1 }, null, { question: '' }] }), []);   // nothing usable: stays an ordinary tool call

  // In a conversation the board runs, the same form arrives as a request and is answered by adding the choices.
  const log = [];
  const ch = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const c = ch.create(d);
  const res = listener();
  ch.subscribe(c.sessionId, res);
  ch.send(c.sessionId, 'x');
  const p = log[0].p;
  p.out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions } }] } });
  p.out({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } });
  const ev = res.events.find((e) => e.type === 'permission');
  assert.deepStrictEqual([ev.tool, ev.questions.length, ev.questions[1].options.map((o) => o.label)], ['AskUserQuestion', 2, ['要', '不要']]);
  assert.strictEqual(res.events.some((e) => e.type === 'tool'), false);     // not also folded away as a tool line
  assert.strictEqual(ch.status(c), 'waiting');
  assert.deepStrictEqual(ch.answer(c.sessionId, 'q1', true, {}), { ok: false, error: '沒有收到任何回答' });
  assert.deepStrictEqual(ch.answer(c.sessionId, 'q1', true, { '哪裡最卡？': '看不懂, 太慢', '要不要刪？': ' 不要 ', '沒問過的題': 'x' }), { ok: true });
  assert.deepStrictEqual(p.stdin.written[1].response.response, { behavior: 'allow', updatedInput: { questions, answers: { '哪裡最卡？': '看不懂, 太慢', '要不要刪？': '不要' } } });
  ch.shutdown();
});

test('Channels: the reply is passed on as it is written, and a subagent is not mistaken for the reply', () => {
  const d = tmp();
  const log = [];
  const ch = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const c = ch.create(d);
  const res = listener();
  ch.subscribe(c.sessionId, res);
  ch.send(c.sessionId, 'x');
  assert.ok(log[0].args.includes('--include-partial-messages'));
  assert.ok(log[0].args.includes('--chrome'), 'Claude in Chrome on, as in a terminal (2026-11-21)');
  const p = log[0].p;
  const se = (event, parent) => p.out({ type: 'stream_event', parent_tool_use_id: parent || null, event });
  se({ type: 'message_start', message: {} });
  se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } });
  se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '台北是' } });
  se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '首都' } });
  se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '子代理在講話' } }, 'toolu_1');
  p.out({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: '子代理的整段話' }] } });
  p.out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '台北是首都' }] } });
  p.out({ type: 'result', is_error: false });
  const got = res.events.filter((e) => e.type !== 'state' && e.type !== 'tasks' && e.type !== 'shell' && e.type !== 'unsent' && e.type !== 'user');
  assert.deepStrictEqual(got, [
    { type: 'thinking' },
    { type: 'delta', text: '台北是' },
    { type: 'delta', text: '首都' },
    { type: 'assistant', text: '台北是首都' },
    { type: 'result', isError: false, text: '' },
  ]);
  ch.shutdown();
});

test('background work: the turn ending is not "idle", the process is kept, and Claude waking by itself is seen', () => {
  const d = tmp();
  const log = [];
  const ch = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null, wakeGraceMs: 0 });
  const c = ch.create(d);
  const res = listener();
  ch.subscribe(c.sessionId, res);
  ch.send(c.sessionId, '跑測試');
  const p = log[0].p;
  const sys = (subtype, o) => p.out(Object.assign({ type: 'system', subtype }, o));
  sys('task_started', { task_id: 'agent1', task_type: 'local_agent', subagent_type: 'qa-engineer', description: '跑整合測試', is_backgrounded: true });
  sys('task_started', { task_id: 'bash1', task_type: 'local_bash', description: '背景建置', is_backgrounded: true });
  sys('task_started', { task_id: 'inner', task_type: 'local_bash', description: '子代理自己的指令', owned_by_subagent: true, parent_task_id: 'agent1' });
  sys('task_progress', { task_id: 'agent1', last_tool_name: 'Bash', usage: { tool_uses: 3 } });
  assert.deepStrictEqual(ch._taskList(c).map((t) => [t.id, t.kind, t.name, t.description, t.lastTool, t.toolUses]),
    [['agent1', 'agent', 'qa-engineer', '跑整合測試', 'Bash', 3], ['bash1', 'command', '', '背景建置', '', 0]]);   // the subagent's own command is not listed
  p.out({ type: 'assistant', message: { content: [{ type: 'text', text: '測試在背景跑，跑完回報' }] } });
  p.out({ type: 'result', is_error: false, total_cost_usd: 0.5, modelUsage: { 'm-x': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, contextWindow: 1000000 } } });
  assert.strictEqual(ch.status(c), 'background');                // not idle
  assert.deepStrictEqual(ch.active().map((a) => [a.status, a.tasks]), [['background', 2]]);   // stopping the board now would lose work
  c.lastActivity = Date.now() - 3600000;
  ch._reap();
  assert.strictEqual(p.killed, undefined);                       // an hour of silence does not end a process with work running
  assert.deepStrictEqual(ch.send(c.sessionId, '順便問一下').ok, true);   // you can still talk to it
  p.out({ type: 'result', is_error: false, total_cost_usd: 0.6 });

  sys('task_notification', { task_id: 'agent1', status: 'completed' });
  sys('background_tasks_changed', { tasks: [{ task_id: 'bash1', task_type: 'local_bash', description: '背景建置' }] });
  assert.deepStrictEqual(ch._taskList(c).filter((t) => !t.done).map((t) => t.id), ['bash1']);   // still running; the finished subagent stays listed as done for a while
  // The finished subagent wakes the conversation: a turn starts with no message from you.
  sys('init', {});
  assert.strictEqual(ch.status(c), 'busy');
  p.out({ type: 'assistant', message: { content: [{ type: 'text', text: '子代理回來了' }] } });
  p.out({ type: 'result', is_error: false, total_cost_usd: 0.9 });
  assert.strictEqual(ch.status(c), 'background');                // the build is still going
  sys('task_updated', { task_id: 'bash1', patch: { status: 'completed' } });
  sys('background_tasks_changed', { tasks: [] });
  assert.strictEqual(ch.status(c), 'idle');
  assert.deepStrictEqual(ch.active(), []);
  // How many were running, each time the page was told (told again when one moves from running to done).
  const running = res.events.filter((e) => e.type === 'tasks').map((e) => e.tasks.filter((t) => !t.done).length);
  assert.deepStrictEqual(running.filter((n, i) => i === 0 || n !== running[i - 1]), [0, 1, 2, 1, 0]);

  // With the default grace, the moment between "last task ended" and "Claude starts reporting it" still counts as background.
  const g = new Channels(path.join(d, 'g.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const gc = g.create(d);
  g.send(gc.sessionId, 'x');
  const gp = log[log.length - 1].p;
  gp.out({ type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_bash', description: 'd', is_backgrounded: true });
  gp.out({ type: 'result', is_error: false });
  gp.out({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
  assert.deepStrictEqual([g._taskList(gc).filter((t) => !t.done).length, g.status(gc)], [0, 'background']);
  gc.wakeUntil = Date.now() - 1;
  assert.strictEqual(g.status(gc), 'idle');
  g.shutdown();

  // What a result says it cost is not added up: a resumed process says everything before it again.
  assert.strictEqual(c.cost, undefined);
  assert.strictEqual(ch.modelWindows['m-x'], 1000000);
  const again = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  assert.strictEqual(again.modelWindows['m-x'], 1000000);
  ch.shutdown(); again.shutdown();
});

test('quota: read from the one file cc-statusline keeps', () => {
  const Q = require('../lib/quota'), d = tmp(), a = path.join(d, 'account.json'), now = 1_800_000_000_000, sec = now / 1000, w = (pct, inSec) => ({ used_percentage: pct, resets_at: sec + inSec });
  const read = (o, at = now) => { fs.writeFileSync(a, typeof o === 'string' ? o : JSON.stringify(o)); return Q.readQuota(a, at); };
  assert.deepStrictEqual(read({ v: 1, at: now - 60000, five_hour: w(1.4, 3600), seven_day: w(34, 345600) }), { fiveHour: { pct: 1, resetsAt: (sec + 3600) * 1000 }, sevenDay: { pct: 34, resetsAt: (sec + 345600) * 1000 }, seenAt: now - 60000, from: 'asked' });
  // no such limit; the limit with no window running; one that is over
  const q = (five) => { const x = read({ v: 1, at: now, five_hour: five, seven_day: w(34, 345600) }); return [x.fiveHour, x.sevenDay.pct]; };
  assert.deepStrictEqual([q(null), q({ used_percentage: 0, resets_at: null }), q(w(50, -5)), q(w(50, 30 * 86400)), q('x')], Array(5).fill([null, 34]));
  assert.strictEqual(read({ v: 1, at: now - 5 * 86400000, five_hour: null, seven_day: w(34, 3600) }).seenAt, now - 5 * 86400000, 'old: said how old, not thrown away');
  // nothing there, half written, an account without limits, asked and never answered, a time that is not yet
  const none = { fiveHour: null, sevenDay: null, seenAt: 0, from: '' };
  assert.deepStrictEqual([Q.readQuota(path.join(d, 'x.json'), now), read('{"at":'), read('[]'), read({ v: 1, tried: now }), read({ v: 1, at: now + 3600000, seven_day: w(5, 345600) })], [none, none, none, none, none]);
  assert.strictEqual(read({ v: 1, none: true, tried: now }).from, 'none'); assert.strictEqual(read({ at: now, seven_day: w(5, 345600) }).from, '', 'no v: from before it was kept up to date');
  // which one "after the limit resets" is
  const wait = (o) => { fs.writeFileSync(a, JSON.stringify(Object.assign({ v: 1, at: now }, o))); const x = Q.waitFor(a, now); return x.error || [x.window, x.at, x.pct]; }, S7 = w(75, 172800);
  assert.deepStrictEqual([wait({ five_hour: w(97, 3600), seven_day: S7 }), wait({ five_hour: null, seven_day: S7 })], [['5h', (sec + 3600) * 1000, 97], ['7d', (sec + 172800) * 1000, 75]]);
  assert.match(wait({ five_hour: { used_percentage: 0, resets_at: null }, seven_day: S7 }), /沒有 5 小時額度在計時/); assert.match(wait({ five_hour: w(97, -5), seven_day: S7 }), /沒有 5 小時額度在計時/); assert.match(wait({ five_hour: { used_percentage: 100, resets_at: null }, seven_day: S7 }), /用完了，但查不到/);
  // the 7-day one used up: that one, whatever the 5-hour one does
  { const F7 = w(100, 172800); fs.writeFileSync(a, JSON.stringify({ v: 1, at: now, five_hour: w(3, 3600), seven_day: F7 })); assert.deepStrictEqual(Q.waitFor(a, now), { window: '7d', at: (sec + 172800) * 1000, pct: 100, full: true }); assert.deepStrictEqual([wait({ five_hour: { used_percentage: 0, resets_at: null }, seven_day: F7 }), wait({ five_hour: w(3, 3600), seven_day: w(100, -5) })], [['7d', (sec + 172800) * 1000, 100], ['5h', (sec + 3600) * 1000, 3]]); assert.match(wait({ five_hour: w(3, 3600), seven_day: { used_percentage: 100, resets_at: null } }), /7 天額度用完了，但查不到/); }
  assert.match(wait({ five_hour: null, seven_day: { used_percentage: 0, resets_at: null } }), /沒有 7 天額度在計時/); assert.match(wait({ five_hour: null, seven_day: w(100, -5) }), /沒有 7 天額度在計時/); assert.match(wait({ at: now - 2 * 86400000, five_hour: null, seven_day: w(75, -5) }), /太舊/); assert.match(wait({ at: now - 10 * 86400000, five_hour: w(75, -5), seven_day: w(75, -5) }), /太舊/); assert.match(wait({ five_hour: 'x', seven_day: S7 }), /格式不認得/); assert.match(wait({ five_hour: null, seven_day: null }), /沒有可以等的/); assert.match(wait({ at: undefined, none: true }), /沒有額度限制/); assert.match(Q.waitFor(path.join(d, 'x.json'), now).error, /需要 cc-statusline/);
});

test('the board gathers no limits itself: nothing is started to ask, what a conversation reports is not kept', () => {
  for (const f of ['server.js', 'lib/chat.js', 'lib/quota.js']) assert.ok(!/get_usage|quotaSnap|rate_limit_event|SNAPSHOT_FILE|'rate-limit-snapshots\.json'/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f);
});

test('commandsFor asks Claude Code about the folder itself, once, and keeps the answer', async () => {
  const d = tmp();
  const log = [];
  const ch = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const a = ch.commandsFor('C:\\W\\Proj');
  const b = ch.commandsFor('c:\\w\\proj');           // same folder, asked again while the first is in flight
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].opts.cwd, 'C:\\W\\Proj');
  assert.deepStrictEqual(log[0].p.stdin.written[0], { type: 'control_request', request_id: 'commands', request: { subtype: 'initialize' } });
  assert.strictEqual(log[0].p.stdin.written.length, 1);   // no user message: no turn is run
  log[0].p.out({ type: 'system', subtype: 'hook_started' });
  log[0].p.out({ type: 'control_response', response: { subtype: 'success', request_id: 'commands', response: { commands: [{ name: 'harness:init', description: '裝 harness', argumentHint: '[dir]' }, { name: '' }, { nope: 1 }, { name: 'clear' }] } } });
  const want = [{ name: 'harness:init', description: '裝 harness', argumentHint: '[dir]' }, { name: 'clear', description: '', argumentHint: '' }];
  assert.deepStrictEqual((await a).commands, want);
  assert.deepStrictEqual((await b).commands, want);
  assert.strictEqual(log[0].p.killed, true);          // the helper process is ended once it has answered
  assert.deepStrictEqual((await ch.commandsFor('C:\\w\\proj')).commands, want);
  assert.strictEqual(log.length, 1);                  // answered from memory

  // A different folder is asked separately, and a failure there says so instead of borrowing the other list.
  const c = ch.commandsFor('D:\\other');
  assert.strictEqual(log.length, 2);
  log[1].p.emit('exit', 1);
  const r = await c;
  assert.deepStrictEqual(r.commands, []);
  assert.ok(r.error);
  ch.shutdown();
});

test('terminalArgs resumes a conversation that has history and starts one that has none', WIN_ONLY, () => {
  const { terminalArgs } = require('../server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-launch-'));
  const sid = '11111111-2222-3333-4444-555555555555';
  const a = terminalArgs(sid, 'C:\\w', true, 'claude --flag "a b"', dir);
  assert.deepStrictEqual(a.slice(0, 6), ['-w', 'new', '-d', 'C:\\w', 'cmd', '/k']);
  assert.match(fs.readFileSync(a[6], 'utf8'), /\r\nclaude --flag "a b" --resume 11111111-2222-3333-4444-555555555555\r\n$/);
  const b = terminalArgs(sid, 'C:\\w', false, undefined, dir);
  assert.match(fs.readFileSync(b[6], 'utf8'), /\r\nclaude --session-id 11111111-2222-3333-4444-555555555555\r\n$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSessions lists board conversations with or without a running process', () => {
  const d = tmp();
  const o = { sessionsDir: path.join(d, 's'), projectsDir: path.join(d, 'p'), stateDir: path.join(d, 'st'), legacyStateDir: path.join(d, 'l'), pidAlive: () => true };
  for (const k of ['sessionsDir', 'projectsDir', 'stateDir', 'legacyStateDir']) fs.mkdirSync(o[k], { recursive: true });
  const now = 1_800_000_000_000;
  const A = 'aaaaaaaa-0000-0000-0000-00000000000a', B = 'bbbbbbbb-0000-0000-0000-00000000000b', T = 'cccccccc-0000-0000-0000-00000000000c';
  // A has a live process, so the registry lists it too (as some non-interactive kind): it must appear once, as the board's.
  fs.writeFileSync(path.join(o.sessionsDir, '1.json'), JSON.stringify({ pid: 1, sessionId: A, cwd: d, kind: 'sdk', status: 'idle', statusUpdatedAt: now - 9e6 }));
  fs.writeFileSync(path.join(o.sessionsDir, '2.json'), JSON.stringify({ pid: 2, sessionId: T, cwd: d, kind: 'interactive', status: 'busy', statusUpdatedAt: now - 1000 }));
  o.channels = [
    { sessionId: A, cwd: d, title: '甲', status: 'busy', since: now - 5000, unread: false },
    { sessionId: B, cwd: d, title: '', status: 'idle', since: now - 6000, unread: true },
  ];
  const list = S.buildSessions(o, now);
  assert.strictEqual(list.length, 3);
  const a = list.find((s) => s.sessionId === A), b = list.find((s) => s.sessionId === B), t = list.find((s) => s.sessionId === T);
  assert.deepStrictEqual([a.owner, a.kind, a.status, a.group, a.title], ['board', 'board', 'busy', 'running', '甲']);
  assert.deepStrictEqual([b.owner, b.status, b.group, b.title], ['board', 'idle', 'yours', '新對話']);
  assert.deepStrictEqual([t.owner, t.kind, t.group], ['terminal', 'interactive', 'running']);
  o.channels[1].unread = false;
  assert.strictEqual(S.buildSessions(o, now).find((s) => s.sessionId === B).group, 'quiet');
});

test('messages can be sent at any time, and go to Claude Code at once: while it works, and while a card is open', () => {
  const d = tmp();
  const log = [];
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const c = ch.create(d);
  const res = listener();
  ch.subscribe(c.sessionId, res);
  const sentToClaude = () => log[0].p.stdin.written.filter((w) => w.type === 'user').map((w) => w.message.content[0].text);

  assert.deepStrictEqual(ch.send(c.sessionId, '第一件'), { ok: true, queued: false, mid: false });
  const p = log[0].p;
  p.out({ type: 'assistant', message: { content: [{ type: 'text', text: '做到一半' }] } });
  // while it works: not held back - Claude Code reads it when the action in hand is done, in this same turn
  assert.deepStrictEqual(ch.send(c.sessionId, '第二件'), { ok: true, queued: false, mid: true });
  assert.deepStrictEqual([sentToClaude(), (c.queue || []).length, ch.status(c)], [['第一件', '第二件'], 0, 'busy']);
  // an approval opens: a message sent now goes in as well, and the card is still there to be answered
  p.out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  assert.strictEqual(ch.status(c), 'waiting');
  assert.deepStrictEqual(ch.send(c.sessionId, '第三件'), { ok: true, queued: false, mid: true });
  assert.deepStrictEqual([sentToClaude(), c.pending.size], [['第一件', '第二件', '第三件'], 1]);
  ch.answer(c.sessionId, 'r1', true);
  p.out({ type: 'result', is_error: false, result: '做完' });
  assert.deepStrictEqual([ch.status(c), sentToClaude().length, log.length], ['idle', 3, 1]);   // one turn, one process, nothing sent a second time
  assert.deepStrictEqual(ch.send(c.sessionId, '第四件'), { ok: true, queued: false, mid: false });   // between turns: an ordinary message
  assert.strictEqual(res.events.filter((e) => e.type === 'queue').length, 0);    // the board holds nothing back: there is no queue
  assert.strictEqual(ch.stop(c.sessionId), true);
  assert.strictEqual(typeof ch.unqueue, 'undefined'); assert.strictEqual(typeof ch.dropped, 'undefined');
});

test('a background command can be looked at: its command line and where its output goes, while it runs and for a while after', () => {
  const d = tmp();
  const log = [];
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn(log), transcriptOf: () => null, wakeGraceMs: 0 });
  const c = ch.create(d);
  ch.send(c.sessionId, '分析當掉的紀錄');
  const p = log[0].p;
  const out = path.join(d, 'tasks', 'b1.output');
  p.out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cdb -z game.dmp -c "!analyze -v; q"', description: 'Analyze the dump', run_in_background: true } }] } });
  p.out({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1', description: 'Analyze the dump', is_backgrounded: true, task_type: 'local_bash' });
  assert.deepStrictEqual(ch._taskList(c).map((t) => [t.id, t.done, t.canOpen]), [['b1', false, false]]);   // where its output goes is not known yet
  p.out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Command running in background with ID: b1. Output is being written to: ' + out + '. Use the output tool to read it.' }] } });
  assert.deepStrictEqual(ch._taskList(c).map((t) => [t.id, t.done, t.canOpen]), [['b1', false, true]]);
  let info = ch.taskInfo(c.sessionId, 'b1');
  assert.deepStrictEqual([info.command, info.path, info.running, info.description], ['cdb -z game.dmp -c "!analyze -v; q"', out, true, 'Analyze the dump']);
  // A subagent is listed too, but has no output file to open.
  p.out({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'toolu_2', description: '查文件', task_type: 'local_agent', subagent_type: 'Explore' });
  assert.deepStrictEqual(ch._taskList(c).find((t) => t.id === 'a1').canOpen, false);
  p.out({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
  // It ends: no longer running, still listed, still readable, with how it ended.
  p.out({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } });
  p.out({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_1', status: 'completed', output_file: out, summary: 'Background command "Analyze the dump" completed (exit code 0)' });
  assert.strictEqual(c.tasks.size, 0);
  assert.deepStrictEqual(ch._taskList(c).map((t) => [t.id, t.done, t.status, t.canOpen]), [['b1', true, 'completed', true], ['a1', true, 'completed', false]]);
  info = ch.taskInfo(c.sessionId, 'b1');
  assert.deepStrictEqual([info.running, info.status, info.summary, info.path], [false, 'completed', 'Background command "Analyze the dump" completed (exit code 0)', out]);
  assert.strictEqual(ch.taskInfo(c.sessionId, 'nope'), null);
  assert.strictEqual(ch.taskInfo('no-such-conversation', 'b1'), null);
  // Ten minutes on it is gone from the list.
  c.doneTasks.forEach((t) => { t.endedAt -= 11 * 60000; });
  assert.deepStrictEqual(ch._taskList(c), []);
  assert.strictEqual(ch.taskInfo(c.sessionId, 'b1'), null);
  ch.shutdown();
});

test('a conversation nothing was said in can be taken off again; one with anything in it cannot', () => {
  const d = tmp();
  const log = [];
  let transcript = null;
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn(log), transcriptOf: () => transcript });
  const empty = ch.create(d);
  assert.strictEqual(ch.removeIfEmpty(empty.sessionId), true);
  assert.strictEqual(ch.get(empty.sessionId), null);
  assert.strictEqual(ch.removeIfEmpty('no-such'), false);
  // Something was sent: it has a title and a process.
  const used = ch.create(d);
  ch.send(used.sessionId, '你好');
  assert.strictEqual(ch.removeIfEmpty(used.sessionId), false);
  log[0].p.out({ type: 'result', is_error: false });
  ch.stop(used.sessionId);
  assert.strictEqual(ch.removeIfEmpty(used.sessionId), false);                  // stopped, but it was talked in
  // A conversation brought onto the board from elsewhere: nothing sent from here, but it has a record.
  const moved = ch.create(d, '12345678-aaaa-bbbb-cccc-000000000000');
  transcript = 'x.jsonl';
  assert.strictEqual(ch.removeIfEmpty(moved.sessionId), false);
  assert.strictEqual(ch.list().length, 2);
  ch.shutdown();
});

test('a conversation with a fixed name is started under it every time; a kept one is not ended when quiet, and is started again without a message', () => {
  const d = tmp();
  const log = [];
  let keep = true;
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn(log), transcriptOf: () => null, codeOf: (sid) => (sid === a.sessionId ? 'S1-A' : ''), keepAlive: (sid) => keep && sid === a.sessionId });
  const a = ch.create(d), b = ch.create(d);
  ch.send(a.sessionId, '你好'); ch.send(b.sessionId, '你好');
  const nameOf = (x) => (x.args.includes('--name') ? x.args[x.args.indexOf('--name') + 1] : '');
  assert.deepStrictEqual(log.map(nameOf), ['S1-A', '']);
  for (const x of log) x.p.out({ type: 'result', is_error: false, total_cost_usd: 0.1 });
  const old = Date.now() - 3600000; a.lastActivity = b.lastActivity = old;
  const ended = []; for (const x of log) x.p.stdin.end = () => ended.push(x);
  ch._reap();
  assert.deepStrictEqual(ended.map(nameOf), [''], 'only the one that is not kept');
  ch.stop(a.sessionId);
  ch._reap();
  assert.deepStrictEqual([log.length, nameOf(log[2]), log[2].p.stdin.written.length, ch.status(a)], [3, 'S1-A', 0, 'idle'], 'started again under its name, nothing sent, no turn');
  ch.stop(a.sessionId); ch._reap();
  assert.strictEqual(log.length, 3, 'not again within a few minutes');
  { const n = log.length; ch.wake(a.sessionId); }   // (nothing: woken a moment ago)
  a.lastResultAt = 1;   // (the clock below is moved by hand)
  a.wokenAt -= 6 * 60000; ch._reap(); a.proc = null;   // ended by itself
  a.wokenAt -= 6 * 60000; ch._reap();
  assert.strictEqual(log.length, 4, 'woken in vain twice: the wait grows');
  a.wokenAt -= 60 * 60000; keep = false; ch._reap();
  assert.strictEqual(log.length, 4, 'nor once it is not kept');
  ch.shutdown();
});

test('a conversation that has not started is forgotten once no page has it open; one that started, or is being looked at, stays', () => {
  const d = tmp();
  const log = [];
  let transcript = null;
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn(log), transcriptOf: () => transcript });
  const old = ch.create(d), fresh = ch.create(d), watched = ch.create(d), used = ch.create(d);
  old.createdAt = watched.createdAt = used.createdAt = Date.now() - 17 * 3600 * 1000;       // 17 hours, as the one that was found in the list
  watched.listeners.add(() => {});                                                          // a page has it open: someone may be typing the first message
  ch.send(used.sessionId, '你好');
  assert.deepStrictEqual([old, fresh, watched, used].map((c) => ch.isEmpty(c)), [true, true, true, false]);
  ch._reap();
  assert.deepStrictEqual([old, fresh, watched, used].map((c) => ch.has(c.sessionId)), [false, true, true, true]);
  // It does not come back with the next start of the board either.
  const again = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn([]), transcriptOf: () => transcript });
  assert.strictEqual(again.has(old.sessionId), false);
  ch.shutdown(); again.shutdown();
});

test('Channels: a conversation can be given a role before anything is said, and is then started and carried on as it', () => {
  const d = tmp(), home = tmp(), log = [];
  fs.mkdirSync(path.join(d, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'agents', 'qa-engineer.md'), '---\nname: qa-engineer\ndescription: "設計測試案例並驗證功能"\n---\n本文裡的 description: 不算\n');
  fs.writeFileSync(path.join(d, '.claude', 'agents', 'notes.txt'), 'not a role');
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'writer.md'), 'x');
  let has = false;
  const file = path.join(d, 'c.json');
  const ch = new Channels(file, { spawn: fakeSpawn(log), transcriptOf: () => (has ? 'x' : null), homeDir: home });
  // what each is for: the description line at the top of its role file; a file without one has none
  assert.deepStrictEqual(ch.roles(d), [{ name: 'qa-engineer', from: 'project', desc: '設計測試案例並驗證功能' }, { name: 'writer', from: 'user', desc: '' }]);
  const c = ch.create(d);
  assert.strictEqual(ch.setAgent(c.sessionId, 'no-such-role').ok, false);                    // not a role of this folder
  assert.strictEqual(ch.setAgent(c.sessionId, '--dangerously-skip-permissions').ok, false);  // nor anything that is not a role's name
  assert.deepStrictEqual(ch.setAgent(c.sessionId, 'qa-engineer'), { ok: true, agent: 'qa-engineer' });
  ch.send(c.sessionId, '測這一頁');
  assert.deepStrictEqual(log[0].args.slice(-4), ['--session-id', c.sessionId, '--agent', 'qa-engineer']);
  // What Claude Code says the folder has is remembered: a plugin's roles are learned this way; built-in helpers are not offered.
  log[0].p.out({ type: 'system', subtype: 'init', agents: ['claude', 'Explore', 'qa-engineer', 'codex:codex-rescue'] });
  assert.deepStrictEqual(ch.roles(d).map((r) => r.name + ':' + r.from), ['qa-engineer:project', 'writer:user', 'codex:codex-rescue:plugin']);
  assert.strictEqual(ch.setAgent(c.sessionId, '').ok, false);                                 // begun: the role stays
  // Carried on later, by a board that was restarted: still as that role.
  log[0].p.kill(); has = true;
  const again = new Channels(file, { spawn: fakeSpawn(log), transcriptOf: () => 'x', homeDir: home });
  again.send(c.sessionId, '再測一頁');
  assert.deepStrictEqual(log[1].args.slice(-4), ['--resume', c.sessionId, '--agent', 'qa-engineer']);
  assert.deepStrictEqual(again.roles(d).map((r) => r.name), ['qa-engineer', 'writer', 'codex:codex-rescue']);
});

test('pictures go with their message: handed to Claude Code as image blocks before the text, also while it works', () => {
  const d = tmp();
  const log = [];
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const c = ch.create(d);
  const pic = { mime: 'image/png', data: 'AAAA' };
  assert.deepStrictEqual(ch.send(c.sessionId, '看這張', [pic]), { ok: true, queued: false, mid: false });
  const users = () => log[0].p.stdin.written.filter((w) => w.type === 'user').map((w) => w.message.content);
  assert.deepStrictEqual(users()[0], [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: '看這張' }]);
  assert.strictEqual(ch.send(c.sessionId, '', [pic, pic]).mid, true);                   // while it works: handed over at once
  assert.deepStrictEqual(users()[1].map((b) => b.type), ['image', 'image']);            // pictures only: no empty text block is added
  // a conversation whose first message is only a picture still gets a name
  const c2 = ch.create(d); ch.send(c2.sessionId, '', [pic]);
  assert.strictEqual(c2.title, '（圖片）');
});

test('a picture stands where its mark is in the text: the text up to the mark, the picture, then the rest', () => {
  const { contentOf } = require('../lib/chat');
  const A = { mime: 'image/png', data: 'AAAA', tag: 1 }, B = { mime: 'image/jpeg', data: 'BBBB', tag: 2 }, C = { mime: 'image/png', data: 'CCCC' };
  const shape = (c) => c.map((b) => (b.type === 'text' ? JSON.stringify(b.text) : '<' + b.source.data + '>')).join(' ');
  assert.strictEqual(shape(contentOf('第五點如下［圖1］\n第六點如下［圖2］\n請照改', [A, B])), '"第五點如下［圖1］" <AAAA> "\\n第六點如下［圖2］" <BBBB> "\\n請照改"');
  assert.strictEqual(shape(contentOf('先看第二張［圖2］再看第一張［圖1］', [A, B])), '"先看第二張［圖2］" <BBBB> "再看第一張［圖1］" <AAAA>');   // by the text, not by the order attached
  assert.strictEqual(shape(contentOf('看這張［圖1］', [C, A])), '<CCCC> "看這張［圖1］" <AAAA>');                    // one with no place comes first
  assert.strictEqual(shape(contentOf('記號被刪掉了', [A, B])), '<AAAA> <BBBB> "記號被刪掉了"');                   // its mark deleted: first, as before
  assert.strictEqual(shape(contentOf('［圖1］跟［圖1］', [A])), '"［圖1］" <AAAA> "跟［圖1］"');                    // a mark written twice: at the first
  assert.strictEqual(shape(contentOf('只有字，寫了［圖3］也沒有那張圖', [])), '"只有字，寫了［圖3］也沒有那張圖"');
  assert.strictEqual(shape(contentOf('［圖1］', [A])), '"［圖1］" <AAAA>');
  assert.strictEqual(shape(contentOf('', [C])), '<CCCC>');
  // read back from the transcript: the pieces are one text again, the pictures located
  const H = require('../lib/history');
  const it = H.itemsOf({ type: 'user', uuid: 'aaaaaaaa-1111-2222-3333-444444444444', message: { content: contentOf('第五點如下［圖1］\n第六點如下［圖2］\n請照改', [A, B]) } })[0];
  assert.deepStrictEqual([it.text, it.imgAt], ['第五點如下［圖1］\n第六點如下［圖2］\n請照改', [1, 3]]);
});

test('Channels: a conversation switched to another model runs on it from its next message, and remembers it', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-model-')); const file = path.join(d, 'c.json'); const log = [];
  const ch = new Channels(file, { spawn: fakeSpawn(log), transcriptOf: () => 'x' });
  const c = ch.create(d);
  ch.send(c.sessionId, '第一句');
  assert.ok(!log[0].args.includes('--model'), 'Claude Code\'s own default at first');
  assert.deepStrictEqual(ch.setModel(c.sessionId, 'opus'), { ok: false, error: '它還在執行' }, 'not in the middle of a turn');
  log[0].p.out({ type: 'result', is_error: false });
  assert.deepStrictEqual(ch.setModel(c.sessionId, 'opus'), { ok: true });
  assert.deepStrictEqual([c.proc, log[0].p.killed], [null, true], 'the process started on the old model is ended');
  ch.send(c.sessionId, '第二句');
  assert.strictEqual(log.length, 2); const a = log[1].args; assert.strictEqual(a[a.indexOf('--model') + 1], 'opus');
  // effort as well, alone: the model stays
  log[1].p.out({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: 'auto' }); log[1].p.out({ type: 'result', is_error: false });
  assert.strictEqual(c.modelSeen, 'claude-opus-5-5', 'the model its process says it runs on');
  assert.deepStrictEqual(ch.setModel(c.sessionId, undefined, 'high'), { ok: true });
  ch.send(c.sessionId, '第三句'); const a3 = log[2].args;
  assert.deepStrictEqual([a3[a3.indexOf('--model') + 1], a3[a3.indexOf('--effort') + 1]], ['opus', 'high']);
  log[2].p.out({ type: 'result', is_error: false });
  ch.setModel(c.sessionId, undefined, 'bogus'); assert.strictEqual(c.effort, '', 'an effort Claude Code does not know is dropped');
  const again = new Channels(file, { spawn: fakeSpawn(log), transcriptOf: () => 'x' });
  assert.strictEqual(again.get(c.sessionId).model, 'opus', 'kept across a restart of the board');
  ch.shutdown(); again.shutdown(); fs.rmSync(d, { recursive: true, force: true });
});

test('a slash command you ran is shown as you said it (it was dropped with the harness tags); the board\'s own /rename is not', () => {
  const u = (content, uuid = 'c1') => ({ type: 'user', uuid, timestamp: '2026-11-19T11:10:03.315Z', message: { content } });
  // as Claude Code writes it (seen 2026-11-19 for the 「寫交付訊息」 button)
  assert.deepStrictEqual(H.itemsOf(u('<command-message>deliver-report:deliver-report</command-message>\n<command-name>/deliver-report:deliver-report</command-name>')).map((i) => [i.role, i.text]), [['user', '/deliver-report:deliver-report']]);
  // with its words, in either order
  assert.deepStrictEqual(H.itemsOf(u('<command-name>/harness:review</command-name>\n<command-message>harness:review</command-message>\n<command-args>只看 A 檔</command-args>')).map((i) => i.text), ['/harness:review 只看 A 檔']);
  assert.deepStrictEqual(H.itemsOf(u('<command-args>x y</command-args><command-name>/model</command-name>')).map((i) => i.text), ['/model x y']);
  assert.deepStrictEqual(H.itemsOf(u([{ type: 'text', text: '<command-name>/rename</command-name><command-args>合作3-ALPHA</command-args>' }])), []);
  // what a command printed, the skill's own text (isMeta) and the other harness tags stay out
  assert.deepStrictEqual(H.itemsOf(u('<local-command-stdout>✓ Installed</local-command-stdout>')), []);
  assert.deepStrictEqual(H.itemsOf(Object.assign(u([{ type: 'text', text: 'Base directory for this skill: …' }]), { isMeta: true })), []);
  // the name mentioned in the middle of what you typed is just text
  assert.deepStrictEqual(H.itemsOf(u('請看 <command-name>/x</command-name> 這段')).map((i) => i.text), ['請看 <command-name>/x</command-name> 這段']);
});

test('Channels: what is said in a conversation is told to the pages showing it, with the id of the page that said it', () => {
  // (asked 2026-11-21: a message the board itself sent - a room's 處理, a schedule - was not shown until a reload)
  const d = tmp();
  const log = [];
  const ch = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const c = ch.create(d);
  const res = listener();
  ch.subscribe(c.sessionId, res);
  ch.send(c.sessionId, '這個資料夾有 8 個檔沒 commit');
  ch.send(c.sessionId, '從頁面送的', [{ mime: 'image/png', data: 'AAAA' }], 'abc123');
  const said = res.events.filter((e) => e.type === 'user');
  assert.deepStrictEqual(said, [{ type: 'user', text: '這個資料夾有 8 個檔沒 commit', images: 0, echo: '' }, { type: 'user', text: '從頁面送的', images: 1, echo: 'abc123' }]);
  assert.deepStrictEqual(ch.send('no-such', 'x'), { ok: false, error: 'no such channel' });
  ch.shutdown();
});

test('Channels: a message still queued when its turn is stopped is kept - never taken for said (2026-11-23)', async () => {
  const d = tmp(), log = [], f = path.join(d, 't.jsonl');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const make = () => new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => (fs.existsSync(f) ? f : null), settleMs: 5 });
  const rec = (o) => fs.appendFileSync(f, JSON.stringify(o) + '\n');
  const said = (text) => rec({ type: 'user', uuid: 'u', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } });
  const queued = (text) => rec({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text }] } });
  let ch = make();
  const c = ch.create(d), res = listener();
  ch.subscribe(c.sessionId, res);
  const list = () => res.events.filter((e) => e.type === 'unsent').pop().list;
  // three said: the first is the turn's own, the second is read while it works, the third is still waiting when it is stopped
  ch.send(c.sessionId, '第一件'); said('第一件');
  ch.send(c.sessionId, '第二件'); queued('第二件');
  ch.send(c.sessionId, '第三件', [{ mime: 'image/png', data: 'AAAA' }]);
  ch.send(c.sessionId, '/compact');   // a command is recorded in another form: not followed
  rec({ type: 'user', isMeta: true, message: { role: 'user', content: '第三件' } });   // not something you said
  rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '第三件' }] } });
  ch.stop(c.sessionId); await wait(60);
  assert.deepStrictEqual(list().map((x) => [x.text, x.images, x.kept]), [['第三件', 1, true]]);
  // the same words said earlier do not make a later message one that was read
  ch.send(c.sessionId, '第一件'); ch.stop(c.sessionId); await wait(60);
  assert.deepStrictEqual(list().map((x) => x.text), ['第三件', '第一件']);
  // sent again, changed: it goes to Claude with its picture, and is off the list; pressed twice, once
  const id = list()[0].id, before = log.length;
  assert.deepStrictEqual(ch.unsent(c.sessionId, id, 'resend', '第三件改'), { ok: true });
  assert.strictEqual(ch.unsent(c.sessionId, id, 'resend').ok, false);
  const w = log[log.length - 1].p.stdin.written.filter((x) => x.type === 'user').pop().message.content;
  assert.deepStrictEqual([log.length > before, w.some((b) => b.type === 'image'), w.filter((b) => b.type === 'text').map((b) => b.text).join('')], [true, true, '第三件改']);
  assert.deepStrictEqual(list().map((x) => x.text), ['第一件']);
  // that one is read; the turn ends by itself: nothing is called lost
  said('第三件改'); log[log.length - 1].p.out({ type: 'result', is_error: false, result: 'ok' }); await wait(40);
  assert.deepStrictEqual([list().map((x) => x.text), (c.said || []).length], [['第一件'], 0]);
  // thrown away
  assert.deepStrictEqual(ch.unsent(c.sessionId, list()[0].id, 'drop'), { ok: true });
  assert.deepStrictEqual([list(), ch.unsent(c.sessionId, 'x', 'drop').ok, ch.unsent('no-such', 'x', 'drop').ok], [[], false, false]);
  // a message sent right after the stop is the next process's: not called lost with the one before it
  ch.send(c.sessionId, '被停掉的'); ch.stop(c.sessionId); ch.send(c.sessionId, '停了之後說的'); await wait(60);
  assert.deepStrictEqual([list().map((x) => x.text), c.said.map((x) => x.text)], [['被停掉的'], ['停了之後說的']]);
  // the board ends while it works: told when it is started again, without the pictures (they are not written down)
  ch.send(c.sessionId, '看板關掉時還沒讀到', [{ mime: 'image/png', data: 'AAAA' }]);
  ch = make();
  const c2 = ch.get(c.sessionId);
  assert.deepStrictEqual(c2.unsent.map((x) => [x.text, x.n, !!x.images]), [['被停掉的', 0, false], ['停了之後說的', 0, false], ['看板關掉時還沒讀到', 1, false]]);
  assert.ok(!fs.readFileSync(path.join(d, 'c.json'), 'utf8').includes('AAAA'), 'the pictures are in a file of their own');
  // its picture is still there after the board was started again: sent with it, and then let go of
  const last = c2.unsent[2].id; res.events.length = 0; ch.subscribe(c.sessionId, res);
  assert.deepStrictEqual(list().map((x) => x.kept), [false, false, true]);
  ch.unsent(c.sessionId, last, 'resend');
  assert.ok(log[log.length - 1].p.stdin.written.filter((x) => x.type === 'user').pop().message.content.some((b) => b.type === 'image'));
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'unsent')).filter((n) => n.startsWith(last)), []);
  // an update of the board: not while a message is still to be taken in, also when the turn before it is over
  ch.send(c.sessionId, '排隊中', [{ mime: 'image/png', data: 'BBBB' }]);
  log[log.length - 1].p.out({ type: 'result', is_error: false, result: 'ok' });
  assert.deepStrictEqual([ch.status(c2), ch.active().length, c2.said.map((x) => x.text)], ['idle', 1, ['排隊中']]);
  queued('排隊中'); await wait(20); ch._settle(c2, null);
  assert.deepStrictEqual([ch.active().length, fs.readdirSync(path.join(d, 'unsent'))], [0, []]);
  ch.shutdown();
});

test('Channels: a long turn before the stop: what was waiting is not lost, what was read is not called lost', async () => {
  const d = tmp(), log = [], f = path.join(d, 't.jsonl'), big = (n) => fs.appendFileSync(f, JSON.stringify({ type: 'assistant', pad: 'x'.repeat(n * 1024 * 1024) }) + '\n');
  const ch = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => f, settleMs: 5 }); fs.writeFileSync(f, '');
  const c = ch.create(d); ch.send(c.sessionId, '讀到的'); big(20);
  fs.appendFileSync(f, JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: '讀到的' }] } }) + '\n'); big(17);
  ch.send(c.sessionId, '還在排'); big(40); ch.stop(c.sessionId);
  for (let i = 0; i < 200 && !(c.unsent || []).length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepStrictEqual([c.unsent.map((x) => x.text), c.said.length], [['還在排'], 0]);
  // looked at while it works: the next look starts after what was read
  ch.send(c.sessionId, '還沒讀到'); const at0 = c.said[0].from; big(1); ch._settle(c, null); assert.ok(c.said[0].from > at0);
  fs.appendFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: '還沒讀到' } }) + '\n'); ch._settle(c, null); assert.strictEqual(c.said.length, 0);
  // the transcript cannot be read: tried again, and told rather than let go of
  ch.send(c.sessionId, '讀不到紀錄'); ch.transcriptOf = () => { throw new Error('busy'); }; ch._settle(c, new Set(c.said.map((x) => x.id)), 2); assert.strictEqual(c.said.length, 1);
  for (let i = 0; i < 80 && c.said.length; i++) await new Promise((r) => setTimeout(r, 25)); assert.deepStrictEqual([c.said.length, c.unsent.slice(-1)[0].text], [0, '讀不到紀錄']);
  // the board started again: what pages hold counts from now
  ch.transcriptOf = () => f; ch.setHeld(c.sessionId, 'pageA', 1, Date.now() - 3600000); ch._save();
  const ch2 = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => f, settleMs: 5 }); assert.strictEqual(ch2.held(ch2.get(c.sessionId), 600000), 1); ch2.shutdown();
  ch.shutdown();
});

test('Channels: kept whole or not at all; what is waiting goes when its conversation does, or along with it', async () => {
  const d = tmp(), log = [], ch = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null, settleMs: 5 }), pics = () => { try { return fs.readdirSync(path.join(d, 'unsent')); } catch (e) { return []; } };
  const c = ch.create(d), long = '字'.repeat(120000), PIC = [{ mime: 'image/png', data: 'AAAA' }];
  assert.deepStrictEqual([ch.setStash(c.sessionId, long), c.stash.length], [true, 120000]);
  assert.deepStrictEqual([ch.setStash(c.sessionId, long + long), c.stash.length], [false, 120000], 'too long: said so, nothing cut');
  ch.send(c.sessionId, '還在排', PIC); const was = c.said.map((x) => x.text); ch.stop(c.sessionId); await ch.settled(c.sessionId);
  assert.deepStrictEqual([was, (c.unsent || []).map((x) => x.text), pics().length], [['還在排'], ['還在排'], 1], 'told before the conversation goes');
  c.fromHereNext = true; ch.send(c.sessionId, '一'); assert.strictEqual(c.fromHere, true); ch.send(c.sessionId, '排程送的'); assert.strictEqual(c.fromHere, false, 'this message, not the one after it');
  // sent again with what stood in front of it: Claude has both, the page shows the words
  const x = Object.assign(c.unsent[0], { pre: '<bash-input>ls</bash-input>' }); ch.unsent(c.sessionId, x.id, 'resend');
  const w = log[log.length - 1].p.stdin.written.filter((m) => m.type === 'user').pop().message.content.map((b) => b.text || '').join('');
  assert.deepStrictEqual([/<bash-input>ls<\/bash-input>還在排/.test(w), c.said[c.said.length - 1].text], [true, '還在排']);
  for (let i = 0; i < 40; i++) ch.send(c.sessionId, '第 ' + i, PIC);
  assert.deepStrictEqual([c.said.length, pics().length], [30, 30], 'one no longer kept takes its picture with it');
  ch.remove(c.sessionId); assert.deepStrictEqual(pics(), []);
  ch.shutdown();
});

test('an Artifact published is told once, with where it was asked from; a new version, a refusal, another address are not', () => {
  const { Channels } = require('../lib/chat');
  const ch = Object.create(Channels.prototype), got = [], opened = [];
  Object.assign(ch, { _emit: (c, e) => { if (e.type === 'artifact') got.push(e); }, _setState() {}, _save() {}, rolesSeen: {}, onArtifact: (c, a) => opened.push(a.url) });
  const c = { state: 'busy', pending: new Map(), fromHere: true, cwd: 'x' };
  const use = (id) => ch._onLine(c, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Artifact', input: { file_path: 'a.html' } }] } }));
  const res = (id, text, more) => ch._onLine(c, JSON.stringify(Object.assign({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!(more && more.bad) }] } }, more && more.r ? { tool_use_result: more.r } : {})));
  const say = (u) => 'Published C:\\x\\a.html at ' + u + ' (Version 1, version id 1-a)';
  use('1'); res('1', say('https://claude.ai/artifact/SsKu3gK2jnLV'), { r: { title: '表', updated: false } });
  use('2'); res('2', say('https://claude.ai/artifact/SsKu3gK2jnLV'));                       // again: open already
  use('3'); res('3', say('https://claude.ai/artifact/Another00001'), { r: { updated: true } });   // a new version of one put up earlier
  use('4'); res('4', say('https://claude.ai/artifact/Refused00001'), { bad: true });
  use('5'); res('5', say('https://evil.example/artifact/abcdefgh'));
  res('9', say('https://claude.ai/artifact/NotAsked00001'));                                     // another tool's words
  assert.deepStrictEqual(got, [{ type: 'artifact', url: 'https://claude.ai/artifact/SsKu3gK2jnLV', title: '表', here: true }]);
  assert.deepStrictEqual(opened, ['https://claude.ai/artifact/SsKu3gK2jnLV']);
});

test('a message the board sends by itself leaves your draft and what you ran with "!" for your own next message; yours clears the draft', () => {
  const d = tmp(), log = [];
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  const c = ch.create(d); ch.send(c.sessionId, '你好', undefined, '', undefined, { yours: true }); log[0].p.out({ type: 'result', is_error: false });
  c.draft = '打到一半'; c.shellNotes = [{ id: 1 }];
  assert.strictEqual(ch.send(c.sessionId, '【goal2 跑完了】run x').ok, true);   // the board's own (額度回來了, a schedule, goal2 done)
  assert.deepStrictEqual([c.draft, c.shellNotes.length], ['打到一半', 1], 'what you were typing and what you ran stay for your message');
  log[0].p.out({ type: 'result', is_error: false });
  c.shellNotes = [];
  assert.strictEqual(ch.send(c.sessionId, '我的', undefined, '', undefined, { yours: true }).ok, true);
  assert.strictEqual(c.draft, '', 'yours: what was in the box is a message now');
});

test('a command of the board\'s own (quietly) leaves your draft, what you ran and what is unread; /clear is followed; a kept process is renewed only after the old one is gone', () => {
  const d = tmp(), log = [];
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: fakeSpawn(log), transcriptOf: () => null, keepAlive: () => true, mustBypass: (s) => s === 'x' });
  const c = ch.create(d); ch.send(c.sessionId, '你好'); const p = log[0].p; p.out({ type: 'result', is_error: false });
  c.draft = '打到一半'; c.shellNotes = [{ id: 1 }]; c.lastSeenAt = c.lastResultAt = 5;
  assert.strictEqual(ch.quietly(c.sessionId, '/rename S1-a'), true); assert.strictEqual(ch.quietly(c.sessionId, 'again'), false, 'one at a time');
  p.out({ type: 'result', is_error: false });
  assert.deepStrictEqual([c.draft, c.shellNotes.length, ch.unread(c), ch.status(c)], ['打到一半', 1, false, 'idle']);
  c.shellNotes = []; const moved = [], got = []; ch.onMoved = (a, b) => moved.push([a, b]); const from = c.sessionId, to = '00000000-0000-4000-8000-0000000000aa', emit = ch._emit; ch._emit = function (x, e) { got.push(e.type); return emit.call(ch, x, e); };
  p.out({ type: 'system', subtype: 'init', session_id: to }); assert.deepStrictEqual(moved, [], 'another id without a clear: not followed');
  p.out({ type: 'conversation_reset', trigger: 'clear', session_id: from }); p.out({ type: 'system', subtype: 'hook_started', session_id: to });
  assert.deepStrictEqual([moved, ch.get(from), ch.get(to) === c, got.includes('moved')], [[[from, to]], null, true, true]);
  p.out({ type: 'result', is_error: false, session_id: to });
  // renewed: ended first, started when it has gone
  c.procAt = Date.now() - 7 * 3600000; c.lastActivity = Date.now() - 3600000; c.said = []; const n = log.length; let gone = null; p.once = (ev, f) => { if (ev === 'exit') gone = f; };
  ch._reap(); assert.deepStrictEqual([log.length, c.proc], [n, null]); gone(); assert.strictEqual(log.length, n + 1);
  ch.shutdown();
});
