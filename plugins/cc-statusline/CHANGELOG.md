# Changelog

本檔記錄 cc-statusline 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [1.1.0] - 2026-08-07
### Changed
- 紅藍對抗（token 段）產出：tokens 列改真 session 用量——transcript usage 四欄增量累加（StringDecoder 串流、offset 快取、message.id 去重 keep-first、truncate 重掃、0-byte/目錄 fallback）、tok 退出 epoch 累計器改單調 max、payload 數值入口統一夾取、fmtTok 補 T 檔與進位；ctx% 不動（官方語意本就正確）。(all) 過渡期新舊混合、隨 session 讀取跳升至真值

## [1.0.2] - 2026-08-07
### Fixed
- 修 cost 累計天文數字（單 session 顯示一百萬美元）：併發 render 乒乓累加根治——累計帳改 epoch 峰值制（settled+peak，與 render 順序無關）＋深跌需持續 45s 的時戳防抖；累計檔 key 改完整 session id 並修新舊 key 雙算；新增 scripts/repair-cumulative.js（idempotent，修復被灌爆的歷史資料，含 --list-fixtures）；已知自癒取捨 B1/B2 註解在案

## [1.0.1] - 2026-08-01
### Fixed
- 修 agents/skills 欄同 session 莫名刷新：tracker prune 改名稱保底（done 每名稱至少留最新 1 筆、額度 20→40）不再擠掉整個 agent 名稱；tracker 寫入抽共用 lib-state.js 加跨程序檔案鎖，並發啟停掉資料歸零；running 超 4h 未收到 Stop 事件降級為 done 保留名稱

## [1.0.0] - 2026-07-31
### Changed
- 版面大改版：中間欄由對話歷史改為 agents 清單、skills 留最右欄且兩欄等寬（右側剩餘寬度對半分，餘數歸 agents）、crons 釘欄底；session summary 列橫跨全盒寬、右端顯示 session id、最多 1 列超長截斷；任何模式盒子撐滿終端寬；agents 超量末格 …+N 折疊；欄位常駐（無 agent 時不收合）；三欄模式需終端約 115 欄以上，不足整組收合單欄；修 100–114 欄混合態與 agents>5 無聲消失

## [0.4.0] - 2026-07-16
### Changed
- agents 列名字前加模型縮寫前綴 (f)/(o)/(s)/(h)：SubagentStart/Stop payload 無 model 欄位（實證＋官方文件確認），改由 statusline.js 渲染時 lazy 讀各 subagent transcript 前 256KB 抓 model id，快取到獨立 tmp 檔（不碰 tracker 狀態檔避免 CAS 競態）；前綴與名字共用原 20 字元預算，欄寬計算不變（0.4.0）

## [0.3.1] - 2026-07-09
### Fixed
- crons 區塊改條件顯示：有排程才佔 agents/skills 欄底兩 row，無排程不顯示不佔位（原 0.3.0 固定佔位＋— 佔位符移除）；README/rows skill 措辭同步

## [0.3.0] - 2026-07-09
### Changed
- 新增 crons 排程顯示：cron-tracker hook（PostToolUse CronCreate/CronDelete/ScheduleWakeup 寫 claude-crons 狀態檔）＋ statusline 第三欄（agents/skills）改 token 兩段式渲染、欄底固定兩 row 顯示排程（下一發時刻＋標籤，無排程顯示 —，一次性逾時自動剔除、循環顯示至刪除）；rows 開關加 crons key；README 資料源表同步 7 支 hooks

## [0.2.2] - 2026-07-09
### Fixed
- README 前置依賴段補全（git/claude CLI/PowerShell 各欄位降級行為）

## [0.2.1] - 2026-07-06
### Fixed
- 修右欄訊息歷史 off-by-one：summary 直接接分割區塊的版面下，totalSlots 把兼任 section 分隔與 split-open 的同一列分隔線計了兩次，導致最新一則訊息永遠不顯示（歷史僅 1 則時整欄空白）。只在 split 分隔線不兼任 section 分隔時才計 sectionDividers。

## [0.2.0] - 2026-07-05
### Changed
- 加入 6 支 tracker hooks（message/summary/file/skill/subagent/compact）並以 hooks/hooks.json 於安裝時自動註冊，補齊 status line 資料源；README 新增資料源與重複註冊警告、setup skill 加 hook 重複偵測步驟
