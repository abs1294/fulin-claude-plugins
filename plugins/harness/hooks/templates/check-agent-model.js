#!/usr/bin/env node
// PreToolUse(Agent|Task)：專案 agent 派工的 model 參數閘。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Agent|Task", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/check-agent-model.js\"", "timeout": 15 }] }]
//
// 兩層檢查：
//   ① 專案 agent 有沒有帶 model——不帶會繼承主對話模型，浪費高階額度。
//   ② 帶的值是不是 fable——「Fable 禁下放」若只有文字規則、hook 只驗「有沒有帶」不驗值，
//      帶 model:"fable" 的派工一路暢通，規則等於不存在。② 不限 MANAGED_AGENTS，任何 subagent 都適用。
// 判準正本：.claude/harness/02-model-dispatch.md §1。
// fail-open：解析失敗或任何例外一律放行（hook 故障不得變成擋路石）。

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 本專案的 agent 名單（= Phase 3 Q1 裁切後實際建在 .claude/agents/ 的名字；
// 專案已有自己的 agents 時填那些名字）。plugin 前綴（"plugin:agent"）會自動剝掉再比對。
const MANAGED_AGENTS = [
  'backend-architect',
  'backend-engineer',
  'frontend-engineer',
  'qa-engineer',
  'code-reviewer',
];
// deny 訊息裡提示的預設 model（只影響訊息文字，不影響判斷）。
const DEFAULT_MODEL_HINT = '實作／審查／QA＝sonnet、architect＝opus；命中 02 §1 進階執行層判準（任兩項）派 opus';
// ────────────────────────────────────────────────────────────────────────────

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let reason = null;
  try {
    const input = JSON.parse(raw);
    const ti = input.tool_input || {};
    const type = String(ti.subagent_type || '').split(':').pop();
    const model = String(ti.model || '');

    if (MANAGED_AGENTS.includes(type) && !ti.model) {
      reason = '[02-model-dispatch §1] 專案 agent（' + type + '）派工必須顯式帶 model 參數，不帶會繼承主對話模型。'
        + '預設：' + DEFAULT_MODEL_HINT + '。請補上 model 參數重發同一個 agent，不得改派其他 agent type 繞過本檢查。';
    }

    // ② Fable 禁下放。豁免：使用者明確要求時，在 prompt 內寫明（只驗有沒有表態，不判理由對錯）。
    if (!reason && /fable/i.test(model)) {
      const prompt = String(ti.prompt || '');
      const userAsked = /使用者(明確)?要求.{0,12}fable|user (explicitly )?requested fable|--allow-fable/i.test(prompt);
      if (!userAsked) {
        reason = '[02-model-dispatch §1 Fable 禁下放] 這次派工帶了 model="' + model + '"。'
          + '除非使用者明確要求，subagent 一律不得用 Fable——主對話是 Fable session 時，'
          + '派工模型照樣按 §1 表選 sonnet／opus／haiku，不得讓 subagent 繼承 Fable。'
          + '請改成 sonnet／opus／haiku 之一重發同一個 agent；'
          + '若確實是使用者當次明確指定要用 Fable，在 prompt 內寫明「使用者要求用 fable：<理由>」再重發。'
          + '不得改派其他 agent type 繞過本檢查。';
      }
    }
  } catch (e) {}
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  }
  process.exit(0);
});
