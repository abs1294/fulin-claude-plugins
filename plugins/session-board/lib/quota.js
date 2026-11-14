'use strict';
// How much of the account's usage limits is used: the 5-hour and 7-day windows.
//
// These limits are global to the account, not per session. cc-statusline
// already collects what each terminal session was last told and shares it in
// ~/.claude/rate-limit-snapshots.json ({sid: {t, five_hour, seven_day}}, each
// window {used_percentage, resets_at}). This reads that file and picks the
// figure the same way statusline.js does, so the board and the status line show
// the same number:
//   1. keep windows that have not reset yet (and are not absurdly far ahead);
//   2. sessions can disagree on which window is current, so take the reset
//      time most of them agree on;
//   3. within it, the highest percentage anyone has seen.
// Conversations the board runs report the same limits directly
// (rate_limit_event); those are passed in as one more observation.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SNAPSHOT_FILE = path.join(os.homedir(), '.claude', 'rate-limit-snapshots.json');
const MAX_FUTURE_SEC = 8 * 86400;

function pick(observations, nowSec) {
  const live = observations.filter((s) => s && typeof s.used_percentage === 'number' && Number.isFinite(s.resets_at)
    && s.resets_at > nowSec && s.resets_at - nowSec <= MAX_FUTURE_SEC);
  if (!live.length) return null;
  const votes = new Map();
  for (const s of live) votes.set(s.resets_at, (votes.get(s.resets_at) || 0) + 1);
  let bestR = 0, bestVotes = 0;
  for (const [r, v] of votes) if (v > bestVotes || (v === bestVotes && r > bestR)) { bestVotes = v; bestR = r; }
  let max = 0;
  for (const s of live) if (s.resets_at === bestR && s.used_percentage > max) max = s.used_percentage;
  return { pct: Math.round(max), resetsAt: bestR * 1000 };
}

// extra: observations from the board's own conversations, [{t, five_hour, seven_day}].
function readQuota(extra = [], file = SNAPSHOT_FILE, now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  let snaps = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) snaps = Object.values(j).filter((s) => s && typeof s === 'object');
  } catch (e) {}
  snaps = snaps.concat((extra || []).filter(Boolean));
  if (!snaps.length) return { fiveHour: null, sevenDay: null, seenAt: 0 };
  // When the freshest of these figures was observed: a board left open with no session active shows an old number.
  const seenAt = Math.max(0, ...snaps.map((s) => (Number.isFinite(s.t) ? s.t * 1000 : 0)));
  return { fiveHour: pick(snaps.map((s) => s.five_hour), nowSec), sevenDay: pick(snaps.map((s) => s.seven_day), nowSec), seenAt };
}

// A rate_limit_event from a conversation the board runs -> one observation in the snapshot file's shape.
function fromEvent(info, now = Date.now()) {
  if (!info || typeof info !== 'object') return null;
  const win = (w) => (w && typeof w.utilization === 'number' && Number.isFinite(w.resetsAt) ? { used_percentage: w.utilization * 100, resets_at: w.resetsAt } : null);
  const u = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  const out = { t: Math.floor(now / 1000), five_hour: win(u.five_hour), seven_day: win(u.seven_day) };
  // Older shape: one window, named by rateLimitType.
  if (!out.five_hour && !out.seven_day && (info.rateLimitType === 'five_hour' || info.rateLimitType === 'seven_day')) out[info.rateLimitType] = win(info);
  return out.five_hour || out.seven_day ? out : null;
}

module.exports = { readQuota, fromEvent, pick, SNAPSHOT_FILE };
