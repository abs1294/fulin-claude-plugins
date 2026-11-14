#!/usr/bin/env node
'use strict';
// SessionEnd hook: notes that a session ended, and why, in
// ~/.claude/session-board/ended/<session id>.json. The board reads these to
// tell "you closed it" from "the machine went down" (lib/keep.js) - also for
// sessions that ended while the board was not running.
//
// Never blocks and never fails the session: any problem ends quietly with exit 0.
const fs = require('fs');
const os = require('os');
const path = require('path');

let raw = '';
const done = () => {
  try {
    const j = JSON.parse(raw || '{}');
    const sid = String(j.session_id || '');
    if (/^[0-9a-f-]{8,64}$/i.test(sid)) {
      const dir = path.join(os.homedir(), '.claude', 'session-board', 'ended');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, sid + '.json'), JSON.stringify({ sessionId: sid, reason: String(j.reason || ''), at: Date.now(), cwd: String(j.cwd || '') }));
    }
  } catch (e) {}
  process.exit(0);
};
process.stdin.on('data', (c) => { raw += c; if (raw.length > 1048576) done(); });
process.stdin.on('end', done);
process.stdin.on('error', done);
setTimeout(done, 3000);
