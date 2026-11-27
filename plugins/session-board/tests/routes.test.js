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
let lineOn = false; const pushed = [];              // LINE: connected or not, what was pushed
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
  procTable: async () => { did.push('procTable'); return [{ pid: 7, ppid: 1, name: 'chrome.exe', mem: 5, cpu: 2, at: 1 }, { pid: 8, ppid: 1, name: 'x.exe', mem: 9, cpu: 1, at: 1 }]; },
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
// a schedule said in words (lib/ruleparse.js) without Claude, and no calendar fetched from the net
const ruleAsked = [];
const ruleAsk = async (text) => { ruleAsked.push(text); return /看不懂/.test(text) ? { ok: false, error: '看不懂這句排程：不是時間' } : { ok: true, rule: { cron: '0 15 LW * *', workday: undefined, explain: '每月最後一個工作天 15:00' } }; };
const calFetch = async () => ({ ok: false, status: 503 });
let quotaAsks = 0;   // times the 額度 card's ↻ reached cc-statusline (deps.refreshQuota)
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
  server = createServer(TOKEN, port, { refreshQuota: async () => { quotaAsks++; return { ok: true, asked: quotaAsks === 1, at: 1795803261984, tried: 1795803259666 }; }, recFetch: async () => ({ ok: false, status: 404 }), recAsk: async () => ({ ok: false }), drawLook: async () => ({ ok: true, text: '橘色', turns: 2, tokens: 5 }), drawAsk: async () => ({ ok: true, tokens: 9, text: [1, 2].map((r) => '<svg viewBox="0 0 96 96"><circle cx="48" cy="48" r="' + r + '" fill="#f90"/></svg>').join('') }), lineConnected: () => lineOn, linePush: async (t) => { pushed.push(t); return pushed.length > 1 ? { ok: false, error: 'LINE 沒有收下（429）' } : { ok: true }; }, digestAsk: async () => ({ ok: true, text: '{"items":[]}' }), channels, keeper, inbox, monthly, ruleAsk, calFetch, pluginsInstalled: () => ({ harness: { name: 'harness', installs: [{ scope: 'user', project: '' }] }, goal2: { name: 'goal2', installs: [] } }), goal2: new (require('../lib/goal2').Goal2)({ root: null }), remoteInfo: async () => ({ ok: false, why: 'test' }), noTimers: true, out, tell: (t, x) => did.push('tell ' + t), peer: async () => ({ ok: true }), peerCheck: async () => true });
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

test('what you said last, after a long turn: never how the conversation began, and the same message the time is of (2026-11-23)', async () => {
  const Past = require('../lib/past');
  const f = path.join(HOME, 'long-turn.jsonl');
  const u = (text, at) => line({ type: 'user', sessionId: 'x', cwd: WORK, timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } });
  const noise = line({ type: 'assistant', sessionId: 'x', message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(4000) }] } });
  const much = new Array(400).fill(noise).join('\n');   // 1.6 MB: more than the end that is looked at
  fs.writeFileSync(f, [u('最開頭那句', 1000000), much, u('跑', 2000000), much, u('<task-notification>不是你說的</task-notification>', 3000000)].join('\n') + '\n');
  assert.deepStrictEqual([Past.lastSaid(f), Past.saidAtOf(f), Past.ends(f).last, Past.ends(f).lastAt, Past.ends(f).first], ['跑', 2000000, '跑', 2000000, '最開頭那句']);
  // what is added later is read forward, words and time together
  fs.appendFileSync(f, u('再說一句', 4000000) + '\n' + much + '\n');
  assert.deepStrictEqual([Past.lastSaid(f), Past.saidAtOf(f), Past.ends(f).last], ['再說一句', 4000000, '再說一句']);
  // the board's words in your place: shown as the latest (the page says 看板：), the time stays yours
  fs.appendFileSync(f, u('（看板自動送出）接著做', 5000000) + '\n');
  assert.deepStrictEqual([Past.lastSaid(f), Past.saidAtOf(f)], ['（看板自動送出）接著做', 4000000]);
  // read from the start by another file: the same answer
  const g = path.join(HOME, 'long-turn2.jsonl'); fs.copyFileSync(f, g);
  assert.deepStrictEqual([Past.lastSaid(g), Past.saidAtOf(g)], ['（看板自動送出）接著做', 4000000]);
  // a picture with no words: yours, said so
  fs.appendFileSync(g, line({ type: 'user', timestamp: new Date(6000000).toISOString(), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } }) + '\n');
  assert.deepStrictEqual([Past.lastSaid(g), Past.saidAtOf(g)], ['（圖片）', 6000000]);
  assert.strictEqual(Past.lastSaid(path.join(HOME, 'no-such.jsonl')), '');
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
  // what its replies handed you: the files that are there and the links, once each, newest first - not its own folder,
  // not a path that is not there, not what only a subagent or a tool output named
  {
    const tr = S.findTranscript(T1, WORK, path.join(CLAUDE, 'projects')); const before = fs.readFileSync(tr);
    const say = (text, at) => line({ type: 'assistant', sessionId: T1, cwd: WORK, timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
    fs.appendFileSync(tr, [
      say('改好了：`a.docx`，看 ' + WORK + '\\ 裡面。參考 https://example.com/spec.', Date.now() - 5000),
      say('還有 `note.md` 和 `missing.txt`：\n```\n' + path.join(WORK, 'a.docx') + '\n```\n詳見 https://example.com/b', Date.now() - 1000),
      line({ type: 'user', sessionId: T1, timestamp: new Date().toISOString(), toolUseResult: { stdout: 'x' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: '`run.ps1` https://example.com/tool' }] } }),
    ].join('\n') + '\n');
    try {
      const g = await get('/api/changes?sid=' + T1); assert.strictEqual(g.status, 200, g.text);
      assert.deepStrictEqual(g.json.given.map((x) => path.basename(x.abs)), ['note.md', 'a.docx'], 'newest reply first (in it, in the order written), once each');
      assert.deepStrictEqual(g.json.links.map((x) => x.url), ['https://example.com/b', 'https://example.com/spec']);
      assert.strictEqual(g.json.linksTotal, 2, 'how many there are, the list being cut at 50');
      // where each was last named: the reply as the conversation shows it (its uuid and the block's place), to jump to
      const h = await get('/api/messages?sid=' + T1 + '&max=50'); assert.strictEqual(h.status, 200, h.text);
      const ids = new Set((h.json.items || h.json.messages || []).filter((x) => x.role === 'assistant').map((x) => x.id));
      assert.ok(ids.size >= 2, 'the replies are in what the page is given: ' + Object.keys(h.json));
      for (const x of g.json.given.concat(g.json.links)) assert.ok(x.ref || x.id, 'has where it was named');
      for (const r of g.json.given.map((x) => x.ref).concat(g.json.links.map((x) => x.id))) assert.ok(ids.has(r), r + ' is a reply the conversation shows');
    } finally { fs.writeFileSync(tr, before); }
  }
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

test('a plugin shows where it is installed: no switch of its own, a room by its folder', async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-other-'));
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, out, pluginsInstalled: () => ({ harness: { name: 'harness', installs: [{ scope: 'project', project: other }] } }), goal2: new (require('../lib/goal2').Goal2)({ root: null }) });
  await new Promise((r) => s2.listen(p2, '127.0.0.1', r));
  const via = (pp) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: p2, path: pp, headers: { 'x-board-token': TOKEN } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }));
  fs.mkdirSync(path.join(WORK, '.claude', 'harness'), { recursive: true }); fs.writeFileSync(path.join(WORK, '.claude', 'harness', 'README.md'), '# harness');   // its files are here: only the install decides
  try {
    const s = await via('/api/sessions');
    assert.deepStrictEqual([s.features.integrations.goal2, s.features.integrations.harness], [false, true], 'goal2 not installed: not there; harness installed somewhere: there');
    assert.deepStrictEqual((await via('/api/harness?cwd=' + enc(WORK))).states[WORK], { installed: false }, 'harness is installed for another folder only: this room has no harness line');
  } finally { fs.rmSync(path.join(WORK, '.claude', 'harness'), { recursive: true, force: true }); s2.close(); if (s2.closeAllConnections) s2.closeAllConnections(); }
});

test('外掛分析: analysed in the background, kept in a file, only its own answers installed (lib/pluginfit.js)', async () => {
  for (const x of ['GET /api/pluginfit', 'POST /api/pluginfit/analyze', 'POST /api/pluginfit/apply']) asked.add(x);
  let release; const gate = new Promise((r) => { release = r; });
  let slowGo; const slowGate = new Promise((r) => { slowGo = r; });
  const installed = [], file = path.join(HOME, 'pluginfit.json');
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, pluginfitFile: file,
    out: Object.assign({}, out, { pluginInstall: async (cwd, items) => { installed.push([cwd, items.map((x) => x.ref)]); return items.map((x) => ({ ref: x.ref, ok: x.ref !== 'codex@openai-codex', note: x.ref === 'codex@openai-codex' ? 'failed' : '' })); } }),
    pluginfitAsk: async (cwd, st, question) => { if (question === '慢慢回答') { await slowGate; return { ok: true, answer: '慢的回答' }; } return { ok: true, answer: '好', result: Object.assign({}, st.result, { plugins: st.result.plugins.filter((x) => x.ref === 'harness@fulin-plugins') }) }; },
    pluginfitAnalyze: async () => { await gate; return { ok: true, result: { confident: true, profile: null, summary: 's', plugins: [{ ref: 'harness@fulin-plugins', from: 'x', note: '' }, { ref: 'codex@openai-codex', from: 'y', note: '', source: 'openai/codex-plugin-cc' }], skip: [] }, cost: 0.1 }; } });
  await new Promise((r) => s2.listen(p2, '127.0.0.1', r));
  const call = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q = http.request({ host: '127.0.0.1', port: p2, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); }); if (b) q.write(b); q.end(); });
  const st = async () => (await call('/api/pluginfit?cwd=' + enc(WORK))).json;
  try {
    const z = await st(); assert.deepStrictEqual([z.state, z.canRun], ['none', true], 'plugin-manager beside this plugin: it can run');
    assert.strictEqual((await call('/api/pluginfit/analyze', { cwd: path.join(WORK, 'nope') })).status, 400, 'not a folder the board knows');
    assert.strictEqual((await call('/api/pluginfit/apply', { cwd: WORK, refs: ['harness@fulin-plugins'] })).status, 409, 'nothing analysed yet: nothing installed');
    assert.strictEqual((await call('/api/pluginfit/analyze', { cwd: WORK })).status, 202);
    assert.strictEqual((await st()).state, 'running');
    assert.strictEqual((await call('/api/pluginfit/analyze', { cwd: WORK })).status, 409, 'one at a time per folder');
    release(); await new Promise((r) => setTimeout(r, 50));
    const done = await st(); assert.deepStrictEqual([done.state, done.result.plugins.length], ['done', 2]);
    assert.strictEqual(Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))[0].state, 'done', 'kept in a file');
    const a = await call('/api/pluginfit/apply', { cwd: WORK, refs: ['harness@fulin-plugins', 'codex@openai-codex', 'evil@made-up'] });
    assert.deepStrictEqual([a.status, a.json.results.map((x) => x.ok)], [200, [true, false]]);
    assert.deepStrictEqual(installed, [[WORK, ['harness@fulin-plugins', 'codex@openai-codex']]], 'only what the analysis gave');
    const after = await st(); assert.deepStrictEqual([after.applied['harness@fulin-plugins'].ok, after.applied['codex@openai-codex'].note], [true, 'failed']);
    assert.strictEqual((await call('/api/pluginfit/apply', { cwd: WORK, refs: ['evil@made-up'] })).status, 400);
    // a question: kept with the analysis; one that changes the list changes what may be installed
    asked.add('POST /api/pluginfit/ask');
    assert.strictEqual((await call('/api/pluginfit/ask', { cwd: WORK, question: '' })).status, 400);
    const q1 = await call('/api/pluginfit/ask', { cwd: WORK, question: '只留 harness' });
    assert.deepStrictEqual([q1.status, q1.json.changed], [200, true]);
    const t = await st(); assert.deepStrictEqual([t.thread.map((x) => [x.q, x.changed]), t.result.plugins.map((x) => x.ref)], [[['只留 harness', true]], ['harness@fulin-plugins']]);
    assert.strictEqual((await call('/api/pluginfit/apply', { cwd: WORK, refs: ['codex@openai-codex'] })).status, 400, 'taken off the list by the answer: no longer installed from it');
    // a question still being answered while an install finishes: both kept (review 2026-11-21: the later one overwrote the other)
    const slow = call('/api/pluginfit/ask', { cwd: WORK, question: '慢慢回答' });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual((await call('/api/pluginfit/apply', { cwd: WORK, refs: ['harness@fulin-plugins'] })).status, 200);
    slowGo(); assert.strictEqual((await slow).status, 200, 'not told the analysis was redone: it was not');
    const both = await st(); assert.deepStrictEqual([both.thread.map((x) => x.q), !!both.applied['harness@fulin-plugins']], [['只留 harness', '慢慢回答'], true]);
  } finally { s2.close(); if (s2.closeAllConnections) s2.closeAllConnections(); }
  // a board started again finds the answer there
  const p3 = await freePort(); const s3 = createServer(TOKEN, p3, { channels, noTimers: true, noSchedules: true, out, pluginfitFile: file });
  await new Promise((r) => s3.listen(p3, '127.0.0.1', r));
  const again = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: p3, path: '/api/pluginfit?cwd=' + enc(WORK), headers: { 'x-board-token': TOKEN } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }));
  assert.strictEqual(again.state, 'done'); s3.close(); if (s3.closeAllConnections) s3.closeAllConnections();
});

test('CLAUDE.md 面板: the files listed and checked, an evaluation, a tweak applied, taken back, and a stale one refused (lib/claudemd.js)', async () => {
  for (const x of ['GET /api/claudemd', 'POST /api/claudemd/evaluate', 'POST /api/claudemd/ask', 'POST /api/claudemd/tweak', 'POST /api/claudemd/apply', 'POST /api/claudemd/discard', 'POST /api/claudemd/undo']) asked.add(x);
  const G = path.join(CLAUDE, 'CLAUDE.md'), P = path.join(WORK, 'CLAUDE.md');
  fs.writeFileSync(G, '# 全域\n\n- 一律用繁體中文回覆\n');
  fs.writeFileSync(P, '# 專案\n\n看 `nope/gone.md`。\n\n@missing.md\n\napi_key = abcdefgh12345678\n\n## 規則\n\n- 先跑測試\n');
  const prompts = []; let evalGo; const evalGate = new Promise((r) => { evalGo = r; });
  const explain = async (cwd, prompt) => {
    prompts.push([cwd, prompt]);
    if (prompt.includes('請做一次綜合評估') && prompt.includes('其他專案的 CLAUDE.md')) return { ok: true, answer: '這次沒有照格式回答 {不是 JSON' };
    if (prompt.includes('請做一次綜合評估')) { await evalGate; return { ok: true, answer: JSON.stringify({ summary: '大致清楚', items: [{ kind: 'vague', file: P, line: 3, text: '模糊', suggest: '寫具體' }, { kind: 'nonsense', file: 'C:/elsewhere/x.md', text: '別的檔' }] }) }; }
    if (prompt.includes('照使用者的一句指示')) return { ok: true, answer: JSON.stringify({ after: '## 規則\n\n- 先跑測試，全部通過才 commit', why: '更具體' }) };
    if (prompt.includes('改專案外的')) return { ok: true, answer: JSON.stringify({ answer: '改好了', edit: { file: path.join(HOME, 'outside.md'), before: '外面', after: '裡面' } }) };
    if (prompt.includes('不存在的原文')) return { ok: true, answer: JSON.stringify({ answer: '改好了', edit: { file: P, before: '沒有這一句', after: 'x' } }) };
    return { ok: true, answer: JSON.stringify({ answer: '可以這樣改', edit: { file: P, before: '- 先跑測試', after: '- 先跑測試再說' } }) };
  };
  const file = path.join(HOME, 'claudemd.json'), bak = path.join(HOME, 'claudemd-bak');
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, claudemdFile: file, claudemdBak: bak,
    out: Object.assign({}, out, { explain, gitRun: (cmd, args, opts, cb) => cb(null, args.includes('status') ? ' M CLAUDE.md\n' : '', '') }) });
  await new Promise((r) => s2.listen(p2, '127.0.0.1', r));
  const call = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q = http.request({ host: '127.0.0.1', port: p2, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); }); if (b) q.write(b); q.end(); });
  const view = async (w) => (await call('/api/claudemd?cwd=' + enc(w || ''))).json;
  try {
    // the office's 全域 one: only the files every folder loads
    const g = await view('');
    assert.deepStrictEqual([g.global, g.files.map((f) => [f.kind, f.abs])], [true, [['user', G]]]);
    assert.strictEqual((await call('/api/claudemd?cwd=' + enc(path.join(WORK, 'nope')))).status, 400, 'not a folder the board knows');
    // a folder: the 全域 one first, then the project's; each checked
    const v = await view(WORK), pf = v.files.find((f) => f.abs === P);
    assert.deepStrictEqual([v.files[0].kind, pf.kind, pf.git, pf.editable, pf.sections.map((s) => s.title)], ['user', 'project', 'modified', true, ['專案', '規則']]);
    const kinds = v.findings.filter((x) => x.id === pf.id).map((x) => x.kind).sort();
    assert.deepStrictEqual(kinds, ['import', 'path', 'secret']);
    assert.ok(!JSON.stringify(v.findings).includes('abcdefgh'), 'where a key is, never what it is');
    // the evaluation: in the background, one at a time, kept to the files that are there
    assert.strictEqual((await call('/api/claudemd/evaluate', { cwd: WORK })).status, 202);
    assert.strictEqual((await view(WORK)).eval.state, 'running');
    assert.strictEqual((await call('/api/claudemd/evaluate', { cwd: WORK })).status, 409);
    evalGo(); await new Promise((r) => setTimeout(r, 50));
    const e = (await view(WORK)).eval;
    assert.deepStrictEqual([e.state, e.result.items.map((x) => [x.kind, x.file])], ['done', [['vague', P], ['other', null]]]);
    // a tweak of a section: proposed, shown as a diff, written only with 套用 - backed up, and taken back
    assert.strictEqual((await call('/api/claudemd/tweak', { cwd: WORK, abs: P, section: 'all', instruction: '' })).status, 400);
    assert.strictEqual((await call('/api/claudemd/tweak', { cwd: WORK, abs: path.join(WORK, 'other.md'), section: 'all', instruction: 'x' })).status, 400, 'only a file of the set');
    const L9 = pf.text.replace(/\r\n/g, '\n').split('\n'), sec1 = pf.sections[1], orig = L9.slice(sec1.start, sec1.end).join('\n').replace(/\n+$/, ''), to = sec1.start + orig.split('\n').length;
    const t = await call('/api/claudemd/tweak', { cwd: WORK, abs: P, from: sec1.start, to, orig, picked: '先跑測試', instruction: '寫具體一點' });
    assert.ok(prompts[prompts.length - 1][1].includes('框選的字') && prompts[prompts.length - 1][1].includes('只改框選到的地方'), 'what was selected is told');
    assert.ok(t.json.edit, 'a change proposed');
    assert.strictEqual(fs.readFileSync(P, 'utf8').includes('全部通過'), false, 'nothing written yet');
    const pr = (await view(WORK)).proposals[t.json.edit];
    assert.ok(pr.hunks.some((h) => h.lines.includes('+- 先跑測試，全部通過才 commit')));
    assert.strictEqual(pr.hunks[0].oldStart, 9, 'the file\'s own line numbers (the section starts at line 9), not the section\'s');
    const before = fs.readFileSync(P, 'utf8');
    const ap = await call('/api/claudemd/apply', { cwd: WORK, id: t.json.edit });
    assert.deepStrictEqual([ap.status, fs.readFileSync(P, 'utf8').includes('- 先跑測試，全部通過才 commit'), fs.readFileSync(ap.json.backup, 'utf8')], [200, true, before]);
    assert.strictEqual((await call('/api/claudemd/apply', { cwd: WORK, id: t.json.edit })).status, 409, 'once');
    assert.ok((await view(WORK)).files.find((f) => f.abs === P).undoAt > 0);
    assert.strictEqual((await call('/api/claudemd/undo', { cwd: WORK, abs: P })).status, 200);
    assert.strictEqual(fs.readFileSync(P, 'utf8'), before, 'taken back');
    assert.strictEqual((await call('/api/claudemd/undo', { cwd: WORK, abs: P })).status, 409, 'nothing more to take back');
    // a question proposing a change; the file changed after it: refused
    assert.strictEqual((await call('/api/claudemd/ask', { cwd: WORK, question: '' })).status, 400);
    const q = await call('/api/claudemd/ask', { cwd: WORK, question: '改一下' });
    assert.ok(q.json.edit);
    fs.writeFileSync(P, fs.readFileSync(P, 'utf8') + '\n- 另外加的\n');
    assert.strictEqual((await view(WORK)).proposals[q.json.edit].stale, true);
    const stale = await call('/api/claudemd/apply', { cwd: WORK, id: q.json.edit });
    assert.strictEqual(stale.status, 409); assert.ok(!fs.readFileSync(P, 'utf8').includes('先跑測試再說'));
    assert.strictEqual((await call('/api/claudemd/discard', { cwd: WORK, id: q.json.edit })).status, 200);
    assert.strictEqual((await call('/api/claudemd/apply', { cwd: WORK, id: q.json.edit })).status, 404, 'dropped');
    // a change of text that is not there: said, not proposed
    const bad = await call('/api/claudemd/ask', { cwd: WORK, question: '不存在的原文' });
    assert.deepStrictEqual([bad.json.edit, /找不到/.test(bad.json.answer)], ['', true]);
    assert.deepStrictEqual((await view(WORK)).thread.map((x) => !!x.edit), [true, true, false]);
    // an import outside the project (and outside ~/.claude): shown, never changed - not by a proposal either
    fs.writeFileSync(path.join(HOME, 'outside.md'), '外面\n'); fs.appendFileSync(P, '\n@../outside.md\n');
    const away = (await view(WORK)).files.find((f) => f.abs === path.join(HOME, 'outside.md'));
    assert.deepStrictEqual([away.editable, away.away, away.wide], [false, true, true]);
    const out2 = await call('/api/claudemd/ask', { cwd: WORK, question: '改專案外的' });
    assert.deepStrictEqual([out2.json.edit, /專案外/.test(out2.json.answer)], ['', true]);
    assert.strictEqual((await call('/api/claudemd/tweak', { cwd: WORK, abs: away.abs, section: 'all', instruction: 'x' })).status, 400);
    // words selected before the file changed: those lines are no longer what the page showed, refused; nor lines that are not there
    for (const x of [{ from: 0, to: 1, orig: '別的內容' }, { from: 0, to: 9999, orig }, { from: 3, to: 3, orig: '' }, { from: -1, to: 1, orig }, { from: '0', to: 1, orig }, {}]) assert.strictEqual((await call('/api/claudemd/tweak', Object.assign({ cwd: WORK, abs: P, instruction: 'x' }, x))).status, 409, JSON.stringify(x));
    // the global one's evaluation runs in ~/.claude, and reads other projects' CLAUDE.md to compare
    assert.strictEqual((await call('/api/claudemd/evaluate', { cwd: '' })).status, 202);
    await new Promise((r) => setTimeout(r, 50));
    const last = prompts[prompts.length - 1];
    assert.deepStrictEqual([last[0], last[1].includes('其他專案的 CLAUDE.md')], [path.join(HOME, '.claude'), true]);
    // an answer that does not read: failed, and kept whole to be looked at
    const ge = (await view('')).eval;
    assert.deepStrictEqual([ge.state, ge.error, ge.raw], ['failed', '評估的回答不是預期的格式', '這次沒有照格式回答 {不是 JSON']);
  } finally { s2.close(); if (s2.closeAllConnections) s2.closeAllConnections(); fs.rmSync(P, { force: true }); fs.rmSync(G, { force: true }); fs.rmSync(path.join(HOME, 'outside.md'), { force: true }); }
  // kept in a file: a board started again finds the evaluation and the questions
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual([kept[WORK.toLowerCase()].eval.state, kept[WORK.toLowerCase()].thread.length], ['done', 4]);
});

test('找外掛: switched on once (skill-fetch put in), keys saved, a wish from a question looked for and its finds installable', async () => {
  for (const x of ['GET /api/skillwish', 'POST /api/skillwish', 'POST /api/skillwish/keys']) asked.add(x);
  const calls = [];
  let choice = null, installed = false, wishGo, askGo; const wishGate = new Promise((r) => { wishGo = r; }), askGate = new Promise((r) => { askGo = r; });
  const skillwish = {
    status: () => ({ choice, installed, keys: [{ id: 'SKILLSMP_API_KEY', set: false }] }),
    setChoice: (on) => { choice = on ? 'on' : 'off'; },
    install: async () => { calls.push('install'); installed = true; return { ok: true }; },
    saveKeys: (k) => { calls.push(['keys', Object.keys(k || {})]); return k && k.SKILLSMP_API_KEY ? { ok: true, choice, installed, keys: [{ id: 'SKILLSMP_API_KEY', set: true }] } : { ok: false, error: '沒有要存的金鑰' }; },
    wish: async (cwd, text, have) => {
      calls.push(['wish', text, [...have]]);
      if (text === 'tables') return { ok: true, answer: '找到 tables', skills: [{ ref: 'tables@t', source: 'https://github.com/o/t/tree/main/tables', skillCopy: true, from: '找外掛（70 分）', why: '做表格', note: '' }] };
      await wishGate; return { ok: true, answer: '找到 frontend-slides', skills: [{ ref: 'frontend-slides@r', source: 'https://github.com/o/r/tree/main/skills/frontend-slides', skillCopy: true, from: '找外掛（88 分）', why: '做簡報', note: '' }] };
    },
  };
  const installedRefs = [], file = path.join(HOME, 'pluginfit-wish.json');
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, pluginfitFile: file, skillwish,
    out: Object.assign({}, out, { pluginInstall: async (cwd, items) => { installedRefs.push(items.map((x) => [x.ref, !!x.skillCopy, x.source])); return items.map((x) => ({ ref: x.ref, ok: true })); } }),
    pluginfitAnalyze: async () => ({ ok: true, result: { confident: true, profile: null, summary: 's', plugins: [{ ref: 'harness@fulin-plugins', from: 'x', note: '' }], skip: [] }, cost: 0 }),
    pluginfitAsk: async (cwd, st, question, o) => {
      // an answer that takes harness off the list, worked out from the list as it was when asked (and slow)
      if (question === '拿掉 harness') { await askGate; return { ok: true, answer: '拿掉了', result: Object.assign({}, st.result, { plugins: st.result.plugins.filter((x) => x.ref !== 'harness@fulin-plugins') }) }; }
      return { ok: true, answer: o.wish.on ? '去外面找了' : '先啟用', wish: o.wish.on && o.wish.installed ? (question === '還要做表格的' ? 'tables' : 'slides') : undefined, recommend: { key: 'frontend-slides@r', source: 'https://github.com/o/r/tree/main/skills/frontend-slides', note: '做簡報', tags: [], installMethod: 'skill-copy' } };
    } });
  await new Promise((r) => s2.listen(p2, '127.0.0.1', r));
  const call = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q = http.request({ host: '127.0.0.1', port: p2, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); }); if (b) q.write(b); q.end(); });
  const st = async () => (await call('/api/pluginfit?cwd=' + enc(WORK))).json;
  try {
    assert.deepStrictEqual((await call('/api/skillwish')).json.choice, null, 'not asked yet');
    assert.strictEqual((await call('/api/skillwish', { choice: 'maybe' })).status, 400);
    const off = await call('/api/skillwish', { choice: 'off' }); assert.deepStrictEqual([off.status, off.json.choice, calls.length], [200, 'off', 0], 'off: nothing installed');
    await call('/api/pluginfit/analyze', { cwd: WORK }); await new Promise((r) => setTimeout(r, 50));
    const q0 = await call('/api/pluginfit/ask', { cwd: WORK, question: '我想要做簡報的 skill' });
    assert.deepStrictEqual([q0.status, q0.json.wishing], [200, false], 'switched off: not looked for');
    const on = await call('/api/skillwish', { choice: 'on' }); assert.deepStrictEqual([on.status, on.json.choice, on.json.installed, calls], [200, 'on', true, ['install']]);
    assert.strictEqual((await call('/api/skillwish/keys', { keys: {} })).status, 400);
    const k = await call('/api/skillwish/keys', { keys: { SKILLSMP_API_KEY: 'sk_x' } }); assert.deepStrictEqual([k.status, k.json.keys[0].set], [200, true]);
    const q1 = await call('/api/pluginfit/ask', { cwd: WORK, question: '我想要做簡報的 skill' });
    assert.deepStrictEqual([q1.status, q1.json.wishing], [200, true]);
    const mid = await st(); assert.deepStrictEqual([mid.wishing, mid.thread[1].wish, mid.thread[1].recommend.key], [true, 'slides', 'frontend-slides@r'], 'the wish and the drafted entry kept with the answer');
    assert.deepStrictEqual(calls.find((c) => c[0] === 'wish'), ['wish', 'slides', ['harness@fulin-plugins']], 'what the list has already is not looked for again');
    // a second wish while the first is looked for: waits its turn, and is looked for after (review 2026-11-22: it was
    // written down as looked for and never was)
    const q2 = await call('/api/pluginfit/ask', { cwd: WORK, question: '還要做表格的' });
    assert.deepStrictEqual([q2.status, q2.json.wishing], [200, true]);
    // an answer changing the list, asked before the finds come and answered after: the finds stay on the list
    const slowAsk = call('/api/pluginfit/ask', { cwd: WORK, question: '拿掉 harness' });
    await new Promise((r) => setTimeout(r, 30));
    wishGo(); await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'wish').map((c) => c[1]), ['slides', 'tables'], 'the waiting one looked for after');
    askGo(); assert.strictEqual((await slowAsk).status, 200);
    const got = await st();
    assert.deepStrictEqual([got.wishing, got.result.plugins.map((x) => x.ref), got.wished.map((x) => x.ref)], [false, ['frontend-slides@r', 'tables@t'], ['tables@t', 'frontend-slides@r']]);
    assert.deepStrictEqual(got.thread.filter((x) => /^找外掛/.test(x.q)).map((x) => [x.q, x.wished]), [['找外掛：slides', 1], ['找外掛：tables', 1]]);
    const a = await call('/api/pluginfit/apply', { cwd: WORK, refs: ['frontend-slides@r'] });
    assert.deepStrictEqual([a.status, installedRefs], [200, [[['frontend-slides@r', true, 'https://github.com/o/r/tree/main/skills/frontend-slides']]]], 'a found one installed as a skill copy');
  } finally { s2.close(); if (s2.closeAllConnections) s2.closeAllConnections(); }
});

test('找外掛: a wish that comes back while the analysis is redone and fails is written into the next one that finishes, also after the board starts again', async () => {
  let wishGo; const wishGate = new Promise((r) => { wishGo = r; });
  let failNext = false, analyzeGo = null;
  const skillwish = {
    status: () => ({ choice: 'on', installed: true, keys: [] }), setChoice: () => {}, install: async () => ({ ok: true }), saveKeys: () => ({ ok: false }),
    wish: async () => { await wishGate; return { ok: true, answer: '找到 deck', unsure: 1, versions: 1, dropped: 0, skills: [{ ref: 'deck@r', source: 'https://github.com/o/r/tree/main/deck', skillCopy: true, from: '找外掛（80 分）', why: 'x', note: '' }, { ref: 'inst@r', source: 'https://github.com/o/r/tree/main/inst', skillCopy: true, from: '找外掛（70 分）', why: 'y', note: '' }] }; },
  };
  fs.mkdirSync(path.join(WORK, '.claude', 'skills', 'inst'), { recursive: true });   // the folder has inst already
  const file = path.join(HOME, 'pluginfit-wish.json');
  const deps = () => ({ channels, noTimers: true, noSchedules: true, pluginfitFile: file, skillwish, out,
    pluginfitAnalyze: async () => { if (failNext) { failNext = false; await new Promise((r) => { analyzeGo = r; }); return { ok: false, error: '分析失敗' }; } return { ok: true, result: { confident: true, profile: null, summary: 's', plugins: [{ ref: 'harness@fulin-plugins', from: 'x', note: '' }], skip: [] }, cost: 0 }; },
    pluginfitAsk: async () => ({ ok: true, answer: '去找了', wish: 'deck' }) });
  let port = await freePort(); let s2 = createServer(TOKEN, port, deps());
  await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  const call = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q = http.request({ host: '127.0.0.1', port, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); }); if (b) q.write(b); q.end(); });
  const st = async () => (await call('/api/pluginfit?cwd=' + enc(WORK))).json;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 40));
  try {
    await call('/api/pluginfit/analyze', { cwd: WORK }); await tick();
    assert.strictEqual((await call('/api/pluginfit/ask', { cwd: WORK, question: '我想要 deck' })).json.wishing, true);
    failNext = true; await call('/api/pluginfit/analyze', { cwd: WORK }); await tick();   // analysed again, while the wish is looked for
    analyzeGo(); await tick();                                                           // ...and that fails
    assert.strictEqual((await st()).state, 'failed');
    wishGo(); await tick();                                                              // the wish comes back now
    assert.strictEqual((await st()).state, 'failed', 'nothing to write it into yet');
    assert.ok(fs.existsSync(file.replace(/\.json$/, '') + '-wish.json'), 'kept in a file too');
    // the board started again before the next analysis
    s2.close(); if (s2.closeAllConnections) s2.closeAllConnections();
    port = await freePort(); s2 = createServer(TOKEN, port, deps()); await new Promise((r) => s2.listen(port, '127.0.0.1', r));
    await call('/api/pluginfit/analyze', { cwd: WORK }); await tick();                   // the next analysis finishes
    const got = await st();
    assert.deepStrictEqual([got.state, got.result.plugins.map((x) => x.ref), got.wished.map((x) => x.ref)], ['done', ['harness@fulin-plugins', 'deck@r'], ['deck@r']], 'kept, and written in');
    const a = got.thread.slice(-1)[0].a;
    assert.match(a, /連不上 GitHub/); assert.match(a, /指向某個版本（commit）/); assert.match(a, /1 個在這個資料夾的 \.claude\/skills\/ 裡已經有同名的 skill/);
    assert.ok(!fs.existsSync(file.replace(/\.json$/, '') + '-wish.json'), 'written in: the file is gone');
  } finally { s2.close(); if (s2.closeAllConnections) s2.closeAllConnections(); fs.rmSync(path.join(WORK, '.claude', 'skills', 'inst'), { recursive: true, force: true }); }
});

test('找外掛: a wish still looked for when the board starts again is said to be unfinished; the same source (a / at the end aside) is not listed twice', async () => {
  const never = new Promise(() => {});
  let mode = 'hang';
  const skillwish = {
    status: () => ({ choice: 'on', installed: true, keys: [] }), setChoice: () => {}, install: async () => ({ ok: true }), saveKeys: () => ({ ok: false }),
    wish: async () => { if (mode === 'hang') await never; return { ok: true, answer: '找到', skills: [{ ref: 'kit@r', source: 'https://github.com/o/r/tree/main/kit', skillCopy: true, from: 'x', why: 'x', note: '' }] }; },
  };
  const file = path.join(HOME, 'pluginfit-restart.json');
  const deps = () => ({ channels, noTimers: true, noSchedules: true, pluginfitFile: file, skillwish, out,
    pluginfitAnalyze: async () => ({ ok: true, result: { confident: true, profile: null, summary: 's', plugins: [{ ref: 'kit@r', from: 'x', note: '', source: 'https://github.com/o/r/tree/main/kit/', skillCopy: true }], skip: [] }, cost: 0 }),
    pluginfitAsk: async () => ({ ok: true, answer: '去找了', wish: 'kit' }) });
  let port = await freePort(); let s2 = createServer(TOKEN, port, deps()); await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  const call = (pp, body) => new Promise((resolve) => { const b = body ? Buffer.from(JSON.stringify(body)) : null; const q = http.request({ host: '127.0.0.1', port, path: pp, method: b ? 'POST' : 'GET', headers: Object.assign({ 'x-board-token': TOKEN }, b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); }); if (b) q.write(b); q.end(); });
  const st = async () => (await call('/api/pluginfit?cwd=' + enc(WORK))).json;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 40));
  try {
    await call('/api/pluginfit/analyze', { cwd: WORK }); await tick();
    assert.strictEqual((await call('/api/pluginfit/ask', { cwd: WORK, question: '要 kit' })).json.wishing, true);
    assert.strictEqual((await call('/api/pluginfit/ask', { cwd: WORK, question: '還要 kit' })).json.wishing, true, 'the second waits');
    // the board started again while the first is still looked for
    s2.close(); if (s2.closeAllConnections) s2.closeAllConnections();
    port = await freePort(); s2 = createServer(TOKEN, port, deps()); await new Promise((r) => s2.listen(port, '127.0.0.1', r));
    const after = await st();
    assert.strictEqual(after.wishing, false, 'nothing is being looked for in the board started again');
    assert.deepStrictEqual(after.thread.filter((x) => /^找外掛/.test(x.q)).map((x) => [x.q, /還沒找完/.test(x.a)]), [['找外掛：kit', true], ['找外掛：kit', true]], 'both said to be unfinished, none left waiting');
    assert.ok(!fs.existsSync(file.replace(/\.json$/, '') + '-wish.json'), 'nothing left in the file');
    // a find whose source is one on the list but for a / at the end: not listed again, said so
    mode = 'find';
    await call('/api/pluginfit/ask', { cwd: WORK, question: '再找 kit' }); await tick();
    const got = await st();
    assert.deepStrictEqual(got.result.plugins.map((x) => x.ref), ['kit@r']);
    assert.match(got.thread.slice(-1)[0].a, /1 個已經在上面的清單裡/);
  } finally { s2.close(); if (s2.closeAllConnections) s2.closeAllConnections(); }
});

test('找外掛: the journal read back - a wish already written is not written again; a broken entry never stops the board', async () => {
  const file = path.join(HOME, 'pluginfit-journal.json'), k = path.normalize(WORK).replace(/[\\/]+$/, '').toLowerCase();
  const src = 'https://github.com/o/r/tree/main/kit';
  // the analysis has the answer of wish w1 already (the board ended after writing it, before taking it off the journal)
  fs.writeFileSync(file, JSON.stringify({ [k]: { state: 'done', at: 1, gen: 1, folder: WORK, result: { confident: true, summary: 's', plugins: [{ ref: 'kit@r', source: src, skillCopy: true }], skip: [] }, wished: [{ ref: 'kit@r', source: src }], thread: [{ q: '找外掛：kit', a: '找到', wishId: 'w1', wished: 1 }] } }));
  fs.writeFileSync(file.replace(/\.json$/, '') + '-wish.json', JSON.stringify({ [k]: {
    pending: [{ id: 'w1', cwd: WORK, text: 'kit' }, { id: 'w2', cwd: WORK, text: 'deck' }],
    late: [{ id: 'w1', cwd: WORK, text: 'kit', r: { ok: true, answer: '找到', skills: [{ ref: 'kit@r', source: src }] } },
      { id: 'w3', cwd: WORK, text: 'bad', r: { ok: true, answer: 'x', skills: [{}, null, { ref: 5 }] } }] } }));
  const skillwish = { status: () => ({ choice: 'on', installed: true, keys: [] }), setChoice: () => {}, install: async () => ({ ok: true }), saveKeys: () => ({ ok: false }), wish: async () => ({ ok: false, error: 'x' }) };
  const port = await freePort(); let s2;
  assert.doesNotThrow(() => { s2 = createServer(TOKEN, port, { channels, noTimers: true, noSchedules: true, pluginfitFile: file, skillwish, out }); });
  await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  try {
    const got = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/pluginfit?cwd=' + enc(WORK), headers: { 'x-board-token': TOKEN } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }));
    assert.deepStrictEqual(got.thread.map((t) => [t.q, t.wishId || '', /還沒找完/.test(t.a)]), [['找外掛：kit', 'w1', false], ['找外掛：deck', 'w2', true]], 'w1 not written again (neither as found nor as unfinished); w2 said unfinished; the broken w3 left out');
    assert.ok(!fs.existsSync(file.replace(/\.json$/, '') + '-wish.json'), 'the journal emptied');
  } finally { s2.close(); if (s2.closeAllConnections) s2.closeAllConnections(); }
});

test('a source of the inbox: its connection taken away and made again from the page', async () => {
  asked.add('POST /api/inbox/source');
  assert.strictEqual((await post('/api/inbox/source', { source: 'nope' })).status, 400);
  assert.deepStrictEqual((await post('/api/inbox/source', { source: 'teams' })).json, { ok: true });
  assert.deepStrictEqual((await post('/api/inbox/source', { source: 'teams', connect: true })).json, { ok: true });
});

test('系統排程: what the board does by itself on a timer, each with how often and whether it is on', async () => {
  asked.add('GET /api/system-jobs');
  const r = await get('/api/system-jobs'); assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.jobs.map((x) => x.key), ['inbox', 'check', 'update', 'cbm', 'harness', 'watchdog', 'machine', 'budget', 'goal2tell', 'monthly', 'workdays', 'keepalive']);
  for (const x of r.json.jobs) assert.ok(x.name && x.what && x.every && typeof x.on === 'boolean', x.key);
});

test('the recommend list: read, and changed through plugin-manager (its script stood in for)', async () => {
  for (const x of ['GET /api/recommends', 'POST /api/recommends']) asked.add(x);
  const r = await get('/api/recommends'); assert.strictEqual(r.status, 200); assert.ok(Array.isArray(r.json.items));
  const pp = await freePort(); const got = [];
  const s = createServer(TOKEN, pp, { channels, noTimers: true, noSchedules: true, out, saveRecommend: async (x) => { got.push(x); return x.key === 'bad' ? { ok: false, error: 'no' } : { ok: true }; } });
  await new Promise((res) => s.listen(pp, '127.0.0.1', res));
  const call = (b) => new Promise((resolve) => { const d = Buffer.from(JSON.stringify(b)); const q = http.request({ host: '127.0.0.1', port: pp, path: '/api/recommends', method: 'POST', headers: { 'x-board-token': TOKEN, 'content-type': 'application/json', 'content-length': d.length } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(res.statusCode)); }); q.write(d); q.end(); });
  assert.deepStrictEqual([await call({ key: 'a@b', source: 'o/r', note: 'n' }), await call({ key: 'bad' })], [200, 400]);
  assert.deepStrictEqual(got.map((x) => x.key), ['a@b', 'bad']);
  s.close(); if (s.closeAllConnections) s.closeAllConnections();
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
  assert.deepStrictEqual([cfg.sidebarCollapsed, cfg.sidebarShortcut, cfg.officeFavorites, cfg.hideProgramSessions, cfg.decideModel], [false, true, [], true, 'haiku'], 'the defaults');
  assert.strictEqual((await post('/api/config', { sidebarCollapsed: true, officeFavorites: [WORK], officeOrder: [WORK, HOME] })).status, 200);
  const f = (await get('/api/sessions')).json.features.prefs;
  assert.deepStrictEqual([f.sidebarCollapsed, f.officeFavorites, f.officeOrder], [true, [WORK], [WORK, HOME]], 'sent with the list');
  for (const [k, v] of [['sidebarCollapsed', 'yes'], ['officeFavorites', 'C:\\x'], ['hideProgramFolders', [5]], ['decideModel', 'gpt-4'], ['sidebarWidth', 100], ['sidebarWidth', 900], ['sidebarWidth', 300.5], ['navOrder', 'war'], ['navOrder', ['war', 'war']], ['navOrder', ['WAR']], ['navOrder', Array.from({ length: 13 }, (_, i) => 'a' + 'b'.repeat(i + 1))]]) assert.strictEqual((await post('/api/config', { [k]: v })).status, 400, k);
  assert.strictEqual((await post('/api/config', { navOrder: ['sched', 'war'] })).status, 200);
  assert.deepStrictEqual((await get('/api/sessions')).json.features.prefs.navOrder, ['sched', 'war'], 'the order of the left column');
  // a conversation a program started (entrypoint sdk-cli), one the board started, one of yours
  const PROG = uuid(71), MINE = uuid(72), BOARDS = uuid(73);
  const OTHER = path.join(HOME, 'tools'); fs.mkdirSync(OTHER, { recursive: true });
  const write = (sid, cwd, entry) => {
    const dir = path.join(CLAUDE, 'projects', S.encodeCwd(cwd)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sid + '.jsonl'), line({ type: 'user', sessionId: sid, cwd, entrypoint: entry, timestamp: new Date().toISOString(), message: { role: 'user', content: '問一題 ' + sid.slice(-2) } }) + '\n');
  };
  write(PROG, OTHER, 'sdk-cli'); write(MINE, OTHER, 'cli'); write(BOARDS, OTHER, 'sdk-cli');
  // an older board conversation (before the board remembered its own): not told from a program's, until it is named
  const OLDB = uuid(74); { const dir = path.join(CLAUDE, 'projects', S.encodeCwd(OTHER)); const f = path.join(dir, OLDB + '.jsonl'); fs.writeFileSync(f, line({ type: 'user', sessionId: OLDB, cwd: OTHER, entrypoint: 'sdk-cli', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '看板開的舊對話' }] } }) + '\n'); const when = new Date(2026, 10, 17); fs.utimesSync(f, when, when); }
  config.setValue('boardStarted', [BOARDS]);
  const past = async (qs) => JSON.stringify((await get('/api/past' + (qs || ''))).json);
  assert.ok(!(await past()).includes(PROG), 'left out unless you say otherwise');
  assert.strictEqual((await post('/api/config', { hideProgramSessions: false })).status, 200);
  assert.ok((await past()).includes(PROG), 'off: everything is listed');
  assert.strictEqual((await post('/api/config', { hideProgramSessions: true })).status, 200);
  const p = (await get('/api/past?days=all')).json, ps = JSON.stringify(p.items);
  assert.deepStrictEqual([ps.includes(PROG), ps.includes(MINE), ps.includes(BOARDS), ps.includes(OLDB), p.programHidden >= 1], [false, true, true, false, true], 'only the ones a program started are left out');
  config.setValue('customTitles', Object.assign({}, config.value('customTitles', {}), { [OLDB]: '我的' })); assert.ok((await past('?days=all')).includes(OLDB), 'named: yours'); { const v = Object.assign({}, config.value('customTitles', {})); delete v[OLDB]; config.setValue('customTitles', v); }
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
  assert.deepStrictEqual([t2.entrypoint, t2.byProgram, t2.programHidden], ['sdk-cli', true, true], 'open now and not the board\'s: a program\'s, also when its first message is content blocks');
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

test('a conversation the board opened by itself says so, and whose its first words are', async () => {
  const config = require('../lib/config');
  const row = async (sid) => { await new Promise((r) => setTimeout(r, 1100)); return (await get('/api/sessions')).json.sessions.find((x) => x.sessionId === sid); };
  const mine = (await post('/api/new', { cwd: WORK })).json.sessionId, sec = (await post('/api/new', { cwd: WORK, by: 'line' })).json.sessionId;
  assert.strictEqual((await row(mine)).openedBy, undefined, 'opened by you');
  assert.deepStrictEqual([(await row(sec)).openedBy.by, (await row(sec)).secretary], ['line', true]);
  // T1's latest words of yours: at the moment it was opened they are what it was opened with; later ones are yours
  const at = (await row(T1)).saidAt; assert.ok(at);
  config.setValue('openedBy', Object.assign({}, config.value('openedBy', {}), { [T1]: { by: 'schedule', name: '晨報', at: at - 2000 } }));
  let r = await row(T1); assert.deepStrictEqual([r.openedBy, r.saidByBoard], [{ by: 'schedule', name: '晨報', at: at - 2000 }, true]);
  config.setValue('openedBy', Object.assign({}, config.value('openedBy', {}), { [T1]: { by: 'schedule', name: '晨報', at: at - 600000 } }));
  r = await row(T1); assert.deepStrictEqual([r.openedBy.by, r.saidByBoard], ['schedule', undefined], 'you spoke in it since');
  config.setValue('openedBy', {}); await post('/api/close', { sessionId: mine }); await post('/api/close', { sessionId: sec }); config.setValue('lineSessions', []);
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

test('壓縮紀錄: each compaction\'s summary, for a session the board knows only', async () => {
  const r = await get('/api/compactions?sid=00000000-0000-4000-8000-00000000dead');
  assert.strictEqual(r.status, 404, 'a session the board does not list');
  // one it lists, with no transcript of its own here: said so, not thrown
  const known = (await get('/api/sessions')).json;
  const s = (known.sessions || known || []).find ? (known.sessions || known).find((x) => x && x.sessionId) : null;
  if (s) { const x = await get('/api/compactions?sid=' + enc(s.sessionId)); assert.ok([200, 404].includes(x.status)); assert.ok(Array.isArray(x.json.items)); }
});

test('home-screen app: a manifest with a ticket (never the key) in its start address, the ticket handed in once for the key', async () => {
  const page = await get('/'); assert.match(String(page.headers['content-security-policy']), /manifest-src 'self'/);
  assert.match(page.text, /apple-mobile-web-app-capable/); assert.match(page.text, /apple-touch-icon" href="\/icons\/app-180\.png"/);
  const t = await post('/api/app/ticket'); assert.strictEqual(t.status, 200); assert.match(t.json.ticket, /^[a-f0-9]{48}$/);
  const none = { 'x-board-token': '' };
  const m = await ask('/app.webmanifest?ticket=' + t.json.ticket, { headers: none });
  assert.deepStrictEqual([m.status, /manifest\+json/.test(m.headers['content-type']), m.json.display, m.json.start_url], [200, true, 'standalone', '/?app=' + t.json.ticket]);
  assert.ok(!m.text.includes(TOKEN), 'the key is not in the manifest');
  assert.strictEqual((await ask('/app.webmanifest?ticket=../x', { headers: none })).json.start_url, '/', 'only a ticket of the right shape goes in');
  for (const n of [180, 192, 512]) { const i = await ask('/icons/app-' + n + '.png', { headers: none }); assert.deepStrictEqual([i.status, i.headers['content-type'], i.bytes.slice(1, 4).toString()], [200, 'image/png', 'PNG'], String(n)); }
  assert.strictEqual((await ask('/icons/app-64.png', { headers: none })).status, 404);
  const r1 = await ask('/app/redeem', { body: { ticket: t.json.ticket }, headers: none });
  assert.deepStrictEqual([r1.status, r1.json.token], [200, TOKEN], 'handed in from one of your devices: the key');
  assert.strictEqual((await ask('/app/redeem', { body: { ticket: t.json.ticket }, headers: none })).status, 403, 'once');
  assert.strictEqual((await ask('/app/redeem', { body: { ticket: 'f'.repeat(48) }, headers: none })).status, 403, 'one never made');
  assert.strictEqual((await ask('/api/app/ticket', { body: {}, headers: none })).status, 401, 'a ticket only with the key');
});

test('the default model and effort of new conversations: read, and set in Claude Code\'s settings - only those two', async () => {
  asked.add('GET /api/model/default'); asked.add('POST /api/model/default');
  const f = path.join(os.homedir(), '.claude', 'settings.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  assert.ok(f.startsWith(HOME + path.sep), 'the made-up home only (set at the top of this file): never your own settings.json');
  const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  try {
    fs.writeFileSync(f, JSON.stringify({ model: 'sonnet', theme: 'dark' }));
    const g = await get('/api/model/default'); assert.deepStrictEqual([g.status, g.json.model, g.json.effort], [200, 'sonnet', '']);
    const s = await post('/api/model/default', { model: 'opus', effort: 'high' });
    assert.deepStrictEqual([s.status, s.json.model, s.json.effort], [200, 'opus', 'high']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { model: 'opus', theme: 'dark', modelSettings: { opus: { effortLevel: 'high' } } });
    for (const bad of [{ model: 'gpt-5' }, { effort: 'huge' }]) assert.strictEqual((await post('/api/model/default', bad)).status, 400, JSON.stringify(bad));
  } finally { if (had === null) { try { fs.unlinkSync(f); } catch (e) {} } else fs.writeFileSync(f, had); }
});

test('a goal2 run that ended with nobody waiting is told to the conversation that started it - once, and given back when it cannot be', async () => {
  const sent = [], claims = [], releases = [];
  const R = (id, sid, cwd) => ({ runDir: path.join(HOME, 'g2runs', id), runId: id, status: 'done', parentSessionId: sid, parentCwd: cwd, message: '【goal2 跑完了】run ' + id });
  let pending = [R('20261126090000-goal-aaaa', 'a1a1a1a1-0000-4000-8000-000000000a01', WORK), R('20261126090000-goal-bbbb', 'b2b2b2b2-0000-4000-8000-000000000b02', path.join(HOME, 'no-such-folder')), R('20261126090000-goal-cccc', 'c3c3c3c3-0000-4000-8000-000000000c03', WORK)];
  const g = { list: async () => ({ installed: true, runs: [] }), pending: async () => pending, claim: async (d) => { claims.push(d); return { ok: !/cccc/.test(d) }; }, release: async (d) => { releases.push(d); return { ok: true }; } };
  const p3 = await freePort(); const s3 = createServer(TOKEN, p3, { channels, noTimers: true, noSchedules: true, out, goal2: g });
  const realSend = channels.send;
  channels.send = function (sid, text) { sent.push([sid, text]); return realSend.call(channels, sid, text); };
  try {
    const r = await s3.tellGoalRuns();
    assert.deepStrictEqual(r.map((x) => [x.runId, x.ok, x.how || '']), [['20261126090000-goal-aaaa', true, 'resume'], ['20261126090000-goal-bbbb', false, '']], 'cccc was taken by someone else: not told by the board');
    assert.deepStrictEqual(sent.map((x) => x[0]), ['a1a1a1a1-0000-4000-8000-000000000a01'], 'only to the conversation that started it');
    assert.ok(/goal2 跑完了/.test(sent[0][1]));
    const c = channels.get('a1a1a1a1-0000-4000-8000-000000000a01');
    assert.ok(c && c.cwd === WORK, 'a conversation not open is started again on the board, in its own folder');
    assert.deepStrictEqual(releases, [path.join(HOME, 'g2runs', '20261126090000-goal-bbbb')], 'not delivered (its folder is gone): given back for goal2\'s hook');
    c.lastResultAt = Date.now() + 1; assert.strictEqual(channels.unread(c), true, 'what the board sends by itself is not you reading it');
    const before = claims.length; pending = pending.filter((x) => !/aaaa/.test(x.runId));   // aaaa was told: goal2 no longer lists it
    assert.deepStrictEqual(await s3.tellGoalRuns(), [], 'one not delivered is not tried again within 30 minutes');
    assert.ok(claims.slice(before).every((d) => !/bbbb/.test(d)), 'not even claimed again');
    pending = []; sent.length = 0;
    assert.deepStrictEqual(await s3.tellGoalRuns(), [], 'nothing pending: nothing sent'); assert.strictEqual(sent.length, 0);
  } finally { channels.send = realSend; s3.close(); if (s3.closeAllConnections) s3.closeAllConnections(); }
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
  // which integrations there are: those installed, nothing else decides it (the settings' switches are gone, 2026-11-20)
  const ig = P.integrations({ 'self-heal': {}, goal2: {} });
  assert.deepStrictEqual(Object.fromEntries(Object.entries(ig).map(([k, x]) => [k, [x.installed, x.on]])), { goal2: [true, true], harness: [false, false], versions: [false, false], git: [true, true], daily: [false, false], selfHeal: [true, true], qa: [false, false], cbm: [false, false] });
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

  { const r = await get('/api/machine'); assert.strictEqual(r.status, 200); assert.deepStrictEqual([r.json.ram.map((g) => g.name), r.json.cpu.map((g) => g.name)], [['x', 'Chrome'], ['Chrome', 'x']]); assert.strictEqual(r.json.now.alert.ram, 85);
    { const m = await post('/api/machine/mute', { k: 'ram', on: true }); assert.deepStrictEqual([m.status, m.json.now.muted], [200, ['ram']]); assert.strictEqual((await post('/api/machine/mute', { k: 'ram', on: false })).json.now.muted.length, 0); assert.strictEqual((await post('/api/machine/mute', { k: 'x', on: true })).status, 400); }
    await post('/api/machine/mute', { k: 'ram', on: true }); await post('/api/config', { machineAlert: false }); await post('/api/config', { machineAlert: true }); assert.deepStrictEqual((await get('/api/sessions')).json.machine.muted, [], 'off and on at once takes it back');
    assert.strictEqual((await post('/api/config', { machineRam: 40 })).status, 400); assert.strictEqual((await post('/api/config', { machineRam: 90, machineAlert: false })).status, 200); assert.deepStrictEqual((await get('/api/sessions')).json.machine.alert, { on: false, ram: 90, cpu: 85 }); await post('/api/config', { machineRam: 85, machineAlert: true }); }
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
  assert.strictEqual((await post('/api/unsent', { sessionId: B, id: 'no-such', action: 'resend' })).status, 409, 'nothing of that id waits to be sent again');
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
  { const c = channels.get(B); c.lastSeenAt = 1000; c.lastResultAt = 2000; channels.send(B, '（看板自動送出）額度回來了'); assert.strictEqual(channels.unread(c), true, 'what the board sends by itself is not you reading');
    assert.strictEqual((await post('/api/send', { sessionId: B, text: '我送的' })).status, 200); assert.strictEqual(channels.unread(c), false, 'you wrote in it'); }

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
  { const bg = channels.get(B), st = bg.state; bg.state = 'idle'; bg.tasks.set('t1', {}); const r = await post('/api/to-terminal', { sessionId: B }); assert.deepStrictEqual([r.status, /背景工作/.test(r.json.error)], [409, true], 'nor while something it started runs'); bg.tasks.delete('t1'); bg.state = st; }
  const blocked = await post('/api/shutdown'); assert.strictEqual(blocked.status, 409); assert.ok(blocked.json.active.length >= 1, 'the board is not stopped under a working conversation');
  { const shown = new Map((await get('/api/sessions')).json.sessions.map((x) => [x.sessionId, x.title])); for (const x of blocked.json.active) assert.strictEqual(x.title, shown.get(x.sessionId), 'told by the name the board shows'); }
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

  // a message edited and sent again: carried on from the reply before it, in the same conversation (as /rewind in a terminal)
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
  assert.strictEqual(rw.status, 200); assert.deepStrictEqual([rw.json.fromStart, rw.json.inPlace, rw.json.sessionId], [undefined, true, RW], 'the same conversation');
  const rwc = channels.get(RW), rwFile = path.join(CLAUDE, 'projects', S.encodeCwd(WORK), RW + '.jsonl');
  {
    const lines = fs.readFileSync(rwFile, 'utf8').split('\n'), after = Buffer.byteLength(lines.slice(0, 2).join('\n') + '\n');
    assert.deepStrictEqual([rwc.rewindAt, rwc.rewinds], [uuid(82), [[after, fs.statSync(rwFile).size]]], 'from the reply before it; what came after it kept as the way gone back from');
    assert.strictEqual(rwc.resumeAt, undefined, 'not the field a copy starts from');
  }
  const rwArgs = procs.slice(procsAt).map((x) => x.args).find((a) => a.includes('--resume-session-at'));
  assert.ok(rwArgs, 'started from that entry');
  assert.deepStrictEqual(rwArgs.slice(rwArgs.indexOf('--resume'), rwArgs.indexOf('--resume') + 4), ['--resume', RW, '--resume-session-at', uuid(82)]);
  assert.ok(!rwArgs.includes('--fork-session'), 'not a copy under another id');
  const rwSent = procs[procs.length - 1].p.stdin.written.find((w) => w && w.type === 'user');
  assert.ok(rwSent && JSON.stringify(rwSent).includes('改過的第二句'), 'the new words sent');
  // what Claude Code writes next is a branch of the same transcript: the page reads the way it is on now
  fs.appendFileSync(rwFile, [
    line({ type: 'user', uuid: uuid(84), parentUuid: uuid(82), sessionId: RW, cwd: WORK, timestamp: new Date().toISOString(), message: { role: 'user', content: '改過的第二句' } }),
    line({ type: 'assistant', uuid: uuid(85), parentUuid: uuid(84), sessionId: RW, cwd: WORK, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '收到改過的' }] } }),
  ].join('\n') + '\n');
  assert.deepStrictEqual((await get('/api/messages?sid=' + RW)).json.items.map((x) => x.text), ['第一句', '好', '改過的第二句', '收到改過的'], 'not the words gone back from');
  // its first reply came: started again later, it is resumed from its end, not from that entry again
  procs[procs.length - 1].p.stdout.emit('data', JSON.stringify({ type: 'assistant', session_id: RW, message: { content: [{ type: 'text', text: '收到改過的' }] } }) + '\n');
  assert.deepStrictEqual([rwc.rewindAt, rwc.rewindTo], [undefined, undefined]);
  assert.deepStrictEqual(rwc.rewinds.length, 1, 'the range stays: the page still leaves that part out');
  // one with pictures: the ones kept go along, at their marks; not all there: nothing is stopped or closed
  {
    const dir = path.join(CLAUDE, 'projects', S.encodeCwd(WORK)), ts = new Date().toISOString(), RP = (await post('/api/new', { cwd: WORK })).json.sessionId, img = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    fs.writeFileSync(path.join(dir, RP + '.jsonl'), [
      line({ type: 'user', uuid: uuid(81), parentUuid: null, sessionId: RP, cwd: WORK, timestamp: ts, message: { role: 'user', content: '第一句' } }),
      line({ type: 'assistant', uuid: uuid(82), parentUuid: uuid(81), sessionId: RP, cwd: WORK, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }),
      line({ type: 'user', uuid: uuid(83), parentUuid: uuid(82), sessionId: RP, cwd: WORK, timestamp: ts, message: { role: 'user', content: [img('AAAA'), { type: 'text', text: '看［圖1］' }, img('BBBB'), { type: 'text', text: ' 跟［圖2］' }, img('CCCC'), { type: 'text', text: ' 這個' }] } }),
    ].join('\n') + '\n');
    assert.strictEqual((await get('/api/sessions')).json.features.editPics, true);
    assert.deepStrictEqual([(await post('/api/rewind', { sessionId: RP, at: uuid(83), text: 'x', pics: [1] })).status, !!channels.get(RP)], [400, true], 'a block that is no picture');
    assert.strictEqual((await post('/api/rewind', { sessionId: RP, at: uuid(83), text: ' ', pics: [] })).status, 400);
    { const many = await post('/api/rewind', { sessionId: RP, at: uuid(83), text: 'x', pics: [0, 1, 2, 3, 4, 5, 6, 7, 8] }); assert.deepStrictEqual([many.status, /最多 8 張/.test(many.json.error), !!channels.get(RP)], [400, true, true], 'more than can go along: said, none dropped silently'); }
    const rp = await post('/api/rewind', { sessionId: RP, at: uuid(83), text: '改看［圖2］', pics: [0, 4] }); assert.strictEqual(rp.status, 200, rp.text);
    const sent = procs[procs.length - 1].p.stdin.written.filter((w) => w && w.type === 'user').pop().message.content;
    assert.deepStrictEqual(sent.map((b) => (b.type === 'image' ? b.source.data : b.text)), ['AAAA', '改看［圖2］', 'CCCC']);
    { const it = require('../lib/history').readHistory(path.join(dir, RP + '.jsonl'), {}).items.find((x) => x.id === uuid(83)); assert.deepStrictEqual([it.imgAt, it.imgTag], [[0, 2, 4], [0, 1, 2]], 'which mark each picture has: the first was dragged in, it has none'); }
    await post('/api/stop', { sessionId: rp.json.sessionId }); await post('/api/close', { sessionId: rp.json.sessionId });
  }
  // the first message edited: a conversation that starts afresh (nothing to carry on from)
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
    assert.strictEqual(n3, c3, 'carried on in place: the same conversation');
    assert.strictEqual(n3.title, '舊的標題', 'its title stays');
    assert.strictEqual(cfg.value('customTitles', {})[n3.sessionId], '我取的名字', 'the name you gave it stays');
    const said3 = procs.slice(at).map((x) => JSON.stringify(x.p.stdin.written)).join('\n');
    assert.ok(said3.includes('echo shell-note-1') && said3.includes('改過'), 'the "!" notes not yet sent go in front of the new words');
    // started afresh (the first message edited): not the old title; the name you gave it still goes with it
    fs.copyFileSync(path.join(dir, RW + '.jsonl'), path.join(dir, n3.sessionId + '.jsonl'));
    const r4 = await post('/api/rewind', { sessionId: n3.sessionId, at: uuid(81), text: '從頭' });
    assert.strictEqual(r4.status, 200);
    assert.notStrictEqual(channels.get(r4.json.sessionId).title, '舊的標題', 'started afresh: the title comes from the new words');
    assert.strictEqual(cfg.value('customTitles', {})[r4.json.sessionId], '我取的名字');
    // the new words cannot be sent: nothing changed - not where it carries on from, not what the page leaves out
    fs.copyFileSync(path.join(dir, RW + '.jsonl'), path.join(dir, r4.json.sessionId + '.jsonl'));
    const realSend = channels.send;
    channels.send = (sid, text) => (channels.get(sid) && channels.get(sid).rewindAt ? { ok: false, error: '送不出去（測試）' } : realSend.call(channels, sid, text));
    const before5 = channels.list().length;
    const r5 = await post('/api/rewind', { sessionId: r4.json.sessionId, at: uuid(83), text: 'x' });
    channels.send = realSend;
    assert.deepStrictEqual([r5.status, /對話已停下，沒有重來/.test(r5.json.error)], [500, true]);
    assert.deepStrictEqual([channels.get(r4.json.sessionId).rewindAt, channels.get(r4.json.sessionId).rewinds], [undefined, undefined], 'put back as it was');
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
  // put aside with Ctrl+S: one place, kept with the conversation; it is not empty because of it, and sending leaves it
  const st = (await post('/api/new', { cwd: WORK })).json.sessionId, of = async () => ((await get('/api/sessions')).json.sessions || []).find((x) => x.sessionId === st);
  assert.strictEqual((await post('/api/stash', { sessionId: st, text: '先放著的話' })).json.ok, true);
  assert.deepStrictEqual([(await of()).stash, (await of()).title, (await of()).notStarted], ['先放著的話', '暫存：先放著的話', undefined]);
  assert.strictEqual((await post('/api/close-empty', { sessionId: st })).json.ok, false, 'words put aside: not closed');
  await post('/api/stash', { sessionId: st, text: '換一段' }); assert.strictEqual(channels.get(st).stash, '換一段', 'one place');
  await post('/api/draft', { sessionId: st, text: '要送的' }); assert.strictEqual((await post('/api/send', { sessionId: st, text: '要送的' })).json.ok, true);
  assert.deepStrictEqual([channels.get(st).draft, channels.get(st).stash], ['', '換一段'], 'sending takes the draft, not what is put aside');
  assert.strictEqual((await post('/api/stash', { sessionId: st, text: '  ' })).json.ok, true); assert.strictEqual((await of()).stash, undefined);
  assert.strictEqual((await post('/api/stash', { sessionId: 'nope', text: 'x' })).status, 404); assert.strictEqual((await post('/api/stash', { sessionId: st })).status, 400);
  await post('/api/close', { sessionId: st });
  // a terminal has no place for what is not sent: said, not lost
  const tt = (await post('/api/new', { cwd: WORK })).json.sessionId; await post('/api/stash', { sessionId: tt, text: '先放著' });
  const mv = await post('/api/to-terminal', { sessionId: tt }); assert.deepStrictEqual([mv.status, /暫存.*拿不回來/.test(mv.json.error), channels.get(tt).stash], [409, true, '先放著']);
  assert.match((await post('/api/stash', { sessionId: tt, text: 'x'.repeat(160000) })).json.error, /太長/); await post('/api/close', { sessionId: tt });
  // pictures or files only, not sent: the page has them, the board keeps the conversation for them
  const hd = (await post('/api/new', { cwd: WORK })).json.sessionId, hel = async () => ((await get('/api/sessions')).json.sessions || []).find((x) => x.sessionId === hd);
  assert.strictEqual((await post('/api/held', { sessionId: hd, page: 'pageA', n: 2 })).json.ok, true);
  assert.deepStrictEqual([(await hel()).held, (await hel()).title, (await hel()).notStarted], [2, '還沒送出：2 個附件', undefined]);
  assert.strictEqual((await post('/api/close-empty', { sessionId: hd })).json.ok, false, 'not closed under them');
  await post('/api/held', { sessionId: hd, page: 'pageB', n: 0 }); assert.strictEqual((await post('/api/close-empty', { sessionId: hd })).json.ok, false, 'another page has none: this one\'s stay');
  assert.strictEqual((await post('/api/held', { sessionId: hd, page: '', n: 0 })).json.ok, false);
  assert.match((await post('/api/to-terminal', { sessionId: hd })).json.error, /還沒送出的附件/);
  channels.get(hd).held.pageA.at -= 10 * 60000; assert.deepStrictEqual([channels.held(channels.get(hd)), channels.held(channels.get(hd), 180000)], [2, 0], 'a page that went without a word');
  await post('/api/held', { sessionId: hd, page: 'pageA', n: 'x' }); assert.strictEqual((await post('/api/close-empty', { sessionId: hd })).json.ok, true, 'none any more: closed');
  assert.strictEqual((await post('/api/held', { sessionId: hd, page: 'pageA', n: 1 })).json.ok, false, 'a conversation no longer there');
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

test('a schedule of its own rule: said in words, checked, shown with its next runs, saved', async () => {
  const w = await post('/api/schedule/rule', { text: '每月最後一個工作天下午三點' });
  assert.strictEqual(w.status, 200, w.text);
  assert.deepStrictEqual([w.json.ok, w.json.rule.cron, w.json.rule.text, w.json.rule.explain, ruleAsked.slice(-1)[0]], [true, '0 15 LW * *', '每月最後一個工作天下午三點', '每月最後一個工作天 15:00', '每月最後一個工作天下午三點']);
  assert.strictEqual(w.json.next.length, 5);
  assert.ok(w.json.next.every((x, i) => new Date(x.at).getHours() === 15 && (!i || x.at > w.json.next[i - 1].at)), 'five runs, at 15:00, in order');
  assert.ok(w.json.guessed.length >= 1, 'no calendar in this made-up home (and the fetch fails): the working days are a guess, and it says so');
  // not understood: said so, nothing else
  const no = (await post('/api/schedule/rule', { text: '看不懂的話' })).json;
  assert.deepStrictEqual([no.ok, no.error, no.rule], [false, '看不懂這句排程：不是時間', undefined]);
  // the rule itself, typed; and a wrong one
  const r = await post('/api/schedule/rule', { rule: { cron: '0 9,14 * * 1-5', until: '2099-12-31' } });
  assert.deepStrictEqual([r.json.ok, r.json.next.length, r.json.guessed], [true, 5, []]);
  assert.match((await post('/api/schedule/rule', { rule: { cron: '* * * * *' } })).json.error, /5 分鐘/);
  assert.strictEqual((await post('/api/schedule/rule', {})).status, 400);
  // saved with it, and listed with its next run
  assert.match((await post('/api/schedule/save', { kind: 'custom', cwd: WORK, prompt: 'hi' })).json.error, /5 欄/);
  const sv = await post('/api/schedule/save', { kind: 'custom', rule: r.json.rule, cwd: WORK, prompt: '自訂規則的排程' });
  assert.strictEqual(sv.status, 200, sv.text);
  const s = (await get('/api/schedules')).json.schedules.find((x) => x.id === sv.json.id);
  assert.deepStrictEqual([s.kind, s.rule.cron, s.rule.until], ['custom', '0 9,14 * * 1-5', '2099-12-31']);
  assert.strictEqual(s.next, r.json.next[0].at, 'its next run is the first of those shown');
  await post('/api/schedule/delete', { id: sv.json.id });
  // a schedule being edited: its preview counted as its runs are - a count from the save that changed the rule, kept
  // when the rule is the same (review 2026-11-20; asked 2026-11-20: "from the edit, counted again")
  const two = await post('/api/schedule/save', { kind: 'custom', rule: { cron: '0 9 * * *', count: 2 }, cwd: WORK, prompt: '跑兩次' });
  const made = Date.now() - 3 * 86400000, db = require('../lib/db').open();
  db.prepare('UPDATE schedule SET created_at = ?, rule = ? WHERE id = ?').run(made, JSON.stringify({ cron: '0 9 * * *', count: 2, countFrom: made }), two.json.id);
  const pv = async (rule) => (await post('/api/schedule/rule', { id: two.json.id, rule })).json.next.length;
  assert.deepStrictEqual([await pv({ cron: '0 9 * * *', count: 2 }), await pv({ cron: '0 9 * * *', count: 2, text: '每天九點兩次' }), await pv({ cron: '0 9 * * *', count: 3 })], [0, 0, 3],
    'counting since three days ago: its two runs are over, with other words too; three asked for now: three ahead');
  assert.strictEqual((await post('/api/schedule/rule', { rule: { cron: '0 9 * * *', count: 2 } })).json.next.length, 2, 'a new one has both ahead');
  // saved: what the preview showed is what runs; the name alone changed: still counting from where it was
  const save = (rule, name) => post('/api/schedule/save', { id: two.json.id, kind: 'custom', rule, cwd: WORK, prompt: '跑兩次', name });
  await save({ cron: '0 9 * * *', count: 2 }, '改名');
  const listed = () => (async () => (await get('/api/schedules')).json.schedules.find((x) => x.id === two.json.id))();
  assert.deepStrictEqual([(await listed()).rule.countFrom, (await listed()).next], [made, 0]);
  const t0 = Date.now(); await save({ cron: '0 9 * * *', count: 3, countFrom: 1 });
  const s3 = await listed();
  assert.ok(s3.rule.countFrom >= t0 && s3.next > t0, 'the count changed: counted from this save (not from what the page sent), and it runs again');
  await post('/api/schedule/delete', { id: two.json.id });
  // whose working days: a setting, said with each preview; the countries there are calendars for
  const Workdays = require('../lib/workdays');
  const before = (await get('/api/config')).json.prefs.workdayCountry;
  try {
    assert.strictEqual((await post('/api/config', { workdayCountry: 'jp' })).status, 400);
    assert.strictEqual((await post('/api/config', { workdayCountry: 'JP' })).status, 200);
    assert.deepStrictEqual([Workdays.country(), (await post('/api/schedule/rule', { rule: { cron: '0 9 LW * *' } })).json.country], ['JP', 'JP']);
    assert.strictEqual((await post('/api/config', { workdayCountry: '' })).status, 200);
    const n = (await post('/api/schedule/rule', { rule: { cron: '0 9 * * *', workday: 'only' } })).json;
    assert.deepStrictEqual([n.country, n.guessed], ['', []], 'none chosen: Monday to Friday, nothing guessed');
    const c = await post('/api/workdays/countries', {}); assert.strictEqual(c.status, 200, c.text);
    assert.ok(c.json.countries.some((x) => x.code === 'TW'), 'Taiwan is there even when the list cannot be fetched');
  } finally { await post('/api/config', { workdayCountry: before }); }
});

test('a link to localhost pressed on another device: passed on only there', async () => {
  assert.strictEqual((await post('/api/localweb', { port: 57570 })).status, 400, 'on this computer itself it is just opened');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const local = new Function(/const localLink = [^\n]+/.exec(src)[0] + '; return localLink;')();
  assert.deepStrictEqual([local('http://localhost:57570/a?b=1#c'), local('https://127.0.0.1/'), local('http://[::1]:8080/').port], [{ port: 57570, secure: false, path: '/a?b=1#c' }, { port: 443, secure: true, path: '/' }, 8080]);
  for (const u of ['http://example.com/', 'http://localhost.evil.com/', 'http://192.168.1.5/', 'file:///c:/x', '/api/x']) assert.strictEqual(local(u), null, u);
});

test('what the board refuses from another device is not offered there', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').split('\n');
  const list = [.../const onThisScreen = \[([^\]]+)\]/.exec(src)[1].matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(list.length >= 7);
  // each place in the page that asks for one of them, or opens something in a terminal, looks at REMOTE just above or on it
  const bad = [];
  page.forEach((l, i) => { if (list.some((p) => l.includes("api('" + p + "'")) || /(openPast|bringBack)\([^)]*'terminal'\)/.test(l)) { if (!page.slice(Math.max(0, i - 28), i + 1).some((x) => /\bREMOTE\b/.test(x))) bad.push((i + 1) + ': ' + l.trim().slice(0, 90)); } });
  assert.deepStrictEqual(bad, []);
});

test('a search: what you said in the middle of it, the open ones, and the ones taken off the list', async () => {
  const SI = require('../lib/saidindex'), config = require('../lib/config'), dbFile = path.join(path.dirname(config.CONFIG_FILE), 'said.db');
  const MID = uuid(171), OFF = uuid(172), dir = path.join(CLAUDE, 'projects', S.encodeCwd(WORK)); fs.mkdirSync(dir, { recursive: true });
  const said = (sid, t) => line({ type: 'user', sessionId: sid, cwd: WORK, entrypoint: 'cli', timestamp: new Date().toISOString(), message: { role: 'user', content: t } });
  fs.writeFileSync(path.join(dir, MID + '.jsonl'), [said(MID, '開頭'), said(MID, '中間提到石虎保育'), said(MID, '結尾')].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, OFF + '.jsonl'), said(OFF, '石虎不列出的那個') + '\n');
  const ask = async () => (await get('/api/past?q=' + encodeURIComponent('石虎'))).json;
  assert.deepStrictEqual((await ask()).indexing, true, 'not looked through yet: said so');
  SI.scan(dbFile, path.join(CLAUDE, 'projects'));
  let r = await ask(); assert.strictEqual(r.indexing, false);
  assert.deepStrictEqual(r.items.find((x) => x.sessionId === MID).hit, { who: 'you', text: '中間提到石虎保育' });
  await post('/api/hide', { sessionId: OFF, hidden: true });
  assert.strictEqual((await ask()).items.find((x) => x.sessionId === OFF).offList, true, 'found, and said to be off the list');
  assert.ok(!(await get('/api/past')).json.items.some((x) => x.sessionId === OFF), 'without a search it stays off');
  await post('/api/hide', { sessionId: OFF, hidden: false });
  // one that is open is in no list of the not open: where in it is told apart
  const tf = S.findTranscript(T1, WORK, S.DEFAULTS.projectsDir) || path.join(dir, T1 + '.jsonl'); fs.appendFileSync(tf, said(T1, '開著的也提到石虎') + '\n');
  SI.scan(dbFile, path.join(CLAUDE, 'projects')); r = await ask();
  assert.deepStrictEqual(r.said[T1], { who: 'you', text: '開著的也提到石虎' }); assert.ok(!r.items.some((x) => x.sessionId === T1));
});

test('an Office file is converted once for what is in it; opened again it is not sent again', async () => {
  const F = require('../lib/files'), dir = path.join(WORK, 'pdf'); fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'a.pptx'), b = path.join(dir, 'b.pptx'); fs.writeFileSync(a, 'deck one');
  const n = () => did.filter((x) => x === 'convertOffice').length, was = n();
  const ask = (file, more, headers) => new Promise((done) => http.get({ host: '127.0.0.1', port, path: '/api/file/pdf?path=' + encodeURIComponent(file) + (more || ''), headers: Object.assign({ 'x-board-token': TOKEN }, headers) }, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => done({ code: r.statusCode, h: r.headers, t })); }));
  const ready = async (file) => JSON.parse((await ask(file, '&ready=1')).t).cached;
  assert.strictEqual(await ready(a), false); assert.strictEqual(n(), was, 'asking does not convert');
  const x = await ask(a); assert.deepStrictEqual([x.code, x.t, n() - was], [200, '%PDF-1.4 test', 1]); assert.strictEqual(await ready(a), true);
  assert.strictEqual((await ask(a, '', { 'if-none-match': x.h.etag })).code, 304, 'the browser has it');
  // saved again with nothing changed, and a copy of it elsewhere
  fs.utimesSync(a, new Date(), new Date(Date.now() + 60000)); fs.copyFileSync(a, b);
  assert.deepStrictEqual([(await ask(a)).code, (await ask(b)).code, n() - was], [200, 200, 1]);
  fs.writeFileSync(a, 'deck two'); const y = await ask(a, '', { 'if-none-match': x.h.etag }); assert.deepStrictEqual([y.code, n() - was], [200, 2], 'changed: converted again');
  // one converted by an earlier version (named by path and time) is still used
  const c = path.join(dir, 'c.docx'); fs.writeFileSync(c, 'old'); fs.writeFileSync(F.cachePathFor(c), '%PDF old'); assert.deepStrictEqual([(await ask(c)).t, n() - was], ['%PDF old', 2]);
});

test('harness: the chart drawn for a project, the page before the table; artifacts are on for the board unless you said', () => {
  const H = require('../lib/harness'), { claudeEnv } = require('../lib/chat'), d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-flow-')), h = path.join(d, '.claude', 'harness');
  fs.mkdirSync(h, { recursive: true }); fs.writeFileSync(path.join(h, 'README.md'), 'x');
  assert.deepStrictEqual([H.stateOf(d).installed, H.stateOf(d).flowFile], [true, '']);
  fs.writeFileSync(path.join(h, 'flow.md'), '# x'); assert.strictEqual(H.stateOf(d).flowFile, path.join(h, 'flow.md'));
  fs.writeFileSync(path.join(h, 'flow.html'), '<p>'); const s = H.stateOf(d); assert.strictEqual(s.flowFile, path.join(h, 'flow.html')); assert.ok(s.flowAt > 0);
  assert.deepStrictEqual([claudeEnv({ A: '1' }).CLAUDE_CODE_ARTIFACT, claudeEnv({ A: '1' }).A, claudeEnv({ CLAUDE_CODE_ARTIFACT: '0' }).CLAUDE_CODE_ARTIFACT, claudeEnv({}).CLAUDE_CODE_ARTIFACT_AUTO_OPEN], ['1', '1', '0', '0']);
});

test('a day\'s summary: asked for, where it stands, what is wrong said', async () => {
  const m = (await get('/api/daily?month=2026-11')).json; assert.strictEqual(typeof m.ready, 'boolean'); assert.deepStrictEqual(m.days, {});
  assert.deepStrictEqual([(await get('/api/daily?date=2026-11-03')).json.state, (await post('/api/daily', { date: '2099-01-01' })).status], ['none', 409]);
});

test('a conversation some program started is left out, whichever program it was - told by what Claude Code records', async () => {
  const dir = (cwd) => { const d = path.join(CLAUDE, 'projects', S.encodeCwd(cwd)); fs.mkdirSync(d, { recursive: true }); return d; };
  const put = (n, cwd, entry, o = {}) => { const f = path.join(dir(cwd), uuid(n) + '.jsonl'); fs.writeFileSync(f, line(Object.assign({ type: 'user', sessionId: uuid(n), cwd, entrypoint: entry, timestamp: new Date().toISOString(), message: { role: 'user', content: o.blocks ? [{ type: 'text', text: '第一句 ' + n }] : '第一句 ' + n } }, o.src ? { promptSource: o.src } : {})) + '\n'); const when = o.old || new Date(Date.UTC(2026, 11, 1)); fs.utimesSync(f, when, when); };
  const was = (await get('/api/config')).json.prefs.hideProgramSessions; await post('/api/config', { hideProgramSessions: true });
  const OLD = new Date(2026, 10, 17), CASES = [
    [181, path.join(HOME, '.claude-mem', 'observer-sessions', '-958'), 'sdk-cli', { blocks: true, old: OLD }, false, 'a program that is written down as the board is, however old'],
    [182, path.join(HOME, '.claude-mem', 'x'), 'cli', {}, true, 'no folder is a program\'s by its name'],
    [183, WORK, 'sdk-cli', { blocks: true }, false, 'content blocks, since'],
    [184, WORK, 'sdk-cli', { src: 'sdk' }, false, 'claude -p'],
    [185, WORK, 'sdk-ts', { blocks: true, old: OLD }, false, 'the Agent SDK, however old'],
    [186, WORK, 'my-tool', { src: 'sdk', blocks: true }, false, 'a name of its own'],
    [187, WORK, 'cli', { src: 'sdk' }, true, 'begun by a program, then opened in a terminal'], [191, WORK, undefined, { src: 'sdk' }, false, 'nothing recorded but where its words came from'], [192, WORK, undefined, {}, true, 'nothing recorded at all'],
    [188, WORK, 'cli', { src: 'typed' }, true, 'typed'], [189, WORK, 'cli', { src: 'queued' }, true, 'queued'], [190, WORK, 'cli', {}, true, 'an old one of a terminal, nothing recorded'],
  ];
  for (const [n, cwd, entry, o] of CASES) put(n, cwd, entry, o);
  const ids = JSON.stringify((await get('/api/past?days=all')).json.items), all = JSON.stringify((await get('/api/past?days=all&programs=1')).json.items);
  for (const [n, , , , listed, why] of CASES) { assert.strictEqual(ids.includes(uuid(n)), listed, why); assert.ok(all.includes(uuid(n)), why + ': there when asked for'); }
  // the setting says which folders are left out; ~ is your home
  for (const [f, listed] of [['.claude-mem', false], ['.CLAUDE-MEM/', false], ['claude-mem', true], ['x', false], ['~/.claude-mem', false], [path.join(HOME, '.claude-mem') + path.sep, false], ['~/.claude', true], ['~', false]]) {
    await post('/api/config', { hideProgramFolders: [f] }); assert.strictEqual(JSON.stringify((await get('/api/past?days=all')).json.items).includes(uuid(182)), listed, f);
  }
  await post('/api/config', { hideProgramSessions: was, hideProgramFolders: [] });
});

test('a folder by its name: hidden, found, and the one meant where one is worked in', async () => {
  const F = require('../lib/folders'), P = path, root = path.parse(WORK).root, j = (...a) => P.join(root, ...a);
  // a name is any folder of that name and what is in it, not a part of one; a path is that folder only
  for (const [cwd, entry, yes] of [[j('u', '.claude-mem', 'obs', '-9'), '.claude-mem', true], [j('u', '.claude-mem'), '.Claude-Mem', true], [j('u', '.claude-memory'), '.claude-mem', false], [j('a', 'b'), j('a', 'b'), true], [j('a', 'b', 'c'), j('a', 'b') + P.sep, true], [j('a', 'bc'), j('a', 'b'), false], [j('a'), root, true], [P.join(os.homedir(), 'x'), '~', true], [P.join(os.homedir(), 'x', 'y'), '~/x', true], [j('a'), '', false], ['', 'a', false], [j('a'), '"a"', true]]) assert.strictEqual(F.within(cwd, entry), yes, cwd + ' in ' + entry);
  assert.deepStrictEqual(['a', '.claude-mem', 'a/', '"a b"', '~', '/a', 'C:', '', '..'].map(F.isName), [true, true, true, true, false, false, false, false, false]); if (P.sep === '\\') assert.strictEqual(F.isName('a\\b'), false);
  const counts = new Map([[j('p', 'one', 'site'), 3], [j('p', 'two', 'site'), 1], [j('p', 'alone'), 2], [j('u', '.claude-mem', 'obs', 'x'), 40], [j('u', '.claude-mem', 'obs', 'y'), 2], [j('p', 'sitemap'), 9]]);
  assert.deepStrictEqual(F.search('.claude-mem', counts).map((x) => [x.path, x.n]), [[j('u', '.claude-mem'), 42]], 'the folder they are in, with all inside it');
  assert.deepStrictEqual(F.search('site', counts).map((x) => x.name), ['site', 'site', 'sitemap'], 'the same name first'); assert.ok(!F.search('', counts).some((x) => x.path === root));
  const isDir = (p) => !p.includes('gone'), r = (t) => F.resolve(t, counts, isDir);
  assert.deepStrictEqual([r('alone'), r('ALONE'), r(j('p', 'alone')), r('')].map((x) => x.path), [j('p', 'alone'), j('p', 'alone'), j('p', 'alone'), '']);
  assert.deepStrictEqual([r('site').ok, r('site').choices], [false, [j('p', 'one', 'site'), j('p', 'two', 'site')]]); assert.match(r('site').error, /有 2 個叫「site」/); assert.match(r('nothing').error, /沒有用過叫「nothing」/);
  assert.deepStrictEqual([r('p').path, r(j('gone')).ok, r('a/b').ok], [j('p'), false, false]); assert.strictEqual(F.resolve('alone', counts, () => false).ok, false, 'no longer there');
  // on the board: asked while typing, and used where a folder is worked in
  const d = path.join(HOME, 'by-name', 'only-here'); fs.mkdirSync(d, { recursive: true }); const pd = path.join(CLAUDE, 'projects', S.encodeCwd(d)); fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, uuid(195) + '.jsonl'), line({ type: 'user', sessionId: uuid(195), cwd: d, entrypoint: 'cli', timestamp: new Date().toISOString(), message: { role: 'user', content: '一' } }) + '\n');
  const real = Date.now; let found; try { Date.now = () => real() + 120000; await get('/api/folders'); found = (await get('/api/folders?q=only-here&entries=1')).json; } finally { Date.now = real; }
  assert.deepStrictEqual([found.found[0].path, found.found[0].n, found.typed.n, found.entries], [d, 1, 1, []]);
  const n = await post('/api/new', { cwd: 'only-here' }); assert.strictEqual(n.status, 200, n.text); assert.strictEqual(channels.get(n.json.sessionId).cwd, d); await post('/api/close', { sessionId: n.json.sessionId });
  assert.deepStrictEqual([(await post('/api/new', { cwd: 'no-such-name' })).status, (await post('/api/new', { cwd: '' })).status, (await post('/api/new', {})).status, (await post('/api/new', { cwd: { a: 1 } })).status], [400, 400, 400, 400]);
  const sc = await post('/api/schedule/save', { target: 'folder', kind: 'daily', at: '09:00', cwd: 'only-here', prompt: 'x' }); assert.strictEqual(sc.status, 200, sc.text); assert.strictEqual((await get('/api/schedules')).json.schedules.find((x) => x.id === sc.json.id).cwd, d); await post('/api/schedule/delete', { id: sc.json.id });
  assert.match((await post('/api/schedule/save', { target: 'folder', kind: 'daily', at: '09:00', cwd: 'no-such-name', prompt: 'x' })).json.error, /沒有用過叫「no-such-name」/);
  assert.strictEqual((await post('/api/goals/start', { cwd: 'only-here', task: 'x', condition: 'y' })).json.error, '這台電腦沒有裝 goal2', 'the folder is taken'); assert.match((await post('/api/goals/start', { cwd: 'no-such-name', task: 'x', condition: 'y' })).json.error, /沒有用過叫/);
  // a name's accents kept apart (a Mac may), what Finder and Explorer call the folders of your home, quotes in a name
  const nfd = 'Café'.normalize('NFD'); assert.ok(F.within(j('u', nfd, 'x'), 'café') && F.within(j('u', 'Café'), j('u', nfd)) && F.search('café', new Map([[j('u', nfd), 2]])).length === 1);
  const H = os.homedir(); assert.deepStrictEqual([F.within(P.join(H, 'Desktop', 'a'), '桌面'), F.within(P.join(H, 'Documents'), '文件'), F.within(j('x', 'Documents'), '文件'), F.within(j('x', '文件', 'y'), '文件')], [true, true, false, true]);
  assert.strictEqual(F.resolve('桌面', new Map([[P.join(H, 'Desktop'), 1]]), () => true).path, P.join(H, 'Desktop'));
  assert.strictEqual(F.resolve('桌面', new Map([[j('a', 'Desktop'), 1]]), () => true).ok, false, 'a Desktop somewhere else is not it'); assert.strictEqual(F.resolve('桌面', new Map([[j('a', 'Desktop'), 1], [P.join(H, 'Desktop'), 1]]), () => true).path, P.join(H, 'Desktop'));
  assert.deepStrictEqual([F.resolve(j('u', "dogs'"), new Map(), (p) => p === j('u', "dogs'")).path, F.resolve('"' + j('u', 'a b') + '"', new Map(), (p) => p === j('u', 'a b')).path], [j('u', "dogs'"), j('u', 'a b')]);
  if (P.sep === '/') assert.deepStrictEqual([F.isName('a\\b'), F.within('/u/a\\b/c', 'b'), F.within('/u/a\\b/c', 'a\\b')], [true, false, true], 'a backslash is a letter there');
  // the roles of a folder by its name; a name that is the name of something in every object
  fs.mkdirSync(path.join(d, '.claude', 'agents'), { recursive: true }); fs.writeFileSync(path.join(d, '.claude', 'agents', 'helper.md'), '---\nname: helper\ndescription: x\n---\nx');
  assert.ok((await post('/api/roles', { cwd: 'only-here' })).json.roles.some((x) => x.name === 'helper')); assert.match((await post('/api/roles', { cwd: 'no-such-name' })).json.error, /沒有用過叫/);
  for (const x of ['constructor', '__proto__', 'toString']) { assert.strictEqual(F.within(j('a', 'b'), x), false); assert.strictEqual((await get('/api/folders?q=' + x)).status, 200); }
  // the root of a disk: a whole path as any other
  for (const x of process.platform === 'win32' ? ['C:\\', 'c:/', 'C:', '"C:\\"'] : ['/']) assert.deepStrictEqual(F.resolve(x, new Map(), (p) => p.toLowerCase() === root.toLowerCase() || p === '/').ok, true, x);
});

test('a recommend entry from an address: what is wrong with it is said', async () => {
  assert.match((await post('/api/recommends/draft', { url: 'nonsense' })).json.error, /看不懂/);
  const r = await post('/api/recommends/draft', { url: 'https://github.com/a/b' }); assert.deepStrictEqual([r.status, /找不到 a\/b/.test(r.json.error)], [400, true]);
});

test('what the LINE secretary opens is on no list, until you write in it', async () => {
  const n = (await post('/api/new', { cwd: WORK, by: 'line' })).json.sessionId; await post('/api/send', { sessionId: n, text: '找一份簡報', by: 'line' });
  const of = async () => (await get('/api/sessions')).json.sessions.find((x) => x.sessionId === n);
  assert.deepStrictEqual([(await of()).secretary, (await of()).programHidden], [true, true]);
  await post('/api/send', { sessionId: n, text: '我自己說的' });
  assert.deepStrictEqual([(await of()).secretary, (await of()).programHidden], [undefined, undefined], 'yours');
  await post('/api/close', { sessionId: n });
});

test('the pictures shown while something is awaited: every one of every set there, one a day, each told where it is from', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const cut = (a, z) => src.slice(src.indexOf(a), src.indexOf(z, src.indexOf(a)));
  const sets = new Function(cut('const LOAD_SETS = [', 'let ldChosen') + '; return LOAD_SETS;')(), dir = path.join(__dirname, '..', 'public', 'load'), lic = fs.readFileSync(path.join(dir, 'LICENSE.txt'), 'utf8');
  assert.deepStrictEqual(sets.map((x) => x[0]), ['animals', 'fox', 'blob', 'mine']);
  const raw = (p) => new Promise((done) => http.get({ host: '127.0.0.1', port, path: p }, (x) => { const b = []; x.on('data', (d) => b.push(d)); x.on('end', () => done([x.statusCode, x.headers['content-type'], Buffer.concat(b), x.headers['content-security-policy'] || ''])); }));
  for (const [k, name, , ext, list, , from] of sets) {
    if (k === 'mine') continue;
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, k)).sort(), list.map((n) => n + '.' + ext).sort(), k + ': no file missing, none left over');
    assert.strictEqual(new Set(list).size, list.length); assert.ok(list.length >= 29, k + ' ' + list.length);
    for (const n of list) { const [code, type, b, csp] = await raw('/load/' + k + '/' + n + '.' + ext); assert.deepStrictEqual([code, type, b.length > 200, /sandbox/.test(csp)], [200, ext === 'svg' ? 'image/svg+xml' : 'image/webp', true, true], n); if (ext === 'svg') assert.ok(!/<script|javascript:|foreignObject|href="(?!#)/i.test(b.toString()), n + ' is a plain picture'); }
    assert.ok(from && new RegExp('^' + k + ' ', 'm').test(lic), name + ' says where it is from');
  }
  for (const p of ['/load/fox/no-such.webp', '/load/fox/..%2f..%2findex.webp', '/load/LICENSE.txt', '/load/hedgehog.webp']) assert.strictEqual((await raw(p))[0], 404, p);
  const day = new Function(cut('const ldDay = ', '\n') + '; return ldDay;')();
  assert.strictEqual(new Set(Array.from({ length: 30 }, (_, i) => day(30, new Date(2026, 10, 1 + i, 9).getTime()))).size, 30, '30 days, 30 pictures');
  assert.strictEqual(day(30, new Date(2026, 10, 23, 0, 1).getTime()), day(30, new Date(2026, 10, 23, 23, 59).getTime()), 'the same all day');
  assert.strictEqual((await post('/api/config', { loadIcon: 'nope' })).status, 400); assert.strictEqual((await post('/api/config', { loadIcon: 'fox' })).json.prefs.loadIcon, 'fox'); await post('/api/config', { loadIcon: 'animals' });
  for (const x of ['rice', 'three', 'none']) assert.strictEqual((await post('/api/config', { loadIcon: x })).status, 400, x + ' is no longer one of them');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['LICENSE.txt', 'animals', 'blob', 'fox']);
  // drawn by Claude: a draft, then yours - and the one shown
  assert.deepStrictEqual((await get('/api/loaddraw')).json, { ok: true, busy: null, error: '', mine: null, draft: null }); assert.strictEqual((await get('/api/sessions')).json.features.loadMine, null);
  assert.strictEqual((await post('/api/loaddraw', { do: 'x' })).status, 400); assert.strictEqual((await post('/api/loaddraw', { do: 'use' })).status, 400); assert.strictEqual((await post('/api/loaddraw', { do: 'draw', ref: '' })).status, 400);
  assert.strictEqual((await post('/api/loaddraw', { do: 'draw', ref: '橘貓' })).status, 200);
  let st; for (let i = 0; i < 50; i++) { st = (await get('/api/loaddraw')).json; if (!st.busy) break; await new Promise((r2) => setTimeout(r2, 20)); }
  assert.deepStrictEqual([st.error, st.draft.n, st.draft.ref, st.mine], ['', 2, '橘貓', null]);
  const at = (w, v, i, ext) => raw('/load/' + w + '/' + v + '-' + i + '.' + (ext || 'svg'));
  const pic = await at('draft', st.draft.v, 1); assert.deepStrictEqual([pic[0], pic[1], /sandbox/.test(pic[3])], [200, 'image/svg+xml', true]);
  assert.strictEqual((await at('mine', st.draft.v, 1))[0], 404); assert.strictEqual((await at('draft', '0123456789abcdef', 1))[0], 404); assert.strictEqual((await at('draft', st.draft.v, 1, 'webp'))[0], 404);
  assert.strictEqual((await post('/api/loaddraw', { do: 'use' })).json.mine.v, st.draft.v); assert.strictEqual((await at('mine', st.draft.v, 2))[0], 200);
  { const f = (await get('/api/sessions')).json.features; assert.deepStrictEqual([f.loadMine.v, f.prefs.loadIcon], [st.draft.v, 'mine']); }
  await post('/api/config', { loadIcon: 'animals' });
});

test('每天上班統整: a switch where LINE is connected, one schedule, its time kept, what came of it recorded', async () => {
  assert.deepStrictEqual((await get('/api/digest')).json, { line: false, on: false, schedule: null });
  assert.strictEqual((await post('/api/digest', { on: true })).status, 409, 'LINE is not connected');
  assert.strictEqual((await post('/api/digest', {})).status, 400);
  lineOn = true;
  const on = (await post('/api/digest', { on: true })).json, s = on.schedule;
  assert.deepStrictEqual([on.on, s.target, s.kind, s.days, s.at, s.enabled], [true, 'digest', 'weekly', '1,2,3,4,5', '09:30', true]);
  // its time is the schedule page's; a second one, or another schedule made into one, is not
  const body = { id: s.id, target: 'digest', name: s.name, kind: 'daily', at: '08:45' };
  assert.strictEqual((await post('/api/schedule/save', body)).status, 200);
  assert.strictEqual((await post('/api/schedule/save', { target: 'digest', kind: 'daily', at: '08:00' })).status, 400);
  assert.strictEqual((await post('/api/schedule/save', { id: s.id, target: 'folder', cwd: WORK, prompt: 'x', kind: 'daily', at: '08:00' })).status, 400);
  assert.strictEqual((await post('/api/digest', { on: false })).json.on, false);
  const again = (await post('/api/digest', { on: true })).json.schedule;
  assert.deepStrictEqual([again.id, again.at, again.kind], [s.id, '08:45', 'daily'], 'switched on again with the time you gave it');
  const run = async () => { await post('/api/schedule/run', { id: s.id }); for (let i = 0; i < 100; i++) { const r = (await get('/api/schedules')).json.log.find((x) => x.scheduleId === s.id); if (r && r.status !== 'running') return r; await new Promise((x) => setTimeout(x, 50)); } return null; };
  const a = await run(); assert.deepStrictEqual([a.status, /已用 LINE 送出/.test(a.note)], ['done', true]); assert.match(pushed[0], /上班統整/);
  const b = await run(); assert.deepStrictEqual([b.status, /429/.test(b.note)], ['failed', true], 'LINE did not take it: failed, not done');
  lineOn = false; assert.match((await run()).note, /LINE 還沒有接通/); assert.strictEqual(pushed.length, 2);
  await post('/api/schedule/delete', { id: s.id });
});

test('the 額度 card\'s ↻: cc-statusline asks (lib/quota.js refreshQuota), the figures come back with its answer', async () => {
  const limits = path.join(CLAUDE, 'cc-statusline', 'state', 'account-limits.json'); fs.mkdirSync(path.dirname(limits), { recursive: true });
  const reset = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(limits, JSON.stringify({ v: 1, at: Date.now() - 1000, five_hour: { used_percentage: 39, resets_at: reset }, seven_day: null }));
  const a = await post('/api/quota/refresh', {});
  assert.strictEqual(a.status, 200, a.text);
  assert.deepStrictEqual([a.json.ok, a.json.asked, a.json.at, a.json.quota.fiveHour.pct, a.json.quota.from, quotaAsks], [true, true, 1795803261984, 39, 'asked', 1]);
  const b = await post('/api/quota/refresh', {});
  assert.deepStrictEqual([b.json.ok, b.json.asked, quotaAsks], [true, false, 2], 'what cc-statusline answered is handed on (it does not ask again within 30 seconds)');
  fs.unlinkSync(limits);
});

test('schedules', async () => {
  assert.strictEqual((await post('/api/schedule/save', { name: 'x' })).status, 400);
  // after the limit resets: refused when nothing is known (this made-up home has no figures)
  const rs = await post('/api/schedule/save', { name: 'x', kind: 'reset', cwd: WORK, prompt: 'hi' }); assert.deepStrictEqual([rs.status, /沒有額度資料.*cc-statusline/.test(rs.json.error)], [400, true]);
  // with a 5-hour window running: saved as a one-off a minute after its reset (the figures cc-statusline keeps, as they are written)
  const reset = Math.floor(Date.now() / 1000) + 2 * 3600 + 17 * 60;
  const limits = path.join(CLAUDE, 'cc-statusline', 'state', 'account-limits.json'); fs.mkdirSync(path.dirname(limits), { recursive: true });
  fs.writeFileSync(limits, JSON.stringify({ v: 1, at: Date.now(), five_hour: { used_percentage: 97, resets_at: reset }, seven_day: null }));
  const ok = await post('/api/schedule/save', { name: '額度回來再跑', kind: 'reset', cwd: WORK, prompt: 'hi' });
  assert.strictEqual(ok.status, 200, ok.text);
  const want = new Date(reset * 1000 + 60000), pad = (n) => String(n).padStart(2, '0');
  const saved = (await get('/api/schedules')).json.schedules.find((x) => x.id === ok.json.id);
  assert.deepStrictEqual([saved.kind, saved.date, saved.at], ['once', want.getFullYear() + '-' + pad(want.getMonth() + 1) + '-' + pad(want.getDate()), pad(want.getHours()) + ':' + pad(want.getMinutes())]);
  assert.ok(Math.abs(saved.next - (reset * 1000 + 60000)) < 60000, 'next run is a minute after the reset: ' + new Date(saved.next).toISOString());
  await post('/api/schedule/delete', { id: ok.json.id });
  assert.deepStrictEqual((await get('/api/quota')).json.wait, { window: '5h', at: reset * 1000, pct: 97 });
  // no 5-hour limit on the account: the 7-day one; the 5-hour one not running: nothing to wait for
  const week = Math.floor(Date.now() / 1000) + 2 * 86400 + 600; fs.writeFileSync(limits, JSON.stringify({ v: 1, at: Date.now(), five_hour: null, seven_day: { used_percentage: 75, resets_at: week } }));
  const wk = await post('/api/schedule/save', { name: '7 天額度回來再跑', kind: 'reset', cwd: WORK, prompt: 'hi' }); assert.strictEqual(wk.status, 200, wk.text);
  assert.ok(Math.abs((await get('/api/schedules')).json.schedules.find((x) => x.id === wk.json.id).next - (week * 1000 + 60000)) < 60000); await post('/api/schedule/delete', { id: wk.json.id });
  fs.writeFileSync(limits, JSON.stringify({ v: 1, at: Date.now(), five_hour: { used_percentage: 0, resets_at: null }, seven_day: { used_percentage: 75, resets_at: week } }));
  assert.match((await post('/api/schedule/save', { name: 'x', kind: 'reset', cwd: WORK, prompt: 'hi' })).json.error, /沒有 5 小時額度在計時/);
  fs.unlinkSync(limits);
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
  // by its name alone: the one conversations ran in
  { const nm = path.basename(WORK), one = await post('/api/inbox/assign', { id: 'gmail:t2', folder: nm }); if (one.status === 200) assert.strictEqual(one.json.folder, WORK); else assert.ok(one.json.choices.includes(WORK), one.text); assert.match((await post('/api/inbox/assign', { id: 'gmail:t2', folder: 'no-such-name' })).json.error, /沒有用過叫/); assert.match((await post('/api/inbox/route', { source: 'gmail', source_ref: 'x', root_folder: 'no-such-name' })).json.error, /沒有用過叫/); }
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
  // the same test reports in a folder qa-webwright is not installed for: no test line there (2026-11-20: by each folder)
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-room-')); fs.cpSync(path.join(proj, 'tests'), path.join(bare, 'tests'), { recursive: true });
  assert.strictEqual((await via('/api/rooms?cwd=' + encodeURIComponent(bare))).json.facts[bare].qa, undefined);
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

test('the model for small judgements: one setting for the next step, the inbox and the recommended plugins', async () => {
  assert.strictEqual(inbox.triageModel(), 'haiku', 'as it comes');
  const r = await post('/api/config', { decideModel: 'sonnet' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(inbox.triageModel(), 'sonnet');
  // ... down to the call itself, for a recommended plugin
  const p5 = await freePort(), asked5 = [], j = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
  const s5 = createServer(TOKEN, p5, { channels, noTimers: true, noSchedules: true, out, claudeAsk: (o) => { asked5.push(o.model); return async () => ({ ok: false }); }, recFetch: async () => ({ ok: false, status: 404 }) });
  await new Promise((r) => s5.listen(p5, '127.0.0.1', r));
  await fetch('http://127.0.0.1:' + p5 + '/api/recommends/draft', { method: 'POST', headers: { 'x-board-token': TOKEN, 'content-type': 'application/json', origin: 'http://127.0.0.1:' + p5 }, body: JSON.stringify({ url: 'https://github.com/a/b' }) });
  s5.close(); if (s5.closeAllConnections) s5.closeAllConnections();
  assert.deepStrictEqual(asked5, ['sonnet']);
  await post('/api/config', { decideModel: 'haiku' });
});

test('collaborations: started (ledger, names, bypass, briefs), read back, a decision passed on, ended', async () => {
  for (const r of ['GET /api/collabs', 'GET /api/collab', 'POST /api/collab/create', 'POST /api/collab/decide', 'POST /api/collab/end']) asked.add(r);
  let B = (await post('/api/new', { cwd: WORK })).json.sessionId;
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
  const codeA = r.json.results.find((x) => x.role === 'ALPHA').name, codeB = r.json.results.find((x) => x.role === 'BETA').name;
  assert.ok(/^S\d+-ALPHA$/.test(codeA) && /^S\d+-BETA$/.test(codeB) && codeA.split('-')[0] !== codeB.split('-')[0], codeA + ' ' + codeB);
  for (const want of ['## 目標', '對齊增量同步規格', '## 成員與分工', codeA, codeB, '| 介面 | 提供方 | 版本／最後改動 | ALPHA | BETA |', '## 承諾清單', '## 待你裁定', '## 使用者裁定', '## 合作規則']) assert.ok(text.includes(want), 'ledger has ' + want);
  const byRole = Object.fromEntries(r.json.results.map((x) => [x.role, x]));
  assert.deepStrictEqual([byRole.ALPHA.rename, byRole.ALPHA.brief, byRole.BETA.rename], ['start', 'sent', 'by-you'], JSON.stringify(r.json.results));
  assert.ok(['now', 'after-turn'].includes(byRole.ALPHA.bypass));
  // the board conversation: started without approvals, told its name and the brief
  assert.strictEqual(channels.get(B).skipPermissions, true);
  let started = procs.slice(n0).find((x) => x.args.includes('--dangerously-skip-permissions'));
  assert.ok(started, 'its process runs in bypass');
  const said = started.p.stdin.written.map((w) => JSON.stringify(w)).join('\n');
  assert.strictEqual(started.args[started.args.indexOf('--name') + 1], codeA, 'started under its fixed name');
  assert.ok(!said.includes('/rename'), 'nothing to rename');
  assert.ok(said.includes('【合作 #' + id + '】') && said.includes(codeB) && said.includes(ledger.replace(/\\/g, '\\\\')), 'brief: the other member by name, and the ledger');
  // the list and one in full
  const l = (await get('/api/collabs')).json;
  assert.ok(l.collabs.some((c) => c.id === id && c.state === 'active' && c.members.length === 2));
  const d = (await get('/api/collab?id=' + id)).json;
  assert.deepStrictEqual([d.goal, d.ledgerMissing, d.members.map((m) => m.role)], ['對齊增量同步規格', false, ['ALPHA', 'BETA']]);
  assert.deepStrictEqual(d.renameCommands.map((x) => x.command), ['/rename ' + codeB], 'the terminal session: the line to paste');
  assert.strictEqual((await get('/api/collab?id=999')).status, 404);
  // a member of a collaboration edits a message and sends it again: carried on in place, the same member under the same
  // name; told of the collaboration again only when its notice was in the part gone back from
  {
    const dir = path.join(CLAUDE, 'projects', S.encodeCwd(WORK)), ts = new Date().toISOString();
    const said = (sid, u, p, text) => line({ type: 'user', uuid: uuid(u), parentUuid: p, sessionId: sid, cwd: WORK, timestamp: ts, message: { role: 'user', content: text } });
    const reply = (sid, u, p) => line({ type: 'assistant', uuid: uuid(u), parentUuid: uuid(p), sessionId: sid, cwd: WORK, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } });
    const rows = (sid) => [said(sid, 81, null, '第一句'), reply(sid, 82, 81), said(sid, 83, uuid(82), '（看板自動送出）【合作 #' + id + '】說明'), reply(sid, 84, 83), said(sid, 85, uuid(84), '第二句')].join('\n') + '\n';
    const go = async (from, at, text) => {
      fs.writeFileSync(path.join(dir, from + '.jsonl'), rows(from)); const n0 = procs.length; delete channels.get(from).skipPermissions;   // (one that came from a terminal has none of its own)
      const r = await post('/api/rewind', { sessionId: from, at: uuid(at), text }); assert.strictEqual(r.status, 200, r.text);
      const to = r.json.sessionId, pr = procs.slice(n0).find((x) => x.args.includes(to));
      assert.strictEqual(pr.args[pr.args.indexOf('--name') + 1], codeA, 'under the same name');
      assert.ok(pr.args.includes('--dangerously-skip-permissions'), 'and without asking, as its collaboration does');
      if (r.json.inPlace) assert.deepStrictEqual([to, !!channels.get(from), channels.codeOf(to)], [from, true, codeA], 'the same conversation');
      else { assert.deepStrictEqual([channels.get(from), channels.codeOf(to)], [null, codeA]); const left = channels.codeOf(from); assert.ok(left && left !== codeA, 'the one left behind: a name of its own (' + left + ')'); }
      const now = (await get('/api/collab?id=' + id)).json;
      assert.deepStrictEqual(now.members.map((m) => [m.role, m.sessionId, m.name]), [['ALPHA', to, codeA], ['BETA', TT, codeB]]);
      const led = fs.readFileSync(ledger, 'utf8'); assert.ok(led.includes(to) && (to === from || !led.includes(from)), 'the ledger has the one that goes on');
      return { to, pr, words: JSON.stringify(pr.p.stdin.written) };
    };
    const tt = procs.length;
    const a = await go(B, 85, '改過的第二句'); assert.ok(a.words.includes('改過的第二句') && !a.words.includes('【合作 #'), 'it knows of the collaboration already');
    const b = await go(a.to, 83, '回到說明之前'); assert.ok(b.words.includes('回到說明之前') && b.words.includes('【合作 #' + id + '】') && b.words.includes(codeB), 'from before it was told: told again');
    { const w = b.pr.p.stdin.written.filter((x) => x.type === 'user').map((x) => JSON.stringify(x.message.content)); assert.deepStrictEqual([w.length, /回到說明之前/.test(w[0]) && !/合作 #/.test(w[0]), /看板自動送出/.test(w[1])], [2, true, true], 'yours by itself, first; the board\'s after it'); }
    const c = await go(b.to, 81, '從頭'); assert.ok(c.words.includes('【合作 #' + id + '】'), 'started afresh: told again');
    assert.strictEqual(channels.get(c.to).title, '從頭', 'the title from your words, not the board\'s');
    assert.strictEqual(procs.length - tt, 3, 'nobody else was told anything');
    const last = c.to, ch = channels.get(last);
    started = procs.find((x) => x.args.includes(last)); B = last; ch.state = 'idle';
  }
  // a name given to it on the board: its own title there, not what the others reach it by
  const rn = await post('/api/rename', { sessionId: B, name: '我取的標題' });
  assert.deepStrictEqual([rn.json.name, rn.json.synced], ['我取的標題', false]);
  assert.ok(!started.p.stdin.written.map((w) => JSON.stringify(w)).join('\n').includes('/rename'), 'not renamed in Claude Code');
  await post('/api/rename', { sessionId: B, name: '' });
  // the terminal member's registered name changes (its process restarted): in the ledger's members section; nobody is told
  const regFile = fs.readdirSync(path.join(CLAUDE, 'sessions')).map((n) => path.join(CLAUDE, 'sessions', n)).find((x) => { try { return JSON.parse(fs.readFileSync(x, 'utf8')).sessionId === TT; } catch (e) { return false; } });
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8')); const firstName = reg.name;
  const writes = () => procs.reduce((n, x) => n + (x.p.stdin.written || []).length, 0);
  await get('/api/sessions'); await new Promise((r) => setTimeout(r, 1100)); await get('/api/sessions');   // seen once under its first name: nobody told
  const before = [procs.length, writes()];
  reg.name = 'project-b-zz'; fs.writeFileSync(regFile, JSON.stringify(reg));
  await new Promise((r) => setTimeout(r, 1100)); await get('/api/sessions'); await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.readFileSync(ledger, 'utf8').includes('代號 `' + codeB + '`（現在登記的名字是 `project-b-zz`'), 'the ledger has the new name next to the fixed one');
  assert.deepStrictEqual([procs.length, writes()], before, 'no message to anyone, no process started');
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
  // its process is kept while the collaboration is under way - not when it also runs somewhere else
  const cb = channels.get(B), procB = cb.proc;
  const trB = path.join(CLAUDE, 'projects', S.encodeCwd(WORK), B + '.jsonl'), trT = S.findTranscript(TT, WORK, path.join(CLAUDE, 'projects'));
  fs.writeFileSync(trB, line({ type: 'user', uuid: uuid(81), parentUuid: null, sessionId: B, cwd: WORK, timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' } }) + '\n');
  let tick = 0; const at = (t) => { fs.writeFileSync(trB, line({ type: 'assistant', uuid: uuid(82), parentUuid: null, sessionId: B, cwd: WORK, timestamp: new Date(t).toISOString(), message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'x' }] } }) + '\n' + line({ type: 'assistant', uuid: uuid(83), timestamp: new Date().toISOString(), message: { model: '<synthetic>', content: [] } }) + '\n'); tick++; fs.utimesSync(trB, Date.now() / 1000, Date.now() / 1000 - 60 + tick); };
  if (trT) fs.rmSync(trT, { force: true });
  cb.state = 'idle'; at(Date.now() - 3 * 86400000);   // (the file itself was written just now: a process started, not work)
   assert.strictEqual(channels.keepAlive(B), false, 'nobody at work for days');
  cb.state = 'busy'; assert.strictEqual(channels.keepAlive(B), true, 'in the middle of a turn');
  cb.state = 'idle'; at(Date.now() - 3600000); assert.strictEqual(channels.keepAlive(B), true);
  cb.proc = null;
  const other = path.join(CLAUDE, 'sessions', '999901.json');
  fs.writeFileSync(other, JSON.stringify({ pid: process.pid, sessionId: B, cwd: WORK, kind: 'interactive', entrypoint: 'cli', status: 'idle', name: 'x' }));
  assert.strictEqual(channels.keepAlive(B), false, 'open in a terminal: left alone');
  fs.rmSync(other); cb.proc = procB;
  assert.deepStrictEqual([channels.keepAlive(B), channels.keepAlive(TT), channels.codeOf(B), channels.codeOf(uuid(98))], [true, false, codeA, '']);
  // however it comes back onto the board, it runs without asking (its collaboration does)
  { const back = channels.create(WORK, B); assert.deepStrictEqual([channels.bypasses(back), back.skipPermissions], [true, undefined], 'asked at every start, not written down'); channels.map.set(B, cb); const other = channels.create(WORK, uuid(97)); assert.strictEqual(channels.bypasses(other), false); channels.remove(uuid(97)); }
  // a copy of it has a name of its own; a terminal opened for another session does not get this one's
  const F = channels.create(WORK); F.forkOf = B;
  const codeF = channels.codeOf(F.sessionId); assert.ok(codeF && codeF !== codeA && channels.codeOf(F.sessionId) === codeF, codeF);
  channels.remove(F.sessionId);
  const G = channels.create(WORK); G.forkOf = B; const trG = path.join(CLAUDE, 'projects', S.encodeCwd(WORK), G.sessionId + '.jsonl'); fs.writeFileSync(trG, '{}\n');
  assert.strictEqual(channels.codeOf(G.sessionId), '', 'a copy that has long been going its own way: left as it is'); channels.remove(G.sessionId); fs.rmSync(trG);
  // running under another name when it joins another collaboration: told its own once, not at every one
  const renames = () => procs.flatMap((x) => x.p.stdin.written || []).filter((w) => JSON.stringify(w).includes('/rename ' + codeA)).length;
  cb.startedAs = 'x'; cb.state = 'idle';
  for (let k = 0; k < 2; k++) await post('/api/collab/create', { goal: 'once ' + k, bypass: false, members: [{ sessionId: B, role: 'ALPHA' }, { sessionId: TT, role: 'BETA' }] });
  assert.strictEqual(renames(), 1);
  const extra = (await get('/api/collabs')).json.collabs.filter((c) => /^once /.test(c.goal)).map((c) => c.id); for (const k of extra) await post('/api/collab/end', { id: k });
  // /clear: the conversation goes on under another id - its name, place, schedule and the name you gave it along
  {
    const to = uuid(96), pB = cb.proc; await post('/api/rename', { sessionId: B, name: '我的名字' });
    cb.proc = started.p; started.p.out({ type: 'conversation_reset', trigger: 'clear', session_id: B, new_conversation_id: uuid(95) }); started.p.out({ type: 'system', subtype: 'session_title_changed', session_id: to });
    assert.deepStrictEqual([channels.get(B), channels.get(to) === cb, channels.codeOf(to)], [null, true, codeA]);
    const now = (await get('/api/collab?id=' + id)).json; assert.deepStrictEqual(now.members.map((m) => m.sessionId), [to, TT]);
    assert.ok(fs.readFileSync(ledger, 'utf8').includes(to));
    assert.strictEqual((await get('/api/sessions')).json.sessions.find((s) => s.sessionId === to).title, '我的名字');
    await post('/api/rename', { sessionId: to, name: '' }); cb.proc = pB; B = to; cb.state = 'idle';
  }
  // ended: kept, marked; no more decisions
  assert.strictEqual((await post('/api/collab/end', { id })).status, 200);
  assert.strictEqual((await get('/api/collab?id=' + id)).json.state, 'ended');
  assert.strictEqual(channels.keepAlive(B), false, 'nor once it has ended');
  assert.strictEqual((await post('/api/collab/decide', { id, question: 'x', answer: 'y' })).status, 409);
  assert.strictEqual((await post('/api/collab/end', { id: 999 })).status, 404);
  assert.strictEqual((await post('/api/collab/create', { goal: 'again', members: [{ sessionId: B, role: 'ALPHA' }, { sessionId: TT, role: 'BETA' }] })).json.id, id + 3, 'numbered on');
  const again = (await get('/api/collab?id=' + (id + 3))).json.members.map((m) => m.name);
  assert.deepStrictEqual(again, [codeA, codeB], 'the same fixed names in the next collaboration');
  // a ledger left from an earlier database where the next one would go: skipped, not overwritten and not refused
  const leftOver = path.join(WORK, '.claude', 'collab', (id + 4) + '.md'); fs.writeFileSync(leftOver, '舊的帳本');
  const skip = await post('/api/collab/create', { goal: 'third', members: [{ sessionId: B, role: 'ALPHA' }, { sessionId: TT, role: 'BETA' }] });
  assert.deepStrictEqual([skip.status, skip.json.id, fs.readFileSync(leftOver, 'utf8')], [200, id + 5, '舊的帳本']);
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
  assert.ok(/^S\d+-GAMMA$/.test(g.name) && !written().includes('/rename ' + g.name), 'not sent while it is busy');
  ch2.state = 'idle'; await get('/api/sessions'); await new Promise((r) => setTimeout(r, 1100)); await get('/api/sessions'); await new Promise((r) => setTimeout(r, 300));
  assert.ok(written().includes('/rename ' + g.name) && written().includes('【合作 #' + busy.json.id + '】'), 'sent once it is idle');
  const left = (await get('/api/collab?id=' + busy.json.id)).json.members.find((m) => m.role === 'GAMMA');
  assert.ok(!left.pending, 'and not again');
  // /clear typed in a member's terminal: the same process, another session id just begun - the member follows; /resume, to
  // a conversation that was there before: it does not
  {
    const cid = busy.json.id, nowBeta = async () => (await get('/api/collab?id=' + cid)).json.members.find((m) => m.role === 'BETA').sessionId, look = async () => { await new Promise((r) => setTimeout(r, 1100)); await get('/api/sessions'); await get('/api/sessions'); };
    const f = fs.readdirSync(path.join(CLAUDE, 'sessions')).map((x) => path.join(CLAUDE, 'sessions', x)).find((x) => { try { return JSON.parse(fs.readFileSync(x, 'utf8')).sessionId === TT; } catch (e) { return false; } });
    const was = JSON.parse(fs.readFileSync(f, 'utf8')), as = (sid) => fs.writeFileSync(f, JSON.stringify(Object.assign({}, was, { sessionId: sid })));
    await look();
    const OLD = uuid(93), oldF = path.join(CLAUDE, 'projects', S.encodeCwd(was.cwd), OLD + '.jsonl'); fs.mkdirSync(path.dirname(oldF), { recursive: true }); fs.writeFileSync(oldF, '{}\n');
    // (one that was itself begun by clearing, long ago, and is resumed now: still not it)
    const cleared = (t) => line({ type: 'user', timestamp: new Date(t).toISOString(), message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } }) + '\n';
    fs.writeFileSync(oldF, cleared(Date.now() - 60000)); as(OLD); await look(); assert.deepStrictEqual([await nowBeta(), channels.codeOf(OLD)], [TT, '']);
    as(TT); await look();
    const T2 = uuid(94), f2 = path.join(path.dirname(oldF), T2 + '.jsonl'); as(T2); await look(); assert.strictEqual(await nowBeta(), TT, 'nothing written yet: not decided');
    fs.writeFileSync(f2, line({ type: 'mode' }) + '\n' + cleared(Date.now())); await look();
    assert.deepStrictEqual([await nowBeta(), channels.codeOf(T2)], [T2, codeB]);
  }
});

test('the mic: what was heard is tidied as it comes; through tailscale serve the device behind it is checked, Funnel never gets in', async () => {
  const seen = [], tidyCalls = [], tidyCtx = [], openaiCalls = [];
  // a stand-in for OpenAI's transcription: what it was sent, and an answer
  const fakeOpenAI = async (url, o) => { openaiCalls.push({ url, auth: o.headers.authorization, form: o.body }); return { ok: true, status: 200, json: async () => ({ text: 'git commit 一下', languages: [{ code: 'zh' }] }) }; };
  const tidy = {
    warm: () => tidyCalls.push('warm'),
    run: async (text, onDelta, context) => { tidyCalls.push(text); if (context) tidyCtx.push(context); if (text === 'bad') return { ok: false, error: '整理失敗' }; onDelta('我想'); onDelta('我想看。'); return { ok: true, text: '我想看。', ms: 900 }; },
  };
  const gate = { info: { ok: true, name: 'me.tail.ts.net' }, allows: async (a) => { seen.push(a); return a === '127.0.0.1' || a === '100.70.0.2'; }, refresh: async () => {} };
  const p2 = await freePort(); const s2 = createServer(TOKEN, p2, { channels, noTimers: true, noSchedules: true, out, gate, tidy, servedUrl: async () => 'https://me.tail.ts.net/', fetch: fakeOpenAI });
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
  // and this person's own words and corrections go with it (lib/vocab.js)
  const withTitle = tidyCtx.find((c) => c.title);
  assert.ok(Array.isArray(withTitle.words) && Array.isArray(withTitle.fixes), 'the words and corrections given to the tidying');
  assert.ok(tidyCtx.every((c) => Array.isArray(c.words)), 'with no conversation context too');
  await raw('/api/tidy', { text: '原話', context: { alts: [['a', 'b'], 'not a list'] } });
  assert.deepStrictEqual(tidyCtx[tidyCtx.length - 1].alts, [['a', 'b'], []], "the recognizer's other guesses, bounded");
  // ── the mic's own words: a project's (the conversation's folder), kept in this person's board folder ──
  for (const a of ['GET /api/vocab', 'GET /api/vocab/terms', 'POST /api/vocab', 'POST /api/voice/key', 'POST /api/transcribe']) asked.add(a);
  assert.strictEqual(JSON.parse((await raw('/api/vocab', { cwd: WORK, add: 'dapfe' })).text).ok, true);
  const learned = JSON.parse((await raw('/api/vocab', { cwd: WORK, learn: { given: '幫我哥特 commit', sent: '幫我 git commit' } })).text);
  assert.deepStrictEqual(learned.learned, [{ heard: '哥特', meant: 'git' }]);
  const list = JSON.parse((await raw('/api/vocab?cwd=' + enc(WORK))).text);
  assert.deepStrictEqual([list.words.map((w) => w.term), list.fixes.map((f) => f.heard + '>' + f.meant), list.engine, list.openaiKey, list.cwd], [['dapfe', 'git'], ['哥特>git'], 'browser', false, WORK]);
  const Vocab = require('../lib/vocab');
  assert.ok(Vocab.fileFor(WORK).startsWith(path.join(CLAUDE, 'session-board', 'vocab')) && fs.existsSync(Vocab.fileFor(WORK)), "the project's own, in this person's board folder");
  assert.ok(!fs.existsSync(path.join(CLAUDE, 'session-board', 'vocab.json')), 'not one for every folder');
  assert.deepStrictEqual(JSON.parse((await raw('/api/vocab/terms?cwd=' + enc(WORK + path.sep))).text).terms.slice(0, 2), ['dapfe', 'git'], 'the same folder however written: the same words');
  assert.deepStrictEqual(JSON.parse((await raw('/api/vocab/terms')).text).terms, [], 'no conversation, no folder: no words');
  assert.strictEqual((await raw('/api/vocab', { add: 'x' })).status, 400, 'nowhere to keep it');
  assert.strictEqual((await raw('/api/vocab', { cwd: WORK })).status, 400);
  assert.strictEqual((await raw('/api/vocab', { cwd: path.join(WORK, 'nope'), add: 'x' })).status, 400, 'a folder the board does not know');
  // the OpenAI key: checked, kept, never answered back
  assert.strictEqual((await raw('/api/transcribe', { audio: 'AAAA', mime: 'audio/webm' })).status, 409, 'no key yet');
  assert.strictEqual((await raw('/api/voice/key', { key: 'not-a-key' })).status, 400);
  const key = 'sk-' + 'x'.repeat(40);
  assert.deepStrictEqual(JSON.parse((await raw('/api/voice/key', { key })).text), { ok: true, set: true });
  assert.ok(!(await raw('/api/vocab?cwd=' + enc(WORK))).text.includes(key), 'never sent back');
  // the transcription: the recording, the words as keywords, both languages, the conversation as the prompt
  assert.strictEqual((await raw('/api/transcribe', { audio: 'AAAA', mime: 'video/x-evil' })).status, 400);
  const tr = await raw('/api/transcribe', { audio: Buffer.from('fake audio').toString('base64'), mime: 'audio/webm;codecs=opus', context: { sid: T1, cwd: WORK, title: '發版', folder: 'repo' } });
  assert.deepStrictEqual(JSON.parse(tr.text), { ok: true, text: 'git commit 一下' });
  const sentForm = openaiCalls[0].form;
  assert.strictEqual(openaiCalls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.strictEqual(openaiCalls[0].auth, 'Bearer ' + key);
  assert.strictEqual(sentForm.get('model'), 'gpt-transcribe');
  assert.ok(sentForm.getAll('keywords[]').includes('dapfe') && sentForm.getAll('keywords[]').includes('git'));
  assert.deepStrictEqual(sentForm.getAll('languages[]'), ['zh', 'en']);
  assert.strictEqual(sentForm.get('prompt'), '對話：發版 / repo');
  assert.strictEqual(sentForm.get('file').name, 'speech.webm');
  assert.deepStrictEqual(JSON.parse((await raw('/api/voice/key', { key: '' })).text), { ok: true, set: false }, 'taken away');
  assert.deepStrictEqual([withTitle.title.length, withTitle.folder, withTitle.recent.length, withTitle.recent[5].length], [200, 'repo', 6, 600]);
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

test('「有新版本，點我更新」 restart: only onto a newer version, never under a working conversation, by a detached helper that outlives the board', async () => {
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

test('a newer board is the one on GitHub (the marketplace just fetched), not the copy on this computer', async () => {
  // (asked 2026-11-21: "it is to check my GitHub repo, not only what is here")
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-boardroot-'));
  fs.mkdirSync(path.join(here, '.claude-plugin')); fs.writeFileSync(path.join(here, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '99.0.0' }));
  const VERSION = require('../.claude-plugin/plugin.json').version;
  const run = async (pm) => {
    const pp = await freePort();
    const s = createServer(TOKEN, pp, { channels, noTimers: true, noSchedules: true, out, boardRoot: here, pluginsInstalled: () => ({ 'plugin-manager': { name: 'plugin-manager', installs: [{ scope: 'user' }] } }), pluginManager: async () => pm });
    await new Promise((r) => s.listen(pp, '127.0.0.1', r));
    require('../lib/config').setValue('autoState', null);
    await s.autoTick(Date.now());
    const j = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: pp, path: '/api/auto', headers: { 'x-board-token': TOKEN } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }));
    s.close(); if (s.closeAllConnections) s.closeAllConnections();
    return j.check;
  };
  // GitHub has the running one: nothing new, though this computer's copy says 99.0.0 (changed here, not published)
  const same = await run({ checked: true, latest: { 'session-board': VERSION }, behind: [] });
  assert.deepStrictEqual([same.board.newest, same.board.from, same.need], [VERSION, 'github', false]);
  // GitHub has a newer one: said so
  const ahead = await run({ checked: true, latest: { 'session-board': '98.0.0' }, behind: [] });
  assert.deepStrictEqual([ahead.board.newest, ahead.board.from, ahead.need], ['98.0.0', 'github', true]);
  // GitHub could not be asked: the installed one, and said where it came from
  const off = await run({ checked: false, error: 'offline', latest: {}, behind: [] });
  assert.deepStrictEqual([off.board.newest, off.board.from, off.ok], ['99.0.0', 'installed', false]);
  require('../lib/config').setValue('autoState', null);
});
