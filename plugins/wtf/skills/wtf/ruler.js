#!/usr/bin/env node
'use strict';
/**
 * ruler.js — 終端機寬度標尺（機械產生，模型不准自己 print）
 *
 * 為什麼要有這支腳本：
 * 使用者實測回報「同一台電腦同一個螢幕，有的量出 170、有的 200」。
 * 成因有二，這支腳本兩個都治：
 *   ① 模型每次現場寫 print 迴圈，檔位與寫法會飄 → 改成固定腳本，輸出逐字節相同
 *   ② 舊標尺 20 格一跳，真值落中間時兩邊都「看起來沒折」→ 改成兩輪二分法，精度 ±4
 *
 * 用法：
 *   node ruler.js              第一輪（粗）：80~220，每 20 格一條
 *   node ruler.js 160 180      第二輪（細）：在該區間每 4 格一條
 *
 * 標尺每行結構：<n-5 個橫線>┤<數字>
 * 整行顯示寬度剛好 = n（橫線 n-5 格 + ┤ 1 格 + 數字 3~4 格）。
 * 所以「這條沒斷」⇔「視窗寬 >= n」。
 */

const COARSE_MIN = 80;
const COARSE_MAX = 220;
const COARSE_STEP = 20;
const FINE_STEP = 4;

function widthOf(s) {
  // 標尺只用 ASCII 數字 + 兩個 box-drawing 字元，後者在終端機是單格寬。
  // 這裡不需要 east_asian_width：'─' 與 '┤' 屬 Ambiguous，主流終端機當單格。
  return s.length;
}

function rulerLine(n) {
  const label = String(n);
  // 行尾是 ┤+數字，共 1+label.length 格；橫線補滿到 n
  const dashes = n - 1 - label.length;
  if (dashes < 1) return null;
  return '─'.repeat(dashes) + '┤' + label;
}

function emit(values, title, question) {
  const lines = [];
  for (const n of values) {
    const l = rulerLine(n);
    if (l === null) continue;
    if (widthOf(l) !== n) {
      console.error(`[ruler] 內部錯誤：${n} 這行實際寬度 ${widthOf(l)}`);
      process.exit(1);
    }
    lines.push(l);
  }
  console.log(title);
  console.log('');
  console.log(lines.join('\n'));
  console.log('');
  console.log(question);
}

const argv = process.argv.slice(2);

if (argv.length === 0) {
  const vals = [];
  for (let n = COARSE_MIN; n <= COARSE_MAX; n += COARSE_STEP) vals.push(n);
  emit(
    vals,
    '【第一輪／粗測】下面每一條的結尾都應該剛好貼齊該數字的寬度。',
    '請問：**哪一條開始斷開、掉到第二行？** 回答那個數字就好。\n' +
    '（全部都沒斷 → 回「都沒斷」；第一條就斷 → 回「第一條就斷」）'
  );
  process.exit(0);
}

if (argv.length !== 2) {
  console.error('用法：node ruler.js            （第一輪粗測）');
  console.error('      node ruler.js 160 180   （第二輪細測，區間）');
  process.exit(1);
}

const lo = Number(argv[0]);
const hi = Number(argv[1]);
if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 20 || hi <= lo || hi > 400) {
  console.error('[ruler] 區間不合法：需要 20 <= lo < hi <= 400');
  process.exit(1);
}

const vals = [];
for (let n = lo; n <= hi; n += FINE_STEP) vals.push(n);
emit(
  vals,
  `【第二輪／細測】範圍 ${lo}~${hi}，每 ${FINE_STEP} 格一條。`,
  '請問：**最後一條「沒有斷行」的是哪個數字？** 回答那個數字就好。'
);
