'use strict';
// node --test plugins/session-board/tests/server.test.js
// The server itself, started for real on a free port, with a made-up home folder (set before anything is loaded,
// because the modules work out their folders when they are loaded).
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-test-'));
process.env.USERPROFILE = HOME; process.env.HOME = HOME;
fs.mkdirSync(path.join(HOME, '.claude', 'session-board'), { recursive: true });

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');
const { createServer, sendPage, endedReader, readEnded } = require('../server');
const F = require('../lib/files');
const { Monthly, keepMost } = require('../lib/monthly');
const { Channels } = require('../lib/chat');

const TOKEN = 'ab'.repeat(24);
let server, port;
// The server answers only when asked by its own address, port included, so the port is picked first.
const freePort = () => new Promise((r) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
test.before(async () => { port = await freePort(); server = createServer(TOKEN, port, {}); await new Promise((r) => server.listen(port, '127.0.0.1', r)); });
test.after(() => { try { server.close(); server.closeAllConnections && server.closeAllConnections(); } catch (e) {} try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) {} setTimeout(() => process.exit(process.exitCode || 0), 200).unref(); });

const ask = (p, opt = {}) => new Promise((resolve, reject) => {
  const body = opt.body === undefined ? null : JSON.stringify(opt.body);
  const headers = Object.assign({}, opt.token === false ? {} : { 'x-board-token': opt.token || TOKEN }, body ? { 'content-type': 'application/json' } : {}, opt.headers || {});
  const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, text: d, json: j }); }); });
  req.on('error', reject); if (body) req.write(body); req.end();
});

test('server: nothing is answered without the key, or with a wrong one', async () => {
  for (const p of ['/api/sessions', '/api/notices', '/api/config', '/api/watchdog']) {
    assert.strictEqual((await ask(p, { token: false })).status, 401, p + ' without a key');
    assert.strictEqual((await ask(p, { token: 'cd'.repeat(24) })).status, 401, p + ' with a wrong key');
    assert.strictEqual((await ask(p, { token: 'x' })).status, 401, p + ' with a malformed key');
  }
  assert.strictEqual((await ask('/api/send', { token: false, body: { sessionId: 'x', text: 'hi' } })).status, 401);
});

test('server: asked under another name (a page elsewhere pointing a name at this machine), it refuses', async () => {
  assert.strictEqual((await ask('/api/sessions', { headers: { host: 'evil.example:' + port } })).status, 403);
  assert.strictEqual((await ask('/', { token: false, headers: { host: 'evil.example' } })).status, 403);
});

test('server: with the key, the lists answer; an unknown address is 404', async () => {
  const s = await ask('/api/sessions');
  assert.strictEqual(s.status, 200);
  assert.ok(Array.isArray(s.json.sessions));
  assert.strictEqual((await ask('/api/notices')).status, 200);
  assert.strictEqual((await ask('/api/no-such-thing')).status, 404);
});

test('server: the page comes with a policy that names the one script it carries', async () => {
  const r = await ask('/', { token: false });
  assert.strictEqual(r.status, 200);
  const csp = r.headers['content-security-policy'];
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
  assert.ok(nonce.length >= 20);
  assert.ok(r.text.includes('<script nonce="' + nonce + '">'));
  assert.strictEqual((r.text.match(/<script/g) || []).length, 1, 'one script tag, and it has the number');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp) && !/unsafe-eval/.test(csp));
  assert.ok(/default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /base-uri 'none'/.test(csp));
  // the preview frame shows blobs and the board's own PDF address (/api/view/...); nothing from elsewhere
  assert.strictEqual(/frame-src ([^;]+)/.exec(csp)[1], "blob: 'self'");
  assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
  const again = await ask('/', { token: false });
  assert.notStrictEqual(/nonce-([^']+)/.exec(again.headers['content-security-policy'])[1], nonce, 'a new number for every response');
});

test('sendPage: only the first script tag is given the number', () => {
  const res = { writeHead(c, h) { this.code = c; this.h = h; }, end(b) { this.body = b; } };
  sendPage(res, '<p>x</p><script>var a = "<script>";</script>');
  const nonce = /nonce-([^']+)/.exec(res.h['Content-Security-Policy'])[1];
  assert.strictEqual(res.body, '<p>x</p><script nonce="' + nonce + '">var a = "<script>";</script>');
});

test('server: a network path is never opened, shown or previewed', async () => {
  for (const p of ['\\\\host\\share\\a.txt', '//host/share/a.txt']) {
    const c = await ask('/api/files/check', { body: { paths: [p], cwd: HOME } });
    if (c.status === 200) assert.ok(!c.json.files || c.json.files.every((x) => !x), 'not reported as a real file');
    assert.strictEqual(F.realFile(p), null);
  }
});

test('files: a local-looking path that ends on the network is treated as a network path', () => {
  assert.strictEqual(F.leadsToNetwork('C:\\link\\a.txt', () => '\\\\nas\\share\\a.txt'), true);
  assert.strictEqual(F.leadsToNetwork('Z:\\a.txt', () => '\\\\?\\UNC\\nas\\share\\a.txt'), true);
  assert.strictEqual(F.leadsToNetwork('C:\\w\\a.txt', () => 'C:\\w\\a.txt'), false);
  assert.strictEqual(F.leadsToNetwork('C:\\gone.txt', () => { throw new Error('ENOENT'); }), false);
  const f = path.join(HOME, 'plain.txt'); fs.writeFileSync(f, 'x');
  assert.strictEqual(F.realFile(f), path.normalize(f), 'an ordinary local file is still a real file');
});

test('files: old-format Office files are previewed but not opened with one press', () => {
  for (const n of ['a.doc', 'a.xls', 'a.ppt', 'a.rtf', 'a.docm', 'a.xlsm', 'a.html', 'a.svg']) assert.strictEqual(F.canOpen(n), false, n);
  for (const n of ['a.docx', 'a.xlsx', 'a.pptx', 'a.pdf', 'a.png', 'a.md']) assert.strictEqual(F.canOpen(n), true, n);
  assert.strictEqual(F.kindOf('a.doc'), 'office');
});

const month = (ym, cost, extra) => Object.assign({ ok: true, month: ym, computedAt: 1, total: { cost, tok: cost * 1000 }, files: 10, sessions: [{ id: 'S' }] }, extra);

test('monthly keepMost: a later scan that finds less never replaces what was recorded', () => {
  const had = month('2026-08', 100);
  assert.strictEqual(keepMost(had, month('2026-08', 100, { roles: [{ name: 'main', cost: 100 }] })).roles.length, 1, 'covers the same: taken whole');
  const part = keepMost(had, month('2026-08', 40, { computedAt: 9, roles: [{ name: 'main', cost: 40 }] }));
  assert.strictEqual(part.total.cost, 100); assert.strictEqual(part.rolesCover, 40); assert.strictEqual(part.roles[0].cost, 40); assert.strictEqual(part.rescannedAt, 9);
  const none = keepMost(had, month('2026-08', 0, { roles: [] }));
  assert.strictEqual(none.total.cost, 100); assert.deepStrictEqual(none.roles, []); assert.strictEqual(none.rolesCover, 0);
  const full = month('2026-08', 100, { roles: [{ name: 'main', cost: 100 }] });
  assert.strictEqual(keepMost(full, month('2026-08', 40, { roles: [{ name: 'main', cost: 40 }] })).roles[0].cost, 100, 'complete role figures are not replaced by partial ones');
});

test('monthly addRoles: months stored without role figures are scanned once, and not again', async () => {
  const dbFile = path.join(HOME, 'm.db');
  const calls = [];
  const found = { '2026-08': month('2026-08', 30, { roles: [{ name: 'main', cost: 30 }] }), '2026-09': month('2026-09', 0, { roles: [] }) };
  const run = (exe, args, opts, cb) => { calls.push(args[1]); cb(null, JSON.stringify(found[args[1]])); };
  const m = new Monthly({ db: dbFile, legacyDir: null, run, now: () => new Date(2026, 10, 16) });
  m._write(m._db(), month('2026-08', 100), false);
  m._write(m._db(), month('2026-09', 200), false);
  m._write(m._db(), month('2026-10', 50, { roles: [{ name: 'main', cost: 50 }] }), false);
  assert.deepStrictEqual((await m.addRoles()).sort(), ['2026-08', '2026-09']);
  assert.deepStrictEqual(calls.sort(), ['2026-08', '2026-09']);
  const fresh = new Monthly({ db: dbFile, legacyDir: null, run, now: () => new Date(2026, 10, 16) });
  const aug = fresh._disk('2026-08'), sep = fresh._disk('2026-09');
  assert.strictEqual(aug.total.cost, 100); assert.strictEqual(aug.rolesCover, 30);
  assert.strictEqual(sep.total.cost, 200); assert.deepStrictEqual(sep.roles, []);
  assert.deepStrictEqual(await fresh.addRoles(), [], 'nothing left to ask for');
});

test('Channels: a process that cannot be started says so and leaves the conversation usable', () => {
  const made = [];
  const spawn = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = Object.assign(new EventEmitter(), { write() { return true; }, end() {} }); p.kill = () => {}; made.push(p); return p; };
  const ch = new Channels(path.join(HOME, 'c.json'), { spawn, transcriptOf: () => null });
  const c = ch.create(HOME);
  const res = { events: [], write(s) { const m = /^data: (.*)\n\n$/.exec(s); if (m) this.events.push(JSON.parse(m[1])); }, end() {}, on() {} };
  ch.subscribe(c.sessionId, res);
  ch.send(c.sessionId, 'hello');
  assert.strictEqual(ch.status(c), 'busy');
  made[0].emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  assert.notStrictEqual(ch.status(c), 'busy', 'no longer looks as if it were working');
  const err = res.events.filter((e) => e.type === 'error').pop();
  assert.ok(err && /找不到 claude/.test(err.text), JSON.stringify(err));
  ch.send(c.sessionId, 'again');
  assert.strictEqual(made.length, 2, 'the next message starts a process again');
  ch.shutdown && ch.shutdown();
});

test('endedReader: the notes of ended sessions kept in memory, only what was added or rewritten read again', async () => {
  const fs = require('fs'), path = require('path'), os = require('os');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ended-'));
  const w = (id, at, reason) => fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify({ sessionId: id, reason, at }));
  w('aaaaaaaa-1', Date.now(), 'exit'); w('bbbbbbbb-2', Date.now() - 40 * 86400000, 'old');
  const read = endedReader(d);
  try {
    assert.deepStrictEqual([...read().keys()], [], 'the first full read goes on in the background: nothing yet, and no wait');
    await read.ready();
    assert.deepStrictEqual([...read().keys()], ['aaaaaaaa-1']);
    assert.ok(!fs.existsSync(path.join(d, 'bbbbbbbb-2.json')), 'a note over a month old is removed');
    w('cccccccc-3', Date.now(), 'new'); w('aaaaaaaa-1', Date.now(), 'again');   // one added, one rewritten (ended again)
    await new Promise((r) => setTimeout(r, 300));
    const got = (m) => [...m].map(([k, v]) => k + ':' + v.reason).sort();
    assert.deepStrictEqual(got(read()), ['aaaaaaaa-1:again', 'cccccccc-3:new']);
    assert.deepStrictEqual(got(read()), got(readEnded(d)), 'the same as reading them all');
  } finally { read.close(); }
});
