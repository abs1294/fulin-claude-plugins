#!/usr/bin/env node
// PostToolUse hook（matcher: CronCreate|CronDelete|ScheduleWakeup）：
// 把本 session 的排程狀態寫進 tmp（claude-crons-<sid>.json），供 statusline.js
// 在 agents/skills 欄底部的固定兩 row 顯示「有沒有排程、下一發幾點」。
//
// 已知限制（誠實聲明）：hook 只看得到「排程被建立/刪除」，看不到 job 實際 fire——
// 一次性排程由 statusline 依觸發時間推算過期剔除；循環排程會一直顯示到 CronDelete。
// 全程 fail-open：任何解析/讀寫失敗都靜默退出，絕不影響工具流程。

const fs = require('fs');
const os = require('os');
const path = require('path');

const atomicWrite = (f, data) => {
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
};

// 一次性 cron（M H DoM Mon *，四欄皆數字）→ 下一次觸發 epoch ms；解析不了回 null。
function nextFire(cron) {
  try {
    const p = String(cron).trim().split(/\s+/);
    if (p.length < 5) return null;
    const [m, h, dom, mon] = p;
    if ([m, h, dom, mon].some((x) => !/^\d+$/.test(x))) return null; // 含 * / 範圍 = 循環，交給呼叫端
    const now = new Date();
    let d = new Date(now.getFullYear(), +mon - 1, +dom, +h, +m);
    if (d.getTime() < Date.now() - 60000) d = new Date(now.getFullYear() + 1, +mon - 1, +dom, +h, +m);
    return d.getTime();
  } catch (e) { return null; }
}

function shortLabel(s) {
  const t = String(s || '').split('\n')[0].replace(/^\/goal\s*/, '').replace(/^\[([^\]]{0,20})\].*/, '$1').trim();
  return [...t].slice(0, 14).join('');
}

let d = '';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const tool = i.tool_name || '';
    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const file = path.join(os.tmpdir(), `claude-crons-${sid}.json`);
    let jobs = {};
    try { jobs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    const respText = (() => { try { return JSON.stringify(i.tool_response || ''); } catch (e) { return ''; } })();
    const input = i.tool_input || {};

    if (tool === 'CronCreate') {
      const idm = respText.match(/task ([a-z0-9-]{6,})/i) || respText.match(/job ([a-z0-9-]{6,})/i);
      const id = idm ? idm[1] : `cron-${Date.now()}`;
      const recurring = input.recurring !== false;
      jobs[id] = {
        type: 'cron',
        recurring,
        cron: String(input.cron || ''),
        at: recurring ? null : nextFire(input.cron),
        label: shortLabel(input.prompt),
        created: Date.now(),
      };
    } else if (tool === 'CronDelete') {
      const id = String(input.id || '');
      if (id && jobs[id]) delete jobs[id];
    } else if (tool === 'ScheduleWakeup') {
      if (input.stop === true) {
        delete jobs.wakeup;
      } else if (typeof input.delaySeconds === 'number') {
        // 同 session 只會有一個待命 wakeup，後設覆蓋前設
        jobs.wakeup = {
          type: 'wakeup',
          recurring: false,
          at: Date.now() + Math.max(60, Math.min(3600, input.delaySeconds)) * 1000,
          label: shortLabel(input.reason),
          created: Date.now(),
        };
      }
    } else {
      return;
    }
    atomicWrite(file, JSON.stringify(jobs));
  } catch (e) {}
});
