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
const { spawn } = require('child_process');
const { RUNS_DIR } = require('./config.js');

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
 * 組 anchor.md：放進子程序系統提示的錨（完成條件 + 任務全文 + 帳本規則）。
 */
function buildAnchor({ condition, task, runDir, extra = '' }) {
  return `# goal2 錨定（本區塊在系統提示中，每回合重送、上下文壓縮也不會消失）

## 完成條件（引擎據此驗收；達成才准停）
${condition}

## 任務全文
${task}
${extra ? `\n## 補充\n${extra}\n` : ''}
${ledgerRules(runDir)}
`;
}

/**
 * 建立 run 目錄並落地 prompt / anchor / 帳本模板。
 * @param {{ skill: 'goal'|'delaylocal', prompt: string, cwd: string, meta?: object, anchor?: string }} o
 * @returns {{ runDir: string, promptPath: string, metaPath: string, anchorPath: string, progressPath: string, runId: string }}
 */
function prepareRun({ skill, prompt, cwd, meta = {}, anchor = null }) {
  if (!prompt.startsWith('/goal ')) throw new Error('prepareRun: prompt 第一行必須以 "/goal " 開頭');
  const runId = `${ts14()}-${skill}-${Math.random().toString(16).slice(2, 6)}`;
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
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
  return { runDir, promptPath, metaPath, anchorPath, progressPath, runId };
}

function readMeta(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
}
function writeMeta(runDir, meta) {
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

/** 找 claude 可執行檔：PATH 裡的 claude / claude.exe，找不到就回 'claude' 交給 spawn 報錯 */
function locateClaude() {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
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
    permission_denials: 0
  };
  let lines;
  try { lines = fs.readFileSync(streamPath, 'utf8').split('\n').filter(Boolean); } catch (_) { return out; }
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch (_) { continue; }
    if (o.type === 'system' && o.subtype === 'init') out.session_id = o.session_id || out.session_id;
    if (o.type === 'system' && /compact/i.test(o.subtype || '') && !/hook/.test(o.subtype || '')) out.compactions++;
    if (o.type === 'system' && o.subtype === 'hook_response' && /goal2 壓縮後錨定/.test(String(o.output || o.stdout || ''))) out.anchor_injections++;
    if (o.type === 'assistant') {
      for (const c of (o.message && o.message.content) || []) {
        if (c.type === 'text' && /^Goal set: /.test(c.text)) out.goal_set = true;
      }
    }
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
 * 跑引擎（阻塞到子程序結束）。
 * @param {string} runDir  prepareRun 建的目錄
 * @param {{ permissionMode: string, stopHookBlockCap: number, model: string|null }} engine
 * @returns {Promise<object>} summary（也寫進 runDir/result.json）
 */
function runEngine(runDir, engine) {
  const meta = readMeta(runDir);
  const promptPath = path.join(runDir, 'prompt.txt');
  const streamPath = path.join(runDir, 'stream.jsonl');
  const stderrPath = path.join(runDir, 'stderr.txt');
  const resultPath = path.join(runDir, 'result.json');
  const prompt = fs.readFileSync(promptPath, 'utf8');
  if (!prompt.startsWith('/goal ')) throw new Error(`runEngine: ${promptPath} 第一行不是 /goal，拒絕執行`);

  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', engine.permissionMode];
  if (engine.model) args.push('--model', engine.model);
  if (Number.isInteger(engine.autocompact)) args.push('--autocompact', String(engine.autocompact));

  // 長任務防漂移三層：
  //  ① anchor.md 進系統提示（每回合重送，壓縮碰不到）
  const anchorPath = path.join(runDir, 'anchor.md');
  const hasAnchor = fs.existsSync(anchorPath);
  if (hasAnchor) args.push('--append-system-prompt-file', anchorPath);
  //  ③ 只對這個子程序掛 SessionStart(compact) hook，壓縮後把 anchor + 帳本注回（fail-open）
  const hookScript = path.join(__dirname, '..', 'hooks', 'compact-anchor.js');
  if (hasAnchor && fs.existsSync(hookScript)) {
    const hookSettings = { hooks: { SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: `node "${hookScript}"`, timeout: 15 }] }] } };
    args.push('--settings', JSON.stringify(hookSettings));
  }
  //  ② 帳本規則在 anchor 與 prompt 內，由 Claude 執行

  const env = { ...process.env };
  delete env.CLAUDECODE;                       // 避免子程序被當成巢狀 session
  env.MSYS_NO_PATHCONV = '1';                  // 保險：即使經 shell 也不轉 /goal
  env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = String(engine.stopHookBlockCap);
  env.GOAL2_RUN_DIR = runDir;                  // compact-anchor hook 靠它找 run 目錄

  const startedAt = new Date().toISOString();
  writeMeta(runDir, { ...meta, status: 'running', startedAt, permissionMode: engine.permissionMode, stopHookBlockCap: engine.stopHookBlockCap, model: engine.model || null, autocompact: engine.autocompact, anchorInSystemPrompt: hasAnchor });

  return new Promise((resolve) => {
    const outFd = fs.openSync(streamPath, 'w');
    const errFd = fs.openSync(stderrPath, 'w');
    let child;
    try {
      child = spawn(locateClaude(), args, { cwd: meta.cwd || process.cwd(), env, stdio: ['ignore', outFd, errFd], windowsHide: true });
    } catch (e) {
      fs.closeSync(outFd); fs.closeSync(errFd);
      const summary = { ok: false, error: `無法啟動 claude：${e.message}`, run_dir: runDir };
      writeMeta(runDir, { ...readMeta(runDir), status: 'spawn_failed', endedAt: new Date().toISOString() });
      fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2) + '\n');
      return resolve(summary);
    }
    // 記 PID：goal.js --stop / --status 靠它殺程序樹、看還活著沒
    try { writeMeta(runDir, { ...readMeta(runDir), pid: child.pid, runnerPid: process.pid }); } catch (_) {}
    child.on('error', (e) => {
      fs.writeFileSync(stderrPath, `spawn error: ${e.message}\n`, { flag: 'a' });
    });
    child.on('close', (code, signal) => {
      fs.closeSync(outFd); fs.closeSync(errFd);
      const s = summarizeStream(streamPath);
      let stderr = ''; try { stderr = fs.readFileSync(stderrPath, 'utf8').trim(); } catch (_) {}
      const endedAt = new Date().toISOString();
      const achieved = s.goal_set && s.result_subtype === 'success' && !s.is_error;
      const summary = {
        ok: code === 0 && s.result_subtype === 'success',
        run_dir: runDir,
        run_id: meta.runId,
        skill: meta.skill,
        exit_code: code,
        signal: signal || null,
        goal_set: s.goal_set,
        goal_achieved: achieved,     // 引擎有設目標且正常結束 = 達成（引擎達成才會放行結束）
        continuations: s.continuations,
        compactions: s.compactions,
        anchor_injections: s.anchor_injections,
        progress_path: path.join(runDir, 'progress.md'),
        num_turns: s.num_turns,
        result_subtype: s.result_subtype,
        terminal_reason: s.terminal_reason,
        permission_denials: s.permission_denials,
        total_cost_usd: s.total_cost_usd,
        child_session_id: s.session_id,
        started_at: startedAt,
        ended_at: endedAt,
        duration_seconds: Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
        result_text: s.result_text,
        stderr_tail: stderr ? stderr.slice(-800) : '',
        stream_path: streamPath
      };
      const prev = readMeta(runDir);
      // 若是被 --stop 殺掉的，保留 stopped 狀態，不要蓋成 failed
      const status = prev.status === 'stopped' ? 'stopped' : (summary.ok ? 'done' : 'failed');
      if (status === 'stopped') { summary.ok = false; summary.stopped = true; summary.goal_achieved = false; }
      writeMeta(runDir, { ...prev, status, endedAt, exitCode: code });
      fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2) + '\n');
      resolve(summary);
    });
  });
}

/** 程序還活著嗎（不送訊號，只探測） */
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 殺掉整棵程序樹（Windows 用 taskkill /T，其餘用 kill 群組 + 本體） */
function killTree(pid) {
  const { spawnSync } = require('child_process');
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, detail: (r.stdout || '') + (r.stderr || '') };
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
function stopRun(runDir) {
  const meta = readMeta(runDir);
  const out = { run_dir: runDir, run_id: meta.runId, previous_status: meta.status, pid: meta.pid || null };
  if (meta.status !== 'running') return { ...out, ok: false, error: `run 不在執行中（status=${meta.status}），沒有東西可終止` };
  if (!meta.pid) return { ...out, ok: false, error: 'meta.json 沒有 pid（可能是舊版準備的 run），請手動找 claude 子程序終止' };
  if (!isAlive(meta.pid)) {
    writeMeta(runDir, { ...meta, status: 'stopped', stoppedAt: new Date().toISOString(), stopNote: 'pid 已不存在' });
    return { ...out, ok: true, note: '子程序早已結束，僅更新狀態為 stopped' };
  }
  writeMeta(runDir, { ...meta, status: 'stopped', stoppedAt: new Date().toISOString() }); // 先標，讓 runner 的 close 不會蓋成 failed
  const k = killTree(meta.pid);
  const deadline = Date.now() + 5000;
  while (isAlive(meta.pid) && Date.now() < deadline) { const t = Date.now() + 100; while (Date.now() < t) {} }
  const alive = isAlive(meta.pid);
  return { ...out, ok: !alive, killed: !alive, kill_detail: k.detail.trim(), note: alive ? '5 秒後程序仍在，請手動終止' : '子程序樹已終止；進度帳本與 stream.jsonl 保留在 run 目錄' };
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
  const state = {
    prepared: '已準備、還沒啟動',
    running: st.alive ? '進行中' : '狀態寫 running 但子程序已不在（可能被外力殺掉），請看 stream.jsonl 尾端',
    done: '已完成並達成完成條件',
    failed: '已結束但沒達成（看 result.json 的 terminal_reason 與 result_text）',
    stopped: '被 --stop 終止',
    spawn_failed: '子程序起不來（看 stderr.txt）'
  }[st.status] || `狀態 ${st.status}`;
  const parts = [state];
  if (st.num_turns != null) parts.push(`共 ${st.num_turns} 回合`);
  else if (st.assistant_messages) parts.push(`目前 ${st.assistant_messages} 則回覆`);
  parts.push(st.continuations ? `被檢查器擋停要求繼續 ${st.continuations} 次` : '尚未被擋停過');
  if (st.compactions) parts.push(`上下文壓縮 ${st.compactions} 次、錨定注回 ${st.anchor_injections} 次`);
  if (st.last_tool) parts.push(`最後一個動作：${st.last_tool}`);
  if (st.last_text) parts.push(`最後一句：「${st.last_text.replace(/\s+/g, ' ').slice(0, 160)}${st.last_text.length > 160 ? '…' : ''}」`);
  return parts.join('；') + '。';
}

/** 讀一個 run 的即時狀態（不阻塞） */
function runStatus(runDir) {
  const meta = readMeta(runDir);
  const streamPath = path.join(runDir, 'stream.jsonl');
  const s = summarizeStream(streamPath);
  const la = lastActivity(streamPath);
  let progress = ''; try { progress = fs.readFileSync(path.join(runDir, 'progress.md'), 'utf8'); } catch (_) {}
  const st = {
    ok: true, run_dir: runDir, run_id: meta.runId, skill: meta.skill, status: meta.status,
    pid: meta.pid || null, alive: isAlive(meta.pid), started_at: meta.startedAt || null, ended_at: meta.endedAt || null,
    goal_set: s.goal_set, continuations: s.continuations, compactions: s.compactions, anchor_injections: s.anchor_injections,
    num_turns: s.num_turns, assistant_messages: la.assistant_messages,
    last_event_at: la.last_event_at, last_tool: la.last_tool, last_text: la.last_text,
    progress_md: progress
  };
  st.summary_zh = describeStatus(st);
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

module.exports = { prepareRun, runEngine, stopRun, runStatus, summarizeStream, locateClaude, detectWtf, readMeta, buildAnchor, ledgerRules };
