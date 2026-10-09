#!/usr/bin/env node
// harness-kind: cli（手動執行的 port 驗證腳本，不是 hook、不接線；有自己的 cases，probe-hooks 照樣測）
// 唯讀檢查：每個 port 上跑的是不是**對的工作樹**（git worktree）、是不是**最新的建置產物**；設定檔裡「誰該打誰」寫的 port
// 跟這次要起的拓撲一不一致；（選填）實際打一次健康檢查網址。只讀不改、不砍任何 process。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 形狀目錄第 30 列（C 類）：有多個工作樹、而且有在本機起服務的工作法時才裝。
// **不是 hook、不接線**：起好服務之後手動跑；或由 remind-worktree-overrides.js 的 PORT_CHECK_CMD 在起服務時提醒模型去跑
// （只提醒、不會自動執行）。不掛 hook 的理由：第②層要叫 PowerShell／lsof 查 process，Windows 上冷啟一次 PowerShell 就要
// 數秒；服務也還沒起好（hook 跑在起服務的指令「之前」），那一刻量到的是舊的 process，只會誤報。
//
// 為什麼需要：本機覆寫帶齊（覆寫保護那幾支答的是「檔案有沒有改」），整條鏈路照樣可能不通——
//   · 設定值指錯：某個服務設定檔裡寫的下游位址指向沒人聽的 port，檔案照樣有改動，覆寫檢查照樣全綠；
//   · 跑錯工作樹：以為在測某個工作樹，那個 port 上其實是主要工作目錄（或另一個工作樹）起的服務；
//   · 跑的是舊產物：建置過但沒重啟，服務跑的還是舊碼、讀的是建置輸出目錄裡的舊設定。
// 這三種的症狀（某個畫面整批回錯誤、下游逾時）跟成因看起來毫無關聯。來源專案實際因為下游位址指向沒人聽的 port，
// 連撞四輪才定位到；另一輪是「打根路徑回 200 就宣稱起好了」，實際畫面整排連線錯誤。
//
// 用法：
//   node .claude/hooks/check-worktree-ports.js --ports <服務>[@<工作樹>][=<port>],... [--layers config,runtime,http]
//   node .claude/hooks/check-worktree-ports.js --help        # 列出可填的服務名與每個 repo 的工作樹
//   <服務>   ＝填空區 SERVICES 的 name
//   <工作樹> ＝這次從哪個工作樹起：相對專案根的路徑、絕對路徑，或資料夾名（不重複時）；省略＝該 repo 的主要工作目錄
//   <port>   ＝該服務這次自己監聽的 port；省略時用 SERVICES 該筆的 port
//   --layers ＝只跑哪幾層（逗號分隔，預設三層全跑；http 層只對有設 health 的服務跑）
//
// 三層（各層都可單獨跑）：
//   ① config：POINTERS 每一筆——在「來源服務這次的工作樹」裡讀那個設定檔，用正則取出它寫的 port，
//      要等於「目標服務這次的 port」。兩端只要有一端不在這次的 --ports 裡，就標「?」略過（不算通過）。
//   ② runtime：每個 port 上有沒有 process 在聽；那個 process 屬於哪個工作樹（目前目錄、命令列裡的絕對路徑、
//      已載入的模組、執行檔路徑，依序取第一種判得出的，對 `git worktree list --porcelain` 取最長的包含路徑；落在
//      TOOL_DIRS（node_modules、.venv…）裡的路徑不當證據，只剩這種證據時判「?」）、哪個分支；
//      ARTIFACTS 樣式對到的檔最新修改時間晚於 process 啟動時間＝跑的是舊產物（建置後沒重啟）。
//      Windows：PowerShell 的 Get-NetTCPConnection、Get-Process（含 Modules）、Win32_Process 的 CommandLine；
//      Linux：ss -ltnp（沒有就 lsof）＋ /proc/<pid>/cwd、exe、cmdline、maps；macOS：lsof＋ps。
//      平台工具不能用或權限不足時，該項標「? 判不出」並寫明原因——不算失敗、也不算通過。
//   ③ http（選填）：SERVICES 該筆有 health 才跑——實際 GET 一次，比對狀態碼與「回應須包含的字樣」。
//      只看狀態碼會把錯誤頁也當成功，所以字樣請挑「真的拿到值」才會出現的那一段。
//
// 結束碼：0＝沒有不符（判不出的項目會列出來，但不影響結束碼）；1＝有不符；2＝參數或填空區錯誤。
//
// 已知極限：
//   · Windows 取不到別的 process 的目前目錄：命令列只寫相對路徑（在工作樹裡 `node server.js`）、又沒有載入工作樹裡的
//     模組時，第②層判不出是哪個工作樹（標「?」）。用絕對路徑起服務。npm script 起的服務命令列多半只有依賴目錄裡的
//     工具路徑（node_modules/.bin…），那類路徑不採信，Windows 上也會判「?」——Linux／macOS 讀得到目前目錄，判得出。
//   · Linux 沒有 ss、只有 lsof 時，lsof 只看得到自己這個使用者的 process；別人的 process 在聽時會判成「有在聽、
//     取不到 process」（靠直接連線確認有在聽）。
//   · 一個 port 有好幾個 process 在聽時只看第一個；服務跑在容器裡時，port 上是容器的轉送程式，判不出工作樹。
//   · 設定指標只認一行一個值的寫法（正則逐行比對，`#`、`//` 開頭的行視為註解略過）；跨行的設定要自己寫成能逐行命中的正則。

'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 服務表：一個會在本機起的服務一筆。
//   name      這支腳本裡的稱呼（--ports 用的名字；英數字、. _ -）
//   repo      這個服務的程式碼在哪個 repo 的主要工作目錄（相對專案根；'.'＝專案根本身）。工作樹由 `git worktree list` 自動找
//   port      （選填）這個服務平常監聽的 port；--ports 沒寫 port 時用它
//   artifacts （選填）建置產物的路徑樣式（相對工作樹根，`*` 不跨目錄、`**` 跨任意層；萬用字元不會展開進別的工作樹的目錄）：對到的檔最新修改時間晚於 process 啟動時間
//             ＝建置後沒重啟。只填「重啟才會讀」的產物（編譯輸出、建置輸出目錄裡的設定檔）；有熱更新的開發伺服器不要填
//   health    （選填）健康檢查：{ url: 'http://localhost:{port}/<路徑>', status: 200, contains: ['只有拿到值才會出現的字樣'] }
//             {port} 換成這次的 port；contains 可省略（只比狀態碼）
// 例：
//   { name: 'api', repo: 'backend', port: 3000, artifacts: ['bin/Debug/**/*.dll', 'bin/Debug/**/appsettings.*.json'],
//     health: { url: 'http://localhost:{port}/health', status: 200, contains: ['"status":"ok"'] } },
//   { name: 'web', repo: 'frontend', port: 5173 },
const SERVICES = [];
// 設定指標：「誰該打誰」寫在哪個設定檔。一筆＝「from 服務的某個設定檔裡寫的 port，應等於 target 服務這次的 port」。
//   from      寫這個設定的服務（SERVICES 的 name）；檔案在 from 服務這次的工作樹裡讀
//   file      設定檔路徑（相對工作樹根）。服務讀的是建置輸出目錄裡的複本時，原始檔與複本各寫一筆（只改原始檔不重建＝複本還是舊值）
//   pattern   正則字串，逐行比對（不分大小寫），第 1 個擷取群組＝port；一個檔裡命中好幾行時每行各算一筆
//   target    這個值應該等於哪個服務的 port（SERVICES 的 name）
//   label     （選填）表格上的稱呼，省略時用 pattern
// 例：
//   { from: 'web', file: '.env.local', pattern: String.raw`^API_BASE_URL\s*=\s*https?://localhost:(\d+)`, target: 'api', label: 'API_BASE_URL' },
const POINTERS = [];
// 命令列沒給任何參數時改用這組（例：'--ports api=3000,web=5173'）。留空字串＝沒給參數就印用法、結束碼 2。
const DEFAULT_ARGS = '';
// 健康檢查的逾時（毫秒）。
const HTTP_TIMEOUT_MS = 8000;
// 設定指標逐行比對時，以這些字開頭的行當註解略過（註解掉的舊值不算生效）。
const COMMENT_PREFIXES = ['#', '//', ';'];
// 工具／依賴目錄：判 process 屬於哪個工作樹時，路徑裡有任一段等於這些名字的一律不當證據（工作樹可能借用主要工作目錄
// 或全域的依賴，這類路徑只說明「工具裝在哪」，不說明「服務從哪個工作樹起」）。本專案有別的依賴目錄就加進來。
const TOOL_DIRS = ['node_modules', '.bin', '.venv', 'venv', 'site-packages', 'dist-packages', '.cargo', '.rustup', '.gradle', '.m2', '.nuget', '.pnpm-store', '.yarn'];
// ────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..');   // <root>/.claude/hooks → <root>
const SELF = 'node .claude/hooks/check-worktree-ports.js';
const IS_WIN = process.platform === 'win32';
const LAYERS = ['config', 'runtime', 'http'];

// ── 顯示 ──
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
  }
  return w;
}
function pad(s, n) {
  const t = String(s);
  const gap = n - dispWidth(t);
  return gap > 0 ? t + ' '.repeat(gap) : t + ' ';
}
function table(head, rows) {
  const widths = head.map((h, i) => Math.min(48, Math.max(dispWidth(h), ...rows.map((r) => dispWidth(r[i] || '')))) + 1);
  const line = (r) => r.map((c, i) => (i === r.length - 1 ? String(c) : pad(c, widths[i]))).join(' ');
  console.log(line(head));
  console.log('-'.repeat(Math.min(110, widths.reduce((a, b) => a + b + 1, 0) + 10)));
  rows.forEach((r) => console.log(line(r)));
}
function stamp(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '-';
  const d = new Date(ms);
  const two = (n) => (n < 10 ? '0' : '') + n;
  return two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}
const slash = (p) => String(p).split('\\').join('/');
const keyOf = (p) => { const t = slash(path.resolve(p)).replace(/\/+$/, ''); return IS_WIN ? t.toLowerCase() : t; };
function inside(base, p) {
  const b = keyOf(base), q = keyOf(p);
  return q === b || q.startsWith(b + '/');
}
function shown(dir) {
  const rel = slash(path.relative(ROOT, dir));
  return !rel ? '.' : (rel.startsWith('..') || path.isAbsolute(rel) ? slash(dir) : rel);
}

// ── git ──
function git(dir, args) {
  return execFileSync('git', ['-C', dir].concat(args), {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
}
// repo 的工作樹清單：[{ dir, branch, main }]，第一筆是主要工作目錄；不是 git repo 時只有 repo 目錄本身
const wtCache = {};
function worktreesOf(repoDir) {
  const k = keyOf(repoDir);
  if (wtCache[k]) return wtCache[k];
  const list = [];
  try {
    let cur = null;
    for (const line of git(repoDir, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
      let m = line.match(/^worktree (.+)$/);
      if (m) { cur = { dir: path.resolve(m[1]), branch: '-', main: !list.length }; list.push(cur); continue; }
      if (!cur) continue;
      m = line.match(/^branch refs\/heads\/(.+)$/);
      if (m) cur.branch = m[1];
      else if (line === 'detached') cur.branch = '(detached)';
      else if (line === 'bare') cur.branch = '(bare)';
    }
  } catch (e) {}
  if (!list.length) list.push({ dir: path.resolve(repoDir), branch: '-', main: true });
  wtCache[k] = list;
  return list;
}
function repoDirOf(svc) { return path.resolve(ROOT, svc.repo || '.'); }

// ── 用法（錯誤時一律附可直接複製的完整指令；可填的名字由腳本自己掃，不要人去翻文件）──
function usage() {
  const L = [];
  L.push('');
  L.push('用法：' + SELF + ' --ports <服務>[@<工作樹>][=<port>],... [--layers config,runtime,http]');
  L.push('  <服務>   ＝下面列的服務名');
  L.push('  <工作樹> ＝這次從哪個工作樹起（相對專案根的路徑、絕對路徑或資料夾名）；省略＝該 repo 的主要工作目錄');
  L.push('  <port>   ＝該服務這次自己監聽的 port；省略時用服務表裡的預設值');
  if (!SERVICES.length) {
    L.push('');
    L.push('⚠ 填空區的 SERVICES 還是空的：先在本檔「init 填空區」填服務表（與 POINTERS 設定指標）再跑。');
    return L.join('\n');
  }
  L.push('');
  L.push('可填的服務：');
  for (const s of SERVICES) {
    L.push('  ' + pad(s.name, 14) + 'repo ' + pad(s.repo || '.', 20) + (s.port ? '預設 port ' + s.port : '（沒有預設 port，要寫 =<port>）'));
  }
  const seen = new Set();
  const lines = [];
  let sampleWt = null;
  for (const s of SERVICES) {
    const k = keyOf(repoDirOf(s));
    if (seen.has(k)) continue;
    seen.add(k);
    const wts = worktreesOf(repoDirOf(s));
    lines.push('  repo ' + (s.repo || '.') + '：');
    wts.forEach((w) => {
      lines.push('    ' + pad(shown(w.dir), 40) + w.branch + (w.main ? '（主要工作目錄）' : ''));
      if (!w.main && !sampleWt) sampleWt = { svc: s.name, wt: shown(w.dir) };
    });
  }
  L.push('');
  L.push('可填的工作樹（每個 repo 的 git worktree list）：');
  L.push.apply(L, lines);
  L.push('');
  L.push('範例：');
  const portOf = (s) => (s.port ? String(s.port) : '<port>');
  L.push('  # 全部從主要工作目錄起');
  L.push('  ' + SELF + ' --ports ' + SERVICES.map((s) => s.name + '=' + portOf(s)).join(','));
  if (sampleWt) {
    L.push('  # ' + sampleWt.svc + ' 改從工作樹 ' + sampleWt.wt + ' 起（其餘照舊）');
    L.push('  ' + SELF + ' --ports ' + SERVICES.map((s) => s.name + (s.name === sampleWt.svc ? '@' + sampleWt.wt : '') + '=' + portOf(s)).join(','));
  }
  L.push('  # 只驗設定檔（不查 process、不打網址）');
  L.push('  ' + SELF + ' --ports ' + SERVICES[0].name + '=' + portOf(SERVICES[0]) + ' --layers config');
  L.push('');
  L.push('port 填「這次實際要起的值」——本腳本只驗一致性，不會告訴你該選哪個數字。');
  return L.join('\n');
}
function fail2(msg) {
  console.error(msg);
  console.error(usage());
  process.exit(2);
}

// ── 參數 ──
function parseArgs(argv) {
  if (!argv.length && DEFAULT_ARGS.trim()) argv = DEFAULT_ARGS.trim().split(/\s+/);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); process.exit(0); }
  if (!SERVICES.length) fail2('填空區的 SERVICES 是空的，沒有服務可以檢查。');
  const names = new Set();
  for (const s of SERVICES) {
    if (!s || !/^[A-Za-z0-9_.-]+$/.test(String(s.name || ''))) fail2('填空區 SERVICES 有一筆的 name 不合格（要英數字與 . _ -）：' + JSON.stringify(s));
    if (names.has(s.name)) fail2('填空區 SERVICES 的 name 重複：' + s.name);
    names.add(s.name);
  }
  for (const p of POINTERS) {
    if (!p || !names.has(p.from) || !names.has(p.target) || !p.file || !p.pattern) {
      fail2('填空區 POINTERS 有一筆不完整（from／target 要是 SERVICES 的 name，file、pattern 必填）：' + JSON.stringify(p));
    }
    try { new RegExp(p.pattern, 'i'); } catch (e) { fail2('填空區 POINTERS 的 pattern 不是合法正則：' + p.pattern + '（' + e.message + '）'); }
  }
  let spec = null;
  let layers = LAYERS.slice();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ports') { spec = argv[++i]; if (!spec || spec.startsWith('--')) fail2('--ports 後面要接 <服務>[@<工作樹>][=<port>] 清單'); continue; }
    if (a.startsWith('--ports=')) { spec = a.slice(8); continue; }
    if (a === '--layers' || a.startsWith('--layers=')) {
      const v = a === '--layers' ? argv[++i] : a.slice(9);
      if (!v) fail2('--layers 後面要接 config、runtime、http 其中幾個（逗號分隔）');
      layers = v.split(',').map((x) => x.trim()).filter(Boolean);
      const bad = layers.filter((x) => LAYERS.indexOf(x) < 0);
      if (bad.length || !layers.length) fail2('--layers 只認 config、runtime、http：' + v);
      continue;
    }
    fail2('認不得的參數：' + a);
  }
  if (!spec) fail2('缺 --ports。');
  const run = [];
  for (const part of spec.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^([A-Za-z0-9_.-]+)(?:@([^=]+))?(?:=(\d{1,5}))?$/);
    if (!m) fail2('--ports 格式錯誤：' + s + '（要 <服務>[@<工作樹>][=<port>]）');
    const svc = SERVICES.find((x) => x.name === m[1]);
    if (!svc) fail2('沒有這個服務：' + m[1]);
    if (run.some((r) => r.svc.name === svc.name)) fail2('同一個服務寫了兩次：' + svc.name);
    const port = m[3] ? parseInt(m[3], 10) : (svc.port ? parseInt(svc.port, 10) : null);
    if (!port || port < 1 || port > 65535) fail2(svc.name + ' 沒有給 port（服務表也沒有預設值），或 port 不在 1–65535：' + s);
    const wts = worktreesOf(repoDirOf(svc));
    let wt = wts[0];
    if (m[2]) {
      const want = m[2].trim();
      const hits = wts.filter((w) => keyOf(w.dir) === keyOf(path.resolve(ROOT, want)) ||
        keyOf(w.dir) === keyOf(path.resolve(want)) || path.basename(w.dir) === want);
      if (!hits.length) fail2(svc.name + ' 的 repo（' + (svc.repo || '.') + '）沒有這個工作樹：' + want);
      if (hits.length > 1) fail2('工作樹名稱 ' + want + ' 對到好幾個，改寫相對專案根的路徑：' + hits.map((w) => shown(w.dir)).join('、'));
      wt = hits[0];
    }
    if (!fs.existsSync(wt.dir)) fail2(svc.name + ' 的工作目錄不存在：' + wt.dir);
    run.push({ svc, port, wt });
  }
  if (!run.length) fail2('--ports 沒有指定任何服務。');
  const dupPort = run.find((r, i) => run.findIndex((x) => x.port === r.port) !== i);
  if (dupPort) fail2('兩個服務寫了同一個 port：' + dupPort.port);
  return { run, layers };
}

// ── ① 設定一致性 ──
function checkConfig(run) {
  console.log('');
  console.log('=== ① 設定一致性（設定檔寫的 port ↔ 這次的拓撲）===');
  const byName = {};
  run.forEach((r) => { byName[r.svc.name] = r; });
  const rows = [];
  const issues = [];
  let bad = 0, unknown = 0;
  if (!POINTERS.length) { console.log('填空區 POINTERS 是空的，本層沒有東西可比。'); return { bad: 0, unknown: 0, issues }; }
  for (const p of POINTERS) {
    const label = p.label || p.pattern;
    const from = byName[p.from], target = byName[p.target];
    if (!from || !target) {
      unknown++;
      rows.push([p.from + ' → ' + p.target, label, '-', '-', '-', '? 這次沒列 ' + (!from ? p.from : p.target) + '，略過（不算通過）']);
      continue;
    }
    const file = path.join(from.wt.dir, p.file);
    const where = (shown(from.wt.dir) === '.' ? '' : shown(from.wt.dir) + '/') + slash(p.file);
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch (e) {
      bad++;
      rows.push([p.from + ' → ' + p.target, label, '-', String(target.port), where, '✗ 讀不到檔案']);
      issues.push(where + ' 讀不到（' + (e.code || e.message) + '）：確認 ' + p.from + ' 這次的工作樹（' + shown(from.wt.dir) + '）有這個檔；它是本機覆寫的話，從主要工作目錄帶過去。');
      continue;
    }
    const re = new RegExp(p.pattern, 'i');
    let found = 0;
    txt.split(/\r?\n/).forEach((raw, idx) => {
      const line = raw.replace(/^\uFEFF/, '');
      const t = line.trim();
      if (COMMENT_PREFIXES.some((c) => t.startsWith(c))) return;
      const m = line.match(re);
      if (!m) return;
      found++;
      const val = m[1] === undefined ? null : parseInt(m[1], 10);
      const ok = val === target.port;
      if (!ok) bad++;
      rows.push([p.from + ' → ' + p.target, label, val === null ? '?' : String(val), String(target.port), where + ':' + (idx + 1), ok ? 'OK' : '✗ 不一致']);
      if (!ok) {
        issues.push(where + ':' + (idx + 1) + ' 寫的是 ' + (val === null ? '（正則沒有擷取到值）' : val) + '，但 ' + p.target + ' 這次起在 ' + target.port + '。' +
          '改成 ' + target.port + '（或把 ' + p.target + ' 改起在 ' + val + '）；改的是建置前的原始檔時，記得重建並重啟 ' + p.from + '——服務讀的可能是建置輸出目錄裡那份。');
      }
    });
    if (!found) {
      bad++;
      rows.push([p.from + ' → ' + p.target, label, '-', String(target.port), where, '✗ 找不到這個設定']);
      issues.push(where + ' 裡沒有一行對得上 ' + label + '（pattern：' + p.pattern + '）：設定被刪了、被註解掉，或填空區的 pattern 跟實際寫法不同。');
    }
  }
  table(['指標', '欄位', '實際', '期望', '檔案', '結果'], rows);
  return { bad, unknown, issues };
}

// ── ② 執行層：port 上是哪個 process、屬於哪個工作樹 ──
function connectable(port) {
  const tryHost = (host) => new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  return tryHost('127.0.0.1').then((v) => v || tryHost('::1'));
}

function winListeners(ports) {
  const ps = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
foreach ($p in @(${ports.join(',')})) {
  $l = @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
  if ($l.Count -eq 0) { $out += [pscustomobject]@{ port = $p; pid = 0 }; continue }
  $procId = [int]$l[0].OwningProcess
  $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue
  $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  $mods = @(); $modErr = ''
  try { $mods = @($pr.Modules | ForEach-Object { $_.FileName } | Where-Object { $_ -and ($_ -notmatch '^[A-Za-z]:\\Windows\\') } | Select-Object -First 400) } catch { $modErr = $_.Exception.Message }
  $start = $null
  try { if ($pr.StartTime) { $start = $pr.StartTime.ToUniversalTime().ToString('o') } } catch {}
  if (-not $start -and $ci -and $ci.CreationDate) { $start = $ci.CreationDate.ToUniversalTime().ToString('o') }
  $exe = $null
  if ($pr -and $pr.Path) { $exe = $pr.Path } elseif ($ci) { $exe = $ci.ExecutablePath }
  $out += [pscustomobject]@{ port = $p; pid = $procId; name = $pr.ProcessName; exe = $exe; cmd = $ci.CommandLine; start = $start; mods = $mods; modErr = $modErr }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`;
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 45000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const rows = JSON.parse(out.trim());
    const map = {};
    for (const r of (Array.isArray(rows) ? rows : [rows])) {
      map[String(r.port)] = {
        pid: r.pid || 0, name: r.name || '', exe: r.exe || null, cmd: r.cmd || '', cwd: null,
        start: r.start ? Date.parse(r.start) : null, mods: r.mods || [],
        why: (r.pid && !r.cmd && !r.exe) ? '權限不足，讀不到這個 process 的路徑與命令列（換系統管理員身分跑可看到）' : (r.modErr ? '讀不到已載入模組：' + r.modErr : ''),
      };
    }
    return { map };
  } catch (e) {
    return { err: 'PowerShell 查不到 listener（' + String((e && e.message) || e).split(/\r?\n/)[0].slice(0, 120) + '）' };
  }
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, { LC_ALL: 'C' }) });
}
function posixListener(port) {
  // 回傳 { pid }（-1＝有在聽但看不到 pid）、{ pid: 0 }（沒在聽）或 { err }（工具都不能用）
  let ssOk = false;
  try {
    const out = sh('ss', ['-ltnpH']);
    ssOk = true;
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (!cols[3] || !cols[3].endsWith(':' + port)) continue;
      const m = line.match(/pid=(\d+)/);
      return { pid: m ? parseInt(m[1], 10) : -1, via: 'ss' };
    }
    return { pid: 0, via: 'ss' };
  } catch (e) { if (ssOk) return { pid: 0, via: 'ss' }; }
  try {
    const out = sh('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp']);
    const m = out.match(/^p(\d+)/m);
    return m ? { pid: parseInt(m[1], 10), via: 'lsof' } : { pid: 0, via: 'lsof' };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { err: '這台沒有 ss 也沒有 lsof' };
    return { pid: 0, via: 'lsof' };   // lsof 沒找到時以結束碼 1 結束
  }
}
function posixProc(pid) {
  const info = { pid, name: '', exe: null, cmd: '', cwd: null, start: null, mods: [], why: '' };
  const denied = [];
  try { info.cwd = fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (e) { if (e.code === 'EACCES' || e.code === 'EPERM') denied.push('目前目錄'); }
  try { info.exe = fs.readlinkSync('/proc/' + pid + '/exe'); } catch (e) {}
  try { info.cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean).map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '); } catch (e) {}
  try {
    const seen = new Set();
    for (const line of fs.readFileSync('/proc/' + pid + '/maps', 'utf8').split('\n')) {
      const m = line.match(/\s(\/\S.*)$/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); if (seen.size > 2000) break; }
    }
    info.mods = Array.from(seen);
  } catch (e) { if (e.code === 'EACCES' || e.code === 'EPERM') denied.push('已載入模組'); }
  if (!info.cmd) { try { info.cmd = sh('ps', ['-o', 'command=', '-p', String(pid)]).trim(); } catch (e) {} }
  if (!info.cwd) {
    try {
      const m = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).match(/^n(.+)$/m);
      if (m) info.cwd = m[1];
    } catch (e) {}
  }
  try {
    const t = Date.parse(sh('ps', ['-o', 'lstart=', '-p', String(pid)]).trim().replace(/\s+/g, ' '));
    if (!isNaN(t)) info.start = t;
  } catch (e) {}
  try { info.name = sh('ps', ['-o', 'comm=', '-p', String(pid)]).trim(); } catch (e) {}
  if (denied.length) info.why = '權限不足，讀不到' + denied.join('、');
  return info;
}

// 命令列裡的絕對路徑（引號包住的整段、或不含空白的一段；`--x=<路徑>` 取等號之後）
function absPathsIn(cmd) {
  const out = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) {
    let tok = m[1] || m[2] || m[3];
    const eq = tok.indexOf('=');
    if (eq > 0 && !path.isAbsolute(tok)) tok = tok.slice(eq + 1);
    if (IS_WIN ? /^[A-Za-z]:[\\/]/.test(tok) : tok.startsWith('/')) out.push(tok);
  }
  return out;
}

// 路徑有沒有經過工具／依賴目錄（TOOL_DIRS 任一段，Windows 不分大小寫）
function isToolPath(p) {
  const want = new Set(TOOL_DIRS.map((d) => (IS_WIN ? d.toLowerCase() : d)));
  return slash(p).split('/').some((seg) => want.has(IS_WIN ? seg.toLowerCase() : seg));
}

// 這個 process 屬於哪個工作樹：依「目前目錄 → 命令列 → 已載入模組 → 執行檔」取第一種判得出的（同一種裡取票數最多的）。
// 落在工具／依賴目錄裡的路徑一律不當證據：工作樹借用主要工作目錄的依賴時（工作樹放在主要工作目錄底下、自己沒有
// node_modules，`npm run dev` 往上層找到主要工作目錄的 node_modules/.bin），命令列與模組全是主要工作目錄的路徑，
// 拿它們判會把「對的工作樹」誤判成跑錯（審查實測重現）。證據全被排除時回 { toolOnly }，呼叫端判「?」，不判 ✗。
function ownerOf(info, allWts) {
  const deepest = (p) => {
    let best = null;
    for (const w of allWts) if (inside(w.dir, p) && (!best || keyOf(w.dir).length > keyOf(best.dir).length)) best = w;
    return best;
  };
  const sources = [
    ['目前目錄', info.cwd ? [info.cwd] : []],
    ['命令列', absPathsIn(info.cmd)],
    ['已載入模組', info.mods || []],
    ['執行檔', info.exe ? [info.exe] : []],
  ];
  let toolOnly = null;
  for (const [src, paths] of sources) {
    const votes = new Map();
    for (const p of paths) {
      const w = deepest(p);
      if (!w) continue;
      if (isToolPath(p)) { if (!toolOnly) toolOnly = p; continue; }
      const k = keyOf(w.dir);
      const v = votes.get(k) || { w, n: 0, sample: p };
      v.n++;
      votes.set(k, v);
    }
    if (votes.size) {
      const top = Array.from(votes.values()).sort((a, b) => b.n - a.n)[0];
      return { w: top.w, src, sample: top.sample };
    }
  }
  return toolOnly ? { toolOnly } : null;
}

// 產物樣式展開：`*` 不跨目錄、`**` 跨任意層（最多 12 層），回傳最新的 { ms, file }。
// 萬用字元展開時不進 skipDirs（其他工作樹的根目錄）：工作樹放在主要工作目錄底下時，`**` 會掃進別的工作樹，
// 拿別人的建置時間判「舊產物」
function newestArtifact(base, patterns, skipDirs) {
  const skip = new Set((skipDirs || []).map(keyOf).filter((k) => k !== keyOf(base)));
  let best = null;
  const toRe = (seg) => new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', IS_WIN ? 'i' : '');
  const walk = (dir, segs, depth) => {
    if (depth > 12) return;
    if (!segs.length) {
      try {
        const st = fs.statSync(dir);
        if (st.isFile() && (!best || st.mtimeMs > best.ms)) best = { ms: st.mtimeMs, file: dir };
      } catch (e) {}
      return;
    }
    const [seg, ...rest] = segs;
    if (seg === '**') {
      walk(dir, rest, depth);
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const d of ents) {
        const sub = path.join(dir, d.name);
        if (d.isDirectory() && d.name !== '.git' && d.name !== 'node_modules' && !skip.has(keyOf(sub))) walk(sub, segs, depth + 1);
      }
      return;
    }
    if (!/[*?]/.test(seg)) { walk(path.join(dir, seg), rest, depth); return; }
    const re = toRe(seg);
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of ents) if (re.test(n) && !skip.has(keyOf(path.join(dir, n)))) walk(path.join(dir, n), rest, depth + 1);
  };
  for (const pat of patterns || []) walk(base, slash(pat).split('/').filter(Boolean), 0);
  return best;
}

async function checkRuntime(run) {
  console.log('');
  console.log('=== ② 執行層（port 上跑的是哪個工作樹、是不是最新產物）===');
  const issues = [];
  let bad = 0, unknown = 0;
  const allWts = [];
  const seen = new Set();
  const addWts = (dir) => worktreesOf(dir).forEach((w) => { const k = keyOf(w.dir); if (!seen.has(k)) { seen.add(k); allWts.push(w); } });
  run.forEach((r) => addWts(repoDirOf(r.svc)));
  addWts(ROOT);

  let win = null;
  if (IS_WIN) win = winListeners(run.map((r) => r.port));
  const rows = [];
  const procs = [];
  for (const r of run) {
    const label = r.svc.name;
    const want = shown(r.wt.dir);
    let info = null, err = null;
    if (IS_WIN) {
      if (win.err) err = win.err;
      else info = win.map[String(r.port)] || { pid: 0 };
    } else {
      const l = posixListener(r.port);
      if (l.err) err = l.err;
      else if (l.pid > 0) info = posixProc(l.pid);
      else info = { pid: l.pid, why: l.pid < 0 ? '有在聽，但 ss 看不到 pid（權限不足：別的使用者的 process）' : '' , via: l.via };
    }
    // 平台工具沒看到 pid 時，直接連一次確認到底有沒有在聽
    if (err || !info || info.pid <= 0) {
      const open = await connectable(r.port);
      if (!open) {
        bad++;
        rows.push([label, r.port, want, '-', '-', '-', '✗ 沒有服務在聽']);
        issues.push(label + '：port ' + r.port + ' 沒有任何 process 在聽（直接連線也連不上）。服務沒起、起到別的 port，或啟動失敗——看它的啟動輸出。');
        continue;
      }
      unknown++;
      const why = err || info.why || (info.via === 'lsof' ? 'lsof 只看得到自己這個使用者的 process' : '平台工具看不到這個 listener');
      rows.push([label, r.port, '?', '?', '?', '-', '? 有在聽，但判不出 process']);
      issues.push(label + '：port ' + r.port + ' 有在聽（連得上），但判不出是哪個 process——' + why + '。');
      continue;
    }
    const own = ownerOf(info, allWts);
    const startTxt = stamp(info.start);
    if (!own) {
      unknown++;
      rows.push([label, r.port, '?', '?', startTxt, '-', '? 判不出工作樹']);
      issues.push(label + '：port ' + r.port + ' 是 pid ' + info.pid + (info.name ? '（' + info.name + '）' : '') + '，但它的目前目錄、命令列、模組、執行檔都不在任何工作樹裡' +
        (info.why ? '（' + info.why + '）' : IS_WIN ? '（Windows 讀不到別的 process 的目前目錄；命令列只寫相對路徑時判不出，改用絕對路徑起服務）' : '') +
        '。命令列：' + (String(info.cmd || '').slice(0, 160) || '（讀不到）'));
      continue;
    }
    if (own.toolOnly) {
      unknown++;
      rows.push([label, r.port, '?', '?', startTxt, '-', '? 判不出工作樹（證據都在依賴目錄）']);
      issues.push(label + '：port ' + r.port + ' 是 pid ' + info.pid + (info.name ? '（' + info.name + '）' : '') + '，但找得到的路徑都落在工具／依賴目錄（例：' + slash(own.toolOnly) +
        '）——工作樹借用別處的依賴時（例：工作樹沒有自己的 node_modules，npm 往上層找到主要工作目錄的），這類路徑看不出服務是從哪個工作樹起的，不拿來判。' +
        (IS_WIN ? '命令列沒有工作樹裡的腳本路徑、Windows 又讀不到別的 process 的目前目錄，' : '') + '這一項判不出（不算失敗也不算通過），照 B13 手動確認。命令列：' +
        (String(info.cmd || '').slice(0, 160) || '（讀不到）'));
      continue;
    }
    const actual = shown(own.w.dir);
    if (keyOf(own.w.dir) !== keyOf(r.wt.dir)) {
      bad++;
      rows.push([label, r.port, actual, own.w.branch, startTxt, '-', '✗ 跑錯工作樹（應為 ' + want + '）']);
      issues.push(label + '：port ' + r.port + ' 上跑的是 ' + actual + '（' + own.w.branch + '）的服務，不是這次要的 ' + want + '（' + r.wt.branch + '）——' +
        '依據：' + own.src + ' ' + slash(own.sample) + '。停掉 pid ' + info.pid + '，從 ' + want + ' 重新起。');
      continue;
    }
    let art = null;
    if (r.svc.artifacts && r.svc.artifacts.length) art = newestArtifact(r.wt.dir, r.svc.artifacts, allWts.map((w) => w.dir));
    let verdict = 'OK';
    if (r.svc.artifacts && r.svc.artifacts.length) {
      if (!art) {
        unknown++;
        verdict = '? 產物樣式沒對到檔';
        issues.push(label + '：artifacts 樣式在 ' + want + ' 沒有對到任何檔（還沒建置過，或樣式寫錯），判不出新舊。');
      } else if (info.start === null) {
        unknown++;
        verdict = '? 讀不到啟動時間';
        issues.push(label + '：讀不到 pid ' + info.pid + ' 的啟動時間，判不出產物新舊。');
      } else if (art.ms > info.start + 1000) {
        bad++;
        verdict = '✗ 跑的是舊產物';
        issues.push(label + '：' + slash(path.relative(r.wt.dir, art.file)) + ' 在 ' + stamp(art.ms) + ' 更新，晚於 process 啟動（' + startTxt + '）——建置後沒重啟，服務跑的還是舊的。重啟 pid ' + info.pid + '。');
      }
    } else {
      verdict = 'OK（沒設產物樣式，不判新舊）';
    }
    if (info.why && verdict.startsWith('OK')) verdict += '；' + info.why;
    rows.push([label, r.port, actual, own.w.branch, startTxt, art ? stamp(art.ms) : '-', verdict]);
    procs.push(label + '（port ' + r.port + '）pid ' + info.pid + '：' + (String(info.cmd || '').slice(0, 300) || '（讀不到命令列）'));
  }
  table(['服務', 'port', '工作樹', '分支', '起於', '產物', '結果'], rows);
  // listener 的 pid 與完整命令列（判得出工作樹的那幾個）：給要求「貼原始證據」的驗證步驟直接引用
  if (procs.length) {
    console.log('');
    console.log('listener 明細：');
    procs.forEach((s) => console.log('  ' + s));
  }
  return { bad, unknown, issues };
}

// ── ③ HTTP 探測（選填）──
function httpGet(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve({ status: 0, body: '', err: '網址格式錯誤' }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { rejectUnauthorized: false, timeout: HTTP_TIMEOUT_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { if (size < 1048576) { chunks.push(c); size += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: res.statusCode || 0, body: '', err: e.message }));
    });
    req.on('timeout', () => { req.destroy(new Error('逾時 ' + HTTP_TIMEOUT_MS + 'ms')); });
    // 連線被拒時 node 可能丟 AggregateError（IPv4／IPv6 各試一次），message 是空的，改取各自的錯誤碼
    req.on('error', (e) => resolve({ status: 0, body: '', err: e.message || e.code ||
      (Array.isArray(e.errors) ? e.errors.map((x) => x.code || x.message).join('／') : String(e)) }));
  });
}
async function checkHttp(run) {
  console.log('');
  console.log('=== ③ HTTP 探測（有設 health 的服務）===');
  const rows = [];
  const issues = [];
  let bad = 0;
  for (const r of run) {
    const h = r.svc.health;
    if (!h || !h.url) { rows.push([r.svc.name, '-', '-', '- 沒設 health，略過']); continue; }
    const url = String(h.url).split('{port}').join(String(r.port));
    const want = h.status || 200;
    const need = [].concat(h.contains || []).filter(Boolean);
    const res = await httpGet(url);
    if (res.status !== want) {
      bad++;
      rows.push([r.svc.name, url, String(res.status || '-'), '✗ 狀態碼不是 ' + want]);
      issues.push(r.svc.name + '：GET ' + url + ' 回 ' + (res.status || '（連不上：' + res.err + '）') + '，期望 ' + want + '。');
      continue;
    }
    const miss = need.filter((s) => res.body.indexOf(s) < 0);
    if (miss.length) {
      bad++;
      rows.push([r.svc.name, url, String(res.status), '✗ 回應缺 ' + miss.map((s) => '「' + s + '」').join('、')]);
      issues.push(r.svc.name + '：GET ' + url + ' 狀態碼對，但回應裡沒有 ' + miss.map((s) => '「' + s + '」').join('、') +
        '——回的可能是錯誤頁或空資料。回應開頭：' + res.body.replace(/\s+/g, ' ').slice(0, 160));
      continue;
    }
    rows.push([r.svc.name, url, String(res.status), 'OK' + (need.length ? '（含 ' + need.length + ' 段指定字樣）' : '')]);
  }
  table(['服務', '網址', '狀態碼', '結果'], rows);
  return { bad, unknown: 0, issues };
}

async function main() {
  const { run, layers } = parseArgs(process.argv.slice(2));
  console.log('本次拓撲（專案根 ' + slash(ROOT) + '）：');
  run.forEach((r) => console.log('  ' + pad(r.svc.name, 14) + 'port ' + pad(r.port, 7) + shown(r.wt.dir) + '（' + r.wt.branch + (r.wt.main ? '，主要工作目錄' : '') + '）'));
  const results = [];
  if (layers.includes('config')) results.push(['設定一致性', checkConfig(run)]);
  if (layers.includes('runtime')) results.push(['執行層', await checkRuntime(run)]);
  if (layers.includes('http')) results.push(['HTTP 探測', await checkHttp(run)]);

  const bad = results.reduce((a, [, x]) => a + x.bad, 0);
  const unknown = results.reduce((a, [, x]) => a + x.unknown, 0);
  console.log('');
  for (const [name, x] of results) {
    if (!x.issues.length) continue;
    console.log('【' + name + '】');
    x.issues.forEach((s) => console.log('  · ' + s));
  }
  console.log('');
  const parts = results.map(([name, x]) => name + (x.bad ? ' ✗' + x.bad : ' OK') + (x.unknown ? '（? ' + x.unknown + '）' : ''));
  console.log('結論：' + parts.join('／') + '。' +
    (bad ? '有 ' + bad + ' 項不符。' : unknown ? '沒有不符，但有 ' + unknown + ' 項判不出（標 ?）——那幾項沒驗過，不可說成「全部通過」。' : '全部符合。'));
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('執行失敗：' + ((e && e.stack) || e)); process.exit(2); });
