'use strict';
// Conversations that are not open now: every main transcript under
// ~/.claude/projects touched in the last DAYS days (the earlier ones when asked
// for, and always when searching). Listed so one can be found and opened again.
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
function said(content, max = 200) {
  let t = '';
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) t = content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ');
  t = t.replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.startsWith('<') ? '' : t.slice(0, max);
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
      if (out.blocks === null) { out.blocks = Array.isArray(j.message.content); if (typeof j.promptSource === 'string') out.src = j.promptSource; }   // (promptSource: typed | queued by you, sdk by a program - Claude Code 2.1.18x and later)
      const t = said(j.message.content);
      if (t) { if (!out.first) out.first = t; out.last = t; out.lastAt = Date.parse(j.timestamp) || out.lastAt; }
    }
  }
}

function readEnds(file, size) {
  const out = { cwd: '', first: '', last: '', lastAt: 0, entry: '', src: '', blocks: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const read = (pos, len) => { const b = Buffer.allocUnsafe(len); let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, pos + got); if (n <= 0) break; got += n; } return b.subarray(0, got); };
    if (size <= HEAD + TAIL) scanPiece(read(0, size), false, out);
    else {
      const head = { cwd: '', first: '', last: '', lastAt: 0, entry: '', src: '', blocks: null };
      scanPiece(read(0, HEAD), false, head);
      const tail = { cwd: head.cwd || 'x', first: '', last: '', lastAt: 0, entry: '', src: '', blocks: null };
      scanPiece(read(size - TAIL, TAIL), true, tail);
      out.cwd = head.cwd; out.first = head.first; out.last = tail.last; out.lastAt = tail.lastAt;
      // nothing of yours in the end of it (a long turn since): the latest is further back than that - never the head's,
      // which is how the conversation began (2026-11-23: the line under a name showed the first thing said, 11 days old)
      out.deep = !tail.last;
      out.entry = head.entry === 'cli' || tail.entry === 'cli' ? 'cli' : head.entry || tail.entry;
      out.src = head.src; out.blocks = head.blocks;
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
// -> {at, text, board} | null; board: sent by the board in your place
function saidLine(line, max) {
  const isUser = line.indexOf(USER) >= 0, isMid = line.indexOf(QUEUED) >= 0;
  if (!isUser && !isMid) return null;
  let j; try { j = JSON.parse(line.toString('utf8')); } catch (e) { return null; }
  let text = null, pic = false;
  if (isMid) { const q = queuedSaid(j); if (q) { text = said(q.text, max); pic = q.blocks.some((b) => b && b.type === 'image'); } }
  if (text === null && j.type === 'user' && j.isMeta !== true && !j.isSidechain && !notSaid(j) && j.message) {
    text = said(j.message.content, max);
    pic = Array.isArray(j.message.content) && j.message.content.some((b) => b && b.type === 'image');
  }
  if (text === null || (!text && !pic)) return null;
  return { at: Date.parse(j.timestamp) || 0, text: text || '（圖片）', board: BY_BOARD.test(text) };
}
const saidCache = new Map();   // file -> {size: bytes read so far (whole lines only), seen, at, text, textAt}
// -> {at: when YOU last said something, text: the latest words put in (yours, or the board's in your place), textAt}
function saidOf(file) {
  let st; try { st = fs.statSync(file); } catch (e) { return { at: 0, text: '', textAt: 0 }; }
  const c = saidCache.get(file);
  if (c && st.size === c.seen) return c;
  if (c && st.size > c.size && st.size - c.size <= GROW_MAX) {
    // what was added since: read forward, whole lines only (the last one may still be being written)
    let fd, at = c.at, size = c.size, text = c.text, textAt = c.textAt;
    try {
      fd = fs.openSync(file, 'r');
      const len = st.size - c.size, buf = Buffer.allocUnsafe(len);
      let got = 0; while (got < len) { const n = fs.readSync(fd, buf, got, len - got, c.size + got); if (n <= 0) break; got += n; }
      let start = 0;
      for (;;) { const end = buf.indexOf(10, start); if (end < 0 || end >= got) break; const t = saidLine(buf.subarray(start, end)); if (t) { text = t.text; textAt = t.at; if (!t.board && t.at) at = t.at; } start = end + 1; }
      size = c.size + start;
    } catch (e) { return c; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
    const got = { size, seen: st.size, at, text, textAt };
    saidCache.set(file, got);
    return got;
  }
  let at = 0, text = '', textAt = 0;
  eachLineBackward(file, BACK_CAP, (line) => {
    const t = saidLine(line); if (!t) return true;
    if (!text) { text = t.text; textAt = t.at; }
    if (t.board || !t.at) return true;   // the board's words: what you said yourself is further back
    at = t.at; return false;
  });
  const got = { size: st.size, seen: st.size, at, text, textAt };
  saidCache.set(file, got);
  return got;
}
const saidAtOf = (file) => saidOf(file).at;

const cache = new Map();   // file -> {size, mtimeMs, ends}
function ends(file, st) {
  if (!st) { try { st = fs.statSync(file); } catch (e) { return { cwd: '', first: '', last: '', lastAt: 0 }; } }
  const c = cache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.ends;
  const e = readEnds(file, st.size);
  if (e.deep) { const d = saidOf(file); e.last = d.text; e.lastAt = d.textAt; }
  delete e.deep;
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
const lastSaid = (file) => (file ? saidOf(file).text : '');

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
      try { const st = fs.statSync(file); if (st.mtimeMs >= since && st.size > 0) out.push({ file, dir: d.name, sessionId: sid, size: st.size, mtimeMs: st.mtimeMs }); } catch (e) {}
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function describe(f) {
  const e = ends(f.file, f);
  const t = S.cachedTitles(f.file);
  return { sessionId: f.sessionId, cwd: e.cwd, folder: e.cwd ? baseName(e.cwd) : '', title: t.custom || t.ai || e.first || '', named: !!(t.custom || t.ai), entry: e.entry || '', blocks: e.blocks === true, src: e.src || '', first: e.first, last: e.last, at: f.mtimeMs, size: f.size };
}

// o: {projectsDir, exclude: Set of session ids (open now, hidden), q, limit, now, days}
// -> {items, total, matched, days, older, olderDirs}. A conversation in which you never said anything is left out.
// days: how far back (DAYS when not given; 0 = all). A search always looks at all of them, however old (asked
// 2026-11-19: "when searching, never limit the time"). older / olderDirs: how many conversations are left out as
// older, in all and by their folder under projectsDir (Claude Code's name for a folder: every character that is not
// a letter or a digit made "-") - so the page can offer the earlier ones, read only when asked for.
// (olderDirs keys in lower case: matched against a folder's path made the same way, see dirKey)
function listing(o) {
  const now = o.now || Date.now();
  const q = String(o.q || '').trim().toLowerCase();
  const days = q ? 0 : (o.days === undefined ? DAYS : Math.max(0, Number(o.days) || 0));
  const since = days ? now - days * 86400000 : 0;
  const every = files(o.projectsDir, 0).filter((f) => !(o.exclude && o.exclude.has(f.sessionId)));
  const all = since ? every.filter((f) => f.mtimeMs >= since) : every;
  const olderDirs = {}; let older = 0;
  if (since) for (const f of every) if (f.mtimeMs < since) { older++; const k = f.dir.toLowerCase(); olderDirs[k] = (olderDirs[k] || 0) + 1; }
  const st = { o, q, all, limit: o.limit || 40, items: [], matched: 0, hidden: 0 };
  st.done = () => ({ items: st.items, total: all.length, matched: q ? st.matched : null, programHidden: st.hidden, days, older, olderDirs });
  // one transcript; false when no more are needed
  st.one = (f) => {
    // Without a search only the rows shown are read; a search has to look at every one.
    if (!q && st.items.length >= st.limit) return false;
    const d = describe(f);
    if (!d.cwd || !d.first) return true;
    if (o.hide && o.hide(d)) { st.hidden++; return true; }
    // o.names: names given on the board ({sessionId: name}) - found by them too, not only by Claude Code's titles
    const given = o.names && typeof o.names[d.sessionId] === 'string' ? o.names[d.sessionId] : '';
    // o.deep: session id -> where in it you said it (lib/saidindex.js); the title, the folder, the first and latest words as before
    const deep = q && o.deep ? o.deep.get(d.sessionId) : null;
    if (deep) d.hit = deep;   // {who, text}
    if (q && !deep && !(given + '\n' + d.title + '\n' + d.folder + '\n' + d.first + '\n' + d.last).toLowerCase().includes(q)) return true;
    st.matched++;
    if (st.items.length < st.limit) st.items.push(d);
    return true;
  };
  return st;
}
function list(o) {
  const st = listing(o);
  for (const f of st.all) if (!st.one(f)) break;
  return st.done();
}
// The same, giving the board's other work its turn every few transcripts: looking through all of them (a search, the
// earlier ones asked for) reads the ends of some thousand files the first time - seconds - and the board would stand
// still meanwhile (review 2026-11-19).
async function listAsync(o) {
  const st = listing(o);
  let n = 0;
  for (const f of st.all) { if (!st.one(f)) break; if (++n % 20 === 0) await new Promise((r) => setImmediate(r)); }
  return st.done();
}
// A folder's key in olderDirs: Claude Code's name for it (every character not a letter or digit made "-"), lower case,
// without a slash at the end.
const dirKey = (cwd) => String(cwd || '').replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-').toLowerCase();

// One conversation by id, or null.
function find(projectsDir, sid) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(sid))) return null;
  const f = files(projectsDir, 0).find((x) => x.sessionId === sid);
  return f ? describe(f) : null;
}

// Which of these ids - whole, or the first 8 or more characters of one (replies often name a conversation by its
// first 8: "session `b4a05eb5`") - are conversations on this computer. A short one counts only when it fits exactly one.
// Finding them reads only the names in the folders (kept for a minute); each one found is then read for its folder and
// title (the start and end of its record, as the list of old conversations does) - at most 20 a time.
// -> {key: {sessionId, cwd, folder, title}} for the ones found
let nameIndex = { at: 0, dir: '', list: [] };
function which(projectsDir, keys, now = Date.now()) {
  if (nameIndex.dir !== projectsDir || now - nameIndex.at > 60000) {
    const list = [];
    let dirs = []; try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch (e) {}
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let names = []; try { names = fs.readdirSync(path.join(projectsDir, d.name)); } catch (e) { continue; }
      for (const n of names) if (n.endsWith('.jsonl') && !n.startsWith('agent-') && /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i.test(n)) list.push({ sid: n.slice(0, -6).toLowerCase(), file: path.join(projectsDir, d.name, n) });
    }
    nameIndex = { at: now, dir: projectsDir, list };
  }
  const out = {};
  for (const raw of [...new Set((keys || []).map((k) => String(k).toLowerCase()))].slice(0, 20)) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(raw)) continue;
    const hits = nameIndex.list.filter((x) => x.sid.startsWith(raw));
    if (hits.length !== 1) continue;
    let st; try { st = fs.statSync(hits[0].file); } catch (e) { continue; }
    if (!st.size) continue;
    const d = describe({ file: hits[0].file, sessionId: hits[0].sid, size: st.size, mtimeMs: st.mtimeMs });
    out[raw] = { sessionId: d.sessionId, cwd: d.cwd, folder: d.folder, title: d.title };
  }
  return out;
}

module.exports = { interrupted, list, listAsync, dirKey, files, find, which, lastSaid, said, ends, saidAtOf, saidOf, saidLine, DAYS };
