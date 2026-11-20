'use strict';
// 外掛整合分析 (lib/pluginfit.js, server.js /api/pluginfit): what the analysis is handed and may answer, what is
// installed and how, through the board's addresses (tests/routes.test.js) - no real Claude Code run, no real install.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../lib/pluginfit');

const SRC = {
  ok: true, skill: '# Setup Plugins\n步驟 4 偵測專案',
  profiles: { dotnet: { description: '.NET', enable: { 'csharp-lsp@official': true, 'old@official': false } } },
  library: { 'harness@fulin-plugins': '工作規則學習', 'git-commit@fulin-plugins': 'commit 流程' },
  recommends: { 'codex@openai-codex': { source: 'openai/codex-plugin-cc', note: '委派給 Codex' }, 'ui@coll': { source: 'https://x/y', note: '裸 skill', installMethod: 'skill-copy' } },
};

test('the candidates: profile (switched on only), library, kept list; the answer kept to them', () => {
  const c = F.candidates(SRC);
  assert.deepStrictEqual([...c.keys()].sort(), ['codex@openai-codex', 'csharp-lsp@official', 'git-commit@fulin-plugins', 'harness@fulin-plugins', 'ui@coll']);
  assert.ok(!c.has('old@official'), 'switched off in its profile: never offered');
  const have = new Set(['git-commit@fulin-plugins']);
  const r = F.readResult('好的：\n{"confident":true,"profile":"dotnet","summary":"C# 專案","plugins":[{"ref":"csharp-lsp@official","why":"C# 補全"},{"ref":"git-commit@fulin-plugins","why":"已經有"},{"ref":"made-up@nowhere","why":"x"},{"ref":"rm -rf /","why":"x"},{"ref":"csharp-lsp@official","why":"twice"}],"skip":[{"ref":"codex@openai-codex","why":"沒有 Codex"}]}', c, have);
  assert.deepStrictEqual(r.plugins.map((x) => x.ref), ['csharp-lsp@official'], 'not already there, not made up, not twice, nothing shaped otherwise');
  assert.deepStrictEqual([r.confident, r.profile, r.summary, r.skip.map((x) => x.ref)], [true, 'dotnet', 'C# 專案', ['codex@openai-codex']]);
  assert.strictEqual(F.readResult('沒有 JSON', c, have), null);
});

test('what a folder has: installed for you, for it, or switched on in its settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  fs.mkdirSync(path.join(dir, '.claude')); fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false } }));
  const all = { 'u@m': [{ scope: 'user', project: '' }], 'p@m': [{ scope: 'project', project: dir.toUpperCase() + path.sep }], 'q@m': [{ scope: 'project', project: path.join(dir, 'other') }] };
  assert.deepStrictEqual([...F.present(dir, all)].sort(), ['a@m', 'p@m', 'u@m']);
  // installed for you but switched off in the folder: not there; the local file has the last word
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'u@m': false, 'p@m': false } }));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'p@m': true } }));
  assert.deepStrictEqual([...F.present(dir, all)].sort(), ['p@m']);
  assert.ok(F.installedFor(all['p@m'], dir) && !F.installedFor(all['q@m'], dir));
});

test('the analysis: handed the skill, the lists and what is there; asked to only read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  let asked = null;
  const explain = async (cwd, prompt, o) => { asked = { cwd, prompt, o }; return { ok: true, answer: '{"confident":false,"profile":null,"summary":"看不出來","plugins":[{"ref":"harness@fulin-plugins","why":"規則"}],"skip":[]}', cost: 0.2 }; };
  const r = await F.analyze(dir, { sources: SRC, installs: { 'git-commit@fulin-plugins': [{ scope: 'user' }] }, explain, run: (b, a, o, cb) => cb(new Error('not git')) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.result.plugins.map((x) => [x.ref, x.from]), [['harness@fulin-plugins', '你的 plugin 庫']]);
  assert.strictEqual(asked.cwd, dir);
  for (const s of ['# Setup Plugins', 'csharp-lsp@official', 'codex@openai-codex', 'harness@fulin-plugins', 'git-commit@fulin-plugins', '不要安裝任何東西']) assert.ok(asked.prompt.includes(s), s);
  assert.ok(asked.o.timeLimit >= 60000);
  assert.deepStrictEqual(await F.analyze(dir, { sources: Object.assign({}, SRC, { ok: false }), explain }), { ok: false, error: '找不到 plugin-manager 的 setup-plugins skill：這台電腦要先裝 plugin-manager' });
});

test('installing: a missing marketplace added from its source, project scope, a skill-copy one not', async () => {
  const ran = [];
  const run = (bin, args, o, cb) => { ran.push(args.join(' ')); if (args[1] === 'marketplace' && args[2] === 'list') return cb(null, JSON.stringify([{ name: 'fulin-plugins' }]), ''); if (args.includes('bad@fulin-plugins')) return cb(new Error('exit 1'), '', 'Plugin not found'); cb(null, 'ok', ''); };
  const c = F.candidates(SRC);
  const items = ['harness@fulin-plugins', 'codex@openai-codex', 'ui@coll'].map((r) => c.get(r)).concat([{ ref: 'bad@fulin-plugins' }, { ref: 'x@unknown-mk' }]);
  const out = await F.apply('C:/proj', items, { run });
  assert.deepStrictEqual(out.map((x) => [x.ref, x.ok]), [['harness@fulin-plugins', true], ['codex@openai-codex', true], ['ui@coll', false], ['bad@fulin-plugins', false], ['x@unknown-mk', false]]);
  assert.deepStrictEqual(ran, ['plugin marketplace list --json', 'plugin install harness@fulin-plugins --scope project', 'plugin marketplace add openai/codex-plugin-cc', 'plugin install codex@openai-codex --scope project', 'plugin install bad@fulin-plugins --scope project']);
  assert.match(out[3].note, /Plugin not found/);
  assert.match(out[4].note, /還沒加入 unknown-mk/);
});

test('a question about the analysis: the analysis and earlier questions handed along; the list changed only from the candidates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  const st = { result: { confident: true, profile: 'dotnet', read: ['CLAUDE.md'], summary: 'C# 專案', plugins: [{ ref: 'csharp-lsp@official', from: 'profile dotnet', note: '', why: 'C#' }], skip: [{ ref: 'codex@openai-codex', from: '推薦清單', note: '', why: '沒有 Codex' }] }, thread: [{ q: '第一個問題', a: '第一個回答' }] };
  let asked = '';
  const run = (b, a, o, cb) => cb(new Error('not git'));
  const say = (answer) => async (cwd, prompt) => { asked = prompt; return { ok: true, answer, cost: 0.1 }; };
  const a = await F.ask(dir, st, '把 codex 加進來', { sources: SRC, installs: {}, run, explain: say('{"answer":"好，加了 codex。","plugins":[{"ref":"csharp-lsp@official","why":"C#"},{"ref":"codex@openai-codex","why":"第二意見"},{"ref":"made-up@x","why":"x"}]}') });
  for (const s of ['C# 專案', '第一個問題', '第一個回答', '把 codex 加進來', '# Setup Plugins']) assert.ok(asked.includes(s), s);
  assert.deepStrictEqual([a.ok, a.answer, a.result.plugins.map((x) => x.ref)], [true, '好，加了 codex。', ['csharp-lsp@official', 'codex@openai-codex']], 'a name not in the lists is dropped');
  assert.strictEqual(a.result.summary, 'C# 專案', 'the rest of the analysis stays');
  const b = await F.ask(dir, st, '為什麼？', { sources: SRC, installs: {}, run, explain: say('{"answer":"因為 .sln。","plugins":null}') });
  assert.deepStrictEqual([b.answer, b.result], ['因為 .sln。', undefined], 'nothing to change: the list stays');
  const c = await F.ask(dir, st, '為什麼？', { sources: SRC, installs: {}, run, explain: say('不是 JSON 的回答') });
  assert.deepStrictEqual([c.ok, c.answer, c.result], [true, '不是 JSON 的回答', undefined], 'not the JSON asked for: still the answer');
});

test('a name starting with "-" is never one: it would go into the install command as an option', () => {
  assert.ok(!F.REF.test('-x@y') && !F.REF.test('x@-y') && F.REF.test('a-b@c.d'));
  const c = new Map([['-x@y', { ref: '-x@y' }], ['ok@m', { ref: 'ok@m' }]]);
  assert.deepStrictEqual(F.readResult('{"plugins":[{"ref":"-x@y"},{"ref":"ok@m"}]}', c, new Set()).plugins.map((x) => x.ref), ['ok@m']);
});
