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
  assert.deepStrictEqual(R.resumePoint(f, U(7)), { ok: true, at: U(5) }, 'said while it worked: from the reply before it');
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
  fs.rmSync(d, { recursive: true, force: true });
});
