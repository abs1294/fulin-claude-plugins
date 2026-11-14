'use strict';
// Starting the board when you sign in to Windows: one small file in your
// Startup folder (shell:startup). Present = on, absent = off. Nothing else is
// changed (no registry entry, no scheduled task), so removing the file by hand
// also turns it off.
const fs = require('fs');
const path = require('path');

const NAME = 'session-board.vbs';
const startupDir = () => (process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : '');
const fileIn = (dir) => path.join(dir, NAME);

// Runs `node scripts/start.js` with no window. UTF-16 so a path with any character in it works.
function script(node, startJs) {
  const q = (s) => '""' + s + '""';
  return 'CreateObject("WScript.Shell").Run "' + q(node) + ' ' + q(startJs) + '", 0, False\r\n';
}

function isOn(dir = startupDir()) { try { return !!dir && fs.existsSync(fileIn(dir)); } catch (e) { return false; } }

function set(on, startJs, dir = startupDir(), node = process.execPath) {
  if (!dir) return { ok: false, error: '找不到 Windows 的「啟動」資料夾' };
  try {
    if (on) fs.writeFileSync(fileIn(dir), '﻿' + script(node, startJs), 'utf16le');
    else if (fs.existsSync(fileIn(dir))) fs.unlinkSync(fileIn(dir));
  } catch (e) { return { ok: false, error: '「啟動」資料夾寫不進去：' + String(e.message || e).slice(0, 120) }; }
  return { ok: true, on: isOn(dir), file: fileIn(dir) };
}

// The plugin's folder changes with every update, so a file written by an older
// version points at a start.js that may be gone. Called when the board starts.
function refresh(startJs, dir = startupDir()) { return isOn(dir) ? set(true, startJs, dir) : { ok: true, on: false }; }

module.exports = { isOn, set, refresh, script, startupDir, NAME };
