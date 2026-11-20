'use strict';
// node --test plugins/session-board/tests/tidy.test.js - the mic's 自動排版 (lib/tidy.js) against a stand-in Claude
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Tidy, SYSTEM } = require('../lib/tidy');

// a stand-in for `claude -p --input-format stream-json`: answers each line written with what reply() gives
function fake(reply) {
  const procs = [];
  const spawn = (bin, args) => {
    const p = new EventEmitter(); p.args = args; p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {}; p.stderr = new EventEmitter();
    p.killed = false; p.kill = () => { p.killed = true; setImmediate(() => p.emit('exit', null)); };
    p.stdin = Object.assign(new EventEmitter(), {
      ended: false, end() { this.ended = true; },
      write(line) {
        const said = JSON.parse(line).message.content[0].text, r = reply(said, p);
        if (r === null) return true;   // never answers
        setImmediate(() => {
          for (const w of r.words || []) p.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: w } } }) + '\n');
          p.stdout.emit('data', JSON.stringify({ type: 'result', is_error: !!r.error, result: r.error || (r.words || []).join('') }) + '\n');
        });
        return true;
      },
    });
    procs.push(p); return p;
  };
  return { spawn, procs };
}

test('one Claude, its own system prompt only, no tools; words as they come, then the whole', async () => {
  const f = fake((said) => ({ words: ['我想', '看。'] }));
  const t = new Tidy({ spawn: f.spawn, bin: 'claude' });
  const seen = [];
  const r = await t.run('呃 我想 看', (x) => seen.push(x));
  assert.deepStrictEqual([r.ok, r.text], [true, '我想看。']);
  assert.deepStrictEqual(seen, ['我想', '我想看。']);
  const a = f.procs[0].args;
  assert.strictEqual(a[a.indexOf('--system-prompt') + 1], SYSTEM);
  assert.strictEqual(a[a.indexOf('--tools') + 1], '');
  assert.strictEqual(a[a.indexOf('--model') + 1], 'sonnet');
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--no-session-persistence') && a.includes('--disable-slash-commands'));
  // the same process for the next sentence
  await t.run('再一句', () => {});
  assert.strictEqual(f.procs.length, 1);
  t.stop();
});

test('sentences one at a time, each gets its own answer', async () => {
  const f = fake((said) => ({ words: [said + '。'] }));
  const t = new Tidy({ spawn: f.spawn });
  const rs = await Promise.all(['一', '二', '三'].map((x) => t.run(x)));
  assert.deepStrictEqual(rs.map((r) => r.text), ['一。', '二。', '三。']);
  t.stop();
});

test('an answer instead of the words tidied, an error, silence, a process gone: never put in the box, and the next one works', async () => {
  let mode = 'long';
  const f = fake((said, p) => {
    if (mode === 'long') return { words: ['好的，以下是詳細的回答：' + '很長'.repeat(60)] };
    if (mode === 'error') return { error: 'API Error' };
    if (mode === 'silent') return null;
    if (mode === 'die') { setImmediate(() => p.emit('exit', 1)); return null; }
    return { words: ['好。'] };
  });
  const t = new Tidy({ spawn: f.spawn, runMs: 200 });
  let r = await t.run('一加一');
  assert.strictEqual(r.ok, false); assert.match(r.error, /長太多/);
  mode = 'error'; r = await t.run('一句'); assert.deepStrictEqual(r, { ok: false, error: 'API Error' });
  mode = 'silent'; r = await t.run('一句'); assert.strictEqual(r.ok, false); assert.match(r.error, /秒沒有完成/);
  mode = 'die'; r = await t.run('一句'); assert.strictEqual(r.ok, false);
  mode = 'ok'; r = await t.run('好');
  assert.deepStrictEqual([r.ok, r.text], [true, '好。']);
  // each failure dropped that process: a fresh one each time after
  assert.strictEqual(f.procs.length, 5);
  t.stop();
});

test('replaced after so many sentences (its context does not grow without end), and stopped when idle', async () => {
  const f = fake(() => ({ words: ['好。'] }));
  const t = new Tidy({ spawn: f.spawn, maxUses: 2, idleMs: 50 });
  await t.run('a'); await t.run('b');
  assert.strictEqual(f.procs.length, 2, 'the second sentence used up the first; a fresh one is already booting');
  assert.strictEqual(f.procs[0].stdin.ended, true);
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(t.p, null, 'idle: stopped');
  assert.strictEqual(f.procs[1].stdin.ended, true);
});

test('nothing said is not sent', async () => {
  const f = fake(() => ({ words: ['x'] }));
  const t = new Tidy({ spawn: f.spawn });
  assert.deepStrictEqual(await t.run('   '), { ok: false, error: '沒有內容' });
  assert.strictEqual(f.procs.length, 0);
});
