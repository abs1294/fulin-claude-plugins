// 附檔不丟回的兩道閘 —— 跑法：node hooks/tests/attach-handback.test.js
//
// 一、attach-handback-gate.js（Stop，會擋）：實際以 stdin＋假 transcript 跑整支 hook，看輸出。
// 二、attachmentClaimWithoutFiles()（PostToolUse 的 (H) 判準）：單元測試，加一次整支 posttool 閘實跑。
// 語料取自 2026-10-11 實案：回覆寫「附件為空，等使用者自行拖入三檔」，之後的統整照抄「還要你拖進三個附件」。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..');
const GATE = path.join(HOOKS, 'attach-handback-gate.js');
const POST = path.join(HOOKS, 'gmail-draft-posttool-gate.js');
const { attachmentClaimWithoutFiles } = require(path.join(HOOKS, 'lib', 'draft-checks.core.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-handback-'));

let ok = 0, bad = 0;
function check(pass, label, detail) {
  pass ? ok++ : bad++;
  console.log('  ' + (pass ? 'PASS' : '** FAIL **').padEnd(12) + label + (pass ? '' : '  → ' + detail));
}

let n = 0;
function runStop(finalTexts, opts) {
  const o = opts || {};
  const lines = [{ type: 'user', promptId: 'p1', message: { role: 'user', content: '回信' } }];
  if (o.midText) lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: o.midText }] } });
  // the turn's tool calls: o.tools ([{name, input}]) in order, else one o.tool (default Bash)
  (o.tools || [{ name: o.tool || 'Bash', input: {} }]).forEach((t, k) => {
    lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't' + k, name: t.name, input: t.input || {} }] } });
    lines.push({ type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + k, content: 'ok' }] } });
  });
  for (const t of finalTexts) lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const tp = path.join(TMP, 'tr' + (n++) + '.jsonl');
  fs.writeFileSync(tp, lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = spawnSync('node', [GATE], { input: JSON.stringify({ transcript_path: tp, stop_hook_active: !!o.active }), encoding: 'utf8' });
  let out = {};
  try { out = r.stdout ? JSON.parse(r.stdout) : {}; } catch (_) { out = { parseError: r.stdout }; }
  return { code: r.status, out };
}
function expectBlock(texts, label, opts) {
  const r = runStop(texts, opts);
  check(r.code === 0 && r.out.decision === 'block', label, JSON.stringify(r));
}
function expectAllow(texts, label, opts) {
  const r = runStop(texts, opts);
  check(r.code === 0 && !r.out.decision && !r.out.systemMessage, label, JSON.stringify(r));
}

console.log('=== Stop 閘：應擋（實案句與同型寫法）===');
expectBlock(['草稿已建好。\n附件為空，等使用者自行拖入三檔：a.sql、b.py、CHANGELOG.md。'], '實案：等使用者自行拖入三檔');
expectBlock(['其他待辦沒變：\n- 10/8 回信草稿還要你拖進三個附件再送出。'], '實案：還要你拖進三個附件');
expectBlock(['請你把這三個檔案附上後再寄出。'], '請你把檔案附上');
expectBlock(['附件請您自行上傳到草稿。'], '附件請您自行上傳');
expectBlock(['檔案需要手動附加到草稿裡。'], '手動附加檔案');
expectBlock(['Please drag the attachment into the draft.'], '英文 drag attachment');

console.log('=== Stop 閘：應放行 ===');
expectAllow(['為什麼上次叫你自己拖附件：是我沒照規則做。'], '回顧句（為什麼／上次）');
expectAllow(['三個附件已經掛進草稿，我用瀏覽器在 Gmail 網頁上直接上傳檔案。'], '我方已附');
expectAllow(['規則寫明不要叫使用者自己拖附件。'], '引用規則（不要）');
expectAllow(['無法代附：檔案 300MB 且無瀏覽器，請你從雲端硬碟連結取檔。'], '「無法代附：」聲明句');
expectAllow(['草稿已建好，寄出要你自己按送出。'], '只叫使用者送出（沒有附件動作）');
expectAllow(['Stop 硬擋：回覆如果把附檔丟回給使用者（「拖進」「自行附上」這類句子）就擋下。'], '引號內的例句（描述這道閘本身）');
expectBlock(['請你把「a.sql」拖進草稿附件。'], '檔名在引號內、動作在引號外仍要擋');
expectAllow(['檔案由我自己附完再結束。'], '我自己附（我方動手）');
expectBlock(['檔案請你自己附上。'], '你自己附上仍要擋');
expectAllow(['完成。'], '收尾沒有命中', { midText: '附件等你拖進去' });
expectAllow([], '沒有任何文字');
{
  const r = runStop(['還要你拖進三個附件再送出。'], { active: true });
  check(r.code === 0 && !r.out.decision && /已擋過一次/.test(r.out.systemMessage || ''), 'stop_hook_active：第二次改提醒放行', JSON.stringify(r));
}
{
  const r = spawnSync('node', [GATE], { input: '{"transcript_path":"' + path.join(TMP, 'nope.jsonl').replace(/\\/g, '\\\\') + '"}', encoding: 'utf8' });
  check(r.status === 0 && !r.stdout, 'transcript 讀不到：fail-open 放行', JSON.stringify(r.stdout));
}

console.log('=== Stop 閘：表格列不判斷（2026-11-02 誤判實案）===');
expectAllow(['| 主旨 | 時間 | 附件 |\n|---|---|---|\n| 碳排-手動上傳基本資料 檔案無法上傳 | 10-15 09:03 | `1.3入庫品碳排基本資料上傳範本.xlsx`、`image001.jpg`（信內錯誤截圖） |'], '實案：表格裡的客戶問題標題含「手動上傳」');
expectBlock(['| 主旨 | 附件 |\n|---|---|\n| a | b |\n\n附件請您自行上傳到草稿。'], '表格外的丟回句照擋');

expectAllow(['它剛好命中「手動＋上傳」，被當成叫你自己附檔。'], '實案：描述閘的誤判（被當成／命中）');
expectAllow(['這句是誤擋，閘把它當成叫你自己附上檔案。'], '誤擋說明句');
console.log('=== Stop 閘：問要不要下載附件 → 擋（2026-11-02 實案）===');
expectBlock(['要我下載那 4 個附件嗎？ 兩封信共 2 個 Excel、1 張錯誤截圖，總共約 130 KB。'], '實案：要我下載那 4 個附件嗎');
expectBlock(['存到 scratchpad 的新資料夾。你回「可以」，我就下載。'], '實案：你回「可以」，我就下載（同句沒有附件字）');
expectBlock(['無法代附：這次不是寄信草稿，沒有附件要附；那張表列的是我準備下載的客戶附件清單，下載前需要你同意。'], '實案：下載前需要你同意（「無法代附」不豁免）');
expectBlock(['要不要我先把信裡的附件下載下來？'], '要不要下載附件（「要不要」不算否定）');
expectBlock(['附件可以讓我下載嗎？'], '可以讓我下載附件嗎');
expectBlock(['Shall I download the attachments?'], '英文 shall I download');
{
  const r = runStop(['附件請您自行上傳。要我下載信裡的附件嗎？']);
  check(r.out.decision === 'block' && /附檔不丟回／附件直接下載/.test(r.out.reason || ''), '兩種同時命中：標題兩者都列', JSON.stringify(r));
}
{
  const r = runStop(['要我下載那 4 個附件嗎？'], { active: true });
  check(r.code === 0 && !r.out.decision && /附件直接下載.*已擋過一次/.test(r.out.systemMessage || ''), '下載詢問 stop_hook_active：第二次改提醒放行', JSON.stringify(r));
}

console.log('=== Stop 閘：下載相關但不是在問 → 放行 ===');
expectAllow(['4 個附件已下載到 scratchpad，接著派人重現。'], '已下載');
expectAllow(['我已把附件下載下來，Excel 第 3 列是空的。'], '我已下載');
expectAllow(['無法代下載：附件已被寄件者撤回，信裡只剩檔名。'], '「無法代下載：」聲明句');
expectAllow(['規則改成下載附件不用問，例句如「要我下載附件嗎」這類會被擋。'], '引號內的例句');
expectAllow(['客戶說範本下載後打不開，附件是他們重存的版本。'], '描述客戶的下載動作（不是在問）');
expectAllow(['要我先跑測試嗎？'], '一般詢問（與下載無關）');

console.log('=== (H) attachmentClaimWithoutFiles ===');
const c = (input, expect, label) => {
  const r = attachmentClaimWithoutFiles(input);
  check(!!r === expect, label, JSON.stringify(r));
};
c({ htmlBody: '<div dir="ltr">附上三份檔案：<ol><li>a.sql</li></ol></div>', body: '附上三份檔案' }, true, '實案：寫附上、沒帶 attachments');
c({ htmlBody: '<div dir="ltr">附上三份檔案</div>', attachments: [{ filename: 'a.sql', content: 'eA==' }] }, false, '有帶 attachments');
c({ body: 'Please see the attached report.' }, true, '英文 attached');
c({ htmlBody: '<div dir="ltr">好的，週五前回覆</div><div class="gmail_extra"><blockquote class="gmail_quote">如附件</blockquote></div>' }, false, '「如附件」只在引用原信');
c({ body: '好的\n\nOn Thu, Oct 08, 2026 wrote:\n> 請詳附件' }, false, 'body 引用段的附件不算');
c({ body: '好的，收到' }, false, '沒提到附件');
c(null, false, 'null');

console.log('=== (H) posttool 閘實跑 ===');
{
  const toolResponse = { type: 'text', text: JSON.stringify({ id: 'rTEST_claim_' + Date.now(), message: { id: 'm', threadId: 't' } }) };
  const input = {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__claude_ai_Gmail__update_draft',
    tool_input: { draftId: 'x', body: '附上三份檔案', htmlBody: '<div dir="ltr">附上三份檔案</div>' },
    tool_response: toolResponse, tool_use_id: 'u', transcript_path: '', session_id: 's', cwd: '.',
  };
  const r = spawnSync('node', [POST], { input: JSON.stringify(input), encoding: 'utf8' });
  const msg = (() => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return ''; } })();
  check(/沒帶 attachments/.test(msg) && /整批清掉/.test(msg), 'update_draft 沒帶附件：提醒且點出會清掉既有附件', r.stdout);
}

// 2026-11-16 誤判：描述產品行為的句子（拖進檔案會怎樣），同回合與信件、附檔無關
expectAllow(['也就是：圖片真的送到 Claude、它看得到內容；貼文字不受影響；拖進不是圖片的檔案會被擋下'], '描述拖放行為的句子不算把附檔丟回');
expectBlock(['草稿建好了，三個檔案請拖進附件區。'], '有附件語境的「拖進」仍然擋');
expectBlock(['這三個檔案要你手動附上。'], '指名使用者動手的，沒有信件字眼也擋');
expectBlock(['草稿建好了。三個檔案請拖進去。'], '這一回合建過草稿，「拖進去」仍然擋', { tool: 'mcp__claude_ai_Gmail__create_draft' });
expectAllow(['看板改好了，聊天框可以貼圖片和附件。拖進不是圖片的檔案會被擋下'], '前一句提到附件、這一句描述產品拖放，沒動過草稿：放行');
expectAllow(['## 附件處理\n拖進不是圖片的檔案會被擋下'], '標題提到附件、下一行描述拖放：放行');
expectAllow(['修好 email 解析。拖到視窗的檔案會被讀取'], 'email 不算 mail');
expectAllow(['看板改好了。拖進不是圖片的檔案會被擋下'], '別的服務的 send_message（Slack）不算信件回合', { tool: 'mcp__slack__send_message' });
expectBlock(['三個檔案請拖進去。'], '先建 Gmail 草稿、之後又跑別的工具：整個回合仍算信件回合', { tools: [{ name: 'mcp__claude_ai_Gmail__create_draft' }, { name: 'Bash' }] });
expectBlock(['三個檔案請拖進去。'], '用瀏覽器開著 Gmail 寫信也算信件回合', { tools: [{ name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://mail.google.com/mail/u/0/#drafts' } }] });
expectBlock(['檔案拖到信裡再寄。'], '短說法「信裡、寄」也算信件語境');
expectAllow(['我相信拖進不是圖片的檔案會被擋下，這是看板的行為。'], '單一個「信」字（相信）不算信件語境');

console.log('=== Stop 閘：講功能不是在問（2026-11-23 誤判實案）===');
expectAllow(['8. 另一台電腦預覽檔案可以下載。'], '實案：功能清單「預覽檔案可以下載」');
expectAllow(['8. 另一台電腦預覽檔案可以下載'], '實案原樣：沒有句號');
expectAllow(['從另一台裝置，你可以上傳檔案給小秘書。'], '講功能：你可以上傳檔案');
expectAllow(['你也能把檔案拖進輸入框。'], '講功能：你能把檔案拖進來');
expectBlock(['這個檔案可以下載嗎？'], '信件回合問「檔案可以下載嗎」仍擋', { tool: 'mcp__claude_ai_Gmail__get_thread' });
expectBlock(['信裡的檔案可以下載嗎'], '信件語境、沒有問號');
expectBlock(['要我把那兩個檔案下載下來嗎？'], '問我方下載，沒有信件字眼');
expectBlock(['**要我下載附件嗎？**'], '粗體包住的問句');
for (const t of ['**附件要下載嗎**', '**附件可以下載嗎?**', '附件可以下載嗎～', '附件可以下載嗎（共 3 個）', '要我下載附件嗎? 你說一聲我就處理。', 'Should I download the attachment? Let me know.', '要我下載附件的話跟我說一聲。', '要我下載附件的話告訴我。', '需要我下載附件，告訴我一聲。', '要我下載附件的話麻煩直接告訴我。', '要我下載附件的話**告訴我**。', '要我下載附件的話再跟我講。', '要我下載客戶的附件就告訴我。', '要我下載其他附件的話告訴我。', 'Then should I download the attachment', '下載前請同意。', '你核可就下載。', '你同意的話就抓檔案。', 'Should I download the attachment', 'Can I download the attachments, or will you send the text.', 'The mail has 3 files. Shall I download the attachments', '請告訴我是否要下載附件。', '你同意後就下載附件。', '你同意的話就把附件抓下來。', '三個檔案你可以自行上傳。', '你可能需要手動上傳檔案。', '你可以手動把檔案拖進去。', '你可以自行把三個檔案上傳。', '要我下載附件嗎 😊', '要我下載附件嗎?!']) expectBlock([t], '在等回覆／指名使用者動手：' + t);
expectBlock(['草稿建好了（附件請你自行上傳）'], '括號裡叫使用者自己附');
for (const t of ['請下載附件核對後告訴我結果。', '這樣附件就能下載了，要部署的話跟我說一聲。', '為了能下載附件，我加了權限，部署時間你決定。', 'This is the page where I can download the attachment.', '下載端點回我改的訊息，請指定要下載的檔案。', '報表檔案可以直接下載，也能預覽。', '另一台電腦的檔案可以抓，也可以下載。']) expectAllow([t], '描述句：' + t);
for (const t of ['請讓我下載附件。', '檔案可以下載，是否下載', '檔案可不可以下載', '待確認：檔案可不可以下載', '客戶信裡有 4 個附件，共 5 MB。這些檔案可以直接下載', '等你核可就會下載。', '你核可就能開始下載檔案。', '下一步：可以下載檔案，待核可。', '檔案可以下載的話回一聲。', '檔案超過上限，你只能從瀏覽器上傳。', '三個檔案請你幫忙上傳，上限 25MB，你可以一次拖進去。', '請確認是否下載附件。', '附件要不要下載，請回覆。', '等你確認是否可以下載附件。', '待確認：是否下載附件', '需要我下載附件請告知。', '我可以下載附件，等你同意。', '要我下載附件嗎，還是你把內文貼給我。', '要我下載附件請回「好」。', '請確認是否需要我下載附件。', '你核可後我們就會下載附件。', '下載前請同意授權。', '檔案可以下載，請確認。', '這些檔案可以下載，你決定。', '檔案可以下載？', '可以下載檔案嗎，共 3 個']) expectBlock([t], '在徵求許可（不列舉等回覆的說法）：' + t);
expectBlock(['等你決定要不要我下載附件。'], '「要不要我下載」沒有問號');
expectBlock(['附件可以讓我下載的話說一聲。'], '「可以讓我下載」沒有問號');
expectBlock(['Can I download the attachment?'], '英文問號');
expectBlock(['你同意我就下載。'], '你同意我就下載');
expectBlock(['你可以把檔案上傳到草稿裡再寄出。'], '有信件語境的「你可以上傳」仍擋');
expectBlock(['你可以把附件拖進去。'], '「你可以」＋附件仍擋');

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
