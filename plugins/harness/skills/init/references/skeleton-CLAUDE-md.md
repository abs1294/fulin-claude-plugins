# CLAUDE.md — {{專案/workspace 名稱}} 工作區（路由中心）

本檔是 workspace 主入口：只放「邊界＋路由表」。細節規則一律在獨立檔案，本檔告訴你去哪讀。

---

## 1. Workspace 對照

| 資料夾 | 內容 |
|--------|------|
| `{{repo 或資料夾}}` | {{一句話：是什麼、remote 指向哪（外部 remote 要標明）}} |
{{每個頂層資料夾一列；含敏感目錄要標「禁止外傳」}}

## 2. 治理分層

{{三選一，刪掉不適用的：

（A）目標 repo 已有治理層（AGENTS.md／.agents/ 等）：
- 開發流程與技術棧規則的正本＝{{治理層入口檔路徑}}——本檔與 harness 不得重定義開發流程，遇開發流程問題一律讀它並照它的載入規則走。
- 本檔＋`.claude/harness/` 只管 Claude Code 特有行為：subagent 模型派工、指揮官紀律、停損／熔斷、隔離驗證、memory 協議。
- 衝突仲裁：`使用者當下指示 > {{治理層入口檔}}（開發流程／stack）> 本檔與 harness（Claude 行為）> memory`，衝突時回報使用者。

（B）無既有治理層：
- 衝突仲裁：`使用者當下指示 > 本檔 > harness > memory > 程式碼註解`，衝突時回報使用者。

（C）多 repo 各有自己的 CLAUDE.md：
- 仲裁：`使用者當下指示 > 本檔 > repo CLAUDE.md > harness > memory`。}}

## 3. 絕對邊界

1. {{外向動作條款：remote 為外部/客戶時「push 前徵得同意」；無則刪}}
2. commit message 與程式碼不加 AI 署名；commit／push 一律走 `git-commit` skill，禁止裸 `git commit`（{{若有裝 git-commit plugin：plugin 的 PreToolUse hook 會攔裸 commit；無則改寫為「commit 前照 03 矩陣 B 自查」}}）。
3. {{既有治理層/共用資源保護條款；無則刪}}
{{Phase 3 Q2 確認要熔斷的危險動作逐條列（寄信、打外部 API、毀滅性 SQL、部署、金流、實機硬體、資料管線中本專案命中的項）：「<動作>：執行前徵得使用者同意（03 C2）」；無則刪}}
4. 檔案／內容搜尋一律限定在本 workspace 或 repo 目錄內，禁止全碟掃描（全域規則）。
5. {{敏感物條款：憑證/機密目錄不得出現在 commit、文件、對外輸出；無則刪}}

## 4. 開發流程（Agent Pipeline）

{{既有治理層有 pipeline 時整節改成一句：「開發流程正本＝{{治理層入口檔}}，見 §2 分工。」否則保留：}}

```
{{Phase 3 Q1 確認後的 pipeline（與 04 模板五同一份，只貼圖不貼說明）}}
```

- 編排細節、配套三條（無條件對齊回合／QA 先於 review／分流例外）、開發計畫格式：見 `.claude/harness/04-delegation-templates.md` 模板五。
- 各 agent 的職責與交接契約：見 `.claude/agents/<agent>.md`。
- 未過審查的程式碼不得視為完成；行為類未過 QA 不得 commit（03 B4）。

## 5. 路由表（遇到這類問題，只信這個檔）

| 問題類型 | 唯一正本 |
|----------|----------|
| 派工／模型選擇／升降級／隔離驗證／agent 對照 | `.claude/harness/02-model-dispatch.md` |
| 卡關停損／完成判準／何時問使用者 | `.claude/harness/03-judgment-matrix.md` |
| 派工 prompt 怎麼寫／pipeline 編排／QA 派工 | `.claude/harness/04-delegation-templates.md` |
| 踩坑紀錄／制度檔修改權限／健檢／升格 | `.claude/harness/05-knowledge-protocol.md` |
| 各 agent 的職責、觸發時機、交接契約 | `.claude/agents/`（{{裁切後實際建立的 agent 檔名逐一列出}}） |
| 哪些規則有程式擋（他律） | `.claude/settings.json` 的 hooks 區＋`.claude/hooks/`（{{Phase 3 Q5 確認安裝的 hook 逐一列出}}） |
| 本專案特有詞彙（這個詞是什麼意思） | `CONTEXT.md`（workspace 根） |
| 跨模組鏈路（動 A 層要不要同步 B 層） | `FLOWS.md`（workspace 根） |
| QA 操作坑與測試設計知識 | `tests/Project_Detail/PROJECT.md` |
| 動手前必讀文件 | {{Phase 3 Q7 的答案逐一列出絕對或相對路徑；也寫進 04 共通規則的「開工前必讀清單」}} |
{{既有治理層一列：| 開發流程／review gate／stack 限制 | {{路徑}} |；無則刪}}

引用規則時寫「見 <路徑>」——內文、項數、流程摘要不得複製到其他文件（防漂移）。

## 6. 本檔維護

本檔屬紅區：修改前先說明原因、位置、建議內容，經使用者確認後才動。分級制見 `.claude/harness/05-knowledge-protocol.md` §1。

## Changelog
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）
