# Changelog

本檔記錄 red-blue-review 的版本變更，格式依 [Keep a Changelog](https://keepachangelog.com/)。

## [0.4.4] - 2026-07-04
### Changed
- **對話內模式的保證等級誠實化**：先前用「externalize 到 harness、繞不過、由資料判定、比照 git-commit BLOCK」等措辭，暗示對話內收斂追蹤有硬保證；但對話內模式的 TaskList 開關與 `is_real`/`corrected_severity` 全由同一模型自填自判，無外部攔截點——實為「自律強化版」。現明確標註：真機械閘只在 Workflow 路徑（loop-runner.md 的 JS filter）；對話內是自我檢查，高風險命題應優先走 Workflow。並提醒模型對「自己把 finding 降級湊 0 新」保持警覺。

### Fixed
- **去重閘3 誤殺不再靜默**：某 root_concern 首輪被判假/LOW、次輪其實為真且 ≥MEDIUM 時會被去重吞掉。現強制留痕——這類被吞的疑似真弱點必須記進報告「⚠️ 去重吞掉的疑似真弱點」清單（不計入迴圈但使用者看得到），第五步產出必帶此清單（無則明寫「無」）。
### Added
- loop-runner.md prompt cache 優化（零對抗損失省 token）：紅/藍 prompt 改為「穩定前綴（角色+固定指示+GROUND_TRUTH）在前、變動內容（round/seen/finding）在後」，讓同類 agent 跨輪/跨 target 共用 GROUND_TRUTH 前綴有機會走 cache-read（約 0.1×）
- 補完整「prompt cache 優化」說明段：含最小快取門檻（依模型而定、以官方文件為準）、TTL（5min/1h）、並行 stagger timing、4 道誠實邊界（agent() 不暴露 cache_control/usage、可快取前綴真正起點在 tools+system 腳本控制不到、紅藍各自一條 cache 線、跨執行 args.groundTruth 也須逐 byte 同）
### Note
- 經三輪紅藍對抗自驗收斂（dogfood）：修掉「前綴起點誤判」與「schema 誤掛 tools 段」兩個 MEDIUM；最小快取門檻的確切數字因來源分歧改寫為「依官方文件而定」以免寫死過時值

## [0.4.2] - 2026-06-29
### Added
- 強制收斂追蹤（MANDATORY）：對話內跑對抗前須 TaskCreate 建追蹤清單，收斂判定 task 只有「最近 dry_rounds 輪皆 0 新 ≥MEDIUM 真弱點」才准標 completed，未收斂禁止輸出 GO/產出，結束強制清空——把迴圈狀態 externalize 到 harness，比照 git-commit 機制，不靠模型自律
- convergence.md 加「機械閘」三道（is_real:false 丟棄、<MEDIUM 不計入新弱點、去重對所有提過的比）+ 計數公式，讓「要不要再跑一輪」由資料判定，紅方湊 LOW/假 finding 無法卡住收斂
- 新增 references/loop-runner.md：含外層 while(dry<dry_rounds) 的完整可跨 Workflow 腳本，收斂由 seen Set 去重計數驅動（補 workflow-pattern.md 只有單輪 pipeline 的缺口）
### Changed
- 嚴重度表 LOW 改為「為真但拿掉它命題的可行性/正確性/安全性不變」+ LOW/MEDIUM 對照表錨死邊界，消除機械閘的判斷詮釋空間
- SKILL 實作模式段補 cross-ref 指向 loop-runner.md（單輪內核 vs 外層驅動器）
### Fixed
- workflow-pattern.md 的 FINDING schema 補 root_concern 去重鍵（原缺，主 Agent 若把單輪 schema 餵進 loop-runner 外層迴圈會讓去重恆失效、第一輪假收斂）；SKILL cross-ref 加 root_concern 接駁警示，兩檔 schema 改為即插即用
- loop-runner.md / convergence.md 誠實揭露去重閘3 的取捨：把假陽性也記入 seen 防換皮重刷，代價是「同 root_concern 首輪假/LOW、次輪真 ≥MEDIUM」會被誤殺靜默漏掉；補緩解指引（root_concern 命名要具體）與高風險命題的改法

## [0.4.1] - 2026-06-28
### Changed
- README 補痛點/價值 hook

## [0.4.0] - 2026-06-28
### Added
- 補對抗盲點三防線（實戰教訓）：① ground truth 假前提無法靠對抗發現（紅藍同拿一份假事實會精緻論證錯誤結論）→ 動對抗前須獨立實讀來源驗證；② 收斂後、產出前加「常識/第一性原理終檢」（刻意不靠對抗，補集體盲點）；③ 誠實標示對話內單實例自我紅藍藍方獨立性有限

## [0.3.1] - 2026-06-27
### Fixed
- 加修正門檻防紅方鑽牛角尖：只有藍方確認為真且嚴重度 >= MEDIUM 才修，LOW 一律只記錄不修
- 迴圈的「新真弱點」只算 >= MEDIUM；某輪只冒 LOW 視同 0 新即收斂，斷掉「為了續圈而硬找 LOW」的誘因
- 第五步產出加 LOW 級清單（為真但不修、供使用者參考）

## [0.3.0] - 2026-06-27
### Changed
- 預設模式改為實作模式：紅攻→藍守→修 持續迴圈，直到某輪紅方 0 個新真弱點才停；全自動，僅高風險改（刪檔/跨 repo/改設定/不可逆）才停下問
- 分析模式：首輪攻守後停給確認清單，確認後修並一樣續迴圈到攻不破；但後續修正鎖定第一輪確認範圍（檔案集+顧慮集），超出先提醒使用者
- 收斂機制由「四準則並列」改為核心「迴圈到攻不破（唯一輪 0 新即停）」+ 可調參數（round_cap 預設 5、dry_rounds、all_addressed）
- 同步 description、convergence.md；自驗補：高風險拿不準傾向停問、分析模式範圍定義

## [0.2.0] - 2026-06-26
### Changed
- 紅藍對抗自驗(dogfood)後強化:補 security/二階後果/可證偽性攻擊面向、收斂加面向覆蓋閘防確認劇場、藍方驗證與證據標準按分析/實作模式分流、觸發詞補中文同義詞、loop-until-dry 升正式準則、誠實標示單實例藍方獨立性有限
