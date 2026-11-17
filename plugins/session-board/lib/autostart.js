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

const MAC = process.platform === 'darwin';
const Mac = MAC ? require('./mac') : null;
// On a Mac: a LaunchAgent (~/Library/LaunchAgents/com.fulin.session-board.plist, RunAtLoad) instead of the Startup folder.
function isOn(dir = startupDir()) {
  if (MAC && !dir) return Mac.agentOn('start'); try { return !!dir && fs.existsSync(fileIn(dir)); } catch (e) { return false; } }

function set(on, startJs, dir = startupDir(), node = process.execPath) {
  if (MAC && !dir) return Mac.setAgent('start', on, startJs);   // a folder given (the tests): only that folder, as on Windows
  if (!dir) return { ok: false, error: '找不到 Windows 的「啟動」資料夾' };
  try {
    if (on) fs.writeFileSync(fileIn(dir), '﻿' + script(node, startJs), 'utf16le');
    else if (fs.existsSync(fileIn(dir))) fs.unlinkSync(fileIn(dir));
  } catch (e) { return { ok: false, error: '「啟動」資料夾寫不進去：' + String(e.message || e).slice(0, 120) }; }
  return { ok: true, on: isOn(dir), file: fileIn(dir) };
}

// The plugin's folder changes with every update, so a file written by an older
// version points at a start.js that may be gone. Called when the board starts.
function refresh(startJs, dir = startupDir()) {
  if (MAC && !dir) return Mac.agentOn('start') ? Mac.setAgent('start', true, startJs) : { ok: true, on: false }; return isOn(dir) ? set(true, startJs, dir) : { ok: true, on: false }; }

// What the settings page shows as the file: the LaunchAgent on a Mac.
const fileShown = () => (MAC ? Mac.agentFile('start') : path.join(startupDir(), NAME));
module.exports = { isOn, set, refresh, script, startupDir, NAME, fileShown };
