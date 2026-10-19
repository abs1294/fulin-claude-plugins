// harness-kind: module（三支 git 守門 hook 共用的「這條指令會執行哪些 git 呼叫」判法；不是 hook、不接線）
// git-calls：把一條 Bash／PowerShell 指令拆成「實際會執行的 git 呼叫」清單——每個呼叫的子指令（動詞）、參數、
// 執行目錄、-C／--git-dir／--work-tree 指向、alias 展開、是不是 xargs 叫起的，以及「判不出」的理由。
// 使用者：guard-bare-git.js（裸 add／stage／push）、guard-worktree-remove-junction.js（worktree remove 穿透 junction）、
// guard-local-hack-destroy.js（銷毀未提交本機覆寫）。三支各自決定哪些動詞危險，這裡只負責「看得見每一個 git 呼叫」。
//
// 【範本】由 /harness:init 連同 shell-model.js 複製到目標專案 `.claude/hooks/`；實例與範本同文（diff --strip-trailing-cr 0 行）。
//
// 為什麼要有這一層（2026-10-18 紅藍對抗 R2 R1-1／R1-3）：三支 hook 原本的危險判定停在字串層——用正則找「git 後面那個裸字」。
// 字串層看不到 shell 執行時才消失的東西：`git "add"`、`git ad'd'`、`\git`、`git $'reset'`、`git --no-optional-locks add`、
// `-c alias.r='reset --hard' r`、`printf 'git add .' | /bin/sh`、`cat <<'EOF' | sh`、`bash -c -- '…'`、PowerShell 的 `--%`／`a\`dd`／
// `| Invoke-Expression`／`Start-Process git`……紅方 62 條自造寫法 55 條放行、32 條在隔離 repo 實跑真的 stage／push。
// 語法樹（shell-model.js，tree-sitter）照 shell 語意把引號、跳脫、續行、命令替換、管線餵殼、殼包裝、xargs／find -exec 全部還原，
// 這裡只要對每個 simple command 看 argv[0] 是不是 git、再逐個讀 argv 就好；執行期才知道的詞（`$(echo add)`、變數、
// 執行期才定義的 alias）語法樹也給不出值——一律標成「判不出」，呼叫端對 git 指令保守擋並說明。
//
// 兩條路徑：
//   · 語法樹路徑（預設）：shell-model.js 可用、語法樹沒有錯誤節點。PowerShell 文法對 `$env:TEMP\x` 這種寫法會出錯誤節點，
//     那時整條退回正則路徑（殘缺的樹不拿來判）。
//   · 正則路徑（退回）：解析器不在、HARNESS_SHELL_PARSER=off、語法樹有錯。保留 guard-bare-git 2026-10-17 版的資料遮罩
//     （引號與註解是資料；交給殼的引號字串、餵進殼的管線前段、直譯器 heredoc 本文照樣是指令），再加上與語法樹路徑同一套
//     全域選項、alias、`--%`、xargs 無動詞的規則。兩條路徑的輸出形狀相同（Call），呼叫端不必分辨。
//
// 全域選項：不靠白名單。`-C <p>`（可疊加，依序 resolve）、`-c <k=v>`（alias.<x>= 收起來等動詞對）、`--config-env`、
// `--git-dir`／`--work-tree`／`--namespace`／`--super-prefix`／`--attr-source`（分開或 = 連寫）、`--exec-path`／`--version`／`--help`／
// `--html-path` 等（整條 git 不執行子指令＝inert）、其餘任何 `--xxx`／`--xxx=v`／`-x` 一律跳過；第一個不是選項的字面詞才是動詞。
// 位置：`--git-dir` 指到哪 repo 就在哪（優先於 `--work-tree` 與 -C／cd），呼叫端用 repoDir 判「是不是暫存目錄的實驗 repo」。
//
// 直譯器字串（node -e／python -c／perl -e／ruby -e／php -r／awk、與餵給它們的 heredoc）：只有程式碼裡出現「執行外部程式」的呼叫
// （system、exec*、spawn、subprocess、popen、child_process、Process.Start、反引號…）才把裡面的 `git <動詞>` 當成呼叫；
// 只印字串的（`console.log('git add')`、`print('git add')`）不算。list 形式（`['git','add','.']`）也認。
//
// 暫存目錄（inTmp）：os.tmpdir()、TEMP／TMP／TMPDIR 環境變數；路徑開頭的 `$TEMP`／`${TEMP}`／`$env:TEMP`／`%TEMP%`／`$TMPDIR`
// 以 hook 自己的環境展開（該變數沒定義就維持字面、判不是暫存）；Windows 上 Git Bash 的 `/tmp` 就是 %TEMP%（`cd /tmp && pwd -W`）；
// `/c/…` 換回 `C:/…`。
//
// 已知看不到（兩條路徑都是，寫在這裡不寫在各 hook）：
//   · 指令名放在純變數裡（`G=git; $G add .`、`${G} add .`、PowerShell `& $tool add`、`$list | % { & $_ add . }`、`$s | iex`）——
//     要擋就得擋所有 `$X add`，誤擋面太大。間接參照 `${!ref}`、陣列元素 `${arr[0]}`、帶預設值 `${x:-git}` 不算純變數，有擋。
//   · 交給下游解譯器的非字面內容：`curl … | bash`、`curl … | base64 -d | sh`、`cat f | sh`、`bash script.sh`、`powershell -File x.ps1`——
//     內容在別處，固有邊界。就地解碼只做「echo／printf 字面接 base64 -d／--decode（含併寫旗標）／openssl -d -base64／xxd -r -p 再餵殼」
//     與 `-EncodedCommand <字面 base64>` 的乾淨一層：插換行／空白切段的 base64（`echo 'Z2l0\nIGFk…'`）、多層解碼（`base64 -d | base64 -d | sh`）、
//     其他上游工具、非字面上游（curl、檔案、變數）都看不到。字面有但解不出（不是乾淨 base64、UTF-16LE 解成亂碼）不擋，
//     只用 additionalContext＋stderr 提醒「本閘沒檢查」（undecodable／noteOutput）。解碼段的 sink 只認「餵殼」：
//     解碼結果放在指令位置（`$(echo <b64> | base64 -d)`）或餵 eval（`eval "$(echo <b64> | base64 -d)"`）看不到（2026-10-19 red4-a）。
//   · Bash 位置參數當指令名：`set -- git add .; "$@"`、`$1 $2 $3`——走純變數盲區（語法樹路徑放、正則路徑擋），
//     `${arr[@]}` 專規只管具名陣列，不含 `$@`／`$*`／`$1`（2026-10-19 red4-a，只登記不補規則）。
//   · PowerShell 的 .NET 執行 sink：`[powershell]::Create().AddCommand('git')….Invoke()`、`[System.Diagnostics.Process]::Start('git','add .')`、
//     `ProcessStartInfo` 組出來再 Start、`Start-Process -FilePath (運算式)`——PS_HIDDEN_EXEC 只收 AddScript／InvokeScript／
//     [scriptblock]::Create／.Invoke 這幾個原語，上述看不到（2026-10-19 red4-a）。
//     指令名是運算式或命令替換的（`$(which git)`、`"$(printf 'g%s' it)"`、PowerShell `& ('g'+'it')`、`& (Get-Command git)`、
//     `Invoke-Expression ('g'+'it add .')`）有擋：提到 git 字樣、或後面接 git 的危險動詞（add／stage／push／reset／checkout／restore／
//     clean／worktree／stash／rm／switch／branch -D）就判不出→保守（2026-10-18 R3 藍方新 1：原本只在文字含 git 才發 unsure，
//     `& ('g'+'it') add .` 這類拆字拼接的指令名三閘全放行）。
//   · 先前另一條指令 `git config alias.p push` 定義、本條才呼叫的全域／repo alias；把指令寫進檔案再執行；`source x.sh`。
//   · 直譯器程式碼裡用字串拼接組出來的 `git` 字樣（`'gi'+'t'` 在 node -e／python -c 裡）、base64 之類再解碼的。
//   · sed 的 `e` 旗標（`s/x/git push/e` 會執行）——sed 仍算純顯示指令。
// 只有正則路徑（HARNESS_SHELL_PARSER=off／解析器缺席）看不到的（2026-10-19 R3 複驗第三輪窮舉，語法樹路徑都擋）：
//   bash 字母前的反斜線 `g\it`、PowerShell 的空變數夾字 `git$null add .`。正則退路本就是降級，deny 文已點名解析器缺席要 npm ci。
//   （`${x:-git}`／`${x:=git}`／同句 `${git_cmd}` 原也只在正則路徑放行，`${…}` 進動態指令名規則後兩條路徑都擋：名字裡提到 git 就判不出。）
'use strict';

const os = require('os');
const path = require('path');

// ── 解析器（失敗回 null，不拋例外；呼叫端據此走正則路徑）──
let smMod;
function shellModel() {
  if (smMod === undefined) {
    try { smMod = require('./shell-model.js'); } catch (e) { smMod = null; }
  }
  return smMod;
}
function parserAvailable(tool) {
  const sm = shellModel();
  try { return !!(sm && sm.available && sm.available(tool)); } catch (e) { return false; }
}

// ── 共用小工具 ──────────────────────────────────────────────────────────────
// 一個參數：引號字串或非空白，可混搭（alias.hi='!echo hi'、-C "a b"、"$(x)"）
const ARG = '(?:"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\'|[^\\s"\'])+';
const ARG_NOSEP = '(?:"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\'|[^\\s;&|)"\'])+';
const GIT_NAME_RE = /^git(?:\.(?:exe|cmd|bat|com))?$/i;

function stripArgQuotes(s) {
  let v = String(s == null ? '' : s).trim();
  if (v.length > 1 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
  return v;
}
// Git Bash／WSL 的 /c/…、/mnt/c/…、/cygdrive/c/… 換成 C:/…（Windows 上 path.resolve 會把 /c/x 當成目前磁碟的 \c\x）
function fromPosix(p) {
  return process.platform === 'win32' ? String(p).replace(/^\/(?:mnt\/|cygdrive\/)?([A-Za-z])(?=\/|$)/, '$1:') : String(p);
}
// 指令名是不是 git：剝掉路徑（/usr/bin/git、C:\…\git.exe、./git.exe）與前導反斜線（\git）
function isGitName(s) {
  const b = String(s == null ? '' : s).replace(/^\\+/, '').split(/[\\/]/).pop();
  return GIT_NAME_RE.test(b);
}
// PowerShell 裸詞裡的反引號跳脫（a`dd → add）；`n `t 這類標準跳脫維持原樣
function unbacktick(s) {
  return String(s).replace(/`(.)/g, (m, c) => (/[0abefnrtuv]/.test(c) ? m : c));
}
// 簡單的 shell 斷詞（alias 值用）：空白分隔，單／雙引號包住的算一個詞
function splitWords(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s))) !== null) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}
function joinArgs(argv) {
  return (argv || []).map((a) => (/[\s"']/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : a)).join(' ');
}

// ── 暫存目錄 ────────────────────────────────────────────────────────────────
function tmpRoots() {
  const roots = [os.tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR];
  if (process.platform !== 'win32') roots.push('/tmp');
  return roots.filter(Boolean).map((r) => String(r).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
}
// 路徑開頭的暫存目錄變數寫法展開；展開不了的維持字面（inTmp 看到殘留的 $／% 會判不是暫存）
function expandTmpVars(p) {
  let v = stripArgQuotes(p);
  const envOr = (name, literal) => {
    const val = process.env[name] || process.env[name.toUpperCase()];
    return val ? String(val).replace(/[\\/]+$/, '') : literal;
  };
  v = v.replace(/^\$\{?(TEMP|TMP|TMPDIR)\}?(?=$|[\/\\])/i, (m, n) => envOr(n, m))
    .replace(/^\$\{?env:(TEMP|TMP)\}?(?=$|[\/\\])/i, (m, n) => envOr(n, m))
    .replace(/^%(TEMP|TMP)%(?=$|[\/\\])/i, (m, n) => envOr(n, m));
  // Git Bash 的 /tmp 在 Windows 對應 %TEMP%（本機 `cd /tmp && pwd -W` 印的就是它）
  if (process.platform === 'win32') v = v.replace(/^\/tmp(?=$|\/)/, os.tmpdir().replace(/\\/g, '/'));
  return fromPosix(v);
}
function inTmp(p, cwd) {
  if (!p) return false;
  const v = expandTmpVars(p);
  if (!v || /[$%`]/.test(v)) return false;
  let abs;
  try { abs = path.resolve(fromPosix(cwd || process.cwd()), v); } catch (e) { return false; }
  const n = abs.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return tmpRoots().some((r) => n === r || n.startsWith(r + '/'));
}

// ── 純顯示快速放行（兩條路徑之前的便宜判斷）────────────────────────────────
// 整條就一個顯示指令（echo／grep／cat…）只是「提到」git 字樣。分隔符要含換行、單個 &（背景）、行程替換 <( )／>( )：
// `echo start⏎git add .` 是兩條指令，2026-10-18 之前 SHELL_OPS 只認 | ; && || $( ) 反引號，第二行整個被放掉（R2 R1-1，日常形狀）。
// awk 不在清單裡：它的 system() 會執行程式。
const DISPLAY = /^\s*(echo|printf|grep|egrep|fgrep|rg|cat|sed|head|tail|less|more|type|find|wc|sort|uniq|Select-String|Get-Content|Write-Host|Write-Output)(\.exe)?\s/i;
const SHELL_OPS = /\$\(|`|\||;|&|\r?\n|<\(|>\(/;
function isDisplayOnly(text) {
  return DISPLAY.test(text) && !SHELL_OPS.test(text) && !/(^|\s)-(exec|execdir|ok|okdir)(\s|$)/.test(text);
}
// bash 的 ANSI-C 字串 $'…'：斷詞前就把 \xHH／\NNN（八進位）／\uHHHH／\UHHHHHHHH／\n \t 這類跳脫解開（$'\x67it' 就是 git、gi$'t' 也是）。
// 初篩與正則路徑原本都只看原文，2026-10-18 R3 R3A-1：`$'\x67it' add .`、`gi$'t' add .`、`$'\147it' push origin HEAD`、
// `$'\x67it' -C <repo> checkout -- .`、`cd <repo> && gi$'t' reset --hard` 三閘同根放行（語法樹其實解得出動詞，差在初篩沒讓它進去）。
const ANSI_C_RE = /\$'((?:[^'\\]|\\[\s\S])*)'/g;
// 解碼只有一份實作，在 shell-model.js（語法樹路徑的 ansi_c_string、echo -e、printf 也用它；2026-10-18 R3 複驗 G1：兩份實作不同步，
// 語法樹那份少了 \uHHHH／\UHHHHHHHH）。shell-model.js 的 tree-sitter 是延遲載入，檔案在就 require 得到；檔案不在時不解碼、維持原文
function decodeAnsiC(body) {
  const sm = shellModel();
  return sm && sm.decodeAnsiC ? sm.decodeAnsiC(body) : String(body == null ? '' : body);
}
// 整條指令裡的 $'…' 換成解碼後的單引號字串（$'\x67it' → 'git'，正則路徑的 normalize 再把指令位置的 'git' 還原成裸字）；
// 解碼結果含引號或換行時放裸字（沒辦法再包回單引號）
function expandAnsiC(s) {
  const text = String(s);
  if (text.indexOf("$'") < 0) return text;
  return text.replace(ANSI_C_RE, (m, body) => { const d = decodeAnsiC(body); return /['\n\r]/.test(d) ? d : "'" + d + "'"; });
}
// 初篩：指令裡有沒有 git 這個字（含被引號拆開、字中續行的寫法：g''it、gi"t"、gi\⏎t）
const MENTION_RE = /g(?:['"`\\]|\\\r?\n)*i(?:['"`\\]|\\\r?\n)*t/i;
// 拆字拼接（PowerShell 與 bash 的字串相加：('g'+'it')、"gi" + "t"；陣列／參數列 @('g','i','t')、Join('', 'g','it')）
// 去掉「引號 + 引號」「引號 , 引號」之後再比
const CONCAT_RE = /['"]\s*[+,]\s*['"]/g;
function looseGit(text) {
  const s = String(text == null ? '' : text);
  if (MENTION_RE.test(s)) return true;
  if (CONCAT_RE.test(s)) { CONCAT_RE.lastIndex = 0; if (MENTION_RE.test(s.replace(CONCAT_RE, ''))) return true; }
  CONCAT_RE.lastIndex = 0;
  return s.indexOf("$'") >= 0 && MENTION_RE.test(expandAnsiC(s));
}
// `$(which X)`／`$(command -v X)`／`$(type -p X)`／反引號同形／PowerShell `(Get-Command X)`：X 是字面詞時，指令名就是 X——
// 不是 git 就當一般程式，不發 unsure（2026-10-18 R3 複驗 G2 副作用：`$(which python) -m pytest -k add`、`$(which kubectl) rm pod x`
// 原被裸 git 閘當「指令名執行期才知道且接危險動詞」擋）。回傳 X（小寫）或 null（不是這種形狀）
const WHICH_FORM_RE = /^"?(?:\$\(|`)\s*(?:which|command\s+-v|type\s+-[pP])\s+([^\s()'"$`|;&]+)\s*(?:\)|`)"?$|^\(\s*Get-Command\s+([^\s()'"$`|;&]+)\s*\)$/i;
function literalNameOf(text) {
  const m = WHICH_FORM_RE.exec(String(text == null ? '' : text).trim());
  return m ? String(m[1] || m[2]).toLowerCase() : null;
}
function unsureNameMsg(name, dv) {
  return '指令名執行期才知道（' + name + '），本閘判不出它是不是 git' + (dv ? '，且引數含 git 危險動詞字樣 ' + dv : '') + '——請改成字面指令名';
}
// 三閘各自認定的危險動詞聯集（裸 git 閘 add／stage／push、hack 閘 reset／checkout／restore／clean／stash／rm／switch／branch -D、junction 閘 worktree）：
// 指令名執行期才知道時，後面接到這些就判不出→保守擋；`$cmd --version`、`& $tool list` 這類不擋
const DANGER_VERBS = new Set(['add', 'stage', 'push', 'reset', 'checkout', 'restore', 'clean', 'worktree', 'stash', 'rm', 'switch']);
const DANGER_VERB_RE = /(?:^|[\s"'(])(?:add|stage|push|reset|checkout|restore|clean|worktree|stash|rm|switch)(?=[\s"')]|$)|(?:^|[\s"'(])branch\s+(?:-D|-d|--delete)(?=[\s"')]|$)/i;
// 文字裡的危險動詞（給正則路徑與 eval／iex 的字串用）：照 shell 斷詞後逐詞比（引號包住的 'add contact' 是一個詞、不算），
// 與語法樹路徑的 dangerVerbInWords 同判準；回傳命中的動詞或 null
function dangerVerbInText(text) {
  const s = String(text == null ? '' : text).replace(/[()@]/g, ' ');
  return dangerVerbInWords(splitWords(s).map((v) => ({ value: v, literal: true })));
}
// 語法樹的詞序列（tokensOf 的輸出）裡的危險動詞：只認字面詞；branch 要後面跟 -D／-d／--delete 才算
function dangerVerbInWords(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.literal) continue;
    const v = String(w.value == null ? '' : w.value).toLowerCase();
    if (DANGER_VERBS.has(v)) return v;
    if (v === 'branch') { const n = words[i + 1]; if (n && n.literal && /^(?:-D|-d|--delete)$/.test(String(n.value))) return 'branch ' + n.value; }
  }
  return null;
}
// 純變數指令名（$G、${G}、PowerShell 的 $tool／$env:X）：維持已知盲區，不因後面接危險動詞就擋（檔頭）。
// 間接參照 `${!ref}`、陣列元素 `${arr[0]}`、帶預設值的 `${x:-git}`／`${x:=git}` 不算純變數——值由別處組出來，走動態指令名規則
// （2026-10-19 R3 複驗第三輪 F8-4：`ref=g; g=git; ${!ref} add .`、`arr=(git); ${arr[0]} add .` 實證會跑 git）
function isPlainVar(text) { return /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][\w:]*)$/.test(String(text == null ? '' : text).trim()); }
// 指令位置是命令替換／PowerShell 運算式／Invoke-Expression／bash 間接參照或陣列元素的形狀：初篩只在同時出現危險動詞時才放進語法樹
// （便宜的預判，判不判得出交給兩條路徑）
const DYNAMIC_NAME_RE = /(?:^|[;&|(\n{]\s*)(?:"?\$\(|`|&\s*[($]|(?:Invoke-Expression|iex)\s+[($"']|\$\{(?:!|[A-Za-z_]\w*\[|[A-Za-z_]\w*:[-=+?]))/i;
// 就地可解的編碼內容：PowerShell `-EncodedCommand <base64>`（UTF-16LE）、bash `echo <base64> | base64 -d | sh`
// （含 base64 --decode、openssl enc -d -base64、`xxd -r -p` 的十六進位、here-string `base64 -d <<< … | sh`）——輸入是字面時解碼後
// 當成另一條指令餵回同一套分析（2026-10-19 R3 複驗第三輪 F8-2／F8-3）。輸入不是字面（`curl … | base64 -d | sh`、`cat f | sh`）
// 看不到內容，維持放行，登記在檔頭「已知看不到」。回傳 [{ text, tool, kind }]
const PS_ENC_ARG_RE = /(?:^|[\s;&|(`])(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-|\/)[^\s;&|]*\s+(?:[^-\/\s;&|][^\s;&|]*\s+)?)*?(?:-{1,2}|\/{1,2})e(?:c|n(?:c(?:o(?:d(?:e(?:d(?:c\w*)?)?)?)?)?)?)?\s+(["']?)([A-Za-z0-9+\/=]{8,})\1/gi;
// echo／printf 的字面（printf 的 '%s'／"%b" 格式字串跳過）→ 解碼器（base64 的 -d／-D／--decode 可與其他旗標併寫如 -di、-d -i、--decode --ignore-garbage；
// openssl enc -d -base64／openssl base64 -d；xxd -r -p）→ 殼。字面 base64 須連續（插換行／空白看不到）、解碼鏈只解一層。
// 旗標併寫認得，但 payload 本身含非 base64 字元（如 `Z2l0-IGFk-ZCAu` 靠 --ignore-garbage 丟掉 `-`）時這裡比不到、仍解不出，
// 只由 undecodable 發 additionalContext 提醒，不擋。
const B64_PIPE_RE = /(?:^|[\s;&|(`])(?:(?:echo|printf)\s+(?:-[a-zA-Z]+\s+)*(?:(?:'%[sb]'|"%[sb]"|%[sb])\s+)?(["']?)([A-Za-z0-9+\/=]{4,})\1\s*\|\s*|)(base64(?:\s+(?:-[a-zA-Z]*[dD][a-zA-Z]*|--decode|--ignore-garbage|-i|-w\s*\d+|--wrap=\d+))+|openssl\s+(?:enc\s+(?:-[a-zA-Z0-9]+\s+)*-d\s+(?:-[a-zA-Z0-9]+\s+)*-base64|base64\s+-d)|xxd\s+-r\s+-p)(?:\s+<<<\s*(["']?)([A-Za-z0-9+\/=]{4,})\4)?\s*\|\s*(?:sudo\s+)?(?:(?:[\w.\/\\:-]*[\/\\])?(bash|sh|zsh|dash|ksh|eval|iex|Invoke-Expression|pwsh|powershell)(?:\.exe)?|(?:source|\.)\s+\/dev\/stdin)(?=[\s;&|)]|$)/gi;
function decodedViews(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  let m;
  PS_ENC_ARG_RE.lastIndex = 0;
  while ((m = PS_ENC_ARG_RE.exec(s)) !== null) {
    let d = '';
    try { d = Buffer.from(m[2], 'base64').toString('utf16le'); } catch (e) { d = ''; }
    if (d) out.push({ text: d, tool: 'PowerShell', kind: '-EncodedCommand' });
  }
  B64_PIPE_RE.lastIndex = 0;
  while ((m = B64_PIPE_RE.exec(s)) !== null) {
    const payload = m[2] || m[5];
    if (!payload) continue;   // 解碼器的輸入不是字面（curl、cat、變數）：看不到
    let d = '';
    try { d = /^xxd/i.test(m[3]) ? Buffer.from(payload, 'hex').toString('utf8') : Buffer.from(payload, 'base64').toString('utf8'); } catch (e) { d = ''; }
    if (!d) continue;
    const tail = String(m[6] || '').toLowerCase();
    out.push({ text: d, tool: /^(?:iex|invoke-expression|pwsh|powershell)$/.test(tail) ? 'PowerShell' : 'Bash', kind: m[3] + ' | ' + (m[6] || 'source /dev/stdin') });
  }
  return out;
}
// 解不出的編碼內容：-EncodedCommand 的引數不是乾淨的 base64、或合法 base64 但 UTF-16LE 解成亂碼；echo／printf 字面接解碼器再餵殼、
// 但字面不是乾淨的 base64／十六進位。這些不擋（會誤擋），呼叫端用 additionalContext＋stderr 提醒「本閘沒檢查」（R3 複驗第四輪收口）。
// 回傳給人看的句子陣列；空陣列＝沒有這種情形
const CLEAN_B64 = /^[A-Za-z0-9+\/]+={0,2}$/;
const PS_ENC_ANY_RE = /(?:^|[\s;&|(`])(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-|\/)[^\s;&|]*\s+(?:[^-\/\s;&|][^\s;&|]*\s+)?)*?(?:-{1,2}|\/{1,2})e(?:c|n(?:c(?:o(?:d(?:e(?:d(?:c\w*)?)?)?)?)?)?)?\s+(["']?)([^\s;&|"']+)\1/gi;
const B64_PIPE_ANY_RE = /(?:^|[\s;&|(`])(?:echo|printf)\s+(?:-[a-zA-Z]+\s+)*(?:(?:'%[sb]'|"%[sb]"|%[sb])\s+)?(["']?)([^\s;&|"']+)\1\s*\|\s*(base64(?:\s+(?:-[a-zA-Z]*[dD][a-zA-Z]*|--decode|--ignore-garbage|-i|-w\s*\d+|--wrap=\d+))+|openssl\s+(?:enc\s+(?:-[a-zA-Z0-9]+\s+)*-d\s+(?:-[a-zA-Z0-9]+\s+)*-base64|base64\s+-d)|xxd\s+-r\s+-p)\s*\|\s*(?:sudo\s+)?(?:(?:[\w.\/\\:-]*[\/\\])?(?:bash|sh|zsh|dash|ksh|eval|iex|Invoke-Expression|pwsh|powershell)(?:\.exe)?|(?:source|\.)\s+\/dev\/stdin)(?=[\s;&|)]|$)/gi;
function looksGarbled(d) {
  const s = String(d);
  if (!s) return true;
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F�]/.test(s)) return true;
  const printable = (s.match(/[\x20-\x7E\t\r\n]/g) || []).length;
  return printable / s.length < 0.5;
}
function undecodable(text) {
  const notes = [];
  const s = String(text == null ? '' : text);
  let m;
  PS_ENC_ANY_RE.lastIndex = 0;
  while ((m = PS_ENC_ANY_RE.exec(s)) !== null) {
    const tok = m[2];
    if (/^[$@(]/.test(tok)) continue;   // 變數／運算式：非字面，屬固有邊界（檔頭）
    let d = '';
    if (CLEAN_B64.test(tok) && tok.length % 4 !== 1 && tok.length >= 8) { try { d = Buffer.from(tok, 'base64').toString('utf16le'); } catch (e) { d = ''; } }
    if (!d || looksGarbled(d) || (Buffer.from(tok, 'base64').length % 2) === 1) notes.push('-EncodedCommand 的內容解不出（' + tok.slice(0, 24) + (tok.length > 24 ? '…' : '') + ' 不是乾淨的 UTF-16LE base64），本閘沒檢查裡面的指令');
  }
  B64_PIPE_ANY_RE.lastIndex = 0;
  while ((m = B64_PIPE_ANY_RE.exec(s)) !== null) {
    const tok = m[2];
    if (/^[$`]/.test(tok)) continue;
    const hex = /^xxd/i.test(m[3]);
    let ok = hex ? /^(?:[0-9A-Fa-f]{2})+$/.test(tok) : (CLEAN_B64.test(tok) && tok.length % 4 !== 1 && tok.length >= 4);
    let d = '';
    if (ok) { try { d = Buffer.from(tok, hex ? 'hex' : 'base64').toString('utf8'); } catch (e) { d = ''; } }
    if (!ok || !d || looksGarbled(d)) notes.push('解碼鏈（' + m[3] + ' 餵進殼）的字面內容解不出（' + tok.slice(0, 24) + (tok.length > 24 ? '…' : '') + '），本閘沒檢查裡面的指令');
  }
  return notes;
}
function mentionsGit(command) {
  const s = String(command == null ? '' : command);
  if (looseGit(s)) return true;
  if (undecodable(s).length) return true;   // 解不出的編碼要讓呼叫端拿到 notes，不能在初篩就放掉
  if (DYNAMIC_NAME_RE.test(s) && DANGER_VERB_RE.test(s)) return true;
  return decodedViews(s).some((v) => looseGit(v.text) || (DYNAMIC_NAME_RE.test(v.text) && DANGER_VERB_RE.test(v.text)));
}

// ── git 子指令與 alias ──────────────────────────────────────────────────────
// git 不准 alias 蓋掉內建子指令：動詞在這張表上就不可能是 alias，環境裡 alias 定義看不清楚時也不必判不出
const KNOWN_GIT_CMDS = new Set(('add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap ' +
  'check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-tree config count-objects credential daemon ' +
  'describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref ' +
  'for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook http-fetch http-push index-pack init instaweb interpret-trailers ' +
  'log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-one-file merge-tree mergetool mktag mktree ' +
  'multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push quiltimport range-diff read-tree rebase ' +
  'receive-pack reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack sh-i18n shortlog show ' +
  'show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index ' +
  'update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree lfs').split(/\s+/));

// `-c alias.<x>=<值>`：收進 aliases（名稱小寫）；不是 alias 的設定忽略
function parseAliasDef(kv, aliases) {
  const m = /^alias\.([^=\s]+)=([\s\S]*)$/i.exec(String(kv).trim());
  if (m) aliases[m[1].toLowerCase()] = stripArgQuotes(m[2]);
}
// GIT_CONFIG_PARAMETERS 的格式：空白分隔的 sq 引號項目，`'k=v'` 或 `'k'='v'`
function parseConfigParams(v, aliases) {
  const re = /'((?:[^'\\]|\\.)*)'(?:=('((?:[^'\\]|\\.)*)'))?/g;
  let m;
  while ((m = re.exec(String(v))) !== null) {
    if (m[2] !== undefined) parseAliasDef(m[1] + '=' + m[3], aliases);
    else parseAliasDef(m[1], aliases);
  }
}

// ── 直譯器字串裡的 git ──────────────────────────────────────────────────────
const INTERP_VERBS = /^(?:node|bun|deno|python[0-9.]*|py|perl|ruby|php|lua|[gmn]?awk)$/;
// 程式碼裡「執行外部程式」的呼叫；有這些才把字串裡的 git 當成呼叫
const EXEC_KW = /\b(?:system|exec(?:Sync|File|FileSync|l|lp|le|v|vp|ve|vpe)?|spawn(?:Sync)?|popen|Popen|subprocess|shell_exec|passthru|proc_open|check_call|check_output|child_process|Process\.Start|ProcessStartInfo|Runtime\.getRuntime|IO\.popen|Open3|Kernel\.system|os\.system|qx|%x[({\[])\b|`[^`\n]*\bgit\b/;
// 程式碼或字串裡的 `git [全域選項…] <動詞> <參數>`；list 形式 `'git','add','.'`
const GIT_IN_TEXT = /\bgit(?:\.exe)?\s+((?:-[^\s'"`;)]+\s+)*)([a-z][a-z0-9-]*)([^'"`\n;)]*)/gi;
const GIT_LIST_FORM = /['"]git(?:\.exe)?['"]\s*,\s*[[(]?\s*['"]([a-z][a-z0-9-]*)['"]((?:\s*,\s*['"][^'"]*['"])*)/gi;
function codeArgsOf(verb, argv) {
  const out = [];
  const a = argv || [];
  if (verb === 'node' || verb === 'bun') {
    for (let i = 1; i < a.length; i++) {
      if (/^(?:-e|-p|--eval|--print)$/.test(a[i]) && a[i + 1] !== undefined) out.push(a[++i]);
      else { const m = /^--(?:eval|print)=([\s\S]*)$/.exec(a[i]); if (m) out.push(m[1]); }
    }
  } else if (/^(?:python[0-9.]*|py)$/.test(verb)) {
    for (let i = 1; i < a.length; i++) if (a[i] === '-c' && a[i + 1] !== undefined) { out.push(a[i + 1]); break; }
  } else if (verb === 'perl') {
    for (let i = 1; i < a.length; i++) if (/^-[A-Za-z]*[eE]$/.test(a[i]) && a[i + 1] !== undefined) out.push(a[++i]);
  } else if (verb === 'ruby' || verb === 'lua') {
    for (let i = 1; i < a.length; i++) if (/^-[A-Za-z]*e$/.test(a[i]) && a[i + 1] !== undefined) out.push(a[++i]);
  } else if (verb === 'php') {
    for (let i = 1; i < a.length; i++) if (a[i] === '-r' && a[i + 1] !== undefined) { out.push(a[i + 1]); break; }
  } else if (verb === 'deno') {
    if (a[1] === 'eval' && a[2] !== undefined) out.push(a[2]);
  } else if (/^[gmn]?awk$/.test(verb)) {
    for (let i = 1; i < a.length; i++) {
      if (/^-[FvW]$/.test(a[i])) { i++; continue; }
      if (a[i] === '-f') break;                       // 程式在檔案裡，看不到
      if (a[i] === '--') { if (a[i + 1] !== undefined) out.push(a[i + 1]); break; }
      if (a[i].startsWith('-')) continue;
      out.push(a[i]); break;
    }
  }
  return out;
}
// 文字裡的 git 呼叫（直譯器程式碼、PowerShell 的 [scriptblock]::Create 這類語法樹看不到的字串）
function textCalls(s, source, at) {
  const calls = [];
  const text = String(s);
  let m;
  GIT_IN_TEXT.lastIndex = 0;
  while ((m = GIT_IN_TEXT.exec(text)) !== null) {
    const c = mkCall({ source, at, name: 'git', verb: m[2].toLowerCase(), args: m[3].trim(), argv: splitWords(m[3]) });
    c.dirUnsure = true; c.repoUnsure = true;
    calls.push(c);
  }
  GIT_LIST_FORM.lastIndex = 0;
  while ((m = GIT_LIST_FORM.exec(text)) !== null) {
    const rest = (m[2].match(/['"]([^'"]*)['"]/g) || []).map((x) => x.slice(1, -1));
    const c = mkCall({ source, at, name: 'git', verb: m[1].toLowerCase(), args: joinArgs(rest), argv: rest });
    c.dirUnsure = true; c.repoUnsure = true;
    calls.push(c);
  }
  return calls;
}
// PowerShell 把字串當程式碼跑、語法樹上沒有 command 節點的形狀
const PS_HIDDEN_EXEC = /\[scriptblock\]::Create\s*\(|\.Invoke\s*\(|\.InvokeScript\s*\(|Invoke-Command\b|\bicm\b|-ScriptBlock\b|\[powershell\]::Create|\.AddScript\s*\(/i;
// 這些執行原語的括號引數不是字面字串（`$ExecutionContext.InvokeCommand.InvokeScript(('g'+'it add .'))`、`[scriptblock]::Create($s + ' add .')`）時，
// textCalls 找不到 `git <動詞>` 字樣——引數提到 git（含拆字拼接）或含危險動詞就判不出（2026-10-19 R3 複驗第三輪 F8-1）
const PS_HIDDEN_EXEC_OPEN = /(?:\.InvokeScript|\.AddScript|\[scriptblock\]::Create|\.Invoke)\s*\(/gi;
function hiddenExecExprCalls(text) {
  const out = [];
  const s = String(text);
  let m;
  PS_HIDDEN_EXEC_OPEN.lastIndex = 0;
  while ((m = PS_HIDDEN_EXEC_OPEN.exec(s)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(s, open);
    if (close < 0) continue;
    const expr = s.slice(open + 1, close).trim();
    // 單一字面字串（引號內不再有同種引號）：textCalls 已照字面分析；`'g'+'it add .'` 這種以引號開頭結尾的拼接不算字面（R3 複驗第四輪 F8-i4）
    if (!expr || /^'[^']*'$/.test(expr) || /^"[^"]*"$/.test(expr) || /^@(['"])[\s\S]*\1@$/.test(expr)) continue;
    const lg = looseGit(expr);
    const dv = lg ? null : dangerVerbInText(expr);
    if (lg || dv) out.push(mkCall({ source: 'text', at: m.index, unsure: m[0].replace(/\s*\($/, '') + ' 的引數執行期才組出來（' + (lg ? '裡面提到 git' : '裡面有 git 危險動詞 ' + dv) + '：' + expr.slice(0, 60) + '）', dirUnsure: true, repoUnsure: true }));
  }
  return out;
}

// ── Call 物件 ────────────────────────────────────────────────────────────────
// source：'ast'｜'regex'｜'interp'（直譯器字串）｜'text'（PowerShell 隱藏執行形狀）
// verb：小寫子指令（alias 已展開）；unsure：非 null＝判不出，理由給人看；inert：整條 git 不執行子指令（--help、--version、bare git）
// args／argv：動詞之後的參數（字串／陣列）；dir：執行目錄（含 -C 疊加；null＝判不出）；repoDir：--git-dir ＞ --work-tree ＞ dir
// repoUnsure：repoDir 判不出（變數、pushd／popd、cd 到變數…）；cwdFallbackOk：整條沒有任何換目錄、-C、--git-dir 之類，呼叫端可拿 hook 的 cwd 當位置
// viaXargs：xargs／find -exec 叫起（參數可能由管線供給）；alias：{ name, value }（由 -c／GIT_CONFIG_* 當場定義、本呼叫用到的）
// argvLiteral：與 argv 平行的布林陣列，false＝該參數執行期才知道值（變數、$(…)、PowerShell 的 (…)／@(…) 子運算式、
//   含 `$` 的雙引號字串、%VAR%）。動詞是字面、參數不是的情形很常見（`git add $f`），所以不把整個呼叫標成 unsure，由呼叫端
//   依「這個參數是不是路徑判準的一環」決定要不要保守擋（2026-10-18 R2：`git worktree remove (Join-Path (Get-Location) jx)`
//   的語法樹給出完整 argv、unsure=null，junction 閘拿去 path.resolve 得到不存在的路徑而放行）。沒有該資訊的呼叫（直譯器字串）為空陣列
function mkCall(init) {
  return Object.assign({
    source: 'ast', name: 'git', verb: null, args: '', argv: [], argvLiteral: [], unsure: null, inert: false,
    dir: null, dirUnsure: false, repoDir: null, repoUnsure: false, cwdFallbackOk: false, gitDir: null, workTree: null,
    hints: [], viaXargs: false, alias: null, at: null,
  }, init || {});
}

// ── 語法樹路徑 ──────────────────────────────────────────────────────────────
const EXPANSION_TYPES = new Set(['simple_expansion', 'expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion']);
// bash 執行前還會展開的字面詞：`~`／`~user` 開頭（家目錄）、`*`／`?`／`[…]` 萬用字元、`{a,b}` 大括號——值執行期才知道，與變數同等看待。
// 2026-10-18 R3 R3A-2：`git worktree remove ~/…/jx`、`--force j*` 語法樹標成字面，junction 閘拿去 path.resolve 得到不存在的路徑而放行
// （藍方實測 Git Bash `echo ~/AppData` 印 /c/Users/…、`echo j*` 印 jx）。只對 bash 樹的詞：PowerShell 對原生程式不展開 `~` 與萬用字元
// （藍方實測 `cmd /c echo ~\x` 印字面），tokensOf 對 PowerShell 節點不走這裡。引號包住的（raw_string／string）不展開，不在此列。
const BASH_WORD_EXPANDS_RE = /^~[A-Za-z0-9_.-]*(?:\/|$)|[*?]|\[[^\]]+\]|\{[^{}]*,[^{}]*\}/;
function bashNonLiteral(n, text) {
  if (!n) return /[$`]/.test(String(text));
  if (EXPANSION_TYPES.has(n.type) || n.type === 'brace_expression') return true;
  if (n.type === 'word' && BASH_WORD_EXPANDS_RE.test(String(n.text))) return true;
  // 串接詞（j{x,y}、~/x$y）：大括號跨子節點、~ 只看整詞開頭
  if (n.type === 'concatenation' && /^~[A-Za-z0-9_.-]*(?:\/|$)|\{[^{}]*,[^{}]*\}/.test(String(n.text))) return true;
  for (let i = 0; i < n.namedChildCount; i++) if (bashNonLiteral(n.namedChild(i), '')) return true;
  return false;
}
// bash 文法的詞節點（PowerShell 指令裡 Start-Process／bash -c 叫起的內層是 bash 樹，依節點型別分辨而不是依 tool）
const BASH_WORD_TYPES = new Set(['word', 'raw_string', 'string', 'concatenation', 'ansi_c_string', 'translated_string', 'number', 'string_content']);
// 一個詞 → { value, literal, text }；PowerShell 的 --% 之後整串照字面傳給程式（引號由 C runtime 剝）
function tokensOf(e, isPs) {
  const out = [];
  const ws = e.words || [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const n = w.node;
    const text = n ? String(n.text) : String(w.value == null ? '' : w.value);
    const bashNode = !n || BASH_WORD_TYPES.has(n.type) || EXPANSION_TYPES.has(n.type);
    if (!isPs || bashNode) { out.push({ value: String(w.value == null ? '' : w.value), literal: !bashNonLiteral(n, text), text }); continue; }
    const t = text.trim();
    const type = n ? n.type : '';
    if (type === 'stop_parsing') {
      for (const tok of t.replace(/^--%\s*/, '').split(/\s+/).filter(Boolean)) out.push({ value: stripArgQuotes(tok), literal: true, text: tok });
      continue;
    }
    if (type === 'generic_token' || type === 'command_parameter' || type === 'command_name') { out.push({ value: unbacktick(t), literal: !/\$/.test(t), text: t }); continue; }
    if (/^'[^']*'$/.test(t)) { out.push({ value: t.slice(1, -1), literal: true, text: t }); continue; }
    if (/^"(?:[^"`$]|`.)*"$/.test(t)) { out.push({ value: unbacktick(t.slice(1, -1)), literal: true, text: t }); continue; }
    if (type === 'command_name_expr') {
      const q = /^(['"])([\s\S]*)\1$/.exec(t);
      out.push(q ? { value: q[2], literal: true, text: t } : { value: String(w.value), literal: false, text: t });
      continue;
    }
    out.push({ value: String(w.value == null ? '' : w.value), literal: false, text: t });   // @(…)、(…)、$x、$env:X、"…$x…"
  }
  return out;
}

function astCalls(a, tool, cwd, depth, fullText) {
  const isPs = tool === 'PowerShell';
  const calls = [];
  const execs = a.execs || [];
  const scopeEntry = a.scopeEntry || {};
  const parentOf = (e) => { const i = scopeEntry[e.scope]; return i === undefined ? null : execs[i]; };
  const underXargs = (e) => { const p = parentOf(e); return !!(p && (p.verb === 'xargs' || p.verb === 'find')); };
  const CD_RE = /^(?:cd|chdir|set-location|sl|pushd|push-location|popd|pop-location)$/;
  const cdLike = execs.filter((x) => CD_RE.test(x.verb));
  // dirAt 判不準時的兜底：整條就一個 cd（不是 pushd／popd）、在這個 git 之前、同一個殼或外層殼、恰好一個引數 → 拿它的目標
  const cdHintFor = (e) => {
    if (cdLike.length !== 1) return null;
    const c = cdLike[0];
    if (!/^(?:cd|chdir|set-location|sl)$/.test(c.verb) || c.index >= e.index) return null;
    if (!(e.scope === c.scope || e.scope.startsWith(c.scope + '/'))) return null;
    if (c.argv.length !== 2 || /^-/.test(c.argv[1])) return null;
    return c.argv[1];
  };
  const noLocationHints = cdLike.length === 0;

  for (let idx = 0; idx < execs.length; idx++) {
    const e = execs[idx];
    const words = tokensOf(e, isPs);
    if (!words.length) continue;
    const w0 = words[0];
    if (!(isGitName(w0.value) || isGitName(w0.text))) {
      // 指令名執行期才知道（命令替換、PowerShell 運算式）：提到 git 字樣（含拆字拼接 ('g'+'it')）一律判不出；沒提到但後面接 git 危險動詞
      // 也判不出（藍方新 1：`"$(printf 'g%s' it)" add .`）。純變數（$G、& $tool）維持已知盲區，見檔頭
      if (!w0.literal) {
        const lit = literalNameOf(w0.text);   // $(which python)：指令名就是 python，不是 git 就不必判不出
        const lg = lit ? GIT_NAME_RE.test(lit) : looseGit(w0.text);
        const dv = lg || lit ? null : (isPlainVar(w0.text) ? null : dangerVerbInWords(words.slice(1)));
        if (lg || dv) calls.push(mkCall({ unsure: unsureNameMsg(w0.text, dv), name: w0.text, at: idx, dirUnsure: true, repoUnsure: true }));
        // `arr=(git add .); ${arr[@]}`：整條指令由陣列攤平而來、指令名後面什麼都沒有——同一條指令文字裡提到 git 或含危險動詞就判不出
        // （R3 複驗第四輪 F8-v1；`${arr[0]} add .` 走上面的規則）
        else if (/^\$\{[A-Za-z_]\w*\[[@*]\]\}$/.test(String(w0.text).trim()) && (looseGit(fullText) || DANGER_VERB_RE.test(String(fullText || '')))) {
          calls.push(mkCall({ unsure: '整條指令由陣列攤平（' + w0.text + '）、內容執行期才知道，而同一條指令裡提到 git 或 git 危險動詞——請改成字面寫法', name: w0.text, at: idx, dirUnsure: true, repoUnsure: true }));
        }
        // `('g'+'it') | % { & $_ add . }`／`'git' | ForEach-Object { & $_ add . }`：$_ 是純變數，但它的值就是管線餵進來的字面或運算式
        // （shell-model 把來源記在 %／ForEach-Object 那個 exec 的 heredocRaw）——來源提到 git 或 argv 含危險動詞就判不出；
        // 來源是純變數（`$list | % { & $_ add . }`）沒記來源，維持放行（R3 複驗第二輪 F6）
        else if (/^\$(?:_|PSItem)$/i.test(String(w0.text).trim())) {
          const fe = execs.slice(0, idx).reverse().find((x) => /^(?:%|foreach-object|foreach)$/.test(String(x.verb)) && x.raw && e.raw && String(x.raw).indexOf(String(e.raw)) >= 0);
          const src = fe && fe.heredocRaw;
          if (src) {
            const sg = looseGit(src);
            const sdv = sg ? null : dangerVerbInWords(words.slice(1));
            if (sg || sdv) calls.push(mkCall({ unsure: '管線餵進 ' + w0.text + ' 的值執行期才知道（來源：' + String(src).slice(0, 60) + (sg ? '，提到 git' : '；引數含 git 危險動詞字樣 ' + sdv) + '）——請改成字面指令名', name: w0.text, at: idx, dirUnsure: true, repoUnsure: true }));
          }
        }
      }
      collectNonGit(e, words, isPs, calls, idx, cwd, depth, underXargs(e));
      continue;
    }
    const c = mkCall({ name: w0.text, at: idx, source: 'ast' });
    c.viaXargs = underXargs(e);
    const where = a.dirAt ? a.dirAt(idx) : null;
    c.dirUnsure = !where || !!where.unsure;
    let cur = c.dirUnsure ? null : where.dir;
    if (c.dirUnsure) {
      const h = cdHintFor(e);
      if (h) { const hv = expandTmpVars(h); if (hv && !/[$%`]/.test(hv)) cur = path.resolve(fromPosix(cwd || process.cwd()), hv); }
    }
    // 環境：GIT_CONFIG_PARAMETERS／GIT_CONFIG_COUNT 定義的 alias、GIT_DIR／GIT_WORK_TREE 改 repo 位置
    const envOf = (n) => { try { return a.envInfo(idx, n); } catch (e2) { return { values: [], unsure: true, opaque: false }; } };
    const aliases = {};
    let aliasUnknown = false, repoUnsure = false;
    let gitDir = null, workTree = null;
    const ep = envOf('GIT_CONFIG_PARAMETERS');
    if (ep.unsure || ep.opaque) aliasUnknown = true; else for (const v of ep.values) if (v) parseConfigParams(v, aliases);
    const ec = envOf('GIT_CONFIG_COUNT');
    if (ec.unsure || ec.opaque) aliasUnknown = true;
    else for (const v of ec.values) {
      const n = parseInt(v, 10);
      for (let k = 0; n > 0 && k < Math.min(n, 64); k++) {
        const ek = envOf('GIT_CONFIG_KEY_' + k), ev = envOf('GIT_CONFIG_VALUE_' + k);
        if (ek.unsure || ek.opaque || ev.unsure || ev.opaque) { aliasUnknown = true; continue; }
        const key = ek.values.find(Boolean);
        if (key && /^alias\./i.test(key)) aliases[key.slice(6).toLowerCase()] = ev.values.find(Boolean) || '';
      }
    }
    const ed = envOf('GIT_DIR');
    if (ed.unsure || ed.opaque) repoUnsure = true; else if (ed.values.some(Boolean)) gitDir = { value: ed.values.find(Boolean), literal: true };
    const ew = envOf('GIT_WORK_TREE');
    if (ew.unsure || ew.opaque) repoUnsure = true; else if (ew.values.some(Boolean)) workTree = { value: ew.values.find(Boolean), literal: true };

    // 全域選項
    const hints = [];
    let i = 1, inert = false, unsure = null;
    while (i < words.length) {
      const t = words[i];
      const v = t.value;
      if (!t.literal) {
        if (/^-/.test(t.text) || /^-/.test(v)) { unsure = unsure || ('全域選項執行期才知道（' + t.text + '）'); i++; continue; }
        break;
      }
      let m;
      if (v === '-C') { const n = words[i + 1]; if (!n) { unsure = '-C 缺值'; break; } hints.push(n); i += 2; continue; }
      if (v === '-c') { const n = words[i + 1]; if (!n) { unsure = '-c 缺值'; break; } if (n.literal) parseAliasDef(n.value, aliases); else aliasUnknown = true; i += 2; continue; }
      if (v === '--config-env') { const n = words[i + 1]; if (n && /^alias\./i.test(n.value)) aliasUnknown = true; i += 2; continue; }
      if (/^--config-env=/.test(v)) { if (/^--config-env=alias\./i.test(v)) aliasUnknown = true; i++; continue; }
      if ((m = /^--(git-dir|work-tree|namespace|super-prefix|attr-source)$/.exec(v))) {
        const n = words[i + 1]; if (!n) { unsure = v + ' 缺值'; break; }
        if (m[1] === 'git-dir') gitDir = n; else if (m[1] === 'work-tree') workTree = n;
        i += 2; continue;
      }
      if ((m = /^--(git-dir|work-tree|namespace|super-prefix|attr-source|exec-path|list-cmds)=([\s\S]*)$/.exec(v))) {
        if (m[1] === 'git-dir') gitDir = { value: m[2], literal: true }; else if (m[1] === 'work-tree') workTree = { value: m[2], literal: true }; else if (m[1] === 'list-cmds') inert = true;
        i++; continue;
      }
      if (/^(?:--exec-path|--html-path|--man-path|--info-path|--version|--help|-h|-v)$/.test(v)) { inert = true; break; }
      if (/^--/.test(v)) { i++; continue; }
      if (/^-./.test(v)) { i++; continue; }
      break;
    }
    // 位置：dirAt（含 cd）→ 依序套 -C；--git-dir／--work-tree 相對於它
    for (const h of hints) {
      const hv = expandTmpVars(h.value);
      c.hints.push(h.value);
      if (!hv || /[$%`]/.test(hv)) { repoUnsure = true; cur = null; break; }
      cur = path.isAbsolute(hv) ? hv : (cur ? path.resolve(cur, hv) : null);
      if (!cur) { repoUnsure = true; break; }
    }
    const resolveRel = (tok) => {
      if (!tok) return null;
      const v = expandTmpVars(tok.value);
      if (!v || /[$%`]/.test(v)) { repoUnsure = true; return null; }
      if (path.isAbsolute(v)) return v;
      if (cur) return path.resolve(cur, v);
      repoUnsure = true; return null;
    };
    c.gitDir = resolveRel(gitDir);
    c.workTree = resolveRel(workTree);
    c.dir = cur;
    c.repoDir = c.gitDir || c.workTree || cur;
    c.repoUnsure = repoUnsure || !c.repoDir;
    c.cwdFallbackOk = noLocationHints && !hints.length && !gitDir && !workTree && !repoUnsure;
    if (inert) { c.inert = true; calls.push(c); continue; }
    if (unsure) { c.unsure = unsure; calls.push(c); continue; }

    // 動詞
    const vt = words[i];
    if (!vt) {
      if (c.viaXargs) c.unsure = '動詞由管線資料供給（xargs／find -exec 叫起、沒有自己的子指令）'; else c.inert = true;
      calls.push(c); continue;
    }
    if (!vt.literal) { c.unsure = '動詞執行期才知道（' + vt.text + '）'; calls.push(c); continue; }
    if (/\{[^}]*,[^}]*\}/.test(vt.value) || /[*?]/.test(vt.value)) { c.unsure = '動詞含展開語法（' + vt.text + '）'; calls.push(c); continue; }
    let verb = vt.value.toLowerCase();
    let rest = words.slice(i + 1);
    if (Object.prototype.hasOwnProperty.call(aliases, verb)) {
      const av = aliases[verb];
      if (/^!/.test(av)) {
        // shell alias：值是 shell 指令。遞迴解析取其中的 git 呼叫；解析不了就判不出
        const sub = analyzeNested(av.slice(1), 'Bash', cur || cwd, depth + 1);
        if (!sub) { c.unsure = 'alias 值是 shell 指令、解析不了（!' + av.slice(1, 40) + '）'; calls.push(c); continue; }
        for (const sc of sub.calls) { sc.alias = { name: vt.value, value: av }; if (!sc.repoDir) { sc.repoDir = c.repoDir; sc.repoUnsure = c.repoUnsure; } calls.push(sc); }
        c.inert = true; calls.push(c); continue;
      }
      const aw = splitWords(av);
      verb = (aw[0] || '').toLowerCase();
      rest = aw.slice(1).map((x) => ({ value: x, literal: true, text: x })).concat(rest);
      c.alias = { name: vt.value, value: av };
      if (!verb) { c.inert = true; calls.push(c); continue; }
    } else if (aliasUnknown && !KNOWN_GIT_CMDS.has(verb)) {
      c.unsure = 'alias 定義執行期才知道（' + verb + ' 可能是當場定義的 alias）'; calls.push(c); continue;
    }
    c.verb = verb;
    c.argv = rest.map((x) => x.value);
    c.argvLiteral = rest.map((x) => !!x.literal);
    c.args = joinArgs(c.argv);
    calls.push(c);
    // 子指令自己再去執行 shell 指令的：`submodule foreach [--recursive] <cmd>`、`bisect run <cmd>`、`rebase -x／--exec <cmd>`、
    // `filter-branch --tree-filter／--index-filter／--env-filter <cmd>`——內層指令另解析（在哪個目錄執行判不出）
    const inner = innerShellOf(verb, c.argv);
    if (inner !== null) {
      const sub = analyzeNested(inner, 'Bash', cur || cwd, depth + 1);
      if (!sub) calls.push(mkCall({ unsure: 'git ' + verb + ' 要執行的內層指令解析不了', at: idx, dirUnsure: true, repoUnsure: true }));
      else for (const sc of sub.calls) { sc.dirUnsure = true; if (!sc.gitDir && !sc.workTree) { sc.dir = null; sc.repoDir = null; sc.repoUnsure = true; sc.cwdFallbackOk = false; } calls.push(sc); }
    }
  }
  return calls;
}
function innerShellOf(verb, argv) {
  const a = argv || [];
  if (verb === 'submodule') {
    const k = a.indexOf('foreach');
    if (k < 0) return null;
    const rest = a.slice(k + 1).filter((x) => !/^(?:--recursive|-q|--quiet)$/.test(x));
    return rest.length ? joinArgs(rest) : null;
  }
  if (verb === 'bisect' && a[0] === 'run') return a.length > 1 ? joinArgs(a.slice(1)) : null;
  if (verb === 'rebase') {
    for (let k = 0; k < a.length; k++) {
      if ((a[k] === '-x' || a[k] === '--exec') && a[k + 1] !== undefined) return a[k + 1];
      const m = /^--exec=([\s\S]*)$/.exec(a[k]); if (m) return m[1];
    }
    return null;
  }
  if (verb === 'filter-branch') {
    for (let k = 0; k < a.length; k++) if (/^--(?:tree|index|env|commit|msg|parent|tag-name|subdirectory)-filter$/.test(a[k]) && a[k + 1] !== undefined) return a[k + 1];
    return null;
  }
  return null;
}

// 不是 git 的指令：直譯器字串、parallel、xargs 把管線資料交給 sh -c、eval／iex 的非字面引數
function collectNonGit(e, words, isPs, calls, idx, cwd, depth, viaXargs) {
  const verb = e.verb;
  const code = codeArgsOf(verb, e.argv);
  if (INTERP_VERBS.test(verb)) { if (e.heredocRaw) code.push(e.heredocRaw); if (e.herestringRaw) code.push(e.herestringRaw); }
  for (const s of code) if (EXEC_KW.test(s)) for (const c of textCalls(s, 'interp', idx)) calls.push(c);
  if (verb === 'parallel') {
    let tpl = null;
    for (let k = 1; k < e.argv.length; k++) {
      const x = e.argv[k];
      if (x === ':::' || x === '::::') break;
      if (/^-/.test(x)) { if (/^-(?:j|S|a|results|tmpdir|joblog)$/.test(x)) k++; continue; }
      tpl = x; break;
    }
    if (tpl !== null) {
      const sub = analyzeNested(tpl.replace(/\{[^}]*\}/g, 'X'), 'Bash', cwd, depth + 1);
      if (!sub) calls.push(mkCall({ unsure: 'parallel 的指令樣板解析不了', at: idx, dirUnsure: true, repoUnsure: true }));
      else for (const sc of sub.calls) { sc.dirUnsure = true; if (!sc.gitDir && !sc.workTree) { sc.dir = null; sc.repoDir = null; sc.repoUnsure = true; } calls.push(sc); }
    }
  }
  if (/^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)$/.test(verb) && viaXargs && e.argv.some((x) => /\{\}/.test(x))) {
    calls.push(mkCall({ unsure: '管線資料經 xargs 交給 ' + verb + ' -c 執行，內容執行期才知道', at: idx, dirUnsure: true, repoUnsure: true }));
  }
  // eval／iex 的非字面引數：提到 git（含拆字拼接 ('g'+'it add .')）或帶 git 危險動詞就判不出
  if (/^(?:eval|iex|invoke-expression)$/.test(verb)) {
    const w = words.slice(1).find((x) => !x.literal && (looseGit(x.text) || dangerVerbInText(x.text)));
    if (w) calls.push(mkCall({ unsure: verb + ' 的字串執行期才組出來（' + (looseGit(w.text) ? '裡面提到 git' : '裡面有 git 危險動詞 ' + dangerVerbInText(w.text)) + '）', at: idx, dirUnsure: true, repoUnsure: true }));
    // 管線餵進來的運算式（`('g'+'it push') | iex`）：shell-model 解析不出指令、把原文留在 pipedExpr，同一判準
    const pe = e.pipedExpr;
    if (!w && pe && (looseGit(pe) || dangerVerbInText(pe))) {
      calls.push(mkCall({ unsure: verb + ' 由管線收到的運算式執行期才組出來（' + (looseGit(pe) ? '裡面提到 git' : '裡面有 git 危險動詞 ' + dangerVerbInText(pe)) + '：' + String(pe).slice(0, 60) + '）', at: idx, dirUnsure: true, repoUnsure: true }));
    }
  }
}

function analyzeNested(text, tool, cwd, depth) {
  if (depth > 3) return null;
  const sm = shellModel();
  if (!sm || !parserAvailable(tool)) return null;
  let a;
  try { a = sm.analyze(String(text), tool, cwd || process.cwd(), cwd || process.cwd()); } catch (e) { return null; }
  if (!a || a.hasError) return null;
  return { analysis: a, calls: astCalls(a, tool, cwd, depth, text) };
}

// bash 的字中續行（git ad\⏎d → git add）：bash 在斷詞前就刪掉反斜線＋換行，tree-sitter 卻會把它當成分隔，先還原
function joinWordContinuations(s) {
  return String(s).replace(/([A-Za-z0-9_.\-])\\\r?\n([A-Za-z0-9_.\-])/g, '$1$2');
}

// ── 正則路徑（退回）────────────────────────────────────────────────────────
// heredoc 主體是餵給程式的資料（cat <<EOF > note.md），剝掉。例外：餵給殼或直譯器的（bash <<EOF、python - <<EOF）、
// 主體被管線餵進殼的（cat <<'EOF' | sh）本身就是程式碼，要留——dataMask 再決定裡面的引號遮不遮。
function heredocKind(head, tail) {
  if (/\b(bash|sh|zsh|dash|ksh|pwsh|powershell)(\.exe)?\b/.test(head) && !/\b(cat|tee)\b/.test(head)) return 'shell';
  if (PIPE_TO_SHELL_ONE.test(tail)) return 'shell';
  if (/\b(python3?|py|node|perl|ruby|php)(\.exe)?\b/.test(head) && !/\b(cat|tee)\b/.test(head)) return 'interp';
  return 'data';
}
function stripHeredocs(s) {
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const lineStart = s.lastIndexOf('\n', m.index) + 1;
    const head = s.slice(lineStart, m.index);
    if (heredocKind(head, m[3]) !== 'data') continue;
    const endRe = new RegExp('\\n\\s*' + m[2] + '\\s*(\\n|$)');
    const tail = s.slice(m.index + m[0].length - 1);
    const em = endRe.exec(tail);
    if (!em) break;
    const bodyEnd = m.index + m[0].length - 1 + em.index + em[0].length;
    out += s.slice(last, m.index + m[0].length);
    last = bodyEnd;
    re.lastIndex = bodyEnd;
  }
  return out + s.slice(last);
}

// 引號裡的字是交給程式的參數（grep／rg／sed 的 pattern、echo 的字串），不是要執行的指令——遮掉。
// 不遮的：雙引號裡的 $( ) 與反引號（照樣先執行）、交給殼的引號字串（bash／sh -c、powershell -Command、cmd /c、eval、iex、
// 加 -- 或 -o 之類旗標的也算）、直譯器的引號字串（node -e、python -c…）只在字串裡有「執行外部程式」的呼叫時不遮、
// 餵給殼的 heredoc 本文不遮、餵給直譯器的 heredoc 本文同直譯器字串的判法。
const SHELL_RUNS = new RegExp('(?:^|[\\s;&|(`])(?:' + [
  '(?:bash|sh|zsh|dash|ksh|pwsh|powershell)(?:\\.exe)?(?:\\s+(?:-[-A-Za-z]*(?:\\s+[^\\s"\'-]\\S*)?|--))*\\s+-[A-Za-z]*[cC][A-Za-z]*(?:\\s+--)?',
  '(?:pwsh|powershell)(?:\\.exe)?(?:\\s+-\\S+(?:\\s+[^\\s"\'-]\\S*)?)*\\s+(?:-{1,2}|\\/{1,2})(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?|EncodedCommand|cwa)',
  'cmd(?:\\.exe)?(?:\\s+\\/{1,2}[A-Za-z])*\\s+\\/{1,2}[cCkK]',
  'eval|iex|Invoke-Expression|watch|parallel|su\\s+(?:-\\S+\\s+)*-c|script\\s+(?:-\\S+\\s+)*-c',
].join('|') + ')\\s*$', 'i');
const INTERP_RUNS = /(?:^|[\s;&|(`])(?:node|bun|python3?|py|perl|ruby|php|lua)(?:\.exe)?(?:\s+-\S+)*?\s+(?:-[A-Za-z]*[ceEr]|--eval|--print|-p)\s*$|(?:^|[\s;&|(`])[gmn]?awk(?:\s+-[FvW]\s+\S+)*\s*$/i;

// 管線把資料餵進殼（printf 'git add .' | sh、| /bin/sh、| /usr/bin/env bash、| bash -s、| source /dev/stdin、
// | xargs -I{} sh -c '{}'、PowerShell 的 | Invoke-Expression）：那段資料就是要執行的指令
const PIPE_TO_SHELL_SRC = '\\|\\s*(?:sudo\\s+)?(?:(?:[\\w./\\\\:-]*[/\\\\])?(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)(?:\\.exe)?|(?:[\\w./\\\\:-]*[/\\\\])?env\\s+(?:bash|sh|zsh|dash|ksh)|(?:source|\\.)\\s+/dev/(?:stdin|fd/0)|xargs\\b[^|\\n;&]*?\\b(?:sh|bash|zsh|dash|ksh|pwsh|powershell|cmd)(?:\\.exe)?\\b[^|\\n;&]*\\{\\}|Invoke-Expression|iex)(?=[\\s;&|)\'"]|$)';
const PIPE_TO_SHELL = new RegExp(PIPE_TO_SHELL_SRC, 'gi');
const PIPE_TO_SHELL_ONE = new RegExp(PIPE_TO_SHELL_SRC, 'i');

function dataMask(s, isPs) {
  const mask = new Uint8Array(s.length);
  const esc = isPs ? '`' : '\\';
  const runsKind = (i) => {
    const line = s.slice(s.lastIndexOf('\n', i - 1) + 1, i);
    if (SHELL_RUNS.test(line)) return 'shell';
    if (INTERP_RUNS.test(line)) return 'interp';
    return null;
  };
  const pending = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === esc) { i += 2; continue; }
    if (c === '\n' && pending.length) {
      // 殼／直譯器 heredoc 本文：殼的整段當程式碼不遮；直譯器的看有沒有執行外部程式的呼叫，沒有就整段遮
      let pos = i + 1;
      for (const hd of pending) {
        const start = pos;
        while (pos < s.length) {
          let end = s.indexOf('\n', pos);
          if (end === -1) end = s.length;
          const line = s.slice(pos, end).replace(/\r$/, '').trim();
          pos = end + 1;
          if (line === hd.delim) break;
        }
        if (hd.kind === 'interp' && !EXEC_KW.test(s.slice(start, pos))) for (let k = start; k < pos && k < s.length; k++) mask[k] = 1;
      }
      pending.length = 0;
      i = pos;
      continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const hm = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
      if (hm) {
        const lineStart = s.lastIndexOf('\n', i) + 1;
        let lineEnd = s.indexOf('\n', i); if (lineEnd < 0) lineEnd = s.length;
        pending.push({ delim: hm[2], kind: heredocKind(s.slice(lineStart, i), s.slice(i + hm[0].length, lineEnd)) });
        i += hm[0].length; continue;
      }
    }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      if (isPs && s[i + 1] === '>') { i++; continue; }
      // 註解不執行；不跳過的話註解裡的 don't 會被當成開引號，把下一行真的 git push 一起蓋掉
      while (i < s.length && s[i] !== '\n') mask[i++] = 1;
      continue;
    }
    if (isPs && c === '<' && s[i + 1] === '#') {
      // PowerShell 區塊註解 <# … #>
      let e2 = s.indexOf('#>', i + 2);
      if (e2 < 0) e2 = s.length - 2;
      for (let k = i; k < e2 + 2 && k < s.length; k++) mask[k] = 1;
      i = e2 + 2; continue;
    }
    if (c === "'") {
      let e2 = s.indexOf("'", i + 1);
      if (e2 < 0) e2 = s.length;
      const kind = runsKind(i);
      const live = kind === 'shell' || (kind === 'interp' && EXEC_KW.test(s.slice(i + 1, e2)));
      if (!live) for (let k = i + 1; k < e2; k++) mask[k] = 1;
      i = e2 + 1;
      continue;
    }
    if (c === '"') {
      const kind = runsKind(i);
      let close = i + 1;
      while (close < s.length && s[close] !== '"') { if (s[close] === esc) close++; close++; }
      const live = kind === 'shell' || (kind === 'interp' && EXEC_KW.test(s.slice(i + 1, close)));
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === esc) { if (!live) { mask[j] = 1; if (j + 1 < s.length) mask[j + 1] = 1; } j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '(') {
          let depth = 0;
          while (j < s.length) {
            if (s[j] === '(') depth++;
            else if (s[j] === ')' && --depth === 0) { j++; break; }
            j++;
          }
          continue;
        }
        if (!isPs && s[j] === '`') {
          const e2 = s.indexOf('`', j + 1);
          j = e2 < 0 ? s.length : e2 + 1;
          continue;
        }
        if (!live) mask[j] = 1;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return mask;
}
// 把同一條管線前面各段的遮罩拿掉，照指令解析；回傳被解除遮罩的區間（那幾段是「餵進殼的指令」，不再當成 grep／printf 的資料）
function unmaskPipedToShell(s, mask) {
  const fed = [];
  PIPE_TO_SHELL.lastIndex = 0;
  let m;
  while ((m = PIPE_TO_SHELL.exec(s)) !== null) {
    if (mask[m.index]) continue;
    let start = m.index;
    while (start > 0 && !((s[start - 1] === ';' || s[start - 1] === '\n' || s[start - 1] === '&') && !mask[start - 1])) start--;
    for (let k = start; k < m.index; k++) mask[k] = 0;
    fed.push([start, m.index]);
  }
  mask.fed = fed;
  return mask;
}

// 解析前先把 shell 執行時會消失的寫法還原：字中續行 git ad\⏎d → git add（PowerShell 沒有這種續行）；
// 指令位置上被引號包住或拆開的 git（"git"、'git'、g''it、g"i"t）→ git；前導反斜線 \git → git。
// 只動「指令位置」的字（行首、分隔符後、前綴程式之後），grep -w "git" 這種參數不碰。
// 前綴程式那個分支要排在前面：排在後面時，掃描器會先用「行首＋一個詞」吃掉 nice／sudo 本身，輪到 g''it 時前面已經沒有前綴可配
const CMD_WORD = /((?:^|[\s;&|(`{\n])(?:-exec|-execdir|-ok|-okdir|xargs(?:\s+-\S+(?:\s+\{\})?)*|sudo|doas|env|nohup|nice|time|timeout\s+\S+|command|builtin|exec|eval|winpty|watch|parallel|&)\s+|^|[;&|(`{\n"']\s*)(\\?(?:[A-Za-z.]|'[A-Za-z.]*'|"[A-Za-z.]*")+)(?=[\s;&|)"']|$)/g;
function normalize(s, isPs) {
  let out = String(s);
  if (!isPs) {
    // bash 在斷詞前就刪掉反斜線＋換行（引號外），tree-sitter 與字串比對都看不到這件事
    out = out.replace(/\\\r?\n/g, '');
    // ANSI-C 字串先解碼成單引號字串（$'\x67it' → 'git'、gi$'t' → gi't'），下面指令位置的引號還原才認得出 git；
    // locale 翻譯字串 $"…" 等於 "…"（沒有翻譯檔），把 $ 拿掉（R3 複驗第二輪 F5：`$"git" add .`、`$"gi"t push`）
    out = expandAnsiC(out).replace(/\$(?=")/g, '');
    // 空引號對是空字串，黏在字母之間等於沒有（g''it、gi""t、bash -c "g''it add"）
    out = out.replace(/([A-Za-z])(?:''|"")(?=[A-Za-z])/g, '$1').replace(/(^|[\s;&|(`"'])(?:''|"")(?=[A-Za-z])/g, '$1');
  }
  // 加引號的完整路徑（"C:\Program Files\Git\cmd\git.exe" push、& 'C:/…/git.exe' …）換成裸的 git：不換的話整段被當成引述
  out = out.replace(/(["'])[^"'\n]*[\/\\]git(?:\.(?:exe|cmd|bat|com))?\1(?=\s)/gi, ' git');
  out = out.replace(CMD_WORD, (all, pre, word) => {
    if (!/['"\\]/.test(word)) return all;
    const bare = word.replace(/['"]/g, '').replace(/^\\/, '');
    return GIT_NAME_RE.test(bare) ? pre + bare : all;
  });
  return out;
}

// 這個 git 呼叫之前最後一個 cd／Set-Location／pushd 的目標；整條有 popd／Pop-Location（回到不知道哪裡）回 null
function lastCdBefore(text, at) {
  if (/(^|[;&|(\s])(?:popd|Pop-Location)(?=[\s;&|)]|$)/i.test(text)) return null;
  const re = new RegExp('(^|[;&|(]\\s*|\\n\\s*)(?:cd|chdir|Set-Location|sl|pushd|Push-Location)\\s+(' + ARG_NOSEP + ')', 'gi');
  let hit = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > at) break;
    const t = stripArgQuotes(m[2]);
    hit = /^-/.test(t) ? null : t;   // cd -P x、cd - 這類帶旗標或回上一個目錄：判不出
  }
  return hit;
}

// 段首是只吃資料的指令（grep／echo／rg…）時，後面出現的 git 字樣是它的參數（`grep -rn git push docs`），不是呼叫；
// 段落被管線餵進殼（unmaskPipedToShell 記下的 fed 區間）除外
const DATA_HEAD = /^(?:echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|sed|head|tail|less|more|type|wc|sort|uniq|find|ls|dir|man|which|where|Select-String|sls|Get-Content|gc|Write-Host|Write-Output|Out-File|Set-Content|Add-Content|tee)(?:\.exe)?$/i;

function parseGitCalls(text, mask, isPs, cwd) {
  const calls = [];
  const src = String(text);
  const fed = (mask && mask.fed) || [];
  const re = /(^|[^A-Za-z0-9_.\-])git(?:\.(?:exe|cmd|bat|com))?(?=\s|$|[<>])/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const gitAt = m.index + m[1].length;
    if (mask && mask[gitAt]) continue;
    // 段首（往前找最近一個沒被遮罩的分隔符）
    let segStart = gitAt;
    while (segStart > 0) {
      const ch = src[segStart - 1];
      if (/[;&|\n(`]/.test(ch) && !(mask && mask[segStart - 1])) break;
      segStart--;
    }
    const before = src.slice(segStart, gitAt).trim();
    const inFed = fed.some(([a, b]) => gitAt >= a && gitAt < b);
    const viaXargs = /(?:^|[\s;&|(])xargs(?:\s|$)/i.test(before) || /(?:^|\s)-(?:exec|execdir|ok|okdir)(?:\s|$)/.test(before);
    if (before && !inFed) {
      const first = before.split(/\s+/)[0].replace(/^["']|["']$/g, '');
      if (DATA_HEAD.test(first) && !/(^|\s)-(exec|execdir|ok|okdir)(\s|$)/.test(before)) continue;
    }
    // 呼叫的範圍：到下一個沒被遮罩的 ; & | 或換行（反斜線續行不算結束）
    let end = gitAt + (m[0].length - m[1].length);
    while (end < src.length) {
      const ch = src[end];
      if (mask && mask[end]) { end++; continue; }
      if (ch === ';' || ch === '&' || ch === '|') break;
      if (ch === '\n' || ch === '\r') {
        const b = src.slice(0, end).replace(/[ \t]*$/, '');
        if (!b.endsWith('\\')) break;
      }
      end++;
    }
    let rest = src.slice(gitAt + (m[0].length - m[1].length), end).replace(/\\[ \t]*\r?\n/g, ' ').trim();
    const c = mkCall({ source: 'regex', name: src.slice(gitAt, gitAt + (m[0].length - m[1].length)), at: gitAt, viaXargs });
    // 前綴環境變數（GIT_CONFIG_PARAMETERS=…、GIT_CONFIG_COUNT=…、GIT_DIR=…）
    const aliases = {};
    let aliasUnknown = false, repoUnsure = false, gitDir = null, workTree = null;
    const envRe = new RegExp('(?:^|\\s)(GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\\d+|GIT_CONFIG_VALUE_\\d+|GIT_DIR|GIT_WORK_TREE)=(' + ARG + ')?', 'g');
    const envVals = {};
    let em;
    while ((em = envRe.exec(before)) !== null) {
      const v = stripArgQuotes(em[2] || '');
      if (/[$`%]/.test(v)) { if (/^GIT_CONFIG/.test(em[1])) aliasUnknown = true; else repoUnsure = true; continue; }
      envVals[em[1]] = v;
    }
    if (envVals.GIT_CONFIG_PARAMETERS) parseConfigParams(envVals.GIT_CONFIG_PARAMETERS, aliases);
    if (envVals.GIT_CONFIG_COUNT) {
      const n = parseInt(envVals.GIT_CONFIG_COUNT, 10);
      for (let k = 0; n > 0 && k < Math.min(n, 64); k++) {
        const key = envVals['GIT_CONFIG_KEY_' + k];
        if (key === undefined) { aliasUnknown = true; continue; }
        if (/^alias\./i.test(key)) aliases[key.slice(6).toLowerCase()] = envVals['GIT_CONFIG_VALUE_' + k] || '';
      }
    }
    if (envVals.GIT_DIR) gitDir = envVals.GIT_DIR;
    if (envVals.GIT_WORK_TREE) workTree = envVals.GIT_WORK_TREE;
    // 全域選項
    const hints = [];
    let inert = false, unsure = null;
    for (;;) {
      let m2;
      if (isPs && (m2 = rest.match(/^--%\s*/))) { rest = rest.slice(m2[0].length); continue; }
      if ((m2 = rest.match(new RegExp('^-C\\s+(' + ARG + ')\\s*')))) { hints.push(stripArgQuotes(m2[1])); rest = rest.slice(m2[0].length); continue; }
      if ((m2 = rest.match(new RegExp('^-c\\s+(' + ARG + ')\\s*')))) {
        const v = stripArgQuotes(m2[1]);
        if (/[$`]/.test(v)) aliasUnknown = true; else parseAliasDef(v, aliases);
        rest = rest.slice(m2[0].length); continue;
      }
      if ((m2 = rest.match(new RegExp('^--config-env(?:=|\\s+)(' + ARG + ')\\s*')))) { if (/^alias\./i.test(stripArgQuotes(m2[1]))) aliasUnknown = true; rest = rest.slice(m2[0].length); continue; }
      if ((m2 = rest.match(new RegExp('^--(git-dir|work-tree|namespace|super-prefix|attr-source)(?:=|\\s+)(' + ARG + ')\\s*')))) {
        if (m2[1] === 'git-dir') gitDir = stripArgQuotes(m2[2]); else if (m2[1] === 'work-tree') workTree = stripArgQuotes(m2[2]);
        rest = rest.slice(m2[0].length); continue;
      }
      if ((m2 = rest.match(/^(?:--exec-path|--html-path|--man-path|--info-path|--version|--help|-h|-v)(?:\s+|$)/))) { inert = true; break; }
      if ((m2 = rest.match(/^--list-cmds=\S*\s*/))) { inert = true; break; }
      if ((m2 = rest.match(new RegExp('^--[A-Za-z][\\w-]*(?:=' + ARG + ')?\\s*')))) { rest = rest.slice(m2[0].length); continue; }
      if ((m2 = rest.match(/^-[A-Za-z](?:\s+|$)/))) { rest = rest.slice(m2[0].length); continue; }
      break;
    }
    // 位置：cd → -C 依序；--git-dir／--work-tree 相對於它
    let cur = null;
    const cd = lastCdBefore(src, gitAt);
    const hasCdLike = /(^|[;&|(\s])(?:cd|chdir|Set-Location|sl|pushd|Push-Location|popd|Pop-Location)(?=[\s;&|)]|$)/i.test(src);
    if (!hasCdLike) cur = cwd ? fromPosix(cwd) : null;
    else if (cd !== null) { const cv = expandTmpVars(cd); if (cv && !/[$%`]/.test(cv)) cur = path.resolve(fromPosix(cwd || process.cwd()), cv); }
    for (const h of hints) {
      const hv = expandTmpVars(h);
      c.hints.push(h);
      if (!hv || /[$%`]/.test(hv)) { repoUnsure = true; cur = null; break; }
      cur = path.isAbsolute(hv) ? hv : (cur ? path.resolve(cur, hv) : null);
      if (!cur) { repoUnsure = true; break; }
    }
    const resolveRel = (v0) => {
      if (!v0) return null;
      const v = expandTmpVars(v0);
      if (!v || /[$%`]/.test(v)) { repoUnsure = true; return null; }
      if (path.isAbsolute(v)) return v;
      if (cur) return path.resolve(cur, v);
      repoUnsure = true; return null;
    };
    c.gitDir = resolveRel(gitDir);
    c.workTree = resolveRel(workTree);
    c.dir = cur;
    c.dirUnsure = !cur;
    c.repoDir = c.gitDir || c.workTree || cur;
    c.repoUnsure = repoUnsure || !c.repoDir;
    c.cwdFallbackOk = !hasCdLike && !hints.length && !gitDir && !workTree && !repoUnsure;
    if (inert) { c.inert = true; calls.push(c); continue; }
    if (unsure) { c.unsure = unsure; calls.push(c); continue; }
    // 動詞：第一個參數（引號、反斜線剝掉；PowerShell 的反引號跳脫解開）；黏著的重導向切掉（push>/dev/null）
    const vm = rest.match(new RegExp('^(' + ARG + ')([\\s\\S]*)$'));
    let verbTok = vm ? vm[1] : '';
    if (!verbTok) {
      if (c.viaXargs) c.unsure = '動詞由管線資料供給（xargs／find -exec 叫起、沒有自己的子指令）'; else c.inert = true;
      calls.push(c); continue;
    }
    verbTok = (verbTok.split(/(?<![0-9])[<>]|\d[<>]/)[0] || verbTok).replace(/\)+$/, '');
    if (isPs) verbTok = unbacktick(verbTok);
    if (/^[$`]|\$\(|`|\$\{/.test(verbTok) || /\{[^}]*,[^}]*\}/.test(verbTok) || /^[*?]/.test(verbTok)) { c.unsure = '動詞執行期才知道（' + verbTok + '）'; calls.push(c); continue; }
    let verb = verbTok.replace(/^\\+/, '');
    verb = isPs ? verb : verb.replace(/\\(.)/g, '$1');
    verb = stripArgQuotes(verb).replace(/["']/g, '').toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(verb)) { c.unsure = '動詞不是字面詞（' + verbTok + '）'; calls.push(c); continue; }
    let args = (vm && vm[2] ? vm[2] : '').trim();
    if (Object.prototype.hasOwnProperty.call(aliases, verb)) {
      const av = aliases[verb];
      if (/^!/.test(av)) {
        const sub = regexGitCalls(av.slice(1), isPs ? 'PowerShell' : 'Bash', cur || cwd);
        for (const sc of sub.calls) { sc.alias = { name: verb, value: av }; if (!sc.repoDir) { sc.repoDir = c.repoDir; sc.repoUnsure = c.repoUnsure; } calls.push(sc); }
        c.inert = true; calls.push(c); continue;
      }
      const aw = splitWords(av);
      c.alias = { name: verb, value: av };
      verb = (aw[0] || '').toLowerCase();
      args = (joinArgs(aw.slice(1)) + ' ' + args).trim();
      if (!verb) { c.inert = true; calls.push(c); continue; }
    } else if (aliasUnknown && !KNOWN_GIT_CMDS.has(verb)) {
      c.unsure = 'alias 定義執行期才知道（' + verb + ' 可能是當場定義的 alias）'; calls.push(c); continue;
    }
    c.verb = verb;
    c.args = args;
    const rawArgs = args.match(new RegExp(ARG, 'g')) || [];
    c.argv = rawArgs.map(stripArgQuotes);
    // 正則路徑看不到語法樹，字面與否用字元判：變數、命令替換、反引號、%VAR%、PowerShell 的 (…)／@(…)、bash 的 {}（xargs 佔位、brace 展開）；
    // bash 沒加引號的 ~ 開頭、*／?／[…] 萬用字元也是執行期才展開（與語法樹路徑的 bashNonLiteral 同判準）
    c.argvLiteral = rawArgs.map((raw, k) => {
      const t = c.argv[k];
      if (/[$`%(){}]/.test(t)) return false;
      if (!isPs && !/^['"]/.test(raw) && BASH_WORD_EXPANDS_RE.test(t)) return false;
      return true;
    });
    calls.push(c);
  }
  return calls;
}

function regexGitCalls(command, tool, cwd, opts) {
  const isPs = tool === 'PowerShell';
  const text = normalize(stripHeredocs(String(command)), isPs);
  const mask = unmaskPipedToShell(text, dataMask(text, isPs));
  const calls = parseGitCalls(text, mask, isPs, cwd);
  // 引號字串裡的 git：直譯器字串遮罩已依 EXEC_KW 決定留不留，留下來的在 parseGitCalls 已被當成呼叫；
  // list 形式（execFileSync('git',['add','.'])、subprocess.run(['git','push'])）沒有「git 空白動詞」可配，另掃沒被遮罩的部分
  GIT_LIST_FORM.lastIndex = 0;
  let lm;
  while ((lm = GIT_LIST_FORM.exec(text)) !== null) {
    if (mask[lm.index]) continue;
    const rest = (lm[2].match(/['"]([^'"]*)['"]/g) || []).map((x) => x.slice(1, -1));
    calls.push(mkCall({ source: 'interp', at: lm.index, verb: lm[1].toLowerCase(), args: joinArgs(rest), argv: rest, dirUnsure: true, repoUnsure: true }));
  }
  for (const c of dynamicNameCalls(text, mask, isPs, opts)) calls.push(c);
  // PowerShell 把字串當程式碼跑的形狀（[scriptblock]::Create、Invoke-Command -ScriptBlock、$ExecutionContext.InvokeCommand.InvokeScript）另掃
  if (isPs && PS_HIDDEN_EXEC.test(text)) { for (const c of textCalls(text, 'text', null)) calls.push(c); for (const c of hiddenExecExprCalls(text)) calls.push(c); }
  // 語法樹解析失敗退到這裡、而且正則路徑一個呼叫也認不出，但文字提到 git 且有「指令名是運算式／iex」的形狀：不靜默放行，
  // 發一個 unsure 讓 deny 文看得到是解析失敗（2026-10-18 R3 複驗 G2②：`& ([string]::Join('', @('g','i','t'))) checkout -- .` 原本 mode=regex、calls=[]）
  if (opts && opts.parseFailed && !calls.length && mentionsGit(text) && /(?:^|[;&|(\n{])\s*&\s*\(|\b(?:iex|Invoke-Expression)\b/i.test(text)) {
    calls.push(mkCall({ source: 'regex', unsure: tool + ' 語法樹解析失敗、退回正則路徑也認不出指令名，但指令裡提到 git 或 git 危險動詞——請改成字面寫法', dirUnsure: true, repoUnsure: true }));
  }
  return { mode: 'regex', analysis: null, calls, text, parseFailed: !!(opts && opts.parseFailed) };
}

// 從 text[open]（必須是 `(`）往後找配對的 `)`：引號裡的括號不算、巢狀任意層；找不到回 -1
function closeParen(text, open) {
  let depth = 0, q = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = null; else if (ch === '`' && q === '"') i++; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}
// 指令位置的名字執行期才知道：命令替換（$(which git)、"$(command -v git)"、"$(printf 'g%s' it)"、反引號）、PowerShell 的 `& (運算式)`／`& $var`、
// `Invoke-Expression (運算式)`、`(運算式) | iex`。與語法樹路徑同一判準：提到 git（含拆字拼接）就判不出；沒提到但同一段後面接 git 危險動詞
// 也判不出；純變數（& $tool list）只在提到 git 時算；`$(which X)` 的 X 是字面且不是 git 就當一般程式。括號用平衡計數配對（任意層巢狀；
// 2026-10-18 R3 複驗 G2②：原本的正則只吃一層，`& ([string]::Join('', @('g','i','t')))` 三層比不到）。被資料遮罩蓋住的位置不算指令位置
function dynamicNameCalls(text, mask, isPs, opts) {
  const out = [];
  const seen = new Set();
  const suffix = opts && opts.parseFailed ? '（語法樹解析失敗、退回正則路徑）' : '';
  const segRest = (from) => {
    let end = from;
    while (end < text.length) { if (!(mask && mask[end]) && /[;&|\n]/.test(text[end])) break; end++; }
    return text.slice(from, end);
  };
  const push = (at, name, rest, plainVar) => {
    if (seen.has(at)) return;
    const lit = literalNameOf(name);
    const lg = lit ? GIT_NAME_RE.test(lit) : looseGit(name);
    const dv = lg || lit || plainVar ? null : dangerVerbInText(rest);
    if (!lg && !dv) return;
    seen.add(at);
    out.push(mkCall({ source: 'regex', at, unsure: unsureNameMsg(name, dv) + suffix, name, dirUnsure: true, repoUnsure: true }));
  };
  // 指令位置（行首、分隔符後）：回傳每個候選起點
  const starts = [];
  const sepRe = /(^|[;&|(\n{])/g;
  let m;
  while ((m = sepRe.exec(text)) !== null) {
    let i = m.index + m[1].length;
    while (i < text.length && /[ \t]/.test(text[i])) i++;
    if (!(mask && mask[i])) starts.push(i);
    if (m[1] === '' && m.index === 0) sepRe.lastIndex = 1;
  }
  for (const s0 of starts) {
    let i = s0, ps = false;
    if (isPs && text[i] === '&') { i++; while (text[i] === ' ' || text[i] === '\t') i++; ps = true; }
    const quoted = text[i] === '"';
    const j = quoted ? i + 1 : i;
    // 命令替換 $(…)、"$(…)"
    if (text[j] === '$' && text[j + 1] === '(') {
      const e = closeParen(text, j + 1);
      if (e < 0) continue;
      let end = e + 1; if (quoted && text[end] === '"') end++;
      if (end < text.length && !/[\s;&|)\n]/.test(text[end])) continue;
      push(s0, text.slice(i, end), segRest(end), false);
      continue;
    }
    // 反引號 `which git`
    if (text[i] === '`') {
      const e = text.indexOf('`', i + 1);
      if (e < 0 || text.slice(i, e).indexOf('\n') >= 0) continue;
      if (e + 1 < text.length && !/[\s;&|)\n]/.test(text[e + 1])) continue;
      push(s0, text.slice(i, e + 1), segRest(e + 1), false);
      continue;
    }
    // bash 的 ${…}：純變數 ${G} 維持盲區；間接參照 ${!ref}、陣列元素 ${arr[0]}、帶預設值 ${x:-git} 走動態指令名規則
    if (!isPs && text[i] === '$' && text[i + 1] === '{') {
      const e = text.indexOf('}', i);
      if (e < 0) continue;
      const name = text.slice(i, e + 1);
      // `${arr[@]}`／`${arr[*]}` 整條指令由陣列攤平：看整條文字有沒有提到 git 或危險動詞（與語法樹路徑同判準）
      if (/^\$\{[A-Za-z_]\w*\[[@*]\]\}$/.test(name)) {
        if ((looseGit(text) || DANGER_VERB_RE.test(text)) && !seen.has(s0)) { seen.add(s0); out.push(mkCall({ source: 'regex', at: s0, unsure: '整條指令由陣列攤平（' + name + '）、內容執行期才知道，而同一條指令裡提到 git 或 git 危險動詞——請改成字面寫法' + suffix, name, dirUnsure: true, repoUnsure: true })); }
        continue;
      }
      push(s0, name, segRest(e + 1), isPlainVar(name));
      continue;
    }
    if (!isPs) continue;
    // PowerShell：& (運算式)、& $var
    if (ps && text[i] === '(') {
      const e = closeParen(text, i);
      if (e < 0) continue;
      push(s0, text.slice(i, e + 1), segRest(e + 1), false);
      continue;
    }
    if (ps && text[i] === '$') {
      const vm = /^\$[\w:.{}]+/.exec(text.slice(i));
      if (!vm) continue;
      // `… | % { & $_ add . }`：$_ 的值是管線左側餵進來的；左側是字面或運算式（不是純變數）且提到 git 或 argv 含危險動詞 → 判不出
      if (/^\$(?:_|PSItem)$/i.test(vm[0])) {
        const pm = /([^|;\n]*)\|\s*(?:%|ForEach-Object|foreach)\s*\{\s*$/i.exec(text.slice(0, s0));
        const src = pm ? pm[1].trim() : '';
        if (src && !isPlainVar(src)) {
          const sg = looseGit(src);
          const sdv = sg ? null : dangerVerbInText(segRest(i + vm[0].length));
          if ((sg || sdv) && !seen.has(s0)) { seen.add(s0); out.push(mkCall({ source: 'regex', at: s0, unsure: '管線餵進 ' + vm[0] + ' 的值執行期才知道（來源：' + src.slice(0, 60) + (sg ? '，提到 git' : '；引數含 git 危險動詞字樣 ' + sdv) + '）——請改成字面指令名' + suffix, name: vm[0], dirUnsure: true, repoUnsure: true })); }
        }
        continue;
      }
      push(s0, vm[0], segRest(i + vm[0].length), true);
      continue;
    }
    // Invoke-Expression (運算式)／iex (運算式)
    const im = /^(?:Invoke-Expression|iex)\s+(?=\()/i.exec(text.slice(i));
    if (im) {
      const o = i + im[0].length;
      const e = closeParen(text, o);
      if (e < 0) continue;
      const expr = text.slice(o, e + 1);
      const lg = looseGit(expr);
      const dv = lg ? null : dangerVerbInText(expr);
      if (lg || dv) out.push(mkCall({ source: 'regex', at: s0, unsure: 'invoke-expression 的字串執行期才組出來（' + (lg ? '裡面提到 git' : '裡面有 git 危險動詞 ' + dv) + '）' + suffix, dirUnsure: true, repoUnsure: true }));
      continue;
    }
  }
  if (isPs) {
    // 運算式 | iex：管線左側整段（到上一個分隔符）是運算式——含 +、-f、::（`('g'+'it push') | iex`、不加括號的 `'gi'+'t add .' | iex`）；
    // 字面字串 `'git add .' | iex` 由 PIPE_TO_SHELL 解除遮罩後照一般呼叫解析，不走這裡
    const pipeRe = /\|\s*(?:iex|Invoke-Expression)(?=[\s;&|)]|$)/gi;
    let pm;
    while ((pm = pipeRe.exec(text)) !== null) {
      if (mask && mask[pm.index]) continue;
      let st = pm.index;
      while (st > 0 && !(/[;\n]/.test(text[st - 1]) && !(mask && mask[st - 1])) && !(text[st - 1] === '&' && text[st - 2] === '&')) st--;
      const left = text.slice(st, pm.index).trim();
      if (!left || !/\+|-f\b|::/.test(left)) continue;
      const lg = looseGit(left);
      const dv = lg ? null : dangerVerbInText(left);
      if ((lg || dv) && !seen.has(st)) { seen.add(st); out.push(mkCall({ source: 'regex', at: st, unsure: 'iex 由管線收到的運算式執行期才組出來（' + (lg ? '裡面提到 git' : '裡面有 git 危險動詞 ' + dv) + '：' + left.slice(0, 60) + '）' + suffix, dirUnsure: true, repoUnsure: true })); }
    }
  }
  return out;
}

// 三支閘放行但 notes 非空時的共用輸出：stderr 一句＋additionalContext 一句（fail-open loud 慣例），回傳 true 表示有寫；呼叫端自己 exit 0
function noteOutput(gateLabel, notes, hookFile) {
  if (!notes || !notes.length) return false;
  const msg = '[' + gateLabel + '] ' + notes.join('；');
  try { process.stderr.write(msg + '\n'); } catch (e) { /* 寫不了就只剩 additionalContext */ }
  try {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: msg + '。要讓本閘檢查，請把要執行的指令用字面寫法直接寫出；hook：' + hookFile } }));
  } catch (e) { /* 同上 */ }
  return true;
}

// ── 對外介面 ────────────────────────────────────────────────────────────────
// analyzeGitCalls(command, tool, cwd) → { mode: 'ast'|'regex', analysis, calls: [Call], text, notes: [字串] }
function analyzeGitCalls(command, tool, cwd) {
  const isPs = tool === 'PowerShell';
  const cmd = String(command == null ? '' : command);
  const base = cwd || process.cwd();
  let a = null, parseFailed = false;
  if (parserAvailable(tool)) {
    const pre = isPs ? cmd : joinWordContinuations(cmd);
    try { a = shellModel().analyze(pre, tool, base, base); } catch (e) { a = null; }
    if (a && a.hasError) a = null;   // 殘缺的樹不拿來判，整條退回正則路徑
    parseFailed = !a;                 // 解析器在、卻解不出：正則路徑的 unsure 要標出來，不靜默
  }
  let result;
  if (!a) result = regexGitCalls(cmd, tool, base, { parseFailed });
  else {
    const calls = astCalls(a, tool, base, 0, cmd);
    if (isPs && PS_HIDDEN_EXEC.test(cmd)) { for (const c of textCalls(cmd, 'text', null)) calls.push(c); for (const c of hiddenExecExprCalls(cmd)) calls.push(c); }
    result = { mode: 'ast', analysis: a, calls, text: cmd };
  }
  // 就地可解的編碼內容（-EncodedCommand、echo <base64> | base64 -d | sh）：解碼後當另一條指令再分析一次、呼叫併入（在哪個目錄執行判不出）。
  // 語法樹路徑的 shell-model 自己會解 -EncodedCommand（shellInner），那種不重複；base64 管線兩條路徑都靠這裡
  // 解不出的編碼內容：不擋，呼叫端拿 notes 走 additionalContext＋stderr 提醒
  result.notes = undecodable(cmd);
  if (depthOf(cmd) < 3) {
    for (const v of decodedViews(cmd)) {
      if (v.kind === '-EncodedCommand' && result.mode === 'ast') continue;
      const sub = withDepth(cmd, () => analyzeGitCalls(v.text, v.tool, base));
      for (const sc of sub.calls) { sc.dirUnsure = true; if (!sc.gitDir && !sc.workTree) { sc.dir = null; sc.repoDir = null; sc.repoUnsure = true; sc.cwdFallbackOk = false; } sc.hints.push('decoded:' + v.kind); result.calls.push(sc); }
    }
  }
  return result;
}
// 解碼內容再分析的遞迴深度（解碼結果裡又包一層編碼）：用呼叫鏈計數，超過 3 層不再展開
let decodeDepth = 0;
function depthOf() { return decodeDepth; }
function withDepth(_cmd, fn) { decodeDepth++; try { return fn(); } finally { decodeDepth--; } }

module.exports = {
  analyzeGitCalls, regexGitCalls, parserAvailable,
  isDisplayOnly, mentionsGit, looseGit, expandAnsiC, decodeAnsiC, decodedViews, undecodable, noteOutput, dangerVerbInText, normalize, stripHeredocs, dataMask, unmaskPipedToShell, lastCdBefore,
  inTmp, tmpRoots, expandTmpVars, fromPosix, stripArgQuotes, isGitName, splitWords, joinArgs,
  KNOWN_GIT_CMDS, DISPLAY, SHELL_OPS, ARG,
};
