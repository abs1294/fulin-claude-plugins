# 實例化改編原則（adaptation guide）

骨架填空之外的判斷都在這裡。來源：Supplier_Code harness（2026-07-03 建立，含 01~06 完整版）與兩個實例化實戰（fulin-claude-plugins 手動版、汎銓 2026-08-19 版）的教訓。

## 1. 通用／專案的切分判準

| 內容類型 | 處置 |
|----------|------|
| 行為紀律（停損信號、熔斷條件、三重自查、回報鏈鐵則、隔離驗證、指揮官不下場） | 骨架原文保留，不因專案改動 |
| 驗證指令（build/test/run） | 每專案實查填入；寫「查法」優於寫「陳述」（陳述會過時） |
| agent 名單與 pipeline | 目標專案有自己的 agents 才填；沒有就用內建 type（Explore/general-purpose/Plan），**不要把別專案的 agent 組合搬過去** |
| 事故條款（源自特定專案的 DoD 細則、guard hooks、「已知的坑」） | **不搬**。骨架 DoD 只留核心；坑欄留空標「從本專案 memory 撈」 |
| 診斷書（01）、交接信（06） | 不進骨架——那是各專案自己的病歷與遺囑，等實例自己長 |

判斷測試：這條規則換一個語言／產業還成立嗎？成立＝通用進骨架；不成立＝專案事實，實查填入或不搬。

## 2. 既有治理層的讓位規則

目標 repo 已有 AGENTS.md／.agents/ 這類治理層（常見於多工具協作 repo）時：

- 開發流程（sizing、gate、review checkpoint、stack 限制）正本＝它；harness 實例**只管 Claude Code 特有層**：subagent 模型派工、停損熔斷、隔離驗證、memory 協議。
- 路由中心（CLAUDE.md）明寫分工與衝突仲裁順序；04 的「開工前必讀清單」改接該治理層的檔案；**不建流程編排模板**（讓位給它的 pipeline）。
- 該治理層檔案列入實例 05 的紅區（通常已入版控＝共用資源）。
- 引用它的內容時**先驗證**（實查目錄與檔案，勿信其自述——實戰抓過治理層自己的文件漂移：宣稱有測試目錄實際沒有）。

## 3. 外向邊界判定

- `git remote -v` 指向客戶／外部伺服器 → 實例 CLAUDE.md 必寫「push 前徵得同意」；實例落點預設 workspace 根（不進 repo）。
- workspace 內有憑證／VPN／機密目錄 → 絕對邊界寫明「不得出現在 commit、文件、對外輸出」。
- commit 不加 AI 署名屬全域規則，實例只需提醒適用範圍，不重複條文（SSOT）。

## 4. 去專案化檢核（Phase 4 用）

實例生成後 grep 以下詞表，命中＝來源污染（changelog 的出處標註除外）：

```
vee|snakeize|dotnet|winbond|supplier|playwright|BPM|APIM|SQL MI|qa-engineer|frontend-engineer|backend-engineer|smoke-test|COVERAGE|FLOWS\.md|CONTEXT\.md|grilling|P360|HMS2|SAP|LDAP|5181|5182|8080|8081
```

（此表列的是 Supplier_Code 專案詞。若未來骨架從別的實例回收條款，把該專案的特徵詞補進本表。）

## 5. 骨架維護（引擎側）

- 骨架檔屬本 plugin，改動走 monorepo 慣例（bump 版本＋publish）。
- **回收條款的門檻**：某實例的升格條款要進骨架，必須「≥2 個專案獨立踩過同類坑」或「與專案無關的純行為紀律」；單一專案的事故留在該實例。
- 骨架改版**不回寫既有實例**——實例自治，要同步由各專案自己依其 05 紅區流程決定。plugin 更新覆蓋的只有骨架與本指南，永不觸碰任何專案的 `.claude/harness/`。

## 6. 已知的實例差異（現況登記，2026-08-19）

- Supplier_Code：完整版（01~06＋guard hooks＋沉澱閘），本 plugin 的骨架來源。
- fulin-claude-plugins：手動版（A/C/D/E/F/G 命名），早於本 plugin，命名體系不同——**不強制遷移**，它自己的 F 反思協議管自己。
- 汎銓：2026-08-19 首個標準實例（02~05＋讓位 AGENTS.md），本 plugin 骨架的驗收樣本。
