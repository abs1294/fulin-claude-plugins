#!/usr/bin/env node
// PreToolUse(Agent|Task)：Codex B 軌派工的「diff 必須內嵌」閘。
//
// 病灶：部分環境的 codex 沙箱擋掉所有外部 shell（powershell.exe / bash.exe / cat），
// 只要 prompt 裡給了檔案路徑，codex 就會去讀 → CreateProcess rejected: blocked by policy
// → 回 VERDICT: UNAVAILABLE 或「無法驗證」型 BLOCK，等於白白跳過一軌審查。
//
// 曾踩過的坑：SKILL.md 的 prompt 範本第一行若寫「請先 `cat` 讀取」，照著寫就必然失敗；
// 改講「用 cat 不要用 powershell」一樣被擋；內嵌了 diff 卻又附上路徑，codex 仍會去讀。
//
// 規則是自律、會被繞；這道閘是他律。
//
// 接線（本 plugin 的 hooks/hooks.json）：
//   "PreToolUse": [{ "matcher": "Agent|Task", "hooks": [{ "type": "command",
//     "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/guard-codex-diff-embed.js\"", "timeout": 10 }] }]
//
// 判準（命中任一即擋）：
//   ① prompt 內出現 staged diff 的檔案路徑（.git-commit-tmp / staged-*.diff）
//   ② prompt 內出現「先 cat 讀取」「請先讀取」類的讀檔指示
// 放行條件：prompt 內有明確的硬性禁令（不要執行任何指令 / 不要讀取任何檔案）
//           且不含上述檔案路徑。
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let reason = null;
  try {
    const input = JSON.parse(raw);
    const ti = input.tool_input || {};
    const type = String(ti.subagent_type || '');
    // 只管 codex 系 agent；其他 agent 讀檔正常
    if (!/codex/i.test(type)) { process.exit(0); }

    const prompt = String(ti.prompt || '');

    // ① 檔案路徑：給了它就會去讀
    const hasPath = /\.git-commit-tmp|staged-[\w.]+\.diff/i.test(prompt);

    // ② 讀檔指示
    const hasReadOrder = /(先|請先|用)\s*`?(cat|Get-Content|type)`?\s*(讀取|讀|讀檔)?|請先\s*`?cat`?|用\s*`?(cat|Get-Content|type)`?\s*讀/i.test(prompt);

    // 放行條件：硬性禁令
    const hasHardBan = /不要執行任何指令|不得執行任何指令|do not run any command/i.test(prompt)
                    && /不要讀取任何檔案|不得讀取任何檔案|do not read any file/i.test(prompt);

    if (hasPath) {
      reason = '[codex 沙箱閘] 這次派給 ' + type + ' 的 prompt 裡出現了 staged diff 的**檔案路徑**。'
        + '部分環境的 codex 沙箱擋掉所有外部 shell（powershell.exe / bash.exe / cat），'
        + '只要 prompt 給了路徑，codex 就會去讀 → `rejected: blocked by policy` → 回 UNAVAILABLE 或'
        + '「無法驗證」型 BLOCK，等於白白跳過一軌審查。'
        + '\n\n正確做法：**把 diff 內容直接貼進 prompt，不要附任何檔案路徑**，並在開頭寫死'
        + '「【嚴格限制】不要執行任何指令、不要讀取任何檔案。」'
        + '大 diff 不是例外——可只內嵌需要判斷的部分（例如 JSON 結構 diff）＋檔案清單與已驗證結果。'
        + '\n細節見 skills/git-commit/references/codex-troubleshooting.md 的快速參照表。';
    } else if (hasReadOrder && !hasHardBan) {
      reason = '[codex 沙箱閘] 這次派給 ' + type + ' 的 prompt 含「先 cat 讀取」類的讀檔指示，'
        + '但部分環境的沙箱擋掉所有外部 shell，一讀必敗。'
        + '\n\n正確做法：把 diff 內容直接內嵌，並在開頭寫死'
        + '「【嚴格限制】不要執行任何指令、不要讀取任何檔案。」'
        + '\n細節見 skills/git-commit/references/codex-troubleshooting.md 的快速參照表。';
    }
  } catch (e) {
    // fail-open：自身錯誤一律放行，絕不把人鎖在無法派工的狀態
    process.exit(0);
  }

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
