// 用一個「內層捲動＋圖示字型＋對外資源」的假網頁驗證 capture()：
//   1. 內層捲動區被撐開，截圖高度 ≥ 內容全長
//   2. 沒載入的圖示字型被隱藏
//   3. 本機網頁檔不會對外連線（假網頁會打本機的小伺服器，收到請求就算失敗）
//   4. 檔名有空白與中文的路徑也能截
//   5. 帶 crossorigin／integrity 的本機樣式表也要套用（GitHub 這類網站另存後會這樣寫）
// 執行：node plugins/longshot/tests/longshot.test.mjs（需要電腦上有 Chrome 或 Edge）
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../scripts/longshot.mjs';

const hits = [];
const server = createServer((req, res) => { hits.push(req.url); res.end('x'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const dir = mkdtempSync(join(tmpdir(), 'longshot 測試-'));
const page = join(dir, '測試 頁面.html');
mkdirSync(join(dir, '測試 頁面_files'));
writeFileSync(join(dir, '測試 頁面_files', 'site.css'), '#probe { width: 123px; }');
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><title>測試頁</title>
<link rel="stylesheet" href="http://127.0.0.1:${port}/leak.css">
<link crossorigin="anonymous" media="all" integrity="sha512-AAAA" rel="stylesheet" href="./測試 頁面_files/site.css">
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; font-family: sans-serif; }
  header { height: 60px; background: #036; color: #fff; }
  .main { height: calc(100% - 60px); overflow-y: auto; }
  .block { height: 400px; border-bottom: 1px solid #ccc; }
  .icon { font-family: 'Material Symbols Outlined'; }
</style></head><body>
<div id="probe" style="height:1px"></div>
<header>頁首 <span class="icon">arrow_right_alt</span></header>
<div class="main">${Array.from({ length: 8 }, (_, i) => `<div class="block">區塊 ${i + 1}</div>`).join('')}</div>
<img src="http://127.0.0.1:${port}/leak.png">
<script>fetch('http://127.0.0.1:${port}/leak-js')</script>
</body></html>`);

try {
  const out = join(dir, '輸出.png');
  const r = await capture({ input: page, out, width: 800, scale: 1 });
  const png = readFileSync(out);
  const h = png.readUInt32BE(20), w = png.readUInt32BE(16);
  assert.equal(r.scrollers, 1, '應找到 1 個內層捲動區');
  assert.equal(r.icons, 1, '應隱藏 1 個圖示');
  assert.equal(w, 800);
  assert.equal(r.probe, 123, `本機樣式表沒套用（#probe 寬 ${r.probe}）`);
  assert.ok(h >= 60 + 8 * 400, `截圖高度 ${h} 應 ≥ ${60 + 8 * 400}`);
  assert.deepEqual(hits, [], `本機網頁檔不應對外連線，卻收到：${hits.join(', ')}`);
  console.log(`✅ 通過：${w}×${h}，展開 ${r.scrollers} 個捲動區、隱藏 ${r.icons} 個圖示、對外連線 0 次`);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
