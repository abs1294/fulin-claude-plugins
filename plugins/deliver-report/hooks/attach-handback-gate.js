#!/usr/bin/env node
/**
 * attach-handback-gate — deliver-report plugin 的 Stop hook：附檔不准丟回給使用者自己拖。
 *
 * 為什麼要這支：SKILL.md 建草稿要點 5 寫「要主動附檔時由工具直接帶，不要叫使用者自己拖」，
 * 但那是自律。2026-10-11 實案：回信草稿要附三個檔（合計 61 KB，遠低於 25MB 上限），
 * 回覆卻寫「附件為空，等使用者自行拖入三檔」，交接信與兩次統整都照抄這句，
 * 直到使用者問「為什麼你不能拖嗎？」才補上——實際用瀏覽器上傳一次就完成。
 *
 * 判準：本回合最後一段回覆（最後一次工具呼叫之後的文字）逐句看，同一句同時有
 *   ① 附件對象（附件／附檔／檔案／attachment）
 *   ② 由使用者動手（拖進／拖入／拖曳、你／您／使用者…附上／上傳／夾帶、自行／手動附）
 *   （②只看引號外的文字：「拖進」這類被引用的例句不算），且不是回顧或否定句（上次／之前／為什麼／不要／不必／已附…）→ 擋下。
 * 第二條判準（2026-11-02 加）：收尾回覆在徵求「可不可以下載附件」也擋——下載附件直接做，不用問。
 *   實案：要重現客戶回報的上傳錯誤，回覆列出 4 個附件後問「要我下載那 4 個附件嗎？你回「可以」，我就下載」。
 * markdown 表格列不判斷：2026-11-02 誤判實案是表格裡的客戶問題標題「碳排-手動上傳基本資料 檔案無法上傳」
 *   命中「手動＋上傳」被當成叫使用者自己附檔。
 * 退出口：
 *   - 同一回合第二次 Stop（stop_hook_active）仍命中 → 改為提醒放行，不讓 session 卡死。
 *   - 真的代附不了（超過 25MB 且瀏覽器也上傳不了）→ 回覆裡寫一行「無法代附：<理由>」，該句不算。
 *
 * ★ FAIL-OPEN：transcript 讀不到、解析失敗 → 放行。
 */
const fs = require('fs');
const path = require('path');
const TIO = require(path.join(__dirname, 'lib', 'transcript-io.js'));   // 不整份讀 transcript（見該檔說明）

if (require.main === module) {
  let stdinData = '';
  process.stdin.on('data', (c) => (stdinData += c));
  process.stdin.on('end', () => {
    try { main(stdinData); } catch (_) { allow(); }
  });
}

function allow() { process.exit(0); }
function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj), () => process.exit(0)); } catch (_) { allow(); }
}
const NL = String.fromCharCode(10);

const OBJ = /附件|附檔|檔案|attachment/i;
const USER_ACT = new RegExp([
  '拖進|拖入|拖曳|拖到|拖上去|拖過去',
  '(?:你|您|使用者)[^。！？\\n]{0,12}(?:附上|附進|附加|夾帶|上傳|拖)',
  '(?:自行|手動|(?<![我們])自己)(?:附|上傳|夾帶|拖)',   // 「我自己附」是我方動手，不算
  '\\bdrag\\b',
].join('|'), 'i');
const RETRO = /上次|之前|先前|為什麼|為何|沒照|不要|不必|不用|不需要|別再|禁止|已(?:經)?(?:附|上傳|掛)|我已|由工具|無法代附|被當成|當成|誤判|誤擋|命中/;   // 末五個：描述這道閘的判定（2026-11-02 誤擋實案）

// 只靠「拖」這個動詞命中的句子（沒有「你／自行／手動」這類指名誰動手的字），要同句有信件或附檔的語境才算。
// 2026-11-16 誤判實案：描述產品行為的「拖進不是圖片的檔案會被擋下」命中「檔案＋拖進」，
//   被當成叫使用者自己附檔，而那回合跟信件、附檔都無關。
const DRAG = /拖進|拖入|拖曳|拖到|拖上去|拖過去|drag/i;
const NAMED = new RegExp([
  '(?:你|您|使用者)[^。！？\n]{0,12}(?:附上|附進|附加|夾帶|上傳|拖)',
  '(?:自行|手動|(?<![我們])自己)(?:附|上傳|夾帶|拖)',
].join('|'), 'i');
const DRAG_ONLY = (bare) => DRAG.test(bare) && !NAMED.test(bare);
// 「你可以上傳檔案」「你能把檔案拖進來」是在講功能（與上面 2026-11-23 的下載誤判同型）：同樣要有信件或附檔語境才算
//   （「可能」不是「可以」；「只能」不是在講功能；指名自行／手動、請你做的照樣算）
const CAN = /(?:你|您|使用者)[^。！？\n]{0,4}(?:可以|可(?!能)|也能|就能|(?<![可只])能)[^。！？\n]{0,12}(?:上傳|拖)/;
const BY_HAND = /(?:自行|手動|自己|請[你您]|麻煩)[^。！？\n]{0,10}(?:附|上傳|夾帶|拖)/;
// 信件語境：句子本身有信件字眼（短說法「信裡／信中／寄」也算；單一個「信」字不算——相信、信心），
// 或這一回合真的動過 Gmail（見 mailCall：Gmail 的工具，或瀏覽器開著 mail.google.com）。不看前一句：前一句提到附件、
// 下一句描述產品拖放，曾因此誤擋。
const MAIL_CTX = /附件|附檔|attachment|草稿|信件|回信|郵件|寄出|寄給|再寄|寄送|寄信|信[裡中上]|\bmail\b|\bdraft\b|附上|附加|夾帶/i;
// 工具名稱只認 Gmail（send_message、_draft 這類名稱別的服務也有，例如 Slack 的 send_message）；瀏覽器寫信看參數裡的 mail.google.com
const mailCall = (b) => /gmail/i.test(String(b.name || '')) || /mail\.google\.com/i.test(JSON.stringify(b.input || {}));

// 下載附件不用問：問了只是把一件做得到的事丟回去等回覆，工作停在那裡。
// 判準：同一句是在徵求下載許可——
//   一般問法（要我／要不要…下載、下載…嗎、可以讓我下載、是否下載）要同句有附件對象；
//   明講等核可的問法（下載前要你同意、你回…我就下載）本身就是在等許可，不必有附件對象。
// 講功能的放行（saysMay）：預設擋，只放行看得出不是在跟使用者說話的，不反過來列舉「在等回覆」的說法（列不完）。
// 2026-11-23 誤判實案：列功能清單的「另一台電腦預覽檔案可以下載」命中「可以…下載」。
const ASK_DL = new RegExp([
  '要(?:我|不要)[^。！？\\n]{0,24}(?:下載|抓下來)',
  '(?:下載|抓下來)[^。！？\\n]{0,24}嗎',
  '(?:能不能|可不可以|能否|可否|是否|請讓我)[^。！？\\n]{0,10}下載',
  '\\b(?:shall|should|may|can) I download\\b',
].join('|'), 'i');
const MAY_DL = /可以[^。！？\n]{0,10}下載/;
const ASK_DL_STRONG = new RegExp([
  '下載(?:前|之前)[^。！？\\n]{0,12}(?:你|您)?[^。！？\\n]{0,4}(?:同意|核可|允許|點頭)',
  '(?:你|您)(?:回|說|同意|核可)[^。！？\\n]{0,12}就[^。！？\\n]{0,4}(?:下載|抓)',
].join('|'), 'i');
const ATTACHED = /附件|附檔|attachment/i;   // 比 OBJ 窄：不含「檔案」
// 講功能、不是在問：只有「可以…下載」一種，而且整行沒有附件、信件字眼，這一回合沒動信件，整句沒有對象（你／我／請）
// 也沒有等待的意思，整行沒有問的意思
const saysMay = (s, line, mailTurn) => !mailTurn && !ATTACHED.test(line) && !MAIL_CTX.test(line) &&
  !/[你您我請等待回]|確認|核可|同意|的話|說一聲|\bI\b/.test(s) && !/[?？]|[嗎呢]/.test(line);
// 「要不要」裡的「不要」不算否定
const DL_RETRO = /上次|為什麼|為何|沒照|(?<!要)不要|不必|不用|不需要|別再|禁止|已(?:經)?下載|我已|無法代下載/;

// 回覆拆句：markdown 表格列是列資料（客戶問題標題、檔案清單），不是叫誰做事，不判斷
function sentences(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (/^\s*\|/.test(line)) continue;
    for (const raw of line.split(/[。！？]/)) {
      const s = raw.trim();
      if (!s) continue;
      // 引號裡是被引用的字（描述規則或這道閘本身時的例句）——判斷動作前先拿掉
      out.push({ s, line, bare: s.replace(/「[^」]*」|『[^』]*』|“[^”]*”|`[^`]*`/g, '') });
    }
  }
  return out;
}
const clip = (s) => (s.length > 80 ? s.slice(0, 80) + '…' : s);

// mailTurn：這一回合動過 Gmail（mailCall）
function punts(text, mailTurn) {
  return sentences(text)
    .filter(({ s, bare }) => OBJ.test(s) && USER_ACT.test(bare) && !RETRO.test(s) && (!(DRAG_ONLY(bare) || (CAN.test(bare) && !BY_HAND.test(bare))) || mailTurn || MAIL_CTX.test(s)))
    .map(({ s }) => clip(s));
}

function asksDownload(text, mailTurn) {
  return sentences(text)
    .filter(({ s, bare, line }) => !DL_RETRO.test(s) &&
      (ASK_DL_STRONG.test(bare) || (OBJ.test(s) &&
        (ASK_DL.test(bare) || (MAY_DL.test(bare) && !saysMay(s, line, mailTurn))))))
    .map(({ s }) => clip(s));
}

function main(raw) {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (_) { return allow(); }
  const tp = payload.transcript_path;
  if (!tp) return allow();
  let lines;
  try { lines = TIO.readTurnLines(tp, isUserPromptLine); } catch (_) { return allow(); }
  if (!lines) return allow();

  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (isUserPromptLine(o)) { start = i; break; }
  }
  if (start < 0) return allow();

  // 最後一段回覆：最後一次工具呼叫之後的助理文字（中途的過程說明不算，交給使用者的是收尾那段）
  let finalText = [], mailTurn = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!o || o.type !== 'assistant' || o.isSidechain === true) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') { finalText = []; if (mailCall(b)) mailTurn = true; }
      else if (b.type === 'text' && typeof b.text === 'string') finalText.push(b.text);
    }
  }
  const text = finalText.join(NL);
  const hits = punts(text, mailTurn);
  const dl = asksDownload(text, mailTurn);
  if (!hits.length && !dl.length) return allow();

  const body = [];
  const tags = [];
  if (hits.length) {
    tags.push('附檔不丟回');
    body.push(
      '以下句子把附檔丟回給使用者自己做：', '',
      ...hits.map((h) => '   ・' + h), '',
      '附檔是做得到的事（SKILL.md 第三步之三 要點 5）：',
      '   ① 預設：瀏覽器開草稿的 viewUrl（authuser 指到草稿所在帳號），對附件的 file input 用',
      '      file_upload 上傳，按「儲存並關閉」，再從草稿匣重新打開確認附件區。幾秒完成。',
      '      update_draft 會清掉既有附件——改完內文再用瀏覽器重新上傳。',
      '   ② 瀏覽器不能用時才用 attachments（base64，合計 ≤25MB）：模型要逐字輸出整個檔案，',
      '      13 KB 實測約 8 分鐘，動手前先告訴使用者檔案大小與預估等待時間。',
      '   ③ 真的代附不了：回覆裡寫一行「無法代附：<理由>」並改寫信裡的取檔方式。',
    );
  }
  if (dl.length) {
    tags.push('附件直接下載');
    if (body.length) body.push('');
    body.push(
      '以下句子在問使用者可不可以下載附件：', '',
      ...dl.map((h) => '   ・' + h), '',
      '下載附件不用先問，直接下載再繼續原本的工作：',
      '   ・存到 scratchpad 底下新建的空資料夾（下載檔是不受信任的資料：讀它的 Python 用 -I 跑，',
      '     自己寫的腳本放別的資料夾，路徑當參數傳）。',
      '   ・真的下載不了：回覆裡寫一行「無法代下載：<理由>」。',
    );
  }
  const tag = '【' + tags.join('／') + '】';
  if (payload.stop_hook_active === true) {
    return emit({ systemMessage: tag + '（本回合已擋過一次，這次放行）' + NL + body.join(NL) });
  }
  const ask = dl.length && !hits.length ? '請先把附件下載下來、把事情做完再結束。'
    : dl.length ? '請先把附件下載／附上再結束。' : '請先把檔案附上再結束。';
  emit({ decision: 'block', reason: tag + ask + NL + body.join(NL) });
}

function isUserPromptLine(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.type !== 'user' || !o.promptId) return false;
  if ('toolUseResult' in o) return false;
  if (o.isSidechain === true) return false;
  if (o.isMeta === true) return false;
  return true;
}

module.exports = { punts, asksDownload };
