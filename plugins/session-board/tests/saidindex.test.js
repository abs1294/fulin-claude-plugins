'use strict';
// node --test plugins/session-board/tests/saidindex.test.js
// Everything said, searched (lib/saidindex.js): the middle of a conversation too; only what was added is read again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { SaidIndex, scan } = require('../lib/saidindex');
const Db = require('../lib/db');

const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const who = async (ix, q) => [...await ix.search(q)].map(([sid, x]) => [sid, x.who, x.text]);
const you = (text, more) => JSON.stringify(Object.assign({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } }, more));
const made = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'said-')), projects = path.join(d, 'projects', 'C--w'); fs.mkdirSync(projects, { recursive: true });
  const ix = new SaidIndex({ dbFile: path.join(d, 'said.db'), projectsDir: path.join(d, 'projects') });
  return { ix, put: (n, lines) => fs.writeFileSync(path.join(projects, uuid(n) + '.jsonl'), lines.join('\n') + '\n'), file: (n) => path.join(projects, uuid(n) + '.jsonl'), scan: () => scan(ix.dbFile, ix.projectsDir), done: async () => { await ix.close(); Db.close(ix.dbFile); } };
};

test('found by what you said, what Claude said, what Claude did - not by what a tool printed or was put in your place', async () => {
  const m = made();
  const claude = (content, more) => JSON.stringify(Object.assign({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content } }, more));
  m.put(1, [you('開頭'), you('幫我做星河卡的簡報 50%_off'), claude([{ type: 'text', text: '海風卡也可以' }, { type: 'tool_use', name: 'Write', input: { file_path: 'C:/w/月光卡.pptx', content: '內文不收' } }]), you([{ type: 'tool_result', tool_use_id: 'x', content: '印出來的字' }]), you('<task-notification>icash</task-notification>'), you('這是摘要 LinePay', { isCompactSummary: true }), claude([{ type: 'text', text: '側鏈說的' }], { isSidechain: true }), you('結尾')]);
  m.put(2, [you([{ type: 'text', text: 'Hello World ' + '字'.repeat(300) + ' 尾巴在這' }]), claude([{ type: 'text', text: '星河卡我也提到' }])]);
  assert.strictEqual(m.ix.ready(), false); assert.strictEqual((await m.ix.search('星河卡')).size, 0, 'nothing looked at yet');
  assert.deepStrictEqual(m.scan(), { files: 2, read: 2, failed: 0 }); assert.strictEqual(m.ix.ready(), true);
  assert.deepStrictEqual((await who(m.ix, '星河卡')).sort(), [[uuid(1), 'you', '幫我做星河卡的簡報 50%_off'], [uuid(2), 'claude', '星河卡我也提到']]);
  assert.deepStrictEqual(await who(m.ix, '海風卡'), [[uuid(1), 'claude', '海風卡也可以']]);
  assert.deepStrictEqual(await who(m.ix, '月光卡'), [[uuid(1), 'did', 'Write C:/w/月光卡.pptx']]);
  for (const q of ['內文不收', '印出來的字', 'icash', 'LinePay', '側鏈說的', '50%x', '5__', '']) assert.strictEqual((await m.ix.search(q)).size, 0, q);
  assert.ok((await m.ix.search('50%_off')).has(uuid(1)), 'taken as written'); assert.ok((await m.ix.search('hello world')).has(uuid(2)), 'any case');
  m.put(3, [claude([{ type: 'text', text: '長'.repeat(60000) + ' 長回覆的最後' }, { type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(2000) + ' 指令的最後' } }])]); m.scan();
  assert.ok((await m.ix.search('長回覆的最後')).has(uuid(3))); assert.ok((await m.ix.search('指令的最後')).has(uuid(3)));
  assert.match((await m.ix.search('尾巴在這')).get(uuid(2)).text, /^…字+ 尾巴在這$/, 'past the 200 characters a line in the list keeps');
  await m.done();
});

test('only what was added is read; half a line waits; written anew or gone is forgotten; pieces longer than a chunk', async () => {
  const m = made(), has = async (q) => (await m.ix.search(q)).size;
  m.put(1, [you('第一')]); m.put(2, [you('乙')]); m.scan();
  assert.deepStrictEqual(m.scan(), { files: 2, read: 0, failed: 0 }, 'nothing new, nothing read');
  const l = you('後來加的'); fs.appendFileSync(m.file(1), l.slice(0, 20)); m.scan(); assert.strictEqual(await has('後來加的'), 0);
  fs.appendFileSync(m.file(1), l.slice(20) + '\n'); m.scan(); assert.strictEqual(await has('後來加的'), 1);
  assert.strictEqual(Db.open(m.ix.dbFile).prepare('SELECT COUNT(*) AS n FROM said').get().n, 3, 'nothing twice');
  fs.appendFileSync(m.file(1), JSON.stringify({ type: 'assistant', pad: 'x'.repeat(9 * 1024 * 1024) }) + '\n' + you('大塊之後') + '\n'); m.scan(); assert.strictEqual(await has('大塊之後'), 1);
  m.put(1, [you('重寫')]); m.scan(); assert.deepStrictEqual([await has('第一'), await has('重寫')], [0, 1]);
  fs.unlinkSync(m.file(2)); m.scan(); assert.strictEqual(await has('乙'), 0);
  // made by another version: made again, not read wrongly
  Db.open(m.ix.dbFile).exec("UPDATE said_meta SET value = 1 WHERE key = 'version'"); assert.strictEqual(m.ix.ready(), false); m.scan(); assert.strictEqual(await has('重寫'), 1);
  await m.done();
});

test('a day: what was said between two times; it cannot be read: null, not an empty day', async () => {
  const m = made(); m.put(1, [you('今天的')]); const no = new SaidIndex({ dbFile: path.dirname(m.ix.dbFile), projectsDir: m.ix.projectsDir }); assert.strictEqual(await no.day(0, Date.now() + 1000), null); assert.strictEqual((await no.search('x')).size, 0); await no.close();
  m.scan(); assert.deepStrictEqual((await m.ix.day(0, Date.now() + 1000)).map((r) => [r.sid, r.text]), [[uuid(1), '今天的']]); assert.deepStrictEqual(await m.ix.day(0, 5), []);
  await m.done();
});

test('looked through in a process of its own, at most once a minute; words typed over are not looked for', async () => {
  const m = made(); m.put(1, [you('子程序找得到')]);
  await m.ix.refresh(); assert.strictEqual((await m.ix.search('子程序')).size, 1);
  let n = 0; m.ix.spawn = () => { n++; throw new Error('not again'); }; await m.ix.refresh(); assert.strictEqual(n, 0);
  const all = await Promise.all(['子', '子程', '子程序'].map((q) => m.ix.search(q))); assert.strictEqual(all[2].size, 1);
  await m.done();
});
