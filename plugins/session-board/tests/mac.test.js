'use strict';
// lib/mac.js on any computer: what is written, and what is handed to osascript / open / ps / launchctl (stand-ins).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../lib/mac');

const SID = '0fd8a420-f3d4-4c52-9470-6b2d036f5264';
const stand = (answers) => { const calls = []; return { calls, run: (file, args, opt, cb) => { calls.push([file].concat(args)); const a = (answers || []).shift() || {}; cb(a.err || null, a.out || '', a.errOut || ''); } }; };

test('Terminal: the .command file goes to the folder, resumes the conversation, keeps a shell; LF only', () => {
  const t = M.launcherText("/Users/amy/My Proj's", 'claude --dangerously-skip-permissions', SID, true, '接著做 "這個"\n下一行');
  const lines = t.split('\n');
  assert.strictEqual(lines[0], '#!/bin/zsh -l');
  assert.ok(lines.includes("cd '/Users/amy/My Proj'\\''s' || exit 1"), 'the folder as one quoted argument: ' + lines.join(' | '));
  assert.ok(lines.includes("'claude' '--dangerously-skip-permissions' --resume " + SID + " '接著做 \"這個\" 下一行'"), lines.join(' | '));
  // the recorded command line comes from ps, without its quoting: every word is quoted, so nothing in it is run by zsh
  const bad = M.launcherText('/x', 'claude --append-system-prompt hi; rm -rf ~ | cat > /tmp/x $(whoami)', SID, true, '').split('\n')[4];
  assert.strictEqual(bad, "'claude' '--append-system-prompt' 'hi;' 'rm' '-rf' '~' '|' 'cat' '>' '/tmp/x' '$(whoami)' --resume " + SID);
  // the program's own path is quoted too: a folder name with $( ) or ; in it is text
  assert.ok(M.launcherText('/x', '/opt/$(id);x/claude --verbose', SID, true, '').split('\n')[4].startsWith("'/opt/$(id);x/claude' '--verbose'"));
  // a path that falls apart at a space no longer ends in claude: plain claude is run instead
  assert.ok(/^claude --resume /m.test(M.launcherText('/x', '/opt/$(touch /tmp/pwned);x/claude', SID, true, '')));
  assert.ok(lines.includes('exec "${SHELL:-/bin/zsh}" -l'));
  assert.ok(/--session-id /.test(M.launcherText('/x', 'claude', SID, false, '')), 'nothing said yet: started fresh under that id');
  assert.ok(/^claude --resume /m.test(M.launcherText('/x', 'rm -rf ~', SID, true, '')), 'only claude itself is run');
  assert.ok(/^'claude' --resume /m.test(M.launcherText('/x', 'claude', SID, true, '')), 'claude alone, quoted, still runs claude');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mac-'));
  const f = M.writeLauncher(d, '/Users/amy/p', SID, 'claude', true, '');
  assert.strictEqual(path.basename(f), SID + '.command');
  assert.strictEqual(fs.readFileSync(f, 'utf8').includes('\r'), false, 'no CR: zsh would take it as part of the command');
  assert.throws(() => M.writeLauncher(d, '/x', '../evil', 'claude', true, ''));
  fs.rmSync(d, { recursive: true, force: true });
});

test('Terminal: opened with open -a Terminal; the tab found by the session tty and brought forward', async () => {
  const a = stand(); assert.deepStrictEqual(await M.openTerminal('/d/x.command', { run: a.run }), { ok: true }); assert.deepStrictEqual(a.calls, [['open', '-a', 'Terminal', '/d/x.command']]);
  const b = stand([{ err: new Error('x'), errOut: 'Unable to find application named Terminal' }]); assert.strictEqual((await M.openTerminal('/d/x.command', { run: b.run })).ok, false);
  const c = stand([{ out: 'ttys004\n' }, { out: 'hit\n' }]);
  assert.deepStrictEqual(await M.focus(4321, { run: c.run }), { state: 'hit', focused: true }, 'found = in front: the script activates Terminal');
  assert.deepStrictEqual(c.calls[0], ['ps', '-o', 'tty=', '-p', '4321']);
  assert.strictEqual(c.calls[1][0], 'osascript'); assert.strictEqual(c.calls[1][c.calls[1].length - 1], '/dev/ttys004', 'the tty is an argument, not part of the script');
  const d = stand([{ out: '??\n' }]); assert.strictEqual((await M.focus(1, { run: d.run })).state, 'miss', 'no terminal (a background process)');
});

test('notifications, folders, Finder, command lines: the values are arguments, never script text', async () => {
  const a = stand(); await M.notify('標題 "x"', 'end tell\ndo shell script "rm"', { run: a.run });
  const args = a.calls[0];
  assert.deepStrictEqual(args.slice(-2), ['標題 "x"', 'end tell\ndo shell script "rm"']);
  assert.ok(!args.slice(0, -2).some((x) => /rm/.test(x)), 'the text is not inside the AppleScript');
  const b = stand([{ out: '/Users/amy/Projects/\n' }]); assert.strictEqual(await M.pickFolder('選擇', '', { run: b.run }), '/Users/amy/Projects');
  const c = stand([{ err: new Error('User canceled.') }]); assert.strictEqual(await M.pickFolder('選擇', '', { run: c.run }), '', 'cancelled: nothing');
  const d = stand(); await M.openFile('/Users/amy/a.pdf', { run: d.run }); assert.deepStrictEqual(d.calls[0], ['open', '/Users/amy/a.pdf']);
  const e = stand(); await M.reveal(__filename, { run: e.run }); assert.deepStrictEqual(e.calls[0], ['open', '-R', __filename]);
  const g = stand([{ out: '  123 /usr/local/bin/claude --resume abc\n 4567 node /x/y.js --flag "a b"\n' }]);
  assert.deepStrictEqual(await M.commandLines([123, 4567], { run: g.run }), { 123: '/usr/local/bin/claude --resume abc', 4567: 'node /x/y.js --flag "a b"' });
  assert.deepStrictEqual(g.calls[0], ['ps', '-o', 'pid=,command=', '-p', '123,4567']);
});

test('Office preview: without LibreOffice a clear answer, not a hang', async () => {
  if (M.soffice()) return;   // this computer has it: nothing to show here
  const r = await M.convertOffice('/x/a.docx', '/x/a.pdf');
  assert.match(r.error, /LibreOffice/);
});

test('LaunchAgents: at login, and every 10 minutes for keep-alive; launchctl asked to load and unload', () => {
  const p = M.plist('com.fulin.session-board.keepalive', ['/usr/local/bin/node', '/p/start.js', '--keepalive'], '<key>StartInterval</key><integer>600</integer>');
  assert.ok(p.includes('<string>/p/start.js</string><string>--keepalive</string>') && p.includes('<integer>600</integer>') && p.includes('/opt/homebrew/bin'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-home-'));
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const ctl = []; const runSync = (file, args) => { ctl.push([file].concat(args)); return ''; };
    const on = M.setAgent('start', true, '/p/start.js', { runSync });
    assert.deepStrictEqual([on.ok, on.on, fs.existsSync(M.agentFile('start'))], [true, true, true]);
    assert.ok(fs.readFileSync(M.agentFile('start'), 'utf8').includes('<key>RunAtLoad</key><true/>'));
    assert.deepStrictEqual(ctl.map((x) => x[1]), ['unload', 'load']);
    const off = M.setAgent('start', false, '/p/start.js', { runSync });
    assert.deepStrictEqual([off.ok, off.on, M.agentOn('start')], [true, false, false]);
    const bad = M.setAgent('keep', true, '/p/start.js', { runSync: (f, a) => { if (a[0] === 'load') { const e = new Error('x'); e.stderr = Buffer.from('Load failed: 5'); throw e; } return ''; } });
    assert.deepStrictEqual([bad.ok, /Load failed/.test(bad.error)], [false, true]);
  } finally { process.env.HOME = was.HOME; process.env.USERPROFILE = was.USERPROFILE; fs.rmSync(home, { recursive: true, force: true }); }
});
