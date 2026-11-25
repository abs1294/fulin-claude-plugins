'use strict';
// One source of the inbox. What a source is, for lib/inbox/index.js (see lib/inbox/sources/index.js):
//   id, name       its key ('gmail') and the name people read ('Gmail')
//   kind           'mail': a thread is handed over whole. 'chat': the messages to hand over are ticked.
//   routeHint      what a route of this source is matched on
//   fields         the settings it needs: [{key, label, placeholder, type: text|number|password, min, max, def, secret}]
//   status(svc, s, cfg) -> {configured, ready, text, alarm?, action?, ...}   what the page shows on its card
//   poll(inbox, cfg, fetchImpl) -> {source, ingested, skipped?, reason?, error?, ...}   reads; never writes back
//   done(svc, result), failed(svc, error) -> extra fields of the result   (both optional)
// It is fetched only when the inbox is on AND this source is switched on (settings "<id>On").
//
// The Teams desktop app's local cache on this computer (lib/inbox/teams-localdb.js); every conversation
// found, no route needed. Nothing is asked of any server.
const TeamsDb = require('../teams-localdb');

const DAY = 86400000;
// The reader's version. Raised when what it read before was wrong: the messages kept then are read again (rebuild).
// 2: where a message ends (a time, words and a sender of another one were taken for it), 2026-11-25.
const READER = 2;

// Which account is yours, when nobody said: you are in every conversation of
// your own Teams, each other person in a few. So the sender who appears in the
// most conversations is you - taken only when it is in at least three, and in
// clearly more than anyone else. creatorsByThread: Map of thread -> Set of creator ids.
function guessTeamsSelf(creatorsByThread) {
  const n = new Map();
  for (const set of creatorsByThread.values()) for (const c of set) n.set(c, (n.get(c) || 0) + 1);
  const top = [...n.entries()].sort((a, b) => b[1] - a[1]);
  if (!top.length || top[0][1] < 3) return '';
  if (top[1] && top[1][1] * 2 > top[0][1]) return '';
  return top[0][0];
}
const hasTeams = (inbox) => !!inbox.db.prepare("SELECT 1 AS x FROM inbox_message WHERE thread_id LIKE 'teams:%' LIMIT 1").get();
const oldestTeams = (inbox) => inbox.db.prepare("SELECT min(ts) AS t FROM inbox_message WHERE thread_id LIKE 'teams:%'").get().t || Date.now();
// What was kept by an older reader, of the conversations read again and from the first message read again on: put aside in a
// table of its own (nothing is thrown away), so that the same messages can be kept as they are. What is older stays.
// Within the caller's transaction: put aside and kept again, or neither.
function setAside(inbox, byThread) {
  const db = inbox.db;
  db.exec('CREATE TABLE IF NOT EXISTS inbox_message_teams_old AS SELECT * FROM inbox_message WHERE 0');
  const cols = db.prepare('PRAGMA table_info(inbox_message_teams_old)').all().map((c) => c.name).join(', ');
  for (const [key, msgs] of byThread) {
    let first = Infinity; for (const m of msgs) if (m.ts && m.ts < first) first = m.ts;
    const id = 'teams:' + key; if (!Number.isFinite(first)) continue;
    db.prepare('INSERT INTO inbox_message_teams_old (' + cols + ') SELECT ' + cols + ' FROM inbox_message WHERE thread_id = ? AND ts >= ?').run(id, first);
    db.prepare('DELETE FROM inbox_message WHERE thread_id = ? AND ts >= ?').run(id, first);
  }
}
// ... and what is told of those conversations, from what they hold now: when the other side last spoke; whether that is yours
// to handle is asked again for the ones of the last week. Where they were assigned and what you closed stays.
function settle(inbox, byThread, before, now = Date.now()) {
  const db = inbox.db, cols = new Set(db.prepare('PRAGMA table_info(inbox_thread)').all().map((c) => c.name));
  for (const key of byThread.keys()) {
    const id = 'teams:' + key;
    db.prepare("UPDATE inbox_thread SET last_in_at = (SELECT max(ts) FROM inbox_message WHERE thread_id = ? AND direction = 'in'), last_activity = coalesce((SELECT max(ts) FROM inbox_message WHERE thread_id = ?), last_activity) WHERE thread_id = ?").run(id, id, id);
    // closed before: reading the same messages again does not open it
    const was = before.get(id); if (was && was.status === 'done') db.prepare("UPDATE inbox_thread SET status = 'done' WHERE thread_id = ? AND coalesce(last_in_at, 0) <= ?").run(id, Math.max(was.last_in_at || 0, inbox.state('done:' + id, 0)));
    if (cols.has('triage_upto')) db.prepare('UPDATE inbox_thread SET triage_upto = NULL WHERE thread_id = ? AND last_in_at > ?').run(id, now - 7 * DAY);
    // only your own words are left: there is nothing of the other side's to judge
    if (cols.has('triage')) db.prepare('UPDATE inbox_thread SET triage = NULL, triage_upto = NULL WHERE thread_id = ? AND last_in_at IS NULL').run(id);
  }
}
function pollTeams(inbox, cfg) {
  const dir = cfg.teamsDir || TeamsDb.defaultLevelDbDir();
  if (!TeamsDb.available(dir)) return { source: 'teams', skipped: true, reason: '這台電腦沒有 Teams 桌面版（個人帳戶）的本機資料', ingested: 0 };
  let since = Date.now() - (cfg.teamsDays || 7) * DAY;
  const known = inbox.state('teams:files', {}), old = inbox.state('teams:reader', 1) < READER;
  let again = old && hasTeams(inbox);
  if (old && !again) inbox.setState('teams:reader', READER);    // nothing kept yet: all of it will be this reader's
  const usual = since;
  if (again) since = Math.min(since, oldestTeams(inbox) - 1);   // all of what was kept, as far back as Teams still has it
  let res;
  try { res = TeamsDb.readTeamsMessages({ dir, sinceMs: since, knownFiles: !again && Object.keys(known).length ? known : null }); }
  catch (e) { return { source: 'teams', error: '讀本機 Teams 資料失敗：' + e.message, ingested: 0 }; }
  // A file that could not be read (Teams is writing it): what is in it would be put aside and not kept again. Read as usual
  // this time, all again the next.
  if (again && res.failed) { again = false; since = usual; }
  const byThread0 = new Map();
  for (const m of res.messages) { if (!byThread0.has(m.threadKey)) byThread0.set(m.threadKey, new Set()); if (m.creator) byThread0.get(m.threadKey).add(m.creator); }
  const said = res.messages.find((m) => m.mine === true && m.creator);   // Teams itself says which are yours
  let self = String(cfg.teamsSelfId || '').trim().replace(/^8:live:/, '');
  let guessed = '';
  if (!self) { guessed = (said && said.creator) || guessTeamsSelf(byThread0) || inbox.state('teams:self', ''); if (guessed) { self = guessed.replace(/^8:(live|orgid):/, ''); inbox.setState('teams:self', guessed); } }
  const byThread = new Map();
  for (const m of res.messages) { if (!m.contentText) continue; if (!byThread.has(m.threadKey)) byThread.set(m.threadKey, []); byThread.get(m.threadKey).push(m); }
  const db = inbox.db, edits = inbox.state('teams:edits', {}), fix = db.prepare('UPDATE inbox_message SET body = ? WHERE source_msg_id = ?'), kept = db.prepare('SELECT body, ts, direction FROM inbox_message WHERE source_msg_id = ?');
  // (what it says has changed: judged again, as long as it was changed lately; the judging itself leaves what you closed alone)
  const rejudge = db.prepare('UPDATE inbox_thread SET triage_upto = min(coalesce(triage_upto, 0), ?) WHERE thread_id = ?'), hasUpto = db.prepare('PRAGMA table_info(inbox_thread)').all().some((c) => c.name === 'triage_upto');
  const edit0 = JSON.stringify(edits);
  let ingested = 0, failed = 0;
  // read again: put aside, kept, told - all of it or nothing
  const before = new Map();
  // (a full disk can make the database take the whole transaction back by itself: then the savepoint is gone already)
  const undo = () => { try { db.exec('ROLLBACK TO teams_again'); db.exec('RELEASE teams_again'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} } };
  if (again) {
    for (const r of db.prepare("SELECT thread_id, status, last_in_at FROM inbox_thread WHERE thread_id LIKE 'teams:%'").all()) before.set(r.thread_id, r);
    db.exec('SAVEPOINT teams_again');
    try { setAside(inbox, byThread); } catch (e) { undo(); return { source: 'teams', error: '整理舊的 Teams 訊息失敗：' + e.message, ingested: 0 }; }
  }
  for (const [key, msgs] of byThread) {
    const threadId = 'teams:' + key;
    // Teams writes new messages first and fills in older history later, so a
    // strict "newer than the last one" would lose what is filled in. Look back
    // three days; a message already taken is recognised by its id.
    const from = again ? 0 : Math.max(since, inbox.lastTs(threadId) - 3 * DAY);
    const others = [...new Set(msgs.filter((m) => !(self && (m.creator || '').includes(self)) && m.fromName).map((m) => m.fromName))];
    const oneOnOne = key.replace(/^19:/, '').startsWith('uni01_');
    const title = oneOnOne ? 'Teams · ' + (others[0] || '(對方)') : others.length ? 'Teams 群組 · ' + others.slice(0, 3).join('、') + (others.length > 3 ? ' 等 ' + others.length + ' 人' : '') : 'Teams 群組';
    for (const m of msgs) {
      if (again && failed) break;   // it will all be taken back
      const sid = 'teams:' + key + ':' + (m.msgId || m.ts);
      // Edited since it was kept, however old it is: the same message, with its new words. Told by its version, as an old copy
      // of it may be read later.
      const had = m.clientId && m.ver > (m.ts || 0) ? kept.get(sid) : null;
      if (had) {
        const text = m.contentText.trim().slice(0, inbox.bodyMax);
        if (text && m.ver > (edits[sid] || had.ts)) {
          try {
            if (text !== had.body) { fix.run(text, sid); if (had.direction === 'in' && hasUpto && m.ver > Date.now() - 7 * DAY) rejudge.run(had.ts - 1, threadId); }
            edits[sid] = m.ver;
          } catch (e) { failed++; }
        }
        continue;
      }
      if (!m.ts || m.ts <= from) continue;
      const mine = typeof m.mine === 'boolean' ? m.mine : !!self && (m.creator || '').includes(self);   // Teams itself says which are yours
      try {
        const r = inbox.ingest({ source: 'teams', threadId, sourceMsgId: sid, sourceRef: key, from: oneOnOne ? others[0] || '(對方)' : title, msgFrom: m.fromName || '',
          subject: title, bodyText: m.contentText, direction: mine ? 'out' : 'in', quiet: mine, ts: m.ts });
        if (r.ingested) { ingested++; if (m.clientId && m.ver > m.ts) edits[sid] = m.ver; }
      } catch (e) { failed++; }
    }
  }
  if (again) {
    let bad = failed ? failed + ' 則寫入失敗' : '';
    if (!bad) { try { settle(inbox, byThread, before); inbox.setState('teams:reader', READER); } catch (e) { bad = e.message; } }
    if (!bad) { try { db.exec('RELEASE teams_again'); } catch (e) { bad = e.message; } }
    if (bad) undo();
    if (bad) return { source: 'teams', error: '重讀舊的 Teams 訊息失敗，原本的都還在，下次重試：' + bad, ingested: 0 };
  }
  // (of many, the ones changed last)
  { const all = Object.entries(edits), now = all.length > 5000 ? Object.fromEntries(all.sort((a, b) => b[1] - a[1]).slice(0, 5000)) : edits; if (JSON.stringify(now) !== edit0) inbox.setState('teams:edits', now); }
  // A file is marked as read only when everything from it went in: a table file never changes again, so marking it early would lose its messages for good.
  if (!failed && res.files.length) inbox.setState('teams:files', Object.fromEntries(res.files.map((f) => [f.fname, { size: f.size, mtime: f.mtime }])));
  return Object.assign({ source: 'teams', ingested, threads: byThread.size, selfKnown: !!self, selfGuessed: guessed || undefined }, failed ? { error: failed + ' 則寫入失敗，下次重試' } : {});
}

module.exports = {
  id: 'teams', name: 'Teams', kind: 'chat',
  routeHint: '對話編號（Teams 會抓所有對話，路由只決定分派）',
  fields: [
    { key: 'teamsSelfId', label: '你的 Teams 編號', placeholder: '用來分辨哪些話是你說的', type: 'text', def: '' },
    { key: 'teamsDays', label: 'Teams 往回幾天', placeholder: '', type: 'number', min: 1, max: 90, def: 7 },
  ],
  status(svc, s) {
    const configured = TeamsDb.available(), selfKnown = !!(s.teamsSelfId || svc.inbox.state('teams:self', ''));
    return { configured, ready: configured, selfKnown, selfGuessed: !s.teamsSelfId && !!svc.inbox.state('teams:self', ''),
      text: !configured ? '這台電腦沒有 Teams 桌面版（個人帳戶）的本機資料' : '讀這台電腦上 Teams 桌面版的紀錄' + (selfKnown ? '' : ' · 沒設定你自己的編號，你說的話會被當成對方說的') };
  },
  poll: (inbox, cfg) => pollTeams(inbox, cfg),
  pollTeams, guessTeamsSelf,
};
