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
  lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
  lines.push({ type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
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
  const msg = (() => { try { return JSON.parse(r.stdout).hookSpecificOutput.systemMessage; } catch (_) { return ''; } })();
  check(/沒帶 attachments/.test(msg) && /整批清掉/.test(msg), 'update_draft 沒帶附件：提醒且點出會清掉既有附件', r.stdout);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
