# daily-report

把一整天散在各專案的 Claude Code 對話，濃縮成一封「主管/客戶看得懂」的工作日報，經你過目核可後透過 Gmail 寄給**該專案指定的收件人**。

## 怎麼用

跟 Claude 說「產今天的日報」「昨天的日報補寄」即觸發。流程：

1. 掃描 `~/.claude/projects/` 當日 session（自動濾掉 subagent、SDK 自動化、系統注入雜訊，只留人的工作）
2. 按專案分組生成日報（做了什麼＋待辦/未完成；統計數據只在對話顯示、不寄出）
3. **呈現給你過目**，並開始一段確認窗口（預設 30 分鐘，可設定）
4. 交付：你說寄就立刻寄；你喊停就不寄；**窗口內沒回應則自動寄出**（無人值守設計，掛著不顧回來已寄好）

## 三條交付路徑（依你的設定檔自動判斷，不會每次問你）

| 你的 config 有什麼 | 走哪條 | 前置設定 |
|---|---|---|
| `oauth.refresh_token` | **Gmail API OAuth**（推薦） | 一次性：開 GCP 專案 + 一鍵授權（Claude 會逐步帶你做） |
| `smtp.app_password` | **SMTP 直寄** | 兩步驟驗證 + 產生 16 碼應用程式密碼（⚠ 公司帳號多半不可用，見下） |
| 都沒有（且有 Gmail MCP） | **MCP 建草稿** | 零設定，你自己在 Gmail 按送出 |

**為什麼推薦 OAuth**：權限只有 `gmail.send`——能寄不能讀，讀不到你任何信件；token 會過期、可隨時撤銷。應用程式密碼則等同**整個信箱的完整存取權且永不過期**（Google 官方立場是不推薦）。

> ⚠ **公司 Google Workspace 帳號請直接走 OAuth，別試 app password。** Workspace 管理員預設會停用應用程式密碼——你到 `myaccount.google.com/apppasswords` 只會看到「The setting you are looking for is not available for your account」。這是公司政策，不是設定錯誤，plugin 繞不過。判斷方式：信箱是公司發的（`you@公司網域`）就是 Workspace 帳號。（同理，OAuth 在 Workspace 也可能被管理員限制第三方 app 授權——若授權被擋，需請 IT 放行，或改用個人 Gmail 寄。）

> 💡 **走 OAuth 時，client_id / client_secret 可以直接給 Claude**（當參數餵給 setup 腳本）。桌面應用程式類型的 secret 按 Google 設計就不是機密（隨程式散佈到每台電腦、本來就藏不住），不必遮掩。**只有 app password 是真憑證**——那個請自己填進設定檔，別貼進對話。

## 憑證與收件人分兩層（重要）

設定分兩個位置，刻意分開：

| 放什麼 | 放哪 | 進 git？ |
|---|---|---|
| **憑證**（oauth / smtp）＋帳號層預設（channel、subject_prefix、from_name） | 家目錄 `~/.claude/daily-report/config.json` | 否（機密） |
| **收件人**（recipients / cc） | **各專案** `<專案>/.claude/daily-report.json` | 由你決定 |

**收件人為什麼綁專案、不放家目錄**：憑證跟「人」綁定（你就一組 Gmail 授權），收件人跟「專案」綁定（Winbond 的日報不該寄給另一個客戶的窗口）。如果家目錄的收件人被當預設，一個還沒設收件人的新專案會**默默借用**家目錄的收件人寄出去——寄給不相干的人。所以家目錄的 `recipients` **不會被採用**；沒設專案收件人的專案，`status` 會回 `SETUP_REQUIRED`、寄送會被拒（要臨時寄用 `--to a@x`）。範本見 `daily-report.project.example.json`。

**首次使用不用自己看文件**：跟 Claude 說產日報，它偵測到沒設定會問你要哪條路，選 OAuth 就**一步一步帶你做完**（建專案 → 啟用 API → 設定同意畫面 → 建用戶端 → 執行授權），最後那步瀏覽器自動跳出、按個「允許」就完成，refresh token 自動寫進設定檔。

**設定對不對不靠猜——跑 `gmail_oauth.py doctor`**：它實際打 Gmail API 逐項驗證（設定檔、用戶端、授權能否換 token、API 是否已啟用、寄件帳號、收件人），哪一項沒過就指出來，並附上 **Google 當下回傳的**錯誤與修復連結。做這個是因為作者自己照引導跑一遍，仍漏掉「啟用 Gmail API」直到寄信被 403——**引導文字會被漏讀、Console 路徑會改版，實測不會**。

**分享給別人用**：這個 plugin **不內建任何 OAuth 憑證**（刻意的——避免配額、驗證狀態、撤銷風險全綁在單一人身上）。對方裝了之後跑同樣的引導、開自己的 GCP 專案即可；或你把自己的 client_id/secret 給他填，他只需跑最後一步授權。

**憑證怎麼確保不會外流**（設定檔與範本長得一樣，只差值空不空，所以靠機制不靠自律）：

1. 真設定檔在 `~/.claude/daily-report/config.json`（**家目錄**），plugin 從 marketplace 裝下來只會進 `~/.claude/plugins/cache/`，兩者不相干——別人下載 plugin 不會拿到任何人的憑證。
2. `.gitignore` 擋掉誤複製進 repo 的真設定檔。
3. `git-commit` plugin 的 commit 硬閘（0.1.6+）掃 staged diff 的**憑證特徵字串**（`*.apps.googleusercontent.com`、`GOCSPX-`、`1//` refresh token、`ya29.`、`AIza`、PEM 私鑰），命中即拒絕 commit 且**不可用 `--allow-sensitive` 豁免**，輸出還會遮蔽值本身。
4. `check_no_secrets.py` 可獨立掃全 repo 的 JSON 範本作二次確認。

## 前置依賴

- Python 3（純 stdlib，零套件安裝——OAuth 流程也是自己實作，不需 google-api-python-client）
- 家目錄設定檔（憑證）：`~/.claude/daily-report/config.json`（範本 `skills/daily-report/config.example.json`）。**含機密，只放家目錄、絕不進 git**
- 專案設定檔（收件人）：`<專案>/.claude/daily-report.json`（範本 `skills/daily-report/daily-report.project.example.json`）

## 檔案

| 檔案 | 用途 |
|------|------|
| `skills/daily-report/SKILL.md` | 主流程（萃取→生成→核可→寄送） |
| `skills/daily-report/scripts/extract_sessions.py` | 掃 session jsonl 產中間 JSON（mtime 預過濾、sidechain/SDK/注入過濾、ai-title 直取） |
| `skills/daily-report/scripts/setup_gate.py` | 設定閘：`status`（退出碼決定走哪條管道）/`options`/`guide`——首次設定的引導由它產生內容 |
| `skills/daily-report/scripts/gmail_oauth.py` | Gmail API OAuth：`setup`（loopback + PKCE 引導式授權）/`send`/`status`/**`doctor`**（零外部套件） |
| `skills/daily-report/scripts/send_common.py` | 兩條寄送路徑共用的前置契約（展開路徑/收件人/內容閘/確認閘/sent 去重）——對等性由此保證 |
| `skills/daily-report/scripts/send_gmail.py` | Gmail SMTP 寄送（前置走 send_common，只保留 SMTP 連線） |
| `skills/daily-report/scripts/content_guard.py` | **內容硬閘**：擋 AI/工具鏈用語＋憑證/個資/金額，寄送前必過，無豁免旗標 |
| `skills/daily-report/scripts/confirm_gate.py` | **確認窗口閘**：`arm`/`check`/`veto`/`clear`，時間與狀態由腳本判定，專案間隔離 |
| `skills/daily-report/scripts/check_no_secrets.py` | 機制閘：掃 repo 內 JSON 範本有無真憑證（`--staged` 供 pre-commit 用） |
| `skills/daily-report/config.example.json` | 家目錄設定範本（憑證＋帳號層預設） |
| `skills/daily-report/daily-report.project.example.json` | 專案設定範本（收件人；複製到 `<專案>/.claude/daily-report.json`） |

## 界線（誠實說明，裝之前請讀）

- 只涵蓋 Claude Code 內的工作；會議、瀏覽器操作等要口頭補充。
- **內容硬閘擋得住「形狀明確」的東西**（AI 用語、憑證、身分證字號、金額），但**擋不住語意層的機密**——客戶名稱、專案代號、商業判斷這些沒有固定形狀，靠的是產生日報時的改寫。寄出前請看過內容，這是最後一道防線。
- **私人 session 的過濾是模型判斷，不是機制**。工具會掃你當日所有對話，包含你可能問過的私人問題；模型被指示略過明顯私人的內容並告知，但這是自律。在意的話用 `--project` 限定範圍。
- 中間檔 `~/.claude/daily-report/out/*.json` 存有對話原文摘要，**目前不會自動清理**——家目錄若有雲端同步請留意。
- 不自動排程。要每天固定寄，需自行搭配工作排程器。

## 已知風險與依據（2026-07 調查）

- **session jsonl 是非官方格式**：官方文件明言 transcript 格式屬內部實作、版本間會變（建議用 /export）。本 plugin 的解析已做防禦（單行畸形跳過不斷全局、型別守衛），但大改版後仍可能要調 extract 腳本。同類 OSS（claude-code-log ~1.2k星、claude-usage ~2k星、AgentHUD 等至少 5 個工具）都直讀 jsonl——這是社群主流做法，沒有更含敘事內容的替代源（OTel 只有數字 metrics）。
- **Gmail app password**：2026 年中對**個人 Gmail** 帳號 SMTP 仍可用（需 2FA），但 **公司 Google Workspace 帳號多半被管理員停用**（實測：頁面顯示 setting not available）——公司帳號請走 OAuth。Google 官方立場對 app password 是「不推薦、建議遷移」且無明確落日日期。**本 plugin 已內建 OAuth 路徑**（`gmail_oauth.py`，走 Gmail API + `gmail.send` 最小權限），app password 保留為選配。註：若想「維持 SMTP 但改 OAuth」（XOAUTH2）反而要更寬的全信箱 scope，所以最小權限只能走 API 版。
- **OAuth 同意畫面「測試中」狀態的 refresh token 7 天過期**：長期使用要在 GCP 的「目標對象」頁按「發布應用程式」（個人自用不觸發 Google 驗證要求）。授權失效時 `send` 會回報 `invalid_grant` 並指示重跑 `setup`。
