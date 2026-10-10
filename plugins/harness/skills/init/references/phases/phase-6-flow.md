## Phase 6 — 流程圖：裝了什麼、之後一個需求進來會怎麼跑

**為什麼有這一步**：只給檔案清單，使用者看完仍不知道裝了這些之後，下一個需求進來會發生什麼事、每個東西在哪一步起作用（經過見 `../rationale.md` §Phase 6-1）。所以收尾前畫流程圖，三條硬規則，都由 `scripts/check-flow-diagram.js` 機械檢查：

1. **要畫的清單不是寫死的，是 init 實際動過的檔案**：Phase 0 拍的快照對比現況，新增、修改、刪除的每個檔案都要是某張圖上的一個節點（`label` 含它的名字）。只寫在卡片、線上文字或 sublabel 都不算——卡片是圖外清單，看不出在哪一步（經過見 `../rationale.md` §Phase 6-2）。
2. **每個節點都要有線**，線上標關係：讀、寫、擋、觸發、載入。只擺節點不拉線，看不出它跟流程的關係（經過見 `../rationale.md` §Phase 6-3）。
3. **拆成三張圖放同一頁**：全部檔案加上全部關係塞進一張圖，線會大量交叉、穿過別的節點，讀不出來（經過見 `../rationale.md` §Phase 6-4）。

### 1. 找 archify（跑 CLI 驗活，不看目錄在不在）

依序試 `~/.claude/skills/archify`、`~/.agents/skills/archify`，對每個路徑跑 `node <路徑>/bin/archify.mjs doctor`，**exit 0 才算可用**（目錄在但 Node 版本不符或檔案不全時照樣跑不動）。

找不到或都不是 exit 0 → **不准自己裝**，問使用者，四件事一次講完：這是什麼（第三方的流程圖產生工具 tt-a1i/archify，MIT 授權、免費）、為什麼要它（有格式檢查與真瀏覽器量測，比手刻可靠）、裝了會動到什麼（連網下載、寫進 `~/.claude/skills/`，不動這個專案）、不裝會怎樣（改成在終端機給流程表，內容一樣完整，只是沒有圖）。他說要才跑 `npx skills add tt-a1i/archify -g`，裝完再跑一次 doctor。他說不要、或無人值守 → 走第 6 步的退回做法。

### 2. 先列清單，再寫三張圖的 JSON

先寫一個只有 `{"nodes":[],"edges":[]}` 的暫存 JSON，跑一次 `check-flow-diagram.js check <落點> <那個暫存 JSON>` 拿到「init 之後的變動」清單（它會全部列成缺項，這就是要畫的清單）。清單裡有不該留下的殘檔（測試產物、暫存檔）→ 刪掉，不要畫上去。

每個檔案的關係要**查證後才畫**：讀它的是誰、在哪一步（讀 agent 檔的「開工前必讀」、CLAUDE.md 路由表、hook 檔頭的接線與填空區常數），寫它的是誰、在哪一步。查不到就不畫那條線，並在收尾回報說明。

落點：`<落點>/.claude/harness/flow-1.json`～`flow-3.json`，產出 `flow-1.html`～`flow-3.html`，再組成 `flow.html`（路由表要列 `flow.html`）。格式：archify `workflow`、`schema_version: 2`、`meta.quality_profile: "showcase"`、`meta.locale: "zh-CN"`（archify 只收 `en`／`zh-CN`；節點文字照樣寫繁體中文，只有圖例與按鈕會是簡體，這是 archify 的限制）。結構範例見 `references/example-flow-1.json`～`example-flow-3.json`——**只抄結構，內容一律換成這次實際的檔案與查證過的關係**。

| 圖 | 泳道（由上往下） | 放什麼 | 線 |
|---|---|---|---|
| **圖一：需求進來之後怎麼跑** | 自動檢查（擋主對話，`variant: "exception"`）／主對話（含你提出需求、你簽收）／agent 角色／自動檢查（擋 agent，`exception`） | 主線：需求 → 對齊 → 派工 → 第 1 題定案的每支 agent → 收尾。**每支 agent 只畫一個節點、名字照實際裝的檔名**：同一支做兩步（例：architect 併入 engineer 時，engineer 先寫設計、你同意後再寫程式），用「設計給你看」「同意後寫程式」一來一回兩條線表示，小字寫它做哪幾步；畫兩個同名節點，讀者會以為專案裡有兩個角色（經過見 `../rationale.md` §Phase 6-5）；每支**會擋人的** hook 放在它擋的那一步的上方或下方；最下方加一條「收尾時更新的文件」泳道，放 CLAUDE.md（小字「專案概要：流程狀態與進度」） | 主線箭頭；步驟 → hook 標「擋」（`variant: "security"`、`role: "error"`）；結束那一步 → CLAUDE.md 標「寫：更新專案概要」（做完一條業務流程時更新流程狀態與進度；畫在圖一是因為圖二的讀取線已經很密，實測加這條線排不出不交叉的版面） |
| **圖二：文件在哪一步被讀、被寫** | 規則文件（Claude 會讀）／流程步驟／知識筆記（讀＋寫）／記憶 | 步驟一列：開 session、對齊、派工、設計＋實作、實測、收尾（不做的步驟拿掉）；CLAUDE.md、harness/README.md、02～05 放在讀它的那一步上方（有 07 註解規範時一起放，讀它的是設計＋實作那一步；`.claude/git-commit-reviewer-addendum.md` 放在收尾那一步上方，線上寫「讀：commit 前審查」）；<實際詞彙表檔名>（GLOSSARY.md 或沿用的 CONTEXT.md，只寫實際那一個）、FLOWS.md、`tests/Project_Detail/` 底下每個檔放在讀它的那一步下方 | 文件 → 步驟標「讀」（`variant: "dashed"`）；步驟 → 文件標「寫」（`variant: "emphasis"`）。**知識筆記讀和寫都要畫**：誰在哪一步讀、誰在哪一步寫，分開兩條線。**專案理解的產出也要畫出它在哪一步被用到**：CLAUDE.md 專案概要 → 確認需求（判斷需求落在哪條流程、碰不碰正式環境），線上寫「讀：專案概要」；→ 交代工作那一步（實作與測試工作的必讀清單都有它），線上寫「列進必讀清單」（收尾更新專案概要的寫入線畫在圖一）；GLOSSARY.md／CONTEXT.md（照落點實際檔名）→ 確認需求，以及骨架「開工前必讀」有列它的 agent（照實際裝的 agent 檔查，沒列的不畫）；PROJECT.md → 測試那一步（節點小字寫「測試環境位址」，線上寫「讀」就好，長的線上文字容易讓排版擠出交叉）。節點小字寫這次實際寫進去的內容（例：「3 系統、5 條流程」「8 個你確認過的用語」；小字太長 archify 會判讀不清而不給過，寫短），無人值守時寫「未經你確認」 |
| **圖三：背景自動執行與維護工具** | 設定／觸發時機／背景自動執行／讀寫的資料／維護 | settings 檔；開 session、resume、壓縮前、壓縮後這些時機；不擋人的 hook 與它載入的模組；它們讀寫的東西（專案外的就註明「專案外」）；健檢時跑的 probe-hooks 與 `hooks/cases/` | 時機 → hook 標「觸發」；hook 之間標「載入」；讀寫同圖二的畫法 |

**圖三的學習迴路（有裝時）**：在最下面另開三條泳道「學習迴路：什麼時候」「學習迴路：背景做的事」「學到的東西放哪」（不要塞進上面的背景泳道——那條通常已經六個節點、往下的線會跟原本的線擠在同一條走道，archify 會判 `ambiguous-corridor`）。節點：`learn-trigger`、`learn-reflect`、`learn-promote`、`learn-session-report`、`learn-usage`、`learn-approve` 各一個；`learn-reflector-prompt.md`、`.claude/harness/learning/`（紀錄、待核清單、用量，畫成一個目錄節點）、memory 與知識筆記放在「放哪」那一條；`learn-lib.js`（被各支載入的共用模組）與 `learn-pending.js`（你或 Claude 手動列出、還原待核項目）放在維護那一條。線：時機 → hook 標「觸發」（每次用工具 → learn-trigger；讀檔、用 skill、每回合 → learn-usage；開新對話 → learn-session-report；你送出訊息 → learn-approve）；learn-trigger → learn-reflect 標「背景啟動」；learn-reflect → learn-promote 標「交給」；提示詞 → learn-reflect、learning/ → learn-session-report 標「讀」；learn-promote → memory 與知識筆記、learn-usage → learning/、learn-approve → learning/ 標「寫」；learn-lib.js → 各支標「載入」；learn-pending.js 與 learning/ 之間標讀、寫。結構範例見 `example-flow-3.json` 最下面三條泳道。長檔名（`learn-reflector-prompt.md`、`.claude/harness/learning/`）放在本來就比較寬的欄，不然整張圖會變寬、1440 寬時節點小字小於 6px 被判看不清。

參考模式另把沿用的原有 agent、hook、指令、skill 畫進它所屬的那張圖，sublabel 標「原有」。

這次建的專案 skill 畫在圖一，接在觸發它的那一步旁、線上寫「觸發」：難 bug 診斷與本機覆寫導向接「實測」那一步（環境或程式出錯時），工作流地圖接「你提出需求」（不確定該走哪條路時），架構保養接「你提出需求」並在小字寫「你明說才跑」。每支 skill 的 `SKILL.md` 與 `CHANGELOG.md` **各畫一個節點，不用目錄節點**（`check-flow-diagram.js` 的規則：目錄節點只給同一種用途的一批檔，例如測試案例；而且以 `/` 結尾的 label 會涵蓋那個目錄底下全部變動檔，`.claude/skills/<名稱>/` 會把 SKILL.md 一起吞掉）。這幾個檔名彼此撞名，label 要帶上 skill 目錄名才判得出是哪一個，例：`bug-hunt/SKILL.md`、`bug-hunt/CHANGELOG.md`；`CHANGELOG.md` 節點放在它那支 skill 下方，線從 skill 拉過去、線上寫「寫：改這支 skill 時補一行」（不然它沒有線，完整性檢查不過）。本機覆寫說明（`local-overrides-guide.md`）與 `review-rules.md` 畫在圖二：前者被本機覆寫導向 skill 讀（線上寫「讀：該填什麼值」），後者被設計＋實作與審查那兩步讀；起服務時的工作樹覆寫提醒（`remind-worktree-overrides.js`）照「會擋人的 hook」的位置畫在圖一實測那一步旁，但線上寫「提醒」不寫「擋」（它不擋）。

限制：
- 同一張圖裡，同一個檔案（agent、hook、文件）只能有一個節點；完整性檢查會擋。
- 一條泳道同一欄只能有一個節點，最多六個；放不下就再開一條泳道，不准合併節點或移到卡片。
- 檔名一律完整寫出。archify 預設節點寬 92px，檔名放不下時 validate 會回報「Label … is wider than node」，這時給該節點設 `width`（約：英數字每字 7px、中文每字 14px，再加 24px），**不准縮寫檔名**。
- 一群用途相同的檔（例：`hooks/cases/` 的測試案例）可以畫成一個目錄節點（label 以 `/` 結尾），sublabel 寫份數；各有作用的檔不准用目錄節點帶過。
- 先不要手寫 `via`、`channelX` 這類座標，驗證報錯再照它給的修法改。

### 3. 驗證與產出（三張各跑一次）

```
node <archify>/bin/archify.mjs validate workflow <flow-N.json> --quality showcase --json
node <archify>/bin/archify.mjs deliver  workflow <flow-N.json> <flow-N.html> --quality showcase --json
node <archify>/bin/archify.mjs visual-check <flow-N.html> --json
```

- validate 有錯就照回報的 `supportedFixes` 修，連續兩輪錯誤數沒有減少就停，照實回報沒修掉的診斷。**線交叉（`composition/proper-crossing`）要靠調整節點所在的欄與泳道消除，不准降成 `standard` 品質來過關**。
- **`deliver` exit 非 0＝沒產出**，不准說成功。
- visual-check 唯一可接受的診斷是 `viewer/viewport-overflow` 且 `overflowX` 為 false（頁面要往下捲）；其他診斷都要修。記下它在 1440 寬回報的 `scrollHeight`（pass 時記 900），組頁要用。
- 組成同一頁：`node <本 plugin>/skills/init/scripts/flow-page.js <落點>/.claude/harness/flow.html "<專案名>：裝了什麼、需求進來怎麼跑" flow-1.html:<高度> flow-2.html:<高度> flow-3.html:<高度>`
- **每張圖都截圖親自看過**：`chrome --headless=new --window-size=1600,1300 --screenshot=<png> file:///<flow-N.html>`。主線看得出順序、檔名完整沒被截斷、每條讀寫線看得出從哪到哪，才算數。

### 4. 完整性檢查（不同判準的兜底，這步沒過不准收尾）

先清上一次 init 留下、這次不會重產的舊流程圖（重裝時才會有）：這次有 archify 時，舊的 `.claude/harness/flow.md` 是殘檔；這次沒有 archify 時，舊的 `flow.html`、`flow-1.json`～`flow-3.json`、`flow-1.html`～`flow-3.html` 是殘檔。都刪掉（原檔在 `.harness-backup/<時間>/`），收尾回報第 3 段備份位置那一行寫出刪了哪幾份。不刪的後果：舊圖畫的是上一次的安裝、可能還寫著另一個詞彙表檔名，而本步的檔名檢查只查這次產出的那一種；舊的 `flow-N.json` 還在時，`init-flow.js done` 會優先拿它做完整性檢查，不看這次的 `flow.md`。

```
node <本 plugin>/skills/init/scripts/check-flow-diagram.js check <落點> <落點>/.claude/harness/flow-1.json <落點>/.claude/harness/flow-2.json <落點>/.claude/harness/flow-3.json
```

腳本不看圖怎麼畫，而是拿 Phase 0 的快照對比現況，列出 init 之後新增、修改、刪除的每個檔案（排除 `.git/`、備份、流程圖本身、測試快取；`node_modules` 收成一項），逐項確認它是三張圖其中一張的節點 label；另外檢查每個節點都至少有一條線。exit 1 會列出缺哪些 → 補節點或補線（殘檔就刪）→ 重跑第 3 步與這一步，直到 exit 0。腳本輸出原文貼進收尾回報。

詞彙表檔名（Phase 4 開頭的詞彙表檔名規則，流程圖到這一步才產生，所以放在這裡查）：在 <落點> grep **另一個**檔名——實際用 `GLOSSARY.md` 時跑 `grep -nE "CONTEXT\.(changelog\.)?md" .claude/harness/flow-1.json .claude/harness/flow-2.json .claude/harness/flow-3.json`（沒有 archify 時改查 `.claude/harness/flow.md`），實際用 `CONTEXT.md` 時樣式換成 `"GLOSSARY\.(changelog\.)?md"`；命中 = 0。有命中時：archify 路徑改 JSON 後重跑第 3 步與本步；flow.md 路徑直接改 flow.md 後重跑本步。貼原始輸出。

### 5. 交付前易讀性自檢（流程圖與收尾回報都要過）

讀者是第一次用 harness 的人。流程圖上的每一句話（標題、泳道、節點小字、線上的字）與收尾回報，都要讓他不用開口問就看得懂（經過見 `../rationale.md` §Phase 6-6）。規則依據是 deliver-report plugin 的易讀性鐵則。

```
node <本 plugin>/skills/init/scripts/readability-check.js <落點> <落點>/.claude/harness/flow-1.json <落點>/.claude/harness/flow-2.json <落點>/.claude/harness/flow-3.json <落點>/.claude/harness/install-report.md
```

- **exit 3＝這個專案看不到可用的 deliver-report**（沒裝，或被停用）：跳過這一步，照腳本印的那段話在收尾回報告訴使用者「這次沒做易讀性自檢，要裝的話跟我說，我可以幫你跑 `claude plugin install deliver-report@fulin-plugins --scope project`（在這個專案目錄下跑）」（裝新 plugin 要先經使用者同意；裝完要 `/reload-plugins` 或重開 session 才生效）。不准因為沒裝就卡住 init。
- **exit 1**：逐項改。內部用語換成腳本給的說法；節點小字放不下說明就改寫整句，不准用「（見圖二）」這類叫讀者去別處找的寫法。改完**整份重跑**，不是只重跑被點到的那一處。
- **exit 0 之後還沒完**：腳本會印出它判不準的幾條（兩邊對照、資訊放一起、重複、做完寫成做完…）。**先把它印出的規則檔全文讀完**，再對三張圖與收尾回報逐條自檢，改到的地方重跑第 3 步的 deliver。
- 內部用語清單在 `plain-language-terms.json`，是 SKILL.md「對使用者講話的寫法」對照表的機械可讀版；使用者再指出看不懂的詞，兩邊一起加。
- 沒有 archify、改用 Markdown 流程表時，把指令裡的三個 flow-N.json 換成 `flow.md`。
- 範圍：流程圖三張（或 `flow.md`）＋收尾回報。寫進專案的制度文件（CLAUDE.md、02～05、agent 檔）是給 Claude 照做的規則，本來就用內部用語，不在這一步的範圍。

### 6. 給使用者看

- 有 archify：用系統預設瀏覽器打開 `flow.html`（Windows `start "" <路徑>`、macOS `open`、Linux `xdg-open`；無人值守時不開，只給路徑）。
- 沒有 archify：寫一份 Markdown 流程表到 `<落點>/.claude/harness/flow.md`，一樣分三節對應三張圖；每一列是一步，欄位是「步驟｜誰做｜讀了哪些檔｜寫了哪些檔｜被哪支自動檢查擋｜觸發了什麼」，每個變動檔都要以完整檔名出現在它那一步；第 4 步的完整性檢查改對這份檔跑，同樣要 exit 0。

### 收尾回報（誠實條款，缺一不算完成）

先寫成檔案 `<落點>/.claude/harness/install-report.md`（**寫好、易讀性自檢過了，跑 `init-flow.js done <目標>`**——它會重跑 init-verify（Phase 6 之後改過答案或豁免也要重新過）與流程圖完整性檢查、確認收尾回報在；exit 0 之後才可以對使用者說裝好了，本 plugin 的 Stop hook 會擋還沒 done 就說裝好的回覆），過完上面第 5 步的易讀性自檢，再把同樣的內容貼給使用者（之後他也能回頭看這份檔）。下面八段（參考模式九段）；寫給使用者時照「對使用者講話的寫法」，段名可以直接用下面的粗體字。**第 1、2 段放最前面**——使用者最想知道的是「之後會怎麼跑」與「裝了什麼」，驗收證據往後放。

1. **之後一個需求進來會怎麼跑**：先給流程圖的路徑（說明已經在瀏覽器打開）；接著在終端機寫一段 5～8 步的文字版，每步一行：誰做、讀了哪些檔、寫了哪些檔、哪個自動檢查在這一步擋什麼、卡住時會怎樣；背景與維護另寫兩三行。**圖打不開也要看得懂**，每個檔名都要出現在它那一步。最後一句講「完整性檢查：init 新增 N、修改 M、刪除 K 項，每一項都是圖上的節點、每個節點都有線」，附腳本輸出。
2. **裝了哪些東西**：逐檔列出路徑，每個檔附一句用途，分新增／修改／刪除。**項目要和完整性檢查腳本列的變動清單一致**（腳本列幾項，這裡就是幾項；修改的寫出改了什麼）。接著列「我替你做的決定」：拿掉了哪些角色、沿用了你們哪些既有規範、哪些是我先決定的（無人值守時，剛才盤點推導出的預設全列在這裡，註明「你可以推翻」）。
3. **驗收證據**：靜態檢查十三項逐項結果、「開新 session 實際試擋」五項的原始輸出、流程圖完整性檢查與易讀性自檢的腳本輸出（易讀性自檢被跳過時，寫明是因為沒裝 deliver-report，並附安裝指令）。
4. **你已經有的**：
   - CLAUDE.md 的專案概要（用途、外部系統哪些是正式哪些是測試、業務流程、目前進度），確認需求時先讀它，交代任何角色（架構、實作、測試、審查）工作時都列為必讀；`<實際檔名>` 有 <N> 個你確認過的專案用語（逐個列出）。無人值守時寫明「概要是我讀文件推的，還沒經你確認」，並列出等你確認的候選詞
   - 一套開發流程：各角色的分工與順序（列出來）、固定跟著流程走的三條規則、43 條判斷規則（什麼時候該停下來換方法、怎樣才算做完、哪些動作要先問你；參考模式另加 Q8 升格的 <N> 條本專案經驗條款）、派工範本、記錄踩坑的規則
   - <N> 項會真的擋下來的自動檢查，每項一句講它擋什麼；危險指令檢查逐條列出各自對應的風險。<N> 個 agent 角色（名稱加中文職稱）
   - **各角色交給哪個模型**：一張表，每個 agent 一列，欄位是「角色｜做什麼｜預設模型｜什麼時候改用 opus」，照 02 對照表實際填的寫；下面一句講判斷依據（02 的四項進階判準，任兩項成立就用 opus）與「沒指定模型會被哪支自動檢查擋」。理由：使用者要看得到每個角色用哪個模型、為什麼（經過見 `../rationale.md` §Phase 6-7）
   - 註解規範（第 11 題的答案）：建了就寫路徑與它管什麼（寫為什麼不寫做了什麼、不補空殼 doc、不留 AI 參與痕跡），並列出你確認過的範本註解；沿用就寫沿用哪份；不建就寫「只有 agent 檔裡的基本原則」。有產生 commit 前審查的附加要求檔時，一句講它讓審查員多做哪幾件事
   - 專案 skill（第 12 題的答案）：每支一句講什麼時候會被叫到、做什麼（架構保養寫明「只有你說了才跑、一次約一個中型任務的用量」）；有本機覆寫說明時寫它的路徑與「碰到服務起不來、測試信寄出去這類症狀時，Claude 會先去對這份說明」；沒選的列出來並寫之後怎麼補
   - 沒有裝的自動檢查逐項列出與原因：用不到／你取消的／要另裝某個 plugin／要等專案有了某個工具才用得到
   - 三份知識筆記檔（`<實際檔名>` 詞彙表、`FLOWS.md` 跨模組流程、`PROJECT.md` 測試知識）與收錄原則，照實寫每份目前有幾條真實條目（這次確認的用語、參考模式沿用的條目、盤點實跑寫進的測試知識），沒有的才寫「只有示範」
   - 學習迴路（有裝時）：每 80 次工具呼叫（或對話結束時還剩 10 次以上），背景另開一個只能讀檔的 Claude 讀這段對話，提最多 5 筆「你糾正過的事、繞過的坑、工具的坑、知識筆記的新事實」；新的 memory 與知識筆記條目驗證過格式、沒有帳密才直接寫，改既有內容的寫了會在下次開對話時列給你看、可以退回，改規則、自動檢查、agent 的只列成待核、不會自己改；同一類問題第 2 次出現會自動提議升成正式規則。下次開對話第一行會告訴你上次整理寫了什麼、有幾筆等你核可（在提示列打「核可 <編號>」或「駁回 <編號>」）。不想要就在 settings 的 `env` 設 `HARNESS_REFLECT_EVERY_N=0`
5. **你還沒有的**（照實列，不要美化）：
   - **踩坑經驗**：分兩種情況寫，不寫「0 條」這種讓人以為少了東西的說法（經過見 `../rationale.md` §Phase 6-8）。
     - 一般模式：「這套規則照 harness <版本> 產生，是通用的開發流程；這個專案自己的踩坑紀錄還沒開始累積（memory、`FLOWS.md`、`PROJECT.md` 的踩坑段落只有示範條目）。之後每踩一次坑就記下來，同一類坑第二次出現就照 `05-knowledge-protocol.md` 的升格流程寫成正式規則。」
     - 參考模式：「規則文件與自動檢查已照 harness <版本> 重新產生。你原本規矩裡的經驗共 <總數> 條：照預設處置帶過去 <A> 條（在哪個檔），升格 <N> 條進 `03-judgment-matrix.md` 的「本專案經驗條款」（其中 <M> 條加了自動檢查），你選了不帶的 <K> 條留在 <哪裡>（逐條列）；經驗帶走審查的結果：<除了你選了不帶的 K 條，沒有其他沒帶到的／還有哪幾條沒帶到、為什麼>；知識筆記檔沿用原有 <N> 條。」照實數，Q8 沒問就寫原因
   - **回歸測試 0 支**（init 不寫測試）<若 Phase 1 盤點到既有測試，寫「既有測試 N 支，還沒照這套流程檢視過」>
   - 每個模組測到哪裡的登記、專案專屬的檢查腳本、針對過去事故寫的規則——照實寫：沒有就寫沒有；參考模式沿用了原有的自動檢查或事故規則，列出沿用了哪幾項。
   - harness 帶進來的規則是通用版本：裡面的數字與範例還沒被本專案真實發生過的問題校正過（沿用的原有規則不在此限）。
6. **之後怎麼讓它越用越貼合**：
   - 每次踩坑 → 照 `05-knowledge-protocol.md` 的「踩坑紀錄格式」記進 memory；同一類坑第二次出現 → 照同一檔的「升格協議」提議寫進正式規則，能自動檢查的就一起做成自動檢查
   - 每次 commit（非 git 專案、或你選了不裝 git-commit 時改成：每個有改檔的回合結束）→ 會問你四個問題（這次有沒有新名詞、新的跨模組流程、新的測試知識、自創的縮寫），答案記進知識筆記檔
   - 每次改到程式行為 → 補一支可以重跑的自動測試
   - 每 30 天或每 300 個 request（先到者）→ 跑 `/harness:review` 做一次制度健檢（開機時會提醒；兩個門檻在 `health-check-reminder.js` 的填空區可調）。三軌：它自己檢查制度有沒有被照做、逐項跑 05 健檢清單與本專案的稽核工具；另外會請你在提示列輸入 `/doctor`（看工具鏈）和 `/insights`（看使用習慣），三軌結果交叉比對。可逆的修正（重建過期索引、清過期 memory、修明顯的 hook 錯誤…）列成一批讓你一次核可，當場修完逐項驗證；改規則的仍一項一項問你
7. **在哪裡開 session 才有效**：自動檢查只在設定所在的那一層目錄開 session 時生效。在子 repo 裡開 session，`CLAUDE.md` 仍會被讀到（上層目錄的也會讀），但 workspace 根的自動檢查不會跑。
8. **盤點發現的專案本身問題**（文件寫的指令其實不存在、沒有測試、敏感檔沒被 `.gitignore` 擋）照實回報，不略過。
9. **原本的設定怎麼處理了**（僅參考模式）：
   - 備份位置與還原方式（「整份原樣在 `.harness-backup/<時間>/`，要還原就把裡面的檔案複製回原位」）
   - Phase 2 處置表的最終版（使用者改過的照改過的寫），每列附「處理後在哪裡」
   - **第 0 題的每個痛點逐一交代**：這次靠哪個東西解決（寫出檔名或自動檢查名）；沒解決的照實說沒解決、為什麼、之後怎麼補。不准只寫「已改善」
   - 舊規矩的經驗去向：每一條寫出目前的位置——帶進的新檔與行號／03 矩陣 D 的編號與怎麼擋／Q8 沒選、出處檔沒動而留在原位的文件路徑／Q8 沒選、出處檔被取代或併入而只剩 `.harness-backup/<時間>/` 裡的檔案路徑；附經驗帶走審查的原始回報
   - 沿用的原檔仍寫另一個詞彙表檔名：逐筆列 `檔:行`（Phase 5 詞彙表檔名那一項列出的命中；沒有就寫「無」），由使用者決定要不要改
   - 原有 `.claude/` 裡沒動的殘檔清單，由使用者決定去留
