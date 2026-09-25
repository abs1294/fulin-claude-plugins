#!/usr/bin/env node
/**
 * guard-qa-before-commit — qa-webwright 的 PreToolUse(Bash|PowerShell、Skill) hook：行為類改動 commit 前的 QA 表態閘。
 *
 * 為什麼：「行為類改動先 QA 再 commit」只寫在文件裡時，兩軌 review 都 PASS 就自動 commit 的路徑上
 * QA 從來不會被派——bug 隔天才被使用者實測抓到。本閘只在「這次要 commit 的內容真的含行為類檔」時要求表態，
 * 純文件／設定／測試資產不擋；只驗有沒有表態，不判表態內容。
 *
 * 啟動條件：專案 tests/e2e/qa-webwright.json 的 commit_gate.enabled === true（**預設關閉**：沒設＝完全靜默）。
 * 攔截點：
 *   ① shell 裡真的在執行的 `git commit`（commit-tree／commit-graph 等底層子命令不算）：
 *      repo＝同一條指令裡 cd／pushd 逐次累積、再套 git -C 逐個累積（cd a && cd b、git -C a -C b 都是 a/b）；
 *      要看的檔＝staged ＋ -a/--all 的未 stage 追蹤檔 ＋ `git commit <path>` 的 pathspec 工作樹改動
 *      ＋ 同一條指令裡先前 `git add／git stage <path>`（含 -A）會加進來的改動與新檔
 *   ② commit_gate.extra_commands 列的 commit 流程指令（如 `flow.sh review-record <repo>`，repo_group 指定 repo 參數的擷取群組）
 *   ③ Skill 呼叫，skill 名稱符合 commit_gate.skill_name_regex（預設 git-commit），檢查 commit_gate.repos 各 repo 的 staged
 * 行為類檔＝符合 behavior_globs 且不符合 exclude_globs（預設排除 tests/ 與 md/txt/json/yml/yaml/xml）。
 * 放行語法（commit_gate.qa_answer_regex，預設）：在「該次呼叫自己那一段」（含 commit 訊息、heredoc 本文）帶
 *   已QA：<QA 報告或 pytest 路徑＋實跑綠的輸出行>  ／  分流例外：<為何正確性只靠讀 code 就能確定>
 *   （--qa "已QA：…"、QA已驗：… 同樣認得）；Skill 呼叫寫在 args。
 * require_sediment=true：另要求「新 QA 坑：<已補到哪個檔>／無」（新踩的 QA 操作坑要沉澱到專案 QA 知識層）。
 * 註解、引號內、heredoc 本文裡「提到」git commit 不算呼叫。
 * 讀不到時（shell 與 Skill 兩條路徑同一套規則）：
 *   · git 無法啟動或逾時（沒裝 git、PATH 找不到）＝hook 自身環境問題 → 放行（FAIL-OPEN）
 *   · git 跑了但讀不到 staged（不是 git repo、repo 壞掉、目錄不存在）→ 要求表態（寧可多問一次）
 *   · repo 指向解析不出（變數、cd ~、cd -）→ 要求表態
 * FAIL-OPEN：hook 自身錯誤放行。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('./lib/qa-gate-common.js');

const DEFAULTS = {
  behavior_globs: ['**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte,py,rb,php,java,kt,go,rs,cs,swift,c,cc,cpp,h,hpp,sh,ps1,sql}'],
  exclude_globs: ['tests/**', '**/*.{md,txt,json,yml,yaml,xml}'],
  qa_answer_regex: '(?:--qa\\s+["\']?\\s*)?(?:已\\s*QA|QA\\s*已驗|分流例外)\\s*[:：]\\s*\\S',
  skill_name_regex: '(?:^|:)git-commit$',
  sediment_regex: '新\\s*QA\\s*坑\\s*[:：=]\\s*\\S',
  repos: ['.'],
};

function opt(sec, key) {
  return sec[key] !== undefined && sec[key] !== null ? sec[key] : DEFAULTS[key];
}

// 回 { names } 或 { fail: 'spawn' }（git 無法啟動／逾時＝hook 自身環境問題）或 { fail: 'status' }（git 跑了但讀不到）
// git 查詢共用的時間預算：hooks.json 給本 hook 30 秒，全部 git 呼叫加總不超過 GIT_BUDGET_MS；
// 預算用完的查詢視同「git 無法啟動」→ fail-open（寧可漏擋一次，不讓 hook 被 harness 砍掉）
const GIT_BUDGET_MS = 22000;
const GIT_CALL_MS = 8000;
const STARTED = Date.now();

function gitNames(dir, args) {
  if (!fs.existsSync(dir)) return { fail: 'status' };
  const left = GIT_BUDGET_MS - (Date.now() - STARTED);
  if (left < 500) return { fail: 'spawn' };
  const r = spawnSync('git', ['-c', 'core.quotepath=off'].concat(args), {
    cwd: dir, encoding: 'utf8', timeout: Math.min(GIT_CALL_MS, left), windowsHide: true,
  });
  if (r.error) return { fail: 'spawn' };
  if (r.status !== 0) return { fail: 'status' };
  return { names: String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean) };
}

// 這次會進 commit 的行為類檔。o.all＝-a／--all；o.pathspecs＝git commit <path>；o.include＝-i／--include；
// o.adds＝同指令先前的 git add（[{ specs, tracked }]，specs 已是絕對路徑或 :/）。回 { files } 或 { fail }（同 gitNames）。
// `git commit <path>`（沒有 -i）只提交 pathspec 範圍（--only 語意）：其他已 staged 或先前 add 的檔都不在這次 commit 裡。
function behaviorFiles(dir, o, sec) {
  // git commit --only 不帶 pathspec（常見於 --amend --only 只改訊息）：這次不提交任何 staged 改動
  if (o.onlyFlag && !(o.pathspecs && o.pathspecs.length) && !o.all) return { files: [] };
  const only = o.pathspecs && o.pathspecs.length && !o.include;
  const staged = gitNames(dir, ['diff', '--cached', '--name-only'].concat(only ? ['--'].concat(o.pathspecs) : []));
  if (staged.fail) return staged;
  let files = staged.names.slice();
  const extra = [];
  if (o.all) extra.push(['diff', '--name-only']);
  if (o.pathspecs && o.pathspecs.length) extra.push(['diff', '--name-only', '--'].concat(o.pathspecs));
  for (const a of only ? [] : (o.adds || [])) {
    extra.push(['diff', '--name-only', '--'].concat(a.specs));
    // git add -u 只更新已追蹤的檔；-A／. ／路徑才會把未追蹤的新檔加進來
    if (!a.tracked) extra.push(['ls-files', '--others', '--exclude-standard', '--full-name', '--'].concat(a.specs));
  }
  for (const args of extra) {
    const r = gitNames(dir, args);
    if (r.fail) return r;
    for (const f of r.names) if (files.indexOf(f) < 0) files.push(f);
  }
  // pathspec 模式：查詢當下還沒追蹤的新檔不在任何 diff 裡；若先前的 git add 會加它、且它在這次 pathspec 內，它就會被提交
  const untrackedAdds = only ? (o.adds || []).filter((a) => !a.tracked) : [];
  if (untrackedAdds.length) {
    const inSpec = gitNames(dir, ['ls-files', '--others', '--exclude-standard', '--full-name', '--'].concat(o.pathspecs));
    if (inSpec.fail) return inSpec;
    if (inSpec.names.length) {
      const added = new Set();
      for (const a of untrackedAdds) {
        const r = gitNames(dir, ['ls-files', '--others', '--exclude-standard', '--full-name', '--'].concat(a.specs));
        if (r.fail) return r;
        r.names.forEach((f) => added.add(f));
      }
      for (const f of inSpec.names) if (added.has(f) && files.indexOf(f) < 0) files.push(f);
    }
  }
  const inc = (opt(sec, 'behavior_globs') || []).map(G.globToRegex);
  const exc = (opt(sec, 'exclude_globs') || []).map(G.globToRegex);
  return { files: files.filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f))) };
}

// git 全域選項裡的 -C 逐個累積（git -C a -C b ＝ a/b）
function applyDashC(dir, globalOpts) {
  // --git-dir／--work-tree 讓 git 看的是另一個 repo：本 hook 不模擬，當成「解析不出」→ 要求表態
  if (/(?:^|\s)--(?:git-dir|work-tree)\b/.test(globalOpts || '')) return { unknown: '--git-dir／--work-tree' };
  const rx = /(?:^|\s)-C\s*("[^"\n]*"|'[^'\n]*'|\S+)/g;
  let m;
  let d = dir;
  while ((m = rx.exec(globalOpts || '')) !== null) {
    if (!d || d.unknown) return d;
    const v = G.unquote(m[1]);
    d = /[$`]/.test(v) ? { unknown: v } : path.resolve(d, G.nativePath(v));
  }
  return d;
}

// 子命令參數裡的 pathspec（去掉選項與選項值、重導）
const COMMIT_VALUE_OPTS = new Set(['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--reuse-message',
  '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer', '--qa']);
function pathspecs(text, valueOpts, valueShort, ps) {
  const words = G.shellWords(text, { ps });
  const out = [];
  let endOpts = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.redirect) {
      if (!(/&\d*-?$/.test(w.word) && /[<>]&/.test(w.word))) i++;
      continue;
    }
    const a = w.word;
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && /^--/.test(a)) {
      if (!a.includes('=') && valueOpts.has(a)) i++;
      continue;
    }
    if (!endOpts && /^-[A-Za-z]/.test(a)) {
      // 短選項群組：-am msg、-mmsg；值型選項在群組最後一個字元時，值是下一個字詞
      for (let k = 1; k < a.length; k++) {
        if (valueShort.indexOf(a[k]) >= 0) {
          if (k === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

// git commit 的旗標與 pathspec。短選項群組逐字元看：-am＝-a＋-m；-mupdate 的 update 是 -m 的值（不是 -a）。
function commitArgs(text, ps) {
  const words = G.shellWords(text, { ps });
  const out = { all: false, include: false, pathspecs: [], specFile: null, specNul: false, msgFiles: [] };
  let endOpts = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.redirect) {
      if (!(/&\d*-?$/.test(w.word) && /[<>]&/.test(w.word))) i++;
      continue;
    }
    const a = w.word;
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && /^--/.test(a)) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (name === '--dry-run') out.dryRun = true;
      else if (name === '--all') out.all = true;
      else if (name === '--include') out.include = true;
      else if (name === '--only') out.onlyFlag = true;
      else if (name === '--pathspec-file-nul') out.specNul = true;
      else if (name === '--pathspec-from-file') out.specFile = eq >= 0 ? a.slice(eq + 1) : String((words[++i] || {}).word || '');
      else if (name === '--file') out.msgFiles.push(eq >= 0 ? a.slice(eq + 1) : String((words[++i] || {}).word || ''));
      else if (eq < 0 && COMMIT_VALUE_OPTS.has(name)) i++;
      continue;
    }
    if (!endOpts && /^-[A-Za-z]/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        if ('mFCct'.indexOf(a[k]) >= 0) {
          // -F <檔>／-F<檔>：訊息檔（表態可寫在檔裡）
          if (a[k] === 'F') out.msgFiles.push(k === a.length - 1 ? String((words[i + 1] || {}).word || '') : a.slice(k + 1));
          if (k === a.length - 1) i++; // 值是下一個字詞；否則群組其餘字元就是值
          break;
        }
        // -u[<mode>]／-S[<keyid>]：值只能黏寫（可省略），群組其餘字元是值（-uall、-Sdeadbeef 的 a 不是 -a）
        if (a[k] === 'u' || a[k] === 'S') break;
        if (a[k] === 'a') out.all = true;
        if (a[k] === 'i') out.include = true;
        if (a[k] === 'o') out.onlyFlag = true;
      }
      continue;
    }
    out.pathspecs.push(a);
  }
  return out;
}

// --pathspec-from-file 的內容（相對 dir）；- （stdin）、讀不到 → null（無從判斷）
function readSpecFile(dir, file, nul) {
  if (!file || file === '-' || typeof dir !== 'string') return null;
  try {
    const body = fs.readFileSync(path.resolve(dir, G.nativePath(file)), 'utf8');
    return body.split(nul ? '\0' : /\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch (_) {
    return null;
  }
}

// git commit -F 的訊息檔內容（相對 git 執行目錄）；- （stdin）、讀不到、過大 → null
function readMsgFile(dir, file) {
  if (!file || file === '-' || typeof dir !== 'string') return null;
  try {
    const f = path.resolve(dir, G.nativePath(file));
    if (fs.statSync(f).size > 1024 * 1024) return null;
    return fs.readFileSync(f, 'utf8');
  } catch (_) {
    return null;
  }
}

// dir 所在 repo 的頂層（比對「先前的 git add 是不是同一個 repo」用）；查不到回 null
const TOPS = new Map();
function repoTop(dir) {
  if (typeof dir !== 'string') return null;
  if (TOPS.has(dir)) return TOPS.get(dir);
  const r = gitNames(dir, ['rev-parse', '--show-toplevel']);
  let top = r.names && r.names[0] ? path.resolve(G.nativePath(r.names[0])) : null;
  if (top && (process.platform === 'win32' || process.platform === 'darwin')) top = top.toLowerCase();
  TOPS.set(dir, top);
  return top;
}

// 先前的 git add 與這次 commit 是否作用在同一個 repo：目錄相同直接算；不同就比 repo 頂層。
// add 的目錄查不到 repo（那次 add 本身會失敗）→ 不算；commit 的目錄查不到 → 算（交給後面的查詢決定要不要表態）
function sameRepo(addDir, commitDir) {
  if (typeof addDir !== 'string' || typeof commitDir !== 'string' || addDir === commitDir) return true;
  const a = repoTop(addDir);
  if (!a) return false;
  const c = repoTop(commitDir);
  return !c || a === c;
}

function checkShell(input, cmd, sec, root) {
  const sh = G.scanShell(cmd, G.shellOpts(input));
  const cwd = input.cwd || root;
  const qaRe = G.re(opt(sec, 'qa_answer_regex'));
  const sedRe = sec.require_sediment === true ? G.re(opt(sec, 'sediment_regex')) : null;
  const calls = []; // { label, start, end, dir 或 { unknown }, all, include, pathspecs, adds }
  const ps = sh.ps; // PS 工具的指令：反斜線是路徑分隔，不是跳脫字元

  // ① git commit（commit-tree／commit-graph 等底層子命令不算）；同一條指令裡先前的 git add／git stage 一併計入。
  //    執行檔可帶路徑、.exe 或被引號包住（/usr/bin/git、git.exe、"git"）；-c 的值可帶引號。
  //    引號包住的完整路徑可含空白（"C:/Program Files/Git/bin/git.exe"）；-C 可黏寫（-Csub）。
  const gitRe = /(?<![\w.-])(?:(["'])(?:[^"'\n]*[\\/])?git(?:\.exe)?\1|(?:[^\s"';&|()<>]*[\\/])?git(?:\.exe)?)((?:\s+(?:-[pP](?=\s)|-C\s*(?:"[^"\n]*"|'[^'\n]*'|\S+)|-c\s+(?:"[^"\n]*"|'[^'\n]*'|\S+)|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s-]\S*)|--[\w.-]+(?:=\S+)?))*)\s+(commit|add|stage)(?![\w-])/g;
  const adds = []; // { idx, dir, specs（絕對路徑或 :/）, tracked }
  let m;
  while ((m = gitRe.exec(sh.code)) !== null) {
    const gi = m.index;
    const sub = m[3];
    const ci = m.index + m[0].length - sub.length;
    if (sh.kind[gi] !== 0 || sh.kind[ci] !== 0) continue;
    if (!G.atCommandPosition(sh, gi)) continue;
    const end = G.segmentEnd(sh, ci);
    const dir = applyDashC(G.cdChain(sh, gi, cwd), m[2]);
    const argText = sh.code.slice(ci + sub.length, end);
    const segBare = sh.bare.slice(ci, end);
    if (sub !== 'commit') {
      let specs = pathspecs(argText, new Set(['--chmod', '--pathspec-from-file']), '', ps);
      const tracked = /(?:^|\s)(?:-u|--update)(?=\s|$)/.test(segBare);
      let addDir = dir;
      // --pathspec-from-file：讀清單檔當 pathspec；讀不到（stdin、不存在）＝不知道加了什麼
      const sf = commitArgs(argText, ps);
      if (sf.specFile !== null) {
        const listed = readSpecFile(dir, sf.specFile, sf.specNul);
        if (listed === null) addDir = { unknown: 'git add --pathspec-from-file ' + sf.specFile };
        else specs = specs.concat(listed);
      }
      // -A／-u 沒給 pathspec＝整個 repo（git 2.x 起不論在哪個子目錄）：用 :/（repo 頂層）而不是 .（目前目錄）
      if (!specs.length && /(?:^|\s)(?:-[A-Za-z]*[Au][A-Za-z]*|--all|--update)(?=\s|$)/.test(segBare)) specs = [':/'];
      // 路徑型 pathspec 轉成絕對路徑：之後 cd 到別的目錄再 commit 仍指向同一批檔（同 repo 內 git 接受絕對路徑）
      if (typeof dir === 'string') specs = specs.map((s) => (/^:/.test(s) ? s : path.resolve(dir, G.nativePath(s))));
      if (specs.length || typeof addDir !== 'string') adds.push({ idx: gi, dir: addDir, specs, tracked });
      continue;
    }
    const ca = commitArgs(argText, ps);
    if (ca.dryRun) continue; // git commit --dry-run 只預覽、不提交
    // 先前的 git add 只算作用在同一個 repo 的（git -C A add && git -C B commit：A 的 add 與 B 無關）
    const prior = adds.filter((a) => a.idx < gi && sameRepo(a.dir, dir));
    let cdir = dir;
    let specs = ca.pathspecs;
    if (ca.specFile !== null) {
      const listed = readSpecFile(dir, ca.specFile, ca.specNul);
      if (listed === null) cdir = { unknown: '--pathspec-from-file ' + ca.specFile };
      else specs = specs.concat(listed);
    }
    // 先前的 git add 目錄解析不出 → 不知道加了什麼 → 這次 commit 也無從判斷
    if (prior.some((a) => typeof a.dir !== 'string')) cdir = { unknown: '先前 git add 的目錄' };
    calls.push({ label: 'git commit', start: ci, end, dir: cdir, all: ca.all, include: ca.include,
      onlyFlag: ca.onlyFlag, pathspecs: specs, adds: prior, msgFiles: ca.msgFiles, msgDir: dir });
  }

  // ② 參數檔列的 commit 流程指令
  for (const ec of Array.isArray(sec.extra_commands) ? sec.extra_commands : []) {
    if (!G.isObj(ec)) continue;
    const rx = G.re(ec.regex, 'gi');
    if (!rx) continue;
    let em;
    while ((em = rx.exec(sh.code)) !== null) {
      if (em[0] === '') {
        rx.lastIndex++;
        continue;
      }
      // 錨點＝repo 參數前（沒有 repo 群組時＝比對結尾）最後一個非空白字元，必須是指令本體
      // （不在引號／註解／heredoc 裡）：`bash "/x/flow.sh" review-record repo` 的 review-record 是本體；
      // `echo "flow.sh review-record repo"` 整段在引號裡 → 只是提到，不是呼叫。
      const g = Number.isInteger(ec.repo_group) ? ec.repo_group : 0;
      const anchorEnd = g > 0 && em[g] !== undefined
        ? em.index + em[0].lastIndexOf(em[g])
        : em.index + em[0].length;
      let a = anchorEnd - 1;
      while (a > em.index && /\s/.test(sh.code[a])) a--;
      if (sh.kind[a] !== 0) continue;
      // 比對開頭所在的字詞必須在指令位置（直接執行或 bash xxx）：`echo flow.sh review-record .` 只是提到
      if (!G.atCommandPosition(sh, G.wordStart(sh, em.index))) continue;
      const start = em.index + em[0].length;
      const end = G.segmentEnd(sh, start);
      let dir = G.cdChain(sh, em.index, cwd);
      if (g > 0 && em[g] !== undefined && dir && !dir.unknown) {
        const d = G.unquote(em[g]);
        dir = /[$`]/.test(d) ? { unknown: d } : path.resolve(dir, G.nativePath(d));
      }
      calls.push({ label: (ec.name || 'commit 流程指令') + '（' + em[0].trim().slice(0, 60) + '）', start: em.index, end, dir, all: false });
    }
  }

  const blocked = [];
  for (const c of calls) {
    let text = G.segmentText(sh, c.start, c.end);
    // git commit -F <檔>：訊息在檔裡 → 表態也可寫在檔裡（- ＝stdin、讀不到 → 只看指令本身）
    for (const f of c.msgFiles || []) {
      const body = readMsgFile(c.msgDir, f);
      if (body !== null) text += '\n' + body;
    }
    const needQa = qaRe && !qaRe.test(text);
    const needSed = sedRe && !sedRe.test(text);
    if (!needQa && !needSed) continue;
    let files = null;
    if (c.dir && !c.dir.unknown) {
      const r = behaviorFiles(c.dir, c, sec);
      if (r.fail === 'spawn') continue; // git 無法啟動／逾時：hook 自身環境問題 → fail-open
      if (!r.fail) {
        if (r.files.length === 0) continue;
        files = r.files;
      }
    }
    blocked.push({ c, files, needQa, needSed });
  }
  return blocked;
}

function checkSkill(ti, sec, root) {
  const nameRe = G.re(opt(sec, 'skill_name_regex'));
  const skill = String(ti.skill || ti.command || '');
  if (!nameRe || !nameRe.test(skill)) return [];
  const args = String(ti.args || '');
  const qaRe = G.re(opt(sec, 'qa_answer_regex'));
  const sedRe = sec.require_sediment === true ? G.re(opt(sec, 'sediment_regex')) : null;
  const needQa = qaRe && !qaRe.test(args);
  const needSed = sedRe && !sedRe.test(args);
  if (!needQa && !needSed) return [];
  const configured = G.strList(sec.repos);
  const repos = configured ? sec.repos : DEFAULTS.repos;
  let files = [];
  const unknown = [];
  for (const r of repos) {
    const dir = path.resolve(root, r);
    const f = behaviorFiles(dir, {}, sec);
    if (f.fail === 'spawn') continue; // git 無法啟動／逾時：hook 自身環境問題 → 該 repo fail-open
    // repos 沒設定、只用預設的專案根：根本身不是 repo（多 repo workspace）是正常結構，不是「讀不到」
    if (f.fail && !configured) continue;
    if (f.fail) {
      unknown.push(r); // git 讀不到 staged（不是 repo、壞掉）→ 與 shell 路徑一致：要求表態
      continue;
    }
    files = files.concat(f.files.map((x) => (r === '.' ? x : G.toPosix(path.join(r, x)))));
  }
  if (unknown.length) {
    return [{ c: { label: 'Skill ' + skill, dir: { unknown: unknown.join('、') } }, files: null, needQa, needSed, skill: true }];
  }
  if (files.length === 0) return [];
  return [{ c: { label: 'Skill ' + skill }, files, needQa, needSed, skill: true }];
}

function main() {
  const input = G.readInput();
  if (!input) return;
  const got = G.loadSection(input, 'commit_gate', (s) => G.isObj(s));
  if (!got || got.sec.enabled !== true) return;
  const sec = got.sec;
  const ti = G.isObj(input.tool_input) ? input.tool_input : {};
  const blocked = input.tool_name === 'Skill'
    ? checkSkill(ti, sec, got.loc.root)
    : (typeof ti.command === 'string' ? checkShell(input, ti.command, sec, got.loc.root) : []);
  if (!blocked.length) return;

  const problems = [];
  for (const b of blocked) {
    const what = [];
    if (b.needQa) what.push('QA 表態');
    if (b.needSed) what.push('「新 QA 坑」表態');
    let lines = b.c.label + ' 缺' + what.join('與') + '；';
    if (b.files) {
      lines += '這次要 commit 的內容含行為類檔：\n' + b.files.slice(0, 20).map((f) => '     - ' + f).join('\n')
        + (b.files.length > 20 ? '\n     …共 ' + b.files.length + ' 檔' : '');
    } else {
      const d = b.c.dir && b.c.dir.unknown ? b.c.dir.unknown : '（未知）';
      lines += '無法判斷要 commit 的內容（repo 指向 ' + d + ' 解析不出、或讀不到 staged），一律要求表態。'
        + '（若專案根不是 git repo、各子資料夾才是，請在參數檔 commit_gate.repos 列出實際的 repo 子目錄）';
    }
    problems.push(lines);
  }
  const sed = sec.require_sediment === true
    ? '\n另須表態「新 QA 坑：<已補到專案 QA 知識層哪個檔（如 tests/Project_Detail/…）>」或「新 QA 坑：無」'
      + '——本輪踩到的 QA 操作坑、測試設計知識要沉澱，答「無」也要寫出來。'
    : '';
  const where = blocked.some((b) => b.skill)
    ? 'Skill 呼叫：寫在 args（如 args: "--qa \\"已QA：tests/e2e/cart/test_cart.py 3 passed\\""）。'
    : 'shell：寫在該次呼叫自己那一段的 commit 訊息裡（git commit -m "…" -m "已QA：…"；git commit 沒有 --qa 選項）；'
      + '同一條指令裡別次呼叫的表態不算數。';
  G.deny(G.listMessage('[qa-before-commit] 行為類改動 commit 前必須先表態 QA 狀態', problems,
    '三選一：\n'
    + '  (a) 已QA：<QA 報告或 codify 的 pytest 檔路徑＋實跑綠的輸出行>\n'
    + '  (b) 分流例外：<為何正確性只靠讀 code 就能確定（純結構／文案／死碼等靜態可確定等價）>\n'
    + '  (c) 還沒 QA：**不得 commit**——先派 qa-engineer 實測（派工範本見 browser-qa SKILL.md），回來再 commit。\n'
    + where + sed
    + '\n本閘由專案 tests/e2e/qa-webwright.json 的 commit_gate 段啟用（enabled=true）；行為類判準見 behavior_globs／exclude_globs。'));
}

try {
  main();
} catch (_) {
  process.exitCode = 0; // FAIL-OPEN
}
