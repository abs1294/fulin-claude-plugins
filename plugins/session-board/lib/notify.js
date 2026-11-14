'use strict';
// Notifications: a Windows toast when a session finishes or needs you, and a
// click on it takes you to that session.
//
//   Stop / Notification hook (hooks/hooks.json) -> scripts/notify-hook.js
//     decides whether to notify (decide()), builds the text, shows the toast
//     (scripts/toast.ps1) with launch="sessionboard:<session id>".
//   A click -> Windows opens the sessionboard: address -> the launcher this
//     file registers -> scripts/focus-click.js -> the board: a terminal
//     session's window is brought to the front; a conversation on the board is
//     opened in the browser.
//
// What is put on the machine, and only while the setting is on:
//   HKCU\Software\Classes\sessionboard   (the address scheme; current user only)
//   ~/.claude/session-board/focus.vbs    (starts the click handler with no console window)
// The plugin's folder changes with every update, so both are rewritten each
// time the board starts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCHEME = 'sessionboard';
const DATA_DIR = path.join(os.homedir(), '.claude', 'session-board');
const VBS = path.join(DATA_DIR, 'focus.vbs');
const KEY = 'HKCU\\Software\\Classes\\' + SCHEME;

// wscript, not powershell or node directly: started from an address handler, a console program flashes a window.
function vbsText(node, script) {
  const q = (s) => '""' + s + '""';
  return 'Set a = WScript.Arguments\r\nu = ""\r\nIf a.Count > 0 Then u = a(0)\r\nCreateObject("WScript.Shell").Run "' + q(node) + ' ' + q(script) + ' " & Chr(34) & u & Chr(34), 0, False\r\n';
}

const reg = (args) => execFileSync('reg.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });

function isRegistered() { try { return reg(['query', KEY + '\\shell\\open\\command', '/ve']).includes(VBS); } catch (e) { return false; } }

function register(pluginRoot, node = process.execPath) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VBS, '﻿' + vbsText(node, path.join(pluginRoot, 'scripts', 'focus-click.js')), 'utf16le');
    reg(['add', KEY, '/ve', '/d', 'URL:Session Board', '/f']);
    reg(['add', KEY, '/v', 'URL Protocol', '/d', '', '/f']);
    reg(['add', KEY + '\\shell\\open\\command', '/ve', '/d', 'wscript.exe "' + VBS + '" "%1"', '/f']);
    return { ok: true };
  } catch (e) { return { ok: false, error: '登錄不了「點通知跳到 session」：' + String(e.message || e).slice(0, 120) }; }
}

function unregister() {
  try { reg(['delete', KEY, '/f']); } catch (e) {}
  try { fs.unlinkSync(VBS); } catch (e) {}
  return { ok: true };
}

// Someone who already has their own notification script wired into Claude Code
// (a Stop hook in ~/.claude/settings.json running a notify script) would get
// every notification twice. The plugin's hook then stays quiet.
function ownChainPresent(settingsFile = path.join(os.homedir(), '.claude', 'settings.json')) {
  try {
    const j = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const cmds = ['Stop', 'Notification'].flatMap((ev) => ((j.hooks && j.hooks[ev]) || []).flatMap((g) => (g.hooks || []).map((h) => String(h.command || ''))));
    return cmds.some((c) => /notify[\w.-]*\.(ps1|js|sh|py|cmd|bat)/i.test(c) && !c.includes('notify-hook.js'));
  } catch (e) { return false; }
}

// Whether a hook event deserves a toast, and what it says.
//   input: the hook's JSON ({session_id, cwd, message?, last_assistant_message?, hook_event_name?})
//   ctx:   {enabled, ownChain, entrypoint, onBoard, title}
// -> {show: false, why} or {show: true, title, message}
function decide(input, ctx) {
  const sid = String((input && input.session_id) || '');
  if (!/^[0-9a-f-]{8,64}$/i.test(sid)) return { show: false, why: 'no session id' };
  if (!ctx.enabled) return { show: false, why: 'turned off' };
  if (ctx.ownChain) return { show: false, why: 'another notification script is already wired in' };
  // Only sessions you opened yourself: one a program runs (a schedule, `claude -p`) finishing is not
  // something to interrupt you for. A conversation on the board is yours although the board runs it
  // through `claude -p`. No registry entry at all: notified - better one too many than one missed.
  if (ctx.entrypoint && ctx.entrypoint !== 'cli' && !ctx.onBoard) return { show: false, why: 'not a terminal session (' + ctx.entrypoint + ')' };
  const folder = String(input.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const who = ctx.title || folder || 'Claude Code';
  if (input.message) return { show: true, title: who + ' 等你回應', message: String(input.message).slice(0, 200) };
  let msg = String(input.last_assistant_message || '').replace(/```[\s\S]*?```/g, '[程式碼]').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (msg.length > 80) msg = msg.slice(0, 80) + '…';
  return { show: true, title: who + ' 完成了', message: msg || '做完了，等你指示' };
}

module.exports = { SCHEME, VBS, register, unregister, isRegistered, ownChainPresent, decide, vbsText };
