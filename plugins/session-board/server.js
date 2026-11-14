'use strict';
// session-board: one local page for every Claude Code session on this machine.
// A list of sessions on the left, the conversation on the right.
// One process, no dependencies, no database, no build step.
//
// Two kinds of session appear:
//   terminal - running in a terminal window you opened. The board shows its
//              conversation and can bring its window to the front, but cannot
//              type into it.
//   board    - run by the board itself (lib/chat.js). You talk to it here.
// A session can be moved either way; it is never run in both places at once.
//
// The board starts and stops processes, so it is locked down:
//   - listens on 127.0.0.1 only;
//   - every /api call except /api/ping needs the token from
//     ~/.claude/session-board/token (the page gets it from its own URL);
//   - the Host header must be this server's own address, so a web page that
//     rebinds its DNS name to 127.0.0.1 is refused.
// This guards against other web pages in the browser. It is not a sandbox
// against other programs running as the same user: they can read the token file.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const S = require('./lib/sessions');
const { cachedHistory } = require('./lib/history');
const { Channels } = require('./lib/chat');
const W = require('./lib/warroom');
const F = require('./lib/files');
const { sessionStats } = require('./lib/stats');
const config = require('./lib/config');
const { readQuota } = require('./lib/quota');
const { Monthly, ymOf } = require('./lib/monthly');
const K = require('./lib/keep');
const autostart = require('./lib/autostart');
const Past = require('./lib/past');
const { InboxService } = require('./lib/inbox');
const { stripSignatures } = require('./lib/inbox/text');
const Notify = require('./lib/notify');

const SOURCES_OK = ['gmail', 'slack', 'teams'];
const TASK_TAIL = 256 * 1024;   // how much of the end of a background command's output is shown
const HISTORY_MAX = 3000;   // the most items of one conversation the page will be given
// What goes from a thread into a conversation. Two kinds of source, two rules
// (the user's, 2026-11-13):
//   mail (gmail)        the whole thread, every message in full, plus Gmail's own
//                       ids: the conversation can then read the original through
//                       the Gmail connector and draft a reply to it, which is how
//                       the user works on mail.
//   chat (teams, slack) only the messages picked by hand (ids). A chat thread
//                       is days of talk; which lines matter is the user's call.
// A size limit remains as a guard, not as the way of choosing: if it is hit,
// the text says what was left out.
const MAIL_TEXT_MAX = 80000, CHAT_TEXT_MAX = 30000;
// att (mail only): what InboxService.attachments() gave, or {error}. Without it nothing is said about attachments.
function inboxThreadText(t, ids, att) {
  const mail = t.source === 'gmail';
  let sigs = 0;
  // A picture pasted into a mail is, in the mail's text, only a mark ("[影像]", "[cid:…]"). Each mark is replaced by
  // where that picture is saved on this computer - by its id when the mark carries one, else by position when the
  // mail has as many marks as pictures. Done before the signatures go, so a logo's mark goes with its signature.
  const MARK = /\[(影像|圖片|圖像|image|cid:[^\]\s]+)\]/gi;
  const inline = (att && att.inline) || [];
  const loose = [];                               // pictures of a mail whose marks could not be matched
  const bodyOf = (m) => {
    if (!mail) return m.body;
    let body = m.body;
    const imgs = inline.filter((x) => 'gmail:' + x.messageId === m.source_msg_id);
    if (imgs.length) {
      const marks = body.match(MARK) || [];
      const byPlace = marks.length === imgs.length;
      let n = 0, placed = 0;
      body = body.replace(MARK, (all, k) => { const im = /^cid:/i.test(k) ? imgs.find((x) => x.cid === k.slice(4)) : byPlace ? imgs[n] : null; n++; if (im) placed++; return im ? '[圖片：' + im.path + ']' : all; });
      if (!placed) loose.push(...imgs);
    }
    const x = stripSignatures(body); sigs += x.removed; return x.text;
  };
  const size = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const picked = mail ? t.items : t.items.filter((m) => (ids || []).includes(m.id));
  if (!picked.length) return { ok: false, error: mail ? '這串信沒有內容' : '請先勾選要帶入的訊息' };
  const max = mail ? MAIL_TEXT_MAX : CHAT_TEXT_MAX;
  const lines = [];
  let used = 0;
  for (let i = picked.length - 1; i >= 0; i--) {
    const m = picked[i];
    const line = '[' + new Date(m.ts).toLocaleString('zh-TW', { hour12: false }) + '] ' + (m.direction === 'out' ? '我' : m.sender || '對方') + '：\n' + bodyOf(m);
    if (lines.length && used + line.length > max) break;
    lines.unshift(line.length > max ? line.slice(0, max) + '…（太長，後面沒有帶入）' : line); used += line.length;
  }
  const left = picked.length - lines.length;
  const name = { gmail: 'Gmail', slack: 'Slack', teams: 'Teams' }[t.source] || t.source;
  const head = [];
  let wanted = [];
  if (mail) {
    const tid = t.thread_id.replace(/^gmail:/, '');
    const lastIn = [...t.items].reverse().find((m) => m.direction === 'in') || t.items[t.items.length - 1];
    head.push('以下是一串 Gmail 信件的全文（共 ' + picked.length + ' 封' + (left ? '；太長，只帶入最近 ' + lines.length + ' 封，其餘請用 Gmail 連接器讀原信' : '') + '）。',
      '主旨：' + (t.subject || ''), '寄件者：' + (t.sender || ''),
      'Gmail 討論串編號（threadId）：' + tid, '最新一封來信的訊息編號（回覆時的 replyToMessageId）：' + String(lastIn.source_msg_id || '').replace(/^gmail:/, ''),
      '需要收件人、副本等原信細節時，請用 Gmail 連接器以上面的編號讀取原信。');
    if (sigs) head.push('信裡的簽名檔（結尾敬語、聯絡資訊、免責聲明）已移除 ' + sigs + ' 處；要看原樣請讀原信。');
    const body = lines.join('\n');
    const shown = inline.filter((x) => body.includes('[圖片：' + x.path + ']'));
    wanted = [...shown, ...loose.filter((x) => x.size > 8192)];   // unplaced ones: not the small ones, which are logos
    if (shown.length) head.push('信裡貼的圖片 ' + shown.length + ' 張已存到這台電腦，位置標在內文裡（[圖片：路徑]），請直接讀取圖檔來看。');
    if (wanted.length > shown.length) { head.push('信裡另有 ' + (wanted.length - shown.length) + ' 張圖片對不上在內文的位置：'); for (const x of wanted.slice(shown.length)) head.push('- ' + x.path); }
    if (att && att.error) head.push('附檔沒有抓到（' + att.error + '）；需要時請用 Gmail 連接器讀原信的附檔。');
    else if (att) {
      if (att.files.length) {
        head.push('附檔 ' + att.files.length + ' 個，已存到這台電腦，可以直接讀取：');
        for (const f of att.files) head.push('- ' + f.path + '（' + size(f.size) + (f.ts ? '，' + new Date(f.ts).toLocaleDateString('zh-TW') + ' 那封信' : '') + '）');
      } else head.push('這串信沒有附檔。');
      for (const k of att.skipped || []) head.push('- 沒有下載：' + k.name + '（' + k.why + '）');
    }
  } else {
    head.push('以下是從 ' + name + ' 對話「' + (t.subject || '') + '」挑出的 ' + picked.length + ' 則訊息' + (left ? '（太長，只帶入最近 ' + lines.length + ' 則）' : '') + '，不是完整對話。');
  }
  return { ok: true, text: [...head, '', ...lines, ''].join('\n'), count: lines.length, left, signatures: sigs, attachments: att && att.files ? att.files.length : 0, attachError: (att && att.error) || '', images: wanted.length, inlineWanted: wanted };
}
// The text of a thread as it is handed over, with the pictures it points at fetched. Never throws for a picture.
async function handOver(inbox, t, ids) {
  const att = await attachmentsOf(inbox, t);
  const x = inboxThreadText(t, ids, att);
  const want = x.inlineWanted || []; delete x.inlineWanted;
  if (x.ok && want.length) {
    let got = 0; try { got = await att.download(want); } catch (e) {}
    if (got < want.length) { x.text = '（信裡的圖片有 ' + (want.length - got) + ' 張沒有下載成功，內文標的路徑上可能沒有檔案）\n' + x.text; x.images = got; }
  }
  return x;
}
// The attachments of a mail thread, for inboxThreadText: never throws.
async function attachmentsOf(inbox, t) {
  if (t.source !== 'gmail') return undefined;
  try { return await inbox.attachments(t.thread_id); } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}
// What the SessionEnd hook wrote: Map of sessionId -> {reason, at}. Notes older than a month are removed.
function readEnded(dir = path.join(DATA_DIR, 'ended'), now = Date.now()) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const p = path.join(dir, n);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (now - j.at > 30 * 86400000) { fs.unlinkSync(p); continue; }
      if (typeof j.sessionId === 'string' && Number.isFinite(j.at)) out.set(j.sessionId, { reason: String(j.reason || ''), at: j.at });
    } catch (e) {}
  }
  return out;
}

const VERSION = require('./.claude-plugin/plugin.json').version;
const DATA_DIR = path.join(os.homedir(), '.claude', 'session-board');
const TOKEN_FILE = path.join(DATA_DIR, 'token');
const DEFAULT_PORT = 4317;
const HOST = '127.0.0.1';

function getToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(t)) return t;
  } catch (e) {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t + '\n');
  return t;
}

function portFromArgs(argv) {
  const i = argv.indexOf('--port');
  const v = Number(i >= 0 ? argv[i + 1] : process.env.SESSION_BOARD_PORT);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : DEFAULT_PORT;
}

function sameToken(got, token) {
  // Shape first: timingSafeEqual throws when the BYTE lengths differ, which a
  // same-length non-ASCII value would cause (seen as a 500 instead of a 401).
  if (!/^[0-9a-f]{48}$/.test(got) || got.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function powershell(script, args, timeout) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scripts', script), ...args],
      { timeout, windowsHide: true },
      (err, stdout) => resolve({ err, line: String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '' }));
  });
}

async function closeWindow(hwnd) {
  const r = await powershell('focus-window.ps1', ['-Mode', 'close', '-Hwnd', String(hwnd)], 15000);
  try { return JSON.parse(r.line); } catch (e) { return { state: 'error', error: 'no result' }; }
}

// mode: 'focus' brings the window to the front; 'find' only reports its handle.
async function focusWindow(titles, mode = 'focus') {
  const payload = Buffer.from(JSON.stringify({ titles }), 'utf8').toString('base64');
  const r = await powershell('focus-window.ps1', ['-Payload', payload, '-Mode', mode], 15000);
  try { return JSON.parse(r.line); }
  catch (e) { return { state: 'error', error: r.err ? String(r.err.message).slice(0, 200) : 'no result from focus script' }; }
}

async function pickFolder() {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const args = ['-TitleB64', b64('選擇要開新對話的資料夾')];
  const start = config.load().pickerStartDir;   // read each time: a changed setting needs no restart
  if (start) args.push('-StartB64', b64(start));
  const r = await powershell('pick-folder.ps1', args, 5 * 60 * 1000);
  try { return Buffer.from(r.line, 'base64').toString('utf8'); } catch (e) { return ''; }
}

// Windows Terminal arguments that open one conversation in a new window.
// A conversation nothing was ever said in has no transcript, and
// `claude --resume <id>` then exits with "No conversation found with session
// ID" (hit 2026-11-12 by moving a brand-new conversation to the terminal). So
// such a conversation is started fresh under the same id instead of resumed.
//
// The command is put in a small .cmd file and the window is started without
// the board's own "inside a Claude session" variables; lib/keep.js says why.
// cmd /k, not /c: the window stays when claude exits, like a window the user
// opened by hand.
function terminalArgs(sid, cwd, hasTranscript, command, dir = path.join(DATA_DIR, 'launch'), prompt = '') {
  return ['-w', 'new', '-d', cwd, 'cmd', '/k', K.writeLauncher(dir, sid, command || 'claude', hasTranscript, prompt)];
}
// What a session that was cut off is told when it is opened again.
const CONTINUE_PROMPT = '（看板自動送出）這個 session 上次是在工作進行到一半時被中斷的（電腦關機、重開機或程序被結束）。請先確認剛才做到哪裡，再接著把被中斷的工作做完。';
// No windowsHide: it is passed on as "start hidden", and the new terminal
// window then exists but cannot be seen (measured 2026-11-12).
function openTerminal(args) {
  spawn('wt.exe', args, { detached: true, stdio: 'ignore', env: K.cleanEnv(process.env) }).on('error', () => {}).unref();
}

async function commandLines(pids) {
  const r = await powershell('proc-cmdline.ps1', ['-Pids', pids.join(',')], 20000);
  try { return JSON.parse(Buffer.from(r.line, 'base64').toString('utf8')); } catch (e) { return {}; }
}

async function convertOffice(src, dst) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const r = await powershell('office-to-pdf.ps1', ['-InB64', b64(src), '-OutB64', b64(dst)], 120000);
  try { return JSON.parse(r.line); }
  catch (e) { return { ok: false, error: r.err ? 'Office 沒有在時限內完成轉換' : 'Office 沒有回應' }; }
}

const isDir = (p) => { try { return typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createServer(token, port, deps = {}) {
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const pageFile = path.join(__dirname, 'public', 'index.html');
  const page = () => fs.readFileSync(pageFile);
  const pageTag = () => { try { const st = fs.statSync(pageFile); return VERSION + ':' + st.size + ':' + Math.round(st.mtimeMs); } catch (e) { return VERSION; } };
  const channels = deps.channels || new Channels(path.join(DATA_DIR, 'channels.json'),
    { transcriptOf: (sid, cwd) => S.findTranscript(sid, cwd, S.DEFAULTS.projectsDir) });

  // Which terminal sessions come back after a restart (lib/keep.js). Only real
  // terminal windows: not background runs, and not a window that is merely
  // watching a background job (reopening that would run the job twice).
  const keeper = deps.keeper || null;
  const keepable = (s) => s.owner === 'terminal' && !s.headless && !s.parked && !!s.cwd;
  // Messages fetched from Gmail, Slack and Teams (lib/inbox). Only the real server has it: it reads the user's own accounts.
  const inbox = deps.inbox || null;
  if (inbox) { setTimeout(() => inbox.tick(), 20000).unref(); setInterval(() => inbox.tick(), 60000).unref(); }
  const pickedIds = (body) => (Array.isArray(body.messageIds) ? body.messageIds.filter((x) => Number.isInteger(x)).slice(0, 2000) : []);

  // Sessions taken off the list by hand. Kept in the database, so it survives a restart.
  const hiddenList = deps.hidden ? deps.hidden.get : () => { const v = config.value('hiddenSessions', []); return Array.isArray(v) ? v : []; };
  const setHidden = deps.hidden ? deps.hidden.set : (v) => config.setValue('hiddenSessions', v);

  // Several tabs polling at once share one scan.
  let cache = { at: 0, list: [] };
  let war = { at: 0, data: null };
  const fresh = () => { cache.at = 0; war.at = 0; };
  const sessions = () => {
    const now = Date.now();
    if (now - cache.at > 1000) {
      const views = channels.list().map((c) => ({
        sessionId: c.sessionId, cwd: c.cwd, title: c.title, status: channels.status(c), since: c.changedAt, unread: channels.unread(c),
      }));
      // A conversation process this server ended is not alive, whatever the OS
      // says: while this process still holds the child's handle, Windows
      // reports the pid as existing, and the child's registry file stays behind.
      const pidAlive = (pid) => !channels.deadPids.has(pid) && S.pidAlive(pid);
      const list = S.buildSessions({ channels: views, pidAlive }, now);
      if (keeper) for (const s of list) if (keepable(s)) s.kept = keeper.isKept(s.sessionId);
      const hidden = new Set(hiddenList());
      for (const s of list) {
        // Opened but nothing sent yet: the page keeps it out of every list (it is shown only to the one typing in it).
        if (s.owner === 'board' && channels.isEmpty) { const c = channels.get(s.sessionId); if (c && channels.isEmpty(c)) s.notStarted = true; }
        if (hidden.has(s.sessionId)) s.hidden = true;
        // The line under the name: the latest thing you said. The status line's
        // record of it where there is one, else the end of the transcript.
        // (The status line also records what Claude Code put in your place, e.g. <task-notification>: not something you said.)
        if (!s.lastUser || /^\s*</.test(s.lastUser)) { try { s.lastUser = Past.lastSaid(S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir)); } catch (e) {} }
      }
      cache = { at: now, list };
    }
    return cache.list;
  };
  const find = (sid) => { fresh(); return sessions().find((x) => x.sessionId === sid); };
  let looking = false;
  const watch = async () => {
    if (!keeper || looking) return;
    looking = true;
    try {
      const need = keeper.observe(sessions().filter(keepable).map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, pid: s.pid })), Date.now(), readEnded());
      if (need.length) {
        const lines = await commandLines(need.map((n) => n.pid));
        for (const n of need) if (lines[n.pid]) keeper.setCommand(n.sessionId, lines[n.pid]);
      }
    } catch (e) {} finally { looking = false; }
  };
  // Opens kept sessions again. to: 'terminal' (a window each, with the flags it
  // was started with) or 'board' (a conversation on this page).
  // cont: sessions that were cut off in the middle of a turn are told to pick the work up again.
  const restore = async (sids, to, cont) => {
    const done = [], failed = [], continued = [];
    for (const sid of sids) {
      const k = keeper && keeper.get(sid);
      const fail = (why) => failed.push({ sessionId: sid, title: k ? k.title : '', error: why });
      if (!k) { fail('看板沒有這個 session 的紀錄'); continue; }
      if (channels.get(sid)) { fail('它已經在看板裡了'); continue; }
      if (sessions().some((s) => s.sessionId === sid)) { fail('它已經開著了'); continue; }
      if (!isDir(k.cwd)) { fail('它的資料夾已經不存在：' + k.cwd); continue; }
      if (!S.findTranscript(sid, k.cwd, S.DEFAULTS.projectsDir)) { fail('找不到它的對話紀錄（可能已被 Claude Code 清掉）'); continue; }
      const pick = !!cont && Past.interrupted(S.findTranscript(sid, k.cwd, S.DEFAULTS.projectsDir));
      if (to === 'board') { const c = channels.create(k.cwd, sid); c.title = k.title; keeper.forget([sid]); if (pick) channels.send(sid, CONTINUE_PROMPT); }
      else { openTerminal(terminalArgs(sid, k.cwd, true, k.command, undefined, pick ? CONTINUE_PROMPT : '')); keeper.markRestoring(sid); await sleep(700); }   // one at a time: windows opened together land on top of each other
      done.push(sid);
      if (pick) continued.push(sid);
    }
    fresh();
    return { ok: true, done, failed, continued };
  };
  if (keeper) {
    // The first look tells which sessions are open now; only then is "was open last time and is not now" known.
    setTimeout(async () => {
      await watch();
      autostart.refresh(path.join(__dirname, 'scripts', 'start.js'));
      if (config.load().autoRestore) { const r = keeper.restorable(); if (r.length) await restore(r.map((x) => x.sessionId), 'terminal', config.load().autoContinue); }
    }, 3000).unref();
    setInterval(watch, 10000).unref();
    // A finished month is saved without anyone having to open it.
    setTimeout(() => monthly.ensurePrevious(), 60000).unref();
    setInterval(() => monthly.ensurePrevious(), 6 * 3600000).unref();
  }
  const monthly = deps.monthly || new Monthly();
  const statsExtra = (sid) => ({ windows: channels.modelWindows, boardUsage: channels.get(sid) });
  const quota = () => readQuota([channels.quotaSnap]);

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host || ''))) return send(res, 403, { error: 'bad host' });
      const url = new URL(req.url, `http://${HOST}:${port}`);
      const p = url.pathname;
      const q = url.searchParams;

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, page(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { app: 'session-board', version: VERSION, pid: process.pid });
      if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      // EventSource cannot set a header, so the stream alone takes the token from the query.
      const given = p === '/api/stream' ? String(q.get('t') || '') : String(req.headers['x-board-token'] || '');
      if (!sameToken(given, token)) return send(res, 401, { error: 'bad token' });

      if (req.method === 'GET') {
        // page: identifies the page file as it is on disk now. A tab that was
        // opened before the file changed sees a different value and reloads
        // itself; otherwise it keeps running old code until someone presses F5
        // (which is how "the links still are not clickable" happened, 2026-11-13).
        if (p === '/api/sessions') return send(res, 200, { now: Date.now(), version: VERSION, page: pageTag(), sessions: sessions(), inbox: inbox ? inbox.inbox.counts() : null });
        if (p === '/api/inbox') {
          if (!inbox) return send(res, 200, { threads: [], status: null });
          return send(res, 200, { threads: inbox.inbox.threads({ status: q.get('status') || '', triage: q.get('triage') || '', open: q.get('open') === '1', source: q.get('source') || '', q: String(q.get('q') || '').slice(0, 100), limit: 200 }), status: inbox.status(), routes: inbox.inbox.routes() });
        }
        if (p === '/api/inbox/thread') {
          const t = inbox && inbox.inbox.thread(String(q.get('id') || ''));
          if (!t) return send(res, 404, { error: '找不到這串訊息' });
          inbox.inbox.markSeen(t.thread_id);
          return send(res, 200, t);
        }
        if (p === '/api/messages') {
          const s = find(String(q.get('sid') || ''));
          if (!s) return send(res, 404, { error: 'session not found' });
          const file = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir);
          // max: how many items back. The page starts with the last 120 and asks for more when told to
          // ("load earlier"); never the whole file - a transcript can be hundreds of megabytes, and it is
          // read backward in pieces only as far as needed.
          const want = Number(q.get('max'));
          const max = Number.isInteger(want) ? Math.max(W.TURN_ITEMS, Math.min(want, HISTORY_MAX)) : W.TURN_ITEMS;
          const h = file ? cachedHistory(file, { max, cap: max > W.TURN_ITEMS ? 160 * 1024 * 1024 : undefined }) : { items: [], more: false };
          return send(res, 200, Object.assign({}, h, { max, limit: HISTORY_MAX }));
        }
        // A background command of a board conversation: what it is and the end of what it has printed so far.
        if (p === '/api/task') {
          const info = channels.taskInfo ? channels.taskInfo(String(q.get('sid') || ''), String(q.get('id') || '')) : null;
          if (!info) return send(res, 404, { ok: false, error: '找不到這個背景工作（可能已經結束超過 10 分鐘）' });
          let text = '', size = 0, truncated = false;
          if (info.path) {
            try {
              const st = fs.statSync(info.path); size = st.size;
              const want = Math.min(size, TASK_TAIL);
              const fd = fs.openSync(info.path, 'r');
              try { const b = Buffer.allocUnsafe(want); const n = fs.readSync(fd, b, 0, want, size - want); text = b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
              truncated = size > want;
              if (truncated) text = text.slice(text.indexOf('\n') + 1);   // start at a whole line
            } catch (e) { text = ''; info.readError = '輸出檔讀不到（可能已經被清掉）'; }
          }
          return send(res, 200, Object.assign({ ok: true, text, size, truncated }, info));
        }
        if (p === '/api/config') return send(res, 200, { config: config.load(), file: config.CONFIG_FILE, autoStart: autostart.isOn(), autoStartFile: path.join(autostart.startupDir(), autostart.NAME),
          notify: config.value('notify', true) !== false, notifyClick: Notify.isRegistered(), notifyOwnChain: Notify.ownChainPresent() });
        // Conversations of the last 30 days that are not open now, newest first; q searches title, folder and what you said first and last.
        if (p === '/api/past') {
          const exclude = new Set([...sessions().map((s) => s.sessionId), ...hiddenList()]);
          return send(res, 200, Object.assign(Past.list({ projectsDir: S.DEFAULTS.projectsDir, exclude, q: String(q.get('q') || '').slice(0, 100), limit: 600 })   /* all of them: the page lists them by folder */, { days: Past.DAYS, hidden: hiddenList().length }));
        }
        if (p === '/api/keep') {
          if (!keeper) return send(res, 200, { restorable: [], closed: [], autoContinue: true });
          // interrupted: it was in the middle of a turn when it stopped (lib/past.js).
          const mark = (x) => { let cut = false; try { const f = S.findTranscript(x.sessionId, x.cwd, S.DEFAULTS.projectsDir); cut = !!f && Past.interrupted(f); } catch (e) {} return Object.assign({}, x, { interrupted: cut }); };
          return send(res, 200, { restorable: keeper.restorable().map(mark), closed: keeper.recentlyClosed().map(mark), autoContinue: config.load().autoContinue });
        }
        if (p === '/api/commands') {
          const c = channels.get(String(q.get('sid') || ''));
          if (!c) return send(res, 404, { commands: [], error: '這不是看板裡的對話' });
          return send(res, 200, await channels.commandsFor(c.cwd));
        }
        if (p === '/api/warroom') {
          const now = Date.now();
          if (now - war.at > 2500) {
            const data = W.build(sessions(), { windows: channels.modelWindows, boardUsage: (sid) => channels.get(sid) }, now);
            data.quota = quota();
            war = { at: now, data };
          }
          return send(res, 200, war.data);
        }
        // A file mentioned in a conversation, for the preview panel. Only kinds a
        // browser displays inertly are sent, each with its exact type and nosniff:
        // an .html file goes out as text/plain, never as a page, because a page
        // served from this address could read the token.
        if (p === '/api/file') {
          const abs = F.realFile(q.get('path'));
          if (!abs) return send(res, 404, { error: '找不到這個檔案' });
          const kind = F.kindOf(abs);
          if (kind !== 'image' && kind !== 'pdf' && kind !== 'text') return send(res, 415, { error: '這種檔案不能預覽' });
          const size = fs.statSync(abs).size;
          const end = kind === 'text' ? Math.min(size, F.TEXT_LIMIT) : size;
          res.writeHead(200, { 'Content-Type': F.mimeOf(abs), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Truncated': end < size ? '1' : '0' });
          if (end === 0) return res.end();
          return fs.createReadStream(abs, { start: 0, end: end - 1 }).on('error', () => res.destroy()).pipe(res);
        }
        if (p === '/api/file/pdf') {
          const abs = F.realFile(q.get('path'));
          if (!abs || F.kindOf(abs) !== 'office') return send(res, 404, { error: '找不到這個 Office 檔案' });
          const r = await F.officePdf(abs, convertOffice);
          if (!r.ok) return send(res, 500, { error: r.error });
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return fs.createReadStream(r.file).on('error', () => res.destroy()).pipe(res);
        }
        // Figures for one conversation, shown above it: cost, tokens, compactions, context in use, ...
        if (p === '/api/stats') {
          const s = find(String(q.get('sid') || ''));
          if (!s) return send(res, 404, { error: 'session not found' });
          const file = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir);
          const items = file ? cachedHistory(file, { max: W.TURN_ITEMS }).items : [];
          return send(res, 200, Object.assign(sessionStats(s.sessionId, S.DEFAULTS.stateDir, items, statsExtra(s.sessionId)), { quota: quota() }));
        }
        if (p === '/api/quota') return send(res, 200, quota());
        // Tokens and API-equivalent cost for a calendar month, all sessions on this machine.
        if (p === '/api/usage') {
          const r = await monthly.get(String(q.get('month') || ymOf(new Date())), q.get('force') === '1');
          return send(res, r.ok ? 200 : 400, r);
        }
        if (p === '/api/stream') {
          const sid = String(q.get('sid') || '');
          if (!channels.has(sid)) return send(res, 404, { error: 'not a board conversation' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          channels.subscribe(sid, res);
          const beat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (e) {} }, 25000);
          res.on('close', () => clearInterval(beat));
          return;
        }
        return send(res, 404, { error: 'not found' });
      }

      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'json only' });
      const body = await readBody(req);
      const sid = typeof body.sessionId === 'string' ? body.sessionId : '';

      if (p === '/api/focus') {
        const s = find(sid);
        if (!s) return send(res, 404, { state: 'gone', error: 'session not running' });
        return send(res, 200, await focusWindow(s.titleCandidates));
      }
      if (p === '/api/send') {
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) return send(res, 400, { ok: false, error: 'empty message' });
        const r = channels.send(sid, text);
        fresh();
        return send(res, r.ok ? 200 : 409, r);
      }
      if (p === '/api/permission') {
        const r = channels.answer(sid, String(body.requestId || ''), body.allow === true, body.answers);
        fresh();
        return send(res, r.ok ? 200 : 404, r);
      }
      if (p === '/api/stop') { const ok = channels.stop(sid); fresh(); return send(res, 200, { ok, dropped: channels.dropped ? channels.dropped(sid) : [] }); }
      if (p === '/api/close-empty') { const ok = channels.removeIfEmpty ? channels.removeIfEmpty(sid) : false; if (ok) fresh(); return send(res, 200, { ok }); }
      if (p === '/api/unqueue') { const text = channels.unqueue(sid, Number(body.id)); return send(res, text == null ? 404 : 200, { ok: text != null, text }); }
      if (p === '/api/seen') { channels.seen(sid); fresh(); return send(res, 200, { ok: true }); }
      if (p === '/api/pick-folder') return send(res, 200, { path: await pickFolder() });
      if (p === '/api/config') {
        const patch = {};
        for (const k of ['pickerStartDir', 'autoRestore', 'autoContinue']) if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
        const r = config.save(patch);
        if (r.ok && typeof body.autoStart === 'boolean') {
          const a = autostart.set(body.autoStart, path.join(__dirname, 'scripts', 'start.js'));
          if (!a.ok) return send(res, 500, a);
        }
        // Notifications: the setting, and the address scheme a click on one goes through.
        if (r.ok && typeof body.notify === 'boolean') {
          config.setValue('notify', body.notify);
          const n = body.notify ? Notify.register(__dirname) : Notify.unregister();
          if (!n.ok) return send(res, 500, n);
        }
        return send(res, r.ok ? 200 : 400, Object.assign(r, { autoStart: autostart.isOn(), notify: config.value('notify', true) !== false, notifyClick: Notify.isRegistered() }));
      }
      if (p.startsWith('/api/inbox/')) {
        if (!inbox) return send(res, 404, { ok: false, error: '收件功能沒有啟用' });
        const id = typeof body.id === 'string' ? body.id : '';
        if (p === '/api/inbox/poll') { const r = await inbox.poll(SOURCES_OK.includes(body.source) ? body.source : undefined); return send(res, 200, Object.assign({ ok: true }, r)); }
        if (p === '/api/inbox/assign') {
          const folder = typeof body.folder === 'string' ? body.folder.trim().replace(/^["']+|["']+$/g, '') : '';
          if (folder && !isDir(folder)) return send(res, 400, { ok: false, error: '這個資料夾不存在：' + folder.slice(0, 200) });
          return send(res, 200, { ok: inbox.inbox.assign(id, folder ? path.resolve(folder) : '') });
        }
        if (p === '/api/inbox/done') return send(res, 200, { ok: inbox.inbox.setDone(id, body.done !== false) });
        if (p === '/api/inbox/route') {
          const rf = typeof body.root_folder === 'string' ? body.root_folder.trim().replace(/^["']+|["']+$/g, '') : '';
          if (rf && !isDir(rf)) return send(res, 400, { ok: false, error: '這個資料夾不存在：' + rf.slice(0, 200) });
          const r = inbox.inbox.saveRoute(Object.assign({}, body, { root_folder: rf ? path.resolve(rf) : '' }));
          return send(res, r.ok ? 200 : 400, r);
        }
        if (p === '/api/inbox/route/delete') return send(res, 200, { ok: inbox.inbox.deleteRoute(body.routeId) });
        if (p === '/api/inbox/settings') { const r = inbox.saveSettings(body || {}); return send(res, r.ok ? 200 : 400, r); }
        if (p === '/api/inbox/gmail/connect') {
          try { return send(res, 200, Object.assign({ ok: true }, await inbox.startGmailConnect())); }
          catch (e) { return send(res, 400, { ok: false, error: String(e.message || e).slice(0, 200) }); }
        }
        // The same text without starting anything: to copy into a session that is already open.
        if (p === '/api/inbox/text') {
          const t = inbox.inbox.thread(id);
          if (!t) return send(res, 404, { ok: false, error: '找不到這串訊息' });
          const x = await handOver(inbox, t, pickedIds(body));
          return send(res, x.ok ? 200 : 400, x);
        }
        // A conversation about a thread, on the board, in the thread's folder. Nothing is sent: the text goes to the input box.
        if (p === '/api/inbox/open') {
          const t = inbox.inbox.thread(id);
          if (!t) return send(res, 404, { ok: false, error: '找不到這串訊息' });
          if (!t.root_folder || !isDir(t.root_folder)) return send(res, 400, { ok: false, error: '這串訊息還沒有分派到資料夾（或資料夾已經不存在）' });
          const x = await handOver(inbox, t, pickedIds(body));
          if (!x.ok) return send(res, 400, x);
          const c = channels.create(t.root_folder);
          fresh();
          return send(res, 200, { ok: true, sessionId: c.sessionId, text: x.text, count: x.count, left: x.left, signatures: x.signatures, attachments: x.attachments, attachError: x.attachError, images: x.images });
        }
        return send(res, 404, { error: 'not found' });
      }
      if (p === '/api/hide') {
        // {clear: true} brings every hidden session back; otherwise one session is hidden or shown.
        if (body.clear === true) { setHidden([]); fresh(); return send(res, 200, { ok: true, hidden: 0 }); }
        if (!/^[0-9a-f-]{8,64}$/i.test(sid)) return send(res, 400, { ok: false, error: '沒有指定 session' });
        const cur = hiddenList().filter((x) => x !== sid);
        if (body.hidden === true) cur.push(sid);
        setHidden(cur.slice(-500));
        fresh();
        return send(res, 200, { ok: true, hidden: cur.length });
      }
      // Open a conversation that is not open now: in a terminal window, or on the board.
      if (p === '/api/past/open') {
        const d = Past.find(S.DEFAULTS.projectsDir, sid);
        if (!d) return send(res, 404, { ok: false, error: '找不到這個對話的紀錄' });
        if (sessions().some((s) => s.sessionId === sid)) return send(res, 409, { ok: false, error: '它已經開著了' });
        if (!isDir(d.cwd)) return send(res, 400, { ok: false, error: '它的資料夾已經不存在：' + d.cwd });
        if (body.to === 'board') { const c = channels.create(d.cwd, sid); c.title = d.title; if (keeper) keeper.forget([sid]); }
        else {
          const known = keeper && keeper.get(sid);
          openTerminal(terminalArgs(sid, d.cwd, true, known ? known.command : keeper ? keeper.defaultCommand(d.cwd) : 'claude'));
          if (keeper) keeper.markRestoring(sid);
        }
        fresh();
        return send(res, 200, { ok: true });
      }
      // End a terminal session from the board: its process, then its (now empty) window.
      if (p === '/api/end') {
        const s = find(sid);
        if (s && s.parked) return send(res, 409, { ok: false, error: '這個 session 是 Claude Code 的背景工作，視窗只是在看它；結束視窗裡的程序並不會停止那個工作，所以這裡不處理' });
        if (!s || s.owner !== 'terminal' || s.headless || !s.pid) return send(res, 404, { ok: false, error: '找不到這個終端機 session，或它不是在終端機視窗裡跑的' });
        // The pid about to be ended must, right now, be registered to this very session.
        const reg = S.readRegistry(S.DEFAULTS.sessionsDir).find((r) => r.sessionId === sid && r.pid === s.pid);
        if (!reg) return send(res, 409, { ok: false, error: '這個 session 剛剛變動了，分不出哪個程序是它的，所以沒有結束任何東西' });
        const win = await focusWindow(s.titleCandidates, 'find');
        try { process.kill(s.pid); } catch (e) {}
        for (let i = 0; i < 40 && S.pidAlive(s.pid); i++) await sleep(150);
        if (S.pidAlive(s.pid)) return send(res, 500, { ok: false, error: '那個程序沒有結束，請到它的視窗按兩次 Ctrl+C' });
        if (keeper) keeper.markClosed(sid, Date.now(), { cwd: s.cwd, title: s.title });
        fresh();
        let windowClosed = false;
        if (win.state === 'hit' && win.hwnd) { const r = await closeWindow(win.hwnd); windowClosed = r.state === 'closed' && !r.stillOpen; }
        return send(res, 200, { ok: true, windowClosed });
      }
      if (p === '/api/keep/set') {
        if (!keeper || !keeper.setKeep(sid, body.keep === true)) return send(res, 404, { ok: false, error: '找不到這個 session' });
        fresh();
        return send(res, 200, { ok: true, kept: keeper.isKept(sid) });
      }
      if (p === '/api/keep/restore' || p === '/api/keep/forget') {
        const sids = Array.isArray(body.sessionIds) ? body.sessionIds.filter((x) => typeof x === 'string').slice(0, 50) : [];
        if (!keeper || !sids.length) return send(res, 400, { ok: false, error: '沒有選任何 session' });
        if (p === '/api/keep/forget') return send(res, 200, { ok: true, forgotten: keeper.forget(sids) });
        return send(res, 200, await restore(sids, body.to === 'board' ? 'board' : 'terminal', body.continue === undefined ? config.load().autoContinue : body.continue === true));
      }
      if (p === '/api/files/check') {
        const s = sid ? find(sid) : null;
        return send(res, 200, { files: F.check(body.paths, s ? s.cwd : '') });
      }
      // Open with the default program. Limited to document, image and plain-data
      // types (lib/files.js OPENABLE): the path is text an AI wrote, so one click
      // must not be able to run a script or a program.
      if (p === '/api/file/open') {
        const abs = F.realFile(body.path);
        if (!abs) return send(res, 404, { ok: false, error: '找不到這個檔案' });
        if (!F.canOpen(abs)) return send(res, 400, { ok: false, error: '為了安全，這種檔案不從看板直接開啟。可以用「在檔案總管顯示」找到它' });
        spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/file/reveal') {
        // No network paths (see lib/files.js resolve).
        let abs = null;
        try { if (typeof body.path === 'string' && !F.isNetworkPath(body.path) && path.isAbsolute(body.path) && fs.existsSync(body.path)) abs = path.normalize(body.path); } catch (e) {}
        if (!abs) return send(res, 404, { ok: false, error: '找不到這個路徑' });
        const isFolder = fs.statSync(abs).isDirectory();
        spawn('explorer.exe', isFolder ? [abs] : ['/select,' + abs], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false }).on('error', () => {}).unref();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/new') {
        if (!isDir(body.cwd)) return send(res, 400, { ok: false, error: '這個資料夾不存在：' + String(body.cwd || '').slice(0, 200) });
        const c = channels.create(path.resolve(body.cwd));
        fresh();
        return send(res, 200, { ok: true, sessionId: c.sessionId });
      }
      // Terminal -> board: end the terminal's process, then run the same session here.
      if (p === '/api/takeover') {
        const s = find(sid);
        if (s && s.parked) return send(res, 409, { ok: false, error: '這個 session 是由 Claude Code 的背景服務在執行，終端機視窗只是在看它。搬過來會變成兩邊同時跑，所以不能搬' });
        if (!s || s.owner !== 'terminal' || s.headless || !s.pid) return send(res, 404, { ok: false, error: '找不到這個終端機 session，或它不是在終端機視窗裡跑的' });
        if (!isDir(s.cwd)) return send(res, 400, { ok: false, error: '這個 session 的資料夾已經不存在' });
        // Re-read the registry so the pid being ended is, right now, registered to this very session.
        const reg = S.readRegistry(S.DEFAULTS.sessionsDir).find((r) => r.sessionId === sid && r.pid === s.pid);
        if (!reg) return send(res, 409, { ok: false, error: '這個 session 剛剛變動了，請再試一次' });
        // Find its window now, while the title still identifies it; once the
        // process is gone the pane only says "process exited".
        const win = await focusWindow(s.titleCandidates, 'find');
        try { process.kill(s.pid); } catch (e) {}
        for (let i = 0; i < 40 && S.pidAlive(s.pid); i++) await sleep(150);
        if (S.pidAlive(s.pid)) return send(res, 500, { ok: false, error: '終端機裡的那個程序沒有結束，為了不讓同一個 session 兩邊同時跑，沒有接手' });
        const c = channels.create(s.cwd, sid);
        c.title = s.title;
        fresh();
        // Then close the now-empty window. Only when exactly one window matched:
        // closing the wrong window is far worse than leaving one open.
        let windowClosed = false, windowNote = '';
        if (win.state === 'hit' && win.hwnd) {
          const r = await closeWindow(win.hwnd);
          windowClosed = r.state === 'closed' && !r.stillOpen;
          if (!windowClosed) windowNote = r.state === 'closed' ? '終端機視窗裡還有其他分頁，Windows Terminal 會問你要不要一起關' : '終端機視窗沒有關成功，請自己關';
        } else windowNote = win.state === 'ambiguous' ? '有兩個以上終端機視窗標題相同，分不出是哪一個，所以沒有關視窗，請自己關' : '找不到它的終端機視窗，所以沒有關視窗';
        return send(res, 200, { ok: true, windowClosed, windowNote });
      }
      // Board -> terminal: stop running it here, open a terminal window that resumes it.
      if (p === '/api/to-terminal') {
        const c = channels.get(sid);
        if (!c) return send(res, 404, { ok: false, error: '這不是看板裡的對話' });
        if (channels.status(c) === 'busy') return send(res, 409, { ok: false, error: '它還在執行，等它做完或先按停止' });
        const cwd = c.cwd;
        const known = keeper && keeper.get(sid);
        const args = terminalArgs(sid, cwd, !!S.findTranscript(sid, cwd, S.DEFAULTS.projectsDir), known ? known.command : 'claude');
        channels.remove(sid);
        fresh();
        openTerminal(args);
        return send(res, 200, { ok: true });
      }
      // Take a conversation off the board. Its history stays on disk (claude --resume <id>).
      if (p === '/api/close') { const ok = channels.remove(sid); fresh(); return send(res, 200, { ok }); }
      if (p === '/api/shutdown') {
        // Stopping the board ends every conversation process it runs, and with
        // them any turn in progress and any background work (a restart on
        // 2026-11-12 killed a test a conversation was waiting on). So it is
        // refused while anything is active, unless explicitly forced.
        const active = channels.active();
        if (active.length && body.force !== true) return send(res, 409, { ok: false, active });
        send(res, 200, { ok: true });
        channels.shutdown();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      try { send(res, 500, { error: String(e && e.message || e).slice(0, 200) }); } catch (e2) {}
    }
  });
  server.channels = channels;
  return server;
}

if (require.main === module) {
  const port = portFromArgs(process.argv);
  const token = getToken();
  const server = createServer(token, port, { keeper: new K.Keeper(path.join(DATA_DIR, 'keep.json')), inbox: new InboxService() });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `port ${port} is already in use` : String(e));
    process.exit(1);
  });
  // A click on a notification comes back through an address scheme that points at this plugin's folder,
  // which moves with every update: written again at each start, while notifications are on.
  try { if (config.value('notify', true) !== false) Notify.register(__dirname); } catch (e) {}
  server.listen(port, HOST, () => {
    console.log(`session-board ${VERSION} listening on http://${HOST}:${port}/?t=${token}`);
  });
}

module.exports = { createServer, terminalArgs, readEnded, inboxThreadText, getToken, portFromArgs, DEFAULT_PORT, HOST, DATA_DIR, TOKEN_FILE };
