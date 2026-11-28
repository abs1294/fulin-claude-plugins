'use strict';
// node --test plugins/session-board/tests/setup.test.js - the first page: what this computer has (lib/setup.js)
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/setup');

const NOW = Date.parse('2026-11-28T08:00:00Z');
const all = { 'cc-statusline': { newest: '1.11.1' }, 'plugin-manager': { newest: '0.20.1' }, goal2: { newest: '0.9.1' } };
const base = { platform: 'win32', node: '22.16.0', claude: '2.1.330', terminal: true, installed: all, latest: {}, limitsAt: NOW - 60e3, now: NOW, remote: { on: false }, inbox: {}, line: false };
const find = (r, k) => r.groups.flatMap((g) => g.items).find((x) => x.key === k);

test('everything everybody needs there: ready; the rest are a choice and do not count', () => {
  const r = S.check(base);
  assert.strictEqual(r.ready, true);
  assert.deepStrictEqual(r.groups.map((g) => g.key), ['need', 'core', 'more', 'connect']);
  assert.strictEqual(find(r, 'harness').state, 'missing');
  assert.strictEqual(find(r, 'phone').state, 'off');
});

test('a plugin everybody should have missing: not ready, with what it gives, what is missing without it, and an install', () => {
  const inst = Object.assign({}, all); delete inst['cc-statusline'];
  const r = S.check(Object.assign({}, base, { installed: inst }));
  const cs = find(r, 'cc-statusline');
  assert.strictEqual(r.ready, false);
  assert.deepStrictEqual([cs.state, cs.ok, cs.action], ['missing', false, { kind: 'install', plugin: 'cc-statusline' }]);
  assert.match(cs.gives, /額度/); assert.match(cs.without, /空的/);
});

test('cc-statusline older than the board needs, or a newer one out: an update', () => {
  let r = S.check(Object.assign({}, base, { installed: Object.assign({}, all, { 'cc-statusline': { newest: '1.9.0' } }) }));
  assert.deepStrictEqual([find(r, 'cc-statusline').state, find(r, 'cc-statusline').action.kind], ['old', 'update']);
  assert.match(find(r, 'cc-statusline').detail, /1\.11\.0 以上/);
  r = S.check(Object.assign({}, base, { latest: { goal2: '0.9.2' } }));
  assert.deepStrictEqual([find(r, 'goal2').state, find(r, 'goal2').action.kind], ['old', 'update']);
  assert.strictEqual(r.ready, false);
});

test('cc-statusline installed but its figures not coming in: not ok, and says why', () => {
  let r = S.check(Object.assign({}, base, { limitsAt: 0 }));
  assert.deepStrictEqual([find(r, 'cc-statusline').state, r.ready], ['stale', false]);
  r = S.check(Object.assign({}, base, { limitsAt: NOW - 3 * 3600e3 }));
  assert.match(find(r, 'cc-statusline').detail, /3 小時前更新/);
});

test('what is needed to run: Node too old, no claude, no terminal', () => {
  const r = S.check(Object.assign({}, base, { node: '22.4.1', claude: '', terminal: false, platform: 'darwin' }));
  assert.deepStrictEqual(['node', 'claude', 'terminal'].map((k) => find(r, k).state), ['old', 'missing', 'missing']);
  assert.strictEqual(find(r, 'terminal').name, 'Terminal');
  assert.strictEqual(r.ready, false);
});

test('the phone: off, on and listening, on but not reached', () => {
  assert.strictEqual(find(S.check(Object.assign({}, base, { remote: { on: true, listening: true } })), 'phone').state, 'ok');
  const p = find(S.check(Object.assign({}, base, { remote: { on: true, listening: false } })), 'phone');
  assert.deepStrictEqual([p.state, p.action], ['stale', { kind: 'settings', at: 'remote' }]);
  assert.match(find(S.check(Object.assign({}, base, { inbox: { gmail: true, teams: true } })), 'inbox').detail, /Gmail、Teams/);
});

test('where a plugin is: for some projects only it says so; cc-statusline there only is not ok (other projects have no figures)', () => {
  const inst = Object.assign({}, all, { goal2: { newest: '0.9.1', installs: [{ scope: 'project', project: 'C:/a' }, { scope: 'project', project: 'C:/b' }] }, 'cc-statusline': { newest: '1.11.1', installs: [{ scope: 'project', project: 'C:/a' }] } });
  const r = S.check(Object.assign({}, base, { installed: inst }));
  assert.deepStrictEqual([find(r, 'goal2').state, find(r, 'goal2').detail], ['ok', '目前 0.9.1，只裝在 2 個專案']);
  const cs = find(r, 'cc-statusline');
  assert.deepStrictEqual([cs.state, cs.action], ['stale', { kind: 'install', plugin: 'cc-statusline' }]);
  assert.match(cs.detail, /其他專案的對話不會有/);
  assert.strictEqual(r.ready, false);
});

test('a newer one out but no plugin-manager to update it with: no update button, and it says what to install first', () => {
  const inst = Object.assign({}, all); delete inst['plugin-manager'];
  const g = find(S.check(Object.assign({}, base, { installed: inst, latest: { goal2: '0.9.2' } })), 'goal2');
  assert.deepStrictEqual([g.state, g.action], ['old', null]);
  assert.match(g.detail, /先裝 plugin-manager/);
  assert.ok(S.MORE.every((x) => x.without), 'every one says what is missing without it');
});

test('cc-statusline for a project only and old as well: installed for you, not updated (an update would leave it where it was)', () => {
  const inst = Object.assign({}, all, { 'cc-statusline': { newest: '1.9.0', installs: [{ scope: 'project', project: 'C:/a' }] } });
  const cs = find(S.check(Object.assign({}, base, { installed: inst, latest: { 'cc-statusline': '1.11.1' } })), 'cc-statusline');
  assert.deepStrictEqual([cs.state, cs.action], ['stale', { kind: 'install', plugin: 'cc-statusline' }]);
});
