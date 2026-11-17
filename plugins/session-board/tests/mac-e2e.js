'use strict';
// The macOS parts of the board, run for real on a Mac (GitHub's macOS machines: .github/workflows/session-board-mac.yml).
// Not part of `node --test`: it opens Terminal windows, sends notifications and loads LaunchAgents.
// A stand-in `claude` (put first on PATH by the workflow) writes down where it was started and with what, then waits,
// so the Terminal tab it runs in can be looked for. Prints one line per check and a JSON summary; exits 1 on a failure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');
const Mac = require('../lib/mac');

const ROOT = path.join(__dirname, '..');
const MARK = process.env.FAKE_CLAUDE_MARK || path.join(os.tmpdir(), 'fake-claude.log');
const results = [];
const check = async (name, fn) => {
  try { const v = await fn(); results.push({ name, ok: true, detail: v }); console.log('PASS  ' + name + (v ? '  ' + JSON.stringify(v) : '')); }
  catch (e) { results.push({ name, ok: false, detail: String(e.message || e) }); console.log('FAIL  ' + name + '  ' + String(e.message || e)); }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 500) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(step); } return null; };
const get = (port, p, token) => new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port, path: p, headers: token ? { 'x-board-token': token } : {} }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); }); r.on('error', (e) => resolve({ status: 0, body: String(e.message) })); });
const post = (port, p, token, body) => new Promise((resolve) => { const b = Buffer.from(JSON.stringify(body)); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'x-board-token': token, 'content-type': 'application/json', 'content-length': b.length } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); }); r.on('error', (e) => resolve({ status: 0, body: String(e.message) })); r.write(b); r.end(); });

(async () => {
  console.log('platform ' + process.platform + ' ' + os.release() + ' | node ' + process.version);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb mac e2e '));   // a space in the path, on purpose
  const SID = '11111111-2222-4333-8444-555555555555';
  try { fs.unlinkSync(MARK); } catch (e) {}

  // ── 1. the board starts and answers ──
  const PORT = 4419;
  let token = '';
  await check('start.js starts the board on a Mac', async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'start.js'), '--port', String(PORT)], { stdio: 'pipe', timeout: 60000 });
    const ok = await until(() => true, 1);
    const ping = await get(PORT, '/api/ping');
    must(ping.status === 200 && /session-board/.test(ping.body), 'ping: ' + ping.status + ' ' + ping.body.slice(0, 200));
    token = fs.readFileSync(path.join(os.homedir(), '.claude', 'session-board', 'token'), 'utf8').trim();
    return { ping: JSON.parse(ping.body).version, ok };
  });
  await check('the page and the session list are served; the board says it is on a Mac', async () => {
    const page = await get(PORT, '/');
    must(page.status === 200 && /<title>/.test(page.body), 'page ' + page.status);
    const s = await get(PORT, '/api/sessions', token);
    must(s.status === 200, 'sessions ' + s.status + ' ' + s.body.slice(0, 200));
    const j = JSON.parse(s.body);
    must(j.features && j.features.platform === 'darwin', 'platform: ' + JSON.stringify(j.features && j.features.platform));
    return { sessions: j.sessions.length, platform: j.features.platform };
  });
  await check('settings: autostart and keep-alive answer (LaunchAgent, not the Windows Startup folder)', async () => {
    const c = await get(PORT, '/api/config', token);
    must(c.status === 200, 'config ' + c.status);
    const j = JSON.parse(c.body);
    return { autoStart: j.autoStart, autoStartFile: j.autoStartFile, keepAlive: j.keepAlive };
  });

  // ── 2. a conversation opened in Terminal.app ──
  let pid = 0;
  await check('Terminal opens the .command file: it goes to the folder and runs claude --resume <id>', async () => {
    const file = Mac.writeLauncher(path.join(work, 'launch'), work, SID, 'claude', true, '接著做');
    const o = await Mac.openTerminal(file);
    must(o.ok, 'open: ' + JSON.stringify(o));
    const seen = await until(() => { try { return fs.readFileSync(MARK, 'utf8'); } catch (e) { return ''; } }, 45000);
    must(seen, 'the stand-in claude never ran within 45 s');
    const line = seen.trim().split('\n').pop();
    must(line.includes('cwd=' + work), 'wrong folder: ' + line);
    must(line.includes('--resume ' + SID) && line.includes('接著做'), 'wrong arguments: ' + line);
    pid = Number((/pid=(\d+)/.exec(line) || [])[1]) || 0;
    return { line };
  });
  await check('diagnosis: osascript talking to Terminal directly (error text and time)', async () => {
    const t0 = Date.now();
    try { const o = execFileSync('osascript', ['-e', 'tell application "Terminal" to count windows'], { encoding: 'utf8', timeout: 30000 }); return { ok: true, windows: o.trim(), ms: Date.now() - t0 }; }
    catch (e) { throw new Error('ms=' + (Date.now() - t0) + ' signal=' + e.signal + ' status=' + e.status + ' stderr=' + String(e.stderr || '').trim() + ' stdout=' + String(e.stdout || '').trim()); }
  });
  await check('the tty of that claude, and its Terminal tab brought to the front', async () => {
    must(pid, 'no pid from the stand-in');
    const tty = await Mac.ttyOf(pid);
    must(tty, 'no tty for pid ' + pid);
    const f = await Mac.focus(pid);
    must(f.state === 'hit', JSON.stringify(f));
    return { tty, focus: f.state };
  });
  await check('the command line of that process (ps)', async () => {
    const m = await Mac.commandLines([pid]);
    must(m[pid] && /--resume/.test(m[pid]), JSON.stringify(m));
    return { cmd: m[pid].slice(0, 120) };
  });
  await check('the board finds the session through its API: /api/focus with the pid (focus by tty)', async () => {
    // registered the way Claude Code registers a session, so the board lists it as a terminal session
    const dir = path.join(os.homedir(), '.claude', 'sessions'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, sessionId: SID, cwd: work, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli' }));
    const listed = await until(async () => false, 1);
    await sleep(3000);
    const s = JSON.parse((await get(PORT, '/api/sessions', token)).body);
    const me = s.sessions.find((x) => x.sessionId === SID);
    must(me, 'not listed: ' + s.sessions.map((x) => x.sessionId).join(','));
    const r = await post(PORT, '/api/focus', token, { sessionId: SID });
    const j = JSON.parse(r.body);
    must(r.status === 200 && j.state === 'hit', r.status + ' ' + r.body.slice(0, 200));
    return { owner: me.owner, status: me.status, focus: j.state, listed };
  });

  // ── 3. Finder, open, notifications ──
  const doc = path.join(work, 'a file.txt'); fs.writeFileSync(doc, 'hello');
  await check('show in Finder (open -R) through the board', async () => {
    const r = await post(PORT, '/api/file/reveal', token, { path: doc });
    must(r.status === 200, r.status + ' ' + r.body.slice(0, 200));
    return JSON.parse(r.body);
  });
  await check('open with the default program (open) through the board', async () => {
    const r = await post(PORT, '/api/file/open', token, { path: doc });
    must(r.status === 200, r.status + ' ' + r.body.slice(0, 200));
    return JSON.parse(r.body);
  });
  await check('a notification (Notification Center via osascript)', async () => {
    const r = await Mac.notify('session-board 測試', '這是 macOS 實機測試送出的通知 "quoted" & more');
    must(r.ok, r.err);
    return { ok: true };
  });

  // ── 4. LaunchAgents ──
  for (const k of ['start', 'keep']) {
    await check('LaunchAgent "' + k + '": loaded, listed by launchctl, then removed', async () => {
      const on = Mac.setAgent(k, true, path.join(ROOT, 'scripts', 'start.js'));
      must(on.ok && on.on, JSON.stringify(on));
      const list = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
      must(list.includes(Mac.LABEL[k]), 'not in launchctl list');
      const lint = execFileSync('plutil', ['-lint', Mac.agentFile(k)], { encoding: 'utf8' }).trim();
      const off = Mac.setAgent(k, false, path.join(ROOT, 'scripts', 'start.js'));
      must(off.ok && !off.on, JSON.stringify(off));
      return { lint };
    });
  }

  // ── 5. Office preview: LibreOffice, or a clear answer ──
  await check('Office preview answers clearly (LibreOffice ' + (Mac.soffice() ? 'installed' : 'not installed') + ')', async () => {
    const r = await Mac.convertOffice(path.join(work, 'none.docx'), path.join(work, 'none.pdf'));
    must(!r.ok && r.error, JSON.stringify(r));
    return { error: r.error.slice(0, 80) };
  });

  // ── 6. a screenshot of the screen, for a look ──
  await check('screenshot', async () => { execFileSync('screencapture', ['-x', path.join(process.env.SHOTS || os.tmpdir(), 'mac-screen.png')]); return {}; });

  // ── 7. the board stops ──
  await check('start.js --stop stops it', async () => {
    try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'start.js'), '--stop', '--port', String(PORT)], { stdio: 'pipe', timeout: 60000 }); } catch (e) { throw new Error(String(e.stdout || '') + String(e.stderr || '')); }
    await sleep(1500);
    const ping = await get(PORT, '/api/ping');
    must(ping.status === 0, 'still answering');
    return {};
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\nSUMMARY ' + JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name + ': ' + f.detail) }));
  process.exit(failed.length ? 1 : 0);
})();
