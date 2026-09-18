// disallowedTags() 單元測試 —— 跑法：node hooks/tests/disallowed-tags.test.js
//
// 79 例，其中 62 例來自 2026-09-16 八輪對抗審查實際抓到的缺陷，留著當回歸：
//   第一輪：純文字 class=／屬性值裡的 <p>／HTML 註解裡的 <p>／平行 div／
//           &lt;p&gt; 實體／<br/> 與 <BR>／<b-widget> 不可被截斷／onclick=／巢狀 div
//   第二輪：one=／once=／only= 被萬用式 /\son[a-z]+=/ 誤報成事件屬性
//   第三輪：改用窮舉 handler 清單後反而漏掉 onauxclick／onplay／onreset／onfocusin／
//           onbeforeunload 等真 handler；以及 <a href="x"onclick=…> 這種屬性相連
//           無空白的寫法讓 onclick／class=／style= 三者全部漏報
//   第四輪：黑名單字擺在真 handler 前面可遮蔽偵測（once="1" onclick=… 回 []），
//           且黑名單漏 15/15 個常見 on 開頭英文字會誤報 → 判準改為屬性白名單
//   第五輪：單一標籤掛 8 個雜屬性就把 <p>／onclick= 擠出提醒訊息（push
//           上限所有違規平等競爭）；且 name／id／scope／headers／aria-*／role 等
//           手寫草稿的合法屬性 24/24 全被誤報
//   第六輪（自攻）：分兩層後 14 個 on…= 仍把 <script> 擠掉；
//           標籤自成一層後，10 個雜排版標籤同層競爭下依舊擠掉 <script>
//   第八輪：「另有 N 項」對成對標籤重複計數（真實 18 項宣稱成 20）；
//           DANGER_TAGS 漏 textarea／select 等表單控制項；aria- 前綴無條件放行
// 效能段是防 ReDoS：舊正則版 "<"+16 萬空白+"!" 要跑 22.9 秒（超過 hook 的 15 秒
// timeout 而被中止＝靜默失效），改單趟字元掃描後同一輸入 0ms。
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..', 'gmail-draft-link-gate.js');
const src = fs.readFileSync(P, 'utf8');
const start = src.indexOf('function disallowedTags(');
const end = src.indexOf('\n}', start) + 2;
const disallowedTags = new Function(src.slice(start, end) + '; return disallowedTags;')();

// 同一個判準目前有兩份副本：Stop hook 自帶（上面抽的這份）與 lib/draft-checks.core.js
// （PostToolUse 用的）。上面全部案例只測 Stop 那份，core 漂移了不會有任何測試變紅
// ——2026-09-18 審查實際抓到這個盲區。檔尾的漂移比對段拿同一批輸入餵兩份，逐例比對輸出。
const coreDisallowedTags = require(path.join(__dirname, '..', 'lib', 'draft-checks.core.js')).disallowedTags;
const CASES = [];

let ok = 0, bad = 0;
function t(html, expect, label) {
  CASES.push([html, label]);
  const r = disallowedTags(html);
  const hit = r.length > 0;
  const pass = hit === expect;
  pass ? ok++ : bad++;
  console.log('  ' + (pass ? 'PASS' : '** FAIL **').padEnd(12) + JSON.stringify(r).padEnd(30) + label);
}

console.log('=== 合規寫法（應乾淨）===');
t('<div dir="ltr">Hi,<br><br>內容<br></div>', false, '外層 div + br');
t('<div dir="ltr">含<b>粗體</b>與<i>斜體</i><br></div>', false, 'b / i');
t('<div dir="ltr"><ul><li>一</li><li>二</li></ul></div>', false, 'ul / li');
t('<div dir="ltr"><ol><li>一</li></ol></div>', false, 'ol / li');
t('<div dir="ltr"><pre>location = /api.php { return 307 https://x.com$uri; }</pre></div>', false, 'pre');
t('<div dir="ltr"><table border="1"><tr><th>項目</th><th>值</th></tr><tr><td>a</td><td>b</td></tr></table></div>', false, 'table（例外 B，允許）');
t('<div dir="ltr">見 <a href="https://x.com">連結</a><br></div>', false, 'a');
t('<div dir="ltr">底線<u>強調</u><br></div>', false, 'u');
t('', false, '空字串');
t(null, false, 'null');

console.log('=== 違規寫法（應命中）===');
t('<div dir="ltr"><p>Hi,</p><p>內容</p></div>', true, '<p>（禁用）');
t('<div dir="ltr"><span style="color:red">紅字</span></div>', true, '<span>');
t('<p class="MsoNormal">Outlook 貼進來的</p>', true, 'Outlook class=');
t('<div dir="ltr"><div><div>三層 div</div></div></div>', true, '多層 div');
t('<div dir="ltr"><h2>標題</h2></div>', true, '<h2>');
t('<div dir="ltr"><img src="x.png"></div>', true, '<img>');
t('<div dir="ltr"><font size="3">字</font></div>', true, '<font>');

console.log('=== 對抗審查抓到的假陽性（應乾淨）===');
t('<div dir="ltr">請搜尋 class= 這段文字<br></div>', false, '純文字 class=');
t('<div dir="ltr">請搜尋 style= 這段文字<br></div>', false, '純文字 style=');
t('<div dir="ltr"><a title="<p>" href="#">說明</a></div>', false, '屬性值含 <p>');
t('<div dir="ltr"><!-- <p>備註</p> --><b>正文</b></div>', false, 'HTML 註解含 <p>');
t('<div dir="ltr"><a title=" class=x style=y" href="#">連結</a></div>', false, '屬性值含 class=/style=');
t('<div>甲</div><div>乙</div>', false, '完整平行 div（深度 1）');
t('<div dir="ltr">寫成 &lt;p&gt; 的文字<br></div>', false, '&lt;p&gt; 實體');
t('<div dir="ltr">a<br/>b<BR>c</div>', false, '<br/> 與 <BR>');

console.log('=== 對抗審查抓到的漏報（應命中）===');
t('<div dir="ltr"><b-widget>x</b-widget></div>', true, '<b-widget> 不可截斷成 b');
t('<div dir="ltr"><a href="#" onclick="alert(1)">x</a></div>', true, 'onclick= 事件屬性');
t('<div dir="ltr"><a href="#" onmouseover="x()">x</a></div>', true, 'onmouseover= 事件屬性');

// 屬性白名單（第四輪定案）：非標準屬性一律報，不再區分「是不是事件屬性」。
// one=／once=／only= 這些字本來就不該出現在 Gmail 草稿的標籤上，報出來是對的；
// 判準換掉之前它們是「不可誤報」的案例，換之後成了「應命中」——這幾行是判準
// 變更的見證，不是回歸失效（見 disallowedTags 上方 ATTR_OK 的三輪演進註解）。
t('<div dir="ltr"><a href="x" one=1>k</a></div>', true, 'one=1 非白名單屬性應命中');
t('<div dir="ltr"><a href="x" once="y">k</a></div>', true, 'once= 非白名單屬性應命中');
t('<div dir="ltr"><a href="x" onsite="y">k</a></div>', true, 'onsite= 非白名單屬性應命中');

// 合法屬性不可誤報（白名單內的那幾個）
t('<div dir="ltr"><a href="x" title="說明" target="_blank" rel="noopener">k</a></div>', false,
  'href/title/target/rel 皆合法');
t('<table cellspacing="0" cellpadding="8"><tr><td colspan="2" align="left">a</td></tr></table>', false,
  '表格屬性皆合法');
t('<div dir="ltr">x</div>', false, 'dir= 合法');

// 明確 handler 清單漏掉的真 handler（第三輪審查：窮舉清單漏 53 個，已改回萬用式＋黑名單）
t('<div dir="ltr"><a href="x" onauxclick="y">k</a></div>', true, 'onauxclick= 應命中');
t('<div dir="ltr"><a href="x" onplay="y">k</a></div>', true, 'onplay= 應命中');
t('<div dir="ltr"><a href="x" onreset="y">k</a></div>', true, 'onreset= 應命中');
t('<div dir="ltr"><a href="x" onfocusin="y">k</a></div>', true, 'onfocusin= 應命中');
t('<div dir="ltr"><a href="x" onbeforeunload="y">k</a></div>', true, 'onbeforeunload= 應命中');

// 屬性相連無空白的規避路徑（第三輪審查實測三者皆漏報，成因是 attrs 剝掉引號內容）
t('<div dir="ltr"><a href="x"onclick="alert(1)">k</a></div>', true, '無空白相連 onclick 仍應命中');
t('<div dir="ltr"><a href="x"class="y">k</a></div>', true, '無空白相連 class= 仍應命中');
t('<div dir="ltr"><a href="x"style="y">k</a></div>', true, '無空白相連 style= 仍應命中');
t('<div dir="ltr"><a class="y">k</a></div>', true, '第一個屬性就是 class= 應命中');

// 遮蔽路徑（第三輪審查 BLOCK）：舊版只取第一個 on…= 命中，黑名單字擺前面可藏住真
// 事件屬性。屬性白名單改法從根本消除這條路徑——每個屬性都獨立判斷，無「第一個」可言。
t('<div dir="ltr"><a href=x once="y" onclick="alert(1)">k</a></div>', true, 'once= 在前不可遮蔽 onclick');
t('<div dir="ltr"><a href=x only=1 once=2 onplay="y">k</a></div>', true, '兩個正常字不可遮蔽 onplay');
t('<div dir="ltr"><a href="x" title="t" onclick="alert(1)">k</a></div>', true,
  '合法屬性在前不可遮蔽 onclick');
t('<div dir="ltr"><div>巢狀</div></div>', true, '巢狀 div');

console.log('=== push 優先級：雜屬性不可擠掉重要違規（第五輪審查）===');
// 舊版所有違規平等競爭同一個 8 格上限，單一標籤掛 8 個雜屬性就把 <p>／onclick= 擠光。
const junk = (n) => Array.from({ length: n }, (_, k) => 'a' + (k + 1) + '=1').join(' ');
function firstIs(html, want, label) {
  const r = disallowedTags(html);
  const pass = r[0] === want;
  pass ? ok++ : bad++;
  console.log('  ' + (pass ? 'PASS' : '** FAIL **').padEnd(12) +
              JSON.stringify(r.slice(0, 3)).padEnd(30) + label);
}
firstIs('<p ' + junk(8) + '>x</p>', '<p>', '8 個雜屬性不可擠掉 <p>');
firstIs('<b ' + junk(12) + ' onclick="alert(1)">x</b>', 'onclick=', '12 個雜屬性不可擠掉 onclick=');
firstIs('<b ' + junk(12) + ' class="x">y</b>', 'class=', '12 個雜屬性不可擠掉 class=');
// 標籤自成最高層（第六輪自攻）：分兩層時，14 個 on…= 塞滿重要層仍會把 <script> 擠掉
firstIs('<b ' + Array.from({ length: 14 }, (_, k) => 'onx' + k + '=1').join(' ') +
        '><script>evil()</script>', '<script>', '14 個事件屬性不可擠掉 <script>');
// 危險標籤自成第零層（第六輪自攻續）：只分「標籤/屬性」兩種標籤層時，
// 10 個雜排版標籤（h1~h6/img/font/center/marquee）就能把 <script> 擠掉。
// <script>/<iframe>/<form> 會執行或會外連，和 <h1>/<font> 不是同一個嚴重度。
const noise = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'font', 'center', 'marquee']
  .map((t) => '<' + t + '>x</' + t + '>').join('');
firstIs('<div dir="ltr">' + noise + '<script>evil()</script></div>', '<script>',
        '10 個雜標籤不可擠掉 <script>');
firstIs('<div dir="ltr">' + noise + '<iframe src="x"></iframe></div>', '<iframe>',
        '10 個雜標籤不可擠掉 <iframe>');
// 表單控制項與 input／button 同層（第八輪審查：<select> 與 <input> 同次貼上卻不同待遇）
['textarea', 'select', 'option', 'map', 'area'].forEach((tg) => {
  firstIs('<div dir="ltr">' + noise + '<' + tg + '>x</' + tg + '></div>', '<' + tg + '>',
          '<' + tg + '> 應在危險層');
});

// 超出上限要明說，不可靜默截斷
const capped = disallowedTags('<p ' + junk(30) + '>x</p>');
if (capped.some((v) => /另有 \d+ 項未列出/.test(v))) {
  ok++; console.log('  PASS        截斷時有「另有 N 項未列出」提示');
} else {
  bad++; console.log('  ** FAIL **  截斷未提示：' + JSON.stringify(capped));
}

// 「另有 N 項」的 N 必須是真的（第八輪審查 Important）：關閉標籤也走 pushTag，
// 超限項又不在 seen() 裡，於是 <zz8> 與 </zz8> 各加一次，成對標籤的數字變兩倍。
// 這個數字是講給使用者聽的事實，不能虛增。
function droppedCount(html) {
  const r = disallowedTags(html);
  const hit = r.find((v) => /另有 \d+ 項未列出/.test(v));
  return { listed: r.filter((v) => !/另有/.test(v)).length,
           extra: hit ? parseInt(hit.replace(/\D/g, ''), 10) : 0 };
}
const paired = droppedCount('<div dir="ltr">' +
  ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta']
    .map((t) => '<' + t + '>x</' + t + '>').join('') +
  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'font']
    .map((t) => '<' + t + '>x</' + t + '>').join('') + '</div>');
if (paired.listed + paired.extra === 18) {
  ok++; console.log('  PASS        成對標籤的「另有 N 項」不虛增（18 = ' +
                    paired.listed + ' + ' + paired.extra + '）');
} else {
  bad++; console.log('  ** FAIL **  成對標籤數字虛增：列 ' + paired.listed +
                     ' + 另有 ' + paired.extra + '，真實應為 18');
}
// 成對與自閉合的 N 必須一致（差兩倍就是重複計數）
const pairN = droppedCount('<div dir="ltr">' +
  Array.from({ length: 12 }, (_, k) => '<zz' + k + '>x</zz' + k + '>').join('') + '</div>').extra;
const selfN = droppedCount('<div dir="ltr">' +
  Array.from({ length: 12 }, (_, k) => '<zz' + k + '/>').join('') + '</div>').extra;
if (pairN === selfN) {
  ok++; console.log('  PASS        成對與自閉合的「另有 N 項」一致（各 ' + pairN + '）');
} else {
  bad++; console.log('  ** FAIL **  成對 ' + pairN + ' ≠ 自閉合 ' + selfN + '（重複計數）');
}

console.log('=== aria-* 判準要與註解一致（第八輪審查）===');
// 舊版 aria- 前綴無條件 continue，連裸 aria- 與 aria-onclick 都放行。
['aria-label', 'aria-hidden', 'aria-describedby'].forEach((a) => {
  t('<div dir="ltr"><td ' + a + '="x">y</td></div>', false, a + ' 應放行');
});
['aria-onclick', 'aria-style', 'aria-class', 'aria-', 'aria-x1'].forEach((a) => {
  t('<div dir="ltr"><td ' + a + '="x">y</td></div>', true, a + ' 應命中');
});

console.log('=== ATTR_OK 擴充：手寫草稿的合法屬性不可誤報（第五輪審查）===');
// 誤報會訓練使用者忽略警告——與易讀性鐵則 14 同型的教訓。
[['name="anchor"', 'name= 錨點'], ['id="x"', 'id='], ['role="note"', 'role='],
 ['aria-label="說明"', 'aria-*'], ['scope="col"', 'scope= 表頭'],
 ['headers="h1"', 'headers='], ['nowrap', 'nowrap 無值屬性'],
 ['type="1"', 'type='], ['start="3"', 'start=']].forEach(([attr, label]) => {
  t('<div dir="ltr"><td ' + attr + '>x</td></div>', false, label + ' 應放行');
});
t('<div dir="ltr"><a href="x" data-id="1">k</a></div>', true, 'data-* 仍應命中');

console.log('=== 漂移偵測：Stop 自帶副本 vs lib/draft-checks.core.js ===');
// 兩份副本必須對同一輸入給出相同結果。任一邊改了判準卻沒同步，這段就會紅。
let drift = 0;
for (const [html, label] of CASES) {
  let a, b;
  try { a = JSON.stringify(disallowedTags(html)); } catch (e) { a = 'THREW:' + e.message; }
  try { b = JSON.stringify(coreDisallowedTags(html)); } catch (e) { b = 'THREW:' + e.message; }
  if (a !== b) {
    drift++; bad++;
    console.log('  ** DRIFT **  ' + label);
    console.log('      link-gate: ' + a);
    console.log('      core     : ' + b);
  }
}
if (drift === 0) {
  ok++;
  console.log('  PASS        ' + CASES.length + ' 例輸出完全一致，兩份副本未漂移');
}

console.log('=== 效能：ReDoS 檢查（前一輪審查抓到 [^>]* 是二次方元凶）===');
function bench(html, label) {
  const t0 = Date.now();
  disallowedTags(html);
  const ms = Date.now() - t0;
  console.log('  ' + (ms + 'ms').padEnd(10) + label + '  (長度 ' + html.length + ')');
  return ms;
}
bench('<div dir="ltr">' + 'Hi,<br><br>正常內容<br>'.repeat(2000) + '</div>', '典型長信');
bench('<div dir="ltr"><img src="data:image/png;base64,' + 'A'.repeat(500000) + '"></div>', '500KB base64 內嵌圖');
bench('<div dir="ltr"><pre>' + 'location = /x { return 307 https://x.com; }\n'.repeat(5000) + '</pre></div>', '長 pre 設定檔');
const worst = '</a'.repeat(50000);
const ms = bench(worst, '人為最壞：50000 個 </a 且無 >');
console.log('  → ' + ok + ' passed, ' + bad + ' failed');
if (ms > 3000) console.log('  ** 警告：最壞情況 ' + ms + 'ms，需加長度上限 **');

// 失敗要讓呼叫端看得到：只印 "N failed" 而 exit 0，接進 CI 或 hook 鏈會靜默通過
// （2026-09-16 對抗審查實測：`node … >/dev/null; echo $?` 得 0）。
if (bad > 0 || ms > 3000) process.exit(1);
