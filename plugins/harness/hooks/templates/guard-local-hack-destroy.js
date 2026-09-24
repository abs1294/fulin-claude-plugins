#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)：攔截會「銷毀未提交本機覆寫」的 git 指令。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-local-hack-destroy.js\"", "timeout": 15 }] }]
//
// 病灶：本機覆寫（連線字串、mock 開關、測試用 token…）刻意不 commit，長期以未提交改動存在。
// 這些改動不在 commit、不在 stash、reflog 也沒有——被 checkout/reset 蓋掉就是永久消失，git 完全救不回。
// 曾發生：一句 `git checkout <commit> -- .` 抹掉整段未提交實作連同幾個覆寫值，症狀要到服務行為
// 異常才浮現（所有端點回授權錯誤、外部呼叫卡逾時），回頭追已經過了好幾個小時；`reset --hard` 也發生過。
//
// 本檔是三環防線的「擋」，不是最後防線：攔截面（shell 語法變體）是無窮的，真正的根治是
// backup-local-hacks.js 的逐檔備份。本檔擋得住的是「最自然的寫法」，擋不住刻意的迂迴。
//
// 設計：只在「該指令真的會蓋到帶有未提交改動的覆寫檔」時才 deny，沒風險就放行——
// 假警報會讓閘被關掉（或訓練人反射性加豁免），比沒有閘更糟。具體做法：
//   1. 先把 heredoc 主體剝掉、判斷是否整段只是「引述」指令（寫文件、echo、grep 這些字串）；
//      曾經上線當天就自傷：誤擋「寫一份引用危險指令當案例的筆記」，接著連「修這支 hook」的指令也被自己擋。
//   2. 引號裡的 git 若是 shell 包裝（sh -c／bash -c／cmd /c／powershell -Command／eval／xargs git）
//      就是要執行的程式碼，不是引述——曾有 `sh -c "git checkout -- ."` 被當成純引述放行。
//   3. 把原始指令拆成一個個 git 呼叫、剝掉 git 與子指令之間的全域選項（-C、--git-dir、-c…）再判動詞；
//      曾有 `git -C "<含空白的路徑>" reset --hard` 因引號被先剝掉而整個呼叫消失、被放行。
//   4. 只檢查「這條指令真的會動到」的 repo（-C／--work-tree 指向，或整條指令唯一一個 cd）；
//      任何一個危險呼叫判不出落在哪個 repo，就退回掃全部。寧可誤擋，不可漏放。
//   5. 依檔案在 git 眼中的狀態判風險：reset/checkout 類只蓋「追蹤中且有改動」的檔；
//      git clean 只刪未追蹤檔（-x／-X 才碰被 .gitignore 排除的檔）；stash -u／-a 會收走未追蹤／被排除的檔。
//
// fail-open：解析失敗、git 讀不到、任何例外一律放行。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 覆寫清單檔（相對於工作目錄根）。與 git-commit plugin 的 flow.sh 讀同一份檔、同一個格式；
// 對應 Phase 1 盤點到的覆寫清單位置（沒有特別指定就用預設）。
const OVERRIDES_REL = '.claude/local-overrides.yml';
// 備份目錄（相對於工作目錄根），與 backup-local-hacks.js 的同名常數一致；只用在 deny 訊息。
const BACKUP_DIR_REL = '.claude/hack-backups';
// 救回腳本的指令（對應 init 複製 restore-local-hacks.js 的落點）；只用在 deny 訊息。
const RESTORE_CMD = 'node .claude/hooks/restore-local-hacks.js';
// 刻意沒有「放行記號」：記號寫在指令裡，無人值守時模型可以自己加上去＝自我授權，這道閘就等於不存在。
// 放行的唯一方式是讓指令本身不再危險——先備份、改用具名路徑還原、或改用不動工作區的寫法（見 deny 訊息）。
// ────────────────────────────────────────────────────────────────────────────

// ── 覆寫清單解析（backup／guard／alive／restore 四支各帶一份同樣的實作，改一支要同步另外三支）──
// 格式正本＝git-commit plugin 的 local-overrides.example.yml 與 flow.sh 的 parse_overrides_for_repo：
//   <頂層 key>:          區塊識別鍵
//     repo: <值>         "." ＝工作目錄本身；多 repo workspace 用子目錄名或 remote 的 repo 名
//     files:
//       - path: <相對於該 repo 的精確路徑>
//         reason: ...
// 解析比 flow.sh 寬鬆（縮排不拘），是它的超集：flow.sh 讀得到的條目這裡一定讀得到。
// repo 目錄的認法與 flow.sh 同一套候選識別字：repo 值或頂層 key 等於
//   (1) 工作目錄底下實際存在的子目錄路徑，或
//   (2) 工作目錄本身／第一層子目錄裡某個 git repo 的目錄名、remote origin 的 repo 名、git common dir 上層目錄名。
// 認不出目錄的區塊一律跳過（不猜）。
function findRoot() {
  const starts = [];
  if (process.env.CLAUDE_PROJECT_DIR) starts.push(process.env.CLAUDE_PROJECT_DIR);
  starts.push(process.cwd());
  starts.push(path.resolve(__dirname, '..', '..'));   // <root>/.claude/hooks → <root>
  // 逐層往上找：session 從子目錄啟動時，CLAUDE_PROJECT_DIR 不一定是清單所在的那一層
  for (const s of starts) {
    let dir = path.resolve(s);
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, OVERRIDES_REL))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

function unquote(v) {
  v = String(v).trim();
  if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  return v;
}

function loadEntries(root) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(root, OVERRIDES_REL), 'utf8'); } catch (e) { return []; }
  const out = [];
  let key = null, repo = null;
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    let m = line.match(/^([^\s#][^:]*):\s*$/);
    if (m) { key = m[1].trim(); repo = null; continue; }
    m = line.match(/^\s+repo:\s*(.+?)\s*$/);
    if (m) { repo = unquote(m[1]); continue; }
    m = line.match(/^\s*-\s*path:\s*(.+?)\s*$/);
    if (m && (key || repo)) out.push({ key: key, repo: repo, file: unquote(m[1]).split('\\').join('/') });
  }
  return out;
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir].concat(args), {
    encoding: 'utf8', timeout: 10000, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function repoIdentities(dir) {
  const ids = [path.basename(dir)];
  try {
    const url = git(dir, ['remote', 'get-url', 'origin']).trim().replace(/\.git$/, '').replace(/\/+$/, '');
    if (url) ids.push(url.split(/[\/:\\]/).pop());
  } catch (e) {}
  try {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    if (common) ids.push(path.basename(path.dirname(common)));
  } catch (e) {}
  return ids;
}

function repoDirOf(root, ent, cache) {
  const id = String(ent.key) + '\u0000' + String(ent.repo);
  if (Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];
  const names = [ent.repo, ent.key].filter(Boolean);
  let dir = null;
  if (ent.repo === '.') dir = root;
  for (const n of names) {
    if (dir) break;
    const p = path.resolve(root, n);
    try { if (fs.statSync(p).isDirectory()) dir = p; } catch (e) {}
  }
  if (!dir) {
    if (!cache.__repos) {
      cache.__repos = [];
      let subs = [];
      try {
        subs = fs.readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name !== '.claude').map((d) => path.join(root, d.name));
      } catch (e) {}
      for (const d of [root].concat(subs)) {
        if (fs.existsSync(path.join(d, '.git'))) cache.__repos.push({ dir: d, ids: repoIdentities(d) });
      }
    }
    const hit = cache.__repos.find((r) => names.some((n) => r.ids.indexOf(n) >= 0));
    if (hit) dir = hit.dir;
  }
  cache[id] = dir;
  return dir;
}

// 該檔在 git 眼中的狀態：'clean'（與 HEAD 相同或不存在）／'tracked'（追蹤中且有改動）／
// 'untracked'（未追蹤）／'ignored'（被 .gitignore 排除）；git 讀不到回 null（呼叫端一律不判）。
function fileState(dir, file) {
  let out;
  try { out = git(dir, ['status', '--porcelain', '--ignored', '--', file]); } catch (e) { return null; }
  const line = out.split(/\r?\n/).find(Boolean);
  if (!line) return 'clean';
  const xy = line.slice(0, 2);
  if (xy === '??') return 'untracked';
  if (xy === '!!') return 'ignored';
  return 'tracked';
}

function backupBase(ent) {
  return (String(ent.key || ent.repo) + '__' + ent.file).replace(/[^A-Za-z0-9._-]/g, '_');
}
// ── 覆寫清單解析 結束 ──

function gitTop(dir) {
  try { return path.resolve(git(dir, ['rev-parse', '--show-toplevel']).trim()); } catch (e) { return null; }
}

// 剝掉參數外層引號：-C "C:/a b/repo" → C:/a b/repo
function stripArgQuotes(s) {
  let v = String(s == null ? '' : s).trim();
  if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  return v;
}

// 把一段 shell 文字拆成一個個 git 呼叫，回傳 [{ verb, args, repoHint }]。
// 不用 split 切段：續行 `\` + 換行會把一個呼叫切成兩半。改成全域掃描每個 git token，
// 再從它往後吃到「真正的分隔符」為止。
// git 前導只要不是識別字元即可（涵蓋 $( ` ( " 等）；後綴收 .exe/.cmd/.bat/.com
// （Windows 上 `git.exe` 是合法且常見的寫法，曾因沒收後綴而零命中）。
function parseGitCalls(text) {
  const calls = [];
  const src = String(text);
  const re = /(^|[^A-Za-z0-9_.\-\/\\])git(?:\.(?:exe|cmd|bat|com))?(?=\s|$)/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    let rest = src.slice(m.index + m[0].length);
    const endRe = /[;&|]|\r?\n/g;
    let end = rest.length;
    let em;
    while ((em = endRe.exec(rest)) !== null) {
      if (em[0].indexOf('\n') >= 0) {
        const before = rest.slice(0, em.index).replace(/[ \t]*$/, '');
        if (before.endsWith('\\')) continue;   // 續行，不算結束
      }
      end = em.index;
      break;
    }
    rest = rest.slice(0, end).replace(/\\[ \t]*\r?\n/g, ' ').trim();

    // 剝掉 git 的全域選項。參數可能被引號包住，所以「一個參數」＝引號字串或連續非空白。
    // -C／--work-tree 的指向留下來（縮小檢查範圍用），其餘剝掉丟棄。
    const ARG = '(?:"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\'|\\S+)';
    let repoHint = null;
    for (;;) {
      let m2 = rest.match(new RegExp('^(?:-C|--work-tree)\\s+(' + ARG + ')\\s*'));
      if (m2) { if (repoHint === null) repoHint = stripArgQuotes(m2[1]); rest = rest.slice(m2[0].length); continue; }
      m2 = rest.match(new RegExp('^--work-tree=(' + ARG + ')\\s*'));
      if (m2) { if (repoHint === null) repoHint = stripArgQuotes(m2[1]); rest = rest.slice(m2[0].length); continue; }
      m2 = rest.match(new RegExp('^(?:-c|--git-dir|--namespace|--exec-path)\\s+' + ARG + '\\s*'));
      if (m2) { rest = rest.slice(m2[0].length); continue; }
      m2 = rest.match(new RegExp('^(?:--git-dir|--namespace|--exec-path)=' + ARG + '\\s*'));
      if (m2) { rest = rest.slice(m2[0].length); continue; }
      m2 = rest.match(/^(?:--no-pager|--bare|--literal-pathspecs|--paginate|-P|--exec-path)\s+/);
      if (m2) { rest = rest.slice(m2[0].length); continue; }
      break;
    }
    const vm = rest.match(/^([a-zA-Z][a-zA-Z0-9-]*)\s*([\s\S]*)$/);
    if (vm) calls.push({ verb: vm[1].toLowerCase(), args: vm[2] || '', repoHint: repoHint });
  }
  return calls;
}

// 純查詢用法：帶這些旗標時 git 不動工作區
const INERT = /(^|\s)(--help|-h|--dry-run|-n\b)(\s|$)/;

// 每條代表「這個呼叫會覆寫或丟棄工作區檔案」。kinds＝它會毀掉哪種狀態的檔（預設只有追蹤中有改動的）。
const TRACKED = () => ['tracked'];
const VERB_RULES = [
  { verb: 'checkout', test: (a) => /--\s+\./.test(a), label: 'git checkout … -- .（. 是整棵樹，不是你心裡想的那幾個路徑）' },
  { verb: 'checkout', test: (a) => /--\s+\S/.test(a), label: 'git checkout … -- <路徑>' },
  { verb: 'checkout', test: (a) => /(^|\s)(-f|--force)(\s|$)/.test(a), label: 'git checkout -f（直接丟棄本地修改）' },
  // checkout <commit-ish> <路徑>：不帶 -- 也會覆寫該路徑
  { verb: 'checkout', test: (a) => /^\S+\s+\S/.test(a) && !/^-/.test(a), label: 'git checkout <commit> <路徑>（會覆寫該路徑）' },
  { verb: 'checkout', test: (a) => /^\.(\s|$)/.test(a), label: 'git checkout .' },
  // 裸 `--`：路徑由 xargs／管線在執行期供給（`echo . | xargs git checkout --` 會真的還原檔案）
  { verb: 'checkout', test: (a) => /^--\s*$/.test(a.trim()), label: 'git checkout --（路徑由管線供給）' },
  // 單一個名稱：語法上分不出是分支還是路徑；是路徑就會覆寫，所以一律視為危險
  { verb: 'checkout', test: (a) => /^(?!-)[^\s]+\s*$/.test(a), label: 'git checkout <名稱>（分不出是分支或路徑；是路徑就會覆寫）' },
  // restore 預設（無旗標）等同 --worktree；只帶 --staged／--cached 則僅還原 index，工作區不動。
  // 同時帶 --staged --worktree 仍會寫工作區，故「有 worktree 旗標就擋」而非「有 staged 就放」。
  {
    verb: 'restore',
    test: (a) => {
      if (!a.trim()) return false;
      if (/(^|\s)(--worktree|-W)(\s|$)/.test(a)) return true;
      if (/(^|\s)(--staged|--cached|-S)(\s|$)/.test(a)) return false;
      return true;
    },
    label: 'git restore（未帶 --staged，會覆寫工作區）',
  },
  // 一般的 switch 會把未提交改動帶過去（衝突時 git 拒絕切換），不會丟；只有強制旗標會丟。
  { verb: 'switch', test: (a) => /(^|\s)(-f|--force|--discard-changes)(\s|$)/.test(a), label: 'git switch -f／--discard-changes（丟棄本地修改）' },
  { verb: 'reset', test: (a) => /--hard/.test(a), label: 'git reset --hard' },
  {
    verb: 'clean',
    test: (a) => /(^|\s)(-[a-zA-Z]*[fdxX]|--force)/.test(a),
    kinds: (a) => (/(^|\s)-[a-zA-Z]*x/.test(a) ? ['untracked', 'ignored']
      : (/(^|\s)-[a-zA-Z]*X/.test(a) ? ['ignored'] : ['untracked'])),
    label: 'git clean（刪除未追蹤檔；-x／-X 連 .gitignore 排除的檔一起刪）',
  },
  // 裸 git stash 等同 stash push，同樣把覆寫收走（忘了 apply 就等於消失）
  {
    verb: 'stash',
    test: (a) => !/^(list|show|apply|pop|drop|clear|branch|create|store)\b/.test(a.trim()),
    kinds: (a) => (/(^|\s)(-a|--all)(\s|$)/.test(a) ? ['tracked', 'untracked', 'ignored']
      : (/(^|\s)(-u|--include-untracked)(\s|$)/.test(a) ? ['tracked', 'untracked'] : ['tracked'])),
    label: 'git stash（覆寫被收走，忘了 apply 就等於消失）',
  },
  { verb: 'filter-branch', test: () => true, label: 'git filter-branch' },
  { verb: 'rebase', test: (a) => !/^(--abort|--quit|--continue|--skip|--edit-todo|--show-current-patch)\b/.test(a.trim()), label: 'git rebase（重寫歷史，工作區會被重建）' },
  { verb: 'merge', test: (a) => /--abort/.test(a), label: 'git merge --abort（丟棄合併期間的工作區狀態）' },
  { verb: 'revert', test: (a) => !/^--(abort|quit|continue|skip)\b/.test(a.trim()), label: 'git revert（會改動工作區）' },
  { verb: 'am', test: (a) => /--abort/.test(a), label: 'git am --abort' },
  { verb: 'cherry-pick', test: (a) => /--abort/.test(a), label: 'git cherry-pick --abort' },
];

// 回傳 { labels, repoHints, kinds }：repoHints 是每個危險呼叫的 -C／--work-tree 指向（沒指向＝null）。
function matchDanger(text) {
  const labels = [];
  const repoHints = [];
  const kinds = new Set();
  for (const call of parseGitCalls(text)) {
    if (INERT.test(call.args)) continue;
    for (const r of VERB_RULES) {
      if (r.verb !== call.verb) continue;
      let ok = false;
      try { ok = r.test(call.args); } catch (e) { ok = false; }
      if (!ok) continue;
      if (labels.indexOf(r.label) < 0) labels.push(r.label);
      repoHints.push(call.repoHint);
      (r.kinds || TRACKED)(call.args).forEach((k) => kinds.add(k));
      break;   // 同一個呼叫命中一條就夠
    }
  }
  return { labels: labels, repoHints: repoHints, kinds: kinds };
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let reason = null;
  try {
    const input = JSON.parse(raw);
    const ti = input.tool_input || {};
    const cmd = String(ti.command || '');
    if (!cmd) process.exit(0);

    // heredoc 主體是寫檔內容的主要載體，先剝掉；但只剝「換行之後」到終止符為止——
    // 同一行 <<TAG 之後的可執行程式碼要保留。曾有
    //   cat > note.md <<EOF && git reset --hard
    // 因為整段被剝掉而放行，而「寫份筆記順便重置」正是長得像正當用途的洞。
    const heredocStripped = cmd.replace(
      /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?([^\n]*)\n[\s\S]*?^[ \t]*\1[ \t]*$/gm,
      (m0, tag, sameLineRest) => ' ' + (sameLineRest || '') + ' ');

    if (!/\bgit\b/i.test(heredocStripped)) process.exit(0);

    // 引號剝除只用來判斷「這整段只是在引述指令」，不拿去解析 git 呼叫
    // （剝掉引號會把 -C "路徑" 的參數弄不見、整個呼叫隨之消失）。
    const quotesGone = heredocStripped
      .replace(/'[^']*'/g, ' ')
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ');

    // shell 包裝的引號是要執行的程式碼。三個約束缺一不可：
    //   ① 包裝指令必須在執行位置（`echo 'use xargs to batch'` 這種純提及不算）
    //   ② 包裝後面要真的接 git（只有包裝存在不足以取消純引述放行）
    //   ③ 接的程式要是 git——`find … | xargs grep -l "git checkout"` 的 xargs 接的是 grep，不該擋
    // Windows 的 cmd 用 /c /k 不是 -c。
    const GITX = '(?:git(?:\\.(?:exe|cmd|bat|com))?)';
    const SHELLS = '(?:sh|bash|zsh|dash|ksh|pwsh|powershell(?:\\.exe)?|cmd(?:\\.exe)?)';
    // 執行指令的旗標：bash 系 -c（可合寫成 -lc、-ec）；cmd 的 /c、/k（Git Bash 上寫成 //c）；
    // PowerShell 的 -Command 任何前綴縮寫（-c、-Com、-comm，前面可以是 -、-- 或 //）與 -EncodedCommand
    const FLAGS = '(?:-[A-Za-z]*c[A-Za-z]*|\\/{1,2}[ck]|(?:-{1,2}|\\/{1,2})c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?|-EncodedCommand)';
    // 一個詞的組成：非空白字元，或整段引號字串（引號內可含空白）
    const WORD = '(?:[^\\s;&|"\']|"[^"]*"|\'[^\']*\')';
    const WRAPPER_RUNS_GIT = new RegExp(
      // 殼名與執行旗標之間只能是其他旗標（可帶一個值，值可以是路徑）：`cmd //d //c`、`bash -o pipefail -c`、
      // `bash --rcfile /dev/null -c`、`powershell -exec bypass -c`；殼名後面直接是腳本名就不是包裝（`bash run.sh -c …`）。
      // 取捨：旗標後面的腳本路徑也會被當成值（`bash -x run.sh -c …` 會多擋）——漏擋會真的銷毀改動，多擋只是攔下來問
      // 旗標與值都可能含引號字串（`-WorkingDirectory "C:\my repo"`、`-Param:"a b"`），引號內的空白不算斷詞
      '(^|[\\s;&|(])' + SHELLS + '\\s+(?:(?:[-+]' + WORD + '*|\\/{1,2}[A-Za-z](?::' + WORD + '*)?)(?:\\s+(?:"[^"]*"|\'[^\']*\'|[^\\s;&|\\-+"\']' + WORD + '*))?\\s+)*?' + FLAGS + '\\s+["\']?\\s*' + GITX + '(\\s|["\']|$)' +
      '|(^|[\\s;&|(])eval\\s+["\']?\\s*' + GITX + '(\\s|["\']|$)' +
      '|(^|[\\s;&|(])xargs\\s+(?:-[A-Za-z]+(?:\\s+\\S+)?\\s+)*' + GITX + '(\\s|$)',
      'i');
    const isWrapper = WRAPPER_RUNS_GIT.test(heredocStripped);

    // 純引述：剝掉引號後一個 git token 都不剩（與 parseGitCalls 的 git token 同一判準）
    if (!isWrapper && !/(^|[^A-Za-z0-9_.\-\/\\])git(?:\.(?:exe|cmd|bat|com))?(\s|$)/i.test(quotesGone)) process.exit(0);

    const danger = matchDanger(heredocStripped);
    if (!danger.labels.length) process.exit(0);

    const ROOT = findRoot();
    if (!ROOT) process.exit(0);
    const entries = loadEntries(ROOT);
    if (!entries.length) process.exit(0);

    // 每個條目 → 它所在 git repo 的頂層目錄。範圍以「git repo」為單位而不是以清單區塊為單位：
    // 兩個區塊若指向同一個 repo 的不同子目錄，reset --hard 會一起蓋掉。
    const cache = {};
    const tops = {};
    const items = [];
    for (const ent of entries) {
      const dir = repoDirOf(ROOT, ent, cache);
      if (!dir) continue;
      if (!Object.prototype.hasOwnProperty.call(tops, dir)) tops[dir] = gitTop(dir);
      if (!tops[dir]) continue;
      items.push({ ent: ent, dir: dir, top: tops[dir] });
    }
    if (!items.length) process.exit(0);

    const norm = (p) => path.resolve(p).split('\\').join('/').replace(/\/+$/, '').toLowerCase();
    const knownTops = [...new Set(items.map((i) => i.top))];
    const base = input.cwd && fs.existsSync(input.cwd) ? input.cwd : ROOT;
    // 路徑 → 它落在哪個已知 repo（取最長前綴）；對不到回 null（呼叫端退回掃全部）
    const topOfPath = (p) => {
      if (!p) return null;
      let abs;
      try { abs = norm(path.resolve(base, stripArgQuotes(p))); } catch (e) { return null; }
      let best = null;
      for (const t of knownTops) {
        const nt = norm(t);
        if ((abs === nt || abs.indexOf(nt + '/') === 0) && (!best || nt.length > norm(best).length)) best = t;
      }
      return best;
    };
    // cd 只在「整條指令裡就這麼一個」時才採信：`cd A && git status; cd B && git reset --hard`
    // 危險的是 B，只抓第一個 cd 會把範圍算成 A。逐段追蹤 cwd 等於模擬 shell 語意，錯一個分支就是漏放。
    const cdTarget = (function () {
      const re = /(?:^|[;&|(])\s*(?:cd|Set-Location|sl|pushd)\s+("[^"]+"|'[^']+'|\S+)/gi;
      const found = [];
      let m;
      while ((m = re.exec(heredocStripped)) !== null) found.push(m[1]);
      return found.length === 1 ? topOfPath(found[0]) : null;
    })();
    let scanTops = knownTops;
    const resolved = danger.repoHints.map((h) => (h ? topOfPath(h) : cdTarget));
    if (resolved.length && resolved.every((r) => r !== null)) scanTops = [...new Set(resolved)];

    const atRisk = [];
    for (const it of items) {
      if (scanTops.indexOf(it.top) < 0) continue;
      const st = fileState(it.dir, it.ent.file);
      if (st && st !== 'clean' && danger.kinds.has(st)) {
        atRisk.push(path.relative(ROOT, path.join(it.dir, it.ent.file)).split('\\').join('/') || it.ent.file);
      }
    }
    if (!atRisk.length) process.exit(0);

    const L = [];
    L.push('[本機覆寫防銷毀] 這個指令會蓋掉工作區檔案，而目前有 ' + atRisk.length + ' 個帶著未提交改動的本機覆寫檔（清單：' + OVERRIDES_REL + '）：');
    atRisk.forEach((f) => L.push('  - ' + f));
    L.push('');
    L.push('偵測到的危險樣態：' + danger.labels.join('、'));
    L.push('');
    L.push('這些改動不在 commit、不在 stash、reflog 也沒有——被蓋掉就是永久消失，git 救不回。');
    L.push('');
    L.push('先確認備份在、而且是最新的：');
    L.push('  ' + RESTORE_CMD + ' --list     # 備份位於 ' + BACKUP_DIR_REL + '/');
    L.push('  沒有或不是最新 → git -C <repo> diff HEAD -- <檔案> > <備份路徑>.patch，再 git apply --check 驗證可套回');
    L.push('');
    L.push('然後依目的擇一改寫指令：');
    L.push('  · 只想還原某幾個檔 → 用具名路徑 git restore --worktree a.txt b.txt，不要 -- .');
    L.push('  · 要動 HEAD（reset／rebase／filter-branch）→ 先 git branch backup-<時間> HEAD 備份 ref，事後用 ' + RESTORE_CMD + ' --restore 套回覆寫');
    L.push('  · 要切分支 → 不加 -f 的 git switch 會把未提交改動帶過去，不需要先清工作區');
    L.push('');
    L.push('確定這些覆寫不需要保留時：先照上面備份，或改用只動特定檔案的寫法；本閘沒有放行記號，也沒有「說明原因就放行」的旁路。');
    reason = L.join('\n');
  } catch (e) { process.exit(0); }

  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  }
  process.exit(0);
});
