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
function pollTeams(inbox, cfg) {
  const dir = cfg.teamsDir || TeamsDb.defaultLevelDbDir();
  if (!TeamsDb.available(dir)) return { source: 'teams', skipped: true, reason: '這台電腦沒有 Teams 桌面版（個人帳戶）的本機資料', ingested: 0 };
  const since = Date.now() - (cfg.teamsDays || 7) * DAY;
  const known = inbox.state('teams:files', {});
  let res;
  try { res = TeamsDb.readTeamsMessages({ dir, sinceMs: since, knownFiles: Object.keys(known).length ? known : null }); }
  catch (e) { return { source: 'teams', error: '讀本機 Teams 資料失敗：' + e.message, ingested: 0 }; }
  const byThread0 = new Map();
  for (const m of res.messages) { if (!byThread0.has(m.threadKey)) byThread0.set(m.threadKey, new Set()); if (m.creator) byThread0.get(m.threadKey).add(m.creator); }
  let self = String(cfg.teamsSelfId || '').trim().replace(/^8:live:/, '');
  let guessed = '';
  if (!self) { guessed = guessTeamsSelf(byThread0) || inbox.state('teams:self', ''); if (guessed) { self = guessed.replace(/^8:(live|orgid):/, ''); inbox.setState('teams:self', guessed); } }
  const byThread = new Map();
  for (const m of res.messages) { if (!m.contentText) continue; if (!byThread.has(m.threadKey)) byThread.set(m.threadKey, []); byThread.get(m.threadKey).push(m); }
  let ingested = 0, failed = 0;
  for (const [key, msgs] of byThread) {
    const threadId = 'teams:' + key;
    // Teams writes new messages first and fills in older history later, so a
    // strict "newer than the last one" would lose what is filled in. Look back
    // three days; a message already taken is recognised by its id.
    const from = Math.max(since, inbox.lastTs(threadId) - 3 * DAY);
    const others = [...new Set(msgs.filter((m) => !(self && (m.creator || '').includes(self)) && m.fromName).map((m) => m.fromName))];
    const oneOnOne = key.replace(/^19:/, '').startsWith('uni01_');
    const title = oneOnOne ? 'Teams · ' + (others[0] || '(對方)') : others.length ? 'Teams 群組 · ' + others.slice(0, 3).join('、') + (others.length > 3 ? ' 等 ' + others.length + ' 人' : '') : 'Teams 群組';
    for (const m of msgs) {
      if (!m.ts || m.ts <= from) continue;
      const mine = !!self && (m.creator || '').includes(self);
      try {
        const r = inbox.ingest({ source: 'teams', threadId, sourceMsgId: 'teams:' + key + ':' + (m.msgId || m.ts), sourceRef: key, from: oneOnOne ? others[0] || '(對方)' : title, msgFrom: m.fromName || '',
          subject: title, bodyText: m.contentText, direction: mine ? 'out' : 'in', quiet: mine, ts: m.ts });
        if (r.ingested) ingested++;
      } catch (e) { failed++; }
    }
  }
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
