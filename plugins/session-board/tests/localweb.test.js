'use strict';
// node --test plugins/session-board/tests/localweb.test.js
// A site of this computer's localhost passed on to another device (lib/localweb.js). 127.0.0.2 stands for the Tailscale
// address (Windows and Linux answer all of 127/8; a Mac does not: skipped there).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http'), crypto = require('crypto');
const { LocalWeb, IDLE_MS } = require('../lib/localweb');
const IP = '127.0.0.2', SKIP = { skip: process.platform === 'darwin' && 'a Mac has no 127.0.0.2' };
const listen = (s, host = '127.0.0.1', port = 0) => new Promise((r) => s.listen(port, host, () => r(s.address().port)));
const get = (port, path, headers, host = IP, method = 'GET', body) => new Promise((done, bad) => { const q = http.request({ host, port, path, method, headers: Object.assign({ host: IP + ':' + port }, headers), agent: false }, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => done({ code: r.statusCode, h: r.headers, t })); }); q.on('error', bad); q.end(body); });
const make = (more) => { let let_in = true; const w = new LocalWeb(Object.assign({ ip: () => IP, names: () => ['pc.ts.net', 'pc'], allows: async () => let_in, never: [] }, more)); w.gate = (v) => { let_in = v; }; return w; };

test('a page of localhost, seen as localhost by the site; only from your devices and by this computer\'s own name', SKIP, async (t) => {
  const site = http.createServer((q, r) => {
    if (q.url === '/other') { r.writeHead(302, { location: 'http://localhost:' + p2 + '/in?a=1' }); return r.end(); }
    if (q.url === '/out') { r.writeHead(302, { location: 'https://example.com/x' }); return r.end(); }
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { r.setHeader('set-cookie', ['a=1; Domain=localhost; Path=/; Secure; SameSite=None']); r.setHeader('strict-transport-security', 'max-age=1'); r.end(JSON.stringify({ u: q.url, m: q.method, h: q.headers, b })); });
  });
  const site2 = http.createServer((q, r) => r.end('second')); const p2 = await listen(site2), p = await listen(site), w = make();
  t.after(() => { w.closeAll(); site.close(); site2.close(); });
  assert.deepStrictEqual(await w.open(p), { ok: true, port: p });
  assert.deepStrictEqual(await w.open(p), { ok: true, port: p }, 'pressed again');
  const a = await get(p, '/x?y=1', { origin: 'http://' + IP + ':' + p, referer: 'http://' + IP + ':' + p + '/z', 'x-forwarded-for': '1.2.3.4' }, IP, 'POST', 'hi'), j = JSON.parse(a.t);
  assert.deepStrictEqual([j.u, j.m, j.b, j.h.host, j.h.origin, j.h.referer, j.h['x-forwarded-for']], ['/x?y=1', 'POST', 'hi', 'localhost:' + p, 'http://localhost:' + p, 'http://localhost:' + p + '/z', undefined]);
  assert.deepStrictEqual([a.h['set-cookie'], a.h['strict-transport-security']], [['a=1; Path=/; SameSite=Lax'], undefined]);
  // an origin that is not the page's own is left as it is: the site can still turn it away
  assert.strictEqual(JSON.parse((await get(p, '/', { origin: 'http://evil.example' })).t).h.origin, 'http://evil.example');
  const o = await get(p, '/other'); assert.strictEqual(o.h.location, 'http://' + IP + ':' + p2 + '/in?a=1'); assert.strictEqual((await get(p2, '/in')).t, 'second');
  assert.strictEqual((await get(p, '/out')).h.location, 'https://example.com/x');
  assert.strictEqual((await get(p, '/', { host: 'pc.ts.net:' + p })).code, 200);
  assert.strictEqual((await get(p, '/', { host: 'evil.example:' + p })).code, 403, 'a name somebody made point here');
  w.gate(false); assert.strictEqual((await get(p, '/')).code, 403, 'not one of your devices');
});

test('what is not passed on: nothing there, the board, Tailscale off; a site gone is said', SKIP, async (t) => {
  const board = http.createServer((q, r) => r.end('{"app":"session-board"}')), bp = await listen(board), site = http.createServer((q, r) => r.end('x')), p = await listen(site);
  const w = make({ never: [1234] }); t.after(() => { w.closeAll(); board.close(); site.close(); });
  assert.match((await w.open(bp)).error, /看板自己的埠/); assert.match((await w.open(1234)).error, /看板自己的埠/);
  for (const x of [0, 70000, 'x', 1.5]) assert.strictEqual((await w.open(x)).ok, false);
  const gone = http.createServer(() => {}), gp = await listen(gone); await new Promise((r) => gone.close(r));
  assert.match((await w.open(gp)).error, /沒有網站在執行/);
  assert.match((await make({ ip: () => '' }).open(p)).error, /Tailscale/);
  assert.strictEqual((await w.open(p)).ok, true); site.closeAllConnections(); await new Promise((r) => site.close(r));
  const r = await get(p, '/'); assert.deepStrictEqual([r.code, /沒有回應/.test(r.t)], [502, true]);
  assert.match((await w.open(p)).error, /沒有網站在執行/); assert.strictEqual(w.map.size, 0);
});

test('a site that listens on every address itself is reached without the board', SKIP, async (t) => {
  const site = http.createServer((q, r) => r.end('own')), p = await listen(site, '0.0.0.0'), w = make(); t.after(() => { w.closeAll(); site.close(); });
  assert.deepStrictEqual([await w.open(p), w.map.size], [{ ok: true, port: p, direct: true }, 0]);
});

test('web sockets pass; an hour without use and it closes', SKIP, async (t) => {
  const site = http.createServer((q, r) => r.end('x'));
  site.on('upgrade', (q, s) => { s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Host: ' + q.headers.host + '\r\n\r\n'); s.on('data', (d) => s.write('echo ' + d)); s.on('error', () => {}); });
  const p = await listen(site), w = make(); t.after(() => { w.closeAll(); site.close(); site.closeAllConnections(); });
  await w.open(p);
  const got = await new Promise((done, bad) => { const q = http.request({ host: IP, port: p, path: '/ws', headers: { host: IP + ':' + p, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') } }); q.on('upgrade', (a, s) => { s.on('data', (d) => { done([a.headers['x-host'], String(d), w.map.get(p).live]); s.destroy(); }); s.write('hi'); }); q.on('response', (r) => bad(new Error('http ' + r.statusCode))); q.on('error', bad); q.end(); });
  assert.deepStrictEqual(got, ['localhost:' + p, 'echo hi', 1]);
  await new Promise((r) => setTimeout(r, 80)); assert.strictEqual(w.map.get(p).live, 0);
  w.sweep(Date.now() + IDLE_MS - 1000); assert.strictEqual(w.map.size, 1);
  w.sweep(Date.now() + IDLE_MS + 1000); assert.strictEqual(w.map.size, 0);
  await assert.rejects(get(p, '/'));
});
