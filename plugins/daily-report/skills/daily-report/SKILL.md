---
name: daily-report
description: 產生 Claude Code 工作日報並經核可後寄 Gmail 給設定檔指定的收件人。掃描本機所有專案的當日 session 記錄，按專案分組摘要「做了什麼＋待辦/未完成」，使用者過目核可後透過 Gmail SMTP 寄出。當使用者說「日報」、「產今天的日報」、「工作日報」、「今天做了什麼整理一下寄出去」、「昨天的日報補寄」、「daily report」時觸發。
---

# daily-report — 工作日報產生與 Gmail 寄送

把一整天散在各專案的 Claude Code 對話，濃縮成一封收件人（主管/客戶）看得懂的工作日報。
資料來源是本機 `~/.claude/projects/` 的 session jsonl；寄送走 Gmail SMTP（應用程式密碼）。

## 核心原則

1. **寄信是對外動作**：報告在寄出前必須完整呈現給使用者、取得明確核可。沒有「默許自動寄」——寧可多等一句「寄吧」。
2. **收件人視角**：日報是給別人看的。寫「完成了什麼、產出是什麼」，不寫內部術語、不寫 prompt 原文、不寫統計數據（統計只在對話裡給使用者自己看）。
3. **機密不落 git**：SMTP 憑證只存 `~/.claude/daily-report/config.json`（家目錄）。

## 執行步驟

### 1. 定日期

預設今天；「昨天的日報」= 昨天；也可指定 `YYYY-MM-DD`。時區預設台北（+08:00）。

### 2. 萃取當日 session

```
python "${CLAUDE_PLUGIN_ROOT}/skills/daily-report/scripts/extract_sessions.py" --date <YYYY-MM-DD>
```

**預設只掃目前專案**（當前工作目錄及其子目錄的 session），不是全機器。這是刻意的：plugin 多裝在 project scope，「這個專案的日報」才是預期行為，掃全機器會把別的客戶/專案混進同一封信。要跨專案總覽時才加 `--all-projects`；要指定他處用 `--project <路徑>`。

- stdout 唯一輸出＝中間檔路徑（`~/.claude/daily-report/out/<date>-<專案>.json`），直接 Read 它。
- exit 3 = 該日無記錄 → 告知使用者，不硬產空報告。
- 腳本已自動濾掉：subagent 對話、SDK/程式驅動 session、系統注入訊息、指令回顯。留下的都是「人打的 prompt」與 session 標題（ai-title）。
- 要連自動化 session 一起看時加 `--include-auto`（罕用）。

### 3. 生成日報

讀中間檔，寫日報 markdown 到 `~/.claude/daily-report/reports/<date>.md`。固定結構：

```markdown
# YYYY-MM-DD 工作日報

## <專案名（口語化，非路徑）>
- 完成/推進了什麼（1~4 條，說結果不說過程）

## 待辦與未完成
- 從對話中萃取的未收尾事項（沒有就寫「無」）
```

寫作要點：

- **專案名口語化**：`C:\...\winbond-vendor-platform` → 「Winbond 供應商平台」。相鄰子目錄的 session（如 `customer-hub` 與 `customer-hub\web`）併成同一個專案講。
- **從 title + prompts 歸納敘事**，不逐條翻譯 prompt。session 標題（Claude 自動生成）通常就是最好的主題句起點。
- **待辦線索**：對話尾段的「之後再」、「明天」、被中斷的工作、使用者說要做但當天沒做完的事。
- **私人 session 要過濾**：掃出來的 session 可能含私人事務（非工作專案）。判斷明顯私人的（如個人研究、家庭事務）**預設不寫進報告**，並在對話中告知使用者「已略過 N 個疑似私人 session（列標題）」，讓使用者可要求加回。

### 4. 內容硬閘（寫完必跑，不可略）

```
python "${CLAUDE_PLUGIN_ROOT}/skills/daily-report/scripts/content_guard.py" <報告.md> [--project <目錄>]
```

**日報是對外文件，不得出現任何 AI / 工具鏈痕跡**（AI、Claude、plugin、prompt、agent、token、紅藍對抗、自動彙整…）。這道閘在寄送腳本裡也會再跑一次且**不可豁免**，所以與其被擋再改，不如寫完就先自檢。

命中時照它印的改寫原則重寫——**站在收件人角度寫「做了什麼、產出是什麼」，不寫用什麼工具做的**：

- ✗ 調整 AI 工作流程，讓 AI 遇到問題即時詢問　→　✓ 調整開發流程：遇到需求疑義即時確認，減少返工
- ✗ 新增 daily-report plugin，經紅藍對抗審查　→　✓ 新增工作記錄彙整工具，完成設計審查

若輸出含 **`⚠ 需要對外別名`**（專案名本身含禁用詞，改寫解決不了），問使用者「這個專案對外要怎麼稱呼？」，然後登記：

```
python content_guard.py --set-alias "<原名>" "<對外別名>" [--project <目錄>]
```

登記後永久生效，**同一個專案只會問一次**——別讓使用者每天重答。

### 5. 呈現與核可（30 分鐘默許窗口）

**呈現內容**——四塊，缺一不可：

1. **寄送資訊**：收件人、副本、寄件者、主旨、預計自動寄發時間。使用者要在知道「這封會寄給誰」的前提下決定，不能只看內文。（這些**不放進郵件內文**——收件人從 header 就看得到，內文重複是冗餘。）
2. **日報全文**（將寄出的內容，一字不差）。
3. **本機統計**（只顯示不寄出）：專案數、session 數、活躍時段、工具呼叫 top 5。
4. **明確告知窗口**：「N 分鐘內沒有回覆或修改，我就用這個版本自動寄出」。

**然後立刻 arm（同一輪，不可延後）**：

```
python "${CLAUDE_PLUGIN_ROOT}/skills/daily-report/scripts/confirm_gate.py" arm <date> \
  --report <報告.md> --recipients <收件人> [--cc <副本>] [--project <目錄>]
```

窗口分鐘數讀 config 的 `confirm_wait_minutes`（預設 30）。arm 會記下報告內容指紋與到期時間——**之後的自動寄送必須通過 `check` 才放行**，這是機械閘，不是靠記得。

**接著同一輪排喚醒源**（arm 的輸出也會提醒）：

- `ScheduleWakeup({ delaySeconds: <分鐘數×60>, reason: "日報確認窗口", prompt: "<重述：回到 daily-report 寄送步驟>" })`
- 無 ScheduleWakeup 時用 `CronCreate({ recurring:false, durable:false, cron:<現在+N分> })`，記下 job id。

> ⚠ **不排喚醒 = 空頭承諾**：這一輪結束後控制權交還使用者，沒有計時器就沒有任何東西會觸發寄送。`confirm_gate check` 在逾期超過 1 小時時會回報 warning，那就是「當初漏排」的證據。

**使用者在窗口內回應時**：

| 回應 | 動作 |
|---|---|
| 改內容 | 更新報告 → 重跑內容硬閘 → **`confirm_gate clear <date>`** → 重新呈現並 arm（窗口重新計時） |
| 喊停 | **`confirm_gate veto <date> --reason "..."`** → `CronDelete <id>` → 不寄 |
| 說「寄」 | 直接寄，**不帶 `--auto`**（這是他的意思表示，不必等窗口） |

**喚醒觸發時**：寄送指令**必須帶 `--auto`**，腳本會強制查 `confirm_gate check`——not-armed / still-waiting / vetoed / 內容被改過，任一情況都拒寄。

### 5. 交付（先跑閘，由腳本告訴你走哪條）

**不要自己讀 config 判斷，也不要問使用者「你想用哪種」**——跑這行，退出碼就是答案：

```
python "${CLAUDE_PLUGIN_ROOT}/skills/daily-report/scripts/setup_gate.py" status
```

- **exit 0（印 `SETUP_OK`）** → 輸出會寫明管道，照下面 A/B/C 對應執行。
- **exit 10（印 `SETUP_REQUIRED`）** → 設定未完成，**跳到「首次設定引導」**。此時不得自行猜測管道、不得直接寄送。

之所以用腳本判斷而非讀檔自行推論：判斷條件有四種未完成情境（檔案不存在、JSON 壞、有管道但無收件人、有檔但無管道），逐條記在腦中容易漏，腳本每次都查同樣的四條。

**A. Gmail API（OAuth）**
```
python "${CLAUDE_PLUGIN_ROOT}/skills/daily-report/scripts/gmail_oauth.py" send --report ~/.claude/daily-report/reports/<date>.md --date <date> --dry-run
```
先 `--dry-run` 給使用者看實際收件人與主旨，明確確認後拿掉 `--dry-run` 實寄。exit 2 含 `invalid_grant` → 授權失效（撤銷/改密碼/測試模式 7 天過期），重跑 `setup` 即可。

**B. SMTP 直寄**
```
python "${CLAUDE_PLUGIN_ROOT}/skills/daily-report/scripts/send_gmail.py" --report ~/.claude/daily-report/reports/<date>.md --date <date> --dry-run
```
同樣先 dry-run 再實寄。臨時改收件人用 `--to a@x,b@y`（會連 config 的 cc 一併清空，避免自我測試誤寄主管）。

**C. MCP 建草稿**（session 有 `mcp__claude_ai_Gmail__create_draft`；工具未載入先 ToolSearch）
`create_draft`：`to`/`cc` 讀 config、`subject`=`<subject_prefix> <date> 工作日報`、`body`=markdown 原文、`htmlBody`=`send_gmail.py` 的 `md_to_html()` 轉換結果。完成後告知「草稿已在你的 Gmail 草稿匣，過目後自己按送出」——**按送出即人工核可**，本 skill 不代按。

## 首次設定引導（`status` 回 exit 10 時走這裡）

這一節的選項說明與步驟**全部由腳本產生**，你的工作是搬運與陪跑，不是自己組織內容。這麼設計的原因：使用者是在「這個選擇給出多少權限」的資訊下做決定的，而那正是長對話中最容易被壓縮掉的部分——交給腳本輸出，內容就不隨當下狀態浮動。

**步驟 1｜取得選項並原文呈現**

```
python "${CLAUDE_PLUGIN_ROOT}/skills/daily-report/scripts/setup_gate.py" options
```

輸出是 JSON，含 `question` / `header` / 三個 `options`（各有 `label` 與 `description`）。用 **AskUserQuestion** 呈現：`label` 照抄、`description` 照抄。

`description` 內含權限、有效期、設定成本、代價四欄——**這四欄不可摘要、不可省略**。使用者選「應用程式密碼」前必須看見「等同整個信箱完整存取權、永不過期」，否則他不是在做選擇，是在賭。輸出的 `instruction` 欄位也寫著同一件事，照做即可。

**步驟 2｜取得該管道的逐步引導**

```
python "${CLAUDE_PLUGIN_ROOT}/skills/daily-report/scripts/setup_gate.py" guide <oauth|app_password|mcp_draft>
```

輸出是編號步驟，每步含 `do`（做什麼）與 `確認`（怎麼知道成功了）。**一次講一步，等使用者回報再講下一步**；他卡住就根據他描述的畫面對照該步的「確認」給提示。指令裡的 `<PLUGIN>` 替換成實際路徑再給他。

過程中的兩條紅線：

- **不要要求使用者把 client_secret 或 app password 貼進對話**。OAuth 的兩個值直接當參數餵給 `gmail_oauth.py setup`（腳本自己寫進他家目錄）；app password 請他自己編輯設定檔那一格。
- **`config.example.json` 是隨 plugin 發布的空範本，永遠不要把真值寫進去**。真設定檔的位置是 `~/.claude/daily-report/config.json`。（真寫進去也會被 git-commit 的憑證閘擋下，但別依賴那道補救。）

⚠ **不要把「使用者說做完了」當成做完了**。實戰教訓：本 skill 的作者自己照這份引導跑，仍漏掉「啟用 Gmail API」那步，直到寄信被 403 才發現——每步的「確認」都靠人眼判斷加口頭回報，中間兩層都會失真。**每個宣稱完成的步驟後跑一次 `gmail_oauth.py doctor`**（見步驟 3），它實際打 API 驗，不接受自我回報。

⚠ **Console 的畫面與網址以 Google 當下回傳的訊息為準，不以引導文字為準。** 引導裡的路徑會隨 Google 改版過時，而 doctor 輸出的錯誤與連結是 Google 即時給的。兩者衝突時信 doctor。

### 依專案分設收件人

同一台機器上不同專案要寄給不同人時（Winbond 的日報不該寄給 AI Platform 的窗口），在**該專案**建 `.claude/daily-report.json`：

```json
{ "recipients": ["主管@example.com"], "cc": ["pm@example.com"], "subject_prefix": "[Winbond 日報]" }
```

解析規則：**專案層只能覆寫「寄給誰」**（`recipients` / `cc` / `subject_prefix` / `from_name`），憑證一律只從家目錄那份讀。這樣一組授權可以服務多個專案，而憑證不會因為放在專案目錄裡被 git 帶走。所有腳本都吃 `--project <路徑>`，省略即用目前工作目錄。

**步驟 3｜驗收（用 doctor，不用問使用者）**

OAuth 管道跑 `gmail_oauth.py doctor`——五項全綠才算完成。常見的未通過與處置：

| doctor 輸出 | 意思 | 處置 |
|---|---|---|
| `尚未啟用 Gmail API`（附連結） | 專案沒開 API | 開它給的**那個連結**按啟用（別用文件裡的路徑，Google 給的才是對的） |
| `invalid_grant` | 授權已失效 | 重跑 `setup` |
| `授權範圍不含 gmail.send` | scope 不對 | 重跑 `setup` 重新授權 |
| `收件人未設定` | 缺 recipients | 問使用者收件人並寫進 config |

其他管道（app password / MCP 草稿）跑 `setup_gate.py status`，看到 `SETUP_OK` 才算完成。

驗收通過後回到第 5 步交付。**寄送若仍失敗，先跑 doctor 再猜原因**——它會直接指出是哪一環。

## 界線（誠實告知）

- 日報品質取決於 session 記錄的可讀性；純瀏覽器操作、外部會議等 Claude Code 之外的工作不會出現，提醒使用者可口頭補充後由 Claude 補進報告。
- 不自動排程。要每天固定寄，另行搭配 Windows 工作排程器或 delaylocal（屆時仍建議人工核可後寄）。
- 寄送對象由設定檔管理；本 skill 不維護聯絡人清單。
