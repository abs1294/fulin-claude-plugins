'use strict';
// The board as an app on a phone's home screen (asked 2026-11-26: Chrome Remote Desktop's icon opens on its own, the
// board's opened a new tab in the phone's browser every time).
//
// An app added to the home screen does not share the browser's storage (iPhone: a home-screen app starts with none),
// so the key the browser keeps is not there. The key is never put into an address (server.js /api/view); the app is
// given a ticket instead: the page, which has the key, asks for one (POST /api/app/ticket) and puts it in the app's
// start address (the manifest's start_url, and the address the page is at - what an iPhone keeps when no manifest is
// read). Opened from the home screen with no key, the page hands the ticket in (POST /app/redeem, from one of your
// devices only, like everything else) and gets the key - once: a ticket used is gone, and one not used within
// TTL is too. What is kept on disk is the ticket's hash, not the ticket.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL = 24 * 3600 * 1000;
const MAX = 100;   // made only on phones (the page asks on a touch screen), one per opening: room for a day of them
const ID = /^[a-f0-9]{48}$/;
const hash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');

class AppTickets {
  constructor(file, o = {}) { this.file = file; this.now = o.now || Date.now; this.list = this._read(); }
  _read() { try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(j) ? j.filter((x) => x && typeof x.h === 'string' && Number.isFinite(x.at)) : []; } catch (e) { return []; } }
  _save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.list)); } catch (e) {} }
  _prune() { const t = this.now(); this.list = this.list.filter((x) => t - x.at < TTL).slice(-MAX); }
  // -> a new ticket (48 hex characters)
  make() {
    const id = crypto.randomBytes(24).toString('hex');
    this._prune(); this.list.push({ h: hash(id), at: this.now() }); this.list = this.list.slice(-MAX); this._save();
    return id;
  }
  // -> true once for a ticket made within TTL; it is gone after
  use(id) {
    if (!ID.test(String(id || ''))) return false;
    this._prune();
    const h = hash(id), i = this.list.findIndex((x) => x.h === h);
    if (i < 0) { this._save(); return false; }
    this.list.splice(i, 1); this._save();
    return true;
  }
}

// The manifest: what the home screen shows and opens. ticket: put into the start address (only one of the right shape).
function manifest(ticket) {
  const t = ID.test(String(ticket || '')) ? String(ticket) : '';
  return {
    name: 'Session 看板', short_name: '看板', description: '這台電腦所有 Claude Code 對話的看板',
    start_url: t ? '/?app=' + t : '/', scope: '/', display: 'standalone',
    background_color: '#ffffff', theme_color: '#ffffff',
    icons: [180, 192, 512].map((n) => ({ src: '/icons/app-' + n + '.png', sizes: n + 'x' + n, type: 'image/png', purpose: 'any' })),
  };
}

module.exports = { AppTickets, manifest, TTL, ID };
