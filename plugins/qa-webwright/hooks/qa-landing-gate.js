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

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const tp = input.transcript_path;
  const sid = (input.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

  // transcript 讀不到 → 無從判斷 → 放行
  if (!tp || fileState(tp) !== 'yes') return allow();

  const transcript = readTailText(tp, 2_000_000);
  if (transcript === null) return allow(); // 讀失敗 → 放行

  // usedBrowser / triggeredQa：只認「真的 tool_use 呼叫瀏覽器工具」的結構化痕跡，
  // 不因對話文字提到工具名 / plugin 名而誤判（收緊，降誤擋）。
  // transcript 是 JSONL，tool_use 會序列化成含 "type":"tool_use" 且 "name":"<工具>" 的物件。
  const usedBrowser = hasBrowserToolUse(transcript);
  if (!usedBrowser) return allow(); // 沒真的用瀏覽器工具 → 這輪不是在測 → 放行

  const landed = hasLandingArtifacts(cwd); // true / false / null
  if (landed === true) return allow(); // 確定有落地 → 放行
  if (landed === null) return allow(); // 不確定（讀檔失敗）→ FAIL-OPEN 放行

  // 到這裡：確定用了瀏覽器 tool_use + 確定沒落地產物
  const triggeredQa = hasQaTrigger(transcript);

  if (!triggeredQa) {
    // (B) 沒觸發 qa-webwright → 只警告
    return warn(
      '偵測到這輪用了瀏覽器工具但 tests/e2e/ 下沒有落地產物（test_*.py / reports/*.xml / catalog.md）。' +
        '若這是功能測試，建議走 qa-webwright 的 qa-flow.sh 把結果沉澱成可重跑 pytest；若只是瀏覽網頁可忽略。'
    );
  }

  // (A) 觸發 qa-webwright + 用瀏覽器 + 無落地 → 硬擋，但最多 2 次（計數異常一律當已達上限→放行）
  if (reachedBlockLimit(sid)) {
    return warn(
      'qa-webwright 落地仍缺（已提醒 2 次，本次放行以免卡死）。這輪測試沒有留下可重跑產物，' +
        '下次要重測得整套重來。強烈建議補跑 qa-flow.sh bootstrap→沉澱→run→catalog。'
    );
  }

  return block(
    '你觸發了 qa-webwright 做瀏覽器測試，但沒有把結果落地成可重跑產物——' +
      'tests/e2e/ 下缺 test_*.py / reports/*.xml / catalog.md 其中之一。\n' +
      'SKILL.md 的 MANDATORY 強制步驟不可跳過：請照 8 步走完\n' +
      '  1) TaskCreate 建清單 2) qa-flow.sh bootstrap 3) 列 CP 4) 探索\n' +
      '  5) 把 CP 沉澱成 tests/e2e/test_<feature>.py 的 assert\n' +
      '  6) qa-flow.sh run <feature> <test-file> <date>（出 junitxml）\n' +
      '  7) self-verify 8) qa-flow.sh catalog 回填每個情境到 tests/e2e/catalog.md\n' +
      '不要用通用 Playwright MCP 手動測完就口頭回報——那不是可重跑產物。' +
      '（若使用者明確說「這次不要落地」，回覆說明後再結束即可，本 hook 最多擋 2 次。）'
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

// 讀檔尾段；失敗回 null（呼叫端據此放行）
function readTailText(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    const readSize = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) {
    return null;
  }
}

// 真正解析 JSONL：只認結構化的「tool_use block 且工具名是瀏覽器工具」，
// 徹底避免對話文字引用工具名 / "tool_use" 字面就誤判（Codex #2）。
// 逐行 JSON.parse，解析失敗的行直接跳過（不因單行壞掉就誤判）。
const BROWSER_NAME = /^(mcp__playwright__|mcp__claude-in-chrome__|browser_)/;
function eachToolUse(transcript, cb) {
  const lines = transcript.split('\n');
  for (const ln of lines) {
    const s = ln.trim();
    if (!s || s[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch (_) {
      continue; // 壞行跳過
    }
    const content = obj && obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_use' && typeof b.name === 'string') {
        if (cb(b) === true) return true;
      }
    }
  }
  return false;
}

function hasBrowserToolUse(transcript) {
  return eachToolUse(transcript, (b) => BROWSER_NAME.test(b.name));
}

// 觸發 qa-webwright：認「開始做 QA」的結構化證據——(a) Task 叫 qa-engineer subagent，
// 或 (b) Read/Bash 讀了 browser-qa 的 SKILL.md（= 進了這個 skill）。
// 注意：不能用「跑過 qa-flow.sh」當判準——那正是我們要抓的「跳過落地」者不會做的事，
// 用它當觸發證據會反而漏掉最該擋的人。只靠「開始做 QA」的痕跡判定觸發（Codex #3）。
function hasQaTrigger(transcript) {
  return eachToolUse(transcript, (b) => {
    // (a) Task 工具叫 qa-engineer subagent
    if (b.name === 'Task' && b.input && /qa-engineer/.test(safeStr(b.input.subagent_type))) return true;
    // (b) Read / Bash 碰到 browser-qa 的 SKILL.md 路徑（進了這個 skill）
    const paths = safeStr(b.input && (b.input.file_path || b.input.command || b.input.path));
    if (/browser-qa[\\/]SKILL\.md/.test(paths)) return true;
    return false;
  });
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
  if (!files.some((f) => /^test_.*\.py$/.test(f))) return false;

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

/**
 * 是否已達硬擋上限（2 次）。★ FAIL-OPEN：計數檔任何讀寫異常 → 回 true（當已達上限→放行）。
 * 這樣即使計數檔壞掉 / 並發競爭 / tmpdir 不可寫，最壞結果是「少擋」，絕不會「無限擋卡死」。
 * 用「每次 append 一個時間戳字元」的方式估次數：檔案 byte 數 >= 2 就算達上限。
 * append 是單一 syscall，並發下最多多算、不會少算——偏向放行，符合 fail-open。
 */
function reachedBlockLimit(sid) {
  let f;
  try {
    f = path.join(os.tmpdir(), `qa-landing-gate-${sid}.count`);
  } catch (_) {
    return true; // 連路徑都組不出 → 放行
  }

  // 先讀現有次數。★ 只有「明確讀到一個正常的數字 size」才據以判斷；
  //   任何異常（存在性檢查失敗 / stat 失敗 / size 非數字）→ 一律當「已達上限」放行。
  const st = fileState(f);
  if (st === 'unknown') return true; // 檢查失敗 → 放行
  if (st === 'yes') {
    let size;
    try {
      size = fs.statSync(f).size;
    } catch (_) {
      return true; // 檔在但 stat 失敗 → 放行
    }
    if (typeof size !== 'number' || !isFinite(size)) return true; // size 異常 → 放行
    if (size >= 2) return true; // 已擋過 2 次 → 放行
  }
  // st === 'no'（檔還不存在，count=0）或 st==='yes' 且 size<2 → 尚未達上限，記這次後允許擋
  try {
    fs.appendFileSync(f, 'x'); // append 單 syscall，並發下偏多算(偏放行)
  } catch (_) {
    return true; // 記不進去 → 為免下次又擋、寧可這次放行
  }
  return false; // 允許這次硬擋
}
