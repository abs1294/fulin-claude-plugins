---
name: plugin-manager-adopt
description: 把當前專案資料夾裡的一個自製 skill「納管」進 fulin 的 plugin monorepo（move+symlink 模型，真身只有一份）。當使用者說 /plugin-manager:adopt、「把這個 skill 納管」、「收進 monorepo」、「adopt 這個 skill」時觸發。把 skill 真身搬進 monorepo、原位改 symlink、更新 marketplace 與 registry。
---

# plugin-manager:adopt — 納管自製 skill

把使用者在「當前專案資料夾」隨手寫的自製 skill，集中收進 monorepo，從此真身住 monorepo、原專案靠 symlink 引用同一份（不會有兩份不同步）。

## 何時用
- 使用者在某專案 `.claude/skills/<name>/` 寫了自製 skill，想把它納入集中管理。
- 「靠登記」原則：**只納管使用者明確指定的 skill**，絕不自動掃整個專案、不碰別人的東西或專案機密。

## 執行步驟

1. **確認要納管哪個 skill**：使用者要指明 skill 名稱（對應 `<專案>/.claude/skills/<name>/`）。若沒指明，列出當前專案 `.claude/skills/` 底下的目錄讓使用者選。

2. **確認 plugin 名**：預設與 skill 同名。若 monorepo 已有同名 plugin，請使用者改名。

3. **跑 adopt 腳本**（純檔案/symlink 操作，不需 claude CLI）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/adopt.js" <skillName> <pluginName> [projectDir]
   ```
   - `${CLAUDE_PLUGIN_ROOT}` 是本 plugin 安裝目錄（Claude Code 會展開）。
   - projectDir 省略時用當前工作目錄。
   - 腳本會：move 真身 → 建 plugin.json → 更新 marketplace.json → 原位建 symlink → 更新 registry。

4. **檢視腳本輸出**：
   - 若腳本提示「此專案是 git repo，建議加 .gitignore」→ 詢問使用者是否要把 `.claude/skills/<name>` 加進該專案 `.gitignore`（避免 symlink 污染專案版控，這是使用者在意的「git 很亂」根源之一）。若使用者同意，幫他加。
   - 若 symlink 建立失敗（Windows 權限）→ 回報，真身已在 monorepo，但原位置未連結，需手動處理。

5. **提示下一步**：納管後真身在 monorepo 但**尚未推上 git**。提示使用者用 `/plugin-manager:publish` 發布。

## 真身單一份原則（C 折衷模式 — 務必遵守）

本系統統一採「**真身只有 monorepo 一份，原位留 symlink**」的折衷模式：

1. **adopt 一律 move 真身進 monorepo + 原位留 symlink/junction**，絕不在專案留第二份實體。若發現某 skill 在 monorepo 與專案（或 `~/.claude/skills/`）各有一份**獨立實體**（非 symlink），那是歷史遺留的「兩份不同步」狀態，應收斂：先 diff 兩份內容 → 確認後刪實體那份 → 原位改 symlink 指回 monorepo 真身。
2. **開發期靠 symlink 即時迭代**（改 symlink = 改 monorepo 真身，同一份檔，免發布即生效），**一個段落完成就 publish**。這是 C 折衷：快速迭代 + 落實版本追蹤。
3. 因為 symlink 改了本機立刻生效、容易忘記發布——所以**改完務必走 publish**（見 `/plugin-manager:publish` 的發布紀律）。

## 重要限制（誠實告知）
- 這只是把真身搬家 + 連結，**不會自動 install/enable 該 plugin**（install 是互動指令 /plugin，Claude 不能代執行）。
- Windows symlink 可能需權限；腳本會試 junction → dir symlink，皆失敗則回報。
- adopt 後該 skill 的 `dirty: true`（已改未推），publish 後才清。
