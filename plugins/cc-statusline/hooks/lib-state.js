// Shared state-file primitives for cc-statusline: the trackers in hooks/, the
// status line itself, and the background refreshers in scripts/.
//
// The trackers used to do an UNLOCKED read -> write -> verify, which loses
// entries whenever two hooks run at once: measured 4 of 6 rounds losing entries
// (up to 5 of 12) when SubagentStart fired concurrently for parallel subagents.
//
// Locks are files created with 'wx' (atomic on NTFS and POSIX: exactly one
// creator wins) holding the owner's pid. Two rules keep them sound:
//
//   * A lock is only ever removed by its owner, or -- when orphaned -- by the one
//     process holding the '<lock>.reclaim' token. An earlier version reclaimed
//     with stat -> unlink, which could delete a lock another process had just
//     taken, and when it could not get the lock within the timeout it ran the
//     update UNLOCKED anyway; both let two writers overlap and lose data.
//   * "Orphaned" means the owner pid is no longer alive, or the lock is older
//     than a hard ceiling (covers pid reuse and a lock never written). A live
//     owner is never robbed before that ceiling, however slow it is.
//
// Hooks must still never block or break the main flow: a lock that cannot be
// had within the timeout makes the update SKIP (returns undefined/false) -- one
// dropped update is recoverable, a lost-update race silently corrupts others'.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Atomic write: write to a per-pid temp file then rename. On both POSIX
// (rename(2)) and Windows (MoveFileEx with REPLACE_EXISTING) this is a single
// atomic filesystem op, so concurrent readers never see a half-written file.
// Creates the parent directory if it does not exist yet.
const atomicWrite = (f, data) => {
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); return; }
    catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (e.code !== 'ENOENT' || attempt) return;
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (_) {}
    }
  }
};

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  // Signal 0 only probes: ESRCH = gone, EPERM = exists but not ours (alive).
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Owner pid in the lock; 0 = present but empty/unparseable (its creator is
// between create and write), -1 = no lock.
const lockOwner = (p) => {
  let s;
  try { s = fs.readFileSync(p, 'utf8'); } catch (e) { return -1; }
  const n = parseInt(s, 10);
  return n > 0 ? n : 0;
};

const isOrphan = (p, hardMaxMs) => {
  let st;
  try { st = fs.statSync(p); } catch (e) { return false; }
  const owner = lockOwner(p);
  if (owner === -1) return false;
  if (owner > 0 && !pidAlive(owner)) return true;
  return Date.now() - st.mtimeMs > hardMaxMs;
};

// Create lock p for this process: 'ok', 'busy' (someone holds it -- worth
// waiting for) or 'fatal' (an error retrying cannot fix, e.g. an unwritable
// directory). Windows reports a lockfile held or being deleted by another
// process as EPERM/EBUSY rather than EEXIST, so those count as busy. A missing
// directory is created once.
const BUSY = new Set(['EEXIST', 'EPERM', 'EBUSY']);
const tryLock = (p) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return 'ok';
    } catch (e) {
      if (BUSY.has(e.code)) return 'busy';
      if (e.code !== 'ENOENT' || attempt) return 'fatal';
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
    }
  }
  return 'fatal';
};
const tryCreate = (p) => tryLock(p) === 'ok';

// Synchronous sleep that does not burn CPU (the old wait was a busy loop that
// pegged a core for the whole timeout).
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };

const releaseLock = (p) => { try { if (lockOwner(p) === process.pid) fs.unlinkSync(p); } catch (e) {} };

// Remove p if it is orphaned. The test and the delete both happen while holding
// the '<p>.reclaim' token: nobody else may delete p meanwhile (only its owner or
// a token holder does), and nobody can replace it (creation needs p absent), so
// the file tested is the file deleted. A reclaimer that died holding the token
// leaves it orphaned in turn; it is cleared on sight so reclaim cannot wedge.
const reclaim = (p, hardMaxMs) => {
  const token = p + '.reclaim';
  if (!tryCreate(token)) {
    if (isOrphan(token, 5000)) { try { fs.unlinkSync(token); } catch (e) {} }
    return false;
  }
  try { if (isOrphan(p, hardMaxMs)) { try { fs.unlinkSync(p); } catch (e) {} } }
  finally { releaseLock(token); }
  return true;
};

// Single attempt: take lock p, reclaiming it first if orphaned.
const acquireLock = (p, hardMaxMs) => tryCreate(p) || (reclaim(p, hardMaxMs) && tryCreate(p));
const ownsLock = (p) => lockOwner(p) === process.pid;

// Exclusive section around fn. Short-held (a read-modify-write of a small JSON
// file), so a lock older than 10s is treated as orphaned even if its pid looks
// alive (Windows reuses pids). Returns fn()'s result, or undefined when the lock
// could not be had within timeoutMs -- fn is then NOT run.
const withFileLock = (file, fn, timeoutMs = 2000) => {
  const lockPath = file + '.lock';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = tryLock(lockPath);
    if (r === 'ok') break;
    // Nothing to wait for: retrying an unwritable directory only burns the timeout.
    if (r === 'fatal' || Date.now() >= deadline) return undefined;
    reclaim(lockPath, 10000);
    // Contention windows here are ~1ms. On Windows the timer resolution makes
    // this sleep ~15ms in practice (measured median 15.4ms), not 2ms.
    sleepMs(2);
  }
  try { return fn(); } finally { releaseLock(lockPath); }
};

// Locked CAS merge: the whole read -> mutate -> write -> verify cycle runs
// inside the lock. true once verify passes; false if it never did or the lock
// could not be had (the update was skipped).
const casMerge = (file, mutate, verify, maxRetries = 10) => withFileLock(file, () => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    // Guard against a non-plain-object payload (array, string, number, null):
    // properties assigned onto an array are dropped by JSON.stringify, so a
    // corrupted file would swallow every write silently.
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
    mutate(cur);
    atomicWrite(file, JSON.stringify(cur));
    let after = {};
    try { after = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    if (verify(after)) return true;
  }
  return false;
}) === true;

// ── Session state files ──
// They used to live in os.tmpdir() as claude-<kind>-<sid>.*. Windows cleans
// that directory by age (Storage Sense / Disk Cleanup): on 2026-11-03 every
// claude-*.json older than about three days was gone at once, so a 10-day
// session had lost its agents and skills history while its mcp file, rewritten
// on every call, survived. They now live under ~/.claude/cc-statusline/state/,
// which nothing but this plugin touches; pruneState() is the only cleanup.
//
// Transition: hooks installed from an older plugin version keep writing to
// tmpdir until the plugin is updated and the session restarted, while a newer
// statusline.js already reads here. So when the legacy copy is NEWER than (or
// the only copy of) the file, it is copied over first. A copy can in theory
// land between a hook's read and write and lose that one update; the window is
// transitional and a lost update is the recoverable failure mode here.
const STATE_DIR = path.join(os.homedir(), '.claude', 'cc-statusline', 'state');
const PRUNE_AGE_MS = 30 * 86400000;
const stateFile = (name) => {
  const p = path.join(STATE_DIR, name);
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}
  try {
    const legacy = path.join(os.tmpdir(), name);
    const ls = fs.statSync(legacy);
    // Windows copyFileSync keeps the source mtime, so a legacy file older than
    // the prune age would be copied, pruned the next day, and copied again.
    if (Date.now() - ls.mtimeMs > PRUNE_AGE_MS) return p;
    let cur = null;
    try { cur = fs.statSync(p); } catch (e) {}
    if (!cur || ls.mtimeMs > cur.mtimeMs) fs.copyFileSync(legacy, p);
  } catch (e) {}
  return p;
};

// Remove state files not modified for maxAgeMs (default 30 days). Stamped so a
// caller may invoke it on every event and it still scans at most once a day.
// A session whose file has not been touched for that long loses that file,
// which is the trade accepted for never letting the directory grow unbounded.
const pruneState = (maxAgeMs = PRUNE_AGE_MS) => {
  try {
    const stamp = path.join(STATE_DIR, '.last-prune');
    try { if (Date.now() - fs.statSync(stamp).mtimeMs < 86400000) return; } catch (e) {}
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stamp, String(Date.now()));
    const now = Date.now();
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.startsWith('claude-')) continue;
      const p = path.join(STATE_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
};

module.exports = { atomicWrite, withFileLock, casMerge, acquireLock, ownsLock, releaseLock, pidAlive, stateFile, pruneState, STATE_DIR };
