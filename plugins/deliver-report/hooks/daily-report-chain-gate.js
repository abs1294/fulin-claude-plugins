#!/usr/bin/env node
/**
 * daily-report-chain-gate — deliver-report plugin 的第二支 Stop hook
 *
 * 目的：daily-report 的定時觸發走「自續鏈」（寄成功 → 立刻排下一次一次性 cron），
 *       本 hook 擋住鏈斷掉而沒人發現的情況。純 SKILL.md 規範擋不住——
 *       「寄完記得排下一次」是自律，AI 會漏；而鏈一旦斷了就是靜默地永遠斷著。
 *
 * 兩種情況（依使用者定的邊界）：
 *   (A) 本回合寄出成功，但沒排下一次    → 硬擋（decision:block）
 *       ——鏈斷在這裡最可惜，而且當下補排只要一個 CronCreate。
 *   (B) 過去有該寄而沒寄的缺口          → 只警告（systemMessage）
 *       ——補舊日報是使用者的選擇，不該卡住他結束對話。
 *   其他 / 任何不確定 / 失敗            → 放行
 *
 * 觸發條件：本回合（最後一個 promptId 的區段）真的跑過 daily-report 的腳本才啟動。
 *   不是「session 曾經跑過」——抄 doc-readability-gate 的教訓：用後者會讓
 *   跑過一次日報之後的每一句話都被檢查，連寫程式的對話都跳出來講日報。
 *
 * ★ 提醒頻率：每個日報週期只提醒一次（使用者明定）。
 *   狀態檔記下「上次提醒時 sent/ 的內容」，只要沒有新的寄送發生就不再問。
 *   所以一次執行或一次排程觸發之後最多問一次，不會每輪重複。
 *
 * ★ 最高原則：FAIL-OPEN。任何讀檔失敗、解析例外、判斷不確定 → 一律放行。
 *   這 hook 影響 session 能不能結束，寧可漏擋，絕不卡死。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_DIR = path.join(os.homedir(), '.claude', 'daily-report');
const SENT_DIR = path.join(BASE_DIR, 'sent');
const STATE_DIR = path.join(BASE_DIR, 'chain-gate');

// 本回合「碰過 daily-report」的判準：跑過這些腳本，或調用過 skill。
const DR_SCRIPTS = [
  'extract_sessions.py', 'send_gmail.py', 'gmail_oauth.py',
  'confirm_gate.py', 'content_guard.py', 'schedule_gate.py',
];
const DR_SKILL = 'daily-report';

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try { main(stdinData); } catch (_) { allow(); }
});

function allow() { process.exit(0); }
function writeThenExit(obj) {
  let json;
  try { json = JSON.stringify(obj); } catch (_) { return allow(); }
  try { process.stdout.write(json, () => process.exit(0)); } catch (_) { allow(); }
}
function block(reason) { writeThenExit({ decision: 'block', reason }); }
function warn(msg) { writeThenExit({ systemMessage: msg }); }

// ---- 主判定 ----

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return allow(); }

  // 落點基準：以 harness 傳入的 input.cwd 為首選（AI 自己 export CLAUDE_PROJECT_DIR
  // 蓋不掉——見本 repo memory「CLAUDE_PROJECT_DIR 不一定內建、會被 AI export 覆蓋」）。
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const tp = input.transcript_path;

  // 這輪沒碰 daily-report → 不關我的事
  const touched = touchedDailyReportThisTurn(tp);
  if (touched !== true) return allow();   // false 或 null 都放行

  // 專案沒開排程 → 沒有鏈可斷
  const sched = loadSchedule(cwd);
  if (!sched || sched.enabled !== true) return allow();

  const key = scopeKey(cwd);
  const sentNow = sentSnapshot(key);
  if (sentNow === null) return allow();   // 讀不到 sent/ → 不確定 → 放行

  // ── 每個日報週期只提醒一次 ──
  // 狀態檔存上次提醒時的 sent 快照；相同 → 這個週期已經問過了 → 靜默放行。
  const last = readState(key);
  if (last !== null && last === sentNow.sig) return allow();

  // ── (A) 本回合寄出成功，但沒排下一次 → block ──
  const sentThisTurn = sentDuringThisTurn(tp, sentNow.dates);
  if (sentThisTurn) {
    const scheduled = scheduledCronThisTurn(tp);
    if (scheduled === false) {
      writeState(key, sentNow.sig);       // 問過了，這個週期不再問
      return block(
        '日報已寄出，但這一輪沒有排下一次的觸發時間——自續鏈斷在這裡。\n' +
        '鏈斷之後不會有任何東西提醒你（下次觸發本來就該由這個 cron 帶起來），' +
        '而現在補排只要一步：\n' +
        '  1) python "<plugin>/skills/daily-report/scripts/schedule_gate.py" next --project ' + cwd + '\n' +
        '  2) 照它輸出的 cron 欄位呼叫 CronCreate（recurring:false，prompt 寫自然語言不要寫 slash）\n' +
        '若這次刻意不要續排（例如之後不再寄了），回覆說明後再結束即可——本 hook 這個週期只擋這一次。'
      );
    }
  }

  // ── (B) 過去的缺口 → warn ──
  const gaps = runGapCheck(cwd);
  if (gaps && gaps.length) {
    writeState(key, sentNow.sig);
    const shown = gaps.slice(0, 10);
    const more = gaps.length > shown.length ? `（另有 ${gaps.length - shown.length} 天未列出）` : '';
    return warn(
      `daily-report 排程有 ${gaps.length} 天該寄卻沒有寄出紀錄：${shown.join('、')}${more}\n` +
      '可能的斷鏈原因：你當時喊停、內容閘擋下、排程到點時對話正在進行（cron 只在 idle 時觸發）、' +
      '或 Claude Code 被關過。要補哪幾天跟我說；不補也可以，本 hook 這個週期不會再提。'
    );
  }

  return allow();
}

// ---- helpers（全部 fail-safe）----

// 與 send_common.scope_key / confirm_gate.scope_key / schedule_gate.scope_key 同源。
// 四處若各算各的，查到的 sent 標記就對不上。
function scopeKey(dir) {
  try {
    const crypto = require('crypto');
    const norm = path.resolve(dir).toLowerCase();
    return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 10);
  } catch (_) { return null; }
}

function loadSchedule(cwd) {
  // 專案層優先，家目錄次之——與 confirm_gate.wait_minutes 同一套分層。
  let out = null;
  for (const p of [path.join(BASE_DIR, 'config.json'),
                   path.join(cwd, '.claude', 'daily-report.json')]) {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    if (cfg && typeof cfg.schedule === 'object' && cfg.schedule) {
      out = Object.assign(out || {}, cfg.schedule);
    }
  }
  return out;
}

// sent/ 的快照：回 {dates:Set, sig:string}；讀失敗回 null。
function sentSnapshot(key) {
  if (!key) return null;
  let names;
  try { names = fs.readdirSync(SENT_DIR); } catch (e) {
    // 目錄不存在＝還沒寄過任何日報，那是確定的空集合，不是「讀失敗」
    if (e && e.code === 'ENOENT') return { dates: new Set(), sig: '' };
    return null;
  }
  const suffix = `-${key}.json`;
  const dates = new Set();
  for (const n of names) {
    if (n.endsWith(suffix)) dates.add(n.slice(0, n.length - suffix.length));
  }
  return { dates, sig: Array.from(dates).sort().join(',') };
}

// 本回合是否有「新的寄出」——以 transcript 裡本回合出現過 mark_sent 的日期為據。
// 判準刻意寬鬆（只要本回合跑過寄送腳本且 sent/ 非空），因為 block 的代價是
// 使用者多回一句話，而漏擋的代價是鏈靜默斷掉。
function sentDuringThisTurn(tp, sentDates) {
  if (!sentDates || sentDates.size === 0) return false;
  const blocks = turnToolUses(tp);
  if (blocks === null) return false;
  for (const b of blocks) {
    const s = safeStr(b.input && (b.input.command || b.input.script));
    if (!s) continue;
    // 跑過寄送腳本且沒帶 --dry-run
    if ((s.indexOf('send_gmail.py') !== -1 || s.indexOf('gmail_oauth.py') !== -1) &&
        s.indexOf('--dry-run') === -1) {
      return true;
    }
  }
  return false;
}

// 本回合有沒有呼叫 CronCreate；true=有 / false=沒有 / null=判不出（呼叫端當沒有處理要小心）
function scheduledCronThisTurn(tp) {
  const blocks = turnToolUses(tp);
  if (blocks === null) return null;
  for (const b of blocks) {
    if (b.name === 'CronCreate' || b.name === 'ScheduleWakeup') return true;
  }
  return false;
}

function touchedDailyReportThisTurn(tp) {
  const blocks = turnToolUses(tp);
  if (blocks === null) return null;
  for (const b of blocks) {
    if (b.name === 'Skill') {
      const sk = safeStr(b.input && b.input.skill);
      if (sk.indexOf(DR_SKILL) !== -1) return true;
    }
    const s = safeStr(b.input && (b.input.command || b.input.script || b.input.file_path));
    if (s && DR_SCRIPTS.some((n) => s.indexOf(n) !== -1)) return true;
  }
  return false;
}

// 取本回合（最後一個 user promptId 之後）的所有 tool_use block。
// 抄 doc-readability-gate 的做法：用 promptId 切回合，不用「最後 N 行」
// （一個回合可能有數十次工具往返，行數不固定）。
let _turnCache = undefined;
function turnToolUses(tp) {
  if (_turnCache !== undefined) return _turnCache;
  _turnCache = null;
  if (!tp) return null;
  let raw;
  try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return null; }

  const lines = raw.split('\n');
  let pid = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (o && o.type === 'user' && o.promptId) { pid = o.promptId; break; }
  }
  if (!pid) return null;

  const out = [];
  for (const l of lines) {
    if (!l || l.indexOf(pid) === -1) continue;   // 字串快篩，避免每行 JSON.parse
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (o.promptId !== pid) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b && b.type === 'tool_use') out.push(b);
  }
  _turnCache = out;
  return out;
}

// 跑 schedule_gate.py check --json 取缺口；任何失敗回 null（呼叫端放行）。
function runGapCheck(cwd) {
  const script = path.join(__dirname, '..', 'skills', 'daily-report', 'scripts', 'schedule_gate.py');
  try {
    if (!fs.existsSync(script)) return null;
  } catch (_) { return null; }
  for (const py of ['python', 'python3']) {
    try {
      const out = execFileSync(py, [script, 'check', '--project', cwd, '--json'],
                               { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const o = JSON.parse(out);
      return Array.isArray(o.gaps) ? o.gaps : null;
    } catch (e) {
      // exit 20 = 有缺口，stdout 仍是合法 JSON
      if (e && e.stdout) {
        try {
          const o = JSON.parse(String(e.stdout));
          if (Array.isArray(o.gaps)) return o.gaps;
        } catch (_) { /* 換下一個直譯器 */ }
      }
    }
  }
  return null;
}

function readState(key) {
  if (!key) return null;
  try {
    return fs.readFileSync(path.join(STATE_DIR, `${key}.txt`), 'utf8').trim();
  } catch (_) { return null; }
}

function writeState(key, sig) {
  if (!key) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, `${key}.txt`), String(sig), 'utf8');
  } catch (_) { /* 寫不進去只會讓下輪再問一次，不影響正確性 */ }
}

function safeStr(x) { return typeof x === 'string' ? x : ''; }
