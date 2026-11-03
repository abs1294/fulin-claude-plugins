#!/usr/bin/env node
/**
 * paragraph-gate 閘的測試 — htmlBody 不准用 <p> 分段（PreToolUse 硬擋）
 *
 * 由來：2026-11-03 實案。回覆草稿寫成 <p>Hi Soloment,<br>…</p>\n\n<p>…</p>，PostToolUse 閘
 * 提醒了「白名單以外：<p>」但只是提醒，草稿照樣交付；Gmail 把 <p> 邊距原樣顯示，收件人列和
 * 稱謂行之間空一大段，使用者截圖退件。這支測試實跑 hook 子程序，另直接測 core 的三個判準。
 *
 * 跑法：node hooks/tests/paragraph-gate.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..');
const GATE = path.join(HOOKS, 'gmail-draft-paragraph-gate.js');
const C = require(path.join(HOOKS, 'lib', 'draft-checks.core.js'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-para-'));
const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + '\n        got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

function run(input) {
  const r = spawnSync('node', [GATE], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000, env,
  });
  if (r.error) throw r.error;
  return { out: r.stdout || '', code: r.status };
}
function decision(input) {
  const { out } = run(input);
  if (!out) return 'allow';
  try {
    const o = JSON.parse(out);
    return (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny') ? 'deny' : 'allow';
  } catch (_) { return 'allow'; }
}
function reason(input) {
  try { return JSON.parse(run(input).out).hookSpecificOutput.permissionDecisionReason; } catch (_) { return ''; }
}
const call = (tool, toolInput) => ({ tool_name: 'mcp__claude_ai_Gmail__' + tool, tool_input: toolInput });

const SIG = '<div class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><p>甫軒</p><span style="color:#888">02-1234-5678</span></div></div>';
const QUOTE = '<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon wrote:</div>' +
  '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">' +
  '<div class="WordSection1"><p class="MsoNormal">原信第一段</p><p class="MsoNormal">原信第二段</p></div></blockquote></div>';
// 2026-11-03 實案的形狀（內容改寫）
const REAL = '<p>Hi Soloment,<br>感謝您回傳的檢查結果。</p>\n\n<p>升級腳本也一併調整了。</p>\n\n<p><b>一、前台</b></p>\n<ol>\n<li>先備份：<br><code>sudo bash upgrade.sh</code></li>\n</ol>';

console.log('=== 合規寫法 → 放行 ===');
check('外層 div + br（SKILL 範例寫法）', decision(call('create_draft', { subject: 's', includeSignature: true, htmlBody: '<div dir="ltr">Hi 暉東,<br>正式站已上線。<br><br>請確認：<br><ol><li>一</li><li>二</li></ol><br>Best Regards,<br>甫軒</div>' })), 'allow');
check('<pre>／<param>／<picture> 不是 <p>', decision(call('create_draft', { htmlBody: '<div dir="ltr"><pre>a</pre><param name="x"><picture></picture></div>' })), 'allow');
check('屬性值裡的 <p> 不是標籤', decision(call('create_draft', { htmlBody: '<div dir="ltr"><a title="<p>" href="#">說明</a></div>' })), 'allow');
check('HTML 註解裡的 <p> 不是標籤', decision(call('create_draft', { htmlBody: '<div dir="ltr"><!-- <p>備註</p> --><b>正文</b></div>' })), 'allow');
check('&lt;p&gt; 實體是文字', decision(call('create_draft', { htmlBody: '<div dir="ltr">寫成 &lt;p&gt; 的文字<br></div>' })), 'allow');
check('孤兒 </p> 不報（沒有開頭就沒有邊距）', decision(call('create_draft', { htmlBody: '<div dir="ltr">x</p></div>' })), 'allow');
check('只有 body 純文字、沒有 htmlBody', decision(call('create_draft', { body: '<p>純文字裡寫 p 標籤</p>' })), 'allow');
check('htmlBody 空字串', decision(call('update_draft', { draftId: 'r1', htmlBody: '' })), 'allow');

console.log('=== 用了 <p> → 擋 ===');
check('2026-11-03 實案形狀 → deny', decision(call('create_draft', { subject: 'RE: x', includeSignature: true, replyToMessageId: 'm1', htmlBody: REAL })), 'deny');
check('update_draft 同樣擋', decision(call('update_draft', { draftId: 'r1', htmlBody: '<div dir="ltr"><p>x</p></div>' + SIG })), 'deny');
check('大寫 <P>', decision(call('create_draft', { htmlBody: '<P>x</P>' })), 'deny');
check('<p 換行再接屬性', decision(call('create_draft', { htmlBody: '<p\nclass="x">x</p>' })), 'deny');
check('自閉合 <p/>', decision(call('create_draft', { htmlBody: 'a<p/>b' })), 'deny');
check('<p class="MsoNormal"> 在正文（不在引用區）', decision(call('create_draft', { htmlBody: '<div dir="ltr"><p class="MsoNormal">貼自 Outlook</p></div>' })), 'deny');
check('屬性值裡有 > 也要讀完整個標籤再比對', decision(call('create_draft', { htmlBody: '<p title="a>b">x</p>' })), 'deny');

console.log('=== 引用區與簽名檔裡的 <p> 不算 ===');
check('簽名檔裡的 <p>（Gmail 自己的）→ 放行', decision(call('create_draft', { htmlBody: '<div dir="ltr">Hi,<br>正文</div>' + SIG })), 'allow');
check('gmail_quote 裡 Outlook 的 <p class="MsoNormal"> → 放行', decision(call('update_draft', { draftId: 'r2', htmlBody: '<div dir="ltr">Hi,<br>正文</div>' + SIG + QUOTE })), 'allow');
check('裸 <blockquote> 裡的 <p> → 放行', decision(call('update_draft', { draftId: 'r3', htmlBody: '<div dir="ltr">x</div><blockquote><p>原信</p><blockquote><p>更早的原信</p></blockquote></blockquote>' })), 'allow');
check('舊版 gmail_extra 裡的 <p> → 放行', decision(call('update_draft', { draftId: 'r4', htmlBody: '<div dir="ltr">x</div><div class="gmail_extra"><div class="gmail_quote"><p>原信</p></div></div>' })), 'allow');
check('正文有 <p>、引用區也有 → 仍擋', decision(call('update_draft', { draftId: 'r5', htmlBody: '<div dir="ltr"><p>自己寫的</p></div>' + QUOTE })), 'deny');
check('引用區沒收尾（剝不掉）→ 照正文算、擋', decision(call('update_draft', { draftId: 'r6', htmlBody: '<div dir="ltr">x</div><div class="gmail_quote"><p>原信</p>' })), 'deny');

console.log('=== 訊息內容 ===');
const r = reason(call('create_draft', { htmlBody: REAL }));
check('理由講出處數與樣本', /共 3 處/.test(r) && /<p>/.test(r), true);
check('理由給修法 <br><br> 與稱謂行寫法', /<br><br>/.test(r) && /Hi X,<br>/.test(r), true);
check('理由講明引用區不算', /gmail_quote/.test(r) && /blockquote/.test(r), true);
check('正文有 <p>、引用區也有 → 只數正文的', /共 1 處/.test(reason(call('update_draft', { draftId: 'r5', htmlBody: '<div dir="ltr"><p>自己寫的</p></div>' + QUOTE }))), true);

console.log('=== 不相干的輸入 → 放行（FAIL-OPEN）===');
check('get_draft', decision(call('get_draft', { draftId: 'r1' })), 'allow');
check('send_message', decision(call('send_message', { htmlBody: '<p>x</p>' })), 'allow');
check('非 Gmail 工具', decision({ tool_name: 'Write', tool_input: { content: '<p>x</p>' } }), 'allow');
check('壞 JSON', decision('{not json'), 'allow');
check('空輸入', decision(''), 'allow');
check('tool_input 不是物件', decision({ tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: '<p>x</p>' }), 'allow');
check('htmlBody 不是字串', decision(call('create_draft', { htmlBody: ['<p>x</p>'] })), 'allow');
check('exit code 一律 0（deny 也是）', run(call('create_draft', { htmlBody: '<p>x</p>' })).code, 0);

console.log('=== core 判準直接測 ===');
check('paragraphTags 回傳標籤原文', C.paragraphTags('<p>a</p><P class="b">c</P>'), ['<p>', '<P class="b">']);
check('paragraphTags 長標籤截斷', C.paragraphTags('<p ' + 'a="1" '.repeat(20) + '>x</p>')[0].length <= 41, true);
check('paragraphTags 非字串', C.paragraphTags(null), []);
check('paragraphTags：<p:custom>／<p-x>／<p3> 不是 <p>', C.paragraphTags('<p:custom>a</p:custom><p-x>b</p-x><p3>c</p3>'), []);
check('paragraphTags：沒有收尾 > 的 <p 不算標籤', C.paragraphTags('<div dir="ltr">x<p class="a'), []);
check('stripQuotedRegions 剝 gmail_quote 連 blockquote', C.stripQuotedRegions('<div dir="ltr">mine</div>' + QUOTE), '<div dir="ltr">mine</div><br>');
check('stripQuotedRegions 也剝簽名檔（段落閘不再呼叫正則版 stripSignature）', C.stripQuotedRegions('<div dir="ltr">a</div>' + SIG + 'tail'), '<div dir="ltr">a</div>tail');
check('stripQuotedRegions 不碰正文裡的 div', C.stripQuotedRegions('<div dir="ltr">a<div>b</div></div>'), '<div dir="ltr">a<div>b</div></div>');
check('stripQuotedRegions 沒收尾不剝', C.stripQuotedRegions('a<blockquote><p>x</p>'), 'a<blockquote><p>x</p>');
check('stripQuotedRegions 可重複呼叫（無殘留狀態）', C.stripQuotedRegions(C.stripQuotedRegions('x<blockquote>a</blockquote>y')), 'xy');
check('stripQuotedRegions：引用區裡的自閉合 <div/> 不計深度（審查 FP14）', C.stripQuotedRegions('x<div class="gmail_quote"><div/><p>原信</p></div>y'), 'xy');
check('stripQuotedRegions：引用區裡屬性值含 <div> 不計深度（審查 FP13）', C.stripQuotedRegions('x<div class="gmail_quote"><a title="<div>">k</a><p>原信</p></div>y'), 'xy');
check('stripQuotedRegions：引用區裡註解含 </div> 不計深度（審查 FP15）', C.stripQuotedRegions('x<div class="gmail_quote"><!-- </div> --><p>原信</p></div>y'), 'xy');
check('stripQuotedRegions：大寫 CLASS="gmail_quote" 也認', C.stripQuotedRegions('x<DIV CLASS="gmail_quote"><p>q</p></DIV>y'), 'xy');
check('stripQuotedRegions：屬性區超過 2000 字元不當引用區開頭', C.stripQuotedRegions('x<div class="gmail_quote" ' + 'a="1" '.repeat(500) + '><p>q</p></div>y').indexOf('<p>q</p>') !== -1, true);
check('scanTags：沒有收尾 > 就停、不回呼', (() => { const got = []; C.scanTags('<b>a</b><div class="x', (t) => got.push(t.name)); return got; })(), ['b', 'b']);

console.log('=== 效能（線性掃描，不可被長輸入拖過 hook timeout 15s）===');
// 2026-11-03 獨立審查實測：正則版 stripBalanced 在「沒有 >」的輸入上二次方回溯，
// '<div '.repeat(50000) 跑 19 秒、'<div class="gmail_quote'.repeat(20000) 超過 60 秒被 SIGTERM。
// 這幾例全部走端對端（stripQuotedRegions + paragraphTags），門檻放 2 秒、實測應在 50ms 內。
const PERF = [
  ['16 萬空白', '<' + ' '.repeat(160000) + '!'],
  ['6 萬個沒收尾的 <p ', '<p '.repeat(60000)],
  ['2 萬層沒收尾的 <blockquote>', '<blockquote>'.repeat(20000) + '<p>x</p>'],
  ['1 萬層平衡巢狀 blockquote', '<blockquote>'.repeat(10000) + '<p>x</p>' + '</blockquote>'.repeat(10000)],
  ['5 萬個 "<div " 沒有 >（審查抓到 19s）', '<div '.repeat(50000)],
  ['2 萬個 "<div class=\\"" 沒有 >（審查抓到 21s）', '<div class="'.repeat(20000)],
  ['2 萬個 "<div class=\\"gmail_quote" 沒有 >（審查抓到 >60s）', '<div class="gmail_quote'.repeat(20000)],
  ['gmail_quote 開頭後接 5 萬個 "<div "（審查抓到 17s）', '<div class="gmail_quote">' + '<div '.repeat(50000)],
  ['2 萬個 "<blockquote " 沒有 >（審查抓到 3.3s）', '<blockquote '.repeat(20000)],
  ['30 萬個 <', '<'.repeat(300000)],
  ['2.2 萬個互不相同的 <p a=N>', Array.from({ length: 22000 }, (_, i) => '<p a=' + i + '>').join('')],
  ['單一標籤屬性區 20 萬個斜線', '<div ' + '/'.repeat(200000) + '>'],
];
for (const [label, input] of PERF) {
  const t0 = Date.now();
  C.paragraphTags(C.stripQuotedRegions(input));
  const d = Date.now() - t0;
  check(label + '（長度 ' + input.length + '，實測 ' + d + 'ms）< 2s', d < 2000, true);
}
// 端對端含 node 啟動：真的餵 hook 子程序
{
  const t0 = Date.now();
  const d0 = decision(call('create_draft', { htmlBody: '<div class="gmail_quote">' + '<div '.repeat(50000) }));
  const d = Date.now() - t0;
  check('hook 子程序端對端 5 萬個 "<div " < 5s（實測 ' + d + 'ms，結果 ' + d0 + '）', d < 5000, true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
