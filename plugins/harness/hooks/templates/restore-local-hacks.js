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

// 同一個檔可能同時有 .patch 與 .full（檔案在追蹤／未追蹤之間換過），取較新的那份
function pickBackup(outDir, ent) {
  const base = backupBase(ent);
  const cands = ['.patch', '.full'].map((ext) => {
    const p = path.join(outDir, base + ext);
    try { return { p: p, full: ext === '.full', mtime: fs.statSync(p).mtimeMs }; } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  return cands[0] || null;
}

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
  return { ent: ent, dir: dir, label: label, backup: pickBackup(outDir, ent) };
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

const ok = [], drifted = [], missing = [], noBackup = [], unknown = [];
for (const r of rows) {
  if (!r.dir) { unknown.push(r); continue; }
  const st = fileState(r.dir, r.ent.file);
  if (st === null) { unknown.push(r); continue; }
  if (st !== 'clean') {
    ok.push(r);
    if (r.backup) {
      const cur = currentContent(r.dir, r.ent, r.backup.full);
      if (cur !== null && cur !== fs.readFileSync(r.backup.p, 'utf8')) drifted.push(r);
    }
    continue;
  }
  (r.backup ? missing : noBackup).push(r);
}

console.log('=== 本機覆寫狀態（' + rows.length + ' 個）===');
console.log('  仍有本機改動            : ' + ok.length + (drifted.length ? '（其中 ' + drifted.length + ' 個內容與最新備份不同）' : ''));
console.log('  不見了但有備份可救      : ' + missing.length);
console.log('  不見了且無備份          : ' + noBackup.length);
if (unknown.length) console.log('  認不出 repo 或 git 讀不到: ' + unknown.length);

if (drifted.length) {
  console.log('');
  console.log('以下檔案仍有改動，但內容與最新備份不同（可能被部分覆寫、或在別處改過；只提示，不自動套）：');
  drifted.forEach((r) => console.log('    ' + r.label + '  ←→ ' + path.basename(r.backup.p)));
}
if (unknown.length) {
  console.log('');
  console.log('以下條目認不出所在 repo 或 git 讀不到，未判斷：');
  unknown.forEach((r) => console.log('    ' + r.label));
}
if (noBackup.length) {
  console.log('');
  console.log('以下檔案沒有本機改動、也沒有備份——可能本來就沒覆寫，也可能備份前就沒了：');
  noBackup.forEach((r) => console.log('    ' + r.label));
  console.log('  ' + (SETUP_DOC ? '對照 ' + SETUP_DOC + ' 逐項確認該補什麼值。' : '對照清單每筆的 reason 欄逐項確認該補什麼值。'));
}

if (!doRestore) {
  if (missing.length) {
    console.log('');
    console.log('以下 ' + missing.length + ' 個覆寫不見了，但備份在：');
    missing.forEach((r) => console.log('    ' + r.label.padEnd(60) + ' ' + path.basename(r.backup.p)));
    console.log('');
    console.log('這是檢查模式，沒有改動任何檔案。要實際救回請加 --restore：');
    console.log('  ' + RESTORE_CMD + ' --restore');
    process.exit(2);
  }
  console.log('');
  console.log(noBackup.length ? '沒有可自動救回的項目。' : '全部完好，不需救回。');
  process.exit(0);
}

const targets = doAll ? rows.filter((r) => r.dir && r.backup) : missing;
console.log('');
console.log('=== 開始救回（' + targets.length + ' 個）===');
let done = 0, failed = 0;
for (const r of targets) {
  try {
    if (r.backup.full) {
      // 存的是整份內容：直接寫回。不能用 git apply——沒有 diff header，git 也不認得這個檔。
      const dest = path.join(r.dir, r.ent.file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(r.backup.p, 'utf8'), 'utf8');
    } else {
      execFileSync('git', ['-C', r.dir, 'apply', r.backup.p], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    console.log('  OK    ' + r.label);
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
