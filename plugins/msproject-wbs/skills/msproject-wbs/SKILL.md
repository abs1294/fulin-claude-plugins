---
name: msproject-wbs
description: >
  產生 MS Project 可直接匯入的 WBS 專案時程 XML（MSPDI 格式），第一層功能模組、第二層工項，
  含工期、負責資源、前置依賴、資源指派，日期照依賴鏈自動展開成甘特圖。
  當使用者要「WBS」「工作分解」「專案時程」「開發排程」「甘特圖」「MS Project 檔」「.mpp/.xml 時程」
  「排一份 N 天 / N 人的開發計畫」「by 功能 / by 工項排時程」時觸發。
  **只要使用者要的是「能匯入 MS Project 的時程表」就用這個 skill**——手刻 MSPDI XML 極易踩雷
  （打不開 / 日期全塌 / 工期顯示 0），本 skill 把這些坑全部編碼進生成腳本，一次到位。
---

# MS Project WBS 產生器

產生 **MSPDI XML**（MS Project 的匯入格式）。手刻這種 XML 有幾個非踩不可的雷，本 skill 的價值就是把雷全部封在生成腳本裡，讓你只需描述「有哪些工項」，其餘由腳本保證正確。

## 為什麼需要這個 skill（實戰踩過的雷，每個都會讓成果報廢）

親手寫過 MSPDI XML 的都知道，「XML 看起來對」跟「MS Project 打得開且排程正確」是兩回事。

1. **【頭號雷】Task 子元素順序違反 XSD 序列 → 欄位被靜默丟棄**。MSPDI 匯入器嚴格照 schema 序列讀 Task 子元素，**順序不對的欄位不報錯、直接忽略**。經典病徵：`Start`/`Finish` 被放在 `Duration`/`Summary` 之後 → 被丟棄 → **所有任務日期塌到專案起始日，但工期正常顯示**（因為 Duration 剛好在對的位置被讀到）。這個雷極難排查：XML well-formed、PowerShell parser 全過、內容看起來完全正確——只有 MS Project 實際匯入才會露餡。腳本用 `TASK_ORDER` 白名單固定順序（`UID→ID→Name→Type→IsNull→OutlineLevel→Start→Finish→Duration→DurationFormat→Work→Estimated→Milestone→Summary→ConstraintType→ConstraintDate→PredecessorLink→Active→Manual`）並內建順序自檢，違序在生成期就 throw。

2. **缺 Project 層全域欄位 → 直接打不開**。MS Project 期待 `SaveVersion` / `MinutesPerDay` / `DefaultStartTime` / `DurationFormat` / `HonorConstraints` 等一整組全域設定，缺了會判定檔案不完整而拒開。Project 層欄位同樣要照 XSD 序列。腳本已補齊。

3. **日曆 `WorkingTimes` / `WorkingTime` 標籤配對 → XML 非 well-formed**。只差一個 `s`，手拼巢狀極易配對錯，整份解析失敗。腳本用固定正確結構產生。

4. **缺 `ConstraintType` / `ConstraintDate`（或 `HonorConstraints` 沒開）→ 自動排程重算把任務推到「越早越好」**。給每個**葉子任務**加 `ConstraintType=4`（Start No Earlier Than）+ `ConstraintDate=該任務開始日`，Project 層設 `HonorConstraints=1`。**摘要任務不加約束**（日期由子任務彙總，鎖死會打架）。注意：約束欄位放錯位置一樣會被雷 1 吃掉——順序對了約束才存在。

5. **UTF-8 無 BOM → 中文亂碼 / 解析失敗**。Windows 上無 BOM 的 UTF-8 中文 XML 會被用系統 ANSI 誤判。輸出加 UTF-8 BOM。

6. **工期顯示 0 天**：`Duration` 要配對應的 `Work` 欄，MS Project 才算得出天數。

7. **負責人別塞 `Notes`**：用 **Resource + Assignment**（資源指派），甘特圖「資源名稱」欄才會正確顯示；Notes 塞字在表格上是又醜又錯位的「標記」欄。

## 使用流程

### 1. 蒐集 WBS 內容

跟使用者確認這些（能從對話推出的就自己填，缺的一次問完）：

- **功能模組清單**（第一層）+ 每個模組底下的**工項**（第二層）。
- 每個工項的：**工期（天，建議 ≤3 天一項）**、**負責資源**（如後端 / 前端 / QA）、**前置依賴**（此工項要等哪個工項完成才能開始）。
- **專案起始日**、**資源清單**（有哪幾種角色）、**單人或多人並行**（多人時各資源各一條時間線，工項起始 = max(該資源空閒日, 依賴完成日)）。
- **截止日**（若有）——算完總工期後主動比對「排出來的完成日 vs 截止日」，塌不進要老實講、給選項（加人 / 縮範圍 / 接受真實排程），不要灌水硬塞。

> 工項若能抄既有系統 / 既有畫面已存在，工時要據實壓低（別當全新開發估）；估時基準講清楚寫進交付說明。

### 2. 填生成腳本

複製 `scripts/generate-wbs.mjs`，**只改頂部的 `MODULES` 陣列**（模組 + 工項 + 工期 + 資源 + 依賴）與 `START` / `RESOURCES` / `OUT`。腳本內的排程演算法、MSPDI 框架、四個雷的處理**不要動**——那是本 skill 的核心價值。

工項物件格式（見腳本內註解）：
```
{ id:'唯一id', name:'工項名(純中文,不放代號)', d:工期天數, res:'資源key', dep:'前置工項id' }
```

**任務名只放純中文**——別放 `M1` / `B1-2` 這種模組序 / 需求編號代號，使用者看不懂。分組資訊由「模組（第一層摘要任務）」承載即可。

### 3. 執行 + 驗證（必做，別跳）

```bash
node scripts/generate-wbs.mjs
```

產出後**兩層驗證都要做**——注意：`[xml]` 只驗 well-formed，**驗不到元素順序**（雷 1），所以第二段順序檢查不可省：

```powershell
$f = "<輸出的 xml 絕對路徑>"
try {
  [xml]$x = Get-Content -Raw -Path $f
  "OK well-formed | Task: " + $x.Project.Tasks.Task.Count + " | Resource: " + $x.Project.Resources.Resource.Count + " | Assignment: " + $x.Project.Assignments.Assignment.Count
  # 雷1 檢查：每個 Task 子元素順序必須遞增於 XSD 序列（違反 = MS Project 靜默丟欄位）
  $order = @('UID','ID','Name','Type','IsNull','OutlineLevel','Start','Finish','Duration','DurationFormat','Work','Estimated','Milestone','Summary','ConstraintType','ConstraintDate','PredecessorLink','Active','Manual')
  $bad = 0
  foreach ($t in $x.Project.Tasks.Task) {
    $last = -1
    foreach ($c in $t.ChildNodes) {
      $i = $order.IndexOf($c.Name)
      if ($i -lt 0 -or $i -lt $last) { $bad++; "❌ UID $($t.UID) 欄位 $($c.Name) 順序違規"; break }
      $last = $i
    }
  }
  "順序違規 Task 數(要0): $bad"
  "HonorConstraints(要1): " + $x.Project.HonorConstraints
  "葉子約束數(要=工項數): " + ($x.Project.Tasks.Task | Where-Object { $_.ConstraintType }).Count
  "摘要有約束數(要0): " + ($x.Project.Tasks.Task | Where-Object { $_.OutlineLevel -eq '1' -and $_.ConstraintType }).Count
} catch { "XML ERROR: " + $_.Exception.Message }
```

**驗收標準**（全中才算好）：
- `OK well-formed` 且 **順序違規 Task 數 = 0**（順序違規就是雷 1，交付出去日期必塌）
- `HonorConstraints = 1`；葉子約束數 = 工項數、摘要約束數 = 0
- 抽查幾個葉子任務的 `Start`/`ConstraintDate`：應是**展開的**日期（第一項在起始日、最後一項在完成日附近），不是全擠在起始日

> 用 Bash grep / node 簡易正則**驗不準** MSPDI（`<Task>` vs `<Tasks>`、多層巢狀會誤判）。一定用 PowerShell `[xml]`。
> **誠實原則**：以上驗證仍屬「靜態檢查」，最終判準是 MS Project 實際匯入的畫面——交付時請使用者匯入確認「日期展開、工期天數、資源名稱」三點，不要在使用者確認前宣告成功。

### 4. 交付

告訴使用者檔案路徑、起訖日、總工項數、每工項 ≤N 天。若有截止日，明說「排出來 vs 截止日」是否塌得進。提醒匯入後應看到：任務名純中文、有工期天數、資源名稱欄顯示負責人、甘特圖依日期展開。

## 常見追加需求

- **改任務名 / 去代號**：只改 `MODULES` 的 `name`，重跑。
- **加人並行 / 改工期**：改 `RESOURCES` 與工項的 `res`/`d`，重跑（腳本自動依資源排時間線）。
- **使用者說「打不開 / 日期全塌 / 工期 0」**：對照上面「四個雷」逐一查——幾乎都是某個欄位缺了。用 PowerShell parser 定位。若是既有檔要修，先跑 parser 找出是哪個雷，再針對性補（打不開通常是雷 1/2，日期塌是雷 3）。
