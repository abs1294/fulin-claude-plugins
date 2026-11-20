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

  assert.deepStrictEqual(res.events.filter((e) => e.type !== 'tasks' && e.type !== 'shell').map((e) => e.type), ['state', 'state', 'tool', 'permission', 'state', 'permission-done', 'state', 'assistant', 'result', 'state']);
  assert.deepStrictEqual(res.events.find((e) => e.type === 'permission'), { type: 'permission', requestId: 'r1', tool: 'Write', text: 'a.txt' });

  // Second message: same process, no second spawn.
  hasTranscript = true;
  ch.send(c.sessionId, '第二則');
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
  const got = res.events.filter((e) => e.type !== 'state' && e.type !== 'tasks' && e.type !== 'shell');
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

  // Cost adds up across results (each reports this process's total), and across a restart of the process.
  assert.ok(Math.abs(c.cost - 0.9) < 1e-9);
  assert.strictEqual(c.tok, 135);
  assert.strictEqual(ch.modelWindows['m-x'], 1000000);
  ch.stop(c.sessionId);
  ch.send(c.sessionId, '再來');
  log[log.length - 1].p.out({ type: 'result', is_error: false, total_cost_usd: 0.25 });   // a new process starts counting from zero
  assert.ok(Math.abs(c.cost - 1.15) < 1e-9);
  const again = new Channels(path.join(d, 'c.json'), { spawn: fakeSpawn(log), transcriptOf: () => null });
  assert.ok(Math.abs(again.get(c.sessionId).cost - 1.15) < 1e-9);   // remembered
  assert.strictEqual(again.modelWindows['m-x'], 1000000);
  ch.shutdown(); again.shutdown();
});

test('quota: the window most sessions agree on, its highest figure; a board conversation counts as one more observer', () => {
  const Q = require('../lib/quota');
  const d = tmp();
  const f = path.join(d, 'rl.json');
  const now = 1_800_000_000_000, sec = now / 1000;
  const w = (pct, inSec) => ({ used_percentage: pct, resets_at: sec + inSec });
  fs.writeFileSync(f, JSON.stringify({
    a: { t: sec - 20, five_hour: null, seven_day: w(31, 500000) },
    b: { t: sec - 10, five_hour: null, seven_day: w(29, 500000) },
    c: { t: sec - 200, five_hour: w(80, -5), seven_day: w(90, 700000) },          // 5h already reset; a lone session on a different 7d window
    d: { t: sec - 30, five_hour: w(12, 3600), seven_day: w(22, 500000) },
    junk: { t: sec, seven_day: { used_percentage: 99, resets_at: sec + 30 * 86400 } },   // too far ahead to be real
  }));
  assert.deepStrictEqual(Q.readQuota([], f, now), { fiveHour: { pct: 12, resetsAt: (sec + 3600) * 1000 }, sevenDay: { pct: 31, resetsAt: (sec + 500000) * 1000 }, seenAt: now });
  const ev = Q.fromEvent({ rateLimitType: 'seven_day', utilization: 0.34, resetsAt: sec + 500000, unifiedWindows: { seven_day: { utilization: 0.34, resetsAt: sec + 500000 } } }, now);
  assert.deepStrictEqual(ev, { t: sec, five_hour: null, seven_day: { used_percentage: 34, resets_at: sec + 500000 } });
  assert.strictEqual(Q.readQuota([ev], f, now).sevenDay.pct, 34);
  assert.deepStrictEqual(Q.readQuota([], path.join(d, 'none.json'), now), { fiveHour: null, sevenDay: null, seenAt: 0 });
  assert.strictEqual(Q.fromEvent({ status: 'allowed' }, now), null);
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
