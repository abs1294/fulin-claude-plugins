#!/usr/bin/env node
/**
 * PreCompact hook — 壓縮前把「摘要最容易漏掉、而且壓縮後不會自動回來」的狀態存成快照。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 本檔與 compact-handoff.js、compact-reinject.js、compact-summary-log.js 是一組，四支一起裝。
 * 接線（目標專案 .claude/settings.json；timeout 要大於 compact-handoff.js 的 CHILD_TIMEOUT）：
 *   "PreCompact": [{ "matcher": "", "hooks": [{ "type": "command",
 *     "command": "node \"<專案絕對路徑>/.claude/hooks/compact-snapshot.js\"", "timeout": 240 }] }]
 *
 * 壓縮後會自動回來的：系統提示、CLAUDE.md、memory、最近改過的 5 個檔、用過的 skill。
 * 不會回來、摘要又常漏的：還在跑的背景 agent、只讀過沒改過的任務規範文件、
 * 使用者最後幾則指示的原文、超過 5 個以外的改動檔。本檔只抓這四類。
 * 另由 compact-handoff.js 讓模型寫一份交接信（未完成的完整保留、已完成只留結果），
 * 注入時交接信優先；它失敗時才退回這份 regex 快照。
 *
 * 快照放在 session 資料夾（與 subagents/、tool-results/ 同層），不進 workspace 的 .claude/。
 * 由 compact-reinject.js（SessionStart matcher=compact）讀回注入，
 * compact-summary-log.js（PostCompact）拿來和摘要比對。
 *
 * 環境變數：COMPACT_HANDOFF_OFF=1 只存快照、不寫交接信（沒有 claude CLI 或不想付每次壓縮的費用時）。
 * 一律 exit 0、不擋壓縮：自動壓縮若是撞到 context 上限才觸發，擋下會讓當次請求直接失敗。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 每個 session 保留的快照數
const KEEP = 20;
// 「任務規範文件」：只讀過、壓縮後不會自動重讀的文件。預設涵蓋 harness 制度層、skill 本文與
// 三份知識容器；專案另有規格或測試知識目錄（例如 openspec/、docs/specs/）就加進來。
// CLAUDE.md 不列：壓縮後會自動重新載入。
const DOC_RE = /[\\/]\.claude[\\/]harness[\\/]|[\\/]skills[\\/][^\\/]+[\\/](SKILL|references)|(CONTEXT|FLOWS|PROJECT)\.md$/i;
// 不算「改過的檔」的路徑：工具暫存與依賴目錄
const NOISE_RE = /[\\/](tool-results|scratchpad|subagents|node_modules)[\\/]/i;
// ─────────────────────────────────────────────────────────────────────────────

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

function snapshotDir(input) {
  const base = path.join(path.dirname(input.transcript_path), input.session_id, 'compact-snapshots');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (content.some(c => c && c.type === 'tool_result')) return '';
  return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
}

function isRealUserPrompt(t) {
  if (!t || !t.trim()) return false;
  const s = t.trimStart();
  return !(s.startsWith('<') || s.startsWith('Another Claude session') || s.includes('<task-notification>')
    || s.includes('[SYSTEM NOTIFICATION') || s.startsWith('Base directory for this skill'));
}

function scan(transcriptPath) {
  const launched = new Map();   // agentId -> description
  const toolUseDesc = new Map(); // tool_use id -> description（Agent）
  const finished = new Set();
  const reads = [], edits = [], prompts = [], skills = [];
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    // 完成通知可能落在 user 訊息、queue-operation 或 attachment(queued_command) 任一種紀錄，一律從原始行抓
    if (line.includes('task-notification')) {
      for (const mm of line.matchAll(/<task-id>([a-z0-9]+)<\/task-id>/g)) finished.add(mm[1]);
    }
    let o; try { o = JSON.parse(line); } catch { continue; }
    // 使用者在助理工作中途送出的訊息記成 attachment(queued_command)，沒有 message 欄位
    const qa = o.attachment;
    if (o.type === 'attachment' && qa && qa.type === 'queued_command' && qa.origin && qa.origin.kind === 'human' && qa.prompt) {
      const t = String(qa.prompt).trim();
      if (isRealUserPrompt(t)) prompts.push(t);
      continue;
    }
    const m = o.message; if (!m) continue;
    const content = m.content;
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (!c || c.type !== 'tool_use' || !c.input) continue;
        if (c.name === 'Agent') toolUseDesc.set(c.id, c.input.description || c.input.subagent_type || '(agent)');
        if (c.name === 'Skill' && c.input.skill) skills.push(c.input.skill);
        const fp = c.input.file_path || c.input.notebook_path;
        if (!fp || NOISE_RE.test(fp)) continue;
        if (c.name === 'Read' && DOC_RE.test(fp)) reads.push(fp);
        if (c.name === 'Edit' || c.name === 'Write' || c.name === 'NotebookEdit') edits.push(fp);
      }
    }
    if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_result' && toolUseDesc.has(c.tool_use_id)) {
            const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
            const id = (txt.match(/agentId: ([a-z0-9]+)/) || [])[1];
            if (id && /launched successfully|working in the background/i.test(txt)) launched.set(id, toolUseDesc.get(c.tool_use_id));
          }
        }
      }
      // 用 /指令 叫起的 skill 不經 Skill 工具，只留下一則 isMeta 的展開訊息
      const sk = userText(content).match(/^Base directory for this skill:\s*(\S+)/m);
      if (sk) skills.push(path.basename(sk[1]));
      if (!o.isMeta && !o.isCompactSummary) {
        const t = userText(content);
        if (isRealUserPrompt(t)) prompts.push(t.trim());
      }
    }
  }
  const uniqLast = (arr, n) => [...new Set(arr.slice().reverse())].slice(0, n);
  const running = [...launched].filter(([id]) => !finished.has(id)).map(([id, d]) => ({ id, desc: d }));
  return {
    running,
    docs: uniqLast(reads, 12),
    edits: uniqLast(edits, 20),
    skills: uniqLast(skills, 10),
    prompts: prompts.slice(-3).map(p => (p.length > 600 ? p.slice(0, 600) + '…' : p)),
  };
}

function prune(dir) {
  const files = fs.readdirSync(dir).filter(f => /^\d{8}T\d{6}.*\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    for (const g of [f, f.replace(/\.json$/, '.summary.md'), f.replace(/\.json$/, '.handoff.md')]) { try { fs.unlinkSync(path.join(dir, g)); } catch {} }
  }
}

if (process.env.COMPACT_HANDOFF_CHILD) process.exit(0);   // 交接信子 session 不再觸發
try {
  const input = readStdin();
  if (!input || !input.transcript_path || !input.session_id) process.exit(0);
  const snap = scan(input.transcript_path);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const dir = snapshotDir(input);
  // 交接信：模型讀對話骨架寫成；失敗或關閉時只留上面的 regex 快照
  let handoff = null;
  if (process.env.COMPACT_HANDOFF_OFF) {
    handoff = { ok: false, error: 'disabled (COMPACT_HANDOFF_OFF)' };
  } else {
    try {
      const h = require('./compact-handoff.js').generateHandoff(input.transcript_path, input.custom_instructions || '');
      if (h.ok) fs.writeFileSync(path.join(dir, stamp + '.handoff.md'), h.handoff);
      handoff = { ok: h.ok, ms: h.ms, cost: h.cost || null, digestChars: h.digestChars, chars: h.ok ? h.handoff.length : 0,
        asks: h.asks, asksOpen: h.asksOpen, markFound: h.markFound,
        keys: h.keys, keysClaimed: h.keysClaimed, keysMangled: h.keysMangled, keysMissing: h.keysMissing, error: h.error || null };
    } catch (e) { handoff = { ok: false, error: e.message }; }
  }
  const record = { stamp, trigger: input.trigger || null, cwd: input.cwd || null,
    inputKeys: Object.keys(input), customInstructions: input.custom_instructions || null, handoff, ...snap };
  const out = path.join(dir, stamp + '.json');
  fs.writeFileSync(out + '.tmp', JSON.stringify(record, null, 2));
  fs.renameSync(out + '.tmp', out);
  fs.writeFileSync(path.join(dir, 'latest.txt'), stamp);
  prune(dir);
} catch (e) {
  // fail-open：快照失敗不影響壓縮
  try { process.stderr.write(`[compact-snapshot] 快照失敗（不影響壓縮）：${e.message}\n`); } catch {}
}
process.exit(0);
