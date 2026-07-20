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

- stdout 唯一輸出＝中間檔路徑（`~/.claude/daily-report/out/<date>.json`），直接 Read 它。
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

### 4. 呈現與核可

在對話中給使用者兩塊東西：

1. **日報全文**（將寄出的內容，一字不差）。
2. **本機統計**（只顯示不寄出）：專案數、session 數、活躍時段、工具呼叫 top 5。

然後明確問是否寄出。使用者要改就改（改完更新報告檔），要求寄出才進下一步。

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

**步驟 3｜驗收**

引導跑完後再跑一次 `setup_gate.py status`，必須看到 `SETUP_OK` 才算完成；還是 exit 10 就照它印出的原因補（最常見是 `recipients` 沒設）。確認通過後回到第 5 步交付。

## 界線（誠實告知）

- 日報品質取決於 session 記錄的可讀性；純瀏覽器操作、外部會議等 Claude Code 之外的工作不會出現，提醒使用者可口頭補充後由 Claude 補進報告。
- 不自動排程。要每天固定寄，另行搭配 Windows 工作排程器或 delaylocal（屆時仍建議人工核可後寄）。
- 寄送對象由設定檔管理；本 skill 不維護聯絡人清單。
