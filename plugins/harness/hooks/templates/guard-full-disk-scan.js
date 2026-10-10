#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)：全碟掃描守門——對磁碟根、家目錄根、所有使用者目錄的遞迴搜尋一律擋下。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 形狀目錄 A 類：任何專案都適用，不需要盤點證據；init 只在填空區照專案情況調整（見下方填空區註解）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-full-disk-scan.js\"", "timeout": 15, "statusMessage": "檢查有沒有對整顆磁碟或家目錄做遞迴搜尋" }] }]
//
// 病灶：「檔案／內容搜尋限定在專案目錄內」原本只是文字約定。對磁碟根或家目錄根的遞迴搜尋耗時以小時計，
//   而且程序不隨 agent 結束而終止，會變成殭屍程序長時間燒 CPU——來源專案實際發生過 `find /` 跑 7 小時。
//   文字規則擋不住「順手 find / 找一下」，本 hook 是程式強制。
//
// 判準：指令在「執行位置」呼叫遞迴搜尋／走訪工具，且搜尋起點是
//   · 磁碟根：/、C:、C:\、C:/、/c、/c/、/mnt/c、/cygdrive/c、D:\ …（含 C:\*.log 這種根目錄萬用字元）
//   · 家目錄根：~、$HOME、${HOME}、$env:USERPROFILE、%USERPROFILE%，以及 os.homedir() 的字面路徑
//   · 所有使用者目錄：家目錄的上一層（Windows 的 C:\Users、Linux 的 /home、macOS 的 /Users）
//   · 填空區 EXTRA_PROTECTED 另列的目錄；SCOPE='project' 時另加「專案目錄外」
// 相對路徑依同一條指令裡的 cd／Set-Location 追蹤工作目錄後再判（cd / && find . 也擋）；起點是變數、
// 工作目錄推不出來時判不出，放行。
// 涵蓋工具：find、grep/egrep/fgrep（-r／-R／--recursive／-d recurse）、rg、ag、ack、fd、ls -R、du、tree、
//   Get-ChildItem／gci／ls／dir（PowerShell，-Recurse 或 -Depth；-Recurse:$false／-Recurse:0 是明確關掉，不算）、cmd 的 dir /s、where /r、findstr /s、forfiles /s；
//   python／node／PowerShell 程式碼裡的 os.walk、Path(...).rglob、Path.home().rglob、
//   [IO.Directory]::GetFiles/EnumerateFiles(…,'AllDirectories')、readdirSync(…, { recursive: true }) 以根目錄字面值為起點者。
// 深度明確限制在 SHALLOW 層以內（find -maxdepth、rg/fd --max-depth、Get-ChildItem -Depth、tree -L）不算全碟掃描，放行。
//
// 不誤擋：引號內字串只是資料（echo "find /"、grep "find /" 檔、Write-Host "…"）、# 註解、
//   寫進檔案的 heredoc 主體、樣式本身是斜線（grep -r / src/、rg / src）。
//
// 跨平台（同一份檔在 Windows 與 Linux／macOS 都能跑）：
//   · 磁碟代號形式（C:\、C:/、/c、/mnt/c、/cygdrive/c）在任何平台都當磁碟根——Linux 上的 /mnt/c 是 WSL 掛的整顆 C 槽；
//     代價是 Linux 上真有一個叫 /c 的單字母目錄時也會被當成磁碟根（多擋方向，極少見）。
//   · 路徑比對在 Windows 不分大小寫、其他平台分大小寫；家目錄取 os.homedir()，不寫死任何使用者名稱。
//
// 兩層判定（任一層判定命中就擋）：
//   · 斷詞層（一定會跑）：本檔內建的輕量 shell 斷詞——認單／雙引號、反斜線與 PowerShell 反引號、# 與 <# #> 註解、
//     重導向、命令替換 $(…)／`…`／<(…)、heredoc（寫進檔案的主體是資料、餵給殼的主體是指令）、PowerShell here-string；
//     包裝層 bash -c／sh -c／powershell -Command／-EncodedCommand／cmd /c／eval／Invoke-Expression、xargs、find -exec 都遞迴判讀。
//     不依賴任何套件，所以 hook 單獨複製過去就能用。
//   · 語法樹層（選用）：同目錄有 shell-model.js 而且 tree-sitter 解析器裝好時（見兩支規則引擎的說明；
//     設 HARNESS_SHELL_PARSER=off 可關），把語法樹拆出的每個「會執行的程式」再用同一套工具判準判一次，
//     工作目錄取 shell-model 的 dirAt（判不準時只判絕對路徑）。只能多擋、不會放行斷詞層擋下的指令；
//     模組不在、解析器沒裝、語法樹有錯誤節點時這層直接略過，斷詞層照常運作。
//
// **沒有放行旁路**：不提供豁免註解。真的需要掃專案外的目錄時，先問使用者那個東西可能在哪個目錄，
// 再把路徑限定到那裡；要長期放行某個目錄，改填空區（EXEMPT_ROOTS／ALLOWED_OUTSIDE）。
//
// fail-open：stdin 不是 JSON 時安靜放行；判讀過程丟出例外時放行，但用 additionalContext 告訴模型
// 「這次檢查沒有生效」，不靜默——hook 自己壞掉不能擋死使用者，也不能讓人以為有檢查過。
//
// 已知極限（極端情境，刻意不處理；回歸案例見 cases/guard-full-disk-scan.json）：
//   · 執行期才組出的路徑或指令：P=/; find $P、eval "$CMD"、$(echo /)、Invoke-Expression $s。
//   · 別名與函式：alias f=find; f /、function g { gci C:\ -r }; g。
//   · 腳本檔內容：bash scan.sh、python walk.py 不讀檔判斷（只判指令字面與 -c／heredoc 程式碼）。
//   · 其他語言或非常規 API：perl -e、ruby -e、Java、glob.glob('C:/**', recursive=True)、os.scandir 自寫遞迴、
//     以變數或 os.path.expanduser 間接取得根路徑的 os.walk。
//   · 程式碼走訪偵測吃的是原始字串：python -c "…os.walk(\"/\")" 這種在雙引號裡用跳脫雙引號包路徑的寫法，
//     認不出根目錄字面值，漏擋。
//   · Start-Process find -ArgumentList '/ …'、遠端／容器（ssh、docker exec、wsl）。
//   · 子殼層裡的 cd（( cd / ) && find .）在斷詞層會被當成仍在生效（誤擋方向）。
//   · 磁碟機相對路徑（C:foo）判不出，放行。
'use strict';

const path = require('path');
const os = require('os');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 深度明確限制在這個層數以內（find -maxdepth N、rg --max-depth N、Get-ChildItem -Depth N、tree -L N）不算全碟掃描。
const SHALLOW = 2;
// 判定範圍：
//   'roots'   ＝只擋以磁碟根／家目錄根／所有使用者目錄（與 EXTRA_PROTECTED）為起點的遞迴搜尋（預設；只擋災難級的情形）。
//   'project' ＝另外擋「起點在專案目錄外」的遞迴搜尋（ALLOWED_OUTSIDE 列的目錄除外）——照字面執行
//               「搜尋一律限定在專案目錄內」；誤擋會比較多（例：find /tmp），開之前先把常用的外部目錄列進 ALLOWED_OUTSIDE。
const SCOPE = 'roots';
// SCOPE='project' 時，專案目錄以外仍允許遞迴搜尋的目錄（含其底下）。例：[path.join(os.homedir(), 'shared-data')]
const ALLOWED_OUTSIDE = [];
// 另外要保護的目錄（只擋「以它本身為起點」的遞迴搜尋，與磁碟根同等；它底下的子目錄照常放行）。
// 例：掛載的大型網路磁碟 '/mnt/nas'、'Z:\\'。
const EXTRA_PROTECTED = [];
// 不保護的磁碟根或目錄（以它為起點的遞迴搜尋放行）。例：專門放小型測試資料的磁碟 'T:\\'。
const EXEMPT_ROOTS = [];
// 起點恰好是專案根時放行（專案本身放在磁碟根，例如 D:\ 就是 repo 根）。
// 專案根是家目錄或所有使用者目錄時不適用——那代表在家目錄開 session，掃「專案」就是掃整個家目錄，照擋。
const ALLOW_PROJECT_ROOT = true;
// 擋下訊息引用的規則出處（init 填成目標專案實際寫這條規則的檔與節名）。
const RULE_REF = '專案 CLAUDE.md 的搜尋範圍規則';
// ────────────────────────────────────────────────────────────────────────────

const WIN = process.platform === 'win32';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_DEPTH = 4;           // 包裝層遞迴上限
const LABEL = '[全碟掃描守門]';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

// ── 路徑：轉成絕對路徑與比對用的鍵（跨平台）──────────────────────────────────
// 磁碟代號形式一律用 win32 規則解析；其餘依本機平台。
const isDriveForm = (p) => /^[A-Za-z]:/.test(String(p || ''));
// p 轉絕對路徑；相對路徑需要 dir（目前推算的工作目錄），推不出來回 null
function toAbs(raw, dir) {
  let p = String(raw);
  p = p.replace(/^\/(?:mnt|cygdrive)\/([a-zA-Z])(?=\/|$)/, '/$1');
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (m) p = m[1] + ':' + (m[2] || '/');
  if (/^[A-Za-z]:$/.test(p)) p += '\\';
  if (/^[A-Za-z]:[\\/]/.test(p)) return path.win32.resolve(p);
  if (isDriveForm(p)) return null;                                   // C:foo：磁碟機相對路徑，判不出
  const winStyle = WIN || isDriveForm(dir);
  if (/^[\\/]/.test(p)) return winStyle ? path.win32.resolve(dir || PROJECT_ROOT, p) : path.posix.resolve(p);
  if (!dir) return null;
  return winStyle ? path.win32.resolve(dir, p) : path.posix.resolve(dir, p);
}
// 比對用的鍵：Windows 形式轉反斜線、去尾端分隔、小寫（磁碟根成為 "c:"）；POSIX 去尾端斜線（根仍是 "/"）
function keyOf(abs) {
  const s = String(abs);
  if (WIN || isDriveForm(s)) return s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return s.replace(/\/+$/, '') || '/';
}
const isRootKey = (k) => /^[a-z]:$/.test(k) || k === '/' || k === '';
function isUnder(k, base) {
  if (k === base) return true;
  if (base === '/') return k.startsWith('/');
  const sep = (WIN || /^[a-z]:/.test(base)) ? '\\' : '/';
  return k.startsWith(base + sep);
}
const keyOfPath = (p) => { const a = toAbs(p, PROJECT_ROOT); return a ? keyOf(a) : null; };

const HOME = os.homedir();
const HOME_KEY = keyOfPath(HOME);
const USERS_KEY = keyOfPath((WIN || isDriveForm(HOME) ? path.win32 : path.posix).dirname(HOME));
const PROJECT_KEY = keyOf(PROJECT_ROOT);
const EXTRA_KEYS = new Set(EXTRA_PROTECTED.map(keyOfPath).filter(Boolean));
const EXEMPT_KEYS = new Set(EXEMPT_ROOTS.map(keyOfPath).filter(Boolean));
const OUTSIDE_KEYS = ALLOWED_OUTSIDE.map(keyOfPath).filter(Boolean);

const exeName = (v) => String(v).replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
const HOME_VAR = /^(?:\$HOME|\$\{HOME\}|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|~)/i;

/**
 * 搜尋起點分類：回傳描述字串（磁碟根／家目錄根／所有使用者目錄／受保護目錄／專案目錄外）；不是或判不出回 null。
 * dir＝目前推算的工作目錄（null＝推不出來，此時相對路徑一律判不出）。
 */
function classify(raw, dir) {
  let p = String(raw).trim();
  if (!p) return null;
  if (HOME_VAR.test(p)) p = HOME + p.replace(HOME_VAR, '');
  if (/[$%`]/.test(p)) return null;                         // 其他變數：執行期才知道，判不出
  // 最後一段含萬用字元（C:\*.log、/*、*）→ 起點是它的上一層
  if (/[*?]/.test(p)) {
    const cut = p.search(/[^\\/]*[*?]/);
    p = p.slice(0, cut) || '.';
  }
  const abs = toAbs(p, dir);
  if (!abs) return null;
  const k = keyOf(abs);
  if (EXEMPT_KEYS.has(k)) return null;
  if (ALLOW_PROJECT_ROOT && k === PROJECT_KEY && k !== HOME_KEY && k !== USERS_KEY) return null;
  if (isRootKey(k)) return '磁碟根';
  if (k === HOME_KEY) return '家目錄根';
  if (k === USERS_KEY) return '所有使用者目錄';
  if (EXTRA_KEYS.has(k)) return '受保護目錄';
  if (SCOPE === 'project' && !isUnder(k, PROJECT_KEY) && !OUTSIDE_KEYS.some((b) => isUnder(k, b))) return '專案目錄外';
  return null;
}

// cd／Set-Location 的目標 → 新的工作目錄（推不出來回 null）
function cdTarget(t, dir) {
  let p = String(t);
  if (HOME_VAR.test(p)) p = HOME + p.replace(HOME_VAR, '');
  if (/[$%`]/.test(p) || p === '-') return null;
  return toAbs(p, dir);
}

// 依序取出選項與位置參數。valueOpts：帶值選項（值為下一個字，除非寫成 --x=v）；
// clusterValue：短選項叢集裡「其後全部是值」的字母（grep -m5、rg -tpy）
function parseArgs(words, valueOpts, clusterValue) {
  const opts = [];
  const pos = [];
  for (let k = 0; k < words.length; k++) {
    const v = words[k].v;
    if (v === '--') { for (k++; k < words.length; k++) pos.push(words[k].v); break; }
    if (/^--[^=]+=/.test(v)) { const e = v.indexOf('='); opts.push([v.slice(0, e), v.slice(e + 1)]); continue; }
    if (/^--./.test(v)) { if (valueOpts.has(v)) { opts.push([v, (words[k + 1] || {}).v]); k++; } else opts.push([v, null]); continue; }
    if (/^-[^-]/.test(v) && !words[k].q) {
      if (valueOpts.has(v)) { opts.push([v, (words[k + 1] || {}).v]); k++; continue; }
      // 叢集：-rn、-inr、-m5、-rne pattern
      for (let c = 1; c < v.length; c++) {
        const ch = v[c];
        if (clusterValue && clusterValue.includes(ch)) {
          const val = v.slice(c + 1);
          if (val) opts.push(['-' + ch, val]);
          else { opts.push(['-' + ch, (words[k + 1] || {}).v]); k++; }
          break;
        }
        opts.push(['-' + ch, null]);
      }
      continue;
    }
    pos.push(v);
  }
  return { opts, pos };
}
const hasOpt = (opts, re) => opts.some(([o]) => re.test(o));
const optVal = (opts, re) => { const f = opts.filter(([o]) => re.test(o)); return f.length ? f[f.length - 1][1] : undefined; };
const shallow = (v) => v !== undefined && v !== null && /^\d+$/.test(String(v)) && Number(v) <= SHALLOW;

// 檢查一串起點，回傳第一個命中的描述
function firstHit(tool, starts, dir) {
  for (const s of starts) {
    if (s === undefined || s === null) continue;
    const kind = classify(s, dir);
    if (kind) return { tool, path: s, kind };
  }
  return null;
}

const GREP_VALUE = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count',
  '--after-context', '--before-context', '--context', '--directories', '--devices', '--include', '--exclude',
  '--exclude-dir', '--exclude-from', '--label', '--binary-files', '--group-separator']);
const RG_VALUE = new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j', '-M', '-d', '-E', '-r',
  '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--type-add', '--type-clear', '--max-count',
  '--after-context', '--before-context', '--context', '--threads', '--max-columns', '--max-depth', '--maxdepth',
  '--encoding', '--replace', '--pre', '--pre-glob', '--sort', '--sortr', '--max-filesize', '--path-separator',
  '--context-separator', '--field-match-separator', '--field-context-separator', '--colors', '--color',
  '--dfa-size-limit', '--regex-size-limit', '--engine', '--ignore-file']);
const AG_VALUE = new Set(['-G', '-A', '-B', '-C', '-m', '-g', '--file-search-regex', '--ignore', '--ignore-dir',
  '--depth', '--after', '--before', '--context', '--max-count', '--pager', '--type', '--match']);
const FD_VALUE = new Set(['-e', '-t', '-E', '-d', '-c', '-j', '-S', '--extension', '--type', '--exclude', '--max-depth',
  '--min-depth', '--exact-depth', '--color', '--threads', '--size', '--changed-within', '--changed-before',
  '--owner', '--base-directory', '--path-separator', '--search-path', '--max-results', '--ignore-file']);
const GCI_VALUE = /^-(?:p(?:a(?:t(?:h)?)?)?|literalpath|lp|pspath|f(?:i(?:l(?:t(?:e(?:r)?)?)?)?)?|i(?:n(?:c(?:l(?:u(?:d(?:e)?)?)?)?)?)?|ex(?:c(?:l(?:u(?:d(?:e)?)?)?)?)?|de(?:p(?:t(?:h)?)?)?|at(?:t(?:r(?:i(?:b(?:u(?:t(?:e(?:s)?)?)?)?)?)?)?)?)$/i;
// PowerShell 通用參數裡帶值的（-ErrorAction SilentlyContinue 的值不可當成路徑，否則後面的 C:\ 會被看漏）
const PS_COMMON_VALUE = /^-(?:erroraction|ea|warningaction|wa|informationaction|infa|errorvariable|ev|warningvariable|wv|informationvariable|iv|outvariable|ov|outbuffer|ob|pipelinevariable|pv)$/i;
// cmd 系工具的旗標一律以「/字母」開頭（/s、/b/s、/f、/r）；不可拿 classify 判——/s 會被當成 msys 的 S 槽根目錄
const CMD_FLAG = /^\/[A-Za-z?]/;

// 單一簡單指令（words 已剝掉前綴）；回傳命中描述或 null
function judgeCommand(words, dir, mode, depth) {
  const n = exeName(words[0].v);
  const rest = words.slice(1);

  // ── 包裝層：遞迴 ──
  if (/^(?:bash|sh|zsh|dash|ksh|ash)$/.test(n)) {
    for (let j = 0; j < rest.length && /^-/.test(rest[j].v); j++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(rest[j].v)) return rest[j + 1] ? scanText(rest[j + 1].v, 'bash', dir, depth + 1) : null;
    }
    return null;
  }
  if (/^(?:powershell|pwsh)$/.test(n)) {
    for (let j = 0; j < rest.length; j++) {
      const lo = rest[j].v.replace(/^\//, '-').toLowerCase();
      if (/^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/.test(lo)) return scanText(rest.slice(j + 1).map((w) => w.v).join(' '), 'ps', dir, depth + 1);
      if (/^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/.test(lo)) {
        try { return rest[j + 1] ? scanText(Buffer.from(rest[j + 1].v, 'base64').toString('utf16le'), 'ps', dir, depth + 1) : null; } catch (e) { return null; }
      }
      if (/^-f(?:i(?:l(?:e)?)?)?$/.test(lo)) return null;
      if (!/^-/.test(lo)) return scanText(rest.slice(j).map((w) => w.v).join(' '), 'ps', dir, depth + 1);
      if (/^-(?:ex|ep|executionpolicy|w|windowstyle|wd|workingdirectory|configurationname|of|outputformat|if|inputformat|v|version)$/.test(lo)) j++;
    }
    return null;
  }
  if (n === 'cmd') {
    const k = rest.findIndex((x) => /^\/\/?[ck]$/i.test(x.v));
    return k >= 0 && k + 1 < rest.length ? scanText(rest.slice(k + 1).map((w) => w.v).join(' '), 'cmd', dir, depth + 1) : null;
  }
  if (n === 'eval') return rest.length ? scanText(rest.map((w) => w.v).join(' '), 'bash', dir, depth + 1) : null;
  if (n === 'invoke-expression' || n === 'iex') return rest.length ? scanText(rest.map((w) => w.v).join(' '), 'ps', dir, depth + 1) : null;

  // ── 搜尋／走訪工具 ──
  if (n === 'find' && mode !== 'cmd') {
    // find [-H|-L|-P|-D x|-Olevel] [起點…] [運算式]；起點＝運算式（-xxx、(、!）之前的字
    let i = 0;
    while (i < rest.length && /^-(?:[HLP]|O\d*|D)$/.test(rest[i].v)) i += rest[i].v === '-D' ? 2 : 1;
    const starts = [];
    for (; i < rest.length && !/^[-(!]/.test(rest[i].v); i++) starts.push(rest[i].v);
    const md = rest.findIndex((w) => w.v === '-maxdepth');
    if (md >= 0 && shallow((rest[md + 1] || {}).v)) return null;
    // find -exec 執行的指令也要看（find . -exec grep -r x / \;）
    for (let k = 0; k < rest.length; k++) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(rest[k].v)) continue;
      let e = k + 1;
      while (e < rest.length && rest[e].v !== ';' && rest[e].v !== '+') e++;
      const inner = rest.slice(k + 1, e);
      if (inner.length) { const h = judgeWords(inner, dir, mode, depth); if (h) return h; }
      k = e;
    }
    return firstHit('find', starts.length ? starts : ['.'], dir);
  }
  if (/^(?:grep|egrep|fgrep)$/.test(n)) {
    const { opts, pos } = parseArgs(rest, GREP_VALUE, 'efmABCdD');
    const recursive = hasOpt(opts, /^-[rR]$|^--(?:recursive|dereference-recursive)$/) ||
      opts.some(([o, v]) => /^(?:-d|--directories)$/.test(o) && v === 'recurse');
    if (!recursive) return null;
    const paths = hasOpt(opts, /^(?:-e|-f|--regexp|--file)$/) ? pos : pos.slice(1);
    return firstHit('grep -r', paths.length ? paths : ['.'], dir);
  }
  if (n === 'rg') {
    const { opts, pos } = parseArgs(rest, RG_VALUE, 'efgtTmABCjMdEr');
    if (shallow(optVal(opts, /^(?:-d|--max-depth|--maxdepth)$/))) return null;
    if (hasOpt(opts, /^--(?:type-list|version|help)$/)) return null;
    const noPattern = hasOpt(opts, /^(?:-e|-f|--regexp|--file|--files)$/);
    const paths = noPattern ? pos : pos.slice(1);
    return firstHit('rg', paths.length ? paths : ['.'], dir);
  }
  if (n === 'ag' || n === 'ack' || n === 'ack-grep') {
    const { opts, pos } = parseArgs(rest, AG_VALUE, 'GABCmg');
    if (shallow(optVal(opts, /^--depth$/))) return null;
    const paths = hasOpt(opts, /^(?:-g|-f)$/) && n === 'ack' ? pos : pos.slice(1);
    return firstHit(n, paths.length ? paths : ['.'], dir);
  }
  if (n === 'fd' || n === 'fdfind') {
    const { opts, pos } = parseArgs(rest, FD_VALUE, 'etEdcjS');
    if (shallow(optVal(opts, /^(?:-d|--max-depth|--exact-depth)$/))) return null;
    const sp = opts.filter(([o]) => /^--(?:search-path|base-directory)$/.test(o)).map(([, v]) => v);
    const paths = sp.concat(pos.slice(1));
    return firstHit('fd', paths.length ? paths : ['.'], dir);
  }
  if (n === 'du' && mode !== 'cmd') {
    const { pos } = parseArgs(rest, new Set(['-d', '--max-depth', '-B', '--block-size', '-t', '--threshold', '--exclude', '-X', '--exclude-from', '--time-style']), 'dBtX');
    return firstHit('du', pos.length ? pos : ['.'], dir);
  }
  if (n === 'tree') {
    if (mode === 'ps' || mode === 'cmd' || rest.some((w) => /^\/[fFaA]$/.test(w.v))) {
      const paths = rest.filter((w) => !CMD_FLAG.test(w.v)).map((w) => w.v);
      return firstHit('tree', paths.length ? paths : ['.'], dir);
    }
    const { opts, pos } = parseArgs(rest, new Set(['-L', '-P', '-I', '-o', '--filelimit', '--charset']), 'LPIo');
    if (shallow(optVal(opts, /^-L$/))) return null;
    return firstHit('tree', pos.length ? pos : ['.'], dir);
  }
  // PowerShell 的 Get-ChildItem（及 ls／dir／gci 別名）
  if (n === 'get-childitem' || n === 'gci' || (mode === 'ps' && (n === 'ls' || n === 'dir'))) {
    if (n === 'dir' && rest.some((w) => /^\/[sS]$/.test(w.v) || /^\/[A-Za-z](?:\/[A-Za-z])+$/.test(w.v))) return cmdDir(rest, dir);
    let recurse = false;
    let depthVal;
    const paths = [];
    for (let k = 0; k < rest.length; k++) {
      const v = rest[k].v;
      if (/^-/.test(v) && !rest[k].q) {
        const lo = v.toLowerCase().replace(/:.*$/, '');
        if (/^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/.test(lo)) {
          // 開關參數可用冒號給值：-Recurse:$false／-Recurse:0 是明確關掉遞迴（-Recurse: $false 冒號後空一格時值在下一個字）
          let sw = null;
          if (/:/.test(v)) { sw = v.slice(v.indexOf(':') + 1); if (sw === '' && rest[k + 1]) sw = rest[++k].v; }
          recurse = !(sw !== null && /^(?:\$false|0)$/i.test(String(sw).trim()));
          continue;
        }
        if (GCI_VALUE.test(lo)) {
          const val = /:/.test(v) ? v.slice(v.indexOf(':') + 1) : (rest[++k] || {}).v;
          if (/^-de/.test(lo)) depthVal = val;
          else if (/^-(?:p|literalpath|lp|pspath)/.test(lo)) paths.push(...String(val || '').split(','));
          continue;
        }
        if (PS_COMMON_VALUE.test(lo) && !/:/.test(v)) k++;
        continue;
      }
      if (!paths.length) paths.push(...v.split(','));
    }
    if (depthVal !== undefined) { if (shallow(depthVal)) return null; recurse = true; }
    if (!recurse) return null;
    return firstHit('Get-ChildItem -Recurse', paths.length ? paths : ['.'], dir);
  }
  if (n === 'ls' && mode === 'bash') {
    const { opts, pos } = parseArgs(rest, new Set(['-I', '--ignore', '-w', '--width', '-T', '--tabsize', '--format', '--sort', '--time', '--time-style', '--color', '--block-size']), 'IwT');
    if (!hasOpt(opts, /^-R$|^--recursive$/)) return null;
    return firstHit('ls -R', pos.length ? pos : ['.'], dir);
  }
  if (n === 'dir') return cmdDir(rest, dir);
  if (n === 'where') {
    const k = rest.findIndex((w) => /^\/[rR]$/.test(w.v));
    return k >= 0 && rest[k + 1] ? firstHit('where /r', [rest[k + 1].v], dir) : null;
  }
  if (n === 'findstr') {
    if (!rest.some((w) => /^\/[sS]$/.test(w.v))) return null;
    const nonFlag = rest.filter((w) => !CMD_FLAG.test(w.v)).map((w) => w.v);
    const files = rest.some((w) => /^\/[cCgG]:/.test(w.v)) ? nonFlag : nonFlag.slice(1);
    return firstHit('findstr /s', files, dir);
  }
  if (n === 'forfiles') {
    if (!rest.some((w) => /^[/-][sS]$/.test(w.v))) return null;
    const k = rest.findIndex((w) => /^[/-][pP]$/.test(w.v));
    return firstHit('forfiles /s', k >= 0 && rest[k + 1] ? [rest[k + 1].v] : ['.'], dir);
  }
  return null;
}

// cmd 的 dir：/s（或 /b/s 這類合寫）才遞迴；起點＝非旗標參數
function cmdDir(rest, dir) {
  const flags = rest.filter((w) => CMD_FLAG.test(w.v));
  if (!flags.some((w) => /^\/(?:[A-Za-z?]\/)*[sS](?:\/|$)/.test(w.v))) return null;
  const paths = rest.filter((w) => !flags.includes(w)).map((w) => w.v);
  return firstHit('dir /s', paths.length ? paths : ['.'], dir);
}

// 剝掉指令前綴（X=1、if/then、env、timeout、nohup、sudo、xargs…）後判讀
function judgeWords(words, dir, mode, depth) {
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    const v = w.v;
    const n = exeName(v);
    if (w.lead && /^[A-Za-z_]\w*\+?=/.test(v)) continue;
    if (!w.q && /^(?:if|then|else|elif|do|while|until|!|time|nohup|exec|command|builtin|winpty|call|&)$/i.test(v)) continue;
    if (n === 'env') { while (i + 1 < words.length && (/^-/.test(words[i + 1].v) || /^[A-Za-z_]\w*=/.test(words[i + 1].v))) i++; continue; }
    if (n === 'timeout') { while (i + 1 < words.length && /^-/.test(words[i + 1].v)) i++; if (i + 1 < words.length && /^\d/.test(words[i + 1].v)) i++; continue; }
    if (n === 'sudo' || n === 'doas' || n === 'nice' || n === 'stdbuf' || n === 'ionice') {
      while (i + 1 < words.length && /^-/.test(words[i + 1].v)) i += /^-(?:u|g|n|c)$/.test(words[i + 1].v) ? 2 : 1;
      continue;
    }
    if (n === 'xargs') {
      while (i + 1 < words.length && /^-/.test(words[i + 1].v)) i += /^-(?:n|I|i|P|L|l|d|a|E|e|s)$/.test(words[i + 1].v) ? 2 : 1;
      continue;
    }
    break;
  }
  if (i >= words.length) return null;
  return judgeCommand(words.slice(i), dir, mode, depth);
}

// 程式碼字面裡的遞迴走訪（python／node／PowerShell .NET）
const ROOT_LIT = String.raw`(?:[A-Za-z]:(?:\\\\|\\|/)?|/|~|/[a-zA-Z]/?)`;
const CODE_WALK = [
  new RegExp(String.raw`os\s*\.\s*walk\s*\(\s*[rRbBuU]?(["'])` + ROOT_LIT + String.raw`\1`),
  new RegExp(String.raw`Path\s*\(\s*[rR]?(["'])` + ROOT_LIT + String.raw`\1\s*\)\s*\.\s*(?:rglob|walk)\b`),
  /Path\s*\.\s*home\s*\(\s*\)\s*\.\s*(?:rglob|walk)\b/,
  /os\s*\.\s*walk\s*\(\s*(?:os\s*\.\s*path\s*\.\s*expanduser\s*\(\s*["']~["']\s*\)|Path\s*\.\s*home\s*\(\s*\))/,
  new RegExp(String.raw`(?:Get|Enumerate)(?:Files|Directories|FileSystemEntries)\s*\(\s*(["'])` + ROOT_LIT + String.raw`\1[^)]*AllDirectories`, 'i'),
  new RegExp(String.raw`readdirSync\s*\(\s*(["'])` + ROOT_LIT + String.raw`\1\s*,\s*\{[^}]*recursive\s*:\s*true`),
];
function codeWalkHit(text) {
  for (const re of CODE_WALK) {
    const m = re.exec(text);
    if (m) return { tool: '程式碼遞迴走訪', path: m[0].slice(0, 80), kind: '磁碟根或家目錄根' };
  }
  return null;
}
// 指令裡有沒有在執行位置呼叫會跑程式碼的直譯器（只在這種情況下才看程式碼字面，避免 echo 提到 os.walk 被擋）
function runsInterpreter(cmds) {
  return cmds.some((c) => {
    const w = c.words.find((x) => !(x.lead && /^[A-Za-z_]\w*\+?=/.test(x.v)));
    return w && /^(?:python(?:\d+(?:\.\d+)*)?w?|py|node|deno|powershell|pwsh)$/.test(exeName(w.v));
  });
}

// ── 輕量 shell 斷詞（不依賴套件）────────────────────────────────────────────
// heredoc：寫進檔案的主體是資料（剝掉）；餵給 shell 的主體是指令（展開成指令行）；餵給 python 的主體剝掉（程式碼另看原文）
const HEREDOC = /^([^\n]*?)<<-?[ \t]*(["']?)([A-Za-z_][\w.-]*)\2([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\r?\n|$)/gm;
const AT_CMD = String.raw`(?:^|[|;&({]\s*|\b(?:exec|then|do)\s+)(?:\S*[\\/])?`;
const HD_SHELL = new RegExp(AT_CMD + String.raw`(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)(?:\.exe)?(?=[\s;|&)]|$)`, 'i');
function stripHeredocs(s) {
  return s.replace(HEREDOC, (m, pre, _q, _id, post, body) => {
    if (HD_SHELL.test(pre + ' ' + post)) return pre + post + '\n' + body + '\n';
    return pre + post;
  });
}
// 找配對的右括號（從 s[i] === '(' 之後開始），略過引號；找不到回 -1
function matchParen(s, i) {
  let depth = 1;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "'") { const k = s.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++;
      continue;
    }
    if (c === '\\') { j++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j; }
  }
  return -1;
}
// 回傳 { cmds: [{ words:[{v,q,lead}] }], subs: [命令替換的內文] }
function tokenize(s, mode) {
  const ps = mode === 'ps';
  const bs = mode === 'bash';   // 反斜線跳脫只在 bash；PowerShell／cmd 的反斜線是路徑分隔
  const tokens = [];   // {t:'w',v,q,lead} | {t:'op',v} | {t:'redir',v}
  const subs = [];
  let cur = null;      // 目前累積中的字 {v,q,lead}
  const flush = () => { if (cur) { tokens.push({ t: 'w', v: cur.v, q: cur.q, lead: cur.lead }); cur = null; } };
  // lead：字的第一個字元不在引號裡（判 X=1 賦值用；Y="a b" 是賦值，"Y=a" 不是）
  const add = (ch, quoted) => { if (!cur) cur = { v: '', q: false, lead: !quoted }; cur.v += ch; if (quoted) cur.q = true; };
  const op = (v) => { flush(); tokens.push({ t: 'op', v }); };
  const takeSub = (at) => {
    if (s.startsWith('$((', at)) {           // 算術展開，不是指令
      const e = matchParen(s, at + 2);
      return e < 0 ? -1 : (s[e + 1] === ')' ? e + 2 : e + 1);
    }
    const open = s[at] === '(' ? at : at + 1;
    const e = matchParen(s, open);
    if (e < 0) return -1;
    subs.push(s.slice(open + 1, e));
    return e + 1;
  };
  const takeBacktickSub = (at) => {
    const e = s.indexOf('`', at + 1);
    if (e < 0) return -1;
    subs.push(s.slice(at + 1, e));
    return e + 1;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    // 續行
    if (c === '\\' && bs && (n === '\n' || (n === '\r' && s[i + 2] === '\n'))) { i += n === '\n' ? 2 : 3; continue; }
    if (c === '`' && (n === '\n' || (n === '\r' && s[i + 2] === '\n'))) { i += n === '\n' ? 2 : 3; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') { op('\n'); i++; continue; }
    // 註解（只在字首）
    if (!cur && c === '<' && n === '#') { const e = s.indexOf('#>', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (!cur && c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) { add(s.slice(i + 1), true); i = s.length; continue; }
      add(s.slice(i + 1, e), true);
      if (!cur) cur = { v: '', q: true, lead: false };
      i = e + 1;
      continue;
    }
    if (c === '"') {
      if (!cur) cur = { v: '', q: true, lead: false };
      cur.q = true;
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        const d = s[j];
        if (d === '\\' && bs && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) { add(s[j + 1], true); j += 2; continue; }
        if (d === '`' && (ps || s[j + 1] === '"')) { if (j + 1 < s.length) add(s[j + 1], true); j += 2; continue; }
        if (d === '`') { const e = takeBacktickSub(j); if (e > 0) { add('$SUB', true); j = e; continue; } }
        if (d === '$' && s[j + 1] === '(') { const e = takeSub(j); if (e > 0) { add('$SUB', true); j = e; continue; } }
        add(d, true);
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '\\' && bs) {
      // 只把 shell 特殊字元當跳脫；其餘保留反斜線（Windows 路徑 C:\Python312\python.exe）
      if (n !== undefined && ' \t;&|()<>"\'`$#{}\\*?'.includes(n)) { add(n, true); i += 2; continue; }
      add(c); i++; continue;
    }
    if (c === '`') {
      if (ps) { if (n !== undefined) add(n, true); i += 2; continue; }
      const e = takeBacktickSub(i);
      if (e > 0) { add('$SUB'); i = e; continue; }
      add(c); i++; continue;
    }
    if (c === '$' && n === '(') { const e = takeSub(i); if (e > 0) { add('$SUB'); i = e; continue; } }
    if (c === '$' && n === '{') { const e = s.indexOf('}', i + 2); if (e > 0) { add(s.slice(i, e + 1)); i = e + 1; continue; } }
    if ((c === '<' || c === '>') && n === '(' && !ps) { const e = takeSub(i); if (e > 0) { add('$SUB'); i = e; continue; } }
    if (c === '>' || c === '<' || (c === '&' && n === '>')) {
      if (cur && /^\d+$/.test(cur.v) && !cur.q) cur = null;   // 2>&1 的 2
      if (cur && cur.v === '*' && ps) cur = null;              // PowerShell *>&1
      flush();
      let j = i;
      if (s[j] === '&') j++;
      const startCh = s[j];
      while (j < s.length && s[j] === startCh) j++;
      if (s[j] === '&' || s[j] === '|') j++;
      tokens.push({ t: 'redir', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      let v = c;
      if (n === c) v = c + c;
      else if (c === '|' && n === '&') v = '|&';
      op(v); i += v.length; continue;
    }
    if (c === '(' || c === ')') { op(c); i++; continue; }
    if (c === '{' && !cur && (ps || n === undefined || /\s/.test(n))) { op('{'); i++; continue; }
    if (c === '{' && cur && ps) { op('{'); i++; continue; }
    if (c === '}' && (ps || !cur)) { op('}'); i++; continue; }
    add(c);
    i++;
  }
  flush();
  // 切成簡單指令；重導向的目標字（> out.txt、< in.txt、<<< 字串）不算引數
  const cmds = [];
  let words = [];
  let pendingRedir = false;
  for (const t of tokens) {
    if (t.t === 'redir') { pendingRedir = true; continue; }
    if (t.t === 'w') {
      if (pendingRedir) { pendingRedir = false; continue; }
      words.push(t);
      continue;
    }
    pendingRedir = false;
    if (words.length) cmds.push({ words });
    words = [];
  }
  if (words.length) cmds.push({ words });
  return { cmds, subs };
}

// ── 斷詞層 ──────────────────────────────────────────────────────────────────
function scanText(text, mode, cwd, depth) {
  if (depth > MAX_DEPTH) return null;
  const raw = String(text);
  const body = stripHeredocs(raw);
  const noHere = body.replace(/@(["'])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g, ' ');   // PowerShell here-string 是資料
  const { cmds, subs } = tokenize(noHere, mode);
  if (mode === 'ps' || runsInterpreter(cmds)) {
    const h = codeWalkHit(mode === 'ps' ? noHere : raw);
    if (h) return h;
  }
  let dir = cwd;
  for (const sub of subs) { const h = scanText(sub, mode, dir, depth + 1); if (h) return h; }
  for (const cmd of cmds) {
    const w = cmd.words;
    if (!w.length) continue;
    // PowerShell 裸字串（"…" 單獨成段）是值，不是指令
    if (mode === 'ps' && w[0].q && w.length === 1) continue;
    const n0 = exeName(w[0].v);
    if (/^(?:cd|pushd|chdir|set-location|sl|push-location)$/.test(n0)) {
      const a = w.slice(1).filter((x) => !/^-/.test(x.v) && !/^\/d$/i.test(x.v));
      dir = a.length ? cdTarget(a[0].v, dir) : HOME;
      continue;
    }
    const h = judgeWords(w, dir, mode, depth);
    if (h) return h;
  }
  return null;
}

// ── 語法樹層（選用）：shell-model 拆出的每個會執行的程式，用同一套判準再判一次 ──────
// 語法樹節點後面緊接的那個字元（取不到回空字串）
function afterChar(node) {
  try {
    const p = node.parent;
    if (!p) return '';
    const off = node.endIndex - p.startIndex;
    return String(p.text).slice(off, off + 1);
  } catch (e) { return ''; }
}

function parserHit(command, tool, cwd) {
  let sm;
  try { sm = require('./shell-model.js'); } catch (e) { return null; }
  const t = tool === 'PowerShell' ? 'PowerShell' : 'Bash';
  if (typeof sm.available !== 'function' || !sm.available(t)) return null;
  const a = sm.analyze(command, t, cwd, PROJECT_ROOT);
  if (!a || a.hasError) return null;
  const mode = t === 'PowerShell' ? 'ps' : 'bash';
  for (let i = 0; i < a.execs.length; i++) {
    const e = a.execs[i];
    const words = [];
    const src = e.words || [];
    for (let j = 0; j < src.length; j++) {
      const w = src[j];
      // PowerShell 的 -Param:值 被語法樹拆成參數與值兩個字、冒號不見了；併回一個字，
      // 讓 -Recurse:$false／-Recurse:0 與斷詞層同樣判成明確關掉（-Recurse 0 是另一個位置參數，不併）
      if (mode === 'ps' && w.node && w.node.type === 'command_parameter' && src[j + 1] && afterChar(w.node) === ':') {
        words.push({ v: String(w.value) + ':' + String(src[j + 1].value), q: false, lead: false });
        j++;
        continue;
      }
      words.push({ v: String(w.value), q: !!w.quoted, lead: false });
    }
    if (!words.length) continue;
    let dir = null;
    try { const d = a.dirAt(i); if (d && !d.unsure && d.dir) dir = d.dir; } catch (err) { dir = null; }
    // 包裝層的內層已由語法樹拆成獨立的 exec；深度給到上限，不再走斷詞層的遞迴
    const h = judgeCommand(words, dir, mode, MAX_DEPTH);
    if (h) return h;
  }
  return null;
}

function failOpenNote(msg) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext:
    LABEL + ' ERROR: 判讀時發生例外——' + String(msg).slice(0, 200) +
    '（本次放行，但全碟掃描檢查沒有生效；搜尋路徑請自行限定在專案目錄內。hook 故障要修：.claude/hooks/guard-full-disk-scan.js，勿靜默忽略）' } }));
}

(async () => {
  let payload;
  try { payload = JSON.parse(await readStdin()); } catch (e) { process.exit(0); }
  const input = (payload && (payload.tool_input || payload.toolInput)) || {};
  const command = String(input.command || '');
  if (!command) process.exit(0);

  const tool = payload.tool_name === 'PowerShell' ? 'PowerShell' : 'Bash';
  const cwd = payload.cwd || process.cwd();
  let hit = null;
  try {
    hit = scanText(command, tool === 'PowerShell' ? 'ps' : 'bash', cwd, 0);
    if (!hit && process.env.HARNESS_SHELL_PARSER !== 'off') {
      // 語法樹層只能多擋；它自己出錯不影響斷詞層的結果
      try { hit = parserHit(command, tool, cwd); } catch (e) { hit = null; }
    }
  } catch (e) {
    failOpenNote((e && e.message) || e);
    process.exit(0);
  }
  if (!hit) process.exit(0);

  const fwd = PROJECT_ROOT.split('\\').join('/');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        LABEL + ' 偵測到對' + hit.kind + '的遞迴搜尋：' + hit.tool + '（起點：' + hit.path + '）。\n' +
        '理由：這類搜尋要走完整顆磁碟或整個家目錄，耗時以小時計；而且程序不隨 agent 結束而終止，會變成殭屍程序長時間燒 CPU' +
        '（實際發生過 `find /` 跑 7 小時）。規則見' + RULE_REF + '：檔案／內容搜尋一律限定在專案目錄內。\n' +
        '改法：把搜尋起點限定到專案目錄，例如\n' +
        '  find ' + fwd + ' -name …\n' +
        '  rg <樣式> ' + PROJECT_ROOT + '\n' +
        '  Get-ChildItem ' + PROJECT_ROOT + ' -Recurse -Filter …\n' +
        '要找的東西確定不在專案內時，先問使用者它可能在哪個目錄，再把路徑限定到那裡。\n' +
        '本守門沒有豁免註解；要長期放行某個目錄，請使用者改 .claude/hooks/guard-full-disk-scan.js 的填空區（EXEMPT_ROOTS／ALLOWED_OUTSIDE）。',
    },
  }));
  process.exit(0);
})().catch((e) => { try { failOpenNote((e && e.message) || e); } catch (err) { /* 連輸出都失敗就靜默放行 */ } process.exit(0); });
