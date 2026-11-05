# travel-advisor

旅遊行程顧問與現場導遊 plugin。**不常用，需要時才裝到專案**（不放 user 層）。

```
claude plugin install travel-advisor@fulin-plugins --scope project
```

| 內容 | 在哪 |
|---|---|
| skill 本體（四道閘門、分階段細則、踩過的坑、腳本） | `skills/travel-advisor/`，說明見該目錄 `README.md` |
| 批量查核 agent（排整天行程、逐家查核 10 家以上） | `agents/travel-advisor.md`，叫用名 `travel-advisor:travel-advisor` |
| 旅伴設定檔（孕婦／長輩參數） | `skills/travel-advisor/config/user-profile.md` —— **個人資料，已 .gitignore，不進 git** |
| 行程狀態檔 | `skills/travel-advisor/state/*.md` —— **同上，不進 git** |

## 第一次裝完要驗的兩件事（HYPOTHESIS，搬進 plugin 後未實測）

```
① agent 的 skills: 預載用的是命名空間名 travel-advisor:travel-advisor —— 裸名在 plugin 內可能找不到
   驗法：派一次 travel-advisor:travel-advisor，看它回報有沒有讀到 SKILL.md 的四道閘門
② 從 marketplace 安裝時，.gitignore 掉的 config/user-profile.md 與 state/ 會不會一起複製過去
   驗法：裝到一個專案後 ls <安裝路徑>/skills/travel-advisor/config/
   不會 → 第一次用時 init-state.py 會要求補設定檔，照 config/profile-schema.md 填
```

## 怎麼用

四個時間點各一件事，其餘是 skill 的事。詳見 `skills/travel-advisor/README.md` 與 `SKILL.md`。

```
行前     講目的地、日期、誰去
前一天   Google Maps 開「即時位置分享」（直到關閉）、貼連結、試連 Remote Control
當地     講人話
回來     講「這趟哪裡出錯」→ 寫進踩過的坑
```
