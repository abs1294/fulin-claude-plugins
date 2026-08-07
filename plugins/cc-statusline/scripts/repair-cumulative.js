#!/usr/bin/env node
// One-off (but idempotent) repair for cc-statusline's cumulative usage store.
//
// A concurrent-render ping-pong inflated some sessions' `total` without bound:
// two renders of one session held different payload snapshots, and a whole-entry
// merge let the lower `base` survive alongside the higher `total`, so the gap
// between the snapshots was re-charged every ~30s. One session reached
// $1,008,997 against a true spend of $694. statusline.js no longer has the
// mechanism; this script cleans up the damage already on disk.
//
// Repair rule: for an inflated key, `total` is reset to `base`. `base` is the
// last value the payload itself reported, so it is the trustworthy figure.
//
// Deliberately CONSERVATIVE. `total` legitimately exceeds `base` whenever a
// session was compacted (that is the whole point of the total/base split), so a
// low ratio is indistinguishable from mild pumping and is LEFT ALONE. Only
// runaway entries are touched -- ones inflated beyond anything compaction can
// explain, corroborated by the same runaway appearing in an independent key.
//
// Usage:  node repair-cumulative.js [--apply] [--file <path>]
//         node repair-cumulative.js --list-fixtures [--file <path>]
// Without --apply it is a dry run and writes nothing. --list-fixtures only
// reports; it never deletes, because telling a test fixture from a real session
// is a judgement call that belongs to a human.

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const listFixtures = argv.includes('--list-fixtures');
const fileArg = argv.indexOf('--file');
const FILE = fileArg !== -1 && argv[fileArg + 1]
  ? argv[fileArg + 1]
  : path.join(os.homedir(), '.claude', 'usage-data', 'cc-statusline-cumulative.json');

// An entry is "runaway" only if total exceeds base by this factor. Compaction
// realistically produces a handful of resets, so even 5x is generous; the
// observed pump reached 15x-1450x, far clear of the legitimate band (max 2.9x).
const RATIO = 5;
// Below this, even a large ratio is not worth touching (a session that spent
// cents can show a big ratio from rounding alone).
const MIN_ABS = 1.0;
const KEYS = ['cost', 'dur', 'add', 'rm', 'tok'];

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
// Entries exist in two shapes: the current { settled, peak } and the legacy
// { total, base }. Report on whichever is present without rewriting the shape --
// statusline.js reads both, so a format migration here would add risk for nothing.
const reported = (e) => {
  if (!e || typeof e !== 'object') return 0;
  if (typeof e.peak === 'number') return num(e.settled) + num(e.peak);
  return num(e.total);
};
const truth = (e) => {
  if (!e || typeof e !== 'object') return 0;
  if (typeof e.peak === 'number') return num(e.peak);
  return num(e.base);
};

let store;
try {
  store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`cannot read ${FILE}: ${e.message}`);
  process.exit(1);
}
const sessions = (store && store.sessions) || {};

// Test fixtures leak into the real store whenever a smoke test runs against the
// live file instead of a sandboxed HOME (it has happened; 22 such keys worth
// $17.76 were cleaned out once). A real key is the session UUID with the dashes
// stripped -- pure hex, 32 chars, or 24 for entries predating the full-key
// migration. Anything else was typed by a test.
//
// Reported, never deleted: a future Claude Code version could legitimately change
// the session id format, and silently dropping entries on a format guess would
// destroy real spend history. Deletion stays a human decision.
const isRealKey = (k) => /^[0-9a-f]+$/i.test(k) && (k.length === 24 || k.length === 32);
if (listFixtures) {
  const fixtures = Object.keys(sessions).filter(k => !isRealKey(k));
  const total = fixtures.reduce((a, k) => a + reported(sessions[k].cost), 0);
  console.log(`file: ${FILE}`);
  console.log(`sessions: ${Object.keys(sessions).length}`);
  console.log(`non-UUID keys (likely test fixtures): ${fixtures.length}`);
  for (const k of fixtures) {
    console.log(`  ${k.padEnd(26)} len=${String(k.length).padStart(2)}  $${reported(sessions[k].cost).toFixed(2)}`);
  }
  console.log(`combined: $${total.toFixed(2)}`);
  console.log('\nReported only -- nothing deleted. Review the list, then remove by hand.');
  process.exit(0);
}

const allKeys = () => Object.keys(sessions);
// A short key that another, longer key extends is a pre-migration duplicate of the
// same session (the store was once keyed by a 24-char truncation). statusline.js
// skips these when summing; mirror that here so the reported figures match what the
// status line actually shows.
const superseded = (k) => allKeys().some(o => o.length > k.length && o.startsWith(k));

const sumReported = () => Object.entries(sessions)
  .reduce((a, [k, s]) => a + (superseded(k) ? 0 : reported(s && s.cost)), 0);
const sumTruth = () => Object.entries(sessions)
  .reduce((a, [k, s]) => a + (superseded(k) ? 0 : truth(s && s.cost)), 0);

const beforeTotal = sumReported();
const beforeBase = sumTruth();

const repairs = [];
for (const [key, entry] of Object.entries(sessions)) {
  if (!entry || typeof entry !== 'object') continue;
  const cost = entry.cost;
  if (!cost || typeof cost !== 'object') continue;
  const total = reported(cost);
  const base = truth(cost);
  // base === 0 with a nonzero total cannot be judged by ratio: it is either a
  // session that reset to zero (legitimate) or a pump from a zero base. Require
  // an absolute figure large enough that no real session reaches it un-pumped.
  const runaway = base > 0 ? (total > base * RATIO && total > MIN_ABS)
                           : total > 1000;
  if (!runaway) continue;

  const fix = { key, cost: [total, base] };
  // Repair the other cumulative keys the same way -- the pump hits every key in
  // the entry, not just cost, so leaving them inflated would keep the tokens and
  // duration columns wrong.
  for (const k of KEYS) {
    const v = entry[k];
    if (!v || typeof v !== 'object') continue;
    const t = reported(v), b = truth(v);
    if (b > 0 ? t > b * RATIO : t > 0) fix[k] = [t, b];
  }
  repairs.push(fix);

  if (apply) {
    for (const k of KEYS) {
      const v = entry[k];
      if (!v || typeof v !== 'object') continue;
      const t = reported(v), b = truth(v);
      if (!(b > 0 ? t > b * RATIO : t > 0)) continue;
      // Collapse to "reported == truth" in whichever shape the entry uses. Both
      // forms are idempotent: a re-run recomputes reported() as b and no longer
      // matches the runaway test.
      if (typeof v.peak === 'number') v.settled = 0; // reported becomes peak alone
      else v.total = b;
    }
  }
}

// Report the truncated-key duplicates. These are NOT deleted: statusline.js
// already excludes them from the cross-session sum, and keeping them preserves the
// history of sessions that ended before the full-key migration. Deleting would be
// the only lossy step in this script, and it buys nothing.
const dupes = allKeys().filter(superseded);
if (dupes.length) {
  const dupSum = dupes.reduce((a, k) => a + reported(sessions[k].cost), 0);
  console.log(`superseded 24-char keys: ${dupes.length} ($${dupSum.toFixed(2)} excluded from the sum, kept on disk as history)`);
  // One short key extending to several long keys means the truncation collided and
  // two different sessions share it. Excluding it then loses whichever session has
  // no full-length entry, so surface it rather than let it pass silently.
  for (const k of dupes) {
    const m = allKeys().filter(o => o.length > k.length && o.startsWith(k));
    if (m.length > 1) console.log(`  WARNING collision: ${k} extends to ${m.length} full keys -- excluded spend may belong to either`);
  }
}

console.log(`file: ${FILE}`);
console.log(`sessions: ${Object.keys(sessions).length}`);
console.log(`sum(cost reported) before: $${beforeTotal.toFixed(2)}`);
console.log(`sum(cost truth)    before: $${beforeBase.toFixed(2)}`);
console.log(`runaway entries: ${repairs.length}`);
for (const r of repairs) {
  const [t, b] = r.cost;
  const ratio = b > 0 ? (t / b).toFixed(1) + 'x' : 'base=0';
  console.log(`  ${r.key}  cost $${t.toFixed(2)} -> $${b.toFixed(2)}  (${ratio})`);
}

if (!apply) {
  console.log('\nDRY RUN -- nothing written. Re-run with --apply to repair.');
  process.exit(0);
}

if (repairs.length === 0) {
  console.log('\nnothing to repair; file left untouched.');
  process.exit(0);
}

// Back up before writing. Timestamped so a second run cannot clobber the
// original pre-repair state.
const bak = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '')}`;
fs.copyFileSync(FILE, bak);
// Write via temp + rename so a concurrent statusline render never reads a
// half-written file -- same atomicity contract statusline.js itself uses.
const tmp = `${FILE}.repair.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(store));
fs.renameSync(tmp, FILE);

const afterTotal = sumReported();
console.log(`\nbackup: ${bak}`);
console.log(`sum(cost.total) after:  $${afterTotal.toFixed(2)}`);
console.log(`recovered: $${(beforeTotal - afterTotal).toFixed(2)}`);
