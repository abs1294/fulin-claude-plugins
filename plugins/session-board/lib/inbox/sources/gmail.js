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
// Gmail's HTTP interface, read-only. Every received mail is fetched, unless the settings keep to one label.
// The OAuth client and the token: see credFile() and tokenFile in lib/inbox/index.js.
const fs = require('fs');
const path = require('path');
const { htmlToText } = require('../text');

const DAY = 86400000;

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
  // Handed over now: the days these files are kept count from this moment (InboxService.purgeAttachments reads
  // the newest time in the folder). A file already here is not written again, so the folder gets a mark of its own.
  if (out.files.length || out.inline.length) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, KEPT_MARK), String(Date.now())); } catch (e) {} }
  return out;
}
const KEPT_MARK = '.kept';
const header = (m, name) => (((m.payload && m.payload.headers) || []).find((h) => String(h.name).toLowerCase() === name) || {}).value || '';
// The addresses in a To or Cc header ("A" <a@x>, b@y) - the addresses only, never the display names (a name can be anything)
// A display name is set aside first: quoted ("me@x.com" <evil@y.com>) it is cut out, and in an entry with <...> only what
// is in the brackets counts - a name written like your address must not make a mail "to you" (review 2026-11-20).
const addrs = (v) => {
  const out = [];
  for (const part of String(v || '').replace(/"(?:[^"\\]|\\.)*"/g, ' ').split(/[,;]/)) {
    const b = /<([^<>\s]+@[^<>\s]+)>/.exec(part);
    const a = b ? b[1] : (/([^\s<>"']+@[^\s<>"']+)/.exec(part) || [])[1];
    if (a) out.push(a.toLowerCase());
  }
  return [...new Set(out)];
};
// A forward: its subject says so (Fwd:, FW:, 轉寄：), or its text carries the line mail programs put above what is forwarded
const FWD_SUBJECT = /^\s*(fwd?|fw|轉寄|轉送)\s*[:：]/i;
const FWD_BODY = /-{2,}\s*(forwarded message|original message|轉寄的郵件|轉寄郵件|原始郵件)\s*-{2,}|^\s*(begin forwarded message|開始轉寄的郵件)\s*:/im;
// Who a message went to, and where you were among them (asked 2026-11-20: tell apart what was sent to you, copied to
// you and forwarded): {to, cc, meRole: to | cc | other, forwarded}
function recipientsOf(m, mine) {
  const to = addrs(header(m, 'to')), cc = addrs(header(m, 'cc'));
  const meRole = to.some((a) => mine.has(a)) ? 'to' : cc.some((a) => mine.has(a)) ? 'cc' : 'other';
  return { to, cc, meRole, forwarded: FWD_SUBJECT.test(header(m, 'subject')) || FWD_BODY.test(gmailBody(m.payload).slice(0, 20000)) };
}

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
    for (const [k, v] of Object.entries(params || {})) if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x)); else if (v != null) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url.toString(), { headers: { authorization: 'Bearer ' + token } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error('Gmail ' + p.split('/')[0] + ' 失敗：' + ((j.error && j.error.message) || 'HTTP ' + res.status)), { status: res.status });
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
  const mineSet = new Set([me, ...(cfg.myAddresses || []).map((a) => String(a).toLowerCase())].filter(Boolean));
  // Not knowing which addresses are yours (the profile could not be asked, none named in the settings), whether a mail
  // was to you cannot be told: nothing about it is kept now - left for a later fetch to fill in, rather than kept for good
  // as "not to you" (review 2026-11-20).
  const knowMe = mineSet.size > 0;
  // Mail kept before who it went to was kept: the threads with such messages (from the database, newest first - not only
  // those this fetch listed) are asked once more for their headers only (To, Cc, Subject - not the text again), at most
  // 100 threads a fetch, until none is left. Only messages not filled in yet are written (a forward told from its text
  // stays one). A thread Gmail no longer has (404: deleted) is marked as such, not asked again every fetch.
  let filled = 0, fillFailed = 0;
  if (knowMe && inbox.threadsWithoutRecipients) {
    const old = inbox.threadsWithoutRecipients('gmail', 100).filter((tid) => !threadIds.has(tid));
    for (const tid of old) {
      let thr; try { thr = await api('threads/' + tid, { format: 'metadata', metadataHeaders: ['To', 'Cc', 'Subject'] }); }
      catch (e) { fillFailed++; if (e.status === 404) inbox.recipientsGone('gmail:' + tid); continue; }
      for (const m of thr.messages || []) if (m.payload) { const r = recipientsOf(m, mineSet); r.forwarded = FWD_SUBJECT.test(header(m, 'subject')); if (inbox.setRecipients('gmail:' + m.id, r)) filled++; }
      // a message of it Gmail did not give back (deleted from the thread): not asked again
      inbox.recipientsGone('gmail:' + tid);
    }
  }
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
        from, subject: header(m, 'subject'), bodyText: gmailBody(m.payload), direction: mine ? 'out' : 'in', quiet: mine, ts: Number(m.internalDate) || Date.now(),
        ...(knowMe ? recipientsOf(m, mineSet) : {}) });
      if (r.ingested) { if (mine) own++; else ingested++; }
      // a message of it kept before who it went to was kept: filled in from this fetch, its text and all - the thread is
      // left out of the fill-in above for having something new (review 2026-11-20: a thread new mail kept coming to was
      // never filled in)
      else if (knowMe && inbox.setRecipients && inbox.setRecipients('gmail:' + m.id, recipientsOf(m, mineSet))) filled++;
      if (r.routed) routed++;
      if (r.reactivated) reactivated++;
    }
  }
  inbox.setState('gmail:mark', { at: startedAt, scope, days });   // reached only when the whole fetch went through
  return { source: 'gmail', ingested, own, routed, reactivated, recipientsFilled: filled, recipientsFailed: fillFailed, threads: threadIds.size, listed: listedMessages, listedThreads: listed.size, incremental, scope, days, account: me };
}

module.exports = { recipientsOf, addrs,
  id: 'gmail', name: 'Gmail', kind: 'mail',
  routeHint: '標籤名稱（信全部都會抓，帶這個標籤的自動分派）',
  fields: [
    { key: 'gmailLabel', label: 'Gmail 只抓這個標籤', placeholder: '留空＝所有收到的信都抓', type: 'text', def: '' },
    { key: 'gmailDays', label: 'Gmail 往回幾天', placeholder: '', type: 'number', min: 1, max: 365, def: 7 },
  ],
  status(svc, s, cfg) {
    const reauth = svc.inbox.state('gmail:reauth', null), configured = gmailConfigured(cfg), hasClient = svc.hasCred(), account = svc.inbox.state('gmail:account', '');
    const text = reauth ? '授權已失效，要重新連接才抓得到信'
      : !hasClient ? '要先放一個 Google 的 OAuth 用戶端檔，才能連接（按「連接 Gmail」看放哪裡）'
      : !configured ? '還沒有連接'
      : (account ? account + ' · ' : '') + (s.gmailLabel ? '只抓標籤「' + s.gmailLabel + '」' : '所有收到的信') + '，最近 ' + s.gmailDays + ' 天';
    return { configured, ready: configured && !reauth, alarm: !!reauth, text, hasClient, clientFile: path.join(path.dirname(svc.tokenFile), 'gmail-credentials.json'), ownToken: fs.existsSync(svc.tokenFile),
      needsReauth: !!reauth, reauthAt: reauth && reauth.at, account, label: s.gmailLabel, days: s.gmailDays,
      action: { label: reauth || !configured ? '連接 Gmail' : '重新連接', api: '/api/inbox/gmail/connect', title: '開 Google 的登入頁，授權看板「唯讀」讀取信件。授權只存在這台電腦', said: '已開啟 Google 的登入頁。完成後回到這裡，會自動開始抓信' } };
  },
  poll: (inbox, cfg, fetchImpl) => pollGmail(inbox, cfg, fetchImpl),
  done(svc, r) { if (!r.skipped) { svc.inbox.setState('gmail:reauth', null); if (r.account) svc.inbox.setState('gmail:account', r.account); } },
  failed(svc, e) { const reauth = e instanceof ReauthError; if (reauth) svc.inbox.setState('gmail:reauth', { at: Date.now() }); return { reauth }; },
  safeName, gmailAttachments, pollGmail, gmailConfigured, gmailBody, ReauthError,
};
