'use strict';
// Conversation history of one session, read from the END of its transcript.
//
// A transcript is mostly not conversation: a three-message exchange measured
// 440 KB (2026-11-12) because every API request is logged beside it, and long
// sessions reach hundreds of MB. So this walks backwards line by line, keeps
// only user / assistant lines, and stops once it has enough messages or has
// read `cap` bytes. Nothing here ever loads the whole file.
const fs = require('fs');

const CHUNK = 1024 * 1024;

// Calls onLine(buffer) for each complete line, last line first. onLine returns
// false to stop. Reads at most `cap` bytes.
function eachLineBackward(file, cap, onLine) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);   // the start of a line whose beginning is in an earlier chunk
    let read = 0;
    while (pos > 0 && read < cap) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, pos + got);
        if (n <= 0) break;
        got += n;
      }
      read += got;
      const data = carry.length ? Buffer.concat([buf.subarray(0, got), carry]) : buf.subarray(0, got);
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        if (end > i + 1 && onLine(data.subarray(i + 1, end)) === false) return;
        end = i;
      }
      carry = Buffer.from(data.subarray(0, end));
      if (pos === 0 && carry.length) onLine(carry);
    }
  } catch (e) {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

const USER_MARK = Buffer.from('"type":"user"');
const ASSISTANT_MARK = Buffer.from('"type":"assistant"');

// Text the harness puts into user turns that the person did not type.
const NOT_TYPED = /^\s*<(system-reminder|task-notification|local-command-|command-name|command-message|command-args|user-prompt-submit-hook)/;

const oneLine = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// What a tool call was about, in a few words, from whichever input field says it best.
function toolSummary(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['description', 'file_path', 'command', 'pattern', 'url', 'query', 'prompt', 'skill', 'path']) {
    if (typeof input[k] === 'string' && input[k]) return oneLine(input[k], 110);
  }
  for (const v of Object.values(input)) if (typeof v === 'string' && v) return oneLine(v, 110);
  return '';
}

// The questions of an AskUserQuestion call, reduced to what is shown: Claude
// asking you to choose, as a form with a few options per question.
function questionsOf(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : [];
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return qs.filter((q) => q && typeof q.question === 'string' && q.question).slice(0, 8).map((q) => ({
    question: str(q.question, 600), header: str(q.header, 60), multiSelect: !!q.multiSelect,
    options: (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o.label === 'string' && o.label).slice(0, 12)
      .map((o) => ({ label: str(o.label, 200), description: str(o.description, 400) })),
  }));
}

// One transcript entry -> zero or more display items.
function itemsOf(e) {
  if (!e || e.isSidechain || e.isMeta || !e.message) return [];
  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0;
  const id = typeof e.uuid === 'string' ? e.uuid : '';
  const c = e.message.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  const out = [];
  // When Claude Code compacts a conversation it writes the summary into the
  // transcript as a "user" entry (isCompactSummary). Nobody typed it: shown as
  // a bubble it was a screenful of system text (seen 2026-11-12). It becomes a
  // marker instead, so the page can draw a line where the compaction happened.
  if (e.type === 'user' && e.isCompactSummary) return [{ id, role: 'compact', ts }];
  if (e.type === 'user') {
    const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string' && !NOT_TYPED.test(b.text))
      .map((b) => b.text).join('\n').trim();
    if (text) out.push({ id, role: 'user', text, ts });
    // The answers to a question form. They come back as a tool result whose
    // sentence varies ("Your questions have been answered: ..." in one place,
    // "The user answered: ..." in another, both seen 2026-11-12), so the
    // sentence is not parsed: the entry also carries the answers as data.
    const ans = e.toolUseResult && e.toolUseResult.answers;
    if (ans && typeof ans === 'object' && !Array.isArray(ans)) {
      const pairs = Object.entries(ans).filter(([q, a]) => typeof q === 'string' && typeof a === 'string').slice(0, 8)
        .map(([q, a]) => ({ question: q.slice(0, 600), answer: a.slice(0, 1200) }));
      if (pairs.length) out.push({ id: id + ':a', role: 'answered', answers: pairs, ts });
    }
  } else if (e.type === 'assistant') {
    // Token usage of the API message this entry belongs to. One API message is
    // written as several entries (one per content block), each repeating the
    // same usage, so `mid` is carried along for whoever adds these up.
    const mu = e.message.usage;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const u = mu && typeof mu === 'object' && typeof e.message.id === 'string'
      ? { mid: e.message.id, model: typeof e.message.model === 'string' ? e.message.model : '', in: n(mu.input_tokens), out: n(mu.output_tokens), cr: n(mu.cache_read_input_tokens), cw: n(mu.cache_creation_input_tokens) }
      : undefined;
    blocks.forEach((b, i) => {
      if (!b) return;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ id: id + ':' + i, role: 'assistant', text: b.text, ts, u });
      // A question form is not a tool call to fold away: it is Claude waiting on you.
      else if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && questionsOf(b.input).length) out.push({ id: id + ':' + i, role: 'ask', questions: questionsOf(b.input), ts, u });
      else if (b.type === 'tool_use') out.push({ id: id + ':' + i, role: 'tool', tool: String(b.name || ''), text: toolSummary(b.input), ts, u });
    });
  }
  return out;
}

// Last `max` display items, oldest first. `more` says older ones exist.
function readHistory(file, o = {}) {
  const max = o.max || 120;
  const cap = o.cap || 32 * 1024 * 1024;
  const groups = [];   // newest first; each group is one entry's items in order
  let count = 0;
  let more = false;
  eachLineBackward(file, cap, (line) => {
    if (line.indexOf(USER_MARK) < 0 && line.indexOf(ASSISTANT_MARK) < 0) return true;
    let e;
    try { e = JSON.parse(line.toString('utf8')); } catch (x) { return true; }
    if (e.type !== 'user' && e.type !== 'assistant') return true;
    const items = itemsOf(e);
    if (!items.length) return true;
    if (count >= max) { more = true; return false; }
    groups.push(items);
    count += items.length;
    return true;
  });
  return { items: groups.reverse().flat(), more };
}

const cache = new Map();
function cachedHistory(file, o) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { items: [], more: false }; }
  const key = file + '|' + ((o && o.max) || '');
  const c = cache.get(key);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.res;
  const res = readHistory(file, o);
  cache.delete(key);
  cache.set(key, { size: st.size, mtimeMs: st.mtimeMs, res });
  // One entry per session being looked at or listed in the war room; drop the oldest beyond that.
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return res;
}

module.exports = { eachLineBackward, itemsOf, toolSummary, questionsOf, readHistory, cachedHistory };
