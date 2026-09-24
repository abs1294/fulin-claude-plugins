#!/usr/bin/env node
// PreToolUse(Agent|Task)：派「專案 agent」時，派工 prompt 必須帶上該 agent 的紀律標記，
// 缺就一次列完所有缺項並 deny。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Agent|Task", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/check-review-discipline.js\"", "timeout": 15 }] }]
//
// 背景：派工 prompt 該帶的紀律條款（回報鏈鐵則、驗收條件、回報格式……）若只寫在文件裡、
// 沒有機械檢查，實測會被跳過——派工單漏一項，subagent 照樣開工，缺口要等審查甚至上線
// 才被發現。這支 hook 只能保證「派工 prompt 有帶紀律條款的文字標記」，不驗內容對不對、
// 也不驗 agent 有沒有真的照做——執行面仍要靠 agent 定義檔與 skill 正文把關。
//
// 一次列完所有未過的閘（不要一項一項擠牙膏）：若每次只回報一項，補一項撞一項，
// 派一個要連過多道閘的 agent 會被連續擋很多次，而且每次 deny 都燒一輪 context。
//
// 通用化說明：本範本的 REQUIRED_MARKERS 表格對齊 04-delegation-templates.md 的欄位標題——
// 共用三項（回報鏈鐵則、【驗收條件】、【回報格式】）＋依 agent 角色加碼的欄位（見填空區
// 註解）。這是通用骨架的預設表，**不含**任何特定專案自訂的紀律標記（例如某種靜態掃描
// 工具名、某種分流判準、某個環境的 port 對照）——專案要加自己的紀律時，直接在表裡
// 用同樣的形狀加一條（見填空區範例的「如何自加一條」）。
//
// fail-open：解析失敗或任何例外一律放行。

'use strict';

const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 每個「專案 agent」派工 prompt 必須含的紀律標記表。key 為 agent 名（不含 plugin 前綴），
// `'*'` 是所有專案 agent 共用、每個都要檢查的一組。每條規則：
//   name    — 這條規則的識別名（用於訊息與除錯）
//   pattern — 字串形式的 regex（大小寫不拘），命中即視為「已帶該標記」
//   hint    — 缺這項時給使用者的提示，講清楚該補什麼
//
// 表格對齊 04-delegation-templates.md 的模板欄位標題：
//   共用（'*'）：回報鏈鐵則（「不得轉派」或「親自執行」）、【驗收條件】、【回報格式】
//   實作型 agent（例：backend-engineer／frontend-engineer）另加【開工前必讀】
//   QA agent（例：qa-engineer）另加【範圍展開】與【測試資料來源】
//   審查型 agent（例：code-reviewer）依模板四的驗證欄位（【產出路徑】、【驗證方式】）
//
// 專案要自加一條時，照同樣的形狀加進對應 agent 的陣列（或加進 '*' 讓全部 agent 都要過）：
//   { name: '某工具掃描', pattern: '某工具名', hint: '派工 prompt 必須要求跑 <某工具> 並附輸出' }
const REQUIRED_MARKERS = {
  '*': [
    {
      name: '回報鏈鐵則·禁二次轉派',
      pattern: '不得再?轉派|禁止二次轉派|親自執行',
      hint: '派工 prompt 必須明寫「本任務由你親自執行，不得再轉派給其他 agent」——回報鏈固定一跳，'
        + '需要多個 agent 時由主對話自己分別派、分別收。',
    },
    {
      name: '驗收條件',
      pattern: '【驗收條件】',
      hint: '派工 prompt 必須含【驗收條件】欄位，且每條要可機械判定（能回答「用什麼指令或什麼觀察來判定 PASS/FAIL」）。',
    },
    {
      name: '回報格式',
      pattern: '【回報格式】',
      hint: '派工 prompt 必須含【回報格式】欄位，講清楚回報要包含哪些內容（成果路徑＋關鍵行號＋結論，禁止噴大段代碼）。',
    },
  ],
  'backend-engineer': [
    {
      name: '開工前必讀',
      pattern: '【開工前必讀】',
      hint: '實作型 agent 的派工 prompt 必須含【開工前必讀】：列出該讀哪些既有治理層檔案／規範文件的絕對路徑，'
        + '開工第一步逐檔 Read 完再動工。',
    },
  ],
  'frontend-engineer': [
    {
      name: '開工前必讀',
      pattern: '【開工前必讀】',
      hint: '實作型 agent 的派工 prompt 必須含【開工前必讀】：列出該讀哪些既有治理層檔案／規範文件的絕對路徑，'
        + '開工第一步逐檔 Read 完再動工。',
    },
  ],
  'qa-engineer': [
    {
      name: '範圍展開',
      pattern: '【範圍展開】',
      hint: '派 QA agent 的 prompt 必須含【範圍展開】：至少涵蓋正向路徑、反向／終止分支、狀態序列、'
        + '受影響的共用元件四格；封閉的 TC 清單是最常見的失敗形狀——指揮官漏想的情境，QA 結構上不會補。',
    },
    {
      name: '測試資料來源',
      pattern: '【測試資料來源】',
      hint: '派 QA agent 的 prompt 必須含【測試資料來源】：表明測試資料怎麼來（走真實業務流程／自種自清／'
        + '依賴既有字典資料），並說明理由；禁止硬編業務 Id 或使用者身分當輸入。',
    },
  ],
  'code-reviewer': [
    {
      name: '產出路徑',
      pattern: '【產出路徑】',
      hint: '派審查型 agent 的 prompt 必須含【產出路徑】：列出要驗證的產出檔案絕對路徑清單。',
    },
    {
      name: '驗證方式',
      pattern: '【驗證方式】',
      hint: '派審查型 agent 的 prompt 必須含【驗證方式】：講清楚審查者要怎麼驗（重新 Read 產出檔、跑哪些指令），'
        + '審查者的預設立場是「不相信它完成了，找證據」。',
    },
  ],
};
// ────────────────────────────────────────────────────────────────────────────

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const reasons = [];
  try {
    const input = JSON.parse(raw);
    const ti = input.tool_input || {};
    // plugin 安裝時 agent 名可能帶前綴（"plugin:agent"），剝掉前綴再比對。
    const type = String(ti.subagent_type || '').split(':').pop();
    const prompt = String(ti.prompt || '');

    const rulesForType = (REQUIRED_MARKERS[type] || []);
    const commonRules = (REQUIRED_MARKERS['*'] || []);
    // 只有「表中有列出的 agent 名」才視為專案 agent 並套共用規則；未列出的（例如
    // general-purpose、Explore 這類內建通用 agent）不受本閘管轄。
    const isManaged = Object.prototype.hasOwnProperty.call(REQUIRED_MARKERS, type);
    const rules = isManaged ? [...commonRules, ...rulesForType] : [];

    for (const rule of rules) {
      const re = new RegExp(rule.pattern, 'i');
      if (!re.test(prompt)) {
        reasons.push(`[${rule.name}] ${rule.hint} 請在 prompt 補上後重發同一個 agent，不得改派其他 agent type 繞過本檢查。`);
      }
    }
  } catch (e) {}

  if (reasons.length) {
    const head = reasons.length === 1
      ? '[派工紀律] 派工 prompt 有 1 項未過閘，補齊後重發同一個 agent（不得改派其他 agent type 繞過）：'
      : '[派工紀律] 派工 prompt 有 ' + reasons.length + ' 項未過閘，'
        + '**以下全部補齊後一次重發**同一個 agent（不得改派其他 agent type 繞過）。'
        + '⚠ 這是本次的完整清單，不會再有第二批——逐項對照補完再送：';
    const body = reasons.map((r, i) => '\n\n' + (i + 1) + '. ' + r).join('');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: head + body,
      },
    }));
  }
  process.exit(0);
});
