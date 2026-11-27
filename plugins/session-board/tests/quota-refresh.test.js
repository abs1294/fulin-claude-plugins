'use strict';
// The 額度 card's ↻ (lib/quota.js refreshQuota): the asking is cc-statusline's (hooks/account-limits.js --refresh); the
// board only finds it, starts it, and makes presses while one is under way that one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Q = require('../lib/quota');

test('finds the cc-statusline that has --refresh: beside it, else the newest installed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-qr-'));
  try {
    const here = path.join(d, 'plugins', 'session-board'), beside = path.join(d, 'plugins', 'cc-statusline');
    const old = path.join(d, 'cache', '1.10.1'), neu = path.join(d, 'cache', '1.11.0');
    const put = (root, text) => { fs.mkdirSync(path.join(root, 'hooks'), { recursive: true }); fs.writeFileSync(path.join(root, 'hooks', 'account-limits.js'), text); };
    const installed = path.join(d, 'installed.json');
    fs.writeFileSync(installed, JSON.stringify({ plugins: { 'cc-statusline@fulin-plugins': [{ version: '1.10.1', installPath: old }, { version: '1.11.0', installPath: neu }] } }));
    put(old, "process.argv[2] === '--ask'");
    assert.strictEqual(Q.findLimits({ here, installed }), null, 'only a version without it: none');
    put(neu, "process.argv[2] === '--refresh'");
    assert.strictEqual(Q.findLimits({ here, installed }), path.join(neu, 'hooks', 'account-limits.js'));
    put(beside, "process.argv[2] === '--refresh'");
    assert.strictEqual(Q.findLimits({ here, installed }), path.join(beside, 'hooks', 'account-limits.js'), 'the one beside it first (this repo)');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('presses while one is under way are that one; its answer is handed on', async () => {
  let started = 0, done = null;
  const run = (bin, args, opt, cb) => { started++; assert.deepStrictEqual(args, ['/x/account-limits.js', '--refresh']); done = cb; };
  const a = Q.refreshQuota({ tool: '/x/account-limits.js', run }), b = Q.refreshQuota({ tool: '/x/account-limits.js', run }), c = Q.refreshQuota({ tool: '/x/account-limits.js', run });
  assert.strictEqual(started, 1);
  done(null, 'noise\n{"ok":true,"asked":true,"at":5,"tried":4}\n');
  assert.deepStrictEqual(await Promise.all([a, b, c]), Array(3).fill({ ok: true, asked: true, at: 5, tried: 4 }));
  // once it is over, the next press starts another (cc-statusline itself does not ask again within 30 seconds)
  const d = Q.refreshQuota({ tool: '/x/account-limits.js', run }); assert.strictEqual(started, 2);
  done(null, '{"ok":true,"asked":false,"at":5,"tried":4}'); assert.deepStrictEqual(await d, { ok: true, asked: false, at: 5, tried: 4 });
});

test('no cc-statusline with it, or no answer: said so', async () => {
  const none = await Q.refreshQuota({ tool: null });
  assert.strictEqual(none.ok, false); assert.match(none.error, /1\.11\.0/);
  const silent = await Q.refreshQuota({ tool: '/x/a.js', run: (b, a, o, cb) => cb(Object.assign(new Error('x'), { killed: true }), '') });
  assert.strictEqual(silent.ok, false); assert.match(silent.error, /沒有回應.*70 秒/);
  // not even started (execFile threw): an answer, and the next press is not stuck behind it
  const threw = await Q.refreshQuota({ tool: '/x/a.js', run: () => { throw new Error('spawn EINVAL'); } });
  assert.deepStrictEqual([threw.ok, threw.asked, /沒有啟動.*EINVAL/.test(threw.error)], [false, false, true]);
  const next = await Q.refreshQuota({ tool: '/x/a.js', run: (b, a, o, cb) => cb(null, '{"ok":true,"asked":true,"at":7,"tried":6}') });
  assert.strictEqual(next.asked, true);
});
