'use strict';
// The inbox: messages fetched from Gmail, Slack and Teams, kept as threads in
// the board's database, and dispatched (given a customer, a system and a
// working folder) by a table of routes. Ported from customer-hub
// (src/ingest.js, src/routes-store.js); what happens after dispatch - drafting
// a reply, sending it - is not done here.
//
//   inbox_route    (source, source_ref) -> label, customer, system, root_folder
//                  source_ref is what a message carries that a route can match:
//                  a Gmail label name, a Slack channel id, a Teams thread key.
//   inbox_thread   one conversation. status: new (nobody decided where it
//                  goes) -> routed (it has a folder) -> done (you closed it).
//                  A new incoming message reopens a done thread.
//   inbox_message  one message; source_msg_id is unique, which is what makes
//                  fetching the same thing twice harmless.
//   inbox_state    what each fetcher needs to remember between runs.
const DB = require('../db');

const Sources = require('./sources');
const SOURCES = Sources.ids;   // the sources there are: lib/inbox/sources/index.js
const BODY_MAX = 200000;

function open(file) {
  const db = DB.open(file);
  if (!db.__inbox) {
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_route (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_ref TEXT NOT NULL, label TEXT, customer TEXT, system TEXT, root_folder TEXT, enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(source, source_ref))`);
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_thread (thread_id TEXT PRIMARY KEY, source TEXT NOT NULL, sender TEXT, subject TEXT, status TEXT NOT NULL DEFAULT 'new', root_folder TEXT, customer TEXT, system TEXT, label TEXT, source_ref TEXT, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, last_in_at INTEGER, seen_at INTEGER)`);
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_message (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, source_msg_id TEXT NOT NULL UNIQUE, direction TEXT NOT NULL, author TEXT NOT NULL, sender TEXT, body TEXT NOT NULL, ts INTEGER NOT NULL, fetched_at INTEGER NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS inbox_message_thread ON inbox_message (thread_id, ts)`);
    // What triage (lib/inbox/triage.js) found: triage = todo | question | fyi | noise, a short title, one line
    // of what is wanted, when, and up to which incoming message it has looked (triage_upto).
    const cols = new Set(db.prepare('PRAGMA table_info(inbox_thread)').all().map((c) => c.name));
    for (const [name, type] of [['triage', 'TEXT'], ['triage_conf', 'INTEGER'], ['triage_title', 'TEXT'], ['triage_summary', 'TEXT'], ['triaged_at', 'INTEGER'], ['triage_upto', 'INTEGER']]) if (!cols.has(name)) db.exec('ALTER TABLE inbox_thread ADD COLUMN ' + name + ' ' + type);
    // Who each message went to (asked 2026-11-20: "they wrote to me - tell apart what was sent to me from what was
    // forwarded"): rcpt = {to: [...], cc: [...]} addresses as JSON ({gone: 1}: Gmail no longer has the message, so it
    // never will be known); me_role = to | cc | other (you were neither: a list, a blind copy) | NULL not known (fetched
    // before this was kept, or from a source that does not say); fwd = 1 when the message is a forward; rcpt_addrs = the
    // addresses alone, space-separated, what search looks in (the JSON would match "to", "cc", quotes).
    const mcols = new Set(db.prepare('PRAGMA table_info(inbox_message)').all().map((c) => c.name));
    for (const [name, type] of [['rcpt', 'TEXT'], ['me_role', 'TEXT'], ['fwd', 'INTEGER'], ['rcpt_addrs', 'TEXT']]) if (!mcols.has(name)) db.exec('ALTER TABLE inbox_message ADD COLUMN ' + name + ' ' + type);
    // filled in before rcpt_addrs was kept: made from the JSON, once
    for (const r of db.prepare("SELECT id, rcpt FROM inbox_message WHERE rcpt IS NOT NULL AND rcpt_addrs IS NULL").all()) {
      let j = {}; try { j = JSON.parse(r.rcpt); } catch (e) {}
      db.prepare('UPDATE inbox_message SET rcpt_addrs = ? WHERE id = ?').run([].concat(j.to || [], j.cc || []).join(' '), r.id);
    }
    // Judged before judgements came with "how sure" (triage_conf): judged again, once.
    db.exec('UPDATE inbox_thread SET triage_upto = NULL WHERE triage IS NOT NULL AND triage_conf IS NULL');
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.__inbox = true;
  }
  return db;
}

class Inbox {
  constructor(file) { this.file = file; }
  get db() { return open(this.file); }

  // ── routes ──
  routes(onlyEnabled) { return this.db.prepare('SELECT * FROM inbox_route' + (onlyEnabled ? ' WHERE enabled = 1' : '') + ' ORDER BY source, customer, system, source_ref').all(); }
  enabledRefs(source) { return this.db.prepare('SELECT source_ref FROM inbox_route WHERE enabled = 1 AND source = ?').all(source).map((r) => r.source_ref); }
  // The route for a message that carries these refs. The longest (most specific)
  // ref wins, then alphabetical: the same input always gives the same route.
  matchRoute(source, refs) {
    const list = (refs || []).filter(Boolean);
    if (!list.length) return null;
    return this.db.prepare(`SELECT * FROM inbox_route WHERE enabled = 1 AND source = ? AND source_ref IN (${list.map(() => '?').join(',')}) ORDER BY length(source_ref) DESC, source_ref ASC, id ASC LIMIT 1`).get(source, ...list) || null;
  }
  saveRoute(r) {
    const source = String(r.source || ''), ref = String(r.source_ref || '').trim();
    if (!SOURCES.includes(source)) return { ok: false, error: '來源只能是 ' + Sources.list.map((x) => x.name).join('、') + ' 其中一個' };
    if (!ref) return { ok: false, error: '請填這個來源用來比對的值：' + Sources.byId(source).routeHint };
    const s = (v) => { const t = String(v == null ? '' : v).trim(); return t || null; };
    this.db.prepare(`INSERT INTO inbox_route (source, source_ref, label, customer, system, root_folder, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_ref) DO UPDATE SET label = excluded.label, customer = excluded.customer, system = excluded.system, root_folder = excluded.root_folder, enabled = excluded.enabled`)
      .run(source, ref, s(r.label) || ref, s(r.customer), s(r.system), s(r.root_folder), r.enabled === false ? 0 : 1);
    return { ok: true };
  }
  deleteRoute(id) { return this.db.prepare('DELETE FROM inbox_route WHERE id = ?').run(Number(id)).changes > 0; }

  // ── state ──
  state(key, fallback) { const r = this.db.prepare('SELECT value FROM inbox_state WHERE key = ?').get(key); try { return r ? JSON.parse(r.value) : fallback; } catch (e) { return fallback; } }
  setState(key, v) { this.db.prepare('INSERT INTO inbox_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(v)); }

  has(sourceMsgId) { return !!this.db.prepare('SELECT 1 AS x FROM inbox_message WHERE source_msg_id = ?').get(sourceMsgId); }
  lastTs(threadId) { const r = this.db.prepare('SELECT max(ts) AS t FROM inbox_message WHERE thread_id = ?').get(threadId); return (r && r.t) || 0; }

  // One message in. Returns {ingested, reactivated, routed, threadId}.
  //   o: {source, threadId, sourceMsgId, sourceRef?, refs?, from, subject?, bodyText, direction?, author?, ts}
  //   quiet: a message of your own, added for context - it does not reopen or route the thread.
  ingest(o) {
    if (!SOURCES.includes(o.source) || !o.threadId || !o.sourceMsgId) throw new Error('ingest: source, threadId and sourceMsgId are required');
    const body = String(o.bodyText || '').trim();
    if (!body || this.has(o.sourceMsgId)) return { ingested: false };
    const db = this.db, now = Date.now(), ts = Number(o.ts) || now;
    const direction = o.direction === 'out' ? 'out' : 'in';
    const route = o.quiet ? null : this.matchRoute(o.source, o.refs || (o.sourceRef ? [o.sourceRef] : []));
    const prev = db.prepare('SELECT status, root_folder FROM inbox_thread WHERE thread_id = ?').get(o.threadId);
    let reactivated = false, routed = false;
    db.exec('BEGIN');
    try {
      if (!prev) db.prepare('INSERT INTO inbox_thread (thread_id, source, sender, subject, status, source_ref, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(o.threadId, o.source, String(o.from || ''), String(o.subject || ''), 'new', o.sourceRef || null, now, ts);
      // An existing thread keeps its folder and status; only what describes it is refreshed.
      else if (!o.quiet && direction === 'in') db.prepare("UPDATE inbox_thread SET sender = CASE WHEN ? <> '' THEN ? ELSE sender END, subject = CASE WHEN ? <> '' THEN ? ELSE subject END WHERE thread_id = ?")
        .run(String(o.from || ''), String(o.from || ''), String(o.subject || ''), String(o.subject || ''), o.threadId);
      if (route) {
        db.prepare('UPDATE inbox_thread SET customer = ?, system = ?, label = ?, source_ref = ? WHERE thread_id = ?').run(route.customer, route.system, route.label, route.source_ref, o.threadId);
        if (route.root_folder && !(prev && prev.root_folder)) {
          routed = db.prepare("UPDATE inbox_thread SET root_folder = ?, status = 'routed' WHERE thread_id = ? AND status IN ('new', 'routed')").run(route.root_folder, o.threadId).changes > 0;
        }
      }
      const r = rcptOf(o);
      db.prepare('INSERT INTO inbox_message (thread_id, source_msg_id, direction, author, sender, body, ts, fetched_at, rcpt, me_role, fwd, rcpt_addrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(o.threadId, o.sourceMsgId, direction, o.author || (direction === 'out' ? 'human' : 'customer'), String(o.msgFrom || o.from || ''), body.slice(0, BODY_MAX), ts, now, r.rcpt, r.role, r.fwd, r.addrs);
      db.prepare('UPDATE inbox_thread SET last_activity = max(last_activity, ?) WHERE thread_id = ?').run(ts, o.threadId);
      if (direction === 'in' && !o.quiet) {
        db.prepare('UPDATE inbox_thread SET last_in_at = max(coalesce(last_in_at, 0), ?) WHERE thread_id = ?').run(ts, o.threadId);
        // Something new from the other side on a thread you had closed: it is yours to look at again.
        if (prev && prev.status === 'done' && ts > (this.state('done:' + o.threadId, 0))) {
          reactivated = db.prepare("UPDATE inbox_thread SET status = CASE WHEN root_folder IS NULL THEN 'new' ELSE 'routed' END WHERE thread_id = ?").run(o.threadId).changes > 0;
        }
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; }
    return { ingested: true, reactivated, routed, threadId: o.threadId };
  }

  // Who a message already kept went to, learnt later (mail fetched before this was kept). -> whether it changed
  // Only a message not filled in yet: one fetched with its text knows more (a forward told from its text) than the headers
  // asked for later (review 2026-11-20: a forward was made "not a forward" again)
  setRecipients(sourceMsgId, o) { const r = rcptOf(o); if (!r.rcpt) return false; return this.db.prepare('UPDATE inbox_message SET rcpt = ?, me_role = ?, fwd = ?, rcpt_addrs = ? WHERE source_msg_id = ? AND rcpt IS NULL').run(r.rcpt, r.role, r.fwd, r.addrs, sourceMsgId).changes > 0; }
  // The messages of a thread still not filled in after asking for it (Gmail no longer has them): not asked again
  recipientsGone(threadId) { return this.db.prepare(`UPDATE inbox_message SET rcpt = '{"gone":1}', rcpt_addrs = '' WHERE thread_id = ? AND rcpt IS NULL`).run(threadId).changes; }
  // The threads of a source with messages kept without who they went to, newest first, at most `limit` (their ids as the
  // source has them). Asked of the database, not of what a fetch listed: a fetch lists only what is new since the last
  // one, and an older thread would never be filled in (seen 2026-11-20: 20 messages filled, the thread asked about not).
  threadsWithoutRecipients(source, limit = 100) {
    return this.db.prepare(`SELECT m.thread_id AS id, max(m.ts) AS t FROM inbox_message m WHERE m.rcpt IS NULL AND m.thread_id LIKE ? GROUP BY m.thread_id ORDER BY t DESC LIMIT ?`)
      .all(source + ':%', limit).map((x) => x.id.slice(source.length + 1));
  }

  // ── reading ──
  // o: {status?, source?, q?, limit?} -> threads, newest activity first, each with its message count and latest incoming line.
  threads(o = {}) {
    const where = [], args = [];
    if (o.status) { where.push('t.status = ?'); args.push(o.status); }
    if (o.source) { where.push('t.source = ?'); args.push(o.source); }
    // valid: yours to handle. invalid: judged, and not. pending: nothing judged yet, or something newer than the judgement.
    if (o.triage === 'valid') where.push("t.triage IN ('todo', 'question')");
    else if (o.triage === 'invalid') where.push("t.triage IN ('fyi', 'noise')");
    else if (o.triage === 'pending') where.push('t.triage IS NULL');
    if (o.open) where.push("t.status <> 'done'");
    // also the triage's title and line: the list shows that title, so a word seen there has to find it (2026-11-20)
    // What is typed is looked for as it is: % _ \ are escaped, not made spaces (2026-11-20: 「tina_chao」 found nothing - it was
    // looked for as 「tina chao」); and who sent each message of the thread too, not only who started it.
    if (o.q) { const E = " ESCAPE '\\'"; where.push('(t.subject LIKE ?' + E + ' OR t.sender LIKE ?' + E + ' OR t.customer LIKE ?' + E + ' OR t.triage_title LIKE ?' + E + ' OR t.triage_summary LIKE ?' + E + ' OR EXISTS (SELECT 1 FROM inbox_message m WHERE m.thread_id = t.thread_id AND (m.body LIKE ?' + E + ' OR m.sender LIKE ?' + E + ' OR m.rcpt_addrs LIKE ?' + E + ')))'); const like = '%' + likeEsc(o.q) + '%'; args.push(like, like, like, like, like, like, like, like); }
    return this.db.prepare(`SELECT t.*, (SELECT count(*) FROM inbox_message m WHERE m.thread_id = t.thread_id) AS messages,
        (SELECT substr(m.body, 1, 160) FROM inbox_message m WHERE m.thread_id = t.thread_id ORDER BY m.ts DESC LIMIT 1) AS latest,
        CASE WHEN t.last_in_at IS NOT NULL AND t.last_in_at > coalesce(t.seen_at, 0) THEN 1 ELSE 0 END AS unread
      FROM inbox_thread t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.last_activity DESC LIMIT ?`)   /* newest first on every tab (asked 2026-11-19: ordering by how sure the triage was put an 11/10 thread above an 11/18 one) */.all(...args, Math.min(Number(o.limit) || 100, 500));
  }
  counts() {
    const out = { new: 0, routed: 0, done: 0, unread: 0, bySource: {}, valid: 0, invalid: 0, pending: 0 };
    for (const r of this.db.prepare("SELECT triage, count(*) AS n FROM inbox_thread WHERE status <> 'done' GROUP BY triage").all()) {
      if (r.triage === 'todo' || r.triage === 'question') out.valid += r.n; else if (r.triage === 'fyi' || r.triage === 'noise') out.invalid += r.n; else out.pending += r.n;
    }
    for (const r of this.db.prepare('SELECT status, source, count(*) AS n, sum(CASE WHEN last_in_at IS NOT NULL AND last_in_at > coalesce(seen_at, 0) THEN 1 ELSE 0 END) AS u FROM inbox_thread GROUP BY status, source').all()) {
      out[r.status] = (out[r.status] || 0) + r.n;
      if (r.status !== 'done') out.unread += r.u || 0;
      out.bySource[r.source] = (out.bySource[r.source] || 0) + r.n;
    }
    return out;
  }
  thread(id) {
    const t = this.db.prepare('SELECT * FROM inbox_thread WHERE thread_id = ?').get(id);
    if (!t) return null;
    t.items = this.db.prepare('SELECT id, source_msg_id, direction, author, sender, body, ts, rcpt, me_role, fwd FROM inbox_message WHERE thread_id = ? ORDER BY ts ASC, id ASC').all(id);
    return t;
  }
  markSeen(id, now = Date.now()) { this.db.prepare('UPDATE inbox_thread SET seen_at = ? WHERE thread_id = ?').run(now, id); }

  // ── dispatch by hand ──
  // folder: an existing folder (checked by the caller), or '' to take the thread back to "new".
  assign(id, folder) {
    const r = folder
      ? this.db.prepare("UPDATE inbox_thread SET root_folder = ?, status = CASE WHEN status = 'done' THEN 'done' ELSE 'routed' END WHERE thread_id = ?").run(folder, id)
      : this.db.prepare("UPDATE inbox_thread SET root_folder = NULL, status = CASE WHEN status = 'done' THEN 'done' ELSE 'new' END WHERE thread_id = ?").run(id);
    return r.changes > 0;
  }
  setDone(id, done, now = Date.now()) {
    const r = done
      ? this.db.prepare("UPDATE inbox_thread SET status = 'done' WHERE thread_id = ?").run(id)
      : this.db.prepare("UPDATE inbox_thread SET status = CASE WHEN root_folder IS NULL THEN 'new' ELSE 'routed' END WHERE thread_id = ?").run(id);
    if (r.changes && done) this.setState('done:' + id, now);
    return r.changes > 0;
  }
}

// What ingest() and setRecipients() keep of who a message went to: o.to and o.cc (address lists), o.meRole (to | cc |
// other), o.forwarded. Nothing given (Teams, Slack, a test): nothing kept - not known, rather than "not to you".
function rcptOf(o) {
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).slice(0, 100) : null);
  const to = list(o.to), cc = list(o.cc);
  if (!to && !cc) return { rcpt: null, role: null, fwd: null, addrs: null };
  return { rcpt: JSON.stringify({ to: to || [], cc: cc || [] }), role: ['to', 'cc', 'other'].includes(o.meRole) ? o.meRole : 'other', fwd: o.forwarded ? 1 : 0, addrs: [].concat(to || [], cc || []).join(' ') };
}

// Text to look for with LIKE … ESCAPE '\': its own % _ and \ stand for themselves
function likeEsc(s) { return String(s).replace(/[\\%_]/g, (c) => '\\' + c); }

module.exports = { Inbox, SOURCES, likeEsc };
