#!/usr/bin/env node
/**
 * 2026-11-13 實案補的四件事的測試（實跑 hook 子程序）：
 *   一、gmail-draft-skill-gate：沒載入 deliver-report 就 create_draft → deny；只認結構，不認字串
 *   二、gmail-draft-format-gate：只給 body → deny；<br> 手打序號／列點 → deny
 *   三、gmail-draft-posttool-gate：提醒走 additionalContext（模型看得到）；結構、術語、裸網域、讀回多出連結
 *   四、draft-checks.core：bareDomains／hasUrl／bare <span> 白名單／lacksStructure／unexplainedJargon
 * USERPROFILE／HOME 指到暫存目錄，狀態檔不碰真實家目錄。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..');
const C = require(path.join(HOOKS, 'lib', 'draft-checks.core.js'));
const SKILL = path.join(HOOKS, 'gmail-draft-skill-gate.js');
const FORMAT = path.join(HOOKS, 'gmail-draft-format-gate.js');
const POST = path.join(HOOKS, 'gmail-draft-posttool-gate.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-fmt-'));
let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + '\n        got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}
function freshHome() { return fs.mkdtempSync(path.join(TMP, 'h-')); }
function run(script, input, home) {
  const h = home || freshHome();
  const r = spawnSync('node', [script], { input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { USERPROFILE: h, HOME: h }) });
  if (r.error) throw r.error;
  return r.stdout || '';
}
function decision(out) {
  try { const o = JSON.parse(out); return o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny' ? 'deny' : 'allow'; }
  catch (_) { return 'allow'; }
}
let tn = 0;
function transcript(objs) {
  const f = path.join(TMP, 't' + (++tn) + '.jsonl');
  fs.writeFileSync(f, objs.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  return f;
}
const G = 'mcp__claude_ai_Gmail__';

console.log('=== 一、skill-gate：沒載入 deliver-report 就擋 create_draft ===');
function sg(objs, sid, tool) {
  const tp = objs === null ? path.join(TMP, 'missing.jsonl') : transcript(objs);
  return decision(run(SKILL, { tool_name: G + (tool || 'create_draft'), session_id: sid, transcript_path: tp, tool_input: {} }));
}
const asst = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const user = (content) => ({ type: 'user', message: { role: 'user', content } });
check('完全沒載入 → deny', sg([user('回信說明'), asst([{ type: 'text', text: '好' }])], 's1'), 'deny');
check('Skill tool_use deliver-report:deliver-report → allow', sg([asst([{ type: 'tool_use', name: 'Skill', input: { skill: 'deliver-report:deliver-report' } }])], 's2'), 'allow');
check('Skill tool_use deliver-report:daily-report（同 plugin）→ allow', sg([asst([{ type: 'tool_use', name: 'Skill', input: { skill: 'deliver-report:daily-report' } }])], 's3'), 'allow');
check('skill 載入訊息 Base directory …\\deliver-report\\… → allow',
  sg([user([{ type: 'text', text: 'Base directory for this skill: C:\\Users\\U\\.claude\\plugins\\cache\\fulin-plugins\\deliver-report\\2.6.2\\skills\\deliver-report\n\n# deliver-report' }])], 's4'), 'allow');
check('使用者打 slash command → allow', sg([user('<command-name>/deliver-report:deliver-report</command-name>')], 's5'), 'allow');
check('只是在 Bash 指令裡提到字樣 → deny',
  sg([asst([{ type: 'tool_use', name: 'Bash', input: { command: 'echo "Base directory for this skill: C:\\x\\deliver-report\\y" "skill":"deliver-report"' } }])], 's6'), 'deny');
check('assistant 文字提到 Base directory …deliver-report… → deny',
  sg([asst([{ type: 'text', text: 'Base directory for this skill: C:\\deliver-report\\x' }])], 's7'), 'deny');
check('別的 skill、args 提到 deliver-report → deny',
  sg([asst([{ type: 'tool_use', name: 'Skill', input: { skill: 'plugin-manager:plugin-manager-bump', args: 'deliver-report patch' } }])], 's8'), 'deny');
check('update_draft 不經過這道閘 → allow', sg([user('x')], 's9', 'update_draft'), 'allow');
check('transcript 不存在 → allow（fail-open）', sg(null, 's10'), 'allow');
check('沒有 transcript_path → allow', decision(run(SKILL, { tool_name: G + 'create_draft', tool_input: {} })), 'allow');
check('壞 JSON → allow', decision(run(SKILL, '{oops')), 'allow');
{
  // 同 session 放行一次後記 skillok，之後 transcript 換成沒載入的也放行（不再讀檔）
  const h = freshHome();
  const ok = transcript([asst([{ type: 'tool_use', name: 'Skill', input: { skill: 'deliver-report' } }])]);
  const no = transcript([user('x')]);
  run(SKILL, { tool_name: G + 'create_draft', session_id: 'sx', transcript_path: ok, tool_input: {} }, h);
  check('同 session 放行過一次後記帳，之後不再讀 transcript',
    decision(run(SKILL, { tool_name: G + 'create_draft', session_id: 'sx', transcript_path: no, tool_input: {} }, h)), 'allow');
  check('別的 session 不沿用', decision(run(SKILL, { tool_name: G + 'create_draft', session_id: 'sy', transcript_path: no, tool_input: {} }, h)), 'deny');
}

console.log('=== 二、format-gate：只給 body／手打列點 ===');
const fg = (tool, ti) => decision(run(FORMAT, { tool_name: G + tool, tool_input: ti }));
check('create_draft 只給 body → deny', fg('create_draft', { body: 'Hi,\n內容' }), 'deny');
check('update_draft 只給 body → deny（會清掉 HTML 內文）', fg('update_draft', { draftId: 'r', body: 'x' }), 'deny');
check('htmlBody ＋ body → allow', fg('create_draft', { body: 'x', htmlBody: '<div dir="ltr">Hi,<br>內容</div>' }), 'allow');
check('兩個都沒有（只改收件人）→ allow', fg('update_draft', { draftId: 'r', to: ['a@b.c'] }), 'allow');
// 2026-11-13 實案原形：<br>- 與 <br>1. 手打
check('實案：<br>- 手打列點 → deny',
  fg('create_draft', { htmlBody: '<div>來源如下：<br>- application-migration.properties：6/17<br>- application.properties：9/24</div>' }), 'deny');
check('實案：<br>1. 手打序號 → deny',
  fg('create_draft', { htmlBody: '<div>確認幾件事：<br>1. 上 PRD 的流程？<br>2. 測試機？</div>' }), 'deny');
check('改用 <ul><li>／<ol><li> → allow',
  fg('create_draft', { htmlBody: '<div dir="ltr">來源：<ul><li>a</li><li>b</li></ul>確認：<ol><li>c</li><li>d</li></ol></div>' }), 'allow');
check('只有一處 1.（不成清單）→ allow', fg('create_draft', { htmlBody: '<div>1. 只有一項<br>其他</div>' }), 'allow');
check('引用區裡對方手打的列點不算',
  fg('update_draft', { draftId: 'r', htmlBody: '<div dir="ltr">好的</div><div class="gmail_quote"><blockquote>- a<br>- b<br>1. c<br>2. d</blockquote></div>' }), 'allow');
check('<pre> 裡的 1. 不算', fg('create_draft', { htmlBody: '<div>設定：<pre>1. a\n2. b\n- c\n- d</pre></div>' }), 'allow');
check('壞 JSON → allow', decision(run(FORMAT, '{oops')), 'allow');

console.log('=== 三、posttool：提醒送到模型＋新提醒 ===');
function post(tool, ti, result, home) {
  const out = run(POST, { tool_name: G + tool, tool_use_id: 'u' + Math.random(), tool_input: ti,
    tool_response: { type: 'text', text: JSON.stringify(result) } }, home);
  try { return JSON.parse(out); } catch (_) { return null; }
}
{
  const h = freshHome();
  const o = post('create_draft', { subject: 'RE: x', includeSignature: true,
    htmlBody: '<div dir="ltr">Dear Tina,<br>測試設定寫在 jar 同目錄的外部檔案，不進 repo。<pre>logging.file.name=1</pre></div>', body: 'x' },
  { id: 'rP', messageId: 'm', threadId: 't' }, h);
  const ctx = o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext || '';
  check('提醒放在 hookSpecificOutput.additionalContext（模型看得到）', ctx.length > 0, true);
  check('最外層也有 systemMessage（使用者看得到）', !!(o && o.systemMessage), true);
  check('hookSpecificOutput 裡不再放 systemMessage', !!(o && o.hookSpecificOutput && 'systemMessage' in o.hookSpecificOutput), false);
  check('術語提醒點出 jar、repo', /開發術語沒有白話說明：.*repo/.test(ctx) && /jar/.test(ctx), true);
  check('裸網域提醒點出 logging.file.name', /會被 Gmail 當成網址的字串：logging\.file\.name/.test(ctx), true);
  // 讀回：Gmail 把它包成連結
  const r = post('get_draft', { draftId: 'rP', messageFormat: 'FULL_CONTENT' },
    { id: 'rP', htmlBody: '<div dir="ltr">Dear Tina,<br>x<pre><a href="https://www.google.com/url?q=http://logging.file.name">logging.file.name</a>=1</pre></div>' }, h);
  const rc = r && r.hookSpecificOutput && r.hookSpecificOutput.additionalContext || '';
  check('讀回多出 Gmail 自加的連結 → 提醒', /多了 1 個連結：「logging\.file\.name」/.test(rc), true);
}
{
  const h = freshHome();
  post('create_draft', { subject: 's', includeSignature: true, htmlBody: '<div dir="ltr">見 <a href="https://x.tw">說明頁</a></div>', body: 'x' },
    { id: 'rL', messageId: 'm', threadId: 't' }, h);
  const r = post('get_draft', { draftId: 'rL', messageFormat: 'FULL_CONTENT' },
    { id: 'rL', htmlBody: '<div dir="ltr">見 <a href="https://www.google.com/url?q=https://x.tw">說明頁</a></div>' }, h);
  const rc = r && r.hookSpecificOutput && r.hookSpecificOutput.additionalContext || '';
  check('自己寫的 <a> 讀回時 href 被改寫 → 不算多出來的連結', /多了 \d+ 個連結/.test(rc), false);
}
{
  const long = '<div dir="ltr">' + Array(10).fill('這是一段很長的說明文字，用來測試沒有結構的信件內容會不會被判定為一大片文字而需要提醒使用者加上小標').join('<br>') + '</div>';
  const o = post('create_draft', { subject: 's', includeSignature: true, htmlBody: long, body: 'x' }, { id: 'rS', messageId: 'm', threadId: 't' });
  const ctx = o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext || '';
  check('一大片文字沒有結構 → 提醒', /沒有粗體小標、清單或表格/.test(ctx), true);
  const o2 = post('create_draft', { subject: 's', includeSignature: true, htmlBody: long.replace('<div dir="ltr">', '<div dir="ltr"><b>一、來源</b><br>'), body: 'x' }, { id: 'rS2', messageId: 'm', threadId: 't' });
  const ctx2 = o2 && o2.hookSpecificOutput && o2.hookSpecificOutput.additionalContext || '';
  check('有粗體小標 → 不提醒結構', /沒有粗體小標、清單或表格/.test(ctx2), false);
}

console.log('=== 四、core 判準 ===');
check('bareDomains：logging.file.name 命中、.properties／.jar／.enabled 不命中',
  C.bareDomains('logging.file.name=x application.properties msslot.jar mss.scheduling.enabled'), ['logging.file.name']);
check('bareDomains：email 網域不重複報', C.bareDomains('fu.lin@fable.com.tw'), []);
check('bareDomains：<span> 拆開點號後不命中', C.bareDomains('logging<span>.</span>file<span>.</span>name'), []);
check('hasUrl：裸網域也算', C.hasUrl('請設 logging.file.name'), true);
check('hasUrl：一般設定名稱不算', C.hasUrl('mss.scheduling.enabled=false'), false);
check('disallowedTags：不帶屬性的 <span> 放行', C.disallowedTags('<pre>logging<span>.</span>file</pre>'), []);
check('disallowedTags：帶屬性的 <span> 照報', C.disallowedTags('<span style="color:red">x</span>').indexOf('<span>') !== -1, true);
check('unexplainedJargon：有中文括號說明的不報', C.unexplainedJargon(['送 PR（合併請求）', 'repo（程式碼倉庫）']), []);
check('unexplainedJargon：PRD／project 不誤判成 PR', C.unexplainedJargon(['PRD 系統', 'project']), []);
check('ownBodyLines：引用區不算', C.ownBodyLines('<div>a<br>b</div><div class="gmail_quote">c</div>'), ['a', 'b']);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 留著也無妨 */ }
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
