// Shared pricing for statusline.js and all-usage-refresh.js.
//
// Why this exists: the old table matched model ids by SUBSTRING, so a model the
// table did not know silently took the price of an older sibling --
// 'claude-opus-5-5' hit 'opus-5' and 'claude-fable-5-1' hit 'fable-5'. Nothing
// flagged it: the session figure read 57% high on Opus 5.5 with no marker.
//
// Now: ids normalise to an exact key ('opus-5-5') and only an exact hit counts.
// A miss still gets an interim price from the closest-version model of the same family (so
// the row does not go blank), is reported as approximate so the display can mark
// it '~', and asks scripts/price-refresh.js to look the real price up and backfill
// ~/.claude/usage-data/cc-statusline-prices.json. Backfilled prices only FILL keys
// the built-in table lacks -- they never override it, so a bad parse cannot
// corrupt a known model and a correction to BUILTIN always takes effect. Adding a
// key changes the table signature, which makes every cached cost figure rescan
// instead of keeping the old wrong number.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PRICE_CACHE = path.join(os.homedir(), '.claude', 'usage-data', 'cc-statusline-prices.json');
// A key that is still missing after a lookup is not looked up again for this long.
const RETRY_MS = 6 * 3600 * 1000;
// Held by the ONE price-refresh run allowed at a time. Deliberately not
// PRICE_CACHE + '.lock': that name belongs to hooks/lib-state's casMerge, which
// guards each short write and reclaims any lock older than 10s -- it would treat
// a run's lock (held for the whole fetch) as orphaned and delete it.
const RUN_LOCK = PRICE_CACHE + '.run.lock';
// A price-refresh lock older than this belongs to a run that died.
const LOCK_STALE_MS = 5 * 60 * 1000;

// Single-runner lock shared by price-refresh.js and all-usage-refresh.js, built
// on hooks/lib-state's lock primitives: the lock holds the owner's pid, and is
// taken over only when that pid is gone or the lock is older than staleMs --
// and then only by the single holder of the '<lock>.reclaim' token, so a live
// run's lock is never deleted by a racing one. Callers re-check ownsRunLock()
// before the expensive work as a last guard.
const lockLib = require('../hooks/lib-state');
const acquireRunLock = (lockPath, staleMs) => lockLib.acquireLock(lockPath, staleMs);
const ownsRunLock = (lockPath) => lockLib.ownsLock(lockPath);
// Remove the lock only if it is still ours.
const releaseRunLock = (lockPath) => lockLib.releaseLock(lockPath);

// USD per million tokens. Source:
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-25)
// cw = 5-minute cache write, cw1h = 1-hour cache write, cr = cache hit.
const BUILTIN = {
  'fable-5-1':  { in: 10,   out: 50, cw: 12.50, cw1h: 20,   cr: 0.25 },
  'mythos-5-1': { in: 10,   out: 50, cw: 12.50, cw1h: 20,   cr: 0.25 },
  'fable-5':    { in: 10,   out: 50, cw: 12.50, cw1h: 20,   cr: 1.0  },
  'mythos-5':   { in: 10,   out: 50, cw: 12.50, cw1h: 20,   cr: 1.0  },
  'opus-5-5':   { in: 4,    out: 20, cw: 5,     cw1h: 8,    cr: 0.20 },
  'opus-5':     { in: 5,    out: 25, cw: 6.25,  cw1h: 10,   cr: 0.5  },
  'opus-4-8':   { in: 5,    out: 25, cw: 6.25,  cw1h: 10,   cr: 0.5  },
  'opus-4-7':   { in: 5,    out: 25, cw: 6.25,  cw1h: 10,   cr: 0.5  },
  'opus-4-6':   { in: 5,    out: 25, cw: 6.25,  cw1h: 10,   cr: 0.5  },
  'opus-4-5':   { in: 5,    out: 25, cw: 6.25,  cw1h: 10,   cr: 0.5  },
  'opus-4-1':   { in: 15,   out: 75, cw: 18.75, cw1h: 30,   cr: 1.5  },
  'opus-4':     { in: 15,   out: 75, cw: 18.75, cw1h: 30,   cr: 1.5  },
  'sonnet-5':   { in: 2,    out: 10, cw: 2.50,  cw1h: 4,    cr: 0.2  },
  'sonnet-4-6': { in: 3,    out: 15, cw: 3.75,  cw1h: 6,    cr: 0.3  },
  'sonnet-4-5': { in: 3,    out: 15, cw: 3.75,  cw1h: 6,    cr: 0.3  },
  'sonnet-4':   { in: 3,    out: 15, cw: 3.75,  cw1h: 6,    cr: 0.3  },
  'haiku-4-5':  { in: 1,    out: 5,  cw: 1.25,  cw1h: 2,    cr: 0.1  },
  'haiku-3-5':  { in: 0.80, out: 4,  cw: 1.00,  cw1h: 1.60, cr: 0.08 },
};
// Legacy ids put the version first ('claude-3-5-haiku'); the pricing page and
// BUILTIN put the family first ('haiku-3-5').
const LEGACY_ORDER = /^(\d+(?:-\d+)?)-(opus|sonnet|haiku)$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const num = (x) => (Number.isFinite(x) ? Math.max(0, x) : 0);

// 'claude-opus-5-5' / 'claude-haiku-4-5-20251001' / 'us.anthropic.claude-opus-4-8-v1:0'
// / 'claude-opus-4.8[1m]' / 'Claude Opus 5.5' -> 'opus-5-5', 'haiku-4-5', ...
// Returns '' for ids that are not Claude models at all ('<synthetic>').
const normKey = (model) => {
  let s = String(model || '').toLowerCase().trim();
  s = s.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '-').split('.').join('-');
  const at = s.indexOf('claude-');
  if (at === -1) return '';
  s = s.slice(at + 'claude-'.length);
  // Vertex ids carry the date after '@' ('claude-opus-4-1@20250805'); aliases
  // and variants can end in '-latest' / '-thinking'. Strip them before the date.
  s = s.replace(/@.*$/, '').replace(/(-(latest|thinking))+$/, '');
  s = s.replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '');
  if (!/^[a-z0-9-]+$/.test(s)) return '';
  const m = s.match(LEGACY_ORDER);
  return m ? m[2] + '-' + m[1] : s;
};

const validPrice = (p) => p && ['in', 'out', 'cw', 'cw1h', 'cr'].every((k) => Number.isFinite(p[k]) && p[k] >= 0);

const readCache = () => {
  try {
    const c = JSON.parse(fs.readFileSync(PRICE_CACHE, 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch (e) { return {}; }
};

// Built-in table overlaid with the backfilled one. sig identifies the exact set
// of prices in force, so a cached cost computed under another table is detectable.
const FIELDS = ['in', 'out', 'cw', 'cw1h', 'cr'];
const loadTable = () => {
  const cache = readCache();
  const table = { ...BUILTIN };
  const extra = cache.prices && typeof cache.prices === 'object' ? cache.prices : {};
  // Keys must look like normalised model keys; '__proto__' would otherwise
  // reassign table's prototype instead of adding a price.
  for (const [k, p] of Object.entries(extra)) if (/^[a-z0-9-]+$/.test(k) && !own(BUILTIN, k) && validPrice(p)) table[k] = p;
  // Fields are read in a fixed order: parsed rows and BUILTIN list them in a
  // different key order, and the same prices must give the same signature.
  const sig = crypto.createHash('md5')
    .update(JSON.stringify(Object.keys(table).sort().map((k) => [k, FIELDS.map((f) => table[k][f])])))
    .digest('hex').slice(0, 12);
  return { table, sig, cache };
};

// 'opus-4-8' -> 4_008_000, 'opus-4' -> 4_000_000, 'opus-4-10' -> 4_010_000: one
// thousand-wide slot per level, so a two-digit minor cannot carry into the major
// (as a decimal, 4-10 read 5.0 and tied with 5). null when the part after the
// family is not purely numeric or has more than three levels.
const verNum = (k) => {
  const p = k.split('-').slice(1);
  if (!p.length || p.length > 3 || p.some((x) => !/^\d{1,3}$/.test(x))) return null;
  return p.reduce((v, x, i) => v + Number(x) * Math.pow(1000, 2 - i), 0);
};

// The table key of the same family whose version is CLOSEST to key's; ties go to
// the newer one. Newest-in-family was used before, and it priced retired models
// at today's rates -- 'opus-3' came out at Opus 5.5's $4 against a real $15. A
// key with no numeric version falls back to the newest of its family.
const standIn = (byFam, key) => {
  const fam = key.split('-')[0];
  if (!byFam[fam]) return null;
  const v = verNum(key);
  let best = null, bestD = Infinity, bestV = -Infinity;
  for (const k of byFam[fam]) {
    const kv = verNum(k);
    if (kv === null) continue;
    const d = v === null ? -kv : Math.abs(kv - v);   // no version: smallest -kv = newest
    if (d < bestD || (d === bestD && kv > bestV)) { best = k; bestD = d; bestV = kv; }
  }
  // A family known only through keys without a numeric version (possible for a
  // backfilled one) still gets a stand-in rather than being priced at 0.
  return best || byFam[fam][0];
};

// { key, pr, exact }. exact=false means pr is a stand-in -- the same-family model
// with the closest version ('opus-6' -> 'opus-5-5', 'opus-3' -> 'opus-4') -- or
// null when the family is unknown. own() keeps ids like 'claude-constructor' off
// Object.prototype.
const makeResolver = (table) => {
  const byFam = Object.create(null);            // no prototype: 'constructor' is just a family name
  for (const k of Object.keys(table)) {
    const fam = k.split('-')[0];
    (byFam[fam] || (byFam[fam] = [])).push(k);
  }
  const memo = new Map();
  return (model) => {
    if (memo.has(model)) return memo.get(model);
    const key = normKey(model);
    let r;
    if (!key) r = { key: '', pr: null, exact: true };          // not a model: ignore, never look up
    else if (own(table, key)) r = { key, pr: table[key], exact: true };
    else {
      const near = standIn(byFam, key);
      r = { key, pr: near ? table[near] : null, exact: false };
    }
    memo.set(model, r);
    return r;
  };
};

const usageCost = (u, pr) => {
  const cwAll = num(u.cache_creation_input_tokens);
  const cw1h = Math.min(cwAll, num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens));
  return (num(u.input_tokens) * pr.in
        + num(u.output_tokens) * pr.out
        + (cwAll - cw1h) * pr.cw
        + cw1h * pr.cw1h
        + num(u.cache_read_input_tokens) * pr.cr) / 1e6;
};

const usageTok = (u) => num(u.input_tokens) + num(u.output_tokens)
  + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);

// Spawn price-refresh.js for keys that missed and were not checked recently.
// Detached and fire-and-forget: the caller never waits on the network.
const requestLookup = (keys, cache) => {
  try {
    const now = Date.now();
    const checked = (cache && cache.checked) || {};
    const due = [...new Set(keys)].filter((k) => k && !(checked[k] && now - checked[k] < RETRY_MS));
    if (!due.length) return false;
    const script = path.join(__dirname, 'price-refresh.js');
    if (!fs.existsSync(script)) return false;
    // A refresh already in flight: don't pile up one node process per render.
    try { if (now - fs.statSync(RUN_LOCK).mtimeMs < LOCK_STALE_MS) return false; } catch (e) {}
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, [script, ...due], { detached: true, stdio: 'ignore', windowsHide: true });
    // spawn reports failure (e.g. ENOENT) as an async 'error' event; unhandled, it
    // would kill the statusline process the try/catch cannot protect.
    p.on('error', () => {});
    p.unref();
    return true;
  } catch (e) { return false; }
};

module.exports = { PRICE_CACHE, RUN_LOCK, RETRY_MS, LOCK_STALE_MS, acquireRunLock, ownsRunLock, releaseRunLock, BUILTIN, normKey, validPrice, readCache, loadTable, makeResolver, usageCost, usageTok, requestLookup, num };
