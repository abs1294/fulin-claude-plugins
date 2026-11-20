'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Auto, hhmm } = require('../lib/auto');

const T = (s) => new Date(s).getTime();   // local time
function rig(settings, o = {}) {
  const r = { mem: null, told: [], rebuilt: [], checks: 0, updates: 0, reviews: [] };
  r.auto = new Auto({
    settings: () => settings, recall: () => (r.mem ? JSON.parse(r.mem) : null), remember: (st) => { r.mem = JSON.stringify(st); },
    cbmFolders: () => ['C:\proj'],
    cbmCheck: async () => { r.checks++; return { repos: [{ repo: 'api', state: 'fresh' }, { repo: 'web', state: 'stale', hours: 12 }], fixes: ['"x/codebase-memory-mcp.exe" cli --quiet index_repository \'{"repo_path":"C:/proj/web"}\''] }; },
    rebuild: async (fix) => { r.rebuilt.push(fix); return o.rebuildFails ? { ok: false, error: 'boom' } : { ok: true }; },
    update: async () => { r.updates++; return { ok: true, summary: o.summary || '' }; },
    harnessDue: () => (o.due || []), startReview: async (folder) => { r.reviews.push(folder); return { ok: true }; },
    tell: (t, x) => r.told.push(t + '｜' + x),
  });
  return r;
}

test('code index: a stale repository is rebuilt with the command the check gave; checked again only after 6 hours', async () => {
  const r = rig({ update: false });
  await r.auto.tick(T('2026-11-17T08:00:00'));
  assert.deepStrictEqual([r.checks, r.rebuilt.length, /web/.test(r.rebuilt[0])], [1, 1, true]);
  await r.auto.tick(T('2026-11-17T09:00:00'));
  assert.strictEqual(r.checks, 1, 'not again within 6 hours');
  await r.auto.tick(T('2026-11-17T14:01:00'));
  assert.strictEqual(r.checks, 2);
  assert.ok(r.auto.log().some((x) => x.kind === 'cbm' && /重建了 web/.test(x.what)));
  const off = rig({ cbm: false, update: false }); await off.auto.tick(T('2026-11-17T08:00:00'));
  assert.strictEqual(off.checks, 0, 'switched off: nothing');
  const bad = rig({ update: false }, { rebuildFails: true }); await bad.auto.tick(T('2026-11-17T08:00:00'));
  assert.deepStrictEqual(bad.auto.log().map((x) => x.ok), [false], 'a failed rebuild is logged as failed');
});

test('plugins: updated once a day after the time set; you are told only when something changed', async () => {
  const r = rig({ cbm: false, update: true, updateAt: '09:30' }, { summary: '更新 2 個：deliver-report 2.6.0 → 2.7.0' });
  await r.auto.tick(T('2026-11-17T09:00:00')); assert.strictEqual(r.updates, 0, 'not before the time');
  await r.auto.tick(T('2026-11-17T09:31:00')); assert.strictEqual(r.updates, 1);
  await r.auto.tick(T('2026-11-17T15:00:00')); assert.strictEqual(r.updates, 1, 'once a day');
  await r.auto.tick(T('2026-11-18T09:40:00')); assert.strictEqual(r.updates, 2, 'the next day again');
  assert.strictEqual(r.told.length, 2);
  const quiet = rig({ cbm: false, update: true }, { summary: '' }); await quiet.auto.tick(T('2026-11-17T10:00:00'));
  const off = rig({ cbm: false }, { summary: 'x' }); await off.auto.tick(T('2026-11-17T10:00:00'));
  assert.strictEqual(off.updates, 0, 'off by default: it changes every project\'s plugins without asking');
  assert.deepStrictEqual([quiet.updates, quiet.told.length], [1, 0], 'nothing new: no notice');
  assert.deepStrictEqual([hhmm('7:05'), hhmm('bad'), hhmm('25:00')], [425, 540, 540]);
});

test('harness: off by default; switched on, one due project a day after 10:00', async () => {
  const due = [{ folder: 'C:\a', name: 'a' }, { folder: 'C:\b', name: 'b' }];
  const off = rig({ cbm: false, update: false }, { due }); await off.auto.tick(T('2026-11-17T11:00:00'));
  assert.deepStrictEqual(off.reviews, [], 'off by default');
  const r = rig({ cbm: false, update: false, harness: true }, { due });
  await r.auto.tick(T('2026-11-17T09:59:00')); assert.deepStrictEqual(r.reviews, []);
  await r.auto.tick(T('2026-11-17T10:05:00')); await r.auto.tick(T('2026-11-17T16:00:00'));
  assert.deepStrictEqual(r.reviews, ['C:\a'], 'one a day');
  await r.auto.tick(T('2026-11-18T10:05:00'));
  assert.deepStrictEqual(r.reviews, ['C:\a', 'C:\a'], 'the next day, whichever is due then');
});

test('check: once a day, read only; "need" only when a plugin is behind or a newer board is installed; asked again after an update', async () => {
  let answer = { ok: true, behind: [], board: { running: '0.13.1', newest: '0.13.1' } }, calls = 0;
  const r = rig({ cbm: false, update: false });
  r.auto.ops.check = async () => { calls++; return answer; };
  await r.auto.tick(T('2026-11-20T08:00:00'));
  assert.deepStrictEqual([calls, r.auto.checked().need, r.updates], [1, false, 0], 'nothing to update; nothing updated by the check');
  await r.auto.tick(T('2026-11-20T15:00:00'));
  assert.strictEqual(calls, 1, 'once a day');
  answer = { ok: true, behind: [{ name: 'goal2', from: '0.6.0', to: '0.7.0' }], board: { running: '0.13.1', newest: '0.13.1' } };
  await r.auto.tick(T('2026-11-21T08:00:00'));
  assert.deepStrictEqual([calls, r.auto.checked().need, r.auto.checked().behind[0].name], [2, true, 'goal2']);
  // the board installed is newer than the one running: something to do (a restart) even with no plugin behind
  answer = { ok: true, behind: [], board: { running: '0.13.1', newest: '0.14.0' } };
  r.auto.recheck();
  assert.strictEqual(r.auto.checked(), null, 'after an update: not known until checked again');
  await r.auto.tick(T('2026-11-21T08:10:00'));
  assert.deepStrictEqual([calls, r.auto.checked().need], [3, true]);
  // a check that throws is kept as not ok, nothing else stops
  const bad = rig({ cbm: false, update: false }); bad.auto.ops.check = async () => { throw new Error('offline'); };
  await bad.auto.tick(T('2026-11-20T08:00:00'));
  assert.deepStrictEqual([bad.auto.checked().ok, bad.auto.checked().need, bad.auto.checked().error], [false, false, 'offline']);
});

test('check after an update made the same round sees it done; an older board installed is nothing to update; a failed check is tried again after an hour', async () => {
  const { newer } = require('../lib/auto');
  assert.deepStrictEqual([newer('0.14.0', '0.13.1'), newer('0.13.1', '0.14.0'), newer('0.13.1', '0.13.1'), newer('1.0.0', '0.99.9'), newer('', '1')], [true, false, false, true, false]);
  const order = [];
  const r = rig({ cbm: false, update: true, updateAt: '09:00' }, { summary: '更新 1 個' });
  r.auto.ops.update = async () => { order.push('update'); return { ok: true, summary: '更新 1 個' }; };
  r.auto.ops.check = async () => { order.push('check'); return { ok: true, behind: [], board: { running: '0.14.0', newest: '0.13.1' } }; };
  await r.auto.tick(T('2026-11-20T09:05:00'));
  assert.deepStrictEqual(order, ['update', 'check'], 'the update first, then what is left');
  assert.strictEqual(r.auto.checked().need, false, 'an older board installed: not something to update to');
  // offline: tried again after an hour, not before
  let n = 0; const off = rig({ cbm: false, update: false });
  off.auto.ops.check = async () => { n++; return n === 1 ? { ok: false, error: 'offline' } : { ok: true, behind: [], board: {} }; };
  await off.auto.tick(T('2026-11-20T08:00:00')); await off.auto.tick(T('2026-11-20T08:30:00'));
  assert.strictEqual(n, 1);
  await off.auto.tick(T('2026-11-20T09:01:00'));
  assert.deepStrictEqual([n, off.auto.checked().ok], [2, true]);
});

test('a check made while another board version ran is asked again on the next round', async () => {
  let ver = '0.13.1', n = 0;
  const r = rig({ cbm: false, update: false });
  r.auto.ops.version = () => ver;
  r.auto.ops.check = async () => { n++; return { ok: true, behind: [], board: { running: ver, newest: '0.14.0' } }; };
  await r.auto.tick(T('2026-11-20T08:00:00')); await r.auto.tick(T('2026-11-20T08:10:00'));
  assert.strictEqual(n, 1);
  ver = '0.14.0';
  await r.auto.tick(T('2026-11-20T08:20:00'));
  assert.deepStrictEqual([n, r.auto.checked().need], [2, false], 'restarted onto it: nothing left to do');
});
