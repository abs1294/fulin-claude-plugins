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

// Same table as statusline.js. Source:
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-08-23)
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
const PRICE_ORDER = Object.keys(PRICE).sort((a, b) => b.length - a.length);
const num = (x) => (Number.isFinite(x) ? Math.max(0, x) : 0);
const priceOf = (m) => {
  const k = String(m || '').toLowerCase().split('.').join('-');
  for (const name of PRICE_ORDER) if (k.includes(name)) return PRICE[name];
  return null;
};

// Skip if a recent result already exists.
try {
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  if (c && c.at && (Date.now() - c.at) < FRESH_MS) process.exit(0);
} catch (e) {}

// Single-runner lock: a scan is expensive and several sessions may spawn at once.
try {
  const st = fs.statSync(LOCK);
  if (Date.now() - st.mtimeMs < LOCK_STALE_MS) process.exit(0);
  fs.unlinkSync(LOCK);           // stale: previous run died
} catch (e) { /* absent: proceed */ }
try {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
} catch (e) { process.exit(0); }  // lost the race

const cleanup = () => { try { fs.unlinkSync(LOCK); } catch (e) {} };
process.on('exit', cleanup);
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
let tok = 0, cost = 0, unpricedTok = 0, recs = 0;
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
    const t = num(u.input_tokens) + num(u.output_tokens)
            + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    tok += t; recs++;
    const pr = priceOf(m.model);
    if (!pr) { unpricedTok += t; continue; }
    cost += (num(u.input_tokens) * pr.in
           + num(u.output_tokens) * pr.out
           + num(u.cache_creation_input_tokens) * pr.cw
           + num(u.cache_read_input_tokens) * pr.cr) / 1e6;
  }
}

const tmp = CACHE + '.' + process.pid + '.tmp';
try {
  fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), cost, tok, unpricedTok, records: recs, files: files.length }));
  fs.renameSync(tmp, CACHE);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
}
