---
name: git-commit
description: >
  並行審查模式的 Git Commit 流程：Stage → 並行三軌（使用者確認 message + Codex 審查 + code-reviewer 審查）→ Commit → Push。
  觸發詞（任一命中即觸發）：
  - 中文：「commit」、「提交」、「上版」、「推上去」、「推上板」、「推」
  - 指令式：「git commit」、「git push」、「git add」、「push」
  - 組合：「commit and push」、「commit 後 push」、「stage 一下」
  **重要**：AI 禁止直接執行 `git commit` / `git push` / `git add` 指令。
  只要使用者意圖是「要把程式碼提交或推上去」，一律透過本 skill 走完整流程。
---

# Git Commit Skill — 並行審查流程

本 Skill 定義本專案的 Git 提交流程。

**核心設計：Codex Review 與 code-reviewer 審查前移到 commit 之前，與使用者確認 commit message 三軌並行跑。**

| 階段 | 動作 |
|------|------|
| Step 1 | 分析 + Stage → **並行三軌（使用者確認 message + Codex 審查 + code-reviewer 審查）** → 匯流決策 |
| Step 2 | Commit → Push → 確認結果 |

這麼做的好處：
1. 兩軌審查看的是 **尚未 commit 的 staged diff**，若 BLOCK 只需修改程式碼 + 重新 stage，**無需 `git revert` 或 `git reset`**
2. 使用者審閱 commit message 預覽時，Codex 與 code-reviewer 同步審查，**減少等待時間**
3. git 歷史永遠乾淨，不會留下「Fix → Revert → 新 Fix」的噪音

---

## 核心原則（不可違反）

> **Commit 的觸發條件：Codex PASS（或已豁免）✅ ∧ code-reviewer PASS（或已豁免）✅ + 使用者未明確否決。**

本 skill 採「**三軌審查默許機制**」：

| 情境 | 行為 |
|------|------|
| Codex + code-reviewer **皆 PASS**（有 / 無清單）+ 使用者**尚未回覆** | → **自動** 進 Step 2，不等使用者 |
| Codex + code-reviewer 皆 PASS + 使用者**明確確認 ✅** | → 進 Step 2 |
| 兩軌皆 PASS + 使用者**明確否決 🖊**（要改 message / staging / 攔截） | → 照使用者意思處理，不 commit |
| **任一軌豁免**（Style / Docs 純樣式/純文字）+ 使用者**尚未回覆** | → **自動** 進 Step 2（豁免比照 PASS 默許，自動 commit + push） |
| 任一軌豁免 + 使用者**明確確認 ✅** | → 進 Step 2 |
| 任一軌豁免 + 使用者**明確否決 🖊** | → 照使用者意思處理，不 commit |
| **任一軌 BLOCK** + 任何狀態 | → **絕不自動 commit**，列出必修項 |

其他規則：

- 無論是首次 commit、BLOCK 後重做，都必須完整走過 Step 1（分析 + Stage → 並行三軌）→ 匯流 → Step 2（執行）
- 禁止沿用先前已確認的 commit message 直接 commit（程式碼可能已改動）
- **原則上不得跳過任何審查軌**，唯一例外見下方「Review 豁免規則」
- 預覽（1.3a）必須清楚告知使用者「兩軌審查 PASS 後會自動 commit，要攔截請在審查完成前回覆」

---

## Review 豁免規則

為避免對純樣式 / 純文件的瑣碎變更浪費審查資源，以下類型**自動豁免 1.3b 與 1.3c 兩軌**（仍需 1.3a 預覽 + 使用者確認）：

### 可豁免的 Type

| Type | 豁免條件 | 典型內容 |
|------|---------|---------|
| `Style` | **必須全為純 UI / CSS / formatting 調整**，不得夾帶 JS / TS / C# 邏輯改動 | CSS class 調整、Tailwind 調寬高、字體/顏色/間距、Prettier 格式化 |
| `Docs` | **僅 `.md` / 註解文字** 變更，不得碰 source code | README、技術文件、XML doc comment 補充 |

### 仍須審查的情況（即使使用者標 Style/Docs）

判斷原則：**只要 diff 觸及「會被執行到的程式邏輯」，一律不豁免。**

| 情境 | 動作 |
|------|------|
| Style commit 但 diff 含 `.vue` 的 `<script>` 區塊 | ❌ 不豁免 |
| Style commit 但 diff 改了 template 中的 `v-if` / `@click` 綁定 | ❌ 不豁免 |
| Style commit 但 diff 改了 i18n 的 **key**（會影響 `$t()` 查找） | ❌ 不豁免 |
| Style commit 僅改 i18n 的 **value**（純文字翻譯） | ✅ 豁免 |
| Docs commit 但 diff 含 `.cs` / `.js` / `.ts` / `.vue` 的**邏輯行** | ❌ 不豁免 |
| Docs commit 僅改 XML doc `/// <summary>` 內文 | ✅ 豁免 |

### 豁免時的執行流程

1. 在 1.2 分析變更時判斷是否符合豁免條件
2. 若符合 → 在 1.3a 預覽中**明確標示**「Codex Review：已豁免 / code-reviewer：已豁免（Style / 純樣式）」
3. Task #4（1.3b）與 Task #5（1.3c）**直接標記 `completed`**，備註 `skipped: style-only` 或 `skipped: docs-only`
4. 匯流決策只看 A 軌（使用者確認）
5. **敏感字掃描（1.2.1）仍必做**，豁免範圍僅限兩軌 Review

### 反豁免觸發（AI 自主拒絕豁免）

若使用者標 Style/Docs 但 AI 檢視 staged diff 發現任何「反豁免情境」命中，**必須**：
1. 告知使用者：「你標 Style，但 diff 裡有 X 檔的邏輯修改，我仍會送兩軌審查」
2. 照常走 1.3b + 1.3c
3. 禁止私下豁免

---

## 強制步驟追蹤（MANDATORY）

**開始執行前，必須先用 TaskCreate 建立任務清單。** 不可跳過此步驟。

初始 9 個任務：

```
#1 1.1 辨識有變更的 Repository                        [in_progress]
#2 1.2 分析變更 + 判斷豁免 + Stage 相關檔案             [pending]
#3 1.3a 顯示 Commit Message 預覽                      [pending]
#4 1.3b 送 Codex 審查 staged diff（可豁免）            [pending]
#5 1.3c 送 code-reviewer 審查 staged diff（可豁免）    [pending]
#6 1.4 匯流：使用者確認 ∧ Codex PASS ∧ code-reviewer PASS（或豁免） [pending]
#7 2.1 執行 Commit                                   [pending]
#8 2.2 Push                                         [pending]
#9 2.3 確認結果                                      [pending]
```

**執行規則：**

- **每個步驟開始前**，用 TaskUpdate 將該任務標記為 `in_progress`
- **⚠️ 每個步驟完成的「當下那一輪訊息」就必須 TaskUpdate 成 `completed`**，禁止累積到下一步才補。特別強調：
  - **1.3a 預覽**：只要把預覽訊息送出、並觸發 1.3b + 1.3c 的兩個 agent，**同一輪內** Task 就要標 `completed`（預覽「輸出動作」已完成，不要等使用者回覆或 agent 回來才關）
  - **1.3b / 1.3c Review**：收到對應 agent 的 `task-notification` 當下那一輪就要標 `completed`，不要等 1.4 匯流時才補
  - **2.x 系列**：`flow.sh ship` 一回來，commit / push / verify 三個 task 同一輪一起 `completed`
- **1.3a / 1.3b / 1.3c 必須同一輪訊息內啟動（真並行）**，三者可同時 `in_progress`
- **若命中豁免規則**：#4 / #5 跳過送審呼叫，直接標 `completed` 並於 description 註記 `skipped: style-only` 或 `skipped: docs-only`
- **1.4 匯流觸發時機**：B + C 軌（兩個 Review）**皆完成**即觸發匯流（不需等 A 軌）。A 軌若尚無使用者回覆，依默許機制處理：
  - 兩軌 `PASS` → 視為使用者默許，自動進 Step 2
  - **任一軌豁免（Style / Docs）** → 同樣視為默許，自動進 Step 2（豁免比照 PASS）
  - **任一軌 BLOCK** → 絕不自動 commit，列清單等使用者
- **BLOCK 回流時**：把 1.2（stage 部分）/ 1.3a / 1.3b / 1.3c / 1.4 的狀態 **reset 回 `pending`**，不建立新 task（避免清單膨脹）
- **禁止跳過任何步驟**（豁免 Review 不代表可以跳過 1.2.1 敏感字掃描）

### 🧹 流程結束時必做的清理（MANDATORY）

**2.3 確認結果完成後的「同一輪訊息」內，必須**：

1. 確認 `TaskList` 所有 9 個 task 都是 `completed`（若有殘留 `in_progress` 代表漏關，補上）
2. 對 9 個 task 逐一呼叫 `TaskUpdate status=deleted`，清空清單
3. 最後一步：結果摘要輸出中**主動確認**「task 清單已清空」

**禁止情境**：
- ❌ commit 已完成但 task list 還留著 `completed` 條目沒刪（等下次 commit 觸發才清，會造成舊 task 混入新流程）
- ❌ 預覽訊息送出後 task 停在 `in_progress`，要等使用者指出才補（應該送預覽的同一輪就關）
- ❌ 使用者已確認「OK」後，還留一堆 `completed` task 不處理

---

## ⚡ flow.sh 腳本（必用）

本 skill 提供 `flow.sh`（位於 `.claude/skills/git-commit/flow.sh`）把所有純 git / 檔案操作包成三個 subcommand，**主 AI 每階段只呼叫一次 bash，不要再手動組 `git status` / `git add` / `git commit` 指令**。

| 指令 | 動作 | 對應 Skill 步驟 |
|------|------|----------------|
| `flow.sh analyze <repo>` | 一次輸出：git 狀態分類（staged / modified / untracked）+ local-overrides 過濾 + 敏感字掃描 | 1.2（分析部分） |
| `flow.sh prepare <repo> <files...>` | `git add` → 產出 staged diff 到 `.claude/.git-commit-tmp/staged-<repo>.diff` | 1.2（Stage 部分） |
| `flow.sh ship <repo> <type> <description>` | `git commit` (HEREDOC) → `git push` → 結果驗證 | 2.1 + 2.2 + 2.3 |

**合法參數：**
- `<repo>`：`.`（工作目錄本身是 git repo），或工作目錄底下的 git 子目錄名（多 repo workspace）。flow.sh 會驗證該路徑確實是 git repo。
- `<type>`：`Feat` / `Modify` / `Style` / `Refactor` / `Perf` / `Chore` / `Docs` / `Test` / `Fix` / `Hotfix`

**腳本保留的規範：**
- 敏感字掃描（1.2.1）、local-overrides 過濾（1.2.2.1）由 `analyze` 自動執行
- Staged diff 輸出由 `prepare` 自動執行
- HEREDOC commit（2.1）、禁止 `--amend` / `--no-verify` / force push 由 `ship` 強制遵守

**不能靠腳本跳過的步驟（主 AI 必做）：**
- 1.2.3 豁免判斷（要讀 diff 內容決定）
- 1.3a 顯示預覽 + 等使用者確認
- 1.3b 啟動 Codex Review subagent
- 1.3c 啟動 code-reviewer subagent
- 1.4 匯流決策（三軌到齊才能推進）

---

## Commit Message 格式

```
{Type}: {簡短描述}
```

### Type 對照表

| 類型 | 說明 |
|------|------|
| Feat | 新功能 |
| Modify | 既有功能需求調整的修改 |
| Style | UI 調整、程式碼格式調整（formatting） |
| Refactor | 重構。對既有代碼的邏輯優化、命名調整等，不改變原本功能 |
| Perf | 改善效能 |
| Chore | 環境配置、CI/CD 配置等外部使用者看不到的專案建置設定、更新版本號等瑣事 |
| Docs | 純文件類型檔案的更動 |
| Test | 測試。新增測試、重構測試等 |
| Fix | 錯誤修正 |
| Hotfix | 緊急修正嚴重的 bug |

### 格式規則

- Type 首字母大寫（如 `Feat`，不是 `feat`）
- 冒號後空一格
- 描述使用中文，簡潔明瞭（1 句話，不超過 50 字）
- 範例：`Feat: 相關申請紀錄新增發起人欄位與 Excel 匯出`

### 描述應只寫「改了什麼」，不寫對話/流程上下文

Commit message 是給未來看 git log 的開發者看，不是給「這場對話的記憶」。**禁止把開發過程的內部標記寫進 message**：

| ❌ 不該寫的（內部討論細節） | ✅ 應該寫的（修改本身） |
|---|---|
| `Fix: 補 P0 防護` | `Fix: handleConfirmFinalReply 失敗時保留 dialog` |
| `Refactor: 紅藍對抗整合 P1+P2` | `Refactor: VeeDialog 取消按鈕對稱處理 async 例外與連點` |
| `Refactor: PoC 階段套用 VeeDialog` | `Refactor: 改善通知單供應商正式回覆改用 VeeDialog` |
| `Feat: 紅隊審查補強 a11y` | `Feat: VeeDialog 按鈕補 aria-busy / aria-disabled` |
| `Fix: 12 點全面修齊` | （拆 commit；每個 commit 講該檔的具體動作） |

**禁止關鍵字（這些屬於對話脈絡，不該出現在 commit message）：**
- `P0` / `P1` / `P2` / `Critical` / `Important` / `Minor`
- `紅藍對抗` / `紅隊` / `藍隊` / `Codex` / `code-reviewer`
- `PoC` / `階段` / `第 N 輪` / `補修`（除非真的描述 bug fix）
- `整合報告` / `整合結果` / `審查整合`
- 任何 reviewer agent 名稱或本 skill 流程關鍵字

**辨識方法：未來看 git log 的人，沒有今天的對話 context；如果 message 沒了 context 就看不懂，那就是太依賴內部脈絡，必須改寫為「對著 diff 也讀得懂」的純動作描述。**

---

## 多議題拆 Commit 規則（MANDATORY，不要問）

當一輪 dirty 檔案涵蓋兩個以上不相關議題（feature / fix / refactor），**直接拆成多個 commit，不要徵詢使用者偏好、不要詢問 commit message 用詞**。

### 為什麼

問是浪費 round trip、增加 context switching 成本。使用者明確說過「我比較偏好拆 commit，你不應該問我」。

### 怎麼判斷一個 commit

- 看 git diff 涵蓋的議題（用當前 task list 對應）
- **一個 task / 一個議題 = 一個 commit**
- **同議題跨多檔案則放同 commit**（例如 `vendor.js` + `i18n.json` 兩支都是同一個 fax 國際化議題 → 一個 commit）
- 跨多個議題的同檔案（例如 vendor.js 同時改 hasAgree04 + fax）→ 仍可一起 commit，commit message 統一概括

### 執行流程

1. 看 dirty 清單後，**自己決定拆成幾個 commit、每個包哪些檔案、commit message 用詞**（不要問）
2. 對每個 commit 順序執行完整 git-commit skill 流程（`analyze` → `prepare` → 三軌審查 → `ship`）
3. 完成第一個 commit 後，再 `analyze` 確認剩餘 dirty 檔案，繼續第二個 commit

### 例外（可以問）

- 無法明確判斷某檔案屬於哪個 commit（例如 diff 內混合多議題、難以拆檔）
- 改動跨 repo 邊界（內外站同時動，需確認誰先誰後）
- 改動涉及破壞性操作（amend、force push、rebase）

### Commit Message 範例

```
Modify: vendor schema 個資告知書整併至全 type 必填        ← #4
Modify: vendor schema companyFax 補 country-based 條件式驗證 ← #14
Modify: 廠商查詢操作欄無權限時整欄隱藏                      ← #15
```

---

## Step 1：分析 + Stage + 並行三軌 + 確認

### 1.1 辨識 Repository

git-commit 通用化後支援兩種工作目錄結構：

| 結構 | repo 參數 | 說明 |
|------|-----------|------|
| 單一 git repo 專案 | `.` | 工作目錄本身就是 git repo |
| 多 repo workspace | 子目錄名 | 工作目錄是上層（可能非 git），底下有多個 git 子目錄（例：供應商平台的 `WEHQ.SupplierManager.Service` 等），各自獨立 commit |

**辨識方式**：對工作目錄 `flow.sh analyze .`（單一 repo），或對每個有變更的子目錄 `flow.sh analyze <子目錄名>`（多 repo）。多 repo 時每個 Repository **各自獨立 commit**。

---

### 1.2 分析變更 + Stage 檔案

本步驟涵蓋：分析狀態（1.2.1 ~ 1.2.2.1）→ 判斷豁免（1.2.3）→ Stage 檔案（1.2.4）。

先對每個有變更的 Repository 執行：

```bash
.claude/skills/git-commit/flow.sh analyze <repo>
```

輸出同時包含：
- Branch / Staged / Modified / Untracked 檔案分類
- Excluded by local-overrides（自動過濾，1.2.2.1）
- Sensitive scan 結果（1.2.1，CLEAN 或 HITS 清單）

**1.2.1 ~ 1.2.2.1 的語義規範仍然有效，只是執行動作由 `flow.sh analyze` 代勞，AI 不需再手動跑 grep / awk。**

#### 1.2.1 敏感內容 / Debug 痕跡掃描（必做）

在 1.2.4 Stage 前先檢視即將 stage 的檔案內容，對以下 pattern 進行 grep：

| 類別 | 關鍵字範例 |
|------|-----------|
| 敏感資訊 | `password\|secret\|api_key\|bearer\|token=\|ConnectionString` |
| Debug 痕跡 | `console\.log\|Console\.WriteLine\|System\.out\.print\|debugger;` |
| 臨時標記 | `TODO: remove\|FIXME\|XXX\|// DEBUG\|// TEMP` |
| 硬編 JWT | `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` |

若發現命中，**在 1.3a 預覽時明確列出**，並請使用者確認「是否刻意保留」，避免不小心 commit 進去。

#### 1.2.2 可疑 unstaged / untracked 檔案告警

**前置：先載入本地覆寫清單 `local-overrides.yml`**（見下方 1.2.2.1）。清單內的檔案**不進入告警**（靜默跳過）。

對**不在清單上**的 unstaged / untracked 檔案，若符合以下 pattern，於 1.3a 預覽時提醒使用者：

- `appsettings.Localhost.json` / `appsettings.*.local.json` / `.env.local`
- `BlobStorage/` / `TestData/` / `tmp/` / `logs/`
- 含 hardcoded 測試用密碼 / JWT 的 Controller / middleware

可選處理：
- Untracked 檔案（如個人筆記、測試資料） → 加入 `.gitignore`
- 未列在 `local-overrides.yml` 的本地覆寫檔案 → 建議使用者將其加入清單（而不是 `skip-worktree`，skip-worktree 會阻止 remote 更新同步）

#### 1.2.2.1 本地覆寫清單（local-overrides.yml）

工作目錄層的 `.claude/local-overrides.yml`（你 launch Claude 的目錄）維護一份清單，記錄「團隊共用但本地常被個人覆寫」的檔案（Mock 切換、本地 DB 連線、測試 JWT 等）。**首次執行 `flow.sh analyze` 時若此檔不存在，會自動從 skill 的 `local-overrides.example.yml` 建立空範本。**

**載入時機**：1.2 分析變更開始時，立刻讀取並在記憶體中備妥每個 repo 的覆寫檔案路徑集合。

**影響範圍**：
| 階段 | 行為 |
|------|------|
| 1.2.2 可疑檔案告警 | 清單內的檔案**不列告警** |
| 1.2.4 Stage 檔案 | 清單內的檔案**預設不 stage**，也不在「建議 stage」列表出現 |
| 1.3a 預覽 | 清單內的檔案**不顯示**於 `Staged 檔案` 或 `可疑 unstaged` 區塊 |

**例外：使用者明確指示 commit 覆寫檔案時**

若使用者在 `/git-commit` 指令中明確說「這次要 commit `<路徑>`」且該路徑在清單內：
1. 本次流程 **override 一次**，將該檔案當作一般檔案處理（走 stage + 兩軌 Review 完整流程）
2. Commit 完成後，必須主動詢問使用者：「這次改動是否代表該檔案的本地預設值已變更？要不要從 `local-overrides.yml` 移除？」
3. 若使用者確認移除，則 skill 自動編輯 `local-overrides.yml` 刪除該條目，並額外 stage + commit `local-overrides.yml` 的變更（與主 commit 分離，訊息格式：`Chore: 更新 git-commit local-overrides 清單`）

**新增清單項目**：
當 skill 在多次 commit 中重複偵測到同一個「長期 unstaged 的 tracked 檔案」，**主動建議**使用者：「檢測到 `<路徑>` 連續 N 次未 stage，要不要加入 `local-overrides.yml`？」

#### 1.2.3 判斷 Review 豁免

依據擬定的 Commit Type 與 staged diff 內容，決定是否豁免 1.3b 與 1.3c。

**決策樹：**

```
擬定 Type 是 Style 或 Docs？
├─ 否 → 不豁免，走完整 1.3b + 1.3c
└─ 是 → 檢查 staged diff 是否全為「純樣式 / 純文字」？
    ├─ 否（含邏輯行）→ 不豁免，仍送兩軌審查，並告知使用者「diff 含邏輯修改」
    └─ 是 → ✅ 豁免 1.3b + 1.3c（兩軌同時豁免，不得只豁免其中一軌）
```

**「純樣式」白名單（全部命中才算）：**
- 檔案副檔名：`.css` / `.scss` / `.less` / `.sass`
- `.vue` 檔案的 **`<style>` 區塊** 或 **`<template>` 區塊中的 class / 屬性調整**（不含 `v-if`、`@click`、`:key` 等綁定改動）
- i18n 語系檔的 value 字串修改（key 不變）
- Prettier / ESLint auto-fix 的純 whitespace / 縮排重排

**「純文字」白名單（Docs）：**
- `.md` 檔案整份
- 註解行（`//`、`/* */`、`<!-- -->`、`#`）
- XML doc 的 `/// <summary>` / `/// <param>` / `/// <returns>` 文字內容

**判斷後：**
- 若豁免：在 Task #4 / Task #5 description 加上 `skipped: style-only` 或 `skipped: docs-only`
- 若不豁免：正常觸發 1.3b 與 1.3c

#### 1.2.4 Stage 檔案

對目標 Repository 執行：

```bash
.claude/skills/git-commit/flow.sh prepare <repo> <file1> <file2> ...
```

腳本內部依序做：
1. **Stage**：只 `git add` 你在參數列出的檔案，**不會 `git add .`**
2. **產出 staged diff** 到 `.claude/.git-commit-tmp/staged-<repo>.diff`，供 1.3b / 1.3c 兩個審查 subagent 讀取

**規範仍適用**：
- 只 stage 本次任務相關檔案（由 AI 依據 1.2.3 判斷清單，再把路徑傳給 `prepare`）
- 不 stage `local-overrides.yml` 清單內的檔案（已在 `analyze` 階段過濾，不會出現在建議清單中）
- 禁止使用 `git update-index --skip-worktree`（覆寫檔案必用 `local-overrides.yml`）

---

### 1.3 並行三軌

**本節 A / B / C 三軌必須在同一輪訊息中啟動（真並行）。**

#### 1.3a 顯示 Commit Message 預覽（A 軌）

**設計目標**：commit message 必須以**高對比、獨立區塊**呈現，讓使用者一眼能辨識。禁止把 message 塞在普通段落或 inline code 裡。

**輸出格式（必須遵守排版層次）：**

```markdown
---

## 📦 {Repository 名稱}（{分支名稱}）

**Staged 檔案：**
- `M` `src/path/file.vue` (+10/-5)
- `A` `src/path/new.cs` (+50/-0)

**⚠️ 掃描警示：**（若有）
- 敏感字：在 `<file>:<line>` 發現 `"password"`
- Debug 痕跡：在 `<file>:<line>` 發現 `console.log`
- 可疑 unstaged：`appsettings.Localhost.json`（建議加入 local-overrides.yml）

### 📝 建議 Commit Message

\```
╔══════════════════════════════════════════════════════════════════════╗
║  {Type}: {描述}                                                       ║
╚══════════════════════════════════════════════════════════════════════╝
\```

🚀 **兩軌 Review PASS 後將自動套用此 message 並執行 commit + push**
⏸️ 如要改 message、調整 staging、攔截此次 commit，請在 Review 完成前回覆（例如：「等等」、「改成 Fix: xxx」、「先別上」）

**🔍 Codex Review：**（三選一）
- 🟡 進行中（background task `<id>`）— 通過後將自動 commit
- ✅ **已豁免**（Style / 純樣式）— 理由：diff 僅涉及 `.css` / `<style>` 區塊 — **未回覆將自動 commit + push（豁免比照 PASS 默許）**
- ✅ **已豁免**（Docs / 純文字）— 理由：diff 僅涉及 `.md` 與註解 — **未回覆將自動 commit + push（豁免比照 PASS 默許）**

**🔍 code-reviewer：**（三選一）
- 🟡 進行中（subagent `code-reviewer` 執行中）— 通過後將自動 commit
- ✅ **已豁免**（Style / 純樣式）— 理由：同上 — **未回覆將自動 commit + push（豁免比照 PASS 默許）**
- ✅ **已豁免**（Docs / 純文字）— 理由：同上 — **未回覆將自動 commit + push（豁免比照 PASS 默許）**

---
```

**排版要點（AI 輸出時不可省略）：**

1. **Commit message 必須用 unicode double-line box 框住**（`╔══╗` / `║  message  ║` / `╚══╝`），整個 box 再包在 fenced code block 裡（避免換行渲染被折掉）。這種方式不依賴 markdown code background，在任何終端都會顯示明確框線。
   - 上下框線 `═` 約 70 個（視 message 長度調整，寧可過長不可過短）
   - 中間行：左 `║` + 兩空格 padding + message + 結尾 `║`
   - **右側 `║` 不強求與上下框線 pixel-perfect 對齊**（CJK 字元顯示寬度難以精準計算），目視大致在右側即可
2. Staged 檔案列表每檔一行，用 inline code 包路徑
3. 警示區塊若無內容則整段**不要**輸出（避免干擾）
4. Codex Review 與 code-reviewer 狀態**各自一行**，都用 emoji（🟡 / ✅）開頭
5. 豁免案例要**加粗標示「未回覆將自動 commit + push（豁免比照 PASS 默許）」**，讓使用者知道純樣式 / 純文字不回覆即自動進；要攔截請明確回覆

**告知語（輸出在預覽之後）：**

- **兩軌審查中**：若 Codex 與 code-reviewer 皆 PASS 且你沒回覆，將自動進 Step 2。要攔截請在兩軌完成前回覆。
- **任一軌已豁免（Style / Docs）**：比照 PASS 默許，你沒回覆即自動 commit + push。要攔截、改 message 或調整 staging 請回覆（例如：「等等」、「先別上」）。

#### 1.3b 送 Codex 審查 staged diff（B 軌，可豁免）

> ⚠️ **subagent_type 易錯點（歷史上踩過多次）**
>
> Agent tool 的 `subagent_type` 參數必須是：
>
> ```
> codex:codex-rescue    ← ✅ 正確（subagent 完整識別）
> ```
>
> **不是** 以下任何一個（常見錯誤）：
>
> ```
> codex:rescue          ← ❌ 這是 slash command 名稱（/codex:rescue）
> codex-rescue          ← ❌ 缺 namespace prefix
> codex                 ← ❌ 只是 namespace
> ```
>
> 兩者同時存在且名稱相似，容易混淆。送審時**必定**用 `codex:codex-rescue`，若回 `Agent type '...' not found` 就是踩這個坑。

**豁免檢查（必做）**：先對照 1.2.3 的決策樹。若命中豁免條件：
- 跳過本節所有步驟
- 將 Task #4 `status=completed`，description 註記 `skipped: style-only` 或 `skipped: docs-only`
- 1.3a 預覽改顯示「✅ 已豁免」
- 匯流時 B 軌視為 `PASS`

**若不豁免，執行以下：**

**Staged diff 來源**：已由 `flow.sh prepare` 產出到 `.claude/.git-commit-tmp/staged-<repo>.diff`，**不需再手動 `git diff --staged`**。

**送審方式**：使用 Agent tool，`subagent_type` 必須為 **`codex:codex-rescue`**（見上方警告），`run_in_background` 為 `true`，與 1.3a / 1.3c 的訊息**同一輪**觸發。

**Prompt 範本（兩級制，嚴格遵守回覆格式）**：

```
請審查 staged diff（在 <DIFF_PATH>，請先 `cat` 讀取）。

【任務背景】<一句話描述這次改動在做什麼、影響範圍>

【判準】
- BLOCK：會壞功能、資安洞、邏輯錯、敏感資訊外洩（含 .env / credentials / hardcoded JWT / 連線字串）、
         改名遺漏跨檔、不該 commit 的檔案。
- PASS：其餘一切。有疑問時寧可標 BLOCK，不要放行潛在 bug。

【重點檢查】
1. 明顯 bug / 邏輯錯誤
2. 邊界情況（rollback 不完整、exception 未處理、null / undefined）
3. 安全性（SQL injection、敏感資訊、hardcoded 憑證）
4. 不該被 commit 的檔案或 debug 痕跡
5. 重命名類：diff 可能只顯示片段，提醒是否有跨檔殘留

【回覆格式，嚴格遵守】

第 1 行：`VERDICT: PASS` 或 `VERDICT: BLOCK`

第 2 行起（列清單，**觀察到幾項就列幾項、不設上限**，每行格式 `- <file>:<line> <短描述>`）：
- `VERDICT: BLOCK` → 列所有必修項
- `VERDICT: PASS` → **把所有觀察到的點全部列出**，包含但不限於：
  - edge case / 邊界情況（例：`Number('02') === 2` 型別轉換、null / undefined、race condition）
  - 跨檔殘留風險（例：改名後其他檔案是否還有硬引用）
  - 缺失的測試或文件（例：i18n 多語系漏補、unit test 沒跟上、XML doc 沒更新）
  - 潛在 future risk / 可選的改善建議（例：magic number 沒抽常數）

**主 agent 採兩級制**：BLOCK 才擋 commit；PASS 附清單代表「可以 commit 但有建議值得看」，
使用者會當場決定是否先修。因此 **PASS 時附清單是鼓勵行為，不要自我審查、不要以行數為由省略**。
確實沒有任何觀察時，才只回第 1 行 VERDICT。

每行一個觀察點，描述用一句話講清楚即可，**不寫「應該怎麼改」**（主 agent 會把清單丟給使用者，修法由使用者決定）。
不要分析段、不要 Markdown 標題、不要總結。
```

若多個 Repository，合併一次送審或拆分皆可，但必須**全部非 BLOCK** 才能進 Step 2。

#### 1.3c 送 code-reviewer 審查 staged diff（C 軌，可豁免）

**豁免檢查（必做）**：先對照 1.2.3 的決策樹（與 1.3b 共用同一組豁免規則）。若命中豁免條件：
- 跳過本節所有步驟
- 將 Task #5 `status=completed`，description 註記 `skipped: style-only` 或 `skipped: docs-only`
- 1.3a 預覽改顯示「✅ 已豁免」
- 匯流時 C 軌視為 `PASS`

**若不豁免，執行以下：**

**Staged diff 來源**：已由 `flow.sh prepare` 產出到 `.claude/.git-commit-tmp/staged-<repo>.diff`，**不需再手動 `git diff --staged`**。

**送審方式**：使用 Agent tool，`subagent_type` 為 `code-reviewer`，`run_in_background` 為 `true`，與 1.3a / 1.3b 的訊息**同一輪**觸發。

**審查重點（對齊 code-reviewer agent 的職責）**：
- DDD / CQRS 架構原則（Controller / Handler / Domain / Infrastructure 分層）
- Repository pattern 是否正確操作 Aggregate Root
- Vue 的 Section component 模式、Pinia store 結構、i18n 規範
- `.github/instructions/` 規則集（前端：`frontend-vue/`；後端：`WEHQ.SupplierManager.Service/.github/instructions/`）
- 資安（敏感資訊、SQL injection、Authentication 邏輯）

**Prompt 範本（兩級制，嚴格對齊 Codex 格式，以利匯流合併判讀）**：

```
請審查 staged diff（在 <DIFF_PATH>，請先 `cat` 讀取）。

【任務背景】<一句話描述這次改動在做什麼、影響範圍>

【審查對象】
- Repository: <repo>
- 檔案類型：<.vue / .cs / .ts / ...>
- 適用規則：見 code-review Skill 與對應 `.github/instructions/`

【判準（對齊 git-commit 流程的兩級制）】
- BLOCK：存在 🔴 Critical 問題（違反架構原則、資安洞、破壞 DDD 分層、必錯的邏輯）
- PASS：無 Critical 問題即可放行。🟡 Important / 🟢 Minor 不擋 commit，但須列在 PASS 清單供使用者決定是否先修。

【重點檢查】
1. 架構規範（DDD 分層、CQRS、Repository Pattern、Vue Section component）
2. 規則違反（對應 `.github/instructions/` 的具體規則）
3. 資安（敏感資訊、SQL injection、Auth 邏輯、權限檢查）
4. i18n / 多語系完整性、命名一致性
5. 測試覆蓋（是否遺漏對應 unit test）

【回覆格式，嚴格遵守】

第 1 行：`VERDICT: PASS` 或 `VERDICT: BLOCK`

第 2 行起（列清單，每行格式 `- <file>:<line> [<嚴重度>] <短描述>`，嚴重度為 Critical / Important / Minor）：
- `VERDICT: BLOCK` → 列所有 Critical 必修項（可附 Important / Minor 供參考）
- `VERDICT: PASS` → 列出所有觀察到的 Important / Minor 建議

每行一個觀察點，描述用一句話講清楚即可，**不寫「應該怎麼改」**（主 agent 會把清單丟給使用者，修法由使用者決定）。
不要分析段、不要 Markdown 標題、不要總結。
```

若多個 Repository，合併一次送審或拆分皆可，但必須**全部非 BLOCK** 才能進 Step 2。

---

### 1.4 匯流決策

**採「三軌審查默許機制」**：B + C 兩軌（Codex + code-reviewer）**皆完成**即可推進，A 軌（使用者）無回覆時依下表處理。

#### 決策矩陣（含默許）

| B 軌 (Codex) | C 軌 (code-reviewer) | A 軌（使用者） | 動作 |
|---|---|---|---|
| PASS | PASS | **尚未回覆** | → **Step 2 自動 commit + push**（默許），輸出時註明「採默許模式」 |
| PASS | PASS | 明確確認 ✅ | → Step 2 直接 commit + push |
| PASS + 清單 | PASS + 清單 | 看完清單仍確認 ✅ | → Step 2 |
| PASS | PASS | 決定先修建議 🖊 | 修程式碼 → 重新 `flow.sh prepare` → reset 1.2.4 / 1.3a / 1.3b / 1.3c / 1.4 → 兩軌重送 |
| PASS | PASS | 要改 message 🖊 | 套用新 message → Step 2 |
| PASS | PASS | 要調整 staging 🖊 | 重新 `flow.sh prepare` → **重新判斷豁免**（diff 變了）→ reset 1.2.4 / 1.3a / 1.3b / 1.3c / 1.4 → 兩軌重送 |
| PASS | PASS | 要攔截 🖊（「等等」、「先別上」） | 停在此，等待進一步指示 |
| **豁免** | PASS | **尚未回覆** | → **Step 2 自動 commit + push**（豁免比照 PASS 默許） |
| PASS | **豁免** | **尚未回覆** | → **Step 2 自動 commit + push**（豁免比照 PASS 默許） |
| **豁免** | **豁免** | **尚未回覆** | → **Step 2 自動 commit + push**（豁免比照 PASS 默許） |
| 豁免 / PASS | 豁免 / PASS | 明確確認 ✅ | → Step 2 |
| 豁免 / PASS | 豁免 / PASS | 明確否決 🖊（「等等」、「先別上」、改 message / staging） | 照使用者意思處理，不自動 commit |
| **BLOCK** | — | **任何**（含尚未回覆） | **絕不自動 commit** → 列出 B 軌必修項 → 等使用者決定方向 |
| — | **BLOCK** | **任何** | **絕不自動 commit** → 列出 C 軌必修項 → 等使用者決定方向 |
| BLOCK | BLOCK | 任何 | **絕不自動 commit** → 列出兩軌必修項合併 |
| 尚未完成 | 任何 | 明確確認 ✅ | 告知「兩軌審查中，完成後將自動 commit」 |
| 任何 | 尚未完成 | 明確確認 ✅ | 同上 |
| 任一尚未完成 | — | 要攔截 🖊 | 立即中止，取消背景審查 task（若可），停在此 |
| 任一尚未完成 | — | 尚未回覆 | 正常等待，不催促 |

> **關鍵規則：**
> - **「兩軌 PASS + 使用者未回覆 → 自動 commit」** 是預設行為，在 1.3a 預覽時必須明確告知使用者
> - **任一軌豁免（Style / Docs）比照 PASS 默許**：使用者未回覆即自動 commit + push。豁免靠「反豁免觸發」（diff 含邏輯行就強制不豁免，見 1.2.3）把關，故純樣式 / 純文字自動進可接受；要攔截請明確回覆
> - **任一軌 BLOCK 永遠不默許**，即使使用者已先回「OK」也不行（需使用者看過 BLOCK 清單後另行指示）
> - 兩軌的 **PASS + 清單** 代表「可以 commit 但有建議值得看」，預設視為通過；若使用者在 commit 前要求先修則走修正流程

#### 自動 commit（默許）時的輸出格式

進 Step 2 前必須顯示：

```markdown
🤖 **採三軌審查默許機制自動 commit**
- Codex Review: ✅ PASS（{有/無}建議清單）
- code-reviewer: ✅ PASS（{有/無}建議清單）
- 使用者回覆：尚未（視為默許）
- 套用 message：`{Type}: {描述}`
```

若任一軌 PASS 附清單，**清單必須先列給使用者看**，再告知「已開始自動 commit + push，若要 revert 請明確指示」。

#### BLOCK 處理

```
1. 列出該軌（或兩軌合併）的每個必修項（取自 VERDICT: BLOCK 下方的清單）
2. 等使用者決定是否修正（或忽略並強制 commit，需明確指示）
3. 若要修正：
   a. 直接在 working tree 修改程式碼（檔案還在原地，無需 revert / reset）
   b. 重新執行 `flow.sh prepare <repo> <files...>`（re-stage + 重出 diff）
   c. **reset task #3 / #4 / #5 / #6 回 pending**，不新增 task
      （#2 的 1.2.4 Stage 段落會隨著重跑 prepare 等同於重做，不需要額外 reset task #2）
   d. 回到 1.3 同一輪內重送 Codex + code-reviewer
4. 直到兩軌皆 `VERDICT: PASS`（或豁免）+ 使用者確認 message 才進 Step 2
```

**無 revert / 無 reset / 無 git 歷史噪音。**

---

## Step 2：Commit + Push

對每個 Repository 執行：

```bash
.claude/skills/git-commit/flow.sh ship <repo> <type> "<description>"
```

腳本內部依序做：
1. **Commit**（2.1）：HEREDOC 格式 `git commit`，**不接受 AI 署名**，腳本內已過濾
2. **Push**（2.2）：`git push`，禁止 force push
3. **驗證結果**（2.3）：自動輸出 `git status` 與 `git log --oneline -1`

**規範仍適用**：
- ⚠️ 禁止在 `<description>` 參數中加入任何 AI 署名（如 `Co-Authored-By: Claude`）。公司內部禁止揭露 AI 參與程式碼撰寫。
- 禁止使用 `--amend`、`--no-verify`、force push（腳本不提供這些旗標）
- push 到 `main` / `master` 前必須特別確認使用者意圖

**pre-commit hook 失敗時，先分辨兩種情況：**

**(a) hook 正常執行、但檢查不通過**（如 eslint/prettier 報錯、測試失敗）：
- 腳本會中止並回報 hook 輸出。
- 依提示修正 → 回到 **1.2.4**（重跑 `flow.sh prepare`）→ 兩軌重審 → 匯流 → 再次 `flow.sh ship`。

**(b) hook 本身故障、根本無法執行**（如 `Exec format error`、`segfault 139`、`.husky/pre-commit` 是 CRLF 行尾或缺 `#!/bin/sh` shebang、Git Bash 無法 spawn）：
- 這**不是程式碼問題**，去「修程式碼再重跑」會卡死——程式碼沒錯，修了也過不了壞掉的 hook。
- 合法處置（依序）：
  1. **手動補跑對應 linter/formatter**（如 `prettier --write`、`eslint`、`npm test`）自己確認檢查項目實際乾淨——把壞 hook 本該做的事手動做一遍，不是跳過品質把關。
  2. **明確告知使用者**這是「hook 環境故障」而非程式碼問題，並說明你已手動補跑哪些檢查、結果為何。
  3. **經使用者同意後**，才可破例用 `git commit --no-verify` 繞過（這是本 skill 唯一允許 `--no-verify` 的情境）；commit message 下方加 `[skip-verify: hook 環境故障，已手動補跑 <檢查項>]` 標記。
  4. **建議根治**：修 `.husky/pre-commit`（補 `#!/bin/sh` + 轉 LF）或設 `core.autocrlf=input`。提醒使用者：不根治的話每次 commit 都會炸、長期靠 `--no-verify` 會讓 hook 把關形同虛設。
- ⚠️ 注意：`flow.sh ship` 不提供 `--no-verify` 旗標，此破例需手動 `git commit --no-verify`（脫離 flow.sh），故 (b) 的每一步都必須留痕（手動補跑紀錄 + 告知 + 標記），不可無聲繞過。

---

## 注意事項

- 不可使用 `--no-verify` 跳過 hooks（**唯一例外**：上面「pre-commit hook 失敗時 (b) hook 本身故障」的情境，須經使用者同意 + 手動補跑檢查 + 留 `[skip-verify]` 標記）
- 不可使用 `--amend` 修改前一個 commit（除非使用者明確要求）
- 不可 force push
- 若沒有任何變更需要 commit，告知使用者並結束
- **兩軌審查永遠在 commit 之前**（不會有 commit 後才發現問題導致需要 revert 的情境）
- **若兩軌在 Step 2 之前被使用者要求跳過**（例如緊急 hotfix），必須在 commit message 下方加上 `[skip-review: <原因>]` 標記並告知使用者此為破例
- **默許機制摘要**：
  - 兩軌 `PASS` + 使用者未回覆 → 自動進 Step 2（預設行為）
  - 任一軌 `BLOCK` → 永不自動 commit
  - 任一軌豁免（Style / Docs）+ 使用者未回覆 → 比照 PASS 默許，自動進 Step 2（自動 commit + push）
  - 使用者在任何階段可回覆「等等」/「先別上」/「改成 Xxx」中止或調整
- **1.3a 預覽排版要求**：commit message **必須用 unicode double-line box 框住**（`╔══╗` / `║  message  ║` / `╚══╝`），整個 box 再包在 fenced code block 裡，確保在任何終端都顯示明確框線
