'use strict';
// Conversations that are not open now: every main transcript under
// ~/.claude/projects touched in the last DAYS days. Listed so one can be found
// and opened again.
//
// A transcript can be hundreds of megabytes, so only its two ends are read:
// the first HEAD bytes give the folder it ran in and the first thing you said,
// the last TAIL bytes the latest thing you said. What was read is remembered
// until the file changes.
//
// Searching looks at the title, the folder, and those two sentences. It does
// not read the whole conversation.
const fs = require('fs');
const path = require('path');
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';   // either kind of slash (a path written on Windows, read on a Mac)
const S = require('./sessions');

const DAYS = 30;
const HEAD = 256 * 1024;
const TAIL = 512 * 1024;

// What you typed, on one line; '' for the things Claude Code puts in the user's
// place (<command-name>…, <task-notification>…, tool results).
function said(content) {
  let t = '';
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) t = content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ');
  t = t.replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.startsWith('<') ? '' : t.slice(0, 200);
}

const USER = Buffer.from('"type":"user"');
const QUEUED = Buffer.from('"type":"queued_command"');
const { queuedSaid } = require('./history');
function scanPiece(buf, skipFirst, out) {
  let start = 0;
  if (skipFirst) { const i = buf.indexOf(10); if (i < 0) return; start = i + 1; }
  while (start < buf.length) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = buf.length;
    const line = buf.subarray(start, end);
    start = end + 1;
    if (line.length < 2) continue;
    const isUser = line.indexOf(USER) >= 0, isMid = line.indexOf(QUEUED) >= 0;
    if (!isUser && !isMid && out.cwd) continue;
    let j;
    try { j = JSON.parse(line.toString('utf8')); } catch (e) { continue; }
    // said while a turn was running: recorded as an attachment, not as a user entry (lib/history.js queuedSaid)
    if (isMid) { const q = queuedSaid(j); if (q && q.text) { const t = said(q.text); if (t) { if (!out.first) out.first = t; out.last = t; out.lastAt = Date.parse(j.timestamp) || out.lastAt; } } }
    if (!out.cwd && typeof j.cwd === 'string' && j.cwd) out.cwd = j.cwd;
    // how it was started: 'cli' (a terminal window) anywhere wins - a program's conversation resumed in a terminal is yours
    if (typeof j.entrypoint === 'string' && j.entrypoint && out.entry !== 'cli') out.entry = j.entrypoint;
    if (isUser && j.type === 'user' && j.isMeta !== true && !j.isSidechain && !notSaid(j) && j.message) {
      // the first message's form: the board sends what you type as content blocks (stream-json); a program running
      // `claude -p "..."` is recorded with a plain string. Tells the board's own conversations from programs' runs.
      if (out.blocks === null) out.blocks = Array.isArray(j.message.content);
      const t = said(j.message.content);
      if (t) { if (!out.first) out.first = t; out.last = t; out.lastAt = Date.parse(j.timestamp) || out.lastAt; }
    }
  }
}

function readEnds(file, size) {
  const out = { cwd: '', first: '', last: '', lastAt: 0, entry: '', blocks: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const read = (pos, len) => { const b = Buffer.allocUnsafe(len); let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, pos + got); if (n <= 0) break; got += n; } return b.subarray(0, got); };
    if (size <= HEAD + TAIL) scanPiece(read(0, size), false, out);
    else {
      const head = { cwd: '', first: '', last: '', lastAt: 0, entry: '', blocks: null };
      scanPiece(read(0, HEAD), false, head);
      const tail = { cwd: head.cwd || 'x', first: '', last: '', lastAt: 0, entry: '', blocks: null };
      scanPiece(read(size - TAIL, TAIL), true, tail);
      out.cwd = head.cwd; out.first = head.first; out.last = tail.last || head.last; out.lastAt = tail.lastAt || head.lastAt;
      out.entry = head.entry === 'cli' || tail.entry === 'cli' ? 'cli' : head.entry || tail.entry;
      out.blocks = head.blocks;
    }
  } catch (e) {
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
  return out;
}

// When YOU last said something in a conversation (0: never). What the left list is ordered by.
//
// Not taken from ends(): that looks at the two ends of the file only, and in a long turn everything Claude did since
// your last message is far more than the end holds (measured 2026-11-16: of ten open sessions, four came out as
// "never"). Here the file is read backward from its end until a message of yours is met (at most BACK_CAP). After
// that only what has been added to the file is read: a session at work grows all the time, and is asked about every
// second.
// Not yours: what the board sent in your place - the "carry on" sentences after a restart, a limit or an error.
const BY_BOARD = /^（看板自動送出）/;
const BACK_CAP = 96 * 1024 * 1024;
const GROW_MAX = 8 * 1024 * 1024;       // more than this added at once: read backward again instead
const { eachLineBackward } = require('./history');
function saidLineAt(line) {
  const isUser = line.indexOf(USER) >= 0, isMid = line.indexOf(QUEUED) >= 0;
  if (!isUser && !isMid) return 0;
  let j; try { j = JSON.parse(line.toString('utf8')); } catch (e) { return 0; }
  let text = null, pic = false;
  if (isMid) { const q = queuedSaid(j); if (q) { text = said(q.text); pic = q.blocks.some((b) => b && b.type === 'image'); } }
  if (text === null && j.type === 'user' && j.isMeta !== true && !j.isSidechain && !notSaid(j) && j.message) {
    text = said(j.message.content);
    pic = Array.isArray(j.message.content) && j.message.content.some((b) => b && b.type === 'image');
  }
  if (text === null || (!text && !pic) || BY_BOARD.test(text)) return 0;
  return Date.parse(j.timestamp) || 0;
}
const saidCache = new Map();   // file -> {size: bytes read so far (whole lines only), at}
function saidAtOf(file) {
  let st; try { st = fs.statSync(file); } catch (e) { return 0; }
  const c = saidCache.get(file);
  if (c && st.size === c.seen) return c.at;
  if (c && st.size > c.size && st.size - c.size <= GROW_MAX) {
    // what was added since: read forward, whole lines only (the last one may still be being written)
    let fd, at = c.at, size = c.size;
    try {
      fd = fs.openSync(file, 'r');
      const len = st.size - c.size, buf = Buffer.allocUnsafe(len);
      let got = 0; while (got < len) { const n = fs.readSync(fd, buf, got, len - got, c.size + got); if (n <= 0) break; got += n; }
      let start = 0;
      for (;;) { const end = buf.indexOf(10, start); if (end < 0 || end >= got) break; const t = saidLineAt(buf.subarray(start, end)); if (t) at = t; start = end + 1; }
      size = c.size + start;
    } catch (e) { return c.at; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
    saidCache.set(file, { size, seen: st.size, at });
    return at;
  }
  let at = 0;
  eachLineBackward(file, BACK_CAP, (line) => { const t = saidLineAt(line); if (t) { at = t; return false; } return true; });
  saidCache.set(file, { size: st.size, seen: st.size, at });
  return at;
}

const cache = new Map();   // file -> {size, mtimeMs, ends}
function ends(file, st) {
  if (!st) { try { st = fs.statSync(file); } catch (e) { return { cwd: '', first: '', last: '', lastAt: 0 }; } }
  const c = cache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.ends;
  const e = readEnds(file, st.size);
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, ends: e });
  return e;
}

// An entry filed as "user" that nobody said: the summary Claude Code writes when it compacts a conversation
// (isCompactSummary), and anything else it marks as there for the record only. A compaction is often the last
// thing in the transcript of a session that was sitting idle - taking it for "your message, still unanswered"
// made four idle sessions get the "carry on" sentence after the restart of 2026-11-15.
const notSaid = (e) => e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true;

// Was this conversation cut off in the middle of a turn? Read from the end of its transcript: the last thing
// in it is either Claude finishing a reply (not cut off), or something Claude still owed an answer to - your
// message, a tool's result, or a tool call that never got its result (cut off). A turn you stopped yourself
// ("Request interrupted by user") is not one to pick up again.
function interrupted(file) {
  let fd, last = null;
  try {
    const size = fs.statSync(file).size, len = Math.min(size, TAIL);
    fd = fs.openSync(file, 'r');
    const b = Buffer.allocUnsafe(len);
    let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, size - len + got); if (n <= 0) break; got += n; }
    const lines = b.subarray(0, got).toString('utf8').split('\n');
    if (size > len) lines.shift();   // the first line of a piece cut out of the middle is half a line
    for (const line of lines) {
      if (line.indexOf('"type":"user"') < 0 && line.indexOf('"type":"assistant"') < 0 && line.indexOf('"type":"queued_command"') < 0) continue;
      let e; try { e = JSON.parse(line); } catch (x) { continue; }
      // something you said while a turn was running counts as a message of yours still owed an answer
      { const q = queuedSaid(e); if (q) { last = { type: 'user', message: { content: q.text || '（圖片）' } }; continue; } }
      if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta || notSaid(e) || !e.message) continue;
      last = e;
    }
  } catch (e) { return false; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
  if (!last) return false;
  const c = last.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && (x.text || (typeof x.content === 'string' ? x.content : ''))) || '').join(' ') : '';
  if (last.type === 'user') return !/Request interrupted by user/.test(text) && !/^\s*<(command-name|local-command)/.test(text);
  if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_use')) return true;
  return !last.message.stop_reason;   // a reply still being written when it was cut off has no stop reason yet
}

// The latest thing you said in a conversation (for the line under its name).
const lastSaid = (file) => (file ? ends(file).last : '');

// Main transcripts touched since `since`, newest first: [{file, sessionId, size, mtimeMs}].
function files(projectsDir, since) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(projectsDir, d.name)); } catch (e) { continue; }
    for (const n of names) {
      // agent-* are subagents' own records: `claude --resume` cannot open them.
      if (!n.endsWith('.jsonl') || n.startsWith('agent-')) continue;
      const sid = n.slice(0, -6);
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sid)) continue;
      const file = path.join(projectsDir, d.name, n);
      try { const st = fs.statSync(file); if (st.mtimeMs >= since && st.size > 0) out.push({ file, sessionId: sid, size: st.size, mtimeMs: st.mtimeMs }); } catch (e) {}
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function describe(f) {
  const e = ends(f.file, f);
  const t = S.cachedTitles(f.file);
  return { sessionId: f.sessionId, cwd: e.cwd, folder: e.cwd ? baseName(e.cwd) : '', title: t.custom || t.ai || e.first || '', named: !!(t.custom || t.ai), entry: e.entry || '', blocks: e.blocks === true, first: e.first, last: e.last, at: f.mtimeMs, size: f.size };
}

// o: {projectsDir, exclude: Set of session ids (open now, hidden), q, limit, now}
// -> {items, total, matched}. A conversation in which you never said anything is left out.
function list(o) {
  const now = o.now || Date.now();
  const all = files(o.projectsDir, now - DAYS * 86400000).filter((f) => !(o.exclude && o.exclude.has(f.sessionId)));
  const q = String(o.q || '').trim().toLowerCase();
  const limit = o.limit || 40;
  const items = [];
  let matched = 0, hidden = 0;
  for (const f of all) {
    // Without a search only the rows shown are read; a search has to look at every one.
    if (!q && items.length >= limit) break;
    const d = describe(f);
    if (!d.cwd || !d.first) continue;
    if (o.hide && o.hide(d)) { hidden++; continue; }
    if (q && !(d.title + '\n' + d.folder + '\n' + d.first + '\n' + d.last).toLowerCase().includes(q)) continue;
    matched++;
    if (items.length < limit) items.push(d);
  }
  return { items, total: all.length, matched: q ? matched : null, programHidden: hidden };
}

// One conversation by id, or null.
function find(projectsDir, sid) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(sid))) return null;
  const f = files(projectsDir, 0).find((x) => x.sessionId === sid);
  return f ? describe(f) : null;
}

module.exports = { interrupted, list, find, lastSaid, said, ends, saidAtOf, DAYS };
