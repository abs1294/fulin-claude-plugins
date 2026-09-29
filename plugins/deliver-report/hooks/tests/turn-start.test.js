#!/usr/bin/env node
/**
 * 回合起點判斷的回歸測試（isUserPromptLine）
 *
 * 由來：Skill 工具叫起 skill 後，transcript 在 Skill 呼叫之後會寫一行 isMeta:true 的 skill 內容注入
 * （type=user、有 promptId、沒有 toolUseResult）。舊版 isUserPromptLine() 沒排除 isMeta，這行被當成
 * 回合起點，Skill 呼叫落在起點之前——doc-readability-gate 在真實使用中第一次就放行（實測：照真實順序
 * 的 transcript＋有缺陷的 docx → 放行；拿掉 isMeta 行 → 擋）。既有測試都用手寫 transcript，沒有這一行，
 * 所以從沒抓到。
 *
 * 守兩件事：
 *   1. 每支用同一套回合切割的 hook，isUserPromptLine() 都排除 isMeta（逐支抽出函式執行）
 *   2. doc-readability-gate 端到端：真實行順序（Skill 呼叫 → 工具回傳 → isMeta 注入）要擋；
 *      斜線指令叫 skill（沒有 Skill tool_use）也要擋
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const H = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (desc, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc + (detail ? '：' + detail : '')); }
};

// ---- 1. 逐支抽出 isUserPromptLine() 執行 ----
const FILES = ['doc-readability-gate.js', 'daily-report-chain-gate.js', 'gmail-draft-link-gate.js',
  'visual-view-gate.js', 'lib/draft-checks.core.js'];
const userLine = { type: 'user', promptId: 'p1', message: { role: 'user', content: '幫我交付' } };
const metaSkill = { type: 'user', promptId: 'p1', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: …' }] } };
const metaStop = { type: 'user', promptId: 'p1', isMeta: true, message: { role: 'user', content: 'Stop hook feedback: …' } };
const toolResult = { type: 'user', promptId: 'p1', toolUseResult: null, message: { role: 'user', content: [] } };
for (const f of FILES) {
  const src = fs.readFileSync(path.join(H, f), 'utf8');
  const m = src.match(/function isUserPromptLine\(o\) \{[\s\S]*?\n\}/);
  if (!m) { check(`${f} 找得到 isUserPromptLine()`, false); continue; }
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${m[0]}; return isUserPromptLine;`)();
  check(`${f}：真正的使用者輸入是起點`, fn(userLine) === true);
  check(`${f}：skill 內容注入（isMeta）不是起點`, fn(metaSkill) === false);
  check(`${f}：Stop hook feedback（isMeta）不是起點`, fn(metaStop) === false);
  check(`${f}：工具回傳不是起點`, fn(toolResult) === false);
}

// ---- 2. doc-readability-gate 端到端 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turnstart-'));
execFileSync('python', ['-c', [
  'import docx, sys',
  'd = docx.Document(); d.add_heading("測試文件", 1)',
  '[d.add_paragraph(f"第{i}段內容。") for i in range(22)]',
  'd.add_paragraph("本次查核發現 §3 要調整。")',
  'd.save(sys.argv[1])',
].join('\n'), path.join(tmp, 'sample.docx')]);
const run = (lines) => {
  const tp = path.join(tmp, 'tr.jsonl');
  fs.writeFileSync(tp, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const out = execFileSync('node', [path.join(H, 'doc-readability-gate.js')],
    { input: JSON.stringify({ cwd: tmp, transcript_path: tp }) }).toString();
  try { return JSON.parse(out).decision || 'warn'; } catch (_) { return 'allow'; }
};
const skillCall = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'deliver-report:deliver-report' } }] } };
const skillResult = { type: 'user', promptId: 'p1', toolUseResult: { success: true }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Launching skill' }] } };
const reply = { type: 'assistant', message: { content: [{ type: 'text', text: '交付訊息如下' }] } };
check('真實順序（Skill 呼叫 → 工具回傳 → isMeta 注入）會擋', run([userLine, skillCall, skillResult, metaSkill, reply]) === 'block');
check('Stop hook 擋過一次後（多一行 isMeta feedback）仍會擋', run([userLine, skillCall, skillResult, metaSkill, reply, metaStop, reply]) === 'block');
const slash = (name) => ({ type: 'user', promptId: 'p2', message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>sample.docx</command-args>` } });
check('斜線指令叫受閘的 skill（沒有 Skill tool_use）也會擋', run([slash('deliver-report:deliver-report'), metaSkill, reply]) === 'block');
check('斜線指令叫 to-checklist 也會擋', run([slash('deliver-report:to-checklist'), metaSkill, reply]) === 'block');
check('斜線指令叫不受閘的 check-before 放行（它自己就跑檢查）', run([slash('deliver-report:check-before'), metaSkill, reply]) === 'allow');
const other = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Skill', input: { skill: 'plugin-manager:plugin-manager-update' } }] } };
check('沒有叫 deliver-report 系 skill 時放行', run([userLine, other, skillResult, metaSkill, reply]) === 'allow');
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
