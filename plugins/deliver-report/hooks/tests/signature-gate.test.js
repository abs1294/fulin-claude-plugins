#!/usr/bin/env node
/**
 * signature-gate 的測試 — 草稿不得弄丟使用者的 Gmail 簽名檔
 *
 * 由來：2026-10-21 實案。建新信草稿後簽名檔不見；實測 create_draft 預設不帶簽名檔、
 * update_draft 帶新內文會把簽名檔清掉。實跑 hook 子程序（家目錄指到暫存目錄，狀態檔不碰真實家目錄）：
 *   1. create_draft：沒帶 includeSignature → 擋；帶 true → 放；回覆草稿同規則；
 *      內文已含 gmail_signature 又帶 true → 擋（兩份）；已含、沒帶 → 放；只帶 body 沒帶 → 擋
 *   2. update_draft 依「這封草稿目前有沒有簽名」判斷（posttool 閘在讀回／寫入時記）：
 *      不知道 → 擋並要求讀回；讀回有簽名 → 新內文沒保留就擋、保留就放；
 *      讀回確認原本沒有簽名 → 放（不會卡死）；只改收件人／主旨 → 放
 *   3. 內容掃描不把簽名檔當正文：posttool 閘不因簽名裡的電話／email／<span style> 報警；
 *      日報草稿 update 帶簽名，daily-draft-gate 不把簽名裡的電話／email 當個資擋下
 *   4. stripSignature：巢狀 div、沒有結尾、兩份簽名；Stop 閘副本與 core 不漂移
 *   5. 非 Gmail 工具、壞輸入 → 放
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..');
const GATE = path.join(HOOKS, 'gmail-draft-signature-gate.js');
const POST = path.join(HOOKS, 'gmail-draft-posttool-gate.js');
const DAILY = path.join(HOOKS, 'daily-draft-gate.js');
const C = require(path.join(HOOKS, 'lib', 'draft-checks.core.js'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-sig-'));
const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });

// 結構照 2026-10-21 實測讀回的簽名檔（電話、email 換成假值）
const SIG = '<div><br><div class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">' +
  '<span style="color:rgb(34,34,34);font-size:10.5pt">====<br>林甫軒<br>Mobile :  +886 912 345 678<br>' +
  '<a href="mailto:someone@example.com" style="color:rgb(17,85,204)" target="_blank">Email :  someone@example.com</a>' +
  '<br>Website :  <a href="https://www.example.com">www.example.com</a><br>====</span><br></div></div></div>';

let pass = 0, fail = 0;
function check(desc, got, want) {
  if (got === want) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

function spawn(script, input, timeout) {
  const r = spawnSync('node', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: timeout || 10000, env,
  });
  if (r.error) throw r.error;
  return r.stdout || '';
}
function decision(out) {
  try {
    const o = JSON.parse(out);
    return (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny') ? 'deny' : 'allow';
  } catch (_) { return 'allow'; }
}
const G = (tool, toolInput) => decision(spawn(GATE, { tool_name: tool, tool_input: toolInput }));
function post(tool, toolInput, result) {
  return spawn(POST, { tool_name: tool, tool_input: toolInput, tool_use_id: 'u' + Math.random(),
    tool_response: { type: 'text', text: JSON.stringify(result) } });
}

const CREATE = 'mcp__claude_ai_Gmail__create_draft';
const UPDATE = 'mcp__claude_ai_Gmail__update_draft';
const GET = 'mcp__claude_ai_Gmail__get_draft';

console.log('=== 1. create_draft ===');
check('沒帶 includeSignature → 擋', G(CREATE, { to: ['a@b.c'], htmlBody: '<b>hi</b>' }), 'deny');
check('includeSignature:false → 擋', G(CREATE, { htmlBody: '<b>hi</b>', includeSignature: false }), 'deny');
check('includeSignature:"true"（字串）→ 擋', G(CREATE, { htmlBody: '<b>hi</b>', includeSignature: 'true' }), 'deny');
check('includeSignature:true → 放', G(CREATE, { htmlBody: '<b>hi</b>', includeSignature: true }), 'allow');
check('只帶 body、沒帶 → 擋', G(CREATE, { body: 'hi' }), 'deny');
check('只帶 body、帶 true → 放', G(CREATE, { body: 'hi', includeSignature: true }), 'allow');
check('回覆草稿帶 true → 放', G(CREATE, { replyToMessageId: 'x', htmlBody: '<b>hi</b>', includeSignature: true }), 'allow');
check('回覆草稿沒帶 → 擋', G(CREATE, { replyToMessageId: 'x', htmlBody: '<b>hi</b>' }), 'deny');
check('內文已含簽名又帶 true → 擋（兩份）', G(CREATE, { htmlBody: '<b>hi</b>' + SIG, includeSignature: true }), 'deny');
check('內文已含簽名、沒帶 → 放', G(CREATE, { htmlBody: '<b>hi</b>' + SIG }), 'allow');

console.log('=== 2. update_draft 依草稿目前的簽名狀態 ===');
check('不知道狀態（沒讀回過）→ 擋', G(UPDATE, { draftId: 'r-unknown', htmlBody: '<b>new</b>' }), 'deny');
check('不知道狀態、新內文帶簽名 → 放', G(UPDATE, { draftId: 'r-unknown', htmlBody: '<b>new</b>' + SIG }), 'allow');
check('只改主旨 → 放', G(UPDATE, { draftId: 'r-unknown', subject: 'x' }), 'allow');
check('只改收件人 → 放', G(UPDATE, { draftId: 'r-unknown', to: ['a@b.c'] }), 'allow');

post(GET, { draftId: 'r-has' }, { id: 'r-has', htmlBody: '<b>old</b>' + SIG });
check('讀回有簽名 → 新內文沒保留就擋', G(UPDATE, { draftId: 'r-has', htmlBody: '<b>new</b>' }), 'deny');
check('讀回有簽名 → 只帶 body 也擋', G(UPDATE, { draftId: 'r-has', body: 'new' }), 'deny');
check('讀回有簽名 → 保留就放', G(UPDATE, { draftId: 'r-has', htmlBody: '<b>new</b>' + SIG }), 'allow');
check('讀回有簽名 → htmlBody 保留＋body 一起帶 → 放', G(UPDATE, { draftId: 'r-has', htmlBody: '<b>new</b>' + SIG, body: 'new' }), 'allow');

post(GET, { draftId: 'r-none' }, { id: 'r-none', htmlBody: '<div dir="ltr">網頁上建的、沒設簽名</div>' });
check('讀回確認原本沒簽名 → 改內文放行（不會卡死）', G(UPDATE, { draftId: 'r-none', htmlBody: '<b>new</b>' }), 'allow');
check('讀回確認原本沒簽名 → 只帶 body 也放', G(UPDATE, { draftId: 'r-none', body: 'new' }), 'allow');

post(GET, { draftId: 'r-plain' }, { id: 'r-plain', plaintextBody: '純文字草稿' });
check('純文字草稿讀回（沒有 htmlBody）→ 記為沒簽名，改內文放行',
  G(UPDATE, { draftId: 'r-plain', htmlBody: '<b>new</b>' }), 'allow');
post(GET, { draftId: 'r-meta' }, { id: 'r-meta', subject: 'x' });
check('只讀回中繼資料（沒有內文）→ 狀態仍未知，照樣擋',
  G(UPDATE, { draftId: 'r-meta', htmlBody: '<b>new</b>' }), 'deny');

post(CREATE, { htmlBody: '<b>hi</b>', includeSignature: true }, { id: 'r-new', threadId: 't1' });
check('create 帶 includeSignature 後 → 狀態記為有簽名，update 沒保留就擋',
  G(UPDATE, { draftId: 'r-new', htmlBody: '<b>new</b>' }), 'deny');
post(UPDATE, { draftId: 'r-new', htmlBody: '<b>new</b>' + SIG }, { id: 'r-new', threadId: 't1' });
check('update 保留簽名後 → 狀態仍是有簽名', C.signatureState(readStateIn(home), 'r-new'), 'sig');
post(UPDATE, { draftId: 'r-new', subject: '只改主旨' }, { id: 'r-new', threadId: 't1' });
check('只改主旨的 update 不動簽名狀態', C.signatureState(readStateIn(home), 'r-new'), 'sig');

console.log('=== 3. 內容掃描不把簽名檔當正文 ===');
const postOut = post(UPDATE, { draftId: 'r-has', htmlBody: '<b>正文沒問題</b>' + SIG }, { id: 'r-has', threadId: 't2' });
check('posttool：簽名裡的電話／email／<span style> 不報警', /機敏|白名單以外|佔位符/.test(postOut), false);
const postBad = post(UPDATE, { draftId: 'r-has', htmlBody: '<p>正文用了 p 標籤</p>' + SIG }, { id: 'r-has', threadId: 't2' });
check('posttool：正文自己的問題照報（<p>）', /白名單以外/.test(postBad), true);
const postSigUrl = post(UPDATE, { draftId: 'r-url1', htmlBody: '<b>正文沒有網址</b>' + SIG }, { id: 'r-url1', threadId: 't3' });
check('posttool：只有簽名檔裡有網址 → 不提醒「含網址」', /含網址/.test(postSigUrl), false);
const postOwnUrl = post(UPDATE, { draftId: 'r-url2', htmlBody: '<b>請看 https://example.org/report</b>' + SIG }, { id: 'r-url2', threadId: 't4' });
check('posttool：正文自己有網址 → 照樣提醒', /含網址/.test(postOwnUrl), true);

const SUBJ = '[工作日報] 2026-10-21 工作日報';
const clean = '# 工作日報 2026-10-21\n\n## 一、供應商平台\n\n- 完成國外廠商寫入規格整理\n\n## 二、內部工具\n\n- 更新交付文件檢查\n';
const cleanHtml = '<b>工作日報 2026-10-21</b><br><b>一、供應商平台</b><ul><li>完成國外廠商寫入規格整理</li></ul>' +
  '<b>二、內部工具</b><ul><li>更新交付文件檢查</li></ul>';
const daily = (ti) => decision(spawn(DAILY, { cwd: os.tmpdir(), tool_name: UPDATE, tool_input: ti }, 120000));
check('日報 update 帶簽名（電話＋email）→ daily-draft-gate 放行',
  daily({ draftId: 'r-daily', subject: SUBJ, body: clean, htmlBody: cleanHtml + SIG }), 'allow');
check('日報 update 正文自己含 email → daily-draft-gate 照擋',
  daily({ draftId: 'r-daily', subject: SUBJ, body: clean + '\n- 聯絡 someone@example.com\n',
    htmlBody: cleanHtml + '<ul><li>聯絡 someone@example.com</li></ul>' + SIG }), 'deny');

console.log('=== 4. stripSignature ===');
check('剝掉整段（含巢狀 div），正文保留', C.stripSignature('<b>A</b>' + SIG + '<i>B</i>'), '<b>A</b><div><br></div><i>B</i>');
check('沒有簽名 → 原樣', C.stripSignature('<div>x</div>'), '<div>x</div>');
check('簽名沒有結尾 → 不剝（後面的內容不能藏起來躲內容閘）',
  C.stripSignature('<b>A</b><div class="gmail_signature"><div>x password=abc'), '<b>A</b><div class="gmail_signature"><div>x password=abc');
check('兩份簽名都拿掉', C.hasSignature(C.stripSignature(SIG + SIG)), false);
check('六份簽名都拿掉（沒有份數上限）', C.hasSignature(C.stripSignature(SIG.repeat(6))), false);
check('回覆草稿：簽名剝掉、引用原信保留',
  C.stripSignature('<b>正文</b><br><div class="gmail_extra">' + SIG + '<div>On … wrote:<blockquote>原信</blockquote></div></div>'),
  '<b>正文</b><br><div class="gmail_extra"><div><br></div><div>On … wrote:<blockquote>原信</blockquote></div></div>');
check('非字串 → 空字串', C.stripSignature(null), '');
const linkSrc = fs.readFileSync(path.join(HOOKS, 'gmail-draft-link-gate.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(HOOKS, 'lib', 'draft-checks.core.js'), 'utf8');
const fnOf = (src) => { const i = src.indexOf('function stripSignature(html) {'); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
check('Stop 閘副本與 core 逐字一致（不漂移）', fnOf(linkSrc) === fnOf(coreSrc) && fnOf(coreSrc).length > 50, true);

console.log('=== 5. 不相干的輸入 ===');
check('非 Gmail 工具 → 放', G('mcp__other__create_draft', { htmlBody: '<b>hi</b>' }), 'allow');
check('get_draft → 放', G(GET, { draftId: 'r1' }), 'allow');
check('壞輸入 → 放', decision(spawn(GATE, '{not json')), 'allow');

function readStateIn(h) {
  try {
    const p = path.join(h, '.claude', 'deliver-report', 'draft-link-gate', 'warned.json');
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { warned: Array.isArray(o.warned) ? o.warned : [] };
  } catch (_) { return { warned: [] }; }
}

try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* 暫存目錄清不掉不影響結果 */ }
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
