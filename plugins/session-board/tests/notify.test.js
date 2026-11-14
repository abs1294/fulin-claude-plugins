'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const N = require('../lib/notify');
const { guessTeamsSelf } = require('../lib/inbox/sources');

const SID = '11111111-2222-3333-4444-555555555555';
const on = { enabled: true, ownChain: false, entrypoint: 'cli', onBoard: false, title: '訂單交期' };

test('decide: who gets a notification, and what it says', () => {
  assert.deepStrictEqual(N.decide({ session_id: SID, cwd: 'C:\\w\\proj', last_assistant_message: '改好了，**測試** `全過`。\n```js\nx\n```' }, on), { show: true, title: '訂單交期 完成了', message: '改好了，測試 全過。 [程式碼]' });
  assert.deepStrictEqual(N.decide({ session_id: SID, cwd: 'C:\\w\\proj', message: 'Claude needs your permission to use Bash' }, on), { show: true, title: '訂單交期 等你回應', message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(N.decide({ session_id: SID, cwd: 'C:\\w\\proj' }, Object.assign({}, on, { title: '' })).title, 'proj 完成了');      // no title known: the folder
  assert.strictEqual(N.decide({ session_id: SID, last_assistant_message: 'x'.repeat(200) }, on).message.length, 81);
  // Not shown:
  assert.strictEqual(N.decide({ session_id: SID }, Object.assign({}, on, { enabled: false })).show, false);
  assert.strictEqual(N.decide({ session_id: SID }, Object.assign({}, on, { ownChain: true })).show, false);            // their own script already notifies
  assert.strictEqual(N.decide({ session_id: SID }, Object.assign({}, on, { entrypoint: 'sdk-cli' })).show, false);     // a program's run
  assert.strictEqual(N.decide({ session_id: '../x' }, on).show, false);
  // Shown although a program runs it: a conversation on the board. And a session with no registry entry.
  assert.strictEqual(N.decide({ session_id: SID }, Object.assign({}, on, { entrypoint: 'sdk-cli', onBoard: true })).show, true);
  assert.strictEqual(N.decide({ session_id: SID }, Object.assign({}, on, { entrypoint: '' })).show, true);
});

test('ownChainPresent: a notify script of your own in settings.json, but not this plugin\'s hook', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notify-'));
  const f = path.join(d, 'settings.json');
  const hooks = (cmd) => JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: cmd }] }] } });
  assert.strictEqual(N.ownChainPresent(f), false);                                                       // no file
  fs.writeFileSync(f, hooks('powershell -File C:/Users/x/.claude/notify.ps1'));
  assert.strictEqual(N.ownChainPresent(f), true);
  fs.writeFileSync(f, hooks('node "C:/p/scripts/notify-hook.js"'));
  assert.strictEqual(N.ownChainPresent(f), false);
  fs.writeFileSync(f, hooks('node C:/x/guard.js'));
  assert.strictEqual(N.ownChainPresent(f), false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('the click launcher passes the address on, quoted, with no console window', () => {
  assert.strictEqual(N.vbsText('C:\\Program Files\\nodejs\\node.exe', 'C:\\p q\\scripts\\focus-click.js'),
    'Set a = WScript.Arguments\r\nu = ""\r\nIf a.Count > 0 Then u = a(0)\r\nCreateObject("WScript.Shell").Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\p q\\scripts\\focus-click.js"" " & Chr(34) & u & Chr(34), 0, False\r\n');
});

test('the hook script itself: reads stdin, never fails, says what it decided', () => {
  const run = (input) => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'notify-hook.js'), '--dry'], { input, encoding: 'utf8' });
  const out = JSON.parse(run(JSON.stringify({ session_id: 'not-an-id' })));
  assert.deepStrictEqual(out, { show: false, why: 'no session id' });
  assert.strictEqual(JSON.parse(run('{ broken')).show, false);
});

test('Teams: which account is yours is worked out only when it is clear', () => {
  const m = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  assert.strictEqual(guessTeamsSelf(m({ a: ['me', 'x'], b: ['me', 'y'], c: ['me', 'z', 'x'], d: ['me'] })), 'me');
  assert.strictEqual(guessTeamsSelf(m({ a: ['me', 'x'], b: ['me', 'y'] })), '');                         // two conversations: too few to tell
  assert.strictEqual(guessTeamsSelf(m({ a: ['me', 'x'], b: ['me', 'x'], c: ['me', 'x'] })), '');         // someone else is in as many
  assert.strictEqual(guessTeamsSelf(m({ a: ['p', 'x'], b: ['p', 'x'], c: ['p', 'x'], d: ['p', 'y'], e: ['p'], f: ['p'] })), 'p');
  assert.strictEqual(guessTeamsSelf(new Map()), '');
});
