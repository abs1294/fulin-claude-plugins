#!/usr/bin/env node
/**
 * SessionStart hook（matcher=resume）— 隔了很久才 --resume 回來時，提醒對話裡的狀態可能已過期。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 與壓縮交接一組（require compact-handoff.js 的真人輸入判定、讀同一個 compact-snapshots/ 找最近的交接信）；
 * 接線（目標專案 .claude/settings.json）：
 *   "SessionStart": [{ "matcher": "resume", "hooks": [{ "type": "command",
 *     "command": "node \"<專案絕對路徑>/.claude/hooks/resume-stale-reminder.js\"", "timeout": 15 }] }]
 *
 * 壓縮有交接信補位，resume 沒有：context 原封不動回來，裡面「服務在跑」「測試 965 passed」
 * 都還是暫停當下的說法，模型會當成現況接著做。間隔短於 STALE_HOURS 不出聲，免得每次 resume 都洗一段。
 *
 * 最後活動時間取 transcript 尾端最新的 user／assistant 紀錄。resume 當下寫入的是 queue-operation
 * 與 hook 輸出的 attachment，本輪的使用者提示在 hook 之後才寫（來源實例以 -p --resume 實測），
 * 只看 user／assistant 就不會被 resume 自己的紀錄干擾。不另外排除最近 N 秒：那會把真正最新的指示
 * 換成更早的舊句子。一律 exit 0，不擋 session 啟動。
 *
 * 已知未解：互動模式 resume 是否會在 hook 之前先寫 user／assistant 紀錄未實測；若會，最壞結果是該次不出提醒。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// compact-handoff.js 載入失敗就不提醒，守住 exit 0；判準不準的提醒比沒有提醒更容易誤導
let isHumanPrompt;
try { ({ isHumanPrompt } = require('./compact-handoff.js')); } catch { process.exit(0); }

// ── init 填空區 ──────────────────────────────────────────────────────────────
const STALE_HOURS = 4;                // 距上次活動超過幾小時才提醒
// 顯示最後活動時間用的時區（小時偏移與顯示名稱），與 compact-handoff.js 的同名設定一致
const TZ_OFFSET_HOURS = 8;
const TZ_LABEL = '台北時間';
// ─────────────────────────────────────────────────────────────────────────────
const TAIL_BYTES = 4 * 1024 * 1024;   // transcript 動輒十幾 MB，只讀尾端

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const s = buf.toString('utf8');
    if (size <= len) return s;
    // 從中間切進來的第一行不完整，丟掉；整段 4MB 都沒有換行（單行超長）就沒有完整紀錄可讀
    const nl = s.indexOf('\n');
    return nl < 0 ? '' : s.slice(nl + 1);
  } finally { fs.closeSync(fd); }
}

function localTime(ms) {
  return new Date(ms + TZ_OFFSET_HOURS * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some(c => c && c.type === 'tool_result')) return '';
  return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
}

if (process.env.COMPACT_HANDOFF_CHILD) process.exit(0);
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!input || input.source !== 'resume' || !input.transcript_path || !input.session_id) process.exit(0);
  const now = Date.now();
  let last = 0, lastPrompt = '';
  for (const line of readTail(input.transcript_path).split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const t = Date.parse(o.timestamp);
    if (isNaN(t)) continue;
    // 系統注入的 user 紀錄（isMeta）不算活動：萬一 resume 日後改成以這種形式寫入，活動時間會被刷成現在、提醒永遠不出現
    if (t > last && !(o.type === 'user' && o.isMeta)) last = t;
    if (o.type === 'user' && !o.isMeta && !o.isCompactSummary && o.message) {
      const s = userText(o.message.content).trim();
      if (isHumanPrompt(s)) lastPrompt = s;
    }
  }
  if (!last) process.exit(0);
  const hours = (now - last) / 3600000;
  if (hours < STALE_HOURS) process.exit(0);

  const L = [
    `[resume-stale] 距上次活動 ${hours.toFixed(1)} 小時（最後活動 ${localTime(last)} ${TZ_LABEL}）。對話裡的狀態是暫停當下的說法，下列各項據以行動前先重驗：`,
    '- 服務與程序是否還在跑、port 是否被別的程序佔走',
    '- 暫停前派出的背景 agent：完成通知不一定會再送來，以它的產物（檔案、報告）為準，勿直接重派',
    '- DB 種子與測試資料、git 分支與工作區：其他 session 可能動過',
    '- 對話裡「測試通過」「已驗證」的數字是當時的結果，不代表現在',
  ];
  const dir = path.join(path.dirname(input.transcript_path), input.session_id, 'compact-snapshots');
  try {
    const stamp = fs.readFileSync(path.join(dir, 'latest.txt'), 'utf8').trim();
    const letter = path.join(dir, stamp + '.handoff.md');
    if (fs.existsSync(letter)) L.push('', `本 session 最近一封交接信（最後一次壓縮時寫的，之後的進度不在裡面）：${letter}`);
  } catch {}
  if (lastPrompt) {
    const p = lastPrompt.replace(/\s*\n\s*/g, ' ／ ');
    L.push('', '使用者暫停前最後一則指示（原文）：', '> ' + (p.length > 400 ? p.slice(0, 400) + '…' : p));
  }
  process.stdout.write(L.join('\n') + '\n');
} catch (e) {
  try { process.stderr.write(`[resume-stale] 檢查失敗（不影響啟動）：${e.message}\n`); } catch {}
}
process.exit(0);
