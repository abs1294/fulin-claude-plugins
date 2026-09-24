#!/usr/bin/env node
// PreToolUse(AskUserQuestion)：發問前自省閘。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/check-ask-discipline.js\"" }] }]
//
// 只驗一件事：每題必附建議選項——提得出建議＝三重自查（03 矩陣「問使用者前的三重自查」）真的做過；
// 提不出建議＝還沒自省，deny 訊息即自省清單。
// 刻意不計數、不限次：頻率上限會逼出「湊題」或「改用文字請示」的繞法，自省錨點比次數閘實在。
// 零專案耦合，init 不需填空。fail-open：解析失敗一律放行。
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let reason = null;
  try {
    const input = JSON.parse(raw);
    const questions = Array.isArray((input.tool_input || {}).questions) ? input.tool_input.questions : [];
    for (const q of questions) {
      const opts = Array.isArray(q.options) ? q.options : [];
      const hasRec = opts.some((o) => /推薦|建議|Recommended/i.test(String(o && o.label || '')));
      if (!hasRec) {
        reason = '[提問自省] 每題必須附建議答案（至少一個選項標「（推薦）」）。發問前先過 03 矩陣三重自查：'
          + '①事實型（讀碼／跑指令／查 memory，15 分鐘內可查證）→ 自己查，禁問；'
          + '②規則已裁型（harness／skill／專案慣例有明文）→ 照做並回報「已照 X 處理」；'
          + '③可逆低價型（選錯一行改回）→ 自己決並回報「已代決：X＝Y」。'
          + '過完仍是真決策才問，並附你的建議與理由重發。';
        break;
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
