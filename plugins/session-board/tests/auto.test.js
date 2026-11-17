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
