'use strict';
// "Edit and send again" for a board conversation: where in its transcript to carry it on from, so that the edited
// message takes the place of the one you said there.
//
// Claude Code carries a conversation on from a given entry with --resume <id> --resume-session-at <entry uuid>
// (with --fork-session, under a new id; the original is left as it was). Measured 2026-11-18 on 2.1.327: a two-turn
// conversation carried on from the first reply knew only what was said before it.
//
// The place is the newest whole place before the message, found by walking back its parentUuid chain: a reply in
// words that calls no tool (the end of a turn), or a tool's result (a message said while it worked, or after it was
// stopped, comes after one). Measured 2026-11-18 on 2.1.327, carrying a conversation on from: a tool's result - it
// knew the tool's output; the call of a tool before its result - no error, but the call was gone (it "had not seen"
// the output); a reply's thinking part (one reply is written as several entries) - it knew the output that came after
// that point, so where such a place really ends cannot be told. None (the first message) means a conversation that
// starts afresh. A message from before the last compaction cannot be gone back to: Claude Code holds only the summary
// of what came before it.
const fs = require('fs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -> {ok: true, at: '<uuid of the whole place>' | null, after?: <byte offset where the line after it starts>} | {ok: false, error}
// (after: carried on in place, what the transcript holds from there on is the way gone back from - see lib/history.js hide)
function resumePoint(file, uuid) {
  if (!UUID.test(String(uuid || ''))) return { ok: false, error: '缺少要編輯的那則訊息' };
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { ok: false, error: '讀不到這個對話的紀錄' }; }
  const by = new Map(), calling = new Set();   // calling: the replies (message ids) that call a tool in any of their entries
  let lastCompact = -1, line = 0, at = -1;
  const ends = new Map();   // uuid -> byte offset just past its line
  for (let s = 0; s < buf.length;) {
    let k = buf.indexOf(10, s); if (k < 0) k = buf.length;
    const raw = buf.toString('utf8', s, k), next = k + 1; s = next;
    line++;
    if (!raw.trim()) continue;
    let e; try { e = JSON.parse(raw); } catch (x) { continue; }
    if (!e || typeof e.uuid !== 'string') continue;
    const mid = e.type === 'assistant' && e.message && typeof e.message.id === 'string' ? e.message.id : '';
    if (mid && Array.isArray(e.message.content) && e.message.content.some((b) => b && b.type === 'tool_use')) calling.add(mid);
    ends.set(e.uuid, Math.min(next, buf.length));
    by.set(e.uuid, { type: e.type, parent: typeof e.parentUuid === 'string' ? e.parentUuid : null, line, said: said(e), whole: whole(e), mid });
    if ((e.type === 'system' && e.subtype === 'compact_boundary') || (e.type === 'user' && e.isCompactSummary)) lastCompact = line;
    if (e.uuid === uuid) at = line;
  }
  const me = by.get(uuid);
  if (!me) return { ok: false, error: '這則訊息在對話紀錄裡找不到（可能還沒寫進去，等一下再試）' };
  if (!me.said) return { ok: false, error: '只有你自己打的訊息可以編輯' };
  if (lastCompact > at) return { ok: false, error: '這則在對話被壓縮之前，Claude Code 只留下摘要，沒辦法回到這裡重來' };
  for (let p = me.parent, n = 0; p && n < 100000; n++) {
    const e = by.get(p);
    if (!e) break;
    if (e.whole && !(e.mid && calling.has(e.mid))) return { ok: true, at: p, after: ends.get(p) };   // words of a reply that goes on to call a tool: part of a reply, not its end
    p = e.parent;
  }
  return { ok: true, at: null };
}
// Which of these the board itself told it of (a message of its own that begins with it - not merely mentioned, not quoted
// by Claude) between two places of the transcript: carried on in place, the part gone back from - a collaboration's
// notice there is no longer known to it and is told again. -> [words]
// (read a megabyte at a time, however long that part is; a line is looked at only when it may hold the board's words -
// written as they are, or as \\u escapes)
const MARKS = [Buffer.from('看板自動送出'), Buffer.from('\\u770b\\u677f')];
function told(file, from, to, words) {
  if (!words.length || !(to > from)) return [];
  const had = new Set();
  const look = (line) => {
    if (!MARKS.some((m) => line.includes(m))) return;
    let e; try { e = JSON.parse(line.toString('utf8')); } catch (x) { return; }
    const b = boardSaid(e); for (const w of words) if (b.includes(w)) had.add(w);
  };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    // (a line longer than a notice can be - a picture's data, megabytes long - is skipped to its end, not gathered whole)
    let pos = from, carry = Buffer.alloc(0), skipping = false;
    while (pos < to) {
      const b = Buffer.alloc(Math.min(1024 * 1024, to - pos)), n = fs.readSync(fd, b, 0, b.length, pos);
      if (n <= 0) break;
      pos += n;
      let chunk = b.subarray(0, n);
      if (skipping) { const k = chunk.indexOf(10); if (k < 0) continue; skipping = false; chunk = chunk.subarray(k + 1); }
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let s = 0;
      for (let k; (k = data.indexOf(10, s)) >= 0; s = k + 1) look(data.subarray(s, k));
      carry = Buffer.from(data.subarray(s));
      if (carry.length > 1024 * 1024) { carry = Buffer.alloc(0); skipping = true; }
    }
    if (carry.length) look(carry);
  } catch (e) { return words.filter((w) => had.has(w)); } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
  return words.filter((w) => had.has(w));
}
// The parts gone back from, with one more: overlapping or touching ones as one, in order (kept whole - with a cap the
// oldest came back on the page once there were more than it)
function addRange(list, r) {
  const ok = (x) => Array.isArray(x) && Number.isSafeInteger(x[0]) && Number.isSafeInteger(x[1]) && x[0] >= 0 && x[1] > x[0];   // (a damaged entry in the saved list is left out)
  const all = (Array.isArray(list) ? list : []).concat([r]).filter(ok).map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of all) { const last = out[out.length - 1]; if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push(x); }
  return out;
}
function boardSaid(e) {
  // (said while it worked: an attachment; to a session in a terminal: inside a message from another session)
  const c = e.type === 'attachment' ? e.attachment && e.attachment.type === 'queued_command' && e.attachment.prompt : e.type === 'user' && e.message ? e.message.content : '';
  const t = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '').replace(/^\s*(Another Claude session sent a message:\s*)?(<cross-session-message\b[^>]*>)?\s*/, '');
  return t.startsWith('（看板自動送出）') ? t.slice(0, 60) : '';
}

// a whole place to carry on from: a reply in words that calls no tool, or a tool's result (one entry by itself; the
// reply it belongs to is judged in resumePoint: one written as several entries that calls a tool is not whole anywhere)
function whole(e) {
  if (e.isSidechain || !e.message || !Array.isArray(e.message.content)) return false;
  const c = e.message.content, has = (t) => c.some((b) => b && b.type === t);
  if (e.type === 'assistant') return has('text') && !has('tool_use');
  return e.type === 'user' && has('tool_result');
}

// what you typed: a user entry of words (not a tool's result, not a summary, not a notice), or one said while it worked
function said(e) {
  if (e.isSidechain || e.isMeta) return false;
  if (e.type === 'attachment') return !!(e.attachment && e.attachment.type === 'queued_command');
  if (e.type !== 'user' || e.isCompactSummary || !e.message) return false;
  const c = e.message.content;
  if (typeof c === 'string') return !!c.trim();
  return Array.isArray(c) && c.some((b) => b && (b.type === 'text' || b.type === 'image')) && !c.some((b) => b && b.type === 'tool_result');
}

module.exports = { resumePoint, told, addRange, UUID };
