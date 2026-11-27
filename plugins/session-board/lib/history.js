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

// Calls onLine(buffer, offset) for each complete line, last line first (offset: where the line starts in the file).
// onLine returns false to stop. Reads at most `cap` bytes.
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
        if (end > i + 1 && onLine(data.subarray(i + 1, end), pos + i + 1) === false) return;
        end = i;
      }
      carry = Buffer.from(data.subarray(0, end));
      if (pos === 0 && carry.length) onLine(carry, 0);
    }
  } catch (e) {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

const USER_MARK = Buffer.from('"type":"user"');
const ASSISTANT_MARK = Buffer.from('"type":"assistant"');
const QUEUED_MARK = Buffer.from('"type":"queued_command"');   // something said while a turn was running (queuedSaid)

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

// What a tool call was asked to do, in full enough to check it afterwards: the command of a Bash call, the content
// a Write put in a file, what an Edit replaced with what; for anything else its plain inputs. Bounded, since a
// file written can be large. '' when there is nothing to show.
function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return '';
  const cut = (v, n) => { const t = String(v); return t.length > n ? t.slice(0, n) + '\n…（還有 ' + (t.length - n) + ' 個字沒有顯示）' : t; };
  const s = (k) => (typeof input[k] === 'string' ? input[k] : '');
  let out;
  if (s('command')) out = (s('description') ? '# ' + s('description') + '\n' : '') + cut(s('command'), 4000);
  else if (name === 'Write' && s('file_path')) out = s('file_path') + '\n\n' + cut(s('content'), 4000);
  else if (s('file_path') && (s('old_string') || s('new_string'))) out = s('file_path') + '\n\n－ 原本\n' + cut(s('old_string'), 2000) + '\n\n＋ 改成\n' + cut(s('new_string'), 2000);
  else out = Object.entries(input).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && v !== '').map(([k, v]) => k + ': ' + cut(v, 800)).join('\n');
  return out.slice(0, 9000);
}

// The detail of one tool call of a transcript, found by the id the page has for it ("<entry uuid>:<block index>").
// Read backward from the end, at most `cap` bytes. -> {tool, detail} or null.
function toolDetailAt(file, itemId, cap = 64 * 1024 * 1024) {
  const m = /^([0-9a-f-]{8,64}):(\d{1,3})$/i.exec(String(itemId || ''));
  if (!m || !file) return null;
  const needle = Buffer.from('"uuid":"' + m[1] + '"');
  let hit = null;
  eachLineBackward(file, cap, (line) => {
    if (line.indexOf(needle) < 0) return true;
    let e; try { e = JSON.parse(line.toString('utf8')); } catch (x) { return true; }
    if (e.uuid !== m[1] || !e.message || !Array.isArray(e.message.content)) return true;
    const b = e.message.content[Number(m[2])];
    if (b && b.type === 'tool_use') hit = { tool: String(b.name || ''), detail: toolDetail(b.name, b.input) };
    return false;
  });
  return hit;
}

// One picture of a message of a transcript: the entry by its uuid, the block by its index. Read backward from the
// end, at most `cap` bytes. -> {mime, bytes} or null.
function imageAt(file, uuid, index, cap = 256 * 1024 * 1024) {
  if (!file || !/^[0-9a-f-]{8,64}$/i.test(String(uuid)) || !(Number(index) >= 0)) return null;
  const needle = Buffer.from('"uuid":"' + uuid + '"');
  let hit = null;
  eachLineBackward(file, cap, (line) => {
    if (line.indexOf(needle) < 0) return true;
    let e; try { e = JSON.parse(line.toString('utf8')); } catch (x) { return true; }
    if (e.uuid !== uuid) return true;
    const list = e.message && Array.isArray(e.message.content) ? e.message.content : e.attachment && Array.isArray(e.attachment.prompt) ? e.attachment.prompt : null;   // a message, or one taken in mid-turn
    if (!list) return true;
    const b = list[Number(index)];
    const src = b && b.type === 'image' && b.source;
    if (src && src.type === 'base64' && typeof src.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(String(src.media_type))) hit = { mime: src.media_type, bytes: Buffer.from(src.data, 'base64') };
    return false;
  });
  return hit;
}

// The number of the mark "［圖N］" a picture's block stands after; 0: after none (dragged in, or from the + menu).
const tagOf = (blocks, i) => { const b = blocks[i - 1], m = b && b.type === 'text' ? /［圖(\d{1,2})］\s*$/.exec(String(b.text || '')) : null; return m ? Number(m[1]) : 0; };
// The pictures of a message, to be sent again (an edited message keeps them): the blocks asked for, in order, each with the
// number of the mark "［圖N］" it stands after, if it stands after one. -> [{mime, data, tag?}], or null (not all are there).
function picturesOf(file, uuid, indexes, cap = 256 * 1024 * 1024) {
  if (!file || !/^[0-9a-f-]{8,64}$/i.test(String(uuid))) return null;
  const needle = Buffer.from('"uuid":"' + uuid + '"'); let list = null;
  eachLineBackward(file, cap, (line) => {
    if (line.indexOf(needle) < 0) return true;
    let e; try { e = JSON.parse(line.toString('utf8')); } catch (x) { return true; }
    if (e.uuid !== uuid) return true;
    list = e.message && Array.isArray(e.message.content) ? e.message.content : e.attachment && Array.isArray(e.attachment.prompt) ? e.attachment.prompt : [];
    return false;
  });
  if (!list) return null;
  const out = [];
  for (const i of indexes) {
    const src = list[i] && list[i].type === 'image' && list[i].source;
    if (!src || src.type !== 'base64' || typeof src.data !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(String(src.media_type))) return null;
    const tag = tagOf(list, i);
    out.push(Object.assign({ mime: src.media_type, data: src.data }, tag ? { tag } : {}));
  }
  return out;
}

// The paths of a SendUserFile call: [string], at most 40.
function handedFiles(input) {
  const l = input && Array.isArray(input.files) ? input.files : [];
  return l.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 1000)).slice(0, 40);
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

// What you said while a turn was running. Claude Code does not write that as a "user" entry: it is an attachment of
// type "queued_command", its `prompt` a string or a list of blocks (text, pictures). The same record is used for
// things nobody typed - a background task reporting, a message from another session or from an agent - which are
// told apart by commandMode and by how the text begins. -> {text, blocks} or null
const NOT_SAID_MID = /^\s*<(task-notification|agent-message|cross-session|system-reminder|local-command-|command-name|command-message|command-args|user-prompt-submit-hook)/;
function queuedSaid(e) {
  const a = e && e.type === 'attachment' && !e.isSidechain && e.attachment && e.attachment.type === 'queued_command' ? e.attachment : null;
  if (!a || (a.commandMode && a.commandMode !== 'prompt')) return null;
  const blocks = typeof a.prompt === 'string' ? [{ type: 'text', text: a.prompt }] : Array.isArray(a.prompt) ? a.prompt : [];
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).reduce((a, t) => a + (a && !/［圖\d{1,2}］$/.test(a) ? '\n' : '') + t, '').trim();
  if (NOT_SAID_MID.test(text)) return null;
  return text || blocks.some((b) => b && b.type === 'image') ? { text, blocks } : null;
}

// One transcript entry -> zero or more display items.
function itemsOf(e) {
  const q = queuedSaid(e);
  if (q) {
    const imgAt = q.blocks.map((b, i) => (b && b.type === 'image' ? i : -1)).filter((i) => i >= 0), imgTag = imgAt.map((i) => tagOf(q.blocks, i));
    const it = { id: typeof e.uuid === 'string' ? e.uuid : '', role: 'user', text: q.text, mid: true, ts: typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0 };
    return [imgAt.length ? Object.assign(it, { images: imgAt.length, imgAt, imgTag }) : it];
  }
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
    // A slash command you ran (typed, or a 「下一步」 button such as 寫交付訊息) is written by Claude Code as its tags,
    // <command-message>x</command-message><command-name>/x</command-name>[<command-args>…</command-args>], not as what
    // was sent. Dropped with the other tags, the message was missing from the conversation altogether (asked
    // 2026-11-19: 「我按了你的提示寫交付訊息，但為什麼沒有這個訊息」). Shown as it was said: "/x args". The /rename the
    // board sends to name a conversation is its own doing, not yours, and stays out.
    const raw = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    // (the tags come in either order - lib/cmduse.js)
    const cname = /^\s*<command-(?:name|message|args)>/.test(raw) && /<command-name>(\/[^<\s]+)<\/command-name>/.exec(raw);
    if (cname) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw), a = args ? args[1].trim() : '';
      return cname[1] === '/rename' ? [] : [{ id, role: 'user', text: cname[1] + (a ? ' ' + a : ''), ts }];
    }
    // (pieces that end in a picture's mark were one text, cut where the picture stands: put together again as they were)
    const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string' && !NOT_TYPED.test(b.text))
      .map((b) => b.text).reduce((a, t) => a + (a && !/［圖\d{1,2}］$/.test(a) ? '\n' : '') + t, '').trim();
    // pictures sent with it (pasted in a terminal, or sent from the board): counted, not carried - they can be megabytes
    // The pictures themselves are fetched one at a time when the message is drawn (imageAt below): imgAt says which
    // blocks of the entry they are.
    const imgAt = blocks.map((b, i) => (b && b.type === 'image' ? i : -1)).filter((i) => i >= 0);
    if (text || imgAt.length) out.push(imgAt.length ? { id, role: 'user', text, images: imgAt.length, imgAt, imgTag: imgAt.map((i) => tagOf(blocks, i)), ts } : { id, role: 'user', text, ts });
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
    blocks.forEach((b, i) => {
      if (!b) return;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ id: id + ':' + i, role: 'assistant', text: b.text, ts });
      // A question form is not a tool call to fold away: it is Claude waiting on you.
      else if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && questionsOf(b.input).length) out.push({ id: id + ':' + i, role: 'ask', questions: questionsOf(b.input), ts });
      // Files handed to you (SendUserFile): Claude Code delivers them to its own apps - the desktop and phone ones that
      // can follow a session - and answers "N files delivered to user". On the board nothing arrived anywhere: the
      // files are where Claude wrote them, usually its scratch folder. So they are shown as what they are: files, with
      // their place, to open from here.
      else if (b.type === 'tool_use' && b.name === 'SendUserFile' && handedFiles(b.input).length) out.push({ id: id + ':' + i, role: 'files', files: handedFiles(b.input), caption: typeof b.input.caption === 'string' ? b.input.caption.slice(0, 600) : '', ts });
      else if (b.type === 'tool_use') out.push({ id: id + ':' + i, role: 'tool', tool: String(b.name || ''), text: toolSummary(b.input), ts });
    });
  }
  return out;
}

// Last `max` display items, oldest first. `more` says older ones exist.
// o.hide: [[from, to], ...] byte ranges left out - a message edited and sent again carries the conversation on in place
// (Claude Code's --resume-session-at), and what had come after the place it went back to stays in the transcript as a
// branch nobody is on any more (the board keeps where it was: lib/chat.js rewinds). Not told by parentUuid: an ordinary
// transcript has entries with two children too (measured 2026-11-28: 5 to 20 in each of five large ones).
function readHistory(file, o = {}) {
  const hide = Array.isArray(o.hide) ? o.hide.filter((r) => Array.isArray(r) && r[1] > r[0]) : [];
  const max = o.max || 120;
  const cap = o.cap || 32 * 1024 * 1024;
  const groups = [];   // newest first; each group is one entry's items in order
  let count = 0;
  let more = false;
  eachLineBackward(file, cap, (line, at) => {
    if (hide.some((r) => at >= r[0] && at < r[1])) return true;
    if (line.indexOf(USER_MARK) < 0 && line.indexOf(ASSISTANT_MARK) < 0 && line.indexOf(QUEUED_MARK) < 0) return true;
    let e;
    try { e = JSON.parse(line.toString('utf8')); } catch (x) { return true; }
    if (e.type !== 'user' && e.type !== 'assistant' && e.type !== 'attachment') return true;
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
  const key = file + '|' + ((o && o.max) || '') + '|' + JSON.stringify((o && o.hide) || []);
  const c = cache.get(key);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.res;
  const res = readHistory(file, o);
  cache.delete(key);
  cache.set(key, { size: st.size, mtimeMs: st.mtimeMs, res });
  // One entry per session being looked at or listed in the war room; drop the oldest beyond that.
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return res;
}

module.exports = { handedFiles, queuedSaid, QUEUED_MARK_TEXT: '"type":"queued_command"', eachLineBackward, itemsOf, toolSummary, toolDetail, toolDetailAt, imageAt, picturesOf, questionsOf, readHistory, cachedHistory };
