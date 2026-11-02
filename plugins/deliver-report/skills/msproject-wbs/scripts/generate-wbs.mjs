// MS Project WBS (MSPDI XML) 生成腳本
// 使用方式：只改「① 使用者輸入區」，其餘（排程演算法 + MSPDI 框架 + 雷區處理）不要動。
// 執行：node generate-wbs.mjs
// 驗證：跑完務必照 SKILL.md 步驟 3 用 PowerShell 驗（含元素順序檢查）。
//
// ⚠️ 最重要的雷：MSPDI 匯入器對 Task 子元素「順序」有嚴格要求（照 XSD 序列），
//    順序不對的欄位會被「靜默丟棄」——Start/Finish 被丟就是「日期全塌到專案起始日、
//    但工期正常」的經典病徵。本腳本用 TASK_ORDER 白名單 + 內建順序自檢防止退化。
//
// ── 兩種排程模式（同一份腳本都支援，依工項欄位自動判斷）──────────────
//   A. 依賴鏈自動排（簡單專案）：工項給 { d:工期天數, dep:前置工項id }，腳本依資源時間線 + 依賴自動往後排。
//   B. 週次/天粒度落位（複雜/重疊時程）：工項給 { w:[起週,迄週] } 或 { pd:[週,起日,迄日] }，直接指定落點。
//      —— 當時程本身並行重疊（例：系統二 W7–W10 與系統三 W7–W8 同時跑），依賴鏈會打散重疊，必須用 B。
//   兩模式可在同一份 MODULES 混用（各工項獨立判斷）。用 B 時要設 START/W1_MON 週錨點。
//
// ── 三層 WBS ──────────────────────────────────────────────────────
//   L1 模組（第一層摘要）→ L2 主條目（sum:true，可再帶 L3 子項）→ L3 細部工項。
//   只有兩層時：模組(L1) + 工項，工項不標 sum 即為葉子。要三層時：L2 標 sum:true，其後緊接的 L3 工項會歸它。
//   里程碑：工項標 ms:true（顯示成菱形，單日）。貫穿全期工項：標 top:true（掛在 L2 層、不歸屬某 L3 父）。
import { writeFileSync } from 'fs'

// ════════════════════════════════════════════════════════════════════
// ① 使用者輸入區（只改這一段）
// ════════════════════════════════════════════════════════════════════

const OUT = 'C:/path/to/專案時程.xml'            // 輸出路徑（中文檔名可，會加 BOM）
const PROJECT_NAME = '範例專案'
const PROJECT_TITLE = '範例開發時程'

// 生成基準日：預計完成% 的 XML 定值以此為「今天」算（重跑時改成當天）。
// 月份 0-based：6 = 7月。
const TODAY = new Date(Date.UTC(2026, 6, 21))

// ── 週錨點（只有用「週次落位」模式 w:/pd: 才需要）──────────────────
//   START   = 專案最早起算日（含前期，週一）
//   W1_MON  = 正式第 1 週(W1)的週一。若無「前期」概念，START 設成跟 W1_MON 一樣即可。
const START = new Date(Date.UTC(2026, 6, 27))   // 2026-07-27（週一）
const W1_MON = new Date(Date.UTC(2026, 7, 10))  // 2026-08-10 = W1 週一

// 資源清單：key 對應工項 res 欄；n 為顯示名（甘特圖「資源名稱」欄）。填實際人名即出現在交付檔。
const RESOURCES = [
  { key: 'BE', n: '後端工程師' },
  { key: 'FE', n: '前端工程師' },
  { key: 'QA', n: 'QA' },
  { key: 'PM', n: '專案經理' },
]

// ── WBS 內容（下面是「示範資料」，同時展示三層 / 兩種排程 / 里程碑 / 貫穿全期）──
//   工項欄位：
//     id      唯一 id（依賴鏈模式的 dep 會引用它）
//     name    工項名（純中文，勿放 M1/B1-2 這種代號，使用者看不懂）
//     res     資源 key
//     — 排程（三選一）—
//     d + dep 依賴鏈模式：d=工期天數(建議≤3)，dep=前置工項id(選填)
//     w:[a,b] 週次區間（inclusive，W(a) 週一 → W(b) 週五）
//     pd:[w,s,e] 週內天粒度（w=絕對週次, s/e=週內第幾天 0=一…4=五）
//     pre:[a,b] 前期週次（以 START 為基準的第 a..b 週，落在 W1 之前）
//     — 層級/標記 —
//     sum:true  此為 L2 主條目，其後緊接的一般工項歸它當 L3 子項
//     ms:true   里程碑（菱形，單日）
//     top:true  貫穿全期/獨立 L2 工項（不當某 L2 的子項，自己就是 L2）
const MODULES = [
  // —— 範例1：兩層 + 依賴鏈自動排（最簡單，多數小專案用這種）——
  { name: '共享基礎建設', tasks: [
    { id: 't1', name: 'DB Schema 與資料表 SQL 腳本', d: 1,   res: 'BE' },
    { id: 't2', name: 'Domain Entity 與設定', d: 1.5, res: 'BE', dep: 't1' },
  ]},
  { name: '功能開發', tasks: [
    { id: 't3', name: '後端 API', d: 2,   res: 'BE', dep: 't2' },
    { id: 't4', name: '前端串接', d: 1.5, res: 'FE', dep: 't3' },
    { id: 't5', name: '功能測試與報告', d: 2, res: 'QA', dep: 't4' },
  ]},
  // —— 範例2：三層 + 週次落位（複雜專案：L2 主條目帶 L3 子項，並行不打散）——
  { name: '系統整合', tasks: [
    { id: 's1',  name: '整合階段（主條目）', w: [1, 3], res: 'PM', sum: true },
    { id: 's1a', name: '介面契約確認', pd: [1, 0, 2], res: 'BE' },
    { id: 's1b', name: '整合測試環境建置', pd: [1, 2, 4], res: 'BE' },
    { id: 's1c', name: '端對端整合測試', w: [2, 3], res: 'QA' },
  ]},
  // —— 里程碑 ——
  { name: '里程碑', tasks: [
    { id: 'm1', name: '整合完成驗收（里程碑）', w: [3, 3], res: 'PM', ms: true },
  ]},
  // —— 貫穿全期工項（top:true）——
  { name: '專案管理（貫穿全期）', tasks: [
    { id: 'g1', name: '每週進度報告', w: [1, 3], res: 'PM', top: true },
  ]},
]

// ════════════════════════════════════════════════════════════════════
// ② 以下不要動：排程演算法 + MSPDI 框架 + 雷區處理
// ════════════════════════════════════════════════════════════════════

// —— 通用日期工具 ——
function addWorkdays(start, days) {   // 依賴鏈模式：從 start 起算 days 個工作天
  let d = new Date(start), counted = 0
  const finish = new Date(start)
  while (counted < days) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) { counted++; finish.setTime(d.getTime()) }
    d.setUTCDate(d.getUTCDate() + 1)
  }
  let next = new Date(finish)
  do { next.setUTCDate(next.getUTCDate() + 1) } while (next.getUTCDay() === 0 || next.getUTCDay() === 6)
  return { finish, next }
}
function nextWorkday(dt) { let n = new Date(dt); while (n.getUTCDay() === 0 || n.getUTCDay() === 6) n.setUTCDate(n.getUTCDate() + 1); return n }
function iso(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` }
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function workdaysBetween(a, b) {      // 含頭含尾工作天
  let n = 0, d = new Date(a)
  while (d <= b) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; d.setUTCDate(d.getUTCDate() + 1) }
  return n
}
// —— 週次落位工具 ——
function wkStart(n) { const d = new Date(W1_MON); d.setUTCDate(d.getUTCDate() + (n - 1) * 7); return d }
function wkEnd(n)   { const d = wkStart(n); d.setUTCDate(d.getUTCDate() + 4); return d }   // 該週週五
function preWeekMon(n) { const d = new Date(START); d.setUTCDate(d.getUTCDate() + n * 7); return d }  // 前期第 n 週(0-based)週一
function dayIn(monday, offset) { const d = new Date(monday); d.setUTCDate(d.getUTCDate() + offset); return d }

let uid = 1
const modUid = {}, taskUid = {}
for (const mod of MODULES) { modUid[mod.name] = uid++; for (const t of mod.tasks) taskUid[t.id] = uid++ }

// 依賴鏈模式需要的資源時間線 + 完成日記錄
const resFree = Object.fromEntries(RESOURCES.map(r => [r.key, new Date(START)]))
const done = {}

const rows = []
for (const mod of MODULES) {
  const mrow = { uid: modUid[mod.name], name: mod.name, level: 1, summary: true }
  const childRows = []
  let sawSumInModule = false   // 該模組內是否已出現 sum 主條目（決定後續一般工項是 L2 還 L3）
  for (const t of mod.tasks) {
    let start, finish, dur
    if (t.pre) {                      // 前期週次區間
      start = nextWorkday(preWeekMon(t.pre[0]))
      finish = dayIn(preWeekMon(t.pre[1] - 1), 4)
      dur = workdaysBetween(start, finish)
    } else if (t.pd) {                // 週內天粒度
      const mon = wkStart(t.pd[0])
      start = nextWorkday(dayIn(mon, t.pd[1]))
      finish = dayIn(mon, t.pd[2])
      dur = workdaysBetween(start, finish)
    } else if (t.w) {                 // 週次區間
      start = nextWorkday(wkStart(t.w[0]))
      finish = wkEnd(t.w[1])
      dur = workdaysBetween(start, finish)
    } else {                          // 依賴鏈模式（d + 選填 dep）
      let earliest = new Date(resFree[t.res])
      if (t.dep && done[t.dep]) {
        const afterDep = nextWorkday(new Date(done[t.dep].finish.getTime() + 86400000))
        if (afterDep > earliest) earliest = afterDep
      }
      earliest = nextWorkday(earliest)
      const r = addWorkdays(earliest, t.d)
      start = earliest; finish = r.finish; dur = t.d
      resFree[t.res] = r.next
      done[t.id] = { finish }
    }
    // 層級判定（避免 L1→L3 斷層）：
    //   L2 = 主條目(sum) / 里程碑(ms) / 貫穿全期(top)；也包含「模組內尚未出現 sum 主條目」的一般工項
    //        （兩層專案：工項直接掛在模組 L1 下，就是 L2，不能跳成 L3）。
    //   L3 = 只有在同模組內「已出現過 sum 主條目」之後的一般工項，才是它的子項。
    if (t.sum) sawSumInModule = true
    let level
    if (t.sum || t.ms || t.top) level = 2
    else level = sawSumInModule ? 3 : 2
    childRows.push({
      uid: taskUid[t.id], name: t.name, level,
      dur, start, finish, pred: t.dep ? taskUid[t.dep] : null, res: t.res, ms: !!t.ms, isSum: !!t.sum,
    })
  }
  mrow.start = childRows.reduce((a, c) => c.start < a ? c.start : a, childRows[0].start)
  mrow.finish = childRows.reduce((a, c) => c.finish > a ? c.finish : a, childRows[0].finish)
  mrow.dur = workdaysBetween(mrow.start, mrow.finish)
  rows.push(mrow, ...childRows)
}

// L2 的 sum:true 是 L3 的父層 → 一律視為摘要任務（不加 SNET 約束、不做資源指派，日期由子任務彙總）。
// 里程碑(ms)/貫穿全期(top) 不是摘要，維持葉子。
for (const r of rows) { if (r.isSum) r.summary = true }

// L2 摘要日期由其後續 L3 子任務彙總（涵蓋所有子項，避免父層短於子項）
for (let i = 0; i < rows.length; i++) {
  if (!rows[i].isSum) continue
  const kids = []
  for (let j = i + 1; j < rows.length && rows[j].level === 3; j++) kids.push(rows[j])
  if (!kids.length) continue
  rows[i].start = kids.reduce((a, c) => c.start < a ? c.start : a, kids[0].start)
  rows[i].finish = kids.reduce((a, c) => c.finish > a ? c.finish : a, kids[0].finish)
  rows[i].dur = workdaysBetween(rows[i].start, rows[i].finish)
}

// L1 模組日期再由其底下所有任務彙總一次（因 L2 日期上面才剛更新）
for (let i = 0; i < rows.length; i++) {
  if (rows[i].level !== 1) continue
  const kids = []
  for (let j = i + 1; j < rows.length && rows[j].level > 1; j++) kids.push(rows[j])
  if (!kids.length) continue
  rows[i].start = kids.reduce((a, c) => c.start < a ? c.start : a, kids[0].start)
  rows[i].finish = kids.reduce((a, c) => c.finish > a ? c.finish : a, kids[0].finish)
  rows[i].dur = workdaysBetween(rows[i].start, rows[i].finish)
}

const lastFinish = rows.reduce((a, r) => r.finish > a ? r.finish : a, rows[0].finish)

// ── 雷1（最關鍵）：Task 子元素嚴格照 MSPDI XSD 序列，違序欄位會被 MS Project 靜默丟棄 ──
// ExtendedAttribute 於 Task 內位置在 Manual 之後（MSPDI XSD 序列尾段）
const TASK_ORDER = ['UID','ID','Name','Type','IsNull','OutlineLevel','Start','Finish','Duration','DurationFormat','Work','Estimated','Milestone','Summary','ConstraintType','ConstraintDate','PredecessorLink','Active','Manual','ExtendedAttribute']

// ── 預計完成% 自訂公式欄（依開檔日算「照計畫今天該完成幾趴」的基準線）──────
// 實測教訓（COM round-trip + Microsoft schema 雙證，詳 SKILL.md）：
//   1. 要顯示「54%」必須用 Text 欄（Number 欄無 % 顯示格式）→ FieldID 188743731(Text1)、CFType 7。
//   2. 公式欄名用英文中括號 [Start]/[Finish]/[Duration]（匯入後 MS Project 自動在地化）。
//   3. 公式欄由 MS Project 自算，Task 層只放引用 + ValueGUID 全 0（標「計算欄」），不寫 per-task Value。
//   4. Now() = 系統時鐘。專案起始日在未來時，今天所有任務都還沒開始→全 0% 是正確基準線，非 bug。
const FIELD_ID = '188743731'   // Text1
function workdaysInclusive(a, b) { if (a > b) return 0; let n = 0, d = new Date(a); while (d <= b) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; d.setUTCDate(d.getUTCDate() + 1) } return n }
function plannedPct(start, finish) {   // XLSX 端參考用（XML 端交給公式算）；已消耗工作天 / 總工作天
  if (TODAY <= start) return 0
  if (TODAY >= finish) return 1
  const elapsed = Math.max(0, workdaysInclusive(start, TODAY) - 1)
  const total = Math.max(1, workdaysInclusive(start, finish) - 1)
  return Math.min(1, elapsed / total)
}

function taskXml(r) {
  const start = iso(r.start) + '08:00:00', finish = iso(r.finish) + '17:00:00'
  const dur = `PT${Math.round(r.dur * 8)}H0M0S`
  const fields = []
  fields.push(['UID', r.uid])
  fields.push(['ID', r.uid])
  fields.push(['Name', esc(r.name)])
  fields.push(['Type', r.summary ? 1 : 0])
  fields.push(['IsNull', 0])
  fields.push(['OutlineLevel', r.level])
  fields.push(['Start', start])
  fields.push(['Finish', finish])
  fields.push(['Duration', dur])
  fields.push(['DurationFormat', 7])
  fields.push(['Work', dur])            // 雷2：補 Work，工期才顯示天數
  fields.push(['Estimated', 0])
  fields.push(['Milestone', r.ms ? 1 : 0])
  fields.push(['Summary', r.summary ? 1 : 0])
  if (!r.summary) {                     // 雷3：葉子任務 SNET 約束釘日期；摘要不加（由子任務彙總）
    fields.push(['ConstraintType', 4])
    fields.push(['ConstraintDate', start])
  }
  if (r.pred) fields.push(['PredecessorLink', `<PredecessorUID>${r.pred}</PredecessorUID><Type>1</Type>`])
  fields.push(['Active', 1])
  fields.push(['Manual', 0])
  if (!r.summary) {                     // 預計完成%：Text 公式欄引用（值由公式算，只標計算欄）
    fields.push(['ExtendedAttribute', `<FieldID>${FIELD_ID}</FieldID><ValueGUID>00000000-0000-0000-0000-000000000000</ValueGUID>`])
  }

  // 順序自檢：違序直接 throw，讓錯誤在生成期就爆、不會流到 MS Project 才靜默壞掉
  let lastIdx = -1
  for (const [tag] of fields) {
    const idx = TASK_ORDER.indexOf(tag)
    if (idx < 0) throw new Error(`欄位 ${tag} 不在 TASK_ORDER 白名單`)
    if (idx < lastIdx) throw new Error(`欄位 ${tag} 順序違反 XSD 序列`)
    lastIdx = idx
  }
  return '    <Task>\n' + fields.map(([t, v]) => `      <${t}>${v}</${t}>`).join('\n') + '\n    </Task>'
}

// 雷4：日曆用固定正確的 WorkingTimes/WorkingTime 結構（差一個 s 的巢狀極易手拼錯）
const wt = '<WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime><WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes>'
const wd = t => `<WeekDay><DayType>${t}</DayType><DayWorking>1</DayWorking>${wt}</WeekDay>`
const calendar = `<Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays><WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>${wd(2)}${wd(3)}${wd(4)}${wd(5)}${wd(6)}<WeekDay><DayType>7</DayType><DayWorking>0</DayWorking></WeekDay></WeekDays></Calendar></Calendars>`

// 雷5：負責人用 Resource + Assignment（資源指派），不塞 Notes
const resMap = Object.fromEntries(RESOURCES.map((r, i) => [r.key, i + 1]))
let aUid = 1
const assigns = rows.filter(r => !r.summary && !r.isSum && r.res).map(r =>
  `    <Assignment><UID>${aUid++}</UID><TaskUID>${r.uid}</TaskUID><ResourceUID>${resMap[r.res]}</ResourceUID><Units>1</Units><Work>PT${Math.round(r.dur * 8)}H0M0S</Work></Assignment>`
).join('\n')
const resourceXml = RESOURCES.map((r, i) =>
  `    <Resource><UID>${i + 1}</UID><ID>${i + 1}</ID><Name>${esc(r.n)}</Name><Type>1</Type><IsNull>0</IsNull></Resource>`
).join('\n')

// 雷6：Project 層全域欄位補齊且照 XSD 序列（缺了打不開）；HonorConstraints=1 讓 SNET 生效
const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <SaveVersion>14</SaveVersion>
  <Name>${esc(PROJECT_NAME)}</Name>
  <Title>${esc(PROJECT_TITLE)}</Title>
  <ScheduleFromStart>1</ScheduleFromStart>
  <StartDate>${iso(START)}08:00:00</StartDate>
  <FinishDate>${iso(lastFinish)}17:00:00</FinishDate>
  <FYStartDate>1</FYStartDate>
  <CriticalSlackLimit>0</CriticalSlackLimit>
  <CurrencyDigits>2</CurrencyDigits>
  <CurrencySymbol>NT$</CurrencySymbol>
  <CurrencySymbolPosition>0</CurrencySymbolPosition>
  <CalendarUID>1</CalendarUID>
  <DefaultStartTime>08:00:00</DefaultStartTime>
  <DefaultFinishTime>17:00:00</DefaultFinishTime>
  <MinutesPerDay>480</MinutesPerDay>
  <MinutesPerWeek>2400</MinutesPerWeek>
  <DaysPerMonth>20</DaysPerMonth>
  <DefaultTaskType>0</DefaultTaskType>
  <DefaultFixedCostAccrual>3</DefaultFixedCostAccrual>
  <DefaultStandardRate>0</DefaultStandardRate>
  <DefaultOvertimeRate>0</DefaultOvertimeRate>
  <DurationFormat>7</DurationFormat>
  <WorkFormat>2</WorkFormat>
  <EditableActualCosts>0</EditableActualCosts>
  <HonorConstraints>1</HonorConstraints>
  <NewTasksEffortDriven>0</NewTasksEffortDriven>
  <NewTasksEstimated>1</NewTasksEstimated>
  <SplitsInProgressTasks>1</SplitsInProgressTasks>
  <SpreadActualCost>0</SpreadActualCost>
  <SpreadPercentComplete>0</SpreadPercentComplete>
  <TaskUpdatesResource>1</TaskUpdatesResource>
  <FiscalYearStart>0</FiscalYearStart>
  <WeekStartDay>1</WeekStartDay>
  <MoveCompletedEndsBack>0</MoveCompletedEndsBack>
  <MoveRemainingStartsBack>0</MoveRemainingStartsBack>
  <MoveRemainingStartsForward>0</MoveRemainingStartsForward>
  <MoveCompletedEndsForward>0</MoveCompletedEndsForward>
  <BaselineForEarnedValue>0</BaselineForEarnedValue>
  <AutoAddNewResourcesAndTasks>1</AutoAddNewResourcesAndTasks>
  <CurrentDate>${iso(START)}08:00:00</CurrentDate>
  <Autolink>1</Autolink>
  <NewTaskStartDate>0</NewTaskStartDate>
  <DefaultTaskEVMethod>0</DefaultTaskEVMethod>
  <ProjectExternallyEdited>0</ProjectExternallyEdited>
  <ExtendedCreationDate>1984-01-01T00:00:00</ExtendedCreationDate>
  <ActualsInSync>0</ActualsInSync>
  <RemoveFileProperties>0</RemoveFileProperties>
  <AdminProject>0</AdminProject>
  <ExtendedAttributes>
    <ExtendedAttribute>
      <FieldID>188743731</FieldID>
      <FieldName>Text1</FieldName>
      <CFType>7</CFType>
      <Alias>預計完成%</Alias>
      <CalculationType>2</CalculationType>
      <Formula>IIf([Duration]=0,&quot;&quot;,Format(IIf(Now()&lt;=[Start],0,IIf(Now()&gt;[Finish],100,Val(ProjDurConv(ProjDateDiff([Start],Now()),pjDays))/Val(ProjDurConv([Duration],pjDays))*100)),&quot;0&quot;) &amp; &quot;%&quot;)</Formula>
    </ExtendedAttribute>
  </ExtendedAttributes>
  ${calendar}
  <Tasks>
${rows.map(taskXml).join('\n')}
  </Tasks>
  <Resources>
${resourceXml}
  </Resources>
  <Assignments>
${assigns}
  </Assignments>
</Project>`

// 雷7：加 UTF-8 BOM（中文在 Windows / MS Project 才正常）
writeFileSync(OUT, '﻿' + xml, 'utf8')

const leaf = rows.filter(r => !r.summary)
console.log('輸出:', OUT)
console.log('模組:', MODULES.length, '| 工項:', leaf.length, '| 資源:', RESOURCES.length)
console.log('最大單一工期:', Math.max(...leaf.map(r => r.dur)), '天')
console.log('起', iso(START).replace('T', ''), '訖', iso(lastFinish).replace('T', ''))
console.log('→ 順序自檢已於生成期通過；仍請照 SKILL.md 步驟 3 跑 PowerShell 驗證')
