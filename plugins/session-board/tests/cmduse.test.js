'use strict';
// lib/cmduse.js: how often each slash command was used, counted from the conversation records.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/cmduse');

const rec = (content, extra = {}) => JSON.stringify(Object.assign({ type: 'user', message: { role: 'user', content } }, extra));
const cmd = (name, first = 'name') => (first === 'name'
  ? '<command-name>/' + name + '</command-name>\n<command-message>' + name + '</command-message>'
  : '<command-message>' + name + '</command-message>\n<command-name>/' + name + '</command-name>');

test('commandOf: a command you ran, in either order of its tags; nothing else counts', () => {
  assert.strictEqual(C.commandOf(rec(cmd('model'))), 'model');
  assert.strictEqual(C.commandOf(rec(cmd('deliver-report:deliver-report', 'message'))), 'deliver-report:deliver-report', '<command-message> first (skills run by name)');
  assert.strictEqual(C.commandOf(rec([{ type: 'text', text: cmd('clear') }])), 'clear', 'content as a list of parts');
  assert.strictEqual(C.commandOf(rec('I typed <command-name>/model</command-name> in a sentence')), '', 'mentioned in what you said');
  assert.strictEqual(C.commandOf(rec(cmd('model'), { isCompactSummary: true })), '', 'a summary of the conversation');
  assert.strictEqual(C.commandOf(JSON.stringify({ type: 'assistant', message: { content: cmd('model') } })), '', "Claude's own text");
  assert.strictEqual(C.commandOf('{not json <command-name>/x</command-name>'), '');
});

test('counting: only what was added is read, a replaced file is counted again, odd names are only names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmduse-'));
  const proj = path.join(dir, 'C--work'); fs.mkdirSync(proj);
  const f = path.join(proj, 'a.jsonl');
  fs.writeFileSync(f, [rec(cmd('model')), rec('hello'), rec(cmd('constructor')), rec(cmd('__proto__'))].join('\n') + '\n');
  const u = C.create({ projectsDir: dir });
  assert.strictEqual(u.started(), false, 'made, not counting on its own (a test, not the board)');
  await u.refresh();
  assert.strictEqual(u.usage().model, 1);
  assert.strictEqual(u.usage().constructor, 1, 'constructor counted as a name');
  assert.strictEqual(u.usage().__proto__, 1, '__proto__ counted as a name');
  // more written, the last line still being written (no newline yet): only the finished lines count
  fs.appendFileSync(f, rec(cmd('model')) + '\n' + rec(cmd('clear')).slice(0, 20));
  await u.refresh();
  assert.strictEqual(u.usage().model, 2);
  assert.strictEqual(u.usage().clear, undefined, 'a half-written line waits');
  fs.appendFileSync(f, rec(cmd('clear')).slice(20) + '\n');
  await u.refresh();
  assert.strictEqual(u.usage().clear, 1, 'counted once it is finished');
  // the file replaced by a shorter one: counted from the start again
  fs.writeFileSync(f, rec(cmd('rename')) + '\n');
  await u.refresh();
  assert.deepStrictEqual(Object.assign({}, u.usage()), { rename: 1 });
});

test('counting: only the most recent files, and none older than the limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmduse-'));
  const proj = path.join(dir, 'C--work'); fs.mkdirSync(proj);
  const now = Date.now() / 1000;
  for (const [n, ageDays] of [['new1', 0], ['new2', 1], ['older', 2], ['old', 90]]) {
    const p = path.join(proj, n + '.jsonl'); fs.writeFileSync(p, rec(cmd(n)) + '\n'); fs.utimesSync(p, now - ageDays * 86400, now - ageDays * 86400);
  }
  const u = C.create({ projectsDir: dir, maxFiles: 2, maxAgeDays: 60 });
  await u.refresh();
  assert.deepStrictEqual(Object.keys(u.usage()).sort(), ['new1', 'new2']);
});
