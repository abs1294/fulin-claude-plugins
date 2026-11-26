#!/usr/bin/env node
// 網頁長截圖：把整頁（含內層捲動區）截成一張 PNG。零相依，用電腦上已裝的 Chrome／Edge（Node 22 以上）。
//
//   node longshot.mjs chrome [輸出.png]          Chrome 目前分頁：自動另存 → 截圖 → 刪掉另存檔（macOS／Windows）
//   node longshot.mjs <網頁檔.html|.mhtml> [輸出.png]   已另存的網頁檔：離線開啟、不執行頁面程式
//   node longshot.mjs <https://網址> [輸出.png]         公開網頁：正常連線並執行頁面程式
//   選項：--width 1440（版面寬度，預設 1440）  --scale 2（清晰度倍數，預設 2）
//
// 輸出沒給：存到桌面，檔名＝網頁標題＋時間。
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 參數 ----------
function parseArgs(argv) {
  const a = [...argv];
  const num = (name, def) => { const i = a.indexOf(name); if (i < 0) return def; const v = Number(a[i + 1]); a.splice(i, 2); return v > 0 ? v : def; };
  const width = num('--width', 1440);
  const scale = num('--scale', 2);
  return { width, scale, input: a[0], out: a[1] };
}

// ---------- 找瀏覽器 ----------
function findBrowser() {
  if (process.env.LONGSHOT_BROWSER && existsSync(process.env.LONGSHOT_BROWSER)) return process.env.LONGSHOT_BROWSER;
  const env = process.env;
  const list = IS_WIN ? [
    join(env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ] : IS_MAC ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const hit = list.find(p => p && existsSync(p));
  if (!hit) throw new Error('找不到 Chrome 或 Edge。可用環境變數 LONGSHOT_BROWSER 指定瀏覽器執行檔路徑。');
  return hit;
}

// ---------- 極簡 CDP（Chrome DevTools Protocol）連線 ----------
async function launch() {
  if (typeof WebSocket === 'undefined') throw new Error(`需要 Node 22 以上（目前 ${process.version}）`);
  const profile = mkdtempSync(join(tmpdir(), 'longshot-'));
  const proc = spawn(findBrowser(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) { proc.kill(); throw new Error('瀏覽器沒有啟動（15 秒內沒有回應）'); }
  await sleep(100);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('連不上瀏覽器的除錯介面')); });

  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { ok, fail, method } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? fail(new Error(`${method}：${m.error.message}`)) : ok(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  });
  const close = async () => {
    try { await Promise.race([send('Browser.close'), sleep(2000)]); } catch {}
    try { ws.close(); } catch {}
    try { proc.kill(); } catch {}
    for (let i = 0; i < 10; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
  };
  return { send, on: fn => listeners.push(fn), close };
}

// 在頁面裡執行：隱藏沒載入的圖示字型、把內層捲動區撐開成全長
const PREPARE = `(() => {
  let icons = 0;
  for (const e of document.querySelectorAll('*')) {
    if (e.children.length) continue;
    if (/symbol|material|icon/i.test(getComputedStyle(e).fontFamily)) { e.style.setProperty('visibility', 'hidden', 'important'); icons++; }
  }
  const scrollers = [...document.querySelectorAll('*')].filter(e => {
    const s = getComputedStyle(e);
    return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 10 && e.clientWidth > 300;
  });
  const unlock = e => { e.style.setProperty('overflow', 'visible', 'important'); e.style.setProperty('height', 'auto', 'important'); e.style.setProperty('max-height', 'none', 'important'); };
  for (const sc of scrollers) for (let e = sc; e && e !== document.documentElement; e = e.parentElement) unlock(e);
  unlock(document.body); unlock(document.documentElement);
  const probe = document.getElementById('probe');
  return { icons, scrollers: scrollers.length, probe: probe ? probe.offsetWidth : undefined, title: document.title, height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) };
})()`;

// 拿掉標籤上的 crossorigin 與 integrity 屬性（逐位元組處理，不動原本的文字編碼）
function stripCors(buf) {
  const html = buf.toString('latin1').replace(/<(link|script|img)\b[^>]*>/gi,
    tag => tag.replace(/\s(?:integrity|crossorigin)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, ''));
  return Buffer.from(html, 'latin1');
}

// ---------- 截圖 ----------
export async function capture({ input, out, width = 1440, scale = 2, title: titleHint }) {
  const isUrl = /^https?:\/\//i.test(input);
  if (!isUrl && !existsSync(input)) throw new Error(`找不到檔案：${input}`);
  const target = isUrl ? input : pathToFileURL(realpathSync(input)).href;
  const b = await launch();
  try {
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s } = await b.send('Target.attachToTarget', { targetId, flatten: true });
    let loaded = false;
    const patchHtml = !isUrl && /\.html?$/i.test(input);
    b.on(m => {
      if (m.sessionId !== s) return;
      if (m.method === 'Page.loadEventFired') loaded = true;
      if (m.method === 'Fetch.requestPaused') {
        const u = m.params.request.url;
        // 另存的網頁常帶 crossorigin／integrity：本機檔案過不了跨來源檢查，Chrome 另存時改寫過 CSS 也對不上校驗值，
        // 樣式表會整個被擋掉（GitHub 就是這樣）→ 主網頁送進瀏覽器前先拿掉這兩個屬性
        if (patchHtml && m.params.resourceType === 'Document' && u === target) {
          const raw = readFileSync(realpathSync(input));
          const charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(raw.subarray(0, 4096).toString('latin1')) || [, 'utf-8'])[1];
          b.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: `text/html; charset=${charset}` }], body: stripCors(raw).toString('base64') }, s).catch(() => {});
          return;
        }
        // 本機網頁檔：只准讀本機檔案，任何對外連線一律擋掉
        (/^(file|data|blob):/i.test(u)
          ? b.send('Fetch.continueRequest', { requestId: m.params.requestId }, s)
          : b.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, s)).catch(() => {});
      }
    });
    await b.send('Page.enable', {}, s);
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: scale, mobile: false }, s);
    if (!isUrl) {
      await b.send('Emulation.setScriptExecutionDisabled', { value: true }, s);
      await b.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, s);
    }
    await b.send('Page.navigate', { url: target }, s);
    for (let i = 0; i < 600 && !loaded; i++) await sleep(100);
    if (!loaded) console.warn('頁面 60 秒內沒載完，照現況截');
    await sleep(isUrl ? 3000 : 1000);

    // 頁面程式被關掉時，在獨立的執行環境跑整理程式
    const { executionContextId } = await b.send('Page.createIsolatedWorld', { frameId: targetId, worldName: 'longshot', grantUniveralAccess: true }, s);
    const r = await b.send('Runtime.evaluate', { expression: PREPARE, contextId: executionContextId, returnByValue: true }, s);
    const info = r.result.value;
    await sleep(800);
    const m = await b.send('Page.getLayoutMetrics', {}, s);
    const height = Math.min(Math.ceil(Math.max(info.height, (m.cssContentSize || m.contentSize).height)), 30000);
    const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }, s);

    const name = (titleHint || info.title || '網頁').replace(/[\/\\:*?"<>|\r\n]/g, '_').trim().slice(0, 60) || '網頁';
    const stamp = new Date().toLocaleString('sv-SE').replace(/[-: ]/g, '').slice(0, 12);
    const file = resolve(out || join(desktopDir(), `${name}-${stamp}.png`));
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return { file, width, height, scale, ...info };
  } finally {
    await b.close();
  }
}

function desktopDir() {
  const cands = IS_WIN
    ? [process.env.OneDrive && join(process.env.OneDrive, 'Desktop'), join(homedir(), 'Desktop')]
    : [join(homedir(), 'Desktop')];
  return cands.find(p => p && existsSync(p)) || homedir();
}

// ---------- 自動另存 Chrome 目前分頁 ----------
function saveCurrentTab(name) {
  if (IS_MAC) {
    const q = s => execFileSync('osascript', ['-e', s], { encoding: 'utf8' }).trim();
    const title = q('tell application "Google Chrome" to get title of active tab of front window');
    const url = q('tell application "Google Chrome" to get URL of active tab of front window');
    let old = '';
    try { old = execFileSync('pbpaste', { encoding: 'utf8' }); } catch {}
    execFileSync('pbcopy', { input: name });  // 用貼上的方式填檔名，避免中文輸入法吃掉英文字
    try {
      execFileSync('osascript', ['-e', `tell application "Google Chrome" to activate
delay 0.5
tell application "System Events"
  keystroke "s" using command down
  delay 1.5
  keystroke "a" using command down
  keystroke "v" using command down
  delay 0.3
  key code 36
end tell`]);
    } finally {
      execFileSync('pbcopy', { input: old });
    }
    return { title, url };
  }
  if (IS_WIN) {
    const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 1
if (-not $p) { Write-Error '找不到開著的 Chrome 視窗'; exit 2 }
$old = Get-Clipboard -Raw -ErrorAction SilentlyContinue
Set-Clipboard -Value '${name}'
$ws = New-Object -ComObject WScript.Shell
$null = $ws.AppActivate($p.Id)
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait('^s')
Start-Sleep -Milliseconds 2000
[System.Windows.Forms.SendKeys]::SendWait('^a')
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 300
if ($old) { Set-Clipboard -Value $old }
Write-Output ($p.MainWindowTitle -replace ' - Google Chrome$', '')
`;
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    const title = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8' }).trim();
    return { title, url: '' };
  }
  throw new Error('自動另存只支援 macOS 與 Windows；Linux 請先手動另存，再用 longshot <網頁檔>');
}

function findSaved(name) {
  const h = homedir();
  const roots = [join(h, 'Downloads'), join(h, 'Desktop'), join(h, 'Documents')];
  if (process.env.OneDrive) roots.push(join(process.env.OneDrive, 'Desktop'), join(process.env.OneDrive, 'Documents'));
  const want = new Set([`${name}.html`, `${name}.htm`, `${name}.mhtml`, `${name}.mht`]);
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) if (e.isFile() && want.has(e.name)) return join(dir, e.name);
    if (depth > 0) for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) { const r = walk(join(dir, e.name), depth - 1); if (r) return r; }
    return null;
  };
  for (const r of roots) { const hit = walk(r, 1); if (hit) return hit; }
  return null;
}

async function fromChrome(opts) {
  const name = `longshot-${Date.now()}`;
  const { title, url } = saveCurrentTab(name);
  console.log(`要截的頁面：${title}${url ? `\n  ${url}` : ''}`);
  let file = null;
  for (let i = 0; i < 60 && !(file = findSaved(name)); i++) await sleep(1000);
  if (!file) throw new Error(`60 秒內沒找到另存的網頁檔（${name}）。多半是另存視窗沒出現，或沒有給自動操作的權限（見 README）。`);
  // 等附屬資料夾寫完：大小連續兩次不變
  const assets = join(dirname(file), `${basename(file).replace(/\.(html?|mhtml?)$/i, '')}_files`);
  const size = () => { try { return readdirSync(assets).reduce((n, f) => n + statSync(join(assets, f)).size, 0); } catch { return 0; } };
  for (let last = -1, i = 0; i < 20; i++) { const now = size() + statSync(file).size; if (now === last) break; last = now; await sleep(700); }
  console.log(`已另存：${file}`);
  try {
    return await capture({ ...opts, input: file, title });
  } finally {
    // 另存的網頁檔含登入後的頁面內容，截完就刪
    rmSync(file, { force: true });
    rmSync(assets, { recursive: true, force: true });
    console.log('已刪除另存的網頁檔');
  }
}

// ---------- 主程式 ----------
const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.input || ['-h', '--help'].includes(opts.input)) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(opts.input ? 0 : 1);
  }
  try {
    const r = opts.input === 'chrome' ? await fromChrome(opts) : await capture(opts);
    console.log(`完成：${r.file}`);
    console.log(`寬 ${r.width}px、高 ${r.height}px（×${r.scale}）；展開 ${r.scrollers} 個捲動區、隱藏 ${r.icons} 個圖示`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}
