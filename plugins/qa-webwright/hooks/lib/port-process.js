'use strict';
/**
 * port-process — 從 port 找到「此刻在 LISTEN 的 process」，推出它讀設定檔時會看的目錄。
 *
 * 為什麼：同一台機器常同時跑好幾套服務（主線、別的分支、別人的 session），環境檔寫的值要跟
 * **實際在跑、正在被測的那一套**比，而不是跟原始碼裡的某一份比——兩者可能不同步，
 * 也可能根本不是同一套。比錯對象時症狀從來不是「環境拿錯」，而是很後面的斷言紅燈。
 *
 * 取得方式（查不到一律回 null，呼叫端當「無從判斷」放行）：
 *   Windows       netstat -ano 找 LISTENING 的 pid（含 IPv6） → Get-CimInstance 取 ExecutablePath／CommandLine
 *   macOS／Linux  lsof -nP -iTCP:<port> -sTCP:LISTEN 取 pid → lsof -d cwd 取工作目錄（Linux 先試 /proc/<pid>/cwd）
 *                 → ps -o command= 取命令列
 * 候選目錄＝工作目錄 ＋ 命令列裡真的存在的路徑（檔案取其目錄）＋ 執行檔所在目錄；由近到遠往上找目標檔。
 *   路徑落在 node_modules 裡（vite 這類由套件啟動的工具）→ 改取 node_modules 外面那層，否則會把套件自己當專案根；
 *   路徑落在 bin 裡（.NET 建置輸出）→ 先試 bin 的上一層（dotnet run 讀的是專案目錄那份設定），再試原目錄。
 * 時間：所有子程序共用 LOOKUP_BUDGET_MS，用完就當查不到（fail-open），不讓 hook 被外層逾時砍掉；netstat 輸出同一次呼叫內共用。
 * LISTEN 判定：Windows 認狀態欄含 LISTEN，或對方位址是 :0（非英文系統的 netstat 會把狀態字樣在地化）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CALL_MS = 4000;
const LOOKUP_BUDGET_MS = 9000;
// 預算與 netstat 快取屬於「一次 hook 執行」：hook 每次都是新 process，自然重來；
// 長駐的呼叫端（測試框架反覆輪詢）要自己呼叫 reset()，否則會沿用舊快照、或預算早已用完
let started = Date.now();

function run(cmd, args) {
  const left = LOOKUP_BUDGET_MS - (Date.now() - started);
  if (left < 500) return null;
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: Math.min(CALL_MS, left), windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '');
  } catch (_) {
    return null;
  }
}

let netstatOut;

function pidOfPort(port) {
  if (!/^\d{1,5}$/.test(String(port))) return null;
  if (process.platform === 'win32') {
    if (netstatOut === undefined) netstatOut = run('netstat', ['-ano']); // 不加 -p TCP：那會漏掉只聽 IPv6（[::]:port）的服務
    const out = netstatOut;
    if (!out) return null;
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // Proto  Local  Foreign  State  PID
      if (cols.length >= 5 && /^TCP/i.test(cols[0]) && (/LISTEN/i.test(cols[3]) || /:0$/.test(cols[2]))
        && new RegExp(':' + port + '$').test(cols[1]) && /^\d+$/.test(cols[4]) && cols[4] !== '0') return cols[4];
    }
    return null;
  }
  const out = run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp']);
  if (!out) return null;
  const m = /^p(\d+)$/m.exec(out);
  return m ? m[1] : null;
}

function infoOfPid(pid) {
  if (process.platform === 'win32') {
    const ps = "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "'; "
      + 'if ($p) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; '
      + '@{ exe = $p.ExecutablePath; cmd = $p.CommandLine } | ConvertTo-Json -Compress }';
    const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]); // portable-ok: 只在 win32 分支執行，macOS／Linux 走下方 lsof／ps
    if (!out || !out.trim()) return null;
    try {
      const j = JSON.parse(out.trim());
      return { pid, cwd: null, exe: j.exe || null, cmd: j.cmd || '' };
    } catch (_) {
      return null;
    }
  }
  let cwd = null;
  try {
    cwd = fs.readlinkSync('/proc/' + pid + '/cwd');
  } catch (_) {
    const out = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const m = out ? /^n(\/.*)$/m.exec(out) : null;
    cwd = m ? m[1] : null;
  }
  const cmd = (run('ps', ['-o', 'command=', '-p', String(pid)]) || '').trim();
  return { pid, cwd, exe: null, cmd };
}

// 命令列裡像路徑的字詞（去引號）；相對路徑以工作目錄解析。只收真的存在的。
function pathsInCommand(cmd, cwd) {
  const found = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || ''))) !== null) {
    let w = m[1] || m[2] || m[3] || '';
    w = w.replace(/^--?[\w-]+=/, ''); // --project=src/App 這種
    if (!/[\\/]/.test(w)) continue;
    const abs = path.isAbsolute(w) ? w : (cwd ? path.resolve(cwd, w) : null);
    if (!abs) continue;
    try {
      const st = fs.statSync(abs);
      found.push(st.isDirectory() ? abs : path.dirname(abs));
    } catch (_) {
      /* 不存在就不是線索 */
    }
  }
  return found;
}

// 一個線索目錄 → 依序要試的目錄：node_modules 裡的取外層；bin 裡的先試 bin 上一層
function expand(d) {
  const abs = path.resolve(d);
  const parts = abs.split(/[\\/]/);
  // 切到磁碟根時要補分隔符：「C:」會被 path.resolve 解成該磁碟當下的工作目錄，不是根目錄
  const join = (arr) => {
    const s = arr.join(path.sep);
    if (!s) return path.sep;
    return /^[A-Za-z]:$/.test(s) ? s + path.sep : s;
  };
  const nm = parts.findIndex((x) => x.toLowerCase() === 'node_modules');
  if (nm > 0) return [join(parts.slice(0, nm))];
  let bin = -1;
  parts.forEach((x, i) => { if (x.toLowerCase() === 'bin') bin = i; });
  if (bin > 0) return [join(parts.slice(0, bin)), abs];
  return [abs];
}

function candidateDirs(info) {
  const dirs = [];
  const add = (d) => {
    if (!d) return;
    for (const e of expand(d)) if (!dirs.some((x) => path.resolve(x) === path.resolve(e))) dirs.push(e);
  };
  if (info.cwd) add(info.cwd);
  for (const d of pathsInCommand(info.cmd, info.cwd)) add(d);
  if (info.exe) add(path.dirname(info.exe));
  return dirs;
}

// 從候選目錄由近到遠往上找 rel（最多 up 層）；回第一個存在的絕對路徑
function findUp(dirs, rel, up) {
  for (const d of dirs) {
    let cur = path.resolve(d);
    for (let i = 0; i <= up; i++) {
      const f = path.join(cur, rel);
      if (fs.existsSync(f)) return f;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

const cache = new Map();

// 回 { pid, dirs, cmd, exe } 或 null（查不到）
function lookup(port) {
  const key = String(port);
  if (cache.has(key)) return cache.get(key);
  let res = null;
  const pid = pidOfPort(port);
  if (pid) {
    const info = infoOfPid(pid);
    if (info) res = { pid, dirs: candidateDirs(info), cmd: info.cmd, exe: info.exe, cwd: info.cwd };
  }
  cache.set(key, res);
  return res;
}

function reset() {
  started = Date.now();
  netstatOut = undefined;
  cache.clear();
}

module.exports = { lookup, findUp, pathsInCommand, pidOfPort, candidateDirs, reset, expandDir: expand };
