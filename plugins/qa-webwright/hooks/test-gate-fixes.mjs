#!/usr/bin/env node
/**
 * test-gate-fixes.mjs — 0.9.0 送審意見的 hook 回歸案例（每案例帶審查 ID；開發期，不進 plugin 執行路徑）。
 *
 * 由 test-gate.mjs 匯入執行；也可單獨跑並依 ID 篩選：
 *   node hooks/test-gate-fixes.mjs            全部
 *   node hooks/test-gate-fixes.mjs H7 C15     只跑 ID 以這些字串開頭的案例
 * 全部在 os.tmpdir() 底下建假專案，跑完整批刪除；子程序環境拿掉 CLAUDE_PROJECT_DIR。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(HERE, '..', 'skills', 'browser-qa', 'lib', 'install_tools.py');

function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  delete env.CLAUDE_PROJECT_DIR;
  for (const k of ['APP_TENANT', 'I18N_DIR', 'FRONT_ROOT', 'QA_WEBWRIGHT_NAV_STATE', 'QA_PYTHON']) delete env[k];
  return Object.assign(env, extra || {});
}

function runPre(file, payload, env) {
  const r = spawnSync(process.execPath, [path.join(HERE, file)], {
    input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv(env), timeout: 60000,
  });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  if (r.status === 0 && out === '' && err === '') return { tag: 'ALLOW', msg: '' };
  if (r.status === 0 && out !== '') {
    try {
      const h = JSON.parse(out).hookSpecificOutput || {};
      if (h.permissionDecision === 'deny') return { tag: 'DENY', msg: String(h.permissionDecisionReason || '') };
      return { tag: 'OTHER', msg: out };
    } catch (_) {
      return { tag: 'BADJSON', msg: out };
    }
  }
  return { tag: 'EXIT' + r.status, msg: err || out };
}

let sid = 0;
function runStop(cwd, transcript, env) {
  const s = 'fix' + (sid++) + 'x' + process.pid;
  const r = spawnSync(process.execPath, [path.join(HERE, 'qa-landing-gate.js')], {
    input: JSON.stringify({ session_id: s, cwd, transcript_path: transcript }), encoding: 'utf8', env: cleanEnv(env),
  });
  try {
    fs.unlinkSync(path.join(os.tmpdir(), 'qa-landing-gate-' + s + '.count'));
  } catch (_) {}
  const out = (r.stdout || '').trim();
  if (out === '') return { tag: 'ALLOW', msg: '' };
  try {
    const j = JSON.parse(out);
    if (j.decision === 'block') return { tag: 'BLOCK', msg: j.reason };
    if (j.hookSpecificOutput) return { tag: 'WARN', msg: j.hookSpecificOutput.additionalContext };
  } catch (_) {}
  return { tag: 'BAD', msg: out };
}

function runPost(payload, env) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'guard-test-asset-hygiene.js')], {
    input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv(env), timeout: 200000,
  });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  if (r.status === 0 && out === '' && err === '') return { tag: 'SILENT', msg: '' };
  if (r.status === 2) return { tag: 'BLOCK2', msg: err, raw: r.stderr };
  if (r.status === 0 && out !== '') {
    try {
      return { tag: 'NOTE', msg: String((JSON.parse(out).hookSpecificOutput || {}).additionalContext || '') };
    } catch (_) {
      return { tag: 'BADJSON', msg: out };
    }
  }
  return { tag: 'OTHER(' + r.status + ')', msg: err || out };
}

function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 1));
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失敗：' + r.stderr);
}

function pickPy() {
  const cands = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of cands) {
    const r = spawnSync(c, ['-c', 'import sys'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

// MSYS／Git Bash 形式的路徑（C:\a\b → /c/a/b）；非 Windows 原樣回傳
function msys(p) {
  if (process.platform !== 'win32') return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (_m, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/');
}

export function runFixCases(TMP, filters) {
  const root = fs.mkdtempSync(path.join(TMP, 'fixes-'));
  let n = 0;
  const mkProj = (cfg) => {
    const dir = path.join(root, 'p' + (n++));
    fs.mkdirSync(path.join(dir, 'tests', 'e2e'), { recursive: true });
    if (cfg !== undefined) writeJson(path.join(dir, 'tests', 'e2e', 'qa-webwright.json'), cfg);
    return dir;
  };
  const cases = []; // [id, 名稱, 執行函式 () => {tag,msg}, 期望, 斷言?]
  const add = (id, name, fn, expected, check) => cases.push([id, name, fn, expected, check]);
  const sh = (cwd, command, tool) => ({ cwd, tool_name: tool || 'Bash', tool_input: { command } });

  // =====================================================================
  // guard-report-output.js：H7 B36 C15 C18 C17
  // =====================================================================
  const RO = 'guard-report-output.js';
  const ro = mkProj({ report_hygiene: { roots: ['tests/reports'] } });
  fs.mkdirSync(path.join(ro, 'tests', 'reports', 'topic_20260924'), { recursive: true });
  const w = (cwd, rel) => ({ cwd, tool_name: 'Write', tool_input: { file_path: path.join(cwd, ...rel.split('/')) } });
  add('H7', 'report ls 交付根 2>/dev/null（讀取）→放行', () => runPre(RO, sh(ro, 'ls tests/reports/topic_20260924 2>/dev/null')), 'ALLOW');
  add('H7', 'report cat 交付檔 2>&1 | head（讀取）→放行', () => runPre(RO, sh(ro, 'cat tests/reports/topic_20260924/junit.xml 2>&1 | head')), 'ALLOW');
  add('H7', 'report rm 過程檔 2>/dev/null（清理）→放行', () => runPre(RO, sh(ro, 'rm tests/reports/topic_20260924/debug.png 2>/dev/null')), 'ALLOW');
  add('H7', 'report ls 交付根 > /dev/null→放行', () => runPre(RO, sh(ro, 'ls tests/reports/topic_20260924/a.png > /dev/null')), 'ALLOW');
  add('H7', 'report 重導到交付根層檔案仍擋（對照）', () => runPre(RO, sh(ro, 'ls -la > tests/reports/list.txt 2>/dev/null')), 'DENY', (m) => /根層禁止直接放檔/.test(m));
  add('B36', 'report mv 違規檔搬到 /tmp/→放行', () => runPre(RO, sh(ro, 'mv tests/reports/topic_20260924/junit.xml /tmp/')), 'ALLOW');
  add('B36', 'report cp 交付檔到專案外→放行', () => runPre(RO, sh(ro, 'cp tests/reports/topic_20260924/debug.png ../backup/debug.png')), 'ALLOW');
  add('C15', 'report Write _work/../debug.png（實際落在交付資料夾第一層）→擋', () => runPre(RO, w(ro, 'tests/reports/topic_20260924/_work/../debug.png')), 'DENY', (m) => /_work/.test(m));
  add('C15', 'report bash 重導 _work/../x.log→擋', () => runPre(RO, sh(ro, 'echo x > tests/reports/topic_20260924/_work/../x.log')), 'DENY');
  add('C15', 'report _work/sub/../y.png 仍在 _work→放行', () => runPre(RO, w(ro, 'tests/reports/topic_20260924/_work/sub/../y.png')), 'ALLOW');
  add('C18', 'report cp 過程檔到交付資料夾（目的為目錄）→擋', () => runPre(RO, sh(ro, 'cp /tmp/debug.png tests/reports/topic_20260924/')), 'DENY', (m) => /debug\.png/.test(m));
  add('C18', 'report cp 過程檔到既有交付資料夾（無尾斜線）→擋', () => runPre(RO, sh(ro, 'cp /tmp/debug.png tests/reports/topic_20260924')), 'DENY', (m) => /debug\.png/.test(m));
  add('C18', 'report cp 交付檔到交付資料夾（目錄）→放行', () => runPre(RO, sh(ro, 'cp /tmp/報告.docx tests/reports/topic_20260924/')), 'ALLOW');
  add('C18', 'report cp 過程檔到 _work 目錄→放行', () => runPre(RO, sh(ro, 'cp /tmp/debug.png tests/reports/topic_20260924/_work/')), 'ALLOW');
  add('C17', 'report 複合指令：先寫根層、後 cp 目錄→兩處都檢查', () => runPre(RO, sh(ro, 'echo y > tests/reports/log.txt && cp /tmp/a.docx tests/reports/topic_20260924/')), 'DENY', (m) => /log\.txt/.test(m));
  add('H7', 'report PowerShell 反斜線路徑 Out-File 到根層→擋（反斜線不是跳脫）', () => runPre(RO, sh(ro, '"x" | Out-File -FilePath tests\\reports\\log.txt', 'PowerShell')), 'DENY', (m) => /log\.txt/.test(m)); // portable-ok: 合成 payload 的工具名稱與 PowerShell 語法字串，非呼叫系統指令
  add('H7', 'report PowerShell Copy-Item 過程檔到交付資料夾→擋', () => runPre(RO, sh(ro, 'Copy-Item C:\\tmp\\debug.png tests\\reports\\topic_20260924\\', 'PowerShell')), 'DENY', (m) => /debug\.png/.test(m)); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('H7', 'report PowerShell Get-ChildItem 讀取→放行', () => runPre(RO, sh(ro, 'Get-ChildItem tests\\reports 2>$null', 'PowerShell')), 'ALLOW'); // portable-ok: 合成 payload 字串，非呼叫系統指令

  // =====================================================================
  // qa-landing-gate.js：H6 A4
  // =====================================================================
  const tr = (name, lines) => {
    const f = path.join(root, name + '.jsonl');
    fs.writeFileSync(f, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
    return f;
  };
  const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: input || {} }] } });
  const T = tr('landing', [tool('Bash', { command: 'bash "/x/qa-flow.sh" run orders tests/e2e/orders/test_orders.py' }), tool('mcp__playwright__browser_click')]);
  const mkLanding = (rows, cfg) => {
    const d = mkProj(cfg);
    const e2e = path.join(d, 'tests', 'e2e');
    fs.mkdirSync(path.join(e2e, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(e2e, 'orders'), { recursive: true });
    fs.writeFileSync(path.join(e2e, 'reports', 'x.xml'), '<testsuite/>\n');
    fs.writeFileSync(path.join(e2e, 'orders', 'test_orders.py'), 'def test_x():\n    assert True\n');
    fs.writeFileSync(path.join(e2e, 'orders', 'COVERAGE.md'),
      '# orders/ 情境覆蓋\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n' + rows + '\n## 🔒 鎖定 bug\n\n| 情境 | 位置 | 狀態 |\n|---|---|---|\n');
    return d;
  };
  add('H6', 'landing COVERAGE 只有「待補」佔位列→擋', () => runStop(mkLanding('| 待補 | `test_orders.py::test_x` | ⚠️ |\n'), T), 'BLOCK');
  add('H6', 'landing 自訂佔位字（coverage.placeholder）也不算登記→擋',
    () => runStop(mkLanding('| TBD | `test_orders.py::test_x` | ⚠️ |\n', { coverage: { placeholder: 'TBD' } }), T), 'BLOCK');
  add('H6', 'landing 佔位列＋真實情境列→放行（對照）',
    () => runStop(mkLanding('| 待補 | `test_orders.py::test_y` | ⚠️ |\n| 建立訂單後列表看得到 | `test_orders.py::test_x` | ✅ |\n'), T), 'ALLOW');
  {
    // A4：第一層子目錄 stat 失敗（懸空連結）→ 不確定 → 放行，不得當「沒有測試」去擋
    const d = mkProj();
    const e2e = path.join(d, 'tests', 'e2e');
    fs.mkdirSync(path.join(e2e, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(e2e, 'reports', 'x.xml'), '<testsuite/>\n');
    let linked = true;
    try {
      fs.symlinkSync(path.join(root, 'no-such-target-dir'), path.join(e2e, 'orders'), 'junction');
    } catch (_) {
      linked = false;
    }
    add('A4', 'landing 子目錄 stat 失敗（懸空連結）→不確定放行',
      () => (linked ? runStop(d, T) : { tag: 'ALLOW', msg: '（此平台無法建立連結，略過）' }), 'ALLOW');
  }

  // =====================================================================
  // guard-pretest-env.js：H8 B34 C06 C07 C02
  // =====================================================================
  const PT = 'guard-pretest-env.js';
  const pA = mkProj({ pretest: { alignment: [
    { env: 'APP_TENANT', equals_file: 'backend/app.cfg', regex: 'tenant\\s*=\\s*(\\w[\\w-]*)' },
    { env: 'I18N_DIR', must_be_under: 'FRONT_ROOT' },
  ] } });
  fs.mkdirSync(path.join(pA, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(pA, 'front', 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(pA, 'backend', 'app.cfg'), 'tenant = acme-prod-tenant-key-42\n');
  const GOODT = 'APP_TENANT=acme-prod-tenant-key-42 ';
  const FR = path.join(pA, 'front');
  add('H8', 'pretest must_be_under：$PWD/… 展開後在允許目錄內→放行',
    () => runPre(PT, sh(pA, GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="$PWD/front/i18n" python -m pytest')), 'ALLOW');
  add('H8', 'pretest must_be_under：${PWD}/… 形式→放行',
    () => runPre(PT, sh(pA, GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="${PWD}/front/i18n" python -m pytest')), 'ALLOW');
  add('H8', 'pretest must_be_under：MSYS 路徑 /c/…（Windows）在允許目錄內→放行',
    () => runPre(PT, sh(pA, GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="' + msys(path.join(FR, 'i18n')) + '" python -m pytest')), 'ALLOW');
  add('H8', 'pretest must_be_under：$PWD 展開後不在底下仍擋（對照）',
    () => runPre(PT, sh(pA, GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="$PWD/backend" python -m pytest')), 'DENY', (m) => /I18N_DIR/.test(m));
  const SECRET = 'globex-S3cr3t-T0ken-998877';
  add('B34', 'pretest 拒絕訊息不得原樣輸出環境值與對照檔值（遮罩）',
    () => runPre(PT, sh(pA, 'APP_TENANT=' + SECRET + ' FRONT_ROOT="' + FR + '" I18N_DIR="' + FR + '" python -m pytest')), 'DENY',
    (m) => /APP_TENANT/.test(m) && !m.includes(SECRET) && !m.includes('acme-prod-tenant-key-42') && /長度/.test(m));
  const pS = mkProj({ pretest: { side_effect_guards: [{ name: 'mail', file: 'src/Mail.cs', require_regex: ['MailTo\\s*=\\s*"qa@example\\.com"'] }] } });
  add('C06', 'pretest "pytest" 引號包覆執行檔也算跑測試→擋', () => runPre(PT, sh(pS, '"pytest" tests/e2e')), 'DENY', (m) => /讀不到 src\/Mail\.cs/.test(m));
  add('C06', "pretest 'python' -m \"pytest\" 引號包覆→擋", () => runPre(PT, sh(pS, "'python' -m \"pytest\" tests/e2e")), 'DENY');
  add('C06', 'pretest echo "pytest"（引號內提到）→放行（對照）', () => runPre(PT, sh(pS, 'echo "pytest"')), 'ALLOW');
  add('C07', 'pretest echo qa-flow.sh run（提到不是執行）→放行', () => runPre(PT, sh(pS, 'echo qa-flow.sh run cart')), 'ALLOW');
  add('C07', 'pretest grep "x" qa-flow.sh run（參數）→放行', () => runPre(PT, sh(pS, 'grep -n usage /x/qa-flow.sh run')), 'ALLOW');
  add('C07', 'pretest X=1 bash qa-flow.sh run 仍擋（對照）', () => runPre(PT, sh(pS, 'CLAUDE_PROJECT_DIR=/p bash "/x/qa-flow.sh" run cart t.py')), 'DENY');
  add('C07', 'pretest 直接執行 ./qa-flow.sh run 仍擋（對照）', () => runPre(PT, sh(pS, 'cd x && ./qa-flow.sh run cart t.py')), 'DENY');
  add('C02', 'pretest echo "x; " pytest（pytest 是 echo 的參數）→放行', () => runPre(PT, sh(pS, 'echo "x; " pytest')), 'ALLOW');
  add('C02', "pretest printf 'a && b' pytest→放行", () => runPre(PT, sh(pS, "printf 'a && b' pytest")), 'ALLOW');

  // =====================================================================
  // guard-qa-before-commit.js：A1 B37 B38 C09 C10 C11 C12
  // =====================================================================
  const QC = 'guard-qa-before-commit.js';
  const CG = { commit_gate: { enabled: true } };
  const mkRepo = (cfg, staged, extra) => {
    const dir = mkProj(cfg);
    git(dir, ['init', '-q', '.']);
    git(dir, ['config', 'user.email', 'qa@example.com']);
    git(dir, ['config', 'user.name', 'qa']);
    for (const [rel, body] of Object.entries(Object.assign({}, extra || {}, staged))) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    if (extra && Object.keys(extra).length) {
      git(dir, ['add', '--'].concat(Object.keys(extra)));
      git(dir, ['commit', '-q', '-m', 'init']);
    }
    if (Object.keys(staged).length) git(dir, ['add', '--'].concat(Object.keys(staged)));
    return dir;
  };
  const cBeh = mkRepo(CG, { 'src/app.js': 'x\n' });
  // 子程序用 process.execPath 絕對路徑啟動 node，PATH 指向空目錄＝一定找不到 git（不依賴 node 目錄裡沒有 git）
  const emptyBin = path.join(root, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const nodeOnly = { PATH: emptyBin, Path: emptyBin };
  add('A1', 'commit git 無法啟動（PATH 無 git）→fail-open 放行', () => runPre(QC, sh(cBeh, 'git commit -m "fix"'), nodeOnly), 'ALLOW');
  add('A1', 'commit Skill 路徑 git 無法啟動→fail-open 放行',
    () => runPre(QC, { cwd: cBeh, tool_name: 'Skill', tool_input: { skill: 'git-commit', args: '' } }, nodeOnly), 'ALLOW');
  const cNoRepo = mkProj({ commit_gate: { enabled: true, repos: ['sub'] } });
  fs.mkdirSync(path.join(cNoRepo, 'sub'), { recursive: true });
  add('B37', 'commit Skill 指定 repo 讀不到 staged（非 git repo）→仍須表態',
    () => runPre(QC, { cwd: cNoRepo, tool_name: 'Skill', tool_input: { skill: 'git-commit', args: '' } }), 'DENY', (m) => /無法判斷/.test(m));
  add('B37', 'commit Skill 讀不到 staged 但有表態→放行（對照）',
    () => runPre(QC, { cwd: cNoRepo, tool_name: 'Skill', tool_input: { skill: 'git-commit', args: '--qa "已QA：3 passed"' } }), 'ALLOW');
  {
    // 最後一輪退步審查：專案根本身不是 git repo（多 repo workspace），repos 未設定＝預設 '.' 讀不到 → 不得每次都擋
    const cWs = mkProj({ commit_gate: { enabled: true } });
    add('FR-C1', 'commit Skill 專案根不是 repo、repos 未設定→放行',
      () => runPre(QC, { cwd: cWs, tool_name: 'Skill', tool_input: { skill: 'git-commit', args: '' } }), 'ALLOW');
  }
  add('B38', 'commit git commit-tree（底層指令，不是 commit）→放行', () => runPre(QC, sh(cBeh, 'git commit-tree HEAD^{tree} -m x')), 'ALLOW');
  add('B38', 'commit git commit-graph write→放行', () => runPre(QC, sh(cBeh, 'git commit-graph write')), 'ALLOW');
  add('B38', 'commit git commit 仍擋（對照）', () => runPre(QC, sh(cBeh, 'git commit -m x')), 'DENY');
  // C09／C10：外層是只有文件的 repo，a/b 才是有行為類 staged 的 repo
  const outer = mkRepo(CG, { 'README.md': 'x\n' });
  const inner = path.join(outer, 'a', 'b');
  fs.mkdirSync(inner, { recursive: true });
  git(inner, ['init', '-q', '.']);
  fs.writeFileSync(path.join(inner, 'app.js'), 'x\n');
  git(inner, ['add', 'app.js']);
  add('C09', 'commit cd a && cd b && git commit（逐段累積）→擋 a/b 的行為檔', () => runPre(QC, sh(outer, 'cd a && cd b && git commit -m x')), 'DENY', (m) => /app\.js/.test(m));
  add('C09', 'commit cd a/b && git commit→擋（對照）', () => runPre(QC, sh(outer, 'cd a/b && git commit -m x')), 'DENY');
  add('C10', 'commit git -C a -C b commit（逐個累積）→擋', () => runPre(QC, sh(outer, 'git -C a -C b commit -m x')), 'DENY', (m) => /app\.js/.test(m));
  // C11／C12：repo 裡已有提交過的 app.js，工作樹改了但沒 stage
  const cPath = mkRepo(CG, {}, { 'src/app.js': 'v1\n', 'README.md': 'x\n' });
  fs.writeFileSync(path.join(cPath, 'src', 'app.js'), 'v2\n');
  fs.writeFileSync(path.join(cPath, 'src', 'new.js'), 'n\n');
  add('C11', 'commit git commit src/app.js（未 stage 的行為檔隨 pathspec 提交）→擋', () => runPre(QC, sh(cPath, 'git commit -m x src/app.js')), 'DENY', (m) => /src\/app\.js/.test(m));
  add('C11', 'commit git commit -m x -- src/app.js→擋', () => runPre(QC, sh(cPath, 'git commit -m "x" -- src/app.js')), 'DENY');
  add('C11', 'commit git commit -m x（無 pathspec、無 staged）→放行（對照）', () => runPre(QC, sh(cPath, 'git commit -m x')), 'ALLOW');
  add('C11', 'commit 訊息內含路徑字樣不算 pathspec→放行', () => runPre(QC, sh(cPath, 'git commit -m "fix src/app.js" --author "a <a@example.com>"')), 'ALLOW');
  add('C11', 'commit -F - <<EOF 訊息不算 pathspec→放行', () => runPre(QC, sh(cPath, "git commit -F - <<'EOF'\nfix src/app.js\nEOF")), 'ALLOW');
  add('C11', 'commit -mmsg 緊貼值＋pathspec→擋', () => runPre(QC, sh(cPath, 'git commit -mfix src/app.js')), 'DENY');
  add('C11', 'commit PowerShell 反斜線 pathspec git commit -m x src\\app.js→擋', () => runPre(QC, sh(cPath, 'git commit -m x src\\app.js', 'PowerShell')), 'DENY', (m) => /src\/app\.js/.test(m)); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('C12', 'commit PowerShell git add src\\app.js; git commit→擋', () => runPre(QC, sh(cPath, 'git add src\\app.js; git commit -m x', 'PowerShell')), 'DENY'); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('C12', 'commit git add src/app.js && git commit→擋', () => runPre(QC, sh(cPath, 'git add src/app.js && git commit -m x')), 'DENY', (m) => /src\/app\.js/.test(m));
  add('C12', 'commit git add 新檔 && git commit→擋', () => runPre(QC, sh(cPath, 'git add src/new.js && git commit -m x')), 'DENY', (m) => /src\/new\.js/.test(m));
  add('C12', 'commit git add -A; git commit→擋', () => runPre(QC, sh(cPath, 'git add -A; git commit -m x')), 'DENY');
  add('C12', 'commit git add README.md && git commit（只加文件）→放行', () => runPre(QC, sh(cPath, 'git add README.md && git commit -m x')), 'ALLOW');

  // =====================================================================
  // guard-qa-dispatch.js：A2
  // =====================================================================
  const QD = 'guard-qa-dispatch.js';
  const dBad = mkProj({ dispatch_gate: { checks: ['triage'], params: { triage: { reuse_regex: '(unclosed' } } } });
  add('A2', 'dispatch triage 的 reuse_regex 壞掉→該項 fail-open 放行',
    () => runPre(QD, { cwd: dBad, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: '【增量分流】reuse：tests/e2e/cart/test_cart.py' } }), 'ALLOW');
  const dBad2 = mkProj({ dispatch_gate: { checks: ['triage'], params: { triage: { new_regex: '[bad' } } } });
  add('A2', 'dispatch triage 的 new_regex 壞掉→該項 fail-open 放行',
    () => runPre(QD, { cwd: dBad2, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: '【增量分流】新TC：新畫面' } }), 'ALLOW');

  // =====================================================================
  // guard-browser-nav.js：A3 B35 C13
  // =====================================================================
  const BN = 'guard-browser-nav.js';
  const bnCfg = { browser_guard: { deny_hosts_regex: '(^|\\.)prod\\.example\\.com$', rate_limits: [{ host_regex: 'shop\\.example\\.test$', max: 2, window_s: 60 }] } };
  const nav = (cwd, url) => ({ cwd, tool_name: 'mcp__playwright__browser_navigate', tool_input: { url } });
  const bn1 = mkProj(bnCfg);
  add('C13', 'nav host 尾端句點 prod.example.com. →擋', () => runPre(BN, nav(bn1, 'https://prod.example.com./admin'), { QA_WEBWRIGHT_NAV_STATE: path.join(root, 'c13.json') }), 'DENY');
  add('C13', 'nav host 尾端句點＋大寫 PROD.example.COM. →擋', () => runPre(BN, nav(bn1, 'https://PROD.example.COM../x'), { QA_WEBWRIGHT_NAV_STATE: path.join(root, 'c13.json') }), 'DENY');
  {
    const st = { QA_WEBWRIGHT_NAV_STATE: path.join(root, 'b35.json') };
    const pX = mkProj(bnCfg);
    const pY = mkProj(bnCfg);
    add('B35', 'nav 專案 X 第 1 次→放行', () => runPre(BN, nav(pX, 'https://shop.example.test/'), st), 'ALLOW');
    add('B35', 'nav 專案 X 第 2 次→放行', () => runPre(BN, nav(pX, 'https://shop.example.test/a'), st), 'ALLOW');
    add('B35', 'nav 專案 Y 第 1 次（不得吃到 X 的計數）→放行', () => runPre(BN, nav(pY, 'https://shop.example.test/'), st), 'ALLOW');
    add('B35', 'nav 專案 X 第 3 次→擋（對照）', () => runPre(BN, nav(pX, 'https://shop.example.test/b'), st), 'DENY');
  }
  {
    // A3：狀態讀得到但寫不進去 → 限速判斷不可靠 → 放行（fail-open）
    const dir = path.join(root, 'a3state');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'nav.json');
    const st = { QA_WEBWRIGHT_NAV_STATE: f };
    const pZ = mkProj(bnCfg);
    add('A3', 'nav 限速第 1 次→放行（預備）', () => runPre(BN, nav(pZ, 'https://shop.example.test/'), st), 'ALLOW');
    add('A3', 'nav 限速第 2 次→放行（預備）', () => runPre(BN, nav(pZ, 'https://shop.example.test/'), st), 'ALLOW');
    add('A3', 'nav 狀態檔寫不進去時第 3 次→fail-open 放行', () => {
      if (process.platform === 'win32') fs.chmodSync(f, 0o444); // 唯讀屬性：rename 覆寫失敗
      else fs.chmodSync(dir, 0o555); // 目錄不可寫：tmp 建不出來
      try {
        return runPre(BN, nav(pZ, 'https://shop.example.test/'), st);
      } finally {
        try {
          fs.chmodSync(f, 0o644);
          fs.chmodSync(dir, 0o755);
        } catch (_) {}
      }
    }, 'ALLOW');
  }

  // =====================================================================
  // guard-test-asset-hygiene.js：A6 A8 H9（hook 端）
  // =====================================================================
  const PY = pickPy();
  const mkHyg = () => {
    const d = mkProj();
    const e2e = path.join(d, 'tests', 'e2e');
    fs.mkdirSync(path.join(e2e, 'orders'), { recursive: true });
    spawnSync(PY, [INSTALLER, 'install', e2e], { encoding: 'utf8' });
    fs.writeFileSync(path.join(e2e, 'orders', 'COVERAGE.md'),
      '# orders/ 情境覆蓋\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n| 建立訂單後列表看得到 | `test_orders.py::test_create` | ✅ |\n');
    return e2e;
  };
  const post = (e2e, rel, body, toolName) => {
    const abs = path.join(e2e, ...rel.split('/'));
    if (body !== null) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return runPost({ session_id: 'fix' + (sid++), tool_name: toolName || 'Write', cwd: path.dirname(path.dirname(e2e)), tool_input: { file_path: abs } });
  };
  const ORPHAN = 'def test_create():\n    assert True\n\ndef test_unregistered():\n    assert True\n';
  if (PY) {
    const noHc = mkHyg();
    fs.unlinkSync(path.join(noHc, 'tools', 'hardcode_check.py'));
    add('A8', 'hyg 缺 hardcode_check.py 時其他工具照跑（drift 孤兒→exit2）', () => post(noHc, 'orders/test_orders.py', ORPHAN), 'BLOCK2', (m) => /test_unregistered/.test(m));
    const big = mkHyg();
    const many = ['def test_create():\n    assert True\n'];
    for (let i = 0; i < 400; i++) many.push('def test_unregistered_' + String(i).padStart(4, '0') + '_' + 'x'.repeat(150) + '():\n    assert True\n');
    add('A6', 'hyg 阻擋訊息完整送達（stderr 結尾標記在）', () => post(big, 'orders/test_orders.py', many.join('\n')), 'BLOCK2',
      (m) => /只擋\*\*新增\*\*/.test(m));
    const bl = mkHyg();
    fs.writeFileSync(path.join(bl, 'orders', 'test_orders.py'), 'def test_create():\n    assert True\n');
    writeJson(path.join(bl, '_reports', 'drift-baseline.json'), { fingerprints: [] });
    add('H9', 'hyg 直接 Write baseline JSON→提示（不得手改存量豁免）', () => post(bl, '_reports/drift-baseline.json', null), 'NOTE',
      (m) => /baseline/.test(m) && /--write-baseline/.test(m));
    // 最後一輪退步審查：專案自有工具的 baseline（沒有對應的本 plugin 工具）→不提示不存在的指令
    writeJson(path.join(bl, '_reports', 'route-match-baseline.json'), { fingerprints: [] });
    add('FR-H6', 'hyg 專案自有工具的 baseline JSON→靜默（不給不存在的指令）', () => post(bl, '_reports/route-match-baseline.json', null), 'SILENT');
    // 最後一輪退步審查：路徑含小寫後長度會變的字元（İ）→仍正確找到 tests/e2e 根
    {
      const weird = path.join(root, 'İstanbul-proj');
      fs.mkdirSync(weird, { recursive: true });
      const src = mkHyg();
      fs.cpSync(path.dirname(path.dirname(src)), weird, { recursive: true });
      const wE2e = path.join(weird, 'tests', 'e2e');
      add('FR-H5', 'hyg 專案路徑含 İ＋A 類寫死 Id→仍擋', () => post(wE2e, 'orders/test_orders.py', 'ORDER_ID = 1133\n\ndef test_create():\n    assert ORDER_ID\n'), 'BLOCK2');
    }
    const blBad = mkHyg();
    fs.mkdirSync(path.join(blBad, '_reports'), { recursive: true });
    fs.writeFileSync(path.join(blBad, '_reports', 'drift-baseline.json'), '{ broken json');
    add('H9', 'hyg baseline 檔壞掉→明確擋（不得當成沒有 baseline 而沉默）', () => post(blBad, 'orders/test_orders.py', 'def test_create():\n    assert True\n'), 'BLOCK2',
      (m) => /baseline/.test(m) && /壞/.test(m));
  } else {
    add('A8', 'hyg 找不到 python，無法驗證', () => ({ tag: 'NOPY', msg: '' }), 'BLOCK2');
  }

  // =====================================================================
  // 註：下方各段的「A 軌／B 軌」＝送審時並行的兩條獨立審查軌，編號前綴標明意見出自哪一軌。
  // R3 第 1 輪審查意見（K1-xx＝A 軌 hooks 批）
  // =====================================================================
  {
    // K1-01：input.cwd 是權威；它往上找不到參數檔時，不得改用 CLAUDE_PROJECT_DIR 指到的別的專案
    const noCfg = mkProj();
    const other = mkProj({ pretest: { side_effect_guards: [{ name: 'mail', file: 'src/Nope.cs', require_regex: ['x'] }] } });
    add('K1-01', 'pretest cwd 專案無參數檔、CLAUDE_PROJECT_DIR 指向別專案→靜默', () => runPre(PT, sh(noCfg, 'python -m pytest'), { CLAUDE_PROJECT_DIR: other }), 'ALLOW');
    add('K1-01', 'pretest 沒有 cwd 時才退回 CLAUDE_PROJECT_DIR（對照）', () => runPre(PT, { tool_name: 'Bash', tool_input: { command: 'python -m pytest' } }, { CLAUDE_PROJECT_DIR: other }), 'DENY');
  }
  add('K1-02', 'pretest echo sudo pytest（sudo 是 echo 的參數）→放行', () => runPre(PT, sh(pS, 'echo sudo pytest')), 'ALLOW');
  add('K1-02', 'pretest grep time pytest.ini tests→放行', () => runPre(PT, sh(pS, 'echo run with time pytest later')), 'ALLOW');
  add('K1-02', 'pretest sudo -E pytest 仍擋（對照）', () => runPre(PT, sh(pS, 'sudo -E pytest tests')), 'DENY');
  add('K1-02', 'pretest env X=1 time pytest 仍擋（對照）', () => runPre(PT, sh(pS, 'env X=1 time pytest tests')), 'DENY');
  add('K1-03', 'commit PowerShell "C:\\tmp\\" 之後的 git commit 不得被當成引號內容', () => runPre(QC, sh(cBeh, 'echo "C:\\tmp\\"; git commit -m x', 'PowerShell')), 'DENY'); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('K1-03', 'pretest PowerShell "C:\\x\\"; pytest→擋', () => runPre(PT, sh(pS, 'echo "C:\\x\\"; python -m pytest', 'PowerShell')), 'DENY'); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('K1-04', 'pretest PowerShell $env:X 展開：I18N_DIR 在 FRONT_ROOT 外→擋', () => runPre(PT, sh(pA, // portable-ok: 合成 payload 的案例名稱字串
    '$env:APP_TENANT="acme-prod-tenant-key-42"; $env:FRONT_ROOT="' + FR + '"; $env:I18N_DIR="$env:FRONT_ROOT/../backend"; python -m pytest', 'PowerShell')), 'DENY', (m) => /I18N_DIR/.test(m)); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('K1-04', 'pretest PowerShell $env:X 展開：在底下→放行（對照）', () => runPre(PT, sh(pA, // portable-ok: 合成 payload 的案例名稱字串
    '$env:APP_TENANT="acme-prod-tenant-key-42"; $env:FRONT_ROOT="' + FR + '"; $env:I18N_DIR="$env:FRONT_ROOT/i18n"; python -m pytest', 'PowerShell')), 'ALLOW'); // portable-ok: 合成 payload 字串，非呼叫系統指令
  fs.writeFileSync(path.join(pA, 'env.bad.sh'), 'export APP_TENANT=globex\n');
  fs.mkdirSync(path.join(pA, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(pA, 'sub', 'env.sh'), 'export APP_TENANT=globex\n');
  fs.writeFileSync(path.join(pA, 'env.sh'), 'export APP_TENANT=acme-prod-tenant-key-42\n');
  const FRI = 'FRONT_ROOT="' + FR + '" I18N_DIR="' + FR + '" ';
  add('K1-05', 'pretest export 舊值後 source 覆寫：以較晚的 source 為準→擋', () => runPre(PT, sh(pA, 'export APP_TENANT=acme-prod-tenant-key-42; source ./env.bad.sh && ' + FRI + 'python -m pytest')), 'DENY', (m) => /APP_TENANT/.test(m));
  add('K1-05', 'pretest source 後再 export 正確值：以較晚的 export 為準→放行（對照）', () => runPre(PT, sh(pA, 'source ./env.bad.sh; export APP_TENANT=acme-prod-tenant-key-42; ' + FRI + 'python -m pytest')), 'ALLOW');
  add('K1-06', 'pretest .venv/bin/pytest→擋', () => runPre(PT, sh(pS, '.venv/bin/pytest tests')), 'DENY');
  add('K1-06', 'pretest .venv/Scripts/python.exe -m pytest→擋', () => runPre(PT, sh(pS, '.venv/Scripts/python.exe -m pytest tests')), 'DENY');
  add('K1-06', 'pretest cat .venv/bin/pytest（讀檔）→放行（對照）', () => runPre(PT, sh(pS, 'cat .venv/bin/pytest')), 'ALLOW');
  add('K1-07', 'pretest cd sub && source ./env.sh：讀 sub/env.sh→擋', () => runPre(PT, sh(pA, 'cd sub && source ./env.sh && ' + FRI + 'python -m pytest')), 'DENY', (m) => /APP_TENANT/.test(m));
  add('K1-07', 'pretest 沒 cd 時 source ./env.sh 讀根目錄那份→放行（對照）', () => runPre(PT, sh(pA, 'source ./env.sh && ' + FRI + 'python -m pytest')), 'ALLOW');
  add('K1-08', 'pretest 以絕對路徑 source：訊息不得帶出完整本機路徑', () => runPre(PT, sh(pA, 'source "' + path.join(pA, 'env.bad.sh').replace(/\\/g, '/') + '" && ' + FRI + 'python -m pytest')), 'DENY',
    (m) => /env\.bad\.sh/.test(m) && !m.includes(pA.replace(/\\/g, '/')) && !m.includes(pA));
  {
    const pBadRule = mkProj({ pretest: { side_effect_guards: [{ name: 'mail', file: 'src/Nope.cs', require_regex: 'MailTo' }] } });
    add('K1-09', 'pretest 規則型別錯（require_regex 是字串）→該條 fail-open，不因檔不在而擋', () => runPre(PT, sh(pBadRule, 'python -m pytest')), 'ALLOW');
  }
  {
    // K1-10：pathspec 提交只看 pathspec 範圍；-i/--include 才連同 staged
    const r10 = mkRepo(CG, {}, { 'src/app.js': 'v1\n', 'README.md': 'v1\n' });
    fs.writeFileSync(path.join(r10, 'src', 'app.js'), 'v2\n');
    git(r10, ['add', 'src/app.js']);
    fs.writeFileSync(path.join(r10, 'README.md'), 'v2\n');
    add('K1-10', 'commit 有 staged 行為檔但 git commit -- README.md 只提交文件→放行', () => runPre(QC, sh(r10, 'git commit -m x -- README.md')), 'ALLOW');
    add('K1-10', 'commit git commit -i README.md（連同 staged）→擋（對照）', () => runPre(QC, sh(r10, 'git commit -i -m x README.md')), 'DENY');
    add('K1-10', 'commit git commit -m x（staged 行為檔）→擋（對照）', () => runPre(QC, sh(r10, 'git commit -m x')), 'DENY');
  }
  add('K1-11', 'commit git.exe commit→擋', () => runPre(QC, sh(cBeh, 'git.exe commit -m x')), 'DENY');
  add('K1-11', 'commit "git" commit→擋', () => runPre(QC, sh(cBeh, '"git" commit -m x')), 'DENY');
  add('K1-11', 'commit git -c "user.name=A B" commit→擋', () => runPre(QC, sh(cBeh, 'git -c "user.name=A B" commit -m x')), 'DENY');
  add('K1-11', 'commit /usr/bin/git commit→擋', () => runPre(QC, sh(cBeh, '/usr/bin/git commit -m x')), 'DENY');
  {
    const r12 = mkRepo(CG, {}, { 'app.js': 'v1\n', 'sub/readme.md': 'x\n' });
    fs.writeFileSync(path.join(r12, 'app.js'), 'v2\n');
    add('K1-12', 'commit 在子目錄 git add -A && git commit：全 repo 範圍→擋', () => runPre(QC, sh(r12, 'cd sub && git add -A && git commit -m x')), 'DENY', (m) => /app\.js/.test(m));
  }
  {
    const cEx = mkRepo({ commit_gate: { enabled: true, extra_commands: [{ name: 'review-record', regex: 'flow\\.sh["\']?\\s+review-record\\s+("[^"]*"|\'[^\']*\'|[^\\s;&|]+)', repo_group: 1 }] } }, { 'src/app.js': 'x\n' });
    add('K1-13', 'commit echo flow.sh review-record .（提到不是執行）→放行', () => runPre(QC, sh(cEx, 'echo flow.sh review-record .')), 'ALLOW');
    add('K1-13', 'commit bash flow.sh review-record . 仍擋（對照）', () => runPre(QC, sh(cEx, 'bash /x/flow.sh review-record .')), 'DENY');
  }
  add('K1-14', 'dispatch triage regex 壞＋缺【增量分流】格→該項仍 fail-open', () => runPre(QD, { cwd: dBad, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: '請測購物車' } }), 'ALLOW');
  add('K1-15', 'report cd tests/reports && touch debug.log→擋（根層放檔）', () => runPre(RO, sh(ro, 'cd tests/reports && touch debug.log')), 'DENY', (m) => /debug\.log/.test(m));
  add('K1-15', 'report cd 到專案外再寫相對路徑→放行（對照）', () => runPre(RO, sh(ro, 'cd .. && touch tests/reports/x.log')), 'ALLOW');
  add('K1-16', 'report tar --list --file=交付檔（讀取）→放行', () => runPre(RO, sh(ro, 'tar --list --file=tests/reports/topic_20260924/a.zip')), 'ALLOW');
  add('K1-16', 'report tar -cf 過程檔到交付資料夾→擋（對照）', () => runPre(RO, sh(ro, 'tar -cf tests/reports/topic_20260924/a.zip src')), 'DENY');
  add('K1-16', 'report tar --create --file=… →擋（對照）', () => runPre(RO, sh(ro, 'tar --create --file=tests/reports/topic_20260924/a.zip src')), 'DENY');
  add('K1-17', 'report PowerShell Set-Content -Force <路徑> <值>→擋', () => runPre(RO, sh(ro, 'Set-Content -Force tests/reports/debug.log hello', 'PowerShell')), 'DENY', (m) => /debug\.log/.test(m)); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('K1-17', 'report PowerShell Set-Content -Path <路徑> -Value x→擋（對照）', () => runPre(RO, sh(ro, 'Set-Content -Path tests/reports/debug.log -Value hello', 'PowerShell')), 'DENY'); // portable-ok: 合成 payload 字串，非呼叫系統指令
  {
    // K1-19：有測試與報告、但某子目錄 stat 失敗，而可讀的地方沒有登記 → 不確定（放行），不得當成「沒登記」
    const d = mkProj();
    const e2e = path.join(d, 'tests', 'e2e');
    fs.mkdirSync(path.join(e2e, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(e2e, 'reports', 'x.xml'), '<testsuite/>\n');
    fs.writeFileSync(path.join(e2e, 'test_x.py'), 'def test_x():\n    assert True\n');
    let linked = true;
    try {
      fs.symlinkSync(path.join(root, 'no-such-target-k119'), path.join(e2e, 'orders'), 'junction');
    } catch (_) {
      linked = false;
    }
    add('K1-19', 'landing 有測試＋報告、子目錄不可讀、可讀處無登記→不確定放行',
      () => (linked ? runStop(d, T) : { tag: 'ALLOW', msg: '（此平台無法建立連結，略過）' }), 'ALLOW');
  }

  // =====================================================================
  // R3 第 2 輪審查意見（L1-xx＝A 軌 hooks 批）
  // =====================================================================
  add('L1-01', 'pretest if pytest; then …→擋', () => runPre(PT, sh(pS, 'if pytest tests; then echo ok; fi')), 'DENY');
  add('L1-01', 'commit if git commit …; then→擋', () => runPre(QC, sh(cBeh, 'if git commit -m x; then echo ok; fi')), 'DENY');
  add('L1-01', 'pretest while/until 條件裡跑 pytest→擋', () => runPre(PT, sh(pS, 'until pytest tests; do sleep 1; done')), 'DENY');
  add('L1-02', 'pretest python \\ 續行 -m pytest→擋', () => runPre(PT, sh(pS, 'python \\\n  -m pytest tests')), 'DENY');
  add('L1-02', 'commit git \\ 續行 commit→擋', () => runPre(QC, sh(cBeh, 'git \\\n  commit -m x')), 'DENY');
  add('L1-03', 'report Git Bash 雙引號內反斜線路徑（\\r \\b 不是跳脫）→擋', () => runPre(RO, sh(ro, 'echo x > "tests\\reports\\bad.xml"')), 'DENY'); // portable-ok: 合成 payload 字串，非執行路徑
  add('L1-04', 'commit 2>&1 在 -m 表態之前→表態仍算數', () => runPre(QC, sh(cBeh, 'git commit 2>&1 -m "已QA：tests/e2e/cart/test_cart.py 3 passed"')), 'ALLOW');
  add('L1-05', 'pretest 值是未設變數 "$UNSET"→無從判斷不擋', () => runPre(PT, sh(pA, 'APP_TENANT="$QA_UNSET_FOR_TEST" ' + FRI + 'python -m pytest')), 'ALLOW');
  add('L1-05', 'pretest 值引用已設變數→展開後比對相符放行', () => runPre(PT, sh(pA, 'APP_TENANT="$QA_TENANT_SRC" ' + FRI + 'python -m pytest'), { QA_TENANT_SRC: 'acme-prod-tenant-key-42' }), 'ALLOW');
  add('L1-05', 'pretest 值引用已設變數→展開後不符擋（對照）', () => runPre(PT, sh(pA, 'APP_TENANT="$QA_TENANT_SRC" ' + FRI + 'python -m pytest'), { QA_TENANT_SRC: 'other-tenant-xyz' }), 'DENY');
  fs.mkdirSync(path.join(pA, 'sub2'), { recursive: true });
  add('L1-06', 'pretest cd sub2 && source ./env.sh（sub2 沒有這檔）→不得拿根目錄同名檔的值', () => runPre(PT, sh(pA, 'cd sub2 && source ./env.sh && ' + FRI + 'python -m pytest')), 'DENY', (m) => /未設 APP_TENANT/.test(m));
  add('L1-07', 'pretest 引號內含空白的執行檔路徑 "/Apps/QA Env/bin/python3" -m pytest→擋', () => runPre(PT, sh(pS, '"/Applications/QA Env/bin/python3" -m pytest tests')), 'DENY');
  add('L1-07', 'pretest "C:/Program Files/Py/python.exe" -m pytest→擋', () => runPre(PT, sh(pS, '"C:/Program Files/Py/python.exe" -m pytest tests')), 'DENY'); // portable-ok: 合成 payload 字串，非執行路徑
  {
    const pBadAlign = mkProj({ pretest: { alignment: [{ env: 'QA_NEVER_SET_X', required: true, matches: '(' }] } });
    add('L1-08', 'pretest alignment 規則 regex 壞（required＋壞 matches）→整條 fail-open', () => runPre(PT, sh(pBadAlign, 'python -m pytest')), 'ALLOW');
    const pBadType = mkProj({ pretest: { alignment: [{ env: 'QA_NEVER_SET_X', required: 'yes' }] } });
    add('L1-08', 'pretest alignment 規則型別錯（required 是字串）→整條 fail-open', () => runPre(PT, sh(pBadType, 'python -m pytest')), 'ALLOW');
  }
  {
    const crBad = mkProj({ command_guards: [{ name: 'db', when_regex: 'sqlcmd', deny_regex: '-U sa', require_env: ['QA_DB_ENV_X'] }] });
    add('L1-09', 'command 規則欄位型別錯（deny_regex 是字串）→整條略過', () => runPre('guard-command-rules.js', sh(crBad, 'sqlcmd -U sa -Q x')), 'ALLOW');
  }
  add('L1-10', 'commit git -Ca/b commit（-C 黏寫）→擋', () => runPre(QC, sh(outer, 'git -Ca/b commit -m x')), 'DENY', (m) => /app\.js/.test(m));
  add('L1-10', 'commit 引號包住含空白的 git 路徑→擋', () => runPre(QC, sh(cBeh, '"C:/Program Files/Git/bin/git.exe" commit -m x')), 'DENY'); // portable-ok: 合成 payload 字串，非執行路徑
  add('L1-11', 'commit --git-dir／--work-tree 指到別的 repo→無法判斷，要求表態', () => runPre(QC, sh(outer, 'git --git-dir=a/b/.git --work-tree=a/b commit -m x')), 'DENY', (m) => /無法判斷/.test(m));
  {
    const r12b = mkRepo(CG, {}, { 'sub/app.py': 'v1\n', 'README.md': 'x\n' });
    fs.writeFileSync(path.join(r12b, 'sub', 'app.py'), 'v2\n');
    add('L1-12', 'commit git add sub/app.py && cd sub && git commit→擋', () => runPre(QC, sh(r12b, 'git add sub/app.py && cd sub && git commit -m x')), 'DENY', (m) => /app\.py/.test(m));
  }
  {
    const r13 = mkRepo(CG, {}, { 'src/app.js': 'v1\n', 'README.md': 'v1\n' });
    fs.writeFileSync(path.join(r13, 'src', 'app.js'), 'v2\n');
    fs.writeFileSync(path.join(r13, 'README.md'), 'v2\n');
    add('L1-13', 'commit git add app.js && git commit README.md（只提交 pathspec）→放行', () => runPre(QC, sh(r13, 'git add src/app.js && git commit -m x README.md')), 'ALLOW');
    const r14 = mkRepo(CG, {}, { 'README.md': 'v1\n' });
    fs.writeFileSync(path.join(r14, 'README.md'), 'v2\n');
    fs.mkdirSync(path.join(r14, 'src'), { recursive: true });
    fs.writeFileSync(path.join(r14, 'src', 'new.js'), 'n\n');
    add('L1-14', 'commit git add -u（不含未追蹤檔）&& git commit→只有文件→放行', () => runPre(QC, sh(r14, 'git add -u && git commit -m x')), 'ALLOW');
    add('L1-14', 'commit git add -A（含未追蹤檔）&& git commit→擋（對照）', () => runPre(QC, sh(r14, 'git add -A && git commit -m x')), 'DENY');
  }
  {
    const dStr = mkProj({ dispatch_gate: { checks: 'triage' } });
    add('L1-16', 'dispatch checks 型別錯（字串）→靜默', () => runPre(QD, { cwd: dStr, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: '請測購物車' } }), 'ALLOW');
    const dAl = mkProj({ dispatch_gate: { checks: ['alignment'], params: { alignment: { regex: '(' } } } });
    add('L1-17', 'dispatch alignment 覆寫 regex 壞＋缺標籤→該項 fail-open', () => runPre(QD, { cwd: dAl, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: '請測購物車' } }), 'ALLOW');
  }
  add('L1-18', 'report 根層長副檔名 bad.markdown→擋', () => runPre(RO, w(ro, 'tests/reports/bad.markdown')), 'DENY');
  add('L1-19', 'report PowerShell New-Item -Path 交付根 -Name bad.xml -ItemType File→擋', () => runPre(RO, sh(ro, 'New-Item -Path tests/reports -Name bad.xml -ItemType File', 'PowerShell')), 'DENY'); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('L1-19', 'report PowerShell New-Item -ItemType Directory 名字像檔案的資料夾→放行', () => runPre(RO, sh(ro, 'New-Item -ItemType Directory tests/reports/topic_x.png', 'PowerShell')), 'ALLOW'); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('L1-20', 'nav 多層 a.b.localhost 永遠放行', () => runPre(BN, nav(mkProj({ browser_guard: { deny_hosts_regex: '.*' } }), 'http://a.b.localhost:3000/'), { QA_WEBWRIGHT_NAV_STATE: path.join(root, 'l120.json') }), 'ALLOW');
  {
    const pW = mkProj({ browser_guard: { rate_limits: [{ host_regex: 'slow\\.example\\.test$', max: 1, window_s: 172800 }] } });
    const stf = path.join(root, 'l121.json');
    const key = path.resolve(pW) + '|0|slow\\.example\\.test$|slow.example.test';
    fs.writeFileSync(stf, JSON.stringify({ [key]: [Date.now() - 25 * 3600 * 1000] }));
    add('L1-21', 'nav 視窗兩天：25 小時前的紀錄仍在視窗內→擋', () => runPre(BN, nav(pW, 'https://slow.example.test/'), { QA_WEBWRIGHT_NAV_STATE: stf }), 'DENY');
    add('L1-21', 'nav 視窗兩天：再導向一次仍擋（紀錄不得被 24 小時清理提前刪掉）', () => runPre(BN, nav(pW, 'https://slow.example.test/'), { QA_WEBWRIGHT_NAV_STATE: stf }), 'DENY');
  }
  if (PY) {
    const bom = mkHyg();
    const cp = path.join(bom, 'qa-webwright.json');
    fs.writeFileSync(cp, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(cp)]));
    add('L1-22', 'hyg 參數檔帶 BOM→照常啟動（孤兒→exit2）', () => post(bom, 'orders/test_orders.py', ORPHAN), 'BLOCK2');
    const ci = mkHyg();
    if (process.platform === 'win32' || process.platform === 'darwin') {
      add('L1-23', 'hyg 路徑大小寫不同（Tests/E2E）→照常啟動', () => {
        fs.writeFileSync(path.join(ci, 'orders', 'test_orders.py'), ORPHAN);
        const abs = path.join(path.dirname(path.dirname(ci)), 'Tests', 'E2E', 'orders', 'test_orders.py');
        return runPost({ session_id: 'fix' + (sid++), tool_name: 'Write', cwd: path.dirname(path.dirname(ci)), tool_input: { file_path: abs } });
      }, 'BLOCK2');
    }
    const pyAbs = String(spawnSync(PY, ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).stdout || '').trim();
    const qp = mkHyg();
    add('L1-24', 'hyg QA_PYTHON 絕對路徑不得出現在回饋訊息', () => {
      const abs = path.join(qp, 'orders', 'test_orders.py');
      fs.writeFileSync(abs, ORPHAN);
      return runPost({ session_id: 'fix' + (sid++), tool_name: 'Write', cwd: path.dirname(path.dirname(qp)), tool_input: { file_path: abs } }, { QA_PYTHON: pyAbs });
    }, 'BLOCK2', (m) => pyAbs && !m.includes(pyAbs) && !m.includes(path.dirname(pyAbs)));
  }
  {
    const d = mkProj();
    const e2e = path.join(d, 'tests', 'e2e');
    fs.mkdirSync(path.join(e2e, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(e2e, 'test_fake.py'), { recursive: true });
    fs.writeFileSync(path.join(e2e, 'reports', 'x.xml'), '<testsuite/>\n');
    fs.writeFileSync(path.join(e2e, 'catalog.md'), '| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |\n|---|---|---|---|\n| 登入 | test_x | ✅完整 | 帳號 |\n');
    add('L1-25', 'landing 名叫 test_fake.py 的資料夾不算測試檔→擋', () => runStop(d, T), 'BLOCK');
  }

  // =====================================================================
  // R3 第 3 輪審查意見（M1-xx＝A 軌 hooks 批；B 軌同題者併入同一 ID）
  // =====================================================================
  add('M1-01', 'commit cd -- a/b && git commit→以 a/b 判斷', () => runPre(QC, sh(outer, 'cd -- a/b && git commit -m x')), 'DENY', (m) => /app\.js/.test(m));
  add('M1-01', 'commit PowerShell Set-Location -Path a/b; git commit→以 a/b 判斷', () => runPre(QC, sh(outer, 'Set-Location -Path a/b; git commit -m x', 'PowerShell')), 'DENY', (m) => /app\.js/.test(m)); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('M1-01', 'report cd -- tests/reports && touch debug.log→擋', () => runPre(RO, sh(ro, 'cd -- tests/reports && touch debug.log')), 'DENY', (m) => /debug\.log/.test(m));
  add('M1-02', 'pretest 多層變數 ROOT→BASE→I18N_DIR 展開後在底下→放行', () => runPre(PT, sh(pA, 'ROOT="' + FR + '"; BASE=$ROOT; ' + GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="$BASE/i18n" python -m pytest')), 'ALLOW');
  add('M1-02', 'pretest equals_file：T0→T1→APP_TENANT 兩層變數展開後相符→放行', () => runPre(PT, sh(pA, 'T0=acme-prod-tenant-key-42; T1=$T0; ' + FRI + 'APP_TENANT="$T1" python -m pytest')), 'ALLOW');
  add('M1-02', 'pretest must_be_under：三層變數 R→M→B→I18N_DIR 展開後在底下→放行', () => runPre(PT, sh(pA, 'R="' + FR + '"; M=$R; B=$M; ' + GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="$B/i18n" python -m pytest')), 'ALLOW');
  add('M1-02', 'pretest 多層變數展開後不在底下→擋（對照）', () => runPre(PT, sh(pA, 'ROOT="' + path.join(pA, 'backend') + '"; BASE=$ROOT; ' + GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="$BASE/i18n" python -m pytest')), 'DENY', (m) => /I18N_DIR/.test(m));
  fs.writeFileSync(path.join(pA, 'envq.sh'), "export I18N_DIR='$FRONT_ROOT/i18n'\n");
  add('M1-03', "pretest source 檔裡單引號 '$FRONT_ROOT/i18n' 是字面值（不展開）→不在底下擋", () => runPre(PT, sh(pA, 'source ./envq.sh && ' + GOODT + 'FRONT_ROOT="' + FR + '" python -m pytest')), 'DENY', (m) => /I18N_DIR/.test(m));
  add('M1-03', "pretest inline 單引號 I18N_DIR='$FRONT_ROOT/i18n' 字面值→擋", () => runPre(PT, sh(pA, GOODT + 'FRONT_ROOT="' + FR + "\" I18N_DIR='$FRONT_ROOT/i18n' python -m pytest")), 'DENY', (m) => /I18N_DIR/.test(m));
  add('M1-03', 'pretest inline 雙引號 "$FRONT_ROOT/i18n" 展開→放行（對照）', () => runPre(PT, sh(pA, GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="$FRONT_ROOT/i18n" python -m pytest')), 'ALLOW');
  {
    const g4 = { name: 'mail', file: 'src/Mail.cs', block_regex: 'class Sender\\s*\\{[^}]*\\}', require_regex: ['MailTo\\s*=\\s*"qa@example\\.com"'] };
    const pBlk = mkProj({ pretest: { side_effect_guards: [g4] } });
    fs.mkdirSync(path.join(pBlk, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pBlk, 'src', 'Mail.cs'), 'class Other { string MailTo = "qa@example.com"; }\n');
    add('M1-04', 'pretest block_regex 找不到防線區塊（被改名／刪掉）→擋，不退回全檔', () => runPre(PT, sh(pBlk, 'python -m pytest')), 'DENY', (m) => /區塊/.test(m));
    const pBlk2 = mkProj({ pretest: { side_effect_guards: [g4] } });
    fs.mkdirSync(path.join(pBlk2, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pBlk2, 'src', 'Mail.cs'), 'class Sender { string MailTo = "qa@example.com"; }\n');
    add('M1-04', 'pretest block_regex 找得到區塊且防線在→放行（對照）', () => runPre(PT, sh(pBlk2, 'python -m pytest')), 'ALLOW');
    const pMsg = mkProj({ pretest: { side_effect_guards: [{ name: 'mail', file: 'src/Nope.cs', require_regex: ['x'], message: 123 }] } });
    add('M1-05', 'pretest side_effect_guards.message 型別錯＝規則壞→fail-open', () => runPre(PT, sh(pMsg, 'python -m pytest')), 'ALLOW');
  }
  {
    const r6 = mkRepo(CG, {}, { 'README.md': 'x\n' });
    fs.mkdirSync(path.join(r6, 'src'), { recursive: true });
    fs.writeFileSync(path.join(r6, 'src', 'new.py'), 'x = 1\n');
    add('M1-06', 'commit git add 新檔 && git commit <該檔>（pathspec 模式）→擋', () => runPre(QC, sh(r6, 'git add src/new.py && git commit -m x src/new.py')), 'DENY', (m) => /new\.py/.test(m));
    add('M1-06', 'commit 沒 add 的新檔 git commit <該檔>（git 會報錯、不會提交）→放行（對照）', () => runPre(QC, sh(r6, 'git commit -m x src/new.py')), 'ALLOW');
  }
  {
    const p7 = mkProj(CG);
    const A = path.join(p7, 'A');
    const B = path.join(p7, 'B');
    for (const d of [A, B]) {
      fs.mkdirSync(d, { recursive: true });
      git(d, ['init', '-q', '.']);
    }
    fs.writeFileSync(path.join(A, 'app.js'), 'x\n');
    fs.writeFileSync(path.join(B, 'README.md'), 'x\n');
    git(B, ['add', 'README.md']);
    add('M1-07', 'commit git -C A add . && git -C B commit（B 只有文件）→放行', () => runPre(QC, sh(p7, 'git -C A add . && git -C B commit -m x')), 'ALLOW');
    add('M1-07', 'commit git -C A add . && git -C A commit→擋（對照）', () => runPre(QC, sh(p7, 'git -C A add . && git -C A commit -m x')), 'DENY', (m) => /app\.js/.test(m));
  }
  {
    const r8 = mkRepo(CG, {}, { 'src/app.js': 'v1\n', 'README.md': 'v1\n' });
    fs.writeFileSync(path.join(r8, 'src', 'app.js'), 'v2\n');
    fs.writeFileSync(path.join(r8, 'README.md'), 'v2\n');
    git(r8, ['add', 'README.md']);
    add('M1-08', 'commit -mupdate（訊息黏寫含字母 a）不是 -a→只提交 staged 文件→放行', () => runPre(QC, sh(r8, 'git commit -mupdate')), 'ALLOW');
    add('M1-08', 'commit -am update（真的 -a）→擋（對照）', () => runPre(QC, sh(r8, 'git commit -am update')), 'DENY', (m) => /app\.js/.test(m));
    fs.writeFileSync(path.join(r8, 'list.txt'), 'src/app.js\n');
    add('M1-09', 'commit --pathspec-from-file=list.txt（清單含行為檔）→擋', () => runPre(QC, sh(r8, 'git commit -m x --pathspec-from-file=list.txt')), 'DENY', (m) => /app\.js/.test(m));
    add('M1-09', 'commit --pathspec-from-file -（清單來自 stdin）→無法判斷，要求表態', () => runPre(QC, sh(r8, 'git commit -m x --pathspec-from-file -')), 'DENY', (m) => /無法判斷/.test(m));
  }
  fs.mkdirSync(path.join(ro, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ro, 'assets', 'debug.png'), 'x');
  add('M1-10', 'report cp -r 目錄（內含過程檔）到交付資料夾→擋', () => runPre(RO, sh(ro, 'cp -r assets tests/reports/topic_20260924/')), 'DENY', (m) => /debug\.png/.test(m));
  add('M1-10', 'report cp -r 目錄到 _work→放行（對照）', () => runPre(RO, sh(ro, 'cp -r assets tests/reports/topic_20260924/_work/')), 'ALLOW');
  add('M1-11', 'report echo --junitxml=交付根層（只是輸出文字）→放行', () => runPre(RO, sh(ro, 'echo --junitxml=tests/reports/result.xml')), 'ALLOW');
  add('M1-11', 'report pytest --junitxml=交付根層→擋（對照）', () => runPre(RO, sh(ro, 'python -m pytest --junitxml=tests/reports/result.xml')), 'DENY');
  add('M1-12', 'report touch -r 交付檔（時間參照，唯讀）safe.txt→放行', () => runPre(RO, sh(ro, 'touch -r tests/reports/reference.png safe.txt')), 'ALLOW');
  add('M1-12', 'report touch 交付根層檔→擋（對照）', () => runPre(RO, sh(ro, 'touch tests/reports/reference.png')), 'DENY');
  {
    const r13 = mkProj({ report_hygiene: { roots: ['tests/../tests/reports'] } });
    add('M1-13', 'report roots 含 ..（tests/../tests/reports）仍納管→根層放檔擋', () => runPre(RO, w(r13, 'tests/reports/bad.xml')), 'DENY');
    const r14 = mkProj({ report_hygiene: { roots: ['out'], process_ext_regex: 123 } });
    add('M1-14', 'report process_ext_regex 型別錯（數字）→設定壞 fail-open', () => runPre(RO, w(r14, 'out/topic_1/a.png')), 'ALLOW');
    const r14b = mkProj({ report_hygiene: { roots: ['out'], work_dir: 5 } });
    add('M1-14', 'report work_dir 型別錯→設定壞 fail-open', () => runPre(RO, w(r14b, 'out/topic_1/a.png')), 'ALLOW');
  }
  {
    const ag = (cwd) => ({ cwd, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: '請測購物車' } });
    const d15 = mkProj({ dispatch_gate: { checks: ['target_env'], params: { target_env: { tag: null } } } });
    add('M1-15', 'dispatch 覆寫 tag 為 null（型別錯）→該項 fail-open', () => runPre(QD, ag(d15)), 'ALLOW');
    const d16 = mkProj({ dispatch_gate: { checks: ['triage'], params: { triage: { reuse_evidence_regex: '(' } } } });
    add('M1-16', 'dispatch triage reuse_evidence_regex 壞＋缺標籤→該項 fail-open', () => runPre(QD, ag(d16)), 'ALLOW');
    const d16b = mkProj({ dispatch_gate: { checks: ['triage'], params: { triage: { new_reason_regex: '[' } } } });
    add('M1-16', 'dispatch triage new_reason_regex 壞＋缺標籤→該項 fail-open', () => runPre(QD, ag(d16b)), 'ALLOW');
    const d16c = mkProj({ dispatch_gate: { checks: ['triage'] } });
    add('M1-16', 'dispatch triage 設定正常＋缺標籤→擋（對照）', () => runPre(QD, ag(d16c)), 'DENY');
  }
  {
    const pX = mkProj({ browser_guard: { rate_limits: [{ host_regex: 'slow\\.example\\.test$', max: 1, window_s: 172800 }] } });
    const pY = mkProj({ browser_guard: { rate_limits: [{ host_regex: '.*', max: 5, window_s: 60 }] } });
    const stf = path.join(root, 'm117.json');
    const key = path.resolve(pX) + '|0|slow\\.example\\.test$|slow.example.test';
    add('M1-17', 'nav 別專案（短視窗）的清理不得刪掉本專案長視窗內仍有效的紀錄', () => {
      fs.writeFileSync(stf, JSON.stringify({ [key]: [Date.now() - 25 * 3600 * 1000] }));
      const y = runPre(BN, nav(pY, 'https://other.example.test/'), { QA_WEBWRIGHT_NAV_STATE: stf });
      if (y.tag !== 'ALLOW') return { tag: 'Y-' + y.tag, msg: y.msg };
      return runPre(BN, nav(pX, 'https://slow.example.test/'), { QA_WEBWRIGHT_NAV_STATE: stf });
    }, 'DENY');
  }
  {
    const d = mkProj();
    const e2e = path.join(d, 'tests', 'e2e');
    fs.mkdirSync(path.join(e2e, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(e2e, 'orders'), { recursive: true });
    fs.writeFileSync(path.join(e2e, 'reports', 'x.xml'), '<testsuite/>\n');
    let linked = true;
    try {
      fs.symlinkSync(path.join(root, 'no-such-m118'), path.join(e2e, 'orders', 'test_orders.py'), 'junction');
    } catch (_) {
      linked = false;
    }
    add('M1-18', 'landing 子目錄內測試檔 stat 失敗（斷掉的連結）→不確定放行',
      () => (linked ? runStop(d, T) : { tag: 'ALLOW', msg: '（此平台無法建立連結，略過）' }), 'ALLOW');
  }

  // =====================================================================
  // R3 第 4 輪審查意見（CR4-xx＝B 軌）
  // =====================================================================
  {
    const r = mkRepo(CG, {}, { 'src/app.js': 'v1\n', 'README.md': 'v1\n' });
    fs.writeFileSync(path.join(r, 'src', 'app.js'), 'v2\n');
    fs.writeFileSync(path.join(r, 'README.md'), 'v2\n');
    git(r, ['add', 'README.md']);
    add('CR4-03', 'commit -uall（-u 黏寫值）不是 -a→只提交 staged 文件→放行', () => runPre(QC, sh(r, 'git commit -uall -m x')), 'ALLOW');
    add('CR4-03', 'commit -Sdeadbeef（-S 黏寫 keyid）不是 -a→放行', () => runPre(QC, sh(r, 'git commit -Sdeadbeef -m x')), 'ALLOW');
    add('CR4-03', 'commit -uno -a（真的 -a）→擋（對照）', () => runPre(QC, sh(r, 'git commit -uno -a -m x')), 'DENY', (m) => /app\.js/.test(m));
  }

  // =====================================================================
  // R3 第 14 輪審查意見（N1-xx＝hooks 批）
  // =====================================================================
  add('N1-01', 'pretest uv run python -m pytest→擋', () => runPre(PT, sh(pS, 'uv run python -m pytest tests')), 'DENY');
  add('N1-01', 'pretest poetry run pytest→擋', () => runPre(PT, sh(pS, 'poetry run pytest tests')), 'DENY');
  {
    const pReq = mkProj({ pretest: { alignment: [{ env: 'QA_REQ_FOR_N102', required: true }] } });
    add('N1-02', 'pretest export X=（空值）換行 pytest→X 是空的，required 擋', () => runPre(PT, sh(pReq, 'export QA_REQ_FOR_N102=\npytest tests')), 'DENY', (m) => /未設 QA_REQ_FOR_N102/.test(m));
    add('N1-02', 'pretest X=值 同行 pytest→放行（對照）', () => runPre(PT, sh(pReq, 'QA_REQ_FOR_N102=ok pytest tests')), 'ALLOW');
    const crReq = mkProj({ command_guards: [{ name: 'db', when_regex: 'sqlcmd', require_env: ['QA_DB_FOR_N102'] }] });
    add('N1-02', 'command export X=（空值）換行 sqlcmd→X 是空的，require_env 擋', () => runPre('guard-command-rules.js', sh(crReq, 'export QA_DB_FOR_N102=\nsqlcmd -Q x')), 'DENY');
    add('N1-02', 'command X=值 sqlcmd→放行（對照）', () => runPre('guard-command-rules.js', sh(crReq, 'QA_DB_FOR_N102=ok sqlcmd -Q x')), 'ALLOW');
  }
  fs.writeFileSync(path.join(pA, 'envm.sh'), 'ROOT="' + FR + '"\nBASE="$ROOT"\nexport I18N_DIR="$BASE/i18n"\n');
  add('N1-03', 'pretest source 檔內多層引用 ROOT→BASE→I18N_DIR 在底下→放行', () => runPre(PT, sh(pA, 'source ./envm.sh && ' + GOODT + 'FRONT_ROOT="' + FR + '" python -m pytest')), 'ALLOW');
  fs.mkdirSync(path.join(ro, 'assets2'), { recursive: true });
  fs.writeFileSync(path.join(ro, 'assets2', 'readme.docx'), 'x');
  add('N1-04', 'report rsync -a src/ 交付根/（來源尾斜線＝內容直接進目的地）→根層放檔擋', () => runPre(RO, sh(ro, 'rsync -a assets2/ tests/reports/')), 'DENY', (m) => /readme\.docx/.test(m));
  add('N1-04', 'report rsync -a src 交付資料夾/（無尾斜線＝整個資料夾）→放行（對照）', () => runPre(RO, sh(ro, 'rsync -a assets2 tests/reports/topic_20260924/')), 'ALLOW');
  add('N1-05', 'report --junitxml="$PWD/交付資料夾/run.xml"→展開 $PWD 後擋', () => runPre(RO, sh(ro, 'python -m pytest --junitxml="$PWD/tests/reports/topic_20260924/run.xml"')), 'DENY', (m) => /run\.xml/.test(m));
  {
    const d6 = mkProj({ dispatch_gate: { agent_regex: 5 } });
    add('N1-06', 'dispatch agent_regex 型別錯→設定壞 fail-open', () => runPre(QD, { cwd: d6, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: '請測購物車' } }), 'ALLOW');
  }
  add('N1-07', 'commit shell 路徑的拒絕訊息不得建議 git commit 不支援的 --qa 後綴', () => runPre(QC, sh(cBeh, 'git commit -m x')), 'DENY', (m) => !/後綴 --qa/.test(m) && /-m/.test(m));

  // =====================================================================
  // R3 第 15 輪審查意見（P1-xx＝hooks 批）
  // =====================================================================
  {
    const home = path.join(root, 'p115home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.qa.env'), 'export APP_TENANT=acme-prod-tenant-key-42\nexport FRONT_ROOT="' + FR + '"\nexport I18N_DIR="' + FR + '"\n');
    add('P1-01', 'pretest source ~/.qa.env（~ 展開）已載入正確值→放行', () => runPre(PT, sh(pA, 'source ~/.qa.env && python -m pytest'), { HOME: home, USERPROFILE: home }), 'ALLOW');
    add('P1-01', 'pretest source "$ENV_FILE"（變數展開）已載入正確值→放行', () => runPre(PT, sh(pA, 'ENV_FILE=./env.sh; source "$ENV_FILE" && ' + FRI + 'python -m pytest')), 'ALLOW');
    add('P1-01', 'pretest source "$UNSET_FILE"（展開不了）→無從判斷不擋', () => runPre(PT, sh(pA, 'source "$QA_UNSET_FILE_P101" && ' + FRI + 'python -m pytest')), 'ALLOW');
  }
  add('P1-02', 'pretest uv run --project app pytest→擋', () => runPre(PT, sh(pS, 'uv run --project app pytest tests')), 'DENY');
  {
    const dDs = mkProj({ dispatch_gate: { checks: ['data_source'] } });
    const ag = (prompt) => ({ cwd: dDs, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt } });
    add('P1-03', 'dispatch 選 b，理由裡提到 a 走真實流程→仍是明選 b→放行', () => runPre(QD, ag('【測試資料來源】選 b 自種自清，理由：a 走不到，該狀態只由上游推送 webhook 產生，證據：api/Webhook.cs:10')), 'ALLOW');
    add('P1-03', 'dispatch 照抄三選一選單→仍擋（對照）', () => runPre(QD, ag('【測試資料來源】三選一：a 走真實業務流程／b 自種自清／c 依賴既有資料')), 'DENY');
  }
  add('P1-04', 'report cp -r "$SRC"（變數指向含過程檔的目錄）到交付資料夾→擋', () => runPre(RO, sh(ro, 'SRC=assets; cp -r "$SRC" tests/reports/topic_20260924/')), 'DENY', (m) => /debug\.png/.test(m));
  add('P1-05', 'report 同指令先 mkdir 再 cp 過程檔進去→擋', () => runPre(RO, sh(ro, 'mkdir -p tests/reports/newtopic_p105 && cp shot.png tests/reports/newtopic_p105')), 'DENY', (m) => /shot\.png/.test(m));
  add('P1-06', "report rsync --exclude='*.png' 排除掉過程檔→放行", () => runPre(RO, sh(ro, "rsync -a --exclude='*.png' assets/ tests/reports/topic_20260924/")), 'ALLOW');
  add('P1-06', 'report rsync 沒排除→擋（對照）', () => runPre(RO, sh(ro, 'rsync -a assets/ tests/reports/topic_20260924/')), 'DENY');

  // =====================================================================
  // R3 第 16 輪審查意見（Q1-xx＝hooks 批）
  // =====================================================================
  {
    const crE = mkProj({ command_guards: [{ name: 'db', when_regex: 'sqlcmd', require_env: ['QA_ENVX_Q1'] }] });
    fs.writeFileSync(path.join(crE, 'cr.sh'), 'export QA_ENVX_Q1=ok\n');
    const CR = 'guard-command-rules.js';
    add('Q1-01', 'command source ./cr.sh 已設必要變數→放行', () => runPre(CR, sh(crE, 'source ./cr.sh && sqlcmd -Q x')), 'ALLOW');
    add('Q1-02', 'command X="$EMPTY"（EMPTY 明設為空）→X 是空的→擋', () => runPre(CR, sh(crE, 'QA_EMPTY_Q102=; QA_ENVX_Q1="$QA_EMPTY_Q102" sqlcmd -Q x')), 'DENY');
    add('Q1-02', 'command X="$OK"（OK 有值）→放行（對照）', () => runPre(CR, sh(crE, 'QA_OK_Q102=v; QA_ENVX_Q1="$QA_OK_Q102" sqlcmd -Q x')), 'ALLOW');
  }
  add('Q1-03', 'pretest I18N_DIR=$BASE 之後 BASE 改值→以賦值當下的 BASE 為準→放行', () => runPre(PT, sh(pA, 'BASE="' + FR + '"; I18N_DIR=$BASE; BASE="' + path.join(pA, 'backend') + '"; ' + GOODT + 'FRONT_ROOT="' + FR + '" python -m pytest')), 'ALLOW');
  add('Q1-04', 'pretest python -W ignore -m pytest→擋', () => runPre(PT, sh(pS, 'python -W ignore -m pytest tests')), 'DENY');
  {
    const dQ = mkProj({ dispatch_gate: { checks: ['data_source'] } });
    add('Q1-05', 'dispatch 逐行照抄 a／b／c 選單（多個都像明選）→未明選擋', () => runPre(QD, { cwd: dQ, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: '【測試資料來源】\na 走真實業務流程\nb 自種自清\nc 依賴既有資料（字典／設定類）' } }), 'DENY');
  }
  fs.mkdirSync(path.join(ro, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(ro, 'screenshots', 'a.png'), 'x');
  add('Q1-06', 'report cp screenshots/* 交付資料夾/（glob 展開）→擋', () => runPre(RO, sh(ro, 'cp screenshots/* tests/reports/topic_20260924/')), 'DENY', (m) => /a\.png/.test(m));
  fs.mkdirSync(path.join(ro, 'assets3', 'debug'), { recursive: true });
  fs.writeFileSync(path.join(ro, 'assets3', 'debug', 'x.png'), 'x');
  fs.writeFileSync(path.join(ro, 'assets3', 'report.docx'), 'x');
  add('Q1-07', 'report rsync --exclude debug（排除整個目錄）→放行', () => runPre(RO, sh(ro, 'rsync -a --exclude debug assets3/ tests/reports/topic_20260924/')), 'ALLOW');
  add('Q1-08', 'report PowerShell New-Item 目錄後 Copy-Item 過程檔進去→擋', () => runPre(RO, sh(ro, 'New-Item -ItemType Directory -Path tests/reports/newtopic_q108; Copy-Item shot.png tests/reports/newtopic_q108', 'PowerShell')), 'DENY', (m) => /shot\.png/.test(m)); // portable-ok: 合成 payload 字串，非呼叫系統指令
  add('Q1-09', 'commit git commit --dry-run（只預覽）→放行', () => runPre(QC, sh(cBeh, 'git commit --dry-run -m x')), 'ALLOW');

  // =====================================================================
  // R3 第 17 輪審查意見（R1-xx＝hooks 批）
  // =====================================================================
  fs.writeFileSync(path.join(pA, 'envs.sh'), 'BASE="' + FR + '"\nexport I18N_DIR="$BASE/i18n"\n');
  add('R1-01', 'pretest source 檔內 BASE→I18N_DIR 以檔內的 BASE 為準（指令前面另設 BASE 不影響）→放行', () => runPre(PT, sh(pA, 'BASE=/elsewhere; source ./envs.sh && ' + GOODT + 'FRONT_ROOT="' + FR + '" python -m pytest')), 'ALLOW');
  {
    const pM = mkProj({ pretest: { alignment: [{ env: 'QA_TOKEN_R102', matches: '^ab\\$HOME$' }] } });
    add('R1-02', 'pretest process env 的值含字面 $HOME 不得再展開→符合→放行', () => runPre(PT, sh(pM, 'python -m pytest'), { QA_TOKEN_R102: 'ab$HOME' }), 'ALLOW');
  }
  add('R1-03', 'pretest I18N_DIR="$BASE"/../backend（引號後接未加引號部分）→不在底下擋', () => runPre(PT, sh(pA, 'BASE="' + FR + '"; ' + GOODT + 'FRONT_ROOT="' + FR + '" I18N_DIR="$BASE"/../backend python -m pytest')), 'DENY', (m) => /I18N_DIR/.test(m));
  add('R1-04', 'commit git --git-dir a/b/.git（值分開寫）commit→無法判斷，要求表態', () => runPre(QC, sh(outer, 'git --git-dir a/b/.git --work-tree a/b commit -m x')), 'DENY', (m) => /無法判斷/.test(m));
  add('R1-05', 'commit git commit --amend --only（不帶 pathspec，只改訊息）→放行', () => runPre(QC, sh(cBeh, 'git commit --amend --only -m x')), 'ALLOW');
  add('R1-06', 'report 子殼層 (echo x > 交付根/a.xml)→擋', () => runPre(RO, sh(ro, '(echo x > tests/reports/a.xml)')), 'DENY', (m) => /a\.xml/.test(m));
  {
    const preload = path.join(root, 'as-darwin.cjs');
    fs.writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' });\n");
    const runDarwin = (payload) => {
      const r = spawnSync(process.execPath, ['-r', preload, path.join(HERE, RO)], { input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv() });
      const out = (r.stdout || '').trim();
      if (!out) return { tag: 'ALLOW', msg: '' };
      try {
        const h = JSON.parse(out).hookSpecificOutput || {};
        return { tag: h.permissionDecision === 'deny' ? 'DENY' : 'OTHER', msg: String(h.permissionDecisionReason || '') };
      } catch (_) {
        return { tag: 'BADJSON', msg: out };
      }
    };
    add('R1-07', 'report macOS cp -R src/ 交付根/（BSD：只複製內容）→根層放檔擋', () => runDarwin(sh(ro, 'cp -R assets2/ tests/reports/')), 'DENY', (m) => /readme\.docx/.test(m));
  }
  {
    const d = mkProj({ coverage: { placeholder: 'TODO_CASE' } });
    const e2e = path.join(d, 'tests', 'e2e');
    fs.mkdirSync(path.join(e2e, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(e2e, 'orders'), { recursive: true });
    fs.writeFileSync(path.join(e2e, 'reports', 'x.xml'), '<testsuite/>\n');
    fs.writeFileSync(path.join(e2e, 'orders', 'test_orders.py'), 'def test_a():\n    assert True\n');
    fs.writeFileSync(path.join(e2e, 'orders', 'COVERAGE.md'), '| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n| TODO_CASE | `test_orders.py::test_a` | ⚠️ |\n');
    add('R1-08', 'landing 佔位字含底線（TODO_CASE）的列不算登記→擋', () => runStop(d, T), 'BLOCK');
  }

  // =====================================================================
  // R3 第 18 輪 審查 Minor（B 軌）（CR18-xx）
  // =====================================================================
  add('CR18-03', 'report PowerShell 區域變數 $d = …; Copy-Item 過程檔 "$d/"→展開後擋', () => runPre(RO, sh(ro, '$d = "tests/reports/topic_20260924"; Copy-Item shot.png "$d/"', 'PowerShell')), 'DENY', (m) => /shot\.png/.test(m)); // portable-ok: 合成 payload 字串，非呼叫系統指令
  {
    const crB = mkProj({ command_guards: [{ name: 'db', when_regex: 'sqlcmd', require_env: ['QA_ENVX_CR18'] }] });
    add('CR18-04', 'command X=`cmd`（命令替換）＝值未知→不擋', () => runPre('guard-command-rules.js', sh(crB, 'QA_ENVX_CR18=`cat f` sqlcmd -Q x')), 'ALLOW');
    add('CR18-06', 'command find . $UNSET（不是 source）不得讓必要變數變成未知→沒設照擋', () => runPre('guard-command-rules.js', sh(crB, 'find . $QA_UNSET_CR18; sqlcmd -Q x')), 'DENY');
  }

  // =====================================================================
  // 預審（以 A 軌批次題目預審；S1-xx＝hooks 批）
  // =====================================================================
  {
    const pE = mkProj({ pretest: { alignment: [{ env: 'QA_BASE_URL_S1', required: true }] } });
    fs.writeFileSync(path.join(pE, '.env'), 'QA_BASE_URL_S1=http://localhost:3000\n');
    add('S1-01', 'pretest export $(cat .env | xargs)（值未知）→不擋', () => runPre(PT, sh(pE, 'export $(cat .env | xargs) && pytest')), 'ALLOW');
    add('S1-01', 'pretest 沒載入任何東西→required 照擋（對照）', () => runPre(PT, sh(pE, 'pytest')), 'DENY');
  }
  {
    const dS = mkProj({ dispatch_gate: { checks: ['data_source'] } });
    const ag = (p) => ({ cwd: dS, tool_name: 'Agent', tool_input: { subagent_type: 'qa-engineer', prompt: p } });
    add('S1-02', 'dispatch 選 b，理由：無法用 a…→仍是明選 b', () => runPre(QD, ag('【測試資料來源】選 b，理由：無法用 a 走真實流程（只由外部簽核回呼產生，證據：src/Callback.cs:5）')), 'ALLOW');
    add('S1-02', 'dispatch 選 c，理由：字典資料，不適用 b 自種→仍是明選 c', () => runPre(QD, ag('【測試資料來源】選 c，理由：字典資料，不適用 b 自種')), 'ALLOW');
    add('S1-02', 'dispatch 選 c：只讀國別字典，改用 b 會污染設定→仍是明選 c', () => runPre(QD, ag('【測試資料來源】選 c：只讀國別字典，改用 b 會污染設定')), 'ALLOW');
    // 最後一輪退步審查：雙字動詞（使用／採用／選用）前的否定也要擋，範本「理由：<為何 a 不可行>」正好引導這樣寫
    add('FR-D1', 'dispatch 選 b，理由：無法使用 a（沒有入口）→明選 b', () => runPre(QD, ag('【測試資料來源】選 b，理由：無法使用 a（上游系統推送，證據：api/Push.cs:3）')), 'ALLOW');
    add('FR-D1', 'dispatch 選 b，理由：不採用 a，因為上游推送→明選 b', () => runPre(QD, ag('【測試資料來源】選 b，理由：不採用 a，因為上游推送，證據：api/Push.cs:3')), 'ALLOW');
    add('FR-D1', 'dispatch b 自種自清，理由：無入口；不使用 a→明選 b', () => runPre(QD, ag('【測試資料來源】選 b 自種自清，理由：外部主檔 mock；不使用 a；證據：src/MockMaster.cs:9')), 'ALLOW');
    add('FR-D1', 'dispatch 選 c，理由：不選用 b→明選 c', () => runPre(QD, ag('【測試資料來源】選 c，理由：字典資料，不選用 b')), 'ALLOW');
    add('FR-D1', 'dispatch 照抄選單 a／b 兩行→仍擋（對照）', () => runPre(QD, ag('【測試資料來源】\n選 a\n選 b')), 'DENY');
  }
  fs.writeFileSync(path.join(cBeh, 'qamsg.txt'), '已QA：tests/e2e/x/test_x.py 3 passed\n');
  add('S1-03', 'commit git commit -F 訊息檔（檔內有 QA 表態）→放行', () => runPre(QC, sh(cBeh, 'git commit -F qamsg.txt')), 'ALLOW');
  add('S1-04', 'pretest coverage run -m pytest→擋', () => runPre(PT, sh(pS, 'coverage run -m pytest tests/e2e')), 'DENY');
  add('S1-04', 'pretest python -m coverage run -m pytest→擋', () => runPre(PT, sh(pS, 'python -m coverage run -m pytest tests/e2e')), 'DENY');
  add('S1-04', 'pretest xvfb-run -a pytest→擋', () => runPre(PT, sh(pS, 'xvfb-run -a pytest tests/e2e')), 'DENY');
  add('S1-04', 'pretest dotenv run -- pytest→擋', () => runPre(PT, sh(pS, 'dotenv run -- pytest tests/e2e')), 'DENY');
  add('S1-04', 'pretest py.test→擋', () => runPre(PT, sh(pS, 'py.test tests/e2e')), 'DENY');
  {
    const pN = mkProj({ browser_guard: { deny_hosts_regex: '^prod[.]example[.]com$' } });
    add('S1-05', 'nav 不帶 scheme 的 host:port→仍比對 host 擋', () => runPre(BN, nav(pN, 'prod.example.com:8443/login'), { QA_WEBWRIGHT_NAV_STATE: path.join(root, 's105.json') }), 'DENY');
  }
  {
    const pk = mkProj({ hook: { enabled: false } });
    fs.mkdirSync(path.join(pk, 'tests', 'Project_Detail'), { recursive: true });
    fs.writeFileSync(path.join(pk, 'tests', 'Project_Detail', 'PROJECT.md'), '# 專案\n');
    const tp = path.join(pk, 't.jsonl');
    fs.writeFileSync(tp, '{"type":"user","message":{"content":"hi"}}\n');
    const s = 's106x' + process.pid;
    add('S1-06', 'project-knowledge hook.enabled=false→靜默（未讀 PROJECT.md 也不擋）', () => {
      const r = runPre('project-knowledge-gate.js', { session_id: s, cwd: pk, transcript_path: tp, tool_name: 'mcp__playwright__browser_navigate', tool_input: { url: 'http://localhost' } });
      try { fs.unlinkSync(path.join(os.tmpdir(), 'qa-pk-gate-' + s)); } catch (_) {}
      return r;
    }, 'ALLOW');
  }
  add('S1-08', 'commit git -P commit（--no-pager 短寫）→擋', () => runPre(QC, sh(cBeh, 'git -P commit -m fix')), 'DENY');
  add('S1-09', 'report >| 強制覆寫重導到交付根→擋', () => runPre(RO, sh(ro, 'echo x >| tests/reports/a.xml')), 'DENY');
  add('S1-09', 'report curl -o 過程檔到交付資料夾→擋', () => runPre(RO, sh(ro, 'curl -o tests/reports/topic_20260924/a.png http://x')), 'DENY');
  add('S1-09', 'report wget -O 過程檔到交付資料夾→擋', () => runPre(RO, sh(ro, 'wget -O tests/reports/topic_20260924/a.png http://x')), 'DENY');
  add('S1-09', 'report PowerShell Start-Transcript -Path 交付資料夾 log→擋', () => runPre(RO, sh(ro, 'Start-Transcript -Path tests/reports/topic_20260924/t.log', 'PowerShell')), 'DENY'); // portable-ok: 合成 payload 字串，非呼叫系統指令

  // =====================================================================
  // R3 第 19 輪審查（B 軌，CR19-xx）
  // =====================================================================
  {
    const pD = mkProj({ pretest: { alignment: [{ env: 'QA_BASE_URL_D', required: true }] } });
    fs.writeFileSync(path.join(pD, '.env'), 'QA_BASE_URL_D=http://localhost:3000\n');
    fs.writeFileSync(path.join(pD, '.env.qa'), 'QA_BASE_URL_D=http://localhost:3001\n');
    add('CR19-01', 'pretest dotenv run -- pytest（.env 有設）→放行', () => runPre(PT, sh(pD, 'dotenv run -- pytest')), 'ALLOW');
    add('CR19-01', 'pretest dotenv -f .env.qa run -- pytest→放行', () => runPre(PT, sh(pD, 'dotenv -f .env.qa run -- pytest')), 'ALLOW');
    add('CR19-01', 'pretest dotenv run pytest→放行', () => runPre(PT, sh(pD, 'dotenv run pytest')), 'ALLOW');
    add('CR19-01', 'pretest dotenv -f 不存在的檔 run pytest→擋（對照）', () => runPre(PT, sh(pD, 'dotenv -f .env.none run -- pytest')), 'DENY');
    add('CR19-04', 'pretest eval "$(pyenv init -)" && pytest→仍擋（沒設變數）', () => runPre(PT, sh(pD, 'eval "$(pyenv init -)" && pytest')), 'DENY');
    add('CR19-04', 'pretest eval "$(conda shell.bash hook)" && conda activate qa && pytest→仍擋', () => runPre(PT, sh(pD, 'eval "$(conda shell.bash hook)" && conda activate qa && pytest')), 'DENY');
    add('CR19-04', 'pretest eval "$(direnv export bash)" && pytest→值未知不擋', () => runPre(PT, sh(pD, 'eval "$(direnv export bash)" && pytest')), 'ALLOW');
    add('CR19-06', 'pretest coverage run --rcfile .coveragerc -m pytest→擋', () => runPre(PT, sh(pD, 'coverage run --rcfile .coveragerc -m pytest')), 'DENY');
    add('CR19-07', 'pretest xvfb-run -s "-screen 0 1280x1024x24" pytest→擋', () => runPre(PT, sh(pD, 'xvfb-run -s "-screen 0 1280x1024x24" pytest')), 'DENY');
  }
  add('CR19-05', 'report curl -sSo 過程檔到交付資料夾→擋', () => runPre(RO, sh(ro, 'curl -sSo tests/reports/topic_20260924/a.png http://x')), 'DENY');
  add('CR19-05', 'report wget -qO 過程檔到交付資料夾→擋', () => runPre(RO, sh(ro, 'wget -qO tests/reports/topic_20260924/a.png http://x')), 'DENY');

  // ---- execute ----
  let pass = 0;
  let fail = 0;
  const failed = [];
  for (const [id, name, fn, expected, check] of cases) {
    if (filters && filters.length && !filters.some((f) => id.startsWith(f))) continue;
    let r;
    try {
      r = fn();
    } catch (e) {
      r = { tag: 'THROW', msg: String(e && e.stack || e) };
    }
    const extraOk = check ? check(String(r.msg || '')) : true;
    if (r.tag === expected && extraOk) {
      pass++;
      console.log('  ✓ [' + id + '] ' + name + ' → ' + r.tag);
    } else {
      fail++;
      failed.push(id);
      console.log('  ✗ [' + id + '] ' + name + ' → 期望 ' + expected + (check ? '＋訊息斷言' : '') + '，實際 ' + r.tag + (extraOk ? '' : '（訊息斷言不符）'));
      console.log('     ' + String(r.msg).split('\n').slice(0, 10).join('\n     '));
    }
  }
  return { pass, fail, failed };
}

// 單獨執行
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-gate-fix-'));
  const r = runFixCases(TMP, process.argv.slice(2));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed' + (r.failed.length ? '（' + Array.from(new Set(r.failed)).join(' ') + '）' : ''));
  process.exit(r.fail === 0 ? 0 : 1);
}
