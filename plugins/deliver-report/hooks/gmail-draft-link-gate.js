#!/usr/bin/env node
/**
 * gmail-draft-link-gate — deliver-report plugin 的第三支 Stop hook
 *
 * 守的是**寄出去就收不回來**的那一段：Gmail 草稿的內容。
 * 既有兩支閘掃的是檔案（.docx / 待寄的 .md），**草稿本身沒有任何人掃**——
 * 而它才是真正會到外人手上的東西。本 hook 補這個缺口。
 *
 * 為什麼要 hook：這些規則都寫在 SKILL.md 第三步之三，但那是自律——AI 會跳過。
 *       而下面每一條的共同形狀是**我方看草稿預覽看不出來**，要等對方收到/貼上
 *       才會爆（見本 repo memory「skill MANDATORY 是自律、hook 才是他律」）。
 *
 * 本 hook 不碰 Gmail API、不需要憑證——它只讀 transcript 裡**已經發生過**的
 * 工具呼叫與回傳，所以沒設定憑證的人也能用。
 *
 * ── 六項檢查（全部只提醒，不硬擋）────────────────────────────
 *
 * 【網址被改寫】2026-09-15 實打驗證
 *   Gmail 把純文字 body 裡的網址改寫成 https://www.google.com/url?q=<原網址>&source=gmail…
 *   對方照貼就貼到錯的位址——nginx 轉址目標變成 Google、curl 指令打到 Google。
 *   純文字下所有規避寫法（去掉 scheme、包 []、包 <>、縮排四格、零寬空格）全部失效，
 *   只有 htmlBody 能保住顯示文字。
 *   (A) 建了含網址的草稿但沒 get_draft 讀回 → 提醒去檢查
 *   (B) 讀回的**顯示文字**裡驗出 url?q=     → 提醒草稿已經壞了、要重建
 *   ★ 關鍵判準：`href="...url?q=..."` 是**正常的**，不算壞。Gmail 對 htmlBody
 *     只改寫 href，標籤之間的顯示文字原封不動——那正是對方複製到的東西。
 *     所以偵測前必須先剝掉標籤屬性，只看顯示文字；少了這步會把「已經正確
 *     處理好的 htmlBody 草稿」誤判成壞掉（假陽性）。
 *
 * 【掉出信串】(C) update_draft 之後 threadId 變成自己的 id
 *   實案（2026-09-15 nuvoton）：create_draft 回 threadId=1a0678c431c772e9（正確），
 *   update_draft 後變成 1a0a58271da7ab89（自己的 id）——草稿靜默脫離原討論串，
 *   送出去會變成一封新信、不接在對方那封底下。**Gmail 介面上看不出來**。
 *   判準是純機械的：同一個 draftId 的 threadId 前後不一致。
 *
 * 【佔位符外流】(D) body 裡留著 [xxx] / <xxx> / ___ 這類填空提示
 *   SKILL.md 三個鐵則之一：「永遠不留 <收件人> 這種佔位符」，第三步之三也明文
 *   禁止把網址代換成 [站台網址]（2026-09-15 使用者當面退過）。對方看不懂要填什麼。
 *
 * 【Markdown 外流】(E) body 裡有 **粗體** / ## 標題 / |表格|
 *   2026-09-15 實打驗證：Gmail 純文字**原樣顯示**成星號與井號，不會渲染。
 *
 * 【機敏內容】(F) 憑證／個資 命中 references/banned-patterns.json
 *   與 doc-readability-gate、content_guard 共用同一份樣式（改一次三邊生效）。
 *   草稿是對外的，這類東西外流比寫進內部文件嚴重。
 *
 * 【公文式敬稱】(F) 同上，但**只提醒不下判斷**
 *   ★ 依易讀性鐵則 14：中文沒有詞邊界，「貴司」命中「貴司機」、「本中心」命中
 *     「成本中心」，實測 28 個誘餌全部誤判。故此組**天生是 advisory**，
 *     訊息措辭必須寫成「請確認」而非「有錯」——誤判會訓練使用者忽略警告。
 *
 * ★ 提醒頻率：同一封草稿的同一類問題只提醒一次。狀態以 draftId+檢查類別 為鍵，
 *   避免使用者決定「這封就這樣、不改了」之後每講一句話都被唸。
 *
 * ★ 最高原則：FAIL-OPEN。任何讀檔失敗、解析例外、判斷不確定 → 一律放行。
 *   這 hook 影響 session 能不能結束，寧可漏擋，絕不卡死。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'deliver-report', 'draft-link-gate');

// Gmail 轉址連結的特徵。ust/sa 參數會變，只認前綴。
const REWRITE_MARK = 'google.com/url?q=';

const WRITE_TOOLS = ['create_draft', 'update_draft'];
const READ_TOOL = 'get_draft';

// ---- 共用禁用樣式（references/banned-patterns.json）----
// 與 doc-readability-gate.js、content_guard.py 讀同一份：改一次三邊生效。
// ★ FAIL-OPEN：讀不到 / 壞掉 → 回退到內建最小清單，絕不因此吵使用者。
//
// applies_to 的處理：這份檔的既有值是 'docx' / 'daily'，都沒有 'draft'。
// 草稿的風險輪廓最接近「對外交付」，故取 credentials / pii（外流不可逆）
// 與 formal_honorifics（advisory），不取 email / money（那是日報專屬的
// 內部資訊防護，交付信裡出現金額與信箱是正常的，套上去會全是誤報）。
const HARD_KEYS = ['credentials', 'pii'];
const ADVISORY_KEYS = ['formal_honorifics'];

function loadBanned() {
  const out = { hard: [], advisory: [] };
  try {
    const f = path.join(__dirname, '..', 'references', 'banned-patterns.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const key of Object.keys(j)) {
      if (key.startsWith('_')) continue;
      const bucket = HARD_KEYS.indexOf(key) !== -1 ? 'hard'
                   : ADVISORY_KEYS.indexOf(key) !== -1 ? 'advisory' : null;
      if (!bucket) continue;
      const g = j[key] || {};
      for (const src of g.patterns || []) {
        // (?i) 前綴轉成 JS 的 i flag（JS 不支援行內 (?i)）
        let flags = 'g', body = src;
        if (body.startsWith('(?i)')) { body = body.slice(4); flags += 'i'; }
        try { out[bucket].push({ label: g.label || key, re: new RegExp(body, flags) }); }
        catch (_) { /* 單一 pattern 壞掉 → 略過該條，不影響其餘 */ }
      }
      for (const lit of g.literals || []) {
        out[bucket].push({ label: g.label || key, lit });
      }
    }
  } catch (_) { /* 讀不到就只剩內建 fallback */ }
  if (!out.hard.length) {
    // 最小內建：憑證形狀（誤判率極低，且外流不可逆）
    for (const src of ['GOCSPX-[A-Za-z0-9_-]{6,}', '\\bAIza[A-Za-z0-9_-]{20,}',
                       '\\bya29\\.[A-Za-z0-9_-]{10,}', '\\bsk-[A-Za-z0-9]{20,}',
                       '-----BEGIN [A-Z ]*PRIVATE KEY-----']) {
      try { out.hard.push({ label: '憑證與密碼', re: new RegExp(src, 'g') }); } catch (_) {}
    }
  }
  return out;
}
const BANNED = loadBanned();

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try { main(stdinData); } catch (_) { allow(); }
});

function allow() { process.exit(0); }
function warn(msg) {
  let json;
  try { json = JSON.stringify({ systemMessage: msg }); } catch (_) { return allow(); }
  try { process.stdout.write(json, () => process.exit(0)); } catch (_) { allow(); }
}

// ---- 主判定 ----

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return allow(); }

  const turn = turnBlocks(input.transcript_path);
  if (turn === null) return allow();

  // 本回合有沒有建/改草稿？沒有就不關我的事。
  const writes = turn.uses.filter((b) => isGmailTool(b.name, WRITE_TOOLS));
  if (!writes.length) return allow();

  // 這些草稿裡，哪些是「信裡真的有網址」的？沒網址的本來就不會被改寫。
  // ⚠ 這個名單只用來決定「網址類」的兩項檢查(A)(B)——**不可以在這裡 return**，
  //   否則佔位符／Markdown／機敏內容三項對「沒有網址的草稿」就完全不檢查了。
  const risky = writes.filter((b) => hasUrl(draftText(b.input)));

  const draftIds = new Set();
  for (const b of risky) {
    const id = resultDraftId(turn.results.get(b.id));
    if (id) draftIds.add(id);
  }

  const st = readState();
  const reads = turn.uses.filter((b) => isGmailTool(b.name, READ_TOOL));

  // 一輪只出一次聲：把六項檢查的結果收在一起，最後合成一則訊息。
  // 分開 warn 會只有第一則送得出去（writeThenExit 會 process.exit）。
  const sections = [];
  const claimed = [];       // 本次要記帳的 key（確定要出聲才寫入狀態）
  const claimedLink = [];   // (B) 專用：只有拿得到 draftId 的才記帳

  // key 為 null＝拿不到穩定識別，這次照樣出聲但**不記帳**（下次仍會提醒）。
  // 這是刻意的取捨：重複提醒只是吵，記錯帳會讓真問題永久靜默。
  function once(key, produce) {
    if (key !== null && st.warned.indexOf(key) !== -1) return;
    const text = produce();
    if (!text) return;
    if (key !== null) claimed.push(key);
    sections.push(text);
  }

  // ── (B) 有讀回，而且顯示文字驗出被改寫 → 這封已經壞了 ──
  const broken = [];
  for (const b of reads) {
    const res = turn.results.get(b.id);
    if (!res) continue;
    if (inspectDraftResult(res) !== true) continue;
    const id = safeStr(b.input && b.input.draftId);
    // ★ 取不到 draftId 就用「不記帳」的臨時標記：舊版一律退成 '(未知 draftId)'，
    //   於是第二封不同的壞草稿會撞到同一個 key 而**永久靜默**（2026-09-15 對抗審查實測）。
    //   寧可重複提醒，也不要讓真的壞掉的草稿無聲無息。
    const key = id ? 'link:' + id : null;
    const label = id || '(未知 draftId)';
    if ((key === null || st.warned.indexOf(key) === -1) && broken.indexOf(label) === -1) {
      broken.push(label);
      if (key) claimedLink.push(key);
    }
  }
  if (broken.length) {
    for (const k of claimedLink) claimed.push(k);
    sections.push(
      `■ 網址被改寫，這封草稿已經壞了（${broken.length} 封）：${broken.join('、')}\n` +
      '  讀回來的「顯示文字」裡出現 google.com/url?q= ——不是 href 被包（那是正常的），\n' +
      '  是對方複製到的內容本身就是錯的位址，照貼會貼到 Google。\n' +
      '  修法：改用 htmlBody、可貼內容包 <pre>，body 純文字版換成「完整內容見報告第 N 節」的\n' +
      '  指路句；重建後再 get_draft 確認一次。（SKILL.md 第三步之三）'
    );
  }

  // ── (A) 建了含網址的草稿，但沒有「有效地」讀回檢查 ──
  // 只對「真的含網址」的草稿提醒——沒網址就不會被改寫，讀回也沒意義。
  //
  // ★ 兩個 2026-09-15 對抗審查實測抓到的漏報，都已修掉：
  //   1. **逐封比對，不是全域計數**。舊版只看「本回合有沒有任何一次 get_draft」，
  //      於是讀了 A 草稿就會讓「沒讀的 B 草稿」一起被當成已檢查。
  //   2. **只認「讀得到內容」的讀回**。`messageFormat: MINIMAL` 的回傳不含
  //      htmlBody/plaintextBody，(B) 判不出、(A) 又被抑制——兩項同時失效。
  //      故這裡只把「回傳真的帶內容欄位」的 get_draft 算作有效檢查。
  const verifiedIds = new Set();
  for (const b of reads) {
    if (!resultHasBody(turn.results.get(b.id))) continue;   // MINIMAL 之類的不算
    const rid = safeStr(b.input && b.input.draftId);
    if (rid) verifiedIds.add(rid);
  }
  const unverified = Array.from(draftIds).filter((id) => !verifiedIds.has(id));
  if (risky.length && unverified.length) {
    // 同理：拿不到 draftId 就不記帳（turn.pid 是行號，會重複）。
    const key = 'noread:' + unverified.join(',');
    once(key, () =>
      '■ 建了含網址的草稿，但沒有讀回來檢查\n' +
      '  Gmail 會把純文字 body 裡的網址改寫成自家轉址連結（google.com/url?q=...），\n' +
      '  對方照貼就貼到錯的位址——而且看草稿預覽看不出來。\n' +
      '  請跑一次 get_draft（messageFormat: FULL_CONTENT），檢查 htmlBody 裡\n' +
      '  「標籤之間的顯示文字」有沒有 google.com/url?q=（href 裡有是正常的、不用管）。'
    );
  }

  // ── (C) update_draft 之後掉出原信串 ──
  for (const id of detachedThreads(turn)) {
    once('thread:' + id, () =>
      `■ 草稿掉出原信串了：${id}\n` +
      '  update_draft 之後 threadId 變成草稿自己的 id，代表它已經不接在原討論串下——\n' +
      '  送出去會變成一封新信，對方看不出是在回哪一封。Gmail 介面上看不出來。\n' +
      '  修法：刪掉重建，用 create_draft 帶 replyToMessageId（原信的 message id，\n' +
      '  不是 thread id），建完確認回傳的 threadId 仍是原信串。（SKILL.md 第三步之三 要點 1）'
    );
  }

  // ── (D)(E)(F) 內容層檢查：逐封草稿掃 body / htmlBody ──
  for (const b of writes) {
    // ★ 只有拿得到穩定的 draftId 才記帳。舊版退成 `turn:<行號>`，
    //   而行號極易在不同 session／不同草稿間重複，一旦記帳就**永久靜默**
    //   （2026-09-15 對抗審查實測）。拿不到就每次都提醒——寧可吵，不可漏。
    const id = resultDraftId(turn.results.get(b.id)) || safeStr(b.input && b.input.draftId);
    const text = draftText(b.input);
    if (!text.trim()) continue;

    const ph = findPlaceholders(text);
    if (ph.length) {
      once(id ? 'ph:' + id : null, () =>
        `■ 草稿裡還留著佔位符：${ph.slice(0, 5).join('、')}` +
        (ph.length > 5 ? `（另有 ${ph.length - 5} 處）` : '') + '\n' +
        '  對方看不懂那要填什麼。收件人沒指定就只寫「Hi,」，不要留 <收件人>；\n' +
        '  網址不要代換成 [站台網址]——真的不能貼就指到報告第 N 節並說明原因。\n' +
        '  （SKILL.md 鐵則 ①、第三步之三）'
      );
    }

    const md = findMarkdown(text);
    if (md.length) {
      once(id ? 'md:' + id : null, () =>
        `■ 草稿裡有 Markdown 語法：${md.join('、')}\n` +
        '  實測 Gmail 純文字會原樣顯示成星號與井號，不會渲染成粗體或標題。\n' +
        '  排版改用空行與「項目：值」一行一條。（SKILL.md 第三步之三 格式）'
      );
    }

    const hits = scanBanned(text, BANNED.hard, true);      // 憑證／個資一律遮蔽
    if (hits.length) {
      once(id ? 'banned:' + id : null, () =>
        `■ 草稿裡有機敏內容：${hits.join('；')}\n` +
        '  草稿是要寄給外人的，這類東西外流收不回來。寄出前務必確認並移除。\n' +
        '  （樣式來源：references/banned-patterns.json，與另外兩支閘共用）'
      );
    }

    const adv = scanBanned(text, BANNED.advisory, false);   // 敬稱不遮蔽，見 scanBanned 註解
    if (adv.length) {
      once(id ? 'adv:' + id : null, () =>
        `□ 請確認是否為公文式敬稱（可能誤判，只是提醒）：${adv.join('；')}\n` +
        '  對方一律寫「您們」、自稱寫「我們」。但中文沒有詞邊界，「貴司」會命中\n' +
        '  「貴司機」、「本中心」會命中「成本中心」——是誤判就忽略這行。\n' +
        '  （易讀性鐵則 14：本組天生只提醒、不判定）'
      );
    }
  }

  if (!sections.length) return allow();

  st.warned = st.warned.concat(claimed);
  writeState(st);
  return warn(
    '【Gmail 草稿檢查】寄出去就收不回來，請先確認以下幾點（不影響結束）：\n\n' +
    sections.join('\n\n')
  );
}

// ---- 判定 helpers ----

// MCP 工具名長這樣：mcp__claude_ai_Gmail__create_draft。只比對尾段，
// 避免不同 MCP server 前綴（個人 / Workspace）就漏抓。
function isGmailTool(name, suffixes) {
  const n = safeStr(name);
  if (n.toLowerCase().indexOf('gmail') === -1) return false;
  const list = Array.isArray(suffixes) ? suffixes : [suffixes];
  return list.some((s) => n.endsWith(s));
}

// 草稿送出去的文字：body + htmlBody 都算（htmlBody 也可能有裸網址）。
function draftText(input) {
  if (!input || typeof input !== 'object') return '';
  return safeStr(input.body) + '\n' + safeStr(input.htmlBody);
}

// 信裡有沒有網址。判準刻意寬鬆——漏提醒的代價遠高於多提醒一次。
// 抓 scheme 開頭、或裸的 www.x.y（Gmail 對後者也會改寫並自動補 http://，實測確認）。
function hasUrl(s) {
  if (!s) return false;
  if (/https?:\/\/\S/i.test(s)) return true;
  if (/\bwww\.[a-z0-9-]+\.[a-z]{2,}/i.test(s)) return true;
  return false;
}

/**
 * 掉出信串的草稿 id。判準純機械：同一個 draftId 在本回合出現過兩個不同的 threadId，
 * 而且最後那個 threadId 等於它自己的 messageId（＝這封草稿自成一串）。
 *
 * 實案（2026-09-15 nuvoton）：
 *   create_draft → {"id":"r714…","messageId":"1a0a57d7811cfb39","threadId":"1a0678c431c772e9"}
 *   update_draft → {"id":"r714…","messageId":"1a0a58271da7ab89","threadId":"1a0a58271da7ab89"}
 * 後者 threadId === messageId，且與前者的 threadId 不同 → 脫串。
 *
 * 只有「前後都看得到」才判定：單獨一次 create_draft 的 threadId===messageId 是
 * **新信的正常樣子**，不能算脫串（否則每封新信都會誤報）。
 */
function detachedThreads(turn) {
  const seen = new Map();   // draftId -> [{threadId, messageId}, ...]
  for (const b of turn.uses) {
    if (!isGmailTool(b.name, WRITE_TOOLS)) continue;
    const res = turn.results.get(b.id);
    const s = resultText(res);
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch (_) { continue; }
    if (!o || typeof o.id !== 'string') continue;
    if (typeof o.threadId !== 'string' || typeof o.messageId !== 'string') continue;
    if (!seen.has(o.id)) seen.set(o.id, []);
    seen.get(o.id).push({ threadId: o.threadId, messageId: o.messageId });
  }

  const out = [];
  for (const [id, hist] of seen) {
    if (hist.length < 2) continue;                       // 只有一次 → 判不出，放行
    const last = hist[hist.length - 1];
    if (last.threadId !== last.messageId) continue;      // 最後仍掛在某串下 → 沒掉出去

    // ★ 基準是「最後一次之前，最近一次真的掛在別串上」的觀測，不是第一筆。
    //   2026-09-15 對抗審查抓到的漏洞：用 hist[0] 當基準時，
    //   [自成一串 → 掛入 T → 又自成一串] 這種歷程會被「本來就是新信」跳過，
    //   漏掉中間那次真的掉串。
    let attached = null;
    for (let i = hist.length - 2; i >= 0; i--) {
      if (hist[i].threadId !== hist[i].messageId) { attached = hist[i]; break; }
    }
    if (!attached) continue;                             // 從頭到尾都沒掛過串 → 沒有串可掉
    if (attached.threadId === last.threadId) continue;   // 串沒變 → 正常
    out.push(id);
  }
  return out;
}

/**
 * 找出殘留的填空佔位符。
 *
 * ★ 誤判防護：中括號與角括號在正常信裡有合法用途（法規條號、程式碼片段、
 *   <pre> 等 HTML 標籤），硬抓會全是誤報，而誤報會訓練使用者忽略警告
 *   （見易讀性鐵則 14 的同型教訓）。所以只抓**明顯是填空提示**的形狀：
 *     - 內含「收件人 / 公司 / 姓名 / 網址 / 日期 / 金額 / 名稱 / xxx / TODO」等填空字眼
 *     - 或整段是底線（___）
 *   HTML 標籤（<p>、<pre>、</a>…）以「第一個字元是英文字母或斜線」排除。
 */
function findPlaceholders(text) {
  const out = [];
  // 只認「明顯是填空提示」的字眼。刻意不含「公司／單位／名稱」這類
  // 正常語句也會用的詞——2026-09-15 對抗審查實測，`[公司] 欄位已完成`
  // 這種正常句子會被誤報，而誤報會訓練使用者忽略警告。
  const HINT = /(收件人|待填|請填|填入|TODO|xxx|XXX|ooo|OOO|某某|站台網址|公司名稱|單位名稱)/;
  const push = (v) => { if (out.indexOf(v) === -1 && out.length < 20) out.push(v); };

  let m;
  const sq = /\[([^\]\n]{1,30})\]/g;
  while ((m = sq.exec(text)) !== null) {
    if (HINT.test(m[1])) push(m[0]);
  }
  const ang = /<([^>\n]{1,30})>/g;
  while ((m = ang.exec(text)) !== null) {
    const inner = m[1];
    if (inner.indexOf('@') !== -1) continue;              // <a@b.com> 是信箱寫法
    // HINT 命中就算（含 <TODO>、<xxx> 這類全 ASCII 的填空提示——
    // 舊版用「開頭是英文字母就跳過」排除 HTML 標籤，連帶把它們一起漏掉了）。
    if (HINT.test(inner)) { push(m[0]); continue; }
    if (/^[A-Za-z/!]/.test(inner)) continue;              // 其餘英文開頭視為 HTML 標籤
  }
  // 連續底線：排除網址/識別字裡的 a___b，只抓「前後不是英數」的填空線
  if (/(^|[^0-9A-Za-z\u4e00-\u9fa5])_{3,}([^0-9A-Za-z\u4e00-\u9fa5]|$)/.test(text)) push('___');
  return out;
}


/**
 * 找出會原樣顯示的 Markdown 語法。2026-09-15 實測：Gmail 純文字不渲染，
 * `**粗體測試**` 與 `## 標題` 原封不動出現在收件者眼前。
 *
 * 只抓三種高信心形狀，且都要求「成對 / 行首」，避免把
 * 「3 * 4 * 5」或「# 1 案」誤判。
 */
function findMarkdown(text) {
  const out = [];
  // 三條都要求「像 Markdown 而不像算式/編號」——2026-09-15 對抗審查實測，
  // 舊版會把 `2 ** 3 ** 2`、`# 123 號訂單`、`|x|` 誤報。
  // 粗體：** 後面第一個字不能是空白，內容至少兩字且不得只有數字與運算子
  if (/\*\*[^\s*][^*\n]{0,60}\*\*/.test(text) &&
      !/^\s*[\d\s*+\-/().]+$/.test(text)) out.push('**粗體**');
  // 標題：# 後面接空白再接「非數字」——`# 123 號訂單` 是編號不是標題
  if (/^#{1,6}\s+[^\s\d]/m.test(text)) out.push('## 標題');
  // 表格：一行裡至少要有兩個 | 分隔出的欄位，且整行長度 > 4，排除 |x|
  if (/^\s*\|[^|\n]+\|[^|\n]*\|/m.test(text)) out.push('|表格|');
  return out;
}


/**
 * 掃共用禁用樣式，回傳可讀的命中清單。
 *
 * `doMask` 分流：憑證／個資要遮蔽（否則提醒訊息本身變成第二次外洩），
 * 但敬稱這類**本來就不機敏**的詞不能遮——遮成「貴司***」使用者根本看不出
 * 命中的是哪個詞，也就無法判斷是不是誤判（而這組天生就會誤判）。
 */
function scanBanned(text, rules, doMask) {
  const out = [];
  // 長度上限：正則掃描的成本隨內容長度成長，而信裡內嵌 base64 圖片動輒數十萬字元。
  // 2026-09-15 對抗審查實測：共用樣式中一條無上界量詞的規則，在 160k 字元要跑 23.6 秒，
  // 超過 hooks.json 給的 15 秒 timeout → 這支閘會被逾時中止（靜默失效，正是最該防的）。
  // 該規則已加上界，但這裡再加一道**不同判準**的兜底：施作與驗證用同一套判準時，
  // 驗證器對施作器的盲區完全同構，不可能發現漏掉什麼。
  // 只掃前 200KB：機敏內容幾乎都在信件正文開頭，尾端多半是內嵌圖片的 base64。
  if (typeof text === 'string' && text.length > 200000) text = text.slice(0, 200000);
  for (const r of rules || []) {
    let hit = null;
    if (r.lit) {
      if (text.indexOf(r.lit) !== -1) hit = r.lit;
    } else if (r.re) {
      try { r.re.lastIndex = 0; const m = r.re.exec(text); if (m) hit = m[0]; } catch (_) { continue; }
    }
    if (!hit) continue;
    const v = doMask === false ? `「${hit}」` : `${r.label}：${mask(hit)}`;
    if (out.indexOf(v) === -1 && out.length < 10) out.push(v);
  }
  return out;
}

// 遮蔽命中值，避免提醒訊息本身變成第二次外洩。
function mask(s) {
  const t = String(s);
  if (t.length <= 8) return t.slice(0, 2) + '***';
  return t.slice(0, 4) + '***' + t.slice(-2);
}

// 這筆 get_draft 的回傳是否真的帶了信件內容欄位。
// `messageFormat: MINIMAL` / `METADATA_ONLY` 不含 htmlBody / plaintextBody，
// 拿它當「已檢查」會讓 (A)(B) 兩項同時失效（2026-09-15 對抗審查實測）。
function resultHasBody(res) {
  const s = resultText(res);
  if (!s) return false;
  try {
    const o = JSON.parse(s);
    if (o && typeof o === 'object') {
      return typeof o.htmlBody === 'string' || typeof o.plaintextBody === 'string';
    }
  } catch (_) { /* 非 JSON → 下面走字串比對 */ }
  return s.indexOf('htmlBody') !== -1 || s.indexOf('plaintextBody') !== -1;
}

// create_draft / update_draft 的回傳裡的 draft id。
function resultDraftId(res) {
  const s = resultText(res);
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if (o && typeof o.id === 'string') return o.id;
  } catch (_) { /* 不是 JSON 就算了 */ }
  const m = s.match(/"id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * 檢查一筆 get_draft 回傳：true=顯示文字被改寫 / false=乾淨 / null=判不出。
 *
 * 核心步驟是**先剝掉標籤屬性再找特徵字**。Gmail 對 htmlBody 的處理是
 * 「href 換成轉址連結、顯示文字不動」，所以 href 裡有 url?q= 完全正常；
 * 只有剝完還留著，才代表對方會複製到錯的東西。
 */
function inspectDraftResult(res) {
  const s = resultText(res);
  if (!s) return null;
  if (s.indexOf(REWRITE_MARK) === -1) return false;   // 整包都沒有 → 乾淨

  let html = null, plain = null;
  try {
    const o = JSON.parse(s);
    if (o && typeof o === 'object') {
      html = typeof o.htmlBody === 'string' ? o.htmlBody : null;
      plain = typeof o.plaintextBody === 'string' ? o.plaintextBody : null;
    }
  } catch (_) { /* 非 JSON（截斷、外溢檔路徑…）→ 下面走保守路徑 */ }

  if (html === null && plain === null) {
    // 解析不出結構化欄位。這時無法區分 href 與顯示文字，硬判會製造假陽性
    // （正確處理好的 htmlBody 草稿也會命中）——依 fail-open 原則放棄判定。
    return null;
  }

  if (html !== null && visibleTextHasMark(html)) return true;

  // 只有純文字草稿（沒有 htmlBody）時才看 plaintextBody。
  // 有 htmlBody 的情況下 plaintextBody 是退路副本，依 SKILL.md 那裡本來就
  // 不該放可貼內容，不拿它當判準，否則會對「已按規則處理」的草稿誤報。
  if (html === null && plain !== null && plain.indexOf(REWRITE_MARK) !== -1) return true;

  return false;
}

/**
 * 取出 HTML 的「可見文字」，再找特徵字。
 *
 * ★ 不能只用 `replace(/<[^>]*>/g,'')` 一招——2026-09-15 對抗審查實測，
 *   四種正常 HTML 會被誤判成壞掉（而 href 被改寫本來就是正常的）：
 *     - 屬性值裡有 `>`：`<a title="1 > 0" href="…url?q=…">` 只刪到 title 的第一個 `>`，href 留下
 *     - HTML 註解裡有 `>`：`<!-- 說明 > …url?q=… -->` 同理
 *     - `<script>` / `<style>` 內容：只刪起訖標籤，不可見的程式碼留下
 *     - 未閉合標籤：`<a href="…url?q=…`（結尾被截斷）整段留下
 *
 * 所以順序是：先整段移除 註解 / script / style，再移除「完整標籤」
 * （標籤的正則要能吃掉引號內的 `>`），最後把尾端未閉合的 `<…` 一併丟掉。
 */
function visibleTextHasMark(html) {
  let text;
  try {
    text = String(html);
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');                     // HTML 註解（含內部的 >）
    text = text.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' '); // 不可見內容整段
    text = text.replace(/<(script|style)\b[\s\S]*$/i, ' ');            // 未閉合的 script/style
    // 完整標籤：屬性值用引號包住時，允許其中出現 `>`
    text = text.replace(/<\/?[A-Za-z!?][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g, ' ');
    text = text.replace(/<[^>]*$/, ' ');                               // 尾端未閉合的殘缺標籤
  } catch (_) { return false; }
  // &amp; 在顯示文字裡會還原成 &，特徵字前綴本身不含 &，不受影響。
  return text.indexOf(REWRITE_MARK) !== -1;
}

// tool_result 的 content 可能是字串，也可能是 [{type:'text',text:...}]。
function resultText(res) {
  if (!res) return '';
  const c = res.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let out = '';
    for (const b of c) {
      if (b && typeof b.text === 'string') out += b.text;
      else if (typeof b === 'string') out += b;
    }
    return out;
  }
  return '';
}

// ---- transcript 讀取 ----

/**
 * 取本回合（最後一則使用者輸入之後）的 tool_use blocks 與對應的 tool_result。
 *
 * ★ 切回合用「行位置」，不能用 promptId 比對。實測本機 transcript（2026-09-15，
 *   Claude Code 2.x）：**assistant 行根本沒有 promptId 欄位**——65 個 tool_use
 *   全部沒有，只有 tool_result 所在的 user 行有。用 promptId 過濾會一個
 *   tool_use 都抓不到，而且語法檢查、靜態掃描全部會過——只有實跑才抓得到
 *   這種錯。
 *
 * 回合起點的判準見 isUserPromptLine()（三個條件缺一不可，各有實測重現的失效案例）。
 */
function turnBlocks(tp) {
  if (!tp) return null;
  let raw;
  try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return null; }

  const lines = raw.split('\n');

  // 從尾往前找最後一則真正的使用者輸入。
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (isUserPromptLine(o)) { start = i; break; }
  }
  if (start < 0) return null;

  const uses = [];
  const results = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;   // 合法 JSON 的 null/字串/數字：防 TypeError
    if (o.isSidechain === true) continue;        // subagent 的工具呼叫不算本回合
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') uses.push(b);
      else if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b);
    }
  }
  return { pid: String(start), uses, results };
}

// ---- 狀態（同一封草稿只提醒一次）----

function statePath() {
  return path.join(STATE_DIR, 'warned.json');
}

function readState() {
  const empty = { warned: [] };
  try {
    const o = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return { warned: Array.isArray(o.warned) ? o.warned.filter((x) => typeof x === 'string') : [] };
  } catch (_) { return empty; }
}

function writeState(st) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // 只留最近 200 筆，避免清單無限膨脹。
    const warned = (st.warned || []).slice(-200);
    fs.writeFileSync(statePath(), JSON.stringify({ warned }), 'utf8');
  } catch (_) { /* 寫不進去只會讓下輪再提醒一次，不影響正確性 */ }
}

/**
 * 這一行是不是「真正的使用者輸入」＝ 本回合的起點。
 *
 * 三個條件都不可少（2026-09-15 對抗審查後補強，三項皆已實測重現）：
 *   1. type==='user' 且有 promptId
 *   2. **沒有 toolUseResult 這個「欄位」**——用 `in` 判存在，不能用 `!o.toolUseResult`
 *      判真假值：實測 `toolUseResult: null` 的工具回傳行會被假值判定誤當成使用者輸入，
 *      於是起點落在工具回傳上，本回合前半段的 tool_use 全被漏掉。
 *   3. **不是 sidechain**——subagent 的 user 行若當上起點，主線的 tool_use 會被切在
 *      起點之前而漏掉。收集階段跳過 isSidechain 還不夠，起點搜尋也要排除。
 *
 * 另外對 o 做完整防護：transcript 裡若出現一行合法 JSON 的 `null`（或字串、陣列），
 * `o.type` 會直接拋 TypeError。雖然外層 try/catch 會接住而 fail-open（exit 0），
 * 但那代表**這支閘從該行起靜默停止檢查**——正是本 plugin 最想避免的失效形狀。
 */
function isUserPromptLine(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.type !== 'user' || !o.promptId) return false;
  if ('toolUseResult' in o) return false;
  if (o.isSidechain === true) return false;
  return true;
}

function safeStr(x) { return typeof x === 'string' ? x : ''; }
