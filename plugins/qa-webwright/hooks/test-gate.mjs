#!/usr/bin/env node
/**
 * test-gate.mjs — qa-landing-gate.js 的回歸測試（開發期，不進 plugin 執行路徑）。
 *
 * 目的（源自 agent-guardrail 研究 open question）：像評估分類器那樣，拿合成 + 真實
 * 語料測 hook 的 false-positive / false-negative，改 hook 後跑一次確認沒退化。
 *
 * 用法：node hooks/test-gate.mjs
 * 全部通過 → exit 0；任一 case 不符期望 → 印差異 + exit 1。
 *
 * 每個 case 用唯一 session_id（避免共用計數互相污染）；跑完清 tmp 計數檔。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreToolCases } from './test-gate-pretool.mjs';
import { runFixCases } from './test-gate-fixes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'qa-landing-gate.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-gate-test-'));

let sidCounter = 0;
const usedSids = [];

// ---- fixture builders ----

function mkProj(kind) {
  // kind: 'landed' | 'nocat'（缺 catalog 資料列）| 'noe2e'（整個沒 tests/e2e）
  const dir = fs.mkdtempSync(path.join(TMP, `proj-${kind}-`));
  if (kind === 'noe2e') return dir;
  const e2e = path.join(dir, 'tests', 'e2e');
  fs.mkdirSync(path.join(e2e, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(e2e, 'test_x.py'), 'def test_x():\n    assert True\n');
  fs.writeFileSync(path.join(e2e, 'reports', 'x.xml'), '<testsuite/>\n');
  const header = '| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |\n|------|------|------|------|\n';
  const row = kind === 'landed' ? '| 登入 | test_x | ✅完整 | 帳號 |\n' : '';
  fs.writeFileSync(path.join(e2e, 'catalog.md'), header + row);
  return dir;
}

// 寫一個 JSONL transcript；lines = 陣列，每項是要序列化的物件
function mkTranscript(name, lines) {
  const f = path.join(TMP, `${name}.jsonl`);
  fs.writeFileSync(f, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return f;
}

// tool_use assistant 行
function tool(name, input = {}) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } };
}
function text(t) {
  return { type: 'assistant', message: { content: [{ type: 'text', text: t }] } };
}

const BROWSER = tool('mcp__playwright__browser_click');
const QAFLOW_RUN = tool('Bash', { command: 'bash "/x/qa-flow.sh" run smoke tests/e2e/test_x.py' });
const READ_SKILL = tool('Read', { file_path: 'C:/x/skills/browser-qa/SKILL.md' }); // portable-ok: 合成 transcript 內容字串（驗比對邏輯），非執行路徑
const QA_ENGINEER = tool('Agent', { subagent_type: 'qa-engineer', prompt: 'design' });

// 主檔 + subagents/ 子檔（委派情境）
function mkTranscriptWithSub(name, mainLines, subLines) {
  const f = mkTranscript(name, mainLines);
  const subDir = path.join(TMP, name, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, 'agent-x.jsonl'),
    subLines.map((o) => JSON.stringify(o)).join('\n') + '\n'
  );
  return f;
}

// ---- runner ----

function runHook(cwd, transcriptPath) {
  const sid = `test${sidCounter++}`;
  usedSids.push(sid);
  const stdin = JSON.stringify({ session_id: sid, cwd, transcript_path: transcriptPath });
  const r = spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (out === '') return 'ALLOW';
  try {
    const j = JSON.parse(out);
    if (j.decision === 'block') return 'BLOCK';
    if (j.hookSpecificOutput) return 'WARN';
    return 'ALLOW';
  } catch (_) {
    return `BAD(${out.slice(0, 40)})`;
  }
}

// ---- cases ----

const landed = mkProj('landed');
const nocat = mkProj('nocat');
const noe2e = mkProj('noe2e');

const cases = [
  // [名稱, cwd, transcript, 期望]
  ['觸發qa(讀SKILL)+browser+無落地', nocat, mkTranscript('t1', [READ_SKILL, BROWSER]), 'BLOCK'],
  ['觸發qa(叫qa-engineer)+browser+無落地', nocat, mkTranscript('t2', [QA_ENGINEER, BROWSER]), 'BLOCK'],
  ['跑qa-flow+browser+無落地', nocat, mkTranscript('t3', [QAFLOW_RUN, BROWSER]), 'BLOCK'],
  ['有落地→放行', landed, mkTranscript('t4', [QAFLOW_RUN, BROWSER]), 'ALLOW'],
  ['browser但沒觸發qa→警告', nocat, mkTranscript('t5', [BROWSER]), 'WARN'],
  ['整個沒tests/e2e+觸發qa+browser', noe2e, mkTranscript('t6', [READ_SKILL, BROWSER]), 'BLOCK'],
  ['純文字提工具名/SKILL→放行(不誤判)', nocat, mkTranscript('t7', [text('用了 mcp__playwright__browser_click 讀了 browser-qa/SKILL.md 跑了 qa-flow.sh run')]), 'ALLOW'],
  ['沒用browser→放行', nocat, mkTranscript('t8', [QAFLOW_RUN]), 'ALLOW'],
  ['echo提及qa-flow→WARN(非觸發)', nocat, mkTranscript('t9', [tool('Bash', { command: 'echo qa-flow.sh run' }), BROWSER]), 'WARN'],
  // 委派情境（T8）：主檔只有 Agent、browser 在 subagent 檔
  ['委派：browser在subagent+無落地', nocat, mkTranscriptWithSub('t10', [tool('Agent', { subagent_type: 'general-purpose' })], [BROWSER, QAFLOW_RUN]), 'BLOCK'],
  ['委派：browser在subagent+有落地', landed, mkTranscriptWithSub('t11', [tool('Agent', { subagent_type: 'general-purpose' })], [BROWSER, QAFLOW_RUN]), 'ALLOW'],
  // fail-open
  ['transcript不存在→放行', nocat, path.join(TMP, 'nope.jsonl'), 'ALLOW'],
  ['cwd不存在→放行', path.join(TMP, 'nope-dir'), mkTranscript('t12', [READ_SKILL, BROWSER]), 'ALLOW'],
];

// ---- 真實語料（選用；cwd 指向合成 fixture 控制落地狀態）----
// 真實 transcript 是本機檔案、內含其他專案資訊，不寫死路徑進 plugin：
// 用環境變數 QA_GATE_REAL_TRANSCRIPT 指向一份「跑了 qa-flow 但漏登記」的 transcript，
// 就會多跑這筆真實情境（期望 BLOCK）；沒設就略過。
const REAL = [];
if (process.env.QA_GATE_REAL_TRANSCRIPT) {
  REAL.push({ file: process.env.QA_GATE_REAL_TRANSCRIPT, cwd: nocat, expected: 'BLOCK', name: '真實語料（跑qa-flow漏登記）' });
}
for (const r of REAL) {
  if (fs.existsSync(r.file)) cases.push([r.name, r.cwd, r.file, r.expected]);
  else console.log(`（略過真實語料，檔不存在：${path.basename(r.file)}）`);
}
if (!REAL.length) console.log('（略過真實語料：未設 QA_GATE_REAL_TRANSCRIPT）');

// ---- 0.9.0 三層登記：落地判定要認子目錄測試 + COVERAGE.md 資料列 ----
function mkThreeLayer(kind) {
  // kind: 'three'（子目錄測試 + COVERAGE 有資料列）| 'three-empty'（COVERAGE 只有骨架，另有生成的 CATALOG）
  //       | 'upper'（legacy 但檔名是大寫 CATALOG.md）
  const dir = fs.mkdtempSync(path.join(TMP, `proj-${kind}-`));
  const e2e = path.join(dir, 'tests', 'e2e');
  fs.mkdirSync(path.join(e2e, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(e2e, 'reports', 'x.xml'), '<testsuite/>\n');
  if (kind === 'upper') {
    fs.writeFileSync(path.join(e2e, 'test_x.py'), 'def test_x():\n    assert True\n');
    fs.writeFileSync(path.join(e2e, 'CATALOG.md'),
      '| 白話業務情境 | 對應測試函式 | 覆蓋狀態 | 業務模組分類 |\n|------|------|------|------|\n| 登入 | test_x | ✅完整 | 帳號 |\n');
    return dir;
  }
  fs.mkdirSync(path.join(e2e, 'orders'), { recursive: true });
  fs.writeFileSync(path.join(e2e, 'orders', 'test_orders.py'), 'def test_x():\n    assert True\n');
  const head = '# orders/ 情境覆蓋\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n';
  const row = kind === 'three' ? '| 建立訂單 | `test_orders.py::test_x` | ✅ |\n' : '';
  fs.writeFileSync(path.join(e2e, 'orders', 'COVERAGE.md'), head + row + '\n## 🔒 鎖定 bug\n\n| 情境 | 位置 | 狀態 |\n|---|---|---|\n');
  fs.writeFileSync(path.join(e2e, 'CATALOG.md'),
    '> ⚠️ **本檔由 `tools/gen_catalog.py` 生成，手動修改會在下次生成時被覆蓋。**\n\n| 資料夾 | 說明 |\n|---|---|\n| `orders/` | x |\n');
  return dir;
}
cases.push(
  ['三層：子目錄測試+COVERAGE有列→放行', mkThreeLayer('three'), mkTranscript('t20', [QAFLOW_RUN, BROWSER]), 'ALLOW'],
  ['三層：COVERAGE只有骨架(生成CATALOG不算登記)→擋', mkThreeLayer('three-empty'), mkTranscript('t21', [QAFLOW_RUN, BROWSER]), 'BLOCK'],
  ['legacy：大寫 CATALOG.md 有列→放行', mkThreeLayer('upper'), mkTranscript('t22', [QAFLOW_RUN, BROWSER]), 'ALLOW'],
);

// ---- execute ----

let pass = 0;
let fail = 0;
for (const [name, cwd, tp, expected] of cases) {
  const got = runHook(cwd, tp);
  if (got === expected) {
    pass++;
    console.log(`  ✓ ${name} → ${got}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} → 期望 ${expected}，實際 ${got}`);
  }
}

// ---- guard-test-asset-hygiene.js（PostToolUse 寫測試碼當下跑閘）----
// 需要 python 才能跑工具；找不到 python 時這組案例全部記為失敗（不靜默略過）。
const HYG = path.join(HERE, 'guard-test-asset-hygiene.js');
const INSTALLER = path.join(HERE, '..', 'skills', 'browser-qa', 'lib', 'install_tools.py');

function pickPy() {
  const cands = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of cands) {
    const r = spawnSync(c, ['-c', 'import sys'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}
const PY = pickPy();

function mkHygieneProj(withConfig) {
  const dir = fs.mkdtempSync(path.join(TMP, `hyg-${withConfig ? 'cfg' : 'nocfg'}-`));
  const e2e = path.join(dir, 'tests', 'e2e');
  fs.mkdirSync(path.join(e2e, 'orders'), { recursive: true });
  if (PY) {
    spawnSync(PY, [INSTALLER, 'install', e2e], { encoding: 'utf8' });
  }
  if (!withConfig) {
    try { fs.unlinkSync(path.join(e2e, 'qa-webwright.json')); } catch (_) {}
  } else {
    const cfgPath = path.join(e2e, 'qa-webwright.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.biz_tables = ['orders'];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
  }
  fs.writeFileSync(path.join(e2e, 'orders', 'COVERAGE.md'),
    '# orders/ 情境覆蓋\n\n| 使用情境（白話） | 測試函式 | 覆蓋 |\n|---|---|---|\n' +
    '| 建立訂單後列表看得到 | `test_orders.py::test_create` | ✅ |\n');
  fs.writeFileSync(path.join(e2e, 'orders', 'test_orders.py'), 'def test_create():\n    assert True\n');
  return e2e;
}

function runHyg(e2e, relFile, content, toolName = 'Write', rawStdin = null) {
  const abs = path.join(e2e, ...relFile.split('/'));
  if (content !== null) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const stdin = rawStdin !== null ? rawStdin : JSON.stringify({
    session_id: `hyg${sidCounter++}`, tool_name: toolName, cwd: path.dirname(path.dirname(e2e)),
    tool_input: { file_path: abs },
  });
  const r = spawnSync('node', [HYG], { input: stdin, encoding: 'utf8', timeout: 170000 });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  if (r.status === 0 && out === '' && err === '') return { tag: 'SILENT', err };
  if (r.status === 2) return { tag: 'BLOCK2', err };
  if (r.status === 0 && out !== '') return { tag: 'NOTE', err: out };
  return { tag: `OTHER(${r.status})`, err: err || out };
}

const nocfg = mkHygieneProj(false);
const withcfg = mkHygieneProj(true);
const brokenTool = mkHygieneProj(true);
fs.writeFileSync(path.join(brokenTool, 'tools', 'hardcode_check.py'), 'raise SystemExit(5)\n');
fs.writeFileSync(path.join(brokenTool, 'tools', 'drift_check.py'), 'raise RuntimeError("boom")\n');
fs.writeFileSync(path.join(brokenTool, 'tools', 'skip_audit.py'), 'import sys\nsys.exit(1)\n');
// 專案自有同名工具（首行無 qa-webwright 版本標記）：hook 不得代跑。
// 工具被跑到就會寫出 ran.marker——用它證明「沒被執行」，而不只是「沒擋」。
const foreignTools = mkHygieneProj(true);
for (const t of ['hardcode_check.py', 'drift_check.py', 'skip_audit.py', 'i18n_locator_check.py']) {
  fs.writeFileSync(path.join(foreignTools, 'tools', t),
    '# 專案自有工具\nimport sys\nopen("ran.marker", "a").close()\nprint("QA-TOOL-RESULT: violations")\nsys.exit(1)\n');
}

const HARD = 'ORDER_ID = 1133\n\ndef test_create():\n    assert ORDER_ID\n';
const ORPHAN = 'def test_create():\n    assert True\n\ndef test_unregistered():\n    assert True\n';
const ASKIP = 'import pytest\n\ndef test_create():\n    pytest.skip("no data available")\n';
const I18N = 'def test_create(page):\n    page.get_by_text("送出").click()\n';
const hygCases = [
  // [名稱, e2e, 檔, 內容, 期望, 額外斷言(err)=>bool, toolName, rawStdin]
  ['hyg 無參數檔+違規碼→完全靜默', nocfg, 'orders/test_orders.py', HARD, 'SILENT'],
  ['hyg 有參數檔+合規碼→靜默', withcfg, 'orders/test_orders.py', 'def test_create():\n    assert True\n', 'SILENT'],
  ['hyg 有參數檔+A類寫死Id→exit2', withcfg, 'orders/test_orders.py', HARD, 'BLOCK2',
    (e) => /ORDER_ID/.test(e)],
  ['hyg 阻擋訊息的重產指令帶 --why（缺陷3）', withcfg, 'orders/test_orders.py', HARD, 'BLOCK2',
    (e) => /--write-baseline --why "/.test(e) && !/--write-baseline(?! --why)/.test(e)],
  ['hyg 阻擋訊息列出刻意值前綴含 BAD（缺陷2 同源）', withcfg, 'orders/test_orders.py', HARD, 'BLOCK2',
    (e) => /BAD_\*/.test(e)],
  ['hyg 刻意值命名 BAD_ORDER_ID→放行', withcfg, 'orders/test_orders.py',
    'BAD_ORDER_ID = 999\n\ndef test_create():\n    assert BAD_ORDER_ID\n', 'SILENT'],
  ['hyg 有參數檔+孤兒測試→exit2(drift)', withcfg, 'orders/test_orders.py', ORPHAN, 'BLOCK2',
    (e) => /orphan/.test(e) && /test_unregistered/.test(e)],
  ['hyg 有參數檔+A類執行期skip→exit2', withcfg, 'orders/test_orders.py', ASKIP, 'BLOCK2',
    (e) => /\[A\]/.test(e)],
  ['hyg 收集期skipif(理由像A類)→放行', withcfg, 'orders/test_orders.py',
    'import pytest\n\n@pytest.mark.skipif(True, reason="no data available")\ndef test_create():\n    assert True\n', 'SILENT'],
  ['hyg tools/ 底下的檔→靜默', withcfg, 'tools/extra_tool.py', HARD, 'SILENT'],
  ['hyg 非 .py→靜默', withcfg, 'orders/notes.md', 'ORDER_ID = 1\n', 'SILENT'],
  ['hyg Read 工具→靜默', withcfg, 'orders/test_orders.py', null, 'SILENT', null, 'Read'],
  ['hyg stdin 非 JSON→fail-open', withcfg, 'orders/test_orders.py', null, 'SILENT', null, 'Write', 'not json'],
  ['hyg 工具自身崩潰→fail-open', brokenTool, 'orders/test_orders.py', HARD, 'SILENT'],
  ['hyg 專案自有同名工具(無版本標記)→不代跑、靜默', foreignTools, 'orders/test_orders.py', HARD, 'SILENT',
    () => !fs.existsSync(path.join(foreignTools, 'ran.marker'))],
  ['hyg hook.enabled=false→靜默', null, 'orders/test_orders.py', HARD, 'SILENT'],
  ['hyg 中文定位器+i18n.hook_gate 預設關→放行', withcfg, 'orders/test_orders.py', I18N, 'SILENT'],
  ['hyg 中文定位器+i18n.hook_gate=true→exit2', 'I18N_ON', 'orders/test_orders.py', I18N, 'BLOCK2',
    (e) => /顯示文字定位器/.test(e)],
];
// i18n.hook_gate=true 的專案
{
  const on = mkHygieneProj(true);
  const cfgPath = path.join(on, 'qa-webwright.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.i18n = Object.assign({}, cfg.i18n, { hook_gate: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  for (const c of hygCases) if (c[1] === 'I18N_ON') c[1] = on;
}
// hook.enabled=false 的專案
{
  const off = mkHygieneProj(true);
  const cfgPath = path.join(off, 'qa-webwright.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.hook = { enabled: false };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  for (const c of hygCases) if (/hook\.enabled=false/.test(c[0])) c[1] = off;
}

for (const [name, e2e, rel, content, expected, check, toolName, raw] of hygCases) {
  if (!PY) {
    fail++;
    console.log(`  ✗ ${name} → 找不到 python，無法驗證`);
    continue;
  }
  const r = runHyg(e2e, rel, content, toolName || 'Write', raw === undefined ? null : raw);
  const extraOk = check ? check(r.err) : true;
  if (r.tag === expected && extraOk) {
    pass++;
    console.log(`  ✓ ${name} → ${r.tag}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} → 期望 ${expected}${check ? '＋訊息斷言' : ''}，實際 ${r.tag}${extraOk ? '' : '（訊息斷言不符）'}`);
    console.log('     ' + String(r.err).split('\n').slice(0, 12).join('\n     '));
  }
}

// ---- 六支 PreToolUse 閘（guard-qa-dispatch / guard-qa-before-commit / guard-pretest-env /
//      guard-command-rules / guard-report-output / guard-browser-nav）----
{
  console.log('\n  —— PreToolUse 閘 ——');
  const r = runPreToolCases(TMP);
  pass += r.pass;
  fail += r.fail;
}

// ---- 送審修正的回歸案例（每案例帶審查 ID）----
{
  console.log('\n  —— 送審修正回歸（test-gate-fixes.mjs）——');
  const r = runFixCases(TMP);
  pass += r.pass;
  fail += r.fail;
}

// ---- cleanup ----
for (const sid of usedSids) {
  try {
    fs.unlinkSync(path.join(os.tmpdir(), `qa-landing-gate-${sid}.count`));
  } catch (_) {}
}
for (let i = 0; i < sidCounter; i++) {
  try {
    fs.unlinkSync(path.join(os.tmpdir(), `qa-hygiene-ref-hyg${i}.count`));
  } catch (_) {}
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
