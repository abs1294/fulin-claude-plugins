#!/usr/bin/env node
/**
 * PreCompact hook — 壓縮前把「摘要最容易漏掉、而且壓縮後不會自動回來」的狀態存成快照。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 本檔與 compact-handoff.js（模組）、compact-reinject.js、compact-summary-log.js、resume-stale-reminder.js 是一組，一起裝。
 * 接線（目標專案 .claude/settings.json；timeout 要大於 compact-handoff.js 的 CHILD_TIMEOUT）：
 *   "PreCompact": [{ "matcher": "", "hooks": [{ "type": "command",
 *     "command": "node \"<專案絕對路徑>/.claude/hooks/compact-snapshot.js\"", "timeout": 240, "statusMessage": "壓縮前存快照、寫交接信" }] }]
 *
 * 壓縮後會自動回來的：系統提示、CLAUDE.md、memory、最近改過的 5 個檔、用過的 skill。
 * 不會回來、摘要又常漏的：還在跑的背景 agent、只讀過沒改過的任務規範文件、
 * 使用者最後幾則指示的原文、超過 5 個以外的改動檔。本檔只抓這四類。
 * 另由 compact-handoff.js 讓模型寫一份交接信（未完成的完整保留、已完成只留結果），
 * 注入時交接信優先；它失敗時才退回這份 regex 快照。
 * 「使用者已裁決」（AskUserQuestion 的題目與答案）與「任務清單最後狀態」也由本檔從紀錄抽出，
 * 交接信有沒有寫成都由 compact-reinject.js 原樣附上：這兩樣是事實，程式抽比讓模型自己記進度可靠，也不經寫信模型改寫。
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
const DOC_RE = /[\\/]\.claude[\\/]harness[\\/]|[\\/]skills[\\/][^\\/]+[\\/](SKILL|references)|(GLOSSARY|CONTEXT|FLOWS|PROJECT)\.md$/i;
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

// compact-handoff.js 壞掉時快照仍要寫得出來（它正是交接信失敗時的退路），退回只擋系統標籤的最小判準
let isRealUserPrompt = t => !!t && !!t.trim() && !t.trim().startsWith('<');
// 裁決時間：沿用交接信模組的時區設定；模組壞掉時退回 UTC
let stampOf = ts => { const d = new Date(ts); return isNaN(d) ? '' : d.toISOString().slice(5, 16).replace('T', ' '); };
let tzLabel = 'UTC';
try {
  const h = require('./compact-handoff.js');
  isRealUserPrompt = h.isHumanPrompt;
  if (h.localStamp) { stampOf = h.localStamp; tzLabel = h.TZ_LABEL || tzLabel; }
} catch {}

// ── 使用者已裁決 ──
// 格式依真實 transcript 確認（本機 235 份紀錄、2,819 筆 AskUserQuestion 回傳）：
//   tool_use.input.questions[]＝{ question, header, options[], multiSelect }；
//   回傳那一行的 toolUseResult＝{ questions, answers: {題目原文: 答案原文}, annotations: {題目原文: { notes?, preview? }} }。
//   多選的答案是以「, 」串起的一個字串；只寫附註沒選選項時答案是「(notes only)」，附註在 annotations[題目].notes。
// 不算裁決的回傳：is_error（使用者按拒絕、hook 擋下、參數錯）、60 秒沒回應（answers 是空物件，內文 No response after 60s）。
// 範圍是整份紀錄，不比照關鍵值清單在上一次壓縮摘要處歸零（buildDigest 的 keys.length = 0）：
// - 關鍵值是會被新值取代的狀態（新的測試數字蓋掉舊的），壓縮前的舊值丟了無妨；裁決是持續有效的約束，丟了接手者會重問或做反。
// - 上一次壓縮前的裁決雖已由上一次注入原樣帶過，但那段注入在下一次壓縮時又會被摘要模型改寫或略掉；
//   若只收上次壓縮之後的，連續壓縮兩次後最早的裁決就沒有任何原樣副本。
// - transcript 是 append-only，壓縮後前段原文仍在檔裡（實測 3 份壓縮過的紀錄，摘要行之前都還留著 AskUserQuestion 原行），
//   掃整份即可，不必依賴上一份快照檔（快照會被 prune，交接信也可能失敗）。
// 上一次壓縮前的筆數標 before，注入時註明，讓接手者知道它比較舊、可能已被後來的對話推翻。
const DECISION_KEEP = 50;   // 快照檔保留的筆數（較新的優先）；注入時另有字數上限，見 compact-reinject.js
const ANSWERED_RE = /^(?:The user answered:|Your questions have been answered:)\s*/;
const ANSWER_TAIL_RE = /\.\s*(?:Read the answers carefully|You can now continue)[\s\S]*$/;
function decisionsOf(input, o, c) {
  if (c.is_error) return [];
  const qs = Array.isArray(input && input.questions) ? input.questions : [];
  const at = stampOf(o.timestamp);
  const t = o.toolUseResult;
  if (t && typeof t === 'object' && t.answers && typeof t.answers === 'object') {
    const ann = t.annotations || {};
    // 依題目順序配對；回傳裡有、題目清單裡沒有的題目（理論上不會發生）也收，不漏
    const order = qs.map(q => q && q.question).filter(Boolean);
    for (const k of Object.keys(t.answers)) if (!order.includes(k)) order.push(k);
    for (const k of Object.keys(ann)) if (!order.includes(k)) order.push(k);
    const out = [];
    for (const q of order) {
      const a = t.answers[q];
      const notes = ann[q] && ann[q].notes;
      if (a === undefined && !notes) continue;   // 沒回答的題（逾時、只答了其中幾題）不算裁決
      out.push({ at, q, a: a === undefined ? '' : String(a), notes: notes ? String(notes) : '' });
    }
    return out;
  }
  // 沒有 toolUseResult 的舊格式：無法逐題拆，整段答覆原文當一筆（題目合併），寧可粗也不漏
  const body = textOf(c.content);
  if (!ANSWERED_RE.test(body)) return [];
  return [{ at, q: qs.map(q => q && q.question).filter(Boolean).join(' ／ '), a: body.replace(ANSWERED_RE, '').replace(ANSWER_TAIL_RE, '').trim(), notes: '' }];
}

// ── 任務清單最後狀態 ──
// 實際工具名與格式依真實 transcript 確認（本機 78 份紀錄用過）：TaskCreate／TaskUpdate／TaskList；
//   2026-10-11 掃描：Task 系列 Claude Code 2.1.268 之後零使用，保留以防工具回來或別的版本仍提供。
//   TaskCreate 回傳 toolUseResult.task＝{ id, subject }（內文 Task #N created successfully: 標題）；
//   TaskUpdate input＝{ taskId, status?, subject?, … }，status 有 pending／in_progress／completed／deleted，回傳 toolUseResult.success；
//   TaskList 回傳 toolUseResult.tasks＝[{ id, subject, status, blockedBy }]。
// TodoWrite（input.todos＝[{ content, status, activeForm }]，每次整份覆蓋）至 2026-10-11 掃描本機紀錄仍一筆都沒有，照官方工具 schema 寫，未經真實紀錄驗證；
//   只換掉自己那份（key 以 todo 開頭），不動 Task 系列建的項目。
// 範圍是整份紀錄（清單跨壓縮延續，要的是最後狀態），以「重播」重建：
// - TaskCreate 拿到已存在的 id＝清單被重置過（實測 50 次，多在隔天續跑時；當時常有未完成項），丟掉舊的 Task 項目重新累積。
// - TaskList 的回傳是當下實際清單，見到就把 Task 項目整份換掉再往下重播。兩者都只換 Task 項目，TodoWrite 的 todo* 留著（與 TodoWrite 只換 todo* 對稱）。實測重播與 TaskList 仍有約兩成對不上
//   （112 次比對 25 次不同，多為跨日續跑或別的 agent 動過清單），所以注入時註明「依紀錄重建」，要接續前先跑 TaskList。
const TASK_KEEP = 60;
function textOf(content) {
  return typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
}
// 回傳這次呼叫有沒有套用到清單（失敗、格式認不得、清單外的 id 回 false），呼叫端據此決定 tasksSource
function applyTask(tasks, u, o, c) {
  if (c.is_error) return false;
  const clearTaskItems = () => { for (const k of [...tasks.keys()]) if (!k.startsWith('todo')) tasks.delete(k); };
  const t = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : null;
  const body = textOf(c.content);
  const i = u.input || {};
  if (u.name === 'TodoWrite') {
    if (!Array.isArray(i.todos)) return false;
    for (const k of [...tasks.keys()]) if (k.startsWith('todo')) tasks.delete(k);
    i.todos.forEach((td, n) => { if (td && td.content) tasks.set('todo' + n, { subject: String(td.content), status: String(td.status || '') }); });
    return true;
  }
  if (u.name === 'TaskCreate') {
    // 沒有 toolUseResult 時 t 是 null，id 會是 null 不是 undefined，一律用 == null 判
    let id = t && t.task ? t.task.id : null, subject = t && t.task ? t.task.subject : null;
    if (id == null) { const m = body.match(/^Task #(\S+) created successfully: ([\s\S]*)$/); if (m) { id = m[1]; subject = m[2]; } }
    if (id == null) return false;
    id = String(id);
    if (tasks.has(id)) clearTaskItems();
    tasks.set(id, { subject: String(subject || i.subject || ''), status: 'pending' });
    return true;
  }
  if (u.name === 'TaskUpdate') {
    if (t ? t.success !== true : !/^Updated task #/.test(body)) return false;
    const id = String(i.taskId != null ? i.taskId : (t && t.taskId));
    if (i.status === 'deleted') { tasks.delete(id); return true; }
    const cur = tasks.get(id);
    if (!cur) return false;   // 清單外的 id（重置前的、別的 agent 建的）沒有標題可列，不憑空造一項
    if (i.status) cur.status = String(i.status);
    if (i.subject) cur.subject = String(i.subject);
    return true;
  }
  if (u.name === 'TaskList') {
    let list = t && Array.isArray(t.tasks) ? t.tasks : null;
    if (!list) {
      if (body.trim() === 'No tasks found') list = [];
      else {
        const rows = [...body.matchAll(/^#(\S+) \[(\w+)\] (.*)$/gm)];
        if (rows.length) list = rows.map(m => ({ id: m[1], status: m[2], subject: m[3] }));
      }
    }
    if (!list) return false;
    clearTaskItems();
    for (const x of list) if (x && x.id != null) tasks.set(String(x.id), { subject: String(x.subject || ''), status: String(x.status || '') });
    return true;
  }
  return false;
}
const TASK_TOOLS = /^(TodoWrite|TaskCreate|TaskUpdate|TaskList)$/;

function scan(transcriptPath) {
  const launched = new Map();   // agentId 或背景指令 ID -> description
  const toolUseDesc = new Map(); // tool_use id -> description（Agent 與背景 Bash／PowerShell）
  const resulted = new Set();    // 已有 tool_result 的 tool_use id
  const finished = new Set();
  const reads = [], edits = [], prompts = [], skills = [];
  const asks = new Map();        // AskUserQuestion 的 tool_use id -> input
  const taskUses = new Map();    // 任務清單工具的 tool_use id -> tool_use
  const tasks = new Map();       // 任務 id -> { subject, status }，Map 保留建立順序
  let tasksSource = '';          // 最後一次成功的任務清單工具：TodoWrite 或 Task（系列），決定注入時要 AI 怎麼對回清單
  const decisions = [];
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    // 完成通知可能落在 user 訊息、queue-operation 或 attachment(queued_command) 任一種紀錄，一律從原始行抓
    if (line.includes('task-notification')) {
      for (const mm of line.matchAll(/<task-id>([a-z0-9]+)<\/task-id>/g)) finished.add(mm[1]);
    }
    // 同一行可能併了好幾則 teammate 訊息，只有自己那一則是 idle 的才算完成，只回報進度的還在忙
    if (line.includes('idle_notification')) {
      for (const mm of line.matchAll(/<teammate-message teammate_id=\\"([\w.-]+)\\"[^>]*>([\s\S]*?)<\/teammate-message>/g)) {
        if (mm[2].includes('idle_notification')) finished.add(mm[1]);
      }
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
    // 先前收的裁決都在這次摘要之前（注入時標「上次壓縮前」）；之後收到的才是上次壓縮之後的
    if (o.type === 'user' && o.isCompactSummary) for (const d of decisions) d.before = true;
    // 裁決與任務清單只認主對話；子 agent 的提問與清單不是使用者對本 session 的裁決
    const main = !o.isSidechain;
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (!c || c.type !== 'tool_use' || !c.input) continue;
        if (main && c.name === 'AskUserQuestion') asks.set(c.id, c.input);
        if (main && TASK_TOOLS.test(c.name)) taskUses.set(c.id, c);
        if (c.name === 'Agent') toolUseDesc.set(c.id, c.input.description || c.input.subagent_type || '(agent)');
        // 背景指令（例如 Codex 審查）也會在壓縮後才回報完成，只認 Agent 時快照會寫成沒有東西在跑
        if ((c.name === 'Bash' || c.name === 'PowerShell') && c.input.run_in_background)
          toolUseDesc.set(c.id, c.input.description || String(c.input.command || '').slice(0, 80));
        // idle 過的具名 agent 被 SendMessage 叫醒後又在做事，要等下一次 idle 才算完成
        if (c.name === 'SendMessage' && launched.has(c.input.to)) finished.delete(c.input.to);
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
          if (c && c.type === 'tool_result' && asks.has(c.tool_use_id)) decisions.push(...decisionsOf(asks.get(c.tool_use_id), o, c));
          if (c && c.type === 'tool_result' && taskUses.has(c.tool_use_id)) {
            const u = taskUses.get(c.tool_use_id);
            if (applyTask(tasks, u, o, c)) tasksSource = u.name === 'TodoWrite' ? 'TodoWrite' : 'Task';
          }
          if (c && c.type === 'tool_result' && toolUseDesc.has(c.tool_use_id)) {
            resulted.add(c.tool_use_id);
            const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
            const id = (txt.match(/agentId: ([a-z0-9]+)/) || [])[1];
            if (id && /launched successfully|working in the background/i.test(txt)) launched.set(id, toolUseDesc.get(c.tool_use_id));
            const bg = (txt.match(/running in background with ID: ([a-z0-9]+)/i) || [])[1];
            if (bg) launched.set(bg, toolUseDesc.get(c.tool_use_id));
            // 具名 agent 回的是「Spawned successfully. agent_id: 名稱@session-…」，完成時不發 task-notification，
            // 改以 idle_notification 判完成；同名重派時先清掉舊的完成標記
            const named = (txt.match(/agent_id: ([\w.-]+)@/) || [])[1];
            if (named && /Spawned successfully/i.test(txt)) { launched.set(named, toolUseDesc.get(c.tool_use_id)); finished.delete(named); }
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
  // 派出後還沒寫回 tool_result 就被壓縮打斷（來源實例曾在派出 reviewer 後 0.1 秒就被快照），連 ID 都還沒有
  for (const [tid, d] of toolUseDesc) if (!resulted.has(tid)) running.push({ id: tid, desc: d + '（剛派出，尚未回傳 ID）' });
  // 和其他清單一樣設上限（保留最新的），清單長到會擠掉交接信的注入額度
  running.splice(0, Math.max(0, running.length - 10));
  return {
    running,
    docs: uniqLast(reads, 12),
    edits: uniqLast(edits, 20),
    skills: uniqLast(skills, 10),
    prompts: prompts.slice(-3).map(p => (p.length > 600 ? p.slice(0, 600) + '…' : p)),
    // 原文不截斷（注入端另有字數上限）；只限筆數，保留較新的
    decisions: decisions.slice(-DECISION_KEEP),
    decisionsTz: tzLabel,
    // 沒用過任務清單工具、或最後全部刪光＝空陣列，注入端不輸出
    tasks: [...tasks].slice(-TASK_KEEP).map(([id, t]) => ({ id, subject: t.subject, status: t.status })),
    tasksSource,
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
