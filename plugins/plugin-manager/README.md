# plugin-manager 🧩

**自製的 skill 散在各專案、改一個要手動 git、換機器全部重來？把它們集中到一個 monorepo 管理，一鍵發布、按專案挑裝、換機器一次復現。**

把你所有自製 Claude Code plugin 集中在一個 monorepo 管理，並能精選、挑裝別人做的 plugin。

> private repo: `abs1294/fulin-claude-plugins` ｜ marketplace: `fulin-plugins`

## 1. 這能幫我做什麼

| 你的麻煩 | 用哪個指令 |
|---|---|
| 自製 skill 散在各專案資料夾，想集中管理 | `/plugin-manager:adopt` 收編進來 |
| 改完 skill 要手動 git 推上去很煩 | `/plugin-manager:publish` 一鍵推 |
| 改了 skill 想發新版本給別的專案用 | `/plugin-manager:update` 升版號 |
| 每個專案要用的 plugin 不一樣，不想全開 | `/setup-plugins` 按專案挑 |
| 看到別人做的好 plugin，想推薦、之後挑裝 | 跟 Claude 說「推薦外部 plugin」+ `/setup-plugins` |
| 換新機器，想重現整套環境 | `/plugin-manager:clone-env`（說「復現環境」） |

不需要懂背後運作就能用；想懂看最後「進階」。

## 2. 安裝（一次性）

在 Claude Code 輸入框依序貼這三行（Claude 不能代你執行 `/plugin` 指令，要你自己貼）：

```
/plugin marketplace add abs1294/fulin-claude-plugins
/plugin install plugin-manager@fulin-plugins
/reload-plugins
```

### 首次初始化（只做一次）

第一次用前先建個人設定（告訴 plugin-manager 你的 monorepo 在哪）：

```
node "<你 clone 的 repo>/plugins/plugin-manager/scripts/init.js" <owner> <github-owner/repo>
```

例：`node ".../scripts/init.js" fulin abs1294/fulin-claude-plugins`。monorepo 路徑自動從腳本位置回推，不必手填。它會在 `~/.claude/plugin-manager/` 建好 `config.json` 與 `registry.json`（已存在不覆蓋）。

**為什麼要這步**：所有指令靠 `~/.claude/plugin-manager/config.json` 這個固定錨點找到你的 monorepo——所以你在任何專案、任何 session 說「adopt 某 skill」「推薦外部 plugin」，Claude 都查得到該寫去哪，不必每次給路徑。

### 前置依賴

- **Node.js** — 所有 scripts（init / adopt / bump-version / publish-status / publish-finalize / export-env / restore-env）都是 node 腳本，缺 node 整套管理指令不能動。
- **git CLI** — adopt 的 move+symlink 落版控、publish 的 stage/commit/push 都靠它。
- **本機 clone 的 monorepo** — 這是「管理端」plugin：更新/發布操作的對象是你 clone 下來的 monorepo 工作目錄（不是 plugin cache）。

## 3. 指令速查

| 指令 | 何時用 | 怎麼下 |
|---|---|---|
| `/plugin-manager:adopt` | 某專案寫好一個 skill，想收進集中管理 | `/plugin-manager:adopt <skill名>` |
| `/plugin-manager:update` | 改完某 plugin，要發新版本 | `/plugin-manager:update <plugin名> <patch｜minor｜major>` |
| `/plugin-manager:publish` | 改了東西要推上 GitHub | `/plugin-manager:publish` |
| `/setup-plugins` | 設定「這個專案」啟用哪些 plugin | `/setup-plugins` |
| `/setup-plugins upgrade` | 這專案的自製 plugin 想同步最新版 | `/setup-plugins upgrade` |
| `/plugin-manager:clone-env` | 整套環境複製到新機器/新專案 | 說「複製我的環境」「環境復現」 |
| （對話）「推薦外部 plugin …」 | 把別人的 plugin 記進推薦清單（會推廣） | 直接跟 Claude 說 |

## 4. 各指令詳解

### `:adopt` — 收編我自己寫的 skill / agent
你在專案 `.claude/skills/` 寫了 skill，想收進集中管理（之後能發布、能在別專案用）。
`/plugin-manager:adopt my-tool` → 該 skill 變成受管 plugin。**原專案那份照樣能用、改它就是改受管那份**（move+symlink，永遠一份真身，不會兩份打架）。只動你指定的那一個，不掃整個專案。
agent 也能收：說「把這專案的 agents 納管成 `<plugin名>`」→ 整個 agents 目錄收進 `plugins/<名>/agents/`（一組 agent = 一個 plugin）。

### `:update` — 改完發新版
| 等級 | 用於 | 例 |
|---|---|---|
| `patch` | 修字、修小 bug | 0.1.0 → 0.1.1 |
| `minor` | 加功能（相容） | 0.1.0 → 0.2.0 |
| `major` | 破壞性變更 | 0.1.0 → 1.0.0 |

升完版記得 `:publish` 推上去。

### `:publish` — 推上去
Claude 先給你看「改了什麼 + 建議 commit 訊息」確認，確認後一次 commit + push 整包。**不管改了 1 個還 50 個 plugin，只推一次。**

### `/setup-plugins` — 按專案挑要用哪些 plugin
不同專案需要的 plugin 不同（前端要 figma、後端要 .NET 工具）。輸入 `/setup-plugins`，Claude 用選單問你：
1. **要哪個 profile**？minimal / dotnet / frontend / supplier / full / 自訂（定義在 `~/.claude/plugin-profiles.json`，可自編）
2. **要不要從推薦清單挑外部 plugin 裝**？（清單多會按 tag 分組讓你勾）

選完 Claude 列出「要裝什麼 + 怎麼裝」，給你要自己貼的 `/plugin install` 指令——**setup 本身不寫 settings**，啟用宣告由 `/plugin install` 選 scope（Project / Local）時自己寫進對應 `.claude/settings.json`（只影響這專案，不污染別的）。

### 推薦外部 plugin（會推廣）
GitHub 看到別人的好 plugin，想精選收進推薦清單——之後 `/setup-plugins` 能挑著裝，**且別人裝你的 repo 也看得到你推薦了什麼**。
只記「來源 + 用途 + 標籤」，**不複製別人程式碼**（別人的 plugin 永遠住他們 repo、跟著他們更新，你只做精選書籤）。
推薦寫進 `plugins/plugin-manager/recommends.json`（進 git、會推廣）。**登記 ≠ 安裝**——真正裝要 `/setup-plugins` 勾選後自己貼指令。

### `:clone-env` — 整套環境複製到新機器
舊機器說「擷取我的環境快照」→ 存成 `env-snapshot.json`（進 git）。複製的是**清單**（marketplaces / 各 plugin 版本 scope / 各專案啟用哪些），**不複製程式碼與憑證**。
新機器：裝 plugin-manager + clone monorepo + init → 說「復現環境」→ Claude 產出安裝清單，逐行自己貼。

## 5. 常見問題

**Q：為什麼 Claude 不直接幫我裝 plugin？** `/plugin install`、`marketplace add`、`/reload-plugins` 都是 Claude Code 互動指令，只能你親自打。plugin-manager 只負責「把設定寫好 + 把要貼的指令給你」。

**Q：更新已裝的 plugin 是 `/plugin update` 嗎？** 沒有 `/plugin update`。正確做法：`/plugin marketplace update fulin-plugins` 刷新 → `/plugin uninstall <name>@fulin-plugins` 再 `install` 重裝（或在 `/plugin` 介面開 auto-update）。

**Q：adopt 後在原專案改 skill 要重新 adopt 嗎？** 不用。原專案那份和受管那份是同一份檔，改哪邊都一樣，改完直接 `:publish`。

**Q：改完 skill 但別的專案沒拿到更新？** publish 只推 GitHub、不自動更新已裝專案。要其他專案拿到新版，在那專案刷新 + 重裝，或開 auto-update。

## 6. 進階：背後怎麼運作

- **move+symlink**：adopt 把 skill 真身搬進 monorepo，原位用 symlink/junction 指回——永遠一份真身，原專案與受管處同步。
- **集中 registry**：`~/.claude/plugin-manager/registry.json` 追蹤所有自製 plugin 與版本（本機狀態、不進 git）。
- **per-project 隔離**：`/setup-plugins` 不直接寫 settings，只給指令；實際啟用由 `/plugin install` 選 Project / Local scope 時寫進該專案 `.claude/settings.json`，不動 user 全域。
- **推薦清單 vs 自製狀態**：推薦（recommends.json）進 git、會推廣；自製 plugin 本機狀態存家目錄、不進 git、別人看不到。
