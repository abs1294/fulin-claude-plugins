# Changelog

All notable changes to this plugin will be documented in this file.

## [0.2.0] - 2026-09-13

### Added
- **矩陣 B 新增 B9「三種宣稱嚴格分離」**（`skeleton-03-judgment-matrix.md`）：①結構檢查（parse／lint／exit 0）②機器證據（實跑／截圖／量測）③感知審查（人或看得到圖的模型實際看過內容），**通過其中一種不准說成通過另一種**。
  - 附展開段：三層關係圖、五筆真實事故的冒充類型對照（docx parse 過但 Word 判毀損＝①當③、六個子系統 200 全綠但截圖是「连接失败」＝①當③、兩頁截圖 MD5 相同都是登入頁＝②當③、找回密碼頁截到全白＝②當③、只看 grep 命中行判假陽性＝①當③）。
  - 核心：**最危險的不是沒驗，是「驗了低層卻宣稱高層」**——每次複驗都會過（複驗的也是同一層），錯誤穿過所有關卡直到使用者發現。
  - 附帶條款：③ 沒做就明說沒做，不准用 ①② 混過去；**驗證器與施作器不可同源**（同一函式庫寫檔又驗檔，驗證器對寫入器的破壞完全盲——docx 事故的結構性成因）。
  - 改寫自 tt-a1i/archify 的 delivery-contract（MIT）。原版在程式裡強制執行：`visual-check` 的 receipt **永遠回報 `visualReview: "pending"`**，不管截圖多成功就是不准算成「有人看過」。值得學的是這個機制形狀——**不是用規則要求人誠實，而是讓證據本身拒絕被過度解讀**。
  - 使用者裁決放這裡而非只改單一專案實例：「要也是放進 harness init 裡吧」——骨架改了新專案都帶得走，只改 D 檔只有這個 repo 有。
  - 本 repo 的既有實例 `.claude/harness/D-判斷力矩陣.md` 為舊版格式（節 1/2/3），同步在「節 2 完成判準」補等效第 6 條（骨架更新不會回填既有實例）。

## [0.1.0] - 2026-08-19

### Added
- 初版：/harness:init 實例化流程（盤點→決策→骨架填空→機械驗收）、六份通用骨架（CLAUDE.md 路由中心＋harness README＋02~05）、adaptation-guide 改編原則、SessionStart 條件式提醒 hook。骨架抽取自 Supplier_Code harness，以汎銓實例（2026-08-19）為驗收樣本。
