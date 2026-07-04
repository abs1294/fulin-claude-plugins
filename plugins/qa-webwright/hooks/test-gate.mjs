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
const READ_SKILL = tool('Read', { file_path: 'C:/x/skills/browser-qa/SKILL.md' });
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

// ---- 真實語料（若可讀；cwd 指向合成 fixture 控制落地狀態）----
// 路徑是本機特定 transcript，換機必失效——故 existsSync 不存在即 skip（見下方迴圈），
// 只是該筆覆蓋率靜默下降、非錯誤。可用環境變數 QA_GATE_REAL_TRANSCRIPT 覆蓋成你本機的
// 語料路徑，讓回歸測試在別台機器也能跑到這筆真實情境。
const REAL = [
  // 4137a1c6：走了 qa-flow 但漏 catalog → 對 nocat 期望 BLOCK
  {
    file: process.env.QA_GATE_REAL_TRANSCRIPT
      || 'C:/Users/User/.claude/projects/C--Users-User-Claude-PlayForGood-AI-Platform/4137a1c6-39c0-48f0-a13e-e3995dab1b55.jsonl',
    cwd: nocat,
    expected: 'BLOCK',
    name: '真實語料 4137a1c6（跑qa-flow漏catalog）',
  },
];
for (const r of REAL) {
  if (fs.existsSync(r.file)) cases.push([r.name, r.cwd, r.file, r.expected]);
  else console.log(`（略過真實語料，檔不存在：${path.basename(r.file)}）`);
}

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

// ---- cleanup ----
for (const sid of usedSids) {
  try {
    fs.unlinkSync(path.join(os.tmpdir(), `qa-landing-gate-${sid}.count`));
  } catch (_) {}
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
