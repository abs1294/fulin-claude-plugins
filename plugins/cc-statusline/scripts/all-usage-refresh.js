#!/usr/bin/env node
/**
 * all-usage-refresh.js — cross-session API-equivalent usage for the (all) figure.
 *
 * Walks every transcript under ~/.claude/projects (main sessions AND subagents),
 * sums billed token components, prices them with the same table statusline.js uses,
 * and writes ~/.claude/usage-data/cc-statusline-all-usage.json.
 *
 * Spawned detached by statusline.js when its cache is missing or stale. Never runs
 * inline: a full scan is seconds of IO on a multi-GB history.
 *
 * Why a full scan rather than the cumulative store: the store only ever held
 * sessions that rendered a statusline (68 of 591 main transcripts locally) and its
 * cost came from the payload, which omits subagents. Together those understated the
 * total by 3.2x.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE = path.join(os.homedir(), '.claude', 'usage-data', 'cc-statusline-all-usage.json');
const LOCK = CACHE + '.lock';
const FRESH_MS = 6 * 3600 * 1000;   // re-scan at most this often
const LOCK_STALE_MS = 30 * 60 * 1000;

// Pricing is shared with statusline.js (exact model match, stand-in price for
// unknown ids, backfill via price-refresh.js). sig ties the cache to the table.
const priceLib = require('./lib-price');
const { table, sig, cache: priceCache } = priceLib.loadTable();
const resolvePrice = priceLib.makeResolver(table);

// Skip if a recent result already exists.
try {
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  if (c && c.at && (Date.now() - c.at) < FRESH_MS && c.sig === sig) process.exit(0);
} catch (e) {}

// Single-runner lock: a scan is expensive and several sessions may spawn at once.
// Shared with price-refresh.js (lib-price.acquireRunLock): a stale lock is taken
// over by atomic rename, not stat -> unlink -> create, which let a late run
// delete the lock an earlier run had just made and both scan at once.
if (!priceLib.acquireRunLock(LOCK, LOCK_STALE_MS)) process.exit(0);
process.on('exit', () => priceLib.releaseRunLock(LOCK));
// Lost the lock in a takeover race after all: the other holder scans.
if (!priceLib.ownsRunLock(LOCK)) process.exit(0);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

const root = path.join(os.homedir(), '.claude', 'projects');
const files = [];
const walk = (d) => {
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
};
walk(root);

// Dedup by message.id across every file, keep-first: the same assistant turn is
// written to a transcript several times, and a subagent turn is also echoed into
// its parent. Summing raw lines roughly doubles the total.
const seen = new Set();
let tok = 0, cost = 0, unpricedTok = 0, approxTok = 0, recs = 0;
const missing = new Set();
for (const f of files) {
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    const m = j.message;
    if (!m || !m.usage) continue;
    const id = m.id;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const u = m.usage;
    const t = priceLib.usageTok(u);
    tok += t; recs++;
    const r = resolvePrice(m.model);
    if (!r.exact) missing.add(r.key);
    if (!r.pr) { unpricedTok += t; continue; }
    cost += priceLib.usageCost(u, r.pr);
    if (!r.exact) approxTok += t;
  }
}

const tmp = CACHE + '.' + process.pid + '.tmp';
try {
  fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), sig, cost, tok, unpricedTok, approxTok, missing: [...missing], records: recs, files: files.length }));
  fs.renameSync(tmp, CACHE);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
}
priceLib.requestLookup([...missing], priceCache);
