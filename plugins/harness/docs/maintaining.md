# 維護本 plugin（引擎側）

給改 harness plugin 本身的人讀；執行 `/harness:init` 時用不到。init 時要用的改編判斷（帶／不帶判準、讓位規則、外向邊界、污染詞表的用法）在 `skills/init/references/adaptation-guide.md`。下文路徑都相對於 plugin 根目錄（`plugins/harness/`）。

## 1. 詞表維護觸發

**時機**：動到骨架檔（`skills/init/references/` 底下任何檔、`hooks/templates/`、詞表 `skills/init/pollution-wordlist.txt` 本身）要 commit 時。

**形狀**（仿知識沉澱閘）：plugin 自帶 PreToolUse hook `hooks/wordlist-sweep.js`——staged 含骨架檔時，要求 git-commit 的 args 帶 `詞表=<答案>` 表態，並把已知詞在 staged 內容中的命中列出來。答「無」零成本，漏答才擋；只驗有沒有表態，不判內容對錯。其他 repo、其他改動一律放行（所以一般專案裝了 harness plugin 不會被擋）。

**為什麼選「紀律＋hook」而不是只寫紀律＋健檢清單項**：

1. **觸發點與健檢週期錯位**：健檢 30 天跑一次，但骨架一旦發布，污染就已經進了別人的實例——等健檢抓到時已經擴散。
2. **會漏想新詞的正是改骨架的那個 session**：它剛從某個實例搬條款過來，腦中那些詞是「日常用語」而不是「專案特徵」，最不可能自發地想到要補表。自律在最需要的時候最不可靠。
3. **成本低**：只在 git-commit 且 staged 含骨架路徑時觸發，一般使用不會碰到；表態制不需要判斷語意，不會誤擋。
4. **機械部分與表態部分分工**：已知詞命中由 hook 直接列出（這部分機械可判）；新詞只能靠人判斷，所以用表態逼出「有沒有想過這題」並留在 transcript 讓使用者可否決。

沒裝 git-commit plugin 的維護環境，這支 hook 不會觸發——改用純紀律：發布前手動跑 `adaptation-guide.md` §4.1 的掃描指令，並回答同一題。

## 2. 發布前掃描

骨架改版發布前，對 `skills/init/references/`（含 `agents/`、`containers/`）與 `hooks/templates/` 全掃一次詞表，另掃日期戳：

```
grep -rnE '20[0-9]{2}-[0-9]{2}-[0-9]{2}' <上述目錄>    # 條款區應為 0；事故一律只講機制不寫日期
grep -c '^| [ABC][0-9]' skills/init/references/skeleton-03-judgment-matrix.md   # 03 條款數（目前 43：A 9／B 25／C 9），不得因改版意外掉條
grep -rn --include='*.md' '^## Changelog' skills/init/references/              # 0 筆：骨架檔不放 changelog 節（規格見 skeleton-05 §4）
```

## 3. 骨架維護

- 骨架檔屬本 plugin，改動走 monorepo 慣例（bump 版本＋publish）。
- **回收條款的門檻**：某實例的升格條款要進骨架，必須「≥2 個專案獨立踩過同類坑」或「與專案無關的純行為紀律」或「參數化後形狀仍成立」（`adaptation-guide.md` §1.1 判斷測試）；單一專案的事故留在該實例，由該實例的 `/harness:review` 健檢管；`/harness:review` 只看單一實例，跨專案比對「是不是 ≥2 個專案都踩過」目前由維護者人工做。
- 回收時照 `adaptation-guide.md` §1.1 挖空專案事實、**事故只講機制不寫日期**（「靜態審查看不出跑起來才會出的錯」，不寫「某月那次」），並過本檔 §1 的詞表表態。
- 骨架改版**不回寫既有實例**——實例自治，要同步由各專案自己依其 05 紅區流程決定。plugin 更新覆蓋的只有骨架、範本與 `adaptation-guide.md`，永不觸碰任何專案的 `.claude/harness/`、`.claude/agents/`、`.claude/hooks/`。
- **骨架檔不放 changelog 節**：骨架本身的變更記在 plugin 的 `CHANGELOG.md`；實例的變更紀錄落點由 `skeleton-05` §4 規定（harness 目錄記 `.claude/harness/CHANGELOG.md`、agent 記 `.claude/agents/CHANGELOG.md`、根目錄檔記 `<主檔名>.changelog.md`、`tests/Project_Detail/` 記同目錄 `CHANGELOG.md`），init 時「建立」那一行由 `skeleton-harness-CHANGELOG.md`、`agents/skeleton-agents-CHANGELOG.md`、`skeleton-CLAUDE.changelog.md`、`containers/` 底下的紀錄骨架寫入。
- hook 範本複製到實例後同樣自治：plugin 更新不會自動同步，實例要同步就對照 `hooks/templates/` 手動合併。
- **回收紀錄（實例獨有、未回收的部分）**：`check-review-discipline.js` 的【範圍展開】內容品質層，範本已回收可參數化的三格判準（正向路徑錨點數、反向分支的種類清單與逐種交代、狀態序列步數，另加跨格重複；參數在填空區 `SCOPE_QUALITY`）。**未回收**：「受影響的共用元件格點名的檔／元件要真的存在於專案、寫『無』時對照工作區的共用元件目錄改動」——它要知道專案有哪幾個 repo、共用元件目錄在哪（實例寫死四個 repo 的 `src/components|composables|utils` 與 worktree 目錄）、哪些檔是本機覆寫要排除，還要對每個 repo 跑 `git diff`／`git grep`；這些都是專案目錄結構，參數化後形狀不成立（單 repo 專案連「其他 repo 的使用點」這個概念都沒有），不過 §3 回收門檻。範本該格只驗「有作答、寫無要附理由」。另一處未回收：實例反向分支判定裡依語料校準的十五條修正（引號遮罩、括號標註、表格列、例外句…），範本只做句首分支名＋否定詞＋理由字數的基本判法，誤擋率沒在第二個專案校準過；要拿就連實例的 `cases/dispatch-quality.test.js` 語料一起拿。**已回收**（拿近 9 天 198 張真實派工單餵「範本閘＋填實例參數」複本對照實例閘校準，範本多擋的 33 張降到個位數）：①退件與拒絕預設共用同一條 re（簽核系統只有一個 Rejected 狀態，寫了退件就不會再寫拒絕）；②不適用理由字數兩種量法取大（否定詞後保留分支名——「無刪除操作」的「刪除」既是分支同義詞也是理由）；③錨點認法補到實例的 36 種中文字尾（填空 `uiSuffixes`）、「按X／點選X」按鈕名、英文字列舉、英文前綴的畫面元素，另留 `glossaryFile` 填空讓詞彙表詞條名算 1 個錨點（預設空＝不讀，詞彙表形狀是專案事實）；④合稱詞補「X 等分支／情境／狀態」。**仍未回收**：狀態序列格「引用既有測試檔的序列案例（`test_x.py` 的序列案例重跑）且檔真的存在」那條例外——要查測試檔存不存在得知道測試目錄與各 repo 索引，198 張語料裡 0 張用到；共用元件格的存在性檢查理由同上段。
- **修正層級的同步要靠 cases，不靠讀 diff**：逐支 diff 看得到檔案不同，看不出哪些是範本補的漏洞、哪些是實例刻意分岔。做法是拿 `hooks/templates/cases/` 現行 cases 跑實例同名 hook（實例 probe-hooks 支援指定 cases 目錄時用 `--cases=<目錄>`，否則把 JSON 複製到暫存目錄）——FAIL 清單就是候選，逐筆判「拿」或「刻意分岔（寫理由）」；反向（實例長出的 hook／裁定回收進範本）照上面回收條款判。兩向結果實例記在自己的 harness 目錄（`sync-ledger.md` 之類），`/harness:review` 第 9 段除功能差距外也列這份 FAIL 清單。曾實測：一個實例自長 19 支 hook，範本多輪補的 hack 銷毀閘漏洞（9 條會真的蓋掉本機覆寫的指令）實例一條都沒拿到，健檢第 9 段完全看不出來。
