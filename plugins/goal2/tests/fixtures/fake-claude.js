#!/usr/bin/env node
// 測試用假引擎（GOAL2_CLAUDE_BIN 指到這裡）：印 init → 睡 FAKE_SLEEP_MS → 印收尾與 result，exit 0。
// 不讀參數、不碰網路；session_id 固定字串，transcript 找不到 → runner 判 unverified（測的是啟動／等待／回報，不是判定）。
'use strict';
const ms = Number(process.env.FAKE_SLEEP_MS || 1000);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: 'fake-engine-session', timestamp: new Date().toISOString() });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Goal set: fake' }] }, timestamp: new Date().toISOString() });
setTimeout(() => {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: '做完了（假引擎）' }] }, timestamp: new Date().toISOString() });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: '做完了（假引擎）', total_cost_usd: 0 });
  process.exit(0);
}, ms);
