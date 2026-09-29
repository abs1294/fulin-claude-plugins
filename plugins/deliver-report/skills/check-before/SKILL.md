---
name: check-before
description: >
  交付前對「使用者指定的一份文件」做易讀性自檢：跑十項機械掃描（編號連續、未定義代號、
  交叉引用、重複、異動紀錄用語、樣式一致、表格欄寬、內部推導痕跡、公文式敬稱、目錄頁碼），並擋 AI 工具名稱再加四條人工判斷，
  回報要改的地方；pptx／docx／pdf 另做視覺檢查（用 PowerPoint／Word 實際排版，抓疊字、字跑出方塊、
  超出頁面、字太小，每頁輸出圖片逐張看過）。支援 .docx / .pptx / .md / .txt / .pdf，Windows／macOS／Linux 都能跑。
  **需要使用者給檔案路徑或檔名**，沒給就先問。
  當使用者說「check-before」「交付前檢查這份」「幫我自檢 XXX.docx」「這份文件可以交了嗎」
  「掃一下這份文件的易讀性」「簡報有沒有疊字」「檢查投影片跑版」時觸發。
  只檢查、不改檔；要改由使用者確認後另外做。要寫交付訊息走 deliver-report，要產確認清單走 to-checklist。
---

# check-before：交付文件自檢

對使用者點名的一份文件，照 `../../references/document-readability.md` 的鐵則做交付前檢查。
判準與 Stop hook（`hooks/doc-readability-gate.js`）是**同一份程式**（`hooks/lib/readability-scan.core.js`），
所以這裡過了，交付時的自動閘也會過。差別：這裡由使用者點名、任何格式（docx／pptx／md／txt／pdf）都能查，
且對 docx 多跑三項（重複偵測、內部推導痕跡、Markdown 標題編號）——Stop hook 掃 docx 時不跑這三項，避免交付時多出判不準的提醒。
其他 subskill 已經把這支腳本接進自己的腳本裡，會自動跑：to-checklist 在 `md_to_pdf.py` 轉檔前、test-report-docx 在 `report_gate.verify_docx()`（閘三）、daily-report 在寄送前置流程（`send_common.prepare_send`，MCP 草稿路徑除外）。deliver-report 沒有產檔腳本，docx 由 Stop hook 掃，其他格式手動跑這支。

## 流程

1. **確定檢查哪一份**：使用者給了路徑或檔名就用；沒給就問「要檢查哪一份檔案？給路徑或檔名都可以」，**不要自己猜最近改過的檔**。

2. **跑機械掃描＋視覺檢查**：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/check-before/scripts/check_doc.js" "<路徑或檔名>" --visual
   ```
   - 只給檔名時，腳本從目前目錄往下找（最多 6 層）；檔名可省略副檔名。
   - `--visual` 讓 docx／pdf 也跑視覺檢查（pptx 不加也會跑）；md／txt 沒有版面，不跑。
   - **exit 2**＝找不到、有多份同名候選、讀不到內容，或**要跑視覺檢查卻沒有排版軟體**。把腳本訊息原樣給使用者，不可回報「通過」。
   - **exit 1**＝有硬缺陷；**exit 0**＝硬缺陷 0（可能仍有提醒）。
   - 以「視覺」開頭的項目來自視覺檢查，見下方「視覺檢查」一節。

3. **逐張看每頁畫面**（有跑視覺檢查時）：腳本最後列出每頁的 PNG（問題處有紅框）。**每一張都用 Read 打開**，
   在回報裡逐頁寫一句看到什麼：有沒有疊字、被切掉、空白、字擠成一團。
   - 機器只判得準「字形互相壓到」；SmartArt、圖片裡的字、文字轉外框、字壓在圖案上，只有看圖才抓得到。
   - 總覽圖 `overview.png` 只當索引，縮圖看不出細微疊字，不能代替逐張看。
   - **Stop hook（`hooks/visual-view-gate.js`）會檢查**：清單上的每一張都要在清單印出後被 Read 過，漏看就擋下收尾。

4. **人工判斷四條**（機器判不了，逐條讀過文件再下判斷，不能跳）：
   - 鐵則 1：讀者是否要兩邊對照才能做完一件事？
   - 鐵則 2：同一件事的資訊是否散在正文與備註兩處？
   - 鐵則 6：有沒有「待確認」其實我方自己查得到？
   - 鐵則 10：有沒有機械性步驟該給腳本、卻叫對方手動做？

5. **逐條判斷腳本的「提醒」**：重複內容、推導痕跡、敬稱都是判不準的項目——搜到不等於要改。每條講清楚「要改／不用改，因為…」。
   腳本報的硬缺陷也要先確認**是文件錯還是檢查器錯**（檢查器會過時，踩過）。

6. **回報**，照這個結構：
   - 檔案、格式、段落數
   - **要改的**：每項附位置（章節或原句片段）與建議改法
   - **看過不用改的**：提醒項為什麼放行
   - **每頁畫面**：逐頁一句看到什麼（視覺檢查有跑時）
   - **這次沒檢查到的**：md／pdf 不跑樣式一致與表格欄寬（沒有字級、欄寬資訊），請使用者目視或改用 docx 檢查；pdf 若是掃描圖檔沒有文字層，腳本會 exit 2；
     視覺檢查用的不是對方實際的軟體時（Keynote、LibreOffice），要明講版面問題都只是提醒、需在 PowerPoint／Word 確認
   - 兩份以上文件一起交付時，加做**跨文件一致性**：步驟數、項數、數字宣稱值兩份要一致

7. **不改檔**。使用者說要改再改，改完**同一類問題全文重掃**，再跑一次本腳本確認歸零。

## 視覺檢查（`scripts/visual_check.py`）

**先排版、再判定**。排版交給對方實際會用的軟體，換行、字型替換、自動縮小文字才會跟對方看到的一樣：

| 檔案 | Windows | macOS | Linux |
|------|---------|-------|-------|
| pptx | PowerPoint → LibreOffice | PowerPoint → Keynote → LibreOffice | LibreOffice |
| docx | Word → LibreOffice | Word → LibreOffice | LibreOffice |
| pdf | 不必排版 | 不必排版 | 不必排版 |

前一個失敗（沒裝、開檔失敗、逾時）就換下一個，原因記在提醒裡；全都沒有 → exit 2（視覺未驗證）。
Keynote 與 LibreOffice 不是對方實際的軟體：字寬不同，換行位置跟著不同（實測兩份真實簡報，PowerPoint 0 處疊字、LibreOffice 各多 6～7 處，都是標題最後一個字被擠到下一行）。
所以用它們排版時，疊字、字跑出方塊、超出頁面**一律降為提醒**，標「PowerPoint 可能正常，請在 PowerPoint 確認」，紅框照畫、圖照樣逐張看；「溢出時縮小文字」改從檔案記錄的縮小比例推算 PowerPoint 會顯示的字級。
只關掉檢查器自己開的 PowerPoint／Word——使用者本來就開著的不會被關。
macOS 第一次跑會跳「允許終端機控制 PowerPoint／Keynote」，要有人按允許（系統設定 → 隱私權與安全性 → 自動化）。

判定只有一份，讀排版後每個字實際畫出來的位置：

| 項目 | 判準 | 等級 |
|------|------|------|
| 疊字 | 兩行字形互相壓到，面積超過較小那行的 5%；同一段字疊兩層（重複貼上）也算 | 硬缺陷 |
| 字跑出方塊外 | pptx 有底色或框線的方塊，裡面的字畫到方塊外（看不見的文字方塊不算，撞到別的字時由疊字抓） | 硬缺陷 |
| 超出頁面 | 字畫在頁面外；pptx 有字卻沒出現在畫面上（被裁掉、表格撐出投影片） | 硬缺陷 |
| 字太小 | 實際字級小於 10pt（含「溢出時縮小文字」縮出來的）；頁首頁尾這種每頁都有的合併成一條 | 提醒 |
| 文字壓在圖上 | 文字和圖片重疊，整頁背景圖不算（pptx 看真正的圖片物件，方塊的陰影漸層不算） | 提醒 |
| 字型沒內嵌 | pptx 指定的字型沒內嵌，對方電腦沒有就會被替換、換行跟著變（Arial、Calibri 等 Windows 與 Mac 都有的不列） | 提醒 |
| 空白頁、重複頁 | 整頁同一顏色；兩頁畫面完全相同 | 提醒 |

輸出在系統暫存資料夾的 `deliver-report-visual/<檔名>-<時間>/`：`page-NNN.png`、`overview.png`、`rendered.pdf`、`visual-manifest.json`。
回歸測試：`python hooks/tests/visual/run_fixtures.py [--engine powerpoint|keynote|libreoffice]`（12 份測試文件，逐份對照預期）。

## 前置依賴

- Node.js（掃描本體；docx／pptx 用內建 zlib 解壓，不需 PowerShell，各平台都能跑）
- 檢查 docx 的目錄頁碼：Windows 上的 Microsoft Word（唯讀開檔、比對更新目錄前後，不存檔；約 5 秒）。沒有 Word 或非 Windows 會記「目錄頁碼未檢查」，不算通過
- 檢查 pdf 的文字：Python 3 與 `pypdf`（`pip install pypdf`）
- 視覺檢查：Python 3、`pip install pymupdf pillow`，加上排版軟體（見上表）

## AI 工具名稱怎麼擋（不必逐一加名字）

- **品牌族規則**：`references/banned-patterns.json` 的 `ai_tool_names`，一條規則涵蓋整個系列與未來版號（GPT-任意版號、Llama 加數字、Claude／Codex／Gemini…）。
- **本機自動蒐集**：每次掃描時自動讀取本機已安裝的 Claude Code plugin、marketplace、MCP 伺服器名稱（只收含連字號或數字的，如 `deliver-report`、`openai-codex`），以及描述標為 AI／LLM／agent 的全域 npm 工具（如 `codex`、`openspec`）。以後裝了新的 AI 工具，不用改任何設定就會一起擋。
- 一般工具（Playwright、TypeScript、Figma、資料庫 cursor）不會被擋。命中時會印出原字，照提示改寫或刪除。
