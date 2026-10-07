#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)：要從另一個工作樹（git worktree）起服務時，先查那個工作樹的本機覆寫帶齊了沒。只提醒、不擋。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 形狀目錄第 19 列（C 類）：裝了本機覆寫保護（第 16–18 列）、而且 Phase 1 看到多工作樹時才裝。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/remind-worktree-overrides.js\"", "timeout": 15, "statusMessage": "起服務前檢查工作樹的本機覆寫帶齊沒" }] }]
//
// 為什麼需要：新開的工作樹是乾淨的原版，主要工作目錄裡的本機覆寫（本機連線字串、mock 開關、收件人收斂…）
// 不會跟過去。第 16–18 列只管「既有工作區的覆寫被毀」：新工作樹沒有東西可救、patch 也套不上別的基準。
// 漏帶的症狀跟成因看起來毫無關聯——服務起不來、端點整批回授權錯誤、測試信真的寄給同事——每次都要重查一輪。
// 來源專案實際因為新工作樹漏帶寄信覆寫而誤寄過信。
//
// 為什麼掛在「起服務」而不是 SessionStart：一次稽核所有工作樹很慢、每次開 session 都付不划算；
// 漏帶真正會出事的時刻就是起服務的那一刻，而且只需要查「這次要起的那一個」。
//
// 判定：
//   · 指令要命中填空區的 START_COMMAND（起服務的指令樣式），否則不動作。
//   · 用 `git worktree list --porcelain` 找出覆寫清單上每個 repo 的其他工作樹（第一筆是主要工作目錄，不算）。
//   · 只查**指令提到的那一個**工作樹：指令裡出現它的路徑（絕對路徑、Git Bash 的 /c/… 寫法、相對專案根或相對
//     目前目錄的路徑，正反斜線都認）；指令沒提到任何工作樹、但 session 的目前目錄就在某個工作樹裡時，查那一個。
//     同時提到好幾個時取路徑最長的那一個（巢狀時取最內層）。
//   · 對清單上屬於該 repo 的每一筆（needed-when 條件在該工作樹不成立的略過）：
//       沒有本機改動（與該工作樹的 HEAD 相同；未追蹤或被排除的檔則是不存在）→「沒帶」；
//       檔案被清空（0 bytes）→「被清空」；檔案還在、但缺清單 requires 宣告的字串 →「帶到舊版」。
//     判準與 check-local-hacks-alive.js 相同（同一份清單解析），只是對象換成那個工作樹。
//   · 有缺漏就印 additionalContext 提醒；沒缺漏時安靜（ALWAYS_REMIND 有填時改成照樣提醒那段話）。
// 只提醒不擋：該不該帶是人的判斷——那個工作樹的 HEAD 可能本來就含正確值、不需要覆寫。
// 輸出走 hookSpecificOutput.additionalContext：PreToolUse 的 exit 0 純文字 stdout／stderr 模型看不到（官方 hooks 文件）。
//
// 已知極限：
//   · 只認指令字面上的路徑：路徑放在變數裡（cd "$WT"）、或由腳本切目錄後再起服務，認不出是哪個工作樹，不提醒。
//   · 路徑比對是字串比對：指令裡剛好出現某個工作樹的路徑、但其實沒在那裡起服務（例：起服務前先 ls 過它），也會查那一個。
//   · 只查覆寫在不在、內容是不是舊版，不查服務實際連到哪裡——覆寫全帶齊，整條鏈路照樣可能不通（埠號指錯、
//     跑的是主要工作目錄的服務、建置後沒重啟），那幾件要另外驗（03 的 A9）。
// fail-open：任何例外一律靜默放行（exit 0）。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 起服務的指令樣式（字串 regex，不分大小寫，比對整串指令；= Phase 1 第 10 項②盤點到的實際啟動指令）。
// 預設涵蓋常見寫法；改成本專案實際用的那幾種，用不到的拿掉，免得跑別的指令也去查工作樹。
const START_COMMAND = String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|(?:^|[\s;&|(/\\])(?:npx\s+)?vite(?=\s|$)|\buvicorn\b|\bflask\s+run\b|\bmanage\.py\s+runserver\b|\brails\s+(?:s|server)\b|\bgo\s+run\b|\bcargo\s+run\b|\bmvn\b[^\n]*\bspring-boot:run\b`;
// 覆寫清單檔（相對於工作目錄根），與本機覆寫保護三支的同名常數一致。
const OVERRIDES_REL = '.claude/local-overrides.yml';
// 去哪裡查該補什麼值（init 產了本機覆寫說明時填它的路徑；留空字串＝改提示看清單每筆的 reason 欄）。
const SETUP_DOC = '';
// 從工作樹起服務時「不論有沒有缺漏都要講」的提醒（例：先驗埠號、確認跑的是這個工作樹的建置、建置後有沒有重啟）。
// 留空字串＝沒缺漏就安靜。
const ALWAYS_REMIND = '';
// 最多列幾筆（其餘只算數量）。
const MAX_LIST = 16;
// ────────────────────────────────────────────────────────────────────────────

// ── 覆寫清單解析（backup／guard／alive／restore／remind-worktree 五支各帶一份同樣的實作，改一支要同步另外四支）──
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
//   這三個選填欄位只有 alive、restore 與 remind-worktree 會用（五支都帶同一份解析，backup／guard 只讀不用）；flow.sh 只認 path，
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

// git worktree list --porcelain：回傳 [{ dir }]，第一筆是主要工作目錄
function worktreesOf(repoDir) {
  let out = '';
  try { out = git(repoDir, ['worktree', 'list', '--porcelain']); } catch (e) { return []; }
  const list = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^worktree (.+)$/);
    if (m) list.push(path.resolve(m[1]));
  }
  return list;
}

const norm = (s) => {
  const t = String(s).split('\\').join('/');
  return process.platform === 'win32' ? t.toLowerCase() : t;
};
// Git Bash 的寫法：C:/x → /c/x
const posixOf = (p) => (process.platform === 'win32'
  ? norm(p).replace(/^([a-z]):/, (m, d) => '/' + d) : norm(p));
const inside = (base, p) => {
  const rel = path.relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const SEP_BEFORE = /[\s"'=;&|(]/;
const SEP_AFTER = /[\s"';&|)\/]/;

// 指令裡有沒有提到這個路徑寫法：前後要是分隔字元，相對路徑另接受前面帶 ./
function mentions(cmd, form, isRel) {
  if (!form) return false;
  let from = 0;
  for (;;) {
    const i = cmd.indexOf(form, from);
    if (i < 0) return false;
    from = i + 1;
    const after = cmd[i + form.length];
    if (after !== undefined && !SEP_AFTER.test(after)) continue;
    const before = cmd[i - 1];
    if (before === undefined || SEP_BEFORE.test(before)) return true;
    if (isRel && before === '/' && cmd[i - 2] === '.' && (i - 3 < 0 || SEP_BEFORE.test(cmd[i - 3]))) return true;
    if (!isRel && !/[A-Za-z0-9_.-]/.test(before)) return true;
  }
}

try {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  if (!/^(Bash|PowerShell)$/.test(String(input.tool_name || ''))) process.exit(0);
  const cmd = String((input.tool_input || {}).command || '');
  if (!cmd || !new RegExp(START_COMMAND, 'i').test(cmd)) process.exit(0);

  const ROOT = findRoot();
  if (!ROOT) process.exit(0);
  const entries = loadEntries(ROOT);
  if (!entries.length) process.exit(0);

  // 覆寫清單上每個 repo 的其他工作樹
  const cache = {};
  const byRepo = new Map();
  for (const ent of entries) {
    const dir = repoDirOf(ROOT, ent, cache);
    if (!dir) continue;
    const key = path.resolve(dir);
    if (!byRepo.has(key)) byRepo.set(key, { main: key, ents: [], wts: [] });
    byRepo.get(key).ents.push(ent);
  }
  const candidates = [];
  for (const r of byRepo.values()) {
    const list = worktreesOf(r.main);
    if (!list.length) continue;
    const mainDir = list[0];
    for (const wt of list.slice(1)) candidates.push({ wt: wt, mainDir: mainDir, repo: r });
  }
  if (!candidates.length) process.exit(0);

  // 指令提到的那一個（取路徑最長的）；都沒提到時，看 session 目前目錄在不在某個工作樹裡
  const cwd = path.resolve(input.cwd || ROOT);
  const ncmd = norm(cmd);
  let pick = null;
  let pickLen = -1;
  for (const c of candidates) {
    const forms = [
      [norm(c.wt), false],
      [posixOf(c.wt), false],
      [norm(path.relative(ROOT, c.wt)), true],
      [norm(path.relative(cwd, c.wt)), true],
    ];
    for (const [form, isRel] of forms) {
      if (!form || path.isAbsolute(form) && isRel) continue;
      if (mentions(ncmd, form, isRel) && c.wt.length > pickLen) { pick = c; pickLen = c.wt.length; }
    }
  }
  if (!pick) {
    for (const c of candidates) {
      if (inside(c.wt, cwd) && c.wt.length > pickLen) { pick = c; pickLen = c.wt.length; }
    }
  }
  if (!pick) process.exit(0);

  const wt = pick.wt;
  const issues = [];
  for (const ent of pick.repo.ents) {
    if (!neededHere(wt, ent)) continue;    // needed-when 條件在這個工作樹不成立：用不到
    const st = fileState(wt, ent.file);
    if (st === null) continue;              // git 讀不到，不判
    if (st === 'clean') { issues.push({ tag: '[沒帶]    ', file: ent.file }); continue; }
    const why = wipedReason(wt, ent);
    if (why) { issues.push({ tag: '[被清空]  ', file: ent.file, note: why }); continue; }
    const lack = missingRequires(wt, ent);
    if (lack.length) issues.push({ tag: '[帶到舊版]', file: ent.file, note: '缺 ' + lack.map((x) => '「' + x + '」').join('、') });
  }
  if (!issues.length && !ALWAYS_REMIND) process.exit(0);

  const shown = path.relative(ROOT, wt).split('\\').join('/') || wt;
  const L = [];
  if (issues.length) {
    L.push('[工作樹的本機覆寫沒帶齊] 要從工作樹 ' + shown + ' 起服務，但覆寫清單（' + OVERRIDES_REL + '）上有 ' + issues.length + ' 筆在這個工作樹沒帶齊：');
    issues.slice(0, MAX_LIST).forEach((x) => L.push('  ' + x.tag + ' ' + x.file + (x.note ? '（' + x.note + '）' : '')));
    if (issues.length > MAX_LIST) L.push('  …另有 ' + (issues.length - MAX_LIST) + ' 筆');
    L.push('');
    L.push('從主要工作目錄（' + pick.mainDir.split('\\').join('/') + '）帶過去：只改了幾行的檔，看 `git -C "' + pick.mainDir.split('\\').join('/') +
      '" diff -- <檔>` 照著補；整檔都是本機的（不在版控裡的檔），直接複製那一份。');
    L.push(SETUP_DOC ? '每個檔該填什麼值見 ' + SETUP_DOC + '。' : '每個檔該填什麼值見覆寫清單每筆的 reason 欄。');
    L.push('漏帶時的症狀跟成因看起來毫無關聯（服務起不來、端點整批回授權錯誤、測試信真的寄出去），起服務前先補齊比事後追便宜。');
    L.push('⚠ 只是提醒，指令照跑：這個工作樹的 HEAD 可能本來就含正確值、不需要覆寫。');
  }
  if (ALWAYS_REMIND) {
    if (L.length) L.push('');
    L.push('[從工作樹起服務] ' + ALWAYS_REMIND);
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: L.join('\n') } }) + '\n');
} catch (e) {}
process.exit(0);
