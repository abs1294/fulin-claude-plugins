'use strict';
// Tickets for the home-screen app (lib/appticket.js): once, within a day, only their hash on disk.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppTickets, manifest, TTL } = require('../lib/appticket');

test('a ticket works once, within a day; the file keeps only hashes; at most a hundred', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-at-')), f = path.join(d, 'app-tickets.json');
  let now = 1000000; const t = new AppTickets(f, { now: () => now });
  const a = t.make(), b = t.make();
  assert.ok(!fs.readFileSync(f, 'utf8').includes(a), 'the ticket itself is not kept');
  assert.strictEqual(new AppTickets(f, { now: () => now }).use(a), true, 'kept across a restart of the board');
  assert.strictEqual(t._read().length, 1);
  const again = new AppTickets(f, { now: () => now }); assert.strictEqual(again.use(a), false, 'once');
  now += TTL + 1; assert.strictEqual(again.use(b), false, 'not after a day');
  for (const bad of ['', 'x', '../a', null, a.toUpperCase()]) assert.strictEqual(again.use(bad), false, String(bad));
  for (let i = 0; i < 110; i++) again.make();
  assert.strictEqual(again._read().length, 100);
});

test('the manifest: opens on its own, the ticket in the start address only when it is one', () => {
  const m = manifest('a'.repeat(48));
  assert.deepStrictEqual([m.display, m.start_url, m.scope, m.icons.map((x) => x.sizes)], ['standalone', '/?app=' + 'a'.repeat(48), '/', ['180x180', '192x192', '512x512']]);
  assert.strictEqual(manifest('javascript:alert(1)').start_url, '/');
});
