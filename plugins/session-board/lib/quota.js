'use strict';
// How much of the account's usage limits is used: the 5-hour and 7-day windows. Global to the account, not per session.
//
// Gathered by cc-statusline (1.9.0 and later), only read here (2026-11-24: 蒐集資料讓 cc-statusline 做，看板只讀), from the one
// file it keeps for everybody: ~/.claude/cc-statusline/state/account-limits.json, what Claude Code answered when asked, after
// an answer of a conversation in a terminal or on the board -
//   {v (1; without it: too old), at (ms), five_hour, seven_day, none}; a window {used_percentage, resets_at (s)}, resets_at null: none running now;
//   null: the account has no such limit; none: true: it has none at all (an API key)
// What each session was last told (rate-limit-snapshots.json) is cc-statusline's own: how old that is nobody can tell.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'cc-statusline', 'state', 'account-limits.json');

// What a window says now, as cc-statusline tells it: none (the account has no such limit), idle (none running), running, over
// (its time has passed), '' (not a window, or one absurdly far ahead).
function stateOf(w, nowSec) {
  if (w === null || w === undefined) return 'none';
  if (typeof w !== 'object' || typeof w.used_percentage !== 'number') return '';
  if (w.resets_at === null) return 'idle';
  if (typeof w.resets_at !== 'number' || w.resets_at - nowSec > 8 * 86400) return '';
  return w.resets_at > nowSec ? 'running' : 'over';
}
const load = (file, now) => {
  let a = null; try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  if (!a || typeof a !== 'object' || Array.isArray(a) || !(a.v >= 1)) return null;   // (no v: of before cc-statusline 1.9.0, not kept up to date)
  if (a.none === true) return { none: true };
  if (!Number.isFinite(a.at) || a.at <= 0 || a.at > now + 60000) return null;
  return { at: a.at, w5: a.five_hour, w7: a.seven_day, s5: stateOf(a.five_hour, now / 1000), s7: stateOf(a.seven_day, now / 1000) };
};
// -> {fiveHour, sevenDay: {pct, resetsAt (ms)} | null (none, or not running, or over), seenAt: when Claude Code said so (ms, 0:
//     never), from: 'asked' | 'none' (no such limits) | '' (nothing there)}
function readQuota(file = FILE, now = Date.now()) {
  const a = load(file, now); if (!a || a.none) return { fiveHour: null, sevenDay: null, seenAt: 0, from: a ? 'none' : '' };
  const win = (w, st) => (st === 'running' ? { pct: Math.round(w.used_percentage), resetsAt: w.resets_at * 1000 } : null);
  return { fiveHour: win(a.w5, a.s5), sevenDay: win(a.w7, a.s7), seenAt: a.at, from: 'asked' };
}

// "After the limit resets": which one that is (2026-11-24: 帳號沒有 5 小時額度時也改等 7 天; the same in goal2's delaylocal).
// -> {window: '5h' | '7d', at (ms), pct, full: the 7-day one is used up} or {error}
function waitFor(file = FILE, now = Date.now()) {
  const a = load(file, now), used = (w, st) => (st === 'running' || st === 'idle') && w.used_percentage >= 100;
  if (!a) return { error: '沒有額度資料，不知道什麼時候重置：需要 cc-statusline（1.9.0 以上），裝好或更新之後，下一次問答結束就會有' };
  if (a.none) return { error: '這個帳號沒有額度限制，不用等，直接選一個時間就好' };
  if (!a.s5 || !a.s7) return { error: '額度資料的格式不認得，請更新看板或 cc-statusline；先直接選一個時間' };
  if (a.s5 === 'none' && a.s7 === 'none') return { error: '查到的額度裡沒有可以等的，請直接選一個時間' };
  const five = { window: '5h', w: a.w5, st: a.s5, word: '5 小時' }, seven = { window: '7d', w: a.w7, st: a.s7, word: '7 天' };
  // which one: the 7-day one when it is used up (nothing runs before it resets, whatever the 5-hour one does); else the 5-hour
  // one, or where the account does not have that, the 7-day one
  const it = used(a.w7, a.s7) || a.s5 === 'none' ? seven : five, other = it === seven ? five : seven, full = it === seven && used(a.w7, a.s7);
  // what it says: running - wait; used up and not known until when; none running or just over - no need, if told within a day
  const of = (x, more) => Object.assign({ window: x.window, at: x.w.resets_at * 1000, pct: Math.round(x.w.used_percentage) }, more);
  if (it.st === 'running') return full && other.st === 'running' && other.w.resets_at > it.w.resets_at ? of(other) : of(it, full ? { full: true } : {});
  if (used(it.w, it.st)) return { error: it.word + '額度用完了，但查不到什麼時候重置。請直接選一個時間' };
  if (now - a.at < 86400000) return { error: '現在沒有 ' + it.word + '額度在計時（沒用到，或已經重置了），不用等，直接選一個時間就好' };
  return { error: '額度資料太舊，不知道現在的額度（有問答結束時 cc-statusline 才會再查）。請直接選一個時間' };
}

module.exports = { readQuota, waitFor, stateOf, FILE };
