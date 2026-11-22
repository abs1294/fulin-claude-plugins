'use strict';
// 找外掛 (asked 2026-11-22: "外掛分析要補 skill-fetch：使用者可能在那邊許願要哪些 skill，好用的話也會要求加入推薦清單"):
// a wish typed in the 外掛分析 questions ("I want a skill that makes slides") is looked for outside - SkillsMP, GitHub,
// skills.sh and the other registries skill-fetch knows - by Claude following skill-fetch, and what it finds is put among
// the ones to install for that folder (copied into its .claude/skills/, like any skill-copy entry).
//
// Asked the first time: switched on, it puts skill-fetch in your skills (~/.claude/skills/skill-fetch, from
// github.com/girofu/skill-fetch, MIT) and asks for the registries' keys once (kept where skill-fetch reads them,
// ~/.claude/skills/.fetch-config.json; never shown again, never sent to the page). Switched off, nothing is looked for.
//
// The search: claude -p in an empty folder of its own, no settings of yours (no hooks run), let do only what skill-fetch
// does - the commands it runs (gh search, its npx clients, its two registry scripts), pages of the registries and GitHub,
// reading skill-fetch's files and the project's CLAUDE.md and README.md; nothing else (see allowed() below). SkillsMP's
// tools given to it for this run only (a temporary MCP file holding the key, in a folder it cannot read, removed after) -
// your own MCP settings are not touched (measured 2026-11-22:
// without settings the MCP servers you registered are not there; with --mcp-config they are, and a search answered).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE = 'https://github.com/girofu/skill-fetch/tree/main/skills/skill-fetch';
const REF = 'skill-fetch@skill-fetch';
const HOME = () => os.homedir();
const SKILL_DIR = () => path.join(HOME(), '.claude', 'skills', 'skill-fetch');
// skill-fetch for a folder: the one in your skills (for every folder), else that folder's own .claude/skills (for that
// folder only). -> {dir, where: 'global'|'project'} | null
function whereFor(folder) {
  if (fs.existsSync(path.join(SKILL_DIR(), 'SKILL.md'))) return { dir: SKILL_DIR(), where: 'global' };
  const own = folder ? path.join(folder, '.claude', 'skills', 'skill-fetch') : '';
  if (own && fs.existsSync(path.join(own, 'SKILL.md'))) return { dir: own, where: 'project' };
  return null;
}
const CONFIG = () => path.join(HOME(), '.claude', 'skills', '.fetch-config.json');
const CHOICE = () => path.join(HOME(), '.claude', 'session-board', 'skillwish.json');
// the keys skill-fetch reads (its Step 0.5), each optional: a registry without one is skipped or searched without it
const KEYS = [
  { id: 'SKILLSMP_API_KEY', name: 'SkillsMP', site: 'https://skillsmp.com', note: '最大的 skill 索引；有它才會用 SkillsMP 的語意搜尋' },
  { id: 'SKILLHUB_API_KEY', name: 'SkillHub', site: 'https://www.skillhub.club', note: '沒有也會用它的公開指令列查，有金鑰比較完整' },
  { id: 'SKILLS_DIRECTORY_API_KEY', name: 'Skills Directory', site: 'https://www.skillsdirectory.com', note: '沒有就不查這一家' },
];
const WISH_MAX = 300;
const TIME_LIMIT_MS = 10 * 60 * 1000;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(t, f); };

// For a folder -> {choice: 'on'|'off'|null, implied, installed, where, dir, keys: [{id, name, site, note, set}]} (whether a
// key is there, never the key). Not asked where skill-fetch is there already (asked 2026-11-22: in your skills, every
// folder is on; in one folder's own skills, that folder is - the others are still asked); a choice you made stands.
function status(folder) {
  const c = readJson(CHOICE()) || {}, cfg = readJson(CONFIG()) || {}, w = whereFor(folder);
  const made = c.choice === 'on' || c.choice === 'off' ? c.choice : null;
  return {
    choice: made || (w ? 'on' : null),
    implied: !made && !!w,
    installed: !!w,
    where: w ? w.where : null,
    dir: w ? w.dir : null,
    source: SOURCE,
    keys: KEYS.map((k) => Object.assign({}, k, { set: typeof cfg[k.id] === 'string' && !!cfg[k.id].trim() })),
  };
}
function setChoice(on, folder) { const c = readJson(CHOICE()) || {}; c.choice = on ? 'on' : 'off'; c.at = Date.now(); writeJson(CHOICE(), c); return status(folder); }

// skill-fetch put in your skills, the way any skill-copy entry is (only that folder from GitHub; never over one that is there)
async function install(o = {}) {
  if (fs.existsSync(path.join(SKILL_DIR(), 'SKILL.md'))) return { ok: true, note: '已經裝了' };
  const copy = o.copySkill || require('./pluginfit').copySkill;
  return copy(HOME(), { ref: REF, source: SOURCE }, o);
}

// keys: {ID: 'value'} sets it, {ID: ''} takes it away; ids not skill-fetch's are ignored. Other things in the file stay.
function saveKeys(keys, folder) {
  const cfg = readJson(CONFIG()) || {};
  let n = 0;
  for (const k of KEYS) {
    if (!keys || !Object.prototype.hasOwnProperty.call(keys, k.id)) continue;
    const v = String(keys[k.id] == null ? '' : keys[k.id]).trim();
    if (/[\s"'`$\\]/.test(v)) return { ok: false, error: k.name + ' 的金鑰裡有空白或引號，不像金鑰' };
    if (v.length > 300) return { ok: false, error: k.name + ' 的金鑰太長' };
    if (v) cfg[k.id] = v; else delete cfg[k.id];
    n++;
  }
  if (!n) return { ok: false, error: '沒有要存的金鑰' };
  writeJson(CONFIG(), cfg);
  return Object.assign({ ok: true }, status(folder));
}


// What the search may do (review 2026-11-22: "Bash may do anything - read the key and send it away"): only the commands
// skill-fetch runs, pages only from the registries and GitHub, files only skill-fetch's own and the project's two notes.
// Measured the same day: claude -p refuses a Read or a cat outside these, runs the gh search let in. Nothing it may read
// holds a key: the registry scripts read skill-fetch's key file themselves, and the run's MCP file lies in another folder.
const fwd = (p) => String(p).replace(/\\/g, '/');
// how a registry script is run: its path in quotes when it has a space in it (review 2026-11-22: a home folder with a
// space - the rule matched only the bare path, which the shell splits); the rule and the command told are the same
const script = (name, dir) => { const p = fwd(dir || SKILL_DIR()) + '/scripts/' + name; if (!/^[\p{L}\p{M}\p{N}_.\/:~ -]+$/u.test(p) || /\p{Default_Ignorable_Code_Point}/u.test(p)) return null; return 'bash ' + (/ /.test(p) ? '"' + p + '"' : p); };
// (a home folder whose path has a mark the shell reads - ; $ ` & quotes ... - gets no script: not let in, not told.
// Letters, their combining marks and digits of any language are not such marks: C:/Users/林小明, José written as
// e + U+0301, keep their scripts - review 2026-11-22. Full-width marks, other quotes, and anything not shown at all
// (zero-width, the invisible joiners and variation selectors among the combining marks): still refused)
function allowed(folder, skillDir) {
  const dir = fwd(skillDir || SKILL_DIR()), f = fwd(folder).replace(/\/+$/, '');
  return [
    'Read(' + dir + '/**)', 'Read(' + f + '/CLAUDE.md)', 'Read(' + f + '/README.md)',
    'Bash(gh search:*)', 'Bash(gh api repos/anthropics/skills/git/trees/main?recursive=1:*)',
    'Bash(npx -y clawhub:*)', 'Bash(npx -y @polyskill/cli:*)', 'Bash(npx -y @skill-hub/cli:*)',
    ...['fetch-skillhub.sh', 'fetch-skills-directory.sh'].map((n) => script(n, skillDir)).filter(Boolean).map((c) => 'Bash(' + c + ':*)'),
    'WebFetch(domain:skills.sh)', 'WebFetch(domain:skillsmp.com)', 'WebFetch(domain:github.com)', 'WebFetch(domain:api.github.com)', 'WebFetch(domain:raw.githubusercontent.com)',
    'mcp__skillsmp__skillsmp_search', 'mcp__skillsmp__skillsmp_ai_search', 'mcp__skillsmp__skillsmp_list_repo_skills', 'mcp__skillsmp__skillsmp_get_skill_content',
  ];
}
const DENY = ['Write', 'Edit', 'NotebookEdit', 'mcp__skillsmp__skillsmp_install_skill'];
const argsFor = (mcp, folder, skillDir) => ['-p', '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config']
  .concat(mcp ? ['--mcp-config', mcp] : [], ['--allowedTools'], allowed(folder, skillDir), ['--disallowedTools', DENY.join(','), '--output-format', 'json']);

function prompt(folder, wish, have, keys, skillDir) {
  const dir = fwd(skillDir || SKILL_DIR());
  const on = (id) => (keys || []).some((k) => k.id === id && k.set);
  return [
    '你在替使用者找 Claude Code 的 skill。使用者想要：' + wish,
    '他的專案在 ' + fwd(folder) + '（判斷適不適合可以讀它的 CLAUDE.md、README.md；其他檔你讀不到）。',
    '',
    '照 skill-fetch 的流程搜尋並評分：先讀 ' + dir + '/SKILL.md，以及它的 references/search-sources.md、references/quality-signals.md。這次的做法有幾處不同：',
    '- Step 0（註冊 SkillsMP MCP）不要做：' + (on('SKILLSMP_API_KEY') ? 'SkillsMP 已經以 mcp__skillsmp__ 開頭的工具提供。' : '這次沒有 SkillsMP，跳過它。'),
    '- Step 0.5 不用讀設定檔（你讀不到）：金鑰的情況是 SkillHub ' + (on('SKILLHUB_API_KEY') ? '有' : '沒有') + '、Skills Directory ' + (on('SKILLS_DIRECTORY_API_KEY') ? '有' : '沒有') + '。',
    '- 你能跑的指令只有這些，其他都會被拒：gh search …；gh api repos/anthropics/skills/git/trees/main?recursive=1 …；npx -y clawhub …；npx -y @polyskill/cli …；npx -y @skill-hub/cli …' + (script('fetch-skillhub.sh', skillDir) ? '；' + script('fetch-skillhub.sh', skillDir) + ' "<查詢>"' : '') + (on('SKILLS_DIRECTORY_API_KEY') && script('fetch-skills-directory.sh', skillDir) ? '；' + script('fetch-skills-directory.sh', skillDir) + ' "<查詢>"' : '') + '。網頁只能抓 skills.sh、skillsmp.com、github.com、api.github.com、raw.githubusercontent.com。',
    '- Step 2 盡量查各個來源；被拒、失敗或太慢的就跳過，不要卡住，也不要想辦法繞過。',
    '- Step 3 以後不要做：不安裝、不寫任何檔、不改任何設定、不問問題（沒有人會回答）。',
    have.length ? '- 這個專案已經有的不要再推薦：' + have.join('、') : '',
    '',
    require('./modeljson').PATHS,
    '只輸出一個 JSON 物件，前後不要有任何文字：',
    '{"answer": "繁體中文 Markdown，結論先講：找到哪些、各自做什麼、優缺點、你最推薦哪個與理由；最後一句說查了哪些來源、哪些沒查到", "skills": [{"name": "skill 名稱", "source": "https://github.com/擁有者/庫/tree/分支/那個skill的資料夾", "score": 0到100, "why": "一句話：為什麼適合這個願望", "pros": "優點", "cons": "缺點或要注意的（含安全標籤）"}]}',
    'skills 只列能給出 GitHub 資料夾網址、且那個資料夾裡有 SKILL.md 的，最多 8 個，分數高的在前；不確定網址對不對的寧可不列。',
  ].filter((l) => l !== '').join('\n');
}

// What the search answered, kept to what can be installed: a GitHub folder address, named by its last folder, in
// the repository's name (ref name@repo, as the recommend list writes them). -> {answer, skills: [{ref, source, ...}]}
function readWish(text, have, haveSources) {
  const PF = require('./pluginfit');
  const j = require('./modeljson').parse(text);   // (from the first { to the last; not mended)
  if (!j || typeof j !== 'object') return { answer: String(text || '').slice(0, 8000), skills: [] };
  const t = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const seen = new Set(), skills = [];
  for (const x of Array.isArray(j.skills) ? j.skills : []) {
    const source = t(x && x.source, 400).replace(/\/+$/, '');
    const m = PF.GH_TREE.exec(source);
    if (!m || (m[3] + '/' + m[4]).split('/').some((p) => p === '..' || p === '.')) continue;
    const name = m[4].split('/').pop().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
    if (seen.has(source.toLowerCase()) || (haveSources && haveSources.has(source.toLowerCase()))) continue;
    // two folders named alike (a/x, b/x, or ..x made x): the later one numbered, not thrown away
    let ref = name + '@' + m[2];
    const taken = (r) => seen.has(r.toLowerCase()) || (have && have.has(r));
    for (let i = 2; taken(ref) && i < 10; i++) ref = name + '-' + i + '@' + m[2];
    if (!PF.REF.test(ref) || taken(ref)) continue;
    seen.add(ref.toLowerCase()); seen.add(source.toLowerCase());
    const score = Math.max(0, Math.min(100, Math.round(Number(x.score) || 0)));
    skills.push({ ref, source, skillCopy: true, from: '找外掛（' + score + ' 分）', why: t(x.why, 300), note: [t(x.pros, 300) && '優點：' + t(x.pros, 300), t(x.cons, 300) && '注意：' + t(x.cons, 300)].filter(Boolean).join('；'), score });
    if (skills.length >= 8) break;
  }
  return { answer: String(typeof j.answer === 'string' ? j.answer : '').slice(0, 8000), skills };
}

// Each one found is looked at on GitHub before it is offered (review 2026-11-22: an address made up, or one copied
// wrong, was offered until 套用 failed): its folder has to hold a SKILL.md. The address does not say where the branch
// ends, and raw.githubusercontent.com takes the branch and the folder written one after the other, so the address as
// written is asked for. A version for a branch (tree/<commit>/...) is not offered: the skill copy takes branches and
// tags only. -> {skills: the ones there, missing, unsure (GitHub did not answer: busy, an error, too slow)}
// whether the repository has a branch or tag of the address's first name -> true | false | null (could not ask)
function refNamed(m, o = {}) {
  const n = m[3];
  const args = ['ls-remote', '--heads', '--tags', 'https://github.com/' + m[1] + '/' + m[2] + '.git', 'refs/heads/' + n, 'refs/tags/' + n];
  if (o.lsRemote) return o.lsRemote(args);
  return new Promise((resolve) => require('child_process').execFile('git', args, { windowsHide: true, timeout: 15000, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }) },
    (e, out) => resolve(e ? null : !!String(out || '').trim())));
}
async function present(skills, o = {}) {
  const PF = require('./pluginfit');
  const get = o.fetch || ((u, x) => fetch(u, x));
  const there = await Promise.all(skills.map(async (x) => {
    const m = PF.GH_TREE.exec(x.source); if (!m) return 'missing';
    // a name that looks like a version (deadbeef, 20240101) may still be a branch or a tag: GitHub is asked; only when
    // none of that name is there is it a version (review 2026-11-22: such branches were left out)
    if (/^[0-9a-f]{7,40}$/i.test(m[3])) { const named = await refNamed(m, o); if (named === null) return 'unsure'; if (!named) return 'version'; }
    const url = 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] + '/' + m[4] + '/SKILL.md';
    try { const r = await get(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) }); return !r ? 'unsure' : r.status === 200 ? 'there' : r.status === 404 ? 'missing' : 'unsure'; } catch (e) { return 'unsure'; }
  }));
  return { skills: skills.filter((x, i) => there[i] === 'there'), missing: there.filter((t) => t === 'missing').length, unsure: there.filter((t) => t === 'unsure').length, versions: there.filter((t) => t === 'version').length };
}

// The run's own MCP file: SkillsMP only, with the key - in a folder of its own, not the one the search runs in
// (there a cat is let through), removed after the run
function mcpFile(dir) {
  const k = (readJson(CONFIG()) || {}).SKILLSMP_API_KEY;
  if (typeof k !== 'string' || !k.trim()) return null;
  const f = path.join(dir, 'mcp.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { skillsmp: { command: 'npx', args: ['-y', 'skillsmp-mcp-server'], env: { SKILLSMP_API_KEY: k.trim() } } } }), { mode: 0o600 });
  return f;
}

// A run's key folder left behind (the board ended in the middle of a search, so its finally never ran): removed
// when the board starts. Only the board makes these, and one board runs at a time.
function sweep() {
  let n = 0;
  const old = Date.now() - TIME_LIMIT_MS - 5 * 60 * 1000;   // (a search ends within its time limit)
  try { for (const d of fs.readdirSync(os.tmpdir())) if (/^sb-wishk-/.test(d)) { try { if (fs.statSync(path.join(os.tmpdir(), d)).mtimeMs > old) continue; fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); n++; } catch (e) {} } } catch (e) {}
  return n;
}

// -> {ok, answer, skills, dropped, cost} | {ok:false, error}.  o.run(args, cwd, prompt, opts): the claude -p runner (lib/aside.js runWith)
async function wish(folder, text, have, o = {}) {
  const st = status(folder);
  if (st.choice !== 'on') return { ok: false, error: '「找外掛」沒有啟用' };
  if (!st.installed) return { ok: false, error: '還沒裝 skill-fetch' };
  const w = String(text || '').replace(/\s+/g, ' ').trim().slice(0, WISH_MAX);
  if (!w) return { ok: false, error: '要找什麼樣的 skill？' };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wish-')), keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wishk-'));
  try {
    const mcp = mcpFile(keyDir);
    // (the runner's own clean environment stays unless one is given - review 2026-11-22: an undefined env here gave
    // the search the board's whole environment)
    const r = await o.run(argsFor(mcp, folder, st.dir), work, prompt(folder, w, [...(have || [])], st.keys, st.dir), Object.assign({ timeLimit: o.timeLimit || TIME_LIMIT_MS }, o.env ? { env: o.env } : {}));
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '沒有找完' };
    const got = readWish(r.answer, have, o.haveSources);
    const p = await present(got.skills, o);
    return { ok: true, answer: got.answer, skills: p.skills, dropped: p.missing, unsure: p.unsure, versions: p.versions, cost: r.cost || 0 };
  } finally { for (const d of [work, keyDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } }
}

module.exports = { whereFor, status, setChoice, install, saveKeys, wish, sweep, prompt, readWish, present, argsFor, allowed, KEYS, SOURCE, REF, WISH_MAX, DENY };
