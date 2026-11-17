#!/usr/bin/env node
'use strict';
// Stop / Notification hook: a toast when a session finishes or needs you.
// What decides whether one is shown is in lib/notify.js (decide()).
// Never blocks and never fails the session: any problem ends quietly, exit 0.
//
//   node notify-hook.js            reads the hook's JSON on stdin
//   node notify-hook.js --dry      prints the decision instead of showing a toast
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dry = process.argv.includes('--dry');
let raw = '';
let ended = false;
const finish = () => {
  if (ended) return; ended = true;
  let out = { show: false, why: 'error' };
  try {
    const input = JSON.parse(raw || '{}');
    const N = require('../lib/notify');
    const S = require('../lib/sessions');
    const config = require('../lib/config');
    const sid = String(input.session_id || '');
    const regEntry = S.readRegistry(S.DEFAULTS.sessionsDir).find((r) => r.sessionId === sid) || null;
    let onBoard = false;
    try { onBoard = fs.readFileSync(path.join(os.homedir(), '.claude', 'session-board', 'channels.json'), 'utf8').includes('"' + sid + '"'); } catch (e) {}
    // The same name the board lists it under: the status line's summary, else the transcript's title, else its registry name.
    let title = '';
    try {
      title = S.readSummary(sid, S.DEFAULTS) || '';
      if (!title) { const f = S.findTranscript(sid, String(input.cwd || (regEntry && regEntry.cwd) || ''), S.DEFAULTS.projectsDir); const t = f ? S.lastTitles(f) : {}; title = t.custom || t.ai || ''; }
      if (!title && regEntry && typeof regEntry.name === 'string') title = regEntry.name;
    } catch (e) {}
    out = N.decide(input, { enabled: config.value('notify', true) !== false, ownChain: N.ownChainPresent(), entrypoint: regEntry && typeof regEntry.entrypoint === 'string' ? regEntry.entrypoint : '', onBoard, title: String(title).slice(0, 60) });
    if (out.show && !dry) {
      const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
      if (process.platform === 'darwin') require('child_process').spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', String(out.title).slice(0, 200), String(out.message).slice(0, 400)], { timeout: 5000 });
      else spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'toast.ps1'),
        '-TitleB64', b64(out.title), '-MsgB64', b64(out.message), '-Sid', sid, '-Scheme', N.SCHEME], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  } catch (e) { out = { show: false, why: String(e.message || e).slice(0, 120) }; }
  if (dry) process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
};
process.stdin.on('data', (c) => { raw += c; if (raw.length > 4 * 1048576) finish(); });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 3000);
