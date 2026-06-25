---
name: plugin-manager-clone-env
description: 擷取整套 Claude Code plugin 環境快照、並在新機器/新專案復現（含自製與第三方 plugin）。當使用者說 /plugin-manager:clone-env、「複製我的環境」、「擷取環境快照」、「環境復現」、「搬到新機器」、「換新電腦把 plugin 裝回來」、「把我的 plugin 組合搬到別的專案」時觸發。Claude 跑 export-env/restore-env 腳本，產生使用者要自貼的安裝指令。
---

# plugin-manager:clone-env — 環境快照與復現

把整套 plugin 環境（有哪些 marketplace、哪些 plugin、版本、啟用狀態，含自製 + 第三方）擷取成快照，在新機器或新專案復現。**使用者用自然語言講即可，Claude 跑腳本**——不必使用者自己打 node 指令。

## 何時用
- 換新電腦，要把慣用的整套 plugin 裝回來。
- 想在另一個專案 / 同事機器重現你的 plugin 組合。
- 只是想把當前環境存一份快照備份。

## 執行步驟

### A. 擷取快照（在原環境）
使用者說「擷取環境快照 / 複製我的環境」時，Claude 跑：
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/export-env.js" [outputPath]
```
- 讀 Claude Code 官方記錄（`~/.claude/plugins/known_marketplaces.json` + `installed_plugins.json` + settings 的 enabledPlugins），產出 `env-snapshot.json`，**預設寫進 plugin 內**（`plugins/plugin-manager/env-snapshot.json`，隨 git）。
- 純讀 + 寫一份 JSON，不碰 /plugin。
- 把結果回報使用者，並**提示要 `/plugin-manager:publish`**——快照進 git 後，新機 `/plugin install plugin-manager` 才會把它帶進 cache、restore 才讀得到。

### B. 產生復現指令（在新環境）
使用者說「環境復現 / 搬到新機器 / 復現指令」時，Claude 跑：
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/restore-env.js" [snapshotPath] [--enabled-only]
```
- **新機器全複製**：不加 `--enabled-only`，列出全部。
- **同機換專案**：加 `--enabled-only`，只列啟用中的（再配合 `/setup-plugins` 寫進該專案）。
- 腳本會印出一串「marketplace add + install + reload」指令鏈。

### C. 把復現指令交給使用者貼
腳本印出的 `/plugin marketplace add`、`/plugin install`、`/reload-plugins`——**這些 Claude 不能代執行**（Claude Code 互動指令限制），必須使用者親自貼。Claude 的責任到「把指令列清楚」為止。

### 新機器完整「貼上」流程（已假設新機先裝了 plugin-manager）
1. 新機 `/plugin marketplace add <你的 repo>` + `/plugin install plugin-manager@<marketplace>`（這步把含快照的 plugin 帶進 cache）。
2. 跑 `init.js` 初始化 config（指向新機 clone 的 monorepo；自製 plugin 復現需 monorepo 在本地，故新機仍需 `git clone` monorepo 一次）。
3. 跟 Claude 說「**復現環境**」→ 本 skill 跑 restore-env，**從 `${CLAUDE_PLUGIN_ROOT}/env-snapshot.json`（cache 內的快照）讀** → 列出其餘 plugin 的安裝指令。
4. 使用者逐行貼那串 `/plugin marketplace add` + `install` → `/reload-plugins`。完成。

### 快照從哪讀（restore 找快照順序）
參數 > `${CLAUDE_PLUGIN_ROOT}/env-snapshot.json`（新機從 cache 讀的關鍵）> monorepo 內 plugin 目錄（開發機）> cwd。

## 重要限制（誠實告知）
- **擷取/產生指令這兩步 Claude 幫你跑**（node 腳本，純檔案操作）；但**實際安裝那幾步（/plugin 系列）只能使用者自己貼**——這是 Claude Code 平台限制，非設計選擇。
- **第三方 plugin 能不能裝起來，看其上游 marketplace** 是否可及、使用者有無權限（有些要登入/授權）。自製 plugin（在使用者自己 repo）一定裝得起來。
- env-snapshot.json 含「你啟用了哪些 plugin」——預設寫 plugin 內（`plugins/plugin-manager/`，隨 git/publish，repo private 故只自己看得到）。不想入 git 可用 outputPath 參數指定 monorepo 外路徑。
- 首次在新機器初始化（`init.js`）那步是 bootstrap，plugin-manager 還沒裝起來時 Claude 跑不了，需使用者自己打一次（之後就都能自然語言）。
