'use strict';
// node --test plugins/session-board/tests/recfill.test.js
// A recommend-list entry from an address only (lib/recfill.js). GitHub and Claude are stand-ins.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/recfill');

const hub = (o) => { const asked = []; const f = async (u) => { asked.push(u); const k = Object.keys(o).find((x) => u === x || u.endsWith(x)); if (k === undefined) return { ok: false, status: 404 }; const v = o[k]; if (typeof v === 'number') return { ok: false, status: v }; return { ok: true, status: 200, json: async () => v, text: async () => (typeof v === 'string' ? v : JSON.stringify(v)) }; }; f.asked = asked; return f; };
const tree = (...p) => ({ tree: p.map((path) => ({ path, type: 'blob' })) });
const claude = (items) => async () => ({ ok: true, text: '{"items":' + JSON.stringify(items) + '}' });

test('an address, read', () => {
  const ok = (t) => { const x = R.parse(t); return x && [x.owner, x.repo, x.branch, x.dir]; };
  for (const t of ['https://github.com/alchaincyf/huashu-skills', 'github.com/alchaincyf/huashu-skills/', 'alchaincyf/huashu-skills', 'https://github.com/alchaincyf/huashu-skills.git', 'git@github.com:alchaincyf/huashu-skills.git', 'https://github.com/alchaincyf/huashu-skills?tab=readme#x']) assert.deepStrictEqual(ok(t), ['alchaincyf', 'huashu-skills', '', ''], t);
  assert.deepStrictEqual(ok('https://github.com/a/b/tree/master/x/y'), ['a', 'b', 'master', 'x/y']);
  assert.deepStrictEqual(ok('https://github.com/a/b/blob/main/x/SKILL.md'), ['a', 'b', 'main', 'x']);
  for (const t of ['', 'hello', 'https://gitlab.com/a/b', 'https://github.com/a', 'https://github.com/a/..', 'file:///c:/x', 'https://evil.com/github.com/a/b']) assert.strictEqual(R.parse(t), null, t);
});

test('skills: one entry each, as the list writes them; what each is, from Claude, checked', async () => {
  const f = hub({ '/repos/alchaincyf/huashu-skills': { default_branch: 'master', description: '合集', topics: ['skills', 'BAD TAG'] }, '/git/trees/master?recursive=1': tree('README.md', 'huashu-slides/SKILL.md', 'huashu-design/SKILL.md', 'node_modules/x/SKILL.md', 'tests/y/SKILL.md', 'SKILL.md', 'huashu-design/a.png'),
    'huashu-slides/SKILL.md': '---\nname: huashu-slides\ndescription: >-\n  makes\n  slides\n---\nbody', 'huashu-design/SKILL.md': '---\ndescription: "design things"\n---' });
  let prompt = '';
  const r = await R.draft('https://github.com/alchaincyf/huashu-skills', { fetch: f, ask: async (sys, p) => { prompt = p; return claude([{ i: 1, note: '--一句話做簡報', tags: ['Slides', 'bad tag', 'design'] }, { i: 9, note: 'x' }])(); } });
  assert.deepStrictEqual(r.items, [
    { name: 'huashu-slides', key: 'huashu-slides@huashu-skills', source: 'https://github.com/alchaincyf/huashu-skills/tree/master/huashu-slides', installMethod: 'skill-copy', note: '一句話做簡報', tags: ['slides', 'design'] },
    { name: 'huashu-design', key: 'huashu-design@huashu-skills', source: 'https://github.com/alchaincyf/huashu-skills/tree/master/huashu-design', installMethod: 'skill-copy', note: 'design things', tags: ['skills'] },
  ]);
  assert.deepStrictEqual([r.ok, r.repo, r.more, r.rough], [true, 'alchaincyf/huashu-skills', 0, 1]);
  assert.ok(prompt.includes('makes slides') && prompt.includes('design things'));
  const one = await R.draft('https://github.com/alchaincyf/huashu-skills/tree/master/huashu-design', { fetch: f, ask: claude([]) }); assert.deepStrictEqual(one.items.map((x) => x.key), ['huashu-design@huashu-skills']);
});

test('a marketplace: one entry per plugin, the repository as its source; Claude silent, its own words', async () => {
  const f = hub({ '/repos/openai/codex-plugin-cc': { default_branch: 'main', description: 'd' }, '/git/trees/main?recursive=1': tree('.claude-plugin/marketplace.json', 'plugins/codex/skills/x/SKILL.md'), '.claude-plugin/marketplace.json': { name: 'openai-codex', plugins: [{ name: 'codex', description: 'Use Codex' }, { name: 'bad name' }] } });
  const r = await R.draft('openai/codex-plugin-cc', { fetch: f, ask: async () => ({ ok: false, error: 'x' }) });
  assert.deepStrictEqual([r.items, r.rough], [[{ name: 'codex', key: 'codex@openai-codex', source: 'openai/codex-plugin-cc', installMethod: 'marketplace', note: 'Use Codex', tags: [] }], 1]);
  const thrown = await R.draft('openai/codex-plugin-cc', { fetch: f, ask: async () => { throw new Error('gone'); } }); assert.strictEqual(thrown.items.length, 1);
});

test('what cannot be added is said', async () => {
  const no = async (o, u = 'a/b') => (await R.draft(u, { fetch: hub(o), ask: claude([]) })).error;
  assert.match(await no({}), /找不到 a\/b/); assert.match(await no({ '/repos/a/b': 403 }), /次數用完/); assert.match(await no({}, 'https://gitlab.com/a/b'), /看不懂/);
  const repo = { '/repos/a/b': { default_branch: 'main' } };
  assert.match(await no(Object.assign({ '/git/trees/main?recursive=1': tree('README.md') }, repo)), /不是 Claude Code 能裝/);
  assert.match(await no(Object.assign({ '/git/trees/main?recursive=1': tree('SKILL.md') }, repo)), /整個就是一個 skill/);
  assert.match(await no(repo, 'https://github.com/a/b/tree/dev/x'), /沒有「dev」/);
});
