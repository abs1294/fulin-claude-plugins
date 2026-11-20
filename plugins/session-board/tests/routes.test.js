'use strict';
// node --test plugins/session-board/tests/routes.test.js
// Every address the server answers, asked for real over HTTP - and, at the end, a check that none was left out:
// the list is read out of server.js itself, so a route added later without a test here fails this file.
//
// Nothing here reaches outside the test: the home folder is made up (set before anything is loaded), Claude is a
// stand-in, and whatever would open a window, start a program, write the registry or end the board is replaced
// through createServer's deps.out. The two "terminal sessions" are processes this test starts itself, so the routes
// that end a session end something real that belongs to the test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-test-'));
process.env.USERPROFILE = HOME; process.env.HOME = HOME;
const CLAUDE = path.join(HOME, '.claude');
for (const d of ['session-board', 'sessions', 'projects']) fs.mkdirSync(path.join(CLAUDE, d), { recursive: true });

const test = require('node:test');
const assert = require('node:assert');
const WIN_ONLY = { skip: process.platform !== 'win32' && 'Windows only: Windows paths and tools (the Mac side: tests/mac.test.js, tests/mac-e2e.js)' };
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { createServer } = require('../server');
const S = require('../lib/sessions');
const { Channels } = require('../lib/chat');
const { Keeper } = require('../lib/keep');
const { InboxService } = require('../lib/inbox');
const { Monthly } = require('../lib/monthly');

const TOKEN = 'ab'.repeat(24);
const WORK = path.join(HOME, 'work'); fs.mkdirSync(WORK);
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const T1 = uuid(1), T2 = uuid(2), PAST = uuid(3), PAST2 = uuid(4);

// ── what stands in for the outside world ──
const did = [];                                   // every outward action asked for, in order
const explained = [];                             // the prompts the 說明 of a harness suggestion was asked with
const procs = [];                                 // Claude processes "started"
const fakeSpawn = (bin, args, opts) => {
  const p = new EventEmitter(); p.pid = 900000 + procs.length; p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.stdin = Object.assign(new EventEmitter(), { written: [], write(s) { try { this.written.push(JSON.parse(s)); } catch (e) { this.written.push(s); } return true; }, end() { setImmediate(() => p.emit('exit', 0)); } });
  p.kill = () => { setImmediate(() => p.emit('exit', null)); }; p.unref = () => {};
  p.out = (o) => p.stdout.emit('data', JSON.stringify(o) + '\n');
  procs.push({ bin, args, opts, p }); did.push('spawn ' + bin);
  return p;
};
const out = {
  spawn: fakeSpawn,
  focusWindow: async (titles, mode) => { did.push('focusWindow ' + (mode || 'focus')); return { state: 'hit', hwnd: 4242 }; },
  closeWindow: async (hwnd) => { did.push('closeWindow ' + hwnd); return { state: 'closed', stillOpen: false }; },
  pickFolder: async () => { did.push('pickFolder'); return WORK; },
  openTerminal: (args) => { did.push('openTerminal ' + args.join(' ')); },
  powershell: async (script) => { did.push('powershell ' + script); return { line: '{"state":"front"}' }; },
  convertOffice: async (src, dst) => { did.push('convertOffice'); fs.writeFileSync(dst, '%PDF-1.4 test'); return { ok: true }; },
  autostart: { isOn: () => out._auto, set: (on) => { did.push('autostart ' + on); out._auto = on; return { ok: true }; }, refresh: () => {}, startupDir: () => HOME, NAME: 'session-board.vbs' },
  Keepalive: { isOn: () => !!out._keep, set: (on) => { did.push('keepalive ' + on); out._keep = on; return { ok: true }; }, refresh: () => {}, EVERY_MIN: 5 },
  Notify: { register: () => { did.push('notify register'); return { ok: true }; }, unregister: () => { did.push('notify unregister'); return { ok: true }; }, isRegistered: () => false, ownChainPresent: () => false },
  kill: (pid) => { did.push('kill ' + pid); process.kill(pid); },
  exit: (code) => { did.push('exit ' + code); },
  gitRun: (cmd, args, opts, cb) => {
    did.push('git ' + args.slice(4).join(' '));
    const a = args.slice(4).join(' ');
    if (out._noRepo) return cb(new Error('fatal: not a git repository'), '', 'fatal: not a git repository (or any of the parent directories): .git');
    if (a === 'rev-parse --show-toplevel') return cb(null, WORK.replace(/\\/g, '/') + '\n', '');
    if (a === 'rev-parse --abbrev-ref HEAD') return cb(null, 'main\n', '');
    if (a.startsWith('status ')) return cb(null, ' M src/a.js\0R  new name.txt\0old name.txt\0?? 新檔.md\0', '');
    if (a.startsWith('diff --numstat')) return cb(null, '3\t1\tsrc/a.js\0' + '0\t0\t\0old name.txt\0new name.txt\0', '');
    if (a === 'diff HEAD -- src/a.js') return cb(null, 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n', '');
    return cb(new Error('unexpected git call: ' + a), '', 'unexpected');
  },
  goalRun: null,
  explain: async (cwd, prompt) => { did.push('explain in ' + path.basename(cwd)); explained.push(prompt); if (prompt.includes('slow')) await new Promise((r) => setTimeout(r, 300)); return { ok: true, answer: '說明 ' + explained.length, cost: 0.01, ms: 5 }; },
  btw: async (sid, cwd, question) => { did.push('btw ' + sid.slice(-2) + ' in ' + path.basename(cwd)); if (question === 'slow') await new Promise((r) => setTimeout(r, 300)); return question === 'fail' ? { ok: false, error: '沒有回答', ms: 1 } : { ok: true, answer: '答：' + question, cost: 0.01, ms: 5 }; },
  shell: async (command, cwd) => { did.push('shell ' + command); return command === 'boom' ? { ok: false, code: null, stdout: '', stderr: '', error: 'stopped', shell: 'bash', ms: 1 } : { ok: true, code: 0, stdout: 'out of ' + command + '\n', stderr: '', shell: 'bash', ms: 1 }; },
};

// ── the made-up machine ──
const children = [];
const sleeper = () => { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); children.push(c); return c; };
const line = (o) => JSON.stringify(o);
const UID = (sid) => 'bbbbbbbb-0000-4000-8000-' + sid.slice(-12);   // the entry that holds the picture
const AID = (sid) => 'aaaaaaaa-0000-4000-8000-' + sid.slice(-12);   // the entry that holds the tool call
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function transcript(sid, cwd, when) {
  const dir = path.join(CLAUDE, 'projects', S.encodeCwd(cwd)); fs.mkdirSync(dir, { recursive: true });
  const ts = new Date(when).toISOString();
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), [
    line({ type: 'user', uuid: UID(sid), sessionId: sid, cwd, timestamp: ts, promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: '請看這張圖 ' + sid.slice(-1) }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } }),
    line({ type: 'assistant', uuid: AID(sid), sessionId: sid, cwd, timestamp: ts, message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo hi' } }], usage: { input_tokens: 10, output_tokens: 20 } } }),
    line({ type: 'user', uuid: 'u2-' + sid, sessionId: sid, cwd, timestamp: ts, toolUseResult: { stdout: 'hi' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hi' }] } }),
    line({ type: 'assistant', uuid: 'a2-' + sid, sessionId: sid, cwd, timestamp: ts, message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '做完了' }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: 'end_turn' } }),
    line({ type: 'user', uuid: 'e1-' + sid, sessionId: sid, cwd, timestamp: new Date(when + 1000).toISOString(), toolUseResult: { filePath: path.join(cwd, 'src', 'a.js'), oldString: 'x', newString: 'y', originalFile: 'x', structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' keep', '-old line', '+new line', '+another'] }], userModified: false, replaceAll: false }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }),
    line({ type: 'user', uuid: 'e2-' + sid, sessionId: sid, cwd, timestamp: new Date(when + 2000).toISOString(), toolUseResult: { filePath: path.join(cwd, 'src', 'a.js'), oldString: 'y', newString: 'z', originalFile: 'y', structuredPatch: [{ oldStart: 9, oldLines: 1, newStart: 10, newLines: 1, lines: ['-second old', '+second new'] }] }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] } }),
    line({ type: 'user', uuid: 'e3-' + sid, sessionId: sid, cwd, timestamp: new Date(when + 3000).toISOString(), toolUseResult: { type: 'create', filePath: path.join(cwd, 'note.md'), content: '# hi\nsecond', structuredPatch: [], originalFile: null }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: 'ok' }] } }),
    line({ type: 'user', uuid: 'e4-' + sid, sessionId: sid, cwd, timestamp: new Date(when + 4000).toISOString(), toolUseResult: { type: 'create', filePath: path.join(HOME, 'elsewhere', 'scratch.txt'), content: 'tmp', structuredPatch: [], originalFile: null }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't5', content: 'ok' }] } }),
    line({ type: 'ai-title', aiTitle: '測試對話 ' + sid.slice(-1), sessionId: sid }),
  ].join('\n') + '\n');
}
function terminalSession(sid) {
  const c = sleeper();
  fs.writeFileSync(path.join(CLAUDE, 'sessions', c.pid + '.json'), JSON.stringify({ pid: c.pid, sessionId: sid, cwd: WORK, startedAt: Date.now(), version: '2.1.325', kind: 'interactive', entrypoint: 'cli', name: 'term ' + sid.slice(-1), status: 'idle', updatedAt: Date.now(), statusUpdatedAt: Date.now() }));
  transcript(sid, WORK, Date.now());
  c.on('exit', () => { try { fs.unlinkSync(path.join(CLAUDE, 'sessions', c.pid + '.json')); } catch (e) {} });   // as Claude Code does when it ends
  return c;
}

let server, port, channels, keeper, inbox, asked = new Set();
const freePort = () => new Promise((r) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
test.before(async () => {
  terminalSession(T1); terminalSession(T2);
  transcript(PAST, WORK, Date.now() - 3600000); transcript(PAST2, WORK, Date.now() - 7200000);
  fs.writeFileSync(path.join(WORK, 'note.md'), '# hi\n'); fs.writeFileSync(path.join(WORK, 'a.docx'), 'not really'); fs.writeFileSync(path.join(WORK, 'run.ps1'), 'x'); fs.writeFileSync(path.join(WORK, 'old.doc'), 'x');
  fs.mkdirSync(path.join(WORK, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(WORK, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: reads the change\n---\nYou review.\n');
  channels = new Channels(path.join(CLAUDE, 'session-board', 'channels.json'), { spawn: fakeSpawn, transcriptOf: (sid, cwd) => S.findTranscript(sid, cwd, S.DEFAULTS.projectsDir) });
  keeper = new Keeper(path.join(CLAUDE, 'session-board', 'keep.json'));
  inbox = new InboxService({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) , text: async () => '' }), triageRun: async () => ({ ok: true, items: [] }) });
  const monthly = new Monthly({ run: (exe, args, opts, cb) => cb(null, JSON.stringify({ ok: true, month: args[1], computedAt: Date.now(), daysInMonth: 30, total: { cost: 12.5, tok: 1000 }, files: 1, sessions: [], roles: [], days: [], models: [], projects: [] })) });
  port = await freePort();
  server = createServer(TOKEN, port, { channels, keeper, inbox, monthly, pluginsInstalled: () => ({ harness: { name: 'harness', installs: [] }, goal2: { name: 'goal2', installs: [] } }), goal2: new (require('../lib/goal2').Goal2)({ root: null }), remoteInfo: async () => ({ ok: false, why: 'test' }), noTimers: true, out, tell: (t, x) => did.push('tell ' + t), peer: async () => ({ ok: true }), peerCheck: async () => true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});
test.after(() => {
  for (const c of children) { try { c.kill(); } catch (e) {} }
  try { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } catch (e) {}
  try { require('../lib/db').close(require('../lib/db').DB_FILE); } catch (e) {}
  setTimeout(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) {} process.exit(process.exitCode || 0); }, 300).unref();
});

const ask = (p, opt = {}) => new Promise((resolve, reject) => {
  asked.add((opt.body === undefined ? 'GET ' : 'POST ') + p.split('?')[0]);
  const body = opt.body === undefined ? null : Buffer.from(JSON.stringify(opt.body), 'utf8');
  const headers = Object.assign({ 'x-board-token': TOKEN }, body ? { 'content-type': 'application/json', 'content-length': body.length } : {}, opt.headers || {});
  const req = http.request(Object.assign({ host: '127.0.0.1', port, path: p, method: opt.method || (body ? 'POST' : 'GET'), headers }, opt.localAddress ? { localAddress: opt.localAddress } : {}), (res) => {
    const parts = []; res.on('data', (c) => { parts.push(c); if (opt.firstChunk) { resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }); req.destroy(); } });
    res.on('end', () => { const buf = Buffer.concat(parts); let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), bytes: buf, json: j || {} }); });
  });
  req.on('error', (e) => { if (!opt.firstChunk) reject(e); }); if (body) req.write(body); req.end();
});
const get = (p) => ask(p);
const post = (p, body) => ask(p, { body: body || {} });
const enc = encodeURIComponent;
const since = (n) => did.slice(n);

test('the rules that hold for every address', async () => {
  assert.strictEqual((await ask('/api/sessions', { method: 'PUT' })).status, 405);
  assert.strictEqual((await ask('/api/new', { method: 'POST', headers: { 'content-type': 'text/plain' } })).status, 415, 'a form from another page cannot post');
  assert.strictEqual((await get('/api/nothing-here')).status, 404);
  assert.strictEqual((await post('/api/nothing-here')).status, 404);
  assert.strictEqual((await post('/api/inbox/nothing-here')).status, 404);
  assert.strictEqual((await get('/somewhere-else')).status, 404);
  const ping = await ask('/api/ping', { headers: { 'x-board-token': '' } });
  assert.strictEqual(ping.status, 200); assert.strictEqual(ping.json.app, 'session-board');
});

test('reading: sessions, one conversation, its figures', async () => {
  const s = await get('/api/sessions');
  assert.strictEqual(s.status, 200);
  const t1 = s.json.sessions.find((x) => x.sessionId === T1);
  assert.ok(t1 && t1.owner === 'terminal' && !t1.headless, JSON.stringify(t1));
  assert.ok(s.json.page && s.json.version);

  const m = await get('/api/messages?sid=' + T1 + '&max=50');
  assert.strictEqual(m.status, 200);
  assert.ok(m.json.items.some((x) => x.role === 'user' && /請看這張圖/.test(x.text)));
  assert.strictEqual((await get('/api/messages?sid=' + uuid(99))).status, 404);

  const u = m.json.items.find((x) => x.role === 'user');
  const im = await get('/api/image?sid=' + T1 + '&id=' + enc(u.id) + '&i=' + u.imgAt[0]);
  assert.strictEqual(u.id, UID(T1)); assert.deepStrictEqual(u.imgAt, [1], 'the page is told where in the message the picture is');
  assert.strictEqual(im.status, 200); assert.strictEqual(im.headers['content-type'], 'image/png');
  assert.deepStrictEqual([...im.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.strictEqual((await get('/api/image?sid=' + T1 + '&id=nope&i=0')).status, 404);
  assert.strictEqual((await get('/api/image?sid=' + uuid(99) + '&id=x&i=0')).status, 404);

  const tool = await get('/api/tool?sid=' + T1 + '&id=' + AID(T1) + ':1');
  assert.strictEqual(tool.status, 200, tool.text); assert.strictEqual(tool.json.tool, 'Bash');
  assert.strictEqual((await get('/api/tool?sid=' + T1 + '&id=none')).status, 404);
  assert.strictEqual((await get('/api/tool?sid=' + uuid(99) + '&id=' + AID(T1) + ':1')).status, 404);

  const st = await get('/api/stats?sid=' + T1);
  assert.strictEqual(st.status, 200); assert.ok('quota' in st.json && 'agents' in st.json);
  assert.strictEqual((await get('/api/stats?sid=' + uuid(99))).status, 404);

  assert.strictEqual((await get('/api/quota')).status, 200);
  const w = await get('/api/warroom'); assert.strictEqual(w.status, 200); assert.ok('quota' in w.json);
  const us = await get('/api/usage?month=2026-10'); assert.strictEqual(us.status, 200); assert.strictEqual(us.json.total.cost, 12.5);
  assert.strictEqual((await get('/api/usage?month=nonsense')).status, 400);
  assert.strictEqual((await get('/api/task?sid=' + T1 + '&id=1')).status, 404);
});

test('when you last spoke: told with each session, and what the board sent in your place does not count', async () => {
  const Past = require('../lib/past');
  const t1 = (await get('/api/sessions')).json.sessions.find((x) => x.sessionId === T1);
  assert.ok(t1.saidAt > Date.now() - 60000 && t1.saidAt <= Date.now(), 'the time of the message in its transcript: ' + t1.saidAt);
  const f = path.join(HOME, 'said.jsonl');
  const u = (text, at) => line({ type: 'user', sessionId: 'x', cwd: WORK, timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } });
  fs.writeFileSync(f, [u('早上說的', 1000000), u('下午說的', 2000000), u('（看板自動送出）這個 session 剛才因為用量額度用完而停下', 3000000)].join('\n') + '\n');
  assert.strictEqual(Past.ends(f).lastAt, 3000000); assert.strictEqual(Past.saidAtOf(f), 2000000);
  // far more than the end of the file holds has happened since: still found
  const noise = line({ type: 'assistant', sessionId: 'x', message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(4000) }] } });
  fs.appendFileSync(f, new Array(400).fill(noise).join('\n') + '\n');
  assert.strictEqual(Past.saidAtOf(f), 2000000, 'only what was added is read, and nothing of yours is in it');
  // you speak again, and the line after it is still being written
  fs.appendFileSync(f, u('晚上說的', 4000000) + '\n' + u('寫到一半', 5000000).slice(0, 40));
  assert.strictEqual(Past.saidAtOf(f), 4000000);
  fs.appendFileSync(f, u('寫到一半', 5000000).slice(40) + '\n');
  assert.strictEqual(Past.saidAtOf(f), 5000000, 'the line that was half written counts once it is whole');
  // a picture with no words is still you speaking; a tool result is not
  fs.appendFileSync(f, line({ type: 'user', timestamp: new Date(6000000).toISOString(), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } }) + '\n'
    + line({ type: 'user', timestamp: new Date(7000000).toISOString(), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }) + '\n');
  assert.strictEqual(Past.saidAtOf(f), 6000000);
  const g = path.join(HOME, 'said2.jsonl');
  fs.writeFileSync(g, u('（看板自動送出）只有這一句', 3000000) + '\n');
  assert.strictEqual(Past.saidAtOf(g), 0);
  assert.strictEqual(Past.saidAtOf(path.join(HOME, 'no-such.jsonl')), 0);
});

test('what a session changed: from its own transcript, and what is uncommitted in its folder', async () => {
  const C = require('../lib/changes');
  assert.strictEqual((await get('/api/changes?sid=' + uuid(99))).status, 404);
  const s = await get('/api/changes?sid=' + T1); assert.strictEqual(s.status, 200, s.text);
  assert.deepStrictEqual(s.json.files.map((x) => [x.rel, x.adds, x.dels, x.changes, x.created, x.exists]), [
    [path.join(HOME, 'elsewhere', 'scratch.txt'), 1, 0, 1, true, false],   // outside the folder: its full path, and it is not there
    ['note.md', 2, 0, 1, true, true],
    [path.join('src', 'a.js'), 3, 2, 2, false, false],
  ], 'newest first; a file changed twice is one row');
  assert.deepStrictEqual([s.json.adds, s.json.dels], [6, 2]);
  const d = await get('/api/changes/file?sid=' + T1 + '&path=' + enc(path.join(WORK, 'src', 'a.js'))); assert.strictEqual(d.status, 200, d.text);
  assert.deepStrictEqual(d.json.items.map((x) => [x.kind, x.adds, x.dels, x.hunks[0].oldStart, x.hunks[0].lines]), [['edit', 2, 1, 3, [' keep', '-old line', '+new line', '+another']], ['edit', 1, 1, 9, ['-second old', '+second new']]]);
  const n = await get('/api/changes/file?sid=' + T1 + '&path=' + enc(path.join(WORK, 'note.md')));
  assert.deepStrictEqual([n.json.items[0].kind, n.json.items[0].lines], ['create', ['# hi', 'second']]);
  assert.strictEqual((await get('/api/changes/file?sid=' + T1 + '&path=' + enc(path.join(WORK, 'never-touched.js')))).status, 404);
  assert.strictEqual((await get('/api/changes/file?sid=' + uuid(99) + '&path=x')).status, 404);
  // a path written with other capitals or separators is the same file on this system
  if (process.platform === 'win32') assert.strictEqual((await get('/api/changes/file?sid=' + T1 + '&path=' + enc(path.join(WORK, 'SRC', 'A.JS').replace(/\\/g, '/')))).status, 200);

  // only what has been added is read the next time, and a line still being written waits for its end
  const tf = S.findTranscript(T1, WORK, S.DEFAULTS.projectsDir);
  const more = line({ type: 'user', uuid: 'e9', timestamp: new Date(Date.now() + 60000).toISOString(), toolUseResult: { filePath: path.join(WORK, 'late.js'), structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, message: { role: 'user', content: [] } });
  fs.appendFileSync(tf, more.slice(0, 50));
  assert.strictEqual((await C.summary(tf, WORK)).files.length, 3, 'half a line: not counted, and not lost');
  fs.appendFileSync(tf, more.slice(50) + '\n');
  assert.deepStrictEqual((await C.summary(tf, WORK)).files.map((x) => x.name)[0], 'late.js');
  // what a subagent of the session changed is the session's too
  const sub = path.join(tf.replace(/\.jsonl$/, ''), 'subagents'); fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), line({ type: 'user', uuid: 's1', timestamp: new Date(Date.now() + 61000).toISOString(), toolUseResult: { filePath: path.join(WORK, 'late.js'), structuredPatch: [{ oldStart: 2, oldLines: 0, newStart: 2, newLines: 1, lines: ['+by a subagent'] }] }, message: { role: 'user', content: [] } }) + '\n');
  const late = (await C.summary(tf, WORK)).files.find((x) => x.name === 'late.js');
  assert.deepStrictEqual([late.changes, late.bySubagent, late.adds], [2, 1, 2]);
  // entries that are not changes
  assert.strictEqual(C.changeOf({ toolUseResult: { stdout: 'x' } }), null); assert.strictEqual(C.changeOf({ toolUseResult: 'text' }), null); assert.strictEqual(C.changeOf({}), null);
  assert.strictEqual(C.changeOf({ toolUseResult: { filePath: 'a', structuredPatch: [] } }), null, 'a result with a path but nothing changed');
  const long = C.changeOf({ toolUseResult: { type: 'create', filePath: 'big.txt', content: new Array(1000).fill('l').join('\n') } });
  assert.deepStrictEqual([long.adds, long.lines.length, long.more], [1000, C.CONTENT_LINES, 1000 - C.CONTENT_LINES]);

  // git
  assert.strictEqual((await get('/api/changes/git?sid=' + uuid(99))).status, 404);
  const g = await get('/api/changes/git?sid=' + T1); assert.strictEqual(g.status, 200, g.text);
  assert.deepStrictEqual([g.json.repo, g.json.branch, g.json.adds, g.json.dels], [true, 'main', 3, 1]);
  assert.deepStrictEqual(g.json.files.map((x) => [x.path, x.status, x.adds, x.dels, x.untracked]), [['src/a.js', '修改', 3, 1, false], ['new name.txt', '改名', 0, 0, false], ['新檔.md', '新檔（未加入 git）', 0, 0, true]]);
  const gf = await get('/api/changes/gitfile?sid=' + T1 + '&path=' + enc('src/a.js')); assert.strictEqual(gf.status, 200, gf.text); assert.match(gf.json.text, /^diff --git/);
  const nf = await get('/api/changes/gitfile?sid=' + T1 + '&path=' + enc('新檔.md')); assert.strictEqual(nf.json.untracked, true);
  const before = did.length;
  assert.strictEqual((await get('/api/changes/gitfile?sid=' + T1 + '&path=' + enc('../../outside.txt'))).status, 404, 'a path git did not list is not handed to git');
  assert.ok(!since(before).some((x) => x.includes('outside.txt')));
  assert.strictEqual((await get('/api/changes/gitfile?sid=' + uuid(99) + '&path=x')).status, 404);
  out._noRepo = true;
  const no = await get('/api/changes/git?sid=' + T1); assert.deepStrictEqual([no.status, no.json.repo, no.json.reason], [200, false, '這個資料夾不在 git 裡']);
  assert.strictEqual((await get('/api/changes/gitfile?sid=' + T1 + '&path=' + enc('src/a.js'))).status, 404);
  out._noRepo = false;
});

test('a question on the side: answered from the conversation, for any session that has one', async () => {
  assert.strictEqual((await post('/api/btw', { sessionId: uuid(99), question: 'x' })).status, 404);
  assert.strictEqual((await post('/api/btw', { sessionId: T1, question: '   ' })).status, 400);
  assert.strictEqual((await post('/api/btw', { sessionId: T1, question: 'x'.repeat(4001) })).status, 400);
  const n = did.length;
  const r = await post('/api/btw', { sessionId: T1, question: '剛剛那個檔案叫什麼' }); assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([r.json.ok, r.json.answer], [true, '答：剛剛那個檔案叫什麼']);
  assert.deepStrictEqual(since(n), ['btw 01 in work'], 'a terminal session can be asked too: only its transcript is read');
  assert.strictEqual((await post('/api/btw', { sessionId: T1, question: 'fail' })).status, 502);
  const [a, b] = await Promise.all([post('/api/btw', { sessionId: T1, question: 'slow' }), new Promise((res) => setTimeout(res, 60)).then(() => post('/api/btw', { sessionId: T1, question: 'second' }))]);
  assert.deepStrictEqual([a.status, b.status], [200, 409], 'one at a time for a session');
  assert.strictEqual((await post('/api/btw', { sessionId: T1, question: 'again' })).status, 200, 'and free again afterwards');
  const A = require('../lib/aside');
  const args = A.argsFor('abc');
  assert.ok(args.includes('--fork-session') && args.includes('--no-session-persistence') && args.includes('--strict-mcp-config'), 'a copy, not saved, with nothing it could act through');
  assert.strictEqual(args[args.indexOf('--tools') + 1], '');
  assert.strictEqual(args[args.indexOf('--setting-sources') + 1], '', 'no settings: none of your hooks run in the copy');
  const gone = await A.ask('abc', HOME, 'x', { bin: path.join(HOME, 'no-such-claude.exe') }); assert.strictEqual(gone.ok, false);
});

test('說明 of a harness suggestion: in no conversation, read-only, told another way when asked again', async () => {
  const A = require('../lib/aside');
  const ea = A.explainArgs();
  assert.ok(ea.includes('--no-session-persistence') && ea.includes('--strict-mcp-config') && !ea.includes('--resume'), 'nothing resumed, nothing saved');
  assert.strictEqual(ea[ea.indexOf('--tools') + 1], 'Read,Grep,Glob', 'it may read the file the suggestion is about, not change anything');
  assert.ok(ea.indexOf('--setting-sources') > 0 && ea[ea.indexOf('--setting-sources') + 1] === '', 'no settings: the folder\'s hooks do not run');
  const x = { id: 'p-20261101-01', level: 'red', kind: 'hook', action: 'update', target: '.claude/hooks/learn-lib.js', summary: '淘汰候選沒有記錄機制', content: '加一個 reviewed 欄位' };
  const first = A.explainPrompt(x);
  assert.ok(first.includes('p-20261101-01') && first.includes('.claude/hooks/learn-lib.js') && first.includes('加一個 reviewed 欄位') && first.includes('核可會怎樣／駁回會怎樣'));
  assert.ok(!first.includes('看不懂）'), 'the first time there is nothing earlier');
  const again = A.explainPrompt(x, ['第一版的講法', '', 42, '第二版的講法']);
  assert.ok(again.includes('--- 第 1 版（看不懂）---\n第一版的講法') && again.includes('--- 第 2 版（看不懂）---\n第二版的講法') && again.includes('完全不同的講法'), 'pressed again: the earlier ones go with it, to be told another way');
  assert.ok(!again.includes('42'), 'only text counts as an earlier explanation');
  // it really is run that way: the arguments and the prompt on its input
  let seen = null;
  const fake = (bin, args, opt) => { const { EventEmitter } = require('events'); const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); let input = ''; p.stdin = { on() {}, write(t) { input += t; }, end() { seen = { args, cwd: opt.cwd, input }; setImmediate(() => { p.stdout.emit('data', JSON.stringify({ result: '白話說明', total_cost_usd: 0.02 })); p.emit('close'); }); } }; p.kill = () => {}; return p; };
  const r = await A.explain(WORK, first, { spawn: fake });
  assert.deepStrictEqual([r.ok, r.answer, seen.cwd, seen.input === first, seen.args.join(' ') === ea.join(' ')], [true, '白話說明', WORK, true, true]);
  // the address: the suggestion is read from the folder's own list, not taken from the page
  assert.strictEqual((await post('/api/harness/explain', { cwd: WORK, id: 'p-1' })).status, 404, 'no harness in the folder');
  assert.strictEqual((await post('/api/harness/explain', { cwd: 'relative', id: 'p-1' })).status, 400);
  const H = path.join(WORK, '.claude', 'harness'); fs.mkdirSync(path.join(H, 'learning'), { recursive: true }); fs.writeFileSync(path.join(H, 'README.md'), '# harness');
  fs.writeFileSync(path.join(H, 'learning', 'pending.json'), JSON.stringify({ items: [{ id: 'p-9', status: 'pending', level: 'red', kind: 'hook', target: 'a.js', summary: '要你看' }, { id: 'p-slow', status: 'pending', summary: 'slow' }, { id: 'p-old', status: 'accepted', summary: '舊的' }] }));
  try {
    const before = did.length;
    const one = await post('/api/harness/explain', { cwd: WORK, id: 'p-9', summary: '頁面送來的假摘要' });
    assert.deepStrictEqual([one.status, one.json.answer], [200, '說明 1'], one.text);
    const p1 = explained[explained.length - 1];
    assert.ok(p1.includes('要你看') && !p1.includes('頁面送來的假摘要'), 'the words come from pending.json, not from the page');
    assert.deepStrictEqual(did.slice(before), ['explain in ' + path.basename(WORK)], 'and nothing else: no conversation opened, nothing sent');
    await post('/api/harness/explain', { cwd: WORK, id: 'p-9', before: ['說明 1'] });
    assert.ok(explained[explained.length - 1].includes('--- 第 1 版（看不懂）---\n說明 1'), 'pressed again: the first explanation goes with it');
    assert.strictEqual((await post('/api/harness/explain', { cwd: WORK, id: 'p-old' })).status, 404, 'one already decided is not explained');
    const [a, b] = await Promise.all([post('/api/harness/explain', { cwd: WORK, id: 'p-slow' }), new Promise((res) => setTimeout(res, 60)).then(() => post('/api/harness/explain', { cwd: WORK, id: 'p-slow' }))]);
    assert.deepStrictEqual([a.status, b.status], [200, 409], 'one at a time per suggestion');
  } finally { fs.rmSync(path.join(WORK, '.claude', 'harness'), { recursive: true, force: true }); }
});

test('goal2 and harness switched off in the settings: gone from their addresses', async () => {
  const config = require('../lib/config');
  const before = config.value('integrations', {});
  config.setValue('integrations', Object.assign({}, before, { goal2: false, harness: false }));
  await new Promise((r) => setTimeout(r, 5200));   // the switches are read again after five seconds
  const s = (await get('/api/sessions')).json;
  assert.deepStrictEqual([s.features.goal2, s.features.integrations.goal2, s.features.integrations.harness], [false, false, false]);
  assert.deepStrictEqual((await get('/api/goals')).json, { installed: false, runs: [] });
  assert.strictEqual((await post('/api/goals/start', { cwd: WORK, task: 'x', condition: 'y' })).status, 409);
  assert.deepStrictEqual((await get('/api/harness?cwd=' + enc(WORK))).json, { states: {} });
  config.setValue('integrations', before);
  await new Promise((r) => setTimeout(r, 5200));
});

test('a name given on the board stays above every other title; empty gives the automatic one back', async () => {
  asked.add('POST /api/rename');
  const of = async (sid) => { await new Promise((r) => setTimeout(r, 1100)); return (await get('/api/sessions')).json.sessions.find((x) => x.sessionId === sid); };
  const before = await of(T1);
  assert.strictEqual((await post('/api/rename', { sessionId: T1, name: '  我的   名字 ' })).json.name, '我的 名字');
  const named = await of(T1);
  assert.deepStrictEqual([named.title, named.titleSource], ['我的 名字', 'board']);
  // the status line's summary (rewritten as the conversation goes on) does not take it back
  const stateDir = S.DEFAULTS.stateDir;
  if (stateDir) { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'claude-summary-' + S.sidKey(T1) + '.txt'), '新的摘要\n'); }
  assert.strictEqual((await of(T1)).title, '我的 名字');
  assert.strictEqual((await post('/api/rename', { sessionId: T1, name: '' })).status, 200);
  const back = await of(T1);
  assert.notStrictEqual(back.titleSource, 'board'); assert.notStrictEqual(back.title, '我的 名字');
  if (stateDir) fs.unlinkSync(path.join(stateDir, 'claude-summary-' + S.sidKey(T1) + '.txt'));
  assert.strictEqual((await post('/api/rename', { sessionId: '../x', name: 'a' })).status, 400);
  assert.strictEqual((await post('/api/rename', { sessionId: T1, name: 5 })).status, 400);
  assert.ok(before.title);
});

test('settings kept in the board: the left column, the office, sessions a program started', async () => {
  const config = require('../lib/config');
  const cfg = (await get('/api/config')).json.prefs;
  assert.deepStrictEqual([cfg.sidebarCollapsed, cfg.sidebarShortcut, cfg.officeFavorites, cfg.hideProgramSessions, cfg.decideModel], [false, true, [], false, 'haiku'], 'the defaults');
  assert.strictEqual((await post('/api/config', { sidebarCollapsed: true, officeFavorites: [WORK], officeOrder: [WORK, HOME] })).status, 200);
  const f = (await get('/api/sessions')).json.features.prefs;
  assert.deepStrictEqual([f.sidebarCollapsed, f.officeFavorites, f.officeOrder], [true, [WORK], [WORK, HOME]], 'sent with the list');
  for (const [k, v] of [['sidebarCollapsed', 'yes'], ['officeFavorites', 'C:\\x'], ['hideProgramFolders', [5]], ['decideModel', 'gpt-4'], ['sidebarWidth', 100], ['sidebarWidth', 900], ['sidebarWidth', 300.5]]) assert.strictEqual((await post('/api/config', { [k]: v })).status, 400, k);
  // a conversation a program started (entrypoint sdk-cli), one the board started, one of yours
  const PROG = uuid(71), MINE = uuid(72), BOARDS = uuid(73);
  const OTHER = path.join(HOME, 'tools'); fs.mkdirSync(OTHER, { recursive: true });
  const write = (sid, cwd, entry) => {
    const dir = path.join(CLAUDE, 'projects', S.encodeCwd(cwd)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sid + '.jsonl'), line({ type: 'user', sessionId: sid, cwd, entrypoint: entry, timestamp: new Date().toISOString(), message: { role: 'user', content: '問一題 ' + sid.slice(-2) } }) + '\n');
  };
  write(PROG, OTHER, 'sdk-cli'); write(MINE, OTHER, 'cli'); write(BOARDS, OTHER, 'sdk-cli');
  // an older board conversation (before the board remembered its own): its first message is content blocks, as the board sends them
  const OLDB = uuid(74); { const dir = path.join(CLAUDE, 'projects', S.encodeCwd(OTHER)); fs.writeFileSync(path.join(dir, OLDB + '.jsonl'), line({ type: 'user', sessionId: OLDB, cwd: OTHER, entrypoint: 'sdk-cli', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '看板開的舊對話' }] } }) + '\n'); }
  config.setValue('boardStarted', [BOARDS]);
  const past = async (qs) => JSON.stringify((await get('/api/past' + (qs || ''))).json);
  assert.ok((await past()).includes(PROG), 'off: everything is listed');
  assert.strictEqual((await post('/api/config', { hideProgramSessions: true })).status, 200);
  const p = (await get('/api/past')).json, ps = JSON.stringify(p.items);
  assert.deepStrictEqual([ps.includes(PROG), ps.includes(MINE), ps.includes(BOARDS), ps.includes(OLDB), p.programHidden >= 1], [false, true, true, true, true], 'only the one a program started is left out');
  assert.ok((await past('?programs=1')).includes(PROG), 'shown when asked for');
  // a folder named: everything in it is left out
  assert.strictEqual((await post('/api/config', { hideProgramFolders: [OTHER] })).status, 200);
  const q = JSON.stringify((await get('/api/past')).json.items);
  assert.deepStrictEqual([q.includes(MINE), q.includes(BOARDS)], [false, false]);
  // the folder list is its own rule: it still hides with the program switch off
  assert.strictEqual((await post('/api/config', { hideProgramSessions: false })).status, 200);
  const qOff = JSON.stringify((await get('/api/past')).json.items);
  assert.deepStrictEqual([qOff.includes(MINE), qOff.includes(PROG)], [false, false], 'a folder named is left out whether or not the switch is on');
  // one wrong value in a save: nothing of it is saved
  assert.strictEqual((await post('/api/config', { hideProgramSessions: true, decideModel: 'not a model!' })).status, 400);
  assert.strictEqual((await get('/api/config')).json.prefs.hideProgramSessions, false, 'the right value next to a wrong one was not saved either');
  const sizeNow = async () => (await get('/api/sessions')).json.features.textSize;   // the text size is reported with the sessions
  const sizeWas = await sizeNow(), daysWas = (await get('/api/config')).json.autoHideDays;
  assert.strictEqual(typeof daysWas, 'number', 'there is a value to compare with');
  const otherDays = daysWas === 3 ? 4 : 3, otherSize = sizeWas === 1.3 ? 1 : 1.3;
  assert.strictEqual((await post('/api/config', { textSize: otherSize, autoHideDays: otherDays, decideModel: 'not a model!' })).status, 400);
  const after = { textSize: await sizeNow(), autoHideDays: (await get('/api/config')).json.autoHideDays };
  assert.deepStrictEqual([after.textSize, after.autoHideDays], [sizeWas, daysWas], 'the older settings in the same save are not written either (compared with what they were)');
  assert.strictEqual((await post('/api/config', { autoHideDays: 999, hideProgramSessions: true })).status, 400);
  assert.strictEqual((await get('/api/config')).json.prefs.hideProgramSessions, false, 'a wrong older value stops the new ones too');
  assert.strictEqual((await post('/api/config', { hideProgramSessions: true })).status, 200);
  // an open session a program started: marked, and hidden while the setting is on
  const regFile = fs.readdirSync(path.join(CLAUDE, 'sessions')).map((n) => path.join(CLAUDE, 'sessions', n)).find((x) => JSON.parse(fs.readFileSync(x, 'utf8')).sessionId === T2);
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8')); const was = reg.entrypoint; reg.entrypoint = 'sdk-cli'; fs.writeFileSync(regFile, JSON.stringify(reg));
  await new Promise((r) => setTimeout(r, 1100));
  const t2 = (await get('/api/sessions')).json.sessions.find((x) => x.sessionId === T2);
  assert.deepStrictEqual([t2.entrypoint, t2.byProgram, t2.programHidden], ['sdk-cli', undefined, undefined], 'its first message is content blocks, as the board sends them: taken for the board\'s own');
  // started through the Agent SDK (claude-mem sets sdk-ts): a program's, even with content blocks
  reg.entrypoint = 'sdk-ts'; fs.writeFileSync(regFile, JSON.stringify(reg));
  await new Promise((r) => setTimeout(r, 1100));
  const t2s = (await get('/api/sessions')).json.sessions.find((x) => x.sessionId === T2);
  assert.deepStrictEqual([t2s.entrypoint, t2s.byProgram, t2s.programHidden], ['sdk-ts', true, true], 'an SDK session is a program\'s whatever form its messages take');
  await post('/api/config', { hideProgramFolders: [WORK] }); await new Promise((r) => setTimeout(r, 1100));
  const t2b = (await get('/api/sessions')).json.sessions.find((x) => x.sessionId === T2);
  reg.entrypoint = was; fs.writeFileSync(regFile, JSON.stringify(reg));
  assert.deepStrictEqual([t2b.byProgram, t2b.programHidden], [true, true], 'in a folder named: hidden');
  await post('/api/config', { sidebarCollapsed: false, officeFavorites: [], officeOrder: [], hideProgramSessions: false, hideProgramFolders: [] });
  config.setValue('boardStarted', []);
});

test('a session with nothing new for the set number of days leaves the list by itself', async () => {
  const config = require('../lib/config');
  assert.strictEqual((await get('/api/config')).json.autoHideDays, 7, 'seven days unless changed');
  const of = async (sid) => (await get('/api/sessions')).json.sessions.find((x) => x.sessionId === sid);
  assert.strictEqual((await of(T2)).hidden, undefined, 'something happened in it today');
  // make T2 old: its transcript and its registry say ten days ago
  const old = Date.now() - 10 * 86400000, tf = S.findTranscript(T2, WORK, S.DEFAULTS.projectsDir);
  const body = fs.readFileSync(tf, 'utf8').replace(/"timestamp":"[^"]+"/g, '"timestamp":"' + new Date(old).toISOString() + '"').replace(/\n$/, ''); fs.writeFileSync(tf, body); /* a byte shorter: rewritten in place it would look unchanged to the reader that only reads what was added */ fs.utimesSync(tf, new Date(old), new Date(old));
  const regFile = fs.readdirSync(path.join(CLAUDE, 'sessions')).map((n) => path.join(CLAUDE, 'sessions', n)).find((p) => JSON.parse(fs.readFileSync(p, 'utf8')).sessionId === T2);
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8')); reg.updatedAt = reg.statusUpdatedAt = reg.startedAt = old; fs.writeFileSync(regFile, JSON.stringify(reg));
  await new Promise((r) => setTimeout(r, 1100));   // the list is worked out at most once a second
  const h = await of(T2); assert.strictEqual(h.hidden, true, JSON.stringify({ since: h.since, activeAt: h.activeAt, saidAt: h.saidAt })); assert.strictEqual(h.autoHidden, 10);
  assert.strictEqual((await of(T1)).hidden, undefined, 'the others stay');
  // put back by hand: counted from now, so it stays
  assert.strictEqual((await post('/api/hide', { sessionId: T2, hidden: false })).status, 200);
  assert.strictEqual((await of(T2)).hidden, undefined);
  assert.ok(config.value('shownAt', {})[T2] > Date.now() - 5000);
  // the setting
  config.setValue('shownAt', {});
  await new Promise((r) => setTimeout(r, 1100));   // changed behind the server's back: its list is at most a second old
  assert.strictEqual((await of(T2)).hidden, true);
  assert.strictEqual((await post('/api/config', { autoHideDays: 30 })).status, 200); assert.strictEqual((await of(T2)).hidden, undefined, 'ten days is not thirty');
  assert.strictEqual((await post('/api/config', { autoHideDays: 0 })).status, 200); assert.strictEqual((await of(T2)).hidden, undefined, '0: never');
  for (const bad of [-1, 366, 1.5, 'x']) assert.strictEqual((await post('/api/config', { autoHideDays: bad })).status, 400, String(bad));
  assert.strictEqual((await get('/api/config')).json.autoHideDays, 0);
  await post('/api/config', { autoHideDays: 0 });   // left off for the tests that follow
  // the text size is a setting of the board: sent with the list, so every browser and computer shows the same
  assert.strictEqual((await post('/api/config', { textSize: 1.3 })).status, 200);
  assert.strictEqual((await get('/api/sessions')).json.features.textSize, 1.3);
  assert.strictEqual((await post('/api/config', { textSize: 1.5 })).status, 400, 'only the sizes the page offers');
  assert.strictEqual((await get('/api/sessions')).json.features.textSize, 1.3, 'unchanged by a refused one');
  // a touch screen's size is kept apart from the computer's: setting one leaves the other as it was
  assert.strictEqual((await post('/api/config', { textSizeTouch: 1 })).status, 200);
  const both = (await get('/api/sessions')).json.features;
  assert.deepStrictEqual([both.textSize, both.textSizeTouch], [1.3, 1]);
  assert.strictEqual((await post('/api/config', { textSizeTouch: 2 })).status, 400, 'only the sizes the page offers');
  assert.strictEqual((await get('/api/sessions')).json.features.textSizeTouch, 1);
  // the look (外觀): not chosen at first (the page then picks D on a phone, B elsewhere); a phone's kept apart
  const look = async () => { const p = (await get('/api/sessions')).json.features.prefs; return [p.skin, p.skinPhone]; };
  assert.deepStrictEqual(await look(), ['', '']);
  assert.strictEqual((await post('/api/config', { skin: 'c' })).status, 200);
  assert.strictEqual((await post('/api/config', { skinPhone: 'a' })).status, 200);
  assert.deepStrictEqual(await look(), ['c', 'a']);
  for (const bad of ['e', 'B', 1, null]) assert.strictEqual((await post('/api/config', { skin: bad })).status, 400, String(bad));
  assert.deepStrictEqual(await look(), ['c', 'a'], 'unchanged by a refused one');
  assert.strictEqual((await post('/api/config', { skin: '', skinPhone: '' })).status, 200, 'back to the default');
  assert.deepStrictEqual(await look(), ['', '']);
});

test('files Claude hands over are listed as files, with where they are', () => {
  const H = require('../lib/history');
  const tf = path.join(HOME, 'handed.jsonl');
  fs.writeFileSync(tf, [
    line({ type: 'assistant', uuid: 'cccccccc-0000-4000-8000-000000000001', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '傳給你了' }, { type: 'tool_use', id: 't1', name: 'SendUserFile', input: { files: ['C:\\tmp\\a.patch', 'C:\\tmp\\b.zip', 5, ''], caption: '依序套', display: 'attach' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 't3', name: 'SendUserFile', input: { files: [] } }] } }),
  ].join('\n') + '\n');
  const items = H.readHistory(tf, { max: 50 }).items;
  const fl = items.filter((x) => x.role === 'files');
  assert.deepStrictEqual(fl.map((x) => [x.files, x.caption]), [[['C:\\tmp\\a.patch', 'C:\\tmp\\b.zip'], '依序套']]);
  assert.deepStrictEqual(items.filter((x) => x.role === 'tool').map((x) => x.tool), ['Bash', 'SendUserFile'], 'one with no file in it stays an ordinary action line');
  assert.deepStrictEqual(H.handedFiles(null), []); assert.strictEqual(H.handedFiles({ files: new Array(60).fill('x') }).length, 40);
});

test('goal2 runs: listed, one in detail, a running one stopped - only runs goal2 itself listed', async () => {
  const { Goal2, findGoal2 } = require('../lib/goal2');
  const calls = [];
  const DIR = (id) => path.join(HOME, 'g2runs', id);
  const runs = [{ runId: '20261116090000-goal-aaaa', runDir: DIR('20261116090000-goal-aaaa'), skill: 'goal', status: 'done', alive: false, cwd: WORK, condition: '測試全過' }, { runId: '20261117090000-goal-bbbb', runDir: DIR('20261117090000-goal-bbbb'), skill: 'delaylocal', status: 'running', alive: true, cwd: WORK, condition: '報表產出' }];
  const run = (exe, args, opts, cb) => { calls.push(args.slice(1).join(' ')); const a = args[1]; if (a === '--list') return cb(null, JSON.stringify({ ok: true, plugin_version: '0.5.8', runs })); if (a === '--status') return cb(null, JSON.stringify({ ok: true, status: 'done', goal_verdict: 'met', total_cost_usd: 0.4, progress_md: '# 進度', run_dir: args[2], secret_extra: 'x' })); if (a === '--stop') return cb(null, JSON.stringify({ ok: true })); cb(new Error('unexpected')); };
  const g = new Goal2({ root: path.join(HOME, 'goal2-plugin'), run });
  const judgeAsked = [];
  const decider = new (require('../lib/decide').Decider)({ userDir: path.join(HOME, 'no-questions'), run: async (prompt) => { judgeAsked.push(prompt); return /還沒改/.test(prompt) ? { ok: true, text: '{"answer": 0.9, "items": ["第 9 封"]}' } : /逾時/.test(prompt) ? { ok: false, error: '判斷逾時（60 秒）' } : { ok: true, text: '{"answer": 0.05, "items": []}' }; } });
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, out, goal2: g, decider, pluginsInstalled: () => ({ goal2: { name: 'goal2', installs: [] } }) });
  await new Promise((r) => s2.listen(p2, '127.0.0.1', r));
  const via = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q2 = http.request({ host: '127.0.0.1', port: p2, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json' } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); }); if (b) q2.write(b); q2.end(); });
  asked.add('GET /api/goals'); asked.add('GET /api/goals/status'); asked.add('POST /api/goals/stop');
  const l = await via('/api/goals');
  assert.deepStrictEqual([l.status, l.json.installed, l.json.runs.map((x) => [x.runId, x.status, x.alive])], [200, true, [['20261117090000-goal-bbbb', 'running', true], ['20261116090000-goal-aaaa', 'done', false]]], 'newest first');
  assert.ok(!JSON.stringify(l.json).includes('g2runs'), 'the folders are not handed to the page');
  const st = await via('/api/goals/status?id=20261116090000-goal-aaaa');
  assert.deepStrictEqual([st.status, st.json.goal_verdict, st.json.secret_extra], [200, 'met', undefined], 'only the fields the page shows');
  assert.ok(calls.some((c) => c === '--status ' + DIR('20261116090000-goal-aaaa')));
  const before = calls.length;
  for (const bad of ['../../Windows', DIR('20261116090000-goal-aaaa'), 'nope']) assert.strictEqual((await via('/api/goals/status?id=' + enc(bad))).status, 404, bad);
  assert.ok(!calls.slice(before).some((c) => c.startsWith('--status')), 'nothing that goal2 did not list is handed to it');
  assert.strictEqual((await via('/api/goals/stop', { id: '20261116090000-goal-aaaa' })).status, 409, 'one that is not running');
  assert.strictEqual((await via('/api/goals/stop', { id: '../x' })).status, 409);
  assert.strictEqual((await via('/api/goals/stop', { id: '20261117090000-goal-bbbb' })).status, 200);
  assert.ok(calls.includes('--stop ' + DIR('20261117090000-goal-bbbb')));
  // is work left in this reply? (whether to offer goal2): one model call per message, kept
  asked.add('POST /api/next/judge'); asked.add('POST /api/decide');
  const j1 = await via('/api/next/judge', { text: '第 9 封還沒改' });
  assert.deepStrictEqual([j1.status, j1.json.show, j1.json.items, j1.json.unfinished], [200, true, ['第 9 封'], 0.9]);
  await via('/api/next/judge', { key: 'anything the page says', text: '第 9 封還沒改' });
  assert.strictEqual(judgeAsked.length, 1, 'the same text is not asked twice, whatever key the page sends');
  assert.strictEqual((await via('/api/next/judge', { text: '全部做完了' })).json.show, false);
  assert.deepStrictEqual([(await via('/api/next/judge', { text: '逾時' })).status], [502]);
  assert.strictEqual((await via('/api/next/judge', {})).status, 400, 'no text');
  // any question by its id; never a path the page chose
  const dq = await via('/api/decide', { question: 'unfinished', text: '第 9 封還沒改' });
  assert.deepStrictEqual([dq.status, dq.json.question, dq.json.answer, dq.json.yes], [200, 'unfinished', 0.9, true]);
  for (const bad of ['../../secret', 'C:\\x.json', '']) assert.strictEqual((await via('/api/decide', { question: bad, text: 'x' })).status, 400, bad);
  assert.strictEqual((await via('/api/decide', { question: 'no-such-question', text: 'x' })).status, 502);
  s2.close(); if (s2.closeAllConnections) s2.closeAllConnections();
  // not installed: the page is told so and shows nothing
  const none = new Goal2({ root: null }); assert.deepStrictEqual(await none.list(), { installed: false, runs: [] });
  // where it is found: beside this plugin, else where Claude Code installed it (the newest)
  const inst = path.join(HOME, 'installed.json'); fs.writeFileSync(inst, JSON.stringify({ plugins: { 'goal2@fulin-plugins': [{ installPath: 'C:/old', version: '0.4.0' }, { installPath: 'C:/new', version: '0.5.8' }] } }));
  const has = (set) => (p) => set.some((x) => path.normalize(p).startsWith(path.normalize(x)));
  assert.strictEqual(findGoal2({ here: path.join(HOME, 'plugins', 'session-board'), installed: inst, exists: has([path.join(HOME, 'plugins', 'goal2')]) }), path.join(HOME, 'plugins', 'goal2'));
  assert.strictEqual(findGoal2({ here: path.join(HOME, 'x', 'session-board'), installed: inst, exists: has(['C:/new', 'C:/old']) }), path.normalize('C:/new'));
  assert.strictEqual(findGoal2({ here: path.join(HOME, 'x', 'session-board'), installed: path.join(HOME, 'none.json'), exists: () => false }), null);
});

test('harness state of a folder: read from its files, only for folders the board knows', async () => {
  const H = path.join(WORK, '.claude', 'harness'); fs.mkdirSync(path.join(H, 'learning'), { recursive: true }); fs.mkdirSync(path.join(H, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(H, 'README.md'), '# harness');
  fs.writeFileSync(path.join(H, 'learning', 'pending.json'), JSON.stringify({ version: 1, items: [{ id: 'p-1', status: 'pending', level: 'red', kind: 'hook', summary: '要你看' }, { id: 'p-2', status: 'accepted', summary: '舊的' }] }));
  // the date n days ago on this computer's calendar, as lib/harness.js reads it (local midnight): the UTC date was a day
  // behind between midnight and 8 in Taiwan, and the count one day too many
  const day = (n) => { const t = new Date(Date.now() - n * 86400000); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
  fs.writeFileSync(path.join(H, 'reviews', day(40) + '.md'), 'old'); fs.writeFileSync(path.join(H, 'reviews', day(3) + '.md'), 'new'); fs.writeFileSync(path.join(H, 'reviews', day(3) + '-ledger.md'), 'ledger');
  fs.writeFileSync(path.join(H, 'learning', 'usage.json'), JSON.stringify({ requests: 500 })); fs.writeFileSync(path.join(H, 'learning', 'health-baseline.json'), JSON.stringify({ baseDate: day(3), requestsAtBase: 150 }));
  const ask2 = async (...cwds) => (await get('/api/harness?cwd=' + enc(cwds.join('\n')))).json.states;
  const st = (await ask2(WORK))[WORK];
  assert.deepStrictEqual([st.installed, st.pendingCount, st.pending[0].id, st.lastReview, st.daysSince, st.requestsSince], [true, 1, 'p-1', day(3), 3, 350]);
  assert.deepStrictEqual(st.due, ['距上次健檢已 350 次對話'], 'due by requests before days');
  const other = path.join(HOME, 'elsewhere-h'); fs.mkdirSync(path.join(other, '.claude', 'harness'), { recursive: true }); fs.writeFileSync(path.join(other, '.claude', 'harness', 'README.md'), 'x');
  assert.deepStrictEqual((await ask2(other, 'relative\\path'))[other], { installed: false }, 'a folder no session ever ran in is not looked at');
  fs.rmSync(H, { recursive: true, force: true });
  assert.strictEqual((await ask2(WORK))[WORK].installed, false);
  const Hm = require('../lib/harness'); const fresh = path.join(HOME, 'h-new'); fs.mkdirSync(path.join(fresh, '.claude', 'harness'), { recursive: true }); fs.writeFileSync(path.join(fresh, '.claude', 'harness', 'README.md'), 'x');
  assert.deepStrictEqual(Hm.stateOf(fresh).due, ['還沒做過健檢']);
});

test('another computer: only through Tailscale, only your own devices', WIN_ONLY, async () => {
  const R = require('../lib/remote');
  const status = (peers, state = 'Running') => JSON.stringify({ BackendState: state, Self: { UserID: 7, HostName: 'me', DNSName: 'me.tail.ts.net.', TailscaleIPs: ['100.70.0.1', 'fd7a::1'] }, User: { 7: { LoginName: 'me@x' }, 9: { LoginName: 'other@x' } }, Peer: peers });
  let reply = status({ a: { HostName: 'laptop', UserID: 7, TailscaleIPs: ['100.70.0.2'], Online: true }, b: { HostName: 'friend', UserID: 9, TailscaleIPs: ['100.70.0.3'], Online: true } });
  const run = (exe, args, opts, cb) => cb(null, reply);
  const g = new R.Gate({ run });
  const allows = async (a) => g.allows(a);
  assert.deepStrictEqual(await Promise.all(['127.0.0.1', '::1', '100.70.0.1', '100.70.0.2', '100.70.0.3', '100.70.0.9', '192.168.1.5', '10.0.0.2', '::ffff:100.70.0.2'].map(allows)), [true, true, true, true, false, false, false, false, true], 'this computer, and your own other device; not a shared device of another account, not an unknown one, never the local network');
  const i = await R.info(run); assert.deepStrictEqual([i.ok, i.ip, i.name, i.user, i.devices.map((d) => d.name + ':' + d.mine)], [true, '100.70.0.1', 'me.tail.ts.net', 'me@x', ['laptop:true', 'friend:false']]);
  reply = status({}, 'NeedsLogin'); assert.deepStrictEqual(await R.info(run), { ok: false, why: 'Tailscale 還沒登入' });
  reply = ''; assert.strictEqual((await R.info(run)).ok, false);
  // the https address tailscale serve gives the board (shape of `tailscale serve status --json`, measured 2026-11-19)
  const serve = (web, tcp) => (exe, args, opts, cb) => { assert.deepStrictEqual(args, ['serve', 'status', '--json']); cb(null, JSON.stringify({ TCP: tcp, Web: web })); };
  const web = (port, proxy) => ({ ['me.tail.ts.net:' + port]: { Handlers: { '/': { Proxy: proxy } } } });
  assert.strictEqual(await R.servedUrl(4317, serve(web('443', 'http://127.0.0.1:4317'), { 443: { HTTPS: true } })), 'https://me.tail.ts.net/');
  assert.strictEqual(await R.servedUrl(4317, serve(web('8444', 'http://localhost:4317/'), { 8444: { HTTPS: true } })), 'https://me.tail.ts.net:8444/', 'another https port is named');
  assert.strictEqual(await R.servedUrl(4317, serve(web('8443', 'http://127.0.0.1:4318'), { 8443: { HTTPS: true } })), '', 'serving something else (the LINE listener) is not the board');
  assert.strictEqual(await R.servedUrl(4317, serve(web('443', 'http://127.0.0.1:4317'), { 443: {} })), '', 'not https: no use for the microphone');
  assert.strictEqual(await R.servedUrl(4317, (exe, args, opts, cb) => cb(new Error('x'), '')), '', 'no tailscale');
  assert.strictEqual(await R.servedUrl(4317, (exe, args, opts, cb) => cb(null, 'not json')), '');
  // the board refuses a request from an address the gate does not let in, before it looks at the key
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, out, gate: { allows: async () => false, refresh: async () => {} } });
  await new Promise((r) => s2.listen(p2, '127.0.0.1', r));
  const code = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: p2, path: '/api/sessions', headers: { 'x-board-token': TOKEN } }, (res) => { res.resume(); resolve(res.statusCode); }));
  assert.strictEqual(code, 403);
  // switching it on: refused with Tailscale's own reason when it cannot be used, nothing is listened on
  const s3p = await freePort(); const s3 = createServer(TOKEN, s3p, { channels, noTimers: true, noSchedules: true, out, remoteInfo: async () => ({ ok: false, why: 'Tailscale 還沒登入' }) });
  assert.deepStrictEqual(await s3.setRemote(true), { ok: false, listening: false, error: 'Tailscale 還沒登入' });
  assert.deepStrictEqual(s3.remoteState(), { listening: false, port: s3p });
  // and when it can: a second address is listened on, its host name is accepted, switching off closes it
  const s4p = await freePort(); const s4 = createServer(TOKEN, s4p, { channels, noTimers: true, noSchedules: true, out, remoteInfo: async () => ({ ok: true, ip: '127.0.0.2', name: 'me.tail.ts.net', devices: [] }), gate: { allows: async () => true, refresh: async () => {} } });
  await new Promise((r) => s4.listen(s4p, '127.0.0.1', r));
  const on = await s4.setRemote(true); assert.deepStrictEqual([on.ok, on.listening, on.ip], [true, true, '127.0.0.2'], JSON.stringify(on));
  const viaRemote = (host) => new Promise((resolve) => http.get({ host: '127.0.0.2', port: s4p, path: '/api/ping', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', (e) => resolve(e.code)));
  assert.deepStrictEqual([await viaRemote('127.0.0.2:' + s4p), await viaRemote('me.tail.ts.net:' + s4p), await viaRemote('me:' + s4p), await viaRemote('evil.example:' + s4p)], [200, 200, 200, 403]);
  // what happens on that computer's screen is refused to a request that comes from another one
  const postRemote = (pp) => new Promise((resolve) => { const b = Buffer.from('{}'); const q2 = http.request({ host: '127.0.0.2', port: s4p, path: pp, method: 'POST', headers: { host: '127.0.0.2:' + s4p, 'x-board-token': TOKEN, 'content-type': 'application/json', 'content-length': b.length } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(res.statusCode)); }); q2.on('error', (e) => resolve(e.code)); q2.write(b); q2.end(); });
  // A preview address works only on the device that asked for it: a page can carry its own address anywhere, so
  // another of your devices (let in here) holding it is refused.
  const vdir = path.join(WORK, 'vsite'); fs.mkdirSync(vdir, { recursive: true }); fs.writeFileSync(path.join(vdir, 'v.html'), '<p>v</p>');
  const vb = Buffer.from(JSON.stringify({ path: path.join(vdir, 'v.html') }));
  const vt = await new Promise((resolve) => { const q3 = http.request({ host: '127.0.0.1', port: s4p, path: '/api/file/ticket', method: 'POST', headers: { 'x-board-token': TOKEN, 'content-type': 'application/json', 'content-length': vb.length } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }); q3.write(vb); q3.end(); });
  const getFrom = (host) => new Promise((resolve) => http.get({ host, localAddress: host, port: s4p, path: vt.url, headers: { host: host + ':' + s4p } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve([res.statusCode, res.statusCode === 200 ? '' : JSON.parse(d).error])); }).on('error', (e) => resolve([e.code])));
  assert.deepStrictEqual([await getFrom('127.0.0.2'), await getFrom('127.0.0.1')], [[404, '這個預覽網址只能在開它的那台裝置上看'], [200, '']]);
  const n0 = did.length;
  const screen = ['/api/focus', '/api/pick-folder', '/api/file/open', '/api/file/reveal', '/api/to-terminal', '/api/end', '/api/takeover', '/api/past/open', '/api/keep/restore'];
  assert.deepStrictEqual(await Promise.all(screen.map(postRemote)), screen.map(() => 403), 'windows opened or closed on this computer: refused from another one');
  assert.strictEqual(did.length, n0, 'nothing was started on this computer');
  assert.strictEqual(await postRemote('/api/new'), 400, 'other actions still answered (here: no folder given)');
  // switched off while a connection through it is still open (a stream; here a request whose headers never finish):
  // answered at once, and that connection is cut - it used to wait for it for ever
  const open = require('net').connect(s4p, '127.0.0.2'); await new Promise((r) => open.once('connect', r));
  open.write('GET /api/ping HTTP/1.1\r\nHost: 127.0.0.2:' + s4p + '\r\n');
  const cut = new Promise((r) => open.once('close', r));
  const t0 = Date.now(); const off = await s4.setRemote(false);
  assert.deepStrictEqual([off.listening, Date.now() - t0 < 1000], [false, true], 'not waiting for the open connection');
  assert.strictEqual(await Promise.race([cut.then(() => 'cut'), new Promise((r) => setTimeout(() => r('still open'), 3000))]), 'cut');
  assert.notStrictEqual(await viaRemote('127.0.0.2:' + s4p), 200, 'no longer listened on');
  // switched on, but Tailscale not up yet when the board starts: it keeps trying, and listens as soon as Tailscale is up;
  // switched off meanwhile: no more tries
  const cfg = require('../lib/config'); const was = cfg.value('remoteTailscale', false);
  cfg.setValue('remoteTailscale', true);
  let up = false, asked = 0; const said = [];
  const s5p = await freePort(); const s5 = createServer(TOKEN, s5p, { channels, noTimers: true, noSchedules: true, out, remoteInfo: async () => { asked++; return up ? { ok: true, ip: '127.0.0.2', name: 'me.tail.ts.net', devices: [] } : { ok: false, why: 'Tailscale 的狀態是 NoState' }; }, gate: { allows: async () => true, refresh: async () => {} } });
  await new Promise((r) => s5.listen(s5p, '127.0.0.1', r));
  const tryNow = s5.keepRemote(60000, (l) => said.push(l));
  await tryNow(); await tryNow();
  assert.deepStrictEqual([s5.remoteState().listening, said.length], [false, 1], 'not up: not listening, said once (not on every try)');
  up = true; await tryNow();
  assert.deepStrictEqual([s5.remoteState().listening, said.length, /and on Tailscale: http:\/\/127\.0\.0\.2:/.test(said[1])], [true, 2, true], JSON.stringify(said));
  const r5 = await new Promise((resolve) => http.get({ host: '127.0.0.2', port: s5p, path: '/api/ping', headers: { host: '127.0.0.2:' + s5p } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', (e) => resolve(e.code)));
  assert.strictEqual(r5, 200, 'reached through the Tailscale address');
  const n5 = asked; await tryNow(); assert.strictEqual(asked, n5, 'listening: Tailscale not asked again');
  await s5.setRemote(false); cfg.setValue('remoteTailscale', false); await tryNow();
  assert.deepStrictEqual([s5.remoteState().listening, asked], [false, n5], 'switched off: not tried');
  cfg.setValue('remoteTailscale', was);
  for (const s of [s2, s4, s5]) { s.close(); if (s.closeAllConnections) s.closeAllConnections(); }
});

test('外掛 page: one view of the plugins, and its buttons', async () => {
  const P = require('../lib/plugins');
  // installed: read from Claude Code's record
  const rec = path.join(HOME, 'installed_plugins.json');
  const pdir = path.join(HOME, 'cache', 'goal2', '0.5.8'); fs.mkdirSync(path.join(pdir, '.claude-plugin'), { recursive: true }); fs.writeFileSync(path.join(pdir, '.claude-plugin', 'plugin.json'), JSON.stringify({ description: 'goal 引擎' }));
  fs.writeFileSync(rec, JSON.stringify({ plugins: { 'goal2@fulin-plugins': [{ scope: 'project', projectPath: 'C:/a', version: '0.5.7', installPath: 'C:/old' }, { scope: 'project', projectPath: 'C:/b', version: '0.5.8', installPath: pdir }], 'other@elsewhere': [{ scope: 'user', version: '1' }] } }));
  const inst = P.installed(rec);
  assert.deepStrictEqual(Object.keys(inst), ['goal2'], 'only this marketplace');
  assert.deepStrictEqual([inst.goal2.newest, inst.goal2.description, inst.goal2.installs.length], ['0.5.8', 'goal 引擎', 2]);
  // plugin-manager's check, through its own scripts (stood in for)
  const pmRoot = path.join(HOME, 'pm'); fs.mkdirSync(path.join(pmRoot, '.claude-plugin'), { recursive: true }); fs.writeFileSync(path.join(pmRoot, '.claude-plugin', 'plugin.json'), '{}');
  const ran = [];
  const run = (exe, args, opts, cb) => { ran.push(path.basename(args[0]) + ' ' + args.slice(1).join(' ')); if (/update-all/.test(args[0])) return cb(null, JSON.stringify({ latest: { a: '2.7.0' }, upToDate: 9, rows: [{ name: 'a', category: 'updatable', oldVersion: '2.6.0', latest: '2.7.0', projectPath: 'C:/x' }, { name: 'a', category: 'updatable', oldVersion: '2.6.0', latest: '2.7.0', projectPath: 'C:/y' }, { name: 'b', category: 'missing' }] }), ''); cb(null, '== monorepo 待發布狀態 ==\n  分支: main（本地領先 2）\n  改動的 plugin: a, session-board\n', ''); };
  const pm = await P.pluginManager({ 'plugin-manager': { root: pmRoot } }, { run, here: path.join(HOME, 'nowhere') });
  assert.deepStrictEqual([pm.checked, pm.behind.map((b) => [b.name, b.from, b.to, b.count]), pm.unpublished, pm.aheadOfRemote], [true, [['a', '2.6.0', '2.7.0', 2]], ['a', 'session-board'], 2]);
  assert.ok(ran[0].endsWith('--json --no-refresh'), 'never asks the network unless told: ' + ran[0]);
  assert.deepStrictEqual((await P.pluginManager({}, { here: path.join(HOME, 'nowhere') })), { installed: false });
  // self-heal: its switch is a file
  const off = P.selfHealOff(); try { fs.unlinkSync(off); } catch (e) {}
  assert.deepStrictEqual(P.setSelfHeal(false), { ok: true, on: false }); assert.ok(fs.existsSync(off));
  assert.deepStrictEqual(P.setSelfHeal(true), { ok: true, on: true }); assert.ok(!fs.existsSync(off));
  // the page's address, on a board whose plugin record is made up
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, out, pluginsInstalled: () => ({ 'self-heal': { name: 'self-heal', newest: '0.3.0', description: 'x', installs: [{ scope: 'project', project: 'C:/p' }] }, 'plugin-manager': { name: 'plugin-manager', newest: '0.20.1', description: 'y', installs: [{ scope: 'user', project: '' }] }, goal2: { name: 'goal2', newest: '0.5.8', description: 'z', installs: [] } }), pluginsRun: run, goal2: new (require('../lib/goal2').Goal2)({ root: null }) });
  await new Promise((r) => s2.listen(p2, '127.0.0.1', r));
  const via = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q2 = http.request({ host: '127.0.0.1', port: p2, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json' } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); }); if (b) q2.write(b); q2.end(); });
  for (const r of ['GET /api/plugins', 'POST /api/plugins/refresh', 'POST /api/plugins/update', 'POST /api/plugins/self-heal', 'POST /api/goals/start']) asked.add(r);
  const v = await via('/api/plugins');
  assert.deepStrictEqual([v.status, v.json.installed.map((x) => x.name), v.json.selfHeal, v.json.pm.installed, v.json.goal2.installed], [200, ['self-heal', 'plugin-manager', 'goal2'], { installed: true, on: true }, true, false], 'plugin-manager is found beside this plugin; its scripts are the stand-in');
  assert.deepStrictEqual(v.json.pm.behind.map((b) => b.name), ['a']);
  assert.strictEqual((await via('/api/plugins/refresh', {})).status, 200);
  const n0 = ran.length; assert.strictEqual((await via('/api/plugins/update', {})).status, 200);
  assert.ok(ran.slice(n0).some((x) => /update-all.js --apply --json/.test(x)), 'brought up to date through plugin-manager itself: ' + JSON.stringify(ran.slice(n0)));
  assert.strictEqual((await via('/api/plugins/self-heal', { on: 'yes' })).status, 400);
  assert.deepStrictEqual((await via('/api/plugins/self-heal', { on: false })).json, { ok: true, on: false }); P.setSelfHeal(true);
  assert.strictEqual((await via('/api/goals/start', { cwd: path.join(HOME, 'no-such'), task: 'x', condition: 'y' })).status, 400);
  assert.strictEqual((await via('/api/goals/start', { cwd: WORK, task: '', condition: 'y' })).status, 400);
  assert.strictEqual((await via('/api/goals/start', { cwd: WORK, task: 'x', condition: '' })).status, 400);
  assert.deepStrictEqual((await via('/api/goals/start', { cwd: WORK, task: 'x', condition: 'y' })).json, { ok: false, error: '這台電腦沒有裝 goal2' });
  // which integrations are on is a setting: a plugin not installed is never on; one switched off is gone from the view
  const ig = P.integrations({ 'self-heal': {}, goal2: {} }, { goal2: false });
  assert.deepStrictEqual(Object.fromEntries(Object.entries(ig).map(([k, x]) => [k, [x.installed, x.on]])), { goal2: [true, false], harness: [false, false], versions: [false, false], git: [true, true], daily: [false, false], selfHeal: [true, true], qa: [false, false], cbm: [false, false] });
  const offR = await via('/api/config', { integrations: { selfHeal: false, git: false, bogus: true } }); assert.strictEqual(offR.status, 200);
  const cfg = require('../lib/config').value('integrations', {}); assert.deepStrictEqual([cfg.selfHeal, cfg.git, cfg.bogus], [false, false, undefined]);
  const v2 = await via('/api/plugins');
  assert.deepStrictEqual([v2.json.selfHeal, v2.json.git, v2.json.integrations.selfHeal.on], [{ installed: false }, null, false], 'switched off: not in the view');
  assert.strictEqual((await via('/api/plugins/self-heal', { on: true })).status, 409, 'and its button refused');
  await via('/api/config', { integrations: { selfHeal: true, git: true } });
  s2.close(); if (s2.closeAllConnections) s2.closeAllConnections();
  // goal2 start: prepared through its tool, then run as a process of its own
  const { Goal2 } = require('../lib/goal2'); const spawned = [];
  const g = new Goal2({ root: path.join(HOME, 'g2'), run: (exe, args, opts, cb) => cb(null, JSON.stringify(args[1] === '--prompt-file' ? { ok: true, run_dir: 'D:/runs/r1', run_id: 'r1' } : { ok: true, runs: [] })), spawn: (exe, args, opts) => { spawned.push([args.slice(1), opts.detached]); return { on() {}, unref() {} }; } });
  assert.deepStrictEqual(await g.start('做事', '條件', WORK), { ok: true, runId: 'r1' });
  assert.deepStrictEqual(spawned, [[['--run', 'D:/runs/r1'], true]], 'detached: a restart of the board does not end it');
});

test('settings: read, and changed without touching the real computer', async () => {
  const c = await get('/api/config'); assert.strictEqual(c.status, 200); assert.ok(c.json.config);
  const n = did.length;
  const r = await post('/api/config', { autoRestore: true, autoContinue: false, autoStart: true, keepAlive: true, notify: false });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(since(n), ['autostart true', 'keepalive true', 'notify unregister']);
  const c2 = (await get('/api/config')).json;
  assert.strictEqual(c2.config.autoRestore, true); assert.strictEqual(c2.config.autoContinue, false); assert.strictEqual(c2.autoStart, true); assert.strictEqual(c2.notify, false);
  await post('/api/config', { notify: true, autoStart: false, keepAlive: false });
  assert.strictEqual((await post('/api/config', { pickerStartDir: 12345 })).status, 400, 'a setting of the wrong kind is refused');

  assert.strictEqual((await get('/api/watchdog')).status, 200);
  assert.strictEqual((await post('/api/watchdog', { stuck: false, stuckMinutes: 7 })).json.settings.stuckMinutes, 7);
  assert.strictEqual((await get('/api/watchdog')).json.settings.stuck, false);
  assert.strictEqual((await post('/api/watchdog', { stuckMinutes: 1 })).status, 400);

  assert.strictEqual((await get('/api/budget')).status, 200);
  assert.strictEqual((await post('/api/budget', { monthly: -1 })).status, 400);
  assert.strictEqual((await post('/api/budget', { monthly: 100, warnPct: 5 })).status, 400);
  assert.strictEqual((await post('/api/budget', { monthly: 100, warnPct: 80 })).json.settings.monthly, 100);
  assert.strictEqual((await get('/api/budget')).json.settings.monthly, 100);
  await post('/api/budget', { monthly: 0 });

  const pick = await post('/api/pick-folder'); assert.strictEqual(pick.json.path, WORK);
});

let B;   // a conversation on the board
test('a board conversation: new, role, send, stream, approval, stop, commands, shell, fork, close', async () => {
  assert.strictEqual((await post('/api/new', { cwd: path.join(HOME, 'no-such') })).status, 400);
  const n = await post('/api/new', { cwd: WORK }); assert.strictEqual(n.status, 200); B = n.json.sessionId;
  assert.ok((await get('/api/sessions')).json.sessions.find((x) => x.sessionId === B && x.notStarted));

  const roles = await post('/api/roles', { sessionId: B }); assert.ok(roles.json.roles.some((r) => r.name === 'reviewer'), roles.text);
  assert.deepStrictEqual((await post('/api/roles', { cwd: path.join(HOME, 'no-such') })).json.roles, []);
  assert.strictEqual((await post('/api/role', { sessionId: B, agent: 'reviewer' })).status, 200);
  assert.strictEqual((await post('/api/role', { sessionId: B, agent: 'nobody-by-that-name' })).status, 400);
  assert.strictEqual((await post('/api/role', { sessionId: B, agent: '' })).status, 200);

  // "!" commands: run here, kept for the next message
  assert.strictEqual((await post('/api/shell', { sessionId: uuid(99), command: 'ls' })).status, 404);
  assert.strictEqual((await post('/api/shell', { sessionId: T1, command: 'ls' })).status, 404, 'not for a terminal session');
  assert.strictEqual((await post('/api/shell', { sessionId: B, command: '   ' })).status, 400);
  assert.strictEqual((await post('/api/shell', { sessionId: B, command: 'x'.repeat(8001) })).status, 400);
  const sh1 = await post('/api/shell', { sessionId: B, command: 'echo secret' }); assert.strictEqual(sh1.json.ran, true); assert.strictEqual(sh1.json.stdout, 'out of echo secret\n');
  const sh2 = await post('/api/shell', { sessionId: B, command: 'git status' });
  const sh3 = await post('/api/shell', { sessionId: B, command: 'boom' }); assert.strictEqual(sh3.status, 200); assert.strictEqual(sh3.json.ran, false);
  assert.strictEqual((await post('/api/shell/drop', { sessionId: B, id: sh1.json.id })).json.ok, true, 'the one with the secret is not for Claude');
  assert.strictEqual((await post('/api/shell/drop', { sessionId: B, id: sh1.json.id })).json.ok, false);
  await post('/api/shell/drop', { sessionId: B, id: sh3.json.id });

  assert.strictEqual((await post('/api/send', { sessionId: B, text: '   ' })).status, 400);
  assert.strictEqual((await post('/api/send', { sessionId: uuid(99), text: 'hi' })).status, 409);
  assert.strictEqual((await post('/api/send', { sessionId: B, text: 'x', images: new Array(9).fill({ mime: 'image/png', data: PNG }) })).status, 400);
  assert.strictEqual((await post('/api/send', { sessionId: B, text: 'x', images: [{ mime: 'image/tiff', data: PNG }] })).status, 400);
  const before = procs.length;
  const sent = await post('/api/send', { sessionId: B, text: '第一句［圖1］', images: [{ mime: 'image/png', data: PNG, tag: 1 }] });
  assert.strictEqual(sent.status, 200, sent.text); assert.strictEqual(procs.length, before + 1);
  const proc = procs[procs.length - 1];
  const first = proc.p.stdin.written.find((x) => x && x.type === 'user');
  const texts = first.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.ok(texts.startsWith('<bash-input>git status</bash-input>'), 'what was run is in front of the message: ' + texts.slice(0, 80));
  assert.ok(!texts.includes('echo secret') && !texts.includes('boom'), 'what was dropped is not');
  assert.ok(first.message.content.some((b) => b.type === 'image'));
  assert.strictEqual((await post('/api/shell/drop', { sessionId: B })).json.ok, false, 'nothing kept after it went');

  const stream = await ask('/api/stream?sid=' + B + '&t=' + TOKEN, { headers: { 'x-board-token': '' }, firstChunk: true });
  assert.strictEqual(stream.status, 200); assert.match(stream.headers['content-type'], /event-stream/); assert.match(stream.text, /"type":"state"/);
  assert.strictEqual((await ask('/api/stream?sid=' + B + '&t=' + 'cd'.repeat(24), { headers: { 'x-board-token': TOKEN } })).status, 401, 'the stream takes the key from the address only');
  assert.strictEqual((await get('/api/stream?sid=' + uuid(99) + '&t=' + TOKEN)).status, 404);

  // Claude asks to run something: the answer goes back to its process
  proc.p.out({ type: 'system', subtype: 'init', session_id: B, permissionMode: 'default', model: 'claude-opus-5-5' });
  proc.p.out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual((await get('/api/sessions')).json.sessions.find((x) => x.sessionId === B).status, 'waiting');
  assert.strictEqual((await post('/api/permission', { sessionId: B, requestId: 'no-such', allow: true })).status, 404);
  assert.strictEqual((await post('/api/permission', { sessionId: B, requestId: 'req-1', allow: true })).status, 200);
  assert.ok(proc.p.stdin.written.some((x) => x && x.type === 'control_response' && x.response.request_id === 'req-1' && x.response.response.behavior === 'allow'));

  // model and effort: not while it works; from its next message once it is done
  assert.deepStrictEqual([(await post('/api/model', { sessionId: B, model: 'opus' })).status, (await post('/api/model', { sessionId: B, model: 'opus' })).json.error], [409, '它這一輪還在跑，等它做完或先停止再換']);
  assert.strictEqual((await post('/api/model', { sessionId: B, model: 'gpt' })).status, 400);
  assert.strictEqual((await post('/api/model', { sessionId: B, effort: 'extreme' })).status, 400);
  assert.strictEqual((await post('/api/model', { sessionId: uuid(99), model: 'opus' })).status, 404);
  assert.strictEqual((await post('/api/seen', { sessionId: B })).json.ok, true);
  assert.strictEqual((await post('/api/notices/seen-session', { sessionId: B })).json.ok, true);

  assert.strictEqual((await get('/api/commands?sid=' + uuid(99))).status, 404);
  assert.strictEqual((await post('/api/to-terminal', { sessionId: B })).status, 409, 'not while it is working');
  const blocked = await post('/api/shutdown'); assert.strictEqual(blocked.status, 409); assert.ok(blocked.json.active.length >= 1, 'the board is not stopped under a working conversation');
  assert.ok(!did.includes('exit 0'));

  assert.strictEqual((await post('/api/stop', { sessionId: B })).json.ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual((await post('/api/close-empty', { sessionId: B })).json.ok, false, 'it has been used: not thrown away as empty');

  // a copy of a conversation that has something in it; not of one that has nothing
  // off unless switched on in the settings
  assert.strictEqual((await get('/api/sessions')).json.features.fork, false);
  assert.strictEqual((await post('/api/fork', { sessionId: T1 })).status, 403);
  assert.strictEqual((await post('/api/config', { showFork: true })).status, 200);
  assert.deepStrictEqual([(await get('/api/sessions')).json.features.fork, (await get('/api/config')).json.showFork], [true, true]);
  assert.strictEqual((await post('/api/fork', { sessionId: uuid(99) })).status, 404);
  assert.strictEqual((await post('/api/fork', { sessionId: B })).status, 400);
  const fk = await post('/api/fork', { sessionId: T1 }); assert.strictEqual(fk.status, 200);
  assert.strictEqual(channels.get(fk.json.sessionId).forkOf, T1);
  assert.strictEqual((await post('/api/close', { sessionId: fk.json.sessionId })).json.ok, true);
  assert.strictEqual((await post('/api/close', { sessionId: fk.json.sessionId })).json.ok, false);

  // a message edited and sent again: carried on from the reply before it, as a new board conversation; the old one closed
  const RW = (await post('/api/new', { cwd: WORK })).json.sessionId;
  {
    const dir = path.join(CLAUDE, 'projects', S.encodeCwd(WORK)), ts = new Date().toISOString();
    fs.writeFileSync(path.join(dir, RW + '.jsonl'), [
      line({ type: 'user', uuid: uuid(81), parentUuid: null, sessionId: RW, cwd: WORK, timestamp: ts, message: { role: 'user', content: '第一句' } }),
      line({ type: 'assistant', uuid: uuid(82), parentUuid: uuid(81), sessionId: RW, cwd: WORK, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }),
      line({ type: 'user', uuid: uuid(83), parentUuid: uuid(82), sessionId: RW, cwd: WORK, timestamp: ts, message: { role: 'user', content: '第二句' } }),
    ].join('\n') + '\n');
  }
  assert.strictEqual((await post('/api/rewind', { sessionId: T1, at: uuid(83), text: 'x' })).status, 400, 'a terminal session: not the board\'s to carry on');
  assert.strictEqual((await post('/api/rewind', { sessionId: RW, at: uuid(83), text: '  ' })).status, 400, 'nothing to send');
  assert.strictEqual((await post('/api/rewind', { sessionId: RW, at: uuid(99), text: 'x' })).status, 400, 'not in its transcript');
  assert.strictEqual((await post('/api/rewind', { sessionId: RW, at: uuid(82), text: 'x' })).status, 400, 'a reply is not yours to edit');
  const procsAt = procs.length;
  const rw = await post('/api/rewind', { sessionId: RW, at: uuid(83), text: '改過的第二句' });
  assert.strictEqual(rw.status, 200); assert.strictEqual(rw.json.fromStart, false);
  const rwNew = channels.get(rw.json.sessionId);
  assert.deepStrictEqual([rwNew.forkOf, rwNew.resumeAt, channels.get(RW)], [RW, uuid(82), null], 'from the reply before it; the old one closed');
  const rwArgs = procs.slice(procsAt).map((x) => x.args).find((a) => a.includes('--resume-session-at'));
  assert.ok(rwArgs, 'started from that entry');
  assert.deepStrictEqual(rwArgs.slice(rwArgs.indexOf('--resume'), rwArgs.indexOf('--resume') + 6), ['--resume', RW, '--resume-session-at', uuid(82), '--fork-session', '--session-id']);
  const rwSent = procs[procs.length - 1].p.stdin.written.find((w) => w && w.type === 'user');
  assert.ok(rwSent && JSON.stringify(rwSent).includes('改過的第二句'), 'the new words sent');
  // the first message edited: a conversation that starts afresh (nothing to carry on from)
  {
    const dir = path.join(CLAUDE, 'projects', S.encodeCwd(WORK));
    fs.copyFileSync(path.join(dir, RW + '.jsonl'), path.join(dir, rw.json.sessionId + '.jsonl'));
  }
  const rw2 = await post('/api/rewind', { sessionId: rw.json.sessionId, at: uuid(81), text: '重新開始' });
  assert.strictEqual(rw2.status, 200); assert.strictEqual(rw2.json.fromStart, true);
  assert.strictEqual(channels.get(rw2.json.sessionId).forkOf, undefined);
  await post('/api/stop', { sessionId: rw2.json.sessionId }); await post('/api/close', { sessionId: rw2.json.sessionId });

  // what goes with it, and what does not: a conversation that is working (its process ends before the new one starts),
  // with a name you gave it, notes of "!" not yet sent, and a title
  {
    const cfg = require('../lib/config');
    const R3 = (await post('/api/new', { cwd: WORK })).json.sessionId;
    const dir = path.join(CLAUDE, 'projects', S.encodeCwd(WORK));
    fs.copyFileSync(path.join(dir, RW + '.jsonl'), path.join(dir, R3 + '.jsonl'));
    await post('/api/send', { sessionId: R3, text: '在跑' });
    const c3 = channels.get(R3);
    c3.title = '舊的標題'; c3.shellNotes = [{ id: 1, command: 'echo shell-note-1', stdout: 'shell-note-1', stderr: '', code: 0, at: Date.now() }]; c3.shellSeq = 1;
    cfg.setValue('customTitles', Object.assign({}, cfg.value('customTitles', {}), { [R3]: '我取的名字' }));
    const oldProc = c3.proc; assert.ok(oldProc, 'it has a process');
    const order = []; oldProc.once('exit', () => order.push('old ended'));
    const at = procs.length;
    const r3 = await post('/api/rewind', { sessionId: R3, at: uuid(83), text: '改過' });
    assert.strictEqual(r3.status, 200, JSON.stringify(r3.json));
    order.push('new started:' + (procs.length > at));
    assert.deepStrictEqual(order, ['old ended', 'new started:true'], 'the old process ended before the answer (and the new one started)');
    const n3 = channels.get(r3.json.sessionId);
    assert.strictEqual(n3.title, '舊的標題', 'carried on: its title goes with it');
    assert.strictEqual(cfg.value('customTitles', {})[n3.sessionId], '我取的名字', 'the name you gave it goes with it');
    const said3 = procs.slice(at).map((x) => JSON.stringify(x.p.stdin.written)).join('\n');
    assert.ok(said3.includes('echo shell-note-1') && said3.includes('改過'), 'the "!" notes not yet sent go in front of the new words');
    // started afresh (the first message edited): not the old title; the name you gave it still goes with it
    fs.copyFileSync(path.join(dir, RW + '.jsonl'), path.join(dir, n3.sessionId + '.jsonl'));
    const r4 = await post('/api/rewind', { sessionId: n3.sessionId, at: uuid(81), text: '從頭' });
    assert.strictEqual(r4.status, 200);
    assert.notStrictEqual(channels.get(r4.json.sessionId).title, '舊的標題', 'started afresh: the title comes from the new words');
    assert.strictEqual(cfg.value('customTitles', {})[r4.json.sessionId], '我取的名字');
    // the new words cannot be sent: the new conversation and the name written for it are taken away again
    fs.copyFileSync(path.join(dir, RW + '.jsonl'), path.join(dir, r4.json.sessionId + '.jsonl'));
    const realSend = channels.send;
    channels.send = (sid, text) => (channels.get(sid) && channels.get(sid).forkOf ? { ok: false, error: '送不出去（測試）' } : realSend.call(channels, sid, text));
    const before5 = channels.list().length;
    const r5 = await post('/api/rewind', { sessionId: r4.json.sessionId, at: uuid(83), text: 'x' });
    channels.send = realSend;
    assert.deepStrictEqual([r5.status, /原本的對話已停下/.test(r5.json.error)], [500, true]);
    assert.strictEqual(channels.list().length, before5, 'no new conversation left behind');
    assert.ok(channels.get(r4.json.sessionId), 'the old one is still there');
    const leftNames = Object.keys(cfg.value('customTitles', {})).filter((k) => !channels.get(k) && cfg.value('customTitles', {})[k] === '我取的名字' && k !== R3 && k !== n3.sessionId);
    assert.deepStrictEqual(leftNames, [], 'the name written for the new one is gone');
    // pressed twice: the second waits its turn rather than carrying the same one on again
    await post('/api/send', { sessionId: r4.json.sessionId, text: '又在跑' });
    const p6 = channels.get(r4.json.sessionId).proc; const realKill = p6.kill; p6.kill = () => { setTimeout(() => p6.emit('exit', null), 200); };
    const [a6, b6] = await Promise.all([post('/api/rewind', { sessionId: r4.json.sessionId, at: uuid(83), text: '一' }), post('/api/rewind', { sessionId: r4.json.sessionId, at: uuid(83), text: '二' })]);
    p6.kill = realKill;
    assert.deepStrictEqual([a6.status, b6.status].sort(), [200, 409]);
    for (const x of [a6, b6]) if (x.status === 200) { await post('/api/stop', { sessionId: x.json.sessionId }); await post('/api/close', { sessionId: x.json.sessionId }); }
    cfg.setValue('customTitles', Object.fromEntries(Object.entries(cfg.value('customTitles', {})).filter(([, v]) => v !== '我取的名字')));
  }

  const e = await post('/api/new', { cwd: WORK });
  assert.strictEqual((await post('/api/close-empty', { sessionId: e.json.sessionId })).json.ok, true);

  // words typed and not sent: kept by the board - not thrown away as empty, listed with them, and back when cleared
  const dft = (await post('/api/new', { cwd: WORK })).json.sessionId;
  assert.strictEqual((await post('/api/draft', { sessionId: dft, text: '幫我看一下這個錯誤' })).json.ok, true);
  assert.strictEqual((await post('/api/close-empty', { sessionId: dft })).json.ok, false, 'a draft of yours: not closed');
  const listed = ((await get('/api/sessions')).json.sessions || []).find((x) => x.sessionId === dft);
  assert.ok(listed && !listed.notStarted && listed.draft === '幫我看一下這個錯誤' && /^草稿：幫我看一下/.test(listed.title), 'listed, with its draft: ' + JSON.stringify(listed));
  assert.strictEqual(channels.get(dft).draft, '幫我看一下這個錯誤', 'kept where the board keeps its conversations');
  assert.strictEqual((await post('/api/draft', { sessionId: dft, text: '   ' })).json.ok, true);
  assert.strictEqual((await post('/api/close-empty', { sessionId: dft })).json.ok, true, 'emptied: closed as before');
  // sent: what was in the box is a message now, not a draft to keep
  const sentId = (await post('/api/new', { cwd: WORK })).json.sessionId;
  await post('/api/draft', { sessionId: sentId, text: '要送的話' });
  assert.strictEqual((await post('/api/send', { sessionId: sentId, text: '要送的話' })).json.ok, true);
  assert.strictEqual(channels.get(sentId).draft, '', 'the draft goes once it is sent');
  assert.ok(!((await get('/api/sessions')).json.sessions || []).find((x) => x.sessionId === sentId).draft, 'and the list no longer shows one');
  assert.strictEqual((await post('/api/draft', { sessionId: dft, text: 'x' })).status, 404, 'a conversation no longer there');
  assert.strictEqual((await post('/api/draft', { sessionId: e.json.sessionId })).status, 400, 'no text');
});

test('files: preview, open, show - and what is refused', WIN_ONLY, async () => {
  const note = path.join(WORK, 'note.md');
  const chk = await post('/api/files/check', { sessionId: T1, paths: ['note.md', 'missing.txt', note, '\\\\host\\share\\x.txt'] });
  assert.strictEqual(chk.json.files[0].abs, note); assert.strictEqual(chk.json.files[1], null); assert.strictEqual(chk.json.files[2].kind, 'text'); assert.strictEqual(chk.json.files[3], null);

  const f = await get('/api/file?path=' + enc(note)); assert.strictEqual(f.status, 200); assert.strictEqual(f.text, '# hi\n'); assert.strictEqual(f.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual((await get('/api/file?path=' + enc(path.join(WORK, 'nope.md')))).status, 404);
  assert.strictEqual((await get('/api/file?path=' + enc('\\\\host\\share\\x.txt'))).status, 404);
  assert.strictEqual((await get('/api/file?path=' + enc(path.join(WORK, 'a.docx')))).status, 415);

  const n = did.length;
  const pdf = await get('/api/file/pdf?path=' + enc(path.join(WORK, 'a.docx'))); assert.strictEqual(pdf.status, 200); assert.strictEqual(pdf.headers['content-type'], 'application/pdf'); assert.match(pdf.text, /^%PDF/);
  assert.strictEqual((await get('/api/file/pdf?path=' + enc(note))).status, 404);
  // the preview's own address for a PDF: ends in the file's name, works without the token header, only for its file
  const tk = await post('/api/file/ticket', { path: path.join(WORK, 'a.docx') });
  assert.ok(/^\/api\/view\/[0-9a-f]{36}\/a\.pdf$/.test(tk.json.url), tk.json.url);
  const v = await ask(tk.json.url, { headers: { 'x-board-token': '' } });
  assert.deepStrictEqual([v.status, v.headers['content-type'], /^inline; .*filename\*=UTF-8''a\.pdf$/.test(v.headers['content-disposition'])], [200, 'application/pdf', true]);
  assert.match(v.text, /^%PDF/);
  assert.strictEqual((await ask('/api/view/' + 'f'.repeat(36) + '/a.pdf', { headers: { 'x-board-token': '' } })).status, 404, 'a ticket never given');
  assert.strictEqual((await post('/api/file/ticket', { path: note })).status, 404, 'only PDF, Office and web page files');
  assert.deepStrictEqual(since(n), ['convertOffice']);

  // a web page: served as a page with what sits beside it, shut in; nothing hidden, nothing above its folder, nothing
  // that is not part of a page
  const site = path.join(WORK, 'site'); fs.mkdirSync(path.join(site, 'img'), { recursive: true });
  fs.writeFileSync(path.join(site, 'page.html'), '<img src="img/a.png">'); fs.writeFileSync(path.join(site, 'img', 'a.png'), 'PNG');
  fs.writeFileSync(path.join(site, '.env'), 'SECRET=1'); fs.writeFileSync(path.join(site, 'run.exe'), 'MZ');
  const pt = await post('/api/file/ticket', { path: path.join(site, 'page.html') });
  assert.ok(/^\/api\/view\/[0-9a-f]{36}\/page\.html$/.test(pt.json.url), pt.json.url);
  const pbase = pt.json.url.replace(/[^/]+$/, ''), noKey = { headers: { 'x-board-token': '' } };
  const pg = await ask(pt.json.url, noKey);
  assert.deepStrictEqual([pg.status, pg.headers['content-type'], /^sandbox allow-scripts/.test(pg.headers['content-security-policy']), /connect-src 'none'/.test(pg.headers['content-security-policy'])], [200, 'text/html; charset=utf-8', true, true]);
  assert.deepStrictEqual([(await ask(pbase + 'img/a.png', noKey)).status, (await ask(pbase + 'img/a.png', noKey)).headers['content-type']], [200, 'image/png'], 'a picture beside it');
  fs.writeFileSync(path.join(site, 'data.json'), '{"secret":1}'); fs.writeFileSync(path.join(site, 'notes.md'), 'x');
  for (const bad of ['.env', 'run.exe', '..%2Fnote.md', '%2E%2E/note.md', 'img/../../note.md', 'nope.png',
    // nothing that reaches another host or drive, nor a short name standing for a hidden folder, nor data files
    '%5C%5Chost%5Cs%5Cx.png', '//host/s/x.png', 'img%5C..%5C..%5Cnote.md', 'C:%2FWindows%2Fwin.ini', 'img//a.png', 'GIT~1/a.png', 'data.json', 'notes.md'])
    assert.strictEqual((await ask(pbase + bad, noKey)).status, 404, bad);
  assert.match(pg.headers['content-security-policy'], /^sandbox allow-scripts allow-popups;/, 'what the page opens stays shut in');
  // a file with a second name (a hard link to something kept elsewhere) is not served from a page's folder
  const secret = path.join(WORK, 'secret.txt'); fs.writeFileSync(secret, 'SECRET=1');
  let linked = false; try { fs.linkSync(secret, path.join(site, 'img', 'b.png')); linked = true; } catch (e) {}
  if (linked) assert.strictEqual((await ask(pbase + 'img/b.png', noKey)).status, 404, 'a hard link');
  assert.strictEqual((await ask(pbase + 'img/a.png', noKey)).status, 200, 'a picture of its own still is');
  // ... but the page you opened is shown whatever names it has (an upload sent again is given a second one)
  let pageLinked = false; try { fs.linkSync(path.join(site, 'page.html'), path.join(WORK, 'page-second-name.html')); pageLinked = true; } catch (e) {}
  if (pageLinked) assert.strictEqual((await ask(pt.json.url, noKey)).status, 200, 'the page itself, with two names');
  // a PDF's address is for the file it was given for: another file put in its place since is not served under it
  const swapPdf = path.join(WORK, 'swap.pdf'); fs.writeFileSync(swapPdf, '%PDF-1.4 first');
  const sp = await post('/api/file/ticket', { path: swapPdf });
  assert.strictEqual((await ask(sp.json.url, noKey)).status, 200, 'the file it was given for');
  fs.rmSync(swapPdf); fs.writeFileSync(swapPdf, '%PDF-1.4 put in its place');
  assert.strictEqual((await ask(sp.json.url, noKey)).status, 404, 'another file under the same name');
  // a link under the folder (a junction here: needs no special right) is not followed, wherever it leads
  try { fs.symlinkSync(path.join(WORK), path.join(site, 'lnk'), 'junction'); } catch (e) {}
  if (fs.existsSync(path.join(site, 'lnk'))) {
    fs.writeFileSync(path.join(WORK, 'via.png'), 'PNG');
    assert.strictEqual((await ask(pbase + 'lnk/via.png', noKey)).status, 404, 'through a junction');
  }

  const m = did.length;
  assert.strictEqual((await post('/api/file/open', { path: note })).status, 200);
  assert.deepStrictEqual(since(m), ['spawn explorer.exe']);
  assert.strictEqual((await post('/api/file/open', { path: path.join(WORK, 'run.ps1') })).status, 400, 'a script is never opened with one press');
  assert.strictEqual((await post('/api/file/open', { path: path.join(WORK, 'old.doc') })).status, 400, 'nor an old-format Office file');
  assert.strictEqual((await post('/api/file/open', { path: path.join(WORK, 'nope.md') })).status, 404);
  assert.strictEqual((await post('/api/file/open', { path: '\\\\host\\share\\x.txt' })).status, 404);
  assert.strictEqual(did.length, m + 1, 'nothing else was started');

  const dl = await get('/api/file/download?path=' + enc(path.join(WORK, 'a.docx')));
  assert.deepStrictEqual([dl.status, dl.headers['content-type'], /attachment; filename="a\.docx"/.test(dl.headers['content-disposition']), dl.text], [200, 'application/octet-stream', true, 'not really']);
  fs.writeFileSync(path.join(WORK, '報告 1.md'), 'x');
  assert.ok(/filename\*=UTF-8''%E5%A0%B1%E5%91%8A%201\.md/.test((await get('/api/file/download?path=' + enc(path.join(WORK, '報告 1.md')))).headers['content-disposition']), 'a name that is not plain ASCII is kept');
  assert.strictEqual((await get('/api/file/download?path=' + enc('\\\\host\\share\\x.txt'))).status, 404, 'never a network path');
  assert.strictEqual((await get('/api/file/download?path=' + enc(path.join(WORK, 'nope.bin')))).status, 404);
  assert.strictEqual((await get('/api/file/download?path=' + enc(WORK))).status, 404, 'not a folder');
  const r = await post('/api/file/reveal', { path: note }); assert.strictEqual(r.json.front, true);
  assert.strictEqual((await post('/api/file/reveal', { path: '\\\\host\\share' })).status, 404);
  assert.strictEqual((await post('/api/file/reveal', { path: 'relative\\x' })).status, 404);
});

test('notices and hiding', async () => {
  const { Notices } = require('../lib/notices');
  const N = new Notices();
  N.open({ key: 'budget:2099-01:warn', kind: 'budget', title: 't', text: 'x' });
  const list = await get('/api/notices'); assert.strictEqual(list.status, 200);
  const mine = list.json.open.find((x) => x.key === 'budget:2099-01:warn'); assert.ok(mine, list.text);
  assert.strictEqual((await post('/api/notices/dismiss', { id: mine.id })).json.ok, true);
  assert.ok(!(await get('/api/notices')).json.open.some((x) => x.id === mine.id));
  assert.ok((await post('/api/notices/clear-closed')).json.removed >= 1);

  assert.strictEqual((await post('/api/hide', { sessionId: 'zz' })).status, 400);
  assert.strictEqual((await post('/api/hide', { sessionId: T2, hidden: true })).json.hidden, 1);
  assert.strictEqual((await get('/api/sessions')).json.sessions.find((x) => x.sessionId === T2).hidden, true);
  assert.strictEqual((await post('/api/hide', { clear: true })).json.hidden, 0);
});

test('schedules', async () => {
  assert.strictEqual((await post('/api/schedule/save', { name: 'x' })).status, 400);
  // after the quota resets: refused when no 5-hour window is running (this made-up home has no quota figures)
  const rs = await post('/api/schedule/save', { name: 'x', kind: 'reset', cwd: WORK, prompt: 'hi' }); assert.deepStrictEqual([rs.status, /沒有 5 小時額度在計時/.test(rs.json.error)], [400, true]);
  // with a 5-hour window running: saved as a one-off a minute after its reset (the figures Claude Code leaves, as they are written)
  const reset = Math.floor(Date.now() / 1000) + 2 * 3600 + 17 * 60;
  fs.writeFileSync(path.join(CLAUDE, 'rate-limit-snapshots.json'), JSON.stringify({ s1: { t: Math.floor(Date.now() / 1000), five_hour: { used_percentage: 97, resets_at: reset }, seven_day: null } }));
  const ok = await post('/api/schedule/save', { name: '額度回來再跑', kind: 'reset', cwd: WORK, prompt: 'hi' });
  assert.strictEqual(ok.status, 200, ok.text);
  const want = new Date(reset * 1000 + 60000), pad = (n) => String(n).padStart(2, '0');
  const saved = (await get('/api/schedules')).json.schedules.find((x) => x.id === ok.json.id);
  assert.deepStrictEqual([saved.kind, saved.date, saved.at], ['once', want.getFullYear() + '-' + pad(want.getMonth() + 1) + '-' + pad(want.getDate()), pad(want.getHours()) + ':' + pad(want.getMinutes())]);
  assert.ok(Math.abs(saved.next - (reset * 1000 + 60000)) < 60000, 'next run is a minute after the reset: ' + new Date(saved.next).toISOString());
  await post('/api/schedule/delete', { id: ok.json.id });
  fs.unlinkSync(path.join(CLAUDE, 'rate-limit-snapshots.json'));
  // a goal schedule where goal2 is not installed (this test's board has none)
  const gs = await post('/api/schedule/save', { name: 'g', kind: 'daily', at: '09:00', target: 'goal', cwd: WORK, prompt: 'hi', goal: 'done' }); assert.deepStrictEqual([gs.status, gs.json.error], [400, '這台電腦沒有裝 goal2，不能交辦 goal']);
  assert.strictEqual((await post('/api/schedule/save', { name: 'x', kind: 'daily', at: '09:00', cwd: path.join(HOME, 'no-such'), prompt: 'hi' })).status, 400);
  assert.strictEqual((await post('/api/schedule/save', { name: 'x', kind: 'daily', at: '09:00', cwd: WORK, prompt: 'hi', agent: 'nobody' })).status, 400);
  const sv = await post('/api/schedule/save', { name: '每日檢查', kind: 'daily', at: '09:00', cwd: WORK, prompt: '看一下', agent: 'reviewer' });
  assert.strictEqual(sv.status, 200, sv.text);
  const id = sv.json.id;
  const ls = await get('/api/schedules'); assert.ok(ls.json.schedules.some((x) => x.id === id && x.enabled));
  assert.strictEqual((await post('/api/schedule/toggle', { id, enabled: false })).json.ok, true);
  assert.strictEqual((await get('/api/schedules')).json.schedules.find((x) => x.id === id).enabled, false);
  assert.strictEqual((await post('/api/schedule/run', { id: 99999 })).status, 404);
  const before = procs.length;
  const run = await post('/api/schedule/run', { id }); assert.strictEqual(run.status, 200); assert.strictEqual(run.json.ok, true, run.text);
  assert.strictEqual(procs.length, before + 1, 'it started a conversation (a stand-in here)');
  assert.ok(procs[procs.length - 1].args.includes('reviewer'));
  await post('/api/stop', { sessionId: run.json.sessionId }); await post('/api/close', { sessionId: run.json.sessionId });
  assert.strictEqual((await post('/api/schedule/notice', { id: 99999, action: 'dismiss' })).status, 200);
  assert.strictEqual((await post('/api/schedule/delete', { id })).json.ok, true);
  assert.ok(!(await get('/api/schedules')).json.schedules.some((x) => x.id === id));
});

test('inbox', async () => {
  const empty = await get('/api/inbox'); assert.strictEqual(empty.status, 200); assert.deepStrictEqual(empty.json.threads, []);
  assert.strictEqual((await post('/api/inbox/settings', { me: 'me@example.com, 我', enabled: true })).json.ok, true);
  assert.deepStrictEqual((await get('/api/inbox')).json.status.identities, ['me@example.com', '我'], 'names survive the trip as written');
  assert.strictEqual((await post('/api/inbox/route', { source: 'mail', source_ref: 'x' })).status, 400);
  assert.strictEqual((await post('/api/inbox/route', { source: 'gmail', source_ref: '客戶A', root_folder: path.join(HOME, 'no-such') })).status, 400);
  const rt = await post('/api/inbox/route', { source: 'gmail', source_ref: '客戶A', customer: 'A', root_folder: WORK }); assert.strictEqual(rt.status, 200, rt.text);

  inbox.inbox.ingest({ source: 'gmail', threadId: 'gmail:t1', sourceMsgId: 'gmail:m1', refs: ['INBOX', '客戶A'], from: 'a@x.com', subject: '登入失敗', bodyText: '客戶說登不進去', ts: Date.now() });
  inbox.inbox.ingest({ source: 'gmail', threadId: 'gmail:t2', sourceMsgId: 'gmail:m2', refs: ['INBOX'], from: 'b@x.com', subject: '沒分派', bodyText: '另一件', ts: Date.now() });
  const all = (await get('/api/inbox')).json.threads; assert.strictEqual(all.length, 2);
  assert.strictEqual((await get('/api/inbox?q=' + enc('登入'))).json.threads.length, 1);
  const th = await get('/api/inbox/thread?id=' + enc('gmail:t1')); assert.strictEqual(th.status, 200);
  assert.strictEqual((await get('/api/inbox/thread?id=nope')).status, 404);

  assert.strictEqual((await post('/api/inbox/assign', { id: 'gmail:t2', folder: path.join(HOME, 'no-such') })).status, 400);
  assert.strictEqual((await post('/api/inbox/open', { id: 'gmail:t2' })).status, 400, 'not before it has a folder');
  assert.strictEqual((await post('/api/inbox/assign', { id: 'gmail:t2', folder: WORK })).json.ok, true);
  assert.strictEqual((await post('/api/inbox/text', { id: 'nope' })).status, 404);
  const tx = await post('/api/inbox/text', { id: 'gmail:t1' }); assert.strictEqual(tx.status, 200, tx.text); assert.match(tx.json.text, /客戶說登不進去/);
  assert.strictEqual((await post('/api/inbox/open', { id: 'nope' })).status, 404);
  const op = await post('/api/inbox/open', { id: 'gmail:t1' }); assert.strictEqual(op.status, 200, op.text);
  assert.strictEqual(channels.get(op.json.sessionId).cwd, WORK); assert.strictEqual(procs.filter((x) => x.opts && x.opts.cwd === WORK && x.sid === op.json.sessionId).length, 0, 'nothing is sent by opening');
  await post('/api/close-empty', { sessionId: op.json.sessionId });

  assert.strictEqual((await post('/api/inbox/done', { id: 'gmail:t1' })).json.ok, true);
  assert.strictEqual((await get('/api/inbox?open=1')).json.threads.length, 1);
  const pl = await post('/api/inbox/poll', { source: 'slack' }); assert.strictEqual(pl.status, 200);
  const gc = await post('/api/inbox/gmail/connect'); assert.strictEqual(gc.status, 400, 'no Google client file in this made-up home: said, and no browser is opened');
  const routeId = (await get('/api/inbox')).json.status.routes ? (await get('/api/inbox')).json.status.routes[0].id : inbox.inbox.routes()[0].id;
  assert.strictEqual((await post('/api/inbox/route/delete', { routeId })).json.ok, true);

  // the same addresses on a board that has no inbox
  const p2 = await freePort(); const bare = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, out });
  await new Promise((r) => bare.listen(p2, '127.0.0.1', r));
  const viaBare = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q = http.request({ host: '127.0.0.1', port: p2, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json' } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); }); if (b) q.write(b); q.end(); });
  assert.strictEqual((await viaBare('/api/inbox/poll', {})).status, 404);
  assert.deepStrictEqual((await viaBare('/api/inbox')).json, { threads: [], status: null });
  assert.strictEqual((await viaBare('/api/inbox/thread?id=x')).status, 404);
  assert.deepStrictEqual((await viaBare('/api/keep')).json.restorable, []);
  assert.strictEqual((await viaBare('/api/keep/set', { sessionId: T1, keep: true })).status, 404);
  assert.strictEqual((await viaBare('/api/schedule/run', { id: 1 })).status, 404);
  assert.strictEqual((await viaBare('/api/schedule/notice', { id: 1, action: 'x' })).status, 404);
  bare.close(); if (bare.closeAllConnections) bare.closeAllConnections();
});

test('a file uploaded for a message: kept under the board\'s folder, never over another, its name only a name', async () => {
  const a = await post('/api/upload', { name: '..\\..\\報價 v2.pdf', data: Buffer.from('one').toString('base64') });
  assert.strictEqual(a.status, 200);
  assert.ok(a.json.path.startsWith(path.join(CLAUDE, 'session-board', 'uploads') + path.sep), 'under the board\'s own folder: ' + a.json.path);
  assert.strictEqual(path.basename(a.json.path), '報價 v2.pdf', 'what was a path in the name is gone');
  assert.strictEqual(fs.readFileSync(a.json.path, 'utf8'), 'one');
  const b = await post('/api/upload', { name: '報價 v2.pdf', data: Buffer.from('two').toString('base64') });
  assert.strictEqual(path.basename(b.json.path), '報價 v2 (2).pdf'); assert.strictEqual(fs.readFileSync(a.json.path, 'utf8'), 'one', 'the first one is still there');
  assert.strictEqual((await post('/api/upload', { name: 'x.txt', data: '' })).status, 400, 'empty');
  // the same file again - the same bytes, whatever the name - is the one already kept: no second copy
  const again = await post('/api/upload', { name: '另一個名字.pdf', data: Buffer.from('one').toString('base64') });
  assert.deepStrictEqual([again.json.path, again.json.reused], [a.json.path, true]);
  assert.strictEqual(fs.readdirSync(path.dirname(a.json.path)).filter((n) => /另一個名字/.test(n)).length, 0, 'nothing new written');
  // kept 25 days already: a second name in today's folder (a hard link - stored once), the old path still there
  const upRoot = path.dirname(path.dirname(a.json.path)), old = new Date(Date.now() - 25 * 86400000);
  const oldDay = old.getFullYear() + '-' + String(old.getMonth() + 1).padStart(2, '0') + '-' + String(old.getDate()).padStart(2, '0');
  fs.mkdirSync(path.join(upRoot, oldDay), { recursive: true }); fs.writeFileSync(path.join(upRoot, oldDay, '舊的.txt'), 'kept a while');
  const moved = await post('/api/upload', { name: '新名字.txt', data: Buffer.from('kept a while').toString('base64') });
  assert.deepStrictEqual([moved.json.reused, path.dirname(moved.json.path), path.basename(moved.json.path), fs.existsSync(path.join(upRoot, oldDay, '舊的.txt'))],
    [true, path.dirname(a.json.path), '舊的.txt', true]);
  assert.strictEqual(fs.statSync(moved.json.path).nlink, 2, 'one file with two names, not a copy');
  // a Windows device name is not used as one: with an extension, spaces before it, the superscript digits, CONIN$
  for (const [n, want] of [['CON.txt', '_CON.txt'], ['nul', '_nul'], ['CON .txt', '_CON .txt'], ['COM¹.log', '_COM¹.log'], ['LPT³', '_LPT³'], ['CONIN$', '_CONIN$'], ['console.txt', 'console.txt']]) {
    assert.strictEqual(path.basename((await post('/api/upload', { name: n, data: Buffer.from('device ' + n).toString('base64') })).json.path), want, n);
  }
  // cut to length, then the dots and spaces Windows drops at the end: the path handed back is the file's
  const long = 'a'.repeat(119) + '. .pdf';
  const lp = (await post('/api/upload', { name: long, data: Buffer.from('l').toString('base64') })).json.path;
  assert.ok(!/[. ]$/.test(path.basename(lp)) && fs.existsSync(lp), path.basename(lp));
  // a file already there by that name is never written over - one put there by something else too ('wx': the write
  // fails when the file exists, so another process writing the same name in between cannot be overwritten either)
  const day = path.dirname(a.json.path); fs.writeFileSync(path.join(day, 'same.txt'), 'theirs');
  const mine = await post('/api/upload', { name: 'same.txt', data: Buffer.from('mine').toString('base64') });
  assert.strictEqual(path.basename(mine.json.path), 'same (2).txt');
  assert.strictEqual(fs.readFileSync(path.join(day, 'same.txt'), 'utf8'), 'theirs');
  // a day over a month old goes at the next upload; this month's stay
  const up = path.join(CLAUDE, 'session-board', 'uploads'); fs.mkdirSync(path.join(up, '2020-01-01'), { recursive: true }); fs.writeFileSync(path.join(up, '2020-01-01', 'old.txt'), 'x');
  await post('/api/upload', { name: 'y.txt', data: Buffer.from('y').toString('base64') });
  assert.ok(!fs.existsSync(path.join(up, '2020-01-01')), 'the old day is gone'); assert.ok(fs.existsSync(a.json.path), 'today\'s are kept');
  assert.strictEqual((await post('/api/upload', { name: 'big.bin', data: Buffer.alloc(31 * 1024 * 1024).toString('base64') })).json.error, '檔案太大（上限 30 MB）');
});

test('old conversations: listed, opened on the board or in a terminal', WIN_ONLY, async () => {
  const p = await get('/api/past'); assert.strictEqual(p.status, 200);
  const ids = JSON.stringify(p.json); assert.ok(ids.includes(PAST) && ids.includes(PAST2)); assert.ok(!ids.includes(T1), 'what is open now is not an old conversation');
  assert.ok(!JSON.stringify((await get('/api/past?q=' + enc('沒有這種字'))).json).includes(PAST));
  // which ids written in a page are conversations here: whole, or their first 8 characters; open or not; others left out
  const LONE = 'abcdef12-0000-4000-8000-000000000077'; transcript(LONE, WORK, Date.now() - 1800000);
  const w = await post('/api/past/which', { ids: [PAST, T1, 'ABCDEF12', '00000000', uuid(98), '1AC14E77-02E7-4E5D-B744-2EB1AE5198B7', 'zz'] });
  assert.strictEqual(w.status, 200);
  assert.deepStrictEqual(Object.keys(w.json.found).sort(), [PAST, T1, 'abcdef12'].sort(), 'whole ids and a short one that fits one; "00000000" fits four: none');
  assert.deepStrictEqual([w.json.found[PAST].open, w.json.found[T1].open, w.json.found.abcdef12.sessionId], [false, true, LONE]);
  assert.strictEqual(w.json.found[PAST].cwd, WORK, 'its folder, from its record');
  assert.strictEqual((await post('/api/past/open', { sessionId: uuid(98) })).status, 404);
  assert.strictEqual((await post('/api/past/open', { sessionId: T1 })).status, 409, 'it is open already');
  const n = did.length;
  assert.strictEqual((await post('/api/past/open', { sessionId: PAST, to: 'board' })).status, 200);
  assert.ok(channels.get(PAST)); assert.deepStrictEqual(since(n), [], 'on the board: no window');
  assert.strictEqual((await post('/api/past/open', { sessionId: PAST2 })).status, 200);
  assert.strictEqual(since(n).length, 1); assert.match(since(n)[0], new RegExp('^openTerminal .*' + PAST2));

  // board -> terminal
  const m = did.length;
  assert.strictEqual((await post('/api/to-terminal', { sessionId: uuid(99) })).status, 404);
  assert.strictEqual((await post('/api/to-terminal', { sessionId: PAST })).status, 200);
  // its name goes with it: a terminal session with no title of its own yet shows the name it had on the board,
  // not the one Claude Code makes up for it
  const kept = require('../lib/config').value('movedTitles', {});
  assert.strictEqual(kept[PAST], '測試對話 ' + PAST.slice(-1));
  const dir = path.join(HOME, 'reg'); fs.mkdirSync(dir, { recursive: true });
  const NEW = uuid(55);
  fs.writeFileSync(path.join(dir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: NEW, cwd: WORK, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli', name: 'work-d9', status: 'idle', updatedAt: Date.now(), statusUpdatedAt: Date.now() }));
  const named = (titles) => S.buildSessions({ sessionsDir: dir, pidAlive: () => true, titles }, Date.now()).find((x) => x.sessionId === NEW).title;
  assert.strictEqual(named({}), 'work-d9');
  assert.strictEqual(named({ [NEW]: '在看板上的名字' }), '在看板上的名字');
  assert.ok(!channels.get(PAST)); assert.match(since(m)[0], new RegExp('^openTerminal .*--resume.*' + PAST + '|^openTerminal .*' + PAST));
});

test('terminal sessions: focus, keep, end, take over', WIN_ONLY, async () => {
  // the keeper learns of them by looking, as the board does every few seconds
  const look = async () => keeper.observe((await get('/api/sessions')).json.sessions.filter((s) => s.owner === 'terminal').map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, pid: s.pid })));
  await look();
  const n = did.length;
  assert.strictEqual((await post('/api/focus', { sessionId: T1 })).json.state, 'hit');
  assert.strictEqual((await post('/api/focus', { sessionId: uuid(99) })).status, 404);
  assert.deepStrictEqual(since(n), ['focusWindow focus']);

  assert.strictEqual((await post('/api/keep/set', { sessionId: uuid(99), keep: false })).status, 404);
  assert.strictEqual((await post('/api/keep/set', { sessionId: T1, keep: false })).json.kept, false);
  assert.strictEqual((await post('/api/keep/set', { sessionId: T1, keep: true })).json.kept, true);
  const k = await get('/api/keep'); assert.strictEqual(k.status, 200); assert.ok(Array.isArray(k.json.restorable) && Array.isArray(k.json.closed));
  assert.strictEqual((await post('/api/keep/restore', { sessionIds: [] })).status, 400);
  assert.strictEqual((await post('/api/keep/forget', { sessionIds: [] })).status, 400);

  // end T1: its process (one of this test's own) is ended, then its window is closed
  assert.strictEqual((await post('/api/end', { sessionId: uuid(99) })).status, 404);
  assert.strictEqual((await post('/api/end', { sessionId: B })).status, 404, 'a board conversation is not ended this way');
  const pid1 = (await get('/api/sessions')).json.sessions.find((s) => s.sessionId === T1).pid;
  const m = did.length;
  const end = await post('/api/end', { sessionId: T1 }); assert.strictEqual(end.status, 200, end.text); assert.strictEqual(end.json.windowClosed, true);
  assert.deepStrictEqual(since(m), ['focusWindow find', 'kill ' + pid1, 'closeWindow 4242']);
  assert.strictEqual(S.pidAlive(pid1), false);
  await look();
  assert.ok((await get('/api/keep')).json.closed.some((x) => x.sessionId === T1), 'ended from the board: listed as closed, not brought back by itself');

  // bring it back: a terminal window is asked for (a stand-in), or forget it
  const r0 = did.length;
  const rs = await post('/api/keep/restore', { sessionIds: [T1, uuid(97)], to: 'terminal', continue: false }); assert.strictEqual(rs.status, 200, rs.text);
  assert.ok(since(r0).some((x) => x.startsWith('openTerminal') && x.includes(T1)), JSON.stringify(since(r0)));
  assert.ok(JSON.stringify(rs.json).includes(uuid(97)), 'the one it does not know is reported as failed');
  assert.strictEqual((await post('/api/keep/forget', { sessionIds: [T1] })).json.ok, true);

  // take T2 over: ended there, running here
  assert.strictEqual((await post('/api/takeover', { sessionId: uuid(99) })).status, 404);
  const pid2 = (await get('/api/sessions')).json.sessions.find((s) => s.sessionId === T2).pid;
  const t0 = did.length;
  const tk = await post('/api/takeover', { sessionId: T2 }); assert.strictEqual(tk.status, 200, tk.text); assert.strictEqual(tk.json.windowClosed, true);
  assert.deepStrictEqual(since(t0), ['focusWindow find', 'kill ' + pid2, 'closeWindow 4242']);
  assert.ok(channels.get(T2)); assert.strictEqual(S.pidAlive(pid2), false);
  assert.strictEqual((await get('/api/commands?sid=' + T2)).status, 200);
});

test('stopping the board: refused while something is working, done when asked with force', async () => {
  const s = await post('/api/new', { cwd: WORK }); await post('/api/send', { sessionId: s.json.sessionId, text: 'work' });
  assert.strictEqual((await post('/api/shutdown')).status, 409);
  assert.ok(!did.includes('exit 0'));
  assert.strictEqual((await post('/api/shutdown', { force: true })).status, 200);
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(did.includes('exit 0'));
});

test('辦公室房間：git、最近的測試、程式碼索引（qa-webwright、cbm-guard 的整合）', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-room-'));
  fs.mkdirSync(path.join(proj, 'tests', 'e2e', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'tests', 'e2e', 'reports', 'login-2026-11-17.xml'), '<?xml version="1.0"?><testsuites><testsuite name="pytest" errors="0" failures="2" skipped="1" tests="9" time="3" timestamp="2026-11-17T10:00:00+08:00"></testsuite></testsuites>');
  const fix = `"C:/x/codebase-memory-mcp.exe" cli --quiet index_repository '{"repo_path":"${proj.split(path.sep).join('/')}/web"}'`;
  const checks = [], rebuilt = [];
  const inst = () => ({ 'qa-webwright': { name: 'qa-webwright', installs: [{ scope: 'project', project: proj }] }, 'cbm-guard': { name: 'cbm-guard', installs: [{ scope: 'project', project: proj }] } });
  const p3 = await freePort();
  const s3 = createServer(TOKEN, p3, { channels, noTimers: true, noSchedules: true, out, pluginsInstalled: inst,
    cbmCheck: async (folder) => { checks.push(folder); return { ok: true, code: 1, repos: [{ repo: 'api', state: 'fresh' }, { repo: 'web', state: 'stale', hours: 12.5 }], fixes: [fix] }; },
    rebuildIndex: async (f) => { rebuilt.push(f); return { ok: true }; } });
  await new Promise((r) => s3.listen(p3, '127.0.0.1', r));
  const via = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q3 = http.request({ host: '127.0.0.1', port: p3, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); }); if (b) q3.write(b); q3.end(); });
  for (const r of ['GET /api/rooms', 'POST /api/rooms/reindex']) asked.add(r);
  const url = '/api/rooms?cwd=' + encodeURIComponent(proj);
  const first = (await via(url)).json.facts[proj];
  assert.deepStrictEqual([first.qa.name, first.qa.tests, first.qa.failed, first.qa.skipped, first.qa.source], ['login', 9, 2, 1, 'junit'], 'the newest JUnit report');
  assert.strictEqual(first.git, undefined, 'not a git repository: nothing said');
  assert.deepStrictEqual(first.cbm, { checking: true }, 'the index check runs in the background');
  for (let i = 0; i < 50 && !checks.length; i++) await sleep(20);
  await sleep(30);
  const second = (await via(url)).json.facts[proj];
  assert.deepStrictEqual(second.cbm.repos.map((x) => x.state), ['fresh', 'stale']);
  assert.strictEqual(checks.length, 1, 'checked once, then kept');
  assert.strictEqual((await via('/api/rooms/reindex', { cwd: proj, repo: 'nope' })).status, 404, 'only a repository the check said is stale');
  // the automation's switches (lib/auto.js); the timers are not running in tests
  for (const r of ['GET /api/auto', 'POST /api/auto']) asked.add(r);
  assert.deepStrictEqual((await via('/api/auto')).json.settings, { cbm: true, update: false, updateAt: '09:00', harness: false });
  assert.strictEqual((await via('/api/auto', { updateAt: '9am' })).status, 400);
  assert.deepStrictEqual((await via('/api/auto', { harness: true, updateAt: '07:30' })).json.settings, { cbm: true, update: false, updateAt: '07:30', harness: true });
  await via('/api/auto', { harness: false, updateAt: '09:00' });
  assert.deepStrictEqual((await via('/api/rooms/reindex', { cwd: proj, repo: 'web' })).json, { ok: true });
  assert.deepStrictEqual(rebuilt, [fix], 'the command cbm-guard printed, nothing else');
  // the real command form is the only one accepted by the rebuild itself
  const R = require('../lib/rooms');
  assert.deepStrictEqual(await R.rebuildIndex('rm -rf /'), { ok: false, error: '不是 cbm-guard 給的重建指令' });
  assert.deepStrictEqual(R.parseFreshness('  [新鮮] a   索引 x\n  [過期] b   索引 y  落後 HEAD 3.5 小時\n  [缺]   c   索引不存在\n', 1).repos, [{ repo: 'a', state: 'fresh' }, { repo: 'b', state: 'stale', hours: 3.5 }, { repo: 'c', state: 'missing', why: '索引不存在' }]);
  s3.close(); if (s3.closeAllConnections) s3.closeAllConnections();
  // the daily report switched on for a project deliver-report is installed for: who it goes to, approval required, no schedule
  const p4 = await freePort();
  const s4 = createServer(TOKEN, p4, { channels, noTimers: true, noSchedules: true, out, pluginsInstalled: () => ({ 'deliver-report': { name: 'deliver-report', installs: [{ scope: 'project', project: proj }] } }) });
  await new Promise((r) => s4.listen(p4, '127.0.0.1', r));
  const via4 = (pp, body) => new Promise((resolve) => { const b = Buffer.from(JSON.stringify(body)); const q4 = http.request({ host: '127.0.0.1', port: p4, path: pp, method: 'POST', headers: { 'x-board-token': TOKEN, 'content-type': 'application/json', 'content-length': b.length } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); }); q4.write(b); q4.end(); });
  asked.add('POST /api/daily/enable');
  assert.strictEqual((await via4('/api/daily/enable', { project: proj, recipients: ['not-an-email'] })).status, 400);
  assert.strictEqual((await via4('/api/daily/enable', { project: proj, recipients: 'a@b.co' })).status, 400, 'not a list: a plain 400, not a 500');
  assert.strictEqual((await via4('/api/daily/enable', { project: path.join(proj, 'other'), recipients: ['a@b.co'] })).status, 404, 'only a project that has deliver-report');
  const en = await via4('/api/daily/enable', { project: proj, recipients: ['boss@example.com'], cc: [] });
  assert.strictEqual(en.status, 200);
  const cfgFile = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'daily-report.json'), 'utf8'));
  assert.deepStrictEqual([cfgFile.recipients, cfgFile.require_approval, cfgFile.schedule.enabled], [['boss@example.com'], true, false]);
  assert.strictEqual((await via4('/api/daily/enable', { project: proj, recipients: ['x@y.co'] })).status, 404, 'already on: never overwritten');
  s4.close(); if (s4.closeAllConnections) s4.closeAllConnections();
  fs.rmSync(proj, { recursive: true, force: true });
});

test('collaborations: started (ledger, names, bypass, briefs), read back, a decision passed on, ended', async () => {
  for (const r of ['GET /api/collabs', 'GET /api/collab', 'POST /api/collab/create', 'POST /api/collab/decide', 'POST /api/collab/end']) asked.add(r);
  const B = (await post('/api/new', { cwd: WORK })).json.sessionId;
  const TT = uuid(77); terminalSession(TT); await new Promise((r) => setTimeout(r, 1100));   // a terminal session of its own (the earlier tests end theirs)
  // what is refused
  assert.strictEqual((await post('/api/collab/create', { goal: '', members: [{ sessionId: B }, { sessionId: TT }] })).status, 400, 'a goal');
  assert.strictEqual((await post('/api/collab/create', { goal: 'x', members: [{ sessionId: B }] })).status, 400, 'two members at least');
  assert.strictEqual((await post('/api/collab/create', { goal: 'x', members: [{ sessionId: B }, { sessionId: uuid(99) }] })).status, 404, 'a session that is not there');
  assert.strictEqual((await post('/api/collab/create', { goal: 'x', folder: HOME, members: [{ sessionId: B }, { sessionId: TT }] })).status, 400, 'the ledger only in a member\'s folder');
  const n0 = procs.length;
  const r = await post('/api/collab/create', { goal: '對齊增量同步規格', members: [{ sessionId: B, role: 'ALPHA', does: '推送端' }, { sessionId: TT, role: 'BETA', does: '接收端' }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const id = r.json.id, ledger = r.json.ledger;
  assert.strictEqual(ledger, path.join(WORK, '.claude', 'collab', id + '.md'));
  const text = fs.readFileSync(ledger, 'utf8');
  for (const want of ['## 目標', '對齊增量同步規格', '## 成員與分工', '合作' + id + '-ALPHA', '合作' + id + '-BETA', '| 介面 | 提供方 | 版本／最後改動 | ALPHA | BETA |', '## 承諾清單', '## 待你裁定', '## 使用者裁定', '## 合作規則']) assert.ok(text.includes(want), 'ledger has ' + want);
  const byRole = Object.fromEntries(r.json.results.map((x) => [x.role, x]));
  assert.deepStrictEqual([byRole.ALPHA.rename, byRole.ALPHA.brief, byRole.BETA.rename], ['sent', 'sent', 'by-you'], JSON.stringify(r.json.results));
  assert.ok(['now', 'after-turn'].includes(byRole.ALPHA.bypass));
  // the board conversation: started without approvals, told its name and the brief
  assert.strictEqual(channels.get(B).skipPermissions, true);
  const started = procs.slice(n0).find((x) => x.args.includes('--dangerously-skip-permissions'));
  assert.ok(started, 'its process runs in bypass');
  const said = started.p.stdin.written.map((w) => JSON.stringify(w)).join('\n');
  assert.ok(said.includes('/rename 合作' + id + '-ALPHA'), 'renamed');
  assert.ok(said.includes('【合作 #' + id + '】') && said.includes('合作' + id + '-BETA') && said.includes(ledger.replace(/\\/g, '\\\\')), 'brief: the other member by name, and the ledger');
  // the list and one in full
  const l = (await get('/api/collabs')).json;
  assert.ok(l.collabs.some((c) => c.id === id && c.state === 'active' && c.members.length === 2));
  const d = (await get('/api/collab?id=' + id)).json;
  assert.deepStrictEqual([d.goal, d.ledgerMissing, d.members.map((m) => m.role)], ['對齊增量同步規格', false, ['ALPHA', 'BETA']]);
  assert.deepStrictEqual(d.renameCommands.map((x) => x.command), ['/rename 合作' + id + '-BETA'], 'the terminal session: the line to paste');
  assert.strictEqual((await get('/api/collab?id=999')).status, 404);
  // a member of a collaboration under way is not edited and sent again (a new conversation would drop out of it)
  const rwc = await post('/api/rewind', { sessionId: B, at: uuid(1), text: 'x' });
  assert.deepStrictEqual([rwc.status, /合作/.test(rwc.json.error)], [409, true]);
  // the terminal member's name changes (its process restarted): the ledger's members section and the others told
  const regFile = fs.readdirSync(path.join(CLAUDE, 'sessions')).map((n) => path.join(CLAUDE, 'sessions', n)).find((x) => { try { return JSON.parse(fs.readFileSync(x, 'utf8')).sessionId === TT; } catch (e) { return false; } });
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8')); const firstName = reg.name;
  await get('/api/sessions'); await new Promise((r) => setTimeout(r, 1100)); await get('/api/sessions');   // seen once under its first name: nobody told
  const toldBefore = started.p.stdin.written.map((w) => JSON.stringify(w)).filter((s) => s.includes('現在叫')).length;
  reg.name = 'project-b-zz'; fs.writeFileSync(regFile, JSON.stringify(reg));
  await new Promise((r) => setTimeout(r, 1100)); await get('/api/sessions'); await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.readFileSync(ledger, 'utf8').includes('`project-b-zz`（預定 `合作' + id + '-BETA`）'), 'the ledger has the new name');
  const toldNow = started.p.stdin.written.map((w) => JSON.stringify(w)).filter((s) => s.includes('現在叫 project-b-zz') && s.includes(firstName));
  assert.deepStrictEqual([toldBefore, toldNow.length], [0, 1], 'the board member told once, with the old and new name');
  reg.name = firstName; fs.writeFileSync(regFile, JSON.stringify(reg));
  // a question in the ledger, answered: written word for word and sent to every member
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace('## 待你裁定\n', '## 待你裁定\n\n- [ ] 髒資料誰處理？\n'));
  assert.deepStrictEqual((await get('/api/collab?id=' + id)).json.open.pending, [{ done: false, question: '髒資料誰處理？' }]);
  assert.strictEqual((await post('/api/collab/decide', { id, question: '沒有這題', answer: 'x' })).status, 404);
  const dec = await post('/api/collab/decide', { id, question: '髒資料誰處理？', answer: '視為業務端的髒資料，人工處理' });
  assert.strictEqual(dec.status, 200, JSON.stringify(dec.json));
  const after = fs.readFileSync(ledger, 'utf8');
  assert.ok(after.includes('- [x] 髒資料誰處理？') && after.includes('使用者原話：視為業務端的髒資料，人工處理'));
  assert.ok(started.p.stdin.written.map((w) => JSON.stringify(w)).join('\n').includes('視為業務端的髒資料，人工處理'), 'passed on to the board conversation');
  assert.strictEqual((await post('/api/collab/decide', { id, question: '髒資料誰處理？', answer: 'again' })).status, 404, 'decided once');
  // ended: kept, marked; no more decisions
  assert.strictEqual((await post('/api/collab/end', { id })).status, 200);
  assert.strictEqual((await get('/api/collab?id=' + id)).json.state, 'ended');
  assert.strictEqual((await post('/api/collab/decide', { id, question: 'x', answer: 'y' })).status, 409);
  assert.strictEqual((await post('/api/collab/end', { id: 999 })).status, 404);
  assert.strictEqual((await post('/api/collab/create', { goal: 'again', members: [{ sessionId: B, role: 'ALPHA' }, { sessionId: TT, role: 'BETA' }] })).json.id, id + 1, 'numbered on');
  // a ledger left from an earlier database where the next one would go: skipped, not overwritten and not refused
  const leftOver = path.join(WORK, '.claude', 'collab', (id + 2) + '.md'); fs.writeFileSync(leftOver, '舊的帳本');
  const skip = await post('/api/collab/create', { goal: 'third', members: [{ sessionId: B, role: 'ALPHA' }, { sessionId: TT, role: 'BETA' }] });
  assert.deepStrictEqual([skip.status, skip.json.id, fs.readFileSync(leftOver, 'utf8')], [200, id + 3, '舊的帳本']);
  // a member whose permission mode cannot be read (a terminal session that has not written it yet): not taken as agreeing
  const d3 = (await get('/api/collab?id=' + skip.json.id)).json;
  const beta = d3.members.find((m) => m.role === 'BETA');
  if (!beta.mode) assert.deepStrictEqual([d3.modesAgree, d3.modesUnknown], [false, ['BETA']], 'unknown is not agreeing');
  // a board conversation that is busy when it joins: its name and brief wait until it is idle (its process is restarted
  // for the new mode after the turn - what is written in the middle of it could go with it)
  const C2 = (await post('/api/new', { cwd: WORK })).json.sessionId;
  await post('/api/send', { sessionId: C2, text: 'busy' });
  const ch2 = channels.get(C2); ch2.state = 'busy';
  const busy = await post('/api/collab/create', { goal: 'fourth', members: [{ sessionId: C2, role: 'GAMMA' }, { sessionId: TT, role: 'BETA' }] });
  const g = busy.json.results.find((x) => x.role === 'GAMMA');
  assert.deepStrictEqual([g.rename, g.brief], ['after-turn', 'after-turn'], JSON.stringify(busy.json.results));
  const written = () => procs.filter((x) => x.args.includes(C2) || (x.p.stdin.written || []).some((w) => JSON.stringify(w).includes('busy'))).flatMap((x) => x.p.stdin.written).map((w) => JSON.stringify(w)).join('\n');
  assert.ok(!written().includes('/rename 合作' + busy.json.id + '-GAMMA'), 'not sent while it is busy');
  ch2.state = 'idle'; await get('/api/sessions'); await new Promise((r) => setTimeout(r, 1100)); await get('/api/sessions'); await new Promise((r) => setTimeout(r, 300));
  assert.ok(written().includes('/rename 合作' + busy.json.id + '-GAMMA') && written().includes('【合作 #' + busy.json.id + '】'), 'sent once it is idle');
  const left = (await get('/api/collab?id=' + busy.json.id)).json.members.find((m) => m.role === 'GAMMA');
  assert.ok(!left.pending, 'and not again');
});

test('the mic: what was heard is tidied as it comes; through tailscale serve the device behind it is checked, Funnel never gets in', async () => {
  const seen = [], tidyCalls = [], tidyCtx = [];
  const tidy = {
    warm: () => tidyCalls.push('warm'),
    run: async (text, onDelta, context) => { tidyCalls.push(text); if (context) tidyCtx.push(context); if (text === 'bad') return { ok: false, error: '整理失敗' }; onDelta('我想'); onDelta('我想看。'); return { ok: true, text: '我想看。', ms: 900 }; },
  };
  const gate = { info: { ok: true, name: 'me.tail.ts.net' }, allows: async (a) => { seen.push(a); return a === '127.0.0.1' || a === '100.70.0.2'; }, refresh: async () => {} };
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, out, gate, tidy, servedUrl: async () => 'https://me.tail.ts.net/' });
  await new Promise((r) => s2.listen(p2, '127.0.0.1', r));
  const raw = (pp, body, headers = {}) => new Promise((resolve) => {
    const b = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const q2 = http.request({ host: '127.0.0.1', port: p2, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json', 'content-length': b.length } : {}, headers) }, (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d })); });
    q2.on('error', (e) => resolve({ status: e.code })); if (b) q2.write(b); q2.end();
  });
  asked.add('POST /api/tidy/warm'); asked.add('POST /api/tidy');
  assert.strictEqual((await raw('/api/tidy/warm', {})).status, 200);
  const t = await raw('/api/tidy', { text: '呃 我想 看' });
  assert.deepStrictEqual(t.text.trim().split('\n').map((l) => JSON.parse(l)), [{ d: '我想' }, { d: '我想看。' }, { done: true, text: '我想看。', ms: 900 }], 'the words as they come, then the whole');
  assert.deepStrictEqual(JSON.parse((await raw('/api/tidy', { text: 'bad' })).text.trim()), { error: '整理失敗' });
  assert.strictEqual((await raw('/api/tidy', { text: '  ' })).status, 400);
  assert.strictEqual((await raw('/api/tidy', { text: 'x'.repeat(4001) })).status, 400);
  assert.deepStrictEqual(tidyCalls, ['warm', '呃 我想 看', 'bad']);
  // the conversation it was said in, passed on - bounded
  await raw('/api/tidy', { text: '哥特', context: { title: 't'.repeat(300), folder: 'repo', recent: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'x'.repeat(900)] } });
  assert.deepStrictEqual([tidyCtx[0].title.length, tidyCtx[0].folder, tidyCtx[0].recent.length, tidyCtx[0].recent[5].length], [200, 'repo', 6, 600]);
  // through tailscale serve: from 127.0.0.1, the device in x-forwarded-for - that device is what the gate is asked about
  const serveH = (ip) => ({ host: 'me.tail.ts.net', 'x-forwarded-for': ip, 'tailscale-user-login': 'me@x' });
  const cfg = require('../lib/config'); const was = cfg.value('remoteTailscale', false);
  cfg.setValue('remoteTailscale', false); seen.length = 0;
  assert.strictEqual((await raw('/api/ping', undefined, serveH('100.70.0.2'))).status, 403, 'switched off: not even your phone, though serve is still set up');
  assert.deepStrictEqual(seen, [], 'refused before the device is asked about');
  cfg.setValue('remoteTailscale', true);
  assert.strictEqual((await raw('/api/ping', undefined, serveH('100.70.0.2'))).status, 200, 'your phone through https');
  assert.strictEqual((await raw('/api/ping', undefined, serveH('100.70.0.3'))).status, 403, 'a device not yours');
  assert.deepStrictEqual(seen, ['100.70.0.2', '100.70.0.3']);
  assert.strictEqual((await raw('/api/ping', undefined, Object.assign(serveH('100.70.0.2'), { host: 'me.tail.ts.net:8444' }))).status, 200, 'served on another https port: the name with its port');
  assert.strictEqual((await raw('/api/ping', undefined, Object.assign(serveH('100.70.0.2'), { host: 'other.tail.ts.net:8444' }))).status, 403, 'another name with a port');
  seen.length = 0;
  assert.strictEqual((await raw('/api/ping', undefined, { host: 'other.tail.ts.net', 'x-forwarded-for': '100.70.0.2' })).status, 403, 'another name');
  assert.strictEqual((await raw('/api/ping', undefined, { host: 'me.tail.ts.net' })).status, 403, 'the https name without serve: not taken');
  // Funnel (the internet) is refused whatever else it carries
  assert.strictEqual((await raw('/api/ping', undefined, Object.assign(serveH('100.70.0.2'), { 'tailscale-funnel-request': '?1' }))).status, 403);
  // from the phone through https, what happens on this screen is refused
  const scr = await raw('/api/pick-folder', {}, serveH('100.70.0.2'));
  assert.strictEqual(scr.status, 403, scr.text);
  assert.strictEqual(JSON.parse((await raw('/api/config')).text).httpsUrl, 'https://me.tail.ts.net/', 'switched on: the https address for the phone');
  cfg.setValue('remoteTailscale', false);
  // and the settings name the https address for the phone
  assert.strictEqual(JSON.parse((await raw('/api/config')).text).httpsUrl, '', 'only while reaching it through Tailscale is on');
  cfg.setValue('remoteTailscale', was);
  s2.close();
});

test('「重啟更新」 restart: only onto a newer version, never under a working conversation, by a detached helper that outlives the board', async () => {
  const VERSION = require('../.claude-plugin/plugin.json').version;
  const spawned = [], exited = []; let shut = 0, busy = [];
  const ch = Object.create(channels); ch.active = () => busy; ch.shutdown = () => { shut++; };
  const newer = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-newer-')); fs.mkdirSync(path.join(newer, '.claude-plugin')); fs.writeFileSync(path.join(newer, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '99.0.0' }));
  const mk = async (boardRoot) => {
    const o = Object.assign({}, out, { spawn: (bin, args, opts) => { spawned.push({ bin, args, opts }); const e = new (require('events'))(); e.unref = () => {}; return e; }, exit: (c) => exited.push(c) });
    const pp = await freePort(); const s = createServer(TOKEN, pp, { channels: ch, noTimers: true, noSchedules: true, out: o, boardRoot });
    await new Promise((r) => s.listen(pp, '127.0.0.1', r));
    const call = (body) => new Promise((resolve) => { const b = Buffer.from(JSON.stringify(body)); const q = http.request({ host: '127.0.0.1', port: pp, path: '/api/restart', method: 'POST', headers: { 'x-board-token': TOKEN, 'content-type': 'application/json', 'content-length': b.length } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); }); q.end(b); });
    return { s, call };
  };
  asked.add('POST /api/restart');
  // the same version installed: nothing restarted
  const a = await mk(path.join(__dirname, '..'));
  assert.deepStrictEqual((await a.call({ onlyIfNewer: true })).json, { ok: true, restarted: false, version: VERSION });
  a.s.close();
  // a newer one, but a conversation working: refused, and it is named
  const b = await mk(newer);
  busy = [{ sessionId: 'x', title: '還在跑的', status: 'busy', tasks: 0 }];
  const r1 = await b.call({ onlyIfNewer: true });
  assert.deepStrictEqual([r1.status, r1.json.active[0].title, r1.json.newest], [409, '還在跑的', '99.0.0']);
  assert.deepStrictEqual([spawned.length, shut, exited.length], [0, 0, 0], 'nothing started or stopped');
  // nothing working: the helper is started detached from the newer folder, told to wait for this process, then the board ends
  busy = [];
  const r2 = await b.call({ onlyIfNewer: true });
  assert.deepStrictEqual(r2.json, { ok: true, restarted: true, from: VERSION, to: '99.0.0' });
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].args[0], path.join(newer, 'scripts', 'start.js'));
  assert.deepStrictEqual(spawned[0].args.slice(1, 3), ['--after', String(process.pid)]);
  assert.ok(spawned[0].opts.detached === true && spawned[0].opts.stdio === 'ignore', 'detached: it outlives the board');
  const MARK = require('../lib/keepalive').RESTARTING;
  assert.ok(fs.existsSync(MARK), 'marked restarting: the keep-alive task does not start the old one in between (for a while only)');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepStrictEqual([shut, exited], [1, [0]], 'then the board ends');
  // a conversation that began working in the moment before it ends: called off, the mark taken away
  const r3 = await b.call({ onlyIfNewer: true });
  assert.strictEqual(r3.json.restarted, true);
  busy = [{ sessionId: 'y', title: '剛開始做', status: 'busy', tasks: 0 }];
  await new Promise((r) => setTimeout(r, 400));
  assert.deepStrictEqual([shut, exited.length, fs.existsSync(MARK)], [1, 1, false], 'not cut, not ended');
  busy = [];
  b.s.close();
  // an older board installed than the one running: never gone back to (its start.js would not know --after)
  const older = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-older-')); fs.mkdirSync(path.join(older, '.claude-plugin')); fs.writeFileSync(path.join(older, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.0.1' }));
  const c = await mk(older);
  assert.deepStrictEqual((await c.call({ onlyIfNewer: true })).json, { ok: true, restarted: false, version: VERSION });
  const r4 = await c.call({});
  assert.deepStrictEqual([r4.status, r4.json.newest], [409, '0.0.1']);
  assert.strictEqual(spawned.length, 2, 'nothing more started');
  // a check made while another board version was running: not shown, asked again
  const cfg = require('../lib/config');
  cfg.setValue('autoState', { check: { day: '2026-11-20', at: 1, ok: true, behind: [{ name: 'x' }], board: { running: '0.0.1', newest: '0.0.2' }, need: true } });
  const au = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: c.s.address().port, path: '/api/auto', headers: { 'x-board-token': TOKEN } }, (res) => { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => resolve(JSON.parse(d))); }));
  assert.strictEqual(au.check, null, 'not shown');
  assert.ok((cfg.value('autoState', {}) || {}).check, 'a read changes nothing (the next round asks again: lib/auto.js)');
  c.s.close();
});

test('no address is left without a test', WIN_ONLY, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').split('\n');
  const postFrom = src.findIndex((l) => l.includes("if (req.method !== 'POST') return send(res, 405"));
  assert.ok(postFrom > 0);
  const routes = new Set();
  src.forEach((l, i) => { for (const m of l.matchAll(/p === '(\/api\/[^']+)'/g)) routes.add((i > postFrom ? 'POST ' : 'GET ') + m[1]); });
  routes.delete('POST /api/send'); routes.add('POST /api/send');
  // /api/stream is named twice in the GET part (once to take the key from the address) and /api/send once above the POST check (its size limit)
  const missing = [...routes].filter((r) => !asked.has(r) && !(r === 'GET /api/send'));
  assert.ok(routes.size >= 60, 'the list was read: ' + routes.size);
  assert.deepStrictEqual(missing, [], 'addresses in server.js that this file never asked for');
});
