// Shared state-file primitives for the cc-statusline trackers.
//
// Lifted verbatim (in behaviour) from statusline.js, which already used a
// lockfile for its own shared stores. The trackers were doing an UNLOCKED
// read -> write -> verify, which loses entries whenever two hooks run at once:
// measured 4 of 6 rounds losing entries (up to 5 of 12) when SubagentStart
// fired concurrently for parallel subagents.
//
// Everything here is fail-open on purpose. Hooks must never block or break the
// main flow, so a lock we cannot acquire degrades to running unlocked rather
// than skipping the update — a slightly stale value beats a lost one.
const fs = require('fs');

// Atomic write: write to a per-pid temp file then rename. On both POSIX
// (rename(2)) and Windows (MoveFileEx with REPLACE_EXISTING) this is a single
// atomic filesystem op, so concurrent readers never see a half-written file.
const atomicWrite = (f, data) => {
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
};

// Exclusive inter-process lock via atomic lockfile creation.
//
// `wx` create is atomic on both NTFS and POSIX: exactly one process wins. The
// lock is advisory and best-effort — on timeout we run unlocked rather than
// skip the update.
const withFileLock = (file, fn, timeoutMs = 2000) => {
  const lockPath = file + '.lock';
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  while (Date.now() < deadline) {
    try { fd = fs.openSync(lockPath, 'wx'); break; } catch (e) {
      // Windows raises EPERM/EBUSY (not just EEXIST) when another process holds
      // or is deleting the lockfile. Treating those as fatal bails out early and
      // runs the unlocked path — the sole cause of residual loss at high
      // concurrency. Only give up on errors retrying cannot fix.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY') break;
      // Reclaim a lock orphaned by a crashed process (older than 10s).
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        // unlink can fail if another process reclaims it first; fall through to
        // the spin below rather than continue-ing, so this cannot busy-loop.
        if (age > 10000) { fs.unlinkSync(lockPath); }
      } catch (_) {}
      // Busy-wait briefly: contention windows here are ~1ms.
      const spin = Date.now() + 2;
      while (Date.now() < spin) { /* spin */ }
    }
  }
  try { return fn(); }
  finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  }
};

// Locked CAS merge: the whole read -> mutate -> write -> verify cycle runs
// inside the lock, so a concurrent writer cannot land between our write and our
// verify. Retries remain as a safety net for the unlocked fallback path.
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
    if (verify(after)) return;
  }
});

module.exports = { atomicWrite, withFileLock, casMerge };
