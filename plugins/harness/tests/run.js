#!/usr/bin/env node
'use strict';
/**
 * harness plugin 回歸測試入口。零相依；每個測試在系統暫存目錄建、跑完刪。
 *
 * 用法：node plugins/harness/tests/run.js [--skip-probe] [--only <套件>[,<套件>…]]
 *   --skip-probe：跳過 hooks/templates 的 probe-hooks 全量（兩輪約 10 分鐘），只供開發中快速迭代；完成驗收一律不跳。
 * 結束碼：0＝全數通過；1＝有失敗。最後一行「合計 PASS n / FAIL n」。
 *
 * 套件：size、b5、b8、b9、split-audit、fixtures、golden、init-flow、schema、required-skill、delegation-gate、plugin-hooks、learn-offline、probe
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
const { makeGolden, BROKEN, VALID, seedSnapshot, dropSnapshot } = require('./lib/golden.js');

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
    // Phase 0 快照：init 動工之前拍（真的跑 check-flow-diagram.js snapshot），init-verify V21 拿它核對處置表的 origin
    makeFixture('single-web', base);
    const sn = node([path.join(INIT, 'scripts', 'check-flow-diagram.js'), 'snapshot', base]);
    if (sn.status !== 0) throw new Error('golden：拍 Phase 0 快照失敗：' + sn.stderr);
    makeGolden(base);
    const r = node([path.join(INIT, 'scripts', 'init-verify.js'), base]);
    check('golden', r.status === 0, `標準實例 init-verify exit ${r.status}：${(r.stdout.match(/合計.*$/m) || [''])[0]}${r.status ? '\n' + r.stdout.split('\n').filter((l) => /FAIL/.test(l)).join('\n') : ''}`);
    const v21 = (r.stdout.match(/^V21-rules-split \| .*$/m) || [''])[0];
    check('golden', /origin：沒有沿用檔，新建檔都不在 Phase 0 快照裡/.test(v21), `標準實例 V21 讀到 Phase 0 快照、兩份新建規則檔都不在快照裡：${v21.slice(v21.indexOf('origin：'), v21.indexOf('origin：') + 80)}`);
    // 實例的 guard-required-skill.js 是缺匯出的舊版：init-verify 不崩、V20～V22 退回 plugin 範本並在證據寫明
    {
      const d = tmp('h-oldguard-');
      try {
        fs.cpSync(base, d, { recursive: true });
        const sp = path.join(d, '.claude', 'settings.local.json');
        fs.writeFileSync(sp, read(sp).split(base.split(path.sep).join('/')).join(d.split(path.sep).join('/')));
        const gp = path.join(d, '.claude', 'hooks', 'guard-required-skill.js');
        const src = read(gp);
        const old = src.replace(/^module\.exports = \{[^}]*\};$/m, 'module.exports = { frontmatter, fmValue, parsePaths };');
        if (old === src) throw new Error('找不到 guard-required-skill.js 的 module.exports 那一行');
        fs.writeFileSync(gp, old);
        const rr = node([path.join(INIT, 'scripts', 'init-verify.js'), d]);
        const line = (id) => (rr.stdout.match(new RegExp('^' + id + ' \\| .*$', 'm')) || [''])[0];
        const fb = (id) => /^V2[02]-[\w-]+ \| PASS \|.*plugin 範本.*缺匯出 walkFiles.*退回範本/.test(line(id));
        check('golden', rr.status === 0 && fb('V20-rules-paths') && fb('V22-skill-paths') && /合計/.test(rr.stdout),
          `實例 guard-required-skill.js 缺匯出 → exit ${rr.status}；${line('V20-rules-paths').slice(0, 160)}；${line('V22-skill-paths').slice(0, 160)}${rr.stderr ? '；stderr：' + rr.stderr.slice(0, 300) : ''}`);
      } finally { rm(d); }
    }
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
        if (b.snap) seedSnapshot(base, d, b.snapAdd);
        if (b.afterSnap) b.afterSnap(d);
        const rr = node([path.join(INIT, 'scripts', 'init-verify.js'), d]);
        const fails = (rr.stdout.match(/^(V\d\d-[\w-]+) \| FAIL/mg) || []).map((x) => x.split(' ')[0]);
        check('golden', rr.status === 1 && fails.includes(b.expect), `壞變體「${b.name}」→ exit ${rr.status}，報出 ${fails.join('、') || '（無）'}（應含 ${b.expect}）`);
        n++;
      } finally { rm(d); dropSnapshot(d); }
    }
    check('golden', n >= 8, `壞變體 ${n} 個（至少 8 個）`);
    for (const v of VALID) {
      const d = tmp('h-valid-');
      try {
        fs.cpSync(base, d, { recursive: true });
        const sp = path.join(d, '.claude', 'settings.local.json');
        fs.writeFileSync(sp, read(sp).split(base.split(path.sep).join('/')).join(d.split(path.sep).join('/')));
        v.apply(d);
        if (v.snap) seedSnapshot(base, d, v.snapAdd);
        if (v.afterSnap) v.afterSnap(d);
        const rr = node([path.join(INIT, 'scripts', 'init-verify.js'), d]);
        const line = (rr.stdout.match(new RegExp('^' + v.expect + ' \\| .*$', 'm')) || [''])[0];
        const fails = rr.stdout.split('\n').filter((l) => / \| FAIL \| /.test(l));
        const ev = !v.evidence || v.evidence.test(line);
        const shown = v.evidence && line.includes('origin：') ? line.slice(line.indexOf('origin：')) : line;
        check('golden', rr.status === 0 && / \| PASS \| /.test(line) && ev, `合法變體「${v.name}」→ exit ${rr.status}；${ev ? '' : `證據沒有 ${v.evidence}：`}${shown.slice(0, 220)}${fails.length ? '\n' + fails.join('\n') : ''}`);
      } finally { rm(d); dropSnapshot(d); }
    }
    // 沿用一份既有規則檔：寫檔（paths 命中 single-web 的檔）、列進 harness README、處置表記 origin: kept
    const ruleBody = (t) => `---\npaths:\n  - "src/**/*.{jsx,tsx}"\n---\n\n# ${t}\n\n呼叫後端一律經過共用的 fetch 包裝，不在元件裡直接寫網址。\n`;
    const addKept = (r, rel, ans) => {
      fs.appendFileSync(path.join(r, '.claude', 'harness', 'README.md'), `\n- \`${rel}\`（paths：src/**/*.{jsx,tsx}）\n`);
      const ap = path.join(r, '.claude', 'harness', 'init-answers.json');
      const j = JSON.parse(read(ap));
      j.rulesSplit.push({ file: rel, load: 'paths', origin: 'kept', topic: '既有 API 規範' });
      if (ans) ans(j);
      fs.writeFileSync(ap, JSON.stringify(j, null, 2) + '\n');
    };
    const v21Of = (out) => (out.match(/^V21-rules-split \| .*$/m) || [''])[0];
    const originOf = (l) => (l.includes('origin：') ? l.slice(l.indexOf('origin：')) : l).slice(0, 200);
    // 落點≠目標（Q4 把落點改到 target 底下的子目錄）：快照對 target 拍，讀的時候切掉落點前綴、路徑換成相對落點。
    // 快照記的是實際檔名（這裡用 LAND/ 模擬），落點字面是 land：Windows 不分大小寫，要對得上；其他平台照字面，不跑大小寫那兩項
    // 落點目錄名以 .. 開頭（..land）時，相對路徑 ..land 仍在目標內，不可當成目標外而略過目標的快照
    for (const [label, keyDir, unread, dirName = 'land'] of [['同大小寫', 'land', false], ['大小寫不同', 'LAND', false], ['大小寫不同、沿用檔在快照裡讀不到內容', 'LAND', true], ['落點目錄名以 .. 開頭', '..land', false, '..land']]) {
      if (keyDir !== 'land' && process.platform !== 'win32') continue;
      const P0 = tmp('h-landing-');
      const d = path.join(P0, dirName);
      try {
        fs.cpSync(base, d, { recursive: true });
        const sp = path.join(d, '.claude', 'settings.local.json');
        fs.writeFileSync(sp, read(sp).split(base.split(path.sep).join('/')).join(d.split(path.sep).join('/')));
        const rel = '.claude/rules/web/legacy.md';
        fs.mkdirSync(path.join(d, '.claude', 'rules', 'web'), { recursive: true });
        fs.writeFileSync(path.join(d, ...rel.split('/')), ruleBody('既有 API 規範'));
        addKept(d, rel, (j) => { j.target = P0; j.landing = d; });
        const bs = L.readSnapshot(base);
        const files = {};
        for (const [k, v] of Object.entries(bs.files)) files[`${keyDir}/${k}`] = v;
        const unreadable = [];
        if (unread) unreadable.push(`${keyDir}/${rel}`); else files[`${keyDir}/${rel}`] = L.fileSha1(path.join(d, ...rel.split('/')));
        const snp = L.snapshotPath(P0);
        fs.mkdirSync(path.dirname(snp), { recursive: true });
        fs.writeFileSync(snp, JSON.stringify({ root: P0, takenAt: bs.takenAt, files, unreadable }));
        const rr = node([path.join(INIT, 'scripts', 'init-verify.js'), d]);
        const l = v21Of(rr.stdout);
        const ev = unread ? /legacy\.md 在快照裡讀不到內容，只核對了存在/ : /沿用 1 份對過 Phase 0 快照/;
        check('golden', rr.status === 0 && / \| PASS \| /.test(l) && ev.test(l),
          `落點在目標的子目錄（快照前綴${label}）：沿用檔記 kept → exit ${rr.status}；${originOf(l)}`);
      } finally { rm(P0); dropSnapshot(P0); }
    }
    // 符號連結進來的既有規則檔記 kept：快照另記 .claude/rules/ 底下經連結才走得到的規則檔（ruleLinks，內容是連結讀到的），
    // 連結指向專案內（shared/）、專案外（另一個暫存目錄）都核對得到；Phase 0 之後連結讀到的內容變了 → V21 擋
    {
      const F = tmp('h-ruleslink-');
      const OUT = tmp('h-ruleslink-out-');
      const links = [path.join(F, '.claude', 'rules', 'linked-in'), path.join(F, '.claude', 'rules', 'linked-out')];
      try {
        makeFixture('single-web', F);
        fs.mkdirSync(path.join(F, 'shared'));
        fs.writeFileSync(path.join(F, 'shared', 'c.md'), ruleBody('專案內共用規則'));
        fs.writeFileSync(path.join(OUT, 'd.md'), ruleBody('專案外共用規則'));
        fs.mkdirSync(path.join(F, '.claude', 'rules'), { recursive: true });
        let linked = true;
        try { fs.symlinkSync(path.join(F, 'shared'), links[0], 'junction'); fs.symlinkSync(OUT, links[1], 'junction'); } catch { linked = false; }
        if (!linked) check('golden', false, '符號連結規則檔：這台建不了目錄連結（junction／symlink），測不到');
        else {
          const sn2 = node([path.join(INIT, 'scripts', 'check-flow-diagram.js'), 'snapshot', F]);
          if (sn2.status !== 0) throw new Error('符號連結規則檔：拍 Phase 0 快照失敗：' + sn2.stderr);
          makeGolden(F);
          addKept(F, '.claude/rules/linked-in/c.md');
          addKept(F, '.claude/rules/linked-out/d.md');
          const r1 = node([path.join(INIT, 'scripts', 'init-verify.js'), F]);
          const l1 = v21Of(r1.stdout);
          check('golden', r1.status === 0 && / \| PASS \| /.test(l1) && /沿用 2 份對過 Phase 0 快照.*其中 2 份是符號連結/.test(l1),
            `符號連結進來的既有規則檔記 kept（連到專案內 shared/、連到專案外暫存目錄各一份）→ exit ${r1.status}；${originOf(l1)}${r1.status ? '\n' + r1.stdout.split('\n').filter((x) => / \| FAIL \| /.test(x)).join('\n') : ''}`);
          fs.appendFileSync(path.join(OUT, 'd.md'), '\n逾時一律 10 秒。\n');
          const r2 = node([path.join(INIT, 'scripts', 'init-verify.js'), F]);
          const l2 = v21Of(r2.stdout);
          check('golden', r2.status === 1 && / \| FAIL \| /.test(l2) && /linked-out\/d\.md 記成沿用（origin: kept），但內容跟 Phase 0 快照不同/.test(l2),
            `連到專案外的規則檔在 Phase 0 之後被改過、仍記 kept → exit ${r2.status}；${l2.slice(0, 200)}`);
        }
      } finally {
        for (const x of links) { try { fs.unlinkSync(x); } catch {} }
        rm(F); rm(OUT); dropSnapshot(F);
      }
    }
    // .claude 本身是連結（junction）：快照不走進連結，但 ruleLinks 要收到 .claude/rules/ 底下的規則檔，沒動過的記 kept 才核對得過
    {
      const J = tmp('h-claudelink-');
      const lk = path.join(J, '.claude');
      try {
        fs.mkdirSync(path.join(J, 'real-claude', 'rules'), { recursive: true });
        fs.writeFileSync(path.join(J, 'real-claude', 'rules', 'a.md'), ruleBody('經連結的 .claude 規則'));
        let linked = true;
        try { fs.symlinkSync(path.join(J, 'real-claude'), lk, 'junction'); } catch { linked = false; }
        if (!linked) check('golden', false, '.claude 本身是連結：這台建不了目錄連結（junction／symlink），測不到');
        else {
          const sn3 = node([path.join(INIT, 'scripts', 'check-flow-diagram.js'), 'snapshot', J]);
          if (sn3.status !== 0) throw new Error('.claude 連結：拍 Phase 0 快照失敗：' + sn3.stderr);
          const snap = L.readSnapshot(J);
          const inLinks = !!(snap && snap.ruleLinks && '.claude/rules/a.md' in snap.ruleLinks);
          const res = L.checkRuleOrigins(J, null, [{ file: '.claude/rules/a.md', load: 'paths', origin: 'kept', topic: 'x' }]);
          check('golden', inLinks && res.hits.length === 0,
            `.claude 本身是 junction：沒動過的規則檔記 kept → ruleLinks 收到=${inLinks}、核對 hits=${JSON.stringify(res.hits)}`);
        }
      } finally { try { fs.unlinkSync(lk); } catch {} rm(J); dropSnapshot(J); }
    }
  } finally { rm(base); dropSnapshot(base); }
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
    // 沿用的既有規則檔（子目錄）在 Phase 0 快照之前就在：rules 寫入時會拿快照核對 origin: kept
    fs.mkdirSync(path.join(d, '.claude', 'rules', 'db'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude', 'rules', 'db', 'migrations.md'), '---\npaths:\n  - "db/**/*.sql"\n---\n\n遷移檔只增不改。\n');
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
    const rulesOk = [{ file: '.claude/rules/frontend.md', load: 'paths', moved: [{ from: 'CLAUDE.md「前端」', text: '元件一律用 function component' }] }];
    fs.writeFileSync(ansFile, JSON.stringify(rulesOk));
    check('init-flow', flow('rules', d, '--file', ansFile).status === 1, '規則檔還沒建就寫處置表（記的檔不在落點）→ 不寫入 exit 1');
    fs.writeFileSync(path.join(d, '.claude', 'rules', 'frontend.md'), '---\npaths:\n  - "src/**/*.tsx"\n---\n\n元件一律用 function component\n');
    const rk = flow('rules', d, '--file', ansFile);
    check('init-flow', rk.status === 1 && /db\/migrations\.md/.test(rk.stdout), `落點有處置表沒記的規則檔（子目錄裡沿用的既有檔）→ 不寫入 exit 1 且點名：${rk.stdout.split('\n').filter((l) => /migrations/.test(l)).join(' ').slice(0, 160)}`);
    // 寫入時就核對 origin（與 V21 同一支 L.checkRuleOrigins）：重裝時拿上一版 rulesSplit 當預設、沒寫 origin 的沒動過的檔，這裡就擋
    fs.writeFileSync(ansFile, JSON.stringify([...rulesOk, { file: '.claude/rules/db/migrations.md', load: 'paths' }]));
    const ro1 = flow('rules', d, '--file', ansFile);
    check('init-flow', ro1.status === 1 && /db\/migrations\.md 記成新建（origin 沒寫或寫 new），但 Phase 0 之前就在、內容也沒變/.test(ro1.stdout),
      `沒動過的既有規則檔沒寫 origin（重裝沿用上一版處置表）→ 不寫入 exit ${ro1.status}：${ro1.stdout.split('\n').filter((l) => /migrations/.test(l)).join(' ').slice(0, 160)}`);
    fs.writeFileSync(ansFile, JSON.stringify([Object.assign({}, rulesOk[0], { origin: 'kept' }), { file: '.claude/rules/db/migrations.md', load: 'paths', origin: 'kept' }]));
    const ro2 = flow('rules', d, '--file', ansFile);
    check('init-flow', ro2.status === 1 && /frontend\.md 記成沿用（origin: kept），但 Phase 0 快照裡沒有這份/.test(ro2.stdout),
      `這次才建的規則檔記 kept → 不寫入 exit ${ro2.status}：${ro2.stdout.split('\n').filter((l) => /frontend/.test(l)).join(' ').slice(0, 160)}`);
    rulesOk.push({ file: '.claude/rules/db/migrations.md', load: 'paths', origin: 'kept' });
    fs.writeFileSync(ansFile, JSON.stringify(rulesOk));
    check('init-flow', flow('rules', d, '--file', ansFile).status === 0, 'Phase 4 寫規則分層處置（新建一份＋沿用一份 origin: kept）→ exit 0');
    // 反斜線路徑：init-flow 換成 / 再比對、存檔（與 init-verify V21 同一種寫法，L.normRulePath）
    fs.writeFileSync(ansFile, JSON.stringify(rulesOk.map((x) => Object.assign({}, x, { file: x.file.split('/').join('\\') }))));
    const rb = flow('rules', d, '--file', ansFile);
    const savedFiles = rb.status === 0 ? JSON.parse(read(path.join(d, '.claude', 'harness', 'init-answers.json'))).rulesSplit.map((x) => x.file) : [];
    check('init-flow', rb.status === 0 && savedFiles.join(',') === '.claude/rules/frontend.md,.claude/rules/db/migrations.md', `處置表用反斜線寫路徑 → 換成 / 寫入：exit ${rb.status}，存成 ${savedFiles.join('、')}${rb.status ? '\n' + rb.stdout : ''}`);
    // 列規則檔：init-flow 與 init-verify 共用 L.listRuleFiles——/ 分隔、排序、跟目錄連結、連結繞回上層不無限遞迴
    {
      const lr = tmp('h-listrules-');
      try {
        fs.mkdirSync(path.join(lr, '.claude', 'rules', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(lr, '.claude', 'rules', 'sub', 'b.md'), 'x\n');
        fs.writeFileSync(path.join(lr, '.claude', 'rules', 'a.md'), 'x\n');
        fs.writeFileSync(path.join(lr, '.claude', 'rules', 'notes.txt'), 'x\n');
        fs.mkdirSync(path.join(lr, 'shared'));
        fs.writeFileSync(path.join(lr, 'shared', 'c.md'), 'x\n');
        let linked = true;
        try {
          fs.symlinkSync(path.join(lr, 'shared'), path.join(lr, '.claude', 'rules', 'linked'), 'junction');
          fs.symlinkSync(path.join(lr, '.claude', 'rules'), path.join(lr, '.claude', 'rules', 'sub', 'loop'), 'junction');
        } catch { linked = false; }
        const got = L.listRuleFiles(lr).join(',');
        const want = linked ? '.claude/rules/a.md,.claude/rules/linked/c.md,.claude/rules/sub/b.md' : '.claude/rules/a.md,.claude/rules/sub/b.md';
        check('init-flow', got === want, `L.listRuleFiles：${got}${linked ? '（含目錄連結 linked/、sub/loop 繞回上層只走一次）' : '（這台建不了目錄連結，只驗一般檔）'}`);
      } finally { rm(lr); }
    }
    fs.writeFileSync(ansFile, JSON.stringify([...rulesOk, rulesOk[0]]));
    check('init-flow', flow('rules', d, '--file', ansFile).status === 1, '規則分層處置同一份檔寫兩次 → 不寫入 exit 1');
    fs.writeFileSync(ansFile, JSON.stringify([{ file: 'docs/frontend.md', load: 'paths' }]));
    check('init-flow', flow('rules', d, '--file', ansFile).status === 1, '規則檔不在 .claude/rules/ → 不寫入 exit 1');
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
      ['rulesSplit 的 load 不在列舉', (j) => { j.rulesSplit[0].load = 'lazy'; }],
      ['rulesSplit 搬來的段落少了原文', (j) => { delete j.rulesSplit[0].moved[0].text; }],
      ['rulesSplit 的 origin 不在列舉', (j) => { j.rulesSplit[0].origin = 'reused'; }],
    ];
    for (const [name, fn] of bad) { const j = JSON.parse(JSON.stringify(good)); fn(j); const e = L.validate(schema, j); check('schema', e.length > 0, `${name} → 被抓到（${e[0] || '沒抓到'}）`); }
  } finally { rm(g); }
}

// ── required-skill：guard-required-skill.js 匯出的 paths 比對與載入判定（init-verify 也用同一份）──
// glob 的期望值是 Claude Code 2.1.296 實測的結果：在沙箱放一批帶這些 paths 的 .claude/rules/*.md，讓 claude -p 讀 src/a.ts 與
// src/deep/d.ts，看 transcript 裡哪幾份出現 attachment.type "nested_memory"（skill 的 paths 用同一套判法，讀到時出現 skill_listing）。
if (want('required-skill')) {
  const G = require(path.join(TPL, 'guard-required-skill.js'));
  const MEASURED = [
    ['*.ts', 'src/deep/d.ts', true], ['**/*.ts', 'src/deep/d.ts', true], ['src/**/*.ts', 'src/deep/d.ts', true], ['src/*.ts', 'src/deep/d.ts', false],
    ['src/?.ts', 'src/deep/d.ts', false], ['src/{x,a}.ts', 'src/deep/d.ts', false], ['deep/*.ts', 'src/deep/d.ts', false], ['deep/', 'src/deep/d.ts', true],
    ['**/deep/*.ts', 'src/deep/d.ts', true], ['src/*', 'src/deep/d.ts', true], ['src/**', 'src/deep/d.ts', true], ['!src/deep/d.ts', 'src/deep/d.ts', false],
    ['src/deep/[a-d].ts', 'src/deep/d.ts', true], ['SRC/deep/d.ts', 'src/deep/d.ts', true],
    ['src/{x,a}.ts', 'src/a.ts', true], ['src/a.{js,ts}', 'src/a.ts', true], ['/src/a.ts', 'src/a.ts', true], ['./src/a.ts', 'src/a.ts', false],
    ['src/', 'src/a.ts', true], ['src/?.ts', 'src/a.ts', true], ['src/*.ts', 'src/a.ts', true], ['*.ts', 'src/a.ts', true],
    // 中段 ** 匹配零層目錄：skill 實測（Claude Code 2.1.296，沙箱 skillprobe2/live，session 9209a5a6）——
    // .claude/skills/ts-style/SKILL.md 的 paths 是 "src/**/*.ts"（transcript 第 38 行 Read 的 tool_result 原文），
    // 第 39 行 Read src/a.ts 之後第 41 行出現 attachment skill_listing names:["ts-style"]（開場第 11 行的清單沒有它）
    ['src/**/*.ts', 'src/a.ts', true],
  ];
  for (const [g, f, want_] of MEASURED) check('required-skill', G.matchPath(g, f) === want_, `paths「${g}」對 ${f} → ${want_ ? '命中' : '不命中'}（Claude Code 2.1.296 實測）`);
  // 程式行為（沒有 Claude Code 實測，只鎖住 matchPath 現在的編法：中段 ** 編成 (?:/[^/]+)*，零次重複時前後兩段直接接上）
  const PROGRAM = [['a/**/b', 'a/b', true], ['a/**/b', 'a/x/y/b', true], ['a/**/b', 'ab', false]];
  for (const [g, f, want_] of PROGRAM) check('required-skill', G.matchPath(g, f) === want_, `paths「${g}」對 ${f} → ${want_ ? '命中' : '不命中'}（程式行為，未經 Claude Code 實測）`);
  const pp = (t) => JSON.stringify(G.parsePaths(t));
  check('required-skill', pp('---\npaths: "nomatch/**, src/a.ts"\n---\n') === '["nomatch/**","src/a.ts"]', 'paths 逗號字串切成兩條（實測兩條都生效）');
  check('required-skill', pp('---\npaths:\n  - "src/**/*.{ts,tsx}"\n  - docs/**\n---\n') === '["src/**/*.{ts,tsx}","docs/**"]', 'paths YAML 清單；大括號裡的逗號不切');
  check('required-skill', pp('---\npaths: [a/**, "b/{x,y}"]\n---\n') === '["a/**","b/{x,y}"]', 'paths 行內清單');
  check('required-skill', pp('---\nname: x\n---\n') === '[]', '沒有 paths → 空陣列');
  for (const [g, bad] of [['./src/**', true], ['!src/**', true], ['src\\**', true], ['src/{a,b', true], ['src/{a, b}', true], ['C:/x/**', true], ['src/**/*.{ts,tsx}', false]]) {
    check('required-skill', !!G.validatePattern(g) === bad, `validatePattern「${g}」→ ${bad ? '報問題' : '合法'}${G.validatePattern(g) ? '：' + G.validatePattern(g) : ''}`);
  }
}

// ── delegation-gate：04 派工模板與派工閘（check-review-discipline.js）的契約 ──
// 模板文字改了（例：說明裡多一個單獨的「（」）會讓閘的判讀壞掉，而閘自己的 cases 是手寫 prompt、抓不到。
// 所以從 skeleton-04 實際抽出模板一～四、六，填空換成合理值後直接餵給閘。
if (want('delegation-gate')) {
  const HOOK = path.join(TPL, 'check-review-discipline.js');
  const t = read(path.join(INIT, 'references', 'skeleton-04-delegation-templates.md')).replace(/\r\n/g, '\n');
  const ws = tmp('h-dg-');
  try {
    const W = ws.split(path.sep).join('/');
    const design = `${W}/docs/design.md`;
    fs.mkdirSync(path.join(ws, 'docs'));
    fs.writeFileSync(design, '# 出貨單匯出\n\n狀態：已簽收（使用者，2026-01-01）\n\n## 測試情境表\n\n| 情境 | 預期 |\n|---|---|\n| 匯出一張出貨單 | 檔案含全部明細 |\n');
    // 模板區塊：「## 模板<n>」之後第一個 ``` 區塊
    const block = (n) => {
      const i = t.indexOf('## 模板' + n);
      if (i < 0) return null;
      const a = t.indexOf('```\n', i);
      const b = a < 0 ? -1 : t.indexOf('\n```', a + 4);
      return b < 0 ? null : t.slice(a + 4, b);
    };
    // 填空：{{…}} 由內往外換；<workspace> 換成暫存目錄；其餘 <…>（可巢狀，不跨行）換成示範內容
    const fill = (s) => {
      for (let g = 0; g < 999 && /\{\{/.test(s); g++) s = s.replace(/\{\{((?:(?!\{\{|\}\})[\s\S])*)\}\}/, '示範內容');
      s = s.split('<workspace>').join(W);
      for (let g = 0; g < 99; g++) { const n = s.replace(/<[^<>\n]*>/g, '示範內容'); if (n === s) break; s = n; }
      return s;
    };
    const setLine = (s, head, line) => s.replace(new RegExp('^' + head + '.*$', 'm'), () => line);
    const ALIGN = '【開工前對齊】無分岔＋需求只有一種解讀（單一欄位的顯示調整）';
    const run = (agent, prompt) => {
      const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: ws }),
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: ws, tool_input: { subagent_type: agent, prompt } }) });
      const o = String(r.stdout || '').trim();
      if (!o) return { allow: true, why: `exit ${r.status}` };
      let j; try { j = JSON.parse(o).hookSpecificOutput || {}; } catch { return { allow: false, why: '輸出不是 JSON：' + o.slice(0, 200) }; }
      return j.permissionDecision === 'deny' ? { allow: false, why: String(j.permissionDecisionReason) } : { allow: true, why: 'additionalContext：' + String(j.additionalContext || '').slice(0, 200) };
    };
    const short = (s) => s.replace(/\s+/g, ' ').slice(0, 300);
    const tpl = {};
    for (const [n, agent] of [['一', 'general-purpose'], ['二', 'backend-engineer'], ['三', 'backend-engineer'], ['四', 'code-reviewer'], ['六', 'qa-engineer']]) {
      const raw = block(n);
      check('delegation-gate', !!raw && raw.includes('【驗收條件】'), `skeleton-04 抽得到模板${n}的 prompt 區塊（含【驗收條件】）`);
      if (!raw) continue;
      let p = fill(raw);
      if (n === '二') p = setLine(p, '【計畫／設計文件】', `【計畫／設計文件】"${design}"`);
      if (n === '二' || n === '三' || n === '六') p = setLine(p, '【開工前對齊】', ALIGN);
      if (n === '四') p = p.replace(/^1\. .*$/m, '1. npm test exit 0').replace(/^2\. .*$/m, '2. grep -c "oldApi(" src = 0');
      const left = (p.match(/\{\{|<[^<>\n]*>/) || [])[0];
      check('delegation-gate', !left, `模板${n}填空全數換掉${left ? '（還剩：' + left + '）' : ''}`);
      tpl[n] = { agent, p };
    }
    for (const n of ['一', '二', '三', '四']) {
      if (!tpl[n]) continue;
      const r = run(tpl[n].agent, tpl[n].p);
      check('delegation-gate', r.allow, `模板${n}填好 → 放行${r.allow ? '' : '：' + short(r.why)}`);
    }
    if (tpl['六']) {
      const { agent, p } = tpl['六'];
      const answer = (line) => p.replace(/^(【測試資料來源】[^\n]*\n)/m, (m) => m + line + '\n');
      const cases = [
        ['照貼不作答', p, false, '測試資料來源·未明選'],
        ['選 a', answer('選 a：從出貨單畫面實際建單產生資料。'), true],
        ['選 c＋理由', answer('選 c：幣別屬設定類主檔，期望值查資料庫推導。'), true],
        ['選 b 只寫成本', answer('選 b：走畫面太慢，成本過高。'), false, '測試資料來源·非例外'],
        ['選 b＋例外類別＋檔名:行號', answer('選 b：上游系統推送的出貨回報，產品沒有建立入口，見 src/api/inbound.js:42。'), true],
      ];
      for (const [name, prompt, allow, tag] of cases) {
        const r = run(agent, prompt);
        const ok = allow ? r.allow : (!r.allow && r.why.includes(tag));
        check('delegation-gate', ok, `模板六${name} → ${allow ? '放行' : '擋（' + tag + '）'}${ok ? '' : '；實際：' + (r.allow ? '放行 ' : '') + short(r.why)}`);
      }
    }
  } finally { rm(ws); }
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
