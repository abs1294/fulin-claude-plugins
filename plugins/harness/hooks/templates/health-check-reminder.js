#!/usr/bin/env node
// SessionStart：制度健檢到期提醒。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "SessionStart": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/health-check-reminder.js\"", "timeout": 15 }] }]
//
// 讀健檢紀錄檔的 changelog，找帶專用標記【健檢執行】的條目（`- YYYY-MM-DD 【健檢執行】…`，
// 由 /harness:review 補紀錄時寫入），取其中**日期最大**的一筆，距今超過門檻天數就在開機訊息提醒。
//
// ⚠ 取「日期最大」，不是「檔案裡最後一筆」：changelog 有人新的寫在最上面、有人寫在最下面，
// 取最後一筆時，新的在上就會一直拿到最舊的那次，提醒永遠不歸零（來源專案實際發生過，
// 逾期提醒卡在同一個舊日期 53 天，健檢跑完照樣喊）。
// ⚠ 只認專用標記，不從自由文字猜：「健檢執行：結論正常」跟「健檢執行：改為每月一次」字面上一模一樣，
// 文字判準（先是黑名單、後是白名單）連續四輪審查都被找到誤認或繞法。改制度的人不會順手打出
// 【健檢執行】這個標記，所以只認它。基準日依序取：帶標記紀錄的最大日期 → FALLBACK_BASE_DATE →
// changelog 最早日期。代價：沒有標記的舊紀錄不算，升級後改用最早日期起算，逾期就提醒（安全方向），
// 跑一次 /harness:review 就會寫入帶標記的紀錄而歸零。
// 規則本身＝「距上次**執行**健檢超過 N 天」，不是「距上次改健檢制度」。
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
// `- YYYY-MM-DD 【健檢執行】…` 的 changelog 條目可供本 hook 解析；換一份文件格式要同步改下面的正則。
const LOG_FILE = path.join(__dirname, '..', 'harness', '05-knowledge-protocol.md');
// 找不到任何一筆帶【健檢執行】標記的紀錄時使用的基準日（例：專案該制度檔的建立日）。
// 留空字串時改用 changelog 裡最早的日期；連一筆日期式條目都沒有才靜默放行（見下方判斷）。
const FALLBACK_BASE_DATE = '';
// ────────────────────────────────────────────────────────────────────────────

// 認得：`- 2026-10-01 【健檢執行】/harness:review：結論…`（標記緊接在日期後面）。
// 不認：沒有標記的任何寫法（`健檢執行：…`、`制度健檢（/harness:review）執行：…` 這類舊格式也不認）、
// 標記不在日期後面一開頭的（`- 2026-10-01 改健檢清單：說明【健檢執行】標記怎麼寫`）。
const RAN = /^- \d{4}-\d{2}-\d{2}\s+【健檢執行】/;

try {
  const text = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = text.split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2}/.test(l));

  // 先在真實的健檢紀錄裡取日期最大的一筆；一筆都沒有才退回 FALLBACK_BASE_DATE。
  // 備援日期不參與比大小：它比真實紀錄晚時，會把真實紀錄蓋掉、延後提醒。
  let base = null;
  for (const l of lines) {
    const m = l.match(/^- (\d{4}-\d{2}-\d{2})/);
    // YYYY-MM-DD 字串比大小＝日期比大小
    if (m && RAN.test(l) && (!base || m[1] > base)) base = m[1];
  }
  // 沒有任何帶標記的紀錄：先用 FALLBACK_BASE_DATE，再退到 changelog 裡最早的日期（通常是制度檔建立日）。
  // 不能就此靜默：升級前只有無標記舊紀錄的實例，靜默等於提醒永久失效；退到最早日期才會在逾期時提醒，
  // 跑一次 /harness:review 寫入帶標記的紀錄就歸零。新專案則是建立滿門檻天數時第一次提醒。
  if (!base) base = FALLBACK_BASE_DATE || null;
  if (!base) {
    for (const l of lines) {
      const m = l.match(/^- (\d{4}-\d{2}-\d{2})/);
      if (m && (!base || m[1] < base)) base = m[1];
    }
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
