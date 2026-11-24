'use strict';
// A month's usage, added up by scripts/usage-scan.js in its own process from the usage records cc-statusline keeps.
//
//   current month  added up again when the last figure is older than FRESH_MS, or when asked to.
//   past months    kept in the board's database (lib/db.js, table usage_month: one row a month, with its cost and
//                  tokens as columns and the full figures as JSON). Added up again when asked for and that was over
//                  a day ago, or over FRESH_MS ago while the records had not reached the end of the month: what was
//                  said shortly before midnight, or a price found later, comes in. The records are kept for good, so
//                  what they give now is right; only a month kept before there were records (no dataAt) may be more
//                  than they can hold, and is not replaced by less (keepMost).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DB = require('./db');
// Where finished months were kept before the database: one JSON file a month.
// Read in once, then left alone (nothing reads them afterwards).
const LEGACY_DIR = path.join(os.homedir(), '.claude', 'session-board', 'usage');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'usage-scan.js');
// The month in progress is added up again after this long.
const FRESH_MS = 60 * 1000;
const PAST_MS = 24 * 3600 * 1000;   // a past month is added up again after this long

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
// old one did (its cost and its tokens are at least 99.5% of it), it replaces the record. When it finds less - part of that month's
// conversations have been cleared away since - the record's totals, days, models, projects and sessions are kept, and
// only the per-role figures are taken from the new scan, marked as covering part of the month (rolesCover: the cost
// they add up to), so the page can say so instead of showing a table that silently does not add up.
function keepMost(had, now) {
  const of = (d, k) => Number(d && d.total && d.total[k]) || 0, b = of(now, 'cost');
  if (!had || !had.ok || had.dataAt !== undefined || (b >= of(had, 'cost') * 0.995 && of(now, 'tok') >= of(had, 'tok') * 0.995)) return now;   // (one kept without a price table has no cost: its tokens tell)
  const out = Object.assign({}, had, { rescannedAt: now.computedAt });
  if (Array.isArray(now.roles) && now.roles.length && !(Array.isArray(had.roles) && had.roles.length && !had.rolesCover) && of(had, 'cost') > 0) { out.roles = now.roles; out.rolesCover = b; }
  else if (!Array.isArray(had.roles)) { out.roles = []; out.rolesCover = 0; }   // looked for, none to be had: not asked for again
  if (had.slice === undefined) out.slice = null;   // each day's part: no longer to be had whole, not asked for again
  return out;
}

// Whether a past month's figure was made when the records had reached past its end. (One kept before 0.21.0 does not
// say: made from the conversations themselves, it was whole when it was made.)
const whole = (d) => !!d && (d.dataAt === undefined || (Number.isFinite(d.dataAt) && d.dataAt >= d.to));

// A title there was, where there is none now (the conversation was cleared away, or its title could not be looked up): kept.
function keepTitles(had, now) {
  if (!had || !had.ok || !now || !now.ok) return now;
  const t = new Map();
  for (const s of (had.slice && had.slice.sessions) || []) if (s[2]) t.set(s[0], s[2]);
  for (const s of had.sessions || []) if (s.title) t.set(s.sessionId, s.title);
  for (const s of (now.slice && now.slice.sessions) || []) if (!s[2] && t.has(s[0])) s[2] = t.get(s[0]);
  for (const s of now.sessions || []) if (!s.title && t.has(s.sessionId)) s.title = t.get(s.sessionId);
  return now;
}

class Monthly {
  constructor(opts = {}) {
    this.dbFile = opts.db || DB.DB_FILE;
    this.legacyDir = opts.legacyDir === undefined ? LEGACY_DIR : opts.legacyDir;
    this.run = opts.run || null;       // tests substitute the process
    this.now = opts.now || (() => new Date());
    this.mem = new Map();              // ym -> data
    this.jobs = new Map();             // ym -> scan in flight, shared by everyone asking
    this.looked = new Map();           // ym -> when a past month was last added up
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

  // A finished month as stored, null when there is none, undefined when that cannot be told just now (the database is held).
  _stored(ym) {
    let r; try { r = this._db().prepare('SELECT data FROM usage_month WHERE month = ?').get(ym); } catch (e) { return undefined; }
    try { const j = r ? JSON.parse(r.data) : null; return j && j.ok && j.month === ym ? j : null; } catch (e) { return null; }
  }
  _disk(ym) { return this._stored(ym) || null; }

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
    if (whole(this._disk(prev)) || this.jobs.has(prev)) return false;
    this._scan(prev, false).catch(() => {});
    return true;
  }

  // The months on record that were written before there were per-role figures (or each day's part) get them: scanned again, once each,
  // one after another. Called at start. -> the months asked for
  async addRoles() {
    const todo = this.stored().map((m) => m.month).filter((ym) => { const d = this._disk(ym); return d && (!Array.isArray(d.roles) || d.slice === undefined); });
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
      const now = this.now().getTime();
      if (hit && current && now - hit.computedAt < FRESH_MS) return hit;
      if (hit && !current) { this.mem.set(ym, hit); if (now - (this.looked.get(ym) || 0) < (whole(hit) ? PAST_MS : FRESH_MS)) return hit; }
    }
    return this._scan(ym, current);
  }

  _scan(ym, current) {
    if (this.jobs.has(ym)) return this.jobs.get(ym);
    if (!current) this.looked.set(ym, this.now().getTime());
    const job = scan(ym, this.run).then((data) => {
      if (!data.ok) {
        if (!current) this.looked.delete(ym);   // not added up: again when it is next asked for
        // A failed scan keeps showing the last good figure rather than nothing.
        const last = this.mem.get(ym) || this._disk(ym);
        return last ? Object.assign({}, last, { stale: true, error: data.error }) : data;
      }
      // A finished month that is on record already: Claude Code clears old conversations away, so a later scan can find
      // less than the first one did. What was found before is never replaced by less - see keepMost().
      let known = true;
      if (!current) {
        let had = this._stored(ym);
        if (had === undefined) { known = false; had = this.mem.get(ym); this.looked.delete(ym); }   // what is on record cannot be told: nothing is written over it
        if (had) data = keepTitles(had, keepMost(had, data));
      } else data = keepTitles(this.mem.get(ym), data);
      this.mem.set(ym, data);
      // Only a finished month is written down: the current one keeps changing.
      if (!current && known) { try { this._write(this._db(), data, false); } catch (e) {} }
      return data;
    }).finally(() => this.jobs.delete(ym));
    this.jobs.set(ym, job);
    return job;
  }
}

module.exports = { Monthly, ymOf, valid, FRESH_MS, keepMost };
