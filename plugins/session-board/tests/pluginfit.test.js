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

test('installing: a list of many marketplaces is read whole; one that cannot be read is not taken for none', async () => {
  const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ name: i === 3 ? 'fulin-plugins' : 'other-' + i, source: 'github', repo: 'someone/with-a-long-name-' + i, installLocation: 'C:\\Users\\x\\.claude\\plugins\\marketplaces\\other-' + i })), null, 2);
  assert.ok(many.length > 1200);
  for (const list of [many, 'not json']) {
    const ran = [];
    const run = (bin, args, o, cb) => { ran.push(args.join(' ')); cb(null, args[2] === 'list' ? list : 'done', ''); };
    const r = await F.apply('C:/w', [{ ref: 'wtf@fulin-plugins' }, { ref: 'harness@fulin-plugins' }], { run });
    assert.deepStrictEqual(r, [{ ref: 'wtf@fulin-plugins', ok: true, note: '' }, { ref: 'harness@fulin-plugins', ok: true, note: '' }], list.slice(0, 20));
    assert.deepStrictEqual(ran, ['plugin marketplace list --json', 'plugin install wtf@fulin-plugins --scope project', 'plugin install harness@fulin-plugins --scope project'], 'asked once');
  }
  const none = await F.apply('C:/w', [{ ref: 'x@nowhere' }], { run: (bin, args, o, cb) => cb(null, many, '') });
  assert.deepStrictEqual([none[0].ok, /還沒加入 nowhere/.test(none[0].note)], [false, true], 'one that is really missing');
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

test('the recommend list: changed only through plugin-manager\'s register-external.js, its arguments checked first', async () => {
  if (!F.recommends().writable) return;   // (a computer without plugin-manager's monorepo: nothing to change)
  const ran = [];
  const run = (exe, args, o, cb) => { ran.push(args.slice(1)); cb(null, 'ok', ''); };
  assert.deepStrictEqual(await F.saveRecommend({ key: 'x@m', source: 'o/r', note: '做什麼', tags: 'a, b', installMethod: 'skill-copy' }, { run }), { ok: true, out: 'ok' });
  assert.deepStrictEqual(ran.pop(), ['x@m', 'o/r', '做什麼', '--tags', 'a,b', '--install-method', 'skill-copy']);
  assert.deepStrictEqual(await F.saveRecommend({ remove: 'x@m' }, { run }), { ok: true, out: 'ok' });
  assert.deepStrictEqual(ran.pop(), ['--remove', 'x@m']);
  for (const bad of [{ key: '-x@m', source: 'o/r', note: 'n' }, { key: 'x@m', source: '', note: 'n' }, { key: 'x@m', source: 'o/r', note: '--tags evil' }, { remove: 'not a name' }]) assert.strictEqual((await F.saveRecommend(bad, { run })).ok, false, JSON.stringify(bad));
  assert.strictEqual(ran.length, 0, 'nothing run for those');
  const r = F.recommends(); assert.ok(Array.isArray(r.items) && r.items.every((x) => F.REF.test(x.key) || x.key.includes('@')));
});

test('an overall weighing: what to take away is only ever something this folder has', () => {
  const c = F.candidates(SRC);
  const have = new Set(['git-commit@fulin-plugins', 'cbm-guard@fulin-plugins']);
  const r = F.readResult('{"plugins":[],"skip":[],"reconsider":[{"ref":"cbm-guard@fulin-plugins","why":"重疊"},{"ref":"not-here@x","why":"x"},{"ref":"cbm-guard@fulin-plugins","why":"twice"}]}', c, have);
  assert.deepStrictEqual(r.reconsider, [{ ref: 'cbm-guard@fulin-plugins', why: '重疊' }]);
  assert.deepStrictEqual(F.readResult('{"plugins":[]}', c, have).reconsider, [], 'none said: none');
});

test('a plugin the folder\'s own settings switch off is never recommended back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'harness@fulin-plugins': false, 'codex@openai-codex': false } }));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'codex@openai-codex': true } }));
  const off = F.switchedOff(dir);
  assert.deepStrictEqual([...off], ['harness@fulin-plugins'], 'the local file has the last word');
  const r = F.readResult('{"plugins":[{"ref":"harness@fulin-plugins","why":"x"},{"ref":"codex@openai-codex","why":"y"}],"skip":[{"ref":"harness@fulin-plugins","why":"刻意關掉"}]}', F.candidates(SRC), new Set(), off);
  assert.deepStrictEqual([r.plugins.map((x) => x.ref), r.skip.map((x) => x.ref)], [['codex@openai-codex'], ['harness@fulin-plugins']], 'not recommended; may still be said why not');
  assert.ok(F.prompt(dir, SRC, new Set(), '', off).includes('harness@fulin-plugins'), 'the analysis is told');
});

test('a skill-copy entry is installed by copying its one folder from GitHub into the project (git stood in for)', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  const ran = [];
  // a stand-in git: the clone makes the folder with a SKILL.md in it
  const run = (exe, args, o, cb) => { if (args[0] === 'ls-remote') return cb(null, 'abc\trefs/heads/master\n', ''); if (args.includes('ls-files')) return cb(null, '100644 a 0\t' + args[args.length - 1] + '/SKILL.md\n', ''); if (args.includes('rev-parse')) return cb(null, 'abc\n', ''); ran.push(args.join(' ')); if (args[0] === 'clone') { const repo = args[args.length - 1]; fs.mkdirSync(path.join(repo, 'huashu-slides', 'scripts'), { recursive: true }); fs.writeFileSync(path.join(repo, 'huashu-slides', 'SKILL.md'), '# x'); fs.mkdirSync(path.join(repo, '.git')); } cb(null, '', ''); };
  const x = { ref: 'huashu-slides@huashu-skills', skillCopy: true, source: 'https://github.com/alchaincyf/huashu-skills/tree/master/huashu-slides' };
  const out = await F.apply(proj, [x], { run });
  assert.strictEqual(out[0].ok, true, JSON.stringify(out));
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'skills', 'huashu-slides', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'skills', 'huashu-slides', '.git')));
  assert.ok(ran[0].startsWith('clone --depth 1 --filter=blob:none --sparse --config core.symlinks=false --branch master https://github.com/alchaincyf/huashu-skills.git'), ran[0]);
  assert.match(ran[1], /sparse-checkout set --no-cone \/huashu-slides\//);
  // there already: not overwritten; not a GitHub folder, or climbing out: not fetched at all
  ran.length = 0;
  assert.match((await F.apply(proj, [x], { run }))[0].note, /不覆蓋/);
  assert.match((await F.apply(proj, [Object.assign({}, x, { ref: 'a@b', source: 'https://example.com/x' })], { run }))[0].note, /不是 GitHub/);
  assert.match((await F.apply(proj, [Object.assign({}, x, { ref: 'c@b', source: 'https://github.com/a/b/tree/main/../etc' })], { run }))[0].note, /不是 GitHub/);
  assert.match((await F.apply(proj, [Object.assign({}, x, { ref: 'd@b', source: 'https://github.com/a/b/tree/../x/skills' })], { run }))[0].note, /不是 GitHub/);
  assert.deepStrictEqual(ran, [], 'nothing fetched for those');
});

test('a branch with slashes in it: the longest of the repository branches and tags the address starts with', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  const ran = [];
  // a tag "feature" and a branch "feature/x" both there: feature/x is meant
  const listed = 'a\trefs/heads/main\nb\trefs/tags/feature\nb2\trefs/tags/feature^{}\nc\trefs/heads/feature/x\n';
  const run = (exe, args, o, cb) => {
    if (args[0] === 'ls-remote') { ran.push('ask ' + args.slice(4).join(' ')); return cb(null, listed, ''); }
    if (args.includes('ls-files')) { ran.push('list ' + args[args.length - 1]); return cb(null, '100644 a 0\t' + args[args.length - 1] + '/SKILL.md\n', ''); }
    if (args.includes('rev-parse')) return cb(null, 'c\n', '');
    ran.push(args[0] === 'clone' ? 'clone ' + args[args.indexOf('--branch') + 1] : args.slice(-1)[0]);
    if (args[0] === 'clone') { const repo = args[args.length - 1]; fs.mkdirSync(path.join(repo, 'skills', 'deck'), { recursive: true }); fs.writeFileSync(path.join(repo, 'skills', 'deck', 'SKILL.md'), '# x'); }
    cb(null, '', '');
  };
  const out = await F.apply(proj, [{ ref: 'deck@coll', skillCopy: true, source: 'https://github.com/o/r/tree/feature/x/skills/deck' }], { run });
  assert.strictEqual(out[0].ok, true, JSON.stringify(out));
  // only the names the address could mean are asked for
  assert.deepStrictEqual(ran, ['ask refs/heads/feature refs/tags/feature refs/tags/feature^{} refs/heads/feature/x refs/tags/feature/x refs/tags/feature/x^{} refs/heads/feature/x/skills refs/tags/feature/x/skills refs/tags/feature/x/skills^{}', 'clone feature/x', '/skills/deck/', 'list skills/deck']);
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'skills', 'deck', 'SKILL.md')));
  // more than three segments
  assert.deepStrictEqual(F.branchOf(F.GH_TREE.exec('https://github.com/o/r/tree/team/a/b/c/skills/deck'), 'x\trefs/heads/team/a/b/c\n'), ['team/a/b/c', 'skills/deck', 'x']);
  // none of them there
  assert.strictEqual(F.branchOf(F.GH_TREE.exec('https://github.com/o/r/tree/gone/skills/deck'), listed), null);
  // + = @ , ! are in branch and folder names too; * ? [ are not taken
  assert.deepStrictEqual(F.branchOf(F.GH_TREE.exec('https://github.com/o/r/tree/feature/fix+login/skills/a=b'), 'x\trefs/heads/feature/fix+login\n'), ['feature/fix+login', 'skills/a=b', 'x']);
  for (const u of ['https://github.com/o/r/tree/main/sk*lls', 'https://github.com/o/r/tree/main/a?b', 'https://github.com/o/r/tree/main/[a]']) assert.strictEqual(F.GH_TREE.exec(u), null, u);
  // a branch and a tag of one name: the branch, with its commit; a tag alone: its own commit (the ^{} line)
  const both = 'h1\trefs/heads/release\nt1\trefs/tags/release\nt2\trefs/tags/release^{}\nv1\trefs/tags/v1\nv2\trefs/tags/v1^{}\n';
  assert.deepStrictEqual(F.branchOf(F.GH_TREE.exec('https://github.com/o/r/tree/release/skills/deck'), both), ['release', 'skills/deck', 'h1']);
  assert.deepStrictEqual(F.branchOf(F.GH_TREE.exec('https://github.com/o/r/tree/v1/skills/deck'), both), ['v1', 'skills/deck', 'v2']);
});

test('a permanent link (a commit, long or short) is said in words, nothing cloned; a branch named like one is still a branch', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  const sha = 'a1'.repeat(20);
  let clones = 0; let listed = '';
  const run = (exe, args, o, cb) => {
    if (args[0] === 'clone') { clones++; const repo = args[args.length - 1]; fs.mkdirSync(path.join(repo, 'skills', 'deck'), { recursive: true }); fs.writeFileSync(path.join(repo, 'skills', 'deck', 'SKILL.md'), '# x'); }
    cb(null, args[0] === 'ls-remote' ? listed : args.includes('ls-files') ? '100644 a 0\t' + args[args.length - 1] + '/SKILL.md\n' : args.includes('rev-parse') ? 'x\n' : '', '');
  };
  for (const v of [sha, 'abc1234']) assert.match((await F.apply(proj, [{ ref: 'deck@coll', skillCopy: true, source: 'https://github.com/o/r/tree/' + v + '/skills/deck' }], { run }))[0].note, /某一個版本（commit）/);
  assert.strictEqual(clones, 0);
  listed = 'x\trefs/heads/' + sha + '\n';
  const out = await F.apply(proj, [{ ref: 'deck@coll', skillCopy: true, source: 'https://github.com/o/r/tree/' + sha + '/skills/deck' }], { run });
  assert.strictEqual(out[0].ok, true, JSON.stringify(out));
});

test('git is never left to ask for a sign-in, and a failure says git\'s message, not its output', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  let seen = null;
  const run = (exe, args, o, cb) => { seen = o; cb(new Error('maxBuffer length exceeded'), 'abc\trefs/tags/v1\n'.repeat(50), ''); };
  const out = await F.apply(proj, [{ ref: 'deck@coll', skillCopy: true, source: 'https://github.com/o/r/tree/main/skills/deck' }], { run });
  assert.strictEqual(seen.env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(seen.maxBuffer >= 8 * 1024 * 1024);
  assert.doesNotMatch(out[0].note, /refs\/tags/);
  assert.match(out[0].note, /maxBuffer/);
});

test('what was cloned is not the version found: said, nothing copied', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  const run = (exe, args, o, cb) => {
    if (args[0] === 'ls-remote') return cb(null, 'h1\trefs/heads/release\nt1\trefs/tags/release\n', '');
    if (args.includes('ls-files')) return cb(null, '100644 a 0\t' + args[args.length - 1] + '/SKILL.md\n', ''); if (args.includes('rev-parse')) return cb(null, 't1\n', '');
    if (args[0] === 'clone') { const repo = args[args.length - 1]; fs.mkdirSync(path.join(repo, 'skills', 'deck'), { recursive: true }); fs.writeFileSync(path.join(repo, 'skills', 'deck', 'SKILL.md'), '# x'); }
    cb(null, '', '');
  };
  const out = await F.apply(proj, [{ ref: 'deck@coll', skillCopy: true, source: 'https://github.com/o/r/tree/release/skills/deck' }], { run });
  assert.match(out[0].note, /對不上/);
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'skills', 'deck')));
});

test('a folder with a link in it is not copied; git is told to write no links; a folder named ..foo is fine', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-out-'));
  let cloneArgs = null;
  const make = (sub, link) => (exe, args, o, cb) => {
    if (args[0] === 'ls-remote') return cb(null, 'h\trefs/heads/main\n', '');
    if (args.includes('ls-files')) return cb(null, '100644 a 0\t' + args[args.length - 1] + '/SKILL.md\n', ''); if (args.includes('rev-parse')) return cb(null, 'h\n', '');
    if (args[0] === 'clone') {
      cloneArgs = args; const repo = args[args.length - 1]; const d = path.join(repo, ...sub.split('/'));
      fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '# x');
      if (link) fs.symlinkSync(outside, path.join(d, 'scripts'), 'junction');
    }
    cb(null, '', '');
  };
  let out = await F.apply(proj, [{ ref: 'deck@coll', skillCopy: true, source: 'https://github.com/o/r/tree/main/skills/deck' }], { run: make('skills/deck', true) });
  assert.match(out[0].note, /symlink/);
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'skills', 'deck')));
  assert.ok(cloneArgs.join(' ').includes('--config core.symlinks=false'));
  // a link the repository records, written on disk as a plain file (as git does with core.symlinks=false)
  const recorded = (exe, args, o, cb) => {
    if (args.includes('ls-files')) return cb(null, '100644 a 0\tskills/deck/SKILL.md\n120000 b 0\tskills/deck/scripts\n', '');
    return make('skills/deck', false)(exe, args, o, cb);
  };
  out = await F.apply(proj, [{ ref: 'deck2@coll', skillCopy: true, source: 'https://github.com/o/r/tree/main/skills/deck' }], { run: recorded });
  assert.match(out[0].note, /symlink/);
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'skills', 'deck2')));
  // asked for as -z (paths as they are), a link named in Chinese is found too
  let asked = null;
  const named = (exe, args, o, cb) => {
    if (args.includes('ls-files')) { asked = args; return cb(null, '100644 a 0\tskills/deck/SKILL.md\0' + '120000 b 0\tskills/deck/捷徑\0', ''); }
    return make('skills/deck', false)(exe, args, o, cb);
  };
  out = await F.apply(proj, [{ ref: 'deck3@coll', skillCopy: true, source: 'https://github.com/o/r/tree/main/skills/deck' }], { run: named });
  assert.match(out[0].note, /symlink/);
  assert.ok(asked.includes('-z'));
  out = await F.apply(proj, [{ ref: 'dots@coll', skillCopy: true, source: 'https://github.com/o/r/tree/main/..foo/x' }], { run: make('..foo/x', false) });
  assert.strictEqual(out[0].ok, true, JSON.stringify(out));
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a folder the repository records nothing under (other capitals): not copied', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  const run = (exe, args, o, cb) => {
    if (args[0] === 'ls-remote') return cb(null, 'h\trefs/heads/main\n', '');
    if (args.includes('rev-parse')) return cb(null, 'h\n', '');
    if (args.includes('ls-files')) return cb(null, '', '');
    if (args[0] === 'clone') { const d = path.join(args[args.length - 1], 'skills', 'case'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '# x'); }
    cb(null, '', '');
  };
  const out = await F.apply(proj, [{ ref: 'case@coll', skillCopy: true, source: 'https://github.com/o/r/tree/main/skills/case' }], { run });
  assert.match(out[0].note, /大小寫/);
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'skills', 'case')));
  // git listing the folder in other capitals (where it ignores them): not copied either
  const loose = (exe, args, o, cb) => (args.includes('ls-files') ? cb(null, '100644 a 0\tskills/Case/SKILL.md\n', '') : run(exe, args, o, cb));
  const out2 = await F.apply(proj, [{ ref: 'case2@coll', skillCopy: true, source: 'https://github.com/o/r/tree/main/skills/case' }], { run: loose });
  assert.match(out2[0].note, /大小寫/);
});

test('no network, or no such branch: said at once, nothing cloned', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fit-'));
  let calls = 0;
  const off = (exe, args, o, cb) => { calls++; cb(new Error('x'), '', 'fatal: unable to access: Could not resolve host: github.com'); };
  const x = { ref: 'deck@coll', skillCopy: true, source: 'https://github.com/o/r/tree/main/skills/deck' };
  assert.match((await F.apply(proj, [x], { run: off }))[0].note, /Could not resolve host/);
  assert.strictEqual(calls, 1);
  const none = (exe, args, o, cb) => { calls++; cb(null, args[0] === 'ls-remote' ? 'a\trefs/heads/master\n' : '', ''); };
  calls = 0;
  assert.match((await F.apply(proj, [x], { run: none }))[0].note, /找不到網址裡的分支/);
  assert.strictEqual(calls, 1, 'no clone');
});
