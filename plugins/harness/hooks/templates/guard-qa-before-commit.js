#!/usr/bin/env node
// PreToolUse(Skill)：行為類改動 commit 前的 QA 表態閘。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治。
// 前提：目標專案有裝 git-commit plugin（commit 走 Skill "git-commit"）。沒裝就不要接這支——它只攔 git-commit skill。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Skill", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-qa-before-commit.js\"", "timeout": 30 }] }]
//
// 病灶：pipeline 明訂「行為類先 QA 再 review」，但兩軌 review 都 PASS 時 commit 流程會自動往下走，
// QA 從未被派的改動照樣上線——審查者甚至寫了「沒加自動化測試」仍判 PASS。
// 靜態審查看不出跑起來才會出的錯；這支 hook 讓「沒 QA」從靜默變成必須表態。
// 設計：git-commit skill 零改動（保持跨專案可攜），耦合放專案 hook 層。
// 只擋「staged diff 真的含行為類檔」的情形；純文件／設定／測試資產不擋。
// 每一輪 commit 都驗（不設 marker）——每個 commit 的 diff 都不同，一次表態不能覆蓋後續 commit。
// 放行＝args 帶表態（--qa-verified／--no-qa）：答案同時進 transcript，使用者當場可否決。
// fail-open：hook 故障時放行但 loud 印錯，不得變成擋路石。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 要檢查 staged 的 repo（相對於專案根）。單 repo 專案＝['.']；多 repo workspace 列各 repo 資料夾名。
const REPOS = ['.'];
// 行為類副檔名（會被執行到的程式邏輯）。依 Phase 1 盤點的技術棧填，例：
//   Web 前後端：['js','ts','jsx','tsx','mjs','cjs','py','go','java','kt','cs','rb','php']＋前端框架單檔元件副檔名
//   行動 App：['swift','m','kt','java','dart']
const BEHAVIOR_EXTS = ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'go', 'java', 'kt', 'cs', 'rb', 'php'];
// 不算行為類的路徑（regex，比對 repo 內相對路徑）。測試資產本身不需要再 QA。
const EXCLUDE_PATTERNS = [/^tests?\//, /(^|\/)__tests__\//, /\.(test|spec)\.[a-z]+$/i];
// QA agent 名（訊息用）。
const QA_AGENT = 'qa-engineer';
// ────────────────────────────────────────────────────────────────────────────

const EXT_RE = new RegExp('\\.(' + BEHAVIOR_EXTS.join('|') + ')$', 'i');

function isBehaviorFile(f) {
  if (EXCLUDE_PATTERNS.some((re) => re.test(f))) return false;
  return EXT_RE.test(f);
}

try {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  const ti = input.tool_input || {};
  // plugin 安裝時 skill 名可能帶前綴（"git-commit:git-commit"），剝掉前綴再比對。
  const skill = String(ti.skill || ti.command || '').split(':').pop();
  if (skill !== 'git-commit') process.exit(0);

  const args = String(ti.args || '');
  if (/--qa-verified|--no-qa|QA已驗|QA 已驗/.test(args)) process.exit(0);

  // 專案根：CLAUDE_PROJECT_DIR 不保證存在，退回「本檔在 <root>/.claude/hooks/」推回去。
  const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
  const hits = [];
  for (const r of REPOS) {
    const dir = path.resolve(root, r);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    let out = '';
    try {
      out = execSync('git diff --cached --name-only', { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    for (const f of out.split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (isBehaviorFile(f)) hits.push(r === '.' ? f : `${r}/${f}`);
    }
  }

  if (hits.length === 0) process.exit(0); // 無行為類 staged 檔 → 放行

  console.error(
    [
      '[qa-before-commit] 本次 staged diff 含行為類檔案，commit 前必須先回答 QA 狀態（pipeline 配套：行為類先 QA 再 review，見 04 模板五）：',
      '',
      ...hits.slice(0, 20).map((f) => `  - ${f}`),
      hits.length > 20 ? `  …共 ${hits.length} 檔` : '',
      '',
      '請在回覆中三選一明答，讓使用者可否決：',
      '  (a) 已 QA：貼出 QA 報告路徑或 codify 的測試檔路徑＋實跑綠的輸出行；',
      '  (b) 分流例外：純結構／文案／死碼等「靜態可確定等價」——一句話說明為何正確性只靠讀 code 就能確定；',
      `  (c) 尚未 QA：**不得走默許機制自動 commit** —— 依 04 模板六派 ${QA_AGENT} 實測，回來再 commit。`,
      '',
      '答完後重新呼叫 git-commit skill；判定是 (a) 或 (b) 時，args 帶 "--qa-verified" 即放行本次。',
    ].filter(Boolean).join('\n')
  );
  process.exit(2);
} catch (e) {
  console.log(`[qa-before-commit] ERROR: hook 故障——${e.message}（放行 commit，但 hook 鏽蝕要修，勿靜默忽略）`);
  process.exit(0);
}
