/**
 * 由 compact-snapshot.js（PreCompact）呼叫：壓縮前讓模型讀過對話骨架，寫一份交接信。
 * 本檔不是 hook，不必接線；compact-snapshot.js 與 resume-stale-reminder.js 都會 require 它，放在同一個目錄。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 *
 * 取捨原則：已完成的壓成一兩句結果，未完成的盡量完整保留。
 * 交接信圍繞下一步寫：已落檔的只給路徑，避免同一份內容兩處漂移；
 * 沒實跑過的主張降級為 HYPOTHESIS，因為接手者會把交接信當成已確認的事實、不會回頭查。
 *
 * 子 session 的隔離：不給工具、不載 MCP／skill／使用者設定、換掉預設系統提示，
 * 否則單次呼叫會帶進十幾萬 token 的工具與 skill 清單（實測未隔離 144k token，隔離後不到 1k）。
 * 不能改用 --bare：它只認 ANTHROPIC_API_KEY，用 OAuth 登入的環境會直接失敗。
 * 子 session 帶 COMPACT_HANDOFF_CHILD=1，compact 系列 hook 見到即退出，防遞迴；
 * cwd 設在系統暫存目錄，避免讀到專案的 settings 與 CLAUDE.md。
 *
 * 關鍵值：骨架只收助理的文字，工具回傳的測試數字、錯誤原文、commit、編號另由程式抽成清單交給模型，
 * 信寫完再用字串比對驗「自稱抄入的值是否原樣出現」（判準與寫信的模型不同源，才抓得到改寫）。
 * 非原樣分兩類：keysMangled＝去掉空白、標點、符號後找得到（改寫過），keysMissing＝完全找不到（自稱抄了其實沒寫進信）。
 * ⚠ effort low 下模型在信末「已處理：」「關鍵值：」兩行的自我回報不可靠（來源實例一次自稱抄 16 筆、12 筆不在信裡），
 *   流水帳的 asksOpen／keysClaimed／keysMissing 只能當參考。keysMangled 列出的每一筆都經程式比對信文確認是改寫，
 *   但只檢查模型自稱抄入的那幾筆：沒被自稱的值不在比對範圍內，空陣列不代表信裡沒有改寫過的值。
 *
 * 成本：每次壓縮開一個子 session，耗時與費用隨對話骨架長度增加。effort low 實測長對話 59～71 秒、短對話十幾秒；
 *   預設 effort 時為 35～245 秒、約 0.1～0.3 美元（effort low 的費用未重新統計）。
 *
 * 已知未解：
 * - 手動 /compact 帶說明時，PreCompact 輸入的 custom_instructions 實際值未實測（不帶說明與自動壓縮皆為 null）。
 * - 子 session 逾時被中止時會不會留下孫行程，未驗證。
 * - 同一段對話，模型判定的「未處理」句數每次不同，目前只用於統計。
 * - 「硬約束」標題下的排除說明（CLAUDE.md、memory 條文不列）只寫在原則第 7 條時沒生效、放到標題下才生效，樣本數 1。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
const MODEL = 'sonnet';        // 寫交接信的模型
// 思考強度：預設 effort 下思考 token 佔輸出八成且每次差很多，同一份輸入 183～245 秒、常撞逾時；
// low 實測 59～71 秒、思考 0，九節與關鍵值照樣產出（來源實例三輪評估，low 那輪零逾時、評審分數未變差）
const EFFORT = 'low';
// 交接信的語言與字形要求（寫進第 10 條原則）
const LANGUAGE_RULE = '繁體中文，字形一律用繁體，不得混入簡體字';
const HANDOFF_CHARS = 7500;    // 交接信長度上限（字元）；注入端整段上限見 compact-reinject.js 的 HANDOFF_MAX
const DIGEST_CAP = 120000;     // 送給模型的對話骨架上限（字元）
// 子 session 逾時（毫秒）。必須小於 settings 裡 PreCompact 的 timeout（範本接線為 240 秒），
// 留 20 秒給快照與寫檔；兩者要一起調。來源實例 180 秒時 4 次重寫逾時 2 次
const CHILD_TIMEOUT = 220000;
// 關鍵值標注的時間用哪個時區（小時偏移與顯示名稱）；resume-stale-reminder.js 另有一份同名設定
const TZ_OFFSET_HOURS = 8;
const TZ_LABEL = '台北時間';
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = '你是交接信撰寫者。只輸出交接信本身，不要前言或結語。';

const RULES = `以下是一段 Claude Code 對話的骨架（使用者原話、助理的回覆、工具呼叫的一行摘要、背景 agent 的回報），這段對話即將被壓縮。
請寫一份交接信，讓壓縮後的同一個助理讀完就能直接接著做事，不需要使用者重講背景。

原則：
1. 已完成的工作：每項最多兩句，只寫結果與證據位置（檔案路徑、commit、測試數字）。不寫過程。
2. 未完成的工作：盡量完整保留。每項寫出：目標（附使用者原話）、做到哪、下一步的具體動作、驗收標準、相關檔案路徑、卡在哪或在等誰決定。
3. 助理對使用者說過「我會…」「接下來…」「壓縮後我會…」而尚未兌現的承諾，一律列入未完成，引用原句。
4. 等使用者決定的事項列入未完成，附選項與助理的建議。做法：逐則掃過助理的每一則回覆，找出向使用者提問、請使用者操作或提議但未獲回應的句子（例如「要不要」「等你決定」「需要你」「你可以」「請你」「你要手動」），只要之後沒有使用者的明確回應，每一句都要列出，不得因為看起來次要而省略。服務、程序、環境目前的執行狀態（例如某個服務被重啟後仍在跑）也算未完成的上下文，要列出。
5. 已經寫進檔案的內容（報告、規格、diff、commit）只給路徑，不複製內文。
6. 對話中沒有實際執行驗證過的主張標「HYPOTHESIS」；被推翻過的主張註明「已推翻」。不要把推測寫成事實。同一件事在不同段落的說法必須一致（不可一處寫「已生效」、另一處寫未證實）。對話中前後說法不同時（例如先提設計、後來實作改了路徑），以最後的說法與工具實際操作的參數為準。
7. 使用者說過的話分兩類，各引原話：「硬約束」是禁止、必須、否決過的做法（「不要」「不准」「一律」「禁止」這類）；「偏好」是其餘傾向性的要求。只收使用者在對話中親口說的話；CLAUDE.md、memory、系統提示裡的條文壓縮後會自動重新載入，即使先前摘要把它們標成使用者約束也不要列。只寫使用者實際說過的話，不推斷他的態度：不得寫「使用者傾向…」「似乎偏好…」「可能希望…」這類推論句；沒回應不等於同意，也不等於反對。
8. 列出接手時建議呼叫的 skill。
9. 遮掉密碼、token、金鑰。
10. ${LANGUAGE_RULE}。總長 ${HANDOFF_CHARS} 字元以內；篇幅不夠時先壓縮「已完成」，「未完成」「硬約束」「關鍵值」不得刪減。
11. 使用者中途改過目標時，寫出目標版本：v1、v2 各引原話，並註明舊計畫哪些步驟已作廢，避免接手者照舊計畫繼續做。沒改過就寫「無」。
12. 試過但走不通的做法寫進「走過的死路」：做了什麼、為什麼不行、證據（錯誤訊息或測試結果原文）。這是做法層級的紀錄，與「已推翻」的主張不同；缺了它，接手者會把同一條路再走一遍。

輸出格式（照這個順序）：
## 未完成（完整保留）
## 目標版本
## 硬約束（使用者原話）
（只列使用者在對話中親口說的；CLAUDE.md、memory、先前摘要轉述的規則條文不列，壓縮後會自動重載。沒有就寫「無」）
## 關鍵值（原樣）
## 走過的死路
## HYPOTHESIS／已推翻
## 已完成（每項一兩句）
## 偏好（使用者原話）
## 建議 skill
（對話骨架後若附有「必查清單」或「關鍵值清單」，信的最後分別寫「已處理：」「關鍵值：」各一行，照清單後的說明寫；沒有附清單就不寫該行。）

=== 對話骨架開始 ===
`;

function text(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
}

function findString(v, pred) {
  if (typeof v === 'string') return pred(v) ? v : null;
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) { const r = findString(v[k], pred); if (r) return r; }
  }
  return null;
}

function toolLine(c) {
  const i = c.input || {};
  const hint = i.description || i.file_path || i.notebook_path || i.skill || i.pattern
    || (i.command ? String(i.command).slice(0, 120) : '') || '';
  return `[工具] ${c.name}: ${String(hint).replace(/\s+/g, ' ').slice(0, 160)}`;
}

// 對話骨架：以最後一次壓縮摘要為底，接上其後的原話、回覆、工具摘要、agent 回報
function buildDigest(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  const seenTask = new Set();   // 同一則通知會同時記在 queue-operation 與 user 訊息
  const toolNames = new Map();  // tool_use id -> 工具名，給工具回傳標來源
  const keys = [];
  let entries = [];
  for (const line of lines) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type === 'user' && o.isCompactSummary) {
      entries = [{ k: 'base', t: '[先前壓縮摘要]\n' + text(m && m.content) }];
      keys.length = 0;   // 壓縮前的值已由上一封交接信處理，只收這之後的
      continue;
    }
    if (line.includes('<task-notification>')) {
      // 通知可能落在 user 訊息、queue-operation 或 attachment，從已解析物件的字串值裡找
      const s = findString(o, v => v.includes('<task-notification>'));
      const r = s && s.match(/<task-id>([^<]+)<\/task-id>[\s\S]*?<summary>([\s\S]*?)<\/summary>(?:[\s\S]*?<result>([\s\S]*?)<\/result>)?/);
      if (r && !seenTask.has(r[1] + r[2])) {
        seenTask.add(r[1] + r[2]);
        entries.push({ k: 'agent', t: `[背景 agent 回報] ${r[2]}\n${(r[3] || '').slice(0, 1500)}` });
      }
      continue;
    }
    // 使用者在助理工作中途送出的訊息，記成 attachment(queued_command)，不是 user 訊息
    const a = o.attachment;
    if (o.type === 'attachment' && a && a.type === 'queued_command' && a.origin && a.origin.kind === 'human' && a.prompt) {
      entries.push({ k: 'user', t: '[使用者（中途插話）] ' + String(a.prompt).trim() });
      continue;
    }
    if (!m) continue;
    if (o.type === 'user' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'tool_result') collectKeys(keys, toolNames.get(c.tool_use_id), c.content, o.timestamp);
      }
    }
    if (o.type === 'user' && !o.isMeta) {
      const t = text(m.content).trim();
      const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
      if (cmd) {
        const args = t.match(/<command-args>([^<]*)<\/command-args>/);
        entries.push({ k: 'user', t: `[使用者] ${cmd[1]} ${args ? args[1] : ''}`.trim() });
        continue;
      }
      if (isHumanPrompt(t)) {
        entries.push({ k: 'user', t: '[使用者] ' + t });
      }
    }
    if (o.type === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text' && c.text.trim()) entries.push({ k: 'asst', t: '[助理] ' + c.text.trim() });
        if (c.type === 'tool_use') {
          entries.push({ k: 'tool', t: toolLine(c) });
          toolNames.set(c.id, toolTag(c));
        }
      }
    }
  }
  // 超過上限時先丟最舊的工具摘要，原話與回覆保留
  let total = entries.reduce((s, e) => s + e.t.length + 1, 0);
  for (let i = 0; i < entries.length && total > DIGEST_CAP; i++) {
    if (entries[i].k === 'tool') { total -= entries[i].t.length + 1; entries[i] = null; }
  }
  entries = entries.filter(Boolean);
  let digest = entries.map(e => e.t).join('\n');
  if (digest.length > DIGEST_CAP) digest = digest.slice(0, 8000) + '\n…（中段過長已略）…\n' + digest.slice(-(DIGEST_CAP - 8000));
  return { digest, asks: extractAsks(entries), keys: capKeys(keys) };
}

// 關鍵值清單：骨架只收助理的文字，工具回傳整段不進來，
// 助理沒轉述過的測試數字、錯誤原文、commit、編號因此到不了交接信（來源實例實測）。
// 這裡只抽原值，不塞工具回傳全文，否則骨架上限會被 log 吃光。
const KEY_RES = [
  /\b\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed)\b(?:,? \d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected))*(?: in [\d.]+s)?/,
  /\bTests?:\s+\d+ (?:passed|failed)\b.*$/i,
  // 錯誤行要以錯誤字樣開頭；只「提到」RuntimeError 的說明文字或程式字串不算（編譯器的 error CS／TS 例外，本來就在行中）
  // 前綴可有可無：TypeError: 與 Node 常見的裸 Error: ENOENT 都要收
  /^\s*(?:E\s+)?(?:(?:[A-Z]\w*)?(?:Error|Exception)\b[:(]|FAILED\b|Traceback\b|fatal:|npm ERR!).*$|^.*\berror (?:CS|TS)\d+.*$/,
  /\bExit code [1-9]\d*\b/,
  // 只收 HTTP 狀態碼；"code":"0000" 這類是業務回傳碼，抽進來只是雜訊
  /\bHTTP\/[\d.]+ \d{3}\b|"(?:status|statusCode)"\s*:\s*"?\d{3}(?!\d)"?/,
  /\[[\w./-]+ [0-9a-f]{7,12}\]|\bcommit [0-9a-f]{7,40}\b/,
  /\b(?:PR|MR) ?#\d+\b|\/pull\/\d+\b|\b[A-Z]{2,10}-\d{2,6}\b/,
];
// 讀檔與搜尋的回傳是原始碼，裡面的 Exception、FAILED 是程式字面，不是執行狀態。
// 用 shell 讀檔（cat 舊交接信、sed -n 看原始碼）同理，舊信裡的測試數字會被誤當成這輪的結果
const KEY_SKIP_TOOLS = /^(Read|Glob|Grep|Skill|ToolSearch|WebFetch|WebSearch|TodoWrite)$|^mcp__codebase-memory|:read$|:meta$/;
// 讀別的 session 的壓縮紀錄、交接信、transcript 時，裡面的測試數字與錯誤訊息屬於那個 session，
// 抽進來會被當成這輪的結果（來源實例曾把別處的 965 passed 寫成「最新一次跑通的 pytest」）。
// 樣式是這組 hook 自己產生的檔名（compact-snapshots、compact-log、*.handoff.md、*.summary.md）與 Claude Code 的
// transcript 目錄，換專案不必改；專案另有存放交接信或 session 紀錄的位置時再加進來
const META_SRC_RE = /compact-snapshots|compact-log|\.handoff\.md|\.summary\.md|[\\/]\.claude[\\/]projects[\\/]/;
function toolTag(c) {
  const i = c.input || {};
  const cmd = String(i.command || '');
  // 寧可漏抽也不誤抽：同一道指令順帶跑測試時，真的測試結果也會一起跳過。
  // 試過「指令含 pytest 等字樣就照常抽」，實測反而讓 6 筆別處的數字回流（測試腳本把 pytest 當字串夾具），真值一筆沒多抽到
  if (META_SRC_RE.test(cmd + ' ' + (i.file_path || ''))) return c.name + ':meta';
  return isReadCmd(cmd) ? c.name + ':read' : c.name;
}
// 讀檔指令之後不得再接管線或其他指令：cat log | grep -c 500 印的是算出來的數字，
// cat notes.md && pytest 後段是真的測試結果，這兩種都要照常抽
const READ_CMD_RE = /^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)?(?:cat|head|tail|less|type|sed\s+-n|Get-Content|gc)\b[^&;|\r\n]*$/;   // 換行等同接下一道指令
// 尾端的空白與換行不算下一道指令，先剝掉，否則單行讀檔帶個 \r 會被當成執行
function isReadCmd(cmd) { return READ_CMD_RE.test(cmd.replace(/\s+$/, '')); }

// 真人輸入的判定，壓縮快照、交接信骨架、resume 提醒、續跑評估共用同一份，
// 各寫一份時曾漏了 Another Claude session 這條而三處不一致
function isHumanPrompt(t) {
  if (!t || !t.trim()) return false;
  const s = t.trimStart();
  return !(s.startsWith('<') || s.startsWith('Another Claude session') || s.includes('<task-notification>')
    || s.includes('[SYSTEM NOTIFICATION') || s.startsWith('Base directory for this skill'));
}
const KEY_PER_RESULT = 6;
const KEY_MAX_ITEMS = 60;
const KEY_MAX_CHARS = 6000;

function localStamp(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return new Date(d.getTime() + TZ_OFFSET_HOURS * 3600000).toISOString().slice(5, 16).replace('T', ' ');
}

function collectKeys(keys, tool, content, ts) {
  if (!tool || KEY_SKIP_TOOLS.test(tool)) return;
  const body = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(c => c && c.type === 'text').map(c => c.text).join('\n') : '';
  if (!body) return;
  let n = 0;
  for (const line of body.split('\n')) {
    if (n >= KEY_PER_RESULT) break;
    for (const re of KEY_RES) {
      const r = line.match(re);
      if (!r) continue;
      // 包在引號裡的是被印出來的資料（JSON、測試夾具、字串常值），不是這次執行的狀態
      if (/["'`]$/.test(line.slice(0, r.index))) break;
      // 測試數字所在行夾中文，是交接信、報告這類人寫的敘述被印出來，不是測試工具的輸出
      if (KEY_RES.indexOf(re) < 2 && /\p{Script=Han}/u.test(line)) break;
      // msbuild 在錯誤行尾附專案路徑，長到會被截斷；抄進信的通常只到錯誤訊息，留著會誤判成漏抄
      const value = r[0].replace(/\s+\[[^\]]*\.(?:csproj|vbproj|fsproj|sln|proj)\]\s*$/, '').trim().slice(0, 240);
      // 單獨的「0 failed」沒有資訊量，完整的那行（N passed, 0 failed）另有一筆
      if (value.length > 3 && !/^0 (?:failed|errors?|skipped)$/.test(value)) { keys.push({ value, src: `${localStamp(ts)} ${tool}`.trim() }); n++; }
      break;
    }
  }
}

// 同一個值留最後一次（最新的狀態）；超量時保留較新的
function capKeys(keys) {
  const last = new Map();
  keys.forEach((k, i) => last.set(k.value, i));
  let list = keys.filter((k, i) => last.get(k.value) === i);
  let total = list.reduce((s, k) => s + k.value.length + k.src.length, 0);
  while (list.length > KEY_MAX_ITEMS || total > KEY_MAX_CHARS) { const k = list.shift(); total -= k.value.length + k.src.length; }
  return list;
}

// 必查清單：用字面規則從助理回覆撈出「問使用者／請使用者做／提議／仍在進行」的句子。
// 模型自己掃會漏且每次不同（實測兩輪各漏 4 項），這份清單逼它逐則看過。
// 只當輸入、不把沒勾的原句貼進信：來源實例實測撈 63 句、勾 7 句，貼上的 56 句占信的 55%，
// 大多是已完成事項或解說句，脫離上下文後讀不懂，還把注入額度吃到 96%。
const ASK_RE = /我會|我再|接下來|下一步|要不要|等你|需要你|你可以|請你|你要|你決定|由你|手動|要的話|告訴我|說一聲|還在跑|仍在跑|執行中|值得|順手|沒有處理|待決|尚未|之後再|下次/;
const ASK_MAX_ITEMS = 80;
const ASK_MAX_CHARS = 8000;
function extractAsks(entries) {
  const out = [];
  for (const e of entries) {
    if (e.k !== 'asst') continue;
    // 以行為單位（列點的主語多在行首，切成句子會丟掉「在講哪件事」）
    for (const s of e.t.replace(/^\[助理\]\s*/, '').split('\n')) {
      const t = s.trim();
      // 純標題行、冒號結尾的引言行沒有內容，不收
      if (/^#+\s|^\*\*[^*]+\*\*[：:]?$|[：:]$/.test(t) && t.length < 40) continue;
      if (t.length > 6 && ASK_RE.test(t)) out.push(t.slice(0, 320));
    }
  }
  // 總量上限：超過時保留較新的句子（早期的提問多半已在後續對話裡被回應）
  let list = [...new Set(out)];
  let total = list.reduce((s, x) => s + x.length, 0);
  while (list.length > ASK_MAX_ITEMS || total > ASK_MAX_CHARS) total -= list.shift().length;
  return list;
}

// 取最後一個以「<label>：」開頭的行並整行移除；模型在它後面多寫說明或分隔線時也要抓到
function takeMark(body, label) {
  const marks = [...body.matchAll(new RegExp(`^[ \\t]*${label}[：:][ \\t]*([^\\n]*)$`, 'gm'))];
  const mark = marks.length ? marks[marks.length - 1] : null;
  if (!mark) return { body, nums: new Set(), found: false };
  return {
    body: (body.slice(0, mark.index) + body.slice(mark.index + mark[0].length)).replace(/\n{3,}/g, '\n\n').trim(),
    nums: new Set((mark[1].match(/\d+/g) || []).map(Number)),
    found: true,
  };
}

function findClaude() {
  const cand = [path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')];
  for (const c of cand) if (fs.existsSync(c)) return c;
  return 'claude';
}

// 回傳 { ok, handoff, ms, cost, error }
function generateHandoff(transcriptPath, focus) {
  const t0 = Date.now();
  const { digest, asks, keys } = buildDigest(transcriptPath);
  const prompt = RULES + digest + '\n=== 對話骨架結束 ===\n'
    + (asks.length ? '\n=== 必查清單（程式從助理回覆撈出的提問／請託／提議／進行中狀態，共 ' + asks.length + ' 句）===\n'
      + asks.map((s, i) => `${i + 1}. ${s}`).join('\n')
      + '\n逐句對照對話骨架判定：之後使用者已明確回應、或助理已做完的算「已處理」。'
      + '沒處理的句子，把它講的事用完整的話寫進「未完成」（交代是哪件事、在等誰），不要貼原句；同一件事已經寫過就不重複。'
      + '在交接信最末另起一行，只寫「已處理：」加上已處理句子的編號（逗號分隔，例如「已處理：1,4,7」；都沒有就寫「已處理：無」）。這行程式會移除，只用來統計。\n' : '')
    + (keys.length ? '\n=== 關鍵值清單（程式從工具回傳撈出的原值，附' + TZ_LABEL + '與來源工具，共 ' + keys.length + ' 筆）===\n'
      + keys.map((k, i) => `${i + 1}. [${k.src}] ${k.value}`).join('\n')
      + '\n和「未完成」工作、使用者約束、目前最終狀態有關的值，抄進「## 關鍵值（原樣）」節：每筆一行：原值與 [時間 來源]，原值一個字元都不改（不翻譯、不改寫、不補空格）。對話骨架裡助理或使用者明講過這個值代表什麼，才照骨架的說法附一句；骨架沒講就只寫原值，不要自己推測用途或下「最新一次」「真正跑通」這類判斷。'
      + '已被後來的值取代的舊值、只屬於已結案事項的值不抄。'
      + '在交接信最末另起一行，只寫「關鍵值：」加上抄入的編號（例如「關鍵值：2,5,9」；都沒抄就寫「關鍵值：無」）。這行程式會移除，並逐筆檢查原值是否真的原樣出現在信裡。\n' : '')
    + (focus ? `\n使用者指定壓縮後的重點：${focus}\n請據此調整交接信的取捨。\n` : '');
  const cwd = path.join(os.tmpdir(), 'compact-handoff-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const r = spawnSync(findClaude(), [
    '-p', '--model', MODEL, '--effort', EFFORT, '--tools', '', '--setting-sources', 'local',
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--system-prompt', SYSTEM, '--output-format', 'json',
  ], { input: prompt, cwd, encoding: 'utf8', timeout: CHILD_TIMEOUT, maxBuffer: 16 * 1024 * 1024,
       env: Object.assign({}, process.env, { COMPACT_HANDOFF_CHILD: '1' }) });
  const ms = Date.now() - t0;
  if (r.error || r.status !== 0) {
    return { ok: false, ms, digestChars: digest.length, error: (r.error && r.error.message) || ('exit ' + r.status + ' ' + String(r.stderr || '').slice(0, 300)) };
  }
  try {
    const j = JSON.parse(r.stdout);
    if (j.is_error || !j.result) return { ok: false, ms, digestChars: digest.length, error: 'empty result' };
    // 「已處理」行只拿來統計（asksOpen＝模型判定仍未處理的句數），不進交接信
    // 取最後一個以「已處理」開頭的行；模型在它後面多寫說明或分隔線時也要抓到並整行移除
    let body = String(j.result).trim();
    // 沒附清單時提示詞沒要求寫標記行，信裡碰巧以「已處理：」開頭的句子不能被當標記刪掉
    const none = { body, nums: new Set(), found: false };
    const took = asks.length ? takeMark(body, '已處理') : none;
    body = took.body;
    const done = took.nums;
    // 模型沒寫「已處理」行就無從判定，記 null，不要當成全數未處理
    const asksOpen = took.found ? asks.filter((_, i) => !done.has(i + 1)).length : null;
    // 關鍵值：模型自稱抄了哪幾筆，程式用字串比對驗——判準和寫信的模型不同，才抓得到「說有抄、其實改寫了」
    const kt = keys.length ? takeMark(body, '關鍵值') : { body, nums: new Set(), found: false };
    body = kt.body;
    const claimed = [...kt.nums].filter(n => n >= 1 && n <= keys.length);
    const notVerbatim = claimed.filter(n => !body.includes(keys[n - 1].value));
    // 去掉標點空白後還找得到＝改寫過（逗號換頓號、縮短）；找不到＝自稱抄了其實沒寫進信。
    // effort low 下後者很常見（來源實例一次自稱 16 筆、12 筆根本不在信裡），兩者要分開看
    // 只剝空白、標點、符號；只留英數漢字的寫法會把 α／β、全形數字整段刪掉，讓不同值看起來一樣
    const loose = s => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
    const bodyLoose = loose(body);
    // 短值（去標點後不到 12 字元，如 Exit code 2 → exitcode2、HTTP/1.1 404 → http11404）在整封信裡
    // 容易碰巧拼出同一串，只放寬到空白與大小寫
    const spaced = s => s.replace(/\s+/g, ' ').toLowerCase();
    const bodySpaced = spaced(body);
    const found = v => loose(v).length < 12 ? bodySpaced.includes(spaced(v)) : bodyLoose.includes(loose(v));
    const mangled = notVerbatim.filter(n => found(keys[n - 1].value));
    const missing = notVerbatim.filter(n => !found(keys[n - 1].value));
    return { ok: true, ms, digestChars: digest.length, cost: j.total_cost_usd, handoff: body,
             asks: asks.length, asksOpen, markFound: took.found,
             keys: keys.length, keysClaimed: kt.found ? claimed.length : null,
             keysMangled: kt.found ? mangled.map(n => keys[n - 1].value) : null,
             keysMissing: kt.found ? missing.map(n => keys[n - 1].value) : null };
  } catch (e) {
    return { ok: false, ms, digestChars: digest.length, error: 'parse ' + e.message };
  }
}

module.exports = { buildDigest, generateHandoff, isHumanPrompt };
