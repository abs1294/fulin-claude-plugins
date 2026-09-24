#!/usr/bin/env node
// hook 行為探針：對同目錄的每支 hook，照 cases/<hook 檔名去 .js>.json 的案例餵真實 payload，
// 判定它該擋的有沒有擋、該放的有沒有放。兩個方向都要測——只測「會擋」會漏掉「把正常操作也擋死」。
//
// 用法：
//   node probe-hooks.js                 # 跑同目錄所有有 cases 的 hook
//   node probe-hooks.js <hook>.js ...   # 只跑指定的
//   node probe-hooks.js --list          # 列出哪些 hook 有／沒有 cases
//   node probe-hooks.js --parser=off    # 規則引擎改走退回的正則路徑（沒裝語法解析器時的行為）
// 結束碼：全數符合預期＝0；任一不符或有 hook 缺 cases＝1。
//
// 【範本】/harness:init 會把本檔、cases/ 與選定的 hook 一起複製到目標專案 `.claude/hooks/`。
// 實例化時若改了某支 hook 的「init 填空區」常數，要同步改它的 cases（例如 agent 名單改了，
// 案例裡的 subagent_type 也要換成實際名字）——這是 Phase 5 驗收的一部分，不是事後補的。
//
// cases 檔格式：
// {
//   "hook": "xxx.js",
//   "variants": { "<名稱>": { "replace": [["原字串", "新字串"], ...] } },   // 選填：測同一支 hook 的另一種設定
//   "cases": [{
//     "label": "說明",
//     "variant": "<名稱>",                       // 選填
//     "setup": {
//       "files": { "相對路徑": "內容" },           // 在暫存專案裡建檔
//       "git": true,                               // 暫存專案 git init
//       "stage": ["相對路徑"],                     // git add（隱含 git: true；在 files_after_commit 之後執行）
//       "commit": true,                            // 暫存專案 git add -A 並 commit 一次（隱含 git: true），
//                                                  // 造出「有 HEAD」的狀態；要 dirty 再搭 files_after_commit
//       "files_after_commit": { "相對路徑": "內容" }, // commit 之後才寫入／覆寫（造出與 HEAD 不同的工作區）
//       "env": { "KEY": "value" },                 // 額外環境變數；值給 null＝刪掉該變數（不存在），"" 是存在但為空
//       "transcript": [ {...}, ... ],              // 寫成 jsonl，路徑放進 payload.transcript_path
//       "mtime_days_ago": { "相對路徑": 40 }       // 把檔案時間往回撥
//     },
//     "payload": { "hook_event_name": "PreToolUse", "tool_name": "...", "tool_input": {...} },
//                                                  // payload 字串裡的 {PROJECT_DIR} 會換成本次暫存專案的絕對路徑
//     "expect": "BLOCK" | "ALLOW" | "NOTE",        // NOTE＝不擋但要有輸出（提醒型 hook）
//     "exit": 1,                                   // 選填：預期結束碼（刻意以 0／2 以外結束的 CLI 腳本用）
//     "parser": "only"                             // 選填：只有語法樹路徑做得到（正則路徑的已知極限）；
//                                                  // 走正則路徑時略過並計數，不算通過也不算失敗
//   }]
// }
// 判定：exit 2、stdout JSON 的 hookSpecificOutput.permissionDecision=deny、或 decision=block ＝ BLOCK；
// 否則 ALLOW。NOTE 需 ALLOW 且 stdout 或 stderr 非空。exit 0／2 以外的結束碼、逾時、訊號終止＝CRASH，一律不符。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HERE = __dirname;
const CASES_DIR = path.join(HERE, 'cases');
const args = process.argv.slice(2);
// --parser=off：規則引擎不用語法解析器、走退回的正則路徑（兩條路徑都要能全綠；標 "parser": "only" 的案例略過）
const PARSER_OFF = args.includes('--parser=off');
// 本輪實際走哪條路徑：語法解析器沒裝或載入失敗時，預設模式其實也是正則路徑——開頭就講清楚，不讓它靜默全綠
const NODE_MODULES = path.join(HERE, 'node_modules');
// 跑 hook 用的環境底：本目錄有 node_modules 就指向它，沒有就沿用外層的 NODE_PATH——判路徑與實際跑 hook 用同一個判準
function hookEnvBase() {
  const env = Object.assign({}, process.env);
  if (PARSER_OFF) env.HARNESS_SHELL_PARSER = 'off';
  else if (fs.existsSync(NODE_MODULES)) env.NODE_PATH = NODE_MODULES;
  return env;
}
function parserStatus() {
  if (!fs.existsSync(path.join(HERE, 'shell-model.js'))) return null;           // 沒裝規則引擎，與本項無關
  if (PARSER_OFF) return { on: false, text: '正則路徑（--parser=off）' };
  const r = spawnSync(process.execPath, ['-e',
    "const s=require(process.argv[1]);process.stdout.write(String(s.available('Bash'))+' '+String(s.available('PowerShell')))",
    path.join(HERE, 'shell-model.js')], { env: hookEnvBase(), encoding: 'utf8' });
  const [b, p] = String(r.stdout || '').split(' ');
  if (b === 'true' && p === 'true') return { on: true, text: '語法樹路徑（Bash 與 PowerShell 解析器都已載入）' };
  return { on: false, text: '⚠ 語法解析器沒有完整載入（Bash=' + (b || '?') + '、PowerShell=' + (p || '?') +
    '），本輪規則引擎實際走正則路徑——在本目錄跑 npm ci 補裝' };
}
const PARSER = parserStatus();

function listHooks() {
  // shell-model.js 是兩支規則引擎共用的模組，不是 hook
  return fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && f !== 'probe-hooks.js' && f !== 'shell-model.js');
}
function casesFor(hook) {
  const p = path.join(CASES_DIR, hook.replace(/\.js$/, '.json'));
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

if (args.includes('--list')) {
  for (const h of listHooks()) console.log((casesFor(h) ? '有 cases ' : '缺 cases ') + h);
  process.exit(0);
}

const targets = args.filter((a) => a.endsWith('.js'));
const hooks = targets.length ? targets : listHooks();
let pass = 0, fail = 0, missing = 0;

// 暫存專案路徑要到執行期才知道，cases 檔無法寫死，故用佔位字串；經 JSON 字串層替換以保留反斜線跳脫
function withProjectDir(payload, dir) {
  const esc = JSON.stringify(dir).slice(1, -1);
  return JSON.parse(JSON.stringify(payload || {}).split('{PROJECT_DIR}').join(esc));
}

function mkProject(setup, hookFile, variant) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookprobe-'));
  const hdir = path.join(dir, '.claude', 'hooks');
  fs.mkdirSync(hdir, { recursive: true });
  let src = fs.readFileSync(path.join(HERE, hookFile), 'utf8');
  if (variant) {
    for (const [a, b] of variant.replace || []) {
      if (!src.includes(a)) throw new Error(`variant 取代字串不存在：${a}`);
      src = src.split(a).join(b);
    }
  }
  fs.writeFileSync(path.join(hdir, hookFile), src);
  // 規則引擎共用的語法模組一起帶過去（沒有就算了：其他 hook 用不到）
  if (fs.existsSync(path.join(HERE, 'shell-model.js'))) fs.copyFileSync(path.join(HERE, 'shell-model.js'), path.join(hdir, 'shell-model.js'));
  for (const [rel, content] of Object.entries(setup.files || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  if (setup.git || setup.stage || setup.commit) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    if (setup.commit) {
      // 只在暫存目錄裡 commit，用來造「HEAD 與工作區不同」的測試狀態
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@local',
        'commit', '-qm', 'base', '--allow-empty'], { cwd: dir });
    }
  }
  for (const [rel, content] of Object.entries(setup.files_after_commit || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  // stage 放在 files_after_commit 之後：搭配 commit 時才能造出「改動已被 stage」的狀態
  for (const rel of setup.stage || []) execFileSync('git', ['add', '--', rel], { cwd: dir });
  for (const [rel, days] of Object.entries(setup.mtime_days_ago || {})) {
    const t = new Date(Date.now() - days * 86400000);
    fs.utimesSync(path.join(dir, rel), t, t);
  }
  return dir;
}

if (PARSER) console.log('規則引擎判定路徑：' + PARSER.text + '\n');
let skipped = 0;
for (const hook of hooks) {
  const spec = casesFor(hook);
  if (!spec) { console.log(`MISS | ${hook} | 沒有 cases 檔`); missing++; continue; }
  for (const c of spec.cases) {
    if (c.parser === 'only' && PARSER && !PARSER.on) { skipped++; console.log(`SKIP | ${hook} | 只有語法樹路徑做得到 | ${c.label}`); continue; }
    const setup = c.setup || {};
    const variant = c.variant ? (spec.variants || {})[c.variant] : null;
    let dir;
    try { dir = mkProject(setup, hook, variant); } catch (e) {
      console.log(`FAIL | ${hook} | ${c.label} | 建暫存專案失敗：${e.message}`); fail++; continue;
    }
    const payload = Object.assign({ session_id: 'probe-' + Math.random().toString(36).slice(2), cwd: dir,
      hook_event_name: 'PreToolUse' }, withProjectDir(c.payload, dir));
    if (setup.transcript) {
      const tp = path.join(dir, 'transcript.jsonl');
      fs.writeFileSync(tp, setup.transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
      payload.transcript_path = tp;
    }
    // 語法解析器：預設用本目錄 node_modules 裡的（npm ci 過才有）；--parser=off 強制走退回的正則路徑
    const env = Object.assign(hookEnvBase(), { CLAUDE_PROJECT_DIR: dir }, setup.env || {});
    // setup.env 的值給 null＝這個變數不存在（刪掉）；空字串＝存在但值為空，兩者對環境判斷不同
    for (const [k, v] of Object.entries(setup.env || {})) if (v === null) delete env[k];
    const r = spawnSync(process.execPath, [path.join(dir, '.claude', 'hooks', hook)],
      { input: JSON.stringify(payload), cwd: dir, env, encoding: 'utf8', timeout: 30000 });
    let block = r.status === 2;
    try {
      const j = JSON.parse(r.stdout);
      if ((j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny') || j.decision === 'block') block = true;
    } catch {}
    const said = ((r.stdout || '') + (r.stderr || '')).trim().length > 0;
    // 只有 exit 0（放行／提醒）與 exit 2（擋）是正常結束；崩潰、逾時、其他結束碼一律判錯，
    // 否則 hook 壞掉會被當成「放行」而讓期望 ALLOW 的案例假性通過。
    // 案例可用 "exit" 宣告預期結束碼（給 CLI 腳本這種刻意以非 0／2 結束的）；有宣告就必須剛好相符。
    const crashed = r.error || r.signal ||
      (c.exit !== undefined ? r.status !== c.exit : (r.status !== 0 && r.status !== 2));
    const got = crashed ? 'CRASH' : (block ? 'BLOCK' : (c.expect === 'NOTE' && said ? 'NOTE' : 'ALLOW'));
    const ok = got === c.expect;
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${hook} | 期望 ${c.expect} 實得 ${got} (exit ${r.status}) | ${c.label}`);
    if (!ok) {
      console.log('       stdout:', (r.stdout || '').slice(0, 300).replace(/\n/g, ' '));
      console.log('       stderr:', (r.stderr || '').slice(0, 300).replace(/\n/g, ' '));
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
console.log(`\n合計 PASS ${pass} / FAIL ${fail} / 缺 cases ${missing}` + (skipped ? ` / 略過 ${skipped}（只有語法樹路徑做得到）` : ''));
if (PARSER && !PARSER.on && !PARSER_OFF) console.log(PARSER.text);
process.exit(fail || missing ? 1 : 0);
