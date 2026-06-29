# loop-runner：含外層迴圈的紅藍對抗驅動器（程式化收斂）

> `workflow-pattern.md` 給的是**單輪** pipeline 骨架（紅攻→藍驗）。本檔給的是**含外層 `while` 迴圈的完整驅動器**——把「要不要再跑一輪」從模型自律，搬到**腳本的去重計數**判定，這是收斂能真正做到「迴圈到 0 新發現」的關鍵。

## 為什麼需要這個（病根）

紅藍對抗的收斂條件（迴圈到某輪 0 新真弱點）若寫在 SKILL 散文裡靠模型照著跑，模型會在「感覺差不多」時喊停——因為**沒有任何東西在數「這輪有幾個新弱點、該不該 continue」**。本腳本把那個計數做成真正的 `while (dry < dry_rounds)`：迴圈條件由 `seen` Set 的去重計數 + 機械閘判定，模型只負責「單輪紅攻 + 單 finding 藍驗」，**喊不喊停不在模型手上**。

對應 `convergence.md` 的三道機械閘：閘1 `is_real` 過濾、閘2 LOW/<MEDIUM 不計、閘3 去重對所有提過的比——全在腳本的 `filter` 裡，紅方湊 LOW/假 finding 都無法讓 `dry` 歸零。

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
const TARGETS = args?.targets || [
  // { key: 'skill', path: 'plugins/.../SKILL.md' },
]
const GROUND_TRUTH = args?.groundTruth || `（實際檔案清單 / 版本 / 行為）`

// ── 扁平 schema（鐵律6：別灌巢狀大 JSON，否則撞 StructuredOutput retry cap 炸 workflow）──
const FINDING_SCHEMA = { type:'object', properties:{ findings:{ type:'array', items:{
  type:'object', properties:{
    severity:{ type:'string', enum:['CRITICAL','HIGH','MEDIUM','LOW'] },
    root_concern:{ type:'string' },   // 去重靠這個（root concern，不是措辭）
    quote:{ type:'string' }, problem:{ type:'string' }, reality_or_fix:{ type:'string' }
  }, required:['severity','root_concern','quote','problem','reality_or_fix'] } } }, required:['findings'] }

const VERDICT_SCHEMA = { type:'object', properties:{
  is_real:{ type:'boolean' }, reason:{ type:'string' },
  corrected_severity:{ type:'string', enum:['CRITICAL','HIGH','MEDIUM','LOW'] }, fix:{ type:'string' }
}, required:['is_real','reason'] }

// ── 機械閘計數工具 ──
const rank = f => SEV_RANK[(f.verdict.corrected_severity || f.finding.severity || 'LOW')] // 閘2 取 corrected 優先
const norm = s => (s || '').trim().toLowerCase()   // root_concern 正規化，給去重比對

// ── 外層收斂迴圈：dry 歸零靠機械閘計數，不靠模型 ──
const seen = new Set()         // 閘3：所有提過的 root_concern（含被剔除的假陽性）
const confirmed = []           // 確認為真且 ≥MEDIUM 的弱點，供收斂後產出
const coverage = []            // 覆蓋閘：每輪攻過的面向摘要
let dry = 0                    // 連續 0 新輪數
let round = 0

while (dry < DRY_ROUNDS && round < ROUND_CAP) {
  round++
  log(`Round ${round} 開跑（dry=${dry}/${DRY_ROUNDS}）`)

  // 每個標的獨立走「紅攻 → 藍逐 finding 驗證」，pipeline 不設 barrier
  const results = await pipeline(
    TARGETS,
    (t, _orig, i) => agent(                                  // 紅方：steel-manning 找 finding
      `你是紅方稽核員。讀 ${t.path}，對照 ground truth 找真正的問題（會實際出錯/真不一致）。\n` +
      `第 ${round} 輪：避開以下已提過的顧慮，只報「明顯不同的新弱點」（root_concern 與下列不同）：\n` +
      `${[...seen].join(' / ') || '（首輪，無）'}\n` +
      `理論性/風格/可有可無的潤飾標 LOW；真會觸發的錯誤才標 MEDIUM 以上。\n${GROUND_TRUTH}`,
      { label: `red:${t.key}:r${round}`, phase: 'Red', schema: FINDING_SCHEMA }
    ),
    (audit, t) => parallel(                                  // 藍方：每個 finding 獨立驗證真偽
      (audit?.findings || []).map((f, j) => () =>
        agent(
          `你是藍方驗證員。獨立讀實際檔案驗證這個 finding 是否真實，不要相信紅方。\n` +
          `同時校正嚴重度（紅方常高估）。判 is_real 與 corrected_severity。\n` +
          `Finding：${f.problem}\n原文：${f.quote}\n紅方說應為：${f.reality_or_fix}\n\n${GROUND_TRUTH}`,
          { label: `blue:${t.key}:r${round}:${j}`, phase: 'Blue', schema: VERDICT_SCHEMA }
        ).then(verdict => ({ file: t.key, finding: f, verdict }))
      )
    )
  )

  // ── 機械閘計數：本輪新真弱點 ──
  const all = results.flat().filter(Boolean)
  let freshThisRound = 0
  for (const r of all) {
    const rc = norm(r.finding.root_concern)
    const isNew = rc && !seen.has(rc)                        // 閘3：去重對所有提過的
    if (rc) seen.add(rc)                                     // 含假陽性也記入 seen，防換皮重刷（取捨見下方註）
    if (!r.verdict.is_real) continue                         // 閘1：假陽性丟棄
    if (rank(r) < MIN_RANK) continue                         // 閘2：< MEDIUM 不計入
    if (!isNew) continue                                     // 變體/重複不算新
    freshThisRound++
    confirmed.push(r)                                        // 真新 ≥MEDIUM → 進確認清單（待修）
  }

  coverage.push({ round, targets: TARGETS.map(t => t.key), fresh: freshThisRound })
  log(`Round ${round}：新真弱點 ${freshThisRound} 個（confirmed 累計 ${confirmed.length}）`)

  if (freshThisRound === 0) dry++       // 0 新 → 乾一輪
  else dry = 0                          // 有新 → 重置（此處可插入「修 confirmed」階段後再續圈）
}

const stoppedBy = round >= ROUND_CAP && dry < DRY_ROUNDS ? 'round_cap' : 'converged'
log(`收斂結束：${stoppedBy}，共 ${round} 輪，確認弱點 ${confirmed.length} 個`)

return {
  stoppedBy,                  // 'converged'（自然收斂）或 'round_cap'（達上限強制停）
  rounds: round,
  confirmed: confirmed.map(r => ({
    file: r.file, severity: r.verdict.corrected_severity || r.finding.severity,
    problem: r.finding.problem, fix: r.verdict.fix || r.finding.reality_or_fix,
  })),
  coverage,
}
```

## 用法（主 Agent 端）

1. 主 Agent 換好 `TARGETS` / `GROUND_TRUTH`（或用 `args` 傳入），呼叫 `Workflow({ script })`。
2. 腳本回 `{ stoppedBy, rounds, confirmed, coverage }`。
3. 主 Agent 對 `confirmed`（已是 is_real + ≥MEDIUM + 去重後）做第三步的 REFUTE/HARDEN/MITIGATE/ACCEPT 處置 + 修，再過 SKILL「第四步半：常識/第一性原理終檢」，最後產出第五步報告。
4. `stoppedBy === 'round_cap'` → 產出須註明「達 round_cap 強制停，殘餘弱點如下」，不可假裝已收斂。

## 鐵律（沿用 workflow-pattern.md，此處只列與迴圈相關的）

- **覆蓋閘**：宣告 `converged` 前，主 Agent 須確認該 type 的「預設攻擊面向」每項都至少被攻過一輪（`coverage` 只記了標的，面向覆蓋需主 Agent 對照 attack-catalog 把關）。未涵蓋不得當收斂——否則退化成只攻淺面向就停。
- **`dry` 只由機械閘計數驅動**：不要在腳本外用「我覺得攻夠了」覆寫 `dry`。要更嚴謹就調高 `DRY_ROUNDS`，不要手動短路。
- **⚠️ 去重的已知取捨（誠實揭露，非 bug）**：`seen.add(rc)` 對「假陽性 / LOW」的 finding 也執行（在 is_real / 嚴重度閘之前）。這是**刻意的**——為擋「同一假 finding 換個說法每輪重刷、害迴圈永不收斂」。代價是：**若某 `root_concern` 首輪被判假/LOW、次輪同字串卻其實是真 ≥MEDIUM，會被誤殺（不計為新）→ 可能靜默漏一個真弱點、提早收斂**。緩解（非消除）：
  - **root_concern 命名要夠具體**：用「哪個檔的哪個具體顧慮」而非籠統大類（籠統 → 不同問題撞同字串 → 誤殺率高）。
  - 高風險命題想完全避免此誤殺，把 `seen.add(rc)` 移到「藍方判假」的分支外、只對 `is_real:false` 記入一個獨立的 `rejected` Set，真弱點另用 `confirmedConcerns` Set 去重——代價是換皮重刷的假 finding 會回來。**兩害相權，預設選「防永不收斂」**；此取捨已誠實標示，由使用者依命題風險選邊。
- **schema 扁平、下游只傳精煉摘要**：別把整包上游結果 stringify 塞進下游 prompt（撞 retry cap 炸 workflow）。
- **修在哪做**：上面骨架是「找＋計數」純收斂；要邊找邊修（實作模式），在 `else dry = 0` 那段之後插一個修階段（改檔→可選 Codex 複審），修完再續圈。高風險改（刪檔/跨 repo/改設定）仍須停下問使用者。
