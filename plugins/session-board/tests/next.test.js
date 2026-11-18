'use strict';
// The "next steps" under a finished turn: which plugin commands are offered (server.js nextSteps), and when the goal2
// one is (public/index.html saysUnfinished: the turn's last reply says something is left undone).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextSteps } = require('../server');

test('next steps: offered where the plugin is installed; goal2 only from 0.6.0, which can take the goal from the conversation', () => {
  const proj = path.join(os.tmpdir(), 'sb-next-proj');
  const inst = (v) => ({ goal2: { newest: v, installs: [{ scope: 'user' }] }, 'git-commit': { newest: '1.0.0', installs: [{ scope: 'project', project: proj }] } });
  const keys = (v, folder) => nextSteps(inst(v), folder).map((n) => n.key);
  assert.deepStrictEqual(keys('0.5.8', path.join(proj, 'sub')), ['commit'], 'an older goal2 answers a bare /goal2:goal with "no task given": not offered');
  assert.deepStrictEqual(keys('0.6.0', path.join(proj, 'sub')), ['commit', 'goal']);
  assert.deepStrictEqual(keys('0.10.1', path.join(os.tmpdir(), 'elsewhere')), ['goal'], 'git-commit is installed for the project only');
  assert.strictEqual(nextSteps(inst('0.6.0'), proj).find((n) => n.key === 'goal').cmd, '/goal2:goal', 'sent bare');
});

test('the goal2 step is offered only when the last reply says something is left undone', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const part = /\/\/ <unfinished>[^\n]*\n([\s\S]*?)\/\/ <\/unfinished>/.exec(page);
  assert.ok(part, 'the page marks the part this test reads');
  const { saysUnfinished, textKey } = new Function(part[1] + '\nreturn { saysUnfinished, textKey };')();
  // the judge's key comes from the reply's text: the same with or without its id, different for another turn
  assert.strictEqual(textKey('第 9 封還沒改'), textKey('第 9 封還沒改'));
  assert.notStrictEqual(textKey('第 9 封還沒改'), textKey('第 10 封還沒改'));
  assert.strictEqual(saysUnfinished('並沒有任何未完成的項目'), false, 'a negation further back in the same clause');
  assert.strictEqual(saysUnfinished('沒有測試失敗，第 3 項還沒改'), true, 'a negation in another clause does not count');
  // a negation counts only right before the words, not as part of what the clause is about
  for (const t of ['無法登入的問題還沒修', '沒有測試的那支還沒跑', '不再報錯的那段還沒驗證']) assert.strictEqual(saysUnfinished(t), true, t);
  assert.strictEqual(saysUnfinished('目前已無任何待辦'), false);
  const left = ['第 9、10 封還沒改，剩下的明天做。', '尚未驗證 Mac 上的拖放。', '待辦：清 .bak。', '還差兩支測試。', '這幾項還沒有驗證。'];
  const none = ['已經推上 GitHub，工作區乾淨。', '測試 171 項全過。', '還沒 push，要推的話回 push。', '已修好，接下來要等同事回報。',
    '沒有未完成的項目', '已無待辦事項', '剩餘 token 還夠', '沒有剩下的事了', '目前無待辦。', ''];
  for (const t of left) assert.strictEqual(saysUnfinished(t), true, t);
  for (const t of none) assert.strictEqual(saysUnfinished(t), false, t);
  assert.strictEqual(saysUnfinished('沒有未完成的，但第 3 項還沒驗證'), true, 'one real thing left is enough');
  assert.strictEqual(saysUnfinished('還沒改'), saysUnfinished('還沒改'), 'the same answer every time (no /g lastIndex left over)');
});
