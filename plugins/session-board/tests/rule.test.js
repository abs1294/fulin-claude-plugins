'use strict';
// node --test plugins/session-board/tests/rule.test.js - a schedule's own rule (lib/rule.js) and working days by the
// country chosen (lib/workdays.js), on a Taiwan calendar made up for the test: 2027 with New Year's Day off, a bridge holiday on Monday 2027-03-01
// made up on Saturday 2027-02-20, and the last days of April off
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-'));
process.env.USERPROFILE = HOME; process.env.HOME = HOME;
const Cal = require('../lib/workdays');
const R = require('../lib/rule');

const W = ['日', '一', '二', '三', '四', '五', '六'];
function year(y, off, worked) {
  const out = [];
  for (let d = new Date(y, 0, 1); d.getFullYear() === y; d.setDate(d.getDate() + 1)) {
    const k = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const wkEnd = d.getDay() === 0 || d.getDay() === 6;
    out.push({ date: String(k), week: W[d.getDay()], isHoliday: worked.includes(k) ? false : off[k] !== undefined ? true : wkEnd, description: off[k] || (worked.includes(k) ? '補行上班' : '') });
  }
  return out;
}
fs.mkdirSync(Cal.DIR(), { recursive: true });
// as lib/workdays.js keeps it: only the days that differ from Monday to Friday
fs.writeFileSync(path.join(Cal.DIR(), 'TW-2027.json'), JSON.stringify({ country: 'TW', year: 2027, off: { 20270101: '開國紀念日', 20270301: '彈性放假', 20270428: '假', 20270429: '假', 20270430: '假' }, on: { 20270220: '補行上班' } }));
Cal.setCountry('TW');

const T = (y, m, d, h = 0, n = 0) => new Date(y, m - 1, d, h, n).getTime();
const show = (ts) => ts.map((x) => { const d = new Date(x.at || x); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); });
const up = (o, now, made, n = 5) => { const c = R.check(o); assert.ok(c.ok, c.error); return show(R.upcoming(c.rule, now, made, n)); };

test('working days: holidays off, a make-up Saturday worked, a year without a calendar Monday to Friday', () => {
  assert.strictEqual(Cal.isWorkday(new Date(2027, 0, 1)), false);   // New Year's Day, a Friday
  assert.strictEqual(Cal.isWorkday(new Date(2027, 1, 20)), true);   // a Saturday made up
  assert.strictEqual(Cal.note(new Date(2027, 1, 20)), '補行上班');
  assert.strictEqual(Cal.isWorkday(new Date(2027, 2, 1)), false);
  assert.strictEqual(Cal.known(2027), true); assert.strictEqual(Cal.known(2031), false);
  assert.strictEqual(Cal.isWorkday(new Date(2031, 0, 1)), true, 'no calendar: a Wednesday is taken to be worked');
});

test('the kinds of rule the plain choices cannot say', () => {
  const now = T(2027, 1, 1, 8);
  // two times a day, on working days only: the holiday is left out
  assert.deepStrictEqual(up({ cron: '0 9,14 * * *', workday: 'only' }, now), ['1/4 09:00', '1/4 14:00', '1/5 09:00', '1/5 14:00', '1/6 09:00']);
  // every 2 hours in office hours, Monday to Friday
  assert.deepStrictEqual(up({ cron: '0 9-18/2 * * 1-5' }, T(2027, 1, 4, 12), 0, 5), ['1/4 13:00', '1/4 15:00', '1/4 17:00', '1/5 09:00', '1/5 11:00']);
  // every 30 minutes
  assert.deepStrictEqual(up({ cron: '*/30 * * * *' }, T(2027, 1, 4, 12, 10), 0, 3), ['1/4 12:30', '1/4 13:00', '1/4 13:30']);
  // the last working day of the month: April's last days are off, so the 27th
  assert.deepStrictEqual(up({ cron: '0 15 LW * *' }, T(2027, 4, 1), 0, 2), ['4/27 15:00', '5/31 15:00']);
  // the first working day: January 1st is off, so the 4th; March 1st is off, so the 2nd
  assert.deepStrictEqual(up({ cron: '0 9 FW * *' }, now, 0, 3), ['1/4 09:00', '2/1 09:00', '3/2 09:00']);
  // the first Monday, the last Friday
  assert.deepStrictEqual(up({ cron: '0 10 * * 1#1' }, now, 0, 3), ['1/4 10:00', '2/1 10:00', '3/1 10:00']);
  assert.deepStrictEqual(up({ cron: '0 10 * * 5L' }, now, 0, 3), ['1/29 10:00', '2/26 10:00', '3/26 10:00']);
  // the last day, three days before it
  assert.deepStrictEqual(up({ cron: '0 18 L * *' }, T(2027, 2, 1), 0, 2), ['2/28 18:00', '3/31 18:00']);
  assert.deepStrictEqual(up({ cron: '0 18 L-3 * *' }, T(2027, 2, 1), 0, 2), ['2/25 18:00', '3/28 18:00']);
  // every other Wednesday, from the 6th
  assert.deepStrictEqual(up({ cron: '0 10 * * 3', everyWeeks: 2, from: '2027-01-06' }, now, 0, 3), ['1/6 10:00', '1/20 10:00', '2/3 10:00']);
  // every quarter, on the 1st: from January
  assert.deepStrictEqual(up({ cron: '0 9 1 * *', everyMonths: 3, from: '2027-01-01' }, now, 0, 3), ['1/1 09:00', '4/1 09:00', '7/1 09:00']);
  // once a year
  assert.deepStrictEqual(up({ cron: '0 9 31 3 *' }, now, 0, 2), ['3/31 09:00'].concat(['3/31 09:00']));
  // until a day, and a number of runs
  assert.deepStrictEqual(up({ cron: '0 9 * * *', until: '2027-01-03' }, now), ['1/1 09:00', '1/2 09:00', '1/3 09:00']);
  assert.deepStrictEqual(up({ cron: '0 9 * * *', count: 2 }, now, now), ['1/1 09:00', '1/2 09:00']);
  // only on days off
  assert.deepStrictEqual(up({ cron: '0 11 * * *', workday: 'off' }, T(2027, 2, 18), 0, 3), ['2/21 11:00', '2/27 11:00', '2/28 11:00']);
});

test('next and last: what the runner asks', () => {
  const r = R.check({ cron: '0 9 * * *', count: 2 }).rule, made = T(2027, 1, 1, 8);
  assert.strictEqual(R.next(r, T(2027, 1, 1, 10), made), T(2027, 1, 2, 9));
  assert.strictEqual(R.next(r, T(2027, 1, 2, 10), made), 0, 'its two runs are over');
  assert.strictEqual(R.last(r, T(2027, 1, 5, 10), made), T(2027, 1, 2, 9), 'the last of its runs');
  assert.strictEqual(R.last(r, T(2027, 1, 1, 8, 30), made), 0, 'none yet');
  const w = R.check({ cron: '0 9 * * *', workday: 'only' }).rule;
  assert.strictEqual(R.last(w, T(2027, 1, 3, 12), T(2026, 12, 1)), T(2026, 12, 31, 9), 'over the weekend and the holiday: the last working day');
});

test('what is refused, said plainly', () => {
  const no = (o) => R.check(o).error;
  assert.match(no({ cron: '0 9 * *' }), /5 欄/);
  assert.match(no({ cron: '* * * * *' }), /5 分鐘/);
  assert.match(no({ cron: '0,3 * * * *' }), /5 分鐘/);
  assert.match(no({ cron: '0 25 * * *' }), /時欄超出範圍/);
  assert.match(no({ cron: '0 9 * * 8' }), /星期欄/);
  assert.match(no({ cron: '0 9 x * *' }), /日欄看不懂/);
  assert.match(no({ cron: '0 9 * * *', everyWeeks: 2, everyMonths: 2 }), /只能選一個/);
  assert.match(no({ cron: '0 9 * * *', from: '2027-02-01', until: '2027-01-01' }), /之前/);
  assert.match(no({ cron: '0 9 * * *', count: 0.5 }), /次數/);
  assert.deepStrictEqual(R.check({ cron: ' 0  9 * * 1-5 ', everyWeeks: 1, text: '平日早上九點' }).rule, { cron: '0 9 * * 1-5', text: '平日早上九點' });
});

test('the calendar is fetched once a day, kept, and a broken answer is not kept', async () => {
  const dir = path.join(HOME, 'cal2'); let asked = 0;
  const good = { ok: true, status: 200, json: async () => year(2026, { 20260101: '開國紀念日' }, [20260207]) }, bad = { ok: true, status: 200, json: async () => [{ date: 'x' }] };
  const r1 = await Cal.refresh({ dir, country: 'TW', now: T(2026, 6, 1), fetch: async (u) => { asked++; return /2026/.test(u) ? good : bad; } });
  assert.deepStrictEqual([r1.got, r1.failed, asked], [[2026], [2027], 2]);
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'TW-2026.json'), 'utf8'));
  assert.deepStrictEqual([kept.off['20260101'], kept.on['20260207'], Object.keys(kept.off).length], ['開國紀念日', '補行上班', 1], 'only the days that differ from Monday to Friday');
  assert.ok(!fs.existsSync(path.join(dir, 'TW-2027.json')));
  const r2 = await Cal.refresh({ dir, country: 'TW', now: T(2026, 6, 1), fetch: async () => { asked++; return bad; } });
  assert.deepStrictEqual([r2.got, r2.failed, asked], [[], [2027], 3], 'this year is fresh: only the missing year is asked for again');
  // another country: Nager.Date's public holidays (the nationwide ones), Saturday and Sunday off
  const nager = [{ date: '2026-01-01', localName: '元日', global: true, types: ['Public'] }, { date: '2026-03-02', localName: '地方', global: false, types: ['Public'] }, { date: '2026-03-03', localName: '銀行', global: true, types: ['Bank'] }];
  const urls = [];
  const r3 = await Cal.refresh({ dir, country: 'JP', now: T(2026, 6, 1), fetch: async (u) => { urls.push(u); return /2026/.test(u) ? { ok: true, status: 200, json: async () => nager } : { ok: true, status: 204, json: async () => null }; } });
  assert.deepStrictEqual([r3.got, r3.failed, urls.every((u) => u.startsWith('https://date.nager.at/api/v3/PublicHolidays/'))], [[2026], [2027], true]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'JP-2026.json'), 'utf8')).off, { 20260101: '元日' });
  // none chosen: nothing fetched, Monday to Friday
  assert.deepStrictEqual(await Cal.refresh({ dir, country: '', fetch: async () => { throw new Error('asked'); } }), { got: [], failed: [] });
});

test('a sentence: asked of Claude once, once more when the answer cannot be read', async () => {
  const P = require('../lib/ruleparse');
  const { EventEmitter } = require('events');
  const fake = (answers) => { const calls = []; return { calls, spawn: (bin, args) => { calls.push(args); const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {}; p.stderr = new EventEmitter(); p.kill = () => {};
    p.stdin = { on: () => {}, end: (input) => { calls[calls.length - 1].input = input; const a = answers.shift(); setImmediate(() => { p.stdout.emit('data', JSON.stringify({ result: a })); p.emit('close'); }); } }; return p; } }; };
  const f1 = fake(['not json at all', '{"cron":"0 15 LW * *","explain":"x"}']);
  const r1 = await P.ask('A', { spawn: f1.spawn });
  assert.deepStrictEqual([r1.ok, r1.rule.cron, f1.calls.length], [true, '0 15 LW * *', 2]);
  assert.ok(f1.calls[0].includes('--tools') && f1.calls[0][f1.calls[0].indexOf('--tools') + 1] === '', 'no tools');
  assert.match(f1.calls[0].input, /"A"/, 'the sentence goes in as a JSON string');
  const f2 = fake(['nope', 'still nope']);
  const r2 = await P.ask('B', { spawn: f2.spawn });
  assert.deepStrictEqual([r2.ok, f2.calls.length, r2.again], [false, 2, undefined]);
  const f3 = fake(['{"error":"不是排程"}']);
  const r3 = await P.ask('C', { spawn: f3.spawn });
  assert.deepStrictEqual([r3.ok, r3.error, f3.calls.length], [false, '看不懂這句排程：不是排程', 1], 'not a schedule: not asked again');
});

test('the country chosen: its holidays, or none (Monday to Friday)', () => {
  try {
    Cal.setCountry('');
    assert.strictEqual(Cal.isWorkday(new Date(2027, 0, 1)), true, 'no country: New Year\'s Day, a Friday, is worked');
    assert.strictEqual(Cal.isWorkday(new Date(2027, 1, 20)), false, 'no country: a Saturday is off');
    assert.deepStrictEqual([Cal.known(2031), Cal.note(new Date(2027, 0, 1))], [true, '']);
    assert.deepStrictEqual(R.guessedYears(R.check({ cron: '0 9 * * *', workday: 'only' }).rule, T(2027, 1, 1)), [], 'nothing to guess when none is chosen');
    Cal.setCountry('xx'); assert.strictEqual(Cal.country(), '', 'not a country code: none');
    assert.strictEqual(Cal.okCountry('JP') && Cal.okCountry('') && !Cal.okCountry('jp') && !Cal.okCountry('JPN'), true);
  } finally { Cal.setCountry('TW'); }
});

test('the list of countries: Nager.Date\'s, kept 30 days, with Taiwan added', async () => {
  const dir = path.join(HOME, 'cal3'); let asked = 0;
  const get = async () => { asked++; return { ok: true, status: 200, json: async () => [{ countryCode: 'JP', name: 'Japan' }, { countryCode: 'US', name: 'United States' }, { countryCode: 'bad', name: 'x' }] }; };
  const a = await Cal.countries({ dir, fetch: get, now: T(2026, 6, 1) });
  assert.deepStrictEqual(a.map((x) => x.code), ['JP', 'TW', 'US']);
  await Cal.countries({ dir, fetch: get, now: T(2026, 6, 20) });
  assert.strictEqual(asked, 1, 'kept: not asked again within 30 days');
  const off = await Cal.countries({ dir, fetch: async () => { throw new Error('offline'); }, now: T(2026, 9, 1) });
  assert.deepStrictEqual(off.map((x) => x.code), ['JP', 'TW', 'US'], 'offline: the kept list');
});

test('review 2026-11-20: counted from the moment made, February 29th found years ahead, days that are not, L-n kept to 27', () => {
  // made at noon: that morning's 09:00 is not one of its three runs
  const r = R.check({ cron: '0 9 * * *', count: 3 }).rule, made = T(2027, 1, 4, 12);
  assert.deepStrictEqual(show(R.upcoming(r, made, made, 5)), ['1/5 09:00', '1/6 09:00', '1/7 09:00']);
  assert.strictEqual(R.last(r, T(2027, 1, 10), made), T(2027, 1, 7, 9));
  // February 29th: the next one four years on, not "never"
  const leap = R.check({ cron: '0 9 29 2 *' }).rule;
  assert.strictEqual(R.next(leap, T(2028, 3, 1), T(2028, 3, 1)), T(2032, 2, 29, 9));
  assert.strictEqual(R.next(R.check({ cron: '0 9 31 2 *' }).rule, T(2027, 1, 1)), 0, 'a day that never comes: never');
  // days that are not
  assert.match(R.check({ cron: '0 9 * * *', from: '2028-02-30' }).error, /開始日期/);
  assert.match(R.check({ cron: '0 9 * * *', until: '2027-13-01' }).error, /結束日期/);
  assert.strictEqual(R.check({ cron: '0 9 * * *', until: '2028-02-29' }).ok, true);
  // L-n
  assert.match(R.check({ cron: '0 9 L-28 * *' }).error, /L-1～L-27/);
  assert.match(R.check({ cron: '0 9 L-0 * *' }).error, /L-1～L-27/);
  assert.strictEqual(R.check({ cron: '0 9 L-27 * *' }).ok, true);
});

test('a count added to a schedule that has been running: counted from that save, the weeks where they were (asked 2026-11-20)', () => {
  const made = T(2027, 1, 4, 8), edit = T(2027, 2, 1, 12);   // made on a Monday; edited four weeks on
  const before = R.check({ cron: '0 9 * * 1' }).rule, after = R.check({ cron: '0 9 * * 1', count: 3 }).rule;
  const r = R.stamp(after, before, edit);
  assert.strictEqual(r.countFrom, edit, 'the rule changed: counted from now');
  assert.deepStrictEqual(show(R.upcoming(r, edit, made, 5)), ['2/8 09:00', '2/15 09:00', '2/22 09:00'], 'three more, not "already done"');
  assert.deepStrictEqual(show(R.upcoming(after, edit, made, 5)), [], 'as it was: counted from when it was made, over');
  assert.strictEqual(R.next(r, T(2027, 2, 22, 10), made), 0, 'after the three: no more');
  assert.strictEqual(R.last(r, T(2027, 3, 10), made), T(2027, 2, 22, 9), 'the last of the three');
  assert.strictEqual(R.last(r, T(2027, 2, 1, 13), made), T(2027, 2, 1, 9), 'the runs before the count started are still runs it had');
  // only the words changed: the count goes on where it was
  const again = R.stamp(Object.assign({}, after, { text: '每週一早上九點，三次' }), r, T(2027, 2, 10));
  assert.strictEqual(again.countFrom, edit);
  // the count changed: from that save
  assert.strictEqual(R.stamp(R.check({ cron: '0 9 * * 1', count: 5 }).rule, r, T(2027, 2, 10)).countFrom, T(2027, 2, 10));
  // every 2 weeks keeps its weeks: counted from when it was made, not from the edit
  const two = R.stamp(R.check({ cron: '0 9 * * 1', everyWeeks: 2, count: 2 }).rule, before, T(2027, 1, 13));
  assert.deepStrictEqual(show(R.upcoming(two, T(2027, 1, 13), made, 5)), ['1/18 09:00', '2/1 09:00']);
  // no count: none kept; a rule saved before there was countFrom: as it was; one sent from the page: not taken
  assert.strictEqual('countFrom' in R.stamp(before, r, edit), false);
  assert.strictEqual('countFrom' in R.stamp(after, after, edit), false);
  assert.strictEqual(R.stamp(Object.assign({ countFrom: 1 }, after), null, edit).countFrom, edit);
  assert.strictEqual(R.check(Object.assign({ countFrom: 1 }, after)).rule.countFrom, undefined);
});

test('the years whose working days are a guess: also those of the runs shown, years ahead', () => {
  const r = R.check({ cron: '0 9 29 2 *', workday: 'only' }).rule;
  const now = T(2027, 3, 1), runs = R.upcoming(r, now, now, 2).map((x) => x.at);
  assert.ok(runs.length && new Date(runs[0]).getFullYear() >= 2028);
  const g = R.guessedYears(r, now, runs);
  assert.ok(g.includes(new Date(runs[0]).getFullYear()), 'the year of the run shown: ' + g.join(','));
  assert.ok(!g.includes(2027), 'a year whose calendar is there is not a guess');
});

test('review 2026-11-20: a day where clocks change is 23 or 25 hours - the last day is the calendar day', (t) => {
  // (in a zone with summer time; restored after)
  const was = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    if (new Date(2027, 10, 7).getTimezoneOffset() === new Date(2027, 10, 8).getTimezoneOffset()) { t.skip('這台電腦沒有時區資料，換時日的情況測不了'); return; }   // said as skipped, not passed (review 2026-11-20)
    const at = (x) => new Date(x.at).getDate();
    const r = R.check({ cron: '30 23 * * *', until: '2027-11-07' }).rule, now = new Date(2027, 10, 6, 12).getTime();
    assert.deepStrictEqual(R.upcoming(r, now, now, 5).map(at), [6, 7], 'the 25-hour day keeps its 23:30');
    const r2 = R.check({ cron: '30 0 * * *', until: '2027-03-14' }).rule, n2 = new Date(2027, 2, 13, 12).getTime();
    assert.deepStrictEqual(R.upcoming(r2, n2, n2, 5).map(at), [14], 'the 23-hour day does not run into the next');
    assert.strictEqual(R.last(R.check({ cron: '0 9 * * *' }).rule, new Date(2027, 2, 15, 8).getTime(), new Date(2027, 2, 1).getTime()), new Date(2027, 2, 14, 9).getTime(), 'going back over it, day by day');
  } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});
