'use strict';
// lib/agents.js: a terminal session's running subagents, with what each is doing, from its transcript.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../lib/agents');

test('running from the Agent call until its result (foreground) or a notice that it stopped (background)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agents-')), f = path.join(d, 't.jsonl');
  const L = (o) => JSON.stringify(o);
  const use = (t, id, kind, desc, bg) => L({ type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: kind, description: desc, run_in_background: bg } }] } });
  const result = (id, text) => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
  const notice = (kind, id, status) => kind === 'queue'
    ? L({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>' + id + '</tool-use-id>\n<status>' + status + '</status>\n</task-notification>' })
    : L({ type: 'user', message: { content: '<task-notification>\n<tool-use-id>' + id + '</tool-use-id>\n<status>' + status + '</status>\n</task-notification>' } });
  fs.writeFileSync(f, [
    use('2026-11-18T07:00:00Z', 't1', 'general-purpose', '審查改動', false), result('t1', 'VERDICT: PASS'),          // foreground, done
    use('2026-11-18T07:01:00Z', 't2', 'Explore', '找出登入流程', false),                                             // foreground, still running
    use('2026-11-18T07:02:00Z', 't3', 'codex:codex-rescue', 'Codex 審查', true), result('t3', 'Async agent launched successfully.\nagentId: a3'),   // background, running
    use('2026-11-18T07:03:00Z', 't4', 'general-purpose', '盲標 30 則', true), result('t4', 'Async agent launched successfully.\nagentId: a4'), notice('user', 't4', 'completed'),   // background, done
    use('2026-11-18T07:04:00Z', 't5', 'fork', '實作合作', true), result('t5', 'Async agent launched successfully.'), notice('queue', 't5', 'running'),   // a notice that it is still going: still running
    L({ type: 'user', message: { content: [{ type: 'text', text: '我在說 <task-notification> 這個字：不是通知' }] } }),
  ].join('\n'));
  const r = A.running(f);
  assert.deepStrictEqual(r.map((x) => [x.kind, x.description]), [['Explore', '找出登入流程'], ['codex:codex-rescue', 'Codex 審查'], ['fork', '實作合作']]);
  assert.strictEqual(r[0].startedAt, Date.parse('2026-11-18T07:01:00Z'));
  assert.deepStrictEqual(A.running(path.join(d, 'none.jsonl')), [], 'no transcript: nothing');
  // the tool under its older name, Task
  const g = path.join(d, 'task.jsonl');
  fs.writeFileSync(g, L({ type: 'assistant', timestamp: '2026-11-18T08:00:00Z', message: { content: [{ type: 'tool_use', id: 'k1', name: 'Task', input: { subagent_type: 'general-purpose', description: '舊名字的子代理' } }] } }));
  assert.deepStrictEqual(A.running(g).map((x) => x.description), ['舊名字的子代理']);
  // read again only when the file changed: its result comes back, and the list follows
  fs.appendFileSync(g, '\n' + L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'k1', content: 'done' }] } }));
  assert.deepStrictEqual(A.running(g), [], 'the file grew: read again, no longer running');
  // a notice that follows other text still counts
  fs.appendFileSync(g, '\n' + L({ type: 'assistant', timestamp: '2026-11-18T08:05:00Z', message: { content: [{ type: 'tool_use', id: 'k2', name: 'Agent', input: { subagent_type: 'Explore', description: 'x', run_in_background: true } }] } })
    + '\n' + L({ type: 'user', message: { content: '前面還有字\n<task-notification>\n<tool-use-id>k2</tool-use-id>\n<status>completed</status>\n</task-notification>' } }));
  assert.deepStrictEqual(A.running(g), []);
  // two notices in one message: both count; a pasted look-alike without its closing tag, or for a call not in this
  // transcript, changes nothing
  const h2 = path.join(d, 'two.jsonl');
  const bgUse = (id) => L({ type: 'assistant', timestamp: '2026-11-18T09:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'Explore', description: id, run_in_background: true } }] } });
  const n = (id) => '<task-notification>\n<tool-use-id>' + id + '</tool-use-id>\n<status>completed</status>\n</task-notification>';
  fs.writeFileSync(h2, [bgUse('m1'), bgUse('m2'), bgUse('m3'),
    L({ type: 'user', message: { content: n('m1') + '\n' + n('m2') } }),
    L({ type: 'user', message: { content: '我貼一段：<task-notification><tool-use-id>m3</tool-use-id><status>completed</status>' } }),
  ].join('\n'));
  assert.deepStrictEqual(A.running(h2).map((x) => x.id), ['m3']);
  fs.rmSync(d, { recursive: true, force: true });
});
