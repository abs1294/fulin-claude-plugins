'use strict';
// Bringing the board back when it is not running: schedules, the inbox and the watching of stopped sessions all
// stop with it, and nothing would tell you. A Windows scheduled task (current user, no administrator rights)
// runs every ten minutes:
//     wscript  ~/.claude/session-board/keepalive.vbs   ->   node scripts/start.js --keepalive   (no window)
// start.js starts the board if it is not there, and does nothing if it is.
//
// A board you stopped yourself stays stopped: `start.js --stop` leaves a mark (STOPPED_MARK in the data folder),
// and --keepalive does nothing while that mark is there. Starting the board by hand takes the mark away.
//
// On = the task exists. Turning it off deletes the task and the .vbs file; nothing else is changed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TASK = 'SessionBoardKeepAlive';
const DATA_DIR = path.join(os.homedir(), '.claude', 'session-board');
const VBS = path.join(DATA_DIR, 'keepalive.vbs');
const STOPPED_MARK = path.join(DATA_DIR, 'stopped-on-purpose');
const EVERY_MIN = 10;

// Runs `node start.js --keepalive` with no window. UTF-16, so a path with any character in it works.
function script(node, startJs) {
  const q = (s) => '""' + s + '""';
  return 'CreateObject("WScript.Shell").Run "' + q(node) + ' ' + q(startJs) + ' --keepalive", 0, False\r\n';
}
const run = (args) => execFileSync('schtasks.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).toString();

const MAC = process.platform === 'darwin';
const Mac = MAC ? require('./mac') : null;
// On a Mac: a LaunchAgent that runs start.js --keepalive every 10 minutes (StartInterval 600).
function isOn() {
  if (MAC) return Mac.agentOn('keep'); try { run(['/Query', '/TN', TASK]); return true; } catch (e) { return false; } }

function set(on, startJs, node = process.execPath) {
  if (MAC) return Mac.setAgent('keep', on, startJs);
  try {
    if (on) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(VBS, '﻿' + script(node, startJs), 'utf16le');
      run(['/Create', '/TN', TASK, '/SC', 'MINUTE', '/MO', String(EVERY_MIN), '/TR', 'wscript.exe "' + VBS + '"', '/F']);
    } else {
      if (isOn()) run(['/Delete', '/TN', TASK, '/F']);
      try { fs.unlinkSync(VBS); } catch (e) {}
    }
  } catch (e) {
    // The file without the task would be a leftover that does nothing: taken away again.
    if (on && !isOn()) { try { fs.unlinkSync(VBS); } catch (x) {} }
    if (e && e.code === 'EPERM') return { ok: false, error: 'Windows 不讓這個程序建立工作排程（被擋下，不是設定錯）。常見原因是看板是從受限制的環境啟動的；請在看板由 Windows 登入時自動啟動、或你自己從終端機啟動之後，再打開這個開關' };
    return { ok: false, error: 'Windows 的工作排程沒有設定成功：' + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/\s+/g, ' ').slice(0, 160) }; }
  return { ok: true, on: isOn() };
}

// The plugin's folder changes with every update: the .vbs written by an older version points at a start.js that
// may be gone. Called when the board starts.
function refresh(startJs) {
  if (MAC) { if (Mac.agentOn('keep')) Mac.setAgent('keep', true, startJs); return; } try { if (isOn()) fs.writeFileSync(VBS, '﻿' + script(process.execPath, startJs), 'utf16le'); } catch (e) {} }

module.exports = { isOn, set, refresh, script, TASK, VBS, STOPPED_MARK, EVERY_MIN };
