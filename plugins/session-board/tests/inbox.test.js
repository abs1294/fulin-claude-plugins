'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DB = require('../lib/db');
const { Inbox } = require('../lib/inbox/store');
const Src = require('../lib/inbox/sources');
const { htmlToText, snappyUncompress, stripSignatures } = require('../lib/inbox/text');
const TeamsDb = require('../lib/inbox/teams-localdb');
const { InboxService } = require('../lib/inbox');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-inbox-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { DB.close(path.join(d, 'b.db')); fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const fresh = () => { const d = tmp(); return { d, inbox: new Inbox(path.join(d, 'b.db')) }; };
const json = (o, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => o });

test('ingest: once per message, routed by the most specific route, reopened by a new message from the other side', () => {
  const { inbox } = fresh();
  assert.strictEqual(inbox.saveRoute({ source: 'mail', source_ref: 'x' }).ok, false);
  assert.strictEqual(inbox.saveRoute({ source: 'gmail', source_ref: ' ' }).ok, false);
  inbox.saveRoute({ source: 'gmail', source_ref: '客戶A', customer: 'A', root_folder: 'C:\\w\\general' });
  inbox.saveRoute({ source: 'gmail', source_ref: '客戶A/供應商平台/bug', customer: 'A', system: '供應商平台', root_folder: 'C:\\w\\supplier' });
  inbox.saveRoute({ source: 'gmail', source_ref: 'off', root_folder: 'C:\\w\\off', enabled: false });
  assert.deepStrictEqual(inbox.enabledRefs('gmail').sort(), ['客戶A', '客戶A/供應商平台/bug']);

  const m = (id, extra) => Object.assign({ source: 'gmail', threadId: 'gmail:t1', sourceMsgId: 'gmail:' + id, refs: ['INBOX', '客戶A', '客戶A/供應商平台/bug'], from: 'a@x.com', subject: '登入失敗', bodyText: '內容 ' + id, ts: 1000 }, extra);
  assert.deepStrictEqual(inbox.ingest(m('m1')), { ingested: true, reactivated: false, routed: true, threadId: 'gmail:t1' });
  assert.deepStrictEqual(inbox.ingest(m('m1')), { ingested: false });                       // the same message again
  assert.deepStrictEqual(inbox.ingest(m('m0', { bodyText: '   ' })), { ingested: false });  // nothing in it
  let t = inbox.thread('gmail:t1');
  assert.deepStrictEqual([t.status, t.root_folder, t.customer, t.system, t.items.length], ['routed', 'C:\\w\\supplier', 'A', '供應商平台', 1]);

  // Your own reply is kept for context, and changes nothing about the thread.
  inbox.setDone('gmail:t1', true, 5000);
  assert.strictEqual(inbox.ingest(m('m2', { direction: 'out', quiet: true, ts: 6000, from: 'me@x.com' })).reactivated, false);
  assert.strictEqual(inbox.thread('gmail:t1').status, 'done');
  // An older message of theirs turning up late does not reopen it; a newer one does.
  assert.strictEqual(inbox.ingest(m('m3', { ts: 4000 })).reactivated, false);
  assert.strictEqual(inbox.ingest(m('m4', { ts: 7000 })).reactivated, true);
  t = inbox.thread('gmail:t1');
  assert.deepStrictEqual([t.status, t.sender, t.items.map((x) => x.direction).join()], ['routed', 'a@x.com', 'in,in,out,in']);   // by time, and the sender is still theirs

  // No route: the thread waits to be dispatched; by hand it gets a folder, and loses it again.
  inbox.ingest({ source: 'teams', threadId: 'teams:k', sourceMsgId: 'teams:k:1', sourceRef: 'k', from: '王', subject: 'Teams · 王', bodyText: '在嗎', ts: 9000 });
  assert.strictEqual(inbox.thread('teams:k').status, 'new');
  assert.strictEqual(inbox.assign('teams:k', 'C:\\w\\x'), true);
  assert.strictEqual(inbox.thread('teams:k').status, 'routed');
  inbox.assign('teams:k', '');
  assert.deepStrictEqual([inbox.thread('teams:k').status, inbox.thread('teams:k').root_folder], ['new', null]);

  const c = inbox.counts();
  assert.deepStrictEqual([c.new, c.routed, c.done, c.unread, c.bySource], [1, 1, 0, 2, { gmail: 1, teams: 1 }]);
  inbox.markSeen('teams:k', 10000);
  assert.strictEqual(inbox.counts().unread, 1);
  assert.deepStrictEqual(inbox.threads({ q: '在嗎' }).map((x) => x.thread_id), ['teams:k']);   // the search reads message text too
  inbox.db.prepare("UPDATE inbox_thread SET triage = 'fyi', triage_title = 'Prototype 交付通知', triage_summary = '請確認動畫' WHERE thread_id = 'teams:k'").run();
  assert.deepStrictEqual(inbox.threads({ q: '交付通知' }).map((x) => x.thread_id), ['teams:k']);   // and the triage's title the list shows
  assert.deepStrictEqual(inbox.threads({ q: '確認動畫' }).map((x) => x.thread_id), ['teams:k']);   // and its line
  // who sent any message of the thread, not only who started it; and what is typed looked for as it is: _ and % are
  // themselves (2026-11-20: 「tina_chao」 found nothing - it had been looked for as 「tina chao」)
  inbox.ingest({ source: 'teams', threadId: 'teams:k', sourceMsgId: 'teams:k:2', sourceRef: 'k', from: '"趙" <tina_chao@x.com>', subject: 'Teams · 王', bodyText: '好的，已完成 100%', ts: 11000 });
  assert.deepStrictEqual(inbox.threads({ q: 'tina_chao' }).map((x) => x.thread_id), ['teams:k']);
  assert.deepStrictEqual(inbox.threads({ q: 'TINA_CHAO@X' }).map((x) => x.thread_id), ['teams:k'], 'capitals or not');
  assert.deepStrictEqual(inbox.threads({ q: 'tinaXchao' }), [], '_ is not "any one letter"');
  assert.deepStrictEqual(inbox.threads({ q: '100%' }).map((x) => x.thread_id), ['teams:k']);
  assert.deepStrictEqual(inbox.threads({ q: '10%0' }), [], '% is not "anything"');
  assert.deepStrictEqual(inbox.threads({ source: 'gmail' }).map((x) => [x.thread_id, x.messages, x.latest]), [['gmail:t1', 4, '內容 m4']]);
  assert.strictEqual(inbox.deleteRoute(inbox.routes()[0].id), true);
});

test('htmlToText and snappy', () => {
  assert.strictEqual(htmlToText('<div>你好&nbsp;<b>世界</b></div><p>第二段 &lt;tag&gt; &#x4E2D;&#25991;</p><style>p{}</style><a href="https://x.com/a">連結</a><br><a href="https://y.com">https://y.com</a>'),
    '你好 世界\n第二段 <tag> 中文\n連結 (https://x.com/a)\nhttps://y.com');
  // "abcabcabcabc": a 3-byte literal, then a copy of 9 bytes from 3 back (it overlaps what it is writing).
  assert.strictEqual(snappyUncompress(Buffer.from([12, 0x08, 0x61, 0x62, 0x63, 0x22, 0x03, 0x00])).toString(), 'abcabcabcabc');
  assert.throws(() => snappyUncompress(Buffer.from([5, 0x08, 0x61])));
});

test('Teams: messages are read out of V8-serialized records, one-byte strings as Latin-1', () => {
  const str = (s) => Buffer.concat([Buffer.from([0x22, s.length]), Buffer.from(s, 'latin1')]);
  const wide = (s) => { const b = Buffer.from(s, 'utf16le'); return Buffer.concat([Buffer.from([0x63, b.length]), b]); };
  const num = (n) => { const b = Buffer.alloc(9); b[0] = 0x4e; b.writeDoubleLE(n, 1); return b; };
  const rec = (key, creator, name, html, ts) => Buffer.concat([str('searchKey'), str(key), str('content'), html, str('creator'), str(creator), str('imDisplayName'), name, str('originalArrivalTime'), num(ts)]);
  const block = Buffer.concat([
    rec('19:uni01_abc@thread.v2_170', '8:live:.cid.aaa', wide('王小明'), wide('<div>明天開會嗎</div>'), 1700000000000),
    rec('19:uni01_abc@thread.v2_171', '8:live:me', str('Me'), str('ok\u00a0sure'), 1700000001000),
    rec('19:uni01_abc@thread.v2_172', 'applyConsumptionHorizon', str('x'), str('system event'), 1700000002000),   // not sent by a person
  ]);
  const out = TeamsDb.parseMessagesFromBlock(block);
  assert.deepStrictEqual(out.map((m) => [m.threadKey, m.creator, m.fromName, m.contentHtml, m.ts]), [
    ['19:uni01_abc@thread.v2', '8:live:.cid.aaa', '王小明', '<div>明天開會嗎</div>', 1700000000000],
    ['19:uni01_abc@thread.v2', '8:live:me', 'Me', 'ok\u00a0sure', 1700000001000],
  ]);
  assert.strictEqual(TeamsDb.stableMsgId(5, 'a'), TeamsDb.stableMsgId(5, 'a'));
  assert.notStrictEqual(TeamsDb.stableMsgId(5, 'a'), TeamsDb.stableMsgId(5, 'b'));
});

test('Gmail: who each message went to - to you, a copy to you, neither, a forward; filled in later for mail kept before', async () => {
  const G = require('../lib/inbox/sources/gmail');
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const msg = (id, h, text, labels = ['INBOX']) => ({ id, threadId: 'R1', labelIds: labels, internalDate: String(5000 + Number(id.slice(1))), payload: { mimeType: 'text/plain', headers: Object.entries(h).map(([name, value]) => ({ name, value })), body: { data: b64(text) } } });
  const mine = new Set(['me@x.com', 'alias@y.com']);
  assert.deepStrictEqual(G.addrs('"Me (x.com)" <Me@X.com>, b@c.com; "趙" <tina_chao@x.com>'), ['me@x.com', 'b@c.com', 'tina_chao@x.com'], 'addresses only, not what a display name says');
  const to = G.recipientsOf(msg('m1', { From: 't@c.com', To: 'Me <me@x.com>, k@c.com', Cc: 't@c.com', Subject: 'Re: 會議' }, '請確認'), mine);
  assert.deepStrictEqual(to, { to: ['me@x.com', 'k@c.com'], cc: ['t@c.com'], meRole: 'to', forwarded: false });
  assert.strictEqual(G.recipientsOf(msg('m2', { To: 'k@c.com', Cc: 'alias@y.com' }, 'x'), mine).meRole, 'cc', 'another address of yours, in Cc');
  assert.strictEqual(G.recipientsOf(msg('m3', { To: 'team@c.com' }, 'x'), mine).meRole, 'other', 'a list, or a blind copy');
  assert.strictEqual(G.recipientsOf(msg('m4', { To: 'me@x.com', Subject: 'Fwd: 報價' }, 'x'), mine).forwarded, true);
  assert.strictEqual(G.recipientsOf(msg('m5', { To: 'me@x.com', Subject: '看一下' }, '---------- 轉寄的郵件 ---------\n寄件者：…'), mine).forwarded, true);
  assert.strictEqual(G.recipientsOf(msg('m6', { To: 'me@x.com', Subject: 'FW：合約' }, 'x'), mine).forwarded, true, 'a full-width colon');

  const { d, inbox } = fresh();
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'sec' } }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'rt' }));
  // a thread kept before who it went to was kept: no rcpt
  inbox.ingest({ source: 'gmail', threadId: 'gmail:R1', sourceMsgId: 'gmail:m1', from: 't@c.com', subject: 'Re: 會議', bodyText: '請確認', ts: 5001 });
  assert.strictEqual(inbox.thread('gmail:R1').items[0].rcpt, null);
  const asked = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); asked.push(u.pathname.replace('/gmail/v1/users/me/', '') + (u.searchParams.get('format') ? '?format=' + u.searchParams.get('format') + '&h=' + u.searchParams.getAll('metadataHeaders').join(',') : ''));
    if (u.host === 'oauth2.googleapis.com') return json({ access_token: 'at' });
    if (u.pathname.endsWith('/labels')) return json({ labels: [] });
    // only R2 is listed (a fetch lists what is new since the last): R1, kept before, is filled in all the same
    if (u.pathname.endsWith('/messages')) return json({ messages: [{ id: 'n1', threadId: 'R2' }] });
    if (u.pathname.endsWith('/profile')) return json({ emailAddress: 'me@x.com' });
    if (u.pathname.endsWith('/threads/R1')) return json({ messages: [msg('m1', { From: 't@c.com', To: 'me@x.com, k@c.com', Cc: 't@c.com', Subject: 'Re: 會議' }, '')] });
    if (u.pathname.endsWith('/threads/R2')) return json({ messages: [msg('n1', { From: 'k@c.com', To: 'list@c.com', Subject: 'Fwd: 公告' }, '公告內容'), msg('n2', { From: 'me@x.com', To: 'boss@c.com', Subject: 'Fwd: 公告' }, '---------- Forwarded message ---------\n公告內容', ['SENT'])] });
    return json({}, false);
  };
  const r = await G.pollGmail(inbox, { gmailSecretDir: d }, fetchImpl);
  assert.deepStrictEqual([r.ingested, r.own, r.recipientsFilled], [1, 1, 1]);
  assert.ok(asked.includes('threads/R1?format=metadata&h=To,Cc,Subject'), 'the old thread: its headers only - ' + asked.join(' | '));
  const old = inbox.thread('gmail:R1').items[0];
  assert.deepStrictEqual([JSON.parse(old.rcpt), old.me_role, old.fwd, old.body], [{ to: ['me@x.com', 'k@c.com'], cc: ['t@c.com'] }, 'to', 0, '請確認'], 'filled in, its text as it was');
  const r2 = inbox.thread('gmail:R2').items;
  assert.deepStrictEqual(r2.map((x) => [x.direction, x.me_role, x.fwd]), [['in', 'other', 1], ['out', 'other', 1]]);
  // who it went to is searched too
  assert.deepStrictEqual(inbox.threads({ q: 'boss@c' }).map((x) => x.thread_id), ['gmail:R2']);
  // the next fetch: nothing left to fill in, nothing asked again
  asked.length = 0;
  const r3 = await G.pollGmail(inbox, { gmailSecretDir: d }, fetchImpl);
  assert.deepStrictEqual([r3.recipientsFilled, asked.filter((x) => x.startsWith('threads/')).length], [0, 0]);
  // a source that does not say who it went to (Teams): not known, rather than "not to you"
  inbox.ingest({ source: 'teams', threadId: 'teams:z', sourceMsgId: 'teams:z:1', from: '王', bodyText: '在嗎', ts: 1 });
  assert.deepStrictEqual([inbox.thread('teams:z').items[0].rcpt, inbox.thread('teams:z').items[0].me_role], [null, null]);
});

test('Gmail recipients, review 2026-11-20: a display name is not an address; filled once; a deleted thread not asked again; not knowing you, nothing kept', async () => {
  const G = require('../lib/inbox/sources/gmail');
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const msg = (id, tid, h, text = 'x', labels = ['INBOX']) => ({ id, threadId: tid, labelIds: labels, internalDate: '9000', payload: { mimeType: 'text/plain', headers: Object.entries(h).map(([name, value]) => ({ name, value })), body: { data: b64(text) } } });
  const mine = new Set(['me@x.com']);
  // your address as someone's display name: not to you
  assert.deepStrictEqual(G.addrs('"me@x.com" <evil@y.com>, plain@z.com, "A, B" <ab@z.com>'), ['evil@y.com', 'plain@z.com', 'ab@z.com']);
  assert.strictEqual(G.recipientsOf(msg('a', 'T', { To: '"me@x.com" <evil@y.com>' }), mine).meRole, 'other');
  const { d, inbox } = fresh();
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'sec' } }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'rt' }));
  // a forward told from its text, then the headers asked for: it stays a forward
  inbox.ingest({ source: 'gmail', threadId: 'gmail:F', sourceMsgId: 'gmail:f1', from: 'k@c.com', bodyText: '---------- Forwarded message ---------', to: ['me@x.com'], cc: [], meRole: 'to', forwarded: true, ts: 1 });
  assert.strictEqual(inbox.setRecipients('gmail:f1', { to: ['me@x.com'], cc: [], meRole: 'to', forwarded: false }), false, 'filled already: not written');
  assert.strictEqual(inbox.thread('gmail:F').items[0].fwd, 1);
  // search: the addresses, not the JSON around them
  assert.deepStrictEqual(inbox.threads({ q: 'to' }), [], '"to" is not in any address');
  assert.deepStrictEqual(inbox.threads({ q: 'me@x' }).map((x) => x.thread_id), ['gmail:F']);
  // kept before: one thread Gmail still has, one it no longer has
  inbox.ingest({ source: 'gmail', threadId: 'gmail:OK', sourceMsgId: 'gmail:o1', from: 'k@c.com', bodyText: 'a', ts: 2 });
  inbox.ingest({ source: 'gmail', threadId: 'gmail:GONE', sourceMsgId: 'gmail:g1', from: 'k@c.com', bodyText: 'b', ts: 3 });
  const asked = []; let profileOk = false;
  const fetchImpl = async (url) => {
    const u = new URL(url); asked.push(u.pathname.replace('/gmail/v1/users/me/', ''));
    if (u.host === 'oauth2.googleapis.com') return json({ access_token: 'at' });
    if (u.pathname.endsWith('/labels')) return json({ labels: [] });
    if (u.pathname.endsWith('/messages')) return json({ messages: [] });
    if (u.pathname.endsWith('/profile')) return profileOk ? json({ emailAddress: 'me@x.com' }) : json({ error: { message: 'down' } }, false);
    if (u.pathname.endsWith('/threads/OK')) return json({ messages: [msg('o1', 'OK', { To: 'me@x.com' })] });
    if (u.pathname.endsWith('/threads/GONE')) return { ok: false, status: 404, json: async () => ({ error: { message: 'Requested entity was not found.' } }) };
    return json({}, false);
  };
  // which address is yours not known (profile failed, none in the settings): nothing filled in, nothing kept as "not to you"
  const r0 = await G.pollGmail(inbox, { gmailSecretDir: d }, fetchImpl);
  assert.deepStrictEqual([r0.recipientsFilled, inbox.thread('gmail:OK').items[0].rcpt, asked.filter((x) => x.startsWith('threads/')).length], [0, null, 0]);
  profileOk = true; asked.length = 0;
  const r1 = await G.pollGmail(inbox, { gmailSecretDir: d }, fetchImpl);
  assert.deepStrictEqual([r1.recipientsFilled, r1.recipientsFailed], [1, 1]);
  assert.strictEqual(inbox.thread('gmail:OK').items[0].me_role, 'to');
  assert.deepStrictEqual([inbox.thread('gmail:GONE').items[0].rcpt, inbox.thread('gmail:GONE').items[0].me_role], ['{"gone":1}', null], 'deleted: marked, said nothing about');
  asked.length = 0;
  await G.pollGmail(inbox, { gmailSecretDir: d }, fetchImpl);
  assert.deepStrictEqual(asked.filter((x) => x.startsWith('threads/')), [], 'neither asked again');
  // a thread kept before, with new mail in it now: read in full for the new message - its old one filled in from that
  // (review 2026-11-20), the forward told from its text
  inbox.ingest({ source: 'gmail', threadId: 'gmail:NEW', sourceMsgId: 'gmail:x1', from: 'k@c.com', bodyText: 'old', ts: 4 });
  const more = async (url, o) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/messages')) return json({ messages: [{ id: 'x2', threadId: 'NEW' }] });
    if (u.pathname.endsWith('/threads/NEW')) return json({ messages: [msg('x1', 'NEW', { To: 'k@c.com', Cc: 'me@x.com', Subject: '看一下' }, '---------- 轉寄的郵件 ---------\nold'), msg('x2', 'NEW', { To: 'me@x.com', Subject: 'Re: 看一下' }, 'new')] });
    return fetchImpl(url, o);
  };
  const r2 = await G.pollGmail(inbox, { gmailSecretDir: d }, more);
  const items = inbox.thread('gmail:NEW').items;
  assert.deepStrictEqual([r2.ingested, r2.recipientsFilled, items.map((x) => [x.me_role, x.fwd])], [1, 1, [['cc', 1], ['to', 0]]]);
});

test('Gmail: body in its own character set; a poll takes whole threads, skips drafts, and keeps your own replies quiet', async () => {
  const b64 = (buf) => Buffer.from(buf).toString('base64url');
  const big5 = Buffer.from([0xa7, 0x41, 0xa6, 0x6e]);   // "你好" in Big5
  assert.strictEqual(Src.gmailBody({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
    { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="big5"' }], body: { data: b64(big5) } }] }), '你好');
  assert.strictEqual(Src.gmailBody({ mimeType: 'text/html', body: { data: b64('<div>只有 <b>HTML</b></div>') } }), '只有 HTML');

  const { d, inbox } = fresh();
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'sec' } }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'rt' }));
  const cfg = { gmailSecretDir: d, gmailLabel: 'poc', gmailDays: 30 };
  const msg = (id, from, labels, text) => ({ id, threadId: 'T1', labelIds: labels, internalDate: String(1000 + Number(id.slice(1))), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: '報價' }], body: { data: b64(text) } } });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); calls.push(u.pathname.replace('/gmail/v1/users/me/', '') + (u.searchParams.get('q') ? '?q=' + u.searchParams.get('q') : ''));
    if (u.host === 'oauth2.googleapis.com') return json(String(opts.body).includes('refresh_token=rt') ? { access_token: 'at' } : { error: 'invalid_grant' });
    assert.strictEqual(opts.headers.authorization, 'Bearer at');
    if (u.pathname.endsWith('/labels')) return json({ labels: [{ id: 'L1', name: 'poc' }, { id: 'INBOX', name: 'INBOX' }] });
    if (u.pathname.endsWith('/messages')) return json({ messages: [{ id: 'm1', threadId: 'T1' }, { id: 'm3', threadId: 'T1' }] });
    if (u.pathname.endsWith('/profile')) return json({ emailAddress: 'Me@x.com' });
    if (u.pathname.endsWith('/threads/T1')) return json({ messages: [msg('m1', 'a@c.com', ['L1', 'INBOX'], '請報價'), msg('m2', 'me@x.com', ['SENT'], '已報價'), msg('m3', 'a@c.com', ['L1'], '收到'), msg('m4', 'me@x.com', ['DRAFT'], '草稿')] });
    return json({}, false);
  };
  const r = await Src.pollGmail(inbox, cfg, fetchImpl);
  assert.deepStrictEqual([r.ingested, r.own, r.threads, r.account], [2, 1, 1, 'me@x.com']);
  assert.ok(calls.includes('messages?q=label:"poc" -in:sent -in:draft -in:spam -in:trash -in:chats -from:me newer_than:30d'), calls.join(' | '));   // a label named in the settings: only that
  assert.strictEqual(r.scope, 'label:poc');
  // No label named: all received mail, and seven days back unless said otherwise.
  const everything = await Src.pollGmail(inbox, { gmailSecretDir: d }, fetchImpl);
  assert.ok(calls.includes('messages?q=-in:sent -in:draft -in:spam -in:trash -in:chats -from:me newer_than:7d'), calls.join(' | '));
  assert.deepStrictEqual([everything.scope, everything.days, everything.skipped], ['all', 7, undefined]);
  // A label that is not in the mailbox is said, not silently fetched as nothing.
  assert.match((await Src.pollGmail(inbox, { gmailSecretDir: d, gmailLabel: 'nope' }, fetchImpl)).reason, /沒有「nope」這個標籤/);
  const t = inbox.thread('gmail:T1');
  assert.deepStrictEqual([t.status, t.sender, t.subject, t.items.map((x) => x.direction + ':' + x.body).join('|')], ['new', 'a@c.com', '報價', 'in:請報價|out:已報價|in:收到']);
  assert.deepStrictEqual([r.incremental, r.listedThreads, calls.filter((c) => c.startsWith('threads/')).length], [false, 1, 1]);   // the first fetch: the whole window, the thread read once
  // A second poll asks only for mail since the first (a day's overlap), and does not read the thread again: nothing in it is new.
  await Src.pollGmail(inbox, cfg, fetchImpl);   // back to this label after the all-mail fetch above: a change of scope starts from the whole window again
  const again = await Src.pollGmail(inbox, cfg, fetchImpl);
  assert.deepStrictEqual([again.ingested, again.incremental, again.threads, calls.filter((c) => c.startsWith('threads/')).length], [0, true, 0, 1]);
  assert.ok(calls.some((c) => /^messages\?q=label:"poc" .* after:\d{9,}$/.test(c)), calls.join(' | '));
  // A new message in it: listed, so the thread is read again and only the new message is written.
  const more = async (url, opts) => { const u = new URL(url); if (u.pathname.endsWith('/messages')) return json({ messages: [{ id: 'm5', threadId: 'T1' }] }); if (u.pathname.endsWith('/threads/T1')) return json({ messages: [msg('m1', 'a@c.com', ['L1'], '請報價'), msg('m5', 'a@c.com', ['L1'], '還在嗎')] }); return fetchImpl(url, opts); };
  const third = await Src.pollGmail(inbox, cfg, more);
  assert.deepStrictEqual([third.ingested, third.threads, inbox.thread('gmail:T1').items.length], [1, 1, 4]);
  // A dead token is reported as "sign in again", not as "nothing new".
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'revoked' }));
  await assert.rejects(Src.pollGmail(inbox, cfg, fetchImpl), Src.ReauthError);
  assert.strictEqual((await Src.pollGmail(inbox, { gmailSecretDir: path.join(d, 'none') }, fetchImpl)).skipped, true);
});

test('Slack: a channel of a route, its thread replies, and your own messages', async () => {
  const { inbox } = fresh();
  assert.strictEqual((await Src.pollSlack(inbox, { slackToken: '' })).skipped, true);
  assert.strictEqual((await Src.pollSlack(inbox, { slackToken: 'xoxb' })).skipped, true);   // no route yet
  inbox.saveRoute({ source: 'slack', source_ref: 'C1', root_folder: 'C:\\w\\s' });
  const fetchImpl = async (url, opts) => {
    assert.strictEqual(opts.headers.authorization, 'Bearer xoxb');
    const u = new URL(url);
    if (u.pathname.endsWith('conversations.history')) return json({ ok: true, has_more: false, messages: [
      { type: 'message', ts: '20.000', user: 'U2', text: '第二則' }, { type: 'message', ts: '10.000', thread_ts: '10.000', reply_count: 1, user: 'U2', text: '有人在嗎' }, { type: 'message', subtype: 'channel_join', ts: '5.000', user: 'U9', text: 'joined' }] });
    if (u.pathname.endsWith('conversations.replies')) return json({ ok: true, messages: [{ type: 'message', ts: '10.000', user: 'U2', text: '有人在嗎' }, { type: 'message', ts: '11.000', thread_ts: '10.000', user: 'ME', text: '在' }] });
    return json({ ok: false, error: 'unknown_method' });
  };
  const r = await Src.pollSlack(inbox, { slackToken: 'xoxb', slackSelfId: 'ME', slackDays: 7 }, fetchImpl);
  assert.deepStrictEqual([r.ingested, r.channels, r.error], [3, 1, undefined]);   // two of theirs and one of yours
  assert.deepStrictEqual(inbox.threads({}).map((t) => [t.thread_id, t.status, t.root_folder, t.messages]).sort(), [['slack:C1:10.000', 'routed', 'C:\\w\\s', 2], ['slack:C1:20.000', 'routed', 'C:\\w\\s', 1]]);
  assert.deepStrictEqual(inbox.thread('slack:C1:10.000').items.map((m) => m.direction), ['in', 'out']);
});

test('InboxService: settings start from the old .env, one fetch at a time, a failed sign-in is remembered', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'old.env'), 'GMAIL_LABEL=poc\nTEAMS_SELF_ID="8:live:me"\nTEAMS_POLL_DAYS=3\nSLACK_BOT_TOKEN=\n');
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'sec' } }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'old' }));
  const svc = new InboxService({ db: path.join(d, 'b.db'), secretDir: d, oldEnv: path.join(d, 'old.env'), fetch: async () => json({ error: 'invalid_grant' }) });
  assert.deepStrictEqual([svc.settings().gmailLabel, svc.settings().gmailDays, svc.settings().teamsSelfId, svc.settings().teamsDays, svc.settings().pollMinutes], ['', 7, '8:live:me', 3, 15]);   // the old label is not carried over: all mail is fetched
  // A new installation: the inbox is off and nothing is read whoever asks; no source has been taken away (2026-11-21:
  // a source is fetched once connected - there is no switch to tick)
  assert.deepStrictEqual([svc.settings().enabled, svc.settings().gmailOn, svc.settings().teamsOn, svc.enabled(), svc.tick()], [false, true, true, false, false]);
  // (nothing fetched; what a source has is still said - review 2026-11-21: with the inbox off every source read 「還沒連接」)
  assert.deepStrictEqual([(await svc.poll()).off, (await svc.poll('gmail')).results.length, svc.last, svc.status().gmail.on], [true, 0, null, false]);
  assert.notStrictEqual(svc.status().gmail.text, '沒有開啟');
  // On: a source whose connection was taken away (「刪除連接」) is not read
  assert.strictEqual(svc.saveSettings({ enabled: true }).ok, true);
  assert.deepStrictEqual(svc.disconnect('teams'), { ok: true });
  assert.deepStrictEqual((await svc.poll('teams')).results.map((x) => [x.source, x.skipped, x.off]), [['teams', true, true]]);
  assert.deepStrictEqual([svc.connect('teams'), svc.settings().teamsOn, svc.disconnect('nope').ok], [{ ok: true }, true, false]);
  svc.last = null;
  assert.strictEqual(svc.saveSettings({ pollMinutes: -1 }).ok, false);
  assert.strictEqual(svc.saveSettings({ slackDays: 0 }).ok, false);   // a source's own number, checked against the range it names
  assert.strictEqual(svc.saveSettings({ pollMinutes: 0, slackToken: ' xoxb-1 ' }).ok, true);
  assert.deepStrictEqual([svc.settings().pollMinutes, svc.settings().slackToken, svc.status().settings.slackToken], [0, 'xoxb-1', '（已設定）']);   // the token is not sent to the page
  assert.strictEqual(svc.tick(), false);                                    // 0 minutes: only when asked
  const [a, b] = await Promise.all([svc.poll('gmail'), svc.poll('gmail')]);
  assert.strictEqual(a, b);                                                 // two askers, one fetch
  assert.deepStrictEqual([a.results.length, a.results[0].reauth, svc.status().gmail.needsReauth], [1, true, true]);
  // The board's own token, once there, is the one used.
  fs.writeFileSync(path.join(d, 'gmail-token.json'), JSON.stringify({ refresh_token: 'own' }));
  assert.strictEqual(svc.cfg().gmailTokenFile, path.join(d, 'gmail-token.json'));
  // Starting a sign-in gives Google's address, asking for read-only access and coming back to this machine only.
  const c = await svc.startGmailConnect();
  const u = new URL(c.url);
  assert.deepStrictEqual([u.host, u.searchParams.get('scope'), u.searchParams.get('client_id'), /^http:\/\/127\.0\.0\.1:\d+$/.test(u.searchParams.get('redirect_uri'))], ['accounts.google.com', 'https://www.googleapis.com/auth/gmail.readonly', 'cid', true]);
  const wrong = await fetch(c.redirect + '/?state=nope&code=x');
  assert.strictEqual(wrong.status, 400);                                    // an answer that does not carry this sign-in's secret is not taken
  svc.pending.server.close();
});

test('what goes into a conversation: a mail thread whole with its Gmail ids, a chat thread only the messages picked', () => {
  const { inboxThreadText } = require('../server');
  const mail = { source: 'gmail', thread_id: 'gmail:T9', subject: '環境設定', sender: 'tina@c.com', items: [
    { id: 1, source_msg_id: 'gmail:m1', direction: 'in', sender: 'tina@c.com', ts: 1700000000000, body: '第一封 ' + 'a'.repeat(9000) },
    { id: 2, source_msg_id: 'gmail:m2', direction: 'out', sender: 'me@x.com', ts: 1700000100000, body: '我的回覆' },
    { id: 3, source_msg_id: 'gmail:m3', direction: 'in', sender: 'tina@c.com', ts: 1700000200000, body: '第三封' }] };
  const m = inboxThreadText(mail, []);                                           // nothing picked: mail goes whole anyway
  assert.deepStrictEqual([m.ok, m.count, m.left], [true, 3, 0]);
  assert.ok(m.text.includes('a'.repeat(9000)), 'a long mail is not cut');
  assert.match(m.text, /共 3 封/);
  assert.match(m.text, /threadId）：T9\n/);
  assert.match(m.text, /replyToMessageId）：m3\n/);                             // the latest one from them, not your own reply
  assert.ok(m.text.indexOf('第一封') < m.text.indexOf('我的回覆') && m.text.indexOf('我的回覆') < m.text.indexOf('第三封'));

  const chat = { source: 'teams', thread_id: 'teams:k', subject: 'Teams · 王', sender: '王', items: Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, source_msg_id: 'teams:k:' + i, direction: i % 2 ? 'out' : 'in', sender: '王', ts: 1700000000000 + i * 60000, body: '第 ' + i + ' 則' })) };
  assert.deepStrictEqual(inboxThreadText(chat, []), { ok: false, error: '請先勾選要帶入的訊息' });
  assert.deepStrictEqual(inboxThreadText(chat, [9999]), { ok: false, error: '請先勾選要帶入的訊息' });   // an id that is not in this thread
  const c = inboxThreadText(chat, [149, 103, 110]);                              // picked in any order
  assert.deepStrictEqual([c.ok, c.count, c.left], [true, 3, 0]);
  assert.match(c.text, /挑出的 3 則訊息，不是完整對話/);
  assert.ok(!c.text.includes('第 4 則') && c.text.indexOf('第 3 則') < c.text.indexOf('第 10 則') && c.text.indexOf('第 10 則') < c.text.indexOf('第 49 則'));
  assert.ok(!/threadId/.test(c.text));
  // The guard: far too much picked is said, not silently cut.
  const huge = { source: 'slack', thread_id: 'slack:C:1', subject: 's', sender: 'u', items: Array.from({ length: 40 }, (_, i) => ({ id: i, source_msg_id: 'x' + i, direction: 'in', sender: 'u', ts: i, body: 'z'.repeat(2000) })) };
  const h = inboxThreadText(huge, huge.items.map((x) => x.id));
  assert.ok(h.left > 0 && h.text.length < 32000);
  assert.match(h.text, /太長，只帶入最近 \d+ 則/);
});

test('Gmail: text already in UTF-8 is read as UTF-8 even when the part still declares another character set', () => {
  const part = (bytes, cs) => ({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="' + cs + '"' }], body: { data: Buffer.from(bytes).toString('base64url') } });
  const big5 = [0xb4, 0xfa, 0xb8, 0xd5];                                              // 測試, in Big5
  assert.strictEqual(Src.gmailBody(part(Buffer.from('請確認英文校閱表', 'utf8'), 'big5')), '請確認英文校閱表');   // what Gmail really sends
  assert.strictEqual(Src.gmailBody(part(big5, 'big5')), '測試');                        // bytes truly in the declared set still work
  assert.strictEqual(Src.gmailBody(part(big5, 'no-such-set')), Buffer.from(big5).toString('utf8'));
});

test('signatures are taken out of a mail part by part; what the mail says stays', () => {
  const mail = ['Hi 王先生,', '報價如附件，請確認。', '文件在這裡：', 'https://docs.example.com/d/abc', '', 'Best Regards,', '林小明 Ming Lin', 'Example Co., Ltd.', 'Tel: +886 2 1234 5678', 'Email: ming@example.com', '',
    'From: 王大同 <wang@corp.com>', 'Sent: Monday, November 9, 2026 4:16 PM', 'Subject: RE: 報價', '', '請於週五前提供報價，謝謝。', '1. 含安裝', '2. 含保固', '', '王大同', '02-12345678分機71234', '0912-345-678', '',
    '本郵件及其附件含有機密資訊，僅供指定之收件人使用，若您並非指定之收件人，請勿使用、保存或揭露本郵件之任何部分。'].join('\n');
  const x = stripSignatures(mail);
  assert.strictEqual(x.removed, 2);
  for (const keep of ['報價如附件，請確認。', 'https://docs.example.com/d/abc', 'From: 王大同 <wang@corp.com>', 'Subject: RE: 報價', '請於週五前提供報價，謝謝。', '2. 含保固']) assert.ok(x.text.includes(keep), 'kept: ' + keep);
  for (const gone of ['Best Regards', 'Tel: +886', 'ming@example.com', 'Example Co., Ltd.', '02-12345678', '0912-345-678', '機密資訊']) assert.ok(!x.text.includes(gone), 'gone: ' + gone);
  assert.ok(!/王大同\n*$/.test(x.text));                                                  // the name above the numbers went with them
  // Fenced by rules, quoted with ">", and the "--" line.
  const fenced = stripSignatures('好的，收到。\n=====================\n林小明\nMobile : +886 912 345 678\nTel：+886 2 1234 5678\n=====================\n\nOn Thu, Nov 12, 2026 at 11:00 AM Wang <w@c.com> wrote:\n> 麻煩了\n> -- \n> Wang\n> Sent from my phone');
  assert.deepStrictEqual([fenced.removed, fenced.text], [2, '好的，收到。\n\nOn Thu, Nov 12, 2026 at 11:00 AM Wang <w@c.com> wrote:\n> 麻煩了']);
  // Not signatures: contact details that are what the mail is about, a link on its own, a list, plain thanks.
  for (const plain of ['新窗口的資料如下，之後請找她：\n陳小姐\n電話: 02-1234-5678\nEmail: chen@corp.com\n以上資料請更新到系統裡，並回覆我確認已經完成更新作業，不要漏掉任何一筆資料，謝謝你的幫忙。',
    '會議連結：\nhttps://teams.example.com/meet/123\n請準時', '1. 第一項\n2. 第二項\n謝謝', 'Thanks!!']) assert.deepStrictEqual([stripSignatures(plain).removed, stripSignatures(plain).text], [0, plain]);
  assert.deepStrictEqual(stripSignatures(''), { text: '', removed: 0, lines: 0 });
});

test('a mail handed over: signatures out, and the attachments saved on this computer are listed by path', async () => {
  const { inboxThreadText } = require('../server');
  const d = tmp();
  const t = { source: 'gmail', thread_id: 'gmail:abc123', subject: '報價', sender: 'a@x.com', items: [{ id: 1, source_msg_id: 'gmail:m1', direction: 'in', sender: 'a@x.com', ts: 1000, body: '請看附件。\n\nBest Regards,\nA\nTel: 02-1234-5678' }] };
  const none = inboxThreadText(t, []);
  assert.ok(!none.text.includes('Best Regards') && none.text.includes('請看附件。') && /簽名檔.*已移除 1 處/.test(none.text) && !none.text.includes('附檔'));
  assert.deepStrictEqual([none.signatures, none.attachments], [1, 0]);
  assert.match(inboxThreadText(t, [], { files: [], skipped: [] }).text, /這串信沒有附檔。/);
  assert.match(inboxThreadText(t, [], { error: 'Gmail 授權已失效' }).text, /附檔沒有抓到（Gmail 授權已失效）/);
  // The real fetch, against a made-up Gmail: a file, a picture embedded in the signature, a file too large, a name that tries to leave the folder.
  const b64 = (x) => Buffer.from(x).toString('base64url');
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'r' }));
  const part = (filename, mimeType, id, size, headers = []) => ({ filename, mimeType, headers, body: { attachmentId: id, size } });
  const asked = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'T' });
    asked.push(u.pathname.split('/users/me/')[1]);
    if (u.pathname.endsWith('/threads/abc123')) return json({ messages: [{ id: 'msg000001', internalDate: '5000', payload: { parts: [{ mimeType: 'text/plain', body: { data: b64('hi') } },
      part('報價單.xlsx', 'application/vnd.ms-excel', 'A1', 5), part('logo.png', 'image/png', 'A2', 3, [{ name: 'Content-ID', value: '<x>' }, { name: 'Content-Disposition', value: 'inline' }]),
      part('big.zip', 'application/zip', 'A3', 30 * 1024 * 1024), part('..\\..\\evil?.txt', 'text/plain', 'A4', 2)] } }] });
    if (u.pathname.endsWith('/attachments/A1')) return json({ data: b64('12345') });
    if (u.pathname.endsWith('/attachments/A4')) return json({ data: b64('ok') });
    return json({ error: { message: 'unexpected ' + u.pathname } }, 404);
  };
  const dest = path.join(d, 'att');
  const a = await Src.gmailAttachments({ gmailSecretDir: d }, 'gmail:abc123', dest, fetchImpl);
  assert.deepStrictEqual([a.files.map((x) => x.name), a.inline.map((x) => x.name), a.skipped.map((x) => x.name)], [['報價單.xlsx', '_.._evil_.txt'], ['logo.png'], ['big.zip']]);
  assert.ok(!fs.existsSync(a.inline[0].path));                                                              // a picture in the text is not fetched until it is asked for
  for (const x of a.files) assert.strictEqual(path.dirname(x.path), path.join(dest, 'abc123'));             // nothing lands outside the thread's folder
  assert.strictEqual(fs.readFileSync(a.files[0].path, 'utf8'), '12345');
  const n = asked.length;
  await Src.gmailAttachments({ gmailSecretDir: d }, 'gmail:abc123', dest, fetchImpl);                       // already here: only the thread is asked for again
  assert.strictEqual(asked.length, n + 1);
  // Each hand-over marks the folder: the days its files are kept count from the last one. Long after, with the
  // files cleaned away, handing the mail over again fetches them again and marks the folder anew.
  const mark = path.join(dest, 'abc123', '.kept'), longAgo = new Date(Date.now() - 40 * 86400000);
  assert.ok(fs.existsSync(mark));
  fs.utimesSync(mark, longAgo, longAgo); fs.unlinkSync(a.files[0].path);
  const back = await Src.gmailAttachments({ gmailSecretDir: d }, 'gmail:abc123', dest, fetchImpl);
  assert.deepStrictEqual([fs.readFileSync(back.files[0].path, 'utf8'), back.files[0].path === a.files[0].path, Date.now() - fs.statSync(mark).mtimeMs < 60000], ['12345', true, true]);
  await assert.rejects(Src.gmailAttachments({ gmailSecretDir: d }, 'gmail:../x', dest, fetchImpl), /不是 Gmail 的討論串編號/);
  const full = inboxThreadText(t, [], a);
  assert.ok(full.text.includes('附檔 2 個，已存到這台電腦，可以直接讀取：') && full.text.includes('- ' + a.files[0].path + '（1 KB') && full.text.includes('- 沒有下載：big.zip（太大（30 MB））'));
  assert.strictEqual(full.attachments, 2);
});

test('a picture pasted into a mail: its mark in the text becomes the path of the saved picture; a logo in the signature is not fetched', async () => {
  const { inboxThreadText } = require('../server');
  const d = tmp();
  const b64 = (x) => Buffer.from(x).toString('base64url');
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'r' }));
  const img = (name, id, cid, size) => ({ filename: name, mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<' + cid + '>' }, { name: 'Content-Disposition', value: 'inline; filename="' + name + '"' }], body: { attachmentId: id, size } });
  const fetched = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'T' });
    // The parts come in another order than the text shows them: the HTML decides.
    if (u.pathname.endsWith('/threads/abc999')) return json({ messages: [{ id: 'msg000007', internalDate: '5000', payload: { parts: [
      { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset="utf-8"' }], body: { data: b64('<p>1</p><img src="cid:shotA"><p>2</p><img width=3 src=cid:shotB><p>Thanks</p><img src="cid:logo">') } },
      img('logo.png', 'L', 'logo', 900), img('b.png', 'B', 'shotB', 20000), img('a.png', 'A', 'shotA', 30000)] } }] });
    const m = /attachments\/(\w+)$/.exec(u.pathname); if (m) { fetched.push(m[1]); return json({ data: b64('x'.repeat({ A: 30000, B: 20000, L: 900 }[m[1]])) }); }
    return json({}, false);
  };
  const dest = path.join(d, 'att');
  const att = await Src.gmailAttachments({ gmailSecretDir: d }, 'gmail:abc999', dest, fetchImpl);
  assert.deepStrictEqual(att.inline.map((x) => x.cid + ':' + path.basename(x.path)), ['shotA:000007-圖1.png', 'shotB:000007-圖2.png', 'logo:000007-圖3.png']);
  const t = { source: 'gmail', thread_id: 'gmail:abc999', subject: '碳排', sender: 'a@x.com', items: [{ id: 1, source_msg_id: 'gmail:msg000007', direction: 'in', sender: 'a@x.com', ts: 1000,
    body: '1.運輸明細\n[影像]\n2.出貨地址的註解\n[影像]\nThanks!!!\n\nBest Regards,\n王\n[影像]\nTel: 02-1234-5678' }] };
  const x = inboxThreadText(t, [], att);
  assert.ok(x.text.includes('1.運輸明細\n[圖片：' + att.inline[0].path + ']\n2.出貨地址的註解\n[圖片：' + att.inline[1].path + ']\nThanks!!!'));
  assert.ok(!x.text.includes('[影像]') && !x.text.includes(att.inline[2].path));                            // the logo's mark went with the signature
  assert.match(x.text, /信裡貼的圖片 2 張已存到這台電腦/);
  assert.deepStrictEqual([x.images, x.inlineWanted.map((i) => i.cid)], [2, ['shotA', 'shotB']]);
  assert.strictEqual(await att.download(x.inlineWanted), 2);
  assert.deepStrictEqual([fetched.sort(), fs.statSync(att.inline[0].path).size, fs.existsSync(att.inline[2].path)], [['A', 'B'], 30000, false]);
  // Marks that carry the picture's id are matched by it; marks that cannot be matched leave the pictures listed apart (not the small ones).
  const byId = inboxThreadText(Object.assign({}, t, { items: [Object.assign({}, t.items[0], { body: '看這張 [cid:shotB] 就好' })] }), [], att);
  assert.ok(byId.text.includes('看這張 [圖片：' + att.inline[1].path + '] 就好'));
  const apart = inboxThreadText(Object.assign({}, t, { items: [Object.assign({}, t.items[0], { body: '只有一個記號 [影像]' })] }), [], att);
  assert.ok(apart.text.includes('只有一個記號 [影像]') && /信裡另有 2 張圖片對不上在內文的位置/.test(apart.text));
  assert.deepStrictEqual(apart.inlineWanted.map((i) => i.cid), ['shotA', 'shotB']);
});

test('what came from outside is not trusted: your address in a display name is not you, files are marked, a server-sent id cannot leave the folder', async () => {
  const d = tmp();
  const b64 = (x) => Buffer.from(x).toString('base64url');
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'r' }));
  const inbox = new Inbox(path.join(d, 'b.db'));
  const mail = (id, from) => ({ id, threadId: 'T' + id, labelIds: ['INBOX'], internalDate: '1000', payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: 's' }], mimeType: 'text/plain', body: { data: b64('請匯款') } } });
  const box = { a1: mail('a1', '"me@corp.com" <evil@bad.com>'), a2: mail('a2', 'Me <ME@corp.com>'), a3: mail('a3', 'other@corp.com'), a4: mail('a4', '"x" <second@corp.com>') };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'T' });
    if (u.pathname.endsWith('/labels')) return json({ labels: [{ id: 'INBOX', name: 'INBOX' }] });
    if (u.pathname.endsWith('/profile')) return json({ emailAddress: 'me@corp.com' });
    if (u.pathname.endsWith('/messages')) return json({ messages: Object.values(box).map((m) => ({ id: m.id, threadId: m.threadId })) });
    const t = /threads\/T(\w+)$/.exec(u.pathname); if (t) return json({ messages: [box[t[1]]] });
    return json({}, false);
  };
  await Src.pollGmail(inbox, { gmailSecretDir: d, myAddresses: ['second@corp.com'] }, fetchImpl);
  const dir = (id) => inbox.thread('gmail:T' + id).items[0].direction;
  assert.deepStrictEqual([dir('a1'), dir('a2'), dir('a3'), dir('a4')], ['in', 'out', 'in', 'out']);
  // A saved attachment carries the mark a browser puts on a download; an id with path characters in it stays a plain file name.
  const att = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'T' });
    if (u.pathname.endsWith('/threads/abc123')) return json({ messages: [{ id: '..\\..\\up/9', internalDate: '1', payload: { parts: [{ filename: 'a.docm', mimeType: 'application/x', body: { attachmentId: 'A', size: 3 } }] } }] });
    return json({ data: b64('abc') });
  };
  const dest = path.join(d, 'att');
  const r = await Src.gmailAttachments({ gmailSecretDir: d }, 'gmail:abc123', dest, att);
  assert.deepStrictEqual([r.files.length, path.dirname(r.files[0].path), path.basename(r.files[0].path)], [1, path.join(dest, 'abc123'), 'up9-a.docm']);
  if (process.platform === 'win32') assert.match(fs.readFileSync(r.files[0].path + ':Zone.Identifier', 'utf8'), /ZoneId=3/);
});

test('two attachments of one mail with the same name are two files', async () => {
  const d = tmp();
  const b64 = (x) => Buffer.from(x).toString('base64url');
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'r' }));
  const part = (filename, id, size) => ({ filename, mimeType: 'image/png', body: { attachmentId: id, size } });
  const data = { A: 'first', B: 'second!', C: 'third!!!' };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'T' });
    if (u.pathname.endsWith('/threads/abc777')) return json({ messages: [{ id: 'msg000001', internalDate: '1', payload: { parts: [part('image.png', 'A', 5), part('IMAGE.png', 'B', 7), part('image.png', 'C', 8), part('empty.txt', 'Z', 0), part('gone.txt', 'N', 4)] } }] });
    const m = /attachments\/(\w)$/.exec(u.pathname); return m ? (m[1] === 'Z' ? json({ data: '' }) : m[1] === 'N' ? json({}) : json({ data: b64(data[m[1]]) })) : json({}, false);
  };
  const dest = path.join(d, 'att');
  const a = await Src.gmailAttachments({ gmailSecretDir: d }, 'gmail:abc777', dest, fetchImpl);
  assert.deepStrictEqual(a.files.map((x) => path.basename(x.path)), ['000001-image.png', '000001-IMAGE-2.png', '000001-image-3.png', '000001-empty.txt']);
  assert.deepStrictEqual(a.files.map((x) => fs.readFileSync(x.path, 'utf8')), ['first', 'second!', 'third!!!', '']);          // an empty attachment is saved as an empty file
  assert.deepStrictEqual(a.skipped.map((x) => x.name), ['gone.txt']);                                                        // no content given at all: said, not saved
  const again = await Src.gmailAttachments({ gmailSecretDir: d }, 'gmail:abc777', dest, fetchImpl);          // the same names the second time
  assert.deepStrictEqual(again.files.map((x) => x.path), a.files.map((x) => x.path));
});

test('a file name made from a name somebody else chose never holds a folder separator', () => {
  const BS = String.fromCharCode(92);
  const dest = path.join(os.tmpdir(), 'x', 'abc123');
  for (const n of ['..' + BS + '..' + BS + 'evil.txt', 'a' + BS + 'b.docx', '../../x.txt', 'C:' + BS + 'Windows' + BS + 'x.dll', 'a\u0000b\u001f.txt', BS + BS + 'host' + BS + 'share' + BS + 'f.txt', ' . lead.txt . ']) {
    const out = Src.safeName(n);
    assert.ok(!out.includes(BS) && !out.includes('/') && !/[\u0000-\u001f<>:"|?*]/.test(out), JSON.stringify(n) + ' -> ' + JSON.stringify(out));
    assert.strictEqual(path.dirname(path.join(dest, 'm-' + out)), dest);
  }
  assert.deepStrictEqual([Src.safeName('報價單 v2.xlsx'), Src.safeName(''), Src.safeName('...')], ['報價單 v2.xlsx', 'attachment', 'attachment']);
});

test('settings saved before the switches existed keep the inbox and every source on; the sources are a list', async () => {
  const d = tmp();
  const config = require('../lib/config');
  config.setValue('inbox', { pollMinutes: 5, gmailDays: 3 }, path.join(d, 'b.db'));        // as the earlier version left them
  const svc = new InboxService({ db: path.join(d, 'b.db'), secretDir: d, oldEnv: '', fetch: async () => json({}) });
  const s = svc.settings();
  assert.deepStrictEqual([s.enabled, s.gmailOn, s.slackOn, s.teamsOn, s.pollMinutes, s.gmailDays], [true, true, true, true, 5, 3]);
  assert.strictEqual(config.value('inbox', null, path.join(d, 'b.db')).enabled, true);     // written down once, not decided again each time
  svc.saveSettings({ enabled: false });
  assert.deepStrictEqual([new InboxService({ db: path.join(d, 'b.db'), secretDir: d, oldEnv: '' }).settings().enabled, (await svc.poll()).off], [false, true]);   // turned off stays off
  // every source says what it is in the same words; the page and the settings are made from this
  for (const x of Src.list) {
    assert.deepStrictEqual([typeof x.id, typeof x.name, ['mail', 'chat'].includes(x.kind), typeof x.routeHint, typeof x.poll, typeof x.status, Array.isArray(x.fields)], ['string', 'string', true, 'string', 'function', 'function', true], x.id);
    for (const f of x.fields) assert.ok(f.key && f.label && ['text', 'number', 'password'].includes(f.type) && f.def !== undefined && (f.type !== 'number' || (f.min <= f.def && f.def <= f.max)), x.id + '.' + f.key);
  }
  assert.deepStrictEqual(Src.ids, ['gmail', 'slack', 'teams']);
  const st = svc.status();
  assert.deepStrictEqual([st.enabled, st.sources.map((x) => x.id + ':' + x.on).join(' '), st.sources[1].fields.find((f) => f.key === 'slackToken').secret], [false, 'gmail:false slack:false teams:false', true]);
  assert.strictEqual(svc.inbox.saveRoute({ source: 'line', source_ref: 'x' }).error, '來源只能是 Gmail、Slack、Teams 其中一個');
});

test('attachments are kept for a set number of days from the last hand-over; handing over again renews them', async () => {
  const d = tmp(), DAY = 86400000, now = Date.now();
  const svc = new InboxService({ db: path.join(d, 'b.db'), secretDir: d, oldEnv: '' });
  const dir = svc.attachDir();
  const put = (tid, name, ageDays) => { const p = path.join(dir, tid); fs.mkdirSync(p, { recursive: true }); const f = path.join(p, name); fs.writeFileSync(f, 'x'.repeat(10)); const t = new Date(now - ageDays * DAY); fs.utimesSync(f, t, t); return f; };
  const old = put('aaaaaa01', 'a.pdf', 40), young = put('aaaaaa02', 'b.pdf', 5);
  const renewed = put('aaaaaa03', 'c.pdf', 40); put('aaaaaa03', '.kept', 2);                 // fetched long ago, handed over again two days ago
  const notMine = put('not-a-thread', 'keep.txt', 400);                                       // not named like a thread: never touched
  assert.strictEqual(svc.settings().attachDays, 30);
  assert.deepStrictEqual(svc.purgeAttachments(now), { removed: 1, bytes: 10, kept: 2 });
  assert.deepStrictEqual([fs.existsSync(old), fs.existsSync(young), fs.existsSync(renewed), fs.existsSync(notMine)], [false, true, true, true]);
  assert.deepStrictEqual([svc.saveSettings({ attachDays: 0 }).ok, svc.saveSettings({ attachDays: 3 }).ok], [false, true]);
  assert.deepStrictEqual(svc.purgeAttachments(now), { removed: 1, bytes: 10, kept: 1 });      // three days: the five-day-old one goes, the one renewed two days ago stays
  // the board does this by itself, also with the inbox off, and not more often than once a day
  put('aaaaaa04', 'd.pdf', 9);
  assert.deepStrictEqual([svc.enabled(), svc.tick(now), fs.existsSync(path.join(dir, 'aaaaaa04')), svc.status().lastPurge.removed], [false, false, false, 1]);
  put('aaaaaa05', 'e.pdf', 9); svc.tick(now + 23 * 3600000);
  assert.strictEqual(fs.existsSync(path.join(dir, 'aaaaaa05')), true);
  svc.tick(now + 25 * 3600000);
  assert.strictEqual(fs.existsSync(path.join(dir, 'aaaaaa05')), false);
});

test('InboxService: a source is fetched once connected; 刪除連接 lets go of what it was signed in with', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'sec' } }));
  const svc = new InboxService({ db: path.join(d, 'b.db'), secretDir: d, oldEnv: '', tokenFile: path.join(d, 'gmail-token.json'), fetch: async () => json({}) });
  // settings saved back when each source had a box to tick, none ticked: none counts as taken away now
  require('../lib/config').setValue('inbox', { enabled: true, gmailOn: false, slackOn: false, teamsOn: false }, path.join(d, 'b.db'));
  assert.deepStrictEqual([svc.settings().gmailOn, svc.settings().slackOn, svc.settings().teamsOn], [true, true, true]);
  // Gmail: the board's own token is deleted, and Gmail is not read even with customer-hub's token still there
  fs.writeFileSync(path.join(d, 'gmail-token.json'), JSON.stringify({ refresh_token: 'mine' }));
  fs.writeFileSync(path.join(d, 'token.json'), JSON.stringify({ refresh_token: 'hub' }));
  svc.disconnect('gmail');
  assert.deepStrictEqual([fs.existsSync(path.join(d, 'gmail-token.json')), fs.existsSync(path.join(d, 'token.json')), svc.settings().gmailOn], [false, true, false]);
  assert.deepStrictEqual((await svc.poll('gmail')).results.map((x) => [x.source, x.off]), [['gmail', true]]);
  // Slack: the token is cleared; a token given again is the connection made again
  svc.saveSettings({ slackToken: 'xoxb-1' }); svc.disconnect('slack');
  assert.deepStrictEqual([svc.settings().slackToken, svc.settings().slackOn], ['', false]);
  svc.saveSettings({ slackToken: 'xoxb-2' });
  assert.deepStrictEqual([svc.settings().slackToken, svc.settings().slackOn], ['xoxb-2', true]);
  // a later saving of the settings does not bring a taken-away source back
  svc.saveSettings({ pollMinutes: 5 });
  assert.strictEqual(svc.settings().gmailOn, false);
});

test('InboxService: the sources say whether they are connected with the inbox off; taking one away first thing keeps the rest (review 2026-11-21)', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'credentials.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'sec' } }));
  fs.writeFileSync(path.join(d, 'gmail-token.json'), JSON.stringify({ refresh_token: 'mine' }));
  const db = path.join(d, 'b.db');
  // settings from before, never read yet: the first thing done is a disconnect
  require('../lib/config').setValue('inbox', { enabled: false, gmailOn: false, slackOn: false, teamsOn: false }, db);
  const svc = new InboxService({ db, secretDir: d, oldEnv: '', tokenFile: path.join(d, 'gmail-token.json'), fetch: async () => json({}) });
  svc.disconnect('slack');
  assert.deepStrictEqual([svc.settings().enabled, svc.settings().gmailOn, svc.settings().slackOn, svc.settings().teamsOn], [false, true, false, true], 'the inbox stays off; only Slack taken away');
  // with the inbox off, Gmail still says it is connected (its token is there); Slack says it was taken away
  const st = svc.status();
  assert.deepStrictEqual([st.gmail.configured, st.slack.text], [true, '已刪除連接']);
});
