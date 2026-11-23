'use strict';
// A site that listens only on this computer (http://localhost:57570), opened from another device of yours.
//
// On that device "localhost" is the device itself, so a link to it in a conversation opens nothing (reported 2026-11-23).
// While the board is reached through Tailscale, pressing such a link has the board listen on the same port of this
// computer's Tailscale address, and pass what comes there on to the site. Nothing is opened until a link is pressed; who
// may use it is checked request by request, as for the board itself (lib/remote.js Gate: only devices signed in to the
// same account); an hour without use and it closes. The board itself - this one or another - is never passed on: what
// arrives at it from 127.0.0.1 counts as you sitting at this computer.
//
// The site sees itself asked for as localhost (Host, Origin, Referer): many development servers answer nothing else.
// Where it sends the browser on to another port of localhost (http to https, commonly), that port is opened the same way.
// Not changed: addresses of localhost written inside the site's own pages and scripts.
const http = require('http');
const https = require('https');
const net = require('net');

const IDLE_MS = 60 * 60000, MAX = 12, WAIT = 1500;
const LOOP = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

const answers = (host, port) => new Promise((done) => { const s = net.connect({ host, port }); const end = (v) => { s.destroy(); done(v); }; s.setTimeout(WAIT, () => end(false)); s.once('connect', () => end(true)); s.once('error', () => end(false)); });
const isBoard = (host, port) => new Promise((done) => { const q = http.get({ host, port, path: '/api/ping', timeout: WAIT, headers: { host: '127.0.0.1:' + port } }, (r) => { let t = ''; r.on('data', (c) => { if (t.length < 4096) t += c; }); r.on('end', () => done(/"app"\s*:\s*"session-board"/.test(t))); r.on('error', () => done(false)); }); q.on('timeout', () => q.destroy()); q.on('error', () => done(false)); });

class LocalWeb {
  // o: {ip() -> this computer's Tailscale address or '', names() -> the names it goes by there, allows(addr) -> Promise<bool>, never: [ports]}
  constructor(o) { this.o = o; this.map = new Map(); this.opening = new Map(); this.timer = null; }

  // -> {ok, port} | {ok: false, error}
  open(port, secure) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return Promise.resolve({ ok: false, error: '埠號不對' });
    if (this.opening.has(p)) return this.opening.get(p);
    const job = this._open(p, secure === true).finally(() => this.opening.delete(p));
    this.opening.set(p, job); return job;
  }
  async _open(p, secure) {
    const had = this.map.get(p);
    if (had && had.secure === secure) { had.at = Date.now(); if (await answers(had.host, p)) return { ok: true, port: p }; this.close(p); }
    else if (had) this.close(p);
    const ip = this.o.ip();
    if (!ip) return { ok: false, error: '看板現在沒有透過 Tailscale 開放，沒辦法轉過去' };
    if ((this.o.never || []).includes(p)) return { ok: false, error: '這是看板自己的埠，不轉' };
    const host = (await answers('127.0.0.1', p)) ? '127.0.0.1' : (await answers('::1', p)) ? '::1' : '';
    if (!host) return { ok: false, error: '看板那台電腦的 ' + p + ' 埠現在沒有網站在執行' };
    if (await isBoard(host, p)) return { ok: false, error: '這是看板自己的埠，不轉' };
    // the site itself listens on every address of this computer: your devices reach it without the board, which then opens
    // and passes on nothing - who else may reach it is the site's own doing, as before (asked of it, not told by
    // the listen below failing: Windows lets one address be taken on top of all of them)
    if (await answers(ip, p)) return { ok: true, port: p, direct: true };
    if (this.map.size >= MAX) { const old = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at)[0]; this.close(old[0]); }
    const e = { host, secure, at: Date.now(), socks: new Set() };
    e.server = http.createServer((q, r) => { this._pass(e, p, q, r).catch(() => { try { r.writeHead(502); r.end(); } catch (x) {} }); });
    e.server.on('upgrade', (q, s, head) => { this._upgrade(e, p, q, s, head).catch(() => s.destroy()); });
    e.server.on('connection', (s) => { e.socks.add(s); s.on('close', () => e.socks.delete(s)); s.on('error', () => {}); });
    e.server.requestTimeout = 0;
    const err = await new Promise((done) => { e.server.once('error', done); e.server.listen(p, ip, () => done(null)); });
    if (err) {
      return { ok: false, error: err.code === 'EADDRINUSE' ? p + ' 埠已經被別的程式占用' : '開不了 ' + p + ' 埠：' + (err.code || err.message) };
    }
    e.server.on('error', () => {});
    this.map.set(p, e);
    if (!this.timer) { this.timer = setInterval(() => this.sweep(), 60000); if (this.timer.unref) this.timer.unref(); }
    return { ok: true, port: p };
  }
  sweep(now = Date.now()) { for (const [p, e] of this.map) if (now - e.at > IDLE_MS && !e.live) this.close(p); if (!this.map.size && this.timer) { clearInterval(this.timer); this.timer = null; } }
  close(p) { const e = this.map.get(p); if (!e) return; this.map.delete(p); try { e.server.close(); } catch (x) {} for (const s of e.socks) s.destroy(); }
  closeAll() { for (const p of [...this.map.keys()]) this.close(p); if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  // the request is from one of your devices, and asked for by this computer's own name or address there (a name somebody
  // else made point here is not: DNS rebinding)
  async _mine(q, p) {
    const m = /^([^:]+)(?::(\d+))?$/.exec(String(q.headers.host || '')), names = [this.o.ip(), ...this.o.names()].filter(Boolean).map((x) => x.toLowerCase());
    return !!m && names.includes(m[1].toLowerCase()) && (m[2] || '80') === String(p) && await this.o.allows(String(q.socket.remoteAddress || ''));
  }
  _headers(e, p, q) {
    const own = (e.secure ? 'https' : 'http') + '://localhost:' + p, h = Object.assign({}, q.headers, { host: 'localhost:' + p }), seen = 'http://' + q.headers.host;
    for (const k of ['origin', 'referer']) if (typeof h[k] === 'string' && (h[k] === seen || h[k].startsWith(seen + '/'))) h[k] = own + h[k].slice(seen.length);
    for (const k of Object.keys(h)) if (/^(x-forwarded-|tailscale-)/.test(k)) delete h[k];
    return h;
  }
  _opts(e, p, q, headers) { return { host: e.host, port: p, method: q.method, path: q.url, headers, rejectUnauthorized: false, servername: 'localhost', agent: false }; }
  async _pass(e, p, q, r) {
    if (!(await this._mine(q, p))) { r.writeHead(403, { 'Content-Type': 'text/plain' }); return r.end('not one of your devices'); }
    e.at = Date.now();
    const up = (e.secure ? https : http).request(this._opts(e, p, q, this._headers(e, p, q)));
    up.on('error', (x) => { if (r.headersSent) return r.destroy(); r.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); r.end('看板那台電腦的 ' + p + ' 埠沒有回應（' + (x.code || x.message) + '）'); });
    r.on('close', () => up.destroy());
    up.on('response', async (a) => {
      const h = Object.assign({}, a.headers);
      if (h.location) h.location = await this._location(h.location, q);
      // a cookie for localhost, or for https only (this way is http, inside Tailscale's own encryption), would not be kept
      if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map((c) => c.replace(/;\s*domain=\.?(localhost|127\.0\.0\.1)(?=;|$)/i, '').replace(/;\s*samesite=none(?=;|$)/i, '; SameSite=Lax').replace(/;\s*secure(?=;|$)/i, ''));
      delete h['strict-transport-security'];
      try { r.writeHead(a.statusCode, a.statusMessage, h); a.pipe(r); } catch (x) { r.destroy(); }
      a.on('error', () => r.destroy());
    });
    q.pipe(up);
  }
  // sent on to a port of localhost: opened the same way, and named as this device reaches it
  async _location(loc, q) {
    let u; try { u = new URL(loc); } catch (x) { return loc; }
    if (!/^https?:$/.test(u.protocol) || !LOOP.test(u.hostname)) return loc;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80), o = await this.open(port, u.protocol === 'https:').catch(() => null);
    if (!o || !o.ok) return loc;
    return (o.direct && u.protocol === 'https:' ? 'https' : 'http') + '://' + String(q.headers.host).split(':')[0] + ':' + port + u.pathname + u.search + u.hash;
  }
  async _upgrade(e, p, q, s, head) {
    s.on('error', () => {});
    if (!(await this._mine(q, p))) { s.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    e.at = Date.now();
    const up = (e.secure ? https : http).request(this._opts(e, p, q, this._headers(e, p, q)));
    up.on('error', () => s.destroy());
    up.on('response', (a) => { s.end('HTTP/1.1 ' + a.statusCode + ' ' + a.statusMessage + '\r\nConnection: close\r\n\r\n'); a.resume(); });
    up.on('upgrade', (a, us, uh) => {
      e.live = (e.live || 0) + 1; let over = false;
      const end = () => { if (!over) { over = true; e.live--; e.at = Date.now(); } s.destroy(); us.destroy(); };
      us.on('error', end); for (const x of [us, s]) { x.on('close', end); x.on('end', end); }   // (an http server's sockets stay half open)
      const L = ['HTTP/1.1 101 Switching Protocols']; for (let i = 0; i < a.rawHeaders.length; i += 2) L.push(a.rawHeaders[i] + ': ' + a.rawHeaders[i + 1]);
      s.write(L.join('\r\n') + '\r\n\r\n'); if (uh.length) s.write(uh); if (head.length) us.write(head);
      us.pipe(s); s.pipe(us);
    });
    up.end();
  }
}

module.exports = { LocalWeb, IDLE_MS };
