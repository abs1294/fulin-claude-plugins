#!/usr/bin/env node
'use strict';
/**
 * harness plugin 回歸測試入口。零相依；每個測試在系統暫存目錄建、跑完刪。
 *
 * 用法：node plugins/harness/tests/run.js [--skip-probe] [--only <套件>[,<套件>…]]
 *   --skip-probe：跳過 hooks/templates 的 probe-hooks 全量（兩輪約 10 分鐘），只供開發中快速迭代；完成驗收一律不跳。
 * 結束碼：0＝全數通過；1＝有失敗。最後一行「合計 PASS n / FAIL n」。
 *
 * 套件：size、b5、b8、b9、split-audit、fixtures、golden、init-flow、schema、plugin-hooks、learn-offline、probe
 * 不在這裡的：真實端到端（claude -p 跑一次完整 /harness:init），只跑一次當驗收證據，結論記在 docs/learning-loop-design.md §11。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..');
const INIT = path.join(PLUGIN, 'skills', 'init');
const PHASES = path.join(INIT, 'references', 'phases');
const TPL = path.join(PLUGIN, 'hooks', 'templates');
const L = require(path.join(INIT, 'scripts', 'init-lib.js'));
const { makeFixture } = require('./lib/fixtures.js');
const { makeGolden, BROKEN } = require('./lib/golden.js');

const args = process.argv.slice(2);
const skipProbe = args.includes('--skip-probe');
const onlyArg = args.indexOf('--only') >= 0 ? args[args.indexOf('--only') + 1] : null;
const only = onlyArg ? new Set(onlyArg.split(',')) : null;

let pass = 0, fail = 0;
const failures = [];
function check(suite, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(`${suite} | ${detail}`); }
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${suite} | ${detail}`);
}
const read = (p) => fs.readFileSync(p, 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
function walk(d) { const out = []; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p); } return out; }
const node = (argv, opts = {}) => spawnSync(process.execPath, argv, Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts));
const want = (s) => !only || only.has(s);

// ── size：SKILL 主檔與拆出檔的大小、兩個 description 的長度（B1、B9）──
if (want('size')) {
  const skill = read(path.join(INIT, 'SKILL.md'));
  const lines = skill.split('\n').length;
  check('size', lines <= 300, `SKILL.md ${lines} 行（上限 300）`);
  check('size', skill.length <= 25000, `SKILL.md ${skill.length} 字元（上限 25000）`);
  for (const f of walk(PHASES)) {
    const n = read(f).length;
    check('size', n <= 20000, `${path.relative(INIT, f).split(path.sep).join('/')} ${n} 字元（上限 20000）`);
  }
  const desc = (skill.match(/^description: (.*)$/m) || [])[1] || '';
  const first = desc.split('。')[0];
  check('size', desc.length > 0 && desc.length <= 1024, `init description ${desc.length} 字元（上限 1024）`);
  check('size', /\/harness:init/.test(first) && /幫這個專案裝 harness/.test(first), `init description 第一句就是觸發詞：「${first.slice(0, 60)}…」`);
  const pj = JSON.parse(read(path.join(PLUGIN, '.claude-plugin', 'plugin.json')));
  check('size', pj.description.length <= 400, `plugin.json description ${pj.description.length} 字元（上限 400）`);
  check('size', /\/harness:(init|review)/.test(pj.description.slice(0, 80)), 'plugin.json description 前 80 字就講用途與觸發（/harness:init 或 /harness:review）');
  // 每個 Phase 寫明「進入本階段先讀」，而且指到的檔真的存在
  for (let n = 0; n <= 6; n++) {
    const sec = (skill.split(/^## /m).find((x) => x.startsWith(`Phase ${n} `)) || '');
    const refs = [...sec.matchAll(/`(references\/phases\/[^`]+\.md)`/g)].map((m) => m[1]);
    check('size', /進入本階段先讀/.test(sec) && refs.length > 0 && refs.every((r) => fs.existsSync(path.join(INIT, r))), `SKILL.md Phase ${n} 寫了「進入本階段先讀」且檔存在：${refs.join('、') || '（沒找到）'}`);
  }
}

// ── b5：事故敘述搬到 rationale.md ──
if (want('b5')) {
  const files = [path.join(INIT, 'SKILL.md'), ...walk(PHASES)];
  for (const f of files) {
    const hits = read(f).split('\n').filter((l) => /實際回饋|實際紀錄|實際發生過/.test(l)).length;
    check('b5', hits === 0, `${path.relative(INIT, f).split(path.sep).join('/')}：「實際回饋|實際紀錄|實際發生過」${hits} 處`);
  }
  const rat = path.join(INIT, 'references', 'rationale.md');
  check('b5', fs.existsSync(rat) && /## Phase 0/.test(read(rat)) && /## Phase 6/.test(read(rat)), 'references/rationale.md 存在且依 Phase 分節');
}

// ── b8：訪談合併三題的例外段落，一次一題的規則句仍在 ──
if (want('b8')) {
  const p3 = read(path.join(PHASES, 'phase-3-interview.md'));
  check('b8', /唯一的例外：Q4、Q10、Q11 合成同一則訊息問/.test(p3) && /彼此的答案不影響另外兩題的選項與推薦/.test(p3), 'phase-3 寫明 Q4／Q10／Q11 合併與理由');
  check('b8', /一次一題，不要湊成一次 AskUserQuestion/.test(p3), 'phase-3 仍保留「一次一題」規則句');
  check('b8', /合併一則/.test(read(path.join(PHASES, 'questions', 'how-to-ask.md'))), 'how-to-ask.md 有合併一則的講法');
}

// ── b9：形狀目錄列數與文字一致（不寫死會過時的數字）──
if (want('b9')) {
  const rows = L.catalogRows();
  check('b9', rows.length > 0 && rows.every((r, i) => r.row === i + 1), `形狀目錄目錄表 ${rows.length} 列，編號 1..${rows.length} 連續`);
  const texts = [path.join(INIT, 'references', 'hook-catalog.md'), path.join(INIT, 'SKILL.md'), ...walk(PHASES), path.join(PLUGIN, 'README.md')];
  for (const f of texts) {
    const m = read(f).match(/\d+\s*支\s*hook\s*[＋+]\s*\d+\s*個\s*plugin/);
    check('b9', !m, `${path.relative(PLUGIN, f).split(path.sep).join('/')} 沒有寫死「N 支 hook＋M 個 plugin」${m ? '（找到：' + m[0] + '）' : ''}`);
  }
  const g = tmp('h-b9-');
  try {
    makeFixture('single-web', g); makeGolden(g);
    const a = JSON.parse(read(path.join(g, '.claude', 'harness', 'init-answers.json')));
    check('b9', a.hookCatalog.length === rows.length, `標準實例的 hookCatalog ${a.hookCatalog.length} 列＝形狀目錄 ${rows.length} 列`);
  } finally { rm(g); }
}

// ── split-audit：拆分前後規則句對帳（B1）──
if (want('split-audit')) {
  let orig = path.join(__dirname, 'fixtures', 'skill-0.15.2.md');
  try { // 優先用 git 取 0.15.2 的原檔（與快照應一致）
    const out = execFileSync('git', ['show', '6c657a7:plugins/harness/skills/init/SKILL.md'], { cwd: PLUGIN, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    check('split-audit', out.replace(/\r\n/g, '\n') === read(orig).replace(/\r\n/g, '\n'), 'tests/fixtures/skill-0.15.2.md 與 git 6c657a7 的原檔一致');
  } catch { console.log('     （取不到 git 6c657a7，直接用快照）'); }
  const r = node([path.join(__dirname, 'lib', 'split-audit.js'), orig, path.join(INIT, 'SKILL.md'), PHASES, path.join(INIT, 'references', 'rationale.md'),
    '--waivers', path.join(__dirname, 'fixtures', 'split-audit-waivers.json')]);
  const head = (r.stdout || '').split('\n')[0];
  check('split-audit', r.status === 0, `${head}${r.status ? '\n' + r.stdout.split('\n').slice(1, 30).join('\n') : ''}`);
}

// ── fixtures：四個範例專案的形狀（Phase 0-1 三分類、參考模式）──
if (want('fixtures')) {
  const isRepo = (d) => spawnSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const same = (a, b) => path.resolve(String(a).trim()).toLowerCase() === path.resolve(b).toLowerCase();
  const root = tmp('h-fx-');
  try {
    const sw = makeFixture('single-web', path.join(root, 'single-web'));
    const r1 = isRepo(sw);
    check('fixtures', r1.status === 0 && same(r1.stdout, sw) && fs.existsSync(path.join(sw, 'index.html')), 'single-web：根目錄就是 repo、有 index.html（瀏覽器可驅動）');
    const mr = makeFixture('multi-repo', path.join(root, 'multi-repo'));
    check('fixtures', !same(isRepo(mr).stdout || 'x:/none', mr) && isRepo(path.join(mr, 'web')).status === 0 && isRepo(path.join(mr, 'api')).status === 0, 'multi-repo：根目錄不是 repo、web 與 api 各是 repo');
    const ng = makeFixture('non-git', path.join(root, 'non-git'));
    check('fixtures', !same(isRepo(ng).stdout || 'x:/none', ng) && !fs.existsSync(path.join(ng, '.git')), 'non-git：不是 git 專案');
    const rf = makeFixture('reference', path.join(root, 'reference'));
    check('fixtures', fs.existsSync(path.join(rf, 'CLAUDE.md')) && fs.existsSync(path.join(rf, '.claude', 'agents', 'reviewer.md')) && fs.existsSync(path.join(rf, '.claude', 'hooks', 'block-prod-db.js')) && fs.existsSync(path.join(rf, 'CONTEXT.md')), 'reference：有 CLAUDE.md、自己的 agent 與 hook、舊檔名詞彙表（參考模式）');
    // 範例專案自己的測試指令要跑得起來：init 盤點會實跑它，壞掉的指令會被當成專案本身的問題回報
    const TEST_TIMEOUT_MS = 60000;
    for (const dir of [sw, path.join(mr, 'web'), path.join(mr, 'api'), rf]) {
      const pkg = path.join(dir, 'package.json');
      const label = path.relative(root, dir).replace(/\\/g, '/');
      const script = fs.existsSync(pkg) ? (JSON.parse(read(pkg)).scripts || {}).test : undefined;
      const argv = typeof script === 'string' ? script.trim().split(/\s+/) : [];
      if (argv[0] !== 'node') { check('fixtures', false, `${label}：package.json 的 test 指令不是 node 開頭，測試不知道怎麼跑：${script}`); continue; }
      const r = spawnSync(process.execPath, argv.slice(1), { cwd: dir, encoding: 'utf8', timeout: TEST_TIMEOUT_MS });
      // node --test 一個測試檔都沒找到時也 exit 0，所以另外要求至少跑到 1 個測試
      const ran = Number((/^# tests (\d+)/m.exec(r.stdout || '') || [])[1] || 0);
      const result = r.error && r.error.code === 'ETIMEDOUT' ? `逾時（超過 ${TEST_TIMEOUT_MS / 1000} 秒被終止）` : `exit ${r.status}`;
      check('fixtures', r.status === 0 && ran > 0, `${label}：npm test（${script}）${result}、跑了 ${ran} 個測試${r.error && r.error.code !== 'ETIMEDOUT' ? '、' + r.error.message : ''}`);
    }
  } finally { rm(root); }
}

// ── golden：標準實例 init-verify exit 0；每個壞變體 exit 1 且報出對應 id（B3）──
if (want('golden')) {
  const base = tmp('h-golden-');
  try {
    makeFixture('single-web', base); makeGolden(base);
    const r = node([path.join(INIT, 'scripts', 'init-verify.js'), base]);
    check('golden', r.status === 0, `標準實例 init-verify exit ${r.status}：${(r.stdout.match(/合計.*$/m) || [''])[0]}${r.status ? '\n' + r.stdout.split('\n').filter((l) => /FAIL/.test(l)).join('\n') : ''}`);
    const learn = fs.existsSync(path.join(TPL, 'learn-trigger.js'));
    let n = 0;
    for (const b of BROKEN) {
      if (b.learnOnly && !learn) { check('golden', false, `壞變體「${b.name}」需要學習迴路範本，但 hooks/templates 沒有 learn-trigger.js`); continue; }
      const d = tmp('h-bad-');
      try {
        fs.cpSync(base, d, { recursive: true });
        // 設定檔裡的絕對路徑跟著換成這份複本
        const sp = path.join(d, '.claude', 'settings.local.json');
        fs.writeFileSync(sp, read(sp).split(base.split(path.sep).join('/')).join(d.split(path.sep).join('/')));
        b.apply(d);
        const rr = node([path.join(INIT, 'scripts', 'init-verify.js'), d]);
        const fails = (rr.stdout.match(/^(V\d\d-[\w-]+) \| FAIL/mg) || []).map((x) => x.split(' ')[0]);
        check('golden', rr.status === 1 && fails.includes(b.expect), `壞變體「${b.name}」→ exit ${rr.status}，報出 ${fails.join('、') || '（無）'}（應含 ${b.expect}）`);
        n++;
      } finally { rm(d); }
    }
    check('golden', n >= 8, `壞變體 ${n} 個（至少 8 個）`);
  } finally { rm(base); }
}

// ── init-flow：階段狀態機（B2、B4）──
if (want('init-flow')) {
  const d = tmp('h-flow-');
  const flow = (...a) => node([path.join(INIT, 'scripts', 'init-flow.js'), ...a]);
  const ansFile = path.join(d, '..', path.basename(d) + '-ans.json');
  const answer = (id, obj) => { fs.writeFileSync(ansFile, JSON.stringify(obj)); return flow('answer', d, id, '--file', ansFile); };
  try {
    check('init-flow', flow('advance', d, '1').status === 2, '沒有 start 就 advance → exit 2');
    check('init-flow', flow('start', d).status === 0, 'start → exit 0');
    check('init-flow', flow('start', d).status === 1, '進行中再 start（沒帶 --resume／--restart）→ exit 1');
    check('init-flow', flow('start', d, '--resume').status === 0, 'start --resume 接續 → exit 0');
    check('init-flow', flow('advance', d, '2').status === 1, '跳號 advance 2（目前 Phase 0）→ exit 1');
    check('init-flow', flow('advance', d, '1').status === 1, '沒有快照 advance 1 → exit 1');
    check('init-flow', answer('Q12', { asked: '選裝 skill', answer: '都不要' }).status === 1, 'Phase 0 就寫答案（訪談前預填）→ exit 1');
    fs.writeFileSync(ansFile, '[]');
    check('init-flow', flow('catalog', d, '--file', ansFile).status === 1, 'Phase 0 就寫形狀目錄去向 → exit 1');
    node([path.join(INIT, 'scripts', 'check-flow-diagram.js'), 'snapshot', d]);
    check('init-flow', flow('advance', d, '1').status === 0 && flow('advance', d, '2').status === 0 && flow('advance', d, '3').status === 0, '拍快照後依序 advance 1→2→3');
    check('init-flow', flow('waive', d, 'V07-paths', '--match', 'x', '--reason', 'y').status === 1, 'Phase 3 就登記 init-verify 豁免（生成前）→ exit 1');
    check('init-flow', flow('mode', d, 'reference').status === 1, 'Phase 3 以後切模式（躲參考模式必答）→ exit 1');
    check('init-flow', flow('advance', d, '4').status === 1, '沒有答案就 advance 4 → exit 1');
    check('init-flow', answer('Q4', { asked: '單人或團隊', answer: '單人', data: { team: 'yes' } }).status === 1, 'data 型別錯（team 不是布林）→ 不寫入 exit 1');
    const r0 = flow('answer', d, 'U2', '--json', '-'); // stdin 沒東西 → JSON 解析失敗
    check('init-flow', r0.status === 1, '--json - 讀到空的 stdin → exit 1');
    const base = { U1: { skipped: { reason: '沒有外部系統' } }, U2: { answer: '做到 S2' }, U3: { answer: '無', data: { confirmedTerms: [], removedTerms: [], originalCount: 0 } },
      Q1: { answer: '照預設', data: { agents: ['qa-engineer'] } }, Q2: { answer: '寄信' }, Q4: { answer: '單人', data: { team: false } }, Q5: { answer: '全裝' },
      Q7: { answer: 'README' }, Q10: { answer: '匯入', data: { import: true } }, Q11: { answer: '不建', data: { choice: 'none' } } };
    let allOk = true;
    for (const [id, v] of Object.entries(base)) if (answer(id, Object.assign({ asked: id + ' 問了什麼' }, v)).status !== 0) allOk = false;
    check('init-flow', allOk, '十題答案依序寫入（含 skipped 理由、data 欄位）');
    const st = flow('advance', d, '4');
    check('init-flow', st.status === 1 && /Q12/.test(st.stdout), '缺必答 Q12 → advance 4 exit 1 且點名 Q12');
    answer('Q12', { asked: '選裝 skill', answer: '都不要' });
    check('init-flow', flow('advance', d, '4').status === 0, '必答齊了 → advance 4');
    const a = JSON.parse(read(path.join(d, '.claude', 'harness', 'init-answers.json')));
    check('init-flow', L.checkAnswers(a).length === 0 && a.answers.U2.date && a.answers.U2.delegated === false, '答案檔通過 schema、每題有日期與是否代決');
    check('init-flow', flow('advance', d, '5').status === 1, '沒生成就 advance 5 → exit 1');
    check('init-flow', flow('waive', d, 'V12-secrets', '--match', 'x', '--reason', 'y').status === 1, 'V12 帳密不可豁免 → exit 1');
    check('init-flow', flow('waive', d, 'V19-hooks-commonjs', '--match', 'x', '--reason', 'y').status === 1, 'V19 hook 模組格式不可豁免 → exit 1');
    check('init-flow', flow('waive', d, 'V07-paths', '--match', 'docs/x.md', '--reason', '使用者說之後會建').status === 0, 'V07 可豁免（帶理由）→ exit 0');
    check('init-flow', flow('done', d).status === 1, '還在 Phase 4 就 done → exit 1');
    check('init-flow', flow('abort', d).status === 2, 'abort 沒帶理由 → exit 2');
    check('init-flow', flow('abort', d, '--reason', '使用者要中止').status === 0, 'abort --reason → exit 0');
    const s = JSON.parse(read(path.join(d, '.claude', 'harness', '.init-state.json')));
    check('init-flow', s.status === 'aborted' && s.history.some((h) => h.event === 'abort' && /中止/.test(h.note)), '狀態檔記下 aborted 與理由');
    check('init-flow', flow('advance', d, '5').status === 1, 'aborted 之後不能再 advance');
    check('init-flow', flow('abort', d, '--reason', '再中止一次').status === 1, 'aborted（或 done）之後不能再 abort → exit 1');
    // Phase 6 之後改壞實例（或改答案、豁免）→ done 重跑 init-verify、擋下
    const g6 = tmp('h-flow-done-');
    try {
      makeFixture('single-web', g6); makeGolden(g6);
      const a6 = JSON.parse(read(path.join(g6, '.claude', 'harness', 'init-answers.json')));
      fs.writeFileSync(path.join(g6, '.claude', 'harness', '.init-state.json'), JSON.stringify({ version: 1, runId: a6.runId, target: g6, landing: g6, mode: 'normal', headless: true, phase: 6, status: 'running', gateBlocks: 0,
        history: [{ at: new Date().toISOString(), event: 'advance', phase: 6, note: '' }] }));
      fs.appendFileSync(path.join(g6, 'CLAUDE.md'), '\n驗證指令：{{測試指令}}\n');
      const rd6 = flow('done', g6);
      check('init-flow', rd6.status === 1 && /init-verify\.js 沒過/.test(rd6.stdout) && /V01-placeholder/.test(rd6.stdout), 'Phase 6 之後改壞實例 → done 重跑 init-verify、exit 1 並點名 V01');
    } finally { rm(g6); }
  } finally { rm(d); try { fs.unlinkSync(ansFile); } catch {} }
}

// ── schema：答案檔小驗證器正反兩向（B4）──
if (want('schema')) {
  const schema = L.loadSchema();
  const g = tmp('h-schema-');
  try {
    makeFixture('single-web', g); makeGolden(g);
    const good = JSON.parse(read(path.join(g, '.claude', 'harness', 'init-answers.json')));
    check('schema', L.validate(schema, good).length === 0, '標準實例的 init-answers.json 合法');
    const bad = [
      ['缺 version', (j) => { delete j.version; }],
      ['mode 不在列舉', (j) => { j.mode = 'auto'; }],
      ['題號不認得', (j) => { j.answers.Q99 = j.answers.Q1; }],
      ['日期格式錯', (j) => { j.answers.Q1.date = '10/09'; }],
      ['delegated 不是布林', (j) => { j.answers.Q1.delegated = 'no'; }],
      ['hookCatalog decision 不在列舉', (j) => { j.hookCatalog[0].decision = 'maybe'; }],
      ['多了不認得的頂層欄位', (j) => { j.extra = 1; }],
    ];
    for (const [name, fn] of bad) { const j = JSON.parse(JSON.stringify(good)); fn(j); const e = L.validate(schema, j); check('schema', e.length > 0, `${name} → 被抓到（${e[0] || '沒抓到'}）`); }
  } finally { rm(g); }
}

// ── plugin-hooks：plugin 層 hook 的 cases（init-stop-gate、init-state-guard）用 probe-hooks 同款跑法 ──
if (want('plugin-hooks')) {
  const d = tmp('h-ph-');
  try {
    fs.copyFileSync(path.join(TPL, 'probe-hooks.js'), path.join(d, 'probe-hooks.js'));
    fs.mkdirSync(path.join(d, 'cases'));
    for (const f of fs.readdirSync(path.join(PLUGIN, 'hooks', 'cases'))) {
      const hook = f.replace(/\.json$/, '.js');
      fs.copyFileSync(path.join(PLUGIN, 'hooks', 'cases', f), path.join(d, 'cases', f));
      fs.copyFileSync(path.join(PLUGIN, 'hooks', hook), path.join(d, hook));
    }
    const r = node([path.join(d, 'probe-hooks.js')]);
    const tot = (r.stdout.match(/合計.*$/m) || [''])[0];
    check('plugin-hooks', r.status === 0, `init-stop-gate／init-state-guard cases：${tot}${r.status ? '\n' + r.stdout.split('\n').filter((l) => /^FAIL|stdout|stderr/.test(l)).join('\n') : ''}`);
    const names = r.stdout.split('\n').filter((l) => /^PASS \| init-stop-gate/.test(l)).map((l) => l.split('|').pop().trim());
    for (const k of ['(a)', '(b)', '(c)', '(d)', '(e)']) check('plugin-hooks', names.some((x) => x.startsWith(k)), `Stop 閘案例 ${k} 實跑通過`);
  } finally { rm(d); }
  // 狀態檔寫不進去（擋下次數記不了、連擋 3 次的出口失效）→ 放行並印錯
  const d2 = tmp('h-ph-ro-');
  const hd = path.join(d2, '.claude', 'harness');
  const sp = path.join(hd, '.init-state.json');
  try {
    fs.mkdirSync(hd, { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ version: 1, status: 'running', phase: 4, target: d2, gateBlocks: 0, history: [{ at: new Date().toISOString(), event: 'advance', phase: 4 }] }));
    fs.chmodSync(sp, 0o444);
    if (process.platform !== 'win32') fs.chmodSync(hd, 0o555);
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'init-stop-gate.js')], { input: JSON.stringify({ hook_event_name: 'Stop', cwd: d2, last_assistant_message: '全部安裝完成。' }), encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: d2 }) });
    check('plugin-hooks', r.status === 0 && !/"decision"\s*:\s*"block"/.test(r.stdout) && /寫不進去/.test(r.stderr), `Stop 閘：狀態檔唯讀、寫不進擋下次數 → 放行並印錯（exit ${r.status}，stderr ${String(r.stderr).trim().slice(0, 80)}）`);
  } finally {
    try { if (process.platform !== 'win32') fs.chmodSync(hd, 0o755); fs.chmodSync(sp, 0o644); } catch {}
    rm(d2);
  }
}

// ── learn-offline：學習迴路整段離線測試（假 claude）──
if (want('learn-offline')) {
  const lo = path.join(__dirname, 'lib', 'learn-offline.js');
  if (!fs.existsSync(lo)) check('learn-offline', false, 'tests/lib/learn-offline.js 不存在');
  else {
    const r = node([lo], { env: Object.assign({}, process.env, { CLAUDECODE: '' }), timeout: 900000 });
    for (const l of (r.stdout || '').split('\n')) { const m = l.match(/^(PASS|FAIL)\s+(.*)$/); if (m) check('learn-offline', m[1] === 'PASS', m[2]); }
    check('learn-offline', r.status === 0, `learn-offline.js exit ${r.status}${r.status ? '\n' + String(r.stderr || '').slice(-1500) : ''}`);
  }
}

// ── probe：hooks/templates 全量 probe-hooks，語法樹與正則兩條路徑 ──
if (want('probe')) {
  if (skipProbe) console.log('SKIP | probe | --skip-probe：沒跑 probe-hooks 全量（完成驗收不准跳）');
  else {
    for (const mode of [[], ['--parser=off']]) {
      const r = node([path.join(TPL, 'probe-hooks.js'), ...mode], { cwd: TPL, timeout: 1200000 });
      const tot = (r.stdout.match(/合計 PASS (\d+) \/ FAIL (\d+) \/ 缺 cases (\d+).*$/m) || []);
      check('probe', r.status === 0 && tot[2] === '0' && tot[3] === '0', `probe-hooks.js ${mode.join(' ') || '（語法樹路徑）'}：${tot[0] || '沒有合計行'}${r.status ? '\n' + r.stdout.split('\n').filter((l) => /^FAIL|^MISS/.test(l)).slice(0, 20).join('\n') : ''}`);
    }
  }
}

console.log(`\n合計 PASS ${pass} / FAIL ${fail}`);
if (failures.length) console.log('失敗：\n' + failures.map((x) => '  - ' + x.split('\n')[0]).join('\n'));
process.exit(fail ? 1 : 0);
