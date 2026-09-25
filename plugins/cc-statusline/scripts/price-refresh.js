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
const { PRICE_CACHE, LOCK_STALE_MS, normKey, validPrice, readCache } = require('./lib-price');

const PAGE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const LOCK = PRICE_CACHE + '.lock';
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

const atomicWrite = (f, data) => {
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
};

if (require.main === module) (async () => {
  // argv carries keys already normalised by lib-price ('opus-5-5'); normKey would
  // reject them for lacking the 'claude-' prefix and the throttle stamp would be lost.
  const wanted = process.argv.slice(2).filter((k) => /^[a-z0-9-]+$/.test(k));
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return;
    fs.unlinkSync(LOCK);
  } catch (e) {}
  try {
    fs.mkdirSync(path.dirname(PRICE_CACHE), { recursive: true });
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch (e) { return; }
  // Only remove the lock if it is still ours: another run may have judged it
  // stale and replaced it.
  process.on('exit', () => {
    try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch (e) {}
  });

  const cache = readCache();
  const next = { prices: cache.prices || {}, checked: cache.checked || {}, at: cache.at || 0, source: PAGE_URL };
  // Stamp first: if the fetch hangs or this process dies, renders still see the
  // keys as recently checked instead of spawning a new refresh every 30s.
  const now = Date.now();
  for (const k of wanted) next.checked[k] = now;
  atomicWrite(PRICE_CACHE, JSON.stringify(next));

  let error = null;
  try {
    const parsed = parseTable(await fetchText(PAGE_URL));
    if (Object.keys(parsed).length >= MIN_ROWS) {
      next.prices = { ...next.prices, ...parsed };
      next.at = Date.now();
    } else {
      error = 'parsed only ' + Object.keys(parsed).length + ' rows';
    }
  } catch (e) { error = String(e && e.message || e); }
  next.missing = wanted.filter((k) => !Object.prototype.hasOwnProperty.call(next.prices, k));
  next.lastError = error;
  atomicWrite(PRICE_CACHE, JSON.stringify(next));
})();

module.exports = { parseTable, fetchText };
