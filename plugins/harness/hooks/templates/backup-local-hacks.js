#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)：把覆寫清單上「目前帶著本機改動」的檔，逐檔存一份備份。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "PreToolUse": [{ "matcher": "Bash|PowerShell", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/backup-local-hacks.js\"", "timeout": 20 }] }]
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
  for (const ent of entries) {
    const dir = repoDirOf(ROOT, ent, cache);
    if (!dir) continue;
    const state = fileState(dir, ent.file);
    if (state === null || state === 'clean') continue;   // ③ 乾淨時不碰既有備份

    const full = state === 'untracked' || state === 'ignored';   // ④
    const ext = full ? '.full' : '.patch';
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

    const base = backupBase(ent);
    const cur = path.join(outDir, base + ext);
    let prev = null;
    try { prev = fs.readFileSync(cur, 'utf8'); } catch (e) {}
    if (prev !== null && prev !== content) {                                    // ② 內容變了才轉存上一版
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      try { fs.writeFileSync(path.join(outDir, base + '.' + ts + ext), prev, 'utf8'); } catch (e) {}
    }
    try {
      fs.writeFileSync(cur, content, 'utf8');
      if (fs.readFileSync(cur, 'utf8') === content) summary.push(ent.file + ' → ' + base + ext);
    } catch (e) {}

    try {
      const olds = fs.readdirSync(outDir)
        .filter((f) => f.startsWith(base + '.') && f.endsWith(ext) && f !== base + ext)
        .sort();
      while (olds.length > HISTORY_KEEP) {
        try { fs.unlinkSync(path.join(outDir, olds.shift())); } catch (e) {}
      }
    } catch (e) {}
  }

  try { fs.writeFileSync(stampFile, String(Date.now()), 'utf8'); } catch (e) {}
  if (summary.length && process.env.OVERRIDES_BACKUP_VERBOSE) {
    process.stderr.write('[覆寫檔備份] ' + summary.join(' | ') + '\n');
  }
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
    if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) || String(ti.command || '')) main();
  } catch (e) {}
  process.exit(0);
});
