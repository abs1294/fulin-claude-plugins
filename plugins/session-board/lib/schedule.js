'use strict';
// Schedules: "at this time, in this folder (or carrying on this session), say this to Claude".
//
// This file is the list and its arithmetic - what is stored, what is valid, when a schedule is next due.
// Nothing here runs anything: that is lib/schedrun.js. Here are also the two records the runner keeps -
// every run (schedule_run: when it was due, when it started, how it went, which conversation it went to)
// and the notices that want something from you (schedule_notice: a missed run, one that was not delivered,
// one that stopped for an approval).
//
//   kind     once   on `date` at `at`
//            daily  every day at `at`
//            weekly on the weekdays in `days` (0 = Sunday … 6 = Saturday) at `at`
//            monthly on the days of the month in `days` (1 … 31; 32 = the month's last day) at `at` - a day the month
//                   does not have (31 in April, 30 in February) is its last day (asked 2026-11-20: "why not monthly")
//            every  every `everyHours` hours, counted from when the schedule was last saved
//            custom its own `rule` (lib/rule.js: cron and more - working days, the Nth weekday, every N weeks, until, how many times)
//   target   folder   a new conversation in `cwd`, each time
//            goal     a goal handed to the goal2 plugin in `cwd`: `prompt` is the task, `goal` the condition it runs until
//            session  carry on session `sessionId` (its folder is kept in `cwd`, its name in `sessionTitle`)
//   fallback what to do when the session is open in a terminal and the message cannot be handed to it:
//            notify (only tell you) | fork (run a copy of it on the board) | takeover (move it to the board and run)
//   skipPermissions  the conversation started for this schedule does not ask for approval. Off unless set.

const DB = require('./db');
const Rule = require('./rule');

const KINDS = ['once', 'daily', 'weekly', 'monthly', 'every', 'custom'];
const LAST = 32;   // in a monthly schedule's days: the last day of the month

// Whether a schedule of the day kinds (daily, weekly, monthly) is due on the day of time t (local time)
function onDay(s, t) {
  const d = new Date(t), list = String(s.days).split(',').map(Number);
  if (s.kind === 'weekly') return list.includes(d.getDay());
  if (s.kind === 'monthly') {
    const dom = d.getDate(), last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return list.includes(dom) || (dom === last && list.some((x) => x > last));
  }
  return true;
}
// how many days to look ahead or back for the next or last one: a week, or a month and a bit
const span = (s) => (s.kind === 'monthly' ? 63 : 8);
// the day i days after t's (before, when negative), by the calendar: not t + i × 24 hours, which where clocks change
// drifts an hour a change and near midnight lands on the wrong day (review 2026-11-20)
const dayAfter = (t, i) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, 12).getTime(); };
const FALLBACKS = ['notify', 'fork', 'takeover'];
const HOUR = 3600000, DAY = 24 * HOUR;

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '', days TEXT NOT NULL DEFAULT '', every_hours INTEGER NOT NULL DEFAULT 0, target TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '', session_title TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL, fallback TEXT NOT NULL DEFAULT 'notify',
    skip_permissions INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  // last_due: the latest due time that has been dealt with (run, or written down as missed).
  if (!db.prepare("SELECT 1 FROM pragma_table_info('schedule') WHERE name = 'last_due'").get()) db.exec('ALTER TABLE schedule ADD COLUMN last_due INTEGER NOT NULL DEFAULT 0');
  // agent: the role the new conversation is started as (target 'folder' only); '' = an ordinary conversation.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('schedule') WHERE name = 'goal'").get()) db.exec("ALTER TABLE schedule ADD COLUMN goal TEXT NOT NULL DEFAULT ''");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('schedule') WHERE name = 'agent'").get()) db.exec("ALTER TABLE schedule ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
  // rule: a custom one's rule, as JSON (lib/rule.js)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('schedule') WHERE name = 'rule'").get()) db.exec("ALTER TABLE schedule ADD COLUMN rule TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS schedule_run (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL, name TEXT NOT NULL, due_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, how TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '')`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS schedule_run_once ON schedule_run (schedule_id, due_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS schedule_notice (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, schedule_id INTEGER NOT NULL, run_id INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', closed_by TEXT NOT NULL DEFAULT '')`);
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clock = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); if (!m) return null; const h = Number(m[1]), n = Number(m[2]); return h < 24 && n < 60 ? { h, n, text: String(h).padStart(2, '0') + ':' + m[2] } : null; };

// What was sent from the page -> {ok, value} or {ok: false, error}. isDir tells whether a folder exists.
function clean(input, isDir = () => true) {
  const o = input || {};
  const v = { name: str(o.name, 80), kind: KINDS.includes(o.kind) ? o.kind : '', at: '', date: '', days: '', everyHours: 0,
    target: o.target === 'session' ? 'session' : o.target === 'goal' ? 'goal' : 'folder', goal: o.target === 'goal' ? str(o.goal, 3500) : '', cwd: str(o.cwd, 400), sessionId: '', sessionTitle: str(o.sessionTitle, 200),
    prompt: str(o.prompt, 20000), fallback: FALLBACKS.includes(o.fallback) ? o.fallback : 'notify', skipPermissions: o.skipPermissions === true, enabled: o.enabled !== false,
    agent: o.target !== 'session' && o.target !== 'goal' && typeof o.agent === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(o.agent) ? o.agent : '' };
  if (!v.kind) return { ok: false, error: '請選擇什麼時候執行' };
  if (v.kind === 'custom') {
    const r = Rule.check(o.rule);
    if (!r.ok) return { ok: false, error: r.error };
    v.rule = r.rule;
  } else if (v.kind === 'every') {
    const n = Number(o.everyHours);
    if (!Number.isInteger(n) || n < 1 || n > 168) return { ok: false, error: '每隔幾小時要填 1 到 168 的整數' };
    v.everyHours = n;
  } else {
    const c = clock(o.at);
    if (!c) return { ok: false, error: '時間請用 24 小時制，例如 09:00' };
    v.at = c.text;
  }
  if (v.kind === 'once') {
    // a day that is: typed now (the board's date field is a text field), 2027-02-31 would have been March 3rd (review 2026-11-20)
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(o.date || '')), d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!m || d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return { ok: false, error: o.date ? '沒有這一天：' + String(o.date).slice(0, 20) + '（日期請用 YYYY-MM-DD）' : '請選擇日期' };
    v.date = o.date;
  }
  if (v.kind === 'weekly') {
    const days = [...new Set((Array.isArray(o.days) ? o.days : String(o.days || '').split(',')).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) return { ok: false, error: '每週至少選一天' };
    v.days = days.join(',');
  }
  if (v.kind === 'monthly') {
    const days = [...new Set((Array.isArray(o.days) ? o.days : String(o.days || '').split(',')).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= LAST))].sort((a, b) => a - b);
    if (!days.length) return { ok: false, error: '每月至少選一天' };
    v.days = days.join(',');
  }
  if (v.target === 'session') {
    if (!/^[0-9a-f-]{8,64}$/i.test(String(o.sessionId || ''))) return { ok: false, error: '請選擇要接續的 session' };
    v.sessionId = String(o.sessionId);
  } else v.sessionTitle = '';
  if (!v.cwd) return { ok: false, error: v.target === 'session' ? '這個 session 沒有資料夾' : '請選擇資料夾' };
  if (!isDir(v.cwd)) return { ok: false, error: '這個資料夾不存在：' + v.cwd.slice(0, 200) };
  if (!v.prompt) return { ok: false, error: '請寫下要它做什麼' };
  if (v.target === 'goal') { if (!v.goal) return { ok: false, error: '請寫下完成條件：做到什麼程度、怎麼檢查算完成' }; v.skipPermissions = false; v.fallback = 'notify'; }
  if (!v.name) v.name = v.prompt.split('\n')[0].slice(0, 40);
  return { ok: true, value: v };
}

// When a schedule is next due, as a time in milliseconds; 0 when it never is again (a one-off in the past).
// `from` is where to count from for "every N hours" (when it was last saved, or last ran once there is a runner).
function nextRun(s, now = Date.now(), from = s.updatedAt || now) {
  if (s.kind === 'custom') return s.rule && s.rule.cron ? Rule.next(s.rule, now, s.createdAt || s.updatedAt) : 0;
  const c = clock(s.at);
  const atOn = (day) => { const d = new Date(day); d.setHours(c.h, c.n, 0, 0); return d.getTime(); };
  if (s.kind === 'every') { const step = (s.everyHours || 1) * HOUR; return from > now ? from : from + (Math.floor((now - from) / step) + 1) * step; }
  if (!c) return 0;
  if (s.kind === 'once') { const t = atOn(new Date(s.date + 'T00:00:00')); return t > now ? t : 0; }
  for (let i = 0; i < span(s); i++) { const t = atOn(dayAfter(now, i)); if (t > now && onDay(s, t)) return t; }
  return 0;
}

// The latest time, not after now, at which a schedule was due; 0 when there is none. The runner compares it with
// what has been dealt with already. "Every N hours" counts from when the schedule was last saved.
function lastDue(s, now = Date.now()) {
  if (s.kind === 'custom') return s.rule && s.rule.cron ? Rule.last(s.rule, now, s.createdAt || s.updatedAt) : 0;
  const c = clock(s.at);
  const atOn = (day) => { const d = new Date(day); d.setHours(c.h, c.n, 0, 0); return d.getTime(); };
  if (s.kind === 'every') { const step = (s.everyHours || 1) * HOUR, from = s.updatedAt || now, k = Math.floor((now - from) / step); return k >= 1 ? from + k * step : 0; }
  if (!c) return 0;
  if (s.kind === 'once') { const t = atOn(new Date(s.date + 'T00:00:00')); return t <= now ? t : 0; }
  for (let i = 0; i < span(s); i++) { const t = atOn(dayAfter(now, -i)); if (t <= now && onDay(s, t)) return t; }
  return 0;
}

class Schedules {
  constructor(file) { this.file = file; }
  get db() { const db = DB.open(this.file); migrate(db); return db; }
  _row(r) {
    return { id: r.id, name: r.name, kind: r.kind, at: r.at, date: r.date, days: r.days, everyHours: r.every_hours, target: r.target, cwd: r.cwd, sessionId: r.session_id,
      sessionTitle: r.session_title, prompt: r.prompt, fallback: r.fallback, skipPermissions: !!r.skip_permissions, enabled: !!r.enabled, createdAt: r.created_at, updatedAt: r.updated_at, lastDue: r.last_due || 0, agent: r.agent || '', goal: r.goal || '', rule: (() => { try { return r.rule ? JSON.parse(r.rule) : null; } catch (e) { return null; } })() };
  }
  list(now = Date.now()) {
    return this.db.prepare('SELECT * FROM schedule ORDER BY id').all().map((r) => { const s = this._row(r); s.next = s.enabled ? nextRun(s, now) : 0; return s; });
  }
  get(id) { const r = this.db.prepare('SELECT * FROM schedule WHERE id = ?').get(Number(id) || 0); return r ? this._row(r) : null; }
  // v: a value from clean(). With an id, that schedule is replaced. -> its id.
  save(v, id, now = Date.now()) {
    // a rule's count starts at the save that changed the rule (lib/rule.js stamp)
    if (v.rule) { const old = id ? this.get(id) : null; v = Object.assign({}, v, { rule: Rule.stamp(v.rule, old && old.kind === 'custom' ? old.rule : null, now) }); }
    const args = [v.name, v.kind, v.at, v.date, v.days, v.everyHours, v.target, v.cwd, v.sessionId, v.sessionTitle, v.prompt, v.fallback, v.skipPermissions ? 1 : 0, v.enabled ? 1 : 0, now];
    const role = (n) => { this.db.prepare('UPDATE schedule SET agent = ?, goal = ?, rule = ? WHERE id = ?').run(v.agent || '', v.goal || '', v.rule ? JSON.stringify(v.rule) : '', n); return n; };
    if (id && this.get(id)) {
      this.db.prepare('UPDATE schedule SET name=?, kind=?, at=?, date=?, days=?, every_hours=?, target=?, cwd=?, session_id=?, session_title=?, prompt=?, fallback=?, skip_permissions=?, enabled=?, updated_at=? WHERE id=?').run(...args, Number(id));
      return role(Number(id));
    }
    return role(Number(this.db.prepare('INSERT INTO schedule (name, kind, at, date, days, every_hours, target, cwd, session_id, session_title, prompt, fallback, skip_permissions, enabled, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...args, now).lastInsertRowid));
  }
  setEnabled(id, on, now = Date.now()) { return this.db.prepare('UPDATE schedule SET enabled = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, now, Number(id) || 0).changes > 0; }
  remove(id) { return this.db.prepare('DELETE FROM schedule WHERE id = ?').run(Number(id) || 0).changes > 0; }
  lastDue(s, now) { return lastDue(s, now); }
  setLastDue(id, t) { this.db.prepare('UPDATE schedule SET last_due = ? WHERE id = ?').run(t, Number(id)); }

  // ── runs ──
  // -> the new run's id, or 0 when this schedule already has a run for that due time.
  addRun(r) {
    try { return Number(this.db.prepare('INSERT INTO schedule_run (schedule_id, name, due_at, started_at, ended_at, status, how, session_id, note) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(r.scheduleId, r.name, r.dueAt, r.startedAt, r.endedAt || 0, r.status, r.how || '', r.sessionId || '', r.note || '').lastInsertRowid); } catch (e) { return 0; }
  }
  updateRun(id, p) {
    const col = { status: 'status', how: 'how', sessionId: 'session_id', note: 'note', endedAt: 'ended_at' }, set = [], args = [];
    for (const k of Object.keys(p)) if (col[k]) { set.push(col[k] + ' = ?'); args.push(p[k]); }
    if (set.length) this.db.prepare('UPDATE schedule_run SET ' + set.join(', ') + ' WHERE id = ?').run(...args, Number(id));
  }
  _run(r) { return { id: r.id, scheduleId: r.schedule_id, name: r.name, dueAt: r.due_at, startedAt: r.started_at, endedAt: r.ended_at, status: r.status, how: r.how, sessionId: r.session_id, note: r.note }; }
  runs(limit = 20) { return this.db.prepare('SELECT * FROM schedule_run ORDER BY id DESC LIMIT ?').all(limit).map((r) => this._run(r)); }
  // Runs that went to a conversation on the board and have not finished.
  openRuns() { return this.db.prepare("SELECT * FROM schedule_run WHERE (status IN ('running', 'waiting') AND session_id <> '' AND how <> 'peer') OR status = 'sent'").all().map((r) => this._run(r)); }

  // ── notices ──
  addNotice(n, now = Date.now()) { return Number(this.db.prepare('INSERT INTO schedule_notice (at, kind, schedule_id, run_id, text) VALUES (?,?,?,?,?)').run(now, n.kind, n.scheduleId, n.runId || 0, String(n.text).slice(0, 600)).lastInsertRowid); }
  _notice(r) { return r ? { id: r.id, at: r.at, kind: r.kind, scheduleId: r.schedule_id, runId: r.run_id, text: r.text, state: r.state } : null; }
  notices() { return this.db.prepare("SELECT * FROM schedule_notice WHERE state = 'open' ORDER BY id DESC LIMIT 50").all().map((r) => this._notice(r)); }
  noticeCount() { return this.db.prepare("SELECT count(*) AS n FROM schedule_notice WHERE state = 'open'").get().n; }
  getNotice(id) { return this._notice(this.db.prepare('SELECT * FROM schedule_notice WHERE id = ?').get(Number(id) || 0)); }
  closeNotice(id, by) { this.db.prepare("UPDATE schedule_notice SET state = 'closed', closed_by = ? WHERE id = ?").run(String(by || ''), Number(id) || 0); }
}

module.exports = { Schedules, clean, nextRun, lastDue, KINDS, FALLBACKS, LAST };
