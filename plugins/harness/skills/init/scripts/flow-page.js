#!/usr/bin/env node
'use strict';
/**
 * flow-page.js — 把 Phase 6 的幾張 archify 圖組成同一頁（flow.html）。
 *
 * 為什麼要拆圖再組頁：全部檔案加上讀／寫／擋的關係塞進同一張圖，實測 29 處線交叉、
 * 線穿過別的節點，看不出誰讀誰寫；拆成三張（主流程／文件讀寫／背景與維護）各自無交叉，
 * 再用這支放在同一頁由上往下看。圖本身一律由 archify 產，這支只做外框，不畫圖。
 *
 * 用法：
 *   node flow-page.js <輸出的 flow.html> "<頁面標題>" <圖1.html>:<高度> <圖2.html>:<高度> ...
 *   高度（px）取 archify visual-check 在 1440 寬時回報的 scrollHeight；
 *   visual-check 為 pass（沒有 overflow 診斷）時填 900。圖的路徑寫成相對於 flow.html 的位置。
 */

const fs = require('fs');
const path = require('path');

const [, , out, title, ...figs] = process.argv;
if (!out || !title || !figs.length) {
  console.error('用法：node flow-page.js <flow.html> "<標題>" <圖1.html>:<高度> [<圖2.html>:<高度> ...]');
  process.exit(2);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const frames = figs.map(f => {
  const i = f.lastIndexOf(':');
  const src = i > 1 ? f.slice(0, i) : f;
  const h = i > 1 ? parseInt(f.slice(i + 1), 10) : 900;
  if (!fs.existsSync(path.resolve(path.dirname(out), src))) {
    console.error(`找不到圖：${src}（相對於 ${path.dirname(path.resolve(out))}）`);
    process.exit(2);
  }
  return `  <iframe src="${esc(src)}" style="height:${(h || 900) + 40}px" loading="lazy"></iframe>`;
});

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#f6f7f9; --fg:#1f2328; --muted:#59636e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; } }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:system-ui,"Microsoft JhengHei",sans-serif; }
  header { padding:20px 16px 4px; max-width:1600px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  p { margin:0; color:var(--muted); font-size:14px; }
  iframe { display:block; width:100%; max-width:1600px; margin:12px auto; border:0; }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <p>由上往下 ${frames.length} 張圖；每張圖右上角可切換淺色／深色、匯出圖片。</p>
</header>
${frames.join('\n')}
</body>
</html>
`;
fs.writeFileSync(out, html);
console.log(`已產生 ${out}（${frames.length} 張圖）`);
