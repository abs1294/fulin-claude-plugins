'use strict';
// Which terminal sessions should come back after the machine restarts.
//
// The rule, as the user put it: every terminal session that is open is "kept"
// by default; one that I close stops being kept; after a restart, the kept ones
// are opened again.
//
// So the whole question is telling "I closed it" from "the machine went down".
// Both look the same from outside: the session is gone. The difference is
// whether the board outlived it:
//   - a session that disappears while the board keeps running for another
//     GRACE_MS was closed by the user  -> no longer kept;
//   - a session that was still there the last time the board looked, before
//     the board itself stopped, went down WITH the machine -> still kept, and
//     offered for restoring the next time the board starts.
// The grace period exists because at shutdown Windows ends the terminals a few
// seconds before it ends the board; without it every session would be seen
// "closing" right before the lights go out, and nothing would ever be restored.
//
// Also kept per session: the command line it was started with, so a restored
// session gets the same flags (--append-system-prompt and the like), not a
// bare `claude`.
const fs = require('fs');
const path = require('path');

const GRACE_MS = 90 * 1000;
// What the SessionEnd hook (scripts/session-end-hook.js) reports when you end a
// session yourself. Anything else - "other" above all, which is also what a
// session killed from outside reports - decides nothing, and the 90-second rule
// applies as before. Only "other" has been seen first-hand (2026-11-13, a
// `claude -p` run ending); the names below are Claude Code's documented ones.
const USER_ENDED = /^(prompt_input_exit|logout|clear|exit)$/;
const FORGET_CLOSED_MS = 14 * 86400000;   // a closed session stays in the "recently closed" list this long
const FORGET_KEPT_MS = 30 * 86400000;     // a kept session nobody restored is dropped after this

// Splits a Windows command line into tokens, keeping quoted parts whole (quotes included).
function tokens(cmd) {
  const out = [];
  const re = /"(?:[^"\\]|\\.)*"|[^\s"]+(?:"(?:[^"\\]|\\.)*"[^\s"]*)*/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[0]);
  return out;
}

// The command a session was started with, minus whatever said WHICH
// conversation to open (-c, --resume <id>, --session-id <id>, --fork-session):
// the restore adds its own --resume. Everything else is left as typed.
function launchCommand(cmd) {
  const t = tokens(cmd);
  if (!t.length) return 'claude';
  const out = [t[0]];
  for (let i = 1; i < t.length; i++) {
    const x = t[i];
    if (x === '-c' || x === '--continue' || x === '--fork-session') continue;
    if (x === '-r' || x === '--resume' || x === '--session-id') { if (i + 1 < t.length && !t[i + 1].startsWith('-')) i++; continue; }
    if (/^--(resume|session-id)=/.test(x)) continue;
    out.push(x);
  }
  return out.join(' ');
}

// The same command under this session's fixed name ('' = it has none). A fixed name already in it is taken out - it may be
// another session's (a folder's usual command is taken from one that was open there); a name you gave yourself stays,
// and the fixed one, coming last, is what counts (measured 2026-11-24: of two --name, the last). known: the fixed names.
const bareWord = (x) => String(x || '').replace(/^["']|["']$/g, '');
function withName(cmd, name, known = new Set()) {
  const t = tokens(cmd), out = [];
  for (let i = 0; i < t.length; i++) {
    if ((t[i] === '-n' || t[i] === '--name') && known.has(bareWord(t[i + 1]))) { i++; continue; }
    if (/^--name=/.test(t[i]) && known.has(bareWord(t[i].slice(7)))) continue;
    out.push(t[i]);
  }
  // (nothing to take out: the command is left exactly as it is)
  const base = !/claude(\.exe|\.cmd)?"?$/i.test(t[0] || '') ? 'claude' : out.length === t.length ? String(cmd).trim() : out.join(' ');   // not claude itself: what the launchers fall back to
  return base + (name ? ' --name ' + name : '');
}

class Keeper {
  constructor(file, opts = {}) {
    this.file = file;
    this.grace = opts.graceMs === undefined ? GRACE_MS : opts.graceMs;
    this.entries = {};
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.sessions && typeof j.sessions === 'object') this.entries = j.sessions; } catch (e) {}
    this.seen = new Set();       // seen alive since this board started
    this.live = new Set();       // alive at the last look
    this.looked = false;         // has it looked at all since this board started
    this.savedAt = 0;
  }

  _save(now, force) {
    if (!force && now - this.savedAt < 30000) return;
    this.savedAt = now;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ sessions: this.entries }, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (e) {}
  }

  // live: the terminal sessions alive right now, [{sessionId, cwd, title, pid}].
  // Returns those whose launch command is not known yet, for the caller to look up.
  // ended: what the SessionEnd hook noted, Map of sessionId -> {reason, at}.
  observe(live, now = Date.now(), ended = null) {
    let changed = false;
    this.live = new Set(live.map((s) => s.sessionId));
    this.looked = true;
    const needCommand = [];
    for (const s of live) {
      let e = this.entries[s.sessionId];
      if (!e) { e = this.entries[s.sessionId] = { keep: true }; changed = true; }
      // Open again after having been closed: it is an open terminal session, so it is kept again.
      if (e.keep === false && e.closedAt && !e.off) { e.keep = true; delete e.closedAt; changed = true; }
      if (e.cwd !== s.cwd || e.title !== s.title) { e.cwd = s.cwd; e.title = s.title; changed = true; }
      e.lastSeen = now;
      delete e.goneAt;
      this.seen.add(s.sessionId);
      if (!e.command && s.pid) needCommand.push({ sessionId: s.sessionId, pid: s.pid });
    }
    for (const sid of this.seen) {
      if (this.live.has(sid)) continue;
      const e = this.entries[sid];
      if (!e) continue;
      if (!e.goneAt) e.goneAt = now;
      // Gone, and the board is still here GRACE later: the user closed it.
      if (e.keep !== false && now - e.goneAt >= this.grace) { e.keep = false; e.closedAt = now; changed = true; }
    }
    // You ended it yourself: known at once, and known even if the board was not
    // running then. A note older than the last time the session was seen open
    // is about an earlier run of it (it has been resumed since).
    for (const [sid, m] of ended || []) {
      const e = this.entries[sid];
      if (!e || this.live.has(sid) || e.keep === false || !USER_ENDED.test(String(m.reason))) continue;
      if (m.at < (e.lastSeen || 0) - 60000) continue;
      e.keep = false; e.closedAt = m.at; e.endedBy = m.reason; changed = true;
    }
    for (const [sid, e] of Object.entries(this.entries)) {
      const idle = now - (e.closedAt || e.lastSeen || now);
      if (!this.live.has(sid) && idle > (e.keep === false ? FORGET_CLOSED_MS : FORGET_KEPT_MS)) { delete this.entries[sid]; changed = true; }
    }
    this._save(now, changed);
    return needCommand;
  }

  setCommand(sid, cmd) { const e = this.entries[sid]; if (e && cmd) { e.command = launchCommand(cmd); this._save(Date.now(), true); } }

  // The user's own switch for one session. Off stays off until switched on again, even if the session is open.
  setKeep(sid, keep) {
    const e = this.entries[sid];
    if (!e) return false;
    e.keep = !!keep;
    if (keep) { delete e.off; delete e.closedAt; } else e.off = true;
    this._save(Date.now(), true);
    return true;
  }

  isKept(sid) { const e = this.entries[sid]; return !e || e.keep !== false; }

  view(sid, e) { return { sessionId: sid, cwd: e.cwd || '', title: e.title || '', lastSeen: e.lastSeen || 0, closedAt: e.closedAt || 0, command: e.command || 'claude' }; }

  // Kept, not open now, and not seen since this board started: they were open when the board last stopped.
  // Nothing is offered before the first look: until then every kept session, the ones open right now
  // included, would read as "not open" (seen 2026-11-13: nine open sessions listed for restoring during
  // the three seconds after a restart).
  restorable() {
    if (!this.looked) return [];
    return Object.entries(this.entries).filter(([sid, e]) => e.keep !== false && !this.live.has(sid) && !this.seen.has(sid) && e.cwd)
      .map(([sid, e]) => this.view(sid, e)).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  // Closed by the user lately: not restored automatically, but one click away.
  recentlyClosed() {
    return Object.entries(this.entries).filter(([sid, e]) => e.keep === false && e.closedAt && !this.live.has(sid) && e.cwd)
      .map(([sid, e]) => this.view(sid, e)).sort((a, b) => b.closedAt - a.closedAt).slice(0, 20);
  }

  get(sid) { const e = this.entries[sid]; return e ? this.view(sid, e) : null; }

  // Ended from the board: closed by you, as of now.
  // info: {cwd, title}, for a session ended before the board had noted it down.
  markClosed(sid, now = Date.now(), info = null) {
    let e = this.entries[sid];
    if (!e && info && info.cwd) e = this.entries[sid] = { cwd: info.cwd, title: info.title || '', lastSeen: now };
    if (e) { e.keep = false; e.closedAt = now; this.seen.add(sid); this._save(now, true); }
  }

  // The command to open a conversation with when it has none on record: the one
  // last used in the same folder, else the one most sessions here were started with.
  defaultCommand(cwd) {
    const withCmd = Object.values(this.entries).filter((e) => e.command);
    const same = withCmd.filter((e) => e.cwd === cwd).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];
    if (same) return same.command;
    const count = new Map();
    for (const e of withCmd) count.set(e.command, (count.get(e.command) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'claude';
  }

  // "Not needed": drop it from both lists.
  forget(sids) {
    let n = 0;
    for (const sid of sids || []) if (this.entries[sid] && !this.live.has(sid)) { delete this.entries[sid]; n++; }
    if (n) this._save(Date.now(), true);
    return n;
  }

  // Being reopened: from now on it is treated like any session seen this run
  // (so it is not offered again while it is starting up).
  markRestoring(sid) { this.seen.add(sid); const e = this.entries[sid]; if (e) { delete e.closedAt; e.keep = true; delete e.off; e.goneAt = Date.now(); this._save(Date.now(), true); } }
}

// ── opening a session in a terminal window ──

// A terminal started from the board inherits the board's environment, and the
// board is usually started from inside a Claude Code session. With that
// session's identity variables present, the new `claude` runs but never writes
// its entry under ~/.claude/sessions, so nothing (this board included) can see
// it. Measured 2026-11-13 on 2.1.323: with the variables, no entry after 45
// seconds; without them, an entry after 4. Only the variables that say "you
// are inside session X" are removed; settings such as CLAUDE_CODE_NO_FLICKER
// are the user's and stay.
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_JOB_DIR|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|BRIDGE_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED))$/i;
function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!SESSION_VARS.test(k)) out[k] = v;
  return out;
}

// One command line, made safe to sit on a line of a .cmd file: % doubled, the
// characters cmd acts on escaped where they are outside quotes, no line breaks.
function batchLine(cmd) {
  let out = '', quoted = false;
  for (const ch of String(cmd).replace(/[\r\n]+/g, ' ')) {
    if (ch === '"') quoted = !quoted;
    if (ch === '%') out += '%%';
    else if (!quoted && '&|<>^()'.includes(ch)) out += '^' + ch;
    else out += ch;
  }
  return out;
}

// The command goes through a small .cmd file rather than onto the Windows
// Terminal command line: wt treats ';' as "next command", and the flags a
// session was started with can hold any text (a system prompt, for one).
// resume: false starts a new conversation under this id (it has no transcript yet).
// prompt: something to say as soon as the conversation is open (used to pick up work that was cut off).
// It goes on the command line as one quoted argument, so the characters that would end the quoting are taken out.
function launcherText(command, sid, resume, prompt) {
  const first = tokens(command)[0] || '';
  const safe = /claude(\.exe|\.cmd)?"?$/i.test(first) ? command : 'claude';
  const say = prompt ? ' "' + String(prompt).replace(/["\r\n]/g, ' ').replace(/\\+$/, '').slice(0, 1000) + '"' : '';
  return ['@echo off', 'chcp 65001 >nul', batchLine(safe + (resume ? ' --resume ' : ' --session-id ') + sid + say), ''].join('\r\n');
}

function writeLauncher(dir, sid, command, resume, prompt) {
  if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new Error('bad session id');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  try { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (n.endsWith('.cmd') && now - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } } catch (e) {}
  const file = path.join(dir, sid + '.cmd');
  fs.writeFileSync(file, launcherText(command, sid, resume, prompt));
  return file;
}

module.exports = { USER_ENDED, Keeper, launchCommand, withName, tokens, cleanEnv, batchLine, launcherText, writeLauncher, GRACE_MS };
