#!/usr/bin/env node
// PreToolUse(Agent|Task)：派「專案 agent」時，派工 prompt 必須帶上該 agent 的紀律標記，
// 缺就一次列完所有缺項並 deny。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Agent|Task", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/check-review-discipline.js\"", "timeout": 15 }] }]
//
// 背景：派工 prompt 該帶的紀律條款（回報鏈鐵則、驗收條件、回報格式……）若只寫在文件裡、
// 沒有機械檢查，實測會被跳過——派工單漏一項，subagent 照樣開工，缺口要等審查甚至上線
// 才被發現。這支 hook 保證「派工 prompt 有帶紀律條款的文字標記」，另對兩格驗「有沒有作答」（見下），
// 不驗內容對不對、也不驗 agent 有沒有真的照做——執行面仍要靠 agent 定義檔與 skill 正文把關。
//
// 為什麼不能只比對標題（來源專案實際發生過）：只驗「有沒有出現【測試資料來源】這幾個字」時，
// 寫了標題就過——選 a/b/c 哪個、選 b/c 有沒有附理由都不看，等於只擋「完全沒寫」。實測代價是全庫
// 幾十處寫死業務代碼、上百處直接 INSERT 業務主體表造狀態，而那些派工單多半都「有寫這格」；
// 【驗收條件】同理，整段範本貼上、只留佔位 <…> 也能過閘。所以這兩格改為驗作答：
//   【測試資料來源】（DATA_SOURCE_AGENTS）：①這格第一行要寫「選 a／選 b／選 c」（固定格式）
//     ②選 b 要附產品端證據「檔名:行號」 ③選 c 要附理由（為何屬字典／設定類）
//   【驗收條件】（ACCEPTANCE_BODY_AGENTS）：剝掉範本佔位 <…>、標題後的括號說明、條列符號後不能是空的
// 仍不判「選得對不對」「條件寫得好不好」——那要看程式碼與需求，是審查與 QA 的事。
//
// 一次列完所有未過的閘（不要一項一項擠牙膏）：若每次只回報一項，補一項撞一項，
// 派一個要連過多道閘的 agent 會被連續擋很多次，而且每次 deny 都燒一輪 context。
//
// 通用化說明：本範本的 REQUIRED_MARKERS 表格對齊 04-delegation-templates.md 的欄位標題——
// 共用四項（回報鏈鐵則、【驗收條件】、【回報格式】、【開工前必讀】，且必讀要寫到 CLAUDE.md、CONTEXT.md）＋依 agent 角色加碼的欄位（見填空區
// 註解）。這是通用骨架的預設表，**不含**任何特定專案自訂的紀律標記（例如某種靜態掃描
// 工具名、某種分流判準、某個環境的 port 對照）——專案要加自己的紀律時，直接在表裡
// 用同樣的形狀加一條（見填空區範例的「如何自加一條」）。
//
// fail-open：解析失敗或任何例外一律放行。派工內容檢查（驗作答那兩格）丟例外時同樣放行，
// 但用 additionalContext 告訴模型「派工內容檢查故障」（已有其他缺項要擋時併進 deny 理由）。

'use strict';

const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 每個「專案 agent」派工 prompt 必須含的紀律標記表。key 為 agent 名（不含 plugin 前綴），
// `'*'` 是所有專案 agent 共用、每個都要檢查的一組。每條規則：
//   name    — 這條規則的識別名（用於訊息與除錯）
//   pattern — 字串形式的 regex（大小寫不拘），命中即視為「已帶該標記」
//   hint    — 缺這項時給使用者的提示，講清楚該補什麼
//
// 表格對齊 04-delegation-templates.md 的模板欄位標題：
//   共用（'*'）：回報鏈鐵則（「不得轉派」或「親自執行」）、【驗收條件】、【回報格式】、【開工前必讀】，
//     且必讀清單一定要寫到 CLAUDE.md（專案概要）與 CONTEXT.md（專案用語）——所有角色都要讀
//   架構、實作、審查（backend-architect／backend-engineer／frontend-engineer／code-reviewer）另要寫到 FLOWS.md
//     （觸及已收錄鏈路就列入；沒觸及也寫一句，逼派工的人判斷一次——「有沒有觸及」機械判不了）
//   QA agent（例：qa-engineer）另加【範圍展開】【測試資料來源】，必讀清單要寫到 tests/Project_Detail/PROJECT.md
//   審查型 agent（例：code-reviewer）另加模板四的驗證欄位（【產出路徑】、【驗證方式】）
// 為什麼必讀也要擋：只寫在 agent 檔與 04 範本裡的必讀清單，實測派工時會漏（例：QA 派工沒列測試知識檔），
//   而 subagent 回報時也不會發現自己少讀了什麼。這支 hook 只驗「檔名有寫進 prompt」，有沒有真的讀，
//   靠回報的「已讀清單」與主對話核對（04「派工後的指揮官義務」第 1 條）。
// init 時照 Q1 定案的 agent 名單改 key；裁掉的角色整組刪掉；專案沒有某份知識筆記檔時刪掉對應那條。
//
// 專案要自加一條時，照同樣的形狀加進對應 agent 的陣列（或加進 '*' 讓全部 agent 都要過）：
//   { name: '某工具掃描', pattern: '某工具名', hint: '派工 prompt 必須要求跑 <某工具> 並附輸出' }
const REQUIRED_MARKERS = {
  '*': [
    {
      name: '回報鏈鐵則·禁二次轉派',
      pattern: '不得再?轉派|禁止二次轉派|親自執行',
      hint: '派工 prompt 必須明寫「本任務由你親自執行，不得再轉派給其他 agent」——回報鏈固定一跳，'
        + '需要多個 agent 時由主對話自己分別派、分別收。',
    },
    {
      name: '驗收條件',
      pattern: '【驗收條件】',
      hint: '派工 prompt 必須含【驗收條件】欄位，且每條要可機械判定（能回答「用什麼指令或什麼觀察來判定 PASS/FAIL」）。',
    },
    {
      name: '回報格式',
      pattern: '【回報格式】',
      hint: '派工 prompt 必須含【回報格式】欄位，講清楚回報要包含哪些內容（成果路徑＋關鍵行號＋結論，禁止噴大段代碼）；'
        + '有【開工前必讀】時，回報格式要要求列「已讀清單」。',
    },
    {
      name: '開工前必讀',
      pattern: '【開工前必讀】',
      hint: '派工 prompt 必須含【開工前必讀】：列出這個角色開工前要逐檔 Read 的檔案路徑（見 04-delegation-templates.md 共通規則）。',
    },
    {
      name: '必讀：專案概要',
      pattern: 'CLAUDE\\.md',
      hint: '【開工前必讀】要列 CLAUDE.md 的「專案概要」一節（這個專案在做什麼、哪個環境是正式、做到哪）。',
    },
    {
      name: '必讀：專案用語',
      pattern: 'CONTEXT\\.md',
      hint: '【開工前必讀】要列 CONTEXT.md（專案用語的定義；需求裡的詞以它為準）；專案沒有這個檔就寫「CONTEXT.md：專案沒有這個檔」。',
    },
  ],
  'backend-architect': [
    {
      name: '必讀：跨模組鏈路',
      pattern: 'FLOWS\\.md',
      hint: '【開工前必讀】要寫到 FLOWS.md：本需求觸及已收錄鏈路就列入必讀；沒觸及也要寫一句「FLOWS.md：沒觸及已收錄鏈路」，'
        + '讓派工的人當場判斷過一次。',
    },
  ],
  'backend-engineer': [
    {
      name: '必讀：跨模組鏈路',
      pattern: 'FLOWS\\.md',
      hint: '【開工前必讀】要寫到 FLOWS.md：本需求觸及已收錄鏈路就列入必讀；沒觸及也要寫一句「FLOWS.md：沒觸及已收錄鏈路」，'
        + '讓派工的人當場判斷過一次。',
    },
  ],
  'frontend-engineer': [
    {
      name: '必讀：跨模組鏈路',
      pattern: 'FLOWS\\.md',
      hint: '【開工前必讀】要寫到 FLOWS.md：本需求觸及已收錄鏈路就列入必讀；沒觸及也要寫一句「FLOWS.md：沒觸及已收錄鏈路」，'
        + '讓派工的人當場判斷過一次。',
    },
  ],
  'qa-engineer': [
    {
      name: '範圍展開',
      pattern: '【範圍展開】',
      hint: '派 QA agent 的 prompt 必須含【範圍展開】：至少涵蓋正向路徑、反向／終止分支、狀態序列、'
        + '受影響的共用元件四格；封閉的 TC 清單是最常見的失敗形狀——指揮官漏想的情境，QA 結構上不會補。',
    },
    {
      name: '測試資料來源',
      pattern: '【測試資料來源】',
      hint: '派 QA agent 的 prompt 必須含【測試資料來源】：表明測試資料怎麼來（走真實業務流程／自種自清／'
        + '依賴既有字典資料），並說明理由；禁止硬編業務 Id 或使用者身分當輸入。',
    },
    {
      name: '必讀：測試知識',
      pattern: 'tests[\\\\/]Project_Detail[\\\\/]PROJECT\\.md',
      hint: '【開工前必讀】要列 tests/Project_Detail/PROJECT.md（本專案測試時踩過的坑、測試環境位址與測試設計知識）；專案沒有這個檔就寫「tests/Project_Detail/PROJECT.md：專案沒有這個檔」。',
    },
  ],
  'code-reviewer': [
    {
      name: '產出路徑',
      pattern: '【產出路徑】',
      hint: '派審查型 agent 的 prompt 必須含【產出路徑】：列出要驗證的產出檔案絕對路徑清單。',
    },
    {
      name: '驗證方式',
      pattern: '【驗證方式】',
      hint: '派審查型 agent 的 prompt 必須含【驗證方式】：講清楚審查者要怎麼驗（重新 Read 產出檔、跑哪些指令），'
        + '審查者的預設立場是「不相信它完成了，找證據」。',
    },
    {
      name: '必讀：跨模組鏈路',
      pattern: 'FLOWS\\.md',
      hint: '【開工前必讀】要寫到 FLOWS.md：改動觸及已收錄鏈路時，審查要確認鏈路其他層有沒有同步；沒觸及也要寫一句「FLOWS.md：沒觸及已收錄鏈路」。',
    },
  ],
};

// 派工內容檢查（見檔頭「為什麼不能只比對標題」）。名單用 agent 名（不含 plugin 前綴）；'*'＝表中所有專案 agent。
// 只在該格標題存在時驗內容——標題整個沒寫，由上面的標記表報缺，不重複報。
// 【驗收條件】要有實際內容的 agent。
const ACCEPTANCE_BODY_AGENTS = ['*'];
// 【測試資料來源】要驗作答的 agent（通常只有 QA agent；Q1 裁掉 QA 時清空）。
const DATA_SOURCE_AGENTS = ['qa-engineer'];
// ────────────────────────────────────────────────────────────────────────────

// 取「【標題】」之後、到下一格標題之前的內容當作該格的作答區；沒有這格回 null。
// 「下一格標題」＝換行後緊接的【…】（行首可有空白與 markdown 記號 > * _ # -，例：「**【回報格式】**」「- 【範圍展開】」）。
// 不切在任意「【」：作答內容常引用別處（「選 b：見【規格】src/x.py:3」），切在那裡會把證據切掉而誤擋。
// 不用已知標題清單：04 模板的欄位標題都寫在行首，而專案自加的欄位不必回頭維護清單；
// 已知限制：作答內容自己有一行以「【」開頭時會被當成下一格（把引用寫在行中即可）。
function fieldSegment(prompt, title) {
  // 先找出現在行首的標題（前面只能是空白與 markdown 記號）：前文在句子中間提到「依下方【測試資料來源】造」時，
  // 取第一次出現會切到那一句，底下照格式作答也被判沒作答。沒有行首的才退回第一次出現。
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp('(?:^|\\n)[ \\t>*_#-]*' + esc).exec(prompt);
  const i = head ? head.index + head[0].length - title.length : prompt.indexOf(title);
  if (i < 0) return null;
  const rest = prompt.slice(i + title.length);
  const next = /\n[ \t>*_#-]*【/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
// 範本佔位（<…>，可巢狀）由內往外剝到沒有變化為止：佔位裡的示範文字不算作答
function stripPlaceholders(s) {
  let out = String(s);
  for (;;) {
    const next = out.replace(/<[^<>]*>/g, ' ');
    if (next === out) return out;
    out = next;
  }
}
// 04 範本在標題同一行附了括號說明（「【驗收條件】（逐條判定）」「【測試資料來源】（必填，三選一…）」），不算作答
// 剝掉標題後面的括號說明。說明裡可能還有一層括號（「…附「檔名:行號」（說明為何…），選 c…」），
// 只剝到第一個右括號的話，剩下半句會被當成作答——照範本正確作答也被擋。所以數括號深度，剝到配對的那個為止
function dropHeadingNote(seg) {
  const m = /^[ \t]*[（(]/.exec(seg);
  if (!m) return seg;
  let depth = 0;
  for (let i = m[0].length - 1; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\n') return seg;   // 說明沒在同一行收尾：不剝，照原樣判
    if (c === '（' || c === '(') depth++;
    else if ((c === '）' || c === ')') && --depth === 0) return seg.slice(i + 1);
  }
  return seg;
}

function acceptanceIsEmpty(prompt) {
  const seg = fieldSegment(prompt, '【驗收條件】');
  if (seg === null) return false;   // 沒有這格由標記表報
  const body = stripPlaceholders(dropHeadingNote(seg)).split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•>]+|[\d０-９]+[.)、．）])\s*/, '')).join('');
  return body.replace(/[\s\p{P}\p{S}]/gu, '') === '';
}

// 回缺失訊息陣列（空＝通過）
function dataSourceProblems(prompt) {
  const raw = fieldSegment(prompt, '【測試資料來源】');
  if (raw === null) return [];      // 沒有這格由標記表報
  const seg = stripPlaceholders(dropHeadingNote(raw));
  const COMMON = '（04-delegation-templates.md 模板六）該格**第一行開頭**寫「選 a」「選 b」或「選 c」，後面接理由：'
    + 'a 走真實業務流程長出來（首選）；b 自種自清（寫入後取回自己建的 Id＋teardown 自刪），要附為何不走 a 所根據的產品端證據「檔名:行號」'
    + '（例：上游推送的唯一寫入點、擋住入口的守門）；c 依賴既有資料，僅限字典／設定類，要說明為何屬這類。'
    + '範本裡 a./b./c. 的說明與 ⛔ 清單可以留著，但作答要寫在它們前面。請在 prompt 補上後重發同一個 agent。';

  // 作答段：第一個非空行起，到空行、或到以「a. b. c.」「（」「⛔」開頭的說明行為止。
  // 範本在同一格下方附 a/b/c 說明與 ⛔ 清單，裡面有「檔名:行號」樣的字，不得頂替作答
  // （來源專案實際發生過：整段範本貼上、只填「選 b，理由：比較快」就放行）。
  const answer = (() => {
    const out = [];
    for (const l of seg.split(/\r?\n/)) {
      if (!out.length) { if (l.trim() !== '') out.push(l); continue; }
      if (l.trim() === '' || /^\s*(?:\**\s*[abc]\**\s*[.．、)）](?![A-Za-z0-9@\[][\w.\-/@\[\]+~]*(?:[:：]|#L)\d)|[（(]|⛔)/i
        .test(l.replace(/^[\s_`#>\-：:]+/, ''))) break;
      out.push(l);
    }
    return out.join('\n');
  })();

  // 選項判定——固定格式：第一行開頭必須是「選 a」「選 b」「選 c」（「選擇：a」「選用 b」也算）。
  // 自由文字的判法在來源專案試過五種（字母＋說明詞、否定詞清單、成對否定、第一子句、選字族優先），每一種都有新破口
  // （「不用 a，選 b」判成 a、「本案可從畫面造出，選 a」判成沒選），故不再猜。
  const picked = (() => {
    const head = /^選(?:擇|用)?\s*[:：]?\s*([abc])(?![A-Za-z0-9])/i;
    const lines = seg.split(/\r?\n/)
      .map((l) => l.replace(/^[\s*_`#>\-：:]+/, '').replace(/^[\d０-９]+[.)、．）]\s*/, '').trim()).filter((l) => l !== '');
    if (!lines.length) return null;
    const m = head.exec(lines[0]);
    if (!m) return null;
    const L = m[1].toLowerCase();
    // 第一句同時提到別的選項（「選 a 或 b」）不算明選
    const rest = lines[0].slice(m[0].length).split(/[，,。；;：:（(]/)[0];
    if (['a', 'b', 'c'].some((x) => x !== L && new RegExp('(^|[^A-Za-z0-9])' + x + '($|[^A-Za-z0-9])', 'i').test(rest))) return null;
    // 同一行後面又寫了另一個「選 X」（「選 a，選 b」）也不算明選
    const again = /選(?:擇|用)?\s*[:：]?\s*([abc])(?![A-Za-z0-9])/gi;
    let k;
    while ((k = again.exec(lines[0].slice(m[0].length))) !== null) if (k[1].toLowerCase() !== L) return null;
    // 後面又出現另一個「選 X」（前後矛盾）也不算
    if (lines.slice(1).some((l) => { const k = head.exec(l); return k && k[1].toLowerCase() !== L; })) return null;
    return L;
  })();

  if (!picked) {
    // 沒選之前談「缺理由／缺證據」沒有意義，但補完選項後可能再撞那兩項——訊息先講明，不讓人以為補完這項就結束
    return ['[測試資料來源·未明選] prompt 有【測試資料來源】這格，但沒看到明確選了 a／b／c 哪一個。寫標題不算表態；'
      + '先寫說明、後面才表態，或第一句同時提到兩個選項，都不算。⚠ 選 b 或 c 的話請一併附上證據／理由，'
      + '否則補完選項會再撞一次「缺證據／缺理由」——這兩項在邏輯上有先後，不是漏報。' + COMMON];
  }
  const out = [];
  if (picked === 'b') {
    // 只認作答段裡的「檔名:行號」（或 檔名#L行號）；推託詞不列舉，改要求看過產品程式碼的證據
    const EVIDENCE = /[\w\u4e00-\u9fff./\\@\[\]+~-]+\.(?:cs|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|java|kt|go|rb|php|sql|rs|swift|dart|scala|sh|ps1|json|ya?ml|xml|c|h|cc|cpp|hpp|m|ex|exs|html|cshtml|razor)(?:[:：]|#L)\d+/;
    if (!EVIDENCE.test(answer)) {
      out.push('[測試資料來源·缺證據] （只讀作答段：第一行起到空行，或到以 a./b./c.／（／⛔ 開頭的說明行為止）選了 b，'
        + '但沒附產品端證據：寫出「為何不走真實流程」所根據的程式位置「檔名:行號」（上游推送的唯一寫入點、擋住入口的守門、'
        + '真流程要經過的那幾個入口）。沒去看產品程式碼就主張走不了真流程，多半是誤判。' + COMMON);
    }
  }
  if (picked === 'c') {
    // 理由要真的寫出內容：出現字典／設定類字眼即算；否則取「理由／因為／原因」後面的文字，刪掉佔位詞與全部空白、標點、符號，
    // 剩下至少 2 個字才算（不列舉句型——列舉「佔位＋其後結束」的 regex 在來源專案連兩輪都漏）
    const hasReason = (() => {
      if (/字典|設定類|設定|主檔/.test(answer)) return true;
      const m = /理由|因為|原因|why|because|reason(?![A-Za-z])/i.exec(answer);
      if (!m) return false;
      return answer.slice(m.index + m[0].length)
        .replace(/待補[充中上齊]?|待確認|待定|之後再補|之後補|稍後補|再補|後補|之後|稍後|同上|沒有|無|(?<![A-Za-z])(?:(?:TBD)+|TODO|N\/?A|none|OK)(?![A-Za-z])|\.{2,}|…+/gi, '')
        .replace(/[\s\p{P}\p{S}]/gu, '').length >= 2;
    })();
    if (!hasReason) {
      out.push('[測試資料來源·缺理由] （只讀作答段）選了 c 但沒附理由：說明「為何屬字典／設定類」——業務資料列一律不得走 c。'
        + '一句話即可，但要寫。' + COMMON);
    }
  }
  return out;
}

let raw = '';
let contentCheckError = null;
function contentCheckNote() {
  return '[派工紀律] ⚠ 派工內容檢查故障（' + (contentCheckError && contentCheckError.message)
    + '）：【驗收條件】有沒有寫內容、【測試資料來源】有沒有作答這次沒檢查到，已放行（標記表的檢查照常）。'
    + '請自行確認這兩格有作答；hook 鏽蝕要修（.claude/hooks/check-review-discipline.js），勿靜默忽略。';
}
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const reasons = [];
  try {
    const input = JSON.parse(raw);
    const ti = input.tool_input || {};
    // plugin 安裝時 agent 名可能帶前綴（"plugin:agent"），剝掉前綴再比對。
    const type = String(ti.subagent_type || '').split(':').pop();
    const prompt = String(ti.prompt || '');

    const rulesForType = (REQUIRED_MARKERS[type] || []);
    const commonRules = (REQUIRED_MARKERS['*'] || []);
    // 只有「表中有列出的 agent 名」才視為專案 agent 並套共用規則；未列出的（例如
    // general-purpose、Explore 這類內建通用 agent）不受本閘管轄。
    const isManaged = Object.prototype.hasOwnProperty.call(REQUIRED_MARKERS, type);
    const rules = isManaged ? [...commonRules, ...rulesForType] : [];

    for (const rule of rules) {
      const re = new RegExp(rule.pattern, 'i');
      if (!re.test(prompt)) {
        reasons.push(`[${rule.name}] ${rule.hint} 請在 prompt 補上後重發同一個 agent，不得改派其他 agent type 繞過本檢查。`);
      }
    }
    // 派工內容檢查：標題在、但沒作答（見檔頭）。
    // 自己包一層 try：這段丟例外時放行（fail-open），但要讓模型知道這項沒檢查到——
    // 包在外層空 catch 裡的話會靜默放行，hook 壞了沒人發現。
    const inList = (list) => isManaged && (list.includes('*') || list.includes(type));
    try {
      if (inList(ACCEPTANCE_BODY_AGENTS) && acceptanceIsEmpty(prompt)) {
        reasons.push('[驗收條件·沒寫內容] 【驗收條件】只有標題、或只剩範本佔位 <…>：逐條列出可機械判定的 PASS/FAIL 條件，'
          + '每一條都要答得出「用什麼指令或什麼觀察來判定」（04 共通規則）。請在 prompt 補上後重發同一個 agent。');
      }
      if (inList(DATA_SOURCE_AGENTS)) reasons.push(...dataSourceProblems(prompt));
    } catch (e) {
      contentCheckError = e;
    }
  } catch (e) {}

  if (reasons.length) {
    const head = reasons.length === 1
      ? '[派工紀律] 派工 prompt 有 1 項未過閘，補齊後重發同一個 agent（不得改派其他 agent type 繞過）：'
      : '[派工紀律] 派工 prompt 有 ' + reasons.length + ' 項未過閘，'
        + '**以下全部補齊後一次重發**同一個 agent（不得改派其他 agent type 繞過）。'
        + '⚠ 這是本次的完整清單，不會再有第二批——逐項對照補完再送：';
    const body = reasons.map((r, i) => '\n\n' + (i + 1) + '. ' + r).join('');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: head + body + (contentCheckError ? '\n\n' + contentCheckNote() : ''),
      },
    }));
  } else if (contentCheckError) {
    // 放行但要讓模型知道：PreToolUse 以 exit 0 結束時純文字 stdout 模型看不到，要包成 additionalContext
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: contentCheckNote() },
    }) + '\n');
  }
  process.exit(0);
});
