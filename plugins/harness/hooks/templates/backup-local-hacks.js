#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)：把覆寫清單上「目前帶著本機改動」的檔，逐檔存一份備份。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/backup-local-hacks.js\"", "timeout": 20, "statusMessage": "備份帶著本機改動的覆寫檔" }] }]
//   程式本身也處理 Write／Edit／MultiEdit／NotebookEdit：要讓「被編輯工具蓋掉」也留得住備份，
//   matcher 改成 "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit"（60 秒節流讓成本可接受）。
//
// 三環防線（同一組四支，缺一環就不完整）：
//   存        ＝ 本檔（每次工具呼叫前備份）
//   擋銷毀    ＝ guard-local-hack-destroy.js（會蓋掉工作區的 git 指令碰到覆寫檔就擋）
//   知道要救  ＝ check-local-hacks-alive.js（開 session 點名哪些覆寫不見了）
//   救        ＝ restore-local-hacks.js（照備份套回；本檔與另兩支的訊息都指向它）
//
// 為什麼「存」比「擋」根本：
// 本機覆寫（連線字串、mock 開關、測試用 token…）刻意不 commit，長期以未提交改動存在——
// 不在 commit、不在 stash、reflog 也沒有，工作區那份就是唯一一份。攔截器走的是另一條路：
// 猜哪些指令會銷毀工作區。那條路沒有收斂點——曾經連續幾輪對抗測試，每輪都找到新的繞過
// （git.exe、heredoc 同行殘餘、cmd /c、sh -c "cd X && git …"），因為正則在解析 shell 語法，
// 而 shell 語法的變體是無窮的（eval、變數、alias、function、base64…）。
// 攔截面無窮大，備份面只有清單上那幾個檔——守方要站在「只有一份」這個根因上。
// 本檔不理解任何指令，所以 sh -c、alias、使用者手動在檔案總管刪檔，全部涵蓋。
//
// 刻意保留的設計：
// ① **一個檔一份備份，不是一個 repo 一份**。曾經發生：演練時只銷毀了其中一個覆寫檔，
//    但該 repo 的整份 patch 裡還含著沒被銷毀的其他檔，`git apply` 撞到「已存在」就整份失敗
//    （它是原子的，全有全無）——救援最需要它的時候（部分銷毀）正好用不了。
//    靜態 `git apply --check` 看不出來，因為演練前所有檔都還是 dirty。逐檔切開，救哪個都互不影響。
// ② **稽核判準比對內容，不是比對「有沒有未提交改動」**。「檔案是 dirty」只證明它跟 HEAD 不同，
//    不證明覆寫值還在（可能被部分覆寫、被工具鏈重生、被別的改動取代）。所以：
//      - 歷史版本只在「新內容與上一份備份不同」時才轉存（不是每次都存一份）；
//      - restore-local-hacks.js 檢查模式會另列「有改動、但內容與最新備份不同」的檔。
// ③ **檔案乾淨時絕不覆寫既有備份**。乾淨＝覆寫已經不見了；此時若照樣寫入空內容，
//    銷毀後的下一次備份就會把唯一一份 patch 蓋成空的。
// ④ **不被 git 追蹤的覆寫檔存整份內容**（副檔名 .full），追蹤中的存 `git diff HEAD`（.patch）。
//    被 .gitignore 排除的檔 `git diff` 一律回空字串，若照 patch 路徑處理會「靜默零備份」——
//    而 `git clean -x` 正好以這類檔為目標，被掃掉就永久消失。來源專案曾經因為「在清單上手動標
//    untracked 旗標、資料轉換時旗標被丟掉」而整批零備份且無任何錯誤；本範本改為依 git 狀態自動判斷，
//    不需要在清單上標任何旗標。
// ⑤ 用 `git diff HEAD` 而非 `git diff`：覆寫檔若被人誤 stage，`git diff`（工作區對 index）會回空，
//    等於靜默跳過。
// ⑥ **檔案被清空或刪除時不存**（判準見 wipedReason）。③ 只擋得住「檔案還原成 HEAD」，擋不住
//    「檔案變成 0 bytes」——後者在 git 眼中仍是有改動，照存會把唯一一份正常的 patch 蓋成整檔刪除。
//    跳過時若已有備份，用 additionalContext 提醒模型（PreToolUse 的 stderr 模型看不到）。
//    行數掉到不到一半（shrunkReason）不跳過：覆寫可能本來就是大幅縮短，跳過的話新版永遠沒有備份，
//    救回還會用舊版蓋掉它。照存（前一版由 ② 留在歷史版本），存的當下提醒一次、附上前一版的檔名。
//
// 永遠放行（exit 0）：本檔只負責備份，不做攔截。fail-open：任何例外一律放行。
// 測試／除錯：環境變數 OVERRIDES_BACKUP_VERBOSE=1 時，把「寫入且讀回一致」的備份清單印到 stderr
// （probe-hooks.js 用它驗「真的產生了備份」）。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 覆寫清單檔（相對於工作目錄根）。與 git-commit plugin 的 flow.sh 讀同一份檔、同一個格式；
// 對應 Phase 1 盤點到的覆寫清單位置（沒有特別指定就用預設）。
const OVERRIDES_REL = '.claude/local-overrides.yml';
// 備份目錄（相對於工作目錄根）。對應 Phase 4 決定的備份落點；記得把它加進 .gitignore。
const BACKUP_DIR_REL = '.claude/hack-backups';
// 救回腳本的指令（對應 init 複製 restore-local-hacks.js 的落點）；只用在提醒訊息。
const RESTORE_CMD = 'node .claude/hooks/restore-local-hacks.js';
// 節流：這段時間內跑過就跳過（毫秒）。每個指令都導 patch 會拖慢互動。
const THROTTLE_MS = 60000;
// 每個檔保留幾份歷史版本（不含最新那份）。
const HISTORY_KEEP = 20;
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

function main() {
  const ROOT = findRoot();
  if (!ROOT) return;
  const outDir = path.join(ROOT, BACKUP_DIR_REL);
  const stampFile = path.join(outDir, '.last-run');

  try {
    const last = Number(fs.readFileSync(stampFile, 'utf8'));
    if (Date.now() - last < THROTTLE_MS) return;
  } catch (e) {}

  const entries = loadEntries(ROOT);
  if (!entries.length) return;
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}

  const cache = {};
  const summary = [];
  const warnings = [];
  for (const ent of entries) {
    const dir = repoDirOf(ROOT, ent, cache);
    if (!dir) continue;
    const state = fileState(dir, ent.file);
    if (state === null || state === 'clean') continue;   // ③ 乾淨時不碰既有備份

    const full = state === 'untracked' || state === 'ignored';   // ④
    const ext = full ? '.full' : '.patch';

    // ⑥ 被清空或刪除時不存、不轉存：這時存下來的不是覆寫，是「覆寫連同整份檔一起不見」，
    //    照存會把唯一一份正常的備份蓋掉（判準見 wipedReason）。已有備份的提醒模型去檢查。
    //    行數大幅減少（shrunkReason）照存——可能是刻意縮短；前一版由 ② 轉存成歷史版本，不會丟——只提醒。
    const label = path.relative(ROOT, path.join(dir, ent.file)).split('\\').join('/') || ent.file;
    const existing = findBackup(outDir, ent);
    const wiped = wipedReason(dir, ent);
    // 清空提醒只發一次：檔案一直維持清空時，每過一次節流都再注入同一則提醒只是噪音（開場的 alive 會再點名）
    const wipedNoted = path.join(outDir, backupBase(ent) + '.wiped-noted');
    if (wiped) {
      if (existing && !fs.existsSync(wipedNoted)) {
        warnings.push(label + '（' + wiped + '）：已保留原備份、沒有覆蓋');
        try { fs.writeFileSync(wipedNoted, wiped + '\n', 'utf8'); } catch (e) {}
      }
      continue;
    }
    try { fs.unlinkSync(wipedNoted); } catch (e) {}
    let ref = null;
    if (existing && existing.full) { try { ref = fs.readFileSync(existing.p, 'utf8'); } catch (e) {} }
    const shrunk = shrunkReason(dir, ent, state, ref);

    let content = '';
    try {
      if (full) {
        content = fs.readFileSync(path.join(dir, ent.file), 'utf8');
      } else {
        try { content = git(dir, ['diff', 'HEAD', '--', ent.file]); }          // ⑤
        catch (e) { content = git(dir, ['diff', '--', ent.file]); }            // 還沒有任何 commit 的 repo
      }
    } catch (e) { continue; }
    if (!content.trim()) continue;
    // 檔案還在、diff 卻是整檔刪除的形狀（例：`git rm --cached` 之後）：這份 patch 救不回任何東西，
    // 存了只會把目前那份正常的備份擠進歷史版本，不存
    if (!full && isWipePatch(content)) continue;

    const base = backupBase(ent);
    const cur = path.join(outDir, base + ext);
    // 縮短提醒只在「剛變短」那一次發：記號檔在＝已經提醒過、目前那份備份已是縮短後的版本。
    // 沒有記號的話，追蹤中的檔（參考 HEAD）之後每改一次都會再提醒，而且「前一版」會指向縮短後的版本
    const noted = path.join(outDir, base + '.shrunk-noted');
    if (!shrunk) { try { fs.unlinkSync(noted); } catch (e) {} }
    let prev = null;
    try { prev = fs.readFileSync(cur, 'utf8'); } catch (e) {}
    if (prev !== null && prev !== content) {                                    // ② 內容變了才轉存上一版
      const ts = historyStamp();
      const histName = base + '.' + ts + ext;
      // 轉存失敗就不覆蓋目前那份：上一版只剩這一份，蓋掉就丟了
      try { fs.writeFileSync(path.join(outDir, histName), prev, 'utf8'); } catch (e) { continue; }
      if (shrunk && !fs.existsSync(noted)) {
        warnings.push(label + '（' + shrunk + '）：已存成新備份，縮短前的版本留在 ' + BACKUP_DIR_REL + '/' + histName + '；不是刻意縮短的話從那份救回');
        try { fs.writeFileSync(noted, histName + '\n', 'utf8'); } catch (e) {}
      }
    }
    try {
      fs.writeFileSync(cur, content, 'utf8');
      if (fs.readFileSync(cur, 'utf8') === content) summary.push(ent.file + ' → ' + base + ext);
    } catch (e) {}

    try {
      const olds = fs.readdirSync(outDir).filter((f) => isHistoryOf(base, f, ext)).sort();
      while (olds.length > HISTORY_KEEP) {
        try { fs.unlinkSync(path.join(outDir, olds.shift())); } catch (e) {}
      }
    } catch (e) {}
  }

  try { fs.writeFileSync(stampFile, String(Date.now()), 'utf8'); } catch (e) {}
  if (summary.length && process.env.OVERRIDES_BACKUP_VERBOSE) {
    process.stderr.write('[覆寫檔備份] ' + summary.join(' | ') + '\n');
  }
  return warnings;
}

// PreToolUse 以 exit 0 結束時 stderr 模型看不到，提醒走 additionalContext
function report(warnings) {
  if (!warnings || !warnings.length) return;
  const msg = '[覆寫檔備份] 以下本機覆寫檔被清空、刪除，或行數大幅減少：\n' +
    warnings.map((w) => '  - ' + w).join('\n') + '\n' +
    '檢查：' + RESTORE_CMD + '（不加參數只檢查、不改檔）；確認後用 ' + RESTORE_CMD + ' --restore 救回。';
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }));
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const tool = String(input.tool_name || '');
    const ti = input.tool_input || {};
    // 不只 git 指令前才備：覆寫也可能被編輯工具蓋掉、被建置工具鏈重生設定檔、被使用者手動改。
    // 節流會擋掉絕大多數重複執行。
    if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) || String(ti.command || '')) report(main());
  } catch (e) {}
  process.exit(0);
});
