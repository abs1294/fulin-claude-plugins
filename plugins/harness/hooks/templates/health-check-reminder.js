#!/usr/bin/env node
// SessionStart：制度健檢到期提醒。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "SessionStart": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/health-check-reminder.js\"", "timeout": 15 }] }]
//
// 讀健檢紀錄檔的 changelog，找「同時含『健檢』與執行語意詞（執行／跑過／結果／OK／異常）」的
// 最新一筆日期，距今超過門檻天數就在開機訊息提醒主動提議健檢。
//
// ⚠ 判準必須同時要求「健檢」與執行語意詞：只認「含『健檢』字樣」會把「加了一個健檢項目」
// 「改健檢流程」這種修改制度本身的條目也算成「做過一輪」，把基準日往後推、掩蓋真正逾期的事實。
// 判準正本與細節見來源專案 memory（本範本不引用）；規則本身＝「距上次**執行**健檢超過 N 天」，
// 不是「距上次改健檢制度」。
//
// 失敗時必須 loud（印 ERROR 到 stdout），但不得中斷 session——SessionStart hook 沒有「擋」的語意，
// 只有「有沒有印提醒」。找不到檔案或抓不到日期 → 靜默放行，不印任何東西（避免新專案第一次跑就噴錯）。
// fail-open：任何例外一律放行。
//
// 測試專用：環境變數 HARNESS_TODAY（格式 YYYY-MM-DD）可覆寫「今天」，只供 probe-hooks.js 使用；
// 正常執行不設這個變數，一律用系統當下時間。

const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 提醒門檻（天）。對應 Phase 3 使用者答的健檢週期（沒特別要求就用預設 30）。
const THRESHOLD_DAYS = 30;
// 健檢紀錄檔路徑（相對於本檔所在的 .claude/hooks/）。該檔要有形如
// `- YYYY-MM-DD ...健檢...` 的 changelog 條目可供本 hook 解析；換一份文件格式要同步改下面的正則。
const LOG_FILE = path.join(__dirname, '..', 'harness', '05-knowledge-protocol.md');
// 找不到任何一筆「執行過」的健檢紀錄時使用的基準日（例：專案該制度檔的建立日）。
// 填空區留空字串則代表「完全沒有基準可用」，此時 hook 直接靜默放行（見下方判斷）。
const FALLBACK_BASE_DATE = '';
// ────────────────────────────────────────────────────────────────────────────

const DID_RUN = /健檢/;
const RAN_HINT = /執行|跑完|跑過|結果|項中|OK|異常/;

try {
  const text = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = text.split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2}/.test(l));

  let base = FALLBACK_BASE_DATE || null;
  for (const l of lines) {
    const m = l.match(/^- (\d{4}-\d{2}-\d{2})/);
    if (m && DID_RUN.test(l) && RAN_HINT.test(l)) base = m[1];
  }
  if (!base) process.exit(0); // 檔案讀得到但沒有任何可用日期 → 靜默，不是錯誤

  const todayOverride = process.env.HARNESS_TODAY;
  const now = todayOverride ? new Date(todayOverride + 'T00:00:00') : new Date();
  const days = Math.floor((now - new Date(base + 'T00:00:00')) / 86400000);

  if (days > THRESHOLD_DAYS) {
    console.log(
      `[health-check] 距上次制度健檢已 ${days} 天（基準 ${base}，門檻 ${THRESHOLD_DAYS} 天）——`
      + `應主動向使用者提議一輪健檢（檢查清單見 ${path.relative(process.cwd(), LOG_FILE) || LOG_FILE}）。`
    );
  }
} catch (e) {
  // 檔案不存在／讀不到日期 → 靜默（新專案、或健檢紀錄檔尚未建立時，噴錯反而擾民）。
  // 只有「檔案存在但解析邏輯本身炸掉」才 loud 印錯，提示 hook 鏽蝕要修。
  if (e && e.code !== 'ENOENT') {
    console.log(`[health-check] ERROR: reminder 故障——${e.message}（hook 鏽蝕要修，勿靜默忽略）`);
  }
}
