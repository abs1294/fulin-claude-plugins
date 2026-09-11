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
 * 建立 run 目錄並落地 prompt。
 * @param {{ skill: 'goal'|'delaylocal', prompt: string, cwd: string, meta?: object }} o
 * @returns {{ runDir: string, promptPath: string, metaPath: string, runId: string }}
 */
function prepareRun({ skill, prompt, cwd, meta = {} }) {
  if (!prompt.startsWith('/goal ')) throw new Error('prepareRun: prompt 第一行必須以 "/goal " 開頭');
  const runId = `${ts14()}-${skill}-${Math.random().toString(16).slice(2, 6)}`;
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const promptPath = path.join(runDir, 'prompt.txt');
  const metaPath = path.join(runDir, 'meta.json');
  fs.writeFileSync(promptPath, prompt, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({ runId, skill, cwd, createdAt: new Date().toISOString(), status: 'prepared', ...meta }, null, 2) + '\n');
  return { runDir, promptPath, metaPath, runId };
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

  const env = { ...process.env };
  delete env.CLAUDECODE;                       // 避免子程序被當成巢狀 session
  env.MSYS_NO_PATHCONV = '1';                  // 保險：即使經 shell 也不轉 /goal
  env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = String(engine.stopHookBlockCap);

  const startedAt = new Date().toISOString();
  writeMeta(runDir, { ...meta, status: 'running', startedAt, permissionMode: engine.permissionMode, stopHookBlockCap: engine.stopHookBlockCap, model: engine.model || null });

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
      writeMeta(runDir, { ...readMeta(runDir), status: summary.ok ? 'done' : 'failed', endedAt, exitCode: code });
      fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2) + '\n');
      resolve(summary);
    });
  });
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

module.exports = { prepareRun, runEngine, summarizeStream, locateClaude, detectWtf, readMeta };
