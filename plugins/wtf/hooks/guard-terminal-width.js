#!/usr/bin/env node
'use strict';
/**
 * 寬度未定閘 — 調用 wtf 時，若設定檔沒有終端機寬度就擋下，
 * 強迫先問到寬度才准往下做。
 *
 * 為什麼要機械閘而不是寫在 SKILL.md 裡：
 * 「畫圖前先確認寬度」寫成文字規則，模型讀了會忘、會覺得「應該問過了」而跳過，
 * 於是又用猜的寬度排版、又爆版。實際紀錄：規則寫進 SKILL.md 之後，
 * 下一個 session 仍然沒讀設定檔就直接問使用者，而使用者早就答過了。
 * 真正的保證只能來自「調用當下檢查、不符就 exit 2 擋掉」。
 *
 * 只在 skill 名為 wtf 時作用；其他 skill 一律放行，
 * 所以裝了本 plugin 但不用這個 skill 的人不受影響。
 */

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'skills', 'wtf', 'config.json');
const RULER = path.join(__dirname, '..', 'skills', 'wtf', 'ruler.js');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

const raw = readStdin();
if (!raw.trim()) process.exit(0); // 無 stdin（手動誤跑）→ 放行

let skill = '';
try {
  const input = JSON.parse(raw);
  // payload 不是物件（null／陣列／字串／數字）一律當成「不是我要攔的呼叫」。
  // 官方語義：exit 1（未捕捉例外）不阻擋工具呼叫，等於閘靜默失效——
  // 紅藍對抗實測 `null` payload 曾讓這裡拋 TypeError 而放行，所以型別檢查要做滿。
  if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti)) process.exit(0);
  // matcher "Skill" 是 regex，未來若出現以 Skill 開頭命名的其他工具也會觸發本 hook；
  // 只要它的 tool_input 恰好有 skill 欄位就會被誤擋（紅藍對抗實測 tool_name=NotSkill 中招）。
  // 官方 payload 一定帶 tool_name，所以帶了就以它為準；沒帶（手動測試）才沿用只看 skill。
  if (typeof input.tool_name === 'string' && input.tool_name !== 'Skill') process.exit(0);
  if (typeof ti.skill !== 'string') process.exit(0);
  skill = ti.skill;
} catch (e) {
  process.exit(0); // 解析不了就不擋，閘壞掉不該卡住使用者
}

// plugin skill 可能帶 namespace（wtf:wtf），前綴一併吃掉
if (!/(^|:)wtf$/.test(skill)) process.exit(0);

let width = null;
let declined = false;
let configBroken = ''; // 非空＝檔案讀不到或不是合法 JSON；stderr 要講清楚是檔壞、不是沒問過
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  width = cfg.terminalWidth;
  declined = cfg.widthPromptDeclined === true;
} catch (e) {
  // 檔案不存在／空檔／非法 JSON（尾逗號、截斷、BOM）都落這裡。
  // 紅藍對抗實測：若這裡只當成「未設定」、stderr 又只印 terminalWidth = null，
  // 模型會以為沒問過而重問，問完寫回若仍寫壞就無限迴圈——所以把原因帶出去。
  configBroken = (e && e.code === 'ENOENT')
    ? '檔案不存在'
    : (e && (e.code === 'EACCES' || e.code === 'EPERM'))
      ? '沒有讀取權限（' + e.code + '）'
      : ('不是合法 JSON：' + String((e && e.message) || e).split('\n')[0]);
  width = null;
}

// 使用者明確說過「不要再問寬度」→ 放行，讓模型進入 skill 讀降級規則。
// 沒有這個出口的話，閘會擋住它自己的逃生門：SKILL.md 裡「他說不要問了就停、
// 用 80 排」那條規則寫在 skill 本體，而模型永遠進不了 skill 就讀不到它。
if (declined) process.exit(0);

if (typeof width === 'number' && width > 0) process.exit(0); // 有值 → 放行

// 檔案壞了就只講「修檔」——不印下面那段問寬度的流程，那 14 行對此刻的模型是雜訊，
// 而且會誘導它跳過重建檔直接去問（紅藍對抗 R3 實測）。
if (configBroken) {
  process.stderr.write(
    '[wtf] 設定檔讀取失敗，本次調用已擋下。\n' +
    '\n' +
    '設定檔：' + CONFIG + '\n' +
    '原因：' + configBroken + '\n' +
    '\n' +
    '⛔ 這不是「沒問過寬度」，是檔案壞了。不要去問使用者寬度——問完寫回壞檔還是壞的，會無限迴圈。\n' +
    '先把整個檔用合法 JSON 重建（欄位：terminalWidth 設 null、widthPromptDeclined 設 false），\n' +
    '再重新調用本 skill，那時才會走正常的問寬度流程。\n'
  );
  process.exit(2);
}

process.stderr.write(
  '[wtf] 終端機寬度未設定，本次調用已擋下。\n' +
  '\n' +
  '設定檔：' + CONFIG + '\n' +
  '目前 terminalWidth = ' + JSON.stringify(width) + '\n' +
  '\n' +
  '你必須先問到寬度才能繼續，順序如下（兩輪二分法，精度 ±4 格）：\n' +
  '\n' +
  '⛔ 不准自己寫 print 迴圈產標尺——使用者實測「同一台電腦有的量出 170、有的 200」，\n' +
  '   成因就是每次現場寫、檔位與寫法都在飄。標尺一律用腳本產，輸出逐字節相同。\n' +
  '\n' +
  '1. 跑第一輪（粗測）：node "' + RULER + '"\n' +
  '   把印出來的標尺**原樣貼進回覆正文**（工具輸出使用者看不到），\n' +
  '   ⚠ 這件事有 Stop hook 擋（guard-ruler-pasted.js）：跑了標尺沒貼進正文，整回合會被擋下。\n' +
  '   問他：「哪一條開始斷開、掉到第二行？」\n' +
  '2. 跑第二輪（細測）：node "' + RULER + '" <lo> <hi>\n' +
  '   區間＝他說斷掉那條的前一檔 ~ 斷掉那條（例如他答 180 就跑 160 180）。\n' +
  '   同樣把標尺貼進正文，問他：「最後一條沒有斷行的是哪個數字？」\n' +
  '   （他答「都沒斷」→ 細測 200 220；答「第一條就斷」→ 細測 40 80）\n' +
  '3. 拿到第二輪數字後寫回設定檔的 terminalWidth（其他欄位不動），再重新調用本 skill。\n' +
  '   直接寫他回報的數字，不要自己再減安全邊際——標尺每行寬度已精確等於標示值。\n' +
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
