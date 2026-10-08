#!/usr/bin/env node
// PreToolUse(Agent|Task)：派「專案 agent」時，派工 prompt 必須帶上該 agent 的紀律標記，
// 缺就一次列完所有缺項並 deny。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Agent|Task", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/check-review-discipline.js\"", "timeout": 15, "statusMessage": "檢查派工單的紀律欄位" }] }]
//
// 背景：派工 prompt 該帶的紀律條款（回報鏈鐵則、驗收條件、回報格式……）若只寫在文件裡、
// 沒有機械檢查，實測會被跳過——派工單漏一項，subagent 照樣開工，缺口要等審查甚至上線
// 才被發現。這支 hook 保證「派工 prompt 有帶紀律條款的文字標記」，另對兩格驗「有沒有作答」（見下），
// 不驗內容對不對、也不驗 agent 有沒有真的照做——執行面仍要靠 agent 定義檔與 skill 正文把關。
//
// 為什麼不能只比對標題（來源專案實際發生過）：只驗「有沒有出現【測試資料來源】這幾個字」時，
// 寫了標題就過——選 a/b/c 哪個、選 b/c 有沒有附理由都不看，等於只擋「完全沒寫」。實測代價是全庫
// 幾十處寫死業務代碼、上百處直接 INSERT 業務主體表造狀態，而那些派工單多半都「有寫這格」；
// 【驗收條件】同理，整段範本貼上、只留佔位 <…> 也能過閘。所以這兩格改為驗作答：
//   【測試資料來源】（DATA_SOURCE_AGENTS）：①這格第一行要寫「選 a／選 b／選 c」（固定格式）
//     ②選 b 要理由點名例外類別（關鍵詞判定，見填空區 DATA_SOURCE_B_CATEGORIES；成本、麻煩、慢都不算）
//       且附產品端證據「檔名:行號」，兩件都要 ③選 c 要附理由（為何屬字典／設定類）
//   【驗收條件】（ACCEPTANCE_BODY_AGENTS）：剝掉範本佔位 <…>、標題後的括號說明、條列符號後不能是空的
// 仍不判「選得對不對」「條件寫得好不好」——那要看程式碼與需求，是審查與 QA 的事。
//
// 打開引用的檔驗章節（DOC_SECTION_RULES）：派實作時【計畫／設計文件】指向一份 .md，就打開它驗必要章節
// （預設：「測試情境表」或「驗證計畫」標題＋簽收狀態句）。只看 prompt 文字的話，設計文件漏產情境表、
// 還沒簽收就交棒，派工單照樣過閘——交棒那一刻驗簽收物本身，比事後審查才發現便宜。
// 指向的檔不存在 → 擋（多半是路徑寫錯或還沒產出，放行的話這道檢查等於沒做）；格裡沒寫 .md 路徑 → 不檢查（見已知取捨）。
// 路徑怎麼取：markdown 連結 `[x](<路徑>)`／`[x](路徑)` 括號裡的 → 引號或反引號包住的（可含空白）→ 其餘第一個 .md 字樣；
// .md 後面帶錨點（`design.md#測試情境表`）時去掉錨點再找檔，章節照整份文件驗
// （沒加引號又含空白時，從 .md 結尾往前延伸、找磁碟上實際存在的檔，例：專案放在「OneDrive - 公司名」底下）。
// Windows 上 Git Bash 寫法 `/c/...` 轉成 `C:/...`。判不準的情況（含空白又找不到實際的檔、`~` 開頭、網址、Windows 上其他
// `/` 開頭的 Git Bash 路徑）不擋：放行並用 additionalContext 提醒這次沒驗到。相對路徑以專案根解析，找法同 guard-qa-before-commit
// （CLAUDE_PROJECT_DIR → 本檔在 <專案根>/.claude/hooks/ 時往上兩層 → payload 的 cwd），session 停在子目錄也不會解析錯。
// 不驗的兩種情況：①【開工前對齊】寫「分流例外」（04 只要求行為類任務交簽收物）
// ②【計畫／設計文件】寫「本次產出：<路徑>」（architect 與 engineer 併一步時，第一次派 engineer 由它產出設計文件，檔還不存在）。
//
// 已知取捨（正常寫法以外的情境，刻意不處理）：
//   · 【開工前對齊】【目標環境】【既有測試分流】只驗標題有沒有寫，整行範本照貼不改也會過——三格的作答形式太自由，
//     要判內容就得猜句型；表態對不對由使用者確認開發計畫時看。
//   · 引用檔只認 .md；寫成其他副檔名、或格裡沒寫路徑，這一項不檢查。
//   · 「分流例外」只認【開工前對齊】作答的開頭；寫在句中（「無分岔，但屬分流例外」）不算，照樣驗文件。
//   · 章節只驗「標題行／句子在不在」，不驗情境表裡有沒有反向路徑、簽收是不是真的有人簽。
//
// 一次列完所有未過的閘（不要一項一項擠牙膏）：若每次只回報一項，補一項撞一項，
// 派一個要連過多道閘的 agent 會被連續擋很多次，而且每次 deny 都燒一輪 context。
//
// 通用化說明：本範本的 REQUIRED_MARKERS 表格對齊 04-delegation-templates.md 的欄位標題——
// 共用四項（回報鏈鐵則、【驗收條件】、【回報格式】、【開工前必讀】，且必讀要寫到 CLAUDE.md、GLOSSARY.md（舊檔名 CONTEXT.md 也認））＋依 agent 角色加碼的欄位
// （實作與 QA 驗【開工前對齊】、QA 另驗【目標環境】【既有測試分流】，見填空區註解）。這是通用骨架的預設表，**不含**任何特定專案自訂的紀律標記（例如某種靜態掃描
// 工具名、某種分流判準、某個環境的 port 對照）——專案要加自己的紀律時，直接在表裡
// 用同樣的形狀加一條（見填空區範例的「如何自加一條」）。
//
// fail-open：解析失敗或任何例外一律放行。派工內容檢查（驗作答那兩格）丟例外時同樣放行，
// 但用 additionalContext 告訴模型「派工內容檢查故障」（已有其他缺項要擋時併進 deny 理由）。

'use strict';

const fs = require('fs');
const path = require('path');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 每個「專案 agent」派工 prompt 必須含的紀律標記表。key 為 agent 名（不含 plugin 前綴），
// `'*'` 是所有專案 agent 共用、每個都要檢查的一組。每條規則：
//   name    — 這條規則的識別名（用於訊息與除錯）
//   pattern — 字串形式的 regex（大小寫不拘），命中即視為「已帶該標記」
//   hint    — 缺這項時給使用者的提示，講清楚該補什麼
//
// 表格對齊 04-delegation-templates.md 的模板欄位標題：
//   共用（'*'）：回報鏈鐵則（「不得轉派」或「親自執行」）、【驗收條件】、【回報格式】、【開工前必讀】，
//     且必讀清單一定要寫到 CLAUDE.md（專案概要）與 GLOSSARY.md（專案用語；舊檔名 CONTEXT.md 也認）——所有角色都要讀
//   架構、實作、審查（backend-architect／backend-engineer／frontend-engineer／code-reviewer）另要寫到 FLOWS.md
//     （觸及已收錄鏈路就列入；沒觸及也寫一句，逼派工的人判斷一次——「有沒有觸及」機械判不了）
//   實作與 QA（backend-engineer／frontend-engineer／qa-engineer）另加【開工前對齊】（04 模板二、三、六；三選一表態，判準見模板五配套 1）
//   QA agent（例：qa-engineer）另加【範圍展開】【測試資料來源】【目標環境】【既有測試分流】，必讀清單要寫到 tests/Project_Detail/PROJECT.md
//   審查型 agent（例：code-reviewer）另加模板四的驗證欄位（【產出路徑】、【驗證方式】）
// 為什麼必讀也要擋：只寫在 agent 檔與 04 範本裡的必讀清單，實測派工時會漏（例：QA 派工沒列測試知識檔），
//   而 subagent 回報時也不會發現自己少讀了什麼。這支 hook 只驗「檔名有寫進 prompt」，有沒有真的讀，
//   靠回報的「已讀清單」與主對話核對（04「派工後的指揮官義務」第 1 條）。
// init 時照 Q1 定案的 agent 名單改 key；裁掉的角色整組刪掉；專案沒有某份知識筆記檔時刪掉對應那條。
//
// 專案要自加一條時，照同樣的形狀加進對應 agent 的陣列（或加進 '*' 讓全部 agent 都要過）：
//   { name: '某工具掃描', pattern: '某工具名', hint: '派工 prompt 必須要求跑 <某工具> 並附輸出' }
// 實作與 QA 共用的【開工前對齊】提示文字（下表三個 agent 的那一條都引用它）。
// name／pattern 刻意在表裡寫成字面量：/harness:review 的收集腳本只用文字解析讀這張表，寫成變數引用它就讀不到這條。
const ALIGN_HINT = '派實作／QA agent 的 prompt 必須含【開工前對齊】表態（04 模板二、三、六），三選一：'
    + '「無分岔＋一句理由」／「已對齊清零（<N> 題）」（模型已提不出新分岔，而且使用者確認過共識）／'
    + '「分流例外：<理由>」（純結構、文案、死碼等讀 code 就能確定等價）。本檢查只驗有沒有表態，判斷由你做。';
const REQUIRED_MARKERS = {
  '*': [
    {
      name: '回報鏈鐵則·禁二次轉派',
      pattern: '不得再?轉派|禁止二次轉派|親自執行',
      hint: '派工 prompt 必須明寫「本任務由你親自執行，不得再轉派給其他 agent」——回報鏈固定一跳，'
        + '需要多個 agent 時由主對話自己分別派、分別收。',
    },
    {
      name: '驗收條件',
      pattern: '【驗收條件】',
      hint: '派工 prompt 必須含【驗收條件】欄位，且每條要可機械判定（能回答「用什麼指令或什麼觀察來判定 PASS/FAIL」）。',
    },
    {
      name: '回報格式',
      pattern: '【回報格式】',
      hint: '派工 prompt 必須含【回報格式】欄位，講清楚回報要包含哪些內容（成果路徑＋關鍵行號＋結論，禁止噴大段代碼）；'
        + '有【開工前必讀】時，回報格式要要求列「已讀清單」。',
    },
    {
      name: '開工前必讀',
      pattern: '【開工前必讀】',
      hint: '派工 prompt 必須含【開工前必讀】：列出這個角色開工前要逐檔 Read 的檔案路徑（見 04-delegation-templates.md 共通規則）。',
    },
    {
      name: '必讀：專案概要',
      pattern: 'CLAUDE\\.md',
      hint: '【開工前必讀】要列 CLAUDE.md 的「專案概要」一節（這個專案在做什麼、哪個環境是正式、做到哪）。',
    },
    {
      name: '必讀：專案用語',
      pattern: 'GLOSSARY\\.md|CONTEXT\\.md',
      hint: '【開工前必讀】要列專案的詞彙表（專案用語的定義；需求裡的詞以它為準）：只寫專案實際用的那一個檔名——GLOSSARY.md，或沿用舊檔名的專案寫 CONTEXT.md；兩個都沒有就寫「GLOSSARY.md：專案沒有這個檔」。',
    },
  ],
  'backend-architect': [
    {
      name: '必讀：跨模組鏈路',
      pattern: 'FLOWS\\.md',
      hint: '【開工前必讀】要寫到 FLOWS.md：本需求觸及已收錄鏈路就列入必讀；沒觸及也要寫一句「FLOWS.md：沒觸及已收錄鏈路」，'
        + '讓派工的人當場判斷過一次。',
    },
  ],
  'backend-engineer': [
    {
      name: '必讀：跨模組鏈路',
      pattern: 'FLOWS\\.md',
      hint: '【開工前必讀】要寫到 FLOWS.md：本需求觸及已收錄鏈路就列入必讀；沒觸及也要寫一句「FLOWS.md：沒觸及已收錄鏈路」，'
        + '讓派工的人當場判斷過一次。',
    },
    { name: '開工前對齊', pattern: '【開工前對齊】', hint: ALIGN_HINT },
  ],
  'frontend-engineer': [
    {
      name: '必讀：跨模組鏈路',
      pattern: 'FLOWS\\.md',
      hint: '【開工前必讀】要寫到 FLOWS.md：本需求觸及已收錄鏈路就列入必讀；沒觸及也要寫一句「FLOWS.md：沒觸及已收錄鏈路」，'
        + '讓派工的人當場判斷過一次。',
    },
    { name: '開工前對齊', pattern: '【開工前對齊】', hint: ALIGN_HINT },
  ],
  'qa-engineer': [
    { name: '開工前對齊', pattern: '【開工前對齊】', hint: ALIGN_HINT },
    {
      name: '目標環境',
      pattern: '【目標環境】',
      hint: '派 QA agent 的 prompt 必須含【目標環境】（04 模板六）：預設環境填一行帶過即可；切到其他環境時寫明網址、後端、身分來源'
        + '——站台寫錯是在派工那一刻發生的，逼派工的人寫出來最容易當場抓到。',
    },
    {
      name: '既有測試分流',
      pattern: '【既有測試分流】',
      hint: '派 QA agent 的 prompt 必須含【既有測試分流】（04 模板六），二選一：「reuse：<要改的既有 test 檔絕對路徑>」'
        + '（變更落在既有案例接得住的範圍，只加斷言或參數化）／「新 TC：<一句理由說明為何既有案例接不住>」。',
    },
    {
      name: '範圍展開',
      pattern: '【範圍展開】',
      hint: '派 QA agent 的 prompt 必須含【範圍展開】：至少涵蓋正向路徑、反向／終止分支、狀態序列、'
        + '受影響的共用元件四格；封閉的 TC 清單是最常見的失敗形狀——指揮官漏想的情境，QA 結構上不會補。',
    },
    {
      name: '測試資料來源',
      pattern: '【測試資料來源】',
      hint: '派 QA agent 的 prompt 必須含【測試資料來源】：表明測試資料怎麼來（走真實業務流程／封閉例外／'
        + '依賴既有字典資料），並說明理由；禁止硬編業務 Id 或使用者身分當輸入。',
    },
    {
      name: '必讀：測試知識',
      pattern: 'tests[\\\\/]Project_Detail[\\\\/]PROJECT\\.md',
      hint: '【開工前必讀】要列 tests/Project_Detail/PROJECT.md（本專案測試時踩過的坑、測試環境位址與測試設計知識）；專案沒有這個檔就寫「tests/Project_Detail/PROJECT.md：專案沒有這個檔」。',
    },
  ],
  'code-reviewer': [
    {
      name: '產出路徑',
      pattern: '【產出路徑】',
      hint: '派審查型 agent 的 prompt 必須含【產出路徑】：列出要驗證的產出檔案絕對路徑清單。',
    },
    {
      name: '驗證方式',
      pattern: '【驗證方式】',
      hint: '派審查型 agent 的 prompt 必須含【驗證方式】：講清楚審查者要怎麼驗（重新 Read 產出檔、跑哪些指令），'
        + '審查者的預設立場是「不相信它完成了，找證據」。',
    },
    {
      name: '必讀：跨模組鏈路',
      pattern: 'FLOWS\\.md',
      hint: '【開工前必讀】要寫到 FLOWS.md：改動觸及已收錄鏈路時，審查要確認鏈路其他層有沒有同步；沒觸及也要寫一句「FLOWS.md：沒觸及已收錄鏈路」。',
    },
  ],
};

// 派工內容檢查（見檔頭「為什麼不能只比對標題」）。名單用 agent 名（不含 plugin 前綴）；'*'＝表中所有專案 agent。
// 只在該格標題存在時驗內容——標題整個沒寫，由上面的標記表報缺，不重複報。
// 【驗收條件】要有實際內容的 agent。
const ACCEPTANCE_BODY_AGENTS = ['*'];
// 【測試資料來源】要驗作答的 agent（通常只有 QA agent；Q1 裁掉 QA 時清空）。
const DATA_SOURCE_AGENTS = ['qa-engineer'];
// 【測試資料來源】選 b 時，理由要點名的例外類別（04 模板六 b：封閉例外，類別增減只能由使用者裁定）。
// 每條是字串形式的 regex（大小寫不拘），作答段命中任一條即算「點名了例外類別」；一條都沒命中 → 擋。
// 預設對齊 04 模板六 b 的「上游系統推送的資料、產品本身沒有建立入口」。init 時照專案 04 模板六 b 實際列的類別改，
// 專案另有類別（例：某外部系統回呼才產生的資料）就照同樣的形狀加一條；04 的類別改了，這張表要同步改，否則照新類別寫的 b 會被擋。
// 判準是白名單：只認點名例外類別，不靠列舉推託詞——推託講法列不完（來源專案黑名單連三輪審查每修一種句型就漏另一種）。
// 只驗「有沒有點名類別」，不驗那筆資料是不是真的屬於該類別——真假靠同時要附的「檔名:行號」證據與審查。
const DATA_SOURCE_B_CATEGORIES = [
  '上游[^，,。；;\\n]{0,20}推送',
  '外部系統[^，,。；;\\n]{0,20}推送',
  '(?:沒有|沒|無|没有)[^，,。；;\\n]{0,8}建立入口',
];
// 常見的非理由（04 模板六 b 列明不是理由）：只用來讓擋下訊息說得更準，**不參與放行判定**——
// 沒點名例外類別一律擋，有沒有命中這張表都一樣；同時點名了例外類別則放行（類別成立與否由證據與審查判）。
const DATA_SOURCE_B_NON_REASONS = [
  '成本',
  '麻煩',
  '慢|耗時|比較快|較快|省時|省事',
  '精確控制|資料形狀',
  '歷史相容',
];

// 打開引用的檔驗章節（見檔頭）。每條規則：
//   name     — 識別名（訊息用）
//   field    — 欄位標題的 regex 字串；預設對齊 04 模板二的【計畫／設計文件】（也認【設計文件】）
//   agents   — 適用的 agent 名（不含 plugin 前綴）；prompt 沒有這格就不檢查
//   sections — 引用檔裡必須有的東西：{ name, pattern（regex 字串，多行模式：^ 對齊每一行行首）, hint }
// 引用路徑（resolveDocRef）：格內依序取 markdown 連結 [x](<路徑>)／[x](路徑) 括號裡的 → 引號或反引號包住的（三者都容許 .md#錨點，找檔時去掉錨點）→
// 沒包起來的第一個 .md 字樣（含空白時從 .md 往前延伸，找磁碟上實際存在的檔）。Windows 上 /c/… 轉成 C:/…。
// 相對路徑以專案根解析（projectRoot：CLAUDE_PROJECT_DIR → 本檔在 <專案根>/.claude/hooks/ 時往上兩層 → payload 的 cwd）。
// 引用檔不存在 → 擋；格裡沒寫 .md 路徑、【開工前對齊】開頭是「分流例外」、格裡寫「本次產出：」→ 不檢查；
// 路徑判不準（含空白又找不到實際的檔、~ 開頭、網址、Windows 上對不到的 / 開頭路徑）→ 不擋，用 additionalContext 提醒。agents 照 Q1 定案的實作／審查 agent 名改；
// 04 模板五「簽收物」的格式改了（例：標題改叫別的名字），sections 要同步改，否則照新格式寫的文件會被擋。
const DOC_SECTION_RULES = [
  {
    name: '設計文件',
    field: '【[^】\\n]*設計文件[^】\\n]*】',
    agents: ['backend-engineer', 'frontend-engineer', 'code-reviewer'],
    sections: [
      {
        name: '測試情境表或驗證計畫標題',
        pattern: '^[ \\t]*#{1,6}[^\\n]*(?:情境表|驗證計畫)',
        hint: '大案要有一個 markdown 標題行寫「測試情境表」（例：`## 測試情境表`）；小案寫「驗證計畫」（04 模板五「簽收物」）',
      },
      {
        name: '簽收狀態句',
        pattern: '待簽收|已簽收',
        hint: '文件裡要寫簽收狀態：「狀態：待簽收」，使用者確認後改成「已簽收（<誰>，<日期>）」',
      },
    ],
  },
];
// ────────────────────────────────────────────────────────────────────────────

// 取「【標題】」之後、到下一格標題之前的內容當作該格的作答區；沒有這格回 null。
// 「下一格標題」＝換行後緊接的【…】（行首可有空白與 markdown 記號 > * _ # -，例：「**【回報格式】**」「- 【範圍展開】」）。
// 不切在任意「【」：作答內容常引用別處（「選 b：見【規格】src/x.py:3」），切在那裡會把證據切掉而誤擋。
// 不用已知標題清單：04 模板的欄位標題都寫在行首，而專案自加的欄位不必回頭維護清單；
// 已知限制：作答內容自己有一行以「【」開頭時會被當成下一格（把引用寫在行中即可）。
function fieldSegment(prompt, title) {
  // 先找出現在行首的標題（前面只能是空白與 markdown 記號）：前文在句子中間提到「依下方【測試資料來源】造」時，
  // 取第一次出現會切到那一句，底下照格式作答也被判沒作答。沒有行首的才退回第一次出現。
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp('(?:^|\\n)[ \\t>*_#-]*' + esc).exec(prompt);
  const i = head ? head.index + head[0].length - title.length : prompt.indexOf(title);
  if (i < 0) return null;
  const rest = prompt.slice(i + title.length);
  const next = /\n[ \t>*_#-]*【/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
// 範本佔位（<…>，可巢狀）由內往外剝到沒有變化為止：佔位裡的示範文字不算作答
function stripPlaceholders(s) {
  let out = String(s);
  for (;;) {
    const next = out.replace(/<[^<>]*>/g, ' ');
    if (next === out) return out;
    out = next;
  }
}
// 04 範本在標題同一行附了括號說明（「【驗收條件】（逐條判定）」「【測試資料來源】（必填，三選一…）」），不算作答
// 剝掉標題後面的括號說明。說明裡可能還有一層括號（「…附「檔名:行號」（說明為何…），選 c…」），
// 只剝到第一個右括號的話，剩下半句會被當成作答——照範本正確作答也被擋。所以數括號深度，剝到配對的那個為止
function dropHeadingNote(seg) {
  const m = /^[ \t]*[（(]/.exec(seg);
  if (!m) return seg;
  let depth = 0;
  for (let i = m[0].length - 1; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\n') return seg;   // 說明沒在同一行收尾：不剝，照原樣判
    if (c === '（' || c === '(') depth++;
    else if ((c === '）' || c === ')') && --depth === 0) return seg.slice(i + 1);
  }
  return seg;
}

function acceptanceIsEmpty(prompt) {
  const seg = fieldSegment(prompt, '【驗收條件】');
  if (seg === null) return false;   // 沒有這格由標記表報
  const body = stripPlaceholders(dropHeadingNote(seg)).split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•>]+|[\d０-９]+[.)、．）])\s*/, '')).join('');
  return body.replace(/[\s\p{P}\p{S}]/gu, '') === '';
}

// 回缺失訊息陣列（空＝通過）
function dataSourceProblems(prompt) {
  const raw = fieldSegment(prompt, '【測試資料來源】');
  if (raw === null) return [];      // 沒有這格由標記表報
  const seg = stripPlaceholders(dropHeadingNote(raw));
  const COMMON = '（04-delegation-templates.md 模板六）該格**第一行開頭**寫「選 a」「選 b」或「選 c」，後面接理由：'
    + 'a 走真實業務流程長出來（首選）；b 封閉例外（只限 04 模板六 b 列的例外類別，例：上游系統推送的資料；成本過高不是理由），要附為何不走 a 所根據的產品端證據「檔名:行號」'
    + '（例：上游推送的唯一寫入點、擋住入口的守門）；c 依賴既有資料，僅限字典／設定類，要說明為何屬這類。'
    + '範本裡 a./b./c. 的說明與 ⛔ 清單可以留著，但作答要寫在它們前面。請在 prompt 補上後重發同一個 agent。';

  // 作答段：第一個非空行起，到空行、或到以「a. b. c.」「（」「⛔」開頭的說明行為止。
  // 範本在同一格下方附 a/b/c 說明與 ⛔ 清單，裡面有「檔名:行號」樣的字，不得頂替作答
  // （來源專案實際發生過：整段範本貼上、只填「選 b，理由：比較快」就放行）。
  const answer = (() => {
    const out = [];
    for (const l of seg.split(/\r?\n/)) {
      if (!out.length) { if (l.trim() !== '') out.push(l); continue; }
      if (l.trim() === '' || /^\s*(?:\**\s*[abc]\**\s*[.．、)）](?![A-Za-z0-9@\[][\w.\-/@\[\]+~]*(?:[:：]|#L)\d)|[（(]|⛔)/i
        .test(l.replace(/^[\s_`#>\-：:]+/, ''))) break;
      out.push(l);
    }
    return out.join('\n');
  })();

  // 選項判定——固定格式：第一行開頭必須是「選 a」「選 b」「選 c」（「選擇：a」「選用 b」也算）。
  // 自由文字的判法在來源專案試過五種（字母＋說明詞、否定詞清單、成對否定、第一子句、選字族優先），每一種都有新破口
  // （「不用 a，選 b」判成 a、「本案可從畫面造出，選 a」判成沒選），故不再猜。
  const picked = (() => {
    const head = /^選(?:擇|用)?\s*[:：]?\s*([abc])(?![A-Za-z0-9])/i;
    const lines = seg.split(/\r?\n/)
      .map((l) => l.replace(/^[\s*_`#>\-：:]+/, '').replace(/^[\d０-９]+[.)、．）]\s*/, '').trim()).filter((l) => l !== '');
    if (!lines.length) return null;
    const m = head.exec(lines[0]);
    if (!m) return null;
    const L = m[1].toLowerCase();
    // 第一句同時提到別的選項（「選 a 或 b」）不算明選
    const rest = lines[0].slice(m[0].length).split(/[，,。；;：:（(]/)[0];
    if (['a', 'b', 'c'].some((x) => x !== L && new RegExp('(^|[^A-Za-z0-9])' + x + '($|[^A-Za-z0-9])', 'i').test(rest))) return null;
    // 同一行後面又寫了另一個「選 X」（「選 a，選 b」）也不算明選
    const again = /選(?:擇|用)?\s*[:：]?\s*([abc])(?![A-Za-z0-9])/gi;
    let k;
    while ((k = again.exec(lines[0].slice(m[0].length))) !== null) if (k[1].toLowerCase() !== L) return null;
    // 後面又出現另一個「選 X」（前後矛盾）也不算
    if (lines.slice(1).some((l) => { const k = head.exec(l); return k && k[1].toLowerCase() !== L; })) return null;
    return L;
  })();

  if (!picked) {
    // 沒選之前談「缺理由／缺證據」沒有意義，但補完選項後可能再撞那兩項——訊息先講明，不讓人以為補完這項就結束
    return ['[測試資料來源·未明選] prompt 有【測試資料來源】這格，但沒看到明確選了 a／b／c 哪一個。寫標題不算表態；'
      + '先寫說明、後面才表態，或第一句同時提到兩個選項，都不算。⚠ 選 b 或 c 的話請一併附上證據／理由，'
      + '否則補完選項會再撞一次「缺證據／缺理由」——這兩項在邏輯上有先後，不是漏報。' + COMMON];
  }
  const out = [];
  if (picked === 'b') {
    // 只認作答段裡的「檔名:行號」（或 檔名#L行號）；推託詞不列舉，改要求看過產品程式碼的證據
    const EVIDENCE = /[\w\u4e00-\u9fff./\\@\[\]+~-]+\.(?:cs|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|java|kt|go|rb|php|sql|rs|swift|dart|scala|sh|ps1|json|ya?ml|xml|c|h|cc|cpp|hpp|m|ex|exs|html|cshtml|razor)(?:[:：]|#L)\d+/;
    // 兩件事都要過、各自獨立報（一次列完）：①理由點名例外類別（DATA_SOURCE_B_CATEGORIES）②附「檔名:行號」證據。
    // 只驗證據的話，「選 b，理由：真流程成本過高，證據 src/x.cs:88」會放行——證據隨便指一行程式就湊得出來，理由才是 04 b 封閉的那一半。
    const hit = (list) => list.find((p) => new RegExp(p, 'i').test(answer));
    if (!hit(DATA_SOURCE_B_CATEGORIES)) {
      const nonReason = hit(DATA_SOURCE_B_NON_REASONS);
      const said = nonReason ? (new RegExp(nonReason, 'i').exec(answer) || [''])[0] : '';
      out.push('[測試資料來源·非例外] （只讀作答段：第一行起到空行，或到以 a./b./c.／（／⛔ 開頭的說明行為止）選了 b，'
        + '但理由沒有點名是哪一類例外。04 模板六 b 是封閉例外：只限例外類別（預設：上游系統推送的資料、產品本身沒有建立入口），'
        + (said ? '理由裡的「' + said + '」不屬於例外類別——' : '')
        + '成本過高、跨模組麻煩、跑一輪很慢、要精確控制資料形狀、歷史相容性都不是理由，一律走 a，不論成本。'
        + '確實屬於例外類別的話，在理由裡點名是哪一類（本閘以關鍵詞判類別，例：「上游系統推送」「產品沒有建立入口」）。' + COMMON);
    }
    if (!EVIDENCE.test(answer)) {
      out.push('[測試資料來源·缺證據] （只讀作答段：第一行起到空行，或到以 a./b./c.／（／⛔ 開頭的說明行為止）選了 b，'
        + '但沒附產品端證據：寫出「為何不走真實流程」所根據的程式位置「檔名:行號」（上游推送的唯一寫入點、擋住入口的守門、'
        + '真流程要經過的那幾個入口）。沒去看產品程式碼就主張走不了真流程，多半是誤判。' + COMMON);
    }
  }
  if (picked === 'c') {
    // 理由要真的寫出內容：出現字典／設定類字眼即算；否則取「理由／因為／原因」後面的文字，刪掉佔位詞與全部空白、標點、符號，
    // 剩下至少 2 個字才算（不列舉句型——列舉「佔位＋其後結束」的 regex 在來源專案連兩輪都漏）
    const hasReason = (() => {
      if (/字典|設定類|設定|主檔/.test(answer)) return true;
      const m = /理由|因為|原因|why|because|reason(?![A-Za-z])/i.exec(answer);
      if (!m) return false;
      return answer.slice(m.index + m[0].length)
        .replace(/待補[充中上齊]?|待確認|待定|之後再補|之後補|稍後補|再補|後補|之後|稍後|同上|沒有|無|(?<![A-Za-z])(?:(?:TBD)+|TODO|N\/?A|none|OK)(?![A-Za-z])|\.{2,}|…+/gi, '')
        .replace(/[\s\p{P}\p{S}]/gu, '').length >= 2;
    })();
    if (!hasReason) {
      out.push('[測試資料來源·缺理由] （只讀作答段）選了 c 但沒附理由：說明「為何屬字典／設定類」——業務資料列一律不得走 c。'
        + '一句話即可，但要寫。' + COMMON);
    }
  }
  return out;
}

// 專案根（相對路徑的解析基準）：與 guard-qa-before-commit 的 projectRoot 同一個找法。
// CLAUDE_PROJECT_DIR 不保證存在；沒有時先用「本檔在 <root>/.claude/hooks/」推回去，payload 的 cwd 排最後——
// session 停在子目錄時 cwd 是子目錄，拿它解析相對路徑會把存在的設計文件判成找不到而誤擋。
function projectRoot(input) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  if (path.basename(__dirname) === 'hooks' && path.basename(path.dirname(__dirname)) === '.claude') return path.resolve(__dirname, '..', '..');
  return (input && input.cwd) || path.resolve(__dirname, '..', '..');
}

// 【開工前對齊】作答的開頭是「分流例外」：純結構／文案／死碼等非行為類任務，04 不要求交簽收物
function isTriageException(prompt) {
  const seg = fieldSegment(prompt, '【開工前對齊】');
  if (seg === null) return false;
  const first = stripPlaceholders(dropHeadingNote(seg)).split(/\r?\n/)
    .map((l) => l.replace(/^[\s>*_#\-：:]+/, '').trim()).find((l) => l !== '');
  return !!first && /^分流例外/.test(first);
}

// 路徑寫法本身判不準的先擋在外面（只提醒、不擋）：~ 開頭的家目錄、網址、Windows 上對不到的 Git Bash 路徑。
// 這幾種若照相對路徑接在專案根後面，必然「找不到檔」而誤擋。回 { p } 或 { unsure: '原因' }
function nativePath(raw) {
  if (/^~(?:[\\/]|$)/.test(raw)) return { unsure: '「' + raw + '」是 ~ 開頭的家目錄寫法，hook 不展開' };
  if (/^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(raw)) return { unsure: '「' + raw + '」是網址，不是本機檔案' };
  if (process.platform !== 'win32') return { p: raw };
  // Windows 上的 Git Bash 寫法：/c/... → C:/...；其他 / 開頭的路徑（/tmp/...）對不到 Windows 路徑
  const g = /^\/([A-Za-z])(\/.*)?$/.exec(raw);
  if (g) return { p: g[1].toUpperCase() + ':' + (g[2] || '/') };
  if (/^\/(?!\/)/.test(raw)) return { unsure: '「' + raw + '」是 Git Bash 的路徑寫法，對不到 Windows 路徑' };
  return { p: raw };
}
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// 從欄位作答（原文，還沒剝範本佔位）取出 .md 路徑、解析成本機絕對路徑。
// 回 { p, exists } 或 { unsure: '原因' }（判不準，不檢查）或 null（沒寫路徑）。取法依序：
//   ① markdown 連結的角括號寫法 [x](<路徑>)：markdown 用角括號包含空白的路徑，要在剝範本佔位 <…> 之前取，否則整段被剝掉
//   ② markdown 連結 [x](路徑)：取括號裡的（連結文字常只是檔名）
//   ③ 引號／反引號包住的：可以含空白
//   ④ 沒包起來的第一個 .md 字樣：可能是含空白路徑的後半段，從 .md 結尾往前一次多延伸一段（空白前的字），
//      最長的先試，找磁碟上實際存在的檔；都找不到，而前一段長得像路徑（含斜線或磁碟代號）→ 判不準；否則照字樣判「找不到檔」
function resolveDocRef(rawSeg, baseDir) {
  const toAbs = (raw) => { const np = nativePath(String(raw).trim()); return np.unsure ? np : { p: path.resolve(baseDir, np.p) }; };
  // 三種包起來的寫法都容許 .md 後面接錨點（#章節）：錨點只指到檔內位置，找檔時去掉，章節仍照整份文件驗
  let m = /\]\(\s*<([^<>\n]+?\.md)(?:#[^<>\n]*)?>\s*(?:"[^"\n]*")?\s*\)/i.exec(rawSeg);
  const seg = stripPlaceholders(rawSeg);
  if (!m) m = /\]\(\s*([^()<>\n]*?\.md)(?:#[^()\s]*)?\s*(?:"[^"\n]*")?\s*\)/i.exec(seg);
  if (!m) m = /["'`“「]([^"'`”」\n]*?\.md)(?:#[^"'`”」\n]*)?["'`”」]/i.exec(seg);
  if (m) { const r = toAbs(m[1]); return r.unsure ? r : { p: r.p, exists: isFile(r.p) }; }
  m = /[^\s<>《》【】"'`（）()，,；;、：|]+\.md(?![A-Za-z0-9_])/i.exec(seg);
  if (!m) return null;
  const lineStart = seg.lastIndexOf('\n', m.index) + 1;
  const line = seg.slice(lineStart, m.index + m[0].length);
  const tokenAt = m.index - lineStart;
  // 候選起點：行內每一段非空白字的開頭（到 .md 字樣本身為止），由最長往短試
  const starts = [];
  for (let k = 0; k < tokenAt; k++) if (!/\s/.test(line[k]) && (k === 0 || /\s/.test(line[k - 1]))) starts.push(k);
  for (const k of starts) {
    const r = toAbs(line.slice(k));
    if (!r.unsure && isFile(r.p)) return { p: r.p, exists: true };
  }
  const prev = (/(\S+)[ \t]+$/.exec(line.slice(0, tokenAt)) || [])[1];
  const r = toAbs(m[0]);
  if (r.unsure) return r;
  if (isFile(r.p)) return { p: r.p, exists: true };
  if (prev && /[\\/]|^[A-Za-z]:/.test(prev)) {
    return { unsure: '看起來含空白（「' + line.slice(starts.length ? starts[0] : tokenAt).trim() + '」），往前延伸也找不到磁碟上實際存在的檔，判不準從哪裡開始' };
  }
  return { p: r.p, exists: false };
}

// 打開引用的檔驗章節（DOC_SECTION_RULES）。回 { out: 缺失訊息, notes: 判不準而沒驗的提醒 }；
// 讀檔等非預期錯誤往外丟，由呼叫端 fail-open。
function docSectionProblems(prompt, type, baseDir) {
  const out = [];
  const notes = [];
  if (isTriageException(prompt)) return { out, notes };   // 分流例外：不要求簽收物
  for (const rule of DOC_SECTION_RULES) {
    if (!rule.agents.includes(type)) continue;
    // 標題取法同 fieldSegment：優先行首的那個，沒有才取第一次出現；作答區到下一個行首【…】為止
    const head = new RegExp('(?:^|\\n)[ \\t>*_#-]*(' + rule.field + ')').exec(prompt)
      || new RegExp('(' + rule.field + ')').exec(prompt);
    if (!head) continue;                                 // 沒有這格：不檢查
    const rest = prompt.slice(head.index + head[0].length);
    const next = /\n[ \t>*_#-]*【/.exec(rest);
    const rawSeg = next ? rest.slice(0, next.index) : rest;
    // architect 與 engineer 併一步：這次由它產出，檔還不存在（範本佔位裡的「本次產出」字樣剝掉後才判，照貼範本不算）
    if (/本次產出/.test(stripPlaceholders(rawSeg))) continue;
    const ref = resolveDocRef(rawSeg, baseDir);
    if (!ref) continue;                                  // 沒寫 .md 路徑：不檢查（見檔頭已知取捨）
    if (ref.unsure) {
      notes.push(`[${rule.name}·沒驗到] ${head[1]} 的路徑${ref.unsure}，這次沒打開文件驗章節（這一項不擋）。`
        + '請改寫成加引號的絕對路徑（例："C:/My Docs/design.md"），或自行確認文件有必要章節。');
      continue;
    }
    const p = ref.p;
    if (!ref.exists) {
      out.push(`[${rule.name}·找不到檔] ${head[1]} 指向的 ${p} 不存在（相對路徑以專案根 ${baseDir} 解析）。`
        + '路徑寫錯就改成絕對路徑；還沒產出就先產出、經使用者簽收再派。請在 prompt 補上後重發同一個 agent。');
      continue;
    }
    const doc = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    const missing = rule.sections.filter((s) => !new RegExp(s.pattern, 'm').test(doc));
    if (missing.length) {
      out.push(`[${rule.name}·缺章節] ${p} 缺：` + missing.map((s) => `「${s.name}」（${s.hint}）`).join('；')
        + '——簽收物不完整不得交棒下游。補齊文件後重發同一個 agent（改的是文件，不是 prompt）。');
    }
  }
  return { out, notes };
}

let raw = '';
let contentCheckError = null;
const notes = [];   // 不擋、但要讓模型知道的提醒（例：設計文件路徑判不準而沒驗）
function contentCheckNote() {
  return '[派工紀律] ⚠ 派工內容檢查故障（' + (contentCheckError && contentCheckError.message)
    + '）：【驗收條件】有沒有寫內容、【測試資料來源】有沒有作答、引用的設計文件章節齊不齊，這次可能沒檢查到，已放行（標記表的檢查照常）。'
    + '請自行確認這幾項；hook 鏽蝕要修（.claude/hooks/check-review-discipline.js），勿靜默忽略。';
}
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const reasons = [];
  try {
    const input = JSON.parse(raw);
    const ti = input.tool_input || {};
    // plugin 安裝時 agent 名可能帶前綴（"plugin:agent"），剝掉前綴再比對。
    const type = String(ti.subagent_type || '').split(':').pop();
    const prompt = String(ti.prompt || '');

    const rulesForType = (REQUIRED_MARKERS[type] || []);
    const commonRules = (REQUIRED_MARKERS['*'] || []);
    // 只有「表中有列出的 agent 名」才視為專案 agent 並套共用規則；未列出的（例如
    // general-purpose、Explore 這類內建通用 agent）不受本閘管轄。
    const isManaged = Object.prototype.hasOwnProperty.call(REQUIRED_MARKERS, type);
    const rules = isManaged ? [...commonRules, ...rulesForType] : [];

    for (const rule of rules) {
      const re = new RegExp(rule.pattern, 'i');
      if (!re.test(prompt)) {
        reasons.push(`[${rule.name}] ${rule.hint} 請在 prompt 補上後重發同一個 agent，不得改派其他 agent type 繞過本檢查。`);
      }
    }
    // 派工內容檢查：標題在、但沒作答（見檔頭）。
    // 自己包一層 try：這段丟例外時放行（fail-open），但要讓模型知道這項沒檢查到——
    // 包在外層空 catch 裡的話會靜默放行，hook 壞了沒人發現。
    const inList = (list) => isManaged && (list.includes('*') || list.includes(type));
    try {
      if (inList(ACCEPTANCE_BODY_AGENTS) && acceptanceIsEmpty(prompt)) {
        reasons.push('[驗收條件·沒寫內容] 【驗收條件】只有標題、或只剩範本佔位 <…>：逐條列出可機械判定的 PASS/FAIL 條件，'
          + '每一條都要答得出「用什麼指令或什麼觀察來判定」（04 共通規則）。請在 prompt 補上後重發同一個 agent。');
      }
      if (inList(DATA_SOURCE_AGENTS)) reasons.push(...dataSourceProblems(prompt));
      if (isManaged) {
        const doc = docSectionProblems(prompt, type, projectRoot(input));
        reasons.push(...doc.out);
        notes.push(...doc.notes);
      }
    } catch (e) {
      contentCheckError = e;
    }
  } catch (e) {}

  if (reasons.length) {
    const head = reasons.length === 1
      ? '[派工紀律] 派工 prompt 有 1 項未過閘，補齊後重發同一個 agent（不得改派其他 agent type 繞過）：'
      : '[派工紀律] 派工 prompt 有 ' + reasons.length + ' 項未過閘，'
        + '**以下全部補齊後一次重發**同一個 agent（不得改派其他 agent type 繞過）。'
        + '⚠ 這是本次的完整清單，不會再有第二批——逐項對照補完再送：';
    const body = reasons.map((r, i) => '\n\n' + (i + 1) + '. ' + r).join('');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: head + body + (contentCheckError ? '\n\n' + contentCheckNote() : '')
          + notes.map((n) => '\n\n' + n).join(''),
      },
    }));
  } else if (contentCheckError || notes.length) {
    // 放行但要讓模型知道：PreToolUse 以 exit 0 結束時純文字 stdout 模型看不到，要包成 additionalContext
    const ctx = (contentCheckError ? [contentCheckNote()] : []).concat(notes).join('\n\n');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx },
    }) + '\n');
  }
  process.exit(0);
});
