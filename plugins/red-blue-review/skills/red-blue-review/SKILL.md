---
name: red-blue-review
description: 中文紅藍對抗——對任何命題做對抗式壓力測試（挑戰假設、找邏輯弱點，非效能/負載壓測），找出弱點再強化。當使用者說「紅藍對抗」、「攻擊這個」、「找弱點」、「壓力測試」、「挑戰這個決策」、「這個決策/方案/設計會出什麼問題」、「幫我戳破」、「魔鬼代言人」、「對抗審查」、「盲點」、「挑毛病」、「站得住腳嗎」、「打臉這個提案」、「有什麼沒想到的風險」、「反方論點」、「red team」、「red-team」、「stress test」、「pressure test」、「poke holes」、「devil's advocate」時觸發。適用決策/架構/計畫/策略/投資/安全/程式碼/plugin 配置/文件等多面向。Red 攻、Blue 守、收斂，產出強化版命題 + go/no-go。（純漏洞掃描用 security-review、純程式碼規範審查用 code-reviewer；本 skill 是對抗式論證，非漏洞掃描器。）
---

# red-blue-review — 中文紅藍對抗

> 在現實攻擊你之前，先自己把弱點攻出來。

對任何命題（決策、架構、計畫、策略、程式碼、plugin/skill 配置、文件…）做**對抗式壓力測試**：紅方用「最強化」的攻擊找弱點，藍方防禦/強化，循環到收斂，產出一個經得起攻擊的強化版 + go/no-go 建議。

## 何時用 / 何時不用

**該用**：高風險決策、架構/策略定案前、計畫審查、發布前審核、安全姿態、投資評估、**plugin/skill/agent 配置稽核**、文件與實況一致性。

**不該用**（反模式）：低風險瑣事（直接做就好）、緊急救火（先滅火再復盤）、已定案無法回頭（對抗只會製造衝突）、想法還在成形期（過早攻擊）、走形式的「確認劇場」（沒有真心對抗就別做）。

**分工讓位**：本 skill 做的是對抗式壓力測試（找最強攻擊 → 強化），不取代一般 code-review（風格/規範）與 git-commit 內建審查。純依專案架構/資安規範逐條審查程式碼（DDD/CQRS、AI 痕跡、CS1591 等）→ 用 code-reviewer；純掃 PR 安全漏洞 → 用 security-review；要對抗式找弱點、戳破假設才用本 skill。code 面向若使用者意圖偏向逐項漏洞掃描而非思辨對抗，先反問一句確認再決定是否轉介。

## 第一步：確認對抗標的與面向

問使用者（或從上下文判斷）：

1. **標的**：要對抗什麼？（一段程式碼 / 一個架構決策 / 一份計畫 / 一個 plugin 配置…）
2. **面向 type**（決定攻擊角度，可多選）：

| type | 用在 | 預設攻擊面向 |
|------|------|------|
| `decision` | 決策審查 | 假設、替代方案、可逆性、後果、時機 |
| `architecture` | 架構強化 | 擴展性、安全、依賴、維運、邊界案例 |
| `plan` | 計畫審查 | 可行性、資源、時程、依賴、風險 |
| `strategy` | 策略驗證 | 競爭、市場、執行、依賴、時程 |
| `investment` | 投資評估 | 經濟、市場、執行、競爭、假設 |
| `security` | 安全姿態 | 攻擊面、漏洞、依賴、維運 |
| `code` | 程式碼審核 | 崩潰、注入/資安、邏輯錯誤、邊界、跨平台、錯誤處理 |
| `config` | plugin/skill/agent 配置稽核 | 觸發詞衝突、權限過寬、路徑逃逸、敏感外洩、與實況不符 |
| `docs` | 文件一致性 | 文件聲稱 vs 實際、殘留過時、版號/清單不符、斷鏈 |

> 上表為常見起點，非窮舉；流程/用人/產品/合規等其他命題，可挑最接近的 type 並自由借用通用面向（attack-catalog 的 ASSUMPTIONS/DEPENDENCIES/ORGANIZATIONAL/TEMPORAL/SECOND_ORDER/FALSIFIABILITY 對任何命題皆適用）。

3. **模式**（由**使用者意圖**決定，非面向）：
   - **分析模式**（預設、唯讀）：只要診斷報告 → 純找弱點 + 給強化建議，不改檔。
   - **實作模式**：要實際改檔/修問題，且面向限 `code`/`config`/`docs`。可接 Workflow spawn agent 找問題→驗證→修。見「實作模式」段。
   - **硬規則**：實作模式會 spawn agent 並修改檔案，啟動前必須先向使用者明確確認；意圖不明時一律走分析模式。決策問句：「你是要我只出強化建議報告，還是實際 spawn agent 把問題修掉？」decision/architecture/plan/strategy/investment 等面向即使使用者說「直接幫我改」，也只產出強化建議由使用者自行落地（這類面向沒有單一可驗證的實檔可改）。

4. **收斂準則**（未指定時依風險自動推定）：標準審查→`no_new_critical`（預設）、高風險決策→`all_addressed`、限時→`round_limit`、範圍未知/全面稽核→`loop-until-dry`。見 `references/convergence.md`。

## 第二步：Red 攻擊（steel-manning，要攻得最強）

依面向從**攻擊向量目錄**（`references/attack-catalog.md`）選類別，每個攻擊用**三遍強化**確保是最強版、不是稻草人：

- **遍 1**：基本攻擊「會失敗因為 X 當 Y 觸發」
- **遍 2**：強化——加具體細節、因果機制、證據/前例、影響範圍、機率（base rate）
- **遍 3**：最強版——真正的對手（競爭者/批評者/攻擊者）會不會覺得這攻擊強？不會就再強化

每個攻擊標**嚴重度**：

| 嚴重度 | 準則 |
|------|------|
| CRITICAL | 承重（命題成敗繫於此）且信心 < 50% |
| HIGH | 承重 或 信心 < 50% |
| MEDIUM | 影響效率，不影響可行性 |
| LOW | 錯了也可補救 |

> 由高至低依序套用，命中即定級（先測 CRITICAL，不符再測 HIGH…）；CRITICAL/HIGH 重疊區取較嚴重者。

**關鍵紀律（本專案實戰經驗）**：攻擊要有**證據**，假攻擊（false finding）扣分，寧可少報不要報假的。但「證據」依面向有兩套標準，別把 code 標準誤套到非技術命題：

- **實作面向（code/config/docs）**：攻擊要可重現/附 PoC，理論性的零分。
- **論證面向（decision/architecture/plan/strategy/investment）**：攻擊須附**外部錨點**（base rate / 前例 / 因果機制，見 attack-catalog 假設段與 COMPETITIVE 段範例），可以是對未來/市場/人性的推測，但禁止的是「無錨點的空泛質疑」而非「不可重現的推測」。

## 第三步：Blue 防禦（四類回應，要守得實在）

每個攻擊用決策樹分類回應，**不可打哈哈、不可否認式防禦**：

```
攻擊事實錯了？ → REFUTE（用證據駁斥）
攻擊有效？
  能改命題消除它？ → HARDEN（強化命題）
  能降低風險？     → MITIGATE（緩解：應變/監控/風險轉移/分階段/kill switch）
  都不行？         → ACCEPT（誠實記錄殘餘風險，不假裝沒事）
```

**獨立驗證防假陽性**：藍方對每個紅方 finding 都要**獨立驗證真偽**，不直接相信紅方——這是過濾 false finding 的關鍵。依模式採對應手段：

- **實作模式（code/config/docs）**：獨立**讀實際檔案/重現**比對 ground truth。
- **分析模式（decision/architecture/plan/strategy/investment）**：獨立**事實核查/反論證**——檢查紅方攻擊本身的事實前提是否成立、base rate / 引用數據是否正確、是否為稻草人或過度外推；用此判定真偽，而非「有沒有檔案可讀」。

此驗證在實作模式（spawn 獨立 agent）下最有效；對話內單實例自我紅藍時是較弱的近似（見「重要限制」）。

## 第四步：收斂

依第一步選定的**收斂準則**判斷何時停（完整清單含 `loop-until-dry`，見 `references/convergence.md`）：

- `no_new_critical`（預設）：**覆蓋閘通過**且這輪 0 個**新** CRITICAL/HIGH 就停
- `all_addressed`（高風險）：每個 CRITICAL/HIGH 已 REFUTE/HARDEN/MITIGATE，或 ACCEPT 且明列殘餘風險
- `round_limit`：到上限輪數停（預設 3，可 1-5）
- `loop-until-dry`（範圍未知/全面稽核）：連續 K 輪（預設 2）0 新發現才停，仍受 round_limit 硬上限

**面向覆蓋閘**：收斂前須先確認該 type 全部「預設攻擊面向」每項都至少認真攻過一輪——未涵蓋不得收斂，否則退化成只攻淺面向就 GO 的「確認劇場」。

**去重**：對「**所有已提出過的攻擊（含已被藍方剔除的假陽性）**」比，只看底層顧慮（root concern），與嚴重度/措辭無關；變體不算「新攻擊」。否則被剔除的假陽性會每輪重現、永不收斂。

## 第五步：產出

```
== 紅藍對抗結果 ==
標的：<...>  面向：<type>  輪數：N
攻擊覆蓋：<已攻 N/總 M 面向>（未攻：…）
- 確認的弱點（藍方驗證為真）：
    [CRITICAL] <...> → 處置：HARDEN/MITIGATE/ACCEPT
    [HIGH] ...
- 假陽性（藍方驗證為假，已剔除）：<...>
- 殘餘風險（ACCEPT 的）：<...>
強化後命題：<...>
建議：✅ GO（critical/high 已處理）/ ⚠️ BLOCK（尚有未解 critical/high）
       承重面向有「未攻到」時 → GO 須降級為「GO（覆蓋不全，N 面向未攻）」
```

## 實作模式（程式碼 / config / docs 面向）

當面向是 `code`/`config`/`docs` 且使用者要「實際修」而非只分析，可接 Workflow（本專案已驗證的紅藍對抗 pattern）：

- pipeline：每個標的 → 紅方稽核（找 finding）→ 藍方獨立驗證（讀實際檔案判真偽）
- **實作模式的藍方做真偽過濾（is_real）+ 順手校正紅方嚴重度（corrected_severity，紅方常高估），但不在 verdict 內做四類處置分類**；第三步的 REFUTE/HARDEN/MITIGATE/ACCEPT 與第五步的「處置 / 殘餘風險」，由主 Agent 在收斂階段對「確認為真」的 finding 收斂時補上（REFUTE = is_real:false 已剔除，其餘三類在修復決策時定）。下游收斂/產出計數優先採 corrected_severity，無則 fallback 紅方 severity。
- 確認為真的 finding → 修 → 可選 Codex 複審 → publish
- 詳見 `references/workflow-pattern.md`（含本專案實際用過的 Workflow 腳本骨架）

## 重要限制（誠實告知）
- 分析模式**只找弱點 + 建議，不改檔**；要實際修走實作模式。
- steel-manning 是為了**求真不是求贏**——攻擊強化到最強，藍方守住才證明真的穩。
- 嚴重度與 go/no-go 是**輔助判斷**，最終決策仍由使用者拍板。
- **對話內單實例自我紅藍時，藍方獨立性有限**（同一模型推理鏈，confirmation/anchoring 偏誤無法靠「叫自己當藍方」根除），防假陽性效果弱於實作模式 spawn 獨立 agent。高風險命題建議走實作模式（`references/workflow-pattern.md`）或請第二個實例/人複核。
