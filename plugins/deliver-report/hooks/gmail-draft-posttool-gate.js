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
 *   (E3) htmlBody 手打序號／列點（「1.」「・」）→ 提醒改用 <ol>／<ul><li>
 *   (F) 機敏內容（憑證／個資，共用 banned-patterns.json）
 *   (F2) 公文式敬稱（advisory，會誤判，措辭寫成「請確認」）
 *   (H) 內文說有附檔（附上／附件／attached），這次寫入卻沒帶 attachments
 *       （2026-10-11 實案：寫了「附上三份檔案」卻叫使用者自己拖）→ 提醒用工具附上
 *   (G) reply 附件帶入（2026-10-06 實案：replyToMessageId 建草稿，原信 9 張截圖
 *       被整批複製進草稿附件區，使用者自己打開才發現）→ 寫入時記帳，
 *       get_draft 讀回時：有附件→提醒清除；無附件→銷帳
 *   (I) 寫入後尚未讀回（只記帳、不出聲）：create_draft／update_draft 成功就記 stale:<id>，
 *       get_draft 帶 htmlBody 讀回才銷；PreToolUse 閘 gmail-draft-stale-gate 據此擋下
 *       「上次寫入後沒讀回就再 update_draft」（2026-10-20 實案：使用者在介面手改的草稿被上一版文字原樣覆蓋）
 *
 * ── PostToolUse 契約（官方文件確認，與 Stop 不同）──────────────
 *   stdin:  { tool_name, tool_input, tool_use_id, tool_response, transcript_path,
 *             session_id, cwd, hook_event_name: 'PostToolUse', ... }
 *   ★ tool_response 是**物件**（{type:'text', text:'…'}），不是 transcript 裡的
 *     .content 形狀。resultText() 吃的是 {content:…}，故必須轉接——
 *     少了這步，六項內容檢查會全部拿到空字串而**靜默放行**，
 *     跟現在這支壞掉的 Stop hook 一模一樣，且 bash -n 與 grep 都驗不出來。
 *   輸出: {"systemMessage":"…","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}
 *         （additionalContext 給模型、systemMessage 給使用者；見 notify() 的說明）
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

// ★ 輸出管道（2026-11-13 修正，官方 hooks 文件確認）：
//   模型只看得到 hookSpecificOutput.additionalContext（包成 system reminder 放在工具回傳旁）；
//   systemMessage 是最外層欄位、只顯示給使用者。舊版把 systemMessage 塞在 hookSpecificOutput 裡，
//   兩邊都不是——2026-11-13 一個 session 建了 7 次帶手打列點的草稿，提醒一次都沒送到模型。
//   兩個都給：模型照提醒修，使用者也看得到檢查結果。
function notify(msg) {
  let json;
  try {
    json = JSON.stringify({
      systemMessage: msg,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: msg,
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

// 讀回是否帶 htmlBody——(I) 的 stale 記號只認這個：純文字版看不出使用者在編輯器裡改了哪些結構，不足以當底稿。
function resultHtml(res) {
  try {
    const o = JSON.parse(C.resultText(res));
    return (o && typeof o.htmlBody === 'string') ? o.htmlBody : '';
  } catch (_) { return ''; }
}

function resultHasHtml(res) {
  const s = C.resultText(res);
  if (!s) return false;
  try {
    const o = JSON.parse(s);
    return !!(o && typeof o === 'object' && typeof o.htmlBody === 'string');
  } catch (_) { return false; }
}

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch (_) { return allow(); }
  if (!input || typeof input !== 'object') return allow();

  const toolName = C.safeStr(input.tool_name);
  const isWrite = C.isGmailTool(toolName, C.WRITE_TOOLS);
  const isRead = C.isGmailTool(toolName, C.READ_TOOL);
  const isDelete = C.isGmailTool(toolName, 'delete_draft');
  if (!isWrite && !isRead && !isDelete) return allow();

  const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};

  // (I) 刪除成功 → 草稿已不存在，銷掉它的 stale／staleref，避免之後的 create_draft 被已刪的舊稿誤擋
  if (isDelete) {
    if (isToolError(input.tool_response)) return allow();
    const delId = C.safeStr(toolInput.draftId);
    if (delId) {
      const st0 = C.readState();
      if (C.clearStale(st0, delId)) C.writeState(st0);
    }
    return allow();
  }

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
    // (M) 讀回的正文比寫入時多了 <a>＝Gmail 自己把某段文字包成連結（顯示文字沒變，但變成藍色可點）。
    //     2026-11-13 實案：htmlBody 寫 <pre>logging.file.name=…</pre>，讀回變成 <a href="…url?q=…">logging.file.name</a>；
    //     舊版只查「顯示文字裡有沒有 url?q=」，這種「字沒變、被加連結」查不到。
    if (draftId && res) {
      const html = resultHtml(res);
      const pre = 'anchors:' + draftId + '=';
      const rec = st.warned.find((k) => k.indexOf(pre) === 0);
      if (html && rec) {
        const wrote = parseInt(rec.slice(pre.length), 10) || 0;
        const now = C.ownAnchorTexts(html);
        if (now.length > wrote) {
          const extra = now.slice(wrote).filter(Boolean).slice(0, 5);
          once('autolink:' + draftId + ':' + now.length, () =>
            `■ 讀回的正文比寫入時多了 ${now.length - wrote} 個連結：${extra.map((t) => '「' + t + '」').join('、') || '（顯示文字空白）'}\n` +
            '  這是 Gmail 自己把看起來像網址的字串包成 google.com/url?q= 連結——字沒變，但對方看到的是藍色可點的連結。\n' +
            '  不是要給對方點的，就用不帶屬性的 <span> 拆開點號（logging<span>.</span>file<span>.</span>name）重建，\n' +
            '  再讀回確認。使用者自己在 Gmail 加的連結就忽略這行。（SKILL.md 第三步之三）'
          );
        }
      }
    }
    // 有效讀回（回傳真的帶內容）→ 把 (A) 的未讀回記號銷掉
    if (draftId && res && C.resultHasBody(res)) {
      const noread = 'noread:' + draftId;
      const i = st.warned.indexOf(noread);
      if (i !== -1) { st.warned.splice(i, 1); C.writeState(st); }
    }
    // (I) 讀回帶 htmlBody → 銷「上次寫入後尚未讀回」記號，下一次 update_draft 才放行
    if (draftId && res && resultHasHtml(res)) {
      // 連同 staleref（create_draft／delete_draft 比對用的身分）一起銷
      if (C.clearStale(st, draftId)) C.writeState(st);
      // (J) 讀回的 htmlBody 有沒有簽名檔——原本就沒有的草稿，update 不必保留
      if (C.setSignatureState(st, draftId, C.hasSignature(resultHtml(res)))) C.writeState(st);
    } else if (draftId && res && C.resultHasBody(res)) {
      // (J) 純文字草稿：讀回有內文卻沒有 htmlBody＝沒有 HTML 簽名檔，記 nosig，之後的 update 不會永遠被擋
      if (C.setSignatureState(st, draftId, false)) C.writeState(st);
    }
    // (G) 讀回的附件區：有附件→提醒；確認為零→銷「reply 待檢查」記號
    const attCount = res ? C.resultAttachmentCount(res) : null;
    if (attCount !== null && attCount > 0) {
      once(draftId ? 'attach:' + draftId : null, () =>
        `■ 這封草稿帶著 ${attCount} 個附件：${draftId || '(未知 draftId)'}\n` +
        '  若是用 replyToMessageId 建的回覆草稿，原信的附件（對方貼的截圖等）會被整批\n' +
        '  複製進來——寄回去給對方沒有意義，還撐大信件。請確認每一個都是這次要寄的；\n' +
        '  要清掉就 update_draft 不帶 attachments 欄位（附件不做合併，未重附即全清，\n' +
        '  內文與收件人不受影響）。是自己刻意附上的就忽略這行。\n' +
        '  （SKILL.md 第三步之三 要點 5）'
      );
    }
    if (attCount === 0 && draftId) {
      const pend = 'attachpending:' + draftId;
      const i = st.warned.indexOf(pend);
      if (i !== -1) { st.warned.splice(i, 1); C.writeState(st); }
    }
  }

  // ── 寫入：(C)(D)(E)(E2)(F)(F2) ＋ (A) 記帳 ──
  if (isWrite) {
    // (I) 寫入成功 → 記「尚未讀回」。gmail-draft-stale-gate 據此擋下一次沒先 get_draft 的 update_draft
    //     （2026-10-20 實案：使用者在介面手改過的草稿被上一版文字原樣覆蓋）。這裡只記帳、不出聲。
    if (draftId) {
      const stale = 'stale:' + draftId;
      let changed = false;
      if (st.warned.indexOf(stale) === -1) { st.warned.push(stale); changed = true; }
      // 再記這封草稿的身分（信串／回覆對象／主旨），gmail-draft-stale-gate 用來擋
      // 「不讀回、直接開一封同信串的新草稿再刪舊的」這條繞路（2026-11-13 實案）
      let resObj = null;
      try { resObj = JSON.parse(C.resultText(res)); } catch (_) { resObj = null; }
      if (C.addStaleRefs(st, draftId, C.draftRefs(toolInput, resObj))) changed = true;
      if (changed) C.writeState(st);
    }

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

    // (J) 簽名狀態：create 帶 includeSignature:true 或內文有 gmail_signature → 有簽名；
    //     update 改了內文 → 依新內文判斷（只改收件人／主旨不動狀態）。gmail-draft-signature-gate 據此判斷 update 會不會弄丟簽名
    if (draftId) {
      const newHtml = C.safeStr(toolInput.htmlBody);
      const touches = newHtml.trim() !== '' || C.safeStr(toolInput.body).trim() !== '';
      const isCreate = C.isGmailTool(toolName, 'create_draft');
      if (isCreate || touches) {
        const has = (isCreate && toolInput.includeSignature === true) || C.hasSignature(newHtml);
        if (C.setSignatureState(st, draftId, has)) C.writeState(st);
      }
    }

    const text = C.draftText(toolInput);
    const html = C.stripSignature(toolInput.htmlBody);

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
          '  粗體改用 <b>、條列改用 <ol>／<ul><li>，寫在 htmlBody（純文字 body 只當退路）。\n' +
          '  （SKILL.md 第三步之三 格式）'
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

    // (E3) 手打序號／列點——該用 <ol>／<ul><li>
    const lists = C.handTypedLists(html);
    if (lists.length) {
      once(draftId ? 'list:' + draftId : null, () =>
        '□ htmlBody 裡有手打的序號或列點：' + lists.join('、') + '\n' +
        '  有順序的用 <ol><li>，沒順序的用 <ul><li>；同一點的補充行用 <br> 接在同一個 <li> 裡。\n' +
        '  手打的「1.」「・」在 Gmail 編輯器裡只是文字，使用者增刪一項就得自己重編號、子行也對不齊。\n' +
        '  （SKILL.md 第三步之三 格式）'
      );
    }

    // (K) 正文一大片文字、沒有任何結構（2026-11-13 實案：使用者「很難看出重點」）
    if (C.lacksStructure(toolInput.htmlBody)) {
      once(draftId ? 'struct:' + draftId : null, () =>
        '□ 正文是一大片文字，沒有粗體小標、清單或表格：對方很難一眼看出重點\n' +
        '  （2026-11-13 實案：七段純文字的回信，使用者「很難看出重點」）。\n' +
        '  分節用 <b>一、…</b> 當小標，並列的事用 <ul><li>、要對方回覆的問題用 <ol><li>，\n' +
        '  結論或要對方注意的那一句加 <b>。（SKILL.md 第三步之三 結構）'
      );
    }

    // (L) 讀者可能看不懂的術語（2026-11-13 實案：「jar 同目錄的外部檔案，不進 repo」，使用者「看不懂」）
    {
      const lines = C.ownBodyLines(toolInput.htmlBody || '') ;
      const plain = lines.length ? lines : C.safeStr(toolInput.body).split(/\r?\n/);
      const jargon = C.unexplainedJargon(plain);
      let termNotes = [];
      try {
        const R = require(path.join(__dirname, 'lib', 'readability-scan.core.js'));
        termNotes = (R.checkTermOrder(R.unitsFromText(plain, '行')).notes || []).filter((n) => /鐵則15/.test(n));
      } catch (_) { termNotes = []; }
      if (jargon.length || termNotes.length) {
        once(draftId ? 'jargon:' + draftId : null, () =>
          '□ 正文有讀者可能看不懂的術語（可能誤判，只是提醒）：\n' +
          (jargon.length ? '  開發術語沒有白話說明：' + jargon.join('、') + '\n' : '') +
          termNotes.map((n) => '  ' + n + '\n').join('') +
          '  收件人不是工程師時，改成白話或在第一次出現處加括號說明\n' +
          '  （例：「repo（程式碼倉庫）」「不提交到 git，所以不會跟著 PR 進到正式版本」）；\n' +
          '  收件人本來就是開發者、而且這個詞就是他們的用語，就忽略這行。（易讀性鐵則 15）'
        );
      }
    }

    // (A2) 沒有 http／www、但會被 Gmail 當成網址的點號字串（2026-11-13 實案：logging.file.name）
    {
      const own = C.stripQuotedRegions(C.safeStr(toolInput.htmlBody));
      const bare = C.bareDomains(own.replace(/<a\b[^>]*>/gi, ''));
      if (bare.length) {
        once(draftId ? 'bare:' + draftId : null, () =>
          '■ 正文有會被 Gmail 當成網址的字串：' + bare.join('、') + '\n' +
          '  結尾剛好是頂級網域（.name／.com／.io…），Gmail 建草稿時會把它包成\n' +
          '  google.com/url?q= 的連結（2026-11-13 實案：設定名稱 logging.file.name 變成藍色連結）。\n' +
          '  不是要給對方點的網址，就用不帶屬性的 <span> 拆開點號：logging<span>.</span>file<span>.</span>name\n' +
          '  （htmlBody 也擋不住，只會保住顯示文字）。真的是網址就忽略這行。（SKILL.md 第三步之三）'
        );
      }
    }

    // (M) 記下這次寫入的正文有幾個 <a>，讀回時多出來的就是 Gmail 自己加的連結
    if (draftId) {
      const pre = 'anchors:' + draftId + '=';
      st.warned = st.warned.filter((k) => k.indexOf(pre) !== 0);
      st.warned.push(pre + C.ownAnchorTexts(toolInput.htmlBody).length);
      C.writeState(st);
    }

    // (H) 內文說有附檔，這次沒帶 attachments——預設流程就是這樣（接著用瀏覽器上傳），提示下一步、不要留給使用者自己拖。
    //     回合結束前沒傳齊由 Stop 閘 upload-count-gate 擋。
    const claim = C.attachmentClaimWithoutFiles(toolInput);
    const listed = claim ? C.attachmentListMismatch(toolInput) : null;
    if (claim) {
      once(draftId ? 'claim:' + draftId : null, () =>
        '□ 內文寫了「' + claim + '」，這次 ' + (/update_draft$/.test(toolName) ? 'update_draft' : 'create_draft') + ' 沒帶 attachments——接著用瀏覽器把附件上傳到這封草稿。\n' +
        (/update_draft$/.test(toolName)
          ? '  update_draft 不帶 attachments 會把草稿既有附件整批清掉——用瀏覽器重新上傳。\n'
          : '') +
        '  附檔由我方完成，不要叫使用者自己拖：預設用瀏覽器開草稿 viewUrl，對附件的 file input\n' +
        '  用 file_upload 上傳後按「儲存並關閉」（幾秒完成）。瀏覽器不能用時才用 attachments（base64）\n' +
        '  ——模型要逐字輸出整個檔案，13 KB 實測約 8 分鐘，先告訴使用者大小與預估時間。\n' +
        (listed && listed.items.length
          ? '  信裡的附件清單列了 ' + listed.items.length + ' 項，附完要逐項對過，一個都不能少：\n' +
            listed.items.map((it, i) => '    ' + (i + 1) + '. ' + it).join('\n') + '\n'
          : '') +
        '  （SKILL.md 第三步之三 要點 5）'
      );
    }

    // (G) reply 模式會把原信附件複製進草稿——記帳，等 get_draft 讀回確認附件區
    if (draftId && C.safeStr(toolInput.replyToMessageId)) {
      const key = 'attachpending:' + draftId;
      if (st.warned.indexOf(key) === -1 && claimed.indexOf(key) === -1) {
        claimed.push(key);
        sections.push(
          '□ 這封是回覆草稿（replyToMessageId），原信的附件會被複製進草稿附件區\n' +
          '  （2026-10-06 實案：對方信裡 9 張截圖整批被帶進回覆草稿）。\n' +
          '  請跑一次 get_draft 檢查附件區；有帶入就 update_draft 不帶 attachments 欄位\n' +
          '  一次清空（內文與收件人不受影響）。（SKILL.md 第三步之三 要點 5）'
        );
      }
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
