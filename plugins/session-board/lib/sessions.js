'use strict';
// Assembles the list of live Claude Code sessions on this machine from files
// Claude Code and cc-statusline already write. Read-only: nothing here writes.
//
// Sources, in order of trust:
//   ~/.claude/sessions/<pid>.json        live registry (pid, sessionId, cwd, name, status).
//                                        NOT a documented interface -- every field is optional here.
//   ~/.claude/cc-statusline/state/       claude-summary-<sid>.txt (Claude-written summary, exists
//                                        only after ~10 prompts) and claude-msgs-<sid>.json.
//   ~/.claude/projects/<cwd>/<sid>.jsonl transcript; only its TAIL is read, for the last
//                                        custom-title / ai-title entry (= the terminal window title).
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULTS = {
  sessionsDir: path.join(CLAUDE_DIR, 'sessions'),
  projectsDir: path.join(CLAUDE_DIR, 'projects'),
  stateDir: path.join(CLAUDE_DIR, 'cc-statusline', 'state'),
  legacyStateDir: os.tmpdir(),   // cc-statusline < 1.7.0 wrote here
};

// A session that finished its turn and has not been touched for this long is
// shown apart, as "left open": it is no longer waiting on anyone in practice.
const STALE_MS = 12 * 3600 * 1000;

// cc-statusline's file key for a session id.
const sidKey = (sid) => String(sid || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

// Claude Code's project directory name for a cwd: every non-alphanumeric
// character becomes '-'.  C:\Users\x\my repo -> C--Users-x-my-repo
const encodeCwd = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function readRegistry(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const j = readJson(path.join(dir, n));
    if (j && typeof j.sessionId === 'string') out.push(j);
  }
  return out;
}

// Last custom-title / ai-title in a transcript, reading backwards from the end.
// Transcripts reach hundreds of MB; a whole-file read is what caused the hook
// OOM of 2026-11-11, so this reads 2 MB at a time and gives up after 64 MB.
// Each chunk is read with a 16 KB overlap into the chunk after it, so a title
// line that straddles a chunk boundary is still seen whole in one of the two.
// Works on bytes: no string is built for the chunk, and a multi-byte character
// cut by the boundary cannot corrupt the search.
// The markers are matched unescaped; the same text quoted inside a tool result
// is JSON-escaped (\"type\":\"ai-title\") and so never matches.
const MARKS = { custom: Buffer.from('"type":"custom-title"'), ai: Buffer.from('"type":"ai-title"') };
const PROPS = { custom: 'customTitle', ai: 'aiTitle' };
function lastTitles(file, o = {}) {
  const CHUNK = o.chunk || 2 * 1024 * 1024;
  const OVERLAP = o.overlap === undefined ? 16 * 1024 : o.overlap;
  const CAP = o.cap || 64 * 1024 * 1024;
  const res = { custom: null, ai: null, scanned: 0 };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const total = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(CHUNK + OVERLAP);
    let pos = total;
    while (pos > 0 && res.scanned < CAP && !(res.custom && res.ai)) {
      const start = Math.max(0, pos - CHUNK);
      const len = Math.min(total - start, (pos - start) + OVERLAP);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      const view = buf.subarray(0, got);
      for (const k of ['custom', 'ai']) {
        if (res[k]) continue;
        let i = view.lastIndexOf(MARKS[k]);
        while (i >= 0) {
          const ls = view.lastIndexOf(10, i);
          let le = view.indexOf(10, i);
          // Line start outside this chunk (and not the file start) = half a
          // line; the next, earlier chunk's overlap covers it.
          if (ls >= 0 || start === 0) {
            if (le < 0) le = got;
            try {
              const v = JSON.parse(view.toString('utf8', ls + 1, le))[PROPS[k]];
              if (typeof v === 'string' && v) { res[k] = v; break; }
            } catch (e) {}
          }
          if (i === 0) break;
          i = view.lastIndexOf(MARKS[k], i - 1);
        }
      }
      res.scanned += pos - start;
      pos = start;
    }
  } catch (e) {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
  return res;
}

// Caches keyed by file, invalidated by size+mtime, so a 3-second poll costs a
// stat per session instead of a read.
const titleCache = new Map();
function cachedTitles(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { custom: null, ai: null, scanned: 0 }; }
  const c = titleCache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.res;
  const res = lastTitles(file);
  titleCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, res });
  return res;
}

const transcriptCache = new Map();
const transcriptMiss = new Map();
function findTranscript(sid, cwd, projectsDir) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sid)) return null;
  const hit = transcriptCache.get(sid);
  if (hit && fs.existsSync(hit)) return hit;
  const direct = path.join(projectsDir, encodeCwd(cwd), sid + '.jsonl');
  if (fs.existsSync(direct)) { transcriptCache.set(sid, direct); return direct; }
  // The session may have been started elsewhere and moved: look one level down.
  // That is a scan of every project directory, so a miss is remembered for 20
  // seconds instead of being repeated on every 3-second poll.
  const missedAt = transcriptMiss.get(sid);
  if (missedAt && Date.now() - missedAt < 20000) return null;
  transcriptMiss.set(sid, Date.now());
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch (e) { return null; }
  for (const d of dirs) {
    const p = path.join(projectsDir, d, sid + '.jsonl');
    if (fs.existsSync(p)) { transcriptCache.set(sid, p); return p; }
  }
  return null;
}

function readSummary(sid, o) {
  const name = `claude-summary-${sidKey(sid)}.txt`;
  for (const dir of [o.stateDir, o.legacyStateDir]) {
    if (!dir) continue;
    try {
      const s = fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n')[0].trim();
      if (s) return s;
    } catch (e) {}
  }
  return '';
}

const msgCache = new Map();
const clip = (s, n) => {
  const t = String(s || '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '\u2026' : t;
};
function lastMessages(sid, o) {
  const file = path.join(o.stateDir, `claude-msgs-${sidKey(sid)}.json`);
  let st;
  try { st = fs.statSync(file); } catch (e) { return { user: '', assistant: '' }; }
  const c = msgCache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.res;
  const res = { user: '', assistant: '' };
  const arr = readJson(file);
  if (Array.isArray(arr)) {
    for (let i = arr.length - 1; i >= 0 && !(res.user && res.assistant); i--) {
      const m = arr[i];
      if (!m || typeof m.t !== 'string') continue;
      if (m.r === 'u' && !res.user) res.user = clip(m.t, 140);
      if (m.r === 'a' && !res.assistant) res.assistant = clip(m.t, 200);
    }
  }
  msgCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, res });
  return res;
}

// Branch of the repo a directory IS (not one it merely sits inside): reads
// .git/HEAD directly, no git process. Handles worktrees (.git is a file).
function gitBranch(dir) {
  try {
    const dotgit = path.join(dir, '.git');
    const st = fs.statSync(dotgit);
    let headFile = path.join(dotgit, 'HEAD');
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
      if (!m) return '';
      headFile = path.join(path.resolve(dir, m[1].trim()), 'HEAD');
    }
    const head = fs.readFileSync(headFile, 'utf8').trim();
    const r = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return r ? r[1] : head.slice(0, 8);
  } catch (e) { return ''; }
}

// Who has the ball.
//   yours   - waiting on you (permission / question) or finished and awaiting the next instruction
//   running - Claude is working
//   stale   - finished and untouched for STALE_MS: left open
function groupOf(status, sinceMs) {
  if (status === 'busy') return 'running';
  if (status === 'waiting') return 'yours';
  if (status === 'idle') return sinceMs > STALE_MS ? 'stale' : 'yours';
  return 'running';
}

// quiet - a conversation run by the board whose last reply has been read: nothing pending.
const GROUP_ORDER = { yours: 0, running: 1, quiet: 2, stale: 3 };
function compareSessions(a, b) {
  if (a.group !== b.group) return GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
  if (a.group === 'yours' && a.status !== b.status) return a.status === 'waiting' ? -1 : 1;
  return b.since - a.since;   // most recent status change first
}

function buildSessions(opts = {}, now = Date.now()) {
  const o = Object.assign({}, DEFAULTS, opts);
  const alive = o.pidAlive || pidAlive;
  const out = [];
  const seen = new Set();
  // Conversations the board runs itself (lib/chat.js). The board knows their
  // state first-hand, so for these the registry is not consulted for status:
  // o.channels = [{sessionId, cwd, title, status, since, unread}].
  const owned = new Map((o.channels || []).map((c) => [c.sessionId, c]));
  const records = [];
  for (const r of readRegistry(o.sessionsDir)) {
    if (seen.has(r.sessionId)) continue;
    if (!owned.has(r.sessionId) && !alive(r.pid)) continue;
    seen.add(r.sessionId);
    records.push(r);
  }
  // A terminal window "parked" on a background job is not a second session.
  // When a conversation is moved to the background, Claude Code starts a
  // background worker that forks it (new session id, kind=bg, jobId=X) and the
  // original window stays open as that job's viewer (parkedJobId=X), its own
  // registry entry frozen at "idle" (measured 2026-11-12: listed as two rows,
  // one "done 4 hours ago", for what the user rightly saw as one conversation).
  // So: the window's entry is dropped, and the job is marked as having a window.
  const jobs = new Map();
  for (const r of records) if (typeof r.jobId === 'string' && r.jobId) jobs.set(r.jobId, r);
  const windowed = new Set();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const job = typeof r.parkedJobId === 'string' ? jobs.get(r.parkedJobId) : null;
    if (job && job !== r) { windowed.add(job.sessionId); records.splice(i, 1); }
  }
  // A channel with no process running has no registry entry at all.
  for (const c of owned.values()) if (!seen.has(c.sessionId)) records.push({ sessionId: c.sessionId, cwd: c.cwd });
  for (const r0 of records) {
    const ch = owned.get(r0.sessionId) || null;
    const r = ch ? Object.assign({}, r0, { cwd: ch.cwd, kind: 'board', name: '', status: ch.status, statusUpdatedAt: ch.since, bridgeSessionId: null }) : r0;
    const cwd = typeof r.cwd === 'string' ? r.cwd : '';
    const summary = readSummary(r.sessionId, o);
    const tfile = findTranscript(r.sessionId, cwd, o.projectsDir);
    const tt = tfile ? cachedTitles(tfile) : { custom: null, ai: null };
    // Everything the terminal window's title could currently be, most trusted first.
    const candidates = [...new Set([summary, tt.custom, tt.ai].filter(Boolean))];
    // A non-interactive registry entry with no transcript and no title has no
    // conversation to show and no window to jump to. Seen 2026-11-12: moving a
    // session to the background left a second kind=bg entry whose name was just
    // its id, sitting in "your turn" forever. Interactive sessions are always
    // listed, titled or not: a fresh window with no prompt yet is still yours.
    if (r.kind !== 'interactive' && !ch && !tfile && !candidates.length) continue;
    // The registry is not a documented format: take a field only when it has
    // the type this code relies on, otherwise fall back.
    const name = typeof r.name === 'string' ? r.name : '';
    const title = candidates[0] || name || (ch && ch.title) || (ch ? '新對話' : `session ${r.sessionId.slice(0, 8)}`);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const since = num(r.statusUpdatedAt) || num(r.updatedAt) || num(r.startedAt) || now;
    const status = typeof r.status === 'string' ? r.status : 'unknown';
    const msgs = lastMessages(r.sessionId, o);
    out.push({
      sessionId: r.sessionId,
      name,
      title,
      titleSource: summary ? 'summary' : tt.custom ? 'custom-title' : tt.ai ? 'ai-title' : 'name',
      titleCandidates: candidates,
      status,
      // A board conversation is yours when it wants an approval or has a reply
      // you have not opened yet; a terminal session follows groupOf.
      group: ch ? (status === 'busy' || status === 'background' ? 'running' : status === 'waiting' || ch.unread ? 'yours' : 'quiet') : groupOf(status, now - since),
      // board = runs inside the board and can be typed to here; anything else is a terminal session.
      owner: ch ? 'board' : 'terminal',
      // Not in a terminal window of its own: a background session, or one some
      // program drives through `claude -p` (entrypoint sdk-cli; those register
      // as kind=interactive too, measured 2026-11-12). It can be read here but
      // has no window to switch to and must not be taken over.
      headless: !ch && !windowed.has(r.sessionId) && (r.kind !== 'interactive' || (typeof r.entrypoint === 'string' && r.entrypoint !== 'cli')),
      // Runs as a Claude Code background job with a terminal window watching it.
      // The window can be switched to, but the session cannot be taken over:
      // ending the window would leave the job running, and the board would
      // then be a second process on the same conversation.
      parked: windowed.has(r.sessionId),
      pid: Number.isInteger(r0.pid) ? r0.pid : 0,
      since,
      startedAt: num(r.startedAt),
      kind: typeof r.kind === 'string' ? r.kind : '',
      cwd,
      folder: cwd ? path.basename(cwd) : '',
      branch: cwd ? gitBranch(cwd) : '',
      // Where this session can be talked to in a browser: its Remote Control
      // page on claude.ai, present only while the session is connected to it.
      // The id comes from an undocumented file and ends up in a link, so only
      // the exact shape seen in practice (session_<alphanumerics>) is accepted.
      chatUrl: typeof r.bridgeSessionId === 'string' && /^session_[A-Za-z0-9]{8,64}$/.test(r.bridgeSessionId)
        ? 'https://claude.ai/code/' + r.bridgeSessionId : '',
      lastUser: msgs.user,
      lastAssistant: msgs.assistant,
    });
  }
  return out.sort(compareSessions);
}

module.exports = {
  DEFAULTS, STALE_MS, sidKey, encodeCwd, pidAlive, readRegistry, lastTitles, cachedTitles,
  findTranscript, readSummary, lastMessages, gitBranch, groupOf, compareSessions, buildSessions,
};
