'use strict';
// The board as an app on a phone (Tailscale's https address) or in a browser: with no way to the board - the phone's VPN
// off, the computer asleep, the board stopped - the app showed a white page and nothing else (asked 2026-11-28). This
// says so, and how to try again. Nothing is kept: only a page that could not be fetched at all is answered here, and
// everything else goes to the board as it would without this.
const PAGE = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>連不到看板</title><style>
:root { --bg: #FFFFFF; --ink: #37352F; --dim: #676664; --btn: #E1EFFB; --btn-ink: #124F88; --line: #E9E9E7; color-scheme: light }
@media (prefers-color-scheme: dark) { :root { --bg: #191919; --ink: #E3E2E0; --dim: #9D9C99; --btn: #1E3A54; --btn-ink: #CFE6FF; --line: #2F2F2F; color-scheme: dark } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; }
main { max-width: 420px; margin: 0 auto; padding: max(48px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) 32px max(24px, env(safe-area-inset-left)); }
h1 { font-size: 22px; margin: 0 0 12px; }
p { margin: 0 0 12px; color: var(--dim); }
ul { margin: 0 0 24px; padding-left: 20px; }
li { margin-bottom: 8px; }
a.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 20px; border-radius: 8px; background: var(--btn); color: var(--btn-ink); font-weight: 600; text-decoration: none; }
small { display: block; margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--dim); font-size: 13px; }
</style></head><body><main>
<h1>連不到看板</h1>
<p>這個裝置現在跟執行看板的電腦之間沒有連線。</p>
<ul>
<li>手機：確認 Tailscale（VPN）已連上。</li>
<li>電腦：確認電腦開著、沒有睡眠，看板有在執行。</li>
</ul>
<a class="btn" href="">重試</a>
<small>連上之後按「重試」就會回到看板。</small>
</main></body></html>`;
const WAIT_MS = 30000;   // a VPN half there answers nothing at all: told after this, rather than a white page for minutes (not
// sooner: a slow relay can take a while to bring the first page)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  // only the board's own page: an address it opens itself (an Office file being turned into a page, up to two minutes)
  // is left to answer in its own time (review 2026-11-28: it was told "cannot reach" after 30 s)
  const p = new URL(e.request.url).pathname;
  if (e.request.mode !== 'navigate' || (p !== '/' && p !== '/index.html')) return;
  const offline = () => new Response(PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  // (a navigation's request cannot be made again with options of its own, so not an abort: a race with a timer)
  // (the board stopped behind Tailscale serve: Tailscale answers 502 itself - the board never does for its page)
  e.respondWith(Promise.race([fetch(e.request), new Promise((resolve) => setTimeout(() => resolve(null), WAIT_MS))]).then((r) => (r && ![502, 503, 504].includes(r.status) ? r : offline()), offline));
});
