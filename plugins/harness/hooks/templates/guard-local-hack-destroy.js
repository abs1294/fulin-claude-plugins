#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)：攔截會「銷毀未提交本機覆寫」的 git 指令。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-local-hack-destroy.js\"", "timeout": 15, "statusMessage": "檢查指令會不會毀掉未提交的本機覆寫" }] }]
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
//      短旗標可合寫（stash -ku、switch -fc），判旗標一律用 hasShortFlag，不只認單獨寫的 -u／-f。
//   6. restore／checkout 依點名路徑放寬**只在語法解析器可用時**（同目錄 shell-model.js；沒有解析器、
//      HARNESS_SHELL_PARSER=off、語法樹有錯誤節點時，判法與改動前相同）：每個 git 呼叫的目前目錄、環境、旗標、點名路徑、
//      所屬 repo 都確定，而且沒點到覆寫檔才放行；任何一處判不準就照改動前擋。細節見 astNamedItems 上方的註解。
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
  // 前面可以是路徑分隔：/usr/bin/git、C:\Program Files\Git\cmd\git.exe 這種完整路徑的呼叫也認（只加嚴）
  const re = /(^|[^A-Za-z0-9_.\-])git(?:\.(?:exe|cmd|bat|com))?(?=\s|$)/gi;
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
    let hintCount = 0;   // -C／--work-tree 出現次數；超過一次（-C a -C b 會疊加）就判不出最終目錄
    for (;;) {
      let m2 = rest.match(new RegExp('^(?:-C|--work-tree)\\s+(' + ARG + ')\\s*'));
      if (m2) { hintCount++; if (repoHint === null) repoHint = stripArgQuotes(m2[1]); rest = rest.slice(m2[0].length); continue; }
      m2 = rest.match(new RegExp('^--work-tree=(' + ARG + ')\\s*'));
      if (m2) { hintCount++; if (repoHint === null) repoHint = stripArgQuotes(m2[1]); rest = rest.slice(m2[0].length); continue; }
      m2 = rest.match(new RegExp('^(?:-c|--git-dir|--namespace|--exec-path)\\s+' + ARG + '\\s*'));
      if (m2) { rest = rest.slice(m2[0].length); continue; }
      m2 = rest.match(new RegExp('^(?:--git-dir|--namespace|--exec-path)=' + ARG + '\\s*'));
      if (m2) { rest = rest.slice(m2[0].length); continue; }
      m2 = rest.match(/^(?:--no-pager|--bare|--literal-pathspecs|--paginate|-P|--exec-path)\s+/);
      if (m2) { rest = rest.slice(m2[0].length); continue; }
      break;
    }
    const vm = rest.match(/^([a-zA-Z][a-zA-Z0-9-]*)\s*([\s\S]*)$/);
    // 同一段裡 git 前面有 xargs＝路徑由管線在執行期供給（`git ls-files -m | xargs git restore`）
    const lead = src.slice(0, m.index + m[1].length);
    const viaXargs = /(?:^|[\s;&|(])xargs\b[^;&|\n]*$/i.test(lead);
    if (vm) calls.push({ verb: vm[1].toLowerCase(), args: vm[2] || '', repoHint: repoHint, multiHint: hintCount > 1, viaXargs: viaXargs });
  }
  return calls;
}

// 純查詢用法：帶這些旗標時 git 不動工作區
const INERT = /(^|\s)(--help|-h|--dry-run|-n\b)(\s|$)/;

// 短旗標可以合寫（-fc、-ku、-ua）：只認「單獨寫的 -f／-u」會把合寫的放走
// （`git switch -fc <新分支> <起點>` 照樣丟棄改動、`git stash -ku` 照樣收走未追蹤的覆寫）。
// 判準：任一「-字母串」token 含該字母即算（長旗標 --xxx 不算）。
// 引號裡的字（`-m "wip -all now"` 的訊息）不是旗標，先剝掉再看
function hasShortFlag(args, letter) {
  return String(args).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ').split(/\s+/).some((tok) => /^-[A-Za-z]+$/.test(tok) && tok.indexOf(letter) > 0);
}

// ── 點名路徑放寬（只在語法樹路徑）────────────────────────────────────────────
// 改動前：只要同 repo 有改過的覆寫檔，restore／checkout 不論點名哪個檔都整條擋。這裡用 shell-model.js 的語法樹
// （與規則引擎共用；引號、跳脫、cd 的先後與條件、子殼、新程序都依 shell 語意算）確定「每個 git 呼叫實際會改到哪些檔」，
// 算得出、而且沒點到覆寫檔才放行；任何一處判不準就回 null，呼叫端維持改動前的結果。
// 判不準（回 null）的情形：
//   · 解析器不可用、HARNESS_SHELL_PARSER=off、語法樹有錯誤節點、payload 沒有 cwd
//   · 同一串有寫到檔案的重導向（> 檔、>> 檔；/dev/null、$null、NUL 與 2>&1 不算）或 Out-File／Set-Content／Add-Content／Tee-Object／tee；
//     有 eval、source、.（dot-source）、iex、Invoke-Expression、Invoke-Command、Start-Job、& 呼叫；有指令名稱不是字面的
//     （$g restore .、"$GIT" restore .、$(echo git) …、& $g …）
//   · 語法樹確認的會改工作區的 git 呼叫數，與文字層認出的危險呼叫數不同（含 0 個）：有語法樹看不到的呼叫
//   · PowerShell 用 .NET 換目錄（SessionState.Path.SetLocation、[Environment]::CurrentDirectory、SetCurrentDirectory）
//   · 放寬過程丟出任何例外（例：shell-model.js 是舊版、沒有 dirAt）——呼叫端以自己的 try 接住，維持改動前的結果
//   · 任何 git 呼叫：目前目錄判不準（條件裡的 cd、cd 失敗、cd 到變數、pushd、env -C、在 bash -c／pwsh -Command 等新程序裡、
//     git 之前有認不得的指令或自訂函式——同一串定義的函式、清單外的裸名稱（可能是 session 裡的函式或別名）、PowerShell 的 .ps1 腳本，
//     它們可能換掉呼叫端的目錄；git 本身與常見開發工具（pytest、tsc、docker、make……）不算）；
//     環境裡有改變 repo 位置或 pathspec 語意的 GIT_* 變數（含值判不準）、前置或 env 帶的 GIT_*=；
//     git 的全域選項不在 -C／--no-pager／-P／--no-optional-locks 之內（-c、--git-dir、--work-tree、--namespace……）；
//     子命令不在「不碰工作區」清單、也不是 restore／checkout（submodule foreach、stash、reset、別名……）
//   · restore／checkout：旗標不在下面列的完整清單（縮寫如 --forc、--pathspec-fr 一律不認）、--pathspec-from-file、
//     點名參數是 pathspec magic（: 開頭）、含萬用字元或反斜線、跑出 repo 外；checkout 帶 -f／-b／-B／--orphan／-m 等會動整棵樹的旗標、
//     不帶 -- 且只有一個名稱（分不出切分支或還原路徑）
//   · 執行目錄所屬 repo（git rev-parse --show-toplevel，取實體路徑）不等於清單上某個 repo 的實體路徑
//     （repo 裡的另一份 worktree、經 junction／symlink 進入、清單沒列的 repo）
const GIT_ENV_LOCATION = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];
// 不碰工作區檔案的子命令（出現在同一串裡不影響放寬）
// 不列的：diff／log／show／grep／rev-list／blame／shortlog（--output、-O／--open-files-in-pager 會寫檔或執行程式）、
// cat-file（--textconv／--filters 執行設定的程式）、help（--web 開瀏覽器）、fetch（--upload-pack 執行程式）、
// commit／tag（執行 hook、gpg）。逐一列旗標容易漏，乾脆不算無害
const GIT_HARMLESS = new Set(['status', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'version', 'branch', 'add']);
// 會執行看不到內容的程式碼、或在目前 session 載入腳本的指令：同一串出現就不放寬
const RUNS_HIDDEN_CODE = new Set(['eval', 'source', '.', 'iex', 'invoke-expression', 'invoke-command', 'icm', 'start-job', 'sajb', '&']);
// 會寫檔的 PowerShell cmdlet 與 tee（重導向另外看）
const WRITES_FILE_CMD = /(?:^|[\s;|&({])(?:out-file|set-content|sc|add-content|ac|tee-object|tee)(?=[\s;|&)}]|$)/i;
// 同一串裡有寫到檔案的重導向（目標不是 /dev/null、$null、NUL；2>&1 這類複製檔案描述子不算）。引號裡的字先剝掉
function writesFileByRedirect(cmd) {
  const t = String(cmd).replace(/'[^']*'/g, ' ').replace(/"(?:[^"\\`]|\\.|`.)*"/g, ' ');
  const re = /(?:\d+|&|\*)?(?:>>?|>\|)(&?)[ \t]*([^\s;&|)]*)/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1] === '&' && /^(?:\d+|-)?$/.test(m[2])) continue;          // >&2、2>&1、>&-
    if (/^(?:\/dev\/null|nul|\$null)$/i.test(m[2])) continue;
    return true;
  }
  return false;
}
const RESTORE_FLAGS = new Set(['-p', '--patch', '-W', '--worktree', '-S', '--staged', '-q', '--quiet', '--progress', '--no-progress',
  '--ours', '--theirs', '-m', '--merge', '--ignore-unmerged', '--ignore-skip-worktree-bits', '--overlay', '--no-overlay']);
const CHECKOUT_FLAGS = new Set(['-q', '--quiet', '--ours', '--theirs', '-p', '--patch', '--overlay', '--no-overlay',
  '--ignore-skip-worktree-bits', '--progress', '--no-progress']);

function realOrNull(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch (e) { return null; }
}
function samePath(a, b) {
  const n = (x) => path.resolve(x).split('\\').join('/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}
// 點名參數判不準：空的、pathspec magic（: 開頭）、萬用字元、反斜線（Bash 已解開跳脫，剩下的多半是 PowerShell 路徑分隔，
// git 的行為依平台而定）、還留著展開語法的（$變數、${…}、$(…)、反引號、%VAR%、PowerShell 的 (…)／@(…)、{}、~）——
// 語法樹給的是字面值，展開要到執行期才知道
function badPathArg(p) {
  return !p || p[0] === ':' || p[0] === '@' || p[0] === '~' || /[*?[\]\\$`(){}]/.test(p) || /%[^%]+%/.test(p);
}

// 一個 git 呼叫：回 { harmless: true }、{ danger: true, dir, paths, ambiguousFirst } 或 null（判不準）
function gitCallShape(a, idx) {
  const e = a.execs[idx];
  const argv = e.argv;
  if ((e.prefix || []).some((p) => /^GIT_/i.test(p.name))) return null;
  if ((e.envOps || []).some((op) => op.name && /^GIT_/i.test(op.name))) return null;
  for (const n of GIT_ENV_LOCATION) {
    const info = a.envInfo(idx, n);
    if (info.unsure || info.values.some((v) => v !== undefined && v !== '')) return null;
  }
  const where = a.dirAt(idx);
  if (!where || where.unsure) return null;
  let dir = where.dir;
  let i = 1;
  for (; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-C') {
      const v = argv[i + 1];
      if (!v) return null;
      dir = path.resolve(dir, process.platform === 'win32' ? v.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:') : v);   // 多個 -C 依序疊加
      i++;
      continue;
    }
    if (t === '--no-pager' || t === '-P' || t === '--no-optional-locks') continue;
    if (t[0] === '-') return null;
    break;
  }
  const sub = argv[i];
  // PowerShell 的重導向（2>$null、> log、*>&1）會留在引數裡；bash 的重導向語法樹已經分開，不會出現在這裡
  const rest = [];
  for (let k = i + 1; k < argv.length; k++) {
    if (/^(?:\d|\*)?>>?(?:&\d)?$/.test(argv[k])) { k++; continue; }   // 運算子單獨一個，下一個是目標
    if (/^(?:\d|\*)?>>?\S/.test(argv[k])) continue;                   // 目標黏在運算子後面
    rest.push(argv[k]);
  }
  if (!sub) return { harmless: true };
  if (GIT_HARMLESS.has(sub)) return { harmless: true };
  if (sub === 'restore') {
    const paths = [];
    let worktree = false, staged = false, dd = false;
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (dd) { paths.push(t); continue; }
      if (t === '--') { dd = true; continue; }
      if (t === '-s' || t === '--source') { if (rest[k + 1] === undefined) return null; k++; continue; }
      if (/^--source=./.test(t) || /^-s./.test(t) || /^--conflict=(?:merge|diff3|zdiff3)$/.test(t)) continue;
      if (t[0] === '-') {
        if (!RESTORE_FLAGS.has(t)) return null;
        if (t === '-W' || t === '--worktree') worktree = true;
        if (t === '-S' || t === '--staged') staged = true;
        continue;
      }
      paths.push(t);
    }
    if (staged && !worktree) return { harmless: true };   // 只動 index
    if (!paths.length || paths.some(badPathArg)) return null;
    return { danger: true, dir, paths, ambiguousFirst: false };
  }
  if (sub === 'checkout') {
    const nonflag = [];
    let dd = -1, ours = false;
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (dd >= 0) { nonflag.push(t); continue; }
      if (t === '--') { dd = nonflag.length; continue; }
      if (/^--conflict=(?:merge|diff3|zdiff3)$/.test(t)) continue;
      if (t[0] === '-') {
        if (!CHECKOUT_FLAGS.has(t)) return null;   // -f、-b、-B、--orphan、-m、--detach、縮寫……一律判不準
        if (t === '--ours' || t === '--theirs') ours = true;
        continue;
      }
      nonflag.push(t);
    }
    let paths, ambiguousFirst = false;
    if (dd >= 0) {
      if (dd > 1) return null;            // -- 之前只准一個 tree-ish
      paths = nonflag.slice(dd);
    } else if (ours) {
      paths = nonflag;
    } else {
      if (nonflag.length < 2) return null;   // 只有一個名稱：分不出切分支還是還原路徑
      paths = nonflag;
      ambiguousFirst = true;
    }
    if (!paths.length || paths.some(badPathArg)) return null;
    return { danger: true, dir, paths, ambiguousFirst };
  }
  return null;
}

// 回傳被點到的覆寫條目陣列（可能是空的＝沒點到任何覆寫檔）；判不準回 null
function astNamedItems(cmd, tool, cwd, root, items, danger) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  let sm;
  try { sm = require('./shell-model.js'); } catch (e) { return null; }
  let a;
  try { a = sm.analyze(cmd, tool === 'PowerShell' ? 'PowerShell' : 'Bash', cwd, root); } catch (e) { return null; }
  if (!a || a.hasError) return null;
  // 整串的檢查：寫檔的重導向或 cmdlet、執行看不到內容的程式碼、指令名稱不是字面的（$g restore .、"$GIT" …、$(echo git) …）
  if (writesFileByRedirect(cmd) || WRITES_FILE_CMD.test(cmd)) return null;
  // PowerShell 用 .NET 換目錄（$ExecutionContext.SessionState.Path.SetLocation、[Environment]::CurrentDirectory、
  // [System.IO.Directory]::SetCurrentDirectory）：語法樹看不到，文字出現就判不準
  if (/SessionState\.Path\.SetLocation|\bCurrentDirectory\b|SetCurrentDirectory/i.test(cmd)) return null;
  for (const e of a.execs) {
    if (RUNS_HIDDEN_CODE.has(e.verb)) return null;
    const w0 = (e.allWords || e.words || [])[0];
    const nameText = w0 && w0.node ? String(w0.node.text) : String((e.fullArgv || [])[0] || '');
    if (/[$`(){}'"%]/.test(nameText)) return null;
  }
  // 文字層兜底：任何 GIT_*= 賦值（$env:GIT_DIR=、${env:GIT_DIR} =、export GIT_WORK_TREE=、env GIT_DIR=…）、Env: 磁碟機上的 GIT_*
  // （Set-Item／New-Item／Remove-Item Env:GIT_…）、SetEnvironmentVariable('GIT_…') 都不放寬；Windows 環境變數不分大小寫，比對也不分
  if (/(?:^|[^\w])GIT_[A-Za-z_]+\}?[ \t]*\+?=|env:[\\/]?GIT_|SetEnvironmentVariable[ \t]*\([ \t]*['"]GIT_/i.test(cmd)) return null;
  const knownReal = [...new Set(items.map((it) => it.top))].map((t) => ({ top: t, real: realOrNull(t) })).filter((x) => x.real);
  const hits = [];
  let dangerCount = 0;
  for (let idx = 0; idx < a.execs.length; idx++) {
    if (a.execs[idx].verb !== 'git') continue;
    const shape = gitCallShape(a, idx);
    if (!shape) return null;
    if (shape.harmless) continue;
    dangerCount++;
    const realDir = realOrNull(shape.dir);
    if (!realDir) return null;
    let top = null;
    try { top = execFileSync('git', ['-C', realDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return null; }
    const realTop = top ? realOrNull(top) : null;
    if (!realTop) return null;
    const known = knownReal.find((k) => samePath(k.real, realTop));
    if (!known) return null;   // 清單沒列的 repo、另一份 worktree、經連結進入後實體對不上
    const inRepo = items.filter((it) => it.top === known.top);
    const relOf = (abs) => {
      const r = path.relative(realTop, abs);
      if (r.startsWith('..') || path.isAbsolute(r)) return null;
      const s = r.split('\\').join('/');
      return process.platform === 'win32' ? s.toLowerCase() : s;
    };
    const itemRel = (it) => {
      const d = realOrNull(it.dir);
      return d ? relOf(path.join(d, it.ent.file)) : null;
    };
    let paths = shape.paths;
    if (shape.ambiguousFirst) {
      // 不帶 -- 的 checkout A B：A 是存在的檔或目錄、或指到覆寫檔，就當路徑（git 只在 A 是 commit 時才當 tree-ish）
      const p0 = path.resolve(realDir, paths[0]);
      const r0 = relOf(p0);
      const firstIsPath = fs.existsSync(p0) || (r0 !== null && inRepo.some((it) => {
        const ri = itemRel(it);
        return ri !== null && (r0 === '' || ri === r0 || ri.startsWith(r0 + '/'));
      }));
      if (!firstIsPath) paths = paths.slice(1);
      if (!paths.length) return null;
    }
    for (const p of paths) {
      const rel = relOf(path.resolve(realDir, p));
      if (rel === null) return null;   // 跑出 repo 外
      for (const it of inRepo) {
        const ri = itemRel(it);
        if (ri === null) return null;
        if ((rel === '' || ri === rel || ri.startsWith(rel + '/')) && hits.indexOf(it) < 0) hits.push(it);
      }
    }
  }
  // 文字層（改動前的判法）認出的危險 git 呼叫數，必須等於語法樹確認的數目：對不上代表有語法樹看不到的呼叫
  // （winpty／flock／doas 這類 shell-model 不認得的前綴程式、node -e／python -c 字串裡的 git、別名……），不放寬
  if (!dangerCount || dangerCount !== danger.repoHints.length) return null;
  return hits;
}

// 每條代表「這個呼叫會覆寫或丟棄工作區檔案」。kinds＝它會毀掉哪種狀態的檔（預設只有追蹤中有改動的）。
const TRACKED = () => ['tracked'];
const VERB_RULES = [
  { verb: 'checkout', test: (a) => /--\s+\./.test(a), label: 'git checkout … -- .（. 是整棵樹，不是你心裡想的那幾個路徑）' },
  { verb: 'checkout', test: (a) => /--\s+\S/.test(a), label: 'git checkout … -- <路徑>' },
  // --force 的縮寫（--fo、--forc）git 照樣接受
  { verb: 'checkout', test: (a) => hasShortFlag(a, 'f') || /(^|\s)(-f|--f(?:o(?:r(?:c(?:e)?)?)?)?)(\s|$)/.test(a), label: 'git checkout -f（直接丟棄本地修改）' },
  // 路徑從檔案讀（含縮寫 --pathspec-fr）：看不到會還原哪些檔
  { verb: 'checkout', test: (a) => /(^|\s)--pathspec-f/.test(a), label: 'git checkout --pathspec-from-file（路徑從檔案讀）' },
  // checkout <commit-ish> <路徑>：不帶 -- 也會覆寫該路徑
  { verb: 'checkout', test: (a) => /^\S+\s+\S/.test(a) && !/^-/.test(a), label: 'git checkout <commit> <路徑>（會覆寫該路徑）' },
  { verb: 'checkout', test: (a) => /^\.(\s|$)/.test(a), label: 'git checkout .' },
  // --ours／--theirs：用合併的其中一方覆寫工作區的點名檔
  { verb: 'checkout', test: (a) => /(^|\s)--(ours|theirs)(\s|$)/.test(a), label: 'git checkout --ours／--theirs <路徑>（用合併的一方覆寫工作區）' },
  // xargs 叫起、沒有自己的參數：路徑全由管線供給
  { verb: 'checkout', test: (a, c) => !a.trim() && !!(c && c.viaXargs), label: 'git checkout（路徑由 xargs 供給）' },
  // 裸 `--`：路徑由 xargs／管線在執行期供給（`echo . | xargs git checkout --` 會真的還原檔案）
  { verb: 'checkout', test: (a) => /^--\s*$/.test(a.trim()), label: 'git checkout --（路徑由管線供給）' },
  // 單一個名稱：語法上分不出是分支還是路徑；是路徑就會覆寫，所以一律視為危險
  { verb: 'checkout', test: (a) => /^(?!-)[^\s]+\s*$/.test(a), label: 'git checkout <名稱>（分不出是分支或路徑；是路徑就會覆寫）' },
  // restore 預設（無旗標）等同 --worktree；只帶 --staged／--cached 則僅還原 index，工作區不動。
  // 同時帶 --staged --worktree 仍會寫工作區，故「有 worktree 旗標就擋」而非「有 staged 就放」。
  {
    verb: 'restore',
    test: (a, c) => {
      if (!a.trim()) return !!(c && c.viaXargs);   // 沒參數會報錯；xargs 叫起時路徑由管線供給
      if (/(^|\s)(--worktree|-W)(\s|$)/.test(a)) return true;
      if (/(^|\s)(--staged|--cached|-S)(\s|$)/.test(a)) return false;
      return true;
    },
    label: 'git restore（未帶 --staged，會覆寫工作區）',
  },
  // 一般的 switch 會把未提交改動帶過去（衝突時 git 拒絕切換），不會丟；只有強制旗標會丟。
  // 強制旗標可能跟別的短旗標合寫（-fc <新分支> <起點>），用 hasShortFlag 判。
  { verb: 'switch', test: (a) => hasShortFlag(a, 'f') || /(^|\s)(-f|--force|--discard-changes)(\s|$)/.test(a), label: 'git switch -f／--discard-changes（丟棄本地修改）' },
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
    // -a／-u 可能跟別的短旗標合寫（-ku、-ua），用 hasShortFlag 判
    // 後半是改動前的判法（會連引號裡的 -a／-u 都算），併用以確保不比改動前少擋
    kinds: (a) => ((hasShortFlag(a, 'a') || /(^|\s)(-a|--all)(\s|$)/.test(a)) ? ['tracked', 'untracked', 'ignored']
      : ((hasShortFlag(a, 'u') || /(^|\s)(-u|--include-untracked)(\s|$)/.test(a)) ? ['tracked', 'untracked'] : ['tracked'])),
    label: 'git stash（覆寫被收走，忘了 apply 就等於消失）',
  },
  { verb: 'filter-branch', test: () => true, label: 'git filter-branch' },
  { verb: 'rebase', test: (a) => !/^(--abort|--quit|--continue|--skip|--edit-todo|--show-current-patch)\b/.test(a.trim()), label: 'git rebase（重寫歷史，工作區會被重建）' },
  { verb: 'merge', test: (a) => /--abort/.test(a), label: 'git merge --abort（丟棄合併期間的工作區狀態）' },
  { verb: 'revert', test: (a) => !/^--(abort|quit|continue|skip)\b/.test(a.trim()), label: 'git revert（會改動工作區）' },
  { verb: 'am', test: (a) => /--abort/.test(a), label: 'git am --abort' },
  { verb: 'cherry-pick', test: (a) => /--abort/.test(a), label: 'git cherry-pick --abort' },
];

// 回傳 { labels, repoHints, kinds }：repoHints 是每個危險呼叫的 -C／--work-tree 指向（沒指向＝null；-C 超過一個＝{ multi }）。
function matchDanger(text) {
  const labels = [];
  const repoHints = [];
  const kinds = new Set();
  for (const call of parseGitCalls(text)) {
    if (INERT.test(call.args)) continue;
    let hit = false;
    for (const r of VERB_RULES) {
      if (r.verb !== call.verb) continue;
      let ok = false;
      try { ok = r.test(call.args, call); } catch (e) { ok = false; }
      if (!ok) continue;
      if (labels.indexOf(r.label) < 0) labels.push(r.label);
      (r.kinds || TRACKED)(call.args).forEach((k) => kinds.add(k));
      hit = true;
    }
    if (hit) repoHints.push(call.multiHint ? { multi: true } : call.repoHint);
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
      (m0, tag, sameLineRest) => ' ' + (sameLineRest || '') + ' ')
      // 加引號的完整路徑（"C:\Program Files\Git\cmd\git.exe" reset --hard、& 'C:/…/git.exe' …）換成裸的 git：
      // 不換的話整段被當成引述（引號裡的字）而放行。只加嚴
      .replace(/(["'])[^"'\n]*[\/\\]git(?:\.(?:exe|cmd|bat|com))?\1(?=\s)/gi, ' git');

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
    // 包裝的程式碼：git 直接接在旗標後面，或在引號字串裡、位於指令開頭的位置（`sh -c "cd app && git reset --hard"`——
    // 先 cd 再 git，git 不是第一個字；曾經兩條路徑都放行）。引號裡只是提到 git 的字（`bash -c "echo legit"`）不算。
    // 取捨：包裝裡用 echo／grep 引述一段以空白開頭的 git 指令（`bash -c "echo 請跑 git reset --hard"`）會多擋——
    // 判不出引號裡的 git 是在執行還是被引述；漏擋會真的銷毀覆寫，多擋只是攔下來問
    const WRAPPED_CODE = '(?:["\']?\\s*' + GITX + '(\\s|["\']|$)' +
      '|"[^"]*[\\s;&|(]' + GITX + '(?:\\s|")' +
      '|\'[^\']*[\\s;&|(]' + GITX + '(?:\\s|\'))';
    const WRAPPER_RUNS_GIT = new RegExp(
      // 殼名與執行旗標之間只能是其他旗標（可帶一個值，值可以是路徑）：`cmd //d //c`、`bash -o pipefail -c`、
      // `bash --rcfile /dev/null -c`、`powershell -exec bypass -c`；殼名後面直接是腳本名就不是包裝（`bash run.sh -c …`）。
      // 取捨：旗標後面的腳本路徑也會被當成值（`bash -x run.sh -c …` 會多擋）——漏擋會真的銷毀改動，多擋只是攔下來問
      // 旗標與值都可能含引號字串（`-WorkingDirectory "C:\my repo"`、`-Param:"a b"`），引號內的空白不算斷詞
      '(^|[\\s;&|(])' + SHELLS + '\\s+(?:(?:[-+]' + WORD + '*|\\/{1,2}[A-Za-z](?::' + WORD + '*)?)(?:\\s+(?:"[^"]*"|\'[^\']*\'|[^\\s;&|\\-+"\']' + WORD + '*))?\\s+)*?' + FLAGS + '\\s+' + WRAPPED_CODE +
      '|(^|[\\s;&|(])eval\\s+["\']?\\s*' + GITX + '(\\s|["\']|$)' +
      '|(^|[\\s;&|(])xargs\\s+(?:-[A-Za-z]+(?:\\s+\\S+)?\\s+)*' + GITX + '(\\s|$)',
      'i');
    const isWrapper = WRAPPER_RUNS_GIT.test(heredocStripped);

    // 純引述：剝掉引號後一個 git token 都不剩（與 parseGitCalls 的 git token 同一判準）
    if (!isWrapper && !/(^|[^A-Za-z0-9_.\-])git(?:\.(?:exe|cmd|bat|com))?(\s|$)/i.test(quotesGone)) process.exit(0);

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
    // 換行也是指令分隔：cd 分在不同行（`cd A` 換行 `cd B` 換行 `git reset --hard`）時若只數到第一個，
    // 範圍會被算成 A、B 的覆寫照樣被蓋掉。
    const cdFound = (function () {
      const re = /(?:^|[;&|(\n])\s*(?:cd|Set-Location|sl|pushd)\s+("[^"]+"|'[^']+'|\S+)/gi;
      const found = [];
      let m;
      while ((m = re.exec(heredocStripped)) !== null) found.push(m[1]);
      return found;
    })();
    // cd 的「目標」以 - 開頭（cd -P lib、Set-Location -Path lib）＝抓到的是旗標不是目錄，判不出
    // 改動前只認「開頭或 ; & | ( 之後」的 cd；換行之後的 cd 是新增的。兩種算法都恰好一個時才採用，
    // 確保縮小範圍的情形是改動前的子集（改動前掃全部的，這裡一定也掃全部）。
    const headCd = heredocStripped.match(/(?:^|[;&|(])\s*(?:cd|Set-Location|sl|pushd)\s+("[^"]+"|'[^']+'|\S+)/gi) || [];
    const cdTarget = cdFound.length === 1 && headCd.length === 1 && !/^-/.test(stripArgQuotes(cdFound[0])) ? topOfPath(cdFound[0]) : null;
    let scanTops = knownTops;
    const resolved = danger.repoHints.map((h) => (h && h.multi ? null : (h ? topOfPath(h) : cdTarget)));
    if (resolved.length && resolved.every((r) => r !== null)) scanTops = [...new Set(resolved)];

    // ── 先照改動前的判法：每個危險呼叫判不出落在哪個 repo 就掃全部 ──
    let atRisk = [];
    const riskOf = (it) => {
      const st = fileState(it.dir, it.ent.file);
      return st && st !== 'clean' && danger.kinds.has(st);
    };
    const label = (it) => path.relative(ROOT, path.join(it.dir, it.ent.file)).split('\\').join('/') || it.ent.file;
    for (const it of items) {
      if (scanTops.indexOf(it.top) < 0) continue;
      if (riskOf(it)) atRisk.push(label(it));
    }
    // ── 依點名路徑放寬：只在語法樹路徑、而且每個 git 呼叫都能確定判斷時 ──
    // 判不出就維持上面的結果（與改動前相同）。沒有解析器、HARNESS_SHELL_PARSER=off、語法樹有錯誤節點都不放寬。
    let precise = false;   // true＝清單是語法樹確認「被點到」的覆寫檔；false＝照改動前整個 repo 判，清單是可能受影響的
    if (atRisk.length) {
      // 放寬自己的例外不能落到外層的 catch（那裡是 fail-open 放行）：出錯就維持上面改動前的結果
      let named = null;
      try { named = astNamedItems(cmd, input.tool_name, input.cwd, ROOT, items, danger); } catch (e) { named = null; }
      if (named) { atRisk = named.filter(riskOf).map(label); precise = true; }
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
    L.push('  · 只想還原某幾個檔 → 用具名路徑 git restore --worktree a.txt b.txt，不要 -- .（語法解析器可用、而且目錄與每個 git 呼叫都判得準時，點名的檔不含覆寫檔就會放行；判不準時照樣擋。' +
      (precise ? '上面列出的就是被點到的覆寫檔）' : '這次沒能逐一判定點名的檔，上面列出的是同一 repo 裡可能受影響的覆寫檔）'));
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
