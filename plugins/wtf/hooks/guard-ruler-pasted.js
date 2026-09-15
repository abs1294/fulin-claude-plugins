#!/usr/bin/env node
'use strict';
/**
 * 標尺未貼閘 — 跑了 ruler.js 卻沒把標尺貼進回覆正文，就擋下這個回合。
 *
 * 為什麼要這支（0.17.0 的真實失效紀錄）：
 * 使用者說「你跑的標尺沒顯示出來」。追查後確認：模型跑了 node ruler.js，
 * 拿到標尺、直接就去問「哪一條斷了」——但**工具輸出使用者看不到**，
 * 他螢幕上只有一行「Ran 1 shell command」，於是被問了一個沒有題目的問題。
 *
 * 規則其實早就寫對了：guard-terminal-width.js 的 stderr 白紙黑字寫著
 * 「把印出來的標尺**原樣貼進回覆正文**（工具輸出使用者看不到）」，
 * SKILL.md 也寫了。**模型照樣漏掉**——因為那是純文字規則，是自律。
 * 本 repo 的鐵律：「一定要落地」的動作需機制閘，skill 的「必須」AI 會繞，
 * 只有 hook 是他律。前兩支閘管住了「寬度沒設不准畫」與「標尺要用腳本產」，
 * 唯獨「產完要貼出去」沒有閘 —— 這支補上。
 *
 * 判斷方式（讀 transcript，只看最後一個使用者回合之後的訊息）：
 *   ① 這回合有沒有跑過 ruler.js？   → 看 assistant 的 tool_use 指令字串
 *   ② 標尺有沒有出現在回覆正文？    → 看 assistant 的 text 區塊有沒有標尺特徵
 * 跑了(①) 但沒貼(②) → exit 2 擋下，stderr 叫它貼。
 *
 * 為什麼看 text 區塊就夠：transcript 裡 assistant 訊息的 text 區塊正是
 * 使用者螢幕上看到的內容，tool_use / tool_result 是另外的區塊型別，
 * 兩者在資料結構上本來就分開（已實測確認 2026-09-15）。
 *
 * fail-open：讀不到 transcript、解析不了、判斷不了，一律放行（exit 0）。
 * 閘壞掉不該卡住使用者——這是本 repo 所有 hook 的共同紀律。
 */

const fs = require('fs');
const NL = String.fromCharCode(10);

// 標尺指紋：ruler.js 每行結構是 <橫線>┤<數字>（見 rulerLine()）。
// S5 修正：只看含不含「┤」會被一般表格誤判，也擋不住 codepage 把字元吃掉的情況。
// 改為要求完整的標尺行形狀：行尾是 ┤ 接數字（ruler.js 的 rulerLine() 產出就是這個形狀）。
const RULER_LINE_RE = new RegExp('\u2524\\d+\\s*$');
// 貼一兩行不算貼——粗測 8 行、細測至少 5 行。要求至少 3 行才算真的貼上去了，
// 避免模型只貼一行敷衍過關。
const MIN_RULER_LINES = 3;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

const raw = readStdin();
if (!raw.trim()) process.exit(0); // 無 stdin（手動誤跑）→ 放行

let input;
try { input = JSON.parse(raw); } catch (e) { process.exit(0); }
if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);

// stop_hook_active：官方語義是「本次停止已經是被 hook 擋過又續跑的」。
// 不看這個旗標會無限迴圈——擋下後模型續跑、又觸發 Stop、又被擋。
//
// S3 修正：原本在這裡直接 exit 0，等於「擋一次就永遠放行」——模型只要回一句
// 「抱歉，請問哪條斷了？」而仍然沒貼標尺，第二次 Stop 就無條件通過，閘形同一次性。
// 改法：不在此早退，而是往下照常判斷；只有「真的該擋」時才用這個旗標決定
// 「這次是不是已經擋過了」——擋過就放行（保住迴圈安全），沒擋過才擋。
const alreadyBlockedOnce = input.stop_hook_active === true;

const tpath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
if (!tpath) process.exit(0);

let lines;
try {
  lines = fs.readFileSync(tpath, 'utf8').split('\n');
} catch (e) {
  process.exit(0); // 讀不到就放行
}

// ── 只看「最後一個真實使用者回合」之後的訊息 ────────────────────────
// 工具結果也是 type==='user'，但 content 是陣列（tool_result 區塊），
// 不能拿它當回合邊界，否則每個工具呼叫都會把邊界往後推、永遠看不到 ruler。
//
// ⚠️ S1 修正（原設計的致命洞）：本來以為「type==='user' 且 content 是字串」
// 就等於真人回合——**實測推翻**。掃本機 29 份 transcript：字串型 user 訊息共 681 則，
// 真正出於人類的只有 381 則（56%）。其餘 300 則是 isMeta 103、teammate 82、
// task-notification 46、command-name 36、local-command-stdout 27、command-message 6。
// 這些只要落在「跑 ruler」與「發問」之間，就會把邊界推過 tool_use，
// 於是 ranRuler 永遠是 false、閘靜默失效——測試全過但真實 session 從不觸發。
// 這正是本 repo 紀律警告的那種錯：**假陰性、且失敗方向是放行**。
const NON_HUMAN_RE = /^s*<(task-notification|local-command-stdout|command-name|command-message|system-reminder)>/;

function isHumanTurn(o) {
  if (!o || o.type !== 'user' || !o.message) return false;
  if (typeof o.message.content !== 'string') return false; // tool_result 等陣列型
  if (o.isMeta === true) return false;        // slash command 展開、系統注入
  if (o.isSidechain === true) return false;   // subagent 支線
  const c = o.message.content;
  if (NON_HUMAN_RE.test(c)) return false;     // 系統包裝訊息，非真人輸入
  if (/^Another Claude session sent a message/.test(c)) return false; // teammate
  return true;
}
let startIdx = 0;
const parsed = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (!l.trim()) { parsed.push(null); continue; }
  let o = null;
  try { o = JSON.parse(l); } catch (e) { o = null; }
  parsed.push(o);
  if (isHumanTurn(o)) {
    startIdx = i;
  }
}

// S2 修正：原本用 /ruler.js/ 比對，會把 `cat .../ruler.js`、`grep ruler.js`
// 也當成「跑過標尺」——而用 /wtf 解釋 wtf plugin 自己時正好會做這種事，
// 於是模型被要求貼一份它根本沒產生的標尺。改為必須是 node 實際執行它。
const RUN_RULER_RE = new RegExp('\\bnode\\b[^\\n|;&]*\\bruler\\.js\\b');

// S4 修正：兩輪二分法是正常流程，兩輪常落在同一個回合裡。
// 原本用「整回合跑過沒／整回合貼過沒」兩個總量判斷，第一輪貼了就會
// 替第二輪的漏貼背書——而第二輪漏貼正是使用者看到的症狀。
// 改為依時序記錄：每次執行後，看它「之後」有沒有出現足夠的標尺行。
let pendingSinceRun = null; // 非 null＝有一次執行還沒被貼滿
let ranAny = false;

for (let i = startIdx; i < parsed.length; i++) {
  const o = parsed[i];
  if (!o || o.type !== 'assistant' || !o.message) continue;
  const content = o.message.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;

    // ① 有沒有「執行」ruler.js（Bash / PowerShell 的 command 欄位）
    if (b.type === 'tool_use') {
      const ti = (b.input && typeof b.input === 'object' && !Array.isArray(b.input)) ? b.input : {};
      const cmd = typeof ti.command === 'string' ? ti.command : '';
      if (RUN_RULER_RE.test(cmd)) {
        pendingSinceRun = 0; // 這次執行開始重新計數：之後貼的才算這次的
        ranAny = true;
      }
    }

    // ② 標尺有沒有貼進回覆正文（text 區塊＝使用者螢幕上看到的）
    // thinking 區塊刻意不算——使用者看不到它。
    if (b.type === 'text' && typeof b.text === 'string' && pendingSinceRun !== null) {
      for (const tl of b.text.split(String.fromCharCode(10))) {
        if (RULER_LINE_RE.test(tl)) pendingSinceRun++;
      }
      if (pendingSinceRun >= MIN_RULER_LINES) pendingSinceRun = null; // 這次補齊了
    }
  }
}

if (!ranAny) process.exit(0);            // 這回合沒真的跑標尺 → 不關本閘的事
if (pendingSinceRun === null) process.exit(0); // 每次執行都補貼了 → 放行

// S3：真的該擋，但這次停止已經是「被擋過又續跑」的——放行以免無限迴圈。
// 與原本的差別：原本在讀 transcript 前就無條件放行（等於閘只有一次性效力），
// 現在是先判斷完、確定該擋，才用這個旗標決定要不要重複擋。
if (alreadyBlockedOnce) process.exit(0);

process.stderr.write(
  '[wtf] 這個回合已擋下：你跑了 ruler.js，但標尺沒有貼進回覆正文。\n' +
  '\n' +
  '偵測結果：本回合執行過 ruler.js，但最後一次執行之後，回覆正文裡的標尺行數 = ' +
    pendingSinceRun + '（需要 >= ' + MIN_RULER_LINES + '，標尺行形狀是「┤數字」結尾）。' + NL +
  '\n' +
  '⛔ 工具輸出使用者看不到。他螢幕上只有一行「Ran 1 shell command」，\n' +
  '   你現在問他「哪一條斷了」，他眼前根本沒有那八條線可以看。\n' +
  '   這正是使用者實際回報過的失效（「你跑的標尺沒顯示出來」）。\n' +
  '\n' +
  '你現在要做的：\n' +
  '1. 把 ruler.js 剛剛印出來的每一行**原樣**貼進你的回覆正文，\n' +
  '   放在 ``` 圍起來的程式碼區塊裡（避免 markdown 把橫線吃掉或重新折行）。\n' +
  '2. 一個字都不准改：不要重畫、不要補說明在行內、不要截短、不要只貼幾行。\n' +
  '   標尺的每行寬度就是量測基準，改了就失去意義。\n' +
  '3. 貼完才問他那個問題（哪一條斷 / 最後一條沒斷的是哪個數字）。\n' +
  '\n' +
  '如果標尺輸出已經被捲掉了，就重跑一次 ruler.js 再貼。\n'
);
process.exit(2); // 擋下本回合，stderr 回饋給模型
