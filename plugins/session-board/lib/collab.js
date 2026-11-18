'use strict';
// Collaborations: two or more sessions working on one goal together, the way two projects' sessions once did
// (2026-09 / 2026-11): their Claudes talk to each other directly (ListAgents + SendMessage), keep one shared ledger,
// and pass on what their own user decided, word for word. What went wrong then is what this is for: interfaces not
// confirmed with the other side, one side changing something the other never caught up with, promises not kept,
// joint testing skipped, and a partner's name changing when its process restarted ("No agent named ... is reachable").
//
// This file is the board-free part: templates, the ledger (writing it and reading it back), names, and the message
// timeline read from the members' transcripts. Every wording, heading and limit is in the files of ../collab
// (config.json, ledger.md, brief.md, rules.md, renamed.md, decision.md); a file of the same name in
// ~/.claude/session-board/collab overrides it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_DIR = path.join(os.homedir(), '.claude', 'session-board', 'collab');
const OWN_DIR = path.join(__dirname, '..', 'collab');

// A template or the settings file: the user's copy first, else the plugin's.
function readFile(name, o = {}) {
  for (const d of [o.userDir || USER_DIR, o.ownDir || OWN_DIR]) {
    try { return fs.readFileSync(path.join(d, name), 'utf8').replace(/^﻿/, ''); } catch (e) {}
  }
  return '';
}
function settings(o = {}) {
  const own = (() => { try { return JSON.parse(fs.readFileSync(path.join(o.ownDir || OWN_DIR, 'config.json'), 'utf8')); } catch (e) { return {}; } })();
  let user = {}; try { user = JSON.parse(fs.readFileSync(path.join(o.userDir || USER_DIR, 'config.json'), 'utf8')); } catch (e) {}
  const s = Object.assign({}, own, user, { sections: Object.assign({}, own.sections, user.sections) });
  s.doneMarks = Array.isArray(s.doneMarks) ? s.doneMarks.map(String) : ['✓'];
  s.timelineTailBytes = Number.isInteger(s.timelineTailBytes) && s.timelineTailBytes > 0 ? s.timelineTailBytes : 4 * 1024 * 1024;
  s.timelineMax = Number.isInteger(s.timelineMax) && s.timelineMax > 0 ? s.timelineMax : 200;
  return s;
}

// {{key}} and {{s.key}} (a section heading) filled in; anything unknown is left as it is.
function fill(tpl, vars, s) {
  return String(tpl).replace(/\{\{\s*(s\.)?([a-zA-Z]+)\s*\}\}/g, (m, sec, k) => {
    if (sec) return s && s.sections && typeof s.sections[k] === 'string' ? s.sections[k] : m;
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
  });
}

// The name a member is given in the collaboration (what the others SendMessage to). One line, kept short.
function fixedName(pattern, id, short) {
  const clean = (v) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim();
  return clean(String(pattern || '合作{id}-{short}').split('{id}').join(String(id)).split('{short}').join(clean(short) || 'x')).slice(0, 60);
}
// A short name for a role when none is given: its folder's name.
function shortOf(m) { return String(m.short || '').trim() || path.basename(String(m.cwd || '')).slice(0, 20) || 'x'; }

const membersBlock = (c) => c.members.map((m) => '- **' + m.role + '**：名字 `' + (m.seenName || m.name) + '`' + (m.seenName && m.seenName !== m.name ? '（預定 `' + m.name + '`）' : '') + '；資料夾 `' + m.cwd + '`；' + (m.owner === 'board' ? '看板對話' : '終端機 session') + '；session `' + m.sessionId + '`' + (m.does ? '\n  負責：' + m.does : '')).join('\n');

function ledgerText(c, o = {}) {
  const s = settings(o);
  return fill(readFile('ledger.md', o), {
    id: c.id, created: new Date(c.createdAt).toISOString().replace('T', ' ').slice(0, 16), goal: c.goal,
    members: membersBlock(c), memberColumns: c.members.map((m) => m.role).join(' | '), memberDashes: c.members.map(() => '---').join(' | '),
    rules: readFile('rules.md', o).trim(),
  }, s);
}

function briefText(c, m, o = {}) {
  const s = settings(o);
  const others = c.members.filter((x) => x.sessionId !== m.sessionId).map((x) => '- ' + x.role + '：名字 ' + (x.seenName || x.name) + '，資料夾 ' + x.cwd + (x.does ? '，負責 ' + x.does : '')).join('\n');
  return fill(readFile('brief.md', o), { id: c.id, goal: c.goal, role: m.role + (m.does ? '（負責 ' + m.does + '）' : ''), name: m.name, others, ledger: c.ledger, rules: readFile('rules.md', o).trim() }, s).trim();
}
function renamedText(c, m, was, o = {}) { return fill(readFile('renamed.md', o), { id: c.id, role: m.role, name: m.seenName, was }, settings(o)).trim(); }
function decisionText(c, question, answer, o = {}) { return fill(readFile('decision.md', o), { id: c.id, question, answer }, settings(o)).trim(); }

// The part of the ledger under "## <heading>", up to the next "## ". -> {start, end} of that part (after the heading line), or null
function sectionRange(text, heading) {
  // (\r allowed at the end: a ledger written from templates git checked out with CRLF, or saved by a Windows editor)
  const re = new RegExp('^##[ \\t]+' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t\\r]*$', 'm');
  const m = re.exec(text); if (!m) return null;
  const start = m.index + m[0].length;
  const next = /^##[ \t]/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}
function section(text, heading) { const r = sectionRange(text, heading); return r ? text.slice(r.start, r.end) : ''; }
function replaceSection(text, heading, body) {
  const r = sectionRange(text, heading); if (!r) return text;
  return text.slice(0, r.start) + '\n\n' + String(body).trim() + '\n\n' + text.slice(r.end).replace(/^\n+/, '');
}
// One section of a ledger file replaced, read right before the write: what members wrote anywhere else in the
// meantime stays. (Two writers within the same instant can still overwrite each other - a file has no lock here.)
function writeSection(file, heading, body) {
  const t = fs.readFileSync(file, 'utf8');
  const next = replaceSection(t, heading, body);
  if (next !== t) fs.writeFileSync(file, next);
}
// Text that goes into one line of the ledger (a role, a short name, what someone does): no line breaks or table
// bars, which would start a section or a column of their own.
function oneLine(v, max) { return String(v || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }

// What the ledger says is still open:
//   promises  - [ ] [role] ...   not ticked
//   pending   - [ ] question     not decided
//   behind    an interface row where some member's column is not one of the done marks
function readLedger(text, c, o = {}) {
  const s = settings(o);
  const t = String(text || '').replace(/\r\n/g, '\n');   // Windows line ends read the same
  const promises = [];
  for (const line of section(t, s.sections.promises).split('\n')) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(?:\[([^\]]+)\])?\s*(.+)$/.exec(line); if (!m) continue;
    promises.push({ done: m[1] !== ' ', who: (m[2] || '').trim(), text: m[3].trim() });
  }
  const pending = [];
  for (const line of section(t, s.sections.pending).split('\n')) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/.exec(line); if (!m) continue;
    pending.push({ done: m[1] !== ' ', question: m[2].trim() });
  }
  const rows = section(t, s.sections.interfaces).split('\n').filter((l) => /^\s*\|/.test(l));
  const interfaces = [];
  if (rows.length >= 2) {
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    const head = cells(rows[0]);
    for (const l of rows.slice(1)) {
      const r = cells(l); if (r.every((x) => /^:?-{2,}:?$/.test(x) || !x)) continue;
      const behind = [];
      head.forEach((h, i) => { if (i < 3) return; const v = r[i] || ''; if (!s.doneMarks.some((d) => v === d || v.startsWith(d))) behind.push(h); });
      interfaces.push({ name: r[0] || '', from: r[1] || '', version: r[2] || '', behind });
    }
  }
  return { promises, pending, interfaces };
}

// The user's answer: the question ticked in "pending", the answer added word for word under "decisions".
function answerDecision(text, question, answer, at, o = {}) {
  const s = settings(o);
  let t = String(text || '').replace(/\r\n/g, '\n');
  const r = sectionRange(t, s.sections.pending);
  if (r) {
    const body = t.slice(r.start, r.end).split('\n').map((line) => {
      const m = /^(\s*[-*]\s*)\[ \](\s*)(.+)$/.exec(line);
      return m && m[3].trim() === String(question).trim() ? m[1] + '[x]' + m[2] + m[3] : line;
    }).join('\n');
    t = t.slice(0, r.start) + body + t.slice(r.end);
  }
  const d = sectionRange(t, s.sections.decisions);
  const entry = '- ' + new Date(at).toISOString().replace('T', ' ').slice(0, 16) + '　題目：' + String(question).trim() + '\n  使用者原話：' + String(answer).replace(/\r?\n/g, '\n  ');
  if (d) {
    const before = t.slice(d.start, d.end).replace(/\s+$/, '');
    t = t.slice(0, d.start) + before + '\n' + entry + '\n\n' + t.slice(d.end).replace(/^\n+/, '');
  } else t += '\n\n## ' + s.sections.decisions + '\n\n' + entry + '\n';
  return t;
}

// Messages between the members, from their transcripts (the last timelineTailBytes of each):
//   out  a SendMessage tool call it made (to, message)
//   in   a <cross-session-message from-name="..."> it was given
// -> [{at, member, dir, peer, text, delivered?}] oldest first; an 'out' is marked delivered when the receiving member's
// transcript has it as an 'in' (matched on the start of the text).
function timeline(members, o = {}) {
  const s = settings(o);
  const all = [];
  for (const m of members) {
    if (!m.file) continue;
    let fd, text = '';
    try {
      const size = fs.statSync(m.file).size, from = Math.max(0, size - s.timelineTailBytes);
      fd = fs.openSync(m.file, 'r'); const b = Buffer.alloc(size - from); fs.readSync(fd, b, 0, b.length, from); text = b.toString('utf8');
      if (from > 0) text = text.slice(text.indexOf('\n') + 1);
    } catch (e) { continue; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
    for (const line of text.split('\n')) {
      if (!line || (!line.includes('SendMessage') && !line.includes('cross-session-message'))) continue;
      let e; try { e = JSON.parse(line); } catch (x) { continue; }
      const at = Date.parse(e.timestamp) || 0;
      const content = e.message && e.message.content;
      if (e.type === 'assistant' && Array.isArray(content)) {
        for (const c of content) if (c.type === 'tool_use' && c.name === 'SendMessage' && c.input && typeof c.input.message === 'string') all.push({ at, member: m.role, dir: 'out', peer: String(c.input.to || ''), text: c.input.message });
        continue;
      }
      // Given to it: as a message of its own (when it was idle), or queued while it was working (a queue-operation
      // "enqueue" - measured 2026-11-18: a message that came in mid-turn is only written that way). Only text that
      // IS such a message counts - one that merely mentions the tag (the collaboration brief does) is not.
      let raw = '';
      if (e.type === 'queue-operation' && e.operation === 'enqueue' && typeof e.content === 'string') raw = e.content;
      else if (e.type === 'user') raw = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c && c.type === 'text' ? c.text : '')).join('\n') : '';
      raw = raw.trim();
      if (!/^(Another Claude session sent a message:\s*)?<cross-session-message\b/.test(raw)) continue;
      const re = /<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/g; let x;
      while ((x = re.exec(raw))) { const from = (/from-name="([^"]*)"/.exec(x[1]) || [])[1] || ''; all.push({ at, member: m.role, dir: 'in', peer: from, text: x[2].trim() }); }
    }
  }
  // the same message given twice (queued, then shown as a message of its own): once
  const seenIn = new Set();
  for (let i = 0; i < all.length; i++) {
    const x = all[i]; if (x.dir !== 'in') continue;
    const k = x.member + '|' + x.peer + '|' + String(x.text).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (seenIn.has(k)) { all.splice(i, 1); i--; } else seenIn.add(k);
  }
  all.sort((a, b) => a.at - b.at);
  const key = (t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 60);
  // Delivered = the member it was sent to was given it, from the member who sent it (by any of the sender's names: the
  // one given here, or what Claude Code calls it now) - not just "someone was given the same words". Each message given
  // is matched to one sent at most, so two members sending the same short answer are not both marked.
  const namesOf = new Map(members.map((m) => [m.role, new Set([m.name, m.seenName, m.addr, m.actualName].concat(Array.isArray(m.names) ? m.names : []).filter(Boolean))]));
  const roleOf = (name) => { for (const [role, set] of namesOf) if (set.has(name)) return role; return null; };
  const ins = all.filter((x) => x.dir === 'in'), used = new Set();
  for (const x of all) {
    if (x.dir !== 'out') continue;
    const to = roleOf(x.peer), sender = namesOf.get(x.member) || new Set();
    // sent to someone outside the collaboration (or a name not known here): whether it arrived cannot be seen - left
    // unmarked (null), never taken from whoever else happened to get the same words
    if (!to) { x.delivered = null; continue; }
    const y = ins.find((y) => !used.has(y) && y.at >= x.at - 1000 && y.member === to && sender.has(y.peer) && key(y.text) === key(x.text));
    x.delivered = !!y; if (y) used.add(y);
  }
  return all.slice(-s.timelineMax).map((x) => Object.assign({}, x, { text: x.text.slice(0, 1200) }));
}

module.exports = { readFile, settings, fill, fixedName, shortOf, oneLine, writeSection, ledgerText, briefText, renamedText, decisionText, section, replaceSection, readLedger, answerDecision, timeline, membersBlock, USER_DIR, OWN_DIR };
