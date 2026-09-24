#!/usr/bin/env node
// SessionStart：開場點名本機覆寫還在不在，不在就講清楚哪些救得回、怎麼救。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 接線（目標專案 .claude/settings.json）：
//   "SessionStart": [{ "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/check-local-hacks-alive.js\"", "timeout": 20 }] }]
//
// 為什麼需要：備份（backup-local-hacks.js）與救回（restore-local-hacks.js）都做好了，
// 還少「知道要去救」這一環。覆寫被還原掉時沒有任何症狀會立刻浮現——要等到服務起不來、
// 端點全回授權錯誤、或測試信寄給了真實收件人，才會回頭查，那時往往已經過了好幾個小時。
//
// 判準：清單上的檔「目前沒有任何本機改動」（與 HEAD 相同；未追蹤／被排除的檔則是「不存在」）
// ＝覆寫可能被還原掉了。有備份的列 [可救]、沒有的列 [無備份]。
// 只做偵測與提示，不動任何檔案。訊息印在 stdout（SessionStart 的 stdout 會進入對話脈絡，
// 讓助手能主動轉告使用者）。認不出 repo 目錄、git 讀不到的條目一律不判，避免假警報。
// fail-open：任何例外一律靜默放行。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 覆寫清單檔（相對於工作目錄根）。與 git-commit plugin 的 flow.sh 讀同一份檔、同一個格式；
// 對應 Phase 1 盤點到的覆寫清單位置（沒有特別指定就用預設）。
const OVERRIDES_REL = '.claude/local-overrides.yml';
// 備份目錄（相對於工作目錄根），與 backup-local-hacks.js 的同名常數一致。
const BACKUP_DIR_REL = '.claude/hack-backups';
// 救回腳本的指令（對應 init 複製 restore-local-hacks.js 的落點）。
const RESTORE_CMD = 'node .claude/hooks/restore-local-hacks.js';
// 沒有備份時，去哪裡查該補什麼值（專案若有「本機覆寫該填什麼」的說明文件就填它的路徑；
// 留空字串＝改提示看清單每筆的 reason 欄）。
const SETUP_DOC = '';
// 最多列幾筆（其餘只算數量）。
const MAX_LIST = 16;
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

try {
  const ROOT = findRoot();
  if (!ROOT) process.exit(0);
  const entries = loadEntries(ROOT);
  if (!entries.length) process.exit(0);

  const outDir = path.join(ROOT, BACKUP_DIR_REL);
  const cache = {};
  const gone = [];
  for (const ent of entries) {
    const dir = repoDirOf(ROOT, ent, cache);
    if (!dir) continue;
    const st = fileState(dir, ent.file);
    if (st !== 'clean') continue;   // 還有改動＝還在；null＝讀不到，不判
    const base = backupBase(ent);
    const hasBackup = fs.existsSync(path.join(outDir, base + '.patch')) || fs.existsSync(path.join(outDir, base + '.full'));
    gone.push({ label: path.relative(ROOT, path.join(dir, ent.file)).split('\\').join('/') || ent.file, hasBackup: hasBackup });
  }
  if (!gone.length) process.exit(0);

  const rescuable = gone.filter((g) => g.hasBackup).length;
  const lost = gone.length - rescuable;
  const L = [];
  L.push('[本機覆寫遺失] 覆寫清單（' + OVERRIDES_REL + '）上有 ' + gone.length + ' 個檔目前沒有本機改動——可能被還原掉了。');
  gone.slice(0, MAX_LIST).forEach((g) => L.push('  ' + (g.hasBackup ? '[可救]  ' : '[無備份]') + ' ' + g.label));
  if (gone.length > MAX_LIST) L.push('  …另有 ' + (gone.length - MAX_LIST) + ' 個');
  if (rescuable) {
    L.push('');
    L.push('救回：' + RESTORE_CMD + ' --restore');
    L.push('（先不加 --restore 跑一次，只檢查不改檔）');
  }
  if (lost) {
    L.push('');
    L.push('有 ' + lost + ' 個沒有備份——' + (SETUP_DOC ? '對照 ' + SETUP_DOC + ' 逐項補回。' : '對照清單每筆的 reason 欄逐項補回。'));
  }
  L.push('');
  L.push('若這些檔本來就不該帶覆寫（例如剛拉了新版、或覆寫已正式 commit），忽略本訊息即可。');
  process.stdout.write(L.join('\n') + '\n');
} catch (e) {}
process.exit(0);
