#!/usr/bin/env node
// SessionStart：制度健檢到期提醒。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "SessionStart": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/health-check-reminder.js\"", "timeout": 15, "statusMessage": "檢查制度健檢有沒有到期" }] }]
//
// 讀健檢紀錄，找帶專用標記【健檢執行】的條目（`- YYYY-MM-DD 【健檢執行】…`，
// 由 /harness:review 補紀錄時寫入），取其中**日期最大**的一筆，距今超過門檻天數就在開機訊息提醒。
//
// 健檢紀錄在哪（harness 0.10.0 起 changelog 從指令檔拆出去）：
//   新格式＝`.claude/harness/CHANGELOG.md` 的 `## 05-knowledge-protocol.md` 節——**只讀這一節**，
//     別的節（01～04、README…）剛好寫到「健檢」也不算，節的範圍到下一個 `## ` 標題或檔尾為止。
//   舊格式＝`.claude/harness/05-knowledge-protocol.md` 本體裡的 changelog 條目（0.9.x 以前安裝的實例）。
//   CHANGELOG.md 不存在、或裡面沒有 05 那一節時，退回讀舊格式——升級到一半的實例不會因此失去提醒。
//   ⚠ 來源專案實際遇過：changelog 搬家後提醒還在讀 05 本體，本體已經沒有任何日期行，提醒從此靜默、
//   沒人發現（靜默＝「看起來沒到期」，跟真的沒到期分不出來）。
//
// ⚠ 取「日期最大」，不是「檔案裡最後一筆」：changelog 有人新的寫在最上面、有人寫在最下面，
// 取最後一筆時，新的在上就會一直拿到最舊的那次，提醒永遠不歸零（來源專案實際發生過，
// 逾期提醒卡在同一個舊日期 53 天，健檢跑完照樣喊）。
// ⚠ 只認專用標記，不從自由文字猜：「健檢執行：結論正常」跟「健檢執行：改為每月一次」字面上一模一樣，
// 文字判準（先是黑名單、後是白名單）連續四輪審查都被找到誤認或繞法。改制度的人不會順手打出
// 【健檢執行】這個標記，所以只認它。基準日依序取：帶標記紀錄的最大日期 → FALLBACK_BASE_DATE →
// 該節（或舊格式整份）最早的日期。代價：沒有標記的舊紀錄不算，升級後改用最早日期起算，逾期就提醒（安全方向），
// 跑一次 /harness:review 就會寫入帶標記的紀錄而歸零。
// 規則本身＝「距上次**執行**健檢超過 N 天」，不是「距上次改健檢制度」。
//
// 失敗時必須 loud（印 ERROR 到 stdout），但不得中斷 session——SessionStart hook 沒有「擋」的語意，
// 只有「有沒有印提醒」。找不到檔案或抓不到日期 → 靜默放行，不印任何東西（避免新專案第一次跑就噴錯）。
// fail-open：任何例外一律放行。
//
// 測試專用：環境變數 HARNESS_TODAY（格式 YYYY-MM-DD）可覆寫「今天」，只供 probe-hooks.js 與健檢實測使用；
// 正常執行不設這個變數，一律用系統當下時間。

const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 提醒門檻（天）。對應 Phase 3 使用者答的健檢週期（沒特別要求就用預設 30）。
const THRESHOLD_DAYS = 30;
// 健檢紀錄檔（新格式，相對於本檔所在的 .claude/hooks/）與它裡面記健檢的那一節的標題（`## ` 後面的字）。
const LOG_FILE = path.join(__dirname, '..', 'harness', 'CHANGELOG.md');
const LOG_SECTION = '05-knowledge-protocol.md';
// 舊格式：changelog 還寫在指令檔本體時的位置。LOG_FILE 不存在或沒有 LOG_SECTION 那一節時才讀它。
// 同時也是健檢清單本身所在的檔（提醒訊息指給使用者看的是它）。
const LEGACY_LOG_FILE = path.join(__dirname, '..', 'harness', '05-knowledge-protocol.md');
// 找不到任何一筆帶【健檢執行】標記的紀錄時使用的基準日（例：專案該制度檔的建立日）。
// 留空字串時改用紀錄裡最早的日期；連一筆日期式條目都沒有才靜默放行（見下方判斷）。
const FALLBACK_BASE_DATE = '';
// ────────────────────────────────────────────────────────────────────────────

// 認得：`- 2026-10-01 【健檢執行】/harness:review：結論…`（標記緊接在日期後面）。
// 不認：沒有標記的任何寫法（`健檢執行：…`、`制度健檢（/harness:review）執行：…` 這類舊格式也不認）、
// 標記不在日期後面一開頭的（`- 2026-10-01 改健檢清單：說明【健檢執行】標記怎麼寫`）。
const RAN = /^- \d{4}-\d{2}-\d{2}\s+【健檢執行】/;

// 取 `## <title>` 那一節的內文（到下一個 `## ` 標題或檔尾）；沒有這一節回 null。
// 用逐行比對而不是 /m 的 `$`：multiline 的 `$` 每行結尾都成立，非貪婪比對會在第一行就提早收尾。
function sectionOf(text, title) {
  const lines = text.split('\n');
  const want = '## ' + title;
  const start = lines.findIndex((l) => l.replace(/\s+$/, '') === want);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

try {
  // 先找新格式；沒有檔、或檔裡沒有 05 那一節，才退回舊格式（整份 05 本體）。
  let lines = null;
  let source = null;
  const logText = readIfExists(LOG_FILE);
  if (logText !== null) {
    const sec = sectionOf(logText, LOG_SECTION);
    if (sec) { lines = sec; source = { file: LOG_FILE, section: LOG_SECTION }; }
  }
  if (!lines) {
    const legacy = readIfExists(LEGACY_LOG_FILE);
    if (legacy === null) process.exit(0); // 兩處都沒有 → 靜默（新專案、或紀錄檔尚未建立）
    lines = legacy.split('\n');
    source = { file: LEGACY_LOG_FILE, section: null };
  }
  lines = lines.filter((l) => /^- \d{4}-\d{2}-\d{2}/.test(l));

  // 先在真實的健檢紀錄裡取日期最大的一筆；一筆都沒有才退回 FALLBACK_BASE_DATE。
  // 備援日期不參與比大小：它比真實紀錄晚時，會把真實紀錄蓋掉、延後提醒。
  let base = null;
  for (const l of lines) {
    const m = l.match(/^- (\d{4}-\d{2}-\d{2})/);
    // YYYY-MM-DD 字串比大小＝日期比大小
    if (m && RAN.test(l) && (!base || m[1] > base)) base = m[1];
  }
  // 沒有任何帶標記的紀錄：先用 FALLBACK_BASE_DATE，再退到紀錄裡最早的日期（通常是制度檔建立日）。
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
    const relp = (p) => path.relative(process.cwd(), p) || p;
    console.log(
      `[health-check] 距上次制度健檢已 ${days} 天（基準 ${base}，門檻 ${THRESHOLD_DAYS} 天；紀錄來源 ${relp(source.file)}`
      + (source.section ? ` 的「## ${source.section}」節` : '') + '）——'
      + `應主動向使用者提議一輪健檢（檢查清單見 ${relp(LEGACY_LOG_FILE)}；跑法 /harness:review）。`
    );
  }
} catch (e) {
  // 檔案不存在／讀不到日期 → 靜默（新專案、或健檢紀錄檔尚未建立時，噴錯反而擾民）。
  // 只有「檔案存在但解析邏輯本身炸掉」才 loud 印錯，提示 hook 鏽蝕要修。
  if (e && e.code !== 'ENOENT') {
    console.log(`[health-check] ERROR: reminder 故障——${e.message}（hook 鏽蝕要修，勿靜默忽略）`);
  }
}
