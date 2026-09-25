#!/usr/bin/env node
/**
 * guard-test-asset-hygiene — qa-webwright 的 PostToolUse(Write|Edit|MultiEdit|NotebookEdit) hook。
 *
 * 寫入 tests/e2e/**\/*.py（tools/ 除外）的當下，對該資料夾跑測試資產衛生閘（一律帶 --baseline，只擋新增）：
 *   ① tools/hardcode_check.py   —— 測試資料寫死／繞過產品入口／借一筆現成的
 *   ② tools/drift_check.py      —— COVERAGE 登記漂移（孤兒／幽靈／佔位）
 *   ③ tools/skip_audit.py       —— A/D 類執行期 skip（沒測到卻長得像綠燈）
 *   ④ tools/i18n_locator_check.py —— 顯示文字定位器（參數檔 i18n.hook_gate=true 才當閘）
 *
 * 為什麼掛寫入當下而不是 commit 閘：測試目錄常不受版控，commit 閘結構上看不到它；
 * 寫完立刻回饋最早也最便宜。人（含 AI）不會為印出來的警告停手，只有閘會。
 *
 * 啟動條件：**只有 <tests/e2e>/qa-webwright.json 存在才啟動**，且只代跑 tools/ 裡本 plugin 複製進去的工具
 *   （缺哪一支就略過哪一支，其餘照跑）；否則完全靜默——沒有參數檔的專案不得有任何輸出或延遲以外的影響。
 * 阻擋：任一閘回報新增違規、或 baseline 檔壞掉（QA-TOOL-RESULT: baseline-error）→ exit 2
 *   （stderr 回饋給模型；已發生的寫入擋不掉，但模型會看到並修正）。
 * 直接寫 tests/e2e/_reports/*-baseline.json（手改存量豁免）→ 不擋，additionalContext 提示改用 --write-baseline。
 * 參考類（H' 共用層借資料、覆核註記格式錯）→ 不擋，additionalContext 提示，每 session 上限 3 次。
 * FAIL-OPEN：hook 自身任何錯誤、工具崩潰（沒有 QA-TOOL-RESULT 標記的非 0）、逾時 → exit 0。
 * 時間預算：全部子程序共用 HOOK_BUDGET_MS（低於 hooks.json 的 timeout），每支工具的 timeout 取「單支上限」與
 *   「剩餘預算」的較小者；預算用完的工具略過（fail-open），整支 hook 不會被 Claude Code 的 timeout 砍掉。
 * 輸出：只設 process.exitCode、不呼叫 process.exit——macOS 的 pipe 是非同步寫入，寫完立刻 exit 可能截斷訊息。
 * 可攜：路徑一律 path 模組處理（不假設 `\`）；python 依平台挑 python3/python/py 並實測可跑；
 *   子程序用 spawnSync 參數陣列（不經 shell）、強制 PYTHONIOENCODING=utf-8。
 * 提示中的重產 baseline 指令一律帶 --why（工具會拒絕沒有 --why 的重產）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REF_NOTICE_CAP = 3;
// hooks.json 給本 hook 180 秒；內部總預算留 30 秒餘裕（node 啟動、讀檔、輸出）
const HOOK_BUDGET_MS = 150000;
const PY_PROBE_TIMEOUT_MS = 10000;
const TOOL_TIMEOUT_MS = 40000;
const STARTED = Date.now();

function remaining() {
  return HOOK_BUDGET_MS - (Date.now() - STARTED);
}

function quiet() {
  process.exitCode = 0;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

// 從檔案路徑找出 tests/e2e 根與其後的相對段落；不在 tests/e2e 底下回 null。
function locate(filePath, cwd) {
  let abs = filePath;
  if (!path.isAbsolute(abs)) abs = path.resolve(cwd || process.cwd(), abs);
  abs = path.normalize(abs);
  // 只在比對用的副本把 `\` 換成 `/`（長度不變，索引可直接對回原字串）；
  // Windows／macOS 檔案系統預設不分大小寫：Tests/E2E 與 tests/e2e 是同一個目錄
  // 不分大小寫用 regex 旗標比對（不先 toLowerCase：İ 這類字元小寫後長度會變，索引就對不回原字串）
  const norm = abs.replace(/\\/g, '/');
  const key = '/tests/e2e/';
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const keyRe = new RegExp('/tests/e2e/', ci ? 'gi' : 'g');
  let i = -1;
  for (let m = keyRe.exec(norm); m; m = keyRe.exec(norm)) i = m.index;
  if (i < 0) return null;
  const e2eRoot = abs.slice(0, i + key.length - 1);
  const rest = norm.slice(i + key.length).split('/').filter((s) => s !== '');
  return { e2eRoot, rest };
}

function pickPython() {
  const cands = [];
  if (process.env.QA_PYTHON) cands.push(process.env.QA_PYTHON);
  if (process.platform === 'win32') cands.push('python', 'py', 'python3');
  else cands.push('python3', 'python');
  for (const c of cands) {
    const budget = Math.min(PY_PROBE_TIMEOUT_MS, remaining());
    if (budget < 1000) return null;
    try {
      const r = spawnSync(c, ['-c', 'import sys'], { timeout: budget, windowsHide: true });
      if (!r.error && r.status === 0) return c;
    } catch (_) {
      /* 試下一個 */
    }
  }
  return null;
}

// 只代跑本 plugin 複製進去的工具（首行帶版本標記），與 qa-flow.sh has_plugin_tool 同判準：
// 專案自有同名工具的參數與輸出契約不一定相同，代跑會誤擋或誤判成崩潰。
function isPluginTool(e2eRoot, script) {
  try {
    const head = fs.readFileSync(path.join(e2eRoot, 'tools', script), 'utf8').split(/\r?\n/, 1)[0];
    return head.indexOf('# qa-webwright-tool:') === 0;
  } catch (_) {
    return false;
  }
}

function runTool(py, e2eRoot, script, args) {
  if (!isPluginTool(e2eRoot, script)) return { state: 'skip', out: '' };
  const budget = Math.min(TOOL_TIMEOUT_MS, remaining());
  if (budget < 1000) return { state: 'skip', out: '' }; // 預算用完 → 略過（fail-open）
  const r = spawnSync(py, [path.join('tools', script)].concat(args), {
    cwd: e2eRoot,
    encoding: 'utf8',
    timeout: budget,
    windowsHide: true,
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
  });
  if (r.error) return { state: 'error', out: '' };
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status === 1 && out.indexOf('QA-TOOL-RESULT: violations') >= 0) return { state: 'violation', out };
  if (r.status === 2 && out.indexOf('QA-TOOL-RESULT: baseline-error') >= 0) return { state: 'baseline-error', out };
  // 讀不到部分檔＝這次檢查不完整：不當成乾淨、也不硬擋（無從判斷 → 放行並提示）
  if (r.status === 2 && out.indexOf('QA-TOOL-RESULT: scan-error') >= 0) return { state: 'scan-error', out };
  if (r.status === 0) return { state: 'ok', out };
  return { state: 'error', out }; // 工具自己壞掉（traceback / 參數錯）→ fail-open
}

function detailLines(out, max) {
  return out
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && l.indexOf('QA-TOOL-RESULT') < 0)
    .slice(0, max)
    .map((l) => '  ' + l);
}

function counterFile(sid) {
  const safe = String(sid || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || 'default';
  return path.join(os.tmpdir(), 'qa-hygiene-ref-' + safe + '.count');
}

function bumpRefCount(sid) {
  const f = counterFile(sid);
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(f, 'utf8'), 10) || 0;
  } catch (_) {
    n = 0;
  }
  if (n >= REF_NOTICE_CAP) return false;
  try {
    fs.writeFileSync(f, String(n + 1));
  } catch (_) {
    /* 計數寫不進去就照提示，不影響主流程 */
  }
  return true;
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch (_) {
    return quiet();
  }
  const toolName = input.tool_name || '';
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName)) return quiet();
  const ti = input.tool_input || {};
  const filePath = String(ti.file_path || ti.notebook_path || ti.path || '');
  const isBaselineJson = /[\\/]tests[\\/]e2e[\\/]_reports[\\/][^\\/]+-baseline\.json$/i.test(
    path.isAbsolute(filePath) ? filePath : path.resolve(input.cwd || process.cwd(), filePath));
  if (!filePath || (!/\.py$/i.test(filePath) && !isBaselineJson)) return quiet();

  const loc = locate(filePath, input.cwd);
  if (!loc || loc.rest.length === 0) return quiet();
  if (loc.rest[0].toLowerCase() === 'tools') return quiet();

  const configPath = path.join(loc.e2eRoot, 'qa-webwright.json');
  if (!fs.existsSync(configPath)) return quiet(); // 沒有參數檔 → 完全靜默
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); // 部分編輯器寫檔帶 BOM（portable-ok: 只去 BOM、不呼叫任何指令）
  } catch (_) {
    return quiet();
  }
  if (cfg && cfg.hook && cfg.hook.enabled === false) return quiet();

  if (isBaselineJson) {
    // 手改存量豁免＝繞過「理由必填／不得夾帶新增／只降不升」三道保護；擋不掉已發生的寫入，但要讓模型與人看見
    const name = path.basename(filePath);
    const tool = { hardcode: 'hardcode_check.py', drift: 'drift_check.py', skip: 'skip_audit.py', 'i18n-locator': 'i18n_locator_check.py' }[
      name.replace(/-baseline\.json$/i, '')];
    // 專案自有工具的 baseline（沒有對應的本 plugin 工具）：不是本閘管的，別給一個不存在的指令
    if (!tool || !isPluginTool(loc.e2eRoot, tool)) return quiet();
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '[test-asset-hygiene] 你直接改了 baseline 檔 ' + name + '（存量豁免清單）。'
          + '手改會繞過「--why 理由必填、不得夾帶新增、只降不升」三道保護，新增違規會被當成存量而永久沉默。'
          + '請還原這次手改，改用：cd tests/e2e && python tools/' + tool + ' all --write-baseline --why "<這批清掉了什麼>"'
          + '（判準本身改了才加 --allow-raise 並在 --why 說明）。若是使用者明確要求的手改，回報時講清楚改了什麼。',
      },
    }));
    return quiet();
  }
  const TOOLS = ['hardcode_check.py', 'drift_check.py', 'skip_audit.py', 'i18n_locator_check.py'];
  if (!TOOLS.some((t) => isPluginTool(loc.e2eRoot, t))) return quiet(); // 一支本 plugin 的工具都沒有 → 靜默

  const py = pickPython();
  if (!py) return quiet();
  // 回饋訊息只顯示執行檔名（QA_PYTHON 可能是帶本機目錄結構的絕對路徑）
  const pyShow = path.isAbsolute(py) ? path.basename(py).replace(/\.exe$/i, '') : py;
  const target = loc.rest.length === 1 ? '.' : loc.rest[0];
  const rel = loc.rest.join('/');
  const whyReset = (tool, extra) =>
    `${pyShow} tools/${tool} all --write-baseline --why "<這批清掉了什麼>"${extra || ''}`;

  const sections = [];
  const refNotes = [];
  const baselineErrors = [];
  const run = (script) => {
    const r = runTool(py, loc.e2eRoot, script, [target, '--baseline']);
    if (r.state === 'baseline-error') baselineErrors.push({ script, out: r.out });
    if (r.state === 'scan-error') {
      refNotes.push('  [注意] tools/' + script + ' 讀不到部分檔，本次檢查不完整（未判定、放行）：', ...detailLines(r.out, 3));
    }
    return r;
  };

  const hc = run('hardcode_check.py');
  if (hc.state === 'violation') {
    sections.push({
      title: '硬編違規（測試資料寫死／繞過產品入口／借一筆現成的）',
      detail: detailLines(hc.out, 40),
      cmd: `${pyShow} tools/hardcode_check.py ${target} --baseline`,
      reset: whyReset('hardcode_check.py'),
    });
  } else if (hc.state === 'ok') {
    const m1 = /^=== H' .*?：([1-9]\d*) 處/m.exec(hc.out);
    const m2 = /^=== 覆核註記格式錯誤.*?：([1-9]\d*) 處/m.exec(hc.out);
    if (m1 || m2) refNotes.push(...detailLines(hc.out, 25));
  }

  const dc = run('drift_check.py');
  if (dc.state === 'violation') {
    sections.push({
      title: 'COVERAGE 登記漂移（測試寫了沒登記／登記了沒測試／情境還是佔位）',
      detail: detailLines(dc.out, 30).concat([
        '',
        '  修法：改該資料夾的 COVERAGE.md（情境正本）——',
        '    orphan（程式有、文件沒登記）→ 補一列：白話使用情境｜`檔.py::函式`｜✅/⚠️/❌',
        '    ghost（文件有、程式沒這個函式）→ 測試已刪或改名，把該列改掉或移除',
        '    placeholder（情境欄還是佔位字）→ 寫上使用者在做什麼的白話情境',
        '  或用 qa-flow.sh catalog <情境> <檔.py::函式> <完整|部分|未覆蓋> <資料夾> 登記。',
      ]),
      cmd: `${pyShow} tools/drift_check.py ${target} --baseline`,
      reset: whyReset('drift_check.py'),
    });
  }

  const sk = run('skip_audit.py');
  if (sk.state === 'violation') {
    sections.push({
      title: 'skip 假綠（A 沒資料該自種／D 共用狀態被佔該 fail）',
      detail: detailLines(sk.out, 30).concat([
        '',
        '  開跑前就知道不適用（外部系統不存在、OS 限制）→ 改寫成收集期 @pytest.mark.skipif(具名條件)，不計入閘。',
        '  ⚠ 一輪殘留沒清，之後每輪都安靜跳過：跑一百次一百次綠，一次都沒真的測。',
      ]),
      cmd: `${pyShow} tools/skip_audit.py ${target} --baseline`,
      reset: whyReset('skip_audit.py'),
    });
  }

  const i18n = (cfg && cfg.i18n) || {};
  if (i18n.hook_gate === true && i18n.enabled !== false) {
    const il = run('i18n_locator_check.py');
    if (il.state === 'violation') {
      sections.push({
        title: '顯示文字定位器（切語系即失效）',
        detail: detailLines(il.out, 30),
        cmd: `${pyShow} tools/i18n_locator_check.py ${target} --baseline`,
        reset: whyReset('i18n_locator_check.py'),
      });
    }
  }

  for (const b of baselineErrors) {
    sections.push({
      title: 'baseline 檔壞掉（' + b.script + '）——壞檔不能當成「沒有 baseline」',
      detail: detailLines(b.out, 12),
      cmd: `${pyShow} tools/${b.script} ${target} --baseline`,
      reset: whyReset(b.script, ' --allow-raise') + '   （先試著從版控還原；確定整份重建才用這行）',
    });
  }

  if (sections.length > 0) {
    const msg = [`[test-asset-hygiene] 剛寫入的 ${rel} 讓 \`${target}\` 出現**新增**問題：`, ''];
    for (const s of sections) {
      msg.push(`── ${s.title} ──`, '');
      msg.push(...s.detail);
      msg.push('', `完整清單：cd tests/e2e && ${s.cmd}`);
      msg.push(`存量走 baseline 豁免；清掉一批後重產讓水位下降（--why 必填，只降不升）：cd tests/e2e && ${s.reset}`, '');
    }
    msg.push('⚠ 本閘走 --baseline（只擋**新增**），它沉默不代表水位是 0；看真實水位跑不帶 --baseline 的那次。');
    process.stderr.write(msg.join('\n') + '\n');
    process.exitCode = 2; // 不呼叫 process.exit：讓 stderr 自然排空
    return undefined;
  }

  if (refNotes.length > 0 && bumpRefCount(input.session_id)) {
    const ctx = ['[test-asset-hygiene] 參考提示（不阻擋）：', ...refNotes].join('\n');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx },
    }));
  }
  return quiet();
}

try {
  main();
} catch (_) {
  process.exitCode = 0; // FAIL-OPEN
}
