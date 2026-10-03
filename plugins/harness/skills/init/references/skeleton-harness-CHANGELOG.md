# harness 變更紀錄

<!-- init 填空紀律（實例化後整段刪除）：
  - 落點＝`<落點>/.claude/harness/CHANGELOG.md`。
  - 每個 init 實際建立的 harness 檔留一節；沒建的檔不留節（01、06 由 05 §7 觸發建立時再加節）。
  - 03 那一行的條款數照實例實際的條款寫（不適用的條款保留編號，仍算在內）。
  - `health-check-reminder.js` 讀本檔的 `## 05-knowledge-protocol.md` 節算上次健檢日：節標題一個字都不能改。
-->

> 本目錄各檔的變更紀錄，依檔名分節。指令檔本身不放 changelog 節——它們每次載入都整份進 context，紀錄放在檔裡只會越長越胖（規格見 `05-knowledge-protocol.md` §4）。
> 格式：`- <YYYY-MM-DD> <改了什麼一句話>（<經使用者同意｜黃區自主｜綠區>）`。新的寫在節的最上面或最下面，照本檔既有的慣例，不混用。只寫現行狀態的變更事實，不寫心路歷程。
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
