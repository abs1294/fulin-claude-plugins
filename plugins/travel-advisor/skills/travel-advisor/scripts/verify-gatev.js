#!/usr/bin/env node
/**
 * 驗 Gate-V 的機械判準今天還成立嗎 —— 實際開 Google Maps 比對。
 *
 * 為什麼要有這支：
 *   check-cache.py 只算「查核日 + 有效天數」有沒有過期。
 *   TTL 沒過期【不代表】判準還有效 —— Google 隨時可能改版，
 *   而改版不會通知你，日期算術也看不出來。
 *   這支是唯一能回答「判準今天還活著沒」的東西。
 *
 * 全域 CLAUDE.md 的「驗證器對施作器盲區同構」條款：
 *   本支刻意不重用 skill 內任何既有程式碼，判準字串在這裡重新寫一次。
 *   抄過來會跟著抄錯，兩邊一起錯就驗不出來。
 *
 * 為什麼是 Node 不是 Python：
 *   div.F7nice 是 JS 渲染後才存在的，urllib 抓到的 HTML 裡沒有它。
 *   本機 Python 沒有 playwright 套件，Node 有（實測 1.59.1）。
 *
 * 用法:
 *   node scripts/verify-gatev.js                 驗全部語言介面（ja + en），預設 headed
 *   node scripts/verify-gatev.js --suite ja      只驗日文介面
 *   node scripts/verify-gatev.js --suite ja,en   指定幾組
 *   node scripts/verify-gatev.js --headless      刻意用 headless，會少讀到評論數
 *
 * 驗哪七項（每個測試點都跑）:
 *   [1] [role=feed] === null            不是搜尋列表
 *   [2] div[role=main][aria-label]      有店頁容器
 *   [3] div.F7nice 分數【＋評論數】      分數沒樣本數不可用於比較
 *   [4] aria-label 三分支分類            exact / superset / unrelated
 *   [5] 該語言的營業時間詞彙命中          🔴 靜默失效型，抓不到不報錯
 *   [6] 逐日表 >= 7 列                   規範要的是逐日表，不是一行摘要
 *   [7] URL !3d!4d + !16s               座標與識別碼（語言無關）
 *
 * 換地區要做的事：在 SUITES 加一組（hl / locale / hours / 三種 cases），
 * 然後跑 --suite <新組>。**不要改既有的組。**
 *
 * 🔴 為什麼預設 headed 而不是 headless：
 *   Google Maps 在 headless 下【省略評論數】。本機實測 2026-11-01：
 *     headless=true   UA 含 HeadlessChrome   div.F7nice = "4.4"
 *     headless=false  UA 含 Chrome/145       div.F7nice = "4.4|(80)"
 *   headless 讀到 "4.4" 看起來正常，但樣本數不見了 ——
 *   4.4 配 3 則評論 vs 配 4,603 則，意義完全不同。
 *   這種「看起來成功其實少讀」的失敗最危險，所以預設不用 headless。
 *
 * exit code:
 *   0  判準全部成立（cache 的 E-01/E-02/E-03 可繼續引用）
 *   3  有判準失效（🔴 Gate-V 當下不可用，必須重新實測並改 cache）
 *   1  網路／瀏覽器失敗 —— 無法驗證 ≠ 驗證失敗，兩者刻意分開
 */
'use strict';

/**
 * 各語言介面的測試組。換地區時加一組，不要改既有的。
 *
 * 每組要有三種測試點，少一種就驗不全：
 *   exact    官方店名，aria-label 應【逐字相等】
 *   superset 官方店名 + 多餘的區名，aria-label 應是 query 的【子集】
 *            （這是最容易被二分判準誤判成「店不存在」的形狀）
 *   fake     不存在的分店名，aria-label 應與 query【無包含關係】
 *
 * `hours` 是該語言的營業時間詞彙（會驗它在該介面真的命中）。
 */
const SUITES = {
  ja: {
    label: '日文介面',
    hl: 'ja',
    locale: 'ja-JP',
    hours: ['営業時間', '定休日', '営業中', '休業'],
    cases: [
      { kind: 'exact',    query: '大寅蒲鉾 難波戎橋筋本店' },
      { kind: 'superset', query: '大寅蒲鉾 難波戎橋筋本店 大阪' },
      { kind: 'fake',     query: '551蓬莱 戎橋本店' },
    ],
  },
  zh: {
    label: '繁中介面（台灣）',
    hl: 'zh-TW',
    locale: 'zh-TW',
    hours: ['營業中', '休息中', '公休', '最後點餐', '打烊', '營業時間', '已打烊', '即將打烊'],
    cases: [
      { kind: 'exact',    query: '鼎泰豐 信義店' },
      { kind: 'superset', query: '鼎泰豐 信義店 台北' },
      { kind: 'fake',     query: '鼎泰豐 南極店' },
    ],
  },
  en: {
    label: '英文介面（澳洲）',
    hl: 'en',
    locale: 'en-AU',
    hours: ['Open', 'Closed', 'Opens', 'Closes', 'Hours'],
    cases: [
      { kind: 'exact',    query: 'Flour and Stone' },
      { kind: 'superset', query: 'Flour and Stone Woolloomooloo' },
      { kind: 'fake',     query: 'Gelato Messina Antarctica Branch' },
    ],
  },
};

// 預設驗哪幾組。--suite ja 只驗日文、--suite ja,en 驗兩組。
const DEFAULT_SUITES = ['ja', 'en'];   // zh 在 --suite zh 時驗（台灣不是主要旅遊地，預設不跑省時間）

/**
 * aria-label 的三分支判準（2026-11-01 dry-run 實測得出）。
 *
 * 🔴 不可用二分的逐字比對。實測：搜「Flour and Stone Woolloomooloo」
 *    （雪梨真店，我多打了區名）→ aria-label 回「Flour and Stone」
 *    → 逐字不等 → 二分判準會報「店不存在」，而那家店明明就在。
 *
 * 回 'exact' | 'superset' | 'unrelated'
 */
function classifyAria(query, aria) {
  if (aria == null) return 'unrelated';
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  const q = norm(query), a = norm(aria);
  if (q === a) return 'exact';
  // 我搜的字串包含 aria-label 全文 → 我多打了區名／修飾詞
  if (q.includes(a)) return 'superset';
  return 'unrelated';
}

async function probe(page, query, suite) {
  // 🔴 /maps/place/<店名>/ 這個形狀會被重導向成空白地圖（店名被吃掉）。
  // 必須用 /maps/search/ 才會解析成店頁。見 cache/externals.md E-01 的坑。
  const url = 'https://www.google.com/maps/search/' + encodeURIComponent(query)
              + '?hl=' + suite.hl;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // 等店頁真的長出來：URL 要有 @lat,lng
  try {
    await page.waitForFunction(
      () => /@-?\d+\.\d+,-?\d+\.\d+/.test(location.href),
      { timeout: 30000 }
    );
  } catch (e) {
    return { opened: false, reason: 'URL 沒長出 @lat,lng，沒開到店頁' };
  }
  try {
    await page.waitForSelector('div[role="main"][aria-label]', { timeout: 20000 });
  } catch (e) { /* 讓下面的判準去報 false，不在這裡吞掉 */ }

  return await page.evaluate((hoursWords) => {
    const mainEl = document.querySelector('div[role="main"][aria-label]');
    const f7 = document.querySelector('div.F7nice');
    const bodyText = document.body.innerText;
    // 營業時間詞彙在這個介面命中幾次。
    // 🔴 這一項是靜默失效型：抓不到不會報錯，會被當成「這家店沒有營業時間資訊」。
    const hoursHits = {};
    for (const w of hoursWords) {
      const m = bodyText.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
      if (m) hoursHits[w] = m.length;
    }
    // 逐日表：抓得到幾天（規範要求「逐日表，展開過」，不是一行摘要）
    const dayRows = [...document.querySelectorAll('table tr, [role="row"]')]
      .map((e) => e.innerText.replace(/\n/g, ' ').trim())
      .filter((x) => x && x.length < 60);
    return {
      opened: true,
      href: location.href,
      title: document.title,
      feedIsNull: document.querySelector('[role="feed"]') === null,
      mainExists: !!mainEl,
      mainAria: mainEl ? mainEl.getAttribute('aria-label') : null,
      f7Exists: !!f7,
      f7Text: f7 ? f7.innerText.replace(/\n/g, ' | ') : null,
      hasLatLng: /@-?\d+\.\d+,-?\d+\.\d+/.test(location.href),
      has16s: /!16s/.test(location.href),
      has3d4d: /!3d-?\d+\.\d+!4d-?\d+\.\d+/.test(location.href),
      hoursHits,
      hoursWordsHit: Object.keys(hoursHits).length,
      dayRowCount: dayRows.length,
      dayRowSample: dayRows.slice(0, 3),
      // 自檢：UA 裡有 HeadlessChrome 就代表評論數會被省略，
      // 不論我以為自己開的是 headed（channel 退讓時會發生）。
      ua: navigator.userAgent,
      uaIsHeadless: /HeadlessChrome/.test(navigator.userAgent),
    };
  }, suite.hours);
}

/**
 * 解析 playwright。
 * 🔴 require('playwright') 在這個 skill 目錄下【必然失敗】—— 這裡沒有
 * node_modules，而 Node 預設不搜全域路徑。但 playwright 是真的裝了
 * （本機實測：npm root -g 底下有 playwright，ms-playwright 有 chromium-1208）。
 * 不要看到 require 失敗就寫「環境缺 playwright」—— 那是把自己的疏漏
 * 寫成客觀限制（全域 CLAUDE.md 環境完備性紀律）。
 */
function resolvePlaywright() {
  const { execSync } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const candidates = [];
  // ① 直接 require（有 node_modules 時才成立）
  candidates.push(null);
  // ② 全域 node_modules
  try {
    const groot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
    if (groot) candidates.push(groot);
  } catch (e) { /* npm 不在 PATH 也不要炸 */ }
  // ③ npx 快取（npx playwright 跑過就會留在這）
  const npxCache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  try {
    for (const d of fs.readdirSync(npxCache)) {
      const nm = path.join(npxCache, d, 'node_modules');
      if (fs.existsSync(path.join(nm, 'playwright')) ||
          fs.existsSync(path.join(nm, 'playwright-core'))) candidates.push(nm);
    }
  } catch (e) { /* 沒有這個目錄就跳過 */ }

  for (const base of candidates) {
    for (const mod of ['playwright', 'playwright-core']) {
      const target = base === null ? mod : path.join(base, mod);
      try {
        const m = require(target);
        if (m && m.chromium) return { chromium: m.chromium, from: target };
      } catch (e) { /* 試下一個 */ }
    }
  }
  return null;
}

(async () => {
  const resolved = resolvePlaywright();
  if (!resolved) {
    console.log('CANNOT-VERIFY: playwright not resolvable from node');
    console.log('  searched: require path, npm root -g, %LOCALAPPDATA%\\npm-cache\\_npx\\*');
    console.log('  try: npm i -g playwright && npx playwright install chromium');
    process.exit(1);
  }
  const chromium = resolved.chromium;
  console.log('playwright from  ' + resolved.from);

  // 預設 headed。--headless 才關掉，且會在報告裡標明樣本數可能缺。
  const headed = !process.argv.includes('--headless');

  /**
   * 啟動瀏覽器。
   * 🔴 playwright 的預設 browser revision 常與本機已裝的不符
   * （實測：全域 playwright 1.59.1 要 chromium_headless_shell-1217，
   *  本機只有 -1208，那是 MCP 那套帶的）。
   * 不要為此下載新 browser —— 那會動使用者的機器且耗流量。
   * 依序退讓到不用下載的選項。
   */
  async function launch() {
    const fs = require('fs');
    const path = require('path');
    const tried = [];

    // ① playwright 自帶的 revision（版本相符時最乾淨）
    try {
      return { b: await chromium.launch({ headless: !headed }), how: 'bundled revision' };
    } catch (e) { tried.push('bundled: ' + e.message.split('\n')[0].slice(0, 90)); }

    // ② 系統已裝的 Chrome（不下載任何東西）
    try {
      return { b: await chromium.launch({ headless: !headed, channel: 'chrome' }), how: 'system chrome channel' };
    } catch (e) { tried.push('channel=chrome: ' + e.message.split('\n')[0].slice(0, 90)); }

    // ③ 直接指到 ms-playwright 底下任一已裝的 chromium
    const msRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    try {
      for (const d of fs.readdirSync(msRoot)) {
        if (!/^chromium-\d+$/.test(d)) continue;
        const exe = path.join(msRoot, d, 'chrome-win64', 'chrome.exe');
        if (!fs.existsSync(exe)) continue;
        try {
          return { b: await chromium.launch({ headless: !headed, executablePath: exe }), how: 'executablePath ' + d };
        } catch (e) { tried.push(d + ': ' + e.message.split('\n')[0].slice(0, 90)); }
      }
    } catch (e) { tried.push('ms-playwright scan: ' + e.message.split('\n')[0].slice(0, 90)); }

    const err = new Error('all launch paths failed');
    err.tried = tried;
    throw err;
  }

  let browser, launchedHow;
  try {
    const r = await launch();
    browser = r.b; launchedHow = r.how;
    console.log('browser via      ' + launchedHow);
  } catch (e) {
    console.log('CANNOT-VERIFY: browser launch failed');
    for (const t of (e.tried || [e.message])) console.log('  - ' + t);
    process.exit(1);
  }

  // 要驗哪幾組語言介面
  const suiteArgIdx = process.argv.indexOf('--suite');
  const wanted = suiteArgIdx >= 0 && process.argv[suiteArgIdx + 1]
    ? process.argv[suiteArgIdx + 1].split(',').map((s) => s.trim())
    : DEFAULT_SUITES;
  const unknown = wanted.filter((k) => !SUITES[k]);
  if (unknown.length) {
    console.log('ERROR: unknown suite(s): ' + unknown.join(', '));
    console.log('  available: ' + Object.keys(SUITES).join(', '));
    await browser.close();
    process.exit(1);
  }

  const results = [];
  try {
    for (const key of wanted) {
      const suite = SUITES[key];
      const ctx = await browser.newContext({ locale: suite.locale });
      const page = await ctx.newPage();
      for (const c of suite.cases) {
        let r;
        try { r = await probe(page, c.query, suite); }
        catch (e) { r = { opened: false, reason: e.message.split('\n')[0] }; }
        results.push(Object.assign({ suiteKey: key, suite }, c, r));
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // ---- 判定 ----
  let fatal = 0, netfail = 0, headlessArtifact = 0;
  console.log('today      ' + new Date().toISOString().slice(0, 10));
  console.log('suites     ' + wanted.map((k) => k + '(' + SUITES[k].label + ')').join(', '));
  console.log('');

  let lastSuite = null;
  for (const r of results) {
    if (r.suiteKey !== lastSuite) {
      lastSuite = r.suiteKey;
      console.log('════ ' + r.suite.label + '  hl=' + r.suite.hl
                  + '  locale=' + r.suite.locale + ' ════');
      console.log('');
    }
    console.log('### [' + r.kind + '] query = ' + r.query);
    // fake 案例若 Google 留在【搜尋列表】（feed 存在、沒開店頁），那是「沒有靜默換店」
    // 的正確行為，不是判準失效。2026-11-05 zh-TW 實測撞到：ja/en 的假店剛好都被重導向
    // 到店頁，所以之前沒看過這個分支；台灣的假店 Google 選擇列清單。
    if (r.kind === 'fake' && r.opened && r.feedIsNull === false) {
      console.log('  Google 留在搜尋列表（[role=feed] 存在），沒有硬塞一家店 —— 正確行為');
      console.log('  [4] aria-label 判準         N/A — 沒有店頁可比，也就沒有靜默換店的風險');
      console.log('');
      continue;
    }
    if (!r.opened) {
      // fake 案例「開不到店頁」是合理結果之一：Google 留在搜尋列表，
      // 代表它沒有硬塞一家給我。那不是失敗。
      if (r.kind === 'fake') {
        console.log('  沒開到店頁（' + r.reason + '）');
        console.log('  [4] aria-label 判準         N/A — Google 留在搜尋列表，'
                    + '沒有靜默換店，這也是正確行為');
      } else {
        console.log('  CANNOT-VERIFY  ' + r.reason);
        netfail++;
      }
      console.log('');
      continue;
    }
    console.log('  href   ' + r.href.slice(0, 104));
    console.log('  title  ' + r.title);
    console.log('  ua     ' + (r.uaIsHeadless ? 'HeadlessChrome 🔴 評論數會被省略' : 'real Chrome'));
    if (r.uaIsHeadless && headed) {
      console.log('      ⚠️ 我以為開的是 headed，但 UA 是 headless ——');
      console.log('         channel 退讓到別的實作了，判準 3 的結果不可採信。');
    }

    // 判準 1：無列表容器
    const p1 = r.feedIsNull === true;
    console.log('  [1] [role=feed] === null            ' + (p1 ? 'PASS' : 'FAIL')
                + '  (actual: ' + r.feedIsNull + ')');

    // 判準 2：有 aria-label 的 main 容器存在
    const p2 = r.mainExists === true;
    console.log('  [2] div[role=main][aria-label]      ' + (p2 ? 'PASS' : 'FAIL'));
    console.log('      aria-label = ' + JSON.stringify(r.mainAria));

    // 判準 3：F7nice 讀得到分數【與評論數】。
    // 🔴 只檢「有數字」不夠 —— headless 下會只讀到 "4.4"，樣本數靜默消失。
    const hasScore = r.f7Exists === true && !!r.f7Text && /\d+(\.\d+)?/.test(r.f7Text);
    const hasCount = !!r.f7Text && /\(\s*[\d,]+\s*\)/.test(r.f7Text);
    const p3 = hasScore && hasCount;
    console.log('  [3] div.F7nice score + count        ' + (p3 ? 'PASS' : 'FAIL')
                + '  (text: ' + JSON.stringify(r.f7Text) + ')');

    // 判準 4：aria-label 的三分支分類，期望值依案例類型而定
    const cls = classifyAria(r.query, r.mainAria);
    const want = { exact: 'exact', superset: 'superset', fake: 'unrelated' }[r.kind];
    const p4 = cls === want;
    console.log('  [4] aria-label 三分支分類           ' + (p4 ? 'PASS' : 'FAIL')
                + '  (got: ' + cls + ', want: ' + want + ')');
    if (r.kind === 'superset') {
      console.log('      這個案例在驗「我多打了區名」不被誤判成店不存在。');
      console.log('      搜 ' + JSON.stringify(r.query));
      console.log('      回 ' + JSON.stringify(r.mainAria));
    }
    if (r.kind === 'fake' && cls === 'unrelated') {
      console.log('      Google 靜默換成 ' + JSON.stringify(r.mainAria) + ' —— 判準正確攔下');
    }

    // 判準 5：該語言的營業時間詞彙真的命中
    // 🔴 這是靜默失效型：抓不到不報錯，會被當成「這家店沒有營業時間資訊」。
    const p5 = r.hoursWordsHit > 0;
    console.log('  [5] 營業時間詞彙命中                ' + (p5 ? 'PASS' : 'FAIL')
                + '  (' + JSON.stringify(r.hoursHits) + ')');

    // 判準 6：逐日表（規範要求展開過的逐日表，不是一行摘要）
    const p6 = r.dayRowCount >= 7;
    console.log('  [6] 逐日表 >= 7 列                  ' + (p6 ? 'PASS' : 'FAIL')
                + '  (' + r.dayRowCount + ' 列, 例: '
                + JSON.stringify(r.dayRowSample.slice(0, 2)) + ')');

    // 判準 7：座標與識別碼（語言無關，實測兩種介面都成立）
    const p7 = r.has3d4d && r.has16s;
    console.log('  [7] URL !3d!4d + !16s               ' + (p7 ? 'PASS' : 'FAIL')
                + '  (3d4d=' + r.has3d4d + ', 16s=' + r.has16s + ')');

    // ---- 失敗歸因（分開講，不要把症狀當根因）----
    if (!p1) { console.log('      🔴 E-01 判準 1 失效'); fatal++; }
    if (!p2) {
      console.log('      🔴 E-01 判準 2 失效 —— 這項是唯一能抓重導向的，失效即 Gate-V 不可用');
      fatal++;
    }
    if (!p3) {
      if (!hasScore) {
        console.log('      🔴 E-03 可能失效 —— 連分數都讀不到，div.F7nice 或已改版。');
        console.log('         症狀是讀不到（方向安全，不會讀到錯的），但分數主張須標 HYPOTHESIS。');
        fatal++;
      } else if (r.uaIsHeadless) {
        console.log('      ⚠️ 這【不是】判準失效，是 headless 的已知行為（見本檔頂部註解）。');
        console.log('         div.F7nice 本身還活著（分數讀到了）。拿掉 --headless 即可讀到評論數。');
        headlessArtifact++;
      } else {
        console.log('      🔴 headed 卻讀不到評論數 —— 這是【新情況】，不在已知的 headless 行為內。');
        console.log('         要實際開頁面查評論數跑到哪個容器去了，不要猜。');
        fatal++;
      }
    }
    if (!p4) {
      if (r.kind === 'superset') {
        console.log('      🔴 三分支判準在這個介面失效 —— 「我多打了區名」沒被歸成 superset。');
        console.log('         這會讓 Gate-V 把存在的店報成「不存在」（假陽性）。');
      } else if (r.kind === 'fake') {
        console.log('      🔴 E-02 的防線失效：Gate-V 無法分辨「不是你要的那家店」');
      } else {
        console.log('      🔴 官方店名都對不上 —— 先確認該店還在（可能改名或歇業），');
        console.log('         再判定是判準失效。');
      }
      fatal++;
    }
    if (!p5) {
      console.log('      🔴 營業時間詞彙在這個介面 0 命中 —— 靜默失效。');
      console.log('         這組詞是 ' + JSON.stringify(r.suite.hours));
      console.log('         要換成該語言實際用的詞，並更新 config/user-profile.md 的 I 段。');
      fatal++;
    }
    if (!p6) {
      console.log('      ⚠️ 逐日表不足 7 列 —— 可能是這家店沒公布完整營業時間，');
      console.log('         也可能是 DOM 結構改了。先換一家店測，再判定判準失效。');
      fatal++;
    }
    if (!p7) {
      console.log('      🔴 URL 少了座標或識別碼 —— 座標主張不可用（E-03）。');
      fatal++;
    }
    console.log('');
  }

  // ---- 總結 ----
  const probedOk = results.filter((r) => r.opened).length;
  if (probedOk === 0) {
    console.log('RESULT: CANNOT-VERIFY (no probe opened a place page) -- 無法驗證 != 驗證失敗');
    process.exit(1);
  }
  if (netfail > 0) {
    console.log('NOTE: ' + netfail + ' 個 non-fake 測試點開不到店頁（網路或店已歇業），該點未驗。');
  }
  if (fatal > 0) {
    console.log('RESULT: ' + fatal + ' CRITERION FAILED');
    console.log('  → 逐項看上面的歸因。標 🔴 的要重新實測後更新 cache/externals.md；');
    console.log('    標 ⚠️ 的先換測試點確認，不要直接改 cache。');
    process.exit(3);
  }
  if (headlessArtifact > 0) {
    console.log('RESULT: ' + headlessArtifact + ' 項因 headless 讀不到評論數（Google 省略的）');
    console.log('  這【不代表】判準失效、也不要去改 cache。拿掉 --headless 重跑一次才算驗過。');
    process.exit(3);
  }
  console.log('RESULT: all criteria still valid on ' + wanted.join(', '));
  console.log('NEXT: 把今天的日期寫回 cache/externals.md 的「複驗日」');
  process.exit(0);
})();
