'use strict';
// Per-session figures: cost, tokens, compactions, messages, subagents, skills,
// MCP calls, edited files, and how full the context is right now.
//
// Almost all of it is what the cc-statusline plugin's tracker hooks already
// write to ~/.claude/cc-statusline/state/claude-<kind>-<sid>.* ; this only
// reads those files. Without cc-statusline every figure is simply absent
// (null / empty), never a made-up zero.
const fs = require('fs');
const path = require('path');
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';   // either kind of slash (a path written on Windows, read on a Mac)
const { sidKey } = require('./sessions');

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

// Cost and tokens, split into the main conversation and its subagents.
// toksum2 keys each figure by transcript file; the main one is <sessionId>.jsonl.
function usage(sid, stateDir) {
  const j = readJson(path.join(stateDir, `claude-toksum2-${sidKey(sid)}.json`));
  if (!j || !j.files || typeof j.files !== 'object') return null;
  const out = { cost: 0, tok: 0, mainCost: 0, mainTok: 0, agentCost: 0, agentTok: 0, agentRuns: 0, estimated: false };
  let any = false;
  for (const [file, f] of Object.entries(j.files)) {
    if (!f || typeof f !== 'object') continue;
    any = true;
    const c = num(f.cost), t = num(f.tok);
    out.cost += c; out.tok += t;
    if (baseName(file).toLowerCase() === (sid + '.jsonl').toLowerCase()) { out.mainCost += c; out.mainTok += t; }
    else { out.agentCost += c; out.agentTok += t; out.agentRuns++; }
    // cc-statusline marks figures priced with a stand-in rate, or with tokens it could not price.
    if (num(f.unpricedTok) > 0 || num(f.approxTok) > 0) out.estimated = true;
  }
  return any ? out : null;
}

function top(obj, n, extra) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj).filter(([, v]) => v && typeof v === 'object')
    .map(([name, v]) => Object.assign({ name, count: num(v.count), last: num(v.last) }, extra ? extra(v) : null))
    .sort((a, b) => b.count - a.count || b.last - a.last).slice(0, n);
}

// items: the conversation items already read for this session (lib/history.js),
// used for the size of the context as of the newest reply.
// extra.windows     {model id: context size}, learned by lib/chat.js
// extra.boardUsage  {cost, tok} kept by the board for a conversation it runs
// extra.limit       (model) -> the window set for it in its folder, or 0 (lib/ctxlimit.js)
function sessionStats(sid, stateDir, items, extra = {}) {
  const key = sidKey(sid);
  const file = (kind, ext) => path.join(stateDir, `claude-${kind}-${key}${ext}`);
  // cc-statusline writes this file only once a session HAS been compacted, so
  // with the plugin installed "no file" means zero times, which is worth saying.
  const hasStatusline = fs.existsSync(stateDir);
  const compacts = readJson(file('compacts', '.json')) || (hasStatusline ? { count: 0, last: 0 } : null);
  let messages = null;
  try { const n = parseInt(fs.readFileSync(file('msgcount', ''), 'utf8').trim(), 10); if (Number.isFinite(n)) messages = n; } catch (e) {}
  const agents = readJson(file('agents', '.json'));
  const agentList = agents && typeof agents === 'object' ? Object.values(agents).filter((a) => a && typeof a === 'object') : [];
  const edited = readJson(file('files', '.json'));

  // What was sent to the model for the newest reply = how much of the window is in use.
  let context = null;
  for (let i = (items || []).length - 1; i >= 0; i--) {
    const u = items[i].u;
    if (u) { context = { tokens: u.in + u.cr + u.cw, model: u.model || '', effort: u.effort || '', window: 0, pct: null, assumed: false }; break; }
  }
  if (context) {
    // The percentage needs the size of the model's window. Known when a
    // conversation run by the board has used this model. Otherwise: more than
    // 200K in use can only be the 1M window; below that the size cannot be
    // told from here, so no percentage is made up.
    const known = extra.windows && extra.windows[context.model];
    if (typeof known === 'number' && known > 0) context.window = known;
    else if (context.tokens > 200000) { context.window = 1000000; context.assumed = true; }
    // what is set for it, where that is less than the model's own size (autoCompactWindow, read from the settings files)
    const own = context.window, set = extra.limit ? extra.limit(context.model) : 0;
    if (set && (!own || set < own)) { context.window = set; context.limited = true; if (own) context.own = own; }
    if (context.window) context.pct = Math.min(100, Math.round((context.tokens / context.window) * 100));
  }

  // A conversation run by the board has no cc-statusline figures; the board keeps its own.
  let use = usage(sid, stateDir);
  if (!use && extra.boardUsage && (extra.boardUsage.cost > 0 || extra.boardUsage.tok > 0)) {
    const b = extra.boardUsage;
    use = { cost: b.cost, tok: b.tok, mainCost: b.cost, mainTok: b.tok, agentCost: 0, agentTok: 0, agentRuns: 0, estimated: false, byBoard: true };
  }

  return {
    usage: use,
    compacts: compacts && typeof compacts === 'object' ? { count: num(compacts.count), last: num(compacts.last) } : null,
    messages,
    context,
    // cc-statusline prunes this list (it keeps the running ones and a bounded
    // number of finished ones), so its length is NOT how many subagents the
    // session ever started; that figure is usage.agentRuns. What the list is
    // good for: who is running now, and which kinds were used recently.
    agents: {
      running: agentList.filter((a) => a.status === 'running').map((a) => String(a.name || '')).slice(0, 12),
      runningAt: agentList.filter((a) => a.status === 'running').map((a) => num(a.started)).slice(0, 12),   // when each began: matched to the descriptions read from the transcript
      kinds: [...new Set(agentList.map((a) => String(a.name || '')).filter(Boolean))].slice(0, 8),
    },
    skills: top(readJson(file('skills', '.json')), 6),
    mcp: top(readJson(file('mcp', '.json')), 6, (v) => ({ errors: num(v.errors) })),
    edited: Array.isArray(edited) ? edited.filter((x) => typeof x === 'string').slice(0, 12) : [],
  };
}

module.exports = { sessionStats, usage };
