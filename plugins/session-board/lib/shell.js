'use strict';
// A command you type yourself, run for you: what a line beginning with "!" is in a terminal session.
//
// In a terminal Claude Code runs such a line itself and shows what it printed; what was run and what it printed are
// handed to Claude with your next message. A message sent from the board is not treated that way by Claude Code - it
// reaches the model as plain text and nothing is run (measured 2026-11-16) - so the board does the same thing itself:
// it runs the command in the conversation's folder, as you, and keeps what it printed for the next message.
//
// It runs with no keyboard: a command that waits for input gets none and ends, or is stopped at the time limit.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TIME_LIMIT_MS = 120000;
const OUT_LIMIT = 200 * 1024;      // of each of the two outputs, the end is kept
const NOTE_LIMIT = 20000;          // characters of each output handed to Claude

// The shell: Git Bash where there is one (what Claude Code itself uses on Windows), else PowerShell; sh elsewhere.
// Never C:\Windows\System32\bash.exe - that one starts the Linux subsystem.
function findShell(env = process.env, exists = fs.existsSync, platform = process.platform) {
  if (platform !== 'win32') return { kind: 'sh', file: '/bin/sh', args: (c) => ['-c', c] };
  // Under Git Bash the time limit is kept by bash's own `timeout`, given the command as an argument (never pasted into
  // a command line): what a command starts there does not hang under the shell's process as Windows sees it (measured
  // 2026-11-16: the `sleep` of `sleep 8; echo late` had a parent that no longer existed, and taskkill /T on the shell
  // left it running), while `timeout` stops the whole group through bash's own signals. 124 is what it ends with then.
  const bash = (file) => ({ kind: 'bash', file, args: (c, secs) => (secs ? ['-c', 'exec timeout -k 2 "$1" bash -c "$2"', 'bash', String(secs), c] : ['-c', c]), ownLimit: true });
  const cands = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) cands.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of String(env.PATH || env.Path || '').split(';')) {
    const d = dir.trim().replace(/[\\/]+$/, '');
    if (!d || /[\\/]system32$/i.test(d)) continue;
    // ...\Git\cmd (where git.exe is) -> ...\Git\bin\bash.exe ; or a folder that holds bash.exe itself
    if (/[\\/]cmd$/i.test(d)) cands.push(path.join(path.dirname(d), 'bin', 'bash.exe'));
    if (/git/i.test(d)) cands.push(path.join(d, 'bash.exe'));
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) if (root) cands.push(path.join(root, 'Git', 'bin', 'bash.exe'));
  for (const f of cands) { try { if (f && !/[\\/]system32[\\/]/i.test(f) && exists(f)) return bash(f); } catch (e) {} }
  return { kind: 'powershell', file: 'powershell.exe', args: (c) => ['-NoProfile', '-NonInteractive', '-Command', c] };
}

const tail = (s, n) => (s.length > n ? s.slice(s.length - n) : s);

// -> {ok, code, stdout, stderr, timedOut, cut, shell, ms}   ok: it was started and ended by itself (whatever its exit code)
function run(command, cwd, o = {}) {
  const sh = o.shell || findShell();
  const limit = o.timeLimit || TIME_LIMIT_MS;
  const started = Date.now();
  return new Promise((resolve) => {
    let p, out = '', err = '', cut = false, timedOut = false, done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ stdout: out, stderr: err, timedOut, cut, shell: sh.kind, ms: Date.now() - started }, r)); };
    const secs = Math.max(1, Math.round(limit / 1000));
    // macOS / Linux: the command gets a process group of its own, so the time limit can end all of it (stopAll)
    try { p = (o.spawn || spawn)(sh.file, sh.args(command, secs), { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) }); }
    catch (e) { return end({ ok: false, code: null, error: String(e.message || e) }); }
    // At the time limit the command is ended together with everything it started: ending the shell alone leaves what it
    // was running (measured: `sleep 5` under bash went on to its end). On Windows that takes taskkill with /T.
    const stopAll = () => {
      // (taskkill first and the shell only after it is done: with the shell ended first, what it started has no parent
      // left to be found by - measured, the `sleep` went on.)
      const last = () => { try { p.kill(); } catch (e) {} };
      if (process.platform === 'win32' && Number.isInteger(p.pid)) {
        try { const k = spawn('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); k.on('error', last); k.on('exit', last); } catch (e) { last(); }
      } else { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {} last(); }   // the whole group (macOS 26: p.kill alone left the sleep running)
      setTimeout(() => end({ ok: false, code: null, error: '超過 ' + Math.round(limit / 1000) + ' 秒還沒結束，已經停掉。需要輸入或跑很久的指令請到終端機執行' }), 3000).unref();   // should its output never close
    };
    // (a shell that keeps the limit itself is given a little longer before it is stopped from outside)
    const timer = setTimeout(() => { timedOut = true; stopAll(); }, limit + (sh.ownLimit ? 5000 : 0));
    const take = (which) => (d) => {
      const s = d.toString('utf8');
      if (which === 'out') { out += s; if (out.length > OUT_LIMIT) { out = tail(out, OUT_LIMIT); cut = true; } }
      else { err += s; if (err.length > OUT_LIMIT) { err = tail(err, OUT_LIMIT); cut = true; } }
    };
    p.stdout.on('data', take('out'));
    p.stderr.on('data', take('err'));
    p.on('error', (e) => end({ ok: false, code: null, error: e && e.code === 'ENOENT' ? '找不到用來執行指令的程式：' + sh.file : String((e && e.message) || e) }));
    p.on('close', (code) => { if (sh.ownLimit && code === 124 && Date.now() - started >= limit - 200) { timedOut = true; code = null; } end({ ok: !timedOut, code, error: timedOut ? '超過 ' + Math.round(limit / 1000) + ' 秒還沒結束，已經停掉。需要輸入或跑很久的指令請到終端機執行' : undefined }); });
  });
}

// What is handed to Claude with the next message: the same form a terminal session's transcript uses.
function noteText(notes) {
  return (notes || []).map((n) => '<bash-input>' + n.command + '</bash-input>\n<bash-stdout>' + tail(String(n.stdout || ''), NOTE_LIMIT) + '</bash-stdout><bash-stderr>' + tail(String(n.stderr || ''), NOTE_LIMIT) + '</bash-stderr>').join('\n');
}

module.exports = { findShell, run, noteText, TIME_LIMIT_MS, OUT_LIMIT, NOTE_LIMIT };
