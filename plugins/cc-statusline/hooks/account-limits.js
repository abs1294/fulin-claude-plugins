#!/usr/bin/env node
// The account's usage limits (5-hour and 7-day), asked of Claude Code itself
// after a conversation answered, and kept in state/account-limits.json: for the
// status line, and THE place every other plugin reads the limits from
// (session-board, goal2 -- nobody else gathers them). Fields are added to it,
// never changed; v goes up if one ever has to be.
//
// Why: rate-limit-snapshots.json holds what each terminal session was LAST TOLD.
// A session rewrites that figure every 30s with the time of the writing, so an
// old one looks new (2026-11-24: a Mac showed 3% while the account was at 34%),
// and a conversation without a terminal (session-board, the desktop app) never
// writes there at all.
//
// How: a `get_usage` control request to `claude -p` -- no message is sent, no
// model runs, no transcript is written (measured on 2.1.330: 0 tokens, about 2s).
// None of the user's settings are loaded, so no hook and no plugin runs in it.
//
//   kick()                      called by the Stop hook: returns at once; starts
//                               this file with --ask when the last asking is
//                               older than EVERY_MS
//   node account-limits.js --ask   does the asking (detached, nobody waits for it)
//
// File: { v: 1, at, five_hour, seven_day, tried, none }
//       our own: none_at, when it was last said that there are no limits (gone once there are);
//                next, not asked before (written before asking: an asking that fails keeps to it)
//   at     ms, when Claude Code answered with these figures
//   a window: { used_percentage, resets_at (seconds) };
//             { used_percentage, resets_at: null } -- the account has this limit
//             and no window of it is running now: nothing to wait for;
//             null -- the account does not have this limit
//   tried  ms, the last asking, answered or not
//   none   true: the account has no such limits (an API key)
//   A window whose resets_at has passed is over: the reader tells.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { atomicWrite, acquireLock, releaseLock, STATE_DIR } = require('./lib-state');

const FILE = path.join(STATE_DIR, 'account-limits.json');
const EVERY_MS = 5 * 60000;          // not more often than this, failures included
const NONE_EVERY_MS = 3600000;       // an account without limits: not so often
const KEEP_MS = 24 * 3600000;        // figures this young are not given up for a "no limits"
const GIVE_UP_MS = 20000;
const END_MS = 3000;                 // let it end by itself: killed, it leaves its session files behind
const GUARD = 'CC_STATUSLINE_ASKING';

const read = () => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) && j.v >= 1 ? j : {}; } catch (e) { return {}; }
};
const every = (j) => (Number.isFinite(j.none_at) ? NONE_EVERY_MS : EVERY_MS);
// A time further ahead than it can be (the clock was set back) does not hold the asking off.
const due = (j, now = Date.now()) => !(Number.isFinite(j.next) && j.next > now && j.next - now <= every(j));

function kick() {
  try {
    if (process.env[GUARD] || !due(read())) return false;
    spawn(process.execPath, [__filename, '--ask'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.homedir(), env: Object.assign({}, process.env, { [GUARD]: '1' }) })
      .on('error', () => {}).unref();
    return true;
  } catch (e) { return false; }
}

// The answer -> {five_hour, seven_day}, or {none: true}, or null (not an answer: also one with
// a window that cannot be read, which is not the same as an account without it).
// Its times carry fractions of a second that the status line's do not: to the
// minute, so both count as the same window.
function windows(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.rate_limits_available === false) return { none: true };
  const u = r.rate_limits;
  if (!u || typeof u !== 'object') return null;
  const win = (w) => {
    if (w === null || w === undefined) return null;
    if (typeof w !== 'object' || !('utilization' in w) || !('resets_at' in w)) return undefined;
    const pct = w.utilization === null || w.utilization === undefined ? 0 : w.utilization;
    if (w.resets_at === null || w.resets_at === undefined) return typeof pct === 'number' ? { used_percentage: pct, resets_at: null } : undefined;
    const at = Math.round(Date.parse(w.resets_at) / 60000) * 60;
    return Number.isFinite(at) && typeof w.utilization === 'number' ? { used_percentage: w.utilization, resets_at: at } : undefined;
  };
  const out = { five_hour: win(u.five_hour), seven_day: win(u.seven_day) };
  return out.five_hour === undefined || out.seven_day === undefined || !(out.five_hour || out.seven_day) ? null : out;
}

// What a window in the file says now: 'none' (the account does not have it), 'idle' (has it, none
// running), 'running', 'over' (its time has passed: nothing is known any more), or '' (not a window;
// one that far ahead is garbage).
const MAX_FUTURE_SEC = 8 * 86400;
function stateOf(w, nowSec = Math.floor(Date.now() / 1000)) {
  if (w === null || w === undefined) return 'none';
  if (typeof w !== 'object' || typeof w.used_percentage !== 'number') return '';
  if (w.resets_at === null) return 'idle';
  if (typeof w.resets_at !== 'number' || w.resets_at - nowSec > MAX_FUTURE_SEC) return '';
  return w.resets_at > nowSec ? 'running' : 'over';
}
// The answer to go by, or null: one that was given, and of which at least one window still says something
// - or that there are none on this account (then it has neither window).
function current(now = Date.now()) {
  const a = read();
  if (a.none === true && Number.isFinite(a.none_at) && a.none_at <= now + 60000) return { at: a.none_at, five_hour: null, seven_day: null };
  const says = (w) => ['idle', 'running'].includes(stateOf(w, Math.floor(now / 1000)));
  return Number.isFinite(a.at) && a.at <= now + 60000 && (says(a.five_hour) || says(a.seven_day)) ? a : null;
}

// The Claude Code to ask: the one whose hook this is, then the usual place, then PATH.
function claude() {
  const win = process.platform === 'win32', bin = path.join(os.homedir(), '.local', 'bin');
  const runs = (f) => { try { return !!f && fs.statSync(f).isFile() && !(win && !/\.exe$/i.test(f)); } catch (e) { return false; } };
  const exec = process.env.CLAUDE_CODE_EXECPATH;
  if (runs(exec) && /claude/i.test(path.basename(exec))) return { file: exec, shell: false };
  const own = path.join(bin, win ? 'claude.exe' : 'claude');
  if (runs(own)) return { file: own, shell: false };
  return { file: 'claude', shell: win };   // (Windows: an npm install is claude.cmd, which only a shell runs)
}

// -> Promise of the response, or null
function ask() {
  return new Promise((resolve) => {
    let p = null, buf = '', done = false;
    const finish = (v) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (!p || p.exitCode !== null || p.signalCode !== null) return resolve(v);
      const hard = setTimeout(() => { try { p.kill(); } catch (e) {} resolve(v); }, END_MS);
      p.once('exit', () => { clearTimeout(hard); resolve(v); });
      try { p.stdin.end(); } catch (e) {}
    };
    const timer = setTimeout(() => finish(null), GIVE_UP_MS);
    const c = claude(), args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--tools', ''];
    // What ties a process to the conversation this hook ran in is not handed on.
    const env = Object.assign({}, process.env, { [GUARD]: '1' });
    // Nor is what makes one conversation pay another way (an API key, Bedrock, Vertex...): the
    // file is the whole computer's, and what is asked about is the account signed in to.
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE_[A-Z_]+|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|CHILD_SESSION|CHILD_NOTES_DIR|BRIDGE_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH))$/i.test(k)) delete env[k];   // (i: Windows does not tell case)
    try { p = spawn(c.file, c.shell ? args.map((a) => a || '""') : args, { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env, shell: c.shell }); } catch (e) { return finish(null); }
    p.on('error', () => finish(null));
    p.on('exit', () => finish(null));
    p.stdin.on('error', () => {});
    p.stdout.on('data', (d) => {
      buf += d;
      for (let k; (k = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        let e; try { e = JSON.parse(line); } catch (x) { continue; }
        if (e && e.type === 'control_response') { const r = e.response; return finish(r && r.subtype === 'success' && r.response ? r.response : null); }
      }
    });
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
  });
}

async function main() {
  const lock = FILE + '.asking';
  if (!acquireLock(lock, 60000)) return;   // another is asking
  try {
    const was = read();
    if (!due(was)) return;
    const tried = Date.now();
    atomicWrite(FILE, JSON.stringify(Object.assign({}, was, { v: 1, tried, next: tried + every(was) })));   // first: one that fails is not tried again at once
    const w = windows(await ask());
    if (!w) return;
    const at = Date.now();
    // "No limits" is also what is said while nobody is signed in: it does not wipe out figures of today.
    if (w.none && Number.isFinite(was.at) && at - was.at < KEEP_MS) return atomicWrite(FILE, JSON.stringify(Object.assign({}, was, { v: 1, tried, none_at: at, next: tried + NONE_EVERY_MS })));
    atomicWrite(FILE, JSON.stringify(w.none ? { v: 1, none: true, none_at: at, tried, next: tried + NONE_EVERY_MS } : { v: 1, at, five_hour: w.five_hour, seven_day: w.seven_day, tried, next: tried + EVERY_MS }));
  } finally { releaseLock(lock); }
}

module.exports = { kick, read, current, stateOf, due, windows, FILE, EVERY_MS, NONE_EVERY_MS };
if (require.main === module && process.argv[2] === '--ask') main().catch(() => {}).then(() => process.exit(0));
