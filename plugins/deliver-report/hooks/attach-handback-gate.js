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
 * 退出口：
 *   - 同一回合第二次 Stop（stop_hook_active）仍命中 → 改為提醒放行，不讓 session 卡死。
 *   - 真的代附不了（超過 25MB 且瀏覽器也上傳不了）→ 回覆裡寫一行「無法代附：<理由>」，該句不算。
 *
 * ★ FAIL-OPEN：transcript 讀不到、解析失敗 → 放行。
 */
const fs = require('fs');

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
const RETRO = /上次|之前|先前|為什麼|為何|沒照|不要|不必|不用|不需要|別再|禁止|已(?:經)?(?:附|上傳|掛)|我已|由工具|無法代附/;

function punts(text) {
  const out = [];
  for (const raw of String(text).split(/[。！？\n]/)) {
    const s = raw.trim();
    // 引號裡是被引用的字（描述規則或這道閘本身時的例句），不是叫使用者做事——判斷動作前先拿掉
    const bare = s.replace(/「[^」]*」|『[^』]*』|“[^”]*”|`[^`]*`/g, '');
    if (!s || !OBJ.test(s) || !USER_ACT.test(bare) || RETRO.test(s)) continue;
    out.push(s.length > 80 ? s.slice(0, 80) + '…' : s);
  }
  return out;
}

function main(raw) {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (_) { return allow(); }
  const tp = payload.transcript_path;
  if (!tp) return allow();
  let lines;
  try { lines = fs.readFileSync(tp, 'utf8').split('\n'); } catch (_) { return allow(); }

  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (isUserPromptLine(o)) { start = i; break; }
  }
  if (start < 0) return allow();

  // 最後一段回覆：最後一次工具呼叫之後的助理文字（中途的過程說明不算，交給使用者的是收尾那段）
  let finalText = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!o || o.type !== 'assistant' || o.isSidechain === true) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') finalText = [];
      else if (b.type === 'text' && typeof b.text === 'string') finalText.push(b.text);
    }
  }
  const hits = punts(finalText.join(NL));
  if (!hits.length) return allow();

  const body = [
    '以下句子把附檔丟回給使用者自己做：', '',
    ...hits.map((h) => '   ・' + h), '',
    '附檔是做得到的事（SKILL.md 第三步之三 要點 5）：',
    '   ① 預設：瀏覽器開草稿的 viewUrl（authuser 指到草稿所在帳號），對附件的 file input 用',
    '      file_upload 上傳，按「儲存並關閉」，再從草稿匣重新打開確認附件區。幾秒完成。',
    '      update_draft 會清掉既有附件——改完內文再用瀏覽器重新上傳。',
    '   ② 瀏覽器不能用時才用 attachments（base64，合計 ≤25MB）：模型要逐字輸出整個檔案，',
    '      13 KB 實測約 8 分鐘，動手前先告訴使用者檔案大小與預估等待時間。',
    '   ③ 真的代附不了：回覆裡寫一行「無法代附：<理由>」並改寫信裡的取檔方式。',
  ];
  if (payload.stop_hook_active === true) {
    return emit({ systemMessage: '【附檔不丟回】（本回合已擋過一次，這次放行）' + NL + body.join(NL) });
  }
  emit({ decision: 'block', reason: '【附檔不丟回】請先把檔案附上再結束。' + NL + body.join(NL) });
}

function isUserPromptLine(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.type !== 'user' || !o.promptId) return false;
  if ('toolUseResult' in o) return false;
  if (o.isSidechain === true) return false;
  if (o.isMeta === true) return false;
  return true;
}

module.exports = { punts };
