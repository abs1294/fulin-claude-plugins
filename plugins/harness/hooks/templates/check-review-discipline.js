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
// 才被發現。這支 hook 保證「派工 prompt 有帶紀律條款的文字標記」，另對三格驗「有沒有作答」、
// 對齊類任務驗【對照表】（見下），不驗內容對不對、也不驗 agent 有沒有真的照做——執行面仍要靠 agent 定義檔與 skill 正文把關。
//
// 為什麼不能只比對標題（來源專案實際發生過）：只驗「有沒有出現【測試資料來源】這幾個字」時，
// 寫了標題就過——選 a/b/c 哪個、選 b/c 有沒有附理由都不看，等於只擋「完全沒寫」。實測代價是全庫
// 幾十處寫死業務代碼、上百處直接 INSERT 業務主體表造狀態，而那些派工單多半都「有寫這格」；
// 【驗收條件】同理，整段範本貼上、只留佔位 <…> 也能過閘。所以這兩格改為驗作答：
//   【測試資料來源】（DATA_SOURCE_AGENTS）：①這格第一行要寫「選 a／選 b／選 c」（固定格式）
//     ②選 b 要寫「例外類別：<類別名>」（固定格式，類別名見填空區 DATA_SOURCE_B_LABELS；成本、麻煩、慢都不算）
//       且附產品端證據「檔名:行號」，兩件都要 ③選 c 要附理由（為何屬字典／設定類）
//   【驗收條件】（ACCEPTANCE_BODY_AGENTS）：剝掉範本佔位 <…>、標題後的括號說明、條列符號後不能是空的
//   【範圍展開】（SCOPE_AGENTS）：模板六【回報格式】自己就寫著「【範圍展開】逐格回報」，只驗字樣的話整段不寫也過閘。
//     改為：①只認行首標題 ②依格名切出四格（SCOPE_CELLS），每格剝掉佔位 <…>、04 模板六的說明原文（執行時讀
//     SCOPE_TEMPLATE_DOC）與本閘的格說明後要有實際作答 ③「無／不適用」要附理由（拿掉空詞與填充詞後至少剩 2 個字；
//     理由寫在括號裡也算）。04 讀不到時只剝本閘的格說明，並用 additionalContext 告知，不靜默。
//     ④有作答的格再判內容品質（SCOPE_QUALITY，純機械判準、不用模型）：正向路徑至少 N 個具體錨點且不能全是數字；
//     反向／終止分支的每一種都要交代（以分支名開頭寫怎麼觸發，或寫不適用＋理由；「其餘皆不適用：理由」可一句帶過沒點名的）；
//     狀態序列至少 M 步（箭頭串、條列、序詞、「N 次」），寫不適用要附理由；任兩格內容實質相同（照貼同一段）也擋。
//     來源實例的經驗：只驗「有沒有作答」時，每格填 xx、見附件、一句空泛句都過——派工單的內容品質要在交棒那一刻機械擋，
//     不能靠審查的人判斷。數字與分支種類是專案參數（填空區）。
// 仍不判「選得對不對」「條件寫得好不好」「錨點真不真」——那要看程式碼與需求，是審查與 QA 的事。
//
// 對齊類任務的【對照表】（COMPARE_AGENTS）：任務目標是「比照／照搬／跟 X 一樣／與 X 一致／對齊 X／兩邊一致」時，
// 只要求「列出差異」的話，實測會目測幾個點就說「對齊了」——漏欄位、欄序顛倒、多一欄都看不出來（03 矩陣 B10）。
// 所以要求行首【對照表】格五列都有內容：來源（兩邊各是什麼）、欄位／元素、順序、值／行為、差異結論，且來源兩側各有錨點。
// 觸發只看任務目標（行首【目標】【任務】【目的】段；沒有就看 Markdown「# 目標」段；再沒有就看開頭段），而且要「對齊動詞＋基準側」：
// 全文掃描會撞上【開工前對齊】、驗收條件裡的「與 DB 一致」這類一般用語。基準側是共識、慣例、版面、改動前後時不算
// （「已與使用者對齊」「照慣例」「靠左對齊」「與改動前相同」），「畫面的欄位都有在 Excel 裡？」這類沒有動詞的問句也不觸發。
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
//   · 【範圍展開】【對照表】的標題只認行首：整段寫在句中（「…。【範圍展開】正向…」）會被當成沒寫而擋；
//     格內出現行首的【…】會提早結束該段，該格被判空白。
//   · 【對照表】觸發只看任務目標：對齊要求只寫在【背景】【驗收條件】的派工單不觸發；
//     只驗五列有內容、來源兩側有錨點，不驗列出的項目是否窮舉——窮舉與否靠回報的逐項對照表對帳。
//   · 錨點只驗「長得具體」（識別字、檔名、路由、引號裡的畫面字、畫面元素名），寫捏造的路由或檔名也會過。
//
// 一次列完所有未過的閘（不要一項一項擠牙膏）：若每次只回報一項，補一項撞一項，
// 派一個要連過多道閘的 agent 會被連續擋很多次，而且每次 deny 都燒一輪 context。
//
// 通用化說明：本範本的 REQUIRED_MARKERS 表格對齊 04-delegation-templates.md 的欄位標題——
// 共用四項（回報鏈鐵則、【驗收條件】、【回報格式】、【開工前必讀】；必讀要不要寫到 CLAUDE.md、GLOSSARY.md（舊檔名 CONTEXT.md 也認）由填空區兩個開關決定，預設不驗）＋依 agent 角色加碼的欄位
// （實作與 QA 驗【開工前對齊】、QA 另驗【目標環境】【既有測試分流】，見填空區註解）。這是通用骨架的預設表，**不含**任何特定專案自訂的紀律標記（例如某種靜態掃描
// 工具名、某種分流判準、某個環境的 port 對照）——專案要加自己的紀律時，直接在表裡
// 用同樣的形狀加一條（見填空區範例的「如何自加一條」）。
//
// fail-open：解析失敗或任何例外一律放行。派工內容檢查（驗作答的各格與【對照表】）丟例外時同樣放行，
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
//   共用（'*'）：回報鏈鐵則（「不得轉派」或「親自執行」）、【驗收條件】、【回報格式】、【開工前必讀】；
//     必讀清單要不要寫到 CLAUDE.md（專案概要）與 GLOSSARY.md（專案用語；舊檔名 CONTEXT.md 也認）由下面兩個開關決定（預設不驗，理由見開關註解）
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
// 【開工前必讀】要不要擋「沒列 CLAUDE.md（專案概要）」「沒列詞彙表（GLOSSARY.md／CONTEXT.md）」兩條（下表 '*' 區 when 欄引用）。
// 預設 false：subagent 啟動時 CLAUDE.md 自動載入，詞彙表以 @ 匯入 CLAUDE.md 的專案連詞彙表也一起載入——
//   來源專案健檢抽樣 60/60 份 subagent 逐字紀錄開頭都已帶這兩份，派工單再列一次是重複、不列又被擋；
//   198 張真實 QA 派工單餵本範本實測，這兩條各擋 135／88 張，全是多餘的擋（擋下的單 subagent 都讀得到這兩份）。
// 詞彙表沒以 @ 匯入 CLAUDE.md、或 agent 設定不自動載入 CLAUDE.md 的專案改 true。
// 兩個開關是 init-verify V24 對 04 的判準之一：false 時 04 各模板【開工前必讀】可不列對應那一行，true 時必列。
const REQUIRE_PROJECT_OVERVIEW_READ = false;
const REQUIRE_GLOSSARY_READ = false;
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
      when: REQUIRE_PROJECT_OVERVIEW_READ,   // false＝這條不驗（開關見上方註解）
    },
    {
      name: '必讀：專案用語',
      pattern: 'GLOSSARY\\.md|CONTEXT\\.md',
      hint: '【開工前必讀】要列專案的詞彙表（專案用語的定義；需求裡的詞以它為準）：只寫專案實際用的那一個檔名——GLOSSARY.md，或沿用舊檔名的專案寫 CONTEXT.md；兩個都沒有就寫「GLOSSARY.md：專案沒有這個檔」。',
      when: REQUIRE_GLOSSARY_READ,
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
      // 認 tests/Project_Detail/ 目錄下任一 .md：派工單常列的是該目錄的子檔（測試坑、某模組的測試知識、測試站說明），那些也是測試知識，
      // 只認 PROJECT.md 會把列得更細的單擋下（來源專案 198 張真實 QA 派工單有 41 張列子檔、0 張列 PROJECT.md 正名）。init 時測試知識不放這個目錄就改目錄。
      pattern: 'tests[\\\\/]Project_Detail[\\\\/][^\\s）)]+\\.md',
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
// 【測試資料來源】選 b 時的例外類別名（04 模板六 b：封閉例外，類別增減只能由使用者裁定）。
// 作答段要寫「例外類別：<類別名>」（全形或半形冒號），類別名取到第一個 ，,。.、；;空白（含全形空白、tab）、換行、（( 為止，去頭尾空白與外層的「」『』或引號，須完全等於下表其一。
// 不用關鍵詞比對自由文字：關鍵詞分不出肯定與否定（「這不是上游系統推送的資料」也命中），加否定詞表只是把漏放換成誤擋。
// 預設對齊 04 模板六 b。init 時照專案 04 模板六 b 實際列的類別改；04 的類別改了，這張表要同步改，否則照新類別寫的 b 會被擋。
// 只驗「宣告了哪一類」，不驗那筆資料是不是真的屬於該類別——真假靠同時要附的「檔名:行號」證據與審查。
const DATA_SOURCE_B_LABELS = ['上游系統推送', '產品沒有建立入口'];
// 常見的非理由（04 模板六 b 列明不是理由）：只用來讓擋下訊息說得更準，**不參與放行判定**——
// 沒宣告例外類別一律擋，有沒有命中這張表都一樣；宣告了例外類別則不因這張表擋（類別成立與否由證據與審查判）。
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

// 【範圍展開】要驗逐格作答的 agent（見檔頭；通常只有 QA agent，Q1 裁掉 QA 時清空）。
// 只在 prompt 出現「【範圍展開】」字樣時驗內容——整個沒寫由標記表報缺，不重複報。
const SCOPE_AGENTS = ['qa-engineer'];
// 04 模板六的位置（相對專案根）與模板標題的 regex 字串：四格的說明原文執行時從這裡讀，不在本檔抄一份——抄的副本會跟模板漂移。
// init 時照實例 04 的實際路徑與標題改。
const SCOPE_TEMPLATE_DOC = '.claude/harness/04-delegation-templates.md';
const SCOPE_TEMPLATE_HEADING = '^##\\s*模板六';
// 四格（與 04 模板六的格名、順序一致）。每格：
//   name — 格名（擋下訊息用）
//   re   — 行首格名的 regex 字串（比對前先剝掉編號、Markdown 與粗體）；也用來切「四格寫在同一行」的寫法
//   hint — 這格的說明文字：照抄它不算作答（04 讀不到時只剝這段），也印在擋下訊息裡
//   need — 擋下時告訴派工的人這格要寫到什麼
// 04 模板六的格名改了，re 要同步改，否則照新格名作答會被判「整格沒寫」。
const SCOPE_CELLS = [
  { name: '正向路徑', re: '^正向(?:路徑|流程)?', hint: '本次改動的 happy path，逐步',
    need: '照實際操作逐步寫：從哪個入口進、按哪個鈕、填什麼值、讀回什麼' },
  { name: '反向／終止分支', re: '^(?:反向(?:\\s*[／/、]\\s*終止)?(?:分支)?|終止分支)',
    hint: '退件／拒絕／取消／軟刪／逾時／重送／權限不足 —— 逐條列出適用哪幾條、怎麼觸發；不適用的逐條說為什麼',
    need: '逐種交代：適用的寫怎麼觸發；不適用的可合併成一句，但要附理由' },
  { name: '狀態序列', re: '^狀態序列',
    hint: '至少一條多步操作（做 A → 做 B → 撤銷 A → 存檔 → 重開），驗最終狀態與各中間態一致；單步操作測不出的鎖死型缺陷只有這格抓得到',
    need: '至少一條多步操作，逐步寫出做什麼、最後讀回什麼；真的沒有可撤銷的操作就寫「無＋理由」' },
  { name: '受影響的共用元件', re: '^(?:受影響的?)?共用元件',
    hint: '本次觸及的共用元件清單＋各自其他使用點是否需連帶回歸；改共用元件必列，不得只驗本頁',
    need: '點名觸及的共用元件與它的其他使用點；沒觸及就寫「無＋理由」' },
];
// 【範圍展開】內容品質（有作答的格再判；整個設成 null 就只驗「有沒有作答」）。三個參數都是專案事實：
//   minAnchors   — 正向路徑至少幾個具體錨點，且不能全是數字。錨點＝反引號／引號裡的具體字、檔名、路由或路徑、localhost／port、
//                  識別字（camelCase、snake_case、a.b、非泛稱的全大寫縮寫）、英文字列舉（success／warning）、英文前綴的畫面元素（「token 頁」）、
//                  中文畫面元素名（「出貨單列表頁」，字尾表見 uiSuffixes）、按鈕名（「按儲存」「點選匯出」）、詞彙表詞條名（glossaryFile，最多算 1 個）、數字門檻
//   minSteps     — 狀態序列至少幾步：同一行箭頭串的段數、條列子項數、「先／再／接著／最後」序詞數＋1、「N 次連續」取最大；
//                  真的沒有多步操作就寫「不適用／無＋理由」（拿掉空詞後 ≥6 字）
//   reverseKinds — 反向／終止分支要逐一交代的種類：照專案 04 模板六列的改（name 印在擋下訊息、re 是同義詞的 regex 字串，
//                  英文詞要整字）。每種要嘛以分支名開頭寫怎麼觸發（句裡有錨點，或觸發動詞＋具體對象），要嘛寫不適用＋理由；
//                  「其餘／七種皆不適用：理由」「X 等分支不在範圍：理由」一句可帶過所有沒點名的。只出現在反引號、引號、括號裡的分支名不算交代
//                  （那是識別字、畫面字面或舉例）。「退件」與「拒絕」預設共用同一條 re（點名其中一種就算交代兩種）：
//                  簽核系統多半只有一個 Rejected 狀態、畫面只顯示其中一個詞，派工單寫了退件就不會再另寫拒絕，分開要求只會擋好單
//                  （來源實例逐份讀過只缺一種的派工單，全是品質好的單）。專案的兩種分支真是兩條路徑時才拆成兩條 re。
//   uiSuffixes   — 中文畫面元素名的字尾表（「出貨單列表頁」「編輯視窗」「送出鈕」），regex 字串、長的放前面；
//                  前面接 2 個字以上、不是泛稱（頁面／功能／該／某…）的中文就算一個錨點。預設照來源實例校準過的完整表；
//                  專案畫面慣用別的叫法（「卡」「抽屜」「面板」以外的）就補進來。只有 14 種字尾時，純中文 UI 名的派工單湊不到錨點而被誤擋
//   glossaryFile — 詞彙表（相對專案根；空字串＝不讀）：表裡 `**詞**` 粗體獨立成行的詞條名也算一個錨點，但整格最多算 1 個
//                  （只靠詞彙表湊數不算具體，還要另有頁面／欄位／值）。來源實例的詞條是「**品改單（模組）**」這種形狀，
//                  括號去掉、「／」「、」切開、純中文 ≥2 字的才收；專案詞彙表不是這個形狀就留空
// 不驗「受影響的共用元件」點名的檔是否真的存在、寫「無」時工作區有沒有改到共用元件——那要知道專案有哪幾個 repo、
// 共用元件目錄在哪、哪些檔是本機覆寫，參數化後形狀不成立（見 plugin docs/maintaining.md §3 回收紀錄）；該格只驗有作答、寫無附理由。
const SCOPE_QUALITY = {
  minAnchors: 2,
  minSteps: 3,
  uiSuffixes: '詳情頁|查詢頁|列表頁|編輯頁|按鈕|鈕|欄位|欄|頁籤|分頁|抽屜|彈窗|對話框|下拉選單|下拉|選單|列表|表格|頁面|頁|橫幅|視窗|區塊|區|卡片|卡|圖示|連結|勾選框|核取方塊|輸入框|面板|編輯器|捲軸|列|tab|Tab|modal|Modal',
  glossaryFile: '',
  reverseKinds: [
    { name: '退件', re: '退件|退回(?![一-鿿A-Za-z]{0,4}(?:原文|預設|原值|原始))|駁回|拒絕|拒收|不核准|否決|(?<![A-Za-z])(?:reject(?:ed)?|returned|deny|denied|refuse[ds]?)(?![A-Za-z])' },
    { name: '拒絕', re: '退件|退回(?![一-鿿A-Za-z]{0,4}(?:原文|預設|原值|原始))|駁回|拒絕|拒收|不核准|否決|(?<![A-Za-z])(?:reject(?:ed)?|returned|deny|denied|refuse[ds]?)(?![A-Za-z])' },
    { name: '取消', re: '取消|撤銷|撤回|作廢|(?<![A-Za-z])(?:cancel(?:ed|led)?|revoke[ds]?)(?![A-Za-z])' },
    { name: '軟刪', re: '軟刪|刪除|下架|停用|IsDeleted|(?<![A-Za-z])(?:soft.?delete|delete[ds]?|unpublish)(?![A-Za-z])' },
    { name: '逾時', re: '逾時|超時|逾期|過期|到期|(?<![A-Za-z])(?:timeout|time.?out|expired?)(?![A-Za-z])' },
    { name: '重送', re: '重送|重新送|重新提交|再送|重發|重試|重推|再次送出|重複送出|連發|(?<![A-Za-z])(?:resubmit|retry|retries)(?![A-Za-z])' },
    { name: '權限不足', re: '權限不足|權限|無權|沒權|越權|(?<!\\d)40[13](?!\\d)|(?<![A-Za-z])(?:unauthori[sz]ed|forbidden|permission)(?![A-Za-z])|未登入' },
  ],
};
// 對齊類任務要驗【對照表】的 agent（見檔頭）；'*'＝表中所有專案 agent。不要這道閘就清空。
const COMPARE_AGENTS = ['*'];
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
    + 'a 走真實業務流程長出來（首選）；b 封閉例外（只限 04 模板六 b 列的例外類別，作答段寫「例外類別：' + DATA_SOURCE_B_LABELS.join('」或「例外類別：') + '」照抄；成本過高不是理由），要附為何不走 a 所根據的產品端證據「檔名:行號」'
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
    // 兩件事都要過、各自獨立報（一次列完）：①宣告例外類別（DATA_SOURCE_B_LABELS，固定格式）②附「檔名:行號」證據。
    // 只驗證據的話，「選 b，理由：真流程成本過高，證據 src/x.cs:88」會放行——證據隨便指一行程式就湊得出來，理由才是 04 b 封閉的那一半。
    const hit = (list) => list.find((p) => new RegExp(p, 'i').test(answer));
    const declared = (() => {
      // 派工單是 Markdown：類別名外面包反引號、粗體星號、底線、引號都算正當寫法（2026-10-18 紅藍對抗 R2：`上游系統推送`／**上游系統推送** 被誤擋）
      const unquote = (x) => x.trim().replace(/^[「『"'“‘`*_]+/, '').replace(/[」』"'”’`*_]+$/, '').trim();
      // 類別名在右括號、斜線也要停（「（例外類別：上游系統推送）」「上游系統推送／產品沒有建立入口」列兩類時取第一個），否則括號會被吃進類別名而對不上；
      // 冒號後可以先來一個左括號（「例外類別：（上游系統推送）」，R2 複驗誤擋）——括號裡是「不是」之類的字時 LABELS 對不上，照樣不算宣告
      const re = /(^|[，,。.、；;\s（(「])例外類別[ \t　]*[:：][ \t　]*[（(]?[ \t　]*([^，,。.、；;\s（(）)／/]*)/g;
      let m;
      while ((m = re.exec(answer)) !== null) {
        // 固定格式外面再包一層否定仍會命中（「這筆不屬於例外類別：上游系統推送」「例外類別：上游系統推送（不是）」），
        // 所以同一子句尾端帶否定詞、或類別名後面緊接排除詞（可包在括號裡）的，都不算宣告。正當寫法是用標點把宣告隔成自己的子句。
        const clause = answer.slice(0, m.index + m[1].length).split(/[，,。.；;\n]/).pop();
        if (/[不非沒無別][^，,。.；;\n]{0,6}$/.test(clause)) continue;
        const after = answer.slice(m.index + m[0].length).replace(/^[ \t　]+/, '');
        if (/^(?:[）)]?[ \t　]*)(?:[（(][ \t　]*)?(以外|之外|除外|不算|無關|不是|不屬|不含|不適用|並非|並不|非)/.test(after)) continue;
        if (DATA_SOURCE_B_LABELS.includes(unquote(m[2]))) return true;
      }
      return false;
    })();
    if (!declared) {
      const nonReason = hit(DATA_SOURCE_B_NON_REASONS);
      const said = nonReason ? (new RegExp(nonReason, 'i').exec(answer) || [''])[0] : '';
      out.push('[測試資料來源·非例外] （只讀作答段：第一行起到空行，或到以 a./b./c.／（／⛔ 開頭的說明行為止）選了 b，'
        + '但沒有用固定格式宣告例外類別。04 模板六 b 是封閉例外：作答段要寫「例外類別：' + DATA_SOURCE_B_LABELS.join('」或「例外類別：') + '」其中一個，'
        + '類別名照抄、不加其他字；本閘不判自由文字，「這不是上游系統推送的資料」之類的句子不算宣告。'
        + (said ? '理由裡的「' + said + '」不屬於例外類別——' : '')
        + '成本過高、跨模組麻煩、跑一輪很慢、要精確控制資料形狀、歷史相容性都不是理由，一律走 a，不論成本。'
        + '完整範例：選 b，例外類別：上游系統推送，唯一寫入點 src/Sync/ShipmentImport.cs:120。' + COMMON);
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

// ── 範圍展開作答閘與對照表閘共用的格位解析 ──────────────────────────────────────
// 作答範圍＝「行首」的【標題】那一行之後，到下一個行首【…】為止；行首可帶 Markdown 前綴（###、>、**、- 清單符號）。
// 句中提到的不算標題（「回報要附【對照表】」）。同名標題出現多次時每段都是候選，有一段判過就算有作答——
// 模板六【回報格式】的「- **【範圍展開】逐格回報**」也會被當成一段，但它底下沒有格名，判不過，不影響結果。
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
// 只剩字的比對基準：拿掉空白、標點與符號，全形／半形斜線、粗體記號都不影響「是不是照抄說明文字」
const flatText = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '');
// 不構成作答的空詞與填充詞（「無，理由：無」「不適用，同上」「TBD」）；比對對象是 flatText 之後的字串
const NULL_WORDS = /待補[充中上齊]?|待確認|待定|之後再?補|稍後補|再補|後補|同上|見上|見下|不適用|不涉及|不需要?|無需|沒有|略過?|空白|理由|原因|因為|說明|無|(?<![A-Za-z])(?:(?:TBD)+|TODO|NA|none|nil|null|OK)(?![A-Za-z])/gi;
// 清單編號與項目符號不是內容：「1) <步驟>\n2) <步驟>」剝完佔位只剩編號，不得算作答
const stripMarkers = (s) => String(s).replace(/(^|[\s，,；;：:])(?:[-*•+]|[\d０-９]+[.)、．）]|[①-⑩])(?=\s|$)/gm, '$1');
const hasRealText = (s) => flatText(stripMarkers(stripPlaceholders(s))).replace(NULL_WORDS, '').length >= 2;
// 說明文字切成子句：整段＋各子句（≥4 字才拿來比對，太短的子句會誤刪作答內容），長的先剝
const hintClauses = (s) => [flatText(s)].concat(String(s).split(/[；;，,。]|—+/).map(flatText))
  .filter((c) => c.length >= 4).sort((a, b) => b.length - a.length);

// ── 範圍展開作答閘（見檔頭）──────────────────────────────────────────────────────
const SCOPE_RES = SCOPE_CELLS.map((c) => new RegExp(c.re));
const SCOPE_BARE = SCOPE_CELLS.map((c) => c.re.replace(/^\^/, ''));
// 格內只是複述格名的字（「沒有反向分支」「不適用此格」），拿掉後再數剩幾個字
const SCOPE_ECHO = new RegExp(SCOPE_BARE.concat(['分支', '路徑', '終止', '受影響的?', '這一格', '本格', '此格', '這格', '本次', '這次']).join('|'), 'g');
// 格名所在行剝掉行首前綴（Markdown、編號、粗體）後再比格名
const SCOPE_LEAD = (l) => String(l).replace(/^[\s>*_#-]*/, '').replace(/^(?:[1-9１-９](?:[.、．)）]|\s+)|[①-⑨])\s*/, '').replace(/^[*_]+\s*/, '');
// 四格寫在同一行（「【範圍展開】正向：…；反向：…；狀態序列：…」）：在「；」後接格名處切開，當成多行處理
const SCOPE_SPLIT = new RegExp('[；;](?=\\s*(?:[1-9１-９](?:[.、．)）]|\\s)|[①-⑨])?\\s*[*_]*(?:' + SCOPE_BARE.join('|') + '))');
// 04 模板六各格的說明原文（剝佔位後切成子句）。回 { hints } 或 { error }；讀不到時呼叫端只剝本檔的格說明，並告知模型
function scopeTemplateHints(root) {
  try {
    const t = fs.readFileSync(path.resolve(root, SCOPE_TEMPLATE_DOC), 'utf8').split(/\r?\n/);
    const head = new RegExp(SCOPE_TEMPLATE_HEADING);
    const s6 = t.findIndex((l) => head.test(l));
    if (s6 < 0) throw new Error('找不到模板標題（' + SCOPE_TEMPLATE_HEADING + '）');
    const h = t.findIndex((l, k) => k > s6 && /^\s*【範圍展開】/.test(l));
    if (h < 0) throw new Error('模板裡找不到行首【範圍展開】');
    const hints = SCOPE_CELLS.map(() => null);
    const raws = SCOPE_CELLS.map(() => null);   // 說明原文（剝佔位後）：內容品質判定前要從作答裡整段剝掉，照貼模板不能湊錨點與分支名
    for (let k = h + 1; k < Math.min(t.length, h + 1 + SCOPE_CELLS.length * 2); k++) {
      const m = /^\s*\d+[.、．]\s*\*\*([^*]+)\*\*\s*[:：](.*)$/.exec(t[k]);
      if (!m) continue;
      const slot = SCOPE_RES.findIndex((re) => re.test(m[1].trim()));
      if (slot >= 0 && !hints[slot]) { hints[slot] = hintClauses(stripPlaceholders(m[2])); raws[slot] = stripPlaceholders(m[2]); }
    }
    if (hints.some((x) => !x)) throw new Error('四格格名對不上（' + SCOPE_CELLS.map((c) => c.name).join('／') + '）');
    return { hints, raws };
  } catch (e) {
    return { error: String((e && e.message) || e).split('\n')[0] };
  }
}
// 一段【範圍展開】逐格判定；回傳 [{ slot, why }]（空＝合格）。tpl＝scopeTemplateHints 的結果（{ hints, raws } 或 { error }）；
// quality=false 時只判有沒有作答（不執行測試的 QA 派工用，見 scopeGate）
function judgeScope(sec, tpl, quality) {
  const tplHints = (tpl && tpl.hints) || null;
  const n = SCOPE_CELLS.length;
  const cells = SCOPE_CELLS.map(() => null);
  const lines = [].concat(...[sec.head].concat(sec.body).map((l) => String(l).split(SCOPE_SPLIT)));
  let cur = -1;
  let labeled = 0;
  for (const l of lines) {
    const t = SCOPE_LEAD(l);
    const slot = SCOPE_RES.findIndex((re) => re.test(t));
    if (slot >= 0 && cells[slot] === null) {
      cells[slot] = [t.replace(SCOPE_RES[slot], '').replace(/^[*_]+/, '').replace(/^\s*[:：]/, '')];
      cur = slot;
      labeled++;
      continue;
    }
    if (cur >= 0) cells[cur].push(l);
  }
  if (!labeled) {
    // 沒寫格名、只寫 1.～4. 編號時，依頂層編號歸格（縮排兩格以上的子項歸前一格）
    for (const l of lines) {
      const m = /^[ \t]?([1-9１-９])[.、．)）]\s*(.*)$/.exec(l);
      const k = m ? ('123456789'.indexOf(m[1]) + 1 || '１２３４５６７８９'.indexOf(m[1]) + 1) - 1 : -1;
      if (m && k < n && cells[k] === null) { cells[k] = [m[2]]; cur = k; continue; }
      if (cur >= 0) cells[cur].push(l);
    }
  }
  const bad = [];
  for (let k = 0; k < n; k++) {
    if (cells[k] === null) { bad.push({ slot: k, why: '整格沒寫' }); continue; }
    let flat = flatText(stripMarkers(stripPlaceholders(cells[k].join('\n'))));
    if (!flat) { bad.push({ slot: k, why: '空白或只留佔位' }); continue; }
    const clauses = [].concat((tplHints && tplHints[k]) || [], hintClauses(SCOPE_CELLS[k].hint)).sort((a, b) => b.length - a.length);
    for (const c of clauses) flat = flat.split(c).join('');
    if (!flat) { bad.push({ slot: k, why: '只照抄模板或本閘訊息的說明文字' }); continue; }
    if (flat.replace(NULL_WORDS, '').replace(SCOPE_ECHO, '').length < 2) bad.push({ slot: k, why: '只寫「無／不適用」或複述格名，沒附理由' });
  }
  // 有作答的格再判內容品質（見填空區 SCOPE_QUALITY）；已判空白的格不重複報，跨格重複照報
  if (SCOPE_QUALITY && quality !== false) {
    const done = new Set(bad.map((b) => b.slot));
    for (const q of judgeScopeQuality(cells, tpl && tpl.raws)) if (!done.has(q.slot) || q.dup) bad.push(q);
  }
  return bad;
}

// ── 範圍展開內容品質（見填空區 SCOPE_QUALITY；判準全是機械的，不用模型）──────────────────
const SQ_KINDS = (SCOPE_QUALITY && SCOPE_QUALITY.reverseKinds || []).map((k) => ({ name: k.name, re: new RegExp(k.re, 'i') }));
const SQ_KINDS_ALL = SQ_KINDS.length ? new RegExp(SQ_KINDS.map((k) => k.re.source).join('|'), 'gi') : /$^/g;
const SQ_ARROW = /→|->|⇒|=>|➜|➔|⟶|➡/;
// 否定語（這一句在講「不適用」）；「沒有」「不會」也常用來描述預期結果，所以標題句「分支名：內容」的內容只認 SQ_STRONG_NA
const SQ_NEG = /不適用|不涉及|不需要?|無需|不必|不存在|無此|沒有|不會|不測|不驗|不做|不在|不屬|不觸發|(?<![策省忽概約])略過?|(?<![A-Za-z])N\/?A(?![A-Za-z])|無觸發|無入口|無對應|未觸及|未改|未動|不改|不動|不影響|無關|免測|排除|無(?=其[他餘它])|(?:^|[^一-鿿])無(?=[\s，,。；;：:（(）)—\-、*_]|$)/i;
const SQ_STRONG_NA = /不適用(?![的者就則要須請])|不涉及|免測|不測|不補|不驗|不做|不重測|不另(?:行|外)?(?:觸發|測|補)|(?<![策省忽概約])略過|(?<![A-Za-z])N\/?A(?![A-Za-z])|本輪不|無需|不需要?|不必|不觸發|不在(?:畫面|本輪|範圍|此)|排除|無關|(?:沒有|無|不存在)[^，,。；]{0,8}?(?:入口|路徑|觸發點?|按鈕|功能|概念|狀態|流程|機制|轉換|分支|此)/i;
// 合稱詞：「其餘／七種／以上皆不適用」「拒絕／取消等產品分支不在本次範圍」一句帶過沒點名的分支
const SQ_COLLECTIVE = /[二兩三四五六七八九十]\s*[種條項類個]|其[餘他它]|以上|全部|皆|均|都|剩下|所有|一律|任何|等[一-鿿]{0,4}(?:分支|情境|狀態)/;
const SQ_COLLECTIVE_G = new RegExp(SQ_COLLECTIVE.source, 'g');
// 整格開頭就是一句不適用（「不適用——純查詢頁」「**無**——…」「N/A（…）」）
const SQ_CELL_NA = /^[\s*_]*(?:本(?:任務|次|輪)\s*[*_]*)?(?:不適用|無(?![一-鿿])|N\/?A|不需要?|沒有|免測|略過?|不另行|不另外)/i;
// 觸發動詞：用 X 帳號、按 Y 鈕、打 Z API…
const SQ_TRIGGER = /用|以|按|點|送|呼叫|打|設|改|切|開|登入|模擬|觸發|讓|把|將|走|執行|跑|帶|傳|填|上傳|撤|輸入|選|超過|超出|停|斷|關|注入|造|帳號|身分|攔截|call|mock|role|grant|token|route/i;
const SQ_TRIGGER_G = new RegExp(SQ_TRIGGER.source, 'gi');
// 轉介詞與空泛詞：「見附件」「照常」「確認正常」不是理由也不是觸發方式
const SQ_REFER = /見附件|如附件|詳見|參見|請見|前述|同前|如前|如上|如下|上述|這些|那些|此類|照舊|照常|同模板|照模板|依模板|比照|一般|正常|順利|完整|確認|功能|操作|測試|檢查|驗證|沒問題|無誤|看看|一下/g;
// 分支名只看引號、反引號、括號外。括號裡是作答者的適用與否標註（「**逾時（不適用）**」）時不遮
const sqMaskQuoted = (s) => String(s).replace(/`[^`]*`/g, ' ').replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/g, ' ');
const sqMaskParen = (s) => String(s).replace(/（[^）]*）|\([^)]*\)/g, (m) => (/不?適用(?![的者])|(?<![A-Za-z])N\/?A(?![A-Za-z])/i.test(m) ? m : ' '));
// 理由字數：拿掉分支名、空詞、格名複述、合稱詞、轉介詞後剩幾個字。兩種量法取大：
//   ①整句拿掉分支名後的字數 ②否定詞之後、保留分支名的字數——「軟刪：不適用——無刪除操作」的「刪除」同時是分支同義詞與理由的一部分，
//   只用①會量成 0 而誤擋好單；但否定詞之後只剩分支名與標點（「不適用：退件、拒絕」）時分支名不算理由，仍用①
const sqReasonPart = (s) => flatText(stripMarkers(String(s))).replace(NULL_WORDS, '').replace(SCOPE_ECHO, '').replace(SQ_COLLECTIVE_G, '').replace(SQ_REFER, '');
const sqReasonLen = (s) => {
  const whole = sqReasonPart(String(s).replace(SQ_KINDS_ALL, ' ')).length;
  const m = SQ_NEG.exec(String(s));
  if (!m) return whole;
  const after = String(s).slice(m.index + m[0].length);
  if (!flatText(after.replace(SQ_KINDS_ALL, ' ')).replace(NULL_WORDS, '').length) return whole;
  return Math.max(whole, sqReasonPart(after).length);
};
// 觸發方式：有錨點，或有觸發動詞且拿掉動詞、空詞、泛稱後還有 3 個字以上的對象（「用帳號測一下」不算；「適用」的「用」不是動詞）
const sqHasTrigger = (s) => {
  const rest = String(s).replace(SQ_KINDS_ALL, ' ').replace(/不?適用/g, ' ');
  return anchorList(rest).length > 0
    || (SQ_TRIGGER.test(rest) && flatText(rest).replace(SQ_TRIGGER_G, '').replace(/測試?|一下|看看|帳號/g, '').replace(NULL_WORDS, '').replace(SQ_REFER, '').replace(GENERIC_NOUN, '').length >= 3);
};
// 錨點清單（與 hasAnchor 同一套認法，但回傳每一個；num＝只是數字門檻）。正向路徑數錨點、反向分支判觸發方式、狀態序列判步驟具體與否都用它
function anchorList(raw) {
  const ANCHOR_FILE_G = new RegExp(ANCHOR_FILE.source, 'gi');   // 在函式裡建：ANCHOR_FILE 定義在本檔後段（對照表閘），載入時還拿不到
  let t = stripPlaceholders(String(raw));
  const out = new Map();
  const add = (k, num) => { const key = String(k).trim().toLowerCase(); if (key && !out.has(key)) out.set(key, { key, num: !!num }); };
  const real = (x) => flatText(x).replace(GENERIC_NOUN, '').replace(NULL_WORDS, '').length >= 2;
  t = t.replace(/`([^`\n]+)`/g, (m, x) => { if (real(x)) add('`' + x); return ' '; });
  t = t.replace(/[A-Za-z_][\w.]*\s*[=＝]\s*["'「]?[\w一-鿿.\-]+["'」]?/g, (m) => { add(m); return ' '; });   // 設定值指派：Status=4、E2E_TARGET=dev
  t = t.replace(/[「『“"]([^」』”"\n]{1,40})[」』”"]/g, (m, x) => { if (real(x)) add('「' + x); return ' '; });
  t = t.replace(ANCHOR_FILE_G, (m) => { add(m); return ' '; });
  t = t.replace(/(?:[A-Za-z]:)?\/?[A-Za-z0-9_.\-{}]+(?:\/[A-Za-z0-9_.\-{}]+)+\/?|\/[A-Za-z][\w\-]{2,}/g, (m) => { if (!/[A-Za-z]{3}/.test(m)) return m; add(m); return ' '; });
  t = t.replace(/(?:localhost)?:\d{4,5}(?!\d)|(?<![A-Za-z])localhost(?![A-Za-z])/gi, (m) => { add(m); return ' '; });
  // 英文字列舉：success／warning／danger（全形斜線、頓號；半形斜線已被路徑那條吃掉）
  t = t.replace(/[A-Za-z]{3,}(?:\s*[／、]\s*[A-Za-z]{3,})+/g, (m) => { add(m); return ' '; });
  // 英文前綴的畫面元素：「token 頁」「上傳 Modal」「wangEditor 輸入區」——要在識別字被吃掉之前抓；只登記不消耗，識別字那條照常判
  t.replace(/([A-Za-z][\w\-]{2,})\s*(頁|欄位?|按鈕|鈕|輸入區|輸入框|區|面板|tab|Tab|modal|Modal|dialog|drawer)(?![A-Za-z])/g, (m, a, b) => { if (!GENERIC_CAPS.has(a.toUpperCase())) add(a + b); return m; });
  t = t.replace(/[A-Za-z_][A-Za-z0-9_]*(?:[.\-][A-Za-z0-9_]+)*/g, (m) => { if (!isIdent(m)) return m; add(m); return ' '; });
  t = t.replace(/[≤≥<>＜＞=＝]\s*[+-]?\d+/g, (m) => { add(m, true); return ' '; });
  t = t.replace(/(?<![\d.])(?:\d{2,}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:%|ms|秒|分鐘|筆|個|次|列|欄|頁|px|rem|天|小時|MB|KB|字元|字|碼|位|版|張|支|條|人|家|元|行|份))(?!\d)/g, (m) => { add(m, true); return ' '; });
  let m;
  ANCHOR_UI.lastIndex = 0;
  while ((m = ANCHOR_UI.exec(t))) {
    const core = m[1].split(/[的之與和及或]/).pop().replace(ANCHOR_UI_HEAD, '');
    if (core.replace(GENERIC_NOUN, '').length >= 2 && !ANCHOR_UI_GENERIC.test(core)) add(core + m[0].slice(m[1].length));
  }
  // 按鈕名：「按儲存」「點送出」「點選匯出」（按照、點數、點出這類不是按鈕；前面接中文字時只認「後／再／並／先／然」之後的，
  // 「使用點連帶回歸」的「點」是名詞）
  t.replace(/(?:(?<![一-鿿])|(?<=[後再並先然]))[按點](?![照時數出連位子])(?:擊|選)?([一-鿿]{2,4})/g, (m, x) => {
    if (!/^(?:一下|進去|進入|開|這|該|此|那|上|下|任|某|按鈕|鈕|看|過|到|擊|選|頁面|畫面|確認一下)/.test(x)) add('按' + x);
    return m;
  });
  // 詞彙表詞條名最多算 1 個錨點（見填空區 glossaryFile；空＝這一類不算）
  const term = glossaryTerms().find((w) => t.includes(w));
  if (term) add(term);
  return Array.from(out.values());
}
// 詞彙表的詞條名（填空區 glossaryFile；「**詞（模組）**」獨立成行的粗體），執行時讀、讀不到就不用這一類
let SQ_ROOT = null;   // 專案根：主程式讀到 payload 後設定，詞彙表相對它解析
let GLOSSARY_TERMS = null;
function glossaryTerms() {
  if (GLOSSARY_TERMS) return GLOSSARY_TERMS;
  GLOSSARY_TERMS = [];
  const f = SCOPE_QUALITY && SCOPE_QUALITY.glossaryFile;
  if (!f) return GLOSSARY_TERMS;
  try {
    for (const l of fs.readFileSync(path.resolve(SQ_ROOT || process.cwd(), f), 'utf8').split(/\r?\n/)) {
      const m = /^\*\*([^*]+)\*\*\s*$/.exec(l.trim());
      if (!m) continue;
      m[1].replace(/[（(][^）)]*[）)]/g, '').split(/[／/、]/).map((x) => x.trim())
        .filter((x) => x.length >= 2 && !/[A-Za-z]/.test(x)).forEach((x) => GLOSSARY_TERMS.push(x));
    }
  } catch (e) { /* 讀不到就少一類錨點，其餘照判 */ }
  return GLOSSARY_TERMS;
}
// 模板說明原文與本閘的格說明：作答裡照抄的部分要剝掉才判品質（否則照貼模板就有箭頭、有分支名）。
// 只剩分支名的子句不剝：「退件／拒絕／…／權限不足：不適用，理由…」是正當作答（整行照貼模板時由整段比對剝掉）
function sqLooseRe(s) {
  const chars = Array.from(String(s).replace(/[\s*_]/g, '')).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return chars.length >= 4 ? new RegExp(chars.join('[\\s*_]*'), 'g') : null;
}
function sqStripTemplate(text, slot, raws) {
  let t = String(text);
  const pieces = [];
  for (const s of [SCOPE_CELLS[slot].hint].concat(raws && raws[slot] ? [raws[slot]] : [])) {
    pieces.push(s);
    String(s).split(/[；;，,。（）()]|—+/).forEach((c) => { const f = flatText(c); if (f.length >= 4 && f.replace(SQ_KINDS_ALL, '').length) pieces.push(c); });
  }
  pieces.sort((a, b) => flatText(b).length - flatText(a).length);
  for (const p of pieces) { const re = sqLooseRe(p); if (re) t = t.replace(re, ' '); }
  return t;
}
// 反向／終止分支：每種分支的交代狀態。回傳 { status: { <name>: 'ok'|'notrig'|'na'|'weak' }, collective, collectiveWeak }
//   ok＝適用且寫了觸發方式；notrig＝適用但沒寫怎麼觸發；na＝不適用且有理由；weak＝寫了不適用但沒理由；沒點名＝不在 status 裡
// 句子以「。；;」與換行切；表格列「| 權限不足 | 不適用 | 理由 |」當成「權限不足：不適用，理由」。
// 標題句「分支名：內容」只認冒號前的分支（內容裡順帶提到別的分支不算交代），內容要有明確不適用語才算不適用；
// 其他句子：句裡有否定語就算不適用。被句號切開的理由或觸發方式（「取消：不適用。理由：唯讀查詢」）：下一句不是另一條分支的標題句時算這句的
function sqReverseKinds(text) {
  const clauses = [];
  for (const l0 of String(text).split(/\r?\n/)) {
    let l = l0;
    const cs = /^\s*\|(.*)\|\s*$/.test(l) ? l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()) : null;
    if (cs && cs.length >= 2) l = cs[0] + '：' + cs.slice(1).join('，');
    for (const c of l.split(/[。；;]/)) if (c.trim()) clauses.push(c.trim());
  }
  const status = {};
  const rank = { weak: 1, na: 2, notrig: 1, ok: 2 };
  const set = (k, s) => { if (!status[k.name] || rank[s] > rank[status[k.name]]) status[k.name] = s; };
  const kindsIn = (s) => SQ_KINDS.filter((k) => k.re.test(s));
  let collective = false, collectiveWeak = false;
  const cellNA = clauses.length > 0 && SQ_CELL_NA.test(clauses[0]) && !kindsIn(sqMaskQuoted(clauses[0])).length;
  if (cellNA) { if (sqReasonLen(clauses[0]) + sqReasonLen(clauses[1] || '') >= 4) collective = true; else collectiveWeak = true; }
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    const vis = sqMaskParen(sqMaskQuoted(c));
    const neg = SQ_NEG.test(c);
    if (neg && SQ_COLLECTIVE.test(c) && !(cellNA && i === 0)) { if (sqReasonLen(c) >= 4) collective = true; else collectiveWeak = true; }
    const hm = /^([^：:—]{0,30})(?:[：:]|——?)([\s\S]*)$/.exec(vis);
    const headKinds = hm ? kindsIn(hm[1]) : [];
    const hit = headKinds.length ? headKinds : kindsIn(vis);
    if (!hit.length) continue;
    const nx = clauses[i + 1] && !kindsIn(sqMaskParen(sqMaskQuoted(clauses[i + 1]))).length ? clauses[i + 1] : '';
    const isNeg = cellNA || (headKinds.length ? (SQ_NEG.test(hm[1]) || SQ_STRONG_NA.test(hm[2])) : neg);
    if (isNeg) {
      const r = sqReasonLen(c) + (sqReasonLen(c) < 2 ? sqReasonLen(nx) : 0);
      for (const k of hit) set(k, r >= 2 ? 'na' : 'weak');
      continue;
    }
    const trig = sqHasTrigger(c) || (nx && !SQ_STRONG_NA.test(nx) && sqHasTrigger(nx));
    for (const k of hit) set(k, trig ? 'ok' : 'notrig');
  }
  return { status, collective, collectiveWeak };
}
// 反向格的缺項（每一句都附改法，讓派工的人一次補齊）
function sqJudgeReverse(text) {
  const { status, collective, collectiveWeak } = sqReverseKinds(text);
  const of = (s) => SQ_KINDS.filter((k) => status[k.name] === s).map((k) => k.name);
  const missing = collective ? [] : SQ_KINDS.filter((k) => !status[k.name]).map((k) => k.name);
  const why = [];
  if (missing.length) {
    why.push(SQ_KINDS.length + ' 種反向分支沒交代到：' + missing.join('、') + (collectiveWeak ? '（寫了「其餘不適用」但沒附理由）' : '')
      + '。改法：每種以分支名開頭寫一句——適用的寫怎麼觸發（「權限不足：用沒有 `x.view` 權限的帳號開 `/x/list`，應導向無權限頁」），'
      + '不適用的寫理由（「取消／軟刪不適用：本頁沒有取消與刪除入口」），或一句「其餘皆不適用：<理由>」帶過。'
      + '只寫在反引號、引號、括號裡的分支名不算（那是識別字、畫面字面或舉例）');
  }
  const weak = of('weak');
  if (weak.length) why.push('寫了不適用但沒附理由：' + weak.join('、') + '。改法：「逾時不適用：本頁沒有排程與到期概念」');
  const notrig = of('notrig');
  if (notrig.length) why.push('列為適用但沒寫怎麼觸發（用哪個帳號／按哪顆鈕／打哪支 API／造什麼值）：' + notrig.join('、') + '。改法：「退件：用主管帳號在簽核頁按「退回」，單據應回到可編輯」');
  return why;
}
// 狀態序列步數：同一行箭頭串的段數、條列子項數、「先／再／接著／最後」序詞數＋1、「N 次連續」取最大
function sqSeqSteps(text) {
  let best = flatText(stripMarkers(text)) ? 1 : 0;   // 有寫字就至少算一步（沒有箭頭、沒有條列的一句話＝1 步）
  const lines = String(text).split(/\r?\n/);
  for (const l of lines) {
    const segs = l.split(SQ_ARROW).map((s) => flatText(stripMarkers(s))).filter((s) => s.length >= 1);
    if (segs.length >= 2) best = Math.max(best, segs.length);
  }
  const items = lines.filter((l) => /^\s*(?:[-*•+]|\d+[.)、．）]|[①-⑩]|[(（]\d+[)）])\s*\S/.test(l)).length;
  const ord = (String(text).match(/先|再|然後|接著|之後|最後|隨後|其後|初值|一開始|起初|最初|第[一二三四五1-5]次/g) || []).length;
  const rep = Math.max(0, ...Array.from(String(text).matchAll(/(\d{1,3})\s*次(?:連續|反覆|來回)?/g), (m) => +m[1]).filter((n) => n <= 100));
  return Math.max(best, items, ord ? ord + 1 : 0, rep >= 3 ? rep : 0);
}
// 序列裡「具體」的步數：拿掉泛用動作（開頁、點按鈕、存檔、重開、確認…）後還剩 2 個字以上的步
const SQ_GENERIC_STEP = /開啟?|頁面?|畫面|按鈕?|點擊?|存檔|儲存|重開|重新整理|重整|送出|確認|操作|做|撤銷|再|然後|檢查|看|結果|正常|成功|失敗|資料|內容|欄位|值|填寫?|輸入|改|修改|動作|步驟|完成|一次|進入|回到|返回|[A-Za-z]/g;
function sqSpecificSteps(text) {
  const segs = [];
  String(text).split(/\r?\n/).forEach((l) => l.split(SQ_ARROW).forEach((s) => segs.push(s)));
  return segs.filter((s) => flatText(stripMarkers(s)).replace(SQ_GENERIC_STEP, '').replace(NULL_WORDS, '').length >= 2).length;
}
function sqBigramJaccard(a, b) {
  const g = (s) => { const x = new Set(); for (let i = 0; i < s.length - 1; i++) x.add(s.slice(i, i + 2)); return x; };
  const A = g(a), B = g(b);
  let n = 0; A.forEach((x) => { if (B.has(x)) n++; });
  return n / Math.max(1, A.size + B.size - n);
}
// 四格內容品質；cells＝judgeScope 切好的各格（null＝沒寫），raws＝04 模板六各格說明原文。回傳 [{ slot, why, dup? }]
function judgeScopeQuality(cells, raws) {
  const Q = SCOPE_QUALITY;
  const bad = [];
  const texts = cells.map((c, k) => (c ? sqStripTemplate(c.join('\n'), k, raws) : ''));
  // 1 正向路徑：至少 minAnchors 個錨點，且不能全是數字
  if (cells[0]) {
    const a = anchorList(texts[0]);
    if (a.length < Q.minAnchors || !a.some((x) => !x.num)) {
      bad.push({ slot: 0, why: '具體錨點不足（找到 ' + a.length + ' 個' + (a.length ? '：' + a.slice(0, 3).map((x) => x.key).join('、') : '') + '，至少要 ' + Q.minAnchors + ' 個、且不能全是數字）'
        + '。改法：寫出路由或頁名、按哪顆鈕、填什麼值、讀回哪個欄位——「開 `/orders/list` → 按「匯出」→ 讀回 `OrderNo` 欄與畫面一致」' });
    }
  }
  // 2 反向／終止分支：每種逐一交代
  if (cells[1] && SQ_KINDS.length) {
    const w = sqJudgeReverse(texts[1]);
    if (w.length) bad.push({ slot: 1, why: w.join('；') });
  }
  // 3 狀態序列：至少 minSteps 步、步驟要具體（有錨點，或至少 2 步不是「開頁／點按鈕／存檔」這類泛用動作）；
  //   例外：不適用＋實質理由（拿掉空詞後 ≥6 字，「同上」不算）
  if (cells[2]) {
    const t2 = texts[2];
    const n = sqSeqSteps(t2);
    const first = t2.split(/\r?\n|[。；;]/).map((s) => s.trim()).filter(Boolean)[0] || '';
    const na = (SQ_CELL_NA.test(first) || SQ_NEG.test(first)) && sqReasonLen(t2.replace(/同上|同前/g, '')) >= 6;
    if (n >= Q.minSteps) {
      if (!anchorList(t2).length && sqSpecificSteps(t2) < 2) bad.push({ slot: 2, why: '步驟都是泛用動作、沒有具體錨點（哪一頁、哪個欄位、填什麼值）。改法：「上傳 `a.pdf` → 刪除 → 再上傳 `b.pdf` → 暫存 → 重開，附件清單只剩 `b.pdf`」' });
    } else if (!na) {
      bad.push({ slot: 2, why: '只數到 ' + n + ' 步（至少 ' + Q.minSteps + ' 步：用 → 串起來或條列；真的沒有多步操作就寫「不適用：<理由>」）。改法：「填 A 欄＝1 → 存檔 → 改成 2 → 撤銷 → 重開，A 欄應為 1」' });
    }
  }
  // 4 跨格重複：兩格實質相同（照貼同一段）
  const flats = texts.map((t) => flatText(stripMarkers(t)));
  for (let i = 0; i < flats.length; i++) for (let j = i + 1; j < flats.length; j++) {
    const a = flats[i], b = flats[j];
    if (a.length < 4 || b.length < 4) continue;
    if (a === b || (Math.min(a.length, b.length) >= 12 && sqBigramJaccard(a, b) >= 0.8)) {
      bad.push({ slot: j, dup: true, why: '與「' + SCOPE_CELLS[i].name + '」格內容實質相同（各格要寫各自的內容，不能貼同一段）' });
    }
  }
  return bad;
}

// 不執行測試的 QA 派工（只做設計、只回答問題）：【範圍展開】標題行宣告不執行，且派工單另有「不開瀏覽器／不跑測試」這類明令時，
// 只判有沒有作答、不判內容品質——兩個條件都要成立，單寫標題繞不過（QA 被明令不准測，就沒有測試範圍可漏）
const SQ_NO_EXEC_HEAD = /不執行|不跑測試|只做設計|純設計|不測試/;
const SQ_NO_EXEC_ORDER = /不要執行任何操作|不執行任何操作|不開瀏覽器|不跑\s*(?:pytest|vitest|jest|playwright|測試)|不得執行測試/;
// 整關判定：多段時取缺項最少的一段；回傳 null＝找不到行首標題
function scopeGate(prompt, tpl) {
  let best = null;
  for (const s of sectionsOf(prompt, '範圍展開')) {
    const noExec = SQ_NO_EXEC_HEAD.test(s.head) && SQ_NO_EXEC_ORDER.test(prompt);
    const bad = judgeScope(s, tpl, !noExec);
    if (!best || bad.length < best.length) best = bad;
    if (!bad.length) break;
  }
  return best;
}
function scopeReason(type, best) {
  const slots = best ? Array.from(new Set(best.map((b) => b.slot))).sort() : [];
  const why = !best
    ? '找不到行首的【範圍展開】標題——只在句中或【回報格式】裡提到（例如「【範圍展開】逐格回報」）不算。'
    : '以下格不合格：' + slots.map((k) => '\n   · ' + SCOPE_CELLS[k].name + '——' + best.filter((b) => b.slot === k).map((b) => b.why).join('；')
      + '\n     要寫：' + SCOPE_CELLS[k].need).join('');
  return '[範圍展開·逐格作答] 派 ' + type + ' 的 prompt 要有行首【範圍展開】，各格逐格寫出本次的實際內容（04 模板六）。本次：' + why
    + '\n   格式：【範圍展開】放在行首，其下各格以格名開頭（可帶編號與 **粗體**）：'
    + SCOPE_CELLS.map((c, i) => (i + 1) + '. ' + c.name).join('；') + '。'
    + '只留佔位 <…>、照抄模板或本訊息的說明、填「無／同上／TBD」沒附理由都不算；「無」後面接一句理由即可（「無（只改匯出檔名，不寫入資料）」）。'
    + (SCOPE_QUALITY ? '內容品質：正向路徑至少 ' + SCOPE_QUALITY.minAnchors + ' 個具體錨點（路由、檔名、按鈕或欄位名、輸入值、識別字）；反向／終止分支 '
      + SQ_KINDS.map((k) => k.name).join('／') + ' 每種都要交代；狀態序列至少 ' + SCOPE_QUALITY.minSteps + ' 步；各格不得貼同一段。' : '')
    + '封閉的 TC 清單是最常見的失敗形狀——派工的人漏想的情境，QA 結構上不會補。請在 prompt 補上後重發同一個 agent。';
}

// ── 對照表閘（見檔頭）────────────────────────────────────────────────────────────
// 任務目標段：行首【目標】【任務】【目的】；沒有就看 Markdown「# 目標」標題段；再沒有就看開頭段（最多 12 行，跳過回報鏈那句）
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
// 基準側是這些字時不算對齊類：共識與規範（「已與使用者對齊」「照慣例」）、驗證對象（「與 DB 一致」「與實際一致」）、
// 改動前後（「與改動前相同」是回歸，不是兩邊契約的對齊）、以及「對齊回合」「對齊到清零」這類流程用語
const ALIGN_NOT_SIDE = /使用者|需求|設計|規格|共識|拍板|簽收|慣例|規範|模板|範本|風格|原則|紀律|預期|期望|驗收|上面|以上|上述|下列|編號|現況|現行|實際|事實|環境|DB|資料庫|實值|讀回|readback|結論|改前|修前|修後|改後|(?:改動|修改|調整|重構|修正)[前後]|先前|之前|原本|原來|原先|現在|舊版|以前|是否|^(?:到清零|清零|表態|回合|的|後|完|了|過|中|下來|下|錄)/i;
const ALIGN_NEG_PRE = /(?:不要|不得|不可|不准|不用|無須|別|勿|禁止|避免)[^，,。；;]{0,2}$/;
// 「改寫過時的測試對齊正式頁」「改斷言對齊實際渲染」是測試跟著產品改，不是兩邊契約的對齊
const ALIGN_TEST_PRE = /(?:測試|斷言|(?<![A-Za-z])tests?(?![A-Za-z])|locator|定位器?)[^，,。；;]{0,6}$/i;
// 版面上的對齊（靠左、置中、欄寬）不是對齊類任務
const ALIGN_LAYOUT = /靠左|靠右|置中|置左|置右|左對齊|右對齊|置頂|對齊方式|對齊(?:推導|規則|不變)|左緣|右緣|欄寬|(?<![A-Za-z])(?:align|justify|text-(?:left|right|center))/i;
const ALIGN_PATS = [
  /(?:比照|照搬|照抄|仿照|看齊|鏡像|參照|(?<![照摘])抄)\s*(?:著)?\s*([^，,。；;（(）)、：:\n]{2,30})/g,
  /對齊(?:到|至|成|於)?\s*([^，,。；;（(）)、：:\n]{2,30})/g,
  /(?:跟|和|與|同)\s*([^，,。；;（(：:\n]{1,30}?)\s*(?:完全|保持|維持)?\s*(?:一樣|一致|相同|同步|對齊|同型|等價)/g,
  // 中間不跨引號：「對兩站做「表格欄位對齊」的驗證」的對齊是引號裡的版面用語
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
        if (ALIGN_NEG_PRE.test(pre) || ALIGN_TEST_PRE.test(pre)) continue;
        hits.push({ match: m[0].trim(), side, text: sent.trim() });
      }
    }
  }
  return hits;
}
// 錨點：讓讀的人知道「到底是哪一支／哪一頁／哪個檔」的字——反引號或引號裡的具體字、檔名、路徑或路由、localhost／port、
// 識別字（camelCase、snake_case、a.b、kebab-case、非泛稱的全大寫縮寫、字母夾數字）、中文畫面元素名（「出貨單列表頁」）。
// 只看長得具不具體，不查存不存在。
const GENERIC_CAPS = new Set(['API', 'UI', 'UX', 'DB', 'QA', 'OK', 'TBD', 'TODO', 'NA', 'PASS', 'FAIL', 'TC', 'URL', 'ID', 'BUG', 'AI',
  'E2E', 'CRUD', 'HTTP', 'JSON', 'HTML', 'CSS', 'JS', 'SQL', 'WIP', 'ETC', 'ABC', 'FOO', 'BAR']);
const GENERIC_NOUN = /頁面?|按鈕?|鈕|結果|畫面|資料|欄位?|系統|東西|項目|元件|某|該|此|這|那|邊|側|相關|對應|目標|指定|特定|一些|任意|等等|值|內容|檔案?|名稱|文字/g;
const ANCHOR_FILE = /[\w\-一-鿿]+\.(?:vue|svelte|cs|cshtml|razor|js|mjs|cjs|ts|tsx|jsx|py|java|kt|go|rb|php|sql|rs|swift|dart|scala|md|json|ya?ml|xml|html|css|scss|xlsx|csv|sh|ps1)(?![A-Za-z])/i;
// 字尾表來自填空區 SCOPE_QUALITY.uiSuffixes（沒設就用最小的一組）；前綴去掉動詞與泛稱後，尾字是「功能／操作／測試…」這類泛稱也不算
const ANCHOR_UI = new RegExp('([一-鿿]{2,8})(?:' + ((SCOPE_QUALITY && SCOPE_QUALITY.uiSuffixes) || '詳情頁|查詢頁|列表頁|編輯頁|頁籤|分頁|按鈕|欄位|彈窗|對話框|下拉選單|表格|頁面|頁') + ')', 'g');
const ANCHOR_UI_HEAD = /^[點按開切進到在於用以把將對從回看讀填選去至往並再後先及與和或的被讓有是]*(?:該|此|這個?|那個?|某個?|各|每個?|任一|任意|其[他它餘]|相關|對應|目標|指定|特定|新|舊|主|首|上|下|同一?|一個|整個|所有|全部|[一兩二三四五六七八九十幾多數]+[個處種支份]?)?/;
const ANCHOR_UI_GENERIC = /(?:功能|頁面|畫面|系統|操作|測試|結果|資料|內容|東西|項目|元件|按鈕|欄位|一般|全部|所有|相關|某|本|下一|上一|每一|第一|整|單|多|一|地|分|行|系|排|序|並|陳|前|後)$/;
function isIdent(m) {
  if (/^[A-Z][A-Z0-9]+$/.test(m)) return !GENERIC_CAPS.has(m);
  if (/[a-z][A-Z]|[A-Z]{2}[a-z]/.test(m)) return true;
  if (/[A-Za-z]{2,}[_.\-][A-Za-z0-9]/.test(m)) return true;
  return /[A-Za-z]/.test(m) && /\d/.test(m);
}
function hasAnchor(raw) {
  const t = stripPlaceholders(String(raw));
  const real = (x) => flatText(x).replace(GENERIC_NOUN, '').replace(NULL_WORDS, '').length >= 2;
  let m;
  const quoted = /`([^`\n]+)`|[「『“"]([^」』”"\n]{1,40})[」』”"]/g;
  while ((m = quoted.exec(t))) if (real(m[1] || m[2])) return true;
  if (ANCHOR_FILE.test(t) || /localhost|:\d{4,5}(?!\d)/i.test(t)) return true;
  if ((t.match(/\/?[A-Za-z0-9_.\-{}]+(?:\/[A-Za-z0-9_.\-{}]+)+\/?|\/[A-Za-z][\w\-]{2,}/g) || []).some((p) => /[A-Za-z]{3}/.test(p))) return true;
  if ((t.match(/[A-Za-z_][A-Za-z0-9_]*(?:[.\-][A-Za-z0-9_]+)*/g) || []).some(isIdent)) return true;
  ANCHOR_UI.lastIndex = 0;
  while ((m = ANCHOR_UI.exec(t))) {
    const core = m[1].split(/[的之與和及或]/).pop().replace(ANCHOR_UI_HEAD, '');
    if (core.replace(GENERIC_NOUN, '').length >= 2 && !ANCHOR_UI_GENERIC.test(core)) return true;
  }
  return false;
}
// 【對照表】五列：來源（兩邊各是什麼）、欄位／元素、順序、值／行為、差異結論
const COMPARE_ROWS = [
  { name: '來源', re: /^(?:對照來源|來源|兩邊|基準)/ },
  { name: '欄位／元素', re: /^(?:欄位|元素|項目)/ },
  { name: '順序', re: /^(?:順序|欄序|次序)/ },
  { name: '值／行為', re: /^(?:值|行為)/ },
  { name: '差異結論', re: /^差異/ },
];
const COMPARE_LABEL = /^(對照來源|來源|兩邊|基準|欄位(?:\s*[／/]\s*元素)?|元素|項目|順序|欄序|次序|值(?:\s*[／/]\s*行為)?|行為|差異(?:結論|處理)?)[*_]*\s*(?:[（(][^）)\n]*[）)])?\s*[:：]\s*(.*)$/;
// 五列寫在同一行（「來源：…；欄位／元素：…；順序：…」）：在「；」後接列名與冒號處切開
const COMPARE_SPLIT = /[；;](?=\s*[*_]*(?:對照來源|來源|欄位|元素|項目|順序|欄序|次序|值|行為|差異)[^：:；;]{0,8}[:：])/;
const compareLead = (l) => String(l).replace(/^[\s>*_#-]*/, '').replace(/^(?:[\d１-９]+[.、．)）]|[①-⑩])\s*/, '').replace(/^[*_]+\s*/, '');
// 來源列兩邊的分隔：；、↔、vs（「A＝x；B＝y」「x ↔ y」）
const SIDE_SPLIT = /[；;]|↔|⇄|⟷|<->|(?<![A-Za-z])vs\.?(?![A-Za-z])/;
// 「A＝」「B 側：」是側名標籤，不是內容：照貼模板只剩「A＝ ；B＝ 」不得算作答
const SIDE_TAG = /(^|[；;↔⇄⟷\s])\s*[ABab](?:\s*側)?\s*[＝=:：]/g;
// 一段【對照表】的判定：回傳缺失說明（空＝合格）
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
  COMPARE_ROWS.forEach((r, k) => {
    if (rows[k] === undefined) { bad.push('缺「' + r.name + '」列'); return; }
    const text = k === 0 ? stripPlaceholders(rows[k].join('\n')).replace(SIDE_TAG, '$1') : rows[k].join('\n');
    if (!hasRealText(text)) { bad.push('「' + r.name + '」沒寫內容（只留佔位、空詞，或寫不適用沒附理由）'); return; }
    if (k === 0) {
      const sides = text.split(SIDE_SPLIT).filter((s) => hasRealText(s));
      if (sides.length < 2) { bad.push('「來源」只寫出一側（要寫兩邊各是什麼，用「；」或「↔」分開：A＝…；B＝…）'); return; }
      const vague = sides.filter((s) => !hasAnchor(s));
      if (vague.length) bad.push('「來源」的「' + vague.map((s) => s.trim().slice(0, 20)).join('」「') + '」沒有具體錨點（路由、檔名、檔:行、識別字或畫面元素名）');
    }
  });
  return bad;
}
// 任務目標不是對齊類回傳 null；是的話回傳 { hits, bad }（bad＝null 表示找不到行首【對照表】，[] 表示合格）
function compareGate(prompt) {
  const hits = alignHits(goalText(prompt));
  if (!hits.length) return null;
  let best = null;
  for (const s of sectionsOf(prompt, '對照表')) {
    const bad = judgeCompare(s);
    if (!best || bad.length < best.length) best = bad;
    if (!bad.length) break;
  }
  return { hits, bad: best };
}
function compareReason(type, cg) {
  return '[對照表] 派 ' + type + ' 的任務目標是對齊類（命中：「' + cg.hits.slice(0, 2).map((h) => h.match).join('」「') + '」），'
    + 'prompt 要有行首的【對照表】格（03 矩陣 B10；04 共通規則「對齊類任務必帶【對照表】」）。本次：' + (cg.bad ? cg.bad.join('；') : '找不到行首的【對照表】標題')
    + '\n   格式（五列，各寫本次的實際內容）：'
    + '\n   【對照表】'
    + '\n   - 來源：A＝<基準側，附路由／檔:行／識別字>；B＝<要對齊的一側，同樣附錨點>'
    + '\n   - 欄位／元素：<兩邊的項目清單怎麼程式化抓（DTO 屬性、匯出表頭、畫面表頭、enum 值），窮舉不抽樣>'
    + '\n   - 順序：<要比的順序（欄序、排序、判斷順序）；真的無順序可言寫「不適用＋理由」>'
    + '\n   - 值／行為：<逐項要比的值或行為（顯示值、型別、空值、守門）>'
    + '\n   - 差異結論：<每個差異標「已消除」或「刻意保留＋理由」，回報貼回逐項對照表>'
    + '\n   只目測幾個點就說「對齊了」，漏欄位、欄序顛倒、多一欄都看不出來——對照表逼派工的人先寫出兩邊各是什麼、要比哪些項目。'
    + '\n   判斷命中的是一般用語、不是對齊類任務時：向使用者說明並請示，不得為了過閘改寫【目標】措辭。'
    + '請在 prompt 補上後重發同一個 agent。';
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
let hookError = null;   // stdin 壞或標記表檢查本身丟例外：fail-open 但 loud（見下方 'end' 處理）
const notes = [];   // 不擋、但要讓模型知道的提醒（例：設計文件路徑判不準而沒驗）
function contentCheckNote() {
  return '[派工紀律] ⚠ 派工內容檢查故障（' + (contentCheckError && contentCheckError.message)
    + '）：【驗收條件】有沒有寫內容、【測試資料來源】有沒有作答、引用的設計文件章節齊不齊、【範圍展開】逐格作答、對齊類任務的【對照表】，'
    + '這次可能沒檢查到，已放行（標記表的檢查照常）。'
    + '請自行確認這幾項；hook 鏽蝕要修（.claude/hooks/check-review-discipline.js），勿靜默忽略。';
}
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  if (!raw.trim()) process.exit(0);   // 空 stdin＝手動執行不是故障，安靜放行
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
      if (rule.when === false) continue;   // 填空區開關關掉的規則（預設：必讀 CLAUDE.md／詞彙表兩條）
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
      // 【範圍展開】逐格作答：只在字樣出現時驗（整個沒寫由標記表報，不重複報）
      if (inList(SCOPE_AGENTS) && prompt.includes('【範圍展開】')) {
        SQ_ROOT = projectRoot(input);
        const tpl = scopeTemplateHints(SQ_ROOT);
        if (tpl.error) {
          notes.push('[範圍展開·沒讀到模板] ⚠ 讀不到 04 模板六【範圍展開】原文（' + tpl.error + '）：本次只剝佔位 <…> 與本閘的格說明，'
            + '照貼模板說明文字的格可能被當成已作答。請確認 ' + SCOPE_TEMPLATE_DOC + ' 存在、模板六四格的格式沒改'
            + '（路徑與格名在 .claude/hooks/check-review-discipline.js 的 SCOPE_TEMPLATE_DOC／SCOPE_CELLS）。');
        }
        const best = scopeGate(prompt, tpl);
        if (!best || best.length) reasons.push(scopeReason(type, best));
      }
      if (inList(COMPARE_AGENTS)) {
        const cg = compareGate(prompt);
        if (cg && (!cg.bad || cg.bad.length)) reasons.push(compareReason(type, cg));
      }
    } catch (e) {
      contentCheckError = e;
    }
  } catch (e) {
    // 不再空 catch（2026-10-18 紅藍對抗 R2 R1-6，harness 05 §6.4 fail-open 但 loud）：stdin 壞或標記表檢查丟例外時
    // 舊版靜默放行，派工紀律整段失效也沒人發現。仍放行，但 stderr 與 additionalContext（或併進 deny 理由）都要講。
    hookError = e;
  }
  if (hookError) {
    const msg = '[派工紀律] hook 內部錯誤，本次放行：' + String((hookError && hookError.message) || hookError).split('\n')[0];
    try { process.stderr.write(msg + '\n'); } catch (e) { /* 連 stderr 都寫不了就只剩放行 */ }
    notes.push(msg + '。這次沒有檢查派工 prompt 的必填標記（【目標】【驗收條件】等）與派工內容，請自行對照 .claude/harness/04-delegation-templates.md；hook 要修：.claude/hooks/check-review-discipline.js');
  }

  if (reasons.length) {
    const head = reasons.length === 1
      ? '[派工紀律] 派工 prompt 有 1 項未過閘，補齊後重發同一個 agent（不得改派其他 agent type 繞過）：'
      : '[派工紀律] 派工 prompt 有 ' + reasons.length + ' 項未過閘（這是完整清單），'
        + '全部補齊後一次重發同一個 agent（不得改派其他 agent type 繞過）：';
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
