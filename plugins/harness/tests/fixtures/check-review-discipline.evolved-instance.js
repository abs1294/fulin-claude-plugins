// harness-wire: PreToolUse Agent|Task
// PreToolUse hook：派 code-reviewer / backend-architect 時，強制派工 prompt 帶上紀律標記。
// 背景：RULE-002 三層漏檢事故——驗收清單變成掃描天花板、設計文件被當合規依據。
// 此 hook 只能保證「派工 prompt 有帶紀律條款」；執行面由 agent 定義檔（每次 spawn 必載）與 skill 正文把關。
// 2026-09-10：改為一次列完所有未過的閘（原本單一 reason 變數＋每閘 !reason 短路，
// 一次只回報一項——qa-engineer 要連過 7 道閘，補一項撞一項，使用者實測被連擋 6 次）。
// 同輪補齊 04 模板六缺的回報鏈鐵則 1、2——照範本寫卻仍被擋，是加閘時沒同步範本造成的漂移。
// 例外類別（測試資料來源選 b 時可點名的類別）2026-10-01 改為執行時讀正本，本檔不另抄、不寫數量：
// 正本＝tests/e2e/tools/hardcode_check.py 的 REVIEW_CATEGORY_SPECS（--list-categories --json）。
// 讀不到時由呼叫端 fail-closed（選 b 一律擋），不退回任何內建清單——退回內建清單＝又多一份會漂移的副本。
// 2026-10-04：【範圍展開】改驗逐格作答、【驗收條件】擴到五支專案 agent（回歸＋紅隊案例見 cases/check-review-discipline.test.js）。
// 2026-10-04 同日：加「派工單內容品質」機械判準（judgeScopeQuality／judgeAcceptance，案例見 cases/dispatch-quality.test.js）——
//   原本只分有沒有作答，填 xx／見附件／空泛句都過。全是規則判定，不用模型判斷。
// 2026-10-04 同日：反向／終止分支逐種判定抽成 reverseKinds，QA 回報閘（guard-qa-report.js）直接取用，不再各自維護一份逐句迴圈。
// 2026-10-04 同日（strict）：使用者「把這些規則也套到派工閘、讓它變嚴」——回報閘那五條細規則（遮引號、遮括號、標題句只看冒號前、
//   列舉句、「但…要驗」例外）改由兩閘共用（kindsPass），派工閘那一趟另加 F1～F11 修正（理由與清單見 reverseKinds 註解）；
//   回報閘判定凍結不動（558 筆歷史回報新舊版 stdout 逐字比對差異 0）。deny 訊息對新擋的情況逐條說原因並附改法例。
// 2026-10-08（align）：加【對照表】閘（03 矩陣 B10，compareGate）——五支專案 agent 的任務目標是對齊類時，必須有【對照表】
//   寫兩邊來源、欄位／元素、順序、值／行為、差異結論；QA 回報閘同時要求回報貼回逐項對照表。新閘放在所有舊閘之後，
//   舊閘判定與訊息逐字不變（語料比對與分類見 cases/dispatch-quality.test.js 檔頭）。
// 2026-10-04 同日（unify）：回報閘跟進 F1～F11——reverseKinds 只跑一趟 kindsPass，told 與 applies 由同一份判定推出，兩閘不再分叉。
//   分叉時派工單明寫「**逾時（不適用）**」，派工閘認、回報閘仍判適用，逼 QA 回報不必測的分支（語料 17 份派工單、35 個分支）。
// 已知極限（極端情境，刻意不處理）：
//   · 「退件（含取消）不適用」：括號外已有分支名時括號裡的分支不算（規則④），要把取消寫到括號外。
//   · 全形英文字母（「Ｎ／Ａ」）不認成 N/A：結果仍是擋（沒有理由），只是訊息說成「沒寫觸發方式」。
//   · 程式識別字含分支字樣且同句有預期結果的否定詞（corpus#46「permission_revoke 不影響文件狀態：適用」）：取消／權限不足被判不適用（漏擋方向）。
//     要修得讓 snake_case 識別字不算分支名，會連帶影響大量 `doc_delete` 類寫法；兩條件同時成立才會發生，使用者 2026-10-05 裁定豁免。
//   · 否定詞表外的說法（corpus#16「e2e 不重做」）判成適用：只會多要求 QA 回報一條（補一句不適用＋理由即過），詞表本質上補不完，2026-10-05 裁定豁免。
//   · 理由與觸發方式只量「有沒有具體內容」，不判對不對：「七種皆不適用：這次改動非常單純沒什麼」這類長度夠、但站不住的理由會過；
//     要判理由成不成立得讀懂改動本身，那是模型判斷，本專案沒有 prompt 型 hook 的先例，需使用者同意才做。
//   · 錨點只驗「長得具體」，只有共用元件格（與狀態序列引用的測試檔）會對四個 repo 實查存在；正向路徑寫捏造的路由或欄位名
//     （`/foo/bar`、`FakeField`）會被當成錨點。
//   · 數字算錨點／證據：「測 3 筆確認正常」的「3 筆」會讓驗收條件過關。
//   · 共用元件寫「無」只對照工作區改動（四個 repo 根目錄的 git diff HEAD＋未追蹤），已 commit 未 push 的改動、worktree 裡的改動不在對照範圍。
//   · 標題只認行首：四格或驗收條件整段寫在一行的句中（「…。【驗收條件】build 過。【回報格式】…」）會被當成沒寫而擋，deny 訊息有教改法。
//   · 格內出現行首的【…】（「2. 反向：\n【注意】…」）會提早結束該段，該格被判空白。
//   · 【回報格式】裡若寫成行首清單項「- 【驗收條件】逐條回報」，會被當成驗收條件的作答段（現行模板沒有這種寫法）。
//   · 全形尖括號佔位（＜…＞）不當佔位剝除。
//   · 【對照表】觸發只看任務目標：對齊要求只寫在【背景】【驗收條件】【重點檢查】的派工單不觸發（全文掃描在語料多命中 65 份，幾乎全是一般用語）；
//     git-commit C 軌審查範本沒有【目標】，對齊類改動送審也不觸發。
//   · 【對照表】觸發只認「動詞＋基準側」的句型：「標題可不可以對齊？」（沒寫跟誰對齊）、「畫面的欄位都有在 Excel 裡？」這類問句不觸發。
//   · 【對照表】只驗五列有具體內容、來源兩側各有錨點，不驗列出的項目是否窮舉——窮舉與否要靠回報的逐項對照表（QA 回報閘）對帳。
const CATS_CMD = 'python tests/e2e/tools/hardcode_check.py --list-categories';
function loadExceptionCategories() {
  try {
    const path = require('path');
    const tool = path.resolve(__dirname, '..', '..', 'tests', 'e2e', 'tools', 'hardcode_check.py');
    const out = require('child_process').execFileSync('python', [tool, '--list-categories', '--json'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
    });
    const cats = (JSON.parse(out) || {}).categories;
    if (!Array.isArray(cats) || !cats.length || cats.some((c) => !c || !c.code)) throw new Error('categories 為空或缺 code');
    return { cats };
  } catch (e) {
    return { error: String((e && e.message) || e).split('\n')[0] };
  }
}
// 選 b 的類別宣告只認固定格式「例外類別：<代碼或別名>」（全形或半形冒號）：類別名取到第一個 ，,。.、；;空白、換行、（( 為止，
// 去頭尾空白與外層引號後須完全等於正本的某個代碼或別名（都不分大小寫）。回傳宣告的類別名；沒宣告或對不上回 null。
// 2026-10-17 改：舊版對作答段做代碼／別名的子字串比對，「這筆資料跟 BPM 無關，走 a 太慢所以直接 INSERT」也算點名 BPM——
// 關鍵詞分不出肯定與否定，加否定詞表只是把漏放換成誤擋（紅藍對抗三種否定句全放行；plugin 範本 0.18.0 實測漏放 15／32 後同樣改固定格式）。
// 別名含空白的（「BPM callback」）會被切到空白為止，剩下的「BPM」本身就是代碼，照樣對得上。
function declaredExceptionCategory(cats, text) {
  // 派工單是 Markdown：類別名外面包反引號、粗體星號、引號都算正當寫法（2026-10-18 紅藍對抗 R2：`BPM`／**BPM** 被誤擋）
  const norm = (s) => String(s).trim().replace(/^[「『"'“‘`*_]+/, '').replace(/[」』"'”’`*_]+$/, '').trim().toLowerCase();
  const wanted = new Set();
  for (const c of cats) {
    wanted.add(norm(c.code));
    (c.aliases || []).filter(Boolean).forEach((a) => wanted.add(norm(a)));
  }
  // 「例外類別」前面要是行首或標點／空白；冒號兩側只容許同一行內的空白（換行不算，免得吃到下一行的字）
  // 類別名在右括號、斜線（「BPM／KMS」列兩類時取第一個）也要停，否則括號會被吃進類別名而對不上（R2 誤擋 (例外類別: BPM)）；
  // 冒號後可以先來一個左括號（「例外類別：（BPM）」，R2 複驗誤擋）——括號裡是「不是」之類的字時 wanted 對不上，照樣不算宣告
  const re = /(^|[，,。.、；;\s（(「])例外類別[ \t　]*[:：][ \t　]*[（(]?[ \t　]*([^，,。.、；;\s（(）)／/]*)/g;
  const s = String(text);
  let m;
  while ((m = re.exec(s)) !== null) {
    // 固定格式外面再包一層否定仍會命中（複驗自造：「這筆不屬於例外類別：BPM」「並不是例外類別：KMS」「例外類別：BPM 以外的一般資料」），
    // 所以同一子句尾端帶否定詞、或類別名後面緊接排除詞的，都不算宣告。正當寫法是用標點把宣告隔成自己的子句。
    const clause = s.slice(0, m.index + m[1].length).split(/[，,。.；;\n]/).pop();
    if (/[不非沒無別][^，,。.；;\n]{0,6}$/.test(clause)) continue;
    const after = s.slice(m.index + m[0].length).replace(/^[ \t　]+/, '');
    // 排除詞可以直接接、也可以包在括號裡（「例外類別：BPM（不是）」）；「不適用」「並非」「並不」也是否定（R2 補）
    if (/^(?:[）)]?[ \t　]*)(?:[（(][ \t　]*)?(以外|之外|除外|不算|無關|不是|不屬|不含|不適用|並非|並不|非)/.test(after)) continue;
    if (m[2] && wanted.has(norm(m[2]))) return m[2].trim();
  }
  return null;
}

// ── 派工單格位解析（【範圍展開】／【驗收條件】共用，2026-10-04）────────────────────
// 作答範圍＝「行首」的【標題】那一行之後，到下一個行首【…】為止。行首可帶 Markdown 前綴（###、>、**、- 清單符號）。
// 句中提到的不算標題（「回報要對應【驗收條件】」）。模板六【回報格式】的「- **【範圍展開】逐格回報**」雖然也會被當成
// 一個候選段，但它底下沒有四格格名，judgeScope 判不過；多個候選段只要有一段判過就算有作答。
const ACC_AGENTS = ['backend-architect', 'backend-engineer', 'frontend-engineer', 'qa-engineer', 'code-reviewer'];
const HEAD_RE = /^[ \t#>*_]*(?:[-+][ \t]+[*_]*)?【([^】\n]+)】/;
function sectionsOf(prompt, name) {
  const lines = String(prompt).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD_RE.exec(lines[i]);
    if (!m || m[1].trim() !== name) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !HEAD_RE.test(lines[j]); j++) body.push(lines[j]);
    out.push({ head: lines[i].slice(m[0].length).replace(/^[*_]+/, ''), body });
    i = j - 1;
  }
  return out;
}
// 範本佔位（<…>，可巢狀）由內往外剝到沒有變化為止
function stripPlaceholders(s) {
  let out = String(s);
  for (;;) {
    const next = out.replace(/<[^<>]*>/g, ' ');
    if (next === out) return out;
    out = next;
  }
}
// 只剩標點、空白、符號時的「字」：拿來比對模板說明是否被原樣照抄（不受全形／半形斜線、粗體記號影響）
const flatText = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '');
// 不構成作答的空詞與填充詞（「無，理由：無」「不適用，同上」「TBD」）；比對對象是 flatText 之後的字串
const NULL_WORDS = /待補[充中上齊]?|待確認|待定|之後再?補|稍後補|再補|後補|同上|見上|見下|不適用|不涉及|不需要?|無需|沒有|略過?|空白|理由|原因|因為|說明|無|(?<![A-Za-z])(?:(?:TBD)+|TODO|NA|none|nil|null|OK)(?![A-Za-z])/gi;
// 清單編號與項目符號（「1.」「2)」「-」「①」）不是內容：「1. <條件一>\n2. <條件二>」剝完佔位只剩編號，不得算作答
const stripMarkers = (s) => String(s).replace(/(^|[\s，,；;：:])(?:[-*•+]|[\d０-９]+[.)、．）]|[①-⑩])(?=\s|$)/gm, '$1');
function hasRealText(s) {
  return flatText(stripMarkers(stripPlaceholders(s))).replace(NULL_WORDS, '').length >= 2;
}
// 標題後緊接的模板括號註記：「【驗收條件】（判準）」「（逐條判定）」——註記本身不是作答
const stripHeadNote = (h) => String(h).replace(/^\s*[（(][^）)\n]*[）)]/, '');
// 說明文字切成子句：整段＋各子句（≥4 字才拿來比對，太短的子句會誤刪作答內容），長的先比
const hintClauses = (s) => [flatText(s)].concat(String(s).split(/[；;，,。]|—+/).map(flatText))
  .filter((c) => c.length >= 4).sort((a, b) => b.length - a.length);
// 【範圍展開】格內只是複述格名的字（「沒有反向分支」「不適用此格」），拿掉後再數剩幾個字
const SCOPE_ECHO = /正向|路徑|反向|終止|分支|狀態序列|受影響的?|共用元件|這一格|本格|此格|這格|本次|這次/g;

// 【範圍展開】四格。name＝格名（與 04 模板六原文一致），re＝行首格名比對（剝掉編號與粗體後），hint＝本閘訊息的格說明
const SCOPE_CELLS = [
  { name: '正向路徑', re: /^正向(?:路徑|流程)?/, hint: '本次改動的 happy path，逐步',
    need: '至少 2 個具體錨點：頁面路由或 port、按鈕／欄位名、輸入值、API、DB 表欄、檔名',
    example: '開 localhost:5000 `/case/query` → 篩「簽核中」→ 點第一列「詳情」→ 讀回 `CaseStatus` 與畫面「狀態」欄一致' },
  { name: '反向／終止分支', re: /^(?:反向(?:\s*[／/、]\s*終止)?(?:分支)?|終止分支)/,
    hint: '退件/拒絕/取消/軟刪/逾時/重送/權限不足——逐條列適用哪些、怎麼觸發，不適用的說為什麼',
    need: '七種（退件／拒絕／取消／軟刪／逾時／重送／權限不足）每種都要點名；適用的寫怎麼觸發，不適用的可合併成一句並附理由',
    example: '權限不足：用沒有 `module.view` 的帳號開 `/case/query`，應導向 `/no-permission`；退件／拒絕／取消／軟刪／逾時／重送不適用：查詢頁沒有送審、刪除與排程入口' },
  { name: '狀態序列', re: /^狀態序列/, hint: '至少一條「做A→做B→撤銷A→存檔→重開」的多步操作，單步測不出的鎖死型缺陷只有這格抓得到',
    need: '至少 3 步（用 → 串起來或條列），且帶具體錨點（哪個欄位、填什麼值）',
    example: '上傳 `a.pdf` → 刪除 → 再上傳 `b.pdf` → 暫存 → 重開，附件清單只剩 `b.pdf`' },
  { name: '受影響的共用元件', re: /^(?:受影響的?)?共用元件/, hint: 'VeeUpload/VeeDataTable/VeeNumber/VeeDatePicker/MessageBox 等＋其他使用點是否連帶回歸',
    need: '點名真實存在於四個 repo 的檔名／元件名＋其他使用點；寫「無」要附理由，且四個 repo 工作區不能有沒交代的共用元件改動',
    example: '`VeeUpload`（其他使用點 `SignatureSection.vue`、`FileDrawer.vue` 連帶回歸上傳與刪除）' },
];
// 模板六【範圍展開】各格的說明原文，執行時讀 04（不在本檔抄一份——抄的副本會跟模板漂移）
function scopeTemplateHints() {
  try {
    const t = require('fs').readFileSync(require('path').resolve(__dirname, '..', 'harness', '04-delegation-templates.md'), 'utf8').split(/\r?\n/);
    const s6 = t.findIndex((l) => /^##\s*模板六/.test(l));
    if (s6 < 0) throw new Error('找不到「## 模板六」');
    const h = t.findIndex((l, k) => k > s6 && /^【範圍展開】/.test(l));
    if (h < 0) throw new Error('模板六裡找不到行首【範圍展開】');
    const hints = [null, null, null, null];
    const raws = [null, null, null, null];   // 說明原文（剝佔位後），內容品質判定前要從作答裡整段剝掉
    for (let k = h + 1; k < Math.min(t.length, h + 9); k++) {
      const m = /^\s*[1-4][.、．]\s*\*\*([^*]+)\*\*\s*[:：](.*)$/.exec(t[k]);
      if (!m) continue;
      const slot = SCOPE_CELLS.findIndex((c) => c.re.test(m[1].trim()));
      if (slot >= 0 && !hints[slot]) { hints[slot] = hintClauses(stripPlaceholders(m[2])); raws[slot] = stripPlaceholders(m[2]); }
    }
    if (hints.some((x) => !x)) throw new Error('四格格名對不上（' + SCOPE_CELLS.map((c) => c.name).join('／') + '）');
    return { hints, raws };
  } catch (e) {
    return { error: String((e && e.message) || e).split('\n')[0] };
  }
}
// 格名所在行剝掉行首前綴（Markdown、編號、粗體）後再比格名；QA 回報閘切反向格也用這兩個
const SCOPE_LEAD = (l) => String(l).replace(/^[\s>*_#-]*/, '').replace(/^(?:[1-4１-４](?:[.、．)）]|\s+)|[①②③④])\s*/, '').replace(/^[*_]+\s*/, '');
// 四格寫在同一行（「【範圍展開】正向：…；反向：…；狀態序列：…」）：在「；」後接格名處切開，當成多行處理
const SCOPE_SPLIT = /[；;](?=\s*(?:[1-4１-４](?:[.、．)）]|\s)|[①②③④])?\s*[*_]*(?:正向|反向|終止分支|狀態序列|受影響|共用元件))/;
// 逐格判定；回傳 { bad: [{ slot, why }] }
// opts：{ raws: 模板六四格說明原文, quality: false 時只判有沒有作答, changedShared: 測試注入的工作區改動清單函式 }
function judgeScope(sec, tplHints, opts) {
  const cells = [null, null, null, null];
  const lead = SCOPE_LEAD;
  const lines = [].concat(...[sec.head].concat(sec.body).map((l) => String(l).split(SCOPE_SPLIT)));
  let cur = -1;
  let labeled = 0;
  for (const l of lines) {
    const t = lead(l);
    const slot = SCOPE_CELLS.findIndex((c) => c.re.test(t));
    if (slot >= 0 && cells[slot] === null) {
      cells[slot] = [t.replace(SCOPE_CELLS[slot].re, '').replace(/^[*_]+/, '').replace(/^\s*[:：]/, '')];
      cur = slot;
      labeled++;
      continue;
    }
    if (cur >= 0) cells[cur].push(l);
  }
  if (!labeled) {
    // 沒寫格名、只寫 1.～4. 編號時，依編號歸格（只認頂層編號，縮排的子項歸前一格）
    for (const l of lines) {
      const m = /^[ \t]{0,1}(?:[1-4１-４])[.、．)）]\s*(.*)$/.exec(l);
      const n = m ? '1234１２３４'.indexOf(l.trim()[0]) % 4 : -1;
      if (m && cells[n] === null) { cells[n] = [m[1]]; cur = n; continue; }
      if (cur >= 0) cells[cur].push(l);
    }
  }
  const bad = [];
  for (let k = 0; k < 4; k++) {
    if (cells[k] === null) { bad.push({ slot: k, why: '整格沒寫' }); continue; }
    let flat = flatText(stripMarkers(stripPlaceholders(cells[k].join('\n'))));
    if (!flat) { bad.push({ slot: k, why: '空白或只留佔位' }); continue; }
    const clauses = [].concat(tplHints[k] || [], hintClauses(SCOPE_CELLS[k].hint)).sort((a, b) => b.length - a.length);
    for (const c of clauses) flat = flat.split(c).join('');
    if (!flat) { bad.push({ slot: k, why: '只照抄模板或本閘訊息的說明文字' }); continue; }
    if (flat.replace(NULL_WORDS, '').replace(SCOPE_ECHO, '').length < 2) bad.push({ slot: k, why: '只寫「無／不適用」或複述格名、沒附理由' });
  }
  // 有作答的格再判內容品質（見下方「派工單內容品質」節）；已判空白的格不重複報
  if (opts && opts.quality !== false) {
    const done = new Set(bad.map((b) => b.slot));
    for (const q of judgeScopeQuality(cells, opts)) if (!done.has(q.slot) || q.dup) bad.push(q);
  }
  return { bad };
}

// ── 派工單內容品質（2026-10-04）────────────────────────────────────────────────────
// 使用者：「派工單的內容品質，你要想辦法處理，不是靠審查的人判斷」。上面的作答閘只分「有沒有作答」，
// 每格填 xx／見附件／一句空泛句都過。以下全是機械判準（不用模型判斷）：
//   正向路徑＝至少 2 個具體錨點（且不能全是數字）；反向分支＝七種逐一交代（可一句合併寫不適用＋理由），適用者要寫觸發方式；
//   狀態序列＝至少 3 步且有錨點；共用元件＝點名的檔／元件要真的存在於四個 repo，寫「無」時對照四個 repo 工作區的共用元件改動；
//   四格之間不得實質重複；【驗收條件】逐條要有可對帳的證據（指令、數字、檔名、識別字、VERDICT 類判語、貼輸出）。
// 校準：本專案歷史派工單語料逐份讀過（分類與理由見 cases/dispatch-quality.test.js 檔頭）。
const PATH = require('path');
const FS = require('fs');
const WS_ROOT = PATH.resolve(__dirname, '..', '..');
const REPOS = ['Acme.Admin.Service', 'Acme.Supplier.Service', 'Acme.Admin.Frontend', 'acme-portal-web'];
const FILE_EXT = 'vue|cs|cshtml|csproj|sln|js|mjs|cjs|ts|tsx|jsx|py|sql|md|json|ya?ml|xml|ps1|sh|html|css|scss|xlsx|csv|docx|pdf|png|txt|log|diff|config';
const FILE_RE = new RegExp('[\\w.\\-/\\\\@\\u4e00-\\u9fff]*[\\w\\-\\u4e00-\\u9fff]\\.(?:' + FILE_EXT + ')(?![A-Za-z])(?:(?:[:：]|#L)\\d+(?:-\\d+)?)?', 'gi');
// 只有填充字（xx、foo、…）不算錨點也不算作答
const FILLER = /^(?:x+|y+|z+|o+|a+|abc|foo|bar|baz|qux|hoge|test|todo|tbd|na|none|null|nil|ok|etc|tmp|dummy|sample|example|something|stuff)$/i;
// 轉介詞：「見附件」「同前述」「照常」不是內容
const REFER_WORDS = /見附件|如附件|參見附件|詳見附件|參考附件|附件|詳見|參見|請見|見前述|如前所述|如上所述|如前述|同前述|前述|同前|如前|如上|如下|上述|這些|那些|此類|照舊|照常|同模板|照模板|依模板|比照|一般|正常|順利|完整|確認|功能|操作|測試|檢查|驗證|沒問題|無誤|看看|一下/g;
// 全大寫但不具體的縮寫（API、UI、DB…）不算錨點
const GENERIC_CAPS = new Set(['API', 'UI', 'UX', 'DB', 'QA', 'OK', 'TBD', 'TODO', 'NA', 'PASS', 'FAIL', 'TC', 'URL', 'ID', 'BUG', 'MCP', 'AI',
  'ABC', 'FOO', 'BAR', 'ETC', 'E2E', 'CRUD', 'HTTP', 'JSON', 'HTML', 'CSS', 'JS', 'SQL', 'NG', 'WIP', 'FYI', 'ASAP', 'N', 'A', 'B', 'C']);
function isIdent(m) {
  if (FILLER.test(m)) return false;
  if (/^[A-Z][A-Z0-9]+$/.test(m)) return !GENERIC_CAPS.has(m) && !/^(.)\1+$/.test(m);   // BPM／SAP／S03
  if (/[a-z][A-Z]|[A-Z]{2}[a-z]/.test(m)) return true;                                   // camelCase／PascalCase 多峰
  if (/[A-Za-z]{2,}[_.\-][A-Za-z0-9]/.test(m)) return true;                              // snake_case／module.view／qa-engineer／scroll-x
  return /[A-Za-z]/.test(m) && /\d/.test(m);                                             // TC01／S03／h1
}
// 反引號／引號裡包的若只是泛稱（`頁面`「某按鈕」`A`），不算錨點：拿掉泛稱後至少剩 2 個字
const GENERIC_NOUN = /頁面?|按鈕?|鈕|結果|畫面|資料|欄位?|系統|東西|項目|元件|某|該|此|這|那|相關|對應|目標|指定|特定|一些|任意|等等|值|內容|檔案?|名稱|文字/g;
// 引號裡是畫面上的字面（「查無」「確認」也是真的按鈕／文案），所以只排除填充字、整串空詞（「待補」「同上」）與純泛稱
const realish = (x) => { const f = flatText(x); return !FILLER.test(f) && f.replace(NULL_WORDS, '') !== '' && f.replace(REFER_WORDS, '') !== '' && f.replace(GENERIC_NOUN, '').length >= 2; };
// CONTEXT.md 的領域詞（「品改單」「稽催」…）也算具體錨點；執行時讀正本，讀不到就不用這一類
let CTX_TERMS = null;
function contextTerms() {
  if (CTX_TERMS) return CTX_TERMS;
  CTX_TERMS = [];
  try {
    for (const l of FS.readFileSync(PATH.join(WS_ROOT, 'CONTEXT.md'), 'utf8').split(/\r?\n/)) {
      const m = /^\*\*([^*]+)\*\*\s*$/.exec(l.trim());
      if (!m) continue;
      m[1].replace(/[（(][^）)]*[）)]/g, '').split(/[／/、]/).map((x) => x.trim())
        .filter((x) => x.length >= 2 && !/[A-Za-z]/.test(x)).forEach((x) => CTX_TERMS.push(x));
    }
  } catch (e) { /* 讀不到就少一類錨點，其餘照判 */ }
  return CTX_TERMS;
}
// 中文畫面元素名：「案件詳情頁」「送出按鈕」——前綴不能是泛稱（頁面、功能、該、某…）
const NULL_ONE = new RegExp(NULL_WORDS.source, 'i');
const UI_SUFFIX = /(?:詳情頁|查詢頁|列表頁|按鈕|鈕|欄位|欄|頁籤|分頁|抽屜|彈窗|對話框|下拉選單|下拉|選單|列表|表格|頁面|頁|橫幅|視窗|區塊|區|卡片|卡|圖示|連結|勾選框|核取方塊|輸入框|面板|編輯器|捲軸|列|tab|Tab|modal|Modal)/g;
const UI_VERB_HEAD = /^[點按開切進到在於用以把將對從回看讀填選去至往並再後先及與和或的被讓有是]+/;
const UI_GENERIC_HEAD = /^(?:該|此|這個?|那個?|某個?|各|每個?|任一|任意|其[他它餘]|相關|對應|目標|指定|特定|新|舊|主|首|上|下|同一?|一個|整個|所有|全部|[一兩二三四五六七八九十幾多數]+[個處種支份]?)/;
const UI_GENERIC = /(?:功能|頁面|畫面|系統|操作|測試|結果|資料|內容|東西|項目|元件|按鈕|欄位|一般|全部|所有|相關|某|本|下一|上一|每一|第一|整|單|多|一|地|分|行|系|排|序|並|陳|前|後)$/;
function uiAnchors(t, add) {
  let m;
  UI_SUFFIX.lastIndex = 0;
  while ((m = UI_SUFFIX.exec(t))) {
    // 前綴：緊貼（或隔空白）的 1～6 個中文字，取最後一個「的／與／和…」之後那段（「兩個頁面的狀態欄」→「狀態欄」）
    const pre = (/[一-鿿]{1,6}$/.exec(t.slice(Math.max(0, m.index - 8), m.index).replace(/\s+$/, '')) || [''])[0].split(/[的之與和及或]/).pop();
    const core = pre.replace(UI_VERB_HEAD, '').replace(UI_GENERIC_HEAD, '');
    if (core.length >= 2 && !UI_GENERIC.test(core) && !NULL_ONE.test(core)) add(core + m[0]);
  }
}
// 錨點：反引號識別字、引號裡的畫面字串、檔名／路徑／路由、識別字（camelCase／snake_case／module.view／BPM）、
// 兩位數以上或帶單位的數字、比較式（≥3、=0）、中文畫面元素名、CONTEXT.md 領域詞。回傳 [{ key, num }]（distinct）
function anchorsOf(raw) {
  let t = stripPlaceholders(String(raw));
  const out = new Map();
  const add = (k, num) => { const key = String(k).trim().toLowerCase(); if (key && !out.has(key)) out.set(key, { key, num: !!num }); };
  t = t.replace(/`([^`\n]+)`/g, (m, x) => { if (realish(x)) add('`' + x); return ' '; });
  // 設定值／欄位值指派：E2E_TARGET=devsite、Flgdefault="X"、Status=4（要在引號那條之前，否則 "X" 先被吃掉）
  t = t.replace(/[A-Za-z_][\w.]*\s*[=＝]\s*["'「]?[\w一-鿿.\-]+["'」]?/g, (m) => { add(m); return ' '; });
  t = t.replace(/[「『“"]([^」』”"\n]{1,40})[」』”"]/g, (m, x) => { if (realish(x)) add('「' + x); return ' '; });
  t = t.replace(FILE_RE, (m) => { if (!FILLER.test(m.split(/[\\/]/).pop().replace(/\.[^.]*$/, '').replace(/[:：#].*$/, ''))) add(m); return ' '; });   // XXX.vue、foo.py 不算
  t = t.replace(/(?:[A-Za-z]:)?[\\/]?[A-Za-z0-9_.\-{}]+(?:[\\/][A-Za-z0-9_.\-{}]+)+[\\/]?/g, (m) => { if (!/[A-Za-z]{3}/.test(m)) return m.replace(/[\\/]/g, ' '); add(m); return ' '; });
  t = t.replace(/(?:localhost)?:\d{4,5}\b|\blocalhost\b/gi, (m) => { add(m); return ' '; });
  // 英文字列舉：success／warning／danger（全形斜線；半形斜線已被路徑那條吃掉）
  t = t.replace(/[A-Za-z]{3,}(?:\s*[／、]\s*[A-Za-z]{3,})+/g, (m) => { add(m); return ' '; });
  // 英文前綴的畫面元素：「token 頁」「wangEditor 輸入區」「上傳 Modal」（要在識別字被吃掉之前抓）
  t.replace(/([A-Za-z][\w\-]{2,})\s*(頁|欄位?|按鈕|鈕|輸入區|輸入框|區|面板|tab|Tab|modal|Modal|dialog|drawer)(?![A-Za-z])/g, (m, a, b) => { if (!FILLER.test(a)) add(a + b); return m; });
  t = t.replace(/[A-Za-z_][A-Za-z0-9_]*(?:[.\-][A-Za-z0-9_]+)*/g, (m) => { if (!isIdent(m)) return m; add(m); return ' '; });
  t = t.replace(/[≤≥<>＜＞=＝]\s*[+-]?\d+/g, (m) => { add(m, true); return ' '; });
  t = t.replace(/(?<![\d.])(?:\d{2,}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:%|ms|秒|分鐘|筆|個|次|列|欄|頁|px|rem|天|小時|MB|KB|字元|字|碼|位|版|張|支|條|人|家|元|行|份))(?!\d)/g, (m) => { add(m, true); return ' '; });
  uiAnchors(t, add);
  // 按鈕名：「按儲存」「點送出」「點選匯出」（按照、點數這類不是按鈕；「使用點連帶回歸」的「點」是名詞，前面接中文字時只認後／再／並／先）
  t.replace(/(?:(?<![一-鿿])|(?<=[後再並先然]))[按點](?![照時數出連位子])(?:擊|選)?([一-鿿]{2,4})/g, (m, x) => {
    if (!/^(?:一下|進去|進入|開|這|該|此|那|上|下|任|某|按鈕|鈕|看|過|到|擊|選|頁面|畫面|確認一下)/.test(x)) add('按' + x);
    return m;
  });
  // 領域詞最多算 1 個錨點：「開品改單 → 確認稽催正常」只靠詞彙表湊數不算具體，還要另有頁面／欄位／值
  const term = contextTerms().find((w) => t.includes(w));
  if (term) add(term);
  return Array.from(out.values());
}
// 模板／本閘訊息的說明原文與範例：作答裡照抄的部分要剝掉才判品質（否則照貼模板就有箭頭、有分支名）
function looseRe(s) {
  const chars = Array.from(String(s).replace(/[\s*_]/g, '')).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return chars.length >= 4 ? new RegExp(chars.join('[\\s*_]*'), 'g') : null;
}
function stripTemplateText(text, slot, opts) {
  let t = String(text);
  const srcs = [SCOPE_CELLS[slot].hint, SCOPE_CELLS[slot].example].concat(opts && opts.raws && opts.raws[slot] ? [opts.raws[slot]] : []);
  const pieces = [];
  for (const s of srcs) {
    if (!s) continue;
    pieces.push(s);
    // 只剩七種分支名的子句不剝：「退件／拒絕／…／權限不足：不適用，理由…」是正當作答（整行照貼模板時由上一行的整段比對剝掉）
    String(s).split(/[；;，,。（）()]|—+/).forEach((c) => { const f = flatText(c); if (f.length >= 4 && f.replace(KINDS_ALL, '').length) pieces.push(c); });
  }
  pieces.sort((a, b) => flatText(b).length - flatText(a).length);
  for (const p of pieces) { const re = looseRe(p); if (re) t = t.replace(re, ' '); }
  return t;
}

// 反向／終止分支：模板列的七種，同義詞一併認。
// 退件與拒絕同一組：本平台簽核系統的 Rejected 在畫面就顯示「退件」（簽核狀態列舉只有 Pending/Approved/Rejected），
// 語料裡 27 份只缺一種的派工單幾乎都是「寫了退件、沒另寫拒絕」，逐份讀過全是品質好的單——分開要求只會擋好單。
// 英文同義詞要整字（前後不接英文字母）：`DocPermission`、`CancelToken` 這類識別字不算點名分支
// 「退回」後面幾個字內接原文／預設／原值是 fallback（「說明欄應退回後端原文」「切英文退回中文原文」），不是退件
const KINDS = [
  { name: '退件', re: /退件|退回(?![一-鿿A-Za-z]{0,4}(?:原文|預設|原值|原始))|駁回|拒絕|拒收|不核准|否決|(?<![A-Za-z])(?:reject(?:ed)?|deny|denied)(?![A-Za-z])/i },
  { name: '拒絕', re: /退件|退回(?![一-鿿A-Za-z]{0,4}(?:原文|預設|原值|原始))|駁回|拒絕|拒收|不核准|否決|(?<![A-Za-z])(?:reject(?:ed)?|deny|denied)(?![A-Za-z])/i },
  { name: '取消', re: /取消|撤銷|撤回|作廢|(?<![A-Za-z])(?:cancel(?:ed|led)?|revoke)(?![A-Za-z])/i },
  { name: '軟刪', re: /軟刪|刪除|下架|停用|IsDeleted|(?<![A-Za-z])(?:soft.?delete|delete|unpublish)(?![A-Za-z])/i },
  { name: '逾時', re: /逾時|超時|逾期|過期|到期|(?<![A-Za-z])(?:timeout|time.?out|expired?)(?![A-Za-z])/i },
  { name: '重送', re: /重送|重新送|重新提交|再送|重發|重試|重推|重新推送|再次送出|重複送出|連發|(?<![A-Za-z])(?:resubmit|retry)(?![A-Za-z])/i },
  { name: '權限不足', re: /權限不足|權限|無權|沒權|越權|(?<!\d)40[13](?!\d)|(?<![A-Za-z])(?:unauthori[sz]ed|forbidden|permission)(?![A-Za-z])|未登入/i },
];
const KINDS_ALL = new RegExp(KINDS.map((k) => k.re.source).join('|'), 'gi');
const NEG = /不適用|不涉及|不需要?|無需|不必|不存在|無此|沒有|不會|不測|不補|不驗|不做|不在|不屬|不重測|不觸發|(?<![策省忽概約])略過?|(?<![A-Za-z])N\/?A(?![A-Za-z])|無觸發|無入口|無對應|未觸及|未改|未動|不改|不動|不波及|不影響|無關|免測|排除|無(?=其[他餘它])|(?:^|[^一-鿿])無(?=[\s，,。；;：:（(）)—\-、*_]|$)/i;
const COLLECTIVE = /七[種條項類個]|其[餘他它](?:\s*[\d一二三四五六]\s*[種條項類個])?|以上|全部|皆|均|都|剩下|其餘分支|任何|所有|一律|等(?:業務|其他|相關)?(?:分支|情境|狀態)?/;
const COLLECTIVE_G = new RegExp(COLLECTIVE.source, 'g');
const TRIGGER = /用|以|按|點|送|呼叫|打|設|改|等|切|開|登入|模擬|觸發|讓|把|將|走|執行|跑|帶|傳|填|上傳|撤|輸入|選|超過|超出|停|斷|關|注入|造|呼|未|缺|帳號|身分|攔截|call|mock|role|grant|token|route/i;
// 子句的「理由」字數：拿掉分支名、否定詞、空詞、格名複述、轉介詞後剩幾個字
// 只拿掉空詞（不適用／無／沒有…），不拿掉理由裡的否定詞——「不適用：本次未改權限碼」的「未改」是理由的一部分
// 兩種量法取大：整句拿掉分支名後的字數；否定詞之後的字數（不拿分支名——「軟刪不適用（無刪除路徑）」的「刪除」是理由）
const reasonPart = (s) => flatText(stripMarkers(s)).replace(NULL_WORDS, '').replace(SCOPE_ECHO, '').replace(COLLECTIVE_G, '').replace(REFER_WORDS, '');
const reasonLen = (c) => {
  const whole = reasonPart(String(c).replace(KINDS_ALL, ' ')).length;
  const m = NEG.exec(c);
  return Math.max(whole, m ? reasonPart(String(c).slice(m.index + m[0].length)).length : 0);
};
// 整格一句不適用的開頭：「不適用——…」「**無**——…」「本輪不另行觸發反向分支，理由：…」（否定要在句首，句中順帶的「不存在」不算）
const CELL_NA_HEAD = /^[\s*_]*(?:本(?:任務|次|輪)\s*[*_]*)?(?:不適用|無(?![一-鿿])|N\/?A|不需要?|沒有|免測|略過?|不另行|不另外)/i;
// 觸發方式：有錨點，或有觸發動詞且拿掉動詞、空詞、泛稱後還有 3 個字以上的對象（「用帳號測一下」不算）
const TRIGGER_G = new RegExp(TRIGGER.source, 'gi');
// 「適用」的「用」不是觸發動詞（「**權限不足（適用）**：畫面應顯示錯誤」沒寫怎麼觸發）（F14）
const hasTrigger = (s) => { const rest = String(s).replace(KINDS_ALL, ' ').replace(/不?適用/g, ' '); return anchorsOf(rest).length > 0
  || (TRIGGER.test(rest) && flatText(rest).replace(TRIGGER_G, '').replace(/測試?|一下|看看|帳號/g, '').replace(NULL_WORDS, '').replace(REFER_WORDS, '').replace(GENERIC_NOUN, '').length >= 3); };
// 反向分支組：退件與拒絕同一組（理由見 KINDS 上方註解）。QA 回報閘的回報切段、以及 reverseKinds 判「列舉句」都數組數。
// 「權限不足」組不認裸的 401／403（與 KINDS 的權限不足差在這裡）：回報常在 B13 環境檢查寫「無 token 回 401（端點存在）」，
// 那不是在交代權限不足分支
const REVERSE_GROUPS = [
  { name: '退件／拒絕', kinds: ['退件', '拒絕'] },
  { name: '取消', kinds: ['取消'] }, { name: '軟刪', kinds: ['軟刪'] }, { name: '逾時', kinds: ['逾時'] },
  { name: '重送', kinds: ['重送'] }, { name: '權限不足', kinds: ['權限不足'] },
].map((g) => Object.assign(g, { re: KINDS.find((k) => k.name === g.kinds[0]).re }));
REVERSE_GROUPS[5].re = new RegExp(KINDS.find((k) => k.name === '權限不足').re.source.replace('(?<!\\d)40[13](?!\\d)|', ''), 'i');
// 「標題句」＝分支名出現在句首（「- 取消：…」「**權限不足**：…」）；理由句裡順帶提到分支名不算
const KIND_HEAD = new RegExp('^[\\s\\-*•+_#>|]*(?:[\\d①-⑩a-zA-Z]{1,3}[.、．)）]\\s*)?[*_]*[^：:，,。`]{0,6}?(?:' + KINDS_ALL.source + ')', 'i');
// 明確的不適用語（標題句的不適用判定用）：「不會／沒有」這類也常用來描述預期行為，不收；「沒有／無…入口／路徑／觸發點」是不適用的理由，收
const STRONG_NA = /不適用(?![的者就則要須請])|不涉及|免測|不測|不補|不驗|不做|不重測|不另(?:行|外)?(?:觸發|測|補)|(?<![策省忽概約])略過|(?<![A-Za-z])N\/?A(?![A-Za-z])|本輪不|無需|不需要?|不必|不觸發|不在(?:畫面|本輪|範圍|此)|排除|無關|(?:沒有|無|不存在)[^，,。；]{0,8}?(?:入口|路徑|觸發點?|按鈕|功能|概念|狀態|寫入|流程|機制|轉換|分支|排程|權限碼|刪除|送審|此)/i;
const STRONG_NA_HEAD = new RegExp('^[\\s*_]*(?:' + STRONG_NA.source + ')', 'i');
const hasKind = (s) => KINDS.some((k) => k.re.test(s));
// 分支名的「點名」只看正文：反引號（`test_multi_reject_cycle.py`）、引號裡的畫面字面（「尚未開放權限」）不算；
// 括號裡的內容只在括號外沒有分支名時才算（「不同色態的橫幅（紅＝退件）」算；「退件不適用（本次目標是留下權限）」的「權限」不算），
// 括號裡的假設／舉例（含若、如、或、例如、等）一律不算（「軟刪請走產品入口（內站若有刪除／作廢功能）」）
// 以下 F1～F11 的出處與清單見 reverseKinds 註解。
// 引號裡只有狀態標籤（「已取消」「已退回」「退件中」：已／被／待＋分支名，或分支名＋中／狀態／態）是在講該狀態本身，算點名；
// 其餘引號內容（「退回原文」「尚未開放權限」「取消（N/A）」、裸的「取消」按鈕名）照遮
const KIND_WORD_ONLY = new RegExp('^(?:' + KINDS_ALL.source + ')$', 'i');
const isStateLabel = (x) => String(x).split(/[／/、]/).every((p) => {
  const q = p.trim();
  if (!/^(?:已|被|待)|(?:中|狀態|態)$/.test(q)) return false;
  return KIND_WORD_ONLY.test(q.replace(/^(?:已|被|待)/, '').replace(/(?:中|狀態|態)$/, ''));
});
// ASCII 雙引號與全形直引號（"取消篩選"、＂取消＂）也遮（F9）
const maskQuoted = (s) => String(s).replace(/`[^`]*`/g, ' ').replace(/i18n\s*key[^）)\n]*/gi, ' ')
  .replace(/「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"\n]*)"|＂([^＂\n]*)＂/g, (m, a, b, c, d, e) => (isStateLabel(a || b || c || d || e || '') ? m : ' '));
// 理由字數（F10）：「不適用：退件、拒絕、取消」否定詞之後只剩分支名與標點，不算理由（reasonLen 第二種量法會把分支名算進去，
// 那是為了「軟刪不適用（無刪除路徑）」的「刪除」——拿掉分支名後還有別的字才把分支名算進理由）
// 回報端（guard-qa-report.js）量回報理由仍用 reasonLen
const kindReasonLen = (c) => {
  const m = NEG.exec(c);
  if (m && !flatText(String(c).slice(m.index + m[0].length).replace(KINDS_ALL, '')).replace(NULL_WORDS, '')) return reasonPart(String(c).replace(KINDS_ALL, ' ')).length;
  return reasonLen(c);
};
// 括號是作答者寫的適用與否標註（「**逾時（不適用）**」「**權限不足（適用）**」「權限不足（devsite 不測，…）」）時不遮；
// 其餘括號照原規則遮——括號裡順帶的否定（「（系統查無此組合）」「（不適用的說明原因）」）不能讓同句的分支變成不適用
const PAREN_STATUS = /^[（(][\s*_]*(?:不?適用(?![的者就則要須請])|N\/?A(?![A-Za-z]))|(?:^[（(]|[\s，,、])(?:不適用(?![的者就則要須請])|N\/?A(?![A-Za-z])|不涉及|免測|不測|不驗|不補|不做)/i;
const maskParen = (s) => {
  const t = String(s).replace(/（[^）]*(?:若|如|或|例如|等)[^）]*）|\([^)]*(?:若|如|或|例如|等)[^)]*\)/g, ' ');
  const outside = t.replace(/（[^）]*）|\([^)]*\)/g, (m) => (hasKind(m) || !PAREN_STATUS.test(m) ? ' ' : m));
  return hasKind(outside) ? outside : t;
};
// 冒號前只有「不適用」這類狀態字、沒有分支名（「- **不適用**：軟刪——…無刪除入口」「不適用：退件／逾時——…」）
const STATUS_NA_HEAD = /^[\s\-*•+#>|_]*(?:[\da-zA-Z①-⑩]{1,3}[.、．)）]\s*)?[*_]*\s*(?:不適用|不涉及|免測|不測|N\/?A(?![A-Za-z])|無需|不需要?)/i;
// 子項沿用的不適用小標題：一行只有「不適用的分支與理由：」（行首就是不適用字樣，冒號後沒有內容），底下縮排的子項都算不適用。
// 「（逐條確認覆蓋，不適用的說明為什麼）：」是指示語，不算
// 「其餘／其他／剩下／以上…」開頭的句子：講的是別的分支（F6）
const OTHERS_HEAD = /^[\s\-*•+#>_]*(?:其[餘他它]|剩下|剩餘|以上|另外)/;
const NA_LIST_HEAD = /^[\s\-*•+#>_]*(?:[\da-zA-Z①-⑩]{1,3}[.、．)）]\s*)?[*_]*(?:不適用|不涉及|免測|N\/?A(?![A-Za-z]))[^：:，,。]{0,10}[：:][\s*_]*$/i;
// 逗號切子句，但不切括號與引號裡的逗號
const splitTopComma = (s, seps) => {
  const out = []; let cur = '', depth = 0;
  for (const ch of String(s)) {
    if ('（(「『“'.includes(ch)) depth++;
    else if ('）)」』”'.includes(ch)) depth = Math.max(0, depth - 1);
    if (!depth && (seps || '，,').includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
};
// 子句裡有適用與否標註的括號時，再按頓號切（「軟刪（…）、權限不足（devsite 不測）」的「不測」只屬於權限不足）
const splitSubs = (s) => [].concat(...splitTopComma(s).map((x) => (/[（(][^）)]*[）)]/.test(x) && Array.from(x.matchAll(/（[^）]*）|\([^)]*\)/g)).some((m) => PAREN_STATUS.test(m[0])) ? splitTopComma(x, '、') : [x])));
// 句子切法（F12）：按「。；;」切，但不切引號、括號、反引號裡的——「應回「您沒有權限存取此評分任務。」」若在引號裡切開，
// 引號就遮不掉，「沒有權限存取此」會被當成不適用語。一行裡括號引號沒配對時退回直接切
const splitSentences = (l) => {
  const out = []; let cur = '', depth = 0, tick = false;
  for (const ch of String(l)) {
    if (ch === '`') tick = !tick;
    else if (!tick && '（(「『“'.includes(ch)) depth++;
    else if (!tick && '）)」』”'.includes(ch)) depth = Math.max(0, depth - 1);
    if (!depth && !tick && '。；;'.includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return depth || tick ? String(l).split(/[。；;]/) : out;
};
// 預期結果（F13）：箭頭或「應」之後是預期行為（「（退件／拒絕）→ 應**不觸發**任何 SAP 拋轉」），那裡的否定詞不算不適用；
// 箭頭之後寫的是不適用字樣本身（「→ 不適用」）照算
const OUTCOME = /→|->|⇒|=>|➜|➔|⟶|➡|應(?!用)/;
const OUTCOME_NA = /不適用(?![的者就則要須請])|不涉及|免測|(?<![A-Za-z])N\/?A(?![A-Za-z])/i;
const beforeOutcome = (s) => { const m = OUTCOME.exec(s); return m && !OUTCOME_NA.test(s.slice(m.index)) ? s.slice(0, m.index) : s; };
// 冒號前只有「適用」這類肯定狀態字、沒有分支名（「- **適用且必測**：`callback_step2` 帶 Status 非 Approved（退件／拒絕）→ …」）（F14）：
// 內容點名的都算適用，除非該子句自己寫了不適用字樣
const STATUS_APP_HEAD = /^[\s\-*•+#>|_]*(?:[\da-zA-Z①-⑩]{1,3}[.、．)）]\s*)?[*_]*\s*(?<!不)適用(?![的者就則要須請])/;
// 反向／終止分支格逐種判定（派工閘 judgeReverse 與 QA 回報閘 guard-qa-report.js 的 applicableGroups 共用同一份判定）。
// 入參是已剝掉模板說明的格內文字。回傳：
//   { kinds: { <KINDS 的 name>: { told, applies, miss, app } }, collective, collectiveWeak }
//   applies＝回報閘用：這條分支適用與否：'app' 適用／'na' 不適用／'weak' 寫了不適用但沒理由／null 沒點名
//   told＝派工閘「有沒有交代」：由同一次 kindsPass 的 applies 推出——
//     適用→寫了觸發方式 'ok'／沒寫 'notrig'；不適用→'na'／'weak'；沒點名→null
//     兩軸只跑一趟、同一份判定（2026-10-04 unify 起）：applies 是 'app' 時 told 必為 ok／notrig，'na'／'weak'／null 兩軸相同
//   miss＝分支名有出現、卻不算點名的原因（派工閘訊息用）：'quoted' 只在反引號／引號／i18n key 裡、'paren' 只在括號裡的假設或舉例、
//     'body' 只在別條分支標題句的內容裡、'enum' 列舉句
//   app＝判成適用的特殊原因（派工閘訊息用）：'exception' 「但…要驗」例外、'softneg' 只有「不會／沒有」這類描述、沒有明確不適用語
//   collective／collectiveWeak＝整格開頭或「其餘」一句合併寫不適用（有理由／沒理由），派工閘拿來補沒點名的分支
// 判定規則：
//   ① 分支名先遮掉反引號、引號、i18n key 再找（只出現在引號裡的不算點名）
//   ② 標題句「分支名：內容」（冒號前 ≤30 字且含分支名）：只認冒號前的分支；內容出現明確的不適用語（STRONG_NA）才算不適用。
//      內容裡順帶提到的分支名不算（「權限不足：後端無檢查，故不測後端拒絕」的「拒絕」）；
//      「不會／沒有」這類描述預期行為的否定詞不算不適用（「權限不足：用 A 帳號開頁，不會看到匯出鈕」是適用）。
//   ③ 其他句：以逗號子句為單位，分支名所在子句有否定詞才算不適用；只剩分支名的子句看下一個子句開頭是不是不適用語
//      （「取消，不適用」）。一個子句點名 5 組以上又沒否定詞是列舉（「七條中：只有權限不足有觸發點」），不算點名。
//   ④ 括號裡的假設／舉例（含若、如、或、例如、等）不算點名；其餘括號內容只在括號外沒有分支名時才算
//   ⑤ 不適用句裡的例外（「…不適用——但權限不足這條要驗一個點」）：例外點名的分支一律算適用（覆蓋先前的不適用）
//   另加 F1～F11 修正（語料逐份讀出來的既有誤判，多半是明寫不適用卻被判適用；strict 那輪只開給派工閘，
//   unify 那輪回報閘跟進，兩閘不再分叉——分叉時派工單寫「**逾時（不適用）**」，回報閘仍逼 QA 回報逾時）：
//     F1 引號裡只有狀態標籤（「已取消」）算點名（maskQuoted）
//     F2 括號是適用與否標註時不遮（「**逾時（不適用）**」「權限不足（devsite 不測）」，maskParen／PAREN_STATUS）；
//        含這種標註的子句再按頓號切，標註只屬於緊鄰的分支（splitSubs）
//     F3 冒號前只有狀態字（「- **不適用**：軟刪——…無刪除入口」）、分支名在後面：後面點名的都算不適用；
//        冒號前同時有分支名與否定詞（「**軟刪／取消（不適用）**：…分發建立後不可取消」）：只看冒號前，內容裡再提到不算；
//        整格開頭就是不適用句（「**無**——…無退件／取消等分支可測」）：該句點名的都算不適用；
//        一行只有「不適用的分支與理由：」：底下縮排子項點名的都算不適用
//     F4 表格列「| 權限不足 | ❌ 不適用 | 理由 |」當成標題句「權限不足：❌ 不適用，理由」
//     F5 例外句的「適用」前面不能是「不」（「但本輪未動權限碼，不適用」不是例外）
//     F6 標題句內容太短時併入下一句判，但下一句是「其餘不適用：…」就不併（「權限不足：測一下；其餘不適用：…」的權限不足是適用、沒寫觸發）
//     F7 例外句只在遮掉括號假設後比對（「（若有作廢、刪除功能也一併驗）」是規則④的括號假設，不是例外）
//     F8 例外分支的觸發方式只看例外那段之後（＋下一句）：整句前半「…不適用」的「用」不算觸發動詞
//     F9 ASCII 雙引號與全形直引號（"取消篩選"、＂取消＂）也遮（maskQuoted）
//     F10 否定詞之後只剩分支名與標點（「不適用：退件、拒絕、取消」）不算理由（kindReasonLen）
//     F11 下一句拿來當觸發方式時，只排除「其餘…」與明確不適用句（「用沒有 `x` 的帳號開頁」的「沒有」不是不適用）
//   2026-10-05 shared 那輪（兩閘同時生效；語料 corpus#65／#385／#122／#330）：
//     F12 句子不在引號／括號／反引號裡切（splitSentences）：「應回「您沒有權限存取此評分任務。」」切開後引號遮不掉，被當成不適用
//     F13 箭頭或「應」之後是預期行為，那裡的否定詞不算不適用（beforeOutcome）：「（退件／拒絕）→ 應**不觸發**任何 SAP 拋轉」
//     F14 冒號前只有「適用」這類肯定狀態字（「**適用且必測**：…」）：內容點名的都算適用（STATUS_APP_HEAD）；
//        「適用」的「用」不算觸發動詞（hasTrigger）
//     F15 同一行「不適用：退件——…；**軟刪**——…」分號後的句子沿用行首的不適用，自己寫了「適用」的不沿用
//     另：「退回」後幾個字內接原文／預設／原值是 fallback（「說明欄應退回後端原文」），不算退件（KINDS）
function reverseKinds(text) {
  const p = kindsPass(text);
  const kinds = {};
  for (const k of KINDS) {
    const a = p.applies[k.name] || null;
    kinds[k.name] = { told: a === 'app' ? (p.trig[k.name] ? 'ok' : 'notrig') : a, applies: a,
      miss: a ? null : p.miss[k.name] || null, app: a === 'app' ? p.appWhy[k.name] || null : null };
  }
  return { kinds, collective: p.collective, collectiveWeak: p.collectiveWeak };
}
function kindsPass(text) {
  const mq = maskQuoted;
  const mp = maskParen;
  const clauses = [], naList = [], lineOf = [];
  let listIndent = -1;
  String(text).split(/\r?\n/).forEach((l0, li) => {
    let l = l0;
    const cs = /^\s*\|(.*)\|\s*$/.exec(l) ? l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()) : null;
    if (cs && cs.length >= 2) l = cs[0] + '：' + cs.slice(1).join('，');
    const indent = /^[ \t]*/.exec(l0)[0].replace(/\t/g, '  ').length;
    if (listIndent >= 0 && l.trim() && indent <= listIndent) listIndent = -1;
    const under = listIndent >= 0;
    if (NA_LIST_HEAD.test(l) && !hasKind(mq(l))) listIndent = indent;
    splitSentences(l).map((s) => s.trim()).filter(Boolean).forEach((c) => { clauses.push(c); naList.push(under); lineOf.push(li); });
  });
  let collective = false, collectiveWeak = false, prevNegTold = false, prevNegApp = false;
  const applies = {}, trig = {}, miss = {}, appWhy = {};
  const notHead = (s) => s && !KIND_HEAD.test(s);
  const noteMiss = (k, why) => { if (!miss[k.name]) miss[k.name] = why; };
  // 整格一句不適用（「無——本任務不點按鈕、不送表單、不觸發狀態轉換」）：第一句就是否定且沒點名任何分支，
  // 視同七種合併成一句不適用，理由要有內容（與下一句合計 ≥4 字）；之後點名的分支都當不適用，只認例外句
  const rlen = kindReasonLen;
  // 下一句拿來當觸發方式的條件（F11）：只排除「其餘…」與明確不適用句——舊判法「下一句沒有否定詞」會把
  // 「用沒有 `x` 權限的帳號開頁」也排除
  const nxTrig = (nx) => nx && !OTHERS_HEAD.test(nx) && !STRONG_NA.test(nx) && hasTrigger(nx);
  if (clauses.length && CELL_NA_HEAD.test(clauses[0])) {
    if (rlen(clauses[0]) + (notHead(clauses[1]) ? rlen(clauses[1]) : 0) >= 4) collective = true; else collectiveWeak = true;
  }
  const cellNA = clauses.length > 0 && CELL_NA_HEAD.test(clauses[0]) && !hasKind(mq(clauses[0]));
  const enumSub = (s) => REVERSE_GROUPS.filter((g) => g.re.test(s)).length >= 5;
  const subNeg = (subs, i) => NEG.test(beforeOutcome(subs[i])) || (subs[i + 1] !== undefined && STRONG_NA_HEAD.test(subs[i + 1]) && !hasKind(subs[i + 1]));
  // F15：「不適用：**退件／逾時**——…；**軟刪**——`doc_delete` 本輪未動」——同一行分號後的句子沿用行首的「不適用：」，
  // 自己寫了「適用」的句子不沿用
  let naLine = -1;
  for (let ci = 0; ci < clauses.length; ci++) {
    const c = clauses[ci];
    // 「…：不適用。理由：唯讀查詢」「軟刪：適用。`Enable=0` 的列不該出現」——被句號切到下一句的理由／觸發方式，
    // 下一句不是另一條分支的標題句時算這句的
    const nx = notHead(clauses[ci + 1]) ? clauses[ci + 1] : '';
    const r0 = rlen(c);
    const rNext = r0 < 4 && nx ? rlen(nx) : 0;
    // 觸發方式：這句或下一句（下一句若本身是「其餘不適用：…」這類否定句，不拿來當觸發方式）
    const trigHere = hasTrigger(c) || nxTrig(nx);

    // 合併不適用（「其餘不適用：…」「拒絕／取消：同上」）：整句有否定詞＋合稱詞，派工閘拿來補沒點名的分支
    const hit = KINDS.filter((k) => k.re.test(c));
    const neg = NEG.test(c) || (/同上|同前/.test(c) && prevNegTold);
    if (hit.length && neg) prevNegTold = true;
    const rl = r0 + (neg ? rNext : 0);
    if (neg && COLLECTIVE.test(c)) { if (rl >= 4) collective = true; else collectiveWeak = true; }

    const cm = mq(c);
    const hitA = KINDS.filter((k) => k.re.test(cm));
    hit.filter((k) => !hitA.includes(k)).forEach((k) => noteMiss(k, 'quoted'));
    if (!hitA.length) continue;
    const carry = /同上|同前/.test(c) && prevNegApp;
    const rlA = r0 + rNext;
    const hm = /^([^：:—]{0,30})(?:[：:]|——?)([\s\S]*)$/.exec(cm);
    const decide = (k, isNeg, soft) => {
      if (isNeg) prevNegApp = true;
      else if (trigHere) trig[k.name] = true;
      if (applies[k.name] === 'app' || applies[k.name] === 'na') return;
      applies[k.name] = isNeg ? (rlA >= 2 ? 'na' : 'weak') : 'app';
      if (!isNeg && soft && !appWhy[k.name]) appWhy[k.name] = 'softneg';
    };
    for (const k of hitA) {
      const src = k.re.source;
      const ok = '(?<!不)適用(?![的者])';
      const ex = new RegExp('(?:但|唯一?例外|例外|除了?|不過)[^。；]{0,15}?(?:' + src + ')[^。；]{0,15}?(?:要驗|要測|需驗|須驗|要確認|請驗|必驗|驗一|' + ok + ')'
        + '|(?:但若|若有|如有)[^。；]{0,20}?(?:' + src + ')[^。；]{0,40}?驗', 'i');
      // F7：括號裡的假設（「（若有作廢、刪除功能也一併驗）」）不當例外；F8：觸發方式只看例外那段之後
      // （整句前半是「…不適用」，「適用」的「用」會被當成觸發動詞）
      const exSrc = maskParen(c);
      const em = ex.exec(exSrc);
      if (em) {
        if (applies[k.name] !== 'app') appWhy[k.name] = 'exception';
        applies[k.name] = 'app';
        if (hasTrigger(exSrc.slice(em.index)) || nxTrig(nx)) trig[k.name] = true;
      }
    }
    if (cellNA) { hitA.forEach((k) => decide(k, true)); continue; }
    // F3：不適用的上下文（整格開頭的不適用句、冒號前只有狀態字、不適用小標題底下的子項）
    const statusNA = hm && !hasKind(mp(hm[1])) && STATUS_NA_HEAD.test(hm[1]);
    if (statusNA) naLine = lineOf[ci];
    const inherit = !statusNA && naLine === lineOf[ci] && !/(?<!不)適用(?![的者就則要須請])/.test(cm);
    if ((ci === 0 && CELL_NA_HEAD.test(c)) || naList[ci] || statusNA || inherit) {
      hitA.forEach((k) => decide(k, true));
      continue;
    }
    // F14：冒號前只有肯定狀態字（「**適用且必測**：…（退件／拒絕）→ 應**不觸發**…」）
    if (hm && !hasKind(mp(hm[1])) && STATUS_APP_HEAD.test(hm[1]) && !NEG.test(hm[1])) {
      const subs = splitSubs(cm).map(mp);
      for (const k of hitA) {
        const own = subs.filter((s) => k.re.test(s));
        if (!own.length) { noteMiss(k, 'paren'); continue; }
        decide(k, own.every((s) => OUTCOME_NA.test(s)));
      }
      continue;
    }
    // F3：冒號前有分支名也有否定詞（「**逾時（不適用）**：…」「退件不適用：…」）：冒號前逐子句判，內容裡再提到的分支不算
    if (hm && hasKind(mp(hm[1])) && NEG.test(hm[1])) {
      const hs = splitSubs(hm[1]).map(mp);
      const bodyNeg = carry || STRONG_NA.test(hm[2]);
      for (const k of hitA) {
        const own = hs.map((s, i) => i).filter((i) => k.re.test(hs[i]));
        if (!own.length) { noteMiss(k, k.re.test(hm[1]) ? 'paren' : 'body'); continue; }
        const isNeg = bodyNeg || own.every((i) => subNeg(hs, i));
        decide(k, isNeg, NEG.test(hm[2]));
      }
      continue;
    }
    if (hm && hasKind(mp(hm[1])) && !NEG.test(hm[1])) {
      // F6：內容太短時併入的下一句若是「其餘不適用：…」，講的是別的分支，不併
      const nxB = OTHERS_HEAD.test(nx) ? '' : nx;
      const body = hm[2] + (nxB && !STRONG_NA.test(hm[2]) && flatText(hm[2]).length < 4 ? '\n' + nxB : '');
      const isNeg = carry || STRONG_NA.test(beforeOutcome(body));
      const head = mp(hm[1]);
      for (const k of hitA) {
        if (k.re.test(head)) decide(k, isNeg, NEG.test(body));
        else noteMiss(k, k.re.test(hm[1]) ? 'paren' : 'body');
      }
      continue;
    }
    const subs = splitSubs(cm).map(mp);
    for (const k of hitA) {
      const own = subs.map((s, i) => i).filter((i) => k.re.test(subs[i]));
      if (!own.length) { noteMiss(k, 'paren'); continue; }
      if (!carry && own.every((i) => enumSub(subs[i]) && !subNeg(subs, i))) { noteMiss(k, 'enum'); continue; }
      decide(k, carry || own.every((i) => subNeg(subs, i) || enumSub(subs[i])), NEG.test(c));
    }
  }
  return { applies, trig, miss, appWhy, collective, collectiveWeak };
}
// 派工閘訊息：分支名有出現卻不算交代、或被判成適用的原因，各附一行改法（讓主模型一次補齊）
const MISS_WHY = {
  quoted: { say: '只出現在反引號／引號／i18n key 裡（那是識別字或畫面字面），不算交代',
    fix: '分支名寫在引號外：「取消：按「取消」鈕後重開，`InviteLink/add` 不得送出」' },
  paren: { say: '只出現在括號裡（括號裡的假設／舉例，或句中已有別的分支名時括號裡的補充），不算交代',
    fix: '移出括號單獨寫一句：「軟刪：內站作廢該筆後重開外站，列表不得再出現」或「軟刪不適用：本頁沒有刪除入口」' },
  body: { say: '只出現在別條分支「X：…」的內容裡（標題句只認冒號前的分支名），不算交代',
    fix: '另起一句以分支名開頭：「取消：…」或併進不適用句「取消／軟刪不適用：…」' },
  enum: { say: '所在的句子一口氣點名 5 組以上分支、又沒寫不適用，是列舉，不算交代',
    fix: '逐條分開寫：適用的「退件：用 X 帳號在 Y 頁按退件…」，不適用的「取消／軟刪不適用：理由」' },
};
const APP_WHY = {
  exception: { say: '句中寫了「但／除了／例外…要驗」，表示這條適用，要寫觸發方式',
    fix: '「權限不足：用沒有 `module.view` 的帳號開 `/case/query`，應導向 `/no-permission`」' },
  softneg: { say: '那句只有「不會／沒有」這類描述預期結果的否定、沒有明確不適用語（不適用／不涉及／無…入口），視為適用，要寫觸發方式',
    fix: '真的不適用就寫「取消不適用：本頁沒有取消入口」；適用就寫「取消：按「取消」鈕後重開，草稿不得送出」' },
};
// 派工閘：七種逐一交代（沒點名、不適用沒理由、適用沒寫觸發方式各列一句）；判定來源＝reverseKinds 的 told
function judgeReverse(text) {
  const { kinds, collective, collectiveWeak } = reverseKinds(text);
  const of = (s) => KINDS.filter((k) => kinds[k.name].told === s).map((k) => k.name);
  const missing = collective ? [] : of(null);
  const weak = of('weak');
  const notrig = of('notrig');
  // 同一原因的分支併成一行
  const detail = (names, field, table) => {
    const by = new Map();
    for (const n of names) { const w = kinds[n][field]; if (w && table[w]) { if (!by.has(w)) by.set(w, []); by.get(w).push(n); } }
    return Array.from(by, ([w, ns]) => '\n       ‣ 「' + ns.join('」「') + '」' + table[w].say + '。改法例：' + table[w].fix).join('');
  };
  const why = [];
  if (missing.length) why.push('七種反向分支沒交代到：' + missing.join('、') + (collectiveWeak ? '（寫了「其餘不適用」但沒附理由）' : ''));
  if (weak.length) why.push('寫了不適用但沒附理由：' + weak.join('、'));
  if (notrig.length) why.push('列為適用但沒寫怎麼觸發（用哪個帳號／按哪顆鈕／打哪支 API／造什麼值）：' + notrig.join('、'));
  // 原因說明集中附在最後一項後面（呼叫端用「；」串各項，夾在中間會跟下一項黏在一起）
  const more = detail(missing, 'miss', MISS_WHY) + detail(notrig, 'app', APP_WHY);
  if (more) why[why.length - 1] += more;
  return why;
}
// 狀態序列步數：同一行箭頭串的段數、條列子項數、「先／再／接著／最後」序詞，取最大
function seqSteps(text) {
  let best = 0;
  const lines = String(text).split(/\r?\n/);
  for (const l of lines) {
    const segs = l.split(/→|->|⇒|=>|➜|➔|⟶|➡/).map((s) => flatText(stripMarkers(s))).filter((s) => s.length >= 1);
    if (segs.length >= 2) best = Math.max(best, segs.length);
  }
  const items = lines.filter((l) => /^\s*(?:[-*•+]|\d+[.)、．）]|[①-⑩]|[(（]\d+[)）])\s*\S/.test(l)).length;
  const ord = (String(text).match(/先|再|然後|接著|之後|最後|隨後|其後|初值|一開始|起初|最初|第[一二三四五1-5]次/g) || []).length;
  // 「20 次連續開關」：明寫重複次數（≥3）就是多步
  const rep = Math.max(0, ...Array.from(String(text).matchAll(/(\d{1,3})\s*次(?:連續|反覆|來回)?/g), (m) => +m[1]).filter((n) => n <= 100));
  return Math.max(best, items, ord ? ord + 1 : 0, rep >= 3 ? rep : 0);
}
// 序列裡「具體」的步數：拿掉泛用動作（開頁、點按鈕、存檔、重開、確認…）後還剩 2 個字以上的步
const GENERIC_STEP = /開啟?|頁面?|畫面|按鈕?|點擊?|存檔|儲存|重開|重新整理|重整|送出|確認|操作|做|撤銷|再|然後|檢查|看|結果|正常|成功|失敗|資料|內容|欄位|值|填寫?|輸入|改|修改|動作|步驟|完成|一次|進入|回到|返回|[A-Za-z]/g;
function specificSteps(text) {
  const segs = [];
  String(text).split(/\r?\n/).forEach((l) => l.split(/→|->|⇒|=>|➜|➔|⟶|➡/).forEach((s) => segs.push(s)));
  return segs.filter((s) => flatText(stripMarkers(s)).replace(GENERIC_STEP, '').replace(NULL_WORDS, '').length >= 2).length;
}

// 四個 repo 的檔名索引：直接走目錄（實測 git ls-files 跑 26 份 checkout 要 2.6 秒，走目錄熱快取約 0.3 秒）。
// 範圍＝四個 repo 的 src/、wt/ 底下各 worktree 的 src/（QA 常驗 feature 分支，新檔只在 worktree 裡）、workspace 的 tests/
// （派工單常點名 e2e 測試檔）；排除 node_modules／bin／obj／dist 等產物目錄。一次執行只建一次。
const EXCL_DIRS = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', 'logs', '_reports', 'reports', '__pycache__', '.pytest_cache',
  'coverage', '.vite', 'TestResults', 'playwright-report', 'test-results']);
let REPO_INDEX = null;
function repoIndex() {
  if (REPO_INDEX) return REPO_INDEX;
  const names = new Set(), paths = [];
  const roots = REPOS.map((r) => PATH.join(WS_ROOT, r, 'src'));
  try {
    for (const d of FS.readdirSync(PATH.join(WS_ROOT, 'wt'), { withFileTypes: true })) if (d.isDirectory()) roots.push(PATH.join(WS_ROOT, 'wt', d.name, 'src'));
  } catch (e) { /* 沒有 wt/ 就只看四個 repo */ }
  roots.push(PATH.join(WS_ROOT, 'tests'));
  const walk = (dir, rel) => {
    let es;
    try { es = FS.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      const low = e.name.toLowerCase();
      if (e.isDirectory()) {
        if (EXCL_DIRS.has(e.name)) continue;
        names.add(low);
        walk(PATH.join(dir, e.name), rel + low + '/');
      } else {
        names.add(low);
        names.add(low.replace(/\.[^.]+$/, ''));
        paths.push(rel + low);
      }
    }
  };
  for (const r of roots) walk(r, PATH.basename(r).toLowerCase() + '/');
  for (const r of REPOS) {   // repo 根目錄那一層的檔（package.json、vite.config.js…）
    try { for (const e of FS.readdirSync(PATH.join(WS_ROOT, r), { withFileTypes: true })) if (e.isFile()) { names.add(e.name.toLowerCase()); paths.push(r.toLowerCase() + '/' + e.name.toLowerCase()); } } catch (e) { /* 略 */ }
  }
  if (paths.length < 100) throw new Error('四個 repo 檔名索引異常（只找到 ' + paths.length + ' 個檔）');
  REPO_INDEX = { names, paths };
  return REPO_INDEX;
}
// 檔名／元件名是否存在：比檔名（含去副檔名）、目錄名、路徑尾段；元件名（VeeUpload）對到 VeeUpload.vue 即算
function nameExists(tok) {
  const t = String(tok).replace(/^[`「]|[`」]$/g, '').replace(/(?:[:：]|#L)\d+(?:-\d+)?$/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const low = t.toLowerCase();
  const idx = repoIndex();
  if (t.includes('/')) {
    const tail = low.replace(/^(?:[a-z]:)?\/*/, '');
    if (idx.paths.some((p) => p.endsWith('/' + tail) || p.includes('/' + tail + '/'))) return true;
    try { if (FS.existsSync(PATH.resolve(WS_ROOT, t))) return true; } catch (e) { /* 當不存在 */ }
  }
  const base = low.split('/').pop();
  if (idx.names.has(base) || idx.names.has(base.replace(/\.[^.]+$/, ''))) return true;
  // 檔名對不到：再找四個 repo 的內文（函式庫元件 NDataTable、composable useDialog、檔名不同的 class）。只有對不到的名字才走這步
  const word = t.split('/').pop();
  if (!/^[A-Za-z_][\w.]{2,}$/.test(word)) return false;
  for (const r of REPOS) {
    const g = require('child_process').spawnSync('git', ['-C', PATH.join(WS_ROOT, r), 'grep', '-q', '-I', '-F', '-e', word], { timeout: 5000, windowsHide: true });
    if (g.status === 0) return true;
  }
  return false;
}
// 受影響的共用元件格裡「點名的元件」——只驗長得像檔案或元件的名字（變數名、API 路由、欄位名不驗）：
//   帶副檔名的檔名、以 / 結尾的目錄路徑、Vee／El／Section／use 開頭或以元件類字尾結尾的 PascalCase／camelCase 名
const COMP_NAME = /^(?:Vee|El|Section|use)[A-Z]\w*$|^[A-Z][A-Za-z0-9]*(?:View|Modal|Panel|Table|Upload|Uploader|Picker|Dialog|Drawer|Form|Select|Input|Button|Btn|Tag|Banner|Editor|Filter|Box|Card|Tabs?|Menu|Header|Footer|Layout|Template|List|Item|Component|Grid|Tree|Chart|Toolbar|Field|Badge|Tooltip|Popover|Stepper|Timeline)$/;
function componentCandidates(text) {
  const t = stripPlaceholders(String(text));
  const out = new Set();
  t.replace(FILE_RE, (m) => { out.add(m); return ' '; })
    .replace(/(?:[A-Za-z]:)?[\\/]?[A-Za-z0-9_.\-]+(?:[\\/][A-Za-z0-9_.\-]+)+[\\/]/g, (m) => { if (/(?:^|[\\/])(?:src|components|composables|views|utils|tests|e2e|vee-items)[\\/]/i.test(m)) out.add(m); return ' '; })
    .replace(/(?:[A-Za-z]:)?[\\/]?[A-Za-z0-9_.\-]+(?:[\\/][A-Za-z0-9_.\-]+)+/g, ' ')
    .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m) => { if (COMP_NAME.test(m)) out.add(m); return ' '; });
  return Array.from(out);
}
// 格內有沒有提到任何識別字／檔名（用來分辨「點名了東西」與「寫無」）
const mentionsSomething = (text) => anchorsOf(text).some((a) => !a.num && !/^「/.test(a.key));
// 四個 repo 工作區改到的共用元件目錄檔（git diff HEAD＋未追蹤）；排除 local-overrides.yml 登記的本機 hack 檔
// 測試用：環境變數 CRD_CHANGED_FILES（JSON 陣列，元素為「repo/相對路徑」）取代 git 實查
const SHARED_DIRS = /^(?:Acme\.Admin\.Frontend|acme-portal-web)\/src\/(?:components|composables|utils)\/|^Acme\.Supplier\.Service\/src\/Acme\.Shared\.Infrastructure\//;
function changedSharedFiles() {
  let files = [];
  if (process.env.CRD_CHANGED_FILES) files = JSON.parse(process.env.CRD_CHANGED_FILES);
  else {
    const cp = require('child_process');
    for (const r of REPOS) {
      for (const args of [['diff', '--name-only', 'HEAD'], ['ls-files', '-o', '--exclude-standard']]) {
        const res = cp.spawnSync('git', ['-C', PATH.join(WS_ROOT, r)].concat(args), { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (res.status !== 0) throw new Error('git ' + args[0] + ' 失敗：' + r);
        String(res.stdout).split(/\r?\n/).filter(Boolean).forEach((f) => files.push(r + '/' + f));
      }
    }
  }
  const hacks = new Set();
  try {
    let repo = '';
    for (const l of FS.readFileSync(PATH.join(WS_ROOT, '.claude', 'local-overrides.yml'), 'utf8').split(/\r?\n/)) {
      const r = /^\s*repo:\s*(\S+)/.exec(l); if (r) repo = r[1];
      const p = /^\s*-\s*path:\s*(\S+)/.exec(l); if (p && repo) hacks.add(repo + '/' + p[1]);
    }
  } catch (e) { /* 讀不到清單就不排除 */ }
  return files.filter((f) => SHARED_DIRS.test(f) && !hacks.has(f));
}
function bigramJaccard(a, b) {
  const g = (s) => { const x = new Set(); for (let i = 0; i < s.length - 1; i++) x.add(s.slice(i, i + 2)); return x; };
  const A = g(a), B = g(b);
  let n = 0; A.forEach((x) => { if (B.has(x)) n++; });
  return n / Math.max(1, A.size + B.size - n);
}
function judgeScopeQuality(cells, opts) {
  const bad = [];
  const texts = cells.map((c, k) => (c ? stripTemplateText(c.join('\n'), k, opts) : ''));
  // 1 正向路徑：至少 2 個錨點，且不能全是數字
  if (cells[0]) {
    const a = anchorsOf(texts[0]);
    if (a.length < 2 || !a.some((x) => !x.num)) {
      bad.push({ slot: 0, why: '具體錨點不足（找到 ' + a.length + ' 個' + (a.length ? '：' + a.slice(0, 3).map((x) => x.key).join('、') : '') + '，至少要 2 個、且不能全是數字）' });
    }
  }
  // 2 反向／終止分支：七種逐一交代
  if (cells[1]) {
    const w = judgeReverse(texts[1]);
    if (w.length) bad.push({ slot: 1, why: w.join('；') });
  }
  // 3 狀態序列：至少 3 步，且步驟要具體（有錨點，或至少 2 步不是「開頁／點按鈕／存檔」這類泛用動作）。
  // 例外兩種：①不適用＋實質理由（模板「任一格填無必附理由」；理由拿掉空詞後 ≥6 字，「同上」不算）；
  // ②引用既有測試檔的序列案例（「`test_x.py` 的序列案例用新資料重跑」）——檔案要真的存在（tests/ 與四個 repo 索引）
  if (cells[2]) {
    const t2 = texts[2];
    const n = seqSteps(t2);
    const a = anchorsOf(t2);
    const first = t2.split(/\r?\n|[。；;]/).map((s) => s.trim()).filter(Boolean)[0] || '';
    const na = (CELL_NA_HEAD.test(first) || NEG.test(first)) && reasonPart(t2.replace(/同上|同前/g, '')).length >= 6;
    const testRefs = (t2.match(FILE_RE) || []).filter((f) => /(?:^|[\\/])test_|\.(?:spec|test)\.[jt]s/i.test(f));
    const refOk = testRefs.length && testRefs.every((f) => nameExists(f)) && /重跑|照跑|沿用|既有|原本|本身/.test(t2);
    const w = [];
    if (n >= 3) {
      if (!a.length && specificSteps(t2) < 2) w.push('步驟都是泛用動作、沒有具體錨點（哪一頁、哪個欄位、填什麼值）');
    } else if (!na && !refOk) {
      w.push('只數到 ' + n + ' 步（至少 3 步：用 → 串起來或條列；不適用要附實質理由）'
        + (testRefs.length && !testRefs.every((f) => nameExists(f)) ? '；引用的測試檔查無：' + testRefs.filter((f) => !nameExists(f)).join('、') : ''));
    }
    if (w.length) bad.push({ slot: 2, why: w.join('；') });
  }
  // 4 受影響的共用元件：點名的要真的存在；寫「無」要附理由，且工作區沒有未交代的共用元件改動
  if (cells[3]) {
    const cands = componentCandidates(texts[3]);
    if (cands.length) {
      const miss = cands.filter((c) => !nameExists(c));
      if (miss.length) bad.push({ slot: 3, why: '點名的元件在四個 repo 查無（檔名、目錄名、程式內文都比對過；拼錯或捏造）：' + miss.join('、') });
    } else if (!NEG.test(texts[3])) {
      if (!mentionsSomething(texts[3])) bad.push({ slot: 3, why: '沒點名任何元件（要寫檔名或元件名，如 VeeUpload），也不是「無＋理由」' });
    } else {
      const chg = (opts && opts.changedShared ? opts.changedShared : changedSharedFiles)();
      const low = texts[3].toLowerCase();
      const unack = chg.filter((f) => !low.includes(f.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase()));
      if (unack.length) bad.push({ slot: 3, why: '寫「無」，但四個 repo 工作區有改到共用元件目錄（git diff HEAD／未追蹤檔）：' + unack.join('、') + '——逐檔點名並說明要不要連帶回歸' });
    }
  }
  // 5 跨格重複：兩格實質相同（照貼同一段）
  const flats = texts.map((t) => flatText(stripMarkers(t)));
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const a = flats[i], b = flats[j];
    if (a.length < 4 || b.length < 4) continue;
    if (a === b || (Math.min(a.length, b.length) >= 12 && bigramJaccard(a, b) >= 0.8)) {
      bad.push({ slot: j, dup: true, why: '與「' + SCOPE_CELLS[i].name + '」格內容實質相同（各格要寫各自的內容，不能貼同一段）' });
    }
  }
  return bad;
}

const NO_EXEC_HEAD = /不執行|不跑測試|只做設計|純設計|不測試/;
const NO_EXEC_ORDER = /不要執行任何操作|不執行任何操作|不開瀏覽器|不跑\s*pytest|不得執行測試/;
// 【範圍展開】整關判定（hook 與 cases／語料校準共用同一支）：多段時取缺項最少的一段；回傳 null＝找不到行首標題
function scopeGate(prompt, tpl, opts) {
  let best = null;
  for (const s of sectionsOf(prompt, '範圍展開')) {
    // 不執行測試的 QA 派工（只做設計、只回答問題）：標題行宣告不執行，且派工單另有「不開瀏覽器／不跑 pytest」這類明令時，
    // 只判有沒有作答、不判內容品質——兩個條件都要成立，單寫標題繞不過（QA 被明令不准測，就沒有測試範圍可漏）
    const noExec = NO_EXEC_HEAD.test(s.head) && NO_EXEC_ORDER.test(prompt);
    const r = judgeScope(s, tpl.hints || [[], [], [], []], Object.assign({ raws: tpl.raws, quality: !noExec }, opts || {}, noExec ? { quality: false } : {}));
    if (!best || r.bad.length < best.bad.length) best = r;
    if (!r.bad.length) break;
  }
  return best;
}
// 【驗收條件】整關判定：filled＝有沒有任何一段寫出內容；v＝最好那段的不可驗證條目（任一段全條可驗證即為空）
function accGate(prompt) {
  const filled = sectionsOf(prompt, '驗收條件').filter((s) => hasRealText(stripHeadNote(s.head) + '\n' + s.body.join('\n')));
  if (!filled.length) return { filled: false, v: [] };
  const vague = filled.map(judgeAcceptance);
  return { filled: true, v: vague.some((x) => !x.length) ? [] : vague.reduce((a, b) => (b.length < a.length ? b : a)) };
}

// 【驗收條件】逐條可驗證：每條要有可對帳的證據——指令、exit code、數字門檻、檔名／路徑、識別字、DB 值、
// VERDICT／PASS／BLOCK 類判語、或「貼輸出／截圖／snapshot／行號」這類證據要求。純形容詞（「確認正常」「功能完整」）擋。
// 強證據：本身就是判準（數字門檻、指令、判語、行號、斷言）
const ACC_EVIDENCE = /\d|[≤≥<>＜＞=＝]|🔴|🟡|🟢|行號|讀回|斷言|三方|編譯|查詢結果|計數|硬編|AI\s*痕跡|罐頭|(?<![A-Za-z])(?:PASS|FAIL|BLOCK|VERDICT|Critical|Important|Minor|exit|readback|assert|diff|grep|build|lint|pytest|vitest|dotnet|npm|npx|node|python|git|curl|sqlcmd|SELECT|SQL|playwright|eslint|tsc|console|network|hardcoded?)(?![A-Za-z])/i;
// 弱證據：只是「要附證據」的要求（貼輸出、截圖、綠）——還要有具體對象（拿掉這些詞與空泛詞後 ≥3 字），「功能 OK，貼輸出」不算
const ACC_WEAK = /貼|截圖|snapshot|輸出|原文|全文|對照|比對|命中|佐證|證據|實測|實跑|殘留|已刪|綠|紅燈|清單|零/gi;
// 交付型條目：「列出／說明／附…」後面要接具體對象（拿掉「正常、正確、一切」這類詞後還剩 3 個字以上）
const ACC_DELIVER = /(?:列出|說明|回答|附上?|提供|標明|指出|記錄|回報)(.+)/;
// 可觀察結果：主詞＋「跟著變／帶回／被擋／消失／不受影響…」，主詞要具體（拿掉空泛詞後還剩 3 個字以上）
const ACC_OBSERVE = /第[一二三四五六七八九十]+[筆列頁個欄格]|跟著變|帶回|導向|跳出|被擋|擋下|消失|出現|變成|變為|回到|等於|應為|不變|一致|相同|為空|清乾淨|清空|轉綠|仍綠|不受影響|不得|不可|不能/;
// 約束型條目：「未動 tests/」「無改 production code」「不得重啟服務」——事後可用 git status／程序清單對帳
const ACC_CONSTRAINT = /(?:無|未|不得|禁止|沒有)(?:改|動|殺|重啟|開|跑|寫|刪|新增|引入|修改|手動)/;
const ADJ_WORDS = /正常|正確|無誤|完整|成功|沒問題|良好|順利|一切|妥當|合理|適當|符合預期|如預期/g;
const accSubject = (s) => flatText(s).replace(ADJ_WORDS, '').replace(REFER_WORDS, '').replace(NULL_WORDS, '').length;
function accItems(sec) {
  const lines = (stripHeadNote(sec.head) + '\n' + sec.body.join('\n')).split(/\r?\n/);
  const items = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const indent = /^[ \t]*/.exec(l)[0].replace(/\t/g, '  ').length;
    const cont = indent >= 2 || /^\s*(?:[（(]|⚠|→|例[:：]|註[:：]|※)/.test(l);
    if (cont && items.length) items[items.length - 1] += '\n' + l;
    else items.push(l);
  }
  return items;
}
function judgeAcceptance(sec) {
  const bad = [];
  for (const it of accItems(sec)) {
    const body = stripPlaceholders(it).replace(/^\s*(?:[-*•+]|\d+[.)、．）]|[①-⑩])\s*/, '').replace(/^\s*(?:條件|驗收|AC)\s*\d+\s*[:：.]?/i, '');
    const f = flatText(stripMarkers(body));
    if (f.replace(NULL_WORDS, '').length < 2) continue;                      // 空條目由「有沒有作答」那一關管
    if (/[:：]\s*$/.test(body.trim()) && f.length <= 15) continue;           // 小標題（「後端：」「回報：」）
    if (/^\s*(?:\*\*\s*)?[A-Za-z一二三四五六七八九十][.、．)]\s*[^\n]*\*\*/.test(it) || /^\s*#{1,6}\s/.test(it)) continue;   // 分組標題（「**C. 註解品質**」）
    if (/^\s*(?:不需|不必|無需|不用)/.test(body)) continue;                   // 範圍註記（「不需開畫面（QA 另派）」）
    if (ACC_EVIDENCE.test(body) || anchorsOf(body).length) continue;
    if (new RegExp(ACC_WEAK.source, 'i').test(body) && accSubject(body.replace(ACC_WEAK, '')) >= 3) continue;
    const d = ACC_DELIVER.exec(body);
    if (d && (accSubject(d[1]) >= 3 || accSubject(body) >= 6)) continue;   // 「無新模式（有則列出）」：列出的對象寫在前面
    if (ACC_OBSERVE.test(body) && accSubject(body.replace(new RegExp(ACC_OBSERVE.source, 'g'), '')) >= 3) continue;
    if (ACC_CONSTRAINT.test(body) && accSubject(body) >= 4) continue;
    bad.push(body.trim().split(/\r?\n/)[0].slice(0, 40));
  }
  return bad;
}

// ── 對齊類任務【對照表】（2026-10-08，03 矩陣 B10）──────────────────────────────────
// B10 早就要求「對齊／照搬／複製／同步」類任務逐項對照兩邊的可觀察契約，近 30 天仍有 4 則糾正是同一種錯
// （Excel 少了歸屬單位多了檔案清單、欄序錯、照隔壁那支卻漏了欄位），規則只要求「列出差異」、沒有要交出可檢查的產出物。
// 本閘：派工單的任務目標是對齊類時，必須有【對照表】格寫出兩邊各是什麼、要比哪些項目／順序／值、差異怎麼結論；
// QA 回報閘（guard-qa-report.js）再要求回報貼回逐項對照表。
// 觸發只看任務目標（行首【目標】【任務】【目的】段；沒有就看 Markdown「# 目標」標題段；再沒有就看開頭段）：
// 全文掃描在 390 份歷史派工單命中 251 份，幾乎都是【開工前對齊】、「（照抄，不要省）」、驗收條件裡的「與 DB 一致」這類一般用語；
// 只看任務目標時命中 12 份（閘範圍內），逐份讀過都是對齊類任務（分類見 cases/dispatch-quality.test.js 檔頭）。
// 判準＝對齊動詞＋基準側：「比照／照搬／照抄／仿照／看齊／鏡像／參照／抄 X」「對齊 X」「跟／和／與／同 X 一樣／一致／相同／同步」
// 「兩邊／兩站／內外站…一致」。基準側是共識、慣例、版面、改動前後這類字時不算（「已與使用者對齊」「照慣例」「靠左對齊」「與改動前相同」）。
function goalText(prompt) {
  const out = [];
  for (const n of ['目標', '任務', '目的']) for (const s of sectionsOf(prompt, n)) out.push([s.head].concat(s.body).join('\n'));
  if (out.length) return out.join('\n');
  const lines = String(prompt).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6}\s*(?:目標|任務|目的)/.test(lines[i])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]) && !HEAD_RE.test(lines[j]); j++) body.push(lines[j]);
    out.push(body.join('\n'));
  }
  if (out.length) return out.join('\n');
  const lead = [];
  for (const l of lines) {
    if (HEAD_RE.test(l) || /^#{1,6}\s/.test(l)) { if (lead.some((x) => x.trim())) break; continue; }
    if (/SendMessage|不得再?轉派|親自執行/.test(l)) continue;
    lead.push(l);
    if (lead.length >= 12) break;
  }
  return lead.join('\n');
}
const ALIGN_NOT_SIDE = /使用者|需求|設計|規格|共識|拍板|簽收|慣例|規範|模板|範本|風格|原則|紀律|預期|期望|驗收|上面|以上|上述|下列|編號|現況|現行|實際|事實|環境|DB|資料庫|實值|讀回|readback|結論|改前|修前|修後|改後|(?:改動|修改|調整|重構|修正)[前後]|先前|之前|原本|原來|原先|現在|舊版|以前|是否|^(?:到清零|清零|表態|回合|的|後|完|了|過|中|下來|下|錄)/i;
const ALIGN_NEG_PRE = /(?:不要|不得|不可|不准|不用|無須|別|勿|禁止|避免)[^，,。；;]{0,2}$/;
const ALIGN_TEST_PRE = /(?:測試|斷言|(?<![A-Za-z])tests?(?![A-Za-z])|locator|定位器?)[^，,。；;]{0,6}$/i;
const ALIGN_LAYOUT = /靠左|靠右|置中|置左|置右|左對齊|右對齊|置頂|對齊方式|對齊(?:推導|規則|不變)|左緣|右緣|欄寬|(?<![A-Za-z])(?:align|justify|text-(?:left|right|center))/i;
const ALIGN_PATS = [
  /(?:比照|照搬|照抄|仿照|看齊|鏡像|參照|(?<![照摘])抄)\s*(?:著)?\s*([^，,。；;（(）)、：:\n]{2,30})/g,
  /對齊(?:到|至|成|於)?\s*([^，,。；;（(）)、：:\n]{2,30})/g,
  /(?:跟|和|與|同)\s*([^，,。；;（(：:\n]{1,30}?)\s*(?:完全|保持|維持)?\s*(?:一樣|一致|相同|同步|對齊|同型|等價)/g,
  // 中間不跨引號：「對內外站前端做「VeeDataTable 欄位對齊」的驗證」的對齊是引號裡的版面用語
  /((?:兩邊|兩站|兩側|內外站|兩支|兩份|雙方)[^，,。；;「」『』\n]{0,20}?)(?:一致|一樣|對齊|同步|相同)/g,
];
// 回傳 [{ match, side, text }]（text＝命中所在的句子）
function alignHits(text) {
  const hits = [];
  for (const sent of stripPlaceholders(String(text)).split(/[。；;\n]/)) {
    if (!sent.trim() || ALIGN_LAYOUT.test(sent)) continue;
    for (const re of ALIGN_PATS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(sent))) {
        const side = m[1].trim().replace(/^[」』”"'`）)\]】*_\s]+/, '');
        if (flatText(side).length < 2 || ALIGN_NOT_SIDE.test(side)) continue;
        const pre = sent.slice(0, m.index);
        // 「不要照抄別人的結論」是否定；「改寫過時的測試對齊正式頁」「改斷言對齊實際渲染」是測試跟著產品改，不是兩邊契約的對齊
        if (ALIGN_NEG_PRE.test(pre) || ALIGN_TEST_PRE.test(pre)) continue;
        hits.push({ match: m[0].trim(), side, text: sent.trim() });
      }
    }
  }
  return hits;
}
const alignTrigger = (prompt) => alignHits(goalText(prompt));
// 【對照表】五列（04 共通規則「對齊類任務」）：來源（兩邊各是什麼）、欄位／元素、順序、值／行為、差異結論
const COMPARE_ROWS = [
  { name: '來源', re: /^(?:對照來源|來源|兩邊|基準)/ },
  { name: '欄位／元素', re: /^(?:欄位|元素|項目)/ },
  { name: '順序', re: /^(?:順序|欄序|次序)/ },
  { name: '值／行為', re: /^(?:值|行為)/ },
  { name: '差異結論', re: /^差異/ },
];
const COMPARE_LABEL = /^(對照來源|來源|兩邊|基準|欄位(?:\s*[／/]\s*元素)?|元素|項目|順序|欄序|次序|值(?:\s*[／/]\s*行為)?|行為|差異(?:結論|處理)?)[*_]*\s*(?:[（(][^）)\n]*[）)])?\s*[:：]\s*(.*)$/;
const COMPARE_SPLIT = /[；;](?=\s*[*_]*(?:對照來源|來源|欄位|元素|項目|順序|欄序|次序|值|行為|差異)[^：:；;]{0,8}[:：])/;
const compareLead = (l) => String(l).replace(/^[\s>*_#-]*/, '').replace(/^(?:[\d１-９]+[.、．)）]|[①-⑩])\s*/, '').replace(/^[*_]+\s*/, '');
// 兩邊的分隔：；、↔、vs（「A＝x；B＝y」「x ↔ y」）
const SIDE_SPLIT = /[；;]|↔|⇄|⟷|<->|(?<![A-Za-z])vs\.?(?![A-Za-z])/;
const SIDE_TAG = /(^|[；;↔⇄⟷\s])\s*[ABab](?:\s*側)?\s*[＝=:：]/g;
// 一段【對照表】的判定：回傳 { bad: [說明], orderNA }
function judgeCompare(sec) {
  const rows = {};
  let cur = null;
  const lines = [].concat(...[sec.head].concat(sec.body).map((l) => String(l).split(COMPARE_SPLIT)));
  for (const l of lines) {
    const m = COMPARE_LABEL.exec(compareLead(l));
    const slot = m ? COMPARE_ROWS.findIndex((r) => r.re.test(m[1])) : -1;
    if (slot >= 0 && rows[slot] === undefined) { rows[slot] = [m[2]]; cur = slot; continue; }
    if (cur !== null) rows[cur].push(l);
  }
  const bad = [];
  let orderNA = false;
  COMPARE_ROWS.forEach((r, k) => {
    if (rows[k] === undefined) { bad.push('缺「' + r.name + '」列'); return; }
    // 來源列的「A＝」「B 側：」是側名標籤，不是內容（照貼模板只剩「A＝ ；B＝ 」不得算作答，也不得被當成「設定值指派」錨點）
    const text = k === 0 ? stripPlaceholders(rows[k].join('\n')).replace(SIDE_TAG, '$1') : rows[k].join('\n');
    if (!hasRealText(text)) { bad.push('「' + r.name + '」沒寫內容（只留佔位、空詞，或寫不適用沒附理由）'); return; }
    if (k === 2 && NEG.test(text)) orderNA = true;
    if (k === 0) {
      const sides = text.split(SIDE_SPLIT).filter((s) => hasRealText(s));
      if (sides.length < 2) { bad.push('「來源」只寫出一側（要寫兩邊各是什麼，用「；」或「↔」分開：A＝…；B＝…）'); return; }
      const vague = sides.filter((s) => !anchorsOf(s).length);
      if (vague.length) bad.push('「來源」的「' + vague.map((s) => s.trim().slice(0, 20)).join('」「') + '」沒有具體錨點（路由、檔名、檔:行、識別字或畫面元素名）');
    }
  });
  return { bad, orderNA };
}
// 派工閘與 QA 回報閘共用：任務目標是對齊類時回傳 { hits, sec }（sec＝合格的那段【對照表】，沒有合格的就是 null）、
// 並附最好那段的缺項；不是對齊類回傳 null
function compareGate(prompt) {
  const hits = alignTrigger(prompt);
  if (!hits.length) return null;
  let best = null;
  for (const s of sectionsOf(prompt, '對照表')) {
    const r = judgeCompare(s);
    if (!best || r.bad.length < best.bad.length) best = r;
    if (!r.bad.length) break;
  }
  return { hits, ok: !!best && !best.bad.length, bad: best ? best.bad : null, orderNA: !!best && best.orderNA };
}

let raw = '';
let checkError = null;   // 檢查途中丟出的例外（見 end handler 尾段）
const notes = [];        // 不擋但要讓模型知道的檢查限制（例如模板原文讀不到）
function checkErrorNote() {
  return '[派工紀律] ⚠ 派工內容檢查故障（' + String((checkError && checkError.message) || checkError).split('\n')[0]
    + '）：丟出例外之後的閘這次都沒檢查到，已放行這些項目（上面列出的缺項照常要補）。'
    + '請自行對照 .claude/harness/04-delegation-templates.md 確認派工單齊全；hook 鏽蝕要修（.claude/hooks/check-review-discipline.js），勿靜默忽略。';
}
if (require.main === module) {
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const reasons = [];
  try {
    const input = JSON.parse(raw);
    const ti = input.tool_input || {};
    const type = String(ti.subagent_type || '').split(':').pop();
    const prompt = String(ti.prompt || '');
    if (type === 'code-reviewer' && !/rule-scan/i.test(prompt)) {
      reasons.push('[code-review 紀律] 派 code-reviewer 的 prompt 必須包含 rule-scan 步驟：後端審查第一步跑 node .claude/scripts/rule-scan.js <repo根目錄>（機械掃描自有規則正本 .claude/skills/code-review/rules/ 保底），每筆命中逐筆裁決並引 RULE 編號、報告附掃描統計；前端變更可註明 rule-scan 不適用改走 skill 前端清單。請在 prompt 補上後重發同一個 agent。');
    }
    if (type === 'backend-architect' && !/規範符合性檢核|Compliance Gate/.test(prompt)) {
      reasons.push('[backend-architect 紀律] 派 backend-architect 的 prompt 必須要求產出「規範符合性檢核」節（Compliance Gate）：設計文件逐條核對 repo CLAUDE.md 與自有規則正本（.claude/skills/code-review/rules/）、引用條文必開原文、偏離必列裁決點且預設遵守規範。請在 prompt 補上後重發同一個 agent。');
    }
    // 簽收物形狀檢查（偷自 AIDLC v2 required-sections sensor）：交棒下游的那一刻驗產物本身，
    // 堵「architect 漏產情境表沒人擋」——探針是一次性的，這裡是常駐閘。
    if (['backend-engineer', 'frontend-engineer', 'code-reviewer'].includes(type)) {
      const m = prompt.match(/【設計文件[^】]*】([^\n]*)/);
      let p = m && (m[1].match(/[A-Za-z]:[\\/][^\s>《》【】]+\.md/) || [])[0];
      if (m && !p) {
        // 相對路徑也要能檢查，否則寫相對路徑＝靜默繞過本閘（cwd 漂移事故的同類縫，2026-08-10 補）
        const rel = (m[1].match(/[^\s>《》【】"']+\.md/) || [])[0];
        if (rel) p = require('path').resolve(process.env.CLAUDE_PROJECT_DIR || __dirname + '/../..', rel);
      }
      if (p && require('fs').existsSync(p)) {
        const doc = require('fs').readFileSync(p, 'utf8');
        const missing = [];
        if (!/^##.*情境表/m.test(doc)) missing.push('「測試情境表」H2 節');
        if (!/待簽收|已簽收/.test(doc)) missing.push('簽收狀態句（待簽收/已簽收）');
        if (missing.length) {
          reasons.push('[簽收物形狀] 設計文件 ' + p + ' 缺：' + missing.join('、') + '——簽收物不完整不得交棒下游。請回 architect 補齊（或補簽收狀態）後重發同一個 agent。');
        }
      }
    }
    // 開工前對齊表態閘（2026-08-13 補）：掃 29 場實作 session，11 場開工前 0 對齊痕跡、
    // 抽驗抓到 c28731e1 行為類新功能靜默開工——「無條件對齊回合」是純 prose、零 forcing function，
    // 沒人盯的 session 直接跳過。hook 拿不到 session 歷史，改驗「派工 prompt 帶對齊結論」（同 CATALOG 分流模式）。
    // 「分流例外：<理由>」也是合法表態（CLAUDE.md §3 分流例外；04 模板二、三、六都列為選項，本閘的 deny 訊息也這樣教），
    // 2026-10-03 前只認前三種寫法，照訊息單獨填分流例外反而被擋。
    if (['backend-engineer', 'frontend-engineer', 'qa-engineer'].includes(type) && !/對齊回合|對齊結論|無分岔|已 grill|已對齊|分流例外/.test(prompt)) {
      reasons.push('[開工前對齊] 派實作/QA subagent 的 prompt 必須帶「開工前對齊表態」（CLAUDE.md §3 無條件對齊回合，本 session 開工前必過一回合、不可跳過）：二選一——有決策型解讀分岔（做成什麼樣／改哪個範圍／哪種行為／交付給誰）→ 已正式對齊到清零（提不出新分岔＋使用者確認共識），prompt 中一句話交代對齊結論；無分岔 → 明寫「無分岔＋一句理由」。純結構/文案/死碼/i18n 等靜態可確定等價的分流例外，也在此句註明「分流例外：<理由>」。判斷由你做，本檢查只驗有沒有表態。請在 prompt 補上後重發同一個 agent。');
    }
    if (type === 'qa-engineer' && !/CATALOG 分流/.test(prompt)) {
      reasons.push('[增量 QA 分流] 派 qa-engineer 的 prompt 必須含「CATALOG 分流」表態：開工第一步 Read tests/e2e/CATALOG.md 與對應 COVERAGE.md，並在 prompt 中明寫二選一——reuse：變更落在既有 codified 情境 seam 內 → 指名要改的既有 test 檔路徑，只加 assert／參數化並跑受影響案例，不開 Playwright MCP；新 TC：無既有覆蓋／新 UI 面／需視覺判斷 → 一句理由說明為何既有案例接不住，才走 MCP 探索＋codify。判斷由你做，本檢查只驗有沒有表態。請在 prompt 補上後重發同一個 agent。');
    }
    // QA 範圍展開閘（2026-09-01 補）：三個月稽核顯示 92%(278/301) 的 QA 派工單是封閉 TC 清單，
    // 要求測反向分支僅 16%、逐欄驗值僅 8%——使用者實測抓包的缺陷幾乎全落在派工單沒寫的那一格。
    // QA agent 只測派工單上的東西，範圍完整性是指揮官責任。同 CATALOG 分流模式：只驗有沒有表態，不判內容。
    // 目標環境閘（2026-09-03 補）：本輪站台錯亂犯過兩次（把 auth-host.internal 誤當內站後端、CAIS 出向講成前端打）。
    // 站台錯亂發生在派工那一刻指揮官寫錯位址，逼它列出「哪個環境」就會自己抓到。預設 localhost 也算表態（填一行即可）。
    // 只驗有沒有這格，不判 localhost/dev 內容對錯（同既有哲學）。
    // 必讀清單閘（2026-09-10 補）：E 類紀律（造被測狀態不得繞過產品入口、封閉例外清單、
    // 判準）的說明在 tests/e2e/README.md，PROJECT.md 鐵則 7 是它的入口。兩者都不在
    // 派工單上時，QA 撞到「這筆資料產品好像產不出來」就沒有判準可依，只能憑感覺判成例外。
    // ⚠ 為什麼要用 hook 而不是只寫在模板六：PROJECT.md 的必讀是靠 browser-qa skill
    // 「入口存在就必先讀」那句話帶進去的，而該 skill 在 plugin cache 裡、升級會被覆蓋——
    // 靠 skill 一句話撐著的紀律，升級當天就靜默脫鉤。這道閘讓它不依賴 plugin。
    // 同既有哲學：只驗派工單有沒有帶到，不判 agent 是否真的讀了。
    if (type === 'qa-engineer') {
      // 路徑正規化後再比（2026-09-10 補）：本檔原本用 indexOf 硬比正斜線字串，
      // 而 Windows 的原生絕對路徑是反斜線、派工規範又要求「路徑一律絕對路徑」——
      // 於是照範本寫、路徑也真的帶到了，卻因為分隔符方向被判成「缺」。
      // 這種假陽性最毒的地方是訊息會指錯方向（說你缺這份檔，其實是斜線寫反），
      // 收到的人最自然的反應是「再貼一次路徑」——貼的還是反斜線，於是再被擋一次。
      // （2026-09-10 空 session 盲測實證：把 tests\\e2e\\README.md 改成正斜線、內容一字未動即過閘。）
      const nprompt = String(prompt).split('\\').join('/').toLowerCase();
      const hasPath = (s) => nprompt.indexOf(String(s).toLowerCase()) >= 0;
      const miss = [];
      if (!hasPath('Project_Detail')) {
        miss.push('tests/Project_Detail/PROJECT.md（QA 知識路由中心；鐵則 7＝造被測狀態的紅線）');
      }
      if (!hasPath('tests/e2e/README.md')) {
        miss.push('tests/e2e/README.md（e2e 執行契約：封閉例外清單＋判準、空庫紀律、G-REVIEWED 格式）');
      }
      if (miss.length) {
        reasons.push('[QA 必讀清單] 派 qa-engineer 的 prompt 的【開工前必讀】缺：' + miss.join('；')
          + '。這兩份是「造被測狀態不得繞過產品入口」判準的入口與正本——缺了它，QA 撞到'
          + '「這筆資料產品好像產不出來」時無判準可依，只能憑感覺判成例外，'
          + '而 2026-09-09 實測六個這類判斷全被推翻（判真例外的機械動作見 03 矩陣 B18）。'
          + '照 04 模板六【開工前必讀】把絕對路徑補進 prompt 後重發同一個 agent。');
      }
    }
    if (type === 'qa-engineer' && !/【目標環境】/.test(prompt)) {
      reasons.push('[目標環境] 派 qa-engineer 的 prompt 必須含【目標環境】表態（04 模板六）：預設 localhost 填一行帶過即可；'
        + '切 dev 測試站要展開三行（前端站／後端 API／身分＋token）並先讀 tests/Project_Detail/dev-site-testing.md，'
        + '且 token 發出超過 8 小時就不派、先跟使用者要新的。'
        + '⚠ auth-host.internal 是 EmployeeAuth＋CAIS 出向，不是內站後端（內站後端＝admin-api.internal.example）。'
        + '請在 prompt 補上後重發同一個 agent。');
    }
    // 測試資料來源閘（2026-09-02 補）：04:30 早就寫了「造測試資料要走 UI 真實操作」，
    // 但實測 491 支 e2e 只有 26 支自種自清（5.3%），21 處硬編業務 Id、其中 5 處 DB 已 0 筆、
    // 另有 6 個外部種子 SQL／11 支測試要人工先跑才動得了。規則存在但零 forcing function。
    // 2026-09-09 補：原本只驗「有沒有出現【測試資料來源】這幾個字」——
    // 寫了標題就過，選 a/b/c 哪個、b/c 有沒有附理由都不看，等於只擋「完全沒寫」。
    // 實測代價：全庫 36 處寫死會員代碼、300 處直接 INSERT 業務主體表、198 處寫死員工 alias，
    // 而這些派工單多半都「有寫【測試資料來源】」。故改為三段驗：
    //   ① 有沒有這格 ② 有沒有明選 a/b/c ③ 選 b/c 有沒有附理由
    // 仍不判「選得對不對」（那要看程式碼，是 PostToolUse guard-test-asset-hygiene.js 的事）。
    if (type === 'qa-engineer') {
      const CATS = loadExceptionCategories();
      const CATS_TEXT = CATS.cats
        ? '；本次讀到：' + CATS.cats.map((c) => c.code + '（' + (c.name || '') + '）').join('／')
        : '';
      const DATA_SRC_COMMON =
        '（04-delegation-templates.md 模板六）三選一：'
        + 'a 走真實業務流程長出來（首選；會員類＝內站發邀請連結→外站填表→submit-by-link→callback_step1→callback_step2，'
        + '要跑到 callback_step2 才回填 MainMemberCode、才算正式會員）；'
        + 'b 封閉例外（只限例外類別，正本：`' + CATS_CMD + '`' + CATS_TEXT + '；'
        + '寫成「選 b，例外類別：<代碼或別名>，證據：<守門或寫入點的 檔名:行號>」（固定格式：閘只認「例外類別：」後面那個字，不判自由文字）；'
        + '成本過高、跨站麻煩、跑得慢都不是理由——一律走 a，不論成本）；'
        + 'c 依賴既有資料（僅限字典／設定類，且期望值須查 DB 推導；業務資料列一律不得走 c）。'
        + '⛔ 禁止：硬編業務資料列數字 Id、硬編會員代碼字面值（改讀 helpers/partner_identity.current_company_id()）、'
        + '直接 INSERT/UPDATE 業務主體表造狀態、硬編員工 alias 當輸入（PHCHOU3/DB40 這種）、'
        + '依賴人工先跑的外部種子 SQL 或 teardown 還原別人的資料。'
        + '請在 prompt 補上後重發同一個 agent。';

      if (!/【測試資料來源】/.test(prompt)) {
        reasons.push('[測試資料來源] 派 qa-engineer 的 prompt 必須含【測試資料來源】表態' + DATA_SRC_COMMON
          + '收據：全庫 21 處硬編業務 Id，實測 5 處 DB 已 0 筆'
          + '（TableA 19/21/33、TableB 9641、Files 8467）——不是會壞，是已經壞了。');
      } else {
        // 取【測試資料來源】之後、到下一個【】格之前的內容當作該格的作答區
        const seg = (prompt.split('【測試資料來源】')[1] || '').split('【')[0];
        // 範本佔位（<…>，可巢狀）由內往外剝到沒有變化為止：佔位裡的示範文字不算作答
        const stripPh = (s) => {
          let out = String(s);
          for (;;) {
            const next = out.replace(/<[^<>]*>/g, ' ');
            if (next === out) return out;
            out = next;
          }
        };
        const OPT_LETTERS = ['a', 'b', 'c'];
        // 作答段：第一個非空行起，到空行、或到以「a. b. c.」「（」「⛔」開頭的說明行為止。
        // 模板六在同一格下方附 a/b/c 說明與 ⛔ 清單，裡面有 BPM／SAP 字眼與「檔名:行號」，不得頂替作答
        // （2026-09-25 實證：整段模板貼上、只填「選 b，理由：比較快」就放行）。
        const answer = (() => {
          const out = [];
          for (const l of stripPh(seg).split(/\r?\n/)) {
            if (!out.length) { if (l.trim() !== '') out.push(l); continue; }
            // 說明行可能帶 Markdown 前綴（- a.／> ⛔／* b.），與判「選 X」時剝的前綴同一套，先剝再判
            if (l.trim() === '' || /^\s*(?:\**\s*[abc]\**\s*[.．、)）](?![A-Za-z0-9@\[][\w.\-/@\[\]+~]*(?:[:：]|#L)\d)|[（(]|⛔)/i.test(l.replace(/^[\s_`#>\-：:]+/, ''))) break;
            out.push(l);
          }
          return out.join('\n');
        })();

        // 選項判定——固定格式：該格第一行開頭必須是「選 a」「選 b」或「選 c」（「選擇：a」「選用 b」也算），後面再接理由。自由文字的判法試過五種——字母＋說明詞、否定詞清單、成對否定、第一子句、選字族優先——每一種都有新破口（「不用 a，選 b」判成 a、「本案可從畫面造出，選 a」判成沒選），故不再猜：同一支閘的【增量分流】早就是「第一行開頭寫 reuse 或 新TC」，從沒出過問題。
        // 與 qa-webwright plugin 的 guard-qa-dispatch.js 同一套規則。
        const picked = (() => {
          const head = /^選(?:擇|用)?\s*[:：]?\s*([abc])(?![A-Za-z0-9])/i;
          const lines = stripPh(seg).split(/\r?\n/)
            .map((l) => l.replace(/^[\s*_`#>\-：:]+/, '').replace(/^[\d０-９]+[.)、．）]\s*/, '').trim()).filter((l) => l !== '');
          if (!lines.length) return [];
          const m = head.exec(lines[0]);
          if (!m) return [];
          const L = m[1].toLowerCase();
          const rest = lines[0].slice(m[0].length).split(/[，,。；;：:（(]/)[0];
          if (OPT_LETTERS.some((x) => x !== L && new RegExp('(^|[^A-Za-z0-9])' + x + '($|[^A-Za-z0-9])', 'i').test(rest))) return [];
          if (lines.slice(1).some((l) => { const k = head.exec(l); return k && k[1].toLowerCase() !== L; })) return [];
          return [L];
        })();

        // 額外守門：整格只有列舉選單、沒有任何表態句 → picked 會是空的，走下面的「未明選」。
        //
        // ⚠ 這裡的 else-if 是**語意上必要**的，不是「補一項撞一項」的那種串聯：
        // 沒選 a/b/c 之前談「缺理由」沒有意義。但既然使用者補完選項後可能再撞
        // 「缺理由」，訊息就必須先講明白，不能讓人以為補完這項就結束
        // （2026-09-11 紅藍對抗：訊息的「完整清單」承諾在這條路徑上是假的）。
        if (picked.length === 0) {
          reasons.push('[測試資料來源·未明選] prompt 有【測試資料來源】這格，但沒看到明確選了 a／b／c 哪一個。'
            + '寫標題不算表態——只擋「完全沒寫」等於沒擋，實測全庫 36 處寫死會員代碼、300 處直接 INSERT，'
            + '那些派工單多半都「有寫這格」。該格第一行開頭要寫「選 a」「選 b」或「選 c」（固定格式；'
            + '先寫說明、後面才表態，或第一句同時提到兩個選項，都不算）。'
            + '⚠ **選 b 或 c 的話請一併附上理由**（b 要用固定格式寫「例外類別：<代碼或別名>」、c 要說明為何屬字典／設定類），'
            + '否則補完選項會再撞一次「缺理由」——這兩項在邏輯上有先後，不是漏報。'
            + DATA_SRC_COMMON);
        } else {
          // b＝封閉例外（走真實業務流程，不管成本）：只認允許的理由（白名單）——
          // ①點名例外類別之一（代碼或別名，執行時讀正本）②附產品端證據的「檔名:行號」。不判推託詞：推託講法無限多，
          // 黑名單在 09-25 連續三輪審查每修一種句型就漏另一種、還誤擋正當描述（「HMS2 同步，快速回寫」）。
          // ①的「點名」只認固定格式「例外類別：<代碼或別名>」——子字串比對分不出「跟 BPM 無關」是點名還是排除（2026-10-17，見 declaredExceptionCategory）。
          // 刻意不收裸字 mock／callback：「直接 INSERT mock 資料」「callback 寫起來省事」都沒點名是哪一類（正本別名同此原則）。
          if (picked.includes('b')) {
            const EVIDENCE = /[\w\u4e00-\u9fff./\\@\[\]+~-]+\.(?:cs|js|mjs|cjs|ts|tsx|jsx|vue|py|java|kt|go|rb|php|sql|rs|swift|scala|sh|ps1|json|ya?ml|xml|c|h|cc|cpp|hpp)(?:[:：]|#L)\d+/;
            const why = answer;   // 只看作答段（見上）
            if (!CATS.cats) {
              // fail-closed：讀不到正本就無從判斷點名的是不是例外類別，一律擋（不退回內建清單）
              reasons.push('[測試資料來源·例外類別正本讀不到] 選了 b，但本閘執行時讀不到例外類別正本（`' + CATS_CMD + ' --json`）：'
                + CATS.error + '。讀不到正本時不放行任何 b。'
                + '請先在 workspace 根目錄手動跑 `' + CATS_CMD + '` 確認 python 與該檔可用，修好後重發同一個 agent。');
            } else if (!declaredExceptionCategory(CATS.cats, why)) {
              reasons.push('[測試資料來源·非例外] （本閘只讀作答段：第一行起到空行，或到以 a./b./c.／（／⛔ 開頭的說明行為止——理由與證據要寫在這之前）選了 b，但沒有用固定格式宣告例外類別——'
                + '作答段要寫「例外類別：<代碼或別名>」（全形或半形冒號，類別名照抄、後面接標點或空白；宣告用標點隔成自己的子句，同一子句帶否定詞或類別名後接「以外」之類排除詞都不算）；本閘不判自由文字，「這筆資料跟 BPM 無關」之類提到類別名的句子不算宣告'
                + '（正本：`' + CATS_CMD + '`；本次讀到：'
                + CATS.cats.map((c) => c.code + ' ' + (c.name || '') + '（別名：' + (c.aliases || []).join('、') + '）').join('／') + '）。'
                + '成本、跨站麻煩、跑得慢都不是例外——一律走 a，不論成本（2026-09-25 使用者裁定）。'
                + '「產品沒有入口」是最常見的誤判——先走 03 矩陣 B18 的步驟，其中第③步問「這個前提測試自己造得出來嗎、順序能不能換」，造得出來就走 a。'
                + DATA_SRC_COMMON);
            } else if (!EVIDENCE.test(why)) {
              reasons.push('[測試資料來源·缺證據] （本閘只讀作答段：第一行起到空行，或到以 a./b./c.／（／⛔ 開頭的說明行為止——理由與證據要寫在這之前）選了 b 並點名了類別，但沒附產品端證據：寫出守門或唯一寫入點的「檔名:行號」'
                + '（例：CallbackBossCommandHandler.cs:200）——03 矩陣 B18 的①②步，沒去看產品程式碼就主張例外多半是誤判。'
                + DATA_SRC_COMMON);
            }
          }
          // c 的理由要真的寫出內容：「理由：」後面接空白或佔位不算
          // 計數判準：出現字典／設定類字眼即算；否則取「理由／因為／原因」後面的文字，刪掉佔位字詞與全部空白、標點、符號，
          // 剩下至少 2 個字才算有內容（不列舉句型——列舉「佔位＋其後結束」的 regex 連兩輪都漏）
          const hasReason = (() => {
            if (/字典|設定類|設定|主檔/.test(answer)) return true;
            const m = /理由|因為|原因|why|because|reason(?![A-Za-z])/i.exec(answer);
            if (!m) return false;
            return answer.slice(m.index + m[0].length).replace(/待補[充中上齊]?|待確認|待定|之後再補|之後補|稍後補|再補|後補|之後|稍後|同上|沒有|無|(?<![A-Za-z])(?:(?:TBD)+|TODO|N\/?A|none|OK)(?![A-Za-z])|\.{2,}|…+/gi, '')
              .replace(/[\s\p{P}\p{S}]/gu, '').length >= 2;
          })();
          if (picked.includes('c') && !hasReason) {
            reasons.push('[測試資料來源·缺理由] （本閘只讀作答段：第一行起到空行，或到以 a./b./c.／（／⛔ 開頭的說明行為止——理由與證據要寫在這之前）選了 c 但沒附理由：說明「為何屬字典／設定類」——'
              + '業務資料列（會員、案件、品改單、碳排料號）一律不得走 c。一句話即可，但要寫。' + DATA_SRC_COMMON);
          }
        }
      }
    }
    // 【範圍展開】作答閘（2026-10-04 改）：舊版只驗「【範圍展開】」字樣存在，而模板六【回報格式】自己就寫著
    // 「【範圍展開】逐格回報」——整段不寫、四格全空、照貼模板一字未填都過閘。改為：
    //   ① 只認行首標題（作答範圍＝行首【範圍展開】到下一個行首【…】為止，見 sectionsOf）；
    //   ② 依格名切出四格，每格剝掉佔位 <…>、模板說明原文（執行時讀 04 模板六）與本閘訊息的格說明後，要有實際作答；
    //   ③ 「無／不適用」要附理由：拿掉這類空詞與填充詞（理由、因為…）後至少剩 2 個字。
    // 理由寫在括號裡（「無（單步唯讀）」）算作答——只剝模板帶來的括號說明，不剝作答者自己的括號。
    if (type === 'qa-engineer') {
      const tpl = scopeTemplateHints();
      if (tpl.error) notes.push('[派工紀律] ⚠ 讀不到 04 模板六【範圍展開】原文（' + tpl.error + '）：本次只剝佔位 <…> 與本閘訊息的格說明，'
        + '照貼模板說明文字的格可能被當成已作答。請確認 .claude/harness/04-delegation-templates.md 模板六的四格格式未改（hook：.claude/hooks/check-review-discipline.js）。');
      const best = scopeGate(prompt, tpl);
      if (!best || best.bad.length) {
        // 逐格列：哪一格、缺什麼、怎麼補＋一行好範例（範例照貼會被當模板文字剝掉，要換成本次的實際內容）
        const slots = best ? Array.from(new Set(best.bad.map((b) => b.slot))).sort() : [0, 1, 2, 3];
        const why = !best
          ? '找不到行首的【範圍展開】標題——只在句中或【回報格式】裡提到（例如「【範圍展開】逐格回報」）不算。'
          : '以下格不合格：' + slots.map((k) => '\n   · ' + SCOPE_CELLS[k].name + '——' + best.bad.filter((b) => b.slot === k).map((b) => b.why).join('；')
            + '\n     要求：' + SCOPE_CELLS[k].need + '\n     範例：' + SCOPE_CELLS[k].example).join('');
        reasons.push('[QA 範圍展開] 派 qa-engineer 的 prompt 必須含【範圍展開】四格且逐格寫出具體內容（04-delegation-templates.md 模板六）。本次：' + why
          + '\n   格式：【範圍展開】放在行首，其下四格各以格名開頭（可帶編號與 **粗體**）：'
          + SCOPE_CELLS.map((c, i) => (i + 1) + ' ' + c.name).join('；') + '。'
          + '只留佔位 <…>、照抄模板或本訊息的說明與範例、填 xx／見附件／同上、只寫空泛句（「照常操作確認正常」）都不算；'
          + '範例要換成本次的實際頁面、欄位與值。'
          + '寫入型端點另須填【欄位級驗證】（欄位數＋逐欄 readback，不驗的逐個列理由）。'
          + '收據：08-22 退件重送、07-23 表單簽章鎖死、07-07 交期第二列日期、08-17 VeeUpload 波及 10 檔——四件全是派工單漏列、QA 全綠、使用者實測抓包。'
          + '請在 prompt 補上後重發同一個 agent。');
      }
    }
    // 驗收條件閘（2026-10-01 補 QA；2026-10-04 擴到五支專案 agent）：健檢逐筆讀 09-30 主對話 transcript，
    // 實際派出的 4 筆 qa-engineer 模板六其餘格齊全、唯獨【驗收條件】整格不存在；其餘四支同樣零 forcing function。
    // 只認行首標題（句中提到「對應【驗收條件】」不算）；剝掉標題後的模板括號註記（判準）（逐條判定）、
    // 佔位 <…>、清單編號、「…」與 TBD 一類空詞後要剩實際內容。git-commit C 軌範本「【驗收條件】（判準）」下接 BLOCK／PASS 判準，照常放行。
    // 2026-10-04 再加逐條可驗證（judgeAcceptance）：有內容但每條都是「確認正常」「功能完整」這類形容詞，另列「驗收條件·不可驗證」。
    if (ACC_AGENTS.includes(type)) {
      const { filled, v } = accGate(prompt);
      if (filled && v.length) {
        reasons.push('[驗收條件·不可驗證] 派 ' + type + ' 的【驗收條件】有 ' + v.length + ' 條沒有可對帳的證據：'
          + v.slice(0, 6).map((x) => '\n   · 「' + x + '」').join('') + (v.length > 6 ? '\n   · …另 ' + (v.length - 6) + ' 條' : '')
          + '\n   每一條都要答得出「用什麼指令或什麼觀察判 PASS/FAIL」（04 共通規則）：寫出指令（`dotnet build`、`pytest <檔>`）、'
          + 'exit code 或數字門檻（0 error、≥3 筆）、檔名／路徑、API 欄位或 DB 表欄的期望值、或「貼輸出／截圖／snapshot」；'
          + '「確認正常」「功能完整」這類純形容詞不算。'
          + '\n   範例：- `dotnet build` 0 error；- POST `/backend/case/query` 回傳含 `owner_names`，貼回應原文'
          + '\n   請改寫上列各條後重發同一個 agent。');
      }
      if (!filled) {
        reasons.push('[驗收條件] 派 ' + type + ' 的 prompt 必須含行首的【驗收條件】且要寫出內容（04-delegation-templates.md 模板二／四／六）：'
          + '逐條列出可機械判定的 PASS/FAIL 條件，每一條都要答得出「用什麼指令或什麼觀察來判定」（04 共通規則）。'
          + '只放標題、只在句中提到、只留範本佔位 <…> 或填 TBD 都不算。'
          + '收據：2026-09-30 實際派出的 4 筆 qa-engineer 模板六其餘格齊全，唯獨缺這一格。'
          + '請在 prompt 補上後重發同一個 agent。');
      }
    }

    // 回報鏈鐵則 1、2（2026-09-09 補；04-delegation-templates.md「回報鏈鐵則」）
    // 原本純文字約定，零 forcing function——而該節自己的背景就寫著「靠自覺，實測一天內斷四次」。
    // 鐵則 1（禁二次轉派）與 2（寫明回報指示）都是「prompt 裡有沒有這句話」，可機械驗；
    // 鐵則 3（主對話磁碟驗收）與 4（禁等待型 agent）是行為不是文字，hook 驗不到，仍靠紀律。
    // 只驗有沒有寫，不判措辭好壞（同本檔既有哲學）。
    const CHAIN_AGENTS = ['backend-engineer', 'frontend-engineer', 'code-reviewer',
                          'qa-engineer', 'backend-architect'];
    // git-commit C 軌審查派工（2026-10-03）：範本每次照填都過不了鐵則 2——C 軌一律 run_in_background，
    // 結果靠背景任務通知回主對話，範本裡本來就沒有、也不需要 SendMessage(to: main)；
    // 不免掉的話每次 commit 的 C 軌都被擋，使用者只能手動補一句多餘的回報指示。
    // 只免鐵則 2，rule-scan 照要求（那是本專案審查規則，不是 plugin 範本的一部分）。
    // 三個條件取自 git-commit plugin SKILL.md 的 C 軌範本（fulin-plugins/git-commit/0.9.0，約 218-244 行）：
    // 範本改版（diff 路徑、VERDICT 格式、agent 名）時這三個常數要同步，否則 C 軌會退回每次被擋。
    const C_TRACK_AGENT_TYPES = ['code-reviewer', 'git-commit:code-reviewer'];
    const C_TRACK_DIFF_MARK = '.git-commit-tmp/staged-';
    const C_TRACK_VERDICT_MARK = 'VERDICT: PASS';
    const isCTrack = C_TRACK_AGENT_TYPES.includes(String(ti.subagent_type || ''))
      && prompt.split('\\').join('/').includes(C_TRACK_DIFF_MARK)
      && prompt.includes(C_TRACK_VERDICT_MARK);
    if (CHAIN_AGENTS.includes(type)) {
      // 必讀清單閘擴大到五支 agent（2026-10-03）：原本只驗 QA，其餘四支靠模板文字自覺；
      // 實測模板二／四的【開工前必讀】根本沒寫這份，subagent 就以單層視角開工。
      // CLAUDE.md 不驗——subagent 啟動時自動載入。CONTEXT.md 也不驗（2026-10-13，健檢帳本連動 L1）：
      // root CLAUDE.md 以 @CONTEXT.md 匯入，健檢抽樣 60/60 個子 agent 的逐字紀錄開頭都已帶詞彙表，
      // 要求派工單再列一次是重複、不列又被擋。只剩 FLOWS.md 不在自動注入，照舊要求。
      // 比對照 QA 閘的作法：反斜線轉正斜線、不分大小寫，否則 Windows 原生反斜線絕對路徑會被誤判成缺。
      const nreq = prompt.split('\\').join('/').toLowerCase();
      if (nreq.indexOf('flows.md') < 0) {
        reasons.push('[必讀清單·FLOWS] 派 ' + type + ' 的 prompt 的【開工前必讀】缺：FLOWS.md（跨 repo 鏈路：改一層漏其他層，靜默不報錯）'
          + '。請把 workspace 根的絕對路徑補進必讀清單後重發同一個 agent'
          + '（04-delegation-templates.md 共通規則：五支專案 agent 的必讀一律列 FLOWS.md，沒觸及鏈路就在已讀回報標略過；'
          + 'CONTEXT.md 與 root CLAUDE.md 由系統自動載入，不必列）。');
      }
      const noRelay = /不得再轉派|不得轉派|禁止二次轉派|親自執行/.test(prompt);
      const reportHint = /SendMessage\(to:\s*main\)|SendMessage\(\s*to:\s*["']main["']|回報給 main|回報 main/;
      const reportCount = (prompt.match(new RegExp(reportHint.source, 'gi')) || []).length;
      // ⚠ 這兩條必須**並列**不可 else-if（2026-09-11 紅藍對抗抓到）：
      // 舊版是 if (!noRelay) … else if (reportCount < 2) …，於是兩條都缺時只報鐵則 1，
      // 使用者補完鐵則 1 重發，才撞到鐵則 2——正是本檔頂部註解說要根治的
      // 「補一項撞一項」，而且訊息還寫著「這是本次的完整清單，不會再有第二批」，
      // 那句話在這個路徑上是假的。實測兩輪 ping-pong 重現。
      if (!noRelay) {
        reasons.push('[回報鏈鐵則 1] 派工 prompt 必須明寫「本任務由你親自執行，不得再轉派給其他 agent」'
          + '（04-delegation-templates.md 回報鏈鐵則）。回報鏈固定一跳——中繼 agent 喚醒後轉送率極低，'
          + '需要多個 agent 時由主對話自己分別派、分別收。請補上後重發同一個 agent。');
      }
      if (reportCount < 1 && !isCTrack) {
        reasons.push('[回報鏈鐵則 2] 派工 prompt 必須寫明回報指示：完成後用 SendMessage(to: main) 回報結論，'
          + '結論送出前不要結束 turn。寫法例：開頭「完成後 SendMessage(to: main) 回報」。請補上後重發同一個 agent。');
      }
    }
    // 【對照表】閘（2026-10-08，03 矩陣 B10）：放在最後，舊有各閘的判定與訊息順序不受影響
    if (ACC_AGENTS.includes(type)) {
      const cg = compareGate(prompt);
      if (cg && !cg.ok) {
        reasons.push('[對照表] 派 ' + type + ' 的任務目標是對齊類（命中：「' + cg.hits.slice(0, 2).map((h) => h.match).join('」「') + '」），'
          + 'prompt 必須含行首的【對照表】格（04 共通規則「對齊類任務」、03 矩陣 B10）。本次：'
          + (cg.bad ? cg.bad.join('；') : '找不到行首的【對照表】標題')
          + '\n   格式（五列，各寫本次的實際內容）：'
          + '\n   【對照表】'
          + '\n   - 來源：A＝<基準側，附路由／檔:行／識別字>；B＝<要對齊的一側，同樣附錨點>'
          + '\n   - 欄位／元素：<兩邊的項目清單怎麼程式化抓（DTO 屬性、匯出表頭、DOM 表頭、enum 值），窮舉不抽樣>'
          + '\n   - 順序：<要比的順序（欄序、排序、判斷順序）；真的無順序可言寫「不適用＋理由」>'
          + '\n   - 值／行為：<逐項要比的值或行為（顯示值、型別、空值、守門）>'
          + '\n   - 差異結論：<每個差異標「已消除」或「刻意保留＋理由」，回報貼回逐項對照表>'
          + '\n   收據：2026-09-15／09-17 四則糾正——照隔壁那支卻漏欄位、Excel 少了歸屬單位多了檔案清單、欄序前後顛倒，都是只目測幾個點就說「對齊了」。'
          + '\n   判斷命中的是一般用語、不是對齊類任務時：向使用者說明並請示，不得為了過閘改寫【目標】措辭。'
          + '請在 prompt 補上後重發同一個 agent。');
      }
    }
  } catch (e) {
    // 不再空 catch（2026-10-04，照 plugin 範本「派工內容檢查故障」）：中途丟例外時，丟出點之後的閘全部沒跑，
    // 舊版卻靜默放行——hook 壞了、派工紀律整段失效都沒人發現。仍 fail-open（不因故障擋派工），
    // 但要讓模型知道哪裡沒檢查到：有其他缺項要擋時併進 deny 理由，沒有時走 additionalContext。
    checkError = e;
  }
  if (reasons.length) {
    // 一次列完所有未過的閘（2026-09-10 改）。原本用單一 reason 變數＋每閘 !reason 短路，
    // 結構上一次只回報一項——派 qa-engineer 要連過 7 道閘，補一項撞一項，實測被連擋 6 次。
    // 擠牙膏式攔截讓「補齊派工單」變成盲目試錯，且每次 deny 都燒一輪 context。
    const head = reasons.length === 1
      ? '[派工紀律] 派工 prompt 有 1 項未過閘，補齊後重發同一個 agent（不得改派其他 agent type 繞過）：'
      : '[派工紀律] 派工 prompt 有 ' + reasons.length + ' 項未過閘，'
        + '**以下全部補齊後一次重發**同一個 agent（不得改派其他 agent type 繞過）。'
        + '⚠ 這是本次的完整清單，不會再有第二批——逐項對照補完再送：';
    const body = reasons.map((r, i) => '\n\n' + (i + 1) + '. ' + r).join('');
    const tail = reasons.length > 1
      ? '\n\n——以上 ' + reasons.length + ' 項為完整清單。範本見 .claude/harness/04-delegation-templates.md 模板六'
        + '（照模板逐格填寫可一次過閘）。'
      : '';
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: head + body + tail + notes.map((n) => '\n\n' + n).join('')
          + (checkError ? '\n\n' + checkErrorNote() : ''),
      },
    }));
  } else if (checkError || notes.length) {
    // 放行但要讓模型知道：PreToolUse 以 exit 0 結束時純文字 stdout 模型看不到，要包成 additionalContext
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse',
        additionalContext: notes.concat(checkError ? [checkErrorNote()] : []).join('\n\n') },
    }));
  }
  process.exit(0);
});
}
// 給 cases/ 的語料校準與單元案例直接呼叫判定函式（同 compact-resume-judge.js 的寫法：被 require 時不讀 stdin）
module.exports = { sectionsOf, judgeScope, judgeAcceptance, scopeTemplateHints, anchorsOf, SCOPE_CELLS, scopeGate, accGate,
  stripTemplateText, judgeReverse, reverseKinds, REVERSE_GROUPS, SCOPE_LEAD, SCOPE_SPLIT, seqSteps, componentCandidates, nameExists, changedSharedFiles,
  flatText, reasonLen, NO_EXEC_HEAD, NO_EXEC_ORDER, goalText, alignHits, alignTrigger, judgeCompare, compareGate };
