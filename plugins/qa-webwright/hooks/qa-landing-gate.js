#!/usr/bin/env node
/**
 * qa-landing-gate — qa-webwright plugin 的 Stop hook
 *
 * 目的：擋「AI 觸發了 qa-webwright、也用了瀏覽器工具做測試，卻沒把結果落地成
 *       可重跑 pytest（test_*.py + junitxml 報告 + catalog 回填）」的情況。
 *       純 prompt 規範（SKILL.md 的 MANDATORY）擋不住的最後一道他律。
 *
 * 兩段式（依使用者定的邊界）：
 *   (A) 觸發 qa-webwright + 用 browser MCP + 無落地 → 硬擋（decision:block）
 *   (B) 沒觸發 qa-webwright、但用 browser MCP + 無落地 → 只警告
 *   其他 / 任何不確定 / 失敗                        → 放行
 *
 * ★ 最高原則：FAIL-OPEN。這 hook 影響所有裝此 plugin 的 session 能不能結束，
 *   故「任何讀寫失敗 / 判斷不確定 / 例外」一律放行，絕不因 hook 自身問題卡死 session。
 *   落地判定回三態：true=確定有落地 / false=確定沒落地 / null=不確定→放行。
 *   硬擋計數任何異常都當「已達上限」→ 放行（寧可漏擋，絕不卡死）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  // 最外層保險：任何未預期例外 → 放行
  try {
    main(stdinData);
  } catch (_) {
    safeExitAllow();
  }
});

// ---- 收尾：放行 / 警告 / 硬擋 ----

function safeExitAllow() {
  // 無輸出 → Claude Code 視為允許停止
  process.exit(0);
}

function writeThenExit(obj) {
  // 寫出 JSON 後等 stdout drain 再 exit（不強制 timeout 截斷——寧可讓 harness 的
  // hook timeout(15s) 收，也不輸出半截 JSON 讓 Claude Code 誤判）。寫失敗 → 放行。
  let json;
  try {
    json = JSON.stringify(obj);
  } catch (_) {
    return safeExitAllow();
  }
  try {
    process.stdout.write(json, () => process.exit(0));
  } catch (_) {
    safeExitAllow();
  }
}

function allow() {
  safeExitAllow();
}
function warn(msg) {
  writeThenExit({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: msg } });
}
function block(reason) {
  writeThenExit({ decision: 'block', reason }); // exit 0 + decision:block 才會阻止停止
}

// ---- 主判定 ----

function main(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    return allow(); // stdin 不是合法 JSON → 放行
  }

  // ★★ 落點基準必須與寫入端 skills/browser-qa/qa-flow.sh 的 WORKSPACE_DIR 同源（改一處要改兩處）★★
  //   qa-flow.sh 把產物寫進 WORKSPACE_DIR/tests/e2e/；此處 hook 在 cwd/tests/e2e/ 找產物判是否落地。
  //   兩端指向不同目錄 → 誤擋（產物在 A、hook 看 B）或漏擋。
  //   優先序刻意以 harness 傳入的 input.cwd 為首選：它是 session 真實 cwd，AI 自己 export
  //   CLAUDE_PROJECT_DIR 蓋不掉（見本 repo memory「CLAUDE_PROJECT_DIR 不一定內建、會被 AI export
  //   覆蓋鑽子目錄」）；CLAUDE_PROJECT_DIR / cwd() 僅當 input.cwd 缺席時的備援。
  //   正常情況（未亂 export、session 未 cd 離開起始目錄）下三者一致，與 qa-flow.sh 同源。
  //   若調整此解析順序，務必同步檢視 qa-flow.sh :~31，勿讓兩端在正常情況下發散。
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const tp = input.transcript_path;
  const sid = (input.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

  // transcript 讀不到 → 無從判斷 → 放行
  if (!tp || fileState(tp) !== 'yes') return allow();

  // 掃描來源 = 主 transcript + subagent transcripts。
  // 主 Agent 把瀏覽器 QA 委派給 subagent(Agent 工具)時，實際 tool_use 記在
  // <transcript同名資料夾>/subagents/agent-*.jsonl，主檔只有一行 Agent 呼叫——
  // 只掃主檔會讓「委派做測試」整套他律歸零。故一併掃 subagent 檔。
  // 用 scanner 逐檔 early-exit（不把全部拼進單一大字串，省記憶體、支援長 session）。
  const sources = collectTranscriptSources(tp); // [主檔, ...subagent檔]

  const usedBrowser = scanSources(sources, (b) => BROWSER_NAME.test(b.name));
  if (usedBrowser === null) return allow(); // 全部讀失敗 → 不確定 → 放行
  if (usedBrowser !== true) return allow(); // 沒真的用瀏覽器工具 → 這輪不是在測 → 放行

  const landed = hasLandingArtifacts(cwd); // true / false / null
  if (landed === true) {
    // 確定有落地 → 放行，並重置提醒計數：補完落地後，下一輪新 QA 又有完整的 2 次提醒額度。
    resetRemindCount(sid);
    return allow();
  }
  if (landed === null) return allow(); // 不確定（讀檔失敗）→ FAIL-OPEN 放行

  // 到這裡：確定用了瀏覽器 tool_use + 確定沒落地產物 → 要提醒（WARN 或 BLOCK）。
  // BLOCK 與 WARN 共用同一個提醒計數，共同上限 2 次；達上限 → 完全靜默放行。
  if (reachedRemindLimit(sid)) return allow();

  // 零噪音 nudge：只在「本來就要擋/警告」時，若整輪未偵測到 qa-engineer 設計階段，
  // 追加一句提示（兩階段品質無法機械保證，見 SKILL 誠實化說明）。不新增任何成功路徑輸出。
  const qaEngineerSeen = scanSources(sources, (b) =>
    (b.name === 'Agent' || b.name === 'Task') && b.input && /qa-engineer/.test(safeStr(b.input.subagent_type))
  ) === true;
  const designNudge = qaEngineerSeen
    ? ''
    : '\n另外：本輪未偵測到 qa-engineer 設計階段（Agent 呼叫）。本 plugin 只機械保證「產物存在且可重跑」，' +
      '測試設計品質（覆蓋矩陣 / 證據規範 / 兩階段設計）無法機械強制——請自行把關。';

  const triggeredQa = scanSources(sources, qaTriggerMatcher) === true;
  if (!triggeredQa) {
    // (B) 沒觸發 qa-webwright → 只警告（計入共用計數）
    return warn(
      '偵測到這輪用了瀏覽器工具但 tests/e2e/ 下沒有落地產物（test_*.py 或 *.spec.js/ts / reports/*.xml / catalog.md）。' +
        '若這是功能測試，建議走 qa-webwright 的 qa-flow.sh 把結果沉澱成可重跑 pytest；若只是瀏覽網頁可忽略。' +
        designNudge
    );
  }

  // (A) 觸發 qa-webwright + 用瀏覽器 + 無落地 → 硬擋（計入共用計數）
  return block(
    '你觸發了 qa-webwright 做瀏覽器測試，但沒有把結果落地成可重跑產物——' +
      'tests/e2e/ 下缺 test_*.py（或 *.spec.js/ts）/ reports/*.xml / catalog.md 其中之一。\n' +
      '請照 SKILL.md 的落地流程走完（產物層為機械必做，設計層品質為建議；瀏覽器測試應由 qa-engineer agent 執行）：\n' +
      '  1) TaskCreate 建清單 2) qa-flow.sh bootstrap 3) 列 CP\n' +
      '  4) 預擬 codify 草稿：每 CP 落成 tests/e2e/test_<feature>.py 的 assert（grep 原始碼填真實值）\n' +
      '  5) qa-flow.sh run <feature> <test-file>（出 junitxml，首跑收失敗清單）\n' +
      '  6) 只對失敗 CP 定向探索補值後重跑 7) self-verify\n' +
      '  8) qa-flow.sh catalog 回填每個情境到 tests/e2e/catalog.md\n' +
      '不要用通用 Playwright MCP 手動測完就口頭回報——那不是可重跑產物。' +
      '（若使用者明確說「這次不要落地」，回覆說明後再結束即可，本 hook 最多擋 2 次。）' +
      designNudge
  );
}

// ---- helpers（全部 fail-safe）----

// 三態存在性：'yes'=確定存在 / 'no'=確定不存在 / 'unknown'=檢查本身失敗（呼叫端當不確定→放行）。
// 不把 existsSync 例外壓成 false，避免「hook 自己檢查失敗」被誤當成「產物不存在」而去擋。
function fileState(f) {
  try {
    return fs.existsSync(f) ? 'yes' : 'no';
  } catch (_) {
    return 'unknown';
  }
}

// 掃描來源清單：主 transcript + 同名資料夾下 subagents/*.jsonl（委派做的 tool_use 記在那）。
// fail-open：推導/讀目錄失敗一律略過該來源（不因此出錯），至少保留主檔。
function collectTranscriptSources(tp) {
  const sources = [tp];
  try {
    const dir = path.dirname(tp);
    const base = path.basename(tp).replace(/\.jsonl$/i, '');
    const subDir = path.join(dir, base, 'subagents');
    if (fileState(subDir) === 'yes') {
      const entries = fs.readdirSync(subDir);
      for (const e of entries) {
        if (/\.jsonl$/i.test(e)) sources.push(path.join(subDir, e));
      }
    }
  } catch (_) {
    // 略過 subagent 來源，只用主檔
  }
  return sources;
}

// 掃多個 JSONL 來源，任一 tool_use 命中 matcher 即回 true（early-exit）。
// 回傳：true=有命中 / false=掃完都沒命中 / null=所有來源都讀失敗（不確定→呼叫端放行）。
// ★ 逐檔逐行 streaming（分塊讀 + 跨塊行緩衝），取代舊的「尾 2MB」——長 session 前段的
//   瀏覽器操作不再被截斷漏看。單行超長（>1MB）跳過；總掃描量上限 200MB 後停（視為已掃完）。
const BROWSER_NAME = /^(mcp__playwright__|mcp__claude-in-chrome__|browser_)/;
const MAX_LINE = 1_000_000;
const MAX_TOTAL = 200_000_000;

function scanSources(sources, matcher) {
  let anyReadOk = false;
  let scanned = 0;
  for (const src of sources) {
    let fd = -1;
    try {
      fd = fs.openSync(src, 'r');
    } catch (_) {
      continue; // 這個來源讀不到，試下一個
    }
    try {
      const CHUNK = 1 << 20; // 1MB
      const buf = Buffer.alloc(CHUNK);
      let carry = '';
      let bytes;
      while ((bytes = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
        scanned += bytes;
        let text = carry + buf.toString('utf8', 0, bytes);
        let nl;
        let last = 0;
        while ((nl = text.indexOf('\n', last)) !== -1) {
          const line = text.slice(last, nl);
          last = nl + 1;
          if (matchLine(line, matcher)) {
            fs.closeSync(fd);
            return true;
          }
        }
        carry = text.slice(last);
        if (carry.length > MAX_LINE) carry = ''; // 單行過長 → 丟棄殘段防爆記憶體
        if (scanned > MAX_TOTAL) break; // 總量上限，視為已掃完
      }
      // 收尾殘段
      if (carry && matchLine(carry, matcher)) {
        fs.closeSync(fd);
        return true;
      }
      fs.closeSync(fd);
      // ★ 只有「完整掃完（無例外）」才算此來源成功——避免「開得了檔但讀到一半失敗」
      //   被當成「掃完沒命中」而回 false（那會讓 hook 自身讀失敗掉進 warn/block，破壞 fail-open）。
      anyReadOk = true;
    } catch (_) {
      try {
        if (fd >= 0) fs.closeSync(fd);
      } catch (__) {}
      // 這個來源讀到一半出錯，不計入成功掃描，繼續試下一個
    }
  }
  // 沒有任何來源被完整掃完 → 全失敗 → null（呼叫端 fail-open 放行）。
  return anyReadOk ? false : null;
}

// 解析單行 JSONL，對其中每個 tool_use block 套 matcher；壞行/非物件回 false。
function matchLine(line, matcher) {
  const s = line.trim();
  if (!s || s[0] !== '{') return false;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch (_) {
    return false;
  }
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    if (b && b.type === 'tool_use' && typeof b.name === 'string') {
      if (matcher(b) === true) return true;
    }
  }
  return false;
}

// 觸發 qa-webwright：認任一「在用這個 skill」的結構化證據——
//   (a) 用 Agent（或舊名 Task）叫 qa-engineer subagent；
//   (b) Read/Bash 碰 browser-qa 的 SKILL.md 路徑（進了這個 skill）；
//   (c) Bash 執行過 qa-flow.sh 的 bootstrap/scaffold/run/catalog（正在用本 skill 的流程腳本）。
// 註：真實 transcript 裡 subagent 呼叫的工具名是 `Agent`（非 `Task`），兩者都認以防版本差異。
function qaTriggerMatcher(b) {
  // (a) Agent/Task 工具叫 qa-engineer subagent
  if ((b.name === 'Agent' || b.name === 'Task') && b.input && /qa-engineer/.test(safeStr(b.input.subagent_type)))
    return true;
  // (b) Read / Bash 碰到 browser-qa 的 SKILL.md 路徑
  const paths = safeStr(b.input && (b.input.file_path || b.input.command || b.input.path));
  if (/browser-qa[\\/]SKILL\.md/.test(paths)) return true;
  // (c) Bash 執行 qa-flow.sh 的任一子命令 = 正在用本 skill 流程。
  // 允許路徑前綴與引號；排除 echo/grep/cat 等「提及而非執行」的前綴以降誤判。
  if (b.name === 'Bash' && b.input) {
    const cmd = safeStr(b.input.command);
    const isMention = /^\s*(#|echo\b|grep\b|cat\b|printf\b|rg\b|ls\b|find\b|sed\b|awk\b|head\b|tail\b|less\b|more\b)/.test(cmd);
    if (!isMention && /qa-flow\.sh["']?\s+(bootstrap|scaffold|run|catalog)\b/.test(cmd)) return true;
  }
  return false;
}

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

// 落地三要件回三態：true=齊全 / false=確定缺 / null=任何檢查失敗(不確定→放行)。
// 只要有「檢查本身失敗(fileState==='unknown' 或讀取拋例外)」就回 null，絕不當成「沒落地」去擋。
function hasLandingArtifacts(cwd) {
  if (!cwd) return null;
  const cwdState = fileState(cwd);
  if (cwdState !== 'yes') return null; // cwd 不存在或檢查失敗 → 不確定 → 放行

  let e2e;
  try {
    e2e = path.join(cwd, 'tests', 'e2e');
  } catch (_) {
    return null;
  }
  const e2eState = fileState(e2e);
  if (e2eState === 'unknown') return null; // 檢查失敗 → 放行
  if (e2eState === 'no') return false; // cwd 在、tests/e2e 確定不存在 → 確定沒落地 → 該擋

  let files;
  try {
    files = fs.readdirSync(e2e);
  } catch (_) {
    return null; // 讀目錄失敗 → 放行
  }
  // 兩種 runner 都算落地（否則 JS 專案正確落地仍被誤擋）：
  //   • pytest：test_*.py（對齊 qa-flow.sh run 的 def test_ 落地驗證）；
  //   • playwright-js：*.spec.js / *.spec.ts（對齊 qa-flow.sh scaffold 的 <feature>.spec.js 落點）。
  // 報告仍統一為 reports/*.xml —— pytest 出 junitxml、playwright 用 --reporter=junit 也是 .xml，共用即可。
  if (!files.some((f) => /^test_.*\.py$/.test(f) || /\.spec\.(js|ts)$/.test(f))) return false;

  const reportsDir = path.join(e2e, 'reports');
  const repState = fileState(reportsDir);
  if (repState === 'unknown') return null;
  if (repState === 'no') return false; // 確定沒 reports 目錄 → 沒報告
  let hasReport;
  try {
    hasReport = fs.readdirSync(reportsDir).some((f) => /\.xml$/.test(f));
  } catch (_) {
    return null;
  }
  if (!hasReport) return false;

  const catalog = path.join(e2e, 'catalog.md');
  const catState = fileState(catalog);
  if (catState === 'unknown') return null;
  if (catState === 'no') return false;
  let catalogText;
  try {
    catalogText = fs.readFileSync(catalog, 'utf8');
  } catch (_) {
    return null;
  }
  // 有資料列 = 有回填（骨架只有表頭 + 分隔線）
  const hasDataRow = catalogText
    .split('\n')
    .some((ln) => /^\|/.test(ln) && !/白話業務情境/.test(ln) && !/^\|[\s-]+\|/.test(ln));
  return hasDataRow ? true : false;
}

// 計數檔路徑（BLOCK 與 WARN 共用同一個；per session）。
function countFile(sid) {
  try {
    return path.join(os.tmpdir(), `qa-landing-gate-${sid}.count`);
  } catch (_) {
    return null;
  }
}

/**
 * 是否已達提醒上限（BLOCK+WARN 共用，共 2 次）。★ FAIL-OPEN：計數檔任何讀寫異常 → 回 true
 * （當已達上限→放行）。即使計數檔壞掉 / 並發競爭 / tmpdir 不可寫，最壞是「少提醒」，絕不「無限擋卡死」。
 * 用「每次 append 一個字元」估次數：檔案 byte 數 >= 2 就算達上限。append 單 syscall，並發偏多算→偏放行。
 * 未達上限時 append 記這次並回 false（允許本次提醒）。
 */
function reachedRemindLimit(sid) {
  const f = countFile(sid);
  if (!f) return true; // 連路徑都組不出 → 放行

  // 只有「明確讀到正常數字 size」才據以判斷；任何異常 → 一律當「已達上限」放行。
  const st = fileState(f);
  if (st === 'unknown') return true;
  if (st === 'yes') {
    let size;
    try {
      size = fs.statSync(f).size;
    } catch (_) {
      return true;
    }
    if (typeof size !== 'number' || !isFinite(size)) return true;
    if (size >= 2) return true; // 已提醒 2 次 → 靜默放行
  }
  // st==='no'(count=0) 或 size<2 → 尚未達上限，記這次後允許提醒
  try {
    fs.appendFileSync(f, 'x');
  } catch (_) {
    return true; // 記不進去 → 寧可這次放行
  }
  return false;
}

// 偵測到已落地時呼叫：清掉計數檔，讓下一輪新 QA 又有完整 2 次提醒額度。
// 刪不掉也無妨（最壞就是這個 session 剩餘額度少一點），靜默吞例外。
function resetRemindCount(sid) {
  const f = countFile(sid);
  if (!f) return;
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (_) {}
}
