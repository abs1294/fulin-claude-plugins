#!/usr/bin/env node
/**
 * gmail-draft-posttool-gate — deliver-report 的 Gmail 草稿即時閘（PostToolUse）
 *
 * ── 為什麼會有這支（2026-09-17 實案）──────────────────────────
 * 既有的 Stop hook `gmail-draft-link-gate.js` 判準完全正確，但**從未開火**：
 * 它的 turnBlocks() 只收「最後一則使用者輸入之後」的 tool_use，而真實交付流程是
 *
 *     行 1461-2057  AI 建草稿 / 改草稿 / 讀回草稿   ← 該檢查的全在這
 *     行 2153       使用者又講了一句話              ← 掃描窗從這裡才開始
 *     行 2158       AI 呼叫 list_drafts（非 write）
 *     行 2166       Stop → writes 為空 → return allow()
 *
 * 於是 disallowedTags() 一次都沒被呼叫，使用者手上那封草稿帶著 7 個 <p>
 * （在 Gmail 富文本編輯器裡改一個字就整段跑版，使用者原話「我根本改不了」），
 * 而且 threadId === messageId 已掉出原信串，寄出去會變成一封獨立新信。
 * 四封草稿連續複製同一個錯誤，沒有任何一道閘出過聲。
 *
 * 本 hook 掛 PostToolUse，在 create_draft / update_draft / get_draft **回傳當下**
 * 就檢查，完全不依賴回合切割——草稿一成形就看得到，使用者在下一次互動前就收到提醒。
 *
 * ── 為什麼不做「Stop 掃全檔」兜底 ────────────────────────────
 * 使用者明確否決：「乙沒攔到是你的問題，甲兜底會誤擾」。掃全檔會對早已定案、
 * 使用者已決定「就這樣」的舊草稿反覆出聲。本 hook 只對**當下這一次**工具呼叫負責，
 * 漏掉就是漏掉，不用更吵的機制去補。
 *
 * ── 七項檢查（全部只提醒、不阻擋）─────────────────────────────
 *   (A) 含網址的草稿尚未讀回檢查   → 記帳，等 get_draft 銷帳
 *   (B) 讀回的顯示文字驗出 url?q=  → 該封已壞，要重建
 *   (C) 掉出原信串                  → 兩支判準：
 *         detachedThreads      多次觀測間 threadId 變動
 *         detachedReplyDrafts  單次觀測：自稱 Re: 卻 threadId 等於自己的 id
 *   (D) 佔位符外流
 *   (E) Markdown 語法外流
 *   (E2) htmlBody 標籤白名單（<p> 就是被這項抓到的）
 *   (F) 機敏內容（憑證／個資，共用 banned-patterns.json）
 *   (F2) 公文式敬稱（advisory，會誤判，措辭寫成「請確認」）
 *
 * ── PostToolUse 契約（官方文件確認，與 Stop 不同）──────────────
 *   stdin:  { tool_name, tool_input, tool_use_id, tool_response, transcript_path,
 *             session_id, cwd, hook_event_name: 'PostToolUse', ... }
 *   ★ tool_response 是**物件**（{type:'text', text:'…'}），不是 transcript 裡的
 *     .content 形狀。resultText() 吃的是 {content:…}，故必須轉接——
 *     少了這步，六項內容檢查會全部拿到空字串而**靜默放行**，
 *     跟現在這支壞掉的 Stop hook 一模一樣，且 bash -n 與 grep 都驗不出來。
 *   輸出: {"hookSpecificOutput":{"hookEventName":"PostToolUse","systemMessage":"…"}}
 *   exit: 一律 0。PostToolUse 無法阻擋（工具已經跑完），exit 2 不被採用。
 *
 * ★ 最高原則：FAIL-OPEN。任何解析失敗、判斷不確定 → 放行，絕不卡住流程。
 */

const path = require('path');

let C;
try {
  C = require(path.join(__dirname, 'lib', 'draft-checks.core.js'));
} catch (_) {
  process.exit(0);   // 載不到判準就安靜放行，不影響使用者
}

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try { main(stdinData); } catch (_) { allow(); }
});
process.stdin.on('error', () => allow());

function allow() { process.exit(0); }

function notify(msg) {
  let json;
  try {
    json = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        systemMessage: msg,
      },
    });
  } catch (_) { return allow(); }
  try { process.stdout.write(json, () => process.exit(0)); } catch (_) { allow(); }
}

/**
 * 這次工具呼叫是不是失敗了。
 *
 * 只認 MCP 錯誤回傳的 isError / is_error 旗標，**不猜字串內容**——
 * 「error」「failed」這種字可能正好出現在草稿正文裡，猜錯就會把該檢查的草稿放掉。
 * 判不出來一律當「成功」（照常檢查），因為漏檢查的代價高於多提醒一次。
 */
function isToolError(tr) {
  if (!tr || typeof tr !== 'object') return false;
  if (Array.isArray(tr)) return false;
  return tr.isError === true || tr.is_error === true;
}

/**
 * PostToolUse 的 tool_response 轉成 resultText() 吃得下的 {content} 形狀。
 *
 * 實測過的三種形狀都要接：
 *   1. { type:'text', text:'{"id":"r7144…"}' }      ← 官方文件的標準形狀
 *   2. [ { type:'text', text:'…' }, … ]              ← 部分 MCP 回多個 block
 *   3. '純字串'                                      ← 保險
 * 轉不出來就回 null，呼叫端一律當作「判不出」而放行。
 */
function toResultShape(tr) {
  if (tr === null || tr === undefined) return null;
  if (typeof tr === 'string') return { content: tr };
  if (Array.isArray(tr)) return { content: tr };
  if (typeof tr === 'object') {
    if (typeof tr.text === 'string') return { content: tr.text };
    // 有些實作把內容包在 .content 底下
    if (typeof tr.content === 'string' || Array.isArray(tr.content)) return { content: tr.content };
    try { return { content: JSON.stringify(tr) }; } catch (_) { return null; }
  }
  return null;
}

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return allow(); }
  if (!input || typeof input !== 'object') return allow();

  const toolName = C.safeStr(input.tool_name);
  const isWrite = C.isGmailTool(toolName, C.WRITE_TOOLS);
  const isRead = C.isGmailTool(toolName, C.READ_TOOL);
  if (!isWrite && !isRead) return allow();

  const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};

  // 工具失敗（quota exceeded、權限不足…）→ 草稿沒建成，沒有「寄出去收不回來」的風險。
  // 仍對 tool_input 跑檢查只會叫使用者去修一封不存在的草稿（2026-09-18 審查實測：
  // {"isError":true,"content":"quota exceeded"} 會報 <p>）。重試成功時會重新觸發
  // 一次完整檢查，所以放行不會讓真缺陷溜掉。
  if (isToolError(input.tool_response)) return allow();

  const res = toResultShape(input.tool_response);

  // 單次呼叫組成的 turn：讓共用判準能原封不動地跑。
  const useId = C.safeStr(input.tool_use_id) || 'single';
  const results = new Map();
  if (res) results.set(useId, res);
  const turn = { pid: useId, uses: [{ id: useId, name: toolName, input: toolInput }], results };

  const st = C.readState();
  const sections = [];
  const claimed = [];

  function once(key, produce) {
    if (key !== null && st.warned.indexOf(key) !== -1) return;
    const text = produce();
    if (!text) return;
    if (key !== null) claimed.push(key);
    sections.push(text);
  }

  const draftId = (res ? C.resultDraftId(res) : null) || C.safeStr(toolInput.draftId) || null;

  // ── 讀回：(B) 網址被改寫 ＋ (A) 銷帳 ──
  if (isRead) {
    if (res && C.inspectDraftResult(res) === true) {
      const label = draftId || '(未知 draftId)';
      once(draftId ? 'link:' + draftId : null, () =>
        `■ 網址被改寫，這封草稿已經壞了：${label}\n` +
        '  讀回來的「顯示文字」裡出現 google.com/url?q= ——不是 href 被包（那是正常的），\n' +
        '  是對方複製到的內容本身就是錯的位址，照貼會貼到 Google。\n' +
        '  修法：改用 htmlBody、可貼內容包 <pre>，body 純文字版換成「完整內容見報告第 N 節」的\n' +
        '  指路句；重建後再 get_draft 確認一次。（SKILL.md 第三步之三）'
      );
    }
    // 有效讀回（回傳真的帶內容）→ 把 (A) 的未讀回記號銷掉
    if (draftId && res && C.resultHasBody(res)) {
      const noread = 'noread:' + draftId;
      const i = st.warned.indexOf(noread);
      if (i !== -1) { st.warned.splice(i, 1); C.writeState(st); }
    }
  }

  // ── 寫入：(C)(D)(E)(E2)(F)(F2) ＋ (A) 記帳 ──
  if (isWrite) {
    // (C) 掉串：單次觀測判準（自稱 Re: 卻自成一串）
    for (const d of C.detachedReplyDrafts(turn)) {
      once('thread:' + d.id, () =>
        `■ 草稿掉出原信串了：${d.id}\n` +
        `  主旨寫「${d.subject.slice(0, 40)}」是回覆，但回傳的 threadId 等於這封草稿自己的 id\n` +
        '  ——代表它沒有接在原討論串下，送出去會變成一封新信，對方看不出是在回哪一封。\n' +
        '  **Gmail 介面上看不出來。**\n' +
        '  修法：刪掉重建，create_draft 帶 replyToMessageId（原信的 message id，不是 thread id），\n' +
        '  建完確認回傳的 threadId 仍是原信串。（SKILL.md 第三步之三 要點 1）'
      );
    }
    // (C) 掉串：多次觀測判準（同一 session 內先掛串、後脫離）
    for (const id of C.detachedThreads(turn)) {
      once('thread:' + id, () =>
        `■ 草稿掉出原信串了：${id}\n` +
        '  update_draft 之後 threadId 變成草稿自己的 id。送出去會變成一封新信。\n' +
        '  修法：刪掉重建，用 create_draft 帶 replyToMessageId。（SKILL.md 第三步之三 要點 1）'
      );
    }

    const text = C.draftText(toolInput);
    const html = C.safeStr(toolInput.htmlBody);

    if (text.trim()) {
      const ph = C.findPlaceholders(text);
      if (ph.length) {
        once(draftId ? 'ph:' + draftId : null, () =>
          `■ 草稿裡還留著佔位符：${ph.slice(0, 5).join('、')}` +
          (ph.length > 5 ? `（另有 ${ph.length - 5} 處）` : '') + '\n' +
          '  對方看不懂那要填什麼。收件人沒指定就只寫「Hi,」，不要留 <收件人>；\n' +
          '  網址不要代換成 [站台網址]——真的不能貼就指到報告第 N 節並說明原因。\n' +
          '  （SKILL.md 鐵則 ①、第三步之三）'
        );
      }

      const md = C.findMarkdown(text);
      if (md.length) {
        once(draftId ? 'md:' + draftId : null, () =>
          `■ 草稿裡有 Markdown 語法：${md.join('、')}\n` +
          '  實測 Gmail 純文字會原樣顯示成星號與井號，不會渲染成粗體或標題。\n' +
          '  排版改用空行與「項目：值」一行一條。（SKILL.md 第三步之三 格式）'
        );
      }

      const hard = C.scanBanned(text, C.BANNED.hard, true);
      if (hard.length) {
        once(draftId ? 'banned:' + draftId : null, () =>
          `■ 草稿裡有機敏內容：${hard.join('；')}\n` +
          '  草稿是要寄給外人的，這類東西外流收不回來。寄出前務必確認並移除。\n' +
          '  （樣式來源：references/banned-patterns.json，與另外兩支閘共用）'
        );
      }

      const adv = C.scanBanned(text, C.BANNED.advisory, false);
      if (adv.length) {
        once(draftId ? 'adv:' + draftId : null, () =>
          `□ 請確認是否為公文式敬稱（可能誤判，只是提醒）：${adv.join('；')}\n` +
          '  對方一律寫「您們」、自稱寫「我們」。但中文沒有詞邊界，「貴司」會命中\n' +
          '  「貴司機」、「本中心」會命中「成本中心」——是誤判就忽略這行。\n' +
          '  （易讀性鐵則 14：本組天生只提醒、不判定）'
        );
      }
    }

    // (E2) 標籤白名單——<p> 就是被這項抓到的
    const badTags = C.disallowedTags(html);
    if (badTags.length) {
      once(draftId ? 'tag:' + draftId : null, () =>
        '■ htmlBody 用了白名單以外的標籤或屬性：' + badTags.join('、') + '\n' +
        '  草稿是要讓使用者在 Gmail 富文本編輯器裡微調的——塞進這些結構，\n' +
        '  他改一個字就可能整段跑版（2026-09-17 實案：使用者收到 7 個 <p> 的草稿，\n' +
        '  原話「我根本改不了」）。\n' +
        '  只用：<br> <b> <i> <u> <ul> <ol> <li> <a> <pre> <table> <tr> <td> <th>\n' +
        '  換行一律用 <br>（空一行就是 <br><br>），禁用 <p>；外層只允許一個 <div dir="ltr">。\n' +
        '  （SKILL.md 第三步之三 格式）'
      );
    }

    // (A) 含網址就記帳，等 get_draft 有效讀回才銷帳
    if (draftId && C.hasUrl(text)) {
      const key = 'noread:' + draftId;
      if (st.warned.indexOf(key) === -1 && claimed.indexOf(key) === -1) {
        claimed.push(key);
        sections.push(
          '□ 這封草稿含網址，記得讀回來檢查\n' +
          '  Gmail 會把純文字 body 裡的網址改寫成自家轉址連結（google.com/url?q=...），\n' +
          '  對方照貼就貼到錯的位址——而且看草稿預覽看不出來。\n' +
          '  請跑一次 get_draft（messageFormat: FULL_CONTENT），檢查 htmlBody 裡\n' +
          '  「標籤之間的顯示文字」有沒有 google.com/url?q=（href 裡有是正常的、不用管）。'
        );
      }
    }
  }

  if (!sections.length) return allow();

  st.warned = st.warned.concat(claimed);
  C.writeState(st);

  return notify(
    '【Gmail 草稿檢查】寄出去就收不回來，請先確認以下幾點：\n\n' + sections.join('\n\n')
  );
}
