#!/usr/bin/env node
/**
 * PreToolUse hook — 交付資料夾紀律守門（過程檔納管）。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 接線（目標專案 .claude/settings.json，兩個 matcher 都要掛才完整）：
 *   "PreToolUse": [
 *     { "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
 *       "command": "node \"<專案絕對路徑>/.claude/hooks/guard-report-output.js\"", "timeout": 15 }] },
 *     { "matcher": "Write|Edit|NotebookEdit", "hooks": [{ "type": "command",
 *       "command": "node \"<專案絕對路徑>/.claude/hooks/guard-report-output.js\"", "timeout": 15 }] }
 *   ]
 *
 * 背景：交付結構的常見約定——交付根層只承載「各次交付的專屬資料夾」，資料夾第一層只放
 * 最終交付檔，其餘一切過程產物（測試結果 XML、截圖、傾印…）收進該資料夾內的 `_work/`
 * 子資料夾。歷史事故形態：交付根層被大量過程檔淹沒，一眼看不出哪些是真正要交的東西。
 *
 * 規則（只管「寫入」動作；讀取一律放行；交付根由填空區 `ROOTS` 設定、可增列）：
 *   1. 交付根層直接寫任何「檔案」 → deny（根層只准開交付資料夾）。
 *   2. 交付資料夾內出現「過程檔特徵格式」（填空區 `PROCESS_EXT`）且不在 `_work/` → deny。
 *   3. `_work/` 底下一切、以及非過程格式的交付檔（docx/pdf/xlsx/csv/json…） → 放行。
 *   完整原則（行為層，比本閘更廣）：交付資料夾第一層只放最終交付檔、其餘一切進
 *   `_work/`——機器無法判定「什麼是最終交付檔」，本閘只機械擋最常見的汙染格式，
 *   完整原則要靠團隊紀律或 skill 文字補。
 *
 * Bash/PowerShell 僅在命令含寫入動詞（>、cp、mv、tee、--junitxml=、Out-File…）時檢查，
 * 純讀取（cat/grep/python 解析）不受影響。已知假陰性：相對路徑（如 `../reports/x.xml`）
 * 無法可靠解析 cwd，偵測不到——這是機械掃描的已知邊界，不是漏洞。
 */

'use strict';

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 納管的交付根（要納管新路徑就加一行；用正規化後的正斜線路徑片段比對）。
const ROOTS = ['reports'];
// 過程檔特徵格式：實務上最容易弄髒交付資料夾的格式；
// csv/json/pdf/xlsx 等可能本身就是交付物，刻意不列入（誤殺比漏擋更糟）。
const PROCESS_EXT = /\.(xml|png|jpe?g|gif|bmp|log|webm|har|trace|tmp|bak|dump)$/i;
// ────────────────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

// 正規化：反斜線→斜線、去引號
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/^["']|["']$/g, '');
}

// 取出路徑中「交付根」之後的相對部分；不在任何交付根底下回 null
function underRoot(p) {
  const n = norm(p);
  for (const root of ROOTS) {
    const re = new RegExp(root.replace(/\//g, '\\/') + '\\/(.+)$', 'i');
    const m = n.match(re);
    if (m) return m[1].replace(/\/+$/, '');
  }
  return null;
}

// 判斷交付根相對路徑是否違規；違規回傳原因字串，合法回 null
function violation(rel) {
  if (!rel) return null;
  const segs = rel.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  const looksFile = /\.[A-Za-z0-9]{1,6}$/.test(last); // 有副檔名視為檔案
  if (!looksFile) return null; // 開資料夾、無副檔名路徑不管
  if (segs.length === 1) {
    return `交付根層禁止直接放檔案（${last}）——根層只承載各次交付的資料夾`;
  }
  if (segs.some((s) => s === '_work')) return null; // _work/ 底下一切放行
  if (PROCESS_EXT.test(last)) {
    return `過程檔（${last}）必須收進交付資料夾內的 _work/ 子資料夾——第一層只放最終交付檔`;
  }
  return null; // 非過程格式視為交付檔放行；完整原則靠行為層守
}

(async () => {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }

  const toolName = payload.tool_name || payload.toolName || '';
  const input = payload.tool_input || payload.toolInput || {};

  // 供路徑掃描用的交付根樣式（正/反斜線皆可）
  const rootsAlt = ROOTS.map((r) => r.replace(/\//g, '[\\/\\\\]')).join('|');
  const hits = [];

  if (/^(Write|Edit|NotebookEdit)$/i.test(toolName)) {
    const why = violation(underRoot(input.file_path || input.notebook_path || ''));
    if (why) hits.push(why);
  } else {
    const command = String(input.command || '');
    if (!command || !new RegExp(rootsAlt, 'i').test(command)) process.exit(0);
    // 只在含寫入動詞時介入；純讀取放行
    const writeVerb = /(^|[\s;|&(])(cp|mv|tee|touch|rsync|zip|tar)\b|>>?|--?junitxml[=\s]|Out-File|Set-Content|Add-Content|Copy-Item|Move-Item|New-Item/i;
    if (!writeVerb.test(command)) process.exit(0);
    // 抓命令中所有落在交付根底下的路徑 token（含引號包裹的中文/空白路徑）
    const tokRe = new RegExp(
      `"[^"]*(?:${rootsAlt})[\\/\\\\][^"]*"|'[^']*(?:${rootsAlt})[\\/\\\\][^']*'|[^\\s"';|&]*(?:${rootsAlt})[\\/\\\\][^\\s"';|&]*`,
      'gi'
    );
    let tokens = command.match(tokRe) || [];
    // mv/cp 類搬移指令只驗「目的地」（最後一個 token）——來源本來就在錯誤位置、
    // 正是要搬走的對象，驗來源會把歸檔作業自己擋死。
    const isMoveCopy = /(^|[\s;|&(])(mv|cp|rsync)\b|Move-Item|Copy-Item/i.test(command);
    if (isMoveCopy && tokens.length > 1) tokens = tokens.slice(-1);
    for (const t of tokens) {
      const why = violation(underRoot(t));
      if (why && !hits.includes(why)) hits.push(why);
    }
  }

  if (hits.length) {
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[交付路徑守門] ${hits.join('；')}。\n` +
          `交付資料夾紀律（納管交付根：${ROOTS.join('、')}）：\n` +
          `  〈交付根〉/〈主題〉_〈YYYYMMDD〉/〈最終交付檔〉   ← 第一層只放最終交付檔\n` +
          `  〈交付根〉/〈主題〉_〈YYYYMMDD〉/_work/          ← 其餘一切過程產物全收這裡\n` +
          `請改寫到正確位置後重發。若為特殊情況需破例，先向使用者確認。`
      }
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  process.exit(0);
})();
