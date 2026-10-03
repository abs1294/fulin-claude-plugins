# harness — 開發流程制度安裝器

`/harness:init` 幫任何軟體開發專案裝上一套讓 Claude 照規矩做事的流程：什麼工作用哪一級模型、什麼時候該停下來換方法、怎樣才算做完、哪些動作要先問你、怎麼把工作交給分工角色（agent）、踩過的坑怎麼記下來；再加上一組分工的 agent 角色、會真的擋下危險動作的自動檢查、三份知識筆記檔。**不管專案是什麼語言、什麼架構都能用**，會依掃描結果拿掉你用不到的部分。

## 設計核心

### 引擎與實例分離

| 層 | 位置 | 誰維護 |
|----|------|--------|
| **引擎**（規則文件範本、自動檢查範本、改編原則、init 流程） | 本 plugin | monorepo（bump＋publish） |
| **實例**（各專案的規則檔、agent、自動檢查、知識筆記檔） | 各專案 `.claude/`＋workspace 根 | 該專案自己維護（改之前要先問過使用者） |

plugin 更新只換掉引擎，**永遠不會動到任何專案裡已經產生的檔案**——各專案產生之後各自演變。這是刻意的：曾經發生 plugin 升級把本機客製的修改蓋掉，所以專案自己的檔案絕不能放在會被更新覆蓋的位置。自動檢查也一樣：init 把範本**複製**進專案的 `.claude/hooks/`，你可以自己改，代價是 plugin 更新時不會自動同步過來。

### 規則要能自動擋

只寫在文件裡的「必須」，AI 還是可能不照做；只有程式真的擋下來才靠得住。所以 init 不只產文件，也裝上自動檢查（Claude 每次執行指令或交代工作前自動跑，命中就擋下），最後**開一個新的 session 實際試**（真的去交代工作、真的下 `git commit`），證明它真的會擋。

### 先說清楚：這是基本架構，不是成熟的 harness

init 產出的是**一套基本架構，加上讓它越用越完整的方法**。一套成熟的 harness 除了規則檔，還有數十到上百條踩坑紀錄、數百支自動測試、每個模組測到哪裡的登記——那些只能從專案自己的工作裡累積。結束時的回報會明列「你已經有的」與「你還沒有的」。

## 用法

在目標專案說：

```
/harness:init
```

| 步驟 | 做什麼 |
|------|--------|
| 0 前置檢查 | 先到遠端 repo 比對正在用的 harness 是不是最新版（落後就停下請你更新）／是不是 git 專案（根目錄不是 repo、但底下有子 repo 的多 repo 工作區也算）／專案裡原本有沒有 Claude Code 設定（有的話先整份備份到 `.harness-backup/<時間>/`，再當參考來源，不停下）／Codex CLI 裝了沒（沒裝就問你要不要裝，附裝與不裝的對照；不裝就照一位審查員裝，並記進定期檢查）／Playwright MCP 有沒有列在允許清單／git-commit plugin 裝了沒（沒裝就在這一步給裝與不裝的對照，由你決定） |
| 1 盤點 | 十三項實際讀程式碼查（不只看 README）：技術棧、build/test 指令、repo 結構與 remote、前端類型、有沒有測試、既有的開發規範文件、既有 agent、會對外造成影響的動作（寄信、部署、刪資料等七類）、敏感檔案、跑起來時的風險（資料庫帳號、起服務與跑測試要的環境設定）、工作方式（例如本機一直改著不提交的設定檔）、原本的 Claude Code 設定（每個分工角色、自動檢查、指令在管什麼，裡面寫的專案事實照樣當證據）、這個專案在做什麼（給誰用、串接哪些外部系統、業務流程做了哪些、現在做到哪、哪些專案用語容易誤會、哪些文件已經過時） |
| 2 攤開核對 | 最前面先給一份「這是什麼專案」的概要草稿（每句附出處，請你直接改），接著把盤點結果和據此推導的預設一次給你看，有錯請直接指出；原本有設定的話，逐項列出打算沿用、合併還是換掉，你可以改 |
| 3 訪談 | 一次問一題、每題附建議。先問專案本身：原本的設定哪裡不好用（只有原本有設定時問，後面的建議會朝解決這些問題調整）、每個外部系統與資料庫哪個是正式環境哪個是測試環境、專案現在做到哪與接下來做什麼、從文件挑出的專案用語意思對不對。再問流程設定：①開發流程要哪些角色 ②哪些動作執行前一定要先問你 ③沒有畫面的專案怎樣算做完（只有沒前端時問）④一個人用還是團隊用 ⑤要裝哪些自動檢查（預設全裝，你可以取消）⑥還沒有自動測試時要不要先暫停「每次改動都補測試」的要求（只有沒測試時問）⑦哪些文件動手前必讀（已經過時的文件會標出哪裡過時）。原本有設定的話，另外問：原本規矩裡這個專案自己累積的經驗（用讀懂意思的方式挑出來，不是比對關鍵字），照預設不會帶進新規則的，要升格哪幾條；裝完驗收時會再派一位獨立審查員，從舊文件逐條確認經驗有沒有帶走 |
| 4 生成 | 規則文件、自動檢查、agent 角色、知識筆記檔、Claude Code 設定檔（settings）。CLAUDE.md 最前面是你確認過的專案概要（每次交代工作都第一個讀），`CONTEXT.md` 寫進你確認過的專案用語 |
| 5 驗收 | 檔案檢查十二項（有 `.claude/qa-gate.conf` 時，其中一項另在暫存 repo 實跑一次 git-commit 的 QA 閘：不帶 `--qa` 被拒、帶了才通過；其中一項只在原本有設定時檢查：備份完整、原有設定都照核對結果處理、知識條目沒漏搬；一項檢查專案概要與專案用語跟你確認的內容一致），加上開新 session 實際試五項（交代工作沒指定模型會被擋／正常交代工作不會被誤擋／開 session 時有出現提醒／直接下 git commit 會被擋／危險指令的自動檢查真的有接上），任一項失敗就不算完成 |
| 6 流程圖 | 用 archify 畫三張圖放在同一頁，開在瀏覽器給你看（`.claude/harness/flow.html`）：①需求進來之後怎麼跑、每一步被哪支自動檢查擋 ②每份文件在哪一步被誰讀、被誰寫（`CONTEXT.md`、`FLOWS.md`、`tests/Project_Detail/` 的讀和寫都畫）③開 session、壓縮對話這些時機背景自動做了什麼、健檢怎麼跑。**要畫哪些檔不是寫死的**：init 一開始先記下專案裡每個檔案的狀態，最後比對出這次新增、修改、刪除的每個檔案，每一個都必須是圖上的節點、而且有線標出它跟哪一步是什麼關係，由檢查腳本擋漏項。沒裝 archify 會先問你要不要裝，不裝就改給流程表。流程圖與結束時的回報，會先用 deliver-report plugin 的易讀性規則自檢（不能有內部用語、沒解釋的代號）；沒裝 deliver-report 就跳過，並告訴你怎麼裝 |

原本的設定分兩種處理：
- **Claude Code 自己的設定**（`CLAUDE.md`、`.claude/` 底下的 agents、自動檢查、指令，包括之前裝過的 harness）：**當參考來源**。你會在已經有設定的專案跑 init，代表原本的流程有地方不順，所以不會原樣保留；但裡面寫的專案事實（指令、禁止事項、保護動作）和累積的知識條目一律搬過來，每一項怎麼處理都會先給你核對，原檔整份備份。
- **多個工具共用的開發規範**（AGENTS.md、.agents/、.cursor/ 等）：**以你們既有的為準**，harness 不另外蓋一套，只補上 Claude Code 特有的部分——這些檔不只 Claude 在用。

## 檢查裝好的流程有沒有起作用

用一陣子之後，在專案裡說：

```
/harness:review
```

它是制度健檢，分三軌：

- **軌一（它自己做）**：看實際用起來的紀錄（下表），再派一位助手把 05 健檢清單逐項跑完——包括專案自己長出來的稽核工具、會「過期了也不報錯」的索引與快取、健檢提醒自己算得對不對，以及清單上寫的預期結果跟實際跑出來的對不對得上（對不上時會查證是清單過時、還是自動檢查壞了：找得到「刻意改過」的證據才改清單，找不到就當故障處理）。
- **軌二 `/doctor`**、**軌三 `/insights`**：這兩個是 Claude Code 內建指令，它叫不動，開跑時會請你在提示列打。`/doctor` 看工具鏈（沒在用的連接器與 skill、慢的自動檢查），`/insights` 看你的使用習慣與卡關點；它會把 `/insights` 的每條建議對照現有規則，分成「已經有規則只是沒人照做（改做成自動檢查）」「真的沒有（補規則）」「不屬於這個專案（指出該補在哪）」。

軌一看實際紀錄的部分：

| 看什麼 | 從哪裡看 |
|------|--------|
| 自動檢查還在不在、會不會擋 | 設定裡每筆自動檢查指到的檔在不在；要實際試跑每支自動檢查時，Claude 會先問你（試跑會執行專案裡的程式，預設不跑） |
| 流程有沒有照走 | 每次交代工作的順序（實作 → 測試 → 審查）、動手前有沒有先跟你確認 |
| 交代工作的品質 | 有沒有指定模型、有沒有附開工前必讀；每次被自動檢查擋下，回原文看擋得對不對、擋下後有沒有補對 |
| 該讀的檔有沒有讀 | 每個分工角色實際讀了哪些必讀檔，回報有沒有列已讀清單 |
| 知識有沒有長出來 | 結束前記下學到什麼的回答次數；三份知識筆記安裝後新增了幾條、還剩多少示範 |
| 危險動作 | 看起來有風險的指令（連線、部署、資料庫）、指令裡有沒有直接寫了金鑰或密碼 |
| 你有沒有一直在糾正 | 你打斷、糾正 Claude 的地方 |
| 版本差距 | 目前 plugin 有、這個專案還沒有的功能 |

數字由腳本從紀錄裡抽，每個都附出處；安裝那次的對話與安裝時的試擋會自動略過。腳本只讀，不抄指令和對話的原文（原文可能帶金鑰），只記出處和抽出來的線索（指令名、關鍵詞；主機只列專案文件裡寫過的，其他只計數）。報告寫成 `.claude/harness/reviews/<日期>.md`：你要親自看的項目放最前面（只給資料不下結論），接著是三軌結果與「有起作用／沒起作用／沒機會驗證」三類。修正分兩批：**可逆的**（重建過期索引、清過期 memory、更新已查證過時的清單描述、修明顯的自動檢查錯誤…）列成一批讓你一次核可，它當場修，每項修完重跑當初發現問題的檢查來證明修好；**改規則的、收不回來的**仍一項一項問你。要不要補一筆健檢紀錄會一起問你；你同意才補，30 天的健檢提醒從那天重新算。

## 內容物

```
skills/review/
  SKILL.md                                /harness:review 流程（找範圍、請你打 /doctor 與 /insights → 收集＋清單逐項 → 判讀＋三軌交叉比對 → 問你兩題 → 報告 → 可逆的一次核可當場修、其餘逐項問 → 留紀錄）
  scripts/review-collect.js               從對話紀錄、分工角色紀錄、知識筆記、版本差距抽出數字與出處（只抽不判；加 --probe 才試跑自動檢查）
skills/init/
  SKILL.md                                /harness:init 主流程（第 0～6 步）
  scripts/check-flow-diagram.js           流程圖完整性檢查：一開始記下每個檔案的狀態，收尾時比對出 init 新增／修改／刪除的每個檔案，確認都是圖上的節點、每個節點都有線
  scripts/flow-page.js                    把三張 archify 圖組成同一頁 flow.html
  scripts/readability-check.js            交付前易讀性自檢：用 deliver-report 的易讀性規則掃流程圖與結束時的回報；沒裝 deliver-report 就跳過並提示安裝
  plain-language-terms.json               給使用者看的東西不能出現的內部用語，與對應的白話說法
  pollution-wordlist.txt                  污染詞表（黑名單，機器可讀；第 5 步驗收與 wordlist-sweep.js 共用）
  references/
    adaptation-guide.md                   改編原則（帶／不帶判準、何時沿用專案既有規範、外向邊界、詞表與其維護觸發、骨架維護、實例差異）
    skeleton-CLAUDE-md.md                 CLAUDE.md 的骨架（最前面是專案概要：用途、外部系統的正式與測試環境、業務流程、目前進度；含角色分工一節，以及指向知識筆記檔、分工角色、自動檢查的索引表）
    skeleton-harness-README.md            harness 導航頁骨架（五層清單、生效範圍、誠實揭露）
    skeleton-02-model-dispatch.md         哪種工作用哪個模型（各分工角色用什麼模型、最高階模型不下放、用量節流、跟你對話的 Claude 只分派不親做、另開一個 Claude 驗收）
    skeleton-03-judgment-matrix.md        判斷規則 43 條（9 條何時停下換方法、25 條怎樣才算做完、9 條哪些動作要先問你）＋動手前的三重自查＋設計取捨的決定流程
    skeleton-04-delegation-templates.md   交代工作的六種範本（第五種排整條角色分工、第六種交代測試）
    skeleton-05-knowledge-protocol.md     知識協議（三區分級、產物存放、踩坑格式與 memory 星等、MEMORY.md 字元數精簡觸發、變更紀錄落點、健檢、升格、01／06 何時建）
    skeleton-harness-CHANGELOG.md         harness 各規則檔的變更紀錄（依檔名分節；規則檔本體不放 changelog，免得每次載入都佔 context）
    skeleton-CLAUDE.changelog.md          CLAUDE.md 的變更紀錄
    example-flow-1.json～example-flow-3.json  第 6 步三張流程圖的 archify 結構範例（只抄結構，內容換成實際的檔案與查證過的關係）
    agents/                               五支通用 agent 骨架
      skeleton-agent-backend-architect.md
      skeleton-agent-backend-engineer.md
      skeleton-agent-frontend-engineer.md
      skeleton-agent-qa-engineer.md       （瀏覽器可驅動時整段指向 qa-webwright plugin）
      skeleton-agent-code-reviewer.md     （審查結論的輸出格式不能改，git-commit 的審查流程要讀它）
      skeleton-agents-CHANGELOG.md        五支 agent 的變更紀錄（依檔名分節）
    containers/                           三份知識筆記檔的骨架（收錄原則＋示範條目）與各自的變更紀錄骨架
      skeleton-CONTEXT.md                 專案特有詞彙表 → workspace 根 CONTEXT.md
      skeleton-FLOWS.md                   跨模組鏈路圖 → workspace 根 FLOWS.md
      skeleton-PROJECT.md                 QA 操作坑與測試設計知識 → tests/Project_Detail/PROJECT.md
      skeleton-CONTEXT.changelog.md、skeleton-FLOWS.changelog.md、skeleton-Project_Detail-CHANGELOG.md
                                          三份筆記檔的變更紀錄 → CONTEXT.changelog.md、FLOWS.changelog.md、tests/Project_Detail/CHANGELOG.md
hooks/
  hooks.json                              plugin 自己的自動檢查要在什麼時候啟動
  session-reminder.js                     SessionStart 條件式提醒：偵測到 .claude/harness/ 才輸出，未 init 的專案保持沉默
  wordlist-sweep.js                       引擎側：改到骨架檔要 commit 時，要求表態「有沒有新的專案特徵詞要補進詞表」
  templates/                              init 複製到目標專案 .claude/hooks/ 的範本（檔頭「init 填空區」常數由 init 填）
    （裝哪幾支照 skills/init/references/hook-catalog.md 推導，沒有固定數量）
    ── 一定會裝 ──
    check-agent-model.js                  交代工作給分工角色時沒指定模型、或未經你同意用最高階模型 → 擋下
    check-review-discipline.js            交代工作時沒寫該角色必填的內容（驗收標準、回報方式、測試範圍…）→ 擋下
    check-ask-discipline.js               問你問題時沒附建議答案 → 擋下
    guard-qa-before-commit.js             staged 含行為類檔但沒表態 QA 狀態 → 擋 git-commit
    guard-sediment-sweep.js               commit 前（不是 git 專案時改成每回合結束）要回答四個問題：有沒有新用語、新的跨模組連動、新的測試知識、自創代號
    guard-claude-dir-hygiene.js           .claude/ 底下只准在機制目錄新建檔
    health-check-reminder.js              距上次制度健檢超過門檻天數 → 開 session 提醒
    memory-write-advisory.js              寫記憶後提醒：索引太大、同類條目該合併
    compact-snapshot.js＋compact-handoff.js
                                          對話太長要壓縮前，把重點存下來（背景工作、讀過的規範、改過的檔、使用者原話），
                                          並另開一個 Claude 寫交接信（九節，未完成的完整保留、關鍵數值原樣抄入）；失敗時只存重點、不擋壓縮
    compact-reinject.js                   壓縮後把交接信與接續指示放回對話，超長時先截「已完成」節，整段不超過平台 10,000 字元上限
    compact-summary-log.js                壓縮後記下摘要漏掉的項目、交接信又漏了什麼（評估用流水帳）
    resume-stale-reminder.js              隔數小時才接續之前的對話時，提醒狀態可能已過期，附最近交接信路徑與最後一則指示
    ── 盤點到你的專案有這類風險才裝（規則由 init 依盤點結果填）──
    guard-risky-command.js                執行前一定要先問你的指令（最高權限帳號連資料庫、部署、連到或打到你沒確認為測試環境的主機與網址、刪資料的 SQL、起服務缺環境設定）→ 擋下
    guard-test-preconditions.js           跑測試前驗前置條件（寄信收斂、測試環境對齊）→ 不符就擋
    shell-model.js＋package.json＋package-lock.json
                                          上面兩個引擎共用的指令語法解析（tree-sitter，bash 與 PowerShell 各一套文法）；
                                          init 在目標專案 .claude/hooks 跑 npm ci，沒裝或解析失敗時引擎退回正則判法
    guard-report-output.js                交付物落點紀律（主題_日期資料夾、過程檔進 _work/）
    ── 偵測到你有只給本機用的設定檔才裝 ──
    backup-local-hacks.js                 shell 指令前逐檔備份本機覆寫（檔案被清空、刪除時不蓋掉舊備份）
    guard-local-hack-destroy.js           會銷毀工作區的 git 指令碰到本機覆寫 → 擋（沒有放行記號）
    check-local-hacks-alive.js            開 session 點名遺失或被清空的本機覆寫；只在某些分支才需要的、帶到舊版的另外處理
    restore-local-hacks.js                救回腳本（上面三支的訊息會叫使用者跑它）
    ── 專案有了自己的測試檢查工具才裝 ──
    guard-test-asset-hygiene.js           寫測試檔後跑專案自己的稽核工具
    probe-hooks.js＋cases/                每支自動檢查「該擋」與「該放行」的例子，以及執行它們的程式；第 5 步驗收與每 30 天的定期檢查都跑它
```

## 骨架不帶什麼（同樣是設計）

原則是**開發流程骨幹全帶、事故型條款不帶**（細節見 `references/adaptation-guide.md` 第 1 節）：

- **帶**：純行為紀律（原文照搬）、可參數化的判準（專案事實挖成填空）、開發流程骨架（角色分工、分工角色的定義檔、自動檢查、知識筆記檔）。
- **綁定特定工作法的條款不預載**：本機覆寫檔管理、多工作樹並行、特定鏡像架構——判斷矩陣不帶這幾條。但對應的**保護用自動檢查**，在盤點時偵測到目標專案也有這種工作法（例如有只給本機用的設定檔）才裝。
- **不帶事故型條款**：某個第三方套件的坑、某次事故的細則——由目標專案自己的 memory 長出來，或由 `/harness:review` 健檢時從該實例的紀錄列進提案，同一件事反覆出錯就提升格；要不要收進骨架給所有專案用，仍由維護者照 `adaptation-guide.md` 的回收門檻判斷。
- **不帶 01 診斷書、06 交接信**——那是各專案自己的病歷與遺囑。
- **不帶任何知識內容**：CONTEXT／FLOWS／PROJECT 只帶結構與一個標明「示範」的條目，不替專案編詞條、畫鏈路、寫坑。
- **自動檢查不從固定清單挑**：照 `references/hook-catalog.md` 推導——來源專案每支自動檢查都拆成「通用形狀＋觸發條件＋專案參數」。綁著來源專案事實的那些（資料庫登入守衛、服務啟動環境、寄信收斂、測試環境對齊）不是原檔照搬，而是收成兩個規則引擎（`guard-risky-command`、`guard-test-preconditions`），init 用目標專案盤點到的事實填規則。每支範本自帶正反兩向的 `cases/`，由 `probe-hooks.js` 實跑驗證。

## 骨架條款回收門檻

某實例升格的條款要進骨架：須「≥2 個專案獨立踩過同類坑」、「與專案無關的純行為紀律」或「挖空專案事實後形狀仍成立」。單一專案的事故留在該實例。回收時事故只講機制不寫日期，改到骨架檔 commit 時會被 `wordlist-sweep.js` 要求回答詞表維護題。詳見 `references/adaptation-guide.md` 第 4、5 節。
