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
// Slack's HTTP interface with a bot token; the channels of the enabled Slack routes.
const DAY = 86400000;

async function pollSlack(inbox, cfg, fetchImpl = fetch) {
  const token = String(cfg.slackToken || '').trim();
  if (!token) return { source: 'slack', skipped: true, reason: '還沒有設定 Slack 權杖', ingested: 0 };
  const channels = inbox.enabledRefs('slack');
  if (!channels.length) return { source: 'slack', skipped: true, reason: '還沒有任何 Slack 路由（要抓哪個頻道）', ingested: 0 };
  const api = async (method, params) => {
    const url = new URL('https://slack.com/api/' + method);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const j = await (await fetchImpl(url.toString(), { headers: { authorization: 'Bearer ' + token } })).json();
    if (!j.ok) throw new Error('Slack ' + method + ' 失敗：' + (j.error || 'unknown'));
    return j;
  };
  const self = String(cfg.slackSelfId || '').trim();
  const oldest = Math.floor((Date.now() - (cfg.slackDays || 7) * DAY) / 1000);
  const take = (channel, m) => {
    if (!m.text || !m.text.trim()) return false;
    const mine = !!self && m.user === self;
    return inbox.ingest({ source: 'slack', threadId: 'slack:' + channel + ':' + (m.thread_ts || m.ts), sourceMsgId: 'slack:' + channel + ':' + m.ts, sourceRef: channel,
      from: m.user || (mine ? '(我)' : '(對方)'), subject: 'Slack · ' + channel, bodyText: m.text, direction: mine ? 'out' : 'in', quiet: mine, ts: Math.floor(Number(m.ts) * 1000) }).ingested;
  };
  let ingested = 0;
  const errors = [];
  for (const ch of channels) {
    try {
      const roots = [];
      let cursor;
      for (let page = 0; page < 50; page++) {
        const r = await api('conversations.history', { channel: ch, oldest, limit: 200, cursor });
        const msgs = (r.messages || []).filter((m) => m.type === 'message' && (!m.subtype || m.subtype === 'thread_broadcast')).reverse();
        for (const m of msgs) { if (m.reply_count > 0 && m.thread_ts) roots.push(m.thread_ts); if (take(ch, m)) ingested++; }
        cursor = r.response_metadata && r.response_metadata.next_cursor;
        if (!r.has_more || !cursor) break;
      }
      // conversations.history does not return the replies of a thread: they are asked for per thread.
      for (const root of roots) {
        let rc;
        for (let page = 0; page < 20; page++) {
          const r = await api('conversations.replies', { channel: ch, ts: root, limit: 200, cursor: rc });
          for (const m of (r.messages || []).filter((x) => x.type === 'message' && x.ts !== root)) if (take(ch, m)) ingested++;
          rc = r.response_metadata && r.response_metadata.next_cursor;
          if (!r.has_more || !rc) break;
        }
      }
    } catch (e) { errors.push(ch + '：' + e.message); }
  }
  return Object.assign({ source: 'slack', ingested, channels: channels.length }, errors.length ? { error: errors.join('；') } : {});
}

module.exports = {
  id: 'slack', name: 'Slack', kind: 'chat',
  routeHint: '頻道編號（例如 C0123ABCD，機器人要先加入那個頻道）',
  fields: [
    { key: 'slackToken', label: 'Slack 機器人權杖', placeholder: 'xoxb-…', type: 'password', def: '', secret: true },
    { key: 'slackSelfId', label: '你的 Slack 編號', placeholder: '例如 U0123ABCD', type: 'text', def: '' },
    { key: 'slackDays', label: 'Slack 往回幾天', placeholder: '', type: 'number', min: 1, max: 90, def: 7 },
  ],
  status(svc, s) {
    const configured = !!s.slackToken, routes = svc.inbox.enabledRefs('slack').length;
    return { configured, ready: configured && routes > 0, text: !configured ? '還沒有設定權杖（在「抓取設定」填）' : !routes ? '還沒有任何 Slack 路由（要抓哪個頻道）' : routes + ' 個頻道' };
  },
  poll: (inbox, cfg, fetchImpl) => pollSlack(inbox, cfg, fetchImpl),
  pollSlack,
};
