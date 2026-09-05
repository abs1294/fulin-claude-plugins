#!/usr/bin/env node
'use strict';
/**
 * 寬度未定閘 — 調用 what-the-fuck 時，若設定檔沒有終端機寬度就擋下，
 * 強迫先問到寬度才准往下做。
 *
 * 為什麼要機械閘而不是寫在 SKILL.md 裡：
 * 「畫圖前先確認寬度」寫成文字規則，模型讀了會忘、會覺得「應該問過了」而跳過，
 * 於是又用猜的寬度排版、又爆版。實際紀錄：規則寫進 SKILL.md 之後，
 * 下一個 session 仍然沒讀設定檔就直接問使用者，而使用者早就答過了。
 * 真正的保證只能來自「調用當下檢查、不符就 exit 2 擋掉」。
 *
 * 只在 skill 名為 what-the-fuck 時作用；其他 skill 一律放行，
 * 所以裝了本 plugin 但不用這個 skill 的人不受影響。
 */

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'skills', 'what-the-fuck', 'config.json');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

const raw = readStdin();
if (!raw.trim()) process.exit(0); // 無 stdin（手動誤跑）→ 放行

let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  process.exit(0); // 解析不了就不擋，閘壞掉不該卡住使用者
}

const skill = (input.tool_input || {}).skill || '';
// plugin skill 的名稱可能帶 namespace（what-the-fuck:what-the-fuck），兩種都要認
if (!/(^|:)what-the-fuck$/.test(skill)) process.exit(0);

let width = null;
let declined = false;
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  width = cfg.terminalWidth;
  declined = cfg.widthPromptDeclined === true;
} catch (e) {
  width = null; // 檔案不存在或壞掉 → 當成未設定，走下面的擋下流程
}

// 使用者明確說過「不要再問寬度」→ 放行，讓模型進入 skill 讀降級規則。
// 沒有這個出口的話，閘會擋住它自己的逃生門：SKILL.md 裡「他說不要問了就停、
// 用 80 排」那條規則寫在 skill 本體，而模型永遠進不了 skill 就讀不到它。
if (declined) process.exit(0);

if (typeof width === 'number' && width > 0) process.exit(0); // 有值 → 放行

process.stderr.write(
  '[what-the-fuck] 終端機寬度未設定，本次調用已擋下。\n' +
  '\n' +
  '設定檔：' + CONFIG + '\n' +
  '目前 terminalWidth = ' + JSON.stringify(width) + '\n' +
  '\n' +
  '你必須先問到寬度才能繼續，順序如下：\n' +
  '1. 在回覆正文（不是工具輸出，工具輸出使用者看不到）印出這組階梯標尺：\n' +
  "   for n in (80, 100, 120, 140, 160, 180, 200, 220):\n" +
  "       print('─' * (n - 5) + f'┤{n}')\n" +
  '2. 問使用者：「最後一條沒有折到第二行的是哪個數字？」\n' +
  '3. 拿到數字後寫回設定檔的 terminalWidth（其他欄位不動），再重新調用本 skill。\n' +
  '\n' +
  '不准用猜的、不准用 tput/stdout.columns/PowerShell 去量（那些量到的都不是使用者的視窗），\n' +
  '也不准因為被擋就放棄畫圖改用純文字——那正是這個 skill 要治的病。\n' +
  '在拿到數字之前若必須先回話，一律照 80 字元排版。\n' +
  '\n' +
  '★ 唯一的例外：使用者明確說「不要問了」「別再問寬度」時，\n' +
  '  把設定檔的 widthPromptDeclined 設成 true（terminalWidth 維持 null），\n' +
  '  本閘就會放行，你才進得了 skill 讀到那條降級規則。\n' +
  '  ⚠️ 這個旗標只管「還要不要再問」，不管排版：terminalWidth 有數字就照那個數字排，\n' +
  '     只有 terminalWidth 仍是 null 時才照 80 排。\n' +
  '  不准因為他一次沒回答、或你自己覺得問了很煩就設這個旗標——必須是他明確拒絕過。\n'
);
process.exit(2); // 擋下本次呼叫，stderr 回饋給模型
