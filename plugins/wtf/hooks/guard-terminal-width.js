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
 *
 * 0.18.0：設定改存使用者層（~/.claude/wtf/config.json），讀寫一律經 skills/wtf/width.js。
 * 原本存在 plugin 版本資料夾裡，每升一次版就被重問一次。
 */

const fs = require('fs');
const path = require('path');

const WIDTH = path.join(__dirname, '..', 'skills', 'wtf', 'width.js');
const RULER = path.join(__dirname, '..', 'skills', 'wtf', 'ruler.js');
const NL = String.fromCharCode(10);

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
// 'skill'＝模型呼叫 Skill 工具（PreToolUse，可擋）；
// 'prompt'＝使用者自己打 /wtf（UserPromptSubmit）。0.18.0 起新增：斜線指令直接展開、不經 Skill 工具，
// 原本這種情況本閘根本不會跑。這個時機不擋（exit 2 會把使用者打的字整個吃掉），
// 改成把「先問一次寬度」的指示當成附加脈絡交給模型。
let mode = 'skill';
try {
  const input = JSON.parse(raw);
  // payload 不是物件（null／陣列／字串／數字）一律當成「不是我要攔的呼叫」。
  // 官方語義：exit 1（未捕捉例外）不阻擋工具呼叫，等於閘靜默失效——
  // 紅藍對抗實測 `null` payload 曾讓這裡拋 TypeError 而放行，所以型別檢查要做滿。
  if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);
  if (input.hook_event_name === 'UserPromptSubmit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!/^\s*\/(wtf:)?wtf(\s|$)/.test(prompt)) process.exit(0);
    mode = 'prompt';
    skill = 'wtf';
  }
  const ti = mode === 'prompt' ? { skill: 'wtf' } : input.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti)) process.exit(0);
  // matcher "Skill" 是 regex，未來若出現以 Skill 開頭命名的其他工具也會觸發本 hook；
  // 只要它的 tool_input 恰好有 skill 欄位就會被誤擋（紅藍對抗實測 tool_name=NotSkill 中招）。
  // 官方 payload 一定帶 tool_name，所以帶了就以它為準；沒帶（手動測試）才沿用只看 skill。
  if (mode === 'skill' && typeof input.tool_name === 'string' && input.tool_name !== 'Skill') process.exit(0);
  if (typeof ti.skill !== 'string') process.exit(0);
  skill = ti.skill;
} catch (e) {
  process.exit(0); // 解析不了就不擋，閘壞掉不該卡住使用者
}

// plugin skill 可能帶 namespace（wtf:wtf），前綴一併吃掉
if (!/(^|:)wtf$/.test(skill)) process.exit(0);

let st;
try {
  st = require(WIDTH).load();
} catch (e) {
  process.exit(0); // width.js 載入失敗（plugin 檔案不完整）→ fail-open，閘壞掉不該卡住使用者
}
const CONFIG = st.path;
const width = st.terminalWidth;
const declined = st.widthPromptDeclined === true;
// 非空＝使用者層設定檔讀不了。紅藍對抗實測：若這裡只當成「未設定」，
// 模型會以為沒問過而重問，問完寫回若仍寫壞就無限迴圈——所以把原因帶出去。
const configBroken = st.broken || '';

// 使用者明確說過「不要再問寬度」→ 放行，讓模型進入 skill 讀降級規則。
// 沒有這個出口的話，閘會擋住它自己的逃生門：SKILL.md 裡「他說不要問了就停、
// 用 80 排」那條規則寫在 skill 本體，而模型永遠進不了 skill 就讀不到它。
if (declined) process.exit(0);

if (typeof width === 'number' && width > 0) process.exit(0); // 有值 → 放行

// 手打 /wtf：不擋訊息，指示交給模型當附加脈絡；Skill 工具：照舊 exit 2 擋下
const PROMPT_MODE = mode === 'prompt';
const STATE = PROMPT_MODE ? '（使用者手打 /wtf，訊息照常送出；以下是給你的指示）' : '本次調用已擋下。';
const AFTER = PROMPT_MODE ? '之後照那個數字排' : '再重新調用本 skill';
function emit(lines) {
  const text = lines.join(NL);
  if (PROMPT_MODE) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
    process.exit(0);
  }
  process.stderr.write(text);
  process.exit(2); // 擋下本次呼叫，stderr 回饋給模型
}

// 檔案壞了就只講「修檔」——不印下面那段問寬度的流程，那 14 行對此刻的模型是雜訊，
// 而且會誘導它跳過重建檔直接去問（紅藍對抗 R3 實測）。
if (configBroken) {
  emit([
    '[wtf] 設定檔讀取失敗' + STATE,
    '',
    '設定檔：' + CONFIG,
    '原因：' + configBroken,
    '',
    '⛔ 這不是「沒問過寬度」，是檔案壞了。不要去問使用者寬度——問完寫回壞檔還是壞的，會無限迴圈。',
    '先把壞掉的設定檔改名備份（它只存寬度，移開不會掉其他東西），',
    (PROMPT_MODE ? '這次先照 80 字元排，' : '再重新調用本 skill，') + '之後才會走正常的問寬度流程。',
    '',
  ]);
}

emit([
  '[wtf] 終端機寬度未設定' + STATE,
  '',
  '設定檔：' + CONFIG + '（使用者層，plugin 升版不會清掉）',
  '',
  '你必須先問到寬度才能繼續，順序如下（兩輪二分法，精度 ±4 格）：',
  '',
  '⛔ 不准自己寫 print 迴圈產標尺——使用者實測「同一台電腦有的量出 170、有的 200」，',
  '   成因就是每次現場寫、檔位與寫法都在飄。標尺一律用腳本產，輸出逐字節相同。',
  '',
  '1. 跑第一輪（粗測）：node "' + RULER + '"',
  '   把印出來的標尺**原樣貼進回覆正文**（工具輸出使用者看不到），',
  '   ⚠ 這件事有 Stop hook 擋（guard-ruler-pasted.js）：跑了標尺沒貼進正文，整回合會被擋下。',
  '   問他：「最後一條沒有斷行的是哪個數字？」',
  '2. 跑第二輪（細測）：node "' + RULER + '" <他答的數字> <他答的數字+20>',
  '   例如他答 180 就跑 180 200。同樣貼進正文，問同一句：「最後一條沒有斷行的是哪個數字？」',
  '   （他答「第一條就斷」→ 細測 40 80）',
  '3. 拿到第二輪數字後寫回：node "' + WIDTH + '" set <數字>，' + AFTER + '。',
  '   直接寫他回報的數字，不要自己再減安全邊際——標尺每行寬度已精確等於標示值。',
  '',
  '★ 他沒答寬度、改講別的事 → 處理那件事就好，**不要在回覆尾巴追問、不要再貼標尺**，',
  '  圖表照 80 字元排。下次他再按 /wtf 時本閘自然會再提醒一次。',
  '',
  '不准用猜的、不准用 tput/stdout.columns/PowerShell 去量（那些量到的都不是使用者的視窗），',
  '也不准因為被擋就放棄畫圖改用純文字——那正是這個 skill 要治的病。',
  '在拿到數字之前若必須先回話，一律照 80 字元排版。',
  '',
  '★ 唯一的例外：使用者明確說「不要問了」「別再問寬度」時，',
  '  跑 node "' + WIDTH + '" decline（terminalWidth 維持 null），',
  '  本閘就會放行，你才進得了 skill 讀到那條降級規則。',
  '  ⚠️ 這個旗標只管「還要不要再問」，不管排版：terminalWidth 有數字就照那個數字排，',
  '     只有 terminalWidth 仍是 null 時才照 80 排。',
  '  不准因為他一次沒回答、或你自己覺得問了很煩就設這個旗標——必須是他明確拒絕過。',
  '',
]);
