#!/usr/bin/env node
/**
 * PreToolUse hook — `.claude/` 目錄純度守門。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 接線（目標專案 .claude/settings.json）：
 *   "PreToolUse": [{ "matcher": "Write", "hooks": [{ "type": "command",
 *     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-claude-dir-hygiene.js\"", "timeout": 15 }] }]
 *
 * 背景：`.claude/` 是 Claude Code 的機制目錄（commands / skills / hooks / agents /
 * settings）加上工作流的制度層（例：harness）。一次性產物——設計文件、交接、QA 報告、
 * 測試計畫——不該放這裡，該進交付產物的落點（填空區 `SUGGESTED_DEST`）。
 *
 * 事故形態：某個過程性子目錄裡混了大量帶日期戳的報告與計畫，其中只有極少數是真正的規範；
 * 另有多個資料夾整個是專案產物而非制度檔。整頓時常一併發現「說謊的地圖」——skill 或
 * CLAUDE.md 還指著早已刪除的路徑。本閘要擋的就是這種「一次性產物混進制度層」的起點。
 *
 * 本閘只擋最明顯的形態（新建檔案落在 `.claude/` 底下、且不在機制白名單內）。
 * 完整判準是質性的：「這份文件換一個專案還需要嗎？」需要→機制/制度；不需要→產物落點。
 *
 * 只管「新建」，不管修改既有檔（既有檔的搬遷是人工決策，不該被閘擋）。
 * fail-open：解析失敗或任何例外一律放行。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// `.claude/` 底下允許新建檔案的機制目錄（第一層目錄名）。
// 通用預設涵蓋 Claude Code 自身機制＋常見的工作流制度層目錄；專案若另有自己的
// 制度層目錄（例：本專案的 harness 之外還有一份 xxx-guide/），在此加上去。
const ALLOWED_DIRS = new Set([
  'agents', 'commands', 'hooks', 'skills', 'scripts',
  'harness',
  'plugins', 'statsig', 'projects', 'todos', 'shell-snapshots', 'ide',
  'plans',
]);
// `.claude/` 第一層允許新建的檔案。local-overrides.yml＝本機覆寫清單，git-commit plugin 會在
// 任何專案自動建立它（本機覆寫保護 hook 也讀同一個檔），所以必須放行；其餘依專案實際檔名調整。
const ALLOWED_ROOT_FILES = new Set([
  'settings.json', 'settings.local.json',
  'local-overrides.yml',
  'CLAUDE.md', '.gitignore',
]);
// 擋下時建議的產物落點（依檔名關鍵字分流；找不到關鍵字時給預設落點）。
const SUGGESTED_DEST_ROOT = 'docs/';
function suggestDest(base) {
  const b = base.toLowerCase();
  if (/handover|交接/.test(b)) return SUGGESTED_DEST_ROOT + 'handover/';
  if (/qa-report|qa-plan|test-plan|測試/.test(b)) return SUGGESTED_DEST_ROOT + 'test-plan/';
  if (/design|spec|架構|設計|plan/.test(b)) return SUGGESTED_DEST_ROOT + 'design/';
  return SUGGESTED_DEST_ROOT + '（依內容挑合適的子資料夾）';
}
// ────────────────────────────────────────────────────────────────────────────

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const input = readInput();
  if (!input) process.exit(0);

  const tool = input.tool_name || '';
  if (tool !== 'Write') process.exit(0);   // 只管新建；Edit 既有檔不擋

  const fp = (input.tool_input && input.tool_input.file_path) || '';
  if (!fp) process.exit(0);

  const norm = fp.replace(/\\/g, '/');

  // 只管**本專案**的 .claude/。不錨專案根會連 Claude Code 自己的全域機制目錄
  // （例如使用者家目錄下的 .claude/plans/，plan mode 每次都會寫）都一併擋下，
  // 且建議落點會指向專案內路徑——錯的診斷配錯的處方。
  const cwd = input.cwd || process.cwd();
  const projRoot = (process.env.CLAUDE_PROJECT_DIR || cwd)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const absNorm = path.isAbsolute(fp) ? norm : path.resolve(cwd, fp).replace(/\\/g, '/');
  if (!absNorm.toLowerCase().startsWith(projRoot.toLowerCase() + '/')) process.exit(0);

  const m = absNorm.match(/(^|\/)\.claude\/(.+)$/);
  if (!m) process.exit(0);                 // 不在 .claude/ 底下

  const rest = m[2];                       // .claude/ 之後的相對路徑
  const seg = rest.split('/')[0];

  // 落在允許的機制目錄內 → 放行
  if (rest.includes('/') && ALLOWED_DIRS.has(seg)) process.exit(0);
  // 第一層的允許檔 → 放行
  if (!rest.includes('/') && ALLOWED_ROOT_FILES.has(seg)) process.exit(0);
  // 允許目錄本身（無子路徑）→ 放行
  if (!rest.includes('/') && ALLOWED_DIRS.has(seg)) process.exit(0);

  // 既有檔就放行（本閘只擋新建；搬遷既有檔是人工決策）
  try {
    if (fs.existsSync(fp)) process.exit(0);
  } catch { /* ignore */ }

  const base = path.basename(rest);
  const dest = suggestDest(base);

  const msg = [
    `[.claude 純度閘] 擋下：${norm}`,
    '',
    '`.claude/` 只放 Claude Code 機制（commands / skills / hooks / agents / scripts）',
    '與工作流制度層。**一次性產物不放這裡。**',
    '',
    `建議落點：\`${dest}\``,
    '',
    '判準：這份文件換一個專案還需要嗎？需要 → 機制/制度層；不需要 → 一次性產物，進上面的落點。',
    '另一個問法：檔名有沒有日期戳或案號？有 → 幾乎必然是一次性。',
    '',
    '真的要放進 .claude/（例如新增一支 hook / skill / command），',
    '請放進對應的機制子目錄，或先跟使用者確認這是制度檔。',
  ].join('\n');

  // exit 2 = 阻擋
  process.stderr.write(msg + '\n');
  process.exit(2);
}

main();
