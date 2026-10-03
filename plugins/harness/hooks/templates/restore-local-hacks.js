#!/usr/bin/env node
// 救回腳本：把備份目錄裡的本機覆寫套回工作區（三環防線的「救」）。
//
// 【範本】由 /harness:init 與 backup-local-hacks.js／guard-local-hack-destroy.js／check-local-hacks-alive.js
// 一起複製到目標專案 `.claude/hooks/`。它不是 hook、不需要接線；另外三支的訊息都指向它——
// 只複製那三支而漏了這支，訊息就是在說謊的指路。
//
// 為什麼要有這支：沒有它，備份等於只有一半——patch 在那裡，但出事當下沒人記得
// 該對哪個 repo `git apply` 哪個檔，而那正是最不該現查文件的時刻。
//
// 用法（在工作目錄根執行）：
//   node .claude/hooks/restore-local-hacks.js                 # 只檢查，列出誰不見了（不改檔）
//   node .claude/hooks/restore-local-hacks.js --restore       # 實際救回（只補不見的）
//   node .claude/hooks/restore-local-hacks.js --restore --all # 全部重套（含仍有改動的；多半會因基準不符而失敗）
//   node .claude/hooks/restore-local-hacks.js --list          # 列出所有備份與時間
// 結束碼：檢查模式有可救項目＝2、沒有＝0；找不到清單或清單為空＝1；救回有失敗＝1。
//
// 檢查模式另列「有改動、但內容與最新備份不同」：dirty 只證明與 HEAD 不同，不證明覆寫值還在
// （可能被部分覆寫或被別的改動取代）——稽核要比對內容。這一類只提示、不自動套。
// 被清空、刪除的檔（wipedReason）算「不見了」：救回時追蹤中的檔先寫回 HEAD 內容再套 patch
// （patch 的基準是 HEAD）；「目前」那份備份若已被舊版腳本蓋成刪除形狀，改用最新一份正常的歷史版本（findBackup）。
// 清單條目的 needed-when 條件不成立（這個分支用不到）的不檢查也不救；requires 缺字串的另列提示。
// 行數比參考版少一半以上（shrunkReason）只列出、不當成不見了——可能是刻意縮短，自動救回會用舊版蓋掉它。
// 實際救回前，目前還有內容的檔先另存成 <備份名>.<時間>.before-restore，判準誤判時也不會丟掉現況。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 覆寫清單檔（相對於工作目錄根）。與 git-commit plugin 的 flow.sh 讀同一份檔、同一個格式。
const OVERRIDES_REL = '.claude/local-overrides.yml';
// 備份目錄（相對於工作目錄根），與 backup-local-hacks.js 的同名常數一致。
const BACKUP_DIR_REL = '.claude/hack-backups';
// 本腳本自己的呼叫字串（只用在訊息）。
const RESTORE_CMD = 'node .claude/hooks/restore-local-hacks.js';
// 沒有備份時去哪裡查該補什麼值（留空字串＝提示看清單每筆的 reason 欄）。
const SETUP_DOC = '';
// ────────────────────────────────────────────────────────────────────────────

// ── 覆寫清單解析（backup／guard／alive／restore 四支各帶一份同樣的實作，改一支要同步另外三支）──
// 格式正本＝git-commit plugin 的 local-overrides.example.yml 與 flow.sh 的 parse_overrides_for_repo：
//   <頂層 key>:          區塊識別鍵
//     repo: <值>         "." ＝工作目錄本身；多 repo workspace 用子目錄名或 remote 的 repo 名
//     files:
//       - path: <相對於該 repo 的精確路徑>
//         reason: ...
//         requires: <字串>               選填：這個覆寫檔一定要含有的字串；要好幾個時重複寫 `requires:`，或寫成
//                                        `requires:` 下面接 `- 字串` 清單、`requires: |` 下面一行一個。檔案在、但缺了它＝
//                                        帶到的是舊版覆寫（例：舊版 mock 的發號方式會撞號），alive／restore 會點名。
//                                        挑能代表該能力、不容易被改名的識別字；不拿整檔比，覆寫本來就允許各處不同。
//         needed-when-file: <路徑>       選填，與下一行成對：只有這個檔（相對於該 repo）含有指定字串時，
//         needed-when-contains: <字串>     這筆覆寫才算需要。用在「只在某些分支才需要的覆寫」——例：本機 mock
//                                        類別只在有注入它的分支才需要，切到沒有該功能的分支時補回去反而編譯不過；
//                                        不設的話每次開場都會報它不見了。判準檔讀不到就當需要（寧可多報，不可漏報）。
//   這三個選填欄位只有 alive 與 restore 會用（四支都帶同一份解析，backup／guard 只讀不用）；flow.sh 只認 path，
//   多寫不影響它。欄位要跟 `path` 同一層縮排
//   （更深的、或寫在 `reason: |` 多行字串裡的不算）；沒加引號的值，` #` 之後視為註解。
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

// 選填欄位的值：引號包住的取引號內；沒有引號的去掉行尾註解（`requires: TOKEN  # 說明` 只取 TOKEN，
// 否則這個字串永遠找不到、每次開場都誤報「內容不完整」）
function fieldValue(v) {
  v = String(v).trim();
  if (v.length > 1 && (v[0] === '"' || v[0] === "'")) {
    const end = v.indexOf(v[0], 1);
    if (end > 0) return v.slice(1, end);
  }
  return v.replace(/\s+#.*$/, '').trim();
}

function loadEntries(root) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(root, OVERRIDES_REL), 'utf8'); } catch (e) { return []; }
  const out = [];
  let key = null, repo = null, cur = null, propIndent = -1, reqBlock = null;
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    let m = line.match(/^([^\s#][^:]*):\s*$/);
    if (m) { key = m[1].trim(); repo = null; cur = null; reqBlock = null; continue; }
    m = line.match(/^\s+repo:\s*(.+?)\s*$/);
    if (m) { repo = unquote(m[1]); continue; }
    m = line.match(/^(\s*-\s*)path:\s*(.+?)\s*$/);
    if (m) {
      cur = null; reqBlock = null;
      if (key || repo) {
        cur = { key: key, repo: repo, file: unquote(m[2]).split('\\').join('/'), requires: [], whenFile: null, whenContains: null };
        out.push(cur);
        propIndent = m[1].length;   // 條目屬性的縮排＝`path` 這個字的起始欄
      }
      continue;
    }
    if (!cur) continue;
    // 選填欄位只認「跟 path 同一層」的行：更深的是別的屬性底下的子項或多行字串的內容
    // （`notes:` 底下、`reason: |` 的內文裡出現 `requires:` 都不算）；更淺的代表這筆條目已經結束。
    // 例外：`requires:` 後面沒有值（下面接 `- 字串` 清單）或是 `|`／`>`（下面接多行字串）時，
    // 更深的那幾行是它的值，每個清單項目或每一行算一個必須含有的字串
    const indent = line.match(/^\s*/)[0].length;
    if (indent < propIndent) { cur = null; reqBlock = null; continue; }
    if (indent > propIndent) {
      if (reqBlock) {
        const item = reqBlock === 'list' ? line.match(/^\s*-\s*(.+?)\s*$/) : [null, line.trim()];
        const v = item ? fieldValue(item[1]) : '';
        if (v) cur.requires.push(v);
      }
      continue;
    }
    reqBlock = null;
    m = line.match(/^\s+requires:\s*(.*?)\s*$/);
    if (m) {
      const raw = m[1].replace(/\s+#.*$/, '');
      if (!raw) reqBlock = 'list';
      else if (/^[|>][-+]?$/.test(raw)) reqBlock = 'block';
      else { const v = fieldValue(m[1]); if (v) cur.requires.push(v); }
      continue;
    }
    m = line.match(/^\s+needed-when-file:\s*(.+?)\s*$/);
    if (m) { cur.whenFile = fieldValue(m[1]).split('\\').join('/') || null; continue; }
    m = line.match(/^\s+needed-when-contains:\s*(.+?)\s*$/);
    if (m) { cur.whenContains = fieldValue(m[1]) || null; continue; }
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
// status 列出有改動、但工作區與 index 都跟 HEAD 相同，也算 'clean'：換行自動轉換（core.autocrlf）時會出現
// 這種假改動，覆寫值其實已經不在了（實測：HEAD 存 LF、autocrlf=true、工作區是 CRLF，status 是 M、diff HEAD 是空的）。
// 兩邊都要看：覆寫只留在 index（工作區已改回、status 是 MM）時 diff HEAD 也是空的，但 reset --hard 照樣會把它丟掉。
function fileState(dir, file) {
  let out;
  try { out = git(dir, ['status', '--porcelain', '--ignored', '--', file]); } catch (e) { return null; }
  const line = out.split(/\r?\n/).find(Boolean);
  if (!line) return 'clean';
  const xy = line.slice(0, 2);
  if (xy === '??') return 'untracked';
  if (xy === '!!') return 'ignored';
  try {   // 還沒有 commit 的 repo 會丟例外，照舊當有改動
    if (!git(dir, ['diff', 'HEAD', '--', file]).trim() && !git(dir, ['diff', '--cached', '--', file]).trim()) return 'clean';
  } catch (e) {}
  return 'tracked';
}

// 整檔被清空或刪除時 `git diff` 的形狀：刪除檔案，或某個 hunk 的新內容是 0 行（@@ -1,191 +0,0 @@）。
// 這種 patch 不是覆寫，是「覆寫連同整份檔一起不見」。
function isWipePatch(patch) {
  return /^deleted file mode /m.test(patch) || /^\+\+\+ \/dev\/null\s*$/m.test(patch) ||
    /^@@ -\d+(?:,\d+)? \+0,0 @@/m.test(patch);
}

// 行數：結尾的換行不算多一行（"a\nb\n" 是 2 行）
function lineCount(text) {
  return text ? text.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
}

// 覆寫檔被清空或刪除的判準。在 git 眼中「整檔刪光」也是一種改動，只看有沒有改動會把它當成「還在」，
// 下一次備份還會把唯一一份正常的 patch 蓋成刪除形狀——來源專案實際發生過：寄信服務的覆寫檔被清成 0 bytes，
// 一分鐘內備份就被蓋掉，之後救回套的是刪除、不是覆寫。回傳原因字串；沒被清空回 null；讀不到（權限等）也回 null，不判。
// 只看檔案本身：不在，或 0 bytes。刻意不看 diff 的形狀——`git rm --cached` 之後檔案內容完好，
// `git diff HEAD` 卻是整檔刪除的形狀，看 diff 會把它誤判成清空、救回時蓋掉現況（審查時實跑重現）；
// 只剩 BOM 或空白這類「有內容的清空」不判（已知極限）。
// 也刻意不含「行數大幅減少」：覆寫本身就可能是合法的大幅縮短，當成「不見了」會讓 backup 永遠不存新版、
// restore 用舊備份蓋掉現行覆寫（審查時實跑重現過這個資料遺失）。行數大幅減少只走 shrunkReason 提醒。
function wipedReason(dir, ent) {
  let text;
  try { text = fs.readFileSync(path.join(dir, ent.file), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? '檔案不在' : null;
  }
  return text.length ? null : '0 bytes';
}

// 行數不到參考值的一半（追蹤中的檔參考 HEAD 那份；未追蹤／被排除的參考 refText＝最新的整份備份）。
// 可能是被截斷，也可能是刻意的縮短，所以只提醒、不當成不見了：backup 照存（前一版自動留在歷史版本），
// alive 不報，restore 檢查模式列出供人判斷。回傳原因字串或 null。
function shrunkReason(dir, ent, state, refText) {
  let text;
  try { text = fs.readFileSync(path.join(dir, ent.file), 'utf8'); } catch (e) { return null; }
  if (!text.length) return null;
  let ref = refText || null;
  if (state === 'tracked') { try { ref = git(dir, ['show', 'HEAD:./' + ent.file]); } catch (e) {} }
  if (!ref) return null;
  const have = lineCount(text), want = lineCount(ref);
  return have * 2 < want ? '只剩 ' + have + ' 行（參考 ' + want + ' 行）' : null;
}

// needed-when-file／needed-when-contains：這筆覆寫在目前這個 checkout 需不需要。沒設或判準檔讀不到＝需要。
function neededHere(dir, ent) {
  if (!ent.whenFile || !ent.whenContains) return true;
  try { return fs.readFileSync(path.join(dir, ent.whenFile), 'utf8').indexOf(ent.whenContains) >= 0; } catch (e) { return true; }
}

// requires：覆寫檔裡缺了哪幾個必須含有的字串（檔案讀不到回空陣列，由別的判準處理）。
function missingRequires(dir, ent) {
  if (!ent.requires || !ent.requires.length) return [];
  let text;
  try { text = fs.readFileSync(path.join(dir, ent.file), 'utf8'); } catch (e) { return []; }
  return ent.requires.filter((s) => text.indexOf(s) < 0);
}

function backupBase(ent) {
  return (String(ent.key || ent.repo) + '__' + ent.file).replace(/[^A-Za-z0-9._-]/g, '_');
}

// 備份檔名的候選：本組用頂層 key 命名；別的實作可能用 repo 值命名（來源專案就是），找不到時退回試 repo 名——
// 否則既有專案換成本組後，所有舊備份都「看起來不存在」（實測：0 / 21 個認得出來）。
function backupBases(ent) {
  const out = [backupBase(ent)];
  if (ent.repo && ent.repo !== ent.key) {
    const b = (String(ent.repo) + '__' + ent.file).replace(/[^A-Za-z0-9._-]/g, '_');
    if (out.indexOf(b) < 0) out.push(b);
  }
  return out;
}

// 歷史版本檔名＝<base>.<YYYY-MM-DDTHH-MM-SS-mmm><副檔名>（毫秒：同一秒內轉存兩次時，後一份會蓋掉前一份；
// 舊格式沒有毫秒，照樣認得）。用精確樣式比對，不用 startsWith——
// 清單上若同時有 conf.txt 與 conf.txt.bak，前者的 startsWith 會把後者的備份當成自己的歷史版本。
function historyStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
}
function isHistoryOf(base, name, ext) {
  if (name.slice(0, base.length + 1) !== base + '.') return false;
  const tail = name.slice(base.length + 1);
  return new RegExp('^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(?:-\\d{3})?' + (ext ? ext.replace('.', '\\.') : '\\.(?:patch|full)') + '$').test(tail);
}

// 找可用的備份，回傳 { p, full } 或 null。「目前」那份若是空的或整檔刪除的形狀（舊版備份腳本遇到清空的檔
// 會把它蓋成這樣），改用最新一份正常的歷史版本。同一個名字下 .patch 與 .full 都有時（檔案在追蹤／未追蹤
// 之間換過）取較新的那份。
function findBackup(outDir, ent) {
  const usable = (p, full) => {
    let t = '';
    try { t = fs.readFileSync(p, 'utf8'); } catch (e) { return false; }
    return t.trim().length > 0 && (full || !isWipePatch(t));
  };
  let names = null;
  for (const base of backupBases(ent)) {
    const cur = ['.patch', '.full'].map((ext) => {
      const p = path.join(outDir, base + ext);
      try { return { p: p, full: ext === '.full', mtime: fs.statSync(p).mtimeMs }; } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    const good = cur.find((c) => usable(c.p, c.full));
    if (good) return { p: good.p, full: good.full };
    if (names === null) { try { names = fs.readdirSync(outDir); } catch (e) { names = []; } }
    const hist = names.filter((f) => isHistoryOf(base, f, null)).sort().reverse();
    for (const f of hist) {
      const full = /\.full$/.test(f);
      const p = path.join(outDir, f);
      if (usable(p, full)) return { p: p, full: full };
    }
  }
  return null;
}
// ── 覆寫清單解析 結束 ──

function currentContent(dir, ent, full) {
  try {
    if (full) return fs.readFileSync(path.join(dir, ent.file), 'utf8');
    try { return git(dir, ['diff', 'HEAD', '--', ent.file]); } catch (e) { return git(dir, ['diff', '--', ent.file]); }
  } catch (e) { return null; }
}

const ROOT = findRoot();
if (!ROOT) { console.error('找不到覆寫清單（' + OVERRIDES_REL + '），往上 8 層都沒有。'); process.exit(1); }
const outDir = path.join(ROOT, BACKUP_DIR_REL);
const args = process.argv.slice(2);
const doRestore = args.includes('--restore');
const doAll = args.includes('--all');
const doList = args.includes('--list');

const entries = loadEntries(ROOT);
if (!entries.length) { console.error(OVERRIDES_REL + ' 沒有列出任何覆寫檔。'); process.exit(1); }

const cache = {};
const rows = entries.map((ent) => {
  const dir = repoDirOf(ROOT, ent, cache);
  const label = dir ? (path.relative(ROOT, path.join(dir, ent.file)).split('\\').join('/') || ent.file)
    : String(ent.key || ent.repo) + ':' + ent.file;
  return { ent: ent, dir: dir, label: label, backup: findBackup(outDir, ent), wiped: null };
});

if (doList) {
  console.log('備份目錄：' + outDir);
  let n = 0;
  for (const r of rows) {
    let info = '（無備份）';
    if (r.backup) {
      const st = fs.statSync(r.backup.p);
      info = path.basename(r.backup.p) + '  ' + st.size + ' bytes  ' + st.mtime.toISOString().slice(0, 19).replace('T', ' ');
      n++;
    }
    console.log('  ' + r.label.padEnd(60) + ' ' + info);
  }
  console.log('共 ' + n + ' / ' + rows.length + ' 個檔有備份');
  process.exit(0);
}

const ok = [], drifted = [], stale = [], shrunk = [], missing = [], noBackup = [], unknown = [], notNeeded = [];
for (const r of rows) {
  if (!r.dir) { unknown.push(r); continue; }
  if (!neededHere(r.dir, r.ent)) { notNeeded.push(r); continue; }
  const st = fileState(r.dir, r.ent.file);
  if (st === null) { unknown.push(r); continue; }
  if (st !== 'clean') {
    // 有改動不等於還在：被清空、刪除在 git 眼中也是改動，要當成「不見了」處理
    r.wiped = wipedReason(r.dir, r.ent);
    if (!r.wiped) {
      ok.push(r);
      // 行數大幅減少：可能被截斷、也可能是刻意縮短，只列出、不自動套
      let ref = null;
      if (r.backup && r.backup.full) { try { ref = fs.readFileSync(r.backup.p, 'utf8'); } catch (e) {} }
      const sr = shrunkReason(r.dir, r.ent, st, ref);
      if (sr) shrunk.push({ r: r, why: sr });
      if (r.backup) {
        const cur = currentContent(r.dir, r.ent, r.backup.full);
        if (cur !== null && cur !== fs.readFileSync(r.backup.p, 'utf8')) drifted.push(r);
      }
      const lack = missingRequires(r.dir, r.ent);
      if (lack.length) stale.push({ r: r, lack: lack });
      continue;
    }
  }
  (r.backup ? missing : noBackup).push(r);
}
const tag = (r) => r.label + (r.wiped ? '（' + r.wiped + '）' : '');

console.log('=== 本機覆寫狀態（' + rows.length + ' 個）===');
console.log('  仍有本機改動            : ' + ok.length + (drifted.length ? '（其中 ' + drifted.length + ' 個內容與最新備份不同）' : ''));
console.log('  不見了但有備份可救      : ' + missing.length);
console.log('  不見了且無備份          : ' + noBackup.length);
if (stale.length) console.log('  缺少必須含有的字串      : ' + stale.length);
if (notNeeded.length) console.log('  目前這個 checkout 用不到: ' + notNeeded.length);
if (unknown.length) console.log('  認不出 repo 或 git 讀不到: ' + unknown.length);

if (drifted.length) {
  console.log('');
  console.log('以下檔案仍有改動，但內容與最新備份不同（可能被部分覆寫、或在別處改過；只提示，不自動套）：');
  drifted.forEach((r) => console.log('    ' + r.label + '  ←→ ' + path.basename(r.backup.p)));
}
if (shrunk.length) {
  console.log('');
  console.log('以下覆寫檔的行數比參考版少一半以上——可能被截斷，也可能是刻意縮短（只提示，不自動套）：');
  shrunk.forEach((s) => {
    // 縮短前的版本：backup 剛縮短時記下的那份歷史版本；沒有記號就取最新一份歷史版本
    let before = '';
    try { before = fs.readFileSync(path.join(outDir, backupBase(s.r.ent) + '.shrunk-noted'), 'utf8').trim(); } catch (e) {}
    if (!before) {
      let names = [];
      try { names = fs.readdirSync(outDir); } catch (e) {}
      before = names.filter((f) => backupBases(s.r.ent).some((b) => isHistoryOf(b, f, null))).sort().pop() || '';
    }
    console.log('    ' + s.r.label + '：' + s.why + (before ? '；縮短前的版本：' + BACKUP_DIR_REL + '/' + before : '；備份目錄裡沒有縮短前的版本'));
  });
}
if (stale.length) {
  console.log('');
  console.log('以下覆寫檔還在，但缺少清單（requires 欄）宣告一定要有的字串——可能帶到的是舊版（只提示，不自動套）：');
  stale.forEach((s) => console.log('    ' + s.r.label + '：缺 ' + s.lack.map((x) => '「' + x + '」').join('、')));
}
if (notNeeded.length) {
  console.log('');
  console.log('以下覆寫的 needed-when 條件在目前這個 checkout 不成立（這個分支用不到），未檢查、也不會救回：');
  notNeeded.forEach((r) => console.log('    ' + r.label + '  （' + r.ent.whenFile + ' 不含「' + r.ent.whenContains + '」）'));
}
if (unknown.length) {
  console.log('');
  console.log('以下條目認不出所在 repo 或 git 讀不到，未判斷：');
  unknown.forEach((r) => console.log('    ' + r.label));
}
if (noBackup.length) {
  console.log('');
  console.log('以下檔案的覆寫不見了（沒有本機改動，或被清空、刪除），也沒有備份——可能本來就沒覆寫，也可能備份前就沒了：');
  noBackup.forEach((r) => console.log('    ' + tag(r)));
  console.log('  ' + (SETUP_DOC ? '對照 ' + SETUP_DOC + ' 逐項確認該補什麼值。' : '對照清單每筆的 reason 欄逐項確認該補什麼值。'));
}

if (!doRestore) {
  if (missing.length) {
    console.log('');
    console.log('以下 ' + missing.length + ' 個覆寫不見了，但備份在：');
    missing.forEach((r) => console.log('    ' + tag(r).padEnd(60) + ' ' + path.basename(r.backup.p)));
    console.log('');
    console.log('這是檢查模式，沒有改動任何檔案。要實際救回請加 --restore：');
    console.log('  ' + RESTORE_CMD + ' --restore');
    process.exit(2);
  }
  console.log('');
  console.log(noBackup.length ? '沒有可自動救回的項目。' : (stale.length ? '沒有不見的覆寫，但有內容不完整的（見上）。' : '全部完好，不需救回。'));
  process.exit(0);
}

const targets = doAll ? rows.filter((r) => r.dir && r.backup && notNeeded.indexOf(r) < 0) : missing;
console.log('');
console.log('=== 開始救回（' + targets.length + ' 個）===');
let done = 0, failed = 0;
for (const r of targets) {
  try {
    const dest = path.join(r.dir, r.ent.file);
    // 救回會蓋掉現在的檔：還有內容的先另存一份（--all 會碰到仍有改動的檔；判準誤判時也不至於丟掉現況）
    let now = '';
    // 讀不到（權限、被鎖）不等於檔案不在：無法另存現況就不救，免得在沒有副本的情況下蓋掉它
    try { now = fs.readFileSync(dest, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (now.length) {
      const ts = historyStamp();
      const keep = path.join(outDir, backupBase(r.ent) + '.' + ts + '.before-restore');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(keep, now, 'utf8');
      // 每個檔只留最近 10 份，免得一直累積
      try {
        const pre = backupBase(r.ent) + '.';
        const olds = fs.readdirSync(outDir).filter((f) => f.slice(0, pre.length) === pre && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?\.before-restore$/.test(f.slice(pre.length))).sort();
        while (olds.length > 10) fs.unlinkSync(path.join(outDir, olds.shift()));
      } catch (e) {}
      console.log('  （救回前的現況另存在 ' + path.relative(ROOT, keep).split('\\').join('/') + '）');
    }
    if (r.backup.full) {
      // 存的是整份內容：直接寫回。不能用 git apply——沒有 diff header，git 也不認得這個檔。
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(r.backup.p, 'utf8'), 'utf8');
    } else {
      // 被清空、刪除的追蹤中檔案：patch 的基準是 HEAD 那份，先把 HEAD 內容寫回才套得上
      if (r.wiped) {
        const base = execFileSync('git', ['-C', r.dir, 'show', 'HEAD:./' + r.ent.file],
          { timeout: 15000, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, base);
      }
      execFileSync('git', ['-C', r.dir, 'apply', r.backup.p], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    console.log('  OK    ' + r.label + '  ← ' + path.basename(r.backup.p));
    done++;
  } catch (e) {
    const msg = String((e.stderr || e.message || '')).trim().split(/\r?\n/)[0];
    console.log('  FAIL  ' + r.label + '  -> ' + msg);
    failed++;
  }
}
console.log('');
console.log('救回 ' + done + ' 個，失敗 ' + failed + ' 個。');
if (failed) {
  console.log('失敗多半是「該檔現在的內容已經不是 patch 的基準」——先看 git diff 確認現況，再決定手動處理。');
}
process.exit(failed ? 1 : 0);
