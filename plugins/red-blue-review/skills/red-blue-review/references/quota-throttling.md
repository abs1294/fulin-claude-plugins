# Quota 節流（MANDATORY）——分波派發＋撞牆熔斷

> 事故背景（兩次同型）：把整支艦隊（5 紅攻＋30+ 藍驗）一次 `parallel` 灑出去 → 撞 5h quota、飛行中 agent 全滅白燒 → quota reset 後 resume 又把剩餘艦隊一次灑出去 → **再撞一次**。根因不是平行——**平行可以**——是「無界派發」＋「撞牆不熔斷」＋「resume 不分波」三件事疊加。本檔規則由 plugin 的 PreToolUse hook（`hooks/quota-guard.js`）強制。

## 三條鐵則

1. **分波派發（bounded waves）**：多 agent fan-out 一律透過 `runWaves()`（下方骨架）分波，每波併發 ≤ 6（重型讀碼/審查 agent 建議 ≤ 4）。任何時刻在飛的 token 曝險 ≤ 一波。
2. **撞牆熔斷**：任一 agent 因 quota / API 終止（`agent()` 回 `null`）→ **立即停止派下一波**、保留已完成結果，回報使用者等指示。禁止自動重試、禁止繼續派。
3. **Resume 不重灑**（前兩者的自然結果，非獨立機制）：`resumeFromRunId` 對已完成 agent 走 cache 是 harness 內建；但 resume＝重放同一支腳本——腳本若是無界 parallel，沒 cache 的 agent 照樣一次全灑（第二次事故即此）。腳本用 `runWaves` 寫，resume 重放時自然分波續跑，「reset 後重啟」最多再曝險一波。

**大艦隊先報備**：單一 workflow 預計 agent 總數 > 15、或估算總預算 >1M tokens（agent 數 × 每 agent 預估——讀碼/審查類常見 60k~150k）時，啟動前先把估算報給使用者、取得同意再發（此時可用 `// quota-user-approved:` 走整批豁免，或仍分波跑）。

## runWaves 骨架（hook 放行的標準模式）

```js
// 分波派發：每波 ≤ waveSize 併發；任一 agent 回 null（quota/API 終止或使用者 skip）→ 熔斷不派下一波
async function runWaves(items, run, waveSize = 6) {
  const out = []
  for (let i = 0; i < items.length; i += waveSize) {
    const wave = await parallel(items.slice(i, i + waveSize).map((it) => () => run(it)))
    out.push(...wave)
    if (wave.some((r) => r === null)) {
      log(`⛔ 熔斷：第 ${Math.floor(i / waveSize) + 1} 波有 agent 終止（quota/API），停止派發。已完成 ${out.filter(Boolean).length}/${items.length}，其餘待 resume 續跑`)
      break
    }
  }
  return out
}

// 用法（紅攻 5 路 → 波 4；藍驗 N 筆 → 波 6）
const reds = await runWaves(REDS, (r) => agent(r.prompt, { label: `red:${r.key}`, schema: FINDINGS }), 4)
const verdicts = await runWaves(findings, (f) => agent(verifyPrompt(f), { schema: VERDICT }), 6)
```

> `pipeline()` 同理：items 多且每 item 派 agent 時，把 items 先切波、逐波 pipeline。hook 檢測到 `runWaves(` 即放行——helper 的熔斷邏輯（`null` 即 break）不可省略，那是防二次撞牆的核心。

## 對話內模式（不走 Workflow）比照辦理

Agent tool 直接派發時：同一輪訊息重型 agent ≤ 4；收到「quota / session limit」失敗通知，立即停止派新 agent、回報使用者，等使用者說繼續才續派（且從失敗處分波續，不整批重派）。
