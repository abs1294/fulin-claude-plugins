'use strict';
// lib/rewind.js: where a board conversation is carried on from when a message of it is edited and sent again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/rewind');

const U = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const L = (o) => JSON.stringify(o);

test('the newest reply before the message; none for the first; refused before a compaction, for a tool result or an unknown id', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rewind-')), f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, [
    L({ type: 'user', uuid: U(1), parentUuid: null, message: { role: 'user', content: '第一句' } }),
    L({ type: 'assistant', uuid: U(2), parentUuid: U(1), message: { content: [{ type: 'text', text: '好' }] } }),
    L({ type: 'system', uuid: U(3), parentUuid: U(2), subtype: 'turn_duration' }),
    L({ type: 'user', uuid: U(4), parentUuid: U(3), message: { role: 'user', content: [{ type: 'text', text: '第二句' }] } }),
    L({ type: 'assistant', uuid: U(5), parentUuid: U(4), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
    L({ type: 'user', uuid: U(6), parentUuid: U(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }),
    L({ type: 'attachment', uuid: U(7), parentUuid: U(6), attachment: { type: 'queued_command', prompt: '做到一半插話' } }),
    L({ type: 'assistant', uuid: U(8), parentUuid: U(7), message: { content: [{ type: 'text', text: '收到' }] } }),
  ].join('\n'));
  assert.deepStrictEqual(R.resumePoint(f, U(4)), { ok: true, at: U(2) }, 'past the system line to the reply before it');
  assert.deepStrictEqual(R.resumePoint(f, U(1)), { ok: true, at: null }, 'the first message: start afresh');
  assert.deepStrictEqual(R.resumePoint(f, U(7)), { ok: true, at: U(6) }, 'said while it worked: after the tool result, not at the call before it (measured: the call would be gone)');
  assert.strictEqual(R.resumePoint(f, U(6)).ok, false, 'a tool result is not yours to edit');
  assert.strictEqual(R.resumePoint(f, U(99)).ok, false, 'not in the transcript');
  assert.strictEqual(R.resumePoint(f, 'nope').ok, false, 'not an id');
  // a compaction after the message: it cannot be gone back to; one after the compaction can
  fs.appendFileSync(f, '\n' + [
    L({ type: 'system', uuid: U(9), parentUuid: null, subtype: 'compact_boundary', logicalParentUuid: U(8) }),
    L({ type: 'user', uuid: U(10), parentUuid: U(9), isCompactSummary: true, message: { role: 'user', content: '摘要' } }),
    L({ type: 'assistant', uuid: U(11), parentUuid: U(10), message: { content: [{ type: 'text', text: '接著' }] } }),
    L({ type: 'user', uuid: U(12), parentUuid: U(11), message: { role: 'user', content: '第三句' } }),
  ].join('\n'));
  assert.match(R.resumePoint(f, U(4)).error, /壓縮/);
  assert.deepStrictEqual(R.resumePoint(f, U(12)), { ok: true, at: U(11) });
  assert.strictEqual(R.resumePoint(f, U(10)).ok, false, 'the summary is not yours to edit');
  assert.strictEqual(R.resumePoint(path.join(d, 'none.jsonl'), U(1)).ok, false, 'no transcript');
  // a reply's thinking part is not a place to carry on from (where it really ends cannot be told): past it
  const g = path.join(d, 'think.jsonl');
  fs.writeFileSync(g, [
    L({ type: 'user', uuid: U(21), parentUuid: null, message: { role: 'user', content: '一' } }),
    L({ type: 'assistant', uuid: U(22), parentUuid: U(21), message: { id: 'm', content: [{ type: 'text', text: '好' }] } }),
    L({ type: 'user', uuid: U(23), parentUuid: U(22), message: { role: 'user', content: '二' } }),
    L({ type: 'assistant', uuid: U(24), parentUuid: U(23), message: { id: 'n', content: [{ type: 'thinking', thinking: '…' }] } }),
    L({ type: 'user', uuid: U(25), parentUuid: U(24), message: { role: 'user', content: '三' } }),
  ].join('\n'));
  assert.deepStrictEqual(R.resumePoint(g, U(25)), { ok: true, at: U(22) });
  // one reply written as two entries, words then a tool call (same message id), stopped before the tool's result: its
  // words are part of a reply, not its end - past them
  const h = path.join(d, 'split.jsonl');
  fs.writeFileSync(h, [
    L({ type: 'user', uuid: U(31), parentUuid: null, message: { role: 'user', content: '一' } }),
    L({ type: 'assistant', uuid: U(32), parentUuid: U(31), message: { id: 'a', content: [{ type: 'text', text: '好' }] } }),
    L({ type: 'user', uuid: U(33), parentUuid: U(32), message: { role: 'user', content: '二' } }),
    L({ type: 'assistant', uuid: U(34), parentUuid: U(33), message: { id: 'b', content: [{ type: 'text', text: '我來跑一下' }] } }),
    L({ type: 'assistant', uuid: U(35), parentUuid: U(34), message: { id: 'b', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: {} }] } }),
    L({ type: 'user', uuid: U(36), parentUuid: U(35), message: { role: 'user', content: '三' } }),
  ].join('\n'));
  assert.deepStrictEqual(R.resumePoint(h, U(36)), { ok: true, at: U(32) });
  fs.rmSync(d, { recursive: true, force: true });
});

test('what the board told it of before: its own messages on the way there - also said while it worked, or through another session; not a mention, not a way gone back from', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rewind-')), f = path.join(d, 't.jsonl'), tag = '【合作 #7】', brief = '（看板自動送出）' + tag + '你加入了一個合作';
  const had = (mid) => {
    fs.writeFileSync(f, [
      L({ type: 'user', uuid: U(1), parentUuid: null, message: { role: 'user', content: '第一句' } }), L({ type: 'assistant', uuid: U(2), parentUuid: U(1), message: { content: [{ type: 'text', text: '好' }] } }),
      L(Object.assign({ uuid: U(3), parentUuid: U(2) }, mid)), L({ type: 'assistant', uuid: U(4), parentUuid: U(3), message: { content: [{ type: 'text', text: '好' }] } }),
      L({ type: 'user', uuid: U(5), parentUuid: U(4), message: { role: 'user', content: '改我' } }),
      L({ type: 'user', uuid: U(6), parentUuid: U(2), message: { role: 'user', content: '另一條路' } }),
    ].join('\n'));
    return [R.resumePoint(f, U(5), [tag]).had, R.resumePoint(f, U(6), [tag]).had];
  };
  for (const m of [{ type: 'user', message: { role: 'user', content: brief } }, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: brief }] } }, { type: 'attachment', attachment: { type: 'queued_command', prompt: brief } },
    { type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="y">\n' + brief } }]) assert.deepStrictEqual(had(m), [[tag], []], JSON.stringify(m).slice(0, 60));
  assert.deepStrictEqual(had({ type: 'user', message: { role: 'user', content: '你看過 ' + tag + ' 嗎' } }), [[], []], 'merely mentioned');
  fs.rmSync(d, { recursive: true, force: true });
});
