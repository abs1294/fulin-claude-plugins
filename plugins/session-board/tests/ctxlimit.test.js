'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { limitFor, size, plain } = require('../lib/ctxlimit');
const { sessionStats } = require('../lib/stats');

test('sizes as they can be written', () => {
  assert.deepStrictEqual([500000, '500000', '500k', '500K', '1m', '0.5m', '500,000', 50000, '50k'].map(size), [500000, 500000, 500000, 500000, 1000000, 500000, 500000, 100000, 100000], 'less than the least is the least, as Claude Code reads it');
  for (const v of ['auto', '', null, undefined, 'x', -1, 0, {}, '1e6x']) assert.strictEqual(size(v), 0, String(v));
  assert.strictEqual(plain('claude-opus-5-5-20260601[1m]'), 'claude-opus-5-5');
});

test('what is set for a folder and a model: the environment first, then the nearer file, in it the model\'s own before the file\'s', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-')), cwd = path.join(home, 'proj'); let t = 1e9; fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true }); fs.mkdirSync(path.join(home, '.claude'));
  const put = (f, j) => { const p = f === 'user' ? path.join(home, '.claude', 'settings.json') : path.join(cwd, '.claude', f); if (j === null) fs.rmSync(p, { force: true }); else { fs.writeFileSync(p, typeof j === 'string' ? j : JSON.stringify(j)); t += 60; fs.utimesSync(p, t, t); } };
  const of = (model = 'claude-opus-5-5', w = cwd) => limitFor(w, model, { home, managed: path.join(home, 'managed.json') });
  assert.strictEqual(of(), 0, 'nothing set');
  put('user', { autoCompactWindow: 800000 }); assert.strictEqual(of(), 800000); assert.strictEqual(of('x', ''), 800000);
  put('settings.json', { autoCompactWindow: '600k' }); assert.strictEqual(of(), 600000);
  put('settings.local.json', { autoCompactWindow: 500000 }); assert.deepStrictEqual([of(), of('claude-haiku-5-5')], [500000, 500000]);
  put('settings.local.json', { autoCompactWindow: 500000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 300000 }, 'claude-haiku-5-5': { effortLevel: 'high' } } }); assert.deepStrictEqual([of('claude-opus-5-5-20260601'), of('claude-haiku-5-5')], [300000, 500000]);
  put('settings.local.json', { autoCompactWindow: 'auto' }); assert.strictEqual(of(), 0, 'auto is not a size, and it is the nearer word');
  put('settings.local.json', '{ not json'); assert.strictEqual(of(), 600000);
  put('user', { autoCompactWindow: 800000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } }); assert.strictEqual(of(), 250000, 'the environment is before all of them');
  put('user', null); assert.strictEqual(of(), 600000, 'a file taken away counts no more');
  const rd = fs.readFileSync; let reads = 0; fs.readFileSync = (...a) => { reads++; return rd(...a); }; try { of(); of(); } finally { fs.readFileSync = rd; } assert.strictEqual(reads, 0, 'unchanged: not read again');
});

test('the share of the context is of the window it really has', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-')), of = (x) => sessionStats('s', d, x).context, W = { windows: { 'claude-opus-5-5': 1000000 } };
  fs.writeFileSync(path.join(d, 'claude-toksum2-s.json'), JSON.stringify({ v: 1, at: 1, total: {}, context: { tokens: 270000, model: 'claude-opus-5-5', effort: 'high', at: 1 } }));
  assert.deepStrictEqual([of(W).window, of(W).pct, of(W).limited], [1000000, 27, undefined]);
  let c;
  // from the settings files
  c = of(Object.assign({ limit: (m) => (m === 'claude-opus-5-5' ? 500000 : 0) }, W)); assert.deepStrictEqual([c.window, c.pct, c.limited, c.own], [500000, 54, true, 1000000]);
  c = of(Object.assign({ limit: () => 2000000 }, W)); assert.deepStrictEqual([c.window, c.limited], [1000000, undefined], 'never more than the model has');
  c = of({ limit: () => 500000 }); assert.deepStrictEqual([c.window, c.pct, c.limited, c.own], [500000, 54, true, 1000000]);
});
