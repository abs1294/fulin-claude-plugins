// goal2 共用模組：把「以 /goal 開頭的 prompt」交給 Claude Code 官方 goal 引擎跑到完成。
//
// 為什麼要起子程序：Claude Code 2.1.196 起，排程（CronCreate）fire 的 prompt 被標 skipSlashCommands，
// 開頭的 /goal 只是純文字；跨 session 訊息、skill 內包 /goal 也一樣不執行（官方 scheduled-tasks 文件、
// GitHub #75837 / #91146）。唯一能由 Claude 自己啟動引擎的入口是 `claude -p "/goal …"`
// （官方 goal 文件：「Setting a goal with -p runs the loop to completion in a single invocation」，
// 2026-09-11 於 2.1.268 實測：Goal set → 第一回合故意做一半 → 引擎自動推第二回合 → 達成）。
//
// 兩個坑，本模組都避掉：
//   1. git-bash 會把開頭是 / 的參數轉成 Windows 路徑（/goal → D:/Program Files/Git/goal）。
//      這裡用 child_process.spawn 傳 argv 陣列、不經 shell，並另設 MSYS_NO_PATHCONV=1 保險。
//   2. 在 Claude Code 裡再起 claude 時，環境變數 CLAUDECODE=1 會被子程序繼承；這裡清掉。
//
// 流程：prepareRun() 在 ~/.claude/goal2/runs/<id>/ 放 prompt.txt + meta.json →
//       runEngine() 起 `claude -p <prompt> --output-format stream-json --verbose --permission-mode <m>`，
//       stdout 逐行寫 stream.jsonl，結束時解析出 summary 寫 result.json 並回傳。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { RUNS_DIR } = require('./config.js');

/** plugin 版本（plugin.json）：所有 JSON 輸出都帶，讓主 session 看得出「安裝版 ≠ repo 版」 */
let _pluginVersion = null;
function pluginVersion() {
  if (_pluginVersion) return _pluginVersion;
  try { _pluginVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || 'unknown'; }
  catch (_) { _pluginVersion = 'unknown'; }
  return _pluginVersion;
}
const PLUGIN_ROOT = path.resolve(__dirname, '..');

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function ts14() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 進度帳本規則（放進 anchor.md 與引擎 prompt，兩邊同一份文字）。
 * 為什麼要帳本：長任務跑到上下文滿會自動壓縮，壓縮後 Claude 常忘記做到哪、重做或偏離。
 * anchor.md 走系統提示（每回合重送、壓縮碰不到）保住「目標與任務」；progress.md 保住「做到哪」。
 */
function ledgerRules(runDir) {
  const p = path.join(runDir, 'progress.md');
  return `【進度帳本規則（長任務防漂移，必守）】
- 帳本檔：${p}
- 每完成一個里程碑（一個子任務、一個檔案、一個驗證通過）就更新帳本，格式固定三節：
  ## 已完成（一行一項，附驗證證據或路徑）
  ## 剩餘（一行一項，依順序）
  ## 決策與注意（做過的取捨、別再重做的事、踩過的坑）
- 上下文被壓縮後、或任何時候不確定「目標是什麼／做到哪」，**先讀 anchor.md 與帳本再動手**，不要憑印象猜。
- 帳本只寫事實，不寫鋪陳；已完成的項目不要重做。`;
}

/**
 * 組 anchor.md：放進子程序系統提示的錨。
 * /goal prompt 本身受 4000 字元限制（-p 路徑整段都算），所以任務全文、工作清單、報告格式、帳本規則全都放這裡。
 * @param {{ condition: string, conditionOverflow?: boolean, task: string, workList: string, runDir: string, extra?: string }} o
 *   conditionOverflow 為 true 時，/goal 第一行只放指針句，這裡的「完成條件全文」就是檢查器要對的清單，
 *   並要求引擎第一則回覆先把它貼進對話。
 */
/** 從任務原文抽出「## 項目清單」節（到下一個 ## 為止）；沒有就回 '' */
function extractItems(task) {
  const m = String(task || '').match(/^##\s*項目清單[^\n]*\n([\s\S]*?)(?=\n##\s|\s*$(?![\s\S]))/m);
  return m ? m[1].trim() : '';
}
/** 任務原文是否自足：對話指涉（引擎在另一個 session，看不到本對話）且沒有項目清單 → 不自足 */
const CONVERSATIONAL_REF = /你掌握|你的建議|你建議|剛才|剛剛|上述|上面(提到|說)|前面(提到|說)|如上|這\s*\d+\s*(個|項|條)|那\s*\d+\s*(個|項|條)|按照你|照你說|之前討論|我們討論/;
function selfSufficiency(task) {
  const refs = (String(task || '').match(CONVERSATIONAL_REF) || []);
  const items = extractItems(task);
  return { conversational_refs: refs, has_items: !!items, items_count: items ? items.split('\n').filter((l) => /^\s*(\d+[.)、]|[-*])\s+/.test(l)).length : 0, self_sufficient: refs.length === 0 || !!items };
}

function buildAnchor({ condition, conditionOverflow = false, task, workList, runDir, cwd = '', extra = '' }) {
  const items = extractItems(task);
  const condSection = conditionOverflow
    ? `## 完成條件全文（/goal 第一行因 4000 字元上限只放指針句；引擎據此逐項驗收）
${condition}

條件裡的數量與全稱照字面：「= 0」就是 0、「每一項」就是全部，不得自行放寬成「差不多」「主要的」。條件若含「例外清單內的項目不計」：例外只限真 blocker（需使用者決策／授權、外部系統不可用、缺只有使用者能給的祕密或資料、與任務書規範衝突），每項附證據＋原因，寫進帳本「決策與注意」並在最後回報以「例外清單」逐項列出；「太花時間」「不重要」不是例外。

⚠️ 你的第一則回覆必須先把上面「完成條件全文」逐項原文貼出，再開始做事——檢查器要在對話裡看得到它。`
    : `## 完成條件（引擎據此驗收；達成才准停）
${condition}

條件裡的數量與全稱照字面：「= 0」就是 0、「每一項」就是全部，不得自行放寬成「差不多」「主要的」。條件若含「例外清單內的項目不計」：例外只限真 blocker（需使用者決策／授權、外部系統不可用、缺只有使用者能給的祕密或資料、與任務書規範衝突），每項附證據＋原因，寫進帳本「決策與注意」並在最後回報以「例外清單」逐項列出；「太花時間」「不重要」不是例外。`;
  // <!-- goal2:sec=… --> 是給 hooks/compact-anchor.js 切節用的標記（HTML 註解，對引擎是雜訊但無害）；任務書或條件裡自帶的「## 」標題不會被誤當節邊界
  return `# goal2 錨定（本區塊在系統提示中，每回合重送、上下文壓縮也不會消失）

<!-- goal2:sec=cwd -->
## 工作目錄
${cwd || '（未指定；以子程序啟動時的 cwd 為準）'}
所有相對路徑以此為準；不要 cd 到別的專案。

<!-- goal2:sec=condition -->
${condSection}

${items ? `<!-- goal2:sec=items -->\n## 項目清單（完成條件對著這份清單算；每一項都要處理到，例外照條件裡的例外條款）\n${items}\n\n` : ''}<!-- goal2:sec=task -->
## 任務全文
${task}

<!-- goal2:sec=worklist -->
## 工作清單（依序）
${workList}
${extra ? `\n<!-- goal2:sec=extra -->\n## 補充\n${extra}\n` : ''}
<!-- goal2:sec=ledger -->
${ledgerRules(runDir)}
`;
}

/**
 * 建立 run 目錄並落地 prompt / anchor / 帳本模板。
 * @param {{ skill: 'goal'|'delaylocal', prompt: string, cwd: string, meta?: object, anchor?: string }} o
 * @returns {{ runDir: string, promptPath: string, metaPath: string, anchorPath: string, progressPath: string, runId: string }}
 */
const GOAL_PROMPT_HARD_MAX = 3900; // 與 goal-head.js 的 GOAL_PROMPT_MAX 一致；-p 路徑整段都算進條件
function prepareRun({ skill, prompt, cwd, meta = {}, anchor = null }) {
  if (!prompt.startsWith('/goal ')) throw new Error('prepareRun: prompt 第一行必須以 "/goal " 開頭');
  // 同一棵工作樹已有活著的 run 只當資訊回報（activeRunsInTree），不阻擋——使用者常在同一專案並行多個調整。
  const activeRunsInTree = findActiveRunsIn(cwd).map((r) => ({ runId: r.runId, pid: r.pid, cwd: r.cwd, skill: r.skill }));
  if (prompt.length > GOAL_PROMPT_HARD_MAX) {
    throw new Error(`prepareRun: /goal prompt 共 ${prompt.length} 字，超過 ${GOAL_PROMPT_HARD_MAX}（Claude Code 在 claude -p 下把 /goal 後整段都算進 4000 字元上限）。任務全文與工作清單應放 anchor.md，不要塞進 prompt。`);
  }
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`prepareRun: 工作目錄不存在或不是目錄：${cwd}（請用 --cwd 明確指定專案根目錄）`);
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  // 同秒並發時靠 4 位隨機區分；真撞名就換隨機重試，絕不靜默共用同一個 run 目錄（mkdir 不加 recursive 才會在 EEXIST 時報錯）
  let runId, runDir;
  for (let attempt = 0; ; attempt++) {
    runId = `${ts14()}-${skill}-${Math.random().toString(16).slice(2, 6)}`;
    runDir = path.join(RUNS_DIR, runId);
    try { fs.mkdirSync(runDir); break; }
    catch (e) { if (e.code !== 'EEXIST' || attempt >= 8) throw new Error(`prepareRun: 建立 run 目錄失敗（${e.code}）：${runDir}`); }
  }
  const promptPath = path.join(runDir, 'prompt.txt');
  const metaPath = path.join(runDir, 'meta.json');
  const anchorPath = path.join(runDir, 'anchor.md');
  const progressPath = path.join(runDir, 'progress.md');
  // prompt 內的 <RUN_DIR> 佔位換成真實路徑（呼叫端組 prompt 時還不知道 runDir）
  const finalPrompt = prompt.split('<RUN_DIR>').join(runDir);
  fs.writeFileSync(promptPath, finalPrompt, 'utf8');
  if (anchor) fs.writeFileSync(anchorPath, anchor.split('<RUN_DIR>').join(runDir), 'utf8');
  fs.writeFileSync(progressPath, `# 進度帳本（${runId}）\n\n## 已完成\n（尚無）\n\n## 剩餘\n（開工時依任務拆解填入）\n\n## 決策與注意\n（無）\n`, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({ runId, skill, cwd, createdAt: new Date().toISOString(), status: 'prepared', hasAnchor: !!anchor, ...meta }, null, 2) + '\n');
  return { runDir, promptPath, metaPath, anchorPath, progressPath, runId, activeRunsInTree };
}

/** 讀 meta.json；另一個程序正在原子替換時可能瞬間讀到空／半截，重試一次再放棄 */
function readMeta(runDir) {
  const p = path.join(runDir, 'meta.json');
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { if (attempt >= 2) throw new Error(`meta.json 讀取失敗（${e.code || e.message}）：${p}`); sleepMs(60); }
  }
}
/** 原子寫 meta.json（先寫 tmp 再 rename）：多 session 同時 --status 不會讀到半截 */
function writeMeta(runDir, meta) {
  const p = path.join(runDir, 'meta.json');
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n');
  try { fs.renameSync(tmp, p); }
  catch (e) {
    // Windows 上目標被別的程序短暫鎖住時 rename 會 EPERM；退一步直接覆寫（非原子但不丟資料）
    try { fs.writeFileSync(p, JSON.stringify(meta, null, 2) + '\n'); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
}

/**
 * 程序身分：pid 之外再記啟動時間與程式名，避免 pid 被作業系統回收給別的程序後
 * --stop 殺錯樹、--list 誤報活著（Windows 重用 pid 很常見）。拿不到就回 null（舊版 meta、平台不支援）。
 */
function procIdentity(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ($p.StartTime.ToUniversalTime().ToString('o') + '|' + $p.ProcessName)`], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      if (r.status !== 0) return null;
      const [start, name] = String(r.stdout || '').trim().split('|');
      return start && name ? { start: Date.parse(start), name } : null;
    }
    const r = spawnSync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 8000 });
    if (r.status !== 0) return null;
    const line = String(r.stdout || '').trim();
    const m = line.match(/^(.+?\d{4})\s+(\S+)$/);
    return m ? { start: Date.parse(m[1]), name: path.basename(m[2]) } : null;
  } catch (_) { return null; }
}

/**
 * 判活（給 meta 而不是裸 pid）：
 *   alive   pid 在、且啟動時間與程式名對得上（或 meta 沒記身分：舊版 run，只能信 pid）
 *   stale   pid 在但身分對不上 → pid 已被別的程序重用，不是我們的引擎
 *   dead    pid 不在
 *   unknown 探測被拒（EPERM）——不當活著，也不殺
 */
function aliveState(meta) {
  const pid = meta && meta.pid;
  if (!pid) return 'dead';
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM' ? 'unknown' : 'dead'; }
  const id = procIdentity(pid);
  if (!meta.pidStart) {
    // 0.4.0 起啟動時會記身分；啟動當下沒抓到（PowerShell 慢／不在 PATH）就每次判活時重探：
    // 程式名像 claude/node 且啟動時間落在本 run startedAt 之後 2 分鐘內 → 認定是我們的引擎；抓不到身分 → unknown；舊版 meta（無 pluginVersion）退回只信 pid
    if (!meta.pluginVersion) return 'alive';
    if (!id) return 'unknown';
    const t0 = Date.parse(meta.startedAt || meta.createdAt || 0);
    const nameOk = /claude|node/i.test(id.name);
    const timeOk = Number.isFinite(t0) && id.start >= t0 - 5000 && id.start <= t0 + 120000;
    return nameOk && timeOk ? 'alive' : 'stale';
  }
  if (!id) return 'unknown';
  const sameStart = Math.abs(id.start - Date.parse(meta.pidStart)) < 3000;
  const sameName = !meta.pidName || id.name.toLowerCase().replace(/\.exe$/, '') === String(meta.pidName).toLowerCase().replace(/\.exe$/, '');
  return sameStart && sameName ? 'alive' : 'stale';
}

/** 找 claude 可執行檔：環境變數 GOAL2_CLAUDE_BIN（非標準安裝路徑／測試用假引擎）> PATH 裡的 claude / claude.exe > ~/.local/bin，找不到就回 'claude' 交給 spawn 報錯。
 *  Windows 只認 .exe：Node 22 起 spawn .cmd/.bat 不經 shell 會 EINVAL，而 -p 後面那段 prompt 走 shell 引號會被改寫，所以不走 .cmd。 */
function locateClaude() {
  if (process.env.GOAL2_CLAUDE_BIN && fs.existsSync(process.env.GOAL2_CLAUDE_BIN)) return process.env.GOAL2_CLAUDE_BIN;
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
    }
  }
  const home = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(home)) return home;
  return 'claude';
}

/** 從 stream.jsonl 解析摘要（不依賴引擎的內部訊息格式，只用 stream-json 的公開事件） */
function summarizeStream(streamPath) {
  const out = {
    goal_set: false,            // stream 裡看到引擎回「Goal set: …」
    goal_error: null,           // 引擎拒收目標的訊息（例：Goal condition is limited to 4000 characters (got N)）
    continuations: 0,           // 引擎擋停、要求繼續的次數（"Stop hook feedback" 使用者訊息）
    compactions: 0,             // 上下文壓縮次數（system 事件 subtype 含 compact）
    anchor_injections: 0,       // 壓縮後 compact-anchor hook 成功注回錨定的次數
    num_turns: null,
    result_subtype: null,       // success | error_* …
    is_error: null,
    terminal_reason: null,
    result_text: null,          // 最後一則 assistant 文字（引擎達成後的收尾回報）
    session_id: null,
    total_cost_usd: null,
    permission_denials: 0,
    stream_missing: false       // stream.jsonl 不在（被刪／從未產生）：與「引擎沒設目標」是兩回事，不可判成失敗
  };
  let lines;
  try { lines = fs.readFileSync(streamPath, 'utf8').split('\n').filter(Boolean); } catch (_) { out.stream_missing = true; return out; }
  const GOAL_ERR_RE = /Goal condition is limited to \d+ characters \(got \d+\)/;
  let assistantTexts = 0;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch (_) { continue; }
    if (o.type === 'system' && o.subtype === 'init') out.session_id = o.session_id || out.session_id;
    if (o.type === 'system' && /compact/i.test(o.subtype || '') && !/hook/.test(o.subtype || '')) out.compactions++;
    if (o.type === 'system' && o.subtype === 'hook_response' && /goal2 壓縮後錨定/.test(String(o.output || o.stdout || ''))) out.anchor_injections++;
    if (o.type === 'assistant') {
      for (const c of (o.message && o.message.content) || []) {
        if (c.type !== 'text') continue;
        assistantTexts++;
        if (/^Goal set: /.test(c.text)) out.goal_set = true;
        // 拒收訊息只可能出現在「第一則」回覆（引擎收到 /goal 的立即回應）。之後的回合若引述這句
        // （例如任務本身在檢視別的 run 的失敗紀錄）不算——2026-09-12 run 5cd6 就因此被誤判 ok:false。
        if (assistantTexts === 1) { const m = c.text.match(GOAL_ERR_RE); if (m) out.goal_error = m[0]; }
      }
    }
    if (o.type === 'result' && typeof o.result === 'string' && !out.goal_set) { const m = o.result.match(GOAL_ERR_RE); if (m) out.goal_error = m[0]; }
    if (o.type === 'user') {
      const c = o.message && o.message.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
      if (/^Stop hook feedback:/.test(txt)) out.continuations++;
    }
    if (o.type === 'result') {
      out.num_turns = o.num_turns ?? null;
      out.result_subtype = o.subtype ?? null;
      out.is_error = o.is_error ?? null;
      out.terminal_reason = o.terminal_reason ?? null;
      out.result_text = typeof o.result === 'string' ? o.result : null;
      out.total_cost_usd = o.total_cost_usd ?? null;
      out.permission_denials = Array.isArray(o.permission_denials) ? o.permission_denials.length : 0;
    }
  }
  return out;
}

/**
 * 子程序自己的 transcript：~/.claude/projects/<cwd 編碼>/<session_id>.jsonl。
 * 編碼規則（實測 2.1.268）：cwd 內所有非英數字元各換成一個 '-'（C:\Users\x\a_b → C--Users-x-a-b）。
 * 找不到就掃 projects 底下每個專案目錄一層（只看檔名，不遞迴）。
 */
function findChildTranscript(cwd, sessionId) {
  if (!sessionId) return null;
  const base = path.join(os.homedir(), '.claude', 'projects');
  const enc = String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
  const direct = path.join(base, enc, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return null;
}

/**
 * 從子程序 transcript 讀 /goal 檢查器的真實判定。
 * 每次 Stop 檢查引擎都會寫一筆 attachment {type:'goal_status', met, failed?, reason?}（stream-json 裡沒有這個訊號，
 * 只在 transcript）。Goal set 當下那筆是 sentinel:true、met:false，不算檢查。
 * @returns {{ verdict: 'met'|'impossible'|'unverified'|'no_transcript', checks: number, last_reason: string|null, transcript_path: string|null }}
 */
function goalVerdictFromTranscript(transcriptPath) {
  const out = { verdict: 'no_transcript', checks: 0, last_reason: null, transcript_path: transcriptPath || null };
  if (!transcriptPath) return out;
  let lines; try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); } catch (_) { return out; }
  out.verdict = 'unverified';
  let last = null;
  for (const l of lines) {
    if (!l.includes('"goal_status"')) continue;
    let o; try { o = JSON.parse(l); } catch (_) { continue; }
    const a = o.attachment;
    if (!a || a.type !== 'goal_status' || a.sentinel) continue;
    out.checks++;
    last = a;
  }
  if (last) {
    if (last.met === true) out.verdict = 'met';
    else if (last.failed === true) out.verdict = 'impossible';
    else out.verdict = 'unverified';
    out.last_reason = typeof last.reason === 'string' ? last.reason.slice(0, 1500) : null;
  }
  return out;
}

/** 組 claude 的 argv（抽出來讓測試不用真的起子程序） */
function buildEngineArgs(prompt, engine, { anchorPath = null, hookScript = null } = {}) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', engine.permissionMode];
  if (engine.model) args.push('--model', engine.model);
  if (Number.isInteger(engine.autocompact)) args.push('--autocompact', String(engine.autocompact));
  if (engine.maxBudgetUsd != null) args.push('--max-budget-usd', String(engine.maxBudgetUsd));
  // 長任務防漂移三層：
  //  ① anchor.md 進系統提示（每回合重送，壓縮碰不到）
  if (anchorPath) args.push('--append-system-prompt-file', anchorPath);
  //  ③ 只對這個子程序掛 SessionStart(compact) hook，壓縮後把條件＋帳本注回（fail-open）
  if (anchorPath && hookScript) {
    const hookSettings = { hooks: { SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: `node "${hookScript}"`, timeout: 15 }] }] } };
    args.push('--settings', JSON.stringify(hookSettings));
  }
  //  ② 帳本規則在 anchor 內，由 Claude 執行
  return args;
}

/**
 * 跑引擎（阻塞到子程序結束）。
 * @param {string} runDir  prepareRun 建的目錄
 * @param {{ permissionMode: string, stopHookBlockCap: number, model: string|null, autocompact: string|number, maxBudgetUsd: number|null, maxMinutes: number|null }} engine
 * @returns {Promise<object>} summary（也寫進 runDir/result.json）
 *
 * 結果判定（0.4.0 起）：
 *   goal_verdict  來自子程序 transcript 的 goal_status（met / impossible / unverified / no_transcript），
 *                 不再用「exit 0 且 subtype success」推定達成——2026-09-12 run 55a0 就是那樣被記成達成但條件根本沒滿足。
 *   status        done（met）｜impossible（檢查器判不可能）｜unverified（正常結束但沒有任何檢查器判定）｜
 *                 failed（引擎拒收／非零退出／error）｜stopped（--stop）｜timeout（超過 maxMinutes）｜unknown（stream 被刪，無從判定）
 */
function runEngine(runDir, engine) {
  const promptPath = path.join(runDir, 'prompt.txt');
  const streamPath = path.join(runDir, 'stream.jsonl');
  const stderrPath = path.join(runDir, 'stderr.txt');
  const resultPath = path.join(runDir, 'result.json');
  const writeResult = (summary) => { try { fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2) + '\n'); } catch (_) {} return summary; };

  // meta 讀不到（被刪、半截）：不炸 stack trace，留一個 spawn_failed 的 meta 讓 --list/--prune 認得它
  let meta;
  try { meta = readMeta(runDir); }
  catch (e) {
    const now = new Date().toISOString();
    try { writeMeta(runDir, { runId: path.basename(runDir), skill: 'unknown', status: 'spawn_failed', createdAt: now, endedAt: now, error: e.message, pluginVersion: pluginVersion() }); } catch (_) {}
    return Promise.resolve(writeResult({ ok: false, error: `runEngine: ${e.message}`, run_dir: runDir, status: 'spawn_failed', plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT }));
  }
  // R3-1：同一 run 目錄只准啟動一次。第二次 --run 會覆寫 pid、重開 stream.jsonl，把第一個引擎變成找不到的孤兒。
  if (meta.status !== 'prepared') {
    const st = meta.status === 'running' ? aliveState(meta) : null;
    const hint = meta.status === 'running'
      ? (st === 'alive' ? '它正在跑；要看進度用 --status，要停用 --stop'
        : !meta.pid ? '它正在啟動（還沒記到 pid），幾秒後用 --status 看'
        : st === 'unknown' ? '狀態 running 但無法確認程序是否還在；先 --status 重探，仍不明再依 SKILL 處理'
        : `狀態 running 但程序已不在（${st}）；先 --stop 收掉狀態，要重做就重新準備一個 run`)
      : '要重做請重新準備一個 run（同目錄重跑會覆寫 stream.jsonl 與結果）';
    // 不寫 result.json：那是第一次執行的結果，覆寫掉會把 result_text 弄丟
    return Promise.resolve({ ok: false, error: `runEngine: 這個 run 已啟動過（status=${meta.status}）——${hint}`, run_dir: runDir, status: meta.status, alive_state: st, plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT, reentry_refused: true });
  }
  const prompt = fs.readFileSync(promptPath, 'utf8');
  if (!prompt.startsWith('/goal ')) throw new Error(`runEngine: ${promptPath} 第一行不是 /goal，拒絕執行`);
  if (prompt.length > GOAL_PROMPT_HARD_MAX) throw new Error(`runEngine: ${promptPath} 共 ${prompt.length} 字，超過 ${GOAL_PROMPT_HARD_MAX}——Claude Code 會以「Goal condition is limited to 4000 characters」拒收（-p 路徑整段都算）。請縮短完成條件或 tail；任務全文應在 anchor.md。`);

  if (meta.cwd && !fs.existsSync(meta.cwd)) {
    const now = new Date().toISOString();
    try { writeMeta(runDir, { ...meta, status: 'spawn_failed', endedAt: now, error: `工作目錄不存在：${meta.cwd}` }); } catch (_) {}
    return Promise.resolve(writeResult({ ok: false, status: 'spawn_failed', error: `工作目錄不存在：${meta.cwd}（準備後被移除／改名？worktree 被清？）——重新準備一個 run 並用 --cwd 指到現存目錄`, run_dir: runDir, plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT }));
  }
  const anchorPath = path.join(runDir, 'anchor.md');
  const hasAnchor = fs.existsSync(anchorPath);
  const hookScript = path.join(__dirname, '..', 'hooks', 'compact-anchor.js');
  const args = buildEngineArgs(prompt, engine, { anchorPath: hasAnchor ? anchorPath : null, hookScript: fs.existsSync(hookScript) ? hookScript : null });

  const env = { ...process.env };
  delete env.CLAUDECODE;                       // 避免子程序被當成巢狀 session
  env.MSYS_NO_PATHCONV = '1';                  // 保險：即使經 shell 也不轉 /goal
  env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = String(engine.stopHookBlockCap);
  env.GOAL2_RUN_DIR = runDir;                  // compact-anchor hook 靠它找 run 目錄

  const startedAt = new Date().toISOString();
  writeMeta(runDir, { ...meta, status: 'running', startedAt, permissionMode: engine.permissionMode, stopHookBlockCap: engine.stopHookBlockCap, model: engine.model || null, autocompact: engine.autocompact, maxBudgetUsd: engine.maxBudgetUsd ?? null, maxMinutes: engine.maxMinutes ?? null, anchorInSystemPrompt: hasAnchor, pluginVersion: pluginVersion(), runnerPid: process.pid });

  return new Promise((resolve) => {
    const outFd = fs.openSync(streamPath, 'w');
    const errFd = fs.openSync(stderrPath, 'w');
    let child;
    try {
      const bin = locateClaude();
      // GOAL2_CLAUDE_BIN 指到 .js 時以 node 執行（測試用假引擎、或自製包裝器）；其餘直接執行
      const isJs = /\.[cm]?js$/i.test(bin);
      child = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, { cwd: meta.cwd || process.cwd(), env, stdio: ['ignore', outFd, errFd], windowsHide: true });
    } catch (e) {
      fs.closeSync(outFd); fs.closeSync(errFd);
      const summary = { ok: false, error: `無法啟動 claude：${e.message}`, run_dir: runDir, status: 'spawn_failed', plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT };
      writeMeta(runDir, { ...readMeta(runDir), status: 'spawn_failed', endedAt: new Date().toISOString() });
      return resolve(writeResult(summary));
    }
    // 記 PID＋身分：--stop / --status / --list 靠它殺程序樹、判活；身分防 pid 重用
    const recordIdent = (ident) => { try { writeMeta(runDir, { ...readMeta(runDir), pid: child.pid, pidStart: ident ? new Date(ident.start).toISOString() : null, pidName: ident ? ident.name : null }); } catch (_) {} };
    let ident = procIdentity(child.pid); recordIdent(ident);
    // 第一次抓不到（PowerShell 慢半拍）就 500ms 後再試一次；沒有身分的 running meta 會被 aliveState 判成 unknown 而不是 alive
    if (!ident) { const t = setTimeout(() => { if (child.exitCode === null) recordIdent(procIdentity(child.pid)); }, 500); if (t.unref) t.unref(); }
    child.on('error', (e) => {
      fs.writeFileSync(stderrPath, `spawn error: ${e.message}\n`, { flag: 'a' });
    });
    // 子程序的 session_id 在 stream 第一筆 init 事件；每 2 秒讀一次、抓到就記進 meta（stream 之後被刪也找得到 transcript），最多等 60 秒
    let sidTimer = null; const sidDeadline = Date.now() + 60000;
    const pollSid = () => {
      try {
        const head = fs.readFileSync(streamPath, 'utf8').split('\n').find((l) => l.includes('"init"'));
        const o = head ? JSON.parse(head) : null;
        if (o && o.type === 'system' && o.subtype === 'init' && o.session_id) { writeMeta(runDir, { ...readMeta(runDir), childSessionId: o.session_id }); return; }
      } catch (_) {}
      if (Date.now() < sidDeadline && child.exitCode === null) { sidTimer = setTimeout(pollSid, 2000); if (sidTimer.unref) sidTimer.unref(); }
    };
    sidTimer = setTimeout(pollSid, 2000); if (sidTimer.unref) sidTimer.unref();
    // 時限煞車：超過 maxMinutes 殺整棵樹並標 timeout（無人值守唯一的自動煞車之一；另一個是 --max-budget-usd 由引擎自己執行）
    let timer = null;
    if (engine.maxMinutes != null && engine.maxMinutes > 0) {
      timer = setTimeout(() => {
        try { writeMeta(runDir, { ...readMeta(runDir), status: 'timeout', timeoutAt: new Date().toISOString(), timeoutNote: `超過 engine.maxMinutes=${engine.maxMinutes} 分鐘，由 runner 終止` }); } catch (_) {}
        killTree(child.pid);
      }, engine.maxMinutes * 60 * 1000);
      if (timer.unref) timer.unref();
    }
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer); if (sidTimer) clearTimeout(sidTimer);
      fs.closeSync(outFd); fs.closeSync(errFd);
      const s = summarizeStream(streamPath);
      let stderr = ''; try { stderr = fs.readFileSync(stderrPath, 'utf8').trim(); } catch (_) {}
      const endedAt = new Date().toISOString();
      let prevSid = null; try { prevSid = readMeta(runDir).childSessionId || null; } catch (_) {}
      const transcript = findChildTranscript(meta.cwd, s.session_id || prevSid);
      const v = goalVerdictFromTranscript(transcript);
      // 執行中 meta.json 被別的 session 刪掉／砍壞：不要讓 runner 崩在收尾，仍寫 result.json，狀態退回 unknown
      let prev; try { prev = readMeta(runDir); } catch (e) { prev = { ...meta, status: 'unknown', metaLost: e.message }; }
      const ranOk = code === 0 && s.result_subtype === 'success' && !s.goal_error && !s.stream_missing;
      let status, error;
      if (prev.metaLost) { status = 'unknown'; error = `執行中 meta.json 遺失（${prev.metaLost}），結果無從對照；子程序 transcript：${transcript || '未知'}`; }
      else if (prev.status === 'stopped' && !(ranOk && v.verdict === 'met')) status = 'stopped';   // --stop 落在引擎已達成、正在收尾之後 → 仍算 done
      else if (prev.status === 'timeout' && !(ranOk && v.verdict === 'met')) { status = 'timeout'; error = prev.timeoutNote; }
      else if (s.stream_missing) { status = 'unknown'; error = 'stream.jsonl 不在（被刪或從未產生），無法判定結果；請看子程序 transcript'; }
      else if (s.goal_error) { status = 'failed'; error = `引擎拒收目標：${s.goal_error}（/goal prompt 整段超過 4000 字元；這版工具已把任務與工作清單移到 anchor.md，若仍出現代表條件本身或 tail 太長）`; }
      else if (s.result_subtype === 'error_max_budget_usd') { status = 'budget'; error = `花費達到 engine.maxBudgetUsd（${engine.maxBudgetUsd} USD）引擎自行停止，條件未達成；實花 ${s.total_cost_usd ?? '?'} USD。要續做請重新準備一個 run（可調高預算）`; }
      else if (!s.goal_set && code !== 0 && /^spawn .*ENOENT/m.test(stderr)) { status = 'spawn_failed'; error = `找不到 claude 可執行檔（${stderr.split('\n')[0]}）：確認 claude 在 PATH（Windows 需 .exe，npm 的 .cmd 不行）或設 GOAL2_CLAUDE_BIN`; }
      else if (!ranOk) { status = 'failed'; error = `引擎異常結束（exit ${code}${signal ? ' / ' + signal : ''}，subtype ${s.result_subtype}）`; }
      else if (v.verdict === 'met') status = 'done';
      else if (v.verdict === 'impossible') { status = 'impossible'; error = '檢查器判定完成條件不可能達成而放行結束（條件寫錯或環境不允許）'; }
      else { status = 'unverified'; error = v.verdict === 'no_transcript' ? '引擎正常結束但找不到子程序 transcript，無法確認是否達成' : '引擎正常結束但檢查器沒有留下任何達成判定（可能未經檢查就 end_turn），不可當作已達成'; }
      const achieved = status === 'done';
      const summary = {
        ok: achieved,
        status,
        error,
        goal_error: s.goal_error,
        goal_verdict: v.verdict,
        goal_checks: v.checks,
        goal_verdict_reason: v.last_reason,
        child_transcript: transcript,
        run_dir: runDir,
        run_id: meta.runId,
        skill: meta.skill,
        plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT,
        exit_code: code,
        signal: signal || null,
        goal_set: s.goal_set,
        goal_achieved: achieved,     // 只認子程序 transcript 最後一筆 goal_status.met === true
        stopped: status === 'stopped' || undefined,
        continuations: s.continuations,
        compactions: s.compactions,
        anchor_injections: s.anchor_injections,
        progress_path: path.join(runDir, 'progress.md'),
        num_turns: s.num_turns,
        result_subtype: s.result_subtype,
        terminal_reason: s.terminal_reason,
        permission_denials: s.permission_denials,
        total_cost_usd: s.total_cost_usd,
        child_session_id: s.session_id || prevSid,
        started_at: startedAt,
        ended_at: endedAt,
        duration_seconds: Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
        result_text: s.result_text,
        stderr_tail: stderr ? stderr.slice(-800) : '',
        stream_path: streamPath
      };
      try { writeMeta(runDir, { ...prev, status, endedAt, exitCode: code, goalVerdict: v.verdict, childSessionId: s.session_id || prevSid, childTranscript: transcript }); } catch (e) { summary.meta_write_error = e.message; }
      resolve(writeResult(summary));
    });
  });
}

/** 殺掉整棵程序樹（Windows 用 taskkill /T，其餘用 kill 群組 + 本體）。
 *  注意：taskkill /T 只沿父子鏈找；引擎內用 `cmd &`／nohup 起、已被 re-parent 的背景服務抓不到。 */
function killTree(pid) {
  if (process.platform === 'win32') {
    // 不回傳 taskkill 的文字（中文 Windows 是 cp950，塞進 JSON 一律亂碼），只回 exit code
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return { ok: r.status === 0, detail: `taskkill /T /F exit ${r.status}` };
  }
  let ok = false, detail = '';
  try { process.kill(-pid, 'SIGTERM'); ok = true; } catch (e) { detail += `group: ${e.message}; `; }
  try { process.kill(pid, 'SIGTERM'); ok = true; } catch (e) { detail += `pid: ${e.message}; `; }
  return { ok, detail };
}

/**
 * 終止一個進行中的 run：殺子程序樹（claude -p 與它的工具子程序），meta 標 stopped。
 * runner（goal.js --run 那個 node）會因 child close 事件正常收尾並寫 result.json。
 */
function stopRun(runDir, { force = false } = {}) {
  const meta = readMeta(runDir);
  const out = { run_dir: runDir, run_id: meta.runId, previous_status: meta.status, pid: meta.pid || null, plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT };
  // running／timeout 可停；stopped 但程序其實還活著（上次沒殺乾淨、或被 --force 誤收）也允許再殺一次
  if (meta.status !== 'running' && !(['timeout', 'stopped'].includes(meta.status) && meta.pidStart && aliveState(meta) === 'alive')) return { ...out, ok: false, error: `run 不在執行中（status=${meta.status}），沒有東西可終止` };
  if (!meta.pid) return { ...out, ok: false, error: 'meta.json 沒有 pid（可能是舊版準備的 run），請手動找 claude 子程序終止' };
  const state = aliveState(meta);
  const now = new Date().toISOString();
  if (state === 'dead' || state === 'stale') {
    // pid 不在、或 pid 已被別的程序重用：都不能殺，只把狀態收掉
    const note = state === 'dead' ? 'pid 已不存在' : `pid ${meta.pid} 已被別的程序重用（啟動時間／程式名對不上），未殺任何程序`;
    writeMeta(runDir, { ...meta, status: 'stopped', stoppedAt: now, endedAt: now, stopNote: note });
    return { ...out, ok: true, alive_state: state, note: `子程序早已結束（${note}），僅更新狀態為 stopped` };
  }
  if (state === 'unknown') {
    if (!force) return { ...out, ok: false, alive_state: state, error: `無法確認 pid ${meta.pid} 是不是本 run 的引擎（探測被拒或拿不到程序身分），為避免殺錯程序不動它。先再跑一次 --status（每次都會重探身分）；仍不明且手動確認引擎已不在，才用 --stop <run_dir> --force 只把狀態收成 stopped（不殺任何程序；pid 仍是活著的 claude 時會拒絕）` };
    // --force 的安全閥：pid 探得到且程式名像 claude → 很可能就是引擎（本 run 或別 run 的），拒絕收狀態
    let probeOk = false; try { process.kill(meta.pid, 0); probeOk = true; } catch (_) {}
    const id = probeOk ? procIdentity(meta.pid) : null;
    if (id && /claude|node/i.test(id.name)) return { ...out, ok: false, alive_state: state, error: `--force 拒絕：pid ${meta.pid} 仍是活著的 ${id.name}（啟動於 ${new Date(id.start).toISOString()}），可能就是本 run 的引擎；要停它請用工作管理員／taskkill 後再 --stop --force` };
    // pid 探得到卻拿不到身分（PowerShell／ps 不可用）：閥失明，不敢收——拿不到身分的 pid 若是受保護的系統程序，探測本身就會被拒（EPERM），不會走到這裡
    if (probeOk && !id) return { ...out, ok: false, alive_state: state, error: `--force 拒絕：pid ${meta.pid} 還在但拿不到程序身分（PowerShell／ps 不可用？），無法排除它就是引擎；修好身分探測或以工作管理員確認後再試` };
    writeMeta(runDir, { ...meta, status: 'stopped', stoppedAt: now, endedAt: now, stopNote: `--force：pid ${meta.pid} 狀態不明，由使用者確認後強制收狀態，未殺任何程序` });
    return { ...out, ok: true, alive_state: state, forced: true, note: '未殺任何程序，僅把狀態收成 stopped（--force）' };
  }
  writeMeta(runDir, { ...readMeta(runDir), status: 'stopped', stoppedAt: now }); // 先標，讓 runner 的 close 不會蓋成 failed（重讀：別蓋掉 pollSid 剛寫的 childSessionId）
  const k = killTree(meta.pid);
  const deadline = Date.now() + 5000;
  while (aliveState(meta) === 'alive' && Date.now() < deadline) sleepMs(100);
  const alive = aliveState(meta) === 'alive';
  if (!alive) { try { const m = readMeta(runDir); if (!m.endedAt) writeMeta(runDir, { ...m, endedAt: new Date().toISOString() }); } catch (_) {} }
  return { ...out, ok: !alive, killed: !alive, alive_state: alive ? 'alive' : 'dead', kill_detail: k.detail.trim(), note: alive ? '5 秒後程序仍在，請手動終止' : '子程序樹已終止；進度帳本與 stream.jsonl 保留在 run 目錄。注意：引擎內用 & / nohup 起的背景服務（dev server 等）不在這棵樹上，請自行檢查 port' };
}

/** 從 stream.jsonl 取「引擎最後在做什麼」：最後一則 assistant 文字、最後一個工具呼叫、最後事件時間 */
function lastActivity(streamPath) {
  const out = { last_text: null, last_tool: null, last_event_at: null, assistant_messages: 0 };
  let lines; try { lines = fs.readFileSync(streamPath, 'utf8').split('\n').filter(Boolean); } catch (_) { return out; }
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch (_) { continue; }
    if (o.timestamp) out.last_event_at = o.timestamp;
    if (o.type === 'assistant') {
      out.assistant_messages++;
      for (const c of (o.message && o.message.content) || []) {
        if (c.type === 'text' && c.text.trim()) out.last_text = c.text.trim();
        if (c.type === 'tool_use') {
          const inp = c.input || {};
          const brief = String(inp.description || inp.command || inp.file_path || inp.pattern || '').split('\n')[0].trim();
          out.last_tool = `${c.name}${brief ? '：' + brief.slice(0, 100) + (brief.length > 100 ? '…' : '') : ''}`;
        }
      }
    }
  }
  return out;
}

/** 把狀態講成一句人話（給主 session 直接轉述用；欄位本身也保留） */
function describeStatus(st) {
  const runningDesc = {
    alive: '進行中',
    dead: '狀態寫 running 但子程序已不在（runner 被殺或關機），結果未收尾；用 --stop 收掉狀態，結果看子程序 transcript',
    stale: `狀態寫 running 但 pid ${st.pid} 已被別的程序重用，引擎早已不在；用 --stop 收掉狀態`,
    unknown: '狀態寫 running，但無法確認 pid 是否還是本 run 的引擎'
  }[st.alive_state || (st.alive ? 'alive' : 'dead')];
  const state = {
    prepared: '已準備、還沒啟動',
    running: runningDesc,
    done: '已完成，檢查器確認完成條件達成（goal_status met:true）',
    unverified: '引擎正常結束，但檢查器沒有留下達成判定——不能當作已達成，請看 result_text 與帳本自行核對',
    impossible: '檢查器判定條件不可能達成而放行結束（條件寫錯或環境不允許），未達成',
    failed: st.goal_error ? `引擎拒收目標：${st.goal_error}` : '已結束但失敗（看 result.json 的 error / terminal_reason / result_text）',
    stopped: st.alive_state === 'alive' ? '狀態是 stopped 但子程序仍在跑（上次沒殺乾淨或被 --force 誤收）——用 --stop 再殺一次' : '被 --stop 終止',
    timeout: st.alive_state === 'alive' ? '超過 engine.maxMinutes 時限，runner 已嘗試終止但子程序仍在——用 --stop 再殺一次' : '超過 engine.maxMinutes 時限，被 runner 終止',
    budget: '花費達到 engine.maxBudgetUsd 引擎自行停止，條件未達成（要續做請重新準備、可調高預算）',
    unknown: 'stream.jsonl 不在，結果無從判定（看子程序 transcript）',
    spawn_failed: '子程序起不來（看 stderr.txt / meta.json 的 error）'
  }[st.status] || `狀態 ${st.status}`;
  const parts = [state];
  if (st.status === 'running' && !st.goal_set && st.assistant_messages === 0) parts.push('引擎尚未回第一則（剛啟動或還在載入）');
  if (st.num_turns != null) parts.push(`共 ${st.num_turns} 回合`);
  else if (st.assistant_messages) parts.push(`目前 ${st.assistant_messages} 則回覆`);
  parts.push(st.continuations ? `被檢查器擋停要求繼續 ${st.continuations} 次` : '尚未被擋停過');
  if (st.compactions) parts.push(`上下文壓縮 ${st.compactions} 次、錨定注回 ${st.anchor_injections} 次`);
  if (st.last_tool) parts.push(`最後一個動作：${st.last_tool}`);
  if (st.last_text) parts.push(`最後一句：「${st.last_text.replace(/\s+/g, ' ').slice(0, 160)}${st.last_text.length > 160 ? '…' : ''}」`);
  return parts.join('；') + '。';
}

/** 列出 runs 目錄裡所有 run 的摘要（meta 為準，pid 探活） */
const FINISHED_STATUSES = ['done', 'failed', 'stopped', 'spawn_failed', 'timeout', 'budget', 'unknown', 'impossible', 'unverified'];

function listRuns() {
  let names = []; try { names = fs.readdirSync(RUNS_DIR); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    const rd = path.join(RUNS_DIR, n);
    let dirMtime = null, isDir = false; try { const st = fs.statSync(rd); dirMtime = st.mtime.toISOString(); isDir = st.isDirectory(); } catch (_) {}
    if (!isDir || !/^\d{14}-[a-z]+-[0-9a-z]{4}$/.test(n)) { out.push({ runDir: rd, runId: n, status: 'foreign', alive: false, alive_state: 'dead', foreign: true, dirMtime }); continue; }   // 不是 run 目錄的東西：列出但 prune 不碰
    let meta; try { meta = JSON.parse(fs.readFileSync(path.join(rd, 'meta.json'), 'utf8')); } catch (_) { out.push({ runDir: rd, runId: n, status: 'broken', alive: false, alive_state: 'dead', broken: true, dirMtime }); continue; }
    // 只有 running 才需要探活（探身分要起 PowerShell，避免對每個歷史 run 都做）
    // running／timeout／stopped 都要探活：timeout 殺不死、stopped 被 --force 誤收，引擎可能還在跑（探身分要起 PowerShell，其餘狀態不做）
    const probe = meta.status === 'running' || (['timeout', 'stopped'].includes(meta.status) && meta.pidStart);   // 舊版 meta 沒身分：stopped/timeout 不探活（pid 重用會把無關程序當引擎）
    const state = probe && meta.pid ? aliveState(meta) : 'dead';
    out.push({ runDir: rd, runId: meta.runId || n, skill: meta.skill, status: meta.status, cwd: meta.cwd || null, pid: meta.pid || null, alive: state === 'alive', alive_state: state, createdAt: meta.createdAt || null, scheduledFor: meta.scheduledFor || null, startedAt: meta.startedAt || null, endedAt: meta.endedAt || meta.stoppedAt || null, pluginVersion: meta.pluginVersion || null, condition: typeof meta.condition === 'string' ? meta.condition.slice(0, 120) : null, dirMtime });
  }
  return out;
}

/** 同一棵工作樹（相同、祖先或子孫目錄）是否已有活著的 run——兩個引擎在同一棵樹裡會互相改檔、搶測試 */
function findActiveRunsIn(cwd) {
  const norm = (p) => path.resolve(String(p || '')).toLowerCase().replace(/[\\/]+$/, '');
  const a = norm(cwd);
  const overlaps = (b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  return listRuns().filter((r) => r.alive && r.cwd && overlaps(norm(r.cwd)));
}

/**
 * 安全清理。可刪的只有這四類，且都要「最後一次活動」超過 keepHours 小時：
 *   a. 已結束（FINISHED_STATUSES）且程序不在
 *   b. status=running 但 pid 已死或被重用（runner 被殺／關機留下的殘骸）——這類永遠不會自己變成 done
 *   c. prepared 但從未啟動（skill 準備後沒執行 run_command）
 *   d. 沒有 meta.json 的壞目錄
 * 活著的、探測不明（unknown）的一律不碰。單一目錄刪不掉（EBUSY 等）不中斷，記進 failed 繼續。
 * 這是唯一被允許的清理方式——2026-09-12 曾因人手 rm 整個 runs 目錄，把另一個 session 正在跑的 run 一起刪掉。
 */
function pruneRuns({ keepHours = 24, dryRun = false } = {}) {
  const now = Date.now();
  const removed = [], kept = [], failed = [];
  const olderThan = (iso) => iso ? (now - Date.parse(iso)) > keepHours * 3600 * 1000 : false;
  // run id 開頭 14 位就是建立時間（本機時間）：壞目錄／刪到一半的殘骸沒有 meta 可看，用它判年齡，不用 dirMtime（刪一半會把 mtime 刷新）
  const idTime = (runId) => { const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(runId || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : null; };
  for (const r of listRuns()) {
    let kind = null, reason = null;
    if (r.foreign) reason = '不是 run 目錄（名稱不符 <14位時間戳>-<skill>-<4位>），不碰';
    else if (r.broken) { if (olderThan(idTime(r.runId) || r.dirMtime)) kind = 'broken'; else reason = '壞目錄但未滿保留時數'; }
    else if (r.alive_state === 'alive') reason = '程序仍在';
    else if (r.alive_state === 'unknown') reason = '無法確認程序狀態，不碰';
    else if (FINISHED_STATUSES.includes(r.status)) { if (olderThan(r.endedAt || r.dirMtime)) kind = 'finished'; else reason = '結束未滿保留時數'; }
    else if (r.status === 'running') { if (olderThan(r.dirMtime)) kind = 'stale-running'; else reason = 'running 但程序不在；未滿保留時數（可能剛被殺）'; }
    else if (r.status === 'prepared') {
      // delaylocal 排程的 run 在 quota 重置後才會被 --run（可能等 5 小時以上）：以預計 fire 時間（scheduledFor）為起算點，沒有就用 createdAt
      const created = r.createdAt || r.dirMtime;
      const since = r.scheduledFor && Date.parse(r.scheduledFor) > Date.parse(created || 0) ? r.scheduledFor
        : (r.skill === 'delaylocal' && created ? new Date(Date.parse(created) + 6 * 3600e3).toISOString() : created);   // 舊版 delaylocal meta 沒記 fire 時間：quota 週期 5h＋緩衝，保守給 6h
      if (olderThan(since)) kind = 'never-started'; else reason = r.scheduledFor ? `prepared，預計 ${r.scheduledFor} 由 cron 啟動，未滿保留時數` : 'prepared 未滿保留時數（可能等著被 --run）';
    }
    else reason = `未知狀態 ${r.status}`;
    if (!kind) { kept.push({ runId: r.runId, status: r.status, alive_state: r.alive_state, reason }); continue; }
    if (!dryRun) {
      try { fs.rmSync(r.runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
      catch (e) { failed.push({ runId: r.runId, kind, error: `${e.code || ''} ${e.message}`.trim() }); continue; }
    }
    removed.push({ runId: r.runId, kind });
  }
  return { ok: failed.length === 0, dry_run: dryRun, keep_hours: keepHours, removed, kept, failed, plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT };
}

/** 讀一個 run 的即時狀態（不阻塞）。同時寫一份 status.json 到 run 目錄——終端機是 cp950 時中文會糊掉，可改用 Read 讀檔 */
function runStatus(runDir) {
  const meta = readMeta(runDir);
  const streamPath = path.join(runDir, 'stream.jsonl');
  const s = summarizeStream(streamPath);
  const la = lastActivity(streamPath);
  let progress = ''; try { progress = fs.readFileSync(path.join(runDir, 'progress.md'), 'utf8'); } catch (_) {}
  const probe = meta.status === 'running' || (['timeout', 'stopped'].includes(meta.status) && meta.pidStart);
  const state = probe && meta.pid ? aliveState(meta) : 'dead';
  const st = {
    ok: true, run_dir: runDir, run_id: meta.runId, skill: meta.skill, status: meta.status, plugin_version: pluginVersion(), plugin_root: PLUGIN_ROOT, run_plugin_version: meta.pluginVersion || null,
    pid: meta.pid || null, alive: state === 'alive', alive_state: state, started_at: meta.startedAt || null, ended_at: meta.endedAt || null,
    goal_set: s.goal_set, goal_error: s.goal_error, goal_verdict: meta.goalVerdict || null, stream_missing: s.stream_missing,
    continuations: s.continuations, compactions: s.compactions, anchor_injections: s.anchor_injections,
    num_turns: s.num_turns, assistant_messages: la.assistant_messages, total_cost_usd: s.total_cost_usd,
    last_event_at: la.last_event_at, last_tool: la.last_tool, last_text: la.last_text,
    progress_md: progress,
    status_path: path.join(runDir, 'status.json')
  };
  st.summary_zh = describeStatus(st);
  try { fs.writeFileSync(st.status_path, JSON.stringify(st, null, 2) + '\n'); } catch (_) {}
  return st;
}

/** 偵測 wtf plugin（重講紀律）：找 plugin cache 裡最新版的 skills/wtf，回 SKILL.md 路徑與 terminalWidth */
function detectWtf() {
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache');
  let best = null;
  try {
    for (const mp of fs.readdirSync(base)) {
      const wtfDir = path.join(base, mp, 'wtf');
      if (!fs.existsSync(wtfDir)) continue;
      for (const ver of fs.readdirSync(wtfDir)) {
        const skill = path.join(wtfDir, ver, 'skills', 'wtf', 'SKILL.md');
        const cfg = path.join(wtfDir, ver, 'skills', 'wtf', 'config.json');
        if (!fs.existsSync(skill)) continue;
        let width = null;
        try { width = JSON.parse(fs.readFileSync(cfg, 'utf8')).terminalWidth ?? null; } catch (_) {}
        const cand = { installed: true, version: ver, skill_md: skill, config_json: fs.existsSync(cfg) ? cfg : null, terminal_width: width };
        if (!best || ver.localeCompare(best.version, undefined, { numeric: true }) > 0) best = cand;
      }
    }
  } catch (_) {}
  return best || { installed: false };
}

module.exports = { prepareRun, runEngine, stopRun, runStatus, listRuns, findActiveRunsIn, pruneRuns, summarizeStream, locateClaude, detectWtf, extractItems, selfSufficiency, readMeta, writeMeta, buildAnchor, ledgerRules, pluginVersion, PLUGIN_ROOT, aliveState, procIdentity, findChildTranscript, goalVerdictFromTranscript, buildEngineArgs, describeStatus, FINISHED_STATUSES };
