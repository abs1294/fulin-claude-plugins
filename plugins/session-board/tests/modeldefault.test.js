'use strict';
// The default model and effort of new conversations, in Claude Code's own settings (lib/modeldefault.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MD = require('../lib/modeldefault');

const home = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-md-')); fs.mkdirSync(path.join(h, '.claude')); return h; };
const file = (h) => path.join(h, '.claude', 'settings.json');
const readJ = (h) => JSON.parse(fs.readFileSync(file(h), 'utf8'));

test('read: the model, and its effort from modelSettings (alias, or the full id it runs on)', () => {
  const h = home();
  fs.writeFileSync(file(h), JSON.stringify({ model: 'opus', effortLevel: 'high', modelSettings: { 'claude-fable-5': { effortLevel: 'xhigh' } } }));
  assert.deepStrictEqual([MD.get({ home: h }).model, MD.get({ home: h }).effort], ['opus', ''], 'the top-level effortLevel is not what Opus 5.5 runs on: not shown as its effort');
  fs.writeFileSync(file(h), JSON.stringify({ model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' }, opus: { effortLevel: 'low' } } }));
  assert.strictEqual(MD.get({ home: h, seen: 'claude-opus-5-5' }).effort, 'max', 'the full id wins over the alias, as in Claude Code');
  assert.strictEqual(MD.get({ home: h }).effort, 'low');
});

test('set: only the model and that one effort change, everything else is kept; a copy of the file is kept first', () => {
  const h = home();
  const before = { model: 'sonnet', effortLevel: 'high', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] }, enabledPlugins: { 'a@b': true }, modelSettings: { 'claude-fable-5': { effortLevel: 'xhigh' } } };
  fs.writeFileSync(file(h), JSON.stringify(before, null, 2));
  const r = MD.set({ home: h, model: 'opus', effort: 'high', now: Date.UTC(2026, 10, 26) });
  assert.deepStrictEqual([r.ok, r.model, r.effort], [true, 'opus', 'high']);
  const after = readJ(h);
  assert.deepStrictEqual(after, Object.assign({}, before, { model: 'opus', modelSettings: { 'claude-fable-5': { effortLevel: 'xhigh' }, opus: { effortLevel: 'high' } } }));
  assert.ok(r.backup && fs.existsSync(r.backup)); assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), before, 'the copy is the file as it was');
  assert.ok(r.backup.startsWith(path.join(h, '.claude', 'session-board', 'backups')));
});

test('set: the full id the conversation runs on, already there, is updated too (it would win over the alias); another model of the family is not', () => {
  const h = home();
  fs.writeFileSync(file(h), JSON.stringify({ model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' }, 'claude-opus-4-7': { effortLevel: 'low' } } }));
  MD.set({ home: h, effort: 'high', seen: 'claude-opus-5-5' });
  assert.deepStrictEqual(readJ(h).modelSettings, { 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-opus-4-7': { effortLevel: 'low' }, opus: { effortLevel: 'high' } });
});

test('a file that is not JSON is left alone; wrong values are refused; no file yet: made', () => {
  const h = home();
  fs.writeFileSync(file(h), '{ "model": "opus", ');
  const r = MD.set({ home: h, model: 'sonnet' });
  assert.strictEqual(r.ok, false); assert.strictEqual(fs.readFileSync(file(h), 'utf8'), '{ "model": "opus", ', 'not written over');
  for (const bad of [{ model: 'gpt' }, { effort: 'huge' }, {}]) assert.strictEqual(MD.set(Object.assign({ home: h }, bad)).ok, false, JSON.stringify(bad));
  const h2 = home();
  assert.deepStrictEqual([MD.set({ home: h2, model: 'haiku', effort: 'low' }).ok, readJ(h2)], [true, { model: 'haiku', modelSettings: { haiku: { effortLevel: 'low' } } }]);
  const h3 = home(); fs.writeFileSync(file(h3), JSON.stringify({ theme: 'dark' }));
  assert.strictEqual(MD.set({ home: h3, effort: 'high' }).ok, false, 'no default model to put the effort under');
});

test('the same model as now: what is written stays (opus[1m], a version kept on purpose); a link stays a link', () => {
  for (const was of ['opus[1m]', 'claude-opus-4-7', 'opusplan']) {
    const h = home(); fs.writeFileSync(file(h), JSON.stringify({ model: was }));
    assert.strictEqual(MD.set({ home: h, model: 'opus', effort: 'high' }).ok, true);
    assert.deepStrictEqual(readJ(h), { model: was, modelSettings: { opus: { effortLevel: 'high' } } }, was);
  }
  const h = home(); fs.writeFileSync(file(h), JSON.stringify({ model: 'opus[1m]' }));
  MD.set({ home: h, model: 'sonnet' }); assert.strictEqual(readJ(h).model, 'sonnet', 'another model: changed');
  const h2 = home(), real = path.join(h2, 'dotfiles.json'); fs.writeFileSync(real, JSON.stringify({ model: 'sonnet' }));
  let linked = true; try { fs.symlinkSync(real, file(h2)); } catch (e) { linked = false; }   // Windows without the right to make links: not tested here
  if (linked) { MD.set({ home: h2, model: 'opus' }); assert.ok(fs.lstatSync(file(h2)).isSymbolicLink(), 'still a link'); assert.strictEqual(JSON.parse(fs.readFileSync(real, 'utf8')).model, 'opus'); }
});

test('only the newest ten copies are kept', () => {
  const h = home(); fs.writeFileSync(file(h), '{}');
  for (let i = 0; i < 13; i++) MD.set({ home: h, model: i % 2 ? 'opus' : 'sonnet', now: Date.UTC(2026, 10, 26, 0, 0, i) });
  assert.strictEqual(fs.readdirSync(path.join(h, '.claude', 'session-board', 'backups')).length, 10);
});
