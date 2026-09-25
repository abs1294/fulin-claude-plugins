#!/usr/bin/env node
/**
 * guard-qa-dispatch — qa-webwright 的 PreToolUse(Agent|Task) hook：派 qa-engineer 的派工單表態閘。
 *
 * 為什麼：派工單上沒寫的那一格，QA 就不會測、不會問——範圍完整性是指揮官的責任，
 * 而「必須在派工單寫清楚」若只是文件裡的一句話，沒人盯的 session 會直接跳過。
 * 本閘只驗「派工單有沒有表態」，不判表態內容對不對（那要看程式碼與畫面，是 QA 本身的事）。
 *
 * 啟動條件：專案 tests/e2e/qa-webwright.json 存在且有 `dispatch_gate` 段；subagent_type 符合
 *   dispatch_gate.agent_regex（預設以 qa-engineer 結尾）。其餘一律靜默。
 * 預設檢查（dispatch_gate.checks 可改）：
 *   triage             【增量分流】明選 reuse（附既有 test 檔路徑）或 新TC（附一句理由）
 *   target_env         【目標環境】寫出站台／環境（不是空白、不是範本佔位）
 *   data_source        【測試資料來源】第一行開頭寫「選 a」「選 b」或「選 c」（固定格式，其他寫法一律不算表態）：
 *                        a＝走真實業務流程長出來（常態，不論成本）；
 *                        b＝封閉例外：該前置只由產品外部的系統產生、產品端沒有入口。理由必須①點名是哪一類外部系統邊界
 *                          ②附產品端證據的「檔名:行號」（守門或寫入點在哪）。只認允許的理由（白名單），不判推託詞——
 *                          推託的講法無限多，黑名單每修一種就漏另一種、還會誤擋正當描述（實證：連續三輪審查都在補句型）；
 *                        c＝依賴既有資料：只限字典／設定類，須附理由
 *   out_of_scope       【範圍外發現】範圍外看到的問題必報
 *   no_relay           明寫「本任務由你親自執行，不得再轉派」
 *   alignment          【開工前對齊】對齊結論或「無分岔＋理由」
 *   scope_expansion    【範圍展開】正向／反向（終止分支）／狀態序列／共用元件四格都要寫到
 *   field_verification 【欄位級驗證】逐欄比對寫入或顯示的值與 DB（或資料來源）實值
 * custom_checks 自訂 regex。
 * 必讀清單：dispatch_gate.required_reading 列的路徑必須出現在派工單（斜線方向、大小寫不拘）；
 *   required_reading_existing_only=true（預設）時只要求專案裡真的存在的檔。
 * 擋下：permissionDecision=deny，一次列完所有未過項並附範本（skills/browser-qa/SKILL.md「派工範本」）。
 * FAIL-OPEN：自身任何錯誤、設定壞掉 → 放行。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const G = require('./lib/qa-gate-common.js');

const DEFAULT_CHECKS = ['triage', 'target_env', 'data_source', 'out_of_scope', 'no_relay',
  'alignment', 'scope_expansion', 'field_verification'];

const DEFAULT_PARAMS = {
  triage: {
    tag: '【增量分流】',
    reuse_regex: '^(?:選擇|選用|選|採用|採|走|用)?\\s*[:：]?\\s*(?:reuse|沿用既有|沿用)',
    new_regex: '^(?:選擇|選用|選|採用|採|走|用)?\\s*[:：]?\\s*(?:新\\s*TC|新增\\s*TC|new\\s*TC)',
    reuse_evidence_regex: '[\\w./\\\\-]+\\.py\\b|\\.(?:spec|test)\\.[jt]sx?\\b',
    new_reason_regex: '理由|因為|原因|尚無|沒有|無既有|接不住|新畫面|新功能|新互動|視覺|why|because',
  },
  target_env: { tag: '【目標環境】' },
  data_source: {
    tag: '【測試資料來源】',
    option_words: {
      a: '走|真實|業務流程|產品入口|UI',
      b: '例外|外部系統|自種|自清|INSERT|seed|mock',
      c: '依賴|既有|字典|設定',
    },
    reason_required_for: ['b', 'c'],
    // c 的理由：出現字典／設定類字眼即算；否則取「理由／因為／原因」後面的文字，
    // 刪掉佔位字詞與全部空白、標點、符號後，剩下至少 2 個字才算有內容（計數判準，不列舉句型——
    // 列舉「佔位＋其後結束」的 regex 連兩輪都漏：待補充、TBD 之後補、（待補）（待補）…）
    reason_regex: '字典|設定類|設定|主檔',
    reason_marker_regex: '理由|因為|原因|why|because|reason(?![A-Za-z])',
    // b 的理由必須點名外部系統邊界的類別（參數檔 external_system_keywords 的關鍵字也一併認得）。
    // 刻意不收裸字 mock／callback／回呼：「直接 INSERT mock 資料」「callback 寫起來省事」都不是在說外部系統邊界
    exception_regex: '外部系統|外部簽核|簽核系統|簽核回呼|上游推送|上游系統|webhook|外部主檔|目錄服務|ldap',
    // b 的理由必須附產品端證據：程式碼檔的「檔名:行號」（守門或唯一寫入點在哪）。只驗有沒有這個形狀，不判內容對錯
    evidence_regex: '[\\w\\u4e00-\\u9fff./\\\\@\\[\\]+~-]+\\.(?:cs|js|mjs|cjs|ts|tsx|jsx|vue|py|java|kt|go|rb|php|sql|rs|swift|scala|sh|ps1|json|ya?ml|xml|c|h|cc|cpp|hpp)(?:[:：]|#L)\\d+',
  },
  out_of_scope: { regex: '【範圍外發現】|範圍外(?:的)?(?:發現|問題)' },
  no_relay: { regex: '不得再轉派|不得轉派|禁止二次轉派|親自執行' },
  alignment: { tag: '【開工前對齊】', regex: '對齊結論|無分岔|已對齊|分流例外' },
  scope_expansion: { tag: '【範圍展開】', required_parts: ['正向', '反向', '狀態序列', '共用元件'] },
  field_verification: { tag: '【欄位級驗證】', db_regex: '讀回|readback|DB|資料庫|查回|三方|落庫|實值' },
};

const TEMPLATE_HINT = '範本見 qa-webwright plugin 的 skills/browser-qa/SKILL.md「派工範本（主 Agent 派 qa-engineer 用）」'
  + '（照範本逐格填寫可一次過閘；也可 /qa-webwright:qa-run 讓命令替你套範本）。';

function merged(sec, id) {
  const base = DEFAULT_PARAMS[id] || {};
  const over = G.isObj(sec.params) && G.isObj(sec.params[id]) ? sec.params[id] : {};
  const out = Object.assign({}, base, over);
  if (G.isObj(base.option_words) || G.isObj(over.option_words)) {
    out.option_words = Object.assign({}, base.option_words || {}, over.option_words || {});
  }
  return out;
}

// 合併後的參數是否可用：tag 必須是非空字串、*regex 必須是可編譯的字串、option_words 的值可編譯、
// reason_required_for 是字串陣列。任何一項壞＝該項判準失效 → 該項 fail-open（不得因壞設定擋人）
function paramsOk(p) {
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (k === 'tag' && (typeof v !== 'string' || !v)) return false;
    if (/regex$/.test(k) && (typeof v !== 'string' || !G.re(v))) return false;
    if (k === 'option_words' && (!G.isObj(v) || Object.keys(v).some((L) => typeof v[L] !== 'string' || !G.re(v[L])))) return false;
    if ((k === 'reason_required_for' || k === 'required_parts') && !G.strList(v)) return false;
  }
  return true;
}

// 取【標籤】之後、到下一個【之前的作答區；沒有這格回 null
function segmentAfter(prompt, tag) {
  const i = prompt.indexOf(tag);
  if (i < 0) return null;
  return prompt.slice(i + tag.length).split('【')[0];
}

function plainLines(seg) {
  return String(seg)
    .replace(/[*_`#>]/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[ \t]*-[ \t]+/, '').trim())
    .filter((l) => l !== '');
}

function isPlaceholder(line) {
  return /^<[^>]*>\s*$/.test(line) || /^[<＜]/.test(line);
}

// ---- 各項檢查：回傳 problem 字串陣列（空＝通過）----

function checkTriage(prompt, p) {
  // 參數檔覆寫的 regex 壞掉（編不起來）＝判準失效 → 整項 fail-open（連「缺標籤」也不判，免得壞設定把人鎖住）
  if (!G.re(p.reuse_regex) || !G.re(p.new_regex)) return [];
  const seg = segmentAfter(prompt, p.tag);
  const how = p.tag + 'reuse：<要改的既有 test 檔路徑>（只加 assert／參數化，不開瀏覽器探索）'
    + '，或 ' + p.tag + '新TC：<一句理由：為何既有案例接不住>——擇一寫在該格最前面。';
  if (seg === null) {
    return ['[增量分流] 缺 ' + p.tag + '：設計前先盤點 tests/e2e/CATALOG.md 與對應 COVERAGE.md，明寫 reuse 或 新TC。'
      + '寫法：' + how];
  }
  const first = plainLines(seg)[0] || '';
  const reuse = G.re(p.reuse_regex);
  const fresh = G.re(p.new_regex);
  if (!first || isPlaceholder(first) || !((reuse && reuse.test(first)) || (fresh && fresh.test(first)))) {
    return ['[增量分流·未明選] ' + p.tag + ' 這格第一行沒看到明確選了 reuse 或 新TC（照抄範本佔位不算）。寫法：' + how];
  }
  if (reuse && reuse.test(first)) {
    const ev = G.re(p.reuse_evidence_regex);
    if (ev && !ev.test(seg)) {
      return ['[增量分流·缺路徑] 選了 reuse 但沒指名要改的既有 test 檔路徑（如 tests/e2e/cart/test_cart.py）。'
        + '指名路徑，QA 才知道只加 assert、不重新探索。'];
    }
    return [];
  }
  const why = G.re(p.new_reason_regex);
  if (why && !why.test(seg)) {
    return ['[增量分流·缺理由] 選了 新TC 但沒附理由：一句話說明為何既有案例接不住'
      + '（無既有覆蓋／新畫面／新互動／需視覺判斷）。'];
  }
  return [];
}

function checkTargetEnv(prompt, p) {
  const seg = segmentAfter(prompt, p.tag);
  const how = '寫法：' + p.tag + '<前端網址>（後端 API／登入身分來源若與預設不同也寫上；本機預設填一行 localhost 即可）。';
  if (seg === null) {
    return ['[目標環境] 缺 ' + p.tag + '：站台寫錯是最常見的整輪作廢原因，逼自己寫出來就會自己抓到。' + how];
  }
  const first = plainLines(seg)[0] || '';
  if (!first || isPlaceholder(first)) {
    return ['[目標環境·空白] ' + p.tag + ' 這格是空的或還是範本佔位。' + how];
  }
  return [];
}

// 範本佔位（<…>，可巢狀）由內往外剝乾淨，剝到沒有變化為止：佔位裡的示範文字（如「選 b，理由：…」）不算作答
function stripPlaceholders(s) {
  let out = String(s);
  for (;;) {
    const next = out.replace(/<[^<>]*>/g, ' ');
    if (next === out) return out;
    out = next;   // 每一輪至少少掉一對角括號，必定結束
  }
}

// 選項判定——固定格式（2026-09-25 使用者裁定）：該格第一行開頭必須是「選 a」「選 b」或「選 c」（「選擇：a」「選用 b」也算），後面再接理由。自由文字的判法試過五種——字母＋說明詞、否定詞清單、成對否定、第一子句、選字族優先——每一種都有新破口（「不用 a，選 b」判成 a、「本案可從畫面造出，選 a」判成沒選），故不再猜：同一支閘的【增量分流】早就是「第一行開頭寫 reuse 或 新TC」，從沒出過問題。
// 不算表態：第一行開頭不是「選 X」；第一個子句裡又出現別的選項字母（「選 a 或 c」）；
// 另一行也以「選 Y」開頭且字母不同（照抄「選 a／選 b」兩行）。
function pickedOptions(seg, words) {
  const letters = Object.keys(words);
  const cls = '[' + letters.join('') + ']';
  const head = new RegExp('^選(?:擇|用)?\\s*[:：]?\\s*(' + cls + ')(?![A-Za-z0-9])', 'i');
  // 行首的 Markdown 符號、編號（1. 1)）、標籤後直接接的冒號都不算作答內容
  const lines = stripPlaceholders(seg).split(/\r?\n/)
    .map((l) => l.replace(/^[\s*_`#>\-：:]+/, '').replace(/^[\d０-９]+[.)、．）]\s*/, '').trim()).filter((l) => l !== '');
  if (!lines.length) return [];
  const m = head.exec(lines[0]);
  if (!m) return [];
  const key = letters.find((x) => x.toLowerCase() === m[1].toLowerCase());   // 回傳參數檔裡的原始鍵名（大小寫照原樣）
  const rest = lines[0].slice(m[0].length).split(/[，,。；;：:（(]/)[0];
  if (letters.some((x) => x !== key && new RegExp('(^|[^A-Za-z0-9])' + x + '($|[^A-Za-z0-9])', 'i').test(rest))) return [];
  if (lines.slice(1).some((l) => {
    const k = head.exec(l);
    return k && k[1].toLowerCase() !== key.toLowerCase();
  })) return [];
  return [key];
}

// c 的理由有沒有真內容（計數判準，見 DEFAULT_PARAMS.data_source.reason_regex 的說明）
const PLACEHOLDER_WORDS = /待補[充中上齊]?|待確認|待定|之後再補|之後補|稍後補|再補|後補|之後|稍後|同上|沒有|無|(?<![A-Za-z])(?:(?:TBD)+|TODO|N\/?A|none|OK)(?![A-Za-z])|\.{2,}|…+/gi;
function hasReason(answer, p) {
  const kw = G.re(p.reason_regex);
  // 舊參數檔只覆寫 reason_regex、沒設 reason_marker_regex：維持舊語意，reason_regex 是唯一判準
  const D0 = DEFAULT_PARAMS.data_source;
  if (p.reason_regex !== D0.reason_regex && p.reason_marker_regex === D0.reason_marker_regex) return !kw || kw.test(answer);
  if (kw && kw.test(answer)) return true;
  const mk = G.re(p.reason_marker_regex);
  if (!mk) return true; // 參數壞：fail-open
  const m = mk.exec(answer);
  if (!m) return false;
  const rest = answer.slice(m.index + m[0].length).replace(PLACEHOLDER_WORDS, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return rest.length >= 2;
}

const ANSWER_NOTE = '（本閘只讀作答段：第一行起到空行，或到以 a./b./c.／（／⛔ 開頭的說明行為止——理由與證據要寫在這之前）';

// 作答段：第一個非空行起，到空行、或到以「a. b. c.」「（」「⛔」開頭的說明行為止。
// 範本常在同一格下方附選項說明與禁止清單（含外部系統字眼與「檔名:行號」），不得拿來頂替作答。
function answerBlock(seg, letters) {
  // 說明行可能帶 Markdown 前綴（- a.／> ⛔／* b.），與判「選 X」時剝的前綴同一套，先剝再判
  // 字母＋標點後面若是「一段不含空白的字串＋冒號或 #L＋數字」就是檔名（a.cs:12、c.Handler.cs:12），不是說明行；
  // 字母後接空白或一般文字的（b. …、b.Upstream …）仍是說明行
  const def = new RegExp('^\\s*(?:\\**\\s*[' + letters.join('') + ']\\**\\s*[.．、)）](?![A-Za-z0-9@\\[][\\w.\\-/@\\[\\]+~]*(?:[:：]|#L)\\d)|[（(]|⛔)', 'i');
  const out = [];
  for (const l of stripPlaceholders(seg).split(/\r?\n/)) {
    if (!out.length) {
      if (l.trim() !== '') out.push(l);
      continue;
    }
    if (l.trim() === '' || def.test(l.replace(/^[\s_`#>\-：:]+/, ''))) break;
    out.push(l);
  }
  return out.join('\n');
}

function checkDataSource(prompt, p, cfg) {
  const words = G.isObj(p.option_words) ? p.option_words : DEFAULT_PARAMS.data_source.option_words;
  for (const k of Object.keys(words)) if (!/^[a-z]$/i.test(k) || typeof words[k] !== 'string') return [];
  const menu = Object.keys(words).map((L) => L + '（' + words[L].split('|').slice(0, 2).join('／') + '）').join('／');
  const common = '三選一：a 走真實業務流程長出來（常態，不論成本）'
    + '／b 封閉例外（該前置只由產品外部的系統產生、產品端沒有入口：外部簽核回呼／上游推送／外部主檔 mock／目錄服務）'
    + '／c 依賴既有資料（僅限字典／設定類，期望值查來源推導）。'
    + '寫法：' + p.tag + '選 a；或「選 b，理由：<哪一類外部系統邊界>，證據：<產品端守門或寫入點的 檔名:行號>」。';
  const seg = segmentAfter(prompt, p.tag);
  if (seg === null) {
    return ['[測試資料來源] 缺 ' + p.tag + '：' + common];
  }
  const picked = pickedOptions(seg, words);
  if (picked.length === 0) {
    return ['[測試資料來源·未明選] ' + p.tag + ' 這格的第一行開頭要寫「選 a」「選 b」或「選 c」（固定格式；'
      + '先寫說明、後面才表態，或第一句同時提到兩個選項，都不算）。選項：' + menu + '。'
      + '⚠ 選 b 或 c 請一併附理由，否則補完選項會再撞「缺理由」——兩者有先後，不是漏報。' + common];
  }
  // 參數檔的選項鍵可能是大寫：比對一律不分大小寫
  const pk = picked.map((x) => String(x).toLowerCase());
  const need = (Array.isArray(p.reason_required_for) ? p.reason_required_for : [])
    .map((L) => String(L).toLowerCase()).filter((L) => pk.includes(L));
  const answer = answerBlock(seg, Object.keys(words));
  const problems = [];
  if (need.includes('b')) {
    const exc = G.re(exceptionSource(p, cfg));
    const ev = G.re(p.evidence_regex);
    const why = answer;
    if (exc && !exc.test(why)) {
      problems.push('[測試資料來源·非例外] ' + ANSWER_NOTE + '選了 b，但理由沒有點名是哪一類外部系統邊界'
        + '（外部簽核回呼／上游推送／外部主檔 mock／目錄服務；專案可在 external_system_keywords 擴充）。'
        + '成本、麻煩、跑得慢都不是例外——一律走 a，不論成本。'
        + '「產品沒有入口」是最常見的誤判——先問「這個前提測試自己造得出來嗎、順序能不能換」，造得出來就走 a。' + common);
    } else if (ev && !ev.test(why)) {
      problems.push('[測試資料來源·缺證據] ' + ANSWER_NOTE + '選了 b 並點名了外部系統類別，但沒附產品端證據：寫出守門或唯一寫入點的「檔名:行號」'
        + '（例：callback 處理器寫入核決結果的那一行）。沒有證據的例外主張，多半是還沒去看產品程式碼——'
        + '看了常會發現前提其實測試自己造得出來。' + common);
    }
  }
  if (need.includes('c') && !hasReason(answer, p)) {
    problems.push('[測試資料來源·缺理由] ' + ANSWER_NOTE + '選了 c 但沒附理由：說明為何屬字典／設定類——業務資料列一律不得走 c。一句話即可，但要寫。' + common);
  }
  return problems;
}

// b 的例外關鍵字：內建 exception_regex ＋ 參數檔 external_system_keywords 的每個字詞（字面比對）
function exceptionSource(p, cfg) {
  const parts = [];
  if (typeof p.exception_regex === 'string' && G.re(p.exception_regex)) parts.push(p.exception_regex);
  const kw = cfg && G.isObj(cfg.external_system_keywords) ? cfg.external_system_keywords : {};
  for (const k of Object.keys(kw)) {
    if (!G.strList(kw[k])) continue;
    for (const w of kw[k]) if (w) parts.push(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  return parts.join('|');
}

function checkRegex(prompt, p, label, how) {
  const rx = G.re(p.regex);
  if (rx && !rx.test(prompt)) return [label + ' ' + how];
  return [];
}

function checkTagFilled(prompt, p, label, how) {
  if (p.regex !== undefined && !G.re(p.regex)) return []; // 覆寫的 regex 壞＝判準失效 → 該項 fail-open
  const seg = segmentAfter(prompt, p.tag);
  if (seg === null) {
    if (p.regex && G.re(p.regex) && G.re(p.regex).test(prompt)) return [];
    return [label + ' 缺 ' + p.tag + '。' + how];
  }
  const first = plainLines(seg)[0] || '';
  if (!first || isPlaceholder(first)) return [label + ' ' + p.tag + ' 這格是空的或還是範本佔位。' + how];
  return [];
}

function checkScopeExpansion(prompt, p) {
  const how = '寫法：' + p.tag + '1 正向路徑：…；2 反向／終止分支（退件／拒絕／取消／軟刪／逾時／重送／權限不足，逐條列適用與否）：…；'
    + '3 狀態序列（做A→做B→撤銷A→存檔→重開）：…；4 受影響的共用元件（其他使用點是否連帶回歸）：…。任一格填「無」必附一句理由。';
  const base = checkTagFilled(prompt, p, '[範圍展開]', how);
  if (base.length) return base;
  const seg = segmentAfter(prompt, p.tag);
  const parts = G.strList(p.required_parts) ? p.required_parts : [];
  const miss = parts.filter((w) => seg.indexOf(w) < 0);
  if (!miss.length) return [];
  return ['[範圍展開·缺格] ' + p.tag + ' 缺：' + miss.join('、') + '。派工單漏掉的那一格，QA 結構上不會補——'
    + '單步操作測不出的鎖死型缺陷只有「狀態序列」抓得到，改共用元件不驗其他使用點會波及整站。' + how];
}

function checkFieldVerification(prompt, p) {
  const how = '寫法：' + p.tag + '本次涉及 <N> 個欄位，逐欄比對「畫面顯示值 ↔ API 回傳 ↔ DB 實值」；寫入型逐欄讀回 DB'
    + '（bool/int 用非預設值、集合驗筆數＋順序），不驗的欄位逐個列理由。純讀取頁同樣要拿畫面顯示值對 DB 實值。';
  const base = checkTagFilled(prompt, p, '[欄位級驗證]', how);
  if (base.length) return base;
  const rx = G.re(p.db_regex);
  if (rx && !rx.test(segmentAfter(prompt, p.tag))) {
    return ['[欄位級驗證·沒對 DB] ' + p.tag + ' 沒寫要拿什麼實值比對：「畫面有顯示／API 回 200／寫入成功」都不算驗過，'
      + '要下到 DB（或資料來源）實值逐欄比對。' + how];
  }
  return [];
}

function checkRequiredReading(prompt, sec, root) {
  if (!G.strList(sec.required_reading) || sec.required_reading.length === 0) return [];
  const existingOnly = sec.required_reading_existing_only !== false;
  const norm = G.toPosix(prompt).toLowerCase();
  const miss = [];
  for (const rel of sec.required_reading) {
    const want = G.toPosix(rel).replace(/^\.\//, '').toLowerCase();
    if (!want) continue;
    if (existingOnly && !fs.existsSync(path.resolve(root, rel))) continue;
    if (norm.indexOf(want) < 0) miss.push(rel);
  }
  if (!miss.length) return [];
  return ['[必讀清單] 派工單的【開工前必讀】缺：' + miss.join('、')
    + '（參數檔 dispatch_gate.required_reading）。這些是專案 QA 判準的入口——缺了它，QA 撞到判斷題只能憑感覺。'
    + '把路徑（絕對或相對皆可，斜線方向不拘）列進【開工前必讀】後重發。'];
}

function main() {
  const input = G.readInput();
  if (!input) return;
  const ti = G.isObj(input.tool_input) ? input.tool_input : {};
  const type = String(ti.subagent_type || '');
  if (!type) return;
  const got = G.loadSection(input, 'dispatch_gate', (s) => G.isObj(s));
  if (!got) return;
  const sec = got.sec;
  if (sec.agent_regex !== undefined && typeof sec.agent_regex !== 'string') return; // 型別錯＝設定壞 → 靜默
  const agentRe = G.re(typeof sec.agent_regex === 'string' ? sec.agent_regex : 'qa-engineer$');
  if (!agentRe || !agentRe.test(type)) return;
  const prompt = String(ti.prompt || '');

  // checks 有寫但型別錯＝設定壞 → 整支靜默（不得退回預設檢查項把人擋下）
  if (sec.checks !== undefined && !G.strList(sec.checks)) return;
  const checks = G.strList(sec.checks) ? sec.checks : DEFAULT_CHECKS;
  const problems = [];
  for (const id of checks) {
    const p = merged(sec, id);
    if (!paramsOk(p)) continue; // 覆寫參數壞（型別錯、regex 編不起來）→ 該項 fail-open
    if (id === 'triage') problems.push(...checkTriage(prompt, p));
    else if (id === 'target_env') problems.push(...checkTargetEnv(prompt, p));
    else if (id === 'data_source') problems.push(...checkDataSource(prompt, p, got.cfg));
    else if (id === 'out_of_scope') {
      problems.push(...checkRegex(prompt, p, '[範圍外發現必報]',
        '派工單必須要求 QA 回報範圍外看到的問題：加一格【範圍外發現】範圍外看到的異常一律列在報告「範圍外發現」節回報，不自行擴大修改、也不當作沒看到。'));
    } else if (id === 'no_relay') {
      problems.push(...checkRegex(prompt, p, '[親自執行]',
        '派工單必須明寫「本任務由你親自執行，不得再轉派給其他 agent」——回報鏈固定一跳，中繼 agent 轉送率極低；需要多個 agent 時由主對話分別派、分別收。'));
    } else if (id === 'alignment') {
      problems.push(...checkTagFilled(prompt, p, '[開工前對齊]',
        '寫法：【開工前對齊】對齊結論：<一句話>，或「無分岔：<一句理由>」。有決策型分岔（做成什麼樣／範圍／行為／交付給誰）要先跟使用者對齊到清零。'));
    } else if (id === 'scope_expansion') {
      problems.push(...checkScopeExpansion(prompt, p));
    } else if (id === 'field_verification') {
      problems.push(...checkFieldVerification(prompt, p));
    }
  }
  if (Array.isArray(sec.custom_checks)) {
    for (const c of sec.custom_checks) {
      if (!G.isObj(c)) continue;
      const rx = G.re(c.regex);
      if (!rx) continue;
      if (!rx.test(prompt)) {
        problems.push('[' + (c.label || c.id || '自訂檢查') + '] ' + (c.message || ('派工單需符合 ' + c.regex)));
      }
    }
  }
  problems.push(...checkRequiredReading(prompt, sec, got.loc.root));
  if (!problems.length) return;
  G.deny(G.listMessage('[qa-dispatch] 派 ' + type + ' 的派工單', problems,
    '補齊後重發**同一個** agent（不要改派其他 agent type 繞過）。' + TEMPLATE_HINT
    + '\n本閘由專案 tests/e2e/qa-webwright.json 的 dispatch_gate 段啟用；檢查項可用 dispatch_gate.checks 調整。'));
}

try {
  main();
} catch (_) {
  process.exitCode = 0; // FAIL-OPEN
}
