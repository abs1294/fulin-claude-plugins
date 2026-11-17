'use strict';
// A month's usage, computed by scripts/usage-scan.js in its own process.
//
//   current month  recomputed when the last figure is older than FRESH_MS
//                  (a scan takes a few seconds), or when asked to.
//   past months    computed once and kept in the board's database (lib/db.js,
//                  table usage_month: one row a month, with its cost and
//                  tokens as columns and the full figures as JSON). Kept on
//                  purpose: Claude Code deletes old transcripts after its
//                  retention period, and a month that can no longer be
//                  recomputed should not vanish from the record. Recomputed
//                  only when asked to (which, once transcripts are gone, would
//                  give a smaller figure; the page says so).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DB = require('./db');
// Where finished months were kept before the database: one JSON file a month.
// Read in once, then left alone (nothing reads them afterwards).
const LEGACY_DIR = path.join(os.homedir(), '.claude', 'session-board', 'usage');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'usage-scan.js');
// The month in progress is scanned again after this long. A scan reads only what
// was added since the last one (scripts/usage-scan.js), so it is cheap: measured
// 0.08 s against 4.6 s for reading everything.
const FRESH_MS = 60 * 1000;

const ymOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const valid = (ym) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym || ''));

function scan(ym, run) {
  return new Promise((resolve) => {
    (run || execFile)(process.execPath, [SCRIPT, ym], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000, windowsHide: true }, (err, stdout) => {
      try { const j = JSON.parse(String(stdout || '')); resolve(j && j.ok ? j : { ok: false, error: (j && j.error) || 'scan failed' }); }
      catch (e) { resolve({ ok: false, error: err ? String(err.message).slice(0, 200) : 'the scan printed nothing usable' }); }
    });
  });
}

// A finished month scanned again (`now`) against what is on record for it (`had`). When the new scan covers what the
// old one did (its cost is at least 99.5% of it), it replaces the record. When it finds less - part of that month's
// conversations have been cleared away since - the record's totals, days, models, projects and sessions are kept, and
// only the per-role figures are taken from the new scan, marked as covering part of the month (rolesCover: the cost
// they add up to), so the page can say so instead of showing a table that silently does not add up.
function keepMost(had, now) {
  const a = Number(had && had.total && had.total.cost) || 0, b = Number(now && now.total && now.total.cost) || 0;
  if (!had || !had.ok || b >= a * 0.995) return now;
  const out = Object.assign({}, had, { rescannedAt: now.computedAt });
  if (Array.isArray(now.roles) && now.roles.length && !(Array.isArray(had.roles) && had.roles.length && !had.rolesCover)) { out.roles = now.roles; out.rolesCover = b; }
  else if (!Array.isArray(had.roles)) { out.roles = []; out.rolesCover = 0; }   // looked for, none to be had: not asked for again
  return out;
}

class Monthly {
  constructor(opts = {}) {
    this.dbFile = opts.db || DB.DB_FILE;
    this.legacyDir = opts.legacyDir === undefined ? LEGACY_DIR : opts.legacyDir;
    this.run = opts.run || null;       // tests substitute the process
    this.now = opts.now || (() => new Date());
    this.mem = new Map();              // ym -> data
    this.jobs = new Map();             // ym -> scan in flight, shared by everyone asking
  }

  _db() {
    const db = DB.open(this.dbFile);
    DB.importOnce(db, 'usage/*.json', () => {
      let names = [];
      try { names = fs.readdirSync(this.legacyDir); } catch (e) { return; }
      for (const n of names) {
        const m = /^(\d{4}-\d{2})\.json$/.exec(n);
        if (!m) continue;
        try { const j = JSON.parse(fs.readFileSync(path.join(this.legacyDir, n), 'utf8')); if (j && j.ok && j.month === m[1]) this._write(db, j, true); } catch (e) {}
      }
    });
    return db;
  }

  _write(db, data, keepExisting) {
    db.prepare('INSERT INTO usage_month (month, computed_at, cost, tokens, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(month) DO '
      + (keepExisting ? 'NOTHING' : 'UPDATE SET computed_at = excluded.computed_at, cost = excluded.cost, tokens = excluded.tokens, data = excluded.data'))
      .run(data.month, Number(data.computedAt) || Date.now(), Number(data.total && data.total.cost) || 0, Math.round(Number(data.total && data.total.tok) || 0), JSON.stringify(data));
  }

  // A finished month as stored, or null.
  _disk(ym) {
    try {
      const r = this._db().prepare('SELECT data FROM usage_month WHERE month = ?').get(ym);
      const j = r ? JSON.parse(r.data) : null;
      return j && j.ok && j.month === ym ? j : null;
    } catch (e) { return null; }
  }

  // The months on record, newest first: [{month, computedAt, cost, tokens}].
  stored() {
    try { return this._db().prepare('SELECT month, computed_at AS computedAt, cost, tokens FROM usage_month ORDER BY month DESC').all(); } catch (e) { return []; }
  }

  // Writes last month down if it has not been yet. Called by the board on its
  // own (at start and a few times a day), so a finished month is saved even if
  // nobody opens it: waiting for someone to look risks the transcripts being
  // cleaned up first. Returns true when a scan was started.
  ensurePrevious() {
    const d = this.now();
    const prev = ymOf(new Date(d.getFullYear(), d.getMonth() - 1, 1));
    if (this._disk(prev) || this.jobs.has(prev)) return false;
    this.get(prev).catch(() => {});
    return true;
  }

  // The months on record that were written before there were per-role figures get them: scanned again, once each,
  // one after another. Called at start. -> the months asked for
  async addRoles() {
    const todo = this.stored().map((m) => m.month).filter((ym) => { const d = this._disk(ym); return d && !Array.isArray(d.roles); });
    for (const ym of todo) { try { await this.get(ym, true); } catch (e) {} }
    return todo;
  }

  // {ok, ...figures, stale?} - or {ok:false, error}.
  async get(ym, force) {
    if (!valid(ym)) return { ok: false, error: 'month must be YYYY-MM' };
    const current = ym === ymOf(this.now());
    if (ym > ymOf(this.now())) return { ok: false, error: '這個月還沒到' };
    if (!force) {
      const hit = this.mem.get(ym) || (current ? null : this._disk(ym));
      if (hit && (!current || this.now().getTime() - hit.computedAt < FRESH_MS)) { this.mem.set(ym, hit); return hit; }
    }
    if (this.jobs.has(ym)) return this.jobs.get(ym);
    const job = scan(ym, this.run).then((data) => {
      if (!data.ok) {
        // A failed scan keeps showing the last good figure rather than nothing.
        const last = this.mem.get(ym) || this._disk(ym);
        return last ? Object.assign({}, last, { stale: true, error: data.error }) : data;
      }
      // A finished month that is on record already: Claude Code clears old conversations away, so a later scan can find
      // less than the first one did. What was found before is never replaced by less - see keepMost().
      if (!current) { const had = this._disk(ym); if (had) data = keepMost(had, data); }
      this.mem.set(ym, data);
      // Only a finished month is written down: the current one keeps changing.
      if (!current) { try { this._write(this._db(), data, false); } catch (e) {} }
      return data;
    }).finally(() => this.jobs.delete(ym));
    this.jobs.set(ym, job);
    return job;
  }
}

module.exports = { Monthly, ymOf, valid, FRESH_MS, keepMost };
