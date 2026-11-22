'use strict';
// 找外掛 (lib/skillwish.js): switched on once, skill-fetch put in your skills, keys kept where skill-fetch reads them,
// a wish looked for by Claude following skill-fetch - read back to what can be installed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wishhome-'));
process.env.USERPROFILE = HOME; process.env.HOME = HOME;
const W = require('../lib/skillwish');
const PF = require('../lib/pluginfit');
const CONFIG = path.join(HOME, '.claude', 'skills', '.fetch-config.json');

test('asked once: no choice yet, then on or off is kept', () => {
  assert.strictEqual(W.status().choice, null);
  assert.strictEqual(W.setChoice(false).choice, 'off');
  assert.strictEqual(W.setChoice(true).choice, 'on');
  assert.strictEqual(W.status().installed, false);
});

test('keys: written where skill-fetch reads them, other things in the file kept, never answered back', () => {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ OTHER: 'keep' }));
  const r = W.saveKeys({ SKILLSMP_API_KEY: 'sk_live_abc123', NOT_OURS: 'x' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.keys.map((k) => [k.id, k.set]), [['SKILLSMP_API_KEY', true], ['SKILLHUB_API_KEY', false], ['SKILLS_DIRECTORY_API_KEY', false]]);
  assert.ok(!JSON.stringify(r).includes('sk_live_abc123'), 'the key itself is not in the answer');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8')), { OTHER: 'keep', SKILLSMP_API_KEY: 'sk_live_abc123' });
  // taken away with an empty value; a value with spaces or quotes is not a key
  assert.strictEqual(W.saveKeys({ SKILLHUB_API_KEY: 'a b' }).ok, false);
  assert.strictEqual(W.saveKeys({}).ok, false);
  W.saveKeys({ SKILLSMP_API_KEY: '' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8')), { OTHER: 'keep' });
});

test('skill-fetch put in your skills from its GitHub folder, and not again once it is there', async () => {
  let asked = null;
  const copySkill = async (folder, x) => { asked = [folder, x]; const d = path.join(folder, '.claude', 'skills', 'skill-fetch'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '# x'); return { ok: true }; };
  assert.strictEqual((await W.install({ copySkill })).ok, true);
  assert.deepStrictEqual(asked, [HOME, { ref: 'skill-fetch@skill-fetch', source: 'https://github.com/girofu/skill-fetch/tree/main/skills/skill-fetch' }]);
  assert.ok(PF.GH_TREE.test(asked[1].source), 'an address the skill copy takes');
  asked = null; assert.strictEqual((await W.install({ copySkill })).note, '已經裝了'); assert.strictEqual(asked, null);
  assert.strictEqual(W.status().installed, true);
});

test('the search: no settings, only what skill-fetch does, the key where it cannot read, each find checked on GitHub', async () => {
  W.saveKeys({ SKILLSMP_API_KEY: 'sk_live_abc123' });
  let seen = null;
  const run = async (args, cwd, prompt, opts) => {
    const at = args.indexOf('--mcp-config');
    seen = { args, cwd, prompt, opts, mcp: at > 0 ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8')) : null, file: at > 0 ? args[at + 1] : null };
    return { ok: true, cost: 0.4, answer: JSON.stringify({ answer: '找到幾個', skills: [
      { name: 'Slides', source: 'https://github.com/o/r/tree/main/skills/frontend-slides', score: 88, why: '做簡報', pros: '好看', cons: '要裝 node' },
      { name: 'dup', source: 'https://github.com/o/r/tree/main/skills/frontend-slides/', score: 50 },
      { name: 'same name', source: 'https://github.com/o/r/tree/main/other/frontend-slides', score: 60 },
      { name: 'made up', source: 'https://github.com/o/r/tree/main/skills/nowhere', score: 95 },
      { name: 'busy', source: 'https://github.com/o/r/tree/main/skills/busy', score: 90 },
      { name: 'hex branch', source: 'https://github.com/o/h/tree/deadbeef/skills/hb', score: 85 },
      { name: 'a version', source: 'https://github.com/o/v/tree/0123456789abcdef0123456789abcdef01234567/skills/x', score: 93 },
      { name: 'not github', source: 'https://example.com/x', score: 99 },
      { name: 'climb', source: 'https://github.com/o/r/tree/main/../x', score: 99 },
      { name: 'had', source: 'https://github.com/o/had/tree/main/deck', score: 70 },
    ] }) };
  };
  const asked = [];
  const fetchFake = async (url) => { asked.push(url); return { status: /nowhere/.test(url) ? 404 : /busy/.test(url) ? 503 : 200 }; };
  const lsRemote = async (args) => (/deadbeef/.test(args.join(' ')) ? true : false);   // deadbeef is a branch there; the long one is not
  const r = await W.wish('C:/work/p', '做簡報的 skill', new Set(['deck@had', 'frontend-slides@r']), { run, fetch: fetchFake, lsRemote, haveSources: new Set(['https://github.com/o/had/tree/main/deck', 'https://github.com/o/r/tree/main/old/frontend-slides']) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.skills.map((x) => [x.ref, x.score]), [['frontend-slides-2@r', 88], ['frontend-slides-3@r', 60], ['hb@h', 85]], 'GitHub folders that hold a SKILL.md, once each; the folder has another frontend-slides (another source), so these are numbered, and the folder it has (deck) is skipped');
  assert.deepStrictEqual([r.dropped, r.versions, r.unsure], [1, 1, 1], 'the made-up one, the version and the one GitHub did not answer for: each told apart, none offered');
  assert.ok(asked.includes('https://raw.githubusercontent.com/o/r/main/skills/frontend-slides/SKILL.md'));
  assert.match(r.skills[0].note, /優點：好看；注意：要裝 node/);
  // what it may do: no tool left open-ended, the key file in a folder of its own
  for (const a of ['--setting-sources', '--strict-mcp-config', '--no-session-persistence']) assert.ok(seen.args.includes(a), a);
  const allow = seen.args.slice(seen.args.indexOf('--allowedTools') + 1, seen.args.indexOf('--disallowedTools'));
  for (const bare of ['Bash', 'Read', 'WebFetch', 'Glob', 'Grep', 'WebSearch']) assert.ok(!allow.includes(bare), bare + ' is not let in for everything');
  assert.ok(allow.every((x) => /^(Read|Bash|WebFetch)\(.+\)$|^WebSearch$|^mcp__skillsmp__skillsmp_(search|ai_search|list_repo_skills|get_skill_content)$/.test(x)), JSON.stringify(allow));
  assert.ok(allow.includes('Read(C:/work/p/CLAUDE.md)') && allow.includes('Bash(gh search:*)'));
  assert.ok(!allow.some((x) => /fetch-config/.test(x)), 'the key file of skill-fetch is not readable');
  assert.match(seen.args[seen.args.indexOf('--disallowedTools') + 1], /Write.*Edit.*skillsmp_install_skill/);
  assert.deepStrictEqual(seen.mcp.mcpServers.skillsmp.env, { SKILLSMP_API_KEY: 'sk_live_abc123' });
  assert.notStrictEqual(path.dirname(seen.file), seen.cwd, 'the key file is not in the folder the search runs in');
  assert.ok(!('env' in seen.opts), 'the runner keeps its own clean environment');
  assert.ok(!seen.prompt.includes('sk_live_abc123'), 'the key is not in what Claude is told');
  assert.match(seen.prompt, /做簡報的 skill/); assert.match(seen.prompt, /deck@had/); assert.match(seen.prompt, /不安裝/); assert.match(seen.prompt, /設定檔（你讀不到）/);
  assert.ok(!fs.existsSync(seen.file) && !fs.existsSync(seen.cwd), 'its own folders and the key file are gone after');
  // an environment given is passed on
  await W.wish('C:/work/p', 'x', new Set(), { run, fetch: fetchFake, env: { A: '1' } });
  assert.deepStrictEqual(seen.opts.env, { A: '1' });
  // a key folder a search left behind is swept
  const left = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wishk-')), fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wishk-'));
  const long = (Date.now() - 60 * 60 * 1000) / 1000; fs.utimesSync(left, long, long);
  assert.ok(W.sweep() >= 1); assert.ok(!fs.existsSync(left));
  assert.ok(fs.existsSync(fresh), 'one that a search may still be using is left alone'); fs.rmSync(fresh, { recursive: true, force: true });
  // no SkillsMP key: run without SkillsMP
  W.saveKeys({ SKILLSMP_API_KEY: '' });
  await W.wish('C:/work/p', 'x', new Set(), { run, fetch: fetchFake });
  assert.ok(!seen.args.includes('--mcp-config'));
  // switched off, or not installed: nothing is run
  W.setChoice(false); seen = null;
  assert.match((await W.wish('C:/work/p', 'x', new Set(), { run })).error, /沒有啟用/); assert.strictEqual(seen, null);
  W.setChoice(true);
});

test('a home folder with a mark the shell reads: the registry scripts are neither let in nor told; with a space, quoted', () => {
  const was = [process.env.USERPROFILE, process.env.HOME];
  try {
    for (const odd of ['C:/Users/a;touch x #', 'C:/Users/a$(id)', 'C:/Users/a`id`', "C:/Users/o'neil", 'C:/Users/a&b']) {
      process.env.USERPROFILE = process.env.HOME = odd;
      const allow = W.allowed('C:/w'), told = W.prompt('C:/w', 'x', [], []);
      assert.ok(!allow.some((x) => /scripts\//.test(x)), odd + ': no script let in');
      assert.ok(!/scripts\/fetch-/.test(told), odd + ': no script told');
    }
    // letters of another language are not shell marks: kept
    process.env.USERPROFILE = process.env.HOME = 'C:/Users/林小明';
    assert.ok(W.allowed('C:/w').includes('Bash(bash C:/Users/林小明/.claude/skills/skill-fetch/scripts/fetch-skillhub.sh:*)'));
    // a letter written with a combining mark (José as e + U+0301): kept, and told
    process.env.USERPROFILE = process.env.HOME = 'C:/Users/Jose\u0301';
    const jose = 'bash C:/Users/Jose\u0301/.claude/skills/skill-fetch/scripts/fetch-skillhub.sh';
    assert.ok(W.allowed('C:/w').includes('Bash(' + jose + ':*)'), 'let in');
    assert.ok(W.prompt('C:/w', 'x', [], []).includes(jose + ' "<查詢>"'), 'told, with that path');
    // full-width marks, other quotes, and what is not shown at all (zero-width, also among the combining marks): refused
    for (const odd of ['C:/Users/a；b', 'C:/Users/a＄b', 'C:/Users/a\u200bb', 'C:/Users/a\u202eb', 'C:/Users/a“b', 'C:/Users/a\u3000b', 'C:/Users/a\u034fb', 'C:/Users/a\ufe0fb', 'C:/Users/a\u{e0100}b']) {
      process.env.USERPROFILE = process.env.HOME = odd;
      assert.ok(!W.allowed('C:/w').some((x) => /scripts\//.test(x)), JSON.stringify(odd) + ': refused');
    }
    process.env.USERPROFILE = process.env.HOME = 'C:/Users/First Last';
    assert.ok(W.allowed('C:/w').includes('Bash(bash "C:/Users/First Last/.claude/skills/skill-fetch/scripts/fetch-skillhub.sh":*)'));
    assert.match(W.prompt('C:/w', 'x', [], []), /bash "C:\/Users\/First Last\/\.claude\/skills\/skill-fetch\/scripts\/fetch-skillhub\.sh" "<查詢>"/);
  } finally { process.env.USERPROFILE = was[0]; process.env.HOME = was[1]; }
});

test('not asked where skill-fetch is there: in your skills every folder is on; in a folder\'s own, that folder only; a choice made stands', async () => {
  const was = [process.env.USERPROFILE, process.env.HOME];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wherehome-')), a = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wherea-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-whereb-'));
  const put = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), '# x'); };
  try {
    process.env.USERPROFILE = process.env.HOME = home;
    assert.deepStrictEqual([W.status(a).choice, W.status(a).installed], [null, false], 'nowhere: asked');
    // in folder a's own skills only: a is on (not asked), b is still asked
    put(path.join(a, '.claude', 'skills', 'skill-fetch'));
    const sa = W.status(a), sb = W.status(b);
    assert.deepStrictEqual([sa.choice, sa.implied, sa.where], ['on', true, 'project']);
    assert.deepStrictEqual([sb.choice, sb.installed], [null, false]);
    // its search reads that folder's skill-fetch
    let seen = null;
    await W.wish(a, 'x', new Set(), { run: async (args, cwd, p) => { seen = { args, p }; return { ok: true, answer: '{}' }; }, fetch: async () => ({ status: 404 }) });
    const own = String(path.join(a, '.claude', 'skills', 'skill-fetch')).replace(/\\/g, '/');
    assert.ok(seen.args.includes('Read(' + own + '/**)'), 'that folder\'s skill-fetch is the one read');
    assert.ok(seen.p.includes(own + '/SKILL.md'));
    // in your skills: every folder is on
    put(path.join(home, '.claude', 'skills', 'skill-fetch'));
    assert.deepStrictEqual([W.status(b).choice, W.status(b).implied, W.status(b).where], ['on', true, 'global']);
    // switched off by you: off everywhere, whatever is installed
    W.setChoice(false, a);
    assert.deepStrictEqual([W.status(a).choice, W.status(b).choice, W.status(b).implied], ['off', 'off', false]);
  } finally {
    process.env.USERPROFILE = was[0]; process.env.HOME = was[1];
    for (const d of [home, a, b]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a recommend entry drafted in a question: the list form rules; a GitHub folder is a skill-copy entry', () => {
  assert.deepStrictEqual(PF.readRecommend({ key: 'frontend-slides@r', source: 'https://github.com/o/r/tree/main/skills/frontend-slides', note: '做 HTML 簡報', tags: ['slides', 'bad tag', 'html'] }),
    { key: 'frontend-slides@r', source: 'https://github.com/o/r/tree/main/skills/frontend-slides', note: '做 HTML 簡報', tags: ['slides', 'html'], installMethod: 'skill-copy' });
  assert.strictEqual(PF.readRecommend({ key: 'codex@openai-codex', source: 'openai/codex-plugin-cc', note: 'x' }).installMethod, 'marketplace');
  for (const bad of [null, {}, { key: 'no-at', source: 'a/b', note: 'x' }, { key: 'a@b', source: '--evil', note: 'x' }, { key: 'a@b', source: 'a/b', note: '' }]) assert.strictEqual(PF.readRecommend(bad), null, JSON.stringify(bad));
});

test('a question may ask for a wish to be looked for (only when it can be), and found ones are candidates for it', async () => {
  const pm = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wishpm-'));
  const src = { ok: true, skill: 'x', profiles: {}, recommends: {}, library: {} };
  const st = { result: { confident: true, profile: null, summary: 's', read: [], plugins: [], skip: [] }, wished: [{ ref: 'frontend-slides@r', source: 'https://github.com/o/r/tree/main/skills/frontend-slides', why: '做簡報', note: '' }] };
  let told = '';
  const explain = async (cwd, p) => { told = p; return { ok: true, answer: JSON.stringify({ answer: '去找了', plugins: [{ ref: 'frontend-slides@r', why: '要裝' }], wish: '  slide   deck  ', recommend: { key: 'frontend-slides@r', source: 'https://github.com/o/r/tree/main/skills/frontend-slides', note: '做簡報' } }) }; };
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wishproj-'));
  const on = await PF.ask(proj, st, '我想要做簡報的', { sources: src, installs: [], explain, run: (c, a, o, cb) => cb(null, '', ''), wish: { on: true, installed: true } });
  assert.strictEqual(on.wish, 'slide deck');
  assert.deepStrictEqual(on.result.plugins.map((x) => [x.ref, x.skillCopy, x.source]), [['frontend-slides@r', true, 'https://github.com/o/r/tree/main/skills/frontend-slides']], 'a found one may be put on the list');
  assert.strictEqual(on.recommend.installMethod, 'skill-copy');
  assert.match(told, /找外掛.*先前在外面找到的/); assert.match(told, /看板會用 skill-fetch 到外面/);
  const off = await PF.ask(proj, st, '我想要做簡報的', { sources: src, installs: [], explain, run: (c, a, o, cb) => cb(null, '', ''), wish: { on: false, installed: true } });
  assert.strictEqual(off.wish, undefined, 'not switched on: nothing looked for');
  assert.match(told, /啟用「找外掛」/);
  fs.rmSync(pm, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true });
});

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) {} });
