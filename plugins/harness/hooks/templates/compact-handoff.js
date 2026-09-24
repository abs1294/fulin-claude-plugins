/**
 * 由 compact-snapshot.js（PreCompact）呼叫：壓縮前讓模型讀過對話骨架，寫一份交接信。
 * 本檔不是 hook，不必接線；與 compact-snapshot.js 放在同一個目錄即可。
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
 * 成本：每次壓縮 35～140 秒、約 0.1～0.3 美元，與對話骨架長度成正比。
 *
 * 已知未解：
 * - 手動 /compact 帶說明時，PreCompact 輸入的 custom_instructions 實際值未實測（不帶說明與自動壓縮皆為 null）。
 * - 子 session 逾時被中止時會不會留下孫行程，未驗證。
 * - 同一段對話，模型判定的「未處理」句數每次不同，目前只用於統計。
 * - 交接信偶爾把使用者的提問歸到「已推翻」，分類不精確。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
const MODEL = 'sonnet';        // 寫交接信的模型
const LANGUAGE = '繁體中文';    // 交接信語言
const HANDOFF_CHARS = 6000;    // 交接信長度上限（字元）；注入端整段上限見 compact-reinject.js 的 HANDOFF_MAX
const DIGEST_CAP = 120000;     // 送給模型的對話骨架上限（字元）
const CHILD_TIMEOUT = 180000;  // 子 session 逾時（毫秒）；PreCompact 接線的 timeout 要比它大
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
7. 列出使用者在對話中提出的約束、偏好、否決過的做法（引用原話）。只寫使用者實際說過的話，不推斷他的態度：沒回應不等於同意，也不等於反對。
8. 列出接手時建議呼叫的 skill。
9. 遮掉密碼、token、金鑰。
10. ${LANGUAGE}。總長 ${HANDOFF_CHARS} 字元以內；篇幅不夠時先壓縮「已完成」，「未完成」不得刪減。

輸出格式（照這個順序）：
## 未完成（完整保留）
## 已完成（每項一兩句）
## HYPOTHESIS／已推翻
## 使用者的約束與偏好
## 建議 skill
（對話骨架後若附有「必查清單」，信的最後一行必須是「已處理：」加編號，照清單後的說明寫；沒有附清單就不寫這行。）

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
  let entries = [];
  for (const line of lines) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type === 'user' && o.isCompactSummary) {
      entries = [{ k: 'base', t: '[先前壓縮摘要]\n' + text(m && m.content) }];
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
    if (o.type === 'user' && !o.isMeta) {
      const t = text(m.content).trim();
      const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
      if (cmd) {
        const args = t.match(/<command-args>([^<]*)<\/command-args>/);
        entries.push({ k: 'user', t: `[使用者] ${cmd[1]} ${args ? args[1] : ''}`.trim() });
        continue;
      }
      if (t && !t.startsWith('<') && !t.startsWith('Base directory for this skill') && !t.includes('[SYSTEM NOTIFICATION')) {
        entries.push({ k: 'user', t: '[使用者] ' + t });
      }
    }
    if (o.type === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text' && c.text.trim()) entries.push({ k: 'asst', t: '[助理] ' + c.text.trim() });
        if (c.type === 'tool_use') entries.push({ k: 'tool', t: toolLine(c) });
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
  return { digest, asks: extractAsks(entries) };
}

// 必查清單：用字面規則從助理回覆撈出「問使用者／請使用者做／提議／仍在進行」的句子。
// 模型自己掃會漏且每次不同（實測兩輪各漏 4 項），這份清單逼它逐則看過。
// 只當輸入、不把沒勾的原句貼進信：實測撈 63 句、勾 7 句，貼上的 56 句占信的 55%，
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

function findClaude() {
  const cand = [path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')];
  for (const c of cand) if (fs.existsSync(c)) return c;
  return 'claude';
}

// 回傳 { ok, handoff, ms, cost, error }
function generateHandoff(transcriptPath, focus) {
  const t0 = Date.now();
  const { digest, asks } = buildDigest(transcriptPath);
  const prompt = RULES + digest + '\n=== 對話骨架結束 ===\n'
    + (asks.length ? '\n=== 必查清單（程式從助理回覆撈出的提問／請託／提議／進行中狀態，共 ' + asks.length + ' 句）===\n'
      + asks.map((s, i) => `${i + 1}. ${s}`).join('\n')
      + '\n逐句對照對話骨架判定：之後使用者已明確回應、或助理已做完的算「已處理」。'
      + '沒處理的句子，把它講的事用完整的話寫進「未完成」（交代是哪件事、在等誰），不要貼原句；同一件事已經寫過就不重複。'
      + '在交接信最末另起一行，只寫「已處理：」加上已處理句子的編號（逗號分隔，例如「已處理：1,4,7」；都沒有就寫「已處理：無」）。這行程式會移除，只用來統計。\n' : '')
    + (focus ? `\n使用者指定壓縮後的重點：${focus}\n請據此調整交接信的取捨。\n` : '');
  const cwd = path.join(os.tmpdir(), 'compact-handoff-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const r = spawnSync(findClaude(), [
    '-p', '--model', MODEL, '--tools', '', '--setting-sources', 'local',
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
    const marks = [...body.matchAll(/^[ \t]*已處理[：:][ \t]*([^\n]*)$/gm)];
    const mark = marks.length ? marks[marks.length - 1] : null;
    let done = new Set();
    if (mark) {
      body = (body.slice(0, mark.index) + body.slice(mark.index + mark[0].length)).replace(/\n{3,}/g, '\n\n').trim();
      done = new Set((mark[1].match(/\d+/g) || []).map(Number));
    }
    // 模型沒寫「已處理」行就無從判定，記 null，不要當成全數未處理
    const asksOpen = mark ? asks.filter((_, i) => !done.has(i + 1)).length : null;
    return { ok: true, ms, digestChars: digest.length, cost: j.total_cost_usd, handoff: body,
             asks: asks.length, asksOpen, markFound: !!mark };
  } catch (e) {
    return { ok: false, ms, digestChars: digest.length, error: 'parse ' + e.message };
  }
}

module.exports = { buildDigest, generateHandoff };
