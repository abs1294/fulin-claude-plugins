#!/usr/bin/env node
// SessionStart 提醒：僅在「當前專案已有 harness 實例」時輸出入口提醒。
// 條件式設計的理由：plugin hook 對所有啟用專案生效；未 init 的專案若也收到
// 「先讀 .claude/harness/README.md」會指向不存在的路徑，誤導比沒有提醒更糟。
const fs = require('fs');
const path = require('path');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const harnessReadme = path.join(projectDir, '.claude', 'harness', 'README.md');

try {
  if (fs.existsSync(harnessReadme)) {
    console.log(
      '[harness] 本專案有制度層 .claude/harness/：多步驟或大型任務開始前先讀 README.md；' +
      '派工照 02-model-dispatch + 04-delegation-templates；卡關停損/完成判準/熔斷提問照 03-judgment-matrix。'
    );
  } else {
    // 未 init：保持沉默，不佔 context。要建實例時使用者會叫 /harness:init。
  }
} catch (e) {
  // 提醒 hook 失敗不得阻斷 session
}
process.exit(0);
