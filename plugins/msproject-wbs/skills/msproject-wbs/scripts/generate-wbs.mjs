// MS Project WBS (MSPDI XML) 生成腳本
// 使用方式：只改「① 使用者輸入區」，其餘（排程演算法 + MSPDI 框架 + 雷區處理）不要動。
// 執行：node generate-wbs.mjs
// 驗證：跑完務必照 SKILL.md 步驟 3 用 PowerShell 驗（含元素順序檢查）。
//
// ⚠️ 最重要的雷：MSPDI 匯入器對 Task 子元素「順序」有嚴格要求（照 XSD 序列），
//    順序不對的欄位會被「靜默丟棄」——Start/Finish 被丟就是「日期全塌到專案起始日、
//    但工期正常」的經典病徵。本腳本用 TASK_ORDER 白名單 + 內建順序自檢防止退化。
import { writeFileSync } from 'fs'

// ════════════════════════════════════════════════════════════════════
// ① 使用者輸入區（只改這一段）
// ════════════════════════════════════════════════════════════════════

const OUT = 'C:/path/to/專案時程.xml'            // 輸出路徑（中文檔名可，會加 BOM）
const PROJECT_NAME = '專案時程'
const PROJECT_TITLE = '開發測試計畫'
const START = new Date(Date.UTC(2026, 6, 10))     // 專案起始日（月份 0-based：6 = 7月）

// 資源清單：key 對應工項 res 欄；n 為顯示名稱（會出現在甘特圖「資源名稱」欄）
const RESOURCES = [
  { key: 'BE', n: '後端工程師' },
  { key: 'FE', n: '前端工程師' },
  { key: 'QA', n: 'QA' },
]

// 功能模組（第一層摘要）+ 工項（第二層）
//   工項：{ id, name(純中文,勿放代號), d(工期天數,建議≤3), res(資源key), dep(前置工項id,選填) }
//   多人並行：每個資源各一條時間線，工項起始 = max(該資源空閒日, 依賴完成後一天)
const MODULES = [
  { name: '共享基礎建設', tasks: [
    { id: 't1', name: 'DB Schema 與資料表 SQL 腳本', d: 1,   res: 'BE' },
    { id: 't2', name: 'Domain Entity 與設定', d: 1.5, res: 'BE', dep: 't1' },
  ]},
  { name: '功能開發', tasks: [
    { id: 't3', name: '後端 API', d: 2, res: 'BE', dep: 't2' },
    { id: 't4', name: '前端串接', d: 1.5, res: 'FE', dep: 't3' },
  ]},
  { name: '測試', tasks: [
    { id: 't5', name: '功能測試與報告', d: 2, res: 'QA', dep: 't4' },
  ]},
]

// ════════════════════════════════════════════════════════════════════
// ② 以下不要動：排程演算法 + MSPDI 框架 + 雷區處理
// ════════════════════════════════════════════════════════════════════

function addWorkdays(start, days) {
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

const resFree = Object.fromEntries(RESOURCES.map(r => [r.key, new Date(START)]))
const done = {}
let uid = 1
const modUid = {}, taskUid = {}
for (const mod of MODULES) { modUid[mod.name] = uid++; for (const t of mod.tasks) taskUid[t.id] = uid++ }

const rows = []
for (const mod of MODULES) {
  const mrow = { uid: modUid[mod.name], name: mod.name, level: 1, summary: true }
  const childRows = []
  for (const t of mod.tasks) {
    let earliest = new Date(resFree[t.res])
    if (t.dep && done[t.dep]) {
      const afterDep = nextWorkday(new Date(done[t.dep].finish.getTime() + 86400000))
      if (afterDep > earliest) earliest = afterDep
    }
    earliest = nextWorkday(earliest)
    const { finish, next } = addWorkdays(earliest, t.d)
    resFree[t.res] = next
    done[t.id] = { finish, uid: taskUid[t.id] }
    childRows.push({ uid: taskUid[t.id], name: t.name, level: 2, dur: t.d, start: earliest, finish, pred: t.dep ? taskUid[t.dep] : null, res: t.res })
  }
  mrow.start = childRows[0].start
  mrow.finish = childRows.reduce((a, c) => c.finish > a ? c.finish : a, childRows[0].finish)
  mrow.dur = childRows.reduce((a, c) => a + c.dur, 0)
  rows.push(mrow, ...childRows)
}
const lastFinish = rows.reduce((a, r) => r.finish > a ? r.finish : a, rows[0].finish)

// ── 雷1（最關鍵）：Task 子元素嚴格照 MSPDI XSD 序列，違序欄位會被 MS Project 靜默丟棄 ──
const TASK_ORDER = ['UID','ID','Name','Type','IsNull','OutlineLevel','Start','Finish','Duration','DurationFormat','Work','Estimated','Milestone','Summary','ConstraintType','ConstraintDate','PredecessorLink','Active','Manual']

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
  fields.push(['Milestone', 0])
  fields.push(['Summary', r.summary ? 1 : 0])
  if (!r.summary) {                     // 雷3：葉子任務 SNET 約束釘日期；摘要不加（由子任務彙總）
    fields.push(['ConstraintType', 4])
    fields.push(['ConstraintDate', start])
  }
  if (r.pred) fields.push(['PredecessorLink', `<PredecessorUID>${r.pred}</PredecessorUID><Type>1</Type>`])
  fields.push(['Active', 1])
  fields.push(['Manual', 0])

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
const assigns = rows.filter(r => r.level === 2 && r.res).map(r =>
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
