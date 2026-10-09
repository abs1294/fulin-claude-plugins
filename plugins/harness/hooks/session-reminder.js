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
  // 規則引擎的語法解析器裝在 .claude/hooks/node_modules（不進版控）：剛 clone 的成員沒裝時，
  // 兩支規則引擎會靜默退回正則判法，所以這裡點名。
  const hooksDir = path.join(projectDir, '.claude', 'hooks');
  if (fs.existsSync(path.join(hooksDir, 'shell-model.js')) && fs.existsSync(path.join(hooksDir, 'package.json')) &&
      !fs.existsSync(path.join(hooksDir, 'node_modules', 'tree-sitter-bash'))) {
    console.log(
      '[harness] 規則引擎的語法解析器沒裝：請使用者在 .claude/hooks 跑 `npm ci`。' +
      '沒裝時 guard-risky-command／guard-test-preconditions 退回正則判法，準確度較低。'
    );
  }
  // /harness:init 做到一半（狀態檔還是 running）：提醒續跑或中止。Stop 閘對 24 小時沒動的狀態檔不再擋，改由這裡提醒。
  const statePath = path.join(projectDir, '.claude', 'harness', '.init-state.json');
  if (fs.existsSync(statePath)) {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    if (st && st.status === 'running') {
      const hist = Array.isArray(st.history) ? st.history : [];
      const last = hist.length ? String(hist[hist.length - 1].at || '').slice(0, 10) : '?';
      const flow = path.join(__dirname, '..', 'skills', 'init', 'scripts', 'init-flow.js');
      console.log(
        '[harness] 這個專案有一次沒做完的 /harness:init（停在 Phase ' + st.phase + '，最後動作 ' + last + '）。' +
        '要續跑就照 init 的 SKILL 從這個 Phase 接著做（先跑 node "' + flow + '" status "' + projectDir + '" 看缺什麼）；' +
        '使用者要放棄就跑 node "' + flow + '" abort "' + projectDir + '" --reason "<理由>"。'
      );
    }
  }
} catch (e) {
  // 提醒 hook 失敗不得阻斷 session
}
process.exit(0);
