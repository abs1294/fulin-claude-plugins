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
const P = (r) => ({ ok: r.ok, at: r.at });   // (where, as before; after is tested on its own)

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
  assert.deepStrictEqual(P(R.resumePoint(f, U(4))), { ok: true, at: U(2) }, 'past the system line to the reply before it');
  assert.deepStrictEqual(P(R.resumePoint(f, U(1))), { ok: true, at: null }, 'the first message: start afresh');
  assert.deepStrictEqual(P(R.resumePoint(f, U(7))), { ok: true, at: U(6) }, 'said while it worked: after the tool result, not at the call before it (measured: the call would be gone)');
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
  assert.deepStrictEqual(P(R.resumePoint(f, U(12))), { ok: true, at: U(11) });
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
  assert.deepStrictEqual(P(R.resumePoint(g, U(25))), { ok: true, at: U(22) });
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
  assert.deepStrictEqual(P(R.resumePoint(h, U(36))), { ok: true, at: U(32) });
  fs.rmSync(d, { recursive: true, force: true });
});

test('what the board told it of in a part of the transcript: its own messages - also said while it worked, or through another session; not a mention', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rewind-')), f = path.join(d, 't.jsonl'), tag = '【合作 #7】', brief = '（看板自動送出）' + tag + '你加入了一個合作';
  const had = (mid) => {
    fs.writeFileSync(f, [
      L({ type: 'user', uuid: U(1), parentUuid: null, message: { role: 'user', content: '第一句' } }), L({ type: 'assistant', uuid: U(2), parentUuid: U(1), message: { content: [{ type: 'text', text: '好' }] } }),
      L(Object.assign({ uuid: U(3), parentUuid: U(2) }, mid)), L({ type: 'assistant', uuid: U(4), parentUuid: U(3), message: { content: [{ type: 'text', text: '好' }] } }),
      L({ type: 'user', uuid: U(5), parentUuid: U(4), message: { role: 'user', content: '改我' } }),
      L({ type: 'user', uuid: U(6), parentUuid: U(2), message: { role: 'user', content: '另一條路' } }),
    ].join('\n'));
    const all = fs.statSync(f).size, cut = Buffer.byteLength(fs.readFileSync(f, 'utf8').split('\n').slice(0, 2).join('\n') + '\n');
    return [R.told(f, cut, all, [tag]), R.told(f, 0, cut, [tag])];   // [the part with its third line, the part before it]
  };
  for (const m of [{ type: 'user', message: { role: 'user', content: brief } }, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: brief }] } }, { type: 'attachment', attachment: { type: 'queued_command', prompt: brief } },
    { type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="y">\n' + brief } }]) assert.deepStrictEqual(had(m), [[tag], []], JSON.stringify(m).slice(0, 60));
  assert.deepStrictEqual(had({ type: 'user', message: { role: 'user', content: '你看過 ' + tag + ' 嗎' } }), [[], []], 'merely mentioned');
  fs.rmSync(d, { recursive: true, force: true });
});

test('carried on in place: after is where the way gone back from starts, and the history leaves it out (2026-11-28)', () => {
  const H = require('../lib/history');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rewind-')), f = path.join(d, 't.jsonl');
  const head = [
    L({ type: 'user', uuid: U(1), parentUuid: null, message: { role: 'user', content: '一' } }),
    L({ type: 'assistant', uuid: U(2), parentUuid: U(1), message: { content: [{ type: 'text', text: '回一' }] } }),
  ].join('\n') + '\n';
  const gone = [
    L({ type: 'system', uuid: U(3), parentUuid: U(2), subtype: 'turn_duration' }),
    L({ type: 'user', uuid: U(4), parentUuid: U(3), message: { role: 'user', content: '二' } }),
    L({ type: 'assistant', uuid: U(5), parentUuid: U(4), message: { content: [{ type: 'text', text: '回二' }] } }),
  ].join('\n') + '\n';
  fs.writeFileSync(f, head + gone);
  const r = R.resumePoint(f, U(4));
  assert.strictEqual(r.at, U(2));
  assert.strictEqual(r.after, Buffer.byteLength(head), 'just past the line of the place it goes back to');
  const to = fs.statSync(f).size;
  // what Claude Code writes next: a branch from U(2) in the same file
  fs.appendFileSync(f, [
    L({ type: 'user', uuid: U(6), parentUuid: U(2), message: { role: 'user', content: '二（改過）' } }),
    L({ type: 'assistant', uuid: U(7), parentUuid: U(6), message: { content: [{ type: 'text', text: '回改過的二' }] } }),
  ].join('\n') + '\n');
  const texts = (o) => H.readHistory(f, o).items.map((x) => x.text);
  assert.deepStrictEqual(texts({ hide: [[r.after, to]] }), ['一', '回一', '二（改過）', '回改過的二']);
  assert.deepStrictEqual(texts({}), ['一', '回一', '二', '回二', '二（改過）', '回改過的二'], 'without the range: everything, as before');
  // the cache tells the two apart
  assert.notDeepStrictEqual(H.cachedHistory(f, { hide: [[r.after, to]] }).items.length, H.cachedHistory(f, {}).items.length);
  // non-ASCII before the place: offsets are bytes, not characters
  assert.ok(r.after > head.length, 'bytes (三 bytes for each Chinese character), not characters');
});

test('a conversation cleared (/clear: a new session id) leaves the ranges of its old transcript behind (review 2026-11-28)', () => {
  const { Channels } = require('../lib/chat');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rewind-'));
  const ch = new Channels(path.join(d, 'channels.json'), { spawn: () => { throw new Error('not started'); } });
  const c = ch.create(d, U(1)); c.rewinds = [[10, 100000]]; c.rewindAt = U(2); c.rewindTo = 5;
  ch._moveTo(c, U(3));
  assert.deepStrictEqual([c.sessionId, c.rewinds, c.rewindAt, c.rewindTo], [U(3), undefined, undefined, undefined]);
  if (ch.timer) clearInterval(ch.timer);
});

test('what it is started with: a copy made before (forkOf, resumeAt) with a transcript of its own goes on from its end; in place only until the edited message is written (review 2026-11-28)', () => {
  const { Channels } = require('../lib/chat');
  const { EventEmitter } = require('events');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rewind-')), f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, 'x'.repeat(100));
  const seen = [];
  const spawn = (bin, args) => { seen.push(args); const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = { write() {}, end() {}, on() {} }; p.kill = () => {}; p.pid = 1; return p; };
  const ch = new Channels(path.join(d, 'channels.json'), { spawn, transcriptOf: () => f });
  const at = (args, k) => args.slice(args.indexOf(k), args.indexOf(k) + 2);
  // copied by the board before 0.28.3: its fields stay, it is carried on from its own end
  const old = ch.create(d, U(1)); old.forkOf = U(9); old.resumeAt = U(8);
  ch._start(old);
  assert.deepStrictEqual([at(seen[0], '--resume'), seen[0].includes('--resume-session-at'), seen[0].includes('--fork-session')], [['--resume', U(1)], false, false]);
  // in place, nothing written since: from the entry before the edited message
  const c = ch.create(d, U(2)); c.rewindAt = U(7); c.rewindTo = 100;
  ch._start(c);
  assert.deepStrictEqual(seen[1].slice(seen[1].indexOf('--resume'), seen[1].indexOf('--resume') + 4), ['--resume', U(2), '--resume-session-at', U(7)]);
  // the edited message written meanwhile (the process went before its first reply): from its end, not back again
  fs.appendFileSync(f, 'more');
  c.proc = null; ch._start(c);
  assert.deepStrictEqual([at(seen[2], '--resume'), seen[2].includes('--resume-session-at'), c.rewindAt, c.rewindTo], [['--resume', U(2)], false, undefined, undefined]);
  clearInterval(ch.timer);
});
