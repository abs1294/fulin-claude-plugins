/**
 * qa-gate-common — qa-webwright 各支 PreToolUse 閘共用的小工具（不是 hook，不登錄 hooks.json）。
 *
 * 共同契約（每支閘都照這個走）：
 *   · 啟動條件：往上找得到 <專案>/tests/e2e/qa-webwright.json，且該閘的規則段有設定；否則完全靜默。
 *   · 參數檔讀不到／JSON 壞掉／規則段型別不對 → 靜默（fail-open；型別錯由 python 工具端 exit 2 明講）。
 *   · 全域關閉：參數檔 hook.enabled=false → 六支 PreToolUse 閘、寫入衛生閘、專案知識閘都靜默（Stop 落地閘不受此開關）。
 *   · 擋下一律用 PreToolUse 的 permissionDecision=deny（stdout JSON，exit 0），訊息一次列完所有未過項。
 *   · 路徑一律 path 模組；不呼叫任何作業系統專屬指令（Windows 與 macOS 同一份碼）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_REL = ['tests', 'e2e', 'qa-webwright.json'];

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const data = JSON.parse(raw.replace(/^\uFEFF/, '') || '{}');
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 從 session cwd 往上找 tests/e2e/qa-webwright.json（指令常在 tests/e2e 或子資料夾裡跑；往上找到的就是所在專案）。
// input.cwd 是權威：有給就只從它找——找不到＝這個專案沒有參數檔＝靜默，不改用 CLAUDE_PROJECT_DIR 指到的別處。
// 只有 payload 沒帶 cwd 時才退回 CLAUDE_PROJECT_DIR、process.cwd()。
function findConfig(input) {
  const starts = [];
  if (input && typeof input.cwd === 'string' && input.cwd) {
    starts.push(input.cwd);
  } else {
    if (process.env.CLAUDE_PROJECT_DIR) starts.push(process.env.CLAUDE_PROJECT_DIR);
    starts.push(process.cwd());
  }
  const seen = new Set();
  for (const s of starts) {
    let dir;
    try {
      dir = path.resolve(s);
    } catch (_) {
      continue;
    }
    for (let i = 0; i < 64; i++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      const f = path.join(dir, ...CONFIG_REL);
      if (fs.existsSync(f)) return { root: dir, e2e: path.dirname(f), file: f };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

// 讀某一段規則。回 { sec, cfg, loc } 或 null（＝該閘靜默）。
// isValid(sec) 回 false → 靜默（壞設定不擋人）。
function loadSection(input, key, isValid) {
  const loc = findConfig(input);
  if (!loc) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(loc.file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
  if (!isObj(cfg)) return null;
  if (isObj(cfg.hook) && cfg.hook.enabled === false) return null;
  const sec = cfg[key];
  if (sec === undefined || sec === null) return null;
  try {
    if (isValid && !isValid(sec)) return null;
  } catch (_) {
    return null;
  }
  if (isObj(sec) && sec.enabled === false) return null;
  return { sec, cfg, loc };
}

// 參數檔裡的 regex 字串 → RegExp；壞掉回 null（呼叫端把該條規則當作不存在）。
function re(src, flags) {
  if (typeof src !== 'string' || src === '') return null;
  try {
    return new RegExp(src, flags === undefined ? 'i' : flags);
  } catch (_) {
    return null;
  }
}

function strList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function deny(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: text,
    },
  }));
  // 不呼叫 process.exit：讓 stdout 自然排空（macOS 的 pipe 是非同步寫入，exit 可能截斷輸出）
  process.exitCode = 0;
}

// 一次列完所有未過項（逐項補一項撞一項＝盲目試錯，每次 deny 都燒一輪 context）。
function listMessage(tag, problems, tail) {
  const n = problems.length;
  const head = n === 1
    ? tag + ' 有 1 項未過：'
    : tag + ' 有 ' + n + ' 項未過——以下是本次的**完整清單**，全部補齊後一次重發：';
  const body = problems.map((p, i) => '\n\n' + (i + 1) + '. ' + p).join('');
  return head + body + (tail ? '\n\n' + tail : '');
}

// ---------------------------------------------------------------------------
// shell 指令解析（bash 與 PowerShell 共用的保守近似）
//
// 把每個字元標成四類：0＝指令本體、1＝引號內的文字、2＝heredoc 本文、3＝註解。
// 「在註解／引號／heredoc 裡提到 git commit、pytest」不是呼叫——寫帳本、寫報告、
// 把指令交給別的工具審查時，內容常常會「提到」這些字。
// 已知限制：把指令寫進另一支腳本再執行、bash <<EOF 把本文當腳本執行，都看不到。
// ---------------------------------------------------------------------------
// opts.ps＝PowerShell：跳脫字元是反引號（反斜線是路徑分隔的字面值；"C:\repo\" 在反斜線後就結束），
// 單引號內一律字面值（'' 代表一個單引號）。bash：反斜線跳脫，雙引號內 \" 不結束字串。
function scanShell(cmd0, opts) {
  const ps = !!(opts && opts.ps);
  const esc = ps ? '`' : '\\';
  // 續行（bash 的 \⏎、PowerShell 的 `⏎）等同空白：`git \⏎ commit`、`python \⏎ -m pytest` 是同一次呼叫。
  // 換成等長空白，索引照樣對得回原字串。
  const cmd = String(cmd0).replace(ps ? /`\r?\n/g : /\\\r?\n/g, (m) => ' '.repeat(m.length));
  const kind = new Uint8Array(cmd.length);
  const heredocs = []; // { openAt, bodyStart, bodyEnd }
  const pending = [];
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === esc && q === '"' && i + 1 < cmd.length) {
        kind[i] = 1;
        kind[i + 1] = 1;
        i++;
        continue;
      }
      if (ps && c === "'" && q === "'" && cmd[i + 1] === "'") {
        kind[i] = 1;
        kind[i + 1] = 1;
        i++;
        continue;
      }
      if (c === q) {
        q = null;
        continue;
      }
      kind[i] = 1;
      continue;
    }
    if (c === esc && i + 1 < cmd.length && cmd[i + 1] !== '\n' && cmd[i + 1] !== '\r') {
      i++; // 跳脫字元：下一個字不當引號／註解起點
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]))) {
      while (i < cmd.length && cmd[i] !== '\n') kind[i++] = 3;
      i--;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const hm = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(cmd.slice(i));
      if (hm) {
        pending.push({ delim: hm[3], stripTabs: hm[1] === '-', openAt: i });
        i += hm[0].length - 1;
        continue;
      }
    }
    if (c === '\n' && pending.length) {
      let pos = i + 1;
      for (const h of pending) {
        const bodyStart = pos;
        let bodyEnd = cmd.length;
        while (pos < cmd.length) {
          let end = cmd.indexOf('\n', pos);
          if (end === -1) end = cmd.length;
          let line = cmd.slice(pos, end).replace(/\r$/, '');
          if (h.stripTabs) line = line.replace(/^\t+/, '');
          if (line === h.delim) {
            bodyEnd = pos;
            for (let k = pos; k < end; k++) kind[k] = 2; // 結束行本身也不是指令
            pos = end + 1;
            break;
          }
          for (let k = pos; k < end; k++) kind[k] = 2;
          pos = end + 1;
        }
        heredocs.push({ openAt: h.openAt, bodyStart, bodyEnd: Math.min(bodyEnd, cmd.length) });
      }
      pending.length = 0;
      i = pos - 1;
    }
  }
  // code：註解與 heredoc 本文換成空白（引號內容保留）；bare：再把引號內容也換成空白。長度與原字串相同。
  let code = '';
  let bare = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const k = kind[i];
    const keep = c === '\n' || c === '\r';
    code += k >= 2 && !keep ? ' ' : c;
    // 引號內的換行也要抹掉：-m "$(cat <<EOF …)" 這種多行引號仍是同一次呼叫
    bare += k >= 1 && (!keep || k === 1) ? ' ' : c;
  }
  return { raw: cmd, kind, code, bare, heredocs, ps };
}

// input（hook payload）→ scanShell 的選項：PowerShell 工具的指令用 PowerShell 的跳脫規則
function shellOpts(input) {
  return { ps: !!(input && input.tool_name === 'PowerShell') }; // portable-ok: 比對 Claude Code 工具名稱字串，不是呼叫系統指令
}

// idx 是否位於「指令位置」：行首或 ; & | ( { 之後，允許前綴環境變數賦值、env/sudo/time 等前綴指令（本身也要在
// 指令位置：`echo sudo pytest` 的 sudo 只是 echo 的參數）與 bash／sh 包一層。
// 賦值可出現在前綴指令或 bash 之前／之後（`X=1 bash x.sh`、`env X=1 time pytest` 都常見）。
// 賦值的值可由多段引號／未加引號部分接成（X="$BASE"/sub）
const ASSIGN = '(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\\n]*"|\'[^\'\\n]*\'|`[^`\\n]*`|[^\\s;&|"\'`])*\\s+)*';
// 包裝指令的選項可帶黏寫值（--x=v）或分開寫的值（uv run --project app、sudo -u root）
// xvfb-run（無頭顯示）、dotenv [-f 檔] run [--]（python-dotenv CLI）也是常見的包裝；選項結尾可有 -- 分隔
// 選項值可被引號包住、內含空白（xvfb-run -s "-screen 0 1280x1024x24"）
const WRAP_OPT = '\\s+-{1,2}[A-Za-z][\\w-]*(?:=\\S*)?(?:\\s+(?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s;&|<>()"\'-][^\\s;&|<>()]*))?';
const WRAPPER = '(?:(?:sudo|env|time|nohup|command|exec|xargs|nice|stdbuf|timeout|xvfb-run'
  + '|(?:uv|poetry|pipenv|hatch|pdm|rye)\\s+run|dotenv(?:' + WRAP_OPT + ')*\\s+run)'
  + '(?:' + WRAP_OPT + '|\\s+\\d+[smhd]?)*(?:\\s+--(?=\\s))?\\s+' + ASSIGN + ')*';
const CMD_PREFIX = new RegExp(
  '(?:^|[;&|({\\n])\\s*(?:(?:then|do|else|elif|if|while|until|!)\\s+)*'
  + ASSIGN + WRAPPER
  + '(?:(?:bash|sh|zsh)\\s+(?:-[A-Za-z]+\\s+)*)?'
  + ASSIGN
  + '(?:&\\s*)?$'
);
function atCommandPosition(sh, idx) {
  // 用 bare（引號內容已抹成空白）判斷：`echo "x; " pytest` 引號裡的 ; 不是分隔符
  const lineStart = sh.bare.lastIndexOf('\n', idx - 1) + 1;
  // 同一行往前看就夠：多行指令的換行本身就是分隔符
  return CMD_PREFIX.test(sh.bare.slice(lineStart, idx));
}

// 從 idx 往回找到這個字詞的起點（含引號包住、內含空白的路徑）
function wordStart(sh, idx) {
  let j = idx;
  while (j > 0 && (sh.kind[j - 1] === 1 || !/[\s;&|()]/.test(sh.code[j - 1]))) j--;
  return j;
}

// 把一段指令文字切成 shell 字詞（去引號、處理跳脫）。回 [{ word, quoted, start }]。
// 重導運算子（>、2>&1、<<EOF…）自成一個字詞，word 以 < 或 > 開頭，呼叫端自行略過。
// opts.ps＝PowerShell：反斜線是路徑分隔（字面值），跳脫字元是反引號；單引號內一律字面值。
function shellWords(text, opts) {
  const out = [];
  const s = String(text || '');
  const esc = opts && opts.ps ? '`' : '\\';
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let word = '';
    let quoted = false;
    const redir = /^(?:\d*|&)(?:>&|<&|>\||>>?|<<?-?)/.exec(s.slice(i));
    if (redir && redir[0].length) {
      word = redir[0];
      i += redir[0].length;
      if (/[&]$/.test(word)) {
        while (i < s.length && /[\d-]/.test(s[i])) word += s[i++];
      }
      out.push({ word, quoted: false, start, redirect: true });
      continue;
    }
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === esc && i + 1 < s.length) {
        word += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        quoted = true;
        const q = c;
        i++;
        while (i < s.length && s[i] !== q) {
          // bash 雙引號內反斜線只跳脫 $ ` " \ 與換行（"C:\repo\x" 的 \r \x 是字面值）；PowerShell 用反引號
          if (q === '"' && s[i] === esc && i + 1 < s.length && (esc === '`' || /[$`"\\\n]/.test(s[i + 1]))) {
            word += s[i + 1];
            i += 2;
            continue;
          }
          word += s[i++];
        }
        i++;
        continue;
      }
      if (c === '>' || c === '<') break; // 緊貼的重導（x>file）
      word += c;
      i++;
    }
    if (word !== '' || quoted) out.push({ word, quoted, start });
  }
  return out;
}

// 拒絕訊息裡的值一律遮罩（環境值與對照檔擷取值可能是密碼／token）：只露長度與前後各 2 字元。
function mask(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (s.length <= 8) return '***（長度 ' + s.length + '）';
  return s.slice(0, 2) + '***' + s.slice(-2) + '（長度 ' + s.length + '）';
}

// Git Bash／MSYS 形式的絕對路徑（/c/Users/x）在 Windows 上轉成原生（C:\Users\x）；其他平台原樣回傳。
function nativePath(p) {
  const s = String(p || '');
  if (process.platform !== 'win32') return s;
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(s);
  if (m) return m[1].toUpperCase() + ':' + (m[2] || '/').replace(/\//g, '\\');
  return s;
}

// 路徑值裡的 $VAR／${VAR}／開頭的 ~ 展開（值取自同一條指令或 process env；$PWD 缺席時用 cwd）。
// 展開不了（變數沒有值、含命令替換）回 null——呼叫端當「無從判斷」。
function expandPathValue(sh, value, opts) {
  let s = String(value || '');
  if (/^~(?=\/|\\|$)/.test(s)) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return null;
    s = home + s.slice(1);
  }
  const v = expandValue(sh, s, opts);
  return v === null ? null : nativePath(v);
}

// 值裡的 $VAR／${VAR}／$env:VAR 展開（值取自同一條指令或 process env）；沒有 $ 原樣回傳。
// 展開不了（變數沒有值、含命令替換）回 null——呼叫端當「無從判斷」，不擋也不放。
// 多層引用（R=/x; B=$R; X=$B/sub）逐層展開：被引用變數的值以「它被賦值的位置」為準再展開；
// 單引號賦值（X='$Y'）是字面值，不展開。
const EXPAND_DEPTH = 8;
function expandValue(sh, value, opts) {
  const o = opts || {};
  const depth = o.depth || 0;
  let s = String(value || '');
  if (/\$\(|`/.test(s)) return null;
  if (s.indexOf('$') < 0) return s;
  if (depth > EXPAND_DEPTH) return null; // 引用鏈太深（多半是循環）＝無從判斷
  let failed = false;
  // $env:X 要先比對（否則 $env 會被當成名為 env 的變數）
  s = s.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gi, (_m, c, a, b) => {
    if (failed) return '';
    const name = c || a || b;
    // $PWD：hook 程序自己的 PWD 不是 Bash 工具的工作目錄，只認同指令賦值，否則用 session cwd
    const isPwd = name === 'PWD';
    const got = envValue(sh, name, { beforeIdx: o.beforeIdx, bases: o.bases, dirAt: o.dirAt, useProcessEnv: !isPwd,
      depth: depth + 1 });
    if (got && got.value === null) {
      failed = true; // 值未知（來自展開不了路徑的 source）
      return '';
    }
    if (got && got.value === '' && got.from !== 'process env') return ''; // 同指令明設為空（X=）＝空字串，不是未知
    if (got && got.value !== '') {
      if (got.literal || got.value.indexOf('$') < 0 || got.from === 'process env') return got.value;
      const inner = expandValue(sh, got.value, Object.assign({}, o, { beforeIdx: got.at, depth: depth + 1 }));
      if (inner === null) {
        failed = true;
        return '';
      }
      return inner;
    }
    if (isPwd && o.cwd) return o.cwd;
    failed = true;
    return '';
  });
  if (failed) return null;
  return s;
}

// 已展開的值 → 路徑：開頭的 ~ 換成家目錄（單引號字面值不換）、Git Bash 的 /c/… 轉原生。家目錄不明回 null。
function valuePath(value, literal) {
  let s = String(value || '');
  if (!literal && /^~(?=\/|\\|$)/.test(s)) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return null;
    s = home + s.slice(1);
  }
  return nativePath(s);
}

// 取變數在該位置的值並展開（單引號字面值原樣）；回 { value, from, literal } 或 null（沒設），展開不了 value＝null
function resolvedEnv(sh, name, opts) {
  const got = envValue(sh, name, opts);
  if (!got) return null;
  if (got.value === null) return { value: null, from: got.from, literal: false }; // 值未知 → 呼叫端當無從判斷
  // 值裡的 $VAR 以「這個變數被賦值的位置」展開（BASE=/a; X=$BASE; BASE=/b → X 是 /a）
  const at = typeof got.at === 'number' ? got.at : (opts || {}).beforeIdx;
  // process env 的值已是最終值（密碼／token 裡的字面 $ 不得再展開）
  const value = got.literal || got.from === 'process env' ? got.value
    : expandValue(sh, got.value, Object.assign({}, opts, { beforeIdx: at }));
  return { value, from: got.from, literal: !!got.literal };
}

// 從 start 起取「這一次呼叫」的結束位置：下一個不在引號、不在括號裡的 ; & | 或換行。
// 續行（bash 的 \、PowerShell 的反引號）視為同一次呼叫。
function segmentEnd(sh, start) {
  const s = sh.bare;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if ((c === '\\' || c === '`') && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      i += s[i + 1] === '\r' ? 2 : 1;
      continue;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth--;
      continue;
    }
    // 2>&1、>&2、&>file 的 & 是重導的一部分，不是背景執行／分隔符
    if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || (s[i + 1] === '>' && s[i - 1] !== '&'))) continue;
    // >|（noclobber 下強制覆寫）的 | 是重導的一部分，不是管線
    if (c === '|' && s[i - 1] === '>') continue;
    if (depth === 0 && (c === ';' || c === '&' || c === '|' || c === '\n')) return i;
  }
  return s.length;
}

// 某次呼叫「自己那一段」的文字（含引號內容、含該段開出去的 heredoc 本文；不含註解）。
function segmentText(sh, start, end) {
  let text = sh.code.slice(start, end);
  for (const h of sh.heredocs) {
    if (h.openAt >= start && h.openAt < end) text += '\n' + sh.raw.slice(h.bodyStart, h.bodyEnd);
  }
  return text;
}

// 去掉 heredoc 本文與註解後的指令（給「整條指令比對」的規則用）
function codeOnly(cmd, opts) {
  return scanShell(cmd, opts).code;
}

// 取某個環境變數在「這條指令執行當下」的值。來源依序：
//   ① 同指令的 inline 前綴／export／$env:／set 賦值（取出現在 beforeIdx 之前的最後一個）
//   ② 同指令 source <檔> / . <檔> 讀進來的檔（找該檔的 export X= 或 X= 行，取最後一個）
//   ③ 目前 process 的環境變數
// 回 { value, from } 或 null。
function unquote(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) return s.slice(1, -1);
  return s;
}
function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// 一個 shell 字詞可由多段引號／未加引號部分接成（"$BASE"/sub、a'b'"c"）
// 命令替換 `…` 也算值的一段（值未知：展開時回 null）
const WORD_VAL = '((?:"[^"\\n]*"|\'[^\'\\n]*\'|`[^`\\n]*`|[^\\s;&|`"\'])*)';
// 接起來的字詞 → 去掉引號後的內容；literal＝整個字詞都是單引號段（$ 不展開）
function joinWord(v) {
  const s = String(v === undefined || v === null ? '' : v);
  let out = '';
  let allSingle = s.length > 0;
  const rx = /"([^"\n]*)"|'([^'\n]*)'|([^"']+)/g;
  let m;
  while ((m = rx.exec(s)) !== null) {
    if (m[2] !== undefined) out += m[2];
    else {
      allSingle = false;
      out += m[1] !== undefined ? m[1] : m[3];
    }
  }
  return { text: out, literal: allSingle };
}

function assignmentRegex(name) {
  const n = escRe(name);
  const val = WORD_VAL;
  // bash 賦值的等號兩邊不能有空白（X= pytest 的 X 是空值，不是 pytest）；PowerShell $env:X = "v" 可有空白但不跨行
  // 第三種：PowerShell 區域變數 $d = "…"（後面用 "$d/" 引用）
  return new RegExp(
    '(?:^|[\\s;&|(])(?:(?:export|set)[ \\t]+)?' + n + '=' + val
    + '|\\$env:' + n + '[ \\t]*=[ \\t]*' + val
    + '|(?:^|[\\s;&|(])\\$' + n + '[ \\t]*=(?!=)[ \\t]*' + val, 'g');
}
// source 進來的檔內部的變數引用：以檔內 upto 位置之前最後一次賦值展開（可多層）；檔內沒賦值的留給外層展開
function expandInFile(value, body, upto, depth) {
  if (depth > EXPAND_DEPTH || value.indexOf('$') < 0) return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => {
    const name = a || b;
    const fr = new RegExp('^[ \\t]*(?:export[ \\t]+)?' + escRe(name) + '=((?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s#;"\'])*)', 'gm');
    let fm;
    let hit = null;
    while ((fm = fr.exec(body)) !== null && fm.index < upto) hit = fm;
    if (!hit) return all;
    const w = joinWord(hit[1]);
    return w.literal ? w.text : expandInFile(w.text, body, hit.index, depth + 1);
  });
}

function envValue(sh, name, opts) {
  const o = opts || {};
  const beforeIdx = o.beforeIdx === undefined ? sh.code.length : o.beforeIdx;
  const text = sh.code.slice(0, beforeIdx);
  // 同一條指令裡「最後一次」設定它的地方為準：inline／export 賦值與 source 讀進來的檔依出現位置比先後
  let inline = null;
  const rx = assignmentRegex(name);
  let m;
  while ((m = rx.exec(text)) !== null) {
    inline = { at: m.index, value: m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] };
  }

  const srcRx = /(?:^|[\s;&|(])(?:source|\.)\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|]+)/g;
  let sm;
  let srcVal = null;
  let srcUnknownAt = -1; // source 的路徑展開不了（$UNSET、命令替換）：不知道載入了什麼
  const loads = []; // 會把檔案內容載入環境的地方：[index, 路徑字詞]（依出現位置處理）
  while ((sm = srcRx.exec(text)) !== null) {
    // source／. 必須在指令位置（find . $X、cp -r . "$D" 的 . 是參數，不是 source）
    const kw = sm.index + (/^[\s;&|(]/.test(sm[0]) ? 1 : 0);
    if (sh.kind[kw] !== 0 || !atCommandPosition(sh, kw)) continue;
    const ld = [sm[0], sm[1]];
    ld.index = sm.index;
    loads.push(ld);
  }
  // python-dotenv 的 CLI：dotenv [-f 檔] run [--] <指令> 先載入該檔（預設 .env）再執行指令
  const dotRx = /(?:^|[\s;&|(])dotenv((?:\s+(?:-f|--file)(?:\s+|=)(?:"[^"\n]+"|'[^'\n]+'|[^\s;&|]+)|\s+-{1,2}[A-Za-z][\w-]*(?:=\S*)?)*)\s+run(?![\w-])/g;
  let dm;
  while ((dm = dotRx.exec(text)) !== null) {
    const kw = dm.index + (/^[\s;&|(]/.test(dm[0]) ? 1 : 0);
    if (sh.kind[kw] !== 0 || !atCommandPosition(sh, kw)) continue;
    const fm = /(?:-f|--file)(?:\s+|=)("[^"\n]+"|'[^'\n]+'|[^\s;&|]+)/.exec(dm[1]);
    const ld = [dm[0], fm ? fm[1] : '.env'];
    ld.index = dm.index;
    loads.push(ld);
  }
  loads.sort((a, b) => a.index - b.index);
  for (const sm of loads) {
    // 相對路徑只以「source 當下的目錄」解析（同指令前面 cd 過就以那裡為準，否則第一個基準＝session cwd）：
    // shell 找不到就是 source 失敗，不得改拿別的目錄底下同名檔的值
    const here = typeof o.dirAt === 'function' ? o.dirAt(sm.index) : null;
    const bases = [typeof here === 'string' ? here : (o.bases || [])[0]].filter(Boolean);
    // 路徑裡的 ~、$VAR 先展開（單引號是字面值）；展開不了＝無從判斷
    let rel = unquote(sm[1]);
    if (sm[1][0] !== "'" && (/^~(?=\/|\\|$)/.test(rel) || rel.indexOf('$') >= 0) && (o.depth || 0) < EXPAND_DEPTH) {
      const ex = expandPathValue(sh, rel, { beforeIdx: sm.index, bases: o.bases, dirAt: o.dirAt, cwd: bases[0],
        depth: (o.depth || 0) + 1 });
      if (ex === null) {
        srcUnknownAt = sm.index;
        continue;
      }
      rel = ex;
    }
    rel = nativePath(rel);
    for (const b of bases) {
      let body;
      try {
        body = fs.readFileSync(path.resolve(b, rel), 'utf8');
      } catch (_) {
        continue;
      }
      const fr = new RegExp('^[ \\t]*(?:export[ \\t]+)?' + escRe(name) + '=((?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s#;"\'])*)', 'gm');
      let fm;
      let found = null;
      let foundAt = -1;
      while ((fm = fr.exec(body)) !== null) {
        found = fm[1];
        foundAt = fm.index;
      }
      if (found !== null) {
        const w = joinWord(found);
        // 檔內先展開：TARGET=$BASE/sub 的 BASE 以同一個檔裡、這一行之前的賦值為準（指令前面另設的 BASE 不算）
        const value = w.literal ? w.text : expandInFile(w.text, body, foundAt, 0);
        // 來源只標檔名：完整路徑可能帶出本機目錄結構
        srcVal = { at: sm.index, value, literal: w.literal, from: 'source ' + path.basename(toPosix(rel)) };
      }
      break;
    }
  }
  // 變數名本身是動態的整批載入（export $(cat .env | xargs)、export "$@"、eval "$(…)"）：載入了哪些變數無從得知
  const bulkRx = /(?:^|[\s;&|(])(?:export|eval|declare[ \t]+-x|typeset[ \t]+-x)[ \t]+["']?(?:\$\(|`|\$[{@*A-Za-z_])/g;
  let bm;
  while ((bm = bulkRx.exec(text)) !== null) {
    const kw = bm.index + (/^[\s;&|(]/.test(bm[0]) ? 1 : 0);
    if (sh.kind[kw] !== 0 || !atCommandPosition(sh, kw)) continue;
    // eval 只有看得出是在載入環境變數（direnv、dotenv、.env 檔、export）才算；
    // eval "$(pyenv init -)"、eval "$(conda shell.bash hook)" 只是初始化工具，不會設專案的變數
    if (/^[\s;&|(]?eval\b/.test(bm[0]) && !/direnv|dotenv|\.env\b|\bexport\b/.test(sh.code.slice(bm.index, segmentEnd(sh, kw + 4)))) continue;
    if (bm.index > srcUnknownAt) srcUnknownAt = bm.index;
  }
  // 最後一次設定它的地方是「展開不了路徑的 source」或動態整批載入 → 值未知（value: null），呼叫端當無從判斷
  if (srcUnknownAt >= 0 && srcUnknownAt > (inline ? inline.at : -1) && srcUnknownAt > (srcVal ? srcVal.at : -1)) {
    return { value: null, from: 'source 路徑無法展開或整批載入', at: srcUnknownAt, unknown: true };
  }
  if (inline && (!srcVal || inline.at > srcVal.at)) {
    const w = joinWord(inline.value);
    return { value: w.text, from: 'inline', at: inline.at, literal: w.literal };
  }
  if (srcVal) return { value: srcVal.value, from: srcVal.from, at: srcVal.at, literal: srcVal.literal };
  if (o.useProcessEnv !== false && typeof process.env[name] === 'string' && process.env[name] !== '') {
    return { value: process.env[name], from: 'process env' };
  }
  return null;
}

// 在 idx 之前、同一條指令裡的 cd／pushd／Set-Location 逐次累積（cd a && cd b ＝ a/b），回目前目錄。
// 切到變數、~、- 或沒有參數 → 解析不出，回 { unknown }。已知限制：不理會子殼層 (cd x) 的範圍。
function cdChain(sh, idx, base) {
  // 目錄前的選項（cd -- x、cd -P x、Set-Location -Path x／-LiteralPath x）略過；單獨的 - 是「上一個目錄」，不是選項
  const rx = /(?:^|[;&|(\n])\s*(?:cd|pushd|Set-Location|sl)(?:\s+(?:-(?:Literal)?Path|--|-[LPe@]{1,3})(?=\s))*(?:\s+("[^"\n]*"|'[^'\n]*'|[^\s;&|)]+))?(?=\s|$|[;&|)])/gi;
  const text = sh.code.slice(0, idx);
  let m;
  let dir = base;
  while ((m = rx.exec(text)) !== null) {
    if (sh.kind[m.index + m[0].search(/[A-Za-z]/)] !== 0) continue; // cd 關鍵字在引號／heredoc 裡＝只是提到
    const d = m[1] === undefined ? '' : unquote(m[1]);
    if (!d || d === '-' || /^~/.test(d) || /[$`]/.test(d)) {
      dir = { unknown: d || '（cd 無參數）' };
      continue;
    }
    if (dir && dir.unknown) continue;
    dir = path.resolve(dir, nativePath(d));
  }
  return dir;
}

// 精簡 glob：** 跨目錄、* 不跨 /、? 單字元、{a,b} 選一。比對正斜線相對路徑。
function globToRegex(glob) {
  let out = '';
  let i = 0;
  let brace = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
        continue;
      }
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      out += '(?:';
      brace++;
    } else if (c === '}' && brace > 0) {
      out += ')';
      brace--;
    } else if (c === ',' && brace > 0) {
      out += '|';
    } else {
      out += escRe(c);
    }
    i++;
  }
  return new RegExp('^' + out + '$', 'i');
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

module.exports = {
  readInput,
  isObj,
  findConfig,
  loadSection,
  re,
  strList,
  deny,
  listMessage,
  scanShell,
  atCommandPosition,
  segmentEnd,
  segmentText,
  codeOnly,
  envValue,
  shellWords,
  shellOpts,
  wordStart,
  cdChain,
  mask,
  nativePath,
  expandPathValue,
  expandValue,
  valuePath,
  resolvedEnv,
  globToRegex,
  toPosix,
  escRe,
  unquote,
};
