#!/usr/bin/env node
// PreToolUse（Write|Edit|MultiEdit）：擋直接改 /harness:init 的狀態檔與答案檔。
//
// 接線：本 plugin 的 hooks/hooks.json。不複製進實例。
//
// 為什麼：Phase 順序與「訪談答案有沒有寫齊」由 skills/init/scripts/init-flow.js 檢查。
// 模型直接改 .init-state.json（把 phase 改大、把 status 改成 done）或手寫 init-answers.json，
// 等於跳過那些檢查。這兩個檔只准經 init-flow.js 改（它會驗格式、補日期、記 history）。
//
// 定位：防手滑，不是沙箱——用 Bash 寫檔擋不到（PreToolUse 只看到 Write／Edit 的 file_path），這是已知極限，
// 只寫在這裡給維護者看，不寫進擋下訊息。
// fail-open：解析不了 payload 一律放行。
'use strict';
const fs = require('fs');
const path = require('path');

const GUARDED = /(^|[\\/])\.claude[\\/]harness[\\/](\.init-state\.json|init-answers\.json)$/i;

try {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if (!/^(Write|Edit|MultiEdit)$/.test(input.tool_name || '')) process.exit(0);
  const ti = input.tool_input || {};
  const fp = String(ti.file_path || ti.path || '');
  if (!fp) process.exit(0);
  const abs = path.resolve(input.cwd || process.cwd(), fp);
  if (!GUARDED.test(abs)) process.exit(0);
  // 答案檔：只有 init 還在進行中才擋（之後 init-flow 不再收答案，修訂只能直接改檔）。狀態檔在 init 的目標目錄，
  // 落點可能是它底下的子目錄，所以從答案檔所在專案往上找；找不到狀態檔（例如隊友 clone 下來，狀態檔不進版控）也放行。狀態檔本身照擋
  if (/init-answers\.json$/i.test(abs)) {
    let running = false;
    let d = path.dirname(path.dirname(path.dirname(abs)));
    for (let i = 0; i < 40; i++) {
      const sp = path.join(d, '.claude', 'harness', '.init-state.json');
      if (fs.existsSync(sp)) {
        try { const st = JSON.parse(fs.readFileSync(sp, 'utf8')); running = !!st && st.status === 'running'; } catch { running = false; }
        break;
      }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    if (!running) process.exit(0);
  }
  const flow = path.join(__dirname, '..', 'skills', 'init', 'scripts', 'init-flow.js');
  const which = /init-answers\.json$/i.test(abs)
    ? `訪談答案要用 node "${flow}" answer <目標> <題號> --file <答案 JSON 檔> 寫入（形狀見 init 的 phase-3-interview.md），形狀目錄去向用 catalog、誤判豁免用 waive。`
    : `Phase 前進用 node "${flow}" advance <目標> <N>，收尾用 done，中止用 abort；先跑 status 看下一步缺什麼。`;
  const reason = `[harness init] ${path.basename(abs)} 只能經 init-flow.js 改，不能直接寫——它會檢查前一個 Phase 的出關條件、驗答案格式、留紀錄。${which}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
} catch (e) {
  process.stderr.write(`[init-state-guard] ERROR: ${e && e.message}（放行）\n`);
  process.exit(0);
}
