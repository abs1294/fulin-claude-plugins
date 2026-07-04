#!/usr/bin/env node
// LINE push 通知工具。用法：
//   node notify-line.js "訊息內容（可含中文與 emoji）"
//   echo "很長的內容..." | node notify-line.js          // 從 stdin 讀（適合長 response）
//
// 長訊息自動拆多則：LINE 單則上限 5000 字、單次 push 最多 5 則 message。
// 超過 5 則（約 24000 字）會把完整內容寫到暫存檔，並在最後一則附上檔案路徑。
// 走 node https 處理 UTF-8（git-bash curl -d 內聯中文會 400）。
'use strict';
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

// LINE 憑證來源（優先序）：環境變數 > 同目錄 notify-line.config.json。
// config 檔已被 .gitignore 排除，不進 git；範本見 notify-line.config.example.json。
let LINE_TOKEN = process.env.LINE_TOKEN || '';
let LINE_USER_ID = process.env.LINE_USER_ID || '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'notify-line.config.json'), 'utf8'));
  LINE_TOKEN = LINE_TOKEN || cfg.token || '';
  LINE_USER_ID = LINE_USER_ID || cfg.userId || '';
} catch (_) {}
if (!LINE_TOKEN || !LINE_USER_ID) {
  // LINE 通知為「選用」：有設憑證才發、沒設就略過，且不影響呼叫方（任務照常完成）。
  // 故缺憑證時印一行 SKIP 並以 0 結束，不再視為失敗。
  // 要啟用通知：複製 notify-line.config.example.json 成 notify-line.config.json 填 token/userId，
  // 或設環境變數 LINE_TOKEN / LINE_USER_ID。
  console.log('LINE SKIP | 未設定 LINE 憑證，略過通知（不影響執行）。');
  process.exit(0);
}

const PER_MSG = 4800;   // 單則保守上限（LINE 5000，留 buffer）
const MAX_MSGS = 5;     // 單次 push 最多 5 則

// --- 清理過期的截斷備份檔 ---
// savedPath（delaylocal-line-*.txt）是「內容過長」時寫的完整內容備份，供使用者事後翻閱；
// 從不主動刪 → 長期累積且含任務報告。策略：每次執行時掃 tmpdir 下本工具自己前綴的檔，
// 刪 mtime 超過 N 天者。只碰 delaylocal-line-* 專屬前綴（本檔只產生這一類），近期檔（使用者
// 可能還沒看）保留，失敗一律吞掉。與 delaylocal.js 的 sweep 同閾值、互補（各清各自寫的檔）。
const CLEANUP_MAX_AGE_DAYS = 7;
(function sweepStaleLineBackups() {
  try {
    const dir = os.tmpdir();
    const cutoff = Date.now() - CLEANUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^delaylocal-line-/.test(name)) continue; // 只清本檔自己產生的截斷備份
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch (_) { /* 單檔失敗忽略 */ }
    }
  } catch (_) { /* 整體失敗忽略，不阻斷通知 */ }
})();

// --- 取訊息：優先參數，否則 stdin ---
let msg = process.argv.slice(2).join(' ').trim();
if (!msg) {
  try { msg = fs.readFileSync(0, 'utf8').trim(); } catch (_) { msg = ''; }
}
if (!msg) {
  console.error('usage: node notify-line.js "<message>"  或  echo "<long>" | node notify-line.js');
  process.exit(2);
}

// --- 用 Array.from 以 code point 切（避免切壞 emoji / 中文）---
const chars = Array.from(msg);
let chunks = [];
for (let i = 0; i < chars.length; i += PER_MSG) {
  chunks.push(chars.slice(i, i + PER_MSG).join(''));
}

let savedPath = null;
if (chunks.length > MAX_MSGS) {
  // 超過 5 則 → 完整內容寫檔，LINE 只發前 (MAX_MSGS-1) 則 + 最後一則附檔案路徑
  savedPath = path.join(os.tmpdir(), `delaylocal-line-${Date.now()}.txt`);
  fs.writeFileSync(savedPath, msg, 'utf8');
  chunks = chunks.slice(0, MAX_MSGS - 1);
  chunks.push(`（內容過長已截斷，完整 ${chars.length} 字內容存於本機：\n${savedPath}）`);
}

// 加頁碼（多則時）
const total = chunks.length;
const messages = chunks.map((text, idx) => ({
  type: 'text',
  text: total > 1 ? `(${idx + 1}/${total})\n${text}`.slice(0, 5000) : text.slice(0, 5000)
}));

const body = JSON.stringify({ to: LINE_USER_ID, messages });

const req = https.request(
  'https://api.line.me/v2/bot/message/push',
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  },
  (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      const ok = res.statusCode === 200;
      console.log(`LINE ${res.statusCode} | 訊息則數=${total}${savedPath ? ' | 完整內容存檔:' + savedPath : ''} | ${d}`);
      // notify 是「盡力通知」而非「必須成功」：即使 API 回非 200（token 過期 / rate limit /
      // userId 失效），也一律 exit 0，只把失敗原因印出來。否則 goal 模式的完成條件會因為
      // 「收尾通知未回 200」而誤判任務未完成、持續重試燒 quota——任務其實早已做完。
      if (!ok) console.error(`[notify-line] 發送未成功（HTTP ${res.statusCode}），但視為「已嘗試通知」，不阻斷收尾。`);
      process.exit(0);
    });
  }
);
// 網路層錯誤同理：已嘗試發送即算完成此步，印出錯誤但 exit 0，不讓 goal 卡住重試。
req.on('error', (e) => { console.error(`[notify-line] LINE request error: ${e.message}（視為已嘗試通知，不阻斷收尾）`); process.exit(0); });
req.write(body);
req.end();
