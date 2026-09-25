#!/usr/bin/env node
/**
 * PostCompact hook — 把壓縮摘要和壓縮前快照存成一對，並記下「快照裡有、摘要沒提到」的項目。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 與 compact-snapshot.js 一組；接線（目標專案 .claude/settings.json）：
 *   "PostCompact": [{ "matcher": "", "hooks": [{ "type": "command",
 *     "command": "node \"<專案絕對路徑>/.claude/hooks/compact-summary-log.js\"", "timeout": 15 }] }]
 *
 * PostCompact 不能影響壓縮結果、也不能注入 context（官方規格），只做紀錄。
 * 紀錄用途：評估壓縮到底丟了什麼、交接信有沒有補回來（例如調整自動壓縮門檻前後的比較），
 * 流水帳在 <session 資料夾>/compact-snapshots/compact-log.jsonl。
 */
'use strict';
const fs = require('fs');
const path = require('path');

if (process.env.COMPACT_HANDOFF_CHILD) process.exit(0);
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!input || !input.transcript_path || !input.session_id) process.exit(0);
  const dir = path.join(path.dirname(input.transcript_path), input.session_id, 'compact-snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const summary = String(input.compact_summary || '');
  let stamp = null, snap = null;
  try {
    stamp = fs.readFileSync(path.join(dir, 'latest.txt'), 'utf8').trim();
    snap = JSON.parse(fs.readFileSync(path.join(dir, stamp + '.json'), 'utf8'));
  } catch {}
  const name = stamp || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  fs.writeFileSync(path.join(dir, name + '.summary.md'), summary);

  // 比對：快照項目在摘要中是否被提到（agent 以 id 或說明比對；檔案以檔名比對）
  const missing = { agents: [], docs: [], edits: [], skills: [] };
  if (snap) {
    for (const s of snap.skills || []) if (!summary.includes(s)) missing.skills.push(s);
    for (const a of snap.running || []) if (!summary.includes(a.id) && !summary.includes(a.desc)) missing.agents.push(a.desc);
    for (const f of snap.docs || []) if (!summary.includes(path.basename(f))) missing.docs.push(path.basename(f));
    for (const f of snap.edits || []) if (!summary.includes(path.basename(f))) missing.edits.push(path.basename(f));
  }
  // 同一份快照對交接信再比一次：上面量的是內建摘要漏了什麼，這裡量交接信有沒有補上
  let missingInHandoff = null;
  if (snap) {
    let letter = null;
    try { letter = fs.readFileSync(path.join(dir, snap.stamp + '.handoff.md'), 'utf8'); } catch {}
    if (letter) {
      missingInHandoff = { agents: [], docs: [], edits: [], skills: [] };
      for (const s of snap.skills || []) if (!letter.includes(s)) missingInHandoff.skills.push(s);
      for (const a of snap.running || []) if (!letter.includes(a.id) && !letter.includes(a.desc)) missingInHandoff.agents.push(a.desc);
      for (const f of snap.docs || []) if (!letter.includes(path.basename(f))) missingInHandoff.docs.push(path.basename(f));
      for (const f of snap.edits || []) if (!letter.includes(path.basename(f))) missingInHandoff.edits.push(path.basename(f));
    }
  }
  const row = {
    at: new Date().toISOString(), session: input.session_id, trigger: input.trigger || null,
    snapshot: stamp, summaryChars: summary.length,
    counts: snap ? { agents: (snap.running || []).length, docs: (snap.docs || []).length, edits: (snap.edits || []).length, skills: (snap.skills || []).length } : null,
    missing,
    missingInHandoff,
    handoff: snap ? snap.handoff || null : null,
    // 壓縮後第一個回合是否直接接續、不需使用者重講背景；無法在此自動判定，評估時人工補記
    resumedWithoutReexplain: null,
  };
  fs.appendFileSync(path.join(dir, 'compact-log.jsonl'), JSON.stringify(row) + '\n');
} catch (e) {
  try { process.stderr.write(`[compact-summary-log] 紀錄失敗：${e.message}\n`); } catch {}
}
process.exit(0);
