// PreToolUse(mcp__codebase-memory-mcp__query_graph|trace_path)：cbm 查詢的機械閘。
//
// 為什麼需要它：cbm 的數字很容易看起來很成功——精確、可複製、有來源，唯獨是錯的。
// 它不會報錯，只會給出一個很像對的數字，而引用的人不會察覺。
//
// ── 擋兩類（結果確定是錯的，擋掉沒有損失）────────────────────────
//   A. EXISTS/NOT EXISTS 子查詢裡「綁定變數不在 pattern 開頭」
//      引擎限制：子查詢從匿名節點起頭時解析不出來，結果恆為「全部命中」或
//      「零命中」——而且不報錯。這是 cbm 引擎的性質，與專案無關。
//        ❌ NOT EXISTS { ()-[:CALLS]->(f) }        → 恆等於全部
//        ✅ NOT EXISTS { (f)<-[:CALLS]-() }        → 正確
//      判準：EXISTS 子查詢第一個節點必須是外層 MATCH 綁定的變數，方向用 <- 反轉。
//
//   B. 死碼查詢（零 caller）—— 寫法可以完全正確，但判準對有框架反射的專案無意義
//      Controller 由框架路由呼叫、Handler 由 mediator 反射分派、ORM 設定由掃描器
//      呼叫、DI 建構子由容器呼叫——這些全都沒有靜態 caller，卻都活著。
//      本類由 config 的 reflectionEntryPoints 驅動；沒設定就不啟用。
//
// ── 提醒四類（查詢寫法是對的，問題在「這個數字能不能用」）──────────
//   C. 計數查詢缺對照組 —— 命中率接近 100% 或 0% 就是判準壞了
//   D. 孤兒／零引用查詢 —— 寫法對不代表數字可用（動態 import、barrel、測試檔）
//   E. Route 節點查詢 —— attribute routing 框架的後端 Route 節點建不出來
//   G. 計數但沒去重 —— 「節點數／邊數」不等於「東西的個數」
//
// ⚠ C～G 為什麼不擋：它們的查詢**寫法都是對的**，問題在引用時的判斷，不是語法
//    錯誤。擋下來會讓人改寫查詢繞過，反而失去偵測力。A/B 才擋。
//
// 放行：查詢含 `-- cbm-ok:<理由>`（A/B 類），或 `-- cbm-total:<總數>`（C 類）。
//       ⚠ 註解放查詢**最後**——`--` 會吃掉同一行剩餘內容。
// fail-open：自身錯誤一律放行。
//
// 設定：專案根的 cbm-guard.config.json（沒有也能用，五類通用判準全開）。
//       範本見 plugin 根目錄 cbm-guard.config.example.json。

const fs = require('fs');
const path = require('path');

// ── 載入專案設定（找不到就用通用預設）──────────────────────────
function loadConfig() {
  const names = ['cbm-guard.config.json', '.cbm-guard.json'];
  const roots = [process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(Boolean);
  for (const root of roots) {
    for (const name of names) {
      try {
        const p = path.join(root, name);
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) { /* 設定壞掉不能讓閘失效 */ }
    }
  }
  return {};
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let reason = null;
  let advisory = null;
  try {
    const input = JSON.parse(raw);

    // 只管真正吃 Cypher 的工具。自 cbm binary 取出的 schema：
    //   query_graph  required: [query, project]，query 是 Cypher        → 適用
    //   trace_path   required: [function_name, project]                 → 適用
    //   search_graph required: [project]，query 是**關鍵字**不是 Cypher → 不適用，套用會誤擋
    const CYPHER_TOOLS = /^mcp__codebase-memory-mcp__(query_graph|trace_path)$/;
    if (!CYPHER_TOOLS.test(String(input.tool_name || ''))) process.exit(0);

    const cfg = loadConfig();
    const docRef = cfg.docRef ? ('\n\n本專案正本：' + cfg.docRef) : '';

    // 掃 tool_input 全部字串值，不寫死 `query` 鍵——cbm 內建 update 指令，
    // 升版若改參數名，寫死鍵會讓本閘**靜默失效**（無錯誤訊息、看起來仍在運作）。
    const ti = input.tool_input || {};
    const q = Object.keys(ti)
      .filter((k) => typeof ti[k] === 'string')
      .map((k) => ti[k])
      .join('\n');

    if (/--\s*cbm-ok:/i.test(q)) process.exit(0);

    // ---- A. EXISTS 子查詢綁定變數不在開頭（通用，引擎性質）----
    const badExists = [];
    const re = /(NOT\s+)?EXISTS\s*\{([^{}]*)\}/gi;
    let m;
    while ((m = re.exec(q)) !== null) {
      const first = m[2].match(/\(\s*([^)]*)\s*\)/);
      if (!first) continue;
      const inner = first[1].trim();
      // 匿名 ( ) 或只有 label (:File) → 綁定變數不在開頭
      if (inner === '' || /^:/.test(inner)) badExists.push(m[0].slice(0, 60));
    }

    if (badExists.length) {
      reason = '[cbm 查詢閘] EXISTS 子查詢的**綁定變數不在 pattern 開頭**，結果會是錯的且不會報錯。\n\n' +
        '命中：' + badExists.join(' / ') + '\n\n' +
        '這顆引擎的 EXISTS 子查詢從匿名節點起頭時無法解析，\n' +
        '結果恆為「全部命中」或「零命中」——**而且不報錯**。\n\n' +
        '**改法：把外層綁定的變數寫在 pattern 第一個位置，方向用 `<-` 反轉。**\n' +
        '  ()-[:R]->(x)       改成  (x)<-[:R]-()\n' +
        '  (:Label)-[:R]->(x) 改成  (x)<-[:R]-(:Label)\n\n' +
        '**怎麼確認改對了**：互補驗證——同一個 pattern 的 EXISTS 與 NOT EXISTS\n' +
        '兩邊相加應該等於總數。不等於就是還沒對。\n\n' +
        '⚠ 這類錯誤**不會報錯**，只會給出很像對的數字——所以務必跑對照組：\n' +
        '  任何計數都同時查總數，命中率接近 100% 或 0% 就是判準壞了。' + docRef + '\n' +
        '確定要跑（例如重現這個陷阱）→ 加註解 `-- cbm-ok:<理由>`\n' +
        '（放查詢**最後**，`--` 會吃掉同行剩餘內容）。';
    }

    // ---- B. 死碼查詢（框架反射入口，由 config 驅動）----
    // 沒設定 reflectionEntryPoints 就不啟用——不是每個專案都有框架反射問題。
    const entryPoints = Array.isArray(cfg.reflectionEntryPoints) ? cfg.reflectionEntryPoints : [];
    if (!reason && entryPoints.length) {
      const isDeadCodeQuery =
        /NOT\s+EXISTS\s*\{\s*\(\s*\w+\s*\)\s*<-\s*\[\s*:?\s*CALLS/i.test(q);
      // deadCodeLabels：限定在哪些 label 上啟用（例如只認後端的 :Method，
      // 避免誤擋前端 :Function 的正確查詢）。沒設就對所有 label 生效。
      const labels = Array.isArray(cfg.deadCodeLabels) ? cfg.deadCodeLabels : [];
      const labelHit = !labels.length ||
        labels.some((l) => new RegExp(':' + l + '\\b', 'i').test(q));

      if (isDeadCodeQuery && labelHit) {
        const lines = entryPoints.map((e) => {
          if (typeof e === 'string') return '  ' + e;
          return '  ' + String(e.pattern || '') + (e.why ? '   ← ' + e.why : '');
        });
        reason = '[cbm 查詢閘] 這是「零 caller ＝死碼」查詢。**寫法可能正確，但判準對本專案無意義。**\n\n' +
          '本專案有框架反射入口——它們沒有靜態 CALLS 入邊，但全都活著：\n' +
          lines.join('\n') + '\n\n' +
          '**靜態分析看不到框架在執行期做的分派**，所以零 caller ≠ 死碼。\n' +
          (cfg.deadCodeStat ? ('實測：' + cfg.deadCodeStat + '\n\n') : '\n') +
          (cfg.deadCodeAlternative
            ? ('**要抓真死碼改用**：' + cfg.deadCodeAlternative + '\n')
            : '**要抓真死碼改用編譯器／linter 的「未使用」警告**——\n' +
              '它看得到框架反射，靜態圖看不到。\n') +
          docRef + '\n' +
          '確定要跑 → 加註解 `-- cbm-ok:<理由>`\n' +
          '（放查詢**最後**，`--` 會吃掉同行剩餘內容）。';
      }
    }

    // ---- D. 孤兒／零引用類查詢（通用：靜態分析的共通盲區）----
    if (!reason && !advisory
        && /NOT\s+EXISTS\s*\{/i.test(q)
        && /:(IMPORTS|CALLS|USAGE)\b/i.test(q)) {
      advisory = '[cbm 查詢閘] 這是「零引用／孤兒」類查詢——**寫法對不代表數字可用**。\n\n' +
        '靜態分析抓不到這幾類引用，它們全都會被算成孤兒：\n' +
        '  動態載入（`() => import()`、`require()` 變數路徑）\n' +
        '  barrel 目錄捷徑（index 轉出，引用記在 barrel 上）\n' +
        '  框架的樣板綁定（template 事件、DI 注入、反射）\n' +
        '  測試檔與設定檔（本來就沒人 import）\n' +
        '  非程式模組（`.md`／`.json`／資源檔）\n' +
        (cfg.orphanStat ? ('\n實測：' + cfg.orphanStat + '\n') : '') +
        '\n**做法**：把清單拉出來逐筆 grep，不要直接引用 count。\n' +
        '⚠ 「無人引用」**也不等於可以刪**——未啟用功能、保留給日後的完整實作、\n' +
        '公開 API 性質的 export 都會落在這份清單裡，該不該刪往往是產品決策。\n' +
        (cfg.annotatedOrphansNote ? ('\n⚠ ' + cfg.annotatedOrphansNote + '\n') : '') +
        docRef;
    }

    // ---- E. Route 節點查詢（attribute routing 框架建不出後端 Route）----
    if (!reason && !advisory && /:Route\b/i.test(q)) {
      advisory = '[cbm 查詢閘] 這是 `Route` 節點查詢——**注意呼叫端與接收端可能不對稱**。\n\n' +
        'cbm 的 route 偵測是為 Express／FastAPI／Spring 那類**呼叫式**寫法設計的。\n' +
        '用 attribute／decorator 宣告路由的框架（ASP.NET Core 的 `[Route]`、\n' +
        'NestJS 的 `@Get()` 等）**後端 Route 節點可能整個建不出來**——\n' +
        '呼叫端（前端 axios/fetch）抓得到，接收端抓不到，兩邊配不起來。\n' +
        (cfg.routeStat ? ('\n實測：' + cfg.routeStat + '\n') : '') +
        '\n⚠ **同時注意去重**：Route 是**節點數**不是端點數——\n' +
        '同一端點常建多顆節點（一顆帶 query string 樣板、一顆乾淨版），\n' +
        '且 `file_path` 可能為空、查不到是在哪個檔呼叫的。\n' +
        '  要算「幾支 API」→ `count(DISTINCT r.name)`\n' +
        '  要算「幾個呼叫點節點」→ `count(r)`\n' +
        (cfg.routeAlternative ? ('\n**要做跨站路由對應請用**：' + cfg.routeAlternative + '\n') : '') +
        docRef;
    }

    // ---- F. trace_path 出向（執行期分派造成斷鏈，由 config 驅動）----
    if (!reason && !advisory && cfg.runtimeDispatch
        && /^mcp__codebase-memory-mcp__trace_path$/.test(String(input.tool_name || ''))) {
      const dir = String(ti.direction || 'both').toLowerCase();
      if (dir === 'outbound' || dir === 'both') {
        advisory = '[cbm 查詢閘] `trace_path` 的**出向**追蹤在本專案會斷鏈。\n\n' +
          cfg.runtimeDispatch + '\n\n' +
          '**靜態分析建不出執行期分派的 `CALLS` 邊**，所以出向查詢會回 0 或少很多。\n' +
          '⚠ 回 0 不代表「沒有呼叫任何東西」，只代表**靜態看不到**——\n' +
          '  這是最危險的一種假證據，因為 0 看起來就像確定的結論。\n\n' +
          '（入向 inbound 不受此限，一般方法呼叫的 CALLS 邊運作正常。）' + docRef;
      }
    }

    // ---- G. 計數但沒去重（通用：圖查詢的共通陷阱）----
    if (!reason && !advisory
        && /\bcount\s*\(/i.test(q)
        && !/\bDISTINCT\b/i.test(q)
        && (/\]->\s*\(|\)\s*<-\s*\[/.test(q) || /:Route\b/i.test(q))) {
      advisory = '[cbm 查詢閘] 這個計數**沒有去重**——「節點數／邊數」不等於「東西的個數」。\n\n' +
        '兩種成因不同，改法也不同：\n' +
        '  ① **邊查詢**：`MATCH (a)-[:R]->(b)` 同一個 a 有多條邊就多列。\n' +
        '     節點本身通常不重複，重複出在**邊**。\n' +
        '     → 要算「幾個 a」加 `count(DISTINCT a.file_path)`\n' +
        '  ② **Route 之類的節點**：同一實體可能真的建多顆節點。\n' +
        '     → 加 `count(DISTINCT r.name)`\n\n' +
        '**先問自己：我要的是「節點數」還是「不重複的實體數」？**\n' +
        '兩個都報出來最安全。' +
        (cfg.dedupStat ? ('\n\n實測：' + cfg.dedupStat) : '') +
        docRef;
    }

    // ---- C. 計數查詢缺對照組（通用，最後判定：讓更具體的類優先）----
    if (!reason && !advisory && /\bcount\s*\(/i.test(q) && !/--\s*cbm-total:/i.test(q)) {
      advisory = '[cbm 查詢閘] 這是計數查詢——引用這個數字之前，請同時查總數當對照組。\n\n' +
        '判準：X 接近總數 ＝ 判準沒鑑別力。\n' +
        '  260 / 260 與 10 / 480 意義完全不同，單看 260 分不出來。\n\n' +
        '做法：把同一個 MATCH 去掉 WHERE 再查一次總數；\n' +
        '或用互補驗證——EXISTS 與 NOT EXISTS 兩邊相加應等於總數。\n\n' +
        '⚠ 引用計數／零缺口結論時，須一併貼出該工具的**盲區說明**＋\n' +
        '一個**反向樣本**（已知該問題存在的案例，證明工具抓得到）。只貼數字＝未完成。\n\n' +
        '已經查過總數了 → 加註解 `-- cbm-total:<總數>` 即不再提醒。\n' +
        '⚠ **註解要放查詢「最後」**——`--` 會吃掉同一行剩餘內容，\n' +
        '  寫在開頭且同一行會讓整個查詢變成註解：\n' +
        '    ❌ `-- cbm-total:332 MATCH (m:Module) RETURN count(m)`\n' +
        '    ✅ `MATCH (m:Module) RETURN count(m) -- cbm-total:332`\n' +
        '    ✅ 獨立一行放開頭也可以（換行後 MATCH 另起一行）' + docRef;
    }
  } catch (e) {
    process.exit(0);
  }

  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } else if (advisory) {
    // additionalContext：放行工具呼叫，同時把提醒餵進模型 context。
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: advisory,
      },
    }));
  }
  process.exit(0);
});
