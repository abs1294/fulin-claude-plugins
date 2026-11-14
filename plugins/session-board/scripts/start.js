'use strict';
// Start (or find) the session-board server and print its URL.
//   node start.js            start if not running, print the URL
//   node start.js --open     same, then open the URL in the default browser
//   node start.js --status   print whether it is running; exit 1 if not
//   node start.js --stop     ask the running server to exit
// The server is started detached, so it outlives the session that started it.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getToken, portFromArgs, HOST, DATA_DIR } = require('../server');

// Windows only: the board finds and moves Windows Terminal windows, and reads Windows-only places.
if (process.platform !== 'win32') { console.error('session-board 只支援 Windows（這台是 ' + process.platform + '）。'); process.exit(1); }
const port = portFromArgs(process.argv);
const args = new Set(process.argv.slice(2));
const LOG = path.join(DATA_DIR, 'server.log');

function request(method, p, token, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port, path: p, method, timeout: 1500,
      headers: token ? { 'x-board-token': token, 'content-type': 'application/json' } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(method === 'POST' ? JSON.stringify(body || {}) : undefined);
  });
}

async function ping() {
  const r = await request('GET', '/api/ping');
  return r && r.body && r.body.app === 'session-board' ? r.body : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const token = getToken();
  const url = `http://${HOST}:${port}/?t=${token}`;
  let running = await ping();

  if (args.has('--status')) {
    console.log(running ? `running  version=${running.version} pid=${running.pid}  ${url}` : 'not running');
    process.exit(running ? 0 : 1);
  }
  if (args.has('--stop')) {
    if (!running) { console.log('not running'); return; }
    // The server refuses to stop while a conversation it runs is working or has
    // background work going: stopping would end that work. --force overrides.
    const r = await request('POST', '/api/shutdown', token, { force: args.has('--force') });
    if (r && r.status === 409 && r.body && Array.isArray(r.body.active)) {
      console.log('NOT stopped: ' + r.body.active.length + ' conversation(s) on the board would lose work:');
      const word = { busy: 'working', waiting: 'waiting for your answer', background: 'has background work running' };
      for (const a of r.body.active) console.log('  - ' + (word[a.status] || a.status) + (a.tasks ? ' (' + a.tasks + ' task(s))' : '') + ': ' + String(a.title || a.sessionId).slice(0, 60));
      console.log('Wait for them to finish, or run again with --force to stop anyway.');
      process.exit(2);
    }
    for (let i = 0; i < 20 && await ping(); i++) await sleep(150);
    console.log(await ping() ? 'still running' : 'stopped');
    return;
  }

  if (!running) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // The log only ever gets a start line and crash output; start it over once it passes 1 MB.
    try { if (fs.statSync(LOG).size > 1048576) fs.truncateSync(LOG, 0); } catch (e) {}
    const out = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(port)],
      { detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    for (let i = 0; i < 40 && !(running = await ping()); i++) await sleep(150);
    if (!running) {
      console.error(`session-board did not start. See ${LOG}`);
      process.exit(1);
    }
  }
  console.log(`session-board ${running.version} (pid ${running.pid})`);
  // A server started before a plugin update keeps serving the old code.
  const mine = require('../.claude-plugin/plugin.json').version;
  if (running.version !== mine) console.log(`NOTE: the running server is ${running.version}, this plugin is ${mine}. Run with --stop, then start again, to switch.`);
  console.log(url);
  if (args.has('--open')) {
    // "start" needs the empty title argument, or it takes the URL as the title.
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
})();
