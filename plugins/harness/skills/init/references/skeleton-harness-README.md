# Harness 制度總覽（導航頁）

> 建立：{{YYYY-MM-DD}}，由 harness plugin `/harness:init` 實例化。
> 目的：讓各級模型在此框架下穩定自主產出。入口：workspace 根 `CLAUDE.md` 會路由到本目錄。
> 本實例帶的是**開發流程骨幹**（行為紀律＋參數化判準＋agent pipeline＋機械閘）＋本專案已查證的事實；**不帶任何專案的事故條款**——那些從本專案自己的 memory 長出來，依 `05` §6 升格。
> ⚠ 誠實揭露：這是骨架＋長出資產的路徑，不是一套成熟的 harness。成熟的 harness 還包括數十到上百條踩坑知識、數百支回歸測試、每個模組的覆蓋登記——那些要靠本專案自己跑出來，init 給不了。

## 檔案清單與用途

| 檔案 | 用途 | 誰在什麼時候讀 |
|------|------|----------------|
| `02-model-dispatch.md` | 模型調度與升降級：指揮官不下場、派工三件套、隔離驗證 | 指揮官（主對話）每次要派工或卡關時 |
| `03-judgment-matrix.md` | 判斷力外化：停損信號、完成判準（DoD）、熔斷條件 | 所有模型；卡關時、宣稱完成前、想問使用者前 |
| `04-delegation-templates.md` | 標準化派工 prompt 模板 | 指揮官派 subagent 前，複製填空 |
| `05-knowledge-protocol.md` | 檔案分級、踩坑紀錄格式、健檢、升格協議 | 踩坑後要記錄時；想改任何制度檔時 |

**制度層以外、同一套 init 一起建的東西**：

| 位置 | 用途 | 誰在什麼時候讀 |
|------|------|----------------|
| `.claude/agents/` | pipeline 各角色的 agent 定義（{{裁切後的 agent 名單}}） | 派工時由 Agent tool 載入；改職責前先讀 |
| `.claude/hooks/` ＋ `.claude/settings.json` | 機械閘（他律）：{{Q5 確認安裝的 hook 與一句用途}} | 被擋時看 deny 訊息；健檢時 dry-run |
| workspace 根 `CONTEXT.md` | 本專案特有詞彙表（詞是什麼，不是怎麼做） | 詞義不清、詞義衝突時當場查與補 |
| workspace 根 `FLOWS.md` | 跨模組鏈路圖（只收踩過坑或橫跨 ≥2 模組的） | 動到已收錄鏈路任一層前必讀 |
| `tests/Project_Detail/PROJECT.md` | QA 操作坑與測試設計知識 | QA agent 開工前必讀 |

（無 `01-diagnosis.md`、`06-handover-letter.md`：那是各專案自己的病歷與遺囑。本專案累積出自己的痛點後，可依 05 協議建立。）

## 快速啟動（給未來的主對話模型）

1. 先讀 workspace 根 `CLAUDE.md`——治理分層與絕對邊界在那裡。
2. 要派工 → 讀 `02` 決定模型與模式，用 `04` 填空。
3. 卡關（同一錯誤重複出現）→ 讀 `03` 矩陣 A 對照信號。
4. 宣稱完成前 → 對照 `03` 矩陣 B 逐條打勾。
5. 踩坑 → 依 `05` 格式寫 memory；想改制度檔 → 先查 `05` §1 分級。
6. 講需求要開發 → 照 `04` 模板五的 pipeline 走（先對齊回合、再計畫確認、再一路推進）。
7. 碰到不確定的專案詞 → 查 `CONTEXT.md`；動到跨模組的東西 → 查 `FLOWS.md`。

## 生效範圍限制（實話）

{{照實填：SessionStart 提醒由 harness plugin 的條件式 hook 提供（需該專案啟用 harness plugin）；或本專案 .claude/settings.json 自帶 inline 提醒。hooks 只在 workspace 根（{{路徑}}）開 session 時生效；在子 repo 內開 session 時 CLAUDE.md 仍會被讀到（祖先目錄），但 hooks 不會。}}

`.claude/hooks/` 裡的 hook 是 init 當下**從 harness plugin 複製過來的範本**，之後歸本專案自治：可以自己改，代價是 plugin 更新不會自動同步到這裡（要同步就對照 plugin 的 `hooks/templates/` 手動合併）。hook 全部是 fail-open——hook 本身故障時放行並印錯誤，不會擋死工作，但也代表**它壞掉時不會自己告訴你規則已失效**，所以健檢要 dry-run（`05` §5）。

## 修改權限

本目錄檔案原則上是紅區（改前徵得使用者同意）；例外：`04` 的新增模板屬黃區。分級正本見 `05` §1。

## Changelog
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）
