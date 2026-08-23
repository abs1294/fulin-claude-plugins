# Harness 制度總覽（導航頁）

> 建立：{{YYYY-MM-DD}}，由 harness plugin `/harness:init` 實例化。
> 目的：讓各級模型在此框架下穩定自主產出。入口：workspace 根 `CLAUDE.md` 會路由到本目錄。
> 本實例刻意精簡：只帶通用紀律骨架＋本專案已查證的事實；規則等踩坑再依 `05` §6 升格，不預載別的專案的事故條款。

## 檔案清單與用途

| 檔案 | 用途 | 誰在什麼時候讀 |
|------|------|----------------|
| `02-model-dispatch.md` | 模型調度與升降級：指揮官不下場、派工三件套、隔離驗證 | 指揮官（主對話）每次要派工或卡關時 |
| `03-judgment-matrix.md` | 判斷力外化：停損信號、完成判準（DoD）、熔斷條件 | 所有模型；卡關時、宣稱完成前、想問使用者前 |
| `04-delegation-templates.md` | 標準化派工 prompt 模板 | 指揮官派 subagent 前，複製填空 |
| `05-knowledge-protocol.md` | 檔案分級、踩坑紀錄格式、健檢、升格協議 | 踩坑後要記錄時；想改任何制度檔時 |

（無 `01-diagnosis.md`：那是各專案自己的病歷。本專案累積出自己的痛點後，可依 05 協議建立。）

## 快速啟動（給未來的主對話模型）

1. 先讀 workspace 根 `CLAUDE.md`——治理分層與絕對邊界在那裡。
2. 要派工 → 讀 `02` 決定模型與模式，用 `04` 填空。
3. 卡關（同一錯誤重複出現）→ 讀 `03` 矩陣 A 對照信號。
4. 宣稱完成前 → 對照 `03` 矩陣 B 逐條打勾。
5. 踩坑 → 依 `05` 格式寫 memory；想改制度檔 → 先查 `05` §1 分級。

## 生效範圍限制（實話）

{{照實填：SessionStart 提醒由 harness plugin 的條件式 hook 提供（需該專案啟用 harness plugin）；或本專案 .claude/settings.json 自帶 inline 提醒。hooks 只在 workspace 根（{{路徑}}）開 session 時生效；在子 repo 內開 session 時 CLAUDE.md 仍會被讀到（祖先目錄），但 hooks 不會。}}

## 修改權限

本目錄檔案原則上是紅區（改前徵得使用者同意）；例外：`04` 的新增模板屬黃區。分級正本見 `05` §1。

## Changelog
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）
