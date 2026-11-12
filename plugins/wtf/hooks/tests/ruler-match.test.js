#!/usr/bin/env node
/**
 * 「是不是在跑 ruler.js」的判定回歸測試（2026-11-11）——跑法：node hooks/tests/ruler-match.test.js
 *
 * Why：兩支 hook 原本用 \bruler\.js 判斷，「-」「.」也算字界，
 * node equiv-wtf-ruler.js 這類檔名以 -ruler.js 結尾的別支腳本被當成 ruler.js：
 *   - guard-ruler-pasted（Stop）：判成跑了標尺沒貼，整回合 exit 2 擋下（使用者實際被擋兩次）
 *   - guard-no-execute（PreToolUse）：/wtf 生效期間把別支腳本當標尺放行
 * 驗舊版：WTF_HOOKS_DIR=<舊版 hooks 目錄>。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.resolve(process.env.WTF_HOOKS_DIR || path.join(__dirname, '..'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'wtf-ruler-'));
const ENV = Object.assign({}, process.env, { TEMP: W, TMP: W, TMPDIR: W });
let pass = 0, fail = 0;
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  → ' + detail)); };
const runHook = (file, input) => spawnSync(process.execPath, [path.join(DIR, file)], { input: JSON.stringify(input), encoding: 'utf8', env: ENV, timeout: 30000 });

const SEP = String.fromCharCode(92);
const REAL = ['node "C:/x/skills/wtf/ruler.js"', 'node "C:/x/skills/wtf/ruler.js" 180 200', 'node ruler.js', 'node C:' + SEP + 'x' + SEP + 'wtf' + SEP + 'ruler.js 80', 'cd skills/wtf && node ruler.js 80'];
const OTHER = ['node equiv-wtf-ruler.js', 'node "C:/tmp/scratchpad/equiv-wtf-ruler.js" 80', 'node my.ruler.js', 'node C:/x/probe-ruler.js'];

// ── guard-ruler-pasted：跑了沒貼才擋 ──
console.log('guard-ruler-pasted');
function transcript(cmd) {
  const f = path.join(W, 't-' + Math.random().toString(36).slice(2) + '.jsonl');
  const rows = [
    { type: 'user', message: { role: 'user', content: '量一下寬度' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: cmd } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好了' }] } },
  ];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
for (const cmd of REAL) {
  const r = runHook('guard-ruler-pasted.js', { transcript_path: transcript(cmd), stop_hook_active: false, last_assistant_message: '好了' });
  check(r.status === 2, '真的跑 ruler.js 沒貼 → 擋：' + cmd, 'exit ' + r.status);
}
for (const cmd of OTHER) {
  const r = runHook('guard-ruler-pasted.js', { transcript_path: transcript(cmd), stop_hook_active: false, last_assistant_message: '好了' });
  check(r.status === 0, '別支 *ruler.js 腳本 → 放行：' + cmd, 'exit ' + r.status + ' ' + (r.stderr || '').slice(0, 80));
}

// ── guard-no-execute：/wtf 生效期間只放行真的 ruler.js ──
console.log('guard-no-execute');
const SID = 'rulertest';
fs.writeFileSync(path.join(W, 'wtf-active-' + SID + '.json'), JSON.stringify({ at: Date.now(), skill: 'wtf' }));
const pre = (cmd) => runHook('guard-no-execute.js', { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash', tool_input: { command: cmd } });
for (const cmd of REAL.filter((c) => !c.startsWith('cd '))) {
  const r = pre(cmd);
  check(r.status === 0, '真的 ruler.js → 放行：' + cmd, 'exit ' + r.status);
}
for (const cmd of OTHER) {
  const r = pre(cmd);
  check(r.status === 2, '別支 *ruler.js 腳本 → 擋：' + cmd, 'exit ' + r.status);
}

try { fs.rmSync(W, { recursive: true, force: true }); } catch (_) { /* 清不掉不影響 */ }
console.log(pass + ' passed, ' + fail + ' failed' + (process.env.WTF_HOOKS_DIR ? '（' + DIR + '）' : ''));
process.exit(fail ? 1 : 0);
