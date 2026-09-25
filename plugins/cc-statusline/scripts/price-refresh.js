#!/usr/bin/env node
/**
 * price-refresh.js — backfill model prices the built-in table does not know.
 *
 * Usage: node price-refresh.js <missing-key> [...]
 * Spawned detached by lib-price.requestLookup when a transcript names a model with
 * no exact entry (a model upgrade: 'opus-5-5' while the table only had 'opus-5').
 *
 * Fetches the Markdown rendition of the official pricing page, parses the
 * "Model pricing" table, and writes the parsed rows to
 * ~/.claude/usage-data/cc-statusline-prices.json. lib-price only uses rows for
 * keys its built-in table lacks, so this can fill gaps but never override a
 * known price. Each requested key is stamped in `checked` BEFORE the fetch, so
 * a slow or crashed run still throttles retries (lib-price.RETRY_MS).
 *
 * Fail-safe: columns are located by their header text, not by position; a table
 * whose header lacks any expected column, or that yields fewer than MIN_ROWS
 * valid rows, writes no prices at all.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { PRICE_CACHE, RUN_LOCK, RETRY_MS, LOCK_STALE_MS, acquireRunLock, ownsRunLock, releaseRunLock, normKey, validPrice, readCache } = require('./lib-price');
const { casMerge } = require('../hooks/lib-state');

const PAGE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const LOCK = RUN_LOCK;
const MIN_ROWS = 5;

const fetchText = (url, hops = 0) => new Promise((resolve, reject) => {
  const req = https.get(url, { timeout: 15000, headers: { 'user-agent': 'cc-statusline-price-refresh' } }, (res) => {
    // Listeners go on FIRST, before any branch returns: a connection dropped
    // mid-body emits 'error'/'aborted' on the response -- also while a redirect or
    // error body is being drained -- and unhandled it would crash the process.
    // reject after resolve is a no-op, so the drain branches are covered too.
    res.on('error', reject);
    res.on('aborted', () => reject(new Error('aborted')));
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
      res.resume();
      // A malformed Location makes new URL throw synchronously inside this
      // callback, outside any promise -- that would crash the process.
      let next;
      try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(e); }
      return resolve(fetchText(next, hops + 1));
    }
    if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
    let d = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (d += c));
    res.on('end', () => resolve(d));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
});

// Header: | Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
// Row:    | Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
// Each field is found by matching its header text, so an added or reordered
// column cannot shift a price into the wrong field; a missing one aborts.
const COLUMNS = { in: /base input/i, cw: /5m cache/i, cw1h: /1h cache/i, cr: /cache hit/i, out: /output/i };
const cellsOf = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const parseTable = (md) => {
  const start = md.indexOf('## Model pricing');
  if (start === -1) return {};
  const rest = md.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = (end === -1 ? rest : rest.slice(0, end)).split('\n');
  const hi = section.findIndex((l) => /^\|\s*Model\s*\|/i.test(l));
  if (hi === -1) return {};
  const header = cellsOf(section[hi]);
  const col = {};
  for (const [f, re] of Object.entries(COLUMNS)) {
    const idx = header.findIndex((h) => re.test(h));
    if (idx < 1) return {};
    col[f] = idx;
  }
  const out = {};
  for (const line of section.slice(hi + 1)) {
    if (!/^\|\s*Claude /.test(line)) continue;
    const cells = cellsOf(line);
    const name = cells[0].replace(/\(\[[^\]]*\]\([^)]*\)\)/g, '').replace(/\([^)]*\)/g, '').trim();
    const key = normKey(name);
    const p = {};
    for (const [f, idx] of Object.entries(col)) {
      const m = String(cells[idx] || '').match(/\$\s*([\d.]+)/);
      p[f] = m ? Number(m[1]) : NaN;
    }
    if (key && validPrice(p)) out[key] = p;
  }
  return out;
};


// Whole-run ceiling. The request's own timeout is an IDLE timeout: a server that
// trickles bytes never trips it, and the run would hold the lock until it goes
// stale. Past this, the run records the failure and exits.
const TOTAL_MS = 45000;

const acquireLock = () => acquireRunLock(LOCK, LOCK_STALE_MS);
// Still holding the lock? The takeover can, in a three-way race inside one
// moment, leave two runs each believing they hold it; re-checking just before the
// fetch lets the one whose lock file is gone step aside.
const ownsLock = () => ownsRunLock(LOCK);

// Merge into what is on disk NOW, under hooks/lib-state's casMerge (its own short
// write lock around read -> merge -> write -> verify), so even two overlapping
// runs cannot drop each other's prices, checked stamps or missing keys.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const writeMerged = (ours) => {
  const plain = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  casMerge(PRICE_CACHE, (cur) => {
    cur.prices = { ...plain(cur.prices), ...(ours.prices || {}) };
    cur.checked = { ...plain(cur.checked), ...(ours.checked || {}) };
    cur.at = Math.max(Number(cur.at) || 0, ours.at || 0);
    cur.source = PAGE_URL;
    if (ours.lastError !== undefined) cur.lastError = ours.lastError;
    // missing: union of every run's list, minus anything now priced and anything
    // whose last check is past RETRY_MS (it will be looked up again anyway), so
    // the list does not only ever grow.
    const now = Date.now();
    const miss = new Set([...(Array.isArray(cur.missing) ? cur.missing : []), ...(ours.missing || [])]);
    cur.missing = [...miss].filter((k) => !own(cur.prices, k)
      && own(cur.checked, k) && now - Number(cur.checked[k]) < RETRY_MS);
  }, (after) => {
    const p = plain(after.prices), c = plain(after.checked);
    return Object.keys(ours.prices || {}).every((k) => own(p, k))
      && Object.keys(ours.checked || {}).every((k) => own(c, k));
  });
};

if (require.main === module) (async () => {
  // argv carries keys already normalised by lib-price ('opus-5-5'); normKey would
  // reject them for lacking the 'claude-' prefix and the throttle stamp would be lost.
  const wanted = process.argv.slice(2).filter((k) => /^[a-z0-9-]+$/.test(k));
  if (!acquireLock()) return;
  process.on('exit', () => releaseRunLock(LOCK));

  // Stamp first: if the fetch hangs or this process dies, renders still see the
  // keys as recently checked instead of spawning a new refresh every 30s.
  const checked = {};
  const now = Date.now();
  for (const k of wanted) checked[k] = now;
  writeMerged({ checked });
  if (!ownsLock()) return;   // lost it in a takeover race: the other holder fetches

  let prices = {}, at = 0, error = null;
  try {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('deadline ' + TOTAL_MS / 1000 + 's')), TOTAL_MS);
    });
    try {
      const parsed = parseTable(await Promise.race([fetchText(PAGE_URL), deadline]));
      if (Object.keys(parsed).length >= MIN_ROWS) { prices = parsed; at = Date.now(); }
      else error = 'parsed only ' + Object.keys(parsed).length + ' rows';
    } finally { clearTimeout(timer); }
  } catch (e) { error = String(e && e.message || e); }
  const known = { ...(readCache().prices || {}), ...prices };
  const missing = wanted.filter((k) => !Object.prototype.hasOwnProperty.call(known, k));
  writeMerged({ prices, checked, at, missing, lastError: error });
  // A stalled socket abandoned at the deadline would keep the process alive.
  process.exit(0);
})();

module.exports = { parseTable, fetchText, acquireLock, ownsLock, writeMerged };
