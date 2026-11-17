'use strict';
// A monthly budget for the API-equivalent cost the war room shows, and telling you when it is being reached.
//
// Settings (the board's database, key "budget"):
//   monthly   the budget for a calendar month, in US dollars. 0 (default) = no budget: nothing is said.
//   warnPct   the first point at which you are told (default 80). You are told again at 100.
// What has been said is remembered per month (key "budgetState"), so each point is said once a month, also
// across restarts of the board.
//
// decide() is the whole rule, with no clock and no disk of its own, so that it can be tested alone.

const DEFAULTS = { monthly: 0, warnPct: 80 };

function clean(v) {
  const s = v && typeof v === 'object' ? v : {};
  const monthly = Number(s.monthly), warnPct = Number(s.warnPct);
  return { monthly: Number.isFinite(monthly) && monthly > 0 ? Math.round(monthly * 100) / 100 : 0, warnPct: Number.isFinite(warnPct) && warnPct >= 10 && warnPct <= 99 ? Math.round(warnPct) : DEFAULTS.warnPct };
}

// o: {month: '2026-11', cost, day (of the month, 1-based, today), daysInMonth, settings, state: {month, told: [pct, …]}}
// -> {tell: {title, text} | null, state, pct, projected}
function decide(o) {
  const st = clean(o.settings), cost = Number(o.cost) || 0;
  const state = o.state && o.state.month === o.month && Array.isArray(o.state.told) ? { month: o.month, told: o.state.told.slice() } : { month: o.month, told: [] };
  const projected = o.day > 0 ? (cost / o.day) * o.daysInMonth : cost;
  if (!st.monthly) return { tell: null, state, pct: null, projected };
  const pct = (cost / st.monthly) * 100;
  const crossed = [st.warnPct, 100].filter((p) => pct >= p && !state.told.includes(p));
  if (!crossed.length) return { tell: null, state, pct, projected };
  const top = Math.max(...crossed);
  for (const p of [st.warnPct, 100]) if (pct >= p && !state.told.includes(p)) state.told.push(p);   // a jump past both says the higher one once
  const usd = (x) => '$' + Math.round(x).toLocaleString('en-US');
  const title = top >= 100 ? '本月費用已超過預算' : '本月費用已達預算的 ' + Math.floor(pct) + '%';
  const text = '本月 API 等值費用 ' + usd(cost) + '，預算 ' + usd(st.monthly) + '（' + Math.floor(pct) + '%）。照目前的速度，到月底約 ' + usd(projected) + '。';
  return { tell: { title, text }, state, pct, projected };
}

module.exports = { decide, clean, DEFAULTS };
