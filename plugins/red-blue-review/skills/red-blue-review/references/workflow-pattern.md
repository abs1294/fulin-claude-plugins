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
2. **備 ground truth，且其關鍵事實前提必須先「獨立實讀來源」驗證**：紅藍同拿一份基準避免各自憑印象——但 ground truth 本身若含假事實（尤其「X 等價 Y / X 可取代 Y」這類斷言），紅藍都會引用它、裁判基於它定讞，**對抗反而精緻地論證一個錯誤結論**。備 ground truth 時，凡是當「已知」寫進去的等價/取代/涵蓋斷言，動對抗前先實讀來源核對（不可把「聽說等價」當前提）。本 session 曾連判兩次錯，皆因 ground truth 含未驗證的「collect-only 可取代 CATALOG」假設——對抗抓不到，靠人類一句常識才戳破。
3. **嚴重度校正**：藍方驗證時順便校正紅方標的嚴重度（紅方常高估）。
4. **修完可選 Codex 複審**：本 session 慣例——紅藍對抗修完 → Codex review → 才 publish。雙重把關。
5. **完整輸出別靜默截斷**：findings 多時，全列出來（哪些確認、哪些剔除、殘餘風險），不要只報一部分讓人以為「全乾淨」。
6. **schema 扁平、別灌整包大 JSON 給下游 agent**：巢狀 required enum 陣列、或把整包上游結果 stringify 塞進下游 prompt，會讓 agent 產不出合規輸出而撞 StructuredOutput retry cap、炸掉整個 workflow。FINDING/VERDICT 用扁平 schema；下游只傳精煉摘要（label + 關鍵句），需要細節讓 agent 自己 Read。本 session 早期吃過紅隊吐 `"test"` 垃圾、retry cap 炸的虧。
7. **一方持續難產 = 訊號，不是故障**：若某 agent（如質疑方）連續產不出有效輸出（撞 retry cap、`null`），在「對手論點建立在已驗證硬事實上」的情境，這往往是「它找不到站得住的反駁」的訊號——可佐證對手論點難以反駁，而非單純技術失敗。
8. **收斂後過常識終檢**：見 SKILL「第四步半」——對抗全綠不代表結論對；產出前用常識/第一性原理掂量強化後命題（延後是否=技術債、open question 是否=卸責、建議性規範是否沒人執行）。這道不靠對抗，因對抗的集體盲點正是要補的。

## FINDING / VERDICT schema 範例

> 此為範例骨架，`kind` 僅供人讀分類、下游不依賴，可依面向自訂。
> **`root_concern` 是去重鍵**：單輪 pipeline 若要餵進 `loop-runner.md` 的外層迴圈計數，**必須含 `root_concern`**（loop-runner 的去重 `norm(r.finding.root_concern)` 靠它）。缺了它，外層 `isNew` 會恆為 false → 第一輪假收斂。故此處 schema 已含 `root_concern`，與 loop-runner 保持即插即用。

```js
const FINDING_SCHEMA = { type:'object', properties:{ findings:{ type:'array', items:{
  type:'object', properties:{
    severity:{type:'string',enum:['CRITICAL','HIGH','MEDIUM','LOW']},
    kind:{type:'string',enum:['bug','inconsistency','security','config','docs']},
    root_concern:{type:'string'},   // 去重鍵（root concern，跨輪去重靠它）；接 loop-runner 外層迴圈時必備
    quote:{type:'string'}, problem:{type:'string'}, reality_or_fix:{type:'string'}
  }, required:['severity','root_concern','quote','problem','reality_or_fix'] } } }, required:['findings'] };

// corrected_severity 對應鐵律3（藍方校正紅方嚴重度）；選填，is_real:false 的假陽性無需校正。
// 下游收斂/產出計數應優先採 corrected_severity，無則 fallback 紅方 severity。
const VERDICT_SCHEMA = { type:'object', properties:{
  is_real:{type:'boolean'}, reason:{type:'string'},
  corrected_severity:{type:'string',enum:['CRITICAL','HIGH','MEDIUM','LOW']}, fix:{type:'string'}
}, required:['is_real','reason'] };
```

> 註：Workflow 是「使用者明確要多 agent 編排」才用的重型工具。小標的直接在對話裡跑紅藍分析即可，不必每次都開 Workflow。
