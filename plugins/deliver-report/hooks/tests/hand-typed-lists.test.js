// handTypedLists() 單元測試 —— 跑法：node hooks/tests/hand-typed-lists.test.js
//
// 判準：htmlBody 行首手打「1.」「2、」「(1)」「①」「・」「- 」，同類兩處以上才報。
// 2026-10-11 實案：回信草稿在 htmlBody 裡用 <br>1. <br>2. <br>3. 手打序號，
// 序號一律用 <ol><li>、列點一律用 <ul><li>。
// 與 disallowed-tags.test.js 同一套作法：Stop hook 自帶一份、core 一份，
// 檔尾拿同一批輸入餵兩份逐例比對，不一致就 exit 1。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'gmail-draft-link-gate.js'), 'utf8');
const start = src.indexOf('function handTypedLists(');
const end = src.indexOf('\n}', start) + 2;
const stopCopy = new Function(src.slice(start, end) + '; return handTypedLists;')();
const coreCopy = require(path.join(__dirname, '..', 'lib', 'draft-checks.core.js')).handTypedLists;

const CASES = [];
let ok = 0, bad = 0;
function t(html, expect, label) {
  CASES.push([html, label]);
  const r = stopCopy(html);
  const pass = (r.length > 0) === expect;
  pass ? ok++ : bad++;
  console.log('  ' + (pass ? 'PASS' : '** FAIL **').padEnd(12) + JSON.stringify(r).padEnd(44) + label);
}

console.log('=== 應命中 ===');
t('<div dir="ltr">Hi,<br><br>1. 匯入 SQL<br>2. 更新程式<br>3. 說明</div>', true, '2026-10-11 實案：<br>1. 2. 3.');
t('<div dir="ltr">說明：<br>・第一點<br>・第二點</div>', true, '全形列點 ・');
t('<div dir="ltr">說明：<br>- 第一點<br>- 第二點</div>', true, '減號列點');
t('<div dir="ltr">1、甲<br>2、乙</div>', true, '頓號序號，第一項緊接 <div>');
t('<div dir="ltr">(1) 甲<br>(2) 乙</div>', true, '括號序號');
t('<div dir="ltr">①甲<br>②乙</div>', true, '圈號序號');
t('<div dir="ltr"><br><b>1.</b> 甲<br><b>2.</b> 乙</div>', true, '序號包在 <b> 裡');
t('<div dir="ltr"><br>&nbsp;1. 甲<br>&nbsp;2. 乙</div>', true, '序號前有 &nbsp;');
t('<div dir="ltr"><ol><li>1. 甲</li><li>2. 乙</li></ol></div>', true, '<li> 裡又手打序號（雙重編號）');
t('<div dir="ltr">甲<br/>1. a<br/>2. b</div>', true, '<br/> 寫法');

console.log('=== 不應命中 ===');
t('<div dir="ltr"><ol><li>匯入 SQL</li><li>更新程式</li></ol></div>', false, '正確 <ol><li>');
t('<div dir="ltr"><ul><li>甲<br>補充行</li><li>乙</li></ul></div>', false, '正確 <ul><li> 含子行 <br>');
t('<div dir="ltr">只有一行<br>1. 依合約第一條</div>', false, '只有一處，不報');
t('<div dir="ltr">約 1.5 小時<br>2.0 版已上線</div>', false, '小數不算');
t('<div dir="ltr">指令：<pre>- a\n- b\n1. c\n2. d</pre></div>', false, '<pre> 內不算');
t('<div dir="ltr">回覆<br><!-- 1. x<br>2. y --></div>', false, 'HTML 註解內不算');
t('<div dir="ltr">好的<br><blockquote>1. 原信甲<br>2. 原信乙</blockquote></div>', false, 'blockquote 引用不算');
t('<div dir="ltr">好的</div><div class="gmail_quote">1. 原信甲<br>2. 原信乙</div>', false, 'gmail_quote 之後不算');
t('<div dir="ltr">※ 附註一<br>※ 附註二</div>', false, '※ 附註記號不算');
t('<div dir="ltr">2026-10-11 上線<br>10/8 來信</div>', false, '日期開頭不算');
t('', false, '空字串');
t(null, false, 'null');

console.log('=== 漂移比對（Stop 自帶副本 vs core）===');
let drift = 0;
for (const [html, label] of CASES) {
  const a = JSON.stringify(stopCopy(html));
  const b = JSON.stringify(coreCopy(html));
  if (a !== b) { drift++; console.log('  ** DRIFT ** ' + label + '  stop=' + a + '  core=' + b); }
}
console.log('  ' + (drift ? '** FAIL ** 漂移 ' + drift + ' 例' : 'PASS        兩份輸出一致（' + CASES.length + ' 例）'));

console.log('\n' + ok + ' passed, ' + bad + ' failed' + (drift ? ', ' + drift + ' drift' : ''));
process.exit(bad || drift ? 1 : 0);
