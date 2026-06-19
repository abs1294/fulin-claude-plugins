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

5. **更新 monorepo README**（**規則 4**，詳 `../../CONVENTIONS.md`）：adopt 在 marketplace 新增了一個 plugin → 同步更新根 `README.md` 的 plugin 列表與「結構」樹，隨本次一起 publish。

6. **提示下一步**：納管後真身在 monorepo 但**尚未推上 git**。提示使用者用 `/plugin-manager:publish` 發布。

> **規則 1（真身單一份 / C 折衷）**：adopt 一律 move 真身 + 原位 symlink，真身只有 monorepo 一份；開發期靠 symlink 即時迭代、段落完成就 publish。若發現兩份獨立實體則收斂（diff → 刪實體 → 改 symlink）。完整規範見 `../../CONVENTIONS.md`。

## 重要限制（誠實告知）
- 這只是把真身搬家 + 連結，**不會自動 install/enable 該 plugin**（install 是互動指令 /plugin，Claude 不能代執行）。
- Windows symlink 可能需權限；腳本會試 junction → dir symlink，皆失敗則回報。
- adopt 後該 skill 的 `dirty: true`（已改未推），publish 後才清。
