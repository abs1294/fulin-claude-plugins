// How many times each conversation was compacted, read from its transcript, and how many of those the conversation it
// was copied from had had. Run by the usage records (lib-records.js collect: a conversation when it replies, every
// transcript every ten minutes). Its result goes into the public ~/.claude/cc-statusline/state/claude-compacts-<sid>.json;
// the board shows it and does not count anything itself (usage is gathered only here).
//
// Why (2026-11-28): a conversation copied from another - `claude --resume X --fork-session`, which session-board does for
// a 分身, a message edited and sent again and a schedule - starts from X's LAST compaction. Its transcript begins with
// X's compact_boundary (the same uuid, written before any message of its own) and a summary of everything before, and
// the copied replies say requestSessionId: X. The PreCompact hook had counted those compactions in X's file; the copy had
// no file, so the board said 「壓縮 0 次」 right under 「這之前的對話已被壓縮成摘要」 (measured: f0413fe1 copied from
// 7fd0b76b, b8fd77d2 from 369f5abe, 7ed3a525 from 8af4ce5f, all three on 2.1.332 through sdk-cli).
// Also counted: compactions the hook never saw - its file is gone (kept in %TEMP% before 1.7.0 and cleared by Windows,
// or not touched for 30 days) or the plugin was not there then: the transcript's own boundaries are a floor for count.
//
// Kept for each transcript (U/records/.own/compacts.json, ours, may change):
//   off      bytes read so far        conv  1 once the conversation's first message was passed
//   n        its own boundaries       ts    their times (ms), the newest 200
//   head     uuid of the boundary it was copied from (written before any message of its own), else ''
//   headAt   that boundary's time (ms) from  the conversation it was copied from ('' not told)   look  still looking for it
'use strict';
const fs = require('fs');
const path = require('path');

const BOUNDARY = Buffer.from('"compact_boundary"'), RSID = Buffer.from('"requestSessionId"'), NL = 10;
const CHUNK = 1 << 20;
const KEEP_TS = 200;
const LOOK_LINES = 3000;   // the copied part is near the head; past this many lines it is not looked for any more
const SID = /^[0-9a-zA-Z-]{8,80}$/;

const fresh = () => ({ off: 0, conv: 0, n: 0, ts: [], head: '', headAt: 0, from: '', look: 0 });
const parse = (b) => { try { const o = JSON.parse(b.toString('utf8')); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } };

// Reads t (a conversation's own transcript, {p, size}) on from st.off, whole lines only. -> the new st, or null: could not be read.
function scan(t, st0, sid) {
  const st = st0 && typeof st0 === 'object' && Number.isFinite(st0.off) && st0.off <= t.size ? Object.assign(fresh(), st0, { ts: Array.isArray(st0.ts) ? st0.ts.slice() : [] }) : fresh();
  if (st.off === t.size) return st;
  let fd; try { fd = fs.openSync(t.p, 'r'); } catch (e) { return null; }
  const buf = Buffer.allocUnsafe(CHUNK);
  let carry = [], pos = st.off, lines = 0;
  const line = (b) => {
    lines++;
    // Parsed: every line before the first message (a few at the head of a transcript), every line that names a
    // boundary, and while the conversation copied from is looked for, every line that names a request's session.
    // What a line IS comes from its parsed type, never from words in it (a message may well speak of compact_boundary).
    const hasB = b.indexOf(BOUNDARY) >= 0, looking = st.look > 0 && b.indexOf(RSID) >= 0;
    if (st.look > 0) st.look--;
    if (st.conv && !hasB && !looking) return;
    const o = parse(b);
    if (!o) return;
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const at = Date.parse(o.timestamp || '') || 0;
      if (!st.conv && !st.head) { st.head = String(o.uuid || '?').slice(0, 64); st.headAt = at; st.conv = 1; st.look = LOOK_LINES; return; }
      st.conv = 1; st.n++; st.ts.push(at); if (st.ts.length > KEEP_TS) st.ts.splice(0, st.ts.length - KEEP_TS);
      return;
    }
    if (o.type === 'user' || o.type === 'assistant') st.conv = 1;
    if (looking) { const r = o.requestSessionId; if (typeof r === 'string' && r !== sid && SID.test(r)) { st.from = r; st.look = 0; } }
  };
  try {
    while (pos < t.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, t.size - pos), pos);
      if (n <= 0) break;
      let from = 0;
      for (let i = buf.indexOf(NL, 0); i >= 0 && i < n; i = buf.indexOf(NL, from)) {
        const piece = buf.subarray(from, i), l = carry.length ? Buffer.concat([...carry, piece]) : piece;
        carry = []; from = i + 1; st.off = pos + from;
        line(l);
        if (from >= n) break;
      }
      if (from < n) carry.push(Buffer.from(buf.subarray(from, n)));
      pos += n;
    }
  } catch (e) { return null; } finally { try { fs.closeSync(fd); } catch (e) {} }
  return st;
}

// Everything known of one conversation: cps = {'<project>/<sid>.jsonl': st}, hook(sid) = its public file or null.
// -> { count, inherited, from, inheritedAt } ; count: its own (the hook's, at least the boundaries seen);
//    inherited: what the conversation it was copied from had had by then (0: not a copy of a compacted one)
// A conversation's: in its own project folder first, else in any (a copy may be made in another folder than its original's)
function stOf(cps, project, sid) {
  const own = cps[project + '/' + sid + '.jsonl']; if (own) return own;
  const tail = '/' + sid + '.jsonl', k = Object.keys(cps).find((x) => x.endsWith(tail));
  return k ? cps[k] : null;
}
function figures(cps, project, sid, hook, depth = 0) {
  const st = stOf(cps, project, sid), h = hook(sid);
  const count = Math.max(h && Number.isFinite(Number(h.count)) ? Number(h.count) : 0, st ? st.n : 0);
  let inherited = 0, from = '', inheritedAt = 0;
  if (st && st.head) {
    from = st.from || ''; inheritedAt = st.headAt || 0;
    inherited = Math.max(1, from && depth < 8 ? at(cps, project, from, st.headAt, hook, depth + 1) : 1);   // the copied boundary is one at least
  }
  return { count, inherited, from, inheritedAt };
}
// How many compactions conversation sid had had by time t (in all, with those it had carried over itself).
function at(cps, project, sid, t, hook, depth) {
  const st = stOf(cps, project, sid), h = hook(sid);
  if (!st && !h) return 1;   // nothing known of it any more: the boundary copied from it is one
  const f = figures(cps, project, sid, hook, depth);
  if (!st) return f.inherited + f.count;   // its transcript is gone, or untouched for longer than is read (so nothing after t): as many as it has now
  if (st.head && st.headAt && t <= st.headAt) return f.inherited;   // copied on from the very boundary it was itself copied from
  const before = st.ts.filter((x) => x <= t).length, after = st.ts.filter((x) => x > t).length;
  return f.inherited + Math.max(before, f.count - after);
}

module.exports = { scan, figures, fresh };
