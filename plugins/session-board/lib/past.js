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
function scanPiece(buf, skipFirst, out) {
  let start = 0;
  if (skipFirst) { const i = buf.indexOf(10); if (i < 0) return; start = i + 1; }
  while (start < buf.length) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = buf.length;
    const line = buf.subarray(start, end);
    start = end + 1;
    if (line.length < 2) continue;
    const isUser = line.indexOf(USER) >= 0;
    if (!isUser && out.cwd) continue;
    let j;
    try { j = JSON.parse(line.toString('utf8')); } catch (e) { continue; }
    if (!out.cwd && typeof j.cwd === 'string' && j.cwd) out.cwd = j.cwd;
    if (isUser && j.type === 'user' && j.isMeta !== true && !j.isSidechain && j.message) {
      const t = said(j.message.content);
      if (t) { if (!out.first) out.first = t; out.last = t; out.lastAt = Date.parse(j.timestamp) || out.lastAt; }
    }
  }
}

function readEnds(file, size) {
  const out = { cwd: '', first: '', last: '', lastAt: 0 };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const read = (pos, len) => { const b = Buffer.allocUnsafe(len); let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, pos + got); if (n <= 0) break; got += n; } return b.subarray(0, got); };
    if (size <= HEAD + TAIL) scanPiece(read(0, size), false, out);
    else {
      const head = { cwd: '', first: '', last: '', lastAt: 0 };
      scanPiece(read(0, HEAD), false, head);
      const tail = { cwd: head.cwd || 'x', first: '', last: '', lastAt: 0 };
      scanPiece(read(size - TAIL, TAIL), true, tail);
      out.cwd = head.cwd; out.first = head.first; out.last = tail.last || head.last; out.lastAt = tail.lastAt || head.lastAt;
    }
  } catch (e) {
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
  return out;
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
      if (line.indexOf('"type":"user"') < 0 && line.indexOf('"type":"assistant"') < 0) continue;
      let e; try { e = JSON.parse(line); } catch (x) { continue; }
      if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta || !e.message) continue;
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
  return { sessionId: f.sessionId, cwd: e.cwd, folder: e.cwd ? path.basename(e.cwd) : '', title: t.custom || t.ai || e.first || '', named: !!(t.custom || t.ai), first: e.first, last: e.last, at: f.mtimeMs, size: f.size };
}

// o: {projectsDir, exclude: Set of session ids (open now, hidden), q, limit, now}
// -> {items, total, matched}. A conversation in which you never said anything is left out.
function list(o) {
  const now = o.now || Date.now();
  const all = files(o.projectsDir, now - DAYS * 86400000).filter((f) => !(o.exclude && o.exclude.has(f.sessionId)));
  const q = String(o.q || '').trim().toLowerCase();
  const limit = o.limit || 40;
  const items = [];
  let matched = 0;
  for (const f of all) {
    // Without a search only the rows shown are read; a search has to look at every one.
    if (!q && items.length >= limit) break;
    const d = describe(f);
    if (!d.cwd || !d.first) continue;
    if (q && !(d.title + '\n' + d.folder + '\n' + d.first + '\n' + d.last).toLowerCase().includes(q)) continue;
    matched++;
    if (items.length < limit) items.push(d);
  }
  return { items, total: all.length, matched: q ? matched : null };
}

// One conversation by id, or null.
function find(projectsDir, sid) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(sid))) return null;
  const f = files(projectsDir, 0).find((x) => x.sessionId === sid);
  return f ? describe(f) : null;
}

module.exports = { interrupted, list, find, lastSaid, said, ends, DAYS };
