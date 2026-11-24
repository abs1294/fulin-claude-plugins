#!/usr/bin/env node
// api-use.js — 健檢第 1 步：這個專案自己的程式有沒有呼叫 Claude API。
//
// 用法：node api-use.js <落點> [--out <檔.json>]
//
// 為什麼：`/claude-api cost-optimize` 優化的是「專案程式呼叫 Claude API」的花費，沒有呼叫的專案跑了沒東西可看。
// 有呼叫才在決策單提醒使用者可以跑；健檢不代跑（它會問人、花錢的步驟要先核可，背景跑沒人能答）。
//
// 只讀原始碼，不執行專案程式、不寫專案、不叫模型、不連網。輸出只有檔名（專案內相對路徑）、行號與種類，不含程式原文。
//
// 怎麼算：
//   - 「呼叫」＝程式碼裡真的引用 SDK（import／require／using…）、打 api.anthropic.com（整個網址、或只寫主機名），或用
//     Bedrock／Vertex 的 Claude 模型名。查訂閱用量（/api/oauth/）不是呼叫模型，不算。
//   - 「只有宣告」＝相依檔（package.json、requirements.txt…）列了 SDK，程式碼沒有任何地方引用：不算有呼叫，另列。
//   - 「只有測試」＝只在測試、夾具裡用到：不算有呼叫，另列數目。
//   - 不算：註解（整行、行尾、區塊）、Python 三引號字串的內容、文件（.md／.txt）、壓縮過的檔（檔名 .min.，或平均每行超過 500 字元）、
//     第三方與產生物目錄、`.claude/`（agent、skill、hook 不是專案的程式）。
//   - `claude -p` 這種起 Claude Code 子程序的不算：它走的是 Claude Code，不是專案自己呼叫 API。
//
//   - 太大（1 MB 以上）或讀不到的檔不看，列在 notes（最多 10 個），不能當成「沒有呼叫」。
//
// 結束碼：0 正常（有沒有呼叫看輸出的 uses）；2 參數或目錄錯誤。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const root = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
if (!root) { console.error('用法：node api-use.js <落點> [--out <檔>]'); process.exit(2); }
try { if (!fs.statSync(root).isDirectory()) throw 0; } catch { console.error('找不到落點目錄：' + root); process.exit(2); }

const THIRD = /^(node_modules|bower_components|vendor|third_party|\.git|\.hg|\.svn|\.claude|site-packages|Pods)$/i;
// 不是 git 專案時，產生物要自己認（git 專案由 .gitignore 決定：有的專案把程式放 bin/、packages/）
const BUILT = /^(dist|build|out|obj|target|coverage|\.next|\.nuxt|\.venv|venv|__pycache__|\.gradle|\.idea|\.vs)$/i;
const TEST = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|mocks?|[^/]+\.(?:Unit|Integration)?Tests?)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.(?:py|go|rb)$/i, TEST_CLASS = /(?:Tests?|Spec)\.(?:cs|vb|fs|java|kt|kts|scala|swift)$/;
const CODE = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|py|ipynb|cs|vb|fs|java|kt|kts|scala|go|rb|php|rs|swift|dart|ex|exs|sh|bash|ps1|lua|r)$/i;
const DECLARES = /^(package\.json|requirements[^/\\]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|.*\.csproj|.*\.fsproj|Directory\.Packages\.props|packages\.config|pom\.xml|build\.gradle(\.kts)?|go\.mod|Gemfile|composer\.json|Cargo\.toml)$/i;
const MAX_FILE = 1024 * 1024, MINIFIED = 500, MAX_FILES = 60000, MAX_HITS = 30;

// 種類 → 樣子。SDK 一律要是「引用」的寫法，不是名字出現就算。
const USES = [
  ['官方 SDK（JavaScript／TypeScript）', /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)['"`]@anthropic-ai\/(?:sdk|bedrock-sdk|vertex-sdk|foundry-sdk|claude-agent-sdk)(?:\/[^'"`]*)?['"`]/],
  ['官方 SDK（Python）', /\b(?:import_module|__import__)\(\s*['"](?:anthropic|claude_agent_sdk)\b/],
  ['官方 SDK（Python）', /(?:^|[:;]|>>>)\s*(?:from\s+(?:anthropic|claude_agent_sdk)(?:\.[\w.]+)?\s+import\b|import\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*(?:anthropic|claude_agent_sdk)(?![\w]))/],
  ['官方 SDK（C#）', /\bnew\s+(?:global::)?Anthropic\.[\w.]+\s*[({]/],
  ['官方 SDK（F#）', /^\s*open\s+Anthropic(?:\.[\w.]+)?\s*$/],
  ['官方 SDK（C#）', /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?Anthropic(?:\.[\w.]+)?\s*;/],
  ['官方 SDK（Java／Kotlin）', /(?<![\w.'"`\/])com\.anthropic\.\w/],
  ['官方 SDK（Go）', /["`]github\.com\/anthropics\/anthropic-sdk-go(?:\/[^"`]*)?["`]/],
  ['官方 SDK（Ruby）', /^\s*require\s*\(?\s*['"]anthropic['"]|(?<![\w:\\])Anthropic::[A-Z]/],
  ['官方 SDK（VB）', /^\s*Imports\s+Anthropic(?:\.[\w.]+)?\s*$/i],
  ['官方 SDK（PHP）', /^\s*use\s+\\?Anthropic(?:\\|\s*;)|(?<![\w\\])\\Anthropic(?:::|\\)|(?<![\w\\])Anthropic::[a-z]/],
  ['社群 SDK', /^\s*use\s+anthropic(?:_\w+)?(?:::|\s*;)|['"]package:anthropic\w*\/|^\s*import\s+SwiftAnthropic\b|\bAnthropix\b|\blibrary\(\s*['"]?anthropic\b/],
  ['框架的 Claude 介接', /(?:from\s+['"]|require\(\s*['"]|from\s+|import\s+)(?:@langchain\/anthropic|@ai-sdk\/anthropic|langchain_anthropic|llama_index\.llms\.anthropic|pydantic_ai\.models\.anthropic)\b/],
  ['直接打 API', /api\.anthropic\.com\/v1\/(?:messages|complete)|(?:https?:\/\/|["'`])api\.anthropic\.com(?:\/v1)?\/?(?=["'`\s)]|$)/],
  ['Bedrock 的 Claude 模型', /["'`](?:(?:us|eu|apac|jp|au|global)\.)?anthropic\.claude-[\w.:-]+["'`]/],
  ['Vertex 的 Claude 模型', /publishers\/anthropic\/models\/|["'`]claude-[\w.-]+@\d{8}["'`]/],
  ['經轉接的 Claude 模型', /["'`](?:vertex_ai|bedrock|anthropic|azure_ai|openrouter\/anthropic)\/(?:[\w.]+\.)?claude-[\w.@:-]+["'`]/],
];
const DECLARED = /@anthropic-ai\/(?:sdk|bedrock-sdk|vertex-sdk|foundry-sdk|claude-agent-sdk)\b|@langchain\/anthropic\b|@ai-sdk\/anthropic\b|com\.anthropic\b|anthropics\/anthropic-sdk-go\b|anthropic-ai\/sdk\b|(?:Include|id)\s*=\s*"Anthropic(?:\.[\w.]+)?"|(?:^|["'\s])(?:anthropic|claude-agent-sdk|langchain-anthropic)(?=\s*(?:["']|[=<>~!\[]|$))/;
const notes = [];
const oneLine = (x) => x.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');   // 檔名可以有換行：輸出只佔一行
// 每種語言的註解寫法（CODE 列的副檔名都要在這裡，測試逐一核對）：line 行註解、block 區塊註解 [起, 迄]、quote 一行內的字串、multi 可跨行的字串、drop 整段拿掉的字串
const C_LIKE = { line: ['//'], block: [['/*', '*/']], quote: '"\'', multi: ['`'] };
const HASH = { line: ['#'], quote: '"\'' };
const LANG = {};
for (const e of 'js mjs cjs jsx ts mts cts tsx cs java kt kts scala go rs swift dart'.split(' ')) LANG[e] = C_LIKE;
for (const e of ['vue', 'svelte']) LANG[e] = { ...C_LIKE, block: [['/*', '*/'], ['<!--', '-->']] };
LANG.php = { ...C_LIKE, line: ['//', '#'], block: [['/*', '*/'], ['<!--', '-->']] };
LANG.py = LANG.ipynb = { ...HASH, drop: ['"""', "'''"] };
for (const e of ['sh', 'bash', 'r', 'ex', 'exs']) LANG[e] = HASH;
LANG.rb = { ...HASH, block: [['\n=begin', '\n=end']] };
LANG.ps1 = { ...HASH, block: [['<#', '#>']] };
LANG.lua = { line: ['--'], block: [['--[[', ']]']], quote: '"\'' };
LANG.vb = { line: ["'"], quote: '"' };
LANG.fs = { line: ['//'], block: [['(*', '*)']], quote: '"' };
// 把註解剝掉，只留程式與一般字串（網址、套件名寫在字串裡），行號不變。Python 的三引號字串整段拿掉（docstring、提示詞常數）。
// 這裡不是完整的語法分析：分不清時當成程式（多列由人確認），不當成註解（會漏）——
// 區塊註解與三引號到檔尾都沒關就不算；/* 前面要是空白、行首或標點（image/*、正則 [^/*] 不是）、前面是反斜線或 [ 的 // 是正則，前面是冒號的 // 是網址，# 前面要是空白或行首（Python、PHP 除外）；一行內沒關的引號當一般字元
function stripped(text, ext) {
  const g = LANG[ext.slice(1).toLowerCase()], anyHash = /^\.(?:py|ipynb|php)$/i.test(ext);
  const eol = (k) => { const e = text.indexOf('\n', k); return e < 0 ? text.length : e; };
  // 結尾記號的位置，被反斜線跳脫的不算
  const close = (mark, from) => { for (let e = text.indexOf(mark, from); e >= 0; e = text.indexOf(mark, e + 1)) { let b = 0; while (text[e - 1 - b] === '\\') b++; if (b % 2 === 0) return e; } return -1; };
  const opens = [];   // [起, 迄, 內容留不留, 迄可不可以跳脫]
  for (const [a, b] of g.block || []) opens.push([a, b, false, false]);
  for (const q of g.multi || []) opens.push([q, q, true, true]);
  for (const q of g.drop || []) opens.push([q, q, false, true]);
  const isLine = (k) => (g.line || []).some((m) => {
    if (!text.startsWith(m, k)) return false;
    const prev = text[k - 1] || '\n';
    if (m === '//') return !/[\\[:]/.test(prev);
    if (m === '#') return anyHash ? !(/^\.php$/i.test(ext) && text[k + 1] === '[') : /\s/.test(prev);
    return true;
  });
  const none = new Set();   // 後面已經沒有結尾的記號，不再找
  let out = '', k = 0;
  if (g.block && g.block.some(([a]) => a[0] === '\n')) text = '\n' + text;   // 記號在行首的（=begin）：第一行也要認得
  const lead = text[0] === '\n' && g.block && g.block.some(([a]) => a[0] === '\n');
  while (k < text.length) {
    const ch = text[k], prev = text[k - 1] || '', op = opens.find(([a, b]) => !none.has(b) && text.startsWith(a, k));
    if (op && !(op[0] === '/*' && !/^[\s;,(){}\]>=]?$/.test(prev)) && !(op[0] === '(*' && text[k + 2] === ')')) {
      const from = k + op[0].length, e = op[3] ? close(op[1], from) : text.indexOf(op[1], from);
      if (e >= 0) { const body = text.slice(k, e + op[1].length); out += op[2] ? body : ' ' + body.replace(/[^\n]+/g, ''); k = e + op[1].length; if (op[1][0] === '\n') k = eol(k); continue; }
      none.add(op[1]);
    }
    if (isLine(k)) { k = eol(k); continue; }
    if ((g.quote || '').includes(ch)) {
      const raw = ch === '"' && /^\.(?:cs|vb|fs)$/i.test(ext) && (prev === '@' || /^\.vb$/i.test(ext));   // 逐字字串的反斜線不是跳脫
      let e = k + 1; while (e < text.length && text[e] !== ch && text[e] !== '\n') e += text[e] === '\\' && !raw ? 2 : 1;
      if (text[e] === ch) { out += text.slice(k, e + 1); k = e + 1; continue; }
    }
    out += ch; k++;
  }
  const lines = out.split('\n');
  return lead ? lines.slice(1) : lines;
}
const decode = (b) => (b.length > 1 && b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.length > 1 && b[0] === 0xfe && b[1] === 0xff ? Buffer.from(b).swap16().toString('utf16le') : b.toString('utf8'));
const skippedFiles = [];
const skip = (f, why) => { skipped++; if (skippedFiles.length < 10) skippedFiles.push(oneLine(f) + '（' + why + '）'); };
// git 專案：追蹤中的加上還沒追蹤但沒被忽略的；裡面另有 git repo（submodule、沒追蹤的）的進去照樣看；不是 git 就自己走目錄
function list(dir = root, pre = '', depth = 0) {
  const g = spawnSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  // 列出 ./ 的是「這個目錄自己不是 repo、被外層列成一項」（沒初始化的 submodule、外層沒追蹤的目錄）：照一般目錄走
  if (g.status === 0 && (g.stdout || depth) && !/(?:^|\0)\.\/(?:\0|$)/.test(g.stdout)) {
    const out = [];
    for (const f of new Set((g.stdout || '').split('\0').filter(Boolean))) {
      if (f.split('/').filter(Boolean).some((d, k, a) => (k < a.length - 1 || f.endsWith('/')) && THIRD.test(d))) continue;
      let isDir = f.endsWith('/'); if (!isDir) try { isDir = fs.lstatSync(path.join(dir, f)).isDirectory(); } catch {}
      if (!isDir) out.push(pre + f);
      else if (THIRD.test(path.posix.basename(f.replace(/\/$/, '')))) continue;
      else if (depth < 5) out.push(...list(path.join(dir, f), pre + f.replace(/\/?$/, '/'), depth + 1));
      else notes.push('太深的 git repo 沒有看：' + oneLine(pre + f));
    }
    return out;
  }
  const out = [], walk = (d, rel) => {
    if (out.length > MAX_FILES * 5) { if (!notes.some((n) => /走到/.test(n))) notes.push(`檔案太多，走到 ${out.length} 個就停，後面的沒有看`); return; }
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { notes.push('讀不到目錄：' + oneLine(rel || '.')); return; }
    for (const e of es) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!THIRD.test(e.name) && !BUILT.test(e.name) && !(e.name.toLowerCase() === 'bin' && es.some((x) => /^obj$|\.(?:cs|vb|fs)proj$/i.test(x.name)))) walk(path.join(d, e.name), r); } else if (e.isFile()) out.push(pre + r);
    }
  };
  walk(dir, '');
  return out;
}

let files = list().filter((f) => { const b = path.posix.basename(f); return (CODE.test(b) && !/\.min\./i.test(b)) || DECLARES.test(b); });
if (files.length > MAX_FILES) { notes.push(`檔案太多（${files.length}），只看前 ${MAX_FILES} 個`); files = files.slice(0, MAX_FILES); }
const calls = [], declared = [];
// 讀檔前看實際位置：經過連結（symlink、junction）跑到專案外的、已不存在的不讀（null）；看不出實際位置的算沒看（undefined）；同一個檔經兩條路徑只看一次
const realpath = fs.realpathSync.native, realRoot = (() => { try { return realpath(root); } catch { return root; } })(), realDirs = new Map(), seenFiles = new Set();
const realOf = (abs) => {
  const d = path.dirname(abs);
  if (!realDirs.has(d)) { let r = null; try { r = realpath(d); } catch {} realDirs.set(d, r); }
  if (!realDirs.get(d)) { try { fs.lstatSync(abs); } catch { return null; } return undefined; }   // 已刪除還在索引裡的：不算沒看
  let r = path.join(realDirs.get(d), path.basename(abs));
  try { if (fs.lstatSync(r).isSymbolicLink()) { r = realpath(r); if (!fs.statSync(r).isFile()) return null; } } catch { return null; }
  const rel = path.relative(realRoot, r);
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) ? null : r;
};
let scanned = 0, skipped = 0, callsTotal = 0, testsTotal = 0;
for (const f of files) {
  const abs = path.join(root, f), base = path.posix.basename(f), ext = (/\.[^.]+$/.exec(base) || [''])[0];   // 整個檔名就是 .js 的也算
  const real = realOf(abs);
  if (real === undefined) { skip(f, '讀不到'); continue; }
  if (real === null || seenFiles.has(real)) continue;
  seenFiles.add(real);
  const at = path.relative(realRoot, real).split(path.sep).join('/');   // 實際位置：算不算測試、第三方都看它
  if (at !== f && at.split('/').slice(0, -1).some((d) => THIRD.test(d))) continue;
  let t; try { const st = fs.statSync(abs); if (st.size > MAX_FILE) { skip(f, '超過 1 MB'); continue; } const b = fs.readFileSync(abs); t = decode(b.length % 2 && b[0] === 0xfe ? b.subarray(0, b.length - 1) : b); } catch { if (fs.existsSync(abs)) skip(f, '讀不到'); continue; }
  const lines = t.split(/\r?\n/);
  if (DECLARES.test(base)) { scanned++; lines.forEach((l, i) => { if (!/^\s*(?:#|\/\/|<!--)/.test(l) && DECLARED.test(l) && declared.length < MAX_HITS) declared.push({ at: oneLine(f) + ':' + (i + 1) }); }); continue; }
  if (/anthropi[cx]|claude_agent_sdk|claude-/i.test(t) === false) { scanned++; continue; }
  // 壓縮過的：平均每行很長。只有一兩行長（把提示詞寫在一行）的照樣看
  if (t.length / lines.length > MINIFIED && t.length > 20000 && !/\.ipynb$/i.test(base)) { skip(f, '看起來是壓縮過的'); continue; }
  scanned++;
  const nb = ext.toLowerCase() === '.ipynb', bare = nb ? lines : stripped(lines.join('\n'), ext);
  lines.forEach((l, i) => {
    if (!/anthropi[cx]|claude_agent_sdk|claude-/i.test(l)) return;
    // 筆記本一格一行是 JSON 字串："import anthropic\n",
    const cells = nb ? (l.match(/"(?:[^"\\]|\\.)*"/g) || []).map((x) => { try { return JSON.parse(x); } catch { return ''; } }).flatMap((x) => stripped(x, ext)) : [bare[i]];
    const k = USES.find(([, re]) => cells.some((s) => re.test(s)));
    if (!k) return;
    if (TEST.test(at) || TEST_CLASS.test(at)) { testsTotal++; return; }
    callsTotal++; if (calls.length < MAX_HITS) calls.push({ at: oneLine(f) + ':' + (i + 1), kind: k[0] });
  });
}
if (skipped) notes.push(`沒看的檔 ${skipped} 個，不能當成沒有呼叫：${skippedFiles.join('、')}${skipped > skippedFiles.length ? '…' : ''}`);
const result = { uses: callsTotal > 0, callsTotal, calls, testsOnly: callsTotal === 0 && testsTotal > 0, testsTotal, declaredOnly: callsTotal === 0 && testsTotal === 0 && declared.length > 0, declared, scanned, skipped, notes };
if (opt('--out')) { const o = path.resolve(opt('--out')); try { fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, JSON.stringify(result, null, 1)); } catch (e) { console.error('寫不進 --out 指定的檔：' + o + '（' + e.code + '）'); process.exit(2); } }
console.log(`呼叫 Claude API：${result.uses ? '有，' + callsTotal + ' 處' : result.testsOnly ? '沒有（只有測試裡用到，' + testsTotal + ' 處）' : result.declaredOnly ? '沒有（相依檔列了 SDK，程式沒有引用）' : '沒有'}；看了 ${scanned} 個檔，沒看的 ${skipped} 個`);
for (const c of calls) console.log(`  ${c.at}｜${c.kind}`);
if (callsTotal > calls.length) console.log(`  還有 ${callsTotal - calls.length} 處沒列`);
if (result.declaredOnly) for (const d of declared) console.log(`  ${d.at}｜只有宣告`);
for (const n of notes) console.log('  注意：' + n);
