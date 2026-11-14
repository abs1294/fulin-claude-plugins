'use strict';
// The three fetchers. Each one reads its source, turns what it finds into the
// same shape, and hands it to Inbox.ingest; none of them writes anything back
// to its source. Ported from customer-hub (src/gmail-poll.js, src/pollers/*).
//
//   gmail  Gmail's HTTP interface, with the OAuth client and token customer-hub
//          already has in ~/.customer-hub (read from there, never rewritten).
//          Fetches the threads under the labels of the enabled Gmail routes.
//   slack  Slack's HTTP interface with a bot token; the channels of the
//          enabled Slack routes.
//   teams  the Teams desktop app's local cache (lib/inbox/teams-localdb.js);
//          every conversation found, no route needed.
//
// cfg: what lib/inbox/index.js builds from the settings. fetchImpl can be
// replaced in tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { htmlToText } = require('./text');
const TeamsDb = require('./teams-localdb');

const DAY = 86400000;

// ── Gmail ──
// credFile: the OAuth client file; where it is looked for is decided in lib/inbox/index.js (credFile()).
function gmailSecrets(dir, tokenFile, credFile) {
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  const cred = read(credFile || path.join(dir, 'credentials.json')), tok = read(tokenFile || path.join(dir, 'token.json'));
  const c = cred.installed || cred.web || cred;
  const out = { clientId: tok.client_id || c.client_id, clientSecret: tok.client_secret || c.client_secret, refreshToken: tok.refresh_token };
  if (!out.clientId || !out.clientSecret || !out.refreshToken) throw new Error('credentials.json 或 token.json 缺少必要欄位');
  return out;
}
function gmailConfigured(cfg) { try { gmailSecrets(cfg.gmailSecretDir, cfg.gmailTokenFile, cfg.gmailCredFile); return true; } catch (e) { return false; } }

// Gmail's own labels (INBOX, UNREAD, CATEGORY_PROMOTIONS, …): not something a person tagged a mail with.
const SYSTEM_LABEL = /^(INBOX|UNREAD|IMPORTANT|STARRED|SENT|DRAFT|SPAM|TRASH|CHAT|CATEGORY_[A-Z]+|YELLOW_STAR|[A-Z_]+_STAR)$/;
class ReauthError extends Error {}
async function gmailToken(cfg, fetchImpl) {
  const s = gmailSecrets(cfg.gmailSecretDir, cfg.gmailTokenFile, cfg.gmailCredFile);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken, grant_type: 'refresh_token' }).toString() });
  const j = await res.json().catch(() => ({}));
  if (j.error === 'invalid_grant') throw new ReauthError('Gmail 授權已失效（invalid_grant），需要重新授權');
  if (!j.access_token) throw new Error('換不到 Gmail 存取權杖：' + (j.error_description || j.error || 'HTTP ' + res.status));
  return j.access_token;
}

function walkParts(part, acc = []) {
  if (!part) return acc;
  if (Array.isArray(part.parts) && part.parts.length) for (const p of part.parts) walkParts(p, acc);
  else acc.push(part);
  return acc;
}
// The text of a mail: its text/plain part, else its text/html part turned into
// text. The whole quoted history is kept (a forward that adds one line is
// meaningless without it). A part says which character set its bytes are in.
const partText = (l) => {
    const bytes = Buffer.from(l.body.data, 'base64url');
    const ct = ((l.headers || []).find((h) => String(h.name).toLowerCase() === 'content-type') || {}).value || '';
    const cs = (/charset\s*=\s*"?([\w.:-]+)/i.exec(ct) || [])[1];
    // UTF-8 first, whatever the part declares: Gmail usually hands the text over already converted to UTF-8
    // while the header still names the original character set (measured 2026-11-14: 40 of 41 parts declared
    // big5 were valid UTF-8, and decoding them as big5 garbled them). Only bytes that are not valid UTF-8
    // are read in the declared set; of two imperfect readings the one with fewer broken characters is kept.
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) {}
    const loose = bytes.toString('utf8');
    if (!cs || /^utf-?8$/i.test(cs)) return loose;
    let declared; try { declared = new TextDecoder(cs).decode(bytes); } catch (e) { return loose; }
    const broken = (x) => (x.match(/\uFFFD/g) || []).length;
    return broken(declared) <= broken(loose) ? declared : loose;
};
function gmailBody(payload, maxLen = 20000) {
  const leaves = walkParts(payload).filter((l) => l.body && l.body.data);
  const pick = (type) => leaves.find((l) => l.mimeType === type);
  const decode = partText;
  const plain = pick('text/plain'), html = pick('text/html');
  const text = (plain ? decode(plain) : html ? htmlToText(decode(html)) : '').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
// The files attached to the mails of a thread, saved under destDir so that a conversation on this computer
// can read them. Fetched when a mail is handed over, not when it is polled: most mail is never handed over.
// Pictures embedded in the text (a screenshot pasted into the mail - or the logo in a signature) are not
// downloaded here: they are listed in the order the mail shows them, with where each would be saved, and
// download(list) fetches the ones the caller turns out to need (those whose place in the text survives).
// -> {files: [{messageId, name, path, size, mime, ts}], skipped: [{name, why}], inline: [{messageId, cid, name, path, size}], download}
const ATT = { each: 25 * 1024 * 1024, total: 80 * 1024 * 1024, count: 20 };
const idTail = (id) => String(id || '').replace(/[^0-9a-z]/gi, '').slice(-6) || 'msg';   // part of a file name: letters and digits only, whatever the server sent
// A file name out of a name somebody else chose: every character that cannot be in a Windows file name, or that
// separates folders, becomes "_" - control characters (below 32), backslash (92), slash (47), and < > : " | ? *.
// Then no dots or spaces at either end, at most 120 characters. Written with character codes so that it reads the same everywhere.
const BAD_NAME_CODES = new Set([92, 47, 60, 62, 58, 34, 124, 63, 42]);
const safeName = (n) => ([...String(n || '')].map((ch) => { const c = ch.codePointAt(0); return c < 32 || BAD_NAME_CODES.has(c) ? '_' : ch; }).join('').replace(/^[.\s]+|[.\s]+$/g, '').slice(-120) || 'attachment');
async function gmailAttachments(cfg, threadId, destDir, fetchImpl = fetch) {
  const tid = String(threadId).replace(/^gmail:/, '');
  if (!/^[0-9a-f]{6,32}$/i.test(tid)) throw new Error('不是 Gmail 的討論串編號');
  const token = await gmailToken(cfg, fetchImpl);
  const get = async (p) => {
    const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/' + p, { headers: { authorization: 'Bearer ' + token } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Gmail 讀取失敗：' + ((j.error && j.error.message) || 'HTTP ' + res.status));
    return j;
  };
  const th = await get('threads/' + tid + '?format=full');
  const out = { files: [], skipped: [], inline: [] };
  const save = async (messageId, attachmentId, file, size) => {
    let have = false; try { have = fs.statSync(file).size === size && size > 0; } catch (e) {}
    if (have) return true;
    const a = await get('messages/' + messageId + '/attachments/' + attachmentId);
    if (typeof a.data !== 'string') return false;   // an empty string is an empty file, which is a file
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(a.data, 'base64url'));
    // Marked as coming from the internet, the way a browser marks a download: Office then opens it in Protected View.
    try { fs.writeFileSync(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n'); } catch (e) {}
    return true;
  };
  out.download = async (list) => { let n = 0; for (const x of list || []) if (x.size <= ATT.each && await save(x.messageId, x.attachmentId, x.path, x.size)) n++; return n; };
  const dir = path.join(destDir, tid);
  const taken = new Set();   // paths given out in this run, lower case (Windows file names ignore case)
  let total = 0;
  for (const m of th.messages || []) {
    if ((m.labelIds || []).includes('DRAFT')) continue;
    // The order in which the mail's own text shows its embedded pictures: the order of <img src="cid:…"> in the HTML part.
    const leaves = walkParts(m.payload);
    const htmlPart = leaves.find((l) => l.mimeType === 'text/html' && l.body && l.body.data);
    const order = []; if (htmlPart) { const re = /<img\b[^>]*?\bsrc\s*=\s*["']?cid:([^"'\s>]+)/gi; let k; const html = partText(htmlPart); while ((k = re.exec(html))) if (!order.includes(k[1])) order.push(k[1]); }
    const embedded = [];
    for (const p of leaves) {
      if (!p.body || !p.body.attachmentId) continue;
      { const hh = (n) => ((p.headers || []).find((x) => String(x.name).toLowerCase() === n) || {}).value || '';
        const cid = hh('content-id').replace(/^<|>$/g, '');
        if (/^image\//i.test(p.mimeType || '') && cid && !/^\s*attachment/i.test(hh('content-disposition'))) {
          const ext = (/\.[A-Za-z0-9]{2,5}$/.exec(p.filename || '') || ['.' + String(p.mimeType).split('/')[1].replace(/[^a-z0-9]/gi, '').slice(0, 5)])[0];
          embedded.push({ messageId: m.id, attachmentId: p.body.attachmentId, cid, name: safeName(p.filename || 'image' + ext), size: Number(p.body.size) || 0, ext });
          continue;
        } }
      if (!p.filename) continue;
      const h = (n) => ((p.headers || []).find((x) => String(x.name).toLowerCase() === n) || {}).value || '';
      const size = Number(p.body.size) || 0, name = safeName(p.filename);
      if (size > ATT.each) { out.skipped.push({ name, why: '太大（' + Math.round(size / 1048576) + ' MB）' }); continue; }
      if (out.files.length >= ATT.count || total + size > ATT.total) { out.skipped.push({ name, why: '這串的附檔太多，超過一次帶入的上限' }); continue; }
      // One file per attachment: two attachments of a mail may carry the same name (image.png twice), or the same
      // name once cleaned. The second gets "-2" before its extension, and so on - the same every time, since
      // the parts always come in the same order.
      let file = path.join(dir, idTail(m.id) + '-' + name);
      for (let k = 2; taken.has(file.toLowerCase()); k++) { const e = path.extname(name); file = path.join(dir, idTail(m.id) + '-' + name.slice(0, name.length - e.length) + '-' + k + e); }
      taken.add(file.toLowerCase());
      if (!(await save(m.id, p.body.attachmentId, file, size))) { out.skipped.push({ name, why: 'Gmail 沒有給內容' }); continue; }
      total += size;
      out.files.push({ messageId: m.id, name, path: file, size, mime: p.mimeType || '', ts: Number(m.internalDate) || 0 });
    }
    // as the text shows them; a picture the HTML does not point at comes last
    embedded.sort((x, y) => ((order.indexOf(x.cid) + 1) || 999) - ((order.indexOf(y.cid) + 1) || 999));
    embedded.forEach((x, i) => {
      let file = path.join(dir, idTail(m.id) + '-圖' + (i + 1) + x.ext);
      for (let k = 2; taken.has(file.toLowerCase()); k++) file = path.join(dir, idTail(m.id) + '-圖' + (i + 1) + '-' + k + x.ext);   // an attachment may already be called that
      taken.add(file.toLowerCase()); x.path = file; out.inline.push(x);
    });
  }
  return out;
}
const header = (m, name) => (((m.payload && m.payload.headers) || []).find((h) => String(h.name).toLowerCase() === name) || {}).value || '';

async function pollGmail(inbox, cfg, fetchImpl = fetch) {
  if (!gmailConfigured(cfg)) return { source: 'gmail', skipped: true, reason: '還沒有連接 Gmail', ingested: 0 };
  // Which mail: all of it that was received, unless the settings name one label to keep to (gmailLabel).
  // Labels are otherwise only what routes match on to dispatch a thread - they no longer decide what is
  // fetched (the user's call, 2026-11-13: "read all of it, do not narrow by tag"). Sent mail, drafts, spam,
  // the bin and chat transcripts are left out; promotions and the like are not: sorting those out is triage's job.
  const only = String(cfg.gmailLabel || '').trim();
  const token = await gmailToken(cfg, fetchImpl);
  const api = async (p, params) => {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/' + p);
    for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url.toString(), { headers: { authorization: 'Bearer ' + token } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Gmail ' + p.split('/')[0] + ' 失敗：' + ((j.error && j.error.message) || 'HTTP ' + res.status));
    return j;
  };
  const byName = {}, byId = {};
  for (const l of (await api('labels')).labels || []) { byName[l.name] = l.id; byId[l.id] = l.name; }
  if (only && !byName[only]) return { source: 'gmail', skipped: true, reason: 'Gmail 裡沒有「' + only + '」這個標籤（抓取設定裡指定只抓它）', ingested: 0 };
  const esc = (n) => n.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const valid = only ? [only] : [];
  // Only what is new. The first fetch goes gmailDays back; every later one asks only for mail since the
  // last fetch that succeeded (a day's overlap, for mail that arrives late or out of order - a message
  // already taken is recognised by its id). Asked afresh from gmailDays back when the scope changes or
  // the window is made longer.
  const days = cfg.gmailDays || 7, scope = only ? 'label:' + only : 'all';
  const mark = inbox.state('gmail:mark', null);
  const startedAt = Date.now();
  const incremental = !!(mark && mark.scope === scope && mark.days >= days && mark.at > startedAt - days * DAY);
  const q = (only ? 'label:"' + esc(only) + '" ' : '') + '-in:sent -in:draft -in:spam -in:trash -in:chats -from:me '
    + (incremental ? 'after:' + Math.floor((mark.at - DAY) / 1000) : 'newer_than:' + days + 'd');
  // Every page of the window: stopping at the first would lose older mail for good, since the next run asks the same question.
  // The list gives ids only. A thread is fetched in full only if the list names a message of it that is
  // not here yet: a thread with nothing new costs no further request.
  const listed = new Map();   // thread id -> ids of its messages that matched
  let pageToken, listedMessages = 0;
  for (let page = 0; page < 20; page++) {
    const r = await api('messages', { q, maxResults: 500, pageToken });
    for (const x of r.messages || []) if (x.threadId) { listedMessages++; if (!listed.has(x.threadId)) listed.set(x.threadId, []); listed.get(x.threadId).push(x.id); }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  const threadIds = new Set([...listed.entries()].filter(([, ids]) => ids.some((id) => !inbox.has('gmail:' + id))).map(([tid]) => tid));
  let me = '';
  try { me = String((await api('profile')).emailAddress || '').toLowerCase(); } catch (e) {}
  let ingested = 0, routed = 0, reactivated = 0, own = 0;
  for (const tid of threadIds) {
    let thr;
    try { thr = await api('threads/' + tid, { format: 'full' }); } catch (e) { continue; }
    const msgs = thr.messages || [];
    for (const m of msgs) {
      const ids = m.labelIds || [];
      if (ids.includes('DRAFT')) continue;   // a draft comes back as a message of the thread; it was never sent
      const from = header(m, 'from');
      // Yours: Gmail says it was sent from this mailbox, or it is from the account's own address, or from another address you named as yours in the settings.
      // The address itself, not the whole header: a display name can be anything, also your address ("me@x.com" <someone@else>).
      const fromAddr = ((/<([^<>]+)>\s*$/.exec(from) || [null, from])[1] || '').trim().toLowerCase();
      const mine = ids.includes('SENT') || (!!me && fromAddr === me) || (cfg.myAddresses || []).includes(fromAddr);
      const names = ids.map((id) => byId[id]).filter(Boolean);
      const r = inbox.ingest({ source: 'gmail', threadId: 'gmail:' + tid, sourceMsgId: 'gmail:' + m.id, refs: names, sourceRef: names.find((n) => valid.includes(n)) || names.find((n) => !SYSTEM_LABEL.test(n)) || null,
        from, subject: header(m, 'subject'), bodyText: gmailBody(m.payload), direction: mine ? 'out' : 'in', quiet: mine, ts: Number(m.internalDate) || Date.now() });
      if (r.ingested) { if (mine) own++; else ingested++; }
      if (r.routed) routed++;
      if (r.reactivated) reactivated++;
    }
  }
  inbox.setState('gmail:mark', { at: startedAt, scope, days });   // reached only when the whole fetch went through
  return { source: 'gmail', ingested, own, routed, reactivated, threads: threadIds.size, listed: listedMessages, listedThreads: listed.size, incremental, scope, days, account: me };
}

// ── Slack ──
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

// ── Teams ──
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

module.exports = { safeName, gmailAttachments, guessTeamsSelf, pollGmail, pollSlack, pollTeams, gmailConfigured, gmailBody, ReauthError };
