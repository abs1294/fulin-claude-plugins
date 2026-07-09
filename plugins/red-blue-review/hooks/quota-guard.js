#!/usr/bin/env node
/**
 * quota-guard — PreToolUse(Workflow) 配額保護閘
 *
 * 為什麼存在：紅藍對抗曾把整支艦隊（5 紅攻＋30+ 藍驗）一次灑出去，撞 5h quota 全滅；
 * quota reset 後 resume 又把剩餘艦隊一次灑出去，再撞一次。兩次事故的共通根因不是「平行」，
 * 而是「無界派發＋撞牆不熔斷」——平行可以，但必須分波（bounded waves）且撞牆立即停派。
 *
 * 規則：Workflow script 內用 parallel()/pipeline() 包 agent() 時，必須擇一：
 * (a) 走分波熔斷模式——script 含 `runWaves(`（分波 helper，見 references/quota-throttling.md：
 *     每波併發有上限、任一 agent 因 quota/API 終止回 null 即中止派發）；
 * (b) 使用者豁免——script 首行含 `// quota-user-approved:`（僅限使用者於對話中
 *     看過預算估算並明確同意後可加）。
 * 兩者皆無 → 攔下。解析失敗一律放行（fail-open），不擋非相關流程。
 */
const fs = require('fs');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  let input;
  try { input = JSON.parse(readStdin()); } catch { process.exit(0); }
  if (!input || input.tool_name !== 'Workflow') process.exit(0);

  const ti = input.tool_input || {};
  let script = typeof ti.script === 'string' ? ti.script : '';
  if (!script && typeof ti.scriptPath === 'string') {
    try { script = fs.readFileSync(ti.scriptPath, 'utf8'); } catch { process.exit(0); }
  }
  if (!script) process.exit(0); // 具名 workflow（name）或空腳本：放行

  const hasAgent = /\bagent\s*\(/.test(script);
  const hasFanout = /\bparallel\s*\(/.test(script) || /\bpipeline\s*\(/.test(script);
  const hasWaves = /\brunWaves\s*\(/.test(script);
  const approved = /\/\/\s*quota-user-approved:/.test(script);

  if (hasAgent && hasFanout && !hasWaves && !approved) {
    process.stderr.write(
      '[quota-guard] 此 Workflow 用 parallel()/pipeline() 無界灑出多 agent，已攔下。\n' +
      '歷史事故：整支艦隊一次派出→撞 5h quota 全滅→reset 後 resume 又整隊派出→再撞一次。平行可以，但要分波＋撞牆熔斷。\n' +
      '二擇一後重發：\n' +
      '(a) 改用分波派發 helper `runWaves(items, run, waveSize)`（骨架見 references/quota-throttling.md）：每波併發 ≤ waveSize（預設 6），' +
      '任一 agent 因 quota/API 終止（回 null）立即中止、不派下一波；resume 時已完成的走 cache、從斷點逐波續跑，不會二次全滅。\n' +
      '(b) 例外要整批同時派：先向使用者報告「agent 總數 × 預估每 agent token（讀碼/審查類常見 60k~150k）＝總預算」，' +
      '取得明確同意後於 script 首行加 `// quota-user-approved: <記錄>` 再重發。未經使用者本次對話明示同意，禁止自行加標記。'
    );
    process.exit(2);
  }
  process.exit(0);
}

main();
