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
const { sidKey } = require('./sessions');

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

// Cost and tokens, split into the main conversation and its subagents. cc-statusline counts them; nothing is counted here.
// Two places it keeps them. The conversation's own, unless a reply came after it was last brought up to date; what it has
// more (which tokens were the subagents') would come and go otherwise.
//   state/claude-toksum2-<sid>.json            this conversation, brought up to date after every reply (its hooks, since 1.10.0;
//                                              before that only while it had a status line, so it could stand still)
//   usage-data/cc-statusline-usage-detail.json every conversation on this machine, every 15 minutes (until 1.10.0 every 6 hours)
// What Claude Code itself reports (total_cost_usd) is not used: once a conversation is resumed it holds everything before
// again (measured 2026-11-24 on 2.1.325: 0.0039, resumed 0.0076, resumed again 0.0098).
const details = new Map();   // file -> {sig, at, rows}
function detailRow(sid, file) {
  let st; try { st = fs.statSync(file); } catch (e) { return null; }
  const sig = st.mtimeMs + ':' + st.size;
  let d = details.get(file);
  if (!d || d.sig !== sig) {
    const j = readJson(file), rows = new Map();
    if (!j && !d) return null;   // cannot be read this moment: what was read before, if anything, and again next time
    if (j && Array.isArray(j.sessions)) for (const s of j.sessions) if (s && typeof s.id === 'string') { const k = s.id.toLowerCase(), was = rows.get(k); if (!was || num(s.cost) > num(was.cost)) rows.set(k, s); }   // one in two project folders: the larger
    if (j) { d = { sig, at: num(j.at), rows, prices: j.prices || {} }; details.set(file, d); }
  }
  const r = d.rows.get(String(sid).toLowerCase());
  if (!r) return null;
  const t = r.tok && typeof r.tok === 'object' ? r.tok : {}, cost = num(r.cost), sub = Math.min(cost, num(r.subCost));
  return { at: d.at, last: Date.parse(r.last) || 0, use: { cost, tok: num(t.in) + num(t.out) + num(t.cw) + num(t.cr), mainCost: cost - sub, agentCost: sub, agentRuns: null, mainTok: null, agentTok: null,
    estimated: Object.keys(r.models || {}).some((k) => !d.prices[k] || d.prices[k].exact === false) } };
}
function live(sid, stateDir) {
  const file = path.join(stateDir, `claude-toksum2-${sidKey(sid)}.json`), j = readJson(file);
  if (!j || typeof j !== 'object') return null;
  const t = j.v >= 1 && j.total && typeof j.total === 'object' ? j.total : null;
  if (!t) return null;   // written before cc-statusline 1.10.0: no figures for others in it
  const out = { cost: 0, tok: 0, mainCost: 0, mainTok: 0, agentCost: 0, agentTok: 0, agentRuns: 0, estimated: num(t.unpricedTok) > 0 || num(t.approxTok) > 0 };
  for (const k of Object.keys(out)) if (k !== 'estimated') out[k] = num(t[k]);
  return { at: num(j.at), use: out };
}
// stateDir is ~/.claude/cc-statusline/state; the detail is in ~/.claude/usage-data.
function usage(sid, stateDir, detailFile) {
  const a = live(sid, stateDir), b = detailRow(sid, detailFile || path.join(stateDir, '..', '..', 'usage-data', 'cc-statusline-usage-detail.json'));
  if (a && (!b || a.at >= b.at || b.last <= a.at)) return Object.assign(a.use, { at: a.at });
  if (!b) return null;
  if (a) b.use.agentRuns = a.use.agentRuns;
  return Object.assign(b.use, { at: b.at });
}

function top(obj, n, extra) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj).filter(([, v]) => v && typeof v === 'object')
    .map(([name, v]) => Object.assign({ name, count: num(v.count), last: num(v.last) }, extra ? extra(v) : null))
    .sort((a, b) => b.count - a.count || b.last - a.last).slice(0, n);
}

// How many times it was compacted, as cc-statusline counted them (claude-compacts-<sid>.json): count is its own, inherited
// what it carried over when it was copied from another conversation (--fork-session starts from that one's last
// compaction; cc-statusline 1.11.0 on). Shown as one figure - the conversation the person sees began with those.
// The board counts nothing itself: usage is gathered only by cc-statusline.
function compactsOf(c) {
  if (!c || typeof c !== 'object') return null;
  const own = num(c.count), inherited = num(c.inherited);
  const out = { count: own + inherited, last: num(c.last) || (inherited ? num(c.inheritedAt) : 0) };
  if (inherited) Object.assign(out, { own, inherited, from: typeof c.from === 'string' ? c.from.slice(0, 80) : '' });
  return out;
}

// extra.windows     {model id: context size}, learned by lib/chat.js
// extra.limit       (model) -> the window set for it in its folder, or 0 (lib/ctxlimit.js)
function sessionStats(sid, stateDir, extra = {}) {
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

  // What was sent to the model for the newest reply = how much of the window is in use (cc-statusline, 1.10.0 on).
  const seen = readJson(file('toksum2', '.json')), cx = seen && seen.v >= 1 && seen.context && typeof seen.context === 'object' ? seen.context : null;
  const context = cx ? { tokens: num(cx.tokens), model: typeof cx.model === 'string' ? cx.model : '', effort: typeof cx.effort === 'string' ? cx.effort : '', window: 0, pct: null, assumed: false } : null;
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

  const use = usage(sid, stateDir);

  return {
    usage: use,
    compacts: compactsOf(compacts),
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
