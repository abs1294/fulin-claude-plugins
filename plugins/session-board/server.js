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
const { pipeline } = require('stream');
const { execFile, spawn } = require('child_process');
// A file sent as an answer: the file is closed however the sending ends - also when the other side goes away halfway
// (.pipe() leaves the file open then, and on Windows a file left open stays locked).
const sendFile = (rs, res) => pipeline(rs, res, () => {});
// Opening to read without waiting (O_NONBLOCK where the system has it - not on Windows, where there is nothing to wait on).
const OPEN_NOWAIT = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
const S = require('./lib/sessions');
const CmdUse = require('./lib/cmduse');
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
const Sched = require('./lib/schedule');
const { Runner } = require('./lib/schedrun');
const { Watchdog, DEFAULTS: WATCH_DEFAULTS } = require('./lib/watchdog');
const Budget = require('./lib/budget');
const Keepalive = require('./lib/keepalive');
const { RESTARTING } = Keepalive;   // (the module's own path: the Keepalive of createServer's deps may be a stand-in)
const { Notices } = require('./lib/notices');
const { stripSignatures } = require('./lib/inbox/text');
const Notify = require('./lib/notify');
const Shell = require('./lib/shell');
const Changes = require('./lib/changes');
const Aside = require('./lib/aside');
const { Goal2 } = require('./lib/goal2');
const { Decider } = require('./lib/decide');
const Agents = require('./lib/agents');
const Harness = require('./lib/harness');
const Remote = require('./lib/remote');
const TidyLib = require('./lib/tidy');
const Plugins = require('./lib/plugins');
const Rooms = require('./lib/rooms');
const Collab = require('./lib/collab');
const Rewind = require('./lib/rewind');
const rewinding = new Set();   // the board conversations being carried on from an edited message right now (/api/rewind)
const { Auto, newer } = require('./lib/auto');

const SOURCES_OK = require('./lib/inbox/sources').ids;
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
  const name = (require('./lib/inbox/sources').byId(t.source) || {}).name || t.source;
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
// readEnded for a board that asks every few seconds: a folder of thousands of notes (one per session that ended - most
// started by programs) was read in full on every round, about a second of work every 10 seconds (measured 2026-11-19:
// 12,992 notes, 2.8 s of 30 s). Kept in memory instead: the folder is watched, and only the notes added or rewritten
// since (the hook rewrites a session's note when it ends again) are read. Read in full once an hour all the same - a
// change the watch missed, and the notes over a month old removed.
// The full read is done a little at a time, off to the side: read in one go it held the board for 1.3 s three seconds
// after every start (CPU profile 2026-11-19: readEnded, 12,992 files), long enough for a request to give up waiting.
// Until it is done, what was there before (nothing, the first time) is answered - only "you ended it yourself" waits.
function endedReader(dir = path.join(DATA_DIR, 'ended'), every = 3600000) {
  let all = null, at = 0, watcher = null, loading = null;
  const full = (now) => {
    if (loading) return;
    dirty.clear();   // what changes from here on is read again after this
    loading = (async () => {
      const fresh = new Map();
      let names = [];
      try { names = await fs.promises.readdir(dir); } catch (e) {}
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        const p = path.join(dir, n);
        try {
          const j = JSON.parse(await fs.promises.readFile(p, 'utf8'));
          if (now - j.at > 30 * 86400000) { await fs.promises.unlink(p).catch(() => {}); continue; }
          if (typeof j.sessionId === 'string' && Number.isFinite(j.at)) fresh.set(j.sessionId, { reason: String(j.reason || ''), at: j.at });
        } catch (e) {}
      }
      all = fresh; at = now; loading = null;
    })();
  };
  const dirty = new Set();
  const one = (n, now) => {
    const p = path.join(dir, n);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (now - j.at > 30 * 86400000) { fs.unlinkSync(p); all.delete(j.sessionId); return; }
      if (typeof j.sessionId === 'string' && Number.isFinite(j.at)) all.set(j.sessionId, { reason: String(j.reason || ''), at: j.at });
    } catch (e) { if (!fs.existsSync(p)) all.delete(n.slice(0, -5)); /* removed: forgotten at once; half written: read again when it changes */ }
  };
  const read = (now = Date.now()) => {
    if (!watcher) {
      try { fs.mkdirSync(dir, { recursive: true }); watcher = fs.watch(dir, (ev, n) => { if (n) dirty.add(String(n)); else at = 0; }); watcher.on('error', () => { watcher = null; at = 0; }); if (watcher.unref) watcher.unref(); } catch (e) { watcher = null; }
    }
    if (!all || !watcher || now - at > every) full(now);
    if (!all) return new Map();
    if (!loading) for (const n of [...dirty]) { dirty.delete(n); if (n.endsWith('.json')) one(n, now); }
    return all;
  };
  read.ready = () => loading || Promise.resolve();   // for tests: the full read under way, if any
  read.close = () => { try { if (watcher) watcher.close(); } catch (e) {} watcher = null; };
  return read;
}

const VERSION = require('./.claude-plugin/plugin.json').version;
// What a web page opened through /api/view may load from its folder: the kinds a page is made of, nothing else. No
// data files (.json, .txt, .csv, .md, .pdf): the page may not fetch (connect-src 'none'), so it could not use them, and
// served they would be readable by anyone holding the address - a page in a project's root has the project under it.
const SITE_TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
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

// The request came in on the board's own address on this computer (127.0.0.1), not on its Tailscale address - which
// is how another computer reaches it. Told by the address it ARRIVED on: a request this computer sends to its own
// Tailscale address counts as remote too, which is what it is from the page's point of view.
// Through `tailscale serve` (the https address a phone needs for its microphone): Tailscale passes the request on from
// 127.0.0.1, with the device that sent it in x-forwarded-for and its account in tailscale-user-login (measured
// 2026-11-19). Such a request is from that device, not from this computer - checked as one, and never let do what
// happens on this screen. (Those headers are believed only on a connection from this computer itself.)
const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const viaServe = (req) => LOOPBACK.test(String(req.socket.remoteAddress || '')) && !!(req.headers['tailscale-user-login'] || req.headers['x-forwarded-for'] || req.headers['tailscale-funnel-request']);
const clientAddr = (req) => (viaServe(req) ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : String(req.socket.remoteAddress || ''));
const isLocal = (req) => !viaServe(req) && LOOPBACK.test(String(req.socket.localAddress || ''));

function sameToken(got, token) {
  // Shape first: timingSafeEqual throws when the BYTE lengths differ, which a
  // same-length non-ASCII value would cause (seen as a 500 instead of a 401).
  if (!/^[0-9a-f]{48}$/.test(got) || got.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(data);
}

// The page, with a policy that lets only its own script run. The script tag is given a number made for this one
// response, and the policy names that number: a script that got into the page some other way (text of a
// conversation, a file name, a mail) has no such number and is not run. Nothing is loaded from elsewhere; a
// request may go to this board, and to an https address only to fetch a picture that was pasted as an address.
function sendPage(res, html) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const body = String(html).replace('<script>', '<script nonce="' + nonce + '">');
  const csp = ["default-src 'none'", "script-src 'nonce-" + nonce + "'", "style-src 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'self' https: data:", "frame-src blob: 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY' });
  res.end(body);
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

// macOS: the same things done with the Mac's own tools (lib/mac.js). Everything below picks its way by this.
const MAC = process.platform === 'darwin';
const Mac = MAC ? require('./lib/mac') : null;

function powershell(script, args, timeout) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scripts', script), ...args],
      { timeout, windowsHide: true },
      (err, stdout) => resolve({ err, line: String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '' }));
  });
}

async function closeWindow(hwnd) {
  if (MAC) return { state: 'error', error: 'mac: the Terminal tab is left open' };
  const r = await powershell('focus-window.ps1', ['-Mode', 'close', '-Hwnd', String(hwnd)], 15000);
  try { return JSON.parse(r.line); } catch (e) { return { state: 'error', error: 'no result' }; }
}

// mode: 'focus' brings the window to the front; 'find' only reports its handle.
// pid (with 'find'): look the window up through that process's console first; titles are then only the fallback.
async function focusWindow(titles, mode = 'focus', pid = 0) {
  // a Mac: the Terminal tab of that process (found by its tty); 'find' has nothing to close afterwards, so it is a miss
  if (MAC) return mode === 'find' ? { state: 'miss' } : Mac.focus(pid);
  const payload = Buffer.from(JSON.stringify({ titles: titles || [] }), 'utf8').toString('base64');
  const r = await powershell('focus-window.ps1', ['-Payload', payload, '-Mode', mode].concat(pid ? ['-ProcId', String(pid)] : []), 15000);
  try { return JSON.parse(r.line); }
  catch (e) { return { state: 'error', error: r.err ? String(r.err.message).slice(0, 200) : 'no result from focus script' }; }
}

async function pickFolder() {
  if (MAC) return Mac.pickFolder('選擇要開新對話的資料夾', config.load().pickerStartDir || '');
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
  if (MAC) return { mac: Mac.writeLauncher(dir, cwd, sid, command || 'claude', hasTranscript, prompt) };   // a .command file Terminal opens
  return ['-w', 'new', '-d', cwd, 'cmd', '/k', K.writeLauncher(dir, sid, command || 'claude', hasTranscript, prompt)];
}
// What a session that was cut off is told when it is opened again.
const CONTINUE_PROMPT = '（看板自動送出）這個 session 上次是在工作進行到一半時被中斷的（電腦關機、重開機或程序被結束）。請先確認剛才做到哪裡，再接著把被中斷的工作做完。';
// No windowsHide: it is passed on as "start hidden", and the new terminal
// window then exists but cannot be seen (measured 2026-11-12).
function openTerminal(args) {
  if (args && args.mac) return Mac.openTerminal(args.mac);
  spawn('wt.exe', args, { detached: true, stdio: 'ignore', env: K.cleanEnv(process.env) }).on('error', () => {}).unref();
}

async function commandLines(pids) {
  if (MAC) return Mac.commandLines(pids);
  const r = await powershell('proc-cmdline.ps1', ['-Pids', pids.join(',')], 20000);
  try { return JSON.parse(Buffer.from(r.line, 'base64').toString('utf8')); } catch (e) { return {}; }
}

async function convertOffice(src, dst) {
  if (MAC) return Mac.convertOffice(src, dst);
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const r = await powershell('office-to-pdf.ps1', ['-InB64', b64(src), '-OutB64', b64(dst)], 120000);
  try { return JSON.parse(r.line); }
  catch (e) { return { ok: false, error: r.err ? 'Office 沒有在時限內完成轉換' : 'Office 沒有回應' }; }
}

const isDir = (p) => { try { return typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything the server does outside its own process. A test hands in its own (deps.out) so that no window is opened,
// no program started, nothing written to the registry and no process ended while the routes are exercised.
const REAL_OUT = { focusWindow, closeWindow, pickFolder, openTerminal, powershell, convertOffice, spawn, autostart, Keepalive, Notify,
  kill: (pid) => process.kill(pid), exit: (code) => process.exit(code), gitRun: execFile, btw: (sid, cwd, question) => Aside.ask(sid, cwd, question, { env: K.cleanEnv(process.env) }), explain: (cwd, prompt) => Aside.explain(cwd, prompt, { env: K.cleanEnv(process.env) }), shell: (command, cwd) => Shell.run(command, cwd) };

// The next steps a conversation can be given from the board: a plugin's own command, sent into it. Offered only when
// that plugin is installed for the folder (or for the whole user); which ones fit the turn just ended is decided by
// the page (it knows what the turn did).
const NEXT = [
  { key: 'commit', plugin: 'git-commit', cmd: '/git-commit:git-commit' },
  { key: 'review', plugin: 'red-blue-review', cmd: '/red-blue-review:red-blue-review' },
  { key: 'qa', plugin: 'qa-webwright', cmd: '/qa-webwright:qa-run' },
  { key: 'deliver', plugin: 'deliver-report', cmd: '/deliver-report:deliver-report' },
  { key: 'goal', plugin: 'goal2', cmd: '/goal2:goal', min: '0.6.0' },   // bare: goal2 0.6.0 takes the goal from the conversation itself
];
const installedFor = (inst, plugin, folder) => {
  const x = inst[plugin]; if (!x || !folder) return false;
  const f = path.normalize(folder).toLowerCase();
  return x.installs.some((i) => i.scope === 'user' || (i.project && (f === path.normalize(i.project).toLowerCase() || f.startsWith(path.normalize(i.project).toLowerCase() + path.sep))));
};
const vAtLeast = (v, min) => !min || String(v || '').localeCompare(min, undefined, { numeric: true }) >= 0;
// The steps offered for a folder, from what is installed ({name: {newest, installs}}).
const nextSteps = (inst, folder) => NEXT.filter((n) => installedFor(inst, n.plugin, folder) && vAtLeast(inst[n.plugin].newest, n.min)).map((n) => ({ key: n.key, cmd: n.cmd }));

function createServer(token, port, deps = {}) {
  // eslint-disable-next-line no-shadow
  const { focusWindow, closeWindow, pickFolder, openTerminal, powershell, convertOffice, spawn, autostart, Keepalive, Notify, kill: osKill, exit: osExit, shell: runShell, gitRun, btw: askAside, explain: explainAside } = Object.assign({}, REAL_OUT, deps.out);
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  // Who may talk to the board at all: this computer, and - when reaching it through Tailscale is switched on - only the
  // devices of your own Tailscale account (lib/remote.js). Checked before anything else, the key after it.
  const gate = deps.gate || new Remote.Gate();
  const tidy = deps.tidy || new TidyLib.Tidy();   // the mic's 自動排版: one Claude kept running while it is used
  // the https address tailscale serve gives this board ('' none), asked at most once a minute
  let served = { at: 0, url: '' };
  const httpsUrl = async () => { if (Date.now() - served.at > 60000) served = { at: Date.now(), url: await (deps.servedUrl || Remote.servedUrl)(port) }; return served.url; };
  let remote = null;   // {server, ip, name} while the board also listens on this computer's Tailscale address
  const pageFile = path.join(__dirname, 'public', 'index.html');
  const page = () => fs.readFileSync(pageFile);
  const pageTag = () => { try { const st = fs.statSync(pageFile); return VERSION + ':' + st.size + ':' + Math.round(st.mtimeMs); } catch (e) { return VERSION; } };
  const channels = deps.channels || new Channels(path.join(DATA_DIR, 'channels.json'),
    { transcriptOf: (sid, cwd) => S.findTranscript(sid, cwd, S.DEFAULTS.projectsDir) });

  // Which terminal sessions come back after a restart (lib/keep.js). Only real
  // terminal windows: not background runs, and not a window that is merely
  // watching a background job (reopening that would run the job twice).
  const keeper = deps.keeper || null;
  // What is kept across a shutdown: a session you have a terminal window for. That includes one that Claude Code's
  // background service runs while your window watches it ("parked") - to you it is a session open in a terminal,
  // and nothing else brings it back after a restart (2026-11-15: the one session of that kind was the one left out).
  const keepable = (s) => s.owner === 'terminal' && !s.headless && !!s.cwd;
  // Messages fetched from Gmail, Slack and Teams (lib/inbox). Only the real server has it: it reads the user's own accounts.
  const inbox = deps.inbox || null;
  const schedules = deps.schedules || new Sched.Schedules();
  let runner = null;   // made further down, once what it needs exists
  if (inbox) { setTimeout(() => inbox.tick(), 20000).unref(); setInterval(() => inbox.tick(), 60000).unref(); }
  const pickedIds = (body) => (Array.isArray(body.messageIds) ? body.messageIds.filter((x) => Number.isInteger(x)).slice(0, 2000) : []);

  // Sessions taken off the list by hand. Kept in the database, so it survives a restart.
  const hiddenList = deps.hidden ? deps.hidden.get : () => { const v = config.value('hiddenSessions', []); return Array.isArray(v) ? v : []; };
  // After how many days with nothing new a session leaves the list by itself (the setting autoHideDays; 0 = never).
  // How often each slash command was used on this computer (lib/cmduse.js): the list of commands puts those first.
  const cmdUse = deps.cmdUse || CmdUse.create({ projectsDir: S.DEFAULTS.projectsDir });
  const TEXT_SIZES = [1, 1.15, 1.3];   // public/index.html SIZES
  // Two sizes: one for a computer (textSize), one for a touch screen - a phone, a tablet (textSizeTouch). Not set: null.
  const textSize = (key = 'textSize') => { const v = config.value(key, null); return TEXT_SIZES.includes(v) ? v : null; };
  // Settings chosen on the page and kept in the board's database (never written into the program): what each may be,
  // and its value when nothing was chosen. Read on every use, so a change counts at once.
  const isBool = (v) => typeof v === 'boolean';
  const isPaths = (v) => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 400);
  const PREFS = {
    sidebarCollapsed: { def: false, ok: isBool, why: '只能是開或關' },        // the left column folded away
    sidebarWidth: { def: 324, ok: (v) => Number.isInteger(v) && v >= 240 && v <= 640, why: '要是 240 到 640 的整數（像素）' },   // the left column's width, dragged at its edge
    sidebarShortcut: { def: true, ok: isBool, why: '只能是開或關' },          // Ctrl+B folds / unfolds it
    officeFavorites: { def: [], ok: isPaths, why: '要是資料夾路徑的清單' },    // rooms starred: shown first
    officeOrder: { def: [], ok: isPaths, why: '要是資料夾路徑的清單' },        // the order rooms were dragged into
    officeCollapseOthers: { def: false, ok: isBool, why: '只能是開或關' },    // the rooms that are not starred folded up
    hideProgramSessions: { def: false, ok: isBool, why: '只能是開或關' },     // sessions a program started (not you) kept out of the lists
    hideProgramFolders: { def: [], ok: isPaths, why: '要是資料夾路徑的清單' }, // and every session in these folders
    // collaborations: the name each member is given ({id} the collaboration, {short} the member's short name; empty =
    // the one in collab/config.json), and whether board conversations are switched to bypass when they join
    collabNamePattern: { def: '', ok: (v) => typeof v === 'string' && v.length <= 60 && !/[\r\n]/.test(v) && (v === '' || v.includes('{id}')), why: '要包含 {id}，60 字以內、一行' },
    collabBypass: { def: true, ok: isBool, why: '只能是開或關' },
    // the look (外觀 A-D), one for a phone and one for everything else; '' = not chosen: a phone D, the rest B
    skin: { def: '', ok: (v) => ['', 'a', 'b', 'c', 'd'].includes(v), why: '只能是 a、b、c、d 或空白（用預設）' },
    skinPhone: { def: '', ok: (v) => ['', 'a', 'b', 'c', 'd'].includes(v), why: '只能是 a、b、c、d 或空白（用預設）' },
    // what is said into the microphone is tidied by Claude before it stays in the box (lib/tidy.js); off = the words as heard
    voiceTidy: { def: true, ok: isBool, why: '只能是開或關' },
    decideModel: { def: 'haiku', ok: (v) => typeof v === 'string' && /^(haiku|sonnet|opus|fable|claude-[a-z0-9.-]{1,40})$/.test(v), why: '模型只能是 haiku、sonnet、opus、fable 或 claude- 開頭的名稱' },
  };
  const pref = (k) => { const v = config.value(k, PREFS[k].def); return PREFS[k].ok(v) ? v : PREFS[k].def; };
  const prefs = () => { const o = {}; for (const k of Object.keys(PREFS)) o[k] = pref(k); return o; };
  // Names given on the board (sessionId -> name): above every other title (lib/sessions.js).
  const customTitles = () => { const v = config.value('customTitles', {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  // Every conversation the board itself started, remembered after it ends: those are yours, whatever their entrypoint
  // says (the board runs Claude Code through claude -p, which records 'sdk-cli' like any program does).
  const boardStarted = () => { const v = config.value('boardStarted', []); return new Set(Array.isArray(v) ? v : []); };
  const noteBoardStarted = (ids) => {
    const known = boardStarted(); const add = ids.filter((x) => x && !known.has(x));
    if (!add.length) return;
    config.setValue('boardStarted', [...known, ...add].slice(-5000));
  };
  // Started by a program, not by you: an entrypoint other than a terminal window's ('cli'), and not one of the board's
  // own conversations (remembered since 0.4.0, or - for older ones - recognised by their first message being content
  // blocks, the form the board sends; a program's `claude -p "..."` records a plain string), nor one you named here -
  // or in a folder named in hideProgramFolders.
  const inFolders = (cwd, list) => { const f = path.normalize(String(cwd || '')).toLowerCase(); return !!cwd && list.some((x) => { const d = path.normalize(x).toLowerCase(); return f === d || f.startsWith(d + path.sep); }); };
  // The board itself runs `claude -p` (entrypoint sdk-cli, measured). Anything started through the Agent SDK
  // (sdk-ts, sdk-py: claude-mem sets CLAUDE_CODE_ENTRYPOINT="sdk-ts" in its worker) is a program's whatever form its
  // messages take - the SDK sends content blocks too, so the first-message test would let it through.
  const SDK_ONLY = /^sdk-(ts|py)$/;
  const byProgram = (sid, entry, known, blocks) => !!entry && entry !== 'cli' && entry !== 'board' && !known.has(sid) && !Object.prototype.hasOwnProperty.call(customTitles(), sid) && (SDK_ONLY.test(entry) || !blocks);
  // hideProgramFolders is its own rule ("一律不列出"): it hides whatever is in those folders, whether or not
  // hideProgramSessions is on.
  const inHiddenFolder = (cwd) => inFolders(cwd, pref('hideProgramFolders'));
  // Whether a conversation's first message was content blocks (the form the board sends): it never changes once it is
  // written, so it is read once per session - not on every poll, while the conversation keeps growing.
  const firstForm = new Map();   // transcript file -> true | false (only once a first message was found)
  // Kept by transcript file, not by session id alone: a session that comes to be written to another file (moved to
  // another folder) is read again from that file.
  const firstIsBlocks = (sid, cwd) => {
    let f = null; try { f = S.findTranscript(sid, cwd, S.DEFAULTS.projectsDir); } catch (e) {}
    if (!f) return false;
    if (firstForm.has(f)) return firstForm.get(f);
    let v = null;
    try { const e = Past.ends(f); if (typeof e.blocks === 'boolean') v = e.blocks; } catch (e) {}
    if (v === null) return false;   // nothing written yet: asked again next time
    firstForm.set(f, v); if (firstForm.size > 2000) firstForm.delete(firstForm.keys().next().value);
    return v;
  };
  const autoHideDays = () => { const v = config.value('autoHideDays', 7); return Number.isInteger(v) && v >= 0 && v <= 365 ? v : 7; };
  // One fixed question to a small model about a text (lib/decide.js): "is something left undone?" for the goal2 next step, and
  // any other question file. Which model: the setting decideModel (read on each call).
  const decider = deps.decider || new Decider({ model: () => pref('decideModel') });
  const goal2 = deps.goal2 || new Goal2({ env: K.cleanEnv(process.env) });   // the goal2 plugin's runs, through its own tool (lib/goal2.js)
  // The 外掛 page (lib/plugins.js). plugin-manager's check takes about a second: kept for five minutes; git for one.
  const pluginsCache = { pm: null, pmAt: 0, git: null, gitAt: 0 };
  // Which integrations are on (the setting 'integrations', on lib/plugins.js integrations). Asked often: kept 5 seconds.
  let integ = { at: 0, v: null };
  const integrationsNow = () => { if (!integ.v || Date.now() - integ.at > 5000) integ = { at: Date.now(), v: Plugins.integrations((deps.pluginsInstalled || Plugins.installed)(), config.value('integrations', {})) }; return integ.v; };
  const isOn = (k) => { const x = integrationsNow()[k]; return !!(x && x.on); };
  // The office's rooms: git, the last tests (qa-webwright), the code index (cbm-guard) of each folder.
  // git and the tests are read when asked (kept a minute); the index check takes about 20 s, so it runs in the
  // background, one folder at a time, and its answer is kept half an hour.
  let instCache = { at: 0, v: {} };
  const instNow = () => { if (Date.now() - instCache.at > 10000) instCache = { at: Date.now(), v: (deps.pluginsInstalled || Plugins.installed)() }; return instCache.v; };
  const nextFor = (folder) => nextSteps(instNow(), folder).filter((n) => n.key !== 'goal' || isOn('goal2'));   // goal2 switched off in the settings: not offered
  const roomCache = new Map();   // folder -> {at, git, qa}
  const cbmCache = new Map();    // folder -> {at, result} | {checking: true}
  let cbmBusy = false;
  const cbmScript = () => { const root = Plugins.rootOf('cbm-guard', (deps.pluginsInstalled || Plugins.installed)()); const f = root && path.join(root, 'scripts', 'cbm_index_freshness.py'); return f && fs.existsSync(f) ? f : null; };
  // cbm-guard is installed for a project, not for every folder: only those folders are checked
  const cbmFor = (folder) => { const inst = (deps.pluginsInstalled || Plugins.installed)()['cbm-guard']; return !!inst && inst.installs.some((x) => x.scope === 'user' || (x.project && path.normalize(x.project).toLowerCase() === path.normalize(folder).toLowerCase())); };
  const cbmNext = () => {
    if (cbmBusy) return;
    const folder = [...cbmCache.entries()].find(([, v]) => v.checking && !v.started);
    const script = cbmScript();
    if (!folder || !script) return;
    cbmBusy = true; folder[1].started = true;
    (deps.cbmCheck || Rooms.cbmCheck)(folder[0], script).then((result) => { cbmCache.set(folder[0], { at: Date.now(), result }); }).finally(() => { cbmBusy = false; cbmNext(); });
  };
  const roomFacts = async (folder) => {
    const out = {};
    let c = roomCache.get(folder);
    if (!c || Date.now() - c.at > 60000) { c = { at: Date.now(), git: isOn('git') ? await Rooms.gitOf(folder, { run: deps.pluginsRun }) : null, qa: isOn('qa') ? Rooms.qaOf(folder, { sqlite: require('node:sqlite').DatabaseSync }) : null }; roomCache.set(folder, c); }
    if (c.git) out.git = c.git;
    if (c.qa) out.qa = c.qa;
    if (isOn('cbm') && cbmFor(folder)) {
      const k = cbmCache.get(folder);
      if (k && k.result) out.cbm = Object.assign({ at: k.at }, k.result);
      if (!k || (k.result && Date.now() - k.at > 30 * 60000)) { cbmCache.set(folder, Object.assign({}, k, { checking: true, started: false })); cbmNext(); }
      if (!out.cbm) out.cbm = { checking: true };
    }
    return out;
  };
  const pluginsView = async (refresh) => {
    const inst = (deps.pluginsInstalled || Plugins.installed)();
    const on = integrationsNow();
    if (on.versions.on && (refresh || !pluginsCache.pm || Date.now() - pluginsCache.pmAt > 300000)) { pluginsCache.pm = await Plugins.pluginManager(inst, { refresh, run: deps.pluginsRun }); pluginsCache.pmAt = Date.now(); }
    if (on.git.on && (!pluginsCache.git || Date.now() - pluginsCache.gitAt > 60000)) {
      const folders = new Set(sessions().map((s) => s.cwd).filter(Boolean));
      try { for (const x of Past.list({ projectsDir: S.DEFAULTS.projectsDir, limit: 600 }).items || []) if (x.cwd) folders.add(x.cwd); } catch (e) {}
      pluginsCache.git = await Plugins.gitRepos([...folders].filter(isDir), { run: deps.pluginsRun }); pluginsCache.gitAt = Date.now();
    }
    const harnessProjects = !on.harness.on ? [] : [...new Set(((inst.harness && inst.harness.installs) || []).map((x) => x.project).filter(Boolean))].filter(isDir).map((p) => Object.assign({ folder: p, name: path.basename(p) }, Harness.stateOf(p))).filter((x) => x.installed);
    const g = on.goal2.on ? await goal2.list() : { installed: false, runs: [] };
    return {
      integrations: on,
      installed: Object.values(inst).map((x) => ({ name: x.name, version: x.newest, description: x.description, projects: x.installs.filter((i) => i.project).length, user: x.installs.some((i) => i.scope === 'user') })),
      pm: on.versions.on ? pluginsCache.pm : null, git: on.git.on ? pluginsCache.git : null, harness: harnessProjects, harnessOn: on.harness.on, daily: on.daily.on ? Plugins.dailyReport(inst) : { installed: false },
      selfHeal: on.selfHeal.on ? { installed: true, on: !fs.existsSync(Plugins.selfHealOff()) } : { installed: false },
      goal2: { installed: g.installed, runs: (g.runs || []).slice(0, 6), running: (g.runs || []).filter((x) => x.alive).length, total: (g.runs || []).length },
    };
  };
  const asideBusy = new Set();   // sessions with a side question being answered right now
  const explainBusy = new Set(); // harness suggestions (folder + id) being explained right now
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
      noteBoardStarted(views.map((v) => v.sessionId));
      const list = S.buildSessions({ channels: views, pidAlive, titles: config.value('movedTitles', {}), customTitles: customTitles() }, now);
      const known = boardStarted(), hideProg = pref('hideProgramSessions');
      for (const s of list) {
        if (inHiddenFolder(s.cwd)) { s.folderHidden = true; s.programHidden = true; }
        if (s.owner === 'board') continue;
        let blocks = false; if (s.entrypoint && s.entrypoint !== 'cli') blocks = firstIsBlocks(s.sessionId, s.cwd);
        if (byProgram(s.sessionId, s.entrypoint, known, blocks)) { s.byProgram = true; if (hideProg) s.programHidden = true; }
      }
      if (keeper) for (const s of list) if (keepable(s)) s.kept = keeper.isKept(s.sessionId);
      for (const s of list) if (s.cwd) s.next = nextFor(s.cwd);
      const hidden = new Set(hiddenList());
      const quietDays = autoHideDays(), shownAt = config.value('shownAt', {}) || {};
      for (const s of list) {
        // When anything was last written to its transcript: what "busy, but nothing has happened for a while" is told by.
        try { const f = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir); if (f) s.activeAt = Math.round(fs.statSync(f).mtimeMs); } catch (e) {}
        // Opened but nothing sent yet: the page keeps it out of every list (it is shown only to the one typing in it).
        if (s.owner === 'board' && channels.isEmpty) { const c = channels.get(s.sessionId); if (c && channels.isEmpty(c)) s.notStarted = true; if (c && c.draft) { s.draft = c.draft; if (!c.title) s.title = '草稿：' + c.draft.replace(/\s+/g, ' ').trim().slice(0, 40); } }
        if (s.owner === 'board') { const c = channels.get(s.sessionId); if (c && c.agent) s.agent = c.agent; }   // the role it runs as
        // Whether it asks before acting: what its process said (after the first message), else what it will be started with.
        if (s.owner === 'board') { const c = channels.get(s.sessionId); if (c) { s.mode = c.skipPermissions ? 'bypassPermissions' : c.mode || ''; if (!s.mode) s.modeDefault = defaultMode(); s.model = c.model || ''; s.effort = c.effort || ''; s.modelSeen = c.modelSeen || ''; } }
        if (hidden.has(s.sessionId)) s.hidden = true;
        // When you last said something in it: what the left list is ordered by (lib/past.js saidAtOf; after the first look only what was added to the transcript is read).
        try { const f = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir); if (f) s.saidAt = Past.saidAtOf(f); } catch (e) {}
        // The line under the name: the latest thing you said. The status line's
        // record of it where there is one, else the end of the transcript.
        // (The status line also records what Claude Code put in your place, e.g. <task-notification>: not something you said.)
        // Nothing new in it for a number of days (a setting; 7 unless changed, 0 = never): it leaves the list by itself.
        // "New" is anything written to its transcript, anything you said, a change of its state - or your putting it
        // back on the list (shownAt). One that is working or waiting for you is never hidden.
        if (!s.hidden && quietDays > 0 && !['busy', 'waiting', 'background'].includes(s.status)) {
          const last = Math.max(s.activeAt || 0, s.saidAt || 0, s.since || 0, Number(shownAt[s.sessionId]) || 0);
          if (last && now - last > quietDays * 86400000) { s.hidden = true; s.autoHidden = Math.floor((now - last) / 86400000); }
        }
        if (!s.lastUser || /^\s*</.test(s.lastUser)) { try { s.lastUser = Past.lastSaid(S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir)); } catch (e) {} }
      }
      cache = { at: now, list };
      try { trackCollabNames(list); } catch (e) {}   // a collaboration member whose name changed: ledger and the others told (after the list is kept: telling a member asks for it)
    }
    return cache.list;
  };
  // The permission mode Claude Code starts in on this computer, from the user's own settings (read at most once a minute).
  let dm = { at: 0, v: '' };
  const defaultMode = () => { if (Date.now() - dm.at > 60000) { let v = ''; try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')); v = String((j.permissions && j.permissions.defaultMode) || ''); } catch (e) {} dm = { at: Date.now(), v }; } return dm.v; };
  const find = (sid) => { fresh(); return sessions().find((x) => x.sessionId === sid); };
  let looking = false;
  const ended = deps.readEnded || endedReader();
  const watch = async () => {
    if (!keeper || looking) return;
    looking = true;
    try {
      const open = sessions().filter(keepable);
      const parked = new Set(open.filter((s) => s.parked).map((s) => s.sessionId));
      const need = keeper.observe(open.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, pid: s.pid })), Date.now(), ended());
      if (need.length) {
        // A parked session's process is the background worker, not what you typed to start it: it comes back the way
        // sessions in its folder are started. The others come back with their own command line.
        const lines = await commandLines(need.filter((n) => !parked.has(n.sessionId)).map((n) => n.pid));
        for (const n of need) { if (parked.has(n.sessionId)) keeper.setCommand(n.sessionId, keeper.defaultCommand(n.cwd)); else if (lines[n.pid]) keeper.setCommand(n.sessionId, lines[n.pid]); }
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
    // Each step on its own: one that fails (a registry file half written, a folder that is gone, a terminal that will not
    // open) is written to the log and the rest still happens - an error here used to end the board as it started.
    const step = async (what, fn) => { try { await fn(); } catch (e) { console.error(new Date().toISOString() + ' at start, ' + what + ' failed: ' + String((e && e.stack) || e).slice(0, 600)); } };
    setTimeout(async () => {
      await step('the first look at the sessions', () => watch());
      await step('refreshing the start-at-login file', () => autostart.refresh(path.join(__dirname, 'scripts', 'start.js')));
      await step('refreshing the keep-alive file', () => Keepalive.refresh(path.join(__dirname, 'scripts', 'start.js')));
      await step('bringing the kept sessions back', async () => { if (config.load().autoRestore) { const r = keeper.restorable(); if (r.length) await restore(r.map((x) => x.sessionId), 'terminal', config.load().autoContinue); } });
    }, 3000).unref();
    setInterval(watch, 10000).unref();
    // A finished month is saved without anyone having to open it.
    setTimeout(() => monthly.ensurePrevious(), 60000).unref();
    setTimeout(() => { monthly.addRoles().catch(() => {}); }, 120000).unref();   // months stored before there were per-role figures
    setInterval(() => monthly.ensurePrevious(), 6 * 3600000).unref();
  }
  const monthly = deps.monthly || new Monthly();
  const statsExtra = (sid) => ({ windows: channels.modelWindows, boardUsage: channels.get(sid) });
  const quota = () => readQuota([channels.quotaSnap]);

  // ── schedules: what the runner needs from the board ──
  // The mode a session runs in, from the end of its transcript ("bypassPermissions", "auto", …).
  const modeOf = (s) => {
    try {
      const f = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir); if (!f) return '';
      const size = fs.statSync(f).size, len = Math.min(size, 512 * 1024), fd = fs.openSync(f, 'r'), b = Buffer.allocUnsafe(len);
      try { fs.readSync(fd, b, 0, len, size - len); } finally { fs.closeSync(fd); }
      const m = [...b.toString('utf8').matchAll(/"type":"permission-mode","permissionMode":"([A-Za-z]+)"/g)].pop();
      return m ? m[1] : '';
    } catch (e) { return ''; }
  };
  // What became of a message handed to a session, by the mark put in it: 'delivered' when the receiver's transcript
  // holds it as a message given to its Claude, 'held' when it holds the note that the message is being kept back
  // for its user's approval, '' when neither is there yet. The mark alone proves nothing: the "held" note quotes
  // the start of the message, mark included (2026-11-15: a held message was reported as delivered that way).
  const peerSeen = (s, mark) => {
    // Read in pieces from up to 16 MB before the end: a session writes a lot after a message arrives (612 KB in
    // three minutes, measured 2026-11-15 - the line looked for was already outside a 256 KB tail), and a whole
    // transcript must never be read at once.
    let fd;
    try {
      const f = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir); if (!f) return '';
      const size = fs.statSync(f).size, PIECE = 1024 * 1024; fd = fs.openSync(f, 'r');
      const b = Buffer.allocUnsafe(PIECE); let pos = Math.max(0, size - 16 * PIECE), rest = '', held = false;
      while (pos < size) {
        const n = fs.readSync(fd, b, 0, Math.min(PIECE, size - pos), pos); if (n <= 0) break; pos += n;
        const lines = (rest + b.toString('utf8', 0, n)).split('\n'); rest = lines.pop();
        for (const line of lines) {
          if (!line.includes(mark)) continue;
          if (line.includes('"type":"user"') && line.includes('cross-session-message')) return 'delivered';
          if (line.includes('Held peer message')) held = true;
        }
      }
      return held ? 'held' : '';
    } catch (e) { return ''; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
  };
  // The permission mode a terminal session runs in: what its transcript last recorded, and for a session that
  // has not written one yet (just opened), what it was started with.
  const sessionMode = async (s) => {
    const m = modeOf(s); if (m) return m;
    const known = keeper && keeper.get && keeper.get(s.sessionId);
    let cmd = known && known.command ? known.command : '';
    if (!cmd && s.pid) { try { cmd = (await commandLines([s.pid]))[s.pid] || ''; } catch (e) {} }
    return /--dangerously-skip-permissions/.test(cmd) ? 'bypassPermissions' : '';
  };
  // Hands a message to a session that is open in a terminal. The board is not a Claude session, so it starts
  // a small one with no window whose only job is to pass the message on with Claude Code's own
  // session-to-session messaging; it is started in the same permission mode as the receiver, because a
  // receiver holds a message from a session of another mode until its user approves (measured 2026-11-14).
  // Then the receiver's transcript is watched for the mark: only that shows its Claude was given the message.
  const peer = deps.peer || (async (s, text, mark) => { const mode = await sessionMode(s); return new Promise((resolve) => {
    const name = String(s.name || '').trim();
    if (!name) return resolve({ state: 'failed', note: '那個 session 沒有可以指定的名稱' });
    if (sessions().filter((x) => x.owner === 'terminal' && String(x.name || '').trim() === name).length > 1) return resolve({ state: 'failed', note: '有兩個以上開著的 session 都叫「' + name + '」，分不出要送給哪一個' });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence']
      .concat(mode === 'bypassPermissions' ? ['--dangerously-skip-permissions'] : mode ? ['--permission-mode', mode] : []);
    let p; try { p = spawn('claude', args, { cwd: DATA_DIR, env: K.cleanEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return resolve({ state: 'failed', note: String(e.message || e).slice(0, 120) }); }
    let buf = '', sent = false, finished = false;
    const end = (r) => { if (finished) return; finished = true; clearTimeout(timer); try { p.kill(); } catch (e) {} resolve(r); };
    const timer = setTimeout(() => end({ state: 'failed', note: '代發的程序超過 90 秒沒有回應' }), 90000);
    p.on('error', (e) => end({ state: 'failed', note: String(e.message || e).slice(0, 120) }));
    p.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line.includes('tool_result') && /success\\*":\s*true/.test(line)) sent = true; } });
    p.on('exit', async () => {
      if (finished) return;
      end(sent ? { state: 'sent' } : { state: 'failed', note: '代發的程序沒有把訊息送出去' });   // whether it was taken: peerSeen, asked again on every round
    });
    p.stdin.end('用 SendMessage 工具把下面「要送的話」原封不動送給名為 ' + name + ' 的 session（to 就填 ' + name + '）。只做這一件事，不要改寫、不要加任何內容；送完只回覆工具回傳的結果。\n\n要送的話：\n' + text);
  }); });
  // Ends the terminal process of a session so that the board may carry it on, then closes its (now empty) window.
  const takeOver = async (s) => {
    const win = await focusWindow(s.titleCandidates, 'find', s.pid);   // now, while the title still identifies it
    if (s.parked) return { ok: false, error: '它由 Claude Code 的背景服務執行，搬過來會變成兩邊同時跑' };
    if (!s.pid || s.owner !== 'terminal') return { ok: false, error: '它不是開在終端機裡' };
    const reg = S.readRegistry(S.DEFAULTS.sessionsDir).find((r) => r.sessionId === s.sessionId && r.pid === s.pid);
    if (!reg) return { ok: false, error: '它剛剛變動了' };
    if (reg.status === 'busy') return { ok: false, error: '它正在執行，搬過來會中斷做到一半的工作' };
    try { osKill(s.pid); } catch (e) {}
    for (let i = 0; i < 40 && S.pidAlive(s.pid); i++) await sleep(150);
    if (S.pidAlive(s.pid)) return { ok: false, error: '終端機裡的那個程序沒有結束' };
    fresh();
    let windowClosed = false;
    if (win.state === 'hit' && win.hwnd) { const r = await closeWindow(win.hwnd); windowClosed = r.state === 'closed' && !r.stillOpen; }
    return { ok: true, windowClosed };
  };
  // ── collaborations (lib/collab.js): two or more sessions on one goal, talking to each other directly ──
  // Kept in the board's database (setting 'collabs'): [{id, goal, createdAt, folder, ledger, state, bypass,
  //   members: [{sessionId, cwd, owner, role, short, does, name (the one given), seenName (the one it has now), names}]}]
  const collabList = () => { const v = config.value('collabs', []); return Array.isArray(v) ? v.filter((c) => c && Number.isInteger(c.id) && Array.isArray(c.members)) : []; };
  const saveCollabs = (list) => config.setValue('collabs', list);
  // A member's permission mode: a board conversation by what it runs (or will run) with, a terminal session by its transcript.
  const memberMode = (m, s) => {
    if (m.owner === 'board') { const c = channels.get(m.sessionId); return c ? (c.skipPermissions ? 'bypassPermissions' : c.mode || defaultMode()) : ''; }
    return s ? modeOf(s) : '';
  };
  const collabView = (c, list) => {
    const members = c.members.map((m) => { const s = list.find((x) => x.sessionId === m.sessionId); return Object.assign({}, m, { live: !!s, status: s ? s.status : 'gone', actualName: s ? String(s.addr || s.name || '') : '', mode: memberMode(m, s), title: s ? s.title : '' }); });
    const modes = [...new Set(members.map((m) => m.mode).filter(Boolean))];
    // a live member whose mode cannot be read yet (a terminal session that has not written it): not taken as agreeing
    const modesUnknown = members.filter((m) => m.live && !m.mode).map((m) => m.role);
    return Object.assign({}, c, { members, modes, modesUnknown, modesAgree: modes.length <= 1 && !modesUnknown.length });
  };
  // A message to a member: a board conversation is written to; a terminal session is reached through Claude Code's own
  // session-to-session messaging (peer), with a mark to find it by in its transcript.
  const tellMember = async (m, text) => {
    if (m.owner === 'board') { const r = channels.send(m.sessionId, text); return r.ok ? { state: 'sent' } : { state: 'failed', note: String(r.error || '') }; }
    const s = sessions().find((x) => x.sessionId === m.sessionId);
    if (!s || !s.pid) return { state: 'failed', note: '那個終端機 session 現在沒有開著' };
    const mark = '〔合作 ' + Date.now().toString(36) + '〕';
    try { return await peer(s, text + '\n' + mark, mark); } catch (e) { return { state: 'failed', note: String((e && e.message) || e).slice(0, 120) }; }
  };
  // Every refresh: a member whose name (what the others SendMessage to) changed - the ledger's members section is
  // rewritten, and, unless it only took the name it was given, the others are told the new one.
  const trackCollabNames = (list) => {
    const all = collabList(); const told = []; let changed = false;
    for (const c of all) {
      if (c.state !== 'active') continue;
      for (const m of c.members) {
        const s = list.find((x) => x.sessionId === m.sessionId); const now = s ? String(s.addr || s.name || '') : '';
        if (!now || now === m.seenName) continue;
        const was = m.seenName || ''; m.seenName = now; m.names = [...new Set([...(Array.isArray(m.names) ? m.names : []), now])].slice(-20); changed = true;
        told.push({ c, m, was, tell: !!was && now !== m.name });
      }
    }
    // A board conversation that was busy when it joined: its name and brief were held back (written in the middle of a
    // turn, then the process restarted for the new mode, they could be lost). Sent once it is idle.
    for (const c of all) {
      if (c.state !== 'active') continue;
      for (const m of c.members) {
        if (!m.pending || m.owner !== 'board') continue;
        const ch = channels.get(m.sessionId); if (!ch) { delete m.pending; changed = true; continue; }
        if (channels.status(ch) !== 'idle') continue;
        delete m.pending; changed = true;
        channels.send(m.sessionId, '/rename ' + m.name);
        tellMember(m, Collab.briefText(c, m)).catch(() => {});
      }
    }
    if (!changed) return;
    saveCollabs(all);
    const st = Collab.settings();
    for (const { c, m, was, tell } of told) {
      // read right before the write and only the members section replaced: a member writing the ledger at the same
      // moment keeps what it wrote anywhere else (lib/collab.js writeSection re-reads under the same rule)
      try { Collab.writeSection(c.ledger, st.sections.members, Collab.membersBlock(c)); } catch (e) {}
      if (tell) { const text = Collab.renamedText(c, m, was); for (const o of c.members) if (o.sessionId !== m.sessionId) tellMember(o, text).catch(() => {}); }
    }
  };
  // A new collaboration. body: {goal, folder?, bypass?, members: [{sessionId, role, short?, does?}]} -> {status, ...}
  const createCollab = async (body) => {
    const goal = String(body.goal || '').trim().slice(0, 2000);
    if (!goal) return { status: 400, ok: false, error: '要寫共同目標' };
    const raw = Array.isArray(body.members) ? body.members : [];
    if (raw.length < 2 || raw.length > 8) return { status: 400, ok: false, error: '要選 2 到 8 個 session' };
    const list = sessions(), members = [], seen = new Set();
    for (const x of raw) {
      const id = String((x && x.sessionId) || '');
      if (!/^[0-9a-f-]{36}$/i.test(id) || seen.has(id)) return { status: 400, ok: false, error: '成員清單不對：' + id.slice(0, 40) };
      seen.add(id);
      const s = list.find((y) => y.sessionId === id);
      if (!s) return { status: 404, ok: false, error: '找不到這個 session：' + id.slice(0, 8) };
      if (s.headless) return { status: 400, ok: false, error: '「' + (s.title || id.slice(0, 8)) + '」在背景執行、沒有自己的視窗，不能加入合作' };
      let role = Collab.oneLine(x && x.role, 40) || Collab.oneLine(path.basename(s.cwd || ''), 40) || id.slice(0, 8);   // one line: no breaks or table bars in the ledger
      while (members.some((m) => m.role === role)) role += '2';
      members.push({ sessionId: id, cwd: s.cwd, owner: s.owner === 'board' ? 'board' : 'terminal', role, short: Collab.oneLine(x && x.short, 20), does: Collab.oneLine(x && x.does, 300) });
    }
    // the ledger goes in one of the members' folders (the first's unless another of theirs is chosen)
    const folder = body.folder ? String(body.folder) : members[0].cwd;
    const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
    if (!members.some((m) => samePath(m.cwd, folder)) || !isDir(folder)) return { status: 400, ok: false, error: '帳本要放在其中一個成員的資料夾' };
    const all = collabList(); const st = Collab.settings(); const pattern = pref('collabNamePattern') || st.namePattern;
    let cid = all.reduce((k, c) => Math.max(k, c.id), 0) + 1;
    for (let i = 0; i < 1000 && fs.existsSync(path.join(folder, st.ledgerDir || '.claude/collab', cid + '.md')); i++) cid++;   // ledgers left from an earlier database are kept, not reused
    for (const m of members) { let n = Collab.fixedName(pattern, cid, m.short || m.role); while (members.some((o) => o !== m && o.name === n)) n += '2'; m.name = n; m.names = []; }
    const ledger = path.join(folder, st.ledgerDir || '.claude/collab', cid + '.md');
    if (fs.existsSync(ledger)) return { status: 409, ok: false, error: '帳本檔已經存在，不覆蓋：' + ledger };
    const c = { id: cid, goal, createdAt: Date.now(), folder, ledger, members, state: 'active', bypass: body.bypass !== false };
    try { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, Collab.ledgerText(c), { flag: 'wx' }); } catch (e) { return { status: 500, ok: false, error: '帳本寫不進去：' + String(e.message || e).slice(0, 160) }; }
    all.push(c); saveCollabs(all);
    // each member: the permission mode they all need (board conversations), the name it is given, the brief
    const results = [];
    for (const m of members) {
      const r = { sessionId: m.sessionId, role: m.role, name: m.name };
      if (m.owner === 'board') {
        let later = false;
        if (c.bypass) { const b = channels.setBypass(m.sessionId, true); r.bypass = b.ok ? (b.now ? 'now' : 'after-turn') : 'failed: ' + b.error; later = b.ok && !b.now; }
        // busy: its process is restarted after this turn (the new mode) - what is written now could go with it, so the
        // name and the brief are sent once it is idle (trackCollabNames)
        if (later) { m.pending = true; r.rename = 'after-turn'; r.brief = 'after-turn'; results.push(r); continue; }
        const rn = channels.send(m.sessionId, '/rename ' + m.name); r.rename = rn.ok ? 'sent' : 'failed: ' + rn.error;
      } else r.rename = 'by-you';   // a terminal session: only its user can type /rename (a slash command in a message is not run)
      const t = await tellMember(m, Collab.briefText(c, m)); r.brief = t.state; if (t.note) r.note = t.note;
      results.push(r);
    }
    // only the 'send later' marks are written back: names tracked while the brief was being sent (seenName, names) stay
    if (members.some((m) => m.pending)) { const cur = collabList(); const i = cur.findIndex((x) => x.id === cid); if (i >= 0) { for (const cm of cur[i].members) { const m = members.find((x) => x.sessionId === cm.sessionId); if (m && m.pending) cm.pending = true; } saveCollabs(cur); } }
    fresh();
    return { status: 200, ok: true, id: cid, ledger, results };
  };
  const collabDetail = (cid) => {
    const c = collabList().find((x) => x.id === cid); if (!c) return null;
    const v = collabView(c, sessions());
    let ledgerText = ''; try { ledgerText = fs.readFileSync(c.ledger, 'utf8'); } catch (e) {}
    const files = c.members.map((m) => { let file = null; try { file = S.findTranscript(m.sessionId, m.cwd, S.DEFAULTS.projectsDir); } catch (e) {} return { role: m.role, file, name: m.name, seenName: m.seenName, names: m.names }; });   // the names: who sent a message to whom
    return Object.assign(v, {
      ledgerText, ledgerMissing: !ledgerText, open: Collab.readLedger(ledgerText, c), timeline: Collab.timeline(files),
      renameCommands: c.members.filter((m) => m.owner === 'terminal').map((m) => ({ sessionId: m.sessionId, role: m.role, command: '/rename ' + m.name, done: m.seenName === m.name })),
    });
  };
  // The user's answer to a question in the ledger: written in word for word, and every member told.
  const decideCollab = async (cid, question, answer) => {
    const all = collabList(); const c = all.find((x) => x.id === cid);
    if (!c) return { status: 404, ok: false, error: '找不到這個合作' };
    if (c.state !== 'active') return { status: 409, ok: false, error: '這個合作已經結束' };
    const q = String(question || '').trim(), a = String(answer || '').trim();
    if (!q || !a) return { status: 400, ok: false, error: '要有題目和回答' };
    if (a.length > 4000) return { status: 400, ok: false, error: '回答太長（最多 4000 字）' };
    let t; try { t = fs.readFileSync(c.ledger, 'utf8'); } catch (e) { return { status: 404, ok: false, error: '帳本檔不見了：' + c.ledger }; }
    if (!Collab.readLedger(t, c).pending.some((p) => !p.done && p.question === q)) return { status: 404, ok: false, error: '帳本「待你裁定」裡沒有這一題（或已經裁定過）' };
    fs.writeFileSync(c.ledger, Collab.answerDecision(t, q, a, Date.now()));
    const text = Collab.decisionText(c, q, a); const results = [];
    for (const m of c.members) { const r = await tellMember(m, text); results.push({ role: m.role, state: r.state, note: r.note || '' }); }
    return { status: 200, ok: true, results };
  };

  // The notification centre (lib/notices.js): what is waiting for you now, each notice open until it is over. It is
  // NOT fed by tell() below - a Windows notification says something just happened and is gone; the centre keeps a
  // state, opened and closed by the events themselves.
  const notices = deps.notices || new Notices();
  const titleOf = (sid, fallback) => { try { fresh(); const s = sessions().find((x) => x.sessionId === sid); return (s && s.title) || fallback || ''; } catch (e) { return fallback || ''; } };
  // 1. Conversations the board runs: told by lib/chat.js the moment their state changes or they are taken off.
  channels.onStatus = (c, from, to) => { if (channels.isEmpty && channels.isEmpty(c)) return; notices.status({ sessionId: c.sessionId, title: c.title || '新對話' }, from, to); };
  channels.onGone = (sid) => { notices.gone(sid); };
  // 2. Sessions in a terminal: Claude Code rewrites ~/.claude/sessions/<pid>.json whenever one changes state and
  // removes it when the session ends. The folder is watched: Windows reports each write as it happens (measured
  // 2026-11-16: new -> idle -> busy -> idle of one short turn, each within the same second). No timer looks at it.
  const reg = new Map();   // registry file -> {sid, status}
  const readReg = (f) => { try { const j = JSON.parse(fs.readFileSync(path.join(S.DEFAULTS.sessionsDir, f), 'utf8')); return j && typeof j.sessionId === 'string' ? { sid: j.sessionId, status: String(j.status || '') } : null; } catch (e) { return null; } };
  const KNOWN = new Set(['idle', 'busy', 'waiting', 'background']);
  const onRegistry = (f) => {
    if (!/^\d+\.json$/.test(String(f || ''))) return;
    const was = reg.get(f), now = readReg(f);
    if (!now) {                                            // gone, or being written: a file that is really gone ends its session
      if (was && !fs.existsSync(path.join(S.DEFAULTS.sessionsDir, f))) { reg.delete(f); if (!channels.has(was.sid)) notices.gone(was.sid); }
      return;
    }
    reg.set(f, now);
    if (channels.has(now.sid) || !KNOWN.has(now.status)) return;          // the board's own are told by 1.; a state not known here says nothing
    const from = was && was.sid === now.sid && KNOWN.has(was.status) ? was.status : '';
    if (from && from !== now.status) notices.status({ sessionId: now.sid, title: titleOf(now.sid, 'session ' + now.sid.slice(0, 8)) }, from, now.status);
  };
  const reconcile = () => { try { fresh(); return notices.reconcile(sessions()); } catch (e) { return 0; } };
  let regWatch = null;
  const watchRegistry = () => {
    try {
      for (const f of fs.readdirSync(S.DEFAULTS.sessionsDir)) if (/^\d+\.json$/.test(f)) { const r = readReg(f); if (r) reg.set(f, r); }   // how things stand, without calling any of it news
      regWatch = fs.watch(S.DEFAULTS.sessionsDir, (ev, f) => { try { onRegistry(f); } catch (e) {} });
      // A watcher can fail (the folder replaced, the system out of handles). It is set up again, and since events may
      // have been lost meanwhile, the table is checked against the sessions as they are.
      regWatch.on('error', () => { try { regWatch.close(); } catch (e) {} regWatch = null; const t = setTimeout(() => { watchRegistry(); reconcile(); }, 5000); if (t.unref) t.unref(); });
      if (regWatch.unref) regWatch.unref();
    } catch (e) { regWatch = null; }
  };
  if (!deps.noSchedules && !deps.noTimers) { watchRegistry(); const t = setTimeout(reconcile, 6000); if (t.unref) t.unref(); }   // once, at start: what ended while the board was off
  const tell = (title, text) => {
    if (config.value('notify', true) === false) return;
    if (MAC) { Mac.notify(title, text); return; }
    const b64 = (x) => Buffer.from(String(x), 'utf8').toString('base64');
    try { spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'scripts', 'toast.ps1'), '-TitleB64', b64(title), '-MsgB64', b64(text)], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch (e) {}
  };
  runner = deps.noSchedules ? null : new Runner(schedules, { goal: goal2, sessions, channels, isDir, peer, peerCheck: deps.peerCheck || peerSeen, takeOver, tell: deps.tell || tell, newId: () => crypto.randomUUID() });
  if (runner && !deps.noTimers) { const t = setInterval(() => { runner.tick(); }, 20000); if (t.unref) t.unref(); setTimeout(() => { runner.tick(); }, 4000).unref(); }
  // Sessions that stopped moving - stuck, out of quota, cut off by an error on the server's side (lib/watchdog.js):
  // told to you, and where the settings say so, asked to carry on when the cause is gone.
  const viewTickets = new Map();   // id -> {abs, office, name, exp}: see /api/view
  // Every installed plugin of this marketplace brought up to date with plugin-manager's own tool. -> {ok, summary, error}
  const updatePlugins = async () => {
    const inst = (deps.pluginsInstalled || Plugins.installed)(); const root = Plugins.rootOf('plugin-manager', inst);
    if (!root) return { ok: false, error: '這台電腦沒有裝 plugin-manager' };
    const x = await new Promise((resolve) => (deps.pluginsRun || execFile)(process.execPath, [path.join(root, 'scripts', 'update-all.js'), '--apply', '--json'], { windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, o, e) => resolve({ status: !err ? 0 : typeof err.code === 'number' ? err.code : 1, out: String(o || ''), err: String(e || (err && err.message) || '') })));
    pluginsCache.pmAt = 0;
    return Plugins.updateResult(x.out, x.status, x.err);   // its JSON has rows, not a summary: made into one there
  };
  const watchSettings = () => { const v = config.value('watchdog', {}); return Object.assign({}, WATCH_DEFAULTS, v && typeof v === 'object' ? v : {}); };
  const dog = deps.noSchedules ? null : new Watchdog({ open: (n) => notices.open(n), resolve: (kind, sid, by) => notices.close(kind + ':' + sid, by), sessions, channels, peer, peerCheck: deps.peerCheck || peerSeen, tell: deps.tell || tell, settings: watchSettings, quota,
    transcript: (s) => { try { return S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir) || ''; } catch (e) { return ''; } },
    recall: () => config.value('watchdogState', null), remember: (st) => config.setValue('watchdogState', st) });
  // The monthly budget (lib/budget.js): looked at every ten minutes against this month's figure; said once per point per month.
  const budgetCheck = async () => {
    try {
      const st = Budget.clean(config.value('budget', {})); if (!st.monthly) return;
      const now = new Date(), r = await monthly.get(ymOf(now), false);
      if (!r || !r.ok || !r.priced || !r.total) return;
      const d = Budget.decide({ month: r.month, cost: r.total.cost, day: now.getDate(), daysInMonth: r.daysInMonth, settings: st, state: config.value('budgetState', null) });
      notices.closeKind('budget', 'month over', 'budget:' + r.month + ':');   // last month's are over
      if (d.tell) {
        config.setValue('budgetState', d.state); (deps.tell || tell)(d.tell.title, d.tell.text);
        const over = d.pct >= 100;
        if (over) notices.close('budget:' + r.month + ':warn', 'superseded');
        notices.open({ key: 'budget:' + r.month + ':' + (over ? '100' : 'warn'), kind: 'budget', title: d.tell.title, text: d.tell.text });
      }
    } catch (e) {}
  };
  if (!deps.noSchedules && !deps.noTimers) { const t = setInterval(budgetCheck, 600000); if (t.unref) t.unref(); setTimeout(budgetCheck, 45000).unref(); }
  const auto = new Auto({   // always there (its switches and log); it acts only on its timer, which tests leave off
    settings: () => config.value('auto', {}),
    recall: () => config.value('autoState', null), remember: (st) => config.setValue('autoState', st),
    cbmFolders: () => { if (!isOn('cbm') || !cbmScript()) return []; const x = instNow()['cbm-guard']; return x ? [...new Set(x.installs.map((i) => i.project).filter(Boolean))].filter(isDir) : []; },
    cbmCheck: (folder) => (deps.cbmCheck || Rooms.cbmCheck)(folder, cbmScript()),
    rebuild: (fix) => (deps.rebuildIndex || Rooms.rebuildIndex)(fix),
    forget: (folder) => cbmCache.delete(folder),
    update: () => (isOn('versions') ? updatePlugins() : Promise.resolve({ ok: true, summary: '' })),
    version: () => VERSION,
    // once a day: what there is to update (read only - the marketplace asked for its newest versions), and whether the
    // board installed is newer than this one running; the page shows 「重啟更新」 only then
    check: async () => {
      const inst = instNow();
      const root = deps.boardRoot || Plugins.rootOf('session-board', inst, __dirname) || __dirname;
      let newest = VERSION; try { newest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || VERSION; } catch (e) {}
      const board = { running: VERSION, newest };
      if (!isOn('versions')) return { ok: true, behind: [], board };
      const pm = await (deps.pluginManager || Plugins.pluginManager)(inst, { refresh: true, run: deps.pluginsRun });
      return { ok: !!(pm && pm.checked), error: (pm && pm.error) || '', behind: ((pm && pm.behind) || []).map((b) => ({ name: b.name, from: b.from, to: b.to })), board };
    },
    harnessDue: () => { if (!isOn('harness')) return []; const x = instNow().harness; return x ? [...new Set(x.installs.map((i) => i.project).filter(Boolean))].filter(isDir).map((p) => ({ folder: p, name: path.basename(p), st: Harness.stateOf(p) })).filter((p) => p.st.installed && p.st.due && p.st.due.length) : []; },
    startReview: async (folder) => { try { const c = channels.create(path.resolve(folder)); const r = channels.send(c.sessionId, '/harness:review'); fresh(); return r && r.ok === false ? r : { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
    tell: (t, x) => (deps.tell || tell)(t, x),
  });
  if (!deps.noSchedules && !deps.noTimers) { const t = setInterval(() => { auto.tick(); }, 600000); if (t.unref) t.unref(); setTimeout(() => { auto.tick(); }, 90000).unref(); }
  if (dog && !deps.noTimers) { const t = setInterval(() => { dog.tick(); }, 30000); if (t.unref) t.unref(); setTimeout(() => { dog.tick(); }, 15000).unref(); }
  // The ends of every old transcript read once, a little at a time, a minute after starting: the first search (never
  // limited in time) and 「更早的」 then answer from what is remembered instead of reading a thousand files first.
  if (!deps.noTimers) setTimeout(() => { Past.listAsync({ projectsDir: S.DEFAULTS.projectsDir, days: 0, limit: 5000 }).catch(() => {}); }, 60000).unref();

  const server = http.createServer(async (req, res) => {
    try {
      // Tailscale Funnel (open to the internet, for LINE) never reaches the board itself: only its own listener (lib/line.js)
      if (req.headers['tailscale-funnel-request']) return send(res, 403, { error: 'not here' });
      // Through tailscale serve only while 「從其他裝置連線」 is on: switched off, no other device gets in, whatever
      // `tailscale serve` was left set up (it arrives on 127.0.0.1, which the switch alone does not close)
      if (viaServe(req) && config.value('remoteTailscale', false) !== true) return send(res, 403, { error: '從其他裝置連線已關閉' });
      if (!(await gate.allows(clientAddr(req)))) return send(res, 403, { error: 'not one of your devices' });
      const hostIn = String(req.headers.host || '');
      // the https address through tailscale serve: this computer's Tailscale name (on 443 none in the header; served on
      // another https port, the name and that port - the address the settings show)
      const hm = /^([^:]+)(?::(\d{1,5}))?$/.exec(hostIn);
      const servedHost = viaServe(req) && gate.info && gate.info.ok && !!gate.info.name && !!hm && hm[1].toLowerCase() === gate.info.name.toLowerCase();
      if (!allowedHosts.has(hostIn) && !servedHost) return send(res, 403, { error: 'bad host' });
      const url = new URL(req.url, `http://${HOST}:${port}`);
      const p = url.pathname;
      const q = url.searchParams;

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendPage(res, page().toString('utf8'));
      if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { app: 'session-board', version: VERSION, pid: process.pid });
      if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      // A PDF in the preview (also an Office file turned into one): the browser's PDF viewer saves what it shows under
      // the last part of its address, so it gets an address that ends in the file's name - a ticket the page asked for
      // with its token (POST /api/file/ticket): one file, ten minutes, read-only, sent inline as a PDF and nothing else.
      // An iframe cannot send the token header, and the token is never put into an address.
      if (req.method === 'GET' && p.startsWith('/api/view/')) {
        const id = p.split('/')[3] || '', t = viewTickets.get(id);
        if (!t || t.exp < Date.now()) { viewTickets.delete(id); return send(res, 404, { error: '這個預覽網址已經過期，請重新開一次預覽' }); }
        // Only from the device that asked for it: a page can send its own address anywhere (open it in a window, go to
        // another site with it in the address - no sandbox stops a page from leaving), and an address alone is not the key.
        if (t.from && t.from !== clientAddr(req)) return send(res, 404, { error: '這個預覽網址只能在開它的那台裝置上看' });
        // A web page (.html) as a page: it and what it loads from beside it (pictures, styles, scripts), from that
        // folder down only. What a page needs and nothing else is served (no file whose name or folder starts with a
        // dot: .env, .git), and the page is shut in - a sandbox with an origin of its own and no connections - so it
        // can neither read the board's key nor ask the board for anything (asked 2026-11-19: a page opened on the
        // phone showed none of its pictures).
        if (t.site) {
          let rel = ''; try { rel = decodeURIComponent(p.split('/').slice(4).join('/')); } catch (e) { return send(res, 400, { error: 'bad path' }); }
          // Plain names joined by "/" only - checked BEFORE anything touches the disk: no "\" or ":" (a "\\host\share" or
          // "C:" path reaches the network or another drive, and would send this computer's Windows sign-in to a host the
          // page names), no empty part ("///host/..."), nothing starting with "." and no 8.3 short name ("CLAUDE~2" is
          // .claude) - review 2026-11-19
          const parts = rel.split('/');
          if (!rel || /[\\:\0]/.test(rel) || parts.some((s) => !s || s.startsWith('.') || /~\d/.test(s))) return send(res, 404, { error: '找不到' });
          const want = path.resolve(t.dir, ...parts);
          const lex = path.relative(t.dir, want); if (!lex || lex.startsWith('..') || path.isAbsolute(lex)) return send(res, 404, { error: '找不到' });
          // No link (symbolic link or junction) under the page's folder is followed: where one leads cannot be judged from
          // its text (one link to another, a mapped drive, a \\host path), and finding out by following it would already
          // reach that computer. A page is made of files beside it; it does not need links.
          for (let i = 1, at = t.dir; i <= parts.length; i++) {
            at = path.join(at, parts[i - 1]);
            let ls; try { ls = fs.lstatSync(at); } catch (e) { return send(res, 404, { error: '找不到' }); }
            if (ls.isSymbolicLink()) return send(res, 404, { error: '找不到' });
          }
          let real = ''; try { real = fs.realpathSync.native(want); } catch (e) { return send(res, 404, { error: '找不到' }); }
          // and again on the real, long names: inside the folder, and nothing on the way starting with "."
          const inside = path.relative(t.dirReal, real); if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || inside.split(/[\\/]/).some((s) => s.startsWith('.'))) return send(res, 404, { error: '找不到' });
          const type = SITE_TYPES[path.extname(real).toLowerCase()];
          // Opened first, then checked to be the very file looked at: one swapped in between the checks and the reading
          // (a link put in its place) is not what gets read - the open file is, whatever its name points at afterwards.
          let fd = null, st;
          try {
            // a plain file only, looked at BEFORE opening, and opened without waiting: opening a named pipe (macOS) waits
            // for a writer and would hold the whole board (review 2026-11-19)
            if (!fs.statSync(real).isFile()) throw new Error('not a file');
            fd = fs.openSync(real, OPEN_NOWAIT); st = fs.fstatSync(fd);
            // the file's number compared as a big integer (it is past what a plain number holds exactly); the volume only
            // when both report one (on Windows the open file's does, the name's says 0 - measured 2026-11-19)
            const open = fs.fstatSync(fd, { bigint: true }), again = fs.realpathSync.native(want), named = fs.statSync(again, { bigint: true });
            if (again !== real || named.ino !== open.ino || (named.dev && open.dev && named.dev !== open.dev) || fs.lstatSync(want).isSymbolicLink()) throw new Error('changed');
            // one name only: a hard link (a second name for a file kept elsewhere - .credentials.json named x.png) looks
            // like any file and its number is that file's, so a file with more than one name is not served from a page's
            // folder (review 2026-11-19). A page's own pictures, styles and scripts have one.
            // (the page itself excepted: it is the file you opened, whatever names it has - an upload sent again after
            // 20 days is given a second name, for one)
            let isPage = false; try { isPage = real === fs.realpathSync.native(t.abs); } catch (e) {}
            if (open.nlink > 1n && !isPage) throw new Error('more than one name');
          } catch (e) { if (fd !== null) fs.closeSync(fd); return send(res, 404, { error: '找不到' }); }
          if (!type || !st.isFile() || st.size > 50 * 1024 * 1024) { fs.closeSync(fd); return send(res, 404, { error: '找不到' }); }
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "sandbox allow-scripts allow-popups; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'self'" });
          return sendFile(fs.createReadStream(null, { fd, autoClose: true }), res);
        }
        let file = t.abs;
        if (t.office) { const r = await F.officePdf(t.abs, convertOffice); if (!r.ok) return send(res, 500, { error: r.error }); file = r.file; }
        else if (!F.realFile(t.abs) || F.kindOf(t.abs) !== 'pdf') return send(res, 404, { error: '找不到這個檔案' });
        // Opened first, then checked to be the file the ticket was given for (its number taken when it was given - not a
        // file or link put in its place since), and read from what is open. (An Office file's PDF is the board's own copy.)
        let pfd = null;
        try {
          const preal = fs.realpathSync.native(file);
          if (!fs.statSync(preal).isFile()) throw new Error('not a file');   // (as above: never open a pipe)
          pfd = fs.openSync(preal, OPEN_NOWAIT);
          const open = fs.fstatSync(pfd, { bigint: true });
          if (!open.isFile() || (!t.office && t.ino && String(open.ino) !== t.ino)) throw new Error('changed');
        } catch (e) { if (pfd !== null) fs.closeSync(pfd); return send(res, 404, { error: '找不到這個檔案' }); }
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename=\"" + t.name.replace(/[^\x20-\x7e]|["\\]/g, '_') + "\"; filename*=UTF-8''" + encodeURIComponent(t.name), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return sendFile(fs.createReadStream(null, { fd: pfd, autoClose: true }), res);
      }

      // EventSource cannot set a header, so the stream alone takes the token from the query.
      const given = p === '/api/stream' ? String(q.get('t') || '') : String(req.headers['x-board-token'] || '');
      if (!sameToken(given, token)) return send(res, 401, { error: 'bad token' });

      if (req.method === 'GET') {
        // page: identifies the page file as it is on disk now. A tab that was
        // opened before the file changed sees a different value and reloads
        // itself; otherwise it keeps running old code until someone presses F5
        // (which is how "the links still are not clickable" happened, 2026-11-13).
        if (p === '/api/sessions') return send(res, 200, { now: Date.now(), version: VERSION, page: pageTag(), features: { platform: process.platform, textSize: textSize(), textSizeTouch: textSize('textSizeTouch'), prefs: prefs(), fork: config.value('showFork', false) === true, goal2: isOn('goal2') && !!goal2.root(), integrations: Object.fromEntries(Object.entries(integrationsNow()).map(([k, x]) => [k, x.on])) }, sessions: sessions(), inbox: inbox && inbox.enabled() ? inbox.inbox.counts() : null /* null: the inbox is off, the page does not show it */, noticeOpen: notices.openCount() + schedules.noticeCount(), schedNotices: schedules.noticeCount() });
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
        if (p === '/api/config') return send(res, 200, { config: config.load(), file: config.CONFIG_FILE, keepAlive: Keepalive.isOn(), keepAliveEvery: Keepalive.EVERY_MIN, autoStart: autostart.isOn(), autoStartFile: autostart.fileShown ? autostart.fileShown() : path.join(autostart.startupDir(), autostart.NAME),
          notify: config.value('notify', true) !== false, notifyClick: Notify.isRegistered(), notifyOwnChain: Notify.ownChainPresent(), showFork: config.value('showFork', false) === true, autoHideDays: autoHideDays(), prefs: prefs(), integrations: integrationsNow(),
          httpsUrl: config.value('remoteTailscale', false) === true ? await httpsUrl() : '',
          remote: Object.assign({ on: config.value('remoteTailscale', false) === true }, server.remoteState(), q.get('devices') === '1' ? { tailscale: await (deps.remoteInfo || Remote.info)() } : {}) });
        // Conversations of the last 30 days that are not open now, newest first; q searches title, folder and what you said first and last.
        if (p === '/api/past') {
          const exclude = new Set([...sessions().map((s) => s.sessionId), ...hiddenList()]);
          const known = boardStarted(), hideProg = pref('hideProgramSessions');
          const hide = q.get('programs') === '1' ? null : (d) => inHiddenFolder(d.cwd) || (hideProg && byProgram(d.sessionId, d.entry, known, d.blocks));
          const given = customTitles();
          // ?days=all: the earlier ones too (asked for on the page); a search is never limited in time (lib/past.js)
          const days = q.get('days') === 'all' ? 0 : undefined, limit = days === 0 || q.get('q') ? 5000 : 600;
          const pl = await Past.listAsync({ projectsDir: S.DEFAULTS.projectsDir, exclude, hide, names: given, q: String(q.get('q') || '').slice(0, 100), limit, days });   /* all of them: the page lists them by folder */
          for (const x of pl.items) if (given[x.sessionId]) { x.title = given[x.sessionId]; x.named = true; }   // a name given on the board, here too
          return send(res, 200, Object.assign(pl, { hidden: hiddenList().length }));
        }
        // What one tool call of a conversation actually did (lib/history.js toolDetailAt): asked for when its line is opened.
        // One picture of a message, out of the session's transcript (lib/history.js imageAt): asked for when the message is drawn.
        if (p === '/api/image') {
          const s = find(String(q.get('sid') || ''));
          if (!s) return send(res, 404, { error: 'session not found' });
          const file = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir);
          const im = file ? require('./lib/history').imageAt(file, String(q.get('id') || ''), Number(q.get('i'))) : null;
          if (!im) return send(res, 404, { error: '找不到這張圖' });
          res.writeHead(200, { 'Content-Type': im.mime, 'Content-Length': im.bytes.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
          return res.end(im.bytes);
        }
        if (p === '/api/tool') {
          const s = find(String(q.get('sid') || ''));
          if (!s) return send(res, 404, { error: 'session not found' });
          const file = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir);
          const d = file ? require('./lib/history').toolDetailAt(file, String(q.get('id') || '')) : null;
          return send(res, d ? 200 : 404, d || { error: '找不到這個動作的紀錄' });
        }
        // What a session changed (lib/changes.js): the files it edited or wrote, read out of its own transcript - and,
        // apart from that, what is uncommitted in its folder according to git, whoever changed it.
        if (p === '/api/changes' || p === '/api/changes/file' || p === '/api/changes/git' || p === '/api/changes/gitfile') {
          const s = find(String(q.get('sid') || ''));
          if (!s) return send(res, 404, { error: 'session not found' });
          if (p === '/api/changes/git') return send(res, 200, isDir(s.cwd) ? await Changes.gitChanges(s.cwd, gitRun) : { repo: false, reason: '這個 session 的資料夾已經不存在' });
          if (p === '/api/changes/gitfile') { const r = isDir(s.cwd) ? await Changes.gitFileDiff(s.cwd, String(q.get('path') || ''), gitRun) : { ok: false, error: '這個 session 的資料夾已經不存在' }; return send(res, r.ok ? 200 : 404, r); }
          const file = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir);
          if (p === '/api/changes') return send(res, 200, file ? await Changes.summary(file, s.cwd) : { files: [], adds: 0, dels: 0 });
          const d = file ? await Changes.detail(file, String(q.get('path') || '')) : null;
          return send(res, d ? 200 : 404, d || { error: '這個 session 沒有改過這個檔案' });
        }
        // Looked at: first made true to the sessions as they are (an event may have been lost), then listed.
        if (p === '/api/notices') { const fixed = reconcile(); return send(res, 200, { open: notices.openList(), closed: notices.closedList(60), schedule: schedules.notices(), reconciled: fixed }); }
        if (p === '/api/budget') return send(res, 200, { settings: Budget.clean(config.value('budget', {})), state: config.value('budgetState', null) });
        if (p === '/api/watchdog') return send(res, 200, { on: !!dog, settings: watchSettings(), log: dog ? dog.log() : [] });
        if (p === '/api/auto') {
          // a check made by another board than this one (it was restarted, by /session-board or the button): stale - not shown
          let check = auto ? auto.checked() : null;
          if (check && check.board && check.board.running && check.board.running !== VERSION) check = null;   // (asked again on the next round: lib/auto.js)
          return send(res, 200, { on: !!auto, settings: auto ? auto.settings() : {}, log: auto ? auto.log() : [], check });
        }
        // goal2's runs (lib/goal2.js): the list, and one in detail. The run is named by its id; its folder is only ever
        // the one goal2 itself listed.
        // The harness plugin's state in the folders the office shows (lib/harness.js): only folders the board itself knows
        // - those of open sessions and of the conversations of the last 30 days - and only files under their .claude/harness.
        if (p === '/api/rooms') {
          const want = String(q.get('cwd') || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 60);
          const facts = {};
          for (const w of want) if (isDir(w)) facts[w] = await roomFacts(w);
          return send(res, 200, { facts });
        }
        if (p === '/api/harness' && !isOn('harness')) return send(res, 200, { states: {} });
        if (p === '/api/harness') {
          const known = new Set(sessions().map((s) => String(s.cwd || '').toLowerCase()));
          try { for (const x of Past.list({ projectsDir: S.DEFAULTS.projectsDir, limit: 600 }).items || []) known.add(String(x.cwd || '').toLowerCase()); } catch (e) {}
          // and any folder Claude Code has kept conversations for, however old (a room shown after 「更早的」 is one):
          // known by its folder's name under the projects folder, read without opening a transcript
          const kept = new Set(); try { for (const n of fs.readdirSync(S.DEFAULTS.projectsDir)) kept.add(n.toLowerCase()); } catch (e) {}
          const want = String(q.get('cwd') || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 60);
          const states = {};
          for (const w of want) states[w] = (known.has(w.toLowerCase()) || kept.has(Past.dirKey(w))) && isDir(w) ? Harness.stateOf(w) : { installed: false };
          return send(res, 200, { states });
        }
        if (p === '/api/plugins') return send(res, 200, await pluginsView(false));
        if ((p === '/api/goals' || p === '/api/goals/status') && !isOn('goal2')) return send(res, p === '/api/goals' ? 200 : 404, p === '/api/goals' ? { installed: false, runs: [] } : { ok: false, error: 'goal2 的整合已在設定裡關閉' });
        if (p === '/api/goals') { const l = await goal2.list(); return send(res, 200, { installed: l.installed, version: l.version || '', error: l.error || '', runs: l.runs || [] }); }
        if (p === '/api/goals/status') { const r = await goal2.status(String(q.get('id') || '')); return send(res, r.ok ? 200 : 404, r); }
        // collaborations: the list, and one in full (members now, the ledger, what is open in it, the messages between them)
        if (p === '/api/collabs') { const list = sessions(); return send(res, 200, { collabs: collabList().map((c) => collabView(c, list)).reverse(), bypassDefault: pref('collabBypass') }); }
        if (p === '/api/collab') { const d = collabDetail(Number(q.get('id'))); return d ? send(res, 200, d) : send(res, 404, { ok: false, error: '找不到這個合作' }); }
        if (p === '/api/schedules') return send(res, 200, { schedules: schedules.list(), runs: !!runner, notices: schedules.notices(), log: schedules.runs(20) });
        if (p === '/api/keep') {
          if (!keeper) return send(res, 200, { restorable: [], closed: [], autoContinue: true });
          // interrupted: it was in the middle of a turn when it stopped (lib/past.js).
          const mark = (x) => { let cut = false; try { const f = S.findTranscript(x.sessionId, x.cwd, S.DEFAULTS.projectsDir); cut = !!f && Past.interrupted(f); } catch (e) {} return Object.assign({}, x, { interrupted: cut }); };
          return send(res, 200, { restorable: keeper.restorable().map(mark), closed: keeper.recentlyClosed().map(mark), autoContinue: config.load().autoContinue });
        }
        if (p === '/api/commands') {
          const c = channels.get(String(q.get('sid') || ''));
          if (!c) return send(res, 404, { commands: [], error: '這不是看板裡的對話' });
          const list = await channels.commandsFor(c.cwd);
          // the board running (not a test), not counted yet (just started): counted now and waited for, up to 5 s (measured
          // 2026-11-19: 2.1 s for 300 records) - answered with no counts, the list came in name order and stayed so
          if (cmdUse.started() && !cmdUse.countedAt()) await Promise.race([cmdUse.refresh(), new Promise((r) => { const t = setTimeout(r, 5000); if (t.unref) t.unref(); })]);
          // the board's own: Claude Code has no /btw when it runs without a terminal (lib/aside.js)
          return send(res, 200, Object.assign({}, list, { commands: [{ name: 'btw', description: '順便問一句：用這個對話的內容回答，但不記進對話（由看板提供）', argumentHint: '<要問的話>' }].concat((list.commands || []).filter((x) => x.name !== 'btw')), usage: cmdUse.usage(), counted: !cmdUse.started() || !!cmdUse.countedAt() }));
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
        // A file as it is, to be saved by the browser: what "open with the default program" becomes on another computer.
        // Any kind (a .docx, a .zip ...), up to 500 MB; never a network path (lib/files.js realFile). It is only ever sent as
        // something to save, not shown, so the browser does not run what is in it.
        if (p === '/api/file/download') {
          const abs = F.realFile(q.get('path'));
          if (!abs) return send(res, 404, { error: '找不到這個檔案' });
          const size = fs.statSync(abs).size;
          if (size > 500 * 1024 * 1024) return send(res, 413, { error: '檔案超過 500 MB，請用別的方式拿' });
          const name = path.basename(abs);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Content-Disposition': "attachment; filename=\"" + name.replace(/[^\x20-\x7e]|["\\]/g, '_') + "\"; filename*=UTF-8''" + encodeURIComponent(name), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return sendFile(fs.createReadStream(abs), res);
        }
        if (p === '/api/file') {
          const abs = F.realFile(q.get('path'));
          if (!abs) return send(res, 404, { error: '找不到這個檔案' });
          const kind = F.kindOf(abs);
          if (kind !== 'image' && kind !== 'pdf' && kind !== 'text') return send(res, 415, { error: '這種檔案不能預覽' });
          const size = fs.statSync(abs).size;
          const end = kind === 'text' ? Math.min(size, F.TEXT_LIMIT) : size;
          res.writeHead(200, { 'Content-Type': F.mimeOf(abs), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Truncated': end < size ? '1' : '0' });
          if (end === 0) return res.end();
          return sendFile(fs.createReadStream(abs, { start: 0, end: end - 1 }), res);
        }
        if (p === '/api/file/pdf') {
          const abs = F.realFile(q.get('path'));
          if (!abs || F.kindOf(abs) !== 'office') return send(res, 404, { error: '找不到這個 Office 檔案' });
          const r = await F.officePdf(abs, convertOffice);
          if (!r.ok) return send(res, 500, { error: r.error });
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return sendFile(fs.createReadStream(r.file), res);
        }
        // Figures for one conversation, shown above it: cost, tokens, compactions, context in use, ...
        if (p === '/api/stats') {
          const s = find(String(q.get('sid') || ''));
          if (!s) return send(res, 404, { error: 'session not found' });
          const file = S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir);
          const items = file ? cachedHistory(file, { max: W.TURN_ITEMS }).items : [];
          const st = sessionStats(s.sessionId, S.DEFAULTS.stateDir, items, statsExtra(s.sessionId));
          // a terminal session: what each running subagent is doing, from its transcript (lib/agents.js)
          if (s.owner === 'terminal' && file && st.agents) { try { st.agents.detail = Agents.running(file); } catch (e) {} }
          return send(res, 200, Object.assign(st, { quota: quota() }));
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
      let body = await readBody(req, p === '/api/send' || p === '/api/upload' ? 48 * 1024 * 1024 : undefined);   // a message may carry pictures; an upload, a file
      const sid = typeof body.sessionId === 'string' ? body.sessionId : '';

      // What happens on this computer's screen is not done for a request from another computer: nobody is there to see it.
      // what happens on this computer's screen - a window brought forward, opened or closed, a file opened, a folder picker -
      // is refused from another computer (to a terminal, an old conversation or a kept one opened in a terminal, a session ended,
      // a terminal session taken over by the board - its window is closed)
      const onThisScreen = ['/api/focus', '/api/pick-folder', '/api/file/open', '/api/file/reveal', '/api/to-terminal', '/api/end', '/api/takeover'].includes(p)
        || ((p === '/api/past/open' || p === '/api/keep/restore') && body.to !== 'board');
      if (onThisScreen && !isLocal(req)) return send(res, 403, { ok: false, error: '這個動作會發生在看板那台電腦的螢幕上，從別台電腦不能用' });
      if (p === '/api/focus') {
        const s = find(sid);
        if (!s) return send(res, 404, { state: 'gone', error: 'session not running' });
        return send(res, 200, await focusWindow(s.titleCandidates, 'focus', s.pid));
      }
      // A file of any kind for a message (the composer's + → 上傳檔案, or one dropped in that is not a picture): kept on
      // this computer, and its path goes into the message for Claude to read - from the phone too, where the file is not
      // on this computer otherwise. Kept under the board's own folder, not the project's (nothing of it gets committed).
      if (p === '/api/upload') {
        // cut to length first, then the dots and spaces Windows drops from the end (cut after, one could be left there and
        // the path handed back would not be the file's)
        let name = String(body.name || '').split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120).replace(/[. ]+$/, '') || 'file';
        // Windows device names - with any extension, spaces before it, the superscript digits, COM0/LPT0. Node writes them
        // all as files (it opens by the \\?\ form; tried 2026-11-19 on Windows 11 26200: CON, NUL, COM1, COM0.txt…), but
        // programs opening by the plain form cannot: PowerShell could not even remove them. The file is for Claude and
        // you to open with those, so such a name gets a "_" in front - nothing of the file is lost by it.
        if (/^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\.|$)/i.test(name)) name = '_' + name;
        const data = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : null;
        if (!data || !data.length) return send(res, 400, { ok: false, error: '檔案是空的' });
        if (data.length > 30 * 1024 * 1024) return send(res, 400, { ok: false, error: '檔案太大（上限 30 MB）' });
        const up = path.join(DATA_DIR, 'uploads'), d = new Date(), day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        // the days over a month old go: a file is for the message it was sent with, not kept for ever
        try { for (const n of fs.readdirSync(up)) if (/^\d{4}-\d{2}-\d{2}$/.test(n) && Date.now() - new Date(n + 'T00:00:00').getTime() > 30 * 86400000) fs.rmSync(path.join(up, n), { recursive: true, force: true }); } catch (e) {}
        // the same file sent again (the same bytes, whatever its name) is the one already kept: its path is handed back and
        // no second copy is made (asked 2026-11-19: "uploading the same file again reuses it, not one more file")
        const hash = (b) => crypto.createHash('sha256').update(b).digest('hex'), mine = hash(data);
        try {
          for (const d of fs.readdirSync(up).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse()) {
            for (const n of fs.readdirSync(path.join(up, d))) {
              const f = path.join(up, d, n);
              let st; try { st = fs.statSync(f); } catch (e) { continue; }
              if (!(st.isFile() && st.size === data.length && hash(fs.readFileSync(f)) === mine)) continue;
              // Kept over 20 days: it would be cleared soon after (a day folder goes at 30), and this message's path with it.
              // Not copied - given a second NAME in today's folder (a hard link: the same bytes on disk, stored once), so
              // the earlier message's path still works until its own day goes, and this one has a month from today.
              if (d !== day && Date.now() - new Date(d + 'T00:00:00').getTime() > 20 * 86400000) {
                const today = path.join(up, day); fs.mkdirSync(today, { recursive: true });
                // (linking fails if the name is taken - nothing is overwritten - and the next number is tried)
                for (let i = 1; i < 1000; i++) {
                  const to = path.join(today, i === 1 ? n : n.replace(/(\.[^.]*)?$/, '-' + i + '$1'));
                  try { fs.linkSync(f, to); } catch (e) { if (e.code === 'EEXIST') continue; break; }
                  return send(res, 200, { ok: true, path: to, size: data.length, reused: true });
                }
                break;   // cannot be linked: this day's folder is left, the older ones still looked at, and if none will do it is written anew below
              }
              return send(res, 200, { ok: true, path: f, size: data.length, reused: true });
            }
          }
        } catch (e) {}
        const dir = path.join(up, day);
        fs.mkdirSync(dir, { recursive: true });
        const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
        // never over another upload, two at once with the same name included: 'wx' fails when the file is there
        let file = null;
        for (let i = 1; i < 1000 && !file; i++) {
          const f = path.join(dir, i === 1 ? name : stem + ' (' + i + ')' + ext);
          // opened first ('wx': made here, or not at all), then written: only a file this upload made itself is removed when
          // the writing fails (a full disk) - never one that something else made by that name in the same moment
          let fd;
          try { fd = fs.openSync(f, 'wx'); } catch (e) { if (e.code === 'EEXIST') continue; return send(res, 500, { ok: false, error: '存不下來：' + e.message }); }
          // written to the end: one writeSync may write less than it was given (it says how much)
          try { for (let off = 0; off < data.length;) off += fs.writeSync(fd, data, off, data.length - off); fs.closeSync(fd); file = f; } catch (e) {
            try { fs.closeSync(fd); } catch (x) {}
            try { fs.unlinkSync(f); } catch (x) {}
            return send(res, 500, { ok: false, error: '存不下來：' + e.message });
          }
        }
        if (!file) return send(res, 500, { ok: false, error: '同名的檔太多' });
        return send(res, 200, { ok: true, path: file, size: data.length });
      }
      if (p === '/api/send') {
        const text = typeof body.text === 'string' ? body.text : '';
        // Pictures: a few, of the kinds Claude takes, each within its size limit. Refused with a reason, not dropped silently.
        const images = [];
        if (Array.isArray(body.images)) {
          if (body.images.length > 8) return send(res, 400, { ok: false, error: '一則訊息最多 8 張圖' });
          for (const x of body.images) {
            if (!x || !/^image\/(png|jpeg|gif|webp)$/.test(String(x.mime)) || typeof x.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(x.data.slice(0, 200))) return send(res, 400, { ok: false, error: '有一張圖的格式不支援（只收 PNG、JPEG、GIF、WebP）' });
            if (x.data.length > 6.9 * 1024 * 1024) return send(res, 400, { ok: false, error: '有一張圖超過 5 MB' });
            const tag = Number(x.tag);
            images.push(Number.isInteger(tag) && tag >= 1 && tag <= 99 ? { mime: String(x.mime), data: x.data, tag } : { mime: String(x.mime), data: x.data });
          }
        }
        if (!text.trim() && !images.length) return send(res, 400, { ok: false, error: 'empty message' });
        const r = channels.send(sid, text, images);
        fresh();
        return send(res, r.ok ? 200 : 409, r);
      }
      if (p === '/api/permission') {
        const r = channels.answer(sid, String(body.requestId || ''), body.allow === true, body.answers);
        fresh();
        return send(res, r.ok ? 200 : 404, r);
      }
      // A command you typed yourself (a line beginning with "!"), run in the conversation's folder as you; what it printed
      // is kept and handed to Claude with your next message, as a terminal session does (lib/shell.js).
      if (p === '/api/shell') {
        const c = channels.get(sid);
        if (!c) return send(res, 404, { ok: false, error: '這不是看板裡的對話。終端機裡的 session 請直接在它的視窗打指令' });
        const command = typeof body.command === 'string' ? body.command.trim() : '';
        if (!command) return send(res, 400, { ok: false, error: '沒有指令' });
        if (command.length > 8000) return send(res, 400, { ok: false, error: '指令太長（上限 8000 字）' });
        if (!isDir(c.cwd)) return send(res, 400, { ok: false, error: '這個對話的資料夾已經不存在：' + c.cwd });
        if (channels.setDraft) channels.setDraft(sid, '');   // run: what was in the box is done, not a draft to keep
        const r = await runShell(command, c.cwd);
        const id = channels.noteShell(sid, { command, stdout: r.stdout, stderr: r.stderr, code: r.code });
        return send(res, 200, Object.assign({}, r, { ok: true, ran: r.ok, id, cwd: c.cwd }));
      }
      // Not for Claude after all (a password was in it): what was kept is thrown away.
      if (p === '/api/shell/drop') return send(res, 200, { ok: channels.dropShell(sid, body.id === undefined ? null : Number(body.id)) });
      // The 說明 button of a harness suggestion (lib/aside.js explain): Claude says in plain words what it is, in no
      // conversation - nothing saved, so none of your sessions gains a turn and no new one is listed. The suggestion is
      // read from the folder's own list (lib/harness.js), not taken from the page; one at a time per suggestion.
      if (p === '/api/harness/explain') {
        if (!isOn('harness')) return send(res, 409, { ok: false, error: 'harness 的整合已在設定裡關閉' });
        const cwd = typeof body.cwd === 'string' ? body.cwd : '';
        if (!isDir(cwd)) return send(res, 400, { ok: false, error: '這個專案資料夾不存在' });
        const st = Harness.stateOf(cwd);
        const x = st.installed && st.pending.find((y) => y.id === String(body.id || ''));
        if (!x) return send(res, 404, { ok: false, error: '找不到這筆建議（可能已經核可或駁回了）' });
        const key = cwd + '\n' + x.id;
        if (explainBusy.has(key)) return send(res, 409, { ok: false, error: '這筆的說明還在寫，等它回來' });
        explainBusy.add(key);
        let r; try { r = await explainAside(cwd, Aside.explainPrompt(x, Array.isArray(body.before) ? body.before : [])); } catch (e) { r = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; } finally { explainBusy.delete(key); }
        return send(res, r.ok ? 200 : 502, r);
      }
      // A question on the side (lib/aside.js): any session that has a transcript, also a terminal one and a busy one.
      if (p === '/api/btw') {
        const s = find(sid);
        if (!s) return send(res, 404, { ok: false, error: '找不到這個 session' });
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question) return send(res, 400, { ok: false, error: '「/btw」後面要接你想順便問的話' });
        if (question.length > Aside.QUESTION_MAX) return send(res, 400, { ok: false, error: '問題太長（上限 ' + Aside.QUESTION_MAX + ' 字）' });
        if (!S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir)) return send(res, 400, { ok: false, error: '這個對話還沒有內容，沒有東西可以拿來回答' });
        if (!isDir(s.cwd)) return send(res, 400, { ok: false, error: '這個 session 的資料夾已經不存在：' + s.cwd });
        if (asideBusy.has(sid)) return send(res, 409, { ok: false, error: '上一個順便問的還在回答，等它回來再問' });
        asideBusy.add(sid);
        let r; try { r = await askAside(sid, s.cwd, question); } catch (e) { r = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; } finally { asideBusy.delete(sid); }
        return send(res, r.ok ? 200 : 502, r);
      }
      // Plugins (lib/plugins.js): check again (asks the marketplace for its newest versions), bring everything up to date
      // (plugin-manager's update-all.js --apply: what /plugin-manager-update does after you approve its list), self-heal on/off.
      if ((p === '/api/goals/start' || p === '/api/goals/stop') && !isOn('goal2')) return send(res, 409, { ok: false, error: 'goal2 的整合已在設定裡關閉' });
      if (p === '/api/plugins/update' && !isOn('versions')) return send(res, 409, { ok: false, error: '版本檢查的整合已在設定裡關閉' });
      if (p === '/api/plugins/self-heal' && !isOn('selfHeal')) return send(res, 409, { ok: false, error: 'self-heal 的整合已在設定裡關閉' });
      // the daily report switched on for one project (lib/plugins.js enableDaily): only a project deliver-report is installed for
      if (p === '/api/daily/enable') {
        if (!isOn('daily')) return send(res, 409, { ok: false, error: '日報的整合已在設定裡關閉' });
        const d = Plugins.dailyReport((deps.pluginsInstalled || Plugins.installed)());
        const proj = d.could.find((x) => path.normalize(x).toLowerCase() === path.normalize(String(body.project || '')).toLowerCase());
        if (!proj) return send(res, 404, { ok: false, error: '這個專案沒有裝 deliver-report，或已經啟用了' });
        const r = Plugins.enableDaily(proj, body.recipients, body.cc);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (p === '/api/plugins/refresh') return send(res, 200, await pluginsView(true));
      if (p === '/api/plugins/update') {
        const inst = (deps.pluginsInstalled || Plugins.installed)(); const root = Plugins.rootOf('plugin-manager', inst);
        if (!root) return send(res, 400, { ok: false, error: '這台電腦沒有裝 plugin-manager' });
        const u = await updatePlugins();
        if (u.ok && auto) auto.recheck();   // what is still to update is asked again on the next round, not assumed
        return send(res, u.ok ? 200 : 500, u);
      }
      if (p === '/api/plugins/self-heal') { if (typeof body.on !== 'boolean') return send(res, 400, { ok: false, error: '要給 on: true 或 false' }); return send(res, 200, Plugins.setSelfHeal(body.on)); }
      // A goal handed to goal2 now (lib/goal2.js start), from the 外掛 page.
      if (p === '/api/goals/start') {
        const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '', task = typeof body.task === 'string' ? body.task.trim() : '', cond = typeof body.condition === 'string' ? body.condition.trim() : '';
        if (!isDir(cwd)) return send(res, 400, { ok: false, error: '這個資料夾不存在：' + cwd.slice(0, 200) });
        if (!task) return send(res, 400, { ok: false, error: '請寫下要它做什麼' });
        if (!cond) return send(res, 400, { ok: false, error: '請寫下完成條件：做到什麼程度、怎麼檢查算完成' });
        const r = await goal2.start(task.slice(0, 20000), cond.slice(0, 3500), path.resolve(cwd));
        return send(res, r.ok ? 200 : 400, r);
      }
      if (p === '/api/goals/stop') { const r = await goal2.stop(String(body.id || '')); return send(res, r.ok ? 200 : 409, r); }
      // collaborations (lib/collab.js)
      if (p === '/api/collab/create') { const r = await createCollab(body); const { status } = r; delete r.status; return send(res, status, r); }
      if (p === '/api/collab/decide') { const r = await decideCollab(Number(body.id), body.question, body.answer); const { status } = r; delete r.status; return send(res, status, r); }
      if (p === '/api/collab/end') {
        const all = collabList(); const c = all.find((x) => x.id === Number(body.id));
        if (!c) return send(res, 404, { ok: false, error: '找不到這個合作' });
        c.state = 'ended'; c.endedAt = Date.now(); saveCollabs(all);
        return send(res, 200, { ok: true });
      }
      // A question (by its id: a file in questions/, or the user's own in ~/.claude/session-board/questions) about a text.
      // Only an id is taken from the page, never a path: the page cannot make the board read a file of its choosing.
      if (p === '/api/decide') {
        if (typeof body.question !== 'string' || !/^[a-z0-9_-]{1,60}$/i.test(body.question) || typeof body.text !== 'string') return send(res, 400, { ok: false, error: '要 question（題目 id）與 text' });
        const r = await decider.ask(body.question, body.text.slice(-50000));
        return send(res, r.ok ? 200 : 502, r);
      }
      // Is something left undone in this reply? (the question "unfinished") -> whether to offer goal2. Asked once per text:
      // the board keys it on the text itself, not on anything the page sends.
      if (p === '/api/next/judge') {
        if (typeof body.text !== 'string') return send(res, 400, { ok: false, error: '缺 text' });
        if (!isOn('goal2')) return send(res, 409, { ok: false, error: 'goal2 的整合已在設定裡關閉' });
        const r = await decider.ask('unfinished', body.text.slice(-50000));
        return send(res, r.ok ? 200 : 502, r.ok ? { ok: true, unfinished: r.answer, items: r.items, show: r.yes } : r);
      }
      // The mic's 自動排版 (lib/tidy.js). warm: the mic was just pressed - Claude boots while you speak. tidy: the words
      // heard, cleaned up; answered as lines of JSON as they come ({d: text so far}), the last one {done, text} or {error}.
      if (p === '/api/tidy/warm') { tidy.warm(typeof body.sid === 'string' ? body.sid.slice(0, 80) : ''); return send(res, 200, { ok: true }); }   // one process per conversation (lib/tidy.js)
      if (p === '/api/tidy') {
        const text = String(body.text || '');
        if (!text.trim()) return send(res, 400, { ok: false, error: '沒有內容' });
        if (text.length > 4000) return send(res, 400, { ok: false, error: '一次最多整理 4000 字' });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        // the conversation it is said in, to put misheard English words and names right (lib/tidy.js withContext); bounded
        const cx = body.context && typeof body.context === 'object' ? body.context : null;
        const context = cx ? { sid: String(cx.sid || '').slice(0, 80), title: String(cx.title || '').slice(0, 200), folder: String(cx.folder || '').slice(0, 200), recent: (Array.isArray(cx.recent) ? cx.recent : []).slice(-6).map((x) => String(x || '').slice(0, 600)) } : null;
        const r = await tidy.run(text, (sofar) => { try { res.write(JSON.stringify({ d: sofar }) + '\n'); } catch (e) {} }, context);
        return res.end(JSON.stringify(r.ok ? { done: true, text: r.text, ms: r.ms } : { error: r.error }) + '\n');
      }
      // A board conversation's model and effort, from its next message on (lib/chat.js setModel).
      if (p === '/api/model') {
        const model = body.model === undefined ? undefined : String(body.model), effort = body.effort === undefined ? undefined : String(body.effort);
        if (model !== undefined && !/^(|fable|opus|sonnet|haiku|claude-[a-z0-9.-]{1,40})$/.test(model)) return send(res, 400, { ok: false, error: '模型只能是 fable、opus、sonnet、haiku，或留空用預設' });
        if (effort !== undefined && !/^(|low|medium|high|xhigh|max)$/.test(effort)) return send(res, 400, { ok: false, error: 'effort 只能是 low、medium、high、xhigh、max，或留空用預設' });
        const r = channels.setModel ? channels.setModel(sid, model, effort) : { ok: false, error: 'not supported' };
        fresh();
        return send(res, r.ok ? 200 : r.error === 'no such channel' ? 404 : 409, r.error === '它還在執行' ? { ok: false, error: '它這一輪還在跑，等它做完或先停止再換' } : r);
      }
      if (p === '/api/auto') {
        const cur = Object.assign({}, config.value('auto', {}));
        for (const k of ['cbm', 'update', 'harness']) if (typeof body[k] === 'boolean') cur[k] = body[k];
        if (body.updateAt !== undefined) { if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(body.updateAt))) return send(res, 400, { ok: false, error: '時間要寫成 09:00 這樣' }); cur.updateAt = String(body.updateAt); }
        config.setValue('auto', cur);
        return send(res, 200, { ok: true, settings: auto ? auto.settings() : cur });
      }
      if (p === '/api/rooms/reindex') {
        if (!isOn('cbm')) return send(res, 409, { ok: false, error: 'cbm-guard 的整合是關著的' });
        const k = cbmCache.get(String(body.cwd || ''));
        const fix = k && k.result && k.result.fixes.find((x) => x.includes('/' + String(body.repo || '') + '"'));
        if (!fix) return send(res, 404, { ok: false, error: '這個 repo 沒有待重建的索引（請先等檢查跑完）' });
        const r = await (deps.rebuildIndex || Rooms.rebuildIndex)(fix);
        if (r.ok) { cbmCache.set(String(body.cwd), { checking: true, started: false }); cbmNext(); }
        return send(res, r.ok ? 200 : 500, r);
      }
      if (p === '/api/file/ticket') {
        const abs = F.realFile(body.path);
        const kind = abs ? F.kindOf(abs) : '';
        const site = !!abs && /\.html?$/i.test(abs);   // a web page: served with what sits beside it (see /api/view)
        if (!abs || (kind !== 'pdf' && kind !== 'office' && !site)) return send(res, 404, { error: '找不到這個 PDF、Office 或網頁檔案' });
        const now = Date.now();
        for (const [k, v] of viewTickets) if (v.exp < now) viewTickets.delete(k);
        // too many: the oldest go, not all (a page being read keeps loading with its own)
        for (const k of viewTickets.keys()) { if (viewTickets.size <= 200) break; viewTickets.delete(k); }
        const id = crypto.randomBytes(18).toString('hex');
        if (site) {
          // the real, long name, as the files under it are compared by (realpathSync.native: no 8.3 names, no subst drive)
          const dir = path.dirname(abs); let dirReal = dir; try { dirReal = fs.realpathSync.native(dir); } catch (e) {}
          viewTickets.set(id, { abs, site: true, dir, dirReal, name: path.basename(abs), exp: now + 60 * 60000, from: clientAddr(req) });   // an hour: a page keeps loading its pictures while it is read
          return send(res, 200, { ok: true, url: '/api/view/' + id + '/' + encodeURIComponent(path.basename(abs)) });
        }
        const name = kind === 'office' ? path.basename(abs).replace(/\.[^.]+$/, '') + '.pdf' : path.basename(abs);
        let ino = ''; try { ino = String(fs.statSync(fs.realpathSync.native(abs), { bigint: true }).ino); } catch (e) {}   // the file it is for (see /api/view)
        viewTickets.set(id, { abs, office: kind === 'office', name, exp: now + 10 * 60000, from: clientAddr(req), ino });
        return send(res, 200, { ok: true, url: '/api/view/' + id + '/' + encodeURIComponent(name) });
      }
      if (p === '/api/stop') { const ok = channels.stop(sid); fresh(); return send(res, 200, { ok }); }
      // What is typed in a board conversation's box and not sent, kept so that leaving does not lose it (lib/chat.js setDraft)
      if (p === '/api/draft') { if (typeof body.text !== 'string') return send(res, 400, { ok: false, error: '要給 text' }); const ok = channels.setDraft ? channels.setDraft(sid, body.text) : false; if (ok) fresh(); return send(res, ok ? 200 : 404, { ok }); }
      if (p === '/api/close-empty') { const ok = channels.removeIfEmpty ? channels.removeIfEmpty(sid) : false; if (ok) fresh(); return send(res, 200, { ok }); }

      if (p === '/api/seen') { channels.seen(sid); notices.seen(sid); fresh(); return send(res, 200, { ok: true }); }
      if (p === '/api/pick-folder') return send(res, 200, { path: await pickFolder() });
      if (p === '/api/notices/dismiss') return send(res, 200, { ok: notices.closeId(body.id, 'dismissed') });
      if (p === '/api/notices/clear-closed') return send(res, 200, { ok: true, removed: notices.clearClosed() });
      // You opened this session on the page: "finished, have a look" is over.
      if (p === '/api/notices/seen-session') return send(res, 200, { ok: true, closed: notices.seen(sid) });
      if (p === '/api/budget') {
        const m = Number(body.monthly), w = body.warnPct === undefined ? Budget.DEFAULTS.warnPct : Number(body.warnPct);
        if (!Number.isFinite(m) || m < 0 || m > 1000000) return send(res, 400, { ok: false, error: '預算要是 0 以上的數字（0 表示不設預算）' });
        if (!Number.isFinite(w) || w < 10 || w > 99) return send(res, 400, { ok: false, error: '警示門檻要在 10 到 99 之間' });
        const next = Budget.clean({ monthly: m, warnPct: w });
        config.setValue('budget', next);
        config.setValue('budgetState', null);   // a new budget: what was said about the old one no longer counts
        notices.closeKind('budget', 'budget changed');
        budgetCheck();
        return send(res, 200, { ok: true, settings: next });
      }
      // A copy of a conversation, on the board: it starts from what the original holds now and goes its own way; the
      // original is not touched (Claude Code's --fork-session, see lib/chat.js _start).
      // A message of a board conversation edited and sent again: the conversation is carried on from just before that
      // message, as a new board conversation that is sent the new words; the old one is closed (its transcript stays,
      // under 沒開著), and its name, model, effort and role go with it. A turn in progress is stopped first.
      if (p === '/api/rewind') {
        const c = channels.get(sid);
        if (!c) return send(res, 400, { ok: false, error: '只有看板裡的對話可以編輯重送' });
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) return send(res, 400, { ok: false, error: '改好的訊息是空的' });
        // a member of a collaboration under way: the others write to it by its name and the ledger lists its id - a new
        // conversation in its place would drop out of it
        if (collabList().some((x) => x.state !== 'ended' && x.members.some((m) => m.sessionId === sid))) return send(res, 409, { ok: false, error: '這個對話正在合作中，換成新對話會讓其他成員找不到它。要改的話，先在合作頁結束這個合作' });
        const file = S.findTranscript(sid, c.cwd, S.DEFAULTS.projectsDir);
        if (!file) return send(res, 400, { ok: false, error: '這個對話還沒有紀錄' });
        const rp = Rewind.resumePoint(file, body.at);
        if (!rp.ok) return send(res, 400, rp);
        // its process ended before the new one reads its transcript (it could still be writing to it). One at a time for
        // a conversation (pressed twice, the second would carry the same one on again), and it must still be there after
        // the wait (closed meanwhile: nothing to carry on)
        if (rewinding.has(sid)) return send(res, 409, { ok: false, error: '這個對話正在重來，等一下' });
        rewinding.add(sid);
        try {
          const old = c.proc;
          channels.stop(sid);
          if (old && old.exitCode == null) await new Promise((done) => { const t = setTimeout(done, 3000); old.once('exit', () => { clearTimeout(t); done(); }); });
        } finally { rewinding.delete(sid); }
        if (channels.get(sid) !== c) return send(res, 409, { ok: false, error: '這個對話在停下來的時候被關掉了，沒有重來' });
        const n = channels.create(c.cwd, crypto.randomUUID());
        if (rp.at) { n.forkOf = sid; n.resumeAt = rp.at; }
        // its settings go with it; its title only when it carries on (started afresh, the title comes from the new words);
        // what you ran with "!" and had not sent yet goes with the new words (send() puts it in front of them)
        for (const k of ['model', 'effort', 'agent', 'skipPermissions'].concat(rp.at ? ['title'] : [])) if (c[k]) n[k] = c[k];
        if (Array.isArray(c.shellNotes) && c.shellNotes.length) { n.shellNotes = c.shellNotes.slice(); n.shellSeq = c.shellSeq; }
        const named = customTitles()[sid];
        if (named) config.setValue('customTitles', Object.assign({}, customTitles(), { [n.sessionId]: named }));
        if (channels._save) channels._save();
        const r = channels.send(n.sessionId, text);
        if (r && r.ok === false) {
          channels.remove(n.sessionId);
          if (named) { const t = Object.assign({}, customTitles()); delete t[n.sessionId]; config.setValue('customTitles', t); }
          fresh();
          return send(res, 500, { ok: false, error: (r.error || '送不出去') + '。原本的對話已停下，還在清單上，沒有關掉' });
        }
        channels.remove(sid);
        fresh();
        return send(res, 200, { ok: true, sessionId: n.sessionId, fromStart: !rp.at });
      }
      if (p === '/api/fork') {
        // A feature that is off unless switched on in the settings (showFork): the page then has no button for it, and the address refuses.
        if (config.value('showFork', false) !== true) return send(res, 403, { ok: false, error: '「開分身」已經在設定裡關閉。要用的話到設定頁打開' });
        const s = find(sid);
        if (!s) return send(res, 404, { ok: false, error: '找不到這個 session' });
        if (!S.findTranscript(s.sessionId, s.cwd, S.DEFAULTS.projectsDir)) return send(res, 400, { ok: false, error: '它還沒有對話內容，沒有東西可以複製' });
        const c = channels.create(s.cwd, crypto.randomUUID());
        c.forkOf = s.sessionId; c.title = ('分身：' + (s.title || '')).slice(0, 60);
        if (channels._save) channels._save();
        fresh();
        return send(res, 200, { ok: true, sessionId: c.sessionId });
      }
      if (p === '/api/watchdog') {
        const next = watchSettings();
        for (const k of ['stuck', 'limitResume', 'errorRetry', 'modelSwitch']) if (typeof body[k] === 'boolean') next[k] = body[k];
        if (body.switchTo !== undefined) { const m = String(body.switchTo); if (!/^(opus|sonnet|haiku|fable|claude-[a-z0-9.-]{1,40})$/.test(m)) return send(res, 400, { ok: false, error: '換成哪個模型：opus、sonnet、haiku，或完整的模型名稱' }); next.switchTo = m; }
        if (body.stuckMinutes !== undefined) { const n = Number(body.stuckMinutes); if (!Number.isFinite(n) || n < 2 || n > 240) return send(res, 400, { ok: false, error: '分鐘數要在 2 到 240 之間' }); next.stuckMinutes = Math.round(n); }
        config.setValue('watchdog', next);
        return send(res, 200, { ok: true, settings: next });
      }
      if (p === '/api/config') {
        // Every value that can be checked is checked before anything is saved or switched: one wrong value leaves every
        // setting as it was. (Switching autostart, keep-alive or remote access can still fail on its own, after the
        // values before it were saved - those are actions on the system, not values that can be checked first.)
        const given = Object.keys(PREFS).filter((k) => Object.prototype.hasOwnProperty.call(body, k));
        const wrong = given.find((k) => !PREFS[k].ok(body[k]));
        if (wrong) return send(res, 400, { ok: false, error: wrong + '：' + PREFS[wrong].why });
        for (const k of ['textSize', 'textSizeTouch']) if (body[k] !== undefined && !TEXT_SIZES.includes(Number(body[k]))) return send(res, 400, { ok: false, error: '字級只能是 ' + TEXT_SIZES.join('、') });
        if (body.autoHideDays !== undefined) { const n = Number(body.autoHideDays); if (!Number.isInteger(n) || n < 0 || n > 365) return send(res, 400, { ok: false, error: '天數要是 0 到 365 的整數（0 表示不自動隱藏）' }); }
        const patch = {};
        for (const k of ['pickerStartDir', 'autoRestore', 'autoContinue']) if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
        const r = config.save(patch);
        if (r.ok && typeof body.autoStart === 'boolean') {
          const a = autostart.set(body.autoStart, path.join(__dirname, 'scripts', 'start.js'));
          if (!a.ok) return send(res, 500, a);
        }
        if (r.ok && typeof body.keepAlive === 'boolean') {
          const k = Keepalive.set(body.keepAlive, path.join(__dirname, 'scripts', 'start.js'));
          if (!k.ok) return send(res, 500, k);
        }
        if (r.ok && typeof body.showFork === 'boolean') config.setValue('showFork', body.showFork);
        if (r.ok && body.integrations && typeof body.integrations === 'object') {
          const cur = Object.assign({}, config.value('integrations', {}));
          for (const x of Plugins.INTEGRATIONS) if (typeof body.integrations[x.key] === 'boolean') cur[x.key] = body.integrations[x.key];
          config.setValue('integrations', cur); integ.at = 0; pluginsCache.pmAt = 0; pluginsCache.gitAt = 0;
        }
        if (r.ok && typeof body.remoteTailscale === 'boolean') {
          const x = await server.setRemote(body.remoteTailscale);
          if (!x.ok) return send(res, 400, { ok: false, error: x.error });
          config.setValue('remoteTailscale', body.remoteTailscale);
        }
        // (the values below were checked at the top of this handler)
        for (const k of ['textSize', 'textSizeTouch']) if (r.ok && body[k] !== undefined) config.setValue(k, Number(body[k]));
        if (r.ok && given.length) { for (const k of given) config.setValue(k, body[k]); fresh(); }
        if (r.ok && body.autoHideDays !== undefined) { config.setValue('autoHideDays', Number(body.autoHideDays)); fresh(); }
        // Notifications: the setting, and the address scheme a click on one goes through.
        if (r.ok && typeof body.notify === 'boolean') {
          config.setValue('notify', body.notify);
          const n = body.notify ? Notify.register(__dirname) : Notify.unregister();
          if (!n.ok) return send(res, 500, n);
        }
        return send(res, r.ok ? 200 : 400, Object.assign(r, { prefs: prefs(), autoStart: autostart.isOn(), notify: config.value('notify', true) !== false, notifyClick: Notify.isRegistered() }));
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
      if (p === '/api/schedule/save') {
        // "After the 5-hour quota resets": the reset time as it stands now, a minute after, as a one-off. (What goal2's
        // delaylocal does - but kept by the board, so Claude Code does not have to stay open until then.)
        if (body.kind === 'reset') {
          const fh = quota().fiveHour;
          if (!fh || !fh.resetsAt || fh.resetsAt <= Date.now()) return send(res, 400, { ok: false, error: '現在沒有 5 小時額度在計時（沒用到、或已經重置了），不用等，直接選一個時間就好' });
          const t = new Date(fh.resetsAt + 60000), pad = (n) => String(n).padStart(2, '0');
          body = Object.assign({}, body, { kind: 'once', date: t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()), at: pad(t.getHours()) + ':' + pad(t.getMinutes()) });
        }
        const c = Sched.clean(body, isDir);
        if (!c.ok) return send(res, 400, { ok: false, error: c.error });
        if (c.value.target === 'session' && !c.value.sessionTitle) { const s = find(c.value.sessionId); if (s) c.value.sessionTitle = s.title || ''; }
        if (c.value.target === 'goal' && (!isOn('goal2') || !(await goal2.list()).installed)) return send(res, 400, { ok: false, error: '這台電腦沒有裝 goal2，不能交辦 goal' });
        if (c.value.agent && !channels.roles(c.value.cwd).some((r) => r.name === c.value.agent)) return send(res, 400, { ok: false, error: '這個資料夾沒有「' + c.value.agent + '」這個角色' });
        return send(res, 200, { ok: true, id: schedules.save(c.value, body.id) });
      }
      if (p === '/api/schedule/toggle') return send(res, 200, { ok: schedules.setEnabled(body.id, body.enabled === true) });
      if (p === '/api/schedule/delete') return send(res, 200, { ok: schedules.remove(body.id) });
      if (p === '/api/schedule/run') {
        const s = schedules.get(body.id);
        if (!s || !runner) return send(res, 404, { ok: false, error: '找不到這筆排程' });
        const now = Date.now(); const r = await runner.fire(s, now, now);
        fresh();
        return send(res, 200, r.ok ? { ok: true, sessionId: r.sessionId, status: r.status } : { ok: false, error: r.error || '沒有執行成功' });
      }
      if (p === '/api/schedule/notice') { if (!runner) return send(res, 404, { ok: false, error: '排程沒有在執行' }); const r = await runner.act(body.id, String(body.action || '')); fresh(); return send(res, 200, r); }
      // A name for a session, kept by the board above every other title; empty = back to the automatic one. A board
      // conversation is also told /rename, so Claude Code (and the terminal's resume list) has the name too.
      if (p === '/api/rename') {
        const sid = String(body.sessionId || '');
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sid)) return send(res, 400, { ok: false, error: '缺 session id' });
        if (typeof body.name !== 'string') return send(res, 400, { ok: false, error: '名字要是文字' });
        const name = body.name.replace(/\s+/g, ' ').trim().slice(0, 120);
        const t = Object.assign({}, customTitles());
        delete t[sid]; if (name) t[sid] = name;
        const keys = Object.keys(t); for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete t[k];
        config.setValue('customTitles', t); fresh();
        let synced = false;
        if (channels.get(sid) && name) { const r = channels.send(sid, '/rename ' + name); synced = !(r && r.ok === false); }
        return send(res, 200, { ok: true, name, synced });
      }
      if (p === '/api/hide') {
        // {clear: true} brings every hidden session back; otherwise one session is hidden or shown.
        if (body.clear === true) { setHidden([]); fresh(); return send(res, 200, { ok: true, hidden: 0 }); }
        if (!/^[0-9a-f-]{8,64}$/i.test(sid)) return send(res, 400, { ok: false, error: '沒有指定 session' });
        const cur = hiddenList().filter((x) => x !== sid);
        if (body.hidden === true) cur.push(sid);
        // Put back on the list: the days of quiet are counted from now, so that it does not hide itself again at once.
        else { const t = Object.assign({}, config.value('shownAt', {})); delete t[sid]; t[sid] = Date.now(); const keys = Object.keys(t); for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete t[k]; config.setValue('shownAt', t); }
        setHidden(cur.slice(-500));
        fresh();
        return send(res, 200, { ok: true, hidden: cur.length });
      }
      // Which ids written in a page are conversations on this computer (for the "carry on" buttons beside them).
      if (p === '/api/past/which') {
        const found = Past.which(S.DEFAULTS.projectsDir, Array.isArray(body.ids) ? body.ids : []);
        const open = new Set(sessions().map((s) => s.sessionId));
        for (const v of Object.values(found)) v.open = open.has(v.sessionId);
        return send(res, 200, { ok: true, found });
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
        const win = await focusWindow(s.titleCandidates, 'find', s.pid);
        try { osKill(s.pid); } catch (e) {}
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
        if (MAC) { const o = await Mac.openFile(abs); return send(res, o.ok ? 200 : 500, o); }
        spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/file/reveal') {
        // No network paths (see lib/files.js resolve).
        let abs = null;
        try { if (typeof body.path === 'string' && !F.isNetworkPath(body.path) && path.isAbsolute(body.path) && fs.existsSync(body.path)) abs = path.normalize(body.path); } catch (e) {}
        if (!abs) return send(res, 404, { ok: false, error: '找不到這個路徑' });
        // Opened by a script that then brings the Explorer window to the front (scripts/reveal.ps1): started from here
        // directly it opens behind the browser, since the board is a background program.
        if (MAC) { const m = await Mac.reveal(abs); return send(res, m.state === 'shown' ? 200 : 500, Object.assign({ ok: m.state === 'shown' }, m)); }
        const r = await powershell('reveal.ps1', ['-PathB64', Buffer.from(abs, 'utf8').toString('base64')], 15000);
        let j = {}; try { j = JSON.parse(r.line); } catch (e) {}
        if (j.state === 'failed' || !j.state) { spawn('explorer.exe', fs.statSync(abs).isDirectory() ? [abs] : ['/select,' + abs], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); return send(res, 200, { ok: true, front: false }); }
        return send(res, 200, { ok: true, front: j.state === 'front' });
      }
      // The roles a conversation in a folder can be started as, and choosing one for a conversation not yet begun.
      if (p === '/api/roles') {
        const c = sid ? channels.get(sid) : null;
        const cwd = c ? c.cwd : typeof body.cwd === 'string' ? body.cwd : '';
        if (!isDir(cwd)) return send(res, 200, { ok: true, roles: [] });
        return send(res, 200, { ok: true, roles: channels.roles(path.resolve(cwd)), agent: c && c.agent ? c.agent : '' });
      }
      if (p === '/api/role') { const r = channels.setAgent(sid, typeof body.agent === 'string' ? body.agent : ''); if (r.ok) fresh(); return send(res, r.ok ? 200 : 400, r); }
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
        const win = await focusWindow(s.titleCandidates, 'find', s.pid);
        try { osKill(s.pid); } catch (e) {}
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
        // its name goes with it (lib/sessions.js o.titles); the last 200 are remembered
        if (c.title) { const t = Object.assign({}, config.value('movedTitles', {})); delete t[sid]; t[sid] = String(c.title).slice(0, 120); const keys = Object.keys(t); for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete t[k]; config.setValue('movedTitles', t); }
        channels.remove(sid);
        fresh();
        // a Mac says whether Terminal opened; if not, you are told how to pick it up (the conversation is on disk)
        const o = await openTerminal(args);
        if (o && o.ok === false) return send(res, 500, { ok: false, error: o.error + '。對話紀錄還在，可以在終端機用 claude --resume ' + sid + ' 接回' });
        return send(res, 200, { ok: true });
      }
      // Take a conversation off the board. Its history stays on disk (claude --resume <id>).
      if (p === '/api/close') { const ok = channels.remove(sid); fresh(); return send(res, 200, { ok }); }
      // 「重啟更新」 (the floating button at the right of the screen, beside the message box), after the plugins were brought up to date: the board
      // starts again on the newest installed version of itself. Typed in a conversation on the board, /session-board could
      // never do this - that conversation is busy with it, and stopping the board ends it before it could start the new
      // one (asked 2026-11-20). From the page, no conversation is in the way: refused only while one is working (the same
      // rule as /api/shutdown). A small helper, detached so it outlives this process, waits for it to end and starts the
      // new one (scripts/start.js --after).
      if (p === '/api/restart') {
        const inst = (deps.pluginsInstalled || Plugins.installed)();
        const root = deps.boardRoot || Plugins.rootOf('session-board', inst, __dirname) || __dirname;
        let newest = VERSION; try { newest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || VERSION; } catch (e) {}
        if (!newer(newest, VERSION)) {
          // the same version, or an older one installed (its start.js would not know --after: nothing would come back up)
          if (body.onlyIfNewer === true || newest === VERSION) return send(res, 200, { ok: true, restarted: false, version: VERSION });
          return send(res, 409, { ok: false, error: '裝好的看板 ' + newest + ' 比正在跑的 ' + VERSION + ' 舊，不換回去', version: VERSION, newest });
        }
        const active = channels.active();
        if (active.length) return send(res, 409, { ok: false, active, version: VERSION, newest });
        try {
          spawn(process.execPath, [path.join(root, 'scripts', 'start.js'), '--after', String(process.pid), '--port', String(port)],
            { detached: true, stdio: 'ignore', windowsHide: true, cwd: root }).on('error', () => {}).unref();
        } catch (e) { return send(res, 500, { ok: false, error: '重開的小程式起不來：' + String(e.message || e).slice(0, 200) }); }
        send(res, 200, { ok: true, restarted: true, from: VERSION, to: newest });
        // marked as restarting: for a short while the keep-alive task does not start the old one in the moment between (the
        // helper's start takes the mark away; one that never comes up is started by the keep-alive task once the mark is old,
        // lib/keepalive.js RESTARTING_MS); and looked at once more - a conversation that began working since is not cut
        try { fs.mkdirSync(path.dirname(RESTARTING), { recursive: true }); fs.writeFileSync(RESTARTING, String(Date.now())); } catch (e) {}
        setTimeout(() => {
          if (channels.active().length) { try { fs.unlinkSync(RESTARTING); } catch (e) {} return; }   // called off: the page, seeing this version still answer, says so (about 5 s)
          channels.shutdown(); osExit(0);
        }, 300);
        return;
      }
      if (p === '/api/shutdown') {
        // Stopping the board ends every conversation process it runs, and with
        // them any turn in progress and any background work (a restart on
        // 2026-11-12 killed a test a conversation was waiting on). So it is
        // refused while anything is active, unless explicitly forced.
        const active = channels.active();
        if (active.length && body.force !== true) return send(res, 409, { ok: false, active });
        send(res, 200, { ok: true });
        channels.shutdown();
        setTimeout(() => osExit(0), 100);
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      try { send(res, 500, { error: String(e && e.message || e).slice(0, 200) }); } catch (e2) {}
    }
  });
  server.channels = channels;
  // Also listen on this computer's Tailscale address (and only there), or stop doing so. -> {ok, listening, ip, name, error}
  server.setRemote = async (on) => {
    // off: not waited for - the request asking may have come through this very listener (it would wait for itself), and an
    // open stream (/api/stream) never ends on its own. Stopped taking new connections now; the ones it has are cut a moment
    // later, after this request has had its answer.
    if (!on) { if (remote) { const r = remote; remote = null; r.server.close(() => {}); const cut = setTimeout(() => { if (r.server.closeAllConnections) r.server.closeAllConnections(); }, 300); if (cut.unref) cut.unref(); } return { ok: true, listening: false }; }
    if (remote) return { ok: true, listening: true, ip: remote.ip, name: remote.name };
    const i = await (deps.remoteInfo || Remote.info)();
    if (!i.ok) return { ok: false, listening: false, error: i.why };
    if (!i.ip) return { ok: false, listening: false, error: 'Tailscale 沒有給這台電腦 100.x 的位址' };
    const s2 = http.createServer(server.listeners('request')[0]);
    const err = await new Promise((res) => { s2.once('error', (e) => res(e)); s2.listen(port, i.ip, () => res(null)); });
    if (err) return { ok: false, listening: false, error: err.code === 'EADDRINUSE' ? '這個位址的 ' + port + ' 已經被別的程式占用' : String(err.message || err) };
    for (const h of [i.ip, i.name, i.name.split('.')[0]]) if (h) allowedHosts.add(h + ':' + port);
    remote = { server: s2, ip: i.ip, name: i.name };
    gate.refresh().catch(() => {});
    return { ok: true, listening: true, ip: i.ip, name: i.name };
  };
  server.remoteState = () => (remote ? { listening: true, ip: remote.ip, name: remote.name, port } : { listening: false, port });
  // Tailscale may not be up yet when the board starts (at sign-in it often is not): while the setting is on and the board
  // is not listening there, it tries again every `every` ms, so it is reachable as soon as Tailscale is. `say` gets a line
  // when the outcome changes. -> a function that runs one try now (and returns its promise)
  let remoteTimer = null;
  server.cmdUse = cmdUse;
  server.on('close', () => { if (ended.close) ended.close(); });
  server.keepRemote = (every, say) => {
    let said = '', busy = false;
    const once = async () => {
      if (busy || config.value('remoteTailscale', false) !== true || remote) return;
      busy = true;
      try {
        const x = await server.setRemote(true);
        const line = x.ok ? `  and on Tailscale: http://${x.ip}:${port}/ (your own devices only)` : '  Tailscale: not listening yet - ' + x.error + ' (trying again every ' + Math.round(every / 1000) + ' seconds)';
        if (line !== said) { said = line; if (say) say(line); }
      } catch (e) {} finally { busy = false; }
    };
    if (remoteTimer) clearInterval(remoteTimer);
    remoteTimer = setInterval(once, every); if (remoteTimer.unref) remoteTimer.unref();
    once();
    return once;
  };
  server.on('close', () => { if (remoteTimer) { clearInterval(remoteTimer); remoteTimer = null; } });
  server.on('close', () => { if (remote) { try { remote.server.close(); } catch (e) {} remote = null; } });
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
    server.keepRemote(30000, (line) => console.log(line));
    server.cmdUse.start();   // the commands you use most: counted in the background every 15 minutes
    // the LINE secretary, when line.json is filled in (lib/line.js): its own listener on 127.0.0.1:4318, the only
    // thing Tailscale Funnel passes the internet to; it uses the board through this API like the page does
    try { require('./lib/line').start({ boardPort: port, boardKey: token, log: (line) => console.log(line) }); } catch (e) { console.log('LINE 小秘書沒有啟動：' + (e.message || e)); }
  });
}

module.exports = { sendPage, createServer, nextSteps, terminalArgs, readEnded, endedReader, inboxThreadText, getToken, portFromArgs, DEFAULT_PORT, HOST, DATA_DIR, TOKEN_FILE };
