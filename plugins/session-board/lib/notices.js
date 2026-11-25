'use strict';
// The board's notification centre: the things that are waiting for you NOW, each one open until it is over.
//
// This is not Windows' notifications, and it does not copy them. A Windows notification says "something just
// happened" and is gone; nothing here is written because one was shown. What is kept here is a state: a notice is
// OPENED when something begins to need you, and CLOSED when that is over - you answered, the session went on, the
// session ended, the month turned. So the list of open notices is always "what still needs me", with nothing in it
// that has already been dealt with.
//
// Nothing is looked up on a timer. A notice opens and closes on an event:
//   - a board conversation changing state           (lib/chat.js onStatus / onGone: the board runs it and knows)
//   - a terminal session changing state or ending   (Claude Code rewrites ~/.claude/sessions/<pid>.json; the
//                                                     folder is WATCHED, see server.js - Windows reports each write)
//   - you opening a conversation on the board       (closes "finished, have a look")
//   - the watching of stopped sessions finding or clearing something (lib/watchdog.js)
//   - the budget being crossed or changed           (lib/budget.js)
// An event can be lost (a watcher may drop one; the board may be off when it happens). So the whole table is checked
// against the sessions as they are - reconcile() - when the board starts, when the watcher reports trouble, and when
// you open the page: an open notice whose reason is gone is closed there. That is what closes the loop.
//
// The table (the board's database):
//   notice(id, key, kind, session_id, title, text, state, opened_at, closed_at, closed_by)
//   key   what it is about: "<kind>:<session id>", "budget:<month>:<point>". At most ONE open notice per key
//         (a unique index says so): the same thing beginning twice does not make two.
//
//   kind      opens when                                   closes when (closed_by)
//   waiting   a session stops to ask you / for approval    it goes on (answered) · that turn is stopped (stopped) ·
//                                                          it ends (ended)
//   done      a session finishes a turn                    you open it on the board (seen) · it starts again
//                                                          (continued) · it ends (ended)
//   stuck     working, nothing written for N minutes       it moves again or stops working (moved) · ended
//   limit     stopped by the usage limit                   it starts again (resumed) · ended
//   error     stopped by an error on the API's side        it starts again (resumed) · ended
//   budget    this month's cost crosses a point            the month turns (month over) · the budget is changed
//   machine   this computer's memory or processor stays     it has eased (eased) · it is turned off (machine off) ·
//             over the point set (lib/machine.js)           it is nearly full, told anew (worse)
//   any kind                                               you say you do not need it (dismissed)
const DB = require('./db');

const KEEP_CLOSED_MS = 30 * 86400000;
const WORKING = (s) => s === 'busy' || s === 'background';

class Notices {
  // o.statusNotices: also write "done" and "waiting" (a turn ended, it asks you). Off by default since 2026-11-17: the
  // left column already shows both, and the bell is for what nothing else tells you - stuck, limits, errors, budget.
  // Off, the ones still open are closed once, as retired.
  constructor(file = DB.DB_FILE, o = {}) {
    this.db = DB.open(file);
    this.statusNotices = o.statusNotices === true;
    this.db.exec(`CREATE TABLE IF NOT EXISTS notice (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
      opened_at INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT)`);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS notice_one_open ON notice(key) WHERE state = 'open'");
    this.db.exec('CREATE INDEX IF NOT EXISTS notice_session ON notice(session_id, state)');
    if (!this.statusNotices) this.db.prepare("UPDATE notice SET state = 'closed', closed_at = ?, closed_by = 'retired' WHERE state = 'open' AND kind IN ('done', 'waiting')").run(Date.now());
  }
  _row(r) { return r ? { id: r.id, key: r.key, kind: r.kind, sessionId: r.session_id, title: r.title, text: r.text, state: r.state, openedAt: r.opened_at, closedAt: r.closed_at || 0, closedBy: r.closed_by || '' } : null; }

  // Opens a notice, unless one about the same thing is open already. -> the open notice
  open(n, now = Date.now()) {
    const key = String(n.key || (n.kind + ':' + (n.sessionId || '')));
    this.db.prepare("INSERT OR IGNORE INTO notice (key, kind, session_id, title, text, state, opened_at) VALUES (?, ?, ?, ?, ?, 'open', ?)")
      .run(key, String(n.kind), String(n.sessionId || ''), String(n.title || '').slice(0, 160), String(n.text || '').slice(0, 500), now);
    return this._row(this.db.prepare("SELECT * FROM notice WHERE key = ? AND state = 'open'").get(key));
  }
  // Closes the open notice about `key`, if there is one. -> whether one was closed
  close(key, by, now = Date.now()) { return this.db.prepare("UPDATE notice SET state = 'closed', closed_at = ?, closed_by = ? WHERE key = ? AND state = 'open'").run(now, String(by || ''), String(key)).changes > 0; }
  closeId(id, by, now = Date.now()) { return this.db.prepare("UPDATE notice SET state = 'closed', closed_at = ?, closed_by = ? WHERE id = ? AND state = 'open'").run(now, String(by || ''), Number(id) || 0).changes > 0; }
  // Every open notice of one session (optionally only some kinds). -> how many were closed
  closeSession(sessionId, by, kinds, now = Date.now()) {
    if (!sessionId) return 0;
    const k = Array.isArray(kinds) && kinds.length ? ' AND kind IN (' + kinds.map(() => '?').join(',') + ')' : '';
    return this.db.prepare("UPDATE notice SET state = 'closed', closed_at = ?, closed_by = ? WHERE session_id = ? AND state = 'open'" + k).run(now, String(by || ''), String(sessionId), ...(k ? kinds : [])).changes;
  }
  closeKind(kind, by, exceptKeyPrefix, now = Date.now()) {
    return this.db.prepare("UPDATE notice SET state = 'closed', closed_at = ?, closed_by = ? WHERE kind = ? AND state = 'open'" + (exceptKeyPrefix ? ' AND key NOT LIKE ?' : '')).run(now, String(by || ''), String(kind), ...(exceptKeyPrefix ? [exceptKeyPrefix + '%'] : [])).changes;
  }
  openList() { return this.db.prepare("SELECT * FROM notice WHERE state = 'open' ORDER BY opened_at DESC, id DESC").all().map((r) => this._row(r)); }
  closedList(limit = 60) { return this.db.prepare("SELECT * FROM notice WHERE state = 'closed' ORDER BY closed_at DESC, id DESC LIMIT ?").all(Math.min(300, Math.max(1, limit))).map((r) => this._row(r)); }
  openCount() { return this.db.prepare("SELECT count(*) AS n FROM notice WHERE state = 'open'").get().n; }
  prune(now = Date.now()) { return this.db.prepare("DELETE FROM notice WHERE state = 'closed' AND closed_at < ?").run(now - KEEP_CLOSED_MS).changes; }
  clearClosed() { return this.db.prepare("DELETE FROM notice WHERE state = 'closed'").run().changes; }

  // ── events ──
  // A session went from one state to another. s: {sessionId, title}. The states are the board's: idle, busy,
  // background, waiting.
  status(s, from, to, now = Date.now()) {
    const id = s.sessionId, title = String(s.title || '').slice(0, 80);
    if (!id || from === to) return;
    if (from === 'waiting') this.close('waiting:' + id, WORKING(to) ? 'answered' : 'stopped', now);   // it went on: you answered. It did not: that turn was stopped
    if (WORKING(from) && !WORKING(to)) this.close('stuck:' + id, 'moved', now);
    if (WORKING(to)) {                                   // it is at work again: whatever said it had stopped is over
      this.close('done:' + id, 'continued', now);
      this.close('limit:' + id, 'resumed', now);
      this.close('error:' + id, 'resumed', now);
    }
    if (to === 'waiting') { this.close('done:' + id, 'continued', now); if (this.statusNotices) this.open({ kind: 'waiting', sessionId: id, title: '等你回應：' + title, text: '它停下來等你：有動作要你核可，或它在問你問題。' }, now); }
    if (to === 'idle' && WORKING(from) && this.statusNotices) this.open({ kind: 'done', sessionId: id, title: '做完了：' + title, text: '這一輪做完了，還沒看過。' }, now);
  }
  // A session is gone (its process ended and it is not a conversation the board keeps).
  gone(sessionId, now = Date.now()) { return this.closeSession(sessionId, 'ended', null, now); }
  // You opened it on the board.
  seen(sessionId, now = Date.now()) { return this.close('done:' + sessionId, 'seen', now); }

  // The table against the sessions as they are now: closes what no event closed. sessions: the board's list
  // ([{sessionId, status}]). -> how many were closed
  reconcile(sessions, now = Date.now()) {
    const by = new Map((sessions || []).map((s) => [s.sessionId, s.status]));
    let n = 0;
    for (const x of this.openList()) {
      if (!x.sessionId) continue;
      const st = by.get(x.sessionId);
      let why = '';
      if (st === undefined) why = 'ended';
      else if (x.kind === 'waiting' && st !== 'waiting') why = WORKING(st) ? 'answered' : 'stopped';
      else if (x.kind === 'done' && st !== 'idle') why = 'continued';
      else if (x.kind === 'stuck' && !WORKING(st)) why = 'moved';
      else if ((x.kind === 'limit' || x.kind === 'error') && WORKING(st)) why = 'resumed';
      if (why && this.closeId(x.id, why, now)) n++;
    }
    this.prune(now);
    return n;
  }
}

module.exports = { Notices, KEEP_CLOSED_MS };
