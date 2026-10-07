# harness 變更紀錄

<!-- init 填空紀律（實例化後整段刪除）：
  - 落點＝`<落點>/.claude/harness/CHANGELOG.md`。
  - 每個 init 實際建立的 harness 檔留一節；沒建的檔不留節（01、06 由 05 §7 觸發建立時再加節；07 註解規範在 init 選「建」或「沿用」時才有節，「沿用」時這一節記的是既有文件的路徑）。
  - 03 那一行的條款數照實例實際的條款寫（不適用的條款保留編號，仍算在內）。
  - `health-check-reminder.js` 讀本檔的 `## 05-knowledge-protocol.md` 節算上次健檢日：節標題一個字都不能改。
-->

> 本目錄各檔的變更紀錄，依檔名分節。指令檔本身不放 changelog 節——它們每次載入都整份進 context，紀錄放在檔裡只會越長越胖（規格見 `05-knowledge-protocol.md` §4）。
> 格式：`- <YYYY-MM-DD> <改了什麼一句話>（起因：<哪件事讓它需要改，一句>；<經使用者同意｜黃區自主｜綠區>）`——起因寫觸發這次改動的事實，不寫「原本 X 後來改成 Y」的心路歷程（兩者的分別見 05 §4）。新的寫在節的最上面或最下面，照本檔既有的慣例，不混用。
> **健檢紀錄**只寫在 `## 05-knowledge-protocol.md` 節，寫法 `- YYYY-MM-DD 【健檢執行】/harness:review：<一句話結論>`——【健檢執行】標記緊接在日期後面，健檢到期提醒只認這個標記、取日期最大的那一筆。手動跑健檢也照這個寫法記；改健檢清單、改制度的紀錄不准用這個標記。

## README.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

## 02-model-dispatch.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

## 03-judgment-matrix.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化；骨架 0.10.0＝A1-A9／B1-B25／C1-C9 共 43 條，不適用者保留編號改寫為「本專案不適用」；新條款等本專案踩坑再依 05 §6 升格{{；參考模式 Q8 升格了原有規矩的經驗時加：＋矩陣 D 共 N 條經驗條款，出自原有規矩}}）

## 04-delegation-templates.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

## 05-knowledge-protocol.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

{{註解規範那一題：選「建」保留下面這一節、刪掉本行；選「沿用」也保留，節標題改成「## 07-comment-guide.md（沿用 <既有文件路徑>）」、那一行的「建立」改成「沿用專案既有的註解規範 <路徑>，init 只引用、不改內容」（init 依使用者同意在既有文件補了「編譯器或 linter 要求一定要寫 doc 註解時」一節時，改成「沿用專案既有的註解規範 <路徑>，init 補上「編譯器或 linter 要求一定要寫 doc 註解時」一節」；日期照填），刪掉本行；選「不建」才連同本行把下面兩行一起刪掉}}
## 07-comment-guide.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

{{有產生本機覆寫說明時保留下面兩行、刪掉本行；沒有就連同本行一起刪}}
## local-overrides-guide.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

{{動手前必讀那一題有規則檔選「精煉成自有正本」時保留下面兩行、刪掉本行；沒有就連同本行一起刪}}
## review-rules.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化；精煉自 <原檔路徑>，原檔版本 <commit 或日期>）
