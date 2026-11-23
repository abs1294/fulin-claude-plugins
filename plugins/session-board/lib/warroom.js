'use strict';
// War room: three things about all sessions at once.
//   live   - each running session: what it is doing right now, for how long
//   usage  - each session: cost, tokens, compactions, messages, context in use
//   turns  - what was recently finished, across sessions, newest first
//
// Ported from the "war room" of an earlier platform, which logged every
// headless AI call to a database. There is no database here; everything is
// derived from what is already on disk:
//   - a "turn" (one thing you asked, and everything Claude did until it
//     stopped) plays the part of a call. Turns are cut out of the conversation
//     history that lib/history.js reads from the end of each transcript.
//   - "what it is doing right now" is the last entry in the transcript's tail.
//   - the usage figures are the ones cc-statusline already keeps (lib/stats.js).
// The earlier version also had day totals and a per-call receipt panel. They
// were dropped here on purpose: the totals were not accurate from this data,
// and the receipt repeated the conversation, which is one click away.
// Everything here is read-only and bounded: no whole-file reads.
const fs = require('fs');
const { cachedHistory, toolSummary } = require('./history');
const { findTranscript, DEFAULTS } = require('./sessions');
const { sessionStats } = require('./stats');

const TAIL_BYTES = 64 * 1024;
// A busy session whose transcript has not been written for this long is shown
// as possibly stuck. Elapsed time alone is no signal here (multi-hour turns
// are normal); silence is. A single long-running command also looks like this,
// hence "possibly".
const STUCK_QUIET_MS = 10 * 60 * 1000;
const TURN_ITEMS = 120;   // how far back, in messages, turns are cut per session

// The newest thing in the transcript: using a tool, thinking, or writing.
function lastAction(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.allocUnsafe(size - start);
    let got = 0;
    while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, start + got); if (n <= 0) break; got += n; }
    const lines = buf.toString('utf8', 0, got).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l || l[0] !== '{') continue;
      let o;
      try { o = JSON.parse(l); } catch (e) { continue; }   // the first line of the tail is usually cut in half
      if ((o.type !== 'assistant' && o.type !== 'user') || o.isSidechain) continue;
      const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
      for (let j = content.length - 1; j >= 0; j--) {
        const c = content[j];
        if (!c) continue;
        if (c.type === 'tool_use') return { state: 'tool', tool: String(c.name || '?'), detail: toolSummary(c.input) };
        if (c.type === 'thinking') return { state: 'thinking' };
        if (c.type === 'text' && o.type === 'assistant') return { state: 'writing' };
      }
      if (o.type === 'user') return { state: 'thinking' };   // a tool result or your message just arrived
    }
  } catch (e) {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
  return { state: 'starting' };
}

// Cuts conversation items (oldest first) into turns. A turn starts at something
// you typed and runs to just before the next thing you typed.
function turnsOf(items, o = {}) {
  const turns = [];
  let cur = null;
  for (const it of items) {
    if (it.role === 'user') {
      cur = { id: it.id, startedAt: it.ts || 0, endedAt: it.ts || 0, prompt: it.text, tools: 0, replies: 0 };
      turns.push(cur);
    } else if (cur) {
      if (it.ts) cur.endedAt = Math.max(cur.endedAt, it.ts);
      if (it.role === 'tool') cur.tools++;
      if (it.role === 'assistant') cur.replies++;
    }
  }
  const last = turns[turns.length - 1];
  for (const t of turns) {
    t.running = !!(o.busy && t === last);
    t.durationMs = Math.max(0, (t.running ? (o.now || Date.now()) : t.endedAt) - t.startedAt);
  }
  return turns;
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

// sessions: the list from buildSessions.
function build(sessions, opts = {}, now = Date.now()) {
  const o = Object.assign({}, DEFAULTS, opts);
  const live = [];
  const usage = [];
  const turns = [];
  for (const s of sessions) {
    const file = findTranscript(s.sessionId, s.cwd, o.projectsDir);
    const hist = file ? cachedHistory(file, { max: TURN_ITEMS }) : { items: [], more: false };
    // "background": the turn is over but work it started is still running. That is still a session at work.
    const busy = s.status === 'busy' || s.status === 'background';
    if (busy) {
      let quietMs = 0;
      try { if (file) quietMs = Math.max(0, now - fs.statSync(file).mtimeMs); } catch (e) {}
      live.push({
        sessionId: s.sessionId, title: s.title, folder: s.folder, owner: s.owner, headless: !!s.headless,
        since: s.since, action: file ? lastAction(file) : { state: 'starting' }, quietMs, stuck: quietMs >= STUCK_QUIET_MS,
      });
    }
    const st = sessionStats(s.sessionId, o.stateDir, hist.items, { windows: o.windows, boardUsage: o.boardUsage ? o.boardUsage(s.sessionId) : null, limit: o.limit ? (model) => o.limit(s.cwd, model) : null });
    usage.push({
      sessionId: s.sessionId, title: s.title, folder: s.folder, status: s.status, group: s.group,
      cost: st.usage ? st.usage.cost : null, estimated: !!(st.usage && st.usage.estimated),
      tok: st.usage ? st.usage.tok : null,
      compacts: st.compacts ? st.compacts.count : null,
      messages: st.messages,
      context: st.context ? st.context.tokens : null,
      contextPct: st.context ? st.context.pct : null,
    });
    // Finished turns only: a turn still running is already in `live`.
    for (const t of turnsOf(hist.items, { busy, now })) {
      if (t.running) continue;
      turns.push({
        id: t.id, sessionId: s.sessionId, title: s.title, folder: s.folder,
        startedAt: t.startedAt, endedAt: t.endedAt, durationMs: t.durationMs,
        prompt: clip(t.prompt, 160), tools: t.tools, replied: t.replies > 0,
      });
    }
  }
  turns.sort((a, b) => b.endedAt - a.endedAt);
  live.sort((a, b) => a.since - b.since);
  usage.sort((a, b) => (b.cost || 0) - (a.cost || 0));
  return { now, live, usage, turns: turns.slice(0, 60) };
}

module.exports = { lastAction, turnsOf, build, STUCK_QUIET_MS, TURN_ITEMS };
