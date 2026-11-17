'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('../lib/budget');
const K = require('../lib/keepalive');

test('the monthly budget: said once at the warning point and once at 100%, per month; no budget says nothing', () => {
  const base = { month: '2026-11', day: 15, daysInMonth: 30, settings: { monthly: 4000, warnPct: 80 } };
  let r = B.decide(Object.assign({}, base, { cost: 3000, state: null }));
  assert.deepStrictEqual([r.tell, Math.round(r.pct), Math.round(r.projected)], [null, 75, 6000]);
  r = B.decide(Object.assign({}, base, { cost: 3300, state: r.state }));
  assert.deepStrictEqual([r.tell.title, r.state.told], ['本月費用已達預算的 82%', [80]]);
  assert.strictEqual(r.tell.text, '本月 API 等值費用 $3,300，預算 $4,000（82%）。照目前的速度，到月底約 $6,600。');
  const again = B.decide(Object.assign({}, base, { cost: 3500, state: r.state }));
  assert.strictEqual(again.tell, null);                                                    // already said for this month
  r = B.decide(Object.assign({}, base, { cost: 4100, state: again.state }));
  assert.deepStrictEqual([r.tell.title, r.state.told], ['本月費用已超過預算', [80, 100]]);
  assert.strictEqual(B.decide(Object.assign({}, base, { cost: 9000, state: r.state })).tell, null);
  // a jump past both points says the higher one, once
  r = B.decide(Object.assign({}, base, { cost: 5000, state: null }));
  assert.deepStrictEqual([r.tell.title, r.state.told], ['本月費用已超過預算', [80, 100]]);
  // a new month starts over
  r = B.decide(Object.assign({}, base, { month: '2026-12', cost: 3300, state: { month: '2026-11', told: [80, 100] } }));
  assert.deepStrictEqual([!!r.tell, r.state], [true, { month: '2026-12', told: [80] }]);
  // no budget, or a value that is not a budget
  for (const s of [{ monthly: 0 }, {}, null, { monthly: -5 }, { monthly: 'x' }]) assert.strictEqual(B.decide(Object.assign({}, base, { cost: 99999, settings: s, state: null })).tell, null);
  assert.deepStrictEqual([B.clean({ monthly: '250.129', warnPct: 5 }), B.clean({ monthly: 100, warnPct: 90 })], [{ monthly: 250.13, warnPct: 80 }, { monthly: 100, warnPct: 90 }]);
});

test('the keep-alive file runs start.js with --keepalive and no window', () => {
  assert.strictEqual(K.script('C:\\Program Files\\nodejs\\node.exe', 'C:\\a b\\scripts\\start.js'),
    'CreateObject("WScript.Shell").Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\a b\\scripts\\start.js"" --keepalive", 0, False\r\n');
  assert.ok(K.STOPPED_MARK.endsWith('stopped-on-purpose') && K.TASK === 'SessionBoardKeepAlive' && K.EVERY_MIN === 10);
});
