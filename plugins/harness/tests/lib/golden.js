'use strict';
// 標準實例（golden）：把 init 的骨架照 Phase 4 的落點與規則「機械式填空」，產一份 init-verify 應該 exit 0 的實例。
// 這是回歸測試用的近似——真實 init 由模型照盤點事實填，這裡只把每個 {{…}} 填掉或刪掉，讓結構規則（落點、
// 變更紀錄、單一詞彙表檔名、接線、答案檔）都成立；壞變體（BROKEN）各弄壞一條，init-verify 要報出對應 id。
//
// 用法：const { makeGolden, BROKEN } = require('./golden'); makeGolden(<已由 fixtures 建好的 single-web 目錄>)
const fs = require('fs');
const path = require('path');

const PLUGIN = path.resolve(__dirname, '..', '..');
const REF = path.join(PLUGIN, 'skills', 'init', 'references');
const TPL = path.join(PLUGIN, 'hooks', 'templates');
const L = require(path.join(PLUGIN, 'skills', 'init', 'scripts', 'init-lib.js'));

const TODAY = '2026-10-09';
const PROJECT = '出貨入口網站';

// 骨架 → 落點（相對 <落點>）
const DOCS = [
  ['skeleton-CLAUDE-md.md', 'CLAUDE.md'],
  ['skeleton-CLAUDE.changelog.md', 'CLAUDE.changelog.md'],
  ['skeleton-harness-CHANGELOG.md', '.claude/harness/CHANGELOG.md'],
  ['skeleton-harness-README.md', '.claude/harness/README.md'],
  ['skeleton-02-model-dispatch.md', '.claude/harness/02-model-dispatch.md'],
  ['skeleton-03-judgment-matrix.md', '.claude/harness/03-judgment-matrix.md'],
  ['skeleton-04-delegation-templates.md', '.claude/harness/04-delegation-templates.md'],
  ['skeleton-05-knowledge-protocol.md', '.claude/harness/05-knowledge-protocol.md'],
  ['agents/skeleton-agents-CHANGELOG.md', '.claude/agents/CHANGELOG.md'],
  ['agents/skeleton-agent-backend-architect.md', '.claude/agents/backend-architect.md'],
  ['agents/skeleton-agent-backend-engineer.md', '.claude/agents/backend-engineer.md'],
  ['agents/skeleton-agent-frontend-engineer.md', '.claude/agents/frontend-engineer.md'],
  ['agents/skeleton-agent-qa-engineer.md', '.claude/agents/qa-engineer.md'],
  ['agents/skeleton-agent-code-reviewer.md', '.claude/agents/code-reviewer.md'],
  ['containers/skeleton-CONTEXT.md', 'GLOSSARY.md'],
  ['containers/skeleton-CONTEXT.changelog.md', 'GLOSSARY.changelog.md'],
  ['containers/skeleton-FLOWS.md', 'FLOWS.md'],
  ['containers/skeleton-FLOWS.changelog.md', 'FLOWS.changelog.md'],
  ['containers/skeleton-PROJECT.md', 'tests/Project_Detail/PROJECT.md'],
  ['containers/skeleton-Project_Detail-CHANGELOG.md', 'tests/Project_Detail/CHANGELOG.md'],
];

// 裝哪些 hook、接在哪個事件（matcher）
const HOOKS = [
  ['check-agent-model.js', 'PreToolUse', 'Agent|Task'],
  ['check-review-discipline.js', 'PreToolUse', 'Agent|Task'],
  ['check-ask-discipline.js', 'PreToolUse', 'AskUserQuestion'],
  ['guard-sediment-sweep.js', 'PreToolUse', 'Skill'],
  ['health-check-reminder.js', 'SessionStart', ''],
  ['memory-write-advisory.js', 'PostToolUse', 'Write|Edit|MultiEdit'],
  ['guard-claude-dir-hygiene.js', 'PreToolUse', 'Write'],
  ['guard-required-skill.js', 'PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit'],
];
// 搬進 .claude/rules/ 的段落（paths 要命中 single-web 範例專案的檔）
const RULES = [
  { file: '.claude/rules/frontend.md', topic: '前端元件寫法', paths: ['src/**/*.{jsx,tsx}'], body: '元件一律用 function component，狀態放在最近的共同父層。' },
  { file: '.claude/rules/tests.md', topic: '測試慣例', paths: ['tests/**/*.test.js'], body: '測試只用 node:test 與 node:assert，不引入其他測試框架。' },
];
const LEARN_HOOKS = [
  ['learn-trigger.js', 'PreToolUse', ''], ['learn-trigger.js', 'Stop', ''], ['learn-trigger.js', 'SessionEnd', ''],
  ['learn-usage.js', 'PreToolUse', 'Read|Skill'], ['learn-usage.js', 'Stop', ''],
  ['learn-session-report.js', 'SessionStart', ''], ['learn-approve.js', 'UserPromptSubmit', ''],
];
const LEARN_EXTRA = ['learn-lib.js', 'learn-reflect.js', 'learn-promote.js', 'learn-pending.js', 'learn-reflector-prompt.md'];

// 一個 {{…}} 的內容要換成什麼：條件段落（若有…加、沒有…時…）整段刪；日期、專案名照填；驗證指令給真的；其餘填示範值
function fillOne(inner) {
  const t = inner.trim();
  if (/^YYYY-MM-DD$/.test(t)) return TODAY;
  if (/^(專案名|專案\/workspace 名稱|skill 名)$/.test(t)) return PROJECT;
  if (/^settings 檔：/.test(t)) return '.claude/settings.local.json';
  if (/^填 Phase 1 查證的事實：build 指令/.test(t)) return '測試＝`npm test`、建置＝`npm run build`（實查 package.json 的 scripts）';
  if (/^(若|有|無|沒|註解規範|動手前必讀|填 init|照實際|依 |其他|；|、|參考|既有治理|若是|如果|init|Q\d|U\d|選|不|僅|只|當|在 )/.test(t)) return '';
  return '示範值';
}
function fillAll(text) {
  const inner = /\{\{((?:(?!\{\{|\}\})[\s\S])*)\}\}/;
  let s = text, guard = 0;
  while (inner.test(s) && guard++ < 5000) s = s.replace(inner, (_, x) => fillOne(x));
  s = s.replace(/\{\{|\}\}/g, '');
  s = s.replace(/<!--\s*init 填空紀律[\s\S]*?-->\n?/g, '');
  return s;
}
// 詞彙表只留一個檔名（Phase 4 的詞彙表檔名規則）：括號裡講另一個檔名的說明整段拿掉，剩下的換成實際檔名
function singleGlossary(s) {
  return s
    .replace(/（[^（）\n]*CONTEXT[^（）\n]*）/g, '')
    .replace(/\(([^()\n]*CONTEXT[^()\n]*)\)/g, '')
    .replace(/CONTEXT\.changelog\.md/g, 'GLOSSARY.changelog.md')
    .replace(/CONTEXT\.md/g, 'GLOSSARY.md');
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'), 'utf8');
}

function makeGolden(root) {
  for (const [src, dst] of DOCS) write(root, dst, singleGlossary(fillAll(fs.readFileSync(path.join(REF, src), 'utf8'))));
  // 詞彙表：一條使用者確認過的真詞條取代示範條目
  const gp = path.join(root, 'GLOSSARY.md');
  let g = fs.readFileSync(gp, 'utf8');
  g = g.replace(/\*\*（示範）[^\n]*\*\*\n[^\n]*\n_避免_：[^\n]*\n/, '**出貨單**\n倉管建立、送到物流商的一筆出貨。\n_避免_：訂單（客戶下的單，一張訂單可拆多張出貨單）——混了會把拆單當成重複建單\n');
  fs.writeFileSync(gp, g);

  // 規則分層：原 CLAUDE.md 只跟前端、測試有關的段落搬進 .claude/rules/（帶 paths），路由表列出，建立記在 CLAUDE.changelog.md
  const rule = fillAll(fs.readFileSync(path.join(REF, 'skeleton-rule.md'), 'utf8'));
  for (const r of RULES) {
    write(root, r.file, rule.replace('- "示範值"', r.paths.map((p) => `- "${p}"`).join('\n  ')).replace('# 示範值規範', `# ${r.topic}規範`).replace(/\n示範值\n$/, `\n${r.body}（出自原 CLAUDE.md「${r.topic}」）\n`));
  }
  const cp = path.join(root, 'CLAUDE.md');
  const ROUTE = '| 本專案特有詞彙（這個詞是什麼意思） |';
  let c = fs.readFileSync(cp, 'utf8');
  if (!c.includes(ROUTE)) throw new Error('golden：CLAUDE.md 找不到路由表的詞彙表那一列');
  c = c.replace(ROUTE, () => `| 只跟特定程式區域有關的規範（改到對應的檔時自動載入，不必先讀） | \`.claude/rules/\`（${RULES.map((r) => `\`${r.file}\`（paths：${r.paths.join('、')}）`).join('、')}） |\n` +
    `| 改某些檔之前一定要先載入的 skill（沒載入就改會被擋） | \`.claude/skills/frontend-conventions/SKILL.md\`（paths：src/**/*.{jsx,tsx}） |\n${ROUTE}`);
  fs.writeFileSync(cp, c);
  fs.appendFileSync(path.join(root, 'CLAUDE.changelog.md'), RULES.map((r) => `- ${TODAY} 建立 ${r.file}（從原 CLAUDE.md「${r.topic}」搬來；harness plugin /harness:init 實例化）\n`).join(''));
  // 參考模式沿用的既有 skill，Phase 2 使用者同意加上 paths；frontend-engineer 預載它
  write(root, '.claude/skills/frontend-conventions/SKILL.md', '---\nname: frontend-conventions\ndescription: 前端元件寫法（改 src 底下的 jsx 前讀）\npaths: "src/**/*.{jsx,tsx}"\n---\n\n元件檔名用 PascalCase，一個檔一個元件。\n');
  const fe = path.join(root, '.claude', 'agents', 'frontend-engineer.md');
  const fet = fs.readFileSync(fe, 'utf8');
  if (!/^(description: .*\n)\n---/m.test(fet)) throw new Error('golden：frontend-engineer.md 的 frontmatter 沒有 skills 填空留下的空行');
  fs.writeFileSync(fe, fet.replace(/^(description: .*\n)\n---/m, (m, d) => `${d}skills: [frontend-conventions]\n---`));

  // hook 與 cases
  const learn = fs.existsSync(path.join(TPL, 'learn-trigger.js'));
  const hooks = [...HOOKS, ...(learn ? LEARN_HOOKS : [])];
  const files = new Set([...hooks.map((h) => h[0]), 'probe-hooks.js', ...(learn ? LEARN_EXTRA : [])]);
  for (const f of files) {
    write(root, `.claude/hooks/${f}`, fs.readFileSync(path.join(TPL, f), 'utf8'));
    const c = path.join(TPL, 'cases', f.replace(/\.js$/, '.json'));
    if (fs.existsSync(c)) write(root, `.claude/hooks/cases/${path.basename(c)}`, fs.readFileSync(c, 'utf8'));
  }
  // 有 .js hook 就一定帶 package.json（"type": "commonjs"；init-verify V19）
  write(root, '.claude/hooks/package.json', fs.readFileSync(path.join(TPL, 'package.json'), 'utf8'));
  const settings = { hooks: {} };
  const abs = root.split(path.sep).join('/');
  for (const [f, ev, matcher] of hooks) {
    (settings.hooks[ev] = settings.hooks[ev] || []).push({ matcher, hooks: [{ type: 'command', command: `node "${abs}/.claude/hooks/${f}"`, timeout: 15, statusMessage: '示範' }] });
  }
  write(root, '.claude/settings.local.json', JSON.stringify(settings, null, 2));
  if (learn) write(root, '.gitignore', fs.readFileSync(path.join(root, '.gitignore'), 'utf8') + '.claude/harness/learning/\n.claude/harness/.init-state.json\n');

  // 答案檔
  const ans = (asked, answer, data) => Object.assign({ asked, answer, date: TODAY, delegated: false }, data ? { data } : {});
  const installed = new Set(hooks.map((h) => h[0].replace(/\.js$/, '')));
  const catalog = L.catalogRows().map((r) => {
    const name = r.name.replace(/`/g, '');
    if (installed.has(name)) return { row: r.row, name, decision: 'installed', reason: '盤點與答案觸發', files: [name + '.js'] };
    if (/^learn-/.test(name) || /學習迴路/.test(name)) return { row: r.row, name, decision: learn ? 'installed' : 'not-installed', reason: learn ? '必裝' : '範本尚未提供' };
    if (r.row >= 20 && r.row <= 24) return { row: r.row, name, decision: 'plugin', reason: '由別的 plugin 提供' };
    return { row: r.row, name, decision: 'not-installed', reason: '觸發條件不成立' };
  });
  const answers = {
    version: 1, harnessVersion: L.pluginVersion(), runId: 'i-golden', target: root, landing: root, mode: 'normal', headless: false,
    glossaryFile: 'GLOSSARY.md',
    answers: {
      U1: ans('外部系統哪個是正式', '物流商 API 是測試環境', { systems: 1 }),
      U2: ans('做到哪', 'S1、S2 完成，S3 未開始'),
      U3: ans('專案用語', '出貨單', { confirmedTerms: ['出貨單'], removedTerms: [], originalCount: 0 }),
      Q1: ans('角色分工', '五個角色', { agents: ['backend-architect', 'backend-engineer', 'frontend-engineer', 'qa-engineer', 'code-reviewer'] }),
      Q2: ans('先問的動作', '寄信、物流商建單'),
      Q4: ans('單人或團隊', '單人', { team: false }),
      Q5: ans('自動檢查', '全部保留'),
      Q7: ans('必讀文件', 'README.md'),
      Q10: ans('用語表自動載入', '不載入', { import: false }),
      Q11: ans('註解規範', '不建', { choice: 'none' }),
      Q12: ans('選裝 skill', '都不要'),
    },
    hookCatalog: catalog,
    rulesSplit: RULES.map((r) => ({ file: r.file, load: 'paths', topic: r.topic, moved: [{ from: `CLAUDE.md「${r.topic}」`, text: r.body }] })),
  };
  write(root, '.claude/harness/init-answers.json', JSON.stringify(answers, null, 2));
  return root;
}

// Phase 0 快照的模擬：run.js 在 makeGolden 之前對範例專案跑 check-flow-diagram.js snapshot（真的拍，格式與 init 相同），
// 每份變體複本再用 seedSnapshot 把那份「init 之前」的快照搬到複本的路徑底下（快照以落點路徑區分，複本路徑不同就找不到）。
// add：變體裡要當成「init 之前就在、內容沒變」的檔（相對路徑），以它現在的雜湊加進快照。
function seedSnapshot(fromRoot, toRoot, add = []) {
  const snap = L.readSnapshot(fromRoot);
  if (!snap) throw new Error(`seedSnapshot：${fromRoot} 沒有快照（要先跑 check-flow-diagram.js snapshot）`);
  const files = Object.assign(Object.create(null), snap.files);
  for (const rel of add) files[rel] = L.fileSha1(path.join(toRoot, ...rel.split('/')));
  const p = L.snapshotPath(toRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ root: path.resolve(toRoot), takenAt: snap.takenAt, files, unreadable: snap.unreadable }));
  return p;
}
function dropSnapshot(root) { try { fs.unlinkSync(L.snapshotPath(root)); } catch {} }

// 壞變體：各弄壞一條，init-verify 要 exit 1 並報出 expect 這個 id
// snap: true＝這個變體要有 Phase 0 快照（run.js 跑完 apply 後 seedSnapshot，snapAdd 列的檔算 init 之前就在）；
// afterSnap：快照拍完之後再做的改動（模擬 init 期間改了既有檔）
const app = (root, rel, s) => fs.appendFileSync(path.join(root, rel), s);
const sub = (root, rel, a, b) => { const p = path.join(root, rel); const t = fs.readFileSync(p, 'utf8'); if (!t.includes(a)) throw new Error(`壞變體找不到要改的字：${rel}「${a}」`); fs.writeFileSync(p, t.replace(a, b)); };
const editJson = (root, rel, fn) => { const p = path.join(root, rel); const j = JSON.parse(fs.readFileSync(p, 'utf8')); fn(j); fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); };
// 一份合法的規則檔（paths 命中 single-web 的檔、列在 harness README），只差處置表有沒有記它
const extraRule = (root, rel) => {
  write(root, rel, '---\npaths:\n  - "src/**/*.{jsx,tsx}"\n---\n\n# 呼叫後端 API 規範\n\n呼叫後端一律經過共用的 fetch 包裝，不在元件裡直接寫網址。\n');
  app(root, '.claude/harness/README.md', `\n- \`${rel}\`（paths：src/**/*.{jsx,tsx}）\n`);
};
const BROKEN = [
  { name: '03 留了 {{ 填空', expect: 'V01-placeholder', apply: (r) => app(r, '.claude/harness/03-judgment-matrix.md', '\n驗證指令：{{測試指令}}\n') },
  { name: 'CLAUDE.md 本體長回 ## Changelog', expect: 'V02-changelog-body', apply: (r) => app(r, 'CLAUDE.md', '\n## Changelog\n- 2026-10-09 建立\n') },
  { name: 'agent 的變更紀錄少了建立那一行', expect: 'V03-changelog-created', apply: (r) => sub(r, '.claude/agents/CHANGELOG.md', `## code-reviewer.md\n- ${TODAY} 建立`, '## code-reviewer.md\n- （漏寫）') },
  { name: '05 節標題被改掉', expect: 'V04-section-05', apply: (r) => { const p = path.join(r, '.claude', 'harness', 'CHANGELOG.md'); const t = fs.readFileSync(p, 'utf8'); if (!/^## 05-knowledge-protocol\.md$/m.test(t)) throw new Error('找不到 05 節標題'); fs.writeFileSync(p, t.replace(/^## 05-knowledge-protocol\.md$/m, '## 05 知識協議')); } },
  { name: '來源專案的詞漏進實例', expect: 'V05-pollution', apply: (r) => app(r, 'CLAUDE.md', '\n資料存取一律用 Dapper。\n') },
  { name: '詞彙表寫成兩個檔名', expect: 'V06-glossary-single', apply: (r) => app(r, '.claude/harness/04-delegation-templates.md', '\n專案用語見 GLOSSARY.md（沒有就讀 CONTEXT.md）。\n') },
  { name: 'CLAUDE.md 引用不存在的路徑', expect: 'V07-paths', apply: (r) => app(r, 'CLAUDE.md', '\n- 部署手冊：`docs/deploy-guide.md`\n') },
  { name: '03 的驗證指令本體不存在', expect: 'V08-verify-cmds', apply: (r) => app(r, '.claude/harness/03-judgment-matrix.md', '\n冒煙測試＝`npm run e2e:smoke`\n') },
  { name: 'hook 語法錯', expect: 'V09-hook-syntax', apply: (r) => app(r, '.claude/hooks/check-ask-discipline.js', '\nfunction broken( {\n') },
  { name: 'settings 壞 JSON', expect: 'V10-settings-json', apply: (r) => app(r, '.claude/settings.local.json', ',,}') },
  { name: '檔尾被截斷（沒有完整的最後一行）', expect: 'V11-eof', apply: (r) => { const p = path.join(r, 'FLOWS.md'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n+$/, '') + '\n## 鏈 2：寫到一半'); } },
  { name: 'PROJECT.md 寫了帳密字面值', expect: 'V12-secrets', apply: (r) => app(r, 'tests/Project_Detail/PROJECT.md', '\n- 測試庫：postgres://qa_reader:Sup3rS3cret@db.example.test/qa\n') },
  { name: '專案概要少了目前進度', expect: 'V13-overview', apply: (r) => { const p = path.join(r, 'CLAUDE.md'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^- \*\*目前進度\*\*.*\n/m, '')); } },
  { name: '答案檔的確認詞數與詞彙表不符', expect: 'V14-glossary-count', apply: (r) => editJson(r, '.claude/harness/init-answers.json', (j) => { j.answers.U3.data.confirmedTerms.push('結案'); }) },
  { name: '答案檔缺必答題', expect: 'V15-answers-schema', apply: (r) => editJson(r, '.claude/harness/init-answers.json', (j) => { delete j.answers.Q7; }) },
  { name: '形狀目錄少一列去向', expect: 'V16-catalog', apply: (r) => editJson(r, '.claude/harness/init-answers.json', (j) => { j.hookCatalog.pop(); }) },
  { name: '裝了 hook 卻沒接線', expect: 'V17-wiring', apply: (r) => fs.copyFileSync(path.join(TPL, 'guard-report-output.js'), path.join(r, '.claude', 'hooks', 'guard-report-output.js')) },
  { name: '學習迴路少接一個事件', expect: 'V18-learning', learnOnly: true, apply: (r) => editJson(r, '.claude/settings.local.json', (j) => { j.hooks.SessionEnd = []; }) },
  { name: '學習迴路沒接使用者核可（learn-approve）', expect: 'V18-learning', learnOnly: true, apply: (r) => editJson(r, '.claude/settings.local.json', (j) => { j.hooks.UserPromptSubmit = (j.hooks.UserPromptSubmit || []).filter((g) => !JSON.stringify(g).includes('learn-approve.js')); }) },
  { name: '工具呼叫計數的 matcher 只接 Bash', expect: 'V18-learning', learnOnly: true, apply: (r) => editJson(r, '.claude/settings.local.json', (j) => { for (const g of j.hooks.PreToolUse) if (JSON.stringify(g).includes('learn-trigger.js')) g.matcher = 'Bash'; }) },
  { name: '用量計數的 matcher 漏了 Skill', expect: 'V18-learning', learnOnly: true, apply: (r) => editJson(r, '.claude/settings.local.json', (j) => { for (const g of j.hooks.PreToolUse) if (JSON.stringify(g).includes('learn-usage.js')) g.matcher = 'Read'; }) },
  { name: '.claude/hooks 沒有 package.json（專案根是 type: module 時每支 hook 載入就失敗）', expect: 'V19-hooks-commonjs', apply: (r) => fs.unlinkSync(path.join(r, '.claude', 'hooks', 'package.json')) },
  { name: '.claude/hooks/package.json 被改成 type: module', expect: 'V19-hooks-commonjs', apply: (r) => editJson(r, '.claude/hooks/package.json', (j) => { j.type = 'module'; }) },
  { name: '規則檔的 glob 在專案裡命中 0 個檔', expect: 'V20-rules-paths', apply: (r) => sub(r, '.claude/rules/frontend.md', '- "src/**/*.{jsx,tsx}"', '- "web/**/*.vue"') },
  { name: '規則檔的 paths 用 ./ 開頭（Claude Code 不認）', expect: 'V20-rules-paths', apply: (r) => sub(r, '.claude/rules/tests.md', '- "tests/**/*.test.js"', '- "./tests/**/*.test.js"') },
  { name: 'CLAUDE.md 殘留已搬進規則檔的段落', expect: 'V21-rules-split', apply: (r) => app(r, 'CLAUDE.md', `\n- ${RULES[0].body}\n`) },
  { name: '.claude/rules/ 裡放了沒有 paths 的 CHANGELOG（會在啟動時整份載入）', expect: 'V21-rules-split', apply: (r) => fs.writeFileSync(path.join(r, '.claude', 'rules', 'CHANGELOG.md'), `# 規則變更紀錄\n\n- ${TODAY} 建立\n`) },
  { name: '規則檔沒列在路由表', expect: 'V21-rules-split', apply: (r) => { const p = path.join(r, 'CLAUDE.md'); const t = fs.readFileSync(p, 'utf8'); const n = t.split('\n').filter((l) => !l.includes('.claude/rules/tests.md')).join('\n'); if (n === t) throw new Error('找不到路由表的規則檔那一列'); fs.writeFileSync(p, n); } },
  { name: '子目錄多一份規則檔、答案檔 rulesSplit 沒有它的紀錄（漏跑 init-flow.js rules）', expect: 'V21-rules-split', apply: (r) => extraRule(r, '.claude/rules/web/api.md') },
  { name: '答案檔 rulesSplit 記了一份不存在的規則檔', expect: 'V21-rules-split', apply: (r) => editJson(r, '.claude/harness/init-answers.json', (j) => { j.rulesSplit.push({ file: '.claude/rules/ghost.md', load: 'paths', topic: '已刪掉的規則' }); }) },
  { name: '新建的規則檔標成沿用（origin: kept），Phase 0 快照裡沒有它', expect: 'V21-rules-split', snap: true, apply: (r) => {
    extraRule(r, '.claude/rules/web/fresh.md');
    editJson(r, '.claude/harness/init-answers.json', (j) => { j.rulesSplit.push({ file: '.claude/rules/web/fresh.md', load: 'paths', origin: 'kept', topic: '呼叫後端 API' }); });
  } },
  { name: '沿用的既有規則檔在 init 期間被改寫，處置表仍記 origin: kept', expect: 'V21-rules-split', snap: true, snapAdd: ['.claude/rules/web/legacy.md'], apply: (r) => {
    extraRule(r, '.claude/rules/web/legacy.md');
    editJson(r, '.claude/harness/init-answers.json', (j) => { j.rulesSplit.push({ file: '.claude/rules/web/legacy.md', load: 'paths', origin: 'kept', topic: '既有 API 規範' }); });
  }, afterSnap: (r) => app(r, '.claude/rules/web/legacy.md', '\n逾時一律 10 秒。\n') },
  { name: '沒動過的既有規則檔記成新建（origin 沒寫）', expect: 'V21-rules-split', snap: true, snapAdd: ['.claude/rules/web/legacy.md'], apply: (r) => {
    extraRule(r, '.claude/rules/web/legacy.md');
    app(r, 'CLAUDE.changelog.md', `- ${TODAY} 建立 .claude/rules/web/legacy.md（harness plugin /harness:init 實例化）\n`);
    editJson(r, '.claude/harness/init-answers.json', (j) => { j.rulesSplit.push({ file: '.claude/rules/web/legacy.md', load: 'paths', topic: '既有 API 規範' }); });
  } },
  { name: 'skill 的 paths 在專案裡命中 0 個檔', expect: 'V22-skill-paths', apply: (r) => sub(r, '.claude/skills/frontend-conventions/SKILL.md', 'paths: "src/**/*.{jsx,tsx}"', 'paths: "app/**/*.vue"') },
  { name: 'agent 的 skills: 指到不存在的 skill', expect: 'V22-skill-paths', apply: (r) => sub(r, '.claude/agents/frontend-engineer.md', 'skills: [frontend-conventions]', 'skills: [frontend-conventions, ui-kit-rules]') },
];

// 合法變體：各改一處仍合規，init-verify 要 exit 0 且 expect 這個 id 是 PASS；evidence＝證據要含的字樣
const keptLegacy = (r) => {
  extraRule(r, '.claude/rules/web/legacy.md');
  editJson(r, '.claude/harness/init-answers.json', (j) => { j.rulesSplit.push({ file: '.claude/rules/web/legacy.md', load: 'paths', origin: 'kept', topic: '既有 API 規範' }); });
};
const VALID = [
  { name: '參考模式沿用既有規則檔（子目錄、沒有建立那一行），處置表記 origin: kept，Phase 0 快照裡有它且內容沒變', expect: 'V21-rules-split',
    snap: true, snapAdd: ['.claude/rules/web/legacy.md'], evidence: /沿用 1 份對過 Phase 0 快照/, apply: keptLegacy },
  { name: '沒有 Phase 0 快照（舊版 init 的實例）：origin: kept 照舊放行，證據寫明未核對', expect: 'V21-rules-split',
    evidence: /無快照（.*），kept 未核對/, apply: keptLegacy },
  { name: '改寫 Phase 0 之前就在的規則檔、記成新建並寫建立那一行', expect: 'V21-rules-split', snap: true, snapAdd: ['.claude/rules/web/legacy.md'],
    evidence: /legacy\.md 在 Phase 0 之前就在、這次改寫過/, apply: (r) => {
      extraRule(r, '.claude/rules/web/legacy.md');
      app(r, 'CLAUDE.changelog.md', `- ${TODAY} 沿用 .claude/rules/web/legacy.md 並改寫（加上逾時規定；harness plugin /harness:init 實例化）\n`);
      editJson(r, '.claude/harness/init-answers.json', (j) => { j.rulesSplit.push({ file: '.claude/rules/web/legacy.md', load: 'paths', origin: 'new', topic: '既有 API 規範' }); });
    }, afterSnap: (r) => app(r, '.claude/rules/web/legacy.md', '\n逾時一律 10 秒。\n') },
];

module.exports = { makeGolden, BROKEN, VALID, TODAY, seedSnapshot, dropSnapshot };
