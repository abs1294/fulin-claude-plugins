'use strict';
// node --test plugins/session-board/tests/digest.test.js
// 每天上班統整 (lib/digest.js): nothing open is left out, a reply in Gmail is said as a fact, what Claude reads as done is
// said as a reading, and what could not be looked at is said. Gmail, Claude and LINE are stand-ins.
const test = require('node:test');
const assert = require('node:assert');
const Digest = require('../lib/digest');
const Line = require('../lib/line');
const { Schedules, clean } = require('../lib/schedule');
const { Runner } = require('../lib/schedrun');
const fs = require('fs'), os = require('os'), path = require('path');

const NOW = new Date(2026, 10, 24, 9, 30).getTime(), DAY = 86400000;   // a Tuesday
const inboxOf = (list) => ({ threads: () => list, thread: (id) => ({ items: (list.find((x) => x.thread_id === id) || {}).items || [] }) });
const T = (n, days, more) => Object.assign({ thread_id: 'gmail:' + String(n).repeat(8), source: 'gmail', triage_title: '事' + n, triage_summary: '做' + n, subject: 's' + n, sender: 'a@b.c', last_in_at: NOW - days * DAY, root_folder: '', items: [{ direction: 'in', ts: NOW - days * DAY, body: 'x' }] }, more);
const base = (o) => Object.assign({ now: NOW, talks: async () => [], commits: async () => [], waiting: async () => [], schedules: async () => [], ask: async () => ({ ok: true, text: '{"items":[]}' }) }, o);
const section = (text, name) => { const m = new RegExp('【' + name + ' \\d+】\\n([\\s\\S]*?)(?:\\n\\n|$)').exec(text); return m ? m[1] : ''; };

test('each thing is put where what was found puts it, and none is left out', async () => {
  const list = [T(1, 5), T(2, 6), T(3, 0), T(4, 9), T(5, 8), T(6, 7, { source: 'teams', thread_id: 'teams:x6' })];
  const asked = [];
  const gmail = async (p) => {
    asked.push(p);
    if (p.startsWith('messages?')) return { messages: [{ id: 'm1' }] };
    if (p.startsWith('messages/')) return { internalDate: String(NOW - DAY), payload: { headers: [{ name: 'To', value: 'z@z' }, { name: 'Subject', value: '合約寄出' }] } };
    if (p.startsWith('threads/22222222')) return { messages: [{ labelIds: ['INBOX'], internalDate: String(NOW - 6 * DAY) }, { labelIds: ['SENT'], internalDate: String(NOW - 2 * DAY) }] };
    if (p.startsWith('threads/44444444')) return { messages: [{ labelIds: ['SENT'], internalDate: String(NOW - 12 * DAY) }, { labelIds: ['DRAFT'], internalDate: String(NOW - DAY) }] };   // sent before theirs: no answer to it
    return { messages: [] };
  };
  let prompt = '';
  const r = await Digest.build(base({ inbox: inboxOf(list), gmail, talks: async () => [{ at: NOW - DAY, cwd: 'C:\\w', folder: 'w', title: '改合約', last: '寄了' }],
    commits: async (folders) => { assert.deepStrictEqual(folders, ['C:\\w']); return [{ folder: 'w', text: '2026-11-23 Feat: 合約' }]; },
    waiting: async () => [{ title: '對話甲', folder: 'w', what: '等你核准或回答' }], schedules: async () => [{ name: '日報', time: '18:00' }],
    ask: async (sys, p) => { prompt = p; return { ok: true, text: '好的 {"items":[{"i":1,"state":"done","today":false,"why":"寄出「合約寄出」"},{"i":4,"state":"doing","today":true,"why":"有草稿"},{"i":5,"state":"open","today":false,"why":"要回信"},{"i":99,"state":"done"},{"i":5,"state":"done"}]}' }; } }));
  for (const x of list) assert.strictEqual(r.text.split('・' + x.triage_title).length - 1, 1, x.triage_title + ' is in it, once');
  assert.match(section(r.text, '看起來做完了，還沒標完成'), /事1\n　寄出「合約寄出」/);
  assert.match(section(r.text, '你回過信了，還沒標完成'), /事2（11\/22 回的）/);
  assert.match(section(r.text, '今天要做'), /事3（今天來的）[\s\S]*事4（9 天前來的）\n　做4\n　草稿寫好了，還沒寄\n　做到一半：有草稿/);
  assert.match(section(r.text, '還沒做'), /事5（8 天前來的）\n　要回信[\s\S]*事6/);
  assert.match(r.text, /對話甲（w）：等你核准或回答/); assert.match(r.text, /18:00 日報/);
  assert.match(r.text, /Gmail 寄件 1 封、對話 1 個、commit 1 筆/);
  assert.ok(prompt.includes('合約寄出') && prompt.includes('改合約') && prompt.includes('Feat: 合約'));
  assert.ok(!asked.some((p) => /teams|x6/.test(p)), 'only the Gmail ones are asked about at Gmail');
  assert.match(r.text, /2 件 Claude 沒有判斷到/);   // 事3 and 事6
  assert.deepStrictEqual(r.counts, { today: 2, rest: 2, answered: 1, done: 1, waiting: 1 });
});

test('what could not be looked at is said, and everything is still listed', async () => {
  const list = [T(1, 5), T(2, 6)];
  const r = await Digest.build(base({ inbox: inboxOf(list), gmail: async (p) => { if (p.startsWith('threads/1')) throw new Error('500'); return { messages: [] }; }, poll: async () => ({ results: [{ source: 'gmail', error: 'x' }] }), ask: async () => ({ ok: false, error: '額度用完' }), talks: async () => { throw new Error('no'); } }));
  assert.match(r.text, /事1/); assert.match(r.text, /事2/);
  assert.match(r.text, /這次沒核對到：收件沒抓到最新的：gmail；Gmail 有 1 筆讀不到；對話讀不到；Claude 沒有核對成功（額度用完）/);
  assert.ok(!/看起來做完了，還沒/.test(r.text));
  const none = await Digest.build(base({ inbox: inboxOf([]), ask: async () => { throw new Error('not asked'); } }));
  assert.match(none.text, /收件沒有要你處理的，也沒有對話在等你/);
  assert.match((await Digest.build(base({ inbox: null }))).text, /收件沒有打開/);
  const noGmail = await Digest.build(base({ inbox: inboxOf(list), gmail: null }));
  assert.match(noGmail.text, /Gmail 沒有連上/);
});

test('an answer that is not the one asked for is not used', () => {
  assert.strictEqual(Digest.readVerdict('沒有 JSON', 3), null);
  assert.strictEqual(Digest.readVerdict('{"items":[{"i":0,"state":"done"},{"i":2,"state":"finished"}]}', 3), null);
  assert.deepStrictEqual([...Digest.readVerdict('{"items":[{"i":2,"state":"open","today":"yes","why":"a\\nb"}]}', 3)], [[2, { state: 'open', today: false, why: 'a b' }]]);
});

test('LINE: all of a long message goes out, by whole lines; not connected or refused is said', async () => {
  const conf = { secret: 's', token: 't', userId: 'U1' }, sent = [];
  const line = async (p, body) => { sent.push([p, body]); return { status: 200, json: {} }; };
  const text = Array.from({ length: 900 }, (_, i) => '第 ' + i + ' 行 ' + '字'.repeat(40)).join('\n');
  assert.deepStrictEqual(await Line.push(text, { config: conf, line }), { ok: true });
  const all = sent.flatMap(([, b]) => b.messages.map((m) => m.text));
  assert.strictEqual(all.join('\n'), text);
  assert.ok(sent.length > 1 && sent.every(([p, b]) => p === '/v2/bot/message/push' && b.to === 'U1' && b.messages.length <= 5) && all.every((x) => x.length <= 4900));
  assert.match((await Line.push('x', { config: {}, line })).error, /還沒有接通/);
  assert.match((await Line.push('x', { config: conf, line: async () => ({ status: 429, json: { message: 'monthly limit' } }) })).error, /429.*monthly limit/);
  assert.deepStrictEqual([Line.connected({ config: conf }), Line.connected({ config: { token: 't', userId: 'U' } })], [true, false]);
});

test('its schedule: needs no folder, is put together without holding the round up, and one cut short is not left running', async () => {
  const v = clean({ target: 'digest', kind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:30' }, () => false);
  assert.deepStrictEqual([v.ok, v.value.name, v.value.cwd], [true, '每天上班統整', '']);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-')), S = new Schedules(path.join(d, 'b.db'));
  const id = S.save(v.value, null, 1); let end; const told = [];
  const R = new Runner(S, { digest: () => new Promise((r) => { end = r; }), isDir: () => false, sessions: () => [], channels: {}, tell: (a, b) => told.push(b), newId: () => 'x' });
  await R.fire(S.get(id), NOW, NOW);
  assert.deepStrictEqual([S.runs(id)[0].status, S.runs(id)[0].how], ['running', 'digest']);
  await R.tick(NOW + 1000); assert.strictEqual(S.runs(id)[0].status, 'running', 'the round does not settle it as a conversation');
  end({ ok: true, note: '已用 LINE 送出' }); await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual([S.runs(id)[0].status, S.runs(id)[0].note], ['done', '已用 LINE 送出']);
  await R.fire(S.get(id), NOW + DAY, NOW + DAY); end({ ok: false, error: 'LINE 沒有收下（429）' }); await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(S.runs(id)[0].status, 'failed'); assert.ok(told.some((x) => /LINE 沒有收下/.test(x)), 'you are told when it did not go out');
  await R.fire(S.get(id), NOW + 2 * DAY, NOW + 2 * DAY); S.endStale(NOW + 2 * DAY + 5);
  assert.deepStrictEqual([S.runs(id)[0].status, S.runs(id)[0].note], ['failed', '統整到一半看板關掉了']);
  if (S.db && S.db.close) S.db.close();
});
