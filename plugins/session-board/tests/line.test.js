'use strict';
// node --test plugins/session-board/tests/line.test.js - the LINE secretary (lib/line.js) with stand-ins for LINE,
// the board and the model
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const L = require('../lib/line');

const SECRET = 'ff'.repeat(16), ME = 'U' + 'a'.repeat(32), OTHER = 'U' + 'b'.repeat(32);
const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
const ev = (text, o = {}) => ({ type: 'message', webhookEventId: o.id || crypto.randomUUID(), replyToken: 'rt-' + text, source: { type: 'user', userId: o.from || ME }, message: { type: 'text', id: 'm' + Math.random(), text } });
const body = (...events) => Buffer.from(JSON.stringify({ destination: 'x', events }));

function rig(answers) {
  const sent = [], boardCalls = [], prompts = [];
  const sessions = [
    { sessionId: 's1', title: 'Ebilling 費率表', cwd: 'C:\\work\\Ebilling', status: 'idle', owner: 'board', activeAt: 3000, lastUser: '看費率表', lastAssistant: '費率表有三處要改' },
    { sessionId: 's2', title: 'KMS 報告', cwd: 'C:\\work\\KMS', status: 'waiting', owner: 'board', activeAt: 2000 },
    { sessionId: 's3', title: '終端機那個', cwd: 'C:\\work\\T', status: 'busy', owner: 'terminal', activeAt: 1000 },
  ];
  const board = async (method, p, b) => {
    boardCalls.push(method + ' ' + p + (b ? ' ' + JSON.stringify(b) : ''));
    if (p === '/api/sessions') return { status: 200, json: { sessions } };
    if (method === 'STREAM') return { events: p.includes('s2') ? [{ type: 'permission', requestId: 'r9', tool: 'Bash', text: 'rm -rf build' }] : [] };
    if (p.startsWith('/api/messages')) return { status: 200, json: { items: [{ role: 'user', text: '改費率' }, { role: 'assistant', text: '改好了兩處，第三處要你決定' }] } };
    if (p === '/api/new') return { status: 200, json: { ok: true, sessionId: 'n1' } };
    return { status: 200, json: { ok: true } };
  };
  const ask = async (system, prompt) => { prompts.push(prompt); const a = answers.shift(); return a === undefined ? { ok: false, error: 'no more' } : { ok: true, text: typeof a === 'string' ? a : JSON.stringify(a) }; };
  const line = async (p, b) => { sent.push({ p, b }); return { status: 200, json: {} }; };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'line-test-')), 'state.json');
  const sec = new L.Secretary({ config: { secret: SECRET, token: 't', userId: ME }, board, ask, line, stateFile });
  const said = () => sent.filter((x) => /message\/(reply|push)/.test(x.p)).map((x) => x.b.messages.map((m) => m.text).join(''));
  return { sec, sent, said, boardCalls, prompts, stateFile };
}
const hook = async (r, raw, sig) => { const code = r.sec.hook(raw, sig === undefined ? sign(raw) : sig); await r.sec.queue; return code; };

test('only a body signed with the channel secret, and only your messages', async () => {
  const r = rig([{ reply: '好', action: null }]);
  const raw = body(ev('嗨'));
  assert.strictEqual(await hook(r, raw, 'bad'), 401);
  assert.strictEqual(await hook(r, raw, ''), 401);
  assert.strictEqual(await hook(r, Buffer.from(raw.toString().replace('嗨', '哈')), sign(raw)), 401, 'a body changed after signing');
  assert.strictEqual(await hook(r, body(ev('你好', { from: OTHER }))), 200, 'someone else: answered 200, ignored');
  assert.strictEqual(r.prompts.length, 0);
  assert.strictEqual(await hook(r, raw), 200);
  assert.deepStrictEqual(r.said(), ['好']);
  // a redelivery of the same event is not answered twice
  await hook(r, raw); assert.strictEqual(r.said().length, 1);
  // what the model is given: the board's conversations, the waiting approval, the time
  assert.match(r.prompts[0], /#1 「Ebilling 費率表」 資料夾：C:\\work\\Ebilling 狀態：閒置 owner：board/);
  assert.match(r.prompts[0], /對話 #2 的請求 r9：Bash rm -rf build/);
  assert.match(r.prompts[0], /^現在時間：/);
  assert.ok(!r.boardCalls.some((c) => c.startsWith('STREAM') && c.includes('s3')), 'a terminal session has no board stream');
});

test('a change waits for your yes, shown in the program\'s own words; no and anything else drop it', async () => {
  const r = rig([
    { reply: '我請 Ebilling 那個先列出要改的地方', action: { type: 'send', n: 1, text: '把費率表要改的地方列出來，先不要改' } },
    { reply: '好', action: { type: 'stop', n: 1 } },
    { reply: '換一件事', action: null },
  ]);
  await hook(r, body(ev('叫 ebilling 列出要改的')));
  assert.match(r.said()[0], /要我這樣做嗎？\n送給 「Ebilling 費率表」（Ebilling）：\n把費率表要改的地方列出來，先不要改/);
  assert.ok(!r.boardCalls.some((c) => c.startsWith('POST /api/send')), 'not sent yet');
  await hook(r, body(ev('好')));
  assert.ok(r.boardCalls.includes('POST /api/send {"sessionId":"s1","text":"把費率表要改的地方列出來，先不要改"}'));
  assert.strictEqual(r.said()[1], '已送出。');
  assert.strictEqual(r.prompts.length, 1, 'the yes was decided without the model');
  // no
  await hook(r, body(ev('停掉 ebilling')));
  await hook(r, body(ev('不要')));
  assert.ok(!r.boardCalls.some((c) => c.startsWith('POST /api/stop')));
  assert.match(r.said()[3], /取消了/);
  // a yes with nothing waiting is just a message for the model
  await hook(r, body(ev('好')));
  assert.strictEqual(r.prompts.length, 3);
  // the history of the exchange is kept on disk for the next question
  assert.ok(JSON.parse(fs.readFileSync(r.stateFile, 'utf8')).history.length >= 8);
});

test('what cannot be done is said, not offered: a terminal session, an unknown folder, a question form, an old yes', async () => {
  const r = rig([
    { reply: '', action: { type: 'send', n: 3, text: 'x' } },
    { reply: '', action: { type: 'new', folder: 'C:\\Windows', text: 'x' } },
    { reply: '', action: { type: 'answer', n: 2, requestId: 'nope', allow: true } },
    { reply: '開在 KMS', action: { type: 'new', folder: 'c:\\work\\kms', text: '整理 SIT 結果' } },
  ]);
  await hook(r, body(ev('a'))); await hook(r, body(ev('b'))); await hook(r, body(ev('c')));
  const s = r.said();
  assert.match(s[0], /開在終端機視窗，看板不能替它送訊息/);
  assert.match(s[1], /不在看板上出現過的資料夾裡/);
  assert.match(s[2], /找不到那個等你核准的請求/);
  assert.strictEqual(r.sec.state.pending, null);
  await hook(r, body(ev('d')));
  assert.match(r.said()[3], /在「C:\\work\\KMS」開新對話，交代：\n整理 SIT 結果/, 'the folder as the board has it');
  r.sec.state.pending.at -= 11 * 60000;   // ten minutes went by
  await hook(r, body(ev('好')));
  assert.ok(!r.boardCalls.some((c) => c.startsWith('POST /api/new')), 'a yes after the change expired does nothing');
});

test('approve a waiting request; read a conversation before answering', async () => {
  const r = rig([
    { reply: '', action: { type: 'answer', n: 2, requestId: 'r9', allow: true } },
    { reply: '', action: { type: 'read', n: 1 } },
    { reply: 'Ebilling 改好兩處，第三處等你決定', action: { type: 'read', n: 1 } },
  ]);
  await hook(r, body(ev('KMS 那個核准')));
  assert.match(r.said()[0], /核准 「KMS 報告」（KMS） 的請求：Bash rm -rf build/);
  await hook(r, body(ev('ok')));
  assert.ok(r.boardCalls.includes('POST /api/permission {"sessionId":"s2","requestId":"r9","allow":true}'));
  await hook(r, body(ev('ebilling 做到哪')));
  assert.match(r.prompts[r.prompts.length - 1], /Claude：改好了兩處，第三處要你決定/);
  assert.strictEqual(r.said()[2], 'Ebilling 改好兩處，第三處等你決定', 'a second read is not followed');
});

test('a model that does not answer in JSON, or fails: still a reply', async () => {
  const r = rig(['就是一般的話']);
  await hook(r, body(ev('x')));
  await hook(r, body(ev('y')));
  assert.deepStrictEqual(r.said(), ['就是一般的話', '出錯了：小秘書想不出來（no more）']);
});

test('the reply token while it is fresh, a push after; long answers split', async () => {
  const r = rig([{ reply: '字'.repeat(6000), action: null }]);
  let t = 0; r.sec.now = () => t;
  const raw = body(ev('x'));
  assert.strictEqual(r.sec.hook(raw, sign(raw)), 200);
  t = 60000; await r.sec.queue;   // answered a minute after: the reply token is too old
  const m = r.sent.filter((x) => /message\//.test(x.p));
  assert.deepStrictEqual([m[0].p, m[0].b.to, m[0].b.messages.length, m[0].b.messages[0].text.length], ['/v2/bot/message/push', ME, 2, 4900]);
});

test('the listener answers one path only, and is not started without its settings', async () => {
  assert.strictEqual(L.start({ config: { secret: '', token: 't', userId: ME } }), null);
  const r = rig([{ reply: '在', action: null }]);
  const s = L.start({ config: { secret: SECRET, token: 't', userId: ME }, secretary: r.sec, port: 0 });
  await new Promise((ok) => s.once('listening', ok));
  const port = s.address().port;
  const ask = (method, p, raw, headers = {}) => new Promise((ok) => { const q = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); }); if (raw) q.write(raw); q.end(); });
  const raw = body(ev('在嗎'));
  assert.strictEqual(await ask('GET', '/line/webhook'), 404);
  assert.strictEqual(await ask('POST', '/api/sessions', raw, { 'x-line-signature': sign(raw) }), 404);
  assert.strictEqual(await ask('POST', '/line/webhook', raw, { 'x-line-signature': 'x' }), 401);
  assert.strictEqual(await ask('POST', '/line/webhook', raw, { 'x-line-signature': sign(raw) }), 200);
  await r.sec.queue; assert.deepStrictEqual(r.said(), ['在']);
  s.close();
});

test('a conversation keeps its number when the list order changes', async () => {
  const r = rig([{ reply: 'a', action: null }, { reply: '', action: { type: 'stop', n: 1 } }]);
  await hook(r, body(ev('x')));
  assert.match(r.prompts[0], /#1 「Ebilling/);
  // KMS is now the newest: listed first, still #2; Ebilling still #1
  const sessions = (await r.sec.board('GET', '/api/sessions')).json.sessions; sessions[1].activeAt = 9999;
  await hook(r, body(ev('停掉 #1')));
  assert.ok(r.prompts[1].indexOf('#2 「KMS') < r.prompts[1].indexOf('#1 「Ebilling'), 'KMS listed first');
  assert.match(r.said()[1], /停止 「Ebilling 費率表」/);
});

test('no user id yet: only the claim code, before it expires, binds its sender; then only that person is answered', async () => {
  const r = rig([{ reply: '在', action: null }]);
  const bound = [];
  r.sec.conf = { secret: SECRET, token: 't', userId: '', claimCode: '482913', claimUntil: Date.now() + 60000 };
  r.sec.claim = (u) => bound.push(u);
  await hook(r, body(ev('看板有什麼', { from: OTHER })));
  await hook(r, body(ev('111111', { from: OTHER })));
  assert.deepStrictEqual([bound, r.said(), r.prompts.length], [[], [], 0], 'nothing before the code');
  await hook(r, body(ev(' 482913 ', { from: ME })));
  assert.deepStrictEqual(bound, [ME]);
  assert.match(r.said()[0], /綁定好了/);
  await hook(r, body(ev('482913', { from: OTHER })));
  assert.deepStrictEqual(bound, [ME], 'the code works once');
  await hook(r, body(ev('在嗎', { from: ME })));
  assert.deepStrictEqual(r.said().slice(1), ['在']);
  // one message LINE delivered again counts once against the code
  const r4 = rig([]); r4.sec.conf = { secret: SECRET, token: 't', userId: '', claimCode: '555000', claimUntil: Date.now() + 60000 }; r4.sec.claim = () => {};
  for (let i = 0; i < L.CLAIM_TRIES + 2; i++) await hook(r4, body(ev('hello', { id: 'same-event' })));
  assert.strictEqual(r4.sec.misses.n, 1, 'a redelivery is not another try');
  // guessing: after CLAIM_TRIES wrong messages the code is dead, even the right one binds no one; a new code is open again
  const r3 = rig([]); const b3 = [];
  r3.sec.conf = { secret: SECRET, token: 't', userId: '', claimCode: '482913', claimUntil: Date.now() + 60000 }; r3.sec.claim = (u) => b3.push(u);
  for (let i = 0; i < L.CLAIM_TRIES; i++) await hook(r3, body(ev(String(100000 + i), { from: OTHER })));
  await hook(r3, body(ev('482913')));
  assert.deepStrictEqual([b3, r3.said()], [[], []], 'the code is dead after ' + L.CLAIM_TRIES + ' wrong tries');
  r3.sec.conf.claimCode = '771100';
  await hook(r3, body(ev('771100')));
  assert.deepStrictEqual(b3, [ME], 'a new code is open again');
  // an expired code binds no one
  const r2 = rig([]); const b2 = [];
  r2.sec.conf = { secret: SECRET, token: 't', userId: '', claimCode: '482913', claimUntil: Date.now() - 1 }; r2.sec.claim = (u) => b2.push(u);
  await hook(r2, body(ev('482913')));
  assert.deepStrictEqual([b2, r2.said()], [[], []]);
});

test('claimFor writes the user id into line.json and removes the code, keeping the rest', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'line-claim-')), 'line.json');
  fs.writeFileSync(f, JSON.stringify({ channelSecret: 's', channelToken: 't', claimCode: '1', claimUntil: 9 }));
  L.claimFor(f, ME);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { channelSecret: 's', channelToken: 't', userId: ME });
  assert.strictEqual(L.loadConfig({ conf: f, goal2Conf: path.join(path.dirname(f), 'none.json') }).userId, ME);
});

test("goal2's LINE settings are found beside it in the monorepo and in the plugin cache, newest version first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-goal2-'));
  const rel = path.join('skills', 'delaylocal', 'notify-line.config.json');
  // installed: <market>/session-board/0.12.0/lib beside <market>/goal2/<versions>
  const here = path.join(root, 'market', 'session-board', '0.12.0', 'lib');
  for (const v of ['0.5.0', '0.10.0', 'tmp']) { fs.mkdirSync(path.join(root, 'market', 'goal2', v, 'skills', 'delaylocal'), { recursive: true }); }
  const list = L.goal2Confs(here);
  assert.deepStrictEqual(list, [path.join(root, 'market', 'session-board', 'goal2', rel), path.join(root, 'market', 'goal2', '0.10.0', rel), path.join(root, 'market', 'goal2', '0.5.0', rel)]);
  // the monorepo: plugins/session-board/lib beside plugins/goal2
  assert.strictEqual(L.goal2Confs(path.join(root, 'plugins', 'session-board', 'lib'))[0], path.join(root, 'plugins', 'goal2', rel));
});

test('a claim code made after it started is read again, without restarting it', async () => {
  const r = rig([]); const bound = [];
  r.sec.conf = { secret: SECRET, token: 't', userId: '' };
  let onDisk = { secret: SECRET, token: 't', userId: '' };
  r.sec.reload = () => Object.assign({}, onDisk); r.sec.claim = (u) => bound.push(u);
  await hook(r, body(ev('123456')));
  assert.deepStrictEqual(bound, []);
  onDisk = { secret: SECRET, token: 't', userId: '', claimCode: '123456', claimUntil: Date.now() + 60000 };
  await hook(r, body(ev('123456')));
  assert.deepStrictEqual(bound, [ME]);
  // settings with another secret are not taken up mid-way
  const r2 = rig([]); r2.sec.conf = { secret: SECRET, token: 't', userId: '' };
  r2.sec.reload = () => ({ secret: 'other', token: 't', userId: OTHER });
  await hook(r2, body(ev('hi', { from: OTHER })));
  assert.strictEqual(r2.sec.conf.userId, '');
});
