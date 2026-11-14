#!/usr/bin/env node
'use strict';
// What a click on a notification runs: `node focus-click.js sessionboard:<session id>`.
// Asks the board to take you there: a terminal session's window comes to the
// front; a conversation on the board (which has no window) is opened in the
// browser. The board is started first if it is not running.
//
//   --dry   print what would be done, do nothing
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { getToken, portFromArgs, HOST } = require('../server');

const dry = process.argv.includes('--dry');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';
// Windows may add a trailing slash to the address.
const sid = arg.replace(/^sessionboard:/i, '').replace(/[/\\]+$/, '').trim();
const port = portFromArgs([]);
const token = getToken();

function call(method, p, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port, path: p, method, timeout: 20000, headers: { 'x-board-token': token, 'content-type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const openPage = (hash) => spawn('cmd', ['/c', 'start', '', `http://${HOST}:${port}/?t=${token}#${hash}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

// One line per click in ~/.claude/session-board/focus.log (what was asked, what was done; no titles, no
// message text), so "I clicked and nothing happened" can be looked into. Started over when it passes 200 KB.
function note(o) {
  try {
    const f = path.join(require('os').homedir(), '.claude', 'session-board', 'focus.log');
    const fs = require('fs');
    try { if (fs.statSync(f).size > 200 * 1024) fs.truncateSync(f, 0); } catch (e) {}
    fs.appendFileSync(f, new Date().toISOString() + ' ' + sid.slice(0, 8) + ' ' + o.did + (o.why ? ' (' + o.why + ')' : '') + '\n');
  } catch (e) {}
}

(async () => {
  const say = (o) => { if (dry) console.log(JSON.stringify(o)); else note(o); };
  if (!/^[0-9a-f-]{8,64}$/i.test(sid)) { say({ did: 'nothing', why: 'not a session id' }); return; }
  let list = await call('GET', '/api/sessions');
  if (!list) {
    if (dry) { say({ did: 'would start the board first' }); return; }
    try { execFileSync(process.execPath, [path.join(__dirname, 'start.js')], { windowsHide: true, stdio: 'ignore', timeout: 20000 }); } catch (e) {}
    list = await call('GET', '/api/sessions');
  }
  const s = list && list.body && Array.isArray(list.body.sessions) ? list.body.sessions.find((x) => x.sessionId === sid) : null;
  if (!s) { say({ did: 'open the board', why: 'that session is not open any more' }); if (!dry) openPage(''); return; }
  if (s.owner === 'terminal' && !s.headless) {
    if (dry) { say({ did: 'bring its terminal window to the front', title: s.title }); return; }
    const r = await call('POST', '/api/focus', { sessionId: sid });
    // No window found for it (closed, or two with the same title): the board's page of it is the next best place.
    const hit = r && r.body && r.body.state === 'hit';
    say({ did: hit ? 'brought its terminal window to the front' : 'opened it on the board page', why: hit ? '' : 'no single window found: ' + ((r && r.body && r.body.state) || 'no answer') });
    if (!hit) openPage(sid);
    return;
  }
  say({ did: 'open it on the board page', title: s.title, owner: s.owner });
  if (!dry) openPage(sid);
})();
