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

  // hook 與 cases
  const learn = fs.existsSync(path.join(TPL, 'learn-trigger.js'));
  const hooks = [...HOOKS, ...(learn ? LEARN_HOOKS : [])];
  const files = new Set([...hooks.map((h) => h[0]), 'probe-hooks.js', ...(learn ? LEARN_EXTRA : [])]);
  for (const f of files) {
    write(root, `.claude/hooks/${f}`, fs.readFileSync(path.join(TPL, f), 'utf8'));
    const c = path.join(TPL, 'cases', f.replace(/\.js$/, '.json'));
    if (fs.existsSync(c)) write(root, `.claude/hooks/cases/${path.basename(c)}`, fs.readFileSync(c, 'utf8'));
  }
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
  };
  write(root, '.claude/harness/init-answers.json', JSON.stringify(answers, null, 2));
  return root;
}

// 壞變體：各弄壞一條，init-verify 要 exit 1 並報出 expect 這個 id
const app = (root, rel, s) => fs.appendFileSync(path.join(root, rel), s);
const sub = (root, rel, a, b) => { const p = path.join(root, rel); const t = fs.readFileSync(p, 'utf8'); if (!t.includes(a)) throw new Error(`壞變體找不到要改的字：${rel}「${a}」`); fs.writeFileSync(p, t.replace(a, b)); };
const editJson = (root, rel, fn) => { const p = path.join(root, rel); const j = JSON.parse(fs.readFileSync(p, 'utf8')); fn(j); fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); };
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
];

module.exports = { makeGolden, BROKEN, TODAY };
