# 實作模式：接 Workflow 的紅藍對抗

> 程式碼 / config / docs 面向時，不只分析——實際 spawn agent 找問題、藍方獨立驗證、修。
> 這是本專案實戰用過的 pattern（多次對 plugin-manager 整包稽核都這樣跑）。

## 何時用實作模式
- 面向是 `code`/`config`/`docs`，且使用者要「實際修」而非只看分析。
- 標的範圍夠大（多檔/多面向），值得 fan-out 平行稽核。

## 核心結構：pipeline（紅方稽核 → 藍方獨立驗證）

每個標的（檔案/面向）獨立走「紅方找 finding → 藍方逐 finding 驗證真偽」，pipeline 不設 barrier：

```js
// 先備 ground truth（實際狀況），給每個 agent 當比對基準——這是過濾假陽性的關鍵
const GROUND_TRUTH = `...實際的檔案清單/版本/行為...`;

const results = await pipeline(
  TARGETS,                                  // 每個檔案/面向一筆
  (t) => agent(                             // 紅方：找 finding
    `你是紅方稽核員。讀 ${t.path}，對照 ground truth 找真正的問題（bug/不一致）。\n` +
    `只報會實際出錯或真不一致的，理論性/風格問題不報。\n${GROUND_TRUTH}`,
    { label: `red:${t.key}`, phase: 'Red', schema: FINDING_SCHEMA }
  ),
  (audit, t) => parallel(                    // 藍方：每個 finding 獨立驗證
    (audit?.findings || []).map(f => () =>
      agent(
        `你是藍方驗證員。獨立讀實際檔案驗證這個 finding 是否真實，不要相信紅方。\n` +
        `Finding：${f.problem}\n原文：${f.quote}\n紅方說應為：${f.reality_or_fix}\n\n${GROUND_TRUTH}`,
        { label: `blue:${t.key}`, phase: 'Blue', schema: VERDICT_SCHEMA }
      ).then(v => ({ file: t.key, finding: f, verdict: v }))
    )
  )
);
const confirmed = results.flat().filter(Boolean).filter(r => r.verdict?.is_real);
```

## 鐵律（本專案實戰教訓）

1. **藍方一定要「獨立讀實際檔案」驗證**，不能信紅方——否則假陽性（false finding）混進來。本 session 多次靠這抓出紅方的過時/誤判（連 Codex 都有過讀到舊快照的假陽性）。
2. **備 ground truth**：紅藍 agent 都拿同一份「實際狀況」當基準，避免各自憑印象。
3. **嚴重度校正**：藍方驗證時順便校正紅方標的嚴重度（紅方常高估）。
4. **修完可選 Codex 複審**：本 session 慣例——紅藍對抗修完 → Codex review → 才 publish。雙重把關。
5. **完整輸出別靜默截斷**：findings 多時，全列出來（哪些確認、哪些剔除、殘餘風險），不要只報一部分讓人以為「全乾淨」。

## FINDING / VERDICT schema 範例

```js
const FINDING_SCHEMA = { type:'object', properties:{ findings:{ type:'array', items:{
  type:'object', properties:{
    severity:{type:'string',enum:['CRITICAL','HIGH','MEDIUM','LOW']},
    kind:{type:'string',enum:['bug','inconsistency']},
    quote:{type:'string'}, problem:{type:'string'}, reality_or_fix:{type:'string'}
  }, required:['severity','kind','quote','problem','reality_or_fix'] } } }, required:['findings'] };

const VERDICT_SCHEMA = { type:'object', properties:{
  is_real:{type:'boolean'}, reason:{type:'string'}, fix:{type:'string'}
}, required:['is_real','reason'] };
```

> 註：Workflow 是「使用者明確要多 agent 編排」才用的重型工具。小標的直接在對話裡跑紅藍分析即可，不必每次都開 Workflow。
