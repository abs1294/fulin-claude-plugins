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

// Windows and macOS (lib/mac.js). Elsewhere it is not known to work.
if (process.platform !== 'win32' && process.platform !== 'darwin') { console.error('session-board 支援 Windows 與 macOS（這台是 ' + process.platform + '）。'); process.exit(1); }
const port = portFromArgs(process.argv);
const args = new Set(process.argv.slice(2));
const LOG = path.join(DATA_DIR, 'server.log');
// A board stopped on purpose is marked, so that the keep-alive task (lib/keepalive.js) leaves it stopped.
const { STOPPED_MARK } = require('../lib/keepalive');
const markStopped = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STOPPED_MARK, String(Date.now())); } catch (e) {} };

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
    if (!running) { markStopped(); console.log('not running'); return; }
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
    const still = await ping();
    if (!still) markStopped();
    console.log(still ? 'still running' : 'stopped');
    return;
  }
  // --keepalive: what the scheduled task runs every few minutes. Nothing to do when the board is there, or when it
  // was stopped on purpose. Any other start means you want it running: the mark goes.
  if (args.has('--keepalive')) { if (running || fs.existsSync(STOPPED_MARK)) return; }
  else { try { fs.unlinkSync(STOPPED_MARK); } catch (e) {} }

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
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  }
})();
