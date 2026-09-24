// shell-model：用真正的 shell 語法解析器（tree-sitter）把一條指令拆成「實際會執行的程式」與「它們各自拿到的環境」。
// guard-risky-command.js 與 guard-test-preconditions.js 共用；解析器沒裝或載入失敗時 analyze() 回 null，
// 呼叫端退回原本的正則路徑（準確度較低，但不會整個失效）。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，解析器以 npm 安裝在同目錄的 node_modules
// （.claude/hooks/package.json＋package-lock.json 鎖定版本；node_modules 不進版控，clone 後在 .claude/hooks 跑一次 npm ci）。
//
// 為什麼不用正則：shell 的寫法沒有上限（子殼、命令替換、heredoc、續行、條件執行、引號規則、export 與 shell 變數之別…），
// 用字串規則「猜」會執行什麼，每補一種寫法就有下一種。語法樹把結構直接給出來，這裡只需要處理「語意」
// ——哪些程式會真的跑、它們各自拿到什麼環境變數。
//
// 輸出（analyze 的回傳值）：
//   execs：每個會執行的程式一筆 { verb, argv, words, text, masked, raw, scope, cond, pipe, pipeIndex, feeds, prefix, envFiles, cwdBases }
//   lines：給規則比對用的文字，每條管線一行（與舊引擎相同的遮罩規則），{ raw, masked, execs:[索引] }
//   envAt(execIndex, name)：那個程式執行時實際拿到的變數值（undefined＝不存在，或值無法確認）
//   envUnsure(execIndex, name)：true＝前面有「可能發生過、也可能沒有」的設定（條件區段、函式本體、兜底補收的指令），值無法確認
'use strict';
const fs = require('fs');
const path = require('path');

// ── 解析器載入（失敗回 null，不拋例外）──────────────────────────────────────
let loaded = null;
function parsers() {
  if (loaded !== null) return loaded;
  loaded = false;
  try {
    const Parser = require('tree-sitter');
    const bash = require('tree-sitter-bash');
    let powershell = null;
    try {
      // tree-sitter-powershell 的套件入口是含 top-level await 的 ESM，require 不了；直接載它預編的原生檔
      const root = path.dirname(require.resolve('tree-sitter-powershell/package.json'));
      powershell = require('node-gyp-build')(root);
    } catch (e) { powershell = null; }
    loaded = { Parser, bash, powershell };
  } catch (e) {
    loaded = false;
  }
  return loaded;
}
function available(tool) {
  if (process.env.HARNESS_SHELL_PARSER === 'off') return false;   // 測試退回路徑用
  const p = parsers();
  if (!p) return false;
  return tool === 'PowerShell' ? !!p.powershell : true;
}
function parse(lang, text) {
  const p = parsers();
  const parser = new p.Parser();
  parser.setLanguage(lang === 'powershell' ? p.powershell : p.bash);
  return parser.parse(text);
}

// ── 共用小工具 ──────────────────────────────────────────────────────────────
const MENTION_VERBS = new Set([
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'head', 'tail',
  'wc', 'ls', 'dir', 'man', 'which', 'where', 'type', 'tee', 'findstr', 'find', 'vi', 'vim', 'nano', 'code',
  'write-host', 'write-output', 'select-string', 'sls', 'get-content', 'gc', 'get-command', 'out-file', 'out-null',
]);
const BASH_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const DB_CLIENTS = new Set(['psql', 'mysql', 'sqlcmd', 'mongosh', 'mongo', 'sqlite3', 'invoke-sqlcmd']);
const EVAL_ALWAYS = new Set(['eval', 'iex', 'invoke-expression', 'ssh']);
const baseName = (w) => String(w || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/i, '');

// 段首指令本身會把引號字串當程式執行 → 引號內容要納入比對（與舊引擎相同的判準）
function evaluatesQuoted(verb, args) {
  if (DB_CLIENTS.has(verb) || EVAL_ALWAYS.has(verb)) return true;
  const has = (re) => args.some((a) => re.test(a));
  if ((verb === 'node' || verb === 'bun') && has(/^(?:-e|-p|--eval|--print)(?:=|$)/)) return true;
  if (/^(?:python[0-9.]*|py)$/.test(verb) && has(/^-c$/)) return true;
  if ((verb === 'ruby' || verb === 'perl') && has(/^-[A-Za-z]*e$/)) return true;
  if (verb === 'php' && has(/^-r$/)) return true;
  if (verb === 'deno' && args[0] === 'eval') return true;
  return false;
}

// 「後面接著真正要跑的指令」的前綴程式：回傳 { skip：從 argv 第幾個起才是真正的指令, envOps：env 的清除／設定 }
// argv[0] 是前綴程式本身。
function runnerPrefix(argv) {
  const ops = [];
  let i = 0;
  for (;;) {
    const v = baseName(argv[i]);
    if (v === 'sudo') {
      i++;
      while (i < argv.length && argv[i].startsWith('-')) {
        if (argv[i] === '--') { i++; break; }
        i += /^-[ugphCDrtTU]$/.test(argv[i]) ? 2 : 1;
      }
      // sudo 在指令前的 VAR=value 是給那個指令的環境（`sudo APP_ENV=production npm start`）
      while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) {
        const k = argv[i].indexOf('=');
        ops.push({ type: 'set', name: argv[i].slice(0, k), value: argv[i].slice(k + 1), idx: i });
        i++;
      }
      ops.push({ type: 'runner', name: 'sudo' });
    } else if (v === 'env') {
      i++;
      while (i < argv.length) {
        const a = argv[i];
        if (a === '-i' || a === '--ignore-environment' || a === '-') { ops.push({ type: 'clear' }); i++; }
        else if (a === '-u') { ops.push({ type: 'unset', name: argv[i + 1] }); i += 2; }
        else if (a.startsWith('--unset=')) { ops.push({ type: 'unset', name: a.slice(8) }); i++; }
        else if (a === '-C') { i += 2; }
        else if (a.startsWith('--chdir=') || a === '-S' || /^-[0v]$/.test(a)) { i++; }
        else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { const k = a.indexOf('='); ops.push({ type: 'set', name: a.slice(0, k), value: a.slice(k + 1), idx: i }); i++; }
        else break;
      }
    } else if (v === 'nice') {
      i++;
      while (i < argv.length && /^(?:-n|-\d+|--adjustment=.*)$/.test(argv[i])) i += argv[i] === '-n' ? 2 : 1;
    } else if (v === 'timeout') {
      i++;
      while (i < argv.length && argv[i].startsWith('-')) i += /^-[sk]$/.test(argv[i]) ? 2 : 1;
      i++; // 秒數
    } else if (v === 'time') {
      i++; if (argv[i] === '-p') i++;
    } else if (v === 'nohup' || v === 'builtin') {
      i++;
    } else if (v === 'command') {
      i++; if (argv[i] === '-p') i++;
    } else if (v === 'exec') {
      i++;
      while (i < argv.length && argv[i].startsWith('-')) i += argv[i] === '-a' ? 2 : 1;
    } else break;
    if (i >= argv.length) break;
  }
  return { skip: i, envOps: ops };
}

// ── bash 語法樹 → 執行清單＋設定事件 ─────────────────────────────────────────
// 範圍（scope）：字串路徑，外層是內層的前綴。種類記在 scopes 表：
//   'fork'：( … )、$( … )、管線各段——分叉出的子殼，繼承所有 shell 變數（含未匯出），但設定不回外層
//   'exec'：bash -c、find -exec、xargs 叫起的新程序——只繼承已匯出的變數
// 條件（cond）：落在 && 右側、|| 右側、if／while／for／case 內文、函式本體的，記一個條件區段的識別碼；
// 事件只算給「一定跟它一起發生」的執行（事件的條件區段必須是執行的條件區段的前綴）；
// 範圍看得到、發生在它之前、卻不一定發生的事件（「可能發生過」），會讓那個變數的值判成無法確認——不是忽略。
class Model {
  constructor(startDir, root) {
    this.execs = [];
    this.events = [];      // { seq, scope, cond, type, ... }
    this.scopes = { '': 'root' };
    this.seq = 0;
    this.nextScope = 0;
    this.nextCond = 0;
    this.startDir = startDir;
    this.root = root;
    this.lines = [];
    this.seen = new Set();   // 已收進 execs 的指令節點（兜底掃描用）
    this.treeSeq = 0;        // 解析過幾棵樹（主指令、bash -c 內層……各一棵）
    this.curTree = 0;
    this.unsureDepth = 0;    // >0＝正在走「看不出何時執行」的位置（函式本體、兜底補收），其中指令的環境值另行從嚴
    this.loopStack = [];     // 目前在哪幾層迴圈裡（迴圈體後段的設定，下一輪會落在前段指令之前）
    this.nextLoop = 0;
  }
  newScope(parent, kind) { const s = parent + '/' + (this.nextScope++) + kind[0]; this.scopes[s] = kind; return s; }
  newCond(parent) { return parent + '/' + (this.nextCond++); }
  // 函式本體、兜底補收指令裡的設定：實際發生在呼叫的時候，看不出是哪個時間點——標 anytime，對同一串所有指令都算「可能發生過」
  event(ev) { ev.seq = this.seq++; ev.anytime = this.unsureDepth > 0; ev.loops = this.loopStack.slice(); this.events.push(ev); return ev; }
}

// 取一個詞節點的實際值（引號拿掉、跳脫解開）；quoted 表示有沒有加引號
function wordInfo(n) {
  if (!n) return { value: '', quoted: false };
  switch (n.type) {
    case 'raw_string': return { value: n.text.slice(1, -1), quoted: true };
    case 'string': {
      let v = '';
      for (let i = 0; i < n.namedChildCount; i++) v += n.namedChild(i).type === 'string_content' ? n.namedChild(i).text.replace(/\\([$`"\\\n])/g, '$1') : n.namedChild(i).text;
      return { value: n.namedChildCount ? v : n.text.slice(1, -1), quoted: true };
    }
    case 'ansi_c_string': return { value: expandEscapes(n.text.slice(2, -1).replace(/\\(['"?])/g, '$1')), quoted: true };
    case 'concatenation': {
      let v = '', q = false;
      for (let i = 0; i < n.namedChildCount; i++) { const w = wordInfo(n.namedChild(i)); v += w.value; q = q || w.quoted; }
      if (!n.namedChildCount) v = n.text;
      return { value: v, quoted: q };
    }
    case 'word': return { value: n.text.replace(/\\(.)/g, '$1'), quoted: false };
    default: return { value: n.text, quoted: false };
  }
}

// ── 值的表示：字面值照原樣（含單引號裡的 `$X`）；同名展開記成 REF（算值時照當下的值展開）；其他展開一律未知 ──
// 建事件時就要分清楚——轉成字串之後，`'$X'`（字面）與 `"$X"`（展開）就分不出來了。
const V_OPAQUE = '\u0000opaque';
const V_REF = '\u0000ref:';
const V_STAR = '\u0000star';          // 名字本身是展開：寫到哪個變數看不出來
const V_APPEND = '\u0000append:';     // `X+=值`：接在目前的值後面
// 賦值節點是不是 `X+=…`、`X[i]=…`
const isAppend = (a) => /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+=/.test(a.text);
const isSubscript = (a) => /^[A-Za-z_][A-Za-z0-9_]*\[/.test(a.text);
const baseVar = (s) => String(s).replace(/\[[\s\S]*$/, '');
const EXPANSION_TYPES = new Set(['simple_expansion', 'expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion']);
function hasExpansion(n) {
  if (!n) return false;
  if (EXPANSION_TYPES.has(n.type)) return true;
  for (let i = 0; i < n.namedChildCount; i++) if (hasExpansion(n.namedChild(i))) return true;
  return false;
}
const REF_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=][^}$`'"\\]*)?\})$/;
function refOrOpaque(text) {
  let t = text;
  if (/^"[\s\S]*"$/.test(t)) t = t.slice(1, -1);
  return REF_RE.test(t) ? V_REF + t : V_OPAQUE;
}
function valueOf(n) {
  if (!n) return '';
  return hasExpansion(n) ? refOrOpaque(n.text) : wordInfo(n).value;
}
// 單一個 `NAME=值` 詞（`env X=v`、`sudo X=v`、`export "X=v"`、`export 'X'=v`）：回 { name, value }；名字本身是展開回 null
function assignWord(n) {
  if (!hasExpansion(n)) {
    const v = wordInfo(n).value;
    const k = v.indexOf('=');
    return k > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.slice(0, k)) ? { name: v.slice(0, k), value: v.slice(k + 1) } : null;
  }
  // 三種形狀：`"X=…"`（整段雙引號）、`X=…`（值可帶引號）、`'X'=…`；其他形狀看不出名字
  const t = n.text;
  let r = /^"([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)"$/.exec(t);
  if (r) return { name: r[1], value: refOrOpaque(r[2]) };
  r = /^(?:'([A-Za-z_][A-Za-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))=([\s\S]*)$/.exec(t);
  return r ? { name: r[1] || r[2], value: refOrOpaque(r[3]) } : null;
}
// export／declare／local／readonly／typeset／unset 的引數節點 → emitBuiltin 吃的字串（值照上面的表示法）
function argsForBuiltin(nodes) {
  return nodes.map((c) => {
    if (c.type === 'variable_assignment') {
      const nm = c.childForFieldName('name');
      if (!nm || hasExpansion(nm)) return V_STAR;
      return wordInfo(nm).value + '=' + (isAppend(c) ? V_APPEND : '') + valueOf(c.childForFieldName('value'));
    }
    if (!hasExpansion(c)) return wordInfo(c).value;
    const aw = assignWord(c);
    return aw ? aw.name + '=' + aw.value : V_STAR;
  });
}

// 走訪整棵樹：收集執行與設定事件
function walk(m, node, scope, cond) {
  if (!node) return;
  switch (node.type) {
    case 'program': case 'compound_statement':
      for (let i = 0; i < node.namedChildCount; i++) walk(m, node.namedChild(i), scope, cond);
      return;
    case 'subshell': {
      const s = m.newScope(scope, 'fork');
      for (let i = 0; i < node.namedChildCount; i++) walk(m, node.namedChild(i), s, cond);
      return;
    }
    case 'list': {
      // a && b：b 只在 a 成功後才跑；a || b：b 只在 a 失敗後才跑。語法樹左結合（`a || b && c`＝`(a || b) && c`）。
      // 回傳「整串成功時一定已發生」的條件區段，讓外層 `&& c` 的 c 接在它底下：
      //   `L && R`：R 接在 L 的成功區段底下；整串成功＝R 跑過且成功 → 回傳 R 的區段。
      //   `L || R`：R 另開區段（只在 L 失敗時跑）；整串成功不保證 R 跑過 → 回傳本串的起始區段。
      const kids = namedKids(node);
      let succ = walk(m, kids[0], scope, cond) || cond;
      for (let k = 1; k < kids.length; k++) {
        if (opBefore(node, kids[k]) === '||') { walk(m, kids[k], scope, m.newCond(cond)); succ = cond; }
        else { const nc = m.newCond(succ); succ = walk(m, kids[k], scope, nc) || nc; }
      }
      return succ;
    }
    case 'if_statement': case 'elif_clause': case 'else_clause': case 'while_statement': case 'for_statement':
    case 'c_style_for_statement': case 'case_statement': case 'case_item': case 'do_group': {
      // 條件（condition 欄位）一定會跑；內文視條件而定。迴圈另外標記：迴圈體後段的設定，下一輪會落在前段指令之前
      const isLoop = /^(?:while_statement|for_statement|c_style_for_statement)$/.test(node.type);
      if (isLoop) m.loopStack.push(m.nextLoop++);
      try {
        const condNode = node.childForFieldName && node.childForFieldName('condition');
        if (condNode) walk(m, condNode, scope, cond);
        const inner = m.newCond(cond);
        // `for X in …`：迴圈變數本身被改寫（值依清單而定，不一定跑）
        if (node.type === 'for_statement') {
          const v = node.childForFieldName('variable');
          if (v) m.event({ type: 'maybe', scope, cond: inner, name: v.text });
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c === condNode || (condNode && c.id === condNode.id)) continue;
          if (c.type === 'variable_name' || c.type === 'word' && node.type !== 'do_group') { collectSubs(m, c, scope, cond); continue; }
          walk(m, c, scope, inner);
        }
      } finally {
        if (isLoop) m.loopStack.pop();
      }
      return;
    }
    case 'pipeline': {
      // 管線各段各自跑在分叉出的子殼裡（設定不回外層）；段落屬於哪條管線，由 addCommand 看父節點認。
      // 上游印出的文字接給讀 stdin 的殼（`echo 'git push' | bash`、`cat <<< '…' | sh`）＝那個殼的腳本，當內層指令解析
      let prev = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const el = node.namedChild(i);
        const before = m.execs.length;
        walk(m, el, m.newScope(scope, 'fork'), cond);
        const mk = mainCommandKey(m, el);
        const ex = m.execs.slice(before).find((x) => x.nodeKey === mk) || null;
        if (ex && prev && readsScriptFromStdin(ex)) {
          const text = prev.verb === 'echo' || prev.verb === 'printf'
            ? printedText(prev)
            : (prev.heredocRaw || prev.herestringRaw || null);
          // 上游印的是下游殼的腳本：已另外當內層指令解析，上游本身不再拿來比對（否則會拿上游的環境去判腳本裡的指令）
          if (text) { nested(m, 'bash', text, ex, 'exec'); prev.scriptForShell = true; }
        }
        prev = ex;
      }
      return;
    }
    case 'negated_command':
      for (let i = 0; i < node.namedChildCount; i++) walk(m, node.namedChild(i), scope, cond);
      return;
    case 'function_definition': {
      // 定義當下不執行，但同一串裡多半接著呼叫它（`deploy() { kubectl apply …; }; deploy`）：本體一律當成會執行（保守），
      // 走在同一個範圍、另開條件區段——裡面的設定對其他指令算「可能發生過」，裡面指令的環境值也另行從嚴
      const body = node.childForFieldName('body');
      m.unsureDepth++;
      try { walk(m, body, scope, m.newCond(cond)); } finally { m.unsureDepth--; }
      return;
    }
    case 'redirected_statement': {
      const body = node.childForFieldName('body');
      const redirects = [];
      for (let i = 0; i < node.childCount; i++) if (node.fieldNameForChild(i) === 'redirect') redirects.push(node.child(i));
      // 重導向目標裡的命令替換／行程替換會真的執行（`> "$(…)"`、`< <(…)`、`done < <(…)`）
      for (const r of redirects) collectSubs(m, r, scope, cond);
      walkCommandLike(m, body, scope, cond, redirects);
      return;
    }
    case 'command': case 'declaration_command': case 'unset_command': case 'variable_assignment': case 'variable_assignments': case 'test_command':
      walkCommandLike(m, node, scope, cond, []);
      return;
    default:
      collectSubs(m, node, scope, cond);
  }
}

function walkCommandLike(m, node, scope, cond, redirects) {
  const pipeInfo = currentPipe(node);
  if (!node) return;
  if (node.type === 'redirected_statement' || node.type === 'subshell' || node.type === 'compound_statement' || node.type === 'list' ||
      node.type === 'pipeline' || /_statement$/.test(node.type)) {
    walk(m, node, scope, cond);
  } else if (node.type === 'variable_assignment' || node.type === 'variable_assignments') {
    // 只有賦值、沒有指令＝設 shell 變數
    const list = node.type === 'variable_assignment' ? [node] : namedKids(node).filter((c) => c.type === 'variable_assignment');
    for (const a of list) {
      const val = a.childForFieldName('value');
      collectSubs(m, val, scope, cond);
      // `X[0]=v`：X 變成陣列（陣列不會匯出給子程序），值怎麼變不逐一模擬，判成無法確認
      if (isSubscript(a)) { m.event({ type: 'maybe', scope, cond, name: baseVar(a.text) }); continue; }
      m.event({ type: 'assign', scope, cond, name: a.childForFieldName('name').text, value: (isAppend(a) ? V_APPEND : '') + valueOf(val), exportIt: false });
    }
  } else if (node.type === 'declaration_command' || node.type === 'unset_command') {
    // export／declare／local／readonly／typeset／unset：引數一律照值的表示法轉換（`unset "X"`、`export 'X'=v`、`export "X=v"`
    // 的名字加了引號，語法樹給的是字串節點）再交給 emitBuiltin；名字含展開、看不出寫到哪個變數時，全部變數判成無法確認
    const kw = node.type === 'unset_command' ? 'unset' : (node.child(0) ? node.child(0).type : '');
    const kids = namedKids(node);
    for (const c of kids) collectSubs(m, c.type === 'variable_assignment' ? c.childForFieldName('value') : c, scope, cond);
    emitBuiltin(m, kw, argsForBuiltin(kids), scope, cond);
  } else if (node.type === 'command') {
    addCommand(m, node, scope, cond, redirects, pipeInfo);
  } else {
    collectSubs(m, node, scope, cond);
  }
}
function namedKids(n) { const a = []; for (let i = 0; i < n.namedChildCount; i++) a.push(n.namedChild(i)); return a; }

// 管線資訊：看父節點是不是 pipeline
function currentPipe(node) {
  let p = node && node.parent;
  let child = node;
  while (p && p.type === 'redirected_statement') { child = p; p = p.parent; }
  if (!p || p.type !== 'pipeline') return null;
  const kids = namedKids(p);
  return { pipeNodeId: p.id, pipeIndex: kids.findIndex((k) => k.id === child.id), pipeLen: kids.length };
}

// 一個 command 節點：前綴賦值、指令名、引數、重導向；其中的命令替換、殼包裝、find -exec／xargs 另外遞迴
function addCommand(m, node, scope, cond, redirects, pipeInfo) {
  const key = nodeKey(m, node);
  if (m.seen.has(key)) return;
  m.seen.add(key);
  const assigns = [];
  const words = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c.isNamed) continue;
    const field = node.fieldNameForChild(i);
    if (c.type === 'variable_assignment') assigns.push(c);
    else if (field === 'name' || field === 'argument') {
      const target = c.type === 'command_name' ? c.namedChild(0) || c : c;
      words.push({ node: target, ...wordInfo(target) });
    } else if (c.type === 'file_redirect' || c.type === 'heredoc_redirect' || c.type === 'herestring_redirect') redirects = redirects.concat([c]);
  }
  // 引數、賦值值、重導向裡的命令替換：在「這條指令執行之前」於 fork 子殼裡跑
  for (const a of assigns) collectSubs(m, a.childForFieldName('value'), scope, cond);
  for (const w of words) collectSubs(m, w.node, scope, cond);
  for (const r of redirects) collectSubs(m, r, scope, cond);
  const prefix = assigns.map((a) => ({ name: baseVar(a.childForFieldName('name').text), value: isSubscript(a) ? V_OPAQUE : (isAppend(a) ? V_APPEND : '') + valueOf(a.childForFieldName('value')) }));
  if (!words.length) {
    // 只有賦值（X=1）——已在 walkCommandLike 處理 variable_assignment；這裡是 command 節點只有前綴的少見形狀
    for (const p of prefix) m.event({ type: 'assign', scope, cond, name: p.name, value: p.value, exportIt: false });
    return;
  }
  const argv = words.map((w) => w.value);
  const rp = runnerPrefix(argv);
  const realArgv = argv.slice(rp.skip);
  const realWords = words.slice(rp.skip);
  // env／sudo 的 X=v：值照表示法轉換（`env X="$X" cmd` 要照當下的值展開，不是字面的 "$X"）
  for (const op of rp.envOps) {
    if (op.type !== 'set' || op.idx === undefined || !words[op.idx]) continue;
    const aw = assignWord(words[op.idx].node);
    op.value = aw ? aw.value : V_OPAQUE;
  }
  const verb = baseName(realArgv[0]);
  const exec = {
    index: m.execs.length, verb, argv: realArgv, fullArgv: argv, words: realWords, allWords: words, scope, cond,
    prefix, envOps: rp.envOps, seq: m.seq++, raw: node.text, redirects,
    pipe: pipeInfo, mention: false, feeds: false, nodeKey: key, envUnsure: m.unsureDepth > 0, loops: m.loopStack.slice(),
  };
  exec.mention = MENTION_VERBS.has(verb) && !(verb === 'find' && realArgv.some((a) => /^-(?:exec|execdir|ok|okdir|delete)$/.test(a)));
  m.execs.push(exec);
  // tree-sitter 只把「直接寫」的 export／unset／declare 解析成專屬節點；`command export X=v`、`builtin unset X`、
  // `! unset X` 會落成一般指令——照引數補發設定事件
  if (argv.slice(0, rp.skip).every((a) => a === 'command' || a === 'builtin' || a === '-p') &&
      /^(?:export|unset|declare|typeset|readonly|local)$/.test(verb)) emitBuiltin(m, verb, argsForBuiltin(realWords.slice(1).map((w) => w.node)), scope, cond);
  // 指令名本身是展開（`c=unset; $c X`、`$e unset X`）：做什麼看不出來，引數裡出現的變數名判成無法確認
  if (realWords[0] && /[$`]/.test(realWords[0].node.text)) {
    for (const a of realArgv.slice(1)) { const r = /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(a); if (r) m.event({ type: 'maybe', scope, cond, name: r[1] }); }
  }
  // source／. 在目前的 shell 裡執行環境檔：記成事件（實際讀檔在 envAt 時做，才能跟 cd 的位置對上）
  if ((verb === 'source' || verb === '.') && realArgv[1]) {
    // 來源不是字面檔案（`source <(…)`、`. /dev/stdin`、`source $F`）：讀不到內容，所有變數判成無法確認
    const w = realWords[1];
    const literal = w && !/(?:substitution|expansion|simple_expansion)/.test(w.node.type) && !/[$`]/.test(w.node.text) && !/^\/dev\//.test(realArgv[1]);
    if (literal) m.event({ type: 'source', scope, cond, file: realArgv[1], execIndex: exec.index });
    else m.event({ type: 'maybe', scope, cond, name: '*' });
  }
  // eval：引數組成的字串在目前的殼執行——字面時照內層指令解析（一定會跑、同一個範圍），含展開時所有變數判成無法確認
  if (verb === 'eval' && realArgv.length > 1) {
    if (realWords.slice(1).some((w) => /[$`]/.test(w.node.text) && !/^'/.test(w.node.text))) m.event({ type: 'maybe', scope, cond, name: '*' });
    walkText(m, 'bash', realArgv.slice(1).join(' '), scope, cond);
    // 內層已照實際位置與環境判過；eval 自己這一行不再拿整段字串（與設定前的環境）重判
    exec.scriptForShell = true;
  }
  varWriters(m, verb, realArgv, realWords, scope, cond);
  if (verb === 'cd' || verb === 'pushd' || verb === 'popd' || verb === 'set-location' || verb === 'sl' || verb === 'chdir') {
    m.event({ type: 'cd', scope, cond, verb, target: realArgv[1] });
  }
  if (verb === 'set' && /^[-+]a$/.test(realArgv[1] || '')) m.event({ type: 'allexport', scope, cond, on: realArgv[1] === '-a' });
  // cmd /c 叫起的範圍裡，set X=v 是設環境變數（bash 的 set 是位置參數、PowerShell 的 set 是 Set-Variable，都不算）
  if (verb === 'set' && isCmdScope(m, scope) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(realArgv[1] || '')) {
    const k = realArgv[1].indexOf('=');
    // cmd 的 %VAR% 是展開，值看不出來
    const v = realArgv[1].slice(k + 1);
    m.event({ type: 'assign', scope, cond, name: realArgv[1].slice(0, k), value: /%[^%\s]+%/.test(v) ? V_OPAQUE : v, exportIt: true });
  }
  if (verb === 'remove-item' || verb === 'ri') {
    for (const x of realArgv.slice(1)) { const r = /^env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(x); if (r) m.event({ type: 'unset', scope, cond, name: r[1] }); }
  }
  if (verb === 'set' && /^[-+]o$/.test(realArgv[1] || '') && realArgv[2] === 'allexport') m.event({ type: 'allexport', scope, cond, on: realArgv[1] === '-o' });
  // heredoc：由 shell 開啟的主體就是指令
  for (const r of redirects) {
    if (r.type !== 'heredoc_redirect') continue;
    const body = namedKids(r).find((c) => c.type === 'heredoc_body');
    if (!body) continue;
    // `cat <<EOF | bash`：語法樹把「| bash」掛在 heredoc 底下；接回成同一條管線，下游若是讀 stdin 的殼，主體就是它的腳本
    const downstream = namedKids(r).filter((c) => !/^heredoc_(?:start|body|end)$/.test(c.type));
    const fed = downstream.length ? linkDownstream(m, exec, downstream, body.text, scope, cond, r) : false;
    if (BASH_SHELLS.has(verb)) { nested(m, 'bash', body.text, exec, 'exec'); continue; }
    if (fed) { exec.scriptForShell = true; exec.heredocRaw = body.text; collectSubs(m, body, scope, cond); continue; }
    // 其他程式開啟的主體是它的輸入：併進比對文字（psql <<EOF 的 SQL 要讓規則看得到）；加引號的主體語法樹不會有命令替換
    exec.heredoc = (exec.heredoc ? exec.heredoc + ' ' : '') + body.text.replace(/[;&|'"#\r\n]+/g, ' ').trim();
    exec.heredocRaw = body.text;
    collectSubs(m, body, scope, cond);
  }
  // here-string（<<<）：讀 stdin 的殼把它當腳本（`bash <<< 'git push'`），其他程式把它當輸入（`psql <<< "DROP …"`）
  for (const r of redirects) {
    if (r.type !== 'herestring_redirect') continue;
    const content = namedKids(r)[0];
    const text = content ? wordInfo(content).value : '';
    if (readsScriptFromStdin(exec)) { nested(m, 'bash', text, exec, 'exec'); continue; }
    exec.heredoc = (exec.heredoc ? exec.heredoc + ' ' : '') + text.replace(/[;&|'"#\r\n]+/g, ' ').trim();
    exec.herestringRaw = text;
  }
  // 殼包裝：bash -c '…'（一個詞）、cmd /c …（整串）、powershell -Command …（整串）
  const inner = shellInner(verb, realArgv);
  if (inner) nested(m, inner.lang, inner.text, exec, 'exec');
  // 其他會把字串當指令跑的程式：su -c、script -c、watch（新程序）；trap（在目前的殼、何時觸發看不出來）
  if (verb === 'su') {
    const k = realArgv.findIndex((a, j) => j > 0 && (a === '-c' || a === '--command'));
    if (k > 0 && realArgv[k + 1] !== undefined) nested(m, 'bash', realArgv[k + 1], exec, 'exec');
    else { const c = realArgv.find((a) => a.startsWith('--command=')); if (c) nested(m, 'bash', c.slice(10), exec, 'exec'); }
  } else if (verb === 'script') {
    const k = realArgv.findIndex((a, j) => j > 0 && /^-[A-Za-z]*c$/.test(a));
    if (k > 0 && realArgv[k + 1] !== undefined) nested(m, 'bash', realArgv[k + 1], exec, 'exec');
  } else if (verb === 'watch') {
    let k = 1;
    while (k < realArgv.length && realArgv[k].startsWith('-')) k += /^-[nd]$|^--(?:interval|differences)$/.test(realArgv[k]) ? 2 : 1;
    if (k < realArgv.length) nested(m, 'bash', realArgv.slice(k).join(' '), exec, 'exec');
  } else if (verb === 'trap' && realArgv[1] !== undefined && !/^-/.test(realArgv[1])) {
    m.unsureDepth++;
    try { walkText(m, 'bash', realArgv[1], scope, m.newCond(cond)); } finally { m.unsureDepth--; }
  }
  // find -exec／xargs：後面接的指令由它們叫起（新程序）
  if (verb === 'find') {
    for (let k = 1; k < realArgv.length; k++) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(realArgv[k])) continue;
      let e = k + 1;
      while (e < realArgv.length && realArgv[e] !== ';' && realArgv[e] !== '+') e++;
      const sub = realArgv.slice(k + 1, e).filter((a) => a !== '{}');
      if (sub.length) nestedArgv(m, sub, exec);
      // 拆出去的指令另成一行判；這一行只留 find 自己的部分，否則會拿外層的環境去判內層指令
      for (let h = k + 1; h <= e && h < realArgv.length; h++) (exec.hidden = exec.hidden || new Set()).add(h);
      k = e;
    }
  } else if (verb === 'xargs') {
    let k = 1;
    while (k < realArgv.length && realArgv[k].startsWith('-')) k += /^-[nILPdEsa]$/.test(realArgv[k]) ? 2 : 1;
    const sub = realArgv.slice(k);
    if (sub.length) nestedArgv(m, sub, exec);
    for (let h = k; h < realArgv.length; h++) (exec.hidden = exec.hidden || new Set()).add(h);
  }
}

// 把一段文字當成新程序裡的腳本解析（bash -c、cmd /c、powershell -Command、bash <<EOF）
function nested(m, lang, text, parentExec, kind) {
  // PowerShell 文法沒載入（原生檔 ABI 不合等）：內層看不到，整串交給正則路徑，不能靜默丟掉
  if (lang === 'powershell' && !parsers().powershell) { m.hasError = true; return; }
  const s = m.newScope(parentExec.scope, kind);
  m.scopeEntry = m.scopeEntry || {};
  m.scopeEntry[s] = parentExec.index;          // 進入時要套上這個父指令的前綴與 env 選項
  // cmd 的語法在簡單指令層與 bash 相容（空白分詞、&& || | 串接），用 bash 語法樹解析，另外標記 cmd 脈絡
  if (lang === 'cmd') { (m.cmdScopes = m.cmdScopes || new Set()).add(s); lang = 'bash'; }
  walkText(m, lang, text, s, parentExec.cond);
}
// find -exec／xargs 的指令：以引數陣列直接建一個 exec（這裡沒有 shell 在解析，不需要再過語法樹）
function nestedArgv(m, argv, parentExec) {
  const s = m.newScope(parentExec.scope, 'exec');
  m.scopeEntry = m.scopeEntry || {};
  m.scopeEntry[s] = parentExec.index;
  const text = argv.map((a) => (/\s/.test(a) ? "'" + a + "'" : a)).join(' ');
  walkText(m, 'bash', text, s, parentExec.cond);
}

// 這個範圍（或它的祖先）是不是 cmd /c 叫起的
function isCmdScope(m, scope) {
  if (!m.cmdScopes) return false;
  for (const c of m.cmdScopes) if (scope === c || scope.startsWith(c + '/')) return true;
  return false;
}

// 任意節點底下的命令替換／行程替換：在 fork 子殼裡跑
function collectSubs(m, node, scope, cond) {
  if (!node) return;
  if (node.type === 'command_substitution' || node.type === 'process_substitution') {
    const s = m.newScope(scope, 'fork');
    for (let i = 0; i < node.namedChildCount; i++) walk(m, node.namedChild(i), s, cond);
    return;
  }
  for (let i = 0; i < node.namedChildCount; i++) collectSubs(m, node.namedChild(i), scope, cond);
}

// ── PowerShell 語法樹 → 執行清單＋設定事件（範圍較 bash 小：指令、管線、$env:、Remove-Item Env:、包裝）──
function walkPs(m, node, scope, cond) {
  if (!node) return;
  const t = node.type;
  if (t === 'pipeline_chain') {
    // 管線裡不是指令的元素（字串、here-string、運算式）是下一個指令的輸入：`'TRUNCATE orders' | psql` 的 SQL 要讓規則看得到，
    // `"git push" | bash`、`'…' | powershell` 的字串是那個殼的腳本
    let pending = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const el = node.namedChild(i);
      if (el.type !== 'command') { walkPs(m, el, scope, cond); pending = psLiteralText(el); continue; }
      const before = m.execs.length;
      walkPs(m, el, scope, cond);
      const ex = m.execs.slice(before).find((x) => x.nodeKey === nodeKey(m, el));
      if (ex && pending !== null) {
        if (readsScriptFromStdin(ex)) nested(m, 'bash', pending, ex, 'exec');
        else if ((ex.verb === 'powershell' || ex.verb === 'pwsh') && !ex.argv.slice(1).some((a) => /^-(?:c|command|f|file|encodedcommand|e|ec)$/i.test(a))) nested(m, 'powershell', pending, ex, 'exec');
        else ex.heredoc = (ex.heredoc ? ex.heredoc + ' ' : '') + pending.replace(/[;&|'"#\r\n]+/g, ' ').trim();
      }
      pending = null;
    }
    return;
  }
  if (t === 'assignment_expression') {
    const left = node.child(0) ? node.child(0).text : '';
    const mm = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(left.trim());
    const right = node.childForFieldName('value') || node.namedChild(node.namedChildCount - 1);
    if (mm) {
      const rv = right ? right.text.trim() : '';
      const q = /^(['"])([\s\S]*)\1$/.exec(rv);
      if (/^\$null$/i.test(rv)) m.event({ type: 'unset', scope, cond, name: mm[1] });
      else m.event({ type: 'assign', scope, cond, name: mm[1], value: q ? q[2] : rv, exportIt: true });
    }
    if (right) walkPs(m, right, scope, cond);
    return;
  }
  if (t === 'command') {
    const key = nodeKey(m, node);
    if (m.seen.has(key)) return;
    m.seen.add(key);
    const nameNode = node.childForFieldName('command_name');
    const elems = node.childForFieldName('command_elements');
    const words = [];
    if (nameNode) words.push({ node: nameNode, value: psValue(nameNode), quoted: /^['"]/.test(nameNode.text) });
    if (elems) for (let i = 0; i < elems.namedChildCount; i++) {
      const e = elems.namedChild(i);
      if (e.type === 'command_argument_sep') continue;
      words.push({ node: e, value: psValue(e), quoted: /^['"]/.test(e.text.trim()) });
    }
    if (!words.length) { for (let i = 0; i < node.namedChildCount; i++) walkPs(m, node.namedChild(i), scope, cond); return; }
    const argv = words.map((w) => w.value);
    const verb = baseName(argv[0]);
    const exec = { index: m.execs.length, verb, argv, fullArgv: argv, words, allWords: words, scope, cond, prefix: [], envOps: [],
      seq: m.seq++, raw: node.text, redirects: [], pipe: psPipe(node), mention: MENTION_VERBS.has(verb), feeds: false,
      nodeKey: key, envUnsure: m.unsureDepth > 0, loops: m.loopStack.slice() };
    m.execs.push(exec);
    if (verb === 'remove-item' || verb === 'del' || verb === 'rm' || verb === 'ri') {
      for (const a of argv.slice(1)) { const r = /^env:[\\/]?([A-Za-z_][A-Za-z0-9_]*)$/i.exec(a); if (r) m.event({ type: 'unset', scope, cond, name: r[1] }); }
    }
    if (verb === 'set-location' || verb === 'sl' || verb === 'cd' || verb === 'chdir') m.event({ type: 'cd', scope, cond, verb: 'cd', target: argv[1] });
    // 包裝：cmd /c、bash -c、powershell -Command、Start-Process -FilePath x -ArgumentList y
    const inner = shellInner(verb, argv);
    if (inner) nested(m, inner.lang, inner.text, exec, 'exec');
    if (verb === 'start-process' || verb === 'saps' || verb === 'start') {
      let file = null; const args = [];
      for (let k = 1; k < argv.length; k++) {
        const a = argv[k].toLowerCase();
        if (/^-(?:f|fi|fil|file|filep|filepa|filepat|filepath|pspath|path)$/.test(a)) { file = argv[++k]; continue; }
        if (/^-(?:a|ar|arg|args|argu|argum|argume|argumen|argument|argumentl|argumentli|argumentlis|argumentlist)$/.test(a)) { args.push(argv[++k]); continue; }
        if (/^-(?:wo|workingdirectory|wi|windowstyle|verb|v|credential|redirectstandard\w+|rs[eio]|environment|ea|erroraction|ev|errorvariable|wa|warningaction|wv|warningvariable|ov|outvariable|ob|outbuffer|pv|pipelinevariable|infa|informationaction|iv|informationvariable)$/.test(a)) { k++; continue; }
        if (a.startsWith('-')) continue;
        if (file === null) file = argv[k]; else args.push(argv[k]);
      }
      if (file) nestedArgv(m, [file].concat(args.join(' ').split(/[\s,]+/).filter(Boolean)), exec);
    }
    for (const w of words) walkPs(m, w.node, scope, cond);
    return;
  }
  if (t === 'script_block_expression' || t === 'sub_expression') {
    const s = m.newScope(scope, 'fork');
    for (let i = 0; i < node.namedChildCount; i++) walkPs(m, node.namedChild(i), s, cond);
    return;
  }
  for (let i = 0; i < node.namedChildCount; i++) walkPs(m, node.namedChild(i), scope, cond);
}
function psValue(n) {
  const s = n.text.trim();
  const q = /^(['"])([\s\S]*)\1$/.exec(s);
  return q ? q[2] : s;
}
function psPipe(node) {
  let p = node.parent;
  while (p && p.type !== 'pipeline' && p.type !== 'pipeline_chain') p = p.parent;
  if (!p) return null;
  const cmds = [];
  (function coll(n) { if (n.type === 'command') { cmds.push(n.id); return; } for (let i = 0; i < n.namedChildCount; i++) coll(n.namedChild(i)); })(p);
  if (cmds.length < 2) return null;
  return { pipeNodeId: p.id, pipeIndex: cmds.indexOf(node.id), pipeLen: cmds.length };
}

// ── 比對文字：每條管線一行、一般程式的引號內容遮掉（與舊引擎相同的判準）─────
function buildLines(m) {
  const byPipe = new Map();
  const order = [];
  for (const e of m.execs) {
    const key = e.pipe ? 'p' + e.pipe.pipeNodeId : 'e' + e.index;
    if (!byPipe.has(key)) { byPipe.set(key, []); order.push(key); }
    byPipe.get(key).push(e);
  }
  const lines = [];
  for (const key of order) {
    const group = byPipe.get(key).sort((a, b) => (a.pipe && b.pipe ? a.pipe.pipeIndex - b.pipe.pipeIndex : a.index - b.index));
    // 只印字的段落，若管線接給會執行的指令，它就是輸入來源、整段照算（`echo "DROP …" | psql`）
    for (let k = group.length - 1; k >= 0; k--) {
      const next = group[k + 1];
      group[k].feeds = !!(next && !next.dropped);
      group[k].dropped = (group[k].mention && !group[k].feeds) || !!group[k].scriptForShell;
    }
    const kept = group.filter((e) => !e.dropped);
    if (!kept.length) continue;
    const render = (e, maskIt) => {
      const pre = e.prefix.map((p) => p.name + '=' + p.value).concat(e.fullArgv.slice(0, e.fullArgv.length - e.argv.length)).join(' ');
      const body = e.words.map((w, k) => (e.hidden && e.hidden.has(k) ? null : (k === 0 || !maskIt || !w.quoted ? w.value : '""')))
        .filter((x) => x !== null).join(' ');
      return (pre ? pre + ' ' : '') + body + (e.heredoc ? ' ' + e.heredoc : '');
    };
    const masked = kept.map((e) => render(e, !(e.feeds || evaluatesQuoted(e.verb, e.argv.slice(1))))).join(' | ');
    const raw = kept.map((e) => render(e, false)).join(' | ');
    lines.push({ raw, masked, execs: kept.map((e) => e.index), parts: kept.map((e) => ({ exec: e.index, masked: render(e, !(e.feeds || evaluatesQuoted(e.verb, e.argv.slice(1)))), raw: render(e, false) })) });
  }
  return lines;
}

// ── 環境值：第 i 個執行實際拿到的變數值 ─────────────────────────────────────
// 依 bash 語意模擬：事件依發生順序套用，只採計「範圍看得到、條件一定成立」的事件。
//   · 範圍看得到：事件的範圍是執行範圍的祖先（或相同）。子殼裡的設定不回到外層。
//   · 進入 'exec' 範圍（新程序）時，未匯出的變數消失，並套上叫起它的那個指令的前綴與 env 選項。
//   · 條件：事件的條件區段必須是執行的條件區段的前綴（`false && export X; cmd` 的 export 不算給 cmd）。
//   · 本條指令自己的前綴賦值、env 選項最後套用（賦值直接進這個程序的環境）。
//   · node --env-file：Node 不覆蓋已存在的變數，只補還沒有的；只有寫在腳本名之前才算。
function makeEnvAt(m, startDir, root, inherited) {
  const scopeVisible = (ev, e) => e.scope === ev.scope || e.scope.startsWith(ev.scope + '/');
  const condVisible = (ev, e) => e.cond === ev.cond || e.cond.startsWith(ev.cond + '/');
  // 「可能發生過」：範圍看得到、發生在它之前，但只在條件成立時才會執行（if／&&／||／迴圈／函式本體）
  const maybe = (ev, e) => ev.seq < e.seq && scopeVisible(ev, e) && !condVisible(ev, e);
  // 迴圈回邊：同一個迴圈裡、排在它後面的設定，下一輪會落在它之前
  const loopLater = (ev, e) => ev.seq > e.seq && scopeVisible(ev, e) && (ev.loops || []).some((l) => (e.loops || []).includes(l));
  const cwdAt = (e) => {
    // 目前目錄：套用同範圍鏈上、在它之前、一定會執行的 cd；有「可能發生過」的 cd 就標成不確定
    let dir = null; const stack = []; let unsure = false;
    for (const ev of m.events) {
      if (ev.type !== 'cd') continue;
      if (loopLater(ev, e) || (ev.anytime && scopeVisible(ev, e))) { unsure = true; continue; }
      if (ev.seq > e.seq) break;
      if (maybe(ev, e)) { unsure = true; continue; }
      if (!scopeVisible(ev, e) || !condVisible(ev, e)) continue;
      if (ev.verb === 'popd') { dir = stack.length ? stack.pop() : null; continue; }
      if (ev.verb === 'pushd') stack.push(dir);
      let t = ev.target;
      if (!t || t === '-' || /^~|[$%]/.test(t)) { dir = root; continue; }
      if (process.platform === 'win32') t = t.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
      dir = path.resolve(dir === null ? startDir : dir, t);
    }
    return { dirs: dir === null ? [startDir, root] : [dir], unsure };
  };
  const readEnvFile = (file, bases) => {
    for (const base of bases) {
      try { return fs.readFileSync(path.resolve(base, file), 'utf8'); } catch (_) { /* 換下一個候選位置 */ }
    }
    return null;
  };
  const fileMentions = (body, name) => new RegExp('(^|[\\s;])(?:export\\s+)?' + name + '\\s*=', 'm').test(body);
  const sourceEvents = new Map();   // 環境檔解析一次就好
  // 環境檔裡、落在目前這個殼的事件（子殼裡的不影響），照檔內順序；條件區段、巢狀 source 在套用時處理
  const eventsOfFile = (body) => {
    if (!sourceEvents.has(body)) {
      const sub = new Model(startDir, root);
      walk(sub, parse('bash', body).rootNode, '', '');
      sourceEvents.set(body, sub.events.filter((se) => se.scope === ''));
    }
    return sourceEvents.get(body);
  };
  const MAX_STATES = 64;

  // 「未知」也是一種值：看不到內容的寫入（eval 展開、read、source <(…)……）把值設成 OPAQUE，
  // 看不出何時發生的設定（函式本體內指令、切目錄可能發生過時讀到的環境檔）設成 COND。
  // 未知值會跟著同名展開傳下去（`X="$X" cmd` 仍是未知），只有字面值能蓋掉它（`X=local cmd`、父指令的 `X=local bash -c …`）。
  const OPAQUE = '\u0000opaque';
  const COND = '\u0000cond';
  const unknown = (v) => v === OPAQUE || v === COND;
  const compute = (i, name) => {
    const e = m.execs[i];
    let overflow = false;
    // 狀態＝{ val：值, exp：是否匯出, ax：set -a 是否開著 }；「可能發生過」的設定讓狀態一分為二（有發生／沒發生）
    const inh = inherited(name);
    let states = [{ val: inh, exp: inh !== undefined, ax: false }];
    // 函式本體與兜底補收的指令：看不出何時執行，同一串裡碰到這個變數的設定可能落在它之前——多一個「未知」的可能
    const relevant = (ev) => ((ev.type === 'assign' || ev.type === 'export' || ev.type === 'unexport' || ev.type === 'unset') && ev.name === name) ||
      ev.type === 'allexport' || ev.type === 'source' || (ev.type === 'maybe' && (ev.name === name || ev.name === '*'));
    if (e.envUnsure && m.events.some((ev) => scopeVisible(ev, e) && relevant(ev))) states.push({ val: COND, exp: true, ax: false });
    const key = (s) => JSON.stringify([s.val === undefined ? null : s.val, s.val === undefined, s.exp, s.ax]);
    const dedup = (list) => { const seen = new Set(); return list.filter((s) => { const k = key(s); if (seen.has(k)) return false; seen.add(k); return true; }); };
    // 值裡的同名展開：$X、${X}、${X:-預設}、${X-預設}、${X:=預設}（`export APP_ENV=${APP_ENV:-local}`）；目前值未知時結果也未知
    // 值的表示法（見 V_REF）：字面值照原樣；同名展開照當下的值展開（未知仍是未知）；
    // 其他變數的展開：這串指令完全沒碰過那個變數時照繼承值展開（`${NODE_ENV:-local}`），碰過就看不出值；`X+=v` 接在後面
    // 「碰過」包含設定事件，也包含任何指令的前綴與 env 選項（`NODE_ENV=production APP_ENV=${NODE_ENV:-local} cmd`）
    const otherTouched = (o) => m.events.some((ev) => ev.name === o || ev.name === '*' || ev.type === 'source') ||
      m.execs.some((x) => (x.prefix || []).some((p) => p.name === o) || (x.envOps || []).some((op) => op.name === o || op.type === 'clear'));
    const resolve = (v, st) => {
      if (typeof v !== 'string') return v;
      if (v.startsWith(V_APPEND)) {
        const add = resolve(v.slice(V_APPEND.length), st);
        if (unknown(add)) return add;
        if (unknown(st.val)) return st.val;
        return (st.val === undefined ? '' : st.val) + add;
      }
      if (!v.startsWith(V_REF)) return v;
      const p = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)([-=])([^}]*))?\})$/.exec(v.slice(V_REF.length));
      if (!p) return OPAQUE;
      const nm = p[1] || p[2];
      let cur;
      if (nm === name) cur = st.val;
      else if (otherTouched(nm)) return OPAQUE;
      else cur = inherited(nm);
      if (unknown(cur)) return cur;
      if (p[4] === undefined) return cur === undefined ? '' : cur;
      return (cur === undefined || (p[3] && cur === '')) ? p[5] : cur;
    };
    const step = (st, ev) => {
      const s = { val: st.val, exp: st.exp, ax: st.ax };
      if (ev.type === 'assign') {
        s.val = resolve(ev.value, st);
        if (ev.unexport) s.exp = false;
        else if (ev.exportIt || s.ax) s.exp = true;
      } else if (ev.type === 'export') s.exp = true;
      else if (ev.type === 'unexport') s.exp = false;
      else if (ev.type === 'unset') { s.val = undefined; s.exp = false; }
      else if (ev.type === 'allexport') s.ax = ev.on;
      else if (ev.type === 'maybe') { s.val = OPAQUE; s.exp = true; }
      return s;
    };
    // 一個事件套到全部狀態。source 照檔內順序逐一套：一定會執行的照套、條件區段裡的分成有發生／沒發生，
    // 巢狀 source 在它出現的位置設成未知——所以檔內後面的字面寫入蓋得掉前面的未知
    const applyEv = (list, ev) => {
      if (ev.type !== 'source') return list.map((st) => step(st, ev));
      const w = cwdAt(m.execs[ev.execIndex]);
      const body = readEnvFile(ev.file, w.dirs);
      if (body === null) return list;
      let cur = list;
      for (const se of eventsOfFile(body)) {
        if (se.type === 'source') { cur = dedup(cur.map((st) => ({ val: OPAQUE, exp: true, ax: st.ax }))); continue; }
        if (!relevant(se)) continue;
        cur = se.cond === '' ? dedup(cur.map((st) => step(st, se))) : dedup(cur.concat(cur.map((st) => step(st, se))));
      }
      // 切目錄可能發生過：讀到的不一定是這一份
      if (w.unsure && fileMentions(body, name)) cur = dedup(cur.map((st) => ({ val: COND, exp: true, ax: st.ax })));
      return cur;
    };
    // ctx＝展開前綴時看到的殼狀態：前綴在叫起它的那個殼裡展開，看得到那裡還沒匯出的變數
    const applyOwn = (x, st, ctx) => {
      // 照實際順序：殼先把前綴放進那個程式的環境，env／sudo 再依序套自己的選項（`X=v env -u X cmd` 的 cmd 沒有 X）
      const s = { val: st.val, exp: st.exp, ax: st.ax };
      // 前綴由左到右依序展開、依序生效：`X=prod X="$X" cmd` 的第二個 $X 拿到的是 prod
      let cur = ctx || st;
      for (const p of x.prefix || []) if (p.name === name) { s.val = resolve(p.value, cur); s.exp = true; cur = { val: s.val }; }
      // env／sudo 的引數在前綴生效之前就展開好了（`X=local env X="$X" cmd` 拿到的是原本的值），所以照原本的狀態展開
      for (const op of x.envOps || []) {
        if (op.type === 'clear') { s.val = undefined; s.exp = false; }
        else if (op.type === 'unset' && op.name === name) { s.val = undefined; s.exp = false; }
        else if (op.type === 'set' && op.name === name) { s.val = resolve(op.value, ctx || st); s.exp = true; }
      }
      return s;
    };
    // 由外往內，逐層範圍：進入 exec 範圍（新程序）時丟掉未匯出值、set -a 不繼承，並套叫起者的前綴
    const chain = [];
    for (let s = e.scope; s; s = s.slice(0, s.lastIndexOf('/'))) chain.unshift(s);
    const enteredExec = new Set();
    const enter = (s) => {
      if (m.scopes[s] !== 'exec' || enteredExec.has(s)) return;
      enteredExec.add(s);
      const parent = m.scopeEntry && m.execs[m.scopeEntry[s]];
      states = dedup(states.map((st) => {
        const n = { val: st.exp ? st.val : undefined, exp: st.exp && st.val !== undefined, ax: false };
        // 父指令的前綴在外層殼展開（`X=prod; X=${X:-local} bash -c …` 帶進去的是 prod），所以用丟棄前的狀態展開
        return parent ? applyOwn(parent, n, st) : n;
      }));
    };
    const late = [];
    for (const ev of m.events) {
      if (!relevant(ev)) continue;
      // 不管先後都可能發生的設定：函式本體、兜底補收裡的（同一個區塊裡排在它前面的除外），以及迴圈回邊
      if (ev.anytime && scopeVisible(ev, e) && !(ev.scope === e.scope && ev.cond === e.cond && ev.seq < e.seq)) late.push(ev);
      else if (loopLater(ev, e)) late.push(ev);
    }
    for (const ev of m.events) {
      if (ev.seq > e.seq) break;
      for (const s of chain) if (ev.scope === s || ev.scope.startsWith(s + '/')) enter(s);
      if (!scopeVisible(ev, e) || !relevant(ev) || late.includes(ev)) continue;
      if (condVisible(ev, e)) states = dedup(applyEv(states, ev));
      else states = dedup(states.concat(applyEv(states, ev)));   // 可能發生過：有發生、沒發生兩種都算
      if (states.length > MAX_STATES) { overflow = true; break; }
    }
    for (const s of chain) enter(s);
    for (const ev of late) states = dedup(states.concat(applyEv(states, ev)));
    states = states.map((st) => applyOwn(e, st));
    // node --env-file：寫在腳本名之前才是 Node 的選項；只補不存在的變數
    let fromFile;
    if (e.verb === 'node') {
      const takesValue = /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|--env-file-if-exists|--inspect-port|-C|--conditions|--title|--input-type|--cpu-prof-dir|--cpu-prof-name|--heap-prof-dir|--heap-prof-name|--diagnostic-dir|--report-dir|--report-directory|--report-filename|--redirect-warnings|--openssl-config|--icu-data-dir|--trace-event-categories|--trace-event-file-pattern|--watch-path|--test-name-pattern|--test-reporter|--test-reporter-destination|--test-shard|--test-concurrency|--test-timeout)$/;
      const where = cwdAt(e);
      for (let k = 1; k < e.argv.length; k++) {
        const a = e.argv[k];
        if (!a.startsWith('-')) break;               // 腳本名之後的是給腳本的引數
        let file = null;
        if (a.startsWith('--env-file=')) file = a.slice(11);
        else if (a === '--env-file') file = e.argv[k + 1];
        if (file) {
          const body = readEnvFile(file, where.dirs);
          if (body !== null) for (const line of body.split(/\r?\n/)) {
            const r = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]*))/.exec(line);
            if (r && r[1] === name && !/^\s*#/.test(line)) fromFile = r[2] !== undefined ? r[2] : (r[3] !== undefined ? r[3] : r[4]);
          }
        }
        if (takesValue.test(a)) k++;
      }
      if (fromFile !== undefined && where.unsure) fromFile = COND;
    }
    const values = [];
    for (const st of states) {
      let v = st.exp && st.val !== undefined ? st.val : undefined;
      if (v === undefined && fromFile !== undefined) v = fromFile;
      if (!values.includes(v)) values.push(v);
    }
    const unsure = overflow || values.some(unknown);
    return { values: values.filter((v) => !unknown(v)), unsure, opaque: values.includes(OPAQUE) };
  };
  const cache = new Map();
  const get = (i, name) => {
    const k = i + '\u0000' + name;
    if (!cache.has(k)) cache.set(k, compute(i, name));
    return cache.get(k);
  };
  return {
    // envAt：只有一種可能值且確定時回傳它；envInfo：全部可能值（條件分支各算一種）與是否無法確認
    envAt: (i, name) => { const r = get(i, name); return !r.unsure && r.values.length === 1 ? r.values[0] : undefined; },
    envUnsure: (i, name) => get(i, name).unsure,
    envInfo: (i, name) => get(i, name),
  };
}

// 會寫進某個變數、但沒有逐一建模的內建指令：read、mapfile／readarray、getopts、printf -v、let——那個變數判成無法確認
function varWriters(m, verb, argv, words, scope, cond) {
  const at = [];      // 被寫入的變數名在 argv 的位置
  const fixed = [];   // 沒寫名字時的預設變數（REPLY、MAPFILE）
  if (verb === 'read') {
    for (let k = 1; k < argv.length; k++) {
      if (/^-[pdtnNuie]$/.test(argv[k])) { k++; continue; }
      if (argv[k] === '-a' && argv[k + 1] !== undefined) { at.push(++k); continue; }
      if (!argv[k].startsWith('-')) at.push(k);
    }
    if (!at.length) fixed.push('REPLY');
  } else if (verb === 'mapfile' || verb === 'readarray') {
    const rest = [];
    for (let k = 1; k < argv.length; k++) { if (/^-[dnOsuC c]$/.test(argv[k])) { k++; continue; } if (!argv[k].startsWith('-')) rest.push(k); }
    if (rest.length) at.push(rest[rest.length - 1]); else fixed.push('MAPFILE');
  } else if (verb === 'getopts' && argv[2] !== undefined) at.push(2);
  else if (verb === 'printf' && argv[1] === '-v' && argv[2] !== undefined) at.push(2);
  else if (verb === 'let') for (let k = 1; k < argv.length; k++) if (/^([A-Za-z_][A-Za-z0-9_]*|[$`])/.test(argv[k]) && /=/.test(argv[k])) at.push(k);
  for (const n of fixed) m.event({ type: 'maybe', scope, cond, name: n });
  for (const k of at) {
    // 名字本身是展開（`n=APP_ENV; read "$n"`）：寫到哪個變數看不出來，全部變數判成無法確認
    if (words[k] && /[$`]/.test(words[k].node.text) && words[k].node.type !== 'raw_string') { m.event({ type: 'maybe', scope, cond, name: '*' }); continue; }
    const r = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(argv[k]);
    if (r) m.event({ type: 'maybe', scope, cond, name: r[1] });
  }
}

// ── 走訪輔助 ────────────────────────────────────────────────────────────────
// 指令節點的識別：第幾棵樹＋位置（主指令與 bash -c 內層是不同的樹，位置會重疊）
function nodeKey(m, node) { return m.curTree + ':' + node.startIndex + ':' + node.endIndex; }

// 解析一段文字並走訪：錯誤節點記進 hasError；走訪完用不同的判準兜底掃一次
function walkText(m, lang, text, scope, cond) {
  const tree = parse(lang, text);
  if (tree.rootNode.hasError) m.hasError = true;
  const prev = m.curTree;
  m.curTree = ++m.treeSeq;
  try {
    if (lang === 'powershell') walkPs(m, tree.rootNode, scope, cond);
    else walk(m, tree.rootNode, scope, cond);
    sweep(m, tree.rootNode, scope, cond, lang);
  } finally {
    m.curTree = prev;
  }
}

// 兜底掃描（與走訪不同的判準）：語法樹上每一個指令節點都必須已經收進 execs。走訪沒建模到的位置若還有指令節點沒被收，
// 一律補收成「會執行」——同一個範圍、另開條件區段（它的設定對別人算「可能發生過」），環境值另行從嚴。
// 走訪建模得越完整，這裡補收得越少；它存在是為了讓「沒想到的寫法」落在多擋那一側，而不是整段消失。
function sweep(m, root, scope, cond, lang) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'command' && !m.seen.has(nodeKey(m, n))) {
      m.unsureDepth++;
      try {
        if (lang === 'powershell') walkPs(m, n, scope, m.newCond(cond));
        else walkCommandLike(m, n, scope, m.newCond(cond), []);
      } finally {
        m.unsureDepth--;
      }
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i));
  }
}

// list 節點裡某個元素前面的運算子（&& 或 ||）
function opBefore(list, kid) {
  let op = null;
  for (let i = 0; i < list.childCount; i++) {
    const c = list.child(i);
    if (c.startIndex >= kid.startIndex) break;
    if (!c.isNamed) op = c.type;
  }
  return op;
}

// 管線元素的主指令節點（剝掉重導向外殼）
function mainCommandKey(m, el) {
  let n = el;
  while (n && n.type === 'redirected_statement') n = n.childForFieldName('body');
  return n && n.type === 'command' ? nodeKey(m, n) : null;
}

// echo／printf 實際印出的文字：printf 照格式字串代入引數（引數多於轉換時重複套用格式、%b 展開引數裡的跳脫）；
// `echo -e` 與 printf 的格式字串會把 \n、\t 等跳脫序列展開（`printf 'kubectl %s -f prod.yaml\n' apply | sh`）
function printedText(e) {
  const args = e.argv.slice(1);
  if (e.verb === 'printf') {
    if (args[0] === '-v') return '';                  // 印進變數，不是 stdout
    if (args[0] === '--') args.shift();
    if (!args.length) return '';
    const fmt = expandEscapes(args[0]);
    const rest = args.slice(1);
    let out = '';
    for (let round = 0; round < 100; round++) {
      let used = 0;
      out += fmt.replace(/%(%|[-+ #0]*\d*(?:\.\d+)?([a-zA-Z]))/g, (all, p, conv) => {
        if (p === '%') return '%';
        used++;
        const a = rest.length ? rest.shift() : '';
        return conv === 'b' ? expandEscapes(a) : a;
      });
      if (!rest.length || !used) break;
    }
    return out;
  }
  const flags = [];
  while (args.length && /^-[neE]+$/.test(args[0])) flags.push(args.shift());
  const text = args.join(' ');
  return flags.some((f) => /e/.test(f)) ? expandEscapes(text) : text;
}
function expandEscapes(text) {
  return text.replace(/\\(n|t|r|\\|0?[0-7]{1,3}|x[0-9A-Fa-f]{1,2})/g, (all, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    if (c === '\\') return '\\';
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    return String.fromCharCode(parseInt(c, 8));
  });
}

// 殼包裝：這個殼要執行的內層腳本（依殼的種類認它自己的旗標；找第一個像旗標的會被 PowerShell 的 -exec 先命中）
//   bash 系：-c，可與其他短旗標合寫（-lc、-ec），大小寫有別（-C 是 noclobber）
//   cmd：/c、/k；Git Bash（MSYS）上要寫成 //c——單斜線會被當成路徑轉掉、內層不執行，兩種都認
//   PowerShell：-Command 的任何前綴縮寫（-c、-Com、-comm），前面可以是 -、-- 或 //，不分大小寫；
//     -EncodedCommand（-e、-ec、-enc…）base64 解碼後就是指令；powershell.exe 不帶旗標時第一個位置引數就是指令
//     （pwsh 的位置引數是腳本檔）；-File 的腳本檔內容看不到
const PS_CMD = /^(?:-{1,2}|\/{1,2})c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i;
const PS_ENC = /^(?:-{1,2}|\/{1,2})e(?:c|n[a-z]*)?$/i;
const PS_FILE = /^(?:-{1,2}|\/{1,2})(?:f|fi|fil|file)$/i;
// 會吃值的旗標，每個都認完整的前綴縮寫：ExecutionPolicy（-ex…、-ep）、WindowStyle（-w、-wi、-win…）、Version（-v、-ve…）、
// InputFormat（-i、-in、-inp…）、OutputFormat（-o、-ou、-out…）、PSConsoleFile、ConfigurationName、CustomPipeName、SettingsFile、WorkingDirectory
const PS_VALUED = /^(?:-{1,2}|\/{1,2})(?:ex\w*|ep|w(?:i(?:n\w*)?)?|v(?:e\w*)?|i(?:n(?:p\w*)?)?|o(?:u(?:t\w*)?)?|psc\w*|conf\w*|cus\w*|sett\w*|wd|workingd\w*)$/i;
function shellInner(verb, argv) {
  if (BASH_SHELLS.has(verb)) {
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return argv[k + 1] !== undefined ? { lang: 'bash', text: argv[k + 1] } : null;
      // -o／+o（set 選項）與 -O／+O（shopt 選項）後面都接一個值
      if (/^[-+][oO]$/.test(a) || /^--(?:rcfile|init-file)$/.test(a)) { k++; continue; }
      if (a === '--' || !/^[-+]/.test(a)) return null;   // 接下來是腳本檔
    }
    return null;
  }
  if (verb === 'cmd') {
    const k = argv.findIndex((a, j) => j > 0 && /^\/{1,2}[ck]$/i.test(a));
    return k > 0 ? { lang: 'cmd', text: argv.slice(k + 1).join(' ') } : null;
  }
  if (verb === 'powershell' || verb === 'pwsh') {
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (PS_CMD.test(a)) return { lang: 'powershell', text: argv.slice(k + 1).join(' ') };
      if (PS_ENC.test(a)) {
        const text = Buffer.from(argv[k + 1] || '', 'base64').toString('utf16le');
        return text ? { lang: 'powershell', text } : null;
      }
      if (PS_FILE.test(a)) return null;
      // 下一個詞不是旗標才當成它的值；pwsh 的 -i 是 -Interactive，不吃值（powershell.exe 的 -i 才是 InputFormat）
      if (PS_VALUED.test(a) && !(verb === 'pwsh' && /^(?:-{1,2}|\/{1,2})i$/i.test(a))) {
        if (argv[k + 1] !== undefined && !/^[-\/]/.test(argv[k + 1])) k++;
        continue;
      }
      if (/^(?:-{1,2}|\/{1,2})\w/.test(a)) continue;
      return verb === 'powershell' ? { lang: 'powershell', text: argv.slice(k).join(' ') } : null;
    }
  }
  return null;
}

// 讀 stdin 當腳本的殼：bash／sh 不帶 -c、不帶腳本檔（`bash`、`sh -s`、`bash -x`）
function readsScriptFromStdin(e) {
  if (!e || !BASH_SHELLS.has(e.verb)) return false;
  return e.argv.slice(1).every((a) => a.startsWith('-') && !/^-[A-Za-z]*c[A-Za-z]*$/.test(a));
}

// `cat <<EOF | bash`：把掛在 heredoc 底下的「| 下游」接回成同一條管線
function linkDownstream(m, first, downstream, scriptText, scope, cond, r) {
  const elems = downstream.length === 1 && downstream[0].type === 'pipeline' ? namedKids(downstream[0]) : downstream;
  const pid = 'h' + m.curTree + ':' + r.startIndex;
  const len = elems.length + 1;
  first.pipe = { pipeNodeId: pid, pipeIndex: 0, pipeLen: len };
  let fed = false;
  elems.forEach((el, k) => {
    const before = m.execs.length;
    walk(m, el, m.newScope(scope, 'fork'), cond);
    const mk = mainCommandKey(m, el);
    const ex = m.execs.slice(before).find((x) => x.nodeKey === mk);
    if (!ex) return;
    ex.pipe = { pipeNodeId: pid, pipeIndex: k + 1, pipeLen: len };
    if (k === 0 && scriptText && readsScriptFromStdin(ex)) { nested(m, 'bash', scriptText, ex, 'exec'); fed = true; }
  });
  return fed;   // true＝主體是下游殼的腳本
}

// export／unset／declare 以一般指令形式出現時（`command export X=v`、`! unset X`），照引數發設定事件
function emitBuiltin(m, verb, args, scope, cond) {
  if (args.includes(V_STAR)) m.event({ type: 'maybe', scope, cond, name: '*' });
  args = args.filter((a) => a !== V_STAR);
  if (verb === 'unset') {
    if (args.includes('-f')) return;
    for (const a of args) if (!a.startsWith('-')) m.event({ type: 'unset', scope, cond, name: a });
    return;
  }
  const flags = args.filter((a) => /^[-+]/.test(a)).join(' ');
  const exportIt = verb === 'export' || /(^|\s)-\w*x/.test(flags);
  const unexport = (verb === 'export' && /(^|\s)-\w*n/.test(flags)) || /(^|\s)\+\w*x/.test(flags);
  // declare -n r=X：之後對 r 的寫入都落在 X，看不出何時——X 判成無法確認
  const nameref = verb !== 'export' && /(^|\s)-\w*n/.test(flags);
  for (const a of args) {
    if (/^[-+]/.test(a)) continue;
    const k = a.indexOf('=');
    if (nameref) {
      const target = k > 0 ? a.slice(k + 1) : '';
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) { m.unsureDepth++; try { m.event({ type: 'maybe', scope, cond, name: target }); } finally { m.unsureDepth--; } }
      else if (k > 0) m.event({ type: 'maybe', scope, cond, name: '*' });
      continue;
    }
    if (k > 0 && /\[/.test(a.slice(0, k))) { m.event({ type: 'maybe', scope, cond, name: baseVar(a.slice(0, k)) }); continue; }
    if (k > 0) m.event({ type: 'assign', scope, cond, name: a.slice(0, k).replace(/\+$/, ''), value: (/\+$/.test(a.slice(0, k)) ? V_APPEND : '') + a.slice(k + 1), exportIt: exportIt && !unexport, unexport });
    else m.event({ type: unexport ? 'unexport' : (exportIt ? 'export' : 'noop'), scope, cond, name: a });
  }
}

// PowerShell 管線元素若是字串（含 here-string）就取出內容；其他運算式取原文
function psLiteralText(el) {
  const stack = [el];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'string_literal') {
      if (n.text.trim() !== el.text.trim()) return el.text;
      const t = n.text.trim();
      const here = /^@(["'])\r?\n([\s\S]*?)\r?\n\1@$/.exec(t);
      if (here) return here[2];
      const q = /^(['"])([\s\S]*)\1$/.exec(t);
      return q ? q[2] : t;
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i));
  }
  return null;
}

// ── 對外介面 ────────────────────────────────────────────────────────────────
// tool：'Bash' 或 'PowerShell'。回 null＝解析器不可用（呼叫端退回正則路徑）。
// hasError＝指令本身或任何一層內層（bash -c、cmd /c、powershell -Command、find -exec／xargs）解析出錯誤節點。
// 錯誤節點不一定是指令寫壞：PowerShell 文法把合法的 `./deploy.ps1 -Force`、`/usr/bin/x` 整串解析成 ERROR，
// 裡面一個指令都認不出來——所以呼叫端見 hasError 要整串退回正則路徑，不能拿殘缺的樹判。
// source 進來的環境檔不算：那是資料，錯誤節點會被修復後照樣取出賦值。
function analyze(command, tool, startDir, root, inherited) {
  if (!available(tool)) return null;
  const m = new Model(startDir, root);
  walkText(m, tool === 'PowerShell' ? 'powershell' : 'bash', command, '', '');
  const lines = buildLines(m);
  const env = makeEnvAt(m, startDir, root, inherited || ((n) => process.env[n]));
  return { execs: m.execs, lines, envAt: env.envAt, envUnsure: env.envUnsure, envInfo: env.envInfo, hasError: !!m.hasError };
}

module.exports = { analyze, available, runnerPrefix, baseName };
