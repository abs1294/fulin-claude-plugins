#!/usr/bin/env node
/**
 * checkTermOrder（鐵則 4 代號先用後定義、鐵則 15 術語首次出現沒有說明）的測試。
 * 由來：簡報第 2 頁「建議方案 B」，「方案 B」第 18 頁才定義，讀者看到第 2 頁就關了，舊規則沒抓到。
 * 用法：node hooks/tests/term-order.test.js
 */
const path = require('path');
const core = require(path.join(__dirname, '..', 'lib', 'readability-scan.core.js'));
let pass = 0, fail = 0;
function t(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  → ' + JSON.stringify(detail)}`);
  ok ? pass++ : fail++;
}
// pages：[[第 1 頁的段落…], [第 2 頁…], …]
const deck = (pages) => pages.flatMap((ps, i) => ps.map((p) => ({ t: p, page: i + 1, where: `第 ${i + 1} 頁` })));
const run = (pages) => core.checkTermOrder(deck(pages));
const has = (arr, s) => arr.some((x) => x.includes(s));

let r = run([['封面'], ['建議方案 B：留在現有系統自建'], ['細節'], ['方案 B：存去識別化明細']]);
t('方案 B 第 2 頁先用、第 4 頁才定義 → 提醒（不擋）', has(r.notes, '「方案 B」第 2 頁首次出現，第 4 頁才定義'), r);

r = run([['封面'], ['建議方案 B（我方建議的改法：存去識別化明細）']]);
t('第一次出現就用括號說明 → 不報', !has(r.notes, '先用後定義'), r);

r = run([['建議走方案 B'], ['方案 B＝把規則收成一處']]);
t('定義在下一頁 → 照樣提醒', has(r.notes, '「方案 B」第 1 頁首次出現，第 2 頁才定義'), r);

r = run([['推薦 B 案漸進式'], ['結論']]);
t('「B 案」全文找不到定義 → 只提醒（可能是定義句型沒認出來），訊息照原文寫「B 案」', !has(r.bad, 'B 案') && has(r.notes, '「B 案」第 1 頁首次出現，全文沒有定義'), r);

r = run([['「只搬檔案」＝C 案：換套件、切模組邊界'], ['只搬檔案（C 案）']]);
t('「X＝C 案」定義在前 → 不報', !has(r.notes, 'C 案'), r);

r = run([['情境 1：登入成功', '情境 2：登入失敗'], ['情境 1 與情境 2 都通過']]);
t('段首「情境 1：…」標籤 → 算定義', !has(r.notes, '情境'), r);

r = run([['E1', 'user_daily_activity', 'E2', 'legacy_fallback'], ['E1 要改名']]);
t('圖卡標籤格「E1」＋下一格名稱 → 算定義', !has(r.notes, 'E1'), r);

r = run([['C1 PostHog', 'C2 Matomo'], ['推薦 C2']]);
t('表格列首「C1 PostHog」→ 算定義', !has(r.notes, 'C1') && !has(r.notes, 'C2'), r);

r = run([['問題見 C1 與 C2'], ['C1 PostHog', 'C2 Matomo']]);
t('一套字母編號先用、下一頁才標示 → 只提醒（排程、條款常這樣寫）', !has(r.bad, 'C1') && has(r.notes, '「C1」第 1 頁首次出現，第 2 頁才定義'), r);

r = run([['採用 M3 晶片的筆電'], ['結論']]);
t('只有一個的字母編號（型號）→ 只提醒、不擋', !has(r.bad, 'M3') && has(r.notes, 'M3'), r);

r = run([['Q3 營收', 'A4 紙本'], ['結論']]);
t('白名單（Q3、A4）不報', !has(r.notes, 'Q3') && !has(r.notes, 'Q3') && !has(r.notes, 'A4'), r);

r = run([['規格寫 (g1) 有問題'], ['(g1)', '匯出即清會重複計數', '(g2)', 'NULL 分裂']]);
t('括號編號先用、下一頁才標示 → 只提醒', !has(r.bad, '(g1)') && has(r.notes, '「(g1)」第 1 頁首次出現，第 2 頁才定義'), r);

r = run([['後端做 UPSERT 累加'], ['結論']]);
t('術語首次出現沒有說明 → 鐵則15 提醒（不擋）', has(r.notes, 'UPSERT（第 1 頁）') && !has(r.bad, 'UPSERT'), r);

r = run([['後端做 UPSERT（有就累加、沒有就新增）'], ['再次 UPSERT']]);
t('術語首次出現就有中文括號說明 → 不提醒', !has(r.notes, 'UPSERT'), r);

r = run([['使用者所屬團隊（user_team）要從哪取']]);
t('「中文（術語）」寫法 → 算有說明', !has(r.notes, 'user_team'), r);

r = run([['AGENDA'], ['ANALYSIS & SELECTION · 2026-10-02'], ['內容']]);
t('純英文大寫的裝飾標題 → 不當術語', !has(r.notes, 'AGENDA') && !has(r.notes, 'ANALYSIS'), r);

r = run([['頁首 UPSERT 系統名稱說明', '內文'], ['頁首 UPSERT 系統名稱說明', '內文'], ['頁首 UPSERT 系統名稱說明', '內文']]);
t('出現 3 次以上的頁首頁尾 → 不算第一次出現', !has(r.notes, 'UPSERT'), r);

r = run([['PDF 與 Excel 檔、API 文件']]);
t('一般用語白名單（PDF、Excel、API）不提醒', !has(r.notes, 'PDF') && !has(r.notes, 'API'), r);

// 審查回饋的誤擋情境
r = run([['方案 A', '保守成長策略', '方案 B', '積極擴張策略'], ['結論']]);
t('「方案 A」單獨一行、下一行是方案名 → 算定義', !has(r.notes, '方案'), r);
r = core.checkTermOrder(core.unitsFromText(['方案 A', '保守成長策略', '方案 B', '積極擴張策略', '結論']));
t('docx：方案標題＋下一段方案名 → 算定義', !has(r.notes, '方案'), r);
r = core.checkTermOrder(core.unitsFromText(['請確認 (a)資料完整、(b)格式正確。']));
t('句中列舉 (a)(b) → 不當代號擋', !has(r.notes, '(a)'), r);
r = core.checkTermOrder(core.unitsFromText(['檢查項目包括 (a) 資料完整與 (b) 格式正確']));
t('句中列舉 (a) 空一格再接內容 → 不擋', !has(r.notes, '(a)'), r);

r = core.checkTermOrder(core.unitsFromText(['## 方案 A　照規格原樣做', '內容', '## 方案 B　我方建議', '內容']));
t('標題「方案 A　照規格原樣做」（全形空白接名稱）→ 算定義', !has(r.notes, '方案'), r);
r = core.checkTermOrder(core.unitsFromText(['| 情境 | 說明 |', '| 情境 1 | 登入成功 |', '| 情境 2 | 登入失敗 |']));
t('Markdown 表格「| 情境 1 | 登入成功 |」→ 算定義', !has(r.notes, '情境'), r);
r = core.checkTermOrder(core.unitsFromText(['| 項目 | 方案 A | 方案 B |', '| 存法 | 只存統計 | 存明細 |']));
t('表頭列「| 項目 | 方案 A | 方案 B |」→ 算定義', !has(r.notes, '方案'), r);
r = core.checkTermOrder(core.unitsFromText(['Phase 1 預計 10 月完成', 'Phase 2 預計 12 月完成']));
t('「Phase 1 預計 10 月完成」列首接說明 → 算定義', !has(r.notes, 'Phase'), r);
r = core.checkTermOrder(core.unitsFromText(['預計 W3 上線', 'a', 'b', 'c', 'd', 'W1 需求', 'W2 開發', 'W3 測試']));
t('週次編號先用後列表 → 只提醒', !has(r.bad, 'W3'), r);
r = core.checkTermOrder(core.unitsFromText(['建議方案 B', '', '', '', '', '方案 B：存明細']));
t('空白段不算距離：中間只有空段 → 不報', !has(r.notes, '方案 B'), r);

r = core.checkTermOrder(core.unitsFromText(['**方案 A**：保守成長策略', '內容']));
t('Markdown 粗體標籤「**方案 A**：…」→ 算定義', !has(r.notes, '方案'), r);
r = core.checkTermOrder(core.unitsFromText(['We recommend Option A (retain the existing system).']));
t('英文括號說明「Option A (retain …)」→ 算定義', !has(r.notes, 'Option'), r);
r = run([['方案 A：保守成長策略'], ['方案 A：保守成長策略'], ['方案 A：保守成長策略'], ['建議採用方案 A。']]);
t('跨頁重複的定義（像頁首）→ 仍算定義，後面使用不擋', !has(r.notes, '方案'), r);

r = core.checkTermOrder(core.unitsFromText(['方案 A 為沿用現行流程，方案 B 為改用雲端。', 'a', 'b', 'c', 'd', '方案 B：細節']));
t('句中「方案 B 為…」→ 算定義，後面再出現不擋', !has(r.notes, '方案'), r);
r = core.checkTermOrder(core.unitsFromText(['共有兩案，方案 A：沿用現行；方案 B：改用雲端。', 'a', 'b', 'c', 'd', '方案 A：細節']));
t('標點後「方案 A：…」→ 算定義', !has(r.notes, '方案'), r);
r = core.checkTermOrder(core.unitsFromText(['Plan A is to keep the current flow; Plan B is to migrate.', 'a', 'b', 'c', 'd', 'Plan B: details']));
t('英文「Plan B is …」→ 算定義', !has(r.notes, 'Plan'), r);
r = core.checkTermOrder(core.unitsFromText(['本報告共驗證三個情境：情境 1 登入、情境 2 查詢、情境 3 匯出。']));
t('總覽句列出情境（全文無正式定義）→ 不擋', !has(r.bad, '情境'), r);
r = run([['建議方案 B：留在現有系統自建'], ['細節'], ['方案 B：存去識別化明細']]);
t('「建議方案 B：…」接在一般文字後面不算定義 → 第 3 頁才定義仍提醒', has(r.notes, '「方案 B」第 1 頁首次出現，第 3 頁才定義'), r);

r = run([['建議方案 B：留在現有系統', '方案 B 怎麼做'], ['細節'], ['方案 B：存去識別化明細']]);
t('小標「方案 B 怎麼做」是疑問，不算定義 → 第 3 頁才定義照樣提醒', has(r.notes, '「方案 B」第 1 頁首次出現，第 3 頁才定義'), r);

// 代號先用後定義只提醒、從不擋交付（兩軌審查三輪找到的正常寫法，都不可進 bad）
const fpCases = [
  [['本報告將方案 A 定義為保留現有系統。'], ['成本分析'], ['方案 A：保留現有系統。']],
  [['「方案 A」是保留現有系統。'], ['成本分析'], ['方案 A：保留現有系統。']],
  [['本報告共驗證三個情境：情境 1 登入、情境 2 查詢、情境 3 匯出。'], ['測試方法'], ['情境 1：登入']],
  [['我們建議採用方案 B，也就是改用雲端架構。'], ['細節'], ['方案 B 的費用較高']],
  [['本專案 Phase 1 先做資料串接，Phase 2 再做報表。'], ['細節'], ['Phase 2 預計 12 月完成。']],
  [['建議方案 B'], ['細節'], ['方案 B：存明細']],
];
t('代號先用後定義任何情況都不進硬缺陷', fpCases.every((pg) => run(pg).bad.length === 0), fpCases.map((pg) => run(pg).bad));

// 沒有頁的格式：前後 3 段內定義算數
const flat = core.unitsFromText(['建議方案 B', '其他', '方案 B：存明細']);
r = core.checkTermOrder(flat);
t('docx／md：3 段內定義 → 不報', !has(r.notes, '方案 B'), r);
const flat2 = core.unitsFromText(['建議方案 B', 'a', 'b', 'c', 'd', '方案 B：存明細']);
r = core.checkTermOrder(flat2);
t('docx／md：隔 5 段才定義 → 提醒，位置寫第 N 段', has(r.notes, '「方案 B」第 1 段首次出現，第 6 段才定義'), r);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
