#!/usr/bin/env node
// 知識沉澱四題閘（詞／鏈／QA／代號）。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治。
//
// ═══ 綁哪個時機（init 依 Phase 0／Phase 3 Q5 決定，改下方 TRIGGER_MODE）═══
//   'skill'：目標專案有裝 git-commit plugin → 綁 PreToolUse、matcher "Skill"、只攔 skill === 'git-commit'。
//            commit 是「一輪工作收尾」的天然時機，表態寫在 git-commit 的 args 裡。
//     接線："PreToolUse": [{ "matcher": "Skill", "hooks": [{ "type": "command",
//             "command": "node \"<專案絕對路徑>/.claude/hooks/guard-sediment-sweep.js\"", "timeout": 10 }] }]
//   'stop' ：沒裝 git-commit、或目標不是 git repo → 綁 Stop hook。本回合有改檔（Write／Edit 類工具）時，
//            結束前要求回覆正文出現一行四題表態；本回合沒改檔不擋。
//     接線："Stop": [{ "hooks": [{ "type": "command",
//             "command": "node \"<專案絕對路徑>/.claude/hooks/guard-sediment-sweep.js\"", "timeout": 10 }] }]
//
// ═══ 為什麼是「args 表態制」不是「marker 制」（本段是這支 hook 的設計核心，改之前先讀）═══
//   早期版本用 marker 制：被擋 → 答題 → 自己建一個 marker 檔 → 重呼叫放行。實測失效：
//   hook 上線後 17 個 session 用過 git-commit（共 40 次呼叫），只有 8 個留下 marker，9 個直接往下跑。
//   逐一查證，失效模式是「答完題（甚至沒答）就直接往下跑，建 marker 那步靠自覺、沒人做」——
//   有的被擋後逐題答「無」、13 秒後直接進 commit 流程、marker 沒建；有的被擋後下一則就開始 stage，四題一字未答。
//   marker 制的根本缺陷：**放行條件（建檔）與答題行為脫鉤**——模型可以跳過答題只建檔，也可以答了題不建檔。
//   改法：放行條件綁在「把四題答案寫進 args（或回覆正文）」本身：
//     - 答案同時進 transcript，使用者當場看得到、可否決；
//     - 答「無」零成本，**漏答才是要擋的行為**；
//     - hook **只驗有沒有表態，不判內容對錯**（判對錯需要語意理解，硬做會退化成關鍵字檢查，給假保證比沒有更糟）。
//   skill 模式下表態通過後會建一個 session marker，只當「同 session 後續 commit 不再重問」的快取——
//   marker 由 hook 自己在表態通過後建立，不是放行條件本身。
//
// fail-open：hook 故障時放行但 loud 印錯，不得變成擋路石。

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── init 填空區 ──────────────────────────────────────────────────────────────
const TRIGGER_MODE = 'skill'; // 'skill' | 'stop'
// 三個知識容器的路徑（相對於專案根；訊息用）。落點改了就同步改這裡。
const CONTEXT_PATH = 'CONTEXT.md';
const FLOWS_PATH = 'FLOWS.md';
const QA_KNOWLEDGE_PATH = 'tests/Project_Detail/PROJECT.md';
// 本專案的正式代號舉例（第 4 題訊息用；讓模型分得出「正式代號」與「自創代號」）。沒有就留空字串。
const OFFICIAL_CODE_EXAMPLES = '';
// ────────────────────────────────────────────────────────────────────────────

const KEYS = ['詞', '鏈', 'QA', '代號'];
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// 在一段文字裡找四題表態，回傳缺哪幾題。形狀：詞=<答案> 鏈=<答案> QA=<答案> 代號=<答案>
function missingAnswers(text) {
  const s = String(text || '');
  const re = {
    詞: /詞\s*[=＝:：]\s*([^\s，,；;]+)/,
    鏈: /鏈\s*[=＝:：]\s*([^\s，,；;]+)/,
    QA: /QA\s*[=＝:：]\s*([^\s，,；;]+)/,
    代號: /代號\s*[=＝:：]\s*([^\s，,；;]+)/,
  };
  return KEYS.filter((k) => !re[k].test(s));
}

function questionLines(whereToAnswer) {
  return [
    '1. 本輪有無「新專案詞」（本專案特有、IS-not-DOES、≤2 句可定義）？有 → 補進 ' + CONTEXT_PATH + '（含 Changelog）。',
    '2. 本輪有無「新跨模組鏈路」或既有鏈路變更？有 → 補進 ' + FLOWS_PATH + '（掛事故收據）。',
    '3. 本輪有無「新 QA 操作坑／測試設計知識」？有 → 補進 ' + QA_KNOWLEDGE_PATH,
    '   （**寫入時必須同時在該檔的 Changelog 段補一行**，否則事後查不到這題有沒有被執行過）。',
    '4. 本輪的註解／文件有無「自創代號」（態 A、模式 B、階段一這類讀者查不到定義的簡稱）？',
    '   有 → 換成 ' + CONTEXT_PATH + ' 已定義的詞，或直接寫白話；沒有既有詞又非講不可 → 先進 ' + CONTEXT_PATH + ' 再用。',
    '   判準：讀者不必問你就知道那是什麼嗎？' + (OFFICIAL_CODE_EXAMPLES ? '專案正式代號（' + OFFICIAL_CODE_EXAMPLES + '）不算自創，照用。' : '專案正式代號不算自創，照用。'),
    '',
    whereToAnswer,
    '',
    '  --sediment 詞=無 鏈=無 QA=無 代號=無',
    '  --sediment 詞=已補2詞 鏈=無 QA=已補1條 代號=已正名2處',
    '',
    '（四題全帶才放行；答案內容不檢查，但漏題會被擋。答「無」零成本，漏答才是要擋的行為。）',
  ];
}

// ── 'skill' 模式：PreToolUse(Skill)，只攔 git-commit ──
function runSkillMode(input) {
  const ti = input.tool_input || {};
  const skill = String(ti.skill || ti.command || '').split(':').pop();
  if (skill !== 'git-commit') process.exit(0);

  const sessionId = String(input.session_id || 'unknown-session').replace(/[^\w.-]/g, '_');
  const marker = path.join(os.tmpdir(), `claude-sediment-sweep-${sessionId}`);
  if (fs.existsSync(marker)) process.exit(0); // 本 session 已表態過（marker 由本 hook 在表態通過後建立）

  const missing = missingAnswers(ti.args);
  if (missing.length === 0) {
    try { fs.writeFileSync(marker, 'done', 'utf8'); } catch {}
    process.exit(0);
  }

  console.error(
    [
      '[sediment-sweep] commit 前先做知識沉澱四問（本 session 首次 commit 必答；答完才放行）：',
      '',
      ...questionLines('請在**回覆正文逐題明答**（答「無」也要寫出來，讓使用者可否決），完成對應寫入後，\n重新呼叫 git-commit skill 並在 args 帶上四題表態，形狀：'),
      missing.length < KEYS.length ? `⚠ 你的 args 只答了 ${KEYS.length - missing.length} 題，缺：${missing.join('、')}——四題都要答。` : '',
    ].filter((x) => x !== '').join('\n')
  );
  process.exit(2);
}

// ── 'stop' 模式：Stop hook，本回合有改檔才要求表態 ──
function isRealUserPrompt(entry) {
  if (!entry || entry.type !== 'user') return false;
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return !c.some((b) => b && b.type === 'tool_result');
  return false;
}

function runStopMode(input) {
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) process.exit(0);
  const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const l of lines) { try { entries.push(JSON.parse(l)); } catch {} }

  // 「本回合」＝最後一則真正的使用者訊息之後。用行位置切，不要用 promptId 之類的欄位
  // （assistant 行不保證帶與 user 行相同的識別欄位，用欄位過濾會切到 0 行而且不報錯）。
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserPrompt(entries[i])) { start = i; break; }
  }
  const turn = entries.slice(start + 1);

  let edited = false;
  let text = '';
  for (const e of turn) {
    if (e.type !== 'assistant') continue;
    const c = (e.message && e.message.content) || [];
    for (const b of Array.isArray(c) ? c : []) {
      if (b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) edited = true;
      if (b.type === 'text') text += '\n' + b.text;
    }
  }
  if (!edited) process.exit(0); // 本回合沒改檔 → 沒東西要沉澱

  const missing = missingAnswers(text);
  if (missing.length === 0) process.exit(0);

  if (input.stop_hook_active) {
    // 已經擋過一次、模型續跑後仍未表態：放行避免無限迴圈，但留下可見紀錄。
    console.error(`[sediment-sweep] ⚠ 本回合已提醒過仍缺表態（${missing.join('、')}），為避免迴圈放行。`);
    process.exit(0);
  }

  const reason = [
    '[sediment-sweep] 本回合有改檔，結束前先做知識沉澱四問：',
    '',
    ...questionLines('請在**回覆正文逐題明答**（答「無」也要寫出來，讓使用者可否決），完成對應寫入後，\n在回覆中另起一行寫出四題表態，形狀：'),
  ].join('\n');
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

try {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  if (TRIGGER_MODE === 'stop') runStopMode(input);
  else runSkillMode(input);
} catch (e) {
  console.log(`[sediment-sweep] ERROR: hook 故障——${e.message}（放行，但 hook 鏽蝕要修，勿靜默忽略）`);
  process.exit(0);
}
