#!/usr/bin/env node
// UserPromptSubmit / SessionStart hook：這個對話先前起的 goal2 run，在沒有人等的時候結束了（對話被關掉、等待被殺、
// 看板也沒開）——在你下次於這個對話打字（或重新打開它）時，把「先回報它」塞給 Claude。
//
// 只回報一次：和 --wait、看板搶同一個 reported.json（lib/engine.js claimReport）。有新鮮等待心跳的 run 不碰。
// fail-open：任何錯誤都安靜結束、不擋你打字。
'use strict';
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; if (raw.length > 4 * 1024 * 1024) raw = raw.slice(-4 * 1024 * 1024); });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const sid = input.session_id;
    const event = input.hook_event_name || 'UserPromptSubmit';
    if (!sid) return;
    const { pendingReports, claimReport, reportMessage } = require(path.join(__dirname, '..', 'lib', 'engine.js'));
    const mine = pendingReports({ sessionId: sid }).slice(0, 3);
    const texts = [];
    for (const p of mine) { if (claimReport(p.runDir, `hook:${sid}`).ok) texts.push(reportMessage(p)); }
    if (!texts.length) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: texts.join('\n\n') } }));
  } catch (_) { /* fail-open */ }
});
