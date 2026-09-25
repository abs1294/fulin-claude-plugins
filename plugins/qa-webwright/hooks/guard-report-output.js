#!/usr/bin/env node
/**
 * guard-report-output — qa-webwright 的 PreToolUse(Write|Edit|NotebookEdit、Bash|PowerShell) hook：交付資料夾紀律。
 *
 * 為什麼：給人看的測試交付資料夾（報告、驗收截圖）一旦被過程檔（測試結果 XML、除錯截圖、log、trace）
 * 淹沒，收件人找不到最終檔。約定：
 *   〈交付根〉/〈主題〉_〈日期〉/〈最終交付檔〉   ← 第一層只放最終交付檔
 *   〈交付根〉/〈主題〉_〈日期〉/_work/          ← 其餘一切過程產物收這裡
 * 規則（只管「寫入」；讀取、刪除一律放行）：
 *   1. 交付根層直接寫任何「檔案」 → 擋（根層只准開交付資料夾）。
 *   2. 交付資料夾內出現過程格式檔（process_ext_regex）且不在 work_dir 底下 → 擋。
 *   3. work_dir 底下一切、以及非過程格式（docx/pdf/xlsx/csv/json…）→ 放行（機器判不出什麼是最終檔，只擋最常見的汙染）。
 *
 * 與 qa-flow.sh run 的分工：qa-flow.sh run 的 junit 報告落在 tests/e2e/reports/<feature>-<date>.xml，
 *   那是**回歸資產**（機器讀的執行紀錄），不是給人看的交付物——本閘對 tests/e2e/reports/ 底下一律不管，
 *   即使有人把交付根設成 reports 也一樣（避免兩條規則打架）。
 *
 * 啟動條件：專案 tests/e2e/qa-webwright.json 有 report_hygiene.roots（非空陣列）；否則完全靜默。
 *   report_hygiene: { roots: ["tests/reports"], process_ext_regex: "\\.(xml|png|…)$", work_dir: "_work" }
 *   roots 是相對專案根的路徑（不分正反斜線、Windows／macOS 不分大小寫；. 與 .. 先消解）。
 * 路徑判定：相對路徑以 session cwd 解析、`..` 先消解，再看落點是否在專案根的交付根底下（專案外一律不管）。
 * Bash／PowerShell 逐段（; && || | 換行分隔）分詞，只取「寫入目標」檢查：
 *   · 重導目標（> x、>> x、2> x；/dev/null、&1 這類不是檔案）
 *   · tee／touch 的檔案參數（touch -r 的參照檔只被讀，不算）；--junitxml=／--junit-xml 的值（echo、grep 等
 *     文字指令的參數不算）；zip 的壓縮檔、tar -c…f 的壓縮檔
 *   · cp／mv／install／rsync 的**目的地**（來源是被搬走的舊位置，不檢查）；目的地是目錄（尾斜線、已存在的目錄、
 *     或多個來源）時，以「目錄/來源檔名」判定；來源是既有目錄（cp -r dir …）時，底下每個檔都算落點
 *   · Out-File／Set-Content／Add-Content／Export-Csv／New-Item 的 -FilePath／-Path（或第一個位置參數）；
 *     Copy-Item／Move-Item 的 -Destination（或第二個位置參數）
 *   ls、cat、rm 等讀取／刪除指令就算帶 2>/dev/null、2>&1 也不算寫入。
 * FAIL-OPEN：hook 自身錯誤、設定型別壞 → 放行。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const G = require('./lib/qa-gate-common.js');

const DEFAULT_PROCESS_EXT = '\\.(xml|png|jpe?g|gif|bmp|webp|log|webm|mp4|har|trace|zip|tmp|bak|dump)$';
const NOT_A_FILE = /^(?:\/dev\/(?:null|stdout|stderr|tty)|nul|\$null|&\d*-?)$/i;
const CI = process.platform === 'win32' || process.platform === 'darwin';

// 落點 → 專案根相對的正斜線路徑；在專案外回 null
function projectRel(p, ctx) {
  const s = G.nativePath(String(p || '').trim());
  if (!s) return null;
  const abs = path.resolve(ctx.cwd, s);
  let rel = path.relative(ctx.root, abs);
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) return null;
  rel = G.toPosix(rel);
  // 呼叫端寫了尾斜線（明說是目錄）要保留，供推導檔名
  if (/[\\/]$/.test(s)) rel += '/';
  return rel;
}

function isQaflowReports(rel) {
  return /^tests\/e2e\/reports(\/|$)/i.test(rel);
}

function underRoot(rel, roots) {
  if (rel === null || isQaflowReports(rel)) return null;
  for (const root of roots) {
    // 設定值先消解 . 與 ..（tests/../reports ＝ reports），才能與已消解的落點比對；消解後跑到專案外的不管
    const r = path.posix.normalize(G.toPosix(root)).replace(/^\.?\/+|\/+$/g, '').replace(/^\.$/, '');
    if (!r || r === '..' || r.startsWith('../')) continue;
    const a = CI ? rel.toLowerCase() : rel;
    const b = CI ? r.toLowerCase() : r;
    if (a.startsWith(b + '/')) return { root: r, rel: rel.slice(r.length + 1).replace(/\/+$/, '') };
  }
  return null;
}

function violation(hit, procRe, workDir) {
  if (!hit || !hit.rel) return null;
  const segs = hit.rel.split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  if (!/\.[A-Za-z0-9]+$/.test(last)) return null; // 無副檔名（多半是開資料夾）不管；有副檔名不論長短都算檔案
  if (segs.length === 1) return hit.root + '/ 根層禁止直接放檔（' + last + '）——根層只承載各次交付的資料夾';
  if (segs.some((s) => s.toLowerCase() === workDir.toLowerCase())) return null;
  if (procRe.test(last)) {
    return '過程檔（' + hit.root + '/' + hit.rel + '）必須收進交付資料夾內的 ' + workDir + '/——第一層只放最終交付檔';
  }
  return null;
}

function isDir(p, ctx) {
  const abs = path.resolve(ctx.cwd || ctx.root, G.nativePath(p));
  // 同一條指令前面 mkdir 建的目錄（此刻還不存在，執行時會先建好）
  if (ctx.madeDirs && ctx.madeDirs.has(CI ? abs.toLowerCase() : abs)) return true;
  try {
    return fs.statSync(abs).isDirectory();
  } catch (_) {
    return false;
  }
}

// rsync --exclude 樣式（只認最常見的檔名 glob：*.png、debug*）：被排除的檔不會被複製，不算落點
function excluded(rel, patterns) {
  const segs = rel.split('/');
  return (patterns || []).some((p0) => {
    const p = p0.replace(/\/+$/, '');
    const rx = new RegExp('^' + p.split('*').map((x) => G.escRe(x).replace(/\\\?/g, '.')).join('.*') + '$', CI ? 'i' : '');
    if (p.indexOf('/') >= 0) return rx.test(rel);
    // 不含 / 的樣式比對每一層名稱：--exclude debug 排除整個 debug/ 目錄（底下的檔都不會被複製）
    return segs.some((s) => rx.test(s));
  });
}

// 來源帶萬用字元（cp screenshots/* …）：展開成實際的檔名（只處理最後一段的 * ?）
function globSources(src, ctx) {
  const s = G.toPosix(src);
  if (!/[*?]/.test(s)) return [src];
  const dir = s.indexOf('/') >= 0 ? s.slice(0, s.lastIndexOf('/')) : '.';
  const pat = s.slice(s.lastIndexOf('/') + 1);
  if (/[*?]/.test(dir)) return [];
  const rx = new RegExp('^' + pat.split('*').map((x) => G.escRe(x).replace(/\\\?/g, '.')).join('.*') + '$', CI ? 'i' : '');
  try {
    return fs.readdirSync(path.resolve(ctx.cwd || ctx.root, G.nativePath(dir)))
      .filter((n) => rx.test(n) && !(n.startsWith('.') && !pat.startsWith('.')))
      .map((n) => (dir === '.' ? n : dir + '/' + n));
  } catch (_) {
    return [];
  }
}

// 來源是既有目錄（cp -r dir …）：列出底下的檔案（相對來源目錄；有上限，只看最常見的汙染）
const WALK_LIMIT = 2000;
function dirFiles(src, ctx) {
  const base = path.resolve(ctx.cwd || ctx.root, G.nativePath(src));
  const out = [];
  const walk = (abs, rel, depth) => {
    if (out.length >= WALK_LIMIT || depth > 12) return;
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      if (out.length >= WALK_LIMIT) return;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r, depth + 1);
      else out.push(r);
    }
  };
  walk(base, '', 0);
  return out;
}

// cp／mv 類：目的地是目錄時，實際落點是「目錄/來源檔名」；來源是目錄時，底下每個檔都算落點
function copyTargets(dest, sources0, ctx, rsync, excludes) {
  // 來源與目的地裡的 $VAR 先展開（cp -r "$SRC" …）；來源展開不了＝無從判斷，略過該來源
  const ex = (p) => (p.indexOf('$') >= 0 && ctx.expand ? ctx.expand(p) : p);
  dest = dest ? ex(dest) : dest;
  const sources = [].concat(...sources0.map(ex).filter((s) => s !== null).map((s) => globSources(s, ctx)));
  if (!dest) return [];
  const dirLike = /[\\/]$/.test(dest) || sources.length > 1 || isDir(dest, ctx);
  const d = dest.replace(/[\\/]+$/, '');
  const out = [];
  for (const s of sources) {
    const name = path.basename(G.toPosix(s).replace(/\/+$/, ''));
    if (isDir(s, ctx)) {
      // 目的地是既有目錄（或明說是目錄）→ 複製成 目的地/來源目錄名/…；否則目的地就是新目錄 → 目的地/…
      // rsync 的來源帶尾斜線（src/）＝只複製內容 → 直接落在 目的地/…
      const into = dirLike && !(rsync && /[\\/]$/.test(s)) ? d + '/' + name : d;
      for (const f of dirFiles(s, ctx)) if (!excluded(f, excludes)) out.push(into + '/' + f);
    } else {
      out.push(dirLike ? d + '/' + name : dest);
    }
  }
  if (!sources.length) out.push(dest);
  return out;
}

const PREFIX_WORDS = new Set(['sudo', 'env', 'command', 'time', 'nohup', 'exec', 'then', 'do', 'else', 'xargs', '!']);
const TEXT_CMDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'less', 'more', 'head', 'tail', 'sed',
  'awk', 'write-host', 'write-output', 'select-string', 'man', 'help', 'type', 'which', 'test', '[']);

// 一段指令（單次呼叫）的寫入目標
function segmentTargets(seg, ctx) {
  // 子殼層 (echo x > a.xml) 的右括號黏在最後一個字詞上：未加引號、沒有左括號的字詞去掉結尾的 )
  const words = G.shellWords(seg, { ps: ctx.ps }).map((w) => (!w.quoted && /\)+$/.test(w.word) && w.word.indexOf('(') < 0
    ? Object.assign({}, w, { word: w.word.replace(/\)+$/, '') }) : w));
  const args = [];
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.redirect) {
      const op = w.word;
      if (/&\d*-?$/.test(op) && /[<>]&/.test(op)) continue; // 2>&1、>&2：不是檔案
      const next = words[i + 1];
      i++;
      if (!next || /^\d*</.test(op) || /^<</.test(op)) continue; // 輸入重導、heredoc
      if (!NOT_A_FILE.test(next.word)) out.push(next.word);
      continue;
    }
    args.push(w);
  }
  // 去掉前綴賦值、sudo/env 等前綴字與開頭的 ( {
  while (args.length) {
    const a = args[0];
    const bare = a.word.replace(/^[({]+/, '');
    if (!a.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) {
      args.shift();
      continue;
    }
    if (bare === '' || PREFIX_WORDS.has(bare)) {
      args.shift();
      continue;
    }
    a.word = bare;
    break;
  }
  if (!args.length) return out;
  const cmd = path.basename(G.toPosix(args[0].word)).toLowerCase().replace(/\.exe$/, '');
  const rest = args.slice(1).map((a) => a.word);
  // --junitxml 只在真的會跑測試的指令上算寫入；echo／grep 等只是把它當文字
  for (let i = 0; i < rest.length && !TEXT_CMDS.has(cmd); i++) {
    const m = /^--?junit-?xml=(.+)$/i.exec(rest[i]);
    if (m) out.push(m[1]);
    else if (/^--?junit-?xml$/i.test(rest[i]) && rest[i + 1]) out.push(rest[i + 1]);
  }
  const positional = (list, valueOpts) => {
    const pos = [];
    let endOpts = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!endOpts && a === '--') {
        endOpts = true;
        continue;
      }
      if (!endOpts && /^-/.test(a) && a !== '-') {
        if (valueOpts && valueOpts.has(a)) i++;
        continue;
      }
      pos.push(a);
    }
    return pos;
  };
  if (cmd === 'tee') {
    out.push(...positional(rest));
  } else if (cmd === 'touch') {
    // -r／-d／-t 帶值：-r 的參照檔只被讀時間，不是寫入目標
    out.push(...positional(rest, new Set(['-r', '-d', '-t', '--reference', '--date'])));
  } else if (cmd === 'cp' || cmd === 'mv' || cmd === 'install' || cmd === 'rsync' || cmd === 'ln') {
    let tdir = null;
    const list = [];
    const excludes = [];
    const rs = cmd === 'rsync';
    // 「來源帶尾斜線＝只複製內容」：rsync 一律如此；macOS（BSD）的 cp -R src/ 也是
    const contentsCopy = rs || (cmd === 'cp' && process.platform === 'darwin');
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      const tm = /^--target-directory=(.+)$/.exec(a);
      const xm = rs ? /^--exclude=(.+)$/.exec(a) : null;
      if (tm) tdir = tm[1];
      else if (a === '-t' && rest[i + 1]) tdir = rest[++i];
      else if (xm) excludes.push(xm[1]);
      else if (rs && a === '--exclude' && rest[i + 1]) excludes.push(rest[++i]);
      else list.push(a);
    }
    const pos = positional(list, new Set(['-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '-e']));
    if (tdir) out.push(...copyTargets(tdir.replace(/[\\/]*$/, '/'), pos, ctx, contentsCopy, excludes));
    else if (pos.length >= 2) out.push(...copyTargets(pos[pos.length - 1], pos.slice(0, -1), ctx, contentsCopy, excludes));
  } else if (cmd === 'mkdir' || cmd === 'md') {
    // 記下這條指令裡建的目錄：後面 cp／mv 到它時要當目錄看（此刻它還不存在）
    for (let a of positional(rest, new Set(['-m', '--mode']))) {
      if (a.indexOf('$') >= 0 && ctx.expand) a = ctx.expand(a);
      if (!a || !ctx.madeDirs) continue;
      const abs = path.resolve(ctx.cwd || ctx.root, G.nativePath(a));
      ctx.madeDirs.add(CI ? abs.toLowerCase() : abs);
    }
  } else if (cmd === 'curl' || cmd === 'wget') {
    // 下載到檔：curl -o <檔>／--output <檔>、wget -O <檔>／--output-document=<檔>（- ＝stdout）
    const opts = cmd === 'curl' ? /^(?:-o|--output)$/ : /^(?:-O|--output-document)$/;
    const eqRe = cmd === 'curl' ? /^--output=(.+)$/ : /^--output-document=(.+)$/;
    const glued = cmd === 'curl' ? /^-o(.+)$/ : /^-O(.+)$/;
    // 短選項群組以 o／O 結尾（curl -sSo 檔、wget -qO 檔）：值是下一個字詞
    const group = cmd === 'curl' ? /^-[A-Za-z]*o$/ : /^-[A-Za-z]*O$/;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      let f = null;
      if (opts.test(a) || (!/^--/.test(a) && group.test(a))) f = rest[++i];
      else if (eqRe.test(a)) f = eqRe.exec(a)[1];
      else if (glued.test(a)) f = glued.exec(a)[1];
      if (f && f !== '-') out.push(f);
    }
  } else if (cmd === 'start-transcript') {
    // PowerShell 逐字稿：-Path／-LiteralPath／-OutputDirectory 或第一個位置參數
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      const kv = /^-(?:path|literalpath|outputdirectory):(.+)$/i.exec(a);
      if (kv) out.push(kv[1]);
      else if (/^-(?:path|literalpath|outputdirectory)$/i.test(a) && rest[i + 1]) out.push(rest[++i]);
      else if (!/^-/.test(a)) {
        out.push(a);
        break;
      }
    }
  } else if (cmd === 'zip') {
    const pos = positional(rest);
    if (pos.length) out.push(pos[0]);
  } else if (cmd === 'tar') {
    // 只有建立／附加／更新模式（-c／-r／-u、--create／--append／--update）才是寫入；--list、-x 是讀取
    const flag = (a, i) => !/^--/.test(a) && (i === 0 || /^-/.test(a)) && /^-?[A-Za-z]+$/.test(a);
    const writing = rest.some((a, i) => /^--(?:create|append|update)$/.test(a) || (flag(a, i) && /[cru]/.test(a.replace(/^-/, ''))));
    if (writing) {
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        const fm = /^--file=(.+)$/.exec(a);
        if (fm) out.push(fm[1]);
        else if (a === '--file' && rest[i + 1]) out.push(rest[i + 1]);
        else if (flag(a, i) && /f$/.test(a) && rest[i + 1]) out.push(rest[i + 1]);
      }
    }
  } else if (/^(out-file|set-content|add-content|export-csv|new-item|copy-item|move-item|cpi|copy|move|mi)$/.test(cmd)) {
    // 只有這些具名參數帶值；其他 -Xxx 是開關（-Force、-Append、-NoNewline…），不得吃掉後面的位置參數
    const VALUE_PARAMS = new Set(['-path', '-filepath', '-literalpath', '-destination', '-value', '-encoding',
      '-inputobject', '-itemtype', '-name', '-delimiter', '-width', '-stream', '-filter', '-include', '-exclude']);
    const named = {};
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      const kv = /^(-[A-Za-z]+):(.+)$/.exec(a);
      if (kv) {
        named[kv[1].toLowerCase()] = kv[2];
      } else if (/^-[A-Za-z]+:?$/.test(a)) {
        const k = a.replace(/:$/, '').toLowerCase();
        if (VALUE_PARAMS.has(k) && i + 1 < rest.length) named[k] = rest[++i];
        else named[k] = true;
      } else {
        pos.push(a);
      }
    }
    const val = (...ks) => ks.map((k) => named[k]).find((v) => typeof v === 'string');
    if (/^(copy-item|move-item|cpi|copy|move|mi)$/.test(cmd)) {
      const dest = val('-destination') || pos[1] || (pos.length === 1 && val('-path', '-literalpath') ? pos[0] : undefined);
      const src = val('-path', '-literalpath') || pos[0];
      if (dest) out.push(...copyTargets(dest, src ? [src] : [], ctx));
    } else {
      let t = val('-filepath', '-path', '-literalpath') || pos[0];
      if (cmd === 'new-item') {
        // New-Item：-ItemType Directory 是開資料夾（不管）；-Name 給了檔名時，落點＝-Path 底下的 -Name
        if (/^dir/i.test(String(val('-itemtype') || ''))) {
          // 開資料夾不管，但記下來：同一條指令後面 Copy-Item 到它時要當目錄看
          let dpath = t && typeof named['-name'] === 'string' ? t.replace(/[\\/]+$/, '') + '/' + named['-name'] : t;
          if (dpath && dpath.indexOf('$') >= 0 && ctx.expand) dpath = ctx.expand(dpath);
          if (dpath && ctx.madeDirs) {
            const abs = path.resolve(ctx.cwd || ctx.root, G.nativePath(dpath));
            ctx.madeDirs.add(CI ? abs.toLowerCase() : abs);
          }
          t = undefined;
        }
        else if (t && typeof named['-name'] === 'string') t = t.replace(/[\\/]+$/, '') + '/' + named['-name'];
        else if (!t && typeof named['-name'] === 'string') t = named['-name'];
      }
      if (t) out.push(t);
    }
  }
  return out;
}

// 回 [{ p, cwd }]：每段的相對路徑以「這一段執行當下的目錄」解析（同指令前面 cd 過就以那裡為準）
function bashTargets(command, ctx) {
  const sh = G.scanShell(command, { ps: ctx.ps });
  const targets = [];
  ctx.madeDirs = new Set(); // 同一條指令前面 mkdir 建的目錄（各段共用）
  let pos = 0;
  while (pos <= sh.bare.length) {
    const end = G.segmentEnd(sh, pos);
    const seg = sh.code.slice(pos, end);
    if (seg.trim()) {
      const d = G.cdChain(sh, pos, ctx.cwd);
      const segCtx = Object.assign({}, ctx, { cwd: typeof d === 'string' ? d : null });
      const segPos = pos;
      segCtx.expand = (p) => {
        const v = G.expandValue(sh, p, { beforeIdx: segPos, cwd: segCtx.cwd || ctx.cwd });
        return v === null ? null : G.nativePath(v);
      };
      for (let p of segmentTargets(seg, segCtx)) {
        // 目標裡的 $PWD／${VAR}／$env:X 先展開（值取同指令賦值或 process env；$PWD 用該段當下目錄）；
        // 展開不了（變數沒值、命令替換）＝無從判斷 → 這個目標放行
        if (p.indexOf('$') >= 0) {
          const v = G.expandValue(sh, p, { beforeIdx: pos, cwd: segCtx.cwd || ctx.cwd });
          if (v === null) continue;
          p = G.nativePath(v);
        }
        // cd 到變數等解析不出的目錄：相對路徑無從判斷（放行），絕對路徑照判
        if (segCtx.cwd === null && !path.isAbsolute(G.nativePath(p))) continue;
        targets.push({ p, cwd: segCtx.cwd || ctx.cwd });
      }
    }
    if (end >= sh.bare.length) break;
    pos = end + 1;
  }
  return targets;
}

function main() {
  const input = G.readInput();
  if (!input) return;
  const got = G.loadSection(input, 'report_hygiene', (s) => G.isObj(s) && G.strList(s.roots) && s.roots.length > 0);
  if (!got) return;
  const sec = got.sec;
  // 有寫但型別錯（process_ext_regex／work_dir 不是字串）＝設定壞 → 整支放行，不退回預設規則擋人
  if (sec.process_ext_regex !== undefined && typeof sec.process_ext_regex !== 'string') return;
  if (sec.work_dir !== undefined && typeof sec.work_dir !== 'string') return;
  const procRe = G.re(typeof sec.process_ext_regex === 'string' ? sec.process_ext_regex : DEFAULT_PROCESS_EXT);
  if (!procRe) return;
  const workDir = typeof sec.work_dir === 'string' && sec.work_dir ? sec.work_dir : '_work';
  const roots = sec.roots;
  const ti = G.isObj(input.tool_input) ? input.tool_input : {};
  const tool = String(input.tool_name || '');
  const ps = tool === 'PowerShell'; // portable-ok: 比對 Claude Code 工具名稱字串（反斜線是路徑分隔），不是呼叫系統指令
  const ctx = { root: got.loc.root, cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : got.loc.root, ps };
  const hits = [];

  let targets = [];
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    targets = [{ p: ti.file_path || ti.notebook_path || '', cwd: ctx.cwd }];
  } else if (typeof ti.command === 'string' && ti.command) {
    targets = bashTargets(ti.command, ctx);
  }
  for (const t of targets) {
    const why = violation(underRoot(projectRel(t.p, Object.assign({}, ctx, { cwd: t.cwd })), roots), procRe, workDir);
    if (why && hits.indexOf(why) < 0) hits.push(why);
  }
  if (!hits.length) return;
  G.deny(G.listMessage('[report-output] 交付資料夾紀律', hits,
    '交付結構（納管交付根：' + roots.join('、') + '）：\n'
    + '  〈交付根〉/〈主題〉_〈YYYYMMDD〉/〈最終交付檔〉   ← 第一層只放最終交付檔\n'
    + '  〈交付根〉/〈主題〉_〈YYYYMMDD〉/' + workDir + '/          ← 其餘一切過程產物全收這裡\n'
    + '改寫到正確位置後重發。qa-flow.sh run 的 junit（tests/e2e/reports/）是回歸資產，不受本閘管。\n'
    + '規則來源：專案 tests/e2e/qa-webwright.json 的 report_hygiene；特殊情況需破例先向使用者確認。'));
}

try {
  main();
} catch (_) {
  process.exitCode = 0; // FAIL-OPEN
}
