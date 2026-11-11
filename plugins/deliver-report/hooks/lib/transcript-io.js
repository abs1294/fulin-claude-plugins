/**
 * transcript 讀取：不把整份 transcript 讀成一個字串。
 *
 * 為什麼：長 session 的 transcript 可達數百 MB。舊寫法 fs.readFileSync(tp, 'utf8').split('\n')
 * 在 360 MB 的檔上每支 hook 峰值約 1.1 GB；Stop 時多支 hook 同時跑，系統記憶體不夠就
 * 「FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory」（2026-11-11 使用者回報五則）。
 *
 * readTurnLines：只要「本回合」的 hook 用。從檔尾每次往回讀 4 MB，碰到最後一則符合 isStart 的行就停，
 *   回傳該行到檔尾的所有行（原字串、順序不變、含檔尾換行後那個空字串）——等於
 *   readFileSync(...).split('\n') 從起點那行切到尾。整份都沒有起點行 → 回傳整份的行（同舊寫法找不到起點的情況）。
 *   往回讀超過 maxBytes（預設 64 MB）還沒找到起點 → 回傳 null，呼叫端照「讀不到 transcript」處理（放行）。
 * readLineBatches：要看整個 session 的 hook 用。從頭分塊讀（每塊 4 MB、切在換行），每塊的行陣列交給 onBatch；
 *   送出的行與 split('\n') 相同，只少了檔尾換行後那個空字串。
 */
'use strict';
const fs = require('fs');

const CHUNK = 4 * 1024 * 1024;

function startLine(line, isStart) {
  if (!line) return false;
  let o;
  try { o = JSON.parse(line); } catch (_) { return false; }
  return isStart(o) === true;
}

function readTurnLines(file, isStart, maxBytes) {
  const cap = maxBytes || 64 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let readBytes = 0;
    const rev = [];
    while (pos > 0) {
      if (readBytes >= cap) return null;
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      readBytes += len;
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      let end = data.length;
      for (let i = len - 1; i >= 0; i--) {   // 換行只會在新讀的這塊（carry 裡沒有換行）
        if (data[i] !== 10) continue;
        const line = data.toString('utf8', i + 1, end);
        end = i;
        rev.push(line);
        if (startLine(line, isStart)) return rev.reverse();
      }
      carry = Buffer.from(data.subarray(0, end));
    }
    const first = carry.toString('utf8');
    rev.push(first);
    return rev.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

function readLineBatches(file, onBatch) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const nl = data.lastIndexOf(10);
      if (nl < 0) { carry = Buffer.from(data); continue; }
      onBatch(data.toString('utf8', 0, nl).split('\n'));
      carry = Buffer.from(data.subarray(nl + 1));
    }
    if (carry.length) onBatch([carry.toString('utf8')]);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readTurnLines, readLineBatches };
