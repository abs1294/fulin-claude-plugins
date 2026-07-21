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

> ⚠️ **貫穿全流程的硬規則：XML 改了，XLSX 必須同輪跟著重生**（若該專案已有交付 XLSX）。
> XLSX 是 XML 的下游轉出物，禁止只更新其一造成漂移。細節與指令見流程 3 的【HARNESS 硬規則】。

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

> ⚠️ **【HARNESS 硬規則】XML 與 XLSX 必須同步更新，禁止只更新其一。**
> 只要因任何原因重跑 `generate-wbs.mjs`（改工項／改資源／改日期／修雷…）而 XML 內容有變，
> **同一輪就必須接著重跑 `mspdi-to-xlsx.py` 重生 XLSX**——只要該專案已產出過交付用 XLSX（見流程 4／常見追加需求），就一律連動，不問是否「這次只是小改」。
> 原因：XLSX 是從 XML 轉出的**下游產物**，兩者一旦不同步，交付出去的 XLSX 就是舊時程（日期／工項對不上 XML 與 MS Project），且此類漂移靜態難察覺。
> 標準連動指令（改完 XML 後照跑）：
> ```bash
> node   scripts/generate-wbs.mjs                                   # 1) 重生 XML
> python scripts/mspdi-to-xlsx.py <輸出.xml> <交付.xlsx>            # 2) 立刻重生 XLSX（同一輪）
> ```
> 收尾自檢：確認 XML 與 XLSX 的 `mtime` 皆為本輪、且工項數一致；不一致代表漏跑步驟 2。

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
- **使用者要 XLSX 交付檔（免手動 MPP 轉檔）**：客戶常把 XML→MS Project→存 MPP→另存 XLSX，得到白底黑字、無階層、難讀。用 `scripts/mspdi-to-xlsx.py` 直接從 MSPDI XML 產出**內容與 MS Project 匯出完全一致**的 XLSX，並額外加階層縮排／層級配色（L1 藍、L2 灰、里程碑黃）／凍結窗格／可摺疊 outline。
  - 執行：`python scripts/mspdi-to-xlsx.py <輸入.xml> <輸出.xlsx>`
  - **內容對等契約**（改動前想清楚）：8 欄＝大綱編號(1/1.1/1.1.1，依 OutlineLevel 累進非 UID)／名稱／工期("N 工作日"＝Duration 時數÷8)／開始時間(「2026年7月27日 上午 08:00」月日不補零、12 小時制)／完成時間／前置任務(PredecessorLink→對應列大綱編號)／資源名稱(摘要列空白)／完成百分比。
  - **驗收**：若客戶已有一份自己轉的 XLSX，用「名稱＋開始日」複合 key 逐欄比對，內容 diff 必須為 0（大綱編號會因模組增減位移，屬正常）。排版只走樣式層，**絕不改欄位字串內容**（不可把工期寫「3 天」、日期改 ISO），否則對不上客戶端匯出結果。
- **使用者要「預計完成%」基準線欄**（依開檔當天算「今天照計畫該完成幾趴」）：**兩邊都能加**——
  - **XLSX 側（已實作＋已驗證，活公式）**：`mspdi-to-xlsx.py` 產出 I 欄「預計完成%」，公式 `=IF(TODAY()<=起,0,IF(TODAY()>=迄,1,已過工作天/總工作天))` 用 `NETWORKDAYS` 算工作天，開檔當天自動重算。
    - **關鍵設計**：D/E「開始/完成日期」存**真 Excel 日期**、只用儲存格格式 `yyyy"年"m"月"d"日"` 顯示成中文——所以畫面是中文日期、底層可運算，I 欄公式**直接引用 D/E**，不需額外輔助欄。（早期版本誤把 D/E 存成中文字串、被迫另開隱藏 J/K 放真日期，是走了冤枉路；日期一律存真值＋格式化顯示。）摘要/里程碑列留空。
  - **XML 側（MSPDI ExtendedAttribute）——公式欄「可以」匯入，且要顯示 % 必須用 Text 欄（已查 Microsoft XSD＋MS Project COM 實測雙重確認）**：
    - **要顯示「54%」→ 必須用 Text 欄，不能用 Number 欄**。MS Project 的 Number 型自訂欄位**沒有百分比顯示格式**（schema 無 Percent 型別、無 Format/Mask 元素）——Number 存 0.54 就永遠顯示 `0.54`。正解：用 **Text1**（FieldID `188743731`，CFType **7**），公式輸出字串：`Format(<fraction>*100,"0") & "%"` → 顯示「54%」。（本 skill 曾誤用 Number1 顯示成 0.54，已改 Text。）
    - **FieldID 別搞錯型別**：`188743731`=Text1（`pjCustomTaskText1`），`188743767`=Number1（`pjCustomTaskNumber1`）。型別（CFType）要與 FieldID 對應，否則 MS Project 當欄位不存在（連欄名都不出現）。
    - **Project 層定義（子元素嚴格照 XSD 序列，違序會被靜默丟）**：`FieldID→FieldName→CFType→…→Alias→…→CalculationType→Formula→…`。本 skill 用的 Text 版：`<FieldID>188743731</FieldID><FieldName>Text1</FieldName><CFType>7</CFType><Alias>顯示名</Alias><CalculationType>2</CalculationType><Formula>IIf([Duration]=0,"",Format(…*100,"0") &amp; "%")</Formula>`。CFType：0=Cost 1=Date 2=Duration 3=Finish 4=Flag 5=Number 6=Start **7=Text**。CalculationType：0=None 1=Rollup **2=Calculation**。**公式欄名用英文中括號**（`[Start]`/`[Finish]`/`[Duration]`），匯入後 MS Project 會自動在地化成 `[開始時間]/[完成時間]/[工期]`。公式內 `&` 要 XML 轉義成 `&amp;`。
    - **Task 層引用**：本 skill 序列放在 `Manual` 之後（實測 well-formed 且 COM 匯入通過）。公式欄由 MS Project 依 Formula 自算，Text 公式欄**不寫 per-task `<Value>`**，只放 `<ValueGUID>00000000-0000-0000-0000-000000000000</ValueGUID>` 標「計算欄」。`ExtendedAttribute` 要加進 `TASK_ORDER` 白名單否則順序自檢 throw。
    - **驗證方式（本機有 MS Project 才行）**：COM round-trip 是終極判準——`New-Object -ComObject MSProject.Application`→`FileOpen(xml)`→`CustomFieldGetName/GetFormula(188743731)`＋逐 Task `GetField(188743731)`。⚠ **兩個實測踩過的坑**：① MS Project 若已開著檔，COM 建立會 `RPC_E_CALL_REJECTED`（0x80010001），要先 `Stop-Process WINPROJ`；② 測「進行中」的值別靠改系統時鐘，改造一份把公式 `Now()` 換成固定中段日期的 probe XML 匯入，讀回值即可驗證非 0（本 skill 用 2026/9/15 驗到 100%/部分%）。
    - **「今天顯示 0% 不是壞掉」**：公式用 `Now()`＝系統時鐘。若專案起始日在未來，今天所有任務都還沒開始→全 0% 是**正確**基準線（「以今天而言照計畫該完成幾趴」）。要看非 0 得等到專案期間、或改系統日期、或用上面的 probe XML。交付時要主動跟使用者講這點，免得誤判成 bug。
    - 出處：Microsoft Learn MSPDI schema（ExtendedAttribute/CFType/Formula element，無 Format/Percent）、`PjCustomField` enumeration、Dale Howard MVP（Number 欄無 % 格式，須 Text＋`Format(...) & "%"`）。
