#!/usr/bin/env node
/**
 * guard-pretest-env — qa-webwright 的 PreToolUse(Bash|PowerShell) hook：跑測試前的環境對齊閘＋副作用防護閘。
 *
 * 為什麼：
 *   · 環境對齊：借用別套環境的設定檔跑測試，身分／目錄／網址對不上時，症狀從來不會是「環境檔拿錯」，
 *     而是幾十行之後的斷言紅燈（查 0 筆像功能壞、定位 timeout 像畫面沒載入）——會繞十幾輪才追到真因。
 *   · 副作用防護：測試會觸發真實副作用（寄信、推播、扣款）時，收件人收斂之類的防線只存在於某支原始碼；
 *     防線遺失沒人發現，整套 e2e 跑下去就真的寄給真人。防線不在就不准跑。
 *
 * 啟動條件：專案 tests/e2e/qa-webwright.json 的 `pretest` 段有 alignment 或 side_effect_guards 規則；
 *   且指令**真的在執行測試**：指令位置上的 pytest（python -m pytest、py -m pytest…）、qa-flow.sh run，
 *   或 pretest.test_command_regex 追加的樣式（如 dotnet test）。
 *   排除：--collect-only／--co／--fixtures／--help／-h、heredoc 本文、註解、引號內與 echo/grep 等的參數。
 *
 * pretest.alignment 每條規則（env 必填；可加 when_regex 只在指令符合時檢查、message 補充說明）：
 *   {env, required:true}                    該變數必須有值
 *   {env, equals_file, regex}               值必須等於 <equals_file>（相對專案根）裡 regex 第 1 擷取群組的值
 *   {env, must_be_under}                    值（路徑）必須落在另一個環境變數的值或某路徑底下
 *   {env, matches}                          值必須符合 regex
 *   {env, port|port_env, equals_process_file, regex}
 *                                           值必須等於「port 上此刻在 LISTEN 的 process」實際讀的那份檔裡 regex 第 1 群組的值：
 *                                           從該 process 的工作目錄／執行檔目錄／命令列路徑往上（search_up 層，預設 6）找 equals_process_file。
 *                                           原始碼那份與服務實際讀的那份可能不同步、甚至不是同一套服務——比錯對象只會在很後面的斷言紅。
 *   {env, port|port_env, under_process_root} 值（路徑）必須落在該 process 的專案根底下：從上述候選目錄往上找到
 *                                           under_process_root 指定的標記檔（如 package.json）所在目錄即專案根。
 *   port_env＝另一個環境變數（值可以是網址，取最後一段 :port）；解不出就退回 port；查不到 process 或檔案＝該條略過。
 *   值的來源依序：同指令 inline 前綴／export／$env:／set → 同指令 source <檔> 讀該檔 export 行 → 目前 process env。
 *   比對對象讀不到（檔案不在、regex 沒命中）→ 該條略過（無從判斷就不擋）。
 *   must_be_under 的路徑值先展開 $VAR／${VAR}／$PWD／開頭 ~，Windows 上把 Git Bash 的 /c/… 轉成 C:\…；
 *   展開不了（變數沒值、含命令替換）→ 該條略過。
 *   拒絕訊息裡的值一律遮罩（只露長度與前後各 2 字元）：環境值與對照檔值可能是密碼／token。
 * 執行檔被單一字詞的引號包住（"pytest"、'python' -m pytest、"/x/qa-flow.sh" run）照樣認得；
 *   qa-flow.sh run 必須在指令位置（echo／grep 的參數只是提到）。
 * pretest.side_effect_guards 每條：{name, file, require_regex[], forbid_regex[], block_regex?, message}
 *   file（相對專案根）**讀不到＝擋**（防線不在就不准跑）；block_regex 有給就只檢查第一個命中的區塊
 *   （**找不到區塊＝擋**：防線所在的函式被改名／刪掉，不得退回全檔讓別處的同名樣式頂替）。
 * 擋下：permissionDecision=deny，一次列完所有未過項。沒有豁免註解——要跑就先對齊；驗證本 hook 直接餵 payload 即可。
 * FAIL-OPEN：hook 自身錯誤、規則型別壞、regex 編不起來 → 該條（或整支）放行。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const G = require('./lib/qa-gate-common.js');
const PP = require('./lib/port-process.js');

// 執行檔可帶路徑（.venv/bin/pytest、.venv/Scripts/python.exe -m pytest、/usr/bin/python3 -m pytest）
const EXE_PATH = '(?:[^\\s"\';&|()<>]*[\\\\/])?';
// python 的選項可帶分開寫的值（python -W ignore -m pytest、python -X utf8 -m pytest）
const PY_M = EXE_PATH + '(?:python[0-9.]*(?:\\.exe)?|py(?:\\s+-3[0-9.]*)?)\\s+(?:-[A-Za-z]+\\s+(?:(?!-)[^\\s;&|]+\\s+)?)*-m\\s+';
const PYTEST_RE = new RegExp(
  // coverage 包一層（coverage run -m pytest、python -m coverage run [--選項] -m pytest）；舊式執行檔名 py.test
  '(?:(?:' + PY_M + ')?' + EXE_PATH + 'coverage\\s+run\\s+(?:--?[A-Za-z][\\w-]*(?:=\\S*|\\s+(?!-)[^\\s;&|]+)?\\s+)*-m\\s+'
  + '|' + PY_M
  + '|(?:uv|poetry|pipenv|pdm|hatch)\\s+run\\s+)?' + EXE_PATH + 'py\\.?test(?:\\.exe)?(?=\\s|$|;|&|\\||\\))', 'gi');
const QAFLOW_RUN_RE = /qa-flow\.sh["']?\s+run\b/gi;
const EXCLUDE_RE = /(?:^|\s)(?:--collect-only|--co|--fixtures|--fixtures-per-test|--help|-h|--version|-V)(?=\s|$)/;

// 引號只包住一個字詞（"pytest"、'python'、"/x/qa-flow.sh"）時，引號不改變它是指令本體：
// 產生一份把這種引號換成空白、內容標回指令本體的副本，給執行檔辨識用（長度不變，索引可對回原字串）。
function dequoteWords(sh) {
  const code = sh.code.split('');
  const bare = sh.bare.split('');
  const kind = Uint8Array.from(sh.kind);
  for (let i = 0; i < code.length; i++) {
    const q = code[i];
    if ((q !== '"' && q !== "'") || kind[i] !== 0) continue;
    let j = i + 1;
    while (j < code.length && kind[j] === 1) j++;
    if (j >= code.length || code[j] !== q || j === i + 1) {
      i = j;
      continue;
    }
    const inner = sh.code.slice(i + 1, j);
    // 只處理「整個字詞就是這段引號」：前後都是空白／分隔符（X="…" 賦值值的引號不動）
    const before = i === 0 ? ' ' : sh.code[i - 1];
    const after = j + 1 >= code.length ? ' ' : sh.code[j + 1];
    // 內含空白的只收「路徑結尾是 python／py／pytest 執行檔」（"/Applications/QA Env/bin/python3"）：
    // 空白換成底線只為了比對，不影響其他判斷
    const exeWithSpace = /\s/.test(inner) && /[\\/](?:python[0-9.]*|py|pytest)(?:\.exe)?$/i.test(inner);
    if ((!/[\s$`]/.test(inner) || (exeWithSpace && !/[$`]/.test(inner)))
      && /[\s;&|(]/.test(before) && /[\s;&|)]/.test(after)) {
      code[i] = ' ';
      code[j] = ' ';
      bare[i] = ' ';
      bare[j] = ' ';
      for (let k = i + 1; k < j; k++) {
        kind[k] = 0;
        const ch = /\s/.test(sh.code[k]) ? '_' : sh.code[k];
        code[k] = ch;
        bare[k] = ch;
      }
    }
    i = j;
  }
  return Object.assign({}, sh, { code: code.join(''), bare: bare.join(''), kind });
}

function findTestRuns(shOrig, extras) {
  const sh = dequoteWords(shOrig);
  const runs = [];
  let m;
  PYTEST_RE.lastIndex = 0;
  while ((m = PYTEST_RE.exec(sh.code)) !== null) {
    const idx = m.index;
    const low = m[0].toLowerCase();
    const pi = idx + Math.max(low.lastIndexOf('pytest'), low.lastIndexOf('py.test'));
    if (sh.kind[idx] !== 0 || sh.kind[pi] !== 0) continue;
    if (!G.atCommandPosition(sh, idx)) continue;
    const end = G.segmentEnd(sh, pi);
    if (EXCLUDE_RE.test(sh.bare.slice(pi, end))) continue;
    runs.push({ idx, end, what: 'pytest' });
  }
  QAFLOW_RUN_RE.lastIndex = 0;
  while ((m = QAFLOW_RUN_RE.exec(sh.code)) !== null) {
    const ri = m.index + m[0].length - 3; // "run" 必須是指令本體
    if (sh.kind[ri] !== 0) continue;
    // qa-flow.sh 必須在指令位置（直接執行或 bash qa-flow.sh）；echo／grep 的參數只是提到
    if (!G.atCommandPosition(sh, G.wordStart(sh, m.index))) continue;
    runs.push({ idx: m.index, end: G.segmentEnd(sh, ri), what: 'qa-flow.sh run' });
  }
  for (const rx of extras) {
    rx.lastIndex = 0;
    while ((m = rx.exec(sh.bare)) !== null) {
      if (m[0] === '') {
        rx.lastIndex++;
        continue;
      }
      if (!G.atCommandPosition(sh, m.index)) continue;
      runs.push({ idx: m.index, end: G.segmentEnd(sh, m.index), what: m[0].trim() });
    }
  }
  return runs;
}

function samePathUnder(child, parent) {
  const norm = (p) => {
    let s = G.toPosix(path.resolve(p)).replace(/\/+$/, '');
    if (process.platform === 'win32' || process.platform === 'darwin') s = s.toLowerCase();
    return s;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + '/');
}

// alignment 規則的欄位型別與 regex 都要合法；任何一項壞＝整條規則視為不存在（fail-open）
function ruleOk(r) {
  if (!G.isObj(r) || typeof r.env !== 'string' || !r.env) return false;
  const str = ['equals_file', 'regex', 'must_be_under', 'matches', 'when_regex', 'message',
    'port_env', 'equals_process_file', 'under_process_root'];
  for (const k of str) if (r[k] !== undefined && typeof r[k] !== 'string') return false;
  if (r.required !== undefined && typeof r.required !== 'boolean') return false;
  for (const k of ['port', 'search_up']) {
    if (r[k] !== undefined && !(Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= 65535)) return false;
  }
  if (r.equals_process_file !== undefined && typeof r.regex !== 'string') return false;
  if (r.regex !== undefined && !G.re(r.regex, 'm')) return false;
  if (r.matches !== undefined && !G.re(r.matches)) return false;
  if (r.when_regex !== undefined && !G.re(r.when_regex)) return false;
  return true;
}

function checkAlignment(rules, sh, run, ctx) {
  const problems = [];
  const bases = [ctx.cwd, ctx.root, ctx.e2e];
  // 同指令前面 cd 過就以那裡為準（source 的相對路徑、$PWD、相對路徑值）；cd 到變數等解析不出時退回 session cwd
  const dirAt = (i) => {
    const d = G.cdChain(sh, i, ctx.cwd);
    return typeof d === 'string' ? d : null;
  };
  const runDir = dirAt(run.idx) || ctx.cwd;
  for (const r of rules) {
    if (!ruleOk(r)) continue; // 規則本身壞（型別錯、regex 編不起來）→ 整條 fail-open，連 required 也不判
    if (r.when_regex !== undefined) {
      const w = G.re(r.when_regex);
      if (!w || !w.test(sh.code)) continue;
    }
    const eo = { beforeIdx: run.idx, bases, dirAt, cwd: runDir };
    // 值本身引用別的變數（X="$Y"，可多層）：展開後再比；單引號是字面值不展開；
    // 展開不了（Y 沒值、命令替換）＝無從判斷 → 本條略過
    const got = G.resolvedEnv(sh, r.env, eo);
    if (got && got.value === null) continue;
    const val = got ? got.value : '';
    const src = got ? '（來源：' + got.from + '）' : '';
    // 訊息裡的值一律遮罩（環境值與對照檔值可能是密碼／token），只露長度與前後少量字元
    const shown = G.mask(val);
    const extra = typeof r.message === 'string' && r.message ? '\n     ' + r.message : '';
    if (r.required === true && !val) {
      problems.push('未設 ' + r.env + '——這支測試需要它（pretest.alignment required）。' + extra);
      continue;
    }
    if (typeof r.equals_process_file === 'string' || typeof r.under_process_root === 'string') {
      problems.push(...checkProcessRule(r, sh, eo, val, got, shown, src, extra, runDir));
    }
    if (typeof r.equals_file === 'string' && typeof r.regex === 'string') {
      const rx = G.re(r.regex, 'm');
      let expected = null;
      try {
        const body = fs.readFileSync(path.resolve(ctx.root, r.equals_file), 'utf8');
        const mm = rx ? rx.exec(body) : null;
        if (mm) expected = mm[1] !== undefined ? mm[1] : mm[0];
      } catch (_) {
        expected = null;
      }
      if (expected !== null) {
        if (!val) {
          problems.push('未設 ' + r.env + '，但 ' + r.equals_file + ' 有對照值（' + G.mask(expected)
            + '）——兩邊不同源時會「種資料在 A、查資料在 B」，症狀是查 0 筆，看起來像功能壞了。' + extra);
        } else if (val !== expected) {
          problems.push(r.env + '=' + shown + src + ' 與 ' + r.equals_file + ' 的對照值（' + G.mask(expected) + '）不一致。' + extra);
        }
      }
    }
    if (typeof r.must_be_under === 'string' && r.must_be_under && val) {
      let base = null;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.must_be_under)) {
        const b = G.resolvedEnv(sh, r.must_be_under, eo);
        base = b && b.value !== null ? G.valuePath(b.value, b.literal) : null;
      } else {
        base = path.resolve(ctx.root, r.must_be_under);
      }
      // 值已展開（$PWD／${VAR}，多層）；再把開頭 ~ 換成家目錄、Git Bash 的 /c/… 轉成原生路徑；家目錄不明＝無從判斷，不擋
      const v0 = G.valuePath(val, got && got.literal);
      if (base && v0 !== null) {
        const v = path.isAbsolute(v0) ? v0 : path.resolve(runDir, v0);
        if (!samePathUnder(v, path.isAbsolute(base) ? base : path.resolve(runDir, base))) {
          problems.push(r.env + '=' + shown + src + ' 不在 ' + r.must_be_under + '（' + G.mask(base) + '）底下——'
            + '拿別套環境的目錄／檔案跑測試，錯誤只會出現在很後面的斷言上。' + extra);
        }
      }
    }
    if (typeof r.matches === 'string' && val) {
      const rx = G.re(r.matches);
      if (rx && !rx.test(val)) problems.push(r.env + '=' + shown + src + ' 不符合 ' + r.matches + '。' + extra);
    }
  }
  return problems;
}

// port 從 port_env（值可為網址）解，解不出退回 port；都沒有回 null
function portOf(r, sh, eo) {
  if (typeof r.port_env === 'string' && r.port_env) {
    const pv = G.resolvedEnv(sh, r.port_env, eo);
    const s = pv && pv.value ? String(pv.value) : '';
    const m = /:(\d{1,5})(?:[/?#]|$)/.exec(s) || /^(\d{1,5})$/.exec(s);
    if (m) return m[1];
  }
  return Number.isInteger(r.port) ? String(r.port) : null;
}

function checkProcessRule(r, sh, eo, val, got, shown, src, extra, runDir) {
  const port = portOf(r, sh, eo);
  if (!port) return [];
  const proc = PP.lookup(port);
  if (!proc || !proc.dirs.length) return []; // 查不到 process（沒在跑／權限不足／沒有 lsof）→ 無從判斷
  const up = Number.isInteger(r.search_up) ? r.search_up : 6;
  const who = 'port ' + port + ' 上此刻在跑的 process（pid ' + proc.pid + '）';
  const out = [];
  if (typeof r.equals_process_file === 'string') {
    const file = PP.findUp(proc.dirs, r.equals_process_file, up);
    const rx = G.re(r.regex, 'm');
    let expected = null;
    if (file && rx) {
      try {
        const mm = rx.exec(fs.readFileSync(file, 'utf8'));
        if (mm) expected = mm[1] !== undefined ? mm[1] : mm[0];
      } catch (_) {
        expected = null;
      }
    }
    if (expected !== null) {
      if (!val) {
        out.push('未設 ' + r.env + '，但 ' + who + ' 讀的 ' + file + ' 有對照值（' + G.mask(expected) + '）——'
          + '兩邊不同源時會「種資料在 A、查資料在 B」，症狀是查 0 筆，看起來像功能壞了。' + extra);
      } else if (val !== expected) {
        out.push(r.env + '=' + shown + src + ' 與 ' + who + ' 實際讀的 ' + file + ' 的值（' + G.mask(expected) + '）不一致——'
          + '比對的是正在被測的那套服務，不是原始碼裡的某一份。' + extra);
      }
    }
  }
  if (typeof r.under_process_root === 'string' && val) {
    const marker = PP.findUp(proc.dirs, r.under_process_root, up);
    const v0 = G.valuePath(val, got && got.literal);
    if (marker && v0 !== null) {
      const root = path.dirname(marker);
      const v = path.isAbsolute(v0) ? v0 : path.resolve(runDir, v0);
      if (!samePathUnder(v, root)) {
        out.push(r.env + '=' + shown + src + ' 不在 ' + who + ' 的專案根（' + root + '）底下——'
          + '拿別套服務的目錄／檔案跑測試，錯誤只會出現在很後面的斷言上（例如拿別份譯文定位元素 → timeout）。' + extra);
      }
    }
  }
  return out;
}

function checkSideEffects(guards, ctx) {
  const problems = [];
  for (const g of guards) {
    if (!G.isObj(g) || typeof g.file !== 'string' || !g.file || g.enabled === false) continue;
    const name = g.name || g.file;
    // 規則欄位型別錯（regex 清單寫成字串、block_regex 不是字串）＝規則壞 → 整條 fail-open，不因檔不在而擋
    if ((g.require_regex !== undefined && !G.strList(g.require_regex))
      || (g.forbid_regex !== undefined && !G.strList(g.forbid_regex))
      || (g.block_regex !== undefined && typeof g.block_regex !== 'string')
      || (g.message !== undefined && typeof g.message !== 'string')
      || (g.name !== undefined && typeof g.name !== 'string')) continue;
    const req = G.strList(g.require_regex) ? g.require_regex : [];
    const forb = G.strList(g.forbid_regex) ? g.forbid_regex : [];
    const compiled = req.map((s) => G.re(s, 'm')).concat(forb.map((s) => G.re(s, 'm')));
    const br = typeof g.block_regex === 'string' && g.block_regex ? G.re(g.block_regex, 'm') : undefined;
    if (compiled.some((x) => x === null) || br === null) continue; // 規則本身壞 → 該條 fail-open（先驗規則、再讀檔）
    const abs = path.resolve(ctx.root, g.file);
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch (_) {
      problems.push('[' + name + '] 讀不到 ' + g.file + '——無法確認防線還在，先確認該檔存在再跑測試。'
        + (g.message ? '\n     ' + g.message : ''));
      continue;
    }
    let text = src;
    if (br) {
      const bm = br.exec(src);
      if (!bm) {
        // 找不到防線所在的區塊（函式被改名、刪掉、搬走）＝防線不在了：不得退回全檔讓別處的同名樣式頂替
        problems.push('[' + name + '] ' + g.file + ' 找不到防線所在的區塊（block_regex：' + g.block_regex + '）——'
          + '被改名、刪除或搬走了，無法確認防線還在。' + (g.message ? '\n     ' + g.message : ''));
        continue;
      }
      text = bm[0];
    }
    const miss = [];
    req.forEach((s, i) => {
      if (!compiled[i].test(text)) miss.push('缺：' + s);
    });
    forb.forEach((s, i) => {
      if (compiled[req.length + i].test(text)) miss.push('命中禁止樣式：' + s);
    });
    if (miss.length) {
      problems.push('[' + name + '] ' + g.file + (g.block_regex ? '（檢查區塊：' + g.block_regex + '）' : '')
        + ' 的防線不合格：\n     - ' + miss.join('\n     - ')
        + (g.message ? '\n     ' + g.message : ''));
    }
  }
  return problems;
}

function main() {
  const input = G.readInput();
  if (!input) return;
  const ti = G.isObj(input.tool_input) ? input.tool_input : {};
  if (typeof ti.command !== 'string' || !ti.command) return;
  const got = G.loadSection(input, 'pretest', (s) => G.isObj(s));
  if (!got) return;
  const sec = got.sec;
  const rules = Array.isArray(sec.alignment) ? sec.alignment : [];
  const guards = Array.isArray(sec.side_effect_guards) ? sec.side_effect_guards : [];
  if (!rules.length && !guards.length) return;
  const extras = (G.strList(sec.test_command_regex) ? sec.test_command_regex : [])
    .map((s) => G.re(s, 'gi')).filter(Boolean);

  const sh = G.scanShell(ti.command, G.shellOpts(input));
  const runs = findTestRuns(sh, extras);
  if (!runs.length) return;
  const ctx = { root: got.loc.root, e2e: got.loc.e2e, cwd: input.cwd || got.loc.root };

  const problems = [];
  const seen = new Set();
  for (const run of runs) {
    for (const p of checkAlignment(rules, sh, run, ctx)) {
      if (!seen.has(p)) {
        seen.add(p);
        problems.push('[環境對齊] ' + p);
      }
    }
  }
  for (const p of checkSideEffects(guards, ctx)) problems.push('[副作用防護] ' + p);
  if (!problems.length) return;
  G.deny(G.listMessage('[pretest] 跑測試前的檢查（' + runs.map((r) => r.what).join('、') + '）', problems,
    '正解：自己起的一套服務就配一份自己的環境檔（落檔，不要只在當下 shell export），'
    + '跑測試時 `source <你的環境檔> && python -m pytest …` 或 inline `X=值 python -m pytest …`；'
    + '副作用防線不合格就先修好那支檔（並重啟跑中的服務）再跑。\n'
    + '本閘沒有豁免註解——要跑就先對齊；驗證本 hook 請直接餵 PreToolUse payload，不必真的跑測試。\n'
    + '規則來源：專案 tests/e2e/qa-webwright.json 的 pretest 段（alignment／side_effect_guards）。'));
}

try {
  main();
} catch (_) {
  process.exitCode = 0; // FAIL-OPEN
}
