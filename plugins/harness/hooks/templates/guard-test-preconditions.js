#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)：跑測試前的前置條件閘——「指令是在跑測試 → 先驗一組前置條件 → 不符就擋」。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-test-preconditions.js\"", "timeout": 15 }] }]
//
// 為什麼要機械擋：來源專案有兩支同形狀的守門，病灶都是「測試跑下去才發現環境不對，而症狀完全不指向環境」。
//   ① 寄信收斂：本機把收件人收斂到自己信箱的覆寫遺失了沒人發現，整套測試跑到一半才被攔下，
//     期間寄信流程真的寄給了好幾位同事。事後又兩度只看了「附加自己信箱」那一行就宣稱「只寄一人」，
//     但同一區塊另一個呼叫的語意是「保留」原收件人——片面檢查等於沒檢查。所以判準要讀整個區塊，不是抓單行。
//   ② 測試環境對齊：自己起了一套服務，卻套用了給另一套服務用的環境檔，於是幾個值全錯，
//     而症狀分別是「查 0 筆（像功能壞了）」「找不到元素逾時（像畫面沒載入）」「URL 變相對路徑（像鏈路斷了）」，
//     沒有一個指向「環境檔拿錯」，繞了十幾輪才追到真因。
// 共同形狀：前置條件是機械可判的事實（某設定檔內容、某環境變數），卻只存在於人的紀律裡。
//
// 兩個典型用法（init 依盤點結果擇一或併用）：
//   ① 寄信收斂——Phase 1 掃到寄信程式碼且專案有測試指令時：
//      { id: 'mail-sink', kind: 'file', path: 'config/mail.test.json',
//        mustMatch: '"host"\\s*:\\s*"(localhost|127\\.0\\.0\\.1)"',          // SMTP 指向本機收信器
//        mustNotMatch: '"cc"\\s*:\\s*\\[\\s*"',                              // 副本不得有人
//        reason: '測試會觸發寄信；SMTP 若不是本機收信器，信會真的寄給真人。',
//        fix: '把測試設定的 SMTP 指回本機收信器（例：本機 SMTP 捕獲工具），或把收件人硬收斂到單一測試信箱。' }
//      收件人收斂寫在程式碼裡的專案，改驗那支寄信程式：用 within 截出「非正式環境」那個區塊，
//      mustMatch 驗收件人寫死為單一信箱、mustNotMatch 驗區塊內沒有會把原收件人留下來的呼叫。
//   ② 測試環境對齊——專案測試依賴環境變數（.env.test、測試設定讀 process.env／os.environ）時：
//      { id: 'api-base', kind: 'env', env: 'TEST_API_BASE', matches: '^https?://localhost:\\d+',
//        reason: '測試打的服務要跟自己起的那一套同源；指到別套服務，種資料與查資料會落在不同地方。',
//        fix: '用這套服務自己的環境檔（source 它再跑），不要借用別套環境的既有檔。' }
//      「指向同一套服務」用多條 env 檢查的 matches 釘在同一個主機／埠來表達。
//
// 兩條判定路徑（兩支規則引擎共用同一套設計）：
//   · 語法樹路徑（預設）：同目錄的 shell-model.js 用 tree-sitter 把指令解析成語法樹（bash 與 PowerShell 各一套文法），
//     依 shell 的真實語意判「哪些指令會執行」與「每個指令實際拿到的環境值」——子殼範圍、條件執行、命令替換的先後、
//     引號、heredoc、殼包裝的內層都依語法樹，不靠字面猜。解析器由 /harness:init 在 .claude/hooks 以 npm ci 安裝
//     （同目錄 package.json 釘版本：tree-sitter、tree-sitter-bash、tree-sitter-powershell，皆 MIT 授權、
//     附六個平台的預編譯檔，不需要編譯器；版本由 package-lock.json 釘住）；團隊成員拉下專案後要在 .claude/hooks 跑一次 npm ci。
//   · 正則路徑（退回）：解析器沒裝、載入失敗、設 HARNESS_SHELL_PARSER=off，或語法樹有錯誤節點時，整串改走原本的正則判法。
//     錯誤節點不一定是指令寫壞：PowerShell 文法把合法的 `./deploy.ps1`、`--x=值`、單獨的 `--` 都解析成錯誤，
//     這類指令一律走正則路徑。準確度較低（下方已知極限標 [正則] 的條目），但不會整個失效。
//   兩條路徑都以真 shell（Git Bash、Windows PowerShell 5.1）逐條對照驗證過，細節見 plugin 的 CHANGELOG。
//   probe-hooks.js 預設走語法樹、加 --parser=off 走正則路徑，改動引擎後兩者都不得有 FAIL
//   （標 "parser": "only" 的案例是正則路徑的已知極限，走正則路徑時略過並計數）。
//
// CHECKS 欄位：
//   id       代號（訊息用）。
//   when     選填，字串 regex（不分大小寫），比對整條指令；有填才套用這條。多子專案的 repo 用它分範圍——
//            冷啟實測過：web 用 vitest、api 用 node --test，檢查不分範圍時 web 跑 vitest 也被要求資料庫連線變數。
//            例：{ id: 'api-db', kind: 'env', env: 'DATABASE_URL', when: '(^|[\\s/\\\\])api\\b|node\\b[^\\n]*--test', … }
//   kind     'file'：讀 path（相對專案根）的內容，mustMatch 必須命中、mustNotMatch 不得命中（字串 regex，
//                    也可給陣列＝每條都要成立）。選填 within（字串 regex）：只驗第一個命中的區塊，
//                    截不到區塊＝要驗的東西不在，照不符擋下。讀不到檔＝無法確認＝擋（選填 onMissing: 'allow' 改為放行）。
//            'env' ：同一串裡每一條測試指令各自判，值＝那條測試指令執行時**實際拿到**的值：照 bash 的語意
//                    逐行模擬前面的指令——`export`／`declare -x`／`set -a` 之後的賦值／`$env:` 會傳給子程序，
//                    只寫 `X=v` 或 `source` 沒寫 export 的環境檔只是 shell 變數（子程序拿不到）；`unset`、`env -u`、
//                    `env -i`、`export -n` 會讓它消失；管線與子殼裡的設定不回到外層；這條自己的前綴最後套用；
//                    這條自己的 `node --env-file=<檔>` 不覆蓋已存在的變數。環境檔的 `#` 註解行不算。
//                    環境檔的相對路徑以「同一條指令裡、在它之前的 cd／pushd／Set-Location／sl」累積出的目錄為基準
//                    （相對 cd 疊加、絕對 cd 取代）——`cd api && node --env-file=.env.test --test` 讀的是
//                    api/.env.test；冷啟交叉驗證曾抓到對專案根解析而誤擋環境正確的指令。
//                    equals（全等）或 matches（字串 regex）；兩者都沒給＝只要求存在。空字串視同未設。
//   reason   為什麼要這個前置條件（寫機制與後果）。
//   fix      怎麼做才會放行。
//
// 「是不是在跑測試」的判定：指令依 ; && || | 換行切段（引號內不切），只印字／只讀的段落
// （echo、grep、cat…）不算；heredoc 主體是資料不是指令；`bash -c '…'`／`powershell -Command "…"`
// 拆開內層再判。剩下的每一段去掉前綴環境變數後，以 TEST_COMMAND 比對段首（兩條路徑相同）。
// 直接以路徑叫的執行器（`.venv/bin/pytest`、`.venv\Scripts\pytest.exe`）取檔名比對，Windows 的 .exe／.cmd／.bat／.ps1 一併去掉；
// npm 系在 test 前帶選項（`npm --prefix api test`、`pnpm -C api test`、`yarn workspace api test`）也算在跑測試。
// 所以 `cat pytest.ini`、`grep -n test package.json`、寫一份提到測試指令的文件都不會被攔——
// 來源專案首版就曾把診斷 hook 自己的 grep 指令、寫進度帳本的 heredoc 誤擋。
// 帶 --collect-only／--help／--list 這類「不真的執行」旗標的也放行。
//
// ⚠ 刻意沒有豁免註解：來源專案曾設「指令帶某個註解就放行」，結果整輪每條指令都習慣性帶著它，
// 守門從頭到尾沒生效過一次；而豁免唯一能豁免的，正是守門唯一該守的對象（真的在跑測試的指令）。
// 驗證本 hook 不需要真的跑測試：直接把 PreToolUse payload 餵給它即可（probe-hooks.js 就是這樣做）。
//
// 已知極限（標 [正則] 的只在退回正則路徑時成立，語法樹路徑已正確判）：
//   · 本 hook 驗的是「檔案與環境變數」，不是跑中的程序——改完設定要重啟服務才生效，擋下訊息會提醒。
//   · 條件與函式只做保守判：條件區塊、迴圈、函式本體裡的測試一律當成會跑（`while false; do npm test; done` 照擋）。
//     條件區段裡的設定兩種情況都算（有發生、沒發生各得一個可能值），每一個都符合才放行——`[ -f .env.test ] && source .env.test`
//     在檔案與繼承值都對時放行、會把正確值改壞時擋；沒有繼承值時「沒發生」那一支是空值而擋。迴圈體後段的設定當成也可能落在
//     前段之前；函式本體、trap 裡的設定與 read、printf -v、`for X in`、`declare -n`、非字面 source、含展開的 eval 這類寫入，
//     讓該變數判成無法確認；source 進來的檔案裡的條件式寫入與巢狀 source、指令名是展開時引數裡的變數名，同樣判成無法確認。
//     這一類擋下時訊息會建議在測試指令前面直接帶字面值——只有字面值的前綴蓋得掉「未知」，引用同名變數的前綴（`X="$X"`）仍是未知。
//   · PowerShell 設環境變數只認最外層、名字大小寫一致、值為字面值的 `$env:X = '…'`（`$Env:` 前綴不分大小寫）／
//     `$env:X = $null`；其他寫法（Env: 項目操作、`${env:X}`、SetEnvironmentVariable、`+=`、名字大小寫不同、寫在區塊或條件裡）
//     判成值無法確認而擋；Env: 磁碟機被變數語法以外的方式碰到時，所有環境變數一律判成無法確認。
//   · 環境值只認得殼裡的設定、source／. 載入的檔、node --env-file；其他載入方式（dotenv-cli、
//     測試框架設定檔裡的 env 區塊、程式內 require('dotenv')）看不到，會落到 hook 程序環境變數判——
//     專案若用這些方式，該條檢查改用 kind: 'file' 直接驗那份環境檔的內容。
//   · when 比對的是指令字面：`npm test` 在哪個子專案跑取決於 cwd 時，when 要能從字面分辨
//     （`cd api && …`、`--prefix api`、`-w api`），分辨不出就會落到「不套用」。
//   · when 比對**整串指令**（為了看得到前面的 `cd api`），不是逐條：同一串裡同時跑兩個子專案的測試
//     （`cd api && node --test; cd ../web && npm test`）時，限定 api 的檢查也會套到 web 那條，可能多擋。
//     環境值與「是不是測試」則是逐條判的。
//   · 環境檔的目錄追蹤只認字面的切目錄動作：`cd -`、`cd ~`、`cd $DIR`、不帶引數的 cd 判讀不了，
//     一律退回專案根解析。判錯的後果是找不到環境檔 → 落到 hook 程序環境變數判（多半是擋，訊息會寫變數未設定）。
//   · 會話先前另一條指令裡的 cd 看不到（每條指令只看自己的字面）；起點是 hook 收到的 cwd。
//   · sudo 預設會重設環境（env_reset），外層匯出的變數多半傳不進去；引擎不模擬這點，照一般前綴處理。
//   · 腳本檔的內容看不到（`bash run.sh` 裡跑的測試不會被認出）；餵給殼的 stdin 只認 echo／printf、heredoc、here-string。
//   · [正則] PowerShell 的反引號續行（行尾 `）不接回；bash 的反斜線續行有接。
//   · [正則] heredoc 的開頭 `<<TERM` 不辨識是否在引號裡：`echo '<<EOF'` 會把之後到 EOF 的行當成資料略過。
//   · [正則] 條件不建模：`false && export X=v` 會被當成已設（漏擋方向）；`( … )` 子殼不辨識範圍；
//     兩次各自獨立的 `bash -c '…'` 之間分不出是不是同一個子殼；包裝指令與子殼裡的 cd 照同一條線性順序算。
//   · [正則] 函式本體裡的測試、here-string 與 stdin 餵給殼的腳本裡的測試認不出來；迴圈體後段的設定不回到前段；
//     eval、read、printf -v、`for X in`、`declare -n`、`source <(…)` 寫進變數看不到。
// fail-open：解析失敗、regex 寫壞、任何例外一律放行（壞掉的檢查只印提醒，不擋路）。

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 「這條指令是在跑測試」的樣式（= Phase 1 盤點到的測試指令；比對每段段首，不分大小寫）。
// 預設涵蓋常見測試執行器；專案有自訂測試腳本名（例：make e2e）就加進來。
const TEST_COMMAND = String.raw`^(?:(?:npm|pnpm|yarn|bun)(?:\s+(?:--?[\w-]+(?:=\S+|\s+(?!(?:run|test)\b)[^\s-]\S*)?|workspace\s+\S+))*\s+(?:run\s+)?test\b|(?:npm|pnpm|yarn|bun)(?:\s+(?:--?[\w-]+(?:=\S+|\s+(?!(?:run|test)\b)[^\s-]\S*)?|workspace\s+\S+))*\s+run\s+(?:test|e2e)[\w:-]*|npx\s+(?:jest|vitest|mocha|playwright\s+test|cypress\s+run)\b|(?:jest|vitest|mocha)\b|node\b[^\n]*\s--test\b|(?:(?:uv|poetry|pipenv)\s+run\s+)?(?:python[0-9.]*\s+-m\s+)?pytest\b|go\s+test\b|cargo\s+test\b|mvn\b[^\n]*\b(?:test|verify)\b|(?:\./)?gradlew?\b[^\n]*\btest\b|(?:bundle\s+exec\s+)?rspec\b|(?:vendor/bin/)?phpunit\b)`;
// 前置條件表（= 寄信收斂／環境對齊兩類盤點結果，每項一列；格式見檔頭）。預設空陣列＝全放行。
const CHECKS = [];
// 擋下訊息開頭的標籤（只影響訊息文字）。
const LABEL = '測試前置條件守門';
// ────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// 帶這些旗標時測試執行器不會真的跑測試（只列清單、印說明）。
const NOT_A_RUN = /(?:^|\s)(?:--collect-only|--co|--help|--list|--listTests|--version|-h)(?=\s|$)/i;
const MENTION_VERBS = new Set([
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'head', 'tail',
  'wc', 'ls', 'dir', 'man', 'which', 'where', 'type', 'tee', 'findstr', 'find', 'vi', 'vim', 'nano', 'code',
  'write-host', 'write-output', 'select-string', 'sls', 'get-content', 'gc', 'get-command', 'out-file',
]);
const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);

// 「後面接著真正要跑的指令」的前綴程式與它們的選項（sudo -u x、env -u x、nice -n 5、timeout -s KILL 10…）。
// 判動詞、取環境值的前綴、拆 find／xargs 的段首三處共用這一份——以前三處各寫一份清單，改一處就漏其他處
// （sudo -u postgres psql 的動詞被認成 -u；env -u X 在段首判斷裡認不得）。
const ASSIGN_SRC = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)`;
// 選項的值：可以是加引號的（`sudo -p "Password: "`、`env --chdir="/path with spaces"`），引號裡的空白不算斷點
const VAL_SRC = String.raw`(?:"[^"]*"|'[^']*'|[^\s"';&|])+`;
const RUNNER_PREFIX_SRC = [
  String.raw`sudo(?:\s+(?:-[ugphCDrtTU](?:\s*|=)` + VAL_SRC + String.raw`|--[a-z-]+=` + VAL_SRC + String.raw`|--|-[A-Za-z]+))*`,
  String.raw`env(?:\s+(?:-i|--ignore-environment|-u\s+` + VAL_SRC + String.raw`|--unset=` + VAL_SRC + String.raw`|-C\s+` + VAL_SRC + String.raw`|--chdir=` + VAL_SRC + String.raw`|-))*`,
  String.raw`nice(?:\s+(?:-n\s*` + VAL_SRC + String.raw`|-\d+|--adjustment=` + VAL_SRC + String.raw`))*`,
  String.raw`timeout(?:\s+(?:-[sk]\s*` + VAL_SRC + String.raw`|--[a-z-]+(?:=` + VAL_SRC + String.raw`)?|-\S+))*\s+` + VAL_SRC,
  String.raw`time(?:\s+-p)?`,
  String.raw`nohup`,
  String.raw`command(?:\s+-p)?`,
  String.raw`exec(?:\s+-a\s+` + VAL_SRC + String.raw`|\s+-[cl]+)*`,
  String.raw`builtin`,
].join('|');
const KEYWORD_SRC = String.raw`if|then|do|else|elif|while|until|!`;
// 判動詞：一次剝一層（賦值、前綴程式連同選項、控制關鍵字）
const PREFIX_STEP_RE = new RegExp('^(?:' + ASSIGN_SRC + '\\s+|(?:' + RUNNER_PREFIX_SRC + ')\\s+|(?:' + KEYWORD_SRC + ')\\s+)');
// 拆 find／xargs 前的段首：賦值與前綴程式整串剝掉
const LEAD_RE = new RegExp('^(?:' + ASSIGN_SRC + '\\s+|(?:' + RUNNER_PREFIX_SRC + ')\\s+)*');
// 取環境值的前綴：再加上殼包裝名（包裝展開後的 X=1 bash Y=2 cmd）
const ENV_PREFIX_RE = new RegExp('^(?:(?:bash|sh|zsh|dash|cmd|powershell|pwsh|' + ASSIGN_SRC + '|' + RUNNER_PREFIX_SRC + ')\\s+)*');

// heredoc 主體是資料：直接剝掉（寫一份提到測試指令的文件，不是在跑測試）。
// 例外兩種要留：由 shell 開啟的（`bash <<EOF`）主體每行都是指令；結束標記沒加引號的主體會展開，
// 裡面的 `$(…)`／反引號會真的執行（`cat <<EOF` 夾著 `$(pytest)` 就是在跑測試）。
function stripHeredocs(cmd) {
  const out = [];
  let term = null;
  let asCommands = false;
  let expands = false;
  for (const line of cmd.split('\n')) {
    if (term === null) {
      out.push(line);
      const m = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
      if (m) {
        term = m[1] || m[2] || m[3];
        expands = !!m[3];
        asCommands = /(?:^|[\s;&|(])(?:bash|sh|zsh|dash)(?:\s+-\S+)*\s*$/.test(line.slice(0, m.index));
      }
    } else if (line.trim() === term) {
      term = null;
    } else if (asCommands) {
      out.push(line);
    } else if (expands) {
      for (const inner of substitutions(line)) out.push(inner);
    }
  }
  return out.join('\n');
}

function splitSegments(cmd) {
  const segs = [];
  let cur = '';
  let q = null;
  // segs.piped[k]：第 k 段是否在管線裡（管線各段跑在子殼，裡面的設定不回到外層）
  segs.piped = [];
  let prevPipe = false;
  const push = (pipe) => { segs.push(cur); segs.piped.push(!!pipe || prevPipe); prevPipe = !!pipe; cur = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '\\' && i + 1 < cmd.length && cmd[i + 1] !== '\n') { cur += ch + cmd[++i]; continue; }
    if (ch === '#' && (cur === '' || /\s$/.test(cur))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '|') { if (cmd[i + 1] === '|') { i++; push(false); } else push(true); continue; }
    if (ch === '\n' || ch === ';') { push(false); continue; }
    if (ch === '&') {
      if (cmd[i - 1] === '>' || cmd[i + 1] === '>') { cur += ch; continue; }
      if (cmd[i + 1] === '&') i++;
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return segs;
}

// 去掉前綴環境變數與 sudo／env 之類的前綴，回傳「動詞＋其餘」。
function stripPrefix(seg) {
  let t = seg.trim().replace(/^[({]+\s*/, '');
  for (;;) {
    // env 的選項（-i、-u X）也是前綴的一部分，否則 `env -u X pytest` 認不出是在跑測試
    const m = PREFIX_STEP_RE.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t;
}
function verbOf(t) {
  const w = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(t);
  return w ? String(w[1] || w[2] || w[3]).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '') : '';
}

// 殼包裝（`bash -c '…'`、`cmd /c "…"`、`powershell -Command "…"`）的內層指令。取法依殼而不同：
//   bash 系（bash／sh／zsh／dash）：-c 後面「一個詞」就是指令，之後的是 $0、$1…；加引號就自己配對引號拿內容，
//     沒加引號（`bash -c pytest`）就是那個詞。後面接引數或重導向（`_ arg`、`> "out.log" 2>&1`）都不影響。
//   cmd 的 /c、/k（Git Bash 上寫成 //c、//k）與 PowerShell 的 -Command：後面「整串」都是指令（`cmd /c kubectl apply -f prod.yaml`）；
//     整串剛好是一個加引號的字串時取引號內容。
// 以前用「一路比對到行尾」的正則，每多一種尾巴寫法就漏一次。沒有 -c 就回 null。
function wrapperInner(rest, verb) {
  // 依殼的種類找它自己的「執行指令」旗標（找第一個像旗標的會被 PowerShell 的 -exec 先命中而整個不拆）：
  //   bash 系：-c，可與其他短旗標合寫（-lc、-ec），大小寫有別（-C 是別的旗標）
  //   cmd：/c、/k；Git Bash（MSYS）上要寫成 //c（單斜線會被轉成路徑、內層不執行），兩種都認
  //   PowerShell：-Command 的任何前綴縮寫（-c、-Com、-comm），前面可以是 - 、-- 或 //，不分大小寫；
  //   -CommandWithArgs（-cwa）同樣帶指令；-EncodedCommand（-e、-ec、-enc…，-encodeda 起是 -EncodedArguments）解碼後就是指令；powershell.exe 不帶旗標時第一個位置引數就是指令
  const v = String(verb || '').toLowerCase().replace(/\.exe$/, '');
  // 與語法樹路徑同一套判準：從殼名後面開始，只在連續的旗標區裡找；碰到腳本名（或 pwsh 的位置引數、-File）就停——
  // 腳本名之後的 `-c` 是腳本自己的參數（`bash release.sh -check …`、`powershell -File x.ps1 -c …`）
  const tok = /("[^"]*"|'[^']*'|[^\s]+)/g;
  const words = [];
  let t;
  while ((t = tok.exec(rest))) words.push({ w: t[1], end: t.index + t[0].length, start: t.index });
  if (words.length && words[0].w.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '') === v) words.shift();
  let i = null;
  if (/^(?:bash|sh|zsh|dash)$/.test(v)) {
    for (let k = 0; k < words.length; k++) {
      const w = words[k].w;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) { i = words[k].end; break; }
      if (/^[-+][oO]$/.test(w) || /^--(?:rcfile|init-file)$/.test(w)) { k++; continue; }
      if (w === '--' || !/^[-+]/.test(w)) break;
    }
  } else if (v === 'cmd') {
    const hit = words.find((x) => /^\/{1,2}[ck]$/i.test(x.w));
    if (hit) i = hit.end;
  } else if (v === 'powershell' || v === 'pwsh') {
    for (let k = 0; k < words.length; k++) {
      const w = words[k].w;
      if (/^(?:-{1,2}|\/{1,2})(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?|cwa|commandwithargs)$/i.test(w)) { i = words[k].end; break; }
      if (/^(?:-{1,2}|\/{1,2})e(?:c|n(?:c(?:o(?:d(?:e(?:d(?:c\w*)?)?)?)?)?)?)?$/i.test(w)) {
        try { return words[k + 1] ? Buffer.from(words[k + 1].w, 'base64').toString('utf16le') : null; } catch (e) { return null; }
      }
      if (/^(?:-{1,2}|\/{1,2})(?:f|fi|fil|file)$/i.test(w)) return null;          // 腳本檔內容看不到
      // 會吃值的旗標認完整的前綴縮寫（-wi、-inp、-ou、-wo…）；下一個詞不是旗標才當成它的值；
      // pwsh 的 -i、-in 是 -Interactive，不吃值（powershell.exe 的 -i 才是 InputFormat）
      if (/^(?:-{1,2}|\/{1,2})(?:ex\w*|ep|w(?:i(?:n\w*)?)?|v(?:e\w*)?|i(?:n(?:p\w*)?)?|o(?:u(?:t\w*)?)?|psc\w*|conf\w*|cus\w*|sett\w*|wd|wo(?:r(?:k(?:i(?:n(?:g(?:d\w*)?)?)?)?)?)?|if|of|to(?:k(?:e(?:n)?)?)?|utc\w*|ea|encodeda\w*)$/i.test(w) &&
          !(v === 'pwsh' && /^(?:-{1,2}|\/{1,2})in?$/i.test(w))) {
        if (words[k + 1] && !/^[-\/]/.test(words[k + 1].w)) k++;
        continue;
      }
      if (/^(?:-{1,2}|\/{1,2})\w/.test(w)) continue;
      // 第一個位置引數：powershell.exe 預設是 -Command，pwsh 預設是 -File
      if (v === 'powershell') i = words[k].start;
      break;
    }
  } else {
    const m = /\s(?:-[A-Za-z]*c|\/{1,2}[ck]|-command)\s+/i.exec(rest);
    if (m) i = m.index + m[0].length;
  }
  if (i === null) return null;
  const tail = rest.slice(i).trim();
  const quoted = (s) => {
    const q = s[0];
    if (q !== '"' && q !== "'") return null;
    let body = '';
    for (let k = 1; k < s.length; k++) {
      const ch = s[k];
      if (ch === q) return { body, end: k + 1 };
      // 雙引號裡的反斜線只跳脫 $ ` " \ 與換行，其他字元前的反斜線原樣保留（bash 的規則）
      if (ch === '\\' && q === '"' && k + 1 < s.length && '$`"\\\n'.includes(s[k + 1])) { body += s[++k]; continue; }
      body += ch;
    }
    return null;
  };
  if (/^(?:cmd|powershell|pwsh)$/.test(verb || '')) {
    const qd = quoted(tail);
    return qd && !tail.slice(qd.end).trim() ? qd.body : tail;
  }
  const qd = quoted(tail);
  if (qd) return qd.body;
  const w = /^[^\s;&|<>]+/.exec(tail);
  return w ? w[0] : null;
}

// find -exec／-execdir／-ok／-okdir 與 xargs 會執行後面接的指令（`find . -exec pytest {} \\;`、`ls | xargs pytest`），
// 拆出那段指令當成一條新指令判；`{}` 佔位與結尾的 `\\;`／`+` 去掉。xargs 的選項（會吃值的 -n／-I／-L／-P／-d／-E／-s／-a）跳過。
function runnerCommands(seg) {
  const out = [];
  // 只看段首的動詞（去掉 X=v、sudo、env、nice、nohup、timeout N 這類前綴）：
  // `man xargs`、`grep -r xargs src` 裡的 xargs 只是字，不是在執行後面的東西
  const lead = seg.trim().replace(LEAD_RE, '');
  const head = (lead.split(/\s+/)[0] || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (head === 'find') {
    // 終止符是字面的 `\;`、`;` 或 `+`；每個 -exec 各自一條（`-exec a \; -exec b \;` 是兩條，不能合併）
    for (const m of lead.matchAll(/(?:^|\s)-(?:exec|execdir|ok|okdir)\s+([\s\S]*?)(?:\s(?:\\;|;|\+)(?=\s|$)|$)/g)) {
      const c = m[1].replace(/(^|\s)\{\}(?=\s|$)/g, ' ').trim();
      if (c) out.push(c);
    }
  } else if (head === 'xargs') {
    const w = lead.split(/\s+/);
    let k = 1;
    while (k < w.length && w[k].startsWith('-')) k += /^-[nILPdEsa]$/.test(w[k]) ? 2 : 1;
    const c = w.slice(k).join(' ').trim();
    if (c) out.push(c);
  }
  return out;
}

// 實際會執行的指令段，包裝指令拆開內層。每段回傳 { raw：原文（取環境值用）, run：去掉前綴後（判是不是測試用） }。
function executedSegments(cmd, depth) {
  const out = [];
  // 反斜線續行（`npm \` 換行 `test`）是同一條指令，先接回，否則換行會被當成分段
  const parts = splitSegments(depth === 0 ? stripHeredocs(cmd.replace(/\\\r?\n/g, ' ')) : cmd);
  for (let k = 0; k < parts.length; k++) {
    const seg = parts[k];
    const piped = parts.piped[k];
    // 命令替換／find -exec／xargs 拆出的指令跑在子殼（或另一個程序）：原文前面標上 sh 脈絡，裡面的設定不回到外層
    if (depth < 3) {
      for (const inner of substitutions(seg).concat(runnerCommands(seg))) {
        out.push(...executedSegments(inner, depth + 1).map((x) => ({ raw: 'sh ' + x.raw, run: x.run, piped: x.piped })));
      }
    }
    const t = stripPrefix(seg);
    if (!t) continue;
    const verb = verbOf(t);
    if (MENTION_VERBS.has(verb)) continue;
    if (WRAPPERS.has(verb) && depth < 3) {
      const inner = wrapperInner(t, verb);
      if (inner !== null) {
        // 外層的前綴（`TEST_API_BASE=… bash -c 'npm test'`）內層每條指令都繼承，連同包裝名一起帶上
        // （包裝名是內層的脈絡標記：子殼裡的設定不回到外層）
        const whole = seg.trim();
        const pre = whole.slice(0, whole.length - t.length) + verb + ' ';
        out.push(...executedSegments(inner, depth + 1).map((x) => ({ raw: pre + x.raw, run: x.run, piped: x.piped || piped })));
        continue;
      }
    }
    out.push({ raw: seg.trim(), run: t, piped });
  }
  return out;
}

// 命令替換 `$(…)`／反引號裡的指令會真的執行，不管外層是什麼動詞（`echo "$(git push)"` 會推送）。
// 單引號裡與跳脫過的（`'$(x)'`、`\$(x)`）是字面文字，不執行。
// 逐字元掃：只有不在單引號裡時才認 `$(`，並以括號深度配對取出完整內容——替換裡面的引號原樣保留
// （`echo "$(psql -c 'DROP TABLE x')"` 取出的是 `psql -c 'DROP TABLE x'`，SQL 不能被當成字面剔掉）。
function substitutions(text) {
  const out = [];
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" && q === null) { q = "'"; continue; }
    if (ch === '"') { q = q === '"' ? null : '"'; continue; }
    if (ch === '$' && text[i + 1] === '(') {
      let depth = 0;
      let iq = null;
      let j = i + 1;
      for (; j < text.length; j++) {
        const c = text[j];
        if (iq) { if (c === iq) iq = null; else if (c === '\\' && iq === '"') j++; continue; }
        if (c === '\\') { j++; continue; }
        if (c === "'" || c === '"') { iq = c; continue; }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) break;
      }
      const inner = text.slice(i + 2, j).trim();
      if (inner) out.push(inner);
      i = j;
      continue;
    }
    if (ch === '`') {
      const j = text.indexOf('`', i + 1);
      if (j < 0) break;
      const inner = text.slice(i + 1, j).trim();
      if (inner) out.push(inner);
      i = j;
    }
  }
  return out;
}

// 把一段指令切成詞，引號拿掉並接起來（`loc"al"` → `local`、`"cfg dir/.env"` → `cfg dir/.env`）。
function words(s) {
  const out = [];
  for (const m of String(s).matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) {
    out.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, (x, a, b) => (a !== undefined ? a : b)));
  }
  return out;
}

// 被 bash -c／cmd /c／powershell -Command 展開的內層指令，行首帶著「外層前綴＋包裝名」（`X=1 bash …`）。
// 這段前綴就是它的包裝脈絡：子殼裡的設定不會回到外層，外層已匯出的會傳進子殼。
// 殼名前面可以有賦值與前綴程式（`env bash -c '…'`、`sudo -u x bash -c '…'`），由共用常數產生。
const CTX_RE = new RegExp('^(?:(?:(?:' + ASSIGN_SRC + '|' + RUNNER_PREFIX_SRC + ')\\s+)*(?:bash|sh|zsh|dash|cmd|powershell|pwsh)\\s+)*', 'i');
function ctxOf(line) {
  return CTX_RE.exec(line.trim())[0];
}

// 指令本身的前綴（`X=v cmd`、`env -u X cmd`、`env -i cmd`、包裝展開後的 `X=1 bash Y=2 cmd`），交給 envValueAt 依序套用。
// 引數裡長得像賦值的字串（`node server.js 'NODE_ENV=test'`）不在前綴裡，不算。
function prefixOf(line) {
  const m = ENV_PREFIX_RE.exec(line.trim());
  return m ? m[0] : '';
}

// 指令載入的環境檔：source <檔>、. <檔>、node --env-file=<檔>／--env-file <檔>（依出現順序，後者覆蓋前者）。
// 相對路徑的基準＝同一條指令裡、該環境檔之前的切目錄動作（cd／pushd／popd／Set-Location／sl／chdir）累積出來的目錄：
// 相對 cd 疊加、絕對 cd 取代；`cd -`、`cd ~`、不帶引數、含變數（$／%）等判讀不了的，退回專案根。
// 沒有任何切目錄動作時，依序試 hook 收到的 cwd 與專案根。
// 為什麼要追 cd：`cd api && node --env-file=.env.test …` 的環境檔在 api/ 底下，
// 對專案根解析會找不到（或找到別套的同名檔），把環境正確的指令誤擋——冷啟交叉驗證實際抓到。
function envFilesOf(command, startDir, root) {
  const out = [];
  const stack = [];
  let dir = null;
  // 路徑可加引號，引號內可含空白（`--env-file="./config files/.env.test"`）
  const re = /(?:^|[\s;&|(])(?:(cd|pushd|popd|set-location|sl|chdir)(?:\s+-(?:literal)?path)?(?:\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|"')]+)))?(?=\s*(?:$|[;&|)\n]))|(?:source|\.)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))|--env-file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+)))/gi;
  for (const m of command.matchAll(re)) {
    if (m[1]) {
      const verb = m[1].toLowerCase();
      if (verb === 'popd') { dir = stack.length ? stack.pop() : null; continue; }
      if (verb === 'pushd') stack.push(dir);
      let t = m[2] || m[3] || m[4];
      if (!t || t === '-' || /^~|[$%]/.test(t)) { dir = root; continue; }
      if (process.platform === 'win32') t = t.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
      dir = path.resolve(dir === null ? startDir : dir, t);
      continue;
    }
    const envFileArg = m[8] || m[9] || m[10];
    const file = m[5] || m[6] || m[7] || envFileArg;
    if (file) out.push({ file, bases: dir === null ? [startDir, root] : [dir], at: m.index, envFile: !!envFileArg });
  }
  return out;
}

// `node --env-file=x server.js` 的 --env-file 是 Node 的選項；`node server.js --env-file=x` 則是傳給 server.js 的引數，
// Node 不會載入那個檔。before＝指令從頭到 --env-file 出現處為止：去掉前綴後，node 之後若已經出現非選項的詞
// （腳本名），這個 --env-file 就不算。會吃掉下一個詞當值的選項（-r x、--import x）要跳過它的值——
// 清單收常見的；清單以外、以空白隔開值的選項會把值誤認成腳本名而多擋（寫成 --flag=value 就不受影響）。
// 不是 node 開頭的（例如 tsx、bun 自己也認 --env-file）照舊算。
function envFileIsNodeOption(before) {
  const w = words(before.trim().slice(prefixOf(before).length));
  if (!w.length || !/^node(\.exe)?$/i.test(w[0].split(/[\\/]/).pop())) return true;
  const takesValue = /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|--env-file-if-exists|--inspect-port|-C|--conditions|--title|--input-type|--cpu-prof-dir|--cpu-prof-name|--heap-prof-dir|--heap-prof-name|--diagnostic-dir|--report-dir|--report-directory|--report-filename|--redirect-warnings|--openssl-config|--icu-data-dir|--trace-event-categories|--trace-event-file-pattern|--watch-path|--test-name-pattern|--test-reporter|--test-reporter-destination|--test-shard|--test-concurrency|--test-timeout)$/;
  for (let k = 1; k < w.length; k++) {
    if (!w[k].startsWith('-')) return false;
    if (takesValue.test(w[k])) k++;
  }
  return true;
}

// 第 i 條指令執行時，那個程式實際拿到的變數值（lines＝逐條指令的原文；ownText＝管線裡真正要判的那個指令）。
// 照 bash 的語意逐行模擬外層殼的狀態——值、是否匯出給子程序、allexport（set -a）——而不是抓字串：
//   · 繼承的環境變數一開始就是「已匯出」。
//   · `export X=v`／`export X`／`declare -x`／`typeset -x`：設值並匯出；`export -n X`：取消匯出。
//   · `X=v`（整段只有賦值、後面沒指令）：只設 shell 變數，除非 X 早已匯出或 set -a 開著，否則子程序看不到。
//   · `source <檔>`／`. <檔>`：檔內的 `export X=v` 會匯出，沒寫 export 的只是 shell 變數（同上）。
//   · `unset X`／`Remove-Item Env:X`：清掉。cmd 的 `set X=v`、PowerShell 的 `$env:X = 'v'`：直接設進環境。
//   · 管線裡的段落與別的包裝脈絡（子殼）裡的設定，不回到外層。
//   · 這條指令自己的前綴（`X=v cmd`、`env -u X cmd`、`env -i cmd`，含外層包裝帶進來的）最後套用。
//   · 這條自己的 `node --env-file=<檔>`：Node 不讓它覆蓋已存在的變數，只補還沒有的。
// 後面的指令、前面只作用在單一指令的 `X=v cmd`、引數裡的字串都不影響結果。
function envValueAt(lines, i, name, startDir, root, ownText) {
  const cur = ownText !== undefined ? ownText : lines[i];
  const ctx = ctxOf(lines[i]);
  const text = lines.slice(0, i).concat([cur]).join('\n');
  const lineStart = text.length - cur.length;
  const starts = [];
  let off = 0;
  for (let j = 0; j < i; j++) { starts.push(off); off += lines[j].length + 1; }
  // 環境檔的比對位置可能落在前一行結尾的換行字元上（正則以分隔字元起頭），往後挪一格再歸行
  const lineOf = (at) => {
    const p = /[\s;&|(]/.test(text[at] || '') ? at + 1 : at;
    let k = -1;
    for (let j = 0; j < starts.length; j++) if (p >= starts[j]) k = j;
    return k;
  };
  const files = envFilesOf(text, startDir, root);
  const readEnvFile = (f) => {
    for (const base of f.bases) {
      try {
        // 註解行（`# NODE_ENV=test`）不是設定
        return fs.readFileSync(path.resolve(base, f.file), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
      } catch (e) { /* 讀不到就換下一個候選位置 */ }
    }
    return null;
  };
  const valueIn = (word) => (word.startsWith(name + '=') ? word.slice(name.length + 1) : undefined);

  // 繼承的變數就算是空字串也算「存在」：Node 的 --env-file 不會覆蓋它（空值最後照未設定判）
  const inherited = process.env[name];
  let val = inherited;
  let exported = inherited !== undefined;
  let allexport = false;
  const assign = (v, exportIt) => { val = v; if (exportIt || allexport) exported = true; };

  // 外層包裝帶進來的前綴（`X=1 bash -c '…'` 的 X=1）在進入子殼時生效，之後子殼內的 export 可以蓋掉它
  let ctxApplied = false;
  const applyCtx = () => {
    if (ctxApplied) return;
    ctxApplied = true;
    if (!ctx) return;
    // 進入子殼：外層沒匯出的 shell 變數不會傳進來（`X=test; bash -c 'export X; …'` 裡的 X 是空的）
    if (!exported) val = undefined;
    applyPrefix(words(ctx));
  };

  // 依序套用一串前綴詞（`X=v`、`env -u X`、`env -i`、`sudo -u x`、`timeout 10`…）到目前的狀態。
  // 進入子殼時套外層包裝帶的前綴、最後套這條指令自己的前綴，兩處都用這一份——以前子殼那處只認賦值，
  // `env -u X bash -c '…'` 的清除就被漏掉了。
  // `X=v` 只在「指令開頭」或 `env`／`sudo`／新殼之後才是賦值；timeout／nice／nohup／exec／command 後面接的是指令，
  // `timeout 10 X=v cmd` 會把 `X=v` 當成指令名去執行（bash 實測），不是設定。
  // -i／-u X／--unset=X 只有在 env 後面才是清除變數；sudo -u postgres 的 -u 是「以誰的身分」，不是清變數。
  function applyPrefix(pw) {
    let assignOk = true;
    let runner = '';
    for (let k = 0; k < pw.length; k++) {
      const x = pw[k];
      const low = x.toLowerCase();
      if (/^(?:timeout|nice|nohup|exec|command|builtin|time)$/.test(low)) { assignOk = false; runner = low; }
      else if (/^(?:env|sudo|bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(low)) { assignOk = true; runner = low; }
      else if (runner === 'env' && (x === '-i' || x === '--ignore-environment')) { val = undefined; exported = false; }
      else if (runner === 'env' && x === '-u') { if (pw[k + 1] === name) { val = undefined; exported = false; } k++; }
      else if (runner === 'env' && x === '--unset=' + name) { val = undefined; exported = false; }
      else if (runner === 'sudo' && /^-[ugphCDrtTU]$/.test(x)) k++;
      else if (assignOk && valueIn(x) !== undefined) { val = valueIn(x); exported = true; }
    }
  }


  for (let j = 0; j < i; j++) {
    const line = lines[j];
    if (line.includes(' | ')) continue;           // 管線各段跑在子殼，設定不回到外層
    const cj = ctxOf(line);
    if (!ctx.startsWith(cj)) continue;            // 別的包裝脈絡（子殼）裡的設定不回到這裡
    if (ctx && cj === ctx) applyCtx();
    const body = line.trim().slice(cj.length).replace(/^\{\s*/, '');
    const w = words(body);
    if (!w.length) continue;
    const head = w[0].toLowerCase();
    if (head === 'unset') {
      if (w.slice(1).includes(name)) { val = undefined; exported = false; }
    } else if (head === 'remove-item') {
      if (w.slice(1).some((x) => x.toLowerCase() === 'env:' + name.toLowerCase())) { val = undefined; exported = false; }
    } else if (head === 'set' && /^[-+]a$/.test(w[1] || '')) {
      allexport = w[1] === '-a';
    } else if (head === 'set' && /^[-+]o$/.test(w[1] || '') && (w[2] || '') === 'allexport') {
      allexport = w[1] === '-o';
    } else if (head === 'set' && w.length === 2 && /\bcmd\s+$/i.test(cj) && w[1].toLowerCase().startsWith(name.toLowerCase() + '=')) {
      // 只有 cmd.exe 的 set X=v 是設環境變數；bash 的 set 是設位置參數、PowerShell 的 set 是 Set-Variable
      val = w[1].slice(name.length + 1); exported = true;
    } else if (head === 'export' || ((head === 'declare' || head === 'typeset') && w.some((x) => /^-\w*x/.test(x)))) {
      const unexport = w.some((x) => /^-\w*n/.test(x));
      for (const x of w.slice(1)) {
        if (x.startsWith('-')) continue;
        if (x === name) exported = !unexport;
        else if (valueIn(x) !== undefined) { val = valueIn(x); exported = !unexport; }
      }
    } else if (new RegExp('^\\$env:' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=', 'i').test(body)) {
      const m = /=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(body);   // PowerShell 的 $env:X = 'v'
      if (m) { val = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]); exported = val !== '$null'; if (!exported) val = undefined; }
    } else if (head === 'source' || head === '.') {
      for (const f of files) {
        if (f.envFile || lineOf(f.at) !== j) continue;
        for (const l of readEnvFile(f) || []) {
          const lw = words(l.trim());
          const isExport = lw[0] === 'export';
          const v = valueIn(isExport ? (lw[1] || '') : (lw[0] || ''));
          if (v !== undefined) assign(v, isExport);
        }
      }
    } else if (w.every((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x))) {
      for (const x of w) if (valueIn(x) !== undefined) assign(valueIn(x), false);   // 整段只有賦值＝shell 變數
    }
  }

  applyCtx();
  // 這條指令自己的前綴（扣掉已在進入子殼時套用的外層包裝前綴）：依序套用，賦值直接進這個程序的環境
  const curTrim = cur.trim();
  const pw = words(prefixOf(ctx && curTrim.startsWith(ctx) ? curTrim.slice(ctx.length) : curTrim));
  applyPrefix(pw);
  if (exported && val !== undefined) return val;

  let fromEnvFile;
  for (const f of files) {
    if (!f.envFile || f.at < lineStart) continue;   // --env-file 只作用在帶它的那條指令
    if (!envFileIsNodeOption(cur.slice(0, f.at - lineStart + 1))) continue;
    for (const l of readEnvFile(f) || []) {
      const lw = words(l.trim());
      const v = valueIn(lw[0] === 'export' ? (lw[1] || '') : (lw[0] || ''));
      if (v !== undefined) fromEnvFile = v;
    }
  }
  return fromEnvFile;
}

const asList = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]));

// PowerShell 寫環境變數的方式很多，兩條路徑都只模擬得了一種：最外層（不在任何 { }、( )、字串裡）、
// 名字大小寫完全相同、值是字面值的 `$env:X = '…'`／`$env:X = $null`。同一串指令裡只要這個變數出現過其他寫法的寫入——
// Set-Item／Clear-Item／Remove-Item 等 Env: 磁碟機操作與其別名、`${env:X}`、[Environment]::SetEnvironmentVariable、
// `+=`、大小寫不同（Windows 環境變數不分大小寫）、寫在區塊或條件裡——值就模擬不出來，判成「無法確認」。
// 以真 PowerShell 對照過：這些寫法把原本正確的繼承值改壞時，逐條模擬的判法會照舊值放行。
// 只在 PowerShell 工具、或 Bash 指令裡叫了 powershell／pwsh 時才看；回傳「這個變數名是否無法確認」的函式。
function psEnvUnsure(command, tool) {
  if (tool !== 'PowerShell' && !/(^|[\s;&|("'])(?:powershell|pwsh)(?:\.exe)?\b/i.test(command)) return () => false;
  // 掃一遍：註解換成空白；記下每個位置是否在最外層程式碼（不在字串、不在任何括號裡）
  const n = command.length;
  const top = new Array(n).fill(false);
  let code = '';
  let depth = 0;
  for (let i = 0; i < n; i++) {
    const ch = command[i];
    const here = command.startsWith("@'", i) || command.startsWith('@"', i);
    if (here && /^[ \t]*\r?\n/.test(command.slice(i + 2))) {
      const close = command.indexOf('\n' + command[i + 1] + '@', i + 2);
      const end = close < 0 ? n : close + 3;
      code += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n && !(command[j] === "'" && command[j + 1] !== "'")) j += command[j] === "'" ? 2 : 1;
      code += command.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') j += command[j] === '`' ? 2 : 1;
      code += command.slice(i, j + 1);
      i = j;
      continue;
    }
    if (command.startsWith('<#', i)) {
      const close = command.indexOf('#>', i + 2);
      const end = close < 0 ? n : close + 2;
      code += ' '.repeat(end - i);
      i = end - 1;
      continue;
    }
    if (ch === '#' && (i === 0 || /[\s;]/.test(command[i - 1]))) {
      let j = i;
      while (j < n && command[j] !== '\n') j++;
      code += ' '.repeat(j - i);
      i = j - 1;
      continue;
    }
    if (ch === '`') { code += command.slice(i, i + 2); i++; continue; }
    if (ch === '{' || ch === '(') depth++;
    if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
    top[i] = depth === 0 && ch !== '}' && ch !== ')';
    code += ch;
  }
  const writes = [];   // { name, ok }
  const NAME = '([A-Za-z_][A-Za-z0-9_]*)';
  const LITERAL = /^\s*(?:'(?:[^']|'')*'|"[^"$`]*"|\$null|-?\d+(?:\.\d+)?)\s*(?:$|;|\r?\n|\|\||&&)/i;
  let m;
  const assign = new RegExp('\\$(\\{)?env:' + NAME + '(\\})?\\s*([-+*/%]?=)(?!=)', 'gi');
  while ((m = assign.exec(code))) {
    // `$env:`／`$Env:` 前綴不分大小寫（微軟文件慣用 $Env:）；變數名才要求大小寫一致
    const ok = !m[1] && m[4] === '=' && top[m.index] && /^\$env:/i.test(code.slice(m.index, m.index + 5)) && LITERAL.test(code.slice(m.index + m[0].length));
    writes.push({ name: m[2], ok });
  }
  const item = new RegExp('(?:^|[\\s;|&({])(?:set-item|si|new-item|ni|remove-item|ri|rm|del|erase|rd|rmdir|clear-item|cli|rename-item|rni|move-item|mi|move|mv|copy-item|cpi|copy|cp|set-content|sc|add-content|ac|clear-content|clc)\\b[^;\\n|]*?env:\\\\?' + NAME, 'gi');
  while ((m = item.exec(code))) writes.push({ name: m[1], ok: false });
  const api = new RegExp('SetEnvironmentVariable\\s*\\(\\s*[\'"]' + NAME, 'gi');
  while ((m = api.exec(code))) writes.push({ name: m[1], ok: false });
  // Env: 磁碟機被 $env:／${env:} 變數語法以外的方式碰到（New-Item -Path Env: -Name X、gci Env:X | Remove-Item、
  // Set-Location Env:……），或 SetEnvironmentVariable 的名字不是字面值：改的是哪個變數從字面看不出來，
  // 所有環境變數一律判成無法確認
  const anyDrive = /(^|[\s'"(=,;|&])env:/i.test(code);
  const anyApi = /SetEnvironmentVariable\s*\(\s*(?!['"][A-Za-z_])/i.test(code) ||
    // iex／Invoke-Expression 的引數不是字面字串、或 [scriptblock]::Create(…)：在目前的工作階段執行看不到的程式碼
    /\[scriptblock\]\s*::\s*create\s*\(/i.test(code) ||
    /(^|[\s;|&({])(?:iex|invoke-expression)\s+(?!'[^']*'\s*(?:$|[;|&)}]))(?!"[^"$`]*"\s*(?:$|[;|&)}]))/i.test(code);
  const f = (name) => anyDrive || anyApi ||
    writes.some((w) => w.name.toLowerCase() === String(name).toLowerCase() && !(w.ok && w.name === name));
  f.fromBash = tool !== 'PowerShell';
  return f;
}

function envUnsureMsg(name) {
  if (envUnsure.fromBash) {
    return name + ' 的值無法確認：這是 Bash 指令裡叫起的 PowerShell，它改環境變數的寫法從外面驗不了；' +
      '要帶值請在 bash 這一側用 export ' + name + '=… 或前綴 ' + name + '=… 帶給它';
  }
  return name + " 的值無法確認：這串指令用了 $env:" + name + " = '…'（寫在最外層、名字大小寫一致、值為字面值）以外的方式改它";
}
// 語法樹路徑：前面有「可能發生過、也可能沒有」的設定（條件區段、函式本體裡的 export／unset／cd／source）
function condUnsureMsg(name) {
  return name + ' 的值無法確認：前面有只在條件成立時才會執行、或看不出何時執行的設定（if／&&／||／迴圈／函式裡的 export、unset、set -a、cd、source）；' +
    '在這條指令前面直接帶值（' + name + '=… <指令>），或把設定改成一定會執行的寫法再跑';
}
// 語法樹路徑：前面有看不到內容的寫入（eval "$(…)"、source <(…)、read、printf -v、指令名是變數……）
function opaqueMsg(name) {
  return name + ' 的值無法確認：前面有看不到內容的寫入（eval 展開、source <(…)、read、printf -v 之類），不知道它有沒有改到 ' + name + '；' +
    '在這條指令前面直接帶字面值（' + name + '=<值> <指令>）即可——字面值不受前面影響（引用 $' + name + ' 的寫法仍無法確認）';
}
// 主流程依本串指令設定；兩條路徑取環境值時先問它
let envUnsure = () => false;

// 語法解析器路徑（shell-model.js＋npm 裝在 .claude/hooks/node_modules 的 tree-sitter）。
// 模組缺、解析器沒裝、載入失敗、設 HARNESS_SHELL_PARSER=off、語法樹有錯誤節點時回 null，呼叫端改走正則路徑——準確度較低，但不會整個失效。
function analyzeWithParser(command, tool, startDir, root) {
  try {
    const sm = require('./shell-model.js');
    const a = sm.analyze(command, tool === 'PowerShell' ? 'PowerShell' : 'Bash', startDir, root);
    // 語法樹有錯誤節點＝這串沒被完整認出來（PowerShell 文法連 ./deploy.ps1 都解析成錯誤），整串改走正則路徑
    return a && !a.hasError ? a : null;
  } catch (e) {
    return null;
  }
}

// 語法樹路徑：指令名取檔名（.venv/bin/pytest、vitest.cmd）＋未加引號的引數比對 TEST_COMMAND；
// 「不真的跑測試」的旗標只看未加引號的引數（`vitest -t "handles --help"` 引號裡的是測試名稱）。
function findTestsWithParser(command, tool, cwd, root, testRe) {
  const a = analyzeWithParser(command, tool, cwd, root);
  if (!a) return null;
  const tests = a.execs.filter((e) => {
    if (e.mention) return false;
    if (!testRe.test([e.verb].concat(e.words.slice(1).map((w) => w.value)).join(' '))) return false;
    return !e.words.slice(1).some((w) => !w.quoted && NOT_A_RUN.test(' ' + w.value + ' '));
  }).map((e) => e.index);
  return { tests, envOf: (i, name) => a.envAt(i, name), infoOf: (i, name) => a.envInfo(i, name) };
}

// 正則路徑（沒有語法解析器時）：原本的判法，照舊保留。
function findTestsWithRegex(command, cwd, root, testRe) {
  const segs = executedSegments(command, 0);
  // 管線裡的段落在原文後補上 ' | '，envValueAt 據此認得「這段跑在子殼、設定不回到外層」
  const rawSegs = segs.map((x) => (x.piped ? x.raw + ' | ' : x.raw));
  // 直接用路徑叫的（.venv/bin/pytest、./node_modules/.bin/vitest）取檔名再比對；Windows 的 .exe 等一併去掉
  const asName = (r) => r.replace(/^(?:"[^"]*"|'[^']*'|\S+)/, (w) => w.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|ps1)$/i, ''));
  // 「不真的跑測試」的旗標只看引號外
  const unquoted = (r) => r.replace(/"[^"]*"|'[^']*'/g, '""');
  const tests = segs.map((x, i) => (testRe.test(asName(x.run)) && !NOT_A_RUN.test(unquoted(x.run)) ? i : -1)).filter((i) => i >= 0);
  return { tests, envOf: (i, name) => envValueAt(rawSegs, i, name, cwd, root) };
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const problems = [];
  let fileProblem = false; // 有「設定檔類」檢查不符時，結尾才提醒重啟跑中的服務
  try {
    const input = JSON.parse(raw);
    const command = String((input.tool_input || {}).command || '');
    if (!command || !CHECKS.length) process.exit(0);

    const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const cwd = input.cwd || root;
    envUnsure = psEnvUnsure(command, input.tool_name);
    const testRe = new RegExp(TEST_COMMAND, 'i');
    // 找出「真的在跑測試」的指令，以及取它們各自環境值的方法：有語法解析器用語法樹，沒有走正則路徑
    const found = findTestsWithParser(command, input.tool_name, cwd, root, testRe) || findTestsWithRegex(command, cwd, root, testRe);
    if (!found.tests.length) process.exit(0);

    for (const c of CHECKS) {
      try {
        if (!c) continue;
        if (c.when && !new RegExp(c.when, 'i').test(command)) continue;
        const tag = '[' + (c.id || c.kind) + '] ';
        const bad = [];
        if (c.kind === 'file') {
          let body = null;
          try { body = fs.readFileSync(path.resolve(root, c.path), 'utf8'); } catch (e) {}
          if (body === null) {
            if (c.onMissing !== 'allow') bad.push('讀不到 ' + c.path + '，無法確認前置條件');
          } else {
            // within 截不到區塊＝要驗的東西不在，照不符處理；退回整份檔會讓別的區塊的值替它背書。
            const w = c.within ? new RegExp(c.within, 'm').exec(body) : null;
            if (c.within && !w) {
              bad.push(c.path + ' 找不到指定區塊 /' + c.within + '/');
            } else {
              if (w) body = w[0];
              for (const re of asList(c.mustMatch)) if (!new RegExp(re, 'm').test(body)) bad.push(c.path + ' 未符合 /' + re + '/');
              for (const re of asList(c.mustNotMatch)) if (new RegExp(re, 'm').test(body)) bad.push(c.path + ' 出現不該有的 /' + re + '/');
            }
          }
        } else if (c.kind === 'env') {
          // 每一條測試指令各自判：同一串裡後面的賦值不能替前面的測試背書
          for (const t of found.tests) {
            // 語法樹路徑給的是全部可能值（條件分支各一種），每一種都要符合；正則路徑只有一個值
            const info = found.infoOf ? found.infoOf(t, c.env) : { values: [found.envOf(t, c.env)], unsure: false };
            let msg = null;
            if (envUnsure(c.env)) msg = envUnsureMsg(c.env);
            else if (info.unsure) msg = info.opaque ? opaqueMsg(c.env) : condUnsureMsg(c.env);
            else {
              const tail = info.values.length > 1 ? '（前面有條件式設定，其中一種情況）' : '';
              for (const v of info.values) {
                if (v === undefined || v === '') msg = c.env + ' 未設定' + tail;
                else if (c.equals !== undefined && v !== String(c.equals)) msg = c.env + '="' + v + '"' + tail + '，應為 "' + c.equals + '"';
                else if (c.matches && !new RegExp(c.matches, 'i').test(v)) msg = c.env + '="' + v + '"' + tail + ' 不符 /' + c.matches + '/';
                if (msg) break;
              }
            }
            if (msg && !bad.includes(msg)) bad.push(msg);
          }
        }
        if (bad.length) {
          if (c.kind === 'file') fileProblem = true;
          problems.push('  - ' + tag + bad.join('；') +
            (c.reason ? '\n      為什麼：' + c.reason : '') +
            '\n      放行方式：' + (c.fix || '修正後再跑。'));
        }
      } catch (e) {
        process.stderr.write('[' + LABEL + '] 檢查 ' + (c && c.id) + ' 無法套用（' + e.message + '），已略過——請修檢查。\n');
      }
    }
  } catch (e) {
    process.exit(0);
  }
  if (!problems.length) process.exit(0);

  const reason = '[' + LABEL + '] 要跑測試，但前置條件不符：\n\n' + problems.join('\n\n') +
    '\n\n這類問題不會報「環境不對」，只會讓測試紅在很遠的斷言上，或產生真實副作用（例如寄信給真人）。' +
    (fileProblem ? '\n改的若是跑中服務讀的設定檔，改完要重啟該服務才會生效——本守門只驗檔案內容，驗不到跑中的程序。' : '') +
    '\n檢查表在 .claude/hooks/guard-test-preconditions.js 的 CHECKS；判斷是檢查錯擋就回報使用者改檢查，不要繞過。';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
});
