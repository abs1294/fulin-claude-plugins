'use strict';
// node --test plugins/session-board/tests/shell.test.js
// Commands are run for real, in a folder made for the test.
const test = require('node:test');
const assert = require('node:assert');
const WIN_ONLY = { skip: process.platform !== 'win32' && 'Windows only: Windows paths and tools (the Mac side: tests/mac.test.js, tests/mac-e2e.js)' };
const fs = require('fs');
const os = require('os');
const path = require('path');
const Shell = require('../lib/shell');
const { Channels } = require('../lib/chat');
const { EventEmitter } = require('events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-test-'));
test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const sh = Shell.findShell();
const posix = sh.kind !== 'powershell';   // bash here, sh elsewhere

test('findShell: Git Bash by the setting, by PATH, by the usual place; never the one in System32; else PowerShell', WIN_ONLY, () => {
  const only = (file) => (f) => f === file;
  assert.strictEqual(Shell.findShell({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe', PATH: '' }, only('D:\\Git\\bin\\bash.exe'), 'win32').file, 'D:\\Git\\bin\\bash.exe');
  assert.strictEqual(Shell.findShell({ PATH: 'C:\\Windows\\System32;X:\\Git\\cmd' }, only('X:\\Git\\bin\\bash.exe'), 'win32').file, 'X:\\Git\\bin\\bash.exe');
  assert.strictEqual(Shell.findShell({ PATH: '', ProgramFiles: 'C:\\Program Files' }, only('C:\\Program Files\\Git\\bin\\bash.exe'), 'win32').kind, 'bash');
  assert.strictEqual(Shell.findShell({ CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Windows\\System32\\bash.exe', PATH: 'C:\\Windows\\System32' }, () => true, 'win32').kind, 'powershell', 'that one starts the Linux subsystem');
  assert.strictEqual(Shell.findShell({ PATH: 'C:\\Windows\\System32' }, () => false, 'win32').kind, 'powershell');
  assert.strictEqual(Shell.findShell({}, () => false, 'linux').file, '/bin/sh');
});

test('run: what it printed, both outputs, its exit code, in the folder given', async () => {
  fs.writeFileSync(path.join(DIR, 'here.txt'), 'x');
  const r = await Shell.run(posix ? 'echo 中文 && ls && echo oops 1>&2 && exit 3' : 'Write-Output 中文; Get-ChildItem -Name; [Console]::Error.WriteLine("oops"); exit 3', DIR);
  assert.strictEqual(r.ok, true, 'it ran to its end, whatever the code');
  assert.strictEqual(r.code, 3);
  assert.match(r.stdout, /here\.txt/);
  assert.match(r.stderr, /oops/);
  if (posix) assert.match(r.stdout, /中文/);
  assert.strictEqual(r.shell, sh.kind);
});

test('run: no keyboard - a command that asks for input gets none and ends', async () => {
  const r = await Shell.run(posix ? 'read x; echo got=$x' : '$x = [Console]::In.ReadLine(); "got=$x"', DIR);
  assert.strictEqual(r.ok, true);
  assert.match(r.stdout, /got=\s*$/);
});

test('run: stopped at the time limit together with what it started', async () => {
  const mark = path.join(DIR, 'late.txt');
  const cmd = posix ? 'sleep 4; echo late > late.txt' : 'Start-Sleep 4; Set-Content late.txt late';
  const t0 = Date.now();
  const r = await Shell.run(cmd, DIR, { timeLimit: 1000 });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.timedOut, true); assert.match(r.error, /已經停掉/);
  assert.ok(Date.now() - t0 < 4000, 'it does not wait for the command to finish by itself');
  await new Promise((res) => setTimeout(res, 4500));
  assert.strictEqual(fs.existsSync(mark), false, 'what it was running was stopped too');
});

test('run: a shell that is not there is said, not thrown', async () => {
  const r = await Shell.run('x', DIR, { shell: { kind: 'bash', file: path.join(DIR, 'no-such-shell.exe'), args: (c) => ['-c', c] } });
  assert.strictEqual(r.ok, false); assert.match(String(r.error), /找不到|ENOENT/);
});

test('noteText: the form a terminal session uses; long output keeps its end', () => {
  assert.strictEqual(Shell.noteText([{ command: 'git status', stdout: 'clean\n', stderr: '' }]), '<bash-input>git status</bash-input>\n<bash-stdout>clean\n</bash-stdout><bash-stderr></bash-stderr>');
  const long = Shell.noteText([{ command: 'x', stdout: 'a'.repeat(Shell.NOTE_LIMIT) + 'THE END', stderr: '' }]);
  assert.ok(long.includes('THE END') && long.length < Shell.NOTE_LIMIT + 200);
  assert.strictEqual(Shell.noteText([]), '');
});

test('Channels: what you ran goes in front of your next message, once; dropped notes do not; the title is your words', () => {
  const made = [];
  const spawn = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = Object.assign(new EventEmitter(), { written: [], write(s) { this.written.push(JSON.parse(s)); return true; }, end() {} }); p.kill = () => {}; made.push(p); return p; };
  const ch = new Channels(path.join(DIR, 'c.json'), { spawn, transcriptOf: () => null });
  const c = ch.create(DIR);
  assert.strictEqual(ch.noteShell('no-such', { command: 'x' }), null);
  const a = ch.noteShell(c.sessionId, { command: 'echo password=hunter2', stdout: 'password=hunter2\n', stderr: '' });
  const b = ch.noteShell(c.sessionId, { command: 'git status', stdout: 'clean\n', stderr: '' });
  assert.strictEqual(ch.dropShell(c.sessionId, a), true);
  assert.strictEqual(ch.dropShell(c.sessionId, a), false);
  ch.send(c.sessionId, '請看一下狀態');
  const textOf = (m) => (typeof m.message.content === 'string' ? m.message.content : m.message.content.map((x) => x.text || '').join(''));
  const first = textOf(made[0].stdin.written.find((x) => x.type === 'user'));
  assert.ok(first.startsWith('<bash-input>git status</bash-input>') && first.endsWith('請看一下狀態'), first);
  assert.ok(!first.includes('hunter2'));
  assert.strictEqual(c.title, '請看一下狀態');
  ch.send(c.sessionId, '第二句');
  const users = made[0].stdin.written.filter((x) => x.type === 'user');
  assert.strictEqual(textOf(users[users.length - 1]), '第二句', 'not repeated');
  assert.ok(b > a);
  for (let i = 0; i < 14; i++) ch.noteShell(c.sessionId, { command: 'c' + i, stdout: '', stderr: '' });
  assert.strictEqual(c.shellNotes.length, 10, 'at most ten are kept');
  assert.strictEqual(ch.dropShell(c.sessionId, null), true);
  assert.strictEqual(c.shellNotes.length, 0);
  if (ch.shutdown) ch.shutdown();
});

test('Channels: what you ran and have not sent is told to the page and survives a restart of the board', () => {
  const file = path.join(DIR, 'keep.json');
  const spawn = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = Object.assign(new EventEmitter(), { write() { return true; }, end() {} }); p.kill = () => {}; return p; };
  const page = () => ({ events: [], write(s) { const m = /^data: (.*)\n\n$/.exec(s); if (m) this.events.push(JSON.parse(m[1])); }, end() {}, on() {} });
  const shells = (res) => res.events.filter((e) => e.type === 'shell').map((e) => e.notes.map((n) => n.command));
  const ch = new Channels(file, { spawn, transcriptOf: () => null });
  const c = ch.create(DIR);
  assert.strictEqual(ch.isEmpty(c), true);
  const res = page(); ch.subscribe(c.sessionId, res);
  assert.deepStrictEqual(shells(res), [[]], 'told on opening, also when there is nothing');
  const a = ch.noteShell(c.sessionId, { command: 'git status', stdout: 'x'.repeat(Shell.NOTE_LIMIT + 50) + 'END', stderr: '', code: 0 });
  ch.noteShell(c.sessionId, { command: 'ls', stdout: 'a\n', stderr: '', code: 0 });
  assert.deepStrictEqual(shells(res).slice(-1), [['git status', 'ls']]);
  assert.strictEqual(ch.isEmpty(c), false, 'not thrown away as an unused conversation while it holds something');
  assert.ok(c.shellNotes[0].stdout.length === Shell.NOTE_LIMIT && c.shellNotes[0].stdout.endsWith('END'), 'kept at the size it will be handed over in');

  // the board is started again: the same file
  const again = new Channels(file, { spawn, transcriptOf: () => null });
  const c2 = again.get(c.sessionId);
  assert.deepStrictEqual(c2.shellNotes.map((n) => n.command), ['git status', 'ls']);
  const res2 = page(); again.subscribe(c.sessionId, res2);
  assert.deepStrictEqual(shells(res2), [['git status', 'ls']], 'a page opened after the restart is shown them');
  assert.ok(again.noteShell(c.sessionId, { command: 'pwd', stdout: '', stderr: '', code: 0 }) > a + 1, 'numbering goes on, so a card is never taken for another');
  assert.strictEqual(again.dropShell(c.sessionId, a), true);
  assert.deepStrictEqual(shells(res2).slice(-1), [['ls', 'pwd']]);
  again.send(c.sessionId, '看一下');
  assert.deepStrictEqual(shells(res2).slice(-1), [[]], 'handed over with the message: nothing is held any more');
  assert.strictEqual(new Channels(file, { spawn, transcriptOf: () => null }).get(c.sessionId).shellNotes, undefined);
  if (ch.shutdown) ch.shutdown(); if (again.shutdown) again.shutdown();
});
