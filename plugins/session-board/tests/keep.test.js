'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../lib/keep');
const autostart = require('../lib/autostart');
const config = require('../lib/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-keep-'));
const A = { sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', cwd: 'C:\\w\\a', title: 'A', pid: 11 };
const B = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000002', cwd: 'C:\\w\\b', title: 'B', pid: 22 };
const GRACE = 90000;

test('a session closed while the board keeps running stops being kept', () => {
  const dir = tmp(), file = path.join(dir, 'keep.json');
  const k = new K.Keeper(file);
  k.observe([A, B], 1000);
  assert.strictEqual(k.isKept(A.sessionId), true);
  k.observe([B], 2000);                       // A is gone
  assert.strictEqual(k.isKept(A.sessionId), true, 'not decided yet: the machine may be going down');
  k.observe([B], 2000 + GRACE);               // the board is still here a grace period later
  assert.strictEqual(k.isKept(A.sessionId), false);
  assert.deepStrictEqual(k.recentlyClosed().map((x) => x.title), ['A']);
  // After a restart it is not offered for restoring.
  const next = new K.Keeper(file);
  next.observe([B], 500000);
  assert.deepStrictEqual(next.restorable(), []);
  assert.deepStrictEqual(next.recentlyClosed().map((x) => x.title), ['A']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sessions that were open when the board stopped are offered after a restart', () => {
  const dir = tmp(), file = path.join(dir, 'keep.json');
  const k = new K.Keeper(file);
  k.observe([A, B], 1000);
  k.setCommand(A.sessionId, 'claude -c --dangerously-skip-permissions --append-system-prompt "use; this & that"');
  // Shutdown: the terminals go a few seconds before the board does.
  k.observe([], 5000);
  k.observe([], 9000);
  // ... the board is gone. Next start:
  const next = new K.Keeper(file);
  assert.deepStrictEqual(next.restorable(), []);                                 // before its first look it offers nothing: it cannot yet tell open from not open
  next.observe([], 900000);
  const r = next.restorable();
  assert.deepStrictEqual(r.map((x) => x.title).sort(), ['A', 'B']);
  assert.strictEqual(r.find((x) => x.title === 'A').command, 'claude --dangerously-skip-permissions --append-system-prompt "use; this & that"');
  assert.strictEqual(r.find((x) => x.title === 'B').command, 'claude');
  // Still offered however long the board then runs: it never saw them alive, so it cannot call them "closed".
  next.observe([], 900000 + 10 * GRACE);
  assert.strictEqual(next.restorable().length, 2);
  // One comes back (restored): no longer offered. The other is dismissed.
  next.markRestoring(A.sessionId);
  assert.deepStrictEqual(next.restorable().map((x) => x.title), ['B']);
  assert.strictEqual(next.forget([B.sessionId]), 1);
  assert.deepStrictEqual(next.restorable(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the switch: off stays off while the session is open, and on brings a closed one back', () => {
  const dir = tmp(), file = path.join(dir, 'keep.json');
  const k = new K.Keeper(file);
  k.observe([A], 1000);
  assert.strictEqual(k.setKeep(A.sessionId, false), true);
  k.observe([A], 2000);
  assert.strictEqual(k.isKept(A.sessionId), false, 'observing an open session does not undo the user\'s choice');
  const next = new K.Keeper(file);
  assert.deepStrictEqual(next.restorable(), [], 'switched off: not restored');
  k.setKeep(A.sessionId, true);
  assert.strictEqual(k.isKept(A.sessionId), true);
  assert.strictEqual(k.setKeep('nope', true), false);
  // Closed, then opened again by hand: kept again, by the default rule.
  k.observe([], 3000); k.observe([], 3000 + GRACE);
  assert.strictEqual(k.isKept(A.sessionId), false);
  k.observe([A], 3000 + GRACE + 1000);
  assert.strictEqual(k.isKept(A.sessionId), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('observe asks for the command line only of sessions it has none for', () => {
  const dir = tmp();
  const k = new K.Keeper(path.join(dir, 'keep.json'));
  assert.deepStrictEqual(k.observe([A, B], 1000).map((n) => n.pid), [11, 22]);
  k.setCommand(A.sessionId, 'C:\\bin\\claude.exe --resume ' + A.sessionId + ' --model opus');
  assert.deepStrictEqual(k.observe([A, B], 2000).map((n) => n.pid), [22]);
  assert.strictEqual(k.get(A.sessionId).command, 'C:\\bin\\claude.exe --model opus');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withName: the fixed name in place of the one it was started with, everything else as it was', () => {
  assert.strictEqual(K.withName('claude --model opus', 'S1-x'), 'claude --model opus --name S1-x');
  const known = new Set(['S1-x', 'S2-y', 'old name']);
  assert.strictEqual(K.withName('claude -n "old name" --model opus', 'S1-x', known), 'claude --model opus --name S1-x');
  assert.strictEqual(K.withName('claude --name=S2-y --x', 'S1-x', known), 'claude --x --name S1-x');
  assert.strictEqual(K.withName('claude --name S2-y --x', '', known), 'claude --x', 'another session\'s: not carried over to one without a name');
  assert.strictEqual(K.withName('claude --name mine', '', known), 'claude --name mine', 'your own: as typed');
  assert.strictEqual(K.withName('claude --append-system-prompt 用 -n 選項 做', 'S1-x', known), 'claude --append-system-prompt 用 -n 選項 做 --name S1-x', 'a Mac\'s ps gives no quotes');
  assert.strictEqual(K.withName('node cli.js', 'S1-x', known), 'claude --name S1-x', 'not claude: what the launchers fall back to, with the name');
  assert.strictEqual(K.withName('claude --append-system-prompt "a -n b"', 'S1-x'), 'claude --append-system-prompt "a -n b" --name S1-x');
  assert.strictEqual(K.withName(K.withName('claude', 'S1-x', known), 'S1-x', known), 'claude --name S1-x', 'kept and restored again: once');
  assert.strictEqual(K.withName('', 'S1-x'), 'claude --name S1-x');
  assert.ok(K.launcherText('claude --name 合作1-x', '11111111-2222-3333-4444-555555555555', true).includes('claude --name 合作1-x --resume'));
});

test('launchCommand drops what chose the conversation and keeps everything else as typed', () => {
  assert.strictEqual(K.launchCommand('claude -c --x'), 'claude --x');
  assert.strictEqual(K.launchCommand('claude --resume'), 'claude');
  assert.strictEqual(K.launchCommand('claude -r abc --session-id=zz --fork-session --append-system-prompt "a  b -c"'), 'claude --append-system-prompt "a  b -c"');
  assert.strictEqual(K.launchCommand('"C:\\Program Files\\c\\claude.exe" --continue'), '"C:\\Program Files\\c\\claude.exe"');
  assert.strictEqual(K.launchCommand(''), 'claude');
});

test('the launcher file: one safe line, and never a program other than claude', () => {
  const sid = A.sessionId;
  assert.strictEqual(K.batchLine('claude --p "100% a & b" x&y\nz'), 'claude --p "100%% a & b" x^&y z');
  assert.match(K.launcherText('claude --p "q"', sid, true), /^@echo off\r\nchcp 65001 >nul\r\nclaude --p "q" --resume aaaaaaaa-0000-0000-0000-000000000001\r\n$/);
  assert.match(K.launcherText('calc.exe --p', sid, false), /\r\nclaude --session-id aaaaaaaa/);
  assert.throws(() => K.writeLauncher(os.tmpdir(), '..\\evil', 'claude', true));
});

test('cleanEnv removes the "inside a session" variables and nothing else', () => {
  const out = K.cleanEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_PID: '1', CLAUDE_JOB_DIR: 'd', CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_GIT_BASH_PATH: 'g', ANTHROPIC_API_KEY: 'k' });
  assert.deepStrictEqual(Object.keys(out).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_NO_FLICKER', 'PATH']);
});

test('autostart writes and removes one file in the given startup folder', () => {
  const dir = tmp();
  assert.strictEqual(autostart.isOn(dir), false);
  const r = autostart.set(true, 'C:\\p q\\start.js', dir, 'C:\\node\\node.exe');
  assert.strictEqual(r.on, true);
  const text = fs.readFileSync(path.join(dir, autostart.NAME), 'utf16le');
  assert.strictEqual(text, '\ufeffCreateObject("WScript.Shell").Run """C:\\node\\node.exe"" ""C:\\p q\\start.js""", 0, False\r\n');
  assert.strictEqual(autostart.refresh('C:\\new\\start.js', dir).on, true);
  assert.match(fs.readFileSync(path.join(dir, autostart.NAME), 'utf16le'), /C:\\new\\start\.js/);
  assert.strictEqual(autostart.set(false, 'x', dir).on, false);
  assert.strictEqual(autostart.refresh('x', dir).on, false);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config keeps autoRestore as a strict on/off', () => {
  const dir = tmp(), file = path.join(dir, 'board.db');
  assert.strictEqual(config.load(file, path.join(dir, 'none.json')).autoRestore, false);
  assert.strictEqual(config.save({ autoRestore: 'yes' }, file).ok, false);
  assert.strictEqual(config.save({ autoRestore: true }, file).config.autoRestore, true);
  assert.strictEqual(config.save({ pickerStartDir: '' }, file).config.autoRestore, true, 'saving another setting leaves it alone');
  assert.strictEqual(config.save({ autoRestore: false }, file).config.autoRestore, false);
  require('../lib/db').close(file);
  fs.rmSync(dir, { recursive: true, force: true });
});
