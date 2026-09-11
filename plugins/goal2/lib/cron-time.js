// goal2 共用模組：Date ↔ CronCreate 5 欄 cron 的轉換與相關防呆。
// 被 skills/goal/goal.js 與 skills/delaylocal/delaylocal.js 共用。
'use strict';

/** Date → `分 時 日 月 *`（CronCreate 只吃 5 欄，無年份、無絕對時間戳） */
function dateToCron(d) {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

/** epoch 秒向上取整到整分（cron 是分鐘粒度；避免「目標分鐘只剩幾秒」或「分鐘已過落到明天」） */
function ceilToMinute(epochSec) {
  return Math.ceil(epochSec / 60) * 60;
}

/**
 * 跨月/跨年防呆。
 * CronCreate 只吃 5 欄 cron（分 時 日 月 週），無年份欄、亦不支援絕對時間戳（已查官方
 * scheduled-tasks 文件確認）。recurring:false 的一次性任務會在「cron 下一個符合的時間點」fire。
 * 問題：若 target 落在與「現在」不同的月/年（例：現在 8/1、目標算到隔年或另一月的 7/31），
 * `31 7 * *` 這種週期式表達的「下一個符合時間」可能被引擎解讀成「明年的 7/31」→ 排到錯年份。
 * 修法（在 5 欄限制下能做的最強防呆）：偵測 target 與 now 不同月/年時回傳警告文字，
 * 讓 skill / 使用者知道這個一次性 cron 是週期式表達、fire 時點依引擎「下一個符合」語意，
 * 若跨到非預期年份需人工確認。純加提示，不改 cron 值。同月同年回 null。
 */
function crossMonthWarning(targetD, nowD, cron) {
  if (targetD.getFullYear() === nowD.getFullYear() && targetD.getMonth() === nowD.getMonth()) return null;
  return (
    `目標時間 ${targetD.toLocaleString()} 與現在 ${nowD.toLocaleString()} 不在同一個月/年。` +
    `CronCreate 只支援 5 欄週期式 cron（無年份、無絕對時間），此 cron「${cron}」的一次性 fire ` +
    `依排程引擎「下一個符合日期」語意解讀，跨月/跨年時可能 fire 到非預期年份。` +
    `排程後請核對回報的觸發時間是否為你要的那一天；若不對，請縮短 bufferSeconds 或改用較近的排程時點。`
  );
}

module.exports = { dateToCron, ceilToMinute, crossMonthWarning };
