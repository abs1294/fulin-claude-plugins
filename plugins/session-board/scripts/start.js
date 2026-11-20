'use strict';
// Start (or find) the session-board server and print its URL.
//   node start.js            start if not running, print the URL
//   node start.js --open     same, then open the URL in the default browser
//   node start.js --status   print whether it is running; exit 1 if not
//   node start.js --stop     ask the running server to exit
//   node start.js --after <pid>   wait for that board process to end, then start (what the board's 「有新版本，點我更新」 runs)
//   node start.js --refresh  bring the installed plugins of this marketplace up to date (plugin-manager's update-all.js,
//                            the same as the board's own "update plugins"), restart the board so it runs what is on
//                            disk now, and say whether it is reachable on Tailscale again. Restarting is refused - and
//                            nothing is restarted - while a conversation on the board would lose work (like --stop).
// The server is started detached, so it outlives the session that started it.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getToken, portFromArgs, HOST, DATA_DIR } = require('../server');

// Windows and macOS (lib/mac.js). Elsewhere it is not known to work.
if (process.platform !== 'win32' && process.platform !== 'darwin') { console.error('session-board 支援 Windows 與 macOS（這台是 ' + process.platform + '）。'); process.exit(1); }
const port = portFromArgs(process.argv);
const args = new Set(process.argv.slice(2));
const LOG = path.join(DATA_DIR, 'server.log');
// A board stopped on purpose is marked, so that the keep-alive task (lib/keepalive.js) leaves it stopped.
const { STOPPED_MARK, RESTARTING, RESTARTING_MS } = require('../lib/keepalive');
const markStopped = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STOPPED_MARK, String(Date.now())); } catch (e) {} };

function request(method, p, token, body) {
  return new Promise((resolve) => {
    // 5 s: a board just started, or busy with a moment's work, answers late; given up on, it is taken for not running,
    // and a second one is started that cannot get the port (seen 2026-11-19 with 1.5 s)
    const req = http.request({ host: HOST, port, path: p, method, timeout: 5000,
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
// Where the server is started from: this plugin's folder, or after --refresh the newest installed version's
let boardRoot = path.join(__dirname, '..');

(async () => {
  const token = getToken();
  const url = `http://${HOST}:${port}/?t=${token}`;
  // --after <pid>: started by the board itself (server.js /api/restart) just before it ends: wait for that process to be
  // gone (up to 30 s), then start as usual - from this folder, which the board chose as the newest installed version.
  const ai = process.argv.indexOf('--after'), after = ai >= 0 ? Number(process.argv[ai + 1]) : 0;
  if (Number.isInteger(after) && after > 0) {
    const alive = () => { try { process.kill(after, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    for (let i = 0; i < 150 && alive(); i++) await sleep(200);
    for (let i = 0; i < 25 && await ping(); i++) await sleep(200);   // its port let go too
  }
  let running = await ping();

  if (args.has('--status')) {
    console.log(running ? `running  version=${running.version} pid=${running.pid}  ${url}` : 'not running');
    process.exit(running ? 0 : 1);
  }
  if (args.has('--refresh')) {
    // 1. the plugins. Given 110 s: this runs inside a skill's "!" command, whose own time limit is not known here
    //    (HYPOTHESIS: about two minutes) - cut off by that, it would say nothing; cut off by this, it says so. Seen
    //    2026-11-19: about 50 s with updates to make. Run again, update-all compares every install with the newest
    //    version again, so what was brought up to date is not done twice (an install cut off half way: HYPOTHESIS that
    //    it shows as behind and is done again). Stopped this way, `claude plugin update` started by it may still be
    //    running: the board is then not restarted, so it does not start from a folder being written.
    const Plugins = require('../lib/plugins');
    const pm = Plugins.rootOf('plugin-manager', Plugins.installed());
    if (!pm) console.log('plugins: not updated - plugin-manager is not installed on this computer');
    else {
      const u = spawnSync(process.execPath, [path.join(pm, 'scripts', 'update-all.js'), '--apply', '--json'], { encoding: 'utf8', timeout: 110000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const timedOut = !!(u.error && u.error.code === 'ETIMEDOUT');
      const x = timedOut ? { ok: false, error: 'took over 110 s and was stopped (an install it started may still be going)', restart: [] }
        : Plugins.updateResult(u.stdout, u.status, u.stderr || (u.error && u.error.message));
      console.log(x.ok ? 'plugins: ' + (x.summary || 'all up to date') : 'plugins: update failed - ' + x.error);
      if (timedOut) { console.log(running ? 'board: NOT restarted - it keeps running ' + running.version + '. Run /session-board again in a minute or two.' : 'board: NOT started (it was not running) - run /session-board again in a minute or two.'); process.exit(2); }
      if (x.restart.length) console.log('plugins: Claude Code sessions to start again for the new versions: ' + x.restart.join(', '));
      // session-board itself may be one of those updated: a new version is a new folder, so the start below runs the
      // newest one (on the developer's machine, the monorepo copy - the same as here)
      boardRoot = Plugins.rootOf('session-board', Plugins.installed(), path.join(__dirname, '..')) || boardRoot;
    }
    // 2. the board: stopped (never forced), so the start below runs the code on disk now. Asked a few times: right after
    //    the update the board can be slow to answer (seen 2026-11-19: no answer within the 1.5 s the request waits).
    if (running) {
      let r = null;
      for (let i = 0; i < 4 && !r; i++) { r = await request('POST', '/api/shutdown', token, { force: false }); if (!r) await sleep(1000); }
      if (!r) { console.error('board: no answer to the request to stop; it keeps running ' + running.version); process.exit(1); }
      if (r && r.status === 409 && r.body && Array.isArray(r.body.active)) {
        console.log('board: NOT restarted - ' + r.body.active.length + ' conversation(s) on it would lose work:');
        for (const a of r.body.active) console.log('  - ' + a.status + ': ' + String(a.title || a.sessionId).slice(0, 60));
        console.log('It keeps running ' + running.version + '. Run /session-board again once they are done (an assistant must not add --force on its own).');
        process.exit(2);
      }
      for (let i = 0; i < 60 && await ping(); i++) await sleep(150);
      if (await ping()) { console.error('board: asked to stop (answer ' + r.status + ') but still running after 9 s'); process.exit(1); }
      console.log('board: stopped ' + running.version + ', starting again');
      running = null;
    }
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
      // Read by whoever ran it - often an assistant asked to "close the board": the choice to end that work is the user's.
      console.log('Wait for them to finish. --force stops anyway and ends that work; add it only when the user has said to stop regardless (an assistant must not add it on its own - tell the user this list instead).');
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
  const restarting = (() => { try { return Date.now() - fs.statSync(RESTARTING).mtimeMs < RESTARTING_MS; } catch (e) { return false; } })();
  if (args.has('--keepalive')) { if (running || fs.existsSync(STOPPED_MARK) || restarting) return; }
  else { try { fs.unlinkSync(STOPPED_MARK); } catch (e) {} }
  if (!args.has('--keepalive')) { try { fs.unlinkSync(RESTARTING); } catch (e) {} }

  if (!running) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // The log only ever gets a start line and crash output; start it over once it passes 1 MB.
    try { if (fs.statSync(LOG).size > 1048576) fs.truncateSync(LOG, 0); } catch (e) {}
    const out = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [path.join(boardRoot, 'server.js'), '--port', String(port)],
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
  const mine = require(path.join(boardRoot, '.claude-plugin', 'plugin.json')).version;
  if (running.version !== mine) console.log(`NOTE: the running server is ${running.version}, this plugin is ${mine}. Run with --stop, then start again, to switch.`);
  console.log(url);
  // 3. Tailscale: the board listens there again by itself when the setting is on (server.js keepRemote); wait for it a little
  if (args.has('--refresh')) {
    let rm = null;
    for (let i = 0; i < 20; i++) {
      const c = await request('GET', '/api/config', token);
      rm = c && c.body && c.body.remote;
      if (!rm || !rm.on || rm.listening) break;
      await sleep(500);
    }
    if (!rm) console.log('tailscale: could not ask the board');
    else if (!rm.on) console.log('tailscale: off (reaching the board from other devices is switched off in its settings)');
    else if (rm.listening) console.log('tailscale: listening on http://' + rm.ip + ':' + port + '/' + (rm.name ? ' (' + rm.name + ')' : ''));
    else console.log('tailscale: not listening yet' + (rm.error ? ' - ' + rm.error : '') + ' (the board tries again by itself every so often)');
  }
  if (args.has('--open')) {
    // "start" needs the empty title argument, or it takes the URL as the title.
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  }
})();
