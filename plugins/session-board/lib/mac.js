'use strict';
// The macOS way of the few things the board does with the computer itself (on Windows: PowerShell scripts, Windows
// Terminal, Explorer, the Task Scheduler). Everything here goes through tools every Mac has: osascript, open, ps, launchctl.
// Each function takes o.run (an execFile stand-in) so it can be checked on any computer.
//   terminal    a conversation opened in Terminal.app: a small .command file (cd, claude --resume, then a shell stays),
//               opened with `open -a Terminal`
//   focus       the Terminal tab whose tty is the session's (ps -o tty=), brought to the front
//   notify      a notification from Notification Center (display notification)
//   folder      the system's "choose folder" window
//   reveal/open Finder (open -R) and the default program (open)
//   cmdlines    the command line of each process (ps -o pid=,command=)
//   office      Office files to PDF with LibreOffice, when it is installed (Word's COM exists only on Windows)
//   autostart   a LaunchAgent that starts the board at login; keepalive: one that runs start.js --keepalive every 10 min
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const run = (file, args, o = {}) => new Promise((resolve) => (o.run || execFile)(file, args, { timeout: o.timeout || 15000, encoding: 'utf8', env: o.env || process.env },
  (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || ''), code: err ? err.code : 0 })));
// AppleScript with its values passed as arguments (item 1 of argv …), never pasted into the script text.
const osa = (lines, argv, o) => run('osascript', [].concat(...lines.map((l) => ['-e', l]), argv.map(String)), o);
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";   // one argument for zsh

// ── a conversation in Terminal.app ──
// The flags the session was started with are kept only when the command is claude itself (same rule as on Windows).
function launcherText(cwd, command, sid, resume, prompt) {
  // ps shows the command line without its quoting: every word is quoted again, so ; | & > $( ) in it are text, not shell
  const words = String(command || 'claude').trim().split(/\s+/).filter(Boolean);
  const safe = words.length && /(^|\/)claude$/.test(words[0]) ? words.map(sq).join(' ') : 'claude';
  const say = prompt ? ' ' + sq(String(prompt).replace(/[\r\n]/g, ' ').slice(0, 1000)) : '';
  return ['#!/bin/zsh -l',
    '# opened by session-board',
    'unset CLAUDECODE CLAUDE_PID CLAUDE_JOB_DIR CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID',
    'cd ' + sq(cwd) + ' || exit 1',
    safe + (resume ? ' --resume ' : ' --session-id ') + sid + say,
    'exec "${SHELL:-/bin/zsh}" -l',   // the window stays when claude ends, like one opened by hand
    ''].join('\n');
}
function writeLauncher(dir, cwd, sid, command, resume, prompt) {
  if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new Error('bad session id');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  try { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (n.endsWith('.command') && now - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } } catch (e) {}
  const file = path.join(dir, sid + '.command');
  fs.writeFileSync(file, launcherText(cwd, command, sid, resume, prompt), { mode: 0o755 });
  try { fs.chmodSync(file, 0o755); } catch (e) {}
  return file;
}
async function openTerminal(file, o) { const r = await run('open', ['-a', 'Terminal', file], o); return r.ok ? { ok: true } : { ok: false, error: 'Terminal 沒有打開：' + r.err.slice(0, 200) }; }

// ── the session's Terminal tab to the front ──
async function ttyOf(pid, o) { const r = await run('ps', ['-o', 'tty=', '-p', String(pid)], o); const t = r.out.trim(); return r.ok && t && t !== '??' ? '/dev/' + t.replace(/^\/dev\//, '') : ''; }
async function focus(pid, o) {
  const tty = pid ? await ttyOf(pid, o) : '';
  if (!tty) return { state: 'miss', error: '找不到它的 Terminal 分頁（它可能不是在 Terminal 裡開的）' };
  const r = await osa(['on run argv', 'tell application "Terminal"', 'repeat with w in windows', 'repeat with t in tabs of w',
    'if tty of t is (item 1 of argv) then', 'set selected of t to true', 'set index of w to 1', 'activate', 'return "hit"', 'end if',
    'end repeat', 'end repeat', 'end tell', 'return "miss"', 'end run'], [tty], o);
  // the script selects the tab, puts its window first and activates Terminal: found is in front (the page reads
  // {state:'hit'} without focused as "found but not brought forward", which is only a Windows case)
  return r.ok && /hit/.test(r.out) ? { state: 'hit', focused: true } : { state: 'miss', error: r.ok ? '找不到它的 Terminal 分頁' : r.err.slice(0, 200) };
}

async function notify(title, text, o) { return osa(['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'], [String(title).slice(0, 200), String(text).slice(0, 400)], o); }

async function pickFolder(prompt, start, o) {
  const r = await osa(['on run argv', 'set p to (item 1 of argv)', 'if (item 2 of argv) is not "" then',
    'return POSIX path of (choose folder with prompt p default location (POSIX file (item 2 of argv)))', 'else', 'return POSIX path of (choose folder with prompt p)', 'end if', 'end run'],
    [prompt, start || ''], Object.assign({ timeout: 5 * 60 * 1000 }, o));
  return r.ok ? r.out.trim().replace(/\/$/, '') : '';
}

async function openFile(abs, o) { const r = await run('open', [abs], o); return r.ok ? { ok: true } : { ok: false, error: r.err.slice(0, 200) }; }
async function reveal(abs, o) { const r = await run('open', fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? [abs] : ['-R', abs], o); return r.ok ? { state: 'shown' } : { state: 'failed', error: r.err.slice(0, 200) }; }

async function commandLines(pids, o) {
  const r = await run('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], o);
  const out = {};
  for (const line of r.out.split('\n')) { const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (m) out[m[1]] = m[2]; }
  return out;
}

// ── Office to PDF ──
function soffice(o = {}) {
  for (const p of [o.soffice, '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice']) if (p && fs.existsSync(p)) return p;
  return '';
}
async function convertOffice(src, dst, o = {}) {
  const bin = soffice(o);
  if (!bin) return { ok: false, error: '這台 Mac 沒有裝 LibreOffice，Word／Excel／PowerPoint 檔不能在看板預覽（裝了之後就可以：brew install --cask libreoffice）。可以按「用預設程式開啟」。' };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-office-'));
  const r = await run(bin, ['--headless', '--convert-to', 'pdf', '--outdir', out, src], Object.assign({ timeout: 120000 }, o));
  const made = path.join(out, path.basename(src).replace(/\.[^.]+$/, '') + '.pdf');
  if (!r.ok || !fs.existsSync(made)) return { ok: false, error: 'LibreOffice 沒有轉出 PDF：' + (r.err || r.out).slice(0, 200) };
  fs.copyFileSync(made, dst);
  try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) {}
  return { ok: true };
}

// ── LaunchAgents: started at login, and kept alive ──
const AGENTS = () => path.join(os.homedir(), 'Library', 'LaunchAgents');
const LABEL = { start: 'com.fulin.session-board', keep: 'com.fulin.session-board.keepalive' };
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plist(label, args, extra) {
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0"><dict>',
    '<key>Label</key><string>' + xml(label) + '</string>',
    '<key>ProgramArguments</key><array>' + args.map((a) => '<string>' + xml(a) + '</string>').join('') + '</array>',
    // a LaunchAgent starts with almost no PATH: claude, git and node are found where Homebrew and npm put them
    '<key>EnvironmentVariables</key><dict><key>PATH</key><string>' + xml([path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')) + '</string></dict>',
    extra, '</dict></plist>', ''].join('\n');
}
const agentFile = (k) => path.join(AGENTS(), LABEL[k] + '.plist');
function setAgent(k, on, startJs, o = {}) {
  const ctl = (args) => { try { (o.runSync || execFileSync)('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }); return { ok: true }; } catch (e) { return { ok: false, err: String((e.stderr && e.stderr.toString()) || e.message || e) }; } };
  const f = agentFile(k);
  try {
    if (on) {
      fs.mkdirSync(AGENTS(), { recursive: true });
      const args = [process.execPath, startJs].concat(k === 'keep' ? ['--keepalive'] : []);
      fs.writeFileSync(f, plist(LABEL[k], args, k === 'keep' ? '<key>StartInterval</key><integer>600</integer>' : '<key>RunAtLoad</key><true/>'));
      ctl(['unload', f]);
      const r = ctl(['load', f]);
      if (!r.ok) return { ok: false, error: 'launchctl 沒有載入：' + r.err.slice(0, 200) };
    } else {
      ctl(['unload', f]);
      try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, error: String(e.message) }; }
    }
    return { ok: true, on: fs.existsSync(f), file: f };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
const agentOn = (k) => fs.existsSync(agentFile(k));

module.exports = { launcherText, writeLauncher, openTerminal, ttyOf, focus, notify, pickFolder, openFile, reveal, commandLines, soffice, convertOffice, plist, setAgent, agentOn, agentFile, LABEL };
