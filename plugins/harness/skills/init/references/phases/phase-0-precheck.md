## Phase 0 — 前置檢查（版本比對＋五項；版本落後就停下；0-5、0-3 沒裝時問使用者要不要裝，等他回答再往下；其餘記下繼續）

**最先做：比對正在用的 harness 是不是遠端 repo 上的最新版**（什麼都還沒動，所以放在拍快照之前）：

```
node <本 plugin>/skills/init/scripts/check-version.js
```

- **exit 0**（已是最新）：把它印的「正在用／遠端最新」兩行放進 Phase 2 核對表與收尾回報，繼續。判定寫「正在用的比遠端新」時（維護者在原始碼 repo 開發中），照樣繼續，核對表照實寫兩個版本號。
- **exit 2**（落後）：**停下，不開始 init**。把腳本輸出原文貼給使用者，問他要不要現在更新。**使用者同意後由 Claude 直接跑非互動 CLI**：先跑 `claude plugin list --json` 找 `id` 是 `harness@<marketplace 名稱>` 的安裝紀錄、取它的 `scope`（有 `projectPath` 等於目標專案的那筆優先，沒有就取 `scope` 為 `user` 的那筆），再在目標專案目錄下跑 `claude plugin marketplace update <marketplace 名稱>` → `claude plugin update harness@<marketplace 名稱> --scope <那筆的 scope> --json`（marketplace 名稱照腳本印的填；回傳 `"outcome":"ok"` 才算成功，失敗就把錯誤原文貼給使用者、改請他自己更新）。**更新完要請使用者重開 session 再跑 `/harness:init`**——CLI 更新要重開才生效，這步 Claude 做不到。互動 slash UI `/plugin` 沒有 `update` 子指令，所以走 CLI。理由照實講：舊版少的步驟裝完才發現，就得整輪重做（經過見 `../rationale.md` §Phase 0-1）。使用者明確說「就用這版裝」才繼續，收尾回報寫「用的是 <版本>，遠端已有 <版本>，你選擇不更新」。
- **exit 3**（查不到：沒網路、沒 git、marketplace 不是 git clone）：不擋，繼續；收尾回報寫「沒有比對到遠端版本」並附腳本印的原因。

先確認目標 workspace 路徑（預設＝當前工作目錄；使用者指定別的路徑就用那個）。

**接著、在動任何檔案之前：拍快照**（Phase 6 靠它找出 init 新增或改過的每個檔案，事後補拍比不出差異）：

```
node <本 plugin>/skills/init/scripts/check-flow-diagram.js snapshot <目標>
```

之後 Phase 1 實跑測試、Phase 4 生成、Phase 5 探針留下的所有變動都會被 Phase 6 抓出來——不該留的殘檔要在收尾前刪掉，否則會被要求畫上流程圖。

**拍完快照，立刻開狀態檔**（SKILL.md 硬規則 2；之後每進一個 Phase 先 `advance`，腳本會檢查出關條件）：

```
node <本 plugin>/skills/init/scripts/init-flow.js start <目標>            # 無人值守加 --headless
```

- `start` 會建 `<目標>/.claude/harness/.init-state.json`。所以下表 0-2 判定「有沒有既有設定」時，**`.claude/harness/` 裡只有 `.init-state.json` 這一個檔不算**（那是剛剛 `start` 建的）。
- 回報「已有進行中的 init」時：上一次做到一半沒收尾。照 `init-flow.js status <目標>` 看停在哪，跟使用者確認要接著做（`start --resume`）還是從頭來（`start --restart`）；無人值守時從頭來。
- 0-2 判定為參考模式後跑 `init-flow.js mode <目標> reference`（Phase 3 的出關條件會多要求第 0 題與 Q8 的答案或跳過理由）。
- 本階段做完（五項檢查都有結果、需要問的都問了），跑 `init-flow.js advance <目標> 1` 進 Phase 1。

以下指令一律對目標路徑跑：

| # | 檢查 | 指令 | 不過時 |
|---|------|------|--------|
| 0-1 | 目標是不是 git repo | `git -C <目標> rev-parse --is-inside-work-tree`；workspace 根不是 repo 時再列子資料夾：`for d in <目標>/*/; do git -C "$d" rev-parse --show-toplevel 2>/dev/null; done` | 分三種：①根目錄就是 repo＝**單一 repo** ②根目錄不是 repo、但子資料夾列得出 repo＝**多 repo 工作區**：跟單一 repo 一樣算 git 專案（改動最後一樣要推上 git），git-commit 相關的閘照裝，P4 探針對每個子 repo 各跑一次；沉澱閘綁 git-commit，不改綁 Stop hook ③根目錄與子資料夾都不是 repo＝**非 git 專案**：沉澱閘改綁 Stop hook、git-commit 相關的閘與探針整組不裝不測。理由：多 repo 工作區最後一樣要推上 git，不能當成非 git 專案（經過見 `../rationale.md` §Phase 0-2） |
| 0-2 | 有沒有既有的 Claude Code 設定 | 對 workspace 根與每個子 repo 各查一次：`ls <目標>/CLAUDE.md <目標>/.claude/ 2>/dev/null`；`.claude/` 底下列 `agents/`、`hooks/`、`commands/`、`skills/`、`harness/`，讀 `settings.json`／`settings.local.json` 看有沒有 `hooks`、`permissions`；`CLAUDE.md` 是否含「Harness 路由表」（＝之前裝過 harness） | **不停下**。判定規則：只有 `settings*.json` 且裡面只有 `enabledPlugins`＝**沒有既有設定**，照一般流程走（settings 照 Phase 4 合併）。其餘任何一項存在＝**有既有設定，進入參考模式**：①動 Phase 1 之前先整份備份——`CLAUDE.md`、`.claude/`（排除 `node_modules/`）、`GLOSSARY.md`（舊檔名 `CONTEXT.md` 也認）、`FLOWS.md`、`tests/Project_Detail/PROJECT.md` 原樣複製到 `<目標>/.harness-backup/<YYYYMMDD-HHMM>/`（保持相對路徑）；是 git repo 就把 `.harness-backup/` 加進 `.gitignore`；備份完用 `diff -r` 或逐檔 hash 比對確認一致，比對不過就停 ②Phase 1 第 12 項盤點原有設定 ③Phase 3 第 0 題問原本哪裡不好用。之前裝過 harness 也一樣走參考模式（重裝），不另外停 |
| 0-3 | Codex CLI 裝了沒（0-1 是非 git 專案、或 0-5 使用者選不裝 git-commit 時不適用，標「不適用」；**跟 0-5 一起問、排在 0-5 後面**——沒有 git-commit 就用不到 Codex） | `codex --version` | **沒裝 → 問使用者要不要裝，不是停下**：照下方「Codex 裝不裝」範本給對照與安裝三步，等他回答。選裝 → 他裝好後 **Claude 自己重跑 `codex --version`** 確認，把輸出貼出來再繼續。選不裝 → 照一位審查員繼續：①Phase 2 核對表與收尾回報「你還沒有的」寫「commit 前只有一位審查員（Claude），因為你選擇先不裝 Codex」②05 健檢清單加一列「Codex 還沒裝：commit 前只有同一家模型審查」，`/harness:review` 會追蹤 ③P4 照跑。為什麼要問：git-commit 的三軌審查裡，Codex 是與 code-reviewer 不同源的那一軌，少了它審查只剩同一家模型看自己的東西（03 B23）；但裝不裝是使用者的決定，不自己略過也不擋著不讓他往下（經過見 `../rationale.md` §Phase 0-3） |
| 0-4 | Playwright MCP 在不在 `permissions.allow` | 讀 `<目標>/.claude/settings.json`、`<目標>/.claude/settings.local.json`、`~/.claude/settings.json` 的 `permissions.allow`，找 `mcp__playwright` 開頭的項 | 不在 → 不擋，記下來：Phase 1 判定為「瀏覽器可驅動前端」時，Phase 4 settings 層要補（經 Phase 2 核對）；非瀏覽器或無前端時此項不適用 |
| 0-5 | git-commit plugin 裝了沒（0-1 是非 git 專案時不適用） | 照設定的優先序讀 `enabledPlugins` 裡 `git-commit@` 開頭的項：`<目標>/.claude/settings.local.json` ＞ `<目標>/.claude/settings.json` ＞ `~/.claude/settings.json`，**以最高一層有寫這一項的值為準**（高層寫 `false` 就是停用，就算低層寫 `true`）；三層都沒寫＝沒裝。判定為 `true` 後，再確認 `~/.claude/plugins/cache/*/git-commit/` 底下有版本資料夾；**並讀出這個專案實際用的版本**：`~/.claude/plugins/installed_plugins.json` 裡 `git-commit@…` 的紀錄，取 `projectPath` 是目標的那筆（沒有就取 `scope` 為 `user` 的那筆）的 `version` | **沒裝 → 在這一步就講清楚，不要等到訪談中途才冒出來**：照下方「git-commit 裝不裝」範本給對照表與一行安裝指令，等使用者決定（與 0-3 同一則訊息問，見範本上方「0-5 與 0-3 怎麼問」）。使用者裝好後，**Claude 自己重跑本項的兩個檢查**確認生效，把結果貼出來，不要先叫使用者重開 session（要不要重開以實際檢查為準；hook 有沒有真的生效由 Phase 5 的 P4 冷啟探針驗）。使用者選不裝 → git-commit 相關的閘與 P4 不裝不測、沉澱閘改綁 Stop hook，0-3 標「不適用」，收尾回報寫明。**裝了但版本低於 0.11.0**（QA 閘要 0.11.0 以上：`flow.sh review-record` 才會讀 `.claude/qa-gate.conf`、自己檢查 staged 有行為類檔時有沒有帶 `--qa`）→ 同一則訊息照「git-commit 裝不裝」的方式問要不要更新，講清楚影響：不更新的話「改了程式有沒有測過」只剩呼叫 git-commit skill 時的提早提醒（`guard-qa-before-commit`），直接用 Bash 跑 flow.sh 就不會被查；更新由 Claude 經使用者同意後直接跑非互動 CLI：`claude plugin marketplace update <marketplace 名稱>` → `claude plugin update git-commit@<marketplace 名稱> --scope <實際 scope>`（scope 用 `claude plugin list --json` 查，取法同上方 harness 落後那段），跑完請使用者重開 session。選更新 → 更新完 Claude 自己重讀版本確認；選不更新 → 照裝（`qa-gate.conf` 照樣產生，舊版 flow.sh 不讀它，之後更新就自動生效），Phase 2 核對表與收尾回報寫「git-commit 是 <版本>，QA 閘只有提早提醒，你選擇先不更新」，Phase 5 的 qa-gate 實跑標「不適用：git-commit 版本低於 0.11.0」。理由：缺的相依要在一開始一次講清楚，不要等到訪談中途（經過見 `../rationale.md` §Phase 0-4） |

**0-5 與 0-3 怎麼問**：兩項都沒裝時放在**同一則訊息**，先貼「git-commit 裝不裝」、再貼「Codex 裝不裝」，請使用者兩題一起回答；使用者選不裝 git-commit，Codex 那題就作廢（標「不適用」）。只有一項沒裝就只貼那一份。表格裡 0-3 排在 0-5 前面只是編號沿用，問的順序以這裡為準。

**「git-commit 裝不裝」範本**（0-5 沒裝時照填輸出，等使用者回答）：

```
這套流程的「commit 前審查」靠另一個 plugin：git-commit。你目前沒有裝。

|                    | 不裝                         | 裝                                           |
| commit 怎麼進行    | 照你現在的做法               | commit 前先由審查員看過改動，沒過就不准 commit |
| 只加入指定的檔案   | 靠 Claude 自己小心           | 由程式保證，不會把別人的改動一起帶進去       |
| 直接下 git commit  | 可以                         | 會被擋下，一律走它的流程                     |
| 「改了程式有沒有測過」「這次學到什麼」 | 改成每個回合結束時問 | 在 commit 時問                     |
| 代價               | 沒有                         | 每次 commit 多跑一位審查員，慢一點、多花一點用量 |

要裝的話跟我說「裝」，我會直接幫你裝在這個專案（claude plugin install git-commit@fulin-plugins --scope project），裝完自己確認它有沒有生效。不裝也可以，跟我說「不裝」。
```

**「Codex 裝不裝」範本**（0-3 沒裝時照填輸出，等使用者回答）：

```
commit 前的審查可以多一位 Codex（OpenAI 的指令列工具）。你目前沒有裝。
偵測結果：`codex --version` → <實際輸出，例：command not found>

|              | 不裝                                   | 裝                                         |
| commit 前審查 | 一位審查員（Claude 審 Claude 寫的程式） | 兩位：Claude 和 Codex 各審一次              |
| 抓得到的錯   | 同一家模型的盲點會一起漏掉             | 兩家模型的盲點不同，可以互相補位           |
| 代價         | 沒有                                   | 要有 OpenAI 帳號；每次 commit 多跑一位，慢一點 |

要裝的話，在終端機依序執行：
  1. npm install -g @openai/codex        （需要 Node.js）
  2. codex login                          （用你的 OpenAI 帳號）
裝好跟我說一聲，我會自己跑 codex --version 確認。
先不裝也可以，跟我說「不裝」：我照一位審查員裝好，並記進定期檢查的清單，之後會再提醒你。
```
