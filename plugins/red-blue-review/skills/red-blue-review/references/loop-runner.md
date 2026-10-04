# loop-runner：含外層迴圈的紅藍對抗驅動器（程式化收斂）

> `workflow-pattern.md` 給的是**單輪** pipeline 骨架（紅攻→藍驗）。本檔給的是**含外層 `while` 迴圈的完整驅動器**——把「要不要再跑一輪」從模型自律，搬到**腳本的去重計數**判定，這是收斂能真正做到「迴圈到 0 新發現」的關鍵。
> ⛔ **Quota 節流（v0.5.0 起，hook 強制）**：本檔骨架的 `parallel()`/`pipeline()` fan-out 受 `hooks/quota-guard.js` 管制——**必須改經 `runWaves()` 分波派發**（每波 ≤6、任一 agent 回 null 即熔斷停派；resume 走 cache 逐波續跑）。平行可以、無界灑出不行。骨架與規則見 `quota-throttling.md`；例外整批派須使用者同意標記 `// quota-user-approved:`。


## 為什麼需要這個（病根）

紅藍對抗的收斂條件（迴圈到某輪 0 新真弱點）若寫在 SKILL 散文裡靠模型照著跑，模型會在「感覺差不多」時喊停——因為**沒有任何東西在數「這輪有幾個新弱點、該不該 continue」**。本腳本把那個計數做成真正的 `while (dry < dry_rounds)`：迴圈條件由機械閘計數判定（去重對已確認的 `confirmedConcerns` 比；`seen` 只給紅方看、避免重刷），模型只負責「單輪紅攻 + 單 finding 藍驗」，**喊不喊停不在模型手上**。

對應 `convergence.md` 的三道機械閘：閘1 `is_real` 過濾、閘2 LOW/<MEDIUM 不計、閘3 去重只對已確認的比（先前判假/LOW、後來驗真的升格照算）——全在腳本的計數迴圈裡，紅方湊 LOW/假 finding 都無法讓 `dry` 歸零。

## 何時用

- 面向 `code`/`config`/`docs`、標的夠大（多檔/多面向）、且使用者**明確要多 agent 編排**（Workflow 是 opt-in 重型工具）。
- 小標的、對話內跑就好的，用 SKILL「第四步補：強制收斂追蹤」的 TaskList 紀律即可，不必開 Workflow。

## 完整可跨腳本（直接貼進 Workflow tool 的 `script`）

> 貼之前換掉 `TARGETS` 與 `GROUND_TRUTH` 兩處實際內容即可。Workflow 腳本是 JS 非 TS；`Date.now()`/`Math.random()` 在腳本內不可用（會破壞 resume），所以下方用「輪數 + index」當 label 變異來源，不靠隨機。

```js
export const meta = {
  name: 'red-blue-loop',
  description: '紅藍對抗 loop-until-dry：紅攻→藍逐 finding 獨立驗證→機械閘計數→0 新才收斂',
  phases: [
    { title: 'Red' },
    { title: 'Blue' },
  ],
}

// ── 可調參數（對應 convergence.md）──
const ROUND_CAP = 5      // 迴圈硬上限，避免攻不完
const DRY_ROUNDS = 1     // 要連續幾輪 0 新才停（提高嚴謹度設 >1）
const SEV_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }
const MIN_RANK = SEV_RANK.MEDIUM   // 閘2：< MEDIUM 不計入新弱點

// ── 標的與基準（換成你的實況）──
// ⚠️ GROUND_TRUTH 的關鍵事實前提（尤其「X 等價/取代 Y」）動對抗前須先獨立實讀來源驗證，
//    否則紅藍同拿一份假事實會精緻論證錯誤結論（見 SKILL 重要限制🔴）。
// 一個「使用者核可的面向」一筆（SKILL 第一步提案表一列），不是一個檔案一筆
const TARGETS = args?.targets || [
  // { key: 'direction', facet: '問錯問題', attack: '具體到本標的的攻擊…',
  //   exclude: '數字/版號一致性、極端輸入…', evidence: '外部錨點', paths: ['plugins/.../SKILL.md'] },
]
const GROUND_TRUTH = args?.groundTruth || `（實際檔案清單 / 版本 / 行為）`

// ── 扁平 schema（鐵律6：別灌巢狀大 JSON，否則撞 StructuredOutput retry cap 炸 workflow）──
const FINDING_SCHEMA = { type:'object', properties:{ findings:{ type:'array', items:{
  type:'object', properties:{
    severity:{ type:'string', enum:['CRITICAL','HIGH','MEDIUM','LOW'] },
    root_concern:{ type:'string' },   // 去重靠這個（root concern，不是措辭）
    quote:{ type:'string' }, problem:{ type:'string' }, reality_or_fix:{ type:'string' },
    out_of_scope:{ type:'boolean' },  // 不屬本面向但重大到非報不可 → true；不計入迴圈、不修，進「範圍外觀察」
  }, required:['severity','root_concern','quote','problem','reality_or_fix'] } },
  strongest_attempt:{ type:'string' }, // 本輪試過最強、但自己判斷站不住的攻擊＋站不住的原因（第五步「攻過無弱點」用）
}, required:['findings','strongest_attempt'] }

const VERDICT_SCHEMA = { type:'object', properties:{
  is_real:{ type:'boolean' }, reason:{ type:'string' },
  corrected_severity:{ type:'string', enum:['CRITICAL','HIGH','MEDIUM','LOW'] }, fix:{ type:'string' }
}, required:['is_real','reason'] }

// ── 機械閘計數工具 ──
const rank = f => SEV_RANK[(f.verdict.corrected_severity || f.finding.severity || 'LOW')] // 閘2 取 corrected 優先
const norm = s => (s || '').trim().toLowerCase()   // root_concern 正規化，給去重比對

// ── 外層收斂迴圈：dry 歸零靠機械閘計數，不靠模型 ──
const seen = new Set()         // 給紅方的「已提過的顧慮」：所有提過的 root_concern（含被剔除的假陽性），只用來讓紅方別重刷
const oosSeen = new Set()      // 已記過的面向外觀察（與 seen 分開，不影響範圍內去重）
const confirmed = []           // 確認為真且 ≥MEDIUM 的弱點，供收斂後產出
const ledger = []              // 全部 finding 與判定（含假陽性、LOW、已確認項的重複），供第五步逐面向回報
const attempts = []            // 每輪每面向紅方自報的「最強但站不住的攻擊」
const confirmedConcerns = new Set() // 閘3：已確認的 root_concern——計數去重只對它比
const coverage = []            // 覆蓋閘：每輪「紅方真的有回」的面向，與沒攻到的面向
const attackedEver = new Set() // 任一輪紅方有回結果的面向 key
let halted = null              // 熔斷資訊：哪一輪、哪些面向紅方回 null、幾個 finding 藍方回 null
let dry = 0                    // 連續 0 新輪數
let round = 0

while (dry < DRY_ROUNDS && round < ROUND_CAP) {
  round++
  log(`Round ${round} 開跑（dry=${dry}/${DRY_ROUNDS}）`)

  // 每個核可面向獨立走「紅攻 → 藍逐 finding 驗證」，pipeline 不設 barrier
  //
  // ── cache 友善的 prompt 結構（見本檔末「prompt cache 優化」）──
  // prompt 命中 prompt cache 的條件是「前綴逐 byte 相同」。所以每個 prompt 都按
  // 【穩定前綴 → 變動尾段】排：角色 + 固定指示 + GROUND_TRUTH（每輪/每 finding 都一樣）
  // 放最前面當穩定前綴；round / seen 清單 / 該 finding 等變動內容放最後。
  // 這樣同輪多 target、跨輪多次的紅方 prompt 共用同一段 GROUND_TRUTH 前綴 → 若 runtime
  // 有前綴比對，那段以 cache-read（約 0.1×）計，而非每次全價。GROUND_TRUTH 通常是
  // 大塊（檔案清單/版本/行為），省最多。
  const RED_PREFIX =                                          // ← 穩定前綴：每個紅方 agent 逐 byte 相同
    `你是紅方，只攻下方「本次任務」指派給你的那一個面向，面向外的觀察原則上不報；` +
    `真的重大到會改變使用者決定才報，並標 out_of_scope:true（不計入、不修）。\n` +
    `只報會改變使用者決定或會實際出錯的弱點；可有可無的潤飾標 LOW。\n` +
    `另在 strongest_attempt 寫出你試過最強、但自己判斷站不住的攻擊與原因（找到弱點也要寫）。\n` +
    `只報「明顯不同的新弱點」，避開下方「已提過的顧慮」清單裡的 root_concern。\n` +
    `=== GROUND TRUTH（比對基準，勿憑印象）===\n${GROUND_TRUTH}\n=== GROUND TRUTH 結束 ===\n`
  const BLUE_PREFIX =                                         // ← 穩定前綴：每個藍方 agent 逐 byte 相同
    `你是藍方驗證員。獨立讀實際檔案驗證紅方 finding 是否真實，不要相信紅方。\n` +
    `同時校正嚴重度（紅方常高估）。判 is_real 與 corrected_severity。\n` +
    `=== GROUND TRUTH（比對基準，勿憑印象）===\n${GROUND_TRUTH}\n=== GROUND TRUTH 結束 ===\n`

  const attackedThisRound = new Set()                         // 本輪紅方有回結果（非 null）的面向
  const results = await pipeline(
    TARGETS,
    (t, _orig, i) => agent(                                  // 紅方：穩定前綴在前，變動（target/round/seen）在後
      RED_PREFIX +
      `--- 本次任務（變動段）---\n` +
      `你的面向：「${t.facet}」。要攻什麼：${t.attack}\n` +
      `不歸你管（不要報）：${t.exclude}\n` +
      `證據標準：${t.evidence}（可重現＝附重現步驟；外部錨點＝base rate/前例/因果機制）\n` +
      `相關檔案：${(t.paths || []).join(', ')}。第 ${round} 輪。\n` +
      `已提過的顧慮（避開這些 root_concern）：${[...seen].join(' / ') || '（首輪，無）'}\n` +
      `已記過的面向外觀察（不要再報）：${[...oosSeen].join(' / ') || '（無）'}`,
      { label: `red:${t.key}:r${round}`, phase: 'Red', schema: FINDING_SCHEMA }
    ).then(audit => {                                         // null＝沒攻到，不記
      if (audit) {
        attackedThisRound.add(t.key)
        attempts.push({ round, facet: t.key, strongest_attempt: audit.strongest_attempt || '' })
      }
      return audit
    }),
    (audit, t) => parallel(                                  // 藍方：穩定前綴在前，變動（該 finding）在後
      (audit?.findings || []).map((f, j) => f.out_of_scope
        ? () => Promise.resolve({ file: t.key, finding: f, verdict: null })   // 面向外：不計入也不修，不派藍方、省 quota
        : () => agent(
          BLUE_PREFIX +
          `--- 待驗證 finding（變動段）---\n` +
          `面向：「${t.facet}」；相關檔案：${(t.paths || []).join(', ')}\n` +
          `Finding：${f.problem}\n原文：${f.quote}\n紅方說應為：${f.reality_or_fix}`,
          { label: `blue:${t.key}:r${round}:${j}`, phase: 'Blue', schema: VERDICT_SCHEMA }
        ).then(verdict => ({ file: t.key, finding: f, verdict }))
      )
    )
  )

  // ── 機械閘計數：本輪新真弱點 ──
  const all = results.flat().filter(Boolean)
  const seenAtRoundStart = new Set(seen)                     // 判「升格」用：只看前幾輪提過的，同輪先假後真不算升格
  let freshThisRound = 0
  let unverifiedThisRound = 0
  for (const r of all) {
    const rc = norm(r.finding.root_concern)
    const entry = {                                          // 第五步逐面向回報用的流水帳
      round, facet: r.file, root_concern: r.finding.root_concern, problem: r.finding.problem,
      quote: r.finding.quote, reality_or_fix: r.finding.reality_or_fix,   // 原文與紅方證據／修法，第五步附證據用
      severity: r.verdict ? (r.verdict.corrected_severity || r.finding.severity) : r.finding.severity,
      reason: r.verdict?.reason || '', status: '',
    }
    ledger.push(entry)
    if (r.finding.out_of_scope) {                            // 面向外（沒派藍方，verdict 必為 null）：不計入、不修
      if (rc && oosSeen.has(rc)) { ledger.pop(); continue }  // 已記過的面向外觀察：不重複記
      entry.status = 'out_of_scope'
      if (rc) oosSeen.add(rc)                                // 另記一份，不進 seen——免得吞掉之後範圍內同顧慮的真弱點
      continue
    }
    if (!r.verdict) {                                        // 藍方回 null：沒驗到（多半是 quota/API 終止）。
      entry.status = 'unverified'                            // 不當假陽性、不進 seen；本輪結束後熔斷停跑（見迴圈尾）
      unverifiedThisRound++
      continue
    }
    const seenBefore = rc && seenAtRoundStart.has(rc)        // 前幾輪提過（可能判假/LOW）
    if (rc) seen.add(rc)                                     // 記入給紅方的已提過清單，讓紅方別重刷
    if (!r.verdict.is_real) { entry.status = 'false_positive'; continue } // 閘1：假陽性丟棄（重刷的假 finding 也在這裡擋）
    if (rank(r) < MIN_RANK) { entry.status = 'low'; continue }            // 閘2：< MEDIUM 不計入
    if (rc && confirmedConcerns.has(rc)) { entry.status = 'duplicate_of_confirmed'; continue } // 閘3：只對已確認的去重
    if (seenBefore) entry.upgraded = true                    // 先前判假/LOW、本輪驗為真且 ≥MEDIUM → 升格為新真弱點
    entry.status = 'confirmed'
    if (rc) confirmedConcerns.add(rc)
    freshThisRound++
    confirmed.push(r)                                        // 真新 ≥MEDIUM → 進確認清單（待修）
  }

  for (const k of attackedThisRound) attackedEver.add(k)
  coverage.push({
    round,
    attacked: [...attackedThisRound],                                     // 紅方真的有回的面向
    missing: TARGETS.map(t => t.key).filter(k => !attackedThisRound.has(k)), // 紅方回 null 的面向
    fresh: freshThisRound,
  })
  log(`Round ${round}：新真弱點 ${freshThisRound} 個（confirmed 累計 ${confirmed.length}）`)

  // ── 熔斷：本輪任一紅方或藍方回 null（quota/API 終止）→ 立即停跑，不派下一輪（SKILL「Quota 節流」）──
  // 已完成的結果都留在 ledger；恢復後用 resumeFromRunId 續跑，未驗的 finding 由下一輪紅方重提、藍方重驗。
  const redNullThisRound = TARGETS.length - attackedThisRound.size
  if (redNullThisRound > 0 || unverifiedThisRound > 0) {
    halted = { round, redNull: coverage[coverage.length - 1].missing, unverified: unverifiedThisRound }
    log(`Round ${round}：有 agent 回 null，熔斷停跑`)
    break
  }

  if (freshThisRound === 0) dry++       // 0 新 → 乾一輪
  else dry = 0                          // 有新 → 重置（此處可插入「修 confirmed」階段後再續圈）
}

const uncovered = TARGETS.map(t => t.key).filter(k => !attackedEver.has(k))
const stoppedBy = halted ? 'halted_on_null'   // 熔斷：不算收斂，結論一律 BLOCK（中斷），回報使用者
  : round >= ROUND_CAP && dry < DRY_ROUNDS ? 'round_cap'
  : 'converged'
log(`收斂結束：${stoppedBy}，共 ${round} 輪，確認弱點 ${confirmed.length} 個`)

return {
  stoppedBy,                  // 'converged'（自然收斂）/ 'round_cap'（達上限強制停）/ 'halted_on_null'（有 agent 回 null，熔斷）
  halted,                     // 熔斷時的細節；未熔斷為 null
  rounds: round,
  confirmed: confirmed.map(r => ({
    file: r.file, severity: r.verdict.corrected_severity || r.finding.severity,
    problem: r.finding.problem, quote: r.finding.quote, reason: r.verdict.reason,
    fix: r.verdict.fix || r.finding.reality_or_fix,
  })),
  uncovered,                  // 從頭到尾沒攻到的面向 → 非空即 BLOCK（覆蓋不全）
  ledger,                     // 全部 finding＋status（confirmed〔升格者另帶 upgraded:true〕/ false_positive / low / duplicate_of_confirmed / unverified / out_of_scope）
  attempts,                   // 每輪每面向的最強嘗試攻擊，「攻過無弱點」面向用
  coverage,
}
```

## 用法（主 Agent 端）

1. 主 Agent 先完成 SKILL 第一步（面向提案 → 使用者核可），把核可面向填進 `TARGETS`，換好 `GROUND_TRUTH`（或用 `args` 傳入），呼叫 `Workflow({ script })`。
2. 腳本回 `{ stoppedBy, halted, rounds, confirmed, uncovered, ledger, attempts, coverage }`。第五步最終回報照 `ledger` 依 `facet` 分組逐面向展開：`confirmed` → 確認弱點；`false_positive` → 假陽性（附 `reason`）；`low` → LOW；`confirmed` 帶 `upgraded:true` 的 → 先前判假/LOW、後來驗為真的升格項，報告註明「先前誤判」；`duplicate_of_confirmed` → 已確認項的重複，不必再列；`unverified` → 藍方回 null 沒驗到（只會出現在熔斷那一輪），照實列出（≥MEDIUM 的未驗項使結論為 BLOCK（未驗證））；`out_of_scope` → 「範圍外觀察」。「攻過無弱點」面向的最強攻擊取自 `attempts`（紅方自報）與該面向的 `false_positive`（藍方判假理由），取較強者。`uncovered` 非空 → 結論為 BLOCK（覆蓋不全）。
3. 主 Agent 對 `confirmed`（已是 is_real + ≥MEDIUM + 去重後）做第三步的 REFUTE/HARDEN/MITIGATE/ACCEPT 處置 + 修，再過 SKILL「第四步半：常識/第一性原理終檢」，最後產出第五步報告。
4. `stoppedBy === 'round_cap'` → 產出須註明「達 round_cap 強制停，殘餘弱點如下」，不可假裝已收斂。`stoppedBy === 'halted_on_null'` → 有紅方或藍方回 null（quota/API 終止），腳本已當輪熔斷停跑：**不算收斂**，先回報使用者（`halted` 記了哪一輪、哪些面向紅方沒回、幾個 finding 沒驗到）；結論一律 BLOCK（中斷），並視 `uncovered`／`unverified` 另加註覆蓋不全、未驗證。quota 恢復後以 `resumeFromRunId` 續跑——已完成的走 cache，沒回的重派。
5. 藍方回 null 的 finding（`unverified`）不當假陽性、不進去重集合，所以續跑後紅方重提時會被重驗；不會有「後輪已驗過、前輪仍留 unverified」的情形，因為一出現 null 腳本就停了。

## 鐵律（沿用 workflow-pattern.md，此處只列與迴圈相關的）

- **覆蓋閘**：宣告 `converged` 前，主 Agent 須確認第一步核可的每個面向都至少被攻過一輪（`TARGETS` 一筆就是一個核可面向；腳本回傳的 `uncovered` 就是紅方從頭到尾都回 null、沒攻到的面向，只會在熔斷時非空（此時 `stoppedBy` 為 `'halted_on_null'`）、不得當收斂，`coverage[].missing` 另記每輪漏掉哪些）。未涵蓋不得當收斂——否則退化成只攻淺面向就停。
- **`dry` 只由機械閘計數驅動**：不要在腳本外用「我覺得攻夠了」覆寫 `dry`。要更嚴謹就調高 `DRY_ROUNDS`，不要手動短路。
- **去重只對已確認的比（升格規則）**：`seen` 只用來告訴紅方「這些提過了，別重刷」；計數去重只看 `confirmedConcerns`。所以某 `root_concern` 先前被判假/LOW、這輪被藍方驗為真且 ≥MEDIUM → 照計新真弱點（`upgraded:true`），不會被當變體吞掉。不會因此不收斂：確認過一次之後再提都是 `duplicate_of_confirmed`，重刷的假 finding 每次都被閘1擋。**root_concern 命名要夠具體**（「哪個檔的哪個具體顧慮」），避免不同問題撞同字串被誤當已確認項的重複。
- **schema 扁平、下游只傳精煉摘要**：別把整包上游結果 stringify 塞進下游 prompt（撞 retry cap 炸 workflow）。
- **修在哪做**：上面骨架是「找＋計數」純收斂；要邊找邊修（實作模式），在 `else dry = 0` 那段之後插一個修階段（改檔→可選 Codex 複審），修完再續圈。高風險改（刪檔/跨 repo/改設定）仍須停下問使用者。
- **修階段後必插「修復複驗」agent（MANDATORY，不信自述）**：每個「宣稱已修」的 finding，spawn 一個**獨立**複驗 agent（不得由執行修的 agent 自驗、不得只看修 agent 的回報文字）——實讀改後檔案確認修改落地、拿原攻擊路徑對改後版本再打一次。**複驗 fail → `confirmedConcerns.delete(norm(rc))`（並 `seen.delete`）把該 root_concern 移出去重集合**，讓下一輪紅攻重提時照計新弱點（否則閘3 會把「沒修好」吞成變體、靜默漏掉），並退回重修。收斂（`dry` 累計）只在「本輪所有已修項複驗全過」的前提下才有效。

## prompt cache 優化（零對抗損失的省 token）

> 紅藍對抗是 plugin 裡最貴的（每多一輪 = 多一輪紅方全量重讀 GROUND_TRUTH）。**prompt cache 是不削弱對抗、純省錢的唯一槓桿**——它不減攻擊輪數、不減 finding、不動收斂邏輯，只讓「重複的前綴」便宜約 10 倍。

**機制（Anthropic prompt caching，硬規則）**：
- 命中條件 = **前綴逐 byte 相同** + 在 **TTL 內**（預設 5 分鐘，命中會刷新）。render 順序 `tools → system → messages`，任何一個 byte 變動就讓其後全部失效。
- cache read ≈ 原價 **0.1×**（省 90%）；只省**輸入** token，不省輸出。
- **最小可快取前綴依模型而定**（Opus 等級為數千 tokens 量級；確切門檻以官方 prompt-caching 文件當下的「minimum cacheable prefix」表為準，會隨模型版本變動）——前綴小於該門檻**靜默不快取**（無錯誤、`cache_creation_input_tokens: 0`）。

**本腳本怎麼吃到它（已套用在上面的 `RED_PREFIX` / `BLUE_PREFIX`）**：
- 每個紅/藍 prompt 按【穩定前綴 → 變動尾段】排：**角色 + 固定指示 + GROUND_TRUTH 放最前**（每輪、每 target、每 finding 都逐 byte 相同），round / seen / 該 finding 放最後。
- 效果：同輪多 target、跨輪多次的紅方 prompt 共用同一段 GROUND_TRUTH 前綴。GROUND_TRUTH 通常是大塊（檔案清單/版本/行為），是省最多的部分。

**並行 timing（同輪 N 個紅方）**：cache 只在第一個 response **開始 streaming 後**才可讀——N 個完全並行的請求**全部付全價**（沒人能讀別人還在寫的）。要吃到 cache，pipeline 宜**先發 1 個紅方、待其開始輸出、再發其餘**（stagger）。本骨架的 pipeline 是否 stagger 取決於 Workflow runtime 排程；若 runtime 全並行發，同輪這層 cache 收益有限，但**跨輪**仍可命中（前提：輪間 < TTL）。

**誠實邊界（這道是設計優化，不是保證命中）**：
- ⚠️ **Workflow 的 `agent()` 是高階封裝，不暴露 `cache_control` 參數，也不回傳 `usage`**。本優化做的是「把 prompt 結構改成 cache-friendly（穩定前綴前置）」，讓 runtime **若**有自動 caching / 前綴比對時**有機會**命中——**不是**在腳本裡硬加 breakpoint，也**無法**從 `agent()` 回傳值驗證是否真的命中。
- ⚠️ **「GROUND_TRUTH 放最前」是相對 user message 內部，不是整個可快取前綴的最前。** render 順序是 `tools → system → messages`，所以可快取前綴的**真正起點在 tools + system 層**，而我們的 prompt 字串進的是 messages（user）。`agent()` 注入的 tools 與 system 由 runtime 決定、**腳本完全控制不到**：只要 runtime 在 system/tools 放了任何逐 call 變動的 byte（label、phase、計數器…），GROUND_TRUTH 之前就已失效、它永遠進不了「逐 byte 相同前綴」。**這是命中與否的隱性 silent invalidator，且在 `agent()` 這層看不到、改不到**——所以本優化的實際收益高度依賴 runtime 怎麼組 system/tools，可能從「省很多」到「0 命中」都有。
- ⚠️ **紅方與藍方各自一條 cache 線、不共用前綴**——這是設計上本就如此，原因有二：(a) `RED_PREFIX` 與 `BLUE_PREFIX` 的文字本就完全不同（messages 層即已分叉，連 GROUND_TRUTH 之外的角色/指示都不同）；(b) 紅方的 `FINDING_SCHEMA` 與藍方的 `VERDICT_SCHEMA` 走 **`output_config.format`**（結構化輸出，與 `tools` 參數分離的獨立欄位），schema 不同會使該 thread 的 cache 失效。**所以紅藍 GROUND_TRUTH 只能各自被快取一份，無法互相共用**——這不影響「同類（紅對紅、藍對藍）跨輪/跨 target 共用」的收益，但別期待紅藍之間有 cache 綜效。
- 要拿命中的**硬證據**只有一條路：另寫獨立腳本直接呼叫 Messages API，同一前綴送兩次，讀第二次的 `usage.cache_read_input_tokens > 0`。`agent()` 拿不到這個欄位。
- **GROUND_TRUTH 太小（小標的）→ 達不到該模型的最小快取門檻（見上，依官方文件而定），靜默不 cache**。這種小標的本來就該對話內手動跑、不開 Workflow，cache 與否無所謂。
- **跨輪間隔 > 5 分鐘（藍驗+改檔慢）→ GROUND_TRUTH 的 cache 過期**，下一輪重新付全價寫入。要跨長間隔保溫可考慮把 GROUND_TRUTH 視為 1 小時 TTL 的候選（但那是 API 層設定，`agent()` 同樣不暴露）。
- **跨「執行」命中還隱含要求 `args.groundTruth` 逐 byte 相同**：本檔只保證單次 run 內前綴穩定；若每次重跑都帶略不同的 GROUND_TRUTH（多一個換行、版本號變動），跨執行 cache 即全失效。

**一句話**：把 GROUND_TRUTH 放穩定前綴最前，是「讓重複前綴有機會走 cache-read」的零對抗損失設計；命中與否最終由 runtime 與「最小前綴門檻 / TTL」兩道閘決定，且唯一硬驗證在 API 層、不在腳本層。
