'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Schedules, clean, nextRun } = require('../lib/schedule');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sched-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const at = (y, m, d, h, n) => new Date(y, m - 1, d, h, n, 0, 0).getTime();

test('what is saved is checked: time, date, weekdays, hours, where and what', () => {
  const ok = { kind: 'daily', at: '9:05', target: 'folder', cwd: 'C:\\work', prompt: '整理昨天的進度\n第二行' };
  const v = clean(ok).value;
  assert.deepStrictEqual([v.at, v.name, v.fallback, v.skipPermissions, v.enabled, v.sessionId], ['09:05', '整理昨天的進度', 'notify', false, true, '']);   // asking stays on, and only telling you is the fallback, unless said
  for (const [patch, msg] of [[{ kind: 'x' }, /什麼時候/], [{ at: '25:00' }, /24 小時制/], [{ at: '' }, /24 小時制/], [{ prompt: '  ' }, /做什麼/], [{ cwd: '' }, /資料夾/],
    [{ kind: 'once', date: '' }, /日期/], [{ kind: 'weekly', days: [] }, /至少選一天/], [{ kind: 'every', everyHours: 0 }, /1 到 168/], [{ kind: 'every', everyHours: 2.5 }, /1 到 168/],
    [{ target: 'session', sessionId: 'not an id' }, /要接續的 session/]]) assert.match(clean(Object.assign({}, ok, patch)).error, msg);
  assert.match(clean(ok, () => false).error, /資料夾不存在/);
  // a date typed (the board's date field is a text field): a day that is not is refused, not moved into the next month
  for (const d of ['2027-02-31', '2027-13-01', '2027-2-3']) assert.match(clean(Object.assign({}, ok, { kind: 'once', date: d })).error, /沒有這一天|日期/, d);
  assert.strictEqual(clean(Object.assign({}, ok, { kind: 'once', date: '2028-02-29' })).value.date, '2028-02-29');
  assert.deepStrictEqual(clean(Object.assign({}, ok, { kind: 'weekly', days: [5, 1, 1, 9] })).value.days, '1,5');
  const s = clean(Object.assign({}, ok, { target: 'session', sessionId: 'fcddb7be-012a-460b-bb6e-4ca9c9f93b75', sessionTitle: 'x', fallback: 'fork', skipPermissions: true })).value;
  assert.deepStrictEqual([s.target, s.sessionId, s.fallback, s.skipPermissions], ['session', 'fcddb7be-012a-460b-bb6e-4ca9c9f93b75', 'fork', true]);
});

test('when a schedule is next due', () => {
  const now = at(2026, 11, 15, 12, 0);                                    // a Sunday, noon
  assert.strictEqual(new Date(now).getDay(), 0);
  assert.strictEqual(nextRun({ kind: 'daily', at: '13:30' }, now), at(2026, 11, 15, 13, 30));       // later today
  assert.strictEqual(nextRun({ kind: 'daily', at: '09:00' }, now), at(2026, 11, 16, 9, 0));         // already past: tomorrow
  assert.strictEqual(nextRun({ kind: 'daily', at: '12:00' }, now), at(2026, 11, 16, 12, 0));        // this very minute has gone
  assert.strictEqual(nextRun({ kind: 'weekly', at: '09:00', days: '1,3' }, now), at(2026, 11, 16, 9, 0));   // Monday
  assert.strictEqual(nextRun({ kind: 'weekly', at: '09:00', days: '0' }, now), at(2026, 11, 22, 9, 0));     // today's time has passed: next Sunday
  assert.strictEqual(nextRun({ kind: 'weekly', at: '18:00', days: '0' }, now), at(2026, 11, 15, 18, 0));
  assert.strictEqual(nextRun({ kind: 'once', at: '08:00', date: '2026-11-20' }, now), at(2026, 11, 20, 8, 0));
  assert.strictEqual(nextRun({ kind: 'once', at: '08:00', date: '2026-11-10' }, now), 0);            // a one-off in the past is never due again
  assert.strictEqual(nextRun({ kind: 'every', everyHours: 4, updatedAt: at(2026, 11, 15, 7, 0) }, now), at(2026, 11, 15, 15, 0));   // 7, 11, [15]
  assert.strictEqual(nextRun({ kind: 'every', everyHours: 4, updatedAt: now }, now), at(2026, 11, 15, 16, 0));
});

test('the list: saved, changed, switched off, removed', () => {
  const d = tmp(); const S = new Schedules(path.join(d, 'b.db'));
  const now = at(2026, 11, 15, 12, 0);
  const id = S.save(clean({ kind: 'daily', at: '09:00', target: 'folder', cwd: d, prompt: '早安' }).value, null, now);
  const id2 = S.save(clean({ kind: 'once', at: '08:00', date: '2026-11-10', target: 'folder', cwd: d, prompt: '過期的' }).value, null, now);
  assert.deepStrictEqual(S.list(now).map((s) => [s.id, s.name, s.next]), [[id, '早安', at(2026, 11, 16, 9, 0)], [id2, '過期的', 0]]);
  assert.strictEqual(S.save(clean({ kind: 'daily', at: '10:00', name: '改名', target: 'folder', cwd: d, prompt: '早安' }).value, id, now), id);
  assert.deepStrictEqual([S.get(id).name, S.get(id).at, S.list(now).length], ['改名', '10:00', 2]);
  assert.strictEqual(S.setEnabled(id, false), true);
  assert.deepStrictEqual([S.get(id).enabled, S.list(now)[0].next], [false, 0]);                      // switched off: not due
  assert.deepStrictEqual([S.remove(id2), S.remove(999), S.list(now).length], [true, false, 1]);
  assert.strictEqual(new Schedules(path.join(d, 'b.db')).list(now).length, 1);                       // it is in the database: there after a restart
});

test('the plain kinds across a change of clocks: the next and last run on the right calendar day (review 2026-11-20)', (t) => {
  const { lastDue } = require('../lib/schedule');
  const was = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    if (new Date(2027, 10, 7).getTimezoneOffset() === new Date(2027, 10, 8).getTimezoneOffset()) { t.skip('這台電腦沒有時區資料，換時日的情況測不了'); return; }   // said as skipped, not passed (review 2026-11-20)
    const at = (y, m, d, h, n) => new Date(y, m - 1, d, h, n).getTime();
    const daily = (t) => ({ kind: 'daily', at: t, days: '' });
    // 2027-11-07 has 25 hours, 2027-03-14 has 23
    assert.strictEqual(nextRun(daily('23:45'), at(2027, 11, 6, 23, 50)), at(2027, 11, 7, 23, 45));
    assert.strictEqual(nextRun(daily('00:15'), at(2027, 11, 7, 0, 20)), at(2027, 11, 8, 0, 15));
    assert.strictEqual(nextRun(daily('23:45'), at(2027, 3, 13, 23, 50)), at(2027, 3, 14, 23, 45));
    assert.strictEqual(nextRun({ kind: 'weekly', at: '00:15', days: '0' }, at(2027, 11, 1, 9, 0)), at(2027, 11, 7, 0, 15), 'Sunday the 7th');
    assert.strictEqual(nextRun({ kind: 'monthly', at: '00:15', days: '7' }, at(2027, 10, 8, 1, 0)), at(2027, 11, 7, 0, 15));
    assert.strictEqual(lastDue(daily('23:45'), at(2027, 11, 8, 10, 0)), at(2027, 11, 7, 23, 45));
    assert.strictEqual(lastDue({ kind: 'monthly', at: '23:45', days: '7' }, at(2027, 12, 1, 0, 0)), at(2027, 11, 7, 23, 45));
  } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});

test('monthly: on the days of the month chosen, the last day, and a day a month does not have on its last day', () => {
  const { lastDue } = require('../lib/schedule');
  const at = (y, m, d, h = 9, n = 0) => new Date(y, m - 1, d, h, n).getTime();
  const base = { kind: 'monthly', at: '09:00', target: 'folder', cwd: __dirname, prompt: 'p' };
  assert.strictEqual(clean(Object.assign({ days: [15, 1, 1, 40, 0] }, base)).value.days, '1,15', 'sorted, once each, out of range left out');
  assert.strictEqual(clean(Object.assign({ days: [] }, base)).error, '每月至少選一天');
  const s = { kind: 'monthly', at: '09:00', days: '1,15' };
  assert.strictEqual(nextRun(s, at(2026, 11, 20, 12)), at(2026, 12, 1));
  assert.strictEqual(nextRun(s, at(2026, 12, 1, 8)), at(2026, 12, 1), 'later that day');
  assert.strictEqual(lastDue(s, at(2026, 11, 20, 12)), at(2026, 11, 15));
  // the last day (32), and 31 in a month without it
  assert.strictEqual(nextRun({ kind: 'monthly', at: '18:00', days: '32' }, at(2027, 2, 3)), at(2027, 2, 28, 18));
  assert.strictEqual(nextRun({ kind: 'monthly', at: '18:00', days: '31' }, at(2027, 2, 3)), at(2027, 2, 28, 18));
  assert.strictEqual(nextRun({ kind: 'monthly', at: '18:00', days: '31' }, at(2027, 3, 1)), at(2027, 3, 31, 18));
  assert.strictEqual(nextRun({ kind: 'monthly', at: '18:00', days: '30,32' }, at(2027, 2, 27)), at(2027, 2, 28, 18), 'two days falling on one: once');
  assert.strictEqual(nextRun({ kind: 'monthly', at: '18:00', days: '30,32' }, at(2027, 2, 28, 19)), at(2027, 3, 30, 18));
  assert.strictEqual(nextRun({ kind: 'monthly', at: '00:30', days: '29' }, at(2028, 2, 10)), at(2028, 2, 29, 0, 30), 'a leap year has the 29th');
  assert.strictEqual(lastDue({ kind: 'monthly', at: '09:00', days: '31' }, at(2026, 12, 5)), at(2026, 11, 30), 'November has no 31st: its 30th');
});
