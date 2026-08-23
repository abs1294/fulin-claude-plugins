#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);

    // Row visibility config (see /cc-statusline:rows). Missing file = everything on.
    const rowDefaults = { summary:1, dir:1, repo:1, model:1, cost:1, usage:1, quota:1, agents:1, skills:1, crons:1, memory_mcp:1, edited:1, history:1 };
    let rowCfg = { ...rowDefaults };
    let cfgEnabled = true;
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'cc-statusline-rows.json'), 'utf8'));
      for (const k of Object.keys(rowDefaults)) if (k in stored) rowCfg[k] = !!stored[k];
      if (stored.enabled === false) cfgEnabled = false;
    } catch (e) {}
    // Master switch off — print nothing (Claude Code shows blank status area)
    if (!cfgEnabled) { process.stdout.write(''); return; }
    const showRow = k => !!rowCfg[k];

    const R = '\x1b[0m', DIM = '\x1b[2m';
    const CYAN = '\x1b[36m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', MAGENTA = '\x1b[35m', BLUE = '\x1b[34m';

    // Atomic write: write to a per-pid temp file then rename. On both POSIX
    // (rename(2)) and Windows (MoveFileEx with REPLACE_EXISTING) this is a
    // single atomic filesystem op, so concurrent readers never see a half-
    // written file and the target is either the old content or the new.
    // Normalize a stored per-session entry into {total,base} for every key.
    const normCumEntry = (entry, keys, norm) => {
      const out = {};
      for (const k of keys) out[k] = norm(entry[k]);
      return out;
    };

    const atomicWrite = (f, data) => {
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
    };

    // Exclusive inter-process lock via atomic lockfile creation.
    //
    // casMerge's read -> write -> verify cannot be made correct on its own: two
    // renders can BOTH pass verify (A writes, A verifies OK, B then writes from a
    // pre-A snapshot and also verifies OK -- A's entry is gone yet nobody retries).
    // Measured 18.8% entry loss across 12 rounds of 8-way concurrency. Retrying
    // harder cannot fix it; the read-modify-write needs to be genuinely atomic.
    //
    // wx create is atomic on both NTFS and POSIX: exactly one process wins.
    // The lock is advisory and best-effort -- on timeout we run unlocked rather
    // than skip the update, since a stale statusline number beats a lost one.
    const withFileLock = (file, fn, timeoutMs = 2000) => {
      const lockPath = file + '.lock';
      const deadline = Date.now() + timeoutMs;
      let fd = null;
      while (Date.now() < deadline) {
        try { fd = fs.openSync(lockPath, 'wx'); break; } catch (e) {
          // Windows raises EPERM/EBUSY (not just EEXIST) when another process
          // holds or is deleting the lockfile. Treating those as fatal made us bail
          // out after ~39ms and run on the unlocked path -- measured as the sole
          // cause of residual loss at 16-way concurrency. Only give up on errors
          // that retrying cannot fix (e.g. ENOENT/EACCES on the directory).
          if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY') break;
          // Reclaim a lock orphaned by a crashed render (older than 10s).
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

    // CAS-style merge: read → mutate → atomic write → re-read → verify. If
    // another writer raced past us between our write and the verify read,
    // our change is gone and we retry with fresh state. Bounded to 5 tries
    // to stay cheap under pathological contention; each round is ≈ 1ms.
    // Returns the final state observed after verification.
    const casMerge = (file, mutate, verify, maxRetries = 10) => withFileLock(file, () => {
      let finalState = {};
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let cur = {};
        try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
        // Guard against a non-plain-object payload (array, string, number, null).
        // Properties assigned onto an array are dropped by JSON.stringify, so a
        // corrupted file of the form [1,2,3] would swallow every write silently:
        // mutate() succeeds, the file never changes, no error surfaces.
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
        mutate(cur);
        atomicWrite(file, JSON.stringify(cur));
        let after = {};
        try { after = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
        finalState = after;
        if (verify(after)) return finalState;
      }
      return finalState;
    });

    // Unicode East Asian Width: returns 2 for fullwidth/wide chars, 1 otherwise.
    // Based on UAX #11 (Unicode Standard Annex) + common emoji.
    const isWide = cp =>
      (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
      (cp >= 0x231a && cp <= 0x231b) ||   // ⌚⌛
      (cp >= 0x23e9 && cp <= 0x23f3) ||   // ⏩-⏳
      (cp >= 0x23f8 && cp <= 0x23fa) ||   // ⏸-⏺
      (cp >= 0x25fd && cp <= 0x25fe) ||   // ◽◾
      (cp >= 0x2614 && cp <= 0x2615) ||   // ☔☕
      (cp >= 0x2648 && cp <= 0x2653) ||   // ♈-♓
      cp === 0x267f ||                     // ♿
      cp === 0x26a1 ||                     // ⚡
      (cp >= 0x26aa && cp <= 0x26ab) ||    // ⚪⚫
      (cp >= 0x26bd && cp <= 0x26be) ||    // ⚽⚾
      (cp >= 0x26c4 && cp <= 0x26c5) ||    // ⛄⛅
      cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea || // ⛎⛔⛪
      (cp >= 0x26f2 && cp <= 0x26f3) ||    // ⛲⛳
      cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || // ⛵⛺⛽
      cp === 0x2705 ||                     // ✅
      cp === 0x2728 ||                     // ✨
      cp === 0x274c || cp === 0x274e ||    // ❌❎
      (cp >= 0x2753 && cp <= 0x2755) ||    // ❓❔❕
      cp === 0x2757 ||                     // ❗
      (cp >= 0x2795 && cp <= 0x2797) ||    // ➕➖➗
      cp === 0x27b0 || cp === 0x27bf ||    // ➰➿
      (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK Radicals → CJK Symbols
      (cp >= 0x3041 && cp <= 0x33bf) ||   // Hiragana → CJK Compatibility
      (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
      (cp >= 0x4e00 && cp <= 0xa4cf) ||   // CJK Unified Ideographs + Yi
      (cp >= 0xa960 && cp <= 0xa97c) ||   // Hangul Jamo Extended-A
      (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe6b) ||   // Vertical Forms + CJK Compatibility Forms
      (cp >= 0xff01 && cp <= 0xff60) ||   // Fullwidth ASCII
      (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth Signs
      (cp >= 0x1f004 && cp <= 0x1f9ff) || // Emoji block (Mahjong → Supplemental Symbols)
      (cp >= 0x1fa00 && cp <= 0x1faff) || // Chess symbols + Extended-A emoji
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extension B-F
      (cp >= 0x30000 && cp <= 0x3fffd);   // CJK Extension G+

    const dw = s => {
      let w = 0;
      for (const ch of s.replace(/\x1b\[[0-9;]*m/g, '')) {
        w += isWide(ch.codePointAt(0)) ? 2 : 1;
      }
      return w;
    };
    const pad = (s, w) => { const n = w - dw(s); return n > 0 ? s + ' '.repeat(n) : s; };
    const fit = (s, w) => pad(trunc(s, w), w); // trunc then pad = exact width
    const trunc = (s, w) => {
      let rw = 0, result = '', inEsc = false;
      for (let j = 0; j < s.length; j++) {
        if (s[j] === '\x1b') { inEsc = true; result += s[j]; continue; }
        if (inEsc) { result += s[j]; if (/[a-zA-Z]/.test(s[j])) inEsc = false; continue; }
        const cw = isWide(s.codePointAt(j)) ? 2 : 1;
        if (rw + cw > w) break;
        rw += cw; result += s[j];
      }
      return result;
    };
    const bar = (pct, len = 10) => {
      const filled = Math.max(0, Math.min(len, Math.round(pct / 100 * len)));
      return '\u2588'.repeat(filled) + '\u2591'.repeat(len - filled);
    };
    const cc = pct => pct >= 80 ? RED : pct >= 50 ? YELLOW : GREEN;
    const fmtDur = min => {
      if (min < 60) return `${min}min`;
      if (min < 1440) { const h = Math.floor(min/60), m = min%60; return m > 0 ? `${h}hr ${m}min` : `${h}hr`; }
      const dd = Math.floor(min/1440), h = Math.floor((min%1440)/60);
      return h > 0 ? `${dd}d ${h}hr` : `${dd}d`;
    };
    // Tokens now carry real session usage (tens of millions per session, and the
    // cross-session (all) figure reaches billions), so the top tier is load-bearing
    // rather than theoretical -- hence T, and hence the carry check below.
    //
    // Rounding must be decided BEFORE picking the unit: 999,999 rounds to "1000.0K"
    // if the unit is chosen first, which is both wrong and one char wider than the
    // column budget. Promote to the next unit whenever rounding would reach 1000.
    const fmtTok = (n) => {
      if (!Number.isFinite(n) || n < 0) n = 0;
      // Largest unit first. The threshold for each unit is 999.95 x the NEXT unit
      // down, not 1.0 x its own scale: at 999,999 the K form would round to
      // "1000.0K", so the M row must claim it and render "1.0M". Comparing against
      // the rounded-up boundary is what makes that happen without a retry loop.
      const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
      for (const [scale, suffix] of units) {
        if (n >= scale * 0.99995) return (n / scale).toFixed(1) + suffix;
      }
      return String(Math.round(n));
    };
    const ago = ms => { const m = Math.round((Date.now()-ms)/60000); return m < 1 ? 'now' : m < 60 ? m+'m ago' : Math.floor(m/60)+'h ago'; };

    // ── Data ──
    const model = (i.model?.display_name || '?').replace('Claude ', '');
    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    // Key for the cumulative store ONLY. sid stays truncated at 24 chars because
    // hooks derive the same tmp state filenames from it -- changing that breaks the
    // pairing. But 24 chars of a stripped UUID drops the last 8 hex digits, and 3
    // real cross-project collisions were found in the store, silently merging two
    // sessions' spend. The store is keyed by an in-process map, not a filename, so
    // it can safely use the full id. Pre-existing 24-char keys stay as history.
    const cumKey = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '');

    // Claude Code sometimes resets total_cost / duration / lines (context compact,
    // auto-recovery, etc). Instead of freezing at max (which could over-report),
    // track DELTAS: when payload >= last_baseline, add delta to total; when payload
    // resets (drops below baseline), just re-baseline without touching total.
    // This way total keeps climbing through resets but never double-counts.
    // Single entry point for every payload-derived number. The payload is JSON from
    // another process: a string, null, NaN, Infinity or a negative can all arrive,
    // and any of them poison the cumulative store permanently once written (an
    // Infinity peak makes every later comparison false; a string turns arithmetic
    // into concatenation). Clamp once, here, so nothing downstream has to re-check.
    const num = (x) => (Number.isFinite(x) ? Math.max(0, x) : 0);

    // ── API list-price table, USD per million tokens ──
    // Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-08-23)
    // cw = 5-minute cache write (1.25x input), cr = cache hit (0.1x input).
    //
    // Cost is derived HERE from transcript usage rather than read from the payload's
    // total_cost_usd, because that field covers only the main session and omits every
    // subagent -- measured 23.9% of real spend on this machine. An unknown model
    // contributes 0 rather than a guessed rate, and its tokens are counted separately
    // so the display can flag that the figure is incomplete.
    const PRICE = {
      'fable-5':    { in: 10,   out: 50, cw: 12.50, cr: 1.0  },
      'mythos-5':   { in: 10,   out: 50, cw: 12.50, cr: 1.0  },
      'opus-5':     { in: 5,    out: 25, cw: 6.25,  cr: 0.5  },
      'opus-4-8':   { in: 5,    out: 25, cw: 6.25,  cr: 0.5  },
      'opus-4-7':   { in: 5,    out: 25, cw: 6.25,  cr: 0.5  },
      'opus-4-6':   { in: 5,    out: 25, cw: 6.25,  cr: 0.5  },
      'opus-4-5':   { in: 5,    out: 25, cw: 6.25,  cr: 0.5  },
      'opus-4-1':   { in: 15,   out: 75, cw: 18.75, cr: 1.5  },
      'opus-4':     { in: 15,   out: 75, cw: 18.75, cr: 1.5  },
      'sonnet-5':   { in: 2,    out: 10, cw: 2.50,  cr: 0.2  },
      'sonnet-4-6': { in: 3,    out: 15, cw: 3.75,  cr: 0.3  },
      'sonnet-4-5': { in: 3,    out: 15, cw: 3.75,  cr: 0.3  },
      'sonnet-4':   { in: 3,    out: 15, cw: 3.75,  cr: 0.3  },
      'haiku-4-5':  { in: 1,    out: 5,  cw: 1.25,  cr: 0.1  },
      'haiku-3-5':  { in: 0.80, out: 4,  cw: 1.00,  cr: 0.08 },
      '3-5-haiku':  { in: 0.80, out: 4,  cw: 1.00,  cr: 0.08 },
    };
    // Longest key first so 'opus-4-8' cannot be shadowed by an 'opus-4' substring.
    const PRICE_ORDER = Object.keys(PRICE).sort((a, b) => b.length - a.length);
    // Ids arrive as 'claude-opus-4-8' or 'claude-3-5-haiku-20241022', and some carry
    // dots ('opus-4.8'), so dots normalise to dashes before the substring match.
    const priceOf = (m) => {
      const k = String(m || '').toLowerCase().split('.').join('-');
      for (const name of PRICE_ORDER) if (k.includes(name)) return PRICE[name];
      return null;
    };
    const usageCost = (u, model) => {
      const pr = priceOf(model);
      if (!pr) return null;
      return (num(u.input_tokens) * pr.in
            + num(u.output_tokens) * pr.out
            + num(u.cache_creation_input_tokens) * pr.cw
            + num(u.cache_read_input_tokens) * pr.cr) / 1e6;
    };

    const curCost = num(i.cost?.total_cost_usd);
    const curDur = num(i.cost?.total_duration_ms);
    const curAdd = num(i.cost?.total_lines_added);
    const curRm = num(i.cost?.total_lines_removed);
    // Context-window occupancy, NOT cumulative session usage -- see the tokens row
    // below. Kept only as the fallback when the transcript cannot be read.
    const ctxTok = num(i.context_window?.total_input_tokens) + num(i.context_window?.total_output_tokens);
    // ── Real session token usage ──
    //
    // The payload has no cumulative token field. context_window.total_input_tokens /
    // total_output_tokens are the CURRENT context occupancy (cache reads and writes
    // already folded in), so feeding them to a cumulative accumulator produced a
    // quantity with no meaning -- it read 1.79M against a peak single-turn occupancy
    // of 0.91M. Real usage comes from the transcript: every assistant turn logs
    // message.usage with the four billed components.
    //
    // Turns are DEDUPED BY message.id, KEEPING THE FIRST copy seen. The same
    // assistant message is written to the transcript several times (4x is common),
    // so summing every line double-counts badly -- measured 59.60M naive against
    // 31.81M deduped on this session, and 344.46M against 161.03M on another.
    //
    // Keep-first is deliberate; do NOT "simplify" it to keep-last. Copies are almost
    // always identical, but two opposite exceptions exist in real data, so the tie
    // has to be broken one way and first is the safe end:
    //   - a streaming snapshot can be written before the turn finishes, making the
    //     first copy low by a few thousand tokens;
    //   - a trailing copy can be written with usage entirely ZEROED.
    // Across 508 local transcripts and 50,842 distinct ids, exactly one id varied
    // and it was the zeroed-tail kind: keep-last would have dropped 998,464 tokens
    // (0.005% low), while keep-first matched keep-max exactly (0.000000% error).
    // The streaming-snapshot case costs keep-first at most a few thousand tokens.
    //
    // Read INCREMENTALLY: the state file holds the byte offset already consumed plus
    // the running sums, so each render only parses bytes appended since last time.
    // Two concurrent renders that re-read the same span compute the same sums from
    // the same offset, so the write converges rather than double-counting -- the
    // operation is idempotent in the offset, not an increment of shared state.
    //
    // Subagent transcripts ARE counted: Claude Code writes them under
    // <transcript-dir>/<session-id>/subagents/*.jsonl, and they carried 23.9% of
    // real spend here, so omitting them understated cost badly. Dedup is by
    // message.id across the whole set, so a subagent turn echoed into the parent
    // transcript is still counted once.
    // Known and accepted: a resumed session that copies its transcript can be
    // counted in both entries of the (all) figure.
    // v2: state now carries per-file offsets plus cost. The filename is versioned so
    // a v1 file is ignored rather than misread as a costless single-file scan.
    const tokStatePath = path.join(os.tmpdir(), `claude-toksum2-${sid}.json`);
    // The main transcript plus every subagent transcript beside it. Claude Code
    // stores those under <dir>/<session-id>/subagents/*.jsonl.
    const transcriptTargets = () => {
      const tp = i.transcript_path;
      if (!tp) return [];
      const out = [tp];
      try {
        const dir = path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents');
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
      } catch (e) { /* no subagents dir: main transcript only */ }
      return out;
    };
    // Returns { tok, cost, unpricedTok }, or null when no transcript could be read.
    // Each file keeps its own byte offset so renders stay incremental.
    const readTranscriptUsage = () => {
      const targets = transcriptTargets();
      if (!targets.length) return null;

      let prev = { files: {}, ids: [] };
      try {
        const raw = JSON.parse(fs.readFileSync(tokStatePath, 'utf8'));
        if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') {
          prev = { files: raw.files, ids: Array.isArray(raw.ids) ? raw.ids : [] };
        }
      } catch (e) {}

      const seen = new Set(prev.ids);
      const files = {};
      let tok = 0, cost = 0, unpricedTok = 0;
      let readAny = false;

      for (const tp of targets) {
        let st;
        try { st = fs.statSync(tp); } catch (e) { continue; }
        // size 0 is a not-yet-written transcript or (on Windows) a directory, which
        // statSync also reports as size 0 while openSync would happily open it.
        if (!st.isFile() || st.size === 0) continue;

        const p0 = prev.files[tp];
        let off = p0 ? num(p0.off) : 0;
        let fTok = p0 ? num(p0.tok) : 0;
        let fCost = p0 ? num(p0.cost) : 0;
        let fUnp = p0 ? num(p0.unpricedTok) : 0;
        // Offset past EOF means truncation or a rotated path: rescan from scratch
        // rather than trusting sums that describe different bytes.
        if (off > st.size) { off = 0; fTok = 0; fCost = 0; fUnp = 0; }

        readAny = true;
        if (off === st.size) {
          files[tp] = { off, tok: fTok, cost: fCost, unpricedTok: fUnp };
          tok += fTok; cost += fCost; unpricedTok += fUnp;
          continue;
        }

        let buf = '';
        let consumed = off;
        let fd = null;
        try {
          fd = fs.openSync(tp, 'r');
          const CHUNK = 1 << 20;
          const chunk = Buffer.allocUnsafe(CHUNK);
          // StringDecoder, not chunk.toString(): a multi-byte character straddling a
          // chunk boundary would otherwise decode as two U+FFFD replacements. That
          // corrupts the JSON on that line AND inflates Buffer.byteLength by 2 bytes
          // per occurrence, so the stored offset drifts past the real position and
          // the next render skips live data. The decoder holds the partial sequence
          // until the next chunk completes it.
          const decoder = new StringDecoder('utf8');
          let pos = off;
          while (pos < st.size) {
            const n = fs.readSync(fd, chunk, 0, Math.min(CHUNK, st.size - pos), pos);
            if (n <= 0) break;
            pos += n;
            buf += decoder.write(chunk.subarray(0, n));
            // Only whole lines are processed; a trailing partial line stays in buf
            // and is re-read next time, because consumed never advances past it.
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              consumed += Buffer.byteLength(line, 'utf8') + 1;
              if (!line) continue;
              try {
                const j = JSON.parse(line);
                const u = j.message && j.message.usage;
                if (!u) continue;
                // Dedup by message.id across ALL files: the same assistant turn is
                // written several times, and a subagent turn can also be echoed into
                // the parent transcript. keep-first, per the note above.
                const id = j.message.id;
                if (id) { if (seen.has(id)) continue; seen.add(id); }
                const t = num(u.input_tokens) + num(u.output_tokens)
                        + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
                fTok += t;
                const c = usageCost(u, j.message.model);
                if (c === null) fUnp += t; else fCost += c;
              } catch (e) { /* half-written or non-JSON line: skip */ }
            }
          }
        } catch (e) {
          // Keep whatever this file contributed before the failure.
        } finally {
          if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
        }
        files[tp] = { off: consumed, tok: fTok, cost: fCost, unpricedTok: fUnp };
        tok += fTok; cost += fCost; unpricedTok += fUnp;
      }

      if (!readAny) return null;
      // Cap the id list: only ids that could still reappear matter, and an unbounded
      // array would grow the state file forever on long sessions.
      const ids = [...seen].slice(-4000);
      try { atomicWrite(tokStatePath, JSON.stringify({ files, ids })); } catch (e) {}
      return { tok, cost, unpricedTok };
    };
    let sessionUsage = null;
    try { sessionUsage = readTranscriptUsage(); } catch (e) { sessionUsage = null; }
    // Fallback keeps the row populated (degraded, not broken) when no transcript is
    // readable: tokens fall back to context occupancy.
    const curTok = sessionUsage === null ? ctxTok : sessionUsage.tok;

    // Cumulative usage lives in ONE persistent file keyed by session id.
    // Was: one claude-cum-<sid>.json per session in os.tmpdir(). That lost all
    // history whenever Windows Storage Sense swept %TEMP% (observed: ALL showed
    // ~15% of real spend) and grew one file per session forever. Now: a single
    // file under ~/.claude/usage-data/ (not pruned by cleanupPeriodDays, which
    // only sweeps projects/ transcripts) merged with the same casMerge used for
    // rate-limit snapshots, since concurrent sessions write this every 30s.
    const cumPath = path.join(os.homedir(), '.claude', 'usage-data', 'cc-statusline-cumulative.json');
    try { fs.mkdirSync(path.dirname(cumPath), { recursive: true }); } catch (e) {}
    // cost is NOT stored here any more. It is computed from transcript usage on
    // every render (see PRICE / readTranscriptUsage), which is idempotent and needs
    // none of the epoch/reset machinery below -- that existed only because the
    // payload's total_cost_usd could reset mid-session.
    const CUM_KEYS = ['dur', 'add', 'rm', 'tok'];
    const curVals = { dur: curDur, add: curAdd, rm: curRm, tok: curTok };
    const blankCum = () => ({ dur:{total:0,base:0}, add:{total:0,base:0}, rm:{total:0,base:0}, tok:{total:0,base:0} });
    // Stored shape per key: { settled, peak, lowSince }. `settled` is spend from
    // epochs that have already ended (each payload reset closes an epoch); `peak` is
    // the highest payload seen in the CURRENT epoch. Reported total is settled+peak.
    // `lowSince` is the epoch-ms timestamp when the payload first dropped below the
    // reset threshold, or 0 when it is healthy -- see the debounce note below.
    //
    // Older files stored { total, base }; `total` maps onto settled+peak and `base`
    // is exactly the old epoch peak, so reading base as peak and settled as
    // (total - base) carries history forward without a migration pass.
    const normCum = (st) => {
      if (st && typeof st === 'object') {
        if (typeof st.peak === 'number') return { settled: st.settled || 0, peak: st.peak, lowSince: st.lowSince || 0 };
        const total = st.total || 0, base = st.base || 0;
        return { settled: Math.max(0, total - base), peak: base, lowSince: 0 };
      }
      if (typeof st === 'number') return { settled: 0, peak: st, lowSince: 0 };
      return { settled: 0, peak: 0, lowSince: 0 };
    };
    // Snapshot our PRE-render persisted state once. The casMerge mutate below can
    // run several times (retry on lost race) and MUST be idempotent: deriving the
    // delta from whatever is in the file at mutate time double-counts, because by
    // retry #2 the file already contains our own write. So the delta is always
    // computed against this frozen "before" state, never against live file data.
    let before = {};
    let firstSeen = true;
    try {
      const priorSessions = JSON.parse(fs.readFileSync(cumPath, 'utf8')).sessions || {};
      if (Object.prototype.hasOwnProperty.call(priorSessions, cumKey)) {
        before = priorSessions[cumKey] || {};
        firstSeen = false;
      }
    } catch (e) {}
    // Accounting model: PEAK PER EPOCH, not per-render deltas.
    //
    // total_cost_usd is already the session's own cumulative figure, so the only
    // reason to accumulate at all is that Claude Code occasionally RESETS it
    // (context compact, auto-recovery). Deltas were the wrong tool for that: two
    // concurrent renders of one session hold different snapshots of the same
    // counter, and charging each render's rise re-charged the gap between the two
    // snapshots every ~30s. That pumped one session to $1,008,997 against a true
    // spend of $690.
    //
    // Tracking the epoch PEAK is immune to it. A stale render reporting a LOWER
    // payload cannot raise the peak, so it contributes nothing no matter how often
    // it interleaves -- the result depends only on the highest payload observed,
    // never on the order or number of renders. That makes the merge idempotent and
    // commutative, which is what a lock-free multi-writer store actually needs.
    //
    // Identifying "which render wrote this" was tried first and cannot work: the
    // payload carries no per-render identity, and transcript_path is per SESSION,
    // so two concurrent renders of the blown-up session share it (verified: that
    // session has exactly one transcript file). Any writer-id scheme therefore
    // collapses to a single id in precisely the case that caused the bug.
    //
    // Telling a real reset from a stale concurrent snapshot is the whole problem,
    // and with identical writerIds the two look the same at the instant they occur:
    // both are "payload below the stored peak". They differ in MAGNITUDE. Claude
    // Code resets these counters by starting a fresh context, so the payload falls
    // to near zero. A concurrent render, by contrast, is only one refresh behind and
    // sits just under the peak (observed $689.90 vs $73.83 on the same session, and
    // small $10-scale skews in testing).
    //
    // So a drop only closes an epoch when the payload retains less than this
    // fraction of the peak. Treating a shallow dip as a reset is the expensive
    // mistake -- it banks the entire epoch and then re-banks it on every cycle
    // (measured: $110 banked per cycle, reaching $2,300 against a true $110).
    //
    // The fraction alone misfires while a counter is still small: early in a session
    // a lagging render can sit at $1.50 against a $4.50 peak, which is a 67% drop by
    // ratio yet only $3 in absolute terms. RESET_MIN requires the epoch to be worth
    // banking at all, so those early wobbles cannot open spurious epochs.
    //
    // DEBOUNCE (RESET_N). A deep drop alone is still not enough. When two concurrent
    // renders are far apart -- the real case, $689.90 against $73.83 -- every low
    // render clears the fraction test and banks another full epoch, so the total
    // grows by the peak every cycle: measured $13,871.83 after 20 alternations,
    // 20.1x the single-snapshot figure. Per-cycle bounded is NOT bounded; over a
    // 13-hour session that is the original six-figure blow-up again.
    //
    // What separates the two cases is PERSISTENCE, not depth. A stale snapshot is
    // immediately contradicted by the leading render returning a high value. A real
    // compact stays low: every render from then on reports the restarted counter.
    //
    // Persistence is measured in TIME, not in render count. Counting renders fails
    // under real concurrency: two parallel low renders both read the same stored
    // count and both increment it, so a count of 2 is reached by a single dip
    // observed twice rather than by a dip that lasted (measured: $5,519.20 after 25
    // parallel rounds even with a 2-render debounce). A timestamp cannot be
    // double-counted -- the first low render stamps lowSince, and banking requires
    // the CLOCK to have advanced RESET_MS past it, which no number of simultaneous
    // renders can fake. Any payload at or above the peak clears the stamp.
    //
    // RESET_MS sits above the ~30s render cadence so a genuine compact banks on the
    // next render or two, while alternating snapshots -- which clear the stamp every
    // other render -- can never accumulate the required dwell time. It is tied to
    // that cadence: if the status line is ever refreshed markedly less often, raise
    // RESET_MS to stay above the new interval, or a single slow cycle will look like
    // sustained silence and bank an epoch that never ended.
    const RESET_FRAC = 0.5;
    const RESET_MIN = { dur: 300000, add: 500, rm: 500, tok: 500000 };
    const RESET_MS = 45000;
    const nowMs = Date.now();
    // Two ACCEPTED trade-offs fall out of the "cur >= peak clears the clock" rule.
    // Both are known, both self-correct, and neither compounds -- they are recorded
    // here so a later reader does not mistake them for a fresh bug and "fix" the
    // rule that keeps the ping-pong dead.
    //
    // B1 (stale echo -> brief OVER-report): after a real compact, a render still
    // holding the pre-compact payload re-clears the clock and restores the old high
    // peak, so the reported figure jumps back up for a cycle. It resolves as soon as
    // that render exits, and because the peak is only ever restored -- never added
    // to settled -- repeated echoes cannot compound the way the original delta bug
    // did. A transient overstatement beats reviving unbounded accumulation.
    //
    // B2 (lingering old render -> brief UNDER-report): symmetrically, an old render
    // that keeps reporting a value exactly equal to the stored peak holds the epoch
    // open, so genuinely new spend below that peak is not yet visible. It clears the
    // moment the stale render stops or the live payload climbs past the peak.
    const settled = {};
    for (const k of CUM_KEYS) {
      const c = normCum(before[k]);
      const cur = curVals[k];
      const deepLow = cur < c.peak * RESET_FRAC && c.peak >= RESET_MIN[k];
      if (k === 'tok') {
        // tok is exempt from the epoch machinery. It is now a real cumulative total
        // computed from the transcript, so it only ever grows and never "resets" the
        // way a payload counter does -- running it through epoch banking would add
        // the same tokens again on every compact. Monotonic max keeps it correct and
        // still immune to a stale concurrent render reporting a lower figure.
        // Old entries hold the previous mixed context/cumulative quantity; they are
        // left untouched as history, so (all) reads low until sessions turn over.
        settled[k] = { settled: 0, peak: Math.max(c.settled + c.peak, cur), lowSince: 0 };
        continue;
      }
      if (firstSeen) {
        // No prior entry: the payload's own figure is the truth to seed with.
        settled[k] = { settled: 0, peak: cur, lowSince: 0 };
      } else if (cur >= c.peak) {
        // Counter still climbing within this epoch: raise the peak. No addition, so
        // replaying this render any number of times changes nothing. This also
        // clears the debounce -- the counter is demonstrably alive at this level, so
        // any earlier low reading was a stale snapshot, not a restart.
        settled[k] = { settled: c.settled, peak: cur, lowSince: 0 };
      } else if (deepLow && c.lowSince && nowMs - c.lowSince >= RESET_MS) {
        // Deep, and low for longer than a render cycle: the counter really
        // restarted. Bank the ended epoch and open a new one at cur. Banking the
        // PEAK (not our own payload) is what lets a resumed session pick up without
        // losing the tail of the previous epoch.
        settled[k] = { settled: c.settled + c.peak, peak: cur, lowSince: 0 };
      } else if (deepLow) {
        // Deep but not yet sustained: hold everything and start (or keep) the clock.
        // Concurrent renders all stamp the same window rather than each adding a
        // tick, so simultaneity cannot manufacture the dwell time.
        settled[k] = { settled: c.settled, peak: c.peak, lowSince: c.lowSince || nowMs };
      } else {
        // Shallow dip: a concurrent render one refresh behind. Contributes nothing.
        settled[k] = { settled: c.settled, peak: c.peak, lowSince: c.lowSince };
      }
    }
    let cum = settled;
    // Merge our entry into the CURRENT on-disk state, not the snapshot casMerge
    // handed us. casMerge reads the file once per attempt, but statusline does
    // seconds of work (git, file reads) before reaching this point, so that
    // snapshot is stale: serializing it would silently drop every session that
    // landed in the meantime. Observed 4/8 sessions lost under 8-way concurrency
    // -- the old verify only checked "is my own entry present", which is always
    // true for the writer, so the retry loop never fired. Re-reading inside the
    // mutate keeps other writers' entries and makes the retry meaningful.
    casMerge(cumPath,
      (store) => {
        let live = {};
        try { live = JSON.parse(fs.readFileSync(cumPath, 'utf8')); } catch (e) {}
        const sessions = (live && typeof live.sessions === 'object' && live.sessions) ? live.sessions : {};
        store.v = 1;
        store.sessions = sessions;
        // settled and peak are ONE unit and must be merged as a pair, never
        // field-wise. Taking max on each independently breaks the reset: banking an
        // epoch lowers peak while raising settled, but an independent max keeps the
        // OLD peak, so the same epoch is re-banked on every later render (measured:
        // $232 where $41 was correct). Compare on the reported figure instead --
        // settled + peak is what the model means by "spend so far", it only ever
        // grows, and the pair that produced the larger one is internally consistent.
        //
        // Ties keep the entry with the larger settled: that is the one that has
        // already banked an epoch, so a render still holding the pre-reset pair
        // cannot undo the banking.
        //
        // lowSince rides with the winning pair. Do NOT combine the two sides
        // arithmetically: an earlier attempt min()'d the debounce counter across
        // both, which floored our own fresh observation against the stored 0 every
        // render so resets never banked at all (6 tests red, post-reset spend
        // frozen). A concurrent render seeing a healthy payload already clears the
        // debounce correctly -- it takes the `cur >= peak` branch, writing lowSince 0
        // into the pair that then wins the comparison below.
        const existing = sessions[cumKey];
        let mine = settled;
        if (existing) {
          mine = {};
          for (const k of CUM_KEYS) {
            const e = normCum(existing[k]);
            const eTot = e.settled + e.peak;
            const sTot = settled[k].settled + settled[k].peak;
            const keepExisting = eTot > sTot || (eTot === sTot && e.settled > settled[k].settled);
            const win = keepExisting ? e : settled[k];
            mine[k] = { settled: win.settled, peak: win.peak, lowSince: win.lowSince };
          }
        }
        store.sessions[cumKey] = mine;
        cum = mine;
      },
      // Verify both halves: our entry landed AND we did not clobber anyone who
      // was present before us. Entry count must never shrink across our write.
      (after) => {
        const sess = (after && after.sessions) || {};
        const mine = sess[cumKey];
        // peak bears no fixed relation to the payload value (a concurrent render may
        // hold a higher one, and a reset lowers it), so asserting one would fail
        // legitimate rounds and burn all 10 retries. Verify only what this check is
        // for: our entry is present and well-formed, i.e. nobody clobbered the write.
        if (!mine || !mine.tok || typeof mine.tok.peak !== 'number') return false;
        let onDisk = 0;
        try { onDisk = Object.keys(JSON.parse(fs.readFileSync(cumPath, 'utf8')).sessions || {}).length; } catch (e) {}
        return Object.keys(sess).length >= onDisk;
      });
    // Re-read for the cross-session total: another writer may have landed
    // between our verify and this line.
    let cumAll = {};
    try { cumAll = JSON.parse(fs.readFileSync(cumPath, 'utf8')).sessions || {}; } catch (e) {}
    if (cumAll[cumKey]) cum = normCumEntry(cumAll[cumKey], CUM_KEYS, normCum);
    // Reported value = spend banked from ended epochs + the current epoch's peak.
    // Transcript-derived; falls back to the payload figure (main session only) when
    // no transcript could be read.
    const sessionCost = sessionUsage === null ? curCost : sessionUsage.cost;
    const cost = '$' + sessionCost.toFixed(2);
    const dur = fmtDur(Math.round((cum.dur.settled + cum.dur.peak) / 60000));
    const ctx = Math.round(i.context_window?.used_percentage ?? 0);
    // If a rate-limit window's reset has already passed in real time, payload's
    // used_percentage is stale (payload only refreshes on message submit). Assume
    // a new window started empty and show 0% until payload catches up.
    const _nowSec = Math.floor(Date.now() / 1000);
    const rolledOver = (rl) => rl?.resets_at && rl.resets_at <= _nowSec;

    // Cross-session rate-limit aggregation: quotas are GLOBAL across all Claude
    // Code sessions, but each session's payload only reflects its own latest
    // observation. Share snapshots via ~/.claude/rate-limit-snapshots.json so
    // every session can see the highest observed %used within the same window.
    const rlSnapFile = path.join(os.homedir(), '.claude', 'rate-limit-snapshots.json');
    const mySnap = {
      t: _nowSec,
      five_hour: i.rate_limits?.five_hour || null,
      seven_day: i.rate_limits?.seven_day || null,
    };
    const STALE_SEC = 300;
    // CAS merge: multiple sessions hit this file every 30s so last-writer-
    // wins would drop ~5% of entries under load (see commit 5b75b09). We
    // retry until our own sid entry is visible after write.
    const rlSnaps = casMerge(rlSnapFile,
      (snaps) => {
        snaps[sid] = mySnap;
        for (const k of Object.keys(snaps)) {
          if (!snaps[k]?.t || _nowSec - snaps[k].t > STALE_SEC) delete snaps[k];
        }
      },
      (after) => after[sid]?.t === mySnap.t
    );
    // Aggregate across sessions: different Claude Code sessions can hold
    // cached rate_limits from DIFFERENT 5h windows (session cached old window,
    // never sent a new message). Same-resets_at match was too strict and
    // split sessions into isolated groups that each displayed their own MAX
    // — desync. Instead:
    //   1. Collect snapshots whose resets_at is still in the future (live).
    //   2. Pick the window MOST sessions agree on (plurality by resets_at),
    //      so a lone idle session with a divergent resets_at can't hijack it.
    //   3. Return MAX used_percentage in that winning window.
    //   4. If no live snapshots and my own payload is fresh → use payload.
    //   5. Otherwise 0 (everyone rolled over, nothing to show).
    // Sanity cap: 5h window resets within 5h, 7d within 7d. Anything >8d in
    // the future is garbage (malformed payload or bad test data) and would
    // otherwise win the "latest resets_at" tiebreak and poison the display.
    const MAX_FUTURE_SEC = 8 * 86400;
    const aggMax = (field) => {
      const myRL = i.rate_limits?.[field];
      const liveSnaps = [];
      for (const snap of Object.values(rlSnaps)) {
        const s = snap?.[field];
        if (s && typeof s.used_percentage === 'number'
            && s.resets_at > _nowSec
            && s.resets_at - _nowSec <= MAX_FUTURE_SEC) {
          liveSnaps.push(s);
        }
      }
      if (liveSnaps.length === 0) {
        return (myRL?.resets_at > _nowSec && typeof myRL.used_percentage === 'number')
          ? myRL.used_percentage : 0;
      }
      // Pick the window the MOST sessions agree on (plurality by resets_at).
      // Taking the latest resets_at let a single idle session holding a stale/
      // divergent resets_at hijack the display (e.g. one session showed a 7d
      // window 2.5d later than 7 active sessions and pinned the bar at its old
      // 16%). Count votes per window; ties broken by later resets_at.
      const votes = new Map();
      for (const s of liveSnaps) votes.set(s.resets_at, (votes.get(s.resets_at) || 0) + 1);
      let bestR = 0, bestVotes = 0;
      for (const [r, v] of votes) {
        if (v > bestVotes || (v === bestVotes && r > bestR)) { bestVotes = v; bestR = r; }
      }
      let max = 0;
      for (const s of liveSnaps) {
        if (s.resets_at === bestR && s.used_percentage > max) max = s.used_percentage;
      }
      return max;
    };
    const r5h = Math.round(aggMax('five_hour'));
    const r7d = Math.round(aggMax('seven_day'));
    const added = cum.add.settled + cum.add.peak;
    const removed = cum.rm.settled + cum.rm.peak;
    const tokTotal = cum.tok.settled + cum.tok.peak;
    const sessionName = i.session_name || '';

    let branch = '', dirty = 0, repoName = '';
    try {
      branch = (spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim();
      dirty = (spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim().split('\n').filter(Boolean).length;
      const remoteUrl = (spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim();
      const m = remoteUrl.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (m) repoName = `${m[1]}/${m[2]}`;
      else { const tl = (spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim(); if (tl) repoName = path.basename(tl); }
    } catch (e) {}
    const shortDir = (i.cwd || i.workspace?.current_dir || '').split(/[/\\]/).slice(-2).join('/');

    // Compute seconds remaining for a rolling-window reset. If resets_at has
    // already passed (payload stale), roll into the next window of period_sec.
    const countdownSec = (resetAt, period_sec) => {
      if (!resetAt) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      if (resetAt > nowSec) return resetAt - nowSec;
      return period_sec - ((nowSec - resetAt) % period_sec);
    };
    // d/h/m countdown with leading zeros dropped, always down to the minute.
    // Hour-only precision made the last <1h of a window read a bare "0d0h"
    // (looks frozen). Now: "23m", "1h5m", "2d12h30m".
    const fmtCountdown = (s) => {
      const dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
      if (dd) return `${dd}d${hh}h${mm}m`;
      if (hh) return `${hh}h${mm}m`;
      return `${mm}m`;
    };
    let resetInfo = '';
    {
      const s = countdownSec(i.rate_limits?.five_hour?.resets_at, 5 * 3600);
      if (s != null) resetInfo = `${DIM}resets${R} ${fmtCountdown(s)}`;
    }
    let reset7dInfo = '';
    {
      const s = countdownSec(i.rate_limits?.seven_day?.resets_at, 7 * 86400);
      if (s != null) reset7dInfo = `${DIM}resets${R} ${fmtCountdown(s)}`;
    }

    let effort = '';
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
      const lvl = settings.effortLevel || 'default';
      const ORANGE = '\x1b[38;5;208m';
      const effortColor = {
        low: DIM,
        default: GREEN,
        medium: GREEN,
        high: YELLOW,
        xhigh: ORANGE,
        max: RED,
      }[lvl] || GREEN;
      effort = `${DIM}effort${R} ${effortColor}${lvl}${R}`;
    } catch (e) {}

    let agentItems = [];
    // True number of distinct agent name-groups BEFORE any display cap. The
    // "…+N" overflow marker counts against this, not against the capped list,
    // or N under-reports whatever the cap already discarded.
    let totalAgentGroups = 0;
    try {
      const agents = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-agents-${sid}.json`), 'utf8'));
      // Model letter per agent instance, shown as a (f)/(o)/(s)/(h) prefix on the
      // agent name. The SubagentStart/Stop hook payload carries NO model field
      // (per docs only SessionStart may), so we lazily read each subagent's own
      // transcript (<main transcript minus .jsonl>/subagents/agent-<id>.jsonl —
      // its first assistant event carries the model id) and cache resolved
      // letters in a separate tmp file. Separate file on purpose: writing back
      // into the tracker's state file would race its CAS merge.
      const modelCacheFile = path.join(os.tmpdir(), `claude-agent-models-${sid}.json`);
      let modelCache = {};
      try { modelCache = JSON.parse(fs.readFileSync(modelCacheFile, 'utf8')); } catch (e) {}
      let modelCacheDirty = false;
      const subagentDir = (i.transcript_path || '').replace(/\.jsonl$/, '');
      const modelLetter = (key) => {
        if (modelCache[key]) return modelCache[key];
        if (!subagentDir) return '';
        try {
          // First 256KB is enough: the model id appears in the first assistant
          // event, right after the (possibly long) initial user prompt. Unresolved
          // entries (file not written yet / prompt > 256KB) just retry next render.
          const fd = fs.openSync(path.join(subagentDir, 'subagents', `agent-${key}.jsonl`), 'r');
          const buf = Buffer.alloc(262144);
          const nRead = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          const m = buf.toString('utf8', 0, nRead).match(/"model":"[^"]*(fable|opus|sonnet|haiku)/);
          if (m) { modelCache[key] = m[1][0]; modelCacheDirty = true; return modelCache[key]; }
        } catch (e) {}
        return '';
      };
      // Group by agent name — supports concurrent invocations (e.g. 3 critics in parallel)
      const byName = {};
      for (const [key, info] of Object.entries(agents)) {
        // Migration: old format was keyed by name (no info.name), new format is keyed by agent_id
        const n = info.name || key;
        if (!byName[n]) byName[n] = { running: 0, done: 0, latestFinished: 0, letters: new Set() };
        const L = modelLetter(key);
        if (L) byName[n].letters.add(L);
        if (info.status === 'running') byName[n].running++;
        else { byName[n].done++; if ((info.finished || 0) > byName[n].latestFinished) byName[n].latestFinished = info.finished; }
      }
      if (modelCacheDirty) { try { fs.writeFileSync(modelCacheFile, JSON.stringify(modelCache)); } catch (e) {} }
      totalAgentGroups = Object.keys(byName).length;
      // Build entries: running first, then latest-done. The cap here is only a
      // sanity bound on work done per render — the REAL truncation happens at
      // draw time against the middle column's actual slot count, which then
      // renders "…+N". A tight cap of 5 made that marker dead code and silently
      // dropped the 6th+ agent, so keep this well above any plausible slot count.
      const AGENT_BUILD_CAP = 40;
      const nameEntries = Object.entries(byName).sort((a, b) => {
        if (a[1].running !== b[1].running) return b[1].running - a[1].running;
        return b[1].latestFinished - a[1].latestFinished;
      }).slice(0, AGENT_BUILD_CAP);
      // One entry per agent (each becomes its own third-column row); names can be
      // wider now that they're no longer packed onto a single shared line.
      agentItems = nameEntries.map(([n, s]) => {
        // (f)name — mixed models in one name-group show all letters, e.g. (f,h).
        // Prefix + name share the original 20-char budget so the column width
        // math and fit() clipping stay unchanged.
        const mk = s.letters.size ? `(${[...s.letters].join(',')})` : '';
        const cap = 20 - mk.length;
        const short = n.length > cap ? n.slice(0, cap) : n;
        const parts = [];
        if (s.running > 0) parts.push(`${YELLOW}\u25cb${s.running > 1 ? `\u00d7${s.running}` : ''}${R}`);
        if (s.done > 0) parts.push(`${GREEN}\u2713${s.done > 1 ? `\u00d7${s.done}` : ''}${R}${s.latestFinished ? ` ${DIM}${ago(s.latestFinished)}${R}` : ''}`);
        return `${mk ? `${DIM}${mk}${R}` : ''}${short} ${parts.join(' ')}`;
      });
    } catch (e) {}

    // Skills used this session — written by skill-tracker.js on PostToolUse(Skill).
    // No running state (PostToolUse fires after the skill runs), so we only show
    // "used": name + xN count + how long ago, most-recent first, up to 4 names.
    let skillItems = [];
    try {
      const skills = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-skills-${sid}.json`), 'utf8'));
      const entries = Object.entries(skills)
        .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
        .slice(0, 5);
      // One entry per skill (each becomes its own third-column row).
      skillItems = entries.map(([n, s]) => {
        const short = n.length > 20 ? n.slice(0, 20) : n;
        const cnt = (s.count > 1) ? `${DIM}×${s.count}${R}` : '';
        const when = s.last ? ` ${DIM}${ago(s.last)}${R}` : '';
        return `${GREEN}${short}${R}${cnt}${when}`;
      });
    } catch (e) {}

    // Scheduled jobs — written by cron-tracker.js on PostToolUse(CronCreate|CronDelete|ScheduleWakeup).
    // One-shot jobs whose fire time passed (>90s grace) are treated as fired and hidden
    // (the hook can't observe the actual fire event; recurring jobs show until CronDelete).
    // Rendered as the FIXED bottom-two rows of the third (agents/skills) column.
    let cronRows = [];
    try {
      let jobs = {};
      try { jobs = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-crons-${sid}.json`), 'utf8')); } catch (e) {}
      const active = Object.values(jobs).filter((j) => j && (j.at == null ? j.recurring : j.at > Date.now() - 90000));
      // 無排程 → 區塊整個不顯示（不佔位）；有排程才佔欄底兩 row。
      if (active.length) {
        const timed = active.filter((j) => j.at != null).sort((a, b) => a.at - b.at);
        const recurringN = active.length - timed.length;
        const head = `${DIM}crons${R}${active.length > 1 ? ` ${DIM}×${active.length}${R}` : ''}`;
        let body;
        if (timed.length) {
          const nx = new Date(timed[0].at);
          const hhmm = `${String(nx.getHours()).padStart(2, '0')}:${String(nx.getMinutes()).padStart(2, '0')}`;
          body = `  ⏰ ${YELLOW}${hhmm}${R}${timed[0].label ? ` ${DIM}${timed[0].label}${R}` : ''}`;
        } else {
          body = `  ⏰ ${DIM}循環×${recurringN}${R}`;
        }
        cronRows = [head, body];
      }
    } catch (e) { cronRows = []; }

    let compactCount = 0;
    try { compactCount = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-compacts-${sid}.json`), 'utf8')).count; } catch (e) {}

    let fileParts = [];
    try { fileParts = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-files-${sid}.json`), 'utf8')); } catch (e) {}

    let msgHistory = [];
    try {
      msgHistory = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-msgs-${sid}.json`), 'utf8'));
    } catch (e) {}

    // Memory: check which CLAUDE.md / rules are loaded
    const memParts = [];
    const cwd = i.cwd || i.workspace?.current_dir || '';
    if (fs.existsSync(path.join(os.homedir(), '.claude', 'CLAUDE.md'))) memParts.push(`${GREEN}global${R}`);
    const projMd = [path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude', 'CLAUDE.md')];
    if (projMd.some(p => { try { return fs.existsSync(p); } catch(e) { return false; } })) memParts.push(`${GREEN}project${R}`);
    try {
      const rulesDir = path.join(cwd, '.claude', 'rules');
      if (fs.existsSync(rulesDir)) {
        const ruleCount = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).length;
        if (ruleCount > 0) memParts.push(`${GREEN}${ruleCount} rules${R}`);
      }
    } catch(e) {}

    // MCP: read mcp-status-cache.json (populated by mcp-status-refresh.js → `claude mcp list`)
    let mcpParts = [], mcpTotal = 0, mcpHealthy = 0;
    try {
      const mcpCache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'mcp-status-cache.json'), 'utf8'));
      const servers = mcpCache.servers || {};
      for (const [name, info] of Object.entries(servers)) {
        mcpTotal++;
        if (info.status === 'connected') {
          mcpHealthy++;
        } else {
          const shortName = name.replace(/^plugin:[^:]+:/, '').replace(/^claude\.ai /, '');
          // Match /mcp UI icons: ✔ connected, ✘ failed, △ needs auth
          const icon = info.status === 'auth' ? `\u25b3` : `\u2718`;
          const color = info.status === 'auth' ? YELLOW : RED;
          mcpParts.push(`${color}${shortName} ${icon}${R}`);
        }
      }
    } catch(e) {}
    // Fire background refresh so next render has fresh data (the refresher self-skips if cache fresh).
    // Pass cwd so `claude mcp list` consistently sees the same MCP set as the running session.
    try {
      const { spawn } = require('child_process');
      const refresher = path.join(os.homedir(), '.claude', 'hooks', 'mcp-status-refresh.js');
      if (fs.existsSync(refresher)) {
        // Don't pass cwd — let refresher default to home dir for a stable global view.
        // Passing the session cwd caused the list to flicker based on project-scoped .mcp.json
        // (e.g. phantom 'discord'/'line' entries appearing when spawned from plugin folders).
        const p = spawn(process.execPath, [refresher], { detached: true, stdio: 'ignore', windowsHide: true });
        p.unref();
      }
    } catch(e) {}

    // ── Build left-side content ──
    const gitParts = [];
    if (repoName) gitParts.push(`${CYAN}${repoName}${R}`);
    if (branch) gitParts.push(`${MAGENTA}${branch}${R}${dirty ? ` ${DIM}(${dirty} changed)${R}` : ''}`);
    const gitInfo = gitParts.join(' ');

    // ── Cross-session (all) totals ──
    //
    // Cost comes from a cached full scan of ~/.claude/projects, NOT from the
    // cumulative store. The store only ever held sessions that rendered a statusline
    // (measured: 68 of 591 main transcripts, 11.5%) and its cost came from the
    // payload, which excludes subagents (a further 23.9%). Both gaps understated the
    // figure; the two together put it 3.2x low.
    //
    // The scan is far too heavy for a render, so allUsageRefresh writes a cache and
    // this only reads it. A missing cache shows nothing rather than a wrong number.
    const allCachePath = path.join(os.homedir(), '.claude', 'usage-data', 'cc-statusline-all-usage.json');
    let allCost = null, allTok = null, allUnpriced = 0, allStale = false;
    try {
      const c = JSON.parse(fs.readFileSync(allCachePath, 'utf8'));
      if (c && typeof c.cost === 'number' && typeof c.tok === 'number') {
        allCost = c.cost; allTok = c.tok; allUnpriced = num(c.unpricedTok);
        // The scan takes seconds on a multi-GB history; anything within a few hours
        // is close enough for an at-a-glance figure, older is flagged rather than
        // silently presented as current.
        allStale = !c.at || (Date.now() - c.at) > 6 * 3600 * 1000;
      }
    } catch (e) { /* no cache yet: the row degrades to session-only */ }
    // Spawn the refresher when the cache is missing or stale. It self-skips if
    // another one is already running or the cache is fresh.
    try {
      const refresher = path.join(__dirname, 'scripts', 'all-usage-refresh.js');
      if ((allCost === null || allStale) && fs.existsSync(refresher)) {
        const { spawn } = require('child_process');
        const p2 = spawn(process.execPath, [refresher], { detached: true, stdio: 'ignore', windowsHide: true });
        p2.unref();
      }
    } catch (e) {}
    // '~' marks a figure that excludes tokens from models with no price in PRICE.
    const allCostStr = allCost === null ? '--' : (allUnpriced > 0 ? '~' : '') + '$' + allCost.toFixed(2);

    // Split rows: [leftCol, rightCol] — each cell gated by /cc-statusline:rows config.
    // Empty cells collapse: if a whole column (left OR right across both rows) is empty,
    // the remaining cells merge into full-width rows (no empty grid cells).
    const linesInfo = `${GREEN}+${added}${R} ${RED}-${removed}${R} ${DIM}lines${R}`;
    let splitRow1L = showRow('dir')   ? `\u{1f4c1} ${shortDir}  ${linesInfo}` : '';
    let splitRow1R = showRow('model') ? `${CYAN}${model}${R}  ${effort}` : '';
    let splitRow2L = showRow('repo')  ? (gitInfo || '') : '';
    let splitRow2R = showRow('cost')  ? `${DIM}cost${R} ${cost} ${DIM}(all${R} ${allCostStr}${DIM})${R} \u00b7 ${dur}` : '';

    // Collapsed "top rows" — full-width rows rendered BEFORE the split block (if any).
    // Used when a whole column is empty (one side totally unused → no point in 2-cell layout).
    const preSplitRows = [];
    const leftEmpty = !splitRow1L && !splitRow2L;
    const rightEmpty = !splitRow1R && !splitRow2R;
    if (leftEmpty && (splitRow1R || splitRow2R)) {
      if (splitRow1R) preSplitRows.push(splitRow1R);
      if (splitRow2R) preSplitRows.push(splitRow2R);
      splitRow1L = splitRow1R = splitRow2L = splitRow2R = '';
    } else if (rightEmpty && (splitRow1L || splitRow2L)) {
      if (splitRow1L) preSplitRows.push(splitRow1L);
      if (splitRow2L) preSplitRows.push(splitRow2L);
      splitRow1L = splitRow1R = splitRow2L = splitRow2R = '';
    }
    // Whole-empty row skip: if both cells of a row are empty, don't emit that row at all
    const hasRow1 = !!(splitRow1L || splitRow1R);
    const hasRow2 = !!(splitRow2L || splitRow2R);
    const hasSplitBlock = hasRow1 || hasRow2;

    // Full-width left rows — each row gated by /cc-statusline:rows config
    const compactLabel = `${compactCount} time${compactCount === 1 ? '' : 's'}`;
    const ctxLine = `${DIM}tokens${R} ${fmtTok(tokTotal)} ${DIM}(all${R} ${allTok === null ? '--' : fmtTok(allTok)}${DIM})${R}  ${DIM}context${R} ${cc(ctx)}${bar(ctx)} ${ctx}%${R}  ${DIM}compact${R} ${compactLabel}`;
    // 5h and 7d quota side by side. The verbose "resets" word before each
    // countdown is replaced with a compact "│" separator to keep width down.
    const reset5hCompact = resetInfo.replace(`${DIM}resets${R} `, `${DIM}│${R} `);
    const reset7dCompact = reset7dInfo.replace(`${DIM}resets${R} `, `${DIM}│${R} `);
    const quotaLine = `${DIM}5h-quota${R} ${cc(r5h)}${bar(r5h)} ${r5h}%${R} ${reset5hCompact}     ${DIM}7d-quota${R} ${cc(r7d)}${bar(r7d)} ${r7d}%${R} ${reset7dCompact}`;
    const fullLeftRows = [];
    if (showRow('usage')) fullLeftRows.push(ctxLine);
    if (showRow('quota')) fullLeftRows.push(quotaLine);
    // agents / skills moved to the third (far-right) column — see r3rows below.
    const memStr = memParts.length ? `${DIM}memory${R} ${memParts.join(`${DIM} \u00b7 ${R}`)}` : '';
    let mcpStr = '';
    if (mcpTotal > 0) {
      // Counts only — individual server names (mcpParts: failed/auth-needed) were
      // dropped to keep the left panel narrow.
      const mcpLine = mcpParts.length
        ? `${GREEN}${mcpHealthy}${R}/${mcpTotal} active`
        : `${GREEN}${mcpTotal}${R} active`;
      mcpStr = `${DIM}mcp${R} ${mcpLine}`;
    }
    // Track column offset of │ within content area (for border connectors ┬/┴)
    let memMcpRowIdx = -1, memMcpCol = -1;
    if (showRow('memory_mcp') && (memStr || mcpStr)) {
      if (memStr && mcpStr) {
        memMcpCol = dw(memStr) + 1; // offset inside padded content area (after "memStr ")
      }
      memMcpRowIdx = fullLeftRows.length;
      const combined = [memStr, mcpStr].filter(Boolean).join(` ${DIM}\u2502${R} `);
      fullLeftRows.push(combined);
    }
    const sep = ` ${DIM}\u2192${R} `;
    if (showRow('edited') && fileParts.length) {
      // Per-filename cap: keep last chars so extension stays visible; truncate front with …
      const shortFile = f => f.length > 25 ? '\u2026' + f.slice(-24) : f;
      let fitted = [], usedW = 8; // "edited  " label width
      for (const f of fileParts) {
        const sf = shortFile(f);
        const fw = sf.length + (fitted.length ? 3 : 0);
        if (usedW + fw > 70) break; // tighter row width so LEFT_W stays lean
        fitted.push(sf); usedW += fw;
      }
      if (fitted.length) fullLeftRows.push(`${DIM}edited${R}  ${fitted.join(sep)}`);
    }

    // Session summary — Claude-written file > session_name > first msg > sid
    // Gated by /cc-statusline:rows — empty summary = summary block skipped entirely later
    let summary = '';
    if (showRow('summary')) {
      try {
        const sf = path.join(os.tmpdir(), `claude-summary-${sid}.txt`);
        summary = fs.readFileSync(sf, 'utf8').trim().split('\n')[0].slice(0, 500);
      } catch (e) {}
      if (!summary) summary = sessionName || '';
      if (!summary && msgHistory.length) {
        const firstUser = msgHistory.find(m => m.r === 'u');
        if (firstUser) summary = firstUser.t.replace(/\n/g, ' ').trim().slice(0, 60);
      }
      if (!summary) summary = `session ${sid.slice(0, 8)}`;
    }
    const hasSummary = !!summary;

    // ── Measure widths ──
    let maxLL = Math.max(dw(splitRow1L), dw(splitRow2L));
    let maxLR = Math.max(dw(splitRow1R), dw(splitRow2R));
    const LLW = maxLL + 2;
    const LRW = maxLR + 2;
    const LEFT_INNER = LLW + 1 + LRW;

    let maxFull = 0;
    for (const f of fullLeftRows) maxFull = Math.max(maxFull, dw(f) + 2);
    let LEFT_W = Math.max(LEFT_INNER, maxFull);
    // Total box = terminal width exactly. No wider, no narrower.
    // Detection order matters. Claude Code pipes stdout/stderr (so .columns is
    // undefined) but DOES export COLUMNS with the real TUI width — verified by
    // probe: COLUMNS=179 on a window where PowerShell WindowSize.Width returned
    // a bogus fixed 120 (it reads the console BUFFER width, not the live window).
    // So: TTY columns first (correct when a TTY exists), then COLUMNS (Claude
    // Code's authoritative value), then /dev/tty, and PowerShell LAST as a weak
    // win32 guess — previously PowerShell ran 2nd and its 120 shadowed COLUMNS,
    // which is exactly why the third column never appeared.
    let TERM_W = process.stdout.columns || process.stderr.columns || 0;
    if (!TERM_W) { try { TERM_W = parseInt(process.env.COLUMNS, 10) || 0; } catch(e) {} }
    if (!TERM_W) {
      try {
        const tty = require('tty');
        const fd = fs.openSync('/dev/tty', 'r');
        const stream = new tty.ReadStream(fd);
        TERM_W = stream.columns || 0;
        stream.destroy();
      } catch(e) {}
    }
    if (!TERM_W && process.platform === 'win32') {
      try {
        const r = spawnSync('powershell.exe', ['-NoProfile', '-c', '$Host.UI.RawUI.WindowSize.Width'], { encoding: 'utf8', timeout: 2000 });
        TERM_W = parseInt((r.stdout || '').trim(), 10) || 0;
      } catch(e) {}
    }
    // Fallback width — 120 is conservative; bump to 160 so wider terminals
    // (common 160/180/210 cols) get more room for the message history column.
    if (!TERM_W) TERM_W = 160;
    // Don't subtract padding — let the box fill full terminal width.
    // Claude Code's padding shifts our output right, but the box itself should be terminal-wide.

    // MIDDLE column — the flexible column that used to show msgHistory now shows
    // AGENTS: a dim "agents" header row followed by one indented row per agent.
    // It keeps the message column's old geometry (flexible width, takes whatever
    // is left after the left panel and the third column).
    // The header shows even with zero agents (idle): the column is persistent, so
    // labelling it beats an unexplained blank gap. Header alone does NOT keep the
    // frame alive — that is decided by hasMidContent below.
    const midRows = [];
    const hasMidContent = showRow('agents') && agentItems.length > 0;
    if (showRow('agents')) {
      midRows.push(`${DIM}agents${R}`);
      for (const it of agentItems) midRows.push(`  ${it}`);
    }
    // THIRD column — skills only now that agents own the middle column. Same
    // header + indented-item shape as before.
    const r3rows = [];
    if (showRow('skills') && skillItems.length) {
      r3rows.push(`${DIM}skills${R}`);
      for (const it of skillItems) r3rows.push(`  ${it}`);
    }
    // crons block: FIXED bottom-two rows of this column（使用者指定：固定吃掉欄底兩 row）。
    // r3fixed 不進 r3rows（那是由上往下填的流動內容）；渲染採 token 兩段式——先排版、
    // 最後才知道欄高，再把「最後 |r3fixed| 個 cell」換成 cron 內容（見 r3cell 與收尾替換）。
    const r3fixed = showRow('crons') ? cronRows : [];
    const hasR3 = r3rows.length > 0 || r3fixed.length > 0;
    // Column sizing is EQUAL-SPLIT, not content-driven: the agents column and the
    // skills column each take half of the space right of the left panel, so the
    // two read as a balanced pair. Content narrower than its half is padded;
    // content wider is clipped by the existing fit(). (Previously R3 took only
    // its content width and the middle column swallowed all the rest, which made
    // skills look starved next to a very wide agents column.)
    const R3_USABLE_MIN = 8; // narrowest cell that still fits a header + padding
    const rightAvail = Math.max(0, TERM_W - LEFT_W - 3); // -3 = "│ … │" frame around msg col
    // Halve the space right of the left panel between the two columns. One extra
    // column is consumed by R3's own │ divider, so the pot to share is
    // rightAvail - 1; the odd column (if any) goes to the agents column.
    //
    // Degrade rather than veto: if a half is below R3_USABLE_MIN the pair is not
    // viable at this width, so BOTH collapse together (never one alone — that is
    // the mixed state). showMsgs below enforces the joint decision.
    let R3_W = 0;
    if (hasR3) {
      const sharePot = rightAvail - 1;
      const half = Math.floor(sharePot / 2);
      R3_W = (half >= R3_USABLE_MIN && sharePot - half >= R3_USABLE_MIN) ? half : 0;
    }

    // Left = content-driven (never truncated). The middle column takes the rest
    // of the right-hand space after R3 and its divider, which with the split
    // above is the same half (±1 for an odd pot).
    // `let` because the left-panel fallback below may grow LEFT_W, after which
    // MSG_W must be recomputed or the frame overflows TERM_W (V1).
    let MSG_W = Math.max(0, rightAvail - (R3_W > 0 ? R3_W + 1 : 0));
    // The middle column now carries agents (was msgHistory). The 'history' row
    // key no longer maps to any column and is ignored.
    //
    // The three-column frame is PERSISTENT: it stays up whenever agents, skills
    // or crons has content, so going idle (no running agent) empties the agents
    // column rather than collapsing the whole layout and making the box jump.
    // It only collapses when the terminal is too narrow (the fallback below) or
    // when all three are empty (left panel alone, full width).
    //
    // Two states only, never a mix: the middle column and R3 collapse TOGETHER.
    // If R3 has content but could not secure a usable width (R3_W === 0), the
    // middle column must not render alone — otherwise skills/crons fall back
    // into the left panel while agents keep a column, which is the mixed state
    // seen at COLUMNS 100-114.
    const r3Renderable = !hasR3 || R3_W > 0;
    let showMsgs = (hasMidContent || hasR3) && MSG_W >= 15 && r3Renderable;
    // Third column rides on the middle column's frame, so it only renders when
    // the middle column does. When both are hidden, skills/crons fall back to
    // the left panel (handled below by re-adding them to fullLeftRows).
    let showR3 = hasR3 && showMsgs && R3_W > 0;

    // Fallback: if the third column can't render (middle column hidden), put
    // skills/crons back into the left panel so they're never lost.
    // NOTE: re-adding here is AFTER LEFT_W was finalized (line ~522), so a
    // re-added row wider than the existing left panel would overflow the frame
    // (V1). Guard: only re-add, then clamp LEFT_W-dependent draw width to the
    // actual content. agents/skills lines are short (names capped at 12/14),
    // and this path only triggers on very narrow terminals; we additionally
    // recompute LEFT_W below to absorb any width growth.
    if (hasR3 && !showR3) {
      for (const r of [...r3rows, ...r3fixed]) {
        fullLeftRows.push(r);
        LEFT_W = Math.max(LEFT_W, dw(r) + 2); // V1 guard: keep frame aligned
      }
      // LEFT_W may have grown → middle column must give back that space, else
      // LEFT_W + MSG_W frame exceeds TERM_W and the border misaligns (V1 repro).
      MSG_W = Math.max(0, TERM_W - LEFT_W - 3);
      // R3's content has just been folded into the left panel, so the middle
      // column must collapse too — keeping it alive here is precisely what
      // produced the mixed "agents column + skills as left rows" state. Only
      // mid-column content that is NOT in the left panel can justify a column,
      // and that is nothing once R3 fell back: collapse to the single panel.
      showMsgs = false;
    }
    // Right cell width of the split block — depends on the (possibly grown) LEFT_W,
    // so compute it AFTER the fallback may have widened LEFT_W. (Restored: this
    // const was accidentally dropped while changing showR3 to let.)
    const LRW_RECALC = LEFT_W - LLW - 1;


    // Total inner width of the box (everything between the outer │ │). The box
    // ALWAYS spans the full terminal: with columns present that is left + middle
    // + third + their dividers; with no column the left panel is padded out to
    // TERM_W - 2 so the right border still lands on the terminal's right edge.
    const COLS_W = (showMsgs ? MSG_W + 1 : 0) + (showR3 ? R3_W + 1 : 0);
    const BOX_W = showMsgs ? LEFT_W + COLS_W : Math.max(LEFT_W, TERM_W - 2);
    // When no column renders, the left panel itself stretches to fill the box.
    const LEFT_DRAW_W = showMsgs ? LEFT_W : BOX_W;
    // Right cell of the split block, measured against the DRAWN left width so
    // the split block also stretches when the left panel fills the whole box.
    const LRW_RECALC2 = LEFT_DRAW_W - LLW - 1;

    // Summary wrap (character-level). The summary row spans the FULL box width,
    // so its content area is BOX_W - 2 (inside │ │) minus the 16-char
    // "session summary " label / indent.
    // "session summary " label is 16 chars; subsequent rows indent 16 spaces.
    const MAX_SUM_LINES = 1;
    // Session id, right-aligned at the far end of the summary row. Full sid when
    // it fits, else its first 8 chars, always separated from the summary text by
    // at least 2 spaces. The summary yields the room (it truncates with …) so the
    // id keeps its short form even when the summary is long; dropped entirely
    // only if the row cannot host even the short form plus the gap.
    const SID_GAP = 2;
    const sidFull = sid, sidShort = sid.slice(0, 8);
    const sumRowW = BOX_W - 18; // content width available on the summary row
    let sidText = '';
    if (hasSummary) {
      if (sumRowW - (dw(sidFull) + SID_GAP) >= 1) sidText = sidFull;
      else if (sumRowW - (dw(sidShort) + SID_GAP) >= 1) sidText = sidShort;
    }
    const sidW = sidText ? dw(sidText) + SID_GAP : 0;
    const maxSumW_calc = sumRowW - sidW;
    const sumLines = [];
    if (hasSummary) { let curLine = '', curW = 0, truncated = false;
      const chars = [...summary];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
        if (curW + cw > maxSumW_calc && curLine) {
          if (sumLines.length + 1 >= MAX_SUM_LINES) {
            const rest = chars.slice(i).join('');
            if (rest.length > 0) {
              while (curW + 1 > maxSumW_calc && curLine) {
                const last = curLine[curLine.length - 1];
                curW -= isWide(last.codePointAt(0)) ? 2 : 1;
                curLine = curLine.slice(0, -1);
              }
              sumLines.push(curLine + '\u2026');
              truncated = true;
              break;
            }
          }
          sumLines.push(curLine);
          curLine = ch; curW = cw;
        } else {
          curLine += ch; curW += cw;
        }
      }
      if (!truncated && curLine && sumLines.length < MAX_SUM_LINES) sumLines.push(curLine);
      if (!sumLines.length) sumLines.push('');
    }

    // Count total rows for right-column slot allocation.
    // Split-open divider can be absorbed by the top border when split is the first section;
    // bottom border can absorb the split-close when split is the last section.
    const topMergeSplitSlot = hasSplitBlock && !hasSummary && preSplitRows.length === 0; // same condition as topMergeSplit
    const splitContentRows = (hasRow1 ? 1 : 0) + (hasRow2 ? 1 : 0);
    const splitOpenDivider = (hasSplitBlock && !topMergeSplitSlot) ? 1 : 0;
    const splitCloseDivider = (hasSplitBlock && fullLeftRows.length > 0) ? 1 : 0;
    const allFullRows = preSplitRows.length + fullLeftRows.length;
    const fullDividers = Math.max(0, preSplitRows.length - 1) + (fullLeftRows.length > 1 ? fullLeftRows.length - 1 : 0);
    let sectionDividers = 0;
    // When the split block directly follows the summary (no pre-split rows), the
    // draw path emits ONE physical divider (the split-open ├─┬─┤) serving both as
    // section boundary and split opening. Counting a section divider here too
    // overcounts totalSlots by 1, so the NEWEST message slot is never rendered.
    if (hasSummary && (preSplitRows.length || hasSplitBlock || fullLeftRows.length)
        && !(hasSplitBlock && preSplitRows.length === 0)) sectionDividers++;
    if (preSplitRows.length && fullLeftRows.length && !hasSplitBlock) sectionDividers++;
    // The summary row now spans the WHOLE box width, so it hosts no middle/R3
    // cell and must not be counted as a slot for them.
    const totalSlots = splitContentRows + allFullRows + splitOpenDivider + splitCloseDivider + fullDividers + sectionDividers;

    // Middle-column content: agents, top-down. Unlike the old message column
    // (which showed the NEWEST entries and padded at the top), agents read as a
    // list \u2014 fill from the top and, if there are more agents than slots, collapse
    // the tail into a dim "\u2026+N" so nothing silently disappears.
    // N counts hidden AGENTS, not hidden rows: midRows[0] is the "agents" header,
    // so a dropped header must not inflate the tally (that read "\u2026+6" for 5 agents).
    // Do NOT truncate here. totalSlots is an ESTIMATE that can DIVERGE from the
    // number of cells the draw path actually emits (instrumented sweep: it under-
    // counts or matches, never exceeds \u2014 e.g. 7 vs 8 with a full-width summary,
    // 3 vs 8 with rows toggled off). Truncating against the estimate put the
    // "\u2026+N" marker in the wrong slot, so agents vanished with no marker.
    // Instead pass the full list; the draw path knows the real cell count (ri)
    // and folds the tail into "\u2026+N" once it is known \u2014 see the fixup after the
    // bottom border.
    const rightMsgs = midRows.slice();

    // ── Draw ──
    const h = c => `${DIM}${c}${R}`;
    const hl = (n) => '\u2500'.repeat(n);
    // hl with marks: { idx: char } replaces positions within the ─ run
    const hlm = (n, marks) => {
      const arr = Array(n).fill('\u2500');
      if (marks) for (const k of Object.keys(marks)) { const i = +k; if (i >= 0 && i < n) arr[i] = marks[k]; }
      return arr.join('');
    };
    // Column offset (within hl span) where the mem/mcp │ sits.
    // Content area starts at abs col 2 (│ + space). hl spans abs cols 1..LEFT_W.
    // So hl idx = (2 + memMcpCol) - 1 = 1 + memMcpCol.
    const mcpHlIdx = memMcpCol >= 0 ? 1 + memMcpCol : -1;
    const output = [];
    let ri = 0; // right message index

    // Column-opening run right of the left panel: "┬───[┬───]" for the middle
    // + third columns. Empty when neither renders.
    const colsOpen = (j) => showMsgs
      ? `${h(j)}${h(hl(MSG_W))}${showR3 ? h(j) + h(hl(R3_W)) : ''}`
      : '';

    // Top border — if the FIRST section is the split block, merge the split-open into
    // the top border so there's no redundant ├─┬─┤ right after ┌─┐.
    const topMergeSplit = hasSplitBlock && !hasSummary && preSplitRows.length === 0;
    if (hasSummary) {
      // A full-width summary row comes first, so the top border is flat across
      // the whole box; the columns are opened by the divider BELOW the summary.
      output.push(`${h('\u250c')}${h(hl(BOX_W))}${h('\u2510')}`);
    } else if (topMergeSplit) {
      // top border with split column divider baked in: ┌───┬───┬───┐ (or ┌───┬───┐ if no msgs)
      if (showMsgs) output.push(`${h('\u250c')}${h(hl(LLW))}${h('\u252c')}${h(hl(LRW_RECALC))}${colsOpen('\u252c')}${h('\u2510')}`);
      else          output.push(`${h('\u250c')}${h(hl(LLW))}${h('\u252c')}${h(hl(LEFT_DRAW_W - LLW - 1))}${h('\u2510')}`);
    } else if (showMsgs) {
      output.push(`${h('\u250c')}${h(hl(LEFT_W))}${colsOpen('\u252c')}${h('\u2510')}`);
    } else {
      output.push(`${h('\u250c')}${h(hl(LEFT_DRAW_W))}${h('\u2510')}`);
    }

    // Helper: middle column cell. Emits a placeholder token during layout (same
    // two-phase trick as r3cell) because the number of cells is only known once
    // every host row has been emitted \u2014 and only then can the tail be folded
    // into "\u2026+N". Substituted after the bottom border.
    const rcell = () => {
      if (!showMsgs) return '';
      return ` \x00MID#${ri++}\x00 ${h('\u2502')}`;
    };
    // Helper: third-column cell (agents/skills + fixed crons bottom block)\u3002
    // \u5169\u6bb5\u5f0f\u6e32\u67d3\uff1a\u6392\u7248\u671f\u53ea\u767c token \u4f54\u4f4d\u4e26\u8a08\u6578\uff08\x00R3#n\x00\uff0c\u6b63\u5e38\u8f38\u51fa\u4e0d\u53ef\u80fd\u51fa\u73fe\u6b64
    // \u63a7\u5236\u5b57\u5143\uff09\uff0c\u5168\u90e8 host row \u6392\u5b8c\u624d\u77e5\u9053\u6b04\u9ad8 totalSlots\uff0c\u6536\u5c3e\u6642\u628a token \u63db\u6210\u5be6\u969b
    // \u5167\u5bb9\u2014\u2014\u524d\u6bb5\u7531\u4e0a\u800c\u4e0b\u586b r3rows\uff08agents/skills\uff09\uff0c\u300c\u6700\u5f8c |r3fixed| \u683c\u300d\u56fa\u5b9a\u7d66
    // crons \u5340\u584a\uff08\u4f7f\u7528\u8005\u6307\u5b9a\u6b04\u5e95\u5169 row\uff09\uff0c\u4e2d\u9593\u4e0d\u8db3\u8655\u7559\u767d\u3002
    let r3slot = 0;
    const r3cell = () => {
      if (!showR3) return '';
      return ` \x00R3#${r3slot++}\x00 ${h('\u2502')}`;
    };
    // Combined right suffix for every CONTENT/DIVIDER row: msg cell + third cell.
    const rsuffix = () => rcell() + r3cell();

    // The full-width summary row sits above the columns, so the first divider
    // below it OPENS them (┬ junctions, no cells yet); every later divider
    // continues them (┤ + cells). `colsOpened` flips on the first such divider.
    let colsOpened = !hasSummary;
    // Divider spanning the left panel, with the column junctions appended.
    // Before the columns are opened it emits ├──┬──┬──┤; after, ├──┤ + live cells.
    const ldiv = (marks) => {
      const span = marks ? hlm(LEFT_W, marks) : hl(LEFT_W);
      if (!colsOpened) {
        colsOpened = true;
        if (showMsgs) return `${h('\u251c')}${h(span)}${colsOpen('\u252c')}${h('\u2524')}`;
        return `${h('\u251c')}${h(marks ? hlm(LEFT_DRAW_W, marks) : hl(LEFT_DRAW_W))}${h('\u2524')}`;
      }
      return `${h('\u251c')}${h(marks ? hlm(LEFT_DRAW_W, marks) : hl(LEFT_DRAW_W))}${h('\u2524')}${rsuffix()}`;
    };

    // Summary rows \u2014 these span the FULL box width (no middle/R3 cell), so they
    // emit no rsuffix(). The session id sits flush against the row's right end;
    // sumLines were wrapped against the same reduced width, so padding the text
    // to (row width - sid width) lands the id exactly at the edge.
    if (hasSummary) {
      for (let si = 0; si < sumLines.length; si++) {
        const label = si === 0 ? `${DIM}session summary${R} ` : ' '.repeat(16);
        const tail = (si === 0 && sidText) ? `${' '.repeat(SID_GAP)}${DIM}${sidText}${R}` : '';
        const textW = (si === 0 && sidText) ? sumRowW - sidW : sumRowW;
        output.push(`${h('\u2502')} ${label}${pad(sumLines[si], textW)}${tail} ${h('\u2502')}`);
      }
    }

    // pre-split full-width rows (when an entire split column collapsed to single-cell)
    if (preSplitRows.length > 0) {
      if (hasSummary) output.push(ldiv());
      for (let j = 0; j < preSplitRows.length; j++) {
        if (j > 0) output.push(ldiv());
        output.push(`${h('\u2502')} ${pad(preSplitRows[j], LEFT_DRAW_W - 2)} ${h('\u2502')}${rsuffix()}`);
      }
    }

    // Split block — skip individual rows if both cells empty
    if (hasSplitBlock) {
      // Emit split-open divider only if NOT merged with top border
      if (!topMergeSplit) {
        output.push(colsOpened
          ? `${h('\u251c')}${h(hl(LLW))}${h('\u252c')}${h(hl(LRW_RECALC2))}${h('\u2524')}${rsuffix()}`
          : ((colsOpened = true), `${h('\u251c')}${h(hl(LLW))}${h('\u252c')}${h(hl(LRW_RECALC2))}${colsOpen('\u252c')}${h('\u2524')}`));
      }
      if (hasRow1) output.push(`${h('\u2502')} ${pad(splitRow1L, LLW - 2)} ${h('\u2502')} ${pad(splitRow1R, LRW_RECALC2 - 2)} ${h('\u2502')}${rsuffix()}`);
      if (hasRow2) output.push(`${h('\u2502')} ${pad(splitRow2L, LLW - 2)} ${h('\u2502')} ${pad(splitRow2R, LRW_RECALC2 - 2)} ${h('\u2502')}${rsuffix()}`);
      if (fullLeftRows.length > 0) {
        output.push(`${h('\u251c')}${h(hl(LLW))}${h('\u2534')}${h(hl(LRW_RECALC2))}${h('\u2524')}${rsuffix()}`);
      }
    } else if (!preSplitRows.length && hasSummary && fullLeftRows.length > 0) {
      output.push(ldiv());
    } else if (preSplitRows.length > 0 && fullLeftRows.length > 0) {
      output.push(ldiv());
    }

    // Full-width left rows
    for (let j = 0; j < fullLeftRows.length; j++) {
      output.push(`${h('\u2502')} ${pad(fullLeftRows[j], LEFT_DRAW_W - 2)} ${h('\u2502')}${rsuffix()}`);
      if (j < fullLeftRows.length - 1) {
        const marks = {};
        if (mcpHlIdx >= 0) {
          if (j + 1 === memMcpRowIdx) marks[mcpHlIdx] = '\u252c'; // ┬
          else if (j === memMcpRowIdx) marks[mcpHlIdx] = '\u2534'; // ┴
        }
        output.push(ldiv(marks));
      }
    }

    // Drain any third-column rows that had no host content/divider row to ride
    // on (R-EDGE-04 / V2): emit a divider + a blank-left/blank-message row whose
    // third cell carries the leftover entry. Needed slots = 流動內容（agents/skills）
    // + 固定 crons 區塊——欄高必須容納兩者，crons 才有「欄底兩 row」可佔。
    const r3Needed = r3rows.length + r3fixed.length;
    if (showR3 && r3slot < r3Needed) {
      while (r3slot < r3Needed) {
        output.push(`${h('├')}${h(hl(LEFT_DRAW_W))}${h('┤')}${rcell()}${r3cell()}`);
        output.push(`${h('│')} ${pad('', LEFT_DRAW_W - 2)} ${h('│')}${rcell()}${r3cell()}`);
      }
    }

    // Bottom border
    const bottomMarks = {};
    // If mem/mcp is the last full row, extend its ┴ down to the bottom
    if (mcpHlIdx >= 0 && memMcpRowIdx === fullLeftRows.length - 1) bottomMarks[mcpHlIdx] = '\u2534';
    // If split block was the last thing emitted (no full rows after), the split divider lands on bottom
    if (hasSplitBlock && fullLeftRows.length === 0) {
      if (showMsgs) {
        output.push(`${h('\u2514')}${h(hl(LLW))}${h('\u2534')}${h(hl(LRW_RECALC2))}${colsOpen('\u2534')}${h('\u2518')}`);
      } else {
        output.push(`${h('\u2514')}${h(hl(LLW))}${h('\u2534')}${h(hl(LRW_RECALC2))}${h('\u2518')}`);
      }
    } else {
      if (showMsgs) {
        output.push(`${h('\u2514')}${h(hlm(LEFT_W, bottomMarks))}${colsOpen('\u2534')}${h('\u2518')}`);
      } else {
        output.push(`${h('\u2514')}${h(hlm(LEFT_DRAW_W, bottomMarks))}${h('\u2518')}`);
      }
    }

    // 第三欄 token 收尾替換（兩段式渲染的第二段）：totalSlots = 欄實際高度。
    // slot 0..(totalSlots-|r3fixed|-1) 由上而下放 r3rows（不足留白）；
    // 最後 |r3fixed| 格固定放 crons 區塊（欄底兩 row，使用者指定）。
    if (showR3) {
      const totalSlots = r3slot;
      const fixedStart = totalSlots - r3fixed.length;
      const r3TextFor = (n) => (n >= fixedStart && r3fixed.length ? (r3fixed[n - fixedStart] || '') : (r3rows[n] || ''));
      for (let oi = 0; oi < output.length; oi++) {
        if (output[oi].indexOf('\x00R3#') !== -1) {
          output[oi] = output[oi].replace(/\x00R3#(\d+)\x00/g, (_, n) => fit(r3TextFor(+n), R3_W - 2));
        }
      }
    }

    // Middle-column token substitution. `ri` is now the REAL number of cells the
    // draw path emitted, so the overflow marker can be placed in a cell that
    // actually exists. If the agents list is longer than the available cells,
    // the LAST cell becomes "…+N" where N counts every agent group not shown —
    // measured against totalAgentGroups, the pre-cap truth.
    if (showMsgs) {
      const cellCount = ri;
      const midTextFor = (n) => {
        if (rightMsgs.length > cellCount && n === cellCount - 1) {
          const shownItems = Math.max(0, (cellCount - 1) - 1); // minus the header row
          return `${DIM}…+${Math.max(0, totalAgentGroups - shownItems)}${R}`;
        }
        return rightMsgs[n] || '';
      };
      for (let oi = 0; oi < output.length; oi++) {
        if (output[oi].indexOf('\x00MID#') !== -1) {
          output[oi] = output[oi].replace(/\x00MID#(\d+)\x00/g, (_, n) => fit(midTextFor(+n), MSG_W - 2));
        }
      }
    }

    process.stdout.write(output.join('\n'));
  } catch (e) {
    process.stdout.write('statusline error: ' + e.message);
  }
});
