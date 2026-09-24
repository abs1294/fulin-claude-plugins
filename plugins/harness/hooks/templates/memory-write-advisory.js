#!/usr/bin/env node
// PostToolUse(Write|Edit|MultiEdit)：memory 寫入提示。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/memory-write-advisory.js\"", "timeout": 15 }] }]
//
// 只在寫入 auto-memory 目錄底下的 .md 時觸發，做兩件事、全部 advisory（exit 0，不擋）：
//   ① 印索引檔目前字元數與上限比例——上限是 Claude Code 的載入上限，超限是靜默截斷
//      （沒有錯誤訊息、沒有警告，內容就是沒被載入）。判準用字元數不用行數：條目長度不一，
//      行數門檻在條目偏長的專案會低估風險。
//   ② 寫入的是新檔時，印「同前綴的既有檔數」與可能可掛的總則檔——鼓勵先掛既有總則檔加節，
//      掛不上才新開；逐坑新開檔是索引膨脹的主因。
//
// 為什麼掛 PostToolUse 而不是等健檢：健檢是低頻（見 health-check-reminder.js），索引可能在
// 健檢週期內就已超限；寫入當下提醒能在膨脹初期就被看見。
// 為什麼 exit 0：這裡沒有「錯」的寫入，只有「可以更好」——用 exit 2 會把每次寫 memory
// 都變成一次打斷。訊息走 stdout，模型看得到即可。
// hook 故障一律放行（exit 0）＋印訊息，不得變成擋路石。

const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// auto-memory 目錄的路徑樣式（regex，比對正規化為正斜線後的絕對路徑）。
// 預設對應 Claude Code 的專案記憶目錄慣例：~/.claude/projects/<任意 slug>/memory/。
// 若專案改用別的記憶存放慣例（例如自訂一份 knowledge/ 目錄），改這個 regex；
// 要抓的兩個 capture group 依序是「記憶目錄」「檔名」。
const MEMORY_DIR_PATTERN = /^(.*\/\.claude\/projects\/[^/]+\/memory)\/([^/]+\.md)$/;
// 索引檔檔名（記憶目錄底下彙總所有條目的那一份）。
const INDEX_FILE_NAME = 'MEMORY.md';
// 索引字元數上限（Claude Code 的實際載入上限；環境不同可能有出入，抓保守值即可）。
const LIMIT = 24986;
// 觸發「該精簡了」提醒的比例（相對 LIMIT）。
const WARN_RATIO = 0.8;
// 判斷「該不該提示掛既有總則檔」的門檻：同前綴既有檔數 ≥ 此值就提示。
const SIBLING_THRESHOLD = 3;
// ────────────────────────────────────────────────────────────────────────────

try {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  if (!/^(Write|Edit|MultiEdit)$/.test(input.tool_name || '')) process.exit(0);

  const ti = input.tool_input || {};
  const rawPath = String(ti.file_path || ti.path || '');
  if (!rawPath) process.exit(0);
  // 統一轉絕對路徑再比對——payload 可能給相對路徑（相對於呼叫時的 cwd）。
  const filePath = path.resolve(input.cwd || process.cwd(), rawPath).replace(/\\/g, '/');

  const m = filePath.match(MEMORY_DIR_PATTERN);
  if (!m) process.exit(0);
  const memDir = m[1];
  const fileName = m[2];

  const out = [];

  // ① 索引字元數
  const indexPath = path.join(memDir, INDEX_FILE_NAME);
  if (fs.existsSync(indexPath)) {
    const chars = fs.readFileSync(indexPath, 'utf8').length;
    const pct = Math.round((chars / LIMIT) * 100);
    const tag = chars > LIMIT ? '已超限（可能被靜默截斷）'
      : chars > LIMIT * WARN_RATIO ? `超過提醒線（${Math.round(WARN_RATIO * 100)}%），該考慮精簡`
        : 'OK';
    out.push(`[memory] ${INDEX_FILE_NAME} ${chars} 字元／上限 ${LIMIT}（${pct}%）${tag}`);
  }

  // ② 新檔 → 提示同前綴檔與可掛的總則檔
  if (fileName !== INDEX_FILE_NAME && input.tool_name === 'Write') {
    const all = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== INDEX_FILE_NAME);
    const isNew = !all.includes(fileName) || (input.tool_response && input.tool_response.type === 'create');
    const base = fileName.replace(/\.md$/, '');
    const parts = base.split('_');
    if (parts.length >= 2) {
      const prefix1 = parts.slice(0, 2).join('_');
      const sib = all.filter((f) => f !== fileName && f.startsWith(prefix1 + '_'));
      const consolidated = all.filter((f) => f.includes('consolidated') && f.includes(parts[1]));
      if (isNew && (sib.length >= SIBLING_THRESHOLD || consolidated.length)) {
        out.push(`[memory] 新檔 ${fileName}：同前綴 ${prefix1}_* 已有 ${sib.length} 檔`
          + (consolidated.length ? `；可能可掛的總則檔：${consolidated.join(', ')}` : '')
          + ' —— 先確認能不能掛既有總則檔加一節，掛不上才新開，避免逐坑新開檔造成索引膨脹');
      }
    }
  }

  if (out.length) console.log(out.join('\n'));
  process.exit(0);
} catch (e) {
  console.log('[memory-write-advisory] hook 故障放行：' + (e && e.message));
  process.exit(0);
}
